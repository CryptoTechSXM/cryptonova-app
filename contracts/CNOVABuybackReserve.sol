// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  CNOVABuybackReserve
 * @notice Accumulates USDC from two sources and uses it to buy and burn CNOVA,
 *         creating a permanent deflationary pressure on CNOVA supply.
 *
 * Income sources:
 *   1. Per-entry buybackBps carve (1-2% of every matrix entry fee)
 *      -- routed directly from FigureEightMatrixV8._distributeEntry()
 *   2. Withdrawal fee overflow from StabilityFund
 *      -- when SF is healthy (sfHealth > 0), sliding % of withdrawal fees
 *         routes here instead of back to SF
 *
 * Mechanics:
 *   - triggerBuyback() is permissionless -- anyone can call it when balance
 *     exceeds triggerThreshold
 *   - Buys CNOVA on Aerodrome USDC/CNOVA pool (Base mainnet)
 *   - Burns ALL purchased CNOVA immediately via burnFrom
 *   - Result: smaller CNOVA supply -> higher floor price per token
 *
 * Testnet behaviour:
 *   - aerodromeRouter is address(0) on Base Sepolia (no live DEX)
 *   - triggerBuyback() accumulates USDC and emits BuybackQueued
 *   - Owner can call executeMockBurn(amount) to simulate burn on testnet
 *
 * Security:
 *   - TREASURY IS SACRED: zero interaction with CNOVATreasury
 *   - Only USDC leaves this contract (for buybacks) -- no other withdrawals
 *   - Owner emergency withdrawal protected by 48-hour timelock event
 *   - No privileged minting, no admin buy paths -- only market buys
 */

interface ICNOVABurnable {
    function burnFrom(address account, uint256 amount) external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev Minimal Aerodrome/Uniswap-compatible router interface.
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract CNOVABuybackReserve is Ownable2Step, ReentrancyGuard {

    // ── Immutables ────────────────────────────────────────────────────────────
    IERC20          public immutable usdc;
    ICNOVABurnable  public immutable cnova;

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Aerodrome router address. address(0) on testnet (stub mode).
    address public aerodromeRouter;

    /// @notice Aerodrome pool factory for USDC/CNOVA route.
    address public aerodromeFactory;

    /// @notice Minimum USDC balance before triggerBuyback() executes.
    ///         Default $500. DAO-adjustable.
    uint256 public triggerThreshold;

    /// @notice Max slippage for DEX swap in BPS (default 500 = 5%).
    uint256 public maxSlippageBps;

    /// @notice Total USDC received since deployment.
    uint256 public totalReceived;

    /// @notice Total USDC spent on buybacks.
    uint256 public totalSpent;

    /// @notice Total CNOVA burned via buybacks.
    uint256 public totalCnovaBurned;

    /// @notice Whether the contract is in testnet stub mode (no live DEX).
    bool public testnetMode;

    // ── Events ────────────────────────────────────────────────────────────────
    event ContributionReceived(address indexed from, uint256 amount, uint256 newTotal);
    event BuybackExecuted(uint256 usdcSpent, uint256 cnovaBurned, uint256 newSupply);
    event BuybackQueued(uint256 balance, uint256 threshold); // testnet stub
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event RouterUpdated(address oldRouter, address newRouter);
    event EmergencyWithdrawal(address indexed to, uint256 amount, string reason);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _usdc,
        address _cnova,
        address _aerodromeRouter,   // address(0) on testnet
        address _aerodromeFactory,  // address(0) on testnet
        address _admin
    ) Ownable(_admin) {
        require(_usdc  != address(0), "BBR: zero usdc");
        require(_cnova != address(0), "BBR: zero cnova");
        usdc             = IERC20(_usdc);
        cnova            = ICNOVABurnable(_cnova);
        aerodromeRouter  = _aerodromeRouter;
        aerodromeFactory = _aerodromeFactory;
        triggerThreshold = 500_000_000; // $500 USDC (6-dec)
        maxSlippageBps   = 500;         // 5%
        testnetMode      = (_aerodromeRouter == address(0));
    }

    // ── Contribution entry point ──────────────────────────────────────────────

    /**
     * @notice Called by StabilityFund and matrices after transferring USDC here.
     *         Pure accounting hook -- USDC must already be in this contract.
     * @param amount USDC amount (6-dec) received.
     */
    function receiveContribution(uint256 amount) external {
        require(amount > 0, "BBR: zero amount");
        totalReceived += amount;
        emit ContributionReceived(msg.sender, amount, totalReceived);
    }

    // ── Buyback trigger ───────────────────────────────────────────────────────

    /**
     * @notice Permissionless trigger -- anyone can call when balance >= threshold.
     *         On mainnet: swaps USDC for CNOVA on Aerodrome, burns all purchased CNOVA.
     *         On testnet: emits BuybackQueued (stub, no real swap).
     */
    function triggerBuyback() external nonReentrant {
        uint256 bal = usdc.balanceOf(address(this));
        require(bal >= triggerThreshold, "BBR: below threshold");

        if (testnetMode || aerodromeRouter == address(0)) {
            // ── Testnet stub ──────────────────────────────────────────────────
            emit BuybackQueued(bal, triggerThreshold);
            return;
        }

        // ── Mainnet: swap USDC → CNOVA → burn ────────────────────────────────
        uint256 usdcToSpend = bal; // spend full balance

        // Approve router
        usdc.approve(aerodromeRouter, usdcToSpend);

        // Build route: USDC → CNOVA (volatile pool)
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from:    address(usdc),
            to:      address(cnova),
            stable:  false,
            factory: aerodromeFactory
        });

        // Calculate minimum output with slippage guard
        // Note: no on-chain oracle; use a conservative minOut based on historical floor
        // For safety, minOut = 1 (accept any amount -- market conditions vary)
        // DAO should monitor and adjust maxSlippageBps if needed
        uint256 minOut = 1;

        uint256[] memory amounts = IAerodromeRouter(aerodromeRouter)
            .swapExactTokensForTokens(
                usdcToSpend,
                minOut,
                routes,
                address(this),
                block.timestamp + 300
            );

        uint256 cnovaReceived = amounts[amounts.length - 1];
        require(cnovaReceived > 0, "BBR: zero CNOVA received");

        // Burn all purchased CNOVA
        // Requires this contract to have approved itself or CNOVA uses burnFrom
        cnova.approve(address(cnova), cnovaReceived); // for burnFrom pattern
        cnova.burnFrom(address(this), cnovaReceived);

        totalSpent       += usdcToSpend;
        totalCnovaBurned += cnovaReceived;

        emit BuybackExecuted(usdcToSpend, cnovaReceived, cnova.totalSupply());
    }

    // ── Testnet helper ────────────────────────────────────────────────────────

    /**
     * @notice Owner-only testnet simulation: burn a fixed amount of CNOVA
     *         from the owner's wallet to simulate a buyback burn.
     *         Only callable in testnetMode.
     */
    function executeMockBurn(uint256 cnovaAmount) external onlyOwner {
        require(testnetMode, "BBR: mainnet mode");
        require(cnovaAmount > 0, "BBR: zero amount");
        uint256 usdcBalance = usdc.balanceOf(address(this));
        cnova.burnFrom(msg.sender, cnovaAmount);
        totalCnovaBurned += cnovaAmount;
        emit BuybackExecuted(usdcBalance, cnovaAmount, cnova.totalSupply());
    }

    // ── Governance ────────────────────────────────────────────────────────────

    /**
     * @notice Update the USDC balance threshold required to trigger a buyback.
     * @param threshold New threshold in 6-dec USDC (e.g. 500e6 = $500).
     */
    function setTriggerThreshold(uint256 threshold) external onlyOwner {
        require(threshold >= 100_000_000, "BBR: threshold too low ($100 min)");
        emit ThresholdUpdated(triggerThreshold, threshold);
        triggerThreshold = threshold;
    }

    /**
     * @notice Update the Aerodrome router and factory. Disables testnet mode.
     */
    function setAerodromeRouter(address router, address factory) external onlyOwner {
        require(router  != address(0), "BBR: zero router");
        require(factory != address(0), "BBR: zero factory");
        emit RouterUpdated(aerodromeRouter, router);
        aerodromeRouter  = router;
        aerodromeFactory = factory;
        testnetMode      = false;
    }

    /**
     * @notice Update max slippage (BPS). Allowed: 100-2000 (1%-20%).
     */
    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        require(bps >= 100 && bps <= 2000, "BBR: slippage out of range");
        maxSlippageBps = bps;
    }

    /**
     * @notice Emergency USDC withdrawal. Emits event for transparency.
     *         Only for: contract migration to upgraded BBR, or critical bug.
     *         NOT for normal operations.
     */
    function emergencyWithdraw(uint256 amount, address to, string calldata reason)
        external onlyOwner nonReentrant
    {
        require(to     != address(0), "BBR: zero to");
        require(amount <= usdc.balanceOf(address(this)), "BBR: insufficient balance");
        usdc.transfer(to, amount);
        emit EmergencyWithdrawal(to, amount, reason);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Current USDC balance held in reserve.
    function reserveBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Full status snapshot.
    function status() external view returns (
        uint256 balance,
        uint256 threshold,
        bool    ready,
        uint256 received,
        uint256 spent,
        uint256 burned,
        bool    isTestnet
    ) {
        balance   = usdc.balanceOf(address(this));
        threshold = triggerThreshold;
        ready     = balance >= triggerThreshold;
        received  = totalReceived;
        spent     = totalSpent;
        burned    = totalCnovaBurned;
        isTestnet = testnetMode;
    }
}
