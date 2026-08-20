# NEXT SESSION BRIEF — V8.50, "the crossing redesign", branch `v8.1`
Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`. Written at the end of session 10,
2026-08-20. Paste this in as the opening message of the next session.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. section 7a — THE TWO RULES. Short, owner-set, non-negotiable.
2. SESSION 10 STATE at the top — the newest.
3. SESSION 9 STATE below it — the live incident, the T2 routing answer, the eviction recipe.
4. SESSION 8 STATE below that — the PARAM 59 curve and the eviction answer. Still stands.
5. SESSION 7 STATE below that — the corrected A/B and the velocity fix. Still stands.
6. SESSION 6 STATE below that — its park/loop table is WITHDRAWN; its FUND table holds.

## THE TWO RULES — these govern everything
1. Do not hypothesise unless necessary.
2. Measure and test before implementing. Never build on a hypothesis.

Practical form: when two numbers disagree, the disagreement IS the finding — measure it,
do not explain it. A number you have not run is not a result. One sample is not a
measurement. Arithmetic over measured numbers is NOT a measurement.

**SESSION 9: AN INSTRUMENT MUST NOT REPORT THE ABSENCE OF SOMETHING IT CANNOT OBSERVE.**
Four instances in one day, every one of them looking like a clean result.

**SESSION 10 EXTENDS IT ONE LEVEL UP: A HANDOFF MUST NOT REPORT WHAT THE INSTRUMENT NEVER
ASKED.** Session 9's summary credited `probe_sf_views.js` with finding `evictionGracePeriod`
absent. That script probes the StabilityFund; `evictionGracePeriod` is on MatrixKeeper and is
not in its case list. The claim was read off the source tree and attributed to a script that
never asked. **When a handoff attributes a result to a named script, open the script and look
for the case.** It cost one grep to disprove.

## ⛔ START HERE — WHERE SESSION 10 LEFT THINGS
**Everything is committed and pushed in both repos. The frontend ladder is LEVEL.**

| repo | branch | at session end |
|---|---|---|
| `C:\CryptoNite-Smart-Contracts\CryptoNova` | `v8.1` | **`917b105`** — two new instruments + the session-10 docs; no contract or test file touched |
| `C:\CryptoNova-Testnet-App` | `admin` = `preview` = `main` | **`74a1588`** — badge fix + bug form. **Members have everything.** |

Suite: **611 passing / 7 pending / 0 failing**, as of session 9's `e404d70`. Not re-run in
session 10 because nothing it covers moved.

**First actions, in this order:**
1. `git status` in both repos. Expect clean apart from known untracked debris:
   `COMMIT_MSG_s10.txt` in BOTH repos (delete it), and in contracts
   `scripts/bigfill_v8.js.bak_ascii`, `test_ab/replay.js.bak_s9b`, `test_ab/replay.js.bak_s9c`
   (session 9 leftovers — house pattern is to move strays into `archive/`, not delete them).
2. **VERIFY THE SCREENSHOT UPLOAD END TO END.** It is the one thing session 10 shipped that has
   not been proven against reality — `node --check` passes and `buildEntry` was rendered for
   four cases, but no real browser has done the canvas downscale and no real image has gone
   through the GitHub API. File a throwaway bug report with an image; confirm the `BUGS.md`
   entry, the link, and the file in `bug-screenshots/`. If the upload fails the entry SAYS SO
   by design, so either outcome is informative.
3. Is the bigfill loop still alive? `logs\bigfill_loop\` has one file per run and the loop stops
   itself after 2 consecutive bad runs. **Those logs are UTF-16 — use `Select-String`, never a
   byte-level grep, which returns "0 matches" for everything and reads as "clean".**
   The offset should now be advancing on its own; a filename of `...offset290.log` or higher
   confirms the last run was judged good.

## ⛔ LOCAL `preview` AND `main` ARE 30 COMMITS BEHIND THEIR REMOTES
Not touched in session 10 — the ladder was pushed as `git push origin admin:preview` and
`git push origin admin:main`, both fast-forwards, because `origin/main` and `origin/preview`
were strict ancestors of `origin/admin`. **A future session that checks out local `preview` and
merges will make a mess.** Fix them (`git fetch` then reset each to its origin) or delete them.
`admin` has no upstream set either, so `git status` on it cannot tell you whether it is in sync —
use `git ls-remote origin` to check refs, which is what session 10 did.

## WHAT IS DONE — do not re-derive any of this
- **PARAM 59 = 5_000. OWNER DECISION 2026-08-19, LANDED IN SOURCE.** Basis written at the
  declaration in `StabilityFund.sol`. `V8_48_KeeperScan.test.js` still probes 3_400 ON PURPOSE —
  it is the cliff probe, not the shipping value. **Live V8.48 still reads 3400**; 5000 is V8.50.
- Item E1 + defects 2,4,5,6,7,8,9, ladder preset 1, tier gates, item D, frontend ABI audit —
  settled earlier. `minGasPerItem` 5M is an owner decision **in SOURCE only — see below**.
- GATE MEASUREMENTS 1 AND 2 — answered. Cold SF-funded rescue at `MATRIX_SIZE` 127 costs 4.37M.
- THE 68 VELOCITY `WorkItemFailed` ARE EXPLAINED, FIXED AND GONE. **LIVE V8.48 STILL HAS IT.**
- THE ~10x EVICTIONS ARE EXPLAINED AND REPLICATED 3/3. NOT a defect.
- Loans: 159 loans, 159 distinct members, max 1 each. The second rescue is SELF-FUNDED.
- **The owner's T2 routing concern is CLOSED. Nothing reverted.** Chain wiring verified correct
  on every tier. T1.2 being empty is NOT starvation.
- **SESSION 10: the parked badge and the bug-report form are done and on main.** The badge's
  V8.48 fallback now matches `loanHeadroom`'s whole definition; its clock fallback only fires on
  ABSENT, never on a failed read.
- **SESSION 10: `loanEligible` is exactly `loanHeadroom(...) > 0`** (`StabilityFund.sol:988`).
  It is not an independent signal and the badge does not need it. Do not re-raise this.

## ⛔ THREE LIVE VALUES ARE NOT WHAT THE SOURCE SAYS — MEASURED 2026-08-19, 4/4 CONTROLS GREEN
Run `node scripts\probe_keeper_views.js` to re-confirm any of these; it declares itself VOID if
a control fails, so a green run means the ABI and not the network.

| | live V8.48 | source default | consequence |
|---|---|---|---|
| `maxItemsPerUpkeep` | **15** | 20 | ⛔ the backlog item "still vestigial at 20" is stated against the wrong number. Restate it, then decide 10 or not. |
| `minGasPerItem` | **ABSENT** | 5_000_000 | ⛔ the 5M owner decision is V8.49+/V8.50 and is NOT in force on live. Live keepers still carry 3.5M, deliberately. Never quote 5M as a live figure. |
| `parkedGracePeriod` | **86400** | 6 hours | minor, but it is not the source value |

Also live: `evictionGracePeriod` ABSENT, `extendedIdleTimeout` 604800, `insolvencyFloorBps` 3400,
`tierEntryFees(0)` $10.00 — so the **live T1 loan ceiling is $3.40**.

## ⛔ THE PARKED POPULATION MOVES IN SECONDS — TREAT ITS NUMBERS AS SNAPSHOTS
`diag_badge_preview.js` run twice **20 seconds apart** scanned **109 then 110** positions.
Readings that evening: **37/107, 41/108, 40/109, 40/110**. The uncoverable count moves more
slowly than the population, which is what you would expect if new parkers arrive rescuable and
the uncoverable set is the accumulated hard cases.
**So `44 -> 41 -> 37` IS NOT A TREND.** To compare two instruments honestly, stop the bigfill
loop first, or compare only the PER-MEMBER rows (gap, headroom, verdict) — those must agree to
the cent and that check has no drift in it.
⚠ **Direction worth watching: the fund recovered $486 -> $529 across one session while the
parked queue GREW 107 -> 110. Parking is currently outrunning rescue.**

## OWNER FRAMING — IT DECIDES WHAT COUNTS AS A DEFECT
- **Members are NOT meant to cross forever.** The bar is one or two loans.
- **Nobody can get stuck at the A->B crossing.** (MatA parkers were evictable in 0 of 258.)
- **Members are EXPECTED to take loans and be evicted if they never invite anyone.**
- **Customer-facing issues get priority, even on testnet** (stated 2026-08-19).

## ⛔ ONE OWNER DECISION IS STILL OPEN — ASK, DO NOT DECIDE
**LIVE V8.48 — leave organic, bigfill, or fund the SF?**
Session 8's "bigfill does not replenish" is WITHDRAWN; the owner was right on mechanism and it
was confirmed twice — by the USDC ledger (which reconciles EXACTLY: in $1,401.79, out $1,364.86,
**no leak**) and by live recovery. Daily net separates perfectly by regime: bigfill days
**+$72.87 / +$75.82 / +$81.39 / +$214.74**, quiet days **-$114.31 / -$185.02 / -$108.55**.
**+$111/day running vs -$136/day stopped, no overlap.**
⚠ **NEITHER REGIME IS THE REAL WORLD** — bigfill self-rescues at ~100%, stopped it is 0%. Read
them as a BRACKET. Best empirical anchor available for the open self-rescue-rate item.
⚠ **RE-MEASURE FIRST.** The figures move daily and session 10 watched the fund climb $43 in an
hour. Prerequisite still owed: `diag_parked_growth.js` with `WINDOW=3000` (its last run reported
9 failed ranges while its SF section reconciled exactly — those two statements are in tension).
⚠ Operational constraint: restarting bigfill collides with a future V8.50 private deploy on
wallet nonces. Sequence them, never overlap.

## ⛔ THE TRAP THAT COST THE MOST — READ BEFORE WRITING ANY CHAIN CODE
**The repo tree is V8.50. The community chain is V8.48.** A view added after V8.48 reverts there
with `missing revert data` — which looks exactly like a network fault and is not one.
**Check every chain call against the DEPLOYED ABI, not the source tree.** Use
`scripts/probe_v848_getters.js`, `scripts/probe_sf_views.js` (StabilityFund) and
`scripts/probe_keeper_views.js` (MatrixKeeper). **Know which contract each one covers** — that
confusion is what produced the session 9 handoff error.
**And gate every fallback on the error SHAPE**, not on a bare `catch`: "the function is absent"
and "the read failed" are different answers, and a bare catch will substitute during an outage.

## EVICTION — NEVER FIRED ON LIVE V8.48, AND CANNOT WHILE BIGFILL RUNS
`MemberEvicted`: **0** since 2026-08-13. Not a broken valve — no opportunity. Eviction needs the
7-day clock AND a non-NONE `_triageParked` reason, and bigfill self-rescues at 100%.
✅ **OWNER DECISION 2026-08-19: NOT ON LIVE — DO IT IN THE V8.50 PRIVATE DEPLOY.** Full recipe in
the handoff's session 9 addendum. The one thing that must not be forgotten: **the cohort has to
be left UNFUNDED**, because a funded wallet self-rescues and never reaches the valve. That is
precisely why live V8.48 has produced ZERO evictions.

## WHAT IS NEXT
1. **Verify the screenshot upload end to end** (see FIRST ACTIONS).
2. **Ask @bevmawire to retry the Dashboard.** His "Couldn't find your status" was submitted
   13:50 GMT and the outage ran 15:54-16:39, so **his fault predates it and has a different
   cause**. The `LOGS_DEPLOY_FLOOR` fix has now shipped to main. Either it is fixed or there is
   a second, still-unidentified cause.
3. **Restate the `maxItemsPerUpkeep` item against 15**, then confirm deliberately or lower.
4. ⛔ **MEMBER-CALLABLE RE-ENTRY AFTER EVICTION.** V8.50 scope, owner decision 2026-08-19.
   Eviction does NOT clear `globalJoined`; `register()`/`registerWithCoupon()` revert `TRState()`
   for anyone who has ever joined; `autoReentryEnabled`/`doubleReentryEnabled` are read inside
   the CYCLE-OUT handler (TierRouter:1338/:1342) so they need a seat an evicted member no longer
   holds. **The only door today is the onlyOwner `setGlobalJoined(member,false)`**, which
   contradicts the owner's stated intent. Bigfill simulates it via the owner override as an
   INTERIM measure (BIGFILL_RULES.md action 4). Design notes: `_recordJoin` is already idempotent
   so a return does not double-count `uniqueMembers`; preserve `memberReferrer`; TierRouter is
   under EIP-170 pressure so put any new loop in TierRouterLib from the start.
5. **Eviction end to end in the private deploy** — recipe in the handoff addendum.
6. **Model self-rescue at a non-zero rate.** Still the headline caveat on the PARAM 59 basis, the
   eviction answer and the loans-per-member result.
7. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
8. **The open owner decision above.**

## DO NOT REOPEN
- PARAM 59 (decided, 5000).
- The T2.2 routing concern (nothing reverted).
- Bigfill's SF replenishment (confirmed twice — ledger and live recovery).
- Router placement refusals 11 -> 53 (they were never refusals; 12/12 and 59/59 paired, zero
  orphans both arms. Sessions 7 and 8 still list this as open — ignore them).
- `loanEligible` as a signal the badge is missing (it is `loanHeadroom > 0`, nothing more).

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these
- **AN INSTRUMENT MUST NOT REPORT THE ABSENCE OF WHAT IT CANNOT OBSERVE.**
- **A HANDOFF MUST NOT REPORT WHAT THE INSTRUMENT NEVER ASKED.** (session 10)
- **A FALLBACK MUST REPRODUCE THE WHOLE DEFINITION, NOT JUST THE ARITHMETIC.** `loanHeadroom`
  has two early returns before its formula; the frontend copy had neither and inverted the
  verdict in exactly the configuration an operator reaches for in an emergency. (session 10)
- **A FEATURE THAT RENDERS FOR NOBODY STILL PASSES EVERY CODE REVIEW.** Measure how many real
  users meet a feature's condition before shipping it. The badge was gated at `>= 2` parked
  positions and 107 of 107 members held exactly 1. (session 10)
- **A POPULATION THAT MOVES IN SECONDS CANNOT BE CROSS-CHECKED BY TWO SCRIPTS RUN MINUTES
  APART.** (session 10)
- **`Symbol < BigInt` THROWS IN JAVASCRIPT** — catch a sentinel before any comparison. (session 10)
- **A NEW FORM FIELD NEEDS THREE EDITS:** the input, the payload, and `resetForm`. (session 10)
- **`git commit` CAN FAIL ON A STALE `.git/index.lock`.** Check `Get-Process git` first; if none
  is running the lock is debris and its `CreationTime` says which session left it. (session 10)
- **BEFORE BUILDING A DISCRIMINATOR, PROVE THE TWO CASES DIFFER IN WHAT IT MEASURES.**
- **WHEN TWO DISCRIMINATORS DISAGREE, ONE IS BROKEN.** Do not average them.
- **BUILD EVENT DICTIONARIES FROM `artifacts/`, NEVER FROM HAND-WRITTEN SIGNATURES.**
- **A STATUS PAGE IS NOT A MEASUREMENT.**
- **N ENDPOINTS ON ONE NETWORK PATH ARE NOT N INDEPENDENT OBSERVATIONS.**
- **WHAT CREATED A THING AND WHAT FILLED IT ARE DIFFERENT QUESTIONS.**
- **ARITHMETIC OVER MEASURED NUMBERS IS NOT A MEASUREMENT.**
- **A POOLED MEDIAN OVER A BIMODAL POPULATION DESCRIBES NOBODY.**
- **THE BATCH IS NOT THE POPULATION.**
- **A RE-RUN SHARING AN OUTPUT FILENAME DESTROYS THE EARLIER RESULT.**
- **A DIAL SET IS NOT A DIAL IN FORCE.** Read it BACK.
- Two contracts can declare the same event NAME with different signatures and nothing warns you.
- **Count the state change, not the announcement of it.**
- A declared-but-unimplemented interface function is not a compile error.
- `git commit -m` from PowerShell destroys dollar figures and mangles -> and unicode. Write the
  message to a file and use `git commit -F`.
- **NEVER run `git add -A` or `git commit -a` from the device/Linux side.** core.autocrlf is
  unset there, so 31 files show as modified on line endings alone. Stage explicit paths.
- Select-String with a non-ASCII pattern silently matches NOTHING. Keep patterns ASCII.
- **Library events are NOT in a contract's ABI.** `RescueLoanIssued`/`SelfRescue`/`CoPayRescue`/
  `BalanceCarried` come from `MatrixLogicLib`.
- Parsing one log with several interfaces double-counts every event more than one ABI declares.
- The hardhat provider caps ONE transaction at 2^24 gas — BELOW the 17.8M ceiling.
- A sweep whose later rows test a more depleted world is a false-negative machine.
- `PairManagerV8.rescueReentry` returns a rescued member to their OWN pair. Deliberate.
- Chain pay walks matrix POSITION, not the referral graph (`MatrixLogicLib:1317`).
- Every gas number not taken with `GAS_MATRIX_SIZE=127` is size 7.
- TierRouter's "escrow-zero defect" DOES NOT EXIST.
- `V8_48_KeeperScan.test.js` pins are load-bearing.
- `diag_parked_growth.js` REFUSES to run without `ADDRESSES_FILE`. Do not re-add a default.

## GUARDRAILS — unchanged
Nothing is deployed. No chain has been written to. V8.49 is deployed privately and measured — do
not repoint anything at it. Live V8.48 is the community chain and `.env` line 69 must stay
`deployed_addresses_v8_48.json`. Before any test run whose numbers you intend to trust, use
`npx hardhat compile --force` (and `--config hardhat.v849b.config.js` for the control).
Live keeper scripts still carry `GAS_PER_ITEM_DEFAULT = 3_500_000` — left alone deliberately.
Add at V8.50 deploy time: **LIVE V8.48 STILL CARRIES THE `activateLayer` BUG.**
On the deploy question: **PRIVATE FIRST, not the community.** Do NOT run two chains on Base
Sepolia simultaneously — they collide on wallet nonces.

## THE A/B HARNESS — HOW TO DRIVE IT
```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:AB_SEQ="ab_sequence_s1.json"; $env:AB_CAP="5"
npx hardhat run test_ab/replay.js --config hardhat.v849b.config.js   # control (v849b)
npx hardhat run test_ab/replay.js                                    # subject (V8.50)
```
Optional dials: `AB_EVICT=1`, `AB_QUEUE_EVERY=<n>`, `AB_FLOOR_BPS=<n>`, `AB_CENSUS=1`,
`AB_EQUALIZE=1`. Every dial that changes the answer appears in the output filename.
**Read `mismatchCount` before anything else.**
METHOD FINDING WORTH REUSING: `MATRIX_SIZE` is a CONSTRUCTOR ARGUMENT, so live-size behaviour is
measurable in-process in seconds:
`$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js`

## THE DIAGNOSTICS — WHAT ANSWERS WHAT
Contracts repo, `C:\CryptoNite-Smart-Contracts\CryptoNova\scripts` (read-only, no keys):
| script | answers |
|---|---|
| `probe_keeper_views.js` | which **MatrixKeeper** views exist on the deployed build. Controls first; declares itself VOID if one fails |
| `probe_sf_views.js` | which **StabilityFund** views exist on the deployed build |
| `probe_v848_getters.js` | the broader V8.48 getter probe |
| `diag_badge_preview.js` | what the parked badge would render for every live parked member, and how many members can see it at all |
| `diag_eviction_clock.js` | who can actually be evicted and when — clock AND reason, not just clock |
| `diag_sf_usdc_ledger.js` | ground-truth USDC in/out of the fund. Reconciles exactly |
| `diag_sf_flows.js` | rescue/lending rates. ⚠ its `net/day` column and inflow ATTRIBUTION are VOID; its OUTFLOW column is sound |
| `diag_parked_growth.js` | parked queue growth. ⚠ re-run with `WINDOW=3000`, still owed |

Frontend repo, `C:\CryptoNova-Testnet-App` (all read-only, `node <name>`):
| script | answers |
|---|---|
| `check_rpc.ps1` | per-endpoint health ⚠ only header methods — extend before trusting it |
| `check_chain_scope.mjs` | is a fault Base Sepolia's, or this network path's? |
| `watch_base_sepolia.mjs` | has it recovered? 3-sample streak on BOTH operators, logs to CSV |
| `check_matrix_calls.mjs` | every endpoint asked the same call, side by side |
| `measure_page_rpc.mjs` | page RPC workload + TRUE contract creation blocks |
| `repro_page_load.mjs` | reproduces the page's load shape under a pooled provider |
| `diag_pair_chain.mjs` | every tier's pairs: occupancy, rotations, parked, chainNext |
| `diag_pair1_occupants.mjs` | who is in pair 1 and are they already seated in pair 0 |
| `diag_pair_birth.mjs` | which trigger created each pair (occupancy at birth-1) |

## HOW WE WORK
You drive, decide direction, and make the file edits directly. I run every command and paste
back the output. Copy-paste blocks that name the folder, one step at a time, then wait.
Explain in plain language; I am not deep on the technical side. Do not ask which item to take
next — decide, tell me, and we continue. Ask only when the answer is genuinely mine: a policy or
economic trade-off, not something you can determine from the code or the chain.
Dial back on long chains of runs — prefer fewer, smaller steps over back-to-back batches.
Contracts push to `v8.1`. Frontend pushes to `origin admin`, then `admin:preview` and
`admin:main` (members see MAIN only). There is no third party: every line of this codebase was
written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
