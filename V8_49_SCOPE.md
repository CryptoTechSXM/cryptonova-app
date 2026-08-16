# V8.49 SCOPE — opened 2026-08-13, the evening V8.48 went live

Audience: a future session of Claude, plus the owner. Nobody else touches this code.
Read `V8_48_HANDOFF.md` first for the V8.48 deployed state; this file is what comes NEXT.

---

## ITEM 1 — SEPARATE THE EVICTION CLOCK FROM THE RESCUE CLOCK ✅ BUILT 2026-08-16

> ## ⚠️ THIS ITEM WAS OPENED ON A FALSE PREMISE. READ THIS BOX BEFORE THE ANALYSIS BELOW.
>
> **Everything below this box that says V8.48 evicts real members 24 hours after they
> park is WRONG.** It was written from `MatrixKeeperLib`'s evict branch alone, which
> gates **discovery**. Execution has always had its own independent gate:
>
> ```solidity
> // MatrixKeeper._doEvictParked
> if (!ghost) {
>     if (mat.rotationCount() == 0) return;
>     if (block.timestamp - mat.parkedAt(member) < extendedIdleTimeout) return;  // 7 DAYS
> }
> ```
>
> `extendedIdleTimeout` is **7 days** and `deploy_v8.js` never sets it, so 7 days is what
> has always shipped. A member could be QUEUED for eviction from 24h and never evicted —
> the work item was consumed and `_doEvictParked` returned silently.
> **No member was ever exposed to a 24-hour eviction, in any version. The owner's
> "not before 3-5 days" policy was already met, at 7 days.**
>
> **WHAT WAS GENUINELY BROKEN:** two unrelated knobs governed one behaviour. Neither
> `parkedGracePeriod` (the SF *rescue* clock) nor `extendedIdleTimeout` (the idle-*slot
> reclaim* clock, borrowed by V8.46 "mirroring `_doReclaimSlot`") means "eviction". So
> eviction timing could not be read off any single value, could not be voted on, and
> would move if either unrelated knob moved. And for six of those seven days discovery
> emitted `WORK_EVICT_PARKED` items that execution refused — burning slots out of
> `maxItemsPerUpkeep` (15) against a queue of 88 parked members.
>
> **HOW IT WAS FOUND:** by reading `_doEvictParked` while starting policy B — i.e. by the
> standing "verify the premise before implementing" rule, one item too late. It was not
> found by running anything, and it could not have been: **every test in the suite drove
> `checkUpkeep` only.** Discovery was covered, execution was not, so a disagreement
> between the two could not fail anything. `V8_49_EvictionClock.test.js` EC-8 is that
> missing test and it exists now.
>
> **THE LESSON, WORTH MORE THAN THE FIX:** a clock in this system is TWO gates —
> discovery decides what is queued, execution decides what actually happens. Reading one
> and reporting it as the behaviour is how this scope got written. **Before believing any
> statement of the form "X happens after N", find both gates.**

**Owner policy, stated 2026-08-13 (deploy day), verbatim in substance:**
> "The SF always grows organically, eviction should not happen for 3 to 5 days.
> We do not seed SF, it grows organically. 24hrs of registrations before automated
> rescue kicks in on testnet and 48hrs on mainnet — that is by design, to have
> members rescue themselves before SF takes over."

**VERIFIED AGAINST THE CODE THE SAME DAY. Two of the three hold; one does not.**

| policy | code | verdict |
|---|---|---|
| SF grows organically, never seeded | no seeding anywhere in the deploy path; SF fills from `receiveLayer` fee splits | ✅ holds — and a deploy-day proposal to seed it was WRONG and was withdrawn |
| rescue waits 24h (testnet) / 48h (mainnet) | `parkedGracePeriod` = 86,400s, set by `deploy_v8.js`; mainnet is a config change to 172,800s, not code | ✅ holds |
| **eviction not for 3–5 days** | ~~`MatrixKeeperLib.sol:458-461` — the evict branch gates on `cfg.parkedGracePeriod`, THE SAME 24h CLOCK~~ **HALF-READ, see the box above.** That is DISCOVERY. Execution gated on `extendedIdleTimeout` = **7 days**, so the policy was met — by a knob named for something else. | ⚠️ **MET, BUT BY ACCIDENT** — corrected 2026-08-16 |

The code at `MatrixKeeperLib.sol:455-461`:
```solidity
// EVICTION KEEPS THE FULL GRACE PERIOD. Eviction removes a member who has already
// taken out most of what they earned; there is no "costs the fund nothing"
// version of it, and nothing about it is urgent.
if (evict) {
    if (age < cfg.parkedGracePeriod) return (address(0), type(uint8).max);
    return (parkedMember, WORK_EVICT_PARKED);
}
```
"The FULL grace period" means the full **24 hours** — the comment is about not giving
eviction the *shortened* self-funded path from item 12. It was never 3–5 days.

### Why this is newly urgent in V8.48 specifically

**Evictions have NEVER FIRED, in any version.** `evict_parked.js`'s cron guard
(`pgrep -f evict_loop.sh`) always matched its own parent shell, so the script never
ran once. V8.48 moved eviction ON CHAIN (item 47's two-branch valve) AND the keeper
EOA is now authorized (see the V8.48 deploy-day trap). ~~**V8.48 will therefore produce
the first real evictions in the system's history — on a 24-hour clock the owner does
not intend.**~~

**CORRECTED 2026-08-16 — the first half is right, the second is not.** V8.48 will indeed
produce the first real evictions in the system's history. They fire at **7 days**, not
24 hours, because `_doEvictParked` gates on `extendedIdleTimeout`. See the box at the top
of this item. The urgency was real; the deadline was not.

### Who is actually exposed (from `_triageParked`, MatrixKeeperLib.sol:358-403)

`evict = true` in four cases:
1. **GHOST** — already seated in either half of the pair. The valve DEQUEUES ONLY;
   nobody loses a seat. Harmless, and item 45 is meant to drive this to zero.
2. `withdrawRatio > rescueRatioBps` — has taken out most of what they earned.
3. `sfBps == type(uint256).max` — off the bottom of the rescue ladder, too thin.
4. **Item 46 insolvency floor** — `!loanEligible(member, tier)`, i.e. debt already
   >= 34% of the tier fee. Self-funded members (`sfShare == 0`) are never floored.
   ⚠️ **CORRECTED 2026-08-15 (item 1b, finding (i)): "never floored" is true at
   DISCOVERY only. A self-funded member is still advanced the flat 36% crossing buffer
   and still has it booked as debt, and the SF-side floor check DOES see them — which
   is finding (ii)'s keeper-halt path. Read item 1b before relying on this line.**

Cases 2–4 evict a REAL member. None of them can trigger on a chain that is hours old —
debt and withdrawal history take days to accumulate — which is why this is a V8.49
item and not a hotfix. **The exposure grows every day the network runs.**

### The fix

Add a governed `evictionGracePeriod` (suggest default **4 days = 345,600s**, DAO param,
enumerated and capped like `selfFundedGracePeriod`), thread it through `ScanCfg`, and
use it in the evict branch:
```solidity
if (evict) {
    if (age < cfg.evictionGracePeriod) return (address(0), type(uint8).max);
    return (parkedMember, WORK_EVICT_PARKED);
}
```
Points to settle when building it:
- **Should GHOST dequeue wait at all?** A ghost holds a queue slot it can never use and
  a dequeue costs the member nothing. Argument for keeping ghosts on the SHORT clock
  (or no clock) and giving only cases 2–4 the long one. **Owner decision.**
- Mainnet parity: `parkedGracePeriod` 48h and `evictionGracePeriod` 3–5 days must be
  set at mainnet deploy, not left at testnet defaults. Add both to `predeploy_check.js`
  as declared-default assertions so they cannot silently ship wrong.
- Do NOT try to solve this by raising `parkedGracePeriod` via governance: one knob
  drives both clocks, so it would push SF rescue out to 3–5 days and break the 24h
  design. That is exactly why a second param is needed.

### ✅ BUILT 2026-08-16 — 584 PASSING (was 575), 0 FAILING, predeploy 131/131

**Item 1 is DONE — and it is NOT what the build plan described**, because of the false
premise corrected in the box at the top of this item. What shipped:

**`evictionGracePeriod` is the ONLY eviction clock, read by BOTH discovery and
execution, default 7 days.** 7 days is exactly what `extendedIdleTimeout` was already
enforcing, so **this change moves nobody's eviction** — it is member-neutral by
construction. The policy became *reachable* (a DAO vote to 3/4/5 days) rather than
enacted. Owner decision 2026-08-16, choosing that over the 4-day default the plan
assumed, precisely because 4 days would have SHORTENED members' real window from 7.

| file | change |
|---|---|
| `contracts/MatrixKeeperLib.sol` | `_triageParked` returns `uint8 evictReason` instead of `bool evict`, with `EVICT_NONE/GHOST/RATIO/LADDER/FLOOR`; `ScanCfg` gains `evictionGracePeriod`; the evict branch picks `parkedGracePeriod` for ghosts and `evictionGracePeriod` for the three real cases |
| `contracts/MatrixKeeper.sol` | `evictionGracePeriod = 7 days`; enumerated `setEvictionGracePeriod`; wired into `ScanCfg`; **`_doEvictParked` re-gated from `extendedIdleTimeout` onto `evictionGracePeriod` — this is the reconciliation, and the actual fix** |
| `contracts/V8Governance.sol` | `PARAM_MK_EVICTION_GRACE = 62` at **all five** sites |
| `contracts/test/MockKeeperScan.sol` | `setRotationCount` — **execution was untestable from the mock harness without it**, which is why the split went unnoticed |
| `scripts/predeploy_check.js` | six regions, incl. a mechanical assertion that `_doEvictParked` reads `evictionGracePeriod` and NOT `extendedIdleTimeout` |
| `test/V8_49_EvictionClock.test.js` | **NEW, 9 tests** (EC-1 … EC-9) |
| `test/V8_48_GhostFloor.test.js` | `setEvictionGracePeriod(PARKED_GRACE)` in the discovery `setup()` |
| `test/V8_48_KeeperScan.test.js` | `setEvictionGracePeriod(0)` pin + header |
| `test/V8_48_SplitGrace.test.js` | one test extended — the breakage nobody predicted |

**`extendedIdleTimeout` goes back to meaning only idle-slot reclaim.** Do not re-couple
them "to keep them in step": reclaiming an idle SEAT is not evicting a PARKED member, and
a DAO vote on one must not move the other. That coupling *was* the defect.

**THE STACK HELD.** `_checkParked` compiled first try. `bool` → `uint8` really is the
same one slot, and the gate is computed in a ternary inside the branch rather than as a
new local — worth keeping that shape if this function is ever touched again.

**ONE DEVIATION FROM THE PLAN, AND IT IS LOAD-BEARING: `0` IS ON THE SETTER MENU.**
The plan suggested `86400 / 172800 / 259200 / 345600 / 432000 / 604800`. But
`V8_48_KeeperScan.test.js` pins `setParkedGracePeriod(0)` on BOTH keepers, so without 0
the two clocks cannot be made equal there and the frozen-keeper equivalence harness
cannot be repaired at all. Shipped menu: **`0 / 1d / 2d / 3d / 4d / 5d / 7d`**. Note what
0 means — evict the instant triage says so, the same admin/testing override
`parkedGracePeriod`'s 0 is. It is **not** an "eviction off" switch; it is the opposite.

### ⚠️ THE PLAN NAMED TWO BREAKING FIXTURES. THERE WERE FOUR.

The two it named (`V8_48_GhostFloor`, `V8_48_KeeperScan`) broke exactly as described. Two
more did not appear until they were run:

**3. `scripts/predeploy_check.js:1254`** asserted the evict branch gates on
`cfg.parkedGracePeriod` — the very thing item 1 changes. Restated as what it always
*meant*: the evict branch must not read `selfFundedGracePeriod`. Found by reading, before
running anything.

**4. `scripts/predeploy_check.js:424`** asserted `PARAM_MAX_ID = PARAM_MK_CROSSING_BUFFER`
as a literal string, so param 62 failed it. **Third time this exact anti-pattern has been
hit** (`V8_48_GhostFloor`'s GF-G1 hit it when param 60 landed and its comment says so).
Replaced with a value comparison that parses the param constants and asserts
`MAX_ID >= 61` — param 63 will not break it. **If a fourth site pins MAX_ID literally,
fix it the same way rather than bumping it.**

**5. `test/V8_48_SplitGrace.test.js` — the one worth remembering.** Its test
*"EVICTION keeps the full window even when the member is self-funded"* went red. Nothing
about it was wrong: it was written when eviction and rescue shared one clock, so "the
full window" meant 24h — but its actual subject was item 12's *short* window. **It had
encoded a coincidence as an intention, and nobody chose to do that.** Repaired by
EXTENDING it, not by pinning a clock: it now walks all three windows in order — nothing
at 5 minutes (item 12, unchanged), nothing at 24 hours (V8.49's addition), EVICT at 4
days — and asserts the shipping default rather than setting its own. Stronger than
before. **The lesson generalises: only running everything finds this class, because the
fixture reads correct in isolation.**

### WHAT THE NEW TESTS PIN, AND WHICH ONE MATTERS MOST

**EC-8 is the one that would have caught the original defect** — it drives
`performUpkeep`, not `checkUpkeep`, and asserts that discovery queueing an eviction and
execution accepting it are the SAME answer at every instant. Before it, **every test in
the suite drove discovery only**, which is precisely why two clocks could disagree for
six days and nothing went red. EC-9 pins the ghost bypass on the execution side (it skips
the rotation check too, which a non-ghost cannot survive). Adding these required
`setRotationCount` on `MockMatrixK`: `_doEvictParked` returns early when
`rotationCount == 0`, and the mock had no setter, so **the execution path was literally
unreachable from any mock test.** An untestable path is where this class of bug lives.

EC-1 the three real cases wait 7 days AND produce **no work at all** in between (asserted
as an empty list, not as "not EVICT" — they must not be quietly rescued either; those
days are the member's, to self-rescue) · EC-2 a ghost is still dequeued at 24h **while a
real eviction in the same batch waits** · EC-3 ordinary rescue untouched · **EC-4 the
COLLAPSE PROPERTY** · EC-5 keeper require ↔ DAO menu, both directions · EC-6 the default
and 86400 and 0 are all on the menu · EC-7 setter gated.

**EC-4 is the one to protect.** `V8_48_KeeperScan` pins `evictionGracePeriod ==
parkedGracePeriod` in `setup()` so its byte-identical comparison against the frozen
pre-refactor keeper still holds. That pin is only honest if the collapse is real. Without
EC-4 the pin could go on masking a genuine divergence and the harness would stay green.
**Read that file's pins as a list of deliberate behaviour changes — item 12's split
grace, now item 1's eviction clock. A pin added to make a failure go away rather than to
hold a known deliberate change is the point at which that file stops being evidence.**

### STILL OPEN AFTER ITEM 1

- **Item 1b's policy-B half has NOT shipped.** The scope says the two halves ship
  together and the reason still holds — B alone refuses a thin member's loan while the
  24h clock evicts them the next day. **Item 1 has now removed that objection**: the
  eviction clock is now a single governed knob at 7 days, so B can be built without it
  being worse for that member than today — a refused member has a week to self-rescue. **B is the next thing.** See "RECOMMENDATION — ship B TOGETHER WITH item 1's
  eviction clock" below; with the buffer at 0 and one governed eviction clock at 7 days,
  both preconditions it names are now met.
- **`scripts/diag_floor_halt.js` mirrors `_triageParked` line for line** (its own header
  says so) and has NOT been updated for the reason codes. It models the FLOOR, not the
  clock, so its output is still correct — but it now reports "would be evicted" without
  saying *when*. Worth a column — and note it models DISCOVERY only, which is the exact
  half-view that produced this item's false premise.
- **`deploy_v8.js` never sets `evictionGracePeriod`.** Correct by accident of the default
  being 7 days, which satisfies the "not before 3-5 days" floor on both networks.
  `predeploy_check.js` now says so out loud rather than leaving it silent — the `selfFundedGracePeriod` situation two lines
  above it in that file is what happens when nobody does.

### 🔧 BUILD PLAN — written 2026-08-15, BUILT 2026-08-16 (kept as the record of what was decided and why)

**Read this before touching `MatrixKeeperLib`. The obvious implementation breaks two
existing test fixtures in ways that look like the change is wrong.**

**1. `_triageParked` must return a REASON CODE, not a bool.** It currently returns
`(uint256 sfShare, bool evict)`, so by the time `_checkParked` applies a clock, a
harmless GHOST and an insolvent member are indistinguishable — and the whole point is
to clock them differently. Use `uint8`, NOT an extra return value: that function's own
comments (MatrixKeeperLib.sol:447-450) record that adding the evict branch already blew
the stack once and had to be extracted to its own frame. `bool` → `uint8` is the same
one slot, so it costs nothing:
```solidity
uint8 constant EVICT_NONE = 0;  // rescue
uint8 constant EVICT_GHOST = 1; // seated in either half — dequeue only, harms nobody
uint8 constant EVICT_RATIO = 2; // withdrawRatio > rescueRatioBps
uint8 constant EVICT_LADDER = 3;// off the bottom of the rescue ladder
uint8 constant EVICT_FLOOR = 4; // item 46 insolvency floor
```
Then in `_checkParked`:
```solidity
if (reason != EVICT_NONE) {
    uint256 gate = reason == EVICT_GHOST ? cfg.parkedGracePeriod : cfg.evictionGracePeriod;
    if (age < gate) return (address(0), type(uint8).max);
    return (parkedMember, WORK_EVICT_PARKED);
}
```

**2. THE GHOST CLOCK — decided 2026-08-15, and deliberately the CONSERVATIVE option.**
The scope above left this open. **Ghosts KEEP today's `parkedGracePeriod`; only cases
2–4 get the new longer clock.** Reasoning: this changes ghost behaviour not at all,
so the new param introduces exactly ONE behavioural difference to reason about
(real evictions get slower) instead of two. A ghost dequeue costs the member nothing
and giving it a shorter-than-today clock is a separate, optional improvement — and
item 45 is already driving ghosts toward zero (**measured 2026-08-15: 0 ghosts among
52 parked**, against 16 persistent ones on the old chain). One line to change if the
owner disagrees.

**3. `evictionGracePeriod`: new `MatrixKeeper` state var, default `4 days` (345_600),**
threaded through `ScanCfg` (add after `selfFundedGracePeriod`, and wire it in the
struct literal at MatrixKeeper.sol ~:418 — a field wired to the wrong neighbour
compiles clean and only changes WHEN the keeper acts, which is the exact mutation
`V8_48_KeeperScan` exists to catch). Enumerated setter; **put 86_400 on the menu** so
the clock can be collapsed back to today's 24h behaviour, and the default on the menu
too (item-42 lesson). Suggested: `86400 / 172800 / 259200 / 345600 / 432000 / 604800`.

**4. Governance: `PARAM_MK_EVICTION_GRACE = 62`** — all five sites, same as param 61:
constant, interface entry, `_allowedValues`, `_applyParam` branch, `PARAM_MAX_ID`.

**5. ⚠️ TWO EXISTING FIXTURES WILL BREAK — this is the part that eats a session if you
meet it by surprise:**
- **`V8_48_GhostFloor.test.js`** sets `PARKED_GRACE = 24h` and asserts
  `WORK_EVICT_PARKED` after `time.increase(PARKED_GRACE + 5)` (around :417, :428, :437).
  The GHOST case (GF-D3) still passes by design. The ratio/ladder/floor cases will NOT —
  they now need the 4-day clock. Fix by setting `evictionGracePeriod` explicitly in that
  fixture's `setup()`, not by weakening the assertions.
- **`V8_48_KeeperScan.test.js`** proves byte-identical `performData` against the frozen
  pre-refactor keeper. A new clock is a REAL behavioural divergence. Same remedy the
  file already uses for item 12's split grace (see its header): pin
  `evictionGracePeriod == parkedGracePeriod` in `setup()` so the comparison stays
  honest, and say so in the header — the harness proves the 12a EXTRACTION was
  behaviour-preserving, not that no later item ever changed behaviour.

**6. `predeploy_check.js`:** assert the declared default is 345_600 AND that
`deploy_v8.js` sets both grace periods for mainnet (`parkedGracePeriod` 172_800 and
`evictionGracePeriod` 3–5 days) — the scope above already calls for this and it is the
only thing standing between testnet defaults and a mainnet deploy.

**7. New test file `V8_49_EvictionClock.test.js`:** a member past 24h but under 4 days
is NOT evicted for ratio/ladder/floor; the same member IS at 4 days; a ghost is still
evicted at the parked clock; the governance menu matches the setter both directions;
setting `evictionGracePeriod == parkedGracePeriod` reproduces pre-V8.49 behaviour
exactly (the collapse property — it is what keeps the KeeperScan harness meaningful).

### Until V8.49 DEPLOYS — the interim position (owner chose: fix properly, watch daily)

**Still live, because the fix is built but NOT DEPLOYED.** V8.48 is what is on chain and
it evicts real members on the 24h clock. Watch for the first eviction ever recorded:
`MemberEvicted` / `GhostDequeued` events, `diag_ghost_parked.js`, and the keeper log. If
evictions start hitting real members before V8.49 deploys, the emergency lever is
**PARAM 59 → `insolvencyFloorBps = 0`**, which disables case 4 only (cases 2 and 3
remain, and are pre-V8.48 behaviour).

**No eviction had been observed as of the last check (0 of 88 parked).** That is the
whole reason there was time to build this properly instead of hotfixing it.

---

---

## ITEM 1b — THE INSOLVENCY FLOOR DOES NOT CAP DEBT (owner found it 2026-08-15)

**Owner's observation:** "saw a loan size of $5.40 which would be outside the loan
parameters — if the member is unable to cover the loan they should not be given the
loan." Then, when the numbers did not add up: *"explain how a member with one loan can
owe $5.40 when they have a $5.00 reserve. Something is missing in those numbers."*

**Both instincts were right. There are TWO separate defects here.**

### Defect 1 — the floor is tested BEFORE the loan and never includes it

`StabilityFund.sol:799` —
```solidity
function loanEligible(address member, uint8 tierIdx) public view returns (bool) {
    ...
    return memberDebt[member] < fee * insolvencyFloorBps / 10_000;   // T1: $10 x 34% = $3.40
}
```
Enforced at `payCoRescue` (line 649) and `payForceCross` (line 679) — both as a bare
`require(loanEligible(...))` with the **new loan amount never added**. So the floor caps
the debt you may *start* a loan from, not the debt you end with. Every borrower finishes
above the floor by up to a full advance. The contract's own doc comment claims it
"refuses a new loan when memberDebt >= fee x this / 10000" — an intent the code does not
implement.

### Defect 2 — THE DEBT IS BIGGER THAN THE SHORTFALL (this is what broke the arithmetic)

`MatrixLogicLib.sol:1379`, in `forceCrossKeeper`:
```solidity
uint256 totalLoan = sfContribution + crossingBuffer;
IStabilityFund(self.stabilityFund).increaseMemberDebt(member, cfg.tierIndex, totalLoan);
```
The booked debt is the entry-fee shortfall **plus a crossing buffer** — extra USDC seeded
into the member's `withdrawable` so they will have accumulated the re-entry fee by the
time they reach MatA root. **`crossingBuffer` is a PARAMETER supplied by the keeper**
(`FigureEightMatrixV8.sol:561`), not derived on chain.

That resolves the owner's arithmetic — the shortfall alone cannot produce a $5.20 loan.
`coPayRescue` (line 1423) books `shortfall` only, so the oversized loans are the
**forceCrossKeeper** path. **The exact decomposition is below; an earlier draft of this
item guessed "$5.00 shortfall + ~$0.20 buffer" and that guess was wrong in both terms.**

---

### ✅ THE OPEN QUESTION IS ANSWERED (read 2026-08-15, in the contracts, not inferred)

> *Where does the keeper compute `crossingBuffer`, and what bounds it?*

**Computed at `MatrixKeeper.sol:568`, inside `_doParkedRescue`:**
```solidity
crossingBuffer = fee * CROSSING_BUFFER_BPS / 10_000;   // MatrixKeeper.sol:568
uint256 public constant CROSSING_BUFFER_BPS = 3_600;   // MatrixKeeper.sol:97
```

**It is a FLAT 36% OF THE TIER ENTRY FEE. Nothing about the member enters it** — not
their debt, not their earnings, not their shortfall, not their tier history. Every
`forceCrossKeeper` rescue at T1 advances **exactly $3.60**, and books it as debt.

The derivation is in the comment block at `MatrixKeeper.sol:83-97`: after a rescue the
member needs 50% of the fee from `withdrawable` to cross again, already has 5% direct
earn plus a net 9% pool cycle, so 50 − 5 − 9 = **36%**.

**What bounds it — one thing only, and it is not a policy bound:**

| candidate bound | reality |
|---|---|
| a cap relative to the member's debt or the floor | **none anywhere** |
| a `require` on the matrix side | **none.** `MatrixLogicLib.forceCrossKeeper` (line 1345) requires only `sfContribution <= cfg.entryFee`. `crossingBuffer` has **no require at all** — the matrix accepts whatever it is handed |
| a governance param | **no.** `CROSSING_BUFFER_BPS` is `public constant` — changing it needs a **redeploy**, not a DAO vote |
| SF liquidity | **yes, the only one.** `MatrixKeeper.sol:578-581` trims the buffer to whatever is left after `sfShare`, down to 0, when the fund cannot cover both |

So the buffer is deterministic keeper-contract arithmetic, not keeper-operator input —
but it is a hardcoded constant that **no live lever can move**.

**The exact decomposition of the observed $5.20** (T1 fee $10.00):
`sfShare $1.60 + buffer $3.60 = $5.20`. The buffer is the DOMINANT term, not a rounding
tail. It also explains the rest of the measured spread: median $4.25 = $0.65 + $3.60
(shortfall in the measured range, median $0.83); min $0.33 is below the buffer alone, so
those are either `coPayRescue` (no buffer) or early loans issued while the young SF could
not fund the buffer and line 579 trimmed it.

**The real ceiling is not $5.20.** Under the live default ladder (preset 1, bottom rung
4_000 → 6_000 bps) the largest T1 shortfall the fund will cover is $6.00, so a single
T1 rescue can book **$9.60 = 2.8× the $3.40 floor**. $5.20 is the worst case seen in
two days, not the worst case available.

### ⛔ THREE THINGS THE READ TURNED UP THAT ARE WORSE THAN THE ORIGINAL DEFECT

**(i) THE BUFFER IS ADVANCED TO SELF-FUNDED MEMBERS TOO — item 12's "costs the fund
nothing" is not true.** `_triageParked` (MatrixKeeperLib.sol:400) skips the floor check
when `sfShare == 0`, and this scope's item 1 repeats that as "self-funded members are
never floored". But `_doParkedRescue` computes the buffer **unconditionally** — it is
outside every branch on `sfShare`. A member whose own reserve + withdrawable covers the
whole fee still receives $3.60 of SF money and still has $3.60 booked against them
(`totalLoan = sfContribution + crossingBuffer`, MatrixLogicLib.sol:1379). They are not
floored because they borrow nothing — except they do borrow, $3.60 of it. **This is a
debt-loop driver in its own right and belongs in the parked-loop reasoning.**

**(ii) A LIVE KEEPER-HALT RISK IN V8.48, ON CHAIN RIGHT NOW.** Combine (i) with the
revert allowlist at `MatrixKeeper.sol:469-478`: `"SF: insolvency floor"` is **not** on
the swallow list, so it hits `revert(reason)` and **the entire `performUpkeep` batch
reverts** — velocity, chain-links, evictions, CW epoch, everything. Reachable today: a
member who already owes ≥ $3.40 and has since earned enough to be self-funded passes
discovery (no floor check, `sfShare == 0`), then `payForceCross` is still called because
`totalSfNeeded = 0 + $3.60 > 0`, and the SF refuses. Discovery and the SF disagree
exactly as the comment at `MatrixKeeper.sol:584-587` warns, and the designed response to
that disagreement is to stop the keeper. **Measured cover: 29 of 37 borrowers are already
over the floor; 0 of the 49 currently parked are self-funded, which is why it has not
fired yet.** Watch for a keeper that goes quiet, not just for eviction events.

**(iii) THE BUFFER FORMULA IS DERIVED FROM A CONSTANT THAT NO LONGER EXISTS.**
`MatrixKeeper.sol:64-68` declares `RESCUE_REPAY_BPS = 5_000` and says it "must match
MatrixLogicLib.RESCUE_REPAY_BPS" — but `MatrixLogicLib.sol:200` records that constant was
**removed in V8.32**, and V8.47 replaced it again with the **banded clawback**
(`StabilityFund.clawbackBpsByBand = [9000, 8000, 7000, 6000]`, T1–T3 → **60%**, DAO-
tunable). Redo the 36% derivation at the live 60% rate: net pool cycle is 18% × 40% =
7.2%, so the buffer *should* be 50 − 5 − 7.2 = **37.8%**. The constant is stale by 180
bps, and any future clawback vote silently invalidates it again with no way to correct
it short of a redeploy. **Whatever V8.49 does with the floor, `CROSSING_BUFFER_BPS`
should stop being a constant and start being derived from `clawbackBpsFor` — or at
minimum become a governed param with the derivation documented at the setter.**

### ✅ BUILT 2026-08-15 — 575 PASSING (was 565), 0 FAILING, COMPILE CLEAN

**The contract half of item 1b is DONE.** Not yet committed/pushed at the time of
writing — contracts repo branch is **`v8.1`** (the admin→preview→main ladder is the
FRONTEND repo only).

| file | change |
|---|---|
| `contracts/MatrixKeeper.sol` | `CROSSING_BUFFER_BPS` constant **removed**; `crossingBufferBps` state var **default 0**; `setCrossingBufferBps` enumerated 0/900/1800/2700/3600 + `ConfigUpdated`; call site (was :568) reads the param; the stale `RESCUE_REPAY_BPS` block marked historical with the V8.32/V8.47 trail |
| `contracts/V8Governance.sol` | `PARAM_MK_CROSSING_BUFFER = 61` + interface entry + `_allowedValues` + `_applyParam` branch + `PARAM_MAX_ID` advanced — **all five**, because item 26 shipped three of them and "DAO tunable" was fiction until it was caught |
| `scripts/predeploy_check.js` | fails if the constant returns, if the declared default is not 0, if the setter is missing, or if the keeper `require` and the governance menu disagree |
| `test/V8_49_CrossingBuffer.test.js` | **NEW, 10 tests** (CB-1 … CB-10) |

**Two judgement calls, recorded so they are not re-litigated blind:**

1. **The `crossingBuffer` ARGUMENT STAYS in `forceCrossKeeper`'s signature.** Cutting it
   would ripple through `FigureEightMatrixV8`, `MatrixLogicLib`, the keeper interface,
   the mocks and **`MatrixKeeperPrev.sol`** — the frozen pre-refactor copy that
   `V8_48_KeeperScan` compares against for byte-identical `performData`. Keeping the
   plumbing made this a one-line arithmetic change and left that equivalence harness
   valid. The buffer is dead AT THE SOURCE (bps 0), not at the boundary. **The boundary
   is still unbounded** — `MatrixLogicLib:1345` requires nothing of `crossingBuffer` —
   which is acceptable only because the sole caller is the keeper contract computing
   from an enumerated param. If that ever stops being true, add the require.
2. **CB-10 asserts `buffer < floor`, NOT `buffer == 0`.** That is the invariant that
   actually has to hold. A test pinned to zero would pass while someone dials the buffer
   to 3_600 and silently re-arms the original defect. At the current floor (3_400),
   2_700 is safe and 3_600 is not — and CB-10 is what says so.

**STILL OPEN — the honest gap, also written into the test file's header:** there is NO
end-to-end assertion that a real keeper rescue books `shortfall` and nothing more. That
needs a live-matrix parked fixture (V8Elevator scale). **The arithmetic change itself
rests on the live measurement above, not on a test.** Closing it: extend
`V8_48_GhostFloor.test.js`'s mock harness to run `_doParkedRescue`, not just discovery.

**Two test-authoring facts worth not rediscovering:**
- **`MatrixKeeper` is a LINKED contract since V8.48 item 12a.** `getContractFactory`
  needs `{ libraries: { MatrixKeeperLib } }` or it throws "missing links" before any
  test body runs. `V8_48_KeeperScan` and `V8_48_GhostFloor` show the pattern;
  `V8Governance` and `StabilityFund` are NOT linked, which is what misled the first draft.
- **ethers v6 `Interface.getFunction()` RETURNS NULL for an unknown name** — it does not
  throw (verified against ethers 6.17). A `try/catch` around it never fires. The first
  CB-2 assumed a throw and reported the removed constant as still present. Same family
  as this project's fabricated-fallback bugs: a null read as a value.

### ✅ OWNER DECISION 2026-08-15 — REMOVE THE CROSSING BUFFER

> *"I think we should remove the buffer as it does not match our model."*

**Agreed, and the live measurement is a stronger argument than the reasoning was.**
Build as **`crossingBufferBps`, a governed param, DEFAULT 0** — behaviourally identical
to deleting it, but reversible without a redeploy if the parked queue balloons (the one
real counter-risk, below). Enumerated menu like every other DAO param
(0 / 900 / 1800 / 2700 / 3600), new PARAM id, `predeploy_check.js` assertion that the
declared default is 0.

**MEASURED ON THE LIVE QUEUE (`scripts/diag_floor_halt.js`, 2026-08-15, 52 parked,
all with $0.00 debt — this is a two-day-old chain and nobody has borrowed yet):**

| | with buffer | with `crossingBufferBps = 0` |
|---|---|---|
| advance per rescue | $4.01 – $5.32 | **$0.41 – $1.72** (the real shortfall) |
| queue of 52 costs | **$232.29** | **$45.09** |
| of that, buffer | **$187.20 = 80% of the ask** | $0 |
| SF `totalBalance` $100.84 covers | **21 of 52**, then graceful skip | **all 52, $55.75 left over** |
| loans before policy B refuses | **0** (first advance already over the $3.40 floor) | **3** (avg shortfall $0.87) |

**RE-MEASURED ~4.6h LATER THE SAME DAY (block 45526605 → 45534929) — and it found a
THIRD argument neither the reasoning nor the first measurement had:**

| | 1st read | +4.6h | note |
|---|---|---|---|
| parked | 52 | **88** | +69% in under five hours; a visible registration burst (11 at age ~0.0h) is part of it |
| SF totalBalance | $100.84 | $230.08 | organic growth is healthy — the fund is NOT the problem |
| pending ask (with buffer) | $232.29 | $566.43 | |
| buffer share of the ask | 80% | 74% | |
| **rescues the fund can complete** | **21 of 52** | **48 of 88** | |
| **…with `crossingBufferBps = 0`** | **all 52** | **all 88, $88.45 left** | |
| avg real shortfall | $0.87 | $1.61 | |
| loans before policy B refuses | 3 | 2 | |

**⛔ THE BUFFER IS A THROUGHPUT LIMIT, NOT JUST A DEBT INFLATOR.** The keeper trims the
buffer as the fund drains (MatrixKeeper.sol:578-581) and then skips the rest gracefully
— so the SF spends its capacity on BUFFERS for the first 48 members instead of on
RESCUES for all 88. **Forty parked members wait who would not have to.** At bps 0 the
same dollars clear the entire queue with a third left over. This speaks directly to the
owner's standing product view that the queue must visibly DRAIN rather than churn: part
of why it does not drain is that every rescue costs ~3× what it needs to.

**And the "3 loans" caveat proved itself within four hours** — the average shortfall
moved $0.87 → $1.61 and the count moved 3 → 2. It is queue-dependent, exactly as
written. Do not hard-code it.

**Baseline logging now live** (`logs/parked_baseline.csv`, one row per
`diag_floor_halt.js` run, appended). One row as of 2026-08-15. **The growth RATE is
still not established** — 4.6h with a registration burst in it is not a rate, and the
old chain's "+125/day" is not comparable. Two runs several hours apart will print it.

**Read the last row of the table above honestly: 3, not the 2 in the owner's worked
example (at the FIRST reading; it was 2 by the second).** The example
assumed a $1.60 shortfall; the live queue averages **$0.87**, because members are
reaching the crossing better funded than the example supposed. Three loans total $2.61
and the fourth is refused — still inside the floor's own stated intent ("expected
per-cycle earnings", ≈ $1.80/journey of pool at T1), so the mechanism behaves as
designed. The model is confirmed directionally; the count is queue-dependent and will
move. **Do not hard-code "two loans" anywhere — it is an emergent number, not a rule.**

**Three consequences, in order of importance:**

1. **The floor becomes the rule it was designed to be.** The owner's model — "$5.00
   reserve + earnings ⇒ ~$1.60 shortfall, two loans then refused" — is exactly what the
   live shortfalls show ($0.41–$1.72, centred on $1.60). Policy B then reads
   $1.60 → $3.20 → refused on the third. **Policy B is unshippable WITH the buffer and
   correct WITHOUT it.** The two changes are one change.
2. **Finding (ii)'s keeper-halt path stops existing.** For a self-funded member
   `sfShare == 0`, so with no buffer `totalSfNeeded == 0`, the
   `if (totalSfNeeded > 0)` guard at MatrixKeeper.sol:588 is false, `payForceCross` is
   never called, and there is no floor check to revert on. No swallow-list entry needed
   for `"SF: insolvency floor"` on this path. **(Add it anyway as belt-and-braces —
   `payCoRescue` can still raise it.)**
3. **The Stability Fund is not actually short — the buffer is what makes it short.**
   $187 of the $232 pending ask is buffer. The fund looked insolvent against its own
   queue because of a mechanism that exists to prevent re-parking.

**THE COUNTER-ARGUMENT, ON THE RECORD (this is what to watch after the change).** The
buffer's purpose is real: it seeds enough `withdrawable` that a rescued member can cross
again after ~1 journey instead of parking immediately. Removed, a rescued member is
re-seated with $0 withdrawable and must earn the full 50% from scratch, so **parks will
become MORE FREQUENT**. Worked through at T1 (pool ≈ $1.80/journey, 60% T1–T3 clawback):
with buffer they cross in ~2 journeys carrying ~$3.04 of residual debt; without, ~4
journeys carrying $0. The trade is accepted because each park then costs the fund ~$1.60
instead of ~$5.00, and **the clawback on the inflated debt was itself consuming the
earnings the member needed to avoid the next park** — which is precisely the spiral
`diag_parked_growth.js` measured on 2026-08-13. **Watch the parked count and the park
RATE after the change; the owner's standing product view is that the queue must visibly
drain, not just churn.** If it balloons, dial `crossingBufferBps` up — that is what the
param is for.

**Ripple when building:** `MatrixKeeper` (the constant → param + setter + menu),
`MatrixKeeperLib` interface, `MatrixLogicLib.forceCrossKeeper` (the arg stays; it is
still the SF's pre-transfer), `FigureEightMatrixV8:561`, the mocks, and the V8.48
tests that pin buffer arithmetic. **Also fix `MatrixKeeper.sol:64-68` in the same
commit** — `RESCUE_REPAY_BPS = 5_000` there claims to mirror a MatrixLogicLib constant
deleted in V8.32, and it is the input to the 36% derivation being retired.

### WHAT THIS MEANS FOR THE FIX — POLICY B AS WRITTEN BELOW DOES NOT WORK
### (superseded in practice by the buffer removal above — kept because it is WHY)

The buffer (**3_600 bps**) is LARGER than the insolvency floor (**3_400 bps**). So
`memberDebt + totalAdvance <= fee * insolvencyFloorBps / 10_000` fails for a member with
**zero debt and zero shortfall**: 0 + $3.60 > $3.40. **Policy B applied at
`payForceCross` with the buffer included refuses 100% of forceCross rescues at T1, and
routes every one of them to eviction.** That is not a tuning accident — the two
mechanisms contradict each other by construction: the floor says "never owe more than
34% of a tier fee", the rescue path advances 36% of the tier fee to everyone it touches
before any shortfall is added.

Three ways out, to decide when building (all need the ladder + buffer numbers above):
- **raise the floor above the buffer** — `insolvencyFloorBps` must exceed 3_600 plus
  headroom for the shortfall; PARAM 59 already reaches it with no deploy, but it weakens
  the floor everywhere else;
- **shrink or condition the buffer** — e.g. skip it entirely when `sfShare == 0` (fixes
  (i) and (ii) as a side effect), or scale it by remaining debt capacity;
- **floor the SHORTFALL, cap the BUFFER separately** — two rules for two different
  advances, which is what they actually are.

**Whichever is chosen, `_triageParked` must change in the SAME commit as
`payCoRescue`/`payForceCross`,** and the `sfShare == 0` guard at MatrixKeeperLib.sol:400
must go, or every disagreement between discovery and the SF halts the whole keeper batch
per (ii). Adding `"SF: insolvency floor"` to the allowlist at MatrixKeeper.sol:471-473 is
the cheap belt-and-braces and should ship regardless.

**One correction to Defect 2's own wording, now that the source is read:** the buffer is
NOT "a PARAMETER supplied by the keeper" in the sense of operator input — it is computed
by the MatrixKeeper CONTRACT from a constant. It is unbounded at the matrix boundary
(any value would be accepted), but in practice only the keeper contract can pass it,
because `forceCrossKeeper` is gated on `msg.sender == _state.matrixKeeper`.

### MEASURED, 2026-08-15 (`scripts/model_insolvency_floor.js`, all values read from chain)

| measurement | value |
|---|---|
| floor threshold, T1 | **$3.40** (fee $10.00 x 3400 bps) |
| loan events / unique borrowers | **55 / 55 — every borrower has exactly ONE loan.** Not accumulation. |
| loan size, T1 | min $0.33 · **median $4.25** · max **$5.20** · mean $3.80 |
| borrowers still owing | 37 of 55, **$139.62** outstanding |
| **over their own tier floor** | **29 of 37 = 78.4%**, worst $5.20 = **1.53x the floor** |
| currently parked (T1 MatB) | 49, shortfall min $0.22 · median $0.83 · max $1.72 · **0 self-funded** |
| lifetime lent / repaid | $208.81 / $69.19 = **33.1% recovery** |

**A single loan of median size already breaches the floor.** The owner's "$5.00 reserve +
$3.40 earned = $1.60 shortfall, so two loans then refused" model describes a MATURE
member; the measured borrowers were thin and early, and the crossing buffer pushed each
one over in one step.

### THE POLICY CHOICE — modelled against the live population

| policy | granted | refused | SF out | max debt after |
|---|---|---|---|---|
| A CURRENT (pre-loan check) | 49 | 0 | $41.72 | $1.72 |
| B STRICT (post-loan check) | 49 | 0 | $41.72 | $1.72 |
| C PARTIAL (clamp to floor) | 49 | 0 | $41.72 | $1.72 |

**All three are IDENTICAL on today's queue** — current shortfalls (max $1.72) sit far
below the $3.40 floor, so nothing is refused either way. There is no emergency and no
forced decision this week. The divergence is historical: median past loan $4.25 > $3.40,
so **more than half of every rescue that has ever happened would have been refused under
B**.

**C (partial) should probably be DROPPED as unimplementable.** If the SF funds $3.40 of a
$5.20 need, the entry fee is not covered, the member is not seated, and the keeper cannot
complete the rescue. C degrades into "self-rescue with a subsidy", which requires the
member to act anyway.

### RECOMMENDATION — ship B TOGETHER WITH item 1's eviction clock, never alone

⚠️ **AMENDED 2026-08-15 after the crossingBuffer read — see "WHAT THIS MEANS FOR THE FIX"
above. B in the form written here is NOT shippable as-is: the buffer (36% of fee) exceeds
the floor (34% of fee), so including it in `totalAdvance` refuses every forceCross rescue
at T1, including for members with zero debt. B needs a buffer decision made with it.**

`memberDebt[member] + totalAdvance <= fee * insolvencyFloorBps / 10_000`, where
`totalAdvance` includes the crossing buffer (defect 2), applied at both `payCoRescue` and
`payForceCross` — **and with `_triageParked` changed in the same commit** so discovery and
the lender cannot disagree and halt the keeper.

**Good news for the implementation:** both SF entry points already RECEIVE the full
advance. `payForceCross(member, tierIdx, sourceMatrix, fee)` is called with
`fee = totalSfNeeded = sfShare + crossingBuffer` (MatrixKeeper.sol:571, 588), and
`payCoRescue`'s `sfShare` is the whole shortfall. So the amount the check needs is
already in scope at both `require(loanEligible(...))` sites — StabilityFund.sol:649 and
:679. No new plumbing, no signature change. The blocker is the policy contradiction
above, not the code shape.

**The two halves are one change.** B alone refuses a thin member's loan and the current
24h eviction clock removes them the next day — worse for that member than today's
behaviour. Item 1's 3-5 day window alone leaves the floor unenforced. Together they are
the owner's stated policy: do not lend what one cycle cannot repay, and give the member
days, not hours, to self-rescue first.

**Interim lever needing no deploy:** PARAM 59 sets `insolvencyFloorBps`. Raising it does
NOT fix the structural gap (the check still excludes the new loan) but does move where
the overshoot lands. 0 disables the floor entirely.

### ✅ BUILT 2026-08-16 — POLICY B SHIPPED. 594 PASSING, 0 FAILING, PREDEPLOY 142/142

Commit `40d7843` on `v8.1`. **Owner decision: STRICT B — one rule, first loan or not.**

| file | change |
|---|---|
| `contracts/StabilityFund.sol` | `loanHeadroom(member, tier)` is the ONLY copy of the arithmetic; `loanEligibleFor(member, tier, advance)` (policy B) and `loanEligible(member, tier)` both derive from it. Both require sites pass the amount they are about to lend |
| `contracts/MatrixKeeperLib.sol` | `_triageParked` asks `loanEligibleFor` with `sfShare + fee * cfg.crossingBufferBps / 10_000`; guard moved from `sfShare > 0` to `advance > 0`; ratio maths block-scoped for stack room; `ScanCfg.crossingBufferBps` added |
| `contracts/MatrixKeeper.sol` | populates `crossingBufferBps` in the snapshot; `performUpkeep` swallow-list gains `"SF: insolvency floor"` AND `"SF: below floor"` |
| `contracts/MatrixV8Interfaces.sol` | `loanEligibleFor` + `loanHeadroom` declared for the matrix/frontend side |
| `contracts/test/MockKeeperScan.sol` | `MockStabilityFundK` gained a REAL floor (bps/fee/debt) — a boolean mock answers identically for a $0.01 loan and a $6.00 one, which is the very thing B fixes. Defaults inert (bps 0), so every existing fixture is unchanged. `payForceCross` now actually refuses |
| `test/V8_49_InsolvencyFloor.test.js` | **NEW, 10 tests** (IF-1 … IF-10) |
| `scripts/predeploy_check.js` | **15 new gates** — every regex verified to resolve against the real sources before shipping (a gate that cannot find its target reports nothing, not a failure) |
| `scripts/diag_loan_history.js` | **NEW** — answers "first loan or rescued before?" from the event log |

**THREE DECISIONS RECORDED SO THEY ARE NOT RE-LITIGATED BLIND:**

1. **Discovery asks about the UNTRIMMED advance** (`sfShare + buffer`). `_doParkedRescue`
   trims the buffer when the fund is short (:727-730), and a trim only ever makes the ask
   SMALLER — so discovery is never LOOSER than the lender, which is the safe direction.
   Asking about `sfShare` alone would let a vote on param 61 silently re-arm the
   batch-halt. **IF-8 is the test that fails if anyone ever simplifies it back.**
2. **The guard is on the ADVANCE, not on `sfShare`.** This structurally removes findings
   (i) and (ii) instead of relying on `crossingBufferBps` staying 0.
3. **`loanEligible` keeps its old semantics exactly** (`headroom > 0` is algebraically
   `memberDebt < ceiling`), so the frontend and diagnostics do not break — but it is
   documented as NO LONGER the enforcement rule. It says "not at the ceiling yet"; it
   does not promise the next loan lands.

### ⛔ THE 2026-08-15 POLICY TABLE ABOVE IS FALSIFIED — B IS NOT INERT

The "**All three are IDENTICAL on today's queue**" row was true when written and is
**wrong now**. Re-measured 2026-08-16 (101 parked, then 104):

| | value |
|---|---|
| refused by B at `crossingBufferBps = 0` | **15 of 104** |
| of those, repeat borrowers | **15** |
| of those, refused on a FIRST loan | **0** |
| parked carrying outstanding debt | 11 |
| **parked who borrowed and REPAID IN FULL** | **9 — invisible to `memberDebt`** |
| parked growth rate (first real V8.48 figure) | **+212/day** (88 → 101 in 1.5h) |
| SF `totalBalance` / `stabilityFloor` | $294.12 / $0.00 |
| queue cost at buffer 0 vs with buffer | $202.09 vs $716.89 (buffer = 71% of the ask) |

**WHY THE EARLIER READING WAS WRONG, AND IT IS THE LESSON OF THE DAY:** an intermediate
count said "4 of the refused have never borrowed". **`memberDebt` is CURRENT
OUTSTANDING** — `applyRepayment` decrements it (:854) — so a member who borrowed $4.00
and repaid it reads **$0.00**, identical in every getter to one who never borrowed. Nine
of the parked queue are exactly that. **The owner rejected the claim on instinct**
("explain how a member can come to the point of crossing without getting at least
$3.40") and the event log settled it. `diag_loan_history.js` exists because of that
question, and it self-tests its scan against `totalRescueLoaned()` before printing any
verdict — 62 events, $228.72, matched to the cent.

**WHAT THE 15 ACTUALLY LOOK LIKE — one uniform profile, and it is the spiral:** reserve
$5.00, lifetime withdrawn **$0.00** (not one of them has ever taken money out),
`cyclesCompleted` 1, lifetime EARNED $2.32-$3.82, borrowed ONCE ($3.63-$4.94),
repaid $3.40-$4.04 — the clawback took essentially everything they earned — and they
are back at the crossing needing $3.77-$5.00. **They earn less per cycle than they need
per cycle.** That is verbatim the condition the floor was written to stop.

**AND THE MITIGATING FACT, which is why this shipped without softening:** $3.60 of each
of those first loans was the CROSSING BUFFER. Their real first shortfall was cents to
~$1.34. At `crossingBufferBps = 0` every one of them sails through loan one, and their
second ask is smaller too because the clawback takes ~$0.94 instead of ~$4.54.
**Today's 15 refusals were manufactured by the buffer this same release removes.**

### ⚠️ NEW, UNRESOLVED — THE LADDER AND THE FLOOR NOW DISAGREE ABOUT WHO IS FUNDABLE

**This is the same shape as buffer-vs-floor, one layer down, and the scope never caught
it:** it checked the BUFFER against the floor and stopped there. The SF RESCUE LADDER
also lends past the ceiling.

Derived from preset 1 (the live default) and confirmed against the measured population.
With `debt == 0`, B refuses whenever `sfShare > $3.40`, and
`sfShare = min(coverage x fee, fee - effective)`. So:

> **A member whose effective contribution (crossing reserve + withdrawable) is below
> 66% of the entry fee is refused, ZERO DEBT OR NOT.**

The boundary is exact: `wBps = 6600` gives `sfShare = $3.40` and passes; `6500` gives
$3.50 and is refused. Every one of the measured 15 sits at 50-62% — consistent.

**Consequence: the bottom rungs of preset 1 (thresholds 6500 / 6000 / 5000 / 4000, whose
coverage values are 4000 / 4500 / 5000 / 6000 bps) are DEAD under the shipping
defaults.** The ladder advertises coverage the floor forbids, and `EVICT_LADDER` and
`EVICT_FLOOR` now overlap for reasons nobody chose. Three ways out, none taken yet:

- **accept it** — those members are precisely the eviction population the owner
  described, and the rungs are simply vestigial. Cheapest, but leaves a lookup table in
  the contract that can never fire;
- **trim the ladder** so its bottom rung stops where the floor bites, making the two
  mechanisms state one policy instead of two;
- **raise `insolvencyFloorBps`** (PARAM 59, menu `0/1700/2500/3400/5000/6800/10000`) —
  6800 would make the whole ladder reachable again, at the cost of the floor no longer
  meaning "one cycle's expected earnings", which is the measurement it was derived from.

**Do not resolve this by reading. Re-run `diag_floor_halt.js` first** — the refusal count
moved 13 → 15 in the forty minutes between two runs today.

---

## ITEM 2 — THE WALLET RPC (carried from the V8.48 handoff, likely the biggest member win)

`index.html:2834` and `:2903` call `wallet_addEthereumChain` with
`rpcUrls: ['https://sepolia.base.org']` — the PUBLIC endpoint. The site's own READS go
through a healthy 5-endpoint QuickNode pool, but every member whose wallet our site
configured SENDS TRANSACTIONS through the public one. A Cloudflare 502 from it during
registration is what dumped raw HTML into an `alert()` on deploy day.

**Prime suspect for the "❌ Transaction failed on-chain — hard-refresh" report class,
the single most common member complaint in BUGS.md.** Not changed on deploy day because
it governs how every NEW member adds the network, and verifying it needs a wallet that
has never had Base Sepolia configured.

**Owner decision required with it:** a QuickNode URL placed in a member's wallet is used
for ALL their Base Sepolia activity, not just our site, burning quota the owner pays for.
Consider a dedicated endpoint kept OUT of the site's read pool, so one member cannot
degrade the dashboard for everyone.

---

## ITEM 3 — THE UN-PROPAGATED-FIX SWEEP

Three times now a defect has been fixed in one place and left live in a sibling:
items 30 and 39, the epoch `.catch(() => 1)` (fixed at :3451, still live at :6410 until
a later session caught it), and on deploy day the **post-action dashboard refresh** —
`_staggeredDashRefresh()` was written 2026-08-06 for Kira's upgrade/rescue report and
wired into 8 sites, while all three WITHDRAW paths kept the single 3.5s read the same
commit's own comment calls unreliable. Members saw a stale balance and clicked Withdraw
again. Fixed on deploy day (now 12 call sites).

**This is a pattern, not three coincidences.** Worth a dedicated session: for every
"fixed" entry in BUGS.md and the audit notes, grep for OTHER call sites of the same
defective shape and check whether the fix reached them. Deliverable: a list, then fixes.

---

## ITEM 4 — SMALLER CARRIED ITEMS

- **Raw RPC error dumped into `alert()`** — the 502 rendered a wall of raw HTML/JS in a
  browser popup during registration. Needs the honest-error treatment `doWithdraw()` got.
- **`uBal` display fabrication** — `usdc2.balanceOf(...).catch(() => 0n)` at
  `index.html:5581` shows **$0.00 USDC** if the read drops. Display-only (approve enables
  unconditionally, the contract judges), so D2 class. Deploy-day sweep result: **130
  value-returning catches remain in index.html; none found gating an action.**
- **Stale banner text in `deploy_v8.js`** — prints "V8.41 Deploy" and
  "ADDRESSES_FILE=…v8_47.json must be set". Cosmetic; reads as a live warning mid-deploy.
- **Epoch-transparency panel** — the ONLY part of the old NEXT UP #2 still open; the
  `.catch(() => 1)` half is already fixed. All four epoch getters exist on chain.
- **Item 46's dashboard surface** — "no loan — insolvency floor; self-rescue or eviction
  follows". Ships with, and is the member-facing half of, item 1 above.
- **`deploy_v8.js` does not authorize the keeper EOA** — now step 1.3c in the runbook,
  but the real fix is to do it IN the deploy script so no future deploy can miss it.

## ITEM 5 — THE EARLY-EXIT PENALTY IS NOW LIVE FOR THE FIRST TIME (member comms)

`earlyExitPenaltyBps` returned 0 on every previous deployment because
`setMemberTracker` was never called. V8.48 wired it (item 13), so the V4 ladder
(0–30d **45%**, 31–60d 30%, 61–90d 15%, 91–120d 5%, 121d+ 0%) is enforced for real —
and the redeploy resets every long-standing member to day 0, i.e. 45%. Nothing in the
deploy announcement mentions it. **Not a bug; a communications decision the owner should
make deliberately rather than let a member discover it by trying to redeem.**
