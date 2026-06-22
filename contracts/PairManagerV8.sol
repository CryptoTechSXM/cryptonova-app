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
 *  - _tryAdvancePair() at 80% capacity
 *  - allPairsStatus(), shouldExpand(), all view functions
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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

    uint256 public expandThresholdBps = 8000;  // 80%
    uint256 public constant BPS_DENOM = 10_000;

    // ─── Events ───────────────────────────────────────────────────────────────
    event PairAdded(uint256 indexed pairId, address matrixA, address matrixB);
    event PairActivated(uint256 indexed pairId);
    event MemberRouted(address indexed member, uint256 indexed pairId, address matrixA);
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

    function setExpandThreshold(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= BPS_DENOM, "PM8: invalid bps");
        expandThresholdBps = _bps;
    }

    /// @notice V8.21: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "PM8: not authorized");
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

        Pair storage p = pairs[activePairIndex];
        address matA   = p.matrixA;

        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(msg.sender, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

        emit MemberRouted(msg.sender, activePairIndex, matA);
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

        Pair storage p = pairs[activePairIndex];
        address matA   = p.matrixA;

        // Pull fee from member directly — TierRouter told them to approve this PM
        usdc.safeTransferFrom(member, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

        emit MemberRouted(member, activePairIndex, matA);
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
    function registerFor(address member, address referrer) external {
        require(msg.sender == tierRouter, "PM8: not tierRouter");
        require(pairs.length > 0,         "PM8: no pairs");

        _tryAdvancePair();

        Pair storage p = pairs[activePairIndex];
        address matA   = p.matrixA;

        // Pull fee from TierRouter — TierRouter must have approved this PM before calling
        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrixV8PM(matA).enterFor(member, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

        emit MemberRouted(member, activePairIndex, matA);
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
    function addPair(address matrixA, address matrixB) external onlyOwner {
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

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _tryAdvancePair() internal {
        if (activePairIndex + 1 >= pairs.length) return;

        Pair storage p = pairs[activePairIndex];
        uint256 combined = IFigureEightMatrixV8PM(p.matrixA).occupancy()
                         + IFigureEightMatrixV8PM(p.matrixB).occupancy();
        uint256 maxCap   = IFigureEightMatrixV8PM(p.matrixA).MATRIX_SIZE() * 2;

        if (combined * BPS_DENOM / maxCap >= expandThresholdBps) {
            activePairIndex += 1;
            emit PairActivated(activePairIndex);
        }
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

    function getActivePair() external view
        returns (address matrixA, address matrixB, uint256 pairId, uint256 reg)
    {
        require(pairs.length > 0, "PM8: no pairs");
        uint256 i = activePairIndex;
        return (pairs[i].matrixA, pairs[i].matrixB, i, pairs[i].totalRegistered);
    }

    function shouldExpand() external view returns (bool) {
        if (pairs.length == 0) return false;
        Pair storage p = pairs[activePairIndex];
        uint256 combined = IFigureEightMatrixV8PM(p.matrixA).occupancy()
                         + IFigureEightMatrixV8PM(p.matrixB).occupancy();
        uint256 maxCap   = IFigureEightMatrixV8PM(p.matrixA).MATRIX_SIZE() * 2;
        return combined * BPS_DENOM / maxCap >= expandThresholdBps;
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

        for (uint256 i = 0; i < n; i++) {
            Pair storage p = pairs[i];
            matrixAs[i]   = p.matrixA;
            matrixBs[i]   = p.matrixB;
            occupancyA[i] = IFigureEightMatrixV8PM(p.matrixA).occupancy();
            occupancyB[i] = IFigureEightMatrixV8PM(p.matrixB).occupancy();
            registered[i] = p.totalRegistered;
            active[i]     = (i == activePairIndex);
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
        for (uint256 i = 0; i < n; i++) {
            pairIds[i]   = i;
            sharesBps[i] = (i == activePairIndex) ? BPS_DENOM : 0;
        }
    }
}
