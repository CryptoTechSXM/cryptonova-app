# NEXT SESSION BRIEF — V8.50, "the crossing redesign", branch `v8.1`
Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`. Written at the end of session 9,
2026-08-19. Paste this in as the opening message of the next session.

Read `V8_50_HANDOFF.md` in this order and nothing else first:
1. section 7a — THE TWO RULES. Short, owner-set, non-negotiable.
2. SESSION 9 STATE at the top — the newest. It contains UNCOMMITTED WORK and an
   UNRUN SUITE, which is why it is first.
3. SESSION 8 STATE below it — the PARAM 59 curve and the eviction answer. Still stands.
4. SESSION 7 STATE below that — the corrected A/B and the velocity fix. Still stands.
5. SESSION 6 STATE below that — its park/loop table is WITHDRAWN; its FUND table holds.

## THE TWO RULES — these govern everything
1. Do not hypothesise unless necessary.
2. Measure and test before implementing. Never build on a hypothesis.

Practical form: when two numbers disagree, the disagreement IS the finding — measure it,
do not explain it. A number you have not run is not a result. One sample is not a
measurement. Arithmetic over measured numbers is NOT a measurement.

**SESSION 9 EXTENDS THIS, AND IT IS THE SAME LESSON FOUR MORE TIMES: AN INSTRUMENT MUST
NOT REPORT THE ABSENCE OF SOMETHING IT CANNOT OBSERVE.**
- `check_rpc.ps1` reported "all six endpoints healthy" DURING a total outage — it only
  sent `eth_chainId` and `eth_blockNumber`, the two methods that had not broken.
- `diag_pair_chain.mjs` reported "pair 1 IS receiving graduates" from pair 1 having
  members, without checking the source MatB had ever rotated. It had not. Zero rotations
  means zero graduates.
- `diag_pair_birth.mjs` reported "no registration in this tx" because its hand-written ABI
  guesses did not match the deployed signatures — everything decoded as `unknown(0x...)`.
- Worse, and the ABI fix would not have caught it: **that script's whole discriminator was
  incapable of discriminating.** It assumed "registration tx = routine trigger, cycle-out
  tx = on-demand spawn", but `_tryAdvancePair()` is the first statement of EVERY entry
  path, so tx type carries no information at all. **Before building a discriminator, prove
  the two cases actually differ in what it measures.**

Corollary that saved the session: **when two discriminators disagree, one of them is
broken — go find out which.** Do not average them.

## ⛔ START HERE — THERE IS UNCOMMITTED WORK AND AN UNRUN SUITE
**Nothing from session 9 is committed, in either repo.** First action:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat compile --force
npx hardhat test 2>&1 | Tee-Object -FilePath suite_after_param59.txt
```
Expect **611 passing / 7 pending / 0 failing**. Anything red is a test that pinned the old
$3.40 ceiling and was missed. Only then commit — explicit paths, never `git add -A`.

## WHAT IS DONE — do not re-derive any of this
- **PARAM 59 = 5_000. OWNER DECISION 2026-08-19, LANDED IN SOURCE.** Basis (AB_FLOOR_BPS
  curve, 5 values x 3 seeds) written at the declaration in `StabilityFund.sol`. 5000 was
  already on the DAO menu so no governance change was needed. `V8_48_KeeperScan.test.js`
  still probes 3_400 ON PURPOSE — it is the cliff probe, not the shipping value.
- Item E1 + defects 2,4,5,6,7,8,9, ladder preset 1, tier gates, item D, frontend ABI
  audit — settled earlier. `minGasPerItem` 5M (owner decision, measured).
- GATE MEASUREMENTS 1 AND 2 — answered, no chain needed. Cold SF-funded rescue at live
  `MATRIX_SIZE` 127 costs 4.37M; ~23k per matrix position. Guard halts cleanly, defers.
- THE 68 VELOCITY `WorkItemFailed` ARE EXPLAINED, FIXED AND GONE. `activateLayer` was
  declared and implemented NOWHERE. **LIVE V8.48 STILL HAS IT.**
- THE ~10x EVICTIONS ARE EXPLAINED AND REPLICATED 3/3. NOT a defect.
- Loans: 159 loans, 159 distinct members, max 1 each. The second rescue is SELF-FUNDED —
  MatB re-entry costs a loan; the A->B crossing is covered by the reserve and costs nothing.
- **SESSION 9: the owner's T2 routing concern is CLOSED. Nothing reverted.** Both extra
  pairs were created by the routine 90% trigger (T1 at 92.1%, T2 at 90.6%). `_forceExpand()`
  never fired and cannot — `_tryAdvancePair()` runs first and always leaves a free pair, so
  the "normally unreachable" comments STAND. Separately and also true: T2.2 was FILLED by
  the double-entry path — 5 of 5 occupants already seated in T2.1's MatB. Two different
  questions; both mechanisms fired in the same transaction, in that order.
- **SESSION 9: chain wiring verified correct on every tier** — each MatB's `chainNext` is
  the next pair's MatA, last MatB closes the circle back to pair 0.
- **SESSION 9: T1.2 being empty is NOT starvation.** Before T1.2 existed, `chainNext`
  pointed T1.1's MatB back at its own MatA (why MatA has 599 rotations vs MatB's 447).
  T1.2 is empty because MatB has not rotated since it was wired in.
- Suite: 611 passing / 7 pending / 0 failing **as of session 8** — NOT re-run since.
  Latest commit `c177938` on `v8.1`.

METHOD FINDING WORTH REUSING: `MATRIX_SIZE` is a CONSTRUCTOR ARGUMENT. Live-size behaviour
is measurable in-process in seconds:
`$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js`

## OWNER FRAMING — IT DECIDES WHAT COUNTS AS A DEFECT
- **Members are NOT meant to cross forever.** The bar is one or two loans.
- **Nobody can get stuck at the A->B crossing.** (MatA parkers were evictable in 0 of 258.)
- **Members are EXPECTED to take loans and be evicted if they never invite anyone.**
- **Customer-facing issues get priority, even on testnet** (stated 2026-08-19).

## 🚨 THE LIVE V8.48 INCIDENT, 2026-08-19 — RESOLVED, AND IT WAS NOT OUR CODE
Base Sepolia stopped serving STATE READS while still producing blocks: `eth_call` and
`eth_getCode` returned HTTP 503 on five QuickNode endpoints AND on Coinbase's
`sepolia.base.org`, while `eth_blockNumber` kept returning a fresh advancing head. Base
mainnet and Ethereum Sepolia answered fine from the same machine in the same minute — that
control is what made the conclusion safe. status.base.org said "All Systems Operational"
throughout and was wrong. Down 15:54 UTC, flapping 16:14-16:38, stable from 16:39.

**One cause, four symptoms** — `occupancy()` fails so ethers reports `missing revert data`;
the same failure inside `rpc()` loses its 8s race and `.catch(()=>null)` paints `—`; the
keeper reads state the same way. **Parked rescues stall for the duration.**

If it recurs: `node watch_base_sepolia.mjs` in `C:\CryptoNova-Testnet-App`. It calls
recovery only on 3 clean samples on BOTH operators — a flapping service returns single
green reads, and it did.

## ⛔ ONE OWNER DECISION IS STILL OPEN — ASK, DO NOT DECIDE
**LIVE V8.48 — leave organic, bigfill, or fund the SF?**
⛔ **SESSION 8'S REASONING IS WITHDRAWN. THE OWNER CORRECTED IT 2026-08-19 AND HE IS RIGHT
ON MECHANISM.** Session 8 wrote "bigfill does not replenish", from a single bps figure the
same document flagged as unconfirmed. Three inflows were missed, and one of them dominates:
  1. each run registers 1-5 new wallets -> entry fee -> stability split to the SF;
  2. each run UPGRADES to the highest eligible tier -> T2 $25 / T3 $50 fees carry a
     proportionally larger stability split than a $10 registration;
  3. each run SELF-RESCUES -> the crossing fee is still distributed (SF gains its split)
     AND no SF loan is drawn.
**(3) IS THE BIG ONE AND IT IS NOT AN INCOME ARGUMENT — IT IS AVOIDED OUTFLOW.** A wallet
that self-rescues does not draw the $3.42-$4.52 SF share AND still pays in. Against the
passive case that is a swing of roughly $4 per event, an order of magnitude above the
$0.238-$0.30 registration credit that session 8 reasoned from.
⛔ **CONSEQUENCE — THE DRAIN SERIES IS CONTAMINATED, SO "PRESERVE THE BEFORE-PICTURE" IS
DEAD AS AN ARGUMENT.** The bigfill wallets remain seated whether or not bigfill runs. With
it stopped they still cycle out, still park and are still SF-rescued, but they no longer
register, upgrade or self-rescue. Stopping bigfill removed the income and left the
liability, which makes the population 100% PASSIVE BY CONSTRUCTION — the same pathological
extreme as `SELF_RESCUE_RATE = 0` in the A/B harness. The ~$125/day drain may be an
artifact of the measurement regime rather than a property of the economics.
✅ **MEASURED 2026-08-19 — THE OWNER IS RIGHT, DECISIVELY, ON GROUND-TRUTH USDC.**
`scripts/diag_sf_usdc_ledger.js` reads every USDC Transfer in and out of the fund and
reconciles EXACTLY: in $1,401.79, out $1,364.86, balance $36.94 = `balanceOf` = 
`totalBalance()`. **There is no leak.** Daily net against regime, over V8.48's whole life:

| day | regs | USDC net | regime |
|---|---|---|---|
| 08-13 | 187 | +$72.87 | bigfill |
| 08-14 | 115 | +$75.82 | bigfill |
| 08-15 | 20 | +$81.39 | bigfill |
| 08-16 | 34 | +$214.74 | bigfill |
| 08-17 | 5 | -$114.31 | quiet |
| 08-18 | 2 | -$185.02 | quiet |
| 08-19 | 1 | -$108.55 | quiet |

**Four bigfill days all positive, three quiet days all negative, NO OVERLAP.** Averages
**+$111/day running vs -$136/day stopped**. The -$136 matches the ~$125/day "drain" the
handoff recorded, confirming that series measured the PASSIVE regime and nothing else.
Peak was $444.82 on 08-16; it has fallen every day since bigfill stopped.
Mechanism, from `diag_sf_flows.js` (its outflow column reconciles to the contract counter):
stopping bigfill took keeper rescues 11.5 -> 44.3/day and SF lending $76.72 -> $345.68/day,
while self-rescues fell 73.5 -> 16.0/day.

⚠ **TWO FIGURES FROM `diag_sf_flows.js` ARE VOID — DO NOT QUOTE THEM.** Its `net/day` column
double-counts repayments and treats `FundDeposit` EVENTS as cash (they overstate real
inflow by ~$300 over this range); use the USDC ledger instead. And its inflow ATTRIBUTION
shows "keeper-rescue 58.6%" because a rescue still distributes a crossing fee — keeper
rescues are the fund's single largest COST, not its largest source.

⚠ **NEITHER REGIME IS THE REAL WORLD** — bigfill wallets self-rescue and upgrade every time
(~100%), stopped they do neither (0%). Real members sit between, so -$136 and +$111 are a
BRACKET, not the answer. This is now the best empirical anchor available for the open
"model self-rescue at a non-zero rate" item.

⛔ **AND THE FUND IS AT $36.94 AGAINST $735.73 OUTSTANDING.** At the quiet-regime rate it is
already effectively empty. Whatever is decided, it is not a decision that keeps.
⚠ Operational constraint that survives regardless: restarting bigfill on Base Sepolia
collides with a future V8.50 private deploy on wallet nonces. Sequence them, never overlap.
**⚠ RE-MEASURE FIRST.** The figures are days old and the fund has moved — the status page
read **$87.50** on 2026-08-19 against $212.35 previously. Prerequisite: re-run
`diag_parked_growth.js` with `WINDOW=3000` (its last run reported 9 failed ranges while its
SF section reconciled exactly — those two statements are in tension). Also confirm 238 bps
against the LIVE deployment; it was read from the harness config.


## ⛔ THE TRAP THAT COST THE MOST ON 2026-08-19 — READ BEFORE WRITING ANY CHAIN CODE
**The repo tree is V8.50. The community chain is V8.48.** A view added after V8.48 reverts
there with `missing revert data` — which looks exactly like a network fault and is not one.
Hit three times in one hour:
- `evictionGracePeriod()` is V8.49 (`b14eba7`); V8.48 has `extendedIdleTimeout()`, same 7 days.
- `loanHeadroom(addr,u8)` is V8.49 item 1b (`40d7843`); on V8.48 derive it as
  `tierEntryFees(t) * insolvencyFloorBps / 10000 - memberDebt(who)`.
- The same call was in brand-new dashboard code, where it would have made EVERY badge read
  "CHECKING" on the live chain while the feature looked healthy.
**Check every chain call against the DEPLOYED ABI, not the source tree.** Use
`scripts/probe_v848_getters.js` / `scripts/probe_sf_views.js`; extend them, do not re-invent.

## EVICTION — NEVER FIRED ON LIVE V8.48, AND CANNOT WHILE BIGFILL RUNS
`MemberEvicted`: **0** since 2026-08-13. Not a broken valve — no opportunity. Eviction needs
the 7-day clock AND a non-NONE `_triageParked` reason, and bigfill self-rescues at 100%, so
members are rescued first (54 of 57 in one run). Soonest clock of any parked member: **5.41
days**. ✅ **OWNER DECISION 2026-08-19: NOT ON LIVE — DO IT IN THE V8.50 PRIVATE DEPLOY.** ("we are
definitely not going to make the 6 days, we will have a deploy before that.") Nothing is
being held back for those candidates; bigfill may self-rescue freely.
**The private chain removes the timing problem:** `evictionGracePeriod` is DAO param 62 with
a setter — untouchable on live because it moves every real member's deadline, but on a chain
with no members set it to MINUTES. Full recipe in the handoff's LATE-SESSION ADDENDUM; the
one thing that must not be forgotten is that the cohort has to be left UNFUNDED, because a
funded wallet self-rescues and never reaches the valve. That is precisely why live V8.48 has
produced ZERO evictions in 6 days.

## WHAT IS NEXT
1. **Run the suite, then commit both repos.** See "START HERE".
2. **Ship the frontend `LOGS_DEPLOY_FLOOR` fix** (44,840,000 -> 45,428,000, already edited
   and unpushed) and re-run `measure_page_rpc.mjs` on the healthy chain to confirm 95 -> 30
   windows. The script reads the constant BACK from index.html, so the re-run verifies the
   shipped value. **Its real defect is that the constant goes stale by design** — the head
   moves ~43,200 blocks/day and the floor does not. The structural fix is `opts.fromBlock`
   caching, which `safeGetLogs` already supports and no call site uses.
3. The open owner decision above.
5. ⛔ **NEW V8.50 SCOPE ITEM — MEMBER-CALLABLE RE-ENTRY AFTER EVICTION.** Owner decision
   2026-08-19. Verified in the contracts that day: eviction does NOT clear `globalJoined`,
   `register()`/`registerWithCoupon()` revert `TRState()` for anyone who has ever joined,
   and `autoReentryEnabled`/`doubleReentryEnabled` are read inside the CYCLE-OUT handler
   (TierRouter:1338/:1342) so they need a seat an evicted member no longer holds.
   **AN EVICTED MEMBER CANNOT RETURN ON THEIR OWN — the only door is the onlyOwner
   `setGlobalJoined(member,false)`.** That contradicts the owner's stated intent that
   evicted members come back and pay their fees. Bigfill now simulates it via the owner
   override (see BIGFILL_RULES.md action 4) as an INTERIM measure with a stated expiry;
   the contract path is what makes the test honest. Design notes: `_recordJoin` is already
   idempotent so a return does not double-count `uniqueMembers` or reset the join clock;
   preserve `memberReferrer` so referral history is not rewritten; TierRouter is under
   EIP-170 pressure so put any new loop in TierRouterLib from the start.
4. **Router placement refusals, 11 -> 53** on V8.50. Still unexplained.
5. **Model self-rescue at a non-zero rate.** Blocking more than before — the eviction
   answer, the PARAM 59 curve and the loans-per-member result ALL carry
   `SELF_RESCUE_RATE = 0` as their headline caveat.
6. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
7. **`maxItemsPerUpkeep` is vestigial** at 20. Confirm deliberately or lower to 10.

## TRAPS THAT HAVE ALREADY COST TIME — do not rediscover these
- **AN INSTRUMENT MUST NOT REPORT THE ABSENCE OF WHAT IT CANNOT OBSERVE.** Four instances
  in session 9 alone; see THE TWO RULES above.
- **BEFORE BUILDING A DISCRIMINATOR, PROVE THE TWO CASES DIFFER IN WHAT IT MEASURES.**
- **WHEN TWO DISCRIMINATORS DISAGREE, ONE IS BROKEN.** Do not average them.
- **BUILD EVENT DICTIONARIES FROM `artifacts/`, NEVER FROM HAND-WRITTEN SIGNATURES.**
  227 real signatures vs 9 guesses; a wrong guess decodes as `unknown(0x...)` and reads as
  "the event did not happen".
- **A STATUS PAGE IS NOT A MEASUREMENT.**
- **N ENDPOINTS ON ONE NETWORK PATH ARE NOT N INDEPENDENT OBSERVATIONS.** Test another
  chain from the same machine before blaming an upstream.
- **WHAT CREATED A THING AND WHAT FILLED IT ARE DIFFERENT QUESTIONS.**
- **ARITHMETIC OVER MEASURED NUMBERS IS NOT A MEASUREMENT.**
- **A POOLED MEDIAN OVER A BIMODAL POPULATION DESCRIBES NOBODY.**
- **THE BATCH IS NOT THE POPULATION.** Discovery reaches queue indices 0-2 of a 31-deep queue.
- **A RE-RUN SHARING AN OUTPUT FILENAME DESTROYS THE EARLIER RESULT.** Every dial that
  changes the answer goes in the filename.
- **A DIAL SET IS NOT A DIAL IN FORCE.** Read it BACK.
- Two contracts can declare the same event NAME with different signatures and nothing warns
  you. Bucket by name PLUS arity, or by topic0.
- **Count the state change, not the announcement of it.**
- A declared-but-unimplemented interface function is not a compile error.
- `git commit -m` from PowerShell destroys dollar figures and mangles -> and unicode. Write
  the message to a file and use `git commit -F`.
- **NEVER run `git add -A` or `git commit -a` from the device/Linux side.** core.autocrlf is
  unset there, so 31 files show as modified on line endings alone. Stage explicit paths.
- Select-String with a non-ASCII pattern silently matches NOTHING. Keep patterns ASCII.
- **Library events are NOT in a contract's ABI.** `RescueLoanIssued`/`SelfRescue`/
  `CoPayRescue`/`BalanceCarried` come from `MatrixLogicLib`.
- Parsing one log with several interfaces double-counts every event more than one ABI
  declares. Ratios survive; raw totals are wrong.
- The hardhat provider caps ONE transaction at 2^24 gas — BELOW the 17.8M ceiling.
- A sweep whose later rows test a more depleted world is a false-negative machine.
- `PairManagerV8.rescueReentry` returns a rescued member to their OWN pair. Deliberate.
- Chain pay walks matrix POSITION, not the referral graph (`MatrixLogicLib:1317`).
- Every gas number not taken with `GAS_MATRIX_SIZE=127` is size 7.
- TierRouter's "escrow-zero defect" DOES NOT EXIST.
- `V8_48_KeeperScan.test.js` pins are load-bearing.
- `diag_parked_growth.js` REFUSES to run without `ADDRESSES_FILE`. Do not re-add a default.

## GUARDRAILS — unchanged
Nothing is deployed. No chain has been written to. V8.49 is deployed privately and measured
— do not repoint anything at it. Live V8.48 is the community chain and `.env` line 69 must
stay `deployed_addresses_v8_48.json`. Before any test run whose numbers you intend to trust,
use `npx hardhat compile --force` (and `--config hardhat.v849b.config.js` for the control).
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

## THE LIVE-SITE DIAGNOSTICS — built session 9, all in `C:\CryptoNova-Testnet-App`
All read-only, no wallet, no keys. Run with `node <name>` (or `powershell -File` for .ps1).
| script | answers |
|---|---|
| `check_rpc.ps1` | per-endpoint health ⚠ only header methods — extend before trusting it |
| `check_chain_scope.mjs` | is a fault Base Sepolia's, or this network path's? |
| `watch_base_sepolia.mjs` | has it recovered? 3-sample streak, logs to CSV |
| `check_matrix_calls.mjs` | every endpoint asked the same call, side by side |
| `measure_page_rpc.mjs` | page RPC workload + TRUE contract creation blocks |
| `repro_page_load.mjs` | reproduces the page's load shape under a pooled provider |
| `diag_pair_chain.mjs` | every tier's pairs: occupancy, rotations, parked, chainNext |
| `diag_pair1_occupants.mjs` | who is in pair 1 and are they already seated in pair 0 |
| `diag_pair_birth.mjs` | which trigger created each pair (occupancy at birth-1) |

## HOW WE WORK
You drive, decide direction, and make the file edits directly. I run every command and paste
back the output. Copy-paste blocks that name the folder, one step at a time, then wait.
Explain in plain language; I am not deep on the technical side. Do not ask which item to
take next — decide, tell me, and we continue. Ask only when the answer is genuinely mine:
a policy or economic trade-off, not something you can determine from the code or the chain.
Dial back on long chains of runs — prefer fewer, smaller steps over back-to-back batches.
Contracts push to `v8.1`. Frontend pushes to `origin admin` (admin -> preview -> main;
members see MAIN only). There is no third party: every line of this codebase was written
by a previous session of you and executed by me. Write handoffs to yourself accordingly.
