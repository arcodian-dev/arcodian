// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ArcToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply_, address receiver) {
        require(bytes(name_).length > 0 && bytes(symbol_).length > 0, "EMPTY_METADATA");
        require(supply_ > 0 && receiver != address(0), "BAD_MINT");
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        balanceOf[receiver] = supply_;
        emit Transfer(address(0), receiver, supply_);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}

contract ArcLaunchSale {
    ArcToken public immutable token;
    address public immutable creator;
    uint64 public immutable startTime;
    uint64 public immutable endTime;
    uint256 public immutable tokensPerNative;
    uint256 public immutable hardCap;
    uint256 public immutable minRaise;
    uint256 public raised;
    uint256 public reservedTokens;
    bool public settled;
    bool public proceedsClaimed;
    bool private locked;
    mapping(address => uint256) public contributed;
    mapping(address => uint256) public purchasedTokens;

    event Purchased(address indexed buyer, uint256 paid, uint256 tokens);
    event Finalized(uint256 raised);
    event TokensClaimed(address indexed buyer, uint256 amount);
    event ProceedsClaimed(address indexed creator, uint256 amount);
    event Refunded(address indexed buyer, uint256 amount);

    modifier nonReentrant() {
        require(!locked, "REENTRANCY");
        locked = true;
        _;
        locked = false;
    }

    constructor(
        ArcToken token_,
        address creator_,
        uint64 start_,
        uint64 end_,
        uint256 rate_,
        uint256 cap_,
        uint256 min_
    ) {
        require(address(token_) != address(0) && creator_ != address(0), "ZERO_ADDRESS");
        require(start_ < end_ && end_ > block.timestamp, "BAD_WINDOW");
        require(rate_ > 0 && cap_ > 0 && min_ <= cap_, "BAD_TERMS");
        token = token_;
        creator = creator_;
        startTime = start_;
        endTime = end_;
        tokensPerNative = rate_;
        hardCap = cap_;
        minRaise = min_;
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant {
        require(block.timestamp >= startTime && block.timestamp <= endTime, "SALE_CLOSED");
        require(block.timestamp <= deadline && msg.value > 0, "BAD_ORDER");
        uint256 accepted = msg.value;
        if (raised + accepted > hardCap) accepted = hardCap - raised;
        require(accepted > 0, "CAP_REACHED");
        uint256 tokenAmount = accepted * tokensPerNative / 1 ether;
        require(tokenAmount >= minTokensOut && tokenAmount > 0, "SLIPPAGE");
        raised += accepted;
        contributed[msg.sender] += accepted;
        purchasedTokens[msg.sender] += tokenAmount;
        reservedTokens += tokenAmount;
        emit Purchased(msg.sender, accepted, tokenAmount);
        uint256 excess = msg.value - accepted;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            require(ok, "REFUND_FAILED");
        }
    }

    function finalize() external nonReentrant {
        require(!settled && (block.timestamp > endTime || raised == hardCap), "NOT_FINAL");
        require(raised >= minRaise, "MIN_NOT_MET");
        settled = true;
        uint256 unsold = token.balanceOf(address(this)) - reservedTokens;
        if (unsold > 0) require(token.transfer(creator, unsold), "TOKEN_RETURN");
        emit Finalized(raised);
    }

    function claimProceeds() external nonReentrant {
        require(msg.sender == creator && settled && !proceedsClaimed, "NO_PROCEEDS");
        proceedsClaimed = true;
        uint256 amount = address(this).balance;
        (bool ok,) = creator.call{value: amount}("");
        require(ok, "PAYOUT_FAILED");
        emit ProceedsClaimed(creator, amount);
    }

    function claimTokens() external nonReentrant {
        require(settled, "NOT_SETTLED");
        uint256 amount = purchasedTokens[msg.sender];
        require(amount > 0, "NOTHING_TO_CLAIM");
        purchasedTokens[msg.sender] = 0;
        reservedTokens -= amount;
        require(token.transfer(msg.sender, amount), "TOKEN_TRANSFER");
        emit TokensClaimed(msg.sender, amount);
    }

    function refund() external nonReentrant {
        require(!settled && block.timestamp > endTime && raised < minRaise, "NO_REFUND");
        uint256 amount = contributed[msg.sender];
        require(amount > 0, "NOTHING_TO_REFUND");
        contributed[msg.sender] = 0;
        uint256 tokenAmount = purchasedTokens[msg.sender];
        purchasedTokens[msg.sender] = 0;
        reservedTokens -= tokenAmount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "REFUND_FAILED");
        emit Refunded(msg.sender, amount);
    }
}

contract ArcLaunchpadFactory {
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public saleByLaunch;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address sale);

    function createLaunch(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint256 saleSupply,
        uint64 startTime,
        uint64 endTime,
        uint256 tokensPerNative,
        uint256 hardCap,
        uint256 minRaise
    ) external returns (address tokenAddress, address saleAddress) {
        require(saleSupply > 0 && saleSupply <= totalSupply, "BAD_ALLOCATION");
        ArcToken token = new ArcToken(name, symbol, totalSupply, address(this));
        ArcLaunchSale sale =
            new ArcLaunchSale(token, msg.sender, startTime, endTime, tokensPerNative, hardCap, minRaise);
        require(token.transfer(address(sale), saleSupply), "SALE_ALLOCATION");
        uint256 creatorSupply = totalSupply - saleSupply;
        if (creatorSupply > 0) require(token.transfer(msg.sender, creatorSupply), "CREATOR_ALLOCATION");
        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        saleByLaunch[id] = address(sale);
        emit LaunchCreated(id, msg.sender, address(token), address(sale));
        return (address(token), address(sale));
    }
}
