// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  FigureEightMatrixV8 (library-backed, V8.21)
 * @notice Same external behavior/ABI as the original FigureEightMatrixV8, but
 *         all BFS/cycling/payment/withdraw/rescue logic now lives in the
 *         externally-deployed MatrixLogicLib and runs via delegatecall. This
 *         contract holds only: immutable per-instance config, the MatrixState
 *         storage struct, thin wrapper functions that preserve the exact same
 *         external ABI as the pre-V8.21 contract, and view functions that read
 *         directly from the struct (no need to go through the library for
 *         plain reads).
 *
 *         Why: FigureEightMatrixV8 is deployed 20 times (MatA + MatB x 10
 *         tiers); every byte of its old monolithic bytecode was duplicated
 *         across all 20. It hit the EIP-170 24,576-byte limit during V8.20
 *         (24,758 bytes) and was patched back under the limit with a
 *         custom-error conversion (24,405 bytes, ~171 bytes/0.7% margin) --
 *         a real fix, but a finite one. This refactor moves the actual logic
 *         into a library deployed once, so all 20 instances shrink together
 *         and margin no longer erodes with every feature added to the matrix.
 *         Measured result (solc 0.8.26, optimizer runs=200, viaIR=true):
 *         24,446 -> 12,529 bytes per instance (51% of the limit, ~49% margin).
 *
 *         See MatrixLogicLib.sol for the actual business logic and
 *         memory note future_library_extraction.md for the full decision
 *         history and trade-offs.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";
import "./MatrixV8Interfaces.sol";
import "./MatrixLogicLib.sol";

contract FigureEightMatrixV8 is Ownable2Step {
    using SafeERC20 for IERC20;

    // --- Immutables -------------------------------------------------------------
    uint256 public immutable MATRIX_SIZE;
    uint256 public immutable ENTRY_FEE;
    bool    public immutable isMatrixA;
    uint8   public immutable tierIndex;

    uint256 public immutable SPLIT_L1_BPS;
    uint256 public immutable SPLIT_CHAIN_BPS;
    uint256 public immutable SPLIT_POOL_BPS;
    uint256 public immutable SPLIT_TREASURY_BPS;
    uint256 public immutable SPLIT_DEV_BPS;
    uint256 public immutable SPLIT_OPS_BPS;
    uint256 public immutable SPLIT_COMMUNITY_BPS;
    uint256 public immutable SPLIT_STABILITY_BPS;
    uint256 public immutable SPLIT_BUYBACK_BPS;
    uint256 public immutable SPLIT_LIQUIDITY_BPS;
    uint256 public constant  BPS_DENOM = 10_000;

    IERC20         public immutable usdc;
    CNOVAToken     public immutable cnova;
    CNOVATreasury  public immutable treasury;
    address        public immutable devWallet;
    address        public immutable opsWallet;

    // --- Mutable state, bundled for the library --------------------------------
    MatrixLogicLib.MatrixState private _state;

    // --- Events (re-declared here too so this contract's own ABI advertises
    //     them -- Solidity does not surface a library's events in the
    //     contract's own ABI otherwise, which would break event-decoding
    //     tooling that reads the matrix contract's own ABI, e.g. BaseScan). ---
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
    event PoolDistributed(uint256 totalPool, uint256 cycleNumber);
    event PoolShareCredited(address indexed member, uint256 position, uint256 amount);
    event StabilityContribution(uint8 indexed tier, uint256 amount, uint8 layer);
    event SlotReclaimed(address indexed member, uint256 position, uint256 idleDuration);
    event WithdrawalFeeCharged(address indexed member, uint256 fee);
    event StabilityFundSet(address indexed addr);
    event MatrixKeeperSet(address indexed addr);
    event GovernanceSet(address indexed addr);
    event MemberParked(address indexed member, uint256 shortfall);
    event MemberEvicted(address indexed member, uint256 totalWithdrawn);
    event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed);
    event CouponRegistrySet(address indexed registry);
    event CouponApplied(address indexed member, bytes32 indexed codeHash, uint256 couponAmount, uint256 walletAmount);

    error F8V8_ZeroAddress();

    struct SplitConfig {
        uint256 l1Bps;
        uint256 chainBps;
        uint256 poolBps;
        uint256 treasuryBps;
        uint256 stabilityBps;
        uint256 devBps;
        uint256 opsBps;
        uint256 communityBps;
        uint256 buybackBps;
        uint256 liquidityBps;
    }

    struct DeployParams {
        address usdc;
        address cnova;
        address treasury;
        address devWallet;
        address opsWallet;
        address accountOne;
        address admin;
    }

    // --- Constructor -------------------------------------------------------------
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
        require(_p.devWallet    != address(0), "F8V8: zero devWallet");
        require(_p.opsWallet    != address(0), "F8V8: zero opsWallet");
        require(_p.accountOne   != address(0), "F8V8: zero accountOne");
        require(_entryFee     > 0,             "F8V8: zero fee");
        require(_matrixSize   >= 3 && _matrixSize <= 1023, "F8V8: invalid size");
        require(_tierIndex    < 10,            "F8V8: invalid tier");

        uint256 sum = _splits.l1Bps + _splits.chainBps + _splits.poolBps
            + _splits.treasuryBps + _splits.stabilityBps
            + _splits.devBps + _splits.opsBps + _splits.communityBps
            + _splits.buybackBps + _splits.liquidityBps;
        // V8.32: splits now sum to 4750 BPS (50% crossing reserve + 2.5% direct earn
        // are allocated BEFORE the BPS array in _distributePayments; total = 5000+250+4750=10000)
        require(sum == 4_750, "F8V8: splits != 4750");

        usdc         = IERC20(_p.usdc);
        cnova        = CNOVAToken(_p.cnova);
        treasury     = CNOVATreasury(_p.treasury);
        devWallet    = _p.devWallet;
        opsWallet    = _p.opsWallet;
        ENTRY_FEE    = _entryFee;
        MATRIX_SIZE  = _matrixSize;
        isMatrixA    = _isMatrixA;
        tierIndex    = _tierIndex;

        SPLIT_L1_BPS        = _splits.l1Bps;
        SPLIT_CHAIN_BPS     = _splits.chainBps;
        SPLIT_POOL_BPS      = _splits.poolBps;
        SPLIT_TREASURY_BPS  = _splits.treasuryBps;
        SPLIT_DEV_BPS       = _splits.devBps;
        SPLIT_OPS_BPS       = _splits.opsBps;
        SPLIT_COMMUNITY_BPS = _splits.communityBps;
        SPLIT_STABILITY_BPS = _splits.stabilityBps;
        SPLIT_BUYBACK_BPS   = _splits.buybackBps;
        SPLIT_LIQUIDITY_BPS = _splits.liquidityBps;

        _state.accountOne          = _p.accountOne;
        _state.nextSlot            = 1;
        _state.withdrawalFeeBps    = 150;
        // V8.21: earlyExitPenaltyBps default-set line removed -- the field,
        // its setter, and its getter were deleted entirely (stored + DAO-votable
        // but never actually consumed by any withdraw/cycle logic; see
        // V8Governance.sol's PARAM_EARLY_EXIT_PENALTY_BPS retirement note).
        for (uint256 i = 0; i < 6; i++) {
            _state.chainPayBps[i] = _chainPayBps[i];
        }
    }

    /// @dev Rebuilds the immutable-config struct passed into every library call.
    ///      Cheap: every field here is either an immutable (free read) or a
    ///      contract reference already held by this contract.
    function _cfg() internal view returns (MatrixLogicLib.ImmutableConfig memory) {
        return MatrixLogicLib.ImmutableConfig({
            entryFee:           ENTRY_FEE,
            matrixSize:         MATRIX_SIZE,
            isMatrixA:          isMatrixA,
            tierIndex:          tierIndex,
            splitL1Bps:         SPLIT_L1_BPS,
            splitChainBps:      SPLIT_CHAIN_BPS,
            splitPoolBps:       SPLIT_POOL_BPS,
            splitTreasuryBps:   SPLIT_TREASURY_BPS,
            splitDevBps:        SPLIT_DEV_BPS,
            splitOpsBps:        SPLIT_OPS_BPS,
            splitCommunityBps:  SPLIT_COMMUNITY_BPS,
            splitStabilityBps:  SPLIT_STABILITY_BPS,
            splitBuybackBps:    SPLIT_BUYBACK_BPS,
            splitLiquidityBps:  SPLIT_LIQUIDITY_BPS,
            usdc:               usdc,
            cnova:              cnova,
            treasury:           treasury,
            devWallet:          devWallet,
            opsWallet:          opsWallet
        });
    }

    // --- Admin setters -----------------------------------------------------------

    function setPartner(address _partner) external onlyOwner {
        if (_partner == address(0)) revert F8V8_ZeroAddress();
        require(_partner != address(this), "F8V8: self partner");
        _state.partner = _partner;
        emit PartnerSet(_partner, isMatrixA);
    }

    function setTierRouter(address _tr) external onlyOwner {
        _state.tierRouter = _tr;
    }

    function setPairManager(address _pm) external onlyOwner {
        _state.pairManager = _pm;
    }

    function setAccountOne(address _a1) external onlyOwner {
        if (_a1 == address(0)) revert F8V8_ZeroAddress();
        _state.accountOne = _a1;
    }

    function setChainNext(address _next) external {
        require(
            msg.sender == owner() || msg.sender == _state.pairManager,
            "F8V8: not chain admin"
        );
        _state.chainNext = _next;
    }

    function setChainAuthorized(address caller, bool authorized) external {
        require(
            msg.sender == owner()             ||
            msg.sender == _state.pairManager  ||
            msg.sender == _state.tierRouter,
            "F8V8: not chain admin"
        );
        _state.chainAuthorized[caller] = authorized;
    }

    function setStabilityFund(address _sf) external onlyOwner {
        if (_sf == address(0)) revert F8V8_ZeroAddress();
        _state.stabilityFund = _sf;
        emit StabilityFundSet(_sf);
    }

    function setBuybackReserve(address _bbr) external onlyOwner {
        if (_bbr == address(0)) revert F8V8_ZeroAddress();
        _state.buybackReserve = _bbr;
    }

    function setLiquidityReserve(address _lr) external onlyOwner {
        if (_lr == address(0)) revert F8V8_ZeroAddress();
        _state.liquidityReserve = _lr;
    }

    function setGovernance(address _gov) external onlyOwner {
        if (_gov == address(0)) revert F8V8_ZeroAddress();
        _state.governance = _gov;
        emit GovernanceSet(_gov);
    }

    function setMatrixKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert F8V8_ZeroAddress();
        _state.matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    function setCommunityWallet(address _cw) external onlyOwner {
        _state.communityWallet = _cw;
    }

    /// @notice Wire the CouponRegistry.  Set to address(0) to disable coupon redemption.
    function setCouponRegistry(address _registry) external onlyOwner {
        _state.couponRegistry = _registry;
        emit CouponRegistrySet(_registry);
    }

    // --- Governance setters (DAO-votable, enumerated menus only) ---------------

    /// @notice V8.21: added `_state.pairManager` to the allow-list. PairManagerV8
    ///         broadcasts a single governance-voted fee change to every pair
    ///         instance it has ever added (see PairManagerV8.setWithdrawalFeeBps),
    ///         since each pair is a SEPARATE FigureEightMatrixV8 deployment with
    ///         its own independent storage -- this is the actual governance
    ///         target for param 9 now (one PairManagerV8 per tier), not TierRouter
    ///         (which never implemented this setter) or a single matrix instance.
    function setWithdrawalFeeBps(uint256 _bps) external {
        require(
            msg.sender == owner() || msg.sender == _state.tierRouter ||
            msg.sender == _state.governance || msg.sender == _state.pairManager,
            "F8V8: not governance"
        );
        require(
            _bps == 50 || _bps == 100 || _bps == 150 || _bps == 200 || _bps == 250,
            "F8V8: invalid fee (allowed: 50,100,150,200,250)"
        );
        _state.withdrawalFeeBps = _bps;
    }

    // V8.21: setEarlyExitPenaltyBps() removed entirely -- the field, this
    // setter, and the bare getter below were all deleted. The param it backed
    // (PARAM_EARLY_EXIT_PENALTY_BPS, id 10 in V8Governance.sol) was stored and
    // DAO-votable but never actually consumed by any withdraw/cycle logic --
    // dead state, same situation as TierRouter's escrowFloorMultiplier. The
    // real, working early-exit penalty is CNOVATreasury's hardcoded time-tiered
    // redeemAtFloor() schedule, which is intentionally not governed by this param.

    // --- TierRouter: fund extraction --------------------------------------------

    function deductForUpgrade(address member, uint256 escrowAmt, uint256 withdrawableAmt) external {
        require(msg.sender == _state.tierRouter, "F8V8: not tierRouter");
        MatrixLogicLib.deductForUpgrade(_state, _cfg(), member, escrowAmt, withdrawableAmt);
        emit UpgradeFundsDeducted(member, escrowAmt, withdrawableAmt);
    }

    // --- Registration -------------------------------------------------------------

    function register(address referrer) external {
        require(
            !_state.members[msg.sender].hasEverJoined || !_state.members[msg.sender].isInMatrix,
            "F8V8: already in matrix"
        );
        require(_state.partner != address(0), "F8V8: partner not set");

        address entry = isMatrixA ? address(this) : _state.partner;
        usdc.safeTransferFrom(msg.sender, entry, ENTRY_FEE);
        IFigureEightMatrixV8Cross(entry)._enterMatrix(msg.sender, referrer);
    }

    /// @notice Register with an on-chain coupon code that covers part or all of the entry fee.
    ///         Must be called on the MatA contract (the entry point) when using a coupon.
    /// @param referrer       The member who referred this new member.
    /// @param couponCodeHash keccak256(abi.encodePacked(plaintextCode)) — computed by the frontend.
    function registerWithCoupon(address referrer, bytes32 couponCodeHash) external {
        require(isMatrixA, "F8V8: coupon registration must use MatA");
        require(
            !_state.members[msg.sender].hasEverJoined || !_state.members[msg.sender].isInMatrix,
            "F8V8: already in matrix"
        );
        require(_state.partner != address(0),        "F8V8: partner not set");
        require(_state.couponRegistry != address(0), "F8V8: coupon registry not set");
        require(couponCodeHash != bytes32(0),         "F8V8: empty coupon hash");

        // Redeem coupon — registry transfers couponAmount USDC to this contract.
        uint256 couponCovered = ICouponRegistry(_state.couponRegistry).redeemCoupon(couponCodeHash, msg.sender);

        // Member pays only the remaining shortfall (zero if coupon fully covers the fee).
        uint256 fromWallet = ENTRY_FEE > couponCovered ? ENTRY_FEE - couponCovered : 0;
        if (fromWallet > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), fromWallet);
        }

        emit CouponApplied(msg.sender, couponCodeHash, couponCovered, fromWallet);
        // Route through this._enterMatrix so msg.sender == address(this) inside the library,
        // which passes the auth check without attempting another USDC pull.
        this._enterMatrix(msg.sender, referrer);
    }

    /// @notice V8.31: TierRouter-authorised coupon entry.
    ///         Called by TierRouter.registerWithCoupon() so the TierRouter bookkeeping
    ///         (globalJoined, memberReferrer, globalJoinedCount, CommunityWallet enroll)
    ///         fires before the matrix entry — identical USDC flow as registerWithCoupon()
    ///         but uses `member` for the wallet pull instead of `msg.sender`.
    /// @param member         The wallet registering (resolved by TierRouter).
    /// @param referrer       Resolved referrer (already validated by TierRouter).
    /// @param couponCodeHash keccak256 hash of the coupon code.
    function enterWithCouponFrom(address member, address referrer, bytes32 couponCodeHash) external {
        require(msg.sender == _state.tierRouter,     "F8V8: only tierRouter");
        require(isMatrixA,                           "F8V8: coupon registration must use MatA");
        require(
            !_state.members[member].hasEverJoined || !_state.members[member].isInMatrix,
            "F8V8: already in matrix"
        );
        require(_state.partner != address(0),        "F8V8: partner not set");
        require(_state.couponRegistry != address(0), "F8V8: coupon registry not set");
        require(couponCodeHash != bytes32(0),         "F8V8: empty coupon hash");

        // Redeem coupon — registry transfers couponAmount USDC to this contract.
        uint256 couponCovered = ICouponRegistry(_state.couponRegistry).redeemCoupon(couponCodeHash, member);

        // Member pays only the remaining shortfall (zero if coupon fully covers the fee).
        uint256 fromWallet = ENTRY_FEE > couponCovered ? ENTRY_FEE - couponCovered : 0;
        if (fromWallet > 0) {
            usdc.safeTransferFrom(member, address(this), fromWallet);
        }

        emit CouponApplied(member, couponCodeHash, couponCovered, fromWallet);
        this._enterMatrix(member, referrer);
    }

    function enterFor(address member, address referrer) external {
        require(msg.sender == _state.pairManager, "F8V8: not pairManager");
        require(
            !_state.members[member].hasEverJoined || !_state.members[member].isInMatrix,
            "F8V8: already in matrix"
        );
        require(_state.partner != address(0), "F8V8: partner not set");
        this._enterMatrix(member, referrer);
    }

    /// @notice Public so partner and chain-authorized matrices can call it for crossings.
    function _enterMatrix(address member, address referrer) external {
        MatrixLogicLib.enterMatrix(_state, _cfg(), member, referrer);
    }

    // --- Withdraw -------------------------------------------------------------

    function withdraw() external {
        MatrixLogicLib.withdrawCore(_state, _cfg(), msg.sender, 0, true);
    }

    function withdrawPartial(uint256 amount) external {
        require(amount > 0, "F8V8: amount must be > 0");
        MatrixLogicLib.withdrawCore(_state, _cfg(), msg.sender, amount, false);
    }

    function withdrawPartialTo(address recipient, uint256 amount) external {
        require(recipient != address(0), "F8V8: zero recipient");
        require(amount > 0, "F8V8: amount must be > 0");
        MatrixLogicLib.withdrawCore(_state, _cfg(), recipient, amount, false);
    }

    function withdrawTo(address recipient) external {
        require(recipient != address(0), "F8V8: zero recipient");
        MatrixLogicLib.withdrawCore(_state, _cfg(), recipient, 0, true);
    }

    // --- Keeper: reclaim idle slot -----------------------------------------------

    function reclaimIdleSlot(address member) external {
        require(msg.sender == _state.matrixKeeper, "F8V8: not keeper");
        MatrixLogicLib.reclaimIdleSlot(_state, member);
    }

    // --- Admin: forceCross --------------------------------------------------------

    function forceCross(address member) external onlyOwner {
        MatrixLogicLib.forceCross(_state, _cfg(), member);
    }

    // --- Admin: adminForceRotateRoot (V8.37) ------------------------------------

    /// @notice V8.37 emergency: manually trigger the root rotation on a frozen MatB.
    ///         Only valid on MatB (isMatrixA == false).
    ///
    ///         Use-case: the factory expanded to T1.2 at exactly 254 seats, routing
    ///         member 255 away from T1.1 MatA before T1.1 MatB could receive its 128th
    ///         entry and fire its first rotation.  This call manually executes the
    ///         cycle-out for the current root of this MatB, paying out pool distributions
    ///         and calling handleCycleOut on TierRouter — identical to what would have
    ///         happened naturally.  Safe to call multiple times (each call evicts one root).
    function adminForceRotateRoot() external onlyOwner {
        MatrixLogicLib.adminForceRotateRoot(_state, _cfg());
    }

    function forceCrossKeeper(address member, uint256 sfContribution, uint256 crossingBuffer) external {
        require(msg.sender == _state.matrixKeeper, "F8V8: not keeper");
        MatrixLogicLib.forceCrossKeeper(_state, _cfg(), member, sfContribution, crossingBuffer);
    }

    function coPayRescue(address member) external {
        MatrixLogicLib.coPayRescue(_state, _cfg(), member);
    }

    /// @notice Parked member rescues themselves by paying their own shortfall.
    ///         No SF loan. No debt. Call from the parked wallet directly.
    function selfRescue() external {
        MatrixLogicLib.selfRescue(_state, _cfg());
    }

    function evictParked(address member) external {
        require(msg.sender == _state.matrixKeeper, "F8V8: not keeper");
        MatrixLogicLib.evictParked(_state, member);
    }

    // --- Views ----------------------------------------------------------------

    function isParked(address member) external view returns (bool) {
        return _state.members[member].hasEverJoined && !_state.members[member].isInMatrix;
    }

    function getParkedCount() external view returns (uint256) { return _state.parkedMembers.length; }
    function getParkedMember(uint256 idx) external view returns (address) { return _state.parkedMembers[idx]; }

    function getMember(address member) external view returns (MatrixLogicLib.Member memory) { return _state.members[member]; }
    function getCyclesCompleted(address m) external view returns (uint256) { return _state.members[m].cyclesCompleted; }
    function withdrawableOf(address member) external view returns (uint256) { return _state.members[member].withdrawable; }
    function crossingReserveOf(address member) external view returns (uint256) { return _state.members[member].crossingReserve; }  // V8.31
    function rescueDebtOf(address member) external view returns (uint256) { return _state.rescueDebt[member]; }

    /// @notice Called by the partner MatA during forceCrossKeeper to record the
    ///         rescue loan on THIS contract (MatB), so the 15% gradual repayment
    ///         fires correctly on every MatB distribution and MatB cycle-out.
    ///         Only callable by the registered partner.
    function addRescueDebt(address member, uint256 amount) external {
        require(msg.sender == _state.partner, "F8V8: only partner");
        _state.rescueDebt[member] += amount;
    }

    function freeWithdrawable(address member) external view returns (uint256) {
        uint256 bal = _state.members[member].withdrawable;
        if (bal == 0) return 0;
        if (_state.members[member].isInMatrix) {
            // V8.31: crossing cost = ENTRY_FEE, funded from crossingReserve first then withdrawable.
            // Only lock the withdrawable portion needed beyond the reserve.
            uint256 crossNeeded = ENTRY_FEE > _state.members[member].crossingReserve
                ? ENTRY_FEE - _state.members[member].crossingReserve
                : 0;
            if (crossNeeded > 0) {
                if (bal <= crossNeeded) return 0;
                bal -= crossNeeded;
            }
        }
        if (_state.tierRouter != address(0)) {
            uint8 highest = ITierRouter(_state.tierRouter).memberHighestTier(member);
            if (highest > 0 && (highest - 1) == tierIndex) {
                uint256 res = ITierRouter(_state.tierRouter).reservedFor(member);
                if (res >= bal) return 0;
                bal -= res;
            }
        }
        return bal;
    }

    function getMemberTotalWithdrawn(address member) external view returns (uint256) { return _state.members[member].totalWithdrawn; }
    function escrowOf(address /* member */) external pure returns (uint256) { return 0; }
    function isFull() external view returns (bool) { return _state.occupancy == MATRIX_SIZE; }
    function isActiveInMatrix(address member) external view returns (bool) { return _state.members[member].isInMatrix; }
    function isInMatrix(address member) external view returns (bool) { return _state.members[member].isInMatrix; }

    function getIdleSeconds(address member) external view returns (uint256) {
        if (_state.lastActivityTime[member] == 0) return 0;
        return block.timestamp - _state.lastActivityTime[member];
    }

    function crossingFundsOf(address member)
        external view
        returns (uint256 total, uint256 fromEscrow, uint256 fromEarnings)
    {
        fromEscrow   = 0;
        fromEarnings = _state.members[member].withdrawable;
        total        = fromEarnings;
    }

    function getPendingCross() external view returns (address member, address referrer) {
        return (_state.pendingCross, _state.pendingCrossReferrer);
    }

    function poolSharePreview(uint256 pos) external view returns (uint256) {
        if (_state.poolAccumulator == 0 || pos < 2 || pos > MATRIX_SIZE) return 0;
        uint256 N           = MATRIX_SIZE;
        uint256 totalWeight = N * (N + 1) / 2 - 1;
        return _state.poolAccumulator * pos / totalWeight;
    }

    function getSplitConfig()
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
            uint256 buybackBps,
            uint256 liquidityBps
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
            SPLIT_BUYBACK_BPS,
            SPLIT_LIQUIDITY_BPS
        );
    }

    // --- Storage-struct field getters (preserve the original public-storage ABI) -

    function partner() external view returns (address) { return _state.partner; }
    function chainNext() external view returns (address) { return _state.chainNext; }
    function chainAuthorized(address a) external view returns (bool) { return _state.chainAuthorized[a]; }
    function matrixPos(address m) external view returns (uint256) { return _state.matrixPos[m]; }
    function posToMember(uint256 p) external view returns (address) { return _state.posToMember[p]; }
    function occupancy() external view returns (uint256) { return _state.occupancy; }
    function nextSlot() external view returns (uint256) { return _state.nextSlot; }
    function rotationCount() external view returns (uint256) { return _state.rotationCount; }
    function joinCountSinceRotation() external view returns (uint256) { return _state.joinCountSinceRotation; }
    function lastRotationTimestamp() external view returns (uint256) { return _state.lastRotationTimestamp; }
    function pendingCross() external view returns (address) { return _state.pendingCross; }
    function pendingCrossReferrer() external view returns (address) { return _state.pendingCrossReferrer; }
    function parkedMembers(uint256 i) external view returns (address) { return _state.parkedMembers[i]; }
    function parkedAt(address m) external view returns (uint256) { return _state.parkedAt[m]; }
    function poolAccumulator() external view returns (uint256) { return _state.poolAccumulator; }
    function lastActivityTime(address m) external view returns (uint256) { return _state.lastActivityTime[m]; }
    function withdrawalFeeBps() external view returns (uint256) { return _state.withdrawalFeeBps; }
    // V8.21: earlyExitPenaltyBps() getter removed -- field deleted entirely.
    function noReferrerPoolRouted() external view returns (uint256) { return _state.noReferrerPoolRouted; }
    function noReferrerFounderRouted() external view returns (uint256) { return _state.noReferrerFounderRouted; }
    function members(address m) external view returns (MatrixLogicLib.Member memory) { return _state.members[m]; }
    function totalJoined() external view returns (uint256) { return _state.totalJoined; }
    function tierRouter() external view returns (address) { return _state.tierRouter; }
    function pairManager() external view returns (address) { return _state.pairManager; }
    function accountOne() external view returns (address) { return _state.accountOne; }
    function stabilityFund() external view returns (address) { return _state.stabilityFund; }
    function communityWallet() external view returns (address) { return _state.communityWallet; }
    function buybackReserve() external view returns (address) { return _state.buybackReserve; }
    function liquidityReserve() external view returns (address) { return _state.liquidityReserve; }
    function governance() external view returns (address) { return _state.governance; }
    function matrixKeeper() external view returns (address) { return _state.matrixKeeper; }
    function couponRegistry() external view returns (address) { return _state.couponRegistry; }
    function chainPayBps(uint256 i) external view returns (uint256) { return _state.chainPayBps[i]; }
}
