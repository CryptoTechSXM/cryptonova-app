// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  StabilityFund v3
 * @notice V8.7 "Elevator" -- OPERATIONAL reserve only.
 *
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Holds and deploys USDC to guarantee every member advances without stalling.
 *  CNOVA floor-price backing has moved to CNOVATreasury (redeemAtFloor).
 *  This fund is PURELY operational -- it has zero interaction with CNOVA price.
 *
 *  TREASURY IS SACRED -- zero interaction with CNOVATreasury or CNOVA token.
 *
 * FUNDING LAYERS (V8.7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  L1: Per-entry stabilityBps carve (6% T1-T3, 5% T4-T10)
 *      --> FigureEightMatrixV8._distributeEntry() via receiveLayer(tier, amt, 1)
 *
 *  L3: Withdrawal fee -- DYNAMIC SLIDING DESTINATION
 *      --> FigureEightMatrixV8.withdraw() calls receiveLayer(tier, amt, 3)
 *      --> SF health >= sfTarget(): 100% goes to BuybackReserve
 *      --> SF health = 0%:          100% stays in SF
 *      --> Linear slide between the two extremes
 *      --> healthBps() = min(totalBalance / sfTarget(), 10000)
 *      --> V8.21: sfTarget() auto-scales with the highest tier the system has
 *          organically opened (tierEntryFees[tier] x sfTargetMultiplier[tier]),
 *          falling back to a flat manual override pre-launch. See the
 *          sfTarget() function below for full semantics.
 *
 *  L5: Early exit penalties
 *      --> FigureEightMatrixV8.earlyEscrowRelease() via receiveLayer(tier, amt, 5)
 *
 * OPERATIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *  payForceCross()      -- keeper: fund parked-wallet rescue (forceCrossKeeper)
 *  payGhostEntry()      -- keeper: fund synthetic BFS ghost slot
 *  payReentryDiscount() -- keeper: top up a member slightly short of crossing fee
 *
 * SLIDING WITHDRAWAL FEE FORMULA
 * ─────────────────────────────────────────────────────────────────────────────
 *  healthBps   = min(totalBalance * 10000 / sfTarget(), 10000)
 *  toBuyback   = feeAmount * healthBps / 10000
 *  toSF        = feeAmount - toBuyback
 *
 *  When SF is full  (health=100%): entire withdrawal fee routes to BuybackReserve.
 *  When SF is empty (health=0%):   entire withdrawal fee routes back to SF.
 *  Linear interpolation between: self-healing when depleted, deflationary when healthy.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPairManagerV8Ghost {
    function ghostEntry(uint8 tierIndex) external;
    function entryFee() external view returns (uint256);
}

/// @dev Minimal hook for the BuybackReserve accounting.
interface IBuybackReserve {
    function receiveContribution(uint256 amount) external;
}

/// @dev Minimal interface for CommunityWallet deposit.
interface ICommunityWallet {
    function deposit(uint256 amount) external;
}

/// @dev Minimal hook for V8.21 tier-dynamic SF target -- reads TierRouter's
///      organic progress signal (highest tier both deployed and velocity-green).
interface ITierRouterTierInfo {
    function highestOpenTier() external view returns (uint8);
}

contract StabilityFund is Ownable2Step {
    using SafeERC20 for IERC20;

    uint8 public constant MAX_TIERS = 10;

    // ── Tokens ───────────────────────────────────────────────────────────────
    IERC20 public immutable usdc;

    // ── Authorized callers ───────────────────────────────────────────────────
    address public matrixKeeper;
    address public tierRouter;
    mapping(address => bool) public authorizedMatrices;

    // ── BuybackReserve ───────────────────────────────────────────────────────
    /// @notice Receives overflow from sliding withdrawal fee when SF is healthy.
    address public buybackReserve;

    /// @notice V8.20: DAO governance contract. Co-governs the params below
    ///         alongside owner -- neither replaces the other (owner keeps emergency backstop).
    address public governance;

    // ── CommunityWallet carve-out ─────────────────────────────────────────────
    /// @notice CommunityWallet address. When set, 1% of L1 deposits route here.
    address public communityWallet;
    /// @notice BPS carved from L1 deposits to CommunityWallet. Default 0 in V8.9
    ///         (community carve moved to SplitConfig in FigureEightMatrixV8).
    ///         Can be non-zero for emergency/manual SF-level carve via admin.
    // V8.9: community carve now lives in SplitConfig at matrix level — default 0 here.
    uint256 public communityCarveOutBps = 0;

    // ── Sliding formula target ────────────────────────────────────────────────
    /// @notice V8.21: sfTarget is now a DERIVED view (see the `sfTarget()`
    ///         function below), not a plain storage slot -- ABI shape is
    ///         unchanged (`function sfTarget() view returns (uint256)`), so
    ///         every existing reader (frontend, system_keeper.js, tests)
    ///         keeps working without changes.
    ///
    ///         When `sfTargetAutoMode` is on AND `tierRouter` is wired AND the
    ///         current highest open tier has a registered entryFee, the
    ///         effective target auto-scales with how far the system has
    ///         organically progressed: tierEntryFees[idx] * sfTargetMultiplier[idx]
    ///         (e.g. T1 entry fee x10, T2 x20, T3 x30... by default). This is
    ///         the "auto-increasing as tiers climb" behavior requested by the
    ///         user, replacing the old flat $300 default that never moved on
    ///         its own.
    ///
    ///         `_manualSfTarget` is the fallback used whenever auto-mode is
    ///         off, tierRouter isn't wired yet, or the current tier has no
    ///         entry fee registered on this contract (e.g. pre-launch). It is
    ///         still set via the existing `setSFTarget()` DAO-governable path
    ///         (PARAM_SF_TARGET, unchanged) -- so existing governance
    ///         proposals/tests against that param keep working exactly as
    ///         before whenever tierRouter is unset (e.g. in unit tests that
    ///         never wire StabilityFund.tierRouter).
    uint256 private _manualSfTarget;

    /// @notice Per-tier multiplier applied to that tier's entry fee to derive
    ///         the auto-computed sfTarget. Index 0 = T1. V8.22: each tier is
    ///         independently DAO-governable (PARAM_SF_MULT_T1..T10 in
    ///         V8Governance.sol) as well as owner-tunable -- reversed from the
    ///         V8.21 "owner-only array" decision after further user feedback.
    uint256[MAX_TIERS] public sfTargetMultiplier;

    /// @notice When true (default), `sfTarget()` auto-computes from the
    ///         current highest open tier's entry fee x its multiplier.
    ///         When false, `sfTarget()` always returns the manual override.
    bool public sfTargetAutoMode = true;

    // ── Tier fee registry ─────────────────────────────────────────────────────
    uint256[MAX_TIERS] public tierEntryFees;

    // ── Balances ─────────────────────────────────────────────────────────────
    mapping(uint8 => uint256) public balanceByTier;
    mapping(uint8 => uint256) public balanceByLayer;
    uint256 public totalBalance;
    uint256 public stabilityFloor;

    // ── Metrics ───────────────────────────────────────────────────────────────
    uint256 public totalDeposited;
    uint256 public totalGhostEntries;
    uint256 public totalDiscountsPaid;
    uint256 public totalGhostCost;
    uint256 public totalRoutedToBuyback; // sliding fee → BBR
    uint256 public totalRoutedToSF;      // sliding fee → SF

    // ── Events ───────────────────────────────────────────────────────────────
    event FundDeposit(uint8 indexed tier, uint256 amount, uint8 layer, address from);
    event GhostEntryFunded(uint8 indexed tier, uint256 cost, uint256 remainingBalance);
    event DiscountPaid(address indexed member, uint256 discount, uint256 remainingBalance);
    event FundWithdrawn(address indexed to, uint256 amount, string reason);
    event DebtRepaymentReceived(address indexed matrix, uint256 amount);
    event MatrixKeeperSet(address indexed keeper);
    event TierRouterSet(address indexed router);
    event MatrixAuthorized(address indexed matrix, bool authorized);
    event TierFeeSet(uint8 indexed tier, uint256 fee);
    event StabilityFloorSet(uint256 floor);
    event BuybackReserveSet(address indexed bbr);
    event SFTargetSet(uint256 target);
    event CommunityWalletSet(address indexed cw);
    event CommunityCarveOutBpsSet(uint256 bps);
    event WithdrawalFeeRouted(uint8 indexed tier, uint256 toSF, uint256 toBuyback, uint256 healthBps);
    event GovernanceSet(address indexed governance);
    // V8.21
    event SfTargetMultiplierSet(uint8 indexed tierIndex, uint256 multiplier);
    event SfTargetAutoModeSet(bool enabled);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _admin) Ownable(_admin) {
        require(_usdc != address(0), "SF: zero usdc");
        usdc             = IERC20(_usdc);
        _manualSfTarget  = 300_000_000; // $300 default fallback (used pre-tierRouter-wiring)

        // V8.26: flat 20x multiplier across all tiers by default.
        // DAO can vote to change any tier independently via PARAM_SF_MULT_T1..T10.
        for (uint8 i = 0; i < MAX_TIERS; i++) {
            sfTargetMultiplier[i] = 20;
        }
    }

    // ── Admin setup ──────────────────────────────────────────────────────────

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "SF: not authorized");
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        require(_gov != address(0), "SF: zero governance");
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    function setMatrixKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "SF: zero keeper");
        matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    function setTierRouter(address _tr) external onlyOwner {
        require(_tr != address(0), "SF: zero tierRouter");
        tierRouter = _tr;
        emit TierRouterSet(_tr);
    }

    function setMatrixAuthorized(address matrix, bool authorized) external onlyOwner {
        require(matrix != address(0), "SF: zero matrix");
        authorizedMatrices[matrix] = authorized;
        emit MatrixAuthorized(matrix, authorized);
    }

    function setTierFee(uint8 tierIndex, uint256 fee) external onlyOwner {
        require(tierIndex < MAX_TIERS, "SF: invalid tier");
        require(fee > 0,               "SF: zero fee");
        tierEntryFees[tierIndex] = fee;
        emit TierFeeSet(tierIndex, fee);
    }

    /// @notice V8.20: DAO-governable. Was unbounded before -- now capped at
    ///         sfTarget() (the floor can never exceed the EFFECTIVE current
    ///         health target -- whether auto-computed or manual -- or SF could
    ///         never spend even once "fully funded"). sfTarget() is itself
    ///         bounded $100-$10,000 when in manual mode; the auto-computed
    ///         value is bounded by tierEntryFees x sfTargetMultiplier instead.
    function setStabilityFloor(uint256 floor) external onlyOwnerOrGovernance {
        require(floor <= sfTarget(), "SF: floor exceeds target");
        stabilityFloor = floor;
        emit StabilityFloorSet(floor);
    }

    /// @notice Set the BuybackReserve address. Receives overflow from sliding fee.
    function setBuybackReserve(address _bbr) external onlyOwner {
        require(_bbr != address(0), "SF: zero bbr");
        buybackReserve = _bbr;
        emit BuybackReserveSet(_bbr);
    }

    /// @notice Set the manual SF health target fallback (6-dec USDC). This is
    ///         the value `sfTarget()` returns when auto-mode is off, when
    ///         `tierRouter` isn't wired, or when the current open tier has no
    ///         entry fee registered here -- it is NOT the live effective
    ///         target whenever auto-mode is active with tierRouter wired (see
    ///         `sfTarget()` below and the V8.21 redesign note on
    ///         `_manualSfTarget`).
    ///         Allowed: 100e6 ($100) to 10000e6 ($10,000).
    ///         V8.20: DAO-governable (PARAM_SF_TARGET, unchanged numbering).
    ///         Cannot drop below stabilityFloor (same invariant enforced the
    ///         other way in setStabilityFloor).
    function setSFTarget(uint256 _target) external onlyOwnerOrGovernance {
        require(_target >= 100_000_000,   "SF: target too low");
        require(_target <= 10_000_000_000, "SF: target too high");
        require(_target >= stabilityFloor, "SF: target below floor");
        _manualSfTarget = _target;
        emit SFTargetSet(_target);
    }

    /// @notice Owner-only convenience setter covering any tier in one call.
    ///         V8.22: kept for emergency/bulk admin use, but each tier is ALSO
    ///         independently DAO-governable now via the ten single-value
    ///         siblings below (setSfTargetMultiplierT1..T10) -- reversing the
    ///         V8.21 decision to keep this owner-only-array-only. Same
    ///         pattern CNOVADirectSale uses for setTargets/setCaps (multi-arg
    ///         convenience setter stays owner-only; single-value siblings are
    ///         what governance proposals actually call, since propose() can
    ///         only carry one uint256 value per proposal).
    function setSfTargetMultiplier(uint8 tierIndex, uint256 multiplier) external onlyOwner {
        _setSfTargetMultiplier(tierIndex, multiplier);
    }

    /// @notice V8.22: per-tier DAO-governable siblings of setSfTargetMultiplier()
    ///         above. One PARAM_SF_MULT_T{n} id per tier in V8Governance.sol --
    ///         a real DAO vote can now move T7's multiplier without touching
    ///         T1-T6/T8-T10. Same bound (1-1000) and event as the owner-only
    ///         convenience setter; owner keeps the emergency backstop via
    ///         onlyOwnerOrGovernance, neither path replaces the other.
    function setSfTargetMultiplierT1(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(0, m); }
    function setSfTargetMultiplierT2(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(1, m); }
    function setSfTargetMultiplierT3(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(2, m); }
    function setSfTargetMultiplierT4(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(3, m); }
    function setSfTargetMultiplierT5(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(4, m); }
    function setSfTargetMultiplierT6(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(5, m); }
    function setSfTargetMultiplierT7(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(6, m); }
    function setSfTargetMultiplierT8(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(7, m); }
    function setSfTargetMultiplierT9(uint256 m)  external onlyOwnerOrGovernance { _setSfTargetMultiplier(8, m); }
    function setSfTargetMultiplierT10(uint256 m) external onlyOwnerOrGovernance { _setSfTargetMultiplier(9, m); }

    function _setSfTargetMultiplier(uint8 tierIndex, uint256 multiplier) internal {
        require(tierIndex < MAX_TIERS,        "SF: invalid tier");
        require(multiplier > 0 && multiplier <= 1000, "SF: invalid multiplier");
        sfTargetMultiplier[tierIndex] = multiplier;
        emit SfTargetMultiplierSet(tierIndex, multiplier);
    }

    /// @notice V8.21: owner-only kill switch for tier-dynamic auto-scaling.
    ///         When disabled, sfTarget() always returns the manual override
    ///         (set via setSFTarget()), regardless of tierRouter wiring.
    function setSfTargetAutoMode(bool enabled) external onlyOwner {
        sfTargetAutoMode = enabled;
        emit SfTargetAutoModeSet(enabled);
    }

    /// @notice Set the CommunityWallet address for the 1% L1 carve.
    ///         Set to address(0) to disable routing without changing carveOutBps.
    function setCommunityWallet(address _cw) external onlyOwner {
        communityWallet = _cw;
        emit CommunityWalletSet(_cw);
    }

    /// @notice Adjust the L1 community carve-out (0–500 BPS, default 100 = 1%).
    ///         Set to 0 to pause routing while keeping communityWallet configured.
    ///         V8.20: DAO-governable. Allowed: 0,100,200,300,400,500.
    function setCommunityCarveOutBps(uint256 bps) external onlyOwnerOrGovernance {
        require(
            bps == 0 || bps == 100 || bps == 200 ||
            bps == 300 || bps == 400 || bps == 500,
            "SF: invalid carve bps"
        );
        communityCarveOutBps = bps;
        emit CommunityCarveOutBpsSet(bps);
    }

    // ── Health formula ────────────────────────────────────────────────────────

    /// @notice V8.21: the EFFECTIVE current SF health target (6-dec USDC).
    ///         ABI-compatible drop-in for the old plain storage getter --
    ///         every external reader (frontend, system_keeper.js, tests) that
    ///         calls `sfTarget()` keeps working unchanged.
    ///
    ///         Auto-computed as tierEntryFees[idx] * sfTargetMultiplier[idx]
    ///         for the current highest-open tier (read live from TierRouter)
    ///         whenever: sfTargetAutoMode is true, tierRouter is wired, the
    ///         router reports a tier > 0, AND this contract has a non-zero
    ///         entry fee registered for that tier (via setTierFee()).
    ///         Otherwise falls back to the manual override (_manualSfTarget,
    ///         set via setSFTarget()) -- this is what keeps every existing
    ///         test/deployment that never wires StabilityFund.tierRouter
    ///         working exactly as before.
    function sfTarget() public view returns (uint256) {
        if (sfTargetAutoMode && tierRouter != address(0)) {
            uint8 tierNum = ITierRouterTierInfo(tierRouter).highestOpenTier();
            if (tierNum > 0) {
                uint8 idx = tierNum - 1;
                uint256 fee = tierEntryFees[idx];
                if (fee > 0) {
                    return fee * sfTargetMultiplier[idx];
                }
            }
        }
        return _manualSfTarget;
    }

    /**
     * @notice SF health in BPS (0-10000).
     *         0    = empty, 100% of withdrawal fees route to SF
     *         5000 = half full, 50/50 split
     *         10000 = at/above target, 100% of withdrawal fees route to BBR
     */
    function healthBps() public view returns (uint256) {
        uint256 target = sfTarget();
        if (target == 0) return 10000; // no target set -- always healthy
        if (totalBalance >= target)    return 10000;
        return (totalBalance * 10000) / target;
    }

    // ── Funding entry point ───────────────────────────────────────────────────

    /**
     * @notice Receive a contribution from an authorized matrix, router, or keeper.
     *
     *         Layer routing (V8.7):
     *           L1 (layer=1): per-entry stabilityBps carve   -- straight to SF
     *           L3 (layer=3): withdrawal health fee          -- SLIDING FORMULA
     *           L5 (layer=5): early exit penalty             -- straight to SF
     *
     *         Layer 3 sliding formula:
     *           health = healthBps()
     *           toSF      = amount * (10000 - health) / 10000
     *           toBuyback = amount - toSF
     *           SF keeps toSF, forwards toBuyback to BuybackReserve.
     *
     * @param tierIdx  0-(MAX_TIERS-1)
     * @param amount   USDC amount (6 decimals). Caller MUST approve first.
     * @param layer    1, 3, or 5
     */
    function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external {
        require(
            authorizedMatrices[msg.sender] ||
            msg.sender == tierRouter       ||
            msg.sender == matrixKeeper     ||
            msg.sender == owner(),
            "SF: unauthorized"
        );
        require(tierIdx < MAX_TIERS,              "SF: invalid tier");
        require(layer == 1 || layer == 3 || layer == 5, "SF: invalid layer");
        require(amount > 0,                       "SF: zero amount");

        // Pull USDC from caller
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (layer == 3) {
            // ── Sliding withdrawal fee routing ────────────────────────────────
            uint256 health     = healthBps();
            uint256 toBuyback  = (amount * health) / 10000;
            uint256 toSF       = amount - toBuyback;

            if (toSF > 0) {
                balanceByTier[tierIdx]  += toSF;
                balanceByLayer[layer]   += toSF;
                totalBalance            += toSF;
                totalDeposited          += toSF;
                totalRoutedToSF         += toSF;
            }

            if (toBuyback > 0 && buybackReserve != address(0)) {
                usdc.safeTransfer(buybackReserve, toBuyback);
                try IBuybackReserve(buybackReserve).receiveContribution(toBuyback) {} catch {}
                totalRoutedToBuyback += toBuyback;
            } else if (toBuyback > 0) {
                // No BBR set -- keep in SF instead
                balanceByTier[tierIdx] += toBuyback;
                balanceByLayer[layer]  += toBuyback;
                totalBalance           += toBuyback;
                totalDeposited         += toBuyback;
                totalRoutedToSF        += toBuyback;
            }

            emit WithdrawalFeeRouted(tierIdx, toSF, toBuyback, health);

        } else {
            // ── L1: community carve-out, then straight into SF ────────────────
            // ── L5: straight into SF (no community carve on penalty fees) ──────
            if (layer == 1 && communityWallet != address(0) && communityCarveOutBps > 0) {
                uint256 carve = (amount * communityCarveOutBps) / 10_000;
                if (carve > 0) {
                    amount -= carve;
                    usdc.forceApprove(communityWallet, carve);
                    try ICommunityWallet(communityWallet).deposit(carve) {}
                    catch {
                        // CommunityWallet rejected deposit — keep in SF instead
                        amount += carve;
                        usdc.forceApprove(communityWallet, 0);
                    }
                }
            }

            balanceByTier[tierIdx] += amount;
            balanceByLayer[layer]  += amount;
            totalBalance           += amount;
            totalDeposited         += amount;

            emit FundDeposit(tierIdx, amount, layer, msg.sender);
        }
    }

    // ── Spending (keeper-only) ────────────────────────────────────────────────

    function payGhostEntry(uint8 tierIndex, address pairManager) external {
        require(msg.sender == matrixKeeper,   "SF: not keeper");
        require(tierIndex < MAX_TIERS,        "SF: invalid tier");
        require(pairManager != address(0),    "SF: zero pairManager");

        uint256 cost = tierEntryFees[tierIndex];
        require(cost > 0,                          "SF: tier fee not set");
        require(totalBalance >= cost + stabilityFloor, "SF: below floor");

        if (balanceByTier[tierIndex] >= cost) {
            balanceByTier[tierIndex] -= cost;
        } else {
            balanceByTier[tierIndex] = 0;
        }
        totalBalance -= cost;

        usdc.safeTransfer(pairManager, cost);

        totalGhostEntries += 1;
        totalGhostCost    += cost;

        emit GhostEntryFunded(tierIndex, cost, totalBalance);
    }

    function payReentryDiscount(
        address member,
        address recipient,
        uint256 discount
    ) external {
        require(msg.sender == matrixKeeper, "SF: not keeper");
        require(member    != address(0),   "SF: zero member");
        require(recipient != address(0),   "SF: zero recipient");
        require(discount  > 0,             "SF: zero discount");
        require(totalBalance >= discount + stabilityFloor, "SF: below floor");

        totalBalance -= discount;
        usdc.safeTransfer(recipient, discount);

        totalDiscountsPaid += 1;

        emit DiscountPaid(member, discount, totalBalance);
    }

    function payForceCross(
        uint8   tierIdx,
        address sourceMatrix,
        uint256 fee
    ) external {
        require(msg.sender == matrixKeeper,  "SF: not keeper");
        require(tierIdx < MAX_TIERS,         "SF: invalid tier");
        require(sourceMatrix != address(0),  "SF: zero matrix");
        require(fee > 0,                     "SF: zero fee");
        require(totalBalance >= fee + stabilityFloor, "SF: below floor");

        if (balanceByTier[tierIdx] >= fee) {
            balanceByTier[tierIdx] -= fee;
        } else {
            balanceByTier[tierIdx] = 0;
        }
        totalBalance -= fee;

        usdc.safeTransfer(sourceMatrix, fee);

        emit FundDeposit(tierIdx, fee, 0, address(this));
    }

    // ── V8.18: Member co-pay rescue ───────────────────────────────────────────

    /**
     * @notice Authorized matrix pulls sfShare from SF to co-fund a coPayRescue.
     *         SF covers 50% of the member's withdrawable; matrix calls this then
     *         pulls the member's wallet share via safeTransferFrom in coPayRescue().
     *         Only callable by an authorizedMatrix.
     */
    function payCoRescue(uint8 tierIdx, uint256 sfShare) external {
        require(authorizedMatrices[msg.sender], "SF: not authorized matrix");
        require(tierIdx < MAX_TIERS,            "SF: invalid tier");
        require(sfShare > 0,                    "SF: zero share");
        require(totalBalance >= sfShare + stabilityFloor, "SF: below floor");

        if (balanceByTier[tierIdx] >= sfShare) {
            balanceByTier[tierIdx] -= sfShare;
        } else {
            balanceByTier[tierIdx] = 0;
        }
        totalBalance -= sfShare;

        usdc.safeTransfer(msg.sender, sfShare);

        emit FundWithdrawn(msg.sender, sfShare, "coPayRescue");
    }

    /**
     * @notice Called by an authorized matrix to repay a member's SF rescue loan.
     *         The matrix must have approved `amount` USDC to this contract before
     *         calling. SF pulls the USDC and increments totalBalance.
     *         Only callable by authorizedMatrices.
     */
    function receiveDebtRepayment(uint256 amount) external {
        require(authorizedMatrices[msg.sender], "SF: not authorized matrix");
        require(amount > 0,                     "SF: zero amount");

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalBalance += amount;

        emit DebtRepaymentReceived(msg.sender, amount);
    }

    // ── Governance: emergency withdrawal ─────────────────────────────────────

    function withdraw(
        uint256 amount,
        address to,
        string calldata reason
    ) external onlyOwner {
        require(amount > 0,             "SF: zero amount");
        require(to != address(0),       "SF: zero recipient");
        require(amount <= totalBalance, "SF: insufficient balance");
        totalBalance -= amount;
        usdc.safeTransfer(to, amount);
        emit FundWithdrawn(to, amount, reason);
    }
}
