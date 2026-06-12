// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  TierManagerV6
 * @notice 7-tier upgrade manager for CryptoNova V6.
 *
 * KEY DESIGN:
 * - Each tier has its own BeltManagerV6 (routes into 127-member BFS matrix)
 * - cycleReq[all] = 1 (1 cycle to upgrade, confirmed for all test phases)
 * - L2/L3 tree overrides tracked on-chain, paid by matrix contracts
 * - Auto-upgrade fires from matrix earnings (full $10 cycle net ~$103)
 * - Whale gate: 25/15/5 mainnet | 2/1/1 expedited | 1/1/1 lightning
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";
import "./BeltManagerV6.sol";
import "./CryptoNovaMatrixV6.sol";

contract TierManagerV6 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8   public constant TOTAL_TIERS = 7;

    IERC20        public immutable usdc;
    CNOVAToken    public immutable cnova;
    CNOVATreasury public immutable treasury;
    address       public immutable devWallet;
    address       public immutable opsWallet;
    uint256       public immutable UNIT;

    mapping(uint8 => BeltManagerV6) public beltManagerV6For;

    uint256[8] public tierFee;
    uint8[8]   public cycleReq;
    uint256[8] public tierCnovaRate;

    mapping(address => uint8)   public memberTier;
    mapping(address => uint256) public tierJoinedAt;
    mapping(address => bool)    public autoUpgradeEnabled;
    mapping(address => address) public l2Referrer;
    mapping(address => address) public l3Referrer;

    uint256 public primeOrAboveCount;
    uint256 public eliteOrAboveCount;
    uint256 public sparkCount;
    uint256 public GENESIS_GATE_THRESHOLD;
    uint256 public ELITE_GATE_THRESHOLD;
    uint256 public SPARK_GATE_THRESHOLD;
    bool public t5FastTrackEnabled;
    bool public t6FastTrackEnabled;
    bool public t7FastTrackEnabled;
    bool public fastTrackEnabled;

    mapping(address => bool) public autoUpgradeCaller;

    event TierUpgraded(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee, uint256 cnovaMinted);
    event AutoUpgradeSet(address indexed member, bool enabled);
    event TreeRecorded(address indexed member, address l1, address l2, address l3);
    event GenesisGateOpened(uint256 count);
    event EliteGateOpened(uint256 count);
    event SparkGateOpened(uint256 count);

    constructor(
        address _usdc, address _cnova, address _treasury,
        address _devWallet, address _opsWallet, address _admin,
        uint256 _unit, uint256 _genesisGate, uint256 _eliteGate, uint256 _sparkGate
    ) Ownable(_admin) {
        usdc      = IERC20(_usdc);
        cnova     = CNOVAToken(_cnova);
        treasury  = CNOVATreasury(_treasury);
        devWallet = _devWallet;
        opsWallet = _opsWallet;
        UNIT      = _unit;
        GENESIS_GATE_THRESHOLD = _genesisGate;
        ELITE_GATE_THRESHOLD   = _eliteGate;
        SPARK_GATE_THRESHOLD   = _sparkGate;

        tierFee[1]=10*_unit; tierFee[2]=25*_unit;  tierFee[3]=50*_unit;
        tierFee[4]=100*_unit; tierFee[5]=250*_unit; tierFee[6]=500*_unit; tierFee[7]=1000*_unit;

        for (uint8 t = 1; t <= 7; t++) cycleReq[t] = 1;

        tierCnovaRate[2]=2*1e18; tierCnovaRate[3]=1*1e18; tierCnovaRate[4]=5e17;
        tierCnovaRate[5]=2e17;   tierCnovaRate[6]=1e17;   tierCnovaRate[7]=5e16;
    }

    function setBeltManagerV6(uint8 tier, address bm) external onlyOwner {
        require(tier >= 1 && tier <= TOTAL_TIERS, "TM6: invalid tier");
        beltManagerV6For[tier] = BeltManagerV6(bm);
    }

    function setAutoUpgradeCaller(address caller, bool auth) external onlyOwner {
        autoUpgradeCaller[caller] = auth;
    }

    function setAutoUpgrade(bool enabled) external {
        autoUpgradeEnabled[msg.sender] = enabled;
        emit AutoUpgradeSet(msg.sender, enabled);
    }

    function recordTreeJoin(address member, address l1, address l2, address l3) external {
        require(autoUpgradeCaller[msg.sender] || msg.sender == owner(), "TM6: not authorised");
        if (l2 != address(0)) l2Referrer[member] = l2;
        if (l3 != address(0)) l3Referrer[member] = l3;
        if (memberTier[member] == 0) {
            memberTier[member] = 1;
            tierJoinedAt[member] = block.timestamp;
        }
        emit TreeRecorded(member, l1, l2, l3);
    }

    function tryAutoUpgrade(address member) external {
        require(autoUpgradeCaller[msg.sender], "TM6: not authorised");
        if (!autoUpgradeEnabled[member]) return;
        uint8 current = memberTier[member];
        if (current == 0 || current >= TOTAL_TIERS) return;
        uint8   next = current + 1;
        uint256 fee  = tierFee[next];
        BeltManagerV6 bm = beltManagerV6For[current];
        if (address(bm) == address(0)) return;
        address beltAddr = bm.beltOf(member);
        if (beltAddr == address(0)) return;
        CryptoNovaMatrixV6 matrix = CryptoNovaMatrixV6(beltAddr);
        if (matrix.getCyclesCompleted(member) < cycleReq[current]) return;
        CryptoNovaMatrixV6.Member memory m = matrix.getMember(member);
        if (m.withdrawable < fee) return;
        matrix.deductWithdrawable(member, fee);
        BeltManagerV6 nextBM = beltManagerV6For[next];
        if (address(nextBM) == address(0)) return;
        SafeERC20.forceApprove(usdc, address(nextBM), fee);
        // registerFor() registers `member` (not TierManager) in the next tier belt
        nextBM.registerFor(member, m.referrer);
        uint256 cnovaMinted = 0;
        if (tierCnovaRate[next] > 0) {
            uint256 mintAmt = (fee / UNIT) * tierCnovaRate[next];
            if (mintAmt > 0) cnovaMinted = cnova.mintDirect(member, mintAmt);
        }
        uint8 fromTier = memberTier[member];
        memberTier[member]   = next;
        tierJoinedAt[member] = block.timestamp;
        _updateWhaleGate(next);
        emit TierUpgraded(member, fromTier, next, fee, cnovaMinted);
    }

    function upgradeTier(uint8 targetTier) external nonReentrant {
        require(targetTier >= 2 && targetTier <= TOTAL_TIERS, "TM6: invalid tier");
        uint8 current = memberTier[msg.sender];
        require(current > 0, "TM6: join tier 1 first");
        require(targetTier > current, "TM6: already at or above target");
        bool canFT = (targetTier==5&&t5FastTrackEnabled)||(targetTier==6&&t6FastTrackEnabled)||(targetTier==7&&t7FastTrackEnabled);
        if (!canFT) require(targetTier == current + 1, "TM6: sequential only");
        _requireCycles(msg.sender, current);
        uint256 fee = tierFee[targetTier];
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        BeltManagerV6 nextBM = beltManagerV6For[targetTier];
        require(address(nextBM) != address(0), "TM6: belt manager not set");
        address referrer = _getReferrer(msg.sender, current);
        SafeERC20.forceApprove(usdc, address(nextBM), fee);
        // registerFor() registers msg.sender (the actual member) in the next tier
        nextBM.registerFor(msg.sender, referrer);
        uint256 cnovaMinted = 0;
        if (tierCnovaRate[targetTier] > 0) {
            uint256 mintAmt = (fee / UNIT) * tierCnovaRate[targetTier];
            if (mintAmt > 0) cnovaMinted = cnova.mintDirect(msg.sender, mintAmt);
        }
        uint8 fromTier = memberTier[msg.sender];
        memberTier[msg.sender]   = targetTier;
        tierJoinedAt[msg.sender] = block.timestamp;
        _updateWhaleGate(targetTier);
        emit TierUpgraded(msg.sender, fromTier, targetTier, fee, cnovaMinted);
    }

    function _requireCycles(address member, uint8 tier) internal view {
        uint8 req = cycleReq[tier];
        if (req == 0) return;
        BeltManagerV6 bm = beltManagerV6For[tier];
        if (address(bm) == address(0)) return;
        address ba = bm.beltOf(member);
        if (ba == address(0)) return;
        require(CryptoNovaMatrixV6(ba).getCyclesCompleted(member) >= req, "TM6: cycles not complete");
    }

    function _getReferrer(address member, uint8 tier) internal view returns (address) {
        BeltManagerV6 bm = beltManagerV6For[tier];
        if (address(bm) == address(0)) return address(0);
        address ba = bm.beltOf(member);
        if (ba == address(0)) return address(0);
        return CryptoNovaMatrixV6(ba).getMember(member).referrer;
    }

    function _updateWhaleGate(uint8 toTier) internal {
        if (toTier == 5) { primeOrAboveCount++; if(!t5FastTrackEnabled&&primeOrAboveCount>=GENESIS_GATE_THRESHOLD){t5FastTrackEnabled=true;fastTrackEnabled=true;emit GenesisGateOpened(primeOrAboveCount);}}
        else if(toTier==6){ eliteOrAboveCount++; if(!t6FastTrackEnabled&&eliteOrAboveCount>=ELITE_GATE_THRESHOLD){t6FastTrackEnabled=true;emit EliteGateOpened(eliteOrAboveCount);}}
        else if(toTier==7){ sparkCount++; if(!t7FastTrackEnabled&&sparkCount>=SPARK_GATE_THRESHOLD){t7FastTrackEnabled=true;emit SparkGateOpened(sparkCount);}}
    }

    function canUpgrade(address member) external view returns (bool, string memory) {
        uint8 tier = memberTier[member];
        if (tier == 0) return (false, "Not in tier 1 yet");
        if (tier >= TOTAL_TIERS) return (false, "Already at top tier");
        BeltManagerV6 bm = beltManagerV6For[tier];
        if (address(bm) == address(0)) return (false, "Belt manager not set");
        address ba = bm.beltOf(member);
        if (ba == address(0)) return (false, "Not in matrix yet");
        if (CryptoNovaMatrixV6(ba).getCyclesCompleted(member) < cycleReq[tier]) return (false, "Cycles not complete");
        return (true, "Eligible to upgrade");
    }

    function memberJoinedAt(address member) external view returns (uint256) { return tierJoinedAt[member]; }
    function upgradeCost(address member) external view returns (uint256) {
        uint8 t = memberTier[member];
        if (t == 0 || t >= TOTAL_TIERS) return 0;
        return tierFee[t + 1];
    }
    function GENESIS_GATE_THRESHOLD_view() external view returns (uint256) { return GENESIS_GATE_THRESHOLD; }
}
