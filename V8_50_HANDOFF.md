# V8.50 HANDOFF — the crossing redesign. READ THIS FIRST.

Written 2026-08-16 at the end of the V8.49 private measurement run.
Audience: a future session of Claude, plus the owner. Nobody else touches this code.

**This replaces `V8_49_HANDOFF.md` as the entry point.** That file is still the record of
V8.49 — what it built, what the private test measured, and the traps from deploy day.
Read it for "why is V8.49 like this"; read THIS for "what am I building now".

## READING ORDER

1. **this file**
2. **`V8_50_SCOPE.md`** — items A, B, C, D, plus the **"⬛ MEASURED ON THE V8.49 PRIVATE
   CHAIN"** section at the top. That section is data, not plan; trust it over any
   derivation elsewhere.
3. `V8_49_HANDOFF.md` — for V8.49's own history and the deploy-day mechanics
4. `V8_49_TEST_PLAN.md` — how the private test was run, and its CORRECTIONS section
   (the cohort bleed, the offsets, why sequential)

---

# 1. WHERE THINGS STAND

## Two chains exist. Do not confuse them.

| | **LIVE — V8.48** | **TEST — V8.49** |
|---|---|---|
| who is on it | **the community** | owner + bigfill only |
| addresses file | `deployed_addresses_v8_48.json` | `deployed_addresses_v8_49.json` |
| how scripts reach it | **`.env` line 69 (the default)** | **shell override ONLY** |
| MatrixKeeper | (see the v8_48 file) | `0x03Ff2184Afa458eE743c123bdb93D7804953F49D` |
| StabilityFund | (see the v8_48 file) | `0x9b3EbdE821DE116cF338021D0Ab46590ed066CF8` |
| keeper driving it | the VPS (`167.99.0.250`) | `scripts/testchain_keeper.js` on Windows |
| frontend points at it | **yes** | **no — and that is what keeps it private** |

**`.env` line 69 must STAY `deployed_addresses_v8_48.json`.** Every live diagnostic
resolves through it. The test chain is reached by `$env:ADDRESSES_FILE=...` in the shell,
which wins because `hardhat.config.js:2` calls `dotenv.config()` with no override
(verified, not assumed — `probe_addrs_env.js` is the measurement).

**Both chains are Base Sepolia.** A "private deploy" is a private DEPLOYMENT, not a
private network: the same BIP-44 index is the same address, nonce and ETH balance on
both. Two bigfills running at once will collide.

## What is running right now

- **The VPS keeper drives live V8.48 and was never touched.** It has no authority on the
  test chain — `setUpkeepCaller` was deliberately never called there, and
  `testchain_keeper.js` signs as the deployer, which `performUpkeep` accepts as `owner()`.
- **The live bigfill was STOPPED 2026-08-16 03:30:44 -04:00** and has not restarted. So
  **live V8.48 is now running PURELY ORGANIC.** This project has never measured organic
  growth — every previous rate was bigfill's. **One `diag_floor_halt.js` run against the
  v8_48 addresses is worth taking early, before anything restarts it.**
- The test chain may still have a keeper and a traffic bigfill running. Both are safe to
  stop; every figure is already in `logs/testchain_keeper.csv` and
  `logs/parked_baseline.csv` (the latter now keyed by MatrixKeeper address, so trends
  never span two deployments again).

## Branches

Contracts push to **`v8.1`**. `admin → preview → main` is the FRONTEND repo only.
Everything from the V8.49 run is committed through **`394c35e`**.

---

# 2. WHAT V8.50 IS

**The version the community re-registers into.** V8.49 was a private measurement and the
community never saw it. V8.50 carries the economics change, and it is ONE member-facing
deploy, not four.

Owner's framing, and the reason V8.49 stayed private:

> *"every version is a fresh deployment members must re-join, and v8.47/v8.48/v8.49/v8.50
> in four days spends all their trust."*

---

# 3. ITEM A — THE CROSSING IS PAID BY THE RESERVE

## The owner's idea, in his words

> *"the crossing fee should be used for the crossing, so no reserve fee is required at
> crossing — that makes the 50% crossing fee pay 100% crossing, which covers all the fees
> required except the reserve. The reserve is only at the beginning. So entering A costs
> 100%, 50% reserve; entering B costs 50% only, that was reserved at A. They only need a
> loan when the full A+B cycle is completed and they are short to enter A again."*

## The defect it fixes, now MEASURED not derived

`MatrixLogicLib._crossToPartner` charges the **full** destination entry fee:

```solidity
uint256 reentryFee = IFigureEightMatrixV8Cross(destination).ENTRY_FEE();
```

So a member needs **50% of the fee from earnings at every crossing**, and a member with no
referrals earns **34%** per journey (`250 direct + 1800 pool + 1350 chain = 3400 bps`).

**Observed on the test chain, thirteen members simultaneously, to the cent:**

```
reserve $5.00   withdrawable $3.40   effective $8.40   shortfall $1.60
```

That is the "84% member" — 50% reserve + 34% earnings = 84% of a $10 fee. It appears
**only once members complete FULL journeys**; earlier parkers had partial pool weight and
scattered shortfalls. **The clean number is the steady state.** 84% of cycle-outs parked
(MatA rotations 51 = 43 parked + 8 crossed); only the earliest roots, carrying the most
pool weight, funded their own crossing.

## Why it works with no re-tuning — the constants already say so

```
CROSSING_RESERVE_BPS 5000  +  DIRECT_EARN_BPS 250  +  splits 4750  =  10000
```

**The distributions consume exactly 50% of a fee. The other 50% is the member's own
reserve.** A crossing paid entirely from the $5 reserve funds the destination's L1, chain
pay, pool, treasury, SF, dev, ops, community, buyback and liquidity **identically to
today — the same dollars to every destination**. Not one split BPS changes. The owner's
instinct that *the reserve IS the crossing* is correct in the constants.

## What it changes, at T1 ($10 fee, no referrals)

| | today | with item A |
|---|---|---|
| enter MatA | $10 → $5 reserve + $5 distributed | unchanged |
| cross A → B | **$10** — reserve $5 + **$5 from earnings** → short **$1.60** → PARK | **$5 from reserve. No shortfall. No park.** |
| reserve held in B | $5 (freshly carved) | **$0 — spent on the crossing** |
| journey in B | earns 34%, **clawback eats it repaying the A→B loan** | earns 34%, **kept** |
| cycle out of B → re-enter A | $10 needed, short again → **second loan → REFUSED** | $10 needed, holds **$6.80** → short **$3.20** |
| loan events per full cycle | **2** | **1** |
| mid-cycle parking | **yes — this is the queue** | **none** |

## ⛔ THE MEASUREMENT THAT MAKES ITEM A THE RIGHT FIX

The V8.49 run found **why** the second loan is refused, and it is not what
`V8_50_SCOPE.md` item C assumed.

**14 members were refused by the insolvency floor. Every one read `memberDebt $0.00`.**
The event log (150 loans / $195.78, 65 repayments / $47.95, both matching the contract's
own `totalRescueLoaned` / `totalRescueRepaid`) shows each **borrowed exactly once and was
repaid IN FULL by the clawback**:

```
outstanding debt $0.00  -> RESCUED BEFORE x1  (lifetime borrowed $2.12, repaid $2.12)
repayments : $0.71@blk45558974  $1.41@blk45558974
```

**`0 of 14 were refused on a first loan.`**

So the causal chain is:

> loan 1 (~$1.4–2.1) granted → **clawback takes the MatB earnings that would have funded
> the next crossing** → member reaches crossing 2 with those earnings gone → asks
> **$3.43–4.06** → exceeds the **$3.40** floor → **refused and evicted**.

**Item A removes the first loan, therefore removes the clawback, therefore the member
arrives at re-entry with the full $6.80 and asks $3.20 — under the ceiling.** That is the
whole argument, and every link in it is measured except the last, which is arithmetic.

**T3's boundary is exactly 66%**, confirmed:

| effective | % of fee | advance | verdict |
|---|---|---|---|
| $6.61 | **66.1%** | $3.39 | rescued |
| $6.57 | **65.7%** | $3.43 | **refused** |

$6.60 effective produces precisely a $3.40 advance.

## ⛔ WHAT ITEM A DOES *NOT* FIX — READ BEFORE BUILDING

Per full A+B cycle a no-referral member earns **68%** of a fee and needs **100%** to start
the next one. **That 32% gap is the system's own take** — L1, treasury, SF, dev, ops,
community, buyback, liquidity — about 16% per seat, twice per cycle. **Loans defer that
gap; nothing closes it except referral income.** `CLAUDE.md` already states this is the
design.

Carried one cycle further with today's numbers: the $3.20 loan is itself clawed back, so
the member reaches the NEXT re-entry holding ~$3.60 against $10 — asking **~$6.40, far
above the floor**. **Item A roughly DOUBLES member lifetime (a full cycle instead of half)
and does not fix solvency.**

**That doubling is the real prize and it is worth stating positively:** a member who today
dies at their first crossing would complete both matrices — more pool weight, more chain
pay, more CNOVA minted, and a materially better experience for the fully passive member.
That is the owner's argument and the data supports it.

## ⚠️ THE MARGIN IS THIN — MODEL BEFORE WRITING CONTRACT CODE

$3.20 against a $3.40 floor. **That fits, barely.** Measured lifetime earnings on the test
chain ran **$2.27–$2.92**, so members below the structural $3.40 fall outside it anyway.

**THE FIRST THING TO DO IS NOT TO WRITE CODE:**

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
node scripts\model_insolvency_floor.js
```

Model item A's economics against the population that actually exists on the test chain.
**The $3.20 figure is Claude's arithmetic, not a measurement.** If the model says the
post-item-A ask clusters above $3.40, item C has to move WITH item A and they ship
together.

---

# 4. TOUCH POINTS

From the scope, plus what the V8.49 run added. **Expect more; the plan is always short.**

## Contract

- **`MatrixLogicLib._crossToPartner`** — charge the reserve amount, not `reentryFee`
- **the destination's entry accounting** — accept a 50% payment and **skip the reserve
  carve**
- **`MatrixKeeperLib._triageParked` / `MatrixKeeper._doParkedRescue`** — `effectiveContrib`
  and the shortfall maths both assume a full-fee crossing
- **`exitSeat` and `evictParked` reserve release** — a member mid-cycle now holds **$0**
  reserve. Every path that releases or refunds a reserve needs to handle zero.
- **the tier-upgrade path needs its own answer** — is upgrading a NEW CYCLE (full fee) or a
  CROSSING (reserve only)? **Decide deliberately; do not let it fall out of the diff.**

## Newly identified by the V8.49 run

- **`crossingReserveOf` reads $0 for a mid-cycle member.** The frontend reserve badge
  (V8.48 item 2, `reservedHeldFor`) will show $0 to a member who is perfectly healthy.
  **That is a member-facing change and needs copy, not just code.**
- **Every diagnostic computes `effective = reserve + withdrawable`.** Under item A a
  mid-cycle member has reserve 0, so "effective" means something different.
  `diag_floor_halt.js`, `diag_seating_depth.js`, `diag_cohort_split.js` and
  `v849_watch.html` all need revisiting — and `v849_watch.html` **already under-reports**
  once the factory deploys a second pair, because it reads fixed addresses.
- **`maxItemsPerUpkeep = 15` may be unsafe.** Gas per rescue rose from **600k to 2.6M** as
  members began settling full journeys. A full 15-item batch projects to **~39M against a
  ~17.8M practical ceiling**. **A batch that fails for GAS is indistinguishable, in the
  results, from a floor failure.** Consider 5 or 10.

## Tests

**Every fixture asserting a full-fee crossing.** V8.49's much smaller change predicted 2
breakages and had 4, three of them the same hidden assumption. **Grep the suite for the
OLD justification, not just the identifier.**

---

# 5. ITEMS B, C, D

## ITEM B — no member evicted mid-cycle. SHIPS WITH A, NOT SEPARABLE.

> *"I do not want any member evicted mid cycle — they should complete their cycle before
> being evicted."*

A member parked at the A→B crossing **is** mid-cycle, and that is the main parked
population — now confirmed: 84% of cycle-outs parked there. Honouring this without item A
means either lending at every A→B crossing (what the floor exists to prevent) or leaving
them parked forever. **Item A is what makes this rule free.**

## ITEM C — LADDER VS FLOOR. ⛔ ITS STATED MECHANISM IS WRONG.

The scope describes it as a guard that arms **as debt accumulates**. **Debt never
accumulates** — the clawback repays each loan in full. Policy B refuses on **the size of a
single advance**.

So the question is not "how much debt should we tolerate" but **"how large a single ask
should the fund absorb"** — and it must be calibrated against **post-item-A asks (~$3.20,
then ~$6.40)**, never against today's $3.43–4.06, which describe a world with a first loan
and a clawback in it.

Options unchanged in form: accept / trim the ladder / raise `insolvencyFloorBps`
(PARAM 59, menu `0/1700/2500/3400/5000/6800/10000`). Note `3400` was derived as the
~34% median per-cycle earnings AND equals exactly one full journey's earnings — *"never
lend more than one full journey's earnings"* is a far more defensible way to say it in
member comms than "a median".

## ITEM D — SHALLOW SEATING. STILL UNDECIDED.

`scripts/diag_seating_depth.js` exists and its scan self-test passes exactly. **It was run
and produced no answer**, because the mechanism could not fire: idle reclaim needs
`extendedIdleTimeout` (7 days) and the test chain was six hours old, and
`MemberExitedSeat` needs a voluntary early exit bigfill never performs. **Zero backfills
was guaranteed before the first block.** The script now refuses to give a verdict in that
situation.

To settle it, one of: run a chain past 7 days · lower `extendedIdleTimeout` on a TEST
chain (as we lowered `parkedGracePeriod`) · drive early exits deliberately.

---

# 6. TRAPS — DO NOT REPAY THESE

## From the V8.49 run (all cost time on 2026-08-16)

**Nine instruments returned confident, plausible, wrong answers in one day.** Every one
substituted an easy observable for the question actually being asked:

- `predeploy_check:289` asserted a SOURCE FILE MENTIONS a filename, standing in for "the
  deploy writes the right file" — it forbade the env-override workflow outright
- a guard testing *"is the variable set"* standing in for *"did a human choose this chain"*
  — `dotenv` satisfies the former for free, so it never fired under `npx hardhat run`
- `check_nonce.js` reported *a* signer's nonce (Hardhat account #0, in-memory chain) as
  "the deployer is quiet", three times, immediately before a live deploy
- an absent-constant probe INFERRING absence from an error shape
- `-Offset` looking like cohort isolation when `SCAN_FROM` defaults to 0
- T5's spec naming `SlotReclaimed`, an event the keeper stopped emitting
- a work-type map with `3` GUESSED as `FORCE_ROTATE` (it is `CHAIN_LINK`; 6 is
  `EVICT_PARKED`)
- event signatures written from memory — wrong arity, and `args[1]` was the TIER, which
  would have been read as a dollar amount
- a baseline CSV that differenced rows ACROSS TWO DEPLOYMENTS and printed "-156/day"

**The ones that caught themselves were the ones wired to something they could reconcile
against:** `totalRescueLoaned`, `loanEligibleFor`, `occupancy()`, and a bytecode scan with
a positive control. **Give every V8.50 tool something to check itself against.**

**And the specific rule that keeps recurring:** `memberDebt` is a **BALANCE, not a
LEDGER**. A member who borrowed and repaid reads $0.00 and is invisible to every snapshot.
Use `diag_loan_history.js` (event-sourced, self-testing) for any claim about history.

## Standing repo traps

- **Claude's device-bridge git is NOT trustworthy in these mounted folders** — it cannot
  unlink `.git/index.lock` and will report a working tree that is not the real one.
  **Claude may READ files through the bridge; every git verdict comes from the owner
  running the command.** Never `git add -A`; stage by explicit path.
- **`MatrixKeeper` is a LINKED contract** — `getContractFactory` needs
  `{ libraries: { MatrixKeeperLib: <addr> } }` or it throws before any test body runs.
  `V8Governance` and `StabilityFund` are NOT linked.
- **A clock or a gate is TWO gates** — discovery (`checkUpkeep` / `MatrixKeeperLib`) and
  execution (`performUpkeep` / `MatrixKeeper._do*`). Find both before believing any
  "X happens after N". *(Checked this run: for parked RESCUE the grace is a single gate,
  in `_checkParked:560`. For EVICTION it is genuinely two.)*
- **Never draw a negative conclusion from a truncated search.** Verify the premise, rerun
  rather than assert.
- **Do not hard-code emergent numbers.** Growth rate is a dial the owner controls.
- **When a check and a setter disagree, read the setter** — it is the one the chain
  enforces.
- **A write that reads back wrong is usually a STALE READ.** `KEEPER_VPS_CONFIG.md`
  recorded this for `set_entry_thresholds.js`; it recurred on `set_parked_grace.js` this
  run. **Re-read after ~20s. NEVER re-run a state-changing command on that warning alone.**

---

# 7. HOW WE WORK

Claude drives, decides direction, and makes the file edits directly. **The owner runs
every command** — tests, git, chain reads, VPS — and reports back. Give copy-paste blocks
that name the folder they run in, **one step at a time, and wait for "done"**. Explain in
plain language; the owner is not deep on the technical side and leans on Claude as a
mentor. **Do not ask which item to take next — decide.**

Contracts push to **`v8.1`**. `admin → preview → main` is the FRONTEND repo only.

**Write docs and handoffs for a future session of Claude plus the owner. Nobody else
touches this code, so anything unexplained is an incomplete handoff from a past session:
verify it and close it rather than working around it.**

---

# 8. OPEN, HONESTLY STATED

- **T6 was never answered — the V8.49 run had NO VALID CONTROL.** Self-rescue only happens
  WHILE that cohort's bigfill process is alive; cohort A's exited after registration, so it
  took 58 loans at `-SelfRescueRate 1.0` and behaved as a second subject. Run 2 must keep
  the control's bigfill alive AND confirm its members reached crossings before reading its
  loan count.
- **`SELF_RESCUE_RATE = 0` is a pathological extreme, not a population.** Real members can
  top up and pay. **Self-rescue does not remove the ~32%-per-cycle gap — it moves who
  absorbs it, into a recurring ~$3.20-per-cycle out-of-pocket cost at T1.** That is the
  number V8.50 should be judged on, and the honest one for member comms.
- **No end-to-end test that a real rescue books `shortfall` and nothing more.** The
  aggregate is consistent with it and the buffer is 0 by construction, but there is still
  no per-member assertion. Closing it means a `forceCrossKeeper` mock that RECORDS its
  `(sfContribution, crossingBuffer)` arguments.
- **`ARRAY_RANGE_ERROR` on `getParkedMember`** recurred as **five consecutive TAIL indices**
  during active rescues — not "always the last index" as recorded twice before. That fits
  the RACE explanation and does NOT fit a `getParkedCount` off-by-one, which would
  misreport by exactly one every time. The benign branch now has real support.
- **Item 2 (the wallet RPC, `sepolia.base.org`)** — still open, deferred to mainnet by
  owner decision. **Do NOT propose free public endpoints**; they were tried in this site's
  read pool, were buggy, and were removed. That is owner-observed operational history.
- **The live V8.48 chain has been organic since 03:30:44 -04:00 and has never been measured
  that way.** Take a reading before anything restarts bigfill.
