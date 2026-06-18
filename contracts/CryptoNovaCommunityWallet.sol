// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CryptoNovaCommunityWallet
 * @notice Founding-member reward pool for the first 2,000 CryptoNova members.
 *
 * POOL MECHANICS
 * ==============
 * Every month the owner calls advanceEpoch() which snapshots the pool:
 *
 *   Total pool
 *     50%  -> Always rolls over to next month (compounds forever)
 *     50%  -> Payout pot for this epoch
 *              70% of payout pot -> Tranche A (once A is fully active)
 *              30% of payout pot -> Tranche B (once B is fully active)
 *              Inactive tranche share rolls over instead of paying out
 *
 * ACTIVATION GATES
 * ================
 *   Tranche A unlocks: when ALL 1,000 Tranche A slots are filled
 *   Tranche B unlocks: when ALL 2,000 slots are filled (both tranches complete)
 *   Before a tranche activates its share of the payout pot rolls over.
 *
 * FOUNDING MEMBER SLOTS
 * =====================
 *   Total slots : 2,000 (auto-assigned in join order)
 *   Tranche A   : Members     1 - 1,000  -> 35 shares each
 *   Tranche B   : Members 1,001 - 2,000  -> 15 shares each
 *
 * CLAIM WINDOW
 * ============
 *   Each epoch has a 30-day claim window from advanceEpoch().
 *   Unclaimed amounts at window close roll back into the pending pool
 *   via rolloverUnclaimed() (owner/keeper callable).
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CryptoNovaCommunityWallet is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---
    uint256 public constant MAX_FOUNDERS      = 20;   // TEST MODE (prod: 2000)
    uint256 public constant TRANCHE_A_MAX     = 10;   // TEST MODE (prod: 1000)
    uint256 public constant TRANCHE_A_SHARES  = 35;
    uint256 public constant TRANCHE_B_SHARES  = 15;
    uint256 public constant CLAIM_WINDOW      = 30 days;
    uint256 public constant MIN_EPOCH_INTERVAL = 25 days;

    // 50/50 split: payout vs rollover
    uint256 public constant PAYOUT_BPS     = 5_000; // 50% of pool is payout pot
    uint256 public constant ROLLOVER_BPS   = 5_000; // 50% always rolls over
    // Of the payout pot: 70% to A, 30% to B
    uint256 public constant TRANCHE_A_BPS  = 7_000;
    uint256 public constant TRANCHE_B_BPS  = 3_000;
    uint256 public constant BPS_DENOM      = 10_000;

    // --- External contracts ---
    IERC20 public immutable usdc;

    // --- Founder registration ---
    uint256 public founderCount;
    uint256 public trancheACount; // how many Tranche A slots filled (max 1,000)
    uint256 public trancheBCount; // how many Tranche B slots filled (max 1,000)

    mapping(address => uint8)   public founderTranche;  // 1=A, 2=B, 0=not a founder
    mapping(address => uint256) public founderId;
    mapping(uint256 => address) public founderById;

    // Activation flags - set once, never reset
    bool public trancheAActive; // true once all 10 A slots filled (TEST)
    bool public trancheBActive; // true once all 20 slots filled (TEST)

    // --- Authorised depositors / registrars ---
    mapping(address => bool) public isAuthorisedRegistrar;

    // --- Epoch state ---
    struct Epoch {
        uint256 poolSnapshot;        // total pool at epoch creation
        uint256 payoutPot;           // 50% of poolSnapshot
        uint256 rolledFromPool;      // 50% kept in pending pool
        uint256 trancheATotal;       // A's share of payout pot (or 0 if not active)
        uint256 trancheBTotal;       // B's share of payout pot (or 0 if not active)
        uint256 trancheARolled;      // A's share that rolled (not active yet)
        uint256 trancheBRolled;      // B's share that rolled (not active yet)
        uint256 perTrancheAMember;   // trancheATotal / trancheACount
        uint256 perTrancheBMember;   // trancheBTotal / trancheBCount
        uint256 startTime;
        uint256 totalClaimed;
        bool    rolledOver;          // true once unclaimed swept back
    }

    uint256 public currentEpoch;
    mapping(uint256 => Epoch) public epochs;

    // Pending pool accumulates deposits between epochs
    uint256 public pendingPool;

    mapping(uint256 => mapping(address => bool)) public epochClaimed;

    // --- Events ---
    event FounderRegistered(address indexed member, uint256 id, uint8 tranche);
    event TrancheActivated(uint8 tranche);
    event Deposited(address indexed from, uint256 amount);
    event EpochAdvanced(
        uint256 indexed epochId,
        uint256 poolSnapshot,
        uint256 payoutPot,
        uint256 rolledFromPool,
        uint256 trancheATotal,
        uint256 trancheBTotal,
        uint256 trancheARolled,
        uint256 trancheBRolled
    );
    event RewardClaimed(address indexed member, uint256 indexed epochId, uint256 amount);
    event UnclaimedRolledOver(uint256 indexed fromEpoch, uint256 amount);
    event AuthorisedRegistrarSet(address indexed registrar, bool status);

    // --- Constructor ---
    constructor(address _usdc, address _admin) Ownable(_admin) {
        require(_usdc  != address(0), "CW: zero usdc");
        require(_admin != address(0), "CW: zero admin");
        usdc = IERC20(_usdc);
    }

    // =========================================================================
    // FOUNDER REGISTRATION
    // =========================================================================

    /**
     * @notice Register `member` as a founding member (auto-assign by join order).
     *         Members 1-1,000       -> Tranche A (35 shares)
     *         Members 1,001-2,000   -> Tranche B (15 shares)
     *         After 2,000 slots: silently ignored.
     *
     *         Sets trancheAActive when A fills; trancheBActive when B fills.
     */
    function registerFounder(address member) external {
        require(
            isAuthorisedRegistrar[msg.sender] || msg.sender == owner(),
            "CW: not authorised"
        );
        require(member != address(0), "CW: zero member");
        if (founderTranche[member] != 0) return; // already registered
        if (founderCount >= MAX_FOUNDERS)  return; // slots full

        founderCount += 1;
        uint256 id = founderCount;
        founderId[member]  = id;
        founderById[id]    = member;

        uint8 tranche;
        if (id <= TRANCHE_A_MAX) {
            tranche = 1;
            trancheACount += 1;
            if (trancheACount == TRANCHE_A_MAX && !trancheAActive) {
                trancheAActive = true;
                emit TrancheActivated(1);
            }
        } else {
            tranche = 2;
            trancheBCount += 1;
            if (trancheBCount == TRANCHE_A_MAX && !trancheBActive) {
                // Tranche B full = all 2,000 slots filled
                trancheBActive = true;
                emit TrancheActivated(2);
            }
        }

        founderTranche[member] = tranche;
        emit FounderRegistered(member, id, tranche);
    }

    // =========================================================================
    // DEPOSIT
    // =========================================================================

    /**
     * @notice Deposit USDC into the pending pool.
     *         Caller must approve this contract first.
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "CW: zero deposit");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        pendingPool += amount;
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Record a deposit that was sent via safeTransfer() directly.
     *         Only authorised registrars (V3 matrices, TierManager) may call this.
     */
    function notifyDeposit(uint256 amount) external {
        require(
            isAuthorisedRegistrar[msg.sender] || msg.sender == owner(),
            "CW: not authorised"
        );
        require(amount > 0, "CW: zero amount");
        pendingPool += amount;
        emit Deposited(msg.sender, amount);
    }

    // =========================================================================
    // EPOCH MANAGEMENT
    // =========================================================================

    /**
     * @notice Snapshot the pending pool into a new claimable epoch.
     *         Call on or after the 25th of each month.
     *
     *         Split logic:
     *           50%  stays in pendingPool (always rolls over)
     *           50%  becomes the payout pot
     *             70% of payout pot -> Tranche A (if trancheAActive, else rolls)
     *             30% of payout pot -> Tranche B (if trancheBActive, else rolls)
     */
    function advanceEpoch() external onlyOwner {
        if (currentEpoch > 0) {
            require(
                block.timestamp >= epochs[currentEpoch].startTime + MIN_EPOCH_INTERVAL,
                "CW: too soon"
            );
        }
        require(pendingPool > 0, "CW: pool empty");

        uint256 pool = pendingPool;

        // 50% always stays / rolls over
        uint256 rolledFromPool = pool * ROLLOVER_BPS / BPS_DENOM;
        uint256 payoutPot      = pool - rolledFromPool; // 50%

        // Keep rolled portion in pendingPool for next epoch
        pendingPool = rolledFromPool;

        // Split payout pot: 70% A, 30% B
        uint256 aShare = payoutPot * TRANCHE_A_BPS / BPS_DENOM; // 70%
        uint256 bShare = payoutPot - aShare;                      // 30%

        uint256 trancheATotal  = 0;
        uint256 trancheBTotal  = 0;
        uint256 trancheARolled = 0;
        uint256 trancheBRolled = 0;

        if (trancheAActive) {
            trancheATotal = aShare;
        } else {
            // A not active: roll A's share back into pending pool
            trancheARolled = aShare;
            pendingPool   += aShare;
        }

        if (trancheBActive) {
            trancheBTotal = bShare;
        } else {
            // B not active: roll B's share back into pending pool
            trancheBRolled = bShare;
            pendingPool   += bShare;
        }

        uint256 perA = (trancheAActive && trancheACount > 0)
            ? trancheATotal / trancheACount : 0;
        uint256 perB = (trancheBActive && trancheBCount > 0)
            ? trancheBTotal / trancheBCount : 0;

        currentEpoch += 1;
        epochs[currentEpoch] = Epoch({
            poolSnapshot:      pool,
            payoutPot:         payoutPot,
            rolledFromPool:    rolledFromPool,
            trancheATotal:     trancheATotal,
            trancheBTotal:     trancheBTotal,
            trancheARolled:    trancheARolled,
            trancheBRolled:    trancheBRolled,
            perTrancheAMember: perA,
            perTrancheBMember: perB,
            startTime:         block.timestamp,
            totalClaimed:      0,
            rolledOver:        false
        });

        emit EpochAdvanced(
            currentEpoch, pool, payoutPot, rolledFromPool,
            trancheATotal, trancheBTotal, trancheARolled, trancheBRolled
        );
    }

    // =========================================================================
    // CLAIMING
    // =========================================================================

    /**
     * @notice Claim your share of epoch `epochId`.
     */
    function claim(uint256 epochId) external nonReentrant {
        address member  = msg.sender;
        uint8   tranche = founderTranche[member];
        require(tranche != 0,                      "CW: not a founder");
        require(!epochClaimed[epochId][member],     "CW: already claimed");

        Epoch storage epoch = epochs[epochId];
        require(epoch.poolSnapshot > 0,                               "CW: invalid epoch");
        require(block.timestamp <= epoch.startTime + CLAIM_WINDOW,    "CW: window closed");

        uint256 payout = tranche == 1
            ? epoch.perTrancheAMember
            : epoch.perTrancheBMember;
        require(payout > 0, "CW: nothing to claim");

        epochClaimed[epochId][member] = true;
        epoch.totalClaimed += payout;

        usdc.safeTransfer(member, payout);
        emit RewardClaimed(member, epochId, payout);
    }

    /**
     * @notice Claim from multiple epochs in one transaction.
     */
    function claimMultiple(uint256[] calldata epochIds) external nonReentrant {
        address member  = msg.sender;
        uint8   tranche = founderTranche[member];
        require(tranche != 0, "CW: not a founder");

        uint256 total;
        for (uint256 i = 0; i < epochIds.length; i++) {
            uint256 eid = epochIds[i];
            if (epochClaimed[eid][member]) continue;
            Epoch storage epoch = epochs[eid];
            if (epoch.poolSnapshot == 0) continue;
            if (block.timestamp > epoch.startTime + CLAIM_WINDOW) continue;

            uint256 payout = tranche == 1
                ? epoch.perTrancheAMember
                : epoch.perTrancheBMember;
            if (payout == 0) continue;

            epochClaimed[eid][member] = true;
            epoch.totalClaimed += payout;
            total += payout;
            emit RewardClaimed(member, eid, payout);
        }
        require(total > 0, "CW: nothing to claim");
        usdc.safeTransfer(member, total);
    }

    // =========================================================================
    // ROLLOVER (unclaimed -> next epoch pending pool)
    // =========================================================================

    /**
     * @notice After claim window closes, sweep unclaimed rewards back into
     *         the pending pool so they compound into the next epoch.
     */
    function rolloverUnclaimed(uint256 epochId) external onlyOwner nonReentrant {
        Epoch storage epoch = epochs[epochId];
        require(epoch.poolSnapshot > 0,                                "CW: invalid epoch");
        require(block.timestamp > epoch.startTime + CLAIM_WINDOW,      "CW: window open");
        require(!epoch.rolledOver,                                      "CW: already done");

        epoch.rolledOver = true;
        uint256 unclaimed = epoch.totalClaimed < (epoch.trancheATotal + epoch.trancheBTotal)
            ? (epoch.trancheATotal + epoch.trancheBTotal) - epoch.totalClaimed
            : 0;

        if (unclaimed > 0) {
            pendingPool += unclaimed;
            emit UnclaimedRolledOver(epochId, unclaimed);
        }
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    function claimableAmount(address member, uint256 epochId)
        external view returns (uint256)
    {
        uint8 tranche = founderTranche[member];
        if (tranche == 0) return 0;
        if (epochClaimed[epochId][member]) return 0;
        Epoch storage epoch = epochs[epochId];
        if (epoch.poolSnapshot == 0) return 0;
        if (block.timestamp > epoch.startTime + CLAIM_WINDOW) return 0;
        return tranche == 1 ? epoch.perTrancheAMember : epoch.perTrancheBMember;
    }

    function totalClaimable(address member) external view returns (uint256 total) {
        uint8 tranche = founderTranche[member];
        if (tranche == 0) return 0;
        for (uint256 i = 1; i <= currentEpoch; i++) {
            if (epochClaimed[i][member]) continue;
            Epoch storage epoch = epochs[i];
            if (epoch.poolSnapshot == 0) continue;
            if (block.timestamp > epoch.startTime + CLAIM_WINDOW) continue;
            total += tranche == 1 ? epoch.perTrancheAMember : epoch.perTrancheBMember;
        }
    }

    function epochSummary(uint256 epochId) external view returns (
        uint256 poolSnapshot,
        uint256 payoutPot,
        uint256 rolledFromPool,
        uint256 trancheATotal,
        uint256 trancheBTotal,
        uint256 trancheARolled,
        uint256 trancheBRolled,
        uint256 perTrancheAMember,
        uint256 perTrancheBMember,
        uint256 claimDeadline,
        uint256 totalClaimed
    ) {
        Epoch storage e = epochs[epochId];
        return (
            e.poolSnapshot, e.payoutPot, e.rolledFromPool,
            e.trancheATotal, e.trancheBTotal, e.trancheARolled, e.trancheBRolled,
            e.perTrancheAMember, e.perTrancheBMember,
            e.startTime + CLAIM_WINDOW, e.totalClaimed
        );
    }

    function founderInfo(address member) external view returns (
        bool isFounder, uint8 tranche, uint256 id, uint256 sharesHeld
    ) {
        uint8 t = founderTranche[member];
        isFounder  = t != 0;
        tranche    = t;
        id         = founderId[member];
        sharesHeld = t == 1 ? TRANCHE_A_SHARES : (t == 2 ? TRANCHE_B_SHARES : 0);
    }

    function poolStatus() external view returns (
        uint256 pending,
        bool aActive,
        bool bActive,
        uint256 aSlotsFilled,
        uint256 bSlotsFilled
    ) {
        return (pendingPool, trancheAActive, trancheBActive, trancheACount, trancheBCount);
    }

    // =========================================================================
    // ADMIN
    // =========================================================================

    function setAuthorisedRegistrar(address registrar, bool status) external onlyOwner {
        require(registrar != address(0), "CW: zero registrar");
        isAuthorisedRegistrar[registrar] = status;
        emit AuthorisedRegistrarSet(registrar, status);
    }

    function recoverToken(address token, uint256 amount) external onlyOwner {
        require(token != address(usdc), "CW: cannot recover USDC");
        IERC20(token).transfer(owner(), amount);
    }
}
