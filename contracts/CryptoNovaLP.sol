// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CryptoNovaLP
 * @notice Minimal constant-product AMM (x*y=k) for the USDC/CNOVA trading pair.
 *         Provides on-chain price discovery alongside the CNOVADirectSale bonding curve.
 *         LP providers deposit both tokens and earn 0.30% of every swap.
 *
 * Decimal note:
 *   USDC  = 6 decimals  (1 USDC  = 1_000_000)
 *   CNOVA = 18 decimals (1 CNOVA = 1_000_000_000_000_000_000)
 *   All reserve math works in raw token units — no normalisation needed.
 *   getCNOVAPrice() returns USDC-per-CNOVA scaled by 1e18 for precision.
 */
contract CryptoNovaLP is ERC20, Ownable {

    // ── Immutables ────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IERC20 public immutable cnova;

    // ── State ─────────────────────────────────────────────────────────────
    uint256 public reserveUSDC;
    uint256 public reserveCNOVA;

    // Accumulated swap fees (stay in the pool — LP value grows automatically)
    uint256 public feesUSDC;
    uint256 public feesCNOVA;

    // ── Constants ─────────────────────────────────────────────────────────
    uint256 public constant FEE_BPS       = 30;    // 0.30% swap fee
    uint256 public constant BPS           = 10_000;
    uint256 private constant MIN_LIQ      = 1_000; // permanently locked on first mint

    // ── Events ────────────────────────────────────────────────────────────
    event LiquidityAdded(
        address indexed provider,
        uint256 usdcAmount,
        uint256 cnovaAmount,
        uint256 lpMinted
    );
    event LiquidityRemoved(
        address indexed provider,
        uint256 usdcAmount,
        uint256 cnovaAmount,
        uint256 lpBurned
    );
    event Swap(
        address indexed user,
        bool    usdcIn,          // true = USDC→CNOVA, false = CNOVA→USDC
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeCharged
    );

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(address _usdc, address _cnova)
        ERC20("CryptoNova LP", "CNOVA-LP")
        Ownable(msg.sender)
    {
        require(_usdc   != address(0), "Zero USDC");
        require(_cnova  != address(0), "Zero CNOVA");
        usdc  = IERC20(_usdc);
        cnova = IERC20(_cnova);
    }

    // ── Internal: Babylonian sqrt ─────────────────────────────────────────
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    // ── Add Liquidity ─────────────────────────────────────────────────────
    /**
     * @notice Deposit USDC and CNOVA to earn LP tokens.
     *         First call seeds the pool at whatever ratio is supplied.
     *         Subsequent calls must respect the current pool ratio within
     *         the amounts provided (excess is NOT refunded — caller should
     *         pre-calculate exact proportions via getReserves()).
     * @param usdcAmount  USDC to deposit (6 dec)
     * @param cnovaAmount CNOVA to deposit (18 dec)
     * @return lpMinted   LP tokens minted to msg.sender
     */
    function addLiquidity(uint256 usdcAmount, uint256 cnovaAmount)
        external
        returns (uint256 lpMinted)
    {
        require(usdcAmount > 0 && cnovaAmount > 0, "LP: zero amounts");

        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        cnova.transferFrom(msg.sender, address(this), cnovaAmount);

        uint256 supply = totalSupply();

        if (supply == 0) {
            // Geometric mean — prevents price manipulation on initial seed
            lpMinted = _sqrt(usdcAmount * cnovaAmount) - MIN_LIQ;
            _mint(address(0xdead), MIN_LIQ); // lock MIN_LIQ forever
        } else {
            // Proportional to the smaller ratio (conservative, no inflation exploit)
            uint256 lpU = (usdcAmount  * supply) / reserveUSDC;
            uint256 lpC = (cnovaAmount * supply) / reserveCNOVA;
            lpMinted = lpU < lpC ? lpU : lpC;
        }

        require(lpMinted > 0, "LP: insufficient minted");
        _mint(msg.sender, lpMinted);

        reserveUSDC   += usdcAmount;
        reserveCNOVA  += cnovaAmount;

        emit LiquidityAdded(msg.sender, usdcAmount, cnovaAmount, lpMinted);
    }

    // ── Remove Liquidity ──────────────────────────────────────────────────
    /**
     * @notice Burn LP tokens and receive proportional USDC + CNOVA back.
     *         Accumulated swap fees are already reflected in the reserve growth.
     * @param lpAmount LP tokens to burn
     * @return usdcOut  USDC returned
     * @return cnovaOut CNOVA returned
     */
    function removeLiquidity(uint256 lpAmount)
        external
        returns (uint256 usdcOut, uint256 cnovaOut)
    {
        require(lpAmount > 0, "LP: zero LP");
        uint256 supply = totalSupply();

        usdcOut  = (lpAmount * reserveUSDC)  / supply;
        cnovaOut = (lpAmount * reserveCNOVA) / supply;

        require(usdcOut > 0 && cnovaOut > 0, "LP: zero output");

        _burn(msg.sender, lpAmount);
        reserveUSDC  -= usdcOut;
        reserveCNOVA -= cnovaOut;

        usdc.transfer(msg.sender,  usdcOut);
        cnova.transfer(msg.sender, cnovaOut);

        emit LiquidityRemoved(msg.sender, usdcOut, cnovaOut, lpAmount);
    }

    // ── Swap USDC → CNOVA ─────────────────────────────────────────────────
    /**
     * @notice Buy CNOVA with USDC via the AMM.
     * @param usdcIn     USDC to sell (6 dec)
     * @param minCnovaOut Minimum CNOVA to accept (slippage guard)
     * @return cnovaOut  CNOVA received
     */
    function swapUSDCForCNOVA(uint256 usdcIn, uint256 minCnovaOut)
        external
        returns (uint256 cnovaOut)
    {
        require(usdcIn > 0, "LP: zero input");
        require(reserveUSDC > 0 && reserveCNOVA > 0, "LP: no liquidity");

        usdc.transferFrom(msg.sender, address(this), usdcIn);

        // x*y=k with fee: amountOut = (amountIn*(BPS-FEE)*reserveOut) / (reserveIn*BPS + amountIn*(BPS-FEE))
        uint256 usdcInWithFee = usdcIn * (BPS - FEE_BPS);
        cnovaOut = (usdcInWithFee * reserveCNOVA) /
                   (reserveUSDC * BPS + usdcInWithFee);

        require(cnovaOut >= minCnovaOut,      "LP: slippage exceeded");
        require(cnovaOut <  reserveCNOVA,     "LP: insufficient CNOVA reserve");

        uint256 fee = usdcIn - (usdcIn * (BPS - FEE_BPS)) / BPS;
        feesUSDC += fee;

        reserveUSDC  += usdcIn;
        reserveCNOVA -= cnovaOut;

        cnova.transfer(msg.sender, cnovaOut);
        emit Swap(msg.sender, true, usdcIn, cnovaOut, fee);
    }

    // ── Swap CNOVA → USDC ─────────────────────────────────────────────────
    /**
     * @notice Sell CNOVA for USDC via the AMM.
     * @param cnovaIn    CNOVA to sell (18 dec)
     * @param minUsdcOut Minimum USDC to accept (slippage guard)
     * @return usdcOut   USDC received
     */
    function swapCNOVAForUSDC(uint256 cnovaIn, uint256 minUsdcOut)
        external
        returns (uint256 usdcOut)
    {
        require(cnovaIn > 0, "LP: zero input");
        require(reserveUSDC > 0 && reserveCNOVA > 0, "LP: no liquidity");

        cnova.transferFrom(msg.sender, address(this), cnovaIn);

        uint256 cnovaInWithFee = cnovaIn * (BPS - FEE_BPS);
        usdcOut = (cnovaInWithFee * reserveUSDC) /
                  (reserveCNOVA * BPS + cnovaInWithFee);

        require(usdcOut >= minUsdcOut,    "LP: slippage exceeded");
        require(usdcOut <  reserveUSDC,   "LP: insufficient USDC reserve");

        uint256 fee = cnovaIn - (cnovaIn * (BPS - FEE_BPS)) / BPS;
        feesCNOVA += fee;

        reserveCNOVA += cnovaIn;
        reserveUSDC  -= usdcOut;

        usdc.transfer(msg.sender, usdcOut);
        emit Swap(msg.sender, false, cnovaIn, usdcOut, fee);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Current pool reserves
    function getReserves()
        external view
        returns (uint256 _reserveUSDC, uint256 _reserveCNOVA)
    {
        return (reserveUSDC, reserveCNOVA);
    }

    /**
     * @notice Spot CNOVA price in USDC, scaled by 1e18.
     *         e.g. 50_000 = 0.05 USDC per CNOVA (USDC has 6 dec → 50_000 / 1e6 = 0.00005 ... wait)
     *
     *         Correct interpretation:
     *         price = (reserveUSDC [1e6 units] * 1e18) / reserveCNOVA [1e18 units]
     *               = reserveUSDC * 1e12 / reserveCNOVA  (effective)
     *         To convert to human USDC per CNOVA: price / 1e12
     *         Example: 1000 USDC pool, 100_000 CNOVA pool →
     *           price = (1000e6 * 1e18) / (100_000e18) = 1000e6 / 100_000 = 10_000
     *           human price = 10_000 / 1e6 * 1e18 / 1e18 = 0.01 USDC per CNOVA ✓
     */
    function getCNOVAPrice() external view returns (uint256) {
        if (reserveCNOVA == 0) return 0;
        return (reserveUSDC * 1e18) / reserveCNOVA;
    }

    /**
     * @notice Quote USDC→CNOVA swap output and price impact.
     * @return cnovaOut       Expected CNOVA received
     * @return priceImpactBps Price impact in basis points
     */
    function quoteUSDCForCNOVA(uint256 usdcIn)
        external view
        returns (uint256 cnovaOut, uint256 priceImpactBps)
    {
        if (reserveUSDC == 0 || reserveCNOVA == 0 || usdcIn == 0) return (0, 0);
        uint256 usdcInWithFee = usdcIn * (BPS - FEE_BPS);
        cnovaOut = (usdcInWithFee * reserveCNOVA) / (reserveUSDC * BPS + usdcInWithFee);
        if (cnovaOut == 0) return (0, 0);
        // spot execution price vs spot pool price
        uint256 spotPrice = (reserveUSDC  * 1e18) / reserveCNOVA;          // USDC per CNOVA
        uint256 execPrice = (usdcIn       * 1e18) / cnovaOut;              // USDC per CNOVA paid
        priceImpactBps = execPrice > spotPrice
            ? ((execPrice - spotPrice) * BPS) / spotPrice
            : 0;
    }

    /**
     * @notice Quote CNOVA→USDC swap output and price impact.
     * @return usdcOut        Expected USDC received
     * @return priceImpactBps Price impact in basis points
     */
    function quoteCNOVAForUSDC(uint256 cnovaIn)
        external view
        returns (uint256 usdcOut, uint256 priceImpactBps)
    {
        if (reserveUSDC == 0 || reserveCNOVA == 0 || cnovaIn == 0) return (0, 0);
        uint256 cnovaInWithFee = cnovaIn * (BPS - FEE_BPS);
        usdcOut = (cnovaInWithFee * reserveUSDC) / (reserveCNOVA * BPS + cnovaInWithFee);
        if (usdcOut == 0) return (0, 0);
        uint256 spotPrice = (reserveUSDC * 1e18) / reserveCNOVA;           // USDC per CNOVA
        uint256 execPrice = (usdcOut     * 1e18) / cnovaIn;                // USDC per CNOVA received
        priceImpactBps = execPrice < spotPrice
            ? ((spotPrice - execPrice) * BPS) / spotPrice
            : 0;
    }

    /// @notice LP token share of a given provider, in basis points
    function getLPShare(address provider) external view returns (uint256 shareBps) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        return (balanceOf(provider) * BPS) / supply;
    }

    /// @notice Calculate exact CNOVA amount to deposit for a given USDC amount
    ///         to maintain current pool ratio (for subsequent addLiquidity calls)
    function getOptimalCNOVAForUSDC(uint256 usdcAmount)
        external view
        returns (uint256 cnovaNeeded)
    {
        if (reserveUSDC == 0) return 0;
        return (usdcAmount * reserveCNOVA) / reserveUSDC;
    }

    /// @notice Calculate exact USDC amount to deposit for a given CNOVA amount
    function getOptimalUSDCForCNOVA(uint256 cnovaAmount)
        external view
        returns (uint256 usdcNeeded)
    {
        if (reserveCNOVA == 0) return 0;
        return (cnovaAmount * reserveUSDC) / reserveCNOVA;
    }
}
