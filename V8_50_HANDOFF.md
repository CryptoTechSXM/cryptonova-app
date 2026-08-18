# V8.50 HANDOFF — the crossing redesign. READ THIS FIRST.

Written 2026-08-16 at the end of the V8.49 private measurement run.
Sessions 2, 3 and 4 have appended to it since; read the NEWEST section first — each one
corrects the ones below it, and says so explicitly where it does.
Audience: a future session of Claude, plus the owner. Nobody else touches this code.

---

# ⬛ SESSION 4 STATE — 2026-08-16, LATE. READ THIS FIRST, BEFORE SESSION 3.

Session 3's "NEXT, IN ORDER" list is DONE, items 1–3. Nothing below this section is
contradicted; two things are **extended** and one **sharpened**, each marked.

## WHAT SHIPPED — SIX TEST FILES RE-FIXTURED, NO CONTRACT CHANGED

**Not one line of `contracts/` was touched this session.** Every change is in `test/`.
That is the headline: the 9 new failures session 3 attributed to item A were all
fixtures encoding pre-item-A economics, exactly as it said, and none of them was a
defect in the item A code.

| file | was | now |
|---|---|---|
| `V8_48_SplitGrace.test.js` | 3 failing | 0 |
| `V8_48_GhostFloor.test.js` (GF-D1) | 1 of its 3 | 0 of that 1 |
| `V8_49_InsolvencyFloor.test.js` (IF-7, IF-10) | 2 failing | 0 |
| `V8_49_EvictionClock.test.js` (EC-1/2/4) | 3 failing | 0 |
| `V8_48_RescueSurplus.test.js` | 3 failing | 0 |
| `V8_48_KeeperScan.test.js` | 9 failing | 0, **plus one new test** |

## ⛔ EXTENSION 1 — STEP 1 WAS SIX TESTS. IT IS NINE, AND THEY ARE ONE BUG.

Session 3's step 1 named `SplitGrace ×3, GF-D1, IF-7, IF-10`. Its own effect-(a)
paragraph also lists **the floor legs of EC-1/EC-2/EC-4**, and the run confirms those
three fail for the identical reason and are fixed by the identical edit. The "6 of 9" in
that paragraph is a slip: the list under it has nine entries and all nine are effect (a).

**All nine have ONE root cause and ONE fix.** Every one of them builds its parked member
on the `MockKeeperScan` harness with `MockMatrixK(FEE, true)` — a **MatA**. Under item A
a MatA crossing costs the reserve carve, and every one of those fixtures gives the member
a $5.00 reserve, so all nine members became SELF-FUNDED, `sfShare` went to 0, and the
ladder, the floor and the loan-grace window all stopped being reachable. The failures say
so literally: `expected [ 4 ] to deeply equal [ 6 ]` — RESCUE where the test wanted EVICT.

**THE FIX, AND WHY IT PRESERVES EVERY NUMBER.** Each member moved to the pair's MatB —
`MockMatrixK(FEE, false)` — where a cycle-out re-enters a MatA at the FULL fee and the
loan path still exists. Their money moved with them: **withdrawable becomes the old
(withdrawable + reserve), reserve becomes 0**, because item A leaves a MatB member holding
no reserve; it was spent getting them there.

That substitution is exact. `effectiveContrib` is unchanged, the price basis is back to
the full fee, so **every wBps, every shortfall and every sfShare in all nine tests is the
same number it was before item A**. Not one assertion's expected value was edited. The
fixtures changed matrix and pocket; the rules under test did not move.

- ONE EXCEPTION, and it is the rule not an exception to it: EvictionClock's **RATIO**
  member keeps `withdrawable $2.00`. `rescueRatioBps` is `withdrawn/(withdrawn +
  withdrawable)` and never looked at the reserve — folding it in would have moved that
  member from 8000 bps to 5333 and quietly retired the case. Noted in the file.
- Flipping the B-half's flag does NOT admit the frozen-MatB scan into these batches:
  `_isFrozenMatB` returns on `occupancy() < MATRIX_SIZE()` and `MockMatrixK.occupancy` is
  always 0 (there is no setter). Checked in source before relying on it.

## ⛔ SHARPENING — THE POPULATION NUMBER IN SplitGrace WAS PRE-ITEM-A AND IS NOW RE-MEASURED

`"the 84% member — the live median"` was 50% reserve + ~34% earnings at an A->B crossing,
measured 2026-08-11. **Item A retired that member.** The population it represents moved to
the MatB re-entry, so the test was re-pointed at where that population now lives and
renamed **"the MEDIAN re-entry member"**: `$7.29` of a `$10.00` re-entry, from
`model_item_a.js` on live V8.48 (n=63, median ask **$2.71**). Every other fixture amount
in these files was checked against that same measured band — a member arrives at a $10
re-entry holding **$5.72 to $10.00** — and all of them sit inside it.

## ⛔ CORRECTION TO SESSION 3'S CHARACTERISATION OF THE CLIFF — IT IS THE FLOOR, NOT THE LADDER

Session 3: *"an early-MatB member reads ~3,400 bps against preset 1's bottom rung of 4,000
and falls off it."* **Reproduced, and it is one rung further along than that.** The two
members that actually diverge in `KeeperScan` read **4,120 and 4,875 bps** — both ABOVE
the 4,000 rung. They get a ladder rung; what kills them is what the rung then asks for.

Losing the carve does not change the ladder arithmetic, it changes the **shortfall**:
`$0.88 -> $5.13` for those two. That ask is then refused by the **insolvency floor**.
Same family, same cause, but the lever is PARAM 59 and not `sfRescueThresholds` — which
matters, because the two are different owner decisions and session 3 pointed at the
second one. The ladder can still bite a poorer member; it is not what bit here.

## THE KeeperScan DECISION — SCOPED, NOT RETIRED, AND THE DIVERGENCE IS NOW PINNED

Session 2 and 3 both said the byte-identical premise is *structurally* incompatible with
item A, because item A is not a parameter and `MatrixKeeperPrev` will never know about it.
**That reading was wrong, and the run says so.**

Item A reprices a crossing out of a **MatA**. Out of a MatB, `_crossingCost` returns the
full entry fee — the same number the frozen keeper uses. And under item A a MatA parker's
reserve covers their crossing outright, so **MatA parks nobody for funding and the whole
parked queue this fixture builds lives in the MatB.** Both keepers ask the same question
about the same members. Measured across every scenario in the file:

```
insolvencyFloorBps      0 -> 0 slots differ   (BYTE-IDENTICAL)
insolvencyFloorBps   1700 -> 2 slots differ
insolvencyFloorBps   2500 -> 2
insolvencyFloorBps   3400 -> 2      <- the shipping value
insolvencyFloorBps   5000 -> 2
insolvencyFloorBps   6800 -> 0      (BYTE-IDENTICAL)
insolvencyFloorBps  10000 -> 0      (BYTE-IDENTICAL)
```

**The divergence is one-shaped and lives in one governed parameter.** Every differing slot
is OLD=`PARKED_RESCUE`, NEW=`EVICT_PARKED`, a MatB member, reserve 0 — never the reverse.

So the decision, recorded with its reason as session 2 asked:

1. **`insolvencyFloorBps` is pinned to 0 in `deployBoth()`**, a THIRD pin alongside item
   12's `selfFundedGracePeriod` and item 1's `evictionGracePeriod`. It is the same move
   for the same reason and it obeys the file's own doctrine — *"every pin here is an item
   that DID [change behaviour]."* It hides no keeper difference: both keepers call the
   same `loanEligibleFor`, and this suite was green at the shipping 3400 before item A.
   It neutralises the one INPUT item A moved.
2. **The divergence is asserted, not swept away**, by a new test at the bottom of the
   file: at floor 0 byte-identical; at the shipping floor every flip is RESCUE->EVICT, in
   the MatB, on a member holding no reserve; at floor 10000 identical again — which is
   what proves the cause is the floor and not the ladder.

Net: the file covers MORE than it did. The extraction is still pinned byte-for-byte, and
the economic change now has a test that fails if it ever stops happening.

## RescueSurplus — THE QUEUE MOVED, AND THAT IS ITEM A'S THESIS REPRODUCED LOCALLY

*"Fixture produced no parked member"* was the right failure to see. Measured on this
fixture's own world (`world(7)`, 41 registrations), stepping the count as it grows:

```
regs=10   matA.parked 0   matB.parked 0
regs=20   matA.parked 0   matB.parked 7
regs=40   matA.parked 0   matB.parked 27     every one at wd $2.436 / rs $0.00
regs=70   matA.parked 0   matB.parked 57
```

**MatA parks NOBODY. Not one, at any population size.** The entire queue is the MatB
cycle-out. That is the whole V8.50 argument, reproduced in a local fixture in seven
seconds, and it is worth more than the three tests it was found while fixing.

The file now builds its member in MatB, and asserts MatA's emptiness explicitly rather
than ignoring it — if a funding park ever appears in a MatA again, item A has regressed
and that is the cheapest line in the suite to find it on.

**ONE NEW FIXTURE STEP, AND IT IS NOT A FUDGE.** A journey earns at most ~34% of a fee, so
the only way past 100% is referral income — the member must be a referrer, and their
downline keeps crossing into MatB paying them `l1Bps` each time. Left alone, the RESCUE
TRANSACTION ITSELF pays them another $0.95 mid-flight and the post-rescue balance reads
`surplus + $0.95`. The fixture now drains that first: register outside their downline
until their withdrawable stops moving, measured, not counted. Then the surplus assertion
is exact — **verified delta $0.000000**. The comment says in the file: do not replace this
with a tolerance; the drain is what keeps the assertion sharp.

**MUTATION-CHECKED.** `_selfRescue`'s `withdrawable = surplus` was flipped back to
`withdrawable = 0` — the original V8.48 defect — recompiled, and the REGRESSION test
fails. The re-fixtured test still catches the bug it was written for.

## TEST STATE — AND HOW IT WAS MEASURED, WHICH YOU NEED TO KNOW BEFORE TRUSTING IT

⚠️ **THESE NUMBERS COME FROM A SANDBOX REPRODUCTION OF THE REPO, NOT FROM THE OWNER'S
MACHINE.** Contracts + tests were copied into a clean Linux container with a fresh
`npm install` and solc 0.8.26 from npm. It is a faithful reproduction — it reproduced
every one of the 12 target failures with byte-identical assertion messages before the fix
— but it is NOT the owner's environment and it **drifts by about two tests**: it shows 7
`KeeperScan` failures where the owner's `test_v850_task1b.txt` recorded 9, and it does not
show `V8.46-B cascade gas` (the known inherited `TypeError`). **The owner's run is the
authoritative one. Treat the prediction below as a prediction.**

| | passing | failing |
|---|---|---|
| session 3, owner's machine (`test_v850_task1b.txt`) | 534 | 60 |
| session 4, sandbox, six files re-fixtured | **555** | **40** |
| session 4, sandbox, + the `V8Elevator` fc() guard | **567** | **28** |
| **OWNER'S MACHINE, MEASURED** (`test_v850_task2.txt`) | **574** | **21** |

**60 -> 21. Thirty-nine tests went green.** The prediction was ~568/~27 and was BEATEN, not
missed — the sandbox over-predicted the remainder by 6 because several `V8.35` factory
tests and `V8.46-B cascade gas` fail there and pass on the owner's machine. **Read that as
the sandbox being pessimistic, not as a surprise: every one of the 24 re-fixtured tests and
every test the `fc()` guard was meant to reach went green exactly as predicted.** The
KeeperScan PARAM 59 sweep printed identically on both machines, to the row.

Predicting the ASSERTION and not the test, per session 3's own method note: **33 failing
tests should go green and 1 new test should appear**, and no test that was passing should
start failing. If the owner's run lands anywhere else, the diff — not the total — is the
thing to read.

**THE 40 THAT REMAIN ARE NOT OURS TO FIX THIS SESSION.** Every one was already in session
2's 51: real-pair fixtures that encode a full-fee A->B crossing (`V8.35` factory ×10,
`V8.39` ×5, `V8.38` ×3, `V8.44` ×5, `V8Elevator` ×4, `V8.10` ×4, and so on), plus
`GhostFloor`'s GF-V1 and GF-V3. They are the same class of work as this session's, at
larger scale.

**GF-V3 is worth naming because it is the cleanest statement of the remaining work:**
`precondition: cycle-out park must keep the crossing reserve: expected 0 to equal 5000000`.
Its precondition is now false BY DESIGN. Item A is the reason, and the fixture is right to
say so loudly rather than adapting quietly.

# ✅ ITEM E1 IS BUILT — AND THE SUITE IS GREEN FOR THE FIRST TIME THIS RELEASE

**595 passing / 7 pending / 0 failing.** Session 4 opened at 60 failing.

## WHAT E1 IS

`MatrixLogicLib._crossToPartner`, at the very end and **after** the SF debt clawback: the
member's remaining withdrawable moves with them. `forceApprove` to the destination, then a
partner-only `creditCarriedBalance(member, amount)` on the far side — the same door
`addRescueDebt` has used since V8.28 (`FigureEightMatrixV8:629`), not a new one.

- **NOT routed through `_credit()`.** A transfer is not an earning. Crediting it would
  inflate the member struct's `totalEarned` — the field defect 4 exists to clean up — and
  double-count in anything summing `EarningsCredited`, `model_item_a.js` included.
- **Emits `BalanceCarried(member, from, to, amount)`** so the movement is visible. The
  crossing buffer's sin at `:1368` is moving money into `withdrawable` invisibly; this must
  not repeat it.
- **AFTER the clawback, deliberately.** Debt settles from this ledger first and only the
  remainder travels. Carrying first would move money out from under `:882-897`.
- **ONE DIRECTION ONLY.** My own design note said it had to be symmetric. Wrong: a member
  cycling out of MatB leaves their remainder in MatB, re-enters their OWN pair, and returns
  to that same contract — so it waits for them and the next gate already reads it.

**Measured effect:** MatB ledger at the gate $7.66 -> **$8.32**, gate-basis ask
$2.34 -> **$1.68**.

## THE VALIDATION THAT MATTERS

**E1 fixed all three remaining walk-through items with no fixture change at all** —
the 15-registration re-entry-priority test, `V8_44_Overflow` O1+O2, and `V8.35` G4. Those
were the three I could not resolve and had planned to re-state. **They were failing because
of the defect.** Fixing the root cause turned them green untouched. Nothing else in this
session came close to that as evidence.

## THE FIXTURES E1 THEN BROKE, AND WHAT THEY TAUGHT

E1 took the suite 3 -> 8 failing, every one the same shape: *"precondition: shortfall
cycle-out must PARK the root in MatB"*. The fixtures could no longer make a poor member.

**The cause was the same in three files, and it was a fixture lie of long standing.**
`driveW1IntoMatB`, `parkW1InMatB` and `seedAndParkW1` all referred **fifteen fillers to
W1**, handing the fixture's "underfunded" member $14.25 of L1 and making them the richest
wallet in the pair. It only ever read as underfunded because that money sat in the MatA
ledger where the gate could not see it. **The fixtures were relying on the defect.** They
now chain the referrals, so W1 is the passive no-referral member the precondition always
described.

**Two more corrections came out of `V8_48_RescueSurplus`, both mine:**

1. **"MatA must park nobody" was too strong.** E1 changes cascade timing, so the mid-cascade
   DEFERRAL park (`:906`) now fires — measured: 2 MatA parkers, both holding a reserve of
   exactly $5.00, the full crossing price. They are not stuck; a deferral park hands them to
   the standard machinery for a later transaction and bounds recursion depth. Item A's claim
   is about FUNDING, so the test now asserts funding: **no MatA parker may hold less than
   the crossing price.** Stronger than a count, and it survives future cascade changes.
2. **The settle loop was replaced by accounting.** A rescue re-seats the member, which
   cascades, which can pay them L1 in the SAME transaction. The old fix quiesced their
   downline first; E1 changed the timing and a credit slipped back in. It now SUMS
   `EarningsCredited` from the receipt — with two traps recorded in the file, because both
   produced confident wrong answers: the event must be parsed from an EXPLICIT interface
   (solc does not copy a library's events into the using contract's ABI, and parsing
   through `matB.interface` silently returned zero), and it must be FILTERED BY EMITTER
   (credits are per-ledger — a rescue pays $0.95 L1 on the matrix being left and $0.25
   direct-earn on the one being entered; counting both over-states by exactly the
   direct-earn, the same error as summing both halves in phase 5).

## ⚠️ CONTRACT SIZE IS NOW A LIVE CONSTRAINT ON THE REST OF V8.50

```
  MatrixPairFactory   24,444   headroom   132     <- embeds the matrix init code
  MatrixLogicLib      24,274   headroom   302
  TierRouter          23,910   headroom   666
```

E1 cost MatrixPairFactory 216 bytes and MatrixLogicLib 261. **Defect 4 wants to ADD a
getter to the matrix, which grows the factory again.** With everything landing in V8.50 and
nothing deferring, size has to be managed deliberately from here — budget it before writing,
and `node scripts\sizes.js` after every contract change, not just at the end.

## NEXT

1. **Re-run `scripts/model_item_a.js` phase 6.** It now measures a fixed system. PARAM 59
   should finally be chosen against a basis that is true — the expectation is that the ask
   returns toward the scope's ~$3.20 and 3400 clears the population, but that is a
   prediction and the script is the answer.
2. Defects 2 and 4, within the size budget above.
3. `maxItemsPerUpkeep` 15 -> 5 or 10.
4. Item D and the organic growth reading. (The tier-gate recalibration is CLOSED — PHASE 8 measured it as fixture-specific; live T2 is $25 and nobody upgrades at cycle-out in either world.)

# ⛔⛔ OWNER DIRECTIVE, 2026-08-17: NOTHING DEPLOYS, NOTHING DEFERS

> *"we fix everything, deploy nothing until we have a solid ground to stand on. also would
> like everything we find to be in v8.50, nothing deferred to 8.51"*

**This supersedes every "ship it / defer it" recommendation elsewhere in this document,
including my own from earlier today.** V8.50 is now a FIX-EVERYTHING release. No partial
deploy, no interim PARAM value chosen to unblock a deploy that is no longer happening.

**Practical consequence: PARAM 59 does not need an interim answer.** The 6800 recommendation
existed only to unblock a deploy. With the deploy held, the right sequence is: fix the
ledger split FIRST, then re-measure, then choose the floor against the fixed system. A
floor chosen against the broken basis would be a number nobody could defend later.

## THE REAL V8.50 SCOPE, AS IT NOW STANDS

**Contract work — money path**
- **E1. CARRY THE MEMBER'S BALANCE WHEN THEY CHANGE MATRIX.** The headline fix. See the
  design fork below. Everything else on this list is small by comparison.
- **E2.** Correct the conservation comment in `TierRouter.handleCycleOut` — it currently
  asserts an equality that does not hold at that gate and is the most authoritative-looking
  place anyone will read.
- **E3.** `_executeAdditive`'s re-entry/upgrade fall-through: independent `if`s, not
  `else`. Unreachable on the real ascending ladder ($10 -> $25 -> $50), so the CODE is
  safe; the doc comment claiming "re-enter or PARK" is not. Comment fix at minimum.
- **E4.** Revisit the MatA withdraw lock. Session 2 kept it at the FULL fee on the
  reasoning that "a MatA member WILL need it for the re-entry, and this lock is what
  accumulates it". **The lock accumulates money in MatA and the re-entry gate reads MatB.**
  The lock and the gate are on different ledgers — the same defect from another angle. If
  E1 lands, the lock's premise becomes true for the first time.
- **Defect 2.** `MatrixKeeper.DIRECT_EARN_BPS = 500` — dead, public, and wrong (real value
  250). Delete it.
- **Defect 4.** No getter exposes the true `totalEarned`; `MatrixKeeperLib:426`
  reconstructs it as `withdrawn + withdrawable`, which includes crossing-buffer money, and
  the keeper's withdraw-ratio EVICTION test runs on the contaminated figure.

**Parameters — all decided AFTER E1, not before**
- PARAM 59 `insolvencyFloorBps`. With E1 the ask returns to ~$3.20 and 3400 clears
  everyone; without it, 6800 is the floor. **Do not fix this number until E1 is settled.**
- `crossingBufferBps` -> 0. Already governed in V8.49; confirm in predeploy.
- `maxItemsPerUpkeep` 15 -> 5 or 10 (scope §6: gas per rescue rose 600k -> 2.6M; a full
  15-item batch projects ~39M against a ~17.8M ceiling).

**Tests — 3 red, and 2 of them wait on decisions**
- 15-registration re-entry priority (waits on E3)
- `V8_44_Overflow` O1+O2 (needs a rule re-stated, not a fixture moved)
- `V8.35` G4 — FIXED in the sandbox, not yet committed
- New coverage for E1 will be needed and does not exist yet.

**Still unmeasured, and now in scope because nothing defers**
- **Item D, shallow seating.** T5 has never been able to fire. A member seated at seat 2
  pays a full fee and collects $0.25. If E1 lands, that member's balance travels — which
  changes item D's severity but not its existence.
- **The organic growth rate.** `logs/parked_baseline.csv` and `diag_parked_growth.js` —
  parks vs rescues vs EVICTIONS per day, still never run.
- ~~**Tier-gate recalibration** after the acceleration finding.~~ **CLOSED 2026-08-18.** `model_item_a.js` PHASE 8: live T2 is $25.00 and 0 of 39 can upgrade at cycle-out under EITHER V8.48 or item A. The acceleration was V8Elevator's fee ladder, not this chain's. No recalibration, no contract change.

## 🚨🚨 MEASURED ON CHAIN 2026-08-17: PARAM 59 = 5000 RESCUES **ZERO** MEMBERS

**THIS REVERSES THE OWNER DECISION TAKEN EARLIER TODAY. DO NOT DEPLOY 5000.**

`scripts/model_item_a.js` phase 6 (added for this question) computes the re-entry ask two
ways: the AGGREGATE across both halves — phase 5's basis, and what the 5000 decision was
made on — and the **MatB LEDGER alone**, which is the basis `handleCycleOut` and
`_triageParked` actually use. Live V8.48, block 45588411, n=70:

```
  ask, AGGREGATE (both halves)      min $1.23   median $1.90   max $2.58
  ask, MatB LEDGER (the real gate)  min $6.60   median $6.60   max $6.60
  MEDIAN UNDERSTATEMENT             $4.70

  PARAM 59 sweep on the LEDGER basis — rescued of 70:
     3400 bps  ceiling $3.40    aggregate 70    LEDGER   0
     5000 bps  ceiling $5.00    aggregate 70    LEDGER   0     <- THE DECISION WE TOOK
     6800 bps  ceiling $6.80    aggregate 70    LEDGER  70     <- first value that works
    10000 bps  ceiling $10.00   aggregate 70    LEDGER  70
```

**$6.60 for every single member, min = median = max.** That uniformity is itself the
proof: journey B earns the structural $3.40, a re-entry costs $10.00, the ask is $6.60,
and every one of these 70 is a no-referral member. It matches the hand-derivation exactly.

### WHAT THIS ACTUALLY MEANS — AND IT IS NOT "ITEM A IS BROKEN"

Item A's headline win is untouched and confirmed again this run: **40 of 40 MatA parkers
freed, 100%**, $48.93 of live shortfall to zero, 64.0% of all funding parks removed. Nobody
is evicted mid-cycle. **That is item B delivered and it does not depend on any of this.**

What is broken is the SECOND half of the story — the claim that the member arrives at
re-entry holding $6.80 and asks $3.20. They DO hold $6.80. It sits in two ledgers, $3.40
each, and the re-entry gate can only spend the MatB one.

**So at that gate item A makes the ask WORSE than V8.48, not better:**

```
  V8.48  MatB reserve $5.00 + earnings $1.80 (post-clawback) = $6.80  ->  ask $3.20
  V8.50  MatB reserve $0.00 + journey-B earnings     $3.40  = $3.40  ->  ask $6.60
```

The member is not poorer — their journey-A $3.40 is real, withdrawable, and usable for a
MANUAL `selfRescue` (which pulls a shortfall from the WALLET). **Item A moved money from
the automatic path to the manual path.** For a passive member, who is exactly who item A
exists for, the automatic path is the only one they use.

### THE THREE WAYS OUT

1. **PARAM 59 = 6800 and ship.** Clears all 70. Defensible framing, and better than the one
   it replaces: 3400 was "never lend more than one JOURNEY's earnings"; 6800 is "never lend
   more than one full A+B CYCLE's earnings" — which is exactly what a member at re-entry
   has completed. No code change. But it doubles the fund's per-rescue exposure against a
   balance that fell $451.66 -> $329.29 in one day.
2. **CARRY THE BALANCE ACROSS THE CROSSING.** At the A->B hop, move the member's remaining
   MatA withdrawable into their MatB ledger. They then reach the gate holding $6.80 and ask
   $3.20 — the scope's model, restored — and 3400 would clear everyone with room.
   **NOT A ONE-LINER:** withdrawable is backed by USDC held in the MatA contract, so the
   claim and the tokens must move together, across contracts, in the money path. Needs its
   own scope item and its own tests.
3. **BOTH** — do 2, keep the floor low, and treat 6800 as the interim while 2 is built.

**RECOMMENDATION: 1 now, 2 scoped for V8.51.** 6800 is honest, on the DAO menu, reversible
by vote, and unblocks the deploy. Option 2 is the real fix and should not be rushed into a
release whose test suite is still being re-fixtured.

### SECONDARY OBSERVATIONS FROM THE SAME RUN

- **The population has fully turned over to organic no-referral members.** One completed
  journey now earns min $3.40 / median $3.40 / **max $3.40** — the whole distribution has
  collapsed onto the structural minimum (it was min $3.40 / median $4.83 / max $6.34 on
  2026-08-16). The bigfill-era members with referral income have cycled out.
- **MatB parkers carrying debt: 0 of 70**, down from 23 of 72 yesterday. The clawback
  concern (scope defect 3) has no live population right now.
- **The Stability Fund fell $451.66 -> $329.29 in a day** while the queue drained 133 -> 110.
  Worth watching before committing to a higher lending ceiling.

## 🚨 THE CONSERVATION ARGUMENT HAS A HOLE — MEASURED 2026-08-17, READ BEFORE DEPLOY

**This contradicts a conclusion session 3 committed to source, and it bears on PARAM 59.**

### WHAT SESSION 3 WROTE, IN THE HANDOFF AND IN `TierRouter.handleCycleOut`

> V8.48  reserve $5.00 + earnings $3.40 - $1.60 crossing debt = **$6.80**
> V8.50  reserve $0.00 + earnings $3.40 (journey A, **KEPT**) + $3.40 = **$6.80**
> "The same $6.80 against the same $10 re-entry, so every funding gate below decides
> identically... that is why item A needed NO code change in this contract."

### WHY IT IS WRONG

Journey A's earnings are kept — **in the MatA ledger.** `handleCycleOut(member, tierIndex,
escrow, withdrawable)` receives ONLY the cycling matrix's two buckets, passed by
`MatrixLogicLib._cycleOutRoot` from **MatB**. There is no cross-matrix lookup. So the
"+$3.40 (journey A, KEPT)" term is real money that this gate never sees.

**MEASURED on `deployV8Fixture`, W1 at the MatB cycle-out:**

```
  MatA ledger  $7.31   <- STRANDED from this decision
  MatB ledger  $7.66   <- ALL that handleCycleOut receives
  aggregate   $14.97   <- what scripts/model_item_a.js sums
  T1 re-entry needs $10.00
```

The member holds $14.97 and the contract sees $7.66. Under V8.48 the same member reached
this gate with **$12.66**, because the $5 arrived as a carved MatB reserve. **Item A leaves
that money behind in MatA.** The member is not poorer overall — they are poorer AT THIS
GATE, which is the only place it matters for an automatic re-entry.

### THREE CONSEQUENCES, IN ORDER OF IMPORTANCE

1. **`model_item_a.js` IS OPTIMISTIC FOR THE POST-ITEM-A POPULATION.** Phase 5 computes
   holdings as *"credits across BOTH halves"*. That is CORRECT for the members it measured
   — today's V8.48 parkers, whose MatA money was already spent on their full-fee crossing,
   so aggregate ≈ MatB ledger. It is **wrong as a projection**, because under item A the
   money splits across two ledgers and only one funds the re-entry. **The measured median
   ask of $1.90 and "15 of 72 refused at 3400" are both understatements.** PARAM 59 at 5000
   still looks like the right call — the direction does not change — but the headroom it
   buys is smaller than the sweep suggested.

2. **A MEMBER CAN NOW UPGRADE INSTEAD OF RE-ENTERING, AND THE CODE PERMITS IT.**
   `_executeAdditive` (`:1351`, `:1362`) tries re-entry first, gated on
   `escrow + withdrawable >= curFee`, then tries the upgrade in an INDEPENDENT `if` —
   not an `else`. The doc comment says *"auto-reentry ON → member NEVER graduates:
   re-enter or PARK"*, and the code does not enforce the "or PARK". Under V8.48 the
   divergence was invisible: a member who could afford a $7 upgrade had almost always
   cleared the $10 re-entry first, because the $5 reserve got them there. **Item A opens a
   band — funds between the next-tier fee and the current-tier fee — where the member
   leaves T1 rather than completing another cycle.** Observed: W1 at $7.66 skipped a $10
   re-entry and took a $7 T2 upgrade.

3. **IT INTERACTS WITH ITEM B.** "No member evicted mid-cycle" is satisfied by item A at
   the A->B crossing. This is a different thing: a member who does not re-enter has not
   been evicted, but they have not continued either.

### WHAT IS *NOT* WRONG — CHECKED, SO NOBODY RE-OPENS IT

- **`disableUpgrade` is NOT being ignored.** `_executeAdditive:1336-1341` applies a
  member's options only once `cycles >= reentryMinCycles` / `autoUpgradeCycleThreshold`;
  below that the system default governs. That is V8.44 design (`V8_44_CycleOut` sets
  `setReentryMinCycles(1)` explicitly for exactly this reason). A first cycle-out ignoring
  the member's own toggle is intended, not a defect.
- **The member does not LOSE the MatA money.** It is withdrawable, and `selfRescue` pulls
  a shortfall from the WALLET, so a member can move it manually. **Item A moves money from
  the automatic path to the manual path** — that is the honest one-line summary.

### WHAT TO DO NEXT — NOT YET DONE

1. **Add a phase to `scripts/model_item_a.js` that splits holdings BY LEDGER** and reports
   the re-entry ask on the MatB balance alone. That is the basis the contract uses. Re-run
   PARAM 59's sweep on it. **Until then, treat the $1.90 median and the 5000-clears-all-72
   result as an upper bound on how good things are.**
2. **Decide whether the `_executeAdditive` fall-through is wanted.** Options: leave it (a
   member progressing a tier is not a bad outcome), or make the upgrade an `else` so
   "re-enter or PARK" means what it says. **This is an owner decision and a contract
   change, so it does not belong in a test fix.**
3. **Correct the comment in `TierRouter.handleCycleOut`** — it currently asserts a
   conservation that does not hold at that gate, and it is the most authoritative-looking
   place anyone will read.

**The 15-registration test stays RED until 2 is decided.** It was left failing on purpose
rather than being written around behaviour that is not yet understood.

## ⛔ THE 40 WERE TRIAGED, AND HALF OF THE BIGGEST CLUSTER WAS ONE LINE

Grouping the remaining failures by revert signature rather than by file: **20 of them —
by far the largest cluster — fail on `F8V8: already in matrix`**, which is the
duplicate-seat guard at `MatrixLogicLib:255` and has a history in this repo as a real
pair-wide DoS. That warranted looking at before any more re-fixturing.

**It is not a regression. It is item A succeeding where a fixture expected it to fail.**
The trace runs `test helper -> matA.forceCross -> _finalizeCrossing -> seat in MatB ->
require(!isInMatrix)`. `V8Elevator.test.js` has ONE shared `fc()` helper used at 21 call
sites, and the helper's own comment states the dead assumption outright:

```
// 7 registrations each trigger a MatA rotation; fc() pushes each parked root to MatB
```

Under item A **the root does not park** — its reserve pays the crossing, so it crosses
itself during the rotation and is already seated by the time `fc()` runs. The helper's
real contract was always "ensure this member is in MatB"; only the world made the two
readings identical. **One guard in the helper, and that file went from 22 failing to 10:**

```js
if (await matB.isActiveInMatrix(memberAddr)) return;   // item A got there first
```

The pattern was not invented here — `V8_48_KeeperScan.test.js` already guards its own
force-cross loop exactly this way, and so does `V8_47_UpgradeGate.test.js` at its call
site. This is that pattern hoisted into the helper.

**THREE MORE FILES CARRY THE SAME `ownerForceCross` IDIOM** (`V8_44_CycleOut`,
`V8_47_UpgradeGate`, `V8_44_Overflow`) **and the same guard was applied to them, measured,
and REVERTED: it fixed nothing.** Their 6 failures are the other family — a fixture that
needs a parked member item A no longer produces — and V8_47's call site was already
guarded. The guard would have been correct-by-design and dead in the diff, so it went
back out. Recorded because "it looked like the same bug and was not" is worth one line to
the next session.

**Where the remaining work stands after that:** sandbox **28 failing**, predicted **~27**
on the owner's machine. Two shapes, and neither is mysterious:

1. **The parked-member family** — `V8.10` ×4, `V8.44` ×5, `V8.47` G3, `V8.35` G4,
   `V8.38` L1/L2/L4, `GhostFloor` GF-V1/GF-V3, `CycleOutDebug`, whale gate. Each needs
   what `RescueSurplus` needed: build the member at the MatB cycle-out instead of the MatA
   crossing. **`RescueSurplus` and `GF-V3` are the two worked examples; the rest is that
   job repeated.**
2. **`stress_test_full.js` ×2** — `Expected 'F8V8: already in matrix' but got
   'F8V8: sfContribution exceeds fee'`. Session 3 already named these two as the bug that
   was sitting in plain sight in the 51, and they are now asserting the OLD revert string
   against a keeper that prices correctly. Fixture, one line each.

## ✅ BOTH OWNER DECISIONS ARE SETTLED — 2026-08-17, MEASURED THEN DECIDED

**Superseding the "STILL OPEN" section below, which is kept for its reasoning.**

### ⚠️ DECISION 1 — PARAM 59 3400 -> 5000 — **SUPERSEDED, SEE THE PHASE 6 SECTION ABOVE.**
### (original reasoning kept below; it was correct on the basis it had)

The owner's instinct was **4000**. A sweep added to `scripts/model_item_a.js` measured what
each ceiling actually buys, against the live population (n=72, block 45578581):

```
    0 bps  ceiling  $0.00   rescued   6/72   refused 66
 1700 bps  ceiling  $1.70   rescued  12/72   refused 60
 2500 bps  ceiling  $2.50   rescued  44/72   refused 28
 3400 bps  ceiling  $3.40   rescued  57/72   refused 15     <- today
 4000 bps  ceiling  $4.00   rescued  60/72   refused 12     <- OFF the DAO menu
 5000 bps  ceiling  $5.00   rescued  72/72   refused  0     <- DECIDED
 6800 bps  ceiling  $6.80   rescued  72/72   refused  0
10000 bps  ceiling $10.00   rescued  72/72   refused  0
```

**4000 was rejected on the data, not on taste. It buys THREE members** (57 -> 60) and still
refuses 12, because **12 of the 15 refused sit in a $0.28 band between $4.00 and $4.28** —
a $4.00 ceiling lands just underneath the cluster it was meant to catch. The tail is a
cliff, not a slope, and the sweep is the only thing that could have shown that; min/median/
max cannot answer "how many clear at X" for an X between them.

**AND 4000 IS SETTABLE BUT NOT VOTABLE.** `StabilityFund.setInsolvencyFloorBps` accepts any
bps <= 10_000 (a free range, not an enum), so it CAN be deployed — but `V8Governance.sol:496`
enumerates `[0, 1700, 2500, 3400, 5000, 6800, 10000]` and 4000 is not on it. Set it and the
DAO could never vote back to it. That is CLAUDE.md's `375/400` trap in a new costume:
on-chain state drifting from the source default with nothing keeping them equal. Deploying
4000 honestly would mean moving the source default, the DAO menu and the `GF-G1`
menu-discipline test together — three files, to buy three members.

**THE JUSTIFICATION IS NOT THE MEDIAN ANY MORE, AND THAT MATTERS.** Session 2 argued from
*"one completed journey earns min $3.40 / median $4.83 / max $6.34"*. The 2026-08-17 run
reads **min $3.40 / median $3.40 / max $5.93** — the median IS the structural no-referral
minimum now.

⛔ **I FIRST CALLED THIS "ONE OF THE TWO RUNS IS WRONG". THAT WAS WRONG, AND THE TELL WAS
IN THE NUMBERS I ALREADY HAD.** The MAXIMUM fell, $6.34 -> $5.93. A completed journey's
earnings cannot decrease for a member who stays, and adding members cannot lower a maximum.
**So the population TURNED OVER between the two readings — it did not merely grow.** The
$6.34 member left the MatB queue (rescued or evicted) and new ones arrived. Both runs are
correct; they measure different populations nine hours apart. The degraded reconciliations
(chain pay 97.3% -> 92.6%, pool 77.7% -> 50.2%) are separately explained: pool settles per
ROTATION and the chain has been organic and quiet since bigfill stopped, so more of it sits
unsettled in the accumulator. Neither needed to be a fault.

**AND THE TURNOVER SAYS SOMETHING WORTH KEEPING.** The queue is churning, and the member who
left was the RICHEST one — which is what you would expect, because the richest ask the least
and are the ones the fund can afford. **A queue that keeps losing its wealthiest members
gets poorer, and its median ask rises over time.** That is one observation, not a trend, and
it must not be quoted as one until a third reading exists. But it points the same way the
decision went.

**THE STANDING LESSON, because I nearly filed a false alarm as a finding:** two runs
disagreeing is not evidence that an instrument is broken. Check first whether they measured
the same thing. And it is the reason PARAM 59 is anchored to `CROSSING_RESERVE_BPS` and not
to a median — **a median over a churning queue is a snapshot, not a property of the system.**

The decision does not rest on it. **The operative number is the max ask, $4.28 — measured
twice, on two population sizes, identical to the cent.** And the defensible anchor is
structural rather than statistical:

> **5000 bps IS `CROSSING_RESERVE_BPS`. The fund lends at most what the system itself
> reserves for a crossing.**

That does not drift between runs, it is already on the DAO menu, and it reads honestly in
member comms — better than either "a median" or "one full journey's earnings", which was
the 3400 framing and is now contradicted by its own data.

**COST, BOUNDED:** the 15 extra members each ask between $3.40 and $4.28, so the entire
marginal exposure of 3400 -> 5000 is **$51.00 to $64.20**, against a fund holding $451.66
which item A simultaneously relieves of $96.70. Absolute worst case across all 72 is $308
if every member asked the maximum; none do, the median ask is $1.90.

**⛔ AND THE CORRECTION THAT SHOULD HAVE COME FIRST: PARAM 59 IS NOT REQUIRED BY ITEM B.**
Session 2 wrote that 5000 is needed *"so all 63 members at re-entry are rescued and item B's
promise holds."* **That is wrong.** Item B is about members evicted **MID-CYCLE**, and every
one of those is a MatA parker — all 61 of whom item A frees outright, 100%, measured twice.
The members the floor refuses are MatB parkers **at re-entry, having COMPLETED a full
cycle**. Evicting them does not violate item B. **Item A alone satisfies item B.** PARAM 59
is a purely economic generosity choice and was decided as one. Anyone re-opening it should
argue it on cost and member lifetime, never on item B.

**SECOND-ORDER EFFECT, ACCEPTED WITH EYES OPEN:** 23 of 72 re-entry members carry SF debt,
and `_crossToPartner` sweeps all remaining withdrawable to repay it (`:882-897`). Under item
A they arrive holding MORE, so an indebted member is clawed back HARDER, not spared. Raising
the ceiling means more members borrow, so that group grows next cycle. This is scope defect
3 and it is not fixed by this decision.

### DECISION 2 — THE SF RESCUE LADDER: **KEEP PRESET 1. NOTHING MOVES.**

Measured, and it closes the question session 3 opened: **the poorest live member at re-entry
holds $5.72 — 5,720 bps against preset 1's 4,000 bottom rung.** Not one member of the live
population falls off the ladder. Derived from the sweep: the largest ask is $4.28, so the
smallest holding is $10.00 - $4.28.

The ~3,400 bps case session 3 worried about belongs to a member **mid-journey-B**, and under
item A those never park — there is nothing to pay until cycle-out — so **they never meet the
ladder at all.** The cliff that showed up in `V8_48_KeeperScan.test.js` was the FLOOR, not
the ladder (see the correction above), and it is bought back by decision 1.

**Revisit only if item D (shallow seating) turns out to be real**: a member seated at seat 2
collects $0.25 of a journey and could arrive at re-entry far below anything on chain today.
That frequency is still unmeasured — it is test T5, and `scripts/diag_seating_depth.js`
exists but has never been able to fire.

### ✅ FINALISED IN SOURCE — NOT LEFT AS A DEPLOY STEP

- **`StabilityFund.sol` `insolvencyFloorBps` default is now `5_000`.** Done in source, not
  deferred to a setter call, and that choice is the point: **V8.50 is a fresh deployment, so
  the source value IS the live value from block one.** Leaving `3_400` would have needed a
  runbook step that can be forgotten, with the community's fund silently on the old ceiling
  until someone ran it — which is `375/400` in CLAUDE.md, exactly. 5_000 is already on the
  governance menu (`V8Governance.sol:496`), so the DAO retains full control.
- **The change cost six test edits and every one of them made the suite better.** Two
  "declared default" pins moved 3400n -> 5000n deliberately (they exist to catch accidental
  drift; this drift was chosen). Four boundary tests — `GF-F1`, `IF-1`, `IF-3`, `IF-5` — had
  the $3.40 ceiling HARD-CODED and silently became change detectors the moment the default
  moved. They now DERIVE the ceiling from `insolvencyFloorBps`, so the rule under test is
  "headroom == ceiling - debt" rather than a number. That is this suite's own item-42
  lesson, applied to itself.
- **VERIFIED, NOT ASSUMED: the change has ZERO net effect on the suite.** Full run before
  and after, same sandbox: **574 passing / 21 failing, and the failing SET is identical
  member-for-member.** Nothing else in the codebase keyed off 3400. (The same sandbox now
  matches the owner's machine exactly, 574/21 — the earlier "drifts by two tests" note was
  an artefact of running `KeeperScan` ALONE rather than in suite order. Worth knowing before
  trusting a single-file run again.)
- ⚠️ `contracts/StabilityFund.sol` is the FIRST contract file touched since `24c193c`. One
  constant plus comments, so bytecode is unmoved. **Sizes run, all watched contracts fit:**

```
  TierRouter        23,910  (666 spare)      MatrixLogicLib   24,013  (563)
  MatrixPairFactory 24,228  (348)            MatrixKeeper     21,229  (3,347)
  StabilityFund     15,063  (9,513)
```

  **THE BUILD REPRODUCES ACROSS TWO MACHINES BYTE-FOR-BYTE** — the sandbox container and the
  owner's Windows box produce identical deployed sizes on all five. That is a stronger
  statement than "it fits" and it retires the earlier worry about sandbox drift entirely.

- 🔎 **ONE UNEXPLAINED NUMBER, LOGGED RATHER THAN IGNORED: `MatrixKeeper` reads 21,229 here
  and session 3 recorded 21,282 — 53 bytes SMALLER now.** Nothing in this session touched
  `MatrixKeeper.sol` (mtime unchanged since session 3), and TierRouter, MatrixLogicLib and
  MatrixPairFactory all match session 3's figures EXACTLY, which rules out a toolchain or
  optimiser difference. The likely cause is mundane: session 3 ran `sizes.js` before its
  final edit to that file and recorded the earlier figure. **Direction is benign — headroom
  went UP, 3,294 -> 3,347 — so nothing is at risk.** Recorded because an unexplained number
  is an incomplete handoff, and 21,229 is now the figure to check future runs against.
- `sfRescueLadderPreset` stays **1**. No action.
- **The crossing buffer is the third lever and it is already decided by V8.49:** live V8.48
  hardcodes `CROSSING_BUFFER_BPS = 3600` and the model's Phase 1 warns about it every run —
  every rescue seeds 36% of the fee into withdrawable as SF money without passing through
  `_credit()`. V8.49 made it a governed param defaulting to **0**, and V8.50 carries that.
  Confirm it ships at 0 in the predeploy checks; it is worth more to the live fund's
  solvency than either decision above.

## ~~THE TWO OWNER DECISIONS — STILL OPEN~~ — SUPERSEDED BY THE SECTION ABOVE, KEPT FOR ITS REASONING

**1. PARAM 59 `insolvencyFloorBps` 3400 -> 5000.** Decided in session 2, still not applied.
**A new measurement complicates it and must be read before it is applied.** In the
`KeeperScan` world, 5000 does NOT close the cliff — those two members ask **$5.13** against
a $5.00 ceiling and are still evicted. Parity only returns at **6800**.

⚠️ **DO NOT CARRY THAT NUMBER TO THE LIVE CHAIN.** That world is `MATRIX_SIZE 7`, where one
journey earns **$2.44 (24%)** against the structural **$3.40 (34%)** at 127. Those members
are POORER than any real member and their ask is correspondingly larger. Live, `n=63`, the
maximum ask is **$4.28** — which 5000 clears with room, which is exactly why session 2
chose it. **The fixture measures the SHAPE of the cliff, not its live depth.** What it
does add, honestly: 5000 is not a large margin, the live max is 86% of the way to that
ceiling, and if journeys ever earn less than they do today the ceiling bites first.

**2. The SF rescue ladder's bottom rung.** Session 3 framed this as the lever. **The
reproduction says the floor is what bit, not the ladder** (see the correction above), so
the honest form of decision 2 is now: *is there a population that falls off the 4,000 rung
at all?* In the fixture, no — the poorest divergent member read 4,120. `model_item_a.js`
against the live population is what answers it.

**NEITHER IS SETTLED HERE, AND NEITHER SHOULD BE SETTLED FROM THE FIXTURES.** The command
is still the one session 3 gave, and it needs the owner because neither sandbox can reach
Base Sepolia:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
Remove-Item Env:ADDRESSES_FILE -ErrorAction SilentlyContinue
node scripts\model_item_a.js
```

## PROGRESS ON THE 21 — DOWN TO 3

Nine more closed after the owner's `test_v850_task2.txt` run. Every one was a fixture; no
contract logic changed (the only contract edit this session is the PARAM 59 default).

| what | tests | the fix |
|---|---|---|
| `V8.10` parkedAt / evictParked | 4 | new `parkOneAtReentry()` helper — follow the park to MatB |
| `V8.38` L1 / L2 / L4 | 3 | ensure-not-shove on `forceCross`; L1's precondition re-stated |
| `stress_test_full` S2 x2 | 2 | `sfContribution` = CROSSING_PRICE, not the full fee |

**`V8.10` x4 is the one worth reading**, because it is the template for most of what is
left. The fourteen-registration sequence used to leave `s0` parked in MatA. Measured now on
that exact fixture:

```
  matA  parked 0   occupancy 7   rotationCount 8     <- everyone crossed themselves
  matB  parked 1   [w1]          rotationCount 1     <- the one real park
```

So the tests follow the park to MatB via a shared helper that ASSERTS the precondition
loudly. They were never about which half the park happened in — they are about `parkedAt`
and `evictParked` mechanics — and saying so in the helper is most of the work.

**`stress_test_full` x2 is session 3's "bug sitting in plain sight", closed.** They passed
`sfContribution = T1_FEE` to `forceCrossKeeper` to make `memberShare` 0 and isolate the
seat guard. Under item A the whole crossing IS half a fee, so the full fee trips
`sfContribution <= crossingCost` FIRST and the seat guard was never reached. Now
`CROSSING_PRICE`, mirrored from `MatrixLogicLib`'s `internal` constant with its source
named — the same way `V8_48_SplitGrace.test.js` mirrors it.

### ✅ CLOSED 2026-08-18 ON MEASUREMENT — THE CLAIM BELOW IS FIXTURE-SPECIFIC

**READ THIS BEFORE THE SECTION IT PRECEDES.** Everything below was measured on
`V8Elevator`'s fixture, which picks its own tier fees. `scripts/model_item_a.js` PHASE 8
(added for this) reads the REAL ladder off each tier's MatA and asks the same question:

    THE LIVE FEE LADDER   T1 $10   T2 $25   T3 $50   T4 $100   T5 $250 ... T10 $10,000

    HOLDINGS AT THE MatA CYCLE-OUT, n=39 members who completed a journey
      V8.48 (crossing ate $5.00 of earnings)   min $0.00  median $0.00  max $5.90
      item A (reserve paid it in full)         min $3.40  median $3.40  max $10.90

    T2 ENTRY FEE $25.00 — who can upgrade at cycle-out?
      under V8.48    0 of 39
      under item A   0 of 39

**THE LOGGED CLAIM IS FALSE ON THIS CHAIN.** Nobody reaches T2 at their first cycle-out
in either world, so **T2's whale gate does not trip sooner, `tierGateThreshold` needs no
recalibration, and there is no contract change.** The `$7.66 against a $7 T2 fee` figure
below is the fixture's ladder; the live T2 fee is $25.00. **The open scope item is
CLOSED — measured, not real here.**

### ⛔ BUT THE REAL FINDING IS BIGGER THAN THE ONE THAT WAS LOGGED

Read the two holding rows again. **Under V8.48 the median member holds $0.00 after their
crossing.** A completed journey earns $3.40 and the crossing demands $5.00 of earnings on
top of the reserve — so the median member cannot fund the crossing at all. They park, or
they borrow. That is the 68 MatA parkers and the $727.05 of lending, seen from the
member's side rather than the fund's.

Under item A the same member keeps **$3.40 every cycle**.

So item A's effect on progression is not "T2 arrives one cycle sooner". It is that **T2
becomes reachable AT ALL for the median member** — roughly eight cycles of accumulation
at $3.40, against a V8.48 per-cycle balance of zero and no upward path whatsoever.

**Correct the framing wherever it appears.** This document has said "the benefit arriving
faster than predicted". It is not faster. It is **existing where it previously did not**.
That is a stronger claim, it is measured, and it is the one to use with members.

⚠ NOT MODELLED: multi-cycle accumulation. PHASE 8 answers only "does item A move the
FIRST cycle-out across the T2 line", which is the specific claim that was logged. The
eight-cycle figure above is arithmetic on the median, not a simulation. A real
progression model would simulate repeated cycles and is a separate piece of work.

---

### THE ORIGINAL ENTRY, KEPT VERBATIM — ⛔ ITS NUMBERS ARE THE FIXTURE'S, NOT THIS CHAIN'S


**Two failing tests turned out to be one finding, and it is not a test problem.**

At a MatA cycle-out under V8.48 the crossing consumed a full fee — $5 reserve + $5
earnings — leaving a T1 member $2.66 against the $7 T2 fee, so the additive cycle-out's
UPGRADE leg could not fire. Item A charges that crossing $5 and leaves **$7.66**. Measured
on `V8Elevator`'s own fixture: W1 now reaches **tier 2 inside nine registrations**, seated
in MatB and MatA2 at once.

**Nothing new fires and nothing leaked.** The additive cycle-out is V8.43 behaviour that
merely became AFFORDABLE; the T2 whale gate stays shut; and cycle-completed eligibility
bypassing a closed gate is deliberate and pinned by V8.44 UX3/C2. The member did not skip
MatB — they hold both seats.

**THE CONSEQUENCE IS ECONOMIC AND IT IS LIVE.** `tierGateThreshold` and
`whaleGateThreshold` were calibrated in a world where members could not afford to upgrade
at their first cycle-out. **T2's whale gate will now trip sooner than V8.48 modelled**,
because members reach the tier one cycle earlier. Owner decision 2026-08-17: **ACCEPT it —
this is the "more completed rotations, more tiers, more CNOVA" benefit the scope promised,
arriving faster than predicted — and log the threshold recalibration as an OPEN SCOPE
ITEM.** No contract change; nothing blocks the deploy.

**The two tests were asserting POVERTY, not the rule they were named for.**
`tierFirstEntries(2) == 0` was only ever true because nobody could afford to move. The
whale-gate test now asserts what it was always about — the gates are per-tier, and
tripping T1's does not trip T2's. **DONE.** The 15-registration test is NOT done and is a
walk-through item below, because its assertion pins a different rule.

**STILL OPEN, for whoever picks this up:** re-measure when T2's gate trips under item A
against the live population before the thresholds are trusted. `scripts/model_item_a.js`
does not model tier progression today; it would need a new phase.

### ⛔ NEW SCOPE FINDING: `EvictionReserveReleased` IS NOW ALL BUT UNREACHABLE

Found while walking GF-V3, and it is worth more than the test fix it came from.

Releasing a crossing reserve on eviction needs a member who is **(a) parked, (b) holding a
reserve, and (c) NOT seated in the partner half** — because a holder seated in the partner
is a GHOST, and the valve dequeues those without touching a balance. Every park site in
`MatrixLogicLib` was walked against that three-part test:

| park site | holds a reserve? | a ghost? | reachable under item A |
|---|---|---|---|
| `:947` funding shortfall | yes | no | **NO — item A deleted this park** |
| `:876` duplicate seat | yes | **YES, by construction** | dequeue-only, releases nothing |
| `:1461` `softParkIdle` | no — releases it itself at `:1447-1450` | no | n/a |
| MatB, any cause | no — item A spent it | no | n/a |
| `:906` mid-cascade deferral | yes | no | yes |
| `:523` cascade-refill on entry | yes | no | yes |

**Only the last two survive, and no test in this suite constructs either deliberately.**
Measured, not reasoned: a duplicate holder parked in MatA was built and evicted — the
contract emitted `GhostDequeued`, not `MemberEvicted`, and released nothing. Correct
behaviour, and it closes off the one path that looked promising.

**So on the live chain, eviction will essentially never release a reserve under item A:
the members who still hold one when they park are ghosts, and ghosts are dequeued.** That
is not a bug — it is item A removing the poverty park, which was the only common way to be
parked while still holding a carve.

**WHAT NEEDS DECIDING (not urgent, not deploy-blocking):** whether the release path is
still worth carrying. It is live code with a live event and near-zero reachability. GF-V3
now pins the behaviour that actually ships — a MatB eviction releasing nothing — and
asserts `EvictionReserveReleased` count is **0**, which will fail loudly if anything ever
starts carving a MatB reserve again. That makes it a regression guard for item A rather
than coverage of the release.

### ⛔ WALK-THROUGH ITEMS — 3 LEFT OF 6

**DONE:** GF-V1 and GF-V3 (below), on the owner's go-ahead 2026-08-17.

**GF-V1 — SOLVED BY MOVING TO A CONSTRUCTION THAT STILL WORKS.** It swung *MatA's* partner
to the decoy and seated through `_enterMatrix` into a FULL MatA, which under item A
cascades a real cycle-out into an unwired decoy. `V8_46_PairGuard` G2's construction was
adopted instead — swing *MatB's* partner, seat both halves through the PairManager BEFORE
anything is full, restore — so nothing cascades and the decoy never has to accept a
crossing. Hoisted into shared `forceSeat()` / `seatBothHalves()` helpers in that file.

**GF-V3 — RESOLVED AS A FINDING, see above.**

**`CycleOutDebug` — REBUILT, NOT RETIRED, AND THE FIRST CALL ON IT WAS WRONG.** It was
triaged as "retire it, the behaviour is covered by `V8_44_CycleOut` and
`V8_48_RescueSurplus`". **That was judged from the filename and the error message, not
from reading the file, and it was wrong.** Those two cover `selfRescue` and `coPayRescue`
— the member paying for THEMSELVES. Checked properly: only two files call both
`payForceCross` and `forceCrossKeeper`, this one and `stress_test_full`, and
`stress_test_full` only exercises the REVERT paths. `V8_44_Keeper` covers force-rotation
and epochs, not member rescues.

**So this is the ONLY test in the suite where the Stability Fund successfully rescues
anybody** — and this handoff's own open-items list already says *"no end-to-end test that
a real rescue books shortfall and nothing more"*. Deleting it in the same release that
REPRICES rescues would have thinned a known-thin area at exactly the wrong moment.

It moved instead: members now park at the MatB cycle-out, where re-entry costs a full fee,
and that is where the live keeper will find them. The rebuilt flow asserts MatA parks
NOBODY, the member holds no reserve, the floor refuses a full-fee advance at the NEW $5.00
ceiling (PARAM 59 = 5000), the floor is raised, SF funds, `forceCrossKeeper` completes it,
and the member re-enters MatA **with a fresh $5.00 reserve carved**.

Two assertions were tried and abandoned on the way, both recorded in the file: "the queue
is empty" and "the count dropped by one". Both are wrong for the same reason — the rescue
re-seats the member, which cascades, which cycles ANOTHER member into their own re-entry
park. One out, one in, net zero. **That churn is item A's thesis showing up as a side
effect, not a fault.** The test scans for the rescued member's ABSENCE instead, which says
what the rescue promised and nothing about the fixture's shape.

**STATUS: 592 passing / 7 pending / 3 failing** (was 60 failing at the start of session 4).
Remaining: the 15-registration re-entry-priority test, `V8.35` G4, and `V8_44_Overflow`
O1+O2 — items 1, 6 and 4 of the walk-through list.

### ⛔ THE ORIGINAL SIX, FOR REFERENCE

**Owner instruction 2026-08-17: walk through each before changing anything.** They were
triaged as "the same fixture shape" and they are NOT. Every one asks what the test should
now MEAN, and each answer is a small policy decision. **The mechanical tail is finished;
this is the judgement tail.**

1. **`V8Elevator` — 15-registration re-entry priority** (`expected 2 to equal 1`).
   Pins the V8.44 rule *re-entry has priority over upgrade at a MatB cycle-out*. Item A
   moves the upgrade EARLIER — to the MatA cycle-out — so W1 is already T2 before the
   moment this test examines. The rule is still real; the fixture no longer isolates it.
   Complication: proving "funds went to re-entry, not upgrade" needs a tier ABOVE the
   member's current one to be available, and T3 is not deployed in this fixture.

2. **`GF-V1` — the ghost can no longer be constructed.** It swings MatA's partner to a
   decoy, seats W1 through the decoy, restores the pair. Under item A that entry cascades
   a REAL cycle-out; the root can now afford to cross; it crosses into the unwired decoy
   and dies on `F8V8: not authorized`. Under V8.48 the root was underfunded and simply
   parked, so the cascade never reached the partner. **Recommendation: build the ghost at
   a moment the matrix cannot cascade — do NOT wire the decoy, because a decoy that
   accepts crossings has stopped being a decoy.**

3. **`GF-V3` — eviction's reserve release may now be DEAD CODE, and that is the real
   question.** It asserts a cycle-out park keeps its $5 reserve, then that `evictParked`
   emits `EvictionReserveReleased` and folds it into withdrawable. Under item A a MatB
   parker holds $0.00, so nothing is released and the event does not fire
   (`releaseReserve` guards `r > 0`). **And a MatA parker — the only member who still
   holds a reserve — no longer exists: MatA parks nobody.** So before re-fixturing, answer
   the real question: **is `EvictionReserveReleased` reachable at all under item A?** If
   not, that is a scope finding, not a test edit.

4. **`V8_44_Overflow` O1+O2 — needs a member who no longer exists.** Requires a parked
   MatA member to `selfRescue` into a full MatB. The invariant it protects (own members
   return to their OWN pair, never a later one) is worth keeping, but re-pointing it at a
   MatB parker breaks one assertion outright: *"own MatB must rotate from the rescue
   entry"* stops being true, because a MatB parker re-enters MatA and does not rotate
   MatB. Something must be re-stated, not re-pointed.

5. **`CycleOutDebug` — its entire premise is what item A deletes.** The test is *"W1 parks
   on cycle-out (insufficient funds), keeper rescues to MatB"*. Item A means W1 crosses
   itself; there is no park and no rescue. **Recommendation: this one is a genuine
   RETIRE-or-repoint decision, and retiring it is defensible** — it is a diagnostic
   harness, its behaviour is covered by `V8_44_CycleOut` and `V8_48_RescueSurplus`, and
   keeping it means inventing a scenario item A worked to prevent.

6. **`V8.35` G4 — a member count moved** (`expected 9 to equal 8`). FIFO placement after a
   factory expansion. Item A changed who is seated where at the moment the factory fires,
   so the count shifted. **Needs reading before touching: this is the only one of the six
   where the FACTORY, not the parked queue, may be what moved.**

### THE 6 THAT REMAIN

- **9 of one shape — a fixture that needs a parked member item A no longer produces:**
  `V8_44_CycleOut` T1-T4, `V8_44_Overflow` O1+O2, `V8_47_UpgradeGate` G3, `CycleOutDebug`,
  `GhostFloor` GF-V3, `V8.35` G4. Four of them announce it outright with
  `expected 0 to equal 5000000` — a fixture asking for a $5 reserve item A no longer
  carves. `V8_48_RescueSurplus.test.js` and the `V8.10` helper are the two worked examples.
- **3 odd ones, each needing to be READ rather than pattern-matched:** `V8Elevator`'s
  15-registration re-entry count (`expected 2 to equal 1`), the `V8.21` whale gate
  (`expected 1 to equal 0` — a first-entry counter, possibly a genuine behaviour question
  rather than a fixture), and `GhostFloor` GF-V1 (`F8V8: not authorized` inside `seatVia`,
  a different failure entirely). **Do not assume these are the same job as the nine.**


## STATE OF THE TREE

**No chain was touched. No transaction sent, nothing deployed, no parameter set, the VPS
keeper untouched, live V8.48 exactly as it was.** `.env` line 69 is still
`deployed_addresses_v8_48.json`. Every command run was a read, a local build, or a test —
and every test ran in a sandbox container, never against a chain.

**`contracts/` is UNCHANGED from `24c193c`.** Seven files in `test/` are modified, plus `scripts/model_item_a.js` (the PARAM 59 sweep), and
nothing is staged. Git is the owner's to run:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
git status
git add test/V8_48_SplitGrace.test.js test/V8_48_GhostFloor.test.js test/V8_49_InsolvencyFloor.test.js test/V8_49_EvictionClock.test.js test/V8_48_RescueSurplus.test.js test/V8_48_KeeperScan.test.js test/V8Elevator.test.js scripts/model_item_a.js V8_50_HANDOFF.md
git commit -m "V8.50: re-fixture the 24 tests that encoded pre-item-A economics; scope the KeeperScan equivalence premise and pin its one divergence"
git push origin v8.1
```

**Before the run whose numbers you intend to trust** — session 3's rule, unchanged:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat compile --force
npx hardhat test 2>&1 | Tee-Object -FilePath test_v850_task2.txt
```

…and remember that capture will be **UTF-16**. Decode before searching it.

## NEXT, IN ORDER

1. **The owner runs the suite** and the diff is taken mechanically against
   `test_v850_task1b.txt` — failure titles as sets, both files decoded first. The
   prediction above is 21 green and 1 new.
2. ~~`model_item_a.js`, then the two decisions~~ — **DONE, both settled above.**
3. **The remaining 12**, listed above. Nine are one shape with two worked examples; three
   need reading rather than pattern-matching.
4. **Defects 2 and 4** from the scope (`DIRECT_EARN_BPS = 500`, `totalEarnedOf`).

## METHOD NOTE FROM THIS SESSION

**A sandbox reproduction of the repo paid for itself many times over, and its limits are
the first thing to state about it.** Building the project in a clean container turned a
four-minute owner round-trip into a seven-second loop, and three of this session's results
could not have been reached without iteration: the RescueSurplus queue measurement, the
$0.95 commission that was silently corrupting an exact assertion, and the PARAM 59 sweep
that overturned session 3's reading of the cliff. It also **drifts from the owner's
machine by two tests**, which is exactly why every number above says where it came from.
The repo's own standing rule applied to itself: give every instrument something to check
itself against, and say which instrument produced which number.

---

# ⬛ SESSION 3 STATE — 2026-08-16, EVENING. READ THIS FIRST, BEFORE SESSION 2.

Session 2's plan is still the plan. This section says what happened building step 1 of it,
**corrects two things session 2 got wrong**, and names the one decision that is the owner's.

## THE HEADLINE NUMBERS — MEASURED, NOT ESTIMATED

| | passing | failing |
|---|---|---|
| baseline, item A stashed (session 2) | 593 | 1 |
| item A only (session 2, `after.txt`) | **543** | **51** |
| + session 3 keeper fix (`test_v850_task1b.txt`) | **534** | **60** |

**9 new failures, 0 fixed, every one attributed below.** The diff was taken mechanically
against `after.txt`, not by eye — decode, slice from the `N failing` line, compare failure
titles as sets. Do that again rather than reading 60 stack traces.

⚠️ **`after.txt` AND EVERY `Tee-Object` CAPTURE IS UTF-16.** `grep` finds nothing in them and
exits 0, which reads exactly like "no failures". Decode before believing any search of these
files. Windows PowerShell 5.1's `Tee-Object` has **no `-Encoding` parameter** (that is
PowerShell 7+), so this cannot be fixed at the capture site — fix it at the read site.

## WHAT SHIPPED (branch `v8.1`, compiles, sizes checked)

**`MatrixKeeperLib.sol` + `MatrixKeeper.sol` — the keeper now prices a rescue at what the
crossing COSTS, not at the entry fee.** New `_crossingCost(mat, fee)` mirrors
`MatrixLogicLib._crossingPrice` and the `cfg.isMatrixA ? … : …` line that appears in six
places there. It feeds three things in BOTH discovery (`_triageParked`) and execution
(`_doParkedRescue`): the ladder's denominator, `maxShortfall`, and `sfShare`.

**This half is load-bearing, not polish.** `forceCrossKeeper` REQUIRES
`sfContribution <= crossingCost`; a keeper still computing against the full fee hands it up
to 2x that and reverts its own rescue. `stress_test_full.js` proves it — two tests there fail
with `'F8V8: sfContribution exceeds fee'`, and they failed that way in session 2's run too,
before any keeper change. That was the bug sitting in plain sight in the 51.

**`MatrixKeeper.sol:722` zero-balance trap is now gated on `isMatrixA()`.** `reserve == 0`
was evidence of destitution only while every seated member was guaranteed to hold one. Under
item A it is the normal healthy state for every MatB member. In a MatA the old evidence still
holds, and those members keep V8.48 behaviour exactly.

**`TierRouter.sol` — COMMENTS ONLY, no executable change. See correction 1.**

**Sizes (`node scripts\sizes.js`): MatrixKeeper 21,282 (3,294 spare) · TierRouter 23,910
(666) · MatrixLogicLib 24,013 (563) · MatrixPairFactory 24,228 (348).** All fit.

## ⛔ CORRECTION 1 — SESSION 2'S TASK 2 WAS A FALSE ALARM. NO CODE CHANGE WAS NEEDED.

Session 2 wrote: *"`TierRouter` escrow-zero … makes the `escrow > 0` graduation branch at
`TierRouter.sol:1428` unreachable and dropping members into a park labelled 'autoReentry
disabled' — a misleading reason for a healthy member."* Checked against the source:

1. **Nothing is lost.** That branch's only work is releasing an UN-CONSUMED reserve. At
   escrow 0 there is nothing to release, and `releaseReserve()` guards on `r > 0` anyway. A
   member who entered a MatB at full fee still trips `escrow > 0` and is still released — so
   the test stays rather than being deleted.
2. **No healthy member is mislabelled.** The underfunded member is caught by the FIRST
   branch, `!anySeat && reentryOn`, evaluated BEFORE escrow is read, emitting "insufficient
   funds". "autoReentry disabled" is only reachable when re-entry genuinely is disabled.

**And every funding gate decides identically, because the conservation is exact.** At a T1
MatB cycle-out with no referrals: V8.48 = $5.00 reserve + $3.40 earnings − $1.60 crossing
debt = **$6.80**; V8.50 = $0.00 + $3.40 (journey A, KEPT) + $3.40 = **$6.80**. Same money,
same $10 re-entry. The V8.48 member just borrowed twice and parked mid-cycle to get there.

**WHERE THE MISREADING CAME FROM, closed rather than left open:** neither graduation branch
calls `parkCycledOut`. They emit `MemberParked` and park nobody — the member GRADUATED. The
event name is V8.44 legacy and reads like an eviction in the logs. **That is a real naming
defect**, frontend-and-tooling scope, deliberately not dragged into the item A diff.

## ⛔ CORRECTION 2 — SESSION 2'S ATTRIBUTION WAS WRONG, AND SO WAS ITS PRESCRIPTION

Session 2 said *"`V8_48_KeeperScan.test.js` (~44)"* of the 51. **That suite has 13 tests and
9 of them fail.** The other ~42 were never attributed. Do not trust "each is attributed" —
the run itself is the list.

More importantly, session 2's prescription — *"the ladder must stop reading a spent reserve
as poverty"* — was **built, tested, and reverted the same hour.** The full write-up sits at
the top of `MatrixKeeperLib._triageParked` so the next session does not rebuild it:

- The credit was `withdrawable + max(reserve, carve)`. For a MatA member the DENOMINATOR is
  the carve, so `wBps >= 10_000` always: **it made `EVICT_LADDER` unreachable for everyone,
  in every matrix.** A member holding nothing read as a top-rung self-funder, the keeper
  queued a rescue `forceCrossKeeper` refuses, swallowed as `WorkItemFailed`, retried every
  tick. **An eviction traded for an infinite loop.**
- The premise double-counted borrowed money. The only position where V8.48 reads higher is
  mid-journey in a MatB ($6.70 vs $5.10), and that gap **is** the $1.60 SF loan that funded
  the old full-fee crossing and got carved into a reserve. V8.48's number was inflated by
  debt; "restoring" it restores an artefact of the double-lending item A exists to remove.

**PROOF THE BACK-OUT DID WHAT IT CLAIMS**, because "it feels right" is not evidence: `EC-1`
and `EC-4` name their failing leg. With the credit in they failed on **`ladder:`**; with it
out they fail on **`floor:`**. The ladder behaviour is restored; what remains is a different
cause.

## THE 9 NEW FAILURES — TWO EFFECTS, BOTH INTENDED, NEITHER A BUG

**(a) ADVANCES GOT SMALLER, so the insolvency floor stops refusing — 6 of 9.**
`GF-D1`, `IF-7`, `IF-10`, the floor legs of `EC-1`/`EC-2`/`EC-4`, and the three
`V8_48_SplitGrace` fixtures ("ONE UNIT SHORT is a loan", "the 84% member … is unaffected",
"a LOAN rescue does NOT fire when the fund cannot cover it"). **The 84% member is exactly who
item A is for** — they need $5, hold $5, borrow nothing. These encode the pre-item-A
economics and must be RE-FIXTURED, not fixed.

**(b) THE LADDER CLIFF IS REAL AND IS NOW REPRODUCED — the owner's decision.**
Inside the already-failing `KeeperScan` diffs, this code now **evicts** in slots where the
frozen V8.48 copy rescued. Honest arithmetic: an early-MatB member reads ~**3,400 bps**
against preset 1's bottom rung of **4,000** and falls off it — debt-free, where V8.48 kept
them on it owing $1.60. **This was analysis in session 3 and is now a fixture result.**
Deliberately NOT fixed in code: the lever is `sfRescueThresholds`, a governed preset (presets
2 and 3 reach 3,000 and 1,000). It is an economic trade-off, not an arithmetic one.

## ⛔ TWO OWNER DECISIONS, TAKEN TOGETHER, BEFORE THE RE-FIXTURE IS FINISHED

1. **PARAM 59 `insolvencyFloorBps` 3400 -> 5000** — decided in session 2, still not applied
   (a deploy-time setting, not code).
2. **The SF rescue ladder's bottom rung.** Keep preset 1 (bottom 4,000) and accept that
   early-MatB members fall off it, or move to preset 2 (3,000) / preset 3 (1,000). Framing:
   under item A these members carry NO debt where V8.48 gave them one, so falling off the
   ladder is not the same event it was.

**Do not settle 2 from the fixtures alone** — run `scripts/model_item_a.js` against the live
population the way session 2 did, so the answer is measured on real members.

## NEXT, IN ORDER

1. **Re-fixture the 6 old-economics tests** (`SplitGrace` ×3, `GF-D1`, `IF-7`, `IF-10`) at a
   MatB re-entry, where a full fee is still charged, instead of a MatA crossing.
2. **`V8_48_RescueSurplus.test.js` (3)** — still "fixture produced no parked member", still
   item A working, same re-fixture. Unchanged since session 2.
3. **Decide the `KeeperScan` premise.** It pins the keeper byte-identical to a frozen
   `MatrixKeeperPrev`; item A changes the WORLD, so the premise is structurally incompatible.
   Session 2's advice stands: decide deliberately, record which and why.
4. **Then** the two owner decisions, then defects 2 and 4 from the scope.

## METHOD NOTES FROM THIS SESSION

- **A prediction at the wrong granularity is not a wrong diagnosis.** I predicted 60 -> 57
  and got 60. The diagnosis was right — `EC-1`/`EC-4`'s ladder leg DID recover — but these
  are MULTI-ASSERTION tests and fixing one leg does not turn a test green. Predict the
  assertion, not the test.
- **`npx hardhat compile` printed "Nothing to compile" for a file that HAD changed.** The
  cache's `contentHash` matched the on-disk md5, so Hardhat had seen it — but stale-artifact
  risk under a 594-test run is not worth reasoning about. `npx hardhat compile --force`
  settles it in 90 seconds. Do that before any run whose numbers you intend to trust.
- **Verify a write landed via `device_bash`, not the upload cache** — `wc -c` plus a `grep`
  for a string you just wrote. The cache served a stale file earlier in this project and cost
  an hour.
- **Two orphaned docstrings found and closed**, both the same shape: a comment left behind
  when its function moved, silently re-attaching to the next function.
  `MatrixKeeper.pendingChainLinkCount()` carried the SF-ladder docstring (stranded by V8.48
  item 12a); `TierRouter` had `reservedFor`'s sitting above `setGlobalJoined`. Worth a sweep —
  this repo has moved a lot of code between files.

## STATE OF THE TREE

No chain was touched. **No transaction sent, nothing deployed, no parameter set, the VPS
keeper untouched, live V8.48 exactly as it was.** `.env` line 69 is still
`deployed_addresses_v8_48.json`. Every command run was a read, a local build, or a test.

Session 3's work is COMMITTED AND PUSHED to `v8.1` as **`24c193c`** (4 files, +500/-68):
`contracts/MatrixKeeperLib.sol`, `contracts/MatrixKeeper.sol`, `contracts/TierRouter.sol`
(comments only), and this file — this line was corrected in a follow-up commit, so the
handoff itself is one commit later than the code. New
scratch captures in the repo root: `test_v850_task1.txt` (ladder-credit run, superseded) and
`test_v850_task1b.txt` (current). Both redundant once the numbers above are read; session 2's
`after.txt`/`before.txt` are still the baseline and should be kept until the re-fixture lands.

---

# ⬛ SESSION 2 STATE — 2026-08-16, LATER THE SAME DAY.

Everything below section 1 is still the plan. This section says what
happened when we started building it, and **it contains one finding that reorders the work.**
**Read session 3 above first — it corrects this section's task 2 and its failure attribution.**

Read `V8_50_SCOPE.md`'s "⬛ MEASURED ON THE LIVE V8.48 COMMUNITY CHAIN" section next — it
carries the numbers, the five source defects, and the two wrong turns the new instrument
took before it was right.

## WHAT IS DONE

- **Item A modelled against the real population.** New tool `scripts/model_item_a.js`.
  Note the handoff's own pointer was wrong: `model_insolvency_floor.js` does NOT model
  item A, it models the three floor POLICIES. Item A is confirmed and sized — frees
  **76 of 139** parked members outright, premise holds **100%** on chain, removes
  **63.7%** of all funding parks. Re-entry ask afterwards: median **$2.71**, better than
  the $3.20 the plan predicted.
- **ITEM C IS DECIDED BY THE OWNER: `insolvencyFloorBps` 3400 -> 5000.** Measured, not
  asserted: the rule *"never lend more than one full journey's earnings"* was calibrated
  on the STRUCTURAL no-referral minimum, but one completed journey actually earns
  **min $3.40 / median $4.83 / max $6.34**. At 5000 the maximum measured ask ($4.28)
  clears, so **all 63 members at re-entry are rescued** and item B's promise holds.
  NOT YET APPLIED — it is a PARAM 59 setting, not a code change.
- **Item A's contract core is written and COMPILES** — `contracts/MatrixLogicLib.sol` on
  branch `v8.1`, one file. See "WHAT THE CODE DOES NOW". It is NOT deployed anywhere and
  **must not be** until step 1 below is done — see the finding immediately after this list.

## ⛔ THE FINDING THAT REORDERS THE WORK

**Item A creates a member state that has never existed before: a live mid-cycle member
holding a ZERO crossing reserve.** Every MatB member is now in that state, because their
reserve was spent getting them there and no new one is carved.

The keeper is not ready for it, and the failure is not benign:

```
MatrixKeeperLib._triageParked:432   effectiveContrib = reserve + withdrawable
MatrixKeeperLib._rescueBpsFor:359   wBps = effectiveContrib * 10_000 / entryFee
```

With `reserve == 0` a MatB member's `effectiveContrib` roughly HALVES, `wBps` drops, and
they fall off the bottom of the SF rescue ladder — which routes to **EVICT_LADDER**.
`MatrixKeeper.sol:722`'s `withdrawable == 0 && reserve == 0 && debt > 0` trap is a second
door to the same place.

**So item A shipped WITHOUT the keeper change does not merely fail to help members at
re-entry — it evicts members the old code would have rescued. That is the exact opposite
of item B.**

**THE KEEPER CHANGE IS LOAD-BEARING FOR ITEM A'S SAFETY, NOT POLISH. THEY SHIP TOGETHER
OR NOT AT ALL.** The ladder must stop reading a spent reserve as poverty: what matters is
what the member needs NEXT (a full fee at re-entry) against what they hold, not a reserve
that item A deliberately consumed.

## TEST STATE — MEASURED BOTH WAYS. DO NOT GUESS AT THIS.

| | passing | failing |
|---|---|---|
| baseline (item A stashed) | **593** | **1** |
| with item A | **543** | **51** |

**All 50 new failures are ours.** A confident prediction in this session that
`V8_48_KeeperScan.test.js` used mock matrices was WRONG — it deploys real
`FigureEightMatrixV8` with the real `MatrixLogicLib` at test:152-157. Caught only because
the baseline was actually run instead of reasoned about.

- **The 1 pre-existing failure is inherited debt and is a TEST bug, not a contract bug:**
  `V8.46-B — cascade gas versus ladder depth`, `TypeError: Cannot read properties of
  undefined (reading 'worst')`. Log it; do not let it confuse a future run.
- `V8_48_RescueSurplus.test.js` (3) fails with *"fixture produced no parked member"* —
  **that is item A working.** The fixture parks someone at a crossing they cannot afford;
  under item A their reserve covers it and they cross. Re-fixture at a MatB re-entry,
  where a full fee is still charged.
- `V8_48_KeeperScan.test.js` (~44) asserts the refactored keeper is byte-identical to the
  frozen `MatrixKeeperPrev` (a V8.48 artifact). **The file states its own doctrine at
  test:190-199: every later item that deliberately changes behaviour gets PINNED, and
  "every pin here is an item that DID."** Item A cannot be pinned that way — it changes
  the WORLD, not a keeper parameter, and `MatrixKeeperPrev` will never know about item A.
  **This suite's premise is structurally incompatible with V8.50.** Do NOT delete it
  reflexively; decide deliberately (retire with a note / re-baseline the frozen copy /
  scope it to untouched behaviours) and record which and why.

## WHAT THE CODE DOES NOW — `contracts/MatrixLogicLib.sol`

The discriminator is **`cfg.isMatrixA`, the matrix's own immutable flag**. Crossing out of
a MatA means crossing into a MatB, which is the hop the reserve pre-funded. Everything
else enters a MatA and begins a new cycle at full fee. No interface change, and no
cross-contract read added to the money path.

**This decides the tier-upgrade question the scope told us to decide deliberately:**
upgrades arrive via the PairManager, never as the partner, so they take the full-fee
branch automatically and fund their own reserve. It cannot fall out of the diff wrongly.

- `_crossingPrice(entryFee)` — new helper, `entryFee * CROSSING_RESERVE_BPS / BPS_DENOM`
- `_crossToPartner` — charges `crossingCost`; `CrossingFunded` now reports the real total
- `enterMatrix` — pulls the crossing price on a crossing. `isCrossingEntry` is the
  destination-side twin of the source's price decision and **the two must agree or the
  transferFrom reverts on allowance.**
- `_distributePayments(..., bool skipReserveCarve)` — **the other half of item A. THE
  CARVE AND THE PRICE MUST MOVE TOGETHER:** carve on + full fee in = 10_000; carve off +
  50% in = 5_000. Either alone breaks the contract's cash balance.
- `_finalizeCrossing` — same price rule, and **now emits `CrossingFunded` (defect 5)** so
  rescued crossings stop being invisible to event tooling
- `forceCross` — **BUG FIXED:** pulled a full fee for an A->B hop, stranding 50% in the
  matrix as unattributed surplus
- `forceCrossKeeper` — **BUG FIXED:** unconditionally zeroed the reserve, erasing anything
  above the crossing price. Harmless while reserve == fee; not any more.
- `coPayRescue` / `_selfRescue` — priced at `crossingCost`, so an A->B hop needs no loan
  and no out-of-pocket payment at all
- **DELIBERATE NON-CHANGE:** the withdraw lock (`crossNeeded`, at :686 and :1345) stays at
  the FULL fee. A MatA member no longer needs it for the hop but WILL need it for the
  re-entry, and this lock is what accumulates it. Measured: **0 of 63** members at
  re-entry had withdrawn to wallet — the lock is doing all of that work. Repricing it
  would send members into MatB with nothing. The code says so; do not "simplify" it.

## NEXT, IN ORDER

1. **`MatrixKeeperLib` + `MatrixKeeper` for the zero-reserve state.** Load-bearing, see
   above. The keeper interface already has `isMatrixA()` (`MatrixKeeperLib.sol:89`, used
   at `:342`), so it can discriminate without new plumbing.
2. **`TierRouter` escrow-zero.** `MatrixLogicLib:775` passes the reserve as `escrow` to
   `handleCycleOut`; at MatB cycle-out that is now always 0, making the `escrow > 0`
   graduation branch at `TierRouter.sol:1428` unreachable and dropping members into a park
   labelled "autoReentry disabled" — a misleading reason for a healthy member.
3. **Re-fixture the tests**, and decide the `KeeperScan` question above.
4. **Scope defects 2 and 4** — `MatrixKeeper.DIRECT_EARN_BPS = 500` (dead but public, and
   wrong) and `totalEarnedOf` (the true earnings field has no getter, and the keeper's
   withdraw-ratio eviction test runs on a reconstruction that includes buffer money).
   Defect 1, the stale split comments, is DONE.
5. **Set PARAM 59 to 5000** at deploy, per the owner's decision.
6. **Second organic reading** — `logs/parked_baseline.csv` has one row for this
   deployment; a growth RATE needs two, and bigfill restarting ends the window forever.

## STATE OF THE WORKING TREE AND EVERY LOOSE END

Nothing in this session touched a chain. **No transaction was sent, nothing was deployed,
no parameter was set, the VPS keeper was never touched, and live V8.48 is exactly as it
was.** Every command run was a read or a local build/test.

**Files changed or added by session 2** (all on branch `v8.1`, contracts push to `v8.1`):

| file | what |
|---|---|
| `contracts/MatrixLogicLib.sol` | item A core. Compiles. Not deployed. |
| `V8_50_HANDOFF.md` | this file |
| `V8_50_SCOPE.md` | the measured findings section |
| `scripts/model_item_a.js` | new read-only instrument |

**Scratch files left in the repo root, safe to delete, deliberately NOT deleted here:**

- `after.txt` / `before.txt` — the two test runs behind the 593/1 vs 543/51 table above.
  Both counts are recorded in this document, so the files are redundant once read.
- `predeploy_A.txt`, `predeploy_B.txt` (2026-08-16 early), `predeploy_out.txt`
  (2026-08-13) — **these predate session 2 and are NOT ours.** They are predeploy_check
  output from the V8.49 and V8.48 deploy days. Left alone deliberately: an unexplained
  file is an incomplete handoff from an earlier session, and deleting one to tidy up
  destroys the record rather than closing the loop. Someone should confirm what they were
  for and then either log or remove them.

**Open, and each one is written up above rather than left implicit:**

1. The keeper's zero-reserve handling — **blocking, and the reason item A must not ship
   alone.**
2. `TierRouter` escrow-zero at MatB cycle-out.
3. 50 failing tests, all attributable, none mysterious.
4. The `KeeperScan` premise decision.
5. Defects 2 and 4 from the scope's list.
6. PARAM 59 -> 5000 at deploy (decided by the owner, not yet applied).
7. **The second organic reading is DONE — and it raised a question. See below.**

## ⛔ THE ORGANIC READING: 41 MEMBERS LEFT THE QUEUE AND THE FUND DID NOT MOVE

Two `diag_floor_halt.js` readings on live V8.48, 2.0 hours apart, both fully organic
(no bigfill since 03:30:44 -04:00):

```
parked          139 -> 98     (-41)
SF totalBalance $458.35 -> $458.35   (UNCHANGED, to the cent)
debtors         29 -> 23      debt total $32.74 -> $28.20
```

`logs/parked_baseline.csv` now has 2 rows for this deployment and the script printed a
trend: **"-496.1/day"**.

**DO NOT QUOTE THAT NUMBER AS THE QUEUE DRAINING.** It is the first organic trend this
project has ever had and it is almost certainly not what it looks like:

- **A rescue costs the Stability Fund money. The fund did not move by one cent.** So
  whatever removed 41 members, it was not the rescue path.
- **Debt-carrying members left too** (29 -> 23, $32.74 -> $28.20) **and the fund did not
  RISE either** — so their debt was not repaid on the way out.
- The remaining top-20 are the same addresses with the same balances, 2.0h older. The 41
  came from elsewhere in the queue.

Three candidate mechanisms, none confirmed, and they mean completely different things:

1. **Eviction.** `evictParked` releases the reserve to withdrawable, removes the member,
   leaves the debt on the SF ledger, and costs the fund nothing. If this is it, **41
   community members were evicted in two hours** — which is precisely what item B exists
   to prevent, and it makes V8.50 more urgent, not less.
2. **Ghost / residue dequeue.** The V8.48 item 45 `clearParkRecord` and item 47 valve
   remove queue entries for members who are actually seated. `diag_ghost_parked.js`
   measured **41 ghosts** on 2026-08-13 — the same number, which is either a strong hint
   or a coincidence worth ruling out. If this is it, no member was harmed and the queue
   never really held 139.
3. **Self-rescue** from members' own wallets — costs the fund nothing, but bigfill is
   stopped and these are bigfill wallets, so this is the weakest of the three.

**Do not reason further about this — measure it.** `scripts/diag_parked_growth.js` exists
and answers exactly this question: parks vs rescues vs **evictions** per day, the
repeat-park loop signature, and the SF debt financing. It is read-only:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
Remove-Item Env:ADDRESSES_FILE -ErrorAction SilentlyContinue
node scripts\diag_parked_growth.js
```

Until that runs, treat "-496.1/day" as **an unexplained observation, not a trend**, and do
not let it into member comms or into any V8.50 justification.

One more thing the pair of readings says on its own: **the fund being unchanged to the
cent over two hours means there were essentially no new entries either** (the SF takes a
split of every entry fee). "Purely organic" may be measuring a very quiet chain. That is
worth knowing before anyone extrapolates a growth rate from it in either direction.

**Nothing else from session 2 is in flight.** No half-finished edit, no script waiting on
an answer, no chain state expecting a follow-up.

## STANDING LESSON FROM THIS SESSION

Three confident, plausible claims turned out wrong, and all three were caught the same
way — by rerunning or reading the source instead of reasoning from a convenient proxy.
A median ask 7x better than predicted (buffer money counted as member earnings). A control
that refused a verdict for an "impossible" condition that was actually normal. A
prediction that a test suite used mocks when it deploys the real library. **The pattern is
always substituting an easy observable for the question actually being asked, and the fix
is always the same: go and look.**

**This replaces `V8_49_HANDOFF.md` as the entry point.** That file is still the record of
V8.49 — what it built, what the private test measured, and the traps from deploy day.
Read it for "why is V8.49 like this"; read THIS for "what am I building now".

## READING ORDER

1. **this file**
2. **`V8_50_SCOPE.md`** — items A, B, C, D, plus the **"⬛ MEASURED ON THE V8.49 PRIVATE
   CHAIN"** section at the top. That section is data, not plan; trust it over any
   derivation elsewhere.
3. `V8_49_HANDOFF.md` — for V8.49's own history and the deploy-day mechanics
4. `V8_49_TEST_PLAN.md` — how the private test was run, and its CORRECTIONS section
   (the cohort bleed, the offsets, why sequential)

---

# 1. WHERE THINGS STAND

## Two chains exist. Do not confuse them.

| | **LIVE — V8.48** | **TEST — V8.49** |
|---|---|---|
| who is on it | **the community** | owner + bigfill only |
| addresses file | `deployed_addresses_v8_48.json` | `deployed_addresses_v8_49.json` |
| how scripts reach it | **`.env` line 69 (the default)** | **shell override ONLY** |
| MatrixKeeper | (see the v8_48 file) | `0x03Ff2184Afa458eE743c123bdb93D7804953F49D` |
| StabilityFund | (see the v8_48 file) | `0x9b3EbdE821DE116cF338021D0Ab46590ed066CF8` |
| keeper driving it | the VPS (`167.99.0.250`) | `scripts/testchain_keeper.js` on Windows |
| frontend points at it | **yes** | **no — and that is what keeps it private** |

**`.env` line 69 must STAY `deployed_addresses_v8_48.json`.** Every live diagnostic
resolves through it. The test chain is reached by `$env:ADDRESSES_FILE=...` in the shell,
which wins because `hardhat.config.js:2` calls `dotenv.config()` with no override
(verified, not assumed — `probe_addrs_env.js` is the measurement).

**Both chains are Base Sepolia.** A "private deploy" is a private DEPLOYMENT, not a
private network: the same BIP-44 index is the same address, nonce and ETH balance on
both. Two bigfills running at once will collide.

## What is running right now

- **The VPS keeper drives live V8.48 and was never touched.** It has no authority on the
  test chain — `setUpkeepCaller` was deliberately never called there, and
  `testchain_keeper.js` signs as the deployer, which `performUpkeep` accepts as `owner()`.
- **The live bigfill was STOPPED 2026-08-16 03:30:44 -04:00** and has not restarted. So
  **live V8.48 is now running PURELY ORGANIC.** This project has never measured organic
  growth — every previous rate was bigfill's. **One `diag_floor_halt.js` run against the
  v8_48 addresses is worth taking early, before anything restarts it.**
- The test chain may still have a keeper and a traffic bigfill running. Both are safe to
  stop; every figure is already in `logs/testchain_keeper.csv` and
  `logs/parked_baseline.csv` (the latter now keyed by MatrixKeeper address, so trends
  never span two deployments again).

## Branches

Contracts push to **`v8.1`**. `admin → preview → main` is the FRONTEND repo only.
Everything from the V8.49 run is committed through **`394c35e`**.

---

# 2. WHAT V8.50 IS

**The version the community re-registers into.** V8.49 was a private measurement and the
community never saw it. V8.50 carries the economics change, and it is ONE member-facing
deploy, not four.

Owner's framing, and the reason V8.49 stayed private:

> *"every version is a fresh deployment members must re-join, and v8.47/v8.48/v8.49/v8.50
> in four days spends all their trust."*

---

# 3. ITEM A — THE CROSSING IS PAID BY THE RESERVE

## The owner's idea, in his words

> *"the crossing fee should be used for the crossing, so no reserve fee is required at
> crossing — that makes the 50% crossing fee pay 100% crossing, which covers all the fees
> required except the reserve. The reserve is only at the beginning. So entering A costs
> 100%, 50% reserve; entering B costs 50% only, that was reserved at A. They only need a
> loan when the full A+B cycle is completed and they are short to enter A again."*

## The defect it fixes, now MEASURED not derived

`MatrixLogicLib._crossToPartner` charges the **full** destination entry fee:

```solidity
uint256 reentryFee = IFigureEightMatrixV8Cross(destination).ENTRY_FEE();
```

So a member needs **50% of the fee from earnings at every crossing**, and a member with no
referrals earns **34%** per journey (`250 direct + 1800 pool + 1350 chain = 3400 bps`).

**Observed on the test chain, thirteen members simultaneously, to the cent:**

```
reserve $5.00   withdrawable $3.40   effective $8.40   shortfall $1.60
```

That is the "84% member" — 50% reserve + 34% earnings = 84% of a $10 fee. It appears
**only once members complete FULL journeys**; earlier parkers had partial pool weight and
scattered shortfalls. **The clean number is the steady state.** 84% of cycle-outs parked
(MatA rotations 51 = 43 parked + 8 crossed); only the earliest roots, carrying the most
pool weight, funded their own crossing.

## Why it works with no re-tuning — the constants already say so

```
CROSSING_RESERVE_BPS 5000  +  DIRECT_EARN_BPS 250  +  splits 4750  =  10000
```

**The distributions consume exactly 50% of a fee. The other 50% is the member's own
reserve.** A crossing paid entirely from the $5 reserve funds the destination's L1, chain
pay, pool, treasury, SF, dev, ops, community, buyback and liquidity **identically to
today — the same dollars to every destination**. Not one split BPS changes. The owner's
instinct that *the reserve IS the crossing* is correct in the constants.

## What it changes, at T1 ($10 fee, no referrals)

| | today | with item A |
|---|---|---|
| enter MatA | $10 → $5 reserve + $5 distributed | unchanged |
| cross A → B | **$10** — reserve $5 + **$5 from earnings** → short **$1.60** → PARK | **$5 from reserve. No shortfall. No park.** |
| reserve held in B | $5 (freshly carved) | **$0 — spent on the crossing** |
| journey in B | earns 34%, **clawback eats it repaying the A→B loan** | earns 34%, **kept** |
| cycle out of B → re-enter A | $10 needed, short again → **second loan → REFUSED** | $10 needed, holds **$6.80** → short **$3.20** |
| loan events per full cycle | **2** | **1** |
| mid-cycle parking | **yes — this is the queue** | **none** |

## ⛔ THE MEASUREMENT THAT MAKES ITEM A THE RIGHT FIX

The V8.49 run found **why** the second loan is refused, and it is not what
`V8_50_SCOPE.md` item C assumed.

**14 members were refused by the insolvency floor. Every one read `memberDebt $0.00`.**
The event log (150 loans / $195.78, 65 repayments / $47.95, both matching the contract's
own `totalRescueLoaned` / `totalRescueRepaid`) shows each **borrowed exactly once and was
repaid IN FULL by the clawback**:

```
outstanding debt $0.00  -> RESCUED BEFORE x1  (lifetime borrowed $2.12, repaid $2.12)
repayments : $0.71@blk45558974  $1.41@blk45558974
```

**`0 of 14 were refused on a first loan.`**

So the causal chain is:

> loan 1 (~$1.4–2.1) granted → **clawback takes the MatB earnings that would have funded
> the next crossing** → member reaches crossing 2 with those earnings gone → asks
> **$3.43–4.06** → exceeds the **$3.40** floor → **refused and evicted**.

**Item A removes the first loan, therefore removes the clawback, therefore the member
arrives at re-entry with the full $6.80 and asks $3.20 — under the ceiling.** That is the
whole argument, and every link in it is measured except the last, which is arithmetic.

**T3's boundary is exactly 66%**, confirmed:

| effective | % of fee | advance | verdict |
|---|---|---|---|
| $6.61 | **66.1%** | $3.39 | rescued |
| $6.57 | **65.7%** | $3.43 | **refused** |

$6.60 effective produces precisely a $3.40 advance.

## ⛔ WHAT ITEM A DOES *NOT* FIX — READ BEFORE BUILDING

Per full A+B cycle a no-referral member earns **68%** of a fee and needs **100%** to start
the next one. **That 32% gap is the system's own take** — L1, treasury, SF, dev, ops,
community, buyback, liquidity — about 16% per seat, twice per cycle. **Loans defer that
gap; nothing closes it except referral income.** `CLAUDE.md` already states this is the
design.

Carried one cycle further with today's numbers: the $3.20 loan is itself clawed back, so
the member reaches the NEXT re-entry holding ~$3.60 against $10 — asking **~$6.40, far
above the floor**. **Item A roughly DOUBLES member lifetime (a full cycle instead of half)
and does not fix solvency.**

**That doubling is the real prize and it is worth stating positively:** a member who today
dies at their first crossing would complete both matrices — more pool weight, more chain
pay, more CNOVA minted, and a materially better experience for the fully passive member.
That is the owner's argument and the data supports it.

## ⚠️ THE MARGIN IS THIN — MODEL BEFORE WRITING CONTRACT CODE

$3.20 against a $3.40 floor. **That fits, barely.** Measured lifetime earnings on the test
chain ran **$2.27–$2.92**, so members below the structural $3.40 fall outside it anyway.

**THE FIRST THING TO DO IS NOT TO WRITE CODE:**

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
node scripts\model_insolvency_floor.js
```

Model item A's economics against the population that actually exists on the test chain.
**The $3.20 figure is Claude's arithmetic, not a measurement.** If the model says the
post-item-A ask clusters above $3.40, item C has to move WITH item A and they ship
together.

---

# 4. TOUCH POINTS

From the scope, plus what the V8.49 run added. **Expect more; the plan is always short.**

## Contract

- **`MatrixLogicLib._crossToPartner`** — charge the reserve amount, not `reentryFee`
- **the destination's entry accounting** — accept a 50% payment and **skip the reserve
  carve**
- **`MatrixKeeperLib._triageParked` / `MatrixKeeper._doParkedRescue`** — `effectiveContrib`
  and the shortfall maths both assume a full-fee crossing
- **`exitSeat` and `evictParked` reserve release** — a member mid-cycle now holds **$0**
  reserve. Every path that releases or refunds a reserve needs to handle zero.
- **the tier-upgrade path needs its own answer** — is upgrading a NEW CYCLE (full fee) or a
  CROSSING (reserve only)? **Decide deliberately; do not let it fall out of the diff.**

## Newly identified by the V8.49 run

- **`crossingReserveOf` reads $0 for a mid-cycle member.** The frontend reserve badge
  (V8.48 item 2, `reservedHeldFor`) will show $0 to a member who is perfectly healthy.
  **That is a member-facing change and needs copy, not just code.**
- **Every diagnostic computes `effective = reserve + withdrawable`.** Under item A a
  mid-cycle member has reserve 0, so "effective" means something different.
  `diag_floor_halt.js`, `diag_seating_depth.js`, `diag_cohort_split.js` and
  `v849_watch.html` all need revisiting — and `v849_watch.html` **already under-reports**
  once the factory deploys a second pair, because it reads fixed addresses.
- **`maxItemsPerUpkeep = 15` may be unsafe.** Gas per rescue rose from **600k to 2.6M** as
  members began settling full journeys. A full 15-item batch projects to **~39M against a
  ~17.8M practical ceiling**. **A batch that fails for GAS is indistinguishable, in the
  results, from a floor failure.** Consider 5 or 10.

## Tests

**Every fixture asserting a full-fee crossing.** V8.49's much smaller change predicted 2
breakages and had 4, three of them the same hidden assumption. **Grep the suite for the
OLD justification, not just the identifier.**

---

# 5. ITEMS B, C, D

## ITEM B — no member evicted mid-cycle. SHIPS WITH A, NOT SEPARABLE.

> *"I do not want any member evicted mid cycle — they should complete their cycle before
> being evicted."*

A member parked at the A→B crossing **is** mid-cycle, and that is the main parked
population — now confirmed: 84% of cycle-outs parked there. Honouring this without item A
means either lending at every A→B crossing (what the floor exists to prevent) or leaving
them parked forever. **Item A is what makes this rule free.**

## ITEM C — LADDER VS FLOOR. ⛔ ITS STATED MECHANISM IS WRONG.

The scope describes it as a guard that arms **as debt accumulates**. **Debt never
accumulates** — the clawback repays each loan in full. Policy B refuses on **the size of a
single advance**.

So the question is not "how much debt should we tolerate" but **"how large a single ask
should the fund absorb"** — and it must be calibrated against **post-item-A asks (~$3.20,
then ~$6.40)**, never against today's $3.43–4.06, which describe a world with a first loan
and a clawback in it.

Options unchanged in form: accept / trim the ladder / raise `insolvencyFloorBps`
(PARAM 59, menu `0/1700/2500/3400/5000/6800/10000`). Note `3400` was derived as the
~34% median per-cycle earnings AND equals exactly one full journey's earnings — *"never
lend more than one full journey's earnings"* is a far more defensible way to say it in
member comms than "a median".

## ITEM D — SHALLOW SEATING. STILL UNDECIDED.

`scripts/diag_seating_depth.js` exists and its scan self-test passes exactly. **It was run
and produced no answer**, because the mechanism could not fire: idle reclaim needs
`extendedIdleTimeout` (7 days) and the test chain was six hours old, and
`MemberExitedSeat` needs a voluntary early exit bigfill never performs. **Zero backfills
was guaranteed before the first block.** The script now refuses to give a verdict in that
situation.

To settle it, one of: run a chain past 7 days · lower `extendedIdleTimeout` on a TEST
chain (as we lowered `parkedGracePeriod`) · drive early exits deliberately.

---

# 6. TRAPS — DO NOT REPAY THESE

## From the V8.49 run (all cost time on 2026-08-16)

**Nine instruments returned confident, plausible, wrong answers in one day.** Every one
substituted an easy observable for the question actually being asked:

- `predeploy_check:289` asserted a SOURCE FILE MENTIONS a filename, standing in for "the
  deploy writes the right file" — it forbade the env-override workflow outright
- a guard testing *"is the variable set"* standing in for *"did a human choose this chain"*
  — `dotenv` satisfies the former for free, so it never fired under `npx hardhat run`
- `check_nonce.js` reported *a* signer's nonce (Hardhat account #0, in-memory chain) as
  "the deployer is quiet", three times, immediately before a live deploy
- an absent-constant probe INFERRING absence from an error shape
- `-Offset` looking like cohort isolation when `SCAN_FROM` defaults to 0
- T5's spec naming `SlotReclaimed`, an event the keeper stopped emitting
- a work-type map with `3` GUESSED as `FORCE_ROTATE` (it is `CHAIN_LINK`; 6 is
  `EVICT_PARKED`)
- event signatures written from memory — wrong arity, and `args[1]` was the TIER, which
  would have been read as a dollar amount
- a baseline CSV that differenced rows ACROSS TWO DEPLOYMENTS and printed "-156/day"

**The ones that caught themselves were the ones wired to something they could reconcile
against:** `totalRescueLoaned`, `loanEligibleFor`, `occupancy()`, and a bytecode scan with
a positive control. **Give every V8.50 tool something to check itself against.**

**And the specific rule that keeps recurring:** `memberDebt` is a **BALANCE, not a
LEDGER**. A member who borrowed and repaid reads $0.00 and is invisible to every snapshot.
Use `diag_loan_history.js` (event-sourced, self-testing) for any claim about history.

## Standing repo traps

- **Claude's device-bridge git is NOT trustworthy in these mounted folders** — it cannot
  unlink `.git/index.lock` and will report a working tree that is not the real one.
  **Claude may READ files through the bridge; every git verdict comes from the owner
  running the command.** Never `git add -A`; stage by explicit path.
- **`MatrixKeeper` is a LINKED contract** — `getContractFactory` needs
  `{ libraries: { MatrixKeeperLib: <addr> } }` or it throws before any test body runs.
  `V8Governance` and `StabilityFund` are NOT linked.
- **A clock or a gate is TWO gates** — discovery (`checkUpkeep` / `MatrixKeeperLib`) and
  execution (`performUpkeep` / `MatrixKeeper._do*`). Find both before believing any
  "X happens after N". *(Checked this run: for parked RESCUE the grace is a single gate,
  in `_checkParked:560`. For EVICTION it is genuinely two.)*
- **Never draw a negative conclusion from a truncated search.** Verify the premise, rerun
  rather than assert.
- **Do not hard-code emergent numbers.** Growth rate is a dial the owner controls.
- **When a check and a setter disagree, read the setter** — it is the one the chain
  enforces.
- **A write that reads back wrong is usually a STALE READ.** `KEEPER_VPS_CONFIG.md`
  recorded this for `set_entry_thresholds.js`; it recurred on `set_parked_grace.js` this
  run. **Re-read after ~20s. NEVER re-run a state-changing command on that warning alone.**

---

# 6c. DEFECT 6 — PARKED WORK IS STARVED IN DISCOVERY (found session 5, OPEN)

**`MatrixKeeperLib.discover` fills the batch in a fixed order and `_scanParked` runs
FIFTH**, after:

1. `WORK_VELOCITY` (at most 1)
2. `WORK_CHAIN_LINK` (one per pending link)
3. the frozen-MatB sweep -> `WORK_FORCE_ROTATE`
4. `_scanMatrix` -> `WORK_GHOST` / `WORK_RECLAIM`, **walked over every position of every
   matrix of every pair of every tier**
5. `_scanParked` -> `WORK_PARKED_RESCUE` / `WORK_EVICT_PARKED`   <- here

So **parked work is only reached when the WHOLE SYSTEM has fewer than
`maxItemsPerUpkeep` ghost/reclaim items pending.** `WORK_RECLAIM` has no rate limit;
`WORK_GHOST` at least has `lastGhostTime[matrix]`.

**This was observed live and then worked around, not diagnosed.** `scripts/set_max_items.js`
exists for exactly this: *"Currently: 14 Reclaim + 1 Velocity = 15, filling the cap and
leaving zero slots for WORK_PARKED_RESCUE (type 4)."* The operator's fix was to **raise**
the cap. `contracts/test/MatrixKeeperPrev.sol` orders it the same way, so this predates
the V8.48 item-12a extraction — it is not something V8.50 introduced.

**Why this is worse than it looks.** Starving reclaim leaves a dead seat sitting; nothing
expires. Starving a parked member runs their **eviction clock** — at `evictionGracePeriod`
(7 days) a member the fund would have RESCUED is EVICTED instead. Delay does not defer
that work, it **changes the answer**. Two other queues share the problem in milder form:
`WORK_ADVANCE_EPOCH` is dead last and has a **calendar** deadline (the 25th), and
`WORK_DISTRIBUTE_CW` sits beside it.

**It blocks defect 5.** Lowering `maxItemsPerUpkeep` 15 -> 5 on gas grounds tightens the
starvation condition from "fewer than 15 pending" to "fewer than 5 pending". **The cap and
the order land together or neither lands.** The cap is therefore HELD AT 15 with the full
gas case recorded in place at `MatrixKeeper.sol:maxItemsPerUpkeep`.

## The fix, and the one thing it costs

Reorder discovery by **deadline**, not by history:

    velocity -> chain links -> PARKED -> CW distribute/epoch -> force-rotate
             -> velocity gate -> ghost/reclaim

Ghost and reclaim go LAST because they are the only work in the system with no deadline
attached. Nothing is dropped; the tail of a full batch is deferred to the next upkeep,
which for housekeeping is free.

**The cost is `V8_48_KeeperScan.test.js`.** It proves the refactored keeper and the frozen
`MatrixKeeperPrev` return **byte-identical** `performData`, and a reorder makes that false
by construction. Its own header anticipates pins for deliberate behaviour changes — but a
reorder cannot be pinned back to the old value, because the order is not a parameter.

**It does not have to be retired.** When the batch is NOT truncated both keepers emit the
same SET of work items, only in a different order, so the harness survives as
**set-identity** with no loss: all four of its recorded mutation kills (`idleSlotTimeout`
<-> `extendedIdleTimeout`, emptied chain links, hardcoded `maxItems`, wrong community
wallet) change WHICH items appear, never merely their order. Only the one truncation test
genuinely diverges, and that test should be re-premised to assert the NEW priority
deliberately.

**Sizes are not a constraint here** (`MatrixKeeper` 3,347 headroom, `MatrixKeeperLib`
15,436, `V8Governance` 11,828). The tight contracts — `MatrixPairFactory` 132 and
`MatrixLogicLib` 302 — are not touched by this.

## MEASURED 2026-08-17 — AND IT IS NOT FIRING TODAY

`diag_keeper_discovery.js` against live V8.48, block time 13:49:18Z:

    maxItemsPerUpkeep 15   pendingChainLinks 0   configuredTierCount 10
    T1: pairs=2 parked=105 pastGrace=0
         p0A occ=127/127 rot=460 parked=36
         p0B occ=127/127 rot=300 parked=69
    T2..T10: parked=0
    checkUpkeep -> upkeepNeeded true, items 1 / 15:  VELOCITY x1

**Correct the record: ZERO reclaim items exist right now.** The batch is 1 of 15. The
"14 Reclaim + 1 Velocity" signature quoted from `set_max_items.js` is V8.30-era history,
not the state of this chain — an earlier draft of this section leaned on it as if it were
current, and it is not. Defect 6 is a **latent ordering hazard**, not an active outage.
That lowers its urgency and it does NOT lower its correctness: `WORK_RECLAIM` is unbounded
and scanned ahead of parked work, so the hazard is one idle cohort away at any time, and
lowering the cap to 5 brings that cohort five times closer.

## THE THING THAT DOES NOT ADD UP: 105 parked, pastGrace 0

`parkedGracePeriod` is 24h. Every one of 105 parked members would have to have parked
within the last day. Possible on a T1 pair at rot=460/300 — but **it is also exactly what
a swallowed read prints**. `diag_keeper_discovery.js` wraps both per-member reads:

    const mem = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
    const ts  = Number(await mx.parkedAt(mem).catch(() => 0n));

A member whose read reverts is still counted by `getParkedCount` and contributes 0 to the
age census. **This deployment is already on record returning `ARRAY_RANGE_ERROR` from
`getParkedMember` during active rescues** (section 8). So `parked=105 / pastGrace=0` has
two readings and the output cannot tell them apart — the same trap as the UTF-16
`Tee-Object` captures.

`scripts/diag_parked_ages.js` (new, read-only) settles it: it catches nothing silently,
names every failed read, prints the age histogram and the ten oldest with the numbers that
decide their verdict, and its closing verdict refuses to call the queue healthy unless
`aged == getParkedCount`. It also flags `parkedAt == 0 while queued` separately, which is
a state defect rather than a read failure — `_checkParked` reads that same slot, so the
keeper could not age such a member either.

### IT RAN — 2026-08-17 14:39Z, AND THE QUEUE IS CLEAN

    T1 p0A  queued=37  aged=37  readFailed=0  parkedAtZero=0  median 0.30d  oldest 0.85d
    T1 p0B  queued=69  aged=69  readFailed=0  parkedAtZero=0  median 0.60d  oldest 0.87d
    <1h 4   1-6h 14   6-24h 88   1-3d 0   3-7d 0   7-14d 0   14-30d 0   >30d 0
    getParkedCount 106 | aged 106 | read failures 0 | parkedAt==0 queued 0
    0 of 106 past the 24h grace.

**`pastGrace=0` was REAL.** All 106 aged with zero swallowed reads, so the earlier figure
was the queue being young, not the census failing. **Defect 6 is confirmed LATENT** — a
hazard, not an outage — and the reorder is cheap insurance rather than a fire drill.

Two things worth keeping from the reading:

- **The population is homogeneous, and it is a bigfill artefact, not an organic one.**
  Every one of the ten oldest holds exactly `$8.40` against a `$10.00` fee
  (`w=$3.40 res=$5.00`), `withdrawnRatio=0`. 88 of 106 sit in the 6-24h bucket, i.e. they
  parked before the chain went organic. Do not quote "35% of the parked queue" as an
  organic statistic.
- **`selfFundedGracePeriod` is 0.1h (6 min) live, `parkedGracePeriod` 24h.** These members
  hold $8.40 against a $10.00 crossing, so they are $1.60 short and wait the full 24h.
  Under item A a MatA parker's price is $5.00, their $8.40 covers it, `sfShare` is 0 and
  they take the **6-minute** window instead — 37 of these 106 (the p0A queue), which is
  the same effect `_triageParked` already records as "35 of 35 on the live chain, 76 of
  139 parked members across all tiers". Item A does nothing for the 69 MatB parkers; a
  MatB re-entry is still a full fee.
- **The whole 6-24h bucket crosses the grace within hours of each other.** 88 members
  become discoverable at nearly the same instant, against `maxItemsPerUpkeep` 15. That is
  the contention defect 6 is about, arriving on a timer.

### DONE — the reorder shipped

`MatrixKeeperLib.discover` now drains **bounded** sources first (velocity, chain links,
CW distribute+epoch, force-rotate, velocity gate), then runs the two **unbounded** scans
by deadline: **parked, then ghost/reclaim**. The rule is stated in full at the top of the
reordered block. No new storage, no new parameter, no bytes — the same code in a
different order.

`V8_48_KeeperScan.test.js` moved from byte-identity to **set-identity** (`canon` /
`expectSameSet`), its PARAM-59 sweep now matches flips **by member instead of by slot**
(index matching would have reported every item as flipped and started passing on noise),
and its truncation case was re-premised: the two keepers must still truncate to the same
SIZE, but which work survives is asserted against the NEW priority, not against Prev. A
new case, `DEFECT 6: parked work outranks ghost/reclaim`, squeezes the cap to 1 and
states the property on its own so it cannot quietly stop being tested.

**Still open — defect 5 (the cap).** Held at 15. The 2.6M-gas-per-rescued-item figure it
rests on predates items A and E1, and the reading above says item A turns a third of this
queue into `sfShare == 0` rescues with no SF round trip at all. **Measure post-item-A
rescue gas in a fixture before setting the cap** — that is a local test, no chain needed,
and it replaces a pessimistic estimate with a real number.

## DEFECT 7 — THE KeeperScan PINS NEVER COLLAPSED ANYTHING (found session 5, FIXED)

Surfaced by the V8.50 run, but it has been wrong since V8.48. `deployBoth()` pinned the
refactored keeper's `selfFundedGracePeriod` and `evictionGracePeriod` to **0** so the
frozen `MatrixKeeperPrev` — which has neither concept — stayed comparable. But
`_checkParked` gates on

    age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
    age < (isGhost      ? parkedGracePeriod     : evictionGracePeriod)

and Prev gates BOTH on `parkedGracePeriod`, **which the pins left at its 6h default.**
Setting the new keeper's two windows to 0 does not collapse the split — it opens it as
wide as it goes: V8.50 discovers a self-funded rescue and fires an eviction IMMEDIATELY
where Prev waits six hours. The missing line was `setParkedGracePeriod(0)` on BOTH keepers.

**Why the setters force zero.** `setSelfFundedGracePeriod` enumerates 0/60/300/900/1800/
3600; `setEvictionGracePeriod` enumerates 0/1d/2d/3d/4d/5d/7d. **They intersect at 0 and
nowhere else.** "Set each equal to `parkedGracePeriod`" — the collapse the file header
describes and `EC-4` asserts — is only REACHABLE with all three at zero. Any other value
is unsettable, so any test that claims to pin them at a nonzero window is not pinning
anything.

**The grace-period walk was doing exactly that.** It set
`setSelfFundedGracePeriod(g === 0 ? 0 : (g >= 3600 ? 3600 : 300))` under a comment
claiming the windows were "pinned together" — a one-hour self-funded window against a
thirty-day loan window — and never restored the value, so every later test in the shared
world inherited an un-collapsed split. Real, and worth fixing on its own.

**⚠ CORRECTION, AND IT MATTERS MORE THAN THE FINDING.** The first write-up of this section
blamed that expression for six of the eight failures. **That attribution was wrong.** The
next run — with the pins corrected — failed six times again, and the output made the real
cause unmissable: **both keepers were returning exactly 15 items, the cap**, one filled
with `PARKED_RESCUE` and the other with `RECLAIM`.

    new: VELOCITY, FORCE_ROTATE, PARKED_RESCUE x12, RECLAIM      (15 = cap)
    old: VELOCITY, FORCE_ROTATE, RECLAIM x13                     (15 = cap)

**The batch was TRUNCATING in the shared world, and neither keeper was wrong.** Defect 6
reordered discovery precisely so that a full batch keeps parked work and sheds
housekeeping; Prev is frozen doing the opposite. Once the cap bites, no content comparison
against Prev can mean anything — the difference IS the fix.

Twice in a row a mechanism was reasoned out and asserted before it was measured, and both
times the measurement said something else. The lesson is the one this project already
knows: an explanation that fits the numbers is not the same as the explanation, and
"3 items vs 2, batch not full" should have prompted a check of what the cap actually was
rather than a theory about grace windows.

### The fix: a FOURTH pin — the batch must not truncate

`deployBoth()` now raises `maxItemsPerUpkeep` from the 15 default to the enumerated
ceiling of **40**, so the shared world discovers everything and the two keepers emit the
same SET in a different sequence — which is what `expectSameSet` is for. This file asks
one question, "did the 12a extraction preserve which member gets which verdict", and batch
sizing was never that question. The two sizing cases set the cap deliberately and restore
it to 40 rather than 15.

⚠ The pin holds only while the fixture stays under 40 discoverable items. Measured union
today is roughly 30 (2 bounded + ~14 parked + ~14 reclaim, `MATRIX_SIZE` 7 across two
matrices). **If both keepers ever report exactly 40, suspect this pin before anything
else.**

Rewritten honestly: full equivalence at `g == 0` where it is reachable, and elsewhere the
real safety property — every item Prev queues, V8.50 must queue with the SAME verdict (a
shorter window can only bring work forward, never withhold it), and any extra item must be
one of the two PARKED verdicts, never a ghost, reclaim or chain link.

**It passed for two versions because the fixture never reached the state.** That is the
blind spot the comment directly above those pins warns about, reintroduced by the pins
written to prevent it. Worth stating plainly: the harness was green on luck, not on proof.

### The other two failures were the reorder, working

The idle sweep and the mutation probe park a dozen members against a cap of 15. With
parked work now ahead of ghost/reclaim it fills the batch and squeezes the sweep out —
measured new = 12x `PARKED_RESCUE` + 1x `GHOST`, old = 13x `GHOST`, both exactly 15. Both
keepers still truncate identically; what breaks is that the GHOST/RECLAIM classification
those tests exist to check becomes unobservable, which would have turned a MUTATION PROBE
into a test passing because it sees nothing. Both now raise the cap to 40. Truncation
priority is covered separately and deliberately.

### Still unexplained, and recorded rather than guessed

Why defect 7 surfaced on THIS run and not on the earlier three-file run. The reorder does
not change what is discovered in an untruncated batch, so the working assumption is that
the shared fixture's parked population differs between running KeeperScan alone and
running the full suite. **Not proven.** The fix stands on its own merits either way.

### `setMaxItemsPerUpkeep` is enumerated — 5/10/15/20/30/40

There is no cap of 1. The first draft of the new `DEFECT 6` test asked for one and
reverted with `MK: invalid max items`. Five is the floor, and five slots are not all
contested (velocity, chain links, CW, force-rotate and the velocity gate drain first), so
the property is stated as an implication instead: **if any housekeeping item is in a
capped batch, every parked decision must already be in it.** That is what starvation
violates, and it survives the enumeration changing.

---

## DEFECT 5 — CLOSED. maxItemsPerUpkeep 15 -> 5, MEASURED (2026-08-17)

`test/V8_50_KeeperGas.test.js` (new) builds a real world — no mocks — and costs a whole
`performUpkeep`, because the failure mode is a transaction running out of gas and gas is
consumed by transactions, not by items in isolation.

### Per item, MATRIX_SIZE 7

| item | median | max |
|---|---|---|
| SF-funded rescue | 1.49M | **1.76M** |
| self-funded rescue (item A) | 0.92M | 0.92M |
| eviction | 0.09M | 0.10M |
| ghost / reclaim | 0.04M | 0.04M |

**An SF-funded rescue costs 1.62x a self-funded one.** That is item A's gas dividend,
measured. An eviction is 18x cheaper than a rescue; a reclaim 44x.

### ⚠ THE BATCH TABLE IS A TRAP AND IT CAUGHT ME FIRST

GAS-1 costs the batch this fixture happens to produce, and it FLATTENS above cap 10 —
4.52M, 4.67M, 4.71M, 4.90M — with every cap "fitting" the 17.8M ceiling, up to 40. The
mix column says why: **this world only ever offers four `PARKED_RESCUE` items**, and every
slot above that fills with `RECLAIM` at 0.04M. The first draft of the test printed
"the largest cap under 17.80M is 40" as its conclusion. That would have been the same
class of error the whole exercise existed to correct — quoting a number whose population
had changed underneath it.

### THE VERDICT: a SATURATED batch, which defect 6 made ordinary

Discovery now takes parked work FIRST, so a deep parked queue yields a batch of rescues
and nothing else. That is no longer the pathological composition, it is the normal one
whenever the queue is deep — and a 25-member fixture cannot build it, so GAS-4 projects
it from the worst rescue actually measured.

    cap   projected   vs 17.8M   verdict
      5       8.82M       49%    fits
     10      17.64M       99%    fits, no margin whatsoever
     15      26.47M      148%    EXCEEDS
     20      35.29M      198%    EXCEEDS

**And that is the generous end.** MATRIX_SIZE here is 7; live tiers run 127, where the
V8.49 chain measured ~2.6M for the same item. At live size: **5 -> ~13M (73%) fits,
10 -> ~26M (146%) EXCEEDS.** Ten survives in the small world and fails in the real one,
which is precisely why the value is 5 and not the 10 the local table would permit.

**Set to 5 — for about an hour.** Then defect 8 replaced the control entirely and the cap
went to **20**. Both moves are correct and the sequence is the point: 5 was the right
answer to the wrong question.

### DEFECT 8 — THE GAS FLOOR (built same session, owner directive: nothing deferred)

**⛔ CORRECTION FIRST, BECAUSE THE DEFECT 5 REASONING ABOVE CONTAINED A FALSE PREMISE.**
An earlier draft of this document and of the `maxItemsPerUpkeep` docstring both said an
out-of-gas batch "reverts WHOLE". **IT DOES NOT.**

Every work item is dispatched as `try this._doXExternal()` — an external self-call. Under
EIP-150 a sub-call receives 63/64 of the remaining gas, so when the batch runs dry the
sub-call burns its 63/64, reverts on out-of-gas, and **the catch fires**. The loop then
continues with 1/64 of nothing and every remaining item fails the same way.

**So exhaustion presents as a CASCADE of `WorkItemFailed` events** — indistinguishable
from a floor refusal, an SF exhaustion, or an already-rescued member. The transaction
succeeds. The keeper looks like it ran. This is worse than a revert and it is the exact
shape that cost a day of misdiagnosis on 2026-07-30.

**The fix.** `MatrixKeeper.minGasPerItem` (default `3_500_000`, DAO param 63, menu
2.5M / 3.5M / 5M / 7.5M) is checked with `gasleft()` **before** dispatching each item;
below it the loop emits `BatchGasHalted(processed, total, gasRemaining)` and **breaks**.

- A break, not a revert: reverting would discard the items that ALREADY SUCCEEDED in this
  transaction, which is the opposite of what a gas guard is for. The skipped tail stays in
  the queue and `checkUpkeep` rediscovers it next tick.
- The floor MUST exceed the worst single item or it lets the batch enter work it cannot
  finish and the cascade returns one item later. 3.5M clears the ~2.6M a live-size rescue
  measured, with ~35% margin. `GAS-6` asserts this against the measured worst item AND
  separately against the known live figure the small world cannot see.
- Measured working: `GAS-5` hands a 20-item batch 12M against a 7.5M floor and it halts at
  **9 of 20 with 6.46M remaining**, with the tail still discoverable afterwards.

### AND THAT IS WHY THE CAP WENT UP, NOT DOWN

A count is the wrong unit. An eviction costs 1/18th of a rescue, a reclaim 1/44th, so any
count sized for the worst mix throws away nearly all the throughput on the common one —
GAS-1 measured a 28-item batch at 4.90M, a quarter of the ceiling, where a cap of 5 would
have run six items and stopped. With the floor doing the safety work, `maxItemsPerUpkeep`
is **20**: a batch of evictions runs all 20 for ~2M, a batch of rescues still stops after
four or five, and nothing has to predict in advance which it is.

Not 40: `performData` is calldata on the way back in, and `_scanMatrix` walks every
position of every matrix before the cap binds. 20 is the largest DAO menu value that keeps
both modest.

**Sizes after defect 8:** MatrixKeeper 21,590 (+381, 2,986 spare), V8Governance 12,824
(+76, 11,752 spare). The tight pair is untouched — MatrixPairFactory 24,498 (78),
MatrixLogicLib 24,274 (302).

---

## SUITE GREEN — 602 passing / 7 pending / 0 failing (2026-08-17, after defect 8)

After `npx hardhat compile --force`. That is the first CONFIRMED green run of V8.50; the
earlier "595/0" in this document was a projection that was never executed, and it should
not have been written as a result.

The road there, because the failures were more instructive than the pass:

| run | failing | cause |
|---|---|---|
| 1 | 8 | 6 x un-collapsed split grace (defect 7) + 2 x idle-sweep truncation |
| 2 | 1 | the new DEFECT 6 test asked for `maxItemsPerUpkeep(1)`; the setter enumerates 5/10/15/20/30/40 |
| 3 | 6 | **the real cause** — the shared batch truncating at 15, misattributed in run 1 |
| 4 | 0 | fourth pin: `maxItemsPerUpkeep` 40 in `deployBoth()`, no truncation |

**Five tracked files are CRLF-only churn and must stay OUT of any commit** — verified with
`git diff --ignore-all-space --ignore-blank-lines`, which comes back empty for each:
`scripts/deployed_addresses_v8_30/31/40.json`, `contracts/test/CryptoNovaCommunityWallet.sol`,
`archive/windows_keeper/corescue.bat`. The address files matter especially: a 148-line
diff on a `deployed_addresses_*.json` looks exactly like a repoint, and here it is nothing
at all. Check them the same way before every commit rather than trusting the line count.

---

**Owner decision, still open:** whether parked work may take the WHOLE batch when the
queue is long, or whether housekeeping keeps a reserved slot or two. **The reorder as
shipped lets parked take the whole batch** — defensible because parked work drains (a
rescue or an eviction removes the item) while housekeeping has no deadline to miss, but
it is a policy choice and it is reversible with a reserved-slots param if the owner wants
one.

---

# 6f. ⛔ THE SECOND ORGANIC READING — THE LOOP IS REAL AND THE FUND IS UNDERWATER

`node scripts/diag_parked_growth.js`, 2026-08-18, blocks 45,060,000..45,645,471
(2026-08-05 -> 2026-08-18, ~13.6 days). Read-only. This is the second organic reading the
handoff has been asking for since 2026-08-16, and it is the most consequential measurement
of the V8.50 work.

## 1. THE LOOP SIGNATURE — MEASURED, NOT INFERRED

    758 park events across 339 unique members
    1x: 59      2x: 167      3-5x: 113      6-10x: 0      11+: 0
    REPEAT SHARE: 48.2% of all park events come from members who parked 3+ times

**ONLY 59 OF 339 MEMBERS PARKED ONCE AND STAYED OUT. 82.6% CAME BACK.**

That is the rescue -> SF debt -> re-seat -> cycle out underfunded -> park again cycle,
observed directly. The script's own criterion for the self-sustaining loop is "a high
repeat share + climbing SF outstanding", and both are met decisively. (Its third
criterion, an ACCELERATING park rate, it classifies as ROUGHLY LINEAR — first-half
103.0/day against a last-3-day 149.7/day. Rising 45%, but the script's own threshold says
linear, and its word is kept here rather than argued with.)

## 2. THE FINANCING — THE FUND HAS LENT 2.4x WHAT IT HOLDS

    CONTRACT counters (ground truth)   loaned $961.65   repaid $443.41   OUTSTANDING $518.24
    SF totalBalance, same night                                          $212.35

    net-outstanding-delta by day:  08-13 +$0.33   08-14 +$34.58   08-15 +$96.66
                                   08-16 -$44.04  08-17 +$258.17  08-18 +$167.35

**Outstanding debt is 2.4x the remaining balance, and the last two days added $425.52 of
net new debt.** Independently corroborated: `model_item_a.js` PHASE 1 read SF totalBalance
four times across ~9.7 hours tonight — $262.79 -> $259.49 -> $243.19 -> $212.35, monotonic,
about -$5.20/hour or ~-$125/day. Two different instruments reading different events agree
on the direction and roughly on the rate.

⚠ TESTNET, BIGFILL STOPPED. Do not extrapolate a runway figure to mainnet demand. The
DIRECTION is the finding, not the date it reaches zero.

## 3. WHAT THIS DOES TO V8.50's FRAMING

**Item A stops being a throughput improvement and becomes the fix.** Every sample tonight
put the MatA crossing at **62-65% of ALL funding parks, ~$724 of lending**, and PHASE 2
confirmed 67-75 of 67-75 MatA parkers are freed OUTRIGHT — the reserve covers the halved
crossing price with no fund involvement at all. E1 handles the other half by carrying the
member's balance so the MatB re-entry is affordable. Together they attack both legs of the
loop the section above measures.

The live crossing buffer reads **3600 bps** and V8.50 ships `crossingBufferBps` at **0**.
Every rescue today seeds 36% of the fee into the member's withdrawable as FUND money. That
was recorded as a tuning decision; against a fund that has lent 2.4x its balance it is
better read as part of the same repair.

## 4. ⛔ TWO THINGS IN THIS OUTPUT THAT DO NOT ADD UP — OPEN, NOT EXPLAINED

**(a) The script contradicts itself, and the shape of the gap matters.** It prints
`VERDICT INPUTS (no holes — complete)` and, four lines earlier,
`EVENTS DO NOT RECONCILE`:

    events   loaned $956.46   repaid $443.41
    counters loaned $961.65   repaid $443.41      gap: $5.19 on the LOANED side only

The script blames dropped ranges. **A dropped range would skew BOTH sides.** Repaid matches
to the cent while loaned is $5.19 short, which points instead at **a lending path that does
not emit `MemberDebtIncreased`**. If that is right, every debt total derived from events —
anywhere, in any tool — is a floor rather than a total, and the contract counters are the
only trustworthy source. **Find the silent path before quoting any event-derived debt
figure again.** Start by diffing every writer of `memberDebt` against every emitter of
`MemberDebtIncreased`.

**(b) Cumulative-net 212 against a live queue of 105, with ZERO evictions recorded.**
About half the net growth is unaccounted for. Possible explanations not yet checked: park
events counted per-event while the queue is per-member; members leaving via a path the
script does not count; or the daily net arithmetic double-counting. **No explanation is
offered here because none has been verified.**

Neither of these changes the two headline findings — the repeat share comes from park
events alone, and the financing verdict rests on the CONTRACT COUNTERS, not the events.
But both need closing before this document's numbers are quoted as exact.

---

# 6e. THREE SAMPLES IN ONE NIGHT — THE VERDICTS HOLD, THE FIGURES DO NOT

`model_item_a.js` was run three times on 2026-08-18 as phases were added. The chain was
live throughout, so each run is an INDEPENDENT SAMPLE of a moving population. That was not
the intent, and it turned out to be the most useful thing about it.

## ⛔ THE UNDERLYING FIGURES ARE VOLATILE. DO NOT QUOTE A POINT VALUE AS "THE" NUMBER.

`WHAT ONE COMPLETED JOURNEY EARNS`, the same quantity, measured three ways:

| when | n | min | median | max |
|---|---|---|---|---|
| 2026-08-16 | 63 | $3.40 | **$4.83** | $6.34 |
| 2026-08-18 block 45630741 | 33 | $3.40 | **$3.40** | $10.90 |
| 2026-08-18 block 45642648 | 38 | $3.40 | **$6.55** | $10.15 |

**The median nearly doubled in under seven hours** (~12,000 blocks). Other figures moved
with it — the re-entry ask went from a $2.85 median to $0.00, and the top ladder band from
8 members to 20. **Item C's case for raising the floor rested on the $4.83 median.** That
number is not reproducible; it is one draw from a distribution that also produces $3.40
and $6.55. Any future argument built on a single run's median is built on sand.

The MINIMUM is the stable figure: **$3.40 in all three samples**, exactly the structural
no-referral floor (250 direct + 1800 pool + 1350 chain). That is the number to reason with.

## ✅ AND THE VERDICTS SURVIVED ALL THREE, WHICH IS WHY THEY CAN BE TRUSTED

Every conclusion recorded tonight was reached on one sample and then, by accident, re-run
on two more:

| verdict | run 1 | run 2 | run 3 |
|---|---|---|---|
| PARAM 59 at 3400 refuses | 1 of 40 | 1 of 33 | 1 of 38 |
| PARAM 59 at 5000 refuses | 1 (same) | 1 (same) | 1 (same) |
| members below the 4000 rung | 0 | 0 | 0 |
| presets 2/3 rescue additionally | 0 | 0 | 0 |
| can afford T2 at cycle-out, item A | 0 of 39 | 0 of 33 | 0 of 38 |
| shallow seats | — | 0 of 1534 | 0 of 1412 |
| SlotReclaimed | — | 0 | 0 |

**Nothing moved.** The decisions are robust to a population that churned substantially
underneath them, which is a much stronger claim than any of them had when it was made.

## THE 5 -> 6 CO-MOVEMENT: the MemberEntered identification just got firmer

PHASE 9's position-0 count and PHASE 4's "deferral parks (shortfall 0)" were both **5** in
run 2 and both **6** in run 3. Two independently computed counts moving together across
samples is far better evidence that they are the same events than a single coincidence
was — the earlier note calling the cross-check "suggestive rather than conclusive" was
right to hedge, and the hedge has now been partly discharged. Still not proof: both park
paths emit `MemberParked(member, 0)` and only `:534` also emits `MemberEntered`.

## WHAT THIS MEANS FOR THE NEXT SESSION

**Run the model more than once before deciding anything.** A single run is a sample, not a
measurement, and this chain moves fast enough that the difference matters. Where a verdict
is a COUNT AT A THRESHOLD it appears stable; where it is a MEDIAN it is not.

---

# 6d. THE TWO OWNER DECISIONS — BOTH SETTLED 2026-08-18, BOTH "NO CHANGE"

Settled against `scripts/model_item_a.js` PHASE 7 (added for this), read on the live
V8.48 chain, 40 MatB parkers, post-E1 basis.

## PARAM 59 `insolvencyFloorBps` — STAYS AT 3400

    1700 -> refuses 35 of 40      3400 -> refuses  1   <- live default
    2500 -> refuses 32            5000 -> refuses  1   <- the proposal. SAME MEMBER.
                                  6800 -> refuses  0

**Raising 3400 -> 5000 refuses the identical member.** The change that opened this item
buys nothing measurable. Only 6800 moves the outcome, and that one member is one of the
two carrying existing debt — the exact case the floor exists to refuse. Nearly doubling
the ceiling to reach them inverts the mechanism.

**⚠ PHASE 5 AND PHASE 7 DISAGREE HERE AND PHASE 7 IS THE ONE TO QUOTE.** Phase 5's sweep
reports 3400 clearing 40 of 40; phase 7 reports one refusal. Different models: phase 5
compares the raw ask to the ceiling, phase 7 does what policy B does — trims the advance
to `min(sfShare, shortfall)` and adds EXISTING debt. Phase 5 is the optimistic bound.

## SF rescue ladder bottom rung — STAYS AT PRESET 1 (4000)

    10000+  6 | 8000-8500  3 | 7000-7500 24 | 6500-7000  7 | BELOW 4000  0

Nobody is off the bottom. Preset 2 would additionally rescue 0; preset 3, also 0.

**The ~3400 worry was a PRE-E1 artefact.** It only exists on the ledger basis, where
item A strands journey-A earnings in a MatA ledger the re-entry gate cannot read. E1
carries them across, so the whole population sits at 6500 bps and up. **E1 did not just
close the conservation hole — it removed the reason to touch the ladder.**

## What this run also established, independent of the decisions

- **Item A's premise holds on chain, exactly: 67 of 67 MatA parkers freed outright.**
  $103.35 of real shortfall becomes $0.00.
- **Item A removes 64.7% of all funding parks** — 458 of 708 — and $727.03 of lending.
- **Phase 3 reconciles on all 171 self-funded crossings**, with the 50/50
  reserve/withdrawable split falling out structurally rather than by coincidence.
- **The live crossing buffer is 3600 bps; V8.50 ships `crossingBufferBps` at 0.** Already
  a recorded decision with the knob documented at the declaration, but it means rescued
  members stop being seeded 36% of the fee as SF money. Watch it wherever V8.50 first runs.
- **MatB parkers carrying debt: 2 of 40**, and `_crossToPartner` claws back HARDER under
  item A, not softer — the member arrives holding more.

## ⚠ BOTH DECISIONS REST ON A PROJECTION, NOT A RUNNING SYSTEM

E1 is not deployed. The live chain is V8.48, so PHASE 7 projects V8.50 onto today's
members. Neither decision should be treated as settled for a running system until V8.50
runs somewhere and the model is re-read there. Both were "no change", so nothing is at
risk from the projection being wrong — but a FUTURE change to either must not cite this
table as if it were a measurement of V8.50 in operation.

## Also open, and it bit this session

`model_item_a.js` treats an RPC **503** as "constant unreadable" and aborts. Refusing to
assume `CROSSING_RESERVE_BPS` is correct — guessing it would corrupt every number
downstream — but a busy endpoint and a missing selector are different failures sharing
one code path. It needs a retry wrapper that distinguishes transport errors (503, 429,
timeouts, resets) from genuine call failures, and only declares a value unreadable after
several attempts. Same discipline as `diag_parked_ages.js`. **Do not "fix" it by changing
the endpoint** — public endpoints were tried in this site's read pool and removed.

---

# 7. HOW WE WORK

Claude drives, decides direction, and makes the file edits directly. **The owner runs
every command** — tests, git, chain reads, VPS — and reports back. Give copy-paste blocks
that name the folder they run in, **one step at a time, and wait for "done"**. Explain in
plain language; the owner is not deep on the technical side and leans on Claude as a
mentor. **Do not ask which item to take next — decide.**

Contracts push to **`v8.1`**. `admin → preview → main` is the FRONTEND repo only.

**Write docs and handoffs for a future session of Claude plus the owner. Nobody else
touches this code, so anything unexplained is an incomplete handoff from a past session:
verify it and close it rather than working around it.**

---

# 8. OPEN, HONESTLY STATED

- **T6 was never answered — the V8.49 run had NO VALID CONTROL.** Self-rescue only happens
  WHILE that cohort's bigfill process is alive; cohort A's exited after registration, so it
  took 58 loans at `-SelfRescueRate 1.0` and behaved as a second subject. Run 2 must keep
  the control's bigfill alive AND confirm its members reached crossings before reading its
  loan count.
- **`SELF_RESCUE_RATE = 0` is a pathological extreme, not a population.** Real members can
  top up and pay. **Self-rescue does not remove the ~32%-per-cycle gap — it moves who
  absorbs it, into a recurring ~$3.20-per-cycle out-of-pocket cost at T1.** That is the
  number V8.50 should be judged on, and the honest one for member comms.
- **No end-to-end test that a real rescue books `shortfall` and nothing more.** The
  aggregate is consistent with it and the buffer is 0 by construction, but there is still
  no per-member assertion. Closing it means a `forceCrossKeeper` mock that RECORDS its
  `(sfContribution, crossingBuffer)` arguments.
- **`ARRAY_RANGE_ERROR` on `getParkedMember`** recurred as **five consecutive TAIL indices**
  during active rescues — not "always the last index" as recorded twice before. That fits
  the RACE explanation and does NOT fit a `getParkedCount` off-by-one, which would
  misreport by exactly one every time. The benign branch now has real support.
- **Item 2 (the wallet RPC, `sepolia.base.org`)** — still open, deferred to mainnet by
  owner decision. **Do NOT propose free public endpoints**; they were tried in this site's
  read pool, were buggy, and were removed. That is owner-observed operational history.
- ~~**The live V8.48 chain has been organic since 03:30:44 -04:00 and has never been
  measured that way.** Take a reading before anything restarts bigfill.~~ **DONE
  2026-08-18 — see section 6f.** The reading found the self-sustaining loop (82.6% of
  parked members park more than once) and a fund that has lent 2.4x what it holds
  ($518.24 outstanding against a $212.35 balance). It also opened two unexplained
  discrepancies, both listed in 6f: a $5.19 loaned-side gap that looks like a lending path
  emitting no event, and cumulative-net 212 against a live queue of 105.
- **A LENDING PATH MAY NOT EMIT `MemberDebtIncreased`.** Contract counters and event sums
  agree to the cent on REPAID and differ by $5.19 on LOANED. A dropped log range would
  skew both. Until this is found, treat every event-derived debt total anywhere in this
  project as a FLOOR, and read debt from the contract counters. Diff every writer of
  `memberDebt` against every emitter of `MemberDebtIncreased`.
- **The SF is draining and two instruments agree.** `diag_parked_growth.js` daily deltas
  and four `model_item_a.js` PHASE 1 balance reads both say the fund is losing ground —
  roughly $125/day, monotonic across ~9.7 hours. Testnet with bigfill stopped, so the
  DIRECTION is the finding and not any runway date.
