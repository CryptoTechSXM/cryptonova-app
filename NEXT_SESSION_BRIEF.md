# NEXT SESSION BRIEF — V8.50, branch `v8.1`
Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`. Written at the end of session 11,
2026-08-20. Paste this in as the opening message of the next session.

Read `V8_50_HANDOFF.md`, newest first: **section 11.1 → 11.5** (session 11), then section 7a
THE TWO RULES, then SESSION 10 and below. 11.1–11.5 supersede nothing older; they add.

## THE TWO RULES — these govern everything
1. Do not hypothesise unless necessary.
2. Measure and test before implementing. Never build on a hypothesis.

When two numbers disagree, the disagreement IS the finding — measure it, do not explain it.
A number you have not run is not a result. One sample is not a measurement.

## ⛔ START HERE — WHERE SESSION 11 LEFT THINGS
**NOTHING WAS DEPLOYED. NO CHAIN WAS WRITTEN TO. NO CONTRACT OR EXISTING TEST FILE WAS
TOUCHED.** Owner instruction 2026-08-20, still in force: *"we are not changing code yet just
discussing until we come to a conclusion."*

Session 11 was a MEASUREMENT session. It produced two new test files and five new handoff
sections. **All of it is UNCOMMITTED — land it first:**

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
git status
git add test/V8_50_CycleEconomics.test.js test/V8_50_ReferralBreakeven.test.js V8_50_HANDOFF.md NEXT_SESSION_BRIEF.md
# write the message to a file and use -F: `git commit -m` from PowerShell mangles $ figures
git commit -F COMMIT_MSG_s11.txt
git push origin v8.1
```
Stage EXPLICIT PATHS. Never `git add -A`. Suite untouched at 611/7/0 — session 11 added two
files but ran neither as part of the suite.

## WHAT SESSION 11 SETTLED — do not re-derive any of this
1. ✅ **T1.1 IS THE ONLY FRONT DOOR, PERMANENTLY. CLOSED — DO NOT CHASE.**
   `PairManagerV8._findExternalPair()` is `internal pure { return 0; }`. It is `pure`, so it
   cannot read state and **no number anywhere can change where a registration lands.** The
   owner's "254/255 magic number" describes a mechanism that existed twice and was deleted
   twice — a cumulative counter froze 254 members in T1.1 MatA for three days. Full basis in
   handoff 11.1.
2. ✅ **THE GATE IS A PRICE, NOT A COUNT.** MatA→MatB costs the discounted crossing and is
   pre-funded by the reserve. **MatB→next pair costs the FULL ENTRY FEE with no reserve
   behind it.** That is the wall.
3. ⛔ **MEASURED, live matrix size, no referral income: 485 of 485 cycle-outs at the forward
   hop PARKED. ZERO graduated.** All 485 were genuine shortfalls — the two non-affordability
   park causes were bucketed separately and came back nil. Median member arrives holding
   ~56% of one fee. Matches live chain: T1 pair0 MatB has 773 rotations and 4 members ever
   reached T1.2.
4. ✅ **THE GAP IS FULLY ACCOUNTED FOR IN CLOSED FORM AND MATCHES THE MEASUREMENT TO SIX
   CENTS.** Both halves distribute 5000 bps of the entry fee, so a full A+B cycle distributes
   the whole $10.00. A no-referral member collects pool + chain + direct = $5.536; measured
   median holding $5.5916. The gap is exactly the two leaks: **system take $2.564 + orphaned
   L1 $1.900 = $4.464**; measured median shortfall $4.4084.
   **CONSEQUENCE: while the protocol takes ANY fee, a member who never recruits can NEVER
   self-fund the forward hop. It is conservation of money, not a tuning problem.**
5. ✅ **EACH INVITEE IS WORTH EXACTLY $1.90** — 950 bps at their MatA entry plus 950 bps
   again when they cross to MatB. **L1 PAYS IN BOTH HALVES.** The second $0.95 arrives late,
   so recruiting early is worth more than recruiting late.
6. ✅ **OWNER CORRECTED CLAUDE ON MECHANISM AND WAS RIGHT — THIRD TIME.** Claude called the
   identical MatA/MatB earnings an anomaly ("MatB should earn half"). Owner: *"only $5 is
   distributed which is the crossing fee as well so it should be the same not half."*
   Verified in source. **When he pushes back on how the money moves, read the code before
   defending the finding.**

## ⛔ THE FIRST THING TO CHASE — THE BOUNDED DISTRIBUTION
**Nobody ever reaches the fee, even when they get within eight cents.** Across 3,600+ hops
at referral rates 0 through 4, not one forward crossing. A member who made it would leave the
shortfall sample and appear as a graduation; FORWARD is 0 everywhere. **So the distribution
appears bounded below $10.00 and nobody has ever had enough.**

**ALREADY RULED OUT — do not re-chase:**
- ❌ Lazy pool settlement. `_cycleOutRoot` calls `_settlePool` at MatrixLogicLib:805, BEFORE
  the crossing logic at :900+.
- ❌ An earnings/payout cap. None exists; `_settlePool` is an exact rational with no ceiling.

**DO THIS:** take ONE parked member at the hop and account for their withdrawable to the cent
against every credit they ever received — pool, chain, direct, L1, carried balance — and find
what bounds it. Do not reason about it. If the ceiling is structural, referrals cannot close
the gap either and option A below wins by arithmetic rather than by choice.

## THEN — THE REFERRAL BREAK-EVEN, INSTRUMENT READY BUT NOT YET TRUSTED
`test/V8_50_ReferralBreakeven.test.js` is at **v4 and has NOT produced a trustworthy row.**
**DO NOT QUOTE ANY NUMBER FROM SESSION 11'S RUNS OF IT.** Three earlier versions, three
faults — full table in handoff 11.5. The last one (v3) scaled the budget with the referral
rate, which measured every rate at a different system maturity and produced a flatly
non-monotonic table with 100+ hops per row. v4 holds the budget FIXED across rates.

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:CYCLE_SIZE=127
npx hardhat test test/V8_50_ReferralBreakeven.test.js
Remove-Item Env:\CYCLE_SIZE
```
~17 minutes. Dials: `CYCLE_REFS` (default `0,1,2,3,4`), `CYCLE_BUDGET` (default 6 x SIZE —
**fixed across rates ON PURPOSE, do not "fix" it back**), `CYCLE_MIN_HOPS` (default 10).

## ⛔ ONE OWNER DECISION IS OPEN — ASK, DO NOT DECIDE
**How to close the ~44% gap.** Economic/product, not determinable from code:
- **A. Accept it.** Matches his standing framing — members who never invite are expected to
  take loans and be evicted. Cost: the next pair fills at ~0 without referrals.
- **B. Lend it.** ⚠ **Owner's own $5 idea is ALREADY the V8.50 decision** (PARAM 59 = 5000,
  taken 2026-08-19; live V8.48 still reads 3400 = $3.40). **New fact: measured shortfalls run
  to $5.08, so a $5.00 ceiling is eight cents short of the worst case** — the identical trap
  as the $4.50-vs-$4.52 finding, one rung up. Menu's next step is 6800.
  ⚠ **AND THE ARITHMETIC KILLS IT ANYWAY:** a cycle consumes $10 and returns ~$5.59, so
  lending $4.41 means arriving at the next hop owing $4.41 AND still short. The debt is never
  repaid because there is never a surplus. **Under the owner's own constraint — "not at the
  expense of an unpaid loan" — B is not viable at the current yield.**
- **C. Change the splits.** Levers, largest first: orphaned L1 950 bps (goes to accountOne,
  costs real referrers nothing); system take 1282 bps; what the forward hop costs. Splits
  must sum to exactly 4750 — every option is a reallocation, never an increase.

Owner's stated goal: *"give members at least two full cycles but not at the expense of an
unpaid loan — if it means only one loan that is what it is."*

## ⚠ SESSION 11'S OWN TRAPS — ADD TO THE LIST
- **A HARNESS THAT REMOVES A FAILURE MODE CANNOT THEN REPORT ITS ABSENCE.** v2 registered
  invitees immediately, making stranded L1 zero BY CONSTRUCTION, then printed that zero as a
  finding. v3 measured it non-zero (~0.6% of L1 — real, but far too small to matter).
- **EVENING OUT SAMPLE SIZES BY CHANGING RUN LENGTH INTRODUCES A MATURITY CONFOUND.** A thin
  row labelled thin is honest; a confounded row lies quietly.
- **ONE SAMPLE IS NOT A MEASUREMENT — INCLUDING ONE HAND-PICKED MEMBER.** The first cycle
  fixture tracked a single subject and refused twice at size 127 before being rewritten as a
  census.
- **`isActiveInMatrix` DOES NOT MEAN "HOLDS A SEAT".** It read `true` for a member while 485
  parked and occupancy never moved. Parked members still answer true.
- **V8.50 ITEM A IS ALREADY IN THIS TREE AND DOES NOT FIX THE FORWARD HOP.** The fixture ran
  with item A in force — A→B cost $5.00 funded 100% from reserve — and still ended 0 of 485.
  Item A was never aimed at this hop. LIVE V8.48 does not have item A at all.

## STILL ON THE BACKLOG FROM SESSION 10 — NOT TOUCHED
1. **The stale-nonce retry does not work.** Classifier and offset-hold are proven good; the
   3-second sleep and single re-fetch failed 24 of 24. Pre-run sweep succeeded 24/24 and the
   post-registration sweep failed 24/24, so the lag only appears after those wallets have
   just transacted. Try a longer backoff or several attempts with growing gaps.
2. **Ask @bevmawire to retry the Dashboard.** His fault predates the outage and has a
   different cause. `LOGS_DEPLOY_FLOOR` fix has shipped to main.
3. **Restate the `maxItemsPerUpkeep` item against 15**, not 20.
4. **Member-callable re-entry after eviction** + **eviction end-to-end in the private deploy.**
5. Bigfill loop / fund figures — RE-MEASURE, do not carry session 10's numbers forward.

## HOW WE WORK
You drive, decide direction, and make the file edits directly. I run every command and paste
back the output. Copy-paste blocks that name the folder, one step at a time, then wait.
Explain in plain language; I am not deep on the technical side. Do not ask which item to take
next — decide, tell me, and we continue. Ask only when the answer is genuinely mine: a policy
or economic trade-off. Dial back on long chains of runs.
Contracts push to `v8.1`. Frontend pushes to `origin admin`, then `admin:preview` and
`admin:main` (members see MAIN only). There is no third party: every line of this codebase was
written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
