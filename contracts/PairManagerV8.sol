// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  PairManagerV8
 * @notice V8 "Elevator" — sequential pair router for a single tier.
 *
 * CHANGES FROM V7 PairManager
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. registerDirectFor(member, referrer)
 *       Called by TierRouter for first-time registrations. Pulls fee directly
 *       from the member's wallet (member must have approved this PairManager).
 *
 *  2. registerFor(member, referrer)
 *       Called by TierRouter for upgrades and re-entries. Pulls fee from
 *       TierRouter (msg.sender), which holds the USDC from deductForUpgrade().
 *
 *  3. tierRouter address + setTierRouter()
 *       Both registerDirectFor() and registerFor() require msg.sender == tierRouter.
 *
 *  4. register() (direct member entry) now requires tierRouter == address(0)
 *       In V8 production, tierRouter is always set, so direct calls are blocked.
 *       For testnet scripts that test V8 matrices directly, deploy without
 *       setting tierRouter.
 *
 * UNCHANGED FROM V7
 * ─────────────────────────────────────────────────────────────────────────────
 *  - addPair() and circular chain wiring
 *  - _tryAdvancePair() factory trigger (newest pair MatB ≥1 rotation + MatA full)
 *  - allPairsStatus(), shouldExpand(), all view functions
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMatrixPairFactory {
    /// @notice Deploy and wire a new MatA+MatB pair for the calling PairManager's tier.
    ///         Called by _tryAdvancePair() when no pre-deployed next pair exists.
    function deployAndWire(address pairManager) external returns (address matA, address matB);
}

interface IFigureEightMatrixV8PM {
    /// V8.50 item G: the contested-seat flag (see graduationTargetFor).
    function crossingInProgress() external view returns (bool);
    function enterFor(address member, address referrer) external;
    function occupancy()   external view returns (uint256);
    function MATRIX_SIZE() external view returns (uint256);
    function ENTRY_FEE()   external view returns (uint256);
    function partner()     external view returns (address);
    function setChainNext(address next) external;
    function setChainAuthorized(address caller, bool authorized) external;
    function lastRotationTimestamp() external view returns (uint256);
    /// @notice V8.21: governance fee broadcast target -- see setWithdrawalFeeBps
    ///         below. FigureEightMatrixV8 already accepts calls from its own
    ///         pairManager address for this setter.
    ///         (Early Exit Penalty BPS was going to get an equivalent broadcast
    ///         setter here too, but that param was retired entirely instead --
    ///         it was stored and DAO-votable but never actually consumed by any
    ///         withdraw/cycle logic. See FigureEightMatrixV8.sol/V8Governance.sol
    ///         PARAM_EARLY_EXIT_PENALTY_BPS retirement notes.)
    function setWithdrawalFeeBps(uint256 bps) external;
    function rotationCount() external view returns (uint256);
    /// @notice V8.41 FIFO: stores which pair index (0 = T1.1, 1 = T1.2 …) this matrix belongs to.
    function setPairIndex(uint256 idx) external;
    /// @notice V8.46: needed by freePairFor() to find a pair the member is not in.
    function isActiveInMatrix(address member) external view returns (bool);
}

contract PairManagerV8 is Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Pair record ──────────────────────────────────────────────────────────
    struct Pair {
        address matrixA;
        address matrixB;
        uint256 deployedAt;
        uint256 totalRegistered;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────
    Pair[]  public pairs;
    uint256 public activePairIndex;
    uint256 public totalRegistrations;

    // ── V8.48 item 7: MEMBER vs ENTRY, finally separated at this layer ────────
    //
    // totalRegistrations increments on EVERY routing — register, rescue re-entry,
    // MatB placement, doubles — so it is an ENTRY counter, ~41x the people count
    // (the item-42 measurement: 27,776 seats across 671 members). Two consumers
    // needed a PERSON-denominated answer and had none:
    //   - CNOVATreasury.earlyExitPenaltyBps: "days since FIRST T1 registration"
    //     drives the redeem-at-floor penalty ladder — memberJoinedAt did not
    //     exist here, so the treasury's try/catch read 0 and every penalty was 0.
    //   - CNOVATreasury.setFreeMode: the 500-MEMBER Universe Mode gate read
    //     totalMembers() == totalRegistrations — it would have opened on entry
    //     CHURN, not adoption (~12 real members' worth of re-entries suffice).
    //
    // memberJoinedAt is written ONCE, at a member's first routing through this
    // PairManager, by every path that seats someone; re-entries are no-ops. The
    // public mapping's auto-getter is exactly the IMatrixMemberCount signature
    // the treasury already calls.
    mapping(address => uint256) public memberJoinedAt;
    /// @notice Count of UNIQUE members ever routed through this PairManager.
    uint256 public uniqueMembers;

    function _recordJoin(address member) internal {
        if (memberJoinedAt[member] == 0) {
            memberJoinedAt[member] = block.timestamp;
            uniqueMembers += 1;
        }
    }

    IERC20  public immutable usdc;
    uint256 public immutable entryFee;

    address public tierRouter;      // set post-deploy via setTierRouter()

    // ─── V8.35: Autonomous pair factory ──────────────────────────────────────
    /// @notice MatrixPairFactory — called by _tryAdvancePair() to deploy a new pair
    ///         inline when the active pair hits expandThresholdBps and no pre-deployed
    ///         next pair exists.  address(0) = factory not wired (expansion disabled).
    address public pairFactory;

    /// @notice Reentrancy guard for factory expansion.  Prevents a misbehaving
    ///         factory from calling back into routing during deployAndWire().
    bool private _expanding;

    // ─── V8.21: Governance co-control ─────────────────────────────────────────
    /// @notice DAO governance contract. Co-governs the broadcast fee setters
    ///         below alongside owner -- neither replaces the other (owner
    ///         keeps emergency backstop), same pattern as every other V8.20+
    ///         governance-wired contract.
    address public governance;

    /// @notice V8.21: last value broadcast via setWithdrawalFeeBps. 0 means
    ///         "never broadcast yet" (the allowed-value menu on
    ///         FigureEightMatrixV8 starts at >0, so 0 is a safe sentinel) --
    ///         addPair() uses this to auto-stamp newly added pairs with
    ///         whatever the DAO most recently set, instead of leaving them on
    ///         FigureEightMatrixV8's hardcoded constructor default while every
    ///         other pair in the tier has moved on.
    uint256 public lastWithdrawalFeeBps;

    // ─── Circular chain (intra-tier multi-pair) ───────────────────────────────
    address public chainHead;       // first pair's Matrix A
    address public lastChainB;      // most recent B-type matrix

    uint256 public expandThresholdBps = 8000;   // 80% — advance to a pre-deployed next pair
    // V8.36 Bug Fix #3: Separate threshold for autonomous factory expansion.
    // Old behaviour: factory fired at 80% combined occupancy (when MatA=127, MatB~77).
    // This opened T1.2 while T1.1's MatB was still 60% unfilled, splitting the community
    // too early and causing cross-pair referrer issues.
    // New behaviour: factory fires only when the pair is 100% complete (MatA=127, MatB=127),
    // i.e. a full 254-seat cycle is done. Pre-deployed pairs still advance at 80%.
    uint256 public factoryExpandThresholdBps = 9_000;  // V8.41: 90% MatB occupancy triggers next pair
    uint256 public constant BPS_DENOM = 10_000;

    // ─── V8.48 item 30: THE TWO ENTRY THRESHOLDS ARE GONE ────────────────────
    //
    // `deployEntryThreshold` (375) and `routeEntryThreshold` (400) both counted
    // CUMULATIVE entries into a pair (`pair.totalRegistered`) and compared them to a
    // configured number. Both are deleted, along with their setter and
    // `overflowActive()`. Nothing reads them any more:
    //
    //   entry routing  — `_findExternalPair()`: V8.52, the FULL MatA that has rotated
    //                    least (pair 0 until it is full). Never a non-full pair, so new
    //                    members are still never diluted below MATRIX_SIZE (item 10b's
    //                    point); but every full pair keeps receiving entries (R1).
    //   expansion      — `_tryAdvancePair()` reads LIVE OCCUPANCY: 90% of the newest
    //                    MatB, or the newest pair full (item 33).
    //
    // WHY DELETED RATHER THAN LEFT INERT. A cumulative counter only ever increments,
    // so a pair that passed the threshold was excluded from new registrations FOREVER —
    // even after its members cycled out and freed seats. A full MatA only rotates when
    // it RECEIVES an entry (MatrixLogicLib:407), so exclusion meant no rotation, which
    // meant every member in seats 2..127 stopped moving. `route_rr.js` was written on
    // 2026-07-27 purely to walk the threshold around the pairs and mask this; when that
    // keeper was switched off on 2026-08-06, 254 members froze in T1.1 MatA within three
    // days.
    //
    // A knob that appears to steer routing but steers nothing is the same class of
    // defect as the routing-pair label and the tier-card copy that told members a
    // standby pair opens at 1,000,000 entries. V8.46 set the precedent by deleting
    // `pairExpansionThreshold` outright once it was inert. Do NOT reintroduce either as
    // a routing input.
    //
    // Capacity is read from the matrices, never configured — `_pairFull()` compares
    // occupancy() to MATRIX_SIZE(). A configured capacity can only ever be set wrong.


    /// @notice V8.43: matrices belonging to this PM — allow-list for rescueOverflow().
    mapping(address => bool) public isPairMatrix;

    // ─── Events ───────────────────────────────────────────────────────────────
    event PairAdded(uint256 indexed pairId, address matrixA, address matrixB);
    event PairActivated(uint256 indexed pairId);
    event MemberRouted(address indexed member, uint256 indexed pairId, address matrixA);
    /// @notice V8.50 item S: a rescued member was diverted out of their own pair because
    ///         BOTH its halves were full. Emitted only on the escape hatch, so the
    ///         keepers and pair_saturation.js can count how often it fires — a silent
    ///         routing change is one nobody can measure. See rescueReentry.
    event RescueOverflowed(address indexed member, uint256 indexed fromPair, uint256 indexed toPair);
    event ExpansionRecommended(uint256 pairId, uint256 combinedPct);
    // V8.21
    event GovernanceSet(address indexed governance);
    event WithdrawalFeeBpsBroadcast(uint256 bps, uint256 pairsUpdated);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, uint256 _entryFee, address _admin) Ownable(_admin) {
        require(_usdc != address(0), "PM8: zero usdc");
        require(_entryFee > 0,       "PM8: zero fee");
        usdc     = IERC20(_usdc);
        entryFee = _entryFee;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setTierRouter(address _tr) external onlyOwner {
        tierRouter = _tr;
    }

    /// @notice V8.35: Wire the MatrixPairFactory. address(0) disables auto-expansion.
    function setFactory(address _factory) external onlyOwner {
        pairFactory = _factory;
    }

    function setExpandThreshold(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= BPS_DENOM, "PM8: invalid bps");
        expandThresholdBps = _bps;
    }

    /// @notice V8.46: does `member` hold a seat ANYWHERE in this tier — any pair,
    ///         either half?
    ///
    ///         Replaces four guards in TierRouter that each tested
    ///         `tierMatrixAAddr[i]` — a SINGLE address, set once at deploy by an
    ///         onlyOwner setter, so it is PAIR 1 FOREVER while pairCount() grows.
    ///         T1 has four pairs and T2-T6 have two, so a member seated in pair
    ///         2+ was invisible to every one of them: _manualUpgrade:901,
    ///         hybridUpgrade:930, bulkUpgrade:1059 and _executeAdditive:1302.
    ///         Live proof — Maximum_71 holds T1.3 MatB, which none of them see.
    ///
    ///         Lives here because this contract owns the pair list and has ~11k
    ///         bytes spare, while TierRouter has none. One call replaces a
    ///         storage read plus an external call at each site, so the router
    ///         gets SMALLER while getting correct.
    function holdsSeatIn(address member) external view returns (bool) {
        uint256 n = pairs.length;
        for (uint256 i = 0; i < n; i++) {
            Pair storage pr = pairs[i];
            if (IFigureEightMatrixV8PM(pr.matrixA).isActiveInMatrix(member)) return true;
            if (pr.matrixB != address(0) &&
                IFigureEightMatrixV8PM(pr.matrixB).isActiveInMatrix(member)) return true;
        }
        return false;
    }

    /// @notice V8.46: index of a pair in this tier where `member` holds NEITHER
    ///         half, searching from just after `avoid`. Returns type(uint256).max
    ///         when every pair already holds them.
    ///
    ///         Exists for DOUBLE ENTRY. A double takes a second seat in the same
    ///         tier, and V8.45 sent it to the other half of the member's own pair
    ///         — which is a duplicate by construction, and a duplicate is exactly
    ///         what wedges a pair when its holder reaches the root. Measured
    ///         2026-07-28: 67 duplicates formed in five days, three pairs stopped.
    ///
    ///         The search lives HERE rather than in TierRouter because the router
    ///         has 143 bytes of EIP-170 headroom and this contract has ~11,900,
    ///         and because the pair list is this contract's own data.
    ///
    ///         Starting AFTER `avoid` means the member's own pair is tried last,
    ///         so a double lands somewhere else whenever anywhere else is free.
    function freePairFor(address member, uint256 avoid) external view returns (uint256) {
        return _freePairFor(member, avoid);
    }

    function _freePairFor(address member, uint256 avoid) internal view returns (uint256) {
        uint256 n = pairs.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 idx = (avoid + 1 + i) % n;
            Pair storage pr = pairs[idx];
            if (IFigureEightMatrixV8PM(pr.matrixA).isActiveInMatrix(member)) continue;
            if (pr.matrixB != address(0) &&
                IFigureEightMatrixV8PM(pr.matrixB).isActiveInMatrix(member)) continue;
            return idx;
        }
        return type(uint256).max;
    }

    /// @notice V8.50 item S. Is this pair full in BOTH halves? Used only to decide
    ///         whether the saturation escape hatch in rescueReentry applies.
    ///         ⛔ EVERY READ IS WRAPPED AND AN UNREADABLE MATRIX RETURNS false — i.e.
    ///         "not known to be saturated", which keeps today's own-pair behaviour.
    ///         Guessing "saturated" from a failed read would divert a member who had a
    ///         seat waiting; that is the more damaging error of the two.
    function _bothHalvesFull(Pair storage p) internal view returns (bool) {
        if (p.matrixA == address(0)) return false;
        uint256 aOcc; uint256 aSize; bool ok = true;
        try IFigureEightMatrixV8PM(p.matrixA).occupancy()   returns (uint256 v) { aOcc  = v; } catch { ok = false; }
        try IFigureEightMatrixV8PM(p.matrixA).MATRIX_SIZE() returns (uint256 v) { aSize = v; } catch { ok = false; }
        if (!ok || aSize == 0 || aOcc < aSize) return false;
        if (p.matrixB == address(0)) return true;
        uint256 bOcc; uint256 bSize; ok = true;
        try IFigureEightMatrixV8PM(p.matrixB).occupancy()   returns (uint256 v) { bOcc  = v; } catch { ok = false; }
        try IFigureEightMatrixV8PM(p.matrixB).MATRIX_SIZE() returns (uint256 v) { bSize = v; } catch { ok = false; }
        return ok && bSize != 0 && bOcc >= bSize;
    }

    /// @notice V8.50 item S. The first pair OTHER than `avoid` that has a genuinely free
    ///         MatA seat and in which `member` holds no seat at all.
    ///         ⛔ DELIBERATELY NOT _freePairFor: that one asks "does the member hold a
    ///         seat here", which a FULL pair also answers no to. Routing a rescue into a
    ///         second full pair would reproduce the exact defect this fixes, one pair
    ///         along. Room is checked, not inferred.
    function _hasRoomAndFree(Pair storage pr, address member) internal view returns (bool) {
        if (pr.matrixA == address(0)) return false;
        bool blocked;
        try IFigureEightMatrixV8PM(pr.matrixA).isActiveInMatrix(member) returns (bool s) { blocked = s; } catch { blocked = true; }
        if (blocked) return false;
        if (pr.matrixB != address(0)) {
            try IFigureEightMatrixV8PM(pr.matrixB).isActiveInMatrix(member) returns (bool s) { blocked = s; } catch { blocked = true; }
            if (blocked) return false;
        }
        uint256 occ; uint256 size; bool ok = true;
        try IFigureEightMatrixV8PM(pr.matrixA).occupancy()   returns (uint256 v) { occ  = v; } catch { ok = false; }
        try IFigureEightMatrixV8PM(pr.matrixA).MATRIX_SIZE() returns (uint256 v) { size = v; } catch { ok = false; }
        return ok && size != 0 && occ < size;
    }

    function _pairWithRoomFor(address member, uint256 avoid) internal view returns (uint256) {
        uint256 n = pairs.length;
        for (uint256 i = 1; i < n; i++) {                 // i from 1: never returns `avoid`
            uint256 idx = (avoid + i) % n;
            if (_hasRoomAndFree(pairs[idx], member)) return idx;
        }
        return type(uint256).max;
    }

    /// @notice V8.50 ITEM G — GRADUATION. Where should a MatB root cycling out of
    ///         `fromPairIndex` re-enter? Returns type(uint256).max for "nowhere else —
    ///         keep today's own-MatA behaviour", which is the answer whenever the pair
    ///         still has room or no other pair does.
    ///
    ///         ⛔ THIS IS A VIEW AND IT NEVER REVERTS. TierRouterLib calls it from inside
    ///         a cycle-out that has NO try/catch above it (T3.1/T4.1, 2026-07-28), so a
    ///         revert here would take an unrelated member's registration with it. Both
    ///         helpers below are already fully try-wrapped and fail toward "no change".
    ///
    ///         ⛔ IT REUSES ITEM S's `_pairWithRoomFor`, NOT `_freePairFor`: room is
    ///         checked, not inferred. Graduating into a second FULL pair would move the
    ///         defect one pair along instead of fixing it.
    function graduationTargetFor(address member, uint256 fromPairIndex)
        external view returns (uint256)
    {
        if (fromPairIndex >= pairs.length) return type(uint256).max;
        address matA = pairs[fromPairIndex].matrixA;
        if (matA == address(0)) return type(uint256).max;

        // ⛔⛔ THE FIRST VERSION OF THIS GATED ON _bothHalvesFull AND NEVER FIRED ONCE.
        // MEASURED, session 50, G1: the trace came back byte-identical to the no-graduation
        // baseline with "P2 received: 0". By the time this is reached, _cycleOutRoot has
        // ALREADY decremented occupancy on BOTH halves (MatrixLogicLib:787) — MatA went
        // 4/4 -> 3/4 freeing the arrival's seat, MatB 4/4 -> 3/4 freeing this root's — so a
        // pair that IS saturated reports 3/4 and 3/4 and _bothHalvesFull answers false.
        // ⛔ SATURATION IS NOT OBSERVABLE AT THE MOMENT THE ROUTING DECISION IS MADE.
        //
        // ✅ AND THE RIGHT QUESTION WAS NEVER "IS THE PAIR FULL" ANYWAY. It is "IS THE SEAT
        // I AM ABOUT TO TAKE ALREADY SPOKEN FOR". `crossingInProgress` on the MatA answers
        // exactly that and is EXACT, not a proxy: it is set only by _crossToPartner
        // (MatrixLogicLib:993), which runs only from _cycleOutRoot, which runs only when an
        // entry found MatA FULL. And a MatB root only reaches this function by cycling out,
        // which needs MatB full too. So the flag being set means both halves were full AND
        // an arrival is waiting on the seat.
        //
        // ⚠ THE PROXY THAT WAS REJECTED: "occ + 1 >= size on both halves". It would also
        // fire on a pair that genuinely had one free seat in each half, diverting a member
        // who had a seat waiting — the more damaging error, exactly as item S's
        // _pairWithRoomFor comment argues.
        bool contested;
        try IFigureEightMatrixV8PM(matA).crossingInProgress() returns (bool c) { contested = c; }
        catch { return type(uint256).max; }        // unreadable → own MatA, as before
        if (!contested) return type(uint256).max;

        return _pairWithRoomFor(member, fromPairIndex);
    }

    /// @notice V8.44 overflow rework (replaces V8.43 rescueOverflow, which
    ///         diverted saturated-pair rescues to pair N+1 and starved the own
    ///         MatB — the frozen-MatB root cause). A pair's OWN member being
    ///         rescued/re-entered returns to their OWN pair:
    ///           - below saturation → own MatA (normal self-sustaining loop)
    ///           - at saturation    → V8.50 item S, the escape hatch below.
    ///         ⛔ THE OLD SECOND LINE HERE SAID "at saturation → own MatB". THAT HAS BEEN
    ///         UNTRUE SINCE V8.48 ITEM 10 made this function use matrixA unconditionally;
    ///         the comment was simply left behind. Corrected 2026-08-29 (session 49).
    ///         Called by one of this PM's matrices, which sends the entry fee
    ///         with the call (approve → safeTransferFrom here). Only genuinely
    ///         NEW externals overflow forward (_findExternalPair).
    function rescueReentry(address member, address referrer, uint256 fromPairIndex) external {
        require(isPairMatrix[msg.sender],     "PM8: not a pair matrix");
        require(fromPairIndex < pairs.length, "PM8: invalid pair index");

        Pair storage p = pairs[fromPairIndex];

        // V8.48 item 10 — a rescued member ALWAYS returns to their own MatA.
        //
        // This used to read `p.totalRegistered >= routeEntryThreshold ? matrixB : matrixA`.
        // totalRegistered is CUMULATIVE and only ever increments (:292 and below), so once
        // a pair passed the threshold EVERY later rescue went to MatB, permanently. A member
        // cycled out of MatB, could not fund the crossing, parked, was rescued -- and was put
        // straight back into the same MatB. A closed loop: MatB churned while MatA crawled and
        // nobody climbed the ladder.
        //
        // Measured live 2026-08-09 before this fix:
        //   T2.1  MatA rot   581  |  MatB rot 5684   (9.8x)
        //   T3.1  MatA rot   434  |  MatB rot  870   (2.0x)
        //   parked census: 466 of 714 parked members (65%) were sitting in MatB.
        //
        // This is the THIRD site of the V8.46 cumulative-counter root cause. V8.46 fixed the
        // cycle-out path (TierRouterLib.sameTierTarget) and DELETED pairExpansionThreshold,
        // but missed this one and _findExternalPair (see 10b below).
        //
        // NO COLLISION BRANCH HERE, deliberately. An earlier draft of this fix mirrored
        // TierRouterLib.sameTierTarget and sent the member to MatB when they already held a
        // MatA seat -- the V8.46-C guard. That is DEAD CODE on this path: V8.46's UNIVERSAL
        // PAIR GUARD (MatrixLogicLib:278, added 2026-07-28) rejects a seat in EITHER half of
        // a pair --
        //     require(!isInMatrix && (partner == 0 || !partner.isActiveInMatrix(member)))
        // -- so a member seated in MatA cannot enter MatB either. Routing there would swap one
        // revert for another. The duplicate problem is solved centrally at the chokepoint every
        // seating path passes through, and MatrixKeeper:558 already treats
        // "F8V8: already in matrix" as expected-and-swallowable on the parked-rescue path, so a
        // rescue that would duplicate a seat is skipped cleanly rather than steered sideways.
        // A member cannot hold two seats in one pair (V8.46 universal pair guard,
        // MatrixLogicLib:278 -- it rejects a seat in EITHER half). Before this, a duplicate
        // reaching MatB position 1 reverted here, and rescueReentry is called with NO
        // try/catch at MatrixLogicLib:773 -- so the revert took the whole cycle-out with it
        // and the pair STOPPED DEAD. TierRouter:1372 records the same failure:
        // "a duplicate stops its pair dead the moment its holder reaches position 1
        // (T3.1 and T4.1 both had to be repaired live on 2026-07-28)".
        //
        // Same rule TierRouter:1382 already uses for double entry: take the next pair where
        // this member holds nothing. The 90% factory trigger keeps a standby pair open, so
        // there is normally somewhere to go.
        uint256 destPair = fromPairIndex;
        if (IFigureEightMatrixV8PM(p.matrixA).isActiveInMatrix(member) ||
            (p.matrixB != address(0) &&
             IFigureEightMatrixV8PM(p.matrixB).isActiveInMatrix(member))) {
            destPair = _freePairFor(member, fromPairIndex);
            if (destPair == type(uint256).max) {
                // Seated in EVERY existing pair. A member eligible to cross must not be
                // parked for want of a seat -- spawn a pair so there is somewhere to sit.
                // Normally unreachable: the 90% factory trigger keeps a standby pair open.
                // Wrapped like _tryAdvancePair so a factory failure cannot revert a
                // member's cycle-out.
                _forceExpand();
                destPair = _freePairFor(member, fromPairIndex);
                require(destPair != type(uint256).max, "PM8: no seat available for duplicate");
            }
        } else if (_bothHalvesFull(p)) {
            // ── V8.50 ITEM S — THE SATURATION ESCAPE HATCH ────────────────────────────
            //
            // MEASURED ON CHAIN 2026-08-29 (noseat_witness.js, T1, blocks
            // 46103781..46129371): 105 members parked with shortfall 0, and ALL 105 had
            // another member take a seat in the SAME transaction. 0 exceptions.
            //
            // WHY THAT HAPPENS, counted through the trace (handoff 49.1e). A member
            // entering a MatA that is full cycles its root R_A out, freeing ONE seat.
            // R_A crosses to MatB, which is also full, so MatB cycles ITS root R_B out
            // and R_A takes that seat. R_B then re-enters its OWN MatA — this function,
            // item 10 — and takes the one seat R_A freed. Before: 254 seated. After:
            // 254 seated. R_A and R_B SWAPPED HALVES and the arriving member is parked.
            //
            // ⛔ SO A PAIR SATURATED IN BOTH HALVES CANNOT ABSORB ANYBODY. Entry only
            // rotates two existing members between the halves and parks the arrival.
            // T1.1 parks exactly one member per entry, which is the 188-member queue.
            // Live proof: T1.1 MatA reported FUNDING 0 / NO-SEAT 90 — every one of those
            // members was fully funded and there was simply no seat.
            //
            // ⛔ "RESERVE THE FREED SEAT FOR THE ARRIVING MEMBER" WAS CONSIDERED AND
            // REJECTED: one seat, two claimants. It creates nothing, it only picks R_B
            // as the victim instead. Capacity has to come from a pair that HAS room.
            //
            // WHY THIS DOES NOT UNDO V8.48 ITEM 10. Item 10 cured a real MatB closed
            // loop (measured 2026-08-09: T2.1 MatA rot 581 vs MatB rot 5684, 65% of
            // parked members sitting in MatB) by sending every rescue to the own MatA.
            // That rule is untouched here: this branch is reachable ONLY when BOTH
            // halves are full, which is precisely the case item 10 has no answer for.
            // Any pair with a single free seat still routes to the own MatA exactly as
            // before, so the loop item 10 closed stays closed.
            //
            // SAFETY: rescueReentry is called from MatrixLogicLib with NO try/catch — a
            // revert here takes a member's whole cycle-out with it (TierRouter:1372, and
            // the T3.1/T4.1 repairs of 2026-07-28). So NOTHING in this branch reverts.
            // Every read is wrapped; an unreadable matrix is skipped, never assumed; and
            // if no pair has room the member falls through to the own MatA and parks
            // exactly as they do today. This can improve the outcome, never break it.
            uint256 alt = _pairWithRoomFor(member, fromPairIndex);
            if (alt == type(uint256).max) {
                // Normally unreachable — the 90% factory trigger keeps a standby pair
                // open. Same wrapped force-expand the duplicate branch above uses.
                _forceExpand();
                alt = _pairWithRoomFor(member, fromPairIndex);
            }
            if (alt != type(uint256).max) {
                destPair = alt;
                emit RescueOverflowed(member, fromPairIndex, alt);
            }
        }
        address dest = pairs[destPair].matrixA;

        usdc.safeTransferFrom(msg.sender, dest, entryFee);
        IFigureEightMatrixV8PM(dest).enterFor(member, referrer);

        pairs[destPair].totalRegistered += 1;
        totalRegistrations              += 1;
        _recordJoin(member); // V8.48 item 7 — no-op unless this is their first routing

        emit MemberRouted(member, destPair, dest);
    }

    /// @notice V8.44 overflow rework: TierRouter seats a same-tier re-entry
    ///         directly in a pair's MatB (saturated own pair — the entry
    ///         rotates the full MatB). Fee is pulled from TierRouter, exactly
    ///         like registerFor.
    function registerForMatB(address member, address referrer, uint256 targetPairIndex) external {
        require(msg.sender == tierRouter, "PM8: not tierRouter");
        require(pairs.length > 0,         "PM8: no pairs");

        _tryAdvancePair();

        if (targetPairIndex >= pairs.length) targetPairIndex = pairs.length - 1;

        Pair storage p = pairs[targetPairIndex];
        address matB   = p.matrixB;

        usdc.safeTransferFrom(msg.sender, matB, entryFee);
        IFigureEightMatrixV8PM(matB).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;
        _recordJoin(member); // V8.48 item 7

        emit MemberRouted(member, targetPairIndex, matB);
        _checkExpansion();
    }

    /// @notice V8.36: Set the occupancy threshold at which the factory auto-deploys
    ///         a new pair.  Default 10000 (100%) = only fire when MatA+MatB are both
    ///         fully complete.  Can be lowered for testing (e.g. 8000 = 80%).
    function setFactoryExpandThreshold(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= BPS_DENOM, "PM8: invalid bps");
        factoryExpandThresholdBps = _bps;
    }

    /// @notice V8.21: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "PM8: not authorized");
        _;
    }

    /// @notice V8.35: owner or MatrixPairFactory can call addPair() during expansion.
    modifier onlyOwnerOrFactory() {
        require(msg.sender == owner() || msg.sender == pairFactory, "PM8: not owner/factory");
        _;
    }

    /// @notice V8.21: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        require(_gov != address(0), "PM8: zero governance");
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    /// @notice V8.21: broadcast a withdrawal-fee change to EVERY pair this
    ///         PairManager has ever added (not just the active one) -- fixes
    ///         the bug where param 9 (Withdrawal Fee BPS) had no real
    ///         multi-pair-aware target: a single FigureEightMatrixV8 instance
    ///         only represents ONE pair within a tier, so updating just that
    ///         one left every other pair (and any future ones, pre-fix) on
    ///         a stale fee. This is the DAO-governance entry point for param
    ///         9 -- governance.html targets THIS contract (one per tier), not
    ///         TierRouter (which never implemented this setter at all) or a
    ///         single matrix instance.
    function setWithdrawalFeeBps(uint256 bps) external onlyOwnerOrGovernance {
        lastWithdrawalFeeBps = bps;
        uint256 n = pairs.length;
        for (uint256 i = 0; i < n; i++) {
            IFigureEightMatrixV8PM(pairs[i].matrixA).setWithdrawalFeeBps(bps);
            IFigureEightMatrixV8PM(pairs[i].matrixB).setWithdrawalFeeBps(bps);
        }
        emit WithdrawalFeeBpsBroadcast(bps, n);
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Direct member registration (V7-compatible, for testnet without TierRouter).
     *         Blocked in production when tierRouter is set.
     * @param referrer  Sponsor address
     */
    function register(address referrer) external {
        require(
            tierRouter == address(0),
            "PM8: use TierRouter in V8 production"
        );
        require(pairs.length > 0, "PM8: no pairs");

        _tryAdvancePair();

        uint256 routingIdx = _findExternalPair(); // V8.48: one door, same as registerDirectFor
        Pair storage p = pairs[routingIdx];
        address matA   = p.matrixA;

        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(msg.sender, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;
        _recordJoin(msg.sender); // V8.48 item 7

        emit MemberRouted(msg.sender, routingIdx, matA);
        _checkExpansion();
    }

    /**
     * @notice TierRouter calls this for a member's FIRST registration.
     *         Pulls the entry fee directly from the member's wallet.
     *         Member must have approved THIS PairManager for at least entryFee.
     *
     * @param member   The member being registered
     * @param referrer Sponsor address (already resolved by TierRouter)
     */
    function registerDirectFor(address member, address referrer) external {
        require(msg.sender == tierRouter, "PM8: not tierRouter");
        require(pairs.length > 0,         "PM8: no pairs");

        _tryAdvancePair();

        // V8.52: the door is the least-rotated FULL MatA (see _findExternalPair). Entering
        // a full MatA is correct, not a compromise: the entry rotates the root out, which
        // crosses into the pair's own MatB and frees the seat for the entrant (V8.41 /
        // MatrixLogicLib:407). Diverting new members away from a full pair is what
        // FREEZES it -- which V8.48's single door did to every pair but pair 0.
        uint256 routingIdx = _findExternalPair();
        Pair storage p = pairs[routingIdx];
        address matA   = p.matrixA;

        // Pull fee from member directly -- TierRouter told them to approve this PM
        usdc.safeTransferFrom(member, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;
        _recordJoin(member); // V8.48 item 7

        emit MemberRouted(member, routingIdx, matA);
        _checkExpansion();
    }

    /**
     * @notice TierRouter calls this for upgrades and re-entries.
     *         Pulls the entry fee from TierRouter (msg.sender), which holds
     *         the USDC received from FigureEightMatrixV8.deductForUpgrade().
     *
     * @param member   The member being entered
     * @param referrer Sponsor address (locked in TierRouter)
     */
    /// @notice TierRouter passes the explicit target pair index.
    ///         - Re-entry (same tier):  the member's OWN pair  (TierRouterLib.sameTierTarget)
    ///         - Double  (same tier):   freePairFor()          (TierRouter:1382)
    ///         - Upgrade (next tier):   0, the destination tier's first pair
    ///         If targetPairIndex is out of range, falls back to the newest pair so
    ///         handleCycleOut never reverts (safety net only — the 90% MatB trigger should
    ///         always have the next pair deployed before it is needed).
    ///
    ///         V8.48: the stale V8.41 note here said re-entries pass `srcPairIndex + 1` to
    ///         "graduate from T1.x MatB -> T1.(x+1) MatA". That FORWARD-graduation rule is
    ///         long gone — V8.46 made re-entry return to the member's own pair — and it
    ///         directly contradicted both the code and the routing rule. Corrected rather
    ///         than left, because the next person to read it would have believed it.
    function registerFor(address member, address referrer, uint256 targetPairIndex) external {
        require(msg.sender == tierRouter, "PM8: not tierRouter");
        require(pairs.length > 0,         "PM8: no pairs");

        _tryAdvancePair();

        // Safety: clamp to newest pair if caller passes a stale/invalid index
        if (targetPairIndex >= pairs.length) targetPairIndex = pairs.length - 1;

        // V8.48 — THE 2ND-PAIR ROUTE, placed at the CHOKEPOINT.
        //
        // Owner's routing rule, stated repeatedly:
        //     A -> B -> A same pair     default
        //     A -> B -> A 2nd pair      the member already holds a seat in this pair
        //     A -> B -> A upgrade pair  tier upgrade
        //
        // The middle route existed on rescueReentry (item 31) and on the double
        // (TierRouter:1382) but NOT on ordinary re-entry. There, sameTierTarget steered an
        // already-seated member to their own MatB — a destination V8.46's universal pair
        // guard (MatrixLogicLib:278) refuses outright, because it rejects a seat when the
        // member holds the PARTNER. So the re-entry reverted, V8.46-C caught it, and the
        // member PARKED. Exactly the outcome the owner ruled out: "a member eligible to
        // cross should not be parked, a new pair should be spawned so they have space to
        // sit."
        //
        // Handling it HERE rather than in sameTierTarget covers re-entry, double AND
        // upgrade with ONE guard instead of three patched call sites — the same reasoning
        // that put the V8.46 seat guard at the single point a seat is actually taken. For
        // the double and upgrade this is a no-op: the double already passes a free pair,
        // and upgrades are gated tier-wide by holdsSeatIn() before they get here.
        //
        // No dilution risk: this cannot fire for a NEW member. It requires an existing
        // seat, and new members reach the matrix through registerDirectFor, not this.
        Pair storage tgt = pairs[targetPairIndex];
        if (IFigureEightMatrixV8PM(tgt.matrixA).isActiveInMatrix(member) ||
            (tgt.matrixB != address(0) &&
             IFigureEightMatrixV8PM(tgt.matrixB).isActiveInMatrix(member))) {
            uint256 alt = _freePairFor(member, targetPairIndex);
            if (alt == type(uint256).max) {
                // Seated in EVERY pair. Spawn one rather than park them. try/catch inside
                // _forceExpand, so a factory failure cannot revert the cycle-out.
                _forceExpand();
                alt = _freePairFor(member, targetPairIndex);
                require(alt != type(uint256).max, "PM8: no seat available for duplicate");
            }
            targetPairIndex = alt;
        }

        Pair storage p = pairs[targetPairIndex];
        address matA   = p.matrixA;

        // Pull fee from TierRouter -- TierRouter must have approved this PM before calling
        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;
        _recordJoin(member); // V8.48 item 7

        emit MemberRouted(member, targetPairIndex, matA);
        _checkExpansion();
    }

    // ─── Pair management ──────────────────────────────────────────────────────

    /**
     * @notice Register a new figure-8 pair and wire it into the circular chain.
     *         Wiring rules are identical to V7 PairManager.addPair().
     *
     *   First pair:    chainHead = matA, lastChainB = matB, matB.chainNext = matA
     *   Subsequent:    lastChainB.chainNext = matA, matB.chainNext = chainHead
     *                  matA.setChainAuthorized(lastChainB), chainHead.setChainAuthorized(matB)
     */
    function addPair(address matrixA, address matrixB) external onlyOwnerOrFactory {
        require(matrixA != address(0) && matrixB != address(0), "PM8: zero address");
        require(
            IFigureEightMatrixV8PM(matrixA).partner() == matrixB,
            "PM8: matrices not linked"
        );

        uint256 pairId = pairs.length;
        pairs.push(Pair({
            matrixA:         matrixA,
            matrixB:         matrixB,
            deployedAt:      block.timestamp,
            totalRegistered: 0
        }));

        // V8.43: allow-list for rescueOverflow()
        isPairMatrix[matrixA] = true;
        isPairMatrix[matrixB] = true;

        // V8.41 FIFO: stamp both matrices with their pair index so TierRouter can
        // route graduates to pairIndex+1 (T1.1 MatB root → T1.2 MatA, etc.)
        IFigureEightMatrixV8PM(matrixA).setPairIndex(pairId);
        IFigureEightMatrixV8PM(matrixB).setPairIndex(pairId);

        if (pairId == 0) {
            chainHead  = matrixA;
            lastChainB = matrixB;
            IFigureEightMatrixV8PM(matrixB).setChainNext(matrixA);
        } else {
            IFigureEightMatrixV8PM(lastChainB).setChainNext(matrixA);
            IFigureEightMatrixV8PM(matrixA).setChainAuthorized(lastChainB, true);
            IFigureEightMatrixV8PM(matrixB).setChainNext(chainHead);
            IFigureEightMatrixV8PM(chainHead).setChainAuthorized(matrixB, true);
            lastChainB = matrixB;
        }

        activePairIndex = pairId;

        // V8.21: stamp the new pair with whatever fee values the DAO has most
        // recently broadcast, so it doesn't silently sit on
        // FigureEightMatrixV8's hardcoded constructor default while every
        // other pair in this tier has already moved on. 0 means "never
        // broadcast yet" -- leave the new pair on its own constructor default
        // in that case (matches pre-V8.21 behavior exactly).
        if (lastWithdrawalFeeBps > 0) {
            IFigureEightMatrixV8PM(matrixA).setWithdrawalFeeBps(lastWithdrawalFeeBps);
            IFigureEightMatrixV8PM(matrixB).setWithdrawalFeeBps(lastWithdrawalFeeBps);
        }

        emit PairAdded(pairId, matrixA, matrixB);
        emit PairActivated(pairId);
    }

    function forceAdvancePair() external onlyOwner {
        require(activePairIndex + 1 < pairs.length, "PM8: no next pair");
        activePairIndex += 1;
        emit PairActivated(activePairIndex);
    }

    /// @notice V8.35: Admin override for activePairIndex.
    ///         Use case: deploy script pre-deploys multiple pairs (addPair advances the index
    ///         to the last-added pair each time); call setActivePairIndex(0) after the deploy
    ///         loop so the W1 seed and bigfill fill pair 0 (T1.1).  _tryAdvancePair() then
    ///         auto-advances 0->1->2 as each pair reaches 80% occupancy.
    function setActivePairIndex(uint256 idx) external onlyOwner {
        require(idx < pairs.length, "PM8: invalid index");
        activePairIndex = idx;
        emit PairActivated(idx);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    // ─── V8.48: _findRoutingPair() DELETED — it was a SECOND routing rule ────
    //
    // It returned "the oldest pair whose MatA still has available seats, else the
    // newest". After item 10b that is no longer where anybody goes: `registerDirectFor`
    // routes through `_findExternalPair()` -- one door in V8.48, the least-rotated FULL
    // MatA since V8.52.
    //
    // The two rules AGREE only while pair 0's MatA has a free seat — and a full pair 0
    // is the DESIGNED STEADY STATE, because concentrating the front door is what holds
    // it at MATRIX_SIZE and keeps it rotating. So the moment the design works, the old
    // rule returned pair 1 while every new member actually entered pair 0.
    //
    // That mattered because three PUBLIC VIEWS reported it as the routing target —
    // getActivePair(), allPairsStatus().active[] and routingDistribution() — and the
    // member-facing tier card reads all three. It would have labelled the empty standby
    // pair "taking new entries" and drawn the home card's seat bars from that pair's
    // empty matrices: the "T1.2 reads 0/127 while the community fills T1.1" bug the
    // frontend comments already record, reintroduced from the contract side.
    //
    // Same shape as the routing-pair label in set_entry_thresholds.js, diag_overflow.js's
    // hardcoded pair index and the tier card's threshold copy: an INSTRUMENT that
    // disagrees with the mechanism it reports on. Each one made working code look broken
    // or broken code look fine.
    //
    // One rule, one place: everything reads _findExternalPair().


    /// @notice V8.48 item 10b — ONE POINT OF ENTRY (SUPERSEDED BY V8.52, see the @notice on
    ///         `_findExternalPair` below; the history in this block is kept because R1's
    ///         table cites it). As written for V8.48: every new member enters pair 0's
    ///         MatA. Existing members circulate: own MatA -> own MatB -> own MatA, or on
    ///         to the next pair, or up a tier. New entries never divert.
    ///
    ///         This replaced a first-match scan over each pair's CUMULATIVE entry count
    ///         against a configured threshold. That counter only ever increments
    ///         (:292 and below), so a pair that crossed the threshold was excluded from new
    ///         registrations FOREVER, even after its members cycled out and freed seats. Its
    ///         MatA then had no entry source and froze -- and a full MatA only rotates when
    ///         it RECEIVES an entry (MatrixLogicLib:407), so "no entries" means "no rotation"
    ///         means every member in seats 2..127 stops moving. Second site of the V8.46
    ///         cumulative-counter root cause, after TierRouterLib.sameTierTarget.
    ///
    ///         Live proof: `route_rr.js` was written 2026-07-27 purely to walk the threshold
    ///         around the pairs and mask this. When that keeper was switched off on
    ///         2026-08-06, 254 members froze in T1.1 MatA within three days. On 2026-08-09
    ///         T2.1 held 5,986 cumulative entries against a threshold of 400 and had been
    ///         permanently excluded while T2.2 (35 entries) took everything. The threshold
    ///         itself is deleted as of V8.48 item 30.
    ///
    ///         Feeding a full pair is correct, not a compromise: the entry rotates MatA's
    ///         root out, which crosses into the pair's own MatB and frees the seat for the
    ///         entrant (V8.41 / MatrixLogicLib:407; regression S3 in
    ///         V8_46_MatAStarvation.test.js). If MatB is also full its own root cycles out in
    ///         turn, so the pair keeps processing members indefinitely rather than filling up.
    ///         Verified live 2026-08-09: T1.1 MatA sat at 127/127 and rotated 316 -> 378 in a
    ///         single day precisely because it kept receiving entries.
    ///
    ///         NOT round-robin: spreading entries across pairs means no pair reaches
    ///         MATRIX_SIZE, and below that nothing rotates at all, so nobody cycles. T1.3
    ///         holding 8 members at rot=0 is what thin-spreading looks like.
    ///
    ///         THE MEASURE IS LIVE COMBINED OCCUPANCY, NOT A CUMULATIVE COUNTER. This is the
    ///         same correction V8.46 made to the sibling function, and the parameter's own
    ///         doc at :135 already described it that way. occupancy() falls as members cycle
    ///         out and graduate, so a pair that overflows becomes eligible again -- the
    ///         condition is REVERSIBLE, which is the entire defect: `totalRegistered` only
    ///         ever increments, so exclusion was permanent.
    ///
    ///         Effect: ONE POINT OF ENTRY until that pair is PHYSICALLY full (both halves,
    ///         occupancy == MATRIX_SIZE), then the next pair opens. Not a policy knob
    ///         deciding when a pair has "had enough" -- a statement that there is literally
    ///         nowhere left to sit, read from the matrices rather than configured.
    ///         This also preserves the design law the O4 gate asserts (keepers OFF, every
    ///         MatB still rotates): a pair that never receives externals never rotates, so
    ///         strict one-door would have left pairs 1+ permanently inert.
    /// @dev True when both halves of pair `i` are at MATRIX_SIZE. Capacity is read from
    ///      the matrices, never configured — a knob here could only ever be set wrong, and
    ///      a draft of this fix that hardcoded 254 (2 x 127) silently never diverted on the
    ///      size-7 test rigs, which is precisely what the O4 gate caught.
    function _pairFull(uint256 i) internal view returns (bool) {
        Pair storage pr = pairs[i];
        uint256 live = IFigureEightMatrixV8PM(pr.matrixA).occupancy();
        uint256 cap  = IFigureEightMatrixV8PM(pr.matrixA).MATRIX_SIZE();
        if (pr.matrixB != address(0)) {
            live += IFigureEightMatrixV8PM(pr.matrixB).occupancy();
            cap  += IFigureEightMatrixV8PM(pr.matrixB).MATRIX_SIZE();
        }
        return live >= cap;
    }

    /// @notice V8.52 (2026-09-03, REGRESSION_REGISTER R1 addendum) -- THE DOOR IS THE FULL
    ///         MatA THAT HAS ROTATED LEAST. Pair 0 until pair 0's MatA is full; after that,
    ///         whichever FULL MatA has the lowest rotationCount (a full matrix at 0 rotations
    ///         always wins; ties go to the lowest index). If no MatA is full, pair 0.
    ///
    ///         WHY: a full MatA rotates ONLY when an ENTRY arrives at it (MatrixLogicLib:517).
    ///         V8.48 item 10b made pair 0 the only door, which gave every OTHER pair no entry
    ///         source; item S then SEATED overflow rescues into those pairs' MatAs, which fill
    ///         without ever being entered and stop dead. Measured live 2026-09-03: T1.2 MatA
    ///         127/127 with 0 rotations, T1.2 MatB 0/127, 127 members frozen. The V8.48
    ///         comment this replaces was right that "diverting new members away from a full
    ///         pair is what FREEZES it" -- and never considered that it does so to every pair
    ///         it does not feed. This is the same defect cured for the third time; see R1's
    ///         table for the two earlier coats. `test/V8_52_FrozenPair.test.js` F1 was RED on
    ///         `return 0` and is the regression for this line.
    ///
    ///         NOT "pair 0 until physically full, then the next" (the rule the doc block above
    ///         `_pairFull` describes): a full pair is the DESIGNED STEADY STATE (every entry
    ///         seats one and rotates one out, so occupancy stays at size), so "then the next"
    ///         would starve pair 0 -- the freeze relocated a fourth time. F2 guards that.
    ///         NOT naive round-robin: a pair whose MatA is not full is never a door, so
    ///         entries are never thin-spread below MATRIX_SIZE where nothing rotates. F3
    ///         guards that. Reads LIVE occupancy()/rotationCount() only: no cursor, no
    ///         threshold, no cumulative counter (R3), no storage.
    function _findExternalPair() internal view returns (uint256) {
        uint256 n = pairs.length;
        uint256 best = 0;
        uint256 bestRot = 0;
        bool found = false;
        for (uint256 i = 0; i < n; i++) {
            IFigureEightMatrixV8PM a = IFigureEightMatrixV8PM(pairs[i].matrixA);
            if (a.occupancy() < a.MATRIX_SIZE()) continue;   // not full: never a door
            uint256 rot = a.rotationCount();
            if (!found || rot < bestRot) { found = true; best = i; bestRot = rot; }
        }
        return best; // no full MatA anywhere -> pair 0 (the bootstrap)
    }

    /// @notice V8.41 FIFO: Factory deployment trigger.
    ///         Deploys the next pair when the NEWEST pair's MatB reaches ≥90% occupancy.
    ///         This fires BEFORE MatB fills completely, so the next pair's MatA is ready
    ///         to receive the first MatB graduate (FIFO graduation chain).
    ///
    ///         Why MatB (not MatA): MatA fills first; MatB starts filling only after MatA
    ///         is full and crossings begin. By the time MatB hits 90% (114/127 seats),
    ///         there are still 13 seats of buffer before the first graduation fires —
    ///         ample time for the factory deploy to settle on-chain.
    /// @dev Deploy one pair on demand, ignoring the usual triggers. Used only when a
    ///      member who must move has nowhere left to sit. try/catch mirrors
    ///      _tryAdvancePair: expansion is best-effort and must never revert a member's flow.
    function _forceExpand() internal {
        if (_expanding || pairFactory == address(0)) return;
        _expanding = true;
        try IMatrixPairFactory(pairFactory).deployAndWire(address(this)) {} catch {}
        _expanding = false;
    }

    function _tryAdvancePair() internal {
        // Reentrancy guard: factory's addPair() calls back here indirectly.
        if (_expanding) return;
        if (pairs.length == 0 || pairFactory == address(0)) return;

        Pair storage newest = pairs[pairs.length - 1];
        address newestMatB  = newest.matrixB;

        uint256 matBOcc  = IFigureEightMatrixV8PM(newestMatB).occupancy();
        uint256 matBSize = IFigureEightMatrixV8PM(newestMatB).MATRIX_SIZE();
        // V8.43 two triggers (either fires):
        // V8.48 item 33 — spawn when the newest pair is FULL, not when a cumulative
        // counter passes a configured number.
        //
        // The old trigger was `newest.totalRegistered >= deployEntryThreshold`. That is the
        // same counter-versus-fixed-number test that produced the 10b freeze: totalRegistered
        // only ever increments. It did not wedge here only because addPair() makes the new
        // empty pair the "newest" and resets the comparison — correct by accident, not by
        // design. Fullness is a fact the pair already knows, read from the matrices, and
        // cannot be misconfigured.
        //
        // Both triggers are kept and either fires:
        //   fullTrigger — nowhere left to sit in the newest pair. Guarantees the routing rule
        //     always has somewhere to send a member who cannot stay in their own pair
        //     (rescueReentry -> _freePairFor), so `_forceExpand()` stays unreachable.
        //   matBTrigger — 90% of the newest MatB, i.e. EARLY. Deliberate: it leaves ~13 seats
        //     of runway so the next pair is deployed and wired BEFORE anyone needs it, rather
        //     than mid-cycle-out where a factory deploy would land on top of a cascade.
        bool fullTrigger = _pairFull(pairs.length - 1);
        bool matBTrigger = matBSize > 0 && matBOcc * BPS_DENOM / matBSize >= factoryExpandThresholdBps;
        if (!fullTrigger && !matBTrigger) return;

        _expanding = true;
        // V8.39: wrap deployAndWire in try/catch — registration must not revert if factory fails.
        try IMatrixPairFactory(pairFactory).deployAndWire(address(this)) {
            // success — addPair() callback updates activePairIndex and pairs[]
        } catch {
            _expanding = false;
            return;
        }
        _expanding = false;
    }

    function _checkExpansion() internal {
        Pair storage p = pairs[activePairIndex];
        uint256 combined = IFigureEightMatrixV8PM(p.matrixA).occupancy()
                         + IFigureEightMatrixV8PM(p.matrixB).occupancy();
        uint256 maxCap   = IFigureEightMatrixV8PM(p.matrixA).MATRIX_SIZE() * 2;
        if (maxCap == 0) return;
        if (combined * BPS_DENOM / maxCap >= expandThresholdBps) {
            emit ExpansionRecommended(activePairIndex, combined * 100 / maxCap);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function pairCount() external view returns (uint256) { return pairs.length; }

    /// @notice Total pairs (alias matching IPairManagerKeeper interface for MatrixKeeper)
    function activePairCount() external view returns (uint256) { return pairs.length; }

    /// @notice Active pair's Matrix A (IPairManagerKeeper interface)
    function currentMatA() external view returns (address) {
        require(pairs.length > 0, "PM8: no pairs");
        return pairs[activePairIndex].matrixA;
    }

    /// @notice Active pair's Matrix B (IPairManagerKeeper interface)
    function currentMatB() external view returns (address) {
        require(pairs.length > 0, "PM8: no pairs");
        return pairs[activePairIndex].matrixB;
    }

    /// @notice Return matA and matB for a pair by index (IPairManagerKeeper interface)
    function getPairAt(uint256 idx) external view returns (address matA, address matB) {
        require(idx < pairs.length, "PM8: idx out of range");
        return (pairs[idx].matrixA, pairs[idx].matrixB);
    }

    /// @notice V8.48 item 7: PEOPLE, not entries. This used to return
    ///         totalRegistrations, which counts every routing (~41x the people —
    ///         re-entries, rescues, MatB placements all increment it), and it
    ///         gates Universe Mode at "500+ members" in CNOVATreasury.setFreeMode:
    ///         entry churn alone would have opened an IRREVERSIBLE mode. Entry
    ///         counts remain available as totalRegistrations / totalRegistered.
    function totalMembers() external view returns (uint256) { return uniqueMembers; }

    function getChainInfo() external view returns (address head, address lastB) {
        return (chainHead, lastChainB);
    }

    function newestPairIndex() external view returns (uint256) {
        require(pairs.length > 0, "PM8: no pairs");
        return pairs.length - 1;
    }

    /// @notice V8.40: returns the pair currently receiving new registrations (routing target).
    function getActivePair() external view
        returns (address matrixA, address matrixB, uint256 pairId, uint256 reg)
    {
        require(pairs.length > 0, "PM8: no pairs");
        uint256 i = _findExternalPair(); // V8.48: the door new members actually use
        return (pairs[i].matrixA, pairs[i].matrixB, i, pairs[i].totalRegistered);
    }

    /// @notice V8.40: expansion is needed when the newest pair's MatA is at capacity.
    function shouldExpand() external view returns (bool) {
        if (pairs.length == 0) return false;
        address matA = pairs[pairs.length - 1].matrixA; // V8.40: check newest pair
        return IFigureEightMatrixV8PM(matA).occupancy() >= IFigureEightMatrixV8PM(matA).MATRIX_SIZE();
    }

    function allPairsStatus() external view returns (
        address[] memory matrixAs,
        address[] memory matrixBs,
        uint256[] memory occupancyA,
        uint256[] memory occupancyB,
        uint256[] memory registered,
        bool[]    memory active
    ) {
        uint256 n = pairs.length;
        matrixAs   = new address[](n);
        matrixBs   = new address[](n);
        occupancyA = new uint256[](n);
        occupancyB = new uint256[](n);
        registered = new uint256[](n);
        active     = new bool[](n);

        uint256 routingIdx = _findExternalPair(); // V8.48: the door new members actually use
        for (uint256 i = 0; i < n; i++) {
            Pair storage p = pairs[i];
            matrixAs[i]   = p.matrixA;
            matrixBs[i]   = p.matrixB;
            occupancyA[i] = IFigureEightMatrixV8PM(p.matrixA).occupancy();
            occupancyB[i] = IFigureEightMatrixV8PM(p.matrixB).occupancy();
            registered[i] = p.totalRegistered;
            active[i]     = (i == routingIdx); // V8.40
        }
    }

    function daysSinceLastActivity() external view returns (uint256 daysSince, uint256 lastTs) {
        lastTs = block.timestamp;
        for (uint256 i = 0; i < pairs.length; i++) {
            address[2] memory mats = [pairs[i].matrixA, pairs[i].matrixB];
            for (uint256 j = 0; j < 2; j++) {
                try IFigureEightMatrixV8PM(mats[j]).lastRotationTimestamp() returns (uint256 ts) {
                    if (ts > 0 && ts < lastTs) lastTs = ts;
                } catch {}
            }
        }
        if (lastTs >= block.timestamp) return (0, block.timestamp);
        daysSince = (block.timestamp - lastTs) / 1 days;
    }

    function systemParticipationPct() external view
        returns (uint256 pct, uint256 combined, uint256 total)
    {
        if (pairs.length == 0) return (0, 0, 0);
        for (uint256 i = 0; i < pairs.length; i++) {
            combined += IFigureEightMatrixV8PM(pairs[i].matrixA).occupancy();
            combined += IFigureEightMatrixV8PM(pairs[i].matrixB).occupancy();
            total    += IFigureEightMatrixV8PM(pairs[i].matrixA).MATRIX_SIZE() * 2;
        }
        pct = total == 0 ? 0 : combined * 100 / total;
    }

    function routingDistribution() external view
        returns (uint256[] memory pairIds, uint256[] memory sharesBps)
    {
        uint256 n = pairs.length;
        pairIds   = new uint256[](n);
        sharesBps = new uint256[](n);
        uint256 routingIdx = _findExternalPair(); // V8.48: the door new members actually use
        for (uint256 i = 0; i < n; i++) {
            pairIds[i]   = i;
            sharesBps[i] = (i == routingIdx) ? BPS_DENOM : 0;
        }
    }
}
