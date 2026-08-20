NEXT SESSION BRIEF — V8.50, branch `v8.1`
Written end of session 17, 2026-08-20. Paste this in to open the next session. Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`.
Read `V8_50_HANDOFF.md` section 17 first — 17.1 is the result, 17.2 is the method lesson, 17.5 is the owner's open call — then 16, 15, 14, then section 7a THE TWO RULES. Everything below is a pointer, not a substitute.

STATE
Contracts `v8.1` at **`d1d78ef`**, frontend `admin` = `preview` = `main` at `74a1588`. NOTHING DEPLOYED, NO CHAIN WRITTEN TO. Session 17 edited two contract files as a FIXTURE, measured them, and REVERTED — `git diff contracts/` is empty for both. Sessions 13–17 are measurement only.

SUITE: **618 passing / 8 pending / 0 failing**, RE-RUN IN FULL 2026-08-20 at the end of session 17 — this is the current baseline, use it. The old 611/7/0 was stale: it predated sessions 11 and 12, which added `V8_50_CycleEconomics`, `V8_50_ReferralBreakeven` and `V8_50_MemberLedger`. Those three were run alone and report exactly 7, so the +7 is fully accounted for and is NOT a drift. The 8th pending is `V8_50_GateCost.test.js`, skipped on purpose (17.8).

THE RULES

1. Do not hypothesise unless necessary. 2. Measure and test before implementing. When two numbers disagree, the disagreement IS the finding. A number you have not run is not a result. One sample is not a measurement. Build the instrument so it can contradict you.

AND THE ONE SESSIONS 15–17 EARNED: BUILD THE SECOND INSTRUMENT. Not a review pass, not a re-read — a different measurement of an overlapping quantity, with a printed line where the two must meet. Three sessions, three times it paid.

⛔ AND THE ONE SESSION 17 EARNED, WHICH IS 14.3 IN A NEW COAT: A MEASUREMENT WHOSE CONTROL ARM MOVED IS NOT A MEASUREMENT. The gate fixture was first built with a real ceiling, it BOUND, the fund refused loans, parked members were evicted instead of rescued, and the batch mix went from PARKED_RESCUEx8/EVICT_PARKEDx4 to x2/x10. The gas run priced a different population and read as a saving. To price a MECHANISM, install it so it cannot BIND, then check the work mix came back identical before believing a single number.

⛔ THE POLICY IS SETTLED — 16.5 STANDS, ALL FIVE
Asked once and accepted by the owner 2026-08-20. Keep lending; price it at 20.2% ending in debt vs 10.0%; PARAM 59 stays at 5000; do NOT cut the floor to 40%/20%; do NOT touch `setClawbackBands` for this purpose; the exit is sponsorship. Build on it without re-asking. The lending investigation (13→16) is CLOSED — its record is in the handoff and in memory; do not re-open it, and never requote 13.5's 7.1/31.7 or 15.2's 2.4/31.8. The balanced pair is 8.0% vs 19.6%.

✅ WHAT SESSION 17 CLOSED — THE GATE FITS, AND FEASIBILITY IS NO LONGER A REASON TO WAIT
* SIZE: TierRouter +136 bytes (530 left), StabilityFund +447 (9,066 left), and MatrixPairFactory (78 bytes) and MatrixLogicLib (295) did not move a byte — the matrix and the library are never touched.
* GAS: the added router read costs 7,720 cold / 1,220 warm, measured in exact gas units. Against a live worst item of 4.37M that is 0.18%; a saturated 15-item batch adds ~0.3% of the 17.80M ceiling; `minGasPerItem` is untouched.
* PLACEMENT — this CORRECTS 13.11 and 16.5. The gate does NOT go in `coPayRescue`. It goes in `StabilityFund.loanHeadroom`, the only place the ceiling arithmetic lives, so the keeper's triage and the fund's enforcement cannot drift apart. The SF already stores `tierRouter` (StabilityFund.sol:98) and the matrix needs no change at all.
* NOT MEASURED, stated plainly: the end-to-end delta at MATRIX_SIZE 127 (only the size-7 arm was run; the added read touches no matrix storage, which is REASONING not a measurement), and the register SSTORE beyond "+0.01M measured".

⛔ OWNER DECISION OPEN — DO NOT TREAT AS TAKEN
A BINDING sponsorship gate converts rescues into EVICTIONS. Session 17's binding arm evicted 6 members the baseline rescued. ⚠ That is a fixture world where nobody has a sponsor and it is NOT a live prediction — but the direction is real, eviction has fired 0 times in 1,803 live episodes, and a binding gate is what would start it. What base ceiling, and whether a refused loan should route to eviction at all, are the owner's economic calls. Do not design them before item 1 below.

NEXT, IN ORDER

1. RE-MEASURE 14.1 AND 16.2 ON THE PRIVATE V8.50 DEPLOY. The only blocking item now. `crossingBufferBps = 0` is in the tree and NOT deployed; the buffer manufactured most of the debt behind every number in 13→16. The gate's base ceiling must be chosen on V8.50 numbers.
2. Split 14.1 by tier and cap time-at-risk (14.4's one real imbalance).
3. The gate's policy shape — after item 1, and partly the owner's.
4. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic); `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry.

TOOLS THAT NOW EXIST — use them, do not rebuild them
* `node scripts/fixture_gate_apply.js` reapplies session 17's exact fixture (`--binding` for the policy arm, `--undo` to revert). It aborts rather than half-apply.
* `test/V8_50_GateCost.test.js` is the probe, `describe.skip` ON PURPOSE — it only means anything with the fixture applied. Its header has the run recipe.
* `contracts/test/GateProbe.sol` measures cold and warm in one transaction with no matrix world.

TRAPS, CARRIED FORWARD
* ⛔ CLAUDE'S FILE BRIDGE DOES NOT APPLY YOUR LINE-ENDING NORMALISATION. `contracts/test/CryptoNovaCommunityWallet.sol` reads as a 474/474 whole-file diff from Claude's side and is CLEAN from yours — measured: `git diff --ignore-all-space` is empty, the worktree holds 474 CRs across 491 lines, the blob holds 0. Nothing is wrong with the repo. Session 17 recorded it as a backlog item on Claude's reading alone before checking, which is one instrument unchecked. Before treating any whole-file diff as a finding, run `--ignore-all-space` and ask what YOUR `git status` says — your machine is authoritative. Do not 'fix' it: the commit would churn 474 lines and change nothing.
* A GATE THAT EXISTS IS NOT A GATE THAT BINDS (14.3), and its mirror: A GATE INSTALLED TO BE MEASURED MUST NOT BIND (17.2).
* READING SOURCE MEASURES THE MECHANISM, NOT THE POPULATION. It IS valid for where code lives — that is how 17.4 corrected the `coPayRescue` claim.
* A WINDOW THAT LEAKS INVENTS A FINDING (16.1). DECISIVE ≠ COVERAGE — 67.4% of the missing dollars, 5 of 123 members; quote both or neither. A CONTROL WHOSE BASELINE IS ON THE FLOOR CANNOT CARRY A VERDICT (bigfill, 1.4%).
* AN INSTRUMENT'S RESOLUTION IS PART OF ITS RESULT. `V8_50_KeeperGas` prints to 0.01M; a 7,720-gas change reads as +0.01M. That is agreement, not absence — and it is also why 17.3 says "consistent with", not "established".

HOW WE WORK
You drive and decide direction; you make the file edits; I run every command and paste back the output. Copy-paste blocks that name the folder, one step at a time, then wait. Plain language — I am not deep on the technical side. Do not ask which item to take next: decide, tell me, and we continue. Ask only when the answer is genuinely mine (a policy or economic trade-off). Fewer, smaller steps — converge on the decision rather than chasing every thread; park the rest in the handoff. Contracts push to `v8.1`; frontend `origin admin` → `admin:preview` → `admin:main`. There is no third party: every line here was written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
