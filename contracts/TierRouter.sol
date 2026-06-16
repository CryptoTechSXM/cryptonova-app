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
    mapping(uint8 => bool) public tierVelocityGreen;

    // ─── V8.1: DAO-votable parameters (enumerated menus only) ────────────────
    uint256 public autoUpgradeCycleThreshold = 5;
    uint256 public reentryMinCycles = 2;
    uint256 public escrowFloorMultiplier = 120;

    // ─── Community Fund ───────────────────────────────────────────────────────
    /// @notice CommunityWallet contract — enrolled at registration.
    ///         Zero address = hook disabled (safe before CommunityWallet is deployed).
    address public communityWallet;

    /// @notice Total unique members ever registered system-wide.
    ///         Increments on every register() call. Used by CommunityWallet eligibility.
    uint256 public globalJoinedCount;

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
    // V8.11 events
    event CommunityWalletSet(address indexed cw);
    event MemberEnrolled(address indexed member, uint256 joinedCount);
    // V8.14: cross-upgrade events
    event UpgradeEligibleAtCross(address indexed member, uint8 fromTierNum, uint8 toTierNum);
    event AutoUpgradedAtCross(address indexed member, uint8 fromTierNum, uint8 toTierNum, uint256 fee);

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

    /// @notice V8.11: Set the CommunityWallet address. Zero address disables the hook.
    function setCommunityWallet(address _cw) external onlyOwner {
        communityWallet = _cw;
        emit CommunityWalletSet(_cw);
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

    function setAutoUpgradeCycleThreshold(uint256 threshold) external onlyOwner {
        require(
            threshold == 1 || threshold == 3 || threshold == 5 || threshold == 10,
            "TR: invalid threshold (allowed: 1,3,5,10)"
        );
        autoUpgradeCycleThreshold = threshold;
        emit AutoUpgradeThresholdSet(threshold);
    }

    function setReentryMinCycles(uint256 minCycles) external onlyOwner {
        require(
            minCycles == 1 || minCycles == 2 || minCycles == 3 || minCycles == 5,
            "TR: invalid minCycles (allowed: 1,2,3,5)"
        );
        reentryMinCycles = minCycles;
        emit ReentryMinCyclesSet(minCycles);
    }

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
        globalJoinedCount            += 1;

        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;

        IPairManagerV8(tierPairManagers[0]).registerDirectFor(msg.sender, resolved);

        // Community Fund enrollment (no-op if communityWallet not yet deployed)
        if (communityWallet != address(0)) {
            ICommunityWallet(communityWallet).enroll(msg.sender);
            emit MemberEnrolled(msg.sender, globalJoinedCount);
        }

        _checkT5FirstEntry(msg.sender, 1);
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

        // V8.14: eligible when (a) completed >=1 cycle OR (b) currently in prev MatB
        address prevMatB = tierMatrixBAddr[prevIndex];
        bool inPrevMatB  = prevMatB != address(0) &&
                           IFigureEightMatrixV8(prevMatB).isActiveInMatrix(msg.sender);
        require(
            tierCycles[msg.sender][prevIndex] >= 1 || inPrevMatB,
            "TR: cross to MatB first to unlock upgrade"
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
        if (!tierVelocityGreen[nextIndex])             return;

        address nextMatA = tierMatrixAAddr[nextIndex];
        if (nextMatA != address(0) &&
            IFigureEightMatrixV8(nextMatA).isActiveInMatrix(member)) return;

        uint8 fromTierNum = tierIndex + 1;
        uint8 toTierNum   = nextIndex + 1;

        emit UpgradeEligibleAtCross(member, fromTierNum, toTierNum);

        if (memberOptions[member].autoUpgradeDisabled) return;

        uint256 fee = tierEntryFees[nextIndex];
        if (usdc.balanceOf(member)                < fee) return;
        if (usdc.allowance(member, address(this)) < fee) return;

        usdc.safeTransferFrom(member, address(this), fee);
        usdc.forceApprove(tierPairManagers[nextIndex], fee);

        address referrer = memberReferrer[member];
        IPairManagerV8(tierPairManagers[nextIndex]).registerFor(member, referrer);

        if (toTierNum > memberHighestTier[member]) {
            memberHighestTier[member] = toTierNum;
        }
        lastActivityTimestamp    = block.timestamp;
        cyclesAtLastRegistration = totalSystemCycles;
        _checkT5FirstEntry(member, toTierNum);
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

        uint256 remEscrow;
        uint256 remWithdrawable;
        {
            (uint256 fe, uint256 fw) = _computeSplit(escrow, withdrawable, primaryFee);
            remEscrow       = escrow      - fe;
            remWithdrawable = withdrawable - fw;
            IFigureEightMatrixV8(matrixB).deductForUpgrade(member, fe, fw);
        }

        usdc.forceApprove(tierPairManagers[destTierIndex], primaryFee);
        IPairManagerV8(tierPairManagers[destTierIndex]).registerFor(member, referrer);

        _recordEntry(destTierIndex);
        if (isUpgrade) {
            uint8 destTierNum = destTierIndex + 1;
            if (destTierNum > memberHighestTier[member]) memberHighestTier[member] = destTierNum;
            _checkT5FirstEntry(member, destTierNum);
            emit MemberUpgraded(member, tierIndex + 1, destTierNum, primaryFee);
        } else {
            emit MemberReentered(member, tierIndex + 1);
        }

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
        if (esc2 + earn2 != secFee) return;

        IFigureEightMatrixV8(matrixB).deductForUpgrade(member, esc2, earn2);
        address secPM = tierPairManagers[secIndex];
        usdc.forceApprove(secPM, secFee);
        IPairManagerV8(secPM).registerFor(member, referrer);
        emit DoubleEntryFired(member, destTierIndex + 1, secIndex + 1);
    }

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
