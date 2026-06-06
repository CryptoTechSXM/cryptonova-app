// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  FigureEightMatrixV8
 * @notice V8.1 "Elevator" — BFS matrix with TierRouter integration,
 *         deficit-weighted equalization pool, StabilityFund hooks,
 *         and no-idle-member guarantees.
 *
 * V8.1 CHANGES (Option B BPS)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Equalization Pool (Option B)
 *       SPLIT_ESCROW_BPS + SPLIT_SECONDARY_BPS replaced by SPLIT_POOL_BPS
 *       + SPLIT_STABILITY_BPS. Chain pay halved (4000→2000 T1-T5, 3500→1750
 *       T6-T7). Freed BPS flows into equalization pool accumulated per-entry.
 *       On every cycle-out, pool distributes to all non-root members (pos 2..N)
 *       weighted by BFS position (deeper = larger deficit = larger share).
 *
 *       BPS table:
 *         T1-T3: l1=2500, l2=300, l3=200, chain=2000, pool=3800, treasury=500,
 *                devOps=500, stability=200  (sum=10000)
 *         T4-T5: l1=2500, l2=300, l3=200, chain=2000, pool=3300, treasury=800,
 *                devOps=700, stability=200  (sum=10000)
 *         T6-T7: l1=2500, l2=300, l3=200, chain=1750, pool=3050, treasury=1200,
 *                devOps=800, stability=200  (sum=10000)
 *
 *  2. StabilityFund hooks (zero treasury — treasury is SACRED)
 *       L1: 200 bps per entry (permanent)  → receiveLayer(tier, amt, 1)
 *       L3: withdrawal health fee 1.5%     → receiveLayer(tier, amt, 3)
 *       L5: early exit penalty 20%         → receiveLayer(tier, amt, 5)
 *       Fallback to devOpsWallet if StabilityFund not yet set.
 *
 *  3. Activity tracking
 *       lastActivityTime[member] updated on every _credit() and matrix entry.
 *       MatrixKeeper reads getIdleSeconds() to detect idle slots.
 *
 *  4. reclaimIdleSlot() — keeper-only
 *       Removes idle member from BFS tree. Earnings/escrow untouched.
 *
 *  5. earlyEscrowRelease() — member opt-in
 *       Release escrow early with penalty. Penalty → StabilityFund L5.
 *
 *  6. Governance-adjustable fee parameters (enumerated menus, DAO-votable)
 *       withdrawalFeeBps: 50/100/150/200/250 (default 150 = 1.5%)
 *       earlyExitPenaltyBps: 1000/1500/2000/2500 (default 2000 = 20%)
 *
 * V8 CHANGES (carried forward from Phase 1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Dynamic crossing fee (reads destination.ENTRY_FEE() at crossing time)
 *  2. Per-tier BPS splits passed in constructor (all immutable)
 *  3. TierRouter callback on Matrix B cycle-out
 *  4. deductForUpgrade() callable by TierRouter only
 *  5. 6-level chain pay (configurable per-tier via constructor)
 *  6. Single devOpsWallet
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";

interface ICommunityWalletV8 {
    function deposit(uint256 amount) external;
}

interface ITierRouter {
    function handleCycleOut(
        address member,
        uint8   tierIndex,
        uint256 escrow,
        uint256 withdrawable
    ) external;
}

/// @notice Minimal interface for forwarding stability fund contributions.
interface IStabilityFund {
    /// @param tierIdx  0-6 = T1-T7
    /// @param amount   USDC amount (6 decimals)
    /// @param layer    1=pool-carve, 2=referral-carve, 3=withdrawal-fee, 4=devops, 5=exit-penalty
    function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external;
}

contract FigureEightMatrixV8 is Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────────────
    uint256 public immutable MATRIX_SIZE;
    uint256 public immutable ENTRY_FEE;
    bool    public immutable isMatrixA;
    uint8   public immutable tierIndex;          // 0=T1, 1=T2, ..., 6=T7

    // ─── Per-tier BPS splits (immutable, set in constructor) ──────────────────
    uint256 public immutable SPLIT_L1_BPS;        // 2500 all tiers
    uint256 public immutable SPLIT_L2_BPS;        // 300  all tiers
    uint256 public immutable SPLIT_L3_BPS;        // 200  all tiers
    uint256 public immutable SPLIT_CHAIN_BPS;     // 2000 T1-T5, 1750 T6-T7  (V8.1: halved)
    uint256 public immutable SPLIT_POOL_BPS;      // 3800/3300/3050 — equalization pool
    uint256 public immutable SPLIT_TREASURY_BPS;  // 500/800/1200 per tier group
    uint256 public immutable SPLIT_DEVOPS_BPS;    // 500/700/800 per tier group
    uint256 public immutable SPLIT_STABILITY_BPS; // 200 all tiers — L1 carve to StabilityFund
    uint256 public constant  BPS_DENOM = 10_000;

    // ─── Chain pay weights per BFS level (6 levels in V8) ────────────────────
    uint256[6] public chainPayBps;

    // ─── External contracts ───────────────────────────────────────────────────
    IERC20         public immutable usdc;
    CNOVAToken     public immutable cnova;
    CNOVATreasury  public immutable treasury;
    address        public immutable devOpsWallet;  // combined dev+ops+protocol
    address        public tierRouter;              // TierRouter — set post-deploy
    address        public pairManager;             // PairManager — set post-deploy
    address        public accountOne;              // orphan fee fallback
    address        public stabilityFund;           // StabilityFund.sol — set post-deploy
    address        public matrixKeeper;            // MatrixKeeper (Chainlink) — set post-deploy

    // ─── Figure-8 partner ────────────────────────────────────────────────────
    FigureEightMatrixV8 public partner;

    // ─── Circular chain (multi-pair within same tier) ────────────────────────
    address public chainNext;
    mapping(address => bool) public chainAuthorized;

    // ─── BFS State ───────────────────────────────────────────────────────────
    mapping(address => uint256) public matrixPos;
    mapping(uint256 => address) public posToMember;
    uint256 public occupancy;
    uint256 public nextSlot;
    uint256 public rotationCount;
    uint256 public joinCountSinceRotation;
    uint256 public lastRotationTimestamp;

    // ─── Cascade guard ────────────────────────────────────────────────────────
    bool    private _crossingInProgress;
    address public  pendingCross;
    address public  pendingCrossReferrer;

    // ─── V8.1: Equalization Pool ──────────────────────────────────────────────
    /// @notice Accumulates SPLIT_POOL_BPS per entry. Distributed deficit-weighted
    ///         to all non-root members (pos 2..N) on every cycle-out.
    uint256 public poolAccumulator;

    // ─── V8.1: Activity Tracking ─────────────────────────────────────────────
    /// @notice Last timestamp a member received any credit or entered the matrix.
    ///         MatrixKeeper monitors this for idle slot reclaiming.
    mapping(address => uint256) public lastActivityTime;

    // ─── V8.1: Governance parameters (DAO-votable, enumerated values only) ───
    /// @notice Withdrawal health fee in BPS. Default 150 (1.5%). Feeds L3.
    uint256 public withdrawalFeeBps    = 150;
    /// @notice Early exit penalty in BPS. Default 2000 (20%). Feeds L5.
    uint256 public earlyExitPenaltyBps = 2000;

    // ─── Follow Me Escrow (used for crossing logic, funded by orphan routing) ─
    mapping(address => uint256) public escrowBalance;
    uint256 public totalEscrowHeld;

    // ─── Orphan fee health monitor ────────────────────────────────────────────
    uint256 public noReferrerEscrowRouted;
    uint256 public noReferrerFounderRouted;

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
    event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix);
    event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix);
    event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix);
    event CrossingFunded(address indexed member, uint256 fromEscrow, uint256 fromEarnings, uint256 total);
    event ChainPayDistributed(address indexed recipient, address indexed payer, uint256 level, uint256 amount);
    event EscrowCredited(address indexed root, uint256 amount, uint256 newBalance);
    event OrphanFeeRouted(uint256 amount, uint256 acct1Share, uint256 escrowShare, uint256 founderShare, string source);
    event EarningsWithdrawn(address indexed member, uint256 amount);
    event PartnerSet(address indexed partner, bool isMatrixA);
    event UpgradeFundsDeducted(address indexed member, uint256 escrowAmt, uint256 withdrawableAmt);
    // V8.1 events
    event PoolDistributed(uint256 totalPool, uint256 cycleNumber);
    event PoolShareCredited(address indexed member, uint256 position, uint256 amount);
    event StabilityContribution(uint8 indexed tier, uint256 amount, uint8 layer);
    event SlotReclaimed(address indexed member, uint256 position, uint256 idleDuration);
    event EarlyEscrowRelease(address indexed member, uint256 escrow, uint256 penalty, uint256 payout);
    event WithdrawalFeeCharged(address indexed member, uint256 fee);
    event StabilityFundSet(address indexed addr);
    event MatrixKeeperSet(address indexed addr);

    // ─── Constructor split config struct ──────────────────────────────────────
    /// @notice V8.1: escrowBps and secondaryBps replaced by poolBps and stabilityBps.
    struct SplitConfig {
        uint256 l1Bps;
        uint256 l2Bps;
        uint256 l3Bps;
        uint256 chainBps;
        uint256 poolBps;        // equalization pool (replaces escrow + secondary)
        uint256 treasuryBps;
        uint256 devOpsBps;
        uint256 stabilityBps;   // per-entry L1 carve to StabilityFund
        // Sum must == 10,000
    }

    /// @dev Packs the 6 address constructor args into a single memory pointer,
    ///      keeping the total stack depth below the EVM's 16-slot limit when
    ///      MatrixFactory deploys a new instance.
    struct DeployParams {
        address usdc;
        address cnova;
        address treasury;
        address devOpsWallet;
        address accountOne;
        address admin;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        DeployParams memory _p,
        uint256      _entryFee,
        uint256      _matrixSize,
        bool         _isMatrixA,
        uint8        _tierIndex,
        SplitConfig  memory _splits,
        uint256[6]   memory _chainPayBps
    ) Ownable(_p.admin) {
        require(_p.usdc         != address(0), "F8V8: zero usdc");
        require(_p.cnova        != address(0), "F8V8: zero cnova");
        require(_p.treasury     != address(0), "F8V8: zero treasury");
        require(_p.devOpsWallet != address(0), "F8V8: zero devOps");
        require(_p.accountOne   != address(0), "F8V8: zero accountOne");
        require(_entryFee     > 0,             "F8V8: zero fee");
        require(_matrixSize   >= 3 && _matrixSize <= 1023, "F8V8: invalid size");
        require(_tierIndex    < 7,             "F8V8: invalid tier");

        // V8.1: validate new split fields (poolBps + stabilityBps replace escrow + secondary)
        uint256 sum = _splits.l1Bps + _splits.l2Bps + _splits.l3Bps
            + _splits.chainBps + _splits.poolBps
            + _splits.treasuryBps + _splits.devOpsBps + _splits.stabilityBps;
        require(sum == BPS_DENOM, "F8V8: splits != 10000");

        usdc         = IERC20(_p.usdc);
        cnova        = CNOVAToken(_p.cnova);
        treasury     = CNOVATreasury(_p.treasury);
        devOpsWallet = _p.devOpsWallet;
        accountOne   = _p.accountOne;
        ENTRY_FEE    = _entryFee;
        MATRIX_SIZE  = _matrixSize;
        isMatrixA    = _isMatrixA;
        tierIndex    = _tierIndex;
        nextSlot     = 1;

        SPLIT_L1_BPS        = _splits.l1Bps;
        SPLIT_L2_BPS        = _splits.l2Bps;
        SPLIT_L3_BPS        = _splits.l3Bps;
        SPLIT_CHAIN_BPS     = _splits.chainBps;
        SPLIT_POOL_BPS      = _splits.poolBps;
        SPLIT_TREASURY_BPS  = _splits.treasuryBps;
        SPLIT_DEVOPS_BPS    = _splits.devOpsBps;
        SPLIT_STABILITY_BPS = _splits.stabilityBps;

        for (uint256 i = 0; i < 6; i++) {
            chainPayBps[i] = _chainPayBps[i];
        }
    }

    // ─── Admin setters ────────────────────────────────────────────────────────

    function setPartner(address _partner) external onlyOwner {
        require(_partner != address(0),    "F8V8: zero partner");
        require(_partner != address(this), "F8V8: self partner");
        partner = FigureEightMatrixV8(_partner);
        emit PartnerSet(_partner, isMatrixA);
    }

    function setTierRouter(address _tr) external onlyOwner {
        tierRouter = _tr;
    }

    function setPairManager(address _pm) external onlyOwner {
        pairManager = _pm;
    }

    function setAccountOne(address _a1) external onlyOwner {
        require(_a1 != address(0), "F8V8: zero");
        accountOne = _a1;
    }

    function setChainNext(address _next) external {
        require(
            msg.sender == owner() || msg.sender == pairManager,
            "F8V8: not chain admin"
        );
        chainNext = _next;
    }

    function setChainAuthorized(address caller, bool authorized) external {
        require(
            msg.sender == owner()      ||
            msg.sender == pairManager  ||
            msg.sender == tierRouter,
            "F8V8: not chain admin"
        );
        chainAuthorized[caller] = authorized;
    }

    /// @notice V8.1: Set StabilityFund address. Call once immediately after deploy.
    ///         Until set, stability contributions route to devOpsWallet as escrow.
    function setStabilityFund(address _sf) external onlyOwner {
        require(_sf != address(0), "F8V8: zero stabilityFund");
        stabilityFund = _sf;
        emit StabilityFundSet(_sf);
    }

    /// @notice V8.1: Set MatrixKeeper (Chainlink Automation) address.
    function setMatrixKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "F8V8: zero keeper");
        matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    // ─── Governance setters (DAO-votable, enumerated menus only) ─────────────

    /// @notice Adjust withdrawal health fee. Allowed: 50, 100, 150, 200, 250.
    ///         Default 150 (1.5%). Callable by owner or TierRouter (DAO gateway).
    function setWithdrawalFeeBps(uint256 _bps) external {
        require(msg.sender == owner() || msg.sender == tierRouter, "F8V8: not governance");
        require(
            _bps == 50 || _bps == 100 || _bps == 150 || _bps == 200 || _bps == 250,
            "F8V8: invalid fee (allowed: 50,100,150,200,250)"
        );
        withdrawalFeeBps = _bps;
    }

    /// @notice Adjust early exit penalty. Allowed: 1000, 1500, 2000, 2500.
    ///         Default 2000 (20%). Callable by owner or TierRouter (DAO gateway).
    function setEarlyExitPenaltyBps(uint256 _bps) external {
        require(msg.sender == owner() || msg.sender == tierRouter, "F8V8: not governance");
        require(
            _bps == 1000 || _bps == 1500 || _bps == 2000 || _bps == 2500,
            "F8V8: invalid penalty (allowed: 1000,1500,2000,2500)"
        );
        earlyExitPenaltyBps = _bps;
    }

    // ─── TierRouter: fund extraction ─────────────────────────────────────────

    /**
     * @notice Pull upgrade funds from member's escrow and/or withdrawable.
     *         Called exclusively by TierRouter during handleCycleOut routing.
     *         In V8.1, primary upgrade fuel is withdrawable (escrow is small,
     *         funded only by orphan routing). TierRouter checks combined balance.
     */
    function deductForUpgrade(
        address member,
        uint256 escrowAmt,
        uint256 withdrawableAmt
    ) external {
        require(msg.sender == tierRouter, "F8V8: not tierRouter");

        if (escrowAmt > 0) {
            require(escrowBalance[member] >= escrowAmt, "F8V8: insufficient escrow");
            escrowBalance[member] -= escrowAmt;
            totalEscrowHeld       -= escrowAmt;
        }
        if (withdrawableAmt > 0) {
            require(
                members[member].withdrawable >= withdrawableAmt,
                "F8V8: insufficient earnings"
            );
            members[member].withdrawable -= withdrawableAmt;
        }

        uint256 total = escrowAmt + withdrawableAmt;
        if (total > 0) {
            usdc.safeTransfer(tierRouter, total);
        }

        emit UpgradeFundsDeducted(member, escrowAmt, withdrawableAmt);
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /// @notice Direct register (testnet convenience — bypasses TierRouter).
    function register(address referrer) external {
        require(
            !members[msg.sender].hasEverJoined || !members[msg.sender].isInMatrix,
            "F8V8: already in matrix"
        );
        require(address(partner) != address(0), "F8V8: partner not set");

        FigureEightMatrixV8 entry = isMatrixA ? this : partner;
        usdc.safeTransferFrom(msg.sender, address(entry), ENTRY_FEE);
        entry._enterMatrix(msg.sender, referrer);
    }

    /// @notice PairManager entry — called by PairManager.enterFor().
    function enterFor(address member, address referrer) external {
        require(msg.sender == pairManager, "F8V8: not pairManager");
        require(
            !members[member].hasEverJoined || !members[member].isInMatrix,
            "F8V8: already in matrix"
        );
        require(address(partner) != address(0), "F8V8: partner not set");
        this._enterMatrix(member, referrer);
    }

    /// @notice Internal entry point. Public so partner and chain-authorized matrices
    ///         can call it for crossings.
    function _enterMatrix(address member, address referrer) external {
        require(
            msg.sender == address(this)    ||
            msg.sender == address(partner) ||
            msg.sender == pairManager      ||
            chainAuthorized[msg.sender],
            "F8V8: not authorized"
        );
        require(!members[member].isInMatrix, "F8V8: already in matrix");

        if (msg.sender == address(partner) || chainAuthorized[msg.sender]) {
            usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);
        }

        joinCountSinceRotation   += 1;
        lastActivityTime[member]  = block.timestamp;

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
        }

        if (occupancy < MATRIX_SIZE) {
            _placeInMatrix(member, nextSlot);
            nextSlot  += 1;
            occupancy += 1;
        } else {
            // Full matrix: distribute pool then cycle out root, place new member
            _cycleOutRoot();
            _placeInMatrix(member, nextSlot);
            occupancy += 1;
        }

        _distributePayments(member);

        try cnova.mintReward(member, tierIndex) {} catch {}  // V8.1: pass tier for multiplier

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
        require(root != address(0), "F8V8: no root");

        // ── V8.1: Distribute equalization pool BEFORE shifting ────────────────
        // Pool distributes to positions 2..MATRIX_SIZE (non-root, all present members).
        // Must happen before renumbering so weights match current BFS depth order.
        _distributePool();

        matrixPos[root]               = 0;
        posToMember[1]                = address(0);
        members[root].isInMatrix      = false;
        members[root].cyclesCompleted += 1;
        occupancy                -= 1;
        rotationCount            += 1;
        joinCountSinceRotation    = 0;
        lastRotationTimestamp     = block.timestamp;

        for (uint256 i = 1; i < MATRIX_SIZE; i++) {
            address m          = posToMember[i + 1];
            posToMember[i]     = m;
            posToMember[i + 1] = address(0);
            if (m != address(0)) matrixPos[m] = i;
        }
        nextSlot = MATRIX_SIZE;

        emit MemberCycledOut(root, members[root].cyclesCompleted, rotationCount, address(this));

        // ── V8: TierRouter handles Matrix B cycle-outs ────────────────────────
        if (!isMatrixA && tierRouter != address(0)) {
            try ITierRouter(tierRouter).handleCycleOut(
                root,
                tierIndex,
                escrowBalance[root],
                members[root].withdrawable
            ) {} catch {}
        } else {
            _crossToPartner(root);
        }
    }

    /**
     * @notice V8.1: Distribute accumulated equalization pool to all non-root members.
     *
     *         Called at every cycle-out BEFORE the BFS position shift.
     *         Weight formula: share[pos] = pool * pos / totalWeight
     *         where totalWeight = sum(2..MATRIX_SIZE) = MATRIX_SIZE*(MATRIX_SIZE+1)/2 - 1
     *
     *         This gives deeper members (higher pos) a larger share, compensating for
     *         the fact that they earn less chain pay than shallow members. The root
     *         (pos 1) is excluded entirely — they already earned the most chain pay.
     *
     *         Dust (rounding remainder) goes to pos 2 (longest-waiting non-root).
     */
    function _distributePool() internal {
        if (poolAccumulator == 0) return;

        // totalWeight = sum(2..N) = N*(N+1)/2 - 1
        uint256 N           = MATRIX_SIZE;
        uint256 totalWeight = N * (N + 1) / 2 - 1;

        uint256 pool    = poolAccumulator;
        poolAccumulator = 0;

        uint256 distributed = 0;
        address firstNonNull = address(0);

        for (uint256 pos = 2; pos <= N; pos++) {
            address m = posToMember[pos];
            if (m == address(0)) continue;
            if (firstNonNull == address(0)) firstNonNull = m;

            uint256 share = pool * pos / totalWeight;
            if (share == 0) continue;

            distributed += share;
            _credit(m, share);
            emit PoolShareCredited(m, pos, share);
        }

        // Dust → pos 2 member (or first non-null pos, or devOps)
        uint256 dust = pool - distributed;
        if (dust > 0) {
            address dest = posToMember[2] != address(0)
                ? posToMember[2]
                : firstNonNull;
            if (dest != address(0)) {
                _credit(dest, dust);
            } else if (devOpsWallet != address(0)) {
                usdc.safeTransfer(devOpsWallet, dust);
            }
        }

        emit PoolDistributed(pool, rotationCount);
    }

    /**
     * @notice Fund and execute a crossing to the partner or chain-next matrix.
     *         V8: reads destination.ENTRY_FEE() dynamically at crossing time.
     *         V8.1: primary fuel is withdrawable (escrow is now small).
     */
    function _crossToPartner(address member) internal {
        require(address(partner) != address(0), "F8V8: no partner");

        // Cascade guard: both matrices full simultaneously
        if (_crossingInProgress) {
            pendingCross         = member;
            pendingCrossReferrer = members[member].referrer;
            return;
        }

        address destination;
        if (!isMatrixA && chainNext != address(0)) {
            destination = chainNext;
        } else {
            destination = address(partner);
        }

        uint256 reentryFee = FigureEightMatrixV8(destination).ENTRY_FEE();

        uint256 esc      = escrowBalance[member];
        uint256 earnings = members[member].withdrawable;

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
                // Insufficient funds — park. Keeper calls forceCross() with funded fee.
                return;
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

        SafeERC20.forceApprove(usdc, destination, reentryFee);

        _crossingInProgress = true;
        emit MemberCrossedToPartner(member, address(this), destination);
        FigureEightMatrixV8(destination)._enterMatrix(member, members[member].referrer);
        _crossingInProgress = false;
    }

    // ─── Internal: Payment Distribution ──────────────────────────────────────

    /**
     * @notice Distribute all BPS splits for a new member entry.
     *
     *         V8.1 changes vs V8:
     *         - Removed: escrow accumulation for root (SPLIT_ESCROW_BPS)
     *         - Removed: secondary escrow for root (SPLIT_SECONDARY_BPS)
     *         - Added:   equalization pool accumulation (SPLIT_POOL_BPS)
     *         - Added:   StabilityFund L1 carve (SPLIT_STABILITY_BPS)
     *
     *         Chain pay BPS is halved: 2000 (T1-T5), 1750 (T6-T7).
     *         Pool BPS captures the freed chain + escrow + secondary BPS.
     */
    function _distributePayments(address newMember) internal {
        Member storage m = members[newMember];

        // ── L1 Referral ───────────────────────────────────────────────────────
        uint256 l1Amt = ENTRY_FEE * SPLIT_L1_BPS / BPS_DENOM;
        if (m.referrer != address(0)) {
            _credit(m.referrer, l1Amt);
        } else {
            _routeOrphanFee(l1Amt, "L1");
        }

        // ── L2 Override ───────────────────────────────────────────────────────
        uint256 l2Amt = ENTRY_FEE * SPLIT_L2_BPS / BPS_DENOM;
        if (m.l2 != address(0)) {
            _credit(m.l2, l2Amt);
        } else {
            _routeOrphanFee(l2Amt, "L2");
        }

        // ── L3 Override ───────────────────────────────────────────────────────
        uint256 l3Amt = ENTRY_FEE * SPLIT_L3_BPS / BPS_DENOM;
        if (m.l3 != address(0)) {
            _credit(m.l3, l3Amt);
        } else {
            _routeOrphanFee(l3Amt, "L3");
        }

        // ── Chain Pay (6 BFS levels — V8.1: halved per-level BPS) ─────────────
        _distributeChainPay(newMember);

        // ── Treasury (SACRED — no change, no reduction, no V8.1 touch) ────────
        uint256 treasuryAmt = ENTRY_FEE * SPLIT_TREASURY_BPS / BPS_DENOM;
        SafeERC20.forceApprove(usdc, address(treasury), treasuryAmt);
        treasury.depositReserve(treasuryAmt);

        // ── V8.1: Equalization Pool Accumulation ──────────────────────────────
        // USDC for pool stays in this contract until cycle-out triggers _distributePool().
        // No transfer out — just internal accounting. Backed 1:1 by USDC held here.
        uint256 poolAmt = ENTRY_FEE * SPLIT_POOL_BPS / BPS_DENOM;
        poolAccumulator += poolAmt;

        // ── V8.1: StabilityFund L1 carve (200 bps per entry, permanent) ───────
        uint256 stabilityAmt = ENTRY_FEE * SPLIT_STABILITY_BPS / BPS_DENOM;
        if (stabilityAmt > 0) {
            _forwardToStabilityFund(stabilityAmt, 1);
        }

        // ── Dev/Ops (combined) ────────────────────────────────────────────────
        uint256 devOpsAmt = ENTRY_FEE * SPLIT_DEVOPS_BPS / BPS_DENOM;
        if (devOpsWallet != address(0)) {
            usdc.safeTransfer(devOpsWallet, devOpsAmt);
        }
    }

    /// @dev Forward USDC to StabilityFund. Falls back to devOpsWallet if SF not set.
    function _forwardToStabilityFund(uint256 amount, uint8 layer) internal {
        if (amount == 0) return;
        if (stabilityFund != address(0)) {
            SafeERC20.forceApprove(usdc, stabilityFund, amount);
            try IStabilityFund(stabilityFund).receiveLayer(tierIndex, amount, layer) {}
            catch { usdc.safeTransfer(devOpsWallet, amount); }
        } else {
            // StabilityFund not yet deployed — hold in devOps as interim escrow
            if (devOpsWallet != address(0)) {
                usdc.safeTransfer(devOpsWallet, amount);
            }
        }
        emit StabilityContribution(tierIndex, amount, layer);
    }

    function _routeOrphanFee(uint256 amount, string memory source) internal {
        if (amount == 0) return;

        uint256 acct1Share = amount * 20 / 100;
        _credit(accountOne, acct1Share);

        uint256 remaining = amount - acct1Share;

        (uint256 escrowBps, uint256 founderBps) = _getOrphanRoutingRatios();
        uint256 denom        = escrowBps + founderBps;
        uint256 escrowShare  = remaining * escrowBps / denom;
        uint256 founderShare = remaining - escrowShare;

        address currentRoot = posToMember[1];
        if (currentRoot != address(0)) {
            escrowBalance[currentRoot] += escrowShare;
            totalEscrowHeld            += escrowShare;
            noReferrerEscrowRouted     += escrowShare;
            emit EscrowCredited(currentRoot, escrowShare, escrowBalance[currentRoot]);
        } else {
            _credit(accountOne, escrowShare);
        }

        if (founderShare > 0) {
            if (devOpsWallet != address(0)) {
                usdc.safeTransfer(devOpsWallet, founderShare);
                noReferrerFounderRouted += founderShare;
            } else {
                _credit(accountOne, founderShare);
            }
        }

        emit OrphanFeeRouted(amount, acct1Share, escrowShare, founderShare, source);
    }

    function _getOrphanRoutingRatios()
        internal view
        returns (uint256 escrowBps, uint256 founderBps)
    {
        uint256 total = noReferrerEscrowRouted + noReferrerFounderRouted;
        if (total == 0) return (4000, 4000);
        uint256 escrowPct = noReferrerEscrowRouted * 100 / total;
        if      (escrowPct < 35) return (6000, 2000);
        else if (escrowPct > 65) return (2000, 6000);
        return (4000, 4000);
    }

    /// @notice Chain pay up 6 BFS levels (V8.1: halved SPLIT_CHAIN_BPS, same weights).
    function _distributeChainPay(address newMember) internal {
        uint256 myPos = matrixPos[newMember];
        if (myPos == 0) return;

        uint256 parentPos = myPos / 2;
        for (uint256 lvl = 0; lvl < 6 && parentPos >= 1; lvl++) {
            address ancestor = posToMember[parentPos];
            if (ancestor != address(0)) {
                uint256 amt = ENTRY_FEE * chainPayBps[lvl] / BPS_DENOM;
                _credit(ancestor, amt);
                emit ChainPayDistributed(ancestor, newMember, lvl + 1, amt);
            }
            parentPos = parentPos / 2;
        }
    }

    /// @dev Credit withdrawable earnings and update activity timestamp.
    function _credit(address recipient, uint256 amount) internal {
        if (recipient == address(0) || amount == 0) return;
        members[recipient].withdrawable += amount;
        members[recipient].totalEarned  += amount;
        lastActivityTime[recipient]      = block.timestamp;
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw all earned USDC.
     *
     *         V8.1: A withdrawal health fee (default 1.5%) is deducted and
     *         forwarded to StabilityFund as Layer 3. This is counter-cyclical:
     *         the fee builds reserves during healthy bull runs and funds ghost
     *         entries (via MatrixKeeper) during deflation — keeping every member
     *         advancing without touching the treasury.
     */
    function withdraw() external {
        uint256 amount = members[msg.sender].withdrawable;
        require(amount > 0, "F8V8: nothing to withdraw");
        members[msg.sender].withdrawable = 0;

        // ── V8.1: Withdrawal health fee → StabilityFund L3 ───────────────────
        uint256 fee    = amount * withdrawalFeeBps / BPS_DENOM;
        uint256 payout = amount - fee;

        if (fee > 0) {
            _forwardToStabilityFund(fee, 3);
            emit WithdrawalFeeCharged(msg.sender, fee);
        }

        usdc.safeTransfer(msg.sender, payout);
        emit EarningsWithdrawn(msg.sender, payout);
    }

    // ─── V8.1: Early Escrow Release ──────────────────────────────────────────

    /**
     * @notice Member opt-in: release escrow balance early at a penalty.
     *
     *         In V8.1, escrow is primarily funded by orphan routing. Members
     *         who received escrow (as former roots with no-referrer entries) can
     *         unlock it immediately by forfeiting earlyExitPenaltyBps (default 20%).
     *
     *         Penalty → StabilityFund L5 (counter-cyclical reserve).
     *         Payout → member's withdrawable (withdraw() then transfers to wallet).
     *
     *         Callable at any time, including while member is still in the matrix.
     */
    function earlyEscrowRelease() external {
        uint256 escrow = escrowBalance[msg.sender];
        require(escrow > 0, "F8V8: no escrow to release");

        uint256 penalty = escrow * earlyExitPenaltyBps / BPS_DENOM;
        uint256 payout  = escrow - penalty;

        escrowBalance[msg.sender] = 0;
        totalEscrowHeld          -= escrow;

        if (penalty > 0) {
            _forwardToStabilityFund(penalty, 5);
        }

        if (payout > 0) {
            // Credit to withdrawable so member calls withdraw() in a separate tx
            members[msg.sender].withdrawable += payout;
            members[msg.sender].totalEarned  += payout;
        }

        emit EarlyEscrowRelease(msg.sender, escrow, penalty, payout);
    }

    // ─── V8.1: Keeper — Reclaim Idle Slot ────────────────────────────────────

    /**
     * @notice Remove an idle member from the BFS tree.
     *         Only callable by matrixKeeper (MatrixKeeper.sol via Chainlink Automation).
     *
     *         The keeper verifies maxMemberWait exceeded before calling.
     *         Member's earnings and escrow are NEVER touched — they retain full
     *         access to withdraw(). Only their BFS position is freed.
     *
     *         The freed slot creates a gap in the BFS tree. Chain pay silently
     *         skips address(0) positions (existing _distributeChainPay behavior).
     *         The keeper will fund a ghost entry via StabilityFund to keep the
     *         queue moving — the ghost occupies the freed slot or next available.
     *
     * @param member  The idle member to evict from the tree.
     */
    function reclaimIdleSlot(address member) external {
        require(msg.sender == matrixKeeper, "F8V8: not keeper");
        require(members[member].isInMatrix,  "F8V8: not in matrix");
        require(lastActivityTime[member] > 0, "F8V8: no activity record");

        uint256 pos      = matrixPos[member];
        uint256 idleTime = block.timestamp - lastActivityTime[member];

        posToMember[pos]           = address(0);
        matrixPos[member]          = 0;
        members[member].isInMatrix = false;
        occupancy                 -= 1;

        // Member funds (withdrawable + escrow) are fully preserved.
        // They can call withdraw() at any time after being reclaimed.

        emit SlotReclaimed(member, pos, idleTime);
    }

    // ─── Admin: forceCross ────────────────────────────────────────────────────

    /// @notice Emergency: manually fund and execute a stalled crossing.
    ///         Keeper bot calls this when a member is parked (insufficient funds at cycle-out).
    function forceCross(address member) external onlyOwner {
        require(members[member].hasEverJoined,  "F8V8: not a member");
        require(!members[member].isInMatrix,    "F8V8: still in matrix");
        require(address(partner) != address(0), "F8V8: no partner");

        usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);

        address destination = (!isMatrixA && chainNext != address(0))
            ? chainNext : address(partner);
        SafeERC20.forceApprove(usdc, destination, ENTRY_FEE);

        emit MemberCrossedToPartner(member, address(this), destination);
        FigureEightMatrixV8(destination)._enterMatrix(member, members[member].referrer);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getMember(address member)        external view returns (Member memory) { return members[member]; }
    function getCyclesCompleted(address m)    external view returns (uint256)       { return members[m].cyclesCompleted; }
    function withdrawableOf(address member)   external view returns (uint256)       { return members[member].withdrawable; }
    function escrowOf(address member)         external view returns (uint256)       { return escrowBalance[member]; }
    function isFull()                         external view returns (bool)          { return occupancy == MATRIX_SIZE; }
    function isActiveInMatrix(address member) external view returns (bool)          { return members[member].isInMatrix; }

    /// @notice Seconds since member last received any credit or entered the matrix.
    function getIdleSeconds(address member) external view returns (uint256) {
        if (lastActivityTime[member] == 0) return 0;
        return block.timestamp - lastActivityTime[member];
    }

    function crossingFundsOf(address member)
        external view
        returns (uint256 total, uint256 fromEscrow, uint256 fromEarnings)
    {
        fromEscrow   = escrowBalance[member];
        fromEarnings = members[member].withdrawable;
        total        = fromEscrow + fromEarnings;
    }

    function getPendingCross() external view returns (address member, address referrer) {
        return (pendingCross, pendingCrossReferrer);
    }

    /// @notice V8.1: Pool distribution preview — how much a member at `pos` would receive
    ///         if cycle-out fired right now with current poolAccumulator.
    function poolSharePreview(uint256 pos) external view returns (uint256) {
        if (poolAccumulator == 0 || pos < 2 || pos > MATRIX_SIZE) return 0;
        uint256 N           = MATRIX_SIZE;
        uint256 totalWeight = N * (N + 1) / 2 - 1;
        return poolAccumulator * pos / totalWeight;
    }

    /// @notice V8.1: Return all BPS splits. Returns poolBps and stabilityBps
    ///         instead of the V8 Phase 1 escrowBps/secondaryBps.
    function getSplits()
        external view
        returns (
            uint256 l1Bps,
            uint256 l2Bps,
            uint256 l3Bps,
            uint256 chainBps,
            uint256 poolBps,
            uint256 treasuryBps,
            uint256 devOpsBps,
            uint256 stabilityBps
        )
    {
        return (
            SPLIT_L1_BPS,
            SPLIT_L2_BPS,
            SPLIT_L3_BPS,
            SPLIT_CHAIN_BPS,
            SPLIT_POOL_BPS,
            SPLIT_TREASURY_BPS,
            SPLIT_DEVOPS_BPS,
            SPLIT_STABILITY_BPS
        );
    }
}
