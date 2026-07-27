// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RevertingTierRouter
 * @notice Test double for V8.46 item C.
 *
 *         MatrixLogicLib._cycleOutRoot calls handleCycleOut inside a try/catch.
 *         Before V8.46 that catch was EMPTY, so any revert here made the member
 *         vanish: already removed from the seat map, never re-seated, never
 *         parked, no event. This mock forces that revert on demand so the
 *         fallback can be asserted instead of hoped for.
 *
 *         Only the two functions MatrixLogicLib actually calls on the router
 *         during a cycle-out are implemented; globalJoined/memberHighestTier/
 *         reservedFor are stubbed because other paths touch them.
 */
contract RevertingTierRouter {
    bool public shouldRevert = true;

    event HandleCycleOutSeen(address member, uint8 tierIndex);

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function handleCycleOut(
        address member,
        uint8   tierIndex,
        uint256 /*escrow*/,
        uint256 /*withdrawable*/
    ) external {
        if (shouldRevert) revert("mock: handleCycleOut failed");
        emit HandleCycleOutSeen(member, tierIndex);
    }

    function onCrossToMatB(address, uint8) external {}

    // ── stubs for the read paths MatrixLogicLib touches ──────────────────────
    function globalJoined(address) external pure returns (bool)      { return true; }
    function memberHighestTier(address) external pure returns (uint8) { return 1; }
    function reservedFor(address) external pure returns (uint256)     { return 0; }
}
