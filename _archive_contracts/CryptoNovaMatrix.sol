// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CryptoNovaMatrix  v2
 * @notice Binary (2-wide) 7-level BFS matrix with CNOVA token rewards,
 *         rising-floor USDC treasury, and pause/unpause mechanic.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  PAYMENT SPLIT on every $10.00 USDC entry
 * ═══════════════════════════════════════════════════════════════════
 *  $3.00  → Direct referrer bonus       (30%)
 *  $4.00  → Matrix upline chain pay     (40%) — split L1–L7 below
 *             └─ 80% of each level → recipient earnings (withdrawable)
 *             └─ 20% of each level → recipient re-entry pool (auto-funds cycle)
 *  $1.00  → New member re-entry pool    (10%) — starter for auto re-entry
 *  $1.50  → USDC reserve (Treasury)     (15%) — backs CNOVA floor
 *  $0.30  → Dev wallet                  ( 3%)
 *  $0.20  → Ops wallet                  ( 2%)
 *  ─────────────────────────────────────────
 *  $10.00 TOTAL
 *
 *  Matrix chain pay split of $4.00 (exact, sums to 4_000_000 at 1e6):
 *   L1: $1.33  L2: $0.80  L3: $0.67  L4: $0.53
 *   L5: $0.35  L6: $0.21  L7: $0.11
 *
 * ═══════════════════════════════════════════════════════════════════
 *  RE-ENTRY MECHANIC (v2)
 * ═══════════════════════════════════════════════════════════════════
 *  Every member has a re-entry pool that accumulates two ways:
 *   1. $1.00 flat added to YOUR OWN pool when YOU register.
 *   2. 20% of every chain payment YOU RECEIVE from downline registrations.
 *
 *  The moment a member's re-entry pool reaches $10.00 (ENTRY_FEE),
 *  the contract automatically re-registers them into the current cycle
 *  using their ORIGINAL referrer (locked at first registration — they
 *  follow you for life).  No manual action required.
 *
 *  If a re-entry is already in progress in the same transaction,
 *  the trigger is deferred — the pool keeps accumulating and fires
 *  on the next transaction that pushes it over $10.
 *
 *  Re-entry timing (Scenario 1, 20% rate):
 *   ~132 slots filled  → auto re-entry fires  (52% of first cycle)
 *
 * ═══════════════════════════════════════════════════════════════════
 *  MATRIX STRUCTURE
 * ═══════════════════════════════════════════════════════════════════
 *  Width: 2 (binary)   Depth: 7 levels
 *  Total positions: 2^1 + 2^2 + ... + 2^7 = 254
 *  Cycle trigger: 80% fill = 203 positions filled
 *
 *  Placement: BFS (breadth-first search) — leftmost available slot
 *  at shallowest available depth, ensuring fair automatic placement
 *  regardless of personal referrals.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  PAUSE / UNPAUSE MECHANIC
 * ═══════════════════════════════════════════════════════════════════
 *  If a member hasn't joined a new cycle for 90 days AND their
 *  current cycle has completed, their position is flagged as paused.
 *  BFS routing skips paused positions (spillover goes to the next
 *  active node), keeping the matrix healthy.
 *
 *  A paused member can reactivate by paying a small REACTIVATION_FEE.
 *  Their earnings balance is ALWAYS preserved — pause never confiscates.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";

contract CryptoNovaMatrix is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants & chain-agnostic immutables
    // ─────────────────────────────────────────────────────────────────────────
    // UNIT is set at deploy time:
    //   Base  (USDC native, 6 dec)  → UNIT = 1e6
    //   BSC   (USDT bridged, 18 dec) → UNIT = 1e18
    uint256 public immutable UNIT;              // 1 stablecoin unit ($1.00)

    uint256 public immutable ENTRY_FEE;         // $10.00 = 10 * UNIT
    uint256 public immutable REACTIVATION_FEE;  //  $1.00 =  1 * UNIT

    uint256 public constant MATRIX_WIDTH    = 2;
    uint256 public constant MATRIX_DEPTH    = 7;
    uint256 public constant TOTAL_POSITIONS = 254;
    uint256 public constant CYCLE_TRIGGER   = 203;      // 80% of 254
    uint256 public constant PAUSE_THRESHOLD = 90 days;
    uint256 public constant REENTRY_RATE    = 20;       // 20% of chain pay → re-entry pool

    // Payment splits (set in constructor from UNIT)
    uint256 public immutable SPLIT_REFERRER; // $3.00 (30%)
    uint256 public immutable SPLIT_REENTRY;  // $1.00 (10%) — flat starter for new member
    uint256 public immutable SPLIT_RESERVE;  // $1.50 (15%)
    uint256 public immutable SPLIT_DEV;      // $0.30 ( 3%)
    uint256 public immutable SPLIT_OPS;      // $0.20 ( 2%)

    // Matrix chain pay: $4.00 total across L1–L7  (40% of $10)
    // Values chosen so they sum to exactly 4 * UNIT for both 1e6 and 1e18.
    //   [133, 80, 67, 53, 35, 21, 11] * UNIT / 100  →  sum = 400 * UNIT / 100 = 4 * UNIT ✓
    uint256[7] private CHAIN_PAY;

    // ─────────────────────────────────────────────────────────────────────────
    // External contract references
    // ─────────────────────────────────────────────────────────────────────────
    IERC20         public immutable usdc;
    CNOVAToken     public immutable cnova;
    CNOVATreasury  public immutable treasury;

    address public devWallet;
    address public opsWallet;

    // ─────────────────────────────────────────────────────────────────────────
    // Re-entry guard (prevents cascade chain in same transaction)
    // ─────────────────────────────────────────────────────────────────────────
    bool private _reentryInProgress;

    // ─────────────────────────────────────────────────────────────────────────
    // Member data
    // ─────────────────────────────────────────────────────────────────────────
    struct Member {
        uint256  id;
        address  referrer;           // direct upline for current cycle
        address  originalReferrer;   // locked at first registration — never changes
        uint256  cycleId;
        uint256  matrixNodeId;
        uint256  earnings;           // withdrawable USDC balance
        uint256  reentryPool;        // accumulated re-entry savings
        uint256  lastActivityTime;
        bool     isRegistered;
        bool     isPaused;
    }

    mapping(address => Member) public members;
    mapping(uint256 => address) public memberById;
    uint256 public totalMembers;

    // ─────────────────────────────────────────────────────────────────────────
    // Matrix node data (BFS tree per cycle)
    // ─────────────────────────────────────────────────────────────────────────
    struct MatrixNode {
        address  owner;
        uint256  cycleId;
        uint256  parentNodeId;
        uint8    depth;
        uint8    childCount;
        uint256[2] children;
        bool     isPaused;
    }

    mapping(uint256 => MatrixNode) public nodes;
    uint256 public nextNodeId = 1;

    struct Cycle {
        uint256  id;
        uint256  rootNodeId;
        uint256  filledPositions;
        bool     isComplete;
        uint256  startTime;
    }

    mapping(uint256 => Cycle) public cycles;
    uint256 public currentCycleId = 1;
    uint256 public totalCycles    = 0;

    mapping(uint256 => uint256) public bfsHead; // cycleId → next BFS node to fill under

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────
    event MemberRegistered(
        address indexed member,
        address indexed referrer,
        uint256 memberId,
        uint256 cycleId,
        uint256 nodeId,
        uint256 cnovaRewarded
    );
    event ReferrerBonus(address indexed referrer, address indexed from, uint256 amount);
    event ChainPayment(address indexed recipient, uint256 level, uint256 amount);
    event ReentryPoolContribution(address indexed recipient, uint256 level, uint256 amount);
    event MatrixCycleCompleted(uint256 indexed cycleId, uint256 totalPositions);
    event NewCycleStarted(uint256 indexed cycleId);
    event MemberPaused(address indexed member, uint256 cycleId);
    event MemberUnpaused(address indexed member, uint256 cycleId);
    event ReentryTriggered(address indexed member, uint256 newCycleId, uint256 newNodeId);
    event ReentryDeferred(address indexed member, uint256 poolBalance);
    event EarningsWithdrawn(address indexed member, uint256 amount);
    event DevWalletUpdated(address indexed newDev);
    event OpsWalletUpdated(address indexed newOps);

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _cnova,
        address _treasury,
        address _devWallet,
        address _opsWallet,
        address _admin,
        uint256 _unit       // 1e6 for Base USDC · 1e18 for BSC USDT
    ) Ownable(_admin) {
        require(_usdc      != address(0), "Matrix: zero usdc");
        require(_cnova     != address(0), "Matrix: zero cnova");
        require(_treasury  != address(0), "Matrix: zero treasury");
        require(_devWallet != address(0), "Matrix: zero dev");
        require(_opsWallet != address(0), "Matrix: zero ops");
        require(_unit == 1e6 || _unit == 1e18, "Matrix: invalid unit");

        usdc     = IERC20(_usdc);
        cnova    = CNOVAToken(_cnova);
        treasury = CNOVATreasury(_treasury);

        devWallet = _devWallet;
        opsWallet = _opsWallet;

        UNIT             = _unit;
        ENTRY_FEE        = 10 * _unit;          // $10.00
        REACTIVATION_FEE =  1 * _unit;          //  $1.00
        SPLIT_REFERRER   =  3 * _unit;          //  $3.00 (30%)
        SPLIT_REENTRY    =  1 * _unit;          //  $1.00 (10%) flat starter
        SPLIT_RESERVE    =  3 * _unit / 2;      //  $1.50 (15%)
        SPLIT_DEV        =  3 * _unit / 10;     //  $0.30 ( 3%)
        SPLIT_OPS        =  2 * _unit / 10;     //  $0.20 ( 2%)

        // Chain pay L1–L7 — coefficients × UNIT / 100, sum = 400/100 = 4 * UNIT
        CHAIN_PAY[0] = 133 * _unit / 100;       // L1: $1.33
        CHAIN_PAY[1] =  80 * _unit / 100;       // L2: $0.80
        CHAIN_PAY[2] =  67 * _unit / 100;       // L3: $0.67
        CHAIN_PAY[3] =  53 * _unit / 100;       // L4: $0.53
        CHAIN_PAY[4] =  35 * _unit / 100;       // L5: $0.35
        CHAIN_PAY[5] =  21 * _unit / 100;       // L6: $0.21
        CHAIN_PAY[6] =  11 * _unit / 100;       // L7: $0.11
        // Sum: 133+80+67+53+35+21+11 = 400  →  400 * UNIT / 100 = 4 * UNIT ✓

        _startNewCycle();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REGISTRATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Join the matrix by paying $10.00 USDC.
     * @param referrer  Address of the member who referred you.
     *                  Use address(0) only for member #1.
     */
    function register(address referrer) external nonReentrant {
        address sender = msg.sender;

        require(!members[sender].isRegistered, "Matrix: already registered");
        require(
            (totalMembers == 0 && referrer == address(0)) ||
            (totalMembers  > 0 && referrer != address(0) && members[referrer].isRegistered),
            "Matrix: invalid referrer"
        );
        require(
            usdc.allowance(sender, address(this)) >= ENTRY_FEE,
            "Matrix: approve USDC first"
        );

        usdc.safeTransferFrom(sender, address(this), ENTRY_FEE);

        totalMembers += 1;
        uint256 memberId = totalMembers;

        uint256 nodeId = _placeInMatrix(sender);

        members[sender] = Member({
            id:               memberId,
            referrer:         referrer,
            originalReferrer: referrer,   // locked for life
            cycleId:          currentCycleId,
            matrixNodeId:     nodeId,
            earnings:         0,
            reentryPool:      0,
            lastActivityTime: block.timestamp,
            isRegistered:     true,
            isPaused:         false
        });
        memberById[memberId] = sender;

        _distributePayments(sender, referrer);

        uint256 cnovaRewarded = cnova.mintReward(sender);

        emit MemberRegistered(sender, referrer, memberId, currentCycleId, nodeId, cnovaRewarded);

        _checkCycleTrigger();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BFS MATRIX PLACEMENT
    // ─────────────────────────────────────────────────────────────────────────

    function _placeInMatrix(address member) internal returns (uint256 newNodeId) {
        Cycle storage cycle = cycles[currentCycleId];

        newNodeId = nextNodeId++;

        if (cycle.rootNodeId == 0) {
            nodes[newNodeId] = MatrixNode({
                owner:        member,
                cycleId:      currentCycleId,
                parentNodeId: 0,
                depth:        0,
                childCount:   0,
                children:     [uint256(0), uint256(0)],
                isPaused:     false
            });
            cycle.rootNodeId = newNodeId;
            bfsHead[currentCycleId] = newNodeId;
            cycle.filledPositions += 1;
            return newNodeId;
        }

        uint256 parentNodeId = _findBFSSlot(currentCycleId);
        MatrixNode storage parent = nodes[parentNodeId];
        uint8 slot = parent.childCount;

        nodes[newNodeId] = MatrixNode({
            owner:        member,
            cycleId:      currentCycleId,
            parentNodeId: parentNodeId,
            depth:        parent.depth + 1,
            childCount:   0,
            children:     [uint256(0), uint256(0)],
            isPaused:     false
        });

        parent.children[slot] = newNodeId;
        parent.childCount     += 1;
        cycle.filledPositions += 1;

        _advanceBFSHead(currentCycleId);

        return newNodeId;
    }

    function _findBFSSlot(uint256 cycleId) internal view returns (uint256) {
        uint256 scanId = bfsHead[cycleId];
        while (scanId < nextNodeId) {
            MatrixNode storage n = nodes[scanId];
            if (n.cycleId == cycleId && n.childCount < 2 && n.depth < MATRIX_DEPTH) {
                return scanId;
            }
            scanId++;
        }
        revert("Matrix: BFS queue exhausted");
    }

    function _advanceBFSHead(uint256 cycleId) internal {
        uint256 headId = bfsHead[cycleId];
        while (headId < nextNodeId) {
            MatrixNode storage head = nodes[headId];
            if (head.cycleId == cycleId && head.childCount < 2 && head.depth < MATRIX_DEPTH) {
                break;
            }
            headId++;
        }
        bfsHead[cycleId] = headId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAYMENT DISTRIBUTION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Distribute the $10 entry fee.
     *
     *  $3.00 → direct referrer earnings
     *  $4.00 → matrix upline chain pay (L1–L7)
     *             80% of each level → recipient earnings
     *             20% of each level → recipient re-entry pool
     *  $1.00 → new member's own re-entry pool (flat starter)
     *  $1.50 → CNOVATreasury reserve
     *  $0.30 → dev wallet
     *  $0.20 → ops wallet
     */
    function _distributePayments(address newMember, address referrer) internal {
        // 1. Direct referrer bonus ($3.00)
        if (referrer != address(0) && members[referrer].isRegistered) {
            members[referrer].earnings += SPLIT_REFERRER;
            emit ReferrerBonus(referrer, newMember, SPLIT_REFERRER);
        } else {
            usdc.safeTransfer(opsWallet, SPLIT_REFERRER);
        }

        // 2. Matrix upline chain pay ($4.00 total, 80/20 split per level)
        _distributeChainPay(members[newMember].matrixNodeId);

        // 3. New member's re-entry pool flat starter ($1.00)
        members[newMember].reentryPool += SPLIT_REENTRY;

        // 4. USDC reserve → Treasury ($1.50)
        SafeERC20.forceApprove(usdc, address(treasury), SPLIT_RESERVE);
        treasury.depositReserve(SPLIT_RESERVE);

        // 5. Dev wallet ($0.30)
        usdc.safeTransfer(devWallet, SPLIT_DEV);

        // 6. Ops wallet ($0.20)
        usdc.safeTransfer(opsWallet, SPLIT_OPS);
    }

    /**
     * @dev Walk up the matrix tree from the new member's node.
     *      For each ancestor level:
     *        - 80% of CHAIN_PAY[level] → recipient.earnings
     *        - 20% of CHAIN_PAY[level] → recipient.reentryPool
     *      After paying all levels, trigger auto re-entry for any
     *      recipient whose pool has crossed ENTRY_FEE.
     *      Paused ancestors are skipped; their share rolls upward.
     */
    function _distributeChainPay(uint256 startNodeId) internal {
        uint256 currentNodeId = nodes[startNodeId].parentNodeId;
        uint8   levelIndex    = 0;

        // Collect addresses that may need re-entry check (max 7)
        address[7] memory reentryQueue;
        uint8 reentryCount = 0;

        while (levelIndex < 7 && currentNodeId != 0) {
            MatrixNode storage node = nodes[currentNodeId];
            address recipient = node.owner;

            if (!node.isPaused && recipient != address(0)) {
                uint256 total   = CHAIN_PAY[levelIndex];
                uint256 toPool  = total * REENTRY_RATE / 100;   // 20%
                uint256 toEarn  = total - toPool;               // 80%

                members[recipient].earnings    += toEarn;
                members[recipient].reentryPool += toPool;

                emit ChainPayment(recipient, levelIndex + 1, toEarn);
                emit ReentryPoolContribution(recipient, levelIndex + 1, toPool);

                // Queue for re-entry check after the full loop
                if (members[recipient].reentryPool >= ENTRY_FEE) {
                    reentryQueue[reentryCount++] = recipient;
                }

                levelIndex++;
            }

            currentNodeId = node.parentNodeId;
        }

        // Remaining levels (shallow tree) → ops wallet
        if (levelIndex < 7) {
            uint256 remainder = 0;
            while (levelIndex < 7) {
                remainder += CHAIN_PAY[levelIndex];
                levelIndex++;
            }
            usdc.safeTransfer(opsWallet, remainder);
        }

        // Process any triggered re-entries (pool ≥ $10)
        for (uint8 i = 0; i < reentryCount; i++) {
            _processAutoReentry(reentryQueue[i]);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AUTO RE-ENTRY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Attempt to auto re-enter a member whose pool has hit $10.
     *      Uses originalReferrer so the referring relationship is permanent.
     *      If a re-entry is already mid-flight in this transaction, defers
     *      to the next tx that pushes the pool over $10 again.
     */
    function _processAutoReentry(address member) internal {
        // Defer if a re-entry is already in progress this tx (prevents cascade)
        if (_reentryInProgress) {
            emit ReentryDeferred(member, members[member].reentryPool);
            return;
        }
        // Re-check (pool may have changed since queue was built)
        if (members[member].reentryPool < ENTRY_FEE) return;
        // Skip inactive / paused members
        if (block.timestamp - members[member].lastActivityTime >= PAUSE_THRESHOLD) {
            _pauseMember(member, members[member].matrixNodeId);
            return;
        }

        _reentryInProgress = true;

        members[member].reentryPool     -= ENTRY_FEE;
        members[member].lastActivityTime = block.timestamp;

        uint256 nodeId = _placeInMatrix(member);

        members[member].cycleId      = currentCycleId;
        members[member].matrixNodeId = nodeId;
        members[member].isPaused     = false;

        // Always use the original referrer — they follow you for life
        address origRef = members[member].originalReferrer;
        _distributePayments(member, origRef);

        uint256 cnovaRewarded = cnova.mintReward(member);

        emit MemberRegistered(member, origRef, members[member].id, currentCycleId, nodeId, cnovaRewarded);
        emit ReentryTriggered(member, currentCycleId, nodeId);

        _checkCycleTrigger();

        _reentryInProgress = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CYCLE COMPLETION
    // ─────────────────────────────────────────────────────────────────────────

    function _checkCycleTrigger() internal {
        Cycle storage cycle = cycles[currentCycleId];
        if (cycle.filledPositions >= CYCLE_TRIGGER && !cycle.isComplete) {
            cycle.isComplete = true;
            emit MatrixCycleCompleted(currentCycleId, cycle.filledPositions);
            _startNewCycle();
        }
    }

    function _startNewCycle() internal {
        totalCycles    += 1;
        currentCycleId  = totalCycles;

        cycles[currentCycleId] = Cycle({
            id:              currentCycleId,
            rootNodeId:      0,
            filledPositions: 0,
            isComplete:      false,
            startTime:       block.timestamp
        });

        emit NewCycleStarted(currentCycleId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAUSE / UNPAUSE MECHANIC
    // ─────────────────────────────────────────────────────────────────────────

    function _pauseMember(address member, uint256 nodeId) internal {
        members[member].isPaused = true;
        nodes[nodeId].isPaused   = true;
        emit MemberPaused(member, members[member].cycleId);
    }

    function pauseInactiveMember(address member) external onlyOwner {
        require(members[member].isRegistered, "Matrix: not registered");
        require(!members[member].isPaused,    "Matrix: already paused");
        require(
            block.timestamp - members[member].lastActivityTime >= PAUSE_THRESHOLD,
            "Matrix: member still active"
        );
        _pauseMember(member, members[member].matrixNodeId);
    }

    function unpause() external nonReentrant {
        address sender = msg.sender;
        require(members[sender].isRegistered, "Matrix: not registered");
        require(members[sender].isPaused,     "Matrix: not paused");
        require(
            usdc.allowance(sender, address(this)) >= REACTIVATION_FEE,
            "Matrix: approve reactivation fee first"
        );

        usdc.safeTransferFrom(sender, opsWallet, REACTIVATION_FEE);

        uint256 nodeId = _placeInMatrix(sender);
        members[sender].matrixNodeId     = nodeId;
        members[sender].cycleId          = currentCycleId;
        members[sender].isPaused         = false;
        members[sender].lastActivityTime = block.timestamp;
        nodes[nodeId].isPaused           = false;

        emit MemberUnpaused(sender, currentCycleId);
        _checkCycleTrigger();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WITHDRAWALS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw all available USDC earnings.
     *         Re-entry pool is NOT withdrawable — it auto-funds the next cycle.
     */
    function withdraw() external nonReentrant {
        address sender = msg.sender;
        uint256 amount = members[sender].earnings;
        require(amount > 0, "Matrix: nothing to withdraw");

        members[sender].earnings = 0;
        usdc.safeTransfer(sender, amount);

        emit EarningsWithdrawn(sender, amount);
    }

    function withdrawableBalance(address member) external view returns (uint256) {
        return members[member].earnings;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MANUAL TOP-UP FOR RE-ENTRY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Manually top up your re-entry pool (e.g. if paused or pool is short).
     *         If the top-up pushes pool ≥ $10, auto re-entry fires immediately.
     */
    function topUpReentryPool(uint256 amount) external nonReentrant {
        require(members[msg.sender].isRegistered, "Matrix: not registered");
        require(amount > 0, "Matrix: zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        members[msg.sender].reentryPool += amount;

        if (members[msg.sender].reentryPool >= ENTRY_FEE) {
            _processAutoReentry(msg.sender);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMatrixMemberCount interface (used by Treasury)
    // ─────────────────────────────────────────────────────────────────────────

    function totalMembersCount() external view returns (uint256) {
        return totalMembers;
    }

    function totalMembers_() external view returns (uint256) {
        return totalMembers;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    function setDevWallet(address _dev) external onlyOwner {
        require(_dev != address(0), "Matrix: zero dev");
        devWallet = _dev;
        emit DevWalletUpdated(_dev);
    }

    function setOpsWallet(address _ops) external onlyOwner {
        require(_ops != address(0), "Matrix: zero ops");
        opsWallet = _ops;
        emit OpsWalletUpdated(_ops);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEW HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function getMember(address member) external view returns (Member memory) {
        return members[member];
    }

    function getNode(uint256 nodeId) external view returns (MatrixNode memory) {
        return nodes[nodeId];
    }

    function getCycleStatus() external view returns (
        uint256 cycleId,
        uint256 filled,
        uint256 remaining,
        bool complete
    ) {
        Cycle storage c = cycles[currentCycleId];
        return (
            currentCycleId,
            c.filledPositions,
            CYCLE_TRIGGER > c.filledPositions ? CYCLE_TRIGGER - c.filledPositions : 0,
            c.isComplete
        );
    }

    function earningsSummary(address member) external view returns (
        uint256 withdrawable,
        uint256 reentryPool,
        uint256 reentryProgress,   // percentage toward next re-entry (0–100)
        uint256 cnovaBalance
    ) {
        uint256 pool = members[member].reentryPool;
        uint256 progress = ENTRY_FEE > 0 ? (pool * 100) / ENTRY_FEE : 0;
        if (progress > 100) progress = 100;
        return (
            members[member].earnings,
            pool,
            progress,
            cnova.balanceOf(member)
        );
    }

    function cnovaFloorPrice() external view returns (uint256) {
        return treasury.floorPrice();
    }
}
