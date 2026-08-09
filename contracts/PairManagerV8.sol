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

    // ─── V8.43: Two-threshold pair opening (owner rule 2026-07-22) ───────────
    // Both thresholds count CUMULATIVE entries routed into a pair
    // (pair.totalRegistered — every registration, re-entry and double seat):
    //   deployEntryThreshold (125×3 = 375): deploy the next pair EARLY as a
    //     buffer, so it exists before it's needed (factory deploy is heavy —
    //     avoids a repeat of the July 19 frozen-MatB incident).
    //   routeEntryThreshold (400): from here the pair's loop is saturated —
    //     ALL overflow routes to the next pair: new externals, re-entries,
    //     double-entry seats, and self-rescues.
    // Loop capacity 127×4 = 508 should never be reached.
    //
    // V8.46 (2026-07-28): route was 381 (127×3). The gap between deploy and
    // route is the window the factory has to deploy the next pair, wire its
    // partner and have it ready to receive — and at 375/381 that window was SIX
    // ENTRIES, which under load is seconds. Pair expansion has already caused
    // two incidents: the T1.2-at-254 freeze that needed adminForceRotateRoot,
    // and the 2026-07-28 wedge where every upgrade guard went blind the moment
    // a second pair existed. 375/400 gives 25 entries of headroom.
    //
    // Nothing depends on 381 being 127×3 — it was documentation, not logic.
    //
    // This value was ALREADY SET LIVE on T2–T10 via setEntryThresholds(375,400)
    // on 2026-07-28 (block 44738582 onward). The source still said 381, so a
    // redeploy would have silently reverted every one of those calls. Owner
    // caught it. If you change this default, change it here AND on-chain, or the
    // two disagree the moment anything redeploys.
    //
    // T1 IS DIFFERENT: its routeEntryThreshold is driven at runtime by the
    // round-robin keeper (route_rr.js), which walks it to spread new members
    // across T1's pairs. This default is only T1's starting point.
    uint256 public deployEntryThreshold = 375;
    /// @notice DEAD as of V8.48 — nothing in the production path reads this. Entry
    ///         routing (_findExternalPair) now compares LIVE occupancy against the pair's
    ///         OWN capacity, so there is no threshold to configure. Retained only because
    ///         `overflowActive()` still references it; both should be deleted together
    ///         (see V8_48_SCOPE.md). Do NOT reintroduce it as a routing input: a cumulative
    ///         counter compared to a fixed number is what excluded pairs permanently and
    ///         froze 254 members on 2026-08-06.
    uint256 public routeEntryThreshold  = 254;

    /// @notice V8.43: matrices belonging to this PM — allow-list for rescueOverflow().
    mapping(address => bool) public isPairMatrix;

    // ─── Events ───────────────────────────────────────────────────────────────
    event PairAdded(uint256 indexed pairId, address matrixA, address matrixB);
    event PairActivated(uint256 indexed pairId);
    event MemberRouted(address indexed member, uint256 indexed pairId, address matrixA);
    event ExpansionRecommended(uint256 pairId, uint256 combinedPct);
    // V8.21
    event GovernanceSet(address indexed governance);
    event WithdrawalFeeBpsBroadcast(uint256 bps, uint256 pairsUpdated);
    // V8.43
    event EntryThresholdsSet(uint256 deployThreshold, uint256 routeThreshold);

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

    /// @notice V8.43: adjust the two entry-count thresholds (deploy early / route overflow).
    function setEntryThresholds(uint256 _deploy, uint256 _route) external onlyOwner {
        require(_deploy > 0 && _route >= _deploy, "PM8: deploy<=route required");
        deployEntryThreshold = _deploy;
        routeEntryThreshold  = _route;
        emit EntryThresholdsSet(_deploy, _route);
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

    /// @notice V8.43: is pair `idx` saturated AND is a next pair available to overflow into?
    function overflowActive(uint256 idx) public view returns (bool) {
        return idx < pairs.length
            && pairs[idx].totalRegistered >= routeEntryThreshold
            && idx + 1 < pairs.length;
    }

    /// @notice V8.44 overflow rework (replaces V8.43 rescueOverflow, which
    ///         diverted saturated-pair rescues to pair N+1 and starved the own
    ///         MatB — the frozen-MatB root cause). A pair's OWN member being
    ///         rescued/re-entered ALWAYS returns to their OWN pair:
    ///           - below saturation → own MatA (normal self-sustaining loop)
    ///           - at saturation    → own MatB (the entry rotates the full
    ///             MatB root out — cycle-then-place — keeping it churning)
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
        }
        address dest = pairs[destPair].matrixA;

        usdc.safeTransferFrom(msg.sender, dest, entryFee);
        IFigureEightMatrixV8PM(dest).enterFor(member, referrer);

        pairs[destPair].totalRegistered += 1;
        totalRegistrations              += 1;

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

        uint256 routingIdx = _findRoutingPair(); // V8.40: oldest pair with MatA space
        Pair storage p = pairs[routingIdx];
        address matA   = p.matrixA;

        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(msg.sender, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

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

        // V8.43: externals route to the oldest NON-SATURATED pair. MatA fullness
        // is ignored on purpose — entering a full MatA triggers the natural root
        // rotation (V8.41 mechanism) that keeps the pair's self-sustaining loop
        // alive. Overflow to the next pair only at true saturation
        // (routeEntryThreshold entries — 400 since V8.46, was 127×3 = 381).
        uint256 routingIdx = _findExternalPair();
        Pair storage p = pairs[routingIdx];
        address matA   = p.matrixA;

        // Pull fee from member directly -- TierRouter told them to approve this PM
        usdc.safeTransferFrom(member, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

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
    /// @notice V8.41 FIFO: TierRouter passes the explicit target pair index.
    ///         - Upgrades (new tier): pass 0 — first pair of the destination tier.
    ///         - Re-entries / double-entry (same tier): pass srcPairIndex + 1 —
    ///           graduate from T1.x MatB → T1.(x+1) MatA.
    ///         If targetPairIndex is out of range, falls back to the newest pair
    ///         so handleCycleOut never reverts (safety net only — 90% MatB trigger
    ///         should always have the next pair deployed before it is needed).
    function registerFor(address member, address referrer, uint256 targetPairIndex) external {
        require(msg.sender == tierRouter, "PM8: not tierRouter");
        require(pairs.length > 0,         "PM8: no pairs");

        _tryAdvancePair();

        // Safety: clamp to newest pair if caller passes a stale/invalid index
        if (targetPairIndex >= pairs.length) targetPairIndex = pairs.length - 1;

        Pair storage p = pairs[targetPairIndex];
        address matA   = p.matrixA;

        // Pull fee from TierRouter -- TierRouter must have approved this PM before calling
        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

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

    /// @notice V8.40: Oldest-first pair routing.
    ///         Returns the index of the oldest pair whose MatA still has available seats.
    ///         Falls back to the newest pair when ALL MatAs are at capacity (brief
    ///         crossing-pending window that resolves within one keeper cycle).
    ///
    ///         Why: before V8.40, all new registrations went to the NEWEST pair (activePairIndex).
    ///         This caused older pairs (T1.1, T1.2…) to go dark — their MatA starved of new
    ///         members, so MatB members could never complete further cycles and got stuck.
    ///         Now T1.1 always receives new members first; T1.2+ only when T1.1 MatA is full.
    function _findRoutingPair() internal view returns (uint256) {
        uint256 n = pairs.length;
        for (uint256 i = 0; i < n; i++) {
            address matA = pairs[i].matrixA;
            if (IFigureEightMatrixV8PM(matA).occupancy() < IFigureEightMatrixV8PM(matA).MATRIX_SIZE()) {
                return i;
            }
        }
        return n - 1; // All MatAs at 127/127 — crossing pending; use newest as temp holder
    }

    /// @notice V8.43: external-registration routing — oldest pair whose CUMULATIVE
    ///         entries are still under routeEntryThreshold (400 since V8.46). MatA fullness
    ///         is ignored: a full MatA rotates its root on entry (V8.41), keeping
    ///         the self-sustaining loop fed until true saturation. When every pair
    ///         is saturated, the newest holds until the factory adds the next one.
    /// @notice V8.48 item 10b — ONE POINT OF ENTRY. Every new member enters pair 0's
    ///         MatA. Existing members circulate: own MatA -> own MatB -> own MatA, or on
    ///         to the next pair, or up a tier. New entries never divert.
    ///
    ///         This replaced a first-match scan over `pairs[i].totalRegistered <
    ///         routeEntryThreshold`. That counter is CUMULATIVE and only ever increments
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
    ///         permanently excluded while T2.2 (35 entries) took everything.
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

    function _findExternalPair() internal pure returns (uint256) {
        // ONE POINT OF ENTRY. Every new member enters pair 0's MatA, always. New entries
        // are never diluted across pairs: concentrating them is what keeps pair 0 at
        // MATRIX_SIZE and rotating, and a full MatA only rotates when it RECEIVES an entry
        // (MatrixLogicLib:407). Later pairs are populated by EXISTING members cycling --
        // own MatA by default, the next free pair when the member already holds a seat here
        // (see rescueReentry) -- and by upgrades. Not by splitting the front door.
        return 0;
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
        //   a) newest pair has absorbed deployEntryThreshold (125×3) cumulative
        //      entries — deploy the next pair EARLY as a buffer, or
        //   b) newest MatB ≥ factoryExpandThresholdBps (90%) — V8.41 FIFO rule,
        //      kept as a safety net for low-churn pairs.
        bool entryTrigger = newest.totalRegistered >= deployEntryThreshold;
        bool matBTrigger  = matBSize > 0 && matBOcc * BPS_DENOM / matBSize >= factoryExpandThresholdBps;
        if (!entryTrigger && !matBTrigger) return;

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

    function totalMembers() external view returns (uint256) { return totalRegistrations; }

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
        uint256 i = _findRoutingPair(); // V8.40: routing pair, not newest pair
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

        uint256 routingIdx = _findRoutingPair(); // V8.40: mark routing target as active
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
        uint256 routingIdx = _findRoutingPair(); // V8.40: shows actual routing target
        for (uint256 i = 0; i < n; i++) {
            pairIds[i]   = i;
            sharesBps[i] = (i == routingIdx) ? BPS_DENOM : 0;
        }
    }
}
