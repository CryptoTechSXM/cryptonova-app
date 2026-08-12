// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CNOVATreasury
 * @notice Manages the USDC reserve that backs the CNOVA floor price.
 *
 * Core mechanic — Rising Floor Price:
 *   Floor = usdcReserve / cnovaCirculatingSupply
 *
 * The stablecoin decimal precision depends on the deployment chain:
 *   Base (USDC native, 6 dec)  : 1 stablecoin unit = 1_000_000
 *   BSC  (USDT bridged, 18 dec): 1 stablecoin unit = 1e18
 * CNOVA always uses 18 decimals: 1 CNOVA = 1e18 units.
 *
 * Floor price formula (chain-agnostic):
 *   floorPrice() = (usdcReserve × 1e18) / cnovaSupply_18dec
 *   Result is in stablecoin-native units per 1 CNOVA.
 *   Base example : result 30_000     = $0.03 per CNOVA (1_000_000 = $1.00)
 *   BSC  example : result 3e16       = $0.03 per CNOVA (1e18      = $1.00)
 *
 * Every $10 entry sends $1.50 here → reserve grows → floor rises.
 * No USDC ever leaves except:
 *   (a) A member burns CNOVA → receives USDC at the floor price.
 *   (b) Owner-initiated emergency withdrawal (timelock protected, emits event).
 *
 * Phase gating:
 *   - Phase 1 (Gated):    Only registered members can buy/sell CNOVA.
 *                          Activated from deploy until 500 members join.
 *   - Universe Mode (Free): After 500 members the owner calls setFreeMode().
 *                            This is IRREVERSIBLE — the gate is removed forever.
 *                            Aerodrome DEX trading opens to the public.
 *
 * DEX integration (Aerodrome on Base · PancakeSwap on BSC):
 *   - In Universe Mode the contract can add liquidity / create the initial LP.
 *   - Market price on DEX can trade freely ABOVE floor price.
 *   - Floor price is a buy-side guarantee: if DEX price ever drops to floor,
 *     holders can burn CNOVA directly here and receive USDC at floor rate.
 *
 * Burn-to-redeem flow:
 *   1. Member calls approve(treasury, amount) on CNOVA token.
 *   2. Member calls redeemAtFloor(amount) on this contract.
 *   3. Treasury burns the CNOVA tokens (via BURNER_ROLE).
 *   4. Treasury sends USDC to the member at current floor price.
 *   Floor price updates automatically after each burn.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";

contract CNOVATreasury is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable references
    // ─────────────────────────────────────────────────────────────────────────
    CNOVAToken public immutable cnova;
    IERC20     public immutable usdc;

    // ─────────────────────────────────────────────────────────────────────────
    // Phase state
    // ─────────────────────────────────────────────────────────────────────────
    bool public isUniverseMode;          // false = gated, true = free (irreversible)
    uint256 public constant FREE_MODE_MEMBER_THRESHOLD = 500;

    // ─────────────────────────────────────────────────────────────────────────
    // Reserve tracking
    // ─────────────────────────────────────────────────────────────────────────
    uint256 public usdcReserve;          // USDC held in this contract (18-dec)

    // ─────────────────────────────────────────────────────────────────────────
    // Authorized callers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Addresses authorised to call depositReserve() — all 7 V3 matrices.
    mapping(address => bool) public authorizedCallers;

    /// @notice Tier-1 matrix reference used by setFreeMode() to check totalMembers.
    address public tier1Matrix;
    address public communityWallet; // V4: receives 20% of early exit penalties

    /// @notice V8.35: MatrixPairFactory. When wired, factory can call
    ///         setAuthorizedCaller() to register newly deployed matrices inline.
    address public pairFactory;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────
    event ReserveDeposited(address indexed from, uint256 usdcAmount);
    event EarlyExitPenalty(address indexed member, uint256 penalty, uint256 penaltyBps, uint256 toTreasury, uint256 toCommunity);
    event FloorRedemption(
        address indexed member,
        uint256 cnovaBurned,
        uint256 usdcPaid,
        uint256 floorPriceUsed
    );
    event UniverseModeActivated(uint256 timestamp);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event Tier1MatrixSet(address indexed matrix);
    event EmergencyWithdraw(address indexed to, uint256 amount, string reason);

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────
    modifier onlyMatrix() {
        require(authorizedCallers[msg.sender], "Treasury: caller not matrix");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────
    constructor(
        address _cnova,
        address _usdc,
        address _admin
    ) Ownable(_admin) {
        require(_cnova != address(0), "Treasury: zero cnova");
        require(_usdc  != address(0), "Treasury: zero usdc");

        cnova = CNOVAToken(_cnova);
        usdc  = IERC20(_usdc);
        isUniverseMode = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin setup
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice V8.35: Wire the MatrixPairFactory so it can authorize new matrices inline.
    function setFactory(address _factory) external onlyOwner {
        pairFactory = _factory;
    }

    /// @notice Authorise or deauthorise a caller (matrix) to call depositReserve().
    ///         V8.35: Also callable by pairFactory for autonomous expansion.
    function setAuthorizedCaller(address caller, bool authorized) external {
        require(msg.sender == owner() || msg.sender == pairFactory, "Treasury: not owner/factory");
        require(caller != address(0), "Treasury: zero address");
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerSet(caller, authorized);
    }

    /// @notice Set the Tier-1 V3 matrix used by setFreeMode() to check totalMembers.
    ///         Can only be set once.
    function setCommunityWallet(address cw) external onlyOwner {
        require(cw != address(0), "Treasury: zero address");
        communityWallet = cw;
    }

    function setTier1Matrix(address matrix) external onlyOwner {
        require(matrix != address(0), "Treasury: zero matrix");
        require(tier1Matrix == address(0), "Treasury: already set");
        tier1Matrix = matrix;
        emit Tier1MatrixSet(matrix);
    }

    /// @notice Update the member tracker to PairManager (aggregates across all pairs).
    ///         Call this after deploying PairManager so Universe Mode counts correctly.
    function setMemberTracker(address tracker) external onlyOwner {
        require(tracker != address(0), "Treasury: zero tracker");
        tier1Matrix = tracker;
        emit Tier1MatrixSet(tracker);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reserve deposits — called by Matrix on every $5 entry
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the reserve. Called by Matrix after collecting
     *         entry fee. Transfers `amount` USDC from Matrix to this contract.
     * @param  amount  USDC amount in 18-decimal units (matches BSC USDC).
     */
    /// @notice Record a direct USDC deposit (caller transfers first, then calls this)
    function recordDirectDeposit(uint256 amount) external onlyMatrix {
        require(amount > 0, "Treasury: zero");
        usdcReserve += amount;
        emit ReserveDeposited(msg.sender, amount);
    }

    function depositReserve(uint256 amount_) external onlyMatrix nonReentrant {
        require(amount_ > 0, "Treasury: zero deposit");
        usdc.safeTransferFrom(msg.sender, address(this), amount_);
        usdcReserve += amount_;
        emit ReserveDeposited(msg.sender, amount_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Floor price calculation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Current floor price of CNOVA expressed in 6-decimal USDC units.
     *
     *   Formula : (usdcReserve × 1e18) / cnovaSupply
     *   Units   : 6-dec USDC per 1 CNOVA (18-dec)
     *   Example : result 30_000 = $0.03  (because 1_000_000 = $1.00)
     *
     * Walkthrough for member #1 ($10 entry, 50 CNOVA minted):
     *   usdcReserve = 1_500_000   ($1.50 in 6-dec)
     *   supply      = 50 × 1e18
     *   floor       = (1_500_000 × 1e18) / (50 × 1e18) = 30_000  ($0.03)
     *
     * Floor rises as more members join (reserve grows) or CNOVA is burned
     * (supply shrinks). It can only ever go up — never down — by design.
     *
     * Returns 0 only when supply is 0 AND reserve is 0 (before any member joins).
     */
    function floorPrice() public view returns (uint256) {
        uint256 supply = cnova.totalSupply();
        if (supply == 0) {
            // Edge case: no CNOVA minted yet (between deploy and first member).
            // Return a conservative seed floor: $0.01 in 6-dec = 10_000.
            // This value is never actually used in a real redemption since you
            // cannot burn tokens that don't exist yet.
            return 10_000;
        }
        return (usdcReserve * 1e18) / supply;
    }

    /**
     * @notice USDC value (6-decimal units) of a given CNOVA amount at floor price.
     *         Useful for frontend display: "your X CNOVA is worth $Y at floor."
     *
     * @param cnovaAmount  CNOVA quantity in 18-decimal units (e.g. 1e18 = 1 CNOVA).
     * @return             USDC amount in 6-decimal units (e.g. 30_000 = $0.03).
     */
    function usdcValueAtFloor(uint256 cnovaAmount) external view returns (uint256) {
        return (cnovaAmount * floorPrice()) / 1e18;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Burn-to-redeem at floor price
    // ─────────────────────────────────────────────────────────────────────────

    // V4: Early exit penalty tiers (from first T1 registration date)
    // 0-30d: 45%  |  31-60d: 30%  |  61-90d: 15%  |  91-120d: 5%  |  121d+: 0%
    function earlyExitPenaltyBps(address member) public view returns (uint256 penaltyBps) {
        if (tier1Matrix == address(0)) return 0;
        // Defensive: older matrix versions may not implement memberJoinedAt()
        uint256 joinedAt;
        try IMatrixMemberCount(tier1Matrix).memberJoinedAt(member) returns (uint256 t) {
            joinedAt = t;
        } catch {
            return 0;
        }
        if (joinedAt == 0) return 0;
        uint256 daysSince = (block.timestamp - joinedAt) / 1 days;
        if      (daysSince <= 30)  penaltyBps = 4500;
        else if (daysSince <= 60)  penaltyBps = 3000;
        else if (daysSince <= 90)  penaltyBps = 1500;
        else if (daysSince <= 120) penaltyBps = 500;
        else                       penaltyBps = 0;
    }

    function redeemAtFloor(uint256 cnovaAmount) external nonReentrant {
        require(cnovaAmount > 0, "Treasury: zero amount");
        require(
            cnova.balanceOf(msg.sender) >= cnovaAmount,
            "Treasury: insufficient CNOVA balance"
        );

        uint256 floor = floorPrice();
        require(floor > 0, "Treasury: floor not established yet");

        uint256 usdcOut = (cnovaAmount * floor) / 1e18;
        require(usdcOut > 0,            "Treasury: redemption too small");
        require(usdcOut <= usdcReserve, "Treasury: reserve insufficient");

        // V4: Apply early exit penalty
        uint256 penaltyBps = earlyExitPenaltyBps(msg.sender);
        uint256 penalty    = (usdcOut * penaltyBps) / 10_000;
        uint256 memberOut  = usdcOut - penalty;

        // Burn CNOVA first (checks-effects-interactions)
        usdcReserve -= usdcOut;
        cnova.burnFrom(msg.sender, cnovaAmount);

        // Distribute penalty: 80% back to treasury reserve, 20% to community wallet
        if (penalty > 0) {
            uint256 toTreasury = (penalty * 80) / 100;
            uint256 toCW       = penalty - toTreasury;
            usdcReserve += toTreasury;   // recycles back into floor support
            usdc.safeTransfer(communityWallet, toCW);
            emit EarlyExitPenalty(msg.sender, penalty, penaltyBps, toTreasury, toCW);
        }

        usdc.safeTransfer(msg.sender, memberOut);
        emit FloorRedemption(msg.sender, cnovaAmount, memberOut, floor);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase gating
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Activate Universe Mode — IRREVERSIBLE.
     *         Callable by ANYONE once 500+ members have joined.
     *         The 500-member check is the security guard — no admin gating needed.
     *         Set memberTracker to PairManager to count across all pairs.
     */
    function setFreeMode() external {
        require(!isUniverseMode, "Treasury: already in Universe Mode");
        require(tier1Matrix != address(0), "Treasury: member tracker not set");
        uint256 memberCount = IMatrixMemberCount(tier1Matrix).totalMembers();
        require(
            memberCount >= FREE_MODE_MEMBER_THRESHOLD,
            "Treasury: need 500+ members first"
        );
        isUniverseMode = true;
        emit UniverseModeActivated(block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PancakeSwap liquidity hook (Universe Mode only)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Add initial liquidity to the Aerodrome CNOVA/USDC pool on Base.
     *         Owner pre-approves both tokens to the Aerodrome router,
     *         then calls this function which forwards the addLiquidity call.
     *
     *         Aerodrome Router on Base: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
     *
     * NOTE: This is a convenience wrapper. The owner must separately approve
     *       the router to spend USDC from Treasury and CNOVA from their wallet.
     *       Detailed Aerodrome integration is handled in the deploy script.
     */
    function addDexLiquidity(
        address router,
        uint256 cnovaAmount,
        uint256 usdcAmount,
        uint256 cnovaMin,
        uint256 usdcMin,
        uint256 deadline
    ) external onlyOwner nonReentrant {
        require(isUniverseMode, "Treasury: Universe Mode required");
        require(router != address(0), "Treasury: zero router");
        require(usdcAmount <= usdcReserve, "Treasury: not enough reserve");
        // V8.48 item 5 — owner-decided 2026-08-07: HARD floor guard, no override,
        // no timelock escape. The floor's public promise is "it can only ever go
        // up — never down — by design" (floorPrice() doc above); this makes that
        // promise a contract invariant rather than an intention. CONSEQUENCE,
        // decided with eyes open: since floor = usdcReserve / supply and this
        // function spends reserve without reducing supply, any usdcAmount > 0
        // fails the check below — reserve-funded DEX liquidity is intentionally
        // impossible until a design routes NON-reserve funds to it.
        uint256 floorBefore = floorPrice();

        // Transfer tokens to self for the call (CNOVA from owner, USDC from reserve)
        cnova.transferFrom(msg.sender, address(this), cnovaAmount);

        // Approve router
        IERC20(address(cnova)).approve(router, cnovaAmount);
        usdc.approve(router, usdcAmount);

        // Call Aerodrome router addLiquidity (compatible with Uniswap V2 interface)
        IDexRouter(router).addLiquidity(
            address(cnova),
            address(usdc),
            cnovaAmount,
            usdcAmount,
            cnovaMin,
            usdcMin,
            owner(),
            deadline
        );

        // Deduct USDC used from tracked reserve
        usdcReserve -= usdcAmount;

        require(floorPrice() >= floorBefore, "Treasury: floor would drop");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Emergency — owner only
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Emergency USDC withdrawal. Emits a public event for transparency.
     *         Should never be used in normal operation.
     *         Best practice: protect with a Timelock controller at deploy.
     */
    function emergencyWithdraw(
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyOwner nonReentrant {
        require(to != address(0), "Treasury: zero to");
        require(amount <= usdcReserve, "Treasury: exceeds reserve");
        // V8.48 item 5 — owner-decided 2026-08-07: HARD floor guard, no override.
        // Once CNOVA supply exists, any reserve withdrawal lowers the floor, so
        // this function is INTENTIONALLY unusable against member-backing reserve
        // ("emergencyWithdraw becomes unusable against reserve" — the decision,
        // verbatim). It still works in the window before the first mint: with
        // supply 0, floorPrice() returns the constant seed on both reads.
        uint256 floorBefore = floorPrice();
        usdcReserve -= amount;
        require(floorPrice() >= floorBefore, "Treasury: floor would drop");
        usdc.safeTransfer(to, amount);
        emit EmergencyWithdraw(to, amount, reason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Floor price in 6-decimal USDC units (same as floorPrice()).
    ///         Provided as a named alias for frontend clarity.
    ///         e.g. returns 30_000 → display as "$0.030000" (divide by 1e6 for dollars)
    ///
    ///         Frontend usage:
    ///           const floorUSD = Number(floorPriceFormatted()) / 1e6;
    ///           // floorUSD = 0.03  →  display "$0.03 per CNOVA"
    function floorPriceFormatted() external view returns (uint256 dollars6dec) {
        return floorPrice(); // already in 6-decimal USDC units — no conversion needed
    }

    /// @notice Total USDC held in reserve (pass-through for frontend convenience).
    function reserveBalance() external view returns (uint256) {
        return usdcReserve;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal interface for member count check (avoids circular import)
// ─────────────────────────────────────────────────────────────────────────────
interface IMatrixMemberCount {
    function totalMembers() external view returns (uint256);
    function memberJoinedAt(address member) external view returns (uint256);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEX router interface — Uniswap V2 compatible (Aerodrome on Base)
// Aerodrome Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
// ─────────────────────────────────────────────────────────────────────────────
interface IDexRouter {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        external
        returns (
            uint256 amountA,
            uint256 amountB,
            uint256 liquidity
        );
}
