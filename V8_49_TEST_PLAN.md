# V8.49 PRIVATE TEST PLAN — owner + bigfill only, no community

Written 2026-08-16. Audience: a future session of Claude, plus the owner.

## WHY THIS EXISTS, IN THE OWNER'S WORDS

> *"we do 8.49 but only me, you and bigfill to do the measurements. once we are satisfied
> we scope, build and deploy v8.50 then bring in the community — as too many deploys, I
> cannot have them just 2 days ago on v8.47, now on v8.48, tomorrow v8.49 and the day
> after v8.50."*

**Every version is a FRESH DEPLOYMENT that members must re-register into.** A deploy is
not free engineering hygiene — it spends community trust, and four in four days spends
all of it. Claude's original recommendation (deploy V8.49, measure, then V8.50) was
priced as though deploys were cheap. **The owner's plan is better and it is the one being
followed**: get the measurement without spending the trust.

**So V8.49 IS the experiment, not the release. V8.50 is the release.**

---

## THE ONE THING THAT WOULD MAKE THIS TEST MEANINGLESS

`BIGFILL_RULES.md` sets **`SELF_RESCUE_RATE = 1.0`** — *"every parked wallet self-rescues
(pays own shortfall, no debt)"*.

**That is exactly the behaviour V8.49 changes.** If every wallet pays its own way:
nobody stays parked, nobody accrues debt, `loanEligibleFor` never refuses anyone, the
eviction clock never runs, and the batch-halt path is never approached. **You would deploy
V8.49 and measure nothing, and the run would look like a pass.**

### REQUIRED: a SPLIT COHORT

| cohort | `-SelfRescueRate` | what it is for |
|---|---|---|
| **A — control** | `1.0` | healthy members who fund themselves. Proves V8.49 did not break the normal path |
| **B — the subject** | `0` | members who CANNOT self-fund. This is the only cohort that exercises the insolvency floor, the eviction clock, the ladder-vs-floor gap and the swallow-list |

Run them from **non-overlapping `-Offset` ranges** so the two populations stay separable
in every later query (BIP-44 index is the only thing distinguishing them on chain — write
the ranges down here when the run happens, because nothing else records them).

Suggested first run: A = `-Offset 0 -Count 127 -SelfRescueRate 1.0`,
B = `-Offset 127 -Count 127 -SelfRescueRate 0`. Keep `-UpgradeRate 0.75` on both so the
tier ladder still moves.

---

## KEEPING THE COMMUNITY OFF IT

- **Do NOT run `update_addrs_v8_49.py` (or equivalent) against the frontend.** The site
  keeps serving the V8.48 addresses; members see no change at all. This is the whole
  mechanism that makes a private deploy private.
- Use **`ADDRESSES_FILE=deployed_addresses_v8_49.json`** as an ENV OVERRIDE rather than
  editing the committed defaults. `predeploy_check.js` asserts every script defaults to
  the same file, and today that is `deployed_addresses_v8_48.json` — changing the
  committed default would repoint the live V8.48 diagnostics at the test chain, and the
  V8.48 chain is still the one members are on.
- The VPS keeper: decide DELIBERATELY whether it drives the test chain, the live chain,
  or both, and write the answer down. A keeper pointed at the wrong addresses is the
  quietest possible way to corrupt both datasets.

---

## WHAT THIS TEST MUST BE ABLE TO DISPROVE

A test that cannot fail is a look, not a test. Each of these has a stated pass condition.

### T1 — the crossing buffer actually clears the queue
**PASS:** with `crossingBufferBps = 0`, the SF covers **ALL** pending advances, not most.
**Measured on V8.48 for comparison:** at the live buffer the fund completed 69 of 121; at
0 the same $383 covered all 121 with $99 left. If the test chain does not reproduce
"covers all pending", the buffer was not the constraint and item 1b's central claim is
wrong.
**Tool:** `node scripts\diag_floor_halt.js`.

### T2 — policy B refuses the population we predict, and the rate STABILISES
**PASS:** refusals land on cohort B and the refusal rate flattens.
**FAIL — and this is the one to watch:** the rate keeps climbing. On V8.48 it went
**14% → 24% in a few hours**, driven by average shortfall climbing
**$0.87 → $1.61 → $2.00 → $2.34**. If that trend continues on V8.49, policy B is not a
guard on the tail — it becomes the main path, and it would evict a growing majority.
**Nobody has decided that. It must not be discovered after the community is on it.**
**Tool:** `diag_floor_halt.js` (the POLICY B PREVIEW block) run repeatedly, plus
`logs/parked_baseline.csv` for the series.

### T3 — the ladder-vs-floor gap is real on chain
**PREDICTED:** members whose crossing reserve + withdrawable is **below 66% of the entry
fee** are refused **with ZERO debt**, because the rescue ladder lends up to 60% of the fee
against a 34% ceiling. Derived, never observed.
**PASS:** the refused set contains zero-debt members at 50–65% effective contribution.
**FAIL:** it does not — in which case the derivation is wrong and should be re-read
before anything is built on it.
**Tool:** `node scripts\diag_loan_history.js` (it separates first-loan from repeat).

### T4 — the keeper batch NEVER halts
**PASS:** `WorkItemFailed` events appear (members skipped) and `performUpkeep` never
reverts. This is the belt-and-braces swallow-list doing its job.
**FAIL:** any reverted `performUpkeep`. That means discovery and the lender disagreed
about an AMOUNT, which is the failure IF-8 exists to prevent, and it takes the whole
batch — velocity, chain-links, evictions, the CW epoch.

### T5 — shallow seating: is the $0.25 member real?
`_lowestFreeSlot` scans from position **1 upward**, so a slot freed by `reclaimIdleSlot`
is filled BEFORE seat 127. A member seated shallow inherits the tail of someone else's
journey: at seat 2 they collect **$0.25** — the direct earn on their own entry — against a
full $10 fee, then reach the crossing ~$4.75 short and are refused by the floor.
**PASS (the good outcome):** `WORK_RECLAIM` rarely or never frees a slot below ~seat 50,
so the class is theoretical.
**FAIL:** it happens regularly, which means members are being **seated into a position
that mathematically cannot earn enough**, and V8.50 must fix the seating, not the floor.
**Tool:** none exists. Needs a small script: count `SlotReclaimed` events by position, and
the seat position of each subsequent entry.

### T6 — the control cohort is unharmed
**PASS:** cohort A behaves exactly as on V8.48 — self-rescues, upgrades, no evictions.
V8.49 is meant to be strictly tighter only where a loan is involved; cohort A takes no
loans and should be untouched.

---

## WHAT WE ALREADY KNOW, SO NOBODY RE-DERIVES IT

- **The parked queue is arithmetic, not behaviour.** Crossing charges the FULL fee
  (`_crossToPartner`: `reentryFee = destination.ENTRY_FEE()`), reserve first then
  withdrawable — so a member needs **50% of the fee from earnings at every crossing**. A
  member with no referrals earns **34% per journey** (250 direct + 1800 pool + 1350 chain).
  **50 needed, 34 earned: 16% short at every crossing, forever.** The suite already names
  this population — *"the 84% member — the live median"* (50 + 34).
- **`+201/day` is bigfill's registration rate, not organic growth.** Every profiled member
  had `lifetime withdrawn $0.00` (bigfill does not withdraw), reserve exactly $5.00, and
  round-robin leader sponsors — so they receive L1 from nobody and pay it to a leader,
  which IS the no-referral profile. **Treat the growth rate as a DIAL, not a market
  signal.** Claude presented it as urgency once; that was wrong.
- **`memberDebt` is CURRENT OUTSTANDING, not lifetime.** A member who borrowed and repaid
  reads `$0.00`. Use `diag_loan_history.js` (event-sourced, self-tests against
  `totalRescueLoaned`) for any claim about history.

---

## WHAT THIS TEST FEEDS

Its output decides three things in `V8_50_SCOPE.md`:

1. whether the **crossing redesign** delivers what the arithmetic says it should;
2. the **ladder-vs-floor calibration** — deliberately DEFERRED out of V8.49, because the
   crossing redesign moves the entire shortfall distribution and deciding it now would be
   deciding it twice, the second time against stale numbers;
3. whether **seating** (T5) needs fixing at all.
