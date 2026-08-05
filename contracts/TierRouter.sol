// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  TierRouter
 * @notice V8.1 "Elevator" — central hub that routes members across 7 tiers.
 *
 * V8.14 ADDITIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. onCrossToMatB(address member, uint8 tierIndex)
 *       Called by MatB's _enterMatrix hook whenever a member enters MatB via
 *       any path (normal cross, forceCross, keeper rescue).
 *       - Emits UpgradeEligibleAtCross so the frontend can light up the button.
 *       - If autoUpgrade is enabled AND member holds sufficient USDC AND has
 *         approved TierRouter, executes the upgrade immediately (AutoUpgradedAtCross).
 *
 *  2. manualUpgrade() eligibility relaxed
 *       Old: requires tierCycles >= 1 AND !isActiveInMatrix(prevMatB).
 *       New: requires tierCycles >= 1 OR isActiveInMatrix(prevMatB).
 *       Members can upgrade the moment they cross into MatB.
 *
 * V8.11 ADDITIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. communityWallet hook in register()
 *       ICommunityWallet(communityWallet).enroll(msg.sender) called on every
 *       new registration. No-op if communityWallet == address(0).
 *
 *  2. globalJoinedCount counter
 *       Increments on every register() call. Readable on-chain for CommunityWallet
 *       eligibility (first 1,000 members get Community Fund access).
 *
 * V8.1 ADDITIONS (unchanged)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Three member toggles (setMemberOptions)
 *  2. Cycle thresholds (DAO-votable, enumerated)
 *  3. Escrow floor guard
 *  4. Velocity gate (keeper-maintained)
 *  5. MemberParked event
 *
 * V8 ORIGINAL BEHAVIOR (unchanged unless noted above)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - register() → T1 PairManager entry
 *  - handleCycleOut() → upgrade or re-entry routing
 *  - deductForUpgrade() callback to matrix
 *  - Whale Gate (T4→T6 skip after 25 T5 first entries) -- V8.7: 10 tiers (T8-T10 added)
 *  - Inactivity Pause (dual-guard days + cycles)
 *  - manualUpgrade() voluntary paid upgrade
 *  - doubleEntry toggle (now aliased to doubleReentry in MemberOptions)
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./TierRouterLib.sol"; // V8.47: extracted upgrade-path leaf helpers + debt fold (linked)

// ─── Interfaces ────────────────────────────────────────────────────────────────

interface ICommunityWallet {
    /// @notice Enroll a new member into the Community Fund eligibility pool.
    ///         Must be called at registration time. No-op if called twice for same member.
    function enroll(address member) external;
}

interface IFigureEightMatrixV8 {
    function deductForUpgrade(
        address member,
        uint256 escrowAmt,
        uint256 withdrawableAmt
    ) external;
    /// @notice V8.44: park an underfunded re-entry candidate at MatB cycle-out.
    function parkCycledOut(address member, uint256 shortfall) external;
    /// @notice V8.44: release un-consumed crossing reserve on clean graduation.
    function releaseReserve(address member) external;
    /// @notice V8.44 (G2): full withdrawal of member's balance, paid to member.
    function routerWithdrawFor(address member) external;
    /// @notice V8.44 (G3): balance available beyond crossing/automation locks.
    function freeWithdrawable(address member) external view returns (uint256);
    function escrowOf(address member)         external view returns (uint256);
    function withdrawableOf(address member)   external view returns (uint256);
    function ENTRY_FEE()                      external view returns (uint256);
    function isActiveInMatrix(address member) external view returns (bool);
    /// @notice V8.1 governance gateway — forwards DAO-voted fee changes.
    function setWithdrawalFeeBps(uint256 bps) external;
    function setEarlyExitPenaltyBps(uint256 bps) external;
    /// @notice V8.41 FIFO: which pair slot this MatB occupies (0=T1.1, 1=T1.2…).
    function pairIndex()                      external view returns (uint256);
    /// @notice V8.42: current number of seats filled in this matrix (0-127).
    function occupancy()                      external view returns (uint256);
    /// @notice V8.43: partner matrix (MatB's partner = its pair's MatA).
    function partner()                        external view returns (address);
}

/// @notice V8.47: minimal StabilityFund hooks for the upgrade-gate debt fold.
interface ISFDebt {
    function memberDebtOf(address member) external view returns (uint256);
    function receiveDebtRepayment(address member, uint256 amount) external;
}

interface IPairManagerV8 {
    function registerDirectFor(address member, address referrer) external;
    /// @notice V8.41 FIFO: targetPairIndex tells PM which pair to route into.
    ///         Upgrades pass 0 (first pair of dest tier). Re-entries pass srcPairIndex+1.
    function registerFor(address member, address referrer, uint256 targetPairIndex) external;
    /// @notice V8.44 overflow rework: seat a re-entry directly in a pair's MatB
    ///         (used when the own pair is saturated — the entry rotates a full
    ///         MatB and keeps it churning instead of overflowing forward).
    function registerForMatB(address member, address referrer, uint256 targetPairIndex) external;
    function entryFee() external view returns (uint256);
    function currentMatA() external view returns (address);   // V8.31: for coupon routing
    // V8.38: multi-pair MatB scan for manualUpgrade() eligibility
    function pairCount() external view returns (uint256);
    function getPairAt(uint256 idx) external view returns (address matA, address matB);
    /// @notice V8.46: a pair in this tier the member occupies NEITHER half of,
    ///         or type(uint256).max if there is none. Used to place a DOUBLE
    ///         seat somewhere other than the member's own pair — the same-pair
    ///         double was a duplicate by construction. The search lives in
    ///         PairManagerV8 because this contract has 143 bytes of headroom.
    function freePairFor(address member, uint256 avoid) external view returns (uint256);
    /// @notice V8.46: does the member hold a seat anywhere in this tier — any
    ///         pair, either half? Replaces the tierMatrixAAddr checks, which
    ///         only ever saw pair 1.
    function holdsSeatIn(address member) external view returns (bool);
    /// V8.43: public pairs[] getter — totalRegistered is the routing saturation measure
    function pairs(uint256 idx) external view returns (
        address matrixA, address matrixB, uint256 deployedAt, uint256 totalRegistered
    );
}

interface IFigureEightMatrixV8Coupon {
    function enterWithCouponFrom(address member, address referrer, bytes32 couponCodeHash) external;  // V8.31
    function couponRegistry() external view returns (address);                                        // V8.31
}

interface ICouponRegistry {
    function coupons(bytes32 codeHash) external view returns (address issuer, uint256 amount, uint256 expiry, bool used);
}

/// @notice V8.44 (G1): EIP-2612 permit — USDC approval as a signature, not an
///         on-chain tx. Fits the project's "fresh signature per spend, no
///         standing allowance / no delegation" security stance.
interface IERC20PermitLike {
    function permit(
        address owner, address spender, uint256 value,
        uint256 deadline, uint8 v, bytes32 r, bytes32 s
    ) external;
}

// ─── Contract ──────────────────────────────────────────────────────────────────

contract TierRouter is Ownable2Step {
    using SafeERC20 for IERC20;

    // V8.44 size-diet errors (EIP-170: contract exceeded 24,576 with viaIR).
    // Revert strings that tests/frontends assert are KEPT verbatim; all other
    // guards use these compact errors.
    error TRZero();      // zero address / zero value argument
    error TRBadValue();  // value outside the allowed menu/range
    error TRAuth();      // caller not authorized
    error TRState();     // wrong state / not registered / not deployed
    /// @notice V8.46-B: this tier is not open to you yet — either you have not
    ///         crossed into the previous tier's MatB and completed no cycle, or
    ///         the Whale Gate for the target tier has not opened.
    ///
    ///         Replaces two long revert STRINGS. Bytes were the trigger (the
    ///         depth counter put TierRouter 146 over EIP-170) but readability is
    ///         the better reason: a string revert with no ABI match gives ethers
    ///         nothing, which is why rr_keeper's job D logged a bare "— Error"
    ///         on every ineligible span and nobody could tell why.
    ///         FRONTEND: friendlyError() must map TRGate to
    ///         "this tier isn't open to you yet" — it is a normal, expected
    ///         state, not a failure.
    error TRGate();

    IERC20 public immutable usdc;

    // ─── Tier configuration ───────────────────────────────────────────────────
    uint8 public constant MAX_TIERS = 10;

    /// @notice V8.46-B: how many cycle-out links may chain in ONE transaction.
    ///         Owner-settable because the right value is an operational
    ///         question, not a constant: too low and members are parked who
    ///         could have been seated; too high and a deep chain becomes
    ///         unsendable, which is the bug this fixes. 4 is deliberately above
    ///         the 2 a fresh population reaches and below the 6 that produced
    ///         17.76M live. Measure CascadeDepthCapped before moving it.
    ///         uint256, NOT uint8 — measured 2026-07-28: narrowing it ADDED 54
    ///         bytes (24,595 -> 24,649). A packed small type needs masking and
    ///         shifting on every read and write, which costs more code than the
    ///         narrower getter saves. Same trap as the tier-gate wrapper dedupe.
    ///         MEASURE size changes here; intuition is wrong more often than not.
    uint256 public maxCascadeDepth = 4;

    /// @dev Transient slot (EIP-1153) holding the current chain depth.
    ///
    ///      Slot 0 is safe and deliberate: TRANSIENT STORAGE IS A SEPARATE
    ///      ADDRESS SPACE from contract storage, so this cannot collide with any
    ///      state variable, and nothing else in this contract uses tstore.
    ///      (A keccak-derived slot would have been tidier but inline assembly
    ///      only accepts direct number constants.)
    ///
    ///      On the compiler's composability warning: the counter is restored
    ///      after every _executeAdditive, so the OUTERMOST frame always leaves
    ///      it at 0. A revert inside the cascade also rolls transient storage
    ///      back, so the swallowing try/catch in MatrixLogicLib cannot strand a
    ///      raised value either.
    uint256 private constant _CASCADE_DEPTH_SLOT = 0;

    address[MAX_TIERS] public tierPairManagers;
    uint256[MAX_TIERS] public tierEntryFees;

    address[MAX_TIERS] public tierMatrixAAddr;
    address[MAX_TIERS] public tierMatrixBAddr;

    // ─── Member registry ──────────────────────────────────────────────────────
    mapping(address => address) public memberReferrer;
    mapping(address => uint8)   public memberHighestTier;
    mapping(address => bool)    public globalJoined;
    /// @notice V8.32 Task #59: admin grants a free re-entry to a wrongfully reclaimed member.
    mapping(address => bool)    public freeReentryAllowed;

    /// @dev V8.1: Structured member options (replaces loose doubleEntryEnabled mapping).
    ///      Legacy doubleEntryEnabled still readable for compatibility with V8 test scripts.
    struct MemberOptions {
        bool autoUpgradeDisabled;   // default false (= autoUpgrade ON)
        bool autoReentryEnabled;    // default false (member parks after cycle-out)
        bool doubleReentryEnabled;  // default false
        bool optionsSet;            // true once member has called setMemberOptions()
    }
    mapping(address => MemberOptions) public memberOptions;

    /// @dev Legacy alias — kept so V8 test scripts continue compiling.
    mapping(address => bool) public doubleEntryEnabled;

    mapping(address => mapping(uint8 => uint256)) public tierCycles;

    // ─── Authorized matrices ──────────────────────────────────────────────────
    mapping(address => bool)  public authorizedMatrices;
    mapping(address => uint8) public matrixTierIndex;

    // ─── Keeper ───────────────────────────────────────────────────────────────
    /// @notice MatrixKeeper (Chainlink Automation) — may set tierVelocityGreen.
    address public matrixKeeper;

    // ─── V8.20: Governance co-control ──────────────────────────────────────────
    /// @notice DAO governance contract. Co-governs params below alongside owner --
    ///         neither replaces the other (owner keeps emergency backstop).
    address public governance;

    // ─── V8.35: Autonomous pair factory ──────────────────────────────────────
    /// @notice MatrixPairFactory. When wired, factory can call registerMatrix()
    ///         to authorize newly deployed matrices inline, in the same tx as
    ///         the triggering member registration.
    address public pairFactory;

    /// @notice V8.47: StabilityFund address — used by the upgrade gate to read a
    ///         member's outstanding rescue debt and fold it into the upgrade cost.
    address public stabilityFund;

    // ─── V8.1: Velocity gate (keeper-maintained per tier) ─────────────────────
    mapping(uint8 => bool) public tierVelocityGreen;

    // ─── V8.1: DAO-votable parameters (enumerated menus only) ────────────────
    uint256 public autoUpgradeCycleThreshold = 5;
    uint256 public reentryMinCycles = 2;
    // V8.21: escrowFloorMultiplier and its setter were removed entirely.
    // It gated auto-upgrade via Guard f in _resolveDest() against a `escrow`
    // value that's hardcoded to 0 at every call site (escrow tracking was
    // removed system-wide in V8.8), so the guard could never pass past a
    // member's 5th cycle at a tier -- silently and permanently blocking
    // auto-upgrade with no funds actually at risk. Guard f itself was removed
    // in V8.21 (see _resolveDest() below). PARAM_ESCROW_FLOOR_MULT (id 3) in
    // V8Governance.sol is retired and permanently blocked at propose() time --
    // do not reuse that id for a new param.

    // ─── Community Fund ───────────────────────────────────────────────────────
    /// @notice CommunityWallet contract — enrolled at registration.
    ///         Zero address = hook disabled (safe before CommunityWallet is deployed).
    address public communityWallet;

    /// @notice Total unique members ever registered system-wide.
    ///         Increments on every register() call. Used by CommunityWallet eligibility.
    uint256 public globalJoinedCount;

    // ─── Default Referrer (W1) ────────────────────────────────────────────────
    /// @notice V8.23: Fallback referrer used when a new member provides no referrer
    ///         or provides one that hasn't joined yet. Set to W1 after seed so all
    ///         organic sign-ups credit W1 with the L1 chain-pay, strengthening its
    ///         withdrawable balance and reducing the need for SF rescue.
    ///         Zero = disabled (legacy behaviour: unmatched referrers → address(0)).
    address public defaultReferrer;

    // ─── V8.42: Hybrid pair routing ───────────────────────────────────────────
    /// @notice REMOVED in V8.46 (2026-07-27). This knob decided whether a
    ///         re-entering member looped back into their own pair or was routed
    ///         onward. It compared a CUMULATIVE lifetime counter against a value
    ///         documented as capacity, so every pair crossed it permanently and
    ///         its MatA lost every entry source — rotation stopped dead across
    ///         all 10 tiers (2026-07-26). The live workaround was to set it to
    ///         1,000,000, i.e. "never divert". _sameTierTarget now implements
    ///         that unconditionally, so nothing reads the value any more.
    ///
    ///         The variable and setPairExpansionThreshold() are DELETED rather
    ///         than kept for ABI stability: TierRouter was 369 bytes over the
    ///         EIP-170 limit after the V8.46 collision guard, and dead code was
    ///         the honest place to find the space. Retire set_threshold.js and
    ///         drop the read in pair_entries.js alongside this.

    // ─── Whale Gate ───────────────────────────────────────────────────────────
    // V8.21 REDESIGN: was a single global T5-only counter that, once tripped,
    // let funded members cycling out of T4 SKIP T5 entirely and land in T6 --
    // i.e. they bypassed every member still waiting in T5's queue. User
    // feedback: whales should never jump past a tier's existing members; they
    // should just be able to enter that SAME tier. The skip-ahead behavior
    // (former Guard c in _resolveDest) is removed entirely -- funded members
    // now flow tier-by-tier through the normal queue like everyone else, no
    // exceptions. What remains is purely a per-tier "first entries" tracker
    // (one counter + one active flag per tier, all measured against the same
    // shared DAO-governed threshold) for visibility/eligibility display --
    // it no longer changes routing.
    mapping(uint8 => uint256) public tierFirstEntries;   // keyed by tierNum (1-10)
    mapping(uint8 => bool)    public tierWhaleGateActive; // keyed by tierNum (1-10)
    uint256 public whaleGateThreshold = 25;
    // V8.35: per-tier pioneer thresholds. T2-T5 share T5's gate; T6-T10 each independent.
    // Defaults: T5=25, T6=15, T7=10, T8-T10=5. DAO-adjustable 1-50.
    mapping(uint8 => uint256) public tierGateThreshold;

    // ─── Inactivity Pause (dual-guard) ────────────────────────────────────────
    bool    public systemPaused;
    bool    public inactivityGuardEnabled    = true;
    uint256 public inactivityDaysThreshold   = 30;
    uint256 public inactivityCyclesThreshold = 2;

    uint256 public lastActivityTimestamp;
    uint256 public totalSystemCycles;
    uint256 public cyclesAtLastRegistration;

    // ─── Deflation state (set by MatrixKeeper) ────────────────────────────────
    uint8 public deflationState;

    // ─── Entry tracking for keeper velocity queries (capped circular log) ─────
    uint256 public constant MAX_ENTRY_LOG = 200;
    uint256[] private _sysEntryTimes;
    mapping(uint8 => uint256[]) private _tierEntryTimes;

    // ─── Events ───────────────────────────────────────────────────────────────
    event MemberRegistered(address indexed member, uint8 tier, address indexed referrer); // V8.34: referrer indexed for efficient log queries
    event MemberUpgraded(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee);
    event ManualUpgrade(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee);
    event BulkUpgrade(address indexed member, uint8 fromTier, uint8 toTier, uint256 totalFee); // V8.35
    event MemberReentered(address indexed member, uint8 tier);
    event DoubleEntryFired(address indexed member, uint8 primaryTier, uint8 secondaryTier);
    /// @notice V8.46-B: the cascade hit maxCascadeDepth and this member was
    ///         parked instead of continuing the chain in the same transaction.
    ///         NOT an error — it is the cap doing its job. Watch the rate: a
    ///         steady stream means maxCascadeDepth is set below what the system
    ///         naturally reaches, and members are being parked who need not be.
    ///         (No depth argument — it is always maxCascadeDepth when this
    ///         fires, so carrying it costs bytes to say nothing new.)
    event CascadeDepthCapped(address indexed member, uint8 tierIndex);
    event WhaleGateActivated(uint8 indexed tierNum, uint256 count);
    event CycleRecorded(address indexed member, uint8 tierIndex, uint256 newCount);
    event TierRegistered(uint8 indexed tierIndex, address pairManager, uint256 entryFee);
    event MatrixRegistered(address indexed matrix, uint8 tierIndex);
    event DoubleEntryToggled(address indexed member, bool enabled);
    event SystemPaused(string reason, uint256 daysSinceActivity, uint256 cyclesSinceRegistration);
    event SystemResumed(address indexed by);
    event InactivityConfigUpdated(uint256 daysThreshold, uint256 cyclesThreshold, bool enabled);
    // V8.1 events
    event MemberOptionsSet(address indexed member, bool upgradeDisabled, bool reentryEnabled, bool doubleEnabled);
    event DeflationStateChanged(uint8 prevState, uint8 newState);
    event MemberParked(address indexed member, uint8 tier, string reason);
    event VelocityGateSet(uint8 indexed tier, bool green);
    event AutoUpgradeThresholdSet(uint256 threshold);
    event ReentryMinCyclesSet(uint256 minCycles);
    // V8.21: EscrowFloorMultiplierSet removed along with the setter/storage var.
    event MatrixKeeperSet(address indexed keeper);
    // V8.11 events
    event CommunityWalletSet(address indexed cw);
    event MemberEnrolled(address indexed member, uint256 joinedCount);
    // V8.14: cross-upgrade events
    event UpgradeEligibleAtCross(address indexed member, uint8 fromTierNum, uint8 toTierNum);
    event AutoUpgradedAtCross(address indexed member, uint8 fromTierNum, uint8 toTierNum, uint256 fee);
    // V8.20
    event GovernanceSet(address indexed governance);
    event WhaleGateThresholdSet(uint256 threshold);
    event TierGateThresholdUpdated(uint8 indexed tierNum, uint256 threshold); // V8.35
    event InactivityDaysThresholdSet(uint256 days_);
    event InactivityCyclesThresholdSet(uint256 cycles);
    event InactivityGuardEnabledSet(bool enabled);
    // V8.23
    event DefaultReferrerSet(address indexed ref);
    // V8.42

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _admin) Ownable(_admin) {
        if (_usdc == address(0)) revert TRZero();
        usdc = IERC20(_usdc);
        lastActivityTimestamp = block.timestamp;

        // Default velocity gates: all tiers green at launch
        for (uint8 i = 0; i < MAX_TIERS; i++) {
            tierVelocityGreen[i] = true;
        }

        // V8.35: Whale Gate per-tier pioneer thresholds (DAO-adjustable 1-50)
        // T2-T5 unlock together when tierFirstEntries[5] >= tierGateThreshold[5]
        // T6-T10 each unlock independently via their own counter
        tierGateThreshold[5]  = 25;
        tierGateThreshold[6]  = 15;
        tierGateThreshold[7]  = 10;
        tierGateThreshold[8]  = 5;
        tierGateThreshold[9]  = 5;
        tierGateThreshold[10] = 5;
    }

    // ─── Modifier ─────────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (systemPaused) revert TRState();
        _;
    }

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        if (msg.sender != owner() && msg.sender != governance) revert TRAuth();
        _;
    }

    /// @notice V8.35: owner or MatrixPairFactory can register new matrices.
    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner() && msg.sender != pairFactory) revert TRAuth();
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        if (_gov == address(0)) revert TRZero();
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    // ─── Admin: setup ─────────────────────────────────────────────────────────

    function registerTier(
        uint8   tierIndex,
        address pairManager,
        uint256 entryFee
    ) external onlyOwner {
        if (tierIndex >= MAX_TIERS) revert TRBadValue();
        if (pairManager == address(0)) revert TRZero();
        if (entryFee == 0) revert TRZero();
        tierPairManagers[tierIndex] = pairManager;
        tierEntryFees[tierIndex]    = entryFee;
        emit TierRegistered(tierIndex, pairManager, entryFee);
    }

    function setTierMatrices(
        uint8   tierIndex,
        address matA,
        address matB
    ) external onlyOwner {
        if (tierIndex >= MAX_TIERS) revert TRBadValue();
        if (matA == address(0)) revert TRZero();
        if (matB == address(0)) revert TRZero();
        tierMatrixAAddr[tierIndex] = matA;
        tierMatrixBAddr[tierIndex] = matB;
    }

    /// @notice V8.35: Wire the MatrixPairFactory so it can register new matrices inline.
    function setFactory(address _factory) external onlyOwner {
        pairFactory = _factory;
    }

    /// @notice V8.47: wire the StabilityFund so the upgrade gate can read and fold a
    ///         member's outstanding rescue debt into the upgrade cost.
    function setStabilityFund(address _sf) external onlyOwner {
        if (_sf == address(0)) revert TRZero();
        stabilityFund = _sf;
    }

    /// @dev V8.47 wallet-funded upgrade gate (manual / hybrid) — thin wrapper over the
    ///      linked TierRouterLib (body extracted for EIP-170 headroom).
    function _walletFold(address member) internal {
        TierRouterLib.walletFold(stabilityFund, usdc, member);
    }


    function registerMatrix(address matrix, uint8 tierIndex) external onlyOwnerOrFactory {
        if (matrix == address(0)) revert TRZero();
        if (tierIndex >= MAX_TIERS) revert TRBadValue();
        authorizedMatrices[matrix] = true;
        matrixTierIndex[matrix]    = tierIndex;
        emit MatrixRegistered(matrix, tierIndex);
    }

    function deregisterMatrix(address matrix) external onlyOwner {
        authorizedMatrices[matrix] = false;
    }

    /// @notice V8.20: DAO-governable. Allowed: 10, 15, 20, 25, 30, 50.
    function setWhaleGateThreshold(uint256 threshold) external onlyOwnerOrGovernance {
        if (threshold != 10 && threshold != 15 && threshold != 20 &&
            threshold != 25 && threshold != 30 && threshold != 50) revert TRBadValue();
        whaleGateThreshold = threshold;
        emit WhaleGateThresholdSet(threshold);
    }

    /// @notice V8.35: DAO adjusts the pioneer threshold for a specific tier (T5-T10).
    /// T2-T5 share T5's gate; T6-T10 are independent. Range 1-50.
    function setTierGateThreshold(uint8 tierNum, uint256 threshold) external onlyOwnerOrGovernance {
        if (tierNum < 5 || tierNum > MAX_TIERS) revert TRBadValue();
        if (threshold < 1 || threshold > 50) revert TRBadValue();
        tierGateThreshold[tierNum] = threshold;
        emit TierGateThresholdUpdated(tierNum, threshold);
    }

    /// @notice V8.35: Admin override — force a tier's whale gate open (or closed).
    /// Use for emergency recovery if the organic threshold is misconfigured,
    /// or to manually open a gate for a tier that had its threshold changed.
    /// T2-T5 share T5's gate, so force-opening tier 5 unlocks T2-T5 together.
    // ── V8.35: DAO per-tier wrappers used by V8Governance execute() (params 52-57) ──
    // Governance can only pass a single uint256 value, so each tier gets its
    // own entry-point that hard-codes the tier number.  The shared internal
    // validation (1 ≤ v ≤ 50) mirrors setTierGateThreshold's require guard.
    // NOTE (2026-07-27): folding these six into a shared _setGate(tierNum, v)
    // was tried and made TierRouter BIGGER — 24,809 -> 25,024 bytes. Constant
    // indices (tierGateThreshold[5]) and literal event args compile smaller than
    // a variable-indexed helper, and the optimiser at runs=1 already shares what
    // it can. Do not "dedupe" these again.
    function setTierGateThresholdT5(uint256 v)  external onlyOwnerOrGovernance { if (v < 1 || v > 50) revert TRBadValue(); tierGateThreshold[5]  = uint8(v); emit TierGateThresholdUpdated(5,  v); }
    function setTierGateThresholdT6(uint256 v)  external onlyOwnerOrGovernance { if (v < 1 || v > 50) revert TRBadValue(); tierGateThreshold[6]  = uint8(v); emit TierGateThresholdUpdated(6,  v); }
    function setTierGateThresholdT7(uint256 v)  external onlyOwnerOrGovernance { if (v < 1 || v > 50) revert TRBadValue(); tierGateThreshold[7]  = uint8(v); emit TierGateThresholdUpdated(7,  v); }
    function setTierGateThresholdT8(uint256 v)  external onlyOwnerOrGovernance { if (v < 1 || v > 50) revert TRBadValue(); tierGateThreshold[8]  = uint8(v); emit TierGateThresholdUpdated(8,  v); }
    function setTierGateThresholdT9(uint256 v)  external onlyOwnerOrGovernance { if (v < 1 || v > 50) revert TRBadValue(); tierGateThreshold[9]  = uint8(v); emit TierGateThresholdUpdated(9,  v); }
    function setTierGateThresholdT10(uint256 v) external onlyOwnerOrGovernance { if (v < 1 || v > 50) revert TRBadValue(); tierGateThreshold[10] = uint8(v); emit TierGateThresholdUpdated(10, v); }

    function setTierWhaleGateActive(uint8 tierNum, bool active) external onlyOwnerOrGovernance {
        if (tierNum < 1 || tierNum > MAX_TIERS) revert TRBadValue();
        tierWhaleGateActive[tierNum] = active;
        if (active) {
            emit WhaleGateActivated(tierNum, tierFirstEntries[tierNum]);
        }
    }

    /// @notice V8.1: Set the MatrixKeeper address (Chainlink Automation).
    function setMatrixKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert TRZero();
        matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    /// @notice V8.11: Set the CommunityWallet address. Zero address disables the hook.
    function setCommunityWallet(address _cw) external onlyOwner {
        communityWallet = _cw;
        emit CommunityWalletSet(_cw);
    }

    /// @notice V8.23: Set the default referrer (W1). Called by deploy_v8.js after
    ///         W1 seeds. Zero address re-disables the fallback.
    function setDefaultReferrer(address _ref) external onlyOwner {
        defaultReferrer = _ref;
        emit DefaultReferrerSet(_ref);
    }

    // ─── V8.1: Velocity gate (keeper-only) ───────────────────────────────────

    function setTierVelocityGreen(uint8 tierIndex, bool green) external {
        if (msg.sender != matrixKeeper && msg.sender != owner()) revert TRAuth();
        if (tierIndex >= MAX_TIERS) revert TRBadValue();
        tierVelocityGreen[tierIndex] = green;
        emit VelocityGateSet(tierIndex, green);
    }

    // ─── V8.1: DAO governance setters (enumerated menus only) ────────────────

    function setAutoUpgradeCycleThreshold(uint256 threshold) external onlyOwnerOrGovernance {
        if (threshold != 1 && threshold != 3 && threshold != 5 && threshold != 10) revert TRBadValue();
        autoUpgradeCycleThreshold = threshold;
        emit AutoUpgradeThresholdSet(threshold);
    }

    function setReentryMinCycles(uint256 minCycles) external onlyOwnerOrGovernance {
        if (minCycles != 1 && minCycles != 2 && minCycles != 3 && minCycles != 5) revert TRBadValue();
        reentryMinCycles = minCycles;
        emit ReentryMinCyclesSet(minCycles);
    }

    // V8.21: setEscrowFloorMultiplier() removed entirely -- see PARAM_ESCROW_FLOOR_MULT
    // retirement note in V8Governance.sol and the storage-var removal note above.

    // ─── Inactivity guard ─────────────────────────────────────────────────────

    function setInactivityConfig(
        uint256 daysThreshold,
        uint256 cyclesThreshold,
        bool    enabled
    ) external onlyOwner {
        inactivityDaysThreshold   = daysThreshold;
        inactivityCyclesThreshold = cyclesThreshold;
        inactivityGuardEnabled    = enabled;
        emit InactivityConfigUpdated(daysThreshold, cyclesThreshold, enabled);
    }

    // V8.20: granular single-value governable equivalents of setInactivityConfig
    // above. That function stays owner-only (it's the all-in-one emergency
    // reset); these three let the DAO tune one knob at a time.

    /// @notice DAO-governable. Allowed: 7, 14, 30, 60, 90 (days). 0 disables the days guard.
    function setInactivityDaysThreshold(uint256 v) external onlyOwnerOrGovernance {
        if (v != 0 && v != 7 && v != 14 && v != 30 && v != 60 && v != 90) revert TRBadValue();
        inactivityDaysThreshold = v;
        emit InactivityDaysThresholdSet(v);
    }

    /// @notice DAO-governable. Allowed: 1, 2, 3, 5, 10 (cycles). 0 disables the cycles guard.
    function setInactivityCyclesThreshold(uint256 v) external onlyOwnerOrGovernance {
        if (v != 0 && v != 1 && v != 2 && v != 3 && v != 5 && v != 10) revert TRBadValue();
        inactivityCyclesThreshold = v;
        emit InactivityCyclesThresholdSet(v);
    }

    /// @notice DAO-governable. v must be 0 (disabled) or 1 (enabled) -- V8Governance
    ///         only deals in uint256, so bool is encoded this way.
    function setInactivityGuardEnabled(uint256 v) external onlyOwnerOrGovernance {
        if (v > 1) revert TRBadValue();
        inactivityGuardEnabled = (v == 1);
        emit InactivityGuardEnabledSet(v == 1);
    }

    /// @notice V8.46-B: tune the cascade depth cap without a redeploy.
    ///         Required, not optional: the right value is an operational
    ///         question and the harness cannot reach the default (a fresh
    ///         population stops at depth 2 through lack of funds), so without a
    ///         setter the cap is neither testable nor correctable.
    ///         onlyOwner rather than onlyOwnerOrGovernance: this is an emergency
    ///         throttle, and the compound modifier costs bytes TierRouter does
    ///         not have (30 spare before this setter existed).
    ///
    ///         ONLY the zero check survives. An upper bound was nice-to-have and
    ///         cost the last bytes available: setting this absurdly high merely
    ///         disables the cap and is recoverable in one transaction, whereas
    ///         setting it to ZERO would park every single cycle-out — so that is
    ///         the one that stays guarded.
    function setMaxCascadeDepth(uint256 v) external onlyOwner {
        if (v == 0) revert TRBadValue();
        maxCascadeDepth = v;
    }

    function checkInactivity() public {
        if (!inactivityGuardEnabled || systemPaused) return;

        uint256 daysSince      = (block.timestamp - lastActivityTimestamp) / 1 days;
        uint256 cyclesSinceReg = totalSystemCycles - cyclesAtLastRegistration;

        bool daysBreached   = inactivityDaysThreshold  > 0 && daysSince      >= inactivityDaysThreshold;
        bool cyclesBreached = inactivityCyclesThreshold > 0 && cyclesSinceReg >= inactivityCyclesThreshold;

        if (daysBreached || cyclesBreached) {
            systemPaused = true;
            // Short literals: the event already carries daysSince and
            // cyclesSinceReg, so the words only name which threshold tripped.
            // Trimmed to buy the last bytes for the V8.46-B depth cap — the
            // signature is unchanged and nothing consumes the text.
            string memory reason = daysBreached
                ? (cyclesBreached ? "both" : "days")
                : "cycles";
            emit SystemPaused(reason, daysSince, cyclesSinceReg);
        }
    }

    function resumeSystem() external onlyOwner {
        if (!systemPaused) revert TRState();
        _resume();
    }

    /// @notice V8.21: Owner-only manual kill switch. Immediately sets the
    /// SAME systemPaused flag the automatic inactivity guard uses (and that
    /// register()/manualUpgrade() already check via whenNotPaused) -- no new
    /// gate, no separate flag, no risk of the two pause mechanisms disagreeing
    /// about whether the system is open. Use for emergencies (e.g. a bug found
    /// in a downstream contract) where new entries/upgrades need to stop NOW,
    /// without waiting for the inactivity thresholds to trip on their own.
    /// Does NOT block withdrawals -- members can still withdraw funds already
    /// in the matrices while paused; this only stops NEW entries/upgrades.
    function pauseSystem(string calldata reason) external onlyOwner {
        if (systemPaused) revert TRState();
        systemPaused = true;
        emit SystemPaused(reason, 0, 0);
    }

    /// @notice Alias of resumeSystem() with the paired name the
    /// pauseSystem()/unpauseSystem() kill-switch API expects. Identical
    /// effect -- both clear the same systemPaused flag and reset the
    /// inactivity clocks so the automatic guard doesn't immediately re-trip.
    function unpauseSystem() external onlyOwner {
        if (!systemPaused) revert TRState();
        _resume();
    }

    function _resume() internal {
        systemPaused             = false;
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        emit SystemResumed(msg.sender);
    }

    // ─── Member-facing ────────────────────────────────────────────────────────

    function register(address referrer) external whenNotPaused {
        _register(referrer);
    }

    /// @notice V8.44 (G1a): one-popup registration — member options folded into
    ///         the register tx (the old flow fired a SECOND wallet popup for
    ///         setMemberOptions to enable auto re-entry).
    function registerWithOptions(
        address referrer,
        bool disableUpgrade,
        bool enableReentry,
        bool enableDouble
    ) external whenNotPaused {
        _register(referrer);
        _setMemberOptions(msg.sender, disableUpgrade, enableReentry, enableDouble);
    }

    /// @notice V8.44 (G1b): registration with an EIP-2612 permit signature —
    ///         no separate approve tx, no standing allowance. The permit
    ///         approves the T1 PairManager (which pulls the entry fee).
    ///         permit() is wrapped in try/catch: if a front-runner consumed the
    ///         signature, registration still succeeds when allowance is set.
    function registerWithPermit(
        address referrer,
        bool disableUpgrade,
        bool enableReentry,
        bool enableDouble,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external whenNotPaused {
        try IERC20PermitLike(address(usdc)).permit(
            msg.sender, tierPairManagers[0], value, deadline, v, r, s
        ) {} catch {}
        _register(referrer);
        _setMemberOptions(msg.sender, disableUpgrade, enableReentry, enableDouble);
    }

    /// @dev V8.44 size-diet: shared referrer resolution (V8.23 default-W1 rule).
    function _resolveRef(address referrer) internal view returns (address) {
        return (referrer != address(0) && globalJoined[referrer])
            ? referrer
            : (defaultReferrer != address(0) && globalJoined[defaultReferrer])
                ? defaultReferrer
                : address(0);
    }

    /// @dev V8.44 size-diet: shared join bookkeeping for register / coupon paths.
    ///      V8.21 ordering preserved: _checkTierFirstEntry BEFORE the
    ///      memberHighestTier write (see original note in git history).
    function _bookkeepJoin(address resolved) internal {
        memberReferrer[msg.sender]    = resolved;
        globalJoined[msg.sender]      = true;
        _checkTierFirstEntry(msg.sender, 1);
        memberHighestTier[msg.sender] = 1;
        globalJoinedCount            += 1;
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
    }

    function _register(address referrer) internal {
        if (globalJoined[msg.sender]) revert TRState();
        if (tierPairManagers[0] == address(0)) revert TRState();

        address resolved = _resolveRef(referrer);
        _bookkeepJoin(resolved);

        // V8.32 Task #59: free re-entry for wrongfully reclaimed members.
        // Admin pre-funds TierRouter with USDC; we approve PairManager and call registerFor
        // (which pulls from TierRouter = msg.sender) instead of pulling from the member.
        if (freeReentryAllowed[msg.sender]) {
            freeReentryAllowed[msg.sender] = false;
            uint256 fee = IPairManagerV8(tierPairManagers[0]).entryFee();
            usdc.forceApprove(tierPairManagers[0], fee);
            IPairManagerV8(tierPairManagers[0]).registerFor(msg.sender, resolved, 0);
        } else {
            IPairManagerV8(tierPairManagers[0]).registerDirectFor(msg.sender, resolved);
        }

        // Community Fund enrollment (no-op if communityWallet not yet deployed)
        if (communityWallet != address(0)) {
            ICommunityWallet(communityWallet).enroll(msg.sender);
            emit MemberEnrolled(msg.sender, globalJoinedCount);
        }

        _recordEntry(0);
        emit MemberRegistered(msg.sender, 1, resolved);
    }

    /// @notice V8.31: Register with an on-chain coupon code.
    ///         Identical TierRouter bookkeeping to register() (globalJoined, memberReferrer,
    ///         CommunityWallet enroll, velocity counters) then routes coupon entry through
    ///         the current T1 MatA via enterWithCouponFrom(), which handles USDC pull.
    ///         Member must approve the current MatA for at least (entryFee − couponAmount) USDC.
    /// @param referrer       The member who referred this new member (address(0) → W1).
    /// @param couponCodeHash keccak256(abi.encodePacked(plaintextCode)) — computed by the frontend.
    function registerWithCoupon(address referrer, bytes32 couponCodeHash) external whenNotPaused {
        if (globalJoined[msg.sender]) revert TRState();
        if (tierPairManagers[0] == address(0)) revert TRState();
        if (couponCodeHash == bytes32(0)) revert TRZero();

        // Route coupon entry through the current T1 MatA (not PairManager — USDC goes direct).
        // Resolve matA first so we can look up the coupon issuer before setting memberReferrer.
        address matA = IPairManagerV8(tierPairManagers[0]).currentMatA();

        // V8.31: Force referrer = coupon issuer.
        // The coupon code is cryptographically bound to whoever issued it — the frontend-supplied
        // referrer parameter is overridden so no one can hijack referral credit by typing a code
        // with a different sponsor address.
        address couponReg = IFigureEightMatrixV8Coupon(matA).couponRegistry();
        if (couponReg != address(0)) {
            (address issuer,,,) = ICouponRegistry(couponReg).coupons(couponCodeHash);
            if (issuer != address(0) && globalJoined[issuer]) {
                referrer = issuer;  // coupon issuer wins, always
            }
        }

        address resolved = _resolveRef(referrer);
        _bookkeepJoin(resolved);

        IFigureEightMatrixV8Coupon(matA).enterWithCouponFrom(msg.sender, resolved, couponCodeHash);

        if (communityWallet != address(0)) {
            ICommunityWallet(communityWallet).enroll(msg.sender);
            emit MemberEnrolled(msg.sender, globalJoinedCount);
        }

        _recordEntry(0);
        emit MemberRegistered(msg.sender, 1, resolved);
    }

    function setMemberOptions(
        bool disableUpgrade,
        bool enableReentry,
        bool enableDouble
    ) external {
        if (!globalJoined[msg.sender]) revert TRState();
        _setMemberOptions(msg.sender, disableUpgrade, enableReentry, enableDouble);
    }

    function _setMemberOptions(
        address member,
        bool disableUpgrade,
        bool enableReentry,
        bool enableDouble
    ) internal {
        MemberOptions storage opts = memberOptions[member];
        opts.autoUpgradeDisabled  = disableUpgrade;
        opts.autoReentryEnabled   = enableReentry;
        opts.doubleReentryEnabled = enableDouble;
        opts.optionsSet           = true;
        // Keep legacy mapping in sync
        doubleEntryEnabled[member] = enableDouble;
        emit MemberOptionsSet(member, disableUpgrade, enableReentry, enableDouble);
    }

    /// @dev Legacy toggle — kept for V8 test script compatibility.
    function setDoubleEntry(bool enabled) external {
        doubleEntryEnabled[msg.sender]                   = enabled;
        memberOptions[msg.sender].doubleReentryEnabled   = enabled;
        memberOptions[msg.sender].optionsSet             = true;
        emit DoubleEntryToggled(msg.sender, enabled);
    }

    /// @dev V8.44 (C2): the manualUpgrade three-way eligibility, extracted so
    ///      manualUpgrade, bulkUpgrade and hybridUpgrade all use the SAME rule.
    ///      (V8.43 bug: bulkUpgrade hard-required the whale gate only, so a
    ///      member eligible via a completed cycle could upgrade through one
    ///      button and not the other.)
    ///      Eligible when (a) completed >=1 cycle in the previous tier, OR
    ///      (b) currently seated in ANY of the previous tier's MatBs (V8.38:
    ///      all pairs scanned), OR (c) the Whale Gate is open for the target.
    /// @dev V8.44 size-diet: one require site for the shared eligibility string.
    function _requireUpgradeEligible(uint8 targetTierIndex) internal view {
        if (!_upgradeEligible(msg.sender, targetTierIndex)) revert TRGate();
    }

    function _upgradeEligible(address member, uint8 targetTierIndex) internal view returns (bool) {
        uint8 prevIndex = targetTierIndex - 1;
        if (tierCycles[member][prevIndex] >= 1) return true;
        if (_isTierUnlockedForManualEntry(targetTierIndex + 1)) return true;
        address prevPM = tierPairManagers[prevIndex];
        if (prevPM != address(0)) {
            uint256 numPairs = IPairManagerV8(prevPM).pairCount();
            for (uint256 pi = 0; pi < numPairs; pi++) {
                (, address matB) = IPairManagerV8(prevPM).getPairAt(pi);
                if (matB != address(0) && IFigureEightMatrixV8(matB).isActiveInMatrix(member)) {
                    return true;
                }
            }
        }
        return false;
    }

    function manualUpgrade(uint8 targetTierIndex) external whenNotPaused {
        _manualUpgrade(targetTierIndex);
    }

    /// @notice V8.44 (G1b): manualUpgrade with an EIP-2612 permit signature —
    ///         approval and upgrade in one tx (spender = this TierRouter).
    function manualUpgradeWithPermit(
        uint8 targetTierIndex,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external whenNotPaused {
        try IERC20PermitLike(address(usdc)).permit(
            msg.sender, address(this), value, deadline, v, r, s
        ) {} catch {}
        _manualUpgrade(targetTierIndex);
    }

    function _manualUpgrade(uint8 targetTierIndex) internal {
        if (!globalJoined[msg.sender]) revert TRState();
        if (targetTierIndex == 0 || targetTierIndex >= MAX_TIERS) revert TRBadValue();
        if (tierPairManagers[targetTierIndex] == address(0)) revert TRState();

        uint8 prevIndex = targetTierIndex - 1;
        _requireUpgradeEligible(targetTierIndex);

        // V8.46: ask the PairManager, not tierMatrixAAddr — that is pair 1 only.
        if (IPairManagerV8(tierPairManagers[targetTierIndex]).holdsSeatIn(msg.sender)) revert TRState();

        uint256 fee = tierEntryFees[targetTierIndex];
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        // V8.47 upgrade gate: also clear any outstanding rescue debt from the wallet so
        // the member advances clean (reverts if they can't cover it).
        _walletFold(msg.sender);
        usdc.forceApprove(tierPairManagers[targetTierIndex], fee);

        address referrer = memberReferrer[msg.sender];
        IPairManagerV8(tierPairManagers[targetTierIndex]).registerFor(msg.sender, referrer, 0);

        uint8 targetTierNum = _finishTierEntry(targetTierIndex);
        emit ManualUpgrade(msg.sender, prevIndex + 1, targetTierNum, fee);
    }

    // ─── V8.44 (G3): hybrid upgrade — earnings first, wallet for the rest ────

    event HybridUpgrade(address indexed member, uint8 toTier, uint256 fromEarnings, uint256 fromWallet);

    /// @notice Upgrade funded from the member's FREE earnings in the previous
    ///         tier's matrices first (never touching crossing/automation
    ///         locks — freeWithdrawable only), pulling only the shortfall from
    ///         the wallet in the same tx. Same eligibility as manualUpgrade.
    function hybridUpgrade(uint8 targetTierIndex) external whenNotPaused {
        if (!globalJoined[msg.sender]) revert TRState();
        if (targetTierIndex == 0 || targetTierIndex >= MAX_TIERS) revert TRBadValue();
        if (tierPairManagers[targetTierIndex] == address(0)) revert TRState();
        _requireUpgradeEligible(targetTierIndex);
        // V8.46: ask the PairManager, not tierMatrixAAddr — that is pair 1 only.
        if (IPairManagerV8(tierPairManagers[targetTierIndex]).holdsSeatIn(msg.sender)) revert TRState();

        uint256 fee       = tierEntryFees[targetTierIndex];
        uint256 remaining = fee;

        // Draw free earnings across the previous tier's pairs (MatB first —
        // that's where cycle earnings sit — then MatA).
        address prevPM = tierPairManagers[targetTierIndex - 1];
        if (prevPM != address(0)) {
            uint256 n = IPairManagerV8(prevPM).pairCount();
            for (uint256 p = 0; p < n && remaining > 0; p++) {
                (address mA, address mB) = IPairManagerV8(prevPM).getPairAt(p);
                remaining = _drawFreeEarnings(mB, remaining);
                remaining = _drawFreeEarnings(mA, remaining);
            }
        }
        uint256 fromWallet = remaining;
        if (fromWallet > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), fromWallet);
        }
        // V8.47 upgrade gate: also clear any outstanding rescue debt from the wallet so a
        // hybrid upgrade can't advance past an unpaid debt.
        _walletFold(msg.sender);
        usdc.forceApprove(tierPairManagers[targetTierIndex], fee);
        IPairManagerV8(tierPairManagers[targetTierIndex]).registerFor(
            msg.sender, memberReferrer[msg.sender], 0
        );

        uint8 targetTierNum = _finishTierEntry(targetTierIndex);
        emit HybridUpgrade(msg.sender, targetTierNum, fee - fromWallet, fromWallet);
    }

    /// @dev V8.44 size-diet: shared post-entry bookkeeping for upgrade paths.
    function _finishTierEntry(uint8 targetTierIndex) internal returns (uint8 targetTierNum) {
        targetTierNum = targetTierIndex + 1;
        // V8.21 ordering: _checkTierFirstEntry BEFORE the memberHighestTier write.
        _checkTierFirstEntry(msg.sender, targetTierNum);
        if (targetTierNum > memberHighestTier[msg.sender]) {
            memberHighestTier[msg.sender] = targetTierNum;
        }
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        _recordEntry(targetTierIndex);
    }

    /// @dev Pull up to `remaining` of the member's FREE (lock-respecting) earnings from one
    ///      matrix into this router. Thin wrapper over the linked TierRouterLib (extracted
    ///      for EIP-170 headroom); failures skip silently.
    function _drawFreeEarnings(address mat, uint256 remaining) internal returns (uint256) {
        return TierRouterLib.drawFreeEarnings(mat, msg.sender, remaining);
    }

    // ─── V8.44 (G2): bulk withdraw — sweep every matrix in one tx ────────────

    /// @notice Withdraw the member's FULL free balance from every matrix of
    ///         every deployed tier in one transaction. Additive — the existing
    ///         per-matrix partial withdraw stays available. Matrices where the
    ///         balance is zero or fully locked are skipped silently; each
    ///         matrix applies its own withdrawal fee and lock guards.
    function bulkWithdraw() external {
        if (!globalJoined[msg.sender]) revert TRState();
        for (uint8 t = 0; t < MAX_TIERS; t++) {
            address pmAddr = tierPairManagers[t];
            if (pmAddr == address(0)) continue;
            uint256 n = IPairManagerV8(pmAddr).pairCount();
            for (uint256 p = 0; p < n; p++) {
                (address mA, address mB) = IPairManagerV8(pmAddr).getPairAt(p);
                _sweepMatrix(mA);
                _sweepMatrix(mB);
            }
        }
    }

    function _sweepMatrix(address mat) internal {
        if (mat == address(0)) return;
        try IFigureEightMatrixV8(mat).withdrawableOf(msg.sender) returns (uint256 bal) {
            if (bal == 0) return;
        } catch { return; }
        try IFigureEightMatrixV8(mat).routerWithdrawFor(msg.sender) {} catch {}
    }

    // ─── V8.35: Bulk upgrade — single tx through multiple tiers ──────────────

    /// @notice When a tier's Whale Gate is open, members can enter multiple tiers
    /// in one transaction. Pays all fees upfront and seats the member in each tier's
    /// MatA simultaneously — earning from all tiers at once.
    /// @param targetTierIndex 0-based index of the highest tier to enter (e.g. 4 = T5).
    ///        Must equal or exceed member's current highest tier.
    function bulkUpgrade(uint8 targetTierIndex) external whenNotPaused {
        if (!globalJoined[msg.sender]) revert TRState();
        if (targetTierIndex < 1 || targetTierIndex >= MAX_TIERS) revert TRBadValue();
        if (tierPairManagers[targetTierIndex] == address(0)) revert TRState();

        // memberHighestTier is 1-based; next-to-enter 0-based index = memberHighestTier
        uint8 startIdx = memberHighestTier[msg.sender];
        if (startIdx > targetTierIndex) revert TRBadValue();

        // V8.44 (C2): SAME three-way eligibility as manualUpgrade for the first
        // tier entered (cycle done OR seated in prev MatB OR gate open) — the
        // V8.43 gate-only require blocked members who were eligible through the
        // manualUpgrade button. Tiers BEYOND the first still each require their
        // Whale Gate (eligibility can't be pre-earned for tiers not yet held).
        _requireUpgradeEligible(startIdx);
        for (uint8 i = startIdx + 1; i <= targetTierIndex; i++) {
            if (!_isTierUnlockedForManualEntry(i + 1)) revert TRGate();
        }

        // V8.46 — CHARGE ONLY FOR TIERS ACTUALLY ENTERED.
        //
        // The fee loop summed EVERY tier from startIdx to target while the
        // seating loop below `continue`s past tiers the member already holds, so
        // a skipped tier was still paid for and the router kept the difference.
        // It was latent only because the skip tested tierMatrixAAddr[i] — pair 1
        // — and so almost never fired. Fixing that guard (below) is exactly what
        // would have made this a live overcharge, which is why the two have to
        // ship together.
        //
        // Both loops now use the SAME condition, so what you are charged for and
        // what you are seated in cannot diverge.
        uint256 totalFee;
        for (uint8 i = startIdx; i <= targetTierIndex; i++) {
            if (tierPairManagers[i] == address(0)) revert TRState();
            if (IPairManagerV8(tierPairManagers[i]).holdsSeatIn(msg.sender)) continue;
            totalFee += tierEntryFees[i];
        }
        if (totalFee > 0) usdc.safeTransferFrom(msg.sender, address(this), totalFee);

        // Register in each tier sequentially in the same tx
        address referrer = memberReferrer[msg.sender];
        for (uint8 i = startIdx; i <= targetTierIndex; i++) {
            // Already seated ANYWHERE in this tier — any pair, either half.
            if (IPairManagerV8(tierPairManagers[i]).holdsSeatIn(msg.sender)) {
                continue;
            }
            usdc.forceApprove(tierPairManagers[i], tierEntryFees[i]);
            IPairManagerV8(tierPairManagers[i]).registerFor(msg.sender, referrer, 0);

            uint8 tierNum = i + 1;
            _checkTierFirstEntry(msg.sender, tierNum);
            if (tierNum > memberHighestTier[msg.sender]) {
                memberHighestTier[msg.sender] = tierNum;
            }
            _recordEntry(i);
        }

        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        emit BulkUpgrade(msg.sender, startIdx + 1, targetTierIndex + 1, totalFee);
    }

    // ─── V8.14: MatB entry hook — upgrade eligibility at first crossing ───────

    /**
     * @notice Called by FigureEightMatrixV8._enterMatrix when a member enters MatB.
     *         Covers _crossToPartner, forceCross, and forceCrossKeeper paths.
     *
     *         1. Emits UpgradeEligibleAtCross — frontend listens and enables button.
     *         2. If auto-upgrade ON + balance + allowance >= fee → auto-executes upgrade.
     */
    function onCrossToMatB(address member, uint8 tierIndex) external {
        if (!authorizedMatrices[msg.sender]) revert TRAuth();
        if (matrixTierIndex[msg.sender] != tierIndex) revert TRBadValue();

        if (tierIndex >= MAX_TIERS - 1) return;
        uint8 nextIndex = tierIndex + 1;

        if (tierPairManagers[nextIndex] == address(0)) return;

        // V8.15: MatB crossing IS the gate-open signal — open next tier gate if not already open.
        // The old velocity-gate guard here was defeating the entire V8.14 purpose: members who
        // cross to MatB should be able to auto-upgrade immediately, generating SF funds early.
        if (!tierVelocityGreen[nextIndex]) {
            tierVelocityGreen[nextIndex] = true;
            emit VelocityGateSet(nextIndex, true);
        }

        address nextMatA = tierMatrixAAddr[nextIndex];
        if (nextMatA != address(0) &&
            IFigureEightMatrixV8(nextMatA).isActiveInMatrix(member)) return;

        uint8 fromTierNum = tierIndex + 1;
        uint8 toTierNum   = nextIndex + 1;

        emit UpgradeEligibleAtCross(member, fromTierNum, toTierNum);

        if (memberOptions[member].autoUpgradeDisabled) return;

        uint256 fee = tierEntryFees[nextIndex];

        // V8.43: two funding paths (owner rule 2026-07-22).
        //  Path A (V8.14): member's WALLET — needs a standing allowance, which is
        //    rare in practice (the frontend approves exact per-tx amounts).
        //  Path B (V8.43 NEW): member's in-matrix WITHDRAWABLE in the MatA they
        //    just crossed out of. Withdrawable ONLY — the crossing reserve stays
        //    locked for its re-entry purpose. If neither path can fund the fee,
        //    silently skip; the member upgrades at cycle-out as before.
        if (usdc.balanceOf(member) >= fee && usdc.allowance(member, address(this)) >= fee) {
            usdc.safeTransferFrom(member, address(this), fee);
        } else {
            address srcMatA = IFigureEightMatrixV8(msg.sender).partner();
            if (srcMatA == address(0)) return;
            if (IFigureEightMatrixV8(srcMatA).withdrawableOf(member) < fee) return; // silent skip
            IFigureEightMatrixV8(srcMatA).deductForUpgrade(member, 0, fee);
        }
        usdc.forceApprove(tierPairManagers[nextIndex], fee);

        address referrer = memberReferrer[member];
        IPairManagerV8(tierPairManagers[nextIndex]).registerFor(member, referrer, 0);

        // V8.21 bugfix: must run before the memberHighestTier write below --
        // see the ordering note in register().
        _checkTierFirstEntry(member, toTierNum);
        if (toTierNum > memberHighestTier[member]) {
            memberHighestTier[member] = toTierNum;
        }
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        _recordEntry(nextIndex);

        emit AutoUpgradedAtCross(member, fromTierNum, toTierNum, fee);
    }

    // ─── Matrix B cycle-out callback ──────────────────────────────────────────

    function handleCycleOut(
        address member,
        uint8   tierIndex,
        uint256 escrow,
        uint256 withdrawable
    ) external {
        if (!authorizedMatrices[msg.sender]) revert TRAuth();
        if (matrixTierIndex[msg.sender] != tierIndex) revert TRBadValue();
        if (tierIndex >= MAX_TIERS) revert TRBadValue();

        address matrixB = msg.sender;

        // -- 1. Record cycle + update activity clocks -------------------------
        tierCycles[member][tierIndex] += 1;
        uint256 cycles = tierCycles[member][tierIndex];
        totalSystemCycles            += 1;
        lastActivityTimestamp         = block.timestamp;
        emit CycleRecorded(member, tierIndex, cycles);

        // -- 2. V8.44 ADDITIVE TOGGLES (V8.43 semantics + two-bucket funding) --
        // Funding priority unchanged: re-entry → upgrade → double seat. Each
        // step deducts its fee from the remaining cycle-out funds and is
        // silently skipped when the remainder can't cover it.
        //   auto-reentry ON  → member NEVER graduates: re-enter or PARK.
        //   auto-upgrade ON  → ADDITIONALLY take a seat in the next tier.
        //   double reentry ON → ADDITIONALLY take a 2nd seat in this tier.
        // V8.44: funds arrive as TWO buckets — escrow (the member's crossing
        // reserve, passed by MatrixLogicLib._cycleOutRoot) and withdrawable.
        // Each seat draws escrow first, then earnings (mirror of
        // _crossToPartner's 50/50 crossing logic). If re-entry is ON but
        // underfunded, the member is PARKED in matrixB (rescue machinery
        // applies) instead of silently exiting; on a clean graduation any
        // un-consumed reserve is released to withdrawable — never stranded.
        // -- 3. V8.46-B CASCADE DEPTH CAP -------------------------------------
        //
        // THE PROBLEM, measured on production 2026-07-28: a self-rescue by a
        // member spanning six tiers estimated 17,762,199 gas against a Base
        // Sepolia per-tx ceiling of ~17.8M. It could not be sent at all, and
        // clamping the limit would only trade a refusal for an out-of-gas revert
        // that costs the member their fee. @Lavern_Gay hit the same wall.
        //
        // WHY IT IS DEEP: this function is RE-ENTERED through the whole stack —
        // _executeAdditive -> _takeSeat -> PairManager.registerFor ->
        // matrix.enterFor -> _enterMatrix -> rotation -> _cycleOutRoot ->
        // handleCycleOut again, one tier up, with a DIFFERENT member each time.
        // Depth is a chain through members, not one member's tier span.
        //
        // WHY A COUNTER: V8_46_LadderGas.test.js proved depth is currently
        // bounded by WEALTH — _executeAdditive only upgrades when
        // escrow + withdrawable >= nextFee, and the crossing reserve is exactly
        // 50% of the fee, so each link requires that root to have EARNED the
        // rest. Fresh fixtures stop at two tiers; production reaches six because
        // members accrue. A bound that depends on how rich the chain happens to
        // be is not a bound. This makes it explicit and constant.
        //
        // TRANSIENT storage (EIP-1153, evmVersion cancun): ~100 gas per access
        // and it CLEARS AT END OF TRANSACTION, so a revert mid-cascade cannot
        // leave the counter stuck high and wedge every later cycle-out. A plain
        // storage slot would have exactly that failure mode.
        //
        // Threading a depth argument instead would mean changing the signature
        // of every function on that path — PairManager and the matrix included —
        // for a contract with 35 bytes of EIP-170 headroom.
        uint256 _d;
        assembly { _d := tload(_CASCADE_DEPTH_SLOT) }
        if (_d >= maxCascadeDepth) {
            // Park rather than cascade further. The member has already been
            // removed from the seat map by _cycleOutRoot, so park-not-exit is
            // what keeps them in the system: the rescue machinery re-seats them
            // in a LATER transaction, which is the whole point — the work still
            // happens, it just stops happening all in one block.
            try IFigureEightMatrixV8(matrixB).parkCycledOut(member, 0) {} catch {}
            emit CascadeDepthCapped(member, tierIndex);
            return;
        }
        assembly { tstore(_CASCADE_DEPTH_SLOT, add(_d, 1)) }
        _executeAdditive(matrixB, member, tierIndex, escrow, withdrawable, cycles);
        assembly { tstore(_CASCADE_DEPTH_SLOT, _d) }
    }

    // --- Internal: V8.44 additive cycle-out engine ----------------------------

    /// @dev One seat per funded step, priority re-entry → upgrade → double
    ///      (owner-confirmed 2026-07-22). Early-phase defaults kept from V8.1:
    ///        - re-entry defaults ON until optionsSet && cycles ≥ reentryMinCycles
    ///        - upgrade defaults ON while cycles < autoUpgradeCycleThreshold
    ///      T10 never upgrades (top tier loops forever).
    function _executeAdditive(
        address matrixB,
        address member,
        uint8   tierIndex,
        uint256 escrow,
        uint256 withdrawable,
        uint256 cycles
    ) internal {
        MemberOptions storage opts = memberOptions[member];
        bool reentryOn = (!opts.optionsSet || cycles < reentryMinCycles)
            ? true
            : opts.autoReentryEnabled;
        bool upgradeOn = cycles < autoUpgradeCycleThreshold
            ? true
            : !opts.autoUpgradeDisabled;
        bool doubleOn = (opts.optionsSet ? opts.doubleReentryEnabled : doubleEntryEnabled[member])
            && cycles >= reentryMinCycles;

        address referrer = memberReferrer[member];
        uint256 curFee   = tierEntryFees[tierIndex];
        bool anySeat = false;
        bool reenteredThisTier = false;

        // -- 1. RE-ENTRY: never graduate while enabled -------------------------
        if (reentryOn && escrow + withdrawable >= curFee) {
            (bool toMatB, uint256 target) = _sameTierTarget(matrixB, tierIndex, member);
            (escrow, withdrawable) = _takeSeat(
                matrixB, member, referrer, tierIndex, curFee, target, toMatB, escrow, withdrawable
            );
            emit MemberReentered(member, tierIndex + 1);
            anySeat = true;
            reenteredThisTier = true;
        }

        // -- 2. UPGRADE: additive next-tier seat (V8.1 guards d/g/h kept) ------
        if (upgradeOn && tierIndex < 9) {
            uint8   nextIndex = tierIndex + 1;
            uint256 nextFee   = tierEntryFees[nextIndex];
            // V8.47 upgrade gate: fold any outstanding rescue debt into the cost. The
            // member must cover the debt AND the next-tier fee; the upgrade repays the
            // debt to the SF first so they advance CLEAN. If they can't cover both, the
            // upgrade no-ops — their re-entry seat + the pool-share redirect keep draining
            // the debt from earnings until they can.
            uint256 upDebt = stabilityFund != address(0)
                ? ISFDebt(stabilityFund).memberDebtOf(member) : 0;
            if (tierPairManagers[nextIndex] != address(0)
                && escrow + withdrawable >= nextFee + upDebt
                && tierVelocityGreen[nextIndex]) {
                // V8.46 PRIMARY FIX (2026-07-27) — PREVENT the duplicate seat.
                // This guard used to check only the destination MatA. The member
                // who graduated at block 44702114 was in the destination's MatB,
                // so it passed, the upgrade seated them in MatA, and they then
                // held BOTH halves of the T4 pair.
                //
                // I first tried to ACCOMMODATE that (route re-entry to MatB when
                // MatA is occupied) and dropped this check to save 170 bytes.
                // V8_46_SeatCollision.test.js proved that wrong: with a member in
                // both halves, the next MatA rotation makes them root, the
                // crossing tries to seat them in the MatB they already occupy,
                // and `require(!isInMatrix)` reverts — from _crossToPartner, which
                // is NOT inside the swallowing try/catch. That revert propagates
                // out and kills an UNRELATED member's registration. Trading a
                // silent member loss for a pair-wide denial of service.
                //
                // Grim corollary: the silent graduation was masking this. Losing
                // the member freed their MatB seat, so the later crossing worked.
                //
                // So duplicates must never form. "Already in this tier" has to
                // mean the whole TIER — every pair, both halves — not one pair's
                // two matrices. The first version of this guard read
                // tierMatrixAAddr/BAddr, which is pair 1 and nothing else.
                if (!IPairManagerV8(tierPairManagers[nextIndex]).holdsSeatIn(member)) {
                    // V8.47: repay the folded debt from earnings first, then escrow, so
                    // the member carries no rescue debt into the higher tier.
                    if (upDebt > 0) {
                        (escrow, withdrawable) = TierRouterLib.autoFold(
                            stabilityFund, usdc, matrixB, member, upDebt, escrow, withdrawable
                        );
                    }
                    (escrow, withdrawable) = _takeSeat(
                        matrixB, member, referrer, nextIndex, nextFee, 0, false, escrow, withdrawable
                    );
                    uint8 destTierNum = nextIndex + 1;
                    // V8.21 bugfix ordering: _checkTierFirstEntry BEFORE the
                    // memberHighestTier write (see note in register()).
                    _checkTierFirstEntry(member, destTierNum);
                    if (destTierNum > memberHighestTier[member]) memberHighestTier[member] = destTierNum;
                    emit MemberUpgraded(member, tierIndex + 1, destTierNum, nextFee);
                    anySeat = true;
                }
            }
        }

        // -- 3. DOUBLE: 2nd seat in the CURRENT tier ---------------------------
        if (doubleOn && anySeat && escrow + withdrawable >= curFee) {
            // V8.46: the double goes in a DIFFERENT PAIR of the same tier.
            //
            // V8.45 sent it through _sameTierTarget, which picks a half of the
            // member's OWN pair — so the double seat and the re-entry seat ended
            // up in MatA and MatB of one pair. That is a duplicate by
            // construction, and a duplicate stops its pair dead the moment its
            // holder reaches position 1 (T3.1 and T4.1 both had to be repaired
            // live on 2026-07-28).
            //
            // The member still gets a second position in the tier — the benefit
            // is unchanged. If every pair already holds them the double is
            // SKIPPED, not attempted: this runs inside the cycle-out, so a
            // revert here would roll back the re-entry and upgrade that already
            // succeeded in the same call. A skipped double costs the member a
            // bonus seat; a reverted one costs them their place in the tier.
            uint256 dest = IPairManagerV8(tierPairManagers[tierIndex]).freePairFor(
                member, IFigureEightMatrixV8(matrixB).pairIndex()
            );
            if (dest != type(uint256).max) {
                (escrow, withdrawable) = _takeSeat(
                    matrixB, member, referrer, tierIndex, curFee, dest, false, escrow, withdrawable
                );
                emit DoubleEntryFired(member, tierIndex + 1, tierIndex + 1);
                reenteredThisTier = true;
            }
        }

        // -- 4. V8.44 no-strand epilogue ---------------------------------------
        if (!anySeat && reentryOn) {
            // Re-entry intended but underfunded → PARK in matrixB. The member
            // keeps reserve + withdrawable earmarked; the auto-rescue keeper
            // covers them if funds suffice, selfRescue() (pay the shortfall,
            // no debt) covers the rest. NEVER a silent exit.
            uint256 have = escrow + withdrawable;
            uint256 shortfall = curFee > have ? curFee - have : 0;
            try IFigureEightMatrixV8(matrixB).parkCycledOut(member, shortfall) {} catch {}
            emit MemberParked(member, tierIndex + 1, "insufficient funds");
        } else if (!reenteredThisTier && escrow > 0) {
            // Clean graduation from this tier (re-entry OFF, or upgrade-only
            // exit) with un-consumed reserve → release it to withdrawable.
            try IFigureEightMatrixV8(matrixB).releaseReserve(member) {} catch {}
            if (!anySeat) {
                emit MemberParked(member, tierIndex + 1, "autoReentry disabled");
            }
        } else if (!anySeat) {
            emit MemberParked(member, tierIndex + 1, "autoReentry disabled");
        }
    }

    /// @dev Deduct `fee` from the member's cycle-out funds held in `matrixB` —
    ///      escrow (crossing reserve) first, earnings for the remainder — then
    ///      register one seat in `destTierIndex` at `targetPairIndex`.
    ///      V8.44: `toMatB` seats the member directly in the target pair's
    ///      MatB (saturated own pair — the entry rotates a full MatB).
    function _takeSeat(
        address matrixB,
        address member,
        address referrer,
        uint8   destTierIndex,
        uint256 fee,
        uint256 targetPairIndex,
        bool    toMatB,
        uint256 escrow,
        uint256 withdrawable
    ) internal returns (uint256, uint256) {
        // Body extracted to the linked TierRouterLib for EIP-170 headroom; the entry-time
        // log stays here (it touches router storage).
        (escrow, withdrawable) = TierRouterLib.takeSeat(
            tierPairManagers[destTierIndex], usdc, matrixB, member, referrer,
            fee, targetPairIndex, toMatB, escrow, withdrawable
        );
        _recordEntry(destTierIndex);
        return (escrow, withdrawable);
    }

    /// @dev V8.44 overflow rework for same-tier seats. Below saturation the
    ///      re-entry loops back into the OWN pair's MatA (V8.43 behavior kept).
    ///      At saturation (cumulative entries >= pairExpansionThreshold) the
    ///      V8.43 code diverted the seat to pair N+1 — starving the own MatB
    ///      (frozen-MatB root cause). V8.44: the seat goes into the OWN pair's
    ///      MatB instead, where it rotates the full matrix and keeps the pair
    ///      churning. Only genuinely NEW externals overflow to later pairs.
    ///      V8.46 (item A): compare LIVE COMBINED OCCUPANCY, as the parameter's
    ///      own doc at :230 describes ("Minimum combined occupancy (MatA + MatB)").
    ///      The V8.44/V8.45 code compared pairs[i].totalRegistered — a CUMULATIVE
    ///      lifetime counter that only ever grows. Every pair therefore crossed
    ///      the threshold permanently and never came back, so re-entries were
    ///      diverted to MatB forever. Combined with _findExternalPair sending new
    ///      externals to a younger pair (which is deliberate — PairManagerV8:495
    ///      relies on the pair sustaining itself), a saturated pair's MatA had NO
    ///      entry source at all: rotation stopped and every member in seats
    ///      2..127 froze permanently. Measured live 2026-07-26: MatA rotation
    ///      dead on every saturated pair across all 10 tiers.
    ///
    ///      Live occupancy maxes at 254 (127+127), so the default threshold of
    ///      381 now means "never divert" — the self-sustaining loop the design
    ///      depends on. The knob still works if an owner lowers it below 254.
    ///      V8.46 COLLISION GUARD (2026-07-27) — DO NOT REMOVE.
    ///      Returning MatA *unconditionally* is wrong. Proven by fork replay of
    ///      graduation tx 0xff488549… (block 44702114): the member already held
    ///      a T4.1 MatA seat, so re-entry hit `require(!isInMatrix)` at
    ///      MatrixLogicLib:255, the empty catch at :513 swallowed it, and they
    ///      vanished with their crossing reserve — 9 events, 6 members, $467.50.
    ///
    ///      They were in MatA because an AUTO-UPGRADE put them there (44689351:
    ///      T3 MatB cycle-out → re-enter T3 AND upgrade into T4 MatA) while
    ///      their T4 MatB seat from an earlier crossing was still live. Nothing
    ///      to do with double entry, which was suspected and is exonerated.
    ///
    ///      V8.45's saturation branch accidentally dodged this by diverting to
    ///      MatB. Removing it without this guard would have made every such
    ///      cycle-out graduate — MORE silent losses, not fewer.
    ///
    ///      So: MatA by default (keeps the figure-eight self-sustaining), but
    ///      MatB when the member already occupies MatA. If they somehow hold
    ///      both, the seat call still reverts and V8.46-C parks them with a
    ///      CycleOutFailed event instead of losing them.
    function _sameTierTarget(address matrixB, uint8 tierIndex, address member)
        internal view returns (bool toMatB, uint256 target)
    {
        tierIndex; // unused; kept so the call sites and ABI are unchanged
        // Re-entry ALWAYS returns to the member's own MatA. Entering a full MatA
        // is not a problem — it rotates the root, which crosses into the pair's
        // own MatB. That IS the figure-eight, and it is what keeps a saturated
        // pair self-sustaining once _findExternalPair (PairManagerV8:495) stops
        // sending it new externals, exactly as that function's comment assumes.
        //
        // The removed branch diverted re-entry to MatB whenever
        // pairs[i].totalRegistered >= pairExpansionThreshold — a CUMULATIVE
        // lifetime counter, so every pair crossed it permanently. MatA then had
        // no entry source from either direction and froze: measured 2026-07-26,
        // MatA rotation dead on every saturated pair in all 10 tiers, members
        // stuck in seats 2..127 indefinitely.
        //
        // Proven live: raising the threshold to 1,000,000 at 8:25 PM EDT forced
        // this same always-MatA behaviour and every MatA resumed rotating within
        // seconds, integrity clean across 19+ hours. This makes that permanent.
        // pairExpansionThreshold and its setter are now DELETED — nothing read
        // them once this became unconditional, and TierRouter needed the space.
        tierIndex; // unused; kept so the call sites and ABI are unchanged
        // Body extracted to the linked TierRouterLib for EIP-170 headroom.
        return TierRouterLib.sameTierTarget(matrixB, member);
    }

    /// @dev V8.21: generalized from the old T5-only `_checkT5FirstEntry` to
    /// track every tier independently against the same shared
    /// `whaleGateThreshold`. No longer gates any routing behavior (see
    /// removed Guard c above) -- purely a per-tier "how many members have
    /// first reached this tier" counter, exposed for display/eligibility via
    /// `isWhaleGateActiveForTier()` and `getMemberInfo()`.
    function _checkTierFirstEntry(address member, uint8 tierNum) internal {
        if (tierNum == 0 || tierNum > MAX_TIERS) return;
        if (tierWhaleGateActive[tierNum]) return;
        if (memberHighestTier[member] < tierNum) {
            tierFirstEntries[tierNum] += 1;
            // V8.35: use per-tier threshold if set, else fall back to global whaleGateThreshold
            uint256 threshold = tierGateThreshold[tierNum] > 0
                ? tierGateThreshold[tierNum]
                : whaleGateThreshold;
            if (tierFirstEntries[tierNum] >= threshold) {
                tierWhaleGateActive[tierNum] = true;
                emit WhaleGateActivated(tierNum, tierFirstEntries[tierNum]);
            }
        }
    }

    /// @dev V8.35: T1 is always open. T2-T5 unlock together when T5's pioneer
    /// threshold fires. T6-T10 each unlock independently via their own counter.
    /// Used only by manualUpgrade() — auto-upgrades are never gated.
    function _isTierUnlockedForManualEntry(uint8 tierNum) internal view returns (bool) {
        if (tierNum <= 1) return true;
        if (tierNum <= 5) return tierWhaleGateActive[5]; // T2-T5 share T5's gate
        return tierWhaleGateActive[tierNum];             // T6-T10 independent
    }

    /// @notice View whether a given tier's whale-gate first-entry threshold
    /// has been reached. Purely informational since V8.21 (no routing effect).
    function isWhaleGateActiveForTier(uint8 tierNum) external view returns (bool) {
        return tierWhaleGateActive[tierNum];
    }

    // ─── Entry tracking helper ───────────────────────────────────────────────

    function _recordEntry(uint8 tierIdx) internal {
        if (_sysEntryTimes.length < MAX_ENTRY_LOG) {
            _sysEntryTimes.push(block.timestamp);
        } else {
            for (uint256 i = 0; i < _sysEntryTimes.length - 1; i++) {
                _sysEntryTimes[i] = _sysEntryTimes[i + 1];
            }
            _sysEntryTimes[_sysEntryTimes.length - 1] = block.timestamp;
        }
        uint256[] storage ta = _tierEntryTimes[tierIdx];
        if (ta.length < MAX_ENTRY_LOG) {
            ta.push(block.timestamp);
        } else {
            for (uint256 i = 0; i < ta.length - 1; i++) {
                ta[i] = ta[i + 1];
            }
            ta[ta.length - 1] = block.timestamp;
        }
    }

    // ─── Keeper interface ─────────────────────────────────────────────────────

    function setDeflationState(uint8 state) external {
        if (msg.sender != matrixKeeper && msg.sender != owner()) revert TRAuth();
        if (state > 2) revert TRBadValue();
        uint8 prev = deflationState;
        deflationState = state;
        if (state != prev) emit DeflationStateChanged(prev, state);
    }

    function getSystemEntryCount(uint256 fromTimestamp) external view returns (uint256) {
        uint256 cnt = 0;
        uint256 len = _sysEntryTimes.length;
        for (uint256 i = 0; i < len; i++) {
            if (_sysEntryTimes[i] >= fromTimestamp) cnt++;
        }
        return cnt;
    }

    function getTierEntryCount(uint8 tier, uint256 fromTimestamp) external view returns (uint256) {
        uint256 cnt = 0;
        uint256[] storage ta = _tierEntryTimes[tier];
        uint256 len = ta.length;
        for (uint256 i = 0; i < len; i++) {
            if (ta[i] >= fromTimestamp) cnt++;
        }
        return cnt;
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getMemberInfo(address member) external view returns (
        uint8   highestTier,
        address referrer,
        uint256 totalCycles,
        bool    doubleEntry,
        bool    whaleGateEligible,
        bool    autoUpgradeEnabled,
        bool    autoReentryEnabled
    ) {
        highestTier        = memberHighestTier[member];
        referrer           = memberReferrer[member];
        doubleEntry        = memberOptions[member].doubleReentryEnabled || doubleEntryEnabled[member];
        // V8.21: no longer means "eligible to skip a tier" (that behavior is
        // removed) -- just reports whether the member's next tier already
        // has its whale-gate first-entry threshold tripped.
        // V8.35: use _isTierUnlockedForManualEntry so T2 shows eligible when T5's
        // shared gate fires (T2-T5 all check tierWhaleGateActive[5]).
        whaleGateEligible  = highestTier < MAX_TIERS &&
                             _isTierUnlockedForManualEntry(uint8(highestTier + 1));
        autoUpgradeEnabled = !memberOptions[member].autoUpgradeDisabled;
        autoReentryEnabled = memberOptions[member].autoReentryEnabled;
        for (uint8 i = 0; i < MAX_TIERS; i++) {
            totalCycles += tierCycles[member][i];
        }
    }

    function getMemberOptions(address member) external view returns (
        bool autoUpgradeDisabled,
        bool autoReentryEnabled,
        bool doubleReentryEnabled,
        bool optionsSet
    ) {
        MemberOptions memory opts = memberOptions[member];
        return (
            opts.autoUpgradeDisabled,
            opts.autoReentryEnabled,
            opts.doubleReentryEnabled,
            opts.optionsSet
        );
    }

    function getTierCycles(address member, uint8 tierIndex)
        external view returns (uint256)
    {
        return tierCycles[member][tierIndex];
    }

    function isUpgradeEligible(address member, uint8 tierIndex)
        external view
        returns (bool eligible, uint8 nextTierNum, uint256 feeNeeded)
    {
        if (tierIndex >= 9) return (false, 0, 0);
        uint256 cycles = tierCycles[member][tierIndex];
        if (cycles == 0) return (false, 0, 0);
        nextTierNum = tierIndex + 2;
        feeNeeded   = tierEntryFees[tierIndex + 1];
        eligible    = tierPairManagers[tierIndex + 1] != address(0);
    }

    function getTierConfig(uint8 tierIndex)
        external view
        returns (address pairManager, uint256 entryFee)
    {
        if (tierIndex >= MAX_TIERS) revert TRBadValue();
        pairManager = tierPairManagers[tierIndex];
        entryFee    = tierEntryFees[tierIndex];
    }

    function getAllTiers() external view returns (
        address[10] memory pairManagers,
        uint256[10] memory entryFees
    ) {
        return (tierPairManagers, tierEntryFees);
    }


    /// @notice V8.19: Returns the USDC amount a member must keep as protocol reserve.
    ///         Matrix withdraw() functions call this to prevent members from accidentally
    ///         draining the funds needed for their own automation (reentry / upgrade).
    /// @dev    Reserve is computed from the member's current options + tier fees.
    ///         Double-entry stacks: one slot upgrades + one slot re-enters.
    ///         Only the active highest-tier matrix enforces this (checked in the matrix).
    // ── V8.32 admin helpers ───────────────────────────────────────────────────

    /// @notice V8.32: Retroactively set globalJoined for pre-V8.31 coupon members
    ///         who bypassed registerWithCoupon() and therefore never got the flag set.
    ///         Fixes setMemberOptions() reverting with "TR: not registered".
    function setGlobalJoined(address member, bool val) external onlyOwner {
        globalJoined[member] = val;
    }

    /// @notice V8.32 Task #59: grant a single free re-entry to a wrongfully reclaimed member.
    ///         Admin must pre-fund TierRouter with enough USDC before calling register().
    function grantFreeReentry(address member) external onlyOwner {
        freeReentryAllowed[member] = true;
    }

    function reservedFor(address member) external view returns (uint256) {
        uint8 highest = memberHighestTier[member];
        if (highest == 0) return 0;

        MemberOptions storage opts = memberOptions[member];
        bool autoUpgrade = !opts.autoUpgradeDisabled;
        bool reentry     = opts.autoReentryEnabled;
        bool doubleE     = opts.doubleReentryEnabled || doubleEntryEnabled[member];

        if (!autoUpgrade && !reentry) return 0;

        uint8 curIdx  = highest - 1;           // 0-based current tier
        uint8 nextIdx = highest;               // 0-based next tier (upgrade target)

        uint256 curFee  = tierEntryFees[curIdx];
        uint256 nextFee = (nextIdx < MAX_TIERS) ? tierEntryFees[nextIdx] : 0;

        // V8.43 additive semantics: each enabled toggle reserves its own fee.
        //   re-entry → curFee, upgrade → nextFee, double → another curFee.
        // (double only fires after a re-entry or upgrade seat, which the
        // !autoUpgrade && !reentry guard above already covers.)
        uint256 total = 0;
        if (reentry)                     total += curFee;
        if (autoUpgrade && nextFee > 0)  total += nextFee;
        if (doubleE)                     total += curFee;
        return total;
    }

    function inactivityStatus() external view returns (
        bool    paused,
        bool    guardEnabled,
        uint256 daysSinceActivity,
        uint256 cyclesSinceReg,
        uint256 daysThreshold,
        uint256 cyclesThreshold,
        bool    daysGuardFiring,
        bool    cyclesGuardFiring
    ) {
        paused             = systemPaused;
        guardEnabled       = inactivityGuardEnabled;
        daysSinceActivity  = (block.timestamp - lastActivityTimestamp) / 1 days;
        cyclesSinceReg     = totalSystemCycles - cyclesAtLastRegistration;
        daysThreshold      = inactivityDaysThreshold;
        cyclesThreshold    = inactivityCyclesThreshold;
        daysGuardFiring    = inactivityDaysThreshold  > 0 && daysSinceActivity >= inactivityDaysThreshold;
        cyclesGuardFiring  = inactivityCyclesThreshold > 0 && cyclesSinceReg   >= inactivityCyclesThreshold;
    }

    /// @notice V8.1: Snapshot of all velocity gates (for keeper dashboard).
    function getVelocityGates() external view returns (bool[10] memory green) {
        for (uint8 i = 0; i < MAX_TIERS; i++) {
            green[i] = tierVelocityGreen[i];
        }
    }

    /// @notice V8.21: Highest tier number (1-10) the system has organically
    /// opened so far -- deployed (tierPairManagers set) AND velocity-green.
    /// Used by StabilityFund to scale its target with how far the system has
    /// progressed. Returns 0 if no tier is both deployed and open yet (should
    /// not happen post-launch, since T1 is always deployed+green at
    /// construction, but guarded for safety during partial setup).
    function highestOpenTier() external view returns (uint8 tierNum) {
        for (uint8 i = MAX_TIERS; i > 0; i--) {
            uint8 idx = i - 1;
            if (tierPairManagers[idx] != address(0) && tierVelocityGreen[idx]) {
                return idx + 1;
            }
        }
        return 0;
    }

}
