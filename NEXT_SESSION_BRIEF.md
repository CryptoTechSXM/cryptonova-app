# NEXT SESSION BRIEF — V8.50, branch `v8.1`
Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`. Written at the end of session 12,
2026-08-20. Paste this in as the opening message of the next session.

Read `V8_50_HANDOFF.md`, newest first: **section 12.1 → 12.7** (session 12), then 11.1–11.5
with the withdrawal banners in them, then section 7a THE TWO RULES, then SESSION 10 below.

## THE TWO RULES — these govern everything
1. Do not hypothesise unless necessary.
2. Measure and test before implementing. Never build on a hypothesis.

When two numbers disagree, the disagreement IS the finding — measure it, do not explain it.
A number you have not run is not a result. One sample is not a measurement.

## ⛔ START HERE — WHERE SESSION 12 LEFT THINGS
Contracts `v8.1`; frontend `admin` = `preview` = `main` at `74a1588`, untouched since
session 10. **NOTHING DEPLOYED. NO CHAIN WRITTEN TO. NO CONTRACT FILE TOUCHED.** Owner
instruction still in force: *"we are not changing code yet just discussing until we come to
a conclusion."* Session 12 was measurement only: one new test file, one new read-only
script, handoff section 12. Clean apart from the three known `.bak` files (session 9
leftovers; house pattern is `archive/`, not delete).

## ⛔ THE ONE THING SESSION 12 PROVED, AND IT UNDOES A LOT OF SESSION 11
**"ZERO GRADUATIONS" WAS A DEAD COUNTER, NOT A PROPERTY OF THE SYSTEM.**
`_cycleOutRoot` sends every MatB cycle-out to TierRouter, so `_crossToPartner` — the only
emitter of `MemberCrossedToPartner` — is unreachable for a MatB root. TierRouter emits
`MemberReentered` instead. **Success is silent on the event sessions 11 and 12 both
counted; only failure is loud.** Anything measured on that counter reported 0 forever.

Corrected, and all of it reconciles with 0 unaccounted:
* **Fixture, size 127, zero referrals anywhere:** 508 hops → 485 parked, **23 RE-ENTERED**,
  22 members round twice, one three times. **But every success came during the fill phase
  and the last 237 consecutive hops produced zero** — the steady-state rate really is 0.
  The fixture is the FLOOR (no referrals, no lending), not the forecast.
* **LIVE V8.48, first time ever counted:** 945 hops → 764 parked, **175 RE-ENTERED,
  18.52% cleared. 91 distinct members have cleared the forward hop, 40 more than once, one
  five times.**
* **175 of 175 clearances had NO SF loan or discount in their own transaction** — paid from
  earnings. (Tests the clearing tx only; 53 of the 91 have borrowed at some earlier point.
  The SF sits upstream at the A→B crossing, not at the hop.)
* **THE LOAN BOOK: $1,511.34 borrowed / $1,447.51 repaid = 95.78%**, 836 repayments against
  459 loans. **This refutes 11.4's case against option B.** 11.4 reasoned only about the
  cycle that took the loan; repayment is collected continuously by `withdrawCore`, the
  banded clawback, and the debt sweep at MatB cycle-out. **B is not dead on arithmetic.**
* **CORRECTED: orphaned L1 does NOT all go to accountOne.** 20% does; ~40% to the community
  wallet (or the SF) and ~40% straight out to the dev wallet. So lever C costs the COMMUNITY
  WALLET and the DEV WALLET, not accountOne. That changes what C is, politically.

**UNAFFECTED AND STILL GOOD:** every shortfall number. Median holding at the hop $5.5916,
the closed-form gap, the composition table. `V8_50_MemberLedger.test.js` reconciles the
withdrawable against every credit ever received, three independent readings, both sizes,
**largest disagreement $0.0000 — to the wei.** Nothing is lost, capped, withheld or settled
late. Do not re-chase lazy settlement or an earnings cap; both stayed refuted.

## ⛔ FIRST THING TO DO — AND DO NOT REORDER THIS
**SEPARATE THE BIGFILL WALLETS FROM ORGANIC MEMBERS AND RE-RUN `diag_forward_hop.js`.**
The live entry flow is bigfill, funded with the owner's own USDC, so 12.6's numbers are
measured on a population the owner is paying for. The repayment MECHANISM is proven either
way — that part holds — but a 95.78% ratio on an owner-funded entry stream is not evidence
that B works organically. Bigfill wallets are identifiable: round-robin leader sponsors,
lifetime withdrawn $0.00, reserve exactly $5.00. Split the 12.6 table by cohort.
**THE OWNER'S DECISION SHOULD NOT BE TAKEN UNTIL THAT ROW EXISTS.**

Then, in order:
2. **Open one of the 5 unexplained cycle-outs** (tx hashes in the script output, 0.53% of
   attempts). 7 `DoubleEntryFired` are the leading candidate — UNVERIFIED, so look.
3. **Fix `V8_50_ReferralBreakeven.test.js` v4 to count `MemberReentered`.** It counts the
   same dead event, so its "0 graduations at rates 0–4" measured nothing. The referral
   break-even is still genuinely unknown.
4. Session 10 backlog, untouched: stale-nonce retry backoff (3s sleep + single re-fetch
   failed 24/24; try growing gaps), @bevmawire's Dashboard retry, restate
   `maxItemsPerUpkeep` against 15 not 20, member-callable re-entry after eviction +
   eviction end-to-end in the private deploy, re-measure bigfill fund figures.

## ⛔ THE OWNER DECISION IS STILL OPEN — ASK, DO NOT DECIDE
How to close the gap for members who never recruit. Still A (accept) / B (lend) / C (change
the splits) — but **B is back on the table** and **C costs the community and dev wallets**,
so 11.4's framing of both is out of date. Owner's stated bar: *"give members at least two
full cycles but not at the expense of an unpaid loan — if it means only one loan that is
what it is."* Measured against it: with zero referrals AND zero loans, 22 fixture members
got exactly two cycles and then it stopped. **The two-cycle goal is currently a startup
privilege, not an unreachable bar.**

## ⚠ TRAPS — SESSION 12 ADDED THREE, ALL PAID FOR TWICE
- **AN INSTRUMENT CANNOT REPORT THE ABSENCE OF WHAT IT CANNOT OBSERVE.** Session 11 wrote
  this rule about v2's stranded-L1 zero and then walked into it two sections later. Session
  12 walked into it again with the same event. **Before believing any zero, prove the event
  CAN fire on that path.**
- **DO NOT MERGE THE PARK BUCKETS.** `MemberParked` has six emit sites and only two carry a
  real shortfall. Merging them made outcomes exceed attempts (−9). 11.4 says this in as many
  words and session 12 did it anyway.
- **A PROXY THAT CANNOT COME BACK NEGATIVE IS NOT A MEASUREMENT.** "The SF emitted a log in
  this tx" read 100% because `FundDeposit` fires on every entry's stability split. The loan
  signal is `MemberDebtIncreased`. Also: **a debt SNAPSHOT is not a repayment HISTORY** —
  the same mistake as the 2026-08-16 current-balance-vs-lifetime-ledger error.

## HOW WE WORK
You drive, decide direction, and make the file edits directly. I run every command and paste
back the output. Copy-paste blocks that name the folder, one step at a time, then wait.
Explain in plain language; I am not deep on the technical side. Do not ask which item to take
next — decide, tell me, and we continue. Ask only when the answer is genuinely mine: a policy
or economic trade-off. Dial back on long chains of runs.
Contracts push to `v8.1`. Frontend pushes to `origin admin`, then `admin:preview` and
`admin:main` (members see MAIN only). There is no third party: every line of this codebase was
written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
