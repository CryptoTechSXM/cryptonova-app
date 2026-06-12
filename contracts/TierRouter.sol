// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  TierRouter
 * @notice V8.1 "Elevator" — central hub that routes members across 7 tiers.
 *
 * V8.1 ADDITIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Three member toggles (setMemberOptions)
 *       autoUpgrade   — default ON. After autoUpgradeCycleThreshold cycles,
 *                       member can disable to stay at current tier.
 *       autoReentry   — default OFF. If ON and upgrade doesn't fire, member
 *                       re-enters same tier automatically. If OFF, member parks
 *                       and accumulates earnings until they manually re-enter.
 *       doubleReentry — default OFF. If ON and surplus covers a second fee,
 *                       fires a second registration on cycle-out.
 *
 *  2. Cycle thresholds (DAO-votable, enumerated)
 *       autoUpgradeCycleThreshold: 1/3/5/10 (default 5)
 *         Below threshold: autoUpgrade always fires (escrow floor still applies).
 *         At/above threshold: respects member's autoUpgrade toggle.
 *       reentryMinCycles: 1/2/3/5 (default 2)
 *         autoReentry and doubleReentry only available after this many cycles.
 *
 *  3. Escrow floor guard
 *       autoUpgrade only fires if escrow >= nextFee * escrowFloorMultiplier / 100.
 *       Default multiplier: 120 (1.2×). DAO-votable: 110, 120, 150, 200.
 *       In early phase (cycles < threshold): escrow floor check is skipped.
 *
 *  4. Velocity gate (keeper-maintained)
 *       tierVelocityGreen[tier] — set by MatrixKeeper (Chainlink Automation).
 *       If false for a destination tier, autoUpgrade defers (routes to re-entry).
 *       Default: true. Keeper sets false when 7-day rolling velocity drops below
 *       the tier's slowModeThreshold. Resets to true on velocity recovery.
 *
 *  5. MemberParked event
 *       Emitted when a member cycles out and no registration fires. Keeper
 *       monitors this and can fund ghost entries via StabilityFund if needed.
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
}

interface IPairManagerV8 {
    function registerDirectFor(address member, address referrer) external;
    function registerFor(address member, address referrer) external;
    function entryFee() external view returns (uint256);
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

    // ─── V8.1: Velocity gate (keeper-maintained per tier) ─────────────────────
    /// @notice true = destination tier has healthy velocity, OK to route upgrades.
    ///         false = tier is slow, defer upgrades to re-entry.
    ///         Default: true. MatrixKeeper sets false on slowdown, resets on recovery.
    mapping(uint8 => bool) public tierVelocityGreen;

    // ─── V8.1: DAO-votable parameters (enumerated menus only) ────────────────
    /// @notice Minimum cycles at current tier before autoUpgrade fires.
    ///         Below threshold: autoUpgrade fires regardless of toggle.
    ///         Default 5. Allowed: 1, 3, 5, 10.
    uint256 public autoUpgradeCycleThreshold = 5;

    /// @notice Minimum cycles before autoReentry and doubleReentry toggles activate.
    ///         Default 2. Allowed: 1, 2, 3, 5.
    uint256 public reentryMinCycles = 2;

    /// @notice Escrow must be >= nextFee * multiplier / 100 for autoUpgrade to fire.
    ///         Ensures members have enough escrow buffer before upgrading.
    ///         Default 120 (1.2x). Allowed: 110, 120, 150, 200.
    ///         In early phase (cycles < threshold): floor check is skipped.
    uint256 public escrowFloorMultiplier = 120;

    // ─── Whale Gate ───────────────────────────────────────────────────────────
    uint256 public t5FirstEntries;
    bool    public whaleGateActive;
    uint256 public whaleGateThreshold = 25;

    // ─── Inactivity Pause (dual-guard) ────────────────────────────────────────
    bool    public systemPaused;
    bool    public inactivityGuardEnabled    = true;
    uint256 public inactivityDaysThreshold   = 30;
    uint256 public inactivityCyclesThreshold = 2;

    uint256 public lastActivityTimestamp;
    uint256 public totalSystemCycles;
    uint256 public cyclesAtLastRegistration;

    // ─── Deflation state (set by MatrixKeeper) ────────────────────────────────
    /// @notice 0=NORMAL 1=SLOW 2=RECOVERY — maintained by MatrixKeeper via Chainlink
    uint8 public deflationState;

    // ─── Entry tracking for keeper velocity queries (capped circular log) ─────
    uint256 public constant MAX_ENTRY_LOG = 200;
    uint256[] private _sysEntryTimes;
    mapping(uint8 => uint256[]) private _tierEntryTimes;

    // ─── Events ───────────────────────────────────────────────────────────────
    event MemberRegistered(address indexed member, uint8 tier, address referrer);
    event MemberUpgraded(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee);
    event ManualUpgrade(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee);
    event MemberReentered(address indexed member, uint8 tier);
    event DoubleEntryFired(address indexed member, uint8 primaryTier, uint8 secondaryTier);
    event WhaleGateActivated(uint256 t5Count);
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
    event EscrowFloorMultiplierSet(uint256 multiplier);
    event MatrixKeeperSet(address indexed keeper);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _admin) Ownable(_admin) {
        require(_usdc != address(0), "TR: zero usdc");
        usdc = IERC20(_usdc);
        lastActivityTimestamp = block.timestamp;

        // Default velocity gates: all tiers green at launch
        for (uint8 i = 0; i < MAX_TIERS; i++) {
            tierVelocityGreen[i] = true;
        }
    }

    // ─── Modifier ─────────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        require(!systemPaused, "TR: system paused - inactivity");
        _;
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

    function registerMatrix(address matrix, uint8 tierIndex) external onlyOwner {
        require(matrix != address(0),  "TR: zero matrix");
        require(tierIndex < MAX_TIERS, "TR: invalid tier");
        authorizedMatrices[matrix] = true;
        matrixTierIndex[matrix]    = tierIndex;
        emit MatrixRegistered(matrix, tierIndex);
    }

    function deregisterMatrix(address matrix) external onlyOwner {
        authorizedMatrices[matrix] = false;
    }

    function setWhaleGateThreshold(uint256 threshold) external onlyOwner {
        require(threshold > 0, "TR: zero threshold");
        whaleGateThreshold = threshold;
    }

    /// @notice V8.1: Set the MatrixKeeper address (Chainlink Automation).
    function setMatrixKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "TR: zero keeper");
        matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    // ─── V8.1: Velocity gate (keeper-only) ───────────────────────────────────

    /**
     * @notice MatrixKeeper sets velocity gate for a tier.
     *         green=true:  velocity healthy, autoUpgrade routes to this tier.
     *         green=false: tier is slow, autoUpgrade defers (member re-enters current).
     *
     *         This creates the 4-state deflation system:
     *           Growth/Normal → all tiers green
     *           Slow          → upper tiers yellow/red, lower tiers green
     *           Deflation     → most tiers red, only T1 green
     */
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

    /**
     * @notice Set minimum cycles before autoUpgrade fires.
     *         Allowed: 1, 3, 5, 10. Default: 5.
     *         Below threshold: autoUpgrade always fires (toggle ignored).
     *         At/above threshold: respects member's autoUpgradeDisabled toggle.
     */
    function setAutoUpgradeCycleThreshold(uint256 threshold) external onlyOwner {
        require(
            threshold == 1 || threshold == 3 || threshold == 5 || threshold == 10,
            "TR: invalid threshold (allowed: 1,3,5,10)"
        );
        autoUpgradeCycleThreshold = threshold;
        emit AutoUpgradeThresholdSet(threshold);
    }

    /**
     * @notice Set minimum cycles before autoReentry and doubleReentry activate.
     *         Allowed: 1, 2, 3, 5. Default: 2.
     */
    function setReentryMinCycles(uint256 minCycles) external onlyOwner {
        require(
            minCycles == 1 || minCycles == 2 || minCycles == 3 || minCycles == 5,
            "TR: invalid minCycles (allowed: 1,2,3,5)"
        );
        reentryMinCycles = minCycles;
        emit ReentryMinCyclesSet(minCycles);
    }

    /**
     * @notice Set escrow floor multiplier for autoUpgrade guard.
     *         Allowed: 110, 120, 150, 200 (= 1.1x, 1.2x, 1.5x, 2.0x). Default: 120.
     *         autoUpgrade fires only if escrow >= nextFee * multiplier / 100.
     */
    function setEscrowFloorMultiplier(uint256 multiplier) external onlyOwner {
        require(
            multiplier == 110 || multiplier == 120 || multiplier == 150 || multiplier == 200,
            "TR: invalid multiplier (allowed: 110,120,150,200)"
        );
        escrowFloorMultiplier = multiplier;
        emit EscrowFloorMultiplierSet(multiplier);
    }

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
        systemPaused             = false;
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        emit SystemResumed(msg.sender);
    }

    // ─── Member-facing ────────────────────────────────────────────────────────

    function register(address referrer) external whenNotPaused {
        require(!globalJoined[msg.sender],         "TR: already joined");
        require(tierPairManagers[0] != address(0), "TR: T1 not configured");

        address resolved = (referrer != address(0) && globalJoined[referrer])
            ? referrer : address(0);

        memberReferrer[msg.sender]    = resolved;
        globalJoined[msg.sender]      = true;
        memberHighestTier[msg.sender] = 1;

        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;

        IPairManagerV8(tierPairManagers[0]).registerDirectFor(msg.sender, resolved);

        _checkT5FirstEntry(msg.sender, 1);
        _recordEntry(0);
        emit MemberRegistered(msg.sender, 1, resolved);
    }

    /**
     * @notice V8.1: Configure cycle-out behavior in one call.
     *         Member may call any time. Settings take effect on the NEXT cycle-out.
     *
     * @param disableUpgrade  true = don't auto-upgrade after threshold cycles.
     *                        ONLY takes effect once tierCycles >= autoUpgradeCycleThreshold.
     *                        Before threshold, autoUpgrade always fires regardless.
     * @param enableReentry   true = auto-reenter same tier if upgrade doesn't fire.
     *                        Requires tierCycles >= reentryMinCycles to activate.
     * @param enableDouble    true = fire a second registration if surplus covers fee.
     *                        Requires tierCycles >= reentryMinCycles to activate.
     *
     * Note: these settings are per-member (not per-tier). A member at T3 who sets
     * disableUpgrade=true will also not auto-upgrade when they later reach T4, T5, etc.
     * They can call setMemberOptions() again at any time to change preferences.
     */
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

    /**
     * @notice Voluntarily upgrade to a higher tier by paying directly from wallet.
     *         Pre-condition: approve THIS contract for the entry fee before calling.
     *
     * Eligibility:
     *   1. Must have completed >= 1 cycle at tierIndex-1
     *   2. Must NOT be seated in previous tier's MatB (imminent cycle-out)
     *   3. Must NOT already be seated in target tier's MatA
     */
    function manualUpgrade(uint8 targetTierIndex) external whenNotPaused {
        require(globalJoined[msg.sender],                           "TR: not registered");
        require(targetTierIndex > 0 && targetTierIndex < MAX_TIERS, "TR: invalid tier");
        require(tierPairManagers[targetTierIndex] != address(0),    "TR: tier not deployed");

        uint8 prevIndex = targetTierIndex - 1;
        require(
            tierCycles[msg.sender][prevIndex] >= 1,
            "TR: complete 1 cycle in current tier first"
        );

        address prevMatB = tierMatrixBAddr[prevIndex];
        if (prevMatB != address(0)) {
            require(
                !IFigureEightMatrixV8(prevMatB).isActiveInMatrix(msg.sender),
                "TR: seated in MatB, wait for cycle-out first"
            );
        }

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
        IPairManagerV8(tierPairManagers[targetTierIndex]).registerFor(msg.sender, referrer);

        uint8 targetTierNum = targetTierIndex + 1;
        if (targetTierNum > memberHighestTier[msg.sender]) {
            memberHighestTier[msg.sender] = targetTierNum;
        }
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        _checkT5FirstEntry(msg.sender, targetTierNum);
        _recordEntry(targetTierIndex);

        emit ManualUpgrade(msg.sender, prevIndex + 1, targetTierNum, fee);
    }

    // ─── Matrix B cycle-out callback ──────────────────────────────────────────

    /**
     * @notice Called by Matrix B when root cycles out (full figure-8 complete).
     *
     *         V8.1 priority order:
     *           1. autoUpgrade  -- if enabled AND cycles >= threshold AND escrow >= floor
     *                             AND velocity green AND destination clear
     *           2. autoReentry / default re-entry -- if enabled or early phase
     *           3. park -- emit MemberParked. Keeper monitors, may fund ghost entry.
     *
     *         Stack note: heavy lifting delegated to _executeAndDouble() to stay
     *         within the EVM 16-slot accessible stack limit.
     */
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

        // -- 2. Resolve destination with all V8.1 guards ----------------------
        (uint8 destTierIndex, uint256 primaryFee, bool isUpgrade) =
            _resolveDest(member, tierIndex, escrow, withdrawable, cycles);

        // -- 3. Guard: park if neither upgrade nor re-entry fires --------------
        if (!isUpgrade && !_shouldFireReentry(member, cycles, escrow + withdrawable, tierEntryFees[tierIndex])) {
            emit MemberParked(member, tierIndex + 1, "autoReentry disabled");
            return;
        }

        // -- 4. Execute: deduct + register + optional double ------------------
        _executeAndDouble(matrixB, member, tierIndex, destTierIndex, primaryFee, isUpgrade, escrow, withdrawable, cycles);
    }

    // --- Internal: Routing Helpers -------------------------------------------

    /**
     * @dev V8.1 _resolveDest -- determines upgrade destination with all guards.
     *
     *      Guards (in order):
     *        a. T10 apex loop guard
     *        b. autoUpgrade toggle (ignored if earlyPhase = cycles < threshold)
     *        c. Whale Gate (T4 -> T6 skip when active)
     *        d. Destination tier deployed
     *        e. Funds check (escrow + withdrawable >= nextFee)
     *        f. Escrow floor (skipped in early phase)
     *        g. Velocity gate (keeper-maintained)
     *        h. Manual-upgrade guard (member already in dest MatA)
     *
     *      Returns current-tier re-entry if any guard fails.
     */
    function _resolveDest(
        address member,
        uint8   tierIndex,
        uint256 escrow,
        uint256 withdrawable,
        uint256 cycles
    ) internal view returns (uint8 destTierIndex, uint256 primaryFee, bool isUpgrade) {
        destTierIndex = tierIndex;
        primaryFee    = tierEntryFees[tierIndex];

        // Guard a: T10 always loops
        if (tierIndex >= 9) return (destTierIndex, primaryFee, false);

        // Guard b: autoUpgrade toggle (only respected after threshold cycles)
        bool earlyPhase = cycles < autoUpgradeCycleThreshold;
        if (!earlyPhase && memberOptions[member].autoUpgradeDisabled) {
            return (destTierIndex, primaryFee, false);
        }

        // Guard c: Whale Gate (T4 -> T6 skip)
        uint8 nextIndex = tierIndex + 1;
        if (whaleGateActive && tierIndex == 3) {
            uint256 t6Fee = tierEntryFees[5];
            if (tierPairManagers[5] != address(0) && escrow + withdrawable >= t6Fee) {
                nextIndex = 5;
            }
        }

        // Guard d: destination tier deployed
        if (tierPairManagers[nextIndex] == address(0)) return (destTierIndex, primaryFee, false);

        uint256 nextFee = tierEntryFees[nextIndex];

        // Guard e: funds sufficient
        if (escrow + withdrawable < nextFee) return (destTierIndex, primaryFee, false);

        // Guard f: escrow floor (skipped in early phase for bootstrap ease)
        if (!earlyPhase) {
            uint256 floor = nextFee * escrowFloorMultiplier / 100;
            if (escrow < floor) return (destTierIndex, primaryFee, false);
        }

        // Guard g: velocity gate
        if (!tierVelocityGreen[nextIndex]) return (destTierIndex, primaryFee, false);

        // Guard h: manual-upgrade guard
        address dMatA = tierMatrixAAddr[nextIndex];
        if (dMatA != address(0) && IFigureEightMatrixV8(dMatA).isActiveInMatrix(member)) {
            return (destTierIndex, primaryFee, false);
        }

        return (nextIndex, nextFee, true);
    }

    /**
     * @dev V8.1: Determine if re-entry fires when upgrade didn't.
     *
     *      Fires if funds sufficient AND one of:
     *        - member hasn't configured options (V8 compat), OR
     *        - still in early cycles (< reentryMinCycles), OR
     *        - member explicitly enabled autoReentry.
     *
     *      If member has configured options, is past minimum cycles, and
     *      autoReentry=OFF (default): returns false. Member parks.
     */
    function _shouldFireReentry(
        address member,
        uint256 cycles,
        uint256 totalFunds,
        uint256 fee
    ) internal view returns (bool) {
        if (totalFunds < fee) return false;
        MemberOptions storage opts = memberOptions[member];
        if (!opts.optionsSet || cycles < reentryMinCycles) return true;
        return opts.autoReentryEnabled;
    }

    /**
     * @dev Execute deduction + primary registration + optional double reentry.
     *      Extracted from handleCycleOut to avoid EVM stack depth limits.
     */
    function _executeAndDouble(
        address matrixB,
        address member,
        uint8   tierIndex,
        uint8   destTierIndex,
        uint256 primaryFee,
        bool    isUpgrade,
        uint256 escrow,
        uint256 withdrawable,
        uint256 cycles
    ) internal {
        address referrer = memberReferrer[member];

        // Deduct from matrix (scoped to free fe/fw from stack)
        uint256 remEscrow;
        uint256 remWithdrawable;
        {
            (uint256 fe, uint256 fw) = _computeSplit(escrow, withdrawable, primaryFee);
            remEscrow       = escrow      - fe;
            remWithdrawable = withdrawable - fw;
            IFigureEightMatrixV8(matrixB).deductForUpgrade(member, fe, fw);
        }

        // Register at destination tier
        usdc.forceApprove(tierPairManagers[destTierIndex], primaryFee);
        IPairManagerV8(tierPairManagers[destTierIndex]).registerFor(member, referrer);

        // Bookkeeping + events
        _recordEntry(destTierIndex);
        if (isUpgrade) {
            uint8 destTierNum = destTierIndex + 1;
            if (destTierNum > memberHighestTier[member]) memberHighestTier[member] = destTierNum;
            _checkT5FirstEntry(member, destTierNum);
            emit MemberUpgraded(member, tierIndex + 1, destTierNum, primaryFee);
        } else {
            emit MemberReentered(member, tierIndex + 1);
        }

        // Double reentry (honor legacy doubleEntryEnabled too)
        bool doubleOn = memberOptions[member].optionsSet
            ? memberOptions[member].doubleReentryEnabled
            : doubleEntryEnabled[member];

        if (doubleOn && cycles >= reentryMinCycles) {
            _handleDoubleEntry(
                matrixB, member, tierIndex, destTierIndex,
                isUpgrade, remEscrow, remWithdrawable, referrer
            );
        }
    }

    /**
     * @dev Fire the optional second entry (Double Reentry).
     *      Upgraded  -> second slot in OLD tier (member keeps a foot there).
     *      Re-entered -> second slot in SAME tier (two BFS seats).
     */
    function _handleDoubleEntry(
        address matrixB,
        address member,
        uint8   tierIndex,
        uint8   destTierIndex,
        bool    isUpgrade,
        uint256 remEscrow,
        uint256 remWithdrawable,
        address referrer
    ) internal {
        uint8   secIndex = isUpgrade ? tierIndex : destTierIndex;
        uint256 secFee   = tierEntryFees[secIndex];

        if (remEscrow + remWithdrawable < secFee)     return;
        if (tierPairManagers[secIndex] == address(0)) return;

        (uint256 esc2, uint256 earn2) = _computeSplit(remEscrow, remWithdrawable, secFee);
        if (esc2 + earn2 != secFee) return;   // rounding guard

        IFigureEightMatrixV8(matrixB).deductForUpgrade(member, esc2, earn2);
        address secPM = tierPairManagers[secIndex];
        usdc.forceApprove(secPM, secFee);
        IPairManagerV8(secPM).registerFor(member, referrer);
        emit DoubleEntryFired(member, destTierIndex + 1, secIndex + 1);
    }

    /**
     * @notice Escrow-first split.
     *         In V8.1, primary upgrade fuel is withdrawable earnings (escrow is
     *         small, funded only by orphan routing). Escrow is still used first
     *         as an upgrade buffer, then withdrawable fills the remainder.
     */
    function _computeSplit(
        uint256 escrow,
        uint256 /* withdrawable */,
        uint256 needed
    ) internal pure returns (uint256 fromEscrow, uint256 fromWithdrawable) {
        if (escrow >= needed) {
            fromEscrow       = needed;
            fromWithdrawable = 0;
        } else {
            fromEscrow       = escrow;
            fromWithdrawable = needed - escrow;
        }
    }

    function _checkT5FirstEntry(address member, uint8 tierNum) internal {
        if (tierNum == 5 && !whaleGateActive) {
            if (memberHighestTier[member] < 5) {
                t5FirstEntries += 1;
                if (t5FirstEntries >= whaleGateThreshold) {
                    whaleGateActive = true;
                    emit WhaleGateActivated(t5FirstEntries);
                }
            }
        }
    }

    // ─── Entry tracking helper ───────────────────────────────────────────────

    /// @dev Append current timestamp to per-tier and system entry logs.
    ///      Uses a simple append-only array capped at MAX_ENTRY_LOG.
    ///      Oldest entries remain visible for velocity window queries.
    ///      When full, we overwrite from the start (ring buffer).
    function _recordEntry(uint8 tierIdx) internal {
        if (_sysEntryTimes.length < MAX_ENTRY_LOG) {
            _sysEntryTimes.push(block.timestamp);
        } else {
            // Ring: overwrite oldest slot (index 0 = oldest, shift up)
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

    // ─── Keeper interface (ITierRouterKeeper) ─────────────────────────────────

    /**
     * @notice MatrixKeeper sets deflation state after velocity checks.
     *         state: 0=NORMAL 1=SLOW 2=RECOVERY
     *         Also callable by owner for manual override.
     */
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

    /**
     * @notice Count system-wide entries since fromTimestamp.
     *         Called by MatrixKeeper velocity check. O(MAX_ENTRY_LOG).
     */
    function getSystemEntryCount(uint256 fromTimestamp) external view returns (uint256) {
        uint256 cnt = 0;
        uint256 len = _sysEntryTimes.length;
        for (uint256 i = 0; i < len; i++) {
            if (_sysEntryTimes[i] >= fromTimestamp) cnt++;
        }
        return cnt;
    }

    /**
     * @notice Count per-tier entries since fromTimestamp.
     *         Called by MatrixKeeper velocity check. O(MAX_ENTRY_LOG).
     */
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
        whaleGateEligible  = whaleGateActive && highestTier == 4;
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

}
