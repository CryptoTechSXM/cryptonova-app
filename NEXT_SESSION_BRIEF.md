NEXT SESSION BRIEF — V8.50, branch `v8.1`
Written end of session 18, 2026-08-20. Paste this in to open the next session. Repo: `C:\CryptoNite-Smart-Contracts\CryptoNova`.

Read `V8_50_HANDOFF.md` section 18 first — 18.7 and 18.8 are the finding, 18.11 is the owner's open call, 18.1 is the method lesson — then 17, 16, 15, 14, then section 7a THE TWO RULES. Everything below is a pointer, not a substitute.

STATE
Contracts `v8.1` — run `git log --oneline -3` and trust that, not a hash written here. Frontend `admin` = `preview` = `main` at `74a1588`. NOTHING DEPLOYED, NO CHAIN WRITTEN TO. Session 18 applied session 17's gate fixture, ran a 15-run sweep, and REVERTED it — the owner's own `git status --short contracts/` came back empty, which is the authoritative reading. Sessions 13–18 are measurement only.
SUITE: 618 passing / 8 pending / 0 failing as of the end of session 17. ⚠ NOT re-run in session 18 — nothing in `contracts/` or `test/` changed, only `test_ab/` (which the suite does not run), so it should still hold. If you need the number, run it; do not quote it as re-verified.

THE RULES

1. Do not hypothesise unless necessary. 2. Measure and test before implementing. When two numbers disagree, the disagreement IS the finding. A number you have not run is not a result. One sample is not a measurement. Build the instrument so it can contradict you.

AND BUILD THE SECOND INSTRUMENT — four sessions, four times it paid. Session 18's loan-book counterfactual predicted 7/14/18/22 refusals and the replayed sweep lost 7/13/18/19. That agreement is the only reason the curve can be quoted.

⛔ A MEASUREMENT WHOSE CONTROL ARM MOVED IS NOT A MEASUREMENT (17.2). Session 18 obeyed it: the fixture was installed non-binding first and reproduced the ungated run exactly on all three seeds before a single sweep row was believed.

⛔ AND THE ONE SESSION 18 EARNED: A RESULT FILE IS NOT A RESULT. It is a result AS OF an instrument version and a dial set. Seeds 2 and 3 on disk were a day older than seed 1, recorded no `insolvencyFloorBps`, and predated PARAM 59 = 5000; pooling them reported "evictions +1150%" against the true +500%. CHECK THE MTIME AND THE RECORDED DIALS OF EVERY RESULT FILE BEFORE POOLING IT WITH A FRESH ONE.

⛔ THE POLICY IS SETTLED — 16.5 STANDS, ALL FIVE
Accepted by the owner 2026-08-20. Keep lending; price it at 20.2% ending in debt vs 10.0%; PARAM 59 stays at 5000; do NOT cut the floor to 40%/20%; do NOT touch `setClawbackBands` for this purpose; the exit is sponsorship. Build on it without re-asking. The lending investigation (13→16) is CLOSED — never requote 13.5's 7.1/31.7 or 15.2's 2.4/31.8; the balanced pair is 8.0% vs 19.6%.

✅ WHAT SESSION 18 CLOSED

* 17.7 ITEM 1 IS ANSWERED, AND IT COULD NOT HAVE BEEN RUN AS WRITTEN. 14.1's clean columns are the member-specific ones (14.6), and a private deploy is owner + bigfill only — so a private V8.50 deploy would have returned the bigfill answer. Re-measuring 14.1 honestly needs V8.50 LIVE, weeks after migration. IT CANNOT BLOCK THE GATE. What the gate needed was a mechanism quantity and the A/B harness already had it.
* THE V8.50 LOAN BOOK, 3 seeds, identical sequences, MATRIX_SIZE 127: loans 255 → 85 (−67%), dollars $311.33 → $168.86 (−46%), 45% of rescues now cost the fund nothing, SF ends 4x healthier.
* ⛔ BUT LOANS GET BIGGER, NOT SMALLER: mean $1.22 → $1.99, largest $2.26 → $4.42 (4,421 bps against a 5,000 ceiling). Item 1's "the whole table shrinks" is half wrong — it shrinks in COUNT.
* THE BASE-CEILING CURVE (18.4). Zero-sponsor loans refused: 1500 bps → 26 of 26, 2000 → 22, 2500 → 18, 3000 → 14, 3500 → 7, 4000 → 1, 5000 → 0. This is WHY session 17's 1500 bound so hard. On the OLD build a base of 2500 would have granted 100% — the gate would have been an ornament, which is why item 1's instinct was right even though its method was wrong.
* THE GATE'S GAS AT MATRIX_SIZE 127: +0.41% of whole-run gas, three seeds, agreeing with 17.1's 7,720/1,220. ⚠ Whole-run, NOT per item — it bounds 17.4's open item, it does not close it.

⛔⛔ THE FINDING, AND IT IS WHY THE OWNER'S DECISION CHANGED SHAPE
A gate at any useful base does NOT produce "one or two loans, then eviction if no invites". At base 3000, 27 of 30 evicted members (90%) were NEVER LENT TO AT ALL, and the count evicted AFTER borrowing is flat at 3–4 in every row. The reason is structural and it CORRECTS 13.11's design sketch that 16.5 and 17 both carried: the advance size is set by the member's SHORTFALL, `loanEligibleFor` is a boolean on the WHOLE advance, there is no partial-funding path, and a refused rescue is already routed to eviction. "A small first advance" and "a lower ceiling" are DIFFERENT MECHANISMS.

⛔ OWNER DECISION OPEN — DO NOT DESIGN EITHER BRANCH BEFORE HE ANSWERS (18.11)
Not "what base ceiling" any more, but the prior question: SHOULD A REFUSED LOAN ROUTE TO EVICTION AT ALL?
* If yes — base 3000 bps ($3.00 at T1) is the coherent point: holds 72 of 85 loans, cuts zero-sponsor lending 26 → 5, costs ~6 extra evictions per 288 members, ~9 in 10 of them people who never borrowed.
* If no — the gate needs a shape nobody has scoped: the fund tops a member up to the base and leaves them PARKED rather than removing them. A contract change to the funding path, not a dial.

NEXT, IN ORDER

1. The owner's call above. Blocking, and genuinely his.
2. CROSS 18.4's CURVE WITH THE LIVE `directCount` DISTRIBUTION — read every `memberReferrer` off live V8.48, build the real histogram, apply the zero-sponsor refusal column. Turns a fixture result into a live estimate, costs one read-only script, and does NOT need the owner's decision first. Cheapest remaining thing worth doing.
3. MEASURE WHAT AN EVICTED MEMBER KEEPS (18.10) — design intent is removal, not confiscation; asserted from session 9's recipe, never run. Do it before eviction volume triples.
4. Split 14.1 by tier and cap time-at-risk (14.4). ⚠ It is a V8.48 measurement and 18.0 applies.
5. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic); `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry.

TOOLS THAT NOW EXIST — use them, do not rebuild them

* `test_ab/replay.js` LOAN BOOK — always on. Per-loan amount, bps of the ENTRY FEE, borrower's directCount at that moment (from the sequence file's referral tree, no chain read), `fitsUnderBase`, `directsSanity`. Reconciles against `raw.loanVolume`; a disagreement voids both and says so.
* `AB_GATE_BPS` in `test_ab/world.js` — sets `baseAdvanceBps` so ONE compile serves a whole sweep. ABORTS if the fixture is not applied, because a run that continued would report "the gate changed nothing". Value read back off the contract; the filename tag comes from the contract, never the env var.
* `node scripts/fixture_gate_apply.js` — session 17's exact fixture (`--binding`, `--undo`). Aborts rather than half-apply.
* `test/V8_50_GateCost.test.js` (the probe, `describe.skip` ON PURPOSE) and `contracts/test/GateProbe.sol`.
* Run recipe for the sweep: apply the fixture, `npx hardhat compile`, then `$env:AB_CAP="5"`, `$env:AB_GATE_BPS="<n>"`, `$env:AB_SEQ="ab_sequence_s<n>.json"`, `npx hardhat run test_ab/replay.js`. Undo the fixture afterwards.

TRAPS, CARRIED FORWARD

* ⛔ CLAUDE'S FILE BRIDGE DOES NOT APPLY YOUR LINE-ENDING NORMALISATION. `contracts/test/CryptoNovaCommunityWallet.sol` reads as a 474/474 whole-file diff from Claude's side and is CLEAN from yours — measured. Before treating any whole-file diff as a finding, run `--ignore-all-space` and ask what YOUR `git status` says; your machine is authoritative. Do not 'fix' it.
* THE GATE ONLY LOWERS THE CEILING FOR MEMBERS WITH ZERO DIRECTS. "How many of ALL loans fit under X" is not a policy reading and must never be quoted as one — only the zero-sponsor column predicts anything. The wrong column is the intuitive one.
* A GATE THAT EXISTS IS NOT A GATE THAT BINDS (14.3), and a gate installed to be MEASURED must not bind (17.2).
* READING SOURCE MEASURES THE MECHANISM, NOT THE POPULATION. It IS valid for where code lives — that is how 17.4 corrected the `coPayRescue` claim, and how 18.8 found the partial-funding gap.
* `parkRefusalsRouter` is NOT a refusal count — each pairs 1:1 with a matrix park in the same tx and is already inside `parkEventsMatrix`. The instrument says so in its own output; read the note before reporting a rise.
* A WINDOW THAT LEAKS INVENTS A FINDING (16.1). DECISIVE ≠ COVERAGE — 67.4% of the missing dollars, 5 of 123 members; quote both or neither. A CONTROL WHOSE BASELINE IS ON THE FLOOR CANNOT CARRY A VERDICT (bigfill, 1.4%).
* AN INSTRUMENT'S RESOLUTION IS PART OF ITS RESULT. `V8_50_KeeperGas` prints to 0.01M; a 7,720-gas change reads as +0.01M. That is agreement, not absence.
* THE AB WORLD IS A FIXTURE. Its referral tree is real (a tree, not a star) which is why the gate can be priced in it at all — but nobody there recruits in response to being refused, and it is not the live directCount distribution. Say so with every gate number.

HOW WE WORK
You drive and decide direction; you make the file edits; I run every command and paste back the output. Copy-paste blocks that name the folder, one step at a time, then wait. Plain language — I am not deep on the technical side. Do not ask which item to take next: decide, tell me, and we continue. Ask only when the answer is genuinely mine (a policy or economic trade-off). Fewer, smaller steps — converge on the decision rather than chasing every thread; park the rest in the handoff. Contracts push to `v8.1`; frontend `origin admin` → `admin:preview` → `admin:main`. There is no third party: every line here was written by a previous session of you and executed by me. Write handoffs to yourself accordingly.
