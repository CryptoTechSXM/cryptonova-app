// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * GateProbe.sol — FIXTURE ONLY, session 17 (2026-08-20). Never deployed.
 *
 * WHY IT EXISTS: the sponsorship gate's cost was first measured end-to-end through
 * V8_50_KeeperGas, and that run changed the POPULATION of keeper work items as well as
 * the cost of each one, so the delta was uninterpretable. This is the second instrument:
 * it measures the ONE added read in isolation, exactly, in gas units rather than in
 * two-decimal millions — and the end-to-end run must then agree with a whole-number
 * multiple of what this reads. If it does not, something calls loanHeadroom more often
 * than the call graph says, and THAT is the finding.
 */

interface ISFHeadroom {
    function loanHeadroom(address member, uint8 tierIdx) external view returns (uint256);
}

contract GateProbe {
    uint256 public costCold;   // first call in the transaction — cold router account + cold slot
    uint256 public costWarm;   // second call, same transaction — both already touched
    uint256 public value;

    /// @dev The two calls are identical. Any difference between them is warm/cold, nothing else.
    function probeTwice(address sf, address member, uint8 tierIdx) external {
        uint256 a = gasleft();
        uint256 v = ISFHeadroom(sf).loanHeadroom(member, tierIdx);
        uint256 b = gasleft();
        ISFHeadroom(sf).loanHeadroom(member, tierIdx);
        uint256 c = gasleft();
        costCold = a - b;
        costWarm = b - c;
        value    = v;
    }
}

/// @dev Stands in for TierRouter's directCount so the probe needs no matrix world.
///      Same storage shape (one uint32 mapping slot per member) and same call shape,
///      which is all the gas depends on.
contract MockDirectRouter {
    mapping(address => uint32) public directCount;
    function highestOpenTier() external pure returns (uint8) { return 1; }
    function setDirects(address m, uint32 n) external { directCount[m] = n; }
}
