NEXT SESSION BRIEF — V8.50, branch `v8.1`
Written end of session 18, 2026-08-20. Paste this in to open the next session. Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`.

Read `V8_50_HANDOFF.md` section 18 first — 18.14 and 18.18 are the DECISIONS, 18.16 is who the gate refuses, 18.17 is the caveat that reframes it, 18.8 is the design correction, 18.1 and 18.19 are the method lessons — then 17, 16, 15, 14, then section 7a THE TWO RULES. Everything below is a pointer, not a substitute.

STATE
Contracts `v8.1` — run `git log --oneline -3` and trust that, not a hash written here. Frontend `admin` = `preview` = `main` at `74a1588`. NOTHING DEPLOYED, NO CHAIN WRITTEN TO. Session 18 applied session 17's gate fixture, ran a 20-run sweep, and REVERTED it — the owner's own `git status --short contracts/` came back empty, which is the authoritative reading. Sessions 13–18 are measurement only.
SUITE: 618 passing / 8 pending / 0 failing as of the end of session 17. ⚠ NOT re-run in session 18 — nothing in `contracts/` or `test/` changed, only `test_ab/` (which the suite does not run). If you need the number, run it; do not quote it as re-verified.

THE RULES

1. Do not hypothesise unless necessary. 2. Measure and test before implementing. When two numbers disagree, the disagreement IS the finding. A number you have not run is not a result. One sample is not a measurement. Build the instrument so it can contradict you.

AND BUILD THE SECOND INSTRUMENT — four sessions, four times it paid. Session 18's loan-book counterfactual predicted 7/14/18/22 refusals and the replayed sweep lost 7/13/18/19.

⛔ A MEASUREMENT WHOSE CONTROL ARM MOVED IS NOT A MEASUREMENT (17.2). Session 18 obeyed it: the fixture was installed non-binding first and reproduced the ungated run exactly on all three seeds before a single sweep row was believed.

⛔ AND THE TWO SESSION 18 EARNED:
* A RESULT FILE IS NOT A RESULT. It is a result AS OF an instrument version and a dial set. AB seeds 2/3 on disk were a day older than seed 1, recorded no `insolvencyFloorBps`, and predated PARAM 59 = 5000; pooling them reported "evictions +1150%" against the true +500%. CHECK THE MTIME AND THE RECORDED DIALS BEFORE POOLING ANY RESULT FILE WITH A FRESH ONE.
* THE A/B WORLD ZEROES THE CLOCKS (`world.js:116-118` sets all three grace periods to 0, both arms, on purpose). ANY A/B RESULT ABOUT EVICTION VOLUME OR TIMING IS A NO-GRACE UPPER BOUND and must say so. Live `evictionGracePeriod` is SEVEN DAYS. Results about eligibility, cost, or what a member keeps are unaffected.

⛔ SETTLED POLICY — DO NOT RE-ASK ANY OF IT
* 16.5, all five (accepted 2026-08-20): keep lending; price it at 20.2% ending in debt vs 10.0%; PARAM 59 stays at 5000; do NOT cut the floor to 40%/20%; do NOT touch `setClawbackBands` for this purpose; the exit is sponsorship.
* ⛔⛔ 18.14, THE OWNER 2026-08-20: **YES, A REFUSED LOAN ROUTES TO EVICTION.** Verbatim: *"we are giving some passive earnings and one needs to help themselves in order to earn so invite, self rescue or get evicted."* The three-way — invite, self-rescue, or be evicted — IS the design.
* ⛔ 18.18, CLAUDE'S CALL UNDER THAT RULE: **BASE CEILING = 3000 bps ($3.00 at T1).** Only two things would overturn it: the owner preferring a backstop that almost never fires (then $4.00, one dial), or item 1 below coming back very different from the fixture.
* The lending investigation (13→16) is CLOSED — never requote 13.5's 7.1/31.7 or 15.2's 2.4/31.8; the balanced pair is 8.0% vs 19.6%.

✅ WHAT SESSION 18 CLOSED

* 17.7 ITEM 1 COULD NOT HAVE BEEN RUN AS WRITTEN. 14.1's clean columns are the member-specific ones (14.6) and a private deploy is owner + bigfill only. Honest re-measurement needs V8.50 LIVE, weeks after migration. IT MUST NOT BLOCK THE GATE.
* THE V8.50 LOAN BOOK, 3 seeds, identical sequences, MATRIX_SIZE 127: loans 255 → 85 (−67%), dollars $311.33 → $168.86 (−46%), 45% of rescues now cost the fund nothing, SF ends 4x healthier.
* ⛔ BUT LOANS GET BIGGER, NOT SMALLER: mean $1.22 → $1.99, largest $2.26 → $4.42 (4,421 bps against a 5,000 ceiling — the floor's slack roughly halved).
* THE BASE-CEILING CURVE (18.4). Zero-sponsor loans refused: 1500 → 26 of 26, 2000 → 22, 2500 → 18, 3000 → 14, 3500 → 7, 4000 → 1, 5000 → 0. THE GATE ONLY LOWERS THE CEILING FOR MEMBERS WITH ZERO DIRECTS — "how many of ALL loans fit under X" is NOT a policy reading.
* ⛔ 18.8 CORRECTS 13.11's DESIGN SKETCH, which 16.5 and 17 both carried: "a small first advance at 0 directs" is NOT what a ceiling on `loanHeadroom` produces. The advance size is set by the SHORTFALL, `loanEligibleFor` is a boolean on the WHOLE advance, there is no partial-funding path, and a refused rescue is already routed to eviction. A member whose shortfall exceeds the base gets NOTHING, not less.
* ✅ EVICTION IS REMOVAL, NOT CONFISCATION — 34 of 34 evicted members kept their withdrawable to the cent, all 4 who had borrowed still owed it, none held a reserve afterwards. First time ever measured. ⚠ `EvictionReserveReleased` fired 0 times across all 34 — every evicted member came from MatB where the reserve is always zero, so that path is STILL UNTESTED.
* ⛔ WHO THE GATE REFUSES, and it is 6 per seed on every seed: 18 FLOOR evictions, every one holding $5.58–$6.82 of their own money, owing $0.00, needing $3.18–$4.42. NEAR-MISSES. The other 13 evictions are LADDER cases holding $0.25 who are evicted with or without the gate. At $4.00 the cap grants 17 of the 18 and stops asking anything; there is no gentle setting between.
* THE GATE'S GAS AT MATRIX_SIZE 127: +0.41% of whole-run gas, three seeds, agreeing with 17.1's 7,720/1,220. ⚠ Whole-run, NOT per item.

NEXT, IN ORDER (18.21)

1. CROSS 18.16's REFUSAL CLUSTER WITH THE LIVE `directCount` DISTRIBUTION. The only thing that could overturn 3000 bps. Read every `memberReferrer` off live V8.48, build the real histogram, ask what share of live members sit in the refused class. `scripts/diag_referral_threshold.js` already has `directsAt(member, block)` — extend it, do not build a new tool. Needs no further decision.
2. EXERCISE `EvictionReserveReleased` DELIBERATELY. Needs a MatA eviction; the private V8.50 deploy can stage it with `evictionGracePeriod` in minutes (session 9's recipe).
3. BUILD THE GATE FOR REAL. Everything is measured. Promote `fixture_gate_apply.js`'s five edits into the tree with `baseAdvanceBps = 3000` + setter, plus tests.
4. LENGTHEN THE A/B TAIL until `stillParkedAtEnd` approaches zero, so loan counts stop being censored (18.19).
5. Split 14.1 by tier and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
6. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic); `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry.

TOOLS THAT NOW EXIST — use them, do not rebuild them

* `test_ab/replay.js` LOAN BOOK — always on. Per-loan amount, bps of the ENTRY FEE, borrower's directCount at that moment (from the sequence file's referral tree, no chain read), `fitsUnderBase`, `directsSanity`. Reconciles against `raw.loanVolume`; a disagreement voids both and says so.
* `test_ab/replay.js` EVICTION LEDGER — rides on `AB_CENSUS`/`AB_EVICT`. Withdrawable before (pre-tick snapshot) and after, plus reserve and debt after, per evicted member. Matrix taken from the EVENT, never the snapshot. Shouts in capitals if anyone loses withdrawable.
* `AB_GATE_BPS` in `test_ab/world.js` — sets `baseAdvanceBps` so ONE compile serves a whole sweep. ABORTS if the fixture is not applied. Value and filename tag both read back off the contract, never from the env var.
* `node scripts/fixture_gate_apply.js` — session 17's exact fixture (`--binding`, `--undo`). Aborts rather than half-apply.
* `test/V8_50_GateCost.test.js` (the probe, `describe.skip` ON PURPOSE) and `contracts/test/GateProbe.sol`.
* Sweep recipe: apply the fixture, `npx hardhat compile`, then `$env:AB_CAP="5"`, `$env:AB_EVICT="1"`, `$env:AB_GATE_BPS="<n>"`, `$env:AB_SEQ="ab_sequence_s<n>.json"`, `npx hardhat run test_ab/replay.js`. Undo the fixture afterwards.

TRAPS, CARRIED FORWARD

* ⛔ CLAUDE'S FILE BRIDGE DOES NOT APPLY YOUR LINE-ENDING NORMALISATION. Several files read as whole-file diffs from Claude's side and are CLEAN from yours — measured. Before treating any whole-file diff as a finding, run `--ignore-all-space` and ask what YOUR `git status` says; your machine is authoritative. Never `git add -A`.
* THE A/B WORLD ZEROES THE GRACE CLOCKS — eviction volume is an upper bound. See THE RULES above.
* THE GATE ONLY LOWERS THE CEILING FOR MEMBERS WITH ZERO DIRECTS. The wrong column is the intuitive one.
* A GATE THAT EXISTS IS NOT A GATE THAT BINDS (14.3); a gate installed to be MEASURED must not bind (17.2).
* READING SOURCE MEASURES THE MECHANISM, NOT THE POPULATION. Valid for where code lives — that is how 17.4 corrected `coPayRescue` and how 18.8 found the partial-funding gap.
* `parkRefusalsRouter` is NOT a refusal count — each pairs 1:1 with a matrix park in the same tx and is already inside `parkEventsMatrix`. The instrument says so in its own output.
* THE A/B TAIL DOES NOT DRAIN THE QUEUE (18.19) — late rescues are censored in both arms, so loan counts are understated. Evictions fire mid-run and are much less affected.
* A WINDOW THAT LEAKS INVENTS A FINDING (16.1). DECISIVE ≠ COVERAGE — 67.4% of the missing dollars, 5 of 123 members; quote both or neither.
* AN INSTRUMENT'S RESOLUTION IS PART OF ITS RESULT. `V8_50_KeeperGas` prints to 0.01M; a 7,720-gas change reads as +0.01M. Agreement, not absence.
* THE AB WORLD IS A FIXTURE. Its referral tree is real (a tree, not a star) which is why the gate can be priced in it at all — but nobody there recruits in response to being refused, and it is not the live directCount distribution. Say so with every gate number.

HOW WE WORK
You drive and decide direction; you make the file edits; I run every command and paste back the output. Copy-paste blocks that name the folder, one step at a time, then wait. Plain language — I am not deep on the technical side. Do not ask which item to take next: decide, tell me, and we continue. Ask only when the answer is genuinely mine (a policy or economic trade-off). Fewer, smaller steps — converge on the decision rather than chasing every thread; park the rest in the handoff. Contracts push to `v8.1`; frontend `origin admin` → `admin:preview` → `admin:main`. There is no third party: every line here was written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
