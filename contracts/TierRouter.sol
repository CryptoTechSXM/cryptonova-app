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

interface IPairManagerV8 {
    function registerDirectFor(address member, address referrer) external;
    /// @notice V8.41 FIFO: targetPairIndex tells PM which pair to route into.
    ///         Upgrades pass 0 (first pair of dest tier). Re-entries pass srcPairIndex+1.
    function registerFor(address member, address referrer, uint256 targetPairIndex) external;
    function entryFee() external view returns (uint256);
    function currentMatA() external view returns (address);   // V8.31: for coupon routing
    // V8.38: multi-pair MatB scan for manualUpgrade() eligibility
    function pairCount() external view returns (uint256);
    function getPairAt(uint256 idx) external view returns (address matA, address matB);
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

// ─── Contract ──────────────────────────────────────────────────────────────────

contract TierRouter is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    // ─── Tier configuration ───────────────────────────────────────────────────
    uint8 public constant MAX_TIERS = 10;

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
    /// @notice Minimum combined occupancy (MatA + MatB) a pair must have before
    ///         graduates are routed to the NEXT pair (expansion mode).
    ///         Below this threshold graduates loop back into the SAME pair
    ///         (self-sustaining mode) — the pair never goes stale.
    ///         Default 381 = 127 * 3 (one full MatA + one full MatB + one MatA buffer).
    ///         Owner-adjustable; suggested range 200-508.
    uint256 public pairExpansionThreshold = 381;

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
    event PairExpansionThresholdSet(uint256 threshold);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _admin) Ownable(_admin) {
        require(_usdc != address(0), "TR: zero usdc");
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
        require(!systemPaused, "TR: system paused - inactivity");
        _;
    }

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "TR: not authorized");
        _;
    }

    /// @notice V8.35: owner or MatrixPairFactory can register new matrices.
    modifier onlyOwnerOrFactory() {
        require(msg.sender == owner() || msg.sender == pairFactory, "TR: not owner/factory");
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        require(_gov != address(0), "TR: zero governance");
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    // ─── Admin: setup ─────────────────────────────────────────────────────────

    function registerTier(
        uint8   tierIndex,
        address pairManager,
        uint256 entryFee
    ) external onlyOwner {
        require(tierIndex < MAX_TIERS,     "TR: invalid tier");
        require(pairManager != address(0), "TR: zero pm");
        require(entryFee > 0,              "TR: zero fee");
        tierPairManagers[tierIndex] = pairManager;
        tierEntryFees[tierIndex]    = entryFee;
        emit TierRegistered(tierIndex, pairManager, entryFee);
    }

    function setTierMatrices(
        uint8   tierIndex,
        address matA,
        address matB
    ) external onlyOwner {
        require(tierIndex < MAX_TIERS, "TR: invalid tier");
        require(matA != address(0),    "TR: zero matA");
        require(matB != address(0),    "TR: zero matB");
        tierMatrixAAddr[tierIndex] = matA;
        tierMatrixBAddr[tierIndex] = matB;
    }

    /// @notice V8.35: Wire the MatrixPairFactory so it can register new matrices inline.
    function setFactory(address _factory) external onlyOwner {
        pairFactory = _factory;
    }

    function registerMatrix(address matrix, uint8 tierIndex) external onlyOwnerOrFactory {
        require(matrix != address(0),  "TR: zero matrix");
        require(tierIndex < MAX_TIERS, "TR: invalid tier");
        authorizedMatrices[matrix] = true;
        matrixTierIndex[matrix]    = tierIndex;
        emit MatrixRegistered(matrix, tierIndex);
    }

    function deregisterMatrix(address matrix) external onlyOwner {
        authorizedMatrices[matrix] = false;
    }

    /// @notice V8.20: DAO-governable. Allowed: 10, 15, 20, 25, 30, 50.
    function setWhaleGateThreshold(uint256 threshold) external onlyOwnerOrGovernance {
        require(
            threshold == 10 || threshold == 15 || threshold == 20 ||
            threshold == 25 || threshold == 30 || threshold == 50,
            "TR: invalid threshold (allowed: 10,15,20,25,30,50)"
        );
        whaleGateThreshold = threshold;
        emit WhaleGateThresholdSet(threshold);
    }

    /// @notice V8.35: DAO adjusts the pioneer threshold for a specific tier (T5-T10).
    /// T2-T5 share T5's gate; T6-T10 are independent. Range 1-50.
    function setTierGateThreshold(uint8 tierNum, uint256 threshold) external onlyOwnerOrGovernance {
        require(tierNum >= 5 && tierNum <= MAX_TIERS, "TR: gate only applies to T5-T10");
        require(threshold >= 1 && threshold <= 50,    "TR: threshold must be 1-50");
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
    function setTierGateThresholdT5(uint256 v)  external onlyOwnerOrGovernance { require(v >= 1 && v <= 50, "TR: threshold 1-50"); tierGateThreshold[5]  = uint8(v); emit TierGateThresholdUpdated(5,  v); }
    function setTierGateThresholdT6(uint256 v)  external onlyOwnerOrGovernance { require(v >= 1 && v <= 50, "TR: threshold 1-50"); tierGateThreshold[6]  = uint8(v); emit TierGateThresholdUpdated(6,  v); }
    function setTierGateThresholdT7(uint256 v)  external onlyOwnerOrGovernance { require(v >= 1 && v <= 50, "TR: threshold 1-50"); tierGateThreshold[7]  = uint8(v); emit TierGateThresholdUpdated(7,  v); }
    function setTierGateThresholdT8(uint256 v)  external onlyOwnerOrGovernance { require(v >= 1 && v <= 50, "TR: threshold 1-50"); tierGateThreshold[8]  = uint8(v); emit TierGateThresholdUpdated(8,  v); }
    function setTierGateThresholdT9(uint256 v)  external onlyOwnerOrGovernance { require(v >= 1 && v <= 50, "TR: threshold 1-50"); tierGateThreshold[9]  = uint8(v); emit TierGateThresholdUpdated(9,  v); }
    function setTierGateThresholdT10(uint256 v) external onlyOwnerOrGovernance { require(v >= 1 && v <= 50, "TR: threshold 1-50"); tierGateThreshold[10] = uint8(v); emit TierGateThresholdUpdated(10, v); }

    function setTierWhaleGateActive(uint8 tierNum, bool active) external onlyOwnerOrGovernance {
        require(tierNum >= 1 && tierNum <= MAX_TIERS, "TR: invalid tier");
        tierWhaleGateActive[tierNum] = active;
        if (active) {
            emit WhaleGateActivated(tierNum, tierFirstEntries[tierNum]);
        }
    }

    /// @notice V8.1: Set the MatrixKeeper address (Chainlink Automation).
    function setMatrixKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "TR: zero keeper");
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

    /// @notice V8.42: Set the pair expansion threshold.
    ///         Graduate re-entries loop back into the SAME pair (self-sustaining)
    ///         until MatA.occupancy + MatB.occupancy >= threshold, then route to
    ///         the next pair (expansion). Min 127 (one full MatA); default 381 (127*3).
    function setPairExpansionThreshold(uint256 threshold) external onlyOwner {
        require(threshold >= 127, "TR: threshold too low");
        pairExpansionThreshold = threshold;
        emit PairExpansionThresholdSet(threshold);
    }

    // ─── V8.1: Velocity gate (keeper-only) ───────────────────────────────────

    function setTierVelocityGreen(uint8 tierIndex, bool green) external {
        require(
            msg.sender == matrixKeeper || msg.sender == owner(),
            "TR: not keeper"
        );
        require(tierIndex < MAX_TIERS, "TR: invalid tier");
        tierVelocityGreen[tierIndex] = green;
        emit VelocityGateSet(tierIndex, green);
    }

    // ─── V8.1: DAO governance setters (enumerated menus only) ────────────────

    function setAutoUpgradeCycleThreshold(uint256 threshold) external onlyOwnerOrGovernance {
        require(
            threshold == 1 || threshold == 3 || threshold == 5 || threshold == 10,
            "TR: invalid threshold (allowed: 1,3,5,10)"
        );
        autoUpgradeCycleThreshold = threshold;
        emit AutoUpgradeThresholdSet(threshold);
    }

    function setReentryMinCycles(uint256 minCycles) external onlyOwnerOrGovernance {
        require(
            minCycles == 1 || minCycles == 2 || minCycles == 3 || minCycles == 5,
            "TR: invalid minCycles (allowed: 1,2,3,5)"
        );
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
        require(
            v == 0 || v == 7 || v == 14 || v == 30 || v == 60 || v == 90,
            "TR: invalid days threshold"
        );
        inactivityDaysThreshold = v;
        emit InactivityDaysThresholdSet(v);
    }

    /// @notice DAO-governable. Allowed: 1, 2, 3, 5, 10 (cycles). 0 disables the cycles guard.
    function setInactivityCyclesThreshold(uint256 v) external onlyOwnerOrGovernance {
        require(
            v == 0 || v == 1 || v == 2 || v == 3 || v == 5 || v == 10,
            "TR: invalid cycles threshold"
        );
        inactivityCyclesThreshold = v;
        emit InactivityCyclesThresholdSet(v);
    }

    /// @notice DAO-governable. v must be 0 (disabled) or 1 (enabled) -- V8Governance
    ///         only deals in uint256, so bool is encoded this way.
    function setInactivityGuardEnabled(uint256 v) external onlyOwnerOrGovernance {
        require(v == 0 || v == 1, "TR: invalid bool value (0 or 1)");
        inactivityGuardEnabled = (v == 1);
        emit InactivityGuardEnabledSet(v == 1);
    }

    function checkInactivity() public {
        if (!inactivityGuardEnabled || systemPaused) return;

        uint256 daysSince      = (block.timestamp - lastActivityTimestamp) / 1 days;
        uint256 cyclesSinceReg = totalSystemCycles - cyclesAtLastRegistration;

        bool daysBreached   = inactivityDaysThreshold  > 0 && daysSince      >= inactivityDaysThreshold;
        bool cyclesBreached = inactivityCyclesThreshold > 0 && cyclesSinceReg >= inactivityCyclesThreshold;

        if (daysBreached || cyclesBreached) {
            systemPaused = true;
            string memory reason = daysBreached
                ? (cyclesBreached ? "both guards" : "days guard")
                : "cycles guard";
            emit SystemPaused(reason, daysSince, cyclesSinceReg);
        }
    }

    function resumeSystem() external onlyOwner {
        require(systemPaused, "TR: not paused");
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
        require(!systemPaused, "TR: already paused");
        systemPaused = true;
        emit SystemPaused(reason, 0, 0);
    }

    /// @notice Alias of resumeSystem() with the paired name the
    /// pauseSystem()/unpauseSystem() kill-switch API expects. Identical
    /// effect -- both clear the same systemPaused flag and reset the
    /// inactivity clocks so the automatic guard doesn't immediately re-trip.
    function unpauseSystem() external onlyOwner {
        require(systemPaused, "TR: not paused");
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
        require(!globalJoined[msg.sender],         "TR: already joined");
        require(tierPairManagers[0] != address(0), "TR: T1 not configured");

        // V8.23: fall back to defaultReferrer (W1) when no valid referrer is supplied.
        // This credits W1 with L1 chain-pay on every organic sign-up, growing its
        // withdrawable balance and reducing SF rescue pressure.
        address resolved = (referrer != address(0) && globalJoined[referrer])
            ? referrer
            : (defaultReferrer != address(0) && globalJoined[defaultReferrer])
                ? defaultReferrer
                : address(0);

        memberReferrer[msg.sender]    = resolved;
        globalJoined[msg.sender]      = true;
        // V8.21 bugfix: _checkTierFirstEntry() gates on memberHighestTier[member]
        // < tierNum -- it must run BEFORE memberHighestTier is written to 1,
        // otherwise the check always sees 1 < 1 (false) and the per-tier
        // counter can never increment. This exact ordering bug existed in the
        // original T5-only code too (silently dead since register() always
        // called it with tierNum=1, which the old code ignored anyway).
        _checkTierFirstEntry(msg.sender, 1);
        memberHighestTier[msg.sender] = 1;
        globalJoinedCount            += 1;

        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;

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
        require(!globalJoined[msg.sender],         "TR: already joined");
        require(tierPairManagers[0] != address(0), "TR: T1 not configured");
        require(couponCodeHash != bytes32(0),       "TR: empty coupon hash");

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

        address resolved = (referrer != address(0) && globalJoined[referrer])
            ? referrer
            : (defaultReferrer != address(0) && globalJoined[defaultReferrer])
                ? defaultReferrer
                : address(0);

        memberReferrer[msg.sender]    = resolved;
        globalJoined[msg.sender]      = true;
        _checkTierFirstEntry(msg.sender, 1);
        memberHighestTier[msg.sender] = 1;
        globalJoinedCount            += 1;

        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;

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
        require(globalJoined[msg.sender], "TR: not registered");
        MemberOptions storage opts = memberOptions[msg.sender];
        opts.autoUpgradeDisabled  = disableUpgrade;
        opts.autoReentryEnabled   = enableReentry;
        opts.doubleReentryEnabled = enableDouble;
        opts.optionsSet           = true;
        // Keep legacy mapping in sync
        doubleEntryEnabled[msg.sender] = enableDouble;
        emit MemberOptionsSet(msg.sender, disableUpgrade, enableReentry, enableDouble);
    }

    /// @dev Legacy toggle — kept for V8 test script compatibility.
    function setDoubleEntry(bool enabled) external {
        doubleEntryEnabled[msg.sender]                   = enabled;
        memberOptions[msg.sender].doubleReentryEnabled   = enabled;
        memberOptions[msg.sender].optionsSet             = true;
        emit DoubleEntryToggled(msg.sender, enabled);
    }

    function manualUpgrade(uint8 targetTierIndex) external whenNotPaused {
        require(globalJoined[msg.sender],                           "TR: not registered");
        require(targetTierIndex > 0 && targetTierIndex < MAX_TIERS, "TR: invalid tier");
        require(tierPairManagers[targetTierIndex] != address(0),    "TR: tier not deployed");

        uint8 prevIndex = targetTierIndex - 1;

        // V8.14: eligible when (a) completed >=1 cycle OR (b) currently in prev MatB.
        // V8.35: (c) Whale Gate open for this tier — gate opening waives the crossing
        // requirement so existing members can chain upgrades immediately on payment.
        // Brand-new wallets (no cycles, not in MatB) are blocked until gate opens.
        //
        // V8.38 FIX: scan ALL MatBs across all pairs for prevIndex, not just the first one.
        // tierMatrixBAddr[prevIndex] is hardcoded to the original MatB (e.g. T1.1 MatB).
        // When the factory spawns T1.2, a member sitting in T1.2 MatB was incorrectly
        // blocked because isActiveInMatrix() on T1.1 MatB returned false for them.
        bool inPrevMatB = false;
        address prevPM  = tierPairManagers[prevIndex];
        if (prevPM != address(0)) {
            uint256 numPairs = IPairManagerV8(prevPM).pairCount();
            for (uint256 pi = 0; pi < numPairs && !inPrevMatB; pi++) {
                (, address matB) = IPairManagerV8(prevPM).getPairAt(pi);
                if (matB != address(0) && IFigureEightMatrixV8(matB).isActiveInMatrix(msg.sender)) {
                    inPrevMatB = true;
                }
            }
        }
        bool gateOpen = _isTierUnlockedForManualEntry(targetTierIndex + 1);
        require(
            tierCycles[msg.sender][prevIndex] >= 1 || inPrevMatB || gateOpen,
            "TR: cross to MatB first, or wait for this tier's Whale Gate to open"
        );

        address destMatA = tierMatrixAAddr[targetTierIndex];
        if (destMatA != address(0)) {
            require(
                !IFigureEightMatrixV8(destMatA).isActiveInMatrix(msg.sender),
                "TR: already seated in target tier"
            );
        }

        uint256 fee = tierEntryFees[targetTierIndex];
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        usdc.forceApprove(tierPairManagers[targetTierIndex], fee);

        address referrer = memberReferrer[msg.sender];
        IPairManagerV8(tierPairManagers[targetTierIndex]).registerFor(msg.sender, referrer, 0);

        uint8 targetTierNum = targetTierIndex + 1;
        // V8.21 bugfix: must run before the memberHighestTier write below --
        // see the ordering note in register().
        _checkTierFirstEntry(msg.sender, targetTierNum);
        if (targetTierNum > memberHighestTier[msg.sender]) {
            memberHighestTier[msg.sender] = targetTierNum;
        }
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        _recordEntry(targetTierIndex);

        emit ManualUpgrade(msg.sender, prevIndex + 1, targetTierNum, fee);
    }

    // ─── V8.35: Bulk upgrade — single tx through multiple tiers ──────────────

    /// @notice When a tier's Whale Gate is open, members can enter multiple tiers
    /// in one transaction. Pays all fees upfront and seats the member in each tier's
    /// MatA simultaneously — earning from all tiers at once.
    /// @param targetTierIndex 0-based index of the highest tier to enter (e.g. 4 = T5).
    ///        Must equal or exceed member's current highest tier.
    function bulkUpgrade(uint8 targetTierIndex) external whenNotPaused {
        require(globalJoined[msg.sender],                              "TR: register at T1 first");
        require(targetTierIndex >= 1 && targetTierIndex < MAX_TIERS,  "TR: invalid target tier");
        require(tierPairManagers[targetTierIndex] != address(0),       "TR: tier not deployed");
        require(
            _isTierUnlockedForManualEntry(targetTierIndex + 1),
            "TR: Whale Gate not yet open for this tier"
        );

        // memberHighestTier is 1-based; next-to-enter 0-based index = memberHighestTier
        uint8 startIdx = memberHighestTier[msg.sender];
        require(startIdx <= targetTierIndex, "TR: already at or above target tier");

        // Calculate and collect total fee upfront
        uint256 totalFee;
        for (uint8 i = startIdx; i <= targetTierIndex; i++) {
            require(tierPairManagers[i] != address(0), "TR: intermediate tier not deployed");
            totalFee += tierEntryFees[i];
        }
        usdc.safeTransferFrom(msg.sender, address(this), totalFee);

        // Register in each tier sequentially in the same tx
        address referrer = memberReferrer[msg.sender];
        for (uint8 i = startIdx; i <= targetTierIndex; i++) {
            // Skip if member is already seated here (e.g. double-entry edge case)
            address matA = tierMatrixAAddr[i];
            if (matA != address(0) && IFigureEightMatrixV8(matA).isActiveInMatrix(msg.sender)) {
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
        require(authorizedMatrices[msg.sender],            "TR: not authorized matrix");
        require(matrixTierIndex[msg.sender] == tierIndex,  "TR: tier mismatch");

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
        require(authorizedMatrices[msg.sender],           "TR: unauthorized");
        require(matrixTierIndex[msg.sender] == tierIndex, "TR: tier mismatch");
        require(tierIndex < MAX_TIERS,                    "TR: invalid tier");

        address matrixB = msg.sender;

        // -- 1. Record cycle + update activity clocks -------------------------
        tierCycles[member][tierIndex] += 1;
        uint256 cycles = tierCycles[member][tierIndex];
        totalSystemCycles            += 1;
        lastActivityTimestamp         = block.timestamp;
        emit CycleRecorded(member, tierIndex, cycles);

        // -- 2. V8.43 ADDITIVE TOGGLES (owner rule 2026-07-22) -----------------
        // The three automation toggles are now independent and ADDITIVE, with
        // funding priority: re-entry → upgrade → double seat. Each step deducts
        // its fee from the remaining cycle-out funds and is silently skipped
        // when the remainder can't cover it.
        //   auto-reentry ON  → member NEVER graduates: always re-enter this tier.
        //   auto-upgrade ON  → ADDITIONALLY take a seat in the next tier.
        //   double reentry ON → ADDITIONALLY take a 2nd seat in this tier.
        // (Replaces V8.1 _resolveDest/_executeAndDouble where an upgrade MOVED
        // the member out of the tier unless double entry happened to be on.)
        _executeAdditive(matrixB, member, tierIndex, escrow + withdrawable, cycles);
    }

    // --- Internal: V8.43 additive cycle-out engine ----------------------------

    /// @dev One seat per funded step, priority re-entry → upgrade → double
    ///      (owner-confirmed 2026-07-22). Early-phase defaults kept from V8.1:
    ///        - re-entry defaults ON until optionsSet && cycles ≥ reentryMinCycles
    ///        - upgrade defaults ON while cycles < autoUpgradeCycleThreshold
    ///      T10 never upgrades (top tier loops forever). If no step fires,
    ///      the member parks exactly as before.
    function _executeAdditive(
        address matrixB,
        address member,
        uint8   tierIndex,
        uint256 funds,
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

        // -- 1. RE-ENTRY: never graduate while enabled -------------------------
        if (reentryOn && funds >= curFee) {
            _takeSeat(matrixB, member, referrer, tierIndex, curFee, _sameTierTarget(matrixB, tierIndex));
            funds -= curFee;
            emit MemberReentered(member, tierIndex + 1);
            anySeat = true;
        }

        // -- 2. UPGRADE: additive next-tier seat (V8.1 guards d/g/h kept) ------
        if (upgradeOn && tierIndex < 9) {
            uint8   nextIndex = tierIndex + 1;
            uint256 nextFee   = tierEntryFees[nextIndex];
            if (tierPairManagers[nextIndex] != address(0)
                && funds >= nextFee
                && tierVelocityGreen[nextIndex]) {
                address dMatA = tierMatrixAAddr[nextIndex];
                if (dMatA == address(0) || !IFigureEightMatrixV8(dMatA).isActiveInMatrix(member)) {
                    _takeSeat(matrixB, member, referrer, nextIndex, nextFee, 0);
                    funds -= nextFee;
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
        if (doubleOn && anySeat && funds >= curFee) {
            _takeSeat(matrixB, member, referrer, tierIndex, curFee, _sameTierTarget(matrixB, tierIndex));
            funds -= curFee;
            emit DoubleEntryFired(member, tierIndex + 1, tierIndex + 1);
        }

        if (!anySeat) {
            emit MemberParked(member, tierIndex + 1, reentryOn ? "insufficient funds" : "autoReentry disabled");
        }
    }

    /// @dev Deduct `fee` from the member's cycle-out funds held in `matrixB`,
    ///      then register one seat in `destTierIndex` at `targetPairIndex`.
    function _takeSeat(
        address matrixB,
        address member,
        address referrer,
        uint8   destTierIndex,
        uint256 fee,
        uint256 targetPairIndex
    ) internal {
        IFigureEightMatrixV8(matrixB).deductForUpgrade(member, 0, fee);
        usdc.forceApprove(tierPairManagers[destTierIndex], fee);
        IPairManagerV8(tierPairManagers[destTierIndex]).registerFor(member, referrer, targetPairIndex);
        _recordEntry(destTierIndex);
    }

    /// @dev V8.43 hybrid routing for same-tier seats (fixes V8.42 bug: the old
    ///      measure was MatA+MatB occupancy vs 381 — live seats max out at 254,
    ///      so expansion mode could NEVER fire and pair .2 sat empty). New
    ///      measure: the pair's CUMULATIVE entries (totalRegistered). Loop back
    ///      to the same pair while < pairExpansionThreshold (127×3 = 381);
    ///      overflow to pairIndex+1 once saturated.
    function _sameTierTarget(address matrixB, uint8 tierIndex) internal view returns (uint256) {
        uint256 srcPairIndex = IFigureEightMatrixV8(matrixB).pairIndex();
        (, , , uint256 pairEntries) = IPairManagerV8(tierPairManagers[tierIndex]).pairs(srcPairIndex);
        return pairEntries >= pairExpansionThreshold ? srcPairIndex + 1 : srcPairIndex;
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
        require(
            msg.sender == matrixKeeper || msg.sender == owner(),
            "TR: not keeper"
        );
        require(state <= 2, "TR: invalid deflation state");
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
        require(tierIndex < MAX_TIERS, "TR: invalid tier");
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
