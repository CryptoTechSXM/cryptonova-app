// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  FigureEightMatrix
 * @notice V7 — Two linked BFS matrices forming a figure-8 loop.
 *
 * HOW IT WORKS
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Member registers → enters Matrix A at next BFS position
 *  2. Matrix A fills (MATRIX_SIZE members) → root cycles out
 *  3. Root is funded by Follow Me Escrow, then crosses to Matrix B
 *  4. Matrix B fills → root crosses back to Matrix A
 *  5. Figure-8 loop continues forever
 *
 *  No belt, no queue — the matrix IS the conveyor.
 *  Follow Me Escrow guarantees every root can self-fund the crossing.
 *
 * PAYMENT SPLITS (per $10 entry) — V7 FINAL
 * ─────────────────────────────────────────────────────────────────────────────
 *  $2.00  L1 Referrer          20%
 *  $0.30  L2 Override           3%
 *  $0.20  L3 Override           2%
 *  $4.00  Chain Pay (BFS 7lvl) 40%
 *  $1.50  Treasury (floor)     15%  ← UNTOUCHABLE
 *  $1.00  Follow Me Escrow     10%  ← current root's crossing fund
 *  $0.50  Founder Pool          5%
 *  $0.20  Dev                   2%
 *  $0.20  Ops                   2%
 *  $0.10  Protocol Reserve      1%
 *  ──────────────────────────────
 *  $10.00                     100%
 *
 * NO-REFERRER ROUTING
 * ─────────────────────────────────────────────────────────────────────────────
 *  When L1/L2/L3 has no referrer the orphan fee routes through a health
 *  monitor instead of burning or going to a single address:
 *    - 20% → Account #1 (always, fixed)
 *    - 80% → split dynamically between Escrow and Founders based on which
 *             pool is proportionally lower (40/40 base, shifts to 60/20 or 20/60)
 *
 * MATRIX SIZE
 * ─────────────────────────────────────────────────────────────────────────────
 *  4-level test  : 15 members
 *  7-level mainnet: 127 members
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";

interface ICommunityWallet {
    function deposit(uint256 amount) external;
    function registerFounder(address member) external;
}

interface ITierManager {
    function tryAutoUpgrade(address member) external;
    function recordTreeJoin(address member, address l1, address l2, address l3) external;
}

contract FigureEightMatrix is Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────────────
    uint256 public immutable MATRIX_SIZE;  // 15 = 4-level test, 127 = 7-level mainnet
    uint256 public immutable ENTRY_FEE;   // 10_000_000 ($10 USDC, 6 dec)

    // ─── Payment splits in basis points (10,000 = 100%) ──────────────────────
    uint256 public constant SPLIT_L1_BPS       = 1500;  // 15%  $1.50  (was 20%)
    uint256 public constant SPLIT_L2_BPS       = 300;   //  3%  $0.30
    uint256 public constant SPLIT_L3_BPS       = 200;   //  2%  $0.20
    uint256 public constant SPLIT_CHAIN_BPS      = 4000;  // 40%  $4.00
    uint256 public constant SPLIT_TREASURY_BPS   = 1000;  // 10%  $1.00  (was 15% — 5% moved to secondary)
    uint256 public constant SPLIT_SECONDARY_BPS  = 500;   //  5%  $0.50  follow-the-leader: auto-credited to root escrow
    uint256 public constant SPLIT_ESCROW_BPS     = 1500;  // 15%  $1.50  (was 10% → more self-sustaining)
    uint256 public constant SPLIT_FOUNDER_BPS    = 500;   //  5%  $0.50
    uint256 public constant SPLIT_DEV_BPS        = 200;   //  2%  $0.20
    uint256 public constant SPLIT_OPS_BPS        = 200;   //  2%  $0.20
    uint256 public constant SPLIT_PROTOCOL_BPS   = 100;   //  1%  $0.10
    uint256 public constant BPS_DENOM            = 10_000;
    // Sum: 1500+300+200+4000+1000+500+1500+500+200+200+100 = 10000 ✓

    // ─── Chain pay per BFS level (7 levels, total = 40%) ─────────────────────
    // Level:  1     2    3    4    5    6    7   (% each)
    //        20%  8.0% 6.0% 3.0% 1.5% 0.75% 0.75% = 40%
    uint256[7] public chainPayBps = [2000, 800, 600, 300, 150, 75, 75];

    // ─── No-referrer routing: Account #1 always gets 20% of orphan fee ───────
    // Set at deploy via constructor. Admin can rotate via setAccountOne() for key rotation.
    // Testnet key → mainnet key on launch. Always set in accountOne_ADDRESS .env var.
    address public accountOne;

    // ─── External contracts ───────────────────────────────────────────────────
    IERC20         public immutable usdc;
    CNOVAToken     public immutable cnova;
    CNOVATreasury  public immutable treasury;
    address        public immutable devWallet;   // Dev (2%) — fixed at deploy
    address        public opsWallet;             // Ops (2%) — upgradable
    address        public founderWallet;         // Founder Pool (5%)
    address        public protocolWallet;        // Protocol Reserve (1%)
    address        public tierManager;
    address        public pairManager;           // PairManager routing contract

    // ─── Figure-8 partner ────────────────────────────────────────────────────
    FigureEightMatrix public partner;
    bool public isMatrixA;

    // ─── Circular chain routing ───────────────────────────────────────────────
    // chainNext: where B-type (isMatrixA=false) matrices cross their root TO.
    //   Default (no chainNext): B crosses back to A (simple figure-8 loop).
    //   With chainNext set:   B crosses forward to the next pair's Matrix A.
    //   Last pair's B sets chainNext = very first Matrix A → full circle.
    //
    // chainAuthorized: matrices that may call _enterMatrix on this contract.
    //   Needed because chain crossing calls come from non-partner matrices.
    //   e.g. Matrix B calls Matrix C._enterMatrix — B must be authorized in C.
    address public chainNext;
    mapping(address => bool) public chainAuthorized;

    // ─── BFS State ───────────────────────────────────────────────────────────
    mapping(address => uint256) public matrixPos;    // address → BFS position (1-based)
    mapping(uint256 => address) public posToMember;  // BFS position → address
    uint256 public occupancy;
    uint256 public nextSlot;
    uint256 public rotationCount;
    uint256 public joinCountSinceRotation;  // resets on each root cycle
    uint256 public lastRotationTimestamp;   // block.timestamp of last rotation

    // ─── Cascade guard ────────────────────────────────────────────────────────
    // Prevents recursive double-crossing when BOTH matrices are full simultaneously.
    // If a crossing is already in progress (A→B triggered B→A), the returning
    // member is queued instead of immediately re-entering, breaking the infinite loop.
    bool    private _crossingInProgress;
    address public  pendingCross;           // member parked mid-cascade, needs forceCross
    address public  pendingCrossReferrer;

    // ─── Follow Me Escrow ─────────────────────────────────────────────────────
    // Each member accumulates 10% of every entry fee paid while they are root.
    // When they cycle out this fund covers their $10 crossing fee.
    // 15-member matrix → root collects $14 escrow before cycling. Always funded.
    mapping(address => uint256) public escrowBalance;  // per-member crossing fund
    uint256 public totalEscrowHeld;                    // sum of all escrowBalance entries

    // ─── Health monitor for no-referrer routing ───────────────────────────────
    uint256 public noReferrerEscrowRouted;   // cumulative USDC routed to escrow via orphan
    uint256 public noReferrerFounderRouted;  // cumulative USDC routed to founders via orphan

    // ─── Member data ─────────────────────────────────────────────────────────
    struct Member {
        uint256 id;
        address referrer;
        address l2;
        address l3;
        uint256 joinedAt;
        uint256 withdrawable;
        uint256 totalEarned;
        uint256 cyclesCompleted;
        bool    isInMatrix;
        bool    hasEverJoined;
    }
    mapping(address => Member) public members;
    uint256 public totalJoined;

    // ─── Events ───────────────────────────────────────────────────────────────
    event MemberEntered(
        address indexed member,
        uint256 bfsPosition,
        uint256 memberId,
        address matrix
    );
    event MemberCycledOut(
        address indexed member,
        uint256 cycles,
        uint256 rotations,
        address fromMatrix
    );
    event MemberCrossedToPartner(
        address indexed member,
        address fromMatrix,
        address toMatrix
    );
    event CrossingFunded(
        address indexed member,
        uint256 fromEscrow,
        uint256 fromEarnings,
        uint256 total
    );
    event ChainPayDistributed(
        address indexed recipient,
        address indexed payer,
        uint256 level,
        uint256 amount
    );
    event EscrowCredited(
        address indexed root,
        uint256 amount,
        uint256 newBalance
    );
    event OrphanFeeRouted(
        uint256 amount,
        uint256 acct1Share,
        uint256 escrowShare,
        uint256 founderShare,
        string  source
    );
    event EarningsWithdrawn(address indexed member, uint256 amount);
    event PartnerSet(address indexed partner, bool isMatrixA);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _cnova,
        address _treasury,
        address _devWallet,
        address _opsWallet,
        address _founderWallet,
        address _protocolWallet,
        address _accountOne,
        address _admin,
        uint256 _entryFee,
        uint256 _matrixSize,
        bool    _isMatrixA
    ) Ownable(_admin) {
        require(_usdc       != address(0), "F8: zero usdc");
        require(_cnova      != address(0), "F8: zero cnova");
        require(_treasury   != address(0), "F8: zero treasury");
        require(_devWallet  != address(0), "F8: zero dev");
        require(_accountOne != address(0), "F8: zero accountOne");
        require(_entryFee   > 0,           "F8: zero fee");
        require(_matrixSize >= 3 && _matrixSize <= 1023, "F8: invalid size");

        usdc           = IERC20(_usdc);
        cnova          = CNOVAToken(_cnova);
        treasury       = CNOVATreasury(_treasury);
        devWallet      = _devWallet;
        opsWallet      = _opsWallet;
        founderWallet  = _founderWallet;
        protocolWallet = _protocolWallet;
        accountOne     = _accountOne;
        ENTRY_FEE      = _entryFee;
        MATRIX_SIZE    = _matrixSize;
        isMatrixA      = _isMatrixA;
        nextSlot       = 1;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Link the partner matrix (called once after both are deployed)
    function setPartner(address _partner) external onlyOwner {
        require(_partner != address(0),        "F8: zero partner");
        require(_partner != address(this),     "F8: self partner");
        partner = FigureEightMatrix(_partner);
        emit PartnerSet(_partner, isMatrixA);
    }

    function setTierManager(address _tm)    external onlyOwner { tierManager   = _tm; }
    function setPairManager(address _pm)    external onlyOwner { pairManager   = _pm; }

    /// @notice Set where this matrix's root crosses to in the circular chain.
    ///         Callable by admin OR pairManager (which wires the chain on addPair).
    function setChainNext(address _next) external {
        require(msg.sender == owner() || msg.sender == pairManager, "F8: not chain admin");
        chainNext = _next;
    }

    /// @notice Authorize a matrix to call _enterMatrix on this contract.
    ///         Callable by admin OR pairManager (which wires authorization on addPair).
    function setChainAuthorized(address caller, bool authorized) external {
        require(msg.sender == owner() || msg.sender == pairManager, "F8: not chain admin");
        chainAuthorized[caller] = authorized;
    }
    function setFounderWallet(address _fw)  external onlyOwner { founderWallet = _fw; }
    function setProtocolWallet(address _pw) external onlyOwner { protocolWallet = _pw; }
    function setOpsWallet(address _ow)      external onlyOwner { opsWallet     = _ow; }

    /// @notice Rotate Account #1 address (key rotation between testnet and mainnet,
    ///         or if the key is ever compromised). Earnings already credited stay
    ///         on the old address — only future orphan fees route to the new address.
    function setAccountOne(address _accountOne) external onlyOwner {
        require(_accountOne != address(0), "F8: zero accountOne");
        accountOne = _accountOne;
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Register and enter the figure-8.
     *         New members always enter Matrix A first.
     * @param  referrer  Sponsor address (address(0) = no referrer, orphan routing applies)
     */
    function register(address referrer) external {
        require(
            !members[msg.sender].hasEverJoined || !members[msg.sender].isInMatrix,
            "F8: already in matrix"
        );
        require(address(partner) != address(0), "F8: partner not set");

        // Always enter Matrix A
        FigureEightMatrix entry = isMatrixA ? this : partner;
        usdc.safeTransferFrom(msg.sender, address(entry), ENTRY_FEE);
        entry._enterMatrix(msg.sender, referrer);
    }

    /**
     * @notice PairManager entry — called by PairManager.register() on behalf of a member.
     *         PairManager transfers ENTRY_FEE to this contract, then calls enterFor().
     *         Members only need to approve PairManager, not each individual Matrix A.
     */
    function enterFor(address member, address referrer) external {
        require(msg.sender == pairManager, "F8: not pairManager");
        require(!members[member].hasEverJoined || !members[member].isInMatrix,
            "F8: already in matrix");
        require(address(partner) != address(0), "F8: partner not set");
        // Call via this. because _enterMatrix is external (needed for partner cross-calls)
        this._enterMatrix(member, referrer);
    }

    /**
     * @notice Internal entry — called by register(), enterFor(), and by partner on re-entry/crossing.
     *         Public visibility required so partner contract can call it.
     */
    function _enterMatrix(address member, address referrer) external {
        // Authorized: self, figure-8 partner, PairManager, OR chain-authorized (circular chain)
        require(
            msg.sender == address(this) ||
            msg.sender == address(partner) ||
            msg.sender == pairManager ||
            chainAuthorized[msg.sender],
            "F8: not authorized"
        );
        require(!members[member].isInMatrix, "F8: already in matrix");

        // Pull ENTRY_FEE from the crossing caller (partner or chain-authorized matrix)
        if (msg.sender == address(partner) || chainAuthorized[msg.sender]) {
            usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);
        }

        // Track joins per cycle (informational, used by keeper bot)
        joinCountSinceRotation += 1;

        // First-time member setup
        if (!members[member].hasEverJoined) {
            totalJoined += 1;
            address l1 = (referrer != address(0) && members[referrer].hasEverJoined)
                ? referrer : address(0);
            address l2 = l1 != address(0) ? members[l1].referrer : address(0);
            address l3 = l2 != address(0) ? members[l2].referrer : address(0);

            members[member] = Member({
                id:              totalJoined,
                referrer:        l1,
                l2:              l2,
                l3:              l3,
                joinedAt:        block.timestamp,
                withdrawable:    0,
                totalEarned:     0,
                cyclesCompleted: 0,
                isInMatrix:      false,
                hasEverJoined:   true
            });

            if (founderWallet != address(0)) {
                try ICommunityWallet(founderWallet).registerFounder(member) {} catch {}
            }
            if (tierManager != address(0)) {
                try ITierManager(tierManager).recordTreeJoin(
                    member,
                    members[member].referrer,
                    members[member].l2,
                    members[member].l3
                ) {} catch {}
            }
        }

        // Place in BFS tree
        if (occupancy < MATRIX_SIZE) {
            // Matrix not yet full — append at next slot
            _placeInMatrix(member, nextSlot);
            nextSlot  += 1;
            occupancy += 1;
        } else {
            // Matrix full → cycle root out (occupancy-=1), shift everyone, place new member
            _cycleOutRoot();
            _placeInMatrix(member, nextSlot);  // nextSlot == MATRIX_SIZE after shift
            occupancy += 1;                    // back to MATRIX_SIZE (1 out, 1 in)
        }

        // Distribute payments
        _distributePayments(member);

        // Mint CNOVA reward
        try cnova.mintReward(member, 0) {} catch {}  // V6/V7 single-tier: always T1 (index 0)

        emit MemberEntered(member, matrixPos[member], members[member].id, address(this));
    }

    // ─── Internal: Matrix Mechanics ───────────────────────────────────────────

    function _placeInMatrix(address member, uint256 slot) internal {
        matrixPos[member]          = slot;
        posToMember[slot]          = member;
        members[member].isInMatrix = true;
    }

    function _cycleOutRoot() internal {
        address root = posToMember[1];
        require(root != address(0), "F8: no root");

        // Remove root from BFS
        matrixPos[root]               = 0;
        posToMember[1]                = address(0);
        members[root].isInMatrix      = false;
        members[root].cyclesCompleted += 1;
        occupancy               -= 1;
        rotationCount           += 1;
        joinCountSinceRotation   = 0;
        lastRotationTimestamp    = block.timestamp;  // track when last activity happened

        // Shift all BFS positions up by 1 (O(n) — acceptable for ≤127 members)
        for (uint256 i = 1; i < MATRIX_SIZE; i++) {
            address m      = posToMember[i + 1];
            posToMember[i]     = m;
            posToMember[i + 1] = address(0);
            if (m != address(0)) matrixPos[m] = i;
        }
        nextSlot = MATRIX_SIZE;  // last slot now open for new member

        emit MemberCycledOut(root, members[root].cyclesCompleted, rotationCount, address(this));

        if (tierManager != address(0)) {
            try ITierManager(tierManager).tryAutoUpgrade(root) {} catch {}
        }

        // Figure-8: root automatically enters partner matrix
        _crossToPartner(root);
    }

    /**
     * @notice Fund and execute the figure-8 crossing.
     *         Priority order:
     *           1. Escrow balance (Follow Me Escrow, built up while they were root)
     *           2. Withdrawable earnings
     *           3. Neither sufficient → park here, keeper bot calls forceCross()
     *
     *         CASCADE GUARD: If _crossingInProgress is set (we're already mid-crossing),
     *         the partner matrix is full AND trying to cross back to us. Parking the
     *         member here breaks the infinite loop. check_stuck.js / forceCross() recovers them.
     *         This can only happen if BOTH matrices are simultaneously full — a signal that
     *         a new matrix pair should be deployed (>80% capacity rule).
     */
    function _crossToPartner(address member) internal {
        require(address(partner) != address(0), "F8: no partner");

        // Cascade guard: both matrices full simultaneously → park and wait for forceCross
        if (_crossingInProgress) {
            pendingCross         = member;
            pendingCrossReferrer = members[member].referrer;
            return;
        }

        uint256 reentryFee = ENTRY_FEE;
        uint256 esc        = escrowBalance[member];
        uint256 earnings   = members[member].withdrawable;

        uint256 fromEscrow;
        uint256 fromEarnings;

        if (esc >= reentryFee) {
            fromEscrow = reentryFee;
        } else {
            fromEscrow = esc;
            uint256 needed = reentryFee - esc;
            if (earnings >= needed) {
                fromEarnings = needed;
            } else {
                return;  // insufficient — park, keeper bot will forceCross()
            }
        }

        if (fromEscrow > 0) {
            escrowBalance[member] -= fromEscrow;
            totalEscrowHeld       -= fromEscrow;
        }
        if (fromEarnings > 0) {
            members[member].withdrawable -= fromEarnings;
        }

        emit CrossingFunded(member, fromEscrow, fromEarnings, reentryFee);

        // ── Circular chain routing ─────────────────────────────────────────────
        // B-type matrices (isMatrixA=false) with chainNext set cross FORWARD in
        // the circular chain (B→C→D→...→A) instead of looping back to partner.
        // A-type matrices always cross to their figure-8 partner.
        address destination;
        if (!isMatrixA && chainNext != address(0)) {
            destination = chainNext;   // forward: B→C, D→E, ..., lastB→A
        } else {
            destination = address(partner);  // figure-8 or fallback
        }

        SafeERC20.forceApprove(usdc, destination, reentryFee);

        _crossingInProgress = true;
        emit MemberCrossedToPartner(member, address(this), destination);
        FigureEightMatrix(destination)._enterMatrix(member, members[member].referrer);
        _crossingInProgress = false;
    }

    // ─── Internal: Payment Distribution ──────────────────────────────────────

    function _distributePayments(address newMember) internal {
        Member storage m = members[newMember];

        // ── L1 Referral (20%) ────────────────────────────────────────────────
        uint256 l1Amt = ENTRY_FEE * SPLIT_L1_BPS / BPS_DENOM;  // $2.00
        if (m.referrer != address(0)) {
            _credit(m.referrer, l1Amt);
        } else {
            _routeOrphanFee(l1Amt, "L1");
        }

        // ── L2 Override (3%) ─────────────────────────────────────────────────
        uint256 l2Amt = ENTRY_FEE * SPLIT_L2_BPS / BPS_DENOM;  // $0.30
        if (m.l2 != address(0)) {
            _credit(m.l2, l2Amt);
        } else {
            _routeOrphanFee(l2Amt, "L2");
        }

        // ── L3 Override (2%) ─────────────────────────────────────────────────
        uint256 l3Amt = ENTRY_FEE * SPLIT_L3_BPS / BPS_DENOM;  // $0.20
        if (m.l3 != address(0)) {
            _credit(m.l3, l3Amt);
        } else {
            _routeOrphanFee(l3Amt, "L3");
        }

        // ── Chain Pay — BFS tree (40%) ────────────────────────────────────────
        _distributeChainPay(newMember);

        // ── Treasury (10%) ────────────────────────────────────────────────────
        uint256 treasuryAmt = ENTRY_FEE * SPLIT_TREASURY_BPS / BPS_DENOM;  // $1.00
        SafeERC20.forceApprove(usdc, address(treasury), treasuryAmt);
        treasury.depositReserve(treasuryAmt);

        // ── Follow Me Escrow (15%) → current root's crossing fund ────────────
        // Every member who joins contributes $1.50 to the root at pos 1.
        // 127-member matrix = root receives $189 before cycling. Always funded.
        uint256 escrowAmt   = ENTRY_FEE * SPLIT_ESCROW_BPS / BPS_DENOM;    // $1.50
        address currentRoot = posToMember[1];
        if (currentRoot != address(0) && currentRoot != newMember) {
            escrowBalance[currentRoot] += escrowAmt;
            totalEscrowHeld           += escrowAmt;
            emit EscrowCredited(currentRoot, escrowAmt, escrowBalance[currentRoot]);
        } else {
            // No root yet (very first member) → protocol reserve holds it
            if (protocolWallet != address(0)) usdc.safeTransfer(protocolWallet, escrowAmt);
        }

        // ── Secondary Sponsor (5%) → root escrow (follow-the-leader) ─────────
        // Funded from treasury reduction (15%→10%). The member at pos 1 is the
        // "one in front" — they auto-earn 5% from every new joiner behind them.
        // This gives every member a guaranteed passive income stream and reduces
        // worst-case self-funding referrals from 4 → 3 at MSIZE=127.
        uint256 secondaryAmt = ENTRY_FEE * SPLIT_SECONDARY_BPS / BPS_DENOM; // $0.50
        if (currentRoot != address(0) && currentRoot != newMember) {
            escrowBalance[currentRoot] += secondaryAmt;
            totalEscrowHeld           += secondaryAmt;
            emit EscrowCredited(currentRoot, secondaryAmt, escrowBalance[currentRoot]);
        } else {
            if (protocolWallet != address(0)) usdc.safeTransfer(protocolWallet, secondaryAmt);
        }

        // ── Founder Pool (5%) ─────────────────────────────────────────────────
        uint256 founderAmt = ENTRY_FEE * SPLIT_FOUNDER_BPS / BPS_DENOM;    // $0.50
        if (founderWallet != address(0)) {
            usdc.safeTransfer(founderWallet, founderAmt);
            uint256 sz; address fw = founderWallet;
            assembly { sz := extcodesize(fw) }
            if (sz > 0) {
                try ICommunityWallet(founderWallet).deposit(founderAmt) {} catch {}
            }
        }

        // ── Dev (2%) ──────────────────────────────────────────────────────────
        uint256 devAmt = ENTRY_FEE * SPLIT_DEV_BPS / BPS_DENOM;            // $0.20
        usdc.safeTransfer(devWallet, devAmt);

        // ── Ops (2%) ──────────────────────────────────────────────────────────
        uint256 opsAmt = ENTRY_FEE * SPLIT_OPS_BPS / BPS_DENOM;            // $0.20
        if (opsWallet != address(0)) {
            usdc.safeTransfer(opsWallet, opsAmt);
        } else if (protocolWallet != address(0)) {
            // Fallback to protocol wallet if ops not configured
            usdc.safeTransfer(protocolWallet, opsAmt);
        }

        // ── Protocol Reserve (1%) ─────────────────────────────────────────────
        uint256 protocolAmt = ENTRY_FEE * SPLIT_PROTOCOL_BPS / BPS_DENOM;  // $0.10
        if (protocolWallet != address(0)) {
            usdc.safeTransfer(protocolWallet, protocolAmt);
        }
    }

    /**
     * @notice Route orphan referral fee through the health monitor.
     *         Called when L1/L2/L3 has no valid referrer.
     *
     *         Distribution:
     *           20% → Account #1 (always fixed)
     *           80% → Escrow / Founders split (health-weighted)
     *
     * @param amount  USDC in 6-decimal units
     * @param source  "L1", "L2", or "L3" for event logging
     */
    function _routeOrphanFee(uint256 amount, string memory source) internal {
        if (amount == 0) return;

        // Account #1 always gets 20% of any orphan fee
        uint256 acct1Share = amount * 20 / 100;
        _credit(accountOne, acct1Share);

        uint256 remaining = amount - acct1Share;  // 80% to health-route

        // Ask health monitor which pool needs more
        (uint256 escrowBps, uint256 founderBps) = _getOrphanRoutingRatios();
        uint256 denom        = escrowBps + founderBps;
        uint256 escrowShare  = remaining * escrowBps / denom;
        uint256 founderShare = remaining - escrowShare;

        // ── Route to current root's escrow ────────────────────────────────────
        address currentRoot = posToMember[1];
        if (currentRoot != address(0)) {
            escrowBalance[currentRoot] += escrowShare;
            totalEscrowHeld           += escrowShare;
            noReferrerEscrowRouted    += escrowShare;
        } else {
            // No root (empty matrix shouldn't happen in practice)
            _credit(accountOne, escrowShare);
        }

        // ── Route to founder pool ─────────────────────────────────────────────
        if (founderShare > 0) {
            if (founderWallet != address(0)) {
                usdc.safeTransfer(founderWallet, founderShare);
                noReferrerFounderRouted += founderShare;
                uint256 sz; address fw = founderWallet;
                assembly { sz := extcodesize(fw) }
                if (sz > 0) {
                    try ICommunityWallet(founderWallet).deposit(founderShare) {} catch {}
                }
            } else {
                _credit(accountOne, founderShare);  // fallback
            }
        }

        emit OrphanFeeRouted(amount, acct1Share, escrowShare, founderShare, source);
    }

    /**
     * @notice Return BPS weights for orphan-fee routing between escrow and founders.
     *
     *   Healthy (both ~50%)     → 4000 / 4000  (40% / 40%)
     *   Escrow  < 35% of total  → 6000 / 2000  (60% / 20%)  boost escrow
     *   Founders < 35% of total → 2000 / 6000  (20% / 60%)  boost founders
     */
    function _getOrphanRoutingRatios()
        internal view
        returns (uint256 escrowBps, uint256 founderBps)
    {
        uint256 total = noReferrerEscrowRouted + noReferrerFounderRouted;
        if (total == 0) {
            return (4000, 4000);  // default: balanced
        }

        uint256 escrowPct = noReferrerEscrowRouted * 100 / total;

        if (escrowPct < 35) {
            return (6000, 2000);  // escrow is underfunded
        } else if (escrowPct > 65) {
            return (2000, 6000);  // founders are underfunded
        }
        return (4000, 4000);      // balanced
    }

    /**
     * @notice Distribute chain pay up the BFS tree (7 levels).
     *         Members closer to root receive more (level 1 = most).
     */
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

    function withdraw() external {
        uint256 amount = members[msg.sender].withdrawable;
        require(amount > 0, "F8: nothing to withdraw");
        members[msg.sender].withdrawable = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit EarningsWithdrawn(msg.sender, amount);
    }

    // ─── Admin: forceCross — keeper bot backup ────────────────────────────────

    /**
     * @notice Owner/keeper can force-cross a member who couldn't self-fund.
     *         Caller must approve ENTRY_FEE to this contract before calling.
     *         Used when escrow + earnings < ENTRY_FEE (should be rare with escrow).
     */
    function forceCross(address member) external onlyOwner {
        require(members[member].hasEverJoined,  "F8: not a member");
        require(!members[member].isInMatrix,    "F8: still in matrix");
        require(address(partner) != address(0), "F8: no partner");

        usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);

        // Use circular chain routing (same logic as _crossToPartner)
        address destination = (!isMatrixA && chainNext != address(0))
            ? chainNext : address(partner);
        SafeERC20.forceApprove(usdc, destination, ENTRY_FEE);

        emit MemberCrossedToPartner(member, address(this), destination);
        FigureEightMatrix(destination)._enterMatrix(member, members[member].referrer);
    }

    // ─── Admin: deductWithdrawable (tier manager upgrades) ───────────────────

    function deductWithdrawable(address member, uint256 amount) external {
        require(msg.sender == tierManager, "F8: not tier manager");
        require(members[member].withdrawable >= amount, "F8: insufficient");
        members[member].withdrawable -= amount;
        usdc.safeTransfer(msg.sender, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getMember(address member) external view returns (Member memory) {
        return members[member];
    }

    function getCyclesCompleted(address member) external view returns (uint256) {
        return members[member].cyclesCompleted;
    }

    function withdrawableOf(address member) external view returns (uint256) {
        return members[member].withdrawable;
    }

    /// @notice Escrow balance only (Follow Me crossing fund)
    function escrowOf(address member) external view returns (uint256) {
        return escrowBalance[member];
    }

    /// @notice Combined crossing funds (escrow + earnings) for a cycled-out member
    function crossingFundsOf(address member)
        external view
        returns (uint256 total, uint256 fromEscrow, uint256 fromEarnings)
    {
        fromEscrow   = escrowBalance[member];
        fromEarnings = members[member].withdrawable;
        total        = fromEscrow + fromEarnings;
    }

    function isFull() external view returns (bool) {
        return occupancy == MATRIX_SIZE;
    }

    /// @notice Returns any member parked by the cascade guard (both matrices full).
    ///         Keeper bot calls forceCross(pendingCross) when this is non-zero.
    function getPendingCross() external view returns (address member, address referrer)
    {
        return (pendingCross, pendingCrossReferrer);
    }

    /// @notice Snapshot of orphan-fee health ratios for off-chain monitoring.
    function poolHealthSnapshot()
        external view
        returns (
            uint256 escrowRouted,
            uint256 foundersRouted,
            uint256 escrowPct,
            string memory healthState
        )
    {
        escrowRouted   = noReferrerEscrowRouted;
        foundersRouted = noReferrerFounderRouted;
        uint256 total  = escrowRouted + foundersRouted;
        if (total == 0) {
            escrowPct   = 0;
            healthState = "EMPTY";
        } else {
            escrowPct = escrowRouted * 100 / total;
            if (escrowPct < 35) {
                healthState = "LOW_ESCROW";
            } else if (escrowPct > 65) {
                healthState = "HIGH_ESCROW";
            } else {
                healthState = "BALANCED";
            }
        }
    }
}
