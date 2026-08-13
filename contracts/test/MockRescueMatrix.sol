// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISF {
    function increaseMemberDebt(address member, uint8 tier, uint256 amount) external;
    function receiveDebtRepayment(address member, uint256 amount) external;
    function clawbackBpsFor(address member) external view returns (uint256);
    function memberDebt(address member) external view returns (uint256);
    // V8.48 item 46: member-aware, so the SF can enforce the insolvency floor.
    function payCoRescue(address member, uint8 tierIdx, uint256 sfShare) external;
}

/// @dev Test stand-in for a live matrix: an SF-authorized caller that can book
///      rescue loans on the member ledger and repay them, so the V8.47 ledger can
///      be driven in isolation for the SF-conservation invariant.
contract MockRescueMatrix {
    ISF    public immutable sf;
    IERC20 public immutable usdc;

    constructor(address _sf, address _usdc) {
        sf   = ISF(_sf);
        usdc = IERC20(_usdc);
    }

    /// Book a loan on the member ledger. Models coPayRescue/forceCross issue AND
    /// the migration sweep of a stranded per-matrix debt.
    function bookLoan(address member, uint8 tier, uint256 amount) external {
        sf.increaseMemberDebt(member, tier, amount);
    }

    /// Repay an explicit amount toward a member's debt. Models cycle-out lump and
    /// withdraw-settle. SF caps the applied amount at what's owed.
    function repay(address member, uint256 amount) external {
        usdc.approve(address(sf), amount);
        sf.receiveDebtRepayment(member, amount);
    }

    /// Redirect a fraction of an `earning` toward the member's debt at the banded
    /// clawback rate. Models the pool-share redirect in _settlePoolShare.
    function redirectRepay(address member, uint256 earning) external returns (uint256) {
        uint256 owed = sf.memberDebt(member);
        if (owed == 0 || earning == 0) return 0;
        uint256 amount = earning * sf.clawbackBpsFor(member) / 10_000;
        if (amount > owed) amount = owed;
        if (amount == 0) return 0;
        usdc.approve(address(sf), amount);
        sf.receiveDebtRepayment(member, amount);
        return amount;
    }

    /// Pull a co-rescue payout from the SF (models SF funding a rescue entry).
    /// V8.48 item 46: carries the member so the floor is exercised end-to-end.
    function pullCoRescue(address member, uint8 tier, uint256 amount) external {
        sf.payCoRescue(member, tier, amount);
    }
}
