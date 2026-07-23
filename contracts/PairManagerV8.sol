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
    //   routeEntryThreshold (127×3 = 381): from here the pair's loop is
    //     saturated — ALL overflow routes to the next pair: new externals,
    //     re-entries, double-entry seats, and self-rescues.
    // Loop capacity 127×4 = 508 should never be reached.
    uint256 public deployEntryThreshold = 375;
    uint256 public routeEntryThreshold  = 381;

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

    /// @notice V8.43: is pair `idx` saturated AND is a next pair available to overflow into?
    function overflowActive(uint256 idx) public view returns (bool) {
        return idx < pairs.length
            && pairs[idx].totalRegistered >= routeEntryThreshold
            && idx + 1 < pairs.length;
    }

    /// @notice V8.43: route a self-rescuing member from a saturated pair into the
    ///         next pair's MatA. Called by one of this PM's matrices, which sends
    ///         the entry fee with the call (approve → safeTransferFrom here).
    ///         The caller matrix has already verified overflowActive(pairIndex).
    function rescueOverflow(address member, address referrer, uint256 fromPairIndex) external {
        require(isPairMatrix[msg.sender],        "PM8: not a pair matrix");
        require(overflowActive(fromPairIndex),   "PM8: overflow not active");

        uint256 destIdx = fromPairIndex + 1;
        address matA    = pairs[destIdx].matrixA;

        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        pairs[destIdx].totalRegistered += 1;
        totalRegistrations             += 1;

        emit MemberRouted(member, destIdx, matA);
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
        // alive. Overflow to the next pair only at true saturation (127×3 entries).
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
    ///         entries are still under routeEntryThreshold (127×3). MatA fullness
    ///         is ignored: a full MatA rotates its root on entry (V8.41), keeping
    ///         the self-sustaining loop fed until true saturation. When every pair
    ///         is saturated, the newest holds until the factory adds the next one.
    function _findExternalPair() internal view returns (uint256) {
        uint256 n = pairs.length;
        for (uint256 i = 0; i < n; i++) {
            if (pairs[i].totalRegistered < routeEntryThreshold) return i;
        }
        return n - 1;
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
