// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev V8.48 item-5 test doubles (V8_48_FloorGuards.test.js).
///
/// MockDexRouter — accepts CNOVATreasury.addDexLiquidity's router call without
/// moving any tokens, so the test can reach the post-call floor guard rather
/// than dying inside a real AMM. Returning zeros is fine: the treasury ignores
/// the return values.
contract MockDexRouter {
    function addLiquidity(
        address, address, uint256, uint256, uint256, uint256, address, uint256
    ) external pure returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        return (0, 0, 0);
    }
}

/// @dev MockMemberCount — stands in for the T1 matrix so setFreeMode()'s
/// 500-member gate passes without registering 500 members.
contract MockMemberCount {
    function totalMembers() external pure returns (uint256) {
        return 500;
    }

    function memberJoinedAt(address) external pure returns (uint256) {
        return 1;
    }
}
