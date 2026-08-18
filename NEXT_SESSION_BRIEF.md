# NEXT SESSION BRIEF — paste this to open the next session

Copy everything between the lines into a new session as your first message.
Kept in-repo so it is never lost. Update it at the END of every session.

---8<---

We are building **V8.50, "the crossing redesign"**, on branch `v8.1` in
`C:\CryptoNite-Smart-Contracts\CryptoNova`.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. **section 7a — THE TWO RULES.** Short, owner-set, non-negotiable.
2. **SESSION 6 STATE** at the top — what is built, closed, measured, and CONTRADICTED.
3. **THE v8.49b vs V8.50 A/B** — the fund claims held; the loop claim did not.

## THE TWO RULES — these govern everything

1. **Do not hypothesise unless necessary.**
2. **Measure and test before implementing. Never build on a hypothesis.**

Practical form: **when two numbers disagree, the disagreement IS the finding — measure it,
do not explain it.** A number you have not run is not a result.

Session 6's evidence for this is worth one line: **every bug in the new A/B harness was
caught by an instrument contradicting itself, not by care.** `loans: 0` beside 18 completed
rescues. A control that could not finish the workload. "Equalised" results byte-identical to
un-equalised ones. A comparison script printing "3 seeds ✅" beneath three VOID banners.

## WHAT IS DONE — do not re-derive any of this

- **Item E1 + defects 2,4,5,6,7,8,9**, PARAM 59 at 3400, ladder preset 1, tier gates, item D,
  frontend ABI audit — all settled earlier and unchanged.
- **⛔ GATE MEASUREMENTS 1 AND 2 — ANSWERED, no chain needed.** A cold SF-funded rescue at
  live `MATRIX_SIZE` 127 costs **4.37M**; it has three prices by batch position (4.37M cold /
  2.83M mid-batch / 1.43M warm); cost is ~linear at ~23k per matrix position. The guard fires,
  halts cleanly, defers rather than drops.
- **`minGasPerItem` 3.5M -> 5M** on that measurement (owner decision). Costs ~1 item/batch.
- **The A/B ran, 3 seeds, valid pairs.** See below — it is the most important open thread.
- **Suite: 606 passing / 7 pending / 0 failing.** Commits `fd159ed`, `d59593f` pushed to `v8.1`.

**METHOD FINDING WORTH REUSING: `MATRIX_SIZE` is a CONSTRUCTOR ARGUMENT, not a constant.**
Live-size behaviour is measurable in-process in seconds, no deploy, no chain:
`$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js`. Ask whether a
question really needs a chain before booking one.

## ⛔ THE OPEN THREAD — THE A/B CONTRADICTS THE SCOPE, AND IT IS NOT EXPLAINED

Harness in `test_ab/` — one deterministic sequence replayed on both arms; `contracts_v849b/`
is the V8.49 deploy commit built through `hardhat.v849b.config.js`. 288 members, size 127,
seeds 1/2/3, `AB_CAP=5` on both arms, 0 keeper failures on both.

**HELD, 3 of 3 seeds:** loans per rescue 0.99 -> 0.52 · loan volume down ~60% · SF balance
4-6x healthier · distinct members ever parked down ~40%. **That is item A, confirmed against
a running control instead of a projection.**

**DID NOT HOLD:** total park EVENTS are unchanged (~131 both arms). V8.50 concentrates the
same parking onto HALF as many members, and **86% of those cycle** — against the control's
10%, and against the 83.2% session 5 named as THE PROBLEM. **V8.50 reduces exposure to the
loop; it does not fix it.** It also evicts ~10x more members (≈10 vs ≈1).

**Two tempting explanations, both UNVERIFIED — do not build on either:**
that the extra evictions are defect 6's deadline ordering finally reaching starved eviction
work; and that item A's cheaper rescues return a member with less support so they re-park
sooner. The second is neat enough to be dangerous.

## WHAT IS NEXT

1. **Explain the repeat-park inversion.** Per-member time-to-re-park and withdrawable-balance
   -at-rescue, by arm. This is the one result that contradicts the scope; it must not stay a
   story. Everything else on this list is smaller.
2. **Explain the 68 VELOCITY `WorkItemFailed`** — identical on both arms, every run, so
   non-confounding but unexplained. Do not trust the harness further until it is understood.
3. **Model self-rescue at a non-zero rate.** The harness is `SELF_RESCUE_RATE = 0` by
   construction, which section 8 already calls a pathological extreme, not a population. The
   repeat-park figures are an upper bound on churn.
4. **Gate measurements 3 and 4** — MatA parkers freed outright, E1 base coincidence. These
   genuinely need a running system; that is what the private chain is now FOR.
5. **`maxItemsPerUpkeep` is vestigial.** The floor halts the batch before the cap binds at
   127. GAS-7's measured curve fits cap 10 (17.27M) and exceeds at 15. Either confirm that
   deliberately or lower it to 10.

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these

- **`git commit -m` from PowerShell destroys dollar figures** and mangles `->` and `⛔`. Write
  to `.git/COMMIT_DRAFT.txt` and `git commit -F`. (Remote tools cannot write into `.git/` —
  put the draft in the repo root and delete it after.)
- **NEVER run `git add -A` or `git commit -a` from the device/Linux side.** `core.autocrlf` is
  unset there, so 31 files show as modified on line endings alone. Windows git sees them clean.
  Today's commits were clean only because they staged explicit paths.
- **`Select-String` with a non-ASCII pattern silently matches NOTHING** against a console that
  mangles UTF-8. It hid every keeper-failure line. Put diagnostics in the RESULT FILE.
- **Library events are NOT in a contract's ABI.** `RescueLoanIssued`/`SelfRescue`/`CoPayRescue`
  come from `MatrixLogicLib`. Parsing with contract interfaces alone reported `loans: 0` beside
  18 rescues — which would have read as "item A removed all lending", the exact claim under
  test. **A zero that flatters the hypothesis deserves more suspicion than one that does not.**
- **Parsing one log with several interfaces double-counts** every event more than one ABI
  declares. Silent: ratios survive, raw totals are wrong.
- **Record contract state by READING IT BACK.** A flag recording intent is not evidence.
- **A VOID pair is not a seed.** Do not let a summary count runs it just declared unreadable.
- **The hardhat provider caps ONE transaction at 2^24 = 16,777,216 gas** — BELOW the 17.8M
  ceiling. An over-cap tx reports NO gas, which reads as "the item did not complete".
- **A cost curve mixing item KINDS describes no item that exists.** Watch the step column.
- **A sweep whose later rows test a more depleted world is a false-negative machine.**
  `snap.restore()` undoes deployments — rebuild per row.
- **`PairManagerV8.rescueReentry` returns a rescued member to their OWN pair**
  (`destPair = fromPairIndex`). Adding a pair can never attract parked rescues. Correct and
  deliberate (V8.48 item 10) — do not "fix" it.
- **Chain pay walks matrix POSITION, not the referral graph** (`MatrixLogicLib:1317`).
- **`diag_parked_growth.js` DEFAULTS to `deployed_addresses_v8_47.json`.**
- **Run `model_item_a.js` MORE THAN ONCE before deciding anything.**
- **Every gas number not taken with `GAS_MATRIX_SIZE=127` is size 7.** The repo's old ~2.6M
  "live" figure was a BATCH AVERAGE, not an item cost.
- **TierRouter's "escrow-zero defect" DOES NOT EXIST.**
- **A notional-carve credit was built and reverted** — read the write-up at the top of
  `MatrixKeeperLib._triageParked` before having the idea again.
- **`V8_48_KeeperScan.test.js` pins are load-bearing.**

## GUARDRAILS — unchanged

**Nothing is deployed. No chain has been touched. V8.49 is deployed privately and measured —
do not repoint anything at it. Live V8.48 is the community chain and `.env` line 69 must stay
`deployed_addresses_v8_48.json`. Before any test run whose numbers you intend to trust, use
`npx hardhat compile --force`** (and `--config hardhat.v849b.config.js` for the control arm).

Live keeper scripts still carry `GAS_PER_ITEM_DEFAULT = 3_500_000` (`direct_keeper.js:27`,
`direct_keeper_vps.js:26`). Left alone deliberately — they drive live V8.48, which has neither
item A nor E1. Revisit with the V8.50 deploy.

**On the deploy question, asked and answered 2026-08-18: PRIVATE FIRST, not the community.**
Defect 9's path has no test coverage, E1 is deployed nowhere, and re-registration is something
you do to a community once. Do NOT run two chains on Base Sepolia simultaneously — the V8.49
run had to STOP the live bigfill because two chains on one network collide on wallet nonces.
The A/B belongs locally, where it already is.

## HOW WE WORK

You drive, decide direction, and make the file edits directly. **I run every command** and
paste back the output. Copy-paste blocks that name the folder, one step at a time, then wait.
Explain in plain language; I am not deep on the technical side. **Do not ask which item to
take next — decide.** Ask only when the answer is genuinely mine: a policy or economic
trade-off, not something you can determine from the code or the chain.

Contracts push to `v8.1`. There is no third party: every line of this codebase was written by
a previous session of you and executed by me. Write handoffs to yourself accordingly.

---8<---
