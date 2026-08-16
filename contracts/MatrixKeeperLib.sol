// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title  MatrixKeeperLib
 * @notice V8.48 item 12a — the keeper's DISCOVERY path, moved out of MatrixKeeper.
 *
 *         WHY THIS EXISTS
 *         ---------------
 *         MatrixKeeper sat at 24,041 bytes against the EIP-170 limit of 24,576 —
 *         535 bytes of headroom. Item 12 (checkUpkeep discovers its own matrices,
 *         retiring three standalone keepers) cannot be written into 535 bytes, so
 *         the read-only scan comes out first and item 12 is written in here.
 *
 *         WHAT MOVED, AND WHAT DELIBERATELY DID NOT
 *         -----------------------------------------
 *         Moved: the whole VIEW path — checkUpkeep's scan, the per-matrix idle
 *         sweep, the parked-member triage, the frozen-MatB test and the SF rescue
 *         ladder lookup. All of it is read-only, which is what makes it safe to
 *         relocate: a delegatecall that cannot write cannot corrupt storage.
 *
 *         NOT moved: performUpkeep and every _do* execution path. Those mutate
 *         state and call out with value at stake, and the point of this change is
 *         headroom, not a rewrite of the parts that move money.
 *
 *         THE CONFIG STRUCT IS NOT A STYLE CHOICE
 *         ---------------------------------------
 *         The scan reads eighteen keeper variables. Passing them individually
 *         blew the stack ("Stack too deep") in _checkParked, which already
 *         carried a comment about holding peak depth at 8 — see the block scoping
 *         inside it. One memory struct is one stack slot regardless of how many
 *         fields it carries, so ScanCfg is what keeps that function compiling.
 *
 *         lastGhostTime is the exception: it is a mapping, so there is nothing to
 *         flatten into memory and it crosses as a storage reference. Libraries are
 *         the one place in Solidity where a storage pointer may cross an external
 *         call boundary, and this is that case.
 */

// -- Minimal interfaces --------------------------------------------------------

interface ITierRouterKeeper {
    function tierVelocityGreen(uint8 tier) external view returns (bool);
    function setTierVelocityGreen(uint8 tier, bool green) external;
    function setDeflationState(uint8 state) external;
    function getSystemEntryCount(uint256 fromTimestamp) external view returns (uint256);
    function getTierEntryCount(uint8 tier, uint256 fromTimestamp) external view returns (uint256);
}

interface IStabilityFundKeeper {
    function payGhostEntry(uint8 tierIndex, address pairManager) external;
    function activateLayer(uint8 layer, bool active) external;
    function balanceByTier(uint8 tier) external view returns (uint256);
    function totalBalance() external view returns (uint256);
    /// @dev V8.48 item 46: member added so the SF can enforce the insolvency floor.
    function payForceCross(address member, uint8 tierIdx, address sourceMatrix, uint256 fee) external;
    /// @dev V8.48 item 46: discovery routes floor-tripped members to eviction.
    function loanEligible(address member, uint8 tierIdx) external view returns (bool);
}

interface IFigureEightKeeper {
    function reclaimIdleSlot(address member) external;
    function lastActivityTime(address member) external view returns (uint256);
    function isInMatrix(address member) external view returns (bool);
    function matrixPos(address member) external view returns (uint256);
    function posToMember(uint256 pos) external view returns (address);
    function occupancy() external view returns (uint256);
    function MATRIX_SIZE() external view returns (uint256);
    function tierIndex() external view returns (uint8);
    function setChainNext(address next) external;
    function owner() external view returns (address);
    function isParked(address member) external view returns (bool);
    function getParkedCount() external view returns (uint256);
    function getParkedMember(uint256 idx) external view returns (address);
    function forceCrossKeeper(address member, uint256 sfContribution, uint256 crossingBuffer) external;
    function softParkIdle(address member) external;  // V8.33
    function rescueDebtOf(address member) external view returns (uint256);
    function parkedAt(address member) external view returns (uint256);
    function evictParked(address member) external;
    function getMemberTotalWithdrawn(address member) external view returns (uint256);
    function withdrawableOf(address member) external view returns (uint256);
    function crossingReserveOf(address member) external view returns (uint256);  // V8.31
    function isMatrixA() external view returns (bool);
    function ENTRY_FEE() external view returns (uint256);
    function rotationCount() external view returns (uint256);
    // V8.44 (item E): frozen-MatB self-heal
    function nextSlot() external view returns (uint256);
    function lastRotationTimestamp() external view returns (uint256);
    function keeperForceRotateRoot() external;
    // V8.48 items 45/47: ghost detection — a parked record whose holder is seated
    // in the pair's OTHER half is stale residue, not a member awaiting rescue.
    function partner() external view returns (address);
    function isActiveInMatrix(address member) external view returns (bool);
}

interface ICommunityWalletKeeper {
    function distributeReady() external view returns (bool);
    function distribute() external;
    // V8.44 (plan I1): CryptoNovaCommunityWallet epoch automation
    function epochReady() external view returns (bool);
    function advanceEpoch() external;
}

interface IPairManagerKeeper {
    function currentMatA() external view returns (address);
    function currentMatB() external view returns (address);
    function activePairCount() external view returns (uint256);
    function getPairAt(uint256 idx) external view returns (address matA, address matB);
    function entryFee() external view returns (uint256);
}

library MatrixKeeperLib {

    // ── Work item types ───────────────────────────────────────────────────────
    // These MIRROR the public constants on MatrixKeeper and must stay in step:
    // performUpkeep switches on the values this library writes. They are declared
    // here as well because a library cannot read the calling contract's constants,
    // and duplicating four bytes of constant is cheaper than an external call.
    uint8 internal constant WORK_VELOCITY      = 0;
    uint8 internal constant WORK_GHOST         = 1;
    uint8 internal constant WORK_RECLAIM       = 2;
    uint8 internal constant WORK_CHAIN_LINK    = 3;
    uint8 internal constant WORK_PARKED_RESCUE = 4;
    uint8 internal constant WORK_VELOCITY_GATE = 5;
    uint8 internal constant WORK_EVICT_PARKED  = 6;
    uint8 internal constant WORK_DISTRIBUTE_CW = 7;
    uint8 internal constant WORK_FORCE_ROTATE  = 8;
    uint8 internal constant WORK_ADVANCE_EPOCH = 9;

    // ── Eviction REASON codes ─────────────────────────────────────────────────
    // V8.49 item 1. _triageParked used to answer "evict?" with a bool, which made a
    // harmless GHOST and a genuinely insolvent member indistinguishable by the time
    // _checkParked applied a clock — and clocking them differently is the entire
    // point of the change. A uint8 is the SAME single stack slot a bool occupied, so
    // this costs nothing where it matters: see the note above the _triageParked call
    // site about that frame already having blown the stack once.
    //
    // These are internal to discovery. They never reach performData, so the WorkItem
    // wire format is untouched and an upkeep in flight across the upgrade still
    // decodes — the same property item 12a's extraction preserved.
    uint8 internal constant EVICT_NONE   = 0;  // not an eviction — rescue this member
    uint8 internal constant EVICT_GHOST  = 1;  // seated in either half; the valve DEQUEUES ONLY
    uint8 internal constant EVICT_RATIO  = 2;  // withdrawRatio > rescueRatioBps
    uint8 internal constant EVICT_LADDER = 3;  // off the bottom of the SF rescue ladder
    uint8 internal constant EVICT_FLOOR  = 4;  // V8.48 item 46 insolvency floor

    /// @dev Field order is load-bearing: performData is abi.encode(WorkItem[]) and
    ///      performUpkeep decodes it with this exact shape. Reordering these silently
    ///      reroutes work items to the wrong handler.
    struct WorkItem {
        uint8   workType;
        uint8   tierIndex;
        address addr1;
        address addr2;
    }

    struct PendingChainLink {
        address newMatA;
        address newMatB;
        address prevMatB;
        uint8   tierIndex;
    }

    /// @dev A snapshot of everything the scan reads. Built once per checkUpkeep by
    ///      MatrixKeeper, which owns the storage; the library never writes.
    struct ScanCfg {
        uint256 maxItems;
        uint256 lastVelocityCheck;
        uint256 velocityWindow;
        uint256 frozenMatBTimeout;
        uint256 idleSlotTimeout;
        uint256 extendedIdleTimeout;
        uint256 parkedGracePeriod;
        uint256 selfFundedGracePeriod;
        /// @dev V8.49 item 1: the EVICTION clock, separate from the rescue clock.
        ///      Ghosts deliberately keep parkedGracePeriod — see _checkParked.
        uint256 evictionGracePeriod;
        uint256 rescueRatioBps;
        uint8   configuredTierCount;
        address tierRouter;
        address stabilityFund;
        address communityWallet;
        address[]          pairManagers;
        PendingChainLink[] links;
        uint256[]          sfThresholds;
        uint256[]          sfLadder;
    }

    // =========================================================================
    // The scan
    // =========================================================================

    /**
     * @notice Discover every piece of work the keeper should do this block.
     * @dev    View-only by construction. Called by MatrixKeeper.checkUpkeep, which
     *         Chainlink simulates off-chain, so the cost of the memory snapshot in
     *         the caller does not land on any member's transaction.
     */
    function discover(ScanCfg memory cfg, mapping(address => uint256) storage lastGhostTime)
        external view
        returns (WorkItem[] memory trimmed)
    {
        WorkItem[] memory items = new WorkItem[](cfg.maxItems);
        uint256 count = 0;

        if (block.timestamp >= cfg.lastVelocityCheck + cfg.velocityWindow) {
            if (count < cfg.maxItems)
                items[count++] = WorkItem(WORK_VELOCITY, 0, address(0), address(0));
        }

        for (uint256 i = 0; i < cfg.links.length && count < cfg.maxItems; i++) {
            items[count++] = WorkItem(
                WORK_CHAIN_LINK,
                cfg.links[i].tierIndex,
                cfg.links[i].newMatA,
                cfg.links[i].newMatB
            );
        }

        // V8.44 (item E) / V8.48 item 24: frozen-MatB scan — a FULL MatB that
        // hasn't rotated within frozenMatBTimeout (or NEVER rotated: the July 19
        // occ=127/127 rot=0 signature) gets a keeperForceRotateRoot work item.
        //
        // NO LONGER "backstop only". The old comment said "if this ever fires
        // regularly, the routing design has failed" — but a full MatB only
        // rotates when it RECEIVES an entry (cycle-then-place), so whenever
        // inflow pauses, prompt force-rotation is what keeps members cycling.
        // All 6,726 historical force-rotations came from the VPS script at ~10
        // minutes; the owner decided 2026-08-13 the contract owns that policy
        // (frozenMatBTimeout default 15 minutes). Regular firing during quiet
        // inflow is the mechanism WORKING. The design-law gate that still holds:
        // a MatB receiving entries must rotate WITHOUT this scan.
        for (uint8 t = 0; t < cfg.configuredTierCount && count < cfg.maxItems; t++) {
            address pm = cfg.pairManagers[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount && count < cfg.maxItems; p++) {
                (, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                if (matB != address(0) && _isFrozenMatB(matB, cfg.frozenMatBTimeout)) {
                    items[count++] = WorkItem(WORK_FORCE_ROTATE, t, matB, address(0));
                }
            }
        }

        for (uint8 t = 0; t < cfg.configuredTierCount && count < cfg.maxItems; t++) {
            address pm = cfg.pairManagers[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount && count < cfg.maxItems; p++) {
                (address matA, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                count = _scanMatrix(matA, t, items, count, cfg, lastGhostTime);
                count = _scanMatrix(matB, t, items, count, cfg, lastGhostTime);
            }
        }

        for (uint8 t = 0; t < cfg.configuredTierCount && count < cfg.maxItems; t++) {
            address pm = cfg.pairManagers[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount && count < cfg.maxItems; p++) {
                (address matA, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                count = _scanParked(matA, t, items, count, cfg);
                count = _scanParked(matB, t, items, count, cfg);
            }
        }

        for (uint8 t = 0; t < cfg.configuredTierCount && count < cfg.maxItems; t++) {
            if (t + 1 >= 10) continue;
            if (ITierRouterKeeper(cfg.tierRouter).tierVelocityGreen(t + 1)) continue;
            address pm = cfg.pairManagers[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount; p++) {
                (, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                if (matB == address(0)) continue;
                IFigureEightKeeper mat = IFigureEightKeeper(matB);
                uint256 occ  = mat.occupancy();
                uint256 size = mat.MATRIX_SIZE();
                if (size > 0 && occ * 100 >= size * 80) {
                    items[count++] = WorkItem(WORK_VELOCITY_GATE, t, address(0), address(0));
                    break;
                }
            }
        }

        if (cfg.communityWallet != address(0) && count < cfg.maxItems) {
            // try/catch: whichever CW variant is wired, a missing selector must
            // not brick the entire checkUpkeep scan.
            try ICommunityWalletKeeper(cfg.communityWallet).distributeReady() returns (bool ready) {
                if (ready) items[count++] = WorkItem(WORK_DISTRIBUTE_CW, 0, cfg.communityWallet, address(0));
            } catch {}
            if (count < cfg.maxItems) {
                try ICommunityWalletKeeper(cfg.communityWallet).epochReady() returns (bool ready) {
                    if (ready) items[count++] = WorkItem(WORK_ADVANCE_EPOCH, 0, cfg.communityWallet, address(0));
                } catch {}
            }
        }

        trimmed = new WorkItem[](count);
        for (uint256 i = 0; i < count; i++) trimmed[i] = items[i];
    }

    // =========================================================================
    // Shared with the EXECUTION path — these two are called by MatrixKeeper's
    // _do* handlers as well as by the scan above. They live here so the scan and
    // the execution agree by construction: a rescue the scan queues is a rescue
    // performUpkeep can actually pay for.
    // =========================================================================

    /// @dev Full AND (never rotated OR stale past frozenMatBTimeout).
    function isFrozenMatB(address matB, uint256 frozenMatBTimeout) external view returns (bool) {
        return _isFrozenMatB(matB, frozenMatBTimeout);
    }

    function rescueBpsFor(
        uint256[] memory thresholds,
        uint256[] memory ladder,
        uint256 effectiveContrib,
        uint256 entryFee
    ) external pure returns (uint256) {
        return _rescueBpsFor(thresholds, ladder, effectiveContrib, entryFee);
    }

    // =========================================================================
    // Internal — these are inlined INTO this library, not into the keeper.
    // =========================================================================

    function _isFrozenMatB(address matB, uint256 frozenMatBTimeout) internal view returns (bool) {
        IFigureEightKeeper mat = IFigureEightKeeper(matB);
        if (mat.isMatrixA()) return false;
        if (mat.occupancy() < mat.MATRIX_SIZE()) return false;
        uint256 lastRot = mat.lastRotationTimestamp();
        if (lastRot == 0) return true;   // filled but NEVER rotated (July 19 signature)
        return block.timestamp - lastRot >= frozenMatBTimeout;
    }

    function _rescueBpsFor(
        uint256[] memory thresholds,
        uint256[] memory ladder,
        uint256 effectiveContrib,
        uint256 entryFee
    ) internal pure returns (uint256) {
        uint256 n = thresholds.length;
        // V8.23: if no ladder is configured yet (fresh deploy before governance seeds it),
        // fall back to 100% SF coverage so the keeper still rescues parked members.
        if (n == 0) return 10_000;
        uint256 wBps = effectiveContrib * 10_000 / entryFee;
        for (uint256 i = 0; i < n; i++) {
            if (wBps >= thresholds[i]) return ladder[i];
        }
        return type(uint256).max;
    }

    /// @dev Extracted from discover() so the parked loop does not add four locals to
    ///      an already deep frame. Same reason _checkParked block-scopes its maths.
    function _scanParked(
        address matrix,
        uint8 tierIdx,
        WorkItem[] memory items,
        uint256 count,
        ScanCfg memory cfg
    ) internal view returns (uint256) {
        if (matrix == address(0)) return count;
        uint256 pc = IFigureEightKeeper(matrix).getParkedCount();
        for (uint256 idx = 0; idx < pc && count < cfg.maxItems; idx++) {
            (address member, uint8 wt) = _checkParked(matrix, tierIdx, idx, cfg);
            if (wt != type(uint8).max) items[count++] = WorkItem(wt, tierIdx, matrix, member);
        }
        return count;
    }

    /**
     * @dev What should happen to this parked member, ignoring how long they have waited?
     *      Returns the Stability Fund's share of the re-entry (ZERO when the member funds
     *      it themselves) and WHY they should be evicted, if they should — EVICT_NONE
     *      meaning "rescue them". Its own frame purely for stack room — see the note at
     *      the call site.
     *
     *      V8.49 item 1: the second return was a bool. It is a uint8 now because the
     *      four eviction cases are not alike: a GHOST is stale bookkeeping and dequeuing
     *      it costs its holder nothing, while cases 2-4 remove a real member from a real
     *      seat. The caller cannot give them different clocks if it cannot tell them
     *      apart. Same one stack slot; no extra return value, deliberately.
     */
    function _triageParked(IFigureEightKeeper mat, address member, uint8 tierIdx, ScanCfg memory cfg)
        internal view returns (uint256 sfShare, uint8 evictReason)
    {
        // V8.48 item 45: GHOST — a parked record whose holder is actually SEATED in
        // either half of the pair (measured 2026-08-13: 41 live, 39 of them parked
        // in MatB while seated in the same pair's MatA). Rescue would revert
        // "already in matrix" forever; route to the valve, which DEQUEUES ONLY.
        // Scoped so `partner` does not raise this frame's peak stack depth.
        {
            if (mat.isInMatrix(member)) return (0, EVICT_GHOST);
            address partner = mat.partner();
            if (partner != address(0) && IFigureEightKeeper(partner).isActiveInMatrix(member)) {
                return (0, EVICT_GHOST);
            }
        }

        uint256 withdrawn    = mat.getMemberTotalWithdrawn(member);
        uint256 withdrawable = mat.withdrawableOf(member);
        // V8.31: crossing reserve reduces SF shortfall — include it in effective contribution.
        uint256 reserve      = mat.crossingReserveOf(member);
        uint256 fee          = mat.ENTRY_FEE();
        uint256 totalEarned  = withdrawn + withdrawable;
        uint256 withdrawRatio = totalEarned > 0 ? withdrawn * 10_000 / totalEarned : 0;
        // Has taken out most of what they earned — evict rather than lend them more.
        if (withdrawRatio > cfg.rescueRatioBps) return (0, EVICT_RATIO);

        uint256 effectiveContrib = reserve + withdrawable;
        uint256 sfBps = _rescueBpsFor(cfg.sfThresholds, cfg.sfLadder, effectiveContrib, fee);
        // Off the bottom of the ladder — the fund will not cover someone this thin.
        if (sfBps == type(uint256).max) return (0, EVICT_LADDER);

        // THE LINE ITEM 12 TURNS ON. maxShortfall is 0 exactly when the member's own
        // withdrawable + crossing reserve already covers the fee, so sfShare is 0 and the
        // rescue costs the fund nothing. Identical to fastlane_rescue.js's `wd + rs < fee`.
        uint256 maxShortfall = fee > effectiveContrib ? fee - effectiveContrib : 0;
        sfShare = fee * sfBps / 10_000;
        if (sfShare > maxShortfall) sfShare = maxShortfall;

        // V8.48 item 46: the INSOLVENCY FLOOR. A member who would need SF money but
        // whose outstanding debt already guarantees the next shortfall gets no more
        // loans (owner policy 2026-08-13) — route to the eviction valve instead.
        // Self-funded members (sfShare == 0) borrow nothing and are never floored.
        if (sfShare > 0
            && !IStabilityFundKeeper(cfg.stabilityFund).loanEligible(member, tierIdx)) {
            return (0, EVICT_FLOOR);
        }
        // Falling through leaves evictReason at its default 0 == EVICT_NONE: rescue.
    }

    function _checkParked(address matAddr, uint8 tierIdx, uint256 idx, ScanCfg memory cfg)
        internal view
        returns (address parkedMember, uint8 workType)
    {
        IFigureEightKeeper mat = IFigureEightKeeper(matAddr);
        if (mat.getParkedCount() <= idx) return (address(0), type(uint8).max);
        parkedMember = mat.getParkedMember(idx);
        uint256 ts = mat.parkedAt(parkedMember);
        if (ts == 0) return (address(0), type(uint8).max);

        // V8.48 item 12: THE GRACE CHECK MOVED BELOW THE AMOUNT COMPUTATION, ON PURPOSE.
        //
        // It used to sit here, before anything was known about the member, so ONE grace
        // period governed two situations that are not alike:
        //
        //   a rescue the member funds THEMSELVES, out of their own withdrawable plus
        //   crossing reserve, costing the Stability Fund nothing; and
        //
        //   a rescue that draws SF money — a LOAN, clawed back from their future
        //   earnings, which they never asked for.
        //
        // parkedGracePeriod exists for the second. fastlane_rescue.js says so outright:
        // "grace exists to protect members from unwanted LOANS". A member who needs no
        // loan is protected from nothing and simply waits — 24 hours at the live setting
        // — for money already theirs, and is then given a loan anyway, because
        // copay_rescue does not re-check self-funding after the wait.
        //
        // MEASURED, live, 2026-08-11 fastlane.log: two zero-debt rescues at 00:03 —
        // $5.00 reserve + $5.44 earnings vs a $10 fee, and $12.50 + $14.76 vs $25 — then
        // eleven runs at zero. RARE, roughly one an hour against ~900 parked, but real.
        // Rare is why a point-in-time census saw none of them and why the first attempt
        // at this change was reverted: fastlane clears them within ten minutes, so a
        // snapshot samples the residue, not the population.
        //
        // The distinction is already computed one block down: maxShortfall, and so
        // sfShare, is exactly zero when the member covers the fee themselves — the same
        // condition fastlane tests as `wd + rs < fee`. This reorders existing arithmetic
        // and invents no rule. Set selfFundedGracePeriod == parkedGracePeriod and the
        // behaviour collapses to what it was, which is how the pre-refactor equivalence
        // test still holds.

        // A block scope held the old peak stack depth at 8; adding the evict branch did
        // not, and it blew the stack. Extracted to its own frame rather than enabling
        // viaIR — same call as CommunityWallet._gateAndExpiry, and for the same reason:
        // viaIR compiles today and leaves the function one local from the same failure.
        (uint256 sfShare, uint8 evictReason) = _triageParked(mat, parkedMember, tierIdx, cfg);

        uint256 age = block.timestamp - ts;

        // EVICTION GETS ITS OWN, LONGER CLOCK — V8.49 item 1.
        //
        // It used to gate on cfg.parkedGracePeriod, the SAME 24h window that decides
        // when the Stability Fund steps in. The comment here said eviction "keeps the
        // FULL grace period", which was about not giving it item 12's SHORTENED
        // self-funded path — it was never the 3-5 days the owner's policy states.
        // Nobody noticed because evictions had never fired in any version: the VPS
        // evict_parked.js cron guard always matched its own parent shell. V8.48 moved
        // eviction on chain (item 47's valve) and authorized the keeper EOA, so V8.48
        // is the first version that can evict a real member at all — on a clock that
        // was never intended. Hence a SECOND parameter: raising parkedGracePeriod
        // instead would push SF rescue out to days and break the 24h design, because
        // one knob was driving both clocks.
        //
        // GHOSTS DELIBERATELY KEEP THE OLD CLOCK (decided 2026-08-15). A ghost is a
        // parked record whose holder is already seated in either half of the pair;
        // the valve DEQUEUES it and nobody loses a seat, funds or position. Giving it
        // the long clock would make a stale row linger for days for no one's benefit,
        // and giving it a SHORTER-than-today clock is a separate improvement. Keeping
        // it exactly as-is means this parameter introduces exactly ONE behavioural
        // change to reason about — real evictions get slower — instead of two.
        // One line to reverse if that judgement turns out wrong.
        if (evictReason != EVICT_NONE) {
            uint256 gate = evictReason == EVICT_GHOST
                ? cfg.parkedGracePeriod
                : cfg.evictionGracePeriod;
            if (age < gate) return (address(0), type(uint8).max);
            return (parkedMember, WORK_EVICT_PARKED);
        }

        // sfShare == 0 means the member funds their own re-entry. The short floor is not
        // a grace period; it stops a rescue being queued in the same minute a member is
        // mid-registration or mid-upgrade — the race fastlane guards with MIN_AGE=300.
        if (age < (sfShare == 0 ? cfg.selfFundedGracePeriod : cfg.parkedGracePeriod)) {
            return (address(0), type(uint8).max);
        }

        uint256 sfBal   = IStabilityFundKeeper(cfg.stabilityFund).balanceByTier(tierIdx);
        // Fall back to total SF balance if tier bucket cannot cover the rescue share.
        // FIX V8.31: was `sfBal > 0` — same stall-on-pennies bug; checkUpkeep must agree with execution path.
        uint256 sfAvail = sfBal >= sfShare ? sfBal : IStabilityFundKeeper(cfg.stabilityFund).totalBalance();
        workType = (sfAvail >= sfShare) ? WORK_PARKED_RESCUE : type(uint8).max;
    }

    function _scanMatrix(
        address matrix,
        uint8 tierIdx,
        WorkItem[] memory items,
        uint256 count,
        ScanCfg memory cfg,
        mapping(address => uint256) storage lastGhostTime
    ) internal view returns (uint256) {
        if (matrix == address(0)) return count;
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        // Skip idle/ghost checks entirely for matrices that have never completed
        // a full rotation. Members in a first-fill matrix are waiting for growth,
        // not genuinely idle. Ghost-funding and reclaiming only make sense once
        // the matrix is established and actively cycling.
        if (mat.rotationCount() == 0) return count;
        uint256 size = mat.MATRIX_SIZE();
        for (uint256 pos = 1; pos <= size && count < cfg.maxItems; pos++) {
            address member = mat.posToMember(pos);
            if (member == address(0)) continue;
            uint256 idle = block.timestamp - mat.lastActivityTime(member);
            if (idle >= cfg.extendedIdleTimeout) {
                items[count++] = WorkItem(WORK_RECLAIM, tierIdx, matrix, member);
            } else if (idle >= cfg.idleSlotTimeout) {
                if (block.timestamp - lastGhostTime[matrix] >= cfg.idleSlotTimeout)
                    items[count++] = WorkItem(WORK_GHOST, tierIdx, matrix, address(0));
            }
        }
        return count;
    }
}
