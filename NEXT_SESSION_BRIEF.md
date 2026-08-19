# NEXT SESSION BRIEF — V8.50, "the crossing redesign", branch `v8.1`

Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`. Written at the end of session 8,
2026-08-19. Paste this in as the opening message of the next session.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. section 7a — THE TWO RULES. Short, owner-set, non-negotiable.
2. SESSION 8 STATE at the top — the newest, and it CORRECTS session 7 in two places.
3. SESSION 7 STATE below it — the corrected A/B and the velocity fix. Still stands.
4. SESSION 6 STATE below that — its park/loop table is WITHDRAWN; its FUND table holds.

## THE TWO RULES — these govern everything

1. Do not hypothesise unless necessary.
2. Measure and test before implementing. Never build on a hypothesis.

Practical form: when two numbers disagree, the disagreement IS the finding — measure it,
do not explain it. A number you have not run is not a result. One sample is not a
measurement.

**SESSION 8 EXTENDS RULE 2, AND THIS IS THE NEW PART: ARITHMETIC OVER MEASURED NUMBERS IS
NOT A MEASUREMENT.** Three wrong answers that session, all from correct inputs:
- "Session 6's starvation guess does not survive" — tested queue position INSIDE batches
  that were reached. That cannot see a batch that was never reached. Measured properly,
  session 6 was RIGHT: the control starves parked work on 25-26% of ticks.
- "The floor refuses the second loan, here is the headroom arithmetic" — the PARAM 59 =
  10000 row came back BYTE-IDENTICAL to 6800. Nothing was refused.
- "Then the second loan is never requested" — the rescue counter found 7-11 members per
  run ARE rescued twice. The second rescue is simply SELF-FUNDED.
Each read like a result. Each was a derivation dressed as a mechanism.

## WHAT IS DONE — do not re-derive any of this

- Item E1 + defects 2,4,5,6,7,8,9, ladder preset 1, tier gates, item D, frontend ABI
  audit — settled earlier, unchanged. `minGasPerItem` 5M (owner decision, measured).
- GATE MEASUREMENTS 1 AND 2 — ANSWERED, no chain needed. Cold SF-funded rescue at live
  `MATRIX_SIZE` 127 costs 4.37M (4.37M cold / 2.83M mid / 1.43M warm); ~23k per matrix
  position. Guard fires, halts cleanly, defers not drops.
- THE 68 VELOCITY `WorkItemFailed` ARE EXPLAINED, FIXED AND GONE (68 -> 0).
  `MatrixKeeper._setStabilityLayers` called `activateLayer`, declared in the interface and
  implemented NOWHERE, ever. Deleted. **LIVE V8.48 STILL HAS IT.**
- THE A/B PARK COUNTS WERE CORRECTED IN SESSION 7 — queue insertions 142/140/142 (control)
  vs 82/82/80 (V8.50), ~42% fewer; distinct parkers 130/129/132 vs 71/67/64. The FUND
  claims hold: loans per rescue 0.99 -> 0.52, loan volume down ~60%, SF 4-6x healthier.
- **SESSION 8: THE ~10x EVICTIONS ARE EXPLAINED AND REPLICATED 3/3. THEY ARE NOT A DEFECT.**
- **SESSION 8: session 7's open item 2 (withdrawable-at-rescue variance) is CLOSED.**
- Suite: 611 passing / 7 pending / 0 failing. Latest commit `51c57fd` on `v8.1`.

METHOD FINDING WORTH REUSING: `MATRIX_SIZE` is a CONSTRUCTOR ARGUMENT, not a constant.
Live-size behaviour is measurable in-process in seconds, no deploy, no chain:
`$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js`.

## OWNER FRAMING, 2026-08-19 — IT DECIDES WHAT COUNTS AS A DEFECT

Two sessions spent effort on the wrong bar before this was stated. Do not lose it:
- **Members are NOT meant to cross forever.** The bar is that they can get **one or two
  loans** — not that everyone crosses indefinitely.
- **Nobody can get stuck at the A->B crossing. Everyone crosses on the reserve.**
  (Measured and confirmed: MatA parkers were evictable in **0 of 258 observations**.)
- **Members are EXPECTED to take loans and to be evicted if they never invite anyone.**
So "V8.50 evicts 10x more" is not by itself a defect. The only question is whether the
eviction is the DESIGNED one.

## THE EVICTION ANSWER — THREE FACTORS, ALL REPLICATED 3/3

Instrument: `AB_EVICT=1` on `test_ab/replay.js`. It decodes `performData` (the exact
routing, zero chain calls) and re-walks `_triageParked`'s four branches off-chain, asking
the DEPLOYED `MatrixKeeperLib.rescueBpsFor` rather than re-implementing the ladder. It
scores BOTH price bases against the contract's own routing every run, so item A's
repricing is read, not assumed. **`mismatchCount` must be 0 or the reason column is void —
it has been 0 on every run so far.**

1. **WHERE MEMBERS PARK (largest, ~4.5x).** Control queue is .23/.20/.19 MatB; V8.50 is
   **.95/.96/.97**. A parked MatA member was never evictable in either build.
2. **DISCOVERY REACH — defect 6, ~1.35x.** Control produced ZERO parked work items on
   **25-26% of ticks that had a non-empty parked queue** (batch full of VELOCITY + GHOST +
   RECLAIM, ~390 member-ticks unscanned). V8.50: 0%, all seeds.
3. **THE RESERVE, ~1.35x.** Both arms fail the floor below **$6.60** of effective
   contribution — the SAME boundary the phase-6 section measured on live V8.48 (n=70,
   min=median=max=$6.60), reproduced in a fresh local fixture. Control MatB parkers get
   $5.00 of it free from the carve (`reserveZeroShare` 0.00); every V8.50 MatB parker
   holds ZERO (1.00, 221 observations).

The three multiply to ~8x against an observed ~10x. **THAT MULTIPLICATION IS ARITHMETIC,
NOT A MEASUREMENT** — independence was never tested. Do not quote "8x" as a result.

## LOANS: ONE PER MEMBER, AND THE SECOND RESCUE IS FREE

159 loans across six runs, 159 distinct members, `max 1` at EVERY ceiling value. But
7/11/10 members per run ARE rescued twice. The cycle: **MatB re-entry costs one loan;
the A->B crossing is covered by the reserve and costs the fund nothing.** Rescued-from-MatA
(20/27/23) equals fund-free rescues (20/27/22) — item A's headline claim, within-arm.
Cross-checked against the fund's own `MemberDebtIncreased`; they agree on count AND
borrower set every run.

## ⛔ TWO OWNER DECISIONS ARE OPEN — ASK, DO NOT DECIDE THESE

**1. PARAM 59 (`insolvencyFloorBps`). Curve measured, 5 values x 3 seeds, V8.50 arm:**

| PARAM 59 | evicted having NEVER been lent to | FLOOR evictions | SF end $ |
|---|---|---|---|
| 3400 (current) | **9 / 9 / 9** | 7/6/5 | 96.54 / 97.82 / 88.80 |
| 4000 | 3 / 3 / 6 | 1/0/2 | 80.04 / 91.83 / 81.17 |
| 4500 | 3 / 3 / 3 | **0/0/0** | 80.55 / 91.83 / 77.25 |
| 5000 | 3 / 3 / 3 | 0/0/0 | identical to 4500 |
| 6800 | 3 / 3 / 3 | 0/0/0 | identical to 4500 |
| 10000 | 3 / 3 / 3 | 0/0/0 | identical to 4500 |

The curve SATURATES at 4500 — the `raw` block at 4500/5000/6800/10000 is byte-identical on
all three seeds. **But observed asks run $3.42-$4.52, so a $4.50 ceiling is TWO CENTS short
of the worst case** and only the population census sees it. **Recommendation: 5000** — same
measured outcome, $0.48 of margin instead of a rounding error. Costs ~$11-16 of ending fund
balance, still 4-6x the control; `loansPerRescue` unchanged at ~0.5, so item A is untouched.
⚠ This REVERSES phase-6's "DO NOT DEPLOY 5000" — correctly, because that was measured
BEFORE E1, when the ask was $6.60. Do not read phase-6 as binding without carrying E1.

**2. LIVE V8.48 — leave organic, bigfill, or fund the SF?** Session 8's reasoning, offered
but NOT acted on: leave it organic. Bigfill does not replenish — SF income is `stabilityBps`
238 = $0.238 per $10 registration against a rescue costing $3.42-$4.52, and V8.48 has no
item A so `loansPerRescue` is 0.98-1.00. It would also collide with the V8.50 private
deploy on Base Sepolia (the nonce collision that stopped the V8.49 bigfill). Funding the SF
directly erases the drain series, which is the only clean before-picture of the thing item A
fixes. **⚠ THE FIGURES THIS RESTS ON ARE DAYS OLD** ($212.35 balance, $518.24 outstanding,
~$125/day) **and item 2 below says they are in tension. RE-MEASURE FIRST.** Also confirm
238 bps against the LIVE deployment — it was read from the harness config.

## WHAT IS NEXT

1. The two owner decisions above.
2. **Re-run `diag_parked_growth.js` with `WINDOW=3000`.** Its last run reported 9 failed
   ranges ("numbers are FLOORS") while its SF section reconciled EXACTLY against the
   contract counters. Those two statements are in tension. Prerequisite for decision 2.
3. **Router placement refusals, 11 -> 53** on V8.50. Still unexplained. They rose further
   under the floor sweep (57 -> 59 at 6800), which hints they track rescue throughput
   rather than being independent — a clue, not a finding.
4. **Model self-rescue at a non-zero rate.** Now blocking more than before: the eviction
   answer, the PARAM 59 curve and the loans-per-member result ALL carry
   `SELF_RESCUE_RATE = 0` as their headline caveat.
5. **Gate measurements 3 and 4** — MatA parkers freed outright, E1 base coincidence. These
   genuinely need a running system; that is what the private chain is FOR.
6. **`maxItemsPerUpkeep` is vestigial** at 20. The floor halts the batch before the cap
   binds at 127. Confirm deliberately or lower it to 10.

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these

- **ARITHMETIC OVER MEASURED NUMBERS IS NOT A MEASUREMENT.** See the two rules above.
- **TESTING THE WRONG SLICE LOOKS LIKE A REFUTATION.** Before writing "X does not survive",
  check the instrument can observe X's ABSENCE.
- **A POOLED MEDIAN OVER A BIMODAL POPULATION DESCRIBES NOBODY.** V8.50's rescued members
  are two non-overlapping clusters ($0.25 MatA, ~$7.5 MatB). At a ~50/50 mix the median
  flips between humps and reads as 3.5x "variance". That WAS session 7's open item 2.
- **THE BATCH IS NOT THE POPULATION.** Discovery reaches queue indices 0-2 of a 31-deep
  queue. The control's entire MatB cohort was never routed at all.
- **A RE-RUN SHARING AN OUTPUT FILENAME DESTROYS THE EARLIER RESULT.** Every dial that
  changes the answer is now in the filename (`_nopop`, `_floor<n>`).
- **A DIAL SET IS NOT A DIAL IN FORCE.** Read it BACK. `insolvencyFloorBps` and the cap both
  are, on every run.
- Two contracts can declare the same event NAME with different signatures and nothing warns
  you. Bucket by name PLUS arity, or by topic0. Per-member accessors keep working silently.
- **Count the state change, not the announcement of it.** `grep "push"` on the parked array
  found the seventh insertion path in one command.
- Two contaminated numbers that happen to agree read as a robust null result.
- A declared-but-unimplemented interface function is not a compile error. `activateLayer`
  survived from V8.1 to 2026-08.
- `git commit -m` from PowerShell destroys dollar figures and mangles -> and unicode. Write
  the message to a file and use `git commit -F`. (Remote tools cannot write into `.git/` —
  put the draft in the repo root and delete it after.)
- **NEVER run `git add -A` or `git commit -a` from the device/Linux side.** core.autocrlf is
  unset there, so 31 files show as modified on line endings alone. Stage explicit paths.
- Select-String with a non-ASCII pattern silently matches NOTHING. Keep patterns ASCII and
  make sure the full result lands in a FILE anyway.
- **Library events are NOT in a contract's ABI.** `RescueLoanIssued`/`SelfRescue`/
  `CoPayRescue` come from `MatrixLogicLib`; `BalanceCarried` too. A zero that flatters the
  hypothesis deserves more suspicion than one that does not.
- Parsing one log with several interfaces double-counts every event more than one ABI
  declares. Silent: ratios survive, raw totals are wrong.
- Record contract state by READING IT BACK. A flag recording intent is not evidence.
- A VOID pair is not a seed.
- The hardhat provider caps ONE transaction at 2^24 = 16,777,216 gas — BELOW the 17.8M
  ceiling. An over-cap tx reports NO gas, which reads as "the item did not complete".
- A cost curve mixing item KINDS describes no item that exists. Watch the step column.
- A sweep whose later rows test a more depleted world is a false-negative machine.
  `snap.restore()` undoes deployments — rebuild per row.
- `PairManagerV8.rescueReentry` returns a rescued member to their OWN pair
  (`destPair = fromPairIndex`). Correct and deliberate (V8.48 item 10) — do not "fix" it.
- Chain pay walks matrix POSITION, not the referral graph (`MatrixLogicLib:1317`).
- Run `model_item_a.js` MORE THAN ONCE before deciding anything.
- Every gas number not taken with `GAS_MATRIX_SIZE=127` is size 7. The repo's old ~2.6M
  "live" figure was a BATCH AVERAGE, not an item cost.
- TierRouter's "escrow-zero defect" DOES NOT EXIST.
- A notional-carve credit was built and reverted — read the write-up at the top of
  `MatrixKeeperLib._triageParked` before having the idea again.
- `V8_48_KeeperScan.test.js` pins are load-bearing.
- `diag_parked_growth.js` no longer defaults to a dead addresses file — it REFUSES. If you
  see that refusal, set `ADDRESSES_FILE`; do not re-add a default.

## GUARDRAILS — unchanged

Nothing is deployed. No chain has been written to. V8.49 is deployed privately and measured
— do not repoint anything at it. Live V8.48 is the community chain and `.env` line 69 must
stay `deployed_addresses_v8_48.json`. Before any test run whose numbers you intend to trust,
use `npx hardhat compile --force` (and `--config hardhat.v849b.config.js` for the control).
Live keeper scripts still carry `GAS_PER_ITEM_DEFAULT = 3_500_000` (`direct_keeper.js:27`,
`direct_keeper_vps.js:26`) — left alone deliberately; they drive live V8.48, which has
neither item A nor E1. Revisit with the V8.50 deploy.
Add at V8.50 deploy time: **LIVE V8.48 STILL CARRIES THE `activateLayer` BUG**, so its
velocity gate freezes during any quiet window. Fixed only in the V8.50 tree.
On the deploy question, asked and answered 2026-08-18: **PRIVATE FIRST, not the community.**
Do NOT run two chains on Base Sepolia simultaneously — the V8.49 run had to STOP the live
bigfill because two chains on one network collide on wallet nonces.

## THE A/B HARNESS — HOW TO DRIVE IT

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:AB_SEQ="ab_sequence_s1.json"; $env:AB_CAP="5"
npx hardhat run test_ab/replay.js --config hardhat.v849b.config.js   # control (v849b)
npx hardhat run test_ab/replay.js                                    # subject (V8.50)
```
Optional dials: `AB_EVICT=1` (routing + eviction reasons + loans/rescues per member),
`AB_QUEUE_EVERY=<n>` (full-queue population census every nth tick, default 5, 0 = off),
`AB_FLOOR_BPS=<n>` (PARAM 59 sweep), `AB_CENSUS=1`, `AB_EQUALIZE=1`. Every dial that changes
the answer appears in the output filename. **Read `mismatchCount` before anything else.**

## HOW WE WORK

You drive, decide direction, and make the file edits directly. I run every command and paste
back the output. Copy-paste blocks that name the folder, one step at a time, then wait.
Explain in plain language; I am not deep on the technical side. Do not ask which item to
take next — decide, tell me, and we continue. Ask only when the answer is genuinely mine:
a policy or economic trade-off, not something you can determine from the code or the chain.
Dial back on long chains of runs — prefer fewer, smaller steps over back-to-back batches.
Contracts push to `v8.1`. There is no third party: every line of this codebase was written
by a previous session of you and executed by me. Write handoffs to yourself accordingly.
