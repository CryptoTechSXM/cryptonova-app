NEXT SESSION BRIEF — V8.50, branch `v8.1`
Written end of session 19, 2026-08-21. Paste this in to open the next session. Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`.
Read `V8_50_HANDOFF.md` section 19 first — 19.0 and 19.2 are the DECISION, 19.10–19.13 are WHAT SHIPPED and what it cost, 19.5 is a correction to a figure three sections were carrying, 19.15 is the one question that is yours — then 18 (18.14/18.16/18.17 especially), 17, 16, then section 7a THE TWO RULES. Everything below is a pointer, not a substitute.

STATE
Contracts `v8.1` — run `git log --oneline -3` and trust that, not a hash written here. Frontend `admin` = `preview` = `main` at `74a1588`. **NOTHING DEPLOYED, NO CHAIN WRITTEN TO.** Sessions 13–19 are measurement plus, in 19, the first code change since 18: THE SPONSORSHIP GATE IS NOW IN THE TREE, SHIPPING INERT.
SUITE: **638 passing / 7 pending / 0 failing**, run 2026-08-21 after the DAO sweep (`suite_session19c.txt`). Two earlier transcripts from the SAME day are not drift and should not be read as such: `suite_session19.txt` 629/8/0 is before `V8_50_GateCost.test.js` was un-skipped (+2 passing, −1 pending); `suite_session19b.txt` 631/7/0 is before the 7 DAO-param tests. **Quote 638/7/0.**

THE RULES
1. Do not hypothesise unless necessary. 2. Measure and test before implementing. When two numbers disagree, the disagreement IS the finding. A number you have not run is not a result. One sample is not a measurement. Build the instrument so it can contradict you.
AND BUILD THE SECOND INSTRUMENT — five sessions, five times it paid. Session 19's arming script reconciles the on-chain counter against the rebuilt registration log and aborts on any disagreement.
⛔ A MEASUREMENT WHOSE CONTROL ARM MOVED IS NOT A MEASUREMENT (17.2).
⛔ A RESULT FILE IS NOT A RESULT (18.1) — check the mtime and the recorded dials before pooling.
⛔ THE A/B WORLD ZEROES THE CLOCKS (`world.js:116-118`, both arms, on purpose). Any A/B result about eviction VOLUME or TIMING is a NO-GRACE UPPER BOUND. Live `evictionGracePeriod` is SEVEN DAYS. Results about eligibility, cost, or what a member keeps are unaffected.

⛔ SETTLED POLICY — DO NOT RE-ASK ANY OF IT
* 16.5, all five (accepted 2026-08-20): keep lending; price it at 20.2% ending in debt vs 10.0%; PARAM 59 stays at 5000; do NOT cut the floor to 40%/20%; do NOT touch `setClawbackBands` for this purpose; the exit is sponsorship.
* ⛔⛔ 18.14, THE OWNER: **YES, A REFUSED LOAN ROUTES TO EVICTION.** Verbatim: *"we are giving some passive earnings and one needs to help themselves in order to earn so invite, self rescue or get evicted."* The three-way IS the design.
* ⛔ 18.18 + 19.0: **BASE CEILING = 3000 bps ($3.00 at T1).** The one named overturn test was run in 19 and did not trigger. Only a live V8.50 shortfall distribution could move it now, and that needs V8.50 live plus weeks (19.6).
* The lending investigation (13→16) is CLOSED — never requote 13.5's 7.1/31.7 or 15.2's 2.4/31.8; the balanced pair is 8.0% vs 19.6%.
* ⛔ NEW, 19.5: **NEVER REQUOTE 13.11's "4.5x".** One day later the clean side was stable (52.3% → 52.0%) but the owing side went 11.5% → 26.5%, so the multiple is 2.0x. Quote the DIRECTION, and quote it off 19.4's at-loan-time table instead.

✅ WHAT SESSION 19 CLOSED
* **18.21 ITEM 1 — THE LIVE `directCount` CROSS.** Live V8.48, blocks 45430468..45756873, 406 members, 405 referrer edges, all ranges clean. Zero-direct share of MEMBERS: live organic **56.1%** vs fixture 49.7% = 1.13x. Zero-direct share of ADVANCES at that block: live organic **59.2%** vs fixture 30.6% = **1.94x**. ⛔ THE TWO RATIOS DISAGREEING IS THE RESULT: in the fixture zero-direct members are UNDER-represented among borrowers, on live they are OVER-represented. The gate's target population is not rarer here — it borrows nearly twice as often for its size, which is the case FOR the gate.
* Projection (LABELLED, not a run): base 3000 refuses ~31.9% of advances vs the fixture's 16.5%, ~11.6 FLOOR refusals per 288 members per run against 6. Double the bite, not an order of magnitude, and still a no-grace upper bound.
* ✅ THE STRONGEST PRO-GATE NUMBER, live, no hindsight — repayment by directs held AT LOAN TIME: 0 directs **183 loans, 52.0% repaid**; 1 direct 60.0%; 2 directs **94.1%**; 3+ 100%.
* **THE ITEM-43 DAO SWEEP (19.17), owner decision 2026-08-21: "anything owner can change should also be DAO governance where possible."** 55 gated setters, 47 already had a path, 8 did not. FIVE ADDED — 64 clawback preset, 65 `baseAdvanceBps`, 66 self-funded grace, 67 frozen-MatB timeout, 68 ghost entry. `PARAM_MAX_ID` 63 → 68. THREE LEFT OUT ON PURPOSE: `setTierGateThreshold` and `setTierWhaleGateActive` take two arguments (unreachable by construction; ids 52-57 already cover what matters), and `setUpkeepCaller` is authorization not economics — a compromised keeper key must be revocable in minutes, not by vote + 48h timelock.
* ✅ **A SIDE EFFECT WORTH MORE THAN THE ITEM: THE DAO CAN NOW SWITCH THE GATE OFF IN ONE VOTE.** Param 65's menu includes 10000, and base >= floor is inert. Owner arms via PHASE 7b, DAO can reverse. No redeploy either way.
* **18.21 ITEM 3 — THE GATE IS BUILT.** `TierRouter.directCount` (one write site, in `_bookkeepJoin`) + `StabilityFund.baseAdvanceBps`/`setBaseAdvanceBps`/the branch in `loanHeadroom`. 11 new tests, suite green.

⛔⛔ THE TWO THINGS A FUTURE SESSION MUST NOT UNDO
* **IT SHIPS INERT AT 10_000 AND THAT IS DELIBERATE.** `directCount` does NOT backfill — these contracts have no proxy machinery, V8.50 is a fresh deploy, so on migration day every member reads 0 directs including one who sponsored twenty. Arming early refuses real members for an EMPTY COUNTER. Arm it with GO_LIVE_RUNBOOK **PHASE 7b** after the tree rebuilds. Measured: an inert gate costs EXACTLY ZERO gas (GATE-2).
* **THE READ SHORT-CIRCUITS AND FAILS OPEN.** `baseAdvanceBps < bps` is checked BEFORE the router, and the read is in try/catch. A gate that cannot read its counter must refuse nobody — `loanHeadroom` reverting would take a whole keeper batch with it.

MEASURED IN 19
* SIZE with the gate in: TierRouter **24,046 / 530 spare**, StabilityFund **15,513 / 9,063 spare**. ⚠ The baseline was not re-run; the +136/+450 deltas come from 17.1's record.
* GAS, armed: **5,634 cold / 1,134 warm** per `loanHeadroom` call. ⛔ 17.1's fixture read 7,720 / 1,220. Gaps of 2,086 and 86 land within opcode noise of ONE SLOAD at each temperature — consistent with the fixture charging a `baseAdvanceBps` SLOAD to its delta that the shipped form cancels. ⚠ **UNVERIFIED — an inference from two arithmetic agreements, not a run.**
* ⛔ DO NOT CARRY 18.5's +0.41% forward as "the gate's cost" — it priced the always-read fixture.

NEXT, IN ORDER (19.8)
1. **EXERCISE `EvictionReserveReleased`** (18.15) — **A HARDHAT UNIT TEST, NOT A DEPLOY, AND IT MUST TARGET `:523`.** ⛔ Read 19.18 first; it corrects two things every earlier section got wrong. (a) `evictParked` needs only: parked, NOT seated in this matrix or the partner, reserve > 0 — no chain, no keeper, no clock. Every "needs the private deploy" line was reasoning from how the state arises ORGANICALLY, not from what the function requires. (b) THE UNREACHABILITY TABLE IS WRONG ON `:906` — it parks only members already seated in the partner, which IS the ghost test, so it dequeues and releases nothing. **One door survives: `:523` cascade-refill on entry** (parked at line 527, reserve credited at 539 in the same tx). A test aimed at `:906` will pass while proving nothing.
2. **LENGTHEN THE A/B TAIL** until `stillParkedAtEnd` approaches zero, so loan counts stop being censored (18.19).
3. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
4. **PRICE THE CLAWBACK PRESETS ON THE A/B HARNESS** before anyone recommends moving off preset 2. The menu now exists (19.17) but only preset 2 has evidence behind it — 16.x measured this clawback collecting $0.00 inside a MatB occupancy and recorded that its real effect is UNMEASURED. One dial, three seeds, same shape as the base-ceiling sweep.
5. **POST-MIGRATION, NOT BEFORE:** PHASE 7b — pre-flight, check the live histogram against 19.1's 56.1%/49.7%, then arm at 3000. Then re-run section 4 + the loan book on live V8.50.
6. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic); `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry.

TOOLS THAT NOW EXIST — use them, do not rebuild them
* `scripts/diag_referral_threshold.js` **SECTION 4** — live directCount histogram by cohort, directs at the moment of the advance, the fixture's tree read off `ab_sequence_s*.json`, and the crossing with the live and fixture halves labelled separately. Aborts if no member has any direct (the address-case fault that would look like the strongest possible finding).
* `scripts/set_base_advance.js` — READ-ONLY unless `ARM=1`. Rebuilds expected `directCount` from the registration log, reconciles against the chain, ABORTS on disagreement, prints the histogram. This is how the gate gets armed; never call `setBaseAdvanceBps` by hand.
* `test/V8_50_GateBase.test.js` (11) and `test/V8_50_GateCost.test.js` (2, UN-SKIPPED in 19 and rewritten for the shipped short-circuit).
* `test/V8_50_DaoParams.test.js` (7) — the clawback preset, and **DP-5, which feeds EVERY value of EVERY new governance menu to its real target setter.** A menu and a setter are two lists of one thing; when they drift, a proposal wins its vote, waits out the timelock and THEN reverts. Do not replace that test with an eyeball comparison.
* `test_ab/replay.js` LOAN BOOK and EVICTION LEDGER; `AB_GATE_BPS` in `test_ab/world.js` (still works — it tests for the setter, which now ships).
* ⛔ `scripts/fixture_gate_apply.js` is **SUPERSEDED — DO NOT RUN IT.** Its anchors no longer match. Kept only as the record of what 17.1/18.4/18.6 were measured on.
* Sweep recipe, no fixture step any more: `npx hardhat compile`, then `$env:AB_CAP="5"`, `$env:AB_EVICT="1"`, `$env:AB_GATE_BPS="<n>"`, `$env:AB_SEQ="ab_sequence_s<n>.json"`, `npx hardhat run test_ab/replay.js`.

TRAPS, CARRIED FORWARD
* ⚠ ORPHAN FRAGMENTS THAT LOOK LIKE ENTRY POINTS: `handover_session13.md` and `archive/_session13_*.md` are untracked, superseded session-13 leftovers. The entry point is `V8_50_HANDOFF.md` (newest section first) then `V8_50_SCOPE.md`.
* ⚠ A MECHANISM TABLE IN A HANDOFF IS AN ASSERTION, NOT A MEASUREMENT (19.18b). The `EvictionReserveReleased` reachability table was written from a source walk and carried for several sessions before anyone re-read the two rows it concludes with — one was wrong. **When a table is what sends you to work, re-walk it before you follow it.**
* ⛔ RESOLVED 2026-08-21 — THE MECHANISM OF THE LINE-ENDING TRAP IS `core.autocrlf`. Git said so out loud on the session-19 commit: `warning: in the working copy of '<file>', LF will be replaced by CRLF the next time Git touches it`, on all 11 files. The repo stores LF, the owner's working tree is CRLF, and Claude's bridge writes LF — so a file Claude has just written reads a different BYTE COUNT from one git considers clean, with a ZERO-LINE diff. **THE WARNING IS BENIGN AND WILL FIRE ON EVERY FILE CLAUDE WRITES THROUGH THE BRIDGE. It is not a finding and it needs no action.** The proof it does no harm is the commit's own stat line: 11 files, 1,350 insertions, 113 deletions — the size of the real changes, not a whole-file rewrite. STILL TRUE: never `git add -A`, and if a diff ever looks like whole-file churn, run `--ignore-all-space` and trust YOUR `git status`.
* THE GATE ONLY LOWERS THE CEILING FOR MEMBERS WITH ZERO DIRECTS. The wrong column is the intuitive one.
* A GATE THAT EXISTS IS NOT A GATE THAT BINDS (14.3); a gate installed to be MEASURED must not bind (17.2). ⚠ And as of 19 the shipped gate exists and does not bind BY DEFAULT — check `baseAdvanceBps` on chain before reading anything as a gate effect.
* READING SOURCE MEASURES THE MECHANISM, NOT THE POPULATION — valid for where code lives, which is how 19.11 and 19.12 were settled.
* `parkRefusalsRouter` is NOT a refusal count.
* THE A/B TAIL DOES NOT DRAIN THE QUEUE (18.19) — late rescues are censored in both arms.
* A WINDOW THAT LEAKS INVENTS A FINDING (16.1). DECISIVE ≠ COVERAGE — quote both or neither.
* AN INSTRUMENT'S RESOLUTION IS PART OF ITS RESULT. `V8_50_KeeperGas` prints to 0.01M; a 5,634-gas change reads as +0.01M. Agreement, not absence.
* THE AB WORLD IS A FIXTURE. Its referral tree is real but it is not the live distribution — and 19.2 measured exactly how far apart they are on the column that matters. Say so with every gate number.

HOW WE WORK
You drive and decide direction; you make the file edits; I run every command and paste back the output. Copy-paste blocks that name the folder, one step at a time, then wait. Plain language — I am not deep on the technical side. Do not ask which item to take next: decide, tell me, and we continue. Ask only when the answer is genuinely mine (a policy or economic trade-off) — 19.15 is one of those. Fewer, smaller steps — converge on the decision rather than chasing every thread; park the rest in the handoff. Contracts push to `v8.1`; frontend `origin admin` → `admin:preview` → `admin:main`. There is no third party: every line here was written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
