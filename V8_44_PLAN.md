# V8.44 Plan — MatB Cycle-Out: Auto Re-entry Fails for Passive Members + Stranded Crossing Reserves

*Filed: 2026-07-24 ~01:30 UTC, from live community bug reports during the V8.43 stress run.*
*Reporters: Sherwyn (0x7d3c9488…, all accounts), @CryptoJan (0x79470c63…, 4 accounts). Both consistent.*

---

## 🏗️ BUILD ORDER & KICKOFF (start here — decided 2026-07-25, owner: full V8.44, all fixes)

**Doctrine for this build:** code is truth · test-first (write a test that reproduces the bug,
prove it fails, then fix until green) · fresh deploy + stress-test to PROVE cycling before any
promote · 3-stage frontend/keeper sync only after contracts verified. Do NOT edit tired.

**🧭 DESIGN LAW (owner, 2026-07-25): the CONTRACT drives all rotation; the keeper is ONLY a
backstop — never the primary driver.** The V8.43 freeze happened because rotation depended on
an external condition (a fundable crossing) and the sole recovery was a keeper that was broken.
That is inverted. In V8.44: (a) a full matrix MUST rotate as the natural, unavoidable
consequence of the next entry attempt — no external trigger required; (b) crossings must ALWAYS
be able to complete (funded from reserve; a shortfall parks the MEMBER without stalling the
MATRIX's rotation for everyone else); (c) keeper force-rotate stays only as belt-and-suspenders
for pathological cases AND must actually work (ownership fixed, performUpkeep self-heal). Test
gate: with ALL keepers OFF, a fresh stress deploy must still show every MatB's rotationCount
climbing purely from contract-driven flow. If cycling needs a keeper to move, the design failed.

**Sequence (dependency-ordered):**
1. **Crossing-fund fix** (item A) — passive members must not park at the MatA→MatB crossing;
   fund from crossingReserve + withdrawable; park+self-rescue only as true last resort.
2. **MatB cycle-out fix** (item A cont.) — pass escrow (not 0) into handleCycleOut; reserve
   accounting in deductForUpgrade; park-not-exit when re-entry ON but underfunded.
3. **Overflow rework** (item E-refined) — THE cycling fix. A saturated pair's OWN members
   (re-entries, self-rescues) return to THAT pair's MatB to keep it churning; only genuinely
   NEW externals overflow to the next pair. Fixes the frozen-MatB starvation.
4. **Factory ownership + MatB self-heal** (item E) — redeploy factory (owner→pairAdmin),
   add frozen-MatB work-item to MatrixKeeper.performUpkeep, factory sweepMatrixOwnership.
5. **Pull-based pool distribution** (item D) — gas/economics rewrite; wei-equivalence test vs
   V8.43 loop across randomized sequences. Do AFTER cycling proven (biggest blast radius).
6. **Upgrade eligibility unify + hybrid upgrade** (C2 + G3).
7. **Approval UX** (G1): EIP-2612 permit, fold auto-reentry into register; **bulk withdraw** (G2).
8. **Graceful exit** (BUGS.md graceful-exit + I3) — exitSeat/queue + reserve release.
9. **CW** (I1): decide advanceEpoch owner-vs-permissionless; add mainnet distribution keeper.
10. **Stranded-reserve recovery** (item C) — migration for wallets already stranded on V8.43.
11. **Docs/bot/frontend sync** (item F) — code-is-truth pass; update this session's E2 verify.

**Verification gates:** (a) unit tests green incl. the frozen-MatB reproduction; (b) fresh
stress-test deploy shows MatB rotationCount climbing on ALL pairs (the metric that was 0 on
pairs 2–5 this session); (c) zero stranded crossingReserve across 500+ rotations; (d) gas
per full-cascade registration under the ~17.8M public-RPC cap.

**Anchor line for the fresh session:**
`CryptoNova work — read your memory first, then let's build V8.44. Start with the build order at the top of V8_44_PLAN.md.`

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

### E. 🔴 CRITICAL — Factory-spawned matrices admin-orphaned → MatB DEADLOCK freezes cycling
**Upgraded from "keeper spam" to CRITICAL 2026-07-25.** This is the root cause of the V8.43
cycling slowdown vs V8.42. Evidence (live T1, 2026-07-25): MatA halves rotate healthily
(rot 254–291) but factory-spawned MatB halves are FULL (occ 127, nextSlot 128) with rot 0 —
frozen. Only pair 1's MatB (the original non-factory deploy) rotated (rot 79).

**The deadlock:** a full MatB needs one more entry to cycle its root out, but the incoming
MatA→MatB crossing is blocked *because* MatB is full ("partner full — wait for rotation").
Can't rotate without an entry; can't accept an entry without rotating. The only escape is an
authorized force-rotate — and ALL paths are sealed on this deployment:
- `adminForceRotateRoot` — needs matrix owner = the FACTORY (`0xf0b629cc`, orphaned); factory
  has no wrapper to make the call. ✗
- `keeperForceRotateRoot` — needs msg.sender = MatrixKeeper contract; simulated OK, but the
  MatrixKeeper has NO function that calls it. ✗
- `performUpkeep` — generates no work-item for the frozen-MatB condition. ✗
Consequence: cycling stalls at the crossing stage, members pile up parked, frozen-MatB keeper
reverts. One root cause, three symptoms. NOTE: raising entry thresholds (the intuitive "push
the loop harder" fix) makes it WORSE — more members into MatAs whose MatBs then also freeze.

**REFINED ROOT CAUSE (2026-07-25, read _crossToPartner):** it's not a MatB-internal deadlock —
it's STARVATION. (1) A MatA root cycling out must PAY the crossing fee to enter MatB; a passive
member without earnings can't cover the withdrawable half → `_crossToPartner` PARKS them and
returns before reaching MatB. (2) When rescued, the pair is saturated (≥381) so overflow routes
them to the NEXT pair's MatA — NOT back to their own MatB. (3) So the frozen MatB never receives
the entry that would rotate it; it filled early, then got orphaned from all flow at saturation.
MatA keeps spinning on fresh externals; MatB sits frozen behind it. NO clean live fix exists —
ghost-entry churn is messy/partial (leaves ghosts, trips the cycle-out bug), threshold raises
backfire, force-rotate only churns without fixing starvation.

**V8.44 fix (coupled — this is the cycling fix):**
1. **Crossing-fund fix (= item A):** passive members must not park at the crossing. Fund from
   crossingReserve + withdrawable properly; park-with-self-rescue only as true last resort.
2. **Overflow rework (NEW, critical):** a saturated pair's OWN members (re-entries, self-rescues)
   should return to THAT pair's MatB to keep it churning. Only genuinely NEW externals overflow
   forward to the next pair. Today `rescueOverflow` + `_findExternalPair` divert everything at
   381, orphaning the pair's crossing pool. Rework so overflow is external-only.
3. **Ownership fix + MatB self-heal (= item E):** redeploy factory (owner→pairAdmin), add
   frozen-MatB detection to MatrixKeeper performUpkeep (occ==size && nextSlot>size →
   keeperForceRotateRoot), factory `sweepMatrixOwnership(matrix)` for existing orphans. Backstop.

**Interim unfreeze to TEST in daylight (do NOT run blind at night):** `manualGhostEntry(matrix,
tierIdx)` on MatrixKeeper is onlyOwner and injects a synthetic entry — into a full MatB it
should trigger `_cycleOutRoot` (cycle-then-place), unfreezing it. Verify mechanics + fee cost
on ONE frozen MatB first; if it works, it drains the current backlog while V8.44 ships the
permanent fix. Diagnostic saved: the per-pair rotation scan (this session).

### E-OLD. Factory-spawned matrices are admin-orphaned (found 2026-07-24, frozen-keeper spam)
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

### E2. VERIFY overflow self-rescue on saturated pairs (flagged 2026-07-25)
Parked count spiked to 144 (mostly T1.4 MatA, a SATURATED pair — 381 entries, both
matrices full). Investigated live: it DRAINED on its own to 26 within the hour, so the
V8.43 overflow self-rescue path (`_rescueToNextPair` → `rescueOverflow` into pair N+1)
appears to work — the parking was steady-state churn (passive wallets park at crossing,
keeper drains them about as fast). BUT never confirmed with a clean APPROVED simulation
(an un-approved eth_call gave a misleading ERC20InsufficientAllowance red herring).
**Before mainnet, deliberately verify:** a member parked on a saturated pair can
self-rescue from the DASHBOARD — the overflow routes through pair N+1's MatA / the
PairManager, NOT the from-matrix the frontend currently approves. If the frontend approves
only the from-matrix, real members on saturated pairs would fail self-rescue on mainnet
even though the keeper/contract path works. Diagnostic left on VPS: /root/keeper/diag_overflow.js.
Watch signal: if parked count climbs and STAYS high (not draining), this is the likely cause.

### G. Member UX friction — approvals & upgrade funding (member call 2026-07-24)
1. **Too many approvals on register.** ERC20 approve is a separate tx from the spend, and
   registration fires a SECOND popup to auto-enable re-entry (`setMemberOptions`). Fix:
   (a) fold the auto-reentry toggle into the register tx (one popup, not two); (b) adopt
   **EIP-2612 permit** so USDC approval is a signature, not an on-chain tx (gasless, no
   standing allowance — fits the project's "fresh signature per spend, no delegation"
   security stance better than an unlimited approve). CNOVA/USDC must support permit;
   if MockUSDC/mainnet USDC does, wire permit into register + upgrade + coupon paths.
2. **Too many approvals on withdraw.** Withdrawing one's OWN balance needs no approval —
   if members see popups it's (a) per-matrix withdraw (one tx per matrix a member sits in)
   and/or (b) CNOVA redeem approve. Add `bulkWithdraw()` that sweeps withdrawable across
   ALL of a member's matrices in one tx. NOTE: keep the existing partial/type-an-amount
   withdraw — bulk is additive (withdraw-all), not a replacement.
3. **Pay the upgrade difference from wallet (hybrid funding).** Today `manualUpgrade` pulls
   the FULL fee from wallet; auto paths pull from earnings only. Members want "use my
   earnings + top up the shortfall from wallet" as one flow. Add a hybrid upgrade:
   deduct min(withdrawable, fee) from earnings, pull the remainder from wallet in the same tx.
4. **Auto-funding from wallet = DECLINED (owner, 2026-07-24).** Standing allowances / account
   delegation (EIP-7702) let the contract pull funds without a fresh signature — the exact
   attack surface that drains wallets if anything is compromised. Keep "every spend needs a
   fresh signature" as a security feature. Do NOT implement auto-funding.

### H. Bug bounty payout (decided 2026-07-24)
Method (a): **manual USDC send** at milestones, `paid_usd` in bounties.json tracked per
reporter (dashboard already shows earned vs paid). No claim contract for now. Funding
source: **Dev+Ops budget** (1.5% of entry fees — its charter already covers "audits,
protocol engineering"; bug bounty is exactly that). Owner batch-pays periodically and
updates paid_usd during triage.

### I. Community Wallet distribution + exit mechanics (member call 2026-07-25)
1. **`advanceEpoch()` is `onlyOwner`, but comp page says "anyone can trigger every 30 days."**
   Doc-vs-code mismatch. Decide: make it permissionless (matches the pitch) OR fix the docs.
   Either way, MAINNET needs a scheduled keeper to call it on the 25th — else claimable never
   updates (pending pool just grows). Confirmed working-as-designed that claimable only moves
   at epoch advance; members reading "flat claimable" as a bug is an education gap too.
2. **Verify Pioneer cohort accrual.** Pioneer #503 shows $0 claimable — expected (enrolled after
   last snapshot; next advanceEpoch includes them, both cohorts now 500/500). Confirm the next
   epoch advance actually pays both tranches once triggered.
3. **Graceful exit / crossing-reserve refund (ties to the existing BUGS.md graceful-exit item).**
   Current: disabling all automation releases the AUTOMATION reserve (reservedFor→0) to
   withdrawable, but each active seat's crossing reserve stays locked until that seat crosses.
   No mid-cycle quit/refund path exists. Add an exit flow (see graceful-exit options a/b/c) AND
   pair it with the V8.44 cycle-out fix so a clean exit releases any un-consumed reserve to
   withdrawable rather than stranding it.
4. **Upgrade button not visible after MatA→MatB cross (frontend).** Contract makes a member
   upgrade-eligible once seated in prev-tier MatB (`inPrevMatB`), but some members don't see the
   upgrade UI. Frontend eligibility check likely misses the "seated in prev MatB" case — align it
   with the contract's three-way rule (cycle done OR in prev MatB OR gate open). Same area as C2.

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
