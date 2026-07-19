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
    /// @notice V8.36: Used by MatrixLogicLib to accept cross-pair referrers.
    ///         Returns true if the address has ever registered via TierRouter.register().
    function globalJoined(address member) external view returns (bool);
}

interface IStabilityFund {
    function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external;
    function payCoRescue(uint8 tierIdx, uint256 sfShare) external;
    /// @notice Called by an authorized matrix after approving `amount` USDC.
    ///         SF pulls the USDC and increments totalBalance.
    function receiveDebtRepayment(uint256 amount) external;
    /// @notice V8.32: DAO-votable rescue loan repayment BPS (param #50).
    function rescueRepayBps() external view returns (uint256);
}

/// @notice Interface for CouponRegistry — used by MatrixLogicLib to redeem coupons during registration.
interface ICouponRegistry {
    function redeemCoupon(bytes32 codeHash, address newMember) external returns (uint256 amount);
    function isValid(bytes32 codeHash) external view returns (bool);
}

/// @notice Minimal cross-instance interface -- used when matrix A needs to call
///         matrix B (its Figure-8 partner, or a chained matrix in the same tier).
///         Avoids needing the full concrete FigureEightMatrixV8 type, which would
///         otherwise force a circular import between the contract and the library.
interface IFigureEightMatrixV8Cross {
    function _enterMatrix(address member, address referrer) external;
    function ENTRY_FEE() external view returns (uint256);
    /// @notice Called by the partner MatA immediately after forceCrossKeeper
    ///         to record the rescue loan on MatB, where the 15% repayment fires.
    function addRescueDebt(address member, uint256 amount) external;
    /// @notice V8.40: used by selfRescue() to fail early if destination is full.
    function isFull() external view returns (bool);
}
