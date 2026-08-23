// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CommunityWallet
 * @notice First-1000 Members Lifetime Rewards Pool
 *
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Accumulates USDC from two sources:
 *    1. Orphan fees from FigureEightMatrixV8 (_forwardToCommunityPool)
 *    2. 1% carve from StabilityFund L1 deposits (per-entry SF contribution)
 *
 *  Distributes to the first 1,000 registered members on a monthly schedule.
 *  50% of the pool distributes each month; 50% rolls over (compounds).
 *  Members have one distribution window (30 days) to claim; unclaimed
 *  shares return to pool at the next distribution.
 *
 * COHORTS
 * ─────────────────────────────────────────────────────────────────────────────
 *  Genesis (#1–#500)  — 60% of each distribution (DAO-adjustable)
 *  Pioneer (#501–#1000) — 40% of each distribution (DAO-adjustable)
 *  Each member within a cohort receives an equal share.
 *
 * CAP RULE (one slot per Ethereum address)
 * ─────────────────────────────────────────────────────────────────────────────
 *  If the same wallet address registers multiple matrix positions (re-entries,
 *  double-entry, or any other path), it receives exactly ONE enrollment slot.
 *  enroll() is a no-op for already-enrolled addresses. This prevents Sybil
 *  attacks where one party fills multiple Genesis slots with the same identity.
 *  Each wallet = one cohort slot, regardless of matrix activity.
 *
 * INTEGRATION POINTS
 * ─────────────────────────────────────────────────────────────────────────────
 *  TierRouter.register()       → if globalJoined count <= 1000: enroll(member)
 *  FigureEightMatrixV8         → deposit(amount) from _forwardToCommunityPool
 *  StabilityFund.receiveLayer  → deposit(amount) from 1% L1 carve
 *  MatrixKeeper.checkUpkeep    → add distributeReady() to the keeper work queue
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CommunityWallet is Ownable2Step, AccessControl {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Roles
    // =========================================================================

    bytes32 public constant ENROLLOR_ROLE  = keccak256("ENROLLOR_ROLE");   // TierRouter
    bytes32 public constant GOVERNOR_ROLE  = keccak256("GOVERNOR_ROLE");   // V8Governance

    // =========================================================================
    // Constants
    // =========================================================================

    uint256 public constant COHORT_SIZE     = 500;
    uint256 public constant MAX_MEMBERS     = 1_000;
    uint256 public constant BPS_DENOM       = 10_000;

    uint8 public constant COHORT_NONE    = 0;
    uint8 public constant COHORT_GENESIS = 1;
    uint8 public constant COHORT_PIONEER = 2;

    // =========================================================================
    // Config (DAO-adjustable via GOVERNOR_ROLE)
    // =========================================================================

    uint256 public genesisBps         = 6_000;   // 60% to Genesis cohort
    uint256 public pioneerBps         = 4_000;   // 40% to Pioneer cohort
    uint256 public distributeRatioBps = 5_000;   // 50% distributes, 50% rolls over
    /// @notice V8.48 — DISTRIBUTION IS A CALENDAR DATE, NOT AN INTERVAL (owner, 2026-08-10).
    ///
    ///         Was `distributeInterval = 30 days`, a ROLLING window from the last
    ///         distribution. That drifts: 4 Sep, ~4 Oct, ~3 Nov — never landing on a fixed
    ///         day, sliding ~5 days a year. It is also hard to tell a community: "roughly
    ///         every 30 days, check the site" versus "the 25th of every month".
    ///
    ///         Range is capped at 28 so the date exists in February. Anything above 28
    ///         would silently skip months.
    uint8 public distributionDayOfMonth = 25;

    /// @notice Monotonic year*12 + month of the last distribution. Guarantees AT MOST ONE
    ///         distribution per calendar month, independent of how long the month is —
    ///         which a day-count check alone cannot do (the 25th and the 31st are both
    ///         ">= 25", and without this a second distribution could fire six days later).
    uint256 public lastDistributionMonth;

    /// @dev V8.48 testnet-only bypass for forceDistribute(). Before the calendar change
    ///      forceDistribute() worked by zeroing lastDistributionTime, because that was
    ///      what distribute() gated on. distribute() now gates on the calendar instead,
    ///      so that reset became a no-op and forceDistribute() reverted on any day before
    ///      the 25th -- silently, since no test covered it. This flag is the explicit
    ///      bypass; it is set and cleared within a single admin call and is never true
    ///      between transactions.
    bool private _forcing;

    // =========================================================================
    // Member registry
    // =========================================================================

    mapping(address => uint8)   public cohort;          // 0=none, 1=genesis, 2=pioneer
    address[]                   public genesisMembers;  // max 500
    address[]                   public pioneerMembers;  // max 500
    uint256                     public totalEnrolled;   // 0–1000

    // =========================================================================
    // Distribution state
    // =========================================================================

    struct Distribution {
        uint256 perGenesis;   // USDC per genesis member this round
        uint256 perPioneer;   // USDC per pioneer member this round
        uint256 totalAmount;  // total USDC put in play this round
        uint256 expiresAt;    // members must claim before this timestamp
        uint256 totalClaimed; // how much has been claimed so far
    }

    Distribution[] public distributions;
    uint256 public lastDistributionTime;
    uint256 public lastSweptDistId;   // all distributions before this index are swept

    // Per-member claim tracking
    mapping(address => uint256) public lastClaimedDistId;
    mapping(address => bool)    public hasClaimed;

    // Live pending USDC owed to members (used to isolate rolling pool)
    uint256 public totalActivePending;

    // Lifetime stats
    mapping(address => uint256) public lifetimeClaimed;
    uint256                     public totalLifetimeClaimed;

    // =========================================================================
    // USDC
    // =========================================================================

    IERC20 public immutable usdc;

    // =========================================================================
    // Events
    // =========================================================================

    event MemberEnrolled(address indexed member, uint8 cohort, uint256 enrollmentNumber);
    event Deposited(uint256 amount, address indexed from);
    event DistributionExecuted(
        uint256 indexed distId,
        uint256 totalAmount,
        uint256 perGenesis,
        uint256 perPioneer,
        uint256 genesisCount,
        uint256 pioneerCount
    );
    event Claimed(address indexed member, uint256 indexed distCount, uint256 amount);
    event ExpiredSwept(uint256 indexed distId, uint256 unclaimedReturned);
    event GenesisBpsSet(uint256 bps);
    event DistributeRatioSet(uint256 bps);
    event DistributionDayOfMonthSet(uint8 day);

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address _usdc, address _admin) Ownable(_admin) {
        require(_usdc  != address(0), "CW: zero usdc");
        require(_admin != address(0), "CW: zero admin");
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNOR_ROLE,      _admin);
    }

    // =========================================================================
    // Admin setup
    // =========================================================================

    /// @notice Authorize TierRouter to call enroll().
    function setEnrollor(address enrollor) external onlyOwner {
        require(enrollor != address(0), "CW: zero enrollor");
        _grantRole(ENROLLOR_ROLE, enrollor);
    }

    // =========================================================================
    // Enrollment
    // =========================================================================

    /**
     * @notice Register a member in the first-1000 cohort.
     *
     *         CAP RULE: one slot per Ethereum address regardless of matrix
     *         re-entries or double-entry positions. If msg.sender is already
     *         enrolled this is a no-op.
     *
     *         Called by TierRouter.register() while totalEnrolled < MAX_MEMBERS.
     *         Safe to call after the cohorts are full — returns silently.
     */
    function enroll(address member) external onlyRole(ENROLLOR_ROLE) {
        if (cohort[member] != COHORT_NONE) return; // already enrolled — cap rule
        if (totalEnrolled >= MAX_MEMBERS)   return; // cohorts full

        totalEnrolled += 1;
        uint8 c;

        if (totalEnrolled <= COHORT_SIZE) {
            genesisMembers.push(member);
            c = COHORT_GENESIS;
        } else {
            pioneerMembers.push(member);
            c = COHORT_PIONEER;
        }

        cohort[member] = c;
        emit MemberEnrolled(member, c, totalEnrolled);
    }

    /**
     * @notice Batch-enroll members (owner only).
     *         Used for migration, seeding, or recovery after a redeploy.
     *         Respects the cap rule and MAX_MEMBERS limit.
     */
    function enrollBatch(address[] calldata members) external onlyOwner {
        for (uint256 i = 0; i < members.length; i++) {
            address m = members[i];
            if (cohort[m] != COHORT_NONE) continue;
            if (totalEnrolled >= MAX_MEMBERS) break;

            totalEnrolled += 1;
            uint8 c;
            if (totalEnrolled <= COHORT_SIZE) {
                genesisMembers.push(m);
                c = COHORT_GENESIS;
            } else {
                pioneerMembers.push(m);
                c = COHORT_PIONEER;
            }
            cohort[m] = c;
            emit MemberEnrolled(m, c, totalEnrolled);
        }
    }

    // =========================================================================
    // Funding
    // =========================================================================

    /**
     * @notice Accept a USDC deposit. Pull model — caller must approve first.
     *
     *         Callers:
     *           FigureEightMatrixV8: forceApprove → deposit() from orphan fees
     *           StabilityFund:       forceApprove → deposit() from 1% L1 carve
     *           Owner / anyone:      direct seed or top-up
     *
     * @dev    Deposited USDC enters the rolling pool and is included in the
     *         next distribute() call.
     */
    function deposit(uint256 amount) external {
        require(amount > 0, "CW: zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(amount, msg.sender);
    }

    // =========================================================================
    // Distribution
    // =========================================================================

    /**
     * @notice Execute a monthly distribution.
     *
     *         Callable by anyone on or after distributionDayOfMonth, once per month.
     *         Designed to be driven by our own keeper's work queue — add
     *         `distributeReady()` to MatrixKeeper's checkUpkeep condition.
     *
     *         Steps:
     *           1. Sweep expired prior distributions (unclaimed → pool)
     *           2. Compute pool = USDC balance - current pending claims
     *           3. Distribute distributeRatioBps% of pool to enrolled members
     *           4. Record expiry window (the NEXT monthly distribution date)
     */
    function distribute() external {
        // V8.48: calendar gate + claim-window end, computed together (see _gateAndExpiry).
        (uint256 _monthIdx, uint256 _expiresAt) = _gateAndExpiry();
        require(totalEnrolled > 0, "CW: no members enrolled");

        // Step 1 — sweep expired
        _sweepExpired();

        // Step 2 — compute available pool
        uint256 balance   = usdc.balanceOf(address(this));
        uint256 available = balance > totalActivePending
            ? balance - totalActivePending : 0;

        lastDistributionTime  = block.timestamp;
        lastDistributionMonth = _monthIdx;
        if (available == 0) return; // nothing to distribute; time still advances

        uint256 toDistribute = (available * distributeRatioBps) / BPS_DENOM;
        if (toDistribute == 0) return;

        // Step 3 — split by cohort
        uint256 gCount = genesisMembers.length;
        uint256 pCount = pioneerMembers.length;

        uint256 genesisTotal = (toDistribute * genesisBps)  / BPS_DENOM;
        uint256 pioneerTotal = toDistribute - genesisTotal;

        // V8.48: divide by COHORT_SIZE, NOT the live member count.
        //
        // Dividing by the live count made a PARTIALLY FILLED cohort's members richer,
        // because that cohort's entire share was split among fewer people. Measured
        // live 2026-08-09 with Genesis 500 / Pioneer 146, the 60/40 split paid each
        // Pioneer $5.11 against each Genesis member's $2.24 -- 2.3x -- inverting the
        // seniority this wallet exists to reward. The inversion held for ANY Pioneer
        // count below 334 (totalEnrolled below 834), i.e. for the entire ramp.
        //
        // With a FIXED divisor a seat's value never depends on how many seats are
        // occupied: Genesis is always genesisBps/COHORT_SIZE and Pioneer always
        // pioneerBps/COHORT_SIZE, so Genesis holds its intended 1.5x at the default
        // 60/40 from the first member to the thousandth. The share belonging to
        // UNOCCUPIED seats is simply not paid out -- it stays in the pool and rolls
        // into the next cycle, so it accrues to members over time instead of being
        // concentrated on whoever happens to have enrolled early in a cohort.
        //
        // Future-proofing: this holds for every (gCount, pCount) pair including
        // 0, a full 500, and any mid-ramp value, and it needs no re-tuning of
        // genesisBps as members enrol. Do NOT reintroduce a live-count divisor.
        uint256 perGenesis = genesisTotal / COHORT_SIZE;
        uint256 perPioneer = pioneerTotal / COHORT_SIZE;

        // Actual distributed. Unfilled-seat share AND rounding dust stay in the pool.
        uint256 actualDist = (perGenesis * gCount) + (perPioneer * pCount);
        if (actualDist == 0) return;

        // Step 4 — record
        distributions.push(Distribution({
            perGenesis:   perGenesis,
            perPioneer:   perPioneer,
            totalAmount:  actualDist,
            // V8.48: claimable until the NEXT distribution is due — same calendar that
            // schedules distributions, so there is never a gap where a share has expired
            // but its replacement has not arrived, nor an overlap with two live at once.
            expiresAt:    _expiresAt,
            totalClaimed: 0
        }));
        totalActivePending += actualDist;

        uint256 distId = distributions.length - 1;
        emit DistributionExecuted(distId, actualDist, perGenesis, perPioneer, gCount, pCount);
    }

    // =========================================================================
    // Claims
    // =========================================================================

    /**
     * @notice Claim all available (non-expired) distribution shares.
     *
     *         Members have until the NEXT monthly distribution date to claim each
     *         share (V8.48: the 25th by default). After that the share expires and
     *         returns to the pool on the next _sweepExpired() call — where it is
     *         REDISTRIBUTED to the other members, not taken by the protocol.
     *
     * @return totalAmount  USDC transferred to msg.sender.
     */
    function claim() external returns (uint256 totalAmount) {
        uint8 memberCohort = cohort[msg.sender];
        require(memberCohort != COHORT_NONE, "CW: not enrolled");

        uint256 distCount = distributions.length;
        if (distCount == 0) return 0;

        uint256 startId = (hasClaimed[msg.sender])
            ? lastClaimedDistId[msg.sender] + 1
            : 0;

        for (uint256 i = startId; i < distCount; i++) {
            Distribution storage d = distributions[i];
            if (block.timestamp >= d.expiresAt) continue; // expired
            uint256 share = (memberCohort == COHORT_GENESIS)
                ? d.perGenesis
                : d.perPioneer;
            if (share == 0) continue;
            totalAmount       += share;
            d.totalClaimed    += share;
        }

        if (totalAmount == 0) return 0;

        // Update state before transfer (CEI pattern)
        lastClaimedDistId[msg.sender] = distCount - 1;
        hasClaimed[msg.sender]        = true;
        totalActivePending            = totalActivePending >= totalAmount
                                        ? totalActivePending - totalAmount : 0;
        lifetimeClaimed[msg.sender]  += totalAmount;
        totalLifetimeClaimed         += totalAmount;

        usdc.safeTransfer(msg.sender, totalAmount);
        emit Claimed(msg.sender, distCount - 1, totalAmount);
    }

    // =========================================================================
    // Keeper work-queue helper
    // =========================================================================

    /// @notice Returns true when distribute() is ready to fire.
    ///         Add to MatrixKeeper.checkUpkeep() conditions.
    function distributeReady() external view returns (bool) {
        if (totalEnrolled == 0) return false;
        (uint256 y, uint256 m, uint256 d) = _civil(block.timestamp);
        return d >= distributionDayOfMonth && (y * 12 + m) > lastDistributionMonth;
    }

    // ── Calendar helpers (Howard Hinnant's civil-date algorithms) ────────────
    //
    // Solidity has no date type. These are the standard, well-audited conversions and
    // they are exact for every date after 1970 — no leap-year table, no approximation.
    // Kept internal and pure so they cannot be a source of state drift.

    /// @dev unix timestamp -> (year, month, day) UTC.
    function _civil(uint256 ts) internal pure returns (uint256 y, uint256 m, uint256 d) {
        uint256 z   = ts / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp  = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    }

    /// @dev (year, month, day) UTC -> unix timestamp at 00:00.
    function _fromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        unchecked {
            y -= m <= 2 ? 1 : 0;
            uint256 era = y / 400;
            uint256 yoe = y - era * 400;
            uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
            uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            return (era * 146097 + doe - 719468) * 86400;
        }
    }

    /// @dev Gate + expiry in one call. distribute() is already near the stack limit, so
    ///      the three date parts stay in THIS frame and only two values cross back —
    ///      inlining them blew the stack ("Stack too deep", 2026-08-10).
    function _gateAndExpiry() internal view returns (uint256 monthIdx, uint256 expiresAt) {
        (uint256 y, uint256 m, uint256 d) = _civil(block.timestamp);
        monthIdx = y * 12 + m;
        // BOTH conditions are required: day alone would let a second distribution fire on
        // the 26th; the month check alone would let one fire on the 1st.
        // _forcing is the testnet-only escape hatch (see forceDistribute).
        if (!_forcing) {
            require(d >= distributionDayOfMonth, "CW: before the monthly date");
            require(monthIdx > lastDistributionMonth, "CW: already distributed this month");
        }
        if (m == 12) { y += 1; m = 1; } else { m += 1; }
        expiresAt = _fromCivil(y, m, distributionDayOfMonth);
    }

    /// @notice THE single source of truth for when the next distribution is due.
    ///         The frontend MUST read this rather than recomputing calendar logic —
    ///         a second, independent answer to this question is exactly how "claim on the
    ///         25th" became a belief with no basis in the contract (removed from
    ///         index.html 2026-08-07; it had a `day-of-month >= 25` gate the contract
    ///         never had).
    function nextDistributionTime() public view returns (uint256) {
        (uint256 y, uint256 m, ) = _civil(block.timestamp);
        if (lastDistributionMonth < y * 12 + m) {
            uint256 thisMonth = _fromCivil(y, m, distributionDayOfMonth);
            return block.timestamp < thisMonth ? thisMonth : block.timestamp;
        }
        if (m == 12) { y += 1; m = 1; } else { m += 1; }
        return _fromCivil(y, m, distributionDayOfMonth);
    }

    // =========================================================================
    // View helpers
    // =========================================================================

    /// @notice Claimable USDC for a member (active distributions only).
    function claimable(address member) external view returns (uint256 total) {
        uint8 memberCohort = cohort[member];
        if (memberCohort == COHORT_NONE) return 0;

        uint256 distCount = distributions.length;
        if (distCount == 0) return 0;

        uint256 startId = hasClaimed[member]
            ? lastClaimedDistId[member] + 1
            : 0;

        for (uint256 i = startId; i < distCount; i++) {
            if (block.timestamp >= distributions[i].expiresAt) continue;
            uint256 share = (memberCohort == COHORT_GENESIS)
                ? distributions[i].perGenesis
                : distributions[i].perPioneer;
            total += share;
        }
    }

    /// @notice USDC available for the next distribution.
    function availablePool() external view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        return balance > totalActivePending ? balance - totalActivePending : 0;
    }

    /// @notice Full detail for a distribution record.
    function getDistribution(uint256 distId)
        external view
        returns (Distribution memory)
    {
        require(distId < distributions.length, "CW: invalid distId");
        return distributions[distId];
    }

    function distributionCount() external view returns (uint256) {
        return distributions.length;
    }

    function genesisCount() external view returns (uint256) {
        return genesisMembers.length;
    }

    function pioneerCount() external view returns (uint256) {
        return pioneerMembers.length;
    }

    // =========================================================================
    // Governance setters
    // =========================================================================

    /**
     * @notice Update Genesis/Pioneer split (DAO proposal vote required).
     * @param  bps  Genesis share in BPS. pioneerBps = 10000 - bps.
     *              Range: 5000–9000 (50%–90%).
     */
    function setGenesisBps(uint256 bps) external onlyRole(GOVERNOR_ROLE) {
        require(bps >= 5_000 && bps <= 9_000, "CW: genesis bps out of range");
        genesisBps = bps;
        pioneerBps = BPS_DENOM - bps;
        emit GenesisBpsSet(bps);
    }

    /**
     * @notice Update what fraction of the pool distributes each month.
     *         Range: 10%–90% (prevents either extreme of all-or-nothing).
     */
    function setDistributeRatio(uint256 bps) external onlyRole(GOVERNOR_ROLE) {
        require(bps >= 1_000 && bps <= 9_000, "CW: ratio out of range");
        distributeRatioBps = bps;
        emit DistributeRatioSet(bps);
    }

    /**
     * @notice V8.48: set the calendar day distributions fire on. Capped at 28 so the
     *         date exists in February — a value of 29-31 would silently skip months.
     */
    function setDistributionDayOfMonth(uint8 day) external onlyRole(GOVERNOR_ROLE) {
        require(day >= 1 && day <= 28, "CW: day must be 1-28");
        distributionDayOfMonth = day;
        emit DistributionDayOfMonthSet(day);
    }
    // =========================================================================
    // Testnet helpers (admin only - for QA before mainnet)
    // =========================================================================

    /**
     * @notice Force a distribution immediately, bypassing the calendar gate.
     *         Admin-only, testnet-only. Use to verify the distribute->claim flow
     *         without waiting for the 25th.
     *
     *         lastDistributionMonth is RESTORED afterwards on purpose: a forced run
     *         must not consume the month's real slot, or QA on the 3rd would block the
     *         genuine distribution on the 25th and we would be testing a system that
     *         no longer behaves like the one we ship.
     */
    function forceDistribute() external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Allowlist, never a denylist: Base Sepolia (84532) and the Hardhat/local chain
        // (31337). 31337 is here so the bypass is REACHABLE FROM THE TEST SUITE — this
        // function silently stopped working under the V8.48 calendar change precisely
        // because no test could call it. It can never match a production chain id.
        require(block.chainid == 84532 || block.chainid == 31337, "CW: testnet only");
        uint256 prevMonth = lastDistributionMonth;
        _forcing = true;
        this.distribute();
        _forcing = false;
        lastDistributionMonth = prevMonth;
    }


    // =========================================================================
    // Owner emergency
    // =========================================================================

    /// @notice Emergency USDC recovery (owner only). Use only in extreme cases.
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "CW: zero to");
        usdc.safeTransfer(to, amount);
    }

    // =========================================================================
    // Internal
    // =========================================================================

    /**
     * @dev Sweep expired distributions: deduct their unclaimed amounts from
     *      totalActivePending so those USDC re-enter the rolling pool naturally.
     *      Called at the start of every distribute() execution.
     */
    function _sweepExpired() internal {
        uint256 count = distributions.length;
        for (uint256 i = lastSweptDistId; i < count; i++) {
            Distribution storage d = distributions[i];
            if (block.timestamp < d.expiresAt) break; // not yet expired

            uint256 unclaimed = d.totalAmount > d.totalClaimed
                ? d.totalAmount - d.totalClaimed
                : 0;

            if (unclaimed > 0) {
                totalActivePending = totalActivePending >= unclaimed
                    ? totalActivePending - unclaimed : 0;
                emit ExpiredSwept(i, unclaimed);
            }
            lastSweptDistId = i + 1;
        }
    }

    // =========================================================================
    // AccessControl + Ownable2Step coexistence
    // =========================================================================

    function supportsInterface(bytes4 interfaceId)
        public view override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
