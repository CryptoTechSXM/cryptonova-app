// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal FigureEightMatrix stand-in for testing MatrixKeeper._doEvictParked's
///         V8.46 item 1 idle gate. Only the functions _doEvictParked calls are implemented;
///         parkedAt / rotationCount are settable so the test can drive the gate directly.
contract MockEvictMatrix {
    uint256 private _parkedAt;
    uint256 private _rotationCount;
    uint256 private _totalWithdrawn;
    bool    public  evicted;

    function setParkedAt(uint256 v)      external { _parkedAt = v; }
    function setRotationCount(uint256 v) external { _rotationCount = v; }
    function setTotalWithdrawn(uint256 v) external { _totalWithdrawn = v; }

    function parkedAt(address) external view returns (uint256) { return _parkedAt; }
    function rotationCount() external view returns (uint256) { return _rotationCount; }
    function getMemberTotalWithdrawn(address) external view returns (uint256) { return _totalWithdrawn; }
    function evictParked(address) external { evicted = true; }
}
