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

### C2. Unify upgrade eligibility across entrypoints (found 2026-07-24, Sherwyn T2 report)
`manualUpgrade` accepts cycle-completed / prev-MatB / whale-gate eligibility, but `bulkUpgrade`
hard-requires the whale gate only ("TR: Whale Gate not yet open") — a member eligible via a
completed cycle can upgrade through one button and not the other. Align `bulkUpgrade` to the
same three-way eligibility check (or route both frontends through one entrypoint).

### D. Pull-based pool distribution (owner decision 2026-07-24: nothing deferred — in V8.44)
Replace the per-rotation 126-member credit loop in `_distributePool` with O(1) accumulator
accounting; members' shares are computed at claim/exit instead of written every rotation.
- Per matrix, maintain two accumulators updated once per rotation (pool `P`, weight `W = N(N+1)/2 − 1`,
  rotation counter `r`): `S1 += P / W` and `Sr += r × P / W`.
- A member seated at rotation `r0`, position `p0` advances one seat per rotation, so their
  accrued shares from checkpoint to now = `(p0 + r0) × ΔS1 − ΔSr` (exact closed form of the
  current weighted drip — payout amounts unchanged, only the accounting moves).
- Checkpoint (settle into `withdrawable` and re-snapshot) on every seat event: join, cross,
  cycle-out, park, rescue, double-seat, eviction.
- Rescue-debt repayment (currently deducted inside the loop) moves to the settle step.
- Result: full-cascade registration gas drops from ~15.5M to well under any RPC cap — resolves
  the MAINNET_TODO gas finding at the root instead of working around it.
- This is an economics-engine rewrite: test with property-based comparison against V8.43's
  loop output across randomized rotation sequences (payouts must match to the wei).

### E. Factory-spawned matrices are admin-orphaned (found 2026-07-24, frozen-keeper spam)
**Symptom:** frozen_matb_keeper spammed reverts on T1.2 MatB — `OwnableUnauthorizedAccount`.
**Diagnosis (on-chain verified):** T1.2 MatA/MatB owner = the live MatrixPairFactory
(`0xf0b629cc89Ca612473Ea714d6Af8Ac2C2Ae1FB33`) — NOT pairAdmin. The factory's `pairAdmin` and
`owner` are correctly the deployer, and the CURRENT source transfers matrix ownership to
pairAdmin at the end of `_deployPair` (V8.39 fix) — but the DEPLOYED factory bytecode predates
that fix. Every pair it spawns (T1.2 now; T1.3, T2.2… soon) is admin-orphaned: no
`adminForceRotateRoot`, no owner setters, no emergency admin control. `keeperForceRotateRoot`
doesn't help — it requires msg.sender == the MatrixKeeper CONTRACT, which has no passthrough.
Also: `deployed_addresses_v8_43.json` lists a stale `matrixFactory` (`0x907193…`) — the
PairManagers were re-wired to `0xf0b629cc…` later. Update the addresses file.
**V8.44 fix:**
- Redeploy MatrixPairFactory from current source (includes the ownership transfer), re-wire every
  PairManager via `setFactory`, verify `pairAdmin` before first spawn.
- Add a factory `sweepMatrixOwnership(address matrix)` (onlyOwner) so ownership of
  already-spawned orphan matrices can be recovered retroactively — without it, orphans are
  permanent for the life of a deployment.
- Deploy checklist addition: after first factory expansion on any fresh deployment, assert
  `matrix.owner() == pairAdmin` (catches this class of drift immediately).
**Interim (V8.43):** acceptable — on-contract overflow/rotation automation covers the real freeze
cases; frozen_matb_keeper now preflights and stands down cleanly (no gas burn, one log line).

### F. Docs/bot sync after fix
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
6. Gas: re-measure the full-cascade registration after the pull-based pool rewrite — target is
   comfortable clearance under the public-RPC cap (~<17.8M) at worst case; see MAINNET_TODO.md.
7. Pool-accounting equivalence: property-based test — V8.44 accumulator payouts must equal
   V8.43 loop payouts to the wei across randomized join/rotate/park/rescue sequences.

## Related
- MAINNET_TODO.md → "Full-matrix registration gas cascade" finding (2026-07-23).
- V8.43 two-threshold pair overflow passed its first live test the same night (T1.1 sealed at 381,
  T1.2 absorbed overflow cleanly) — the additive engine finding above is the counterweight.
