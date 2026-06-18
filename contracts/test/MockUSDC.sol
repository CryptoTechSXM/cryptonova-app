// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockUSDC
 * @notice Minimal ERC-20 mock for Base Sepolia testnet testing.
 *         Mirrors Circle's native USDC on Base: 6 decimals, symbol "USDC".
 *         Admin can mint to any address for test purposes.
 *         NOT for production use.
 */
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDC is ERC20, Ownable {
    // Base USDC uses 6 decimals — override ERC20's default of 18
    constructor(address admin) ERC20("USD Coin", "USDC") Ownable(admin) {}

    /// @dev Override to return 6 decimals, matching Circle's native USDC on Base.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test USDC to any address (testnet only).
    ///         Amount is in 6-decimal units: 1_000_000 = $1.00
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
