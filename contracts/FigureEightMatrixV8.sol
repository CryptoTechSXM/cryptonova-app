// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  FigureEightMatrixV8
 * @notice V8.1 "Elevator" --- BFS matrix with TierRouter integration,
 *         deficit-weighted equalization pool, StabilityFund hooks,
 *         and no-idle-member guarantees.
 *
 * V8.1 CHANGES (Option B BPS)
 * -----------------------------------------------------------------------------
 *  1. Equalization Pool (Option B)
 *       V8.8: escrow storage removed; orphan fees --- CommunityWallet / SF L6
 *       + SPLIT_STABILITY_BPS. Chain pay halved (4000---2000 T1-T5, 3500---1750
 *       T6-T7). Freed BPS flows into equalization pool accumulated per-entry.
 *       On every cycle-out, pool distributes to all non-root members (pos 2..N)
 *       weighted by BFS position (deeper = larger deficit = larger share).
 *
 *       BPS table (V8.7 -- l2/l3 removed, buyback added, 10 tiers):
 *         T1-T3:  l1=2000, chain=2000, pool=3300, treasury=1500,
 *                 devOps=500, stability=600, buyback=100   (sum=10000)
 *         T4-T5:  l1=2000, chain=2000, pool=3100, treasury=1700,
 *                 devOps=600, stability=500, buyback=100   (sum=10000)
 *         T6-T7:  l1=2000, chain=1750, pool=2950, treasury=1900,
 *                 devOps=700, stability=500, buyback=200   (sum=10000)
 *         T8-T10: l1=2000, chain=1750, pool=2750, treasury=2000,
 *                 devOps=800, stability=500, buyback=200   (sum=10000)
 *
 *  2. StabilityFund hooks (zero treasury --- treasury is SACRED)
 *       L1: 200 bps per entry (permanent)  --- receiveLayer(tier, amt, 1)
 *       L3: withdrawal health fee 1.5%     --- receiveLayer(tier, amt, 3)
 *       L5: early exit penalty 20%         --- receiveLayer(tier, amt, 5)
 *       Fallback to devOpsWallet if StabilityFund not yet set.
 *
 *  3. Activity tracking
 *       lastActivityTime[member] updated on matrix entry (join) and explicit
 *       member actions (withdraw, earlyEscrowRelease) --- NOT on passive credits.
 *       This avoids O(N) cold SSTOREs in _distributePool() at cycle-out.
 *       MatrixKeeper reads getIdleSeconds() to detect idle slots.
 *
 *  4. reclaimIdleSlot() --- keeper-only
 *       Removes idle member from BFS tree. Earnings/escrow untouched.
 *
 *  5. earlyEscrowRelease() --- REMOVED in V8.8 (escrow storage removed)
 *       Orphan fees now route to CommunityWallet / StabilityFund layer 6.
 *
 *  6. Governance-adjustable fee parameters (enumerated menus, DAO-votable)
 *       withdrawalFeeBps: 50/100/150/200/250 (default 150 = 1.5%)
 *       earlyExitPenaltyBps: 1000/1500/2000/2500 (default 2000 = 20%)
 *
 * V8 CHANGES (carried forward from Phase 1)
 * -----------------------------------------------------------------------------
 *  1. Dynamic crossing fee (reads destination.ENTRY_FEE() at crossing time)
 *  2. Per-tier BPS splits passed in constructor (all immutable)
 *  3. TierRouter callback on Matrix B cycle-out
 *  4. deductForUpgrade() callable by TierRouter only
 *  5. 6-level chain pay (configurable per-tier via constructor)
 *  6. Separate devWallet + opsWallet + communityWallet (all per-entry routed)
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
    /// @notice V8.14: called by MatB._enterMatrix to signal a member has crossed in.
    function onCrossToMatB(address member, uint8 tierIndex) external;
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

    // --- Immutables -----------------------------------------------------------
    uint256 public immutable MATRIX_SIZE;
    uint256 public immutable ENTRY_FEE;
    bool    public immutable isMatrixA;
    uint8   public immutable tierIndex;          // 0=T1, 1=T2, ..., 9=T10

    // --- Per-tier BPS splits (immutable, set in constructor) ------------------
    uint256 public immutable SPLIT_L1_BPS;        // 2000 all tiers
    uint256 public immutable SPLIT_CHAIN_BPS;     // 2000 T1-T5, 1750 T6-T10
    uint256 public immutable SPLIT_POOL_BPS;      // 3300/3100/2950/2750 per tier group
    uint256 public immutable SPLIT_TREASURY_BPS;  // 1500/1700/1900/2000 per tier group
    uint256 public immutable SPLIT_DEV_BPS;       // dev portion (300/...) per tier group
    uint256 public immutable SPLIT_OPS_BPS;       // ops portion (200/...) per tier group
    uint256 public immutable SPLIT_COMMUNITY_BPS; // community carve (100 all tiers)
    uint256 public immutable SPLIT_STABILITY_BPS; // 600/500 per tier group -- L1 carve to SF
    uint256 public immutable SPLIT_BUYBACK_BPS;   // 100/200 per tier group -- to BuybackReserve
    uint256 public constant  BPS_DENOM = 10_000;

    // --- Chain pay weights per BFS level (6 levels in V8) --------------------
    uint256[6] public chainPayBps;

    // --- External contracts ---------------------------------------------------
    IERC20         public immutable usdc;
    CNOVAToken     public immutable cnova;
    CNOVATreasury  public immutable treasury;
    address        public immutable devWallet;     // dev wallet
    address        public immutable opsWallet;     // ops wallet
    address        public tierRouter;              // TierRouter --- set post-deploy
    address        public pairManager;             // PairManager --- set post-deploy
    address        public accountOne;              // orphan fee fallback
    address        public stabilityFund;           // StabilityFund.sol --- set post-deploy
    address        public communityWallet;         // CommunityWallet.sol --- set post-deploy (deferred to mainnet)
    address        public buybackReserve;          // CNOVABuybackReserve.sol --- set post-deploy
    address        public matrixKeeper;            // MatrixKeeper (Chainlink) --- set post-deploy

    // --- Figure-8 partner ----------------------------------------------------
    FigureEightMatrixV8 public partner;

    // --- Circular chain (multi-pair within same tier) ------------------------
    address public chainNext;
    mapping(address => bool) public chainAuthorized;

    // --- BFS State -----------------------------------------------------------
    mapping(address => uint256) public matrixPos;
    mapping(uint256 => address) public posToMember;
    uint256 public occupancy;
    uint256 public nextSlot;
    uint256 public rotationCount;
    uint256 public joinCountSinceRotation;
    uint256 public lastRotationTimestamp;

    // --- Cascade guard --------------------------------------------------------
    bool    private _crossingInProgress;
    address public  pendingCross;
    address public  pendingCrossReferrer;

    // --- Parked member queue (keeper rescue) -----------------------------------------
    /// @notice Members that failed to cross (insufficient funds). Keeper rescues via forceCrossKeeper().
    address[] public parkedMembers;
    /// @notice Timestamp when each member was parked. Used by keeper for grace-period logic.
    mapping(address => uint256) public parkedAt;

    // --- V8.1: Equalization Pool ----------------------------------------------
    /// @notice Accumulates SPLIT_POOL_BPS per entry. Distributed deficit-weighted
    ///         to all non-root members (pos 2..N) on every cycle-out.
    uint256 public poolAccumulator;

    // --- V8.1: Activity Tracking ---------------------------------------------
    /// @notice Last timestamp a member received any credit or entered the matrix.
    ///         MatrixKeeper monitors this for idle slot reclaiming.
    mapping(address => uint256) public lastActivityTime;

    // --- V8.1: Governance parameters (DAO-votable, enumerated values only) ---
    /// @notice Withdrawal health fee in BPS. Default 150 (1.5%). Feeds L3.
    uint256 public withdrawalFeeBps    = 150;
    /// @notice Early exit penalty in BPS. Default 2000 (20%). Feeds L5.
    uint256 public earlyExitPenaltyBps = 2000;

    // --- Orphan fee health monitor (escrow replaced by community pool routing) -
    uint256 public noReferrerPoolRouted;     // renamed from noReferrerEscrowRouted
    uint256 public noReferrerFounderRouted;

    // --- Member data ---------------------------------------------------------
    struct Member {
        uint256 id;
        address referrer;
        uint256 joinedAt;
        uint256 withdrawable;
        uint256 totalEarned;
        uint256 totalWithdrawn;   // V8.10: cumulative gross amount withdrawn (pre-fee)
        uint256 cyclesCompleted;
        bool    isInMatrix;
        bool    hasEverJoined;
    }
    mapping(address => Member) public members;
    uint256 public totalJoined;

    // --- Events ---------------------------------------------------------------
    event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix);
    event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix);
    event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix);
    event CrossingFunded(address indexed member, uint256 fromEscrow, uint256 fromEarnings, uint256 total);
    event ChainPayDistributed(address indexed recipient, address indexed payer, uint256 level, uint256 amount);
    event OrphanFeePooled(uint256 poolShare, address destination, string source);
    event OrphanFeeRouted(uint256 amount, uint256 acct1Share, uint256 poolShare, uint256 founderShare, string source);
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
    event MemberParked(address indexed member, uint256 shortfall);
    event MemberEvicted(address indexed member, uint256 totalWithdrawn);  // V8.10: grace-period eviction

    // --- Constructor split config struct --------------------------------------
    /// @notice V8.9: devOpsBps split into devBps + opsBps, communityBps added (9 fields total).
    struct SplitConfig {
        uint256 l1Bps;
        uint256 chainBps;
        uint256 poolBps;        // equalization pool
        uint256 treasuryBps;    // CNOVA backing (SACRED)
        uint256 stabilityBps;   // per-entry L1 carve to StabilityFund
        uint256 devBps;         // dev wallet carve
        uint256 opsBps;         // ops wallet carve
        uint256 communityBps;   // community wallet carve (was SF-level carve in V8.8)
        uint256 buybackBps;     // per-entry carve to CNOVABuybackReserve
        // Sum must == 10,000
    }

    /// @dev Packs the 6 address constructor args into a single memory pointer,
    ///      keeping the total stack depth below the EVM's 16-slot limit when
    ///      MatrixFactory deploys a new instance.
    struct DeployParams {
        address usdc;
        address cnova;
        address treasury;
        address devWallet;
        address opsWallet;
        address accountOne;
        address admin;
    }

    // --- Constructor ----------------------------------------------------------
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
        require(_p.devWallet != address(0),    "F8V8: zero devWallet");
        require(_p.opsWallet != address(0),    "F8V8: zero opsWallet");
        require(_p.accountOne   != address(0), "F8V8: zero accountOne");
        require(_entryFee     > 0,             "F8V8: zero fee");
        require(_matrixSize   >= 3 && _matrixSize <= 1023, "F8V8: invalid size");
        require(_tierIndex    < 10,            "F8V8: invalid tier");

        // V8.9: validate new split fields (9 fields: dev+ops split, communityBps added)
        uint256 sum = _splits.l1Bps + _splits.chainBps + _splits.poolBps
            + _splits.treasuryBps + _splits.stabilityBps
            + _splits.devBps + _splits.opsBps + _splits.communityBps
            + _splits.buybackBps;
        require(sum == BPS_DENOM, "F8V8: splits != 10000");

        usdc         = IERC20(_p.usdc);
        cnova        = CNOVAToken(_p.cnova);
        treasury     = CNOVATreasury(_p.treasury);
        devWallet = _p.devWallet;
        opsWallet = _p.opsWallet;
        accountOne   = _p.accountOne;
        ENTRY_FEE    = _entryFee;
        MATRIX_SIZE  = _matrixSize;
        isMatrixA    = _isMatrixA;
        tierIndex    = _tierIndex;
        nextSlot     = 1;

        SPLIT_L1_BPS        = _splits.l1Bps;
        SPLIT_CHAIN_BPS     = _splits.chainBps;
        SPLIT_POOL_BPS      = _splits.poolBps;
        SPLIT_TREASURY_BPS  = _splits.treasuryBps;
        SPLIT_DEV_BPS       = _splits.devBps;
        SPLIT_OPS_BPS       = _splits.opsBps;
        SPLIT_COMMUNITY_BPS = _splits.communityBps;
        SPLIT_STABILITY_BPS = _splits.stabilityBps;
        SPLIT_BUYBACK_BPS   = _splits.buybackBps;

        for (uint256 i = 0; i < 6; i++) {
            chainPayBps[i] = _chainPayBps[i];
        }
    }

    // --- Admin setters --------------------------------------------------------

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
    ///         Until set, stability contributions route to devWallet as escrow.
    function setStabilityFund(address _sf) external onlyOwner {
        require(_sf != address(0), "F8V8: zero stabilityFund");
        stabilityFund = _sf;
        emit StabilityFundSet(_sf);
    }

    /// @notice V8.7: Set BuybackReserve address.
    function setBuybackReserve(address _bbr) external onlyOwner {
        require(_bbr != address(0), "F8V8: zero bbr");
        buybackReserve = _bbr;
    }

    /// @notice V8.1: Set MatrixKeeper (Chainlink Automation) address.
    function setMatrixKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "F8V8: zero keeper");
        matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    /// @notice Set the CommunityWallet address for orphan fee routing.
    ///         Pass address(0) to disable CW routing (orphan fees fall back to SF layer 6).
    function setCommunityWallet(address _cw) external onlyOwner {
        communityWallet = _cw;
    }

    // --- Governance setters (DAO-votable, enumerated menus only) -------------

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

    // --- TierRouter: fund extraction -----------------------------------------

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

        // escrowAmt always 0 in V8.8 --- escrow storage removed
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

    // --- Registration ---------------------------------------------------------

    /// @notice Direct register (testnet convenience --- bypasses TierRouter).
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

    /// @notice PairManager entry --- called by PairManager.enterFor().
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

            members[member] = Member({
                id:              totalJoined,
                referrer:        l1,
                joinedAt:        block.timestamp,
                withdrawable:    0,
                totalEarned:     0,
                totalWithdrawn:  0,
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

        // V8.14: notify TierRouter when a member enters MatB — triggers upgrade eligibility.
        // Covers all crossing paths: _crossToPartner, forceCross, forceCrossKeeper.
        if (!isMatrixA && tierRouter != address(0)) {
            try ITierRouter(tierRouter).onCrossToMatB(member, tierIndex) {} catch {}
        }
    }

    // --- Internal: Matrix Mechanics -------------------------------------------

    function _placeInMatrix(address member, uint256 slot) internal {
        matrixPos[member]          = slot;
        posToMember[slot]          = member;
        members[member].isInMatrix = true;
    }

    function _cycleOutRoot() internal {
        address root = posToMember[1];
        require(root != address(0), "F8V8: no root");

        // -- V8.1: Distribute equalization pool BEFORE shifting ----------------
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

        // -- V8: TierRouter handles Matrix B cycle-outs ------------------------
        if (!isMatrixA && tierRouter != address(0)) {
            try ITierRouter(tierRouter).handleCycleOut(
                root,
                tierIndex,
                0,                       // escrow removed --- crossing is withdrawable-only
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
     *         (pos 1) is excluded entirely --- they already earned the most chain pay.
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

        // Dust --- pos 2 member (or first non-null pos, or devOps)
        uint256 dust = pool - distributed;
        if (dust > 0) {
            address dest = posToMember[2] != address(0)
                ? posToMember[2]
                : firstNonNull;
            if (dest != address(0)) {
                _credit(dest, dust);
            } else if (devWallet != address(0)) {
                usdc.safeTransfer(devWallet, dust);
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

        // V8.8: escrow removed --- crossing funded entirely from withdrawable earnings.
        uint256 earnings = members[member].withdrawable;

        if (earnings < reentryFee) {
            // Insufficient funds --- park. Keeper rescues via forceCrossKeeper().
            uint256 shortfall = reentryFee - earnings;
            parkedMembers.push(member);
            parkedAt[member] = block.timestamp;  // V8.10: start grace period clock
            emit MemberParked(member, shortfall);
            return;
        }

        members[member].withdrawable -= reentryFee;

        uint256 fromEscrow   = 0;    // kept for CrossingFunded event compat
        uint256 fromEarnings = reentryFee;

        emit CrossingFunded(member, fromEscrow, fromEarnings, reentryFee);

        SafeERC20.forceApprove(usdc, destination, reentryFee);

        _crossingInProgress = true;
        emit MemberCrossedToPartner(member, address(this), destination);
        FigureEightMatrixV8(destination)._enterMatrix(member, members[member].referrer);
        _crossingInProgress = false;
    }

    // --- Internal: Payment Distribution --------------------------------------

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

        // -- L1 Referral -------------------------------------------------------
        uint256 l1Amt = ENTRY_FEE * SPLIT_L1_BPS / BPS_DENOM;
        if (m.referrer != address(0)) {
            _credit(m.referrer, l1Amt);
        } else {
            _routeOrphanFee(l1Amt, "L1");
        }

        // -- Chain Pay (6 BFS levels) ------------------------------------------
        _distributeChainPay(newMember);

        // -- Treasury (SACRED --- no change, no reduction, no V8.1 touch) --------
        uint256 treasuryAmt = ENTRY_FEE * SPLIT_TREASURY_BPS / BPS_DENOM;
        SafeERC20.forceApprove(usdc, address(treasury), treasuryAmt);
        treasury.depositReserve(treasuryAmt);

        // -- V8.1: Equalization Pool Accumulation ------------------------------
        // USDC for pool stays in this contract until cycle-out triggers _distributePool().
        // No transfer out --- just internal accounting. Backed 1:1 by USDC held here.
        uint256 poolAmt = ENTRY_FEE * SPLIT_POOL_BPS / BPS_DENOM;
        poolAccumulator += poolAmt;

        // -- V8.7: StabilityFund L1 carve -------------------------------------
        uint256 stabilityAmt = ENTRY_FEE * SPLIT_STABILITY_BPS / BPS_DENOM;
        if (stabilityAmt > 0) {
            _forwardToStabilityFund(stabilityAmt, 1);
        }

        // -- V8.7: BuybackReserve carve ----------------------------------------
        uint256 buybackAmt = ENTRY_FEE * SPLIT_BUYBACK_BPS / BPS_DENOM;
        if (buybackAmt > 0) {
            _forwardToBuybackReserve(buybackAmt);
        }

        // -- Dev (separate) ----------------------------------------------------
        uint256 devAmt = ENTRY_FEE * SPLIT_DEV_BPS / BPS_DENOM;
        if (devAmt > 0 && devWallet != address(0)) {
            usdc.safeTransfer(devWallet, devAmt);
        }

        // -- Ops (separate) ----------------------------------------------------
        uint256 opsAmt = ENTRY_FEE * SPLIT_OPS_BPS / BPS_DENOM;
        if (opsAmt > 0 && opsWallet != address(0)) {
            usdc.safeTransfer(opsWallet, opsAmt);
        }

        // -- Community wallet carve --------------------------------------------
        uint256 communityAmt = ENTRY_FEE * SPLIT_COMMUNITY_BPS / BPS_DENOM;
        if (communityAmt > 0) {
            if (communityWallet != address(0)) {
                SafeERC20.forceApprove(usdc, communityWallet, communityAmt);
                try ICommunityWalletV8(communityWallet).deposit(communityAmt) {}
                catch { usdc.safeTransfer(devWallet, communityAmt); }
            } else if (devWallet != address(0)) {
                usdc.safeTransfer(devWallet, communityAmt);
            }
        }
    }

    /// @dev Forward USDC to StabilityFund. Falls back to devWallet if SF not set.
    function _forwardToStabilityFund(uint256 amount, uint8 layer) internal {
        if (amount == 0) return;
        if (stabilityFund != address(0)) {
            SafeERC20.forceApprove(usdc, stabilityFund, amount);
            try IStabilityFund(stabilityFund).receiveLayer(tierIndex, amount, layer) {}
            catch { usdc.safeTransfer(devWallet, amount); }
        } else {
            // StabilityFund not yet deployed -- hold in devWallet as interim escrow
            if (devWallet != address(0)) {
                usdc.safeTransfer(devWallet, amount);
            }
        }
        emit StabilityContribution(tierIndex, amount, layer);
    }

    /// @dev Forward USDC to CNOVABuybackReserve. Falls back to devWallet if BBR not set.
    function _forwardToBuybackReserve(uint256 amount) internal {
        if (amount == 0) return;
        if (buybackReserve != address(0)) {
            SafeERC20.forceApprove(usdc, buybackReserve, amount);
            usdc.safeTransfer(buybackReserve, amount);
        } else {
            // BuybackReserve not yet set -- route to devWallet
            if (devWallet != address(0)) {
                usdc.safeTransfer(devWallet, amount);
            }
        }
    }

    function _routeOrphanFee(uint256 amount, string memory source) internal {
        if (amount == 0) return;

        uint256 acct1Share = amount * 20 / 100;
        _credit(accountOne, acct1Share);

        uint256 remaining = amount - acct1Share;

        // Self-balancing: if pool is getting >65% of orphan fees, swing toward
        // devOps; if <35%, swing toward pool.  Keeps the ratio self-correcting.
        (uint256 poolBps, uint256 founderBps) = _getOrphanRoutingRatios();
        uint256 denom      = poolBps + founderBps;
        uint256 poolShare  = remaining * poolBps / denom;
        uint256 founderShare = remaining - poolShare;

        // Route pool share --- CommunityWallet (SF layer 6 fallback)
        if (poolShare > 0) {
            _forwardToCommunityPool(poolShare, source);
            noReferrerPoolRouted += poolShare;
        }

        if (founderShare > 0) {
            if (devWallet != address(0)) {
                usdc.safeTransfer(devWallet, founderShare);
                noReferrerFounderRouted += founderShare;
            } else {
                _credit(accountOne, founderShare);
            }
        }

        emit OrphanFeeRouted(amount, acct1Share, poolShare, founderShare, source);
    }

    /// @notice Forward orphan pool share to CommunityWallet.
    ///         Falls back to StabilityFund (layer 6 = orphan routing) if CW not yet set.
    ///         try/catch on CW call so a bad CW contract can never brick the matrix.
    function _forwardToCommunityPool(uint256 amount, string memory source) internal {
        if (amount == 0) return;
        if (communityWallet != address(0)) {
            SafeERC20.forceApprove(usdc, communityWallet, amount);
            try ICommunityWalletV8(communityWallet).deposit(amount) {
                emit OrphanFeePooled(amount, communityWallet, source);
                return;
            } catch {
                // CW reverted --- fall through to SF
            }
        }
        // SF fallback (layer 6 = orphan community pool carve)
        if (stabilityFund != address(0)) {
            SafeERC20.forceApprove(usdc, stabilityFund, amount);
            try IStabilityFund(stabilityFund).receiveLayer(tierIndex, amount, 6) {}
                catch { _credit(accountOne, amount); }
        } else {
            _credit(accountOne, amount);
        }
        emit OrphanFeePooled(amount, communityWallet != address(0) ? communityWallet : stabilityFund, source);
    }

    function _getOrphanRoutingRatios()
        internal view
        returns (uint256 poolBps, uint256 founderBps)
    {
        uint256 total = noReferrerPoolRouted + noReferrerFounderRouted;
        if (total == 0) return (4000, 4000);
        uint256 poolPct = noReferrerPoolRouted * 100 / total;
        if      (poolPct < 35) return (6000, 2000);
        else if (poolPct > 65) return (2000, 6000);
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

    /// @dev Credit withdrawable earnings. Does NOT touch lastActivityTime
    ///      (passive income != activity; see withdraw()).
    function _credit(address recipient, uint256 amount) internal {
        if (recipient == address(0) || amount == 0) return;
        members[recipient].withdrawable += amount;
        members[recipient].totalEarned  += amount;
        // NOTE: lastActivityTime NOT updated here --- passive credit != activity.
        // Updated only on explicit actions: _placeInMatrix, withdraw.
        // Avoids 63x cold SSTOREs during _distributePool.
    }

    // --- Withdraw -------------------------------------------------------------

    /**
     * @notice Withdraw all earned USDC.
     *
     *         V8.1: A withdrawal health fee (default 1.5%) is deducted and
     *         forwarded to StabilityFund as Layer 3. This is counter-cyclical:
     *         the fee builds reserves during healthy bull runs and funds ghost
     *         entries (via MatrixKeeper) during deflation --- keeping every member
     *         advancing without touching the treasury.
     */
    function withdraw() external {
        uint256 available = members[msg.sender].withdrawable;
        require(available > 0, "F8V8: nothing to withdraw");

        // V8.10: Reserve ENTRY_FEE while member is active in the matrix.
        // This ensures funds for the crossing are always present, preventing
        // the drain-and-park exploit (withdraw all --- get parked --- SF pays crossing).
        // Members who want a full withdrawal must wait until after they have cycled
        // out and crossed (isInMatrix = false).
        if (members[msg.sender].isInMatrix) {
            require(available > ENTRY_FEE, "F8V8: must keep entry fee reserve while active");
            available = available - ENTRY_FEE;
        }

        members[msg.sender].withdrawable    -= available;
        members[msg.sender].totalWithdrawn  += available;   // V8.10: track cumulative
        lastActivityTime[msg.sender] = block.timestamp;     // explicit action = activity

        // -- V8.1: Withdrawal health fee --- StabilityFund L3 -------------------
        uint256 fee    = available * withdrawalFeeBps / BPS_DENOM;
        uint256 payout = available - fee;

        if (fee > 0) {
            _forwardToStabilityFund(fee, 3);
            emit WithdrawalFeeCharged(msg.sender, fee);
        }

        usdc.safeTransfer(msg.sender, payout);
        emit EarningsWithdrawn(msg.sender, payout);
    }

    /// @notice V8.13: Partial withdrawal — caller specifies exact USDC amount (6 decimals).
    ///         Same ENTRY_FEE reserve rule applies while in-matrix.
    ///         Same 1.5% withdrawal fee applies to the requested amount.
    function withdrawPartial(uint256 amount) external {
        require(amount > 0, "F8V8: amount must be > 0");
        uint256 available = members[msg.sender].withdrawable;
        require(available > 0, "F8V8: nothing to withdraw");

        // V8.10 anti-drain-exploit: keep ENTRY_FEE reserve while active in matrix
        if (members[msg.sender].isInMatrix) {
            require(available > ENTRY_FEE, "F8V8: must keep entry fee reserve while active");
            available = available - ENTRY_FEE;
        }

        require(amount <= available, "F8V8: amount exceeds withdrawable");

        members[msg.sender].withdrawable   -= amount;
        members[msg.sender].totalWithdrawn += amount;
        lastActivityTime[msg.sender] = block.timestamp;

        uint256 fee    = amount * withdrawalFeeBps / BPS_DENOM;
        uint256 payout = amount - fee;

        if (fee > 0) {
            _forwardToStabilityFund(fee, 3);
            emit WithdrawalFeeCharged(msg.sender, fee);
        }

        usdc.safeTransfer(msg.sender, payout);
        emit EarningsWithdrawn(msg.sender, payout);
    }

    /**
     * @notice Withdraw a specific amount of earnings, sending the payout to a custom
     *         recipient address. Useful for members who want earnings sent directly
     *         to a hardware wallet, exchange, or different address.
     * @dev    Same reserve and fee rules as withdrawPartial(). msg.sender is still
     *         the member being debited; only the USDC destination changes.
     */
    function withdrawPartialTo(address recipient, uint256 amount) external {
        require(recipient != address(0), "F8V8: zero recipient");
        require(amount > 0, "F8V8: amount must be > 0");
        uint256 available = members[msg.sender].withdrawable;
        require(available > 0, "F8V8: nothing to withdraw");

        if (members[msg.sender].isInMatrix) {
            require(available > ENTRY_FEE, "F8V8: must keep entry fee reserve while active");
            available = available - ENTRY_FEE;
        }

        require(amount <= available, "F8V8: amount exceeds withdrawable");

        members[msg.sender].withdrawable   -= amount;
        members[msg.sender].totalWithdrawn += amount;
        lastActivityTime[msg.sender] = block.timestamp;

        uint256 fee    = amount * withdrawalFeeBps / BPS_DENOM;
        uint256 payout = amount - fee;

        if (fee > 0) {
            _forwardToStabilityFund(fee, 3);
            emit WithdrawalFeeCharged(msg.sender, fee);
        }

        usdc.safeTransfer(recipient, payout);
        emit EarningsWithdrawn(msg.sender, payout);
    }

    /**
     * @notice Withdraw all available earnings to a custom recipient address.
     *         Same anti-drain-exploit reserve rules as withdraw().
     */
    function withdrawTo(address recipient) external {
        require(recipient != address(0), "F8V8: zero recipient");
        uint256 available = members[msg.sender].withdrawable;
        require(available > 0, "F8V8: nothing to withdraw");

        if (members[msg.sender].isInMatrix) {
            require(available > ENTRY_FEE, "F8V8: must keep entry fee reserve while active");
            available = available - ENTRY_FEE;
        }

        members[msg.sender].withdrawable   -= available;
        members[msg.sender].totalWithdrawn += available;
        lastActivityTime[msg.sender] = block.timestamp;

        uint256 fee    = available * withdrawalFeeBps / BPS_DENOM;
        uint256 payout = available - fee;

        if (fee > 0) {
            _forwardToStabilityFund(fee, 3);
            emit WithdrawalFeeCharged(msg.sender, fee);
        }

        usdc.safeTransfer(recipient, payout);
        emit EarningsWithdrawn(msg.sender, payout);
    }

    // --- V8.8: earlyEscrowRelease() removed ---------------------------------
    // Escrow storage removed in V8.8. Orphan fees now route to CommunityWallet /
    // StabilityFund (layer 6) instead of per-member escrow slots. Members crossing
    // to their partner matrix use withdrawable earnings only.  The early-exit
    // penalty path (--- SF L5) is preserved via the withdraw() withdrawal fee (L3).

    // --- V8.1: Keeper --- Reclaim Idle Slot ------------------------------------

    /**
     * @notice Remove an idle member from the BFS tree.
     *         Only callable by matrixKeeper (MatrixKeeper.sol via Chainlink Automation).
     *
     *         The keeper verifies maxMemberWait exceeded before calling.
     *         Member's earnings and escrow are NEVER touched --- they retain full
     *         access to withdraw(). Only their BFS position is freed.
     *
     *         The freed slot creates a gap in the BFS tree. Chain pay silently
     *         skips address(0) positions (existing _distributeChainPay behavior).
     *         The keeper will fund a ghost entry via StabilityFund to keep the
     *         queue moving --- the ghost occupies the freed slot or next available.
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

    // --- Admin: forceCross ----------------------------------------------------

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

    // --- Views ----------------------------------------------------------------

    /// @notice True when member has ever joined but is NOT currently in the matrix.
    ///         Covers both freshly cycled-out members AND parked members.
    function isParked(address member) external view returns (bool) {
        return members[member].hasEverJoined && !members[member].isInMatrix;
    }

    function getParkedCount() external view returns (uint256) { return parkedMembers.length; }

    function getParkedMember(uint256 idx) external view returns (address) { return parkedMembers[idx]; }

    // --- Keeper: forceCrossKeeper ----------------------------------------------------------------------

    /**
     * @notice Keeper-initiated forced crossing for a parked member.
     *         Caller (MatrixKeeper) MUST have already called
     *         StabilityFund.payForceCross(tierIndex, address(this), ENTRY_FEE)
     *         so this contract holds the required ENTRY_FEE USDC before this call.
     */
    /**
     * @notice V8.11: Keeper rescue --- SF sends sfContribution, member covers remainder.
     * @param member         The parked member to rescue.
     * @param sfContribution USDC already sent to this contract by StabilityFund (e.g. 25% of fee).
     *                       Member's withdrawable covers the remaining (fee - sfContribution).
     */
    function forceCrossKeeper(address member, uint256 sfContribution) external {
        require(msg.sender == matrixKeeper,     "F8V8: not keeper");
        require(members[member].hasEverJoined,  "F8V8: not a member");
        require(!members[member].isInMatrix,    "F8V8: still in matrix");
        require(address(partner) != address(0), "F8V8: no partner");
        require(sfContribution <= ENTRY_FEE,    "F8V8: sfContribution exceeds fee");

        // Deduct member's share (fee - sfContribution) from their withdrawable balance
        uint256 memberShare = ENTRY_FEE - sfContribution;
        if (memberShare > 0) {
            require(
                members[member].withdrawable >= memberShare,
                "F8V8: insufficient withdrawable for rescue"
            );
            members[member].withdrawable -= memberShare;
        }

        _removeFromParkedQueue(member);

        address destination = (!isMatrixA && chainNext != address(0))
            ? chainNext : address(partner);
        // Contract now holds full ENTRY_FEE: sfContribution (from SF) + memberShare (from withdrawable)
        SafeERC20.forceApprove(usdc, destination, ENTRY_FEE);

        emit MemberCrossedToPartner(member, address(this), destination);
        FigureEightMatrixV8(destination)._enterMatrix(member, members[member].referrer);
    }

    function _removeFromParkedQueue(address member) internal {
        uint256 len = parkedMembers.length;
        for (uint256 i = 0; i < len; i++) {
            if (parkedMembers[i] == member) {
                parkedMembers[i] = parkedMembers[len - 1];
                parkedMembers.pop();
                parkedAt[member] = 0;  // V8.10: clear grace period clock on rescue
                return;
            }
        }
    }

    /**
     * @notice V8.10: Keeper-initiated eviction of a parked member after grace period expires.
     *         Called when: grace period has passed AND member is not eligible for SF rescue
     *         (i.e. they have extracted significant value via withdraw()).
     *
     *         Effect: member is removed from the parked queue. Their BFS slot was
     *         already freed when they cycled out. Their withdrawable balance is fully
     *         preserved --- they can call withdraw() at any time.
     *         They must re-enter fresh via TierRouter to participate again.
     */
    function evictParked(address member) external {
        require(msg.sender == matrixKeeper,    "F8V8: not keeper");
        require(parkedAt[member] > 0,          "F8V8: member not parked");
        require(!members[member].isInMatrix,   "F8V8: member is in matrix");

        uint256 withdrawn = members[member].totalWithdrawn;
        _removeFromParkedQueue(member);   // also clears parkedAt

        emit MemberEvicted(member, withdrawn);
    }

    function getMember(address member)        external view returns (Member memory) { return members[member]; }
    function getCyclesCompleted(address m)    external view returns (uint256)       { return members[m].cyclesCompleted; }
    function withdrawableOf(address member)   external view returns (uint256)       { return members[member].withdrawable; }
    function getMemberTotalWithdrawn(address member) external view returns (uint256) { return members[member].totalWithdrawn; }  // V8.10: keeper reads for rescue eligibility
    function escrowOf(address /* member */)   external pure  returns (uint256)       { return 0; } // V8.8: escrow removed
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
        fromEscrow   = 0;  // V8.8: escrow removed
        fromEarnings = members[member].withdrawable;
        total        = fromEarnings;
    }

    function getPendingCross() external view returns (address member, address referrer) {
        return (pendingCross, pendingCrossReferrer);
    }

    /// @notice V8.1: Pool distribution preview --- how much a member at `pos` would receive
    ///         if cycle-out fired right now with current poolAccumulator.
    /// @notice V8.1: Pool distribution preview -- how much a member at `pos` would receive
    ///         if cycle-out fired right now with current poolAccumulator.
    function poolSharePreview(uint256 pos) external view returns (uint256) {
        if (poolAccumulator == 0 || pos < 2 || pos > MATRIX_SIZE) return 0;
        uint256 N           = MATRIX_SIZE;
        uint256 totalWeight = N * (N + 1) / 2 - 1;
        return poolAccumulator * pos / totalWeight;
    }

    /// @notice V8.7: Return all BPS splits (7 fields -- l2/l3 removed, buyback added).
    function getSplits()
        external view
        returns (
            uint256 l1Bps,
            uint256 chainBps,
            uint256 poolBps,
            uint256 treasuryBps,
            uint256 stabilityBps,
            uint256 devBps,
            uint256 opsBps,
            uint256 communityBps,
            uint256 buybackBps
        )
    {
        return (
            SPLIT_L1_BPS,
            SPLIT_CHAIN_BPS,
            SPLIT_POOL_BPS,
            SPLIT_TREASURY_BPS,
            SPLIT_STABILITY_BPS,
            SPLIT_DEV_BPS,
            SPLIT_OPS_BPS,
            SPLIT_COMMUNITY_BPS,
            SPLIT_BUYBACK_BPS
        );
    }
}
