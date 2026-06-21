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
    function payForceCross(uint8 tierIdx, address sourceMatrix, uint256 fee) external;
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
    function forceCrossKeeper(address member, uint256 sfContribution) external;
    function parkedAt(address member) external view returns (uint256);
    function evictParked(address member) external;
    function getMemberTotalWithdrawn(address member) external view returns (uint256);
    function withdrawableOf(address member) external view returns (uint256);
    function isMatrixA() external view returns (bool);
    function ENTRY_FEE() external view returns (uint256);
}

interface ICommunityWalletKeeper {
    function distributeReady() external view returns (bool);
    function distribute() external;
}

interface IPairManagerKeeper {
    function currentMatA() external view returns (address);
    function currentMatB() external view returns (address);
    function activePairCount() external view returns (uint256);
    function getPairAt(uint256 idx) external view returns (address matA, address matB);
    function entryFee() external view returns (uint256);
}

// -- MatrixKeeper -------------------------------------------------------------

contract MatrixKeeper is Ownable {

    uint8 public constant STATE_NORMAL   = 0;
    uint8 public constant STATE_SLOW     = 1;
    uint8 public constant STATE_RECOVERY = 2;

    uint8 public constant WORK_VELOCITY      = 0;
    uint8 public constant WORK_GHOST         = 1;
    uint8 public constant WORK_RECLAIM       = 2;
    uint8 public constant WORK_CHAIN_LINK    = 3;
    uint8 public constant WORK_PARKED_RESCUE = 4;
    uint8 public constant WORK_VELOCITY_GATE = 5;
    uint8 public constant WORK_EVICT_PARKED  = 6;
    uint8 public constant WORK_DISTRIBUTE_CW = 7;

    uint256 public velocityWindow      = 3_600;
    uint256 public velocityThreshold   = 3;
    uint256 public deflationThreshold  = 10;
    uint256 public recoveryThreshold   = 3;
    uint256 public idleSlotTimeout     = 43_200;
    uint256 public extendedIdleTimeout = 86_400;
    uint256 public maxItemsPerUpkeep   = 15;
    uint256 public parkedGracePeriod   = 10 days;
    uint256 public rescueRatioBps      = 7_000;

    address public tierRouter;
    address public stabilityFund;
    address public communityWallet;
    /// @notice V8.20: DAO governance contract. Co-governs the params below
    ///         alongside owner -- neither replaces the other (owner keeps emergency backstop).
    address public governance;

    /// @notice V8.20: SF parked-rescue coverage ladder, governable.
    ///         thresholds[i] = withdrawable/entryFee bps breakpoint (descending).
    ///         bpsLadder[i]  = SF coverage bps at that breakpoint (ascending).
    ///         Below the lowest threshold => ineligible for rescue (evict instead).
    ///         Defaults reproduce the exact V8.18 hardcoded ladder.
    uint256[] public sfRescueThresholds = [
        uint256(10_000), 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_000, 4_000
    ];
    uint256[] public sfRescueBpsLadder = [
        uint256(0), 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000
    ];

    uint8   public deflationState;
    uint256 public lastVelocityCheck;
    uint256 public consecutiveGreenWindows;
    uint256 public consecutiveRedWindows;

    mapping(uint8 => address) public pairManagerForTier;
    uint8 public configuredTierCount;

    mapping(address => uint256) public lastGhostTime;
    mapping(address => mapping(address => uint256)) public reclaimAttemptTime;

    struct PendingChainLink {
        address newMatA;
        address newMatB;
        address prevMatB;
        uint8   tierIndex;
    }
    PendingChainLink[] public pendingChainLinks;

    event VelocityUpdated(uint8 indexed tier, bool green, uint256 entryCount);
    event DeflationStateChanged(uint8 from, uint8 to);
    event GhostEntryFunded(address indexed matrix, uint8 tierIndex);
    event SlotReclaimed(address indexed matrix, address indexed member, uint256 idleSeconds);
    event ChainLinked(address newMatA, address newMatB, address prevMatB);
    event PairManagerSet(uint8 indexed tierIndex, address pairManager);
    event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex);
    event VelocityGateOpened(uint8 indexed forTierIndex);
    event ParkedMemberEvicted(address indexed matrix, address indexed member, uint256 totalWithdrawn);
    event ConfigUpdated(string indexed param, uint256 value);
    event CommunityDistributed(address indexed cw);
    event WorkItemFailed(uint8 indexed workType, uint8 tierIndex, address addr1, address addr2);
    event GovernanceSet(address indexed governance);
    event SfRescueLadderUpdated(uint256 rungs, uint256 deepestBps);

    error MK_NotKeeper();
    error MK_InvalidParam();
    error MK_ZeroAddress();

    struct WorkItem {
        uint8   workType;
        uint8   tierIndex;
        address addr1;
        address addr2;
    }

    constructor(address _tierRouter, address _stabilityFund) Ownable(msg.sender) {
        if (_tierRouter    == address(0)) revert MK_ZeroAddress();
        if (_stabilityFund == address(0)) revert MK_ZeroAddress();
        tierRouter    = _tierRouter;
        stabilityFund = _stabilityFund;
        lastVelocityCheck = block.timestamp;
    }

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "MK: not authorized");
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        if (_gov == address(0)) revert MK_ZeroAddress();
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    function setPairManager(uint8 tierIndex, address pm) external onlyOwner {
        if (pm == address(0)) revert MK_ZeroAddress();
        if (pairManagerForTier[tierIndex] == address(0)) configuredTierCount++;
        pairManagerForTier[tierIndex] = pm;
        emit PairManagerSet(tierIndex, pm);
    }

    function queueChainLink(address newMatA, address newMatB, address prevMatB, uint8 tierIdx)
        external onlyOwner
    {
        pendingChainLinks.push(PendingChainLink(newMatA, newMatB, prevMatB, tierIdx));
    }

    function setVelocityWindow(uint256 v) external onlyOwnerOrGovernance {
        require(v == 1800 || v == 3600 || v == 7200 || v == 14400, "MK: invalid window");
        velocityWindow = v;
    }
    function setVelocityThreshold(uint256 v) external onlyOwnerOrGovernance {
        require(v == 1 || v == 2 || v == 3 || v == 5, "MK: invalid threshold");
        velocityThreshold = v;
    }
    function setDeflationThreshold(uint256 v) external onlyOwnerOrGovernance {
        require(v == 5 || v == 10 || v == 15 || v == 20, "MK: invalid deflation threshold");
        deflationThreshold = v;
    }
    function setIdleSlotTimeout(uint256 v) external onlyOwnerOrGovernance {
        require(v == 21600 || v == 43200 || v == 86400, "MK: invalid idle timeout");
        idleSlotTimeout = v;
    }
    function setMaxItemsPerUpkeep(uint256 v) external onlyOwnerOrGovernance {
        require(v == 5 || v == 10 || v == 15 || v == 20, "MK: invalid max items");
        maxItemsPerUpkeep = v;
    }
    /// @notice V8.20: DAO-governable.
    function setParkedGracePeriod(uint256 v) external onlyOwnerOrGovernance {
        require(
            v == 0 || v == 3_600 || v == 21_600 ||
            v == 5 days || v == 10 days || v == 15 days,
            "MK: invalid grace period"
        );
        parkedGracePeriod = v;
        emit ConfigUpdated("parkedGracePeriod", v);
    }
    /// @notice V8.20: DAO-governable. Allowed: 5000,6000,7000,8000,9000,9500.
    function setRescueRatioBps(uint256 v) external onlyOwnerOrGovernance {
        require(
            v == 5_000 || v == 6_000 || v == 7_000 ||
            v == 8_000 || v == 9_000 || v == 9_500,
            "MK: invalid ratio"
        );
        rescueRatioBps = v;
        emit ConfigUpdated("rescueRatioBps", v);
    }
    function setCommunityWallet(address _cw) external onlyOwner {
        communityWallet = _cw;
        emit ConfigUpdated("communityWallet", uint256(uint160(_cw)));
    }

    /// @notice V8.20: Replace the SF parked-rescue coverage ladder.
    ///         thresholds must start at 10_000 (full withdrawable => 0 rescue) and
    ///         strictly descend; bpsValues must start at 0 and strictly ascend, capped at 10_000.
    ///         Below the lowest threshold a parked member is ineligible (evicted instead).
    function setSfRescueLadder(uint256[] calldata thresholds, uint256[] calldata bpsValues)
        external onlyOwnerOrGovernance
    {
        uint256 rungs = thresholds.length;
        require(rungs >= 2 && rungs <= 20,        "MK: bad ladder length");
        require(bpsValues.length == rungs,         "MK: length mismatch");
        require(thresholds[0] == 10_000,           "MK: first threshold must be 10000");
        require(bpsValues[0] == 0,                 "MK: first bps must be 0");
        for (uint256 i = 1; i < rungs; i++) {
            require(thresholds[i] < thresholds[i - 1], "MK: thresholds must descend");
            require(bpsValues[i] > bpsValues[i - 1],   "MK: bps must ascend");
            require(bpsValues[i] <= 10_000,            "MK: bps too high");
        }
        delete sfRescueThresholds;
        delete sfRescueBpsLadder;
        for (uint256 i = 0; i < rungs; i++) {
            sfRescueThresholds.push(thresholds[i]);
            sfRescueBpsLadder.push(bpsValues[i]);
        }
        emit SfRescueLadderUpdated(rungs, bpsValues[rungs - 1]);
    }

    function checkUpkeep(bytes calldata)
        external view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        WorkItem[] memory items = new WorkItem[](maxItemsPerUpkeep);
        uint256 count = 0;

        if (block.timestamp >= lastVelocityCheck + velocityWindow) {
            if (count < maxItemsPerUpkeep)
                items[count++] = WorkItem(WORK_VELOCITY, 0, address(0), address(0));
        }

        for (uint256 i = 0; i < pendingChainLinks.length && count < maxItemsPerUpkeep; i++) {
            items[count++] = WorkItem(
                WORK_CHAIN_LINK,
                pendingChainLinks[i].tierIndex,
                pendingChainLinks[i].newMatA,
                pendingChainLinks[i].newMatB
            );
        }

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

        for (uint8 t = 0; t < configuredTierCount && count < maxItemsPerUpkeep; t++) {
            address pm = pairManagerForTier[t];
            if (pm == address(0)) continue;
            uint256 pairCount = IPairManagerKeeper(pm).activePairCount();
            for (uint256 p = 0; p < pairCount && count < maxItemsPerUpkeep; p++) {
                (address matA, address matB) = IPairManagerKeeper(pm).getPairAt(p);
                if (matA != address(0)) {
                    uint256 pc = IFigureEightKeeper(matA).getParkedCount();
                    for (uint256 idx = 0; idx < pc && count < maxItemsPerUpkeep; idx++) {
                        (address member, uint8 wt) = _checkParked(matA, t, idx);
                        if (wt != type(uint8).max) items[count++] = WorkItem(wt, t, matA, member);
                    }
                }
                if (matB != address(0)) {
                    uint256 pc = IFigureEightKeeper(matB).getParkedCount();
                    for (uint256 idx = 0; idx < pc && count < maxItemsPerUpkeep; idx++) {
                        (address member, uint8 wt) = _checkParked(matB, t, idx);
                        if (wt != type(uint8).max) items[count++] = WorkItem(wt, t, matB, member);
                    }
                }
            }
        }

        for (uint8 t = 0; t < configuredTierCount && count < maxItemsPerUpkeep; t++) {
            if (t + 1 >= 10) continue;
            if (ITierRouterKeeper(tierRouter).tierVelocityGreen(t + 1)) continue;
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
                    items[count++] = WorkItem(WORK_VELOCITY_GATE, t, address(0), address(0));
                    break;
                }
            }
        }

        if (communityWallet != address(0) && count < maxItemsPerUpkeep) {
            if (ICommunityWalletKeeper(communityWallet).distributeReady())
                items[count++] = WorkItem(WORK_DISTRIBUTE_CW, 0, communityWallet, address(0));
        }

        if (count == 0) return (false, "");
        WorkItem[] memory trimmed = new WorkItem[](count);
        for (uint256 i = 0; i < count; i++) trimmed[i] = items[i];
        upkeepNeeded = true;
        performData  = abi.encode(trimmed);
    }

    /**
     * @notice V8.17: try/catch per work item so one failure never blocks the loop.
     */
    function performUpkeep(bytes calldata performData) external {
        WorkItem[] memory items = abi.decode(performData, (WorkItem[]));
        uint256 chainLinkProcessed = 0;
        for (uint256 i = 0; i < items.length; i++) {
            WorkItem memory item = items[i];
            if (item.workType == WORK_VELOCITY) {
                try this._doVelocityCheckExternal() {}
                catch { emit WorkItemFailed(WORK_VELOCITY, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_GHOST) {
                try this._doGhostEntryExternal(item.addr1, item.tierIndex) {}
                catch { emit WorkItemFailed(WORK_GHOST, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_RECLAIM) {
                try this._doReclaimSlotExternal(item.addr1, item.addr2, item.tierIndex) {}
                catch { emit WorkItemFailed(WORK_RECLAIM, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_CHAIN_LINK) {
                try this._doChainLinkExternal(item.addr1, item.addr2, chainLinkProcessed) {}
                catch { emit WorkItemFailed(WORK_CHAIN_LINK, item.tierIndex, item.addr1, item.addr2); }
                chainLinkProcessed++;
            } else if (item.workType == WORK_PARKED_RESCUE) {
                // V8.18: only swallow expected "already done" strings; unexpected reverts bubble up
                try this._doParkedRescueExternal(item.addr1, item.addr2, item.tierIndex) {}
                catch Error(string memory reason) {
                    bytes32 h = keccak256(bytes(reason));
                    if (h == keccak256("F8V8: already in matrix") || h == keccak256("F8V8: not parked") ||
                        h == keccak256("F8V8: still in matrix")) {
                        emit WorkItemFailed(WORK_PARKED_RESCUE, item.tierIndex, item.addr1, item.addr2);
                    } else {
                        revert(reason);
                    }
                }
                catch { emit WorkItemFailed(WORK_PARKED_RESCUE, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_EVICT_PARKED) {
                try this._doEvictParkedExternal(item.addr1, item.addr2) {}
                catch { emit WorkItemFailed(WORK_EVICT_PARKED, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_VELOCITY_GATE) {
                try this._doVelocityGateExternal(item.tierIndex) {}
                catch { emit WorkItemFailed(WORK_VELOCITY_GATE, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_DISTRIBUTE_CW) {
                _doDistributeCW(item.addr1);
            }
        }
        if (chainLinkProcessed > 0) _flushChainLinks(chainLinkProcessed);
    }

    modifier onlySelf() {
        require(msg.sender == address(this), "MK: only self");
        _;
    }

    function _doVelocityCheckExternal()                                        external onlySelf { _doVelocityCheck(); }
    function _doGhostEntryExternal(address m, uint8 t)                        external onlySelf { _doGhostEntry(m, t); }
    function _doReclaimSlotExternal(address m, address mb, uint8 t)           external onlySelf { _doReclaimSlot(m, mb, t); }
    function _doChainLinkExternal(address a, address b, uint256 idx)          external onlySelf { _doChainLink(a, b, idx); }
    function _doParkedRescueExternal(address matrix, address member, uint8 t) external onlySelf { _doParkedRescue(matrix, member, t); }
    function _doEvictParkedExternal(address matrix, address member)           external onlySelf { _doEvictParked(matrix, member); }
    function _doVelocityGateExternal(uint8 t)                                 external onlySelf { _doVelocityGate(t); }

    function _doParkedRescue(address matrix, address member, uint8 tierIdx) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (!mat.isParked(member)) return;
        uint256 fee          = mat.ENTRY_FEE();
        uint256 withdrawable = mat.withdrawableOf(member);
        uint256 sfBps = _sfRescueBps(withdrawable, fee);
        if (sfBps == type(uint256).max) return;
        uint256 sfShare = fee * sfBps / 10_000;
        uint256 sfBal   = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        if (sfBal < sfShare) return;
        if (sfShare > 0) IStabilityFundKeeper(stabilityFund).payForceCross(tierIdx, matrix, sfShare);
        mat.forceCrossKeeper(member, sfShare);
        emit ParkedRescued(matrix, member, tierIdx);
    }

    function _doEvictParked(address matrix, address member) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (mat.parkedAt(member) == 0) return;
        uint256 withdrawn = mat.getMemberTotalWithdrawn(member);
        mat.evictParked(member);
        emit ParkedMemberEvicted(matrix, member, withdrawn);
    }

    function _doDistributeCW(address cw) internal {
        try ICommunityWalletKeeper(cw).distribute() {
            emit CommunityDistributed(cw);
        } catch {}
    }

    function _doVelocityGate(uint8 tierIdx) internal {
        uint8 nextTier = tierIdx + 1;
        if (nextTier >= 10) return;
        if (ITierRouterKeeper(tierRouter).tierVelocityGreen(nextTier)) return;
        ITierRouterKeeper(tierRouter).setTierVelocityGreen(nextTier, true);
        emit VelocityGateOpened(nextTier);
    }

    function manualVelocityCheck() external onlyOwner { _doVelocityCheck(); }
    function manualGhostEntry(address matrix, uint8 tierIdx) external onlyOwner { _doGhostEntry(matrix, tierIdx); }
    function manualReclaimSlot(address matrix, address member, uint8 tierIdx) external onlyOwner { _doReclaimSlot(matrix, member, tierIdx); }

    function _doVelocityCheck() internal {
        uint256 windowStart = block.timestamp - velocityWindow;
        lastVelocityCheck   = block.timestamp;
        for (uint8 t = 0; t < configuredTierCount; t++) {
            uint256 cnt   = ITierRouterKeeper(tierRouter).getTierEntryCount(t, windowStart);
            bool    green = cnt >= velocityThreshold;
            if (ITierRouterKeeper(tierRouter).tierVelocityGreen(t) != green)
                ITierRouterKeeper(tierRouter).setTierVelocityGreen(t, green);
            emit VelocityUpdated(t, green, cnt);
        }
        uint256 sysCount = ITierRouterKeeper(tierRouter).getSystemEntryCount(windowStart);
        uint8   prev     = deflationState;
        if (sysCount >= deflationThreshold) {
            consecutiveRedWindows = 0;
            if (deflationState == STATE_SLOW) {
                deflationState = STATE_RECOVERY;
                consecutiveGreenWindows = 1;
            } else if (deflationState == STATE_RECOVERY) {
                consecutiveGreenWindows++;
                if (consecutiveGreenWindows >= recoveryThreshold) {
                    deflationState = STATE_NORMAL;
                    consecutiveGreenWindows = 0;
                    _setStabilityLayers(false);
                }
            }
        } else {
            consecutiveGreenWindows = 0;
            consecutiveRedWindows++;
            if (deflationState == STATE_NORMAL && consecutiveRedWindows >= 2) {
                deflationState = STATE_SLOW;
                _setStabilityLayers(true);
            }
        }
        if (deflationState != prev) {
            ITierRouterKeeper(tierRouter).setDeflationState(deflationState);
            emit DeflationStateChanged(prev, deflationState);
        }
    }

    function _setStabilityLayers(bool active) internal {
        IStabilityFundKeeper(stabilityFund).activateLayer(2, active);
        IStabilityFundKeeper(stabilityFund).activateLayer(4, active);
    }

    function _doGhostEntry(address matrix, uint8 tierIdx) internal {
        address pm = pairManagerForTier[tierIdx];
        if (pm == address(0)) return;
        uint256 fee   = IPairManagerKeeper(pm).entryFee();
        uint256 sfBal = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        if (sfBal < fee) return;
        lastGhostTime[matrix] = block.timestamp;
        IStabilityFundKeeper(stabilityFund).payGhostEntry(tierIdx, pm);
        emit GhostEntryFunded(matrix, tierIdx);
    }

    function _doReclaimSlot(address matrix, address member, uint8) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (!mat.isInMatrix(member)) return;
        uint256 idleTime = block.timestamp - mat.lastActivityTime(member);
        if (idleTime < extendedIdleTimeout) return;
        reclaimAttemptTime[matrix][member] = block.timestamp;
        mat.reclaimIdleSlot(member);
        emit SlotReclaimed(matrix, member, idleTime);
    }

    function _doChainLink(address newMatA, address newMatB, uint256 idx) internal {
        if (idx >= pendingChainLinks.length) return;
        PendingChainLink memory link = pendingChainLinks[idx];
        if (link.newMatA != newMatA || link.newMatB != newMatB) return;
        emit ChainLinked(newMatA, newMatB, link.prevMatB);
    }

    function _flushChainLinks(uint256 count) internal {
        if (count >= pendingChainLinks.length) {
            delete pendingChainLinks;
        } else {
            uint256 remaining = pendingChainLinks.length - count;
            for (uint256 i = 0; i < remaining; i++)
                pendingChainLinks[i] = pendingChainLinks[count + i];
            for (uint256 i = 0; i < count; i++)
                pendingChainLinks.pop();
        }
    }

    /// @notice V8.20: ladder is now governable storage (see sfRescueThresholds/sfRescueBpsLadder)
    ///         instead of hardcoded breakpoints. Behavior is identical to V8.18 by default.
    function _sfRescueBps(uint256 withdrawable, uint256 entryFee)
        internal view returns (uint256)
    {
        uint256 wBps = withdrawable * 10_000 / entryFee;
        uint256 n = sfRescueThresholds.length;
        for (uint256 i = 0; i < n; i++) {
            if (wBps >= sfRescueThresholds[i]) return sfRescueBpsLadder[i];
        }
        return type(uint256).max;
    }

    function _checkParked(address matAddr, uint8 tierIdx, uint256 idx)
        internal view
        returns (address parkedMember, uint8 workType)
    {
        IFigureEightKeeper mat = IFigureEightKeeper(matAddr);
        if (mat.getParkedCount() <= idx) return (address(0), type(uint8).max);
        parkedMember = mat.getParkedMember(idx);
        uint256 ts = mat.parkedAt(parkedMember);
        if (ts == 0) return (address(0), type(uint8).max);
        if (block.timestamp - ts < parkedGracePeriod) return (address(0), type(uint8).max);
        uint256 withdrawn    = mat.getMemberTotalWithdrawn(parkedMember);
        uint256 withdrawable = mat.withdrawableOf(parkedMember);
        uint256 fee          = mat.ENTRY_FEE();
        uint256 totalEarned  = withdrawn + withdrawable;
        uint256 withdrawRatio = totalEarned > 0 ? withdrawn * 10_000 / totalEarned : 0;
        if (withdrawRatio > rescueRatioBps) return (parkedMember, WORK_EVICT_PARKED);
        uint256 sfBps = _sfRescueBps(withdrawable, fee);
        if (sfBps == type(uint256).max) return (parkedMember, WORK_EVICT_PARKED);
        uint256 sfShare = fee * sfBps / 10_000;
        uint256 sfBal   = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        workType = (sfBal >= sfShare) ? WORK_PARKED_RESCUE : type(uint8).max;
    }

    function _scanMatrix(address matrix, uint8 tierIdx, WorkItem[] memory items, uint256 count)
        internal view returns (uint256)
    {
        if (matrix == address(0)) return count;
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        uint256 size = mat.MATRIX_SIZE();
        for (uint256 pos = 1; pos <= size && count < maxItemsPerUpkeep; pos++) {
            address member = mat.posToMember(pos);
            if (member == address(0)) continue;
            uint256 idle = block.timestamp - mat.lastActivityTime(member);
            if (idle >= extendedIdleTimeout) {
                items[count++] = WorkItem(WORK_RECLAIM, tierIdx, matrix, member);
            } else if (idle >= idleSlotTimeout) {
                if (block.timestamp - lastGhostTime[matrix] >= idleSlotTimeout)
                    items[count++] = WorkItem(WORK_GHOST, tierIdx, matrix, address(0));
            }
        }
        return count;
    }

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
