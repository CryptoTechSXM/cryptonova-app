# V8.44 Plan — MatB Cycle-Out: Auto Re-entry Fails for Passive Members + Stranded Crossing Reserves

*Filed: 2026-07-24 ~01:30 UTC, from live community bug reports during the V8.43 stress run.*
*Reporters: Sherwyn (0x7d3c9488…, all accounts), @CryptoJan (0x79470c63…, 4 accounts). Both consistent.*

---

## Symptom

Members with **auto re-entry enabled** cycle out of T1 MatB and are **silently exited** ("graduated") instead of re-entered or parked. They must manually pay a fresh $10 entry to rejoin. Member expectation (and the code's own intent comment) is: re-entry always — or, if underfunded, parked with the self-rescue path available.

## Root cause (verified in source, V8.43)

Three interacting facts:

1. **`MatrixLogicLib._cycleOutRoot`** (MatB branch) calls
   `ITierRouter.handleCycleOut(root, tierIndex, 0, withdrawable)` — **escrow hardcoded to 0**.
   The additive engine's budget is the member's MatB withdrawable only.

2. **The member has invisible funds.** The MatA→MatB crossing is itself a fee-paying entry, so
   `_distributePayments` allocated the member a **fresh 50% crossing reserve inside MatB**
   (comment: "funds member's next crossing"). At T1 that is $5.00 — excluded from the budget in (1).

3. **`TierRouter._executeAdditive`** guards each step with `funds >= fee` and **silently skips** when
   short. Its own header comment says *"auto-reentry ON → member NEVER graduates"* — but a passive
   member's MatB withdrawable (pool drips + stray chain pay, typically $2–4 at T1) is always < $10,
   so re-entry never fires for them. No parking occurs on the MatB cycle-out path (parking exists
   only in `_crossToPartner`, the MatA path). Result: silent exit.

4. **The $5 reserve is stranded.** After exit: `withdraw()` pays withdrawable only;
   `selfRescue()` requires `parkedAt > 0` (they are not parked); `deductForUpgrade(member, escrowAmt,
   withdrawableAmt)` transfers `escrowAmt` USDC but **never decrements any member field for it** —
   which is precisely why TierRouter passes 0. The reserve is unreachable by any member-facing path.

## Impact (as of filing)

- T1.1 MatB at ~60 rotations → roughly **$300 of member crossing reserves stranded** in T1.1 MatB
  storage, growing with every rotation. Mix of stress wallets and real community members.
- Every passive member "graduates" against their configured intent. Active members with referral
  earnings ≥ the fee are unaffected (their withdrawable covers re-entry).
- Same mechanics apply at every tier (fee scales, reserve scales).

## Fix spec (V8.44)

### A. Fund the additive engine with the reserve
- `MatrixLogicLib._cycleOutRoot` (MatB branch): pass the member's MatB `crossingReserve` as the
  escrow argument: `handleCycleOut(root, tierIndex, members[root].crossingReserve, members[root].withdrawable)`.
- `MatrixLogicLib.deductForUpgrade`: add proper reserve accounting —
  `require(members[member].crossingReserve >= escrowAmt)` and decrement it before transfer.
- `TierRouter._takeSeat`: split the deduction — draw `min(crossingReserve, fee)` as escrow and the
  remainder from withdrawable (mirror of `_crossToPartner`'s 50/50 crossing logic).

### B. Park instead of exit when re-entry is enabled but underfunded
- In `_executeAdditive`: if `reentryOn && funds < curFee` (and no other step seated the member),
  instruct MatB to park the member (`parkedMembers.push` + `parkedAt` + `MemberParked` event)
  instead of letting them fall through to exit.
- This makes the existing machinery apply exactly as members expect: auto-rescue keeper covers
  them if funds suffice; `selfRescue()` (reserve + withdrawable + shortfall, no debt) covers the rest.
- Note: `selfRescue`'s finalize path targets a crossing; parked-at-MatB members need it to target
  re-entry (routes via pair overflow if saturated — `rescueOverflow` already handles the destination).
  Verify `_finalizeCrossing` semantics for the MatB-parked case; extend if needed.

### C. Recovery for already-stranded reserves (V8.43 wallets)
- Option 1 (preferred): one-time admin migration function (timelocked) that moves
  `crossingReserve → withdrawable` for members with `!isInMatrix && parkedAt == 0` in a given matrix.
- Option 2: honor stranded reserves at re-registration — on register, if the member holds a reserve
  in a prior pair of the same tier, credit it against the entry fee. (More complex, touches routing.)
- Either way: enumerate affected wallets from `MemberCycledOut` events minus re-seated members,
  publish the list, and announce recovery before mainnet.

### D. Docs/bot sync after fix
- Update bot SYSTEM_PROMPT + faq/comp pages: cycle-out funding = crossing reserve + withdrawable;
  underfunded re-entry → parked (not exited). Re-verify against deployed V8.44 per the
  code-is-truth doctrine in CryptoNova-Testnet-App/CLAUDE.md.

## Test plan (before V8.44 push to testnet)
1. Unit: passive member (zero referrals) full loop T1 A→B→cycle-out with re-entry ON →
   must re-seat or park; must never exit; reserve must be consumed or preserved, never stranded.
2. Unit: reserve + withdrawable ≥ fee → auto re-entry fires funded by both buckets.
3. Unit: reserve + withdrawable < fee, re-entry ON → parked; selfRescue with shortfall completes re-entry.
4. Unit: re-entry OFF (explicit opt-out) → clean exit WITH reserve released to withdrawable.
5. Stress keeper regression: full-ladder run on a fresh deploy; assert zero stranded reserves
   across 500+ rotations (sum of crossingReserve over non-seated members == 0).
6. Gas: re-measure the full-cascade registration (rotation + pool distribution + crossing + additive
   seats now touching reserve accounting) against the public-RPC cap (~<17.8M) — see MAINNET_TODO.md.

## Related
- MAINNET_TODO.md → "Full-matrix registration gas cascade" finding (2026-07-23).
- V8.43 two-threshold pair overflow passed its first live test the same night (T1.1 sealed at 381,
  T1.2 absorbed overflow cleanly) — the additive engine finding above is the counterweight.
