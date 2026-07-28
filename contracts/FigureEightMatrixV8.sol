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

    // --- V8.41 FIFO: pair index ------------------------------------------------
    /// @notice Which pair slot this matrix occupies within its PairManager
    ///         (0 = T1.1, 1 = T1.2, 2 = T1.3 …). Set once by addPair() via
    ///         setPairIndex(); used by TierRouter.handleCycleOut() to route
    ///         MatB graduates to pairIndex+1 (FIFO graduation chain).
    uint256 public pairIndex;

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
    // V8.44 size-diet errors (EIP-170: factory embeds this contract's creation
    // code and went over the limit). Strings that tests/tools assert are KEPT;
    // everything else uses these compact errors.
    error F8V8_NotAuthorized();
    error F8V8_BadValue();
    error F8V8_BadConfig();

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
        // V8.44: constructor guards use compact custom errors — these strings
        // lived in the CREATION code, which MatrixPairFactory embeds (EIP-170).
        if (_p.usdc == address(0) || _p.cnova == address(0) || _p.treasury == address(0)
            || _p.devWallet == address(0) || _p.opsWallet == address(0)
            || _p.accountOne == address(0)) revert F8V8_ZeroAddress();
        if (_entryFee == 0 || _matrixSize < 3 || _matrixSize > 1023 || _tierIndex >= 10)
            revert F8V8_BadValue();

        uint256 sum = _splits.l1Bps + _splits.chainBps + _splits.poolBps
            + _splits.treasuryBps + _splits.stabilityBps
            + _splits.devBps + _splits.opsBps + _splits.communityBps
            + _splits.buybackBps + _splits.liquidityBps;
        // V8.32: splits now sum to 4750 BPS (50% crossing reserve + 2.5% direct earn
        // are allocated BEFORE the BPS array in _distributePayments; total = 5000+250+4750=10000)
        if (sum != 4_750) revert F8V8_BadConfig();

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

    // --- V8.44 size-diet shared guards (dedupe repeated require sites) --------
    function _onlyTierRouter() private view {
        if (msg.sender != _state.tierRouter) revert F8V8_NotAuthorized();
    }
    function _requirePartner() private view {
        if (_state.partner == address(0)) revert F8V8_BadConfig();
    }
    /// @dev V8.46: the PARTNER half of this check lives in MatrixLogicLib's
    ///      enterMatrix, NOT here. Every seating path in this contract ends in
    ///      _enterMatrix, so the library is the true chokepoint — and it is
    ///      linked rather than embedded, so guarding there costs
    ///      MatrixPairFactory nothing. Putting it here pushed the factory 75
    ///      bytes over EIP-170.
    function _requireNotSeated(address member) private view {
        require(
            !_state.members[member].hasEverJoined || !_state.members[member].isInMatrix,
            "F8V8: already in matrix"
        );
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
        if (_partner == address(this)) revert F8V8_BadValue();
        _state.partner = _partner;
        emit PartnerSet(_partner, isMatrixA);
    }

    function setTierRouter(address _tr) external onlyOwner {
        _state.tierRouter = _tr;
    }

    function setPairManager(address _pm) external onlyOwner {
        _state.pairManager = _pm;
    }

    /// @notice V8.41 FIFO: called by PairManagerV8.addPair() to stamp this matrix
    ///         with its position in the pair array (0 = T1.1, 1 = T1.2 …).
    ///         Access: owner (deployer or MatrixPairFactory.pairAdmin) OR pairManager.
    function setPairIndex(uint256 idx) external {
        if (msg.sender != owner() && msg.sender != _state.pairManager) revert F8V8_NotAuthorized();
        pairIndex = idx;
    }

    function setAccountOne(address _a1) external onlyOwner {
        if (_a1 == address(0)) revert F8V8_ZeroAddress();
        _state.accountOne = _a1;
    }

    function setChainNext(address _next) external {
        if (msg.sender != owner() && msg.sender != _state.pairManager) revert F8V8_NotAuthorized();
        _state.chainNext = _next;
    }

    function setChainAuthorized(address caller, bool authorized) external {
        if (msg.sender != owner() && msg.sender != _state.pairManager
            && msg.sender != _state.tierRouter) revert F8V8_NotAuthorized();
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
        if (_bps != 50 && _bps != 100 && _bps != 150 && _bps != 200 && _bps != 250)
            revert F8V8_BadValue();
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
        _onlyTierRouter();
        MatrixLogicLib.deductForUpgrade(_state, _cfg(), member, escrowAmt, withdrawableAmt);
        emit UpgradeFundsDeducted(member, escrowAmt, withdrawableAmt);
    }

    /// @notice V8.44 (item B): TierRouter parks a member whose MatB cycle-out
    ///         could not fund a re-entry — see MatrixLogicLib.parkCycledOut.
    function parkCycledOut(address member, uint256 shortfall) external {
        _onlyTierRouter();
        MatrixLogicLib.parkCycledOut(_state, member, shortfall);
    }

    /// @notice V8.44 (item B/I3): TierRouter releases an exiting member's
    ///         un-consumed crossing reserve to withdrawable (clean graduation).
    function releaseReserve(address member) external {
        _onlyTierRouter();
        MatrixLogicLib.releaseReserve(_state, member);
    }

    /// @notice V8.44 (item C): admin recovery of a STRANDED crossing reserve —
    ///         a member who is out of the matrix and NOT parked has no
    ///         member-facing path to a leftover reserve (parked members' path
    ///         is selfRescue; exiting members are released automatically by the
    ///         V8.44 engine — this valve exists for pathological drift only).
    ///         Releases to the member's withdrawable, never to the admin.
    ///         Guards + event live in MatrixLogicLib (size diet).
    event StrandedReserveReleased(address indexed member, uint256 amount);

    function adminReleaseStrandedReserve(address member) external onlyOwner {
        MatrixLogicLib.releaseStranded(_state, member);
    }

    /// @notice V8.44 (item E): one-step ownership handoff. Ownable2Step's
    ///         transferOwnership only sets pendingOwner — factory-spawned
    ///         matrices stayed factory-owned forever because nothing ever
    ///         called acceptOwnership (the V8.43 admin-orphan root cause).
    ///         The factory calls this at the end of deployAndWire, and
    ///         sweepMatrixOwnership uses it to recover existing orphans.
    function adminHandoff(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert F8V8_ZeroAddress();
        _transferOwnership(newOwner);
    }

    // --- Registration -------------------------------------------------------------

    function register(address referrer) external {
        _requireNotSeated(msg.sender);
        _requirePartner();

        address entry = isMatrixA ? address(this) : _state.partner;
        usdc.safeTransferFrom(msg.sender, entry, ENTRY_FEE);
        IFigureEightMatrixV8Cross(entry)._enterMatrix(msg.sender, referrer);
    }

    /// @notice Register with an on-chain coupon code that covers part or all of the entry fee.
    ///         Must be called on the MatA contract (the entry point) when using a coupon.
    /// @param referrer       The member who referred this new member.
    /// @param couponCodeHash keccak256(abi.encodePacked(plaintextCode)) — computed by the frontend.
    function registerWithCoupon(address referrer, bytes32 couponCodeHash) external {
        _couponEntry(msg.sender, referrer, couponCodeHash);
    }

    /// @notice V8.31: TierRouter-authorised coupon entry.
    ///         Called by TierRouter.registerWithCoupon() so the TierRouter bookkeeping
    ///         (globalJoined, memberReferrer, globalJoinedCount, CommunityWallet enroll)
    ///         fires before the matrix entry — identical USDC flow as registerWithCoupon()
    ///         but uses `member` for the wallet pull instead of `msg.sender`.
    function enterWithCouponFrom(address member, address referrer, bytes32 couponCodeHash) external {
        _onlyTierRouter();
        _couponEntry(member, referrer, couponCodeHash);
    }

    /// @dev V8.44 size-diet: shared body of the two coupon entry points (they
    ///      were byte-for-byte duplicates apart from auth + member source).
    function _couponEntry(address member, address referrer, bytes32 couponCodeHash) private {
        require(isMatrixA, "F8V8: coupon registration must use MatA");
        _requireNotSeated(member);
        _requirePartner();
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
        // Route through this._enterMatrix so msg.sender == address(this) inside the library,
        // which passes the auth check without attempting another USDC pull.
        this._enterMatrix(member, referrer);
    }

    function enterFor(address member, address referrer) external {
        if (msg.sender != _state.pairManager) revert F8V8_NotAuthorized();
        _requireNotSeated(member);
        _requirePartner();
        this._enterMatrix(member, referrer);
    }

    /// @notice Public so partner and chain-authorized matrices can call it for crossings.
    function _enterMatrix(address member, address referrer) external {
        MatrixLogicLib.enterMatrix(_state, _cfg(), member, referrer);
    }

    // --- Withdraw -------------------------------------------------------------

    function withdraw() external {
        MatrixLogicLib.withdrawCore(_state, _cfg(), msg.sender, msg.sender, 0, true);
    }

    function withdrawPartial(uint256 amount) external {
        if (amount == 0) revert F8V8_BadValue();
        MatrixLogicLib.withdrawCore(_state, _cfg(), msg.sender, msg.sender, amount, false);
    }

    function withdrawPartialTo(address recipient, uint256 amount) external {
        if (recipient == address(0)) revert F8V8_ZeroAddress();
        if (amount == 0) revert F8V8_BadValue();
        MatrixLogicLib.withdrawCore(_state, _cfg(), msg.sender, recipient, amount, false);
    }

    function withdrawTo(address recipient) external {
        if (recipient == address(0)) revert F8V8_ZeroAddress();
        MatrixLogicLib.withdrawCore(_state, _cfg(), msg.sender, recipient, 0, true);
    }

    /// @notice V8.44 (G2): TierRouter's bulkWithdraw sweep — full withdrawal of
    ///         `member`'s balance in THIS matrix, paid TO the member. All the
    ///         usual guards (crossing lock, automation reserve, withdrawal fee)
    ///         apply exactly as in a direct withdraw().
    function routerWithdrawFor(address member) external {
        _onlyTierRouter();
        MatrixLogicLib.withdrawCore(_state, _cfg(), member, member, 0, true);
    }

    // --- V8.44 graceful exit (I3 / BUGS.md option b) ---------------------------

    /// @notice Penalty applied to the RELEASED crossing reserve on a voluntary
    ///         mid-cycle exit (earnings never penalized). Routed to the SF.
    uint256 public exitPenaltyBps = 2_000;
    event MemberExitedSeat(address indexed member, uint256 position, uint256 reserveReleased, uint256 penalty);

    /// @notice DAO menu: 0, 10%, 20%, 30%, 50%.
    function setExitPenaltyBps(uint256 bps) external {
        require(
            msg.sender == owner() || msg.sender == _state.governance || msg.sender == _state.pairManager,
            "F8V8: not governance"
        );
        if (bps != 0 && bps != 1_000 && bps != 2_000 && bps != 3_000 && bps != 5_000)
            revert F8V8_BadValue();
        exitPenaltyBps = bps;
    }

    /// @notice Voluntarily leave this matrix (seat or parked queue) mid-cycle.
    ///         Releases the crossing reserve to withdrawable minus exitPenaltyBps.
    function exitSeat() external {
        MatrixLogicLib.exitSeat(_state, _cfg(), exitPenaltyBps);
    }

    // --- Keeper: reclaim idle slot -----------------------------------------------

    function reclaimIdleSlot(address member) external {
        require(msg.sender == _state.matrixKeeper, "F8V8: not keeper");
        MatrixLogicLib.reclaimIdleSlot(_state, _cfg(), member);
    }

    /// @notice V8.44 FIX: this wrapper was MISSING in V8.43 — the keeper's
    ///         _doReclaimSlot calls softParkIdle(member) on the matrix, which
    ///         hit no function and reverted into WorkItemFailed on every idle
    ///         soft-park attempt (silently broken since V8.33).
    function softParkIdle(address member) external {
        require(msg.sender == _state.matrixKeeper, "F8V8: not keeper");
        MatrixLogicLib.softParkIdle(_state, _cfg(), member);
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

    /// @notice Called by the matrix keeper to force-rotate a frozen MatB.
    ///         Identical to adminForceRotateRoot() but authorised by matrixKeeper,
    ///         not onlyOwner.  Required because factory-created MatBs (T1.2+, T2.2+…)
    ///         are owned by MatrixPairFactory.pairAdmin — which may differ from the
    ///         keeper's signing wallet.  The keeper is already trusted for
    ///         forceCrossKeeper() and evictParked(), so extending that trust here
    ///         is consistent and intentional.
    function keeperForceRotateRoot() external {
        require(msg.sender == _state.matrixKeeper, "F8V8: not keeper");
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
    /// @notice V8.44 (item D): includes the member's un-settled pool accrual —
    ///         externally the balance behaves exactly as the V8.43 eager loop.
    function withdrawableOf(address member) external view returns (uint256) {
        return _state.members[member].withdrawable
            + MatrixLogicLib.pendingPoolOf(_state, _cfg(), member);
    }
    /// @notice V8.44 (item D): raw stored balance + un-settled pool accrual, separately.
    function pendingPoolOf(address member) external view returns (uint256) {
        return MatrixLogicLib.pendingPoolOf(_state, _cfg(), member);
    }
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
        // V8.44 (item D): include un-settled pool accrual.
        uint256 bal = _state.members[member].withdrawable
            + MatrixLogicLib.pendingPoolOf(_state, _cfg(), member);
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
