# V8.49 HANDOFF — written 2026-08-15, updated 2026-08-16 twice (read this FIRST, then `V8_49_SCOPE.md`)

Audience: a future session of Claude, plus the owner. Nobody else touches this code.

**This replaces `V8_48_HANDOFF.md` as the entry point.** That file is still the record
of the V8.48 DEPLOY (what went live 2026-08-13, the deploy-day traps, the member issues
open at that moment) — keep reading it for deployed-state questions. For "what am I
working on now", it is this file then `V8_49_SCOPE.md`.

---

## WHERE THINGS STAND IN ONE PARAGRAPH

V8.48 is **live on Base Sepolia** and healthy. V8.49 is **in progress on branch `v8.1`**
of the contracts repo (`admin → preview → main` is the FRONTEND repo only). **Item 1b is
now COMPLETE — both halves.** The crossing buffer (2026-08-15), the eviction clock
(item 1, 2026-08-16 morning) and **policy B (2026-08-16, commit `40d7843`)** are all
built, tested and pushed: `594 passing, 0 failing` (was 584, 575, 565), predeploy
`142/142` (was 131). **Nothing of V8.49 is deployed**: the chain is still running V8.48.
Nothing is half-refactored, nothing is uncommitted.

**Next up: the `selfFundedGracePeriod` deploy gap** (small, and it is a hard MAINNET=1
predeploy failure), then **item 2, the wallet RPC**. See "NEXT" below.

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
(the trim lands exactly on `totalBalance >= fee + stabilityFloor`). ~~Worth a guard.~~
**GUARDED 2026-08-16** — `"SF: below floor"` is on `performUpkeep`'s swallow-list now, so
exhaustion skips a member (with `WorkItemFailed`) instead of stopping the queue.

### THIRD READING, 2026-08-16 — the two columns above are SUPERSEDED, keep them only as the trend

| | 1st (08-15) | +4.6h | **2026-08-16** |
|---|---|---|---|
| parked | 52 | 88 | **101, then 104** |
| SF totalBalance | $100.84 | $230.08 | **$294.12** |
| pending ask, with buffer | $232.29 | $566.43 | **$716.89** |
| buffer's share | 80% | 74% | **71%** |
| rescues the fund completes | 21 of 52 | 48 of 88 | **62 of 101** |
| …at `crossingBufferBps = 0` | all 52 | all 88 | **all 101, $92.03 left** |
| halt risk / ghosts | 0 / 0 | 0 / 0 | **0 / 0** |
| **parked growth rate** | — | (burst, not a rate) | **+212/day** |

**The fund is growing and the queue is growing faster.** SF nearly tripled while the
queue doubled; the buffer still eats 71% of every ask. Nothing here changes the buffer
decision — it strengthens it.

---

## WHAT SHIPPED 2026-08-16 — ITEM 1, AND THE FALSE PREMISE IT WAS OPENED ON

### ⚠️ READ THIS FIRST — the scope's original framing of item 1 was WRONG

**V8.48 never evicted anyone 24 hours after they parked.** That claim came from reading
`MatrixKeeperLib`'s evict branch, which gates **discovery**. `MatrixKeeper._doEvictParked`
has always had its own independent gate — `extendedIdleTimeout`, **7 days**, never set at
deploy. A member could be QUEUED from 24h and never evicted: the item was consumed and the
function returned silently. **The owner's "not before 3-5 days" policy was already met.**

What was genuinely broken: **two unrelated knobs governed one behaviour.** Neither
`parkedGracePeriod` (SF rescue) nor `extendedIdleTimeout` (idle-*slot reclaim*) means
"eviction", so the timing could not be read off any value, could not be voted on, and
moved if either unrelated knob moved — and discovery burned `maxItemsPerUpkeep` slots for
six days on items execution refused.

**Found by reading `_doEvictParked` while starting policy B** — the "verify the premise"
rule, one item too late. It could NOT have been found by running: **every test drove
`checkUpkeep` only.** Full correction in `V8_49_SCOPE.md` item 1's top box.

### What shipped

**`evictionGracePeriod` is the ONLY eviction clock now**, read by discovery AND execution,
**default 7 days** — exactly what `extendedIdleTimeout` already enforced, so **nobody's
eviction timing moved**. The policy became reachable by DAO vote, not enacted. Owner chose
that over the plan's 4-day default precisely because 4 days would have SHORTENED members'
real window from 7. `extendedIdleTimeout` goes back to meaning only idle-slot reclaim —
**do not re-couple them.**

### Five things worth carrying forward

1. **A clock in this system is TWO gates.** Discovery decides what is queued; execution
   decides what happens. **Before believing any "X happens after N", find both gates.**
2. **`0` had to go on the setter menu**, which the plan did not call for. Without it
   `V8_48_KeeperScan.test.js` — which pins `setParkedGracePeriod(0)` on both keepers —
   cannot make the two clocks equal, and the frozen-keeper equivalence harness cannot be
   repaired. Shipped menu `0 / 1d / 2d / 3d / 4d / 5d / 7d`. **0 means evict immediately,
   not "eviction off"** — same shape as `parkedGracePeriod`'s 0.
3. **The plan named two breaking fixtures. There were four.** Both extras were in
   `predeploy_check.js` (one asserting the old evict branch; one pinning `PARAM_MAX_ID` to
   a literal constant name — the **third** time that anti-pattern has been hit, now fixed
   by value comparison so param 63 will not break it) plus **`V8_48_SplitGrace.test.js`**,
   which nothing predicted: its eviction test said "keeps the FULL window", written when
   eviction and rescue shared a clock, so it had encoded a coincidence as an intention.
   Extended, not pinned — it now walks all three windows.
4. **An untestable path is where this class of bug lives.** `_doEvictParked` returns early
   when `rotationCount == 0` and `MockMatrixK` had no setter for it, so the execution path
   was literally unreachable from any mock test. `setRotationCount` was added and EC-8/EC-9
   are the first tests in this repo to drive `performUpkeep` rather than `checkUpkeep`.
   **When a test cannot reach a path, that is a finding, not an inconvenience.**
5. **The stack held.** `_checkParked` compiled first try; `bool` → `uint8` really is one
   slot, with the gate as a ternary inside the branch rather than a new local. Keep that
   shape if the function is touched again.

---

## ✅ SHIPPED 2026-08-16 (afternoon) — ITEM 1b's POLICY-B HALF, commit `40d7843`

Full record in `V8_49_SCOPE.md` item 1b under "✅ BUILT 2026-08-16". The short version:

**The floor now tests `memberDebt + advance <= fee * insolvencyFloorBps / 10_000`** at
both SF entry points, and **`_triageParked` asks the same question about the same number**
in the same commit. `loanHeadroom` is the single primitive; `loanEligibleFor` and
`loanEligible` derive from it. `performUpkeep` swallows both `"SF: insolvency floor"` and
`"SF: below floor"` as belt-and-braces (both still emit `WorkItemFailed`).

**Owner decision: STRICT B — one rule, first loan or not.**

### THE FIVE THINGS WORTH CARRYING FORWARD

1. **`memberDebt` IS CURRENT OUTSTANDING, NOT LIFETIME.** `applyRepayment` decrements it,
   so a member who borrowed and repaid reads `$0.00` — indistinguishable, in every
   getter, from one who never borrowed. An intermediate finding this session claimed "4
   of the refused have never borrowed"; **the owner refused to accept it and was right.**
   The event log said 0 of 15. **Before describing anyone's history from a mapping, ask
   whether that mapping is a BALANCE or a LEDGER.**
2. **A DETECTOR'S OWN TOTAL MUST BE RECONCILED AGAINST A COUNTER THE CONTRACT KEEPS.**
   `diag_loan_history.js` checks Σ`MemberDebtIncreased.amount` against
   `totalRescueLoaned()` — written by the same function — and refuses to be believed if
   they differ. It matched (62 events, $228.72). Without that, a capped scan gives a
   clean, plausible, wrong "never borrowed".
3. **I MADE THE CAPPED-SCAN MISTAKE MYSELF, IN A SHELL PIPE.** I predicted which fixtures
   would break by grepping for `setTierFee` and piping through `head -30`.
   `stress_test_full.js` sorts after the `V8_*` files, fell off the end, and I read the
   absence as evidence. It broke. **Do not truncate a search you intend to draw a
   negative conclusion from.**
4. **THREE OF THE FOUR BROKEN FIXTURES WERE ONE SHAPE:** a premise of "the SF covers 100%
   of the entry fee", which is 294% of a 34% ceiling. Under V8.48 zero debt was a free
   pass regardless of loan SIZE, so none of them ever had to state that assumption. All
   three now assert the refusal first, then raise the floor to 10_000 bps to say the
   premise out loud. **When a rule gains a dimension, every fixture that was silent about
   that dimension is a candidate.**
5. **A BOOLEAN MOCK CANNOT TEST AN AMOUNT.** `MockStabilityFundK.loanEligible` was a
   per-member flag, which answers identically for a $0.01 loan and a $6.00 one — exactly
   the bug policy B fixes. It now carries the real floor arithmetic, defaults inert.

---

## NEXT — TWO ITEMS, IN THIS ORDER

### 1. `selfFundedGracePeriod` is never set by `deploy_v8.js` (small, but a mainnet blocker)

It ships at the contract default of **5 minutes**. Its own declaration says the mainnet
default is **6h**, and `predeploy_check.js` already fails hard on it when `MAINNET=1` —
today it prints as an `ℹ`, which is the honest state for testnet and the wrong state for
launch. Fix is either a setter call in the deploy or a documented post-deploy tx. **Decide
which and write it down either way** — the "a live setter call is not a code change" rule.

### 2. Item 2 — the wallet RPC (likely the biggest member-facing win in the scope)

`index.html:2834` and `:2903` hand members the PUBLIC `sepolia.base.org` endpoint while
the site's own reads go elsewhere. Carried from the V8.48 handoff, untouched today.

**Also open, and now RESOLVABLE:** the ladder-vs-floor contradiction — see the new
"⚠️ NEW, UNRESOLVED" section in `V8_49_SCOPE.md` item 1b. The SF rescue ladder lends up to
60% of the entry fee against a 34% ceiling, so **preset 1's bottom rungs can never fire**
and a member below 66% effective contribution is refused with zero debt. Three options are
written up. **Re-run `diag_floor_halt.js` before deciding** — the refusal count moved
13 → 15 inside forty minutes today.

---

## OPEN, HONESTLY STATED

- **No end-to-end test that a real rescue books `shortfall` and nothing more.** Still
  open, but **narrower than it was**: `V8_49_InsolvencyFloor.test.js` IF-10 now drives
  `performUpkeep` into `_doParkedRescue` for real, so the execution path is no longer
  untested — what is missing is an assertion on the `increaseMemberDebt` AMOUNT, which
  the mock matrix stubs out. Closing it means a `forceCrossKeeper` mock that records its
  `(sfContribution, crossingBuffer)` arguments. Cheap now that the harness reaches it.
- ~~**The parked GROWTH RATE on V8.48 is still not established.**~~ **MEASURED
  2026-08-16: +212/day** (88 → 101 parked in 1.5h, `logs/parked_baseline.csv` row 2).
  That is the first real V8.48 figure and it is **worse than the old V8.47 chain's
  +125/day**, which the 2026-08-13 investigation treated as the problem case. Two rows is
  still a slope through two points with a registration burst in it — keep appending, and
  do not quote it as settled. **The queue is not draining, and that is the owner's
  standing product concern; `crossingBufferBps = 0` is expected to help (the same $294 SF
  covers all 104 instead of 62) but is NOT DEPLOYED yet.**
- **Ghosts measured 0 of 88, then 0 of 101** — accumulating evidence item 45 works, with
  the caveat that this chain is days old.
- **`getParkedMember(65)` reverted `ARRAY_RANGE_ERROR` mid-scan on T1 MatB** (2026-08-16).
  Benign: `getParkedCount` read high and the keeper drained the queue underneath the
  loop. Counted nowhere, listed under UNREADABLE. Worth one look if it ever recurs on a
  QUIET chain, where that explanation would not hold.
- **`scripts/diag_floor_halt.js` mirrors `_triageParked` line for line** (its own header
  says so) and was NOT updated for the reason codes. It models the FLOOR, not the clock,
  so its output is still correct — but it now reports "would be evicted" without saying
  *when*. Worth a column — and it models DISCOVERY only, which is the exact half-view
  that produced item 1's false premise. **It now says so in its own output**, and its
  buffer read survives the V8.49 deploy (tries `crossingBufferBps()`, falls back to the
  V8.48 constant, prints which one it read — never a literal). If it is extended, extend
  it to both gates.
- **`diag_floor_halt.js` was NOT updated for policy B's discovery change.** Its
  `_triageParked` mirror still gates the floor on `sfShare > 0`, and it still calls the
  2-arg `loanEligible`. Its POLICY B PREVIEW block computes B correctly and separately, so
  today's numbers are sound — but once V8.49 DEPLOYS, the mirror and the chain will
  disagree about self-funded members whenever the buffer is non-zero. **Fix it in the same
  session as the V8.49 deploy, or delete the mirror and read the chain.**
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
- **A fixture can encode a coincidence as an intention, and nothing local reveals it**
  (2026-08-16). `V8_48_SplitGrace.test.js` asserted eviction "keeps the FULL window" —
  true and meaningful when eviction and rescue shared one clock, and silently a statement
  about the wrong clock once they did not. It reads correct in isolation, passes in
  isolation, and only the full suite exposed it. **Corollary: when a change splits one
  value into two, grep the suite for assertions about the OLD value before running —
  three of the four breakages this session were exactly that, and only one had been
  predicted.**
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
