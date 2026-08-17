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
 *  L1: Per-entry stabilityBps carve -- A FLAT 3% ON ALL TEN TIERS.
 *      --> FigureEightMatrixV8._distributeEntry() via receiveLayer(tier, amt, 1)
 *
 *      V8.48 item 29: this line used to read "6% T1-T3, 5% T4-T10". It was wrong
 *      twice over -- tier-VARYING when the rate is flat, and roughly DOUBLE the real
 *      figure. The deployed value is SPLITS_ALL[4] = 300 bps (deploy_v8.js:103), and
 *      tierSplits(tierNum) returns that same array for every tier, so there is no
 *      per-tier variation to describe.
 *
 *      It is not a harmless comment. Item 26 (SF surplus redirect to the
 *      CommunityWallet) was nearly modelled off it, which would have sized the carve
 *      at 2x reality. DO NOT restate the rate here when it changes -- the number
 *      lives in deploy_v8.js and a copy in a header is a copy that goes stale.
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
    /// @notice V8.35: MatrixPairFactory. When wired, factory can call
    ///         setMatrixAuthorized() to register newly deployed matrices inline.
    address public pairFactory;
    /// @notice V8.32 param #50: fraction of pool-share redirected to SF as rescue-loan repayment.
    ///         DAO-votable via V8Governance param #50 (PARAM_SF_RESCUE_REPAY_BPS).
    uint256 public rescueRepayBps = 10_000;

    // ── CommunityWallet carve-out ─────────────────────────────────────────────
    /// @notice CommunityWallet address. When set, 1% of L1 deposits route here.
    address public communityWallet;
    /// @notice BPS carved from L1 deposits to CommunityWallet. Default 0 in V8.9
    ///         (community carve moved to SplitConfig in FigureEightMatrixV8).
    ///         Can be non-zero for emergency/manual SF-level carve via admin.
    // V8.9: community carve now lives in SplitConfig at matrix level — default 0 here.
    uint256 public communityCarveOutBps = 0;

    /// @notice V8.48 item 26 — SURPLUS-ONLY community redirect (owner proposal 2026-08-09).
    ///
    ///         DISTINCT FROM communityCarveOutBps ABOVE, deliberately. That one carves a
    ///         slice of EVERY L1 deposit unconditionally. This one fires ONLY while the
    ///         fund is at or above sfTarget(). Together they express a policy the DAO can
    ///         actually tune: "the community gets nothing until the Stability Fund is
    ///         healthy, and a share of everything after that". Set both and they stack —
    ///         the carve is taken first, then this applies to what remains.
    ///
    ///         DEFAULT 10_000 (V8.48, owner decision 2026-08-13): once the fund is at
    ///         target, EVERY incremental L1 dollar is surplus by definition — the fund
    ///         does not need it — and the owner decided it belongs to the community:
    ///         "100% of surplus go to CW and we can DAO vote to change it after."
    ///         DAO-votable via PARAM_SF_COMMUNITY_OVERFLOW (60). This default also
    ///         SUPERSEDES the 2026-08-07 "SF intake lever" decision (dial the 3% carve
    ///         itself): reducing intake and forwarding at-target inflow reach the same
    ///         steady state, and this one was already built and needs no fanout across
    ///         the live matrices. Recorded so the older decision reads as CLOSED BY
    ///         CHOICE, not lost.
    ///
    ///         L3 IS DELIBERATELY UNTOUCHED — that overflow funds BuybackReserve, which
    ///         supports the CNOVA floor (scope items 4/5/6). Do not extend this to it.
    uint256 public communityOverflowBps = 10_000;

    /// @notice Lifetime USDC routed to the CommunityWallet from this contract, by BOTH
    ///         the unconditional carve and the surplus redirect. The carve had no
    ///         accounting at all before V8.48 — money left and nothing recorded it.
    uint256 public totalRoutedToCommunity;

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
    ///         (flat 10x across all tiers by default — V8.48; the "x10/x20/x30
    ///         ladder" this comment once described was V8.21 and never shipped
    ///         past V8.26's flat 20x). This is
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
    /// @notice V8.48 item 26. `sfBalanceAtCheck` and `target` are the values the surplus
    ///         test actually used, so the decision is auditable after the fact rather than
    ///         inferred from a balance that has since moved.
    event CommunityOverflowRouted(uint8 indexed tierIdx, uint256 amount, uint256 sfBalanceAtCheck, uint256 target);
    event CommunityOverflowBpsSet(uint256 bps);
    // V8.21
    event SfTargetMultiplierSet(uint8 indexed tierIndex, uint256 multiplier);
    event SfTargetAutoModeSet(bool enabled);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _admin) Ownable(_admin) {
        require(_usdc != address(0), "SF: zero usdc");
        usdc             = IERC20(_usdc);
        _manualSfTarget  = 300_000_000; // $300 default fallback (used pre-tierRouter-wiring)

        // V8.48 (owner decision 2026-08-13): flat 10x multiplier across all tiers
        // by default — halved from V8.26's flat 20x. Declared default, not a
        // post-deploy transaction (deploy_v8.js never sets these — item-42
        // doctrine), and 10 is on the PARAM_SF_MULT_T1..T10 governance menu, so
        // the DAO can move any tier independently, including back to 20.
        // Consequence: sfTarget() halves at every tier, so healthBps() reaches
        // 100% sooner, the L3 withdrawal-fee slider tips toward BuybackReserve
        // earlier, and item 26's surplus redirect arms at half the old balance.
        for (uint8 i = 0; i < MAX_TIERS; i++) {
            sfTargetMultiplier[i] = 10;
        }
    }

    // ── Admin setup ──────────────────────────────────────────────────────────

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "SF: not authorized");
        _;
    }

    /// @notice V8.35: owner or MatrixPairFactory can authorize new matrices.
    modifier onlyOwnerOrFactory() {
        require(msg.sender == owner() || msg.sender == pairFactory, "SF: not owner/factory");
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        require(_gov != address(0), "SF: zero governance");
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    /// @notice V8.32 param #50: DAO or owner can adjust the rescue loan repayment fraction.
    function setRescueRepayBps(uint256 newVal) external onlyOwnerOrGovernance {
        require(newVal <= 10_000, "SF: bps overflow");
        rescueRepayBps = newVal;
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

    /// @notice V8.35: Wire the MatrixPairFactory so it can authorize new matrices.
    function setFactory(address _factory) external onlyOwner {
        pairFactory = _factory;
    }

    function setMatrixAuthorized(address matrix, bool authorized) external onlyOwnerOrFactory {
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

    /// @notice V8.48 item 26: share of each L1 deposit redirected to the CommunityWallet
    ///         WHILE the fund is at or above target. Enumerated, and since the owner's
    ///         2026-08-13 decision the menu runs to 100% — at-target inflow is surplus,
    ///         and 10_000 ("all of it, to the community") is the declared default.
    ///         Menu mirrored in V8Governance PARAM_SF_COMMUNITY_OVERFLOW (60).
    function setCommunityOverflowBps(uint256 bps) external onlyOwnerOrGovernance {
        require(
            bps == 0 || bps == 100 || bps == 250 || bps == 500 ||
            bps == 1_000 || bps == 2_500 || bps == 5_000 ||
            bps == 7_500 || bps == 10_000,
            "SF: invalid overflow bps"
        );
        communityOverflowBps = bps;
        emit CommunityOverflowBpsSet(bps);
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
                    try ICommunityWallet(communityWallet).deposit(carve) {
                        totalRoutedToCommunity += carve;   // V8.48: this was untracked
                    }
                    catch {
                        // CommunityWallet rejected deposit — keep in SF instead
                        amount += carve;
                        usdc.forceApprove(communityWallet, 0);
                    }
                }
            }

            // V8.48 item 26 — SURPLUS REDIRECT.
            //
            // totalBalance is read HERE, before this deposit is credited below, so the
            // incoming amount cannot tip its own test. Without that ordering a deposit
            // arriving at exactly the target would qualify itself, and the fund would
            // start leaking to the community one deposit early.
            if (layer == 1 && communityWallet != address(0) && communityOverflowBps > 0
                && totalBalance >= sfTarget()) {
                uint256 target = sfTarget();
                uint256 over   = (amount * communityOverflowBps) / 10_000;
                if (over > 0) {
                    amount -= over;
                    usdc.forceApprove(communityWallet, over);
                    try ICommunityWallet(communityWallet).deposit(over) {
                        totalRoutedToCommunity += over;
                        emit CommunityOverflowRouted(tierIdx, over, totalBalance, target);
                    } catch {
                        // Same failure policy as the carve: never lose the money, keep it
                        // in the SF and clear the approval.
                        amount += over;
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

    /// @dev V8.48 item 46: takes the MEMBER so the insolvency floor is enforced at
    ///      the lender, whoever drives the rescue. See loanEligible() below.
    function payForceCross(
        address member,
        uint8   tierIdx,
        address sourceMatrix,
        uint256 fee
    ) external {
        require(msg.sender == matrixKeeper,  "SF: not keeper");
        require(tierIdx < MAX_TIERS,         "SF: invalid tier");
        require(sourceMatrix != address(0),  "SF: zero matrix");
        require(fee > 0,                     "SF: zero fee");
        // V8.49 item 1b policy B: the floor is tested WITH the advance included. `fee`
        // here is the keeper's totalSfNeeded (sfShare + crossingBuffer, MatrixKeeper.sol
        // :720/:737) — the whole amount about to leave the fund, which is exactly what
        // MatrixKeeperLib._triageParked asks about. Same question, same number, both sides.
        require(loanEligibleFor(member, tierIdx, fee), "SF: insolvency floor");
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
     * @notice Authorized matrix pulls sfShare from SF to fund a coPayRescue.
     *         SF covers the full shortfall (entryFee - withdrawable). No deployer
     *         USDC required. The shortfall is recorded as a soft loan to the member,
     *         repaid from future cycle-out earnings.
     *         Only callable by an authorizedMatrix.
     */
    function payCoRescue(address member, uint8 tierIdx, uint256 sfShare) external {
        require(authorizedMatrices[msg.sender], "SF: not authorized matrix");
        require(tierIdx < MAX_TIERS,            "SF: invalid tier");
        require(sfShare > 0,                    "SF: zero share");
        // V8.48 item 46: the insolvency floor. The old member-less signature could
        // not refuse anyone — a lender must know who it is lending to.
        // V8.49 item 1b policy B: ...and how much it is lending. sfShare IS the whole
        // advance on this path (coPayRescue books shortfall only, no crossing buffer —
        // MatrixLogicLib.sol:1423), so the amount needs no assembling here.
        require(loanEligibleFor(member, tierIdx, sfShare),  "SF: insolvency floor");
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

    // ═══════════════════════════════════════════════════════════════════════════
    // V8.47 — member-level rescue-debt ledger ("debt follows the account")
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // In V8.46 a rescue loan was tracked per-matrix (mapping in each MatrixState),
    // so a loan issued in a matrix the member later moved on from could never be
    // collected and the SF silently carried it. V8.47 promotes the debt to a
    // single member-level balance recorded HERE (the SF is the creditor+custodian),
    // so any matrix at any tier can repay it, and an upgrade can fold it into cost.
    //
    // Conservation identity (SF-conservation invariant, test #1):
    //   Σ_members memberDebt[m]  ==  totalRescueLoaned − totalRescueRepaid
    // No wei of debt is ever created or destroyed by the ledger — only moved
    // between "outstanding" and "repaid".

    /// @notice Total outstanding rescue debt owed by a member across ALL tiers/matrices.
    mapping(address => uint256) public memberDebt;
    /// @notice Highest tier that issued outstanding debt for a member — drives the clawback band.
    mapping(address => uint8)   public debtIssuingTier;

    /// @notice Cumulative debt ever booked / ever repaid. The invariant ties these to memberDebt.
    uint256 public totalRescueLoaned;
    uint256 public totalRescueRepaid;

    /// @notice Owner/DAO-tunable banded clawback rate, keyed to the issuing tier band.
    ///         Default 90/80/70/60 (direction A: deeper tiers claw back hardest).
    ///         Band 0 = T8–T10, 1 = T6–T7, 2 = T4–T5, 3 = T1–T3.
    uint256[4] public clawbackBpsByBand = [uint256(9000), 8000, 7000, 6000];

    event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal);
    event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal);
    event ClawbackBandsSet(uint256 b0, uint256 b1, uint256 b2, uint256 b3);

    // ── V8.48 item 46: the INSOLVENCY FLOOR ───────────────────────────────────
    //
    // Owner policy, his words (2026-08-13): "evict them when their fees are maybe
    // more than the fees they are collecting… It is not a free ride for ever — the
    // idea is to help them, but if they are not getting any referrals they would be
    // evicted bcuz the loan no longer covers their coverage %."
    //
    // Mechanics: a copay loan repays FIRST out of the member's next earnings, so
    // once outstanding debt >= expected per-cycle earnings, every further loan is
    // arithmetically unrepayable — the book can only grow (measured 2026-08-13:
    // 64 wallets, $1,917, 26% of the outstanding book, per-member debt growing
    // linearly every cycle). The floor stops lending at exactly that line; the
    // eviction valve (item 47, MatrixLogicLib.evictParked) is where floored
    // members leave the queue — withdrawable intact, reserve released, debt still
    // booked and repaid off the top of their next withdrawal.
    //
    // The estimate: expected per-cycle earnings ≈ tier fee x insolvencyFloorBps.
    // Default 3400 bps = the measured ~34% median (model_reserve_bps.js /
    // diag_parked_growth.js, 2026-08-13). DAO-governable (PARAM 59); 0 disables
    // the floor entirely — the escape hatch, on the menu like every default.
    // Members can ALWAYS selfRescue past the floor — it gates only SF LENDING.

    /// @notice Expected per-cycle earnings as BPS of the loan tier's entry fee.
    ///         The floor refuses a new loan when memberDebt >= fee x this / 10000.
    ///         0 = floor disabled (every member stays loan-eligible).
    /// V8.50: STAYS AT 3_400 — AND THE ROUND TRIP IS RECORDED BECAUSE IT WAS INSTRUCTIVE.
    ///
    /// This was changed to 5_000 on 2026-08-17 and changed back the same day. The 5_000
    /// case was measured, not guessed: scripts/model_item_a.js showed the post-item-A
    /// re-entry ask at a median $1.90 / max $4.28, and 5_000 cleared every member where
    /// 3_400 refused 15 of 72. The reasoning was sound. **The BASIS was wrong.**
    ///
    /// Phase 6 of that script, added afterwards, computes the same ask on the ledger the
    /// contract actually reads. TierRouter.handleCycleOut is passed only the CYCLING
    /// matrix's buckets, and MatrixKeeperLib._triageParked reads only the PARKED matrix.
    /// Item A left the member's journey-A earnings in the MatA ledger, so the gate saw
    /// roughly half of what the model was summing:
    ///
    ///     ask, AGGREGATE (both halves)   median $1.90   -> 3_400 clears 69 of 69
    ///     ask, MatB LEDGER (the gate)    median $6.60   -> 3_400 clears  0 of 69
    ///
    /// On that basis 5_000 rescued ZERO members. The fix was not a bigger ceiling, it was
    /// item E1 — MatrixLogicLib._crossToPartner now carries the member's remaining
    /// withdrawable across the crossing, so the MatB ledger holds journey A + journey B
    /// and the gate sees the whole sum. With E1 in, the two bases coincide and the
    /// declared default clears the population with room.
    ///
    /// THE LESSON, worth more than the number: a floor calibrated against a total the
    /// enforcing code cannot see is not calibrated at all. Any future change to this
    /// value must state WHICH BALANCE it was measured against.
    uint256 public insolvencyFloorBps = 3_400;

    event InsolvencyFloorBpsSet(uint256 bps);

    function setInsolvencyFloorBps(uint256 bps) external onlyOwnerOrGovernance {
        require(bps <= 10_000, "SF: floor bps > 100%");
        insolvencyFloorBps = bps;
        emit InsolvencyFloorBpsSet(bps);
    }

    // ── V8.49 item 1b, POLICY B: THE FLOOR INCLUDES THE LOAN BEING ASKED FOR ──
    //
    // V8.48 tested `memberDebt < ceiling` BEFORE the advance and never added the
    // advance itself, so the floor capped the debt a member could START a loan from,
    // not the debt they ended with. Every borrower finished above the ceiling by up to
    // a full advance. The doc comment on insolvencyFloorBps claimed the intent; the
    // code did not implement it.
    //
    // V8.49 tests `memberDebt + advance <= ceiling`. This is STRICTLY TIGHTER than the
    // old rule at every point — if the new test passes then `memberDebt < ceiling` also
    // held, because every advance is > 0 (both call sites require it). So this can
    // never lend where V8.48 refused. That property is pinned by a test, because it is
    // the whole safety argument for shipping it.
    //
    // ⚠ THE THREE VIEWS BELOW SHARE ONE PRIMITIVE ON PURPOSE. loanHeadroom is the only
    // place the arithmetic lives; loanEligible and loanEligibleFor both derive from it.
    // Three copies of one formula is how this codebase produced a dashboard that
    // itemised $7,500 while the chain held $10,000 — two models of one rule, drifting.
    //
    // MEASURED BEFORE SHIPPING (2026-08-16, diag_loan_history.js against 104 parked):
    // 15 members are refused by this rule, and ALL 15 are repeat borrowers — 0 are
    // refused on a first loan. Each had borrowed once, repaid $3.40-$4.04 of it, and
    // came back needing MORE than they earn per cycle ($2.32-$3.82 earned against a
    // $3.77-$5.00 ask), which is verbatim the condition this floor exists to stop.
    // Note their first loans looked oversized only because $3.60 of each was the
    // crossing buffer — with crossingBufferBps at 0 they would all have passed loan one.

    /// @notice How much MORE this member may borrow at this tier before the insolvency
    ///         floor refuses them. 0 = refused now. type(uint256).max = no ceiling
    ///         applies (floor disabled, or the tier has no registered fee).
    ///         THE FRONTEND SHOULD SHOW THIS, not just a yes/no — a member told only
    ///         "no loan" cannot act on it, and the parity rule says the dashboard must
    ///         say WHY no loan came.
    function loanHeadroom(address member, uint8 tierIdx) public view returns (uint256) {
        if (insolvencyFloorBps == 0) return type(uint256).max;   // floor disabled — the escape hatch
        if (tierIdx >= MAX_TIERS) return 0;
        uint256 fee = tierEntryFees[tierIdx];
        if (fee == 0) return type(uint256).max;                  // no fee registered — no estimate to form
        uint256 ceiling = fee * insolvencyFloorBps / 10_000;
        uint256 owed    = memberDebt[member];
        return ceiling > owed ? ceiling - owed : 0;
    }

    /// @notice V8.49: may this member take an advance of exactly `advance` at this tier?
    ///         THIS IS THE ENFORCEMENT RULE — payCoRescue and payForceCross both call it
    ///         with the amount they are about to lend, and keeper discovery
    ///         (MatrixKeeperLib._triageParked) calls it with the SAME amount so the two
    ///         cannot disagree. A disagreement is not a cosmetic bug: "SF: insolvency
    ///         floor" reverting inside performUpkeep would take the whole batch with it.
    function loanEligibleFor(address member, uint8 tierIdx, uint256 advance) public view returns (bool) {
        if (insolvencyFloorBps == 0) return true;
        if (tierIdx >= MAX_TIERS) return false;
        if (tierEntryFees[tierIdx] == 0) return true;
        return advance <= loanHeadroom(member, tierIdx);
    }

    /// @notice V8.48 item 46: does this member have ANY room left under the floor?
    ///         Equivalent to loanHeadroom(...) > 0, and kept because the frontend and
    ///         the diagnostics read it. NOTE: this is NOT the rule the lender enforces
    ///         any more — see loanEligibleFor. A true here means "not yet at the
    ///         ceiling"; it does NOT promise the next loan will be granted, because
    ///         that depends on the loan's SIZE.
    ///         A tier with no registered fee cannot form an estimate — eligible.
    function loanEligible(address member, uint8 tierIdx) public view returns (bool) {
        return loanHeadroom(member, tierIdx) > 0;
    }

    /// @notice Total outstanding rescue debt for a member (explicit accessor used by
    ///         matrices; mirrors the auto-getter on the public `memberDebt` mapping).
    function memberDebtOf(address member) external view returns (uint256) {
        return memberDebt[member];
    }

    /// @notice Book a rescue loan against a member's ledger. Called by an authorized
    ///         matrix at loan-issue time (coPayRescue / forceCrossKeeper), and by the
    ///         migration sweep for pre-V8.47 stranded per-matrix debt. Records the
    ///         issuing tier (keeps the highest, which drives the clawback band).
    ///         Booking does NOT move USDC — the SF already paid the rescue out via
    ///         payCoRescue/payForceCross; this only records who owes it.
    function increaseMemberDebt(address member, uint8 tier, uint256 amount) external {
        // Authorized matrices book at loan-issue time; owner books during the one-time
        // V8.47 migration sweep of pre-existing stranded per-matrix debt.
        require(authorizedMatrices[msg.sender] || msg.sender == owner(), "SF: not authorized");
        require(member != address(0),           "SF: zero member");
        require(tier < MAX_TIERS,               "SF: invalid tier");
        require(amount > 0,                      "SF: zero amount");

        memberDebt[member]  += amount;
        totalRescueLoaned   += amount;
        if (tier > debtIssuingTier[member]) debtIssuingTier[member] = tier;

        emit MemberDebtIncreased(member, tier, amount, memberDebt[member]);
    }

    /// @notice V8.47 member-keyed repayment. An authorized matrix approves `amount`
    ///         USDC and calls this; the SF pulls the USDC (credited to totalBalance)
    ///         and clears up to `amount` of the member's outstanding debt. Any excess
    ///         over the member's outstanding debt still enters the SF as balance but
    ///         does not drive the ledger negative (applied is capped at owed).
    ///         Overload of the legacy receiveDebtRepayment(uint256) — existing callers
    ///         that have not yet migrated keep working against the old signature.
    function receiveDebtRepayment(address member, uint256 amount) external {
        require(
            authorizedMatrices[msg.sender] || msg.sender == tierRouter,
            "SF: not authorized"
        );
        require(amount > 0,                     "SF: zero amount");

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalBalance += amount;

        uint256 owed    = memberDebt[member];
        uint256 applied = amount > owed ? owed : amount;
        if (applied > 0) {
            memberDebt[member] -= applied;
            totalRescueRepaid  += applied;
            if (memberDebt[member] == 0) debtIssuingTier[member] = 0;
            emit MemberDebtRepaid(member, applied, memberDebt[member]);
        }

        emit DebtRepaymentReceived(msg.sender, amount);
    }

    /// @notice The clawback rate (BPS of each earning redirected to repay) for a
    ///         member, banded by the highest tier that issued their outstanding debt.
    function clawbackBpsFor(address member) public view returns (uint256) {
        return clawbackBpsByBand[_bandOf(debtIssuingTier[member])];
    }

    /// @dev Map a 0-indexed issuing tier (0=T1 … 9=T10) to a clawback band.
    ///      Direction A: deeper tiers issue larger advances → claw back hardest.
    function _bandOf(uint8 tier) internal pure returns (uint256) {
        if (tier >= 7) return 0; // T8–T10 → band 0 (90%)
        if (tier >= 5) return 1; // T6–T7  → band 1 (80%)
        if (tier >= 3) return 2; // T4–T5  → band 2 (70%)
        return 3;                // T1–T3  → band 3 (60%)
    }

    /// @notice Owner/DAO-tunable clawback bands. Each ≤ 10000 BPS.
    function setClawbackBands(uint256[4] calldata bps) external onlyOwnerOrGovernance {
        for (uint256 i = 0; i < 4; i++) require(bps[i] <= 10_000, "SF: bad bps");
        clawbackBpsByBand = bps;
        emit ClawbackBandsSet(bps[0], bps[1], bps[2], bps[3]);
    }
}
