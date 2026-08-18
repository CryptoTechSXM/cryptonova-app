# NEXT SESSION BRIEF — paste this to open the next session

Copy everything between the lines into a new session as your first message.
Kept in-repo so it is never lost. Update it at the END of every session.

---8<---

We are building **V8.50, "the crossing redesign"**, on branch `v8.1` in
`C:\CryptoNite-Smart-Contracts\CryptoNova`.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. **section 7a — THE TWO RULES.** Short, owner-set, non-negotiable.
2. **SESSION 6 STATE** at the top — what is built, what is closed, what is open.
3. **THE V8.50 DEPLOY GATE** — measurements 1 and 2 are DONE; 3 and 4 are what remains.

## THE TWO RULES — these govern everything

1. **Do not hypothesise unless necessary.**
2. **Measure and test before implementing. Never build on a hypothesis.**

The practical form: **when two numbers disagree, the disagreement IS the finding — do not
explain it, measure it.** And: a number you have not run is not a result. Section 7a lists
the five things a previous session got wrong by reasoning ahead of measuring.

Session 6 earned two more entries in that spirit, both caught by instruments contradicting
themselves rather than by thinking harder — see the traps list below.

## WHAT IS DONE — do not re-derive any of this

- **Item E1 + defects 2, 4, 5, 6, 7, 8, 9** — built, committed, pushed.
- **PARAM 59 stays 3400**, **SF ladder stays preset 1**, **tier-gate recalibration closed**,
  **item D closed**, **frontend ABI audit passes**. All settled on measurement.
- **⛔ GATE MEASUREMENT 1 — ANSWERED.** A cold SF-funded rescue at the live `MATRIX_SIZE`
  127 costs **4.37M**. It has THREE prices by position in the batch: 4.37M cold (item #1),
  2.83M first-touch mid-batch, 1.43M fully warm. Cost is ~linear in matrix size,
  ~23k/position.
- **⛔ GATE MEASUREMENT 2 — ANSWERED.** `BatchGasHalted` fires at live size, halts cleanly,
  defers rather than drops, zero `WorkItemFailed` across every budget tested.
- **`minGasPerItem` MOVED 3.5M -> 5M** on that measurement (owner decision, 2026-08-18).
  Cost: about one item per batch, measured.
- **Suite: 606 passing / 7 pending / 0 failing** after `npx hardhat compile --force`.

**THE BIG METHOD FINDING: `MATRIX_SIZE` IS A CONSTRUCTOR ARGUMENT, NOT A CONSTANT.**
Live-size gas is measurable in-process in ~15 seconds, with no deploy and no chain:
`$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js` (then
`Remove-Item Env:\GAS_MATRIX_SIZE`). The gate was scoped as "private chain, bigfill, hours"
because nobody had noticed. Ask whether a question really needs a chain before booking one.

## WHAT IS NEXT

1. **Gate measurements 3 and 4** — MatA parkers freed outright (PHASE 2 projects 67 of 67)
   and E1 making the aggregate and ledger bases coincide. These genuinely need a running
   system; that is what the private chain is now FOR, and it has less to prove than before.
2. **Re-run `model_item_a.js`** against the private V8.50 chain; re-check PARAM 59 and the
   ladder rung on a running system. Expected to hold — which is a hypothesis, so rule 2.
3. **`maxItemsPerUpkeep` is unfinished business.** GAS-7's measured curve says a saturated
   SF-funded batch fits the 17.8M ceiling at cap 10 (17.27M) and EXCEEDS at 15 (24.44M).
   The shipped cap is 20. It has never bitten because the floor stops the batch first — so
   either confirm deliberately that the cap is now vestigial, or lower it to 10.
4. **Two-tier fixture — NO LONGER BLOCKING.** 5M clears the measured worst item whatever the
   tier count. It is now a CAP question, not a floor question.

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these

- **`git commit -m` from PowerShell DESTROYS dollar figures** and mangles `->` and `⛔`.
  Write to `.git/COMMIT_DRAFT.txt` and use `git commit -F .git/COMMIT_DRAFT.txt`.
- **Every `Tee-Object` capture is UTF-16.** grep finds nothing and exits 0. Use
  `Out-File -Encoding utf8`.
- **The hardhat provider caps ONE transaction at 2^24 = 16,777,216 gas** — BELOW the 17.8M
  ceiling. An over-cap tx reports NO gas at all, which reads as "the item did not complete":
  defect 8's failure mode inside your instrument. Never let a capped row report as zero.
- **A cost curve that mixes item KINDS produces a number describing no item that exists.**
  Watch the step column; a 3x jump mid-curve means you are averaging two populations.
- **A test that mutates a contract value must restore before reporting it**, or it prints its
  own leftover state as a fact about the contract.
- **A sweep whose later rows test a more depleted world than its earlier ones is a
  false-negative machine.** `snap.restore()` undoes deployments — rebuild per row.
- **`PairManagerV8.rescueReentry` returns a rescued member to their OWN pair**
  (`destPair = fromPairIndex`). Adding a pair can NEVER attract parked rescues. Correct and
  deliberate (V8.48 item 10, fixed a measured live loop) — do not "fix" it.
- **Chain pay walks matrix POSITION, not the referral graph** (`MatrixLogicLib:1317`). A
  deep-referral fixture measures nothing. One grep, not a fixture.
- **`diag_parked_growth.js` DEFAULTS to `deployed_addresses_v8_47.json`** and reads the live
  chain only because `.env` line 69 sets `ADDRESSES_FILE`.
- **Run `model_item_a.js` MORE THAN ONCE before deciding anything.**
- **Every gas number NOT taken with `GAS_MATRIX_SIZE=127` is `MATRIX_SIZE` 7.** Never quote
  one as live. The repo's old ~2.6M "live" figure was a BATCH AVERAGE, not an item cost.
- **TierRouter's "escrow-zero defect" DOES NOT EXIST.** Session 2 was wrong.
- **A notional-carve credit was built and reverted.** Read the write-up at the top of
  `MatrixKeeperLib._triageParked` before having the idea again.
- **`V8_48_KeeperScan.test.js` pins are load-bearing.**

## GUARDRAILS — unchanged

**Nothing is deployed. No chain has been touched. V8.49 is deployed privately and measured
— do not repoint anything at it. Live V8.48 is the community chain and `.env` line 69 must
stay `deployed_addresses_v8_48.json`. Before any test run whose numbers you intend to trust,
use `npx hardhat compile --force`.**

The live keeper scripts still carry `GAS_PER_ITEM_DEFAULT = 3_500_000`
(`direct_keeper.js:27`, `direct_keeper_vps.js:26`). Left alone deliberately — they run
against live V8.48, which has neither item A nor E1. Revisit with the V8.50 deploy.

## HOW WE WORK

You drive, decide direction, and make the file edits directly. **I run every command** —
tests, git, chain reads — and paste back the output. Give copy-paste blocks that name the
folder, one step at a time, and wait. Explain in plain language; I am not deep on the
technical side. **Do not ask which item to take next — decide.** Ask only when the answer is
genuinely mine: a policy or economic trade-off, not something you can determine from the
code or the chain.

Contracts push to `v8.1`. There is no third party: every line of this codebase was written
by a previous session of you and executed by me. Write handoffs to yourself accordingly.

---8<---
