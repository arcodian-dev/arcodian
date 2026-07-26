// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Collateral, IArcPriceOracle} from "./ArcLend.sol";

/// @notice Single-collateral, native-USDC isolated lending market for Arc.
/// @dev Identical to ArcLend (oracle, LTV, liquidation, pause, caps, bad debt)
///      except the interest rate. ArcLend fixes `ratePerSecond` at deploy time
///      — under high utilization the rate never rises, so nothing incentivizes
///      repayment and suppliers can be left unable to withdraw. V2 replaces
///      the fixed rate with the two-slope utilization curve used by Compound's
///      JumpRateModel and Aave's reserve interest strategy: flat-ish below the
///      kink, then a steep second slope above it that pushes borrowers to
///      repay and lenders to earn more exactly when liquidity is scarce.
contract ArcLendV2 {
    uint256 constant WAD = 1e18;
    uint256 constant BPS = 10_000;
    uint256 public constant RESERVE_FACTOR_BPS = 1_000;
    uint256 public constant MAX_LTV_BPS = 7_000;
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 8_000;
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;
    uint256 public constant MAX_ORACLE_AGE = 1 hours;
    uint256 public constant MAX_ORACLE_DEVIATION_BPS = 2_000;
    uint256 public constant CAP_INCREASE_DELAY = 48 hours;
    uint256 public constant PAUSE_SUPPLY = 1;
    uint256 public constant PAUSE_COLLATERAL = 2;
    uint256 public constant PAUSE_BORROW = 4;

    IERC20Collateral public immutable collateralToken;
    IArcPriceOracle public immutable oracle;
    address public immutable admin;
    address public guardian;
    uint256 public supplyCap;
    uint256 public borrowCap;
    uint256 public pendingSupplyCap;
    uint256 public pendingBorrowCap;
    uint64 public capIncreaseEta;
    uint256 public immutable collateralUnit;
    bool public paused;
    uint256 public pauseFlags;
    uint256 public badDebt;
    uint256 public lastGoodPrice;
    uint64 public lastGoodPriceAt;
    uint256 public borrowIndex = WAD;
    uint64 public lastAccrual;
    uint256 public totalBorrows;
    uint256 public reserves;
    uint256 public totalSupplyShares;
    uint256 private unlocked = 1;

    /// Two-slope utilization curve, all WAD-scaled annual rates/utilization.
    /// rate(u) = base + u * multiplier                      for u <= kink
    /// rate(u) = base + kink * multiplier + (u-kink) * jump  for u  > kink
    uint256 public immutable baseRatePerYear;
    uint256 public immutable multiplierPerYear;
    uint256 public immutable jumpMultiplierPerYear;
    uint256 public immutable kink;

    mapping(address => uint256) public supplyShares;
    mapping(address => uint256) public debtShares;
    mapping(address => uint256) public collateralOf;

    event Supplied(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event CollateralChanged(address indexed user, int256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 repaid, uint256 collateralSeized);
    event Paused(bool state);
    event PauseFlagsSet(uint256 flags);
    event CapsSet(uint256 supplyCap, uint256 borrowCap);
    event CapIncreaseScheduled(uint256 supplyCap, uint256 borrowCap, uint64 eta);
    event CapIncreaseCancelled();
    event OracleSynced(uint256 price, uint64 updatedAt);
    event BadDebtRecorded(address indexed user, uint256 amount);

    error Invalid();
    error PausedError();
    error Cap();
    error Liquidity();
    error Health();
    error OracleStale();
    error Unauthorized();
    error TransferFailed();
    error Reentrancy();
    error OracleDeviation();

    modifier lock() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }
    modifier live() {
        if (paused) revert PausedError();
        _;
    }

    constructor(
        IERC20Collateral collateral_,
        IArcPriceOracle oracle_,
        address admin_,
        address guardian_,
        uint256 supplyCap_,
        uint256 borrowCap_,
        uint256 baseRatePerYear_,
        uint256 multiplierPerYear_,
        uint256 jumpMultiplierPerYear_,
        uint256 kink_
    ) {
        if (
            address(collateral_) == address(0) || address(oracle_) == address(0) || admin_ == address(0)
                || guardian_ == address(0) || supplyCap_ == 0 || borrowCap_ == 0 || kink_ == 0 || kink_ > WAD
                || baseRatePerYear_ > WAD || multiplierPerYear_ > 10 * WAD || jumpMultiplierPerYear_ > 100 * WAD
        ) revert Invalid();
        collateralToken = collateral_;
        uint8 collateralDecimals = collateral_.decimals();
        if (collateralDecimals > 18) revert Invalid();
        collateralUnit = 10 ** collateralDecimals;
        oracle = oracle_;
        admin = admin_;
        guardian = guardian_;
        supplyCap = supplyCap_;
        borrowCap = borrowCap_;
        baseRatePerYear = baseRatePerYear_;
        multiplierPerYear = multiplierPerYear_;
        jumpMultiplierPerYear = jumpMultiplierPerYear_;
        kink = kink_;
        lastAccrual = uint64(block.timestamp);
        (uint256 initialPrice, uint64 initialUpdatedAt) = oracle_.price();
        if (initialPrice == 0 || initialUpdatedAt > block.timestamp || block.timestamp - initialUpdatedAt > MAX_ORACLE_AGE) revert OracleStale();
        lastGoodPrice = initialPrice;
        lastGoodPriceAt = initialUpdatedAt;
    }

    receive() external payable {
        revert Invalid();
    }

    /// Fraction of assets currently borrowed, WAD-scaled. Read before this
    /// accrual's interest is added, matching the balance the rate is meant to
    /// react to (the state at the start of the period, not its own output).
    function utilization() public view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        uint256 u = totalBorrows * WAD / assets;
        return u > WAD ? WAD : u;
    }

    function borrowRatePerYear() public view returns (uint256) {
        uint256 u = utilization();
        if (u <= kink) return baseRatePerYear + u * multiplierPerYear / WAD;
        uint256 normalRate = baseRatePerYear + kink * multiplierPerYear / WAD;
        return normalRate + (u - kink) * jumpMultiplierPerYear / WAD;
    }

    function supplyRatePerYear() public view returns (uint256) {
        return borrowRatePerYear() * utilization() / WAD * (BPS - RESERVE_FACTOR_BPS) / BPS;
    }

    function accrue() public {
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return;
        lastAccrual = uint64(block.timestamp);
        if (totalBorrows == 0) return;
        uint256 ratePerSecond = borrowRatePerYear() / 365 days;
        uint256 factor = ratePerSecond * elapsed;
        uint256 interest = totalBorrows * factor / WAD;
        totalBorrows += interest;
        reserves += interest * RESERVE_FACTOR_BPS / BPS;
        borrowIndex += borrowIndex * factor / WAD;
    }

    function totalAssets() public view returns (uint256) {
        return address(this).balance + totalBorrows - reserves;
    }

    function debtOf(address user) public view returns (uint256) {
        return debtShares[user] * borrowIndex / WAD;
    }

    function _price() internal view returns (uint256 value) {
        value = lastGoodPrice;
        if (value == 0 || lastGoodPriceAt > block.timestamp || block.timestamp - lastGoodPriceAt > MAX_ORACLE_AGE) {
            revert OracleStale();
        }
    }

    function syncOracle() public {
        (uint256 next, uint64 updatedAt) = oracle.price();
        if (next == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_ORACLE_AGE) revert OracleStale();
        uint256 delta = next > lastGoodPrice ? next - lastGoodPrice : lastGoodPrice - next;
        if (delta * BPS > lastGoodPrice * MAX_ORACLE_DEVIATION_BPS) revert OracleDeviation();
        lastGoodPrice = next; lastGoodPriceAt = updatedAt;
        emit OracleSynced(next, updatedAt);
    }

    function acceptOraclePrice() external {
        if (msg.sender != admin) revert Unauthorized();
        (uint256 next, uint64 updatedAt) = oracle.price();
        if (next == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_ORACLE_AGE) revert OracleStale();
        lastGoodPrice = next; lastGoodPriceAt = updatedAt;
        emit OracleSynced(next, updatedAt);
    }

    function collateralValue(address user) public view returns (uint256) {
        return collateralOf[user] * _price() / collateralUnit;
    }

    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = debtOf(user);
        if (debt == 0) return type(uint256).max;
        return collateralValue(user) * LIQUIDATION_THRESHOLD_BPS * WAD / BPS / debt;
    }

    function supply() external payable live lock returns (uint256 shares) {
        if (pauseFlags & PAUSE_SUPPLY != 0) revert PausedError();
        accrue();
        if (msg.value == 0 || totalAssets() > supplyCap) revert Cap();
        uint256 assetsBefore = totalAssets() - msg.value;
        shares = totalSupplyShares == 0 ? msg.value : msg.value * totalSupplyShares / assetsBefore;
        if (shares == 0) revert Invalid();
        totalSupplyShares += shares;
        supplyShares[msg.sender] += shares;
        emit Supplied(msg.sender, msg.value, shares);
    }

    function withdraw(uint256 shares) external lock returns (uint256 assets) {
        accrue();
        if (shares == 0 || shares > supplyShares[msg.sender]) revert Invalid();
        assets = shares * totalAssets() / totalSupplyShares;
        if (assets > address(this).balance) revert Liquidity();
        supplyShares[msg.sender] -= shares;
        totalSupplyShares -= shares;
        (bool ok,) = payable(msg.sender).call{value: assets}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, assets, shares);
    }

    function depositCollateral(uint256 amount) external live lock {
        if (pauseFlags & PAUSE_COLLATERAL != 0) revert PausedError();
        if (amount == 0) revert Invalid();
        if (!collateralToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        collateralOf[msg.sender] += amount;
        emit CollateralChanged(msg.sender, int256(amount));
    }

    function withdrawCollateral(uint256 amount) external lock {
        accrue();
        if (amount == 0 || amount > collateralOf[msg.sender]) revert Invalid();
        collateralOf[msg.sender] -= amount;
        uint256 debt = debtOf(msg.sender);
        if (debt != 0 && debt * BPS > collateralValue(msg.sender) * MAX_LTV_BPS) revert Health();
        if (!collateralToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit CollateralChanged(msg.sender, -int256(amount));
    }

    function borrow(uint256 amount) external live lock {
        if (pauseFlags & PAUSE_BORROW != 0) revert PausedError();
        accrue();
        if (amount == 0 || totalBorrows + amount > borrowCap || amount > address(this).balance) revert Cap();
        uint256 newDebt = debtOf(msg.sender) + amount;
        if (newDebt * BPS > collateralValue(msg.sender) * MAX_LTV_BPS) revert Health();
        uint256 shares = (amount * WAD + borrowIndex - 1) / borrowIndex;
        debtShares[msg.sender] += shares;
        totalBorrows += amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Borrowed(msg.sender, amount);
    }

    function repay(address user) external payable lock {
        accrue();
        uint256 debt = debtOf(user);
        if (msg.value == 0 || debt == 0) revert Invalid();
        uint256 payment = msg.value > debt ? debt : msg.value;
        uint256 shares = payment == debt ? debtShares[user] : payment * WAD / borrowIndex;
        if (shares == 0) revert Invalid();
        uint256 repaid = payment == debt ? debt : shares * borrowIndex / WAD;
        debtShares[user] -= shares;
        totalBorrows -= repaid;
        if (msg.value > repaid) {
            (bool refundOk,) = payable(msg.sender).call{value: msg.value - repaid}("");
            if (!refundOk) revert TransferFailed();
        }
        emit Repaid(user, repaid);
    }

    function liquidate(address user) external payable lock {
        accrue();
        uint256 debt = debtOf(user);
        uint256 maxRepay = debt / 2;
        if (maxRepay == 0) maxRepay = debt;
        if (healthFactor(user) >= WAD || msg.value == 0 || msg.value > maxRepay) revert Health();
        uint256 shares = msg.value * WAD / borrowIndex;
        if (shares == 0) revert Invalid();
        uint256 repaid = shares * borrowIndex / WAD;
        debtShares[user] -= shares;
        totalBorrows -= repaid;
        if (msg.value > repaid) {
            (bool refundOk,) = payable(msg.sender).call{value: msg.value - repaid}("");
            if (!refundOk) revert TransferFailed();
        }
        uint256 seize = repaid * (BPS + LIQUIDATION_BONUS_BPS) * collateralUnit / BPS / _price();
        if (seize > collateralOf[user]) seize = collateralOf[user];
        collateralOf[user] -= seize;
        if (!collateralToken.transfer(msg.sender, seize)) revert TransferFailed();
        emit Liquidated(user, msg.sender, repaid, seize);
    }

    function setPaused(bool state) external {
        if (msg.sender != guardian && msg.sender != admin) revert Unauthorized();
        paused = state;
        emit Paused(state);
    }

    function setPauseFlags(uint256 flags) external {
        if (msg.sender != guardian && msg.sender != admin) revert Unauthorized();
        pauseFlags = flags; emit PauseFlagsSet(flags);
    }

    function setCaps(uint256 nextSupplyCap, uint256 nextBorrowCap) external {
        if ((msg.sender != admin && msg.sender != guardian) || nextSupplyCap == 0 || nextBorrowCap == 0) revert Unauthorized();
        if (nextSupplyCap > supplyCap || nextBorrowCap > borrowCap) revert Cap();
        supplyCap = nextSupplyCap; borrowCap = nextBorrowCap;
        emit CapsSet(nextSupplyCap, nextBorrowCap);
    }

    function scheduleCapIncrease(uint256 nextSupplyCap, uint256 nextBorrowCap) external {
        if (msg.sender != admin || nextSupplyCap < supplyCap || nextBorrowCap < borrowCap) revert Unauthorized();
        if (nextSupplyCap == supplyCap && nextBorrowCap == borrowCap) revert Invalid();
        pendingSupplyCap = nextSupplyCap;
        pendingBorrowCap = nextBorrowCap;
        capIncreaseEta = uint64(block.timestamp + CAP_INCREASE_DELAY);
        emit CapIncreaseScheduled(nextSupplyCap, nextBorrowCap, capIncreaseEta);
    }

    function cancelCapIncrease() external {
        if (msg.sender != admin && msg.sender != guardian) revert Unauthorized();
        pendingSupplyCap = 0; pendingBorrowCap = 0; capIncreaseEta = 0;
        emit CapIncreaseCancelled();
    }

    function executeCapIncrease() external {
        uint64 eta = capIncreaseEta;
        if (eta == 0 || block.timestamp < eta) revert Invalid();
        uint256 nextSupplyCap = pendingSupplyCap;
        uint256 nextBorrowCap = pendingBorrowCap;
        pendingSupplyCap = 0; pendingBorrowCap = 0; capIncreaseEta = 0;
        supplyCap = nextSupplyCap; borrowCap = nextBorrowCap;
        emit CapsSet(nextSupplyCap, nextBorrowCap);
    }

    function recordBadDebt(address user) external lock {
        accrue();
        if (collateralOf[user] != 0 || debtOf(user) == 0) revert Health();
        uint256 amount = debtOf(user);
        totalBorrows -= amount;
        debtShares[user] = 0;
        badDebt += amount;
        emit BadDebtRecorded(user, amount);
    }

    function setGuardian(address next) external {
        if (msg.sender != admin || next == address(0)) revert Unauthorized();
        guardian = next;
    }

    function withdrawReserves() external lock {
        if (msg.sender != admin) revert Unauthorized();
        accrue();
        uint256 amount = reserves;
        if (amount == 0 || amount > address(this).balance) revert Liquidity();
        reserves = 0;
        (bool ok,) = payable(admin).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
