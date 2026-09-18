// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory);
}

/// @notice A synthetic stock token (sNVDA, sAAPL, …). Tracks the Pyth price of
/// the underlying share in USD. It is NOT a share: no ownership, no votes, no
/// dividends. Only its market can mint or burn it.
contract ArcSynthStock {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    address public immutable market;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotMarket();

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        market = msg.sender;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function mint(address to, uint256 value) external {
        if (msg.sender != market) revert NotMarket();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external {
        if (msg.sender != market) revert NotMarket();
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _move(address from, address to, uint256 value) private {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @notice Synthetic US stocks on Arc, priced by Pyth, settled in native USDC.
///
/// Liquidity providers deposit USDC into one shared pool, which is the
/// counterparty to every trade: a buyer pays USDC in and receives synthetic
/// shares minted at the Pyth price; a seller burns them and is paid out of the
/// pool at the Pyth price. LPs earn the trading fee and carry the pool's net
/// exposure to the stocks traders hold — when those stocks rise, the pool owes
/// more; when they fall, it owes less.
///
/// Safety rails, all on-chain:
/// - Every trade brings its own signed Pyth update and uses a price no older
///   than MAX_PRICE_AGE. Outside market hours Pyth stops publishing equities,
///   the price goes stale, and trading stops by itself.
/// - Buys fill at price + confidence and sells at price − confidence, so the
///   pool is never on the wrong side of Pyth's own uncertainty. A report whose
///   confidence exceeds MAX_CONF_BPS of the price is refused.
/// - Open interest is capped per stock and in total (MAX_POOL_EXPOSURE_BPS of
///   pool value), measured at each stock's latest traded price.
/// - LP deposits are locked for LP_LOCK before they can be withdrawn, and LP
///   entry and exit need fresh prices for every stock with open interest, so
///   no one can time a deposit or exit around a known price gap.
contract ArcStockMarket {
    uint256 constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 30; // 0.30% per trade
    uint256 public constant TREASURY_SHARE_BPS = 2_000; // 20% of fees; 80% stays with LPs
    uint256 public constant MAX_PRICE_AGE = 60; // seconds
    uint256 public constant MAX_CONF_BPS = 100; // 1% of price
    uint256 public constant MAX_POOL_EXPOSURE_BPS = 5_000; // open interest ≤ 50% of pool value
    uint256 public constant LP_LOCK = 15 minutes; // blocks deposit→withdraw loops on a lagging price, short enough to stay flexible
    /// First deposit must be at least 1 USDC, and 0.001 of its shares are
    /// minted to nobody, so the share price cannot be inflated from a dust
    /// first deposit to round later depositors down.
    uint256 public constant MIN_FIRST_DEPOSIT = 1 ether;
    uint256 public constant DEAD_SHARES = 1e15;

    struct Asset {
        ArcSynthStock token;
        bytes32 feedId;
        uint256 maxOpenInterest; // USD, 18 dp
        uint256 lastPrice; // USD per share, 18 dp, at the latest trade
    }

    IPyth public immutable pyth;
    address public immutable treasury;
    address public admin;
    address public guardian;
    bool public paused;

    Asset[] public assets;
    mapping(address => uint256) public assetIdOf; // token => id + 1

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public lockedUntil;
    uint256 public treasuryFees;

    event AssetListed(uint256 indexed id, address token, bytes32 feedId, uint256 maxOpenInterest);
    event CapSet(uint256 indexed id, uint256 maxOpenInterest);
    event Bought(address indexed trader, uint256 indexed id, uint256 usdcIn, uint256 shares, uint256 price, uint256 fee);
    event Sold(address indexed trader, uint256 indexed id, uint256 shares, uint256 usdcOut, uint256 price, uint256 fee);
    event Deposited(address indexed provider, uint256 usdc, uint256 shares);
    event Withdrawn(address indexed provider, uint256 usdc, uint256 shares);
    event Paused(bool state);

    error Unauthorized();
    error IsPaused();
    error UnknownAsset();
    error BadPrice();
    error Slippage();
    error CapExceeded();
    error Locked();
    error Insolvent();
    error Invalid();
    error TransferFailed();

    uint256 private locked_ = 1;

    modifier lock() {
        if (locked_ != 1) revert Invalid();
        locked_ = 2;
        _;
        locked_ = 1;
    }

    modifier live() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(IPyth pyth_, address treasury_, address admin_, address guardian_) {
        if (address(pyth_) == address(0) || treasury_ == address(0) || admin_ == address(0) || guardian_ == address(0)) revert Invalid();
        pyth = pyth_;
        treasury = treasury_;
        admin = admin_;
        guardian = guardian_;
    }

    // --- views -------------------------------------------------------------

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    /// @notice USDC owned by LPs: the balance minus fees owed to the treasury.
    function poolBalance() public view returns (uint256) {
        return address(this).balance - treasuryFees;
    }

    /// @notice Open interest in USD at each stock's latest traded price.
    function openInterest(uint256 id) public view returns (uint256) {
        Asset storage a = assets[id];
        return a.token.totalSupply() * a.lastPrice / WAD;
    }

    function totalOpenInterest() public view returns (uint256 sum) {
        for (uint256 i; i < assets.length; i++) sum += openInterest(i);
    }

    // --- trading -----------------------------------------------------------

    /// @notice Buy synthetic shares with the USDC sent. `updates` is Pyth's
    /// signed price update for this stock (fetched from Hermes).
    function buy(uint256 id, uint256 minShares, bytes[] calldata updates) external payable live lock returns (uint256 shares) {
        uint256 value = msg.value - _updatePrices(updates);
        (uint256 price, uint256 conf) = _price(id);
        uint256 fee = value * FEE_BPS / BPS;
        uint256 ask = price + conf;
        shares = (value - fee) * WAD / ask;
        if (shares == 0 || shares < minShares) revert Slippage();

        Asset storage a = assets[id];
        a.lastPrice = price;
        treasuryFees += fee * TREASURY_SHARE_BPS / BPS;
        a.token.mint(msg.sender, shares);

        if (openInterest(id) > a.maxOpenInterest) revert CapExceeded();
        if (totalOpenInterest() * BPS > poolBalance() * MAX_POOL_EXPOSURE_BPS) revert CapExceeded();
        emit Bought(msg.sender, id, value, shares, ask, fee);
    }

    /// @notice Sell synthetic shares back to the pool for USDC.
    function sell(uint256 id, uint256 shares, uint256 minUsdc, bytes[] calldata updates) external payable live lock returns (uint256 usdc) {
        uint256 refund = msg.value - _updatePrices(updates);
        (uint256 price, uint256 conf) = _price(id);
        uint256 bid = price > conf ? price - conf : 0;
        uint256 gross = shares * bid / WAD;
        uint256 fee = gross * FEE_BPS / BPS;
        usdc = gross - fee;
        if (usdc == 0 || usdc < minUsdc) revert Slippage();

        Asset storage a = assets[id];
        a.lastPrice = price;
        a.token.burn(msg.sender, shares);
        treasuryFees += fee * TREASURY_SHARE_BPS / BPS;
        if (address(this).balance < usdc + refund + treasuryFees) revert Insolvent();
        _pay(msg.sender, usdc + refund);
        emit Sold(msg.sender, id, shares, usdc, bid, fee);
    }

    // --- liquidity ---------------------------------------------------------

    /// @notice Pool value net of what traders' synthetic shares are worth at
    /// fresh prices. Reverts unless every stock with open interest has a
    /// fresh price — call through deposit/withdraw with updates.
    function netAssetValue() public view returns (uint256) {
        uint256 liabilities;
        for (uint256 i; i < assets.length; i++) {
            uint256 supply = assets[i].token.totalSupply();
            if (supply == 0) continue;
            (uint256 price,) = _price(i);
            liabilities += supply * price / WAD;
        }
        uint256 balance = poolBalance();
        return balance > liabilities ? balance - liabilities : 0;
    }

    function deposit(bytes[] calldata updates) external payable live lock returns (uint256 shares) {
        uint256 value = msg.value - _updatePrices(updates);
        uint256 navBefore = netAssetValue() - value; // value is already in the balance
        if (totalShares == 0) {
            if (value < MIN_FIRST_DEPOSIT) revert Invalid();
            totalShares = DEAD_SHARES;
            shares = value - DEAD_SHARES;
        } else {
            if (navBefore == 0) revert Insolvent();
            shares = value * totalShares / navBefore;
        }
        if (shares == 0) revert Invalid();
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        lockedUntil[msg.sender] = block.timestamp + LP_LOCK;
        emit Deposited(msg.sender, value, shares);
    }

    function withdraw(uint256 shares, bytes[] calldata updates) external payable lock returns (uint256 usdc) {
        if (block.timestamp < lockedUntil[msg.sender]) revert Locked();
        uint256 refund = msg.value - _updatePrices(updates);
        usdc = (netAssetValue() - refund) * shares / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        // What remains must still cover open interest within the exposure bound.
        if (totalOpenInterest() * BPS > (poolBalance() - usdc - refund) * MAX_POOL_EXPOSURE_BPS) revert CapExceeded();
        _pay(msg.sender, usdc + refund);
        emit Withdrawn(msg.sender, usdc, shares);
    }

    // --- admin -------------------------------------------------------------

    function listAsset(string calldata name, string calldata symbol, bytes32 feedId, uint256 maxOpenInterest)
        external
        returns (uint256 id, address token)
    {
        if (msg.sender != admin) revert Unauthorized();
        if (feedId == bytes32(0)) revert Invalid();
        ArcSynthStock t = new ArcSynthStock(name, symbol);
        assets.push(Asset(t, feedId, maxOpenInterest, 0));
        id = assets.length - 1;
        token = address(t);
        assetIdOf[token] = id + 1;
        emit AssetListed(id, token, feedId, maxOpenInterest);
    }

    /// @notice Lower a cap immediately; the admin cannot move money.
    function setCap(uint256 id, uint256 maxOpenInterest) external {
        if (msg.sender != admin) revert Unauthorized();
        assets[id].maxOpenInterest = maxOpenInterest;
        emit CapSet(id, maxOpenInterest);
    }

    function setPaused(bool state) external {
        if (msg.sender != guardian && msg.sender != admin) revert Unauthorized();
        paused = state;
        emit Paused(state);
    }

    function setAdmin(address next) external {
        if (msg.sender != admin || next == address(0)) revert Unauthorized();
        admin = next;
    }

    function sweepTreasuryFees() external lock {
        uint256 amount = treasuryFees;
        treasuryFees = 0;
        _pay(treasury, amount);
    }

    // --- internals ---------------------------------------------------------

    function _updatePrices(bytes[] calldata updates) private returns (uint256 fee) {
        if (updates.length == 0) return 0;
        fee = pyth.getUpdateFee(updates);
        pyth.updatePriceFeeds{value: fee}(updates);
    }

    /// Price and confidence in USD per share, 18 dp.
    function _price(uint256 id) private view returns (uint256 price, uint256 conf) {
        if (id >= assets.length) revert UnknownAsset();
        IPyth.Price memory p = pyth.getPriceNoOlderThan(assets[id].feedId, MAX_PRICE_AGE);
        if (p.price <= 0) revert BadPrice();
        int256 scale = int256(p.expo) + 18;
        if (scale < 0 || scale > 36) revert BadPrice();
        uint256 factor = 10 ** uint256(scale);
        price = uint256(uint64(p.price)) * factor;
        conf = uint256(p.conf) * factor;
        if (conf * BPS > price * MAX_CONF_BPS) revert BadPrice();
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {
        revert Invalid();
    }
}
