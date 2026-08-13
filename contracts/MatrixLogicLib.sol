// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";
import "./MatrixV8Interfaces.sol";

/// @notice V8.43: PairManager overflow routing (two-threshold pair opening).
///         V8.44 overflow rework: rescueOverflow (divert to next pair) is GONE —
///         a pair's OWN members always return to their OWN pair. rescueReentry
///         seats them in own MatA below saturation, own MatB at saturation
///         (the entry that keeps a full MatB churning). Only genuinely NEW
///         externals overflow forward (PairManagerV8._findExternalPair).
interface IPairManagerOverflow {
    function rescueReentry(address member, address referrer, uint256 fromPairIndex) external;
}

/// @notice V8.43: read the calling matrix's own pairIndex (contract-level public var).
interface IMatrixPairIndexView {
    function pairIndex() external view returns (uint256);
}

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
        // V8.31: 50/5/45 crossing reserve. Pre-funded on join (50% of entry fee).
        // Used first when member crosses; remainder funded from withdrawable pool earnings.
        // Field appended at end of struct to preserve storage layout of all prior fields.
        uint256 crossingReserve;
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
        // Records USDC owed back to the SF per member after any rescue path.
        // ALL rescue paths now create debt (forceCrossKeeper, coPayRescue).
        // Repaid automatically from withdrawable at each crossing
        // (_crossToPartner) and at MatB cycle-out (_cycleOutRoot).
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
        // -- Optional coupon registry (address(0) = disabled) --
        address couponRegistry;

        // -- V8.44 pull-based equalization pool (item D) --
        // O(1) accumulator accounting replaces the per-rotation 126-member
        // credit loop (the gas core of the ~15.5M full-cascade registration).
        // Per rotation event t with pool P_t:  poolA1 += P_t; poolAr += t·P_t.
        // A member seated at position p0 when rotationCount was r0 advances one
        // seat per rotation, so their exact accrued share between checkpoints:
        //   pending = (k·ΔpoolA1 − ΔpoolAr) / W,  k = p0 + r0 + 1,
        //   W = N(N+1)/2 − 1  (constant per matrix).
        // Same closed form as the old weighted drip; amounts identical in
        // exact arithmetic. Rounding: ONE floor at settle instead of one per
        // rotation — per-member deviation vs the old loop is bounded by the
        // number of rotations between checkpoints, in USDC wei (1e-6 $).
        // Fields appended at the END of the struct (layout discipline).
        uint256 poolA1;
        uint256 poolAr;
        mapping(address => uint256) poolK;        // p0 + r0 + 1; 0 = no checkpoint
        mapping(address => uint256) poolA1Snap;
        mapping(address => uint256) poolArSnap;
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

    /// @notice V8.31: 50/5/45 fee split constants.
    ///         Every entry fee is divided into three buckets BEFORE the BPS array runs:
    ///           50% -> crossingReserve  (pre-funds first crossing; held in member struct)
    ///            5% -> direct earnings  (immediately withdrawable by the new member)
    ///           45% -> payout base      (BPS array applied to this portion ONLY)
    ///         Crossing cost = full entryFee, funded from crossingReserve first then withdrawable.
    ///         Member only needs to accumulate entryFee x 50% = $5 in withdrawable per crossing
    ///         (the other 50% is always pre-funded by the reserve deposited at entry time),
    ///         reducing cycles to cross from ~6 to ~3 at every tier.
    uint256 internal constant CROSSING_RESERVE_BPS = 5_000;   // 50% pre-funded for crossing
    uint256 internal constant DIRECT_EARN_BPS      =   250;   // 2.5% instant earnings on entry (V8.32: halved from 5%)
    // payout base = BPS_DENOM - CROSSING_RESERVE_BPS - DIRECT_EARN_BPS = 4_500 (45%)

    /// @notice Fraction of each pool distribution share that is redirected to the SF
    ///         as gradual rescue-debt repayment.  5000 = 50%.
    ///         V8.31: raised from 15% -> 50%.  Faster debt clearing (6 cycles vs 18 at T1)
    ///         while the member still earns CNOVA throughout.  Passive members earn
    ///         CNOVA mining rewards; the USDC stream is the active-recruiter bonus,
    ///         so redirecting half of it during rescue repayment is transparent and fair.
    ///         Paired with the crossing-buffer in forceCrossKeeper so that:
    ///           buffer = entryFee - poolEarningsPerJourney x (1 - RESCUE_REPAY_BPS/BPS_DENOM)
    ///         guaranteeing the member arrives at MatA root position with exactly entryFee.
    // V8.32: RESCUE_REPAY_BPS removed as constant -- now read from StabilityFund (DAO param #50).

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

    /// @notice V8.48 item 37 — EVERY credit says WHERE IT CAME FROM.
    ///
    ///         Before this, `_credit` moved money and emitted NOTHING, so two of the four
    ///         earning paths were invisible to any consumer: the 2.5% direct earn on entry
    ///         and the L1 referral payment. Chain pay and pool share emitted, so the
    ///         dashboard could attribute exactly those two and no others — a member watched
    ///         their balance rise with no way to learn why. Worse, an ORPHANED L1 (no
    ///         referrer) emitted `OrphanFeeRouted`, so the FAILURE case was observable while
    ///         the success case was silent.
    ///
    ///         `ChainPayDistributed` and `PoolShareCredited` are DELIBERATELY KEPT: the
    ///         frontend and the VPS keepers read them today, and removing them in the same
    ///         release would break live tooling. Retire them only once the frontend has
    ///         migrated to this stream.
    event EarningsCredited(
        address indexed member,
        address indexed payer,
        uint8   indexed source,
        uint256 amount
    );

    uint8 internal constant SRC_DIRECT_ENTRY = 1;  // 2.5% carve on the member's own entry
    uint8 internal constant SRC_L1_REFERRAL  = 2;  // paid to the entrant's referrer
    uint8 internal constant SRC_CHAIN_PAY    = 3;  // up to 6 levels above the entrant
    uint8 internal constant SRC_POOL_SHARE   = 4;  // settled rotation pool
    uint8 internal constant SRC_ORPHAN_ACCT1 = 5;  // orphaned fee routed to accountOne
    event PoolDistributed(uint256 totalPool, uint256 cycleNumber);
    event PoolShareCredited(address indexed member, uint256 position, uint256 amount);
    event StabilityContribution(uint8 indexed tier, uint256 amount, uint8 layer);
    event SlotReclaimed(address indexed member, uint256 position, uint256 idleDuration);
    /// @notice V8.33: Emitted when keeper soft-parks an idle member (parks instead of hard-evict).
    event SlotParkedIdle(address indexed member, uint256 position, uint256 idleDuration);
    event WithdrawalFeeCharged(address indexed member, uint256 fee);
    event MemberParked(address indexed member, uint256 shortfall);
    /// @notice V8.46 (item C): handleCycleOut reverted and the member was parked
    ///         as a fallback instead of vanishing. If this ever fires, something
    ///         upstream is broken — check gas on the cascade and the TierRouter's
    ///         USDC balance/allowance. Silence here is the healthy state.
    event CycleOutFailed(address indexed member, uint8 tierIndex);
    event MemberEvicted(address indexed member, uint256 totalWithdrawn);
    /// @notice V8.48 item 47: a parked-queue record was cleared for a member who is
    ///         actually SEATED (a "ghost" — stale queue residue, measured 41 live on
    ///         2026-08-13). Dequeue only: no funds moved, no seat touched. Distinct
    ///         from MemberEvicted so the two are never conflated in any consumer.
    event GhostDequeued(address indexed member, uint256 staleParkedAt);
    /// @notice V8.48 item 47: an evicted member's crossing reserve was released to
    ///         their withdrawable (involuntary exit — no exitSeat penalty). Their SF
    ///         debt stays booked and repays off the top of the next withdrawal.
    event EvictionReserveReleased(address indexed member, uint256 amount);
    event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed);
    /// @notice Emitted when a member self-rescues by paying their own shortfall (no debt).
    event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed);
    /// @notice Emitted when a member's SF rescue loan is (partially) repaid at cycle-out.
    event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining);
    /// @notice Emitted when a rescue loan is issued (all rescue paths: keeper, coPayRescue).
    event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType);

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
        // V8.46 THE UNIVERSAL PAIR GUARD — added 2026-07-28 from measured data.
        //
        // A seat in EITHER half of a pair is a seat in that pair. Every guard in
        // V8.45 tested ONE matrix: _manualUpgrade:825, hybridUpgrade:854,
        // bulkUpgrade:986 and _executeAdditive:1185 all check tierMatrixAAddr,
        // while selfRescue:1108 and coPayRescue:1071 check only the matrix the
        // member is PARKED in — then seat them in the PARTNER, unchecked.
        //
        // dupe_watch.js recorded 67 duplicates forming over 18,700 blocks:
        //   coPayRescue 52 · selfRescue 7 · manualUpgrade 6 · performUpkeep 2
        // 57 of 67 formed in a tier BELOW the member's highest and ZERO above —
        // which is why the upgrade-path fix drafted on 2026-07-27 would not have
        // stopped a single one of the 59 rescue-driven cases.
        //
        // EVERY seating path ends here: register, enterFor, coupon entry,
        // crossings and rescues all reach _enterMatrix. Guarding the chokepoint
        // covers them at once instead of patching six call sites and hoping
        // there is no seventh — today alone turned up four nobody knew about.
        //
        // One require, reusing the existing string: MatrixKeeper:558 already
        // treats "F8V8: already in matrix" as expected-and-swallowable on the
        // parked-rescue path, so a co-pay that would create a duplicate is now
        // skipped cleanly by the keeper rather than surfacing as a surprise.
        require(
            !self.members[member].isInMatrix
            && (self.partner == address(0)
                || !IFigureEightMatrixV8Cross(self.partner).isActiveInMatrix(member)),
            "F8V8: already in matrix"
        );

        if (msg.sender == self.partner || self.chainAuthorized[msg.sender]) {
            cfg.usdc.safeTransferFrom(msg.sender, address(this), cfg.entryFee);
        }

        // V8.46: TAKING A SEAT CLEARS ANY PARK RECORD FOR THIS MATRIX.
        //
        // parkedAt was only ever cleared by _removeFromParkedQueue, which gives
        // up silently if the member is not found in the parkedMembers array — so
        // a re-seating path that misses that call leaves the timestamp behind
        // forever. Live 2026-07-28: Kira reads as SEATED in T3.1 MatA and PARKED
        // in T3.1 MatA at the same time, which is not a possible state.
        //
        // Members are not harmed (selfRescue checks !isInMatrix as well), but the
        // parked QUEUE still lists them, so the co-pay keeper spends attempts
        // rescuing people who are already sitting down and fails with
        // "still in matrix" — swallowed at MatrixKeeper:558, so it never even
        // shows up as an error. Wasted keeper work, invisible.
        //
        // Clearing it HERE, where the seat is actually taken, means no future
        // path can reintroduce the residue by forgetting to call the cleaner.
        if (self.parkedAt[member] > 0) {
            _removeFromParkedQueue(self, member);
            self.parkedAt[member] = 0;
        }

        // V8.48 item 45: ...AND THE PARTNER HALF'S RECORD TOO.
        //
        // The V8.46 clear above is matrix-LOCAL, and every MatB rescue destination
        // is the pair's MatA (item 10) — so a member parked in MatB and rescued
        // into MatA kept a live MatB queue slot forever. Measured 2026-08-13
        // (diag_ghost_parked.js): 41 ghosts, 39 of them exactly this shape; every
        // copay run burned attempts on them, reverting "already in matrix".
        //
        // try/catch, deliberately: a failing partner call must never cost a member
        // their seat — on failure the residue simply remains (the pre-fix state)
        // and item 47's valve dequeues it later. This is residue cleanup, not a
        // safety invariant; the seat itself must not depend on it.
        if (self.partner != address(0)) {
            try IFigureEightMatrixV8Cross(self.partner).clearParkRecord(member) {} catch {}
        }

        self.joinCountSinceRotation += 1;
        self.lastActivityTime[member] = block.timestamp;

        if (!self.members[member].hasEverJoined) {
            self.totalJoined += 1;
            // V8.36 Bug Fix #2: Accept cross-pair referrers.
            // Old check only accepted referrers who had joined THIS specific matrix pair.
            // This caused factory-created pairs (T1.2+) to always store l1 = address(0)
            // for members whose referrers were only in the original pair (T1.1), sending
            // the L1 commission to accountOne (W1) instead of the actual referrer.
            // New check: also accept referrers who are globally joined in TierRouter.
            // withdraw() checks withdrawable > 0, not hasEverJoined, so the cross-pair
            // referrer can claim earned L1 credits from this matrix at any time.
            address l1;
            if (referrer != address(0)) {
                if (self.members[referrer].hasEverJoined) {
                    l1 = referrer;
                } else if (self.tierRouter != address(0)) {
                    try ITierRouter(self.tierRouter).globalJoined(referrer) returns (bool joined) {
                        if (joined) l1 = referrer;
                    } catch {}
                }
            }

            // V8.46 ITEM 8 — UPDATE THE EXISTING RECORD, NEVER REPLACE IT.
            //
            // This used to be `self.members[member] = Member({... 0, 0, 0 ...})`,
            // on the assumption that `!hasEverJoined` means "no record exists yet".
            // IT DOES NOT. It means "never took a seat in THIS matrix". Two paths
            // write real values to a member's record without ever setting the flag:
            //
            //   1. _credit (:928) adds to `withdrawable` and `totalEarned`.
            //      Referral commission is credited into the matrix where the
            //      member's DOWNLINE entered, so every upline accrues a genuine
            //      claim in tiers they have never occupied.
            //   2. withdrawCore (:948) gates on `require(available > 0)`, never on
            //      membership, so such a holder can withdraw — which increments
            //      `totalWithdrawn` while `hasEverJoined` is still false.
            //
            // Constructing a fresh struct here therefore DELETED live balances,
            // earnings, withdrawal history and crossing reserve the moment a
            // commission-only holder finally entered that tier. The USDC stayed in
            // the matrix as unattributed surplus with no claim against it.
            //
            // MEASURED 2026-07-29 on 0xe8Ad7bbA: withdrew $52.50 gross from T3.1
            // MatA at block 44796516 (~21:40 UTC) as a commission-only holder;
            // entered that matrix at 23:30:02 UTC; `totalWithdrawn` read $0.00
            // afterwards. Sixteen payouts totalled $2,000.00 gross but the ledgers
            // summed to $1,947.50. The owner lost only the RECORD because he had
            // already withdrawn — had he entered first, the money itself was gone.
            //
            // Fields are written individually and the value-bearing ones are left
            // alone. They are already 0 for a genuinely new member (mapping
            // default), so nothing is lost in the normal case.
            Member storage rec = self.members[member];
            rec.id            = self.totalJoined;
            // Never overwrite a referrer that is already set; a commission-only
            // holder has address(0) here because the struct was never built, so
            // the cross-pair resolution above still applies on first real entry.
            if (rec.referrer == address(0)) rec.referrer = l1;
            rec.joinedAt      = block.timestamp;
            rec.hasEverJoined = true;
            // The seat itself is taken further down this function; never inherit a
            // stale true from an earlier path.
            rec.isInMatrix    = false;
            // DELIBERATELY UNTOUCHED: withdrawable, totalEarned, totalWithdrawn,
            // cyclesCompleted, crossingReserve.
        }

        // V8.45 CRITICAL FIX (live incident 2026-07-26, T1.0 MatB wedged):
        // NEVER trust a cached nextSlot across a _cycleOutRoot call, and NEVER write
        // outside 1..matrixSize.
        //
        // What went wrong in V8.44: entering a FULL matrix calls _cycleOutRoot, which
        // calls handleCycleOut -> TierRouter._executeAdditive -> _takeSeat, which can
        // seat a member back into THIS SAME matrix (own-pair re-entry, or a partner
        // MatA cycle-out crossing back in). That nested entry consumed the freed slot
        // and advanced nextSlot; control then returned here and placed the outer member
        // at the stale slot — overwriting the nested occupant, or writing to position
        // 128 (out of range). Each occurrence orphaned one member and inflated
        // occupancy by 1. After ~217 rotations: 44 holes, position 1 empty, and every
        // subsequent entry reverted "F8V8: no root" — the matrix was permanently wedged.
        //
        // Fix: resolve the slot AFTER the rotation, from live storage, and park the
        // member (fee still distributed, rescue path available) if the cascade refilled
        // the matrix rather than corrupting the BFS array.
        bool placed = false;
        if (self.occupancy < cfg.matrixSize) {
            uint256 slot = _lowestFreeSlot(self, cfg.matrixSize);
            if (slot != 0) {
                _placeInMatrix(self, member, slot);
                self.nextSlot  = slot + 1;
                self.occupancy += 1;
                placed = true;
            }
        }
        if (!placed) {
            if (self.occupancy >= cfg.matrixSize) _cycleOutRoot(self, cfg);
            uint256 slot2 = _lowestFreeSlot(self, cfg.matrixSize);
            if (slot2 != 0) {
                _placeInMatrix(self, member, slot2);
                self.nextSlot  = slot2 + 1;
                self.occupancy += 1;
                placed = true;
            } else {
                // Cascade refilled every seat. Park instead of corrupting the array —
                // the member keeps their funds and the standard rescue path applies.
                self.parkedMembers.push(member);
                self.parkedAt[member] = block.timestamp;
                emit MemberParked(member, 0);
            }
        }

        // V8.48 item 4: the reserve deposit this seat just made prices its own
        // mint cap — pass the EXACT amount deposited, never a reconstruction.
        uint256 _reserveDeposit = _distributePayments(self, cfg, member);

        try cfg.cnova.mintReward(member, cfg.tierIndex, _reserveDeposit) {} catch {}

        emit MemberEntered(member, self.matrixPos[member], self.members[member].id, address(this));

        if (!cfg.isMatrixA && self.tierRouter != address(0)) {
            try ITierRouter(self.tierRouter).onCrossToMatB(member, cfg.tierIndex) {} catch {}
        }
    }

    /// @notice V8.45: lowest genuinely-empty BFS position, read from LIVE storage.
    ///         Returns 0 when every seat 1..size is taken. Checks the nextSlot hint
    ///         first (the common path, one SLOAD) before the bounded scan, so the
    ///         extra safety costs almost nothing in the normal case.
    function _lowestFreeSlot(MatrixState storage self, uint256 size)
        internal view returns (uint256)
    {
        uint256 hint = self.nextSlot;
        if (hint >= 1 && hint <= size && self.posToMember[hint] == address(0)) return hint;
        for (uint256 i = 1; i <= size; i++) {
            if (self.posToMember[i] == address(0)) return i;
        }
        return 0;
    }

    function _placeInMatrix(MatrixState storage self, address member, uint256 slot) internal {
        self.matrixPos[member]          = slot;
        self.posToMember[slot]          = member;
        self.members[member].isInMatrix = true;
        // V8.44 (item D): pool checkpoint — k encodes seat + rotation epoch.
        self.poolK[member]      = slot + self.rotationCount + 1;
        self.poolA1Snap[member] = self.poolA1;
        self.poolArSnap[member] = self.poolAr;
    }

    /// @notice V8.44 (item D): settle a member's accrued pool share into
    ///         withdrawable and re-snapshot. Called on every seat event (join
    ///         is a fresh checkpoint; cycle-out, park, idle-reclaim settle
    ///         before removal) and before withdrawals. Rescue-debt repayment
    ///         (formerly deducted inside the rotation loop) applies here.
    function _settlePool(MatrixState storage self, ImmutableConfig memory cfg, address member) internal {
        uint256 k = self.poolK[member];
        if (k == 0) return;                       // no active checkpoint
        uint256 dA1 = self.poolA1 - self.poolA1Snap[member];
        uint256 dAr = self.poolAr - self.poolArSnap[member];
        self.poolA1Snap[member] = self.poolA1;
        self.poolArSnap[member] = self.poolAr;
        if (dA1 == 0) return;                     // no rotations since checkpoint

        uint256 W = cfg.matrixSize * (cfg.matrixSize + 1) / 2 - 1;
        // Exact rational numerator; k − t ≥ 1 for every accumulated event
        // (a member reaching seat 1 is settled+removed at that same event,
        // BEFORE the event's pool is added to the accumulators).
        uint256 share = (k * dA1 - dAr) / W;
        if (share == 0) return;

        // -- V8.47: member-level rescue-debt repayment ------------------------
        // Repay against the member's SINGLE cross-tier debt held in the SF, at the
        // banded clawback rate, out of this pool share. Because the debt is now a
        // member-level balance (not this matrix's silo), ANY matrix at ANY tier the
        // member earns in services the one debt — a loan issued in a matrix they
        // later moved on from no longer strands.
        if (self.stabilityFund != address(0)) {
            uint256 owed = IStabilityFund(self.stabilityFund).memberDebtOf(member);
            if (owed > 0) {
                uint256 repay = share * IStabilityFund(self.stabilityFund).clawbackBpsFor(member) / BPS_DENOM;
                if (repay > owed) repay = owed;
                if (repay > 0) {
                    share -= repay;
                    SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, repay);
                    try IStabilityFund(self.stabilityFund).receiveDebtRepayment(member, repay) {}
                    catch {}
                    emit RescueDebtRepaid(member, repay, owed - repay);
                }
            }
        }
        if (share > 0) {
            _credit(self, member, share, SRC_POOL_SHARE, address(0));
            emit PoolShareCredited(member, self.matrixPos[member], share);
        }
    }

    /// @notice V8.44 (item D): view of a member's un-settled pool accrual
    ///         (net of the rescue-debt redirect estimate).
    /// @notice V8.48 item 1 — the claimable balance, mirroring withdrawCore's deduction
    ///         order exactly. Lives HERE rather than in FigureEightMatrixV8 because
    ///         MatrixPairFactory EMBEDS the matrix creation bytecode: +286 bytes on the
    ///         matrix cost the factory 248 and left it with 108 bytes of EIP-170 headroom.
    ///         A library is LINKED, so this costs the factory nothing.
    ///
    ///         Order (must match withdrawCore):
    ///           settle-equivalent -> debt off the top -> crossing lock (ONLY when
    ///           automation is active) -> automation reserve.
    function claimableOf(MatrixState storage self, ImmutableConfig memory cfg, address member)
        external view returns (uint256)
    {
        (uint256 bal, ) = _claimableAndHeld(self, cfg, member);
        return bal;
    }

    /// @notice V8.48 item 2 (owner decision 2026-08-12: keep high-tier-only semantics,
    ///         add the getter) — what the crossing lock + automation reserve ACTUALLY
    ///         withhold from `member` in THIS matrix right now. The on-chain version of
    ///         the frontend's `_claimableAll.heldNow` reconstruction, so UIs stop
    ///         rebuilding it client-side. Zero outside the member's highest tier and
    ///         zero when automation is off, because those are exactly the places
    ///         withdrawCore enforces nothing. The DEBT portion of a balance is
    ///         deliberately NOT counted: withdrawCore repays SF debt BEFORE the holds
    ///         apply, so that money is held toward repayment, not toward the reserve
    ///         target. Shares one internal with claimableOf — the item-1 discipline:
    ///         a view that describes an enforcement must be computed BY that
    ///         enforcement's arithmetic, never alongside it.
    function reservedHeldOf(MatrixState storage self, ImmutableConfig memory cfg, address member)
        external view returns (uint256)
    {
        (, uint256 held) = _claimableAndHeld(self, cfg, member);
        return held;
    }

    /// @dev The single source claimableOf and reservedHeldOf both read. `bal` is what
    ///      withdrawCore would pay (pre-fee); `held` is what the crossing lock +
    ///      automation reserve withhold. Invariant, asserted in
    ///      V8_48_ReservedHeld.test.js: after a FULL withdrawal, the member's remaining
    ///      stored withdrawable equals `held` as read beforehand — the two outputs
    ///      partition the post-debt balance.
    function _claimableAndHeld(MatrixState storage self, ImmutableConfig memory cfg, address member)
        internal view returns (uint256 bal, uint256 held)
    {
        // GROSS pool, not pendingPoolOf. withdrawCore applies the clawback inside
        // _settlePool and then repays the REMAINING debt from the full balance, so the
        // net effect is the whole debt deducted ONCE from the gross. Using the netted
        // figure here and then subtracting the full debt would take the clawback twice.
        bal = self.members[member].withdrawable + _poolShareGross(self, cfg, member);
        if (bal == 0) return (0, 0);

        if (self.stabilityFund != address(0)) {
            uint256 debt = IStabilityFund(self.stabilityFund).memberDebtOf(member);
            if (debt >= bal) return (0, 0);
            bal -= debt;
        }

        uint256 automationReserve = 0;
        if (self.tierRouter != address(0)) {
            uint8 highest = ITierRouter(self.tierRouter).memberHighestTier(member);
            if (highest > 0 && (highest - 1) == cfg.tierIndex) {
                automationReserve = ITierRouter(self.tierRouter).reservedFor(member);
            }
        }

        if (self.members[member].isInMatrix && automationReserve > 0) {
            uint256 crossNeeded = cfg.entryFee > self.members[member].crossingReserve
                ? cfg.entryFee - self.members[member].crossingReserve
                : 0;
            if (crossNeeded > 0) {
                // withdrawCore: require(available > crossNeeded). At or below it,
                // NOTHING is payable and the whole post-debt balance is held.
                if (bal <= crossNeeded) return (0, bal);
                bal -= crossNeeded;
                held = crossNeeded;
            }
        }

        if (automationReserve > 0) {
            // withdrawCore: require(automationReserve < available). At or below it,
            // the crossing hold plus everything remaining is held.
            if (automationReserve >= bal) return (0, held + bal);
            bal -= automationReserve;
            held += automationReserve;
        }
    }

    /// @dev Accrued pool share BEFORE the debt clawback estimate. Split out for V8.48
    ///      item 1: claimableOf needs the GROSS figure, because withdrawCore applies the
    ///      clawback during _settlePool and then repays the REMAINING debt from the whole
    ///      balance — a full-debt deduction on top of an already-netted pool would remove
    ///      the clawback portion twice.
    function _poolShareGross(MatrixState storage self, ImmutableConfig memory cfg, address member)
        internal view returns (uint256)
    {
        uint256 k = self.poolK[member];
        if (k == 0) return 0;
        uint256 dA1 = self.poolA1 - self.poolA1Snap[member];
        if (dA1 == 0) return 0;
        uint256 dAr = self.poolAr - self.poolArSnap[member];
        uint256 W = cfg.matrixSize * (cfg.matrixSize + 1) / 2 - 1;
        return (k * dA1 - dAr) / W;
    }

    function pendingPoolOf(MatrixState storage self, ImmutableConfig memory cfg, address member)
        external view returns (uint256)
    {
        uint256 share = _poolShareGross(self, cfg, member);
        if (share == 0) return 0;
        // V8.47: net of the member-level redirect estimate (banded clawback).
        if (self.stabilityFund != address(0)) {
            uint256 owed = IStabilityFund(self.stabilityFund).memberDebtOf(member);
            if (owed > 0) {
                uint256 repay = share * IStabilityFund(self.stabilityFund).clawbackBpsFor(member) / BPS_DENOM;
                if (repay > owed) repay = owed;
                share -= repay;
            }
        }
        return share;
    }

    // ===========================================================================
    // Cycling / pool distribution / crossing
    // ===========================================================================

    function _cycleOutRoot(MatrixState storage self, ImmutableConfig memory cfg) internal {
        // V8.45 SELF-HEAL: cycle out the LOWEST OCCUPIED position, not blindly
        // position 1. A matrix that somehow acquires a gap at position 1 (the
        // V8.44 incident, or any future accounting drift) used to revert
        // "F8V8: no root" on every single entry and was permanently wedged —
        // no rescues, no registrations, no admin path back. Scanning forward
        // makes that state recoverable instead of terminal.
        uint256 rootPos = 1;
        while (rootPos <= cfg.matrixSize && self.posToMember[rootPos] == address(0)) {
            rootPos++;
        }
        require(rootPos <= cfg.matrixSize, "F8V8: no root");
        address root = self.posToMember[rootPos];

        // V8.44 (item D): settle the departing root's accrued pool share up to
        // the PREVIOUS event (the root receives nothing from this rotation —
        // identical to the V8.43 loop, which paid seats 2..N only), THEN fold
        // this rotation's pool into the accumulators for everyone else.
        _settlePool(self, cfg, root);
        self.poolK[root] = 0;
        if (self.poolAccumulator > 0) {
            uint256 pool = self.poolAccumulator;
            self.poolAccumulator = 0;
            self.poolA1 += pool;
            self.poolAr += (self.rotationCount + 1) * pool;
            emit PoolDistributed(pool, self.rotationCount + 1);
        }

        self.matrixPos[root]               = 0;
        self.posToMember[rootPos]          = address(0);   // V8.45: clear the ACTUAL root seat
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
            // -- V8.47: member-level rescue-debt repayment at MatB cycle-out --------
            // Primary repayment moment: the member just received their full pool
            // distribution. Clear as much of their SINGLE cross-tier SF debt as their
            // withdrawable covers before handing the net to TierRouter for upgrade/exit.
            // Soft -- never blocks the cycle-out, just reduces what carries forward.
            uint256 cycleOutDebt = self.stabilityFund != address(0)
                ? IStabilityFund(self.stabilityFund).memberDebtOf(root)
                : 0;
            if (cycleOutDebt > 0) {
                uint256 bal = self.members[root].withdrawable;
                if (bal > 0) {
                    uint256 repay = bal >= cycleOutDebt ? cycleOutDebt : bal;
                    self.members[root].withdrawable -= repay;
                    SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, repay);
                    // V8.39: try/catch — SF failure must not block cycle-out
                    try IStabilityFund(self.stabilityFund).receiveDebtRepayment(root, repay) {}
                    catch {}
                    emit RescueDebtRepaid(root, repay, cycleOutDebt - repay);
                }
            }
            // V8.44 (item A): escrow = the member's crossing reserve. V8.43
            // hardcoded 0 here, so the additive engine's budget excluded the
            // 50% reserve pre-funded at the member's MatB entry — passive
            // members (withdrawable < fee) silently graduated against their
            // configured intent and the reserve was stranded forever.
            // V8.46 (item C): the catch below used to be EMPTY. The root has
            // ALREADY been removed from the seat map by this point, so a revert
            // inside handleCycleOut — deep-cascade out of gas, TierRouter short
            // of USDC or allowance for registerFor, any nested failure — left
            // the member in NO matrix, NOT parked, with NO event emitted. They
            // silently vanished, which is the exact "graduated against their
            // configured intent" failure V8.44 was built to eliminate (see the
            // comment above). Confirmed live 2026-07-27: 5 wallets, 8 events,
            // $267.50 of crossing reserve left behind — W1 lost its T1, T2 and
            // T3 seats this way while its options were correct throughout.
            //
            // PARK-NOT-EXIT MUST HOLD ON EVERY PATH, INCLUDING FAILURE.
            try ITierRouter(self.tierRouter).handleCycleOut(
                root,
                cfg.tierIndex,
                self.members[root].crossingReserve,
                self.members[root].withdrawable
            ) {} catch {
                self.parkedMembers.push(root);
                self.parkedAt[root] = block.timestamp;
                emit MemberParked(root, 0);
                emit CycleOutFailed(root, cfg.tierIndex);
            }
        } else {
            // V8.46 CONTAINMENT — the pair must never stop.
            //
            // This called _crossToPartner directly, outside any try/catch. If the
            // root already held a seat in the partner, _enterMatrix reverted
            // "already in matrix" and that revert propagated OUT of the rotation
            // and killed whatever transaction triggered it — a stranger's
            // register() or upgrade. T3.1 and T4.1 were both stopped dead this
            // way on 2026-07-28 and had to be repaired live.
            //
            // A pre-check, not a try/catch: _crossToPartner is an internal
            // library call and Solidity cannot catch those, and checking first is
            // cheaper than reverting anyway. The member is PARKED instead —
            // park-not-exit holds, they keep their funds, and once their partner
            // seat cycles out the normal rescue machinery seats them again.
            //
            // The V8.46 guard in _requireNotSeated should make this unreachable.
            // It stays regardless: prevention stops NEW duplicates, and this is
            // what protects the pair from the ones already out there and from
            // any cause nobody has found yet.
            address dest = self.partner;
            if (dest != address(0) && IFigureEightMatrixV8Cross(dest).isActiveInMatrix(root)) {
                self.parkedMembers.push(root);
                self.parkedAt[root] = block.timestamp;
                emit MemberParked(root, 0);
                emit CycleOutFailed(root, cfg.tierIndex);
            } else {
                _crossToPartner(self, cfg, root);
            }
        }
    }

    // V8.44 (item D): the per-rotation 126-member credit loop is GONE —
    // replaced by the poolA1/poolAr accumulators (folded in _cycleOutRoot) and
    // lazy _settlePool at each member's own seat events. Full-cascade
    // registration gas drops accordingly (MAINNET_TODO gas finding fixed at
    // the root). Rounding note: the old loop floored each member's share per
    // rotation and swept the remainder ("dust") to seat 2; the pull model
    // floors ONCE per settle (strictly less rounding loss per member) and
    // leaves the microscopic global remainder (≤ a few wei per rotation) in
    // the contract instead of gifting it to seat 2.

    function _crossToPartner(MatrixState storage self, ImmutableConfig memory cfg, address member) internal {
        require(self.partner != address(0), "F8V8: no partner");

        if (self.crossingInProgress) {
            // V8.44 FIX: PARK instead of the pendingCross deferral. pendingCross
            // was written here and NEVER processed anywhere — a member deferred
            // mid-cascade sat in limbo (out of matrix, not parked, funds
            // unreachable): the same stranded class as the cycle-out bug.
            // Parking hands them to the standard machinery (auto-rescue keeper
            // + selfRescue) and naturally bounds cascade recursion depth.
            self.parkedMembers.push(member);
            self.parkedAt[member] = block.timestamp;
            emit MemberParked(member, 0);
            return;
        }

        address destination;
        if (!cfg.isMatrixA && self.chainNext != address(0)) {
            destination = self.chainNext;
        } else {
            destination = self.partner;
        }

        uint256 reentryFee = IFigureEightMatrixV8Cross(destination).ENTRY_FEE();

        // V8.31: 50/5/45 crossing logic.
        // Draw from crossingReserve first; any remaining shortfall comes from withdrawable.
        // Member only needs to accumulate 50% of the fee in withdrawable (the other 50%
        // is always pre-funded by the reserve deposited at entry time).
        Member storage memberData = self.members[member];
        uint256 fromReserve = memberData.crossingReserve >= reentryFee
            ? reentryFee
            : memberData.crossingReserve;
        uint256 fromWithdrawable = reentryFee - fromReserve;

        if (memberData.withdrawable < fromWithdrawable) {
            uint256 shortfall = fromWithdrawable - memberData.withdrawable;
            self.parkedMembers.push(member);
            self.parkedAt[member] = block.timestamp;
            emit MemberParked(member, shortfall);
            return;
        }

        memberData.crossingReserve -= fromReserve;
        memberData.withdrawable    -= fromWithdrawable;

        emit CrossingFunded(member, fromReserve, fromWithdrawable, reentryFee);

        SafeERC20.forceApprove(cfg.usdc, destination, reentryFee);

        self.crossingInProgress = true;
        emit MemberCrossedToPartner(member, address(this), destination);
        IFigureEightMatrixV8Cross(destination)._enterMatrix(member, self.members[member].referrer);
        self.crossingInProgress = false;

        // -- SF rescue loan repayment -------------------------------------------
        // After paying the crossing fee, any remaining withdrawable is used to
        // repay outstanding rescue debt to the SF (partial repayment is fine).
        // This does NOT block or re-park the member -- it's a soft recovery.
        // V8.47: repay against the member-level SF ledger.
        uint256 debt = self.stabilityFund != address(0)
            ? IStabilityFund(self.stabilityFund).memberDebtOf(member)
            : 0;
        if (debt > 0) {
            uint256 remaining = self.members[member].withdrawable;
            if (remaining > 0) {
                uint256 repay = remaining >= debt ? debt : remaining;
                self.members[member].withdrawable -= repay;
                SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, repay);
                // V8.39: try/catch — SF failure must never block the crossing.
                try IStabilityFund(self.stabilityFund).receiveDebtRepayment(member, repay) {}
                catch {}
                emit RescueDebtRepaid(member, repay, debt - repay);
            }
        }
    }

    /// @dev Shared tail for forceCross/forceCrossKeeper/coPayRescue.
    function finalizeCrossing(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        _finalizeCrossing(self, cfg, member);
    }

    function _finalizeCrossing(MatrixState storage self, ImmutableConfig memory cfg, address member) internal {
        // V8.44 overflow rework: a pair's OWN members always return to their
        // OWN pair — never forward to the next pair (the V8.43 diversion that
        // starved factory-spawned MatBs: live proof was MatA rot 254-291 with
        // MatB rot 0 on pairs 2-5).
        //   - From MatA: destination is the partner (own MatB). If it's full,
        //     the entry itself rotates the root out — cycle-then-place — which
        //     is exactly the churn a full MatB needs (design law: rotation is
        //     the natural consequence of the next entry, no keeper required).
        //   - From MatB (cycled-out-parked / idle-parked members): re-enter the
        //     own pair via PairManager.rescueReentry (own MatA below
        //     saturation, own MatB at saturation). chainNext is only a legacy
        //     fallback for deployments without a PairManager.
        if (!cfg.isMatrixA && self.pairManager != address(0)) {
            uint256 pIdx = IMatrixPairIndexView(address(this)).pairIndex();
            SafeERC20.forceApprove(cfg.usdc, self.pairManager, cfg.entryFee);
            emit MemberCrossedToPartner(member, address(this), self.pairManager);
            IPairManagerOverflow(self.pairManager).rescueReentry(
                member, self.members[member].referrer, pIdx
            );
            return;
        }
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

    /// @dev V8.48 item 4: returns the treasury-reserve deposit this entry made, so
    ///      the caller can pass it to mintReward as the mint's backing value.
    function _distributePayments(MatrixState storage self, ImmutableConfig memory cfg, address newMember) internal returns (uint256) {
        Member storage m = self.members[newMember];

        // V8.32: 50/2.5/47.5 pre-split.  Before the BPS array runs, carve the entry fee into:
        //   50%   -> crossingReserve  (stays in contract; funds member's next crossing)
        //    2.5% -> direct earnings  (immediately withdrawable by the new member)
        //   47.5% -> payBase = entryFee (BPS splits are expressed as BPS-of-entryFee, sum to 4750)
        //
        // V8.32 change: payBase is now the full entryFee; all SplitConfig BPS values
        // are expressed as fractions of entryFee (not of the 45% sub-pool).
        // Sum check: 5000 (cross) + 250 (instant) + 4750 (splits) = 10000
        m.crossingReserve += cfg.entryFee * CROSSING_RESERVE_BPS / BPS_DENOM;
        _credit(self, newMember, cfg.entryFee * DIRECT_EARN_BPS / BPS_DENOM, SRC_DIRECT_ENTRY, newMember);
        uint256 payBase = cfg.entryFee;

        // All BPS splits below apply to payBase (= entryFee in V8.32); values sum to 4750 BPS of entryFee.
        uint256 l1Amt = payBase * cfg.splitL1Bps / BPS_DENOM;
        if (m.referrer != address(0)) {
            _credit(self, m.referrer, l1Amt, SRC_L1_REFERRAL, newMember);
        } else {
            _routeOrphanFee(self, cfg, l1Amt, "L1");
        }

        _distributeChainPay(self, cfg, newMember, payBase);

        uint256 treasuryAmt = payBase * cfg.splitTreasuryBps / BPS_DENOM;
        SafeERC20.forceApprove(cfg.usdc, address(cfg.treasury), treasuryAmt);
        cfg.treasury.depositReserve(treasuryAmt);

        // V8.48 item 4: `treasuryAmt` now lives to the end of the function (it is
        // the return value), which pushed this frame past the EVM's 16-slot stack
        // ("Stack too deep" at the community block). Each split below is therefore
        // SCOPED — its local dies at the closing brace. Same doctrine as item 12's
        // _triageParked extraction: remove locals, never enable viaIR for this.
        {
            uint256 poolAmt = payBase * cfg.splitPoolBps / BPS_DENOM;
            self.poolAccumulator += poolAmt;
        }

        {
            uint256 stabilityAmt = payBase * cfg.splitStabilityBps / BPS_DENOM;
            if (stabilityAmt > 0) {
                _forwardToStabilityFund(self, cfg, stabilityAmt, 1);
            }
        }

        {
            uint256 buybackAmt = payBase * cfg.splitBuybackBps / BPS_DENOM;
            if (buybackAmt > 0) {
                _forwardToBuybackReserve(self, cfg, buybackAmt);
            }
        }

        {
            uint256 liquidityAmt = payBase * cfg.splitLiquidityBps / BPS_DENOM;
            if (liquidityAmt > 0 && self.liquidityReserve != address(0)) {
                cfg.usdc.safeTransfer(self.liquidityReserve, liquidityAmt);
            } else if (liquidityAmt > 0 && cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, liquidityAmt);
            }
        }

        {
            uint256 devAmt = payBase * cfg.splitDevBps / BPS_DENOM;
            if (devAmt > 0 && cfg.devWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.devWallet, devAmt);
            }
        }

        {
            uint256 opsAmt = payBase * cfg.splitOpsBps / BPS_DENOM;
            if (opsAmt > 0 && cfg.opsWallet != address(0)) {
                cfg.usdc.safeTransfer(cfg.opsWallet, opsAmt);
            }
        }

        {
            uint256 communityAmt = payBase * cfg.splitCommunityBps / BPS_DENOM;
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

        return treasuryAmt;   // V8.48 item 4: this entry's reserve deposit
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
        _credit(self, self.accountOne, acct1Share, SRC_ORPHAN_ACCT1, address(0));

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
                _credit(self, self.accountOne, founderShare, SRC_ORPHAN_ACCT1, address(0));
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
            try IStabilityFund(self.stabilityFund).receiveLayer(cfg.tierIndex, amount, 1) {}
                catch { _credit(self, self.accountOne, amount, SRC_ORPHAN_ACCT1, address(0)); }
        } else {
            _credit(self, self.accountOne, amount, SRC_ORPHAN_ACCT1, address(0));
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

    // V8.31: payBase parameter added -- chain pay is a fraction of the 45% payout base,
    // not the full entry fee.
    function _distributeChainPay(MatrixState storage self, ImmutableConfig memory /* cfg */, address newMember, uint256 payBase) internal {
        uint256 myPos = self.matrixPos[newMember];
        if (myPos == 0) return;

        uint256 parentPos = myPos / 2;
        for (uint256 lvl = 0; lvl < 6 && parentPos >= 1; lvl++) {
            address ancestor = self.posToMember[parentPos];
            if (ancestor != address(0)) {
                uint256 amt = payBase * self.chainPayBps[lvl] / BPS_DENOM;
                _credit(self, ancestor, amt, SRC_CHAIN_PAY, newMember);
                emit ChainPayDistributed(ancestor, newMember, lvl + 1, amt);
            }
            parentPos = parentPos / 2;
        }
    }

    function _credit(
        MatrixState storage self,
        address recipient,
        uint256 amount,
        uint8   source,
        address payer
    ) internal {
        if (recipient == address(0) || amount == 0) return;
        self.members[recipient].withdrawable += amount;
        self.members[recipient].totalEarned  += amount;
        // V8.48 item 37: the credit and its provenance are emitted together, so a
        // breakdown can never disagree with a balance.
        emit EarningsCredited(recipient, payer, source, amount);
        // V8.33: Earning from chain pay, direct earn, or pool distributions resets the idle
        // timer.  Without this, passively-earning members (others filling slots below them)
        // are incorrectly flagged as idle and reclaimed -- they ARE active, new joins are
        // paying into their chain.  Root cause of the V8.32 reclaim flood.
        self.lastActivityTime[recipient] = block.timestamp;
    }

    // ===========================================================================
    // Withdraw (deduped engine: same require order/messages on every call path
    // as the original four separate functions -- see FigureEightMatrixV8.sol's
    // thin wrappers for the four external entry points).
    // ===========================================================================

    // V8.44 (G2): member parameter made explicit (was msg.sender) so the
    // TierRouter bulkWithdraw sweep can withdraw on a member's behalf TO that
    // member. Wrapper entry points pass msg.sender — semantics unchanged.
    function withdrawCore(
        MatrixState storage self,
        ImmutableConfig memory cfg,
        address member,
        address recipient,
        uint256 amount,
        bool isFullWithdraw
    ) external {
        // V8.44 (item D): settle any accrued pool share first so withdrawals
        // always see the up-to-date balance.
        _settlePool(self, cfg, member);
        uint256 available = self.members[member].withdrawable;
        require(available > 0, "F8V8: nothing to withdraw");

        // V8.47: repay the member's SINGLE cross-tier rescue debt from the withdrawable
        // balance on the way out. With the member-level ledger this covers the old
        // "stranded in a left-behind matrix" case AND any other outstanding debt — this
        // withdrawal clears up to `available` of it. Decrements the STORED withdrawable
        // too so the repaid amount can't be withdrawn twice; try/catch keeps an SF
        // failure from ever blocking the payout.
        {
            uint256 debt = self.stabilityFund != address(0)
                ? IStabilityFund(self.stabilityFund).memberDebtOf(member)
                : 0;
            if (debt > 0) {
                uint256 repay = available >= debt ? debt : available;
                if (repay > 0) {
                    self.members[member].withdrawable -= repay;
                    available                         -= repay;
                    SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, repay);
                    try IStabilityFund(self.stabilityFund).receiveDebtRepayment(member, repay) {}
                    catch {}
                    emit RescueDebtRepaid(member, repay, debt - repay);
                }
            }
        }

        // V8.32 Task #63: hoist automationReserve early so crossNeeded check can be
        // skipped when all automation is disabled (reservedFor == 0 means member opted out).
        uint256 automationReserve = 0;
        if (self.tierRouter != address(0)) {
            uint8 highest = ITierRouter(self.tierRouter).memberHighestTier(member);
            if (highest > 0 && (highest - 1) == cfg.tierIndex) {
                automationReserve = ITierRouter(self.tierRouter).reservedFor(member);
            }
        }

        if (self.members[member].isInMatrix && automationReserve > 0) {
            // V8.32: only enforce crossing reserve when automation is active.
            // If all automation is disabled (automationReserve == 0), member may
            // withdraw freely -- they have explicitly opted out of auto-reentry.
            uint256 crossNeeded = cfg.entryFee > self.members[member].crossingReserve
                ? cfg.entryFee - self.members[member].crossingReserve
                : 0;
            if (crossNeeded > 0) {
                require(available > crossNeeded, "F8V8: must keep crossing reserve while active");
                available = available - crossNeeded;
            }
        }

        if (automationReserve > 0) {
            require(automationReserve < available, "F8V8: balance fully reserved for automation");
            available -= automationReserve;
        }

        uint256 amt = isFullWithdraw ? available : amount;
        if (!isFullWithdraw) {
            require(amt <= available, "F8V8: amount exceeds withdrawable");
        }

        self.members[member].withdrawable   -= amt;
        self.members[member].totalWithdrawn += amt;
        self.lastActivityTime[member] = block.timestamp;

        uint256 fee    = amt * self.withdrawalFeeBps / BPS_DENOM;
        uint256 payout = amt - fee;

        if (fee > 0) {
            _forwardToStabilityFund(self, cfg, fee, 3);
            emit WithdrawalFeeCharged(member, fee);
        }

        cfg.usdc.safeTransfer(recipient, payout);
        emit EarningsWithdrawn(member, payout);
    }

    // ===========================================================================
    // Parked queue: rescue / eviction
    // ===========================================================================

    function reclaimIdleSlot(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        require(self.members[member].isInMatrix, "F8V8: not in matrix");
        require(self.lastActivityTime[member] > 0, "F8V8: no activity record");

        uint256 pos      = self.matrixPos[member];
        uint256 idleTime = block.timestamp - self.lastActivityTime[member];

        // V8.44 (item D): settle accrued pool share before the seat is freed.
        _settlePool(self, cfg, member);
        self.poolK[member] = 0;

        // V8.33: Return crossing reserve to withdrawable before eviction.
        // Previously locked forever -- member left limbo unable to access their reserve.
        if (self.members[member].crossingReserve > 0) {
            self.members[member].withdrawable    += self.members[member].crossingReserve;
            self.members[member].crossingReserve  = 0;
        }

        self.posToMember[pos]           = address(0);
        self.matrixPos[member]          = 0;
        self.members[member].isInMatrix = false;
        self.occupancy                 -= 1;

        emit SlotReclaimed(member, pos, idleTime);
    }

    /// @notice V8.33: Keeper calls this for timeout-triggered idle members instead of
    ///         reclaimIdleSlot.  Unlike reclaimIdleSlot (hard eviction, member lands in
    ///         limbo), this adds the member to the parked queue so the rescue mechanism
    ///         re-enters them automatically.  Crossing reserve is returned to withdrawable
    ///         so it's accessible while parked.  The slot opens immediately for new members.
    function softParkIdle(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        require(self.members[member].isInMatrix, "F8V8: not in matrix");
        uint256 pos      = self.matrixPos[member];
        uint256 idleTime = block.timestamp - self.lastActivityTime[member];

        // V8.44 (item D): settle accrued pool share before the seat is freed.
        _settlePool(self, cfg, member);
        self.poolK[member] = 0;

        // Return crossing reserve so member keeps full access to their balance while parked
        if (self.members[member].crossingReserve > 0) {
            self.members[member].withdrawable    += self.members[member].crossingReserve;
            self.members[member].crossingReserve  = 0;
        }

        self.posToMember[pos]           = address(0);
        self.matrixPos[member]          = 0;
        self.members[member].isInMatrix = false;
        self.occupancy                 -= 1;

        // Add to parked queue -- keeper rescue path (forceCrossKeeper) will re-enter them
        self.parkedAt[member]      = block.timestamp;
        self.parkedMembers.push(member);

        emit SlotParkedIdle(member, pos, idleTime);
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
        uint256 sfContribution,
        uint256 crossingBuffer
    ) external {
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.partner != address(0),           "F8V8: no partner");
        require(sfContribution <= cfg.entryFee,       "F8V8: sfContribution exceeds fee");

        // V8.31: crossing is funded from crossingReserve first, then withdrawable, then SF.
        uint256 reserveContrib = self.members[member].crossingReserve;
        uint256 memberShare = cfg.entryFee > (sfContribution + reserveContrib)
            ? cfg.entryFee - sfContribution - reserveContrib
            : 0;
        if (memberShare > 0) {
            require(
                self.members[member].withdrawable >= memberShare,
                "F8V8: insufficient withdrawable for rescue"
            );
            self.members[member].withdrawable -= memberShare;
        }
        self.members[member].crossingReserve = 0;  // consume reserve toward crossing

        // -- Crossing buffer ----------------------------------------------------
        // The SF pre-transferred (sfContribution + crossingBuffer) to this contract.
        // sfContribution covered the entry-fee shortfall (already handled above).
        // crossingBuffer is extra USDC seeded into the member's withdrawable so they
        // will accumulate exactly entryFee by the time they reach MatA root position
        // (their ~50%-repaid pool earnings + this buffer = reentryFee at crossing).
        if (crossingBuffer > 0) {
            self.members[member].withdrawable += crossingBuffer;
        }

        _removeFromParkedQueue(self, member);

        // V8.47: record the TOTAL SF advance (entry shortfall + crossing buffer) on the
        // MEMBER-LEVEL ledger held by the SF (the creditor). This replaces the V8.28
        // per-matrix write to the DESTINATION matrix: because the debt is now one balance
        // per member (not a matrix silo), it services from ANY tier the member earns in
        // and can never be stranded on a matrix they move on from. The addRescueDebt
        // cross-call is retired.
        uint256 totalLoan = sfContribution + crossingBuffer;
        if (totalLoan > 0) {
            emit RescueLoanIssued(member, totalLoan, "forceCrossKeeper");
            IStabilityFund(self.stabilityFund).increaseMemberDebt(member, cfg.tierIndex, totalLoan);
        }

        // Contract now holds full ENTRY_FEE: sfContribution (from SF) + memberShare (from withdrawable)
        // crossingBuffer USDC is also in the contract, credited to member.withdrawable above
        _finalizeCrossing(self, cfg, member);
    }

    function coPayRescue(MatrixState storage self, ImmutableConfig memory cfg, address member) external {
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.parkedAt[member] > 0,            "F8V8: not parked");
        require(self.partner != address(0),           "F8V8: no partner");
        require(self.stabilityFund != address(0),     "F8V8: no stabilityFund");

        uint256 withdrawable = self.members[member].withdrawable;

        // V8.31: crossing reserve is consumed first -- reduces SF shortfall.
        uint256 reserve = self.members[member].crossingReserve;
        uint256 effectiveContrib = reserve + withdrawable;

        // Pure SF loan: SF covers the full shortfall. No deployer USDC required.
        uint256 shortfall = cfg.entryFee > effectiveContrib ? cfg.entryFee - effectiveContrib : 0;

        // V8.48 item 11 — same erasure as selfRescue, same fix. A member rescued by the
        // co-pay keeper whose own balances already covered the fee borrows NOTHING
        // (shortfall == 0) and previously lost the excess anyway.
        uint256 surplus = effectiveContrib > cfg.entryFee ? effectiveContrib - cfg.entryFee : 0;

        self.members[member].crossingReserve = 0;
        self.members[member].withdrawable = surplus;

        if (shortfall > 0) {
            // SF transfers shortfall USDC to this contract to complete the entry fee.
            // V8.48 item 46: the member travels with the request — the SF enforces
            // the insolvency floor there and reverts "SF: insolvency floor" for a
            // member whose debt already guarantees the next shortfall. The keeper
            // routes those members to the eviction valve instead (item 47).
            IStabilityFund(self.stabilityFund).payCoRescue(member, cfg.tierIndex, shortfall);
            // V8.47: record on the member-level ledger (was per-matrix self.rescueDebt),
            // so repayment can come from any tier / withdrawal, not just this matrix.
            IStabilityFund(self.stabilityFund).increaseMemberDebt(member, cfg.tierIndex, shortfall);
            emit RescueLoanIssued(member, shortfall, "coPayRescue");
        }

        _removeFromParkedQueue(self, member);

        emit CoPayRescue(member, shortfall, 0, withdrawable);
        _finalizeCrossing(self, cfg, member);
    }

    /// @notice Member rescues themselves by paying their own shortfall.
    ///         No SF loan. No debt. No intermediary required.
    ///         Anyone can call this -- only msg.sender is rescued (prevents griefing).
    function selfRescue(MatrixState storage self, ImmutableConfig memory cfg) external {
        _selfRescue(self, cfg);
    }

    /// @notice V8.48 item 40: selfRescue with an EIP-2612 permit folded in, so the
    ///         approve becomes a free off-chain signature and each parked position
    ///         costs ONE transaction instead of two (Lavern-Gay's report, 2026-08-11:
    ///         "I had to click both Approval and Self-Rescue several times"). Mirrors
    ///         TierRouter.manualUpgradeWithPermit exactly, including the try/catch:
    ///         a griefed or already-consumed permit must not brick the rescue when
    ///         the allowance is already in place — and if neither the permit nor a
    ///         standing allowance covers the shortfall, the transfer inside
    ///         _selfRescue reverts with the token's own error, never a silent pass.
    ///         Runs under delegatecall, so address(this) IS the matrix — the same
    ///         spender _selfRescue's safeTransferFrom draws on.
    function selfRescueWithPermit(
        MatrixState storage self,
        ImmutableConfig memory cfg,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        try IERC20PermitLike(address(cfg.usdc)).permit(
            msg.sender, address(this), value, deadline, v, r, s
        ) {} catch {}
        _selfRescue(self, cfg);
    }

    function _selfRescue(MatrixState storage self, ImmutableConfig memory cfg) internal {
        address member = msg.sender;
        require(self.members[member].hasEverJoined,  "F8V8: not a member");
        require(!self.members[member].isInMatrix,    "F8V8: still in matrix");
        require(self.parkedAt[member] > 0,            "F8V8: not parked");

        // V8.44 overflow rework: the V8.43 saturation diversion to pair N+1
        // (_rescueToNextPair) is REMOVED — it orphaned the own pair's MatB from
        // all flow at saturation. Own members always return to their own pair
        // via _finalizeCrossing (MatA→own MatB; MatB→own pair via PairManager).
        // The V8.40 "partner full - wait for rotation" guard is also removed:
        // an entry into a full matrix rotates its root out (cycle-then-place),
        // which is precisely how a full MatB is supposed to churn.

        uint256 withdrawable = self.members[member].withdrawable;

        // V8.31: crossing reserve is consumed first -- reduces what member must pay.
        uint256 reserve = self.members[member].crossingReserve;
        uint256 effectiveContrib = reserve + withdrawable;
        uint256 shortfall = cfg.entryFee > effectiveContrib ? cfg.entryFee - effectiveContrib : 0;

        // V8.48 item 11 — THE SURPLUS BELONGS TO THE MEMBER.
        //
        // Both balances used to be zeroed unconditionally while _finalizeCrossing
        // forwards only cfg.entryFee, so anything above the fee was ERASED. Not spent,
        // not locked — deleted, with the USDC left sitting in this contract and the
        // member's claim on it gone.
        //
        // It fires whenever reserve + withdrawable EXCEEDS the fee, which is exactly
        // the self-funded rescue: fastlane_rescue.js, 2026-08-11, two real cases —
        // $5.00 + $5.438759 against a $10.00 fee ($0.44 erased) and $12.50 + $14.76495
        // against $25.00 ($2.26 erased). Roughly one an hour on the live chain.
        //
        // Return the excess to withdrawable. The USDC backing it never left this
        // contract — only entryFee is forwarded — so the credit is fully backed.
        uint256 surplus = effectiveContrib > cfg.entryFee ? effectiveContrib - cfg.entryFee : 0;

        self.members[member].crossingReserve = 0;
        self.members[member].withdrawable = surplus;

        if (shortfall > 0) {
            // Member pays their own shortfall directly -- no debt, no SF involvement.
            cfg.usdc.safeTransferFrom(member, address(this), shortfall);
        }

        _removeFromParkedQueue(self, member);

        emit SelfRescue(member, shortfall, withdrawable);
        _finalizeCrossing(self, cfg, member);
    }

    // V8.44: _rescueToNextPair removed (overflow rework — own members never
    // divert to pair N+1; see _finalizeCrossing).

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

    /// @notice V8.44 (graceful exit, BUGS.md option b + plan I3): a member
    ///         voluntarily leaves their seat (or the parked queue) mid-cycle.
    ///         Their crossing reserve is released to withdrawable MINUS a
    ///         DAO-tunable penalty routed to the StabilityFund (the reserve
    ///         funds the crossing mechanic that pays everyone — the penalty
    ///         protects the loop while still giving members an exit door).
    ///         Earnings are NEVER penalized. Root (seat 1) cannot exit — it is
    ///         about to cycle out naturally.
    event MemberExitedSeat(address indexed member, uint256 position, uint256 reserveReleased, uint256 penalty);

    function exitSeat(MatrixState storage self, ImmutableConfig memory cfg, uint256 penaltyBps) external {
        address member = msg.sender;
        bool seated = self.members[member].isInMatrix;
        bool parked = self.parkedAt[member] > 0;
        require(seated || parked, "F8V8: no seat or parked slot to exit");

        uint256 pos = 0;
        if (seated) {
            pos = self.matrixPos[member];
            require(pos != 1, "F8V8: root exits by cycling out");
            _settlePool(self, cfg, member);
            self.poolK[member] = 0;
            self.posToMember[pos]           = address(0);
            self.matrixPos[member]          = 0;
            self.members[member].isInMatrix = false;
            self.occupancy                 -= 1;
        }
        if (parked) {
            _removeFromParkedQueue(self, member);
        }

        uint256 r = self.members[member].crossingReserve;
        uint256 penalty = 0;
        if (r > 0) {
            penalty = r * penaltyBps / BPS_DENOM;
            self.members[member].crossingReserve  = 0;
            self.members[member].withdrawable    += r - penalty;
            if (penalty > 0) _forwardToStabilityFund(self, cfg, penalty, 3);
        }
        emit MemberExitedSeat(member, pos, r, penalty);
    }

    /// @notice V8.48 item 45: partner-side half of the seat-clears-the-pair rule.
    ///         Called by the PARTNER matrix from its enterMatrix the moment it seats
    ///         this member; clears any parked-queue residue they left HERE. Guarded
    ///         to the partner only — nobody else may dequeue somebody.
    function clearParkRecordFor(MatrixState storage self, address member) external {
        require(msg.sender == self.partner, "F8V8: only partner");
        if (self.parkedAt[member] > 0) {
            uint256 staleTs = self.parkedAt[member];
            _removeFromParkedQueue(self, member);
            self.parkedAt[member] = 0;  // belt and braces — _remove clears it only when found
            emit GhostDequeued(member, staleTs);
        }
    }

    /// @notice V8.48 item 47: the eviction valve, two branches (owner policy 2026-08-13).
    ///
    ///         GHOST — the member is actually SEATED (here or in the partner half):
    ///         the queue entry is stale residue, measured at 41 live on 2026-08-13.
    ///         Dequeue only. No funds move, no seat is touched. The pre-V8.48 code
    ///         REVERTED on this state ("F8V8: member is in matrix"), which is why
    ///         ghosts could never be cleaned by any path.
    ///
    ///         EVICTION — a genuinely parked member the keeper has decided to remove
    ///         (insolvency floor tripped, rescue-ratio exceeded, or idle): out of the
    ///         queue, and their crossing reserve is RELEASED to withdrawable in full.
    ///         This exit is involuntary, so no exitSeat-style penalty — the reserve is
    ///         their own money, and stranding it was the adminReleaseStrandedReserve
    ///         class of bug. Their SF debt stays booked and repays off the top of the
    ///         next withdrawal (withdrawCore), which is what finally drains the book.
    ///         Re-entry afterwards costs the full fee: "not a free ride forever".
    function evictParked(MatrixState storage self, address member) external {
        require(self.parkedAt[member] > 0,          "F8V8: member not parked");

        // GHOST branch — seated in this matrix or in the partner half.
        if (self.members[member].isInMatrix
            || (self.partner != address(0)
                && IFigureEightMatrixV8Cross(self.partner).isActiveInMatrix(member))) {
            uint256 staleTs = self.parkedAt[member];
            _removeFromParkedQueue(self, member);
            self.parkedAt[member] = 0;
            emit GhostDequeued(member, staleTs);
            return;
        }

        // EVICTION branch.
        uint256 withdrawn = self.members[member].totalWithdrawn;
        _removeFromParkedQueue(self, member);

        uint256 r = self.members[member].crossingReserve;
        if (r > 0) {
            self.members[member].crossingReserve = 0;
            self.members[member].withdrawable   += r;
            emit EvictionReserveReleased(member, r);
        }

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
        // V8.44 (item D): settle pool accrual first — callers gate on the
        // pending-inclusive withdrawableOf view, so the stored balance must be
        // brought current before the deduction guard below.
        _settlePool(self, cfg, member);

        // V8.44 (item A): proper reserve accounting. V8.43 transferred escrowAmt
        // USDC without decrementing any member field — which is exactly why
        // TierRouter passed 0 and the reserve stranded. Escrow now draws down
        // the member's crossingReserve, with an explicit balance guard.
        if (escrowAmt > 0) {
            require(
                self.members[member].crossingReserve >= escrowAmt,
                "F8V8: insufficient crossing reserve"
            );
            self.members[member].crossingReserve -= escrowAmt;
        }
        if (withdrawableAmt > 0) {
            require(
                self.members[member].withdrawable >= withdrawableAmt,
                "F8V8: insufficient earnings"
            );
            self.members[member].withdrawable -= withdrawableAmt;
        }

        // V8.32 Task #60: clear any ghost-parked state on this tier's slot
        // when the member is deducted for an auto-upgrade to a higher tier.
        if (self.parkedAt[member] > 0) {
            _removeFromParkedQueue(self, member);
            self.parkedAt[member] = 0;
        }

        uint256 total = escrowAmt + withdrawableAmt;
        if (total > 0) {
            cfg.usdc.safeTransfer(self.tierRouter, total);
        }
    }

    /// @notice V8.44 (item B): TierRouter parks a member whose MatB cycle-out
    ///         could not fund a re-entry (re-entry ON but reserve + withdrawable
    ///         < fee). Puts the member into the SAME parked machinery as the
    ///         MatA crossing path, so the auto-rescue keeper and selfRescue()
    ///         (reserve + withdrawable + shortfall, no debt) both apply.
    ///         V8.43 had NO parking on this path — members silently exited.
    function parkCycledOut(
        MatrixState storage self,
        address member,
        uint256 shortfall
    ) external {
        require(self.members[member].hasEverJoined, "F8V8: not a member");
        require(!self.members[member].isInMatrix,   "F8V8: still in matrix");
        if (self.parkedAt[member] > 0) return;  // already parked — no-op
        self.parkedMembers.push(member);
        self.parkedAt[member] = block.timestamp;
        emit MemberParked(member, shortfall);
    }

    /// @notice V8.44 (item B/I3): release a member's un-consumed crossing
    ///         reserve to withdrawable. Called by TierRouter on a clean
    ///         graduation (re-entry explicitly OFF, or member left the tier via
    ///         upgrade-only) so the reserve is never stranded. NOT called when
    ///         the member parks — a parked member's reserve stays earmarked for
    ///         their rescue.
    function releaseReserve(MatrixState storage self, address member) external {
        require(!self.members[member].isInMatrix, "F8V8: still in matrix");
        uint256 r = self.members[member].crossingReserve;
        if (r > 0) {
            self.members[member].crossingReserve  = 0;
            self.members[member].withdrawable    += r;
        }
    }

    /// @notice V8.44 (item C): admin stranded-reserve recovery — guards + event
    ///         here so the wrapper stays tiny (EIP-170 factory embed).
    event StrandedReserveReleased(address indexed member, uint256 amount);

    function releaseStranded(MatrixState storage self, address member) external {
        require(!self.members[member].isInMatrix, "F8V8: still in matrix");
        require(self.parkedAt[member] == 0,       "F8V8: parked - use selfRescue path");
        uint256 r = self.members[member].crossingReserve;
        require(r > 0, "F8V8: no stranded reserve");
        self.members[member].crossingReserve  = 0;
        self.members[member].withdrawable    += r;
        emit StrandedReserveReleased(member, r);
    }

    // --- V8.37: adminForceRotateRoot -------------------------------------------
    // Body lives here (not in FigureEightMatrixV8) so that FigureEightMatrixV8's
    // creation bytecode stays small enough for MatrixPairFactory to embed it under
    // the EIP-170 24,576-byte limit.
    function adminForceRotateRoot(
        MatrixState storage self,
        ImmutableConfig memory cfg
    ) external {
        require(!cfg.isMatrixA, "F8V8: only callable on MatB");
        require(self.nextSlot > 1,  "F8V8: no members to rotate");
        _cycleOutRoot(self, cfg);
    }
}
