## 13.11 ⛔⛔ THE FLOOR, TIER-CORRECTED — AND THE ANSWER TO THE OWNER'S 100% TARGET

Owner's call, 2026-08-20: *"my call stands where we need to make the system not carry anyone's
debts — if they will not be able to pay we do not offer them a loan. I am looking for 100% loan
repayment, so if that means a reduction from 50% to 40% or even 20% so be it. The way to get out
would be to sponsor one or more."* Also: **PARAM 59 is to be RE-CONFIRMED, not shipped as-is**,
because it "was handed by a previous session before this evidence was presented."

`diag_insolvency_floor.js` v2 re-measures peak debt as **bps of the member's OWN tier fee** and
replaces v1's counterfactual with a purely observational question — *among members who never
exceeded B, what share ended clean?* Monotonic, and it answers the target directly:

| cap B | T1 cap | members at/below | clean | owing | CLEAN % |
|---|---|---|---|---|---|
| 1000 bps | $1.00 | 13 | 13 | 0 | **100.0%** |
| 1700 bps | $1.70 | 33 | 28 | 5 | 84.8% |
| 2500 bps | $2.50 | 45 | 36 | 9 | 80.0% |
| 3400 bps LIVE | $3.40 | 52 | 39 | 13 | 75.0% |

**THE FLOOR CAN REACH 100% — AT 1000 bps (10%), AND ONLY THERE.** The cost is in section 3 of
the output: **1000 bps would have capped 101 of 114 organic borrowers (88.6%)** to remove 26
defaulters. That is not "lending with a sane ceiling", it is ending lending to keep the book
clean, and it contradicts the first half of the owner's own rule 1 (*"members need loans to help
them and that is good"*). **The 100% target is reachable by parameter only by abolishing the
thing the parameter governs.**

### ⛔ AND TONIGHT'S DATA IS THE WRONG BASIS FOR SETTING THE FLOOR ANYWAY — A CORRECTION TO 13.7
Section 1 shows **62 organic members with peak debt ABOVE the live 3400 cap**, which should be
impossible. It is not a floor failure: `forceCrossKeeper` (MatrixLogicLib:1612) books
`sfContribution + crossingBuffer` as one advance, and the crossing buffer pushed members past the
ceiling — the exact effect recorded on 2026-08-15 as *"it exceeded insolvencyFloorBps so the floor
could refuse nobody"*. **`crossingBufferBps = 0` has been the default in the tree since V8.49
(MatrixKeeper.sol:153) but IS NOT DEPLOYED. V8.48 is live.**

**CONSEQUENCE, AND IT REVERSES 13.7's FRAMING:** most of the debt measured tonight was
manufactured by a mechanism already removed in the undeployed build. PARAM 59's 5000 was measured
on the **V8.50 arm — buffer already zero** — so for the FLOOR VALUE SPECIFICALLY the AB_FLOOR_BPS
curve is the BETTER evidence and tonight's numbers are the worse one. 13.7 said the 5000 decision
predated this evidence; that is true but misleading, because this evidence is on the old build.
**RE-CONFIRM RECOMMENDATION: KEEP 5000.** Nothing measured tonight improves on the basis it was
already chosen from, and lowering the floor on V8.48 data would be tuning against a mechanism
that will not exist in V8.50.

### ⛔ WHAT TONIGHT DOES ADD, AND IT IS THE ANSWER TO RULES 1-4 TOGETHER
The AB curve measured EVICTIONS. It never measured repayment or who repays. Section 4 does, and
it is the strongest single signal of the session — **the owner's own stated exit route, confirmed
observationally with no model behind it:**

| organic members | count | have sponsored anyone |
|---|---|---|
| STILL OWING | 26 | **3 (11.5%)** |
| CLEAN | 88 | **46 (52.3%)** |

**A member who has sponsored someone is 4.5x more likely to have cleared their debt.** With
13.6's at-loan-time figures (0 directs 67.2% repayment, 1 direct 92.6%), sponsorship is the
discriminating variable and the floor is not.

### THE SHAPE THAT SATISFIES ALL FIVE RULES AT ONCE
Not a decision — the owner's — but this is what the evidence supports, and it uses his own exit
route as the qualifying condition rather than inventing a new one:

* **Keep the floor at 5000** as the outer ceiling (re-confirmed on the V8.50-arm curve, above).
* **Gate the HEADROOM ABOVE A BASE on `directCount >= 1`.** A member who has sponsored nobody
  gets a small first advance; the rest of the ceiling unlocks when they sponsor one person.
  Rule 1 keeps lending alive, rule 2 targets the population that actually repays, rule 3 refuses
  the advance that cannot be covered, rule 4's "invite 2 or 3" becomes the literal mechanism, and
  rule 5's pay-it-forward is the same counter again.
* **⚠ UNVERIFIED — THE SPLIT IS ASSOCIATION, NOT CAUSATION.** Sponsoring may mark an engaged
  member rather than cause solvency. For a GATE that is sufficient (a filter only has to
  predict), but nobody should claim recruiting makes you solvent on this data.
* **BLOCKING WORK BEFORE ANY OF IT SHIPS:** `directCount` does not exist (TierRouter:216 stores
  only `memberReferrer`), and `coPayRescue` sees only `withdrawable` and `crossingReserve`, so the
  gate needs a router read **at a call already near the block gas ceiling. Measure size and gas
  first — this has not been done and must not be promised until it is.**
* **THEN RE-MEASURE ON V8.50.** With the buffer at zero, loans are the real shortfall only, debt
  per member falls, and the floor binds differently. Every number in 13.11 should be re-run on
  the private V8.50 deploy before the floor is touched again.

