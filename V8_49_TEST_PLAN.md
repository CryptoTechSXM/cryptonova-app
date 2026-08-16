# V8.49 PRIVATE TEST PLAN — owner + bigfill only, no community

Written 2026-08-16. Audience: a future session of Claude, plus the owner.
**Updated 2026-08-16 (deploy session) — read the CORRECTIONS section first; several
instructions below it are superseded.**

---

# ⛔ CORRECTIONS FROM THE DEPLOY SESSION (2026-08-16)

The plan below was written before the deploy. Running it surfaced things it could not
have known. **Where this section and the original text disagree, this section wins.**

## THE DEPLOY THAT HAPPENED

- **V8.49 deployed to Base Sepolia 2026-08-16T07:07:33Z**, addresses in
  `scripts/deployed_addresses_v8_49.json` (committed, `de27329`).
  MatrixKeeper `0x03Ff2184Afa458eE743c123bdb93D7804953F49D`,
  StabilityFund `0x9b3EbdE821DE116cF338021D0Ab46590ed066CF8`.
- **`.env` line 69 was NOT changed** and must not be. It still names
  `deployed_addresses_v8_48.json`. The deploy card's step 0.5 says to bump it; that is
  correct for a community deploy and WRONG here — bumping it repoints every live
  diagnostic at the test chain while members are still on V8.48. The private deploy is
  reached by shell override only.
- **The VPS keeper was NOT disabled and NOT repointed.** Deploy card 0.2 disables all
  keepers; that exists for nonce safety, and here it would have stalled live rescues for
  members for no reason. Verified instead (badly — see below) and left running.
- **`set_upkeep_caller.js` was NOT run on this deployment, deliberately.** The test keeper
  signs as the deployer, which `performUpkeep` accepts as `owner()` unconditionally. So
  the VPS keeper EOA has NO authority on the test chain and cannot drive it even if
  misconfigured.
- **`probe_v849_getters.js` (new) confirms V8.49 bytecode is what is on chain**:
  `crossingBufferBps = 0`, `evictionGracePeriod = 604800`, `extendedIdleTimeout = 604800`
  (decoupled), `insolvencyFloorBps = 3400`, `loanHeadroom/loanEligibleFor/loanEligible`
  all answering, and the retired V8.48 constant `CROSSING_BUFFER_BPS()` **absent from the
  runtime bytecode, with a positive control proving the scan works**. Re-run it after any
  redeploy. SF at t0 was **$0.30** (W1's own registration).

## ⚠️ `-Offset` DOES NOT ISOLATE A COHORT — THIS WOULD HAVE RUINED THE SPLIT

`bigfill_v8.js:1261-1269` builds its rescue/upgrade population as
`historicalCount = max(0, HDR_OFFSET - SCAN_FROM)` with **`SCAN_FROM` defaulting to 0**.
So a run at `-Offset 127` also sweeps wallets `0..126` and applies **its own
`SELF_RESCUE_RATE`** to them.

**Cohort B at rate 0 would have reached into cohort A and stopped it self-rescuing.** The
control would have been driven by the subject. `-Offset` separates who gets REGISTERED,
not who gets SWEPT — and the plan's "non-overlapping `-Offset` ranges" does not prevent
it. The bleed is one-directional (A at offset 0 has `historicalCount = 0`), which is
worse than symmetric: it yields a plausible confusing result rather than an obvious break.

**Fixed in `run_bigfill_rr.ps1`**: a new `-ScanFrom`, auto-pinned to `-Offset` whenever
`-SelfRescueRate` is not 1.0, and the banner now prints the SWEEP range as well as the
registration range. **Check the sweep line on every cohort launch.**

## THE COHORT RANGES CHANGED

The suggested `A = 0-126, B = 127-253` is unusable. **A private deploy is a private
DEPLOYMENT, not a private network** — V8.49 and live V8.48 share Base Sepolia, so a
wallet index is the same address, nonce and ETH balance on both. `bigfill_v8.js:44-49`
records earlier runs at `HDR_OFFSET=0..3249`, and the live run stopped 2026-08-16
03:30:44 -04:00 was working a 127-wallet range above that (its exact offset was **not
recorded** — do not assume).

| cohort | offset | count | `-SelfRescueRate` | `-ScanFrom` |
|---|---|---|---|---|
| **A — control** | 6000 | 127 | 1.0 | **6000** |
| **B — subject** | 6200 | 127 | 0 | **6200** |

The gap between 6126 and 6200 is deliberate: an off-by-one lands on an unused index
instead of the other cohort.

**`-ScanFrom` is required on BOTH, for different reasons.** On B it stops the bleed. On A
— where the auto-pin does NOT fire, because A runs at 1.0 — leaving the default would make
bigfill derive and scan 6,126 non-existent historical wallets before registering anything.

**AND: the interlock does not protect cohort A.** `run_bigfill_rr.ps1` refuses a run below
rate 1.0 that has not named its chain, but cohort A runs AT 1.0 and so is indistinguishable
from the ordinary live traffic-driver invocation, which must keep working. **For cohort A
the only protection is reading the banner.** Confirm `ADDRESSES FILE` and its `source`
line before letting it register anything.

## RUN THEM SEQUENTIALLY, B FIRST — AND NOT ONLY FOR NONCE REASONS

`FILL_FUNDER_KEY` is **not set** in `.env`, so bigfill falls back to the deployer for every
ETH send and USDC top-up (`bigfill_v8.js:961`), and the test keeper also signs as deployer.
Two bigfills plus a keeper on one nonce is a bad footing for a 20-hour run.

**The stronger reason is scientific.** Cohort A's registrations pay 3% of every entry into
the Stability Fund. Run concurrently, **A subsidises B's rescues**, and the fund-versus-
shortfall ratio — the exact quantity T1 measures — becomes an artifact of the A:B size
ratio somebody picked. Run B alone and its parked population, SF income and refusal rate
are all attributable to B. T6 only asks whether the control behaves normally on V8.49; it
does not need to be contemporaneous to answer that.

**Start the keeper AFTER B's funding phase completes.** `parkedGracePeriod` is 86400, so
nothing is eligible for SF rescue for 24h and the keeper is not needed early; bigfill's
heaviest deployer usage is its opening funding phase.

## ⚠️ T1 AS WRITTEN CLAIMS MORE THAN THE BUFFER CAN DELIVER

T1's pass condition — *"the SF covers ALL pending advances"* — is **not a property of
`crossingBufferBps`**. It is a property of SF balance versus total shortfall. On live it
held because the fund happened to sit at roughly **1.35x** the total ask. On a fresh chain
whose population is deliberately half non-self-funding, that ratio will be far worse for
reasons having nothing to do with the buffer, and **T1 would fail for the wrong reason.**

**The claim item 1b actually needs to survive, and which IS directly checkable:**
> **the buffer contributes $0 to every ask.** Every pending advance equals its member's
> shortfall exactly, with no 36%-of-fee component.

Measure that first. Then, separately, report `SF balance ÷ total pending shortfall` as a
ratio — it is the number that decides how much fund the system needs, and it is worth
knowing on its own rather than hidden inside a pass/fail.

## STILL OPEN AT THE TIME OF WRITING

- **The Stability Fund is not yet seeded.** It starts at $0.30 and fills only from 3% of
  entries. 24h of `parkedGracePeriod` buys time to decide the number — set it from the
  OBSERVED shortfall distribution, not an estimate, and **write the figure down here**,
  because "covers all pending" is meaningless without it. Use `topup_sf.js` /
  `receiveLayer(tier, amount, 5)`; `totalBalance` is the number that governs, not
  `balanceOf`.
- **T5 still has no tool.** Unchanged from the original plan below.
- **`diag_floor_halt.js` is still not updated for policy B** — its `_triageParked` mirror
  gates the floor on `sfShare > 0` and calls the 2-arg `loanEligible`. V8.49 is now
  DEPLOYED, so the mirror and the chain can disagree. T1 and T2 both read from this tool.
- **Sponsor concentration differs from live.** Only W1 is registered as a sponsor on this
  deployment, so all 127 cohort-B members take W1 as referrer, where live spreads across
  41 leaders. Member-side economics are identical (they receive L1 from nobody, which is
  the no-referral profile), but do not compare refusal rates across the two chains without
  accounting for it.
- **The deployer nonce was never actually verified quiet before the deploy.**
  `check_nonce.js` was run as `node scripts\check_nonce.js` with no `--network`, so hardhat
  used its in-memory chain and reported Hardhat account #0's nonce three times. Both it and
  `whoami.js` now refuse on the in-memory chain. The deploy completed with no nonce error,
  so the question is moot for this deploy — but it was not answered.
- **`whoami.js`'s header comment is stale**: it says the testnet deployer is 7702-delegated
  to the MetaMask stateless delegator. It now reports `clean EOA (no delegation)`.

---

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
