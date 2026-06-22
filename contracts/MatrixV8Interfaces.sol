// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared interfaces for FigureEightMatrixV8.sol and MatrixLogicLib.sol.
///         Pulled out to a standalone file so the library and the matrix contract
///         can both depend on these without a circular import between them.

interface ICommunityWalletV8 {
    function deposit(uint256 amount) external;
}

interface ITierRouter {
    function handleCycleOut(
        address member,
        uint8   tierIndex,
        uint256 escrow,
        uint256 withdrawable
    ) external;
    function onCrossToMatB(address member, uint8 tierIndex) external;
    function memberHighestTier(address member) external view returns (uint8);
    function reservedFor(address member) external view returns (uint256);
}

interface IStabilityFund {
    function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external;
    function payCoRescue(uint8 tierIdx, uint256 sfShare) external;
}

/// @notice Minimal cross-instance interface -- used when matrix A needs to call
///         matrix B (its Figure-8 partner, or a chained matrix in the same tier).
///         Avoids needing the full concrete FigureEightMatrixV8 type, which would
///         otherwise force a circular import between the contract and the library.
interface IFigureEightMatrixV8Cross {
    function _enterMatrix(address member, address referrer) external;
    function ENTRY_FEE() external view returns (uint256);
}
