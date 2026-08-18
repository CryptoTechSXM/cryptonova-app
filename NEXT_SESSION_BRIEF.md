# NEXT SESSION BRIEF — paste this to open the next session

Copy everything between the lines into a new session as your first message.
Kept in-repo so it is never lost. Update it at the END of every session.

---8<---

We are building **V8.50, "the crossing redesign"**, on branch `v8.1` in
`C:\CryptoNite-Smart-Contracts\CryptoNova`.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. **section 7a — THE TWO RULES.** Short, owner-set, non-negotiable.
2. **SESSION 5 STATE** at the top — what is built, what is closed, what is open.
3. **THE V8.50 DEPLOY GATE** — what has to be measured before we ship.

## THE TWO RULES — these govern everything

1. **Do not hypothesise unless necessary.**
2. **Measure and test before implementing. Never build on a hypothesis.**

They were set because the previous session got five things wrong by reasoning ahead of
measuring, and every one was caught only when an instrument contradicted itself. Section 7a
lists all five with what measurement actually said. Read them. The practical form:
**when two numbers disagree, the disagreement IS the finding — do not explain it, measure
it.** And: a number you have not run is not a result.

## WHAT IS DONE — do not re-derive any of this

- **Item E1 + defects 2, 4, 5, 6, 7, 8, 9** — built, committed, pushed. Suite is
  **602 passing / 7 pending / 0 failing** after `npx hardhat compile --force`.
- **PARAM 59 stays 3400** and **the SF ladder stays preset 1** — owner decisions, settled
  on measurement, replicated across three independent samples.
- **Tier-gate recalibration: closed.** Live T2 is $25.00; nobody upgrades at cycle-out in
  either world. The acceleration was V8Elevator's fixture ladder, not this chain.
- **Item D (shallow seating): closed.** 0 shallow seats in 1412 real seatings, 0 reclaims.
- **Frontend ABI audit: V8.50 PASSES.** All 7 findings predate V8.50.

## WHAT IS NEXT — the deploy gate

Deploy V8.50 to a **private chain at `MATRIX_SIZE` 127**, bigfill to force real rescues,
and measure exactly four things (hours, not days). The community stays on V8.48 throughout.

1. **Gas per SF-funded rescue at 127.** 1.76M measured at size 7; ~2.6M assumed at 127.
   **THIS IS THE WHOLE REASON THE GATE EXISTS.** `minGasPerItem = 3.5M` is a SAFETY
   mechanism and this is its only live-size input. If it lands above 3.5M the value is
   wrong and must move before the community sees V8.50 — and per defect 8 a wrong value
   does NOT revert loudly, it cascades `WorkItemFailed` and reads as a floor refusal.
2. `BatchGasHalted` fires, and at what batch size.
3. MatA parkers freed outright (PHASE 2 projects 67 of 67).
4. E1 makes the aggregate and ledger bases coincide (PHASE 6 claims it by construction).

Then re-run `model_item_a.js` against the private V8.50 chain and re-check PARAM 59 and the
ladder rung on a RUNNING system. Both are expected to hold. "Expected to hold" is a
hypothesis — rule 2 applies.

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these

- **`git commit -m` from PowerShell DESTROYS dollar figures.** `\$956.46` becomes `\.46`;
  backslash is not PowerShell's escape character. **Write the message to
  `.git/COMMIT_DRAFT.txt` and use `git commit -F .git/COMMIT_DRAFT.txt`.** Four commits are
  already mangled; the handoff is the record, not `git log`.
- **Every `Tee-Object` capture is UTF-16.** grep finds nothing and exits 0, which reads as
  "no failures". Decode before searching.
- **`diag_parked_growth.js` DEFAULTS to `deployed_addresses_v8_47.json`** and reads the live
  chain only because `.env` line 69 sets `ADDRESSES_FILE`. Every v8_47 address differs.
  Unset the variable and it measures a dead deployment while printing confident numbers.
- **Run `model_item_a.js` MORE THAN ONCE before deciding anything.** A count at a threshold
  held across three samples; a median nearly doubled in seven hours.
- **Every gas number in the repo is `MATRIX_SIZE` 7. Live is 127.** Never quote one as live.
- **TierRouter's "escrow-zero defect" DOES NOT EXIST.** Session 2 was wrong. Do not chase it.
- **A notional-carve credit in the rescue ladder was built and reverted.** The full
  write-up is at the top of `MatrixKeeperLib._triageParked`. Read it before having the idea
  again — it is a good instinct and it is wrong twice over.
- **`V8_48_KeeperScan.test.js` pins are load-bearing.** Read its header before touching it.

## GUARDRAILS — unchanged

**Nothing is deployed. No chain has been touched. V8.49 is deployed privately and measured
— do not repoint anything at it. Live V8.48 is the community chain and `.env` line 69 must
stay `deployed_addresses_v8_48.json`. Before any test run whose numbers you intend to
trust, use `npx hardhat compile --force`.**

## HOW WE WORK

You drive, decide direction, and make the file edits directly. **I run every command** —
tests, git, chain reads — and paste back the output. Give copy-paste blocks that name the
folder, one step at a time, and wait. Explain in plain language; I am not deep on the
technical side. **Do not ask which item to take next — decide.**

Contracts push to `v8.1`. There is no third party: every line of this codebase was written
by a previous session of you and executed by me. Write handoffs to yourself accordingly.

---8<---
