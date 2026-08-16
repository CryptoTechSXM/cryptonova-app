# V8.50 SCOPE — the crossing redesign. THE version the community joins.

Opened 2026-08-16. Audience: a future session of Claude, plus the owner.

Read `V8_49_HANDOFF.md` first, then `V8_49_TEST_PLAN.md` (V8.49 is a PRIVATE measurement
deploy — owner + bigfill only). **V8.50 is the release members re-register into**, so it
carries the economics changes, not V8.49.

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
