// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal interface for CNOVAToken — only the mint function this contract needs.
interface ICNOVAMintable {
    function mintDirect(address to, uint256 amount) external;
    function totalSupply() external view returns (uint256);
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

    // ── SF / LQ targets (6-dec USDC) ─────────────────────────────────────────
    uint256 public sfTarget;   // default $500
    uint256 public lqTarget;   // default $1 000

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

        (
            uint256 cnovaOut,
            uint256 toTreasury,
            uint256 toSF,
            uint256 toLQ
        ) = _computePurchase(usdcAmount);

        require(cnovaOut > 0, "DS: zero CNOVA out");

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
