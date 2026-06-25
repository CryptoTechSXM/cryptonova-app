// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";
import "./MatrixV8Interfaces.sol";

/// @title  MatrixLogicLib
/// @notice Deployed ONCE. Holds the core BFS/figure-eight business logic that
///         used to be duplicated in full across all 20 FigureEightMatrixV8
///         deployments (MatA + MatB x 10 tiers). Each matrix instance now holds
///         a thin wrapper + a MatrixState struct in its own storage, and
///         delegatecalls into this library for every state-mutating operation.
///
///         Because Solidity routes external-library calls that take a `storage`
///         argument through DELEGATECALL, every function below executes with:
///           - msg.sender / msg.value exactly as the caller saw them
///           - address(this) / event log address == the calling matrix instance
///           - storage reads/writes against the CALLING matrix's own storage
///         i.e. behavior is identical to the logic living inline in the matrix
///         contract, but the bytecode itself is not duplicated 20 times.
///
///         Immutable/constant per-instance config (ENTRY_FEE, MATRIX_SIZE, the
///         BPS splits, tierIndex, isMatrixA, usdc/cnova/treasury/dev/ops) can't
///         live in a storage struct -- immutables aren't SSTORE'd, so a
///         delegatecall'd library can't read another contract's immutables.
///         Instead, the thin wrapper reads its OWN immutables for free and
///         passes them in as an `ImmutableConfig memory` parameter each call.
library MatrixLogicLib {
    using SafeERC20 for IERC20;

    // --- Member data -----------------------------------------------------------
    struct Member {
        uint256 id;
        address referrer;
        uint256 joinedAt;
        uint256 withdrawable;
        uint256 totalEarned;
        uint256 totalWithdrawn;
        uint256 cyclesCompleted;
        bool    isInMatrix;
        bool    hasEverJoined;
    }

    /// @notice All mutable per-instance state. One of these lives in storage in
    ///         every FigureEightMatrixV8 deployment; every library function below
    ///         takes a `storage` pointer to it as its first argument.
    struct MatrixState {
        // -- Chain pay weights per BFS level (6 levels). Set once in the
        //    constructor; there is no setter in the original contract, but it
        //    is regular storage (arrays can't be `immutable` in Solidity), so
        //    it belongs here rather than in ImmutableConfig.
        uint256[6] chainPayBps;
        // -- BFS tree --
        mapping(address => uint256) matrixPos;
        mapping(uint256 => address) posToMember;
        uint256 occupancy;
        uint256 nextSlot;
        uint256 rotationCount;
        uint256 joinCountSinceRotation;
        uint256 lastRotationTimestamp;
        // -- Figure-8 partner / chain --
        address partner;
        address chainNext;
        mapping(address => bool) chainAuthorized;
        // -- Cascade guard --
        bool    crossingInProgress;
        address pendingCross;
        address pendingCrossReferrer;
        // -- Parked queue --
        address[] parkedMembers;
        mapping(address => uint256) parkedAt;
        // -- Equalization pool --
        uint256 poolAccumulator;
        // -- Activity tracking --
        mapping(address => uint256) lastActivityTime;
        // -- Governance-adjustable fee params --
        uint256 withdrawalFeeBps;
        // V8.21: earlyExitPenaltyBps field removed entirely -- it was stored
        // and DAO-votable (FigureEightMatrixV8.setEarlyExitPenaltyBps /
        // PARAM_EARLY_EXIT_PENALTY_BPS) but never actually consumed by any
        // withdraw/cycle logic in this library. See V8Governance.sol's
        // retirement note for the real (hardcoded, non-governed) early-exit
        // penalty mechanism, which lives in CNOVATreasury.redeemAtFloor().
        // -- Orphan fee health monitor --
        uint256 noReferrerPoolRouted;
        uint256 noReferrerFounderRouted;
        // -- SF rescue debt tracking --
        // Records USDC owed back to the SF per member after a coPayRescue.
        // Repaid incrementally from remaining withdrawable on each natural cycle-out.
        mapping(address => uint256) rescueDebt;
        // -- Members --
        mapping(address => Member) members;
        uint256 totalJoined;
        // -- Post-deploy wired addresses --
        address tierRouter;
        address pairManager;
        address accountOne;
        address stabilityFund;
        address communityWallet;
        address buybackReserve;
        address liquidityReserve;
        address governance;
        address matrixKeeper;
    }

    /// @notice Per-instance immutable config, rebuilt cheaply (from the calling
    ///         contract's own immutables) on every external call and passed by
    ///         value into library functions that need it.
    struct ImmutableConfig {
        uint256 entryFee;
        uint256 matrixSize;
        bool    isMatrixA;
        uint8   tierIndex;
        uint256 splitL1Bps;
        uint256 splitChainBps;
        uint256 splitPoolBps;
        uint256 splitTreasuryBps;
        uint256 splitDevBps;
        uint256 splitOpsBps;
        uint256 splitCommunityBps;
        uint256 splitStabilityBps;
        uint256 splitBuybackBps;
        uint256 splitLiquidityBps;
        IERC20        usdc;
        CNOVAToken    cnova;
        CNOVATreasury treasury;
        address       devWallet;
        address       opsWallet;
    }

    uint256 internal constant BPS_DENOM = 10_000;

    // --- Events (identical to the originals; emitted from library code, but the
    //     LOG opcode under delegatecall records the CALLING matrix's address,
    //     so on-chain consumers see no difference at all). -----------------------
    event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix);
    event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix);
    event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix);
    event CrossingFunded(address indexed member, uint256 fromEscrow, uint256 fromEarnings, uint256 total);
    event ChainPayDistributed(address indexed recipient, address indexed payer, uint256 level, uint256 amount);
    event OrphanFeePooled(uint256 poolShare, address destination, string source);
    event OrphanFeeRouted(uint256 amount, uint256 acct1Share, uint256 poolShare, uint256 founderShare, string source);
    event EarningsWithdrawn(address indexed member, uint256 amount);
    event PoolDistributed(uint256 totalPool, uint256 cycleNumber);
    event PoolShareCredited(address indexed member, uint256 position, uint256 amount);
    event StabilityContribution(uint8 indexed tier, uint256 amount, uint8 layer);
    event SlotReclaimed(address indexed member, uint256 position, uint256 idleDuration);
    event WithdrawalFeeCharged(address indexed member, uint256 fee);
    event MemberParked(address indexed member, uint256 shortfall);
    event MemberEvicted(address indexed member, uint256 totalWithdrawn);
    event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed);
    /// @notice Emitted when a member's SF rescue loan is (partially) repaid at cycle-out.
    event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining);

    error F8V8_ZeroAddress();

    // ===========================================================================
    // Registration / BFS entry
    // ===========================================================================

    function enterMatrix(
        MatrixState storage self,
        ImmutableConfig memory cfg,
        address member,
        address referrer
    ) external {
        require(
            msg.sender == address(this)  ||
            msg.sender == self.partner   ||
            msg.sender == self.pairManager ||
            self.chainAuthorized[msg.sender],
            "F8V8: not authorized"
        );
        require(!self.members[member].isInMatrix, "F8V8: already in matrix");

        if (msg.sender == self.partner || self.chainAuthorized[msg.sender]) {
            cfg.usdc.safeTransferFrom(msg.sender, address(this), cfg.entryFee);
        }

        self.joinCountSinceRotation += 1;
        self.lastActivityTime[member] = block.timestamp;

        if (!self.members[member].hasEverJoined) {
            self.totalJoined += 1;
            address l1 = (referrer != address(0) && self.members[referrer].hasEverJoined)
                ? referrer : address(0);

            self.members[member] = Member({
                id:              self.totalJoined,
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

        if (self.occupancy < cfg.matrixSize) {
            _placeInMatrix(self, member, self.nextSlot);
            self.nextSlot  += 1;
            self.occupancy += 1;
        } else {
            _cycleOutRoot(self, cfg);
            _placeInMatrix(self, member, self.nextSlot);
            self.occupancy += 1;
        }

        _distributePayments(self, cfg, member);

        try cfg.cnova.mintReward(member, cfg.tierIndex) {} catch {}

        emit MemberEntered(member, self.matrixPos[member], self.members[member].id, address(this));

        if (!cfg.isMatrixA && self.tierRouter != address(0)) {
            try ITierRouter(self.tierRouter).onCrossToMatB(member, cfg.tierIndex) {} catch {}
        }
    }

    function _placeInMatrix(MatrixState storage self, address member, uint256 slot) internal {
        self.matrixPos[member]          = slot;
        self.posToMember[slot]          = member;
        self.members[member].isInMatrix = true;
    }

    // ===========================================================================
    // Cycling / pool distribution / crossing
    // ===========================================================================

    function _cycleOutRoot(MatrixState storage self, ImmutableConfig memory cfg) internal {
        address root = self.posToMember[1];
        require(root != address(0), "F8V8: no root");

        _distributePool(self, cfg);

        self.matrixPos[root]               = 0;
        self.posToMember[1]                = address(0);
        self.members[root].isInMatrix      = false;
        self.members[root].cyclesCompleted += 1;
        self.occupancy             -= 1;
        self.rotationCount         += 1;
        self.joinCountSinceRotation = 0;
        self.lastRotationTimestamp  = block.timestamp;

        uint256 matrixSize = cfg.matrixSize;
        for (uint256 i = 1; i < matrixSize; i++) {
            address m = self.posToMember[i + 1];
            self.posToMember[i]     = m;
            self.posToMember[i + 1] = address(0);
            if (m != address(0)) self.matrixPos[m] = i;
        }
        self.nextSlot = matrixSize;

        emit MemberCycledOut(root, self.members[root].cyclesCompleted, self.rotationCount, address(this));

        if (!cfg.isMatrixA && self.tierRouter != address(0)) {
            try ITierRouter(self.tierRouter).handleCycleOut(
                root,
                cfg.tierIndex,
                0,
                self.members[root].withdrawable
            ) {} catch {}
        } else {
            _crossToPartner(self, cfg, root);
        }
    }

    function _distributePool(MatrixState storage self, ImmutableConfig memory cfg) internal {
        if (self.poolAccumulator == 0) return;

        uint256 N           = cfg.matrixSize;
        uint256 totalWeight = N * (N + 1) / 2 - 1;

        uint256 pool    = self.poolAccumulator;
        self.poolAccumulator = 0;

        uint256 distributed = 0;
        address firstNonNull = address(0);

        for (uint256 pos = 2; pos <= N; pos++) {
            address m = self.posToMember[pos];
            if (m == address(0)) continue;
            if (firstNonNull == address(0)) firstNonNull = m;

            uint256 share = pool * pos / totalWeight;
            if (share == 0) continue;

            distributed += share;
            _credit(self, m, share);
            emit PoolShareCredited(m, pos, share);
        }

        uint256 dust = pool - distributed;
        if (dust > 0) {
            address dest = self.posToMember[2] != address(0)
                ? self.posToMember[2]
                : firstNonNull;
            if (dest != address(0)) {
                _credit(self, dest, dust);
            } else if (cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, dust);
            }
        }

        emit PoolDistributed(pool, self.rotationCount);
    }

    function _crossToPartner(MatrixState storage self, ImmutableConfig memory cfg, address member) internal {
        require(self.partner != address(0), "F8V8: no partner");

        if (self.crossingInProgress) {
            self.pendingCross         = member;
            self.pendingCrossReferrer = self.members[member].referrer;
            return;
        }

        address destination;
        if (!cfg.isMatrixA && self.chainNext != address(0)) {
            destination = self.chainNext;
        } else {
            destination = self.partner;
        }

        uint256 reentryFee = IFigureEightMatrixV8Cross(destination).ENTRY_FEE();

        uint256 earnings = self.members[member].withdrawable;

        if (earnings < reentryFee) {
            uint256 shortfall = reentryFee - earnings;
            self.parkedMembers.push(member);
            self.parkedAt[member] = block.timestamp;
            emit MemberParked(member, shortfall);
            return;
        }

        self.members[member].withdrawable -= reentryFee;

        emit CrossingFunded(member, 0, reentryFee, reentryFee);

        SafeERC20.forceApprove(cfg.usdc, destination, reentryFee);

        self.crossingInProgress = true;
        emit MemberCrossedToPartner(member, address(this), destination);
        IFigureEightMatrixV8Cross(destination)._enterMatrix(member, self.members[member].referrer);
        self.crossingInProgress = false;

        // ── SF rescue loan repayment ──────────────────────────────────────────
        // After paying the crossing fee, any remaining withdrawable is used to
        // repay outstanding rescue debt to the SF (partial repayment is fine).
        // This does NOT block or re-park the member — it's a soft recovery.
        uint256 debt = self.rescueDebt[member];
        if (debt > 0 && self.stabilityFund != address(0)) {
            uint256 remaining = self.members[member].withdrawable;
            if (remaining > 0) {
                uint256 repay = remaining >= debt ? debt : remaining;
                self.rescueDebt[member] -= repay;
                self.members[member].withdrawable -= repay;
                SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, repay);
                IStabilityFund(self.stabilityFund).receiveDebtRepayment(repay);
                emit RescueDebtRepaid(member, repay, self.rescueDebt[member]);
            }
        }
    }

    /// @dev Shared tail for forceCross/forceCrossKeeper/topUpAndCross/coPayRescue.
    function finalizeCrossing(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        _finalizeCrossing(self, cfg, member);
    }

    function _finalizeCrossing(MatrixState storage self, ImmutableConfig memory cfg, address member) internal {
        address destination = (!cfg.isMatrixA && self.chainNext != address(0))
            ? self.chainNext : self.partner;
        SafeERC20.forceApprove(cfg.usdc, destination, cfg.entryFee);

        emit MemberCrossedToPartner(member, address(this), destination);
        IFigureEightMatrixV8Cross(destination)._enterMatrix(member, self.members[member].referrer);
    }

    // ===========================================================================
    // Payment distribution
    // ===========================================================================

    function distributePayments(MatrixState storage self, ImmutableConfig memory cfg, address newMember) external {
        _distributePayments(self, cfg, newMember);
    }

    function _distributePayments(MatrixState storage self, ImmutableConfig memory cfg, address newMember) internal {
        Member storage m = self.members[newMember];

        uint256 l1Amt = cfg.entryFee * cfg.splitL1Bps / BPS_DENOM;
        if (m.referrer != address(0)) {
            _credit(self, m.referrer, l1Amt);
        } else {
            _routeOrphanFee(self, cfg, l1Amt, "L1");
        }

        _distributeChainPay(self, cfg, newMember);

        uint256 treasuryAmt = cfg.entryFee * cfg.splitTreasuryBps / BPS_DENOM;
        SafeERC20.forceApprove(cfg.usdc, address(cfg.treasury), treasuryAmt);
        cfg.treasury.depositReserve(treasuryAmt);

        uint256 poolAmt = cfg.entryFee * cfg.splitPoolBps / BPS_DENOM;
        self.poolAccumulator += poolAmt;

        uint256 stabilityAmt = cfg.entryFee * cfg.splitStabilityBps / BPS_DENOM;
        if (stabilityAmt > 0) {
            _forwardToStabilityFund(self, cfg, stabilityAmt, 1);
        }

        uint256 buybackAmt = cfg.entryFee * cfg.splitBuybackBps / BPS_DENOM;
        if (buybackAmt > 0) {
            _forwardToBuybackReserve(self, cfg, buybackAmt);
        }

        uint256 liquidityAmt = cfg.entryFee * cfg.splitLiquidityBps / BPS_DENOM;
        if (liquidityAmt > 0 && self.liquidityReserve != address(0)) {
            cfg.usdc.safeTransfer(self.liquidityReserve, liquidityAmt);
        } else if (liquidityAmt > 0 && cfg.devWallet != address(0)) {
            cfg.usdc.safeTransfer(cfg.devWallet, liquidityAmt);
        }

        uint256 devAmt = cfg.entryFee * cfg.splitDevBps / BPS_DENOM;
        if (devAmt > 0 && cfg.devWallet != address(0)) {
            cfg.usdc.safeTransfer(cfg.devWallet, devAmt);
        }

        uint256 opsAmt = cfg.entryFee * cfg.splitOpsBps / BPS_DENOM;
        if (opsAmt > 0 && cfg.opsWallet != address(0)) {
            cfg.usdc.safeTransfer(cfg.opsWallet, opsAmt);
        }

        uint256 communityAmt = cfg.entryFee * cfg.splitCommunityBps / BPS_DENOM;
        if (communityAmt > 0) {
            if (self.communityWallet != address(0)) {
                SafeERC20.forceApprove(cfg.usdc, self.communityWallet, communityAmt);
                try ICommunityWalletV8(self.communityWallet).deposit(communityAmt) {}
                catch { cfg.usdc.safeTransfer(cfg.devWallet, communityAmt); }
            } else if (cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, communityAmt);
            }
        }
    }

    function _forwardToStabilityFund(MatrixState storage self, ImmutableConfig memory cfg, uint256 amount, uint8 layer) internal {
        if (amount == 0) return;
        if (self.stabilityFund != address(0)) {
            SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, amount);
            try IStabilityFund(self.stabilityFund).receiveLayer(cfg.tierIndex, amount, layer) {}
            catch { cfg.usdc.safeTransfer(cfg.devWallet, amount); }
        } else {
            if (cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, amount);
            }
        }
        emit StabilityContribution(cfg.tierIndex, amount, layer);
    }

    function _forwardToBuybackReserve(MatrixState storage self, ImmutableConfig memory cfg, uint256 amount) internal {
        if (amount == 0) return;
        if (self.buybackReserve != address(0)) {
            SafeERC20.forceApprove(cfg.usdc, self.buybackReserve, amount);
            cfg.usdc.safeTransfer(self.buybackReserve, amount);
        } else {
            if (cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, amount);
            }
        }
    }

    function _routeOrphanFee(MatrixState storage self, ImmutableConfig memory cfg, uint256 amount, string memory source) internal {
        if (amount == 0) return;

        uint256 acct1Share = amount * 20 / 100;
        _credit(self, self.accountOne, acct1Share);

        uint256 remaining = amount - acct1Share;

        (uint256 poolBps, uint256 founderBps) = _getOrphanRoutingRatios(self);
        uint256 denom      = poolBps + founderBps;
        uint256 poolShare  = remaining * poolBps / denom;
        uint256 founderShare = remaining - poolShare;

        if (poolShare > 0) {
            _forwardToCommunityPool(self, cfg, poolShare, source);
            self.noReferrerPoolRouted += poolShare;
        }

        if (founderShare > 0) {
            if (cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, founderShare);
                self.noReferrerFounderRouted += founderShare;
            } else {
                _credit(self, self.accountOne, founderShare);
            }
        }

        emit OrphanFeeRouted(amount, acct1Share, poolShare, founderShare, source);
    }

    function _forwardToCommunityPool(MatrixState storage self, ImmutableConfig memory cfg, uint256 amount, string memory source) internal {
        if (amount == 0) return;
        if (self.communityWallet != address(0)) {
            SafeERC20.forceApprove(cfg.usdc, self.communityWallet, amount);
            try ICommunityWalletV8(self.communityWallet).deposit(amount) {
                emit OrphanFeePooled(amount, self.communityWallet, source);
                return;
            } catch {
                // fall through to SF
            }
        }
        if (self.stabilityFund != address(0)) {
            SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, amount);
            try IStabilityFund(self.stabilityFund).receiveLayer(cfg.tierIndex, amount, 6) {}
                catch { _credit(self, self.accountOne, amount); }
        } else {
            _credit(self, self.accountOne, amount);
        }
        emit OrphanFeePooled(amount, self.communityWallet != address(0) ? self.communityWallet : self.stabilityFund, source);
    }

    function _getOrphanRoutingRatios(MatrixState storage self)
        internal view
        returns (uint256 poolBps, uint256 founderBps)
    {
        uint256 total = self.noReferrerPoolRouted + self.noReferrerFounderRouted;
        if (total == 0) return (4000, 4000);
        uint256 poolPct = self.noReferrerPoolRouted * 100 / total;
        if      (poolPct < 35) return (6000, 2000);
        else if (poolPct > 65) return (2000, 6000);
        return (4000, 4000);
    }

    function _distributeChainPay(MatrixState storage self, ImmutableConfig memory cfg, address newMember) internal {
        uint256 myPos = self.matrixPos[newMember];
        if (myPos == 0) return;

        uint256 parentPos = myPos / 2;
        for (uint256 lvl = 0; lvl < 6 && parentPos >= 1; lvl++) {
            address ancestor = self.posToMember[parentPos];
            if (ancestor != address(0)) {
                uint256 amt = cfg.entryFee * self.chainPayBps[lvl] / BPS_DENOM;
                _credit(self, ancestor, amt);
                emit ChainPayDistributed(ancestor, newMember, lvl + 1, amt);
            }
            parentPos = parentPos / 2;
        }
    }

    function _credit(MatrixState storage self, address recipient, uint256 amount) internal {
        if (recipient == address(0) || amount == 0) return;
        self.members[recipient].withdrawable += amount;
        self.members[recipient].totalEarned  += amount;
    }

    // ===========================================================================
    // Withdraw (deduped engine: same require order/messages on every call path
    // as the original four separate functions -- see FigureEightMatrixV8.sol's
    // thin wrappers for the four external entry points).
    // ===========================================================================

    function withdrawCore(
        MatrixState storage self,
        ImmutableConfig memory cfg,
        address recipient,
        uint256 amount,
        bool isFullWithdraw
    ) external {
        uint256 available = self.members[msg.sender].withdrawable;
        require(available > 0, "F8V8: nothing to withdraw");

        if (self.members[msg.sender].isInMatrix) {
            require(available > cfg.entryFee, "F8V8: must keep entry fee reserve while active");
            available = available - cfg.entryFee;
        }

        if (self.tierRouter != address(0)) {
            uint8 highest = ITierRouter(self.tierRouter).memberHighestTier(msg.sender);
            if (highest > 0 && (highest - 1) == cfg.tierIndex) {
                uint256 res = ITierRouter(self.tierRouter).reservedFor(msg.sender);
                require(res < available, "F8V8: balance fully reserved for automation");
                available -= res;
            }
        }

        uint256 amt = isFullWithdraw ? available : amount;
        if (!isFullWithdraw) {
            require(amt <= available, "F8V8: amount exceeds withdrawable");
        }

        self.members[msg.sender].withdrawable   -= amt;
        self.members[msg.sender].totalWithdrawn += amt;
        self.lastActivityTime[msg.sender] = block.timestamp;

        uint256 fee    = amt * self.withdrawalFeeBps / BPS_DENOM;
        uint256 payout = amt - fee;

        if (fee > 0) {
            _forwardToStabilityFund(self, cfg, fee, 3);
            emit WithdrawalFeeCharged(msg.sender, fee);
        }

        cfg.usdc.safeTransfer(recipient, payout);
        emit EarningsWithdrawn(msg.sender, payout);
    }

    // ===========================================================================
    // Parked queue: rescue / eviction
    // ===========================================================================

    function reclaimIdleSlot(MatrixState storage self, address member) external {
        require(self.members[member].isInMatrix, "F8V8: not in matrix");
        require(self.lastActivityTime[member] > 0, "F8V8: no activity record");

        uint256 pos      = self.matrixPos[member];
        uint256 idleTime = block.timestamp - self.lastActivityTime[member];

        self.posToMember[pos]           = address(0);
        self.matrixPos[member]          = 0;
        self.members[member].isInMatrix = false;
        self.occupancy                 -= 1;

        emit SlotReclaimed(member, pos, idleTime);
    }

    function forceCross(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.partner != address(0),           "F8V8: no partner");

        cfg.usdc.safeTransferFrom(msg.sender, address(this), cfg.entryFee);

        if (self.parkedAt[member] > 0) _removeFromParkedQueue(self, member);

        _finalizeCrossing(self, cfg, member);
    }

    function forceCrossKeeper(
        MatrixState storage self,
        ImmutableConfig memory cfg,
        address member,
        uint256 sfContribution
    ) external {
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.partner != address(0),           "F8V8: no partner");
        require(sfContribution <= cfg.entryFee,       "F8V8: sfContribution exceeds fee");

        uint256 memberShare = cfg.entryFee - sfContribution;
        if (memberShare > 0) {
            require(
                self.members[member].withdrawable >= memberShare,
                "F8V8: insufficient withdrawable for rescue"
            );
            self.members[member].withdrawable -= memberShare;
        }

        _removeFromParkedQueue(self, member);

        // Contract now holds full ENTRY_FEE: sfContribution (from SF) + memberShare (from withdrawable)
        _finalizeCrossing(self, cfg, member);
    }

    function topUpAndCross(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.parkedAt[member] > 0,            "F8V8: not parked");
        require(self.partner != address(0),           "F8V8: no partner");

        uint256 bal      = self.members[member].withdrawable;
        uint256 shortfall = bal >= cfg.entryFee ? 0 : cfg.entryFee - bal;

        if (shortfall > 0) {
            cfg.usdc.safeTransferFrom(msg.sender, address(this), shortfall);
        }

        uint256 memberContribution = cfg.entryFee - shortfall;
        if (memberContribution > 0) {
            self.members[member].withdrawable -= memberContribution;
        }

        _removeFromParkedQueue(self, member);

        _finalizeCrossing(self, cfg, member);
    }

    function coPayRescue(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.parkedAt[member] > 0,            "F8V8: not parked");
        require(self.partner != address(0),           "F8V8: no partner");
        require(self.stabilityFund != address(0),     "F8V8: no stabilityFund");

        uint256 withdrawable = self.members[member].withdrawable;
        require(withdrawable > 0, "F8V8: no withdrawable for coPayRescue");

        uint256 sfShare      = withdrawable / 2;
        uint256 shortfall    = cfg.entryFee > withdrawable ? cfg.entryFee - withdrawable : 0;
        uint256 memberShare  = shortfall > sfShare ? shortfall - sfShare : 0;

        self.members[member].withdrawable = 0;

        IStabilityFund(self.stabilityFund).payCoRescue(cfg.tierIndex, sfShare);

        // Record SF contribution as a soft loan — repaid from cycle-out earnings
        self.rescueDebt[member] += sfShare;

        if (memberShare > 0) {
            cfg.usdc.safeTransferFrom(msg.sender, address(this), memberShare);
        }

        _removeFromParkedQueue(self, member);

        emit CoPayRescue(member, sfShare, memberShare, withdrawable);
        _finalizeCrossing(self, cfg, member);
    }

    function _removeFromParkedQueue(MatrixState storage self, address member) internal {
        uint256 len = self.parkedMembers.length;
        for (uint256 i = 0; i < len; i++) {
            if (self.parkedMembers[i] == member) {
                self.parkedMembers[i] = self.parkedMembers[len - 1];
                self.parkedMembers.pop();
                self.parkedAt[member] = 0;
                return;
            }
        }
    }

    function evictParked(MatrixState storage self, address member) external {
        require(self.parkedAt[member] > 0,          "F8V8: member not parked");
        require(!self.members[member].isInMatrix,   "F8V8: member is in matrix");

        uint256 withdrawn = self.members[member].totalWithdrawn;
        _removeFromParkedQueue(self, member);

        emit MemberEvicted(member, withdrawn);
    }

    // ===========================================================================
    // TierRouter fund extraction
    // ===========================================================================

    function deductForUpgrade(
        MatrixState storage self,
        ImmutableConfig memory cfg,
        address member,
        uint256 escrowAmt,
        uint256 withdrawableAmt
    ) external {
        if (withdrawableAmt > 0) {
            require(
                self.members[member].withdrawable >= withdrawableAmt,
                "F8V8: insufficient earnings"
            );
            self.members[member].withdrawable -= withdrawableAmt;
        }

        uint256 total = escrowAmt + withdrawableAmt;
        if (total > 0) {
            cfg.usdc.safeTransfer(self.tierRouter, total);
        }
    }
}
