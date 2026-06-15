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
 *  MatrixKeeper.checkUpkeep    → add distributeReady() check for Chainlink
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
    uint256 public distributeInterval = 30 days; // Chainlink upkeep cadence

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
    event DistributeIntervalSet(uint256 interval);

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
     *         Callable by anyone after distributeInterval has elapsed.
     *         Designed to be called by Chainlink Automation — add
     *         `distributeReady()` to MatrixKeeper's checkUpkeep condition.
     *
     *         Steps:
     *           1. Sweep expired prior distributions (unclaimed → pool)
     *           2. Compute pool = USDC balance - current pending claims
     *           3. Distribute distributeRatioBps% of pool to enrolled members
     *           4. Record expiry window (distributeInterval from now)
     */
    function distribute() external {
        require(
            block.timestamp >= lastDistributionTime + distributeInterval,
            "CW: too soon"
        );
        require(totalEnrolled > 0, "CW: no members enrolled");

        // Step 1 — sweep expired
        _sweepExpired();

        // Step 2 — compute available pool
        uint256 balance   = usdc.balanceOf(address(this));
        uint256 available = balance > totalActivePending
            ? balance - totalActivePending : 0;

        lastDistributionTime = block.timestamp;
        if (available == 0) return; // nothing to distribute; time still advances

        uint256 toDistribute = (available * distributeRatioBps) / BPS_DENOM;
        if (toDistribute == 0) return;

        // Step 3 — split by cohort
        uint256 gCount = genesisMembers.length;
        uint256 pCount = pioneerMembers.length;

        uint256 genesisTotal = (toDistribute * genesisBps)  / BPS_DENOM;
        uint256 pioneerTotal = toDistribute - genesisTotal;

        uint256 perGenesis = gCount > 0 ? genesisTotal / gCount : 0;
        uint256 perPioneer = pCount > 0 ? pioneerTotal / pCount : 0;

        // Actual distributed (rounding dust stays in pool)
        uint256 actualDist = (perGenesis * gCount) + (perPioneer * pCount);
        if (actualDist == 0) return;

        // Step 4 — record
        distributions.push(Distribution({
            perGenesis:   perGenesis,
            perPioneer:   perPioneer,
            totalAmount:  actualDist,
            expiresAt:    block.timestamp + distributeInterval,
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
     *         Members have distributeInterval (default 30 days) from each
     *         distribution to claim. After that window, the share expires
     *         and returns to the pool on the next _sweepExpired() call.
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
    // Chainlink Automation helper
    // =========================================================================

    /// @notice Returns true when distribute() is ready to fire.
    ///         Add to MatrixKeeper.checkUpkeep() conditions.
    function distributeReady() external view returns (bool) {
        return (
            totalEnrolled > 0 &&
            block.timestamp >= lastDistributionTime + distributeInterval
        );
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
     * @notice Update the distribution interval and claim expiry window.
     *         Range: 7 days–365 days.
     */
    function setDistributeInterval(uint256 interval) external onlyRole(GOVERNOR_ROLE) {
        require(
            interval >= 7 days && interval <= 365 days,
            "CW: interval out of range"
        );
        distributeInterval = interval;
        emit DistributeIntervalSet(interval);
    }
    // =========================================================================
    // Testnet helpers (admin only - for QA before mainnet)
    // =========================================================================

    /**
     * @notice Force a distribution immediately, bypassing the interval guard.
     *         Admin-only. Use on testnet to verify the distribute->claim flow
     *         without waiting 30 days. Should NOT be called on mainnet.
     */
    function forceDistribute() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(block.chainid == 84532, "CW: testnet only");
        lastDistributionTime = 0; // reset so distribute() time check passes
        this.distribute();
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
