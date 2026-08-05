// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILPair {
    function registerFor(address member, address referrer, uint256 targetPairIndex) external;
    function registerForMatB(address member, address referrer, uint256 targetPairIndex) external;
}

interface ILMat {
    function deductForUpgrade(address member, uint256 escrowAmt, uint256 withdrawableAmt) external;
    function freeWithdrawable(address member) external view returns (uint256);
    function pairIndex() external view returns (uint256);
    function partner() external view returns (address);
    function isActiveInMatrix(address member) external view returns (bool);
}

interface ILSF {
    function memberDebtOf(address member) external view returns (uint256);
    function receiveDebtRepayment(address member, uint256 amount) external;
}

/// @title  TierRouterLib
/// @notice EIP-170 headroom: the param-only leaf helpers of TierRouter's upgrade path
///         plus the V8.47 debt-fold, extracted to a LINKED library (delegatecall). All
///         functions run in TierRouter's context — `address(this)` is the router and
///         `msg.sender` on outbound calls is the router — so USDC approvals/pulls and
///         PairManager/matrix registrations behave exactly as the inlined code did.
library TierRouterLib {
    using SafeERC20 for IERC20;

    /// @notice Re-entry ALWAYS returns to the member's own MatA; toMatB only when the
    ///         member already occupies their own MatA (figure-eight self-sustain).
    function sameTierTarget(address matrixB, address member)
        external view returns (bool toMatB, uint256 target)
    {
        target = ILMat(matrixB).pairIndex();
        address ownMatA = ILMat(matrixB).partner();
        toMatB = ownMatA != address(0) && ILMat(ownMatA).isActiveInMatrix(member);
    }

    /// @notice Draw a member's FREE earnings from one matrix toward `remaining`, returning
    ///         the still-outstanding amount. Soft — a matrix that reverts is skipped.
    function drawFreeEarnings(address mat, address member, uint256 remaining)
        external returns (uint256)
    {
        if (mat == address(0) || remaining == 0) return remaining;
        uint256 avail;
        try ILMat(mat).freeWithdrawable(member) returns (uint256 a) { avail = a; } catch { return remaining; }
        if (avail == 0) return remaining;
        uint256 take = avail >= remaining ? remaining : avail;
        try ILMat(mat).deductForUpgrade(member, 0, take) { return remaining - take; }
        catch { return remaining; }
    }

    /// @notice Fund a seat: deduct `fee` from the member's matrix escrow-then-withdrawable,
    ///         approve the destination PairManager, register. Returns the reduced buckets.
    ///         (Caller records the entry timestamp afterwards.)
    function takeSeat(
        address pm,
        IERC20  usdc,
        address matrixB,
        address member,
        address referrer,
        uint256 fee,
        uint256 targetPairIndex,
        bool    toMatB,
        uint256 escrow,
        uint256 withdrawable
    ) external returns (uint256, uint256) {
        uint256 fromEscrow = escrow >= fee ? fee : escrow;
        uint256 fromW      = fee - fromEscrow;
        ILMat(matrixB).deductForUpgrade(member, fromEscrow, fromW);
        usdc.forceApprove(pm, fee);
        if (toMatB) ILPair(pm).registerForMatB(member, referrer, targetPairIndex);
        else        ILPair(pm).registerFor(member, referrer, targetPairIndex);
        return (escrow - fromEscrow, withdrawable - fromW);
    }

    /// @notice V8.47 wallet-funded upgrade gate: pull the member's outstanding rescue debt
    ///         from their wallet and repay the SF. Reverts if the wallet can't cover it.
    function walletFold(address sf, IERC20 usdc, address member) external {
        if (sf == address(0)) return;
        uint256 debt = ILSF(sf).memberDebtOf(member);
        if (debt == 0) return;
        usdc.safeTransferFrom(member, address(this), debt);
        usdc.forceApprove(sf, debt);
        ILSF(sf).receiveDebtRepayment(member, debt);
    }

    /// @notice V8.47 auto (cycle-out) upgrade gate: repay `debt` from the member's matrix
    ///         earnings first, then escrow. Returns the reduced (escrow, withdrawable).
    function autoFold(
        address sf,
        IERC20  usdc,
        address matrixB,
        address member,
        uint256 debt,
        uint256 escrow,
        uint256 withdrawable
    ) external returns (uint256, uint256) {
        if (debt == 0) return (escrow, withdrawable);
        uint256 fromW = withdrawable >= debt ? debt : withdrawable;
        uint256 fromE = debt - fromW;
        ILMat(matrixB).deductForUpgrade(member, fromE, fromW);
        usdc.forceApprove(sf, debt);
        ILSF(sf).receiveDebtRepayment(member, debt);
        return (escrow - fromE, withdrawable - fromW);
    }
}
