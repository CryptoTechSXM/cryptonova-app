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
    /// @notice Legacy per-matrix repayment. Called by an authorized matrix after
    ///         approving `amount` USDC. SF pulls the USDC and increments totalBalance.
    function receiveDebtRepayment(uint256 amount) external;
    /// @notice V8.32: DAO-votable rescue loan repayment BPS (param #50).
    ///         V8.47: retained as the band-table fallback; live redirect uses clawbackBpsFor.
    function rescueRepayBps() external view returns (uint256);

    // ── V8.47: member-level rescue-debt ledger ("debt follows the account") ────
    /// @notice Total outstanding rescue debt owed by a member across ALL tiers/matrices.
    function memberDebtOf(address member) external view returns (uint256);
    /// @notice Book a rescue loan against the member ledger (loan-issue + migration).
    function increaseMemberDebt(address member, uint8 tier, uint256 amount) external;
    /// @notice Member-keyed repayment. Matrix approves `amount` USDC; SF pulls it and
    ///         clears up to `amount` of the member's outstanding debt.
    function receiveDebtRepayment(address member, uint256 amount) external;
    /// @notice Banded clawback rate (BPS of each earning redirected), keyed to the
    ///         highest tier that issued the member's outstanding debt.
    function clawbackBpsFor(address member) external view returns (uint256);
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
    /// @notice V8.46: is this member seated here? Needed so a matrix can ask its
    ///         PARTNER before seating someone. A seat in either half of a pair is
    ///         a seat in that pair, and every guard in V8.45 tested only one half
    ///         — which is how 67 duplicate seats formed in five days.
    function isActiveInMatrix(address member) external view returns (bool);
}
