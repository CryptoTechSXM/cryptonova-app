# NEXT SESSION BRIEF — V8.50, "the crossing redesign", branch `v8.1`

Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`. Written at the end of session 7,
2026-08-18. Paste this in as the opening message of the next session.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. section 7a — THE TWO RULES. Short, owner-set, non-negotiable.
2. SESSION 7 STATE at the top — what is built, closed, measured, and WITHDRAWN.
3. SESSION 6 STATE below it — still the record of the A/B, but **its park/loop table is
   withdrawn**; the fund table in it still holds.

## THE TWO RULES — these govern everything

1. Do not hypothesise unless necessary.
2. Measure and test before implementing. Never build on a hypothesis.

Practical form: when two numbers disagree, the disagreement IS the finding — measure it,
do not explain it. A number you have not run is not a result. One sample is not a
measurement.

Session 7's evidence for this is worth three lines, because all three nearly went the
other way. A queue census contradicted an event tally by 2x and the CENSUS was right. The
tidy explanation this session STARTED with — that ~57 members were leaving via silent exit
paths — measured **zero on both arms**; the gap was in the park count itself. And
"V8.50 rescues members with twice the support" was true on seed 1 ($7.43 vs $3.73) and
died on seeds 2 and 3 ($4.45, $2.15).

## WHAT IS DONE — do not re-derive any of this

- Item E1 + defects 2,4,5,6,7,8,9, PARAM 59 at 3400, ladder preset 1, tier gates, item D,
  frontend ABI audit — settled earlier, unchanged.
- GATE MEASUREMENTS 1 AND 2 — ANSWERED, no chain needed. Cold SF-funded rescue at live
  MATRIX_SIZE 127 costs 4.37M; three prices by batch position (4.37M cold / 2.83M mid /
  1.43M warm); ~23k per matrix position. Guard fires, halts cleanly, defers not drops.
- `minGasPerItem` 3.5M -> 5M on that measurement (owner decision). Costs ~1 item/batch.
- **THE 68 VELOCITY `WorkItemFailed` ARE EXPLAINED, FIXED AND GONE (68 -> 0).**
  `MatrixKeeper._setStabilityLayers` called `activateLayer` on the StabilityFund; that
  function was declared in the interface and implemented NOWHERE, in any version, ever.
  Deleted. It had been silently killing `tierVelocityGreen` updates during quiet windows
  on every deployment since V8.1 — **live V8.48 still has it.**
- **THE A/B PARK COUNTS WERE WRONG AND ARE NOW CORRECTED.** See below. This is the
  important one.
- Both pre-session-6 loose ends closed: `diag_parked_growth.js` committed (and it now
  refuses to run without `ADDRESSES_FILE` instead of defaulting to dead V8.47 addresses);
  the eight stray `.txt` captures moved to `archive/captures/`.
- Suite: **611 passing / 7 pending / 0 failing.**

METHOD FINDING WORTH REUSING: MATRIX_SIZE is a CONSTRUCTOR ARGUMENT, not a constant.
Live-size behaviour is measurable in-process in seconds, no deploy, no chain:
`$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js`.

## THE CORRECTED A/B — AND WHAT IT MEANS

Harness in `test_ab/`; `contracts_v849b/` is the V8.49 deploy commit (de27329) built via
`hardhat.v849b.config.js`. 288 members, size 127, seeds 1/2/3, AB_CAP=5 both arms.

Session 6 reported park events "unchanged, ~131 both arms" with repeat-park share
inverting 0.11 -> 0.86, and concluded V8.50 does not fix the loop. **Both halves came from
a contaminated count. Two defects:**

- **Two different events are both named `MemberParked`** — the matrix's queue insertion
  (`FigureEightMatrixV8:98`) and TierRouter's placement REFUSAL (`TierRouter:372`).
  Different signatures, so bucketing by event NAME merged them. `args[0]` is `member` in
  both, so every per-member tally kept working over a mixture.
- **A queue insertion that emits no `MemberParked` at all** — `MatrixLogicLib:1516`
  (idle-slot reclaim) emits `SlotParkedIdle`. The exact identity is
  `queue insertions == MemberParked(matrix) + SlotParkedIdle`.

The first inflated V8.50 (57 refusals/run), the second deflated the control (18-20 idle
parks/run) — opposite directions, different sizes per arm, so the *difference between the
arms was manufactured*.

CORRECTED, 3 of 3 seeds:

| | v849b | V8.50 |
|---|---|---|
| queue insertions | 142 / 140 / 142 | **82 / 82 / 80** (~42% fewer) |
| of which idle-slot | 18 / 20 / 20 | **0 / 0 / 0** |
| distinct parkers | 130 / 129 / 132 | **71 / 67 / 64** |
| repeat parkers (absolute) | 12 / 11 / 10 | 11 / 13 / 15 |
| repeat-park share | .092 / .085 / .076 | .155 / .194 / .234 |
| evictions | 1 / 1 / 0 | **9 / 10 / 10** |

**V8.50 cuts total parking ~42% and halves distinct exposure.** The repeat-park share
rises 8.4% -> 19.4%, but the ABSOLUTE repeat-parker count is ~11 vs ~13 — the same handful
of members over a halved base. That is a much weaker claim than the withdrawn one, and it
does not support "V8.50 concentrates parking onto repeat members".

The FUND claims are untouched by any of this and still hold (loans per rescue 0.99 -> 0.52,
loan volume down ~60%, SF balance 4-6x healthier).

`AB_CENSUS=1` on `replay.js` is the instrument that caught it: it enumerates both parked
arrays before and after every keeper tick and diffs membership, so exits are seen whether
or not anything is emitted. It prints a census/event reconciliation every run. **The
control reconciles exactly (0). V8.50's gap of 11-16 is park-and-rescue inside one tick, a
known lower-bound artifact. A NEGATIVE gap means an undiscovered insertion path — stop and
find it.**

## WHAT IS NEXT

1. **Explain the ~10x evictions (9/10/10 vs 1/1/0).** The last surviving session-6 anomaly.
   Extend the census to record WHY discovery routed a member to `WORK_EVICT_PARKED` rather
   than `WORK_PARKED_RESCUE` — `loanEligible` false, deadline order, or queue position.
   Session 6's guess (defect 6's deadline ordering reaching starved eviction work) is still
   UNVERIFIED.
2. **Explain the withdrawable-at-rescue variance.** Control $3.73/$3.75/$3.72 — remarkably
   tight. V8.50 $7.43/$4.45/$2.15 — a 3.5x spread straddling it. Until that is understood
   no claim about member support at rescue is safe in either direction.
3. **Explain the router placement refusals, 11 -> 53 per run on V8.50.**
4. **Model self-rescue at a non-zero rate.** `SELF_RESCUE_RATE = 0` is a pathological
   extreme by construction, not a population.
5. **Gate measurements 3 and 4** — MatA parkers freed outright, E1 base coincidence. These
   genuinely need a running system; that is what the private chain is FOR.
6. **`maxItemsPerUpkeep` is vestigial.** The floor halts the batch before the cap binds at
   127. Confirm deliberately or lower it to 10.
7. **Re-run `diag_parked_growth.js` with `WINDOW=3000`.** Its last run reported 9 failed
   ranges ("numbers are FLOORS") while its SF section reconciled EXACTLY against the
   contract counters. Those two statements are in tension; resolve before quoting its park
   figures. Its exit accounting is now correct — cumulative-net 108 vs live queue 106,
   which closes section 6f's 212-vs-105.

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these

- **Two contracts can declare the same event NAME with different signatures and nothing
  will warn you.** Bucket parsed logs by name PLUS arity, or by topic0. Per-member
  accessors keep working over the mixture, so it is silent.
- **Count the state change, not the announcement of it.** `grep "push"` on the parked array
  found the seventh insertion path in one command; no amount of event archaeology would.
- **Two contaminated numbers that happen to agree read as a robust null result.** 139 vs
  136 "park events" looked like solid evidence of no change. Both were wrong.
- **A declared-but-unimplemented interface function is not a compile error.** It fails only
  at the moment its branch is first reached. `activateLayer` survived from V8.1 to 2026-08.
- `git commit -m` from PowerShell destroys dollar figures and mangles arrows and unicode.
  Write the message to a file and use `git commit -F`. (Remote tools cannot write into
  `.git/` — put the draft in the repo root and delete it after.)
- NEVER run `git add -A` or `git commit -a` from the device/Linux side. core.autocrlf is
  unset there, so 31 files show as modified on line endings alone. Stage explicit paths.
- Select-String with a non-ASCII pattern silently matches NOTHING against a console that
  mangles UTF-8. Keep patterns ASCII, and make sure the full result lands in a FILE anyway.
- Library events are NOT in a contract's ABI. RescueLoanIssued/SelfRescue/CoPayRescue come
  from MatrixLogicLib. A zero that flatters the hypothesis deserves more suspicion than one
  that does not.
- Parsing one log with several interfaces double-counts every event more than one ABI
  declares. Silent: ratios survive, raw totals are wrong.
- Record contract state by READING IT BACK. A flag recording intent is not evidence.
- A VOID pair is not a seed.
- The hardhat provider caps ONE transaction at 2^24 = 16,777,216 gas — BELOW the 17.8M
  ceiling. An over-cap tx reports NO gas, which reads as "the item did not complete".
- A cost curve mixing item KINDS describes no item that exists. Watch the step column.
- A sweep whose later rows test a more depleted world is a false-negative machine.
  snap.restore() undoes deployments — rebuild per row.
- PairManagerV8.rescueReentry returns a rescued member to their OWN pair
  (destPair = fromPairIndex). Correct and deliberate (V8.48 item 10) — do not "fix" it.
- Chain pay walks matrix POSITION, not the referral graph (MatrixLogicLib:1317).
- Run model_item_a.js MORE THAN ONCE before deciding anything.
- Every gas number not taken with GAS_MATRIX_SIZE=127 is size 7. The repo's old ~2.6M
  "live" figure was a BATCH AVERAGE, not an item cost.
- TierRouter's "escrow-zero defect" DOES NOT EXIST.
- A notional-carve credit was built and reverted — read the write-up at the top of
  MatrixKeeperLib._triageParked before having the idea again.
- V8_48_KeeperScan.test.js pins are load-bearing.
- `diag_parked_growth.js` no longer defaults to a dead addresses file — it refuses. If you
  see that refusal, set `ADDRESSES_FILE`, do not re-add a default.

## GUARDRAILS — unchanged

Nothing is deployed. No chain has been written to. V8.49 is deployed privately and
measured — do not repoint anything at it. Live V8.48 is the community chain and `.env` line
69 must stay `deployed_addresses_v8_48.json`. Before any test run whose numbers you intend
to trust, use `npx hardhat compile --force` (and `--config hardhat.v849b.config.js` for the
control). Live keeper scripts still carry GAS_PER_ITEM_DEFAULT = 3_500_000
(direct_keeper.js:27, direct_keeper_vps.js:26) — left alone deliberately; they drive live
V8.48, which has neither item A nor E1. Revisit with the V8.50 deploy.

⚠ Add to that list at V8.50 deploy time: **live V8.48 still carries the `activateLayer`
bug**, so its velocity gate freezes during any quiet window. Fixed only in the V8.50 tree.

On the deploy question, asked and answered 2026-08-18: PRIVATE FIRST, not the community.
Do NOT run two chains on Base Sepolia simultaneously — the V8.49 run had to STOP the live
bigfill because two chains on one network collide on wallet nonces. The A/B belongs
locally, where it already is.

## HOW WE WORK

You drive, decide direction, and make the file edits directly. I run every command and
paste back the output. Copy-paste blocks that name the folder, one step at a time, then
wait. Explain in plain language; I am not deep on the technical side. Do not ask which item
to take next — decide. Ask only when the answer is genuinely mine: a policy or economic
trade-off, not something you can determine from the code or the chain.

Contracts push to `v8.1`. There is no third party: every line of this codebase was written
by a previous session of you and executed by me. Write handoffs to yourself accordingly.
