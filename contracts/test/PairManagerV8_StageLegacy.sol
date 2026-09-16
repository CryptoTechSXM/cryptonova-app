// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../PairManagerV8.sol";

/**
 * @title  PairManagerV8_StageLegacy
 * @notice TEST-ONLY. The CONTROL arm of `test/V8_54_StageInversion.test.js`.
 *
 *  Audience: the next session of Claude, plus the owner. Nothing deploys this.
 *
 *  Session 85 moved the V8.54 stage inversion INTO production `PairManagerV8._overflowTargetFor`
 *  (waited-longest first, room second). This contract restores the V8.53-and-earlier order
 *  (room first, waited-longest second) so the fixture keeps measuring BOTH orders against the
 *  same arrival sequence. Replaces `PairManagerV8_StageInverted.sol`, which became identical to
 *  production and was retired to archive/. Full reasoning: handoff 62.54 / 62.55.
 */
contract PairManagerV8_StageLegacy is PairManagerV8 {
    constructor(address _usdc, uint256 _entryFee, address _admin)
        PairManagerV8(_usdc, _entryFee, _admin)
    {}

    /// @dev The ONLY override: the pre-V8.54 order. Same helpers, same arguments.
    function _overflowTargetFor(address member, uint256 avoid)
        internal view override returns (uint256)
    {
        uint256 alt = _pairWithRoomFor(member, avoid);
        if (alt == type(uint256).max) alt = _fullPairWaitingLongest(member, avoid);
        return alt;
    }
}
