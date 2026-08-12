// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CryptoNovaMatrixV6
 * @notice 127-member BFS binary tree matrix that feeds into a conveyor belt.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOW IT WORKS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Belt → Matrix → Belt (repeating cycle)
 *  ─────────────────────────────────────────────────────────────────────────
 *  1. Member joins belt queue (via BeltManager).
 *  2. When matrix has an open slot, next belt member enters at the next
 *     available BFS position (queued, FIFO).
 *  3. While in the matrix, chain pay flows UP the BFS tree to ancestors
 *     on every new entry (join or re-entry).
 *  4. When matrix fills (127 members), position 1 (root) cycles out.
 *  5. Root goes to BACK of belt queue (fair, no priority).
 *  6. Repeat forever.
 *
 *  PAYMENT SPLIT (per $10 event — any entry or re-entry)
 *  ─────────────────────────────────────────────────────────────────────────
 *  $2.50 → L1 referrer (direct sponsor)
 *  $0.30 → L2 override (sponsor's sponsor)
 *  $0.20 → L3 override (L2's sponsor)
 *  $4.00 → Chain pay distributed up 7 levels of BFS tree ancestors
 *  $1.50 → Treasury (backs CNOVA floor price)
 *  $1.00 → Community Wallet (founder epoch payouts)
 *  $0.50 → Dev/Ops
 *
 *  MATRIX SIZE
 *  ─────────────────────────────────────────────────────────────────────────
 *  127 members = 7-level full binary tree
 *  Positions 1-127 in BFS order:
 *    Level 1:  pos 1       (root)
 *    Level 2:  pos 2-3
 *    Level 3:  pos 4-7
 *    Level 4:  pos 8-15
 *    Level 5:  pos 16-31
 *    Level 6:  pos 32-63
 *    Level 7:  pos 64-127  (leaves)
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";

interface ICommunityWalletV6 {
    function deposit(uint256 amount) external;
    function registerFounder(address member) external;
}

interface ITierManagerV6 {
    function tryAutoUpgrade(address member) external;
    function recordTreeJoin(address member, address l1, address l2, address l3) external;
}

contract CryptoNovaMatrixV6 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────────────
    // Matrix size is a constructor param so the same contract works at all test scales:
    //   Lightning self-test   : 7  (3-level tree, fills in 7 members — very fast)
    //   Expedited community   : 15 (4-level tree, fills in 15 members)
    //   Full / Mainnet        : 127 (7-level tree, production)
    uint256 public immutable MATRIX_SIZE;

    // Payment splits (in USDC native units — same unit as ENTRY_FEE)
    // All splits are expressed as fractions of ENTRY_FEE
    uint256 public constant SPLIT_L1_BPS       = 2500;  // 25% → direct sponsor
    uint256 public constant SPLIT_L2_BPS       = 300;   //  3% → L2 override
    uint256 public constant SPLIT_L3_BPS       = 200;   //  2% → L3 override
    uint256 public constant SPLIT_CHAIN_BPS    = 4000;  // 40% → BFS tree ancestors
    uint256 public constant SPLIT_TREASURY_BPS = 1500;  // 15% → treasury
    uint256 public constant SPLIT_CW_BPS       = 1000;  // 10% → community wallet
    uint256 public constant SPLIT_DEV_BPS      = 500;   //  5% → dev/ops
    uint256 public constant BPS_DENOM          = 10_000;

    // Chain pay per level — sums to SPLIT_CHAIN_BPS exactly
    // 7 levels: 20%+8%+6%+3%+1.5%+0.75%+0.75% = 40%
    uint256[7] public chainPayBps = [2000, 800, 600, 300, 150, 75, 75];

    // ─── Immutables ───────────────────────────────────────────────────────────
    IERC20         public immutable usdc;
    CNOVAToken     public immutable cnova;
    CNOVATreasury  public immutable treasury;
    address        public immutable devWallet;
    uint256        public immutable ENTRY_FEE;    // e.g. 10_000_000 for $10

    // ─── State ────────────────────────────────────────────────────────────────

    /// @dev BFS tree: matrixPos[addr] = position 1-127 (0 = not in matrix)
    mapping(address => uint256) public matrixPos;

    /// @dev Reverse: who is at each BFS position (1..MATRIX_SIZE). Index 0 unused.
    mapping(uint256 => address) public posToMember;

    /// @dev Number of positions currently occupied (1..MATRIX_SIZE)
    uint256 public occupancy;

    /// @dev Next BFS slot to fill (1..127). After 127, matrix is full.
    uint256 public nextSlot;

    /// @dev Member data
    struct Member {
        uint256  id;
        address  referrer;          // direct sponsor (L1)
        address  l2;                // sponsor's sponsor
        address  l3;                // l2's sponsor
        uint256  joinedAt;
        uint256  withdrawable;
        uint256  totalEarned;
        uint256  cyclesCompleted;
        bool     isInMatrix;
        bool     hasEverJoined;
    }
    mapping(address => Member) public members;
    uint256 public totalJoined;

    /// @dev Global cycle counter
    uint256 public rotationCount;

    // ─── External references ──────────────────────────────────────────────────
    address public communityWallet;
    address public opsWallet;
    address public tierManager;
    address public beltManagerCaller;  // BeltManager address
    uint256 public reentryPool;        // pre-funded by newer belt joiners (Option B)

    /// @dev Contracts authorised to call enterMatrix() — BeltManager only
    mapping(address => bool) public authorizedCallers;

    // ─── Events ───────────────────────────────────────────────────────────────
    event MemberEnteredMatrix(address indexed member, uint256 bfsPosition, uint256 memberId);
    event MemberCycledOut(address indexed member, uint256 cyclesCompleted, uint256 rotationCount);
    event ChainPayDistributed(address indexed recipient, address indexed payer, uint256 level, uint256 amount);
    event EarningsWithdrawn(address indexed member, uint256 amount);
    event L2L3Override(address indexed l1, address indexed l2, address indexed l3, uint256 l2Amount, uint256 l3Amount);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _cnova,
        address _treasury,
        address _devWallet,
        address _opsWallet,
        address _communityWallet,
        address _admin,
        uint256 _entryFee,
        uint256 _matrixSize   // 7=lightning, 15=expedited, 127=mainnet
    ) Ownable(_admin) {
        require(_usdc != address(0),            "V6: zero usdc");
        require(_cnova != address(0),           "V6: zero cnova");
        require(_treasury != address(0),        "V6: zero treasury");
        require(_devWallet != address(0),       "V6: zero dev");
        require(_opsWallet != address(0),       "V6: zero ops");
        require(_communityWallet != address(0), "V6: zero cw");
        require(_entryFee > 0,                  "V6: zero fee");
        require(_matrixSize >= 3 && _matrixSize <= 127, "V6: invalid matrix size");

        usdc            = IERC20(_usdc);
        cnova           = CNOVAToken(_cnova);
        treasury        = CNOVATreasury(_treasury);
        devWallet       = _devWallet;
        opsWallet       = _opsWallet;
        communityWallet = _communityWallet;
        ENTRY_FEE   = _entryFee;
        MATRIX_SIZE = _matrixSize;
        nextSlot    = 1;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
    }

    function setTierManager(address tm) external onlyOwner {
        tierManager = tm;
    }

    function setBeltManagerCaller(address bm) external onlyOwner {
        beltManagerCaller = bm;
    }

    /// @notice BeltManager pre-funds this pool so older belts keep cycling.
    function topUpReentryPool(uint256 amount) external {
        require(msg.sender == beltManagerCaller, "V6: not belt manager");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        reentryPool += amount;
    }

    /// @notice BeltManager calls this to drain re-entry pool funds to itself to cover enterMatrix cost.
    function drainReentryPool(uint256 amount) external {
        require(msg.sender == beltManagerCaller, "V6: not belt manager");
        require(reentryPool >= amount, "V6: pool insufficient");
        reentryPool -= amount;
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice TierManager or BeltManager calls this to pull fee from member's earned balance.
    ///         TierManager: pulls upgrade fee → sends USDC to TierManager.
    ///         BeltManager: pulls 2nd re-entry fee → USDC stays in matrix (re-entry pool).
    function deductWithdrawable(address member, uint256 amount) external {
        require(
            msg.sender == tierManager || msg.sender == beltManagerCaller,
            "V6: not authorized"
        );
        require(members[member].withdrawable >= amount, "V6: insufficient balance");
        members[member].withdrawable -= amount;
        // Transfer USDC to caller (TierManager for upgrade, BeltManager for 2nd slot)
        usdc.safeTransfer(msg.sender, amount);
    }

    // ─── Matrix Entry ─────────────────────────────────────────────────────────

    /**
     * @notice Called by BeltManager when a belt member's turn arrives to enter
     *         the matrix. USDC must already be approved to this contract.
     *
     * @param member    The member entering the matrix.
     * @param referrer  Their L1 sponsor (locked for life on first join).
     */
    function enterMatrix(address member, address referrer) external {
        // No nonReentrant — enterMatrix is called nested when cycled root re-enters:
        // register() [BM nonReentrant] → enterMatrix() → _cycleOutRoot() → reenterBelt() → enterMatrix()
        // Security: only authorizedCallers can call this (BeltManager only)
        // BeltManager.register() already has nonReentrant protecting the outer entry
        require(authorizedCallers[msg.sender], "V6: not authorized");
        require(member != address(0),          "V6: zero member");
        require(!members[member].isInMatrix,   "V6: already in matrix");
        require(nextSlot <= MATRIX_SIZE || occupancy == MATRIX_SIZE, "V6: matrix full");

        // Pull ENTRY_FEE from caller (BeltManager)
        usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);

        // First-time setup
        bool isFirstJoin = !members[member].hasEverJoined;
        if (isFirstJoin) {
            totalJoined += 1;
            address l1 = (referrer != address(0) && members[referrer].hasEverJoined)
                ? referrer : address(0);
            address l2 = l1 != address(0) ? members[l1].referrer : address(0);
            address l3 = l2 != address(0) ? members[l2].referrer : address(0);

            members[member] = Member({
                id:               totalJoined,
                referrer:         l1,
                l2:               l2,
                l3:               l3,
                joinedAt:         block.timestamp,
                withdrawable:     0,
                totalEarned:      0,
                cyclesCompleted:  0,
                isInMatrix:       false,
                hasEverJoined:    true
            });

            // Register in community wallet
            try ICommunityWalletV6(communityWallet).registerFounder(member) {} catch {}

            // Notify TierManager of L2/L3 tree structure
            if (tierManager != address(0)) {
                try ITierManagerV6(tierManager).recordTreeJoin(member, l1, l2, l3) {} catch {}
            }
        }

        // ── Place in matrix ───────────────────────────────────────────────────
        if (occupancy < MATRIX_SIZE) {
            // Filling phase: place at nextSlot
            _placeInMatrix(member, nextSlot);
            nextSlot += 1;
            occupancy += 1;
        } else {
            // Matrix is full: root (position 1) cycles out, everyone shifts up by 1,
            // new member goes to the last position (nextSlot = MATRIX_SIZE after shift)
            _cycleOutRoot();
            _placeInMatrix(member, nextSlot); // nextSlot = MATRIX_SIZE after _cycleOutRoot shift
            // nextSlot stays at 1 (root slot just freed)
        }

        // ── Distribute payments ───────────────────────────────────────────────
        _distributePayments(member);

        // ── Mint CNOVA ────────────────────────────────────────────────────────
        // V8.48: mintReward gained a deposit6 backing param. This LEGACY contract is
        // never deployed against the V8.48 token; deposit 0 = mints 0 by the strict
        // backing rule, which is correct for a path that made no reserve deposit.
        cnova.mintReward(member, 0, 0);  // V6: single-tier, T1 multiplier (index 0)

        emit MemberEnteredMatrix(member, members[member].isInMatrix ? matrixPos[member] : 0, members[member].id);
    }

    // ─── Internal: Matrix Placement ───────────────────────────────────────────

    function _placeInMatrix(address member, uint256 slot) internal {
        matrixPos[member] = slot;
        posToMember[slot] = member;
        members[member].isInMatrix = true;
    }

    function _cycleOutRoot() internal {
        address root = posToMember[1];
        require(root != address(0), "V6: no root");

        // Remove from matrix
        matrixPos[root] = 0;
        posToMember[1] = address(0);
        members[root].isInMatrix = false;
        members[root].cyclesCompleted += 1;
        rotationCount += 1;
        occupancy -= 1;  // Decrement so isFull() returns false — allows immediate re-entry

        // Shift everyone up by one BFS position
        // Positions 2..127 shift to 1..126
        for (uint256 i = 1; i < MATRIX_SIZE; i++) {
            address m = posToMember[i + 1];
            posToMember[i] = m;
            posToMember[i + 1] = address(0);
            if (m != address(0)) {
                matrixPos[m] = i;
            }
        }
        // nextSlot is now at MATRIX_SIZE (127 — the last slot just freed)
        nextSlot = MATRIX_SIZE;

        emit MemberCycledOut(root, members[root].cyclesCompleted, rotationCount);

        // Auto-upgrade check
        if (tierManager != address(0)) {
            try ITierManagerV6(tierManager).tryAutoUpgrade(root) {} catch {}
        }

        // Notify BeltManager to put root back in belt queue
        if (beltManagerCaller != address(0)) {
            IBeltManagerV6(beltManagerCaller).reenterBelt(root);
        }
    }

    // ─── Internal: Payment Distribution ──────────────────────────────────────

    function _distributePayments(address newMember) internal {
        Member storage m = members[newMember];

        // L1/L2/L3 referral overrides
        uint256 l1Amount = ENTRY_FEE * SPLIT_L1_BPS / BPS_DENOM;
        uint256 l2Amount = ENTRY_FEE * SPLIT_L2_BPS / BPS_DENOM;
        uint256 l3Amount = ENTRY_FEE * SPLIT_L3_BPS / BPS_DENOM;

        if (m.referrer != address(0)) {
            _credit(m.referrer, l1Amount);
        } else {
            // No sponsor: L1 bonus flows to Community Wallet pool (not lost to ops)
            SafeERC20.forceApprove(usdc, communityWallet, l1Amount);
            ICommunityWalletV6(communityWallet).deposit(l1Amount);
        }
        if (m.l2 != address(0)) {
            _credit(m.l2, l2Amount);
            emit L2L3Override(m.referrer, m.l2, m.l3, l2Amount, m.l3 != address(0) ? l3Amount : 0);
        } else {
            // No L2: override flows to Community Wallet
            SafeERC20.forceApprove(usdc, communityWallet, l2Amount);
            ICommunityWalletV6(communityWallet).deposit(l2Amount);
        }
        if (m.l3 != address(0)) {
            _credit(m.l3, l3Amount);
        } else {
            // No L3: override flows to Community Wallet
            SafeERC20.forceApprove(usdc, communityWallet, l3Amount);
            ICommunityWalletV6(communityWallet).deposit(l3Amount);
        }

        // Chain pay up BFS tree (7 levels above new member's position)
        _distributeChainPay(newMember);

        // Treasury
        uint256 treasuryAmt = ENTRY_FEE * SPLIT_TREASURY_BPS / BPS_DENOM;
        SafeERC20.forceApprove(usdc, address(treasury), treasuryAmt);
        treasury.depositReserve(treasuryAmt);

        // Community wallet
        uint256 cwAmt = ENTRY_FEE * SPLIT_CW_BPS / BPS_DENOM;
        SafeERC20.forceApprove(usdc, communityWallet, cwAmt);
        ICommunityWalletV6(communityWallet).deposit(cwAmt);

        // Dev/ops
        uint256 devAmt = ENTRY_FEE * SPLIT_DEV_BPS / BPS_DENOM;
        usdc.safeTransfer(devWallet, devAmt / 2);
        usdc.safeTransfer(opsWallet, devAmt - devAmt / 2);
    }

    function _distributeChainPay(address newMember) internal {
        uint256 myPos = matrixPos[newMember];
        if (myPos == 0) return;

        uint256 parentPos = myPos / 2;
        for (uint256 lvl = 0; lvl < 7 && parentPos >= 1; lvl++) {
            address ancestor = posToMember[parentPos];
            if (ancestor != address(0)) {
                uint256 amt = ENTRY_FEE * chainPayBps[lvl] / BPS_DENOM;
                _credit(ancestor, amt);
                emit ChainPayDistributed(ancestor, newMember, lvl + 1, amt);
            }
            parentPos = parentPos / 2;
        }
    }

    function _credit(address recipient, uint256 amount) internal {
        if (recipient == address(0) || amount == 0) return;
        members[recipient].withdrawable += amount;
        members[recipient].totalEarned  += amount;
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = members[msg.sender].withdrawable;
        require(amount > 0, "V6: nothing to withdraw");
        members[msg.sender].withdrawable = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit EarningsWithdrawn(msg.sender, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getMember(address member) external view returns (Member memory) {
        return members[member];
    }

    /// @notice Convenience view — returns just the withdrawable balance for a member.
    ///         Used by BeltManager to check if a member can afford a second re-entry slot.
    function withdrawableOf(address member) external view returns (uint256) {
        return members[member].withdrawable;
    }

    function getMatrixPosition(address member) external view returns (uint256) {
        return matrixPos[member];
    }

    function getAncestors(address member) external view returns (address[7] memory ancestors) {
        uint256 pos = matrixPos[member];
        for (uint256 i = 0; i < 7 && pos > 1; i++) {
            pos = pos / 2;
            ancestors[i] = posToMember[pos];
        }
    }

    function totalMembers() external view returns (uint256) {
        return totalJoined;
    }

    function memberJoinedAt(address member) external view returns (uint256) {
        return members[member].joinedAt;
    }

    function getCyclesCompleted(address member) external view returns (uint256) {
        return members[member].cyclesCompleted;
    }

    function isFull() external view returns (bool) {
        return occupancy == MATRIX_SIZE;
    }
}

/// @dev Minimal interface for BeltManager re-entry callback
interface IBeltManagerV6 {
    function reenterBelt(address member) external;
}
