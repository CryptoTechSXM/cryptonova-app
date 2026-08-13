// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal FigureEightMatrix stand-in for testing MatrixKeeper._doEvictParked's
///         V8.46 item 1 idle gate. Only the functions _doEvictParked calls are implemented;
///         parkedAt / rotationCount are settable so the test can drive the gate directly.
///
///         V8.48 items 45/47: _doEvictParked now asks isInMatrix()/partner() first —
///         a GHOST (parked record whose holder is seated) bypasses the time gates,
///         because the matrix-level valve only dequeues for a seated member. The
///         defaults here (not seated, no partner) keep the gate tests meaning what
///         they always meant; setSeated arms the ghost path when a test wants it.
///         The first run after the V8.48 change had this mock WITHOUT these views:
///         the keeper's staticcall reverted, the try/catch swallowed it, and A2
///         read "gate held" for what was actually "mock incomplete".
contract MockEvictMatrix {
    uint256 private _parkedAt;
    uint256 private _rotationCount;
    uint256 private _totalWithdrawn;
    bool    private _seated;
    address private _partner;
    bool    public  evicted;

    function setParkedAt(uint256 v)      external { _parkedAt = v; }
    function setRotationCount(uint256 v) external { _rotationCount = v; }
    function setTotalWithdrawn(uint256 v) external { _totalWithdrawn = v; }
    function setSeated(bool v)           external { _seated = v; }
    function setPartner(address p)       external { _partner = p; }

    function parkedAt(address) external view returns (uint256) { return _parkedAt; }
    function rotationCount() external view returns (uint256) { return _rotationCount; }
    function getMemberTotalWithdrawn(address) external view returns (uint256) { return _totalWithdrawn; }
    function isInMatrix(address) external view returns (bool) { return _seated; }
    function isActiveInMatrix(address) external view returns (bool) { return _seated; }
    function partner() external view returns (address) { return _partner; }
    function evictParked(address) external { evicted = true; }
}
