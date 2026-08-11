// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

//
//  TEST-ONLY MOCKS for MatrixKeeperLib's parked-member triage.
//
//  WHY MOCKS AND NOT A REAL FIXTURE
//  V8.48 item 12 turns on a branch that fires only when a parked member's
//  withdrawable + crossing reserve already covers the entry fee — a "zero-debt
//  rescue". A real local fixture CANNOT produce one: members park with roughly 20-28%
//  of a fee in earnings against a flat 50% reserve, so they land near 80% and never
//  cross 100%. Registering 70 members instead of 25 does not move it, because a
//  member's withdrawable freezes the moment they park.
//
//  On chain the state is real but RARE — fastlane.log, 2026-08-11: two zero-debt
//  rescues at 00:03 ($5.00 reserve + $5.44 earnings vs a $10 fee; $12.50 + $14.76 vs
//  $25), then thirteen runs at zero. Roughly one an hour against ~900 parked, cleared
//  within ten minutes of appearing. A point-in-time census samples the residue and
//  sees none — which is exactly why the first version of this change was reverted on
//  the strength of "0 of 240 self-funded".
//
//  So the state is real, and unreachable by construction in a test. Mock the matrix,
//  set the numbers to the ones the chain actually produced, and assert the triage.
//
//  These live in contracts/test/ and must never be referenced by a deploy script.
//

contract MockMatrixK {
    uint256 public ENTRY_FEE;
    bool    public isMatrixA;
    uint256 public rotationCount;          // 0 => _scanMatrix returns early, so the
    uint256 public occupancy;              //      only work items are parked ones
    uint256 public MATRIX_SIZE = 127;
    uint256 public lastRotationTimestamp;
    uint8   public tierIndex;

    address[] private _parked;
    mapping(address => uint256) public parkedAt;
    mapping(address => uint256) public withdrawableOf;
    mapping(address => uint256) public crossingReserveOf;
    mapping(address => uint256) public getMemberTotalWithdrawn;

    constructor(uint256 fee, bool matA) { ENTRY_FEE = fee; isMatrixA = matA; }

    /// @param wd withdrawable, @param rs crossing reserve, @param wdn lifetime withdrawn
    function addParked(address m, uint256 ts, uint256 wd, uint256 rs, uint256 wdn) external {
        _parked.push(m);
        parkedAt[m] = ts;
        withdrawableOf[m] = wd;
        crossingReserveOf[m] = rs;
        getMemberTotalWithdrawn[m] = wdn;
    }
    function clearParked() external { delete _parked; }

    function getParkedCount() external view returns (uint256) { return _parked.length; }
    function getParkedMember(uint256 i) external view returns (address) { return _parked[i]; }

    // ── remaining IFigureEightKeeper surface: inert stubs ─────────────────────
    function lastActivityTime(address) external view returns (uint256) { return block.timestamp; }
    function isInMatrix(address) external pure returns (bool) { return false; }
    function isParked(address) external pure returns (bool) { return true; }
    function matrixPos(address) external pure returns (uint256) { return 0; }
    function posToMember(uint256) external pure returns (address) { return address(0); }
    function rescueDebtOf(address) external pure returns (uint256) { return 0; }
    function nextSlot() external pure returns (uint256) { return 0; }
    function owner() external view returns (address) { return address(this); }
    function reclaimIdleSlot(address) external {}
    function setChainNext(address) external {}
    function forceCrossKeeper(address, uint256, uint256) external {}
    function softParkIdle(address) external {}
    function evictParked(address) external {}
    function keeperForceRotateRoot() external {}
}

contract MockPairManagerK {
    address[] private _a;
    address[] private _b;
    function addPair(address matA, address matB) external { _a.push(matA); _b.push(matB); }
    function activePairCount() external view returns (uint256) { return _a.length; }
    function getPairAt(uint256 i) external view returns (address, address) { return (_a[i], _b[i]); }
    function currentMatA() external view returns (address) { return _a.length > 0 ? _a[0] : address(0); }
    function currentMatB() external view returns (address) { return _b.length > 0 ? _b[0] : address(0); }
    function entryFee() external pure returns (uint256) { return 0; }
}

contract MockTierRouterK {
    // true => the velocity-gate scan skips this tier, keeping the batch to parked work
    function tierVelocityGreen(uint8) external pure returns (bool) { return true; }
    function setTierVelocityGreen(uint8, bool) external {}
    function setDeflationState(uint8) external {}
    function getSystemEntryCount(uint256) external pure returns (uint256) { return 0; }
    function getTierEntryCount(uint8, uint256) external pure returns (uint256) { return 0; }
}

contract MockStabilityFundK {
    uint256 public totalBalance;
    mapping(uint8 => uint256) public balanceByTier;
    constructor(uint256 bal) { totalBalance = bal; }
    function setTier(uint8 t, uint256 v) external { balanceByTier[t] = v; }
    function setTotal(uint256 v) external { totalBalance = v; }
    function payGhostEntry(uint8, address) external {}
    function activateLayer(uint8, bool) external {}
    function payForceCross(uint8, address, uint256) external {}
}
