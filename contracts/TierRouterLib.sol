// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILPair {
    function registerFor(address member, address referrer, uint256 targetPairIndex) external;
    function registerForMatB(address member, address referrer, uint256 targetPairIndex) external;
    function pairCount() external view returns (uint256);
    function getPairAt(uint256 idx) external view returns (address, address);
}

interface ILMat {
    function deductForUpgrade(address member, uint256 escrowAmt, uint256 withdrawableAmt) external;
    function freeWithdrawable(address member) external view returns (uint256);
    function pairIndex() external view returns (uint256);
    function partner() external view returns (address);
    function isActiveInMatrix(address member) external view returns (bool);
    function routerWithdrawFor(address member, uint256 amount) external;
    function withdrawableOf(address member) external view returns (uint256);
    function reservedHeldOf(address member) external view returns (uint256);
}

interface ILPairRoom {
    function graduationTargetFor(address member, uint256 fromPairIndex) external view returns (uint256);
}

interface ILSF {
    function memberDebtOf(address member) external view returns (uint256);
    function receiveDebtRepayment(address member, uint256 amount) external;
}

/// @title  TierRouterLib
/// @notice EIP-170 headroom: the param-only leaf helpers of TierRouter's upgrade path
///         plus the V8.47 debt-fold, extracted to a LINKED library (delegatecall). All
///         functions run in TierRouter's context — `address(this)` is the router and
///         `msg.sender` on outbound calls is the router — so USDC approvals/pulls and
///         PairManager/matrix registrations behave exactly as the inlined code did.
library TierRouterLib {
    using SafeERC20 for IERC20;

    /// @notice Re-entry ALWAYS returns to the member's own MatA. A -> B -> A.
    ///
    ///         V8.48: `toMatB` is now ALWAYS false. It used to be set when the member
    ///         already occupied their own MatA, sending the re-entry to their own MatB
    ///         instead — but V8.46's UNIVERSAL PAIR GUARD (MatrixLogicLib:278) refuses a
    ///         seat when the member holds the PARTNER, so that destination could never
    ///         succeed. The re-entry reverted, V8.46-C caught it, and the member PARKED —
    ///         for want of a seat that existed one pair over.
    ///
    ///         Item 10 reached exactly this conclusion for the sibling path and recorded
    ///         it in V8_48_SCOPE.md: *"steering an already-seated member to MatB swaps one
    ///         revert for another"*. `rescueReentry` was fixed then; this was not, so the
    ///         owner's SECOND ROUTE (A -> B -> A **2nd pair**, taken when the member
    ///         already holds a seat in this pair) existed on the rescue path and on the
    ///         double, but never on ordinary re-entry.
    ///
    ///         The duplicate case is now handled ONE LEVEL DOWN, in
    ///         PairManagerV8.registerFor — the single chokepoint every TierRouter seating
    ///         passes through — so re-entry, double and upgrade are all covered by one
    ///         guard rather than three patched call sites. Same doctrine as the V8.46 seat
    ///         guard. `registerForMatB` is unreachable as a result; see V8_48_SCOPE.md.
    ///         V8.50 ITEM G — GRADUATION, AND IT IS OFF BY DEFAULT.
    ///
    ///         `graduate` is TierRouter.graduationEnabled, which ships FALSE. With it
    ///         false this function behaves EXACTLY as V8.48 left it, byte for byte in
    ///         effect — that is deliberate, so the contract can be deployed without
    ///         changing live behaviour and the switch thrown separately.
    ///
    ///         With it true, and ONLY when the member's own pair is full in BOTH halves,
    ///         the re-entry goes to the next pair that genuinely has room. Measured
    ///         reason (V8_50_HANDOFF 49.1e, confirmed on chain by `noseat_witness.js`):
    ///         a saturated pair cannot absorb anybody. An arrival frees one MatA seat by
    ///         cycling its root out, and this very re-entry consumes that seat, so the
    ///         arrival parks with shortfall 0 — 105 of 105 live no-seat parks had a
    ///         same-transaction witness taking the seat. Sending this root onward instead
    ///         leaves the freed seat for the arrival AND puts a member into the empty
    ///         pair next door (T1.2: 244 free seats, rotation 0, nobody has ever reached
    ///         it because this line has always said "own MatA. Always.").
    ///
    ///         ⛔ THE READ IS try-WRAPPED AND FAILS TOWARD OWN-MatA. This runs inside
    ///         _cycleOutRoot, which has no try/catch above it: a revert here would kill
    ///         an unrelated member's transaction (T3.1/T4.1, 2026-07-28).
    ///
    ///         ⚠ THIS IS NOT A LICENCE TO DIVERT RE-ENTRY GENERALLY. The branch V8.48
    ///         removed sent re-entry to own MatB whenever a CUMULATIVE lifetime counter
    ///         was crossed — every pair crossed it permanently, MatA lost its entry
    ///         source from both directions and froze (measured 2026-07-26, all 10 tiers).
    ///         This branch fires only at genuine both-halves saturation, and the arriving
    ///         member still enters MatA, so MatA keeps exactly the entry source that
    ///         incident proved it needs.
    function sameTierTarget(address matrixB, address member, address pairManager, bool graduate)
        external view returns (bool toMatB, uint256 target)
    {
        target = ILMat(matrixB).pairIndex();      // own pair
        toMatB = false;                           // own MatA. Always.
        if (!graduate || pairManager == address(0)) return (toMatB, target);
        try ILPairRoom(pairManager).graduationTargetFor(member, target) returns (uint256 alt) {
            if (alt != type(uint256).max) target = alt;
        } catch { /* unreadable → own MatA, exactly as before */ }
    }

    /// @notice Draw a member's FREE earnings from one matrix toward `remaining`, returning
    ///         the still-outstanding amount. Soft — a matrix that reverts is skipped.
    function drawFreeEarnings(address mat, address member, uint256 remaining)
        external returns (uint256)
    {
        if (mat == address(0) || remaining == 0) return remaining;
        uint256 avail;
        try ILMat(mat).freeWithdrawable(member) returns (uint256 a) { avail = a; } catch { return remaining; }
        if (avail == 0) return remaining;
        uint256 take = avail >= remaining ? remaining : avail;
        try ILMat(mat).deductForUpgrade(member, 0, take) { return remaining - take; }
        catch { return remaining; }
    }

    /// @notice V8.48 (item 3): draw up to `remaining` of `member`'s FREE earnings from
    ///         every matrix of ONE tier, paid TO THE MEMBER, returning the amount still
    ///         outstanding. Runs delegatecalled inside TierRouter, so the matrices see
    ///         the router as caller and routerWithdrawFor's _onlyTierRouter passes.
    ///         Soft on failure, same doctrine as drawFreeEarnings above: an unreadable
    ///         pair manager or matrix is SKIPPED — one bad matrix must not sink the
    ///         whole withdrawal, which is the exact defect this function retires from
    ///         the dapp's per-matrix loop. Each take is capped at freeWithdrawable(),
    ///         the item-1 withdrawCore mirror that returns 0 anywhere withdrawCore
    ///         would revert, so the expected path never trips the try/catch — the
    ///         catch is for the unforeseen, not the routine.
    function drawTierToMember(address pm, address member, uint256 remaining)
        external returns (uint256)
    {
        if (pm == address(0) || remaining == 0) return remaining;
        uint256 n;
        try ILPair(pm).pairCount() returns (uint256 c) { n = c; } catch { return remaining; }
        for (uint256 p = 0; p < n; p++) {
            if (remaining == 0) break;
            address mA;
            address mB;
            try ILPair(pm).getPairAt(p) returns (address a, address b) { mA = a; mB = b; }
            catch { continue; }
            remaining = _drawMatrixToMember(mA, member, remaining);
            remaining = _drawMatrixToMember(mB, member, remaining);
        }
        return remaining;
    }

    /// @notice V8.48 item 2: sum reservedHeldOf across every matrix of ONE tier.
    ///         TierRouter.reservedHeldFor calls this with the member's HIGHEST tier —
    ///         the only tier where withdrawCore enforces the reserve, so the only one
    ///         that can hold anything. STRICT, no try/catch: this is a view, and a
    ///         failed read coming back as 0 is exactly the fabricated-fallback class
    ///         the 2026-08-12 session note bans. A revert must reach the caller as a
    ///         revert, never as a plausible zero.
    function heldTierForMember(address pm, address member) external view returns (uint256 held) {
        if (pm == address(0)) return 0;
        uint256 n = ILPair(pm).pairCount();
        for (uint256 p = 0; p < n; p++) {
            (address mA, address mB) = ILPair(pm).getPairAt(p);
            if (mA != address(0)) held += ILMat(mA).reservedHeldOf(member);
            if (mB != address(0)) held += ILMat(mB).reservedHeldOf(member);
        }
    }

    /// @notice V8.48: the V8.44 FULL sweep's tier loop, relocated here verbatim from
    ///         TierRouter.bulkWithdraw()/_sweepMatrix when the item-3 overload pushed
    ///         the router past EIP-170 (24,724 bytes). Same semantics: every matrix
    ///         with any raw balance gets a full routerWithdrawFor(member, 0); zero
    ///         balances and failures are skipped silently.
    function sweepTierToMember(address pm, address member) external {
        if (pm == address(0)) return;
        uint256 n;
        try ILPair(pm).pairCount() returns (uint256 c) { n = c; } catch { return; }
        for (uint256 p = 0; p < n; p++) {
            address mA;
            address mB;
            try ILPair(pm).getPairAt(p) returns (address a, address b) { mA = a; mB = b; }
            catch { continue; }
            _sweepMatrixToMember(mA, member);
            _sweepMatrixToMember(mB, member);
        }
    }

    function _sweepMatrixToMember(address mat, address member) internal {
        if (mat == address(0)) return;
        try ILMat(mat).withdrawableOf(member) returns (uint256 bal) {
            if (bal == 0) return;
        } catch { return; }
        try ILMat(mat).routerWithdrawFor(member, 0) {} catch {}
    }

    function _drawMatrixToMember(address mat, address member, uint256 remaining)
        internal returns (uint256)
    {
        if (mat == address(0) || remaining == 0) return remaining;
        uint256 avail;
        try ILMat(mat).freeWithdrawable(member) returns (uint256 a) { avail = a; } catch { return remaining; }
        if (avail == 0) return remaining;
        uint256 take = avail >= remaining ? remaining : avail;
        try ILMat(mat).routerWithdrawFor(member, take) { return remaining - take; }
        catch { return remaining; }
    }

    /// @notice Fund a seat: deduct `fee` from the member's matrix escrow-then-withdrawable,
    ///         approve the destination PairManager, register. Returns the reduced buckets.
    ///         (Caller records the entry timestamp afterwards.)
    function takeSeat(
        address pm,
        IERC20  usdc,
        address matrixB,
        address member,
        address referrer,
        uint256 fee,
        uint256 targetPairIndex,
        bool    toMatB,
        uint256 escrow,
        uint256 withdrawable
    ) external returns (uint256, uint256) {
        uint256 fromEscrow = escrow >= fee ? fee : escrow;
        uint256 fromW      = fee - fromEscrow;
        ILMat(matrixB).deductForUpgrade(member, fromEscrow, fromW);
        usdc.forceApprove(pm, fee);
        if (toMatB) ILPair(pm).registerForMatB(member, referrer, targetPairIndex);
        else        ILPair(pm).registerFor(member, referrer, targetPairIndex);
        return (escrow - fromEscrow, withdrawable - fromW);
    }

    /// @notice V8.47 wallet-funded upgrade gate: pull the member's outstanding rescue debt
    ///         from their wallet and repay the SF. Reverts if the wallet can't cover it.
    function walletFold(address sf, IERC20 usdc, address member) external {
        if (sf == address(0)) return;
        uint256 debt = ILSF(sf).memberDebtOf(member);
        if (debt == 0) return;
        usdc.safeTransferFrom(member, address(this), debt);
        usdc.forceApprove(sf, debt);
        ILSF(sf).receiveDebtRepayment(member, debt);
    }

    /// @notice V8.47 auto (cycle-out) upgrade gate: repay `debt` from the member's matrix
    ///         earnings first, then escrow. Returns the reduced (escrow, withdrawable).
    function autoFold(
        address sf,
        IERC20  usdc,
        address matrixB,
        address member,
        uint256 debt,
        uint256 escrow,
        uint256 withdrawable
    ) external returns (uint256, uint256) {
        if (debt == 0) return (escrow, withdrawable);
        uint256 fromW = withdrawable >= debt ? debt : withdrawable;
        uint256 fromE = debt - fromW;
        ILMat(matrixB).deductForUpgrade(member, fromE, fromW);
        usdc.forceApprove(sf, debt);
        ILSF(sf).receiveDebtRepayment(member, debt);
        return (escrow - fromE, withdrawable - fromW);
    }
}
