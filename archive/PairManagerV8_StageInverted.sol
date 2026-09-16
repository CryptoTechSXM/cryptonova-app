// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../PairManagerV8.sol";

/**
 * @title  PairManagerV8_StageInverted
 * @notice TEST-ONLY. The treatment arm of `test/V8_54_StageInversion.test.js`.
 *
 *  Audience: the next session of Claude, plus the owner.
 *
 *  ⛔ THIS IS AN INSTRUMENT, NOT A PROPOSED DEPLOY. It exists so the stage order can be
 *     MEASURED before anybody changes the production contract. Nothing deploys this.
 *
 *  WHAT IT CHANGES — exactly one function, exactly two lines swapped:
 *
 *      production  (PairManagerV8._overflowTargetFor)
 *          stage 1  _pairWithRoomFor        — ANY pair with a free MatA seat
 *          stage 2  _fullPairWaitingLongest — the FULL MatA that has waited longest
 *
 *      here
 *          stage 1  _fullPairWaitingLongest
 *          stage 2  _pairWithRoomFor
 *
 *  WHY (handoff 62.54, measured 2026-09-14, session 81). `_hasRoomAndFree` measures room on
 *  MatA ONLY, so a pair whose MatA is full reads as NO ROOM even with its MatB half empty.
 *  The moment a brand-new pair opens with an empty MatA, stage 1 finds it and the ENTIRE
 *  overflow stream goes there — and the older pair's MatB stops being fed. Measured on the
 *  live chain, overflow flows by day (T1.1→T1.2 / T1.1→T1.3):
 *
 *      09-09  42 / 4   ← T1.3 opens
 *      09-10   0 / 59
 *      09-11   0 / 48
 *      09-12  12 / 28  ← T1.3's MatA fills, pair 2 loses "room", stage 2 resumes
 *
 *  T1.2 MatB sat at 115/127 through both zero days. That stall is the six days Sherwyn's
 *  seat did not move.
 *
 *  WHY INVERTING IS BELIEVED TO BE SELF-LIMITING RATHER THAN A NEW STARVATION — and this is
 *  the claim the fixture has to test, not assume: `_fullPairWaitingLongest` already requires
 *  *MatA full AND MatB has room*. Once the older pair's MatB fills, that pair stops
 *  qualifying on its own and stage 2 takes over, so a new pair's MatA still gets to fill.
 *
 *  ✅ NO THRESHOLD, NO CONFIGURED NUMBER, NO SEEDED HOUSE POSITIONS. Both helpers read live
 *     occupancy, which falls when members cycle out. That is what keeps this clear of the
 *     deleted `routeEntryThreshold` (memory `cryptonova-entry-thresholds`): that feature
 *     compared a CUMULATIVE counter against a configured number and froze pairs forever.
 *
 *  ⛔ AND THE SCORING RULE, because it is the trap that fooled everyone in August: the
 *     metric is NOT rotation volume. The deleted 400-threshold regime scored 5,684 rotations
 *     on one MatB with near-zero ladder progress. The fixture scores LADDER PROGRESS —
 *     members who crossed to MatB and members who completed a cycle and left the pair.
 */
contract PairManagerV8_StageInverted is PairManagerV8 {
    constructor(address _usdc, uint256 _entryFee, address _admin)
        PairManagerV8(_usdc, _entryFee, _admin)
    {}

    /// @dev The ONLY override. Same two helpers, same arguments, opposite order.
    ///      Still a view, still never reverts: both helpers are fully try-wrapped and fail
    ///      toward type(uint256).max, which the callers already handle.
    function _overflowTargetFor(address member, uint256 avoid)
        internal view override returns (uint256)
    {
        uint256 alt = _fullPairWaitingLongest(member, avoid);
        if (alt == type(uint256).max) alt = _pairWithRoomFor(member, avoid);
        return alt;
    }
}
