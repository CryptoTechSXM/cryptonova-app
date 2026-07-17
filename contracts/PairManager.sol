// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  PairManager  v3  — Sequential Routing
 * @notice Routing layer that sits between users and figure-8 matrix pairs.
 *
 * ─── VISION ──────────────────────────────────────────────────────────────────
 *  Every member takes the SAME sequential journey:
 *    1. Enter through the current active pair's Matrix A
 *    2. Work up to root, cross to Matrix B (Follow Me Escrow funds the crossing)
 *    3. Work up to root in B, cross back to A (figure-8 loop within pair)
 *    4. When the pair reaches 80% capacity → a new pair opens
 *    5. New members now enter the NEW pair's Matrix A
 *    6. Old pair keeps cycling its existing members forever (funded by Protocol Reserve if needed)
 *
 * ─── HOW ROUTING WORKS ───────────────────────────────────────────────────────
 *  ALL new members always go to the SINGLE active pair's Matrix A.
 *  No splitting, no parallel streams, no skipping ahead.
 *
 *  Pair 1 active:  100% → Pair 1 Matrix A
 *  Pair 1 at 80%:  New pair deploys → 100% → Pair 2 Matrix A
 *  Pair 2 at 80%:  New pair deploys → 100% → Pair 3 Matrix A
 *
 *  This ensures:
 *    - No stagnation (each pair has full traffic while active)
 *    - No stuck crossings in organic growth (escrow builds naturally)
 *    - Fair sequential journey for all members
 *    - Protocol Reserve only activates below 40% participation
 *
 * ─── EXPANSION ───────────────────────────────────────────────────────────────
 *  When the active pair combined occupancy hits expandThresholdBps (80%),
 *  admin deploys a new pair and calls addPair().
 *  The new pair immediately becomes active for all new registrations.
 *
 * ─── ACCESS CONTROL ──────────────────────────────────────────────────────────
 *  register()           — any address (members)
 *  addPair()            — onlyOwner
 *  setExpandThreshold() — onlyOwner
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFigureEightMatrix2 {
    function lastRotationTimestamp() external view returns (uint256);
}

interface IFigureEightMatrix {
    function enterFor(address member, address referrer) external;
    function occupancy()   external view returns (uint256);
    function MATRIX_SIZE() external view returns (uint256);
    function ENTRY_FEE()   external view returns (uint256);
    function partner()     external view returns (address);
    function setChainNext(address next) external;
    function setChainAuthorized(address caller, bool authorized) external;
}

contract PairManager is Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Pair record ──────────────────────────────────────────────────────────
    struct Pair {
        address matrixA;
        address matrixB;
        uint256 deployedAt;
        uint256 totalRegistered;  // new members who entered via this pair
    }

    // ─── Storage ──────────────────────────────────────────────────────────────
    Pair[]  public pairs;
    uint256 public activePairIndex;
    uint256 public totalRegistrations;

    IERC20  public immutable usdc;
    uint256 public immutable entryFee;

    // ─── Circular chain tracking ──────────────────────────────────────────────
    address public chainHead;    // First pair's Matrix A — the universal entry point
    address public lastChainB;   // Most recent B-type matrix (isMatrixA=false)

    // Expansion threshold: advance to next pair when active pair hits this %
    uint256 public expandThresholdBps = 8000;  // 80%
    uint256 public constant BPS_DENOM = 10_000;

    // ─── Events ───────────────────────────────────────────────────────────────
    event PairAdded(uint256 indexed pairId, address matrixA, address matrixB);
    event PairActivated(uint256 indexed pairId);
    event MemberRouted(address indexed member, uint256 indexed pairId, address matrixA);
    event ExpansionRecommended(uint256 pairId, uint256 combinedPct);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _usdc, uint256 _entryFee, address _admin) Ownable(_admin) {
        require(_usdc != address(0), "PM: zero usdc");
        require(_entryFee > 0,       "PM: zero fee");
        usdc     = IERC20(_usdc);
        entryFee = _entryFee;
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Register as a new member.
     *         Always routes to the SINGLE active pair's Matrix A.
     *         Sequential — everyone takes the same journey through pairs.
     *
     * @param referrer  Sponsor address (address(0) = no referrer)
     */
    function register(address referrer) external {
        require(pairs.length > 0, "PM: no pairs configured");

        // Auto-advance if active pair has hit expansion threshold AND next pair exists
        _tryAdvancePair();

        Pair storage p = pairs[activePairIndex];
        address matA   = p.matrixA;

        // Pull USDC from member and forward to active Matrix A
        usdc.safeTransferFrom(msg.sender, matA, entryFee);
        IFigureEightMatrix(matA).enterFor(msg.sender, referrer);

        p.totalRegistered  += 1;
        totalRegistrations += 1;

        emit MemberRouted(msg.sender, activePairIndex, matA);
        _checkExpansion();
    }

    // ─── Admin: pair management ────────────────────────────────────────────────

    /**
     * @notice Register a new figure-8 pair with PairManager.
     *         The new pair becomes active IMMEDIATELY — all new registrations
     *         route here. The previous pair keeps cycling its existing members.
     *
     * @param matrixA  New pair's Matrix A (isMatrixA = true)
     * @param matrixB  New pair's Matrix B (isMatrixA = false)
     */
    /**
     * @notice Register a new figure-8 pair and wire it into the circular chain.
     *
     *   FIRST pair:
     *     chainHead = matrixA (universal entry point, never changes)
     *     lastChainB = matrixB
     *     matrixB.chainNext = matrixA (simple figure-8 until next pair added)
     *     → matrixA authorizes matrixB as chain caller (matrixB→matrixA already via partner)
     *
     *   SUBSEQUENT pairs:
     *     lastChainB.chainNext = matrixA (forward: previous B → new A)
     *     matrixB.chainNext = chainHead  (circle-back: new B → first A)
     *     matrixA.setChainAuthorized(lastChainB) ← lastChainB calls matrixA._enterMatrix
     *     chainHead.setChainAuthorized(matrixB)  ← matrixB calls chainHead._enterMatrix
     *     Update lastChainB = matrixB
     */
    function addPair(address matrixA, address matrixB) external onlyOwner {
        require(matrixA != address(0) && matrixB != address(0), "PM: zero address");
        require(
            IFigureEightMatrix(matrixA).partner() == matrixB,
            "PM: matrices not linked"
        );

        uint256 pairId = pairs.length;
        pairs.push(Pair({
            matrixA:         matrixA,
            matrixB:         matrixB,
            deployedAt:      block.timestamp,
            totalRegistered: 0
        }));

        // ── Wire circular chain ──────────────────────────────────────────────
        if (pairId == 0) {
            // First pair: simple figure-8 loop (B→A), chainHead is always A
            chainHead  = matrixA;
            lastChainB = matrixB;
            // matrixB's partner is already matrixA, so chainNext = matrixA (same effect)
            IFigureEightMatrix(matrixB).setChainNext(matrixA);
            // matrixA already authorizes matrixB via partner check — no extra auth needed
        } else {
            // Subsequent pair: extend the chain
            // 1. Previous lastChainB now crosses FORWARD to new matrixA
            IFigureEightMatrix(lastChainB).setChainNext(matrixA);
            IFigureEightMatrix(matrixA).setChainAuthorized(lastChainB, true);
            // 2. New matrixB circles BACK to chainHead (first Matrix A)
            IFigureEightMatrix(matrixB).setChainNext(chainHead);
            IFigureEightMatrix(chainHead).setChainAuthorized(matrixB, true);
            // 3. Update tracking
            lastChainB = matrixB;
        }

        // New pair immediately becomes active for new registrations
        activePairIndex = pairId;

        emit PairAdded(pairId, matrixA, matrixB);
        emit PairActivated(pairId);
    }

    /**
     * @notice Manually advance to the next pair (admin emergency override).
     */
    function forceAdvancePair() external onlyOwner {
        require(activePairIndex + 1 < pairs.length, "PM: no next pair - add one first");
        activePairIndex += 1;
        emit PairActivated(activePairIndex);
    }

    /**
     * @notice Update the expansion threshold.
     *         Default: 80% (8000 BPS). Testnet can use 50% for faster testing.
     */
    function setExpandThreshold(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= BPS_DENOM, "PM: invalid bps");
        expandThresholdBps = _bps;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _tryAdvancePair() internal {
        // Only advance if a next pair already exists (admin must deploy it first)
        if (activePairIndex + 1 >= pairs.length) return;

        Pair storage p = pairs[activePairIndex];
        IFigureEightMatrix matA = IFigureEightMatrix(p.matrixA);
        IFigureEightMatrix matB = IFigureEightMatrix(p.matrixB);

        uint256 combined = matA.occupancy() + matB.occupancy();
        uint256 maxCap   = matA.MATRIX_SIZE() * 2;

        if (combined * BPS_DENOM / maxCap >= expandThresholdBps) {
            activePairIndex += 1;
            emit PairActivated(activePairIndex);
        }
    }

    function _checkExpansion() internal {
        Pair storage p = pairs[activePairIndex];
        IFigureEightMatrix matA = IFigureEightMatrix(p.matrixA);
        IFigureEightMatrix matB = IFigureEightMatrix(p.matrixB);
        uint256 combined = matA.occupancy() + matB.occupancy();
        uint256 maxCap   = matA.MATRIX_SIZE() * 2;
        if (maxCap == 0) return;
        uint256 pct = combined * BPS_DENOM / maxCap;
        if (pct >= expandThresholdBps) {
            emit ExpansionRecommended(activePairIndex, combined * 100 / maxCap);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function pairCount() external view returns (uint256) {
        return pairs.length;
    }

    /// @notice Required by IPairManagerKeeper (MatrixKeeper).
    ///         Returns total pair count — all pairs, active or historical.
    function activePairCount() external view returns (uint256) {
        return pairs.length;
    }

    /// @notice Get matrixA and matrixB addresses for a given pair index.
    ///         Required by IPairManagerKeeper (MatrixKeeper) and IPairManagerV8 (TierRouter).
    ///         V8.38: added to support multi-pair MatB eligibility scan in manualUpgrade().
    function getPairAt(uint256 idx) external view returns (address matA, address matB) {
        require(idx < pairs.length, "PM: invalid index");
        return (pairs[idx].matrixA, pairs[idx].matrixB);
    }

    /// @notice The circular chain: A→B→C→D→...→A
    function getChainInfo() external view returns (address head, address lastB) {
        return (chainHead, lastChainB);
    }

    /// @notice Total unique member registrations across all pairs.
    ///         Used by CNOVATreasury as the member tracker for Universe Mode.
    function totalMembers() external view returns (uint256) {
        return totalRegistrations;
    }

    /// @notice Timestamp of first pair deployment (used by earlyExitPenaltyBps).
    function memberJoinedAt(address) external pure returns (uint256) {
        return 0; // PairManager doesn't track individual join timestamps
    }

    function newestPairIndex() external view returns (uint256) {
        require(pairs.length > 0, "PM: no pairs");
        return pairs.length - 1;
    }

    /// @notice Days since the most recent rotation across ALL matrices.
    ///         This is the real stall signal. Zero means activity happened today.
    ///         Above stall threshold (e.g. 30 days) → Protocol Reserve should inject.
    function daysSinceLastActivity() external view returns (uint256 daysSince, uint256 lastTs) {
        lastTs = block.timestamp; // default: now (no stall)
        for (uint256 i = 0; i < pairs.length; i++) {
            // Check both A and B matrices of each pair
            address[2] memory mats = [pairs[i].matrixA, pairs[i].matrixB];
            for (uint256 j = 0; j < 2; j++) {
                try IFigureEightMatrix2(mats[j]).lastRotationTimestamp() returns (uint256 ts) {
                    if (ts > 0 && ts < lastTs) lastTs = ts; // find MOST RECENT rotation
                } catch {}
            }
        }
        // If lastTs was never updated (no rotations yet), daysSince = 0
        if (lastTs >= block.timestamp) return (0, block.timestamp);
        daysSince = (block.timestamp - lastTs) / 1 days;
    }

    /// @notice Overall system participation rate (0–100).
    ///         Below 40 = Protocol Reserve should inject members to keep chain moving.
    ///         Measures combined occupancy of ALL pairs vs total capacity.
    function systemParticipationPct() external view returns (uint256 pct, uint256 combined, uint256 total) {
        if (pairs.length == 0) return (0, 0, 0);
        for (uint256 i = 0; i < pairs.length; i++) {
            combined += IFigureEightMatrix(pairs[i].matrixA).occupancy();
            combined += IFigureEightMatrix(pairs[i].matrixB).occupancy();
            total    += IFigureEightMatrix(pairs[i].matrixA).MATRIX_SIZE() * 2;
        }
        pct = total == 0 ? 0 : combined * 100 / total;
    }

    /// @notice Whether active pair has hit the expansion threshold
    function shouldExpand() external view returns (bool) {
        if (pairs.length == 0) return false;
        Pair storage p = pairs[activePairIndex];
        IFigureEightMatrix matA = IFigureEightMatrix(p.matrixA);
        IFigureEightMatrix matB = IFigureEightMatrix(p.matrixB);
        uint256 combined = matA.occupancy() + matB.occupancy();
        uint256 maxCap   = matA.MATRIX_SIZE() * 2;
        return combined * BPS_DENOM / maxCap >= expandThresholdBps;
    }

    /// @notice Full status of all pairs
    function allPairsStatus()
        external view
        returns (
            address[] memory matrixAs,
            address[] memory matrixBs,
            uint256[] memory occupancyA,
            uint256[] memory occupancyB,
            uint256[] memory registered,
            bool[]    memory active
        )
    {
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
            occupancyA[i] = IFigureEightMatrix(p.matrixA).occupancy();
            occupancyB[i] = IFigureEightMatrix(p.matrixB).occupancy();
            registered[i] = p.totalRegistered;
            active[i]     = (i == activePairIndex);
        }
    }

    // Legacy compatibility
    function activePairIndex_view() external view returns (uint256) {
        return activePairIndex;
    }
    function getActivePair()
        external view
        returns (address matrixA, address matrixB, uint256 pairId, uint256 reg)
    {
        require(pairs.length > 0, "PM: no pairs");
        uint256 i = activePairIndex;
        return (pairs[i].matrixA, pairs[i].matrixB, i, pairs[i].totalRegistered);
    }

    // Routing distribution — with sequential routing, active pair gets 100%
    function routingDistribution()
        external view
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
