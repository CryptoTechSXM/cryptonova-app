// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CryptoNovaTierManager
 * @notice Manages the 7-tier CryptoNova Tier Ladder.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  THE 7 TIERS
 * ═══════════════════════════════════════════════════════════════════
 *  #   Name                  Entry Fee   Matrix Instance           Notes
 *  1   Nova Seed             $   10      matrixFor[1]  ($10  belt)
 *  2   Nova Rise             $   25      matrixFor[2]  ($25  belt)
 *  3   Nova Star             $   50      matrixFor[3]  ($50  belt)
 *  4   Nova Prime            $  100      matrixFor[4]  ($100 belt)
 *  5   SuperNova Genesis     $  250      matrixFor[5]  ($250 belt)  ← WHALE GATE
 *  6   SuperNova Elite       $  500      matrixFor[6]  ($500 belt)
 *  7   SuperNova Spark       $1,000      matrixFor[7]  ($1k  belt)
 *
 * ALL 7 tiers have a dedicated CryptoNovaMatrixV3 conveyor-belt instance.
 * Each tier's matrix entry fee equals that tier's upgrade fee.
 * When a member upgrades via TierManager, the full fee is routed through the
 * tier's V3 matrix (registerFor), which handles all USDC splits internally.
 * TierManager mints tier-specific CNOVA via mintDirect() after the V3 call.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  UPGRADE FLOW
 * ═══════════════════════════════════════════════════════════════════
 *  Sequential (Phase 1 — before whale gate):
 *    Member must complete the required cycles in tier N before paying
 *    to enter tier N+1.  Tiers cannot be skipped.
 *
 *  Fast-track (Phase 2 — after whale gate):
 *    Once `primeOrAboveCount` reaches WHALE_GATE_THRESHOLD (25),
 *    fast-track unlocks IRREVERSIBLY.  A new member may then pay the
 *    cumulative sum of all lower-tier fees in a single transaction
 *    and jump straight to any tier they can afford.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  CYCLE REQUIREMENTS (Hybrid B)
 * ═══════════════════════════════════════════════════════════════════
 *  Tier   Cycles required before upgrading
 *   1  →  2 :  1 cycle
 *   2  →  3 :  2 cycles
 *   3  →  4 :  2 cycles
 *   4  →  5 :  2 cycles
 *   5  →  6 :  3 cycles
 *   6  →  7 :  3 cycles
 *   7        :  (top tier — no further upgrade)
 *
 * ═══════════════════════════════════════════════════════════════════
 *  CNOVA MINTED PER TIER UPGRADE (decreasing rate)
 * ═══════════════════════════════════════════════════════════════════
 *  Tier 1  join  :  handled by the V3 matrix's own mintReward()
 *  Tier 2  join  :  50 CNOVA per $1 spent  →  1,250 CNOVA  ($25)
 *  Tier 3  join  :  50 CNOVA per $1 spent  →  2,500 CNOVA  ($50)
 *  Tier 4  join  :  40 CNOVA per $1 spent  →  4,000 CNOVA  ($100)
 *  Tier 5  join  :  30 CNOVA per $1 spent  →  7,500 CNOVA  ($250)
 *  Tier 6  join  :  25 CNOVA per $1 spent  → 12,500 CNOVA  ($500)
 *  Tier 7  join  :  20 CNOVA per $1 spent  → 20,000 CNOVA  ($1,000)
 *
 *  Note: CNOVA/$ rate decreases per tier, ensuring each upgrade adds MORE
 *  USDC to the reserve per CNOVA issued → floor price always rises. ✓
 *
 * ═══════════════════════════════════════════════════════════════════
 *  FEE ROUTING (tiers 2–7 upgrade payments)
 * ═══════════════════════════════════════════════════════════════════
 *  All upgrade payments route through the tier's V3 matrix (registerFor).
 *  V3 handles all USDC splits internally:
 *   30% → referrer bonus
 *   40% → 7-level chain pay (80% ancestor / 20% treasury)
 *   15% → USDC treasury reserve
 *   10% → community wallet
 *    3% → dev wallet
 *    2% → ops wallet
 *  TierManager additionally mints tier-specific CNOVA via mintDirect().
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";
import "./CryptoNovaMatrixV3.sol";
import "./BeltManager.sol";

contract CryptoNovaTierManager is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint8  public constant TOTAL_TIERS = 7;
    uint8  public constant MATRIX_TIERS = 7;  // all 7 tiers have a V3 matrix
    // V4: Staged whale gate thresholds
    uint256 public constant GENESIS_GATE_THRESHOLD = 2;  // T5 members to unlock T5 fast-track (prod: 25)
    uint256 public constant ELITE_GATE_THRESHOLD   = 1;  // T6 members to unlock T6 fast-track (prod: 15)
    uint256 public constant SPARK_GATE_THRESHOLD   = 1;  // T7 members to unlock T7 fast-track (prod: 5)
    uint256 public constant WHALE_GATE_THRESHOLD   = 2;  // kept for backward compat

    // ─────────────────────────────────────────────────────────────────────────
    // Tier configuration (set at deploy, immutable after init)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Entry fee per tier (1-indexed, index 0 unused).
    uint256[8] public tierFee;          // $10, $25, $50, $100, $250, $500, $1000

    /// @notice Cycles required in tier N before upgrading to tier N+1 (1-indexed).
    ///         cycleReq[7] is unused (no upgrade from top tier).
    uint8[8]  public cycleReq;          // [0, 1, 2, 2, 2, 3, 3, 3]

    /// @notice CNOVA minted per upgrade payment dollar (1-indexed).
    ///         Tier 1 is minted by V3 directly; tierCnovaRate[1] = 0 (handled by V3).
    uint256[8] public tierCnovaRate;    // [0, 0, 50, 50, 40, 30, 25, 20] × 1e18

    // ─────────────────────────────────────────────────────────────────────────
    // External contracts
    // ─────────────────────────────────────────────────────────────────────────

    IERC20        public immutable usdc;
    CNOVAToken    public immutable cnova;
    CNOVATreasury public immutable treasury;

    address public devWallet;
    address public opsWallet;
    address public communityWallet; // CryptoNovaCommunityWallet contract

    /// @notice Matrix instances for tiers 1–5.  matrixFor[1]..matrixFor[5].
    ///         matrixFor[6] and matrixFor[7] are address(0) — no matrix for top tiers.
    mapping(uint8 => CryptoNovaMatrixV3) public matrixFor;

    /// @notice V5 BeltManager — routes Tier-1 registrations across multiple belts.
    ///         When set, auto-sync and recordTier1Join use this instead of matrixFor[1].
    BeltManager public beltManager;

    /// @notice V5 per-tier BeltManagers — when set for a tier, upgrades route through
    ///         the belt manager instead of directly to matrixFor[tier].
    mapping(uint8 => BeltManager) public beltManagerFor;

    // ─────────────────────────────────────────────────────────────────────────
    // Whale gate state
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Number of members who have reached tier 5 (SuperNova Genesis) or above.
    uint256 public primeOrAboveCount;
    uint256 public eliteOrAboveCount;
    uint256 public sparkCount;
    bool public t5FastTrackEnabled;
    bool public t6FastTrackEnabled;
    bool public t7FastTrackEnabled;
    bool public fastTrackEnabled; // backward compat

    // V5: Auto-upgrade opt-in
    mapping(address => bool) public autoUpgradeEnabled;
    // Matrices/belts authorised to call tryAutoUpgrade
    mapping(address => bool) public autoUpgradeCaller;

    // ─────────────────────────────────────────────────────────────────────────
    // Member tier state
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Current tier of each member (0 = not yet joined tier 1 via TierManager).
    mapping(address => uint8) public memberTier;

    /// @notice Timestamp when a member entered each tier.
    mapping(address => mapping(uint8 => uint256)) public tierJoinedAt;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TierUpgraded(
        address indexed member,
        uint8   indexed fromTier,
        uint8   indexed toTier,
        uint256 feePaid,
        uint256 cnovaMinted
    );

    event FastTrackActivated(uint256 triggeredByCount);

    event WhaleGateProgress(uint256 primeOrAboveCount, uint256 threshold);
    event GenesisGateOpened(uint256 count);
    event EliteGateOpened(uint256 count);
    event SparkGateOpened(uint256 count);

    event DevWalletUpdated(address newDev);
    event OpsWalletUpdated(address newOps);
    event CommunityWalletUpdated(address newCommunity);
    event AutoUpgradeSet(address indexed member, bool enabled);

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _usdc            USDC token (6 dec on Base).
     * @param _cnova           CNOVAToken — TierManager must have MINTER_ROLE.
     * @param _treasury        CNOVATreasury — TierManager must have DEPOSITOR role (if any).
     * @param _devWallet       Dev income wallet.
     * @param _opsWallet       Ops income wallet.
     * @param _communityWallet CryptoNovaCommunityWallet contract address.
     * @param _admin           Contract owner (Ownable2Step).
     * @param _unit            1e6 for Base USDC.
     */
    constructor(
        address _usdc,
        address _cnova,
        address _treasury,
        address _devWallet,
        address _opsWallet,
        address _communityWallet,
        address _admin,
        uint256 _unit
    ) Ownable(_admin) {
        require(_usdc            != address(0), "TM: zero usdc");
        require(_cnova           != address(0), "TM: zero cnova");
        require(_treasury        != address(0), "TM: zero treasury");
        require(_devWallet       != address(0), "TM: zero dev");
        require(_opsWallet       != address(0), "TM: zero ops");
        require(_communityWallet != address(0), "TM: zero community");
        require(_unit >= 1e3 && _unit <= 1e18,   "TM: invalid unit");

        usdc            = IERC20(_usdc);
        cnova           = CNOVAToken(_cnova);
        treasury        = CNOVATreasury(_treasury);
        devWallet       = _devWallet;
        opsWallet       = _opsWallet;
        communityWallet = _communityWallet;

        // ── Tier entry fees ──────────────────────────────────────────────────
        tierFee[1] =   10 * _unit;   // Nova Seed
        tierFee[2] =   25 * _unit;   // Nova Rise
        tierFee[3] =   50 * _unit;   // Nova Star
        tierFee[4] =  100 * _unit;   // Nova Prime
        tierFee[5] =  250 * _unit;   // SuperNova Genesis  ← whale gate triggers here
        tierFee[6] =  500 * _unit;   // SuperNova Elite
        tierFee[7] = 1000 * _unit;   // SuperNova Spark

        // ── Hybrid B cycle requirements ──────────────────────────────────────
        // cycleReq[t] = cycles needed in tier t before upgrading to tier t+1
        cycleReq[1] = 1;   // Tier 1 → 2
        cycleReq[2] = 2;   // Tier 2 → 3
        cycleReq[3] = 2;   // Tier 3 → 4
        cycleReq[4] = 2;   // Tier 4 → 5
        cycleReq[5] = 3;   // Tier 5 → 6
        cycleReq[6] = 3;   // Tier 6 → 7
        cycleReq[7] = 0;   // Top tier — no upgrade

        // ── CNOVA mint rate per $1 of upgrade fee (tier 1 handled by V3) ────
        tierCnovaRate[1] = 0;              // handled by V3.mintReward()
        tierCnovaRate[2] = 2 * 1e18;      // 2 CNOVA/$ × $25  = 50 CNOVA flat
        tierCnovaRate[3] = 1 * 1e18;      // 1 CNOVA/$ × $50  = 50 CNOVA flat
        tierCnovaRate[4] = 5e17;           // 0.5 CNOVA/$ × $100 = 50 CNOVA flat
        tierCnovaRate[5] = 2e17;           // 0.2 CNOVA/$ × $250 = 50 CNOVA flat
        tierCnovaRate[6] = 1e17;           // 0.1 CNOVA/$ × $500 = 50 CNOVA flat
        tierCnovaRate[7] = 5e16;           // 0.05 CNOVA/$ × $1000 = 50 CNOVA flat
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup (owner-only, called once after deploy)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register the V3 matrix contracts for tiers 1–5.
     *         Must be called after all 5 matrices are deployed.
     *         Can only be called once per tier.
     */
    function setMatrix(uint8 tier, address matrix) external onlyOwner {
        require(tier >= 1 && tier <= TOTAL_TIERS,       "TM: invalid matrix tier");
        require(matrix != address(0),                   "TM: zero matrix");
        require(address(matrixFor[tier]) == address(0), "TM: already set");
        matrixFor[tier] = CryptoNovaMatrixV3(matrix);
    }

    /// @notice V5: set the BeltManager for Tier-1 multi-belt routing.
    ///         Once set, isRegistered checks use BeltManager instead of matrixFor[1].
    function setBeltManager(address _beltManager) external onlyOwner {
        require(_beltManager != address(0), "TM: zero belt manager");
        beltManager = BeltManager(_beltManager);
    }

    /// @notice V5: set a per-tier BeltManager (T2-T7).
    ///         Upgrades to that tier route through the belt manager instead of matrixFor[tier].
    function setBeltManagerForTier(uint8 tier, address _beltManager) external onlyOwner {
        require(tier >= 2 && tier <= TOTAL_TIERS, "TM: invalid tier");
        require(_beltManager != address(0), "TM: zero belt manager");
        beltManagerFor[tier] = BeltManager(_beltManager);
    }

    /// @notice V5: authorise a matrix or belt to trigger auto-upgrade callbacks.
    function setAutoUpgradeCaller(address caller, bool authorized) external onlyOwner {
        autoUpgradeCaller[caller] = authorized;
    }

    /// @notice Member opts in (or out) of automatic tier upgrades.
    ///         When enabled, the next cycle completion that meets all conditions
    ///         will automatically deduct the upgrade fee from withdrawable and
    ///         register the member in the next tier. Sequential upgrades only.
    function setAutoUpgrade(bool enabled) external {
        autoUpgradeEnabled[msg.sender] = enabled;
        emit AutoUpgradeSet(msg.sender, enabled);
    }

    /// @notice Called by a matrix on each cycle completion.
    ///         Silently skips if member has not opted in, cycles not complete,
    ///         or withdrawable balance is insufficient.
    function tryAutoUpgrade(address member) external {
        require(autoUpgradeCaller[msg.sender], "TM: not authorised caller");
        if (!autoUpgradeEnabled[member]) return;

        uint8 current = memberTier[member];
        // Auto-sync tier 1 if not yet recorded
        if (current == 0) {
            if (!_isInTier1(member)) return;
            memberTier[member]      = 1;
            tierJoinedAt[member][1] = block.timestamp;
            current                 = 1;
        }
        if (current >= TOTAL_TIERS) return;

        uint8   next     = current + 1;
        uint8   required = cycleReq[current];
        uint256 fee      = tierFee[next];

        // Check cycles completed in current tier matrix
        CryptoNovaMatrixV3 matrix = matrixFor[current];
        if (address(matrix) == address(0)) return;
        if (matrix.getCyclesCompleted(member) < required) return;

        // Check withdrawable covers the upgrade fee
        CryptoNovaMatrixV3.Member memory m = matrix.getMember(member);
        if (m.withdrawable < fee) return;

        // Pull fee from member's withdrawable in current matrix
        matrix.deductWithdrawable(member, fee);

        // Route to next tier via BeltManager (V5) or direct matrix (V4 fallback)
        BeltManager nextBM = beltManagerFor[next];
        if (address(nextBM) != address(0)) {
            CryptoNovaMatrixV3 activeBelt = CryptoNovaMatrixV3(nextBM.activeBelt());
            uint256 reentryAmt = fee * activeBelt.REENTRY_FEE_BPS() / 10_000;
            uint256 activeIdx  = nextBM.activeBeltIndex();
            uint256 beltsToPay = activeIdx > 3 ? 3 : activeIdx;
            SafeERC20.forceApprove(usdc, address(nextBM), fee + (beltsToPay * reentryAmt));
            nextBM.registerFor(member, m.originalReferrer);
        } else {
            SafeERC20.forceApprove(usdc, address(matrixFor[next]), fee);
            matrixFor[next].registerFor(member, m.originalReferrer);
        }

        // Mint tier-upgrade CNOVA (same formula as manual upgradeTier path)
        uint256 cnovaMinted = 0;
        if (tierCnovaRate[next] > 0) {
            uint256 dollarsInFee = fee / _getUsdcUnit();
            uint256 mintAmt      = dollarsInFee * tierCnovaRate[next];
            if (mintAmt > 0) {
                cnovaMinted = cnova.mintDirect(member, mintAmt);
            }
        }

        // Record upgrade state
        uint8 fromTier = current;
        memberTier[member]          = next;
        tierJoinedAt[member][next]  = block.timestamp;

        // Whale gate tracking
        if (next >= 5) {
            if (next == 5) {
                primeOrAboveCount += 1;
                if (!t5FastTrackEnabled && primeOrAboveCount >= GENESIS_GATE_THRESHOLD) {
                    t5FastTrackEnabled = true;
                    fastTrackEnabled   = true;
                    emit GenesisGateOpened(primeOrAboveCount);
                    emit FastTrackActivated(primeOrAboveCount);
                }
            } else if (next == 6) {
                eliteOrAboveCount += 1;
                if (!t6FastTrackEnabled && eliteOrAboveCount >= ELITE_GATE_THRESHOLD) {
                    t6FastTrackEnabled = true;
                    emit EliteGateOpened(eliteOrAboveCount);
                }
            } else if (next == 7) {
                sparkCount += 1;
                if (!t7FastTrackEnabled && sparkCount >= SPARK_GATE_THRESHOLD) {
                    t7FastTrackEnabled = true;
                    emit SparkGateOpened(sparkCount);
                }
            }
        }

        emit TierUpgraded(member, fromTier, next, fee, cnovaMinted);
    }

    /// @dev Returns true if member is registered in Tier-1.
    ///      Checks BeltManager first (V5), then falls back to matrixFor[1] (V4/legacy).
    ///      Both paths are active when BeltManager is set, for backward compatibility.
    function _isInTier1(address member) internal view returns (bool) {
        if (address(beltManager) != address(0) && beltManager.isRegistered(member)) {
            return true;
        }
        return address(matrixFor[1]) != address(0) &&
               matrixFor[1].getMember(member).isRegistered;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIER UPGRADE — PRIMARY ENTRY POINT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Upgrade to the next tier (sequential mode), or jump to `targetTier`
     *         (fast-track mode, only when fastTrackEnabled == true).
     *
     *         Sequential:
     *           - Must have completed required cycles in current tier.
     *           - targetTier must be currentTier + 1.
     *           - Pay tierFee[targetTier].
     *
     *         Fast-track (post-whale-gate):
     *           - targetTier can be any tier > currentTier.
     *           - Must pay the CUMULATIVE fees for all skipped tiers.
     *             e.g., jumping from tier 1 to tier 4 costs fee[2]+fee[3]+fee[4].
     *           - Cycle requirement is waived for skipped tiers only.
     *             Current tier's cycle requirement still applies if skipping
     *             one level; if jumping multiple levels all requirements waived.
     *
     *         Caller must approve this contract for the required USDC before calling.
     *
     * @param targetTier  Tier to upgrade to (2–7).
     * @param referrer    Referrer address forwarded to V3 register() for matrix tiers.
     */
    function upgradeTier(uint8 targetTier, address referrer) external nonReentrant {
        address member = msg.sender;
        uint8   current = memberTier[member];

        require(targetTier >= 2 && targetTier <= TOTAL_TIERS, "TM: invalid target tier");
        require(targetTier > current,                          "TM: already at or above target");

        // ── Tier 1 auto-sync ─────────────────────────────────────────────────
        // Tier 1 is joined directly via V3.register(). If TierManager hasn't
        // recorded it yet (current == 0), auto-sync by verifying on-chain that
        // the member IS registered in the Tier 1 matrix. No admin needed.
        if (current == 0) {
            // V5: check BeltManager if set, otherwise fall back to matrixFor[1]
            require(_isInTier1(member), "TM: join tier 1 first");
            // Auto-sync: record Tier 1 membership
            memberTier[member]       = 1;
            tierJoinedAt[member][1]  = block.timestamp;
            current                  = 1;
            emit TierUpgraded(member, 0, 1, 0, 0);
        }

        // V4 Staged fast-track: each tier gate unlocks independently
        bool canFastTrackToTarget = (targetTier == 5 && t5FastTrackEnabled)
            || (targetTier == 6 && t6FastTrackEnabled)
            || (targetTier == 7 && t7FastTrackEnabled);

        if (!canFastTrackToTarget) {
            // ── SEQUENTIAL MODE ───────────────────────────────────────────────
            require(targetTier == current + 1, "TM: sequential only - tier gate not yet open");
            _requireCyclesComplete(member, current);
            _processUpgrade(member, current, targetTier, referrer);
        } else {
            // ── FAST-TRACK MODE ───────────────────────────────────────────────
            // Cumulative fee = sum of fees for each tier from (current+1) to targetTier
            uint256 totalFee = _cumulativeFee(current + 1, targetTier);
            usdc.safeTransferFrom(member, address(this), totalFee);

            // Upgrade through each intermediate tier in sequence
            for (uint8 t = current + 1; t <= targetTier; t++) {
                _processUpgradeInternal(member, t, referrer, tierFee[t]);
            }
        }
    }

    /**
     * @notice Called by V3's matrix contract (or owner) to record that a member
     *         has joined tier 1 via V3.register().
     *         Updates TierManager's memberTier[member] = 1.
     *
     * @dev Only callable by the tier-1 matrix contract or the owner.
     *      This avoids requiring members to call two separate functions.
     */
    function recordTier1Join(address member) external {
        // V5: accept calls from BeltManager, any belt in matrixFor[1], or owner
        bool authorised = msg.sender == owner()
            || msg.sender == address(matrixFor[1])
            || (address(beltManager) != address(0) && msg.sender == address(beltManager));
        require(authorised, "TM: not authorised");
        require(member != address(0),    "TM: zero member");
        require(memberTier[member] == 0, "TM: already recorded");
        require(_isInTier1(member),      "TM: not in tier-1");

        memberTier[member] = 1;
        tierJoinedAt[member][1] = block.timestamp;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal upgrade logic
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Sequential upgrade: pull payment, then process.
     *      TierUpgraded is emitted inside _processUpgradeInternal — do not emit here.
     */
    function _processUpgrade(
        address member,
        uint8   /* fromTier */,
        uint8   toTier,
        address referrer
    ) internal {
        uint256 fee = tierFee[toTier];
        usdc.safeTransferFrom(member, address(this), fee);
        _processUpgradeInternal(member, toTier, referrer, fee);
    }

    /**
     * @dev Core upgrade: distribute fee, mint CNOVA, update state, check whale gate.
     *      Assumes USDC is already held by this contract.
     *
     * @param toTier   Tier being entered.
     * @param fee      USDC amount to distribute for this tier.
     */
    function _processUpgradeInternal(
        address member,
        uint8   toTier,
        address referrer,
        uint256 fee
    ) internal {
        uint8 fromTier = memberTier[member];

        // ── Fee distribution ──────────────────────────────────────────────────
        uint256 cnovaMinted = _distributeUpgradeFee(member, toTier, referrer, fee);

        // ── State update ──────────────────────────────────────────────────────
        memberTier[member] = toTier;
        tierJoinedAt[member][toTier] = block.timestamp;

        // ── Whale gate check ──────────────────────────────────────────────────
        // Tier 5 = SuperNova Genesis — the threshold for "serious money".
        // Once 25 members reach SuperNova Genesis or above, fast-track unlocks globally forever.
        if (toTier >= 5) {
            if (toTier == 5) {
                primeOrAboveCount += 1;
                if (!t5FastTrackEnabled && primeOrAboveCount >= GENESIS_GATE_THRESHOLD) {
                    t5FastTrackEnabled = true;
                    fastTrackEnabled   = true;  // backward compat
                    emit GenesisGateOpened(primeOrAboveCount);
                    emit FastTrackActivated(primeOrAboveCount);
                } else {
                    emit WhaleGateProgress(primeOrAboveCount, GENESIS_GATE_THRESHOLD);
                }
            } else if (toTier == 6) {
                eliteOrAboveCount += 1;
                if (!t6FastTrackEnabled && eliteOrAboveCount >= ELITE_GATE_THRESHOLD) {
                    t6FastTrackEnabled = true;
                    emit EliteGateOpened(eliteOrAboveCount);
                }
            } else if (toTier == 7) {
                sparkCount += 1;
                if (!t7FastTrackEnabled && sparkCount >= SPARK_GATE_THRESHOLD) {
                    t7FastTrackEnabled = true;
                    emit SparkGateOpened(sparkCount);
                }
            }
        }

        emit TierUpgraded(member, fromTier, toTier, fee, cnovaMinted);
    }

    /**
     * @dev Distribute upgrade fee and mint CNOVA.
     *      Returns the amount of CNOVA minted.
     *
     *  All tiers 2–7 now have a V3 matrix.  Fee routing:
     *   The full upgrade fee is routed through the tier's V3 matrix via registerFor().
     *   V3 handles all USDC splits internally:
     *     30% → referrer bonus
     *     40% → 7-level chain pay (80% ancestor earns / 20% treasury)
     *     15% → USDC treasury reserve
     *     10% → community wallet
     *      3% → dev wallet
     *      2% → ops wallet
     *
     *   After the V3 call, TierManager mints tier-specific CNOVA via mintDirect()
     *   using the per-tier CNOVA rate (tierCnovaRate[toTier]).
     */
    function _distributeUpgradeFee(
        address member,
        uint8   toTier,
        address referrer,
        uint256 fee
    ) internal returns (uint256 cnovaMinted) {
        // ── Route fee through BeltManager (if set) or direct matrix ─────────
        BeltManager tierBM = beltManagerFor[toTier];
        if (address(tierBM) != address(0)) {
            // V5: route through per-tier belt manager
            // Belt manager pulls fee + reentry contributions from TierManager
            // Pre-approve enough for fee + up to 3 belt reentry contributions
            CryptoNovaMatrixV3 activeBelt = CryptoNovaMatrixV3(tierBM.activeBelt());
            uint256 reentryAmt  = fee * activeBelt.REENTRY_FEE_BPS() / 10_000;
            uint256 activeIdx   = tierBM.activeBeltIndex();
            uint256 beltsToPay  = activeIdx > 3 ? 3 : activeIdx;
            SafeERC20.forceApprove(usdc, address(tierBM), fee + (beltsToPay * reentryAmt));
            tierBM.registerFor(member, referrer);
        } else {
            // Fallback: direct single matrix
            CryptoNovaMatrixV3 mtrx = matrixFor[toTier];
            require(address(mtrx) != address(0), "TM: matrix not set for tier");
            SafeERC20.forceApprove(usdc, address(mtrx), fee);
            mtrx.registerFor(member, referrer);
        }

        // ── Mint tier-specific CNOVA ──────────────────────────────────────────
        // cnovaAmount = dollars_in_fee × tierCnovaRate[toTier]
        // fee is in USDC native units (1e6 on Base), rate is CNOVA-wei per dollar.
        if (tierCnovaRate[toTier] > 0) {
            uint256 usdcUnit     = _getUsdcUnit();
            uint256 dollarsInFee = fee / usdcUnit;  // e.g. 25_000_000 / 1_000_000 = 25
            cnovaMinted          = dollarsInFee * tierCnovaRate[toTier];
            // e.g. tier 2: 25 × 50e18 = 1,250e18 CNOVA

            if (cnovaMinted > 0) {
                // Use CNOVAToken.mintDirect() — role-gated, respects MAX_SUPPLY.
                // TierManager must hold MINTER_ROLE on CNOVAToken.
                cnovaMinted = cnova.mintDirect(member, cnovaMinted);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pending CNOVA bonus — kept for potential future use (currently unused;
    // tier CNOVA is minted inline via mintDirect() during upgradeTier()).
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Pending CNOVA bonus for each member (e.g., if inline mint hits cap).
    mapping(address => uint256) public pendingCnovaBonus;

    // ─────────────────────────────────────────────────────────────────────────
    // Cycle check helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Reverts if `member` has not completed the required cycles in `tier`.
     */
    function _requireCyclesComplete(address member, uint8 tier) internal view {
        uint8 required = cycleReq[tier];
        if (required == 0) return; // top tier or no requirement

        // All tiers 1–7 now have a V3 matrix — use cyclesCompleted from the matrix.
        CryptoNovaMatrixV3 matrix = matrixFor[tier];
        require(address(matrix) != address(0), "TM: matrix not set");
        uint256 completed = matrix.getCyclesCompleted(member);
        require(completed >= required, "TM: cycles not complete");
    }

    /**
     * @dev Sum of fees from `fromTier` to `toTier` inclusive (for fast-track).
     */
    function _cumulativeFee(uint8 fromTier, uint8 toTier) internal view returns (uint256 total) {
        for (uint8 t = fromTier; t <= toTier; t++) {
            total += tierFee[t];
        }
    }

    /**
     * @dev Detect USDC decimal unit from the USDC token's decimals().
     */
    function _getUsdcUnit() internal view returns (uint256) {
        try IERC20Metadata(address(usdc)).decimals() returns (uint8 dec) {
            return 10 ** dec;
        } catch {
            return 1e6; // default to Base USDC
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEW FUNCTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the tier a member is currently on (0 = not yet joined).
     */
    function getTier(address member) external view returns (uint8) {
        return memberTier[member];
    }

    /**
     * @notice Returns how many cycles the member has completed in their current tier.
     *         Returns 0 for non-matrix tiers (6–7) or if matrix not set.
     */
    function cyclesInCurrentTier(address member) external view returns (uint256) {
        uint8 tier = memberTier[member];
        if (tier == 0 || tier > MATRIX_TIERS) return 0;
        CryptoNovaMatrixV3 matrix = matrixFor[tier];
        if (address(matrix) == address(0)) return 0;
        return matrix.getCyclesCompleted(member);
    }

    /**
     * @notice Returns how many more cycles a member needs before they can upgrade.
     */
    function cyclesUntilUpgrade(address member) external view returns (uint256) {
        uint8 tier = memberTier[member];
        if (tier == 0 || tier >= TOTAL_TIERS) return 0;

        uint8 required = cycleReq[tier];
        if (required == 0) return 0;

        // All tiers 1–7 have a V3 matrix — read cycles from it.
        CryptoNovaMatrixV3 matrix = matrixFor[tier];
        if (address(matrix) == address(0)) return required;
        uint256 done = matrix.getCyclesCompleted(member);
        return done >= required ? 0 : required - done;
    }

    /**
     * @notice Returns the cost to upgrade from current tier to `targetTier`.
     *         In sequential mode `targetTier` must be currentTier + 1.
     *         In fast-track mode any higher tier is valid.
     */
    function upgradeCost(address member, uint8 targetTier) external view returns (uint256) {
        uint8 current = memberTier[member];
        if (targetTier <= current || targetTier > TOTAL_TIERS) return 0;
        if (!fastTrackEnabled || targetTier == current + 1) {
            return tierFee[targetTier];
        }
        return _cumulativeFee(current + 1, targetTier);
    }

    /**
     * @notice Returns true if fast-track is enabled AND the member meets the
     *         cycle requirement for their current tier (or has passed it).
     */
    function canUpgrade(address member) external view returns (bool eligible, string memory reason) {
        uint8 tier = memberTier[member];
        // V5: if not yet synced but registered in tier 1 (via BeltManager or matrix), treat as tier 1
        if (tier == 0 && _isInTier1(member)) tier = 1;
        if (tier == 0)              return (false, "Not in tier 1 yet");
        if (tier >= TOTAL_TIERS)    return (false, "Already at top tier");

        uint8 required = cycleReq[tier];
        // All tiers 1–7 have a V3 matrix — check cycles from the matrix.
        CryptoNovaMatrixV3 matrix = matrixFor[tier];
        if (address(matrix) == address(0)) return (false, "Matrix not configured");
        uint256 done = matrix.getCyclesCompleted(member);
        if (done < required)    return (false, "Cycles not complete");

        return (true, "Eligible to upgrade");
    }

    /**
     * @notice Full upgrade profile for a member.
     */
    function memberProfile(address member) external view returns (
        uint8   currentTier,
        uint256 cyclesDone,
        uint8   cyclesNeeded,
        uint256 nextTierFee,
        bool    upgradeReady,
        bool    fastTrack,
        uint256 pendingBonus
    ) {
        currentTier  = memberTier[member];
        cyclesNeeded = currentTier > 0 && currentTier < TOTAL_TIERS
            ? cycleReq[currentTier] : 0;

        if (currentTier > 0 && currentTier <= MATRIX_TIERS) {
            CryptoNovaMatrixV3 matrix = matrixFor[currentTier];
            cyclesDone = address(matrix) != address(0)
                ? matrix.getCyclesCompleted(member) : 0;
        }

        nextTierFee  = currentTier > 0 && currentTier < TOTAL_TIERS
            ? tierFee[currentTier + 1] : 0;
        upgradeReady = cyclesDone >= cyclesNeeded && currentTier > 0 && currentTier < TOTAL_TIERS;
        fastTrack    = fastTrackEnabled;
        pendingBonus = pendingCnovaBonus[member];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    function setDevWallet(address _dev) external onlyOwner {
        require(_dev != address(0), "TM: zero dev");
        devWallet = _dev;
        emit DevWalletUpdated(_dev);
    }

    function setOpsWallet(address _ops) external onlyOwner {
        require(_ops != address(0), "TM: zero ops");
        opsWallet = _ops;
        emit OpsWalletUpdated(_ops);
    }

    function setCommunityWallet(address _cw) external onlyOwner {
        require(_cw != address(0), "TM: zero community");
        communityWallet = _cw;
        emit CommunityWalletUpdated(_cw);
    }

    /**
     * @notice Emergency: owner can manually set a member's tier record.
     *         Use only to correct data errors — emits an event for transparency.
     */
    function adminSetMemberTier(address member, uint8 tier) external onlyOwner {
        require(tier <= TOTAL_TIERS, "TM: invalid tier");
        uint8 prev = memberTier[member];
        memberTier[member] = tier;
        tierJoinedAt[member][tier] = block.timestamp;

        // Mirror whale-gate logic: count the transition into tier 5+ (once per member).
        if (tier >= 5 && prev < 5) {
            if (tier == 5) {
                primeOrAboveCount += 1;
                if (!t5FastTrackEnabled && primeOrAboveCount >= GENESIS_GATE_THRESHOLD) {
                    t5FastTrackEnabled = true;
                    fastTrackEnabled   = true;
                    emit GenesisGateOpened(primeOrAboveCount);
                    emit FastTrackActivated(primeOrAboveCount);
                } else {
                    emit WhaleGateProgress(primeOrAboveCount, GENESIS_GATE_THRESHOLD);
                }
            } else if (tier == 6) {
                eliteOrAboveCount += 1;
                if (!t6FastTrackEnabled && eliteOrAboveCount >= ELITE_GATE_THRESHOLD) {
                    t6FastTrackEnabled = true;
                    emit EliteGateOpened(eliteOrAboveCount);
                }
            } else if (tier == 7) {
                sparkCount += 1;
                if (!t7FastTrackEnabled && sparkCount >= SPARK_GATE_THRESHOLD) {
                    t7FastTrackEnabled = true;
                    emit SparkGateOpened(sparkCount);
                }
            }
        }

        emit TierUpgraded(member, prev, tier, 0, 0);
    }
}
