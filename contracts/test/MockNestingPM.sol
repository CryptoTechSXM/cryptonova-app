// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITierRouterNest {
    function handleCycleOut(address member, uint8 tierIndex, uint256 escrow, uint256 withdrawable) external;
}

/**
 * @title  MockNestingPM
 * @notice Test-only. Forces a NESTED cycle-out so the V8.46-B depth cap can be
 *         proved without manufacturing member wealth.
 *
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The cap counts how many cycle-outs chain inside ONE transaction. Reproducing a
 * real chain requires each root to afford the next seat, and that is the one
 * thing a fresh fixture cannot produce:
 *
 *   - a member's pool income over their whole tenure is 18% of one entry fee
 *     (the pool is 18% per entry, split across the seats)
 *   - re-entry needs 50%, because the crossing reserve covers exactly half
 *   - the gap is closed by REFERRAL income, which only exists if the member has
 *     a downline
 *
 * V8_46_DepthCap ran 60 rotations in each half of a full pair and produced zero
 * nesting for precisely this reason. V8_46_LadderGas hit the same wall from the
 * other direction. That is not a harness defect — it is why the 17.76M cascade
 * only appears on production accounts that have been accruing for days.
 *
 * The cap, though, is a COUNTER, and a counter does not care why the chain is
 * deep. This mock stands in for the PairManager: when TierRouter's additive
 * engine calls registerFor during a cycle-out, it calls handleCycleOut straight
 * back, which is exactly the re-entrancy a real chain produces. Register it as
 * BOTH the tier's PairManager and an authorised matrix and the nesting is
 * deterministic, free, and independent of anyone's balance.
 *
 * Testing the mechanism instead of the symptom. The symptom needed six tiers and
 * days of accrual; the mechanism needs one contract and no money.
 */
contract MockNestingPM {
    ITierRouterNest public router;
    uint8   public tierIndex;
    uint256 public depthToDrive;   // how many times to call back
    uint256 public calls;          // observability: how deep it actually got
    /// @dev Funds handed to each nested handleCycleOut. Must be >= the tier fee
    ///      or _executeAdditive skips re-entry for lack of money and the chain
    ///      stops at depth 1 no matter what the cap says — the same 50%-reserve
    ///      wall that stopped the real fixtures.
    uint256 public escrowToPass;

    constructor(address _router, uint8 _tierIndex) {
        router    = ITierRouterNest(_router);
        tierIndex = _tierIndex;
    }

    function setDepthToDrive(uint256 d) external { depthToDrive = d; }
    function setEscrowToPass(uint256 e) external { escrowToPass = e; }
    function reset() external { calls = 0; }

    /// @dev Matches IPairManagerV8.registerFor. Instead of seating anyone it
    ///      re-enters the router, which is what a real nested cycle-out does
    ///      once the seat it takes rotates a root one level up.
    function registerFor(address member, address, uint256) external {
        if (calls >= depthToDrive) return;
        calls++;
        // No try/catch: if the router reverts we want the test to see it.
        router.handleCycleOut(member, tierIndex, escrowToPass, 0);
    }

    /// @dev Also matches registerForMatB — the double-seat path lands here.
    function registerForMatB(address member, address, uint256) external {
        if (calls >= depthToDrive) return;
        calls++;
        router.handleCycleOut(member, tierIndex, escrowToPass, 0);
    }

    // --- Inert IPairManagerV8 surface, so TierRouter can talk to it ----------
    function registerDirectFor(address, address) external {}
    function entryFee() external pure returns (uint256) { return 0; }
    function currentMatA() external view returns (address) { return address(this); }
    function pairCount() external pure returns (uint256) { return 1; }
    function getPairAt(uint256) external view returns (address, address) {
        return (address(this), address(this));
    }
    function freePairFor(address, uint256) external pure returns (uint256) {
        return type(uint256).max;   // no free pair — doubles are skipped
    }
    function pairs(uint256) external view returns (address, address, uint256, uint256) {
        return (address(this), address(this), 0, 0);
    }
    function rescueReentry(address, address, uint256) external {}

    // --- Inert matrix surface, so it can be registered as an authorised matrix
    function pairIndex() external pure returns (uint256) { return 0; }
    function partner() external view returns (address) { return address(this); }
    function isActiveInMatrix(address) external pure returns (bool) { return false; }
    function deductForUpgrade(address, uint256, uint256) external {}
    function parkCycledOut(address, uint256) external {}
    function releaseReserve(address) external {}
    function ENTRY_FEE() external pure returns (uint256) { return 0; }
}
