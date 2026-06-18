// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  MockTier1Matrix
 * @notice Test helper — reports 500+ members so CNOVATreasury.setFreeMode() succeeds.
 *         Used exclusively in governance tests to activate Universe Mode without
 *         deploying and filling a real matrix.
 *         DO NOT DEPLOY TO MAINNET.
 */
contract MockTier1Matrix {
    function totalMembers() external pure returns (uint256) {
        return 500;
    }
    function memberJoinedAt(address) external pure returns (uint256) {
        return 0;
    }
}
