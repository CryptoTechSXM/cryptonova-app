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
    function totalBalance() external view returns (uint256);
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

    /// @notice Fraction of each pool distribution share redirected to SF for gradual debt repayment.
    ///         Must match MatrixLogicLib.RESCUE_REPAY_BPS.
    ///         V8.31: raised from 15% (1500) → 50% (5000).
    ///         Clears rescue debt ~3× faster (6 cycles vs 18 at T1) while member still earns CNOVA.
    ///         Passive members earn CNOVA mining rewards; USDC is the active-recruiter bonus.
    uint256 public constant RESCUE_REPAY_BPS = 5_000;

    /// @notice V8.31: 50/5/45 model constants (must mirror MatrixLogicLib).
    ///         50% of each entry fee is pre-funded as a crossing reserve in the member struct.
    ///          5% is credited as instant direct earnings.
    ///         45% (= payBase) is distributed via the BPS array.
    uint256 public constant CROSSING_RESERVE_BPS = 5_000;  // 50%
    uint256 public constant DIRECT_EARN_BPS      =   500;  // 5%

    /// @notice Effective pool income as a BPS fraction of the full entry fee.
    ///         pool income per entry = payBase × splitPoolBps / 10_000
    ///                               = (entryFee × 4500/10_000) × (4000/10_000)
    ///                               = entryFee × 1800 / 10_000
    uint256 public constant POOL_BPS = 1_800;

    /// @notice Pre-computed BPS fraction of the entry fee to advance as a crossing buffer.
    ///         After a keeper rescue, the member enters a new matrix and receives:
    ///           crossingReserve = entryFee × 50%    (pre-funded by new matrix entry)
    ///           direct earn     = entryFee × 5%     (instant withdrawable)
    ///           crossingBuffer  = advanced by SF     (so member can cross after ~1 pool cycle)
    ///
    ///         For the NEXT crossing, member needs entryFee − crossingReserve from withdrawable:
    ///           need = entryFee × (1 − CROSSING_RESERVE_BPS/10_000)
    ///                = entryFee × 5000/10_000  = 50%
    ///         Member already has directEarn + one pool cycle after RESCUE_REPAY_BPS deduction:
    ///           directEarn         = entryFee × 500/10_000  = 5%
    ///           poolCycle (net)    = entryFee × POOL_BPS/10_000 × (1 − RESCUE_REPAY_BPS/10_000)
    ///                             = entryFee × 1800/10_000 × 5000/10_000 = 9%
    ///         Buffer needed = 50% − 5% − 9% = 36% = 3_600 bps
    uint256 public constant CROSSING_BUFFER_BPS = 3_600;

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
    uint256 public idleSlotTimeout     = 259_200;   // V8.33: 3 days (was 43200 = 12h)
    uint256 public extendedIdleTimeout = 604_800;   // V8.33: 7 days (was 86400 = 24h)
    uint256 public maxItemsPerUpkeep   = 15;
    uint256 public parkedGracePeriod   = 6 hours;  // V8.25: mainnet default 6h; testnet owner can set as low as 5 min
    uint256 public rescueRatioBps      = 7_000;
    /// @notice V8.33: Ghost entries are disabled by default.  Ghost entries drain the SF to
    ///         fill empty slots with fake positions.  At launch, empty slots should fill with
    ///         real members.  DAO can flip on if the matrix genuinely stalls.
    bool    public ghostEntryEnabled   = false;

    address public tierRouter;
    address public stabilityFund;
    address public communityWallet;
    /// @notice V8.20: DAO governance contract. Co-governs the params below
    ///         alongside owner -- neither replaces the other (owner keeps emergency backstop).
    address public governance;

    /// @notice V8.20/V8.21: SF parked-rescue coverage ladder, governable.
    ///         thresholds[i] = withdrawable/entryFee bps breakpoint (descending).
    ///         bpsLadder[i]  = SF coverage bps at that breakpoint (ascending).
    ///         Below the lowest threshold => ineligible for rescue (evict instead).
    ///         V8.21: free-form custom arrays were removed -- the DAO now picks
    ///         one of 4 curated presets via setSfRescueLadderPreset() instead of
    ///         designing a ladder from scratch. Defaults reproduce the exact
    ///         V8.18 hardcoded ladder (preset 1, "Default").
    uint256[] public sfRescueThresholds = [
        uint256(10_000), 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_000, 4_000
    ];
    uint256[] public sfRescueBpsLadder = [
        uint256(0), 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000
    ];
    /// @notice Which preset is currently active. 0=Conservative, 1=Default,
    ///         2=Generous, 3=Maximum. See setSfRescueLadderPreset() for the
    ///         exact numbers in each.
    uint8 public sfRescueLadderPreset = 1;

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
    /// @dev V8.21: replaces SfRescueLadderUpdated -- presets, not free-form arrays.
    event SfRescueLadderPresetSet(uint8 preset, uint256 rungs, uint256 deepestBps);

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
        // V8.33: expanded range — 6h, 12h, 24h, 3d, 7d
        require(v == 21600 || v == 43200 || v == 86400 || v == 3 days || v == 7 days, "MK: invalid idle timeout");
        idleSlotTimeout = v;
        emit ConfigUpdated("idleSlotTimeout", v);
    }
    /// @notice V8.33: DAO-governable reclaim window (1 day – 90 days).
    function setExtendedIdleTimeout(uint256 v) external onlyOwnerOrGovernance {
        require(v >= 1 days && v <= 90 days, "MK: out of range (1d-90d)");
        extendedIdleTimeout = v;
        emit ConfigUpdated("extendedIdleTimeout", v);
    }
    /// @notice V8.33: Toggle ghost entries on/off.  Off by default — preserves SF for rescues.
    function setGhostEntryEnabled(bool v) external onlyOwnerOrGovernance {
        ghostEntryEnabled = v;
        emit ConfigUpdated("ghostEntryEnabled", v ? 1 : 0);
    }
    function setMaxItemsPerUpkeep(uint256 v) external onlyOwnerOrGovernance {
        // V8.31: ceiling raised to 40 to handle 10 tiers × 2 matrices at scale
        require(v == 5 || v == 10 || v == 15 || v == 20 || v == 30 || v == 40, "MK: invalid max items");
        maxItemsPerUpkeep = v;
    }
    /// @notice V8.20: DAO-governable.
    /// @dev V8.25: changed from enum check to range. 0 = no grace period (testing/admin override).
    ///      Non-zero values must be between 5 minutes and 30 days.
    ///      Mainnet recommendation: 6 hours (21600). Testnet: 0 or 5-10 minutes.
    function setParkedGracePeriod(uint256 v) external onlyOwnerOrGovernance {
        require(v == 0 || (v >= 5 minutes && v <= 30 days), "MK: grace period out of range (0 or 5min-30d)");
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

    /// @notice V8.21: Pick one of 4 curated SF parked-rescue coverage ladders.
    ///         Replaces the old free-form custom-array proposal -- the community
    ///         picks a shape, it doesn't design one from scratch.
    ///         0 = Conservative: floor at 50% withdrawn, coverage caps at 50%.
    ///             [10000,9000,8000,7000,6000,5000] -> [0,1000,2000,3000,4000,5000]
    ///         1 = Default: the original V8.18 ladder. Floor 40%, caps at 60%.
    ///             [10000,9500,9000,8500,8000,7500,7000,6500,6000,5000,4000]
    ///             -> [0,1000,1500,2000,2500,3000,3500,4000,4500,5000,6000]
    ///         2 = Generous: floor at 30% withdrawn, coverage caps at 80%.
    ///             [10000,9000,8000,7000,6000,5000,4000,3000] -> [0,1500,2500,3500,4500,5500,7000,8000]
    ///         3 = Maximum: floor at 10% withdrawn, coverage can reach 100%.
    ///             [10000,9000,8000,7000,6000,5000,4000,3000,2000,1000]
    ///             -> [0,1500,2500,3500,5000,6000,7000,8000,9000,10000]
    /// @dev Takes uint256 (not uint8) so it matches the generic uint256-value
    ///      dispatch every other governance setter in this codebase uses.
    function setSfRescueLadderPreset(uint256 preset) external onlyOwnerOrGovernance {
        require(preset <= 3, "MK: invalid preset (0-3)");
        sfRescueLadderPreset = uint8(preset);
        _applyLadderPreset(uint8(preset));
    }

    function _applyLadderPreset(uint8 preset) internal {
        delete sfRescueThresholds;
        delete sfRescueBpsLadder;

        if (preset == 0) {
            uint256[6] memory t = [uint256(10_000), 9_000, 8_000, 7_000, 6_000, 5_000];
            uint256[6] memory b = [uint256(0), 1_000, 2_000, 3_000, 4_000, 5_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        } else if (preset == 1) {
            uint256[11] memory t = [uint256(10_000), 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_000, 4_000];
            uint256[11] memory b = [uint256(0), 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        } else if (preset == 2) {
            uint256[8] memory t = [uint256(10_000), 9_000, 8_000, 7_000, 6_000, 5_000, 4_000, 3_000];
            uint256[8] memory b = [uint256(0), 1_500, 2_500, 3_500, 4_500, 5_500, 7_000, 8_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        } else {
            uint256[10] memory t = [uint256(10_000), 9_000, 8_000, 7_000, 6_000, 5_000, 4_000, 3_000, 2_000, 1_000];
            uint256[10] memory b = [uint256(0), 1_500, 2_500, 3_500, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        }

        emit SfRescueLadderPresetSet(preset, sfRescueThresholds.length, sfRescueBpsLadder[sfRescueBpsLadder.length - 1]);
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
                // V8.18: only swallow expected "already done" strings; unexpected reverts bubble up.
                // V8.24: added "insufficient withdrawable for rescue" -- member cannot cover their
                //        share under the SF rescue ladder; skip them so the rest of the batch runs.
                //        This is what makes the ladder self-sustaining without SF top-ups.
                try this._doParkedRescueExternal(item.addr1, item.addr2, item.tierIndex) {}
                catch Error(string memory reason) {
                    bytes32 h = keccak256(bytes(reason));
                    if (h == keccak256("F8V8: already in matrix") || h == keccak256("F8V8: not parked") ||
                        h == keccak256("F8V8: still in matrix") ||
                        h == keccak256("F8V8: insufficient withdrawable for rescue")) {
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

        // Declare outputs before the scoped block so they survive into the SF-call section.
        // The block frees fee/withdrawable/reserve/effectiveContrib/sfBps/maxShortfall from
        // the EVM stack before the payForceCross call, keeping peak depth ≤ 9 (limit = 16).
        uint256 sfShare;
        uint256 crossingBuffer;

        {   // ---- amount-computation block ----------------------------------------
            uint256 fee          = mat.ENTRY_FEE();
            uint256 withdrawable = mat.withdrawableOf(member);
            // V8.31: crossing reserve reduces SF shortfall — read it alongside withdrawable.
            uint256 reserve      = mat.crossingReserveOf(member);

            // -- Zero-balance eviction guard -----------------------------------------
            // If this member has $0 in both withdrawable AND crossingReserve, AND already
            // carries rescue debt from a prior rescue, they've proven they cannot repay
            // (likely a testnet zero-income wallet or mainnet member who never referred anyone).
            // Evict instead of piling on more unpayable debt that drains the SF indefinitely.
            if (withdrawable == 0 && reserve == 0 && mat.rescueDebtOf(member) > 0) {
                _doEvictParked(matrix, member);
                return;
            }

            // V8.31: effective contribution = crossingReserve + withdrawable.
            uint256 effectiveContrib = reserve + withdrawable;
            uint256 sfBps = _sfRescueBps(effectiveContrib, fee);
            if (sfBps == type(uint256).max) return;

            // Cap sfShare at the actual shortfall (don't advance more than needed).
            uint256 maxShortfall = fee > effectiveContrib ? fee - effectiveContrib : 0;
            sfShare = fee * sfBps / 10_000;
            if (sfShare > maxShortfall) sfShare = maxShortfall;

            // -- Crossing buffer --------------------------------------------------
            // V8.31: buffer formula derivation in CROSSING_BUFFER_BPS constant above.
            // Advances enough for member to cross after ~1 pool cycle at the new matrix,
            // even with 50% RESCUE_REPAY_BPS deductions from pool income.
            crossingBuffer = fee * CROSSING_BUFFER_BPS / 10_000;
        }   // fee, withdrawable, reserve, effectiveContrib, sfBps, maxShortfall freed here

        uint256 totalSfNeeded = sfShare + crossingBuffer;
        uint256 sfBal         = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        // Fall back to total SF balance if tier bucket cannot fully cover the rescue cost.
        // FIX V8.31: was `sfBal > 0` — caused stall when bucket had pennies left (> 0 but < sfShare).
        uint256 sfAvail       = sfBal >= totalSfNeeded ? sfBal : IStabilityFundKeeper(stabilityFund).totalBalance();

        // If SF cannot cover both, trim the buffer rather than skip the rescue entirely
        if (sfAvail < totalSfNeeded) {
            crossingBuffer = sfAvail > sfShare ? sfAvail - sfShare : 0;
            totalSfNeeded  = sfShare + crossingBuffer;
        }
        if (sfAvail < sfShare) return;   // can't even cover the entry shortfall -- bail

        if (totalSfNeeded > 0) IStabilityFundKeeper(stabilityFund).payForceCross(tierIdx, matrix, totalSfNeeded);
        mat.forceCrossKeeper(member, sfShare, crossingBuffer);
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
        if (!ghostEntryEnabled) return;  // V8.33: ghost entries disabled by default at launch
        address pm = pairManagerForTier[tierIdx];
        if (pm == address(0)) return;
        uint256 fee   = IPairManagerKeeper(pm).entryFee();
        uint256 sfBal   = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        // Fall back to total SF balance if tier bucket cannot cover the ghost entry fee.
        // FIX V8.31: was `sfBal > 0` — same stall-on-pennies bug as rescue path.
        uint256 sfAvail = sfBal >= fee ? sfBal : IStabilityFundKeeper(stabilityFund).totalBalance();
        if (sfAvail < fee) return;
        lastGhostTime[matrix] = block.timestamp;
        IStabilityFundKeeper(stabilityFund).payGhostEntry(tierIdx, pm);
        emit GhostEntryFunded(matrix, tierIdx);
    }

    function _doReclaimSlot(address matrix, address member, uint8) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        // Never reclaim from a matrix that hasn't completed its first rotation.
        // Members waiting for an unfilled matrix to reach 127 are not idle —
        // they're simply waiting for growth. Idle logic only applies to
        // matrices that are already cycling.
        if (mat.rotationCount() == 0) return;
        if (!mat.isInMatrix(member)) return;
        uint256 idleTime = block.timestamp - mat.lastActivityTime(member);
        if (idleTime < extendedIdleTimeout) return;
        reclaimAttemptTime[matrix][member] = block.timestamp;
        // V8.33: soft park instead of hard eviction — member goes to the rescue queue
        // and is re-entered automatically.  reclaimIdleSlot sent members to limbo with
        // no path back; softParkIdle keeps them in the system.
        mat.softParkIdle(member);
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
    /// @notice V8.31: parameter renamed to effectiveContrib (= crossingReserve + withdrawable).
    ///         The ladder ratio is now (crossingReserve + withdrawable) / entryFee, so a member
    ///         with a full crossing reserve but zero earnings correctly shows 50% contribution.
    function _sfRescueBps(uint256 effectiveContrib, uint256 entryFee)
        internal view returns (uint256)
    {
        uint256 n = sfRescueThresholds.length;
        // V8.23: if no ladder is configured yet (fresh deploy before governance seeds it),
        // fall back to 100% SF coverage so the keeper still rescues parked members.
        if (n == 0) return 10_000;
        uint256 wBps = effectiveContrib * 10_000 / entryFee;
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

        // Declare sfShare before the computation block so it survives into the SF-balance
        // check. The block frees withdrawn/withdrawable/reserve/fee/totalEarned/withdrawRatio/
        // effectiveContrib/sfBps/maxShortfall from the EVM stack, keeping peak depth ≤ 8.
        uint256 sfShare;

        {   // ---- amount-computation block ----------------------------------------
            uint256 withdrawn    = mat.getMemberTotalWithdrawn(parkedMember);
            uint256 withdrawable = mat.withdrawableOf(parkedMember);
            // V8.31: crossing reserve reduces SF shortfall — include it in effective contribution.
            uint256 reserve      = mat.crossingReserveOf(parkedMember);
            uint256 fee          = mat.ENTRY_FEE();
            uint256 totalEarned  = withdrawn + withdrawable;
            uint256 withdrawRatio = totalEarned > 0 ? withdrawn * 10_000 / totalEarned : 0;
            if (withdrawRatio > rescueRatioBps) return (parkedMember, WORK_EVICT_PARKED);
            uint256 effectiveContrib = reserve + withdrawable;
            uint256 sfBps = _sfRescueBps(effectiveContrib, fee);
            if (sfBps == type(uint256).max) return (parkedMember, WORK_EVICT_PARKED);
            uint256 maxShortfall = fee > effectiveContrib ? fee - effectiveContrib : 0;
            sfShare = fee * sfBps / 10_000;
            if (sfShare > maxShortfall) sfShare = maxShortfall;
        }   // withdrawn, withdrawable, reserve, fee, totalEarned, withdrawRatio,
            // effectiveContrib, sfBps, maxShortfall freed here

        uint256 sfBal   = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        // Fall back to total SF balance if tier bucket cannot cover the rescue share.
        // FIX V8.31: was `sfBal > 0` — same stall-on-pennies bug; checkUpkeep must agree with execution path.
        uint256 sfAvail = sfBal >= sfShare ? sfBal : IStabilityFundKeeper(stabilityFund).totalBalance();
        workType = (sfAvail >= sfShare) ? WORK_PARKED_RESCUE : type(uint8).max;
    }

    function _scanMatrix(address matrix, uint8 tierIdx, WorkItem[] memory items, uint256 count)
        internal view returns (uint256)
    {
        if (matrix == address(0)) return count;
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        // Skip idle/ghost checks entirely for matrices that have never completed
        // a full rotation. Members in a first-fill matrix are waiting for growth,
        // not genuinely idle. Ghost-funding and reclaiming only make sense once
        // the matrix is established and actively cycling.
        if (mat.rotationCount() == 0) return count;
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
