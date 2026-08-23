---

# ⬛ SESSION 13 STATE — 2026-08-20, LATEST. READ THIS BEFORE SESSION 12.

Measurement only. **No contract file touched, nothing deployed, no chain written to.** Five
new read-only diagnostics. Everything below is live V8.48, blocks 45430468..~45741800.

## 13.1 ⛔⛔ THE COHORT ROW 12.7 DEMANDED — AND THE CONFOUND POINTED THE OTHER WAY

12.7 said the owner's A/B/C decision must not be taken until the bigfill wallets were
separated from organic members. **That row now exists. The confound was real and it was
BACKWARDS from what 12.6 feared.**

| | ORGANIC (real members) | BIGFILL (owner-funded) | LEADER (roster) |
|---|---|---|---|
| MatB hop attempts | 369 | 453 | 137 |
| RE-ENTERED | 83 | 8 | 85 |
| **cleared %** | **22.49%** | **1.77%** | 62.04% |
| borrowed | **$727.63** | $712.33 | $71.38 |
| repaid | **91.88%** | 99.82% | 100.00% |
| borrowers | 113 | 170 | 21 |

**ORGANIC IS THE LARGER HALF OF THE LOAN BOOK AND CLEARS THE HOP TWELVE TIMES BETTER THAN
BIGFILL.** 12.6 worried the 95.78% headline was the owner repaying the owner. It was not:
the owner-funded population was dragging the headline DOWN. Bigfill clears at 1.77% because
since 2026-08-19 it registers one fresh wallet per run with no referral income — it is the
fixture floor showing up live, exactly as 12.1's fixture predicted.

**The LEADER column is not evidence of anything.** The 41 roster addresses are bigfill's
round-robin sponsors, so every bigfill registration pays them L1. They clear at 62% because
bigfill feeds them. Do not spend that number in either direction.

## 13.2 HOW THE COHORT WAS ESTABLISHED — KEY DERIVATION, NOT RESEMBLANCE

12.7 proposed identifying bigfill by "round-robin leader sponsor, lifetime withdrawn $0.00,
reserve exactly $5.00". **All three are properties a real member can also have, so all three
can misclassify — and misclassifying a bigfill wallet as organic is the direction that
FLATTERS.** Instead `diag_forward_hop_cohort.js` re-derives the wallets from `FILL_MNEMONIC`
at `m/44'/60'/0'/0/i`, the same derivation `bigfill_v8.js` uses to create them. Exact test,
not a similarity test. Verified in a sandbox first: `deriveChild(i)` off the account node
gives byte-identical addresses to the full-path form.

**THREE LEAKS WERE HUNTED AND ALL THREE ARE CLOSED:**
1. **Short index window** — re-ran at COHORT_MAX 1200 and 2400. Identical output, highest
   index seen 296. The window was never leaking.
2. **A second phrase** — only `FILL_MNEMONIC` exists in `.env`. `organic_drip.js`,
   `community_drip.js`, `slow_drip.js` and `fill_t2.js` all read it; `community_sim.js`
   reads `MNEMONIC`, which is unset, so it cannot have populated anything.
3. **The VPS keeper** — `stress_keeper.js:22` reads `process.env.FILL_MNEMONIC` and derives
   `m/44'/60'/0'/0/${index}`: **the same phrase on the same path**, so its wallets were
   already inside BIGFILL. Owner confirmed independently: "the stress and the bigfill uses
   the same thing, we just run one or the other." **No VPS `.env` read was needed.**

## 13.3 ⛔ "ORGANIC" IS NOT AUTOMATICALLY "HUMAN" — AND THE DISAGREEMENT WAS THE FINDING

The first run classified **152 addresses as organic while BUGS.md holds 13**. A community of
dozens cannot be 152, so ORGANIC meant "everything the classifier could not name". Chasing it
produced the strongest evidence of the session, in `diag_who_are_they.js`, which runs the
same fingerprint over TWO CONTROL GROUPS (BIGFILL = known machine, NAMED = known human)
because a fingerprint run only on the subject tells whichever story you went in wanting:

| | BIGFILL | NAMED | UNIDENTIFIED |
|---|---|---|---|
| distinct sponsors | 38 | 8 | **70** |
| sponsored by a roster leader | **100.0%** | 36.4% | **16.1%** |
| biggest single sponsor's share | 17.0% | 36.4% | **4.9%** |

**A round-robin script produces 100% roster sponsorship. 70 distinct sponsors with no sponsor
above 4.9% is a referral tree spreading through people.** Combined with 13.2's three closed
leaks and six alternative derivation paths coming back clean, the 143 are real members.

## 13.4 ⛔ THE LOAN IS CREDIT, NOT PLUMBING — AND MY GUESS WAS WRONG

Borrowed and repaid match to the cent across most organic wallets, which looked like the SF
fronting a shortfall inside one atomic flow and taking it straight back. **Measured: 0 of 239
organic loans clear in their own transaction. 0 clear in the same block.** Median time to
zero debt: **13.5 hours organic, 40.5 hours bigfill**. These are real balances carried across
cycles. Option B carries genuine risk that has to be priced, and the "bookkeeping change"
reading is dead.

**42 of 239 organic loans (17.6%) never reached zero**, against 2 of 182 for bigfill.

⚠ **INSTRUMENT LIMIT, CARRY IT FORWARD:** loans are not tracked individually. "Cleared" means
the member's debt returned to zero at some point after that loan. At ~2.1 loans per borrower
one zero event can close several loans, so the 42 never-cleared count is solid but the median
time is smeared.

## 13.5 ⛔⛔ THE OWNER'S BAR, MEASURED FOR THE FIRST TIME — AND IT FAILS BOTH HALVES

The bar is *"give members at least two full cycles but not at the expense of an unpaid loan."*
That is a COMPARISON, and nobody had run it. ORGANIC members only:

| | BORROWED | NEVER BORROWED |
|---|---|---|
| members | 113 | 41 |
| clear rate | 14.6% | 43.1% |
| cycles per member | 0.35 | 1.07 |
| **reached 2+ cycles** | **8 (7.1%)** | 13 (31.7%) |

⚠ **SELECTION, NOT CAUSATION — STATE IT EVERY TIME THIS TABLE IS QUOTED.** You borrow BECAUSE
you were short, so borrowers were the weaker population before the loan touched them. This
CANNOT show the loan harmed anyone. What it shows without confound is that lending as
currently priced does not deliver the two-cycle bar, and that 42 loans went unpaid.

**THE NEAR-EXPERIMENT NOBODY HAS RUN:** every co-pay borrower was PARKED WITH A SHORTFALL at
the moment of the loan — and so were the members who SELF-RESCUED with their own money, and
so were the ones who STAYED PARKED. Same starting condition, three outcomes, and the keeper
picks co-pay recipients by walking a queue rather than by merit. That is as close to random
assignment as this chain offers and it would separate "the loan did not help" from "these
members were already sinking."

## 13.6 THE OWNER'S FIVE RULES (2026-08-20) AND WHERE EACH ONE LANDED

Owner set these while calling for a conclusion: (1) members need loans but not at the expense
of the ecosystem; (2) find the number where 100% of loans are repayable; (3) no loan if
earnings cannot cover it; (4) 2-3 recruits or coupon-sponsored recruits make you
self-sustaining; (5) possibly enforce pay-it-forward in code for coupon members.

* **RULE 3 IS ALREADY IMPLEMENTED AND LIVE.** `payCoRescue` (StabilityFund:686) requires
  `loanEligibleFor(member, tier, advance)`, which caps total debt at
  `tierEntryFees[tier] * insolvencyFloorBps / 10_000`. The comment at StabilityFund:781
  states the intent in the owner's own words: *"expected per-cycle earnings ~= tier fee x
  insolvencyFloorBps."* **Live on V8.48 at 3400 bps = $3.40 at T1.**
* **RULE 2 HAS NO ANSWER IN THAT PARAMETER.** Peak debt does not predict repayment — CLEAN is
  94.7% in the $4-5 band but 76.0% at $1-2 and 0% at $2-3. No dose-response, so tuning the cap
  does not sort good loans from bad. The tightest setting tested avoids $43.79 of bad debt by
  refusing 103 of 113 members and withholding $382.85 of lending. That is not a gate.
* **RULE 2's REAL ANSWER IS ONE DIRECT REFERRAL.** Repayment by directs held AT LOAN TIME:
  **0 directs 67.2% (67 members), 1 direct 92.6% (27 members), 2 directs 93.3% (15).** The
  cliff is 0 -> 1; 1 -> 2 adds nothing measurable. The 100% buckets are 2, 1 and 1 members —
  **100% of two people is not a policy** and must not be quoted as the threshold.
* **RULE 4 IS SUPPORTED, BY A DIFFERENT MECHANISM THAN EXPECTED.** Recruiting barely improves
  REPAYMENT past the first direct; what it improves is CYCLING — 2+ cycles reached by 3.5%,
  10.8%, 27.8% at 0, 1, 2 directs. Two different mechanisms; keep them separate in member copy.
* **RULES 3-gate AND 5 BOTH NEED A COUNTER THAT DOES NOT EXIST.** TierRouter:216 stores only
  `memberReferrer` (child -> sponsor). Nothing counts a downline. Needs
  `mapping(address => uint32) public directCount;` incremented where `memberReferrer` is
  assigned (TierRouter:762 register, :813 coupon). New mapping, no existing struct touched —
  but `coPayRescue` reads only `withdrawable` and `crossingReserve`, so the gate needs the
  count passed in or read through the router, **and that call has to be paid for in gas at a
  point already near the block ceiling. Size and gas both need measuring before it is promised.**

## 13.7 ⛔ PARAM 59 — THE QUEUED 5000 WAS DECIDED BEFORE THIS EVIDENCE EXISTED

Session 10 item 1 records the owner choosing **5000** on 2026-08-19, landed in source. Live
V8.48 runs **3400** because nothing has been deployed since — **this is NOT source/chain
drift, and a mid-session claim that it was drift was wrong and is corrected here.**

But note what the queued change does: **it raises the T1 debt cap from $3.40 to $5.00, 47%
more exposure per member.** It was chosen on the eviction curve (floor evictions 7/6/5 ->
0/0/0; evicted-never-lent-to 9 -> 3) — a member-protective rationale, and a real one. 13.4
and 13.5 supply the other side of that trade, which did not exist on 2026-08-19: more lending
means more unpaid debt, and **organic members still carrying debt average 0.04 cycles against
0.43 for those who cleared.** An unpaid loan does not merely go unpaid — the floor then caps
the member out of borrowing again, so they stop cycling entirely. **25 organic members, ~16%
of the organic population, are in that state now.** Direction of causation is not established
(they may carry debt because they stopped, not stop because they carry debt) but the standing
population is a fact. **The 5000 decision is the owner's and stands; it should be re-confirmed
against this section before V8.50 deploys, not silently.**

## 13.8 ⚠ THREE INSTRUMENT DEFECTS PAID FOR THIS SESSION — TWO CAUGHT, ONE SHIPPED

1. **THE CONTROL GROUP EARNED ITS KEEP.** The USDC funding panel read **14% for BIGFILL**, a
   group we KNOW is owner-funded. That is not a fact about bigfill — the scan window starts at
   the V8.48 deploy block while those wallets were funded on the same mock USDC long before.
   Without a known-machine control, "most bigfill wallets are self-funded" would have been
   reported as a finding. **Section B of `diag_who_are_they.js` is void; do not quote it.**
2. **TWO OF MY THREE HYPOTHESES WERE WRONG AND THE INSTRUMENTS CAUGHT BOTH.** "The loan is
   plumbing" — refuted, 0% same-transaction. "The registration bursts are one sponsor
   onboarding their team" — refuted, 21 of 25 bursts have mixed sponsors. The sampled bursts
   sit within ~3h of deployment, so a launch-day rush is the likely reading, **UNVERIFIED and
   marked as such.** The population conclusion rests on 13.3's sponsor tree, not on this.
3. **A DEFECT THAT SHIPPED — `diag_insolvency_floor.js` MIXES TIERS.** The ceiling is PER
   TIER ($3.40 at T1, $8.50 at T2) but tables 1 and 2 bucket raw dollars and apply the T1 cap
   to everyone, so the ">$5.00" band is largely T2 members sitting INSIDE their own cap rather
   than members who exceeded one. **Both floor tables are weaker than they look and neither
   should be used to set the parameter.** Fix: express peak debt as bps-of-own-tier-fee before
   bucketing. The 13.6 conclusion does not rest on them — it rests on the directs analysis,
   which has no tier-mixing problem — but a floor change does and must not be made until this
   is re-run. Also: 3400 was not among the hardcoded candidates, so the `<- CURRENT` marker
   never printed.

## 13.9 NEXT, IN ORDER

1. **THE PARKED NEAR-EXPERIMENT (13.5).** Co-pay-rescued vs self-rescued vs never-rescued,
   all measured from the same parked-with-shortfall starting state. This is the one comparison
   that can separate selection from causation and it decides whether lending helps at all.
2. **RE-RUN THE FLOOR ANALYSIS IN BPS-OF-OWN-TIER-FEE** (13.8 item 3) before any floor change,
   and re-confirm PARAM 59's 5000 against 13.7.
3. **UNVERIFIED PROPOSAL, NOT MEASURED — first loan free, second needs a direct.** Allow the
   first loan at 0 directs so every member gets their shot at a cycle, require 1+ direct for a
   second. 0-direct members took 135 loans across 67 members (~2 each) with 22 still owing, so
   the exposure is concentrated in repeat lending. **This is an idea, not a finding — it needs
   a per-loan-sequence run before anyone builds it.**
4. **THEN the carried backlog**, still untouched: open one of the 5 unexplained cycle-outs
   (tx hashes in `diag_forward_hop_cohort.js` output, all 5 organic); fix
   `V8_50_ReferralBreakeven.test.js` v4 to count `MemberReentered`; stale-nonce retry backoff;
   @bevmawire's Dashboard retry; `maxItemsPerUpkeep` against 15; member-callable re-entry.

## 13.10 TOOLS BUILT THIS SESSION — all read-only, all default to `deployed_addresses_v8_48.json`

* `diag_forward_hop_cohort.js` — the hop split bigfill/leader/organic by key derivation, with
  the organic column split again into NAMED vs UNIDENTIFIED. Hard-exits if `FILL_MNEMONIC` is
  absent, warns if the HD window is saturated, and reconciles every cohort sum against the
  ungrouped total with a visible ✅/⛔ per line.
* `diag_who_are_they.js` — alternative derivation paths, USDC funding shape (**section B void,
  see 13.8**), registration bursts, sponsor spread. Two control groups.
* `diag_loan_lifetime.js` — burst composition, same-tx vs days-outstanding, borrowers vs
  non-borrowers on cycles, outstanding debt by cohort and age.
* `diag_referral_threshold.js` — directs vs repayment, lifetime AND at-loan-time, plus what a
  1/2/3-direct gate would have refused.
* `diag_insolvency_floor.js` — peak debt vs repayment, candidate bps replay, dead-end check.
  **Carries the tier-mixing defect in 13.8 item 3.**
