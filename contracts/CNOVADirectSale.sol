// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal interface for CNOVAToken — only what this contract needs.
interface ICNOVAMintable {
    function mintDirect(address to, uint256 amount) external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title  CNOVADirectSale
 * @notice Allows anyone to purchase CNOVA with USDC via a bonding curve.
 *
 *  Price model
 *  ───────────
 *  Floor price  = Treasury USDC balance ÷ CNOVA total supply
 *  Tier price   = floor × multiplier  (multiplier rises with supply)
 *
 *  Curve tiers (default, owner-adjustable):
 *    Tier 1:  1.25×  supply  0 → 1 M CNOVA
 *    Tier 2:  1.50×  supply  1M → 5 M CNOVA
 *    Tier 3:  1.75×  supply  5M → 20 M CNOVA
 *    Tier 4:  2.00×  supply  20M + CNOVA
 *
 *  USDC routing per purchase
 *  ──────────────────────────
 *    toTreasury = cnovaOut × floorPrice          (protects token backing)
 *    premium    = usdcIn − toTreasury            (above-floor value)
 *    sfShare    = premium × sfDeficit / totalDeficit   (fills SF to its target)
 *    lqShare    = premium − sfShare              (fills LQ to its target)
 *    If both targets are met: 50/50 premium split.
 *
 *  After routing USDC, the contract mints cnovaOut CNOVA to the buyer.
 *  This contract must hold MINTER_ROLE on CNOVAToken.
 *
 *  Whale caps (owner-adjustable, BPS of CNOVA total supply)
 *  ──────────────────────────────────────────────────────────
 *    maxTxBps     — a single purchase cannot mint more than this % of the
 *                   supply that exists right before the purchase. Stops one
 *                   oversized buy in a single transaction. (0 = disabled)
 *    maxWalletBps — after the purchase, the buyer's TOTAL CNOVA balance
 *                   (not just what they bought here) cannot exceed this % of
 *                   the resulting total supply. Catches accumulation across
 *                   many smaller purchases, not just one big one. (0 = disabled)
 */
contract CNOVADirectSale is Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    // ── Precision constants ────────────────────────────────────────────────────
    uint256 private constant BPS_BASE    = 10_000;
    uint256 private constant CNOVA_DEC   = 1e18;   // CNOVA has 18 decimals
    uint256 private constant USDC_DEC    = 1e6;    // USDC has 6 decimals

    // ── Token + fund addresses ─────────────────────────────────────────────────
    IERC20          public immutable usdc;
    ICNOVAMintable  public immutable cnova;
    address         public immutable treasury;   // CNOVATreasury — floor USDC backing

    address         public stabilityFund;        // StabilityFund — operational rescue
    address         public liquidityReserve;     // LQ wallet/contract — future Aerodrome LP

    /// @notice V8.20: DAO governance contract. Co-governs the params below
    ///         alongside owner -- neither replaces the other (owner keeps emergency backstop).
    address public governance;

    // ── SF / LQ targets (6-dec USDC) ─────────────────────────────────────────
    uint256 public sfTarget;   // default $500
    uint256 public lqTarget;   // default $1 000

    // ── Whale caps (BPS of CNOVA total supply, 0 = disabled) ──────────────────
    uint256 public maxTxBps     = 100; // default 1% of supply per single purchase
    uint256 public maxWalletBps = 500; // default 5% of supply per wallet, cumulative

    // ── Bonding curve ─────────────────────────────────────────────────────────
    struct CurveTier {
        uint256 supplyCeiling;   // 18-dec CNOVA supply — this tier ends when supply exceeds this
        uint256 multBps;         // multiplier in BPS (12500 = 1.25×, 20000 = 2.00×)
    }

    CurveTier[] public curveTiers;

    // ── Events ─────────────────────────────────────────────────────────────────
    event CNOVAPurchased(
        address indexed buyer,
        uint256 usdcIn,
        uint256 cnovaOut,
        uint256 toTreasury,
        uint256 toSF,
        uint256 toLQ
    );
    event TargetsUpdated(uint256 sfTarget, uint256 lqTarget);
    event AddressesUpdated(address stabilityFund, address liquidityReserve);
    event CurveUpdated(uint256 tierCount);
    event CapsUpdated(uint256 maxTxBps, uint256 maxWalletBps);
    event GovernanceSet(address indexed governance);

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _usdc             USDC token address
     * @param _cnova            CNOVAToken address (this contract needs MINTER_ROLE)
     * @param _treasury         CNOVATreasury address (receives toTreasury per purchase)
     * @param _stabilityFund    StabilityFund address (receives sfShare per purchase)
     * @param _liquidityReserve Liquidity reserve wallet/contract (receives lqShare)
     * @param _sfTarget         SF target balance in 6-dec USDC (e.g. 500e6 for $500)
     * @param _lqTarget         LQ target balance in 6-dec USDC (e.g. 1000e6 for $1000)
     */
    constructor(
        address _usdc,
        address _cnova,
        address _treasury,
        address _stabilityFund,
        address _liquidityReserve,
        uint256 _sfTarget,
        uint256 _lqTarget
    ) Ownable(msg.sender) {
        require(_usdc            != address(0), "DS: zero usdc");
        require(_cnova           != address(0), "DS: zero cnova");
        require(_treasury        != address(0), "DS: zero treasury");
        require(_stabilityFund   != address(0), "DS: zero sf");
        require(_liquidityReserve != address(0), "DS: zero lq");

        usdc             = IERC20(_usdc);
        cnova            = ICNOVAMintable(_cnova);
        treasury         = _treasury;
        stabilityFund    = _stabilityFund;
        liquidityReserve = _liquidityReserve;
        sfTarget         = _sfTarget;
        lqTarget         = _lqTarget;

        // Default bonding curve (owner can update via setCurve)
        curveTiers.push(CurveTier({ supplyCeiling:  1_000_000 * CNOVA_DEC, multBps: 12_500 })); // Tier 1: 1.25×
        curveTiers.push(CurveTier({ supplyCeiling:  5_000_000 * CNOVA_DEC, multBps: 15_000 })); // Tier 2: 1.50×
        curveTiers.push(CurveTier({ supplyCeiling: 20_000_000 * CNOVA_DEC, multBps: 17_500 })); // Tier 3: 1.75×
        curveTiers.push(CurveTier({ supplyCeiling: type(uint256).max,       multBps: 20_000 })); // Tier 4: 2.00×
    }

    // ── Core purchase ──────────────────────────────────────────────────────────

    /**
     * @notice Buy CNOVA with USDC.
     * @dev    Caller must have approved this contract to spend `usdcAmount` USDC.
     * @param  usdcAmount  Amount of USDC to spend (6 decimals).
     */
    function buyCNOVA(uint256 usdcAmount) external whenNotPaused {
        require(usdcAmount >= USDC_DEC, "DS: minimum $1 USDC");

        uint256 supplyBefore = cnova.totalSupply();

        (
            uint256 cnovaOut,
            uint256 toTreasury,
            uint256 toSF,
            uint256 toLQ
        ) = _computePurchase(usdcAmount);

        require(cnovaOut > 0, "DS: zero CNOVA out");

        // Per-tx cap: a single purchase can't mint more than maxTxBps of the
        // supply that existed right before this purchase.
        if (maxTxBps > 0) {
            require(
                cnovaOut <= supplyBefore * maxTxBps / BPS_BASE,
                "DS: exceeds per-tx cap"
            );
        }

        // Per-wallet cap: after this purchase, the buyer's TOTAL CNOVA balance
        // (not just this purchase) can't exceed maxWalletBps of the resulting
        // total supply. Catches accumulation across many smaller buys.
        if (maxWalletBps > 0) {
            uint256 supplyAfter  = supplyBefore + cnovaOut;
            uint256 balanceAfter = cnova.balanceOf(msg.sender) + cnovaOut;
            require(
                balanceAfter <= supplyAfter * maxWalletBps / BPS_BASE,
                "DS: exceeds per-wallet cap"
            );
        }

        // Pull USDC from buyer
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Route USDC
        if (toTreasury > 0) usdc.safeTransfer(treasury,         toTreasury);
        if (toSF       > 0) usdc.safeTransfer(stabilityFund,    toSF);
        if (toLQ       > 0) usdc.safeTransfer(liquidityReserve, toLQ);

        // Mint CNOVA to buyer (requires MINTER_ROLE)
        cnova.mintDirect(msg.sender, cnovaOut);

        emit CNOVAPurchased(msg.sender, usdcAmount, cnovaOut, toTreasury, toSF, toLQ);
    }

    // ── View: preview ──────────────────────────────────────────────────────────

    /**
     * @notice Preview purchase amounts without executing.
     * @return cnovaOut    CNOVA the buyer will receive (18 dec)
     * @return toTreasury  USDC routed to Treasury (6 dec)
     * @return toSF        USDC routed to StabilityFund (6 dec)
     * @return toLQ        USDC routed to Liquidity Reserve (6 dec)
     */
    function previewPurchase(uint256 usdcAmount)
        external
        view
        returns (
            uint256 cnovaOut,
            uint256 toTreasury,
            uint256 toSF,
            uint256 toLQ
        )
    {
        return _computePurchase(usdcAmount);
    }

    // ── View: balances for dynamic split UI ───────────────────────────────────

    /// @notice Current USDC balance of the StabilityFund (used to compute deficit).
    function sfBalance() external view returns (uint256) {
        return usdc.balanceOf(stabilityFund);
    }

    /// @notice Current USDC balance of the Liquidity Reserve (used to compute deficit).
    function lqBalance() external view returns (uint256) {
        return usdc.balanceOf(liquidityReserve);
    }

    // ── View: price data ──────────────────────────────────────────────────────

    /**
     * @notice Floor price: USDC per 1 full CNOVA (6-dec USDC, scaled by 1e18 for precision).
     *         Returns 0 if supply is zero.
     */
    function floorPriceE6() external view returns (uint256) {
        return _floorPriceE6();
    }

    /**
     * @notice Current bonding curve tier index (0-based).
     */
    function currentTierIndex() external view returns (uint256) {
        return _tierIndex(cnova.totalSupply());
    }

    /**
     * @notice Current tier multiplier in BPS (e.g. 12500 = 1.25×).
     */
    function currentMultBps() external view returns (uint256) {
        uint256 idx = _tierIndex(cnova.totalSupply());
        return curveTiers[idx].multBps;
    }

    /// @notice Number of tiers in the bonding curve.
    function tierCount() external view returns (uint256) {
        return curveTiers.length;
    }

    // ── Internal math ─────────────────────────────────────────────────────────

    function _computePurchase(uint256 usdcAmount)
        internal
        view
        returns (
            uint256 cnovaOut,
            uint256 toTreasury,
            uint256 toSF,
            uint256 toLQ
        )
    {
        uint256 supply    = cnova.totalSupply();
        uint256 floorE6   = _floorPriceE6();     // 6-dec USDC per 1 CNOVA (i.e. per 1e18 cnova units)
        require(floorE6 > 0, "DS: floor price is zero (no supply yet)");

        uint256 idx       = _tierIndex(supply);
        uint256 multBps   = curveTiers[idx].multBps;

        // tierPriceE6 = price (6-dec USDC) of 1 full CNOVA
        // floorE6 is scaled: (treasuryBal * 1e18 / supply), so it's already in
        // 6-dec USDC per 1e18 CNOVA units, meaning per 1 CNOVA.
        uint256 tierPriceE6 = floorE6 * multBps / BPS_BASE;
        require(tierPriceE6 > 0, "DS: tier price is zero");

        // cnovaOut (18 dec) = usdcAmount (6 dec) * 1e18 / tierPriceE6
        cnovaOut = usdcAmount * CNOVA_DEC / tierPriceE6;

        // toTreasury = floor value of CNOVA purchased (protects backing ratio)
        // = cnovaOut * floorE6 / 1e18
        toTreasury = cnovaOut * floorE6 / CNOVA_DEC;

        // Ensure no rounding overflow
        if (toTreasury > usdcAmount) toTreasury = usdcAmount;

        uint256 premium = usdcAmount - toTreasury;

        // Deficit-weighted SF/LQ split
        uint256 sfBal = usdc.balanceOf(stabilityFund);
        uint256 lqBal = usdc.balanceOf(liquidityReserve);

        uint256 sfDeficit = sfBal < sfTarget ? sfTarget - sfBal : 0;
        uint256 lqDeficit = lqBal < lqTarget ? lqTarget - lqBal : 0;
        uint256 totalDeficit = sfDeficit + lqDeficit;

        if (totalDeficit == 0) {
            toSF = premium / 2;
            toLQ = premium - toSF;   // handles odd wei
        } else {
            toSF = premium * sfDeficit / totalDeficit;
            toLQ = premium - toSF;
        }
    }

    function _floorPriceE6() internal view returns (uint256) {
        uint256 supply       = cnova.totalSupply();
        if (supply == 0) return 0;
        uint256 treasuryBal  = usdc.balanceOf(treasury);
        if (treasuryBal == 0) return 0;
        // (6-dec USDC) per (1 full CNOVA) — scaled by 1e18 for integer precision
        // = treasuryBal(6dec) * 1e18 / supply(18dec)
        return treasuryBal * CNOVA_DEC / supply;
    }

    function _tierIndex(uint256 supply) internal view returns (uint256) {
        uint256 n = curveTiers.length;
        for (uint256 i = 0; i < n; i++) {
            if (supply < curveTiers[i].supplyCeiling) return i;
        }
        return n - 1; // last tier (open-ended)
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "DS: not authorized");
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        require(_gov != address(0), "DS: zero governance");
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    /**
     * @notice Update SF and LQ target balances.
     * @param  _sfTarget  New SF target (6-dec USDC, e.g. 500e6)
     * @param  _lqTarget  New LQ target (6-dec USDC, e.g. 1000e6)
     */
    function setTargets(uint256 _sfTarget, uint256 _lqTarget) external onlyOwner {
        sfTarget = _sfTarget;
        lqTarget = _lqTarget;
        emit TargetsUpdated(_sfTarget, _lqTarget);
    }

    /// @notice V8.20: DAO-governable single-value equivalent of setTargets above
    ///         (which stays owner-only as the two-arg convenience setter).
    ///         Allowed: 0,100,250,500,1000,2500 ($).
    function setSfTargetDS(uint256 _sfTarget) external onlyOwnerOrGovernance {
        require(
            _sfTarget == 0 || _sfTarget == 100_000_000 || _sfTarget == 250_000_000 ||
            _sfTarget == 500_000_000 || _sfTarget == 1_000_000_000 || _sfTarget == 2_500_000_000,
            "DS: invalid sfTarget"
        );
        sfTarget = _sfTarget;
        emit TargetsUpdated(_sfTarget, lqTarget);
    }

    /// @notice V8.20: DAO-governable single-value equivalent of setTargets above.
    ///         Allowed: 0,250,500,1000,2500,5000 ($).
    function setLqTargetDS(uint256 _lqTarget) external onlyOwnerOrGovernance {
        require(
            _lqTarget == 0 || _lqTarget == 250_000_000 || _lqTarget == 500_000_000 ||
            _lqTarget == 1_000_000_000 || _lqTarget == 2_500_000_000 || _lqTarget == 5_000_000_000,
            "DS: invalid lqTarget"
        );
        lqTarget = _lqTarget;
        emit TargetsUpdated(sfTarget, _lqTarget);
    }

    /**
     * @notice Update StabilityFund and LiquidityReserve addresses.
     */
    function setAddresses(address _stabilityFund, address _liquidityReserve) external onlyOwner {
        require(_stabilityFund    != address(0), "DS: zero sf");
        require(_liquidityReserve != address(0), "DS: zero lq");
        stabilityFund    = _stabilityFund;
        liquidityReserve = _liquidityReserve;
        emit AddressesUpdated(_stabilityFund, _liquidityReserve);
    }

    /**
     * @notice Replace the bonding curve tiers entirely.
     * @param  ceilings  Supply ceilings (18-dec CNOVA). Last entry should be type(uint256).max.
     * @param  multBpsArr Multipliers in BPS (e.g. [12500, 15000, 17500, 20000]).
     */
    function setCurve(uint256[] calldata ceilings, uint256[] calldata multBpsArr) external onlyOwner {
        require(ceilings.length > 0,                        "DS: empty curve");
        require(ceilings.length == multBpsArr.length,       "DS: length mismatch");
        require(ceilings[ceilings.length - 1] == type(uint256).max, "DS: last ceiling must be max");

        delete curveTiers;
        for (uint256 i = 0; i < ceilings.length; i++) {
            require(multBpsArr[i] >= BPS_BASE, "DS: mult must be >= 1x (10000 BPS)");
            curveTiers.push(CurveTier({ supplyCeiling: ceilings[i], multBps: multBpsArr[i] }));
        }
        emit CurveUpdated(ceilings.length);
    }

    /**
     * @notice Update whale-cap BPS values.
     * @param  _maxTxBps     Max % of supply (BPS) a single purchase may mint. 0 = disabled.
     * @param  _maxWalletBps Max % of resulting supply (BPS) a wallet may hold via this
     *                       contract's purchases, cumulative. 0 = disabled.
     */
    function setCaps(uint256 _maxTxBps, uint256 _maxWalletBps) external onlyOwner {
        require(_maxTxBps     <= BPS_BASE, "DS: maxTxBps > 100%");
        require(_maxWalletBps <= BPS_BASE, "DS: maxWalletBps > 100%");
        maxTxBps     = _maxTxBps;
        maxWalletBps = _maxWalletBps;
        emit CapsUpdated(_maxTxBps, _maxWalletBps);
    }

    /// @notice V8.20: DAO-governable single-value equivalent of setCaps above
    ///         (which stays owner-only as the two-arg convenience setter).
    ///         Allowed: 0,50,100,200,300,500 BPS (0%-5%). 0 = disabled.
    function setMaxTxBps(uint256 _maxTxBps) external onlyOwnerOrGovernance {
        require(
            _maxTxBps == 0 || _maxTxBps == 50 || _maxTxBps == 100 ||
            _maxTxBps == 200 || _maxTxBps == 300 || _maxTxBps == 500,
            "DS: invalid maxTxBps"
        );
        maxTxBps = _maxTxBps;
        emit CapsUpdated(_maxTxBps, maxWalletBps);
    }

    /// @notice V8.20: DAO-governable single-value equivalent of setCaps above.
    ///         Allowed: 0,250,500,1000,1500,2000 BPS (0%-20%). 0 = disabled.
    function setMaxWalletBps(uint256 _maxWalletBps) external onlyOwnerOrGovernance {
        require(
            _maxWalletBps == 0 || _maxWalletBps == 250 || _maxWalletBps == 500 ||
            _maxWalletBps == 1000 || _maxWalletBps == 1500 || _maxWalletBps == 2000,
            "DS: invalid maxWalletBps"
        );
        maxWalletBps = _maxWalletBps;
        emit CapsUpdated(maxTxBps, _maxWalletBps);
    }

    /**
     * @notice How much more CNOVA `buyer` could acquire through this contract right now
     *         before hitting either cap, given current supply. Useful for the frontend
     *         to show "you can buy up to X more" instead of letting the tx revert.
     * @dev    This is a snapshot — both caps move as supply grows, so the real-time
     *         allowance can change between this view call and the actual purchase.
     */
    function remainingAllowance(address buyer) external view returns (uint256 maxCnovaOut) {
        uint256 supply = cnova.totalSupply();

        uint256 txCap = maxTxBps > 0 ? supply * maxTxBps / BPS_BASE : type(uint256).max;

        uint256 walletCap = type(uint256).max;
        if (maxWalletBps > 0) {
            uint256 bal = cnova.balanceOf(buyer);
            // Solve approx headroom against current supply (ignores the buyer's own
            // mint growing the denominator further — a conservative, slightly tighter
            // estimate than the exact on-chain check, which is what we want for a UI hint).
            uint256 capBal = supply * maxWalletBps / BPS_BASE;
            walletCap = capBal > bal ? capBal - bal : 0;
        }

        maxCnovaOut = txCap < walletCap ? txCap : walletCap;
    }

    /// @notice Pause purchases (emergency).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume purchases.
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency USDC rescue — in case any USDC is stuck in this contract.
     * @dev    Under normal operation no USDC should remain here (all routed on buyCNOVA).
     */
    function rescueUSDC(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "DS: zero to");
        usdc.safeTransfer(to, amount);
    }
}
