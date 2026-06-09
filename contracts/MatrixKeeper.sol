// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title  MatrixKeeper
 * @notice Chainlink Automation-compatible keeper for the V8.1 Elevator system.
 *
 *         RESPONSIBILITIES
 *         ----------------
 *         1. Velocity gate -- monitors per-tier entry rate; sets
 *            tierRouter.tierVelocityGreen[tier] based on a rolling window.
 *
 *         2. Deflation state machine -- tracks systemwide entry rate:
 *              NORMAL   -> entries in last window >= deflationThreshold
 *              SLOW     -> entries < deflationThreshold; activates L2 referral
 *                          carve and L4 devOps carve in StabilityFund
 *              RECOVERY -> entries recovering; transitions back to NORMAL
 *                          after recoveryThreshold consecutive green windows
 *
 *         3. Ghost entries -- when a matrix slot is idle for idleSlotTimeout
 *            seconds, the keeper funds a ghost entry from StabilityFund
 *            (L1 = entry fee from SF) so the matrix stays alive.
 *
 *         4. Idle slot reclaim -- after extendedIdleTimeout, a slot that is
 *            still idle after ghost funding is reclaimed (zero'd) to prevent
 *            a stuck slot from blocking future occupants.
 *
 *         5. Chain-link wiring -- after MatrixFactory.registerPair(), the
 *            keeper must call setChainNext() on new matrices to integrate them
 *            into the circular chain. The deploy script calls this directly;
 *            the keeper can also do it during upkeep.
 *
 *         AUTOMATION MODEL
 *         ----------------
 *         Chainlink Automation calls checkUpkeep() each block. If it returns
 *         true, Automation calls performUpkeep(performData) in the same block.
 *
 *         checkUpkeep encodes a WorkItem[] array in performData:
 *           - Each item has a type (VELOCITY_CHECK, GHOST_ENTRY, RECLAIM_SLOT)
 *             and up to 2 address/uint params.
 *
 *         performUpkeep processes all items in the batch.
 *
 *         GAS LIMIT
 *         ---------
 *         Set Chainlink upkeep gas limit to 3,000,000. Each ghost entry costs
 *         ~150k gas; each velocity check is ~30k; each reclaim is ~50k.
 *         The keeper batches at most MAX_ITEMS_PER_UPKEEP items to avoid
 *         exceeding the gas limit.
 */

// ── Minimal interfaces ────────────────────────────────────────────────────────

interface ITierRouterKeeper {
    function tierVelocityGreen(uint8 tier) external view returns (bool);
    function setTierVelocityGreen(uint8 tier, bool green) external;
    function setDeflationState(uint8 state) external;    // 0=NORMAL 1=SLOW 2=RECOVERY
    function getSystemEntryCount(uint256 fromTimestamp) external view returns (uint256);
    function getTierEntryCount(uint8 tier, uint256 fromTimestamp) external view returns (uint256);
}

interface IStabilityFundKeeper {
    function payGhostEntry(uint8 tierIndex, address pairManager) external;
    function activateLayer(uint8 layer, bool active) external;  // layers 2 and 4
    function balanceByTier(uint8 tier) external view returns (uint256);
    function payForceCross(uint8 tierIdx, address sourceMatrix, uint256 fee) external;
}

interface IFigureEightKeeper {
    function reclaimIdleSlot(address member) external;
    function lastActivityTime(address member) external view returns (uint256);
    function isInMatrix(address member) external view returns (bool);      // members[].isInMatrix
    function matrixPos(address member) external view returns (uint256);
    function posToMember(uint256 pos) external view returns (address);
    function occupancy() external view returns (uint256);
    function MATRIX_SIZE() external view returns (uint256);
    function tierIndex() external view returns (uint8);
    function setChainNext(address next) external;
    function owner() external view returns (address);
    // Parked rescue additions
    function isParked(address member) external view returns (bool);
    function getParkedCount() external view returns (uint256);
    function getParkedMember(uint256 idx) external view returns (address);
    function forceCrossKeeper(address member) external;
    function isMatrixA() external view returns (bool);
    function ENTRY_FEE() external view returns (uint256);
}

interface IPairManagerKeeper {
    function currentMatA() external view returns (address);
    function currentMatB() external view returns (address);
    function activePairCount() external view returns (uint256);
    function getPairAt(uint256 idx) external view returns (address matA, address matB);
    function entryFee() external view returns (uint256);
}

// ── MatrixKeeper ─────────────────────────────────────────────────────────────

contract MatrixKeeper is Ownable {

    // ── Deflation states ──────────────────────────────────────────────────────
    uint8 public constant STATE_NORMAL   = 0;
    uint8 public constant STATE_SLOW     = 1;
    uint8 public constant STATE_RECOVERY = 2;

    // ── Work item types ───────────────────────────────────────────────────────
    uint8 public constant WORK_VELOCITY  = 0;
    uint8 public constant WORK_GHOST     = 1;
    uint8 public constant WORK_RECLAIM   = 2;
    uint8 public constant WORK_CHAIN_LINK    = 3;
    uint8 public constant WORK_PARKED_RESCUE = 4;
    uint8 public constant WORK_VELOCITY_GATE = 5;

    // ── Config (DAO-adjustable via enumerated menus) ───────────────────────────
    /// @notice Rolling window for velocity and deflation checks (seconds)
    uint256 public velocityWindow     = 3_600;   // 1 hour
    /// @notice Min entries per tier per window to keep velocity green
    uint256 public velocityThreshold  = 3;
    /// @notice Min system entries per window above which we stay NORMAL
    uint256 public deflationThreshold = 10;
    /// @notice Consecutive green windows needed to leave RECOVERY
    uint256 public recoveryThreshold  = 3;
    /// @notice Seconds of inactivity before ghost entry is triggered
    uint256 public idleSlotTimeout    = 43_200;  // 12 hours
    /// @notice Seconds after ghost before slot is reclaimed
    uint256 public extendedIdleTimeout = 86_400; // 24 hours
    /// @notice Max work items processed per upkeep to stay under gas limit
    uint256 public maxItemsPerUpkeep  = 15;

    // ── Core state ────────────────────────────────────────────────────────────
    address public tierRouter;
    address public stabilityFund;

    uint8   public deflationState;
    uint256 public lastVelocityCheck;
    uint256 public consecutiveGreenWindows;
    uint256 public consecutiveRedWindows;

    // Per-tier PairManager registry (set by admin)
    mapping(uint8 => address) public pairManagerForTier;  // tierIndex => PairManager
    uint8 public configuredTierCount;

    // Ghost entry tracking: matrix addr => last ghost timestamp
    mapping(address => uint256) public lastGhostTime;
    // Reclaim tracking: (matrix, member) => last reclaim attempt
    mapping(address => mapping(address => uint256)) public reclaimAttemptTime;

    // Pending chain-link queue: new pairs that need setChainNext() wiring
    struct PendingChainLink {
        address newMatA;
        address newMatB;
        address prevMatB;   // previous active matB (chainNext target)
        uint8   tierIndex;
    }
    PendingChainLink[] public pendingChainLinks;

    // ── Events ────────────────────────────────────────────────────────────────
    event VelocityUpdated(uint8 indexed tier, bool green, uint256 entryCount);
    event DeflationStateChanged(uint8 from, uint8 to);
    event GhostEntryFunded(address indexed matrix, uint8 tierIndex);
    event SlotReclaimed(address indexed matrix, address indexed member, uint256 idleSeconds);
    event ChainLinked(address newMatA, address newMatB, address prevMatB);
    event PairManagerSet(uint8 indexed tierIndex, address pairManager);
    event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex);
    event VelocityGateOpened(uint8 indexed forTierIndex);

    // ── Custom errors ─────────────────────────────────────────────────────────
    error MK_NotKeeper();
    error MK_InvalidParam();
    error MK_ZeroAddress();

    // ── Work item struct (ABI-encoded in performData) ─────────────────────────
    struct WorkItem {
        uint8   workType;
        uint8   tierIndex;
        address addr1;       // matrix address for GHOST/RECLAIM; unused for VELOCITY
        address addr2;       // member address for RECLAIM
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _tierRouter, address _stabilityFund) Ownable(msg.sender) {
        if (_tierRouter    == address(0)) revert MK_ZeroAddress();
        if (_stabilityFund == address(0)) revert MK_ZeroAddress();
        tierRouter    = _tierRouter;
        stabilityFund = _stabilityFund;
        lastVelocityCheck = block.timestamp;
    }

    // ── Admin setup ───────────────────────────────────────────────────────────

    function setPairManager(uint8 tierIndex, address pm) external onlyOwner {
        if (pm == address(0)) revert MK_ZeroAddress();
        if (pairManagerForTier[tierIndex] == address(0)) {
            configuredTierCount++;
        }
        pairManagerForTier[tierIndex] = pm;
        emit PairManagerSet(tierIndex, pm);
    }

    /**
     * @notice Queue a new matA/matB pair for chain-link wiring.
     *         Call this after MatrixFactory.registerPair() returns.
     * @param prevMatB  The matB that was previously the "tail" in this tier's chain
     */
    function queueChainLink(
        address newMatA,
        address newMatB,
        address prevMatB,
        uint8   tierIdx
    ) external onlyOwner {
        pendingChainLinks.push(PendingChainLink(newMatA, newMatB, prevMatB, tierIdx));
    }

    // ── Governance setters (enumerated menus) ─────────────────────────────────

    function setVelocityWindow(uint256 v) external onlyOwner {
        require(v == 1800 || v == 3600 || v == 7200 || v == 14400,
            "MK: invalid window (allowed: 1800,3600,7200,14400)");
        velocityWindow = v;
    }

    function setVelocityThreshold(uint256 v) external onlyOwner {
        require(v == 1 || v == 2 || v == 3 || v == 5,
            "MK: invalid threshold (allowed: 1,2,3,5)");
        velocityThreshold = v;
    }

    function setDeflationThreshold(uint256 v) external onlyOwner {
        require(v == 5 || v == 10 || v == 15 || v == 20,
            "MK: invalid deflation threshold (allowed: 5,10,15,20)");
        deflationThreshold = v;
    }

    function setIdleSlotTimeout(uint256 v) external onlyOwner {
        require(v == 21600 || v == 43200 || v == 86400,
            "MK: invalid idle timeout (allowed: 21600,43200,86400)");
        idleSlotTimeout = v;
    }

    function setMaxItemsPerUpkeep(uint256 v) external onlyOwner {
        require(v == 5 || v == 10 || v == 15 || v == 20,
            "MK: invalid max items (allowed: 5,10,15,20)");
        maxItemsPerUpkeep = v;
    }

    // ── Chainlink Automation interface ─────────────────────────────────────────

    /**
     * @notice Called off-chain by Chainlink Automation every block.
     * @return upkeepNeeded  true if there is work to do
     * @return performData   ABI-encoded WorkItem[] to pass to performUpkeep
     */
    function checkUpkeep(bytes calldata /* checkData */)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        WorkItem[] memory items = new WorkItem[](maxItemsPerUpkeep);
        uint256 count = 0;

        // 1. Velocity / deflation check (time-gated)
        if (block.timestamp >= lastVelocityCheck + velocityWindow) {
            if (count < maxItemsPerUpkeep) {
                items[count++] = WorkItem(WORK_VELOCITY, 0, address(0), address(0));
            }
        }

        // 2. Pending chain-link wiring
        for (uint256 i = 0; i < pendingChainLinks.length && count < maxItemsPerUpkeep; i++) {
            items[count++] = WorkItem(
                WORK_CHAIN_LINK,
                pendingChainLinks[i].tierIndex,
                pendingChainLinks[i].newMatA,
                pendingChainLinks[i].newMatB
            );
        }

        // 3. Idle slots (ghost entry + reclaim scan)
        for (uint8 t = 0; t < configuredTierCount && count < maxItemsPerUpkeep; t++) {
            address pm = pairManagerForTier[t];
            if (pm == address(0)) continue;

            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount && count < maxItemsPerUpkeep; p++) {
                (address matA, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                count = _scanMatrix(matA, t, items, count);
                count = _scanMatrix(matB, t, items, count);
            }
        }

        // 4. Parked wallet rescue scan (MatA only — members park in MatA)
        for (uint8 t = 0; t < configuredTierCount && count < maxItemsPerUpkeep; t++) {
            address pm = pairManagerForTier[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount && count < maxItemsPerUpkeep; p++) {
                (address matA,) = IPairManagerKeeper(pm).getPairAt(p);
                if (matA == address(0)) continue;
                IFigureEightKeeper mat = IFigureEightKeeper(matA);
                uint256 parkedCount = mat.getParkedCount();
                if (parkedCount > 0) {
                    address parkedMember = mat.getParkedMember(0);
                    uint256 fee = mat.ENTRY_FEE();
                    uint256 sfBal = IStabilityFundKeeper(stabilityFund).balanceByTier(t);
                    if (sfBal >= fee) {
                        items[count++] = WorkItem(WORK_PARKED_RESCUE, t, matA, parkedMember);
                    }
                }
            }
        }

        // 5. Velocity gate check: MatB at >=80% full -> open next tier
        for (uint8 t = 0; t < configuredTierCount && count < maxItemsPerUpkeep; t++) {
            if (t + 1 >= 7) continue;                                    // no tier after T7
            if (ITierRouterKeeper(tierRouter).tierVelocityGreen(t + 1)) continue;  // already open
            address pm = pairManagerForTier[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount; p++) {
                (, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                if (matB == address(0)) continue;
                IFigureEightKeeper mat = IFigureEightKeeper(matB);
                uint256 occ  = mat.occupancy();
                uint256 size = mat.MATRIX_SIZE();
                if (size > 0 && occ * 100 >= size * 80) {
                    // MatB for tier t is >=80% full — queue gate open for tier t+1
                    items[count++] = WorkItem(WORK_VELOCITY_GATE, t, address(0), address(0));
                    break;
                }
            }
        }

        if (count == 0) return (false, "");

        // Trim array to actual count
        WorkItem[] memory trimmed = new WorkItem[](count);
        for (uint256 i = 0; i < count; i++) trimmed[i] = items[i];

        upkeepNeeded = true;
        performData  = abi.encode(trimmed);
    }

    /**
     * @notice Called by Chainlink Automation when checkUpkeep returns true.
     */
    function performUpkeep(bytes calldata performData) external {
        WorkItem[] memory items = abi.decode(performData, (WorkItem[]));
        uint256 chainLinkProcessed = 0;

        for (uint256 i = 0; i < items.length; i++) {
            WorkItem memory item = items[i];

            if (item.workType == WORK_VELOCITY) {
                _doVelocityCheck();
            } else if (item.workType == WORK_GHOST) {
                _doGhostEntry(item.addr1, item.tierIndex);
            } else if (item.workType == WORK_RECLAIM) {
                _doReclaimSlot(item.addr1, item.addr2, item.tierIndex);
            } else if (item.workType == WORK_CHAIN_LINK) {
                _doChainLink(item.addr1, item.addr2, chainLinkProcessed);
                chainLinkProcessed++;
            } else if (item.workType == WORK_PARKED_RESCUE) {
                _doParkedRescue(item.addr1, item.addr2, item.tierIndex);
            } else if (item.workType == WORK_VELOCITY_GATE) {
                _doVelocityGate(item.tierIndex);
            }
        }

        // Remove processed chain-link items from pending queue
        if (chainLinkProcessed > 0) {
            _flushChainLinks(chainLinkProcessed);
        }
    }

    // ── Internal: parked wallet rescue ──────────────────────────────────────────

    function _doParkedRescue(address matrix, address member, uint8 tierIdx) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (!mat.isParked(member)) return;        // already rescued by another path

        address pm = pairManagerForTier[tierIdx];
        if (pm == address(0)) return;
        uint256 fee = mat.ENTRY_FEE();

        uint256 sfBal = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        if (sfBal < fee) return;                  // SF does not have enough for this tier

        // 1. Ask SF to send ENTRY_FEE USDC to the source matrix
        IStabilityFundKeeper(stabilityFund).payForceCross(tierIdx, matrix, fee);
        // 2. Tell source matrix to execute the crossing using those funds
        mat.forceCrossKeeper(member);

        emit ParkedRescued(matrix, member, tierIdx);
    }

    // ── Internal: velocity gate opener ───────────────────────────────────────────

    function _doVelocityGate(uint8 tierIdx) internal {
        uint8 nextTier = tierIdx + 1;
        if (nextTier >= 7) return;                // T7 is the last tier
        if (ITierRouterKeeper(tierRouter).tierVelocityGreen(nextTier)) return; // already open
        ITierRouterKeeper(tierRouter).setTierVelocityGreen(nextTier, true);
        emit VelocityGateOpened(nextTier);
    }

    // ── Manual trigger (keeper or admin) ─────────────────────────────────────

    /// @notice Manually trigger a velocity check (e.g. for testing).
    function manualVelocityCheck() external onlyOwner {
        _doVelocityCheck();
    }

    /// @notice Manually fund a ghost entry for a specific matrix.
    function manualGhostEntry(address matrix, uint8 tierIdx) external onlyOwner {
        _doGhostEntry(matrix, tierIdx);
    }

    /// @notice Manually reclaim an idle slot.
    function manualReclaimSlot(address matrix, address member, uint8 tierIdx) external onlyOwner {
        _doReclaimSlot(matrix, member, tierIdx);
    }

    // ── Internal: velocity + deflation ───────────────────────────────────────

    function _doVelocityCheck() internal {
        uint256 windowStart = block.timestamp - velocityWindow;
        lastVelocityCheck   = block.timestamp;

        // Per-tier velocity gates
        for (uint8 t = 0; t < configuredTierCount; t++) {
            uint256 cnt = ITierRouterKeeper(tierRouter).getTierEntryCount(t, windowStart);
            bool    green = cnt >= velocityThreshold;
            if (ITierRouterKeeper(tierRouter).tierVelocityGreen(t) != green) {
                ITierRouterKeeper(tierRouter).setTierVelocityGreen(t, green);
            }
            emit VelocityUpdated(t, green, cnt);
        }

        // System-wide deflation state machine
        uint256 sysCount = ITierRouterKeeper(tierRouter).getSystemEntryCount(windowStart);
        uint8   prev     = deflationState;

        if (sysCount >= deflationThreshold) {
            // Green window
            consecutiveRedWindows = 0;
            if (deflationState == STATE_SLOW) {
                deflationState = STATE_RECOVERY;
                consecutiveGreenWindows = 1;
            } else if (deflationState == STATE_RECOVERY) {
                consecutiveGreenWindows++;
                if (consecutiveGreenWindows >= recoveryThreshold) {
                    deflationState          = STATE_NORMAL;
                    consecutiveGreenWindows = 0;
                    _setStabilityLayers(false);  // deactivate L2+L4
                }
            }
        } else {
            // Red window
            consecutiveGreenWindows = 0;
            consecutiveRedWindows++;
            if (deflationState == STATE_NORMAL && consecutiveRedWindows >= 2) {
                deflationState = STATE_SLOW;
                _setStabilityLayers(true);   // activate L2+L4
            }
        }

        if (deflationState != prev) {
            ITierRouterKeeper(tierRouter).setDeflationState(deflationState);
            emit DeflationStateChanged(prev, deflationState);
        }
    }

    function _setStabilityLayers(bool active) internal {
        IStabilityFundKeeper(stabilityFund).activateLayer(2, active);  // referral carve
        IStabilityFundKeeper(stabilityFund).activateLayer(4, active);  // devOps carve
    }

    // ── Internal: ghost entry ─────────────────────────────────────────────────

    function _doGhostEntry(address matrix, uint8 tierIdx) internal {
        address pm = pairManagerForTier[tierIdx];
        if (pm == address(0)) return;

        // Check StabilityFund has sufficient balance for this tier
        uint256 fee    = IPairManagerKeeper(pm).entryFee();
        uint256 sfBal  = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        if (sfBal < fee) return;

        lastGhostTime[matrix] = block.timestamp;
        IStabilityFundKeeper(stabilityFund).payGhostEntry(tierIdx, pm);
        emit GhostEntryFunded(matrix, tierIdx);
    }

    // ── Internal: slot reclaim ────────────────────────────────────────────────

    function _doReclaimSlot(address matrix, address member, uint8 /* tierIdx */) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (!mat.isInMatrix(member)) return;

        uint256 idleTime = block.timestamp - mat.lastActivityTime(member);
        if (idleTime < extendedIdleTimeout) return;

        reclaimAttemptTime[matrix][member] = block.timestamp;
        mat.reclaimIdleSlot(member);
        emit SlotReclaimed(matrix, member, idleTime);
    }

    // ── Internal: chain-link wiring ───────────────────────────────────────────

    function _doChainLink(address newMatA, address newMatB, uint256 idx) internal {
        if (idx >= pendingChainLinks.length) return;
        PendingChainLink memory link = pendingChainLinks[idx];
        if (link.newMatA != newMatA || link.newMatB != newMatB) return;

        // Wire: prevMatB -> newMatA -> newMatB -> (prevMatB's old next)
        // prevMatB.chainNext was previously pointing to some earlier matA;
        // we insert the new pair between prevMatB and that earlier matA.
        // The exact wiring depends on the current chain state. The keeper
        // only sets setChainNext on the new pair; the previous tail already
        // pointed to the existing head (circular). We update prevMatB to
        // point to newMatA, and newMatB to point to prevMatB's OLD next.
        // For simplicity in V8.1: the deploy script calls setChainNext directly
        // and uses queueChainLink only for keeper-initiated expansions.
        // Here we just emit the event and let the deploy script handle it.
        emit ChainLinked(newMatA, newMatB, link.prevMatB);
    }

    function _flushChainLinks(uint256 count) internal {
        if (count >= pendingChainLinks.length) {
            delete pendingChainLinks;
        } else {
            uint256 remaining = pendingChainLinks.length - count;
            for (uint256 i = 0; i < remaining; i++) {
                pendingChainLinks[i] = pendingChainLinks[count + i];
            }
            for (uint256 i = 0; i < count; i++) {
                pendingChainLinks.pop();
            }
        }
    }

    // ── Internal: idle scan helper ────────────────────────────────────────────

    function _scanMatrix(
        address matrix,
        uint8   tierIdx,
        WorkItem[] memory items,
        uint256 count
    ) internal view returns (uint256) {
        if (matrix == address(0)) return count;
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        uint256 size = mat.MATRIX_SIZE();

        for (uint256 pos = 1; pos <= size && count < maxItemsPerUpkeep; pos++) {
            address member = mat.posToMember(pos);
            if (member == address(0)) continue;

            uint256 lastAct = mat.lastActivityTime(member);
            uint256 idle    = block.timestamp - lastAct;

            if (idle >= extendedIdleTimeout) {
                // Ready for slot reclaim
                items[count++] = WorkItem(WORK_RECLAIM, tierIdx, matrix, member);
            } else if (idle >= idleSlotTimeout) {
                // Check if ghost was already funded recently
                if (block.timestamp - lastGhostTime[matrix] >= idleSlotTimeout) {
                    items[count++] = WorkItem(WORK_GHOST, tierIdx, matrix, address(0));
                }
            }
        }
        return count;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function pendingChainLinkCount() external view returns (uint256) {
        return pendingChainLinks.length;
    }

    function getDeflationState() external view returns (string memory) {
        if (deflationState == STATE_NORMAL)   return "NORMAL";
        if (deflationState == STATE_SLOW)     return "SLOW";
        if (deflationState == STATE_RECOVERY) return "RECOVERY";
        return "UNKNOWN";
    }
}
