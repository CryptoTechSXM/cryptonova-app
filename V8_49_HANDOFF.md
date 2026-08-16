# V8.49 HANDOFF — written 2026-08-15 (read this FIRST, then `V8_49_SCOPE.md`)

Audience: a future session of Claude, plus the owner. Nobody else touches this code.

**This replaces `V8_48_HANDOFF.md` as the entry point.** That file is still the record
of the V8.48 DEPLOY (what went live 2026-08-13, the deploy-day traps, the member issues
open at that moment) — keep reading it for deployed-state questions. For "what am I
working on now", it is this file then `V8_49_SCOPE.md`.

---

## WHERE THINGS STAND IN ONE PARAGRAPH

V8.48 is **live on Base Sepolia** and healthy. V8.49 is **in progress on branch `v8.1`**
of the contracts repo (`admin → preview → main` is the FRONTEND repo only). Item 1b —
the crossing buffer — is **built, tested and pushed**: `575 passing, 0 failing` (was
565). Item 1 — the eviction clock — is **fully specified and deliberately NOT started**;
its build plan is in `V8_49_SCOPE.md` under "🔧 BUILD PLAN". Nothing is uncommitted,
nothing is half-refactored, nothing is deployed that should not be.

**Two commits today:** `7d41fcc` (item 1b) and `6151590` (baseline logging + item 1
plan). Both pushed to `origin/v8.1`.

---

## WHAT SHIPPED TODAY — ITEM 1b, THE CROSSING BUFFER

The session started on one open question in `V8_49_SCOPE.md` item 1b: *where does the
keeper compute `crossingBuffer`, and what bounds it?*

**Answer, read in the code, not inferred:** `MatrixKeeper.sol:568` computed it from a
`public constant CROSSING_BUFFER_BPS = 3_600` — a **flat 36% of the tier entry fee**,
with nothing about the member in it. Nothing bounded it except the fund's own cash.

That answer cascaded:

- **The observed $5.20 debts decompose as `$1.60 shortfall + $3.60 buffer`.** The
  scope's earlier guess ("$5.00 shortfall + ~$0.20 buffer") was wrong in both terms and
  has been corrected in place.
- **The buffer (3_600) was LARGER than `insolvencyFloorBps` (3_400)**, so every advance
  cleared the floor before any shortfall was added. The floor could not refuse anyone,
  and "policy B" (test the floor AFTER the advance) would have refused **everyone** —
  measured 52 of 52, then 88 of 88. Both useless. The two mechanisms contradicted each
  other by construction.
- **A live keeper-halt path** (scope finding (ii)): the buffer was computed OUTSIDE
  every branch on `sfShare`, so a self-funded member still triggered `payForceCross`,
  which could revert `"SF: insolvency floor"` — a string NOT on `performUpkeep`'s
  swallow-list, which would revert the WHOLE batch. **Setting the buffer to 0 deletes
  this path rather than patching it** (`totalSfNeeded == 0` skips the call entirely).
- **Owner decision:** remove it. Built as `crossingBufferBps`, **default 0**, DAO param
  **61**, menu `0/900/1800/2700/3600` — reversible without a redeploy.

Files: `contracts/MatrixKeeper.sol`, `contracts/V8Governance.sol`,
`scripts/predeploy_check.js`, **new** `test/V8_49_CrossingBuffer.test.js` (10 tests),
**new** `scripts/diag_floor_halt.js`.

---

## MEASURED ON THE LIVE CHAIN TODAY — USE THESE, DO NOT RE-DERIVE

`scripts/diag_floor_halt.js`, run by the owner (neither sandbox can reach Base Sepolia
— the proxy 403s, so **every on-chain number here came from the owner running a script
and pasting the output**).

| | 1st read | +4.6h |
|---|---|---|
| parked | 52 | **88** |
| SF totalBalance | $100.84 | $230.08 |
| `stabilityFloor` | **$0.00** | $0.00 |
| pending ask, with buffer | $232.29 | $566.43 |
| buffer's share of that ask | **80%** | **74%** |
| rescues the fund can complete | 21 of 52 | **48 of 88** |
| …at `crossingBufferBps = 0` | all 52 | **all 88, $88.45 left** |
| halt risk / ghosts / evictions / debt among parked | 0 / 0 / 0 / $0.00 | 0 / 0 / 0 / $0.00 |

**THE FINDING THAT AROSE ONLY FROM THE SECOND READ: the buffer is a THROUGHPUT limit.**
The keeper trims the buffer as the fund drains and then skips the rest gracefully, so
the SF spends its capacity on buffers for the first 48 members instead of rescues for
all 88. **Forty members wait who would not have to.** That is a direct part of why the
queue does not drain — the owner's standing product concern.

**`stabilityFloor` is $0.00**, which is why SF exhaustion degrades gracefully instead of
reverting the batch. **Any non-zero floor turns exhaustion into a whole-batch revert**
(the trim lands exactly on `totalBalance >= fee + stabilityFloor`). Worth a guard.

---

## NEXT — ITEM 1, THE EVICTION CLOCK. DO NOT REDESIGN IT.

`V8_49_SCOPE.md` → item 1 → "🔧 BUILD PLAN" has the whole design. The short version of
why it is not a one-liner, and the parts that will bite:

1. `_triageParked` returns a **bool**, so a harmless GHOST and an insolvent member are
   indistinguishable when the clock is applied. Use a **`uint8` reason code** — NOT an
   extra return value: that function's own comments record the evict branch already
   blowing the EVM stack once.
2. **Ghosts keep today's `parkedGracePeriod`** (decided 2026-08-15) so the new param
   introduces exactly one behavioural change, not two. One line to reverse.
3. **Two existing fixtures WILL break, with misleading failures:**
   `V8_48_GhostFloor.test.js` (asserts `WORK_EVICT_PARKED` after 24h for ratio/ladder/
   floor cases) and `V8_48_KeeperScan.test.js` (byte-identical `performData` against the
   frozen pre-refactor keeper — pin `evictionGracePeriod == parkedGracePeriod` in its
   `setup()`, the same remedy that file already uses for item 12's split grace).
4. Item 1 and item 1b's policy-B half **ship together** — the scope says so and the
   reason still holds: B alone refuses a thin member and the 24h clock evicts them the
   next day, which is worse for that member than today.

---

## OPEN, HONESTLY STATED

- **No end-to-end test that a real rescue books `shortfall` and nothing more.** The
  arithmetic change rests on the live measurement, not on a test. Closing it means
  extending `V8_48_GhostFloor.test.js`'s mock harness to run `_doParkedRescue`, not just
  discovery. Written into the test file's own header too.
- **The parked GROWTH RATE on V8.48 is still not established.** `logs/parked_baseline.csv`
  has **one row**. Two runs several hours apart make `diag_floor_halt.js` print the rate.
  The 2026-08-13 investigation's "+125/day, 99.8% repeat share" is **old-chain (V8.47)**
  and is not comparable — that investigation's fixes shipped in V8.48 and were never
  re-measured. **That is the unfinished half of the parked investigation.**
- **Ghosts measured 0 of 88** — first real evidence item 45 works, with the caveat that
  this chain is days old and has had little time to accumulate them.
- The V8.48 handoff's own open list (wallet RPC `sepolia.base.org`, raw RPC error in
  `alert()`, `uBal` fabrication, epoch panel) is **untouched today** and still open —
  it is items 2–4 of `V8_49_SCOPE.md`.

---

## TRAPS LEARNED TODAY (cost two failed test runs; do not repay them)

- **`MatrixKeeper` is a LINKED contract** since V8.48 item 12a. `getContractFactory`
  needs `{ libraries: { MatrixKeeperLib: <addr> } }` or it throws "missing links" before
  any test body runs. `V8_48_KeeperScan` / `V8_48_GhostFloor` show it. `V8Governance` and
  `StabilityFund` are NOT linked — copying from their fixtures is what misled the draft.
- **ethers v6 `Interface.getFunction()` returns `null`** for an unknown name; it does not
  throw (verified against ethers 6.17). A `try/catch` around it never fires. Same family
  as this project's fabricated-fallback bugs: a null read as a value.
- **`checkUpkeep` returning `upkeepNeeded: false` proves nothing about a latent path** —
  it reports only what is DUE at that block, and a parked member inside grace produces no
  work item. Ask the question directly instead; that is what `diag_floor_halt.js` is for.

---

## HOW TO WORK (from `/preferences.md` — read it at session start AND periodically)

Claude drives, decides direction, and makes file edits directly. The owner runs every
command (tests, git, chain reads, VPS) and reports back — give copy-paste blocks that
name the folder. One step at a time. Do not ask which backlog item to take next; decide.
Stage git by explicit path, never `git add -A` (the CRLF phantom files). Contracts repo
pushes to **`v8.1`**; the `admin → preview → main` ladder is the frontend repo only.

**Verify the premise before implementing, and rerun rather than assert.** Today that
rule paid twice: the "$5.00 + $0.20" decomposition was wrong, and `stabilityFloor` was
read on chain rather than assumed from `deploy_v8.js` never setting it.
