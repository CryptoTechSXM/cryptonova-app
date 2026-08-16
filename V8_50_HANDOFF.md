# V8.50 HANDOFF — the crossing redesign. READ THIS FIRST.

Written 2026-08-16 at the end of the V8.49 private measurement run.
Audience: a future session of Claude, plus the owner. Nobody else touches this code.

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

Files changed by session 3, all uncommitted at time of writing: `contracts/MatrixKeeperLib.sol`,
`contracts/MatrixKeeper.sol`, `contracts/TierRouter.sol` (comments only), this file. New
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
- **The live V8.48 chain has been organic since 03:30:44 -04:00 and has never been measured
  that way.** Take a reading before anything restarts bigfill.
