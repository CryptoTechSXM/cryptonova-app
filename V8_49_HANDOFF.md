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

**Next up: the LADDER-VS-FLOOR decision, then the V8.49 DEPLOY.** See "NEXT" below.

**NOTHING IS UNCOMMITTED IN EITHER REPO.** Contracts pushed through `492d6d5` on `v8.1`;
the frontend's item-2 refactor is pushed as `f4afff5` on `admin` (not yet promoted to
`preview`/`main` — it is comment-and-refactor only, member behaviour unchanged, so it can
ride along with the next real frontend change).

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

| | 1st (08-15) | +4.6h | 08-16 a | **08-16 b (latest)** |
|---|---|---|---|---|
| parked | 52 | 88 | 101 / 104 | **121** |
| SF totalBalance | $100.84 | $230.08 | $294.12 | **$383.02** |
| pending ask, with buffer | $232.29 | $566.43 | $716.89 | **$918.95** |
| buffer's share | 80% | 74% | 71% | **69%** |
| rescues the fund completes | 21 of 52 | 48 of 88 | 62 of 101 | **69 of 121** |
| …at `crossingBufferBps = 0` | all 52 | all 88 | all 101 | **all 121, $99.47 left** |
| halt risk / ghosts | 0 / 0 | 0 / 0 | 0 / 0 | **0 / 0** |
| **parked growth rate** | — | (burst) | +212/day | **+201/day over 3.9h** |
| **avg real shortfall** | $0.87 | $1.61 | $2.00 | **$2.34** |
| **refused by policy B at buffer 0** | — | — | 15 of 104 (14%) | **29 of 121 (24%)** |

**The fund is growing and the queue is growing faster.** SF nearly quadrupled while the
queue more than doubled; the buffer still eats 69% of every ask. Nothing here changes the
buffer decision — it strengthens it. **+201/day over 3.9h is now a RATE, not a burst** —
three baseline rows, steady.

### ⛔ THE TREND THAT MATTERS MOST — AND IT IS NOT IN ANY SINGLE READING

**Average real shortfall is climbing monotonically: $0.87 → $1.61 → $2.00 → $2.34.**
Members are arriving at the crossing progressively THINNER. Because policy B refuses when
`debt + shortfall > $3.40`, that trend drives the refusal rate directly:
**14% → 24% of the queue in a few hours.**

**Read that as a trajectory, not a level.** If the shortfall keeps climbing toward the
$3.40 ceiling, B stops being a guard on the tail and becomes the main path — it would
evict a growing majority rather than a struggling minority. **Nobody has decided that,
and nobody should discover it after deploy.** This is the single strongest argument for
settling the ladder-vs-floor question BEFORE V8.49 goes out, and for putting a watch on
this number after it does. `logs/parked_baseline.csv` has the series.

**Also new: 23 of 121 now carry debt (was 9), total $28.20 — and a cluster of them sit at
EXACTLY $1.80** with $0.00 withdrawable. $1.80 is 18% of the T1 fee. Not investigated.
Worth one look, because an exact repeated figure is usually a mechanism, not a coincidence.

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

## ✅ ALSO SHIPPED 2026-08-16 — `selfFundedGracePeriod`, AND THE REQUIREMENT WAS FICTION

Opened as "deploy never sets it, so mainnet ships 5 min instead of the declared 6h".
**The 6h was never reachable.** `setSelfFundedGracePeriod`'s menu is
`0/60/300/900/1800/3600` — **capped at ONE HOUR, deliberately**, because V8.48 item 12
redefined this value from a protection window into a **race guard** (matching
`fastlane_rescue.js`'s `MIN_AGE=300`) and said so at the setter. The "mainnet default 6h"
line was a stale **V8.25** statement that item 12 superseded and nobody deleted — and it
had been copied into **three places**: the contract declaration, `deploy_v8.js`'s comment,
and `predeploy_check.js`, which **would have hard-failed a `MAINNET=1` deploy demanding a
value no setter would accept.**

**THIS IS THE ITEM-26 CLASS IN REVERSE.** Item 26 shipped a param that claimed to be DAO
tunable and was not. This was a GATE that claimed a value was required and it was
unsettable. **When a check and a setter disagree, read the setter — it is the one the
chain enforces.**

Shipped: `deploy_v8.js` sets it **explicitly to 300** (env `SELF_GRACE_SECS`, and it
**throws before the deploy starts** on an off-menu value); the stale claim deleted and
explained in all three places; a new predeploy gate that **reads the menu out of
MatrixKeeper's own `require`** rather than restating it, so the two cannot drift.
**300s is correct on mainnet too** — the race it guards is identical on both networks.
Also corrected in the same block: it claimed `evictionGracePeriod` defaults to 4 days.
It is **7**.

`144/144` predeploy (was 142).

---

## NEXT — IN THIS ORDER, AND THE ORDER IS THE POINT

### 1. THE LADDER-VS-FLOOR DECISION — the last real choice in V8.49

Written up in full in `V8_49_SCOPE.md` item 1b, "⚠️ NEW, UNRESOLVED". In one line: **the
SF rescue ladder will lend up to 60% of the entry fee while the insolvency floor caps
debt at 34%**, so with policy B shipped, a member whose crossing reserve + withdrawable is
**below 66% of the fee is refused with ZERO debt**, and the bottom rungs of the live
ladder preset can never fire. Three options are written up (accept / trim the ladder /
raise `insolvencyFloorBps` via PARAM 59).

**WHY IT IS BEFORE THE DEPLOY AND NOT AFTER:** if the answer is "trim the ladder" or
"move the floor", that is a code or config change and it should ship IN V8.49, not as a
second deploy days later.

**RE-MEASURE FIRST — `node scripts\diag_floor_halt.js`.** Three readings on 2026-08-16
gave **13 → 15 → 29** refused. It is not a stable number and the direction is UP (see the
shortfall trend above). Do not decide who gets evicted off a stale reading. This is an
OWNER decision — an economic trade-off, not a code fact — so put the fresh numbers in
front of him with the three options and a recommendation.

**The latest reading changes the weight of the options.** At 14% of the queue this looked
like a guard on the tail; at 24% and climbing it does not. Consider seriously that the
answer may be **raise `insolvencyFloorBps`** (PARAM 59 — no redeploy, menu
`0/1700/2500/3400/5000/6800/10000`) rather than accept, because 5000 or 6800 tracks where
members actually are while leaving the mechanism intact. Against that: 3400 was MEASURED
as the ~34% median per-cycle earnings, so raising it means the floor stops meaning what it
was derived from. **That tension is the decision. Do not resolve it by reading.**

### 2. THEN DEPLOY V8.49 — and the queue is the argument for urgency

Parked is growing at **+212/day** and nothing of V8.49 is on chain. At the live buffer the
Stability Fund completes **62 of 101** rescues; at `crossingBufferBps = 0` the same $294
clears **all 101 with $92 left**. **Every day this is not deployed, the queue compounds
against a fix that is already built and tested.** Runbooks: `DEPLOY_V8_48_CARD.md`,
`GO_LIVE_RUNBOOK.md`.

### 3. CHEAP AND WORTH DOING WHILE WAITING — close the last measurement-only claim

There is still no assertion that a real rescue books **`shortfall` and nothing more**.
IF-10 now drives `performUpkeep` into `_doParkedRescue` for real, so the path is reached;
what is missing is a `forceCrossKeeper` mock that RECORDS its
`(sfContribution, crossingBuffer)` arguments so the amount can be asserted. `MockMatrixK`
stubs it today. **This is the only part of item 1b still resting on a live measurement
rather than on a test.**

### ITEM 2 (the wallet RPC) — OPEN, AND DEFERRED TO MAINNET BY OWNER DECISION

`sepolia.base.org` is still what goes into a new member's wallet, and still the prime
suspect for the "Transaction failed on-chain — hard-refresh" report class (the most
common in `BUGS.md`). **SUSPECT, NEVER MEASURED.**

**DO NOT PROPOSE FREE PUBLIC ENDPOINTS.** This session did exactly that
(`base-sepolia-rpc.publicnode.com` as primary) and **the owner overruled it from
operational history: public RPCs were tried in this site's own read pool, were buggy, and
were all removed.** That is direct experience of those endpoints on this site and it beats
any reliability claim from documentation. Recorded as OWNER-OBSERVED — an attempt to find
the written record in `BUGS.md` and the git history timed out, so do not assume a
write-up exists behind it. The options still live: a **dedicated QuickNode endpoint kept
OUT of the read pool**, or leave it to mainnet. Revisit at mainnet, not before.

**Context worth carrying:** all five QuickNode URLs, keys included, are already in
plaintext in `index.html`, which Vercel serves publicly. Anyone can scrape them today. So
"putting an endpoint in a member's wallet exposes it" is not the real trade-off — the
exposure already exists; what changes is the VOLUME of ordinary member traffic. If that
ever matters enough to fix, the repo already has an `api/` directory and `vercel.json`,
so a serverless RPC proxy is feasible. Not scoped, not started.

**A NOTE ON THE THREE-COPIES PATTERN, because it has now cost two items in two days.**
`crossingBufferBps` was a constant whose derivation cited a constant deleted in V8.32.
`selfFundedGracePeriod` carried a mainnet target its own setter forbade. Both are the same
shape: **a value's MEANING written down beside it, and the meaning changing while the
prose did not.** When you change what a value is FOR — not just what it is — grep the repo
for the old justification, not only for the identifier.

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
- **`getParkedMember()` reverting `ARRAY_RANGE_ERROR` on T1 MatB — IT HAS NOW HAPPENED
  TWICE, AND IT IS ALWAYS THE LAST INDEX.** Index 65 on one run, 66 on the next, same
  matrix `0xB83e7F9f`, both times the final index of the loop. The easy explanation is a
  race (`getParkedCount` reads high, the keeper drains the queue during the ~1-minute
  scan). **That still fits — but "always the last index, every time" also fits
  `getParkedCount()` returning one MORE than the array actually holds**, which would be a
  real off-by-one and would mean the keeper's own loops read a phantom slot too. Two
  observations is not a diagnosis. **Settle it by reading `getParkedCount` against the
  array length directly, on a quiet moment, rather than by assuming the benign branch** —
  assuming the benign branch on one observation is how item 1 got opened on a false
  premise. Counted nowhere in the diagnostic; listed under UNREADABLE.
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

- **CLAUDE'S DEVICE-BRIDGE GIT IS NOT TRUSTWORTHY IN THESE MOUNTED FOLDERS** (found
  2026-08-16). `git status` through the bridge fails with `unable to unlink
  '.git/index.lock': Operation not permitted` — the device VM cannot delete files, so git
  cannot refresh its index, and it then reports a working tree that is not the real one
  (a bridge read claimed 1,162 modified files in the frontend repo and omitted the one
  file that had actually just been edited). **The owner's PowerShell git is unaffected.**
  Rule: Claude may READ files through the bridge, but every git verdict comes from the
  owner running the command. This also means `git add -A` in that repo would be
  catastrophic on a scale nobody has measured — the existing never-use-`-A` rule is doing
  more work than it was written for.
- **A SEARCH YOU TRUNCATE CANNOT SUPPORT A NEGATIVE.** Predicting which fixtures policy B
  would break, Claude grepped for `setTierFee` and piped it through `head -30`.
  `stress_test_full.js` sorts after the `V8_*` files, fell off the end, and its absence
  was read as evidence it had no tier fee registered. It did, at line 144. It broke.
  Same family as the capped-`getLogs` bugs this project has hit twice — **a capped scan
  produces a clean, plausible, wrong answer.**

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
