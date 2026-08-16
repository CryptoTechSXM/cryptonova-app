# V8.50 SCOPE — the crossing redesign. THE version the community joins.

Opened 2026-08-16. Audience: a future session of Claude, plus the owner.

Read `V8_49_HANDOFF.md` first, then `V8_49_TEST_PLAN.md` (V8.49 is a PRIVATE measurement
deploy — owner + bigfill only). **V8.50 is the release members re-register into**, so it
carries the economics changes, not V8.49.

**UPDATED 2026-08-16 — the V8.49 private test RAN. Read the MEASURED section below before
item A. Several assumptions here are now facts, one is now wrong, and the mechanism behind
item C is not what this document says it is.**

---

# ⬛ MEASURED ON THE V8.49 PRIVATE CHAIN, 2026-08-16

Deployment `0x03Ff2184…F49D`. Cohort B (127 wallets, offset 6200, `-SelfRescueRate 0`),
cohort A (127, offset 6000, rate 1.0), traffic (offset 6327, rate 1.0). Every figure came
from the owner running a script — neither sandbox can reach Base Sepolia.

## 1. THE 84% MEMBER IS REAL, AND EXACT

Thirteen members simultaneously read, to the cent:

```
reserve $5.00   withdrawable $3.40   effective $8.40   shortfall $1.60
```

That is item A's own table (`reserve $5 + $5 from earnings → short $1.60 → PARK`) and the
`250 + 1800 + 1350 = 3400 bps` breakdown, observed. **It only appears once members complete
FULL journeys** — earlier parkers had partial pool weight and scattered shortfalls of
$0.02–$2.12. The clean number is the steady state, not the transient.

## 2. THE CROSSING BUFFER WAS THE CONSTRAINT — CONFIRMED FROM A COLD START

At `crossingBufferBps = 0` the buffer is **0% of every ask**, and the fund **cleared the
entire queue**: 43 parked → 0, via 81 rescues. V8.48 live at buffer 3600 completed 69 of 121.

The sensitivity table reproduced the live contradiction on a chain sharing no history:

| buffer bps | policy B refuses |
|---|---|
| 0 | 0 of 38 |
| 1800 | 23 of 38 |
| **3600 (V8.48)** | **38 of 38** |

Matching the live 52-of-52 and then 88-of-88. **Item 1b's central claim is settled.**

## 3. ⛔ ITEM C'S MECHANISM IS NOT DEBT ACCUMULATION — THE CLAWBACK REPAYS EVERY LOAN

This changes item C, and it is the opposite of what the ladder-vs-floor write-up assumes.

**14 members were refused by the floor. Every one had `memberDebt = $0.00`.** The event log
(150 loans / $195.78 and 65 repayments / $47.95, both matching the contract's own counters)
shows each **borrowed exactly once and was repaid IN FULL by the clawback**, in two tranches
at a single block:

```
outstanding debt $0.00  -> RESCUED BEFORE x1  (lifetime borrowed $2.12, repaid $2.12)
repayments : $0.71@blk45558974  $1.41@blk45558974
```

**`0 of 14 were refused on a first loan.`** 34 of 42 parked members had borrowed invisibly
to `memberDebt`.

So policy B does **not** "arm as debt accumulates". Debt never accumulates — the clawback
clears it from the next journey's earnings. **B refuses on the size of a SINGLE advance**:

> loan 1 (~$1.4–2.1) granted → clawback takes the MatB earnings that would repay it →
> member reaches crossing 2 with those earnings gone → asks **$3.43–4.06** →
> **exceeds the $3.40 floor** → refused.

**The clawback is what makes the second loan too big.** The owner's two-loan model is
confirmed: one granted, the second refused.

## 4. T3'S 66% BOUNDARY IS EXACT

| effective | % of fee | advance | verdict |
|---|---|---|---|
| $6.61 | **66.1%** | $3.39 | rescued |
| $6.57 | **65.7%** | $3.43 | **refused** |
| $5.94 | 59.4% | $4.06 | **refused** |

$6.60 effective produces exactly a $3.40 advance. Never observed before. `diag_floor_halt`'s
arithmetic mirror agreed with the chain's `loanEligibleFor` on **all 33 members, including
all 14 refusals**.

## 5. THE FUND IS A FLOW, NOT A STOCK — SEEDING IT IS THE WRONG LEVER

$56.55 → $6.37 in ~6 minutes of rescues, then back to $21.37 in ~14 minutes of
registrations. Solvency is entry-rate versus rescue-rate; a starting balance only buys
time. **Do not scope "seed the Stability Fund" as a fix.**

## 6. ⚠️ GAS PER RESCUE ROSE 4x AS JOURNEYS COMPLETED — A LATENT BATCH FAILURE

600k/item (15-item batches) → **2.6M/item** once members were settling full journeys.
At that rate a full `maxItemsPerUpkeep = 15` batch projects to **~39M gas against a ~17.8M
practical tx ceiling** (`KEEPER_VPS_CONFIG.md`).

**A batch that fails for GAS is indistinguishable, in the results, from a floor failure.**
Consider `maxItemsPerUpkeep` 5 or 10 for V8.50; keep the per-item warning in
`testchain_keeper.js`.

## 7. ⛔ THE RUN HAD NO VALID CONTROL — T6 IS UNANSWERED

| cohort | rate | loans | borrowed | repaid |
|---|---|---|---|---|
| A ("control") | **1.0** | **58** | $92.80 | $0.00 |
| B (subject) | 0 | 98 | $112.58 | $52.20 |
| traffic | 1.0 | 0 | — | — |

**Self-rescue only happens WHILE that cohort's bigfill process is alive.** Cohort A's exited
after registration; its members parked hours later with nobody topping them up and were
rescued by the fund instead. A ran at rate 1.0 and behaved as a second subject.

Traffic's zero is **not** the control signal — traffic registered last and its members likely
never reached a crossing. The 87 → 58 → 0 gradient tracks **cohort age**, not self-rescue rate.

**Design fix for run 2:** keep the control's bigfill running for the whole measurement, and
confirm its members have actually reached crossings before reading its loan count.

## 8. THE SELF-RESCUE CAVEAT ON EVERYTHING ABOVE (owner's point, and it is right)

`SELF_RESCUE_RATE = 0` is a **pathological extreme, not a population.** A real member facing
eviction can top up and pay the $3.43 themselves. The cohort exists to make the floor
observable — with everyone self-rescuing it never fires — but "14 evicted" is not a forecast
for real members.

**Self-rescue does not remove the structural gap; it moves who absorbs it.** Item A's
~32%-of-a-fee-per-cycle becomes a **recurring out-of-pocket cost — about $3.20 per full cycle
at T1, indefinitely, for a member with no referrals** — instead of an eviction. **That is the
number V8.50 should be judged on, and the honest one for member comms.**

## 9. ITEM A, WORKED THROUGH WITH THESE NUMBERS

Under item A the reserve pays the A→B crossing, so there is **no first loan, therefore no
clawback**, and the member reaches re-entry holding the full $6.80 — asking **$3.20, under
the $3.40 ceiling**. Today's second ask is $3.43–4.06 and is refused.

One cycle further: that $3.20 loan is itself clawed back, and the member reaches the NEXT
re-entry holding ~$3.60 against $10 — asking **~$6.40, far above the floor**. So **item A
roughly doubles member lifetime (a full cycle instead of half) and does not fix solvency** —
what this document already says, now with numbers. It also supports the owner's point that
doubling completed rotations means more pool and chain earnings, and more CNOVA minted, for
the fully passive member.

**This is Claude's arithmetic, not a measurement.** Run `scripts/model_insolvency_floor.js`
against this population before building, as "⚠️ THE MARGIN IS THIN" requires. **And item C
must be calibrated against POST-item-A asks (~$3.20, then ~$6.40), not today's $3.43–4.06.**

## 10. SMALLER THINGS WORTH CARRYING

- **`ARRAY_RANGE_ERROR` recurred as FIVE CONSECUTIVE TAIL indices (8–12)** during active
  keeper rescues — not "always the last index" as recorded twice before. A five-slot shrink
  mid-scan fits the RACE explanation and does **not** fit a `getParkedCount` off-by-one,
  which would misreport by exactly one every time.
- **Park rate 84%** — MatA rotations 51 = 43 parked + 8 crossed. Only the earliest roots,
  carrying the most pool weight, fund their own crossing.
- **A second T1 pair was deployed mid-run by the factory.** Any tool reading fixed MatA/MatB
  addresses from the deploy file (including `v849_watch.html`) under-reports once that
  happens. `diag_floor_halt.js` iterates pairs and stays authoritative.
- **`parkedGracePeriod` was set to 300s** on the test chain to compress a 24h wait.
  Accumulation-phase numbers were taken at the real 86400; only the rescue phase ran
  compressed.
- **T5 (seating depth): tool exists (`scripts/diag_seating_depth.js`) and WAS RUN — no answer.**
  Item D is still undecided. Note the test plan's original spec for it was wrong: it named
  `SlotReclaimed`, which the keeper no longer emits (it calls `softParkIdle` → `SlotParkedIdle`).

---

## ITEM A — THE CROSSING SHOULD BE PAID BY THE RESERVE (owner's idea, 2026-08-16)

**Owner, in his own words:**

> *"the crossing fee should be used for the crossing, so no reserve fee is required at
> crossing — that makes the 50% crossing fee pay 100% crossing, which covers all the fees
> required except the reserve. The reserve is only at the beginning. So entering A costs
> 100%, 50% reserve; entering B costs 50% only, that was reserved at A. They only need a
> loan when the full A+B cycle is completed and they are short to enter A again."*

### THE DEFECT IT ADDRESSES — and it is arithmetic, not behaviour

`MatrixLogicLib._crossToPartner` charges the **full** destination entry fee:

```solidity
uint256 reentryFee = IFigureEightMatrixV8Cross(destination).ENTRY_FEE();
// V8.31: 50/5/45 crossing logic. Draw from crossingReserve first; any remaining
// shortfall comes from withdrawable. Member only needs to accumulate 50% of the fee
// in withdrawable (the other 50% is always pre-funded by the reserve...)
```

So a member must find **50% of the fee from earnings at every crossing**. A member with no
referrals earns **34% per journey**:

| source | bps |
|---|---|
| `DIRECT_EARN_BPS`, on their own entry | 250 |
| pool, over a full journey seat 127 → 2 | 1800 |
| chain pay, 5 levels x 270 (level 6 is **0**) | 1350 |
| **total** | **3400** |

**50% needed against 34% earned. Every member with no referrals is 16% short at every
crossing, permanently, by construction.** That is the parked queue. It is not member
behaviour and no rescue policy can fix it — the suite already names the population:
*"the 84% member — the live median"* (50% reserve + 34% earnings = 84% of the fee).

Independent confirmation that `insolvencyFloorBps = 3400` is the SAME number:
`250 + 1800 + 1350 = 3400`. The floor was set from a measured "~34% median", and it turns
out to equal, exactly, **what a no-referral member earns on one complete journey**. So
policy B's rule reads, in plain language: *never lend more than one full journey's
earnings*. Worth stating that way in member comms — it is far more defensible than a
median.

### WHY THE IDEA WORKS — the constants already support it, with no re-tuning

```
CROSSING_RESERVE_BPS 5000  +  DIRECT_EARN_BPS 250  +  splits 4750  =  10000
```

**The distributions consume exactly 50% of a fee. The other 50% is the member's own
reserve.** So a crossing paid entirely from the $5.00 reserve funds the destination
matrix's L1, chain pay, pool, treasury, SF, dev, ops, community, buyback and liquidity
**identically to today — the same dollars to every destination.** Nothing is lost
anywhere, and not one split BPS needs changing. The owner's instinct that *the reserve IS
the crossing* is correct in the constants.

### WHAT IT CHANGES, AT T1 ($10 fee, no referrals)

| | today | with item A |
|---|---|---|
| enter MatA | $10 → $5 reserve + $5 distributed | unchanged |
| cross A → B | **$10** — reserve $5 + **$5 from earnings** → short **$1.60** → PARK | **$5 from reserve. No shortfall. No park.** |
| journey in B | earns 34%, clawback eats it repaying the A→B loan | earns 34%, kept |
| cycle out of B → re-enter A | $10 needed, short again → second loan → **refused, evicted** | $10 needed, holds ~68% → short ~32%, **one loan** |
| loan events per full cycle | **2** | **1** |
| mid-cycle parking | **yes — this is the queue** | **none** |

**Same total cost per cycle (32% of a fee either way — conservation). Different timing.**
Half the loan events, and the member is never stuck mid-cycle.

### ⛔ WHAT IT DOES *NOT* FIX — READ THIS BEFORE BUILDING

Per full A+B cycle a no-referral member earns **68%** of a fee and needs **100%** to start
the next one. **That 32% gap is the system's own take** — L1, treasury, SF, dev, ops,
community, buyback, liquidity: ~16% per seat, twice per cycle. **Loans defer that gap;
nothing closes it except referral income.** `CLAUDE.md` already states this is the design:
*"a member with no referral income can essentially never self-fund a re-entry."*

So item A buys **timing and dignity**, not solvency. Do not build it expecting the queue
to stop growing. It is still worth building: it removes mid-cycle eviction entirely, which
is the owner's stated requirement.

### ⚠️ THE MARGIN IS THIN — MODEL BEFORE BUILDING

The single end-of-cycle shortfall is ~32% ($3.20) against a 34% floor ($3.40). That fits —
**barely**. Members whose journeys earn less than the structural $3.40 (measured lifetime
earnings ran **$2.32–$3.82**) fall outside it and are refused anyway. **Model it against
the live population first**, the way `scripts/model_insolvency_floor.js` did, before
writing contract code. The answer may be that the floor needs recalibrating WITH this
change — see item C.

### TOUCH POINTS (expect more; the plan is always short)

- `MatrixLogicLib._crossToPartner` — charge the reserve amount, not `reentryFee`
- the destination's entry accounting — accept a 50% payment and **skip the reserve carve**
- `MatrixKeeperLib._triageParked` / `MatrixKeeper._doParkedRescue` — `effectiveContrib` and
  the shortfall maths both assume a full-fee crossing
- `exitSeat` and `evictParked` reserve release — a member mid-cycle now holds **$0** reserve
- the **tier-upgrade** path needs its own answer: is upgrading a new cycle (full fee) or a
  crossing (reserve only)? **Decide deliberately; do not let it fall out of the diff.**
- every fixture asserting a full-fee crossing. **V8.49's much smaller change predicted 2
  breakages and had 4, three of them the same hidden assumption.** Grep the suite for the
  OLD justification, not just the identifier.

---

## ITEM B — NO MEMBER IS EVICTED MID-CYCLE (owner requirement, 2026-08-16)

> *"I do not want any member evicted mid cycle — they should complete their cycle before
> being evicted."*

**This is not separable from item A, and an earlier draft wrongly said it was.** A member
parked at the A→B crossing **is** mid-cycle, and that is the main parked population.
Honouring the rule without item A means either lending at every A→B crossing (exactly what
the floor exists to prevent) or leaving those members parked forever (growing the queue the
owner wants drained). **Item A is what makes this rule free:** if the reserve covers the
crossing outright, nobody is ever stuck mid-cycle to begin with.

Ship them together. If item A is ever dropped, this item has to be re-argued from scratch.

---

## ITEM C — LADDER VS FLOOR (deferred out of V8.49 ON PURPOSE)

Full write-up in `V8_49_SCOPE.md` item 1b, "⚠️ NEW, UNRESOLVED". Summary: the SF rescue
ladder lends up to **60%** of the entry fee while the insolvency floor caps debt at
**34%**, so a member below **66% effective contribution** is refused **with zero debt**,
and preset 1's bottom rungs can never fire.

**Why it moved here:** item A changes the entire shortfall distribution. Deciding the
calibration against today's numbers would mean deciding it twice, the second time against
figures that no longer describe the system. **Decide it here, from the V8.49 test's
measurements (T2 and T3), with item A's economics in hand.**

Options unchanged: accept it / trim the ladder to where the floor bites / raise
`insolvencyFloorBps` (PARAM 59, menu `0/1700/2500/3400/5000/6800/10000`).

---

## ITEM D — SHALLOW SEATING: A FULL FEE CAN BUY A FRACTION OF A JOURNEY

`_lowestFreeSlot` scans from position **1 upward**, so a slot freed by `reclaimIdleSlot` is
filled **before** seat 127. That member inherits the tail of someone else's journey.

The pool pays each seat in proportion to its **current position** (`share = P * p / W`,
`W = N(N+1)/2 - 1`; confirmed independently by the JS mirror of the V8.43 loop in
`V8_44_PoolEquivalence.test.js:113`). A full ride collects weights 127 down to 2, summing
to exactly `W` — one rotation's pool, $1.80. A member seated shallow collects only the
slices from their seat down:

| seated at | pool | chain pay | + direct | **total earned** |
|---|---|---|---|---|
| 127 | $1.80 | $1.35 | $0.25 | **$3.40** |
| 64 | $0.46 | $1.35 | $0.25 | **$2.06** |
| 32 | $0.12 | $1.08 | $0.25 | **$1.45** |
| 8 | $0.008 | $0.54 | $0.25 | **$0.80** |
| 2 | $0.0004 | $0.00 | $0.25 | **$0.25** |

**A member seated at seat 2 pays a full $10, receives $0.25, reaches the crossing $4.75
short, is refused by the floor and evicted.** No funds leak — the slices they did not
collect went to deeper members — but **they paid full price for a fraction of a ride.**

**FREQUENCY IS UNMEASURED** — that is test T5 in `V8_49_TEST_PLAN.md`. If it is rare, note
it and move on. If it is common, the fix belongs in seating (seat new entrants at the
deepest free slot, or bar reclaimed shallow slots from new entrants) — **not** in the
floor, which would only be punishing members for where the system sat them.

---

## SEQUENCING

1. **V8.49 → private chain**, owner + bigfill, split cohort. `V8_49_TEST_PLAN.md`.
2. Read T1–T6. **Model item A** against that population.
3. Build V8.50: items A + B together, C calibrated from the measurements, D only if T5
   says it is real.
4. **V8.50 is the deploy the community re-registers into.** One member-facing deploy, not
   four.
