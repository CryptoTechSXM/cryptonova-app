# V8.50 HANDOFF — the crossing redesign. READ THIS FIRST.

Written 2026-08-16 at the end of the V8.49 private measurement run.
Sessions 2-27 have appended to it since; read the NEWEST section first — each one
corrects the ones below it, and says so explicitly where it does.
Audience: **the next session of Claude, plus the owner. There is no third party — every
line of this codebase was written by a previous session of Claude and executed by the
owner.** Read section 7a (THE TWO RULES) before doing anything else; it is short, it is
owner-set, and the session that earned it got five things wrong by ignoring what it says.

---

# ⬛ SESSION 27 STATE — 2026-08-21, LATEST. READ THIS FIRST.
# ✅ THE DEPLOY GATE IS A RUNBOOK PHASE NOW — `GO_LIVE_RUNBOOK.md` PHASE G — AND THE ONE
# TOOL IT WAS MISSING IS BUILT AND SELF-VALIDATED.

Instrument + runbook. **Nothing deployed, no contract file touched.** One new read-only
script, one new runbook phase, two stale numbers corrected in place.

## 27.0 ⛔ THE GAP THAT WAS FOUND WHILE WRITING THE RUNBOOK: NOTHING MEASURED KEEPER GAS ON A CHAIN

The gate's measurement 1 — *gas per SF-funded rescue at 127* — had **no tool**. Grepped
every script: several read `gasUsed`, several decode `performData`, **none does both**.
`V8_50_KeeperGas.test.js` measures per-item gas but is Hardhat at `MATRIX_SIZE` 7;
`diag_floor_halt.js` decodes work items but is a static reachability check for the floor
path. So the gate's single most important number had a threshold and no instrument.

**`scripts/diag_keeper_gas_live.js`** — read-only, 12 self-test assertions passing.

## 27.1 ⛔⛔ THE DESIGN CALL THAT MAKES MEASUREMENT 1 POSSIBLE: ONE ITEM PER TRANSACTION
⚠ **READ 27.5 WITH THIS.** The first version of this said "pin `maxItemsPerUpkeep` to 1" — which the setter does not allow. The mechanism below is unchanged; the way it is reached is not.

`gasUsed` is per **batch**. A mixed batch tells you what the batch cost and nothing about
the parts, and a per-item number fitted from mixed batches is **a model, not a
measurement** — which rule 1 exists to keep out of this record.

So the runbook drives **one item per transaction** (`testchain_keeper.js ONE_ITEM=1`;
27.5 explains why not the cap). Every `performUpkeep` then runs exactly one item and its `gasUsed` IS that item's cost plus a
fixed overhead — **and the overhead is measured too**, read off the cheapest work type in
the same run (a reclaim is ~0.04M at size 7), never assumed. The tool enforces this: single-
item batches are the only ones that enter a per-item figure, and mixed ones are **counted
and reported rather than silently dropped**.

⚠ **IT ALSO TRUNCATES AT A HALT.** When `BatchGasHalted(processed, total, …)` fires, the
items after `processed` never ran, so the tool slices the decoded list to `processed`
before pricing anything. Without that, a halted batch would attribute its gas across items
that were never dispatched.

✅ **AND IT REFUSES TO ANSWER RATHER THAN GUESS.** `gateVerdict` returns **null**, never a
pass, when no single-item rescue was observed or when no cheap type was seen to measure the
overhead with. The self-test pins both refusals, and pins that the same data **fails** a 3M
guard while passing a 5M one — so the verdict is not a rubber stamp.

## 27.2 ✅ THE FAILURE MODE, WRITTEN INTO THE RUNBOOK WHERE IT DECIDES SOMETHING

`minGasPerItem` is checked **before** an item is dispatched (`MatrixKeeper.sol:798`). Below
it, the batch emits `BatchGasHalted` and breaks — visible, clean, work rediscovered next
tick. **That is the guard working, and defect 8 built it exactly so exhaustion would be
distinguishable from refusal.**

⛔ **THE HOLE IS THE OTHER DIRECTION.** Set `minGasPerItem` too LOW and the guard passes,
the item starts, and it dies inside the `try/catch` as `WorkItemFailed` — an event carrying
a work type and addresses and **no reason**. An out-of-gas rescue and a rescue that
reverted for any other cause are **the same line in the log**. On a community chain that
reads as "members are not being rescued", which is also what an ordinary refusal looks
like. **That is the whole argument for a private chain, and it is now stated where the
stop condition sits rather than three documents away.**

So PHASE G's measurement 2 stop rule is: **any `WorkItemFailed` on `PARKED_RESCUE` must be
explained before go-live**, and *"`BatchGasHalted` never fired"* is an unfinished
measurement, not a pass.

## 27.3 ⛔ TWO STALE NUMBERS CORRECTED IN PLACE

* **`minGasPerItem` 3.5M → 5,000,000.** The deploy-gate section still tested against the
  pre-decision value in both its risk list and its measurement table. 20.5 flagged it and
  deliberately left it; PHASE G now carries the correct number and the old section has a
  banner. **Do not carry 3.5M into the run.**
* **Risk 2 of the original four is CLOSED** (20.4) and the gate section now says so.
  Risks 1, 3 and 4 remain and are all the same question: nothing in V8.50 has ever run at
  127 on a real chain.

## 27.4 ✅ WHAT PHASE G IS, AND — MORE USEFULLY — WHAT IT IS NOT

**It is a GAS test.** The economics are measured to exhaustion and are not the risk. And
gas is the one thing a chain of scripts measures **honestly**: gas does not care whether an
address belongs to a person or to bigfill. That is the cleanest justification for the
private chain and it is now the phase's opening line.

⛔ **IT CANNOT ANSWER ANYTHING MEMBER-SHAPED, AND THE PHASE SAYS SO IN ITS OWN CLOSING
SECTION** — behaviour under refusal (nothing anywhere contains a member who invited someone
*because* they were refused), the live V8.50 shortfall distribution (19.6: needs V8.50 live
plus weeks), 14.1 re-measured honestly (18.0). **Those wait for the community and nothing
should be held back for them.** The two are not alternatives: PHASE G asks whether the
machine runs at real size; the community asks how people behave.

## 27.5 ⛔⛔ A STEP IN MY OWN RUNBOOK THAT COULD NOT HAVE RUN — CAUGHT BEFORE THE OWNER HIT IT

PHASE G's measurement 1 was first written as *"set `maxItemsPerUpkeep` to 1"*.
**`setMaxItemsPerUpkeep` accepts 5 | 10 | 15 | 20 | 30 | 40 and reverts on anything else.**
A cap of 1 is not on the menu and never was. The step was written from the shape of the
measurement rather than from the setter, and it would have stopped the owner at G.2 on a
freshly deployed private chain — the most expensive place to discover it.

⛔ **THIS IS RULE 2 IN MY OWN HANDS, AND IT IS THE SECOND TIME THIS WEEK** (22.5 was the
untagged tail dial). **A runbook step is a claim about a contract, and it needs reading
before it is written down.** `set_max_items.js` also hardcodes its value — the comment says
30, `NEW_CAP` says 20 — so it could not have been used for this either way.

✅ **THE REPLACEMENT IS BETTER THAN THE ORIGINAL, AND NEEDS NO SETTER.** `performUpkeep`
decodes its work list straight from calldata and never checks that the list came from
`checkUpkeep`; the owner is always allowlisted. So the driver simply **sends one item**.
`scripts/testchain_keeper.js` — already the private-chain driver, already signing as
deployer, already laddering the gas estimate and surviving reverts — gains `ONE_ITEM=1`:
it sends the FIRST discovered item as its own transaction and leaves the rest for the next
tick, with fresh `checkUpkeep` state between them. Defect 6 orders discovery to take parked
work first, so the item priced is usually the dear one.

⚠ **AND IT FIXES A FIGURE THAT WAS ALREADY BEING PRINTED WRONG.** That driver has always
logged `gasUsed / items.length` as "k/item". **That is a fitted average, not a measurement**
— an eviction costs 1/18th of a rescue, so the mean of a mixed batch describes nothing that
happened. It is the number the ~2.6M estimate the gate tests against came from. The line
now prints `EXACT` under `ONE_ITEM` and `avg` otherwise, and carries the warning inline.

⚠ **THE RE-ENCODE IS THE ONE RISKY LINE AND IT WAS ROUND-TRIP CHECKED** (decode a 3-item
batch → re-encode the first → decode again → same work type, tier and both addresses). The
rest of the mode is unexercised until the private chain runs it.

### 27.5a ⛔⛔ AND IT WAS NOT ONE STEP — A FULL AUDIT FOUND FIVE MORE, PLUS ONE THAT WOULD HAVE MADE THE PHASE RETURN NOTHING

After 27.5 the whole phase was re-walked against the scripts rather than against
convention. **Five of eight commands had the wrong invocation.** `diag_keeper_gas_live.js`
(mine), `model_item_a.js`, `diag_sf_debt_reconcile.js` and `audit_frontend_abi.js` are
**plain node** — they build their own provider from `.env` and have no `--network` flag —
and were all written as `npx hardhat run … --network baseSepolia`. `bigfill_v8.js` is the
reverse: written as `node`, and it is hardhat. `testchain_keeper.js` was the only one right.

⛔⛔ **AND THE ONE THAT MATTERS MOST WAS NOT AN INVOCATION.** `run_bigfill_rr.ps1` sets
**`SELF_RESCUE_RATE = 1.0`** — every parked wallet pays its own shortfall. **The fund then
never lends, no `WORK_PARKED_RESCUE` with `sfShare > 0` is ever queued, and an SF-funded
rescue is precisely the item measurement 1 exists to price.** Run as written, G.3 would
have returned "NO VERDICT" indefinitely on a correctly-built chain, and it would have read
as a broken tool rather than a fill that could not produce the work.

**G.1 now runs the wrapper with `-SelfRescueRate 0.1`,** flagged as a deliberate departure
from the owner-approved default and scoped to the measurement window. ⚠ It is **not** a
claim about realism — live self-rescues ~72% of episodes (25.x) — but **gas does not care**:
the item costs what it costs. Turn it back up for anything economic.

**And a new G.1b:** `node scripts\diag_keeper_work.js` to confirm `PARKED_RESCUE` items are
actually in the discovered list **before** spending a measurement on them. ⛔ Do not proceed
to G.2 on an empty queue.

> ⛔ **THE STANDING LESSON, AND IT IS 7a RULE 2 POINTED AT DOCUMENTS:** a runbook step is a
> claim about a script and about a contract. **Six of the eight in this phase were written
> from the shape of the task and were wrong.** Nothing here was found by running it — every
> one came from reading the file the step names. **Re-walk a runbook against its scripts
> before anyone follows it onto a fresh deploy.**

## 27.6 NEXT, IN ORDER — SUPERSEDES 26.5.

1. **RUN `GO_LIVE_RUNBOOK.md` PHASE G.** Owner's machine, private chain, `MATRIX_SIZE` 127,
   hours not days. G.3 and G.6 are the two stop conditions.
2. **SPLIT THE `shortfall == 0` BUCKET IN `diag_parked_experiment.js`** (26.4) — the only
   thing that can close `:936`. One pass over logs it already fetches. ⛔ Needs an RPC;
   **batch it with PHASE G** rather than making it its own trip.
3. **PHASE 2 ONWARDS** — the community deploy — only after PHASE G passes.
4. **POST-MIGRATION:** PHASE 7b — pre-flight, check the live histogram against 19.1, arm at
   3000. Then re-run `diag_referral_threshold.js` section 4 + the loan book (19.6).
5. Backlog: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4 counts the
   dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep`
   live 15 vs 20 in source (25.6); member-callable re-entry. Plus the three orphan
   session-13 fragments 19.18c flagged.

⚠ **ONE OPEN OPTION, PRICED NOWHERE YET.** If `WorkItemFailed` carried a reason or the
remaining gas, an exhaustion failure would stop being indistinguishable from a refusal and
the blast radius of a wrong `minGasPerItem` on live would drop sharply. **It would NOT tell
anyone what a rescue costs at 127** — it makes the failure legible, it does not remove the
unknown, so it is not a substitute for PHASE G. Cost in bytes is unmeasured; MatrixKeeper's
headroom was never the tight one (TierRouter's 530 spare is), but that is not a measurement
either. Raise it only if PHASE G comes back uncomfortable.

---

# ⬛ SESSION 26 STATE — 2026-08-21. READ AFTER SESSION 27.
# ⛔ `:936` CLASSIFIED: IT IS A DOOR, A ONE-PAIR WORLD CANNOT REACH IT, AND THE TWO-PAIR
# ROUTE IS BLOCKED BY THE SAME WEALTH BOUND THAT CAPS CASCADE DEPTH. UNREACHED ≠ UNREACHABLE.

Source reading plus one throwaway probe. **Nothing deployed, no contract file touched, no
test added.** Also: the owner's decision on 25.8 item 2 applied — **14.1 keeps its banner,
14.2 is struck in place** (session 7's convention, so the failure mode stays legible).

## 26.0 ✅ FIRST, THE PART THAT IS SETTLED: IF `:936` FIRES, IT IS A DOOR

`_crossToPartner` parks at `:936` **before** it reaches the funding arithmetic at `:977` and
before `_finalizeCrossing`. So the member it parks is:

* a root **`_cycleOutRoot` has already removed from this matrix's seat map** — not seated here,
* **never seated in the partner** — the crossing is exactly what was refused,
* **holding an unspent crossing reserve** — nothing has drawn it down yet,
* and **the branch contains no ghost test at all**, unlike `:906`.

That is `evictParked`'s EVICTION branch on all three conditions. **`:936` is a second door to
`EvictionReserveReleased`, not a ghost.** 20.3a suspected this; it is now read off the source
rather than suspected.

## 26.1 ✅ AND THE PART THAT IS NOW AN ARGUMENT INSTEAD OF A GUESS: A ONE-PAIR WORLD CANNOT REACH IT

22's "0 firings in 45 registrations" was a count with a marked-UNVERIFIED story attached.
The story is now checkable and it turns on one fact worth stating loudly:

> ⛔ **`_crossToPartner` HAS EXACTLY ONE CALLER — `_cycleOutRoot`.** Not the rescue paths,
> not `forceCross`, not `coPayRescue`. Verified by grep across `MatrixLogicLib`: two hits,
> the definition and the single call at `:911`.

Everything follows from that. `crossingInProgress` on a matrix is true **only** while a root
it has just cycled out is entering the partner — and at that instant the matrix has been
compacted and holds **exactly one free slot**. So `:936` needs a **second** entry into that
same matrix, while full, inside the nested cascade. In one pair there is exactly one:

| candidate entry | where it lands | reaches MatA₁ again? |
|---|---|---|
| re-entry (`_sameTierTarget`) | *"Re-entry ALWAYS returns to the member's own MatA"* | **yes — and it fills the one free slot exactly** |
| double (`freePairFor(member, ownPair)`) | a **different** pair, by construction | no |
| upgrade | tier + 1 | no — tiers only go up, nothing comes back down |

✅ **AND THE SUITE ALREADY PINS THE LOAD-BEARING STEP.** `V8_50_EvictionReserve.test.js`
ER-1 asserts `occupancy == SIZE` at the `:523` park: the nested cascade refilled the freed
slot **exactly**, no second entry arrived, no nested MatA cycle-out ran. That assertion was
written for another purpose and happens to be the one-pair proof.

## 26.2 ⛔ THE TWO-PAIR ROUTE EXISTS ON PAPER — AND THE PROBE COULD NOT OPEN IT

The missing second entry can only come from another pair's double landing back on pair 1:

```
MatA₁ cycles out R1 -> crossingInProgress = true -> MatB₁._enterMatrix(R1)
  MatB₁ full -> cycles out R2 -> handleCycleOut(R2)
    re-entry -> R2 into MatA₁                (fills the one free slot)
    double   -> R2 into pair 2               (freePairFor avoids pair 1)
      pair 2 full -> cycles out R3 -> handleCycleOut(R3)
        double -> freePairFor(R3, pair2) MAY RETURN PAIR 1
          -> entry into MatA₁, NOW FULL -> _cycleOutRoot -> _crossToPartner
          -> crossingInProgress STILL TRUE -> :936
```

**Probe: two pairs at T1, `MATRIX_SIZE` 7, 55 registrations, `setMemberOptions(false, true,
true)` on every member so re-entry AND double are both on, `reentryMinCycles` at 1 — the
lowest its setter accepts (1/2/3/5 only, so 0 is not available).**

| | |
|---|---|
| crossings | 48 |
| re-entries | **2** |
| doubles fired | **0** |
| pair 2 occupancy after 55 registrations | **0 / 0 — it never received a single member** |
| `:936` candidates | 0 |

⛔ **THE ROUTE WAS NEVER AVAILABLE, SO THIS RUN DOES NOT REFUTE ANYTHING.** `_executeAdditive`
only seats when `escrow + withdrawable >= curFee`, and **item A leaves a MatB cycle-out with
escrow 0**, so each link now demands the full fee from EARNINGS. Fresh members do not have
it: 48 crossings produced 2 re-entries and no doubles at all. **This is the same wall
V8.46-B already documented** — *"depth is bounded by WEALTH… fresh fixtures stop at two
tiers; production reaches six because members accrue"* — and 18.8 noted item A tightened it
from 50% to 100%.

## 26.3 ⛔ THE VERDICT, AND IT IS NOT "UNREACHABLE"

**`:936` IS UNREACHED, NOT PROVEN UNREACHABLE.** Three statements, ranked by how well they
are supported:

1. **MEASURED + ARGUED:** a one-pair fixture cannot produce it. 22's 0/45 now has a
   mechanism behind it and ER-1 pins the load-bearing step.
2. **MEASURED:** a two-pair fixture with every flag set the right way still cannot produce
   it, because the wealth bound stops the cascade two links short. 0 doubles in 55
   registrations.
3. **DERIVED, UNVERIFIED:** the route above would produce it in a world where members are
   rich enough for doubles to fire — **which is production, not a fixture.** Live V8.48
   already runs 2 pairs at T1 and 5 at T2 (25's run header), and V8.46-B measured real
   members cascading six tiers deep. **Nobody has looked for `:936` on live.**

⛔ **SO THE STANDING RULE STANDS: DO NOT WRITE "EXACTLY ONE DOOR."** What changed is that
the second door now has a named route, a named blocker, and a named place to look.

✅ **AND IT DOES NOT THREATEN ANYTHING SHIPPED.** ER-1 already proved the release path works
when it is entered; `:936` would be a second way in, not a different behaviour. This is a
POPULATION question, not a safety one — 19.18a's distinction, holding again.

## 26.4 ▶ THE CHEAP WAY TO CLOSE IT, FOR A SESSION WITH AN RPC

A `:936` park on live has a signature no other site shares — the same one the probe used:

> `MemberParked(m, 0)` from a **MatA**, plus `MemberCycledOut(m)` from that **same** matrix
> in the **same tx**, and **no** `CycleOutFailed(m)`.

`:529` parks the tx's entrant and emits no `MemberCycledOut` for them; `:881` and `:908`
park the root but always emit `CycleOutFailed`. **One pass over the matrix logs
`diag_parked_experiment.js` already pulls would answer it** — the events are all in the
sweep it does today, and its 122 "parks with shortfall == 0" bucket is where any `:936`
would currently be hiding, counted and discarded. Add the split to that bucket rather than
building a new tool.

## 26.5 NEXT, IN ORDER — SUPERSEDES 25.8. ⚠ ITEM 1 IS CLASSIFIED, NOT CLOSED.
✅ **SUPERSEDED BY 27.5.** The deploy gate is now `GO_LIVE_RUNBOOK.md` PHASE G, and 26.4's
`:936` log split should be batched into the same RPC trip.

1. **SPLIT THE `shortfall == 0` BUCKET IN `diag_parked_experiment.js`** (26.4) and re-run
   with 24.3's command. Cheap — one pass over logs already fetched — and it is the only
   thing that can close `:936`. ⛔ Needs an RPC; batch it with anything else live.
2. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4. Read
   20.5 first: the gate's own text still tests against `minGasPerItem` 3.5M and the source
   has been 5,000,000 since 2026-08-18.
3. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
4. Backlog: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4 counts the
   dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep`
   live 15 vs 20 in source (re-confirmed on chain, 25.6); member-callable re-entry. Plus
   the three orphan session-13 fragments 19.18c flagged.

---

# ⬛ SESSION 25 STATE — 2026-08-21. READ AFTER SESSION 26.
# ⛔⛔ 14.4's TIER SUSPICION IS REFUTED. ITS TIME-AT-RISK ONE IS CONFIRMED AND IT INVERTS
# 14.1's HEADLINE: ON EQUAL EXPOSURE, SELF-RESCUE BEATS THE LOAN 27.3% TO 15.1%.

24.3 was run on the owner's machine, live V8.48, blocks 45430468..45779757, **every block
range read cleanly**. **3,106 episodes** (14.1 had 1,803), 875 organic. Transcript saved to
`parked_experiment.txt` — the first time this instrument's output has been kept.

## 25.0 ⛔⛔ THE HEADLINE: 14.1's CENTRAL CLAIM DOES NOT SURVIVE AN EQUAL OBSERVATION WINDOW

14.1 closed with **"THE OWNER'S TWO-CYCLE BAR IS MET, AND IT IS THE LOAN THAT MEETS IT."**
That rested on 83.2% (SF-LOAN) vs 64.4% (SELF-RESCUE) reaching 2+ cycles, measured to the
head block. Tonight, uncapped, the same comparison is 73.0% vs 69.1% — already nearly gone.
**Capped to an equal window it reverses:**

| organic arm | n | 2+ cycles, **uncapped** | eligible | 2+ cycles, **equal window** | median exposure |
|---|---|---|---|---|---|
| **SF-LOAN** | 366 | 73.0% | 305 | **15.1%** | **76,570 blocks** |
| **SELF-RESCUE** | 369 | 69.1% | 293 | **27.3%** | **44,683 blocks** |

**The loan arm's episodes are 1.71x older.** Section 3's advantage for the loan was
substantially the loan arm having had longer to accumulate cycles. Held to the same 22,640
blocks each, **a member who paid their own way out reaches two cycles 1.81x as often as one
who was lent to.**

⚠ **THE CAP IS USABLE HERE AND ONLY HERE.** SF-LOAN loses 16.7% of its episodes to
censoring and SELF-RESCUE 20.6% — comparable, so the two are still comparing like with
like. **STILL-PARKED loses 62.9%**, which is my own standing warning firing: that arm has
not been adjusted, it has been replaced, and its 2.2% must not be quoted.

## 25.1 ✅ 14.4's TIER SUSPICION IS REFUTED — AND IN THE OPPOSITE DIRECTION

14.4 suspected *"the never-rescued arm skews to higher tiers"*. It does not:

| arm | T1 | T2 | T3 | n |
|---|---|---|---|---|
| SF-LOAN | 77% | 17% | **6%** | 366 |
| SELF-RESCUE | 73% | 22% | **5%** | 369 |
| STILL-PARKED | 76% | 23% | **1%** | 124 |

T1 shares agree within 4 points. If anything **STILL-PARKED skews slightly LOW on T3** — 1
episode of 124 — the reverse of what was feared. **So 14.1's arms ARE balanced on tier and
that table does not have to be thrown out on those grounds.** 24.4 said both branches would
be stated before the result was seen; this is the branch where the balance claim survives.

## 25.2 ⛔ BUT THE DOLLAR IMBALANCE IS REAL, IT REPRODUCED, AND TIER IS NOT THE EXPLANATION

14.4's evidence was median shortfall $2.65 for STILL-PARKED against $1.58/$1.60. **It
reproduces exactly: $2.46 against $1.60/$1.60.** Since composition is balanced, the cause is
not tier — it is **within-tier**. In T1 alone, STILL-PARKED sits at medContrib **6885** and
medShort **$2.21**, against SELF-RESCUE's 7800 / $1.57 and SF-LOAN's 7153 / $1.56.

⛔ **AND SECTION 2's BALANCE HAS DEGRADED SINCE 14.1.** Median contribBps was
7939 / 7800 / 7815 in 14.1 — indistinguishable, which was the whole basis for calling the
arms balanced. Tonight it is **7829 / 7800 / 7040**: STILL-PARKED has dropped ~775 bps
away from the other two.

⚠ **AN EXPLANATION, MARKED UNVERIFIED (rule 6).** STILL-PARKED shrank from 192 to 124
episodes while the population grew 657 → 875. An episode's arm is decided by its exit, so a
still-parked episode that is later rescued **leaves** that arm. The ones remaining are the
ones nobody could rescue — so the arm gets poorer over time by construction. That would
explain both the drop and the persistent dollar gap. **Nobody has measured it; it is a
hypothesis about a selection process, not a finding.**

**CONSEQUENCE EITHER WAY: STILL-PARKED IS NO LONGER A BALANCED CONTROL FOR THE OTHER TWO.**
SF-LOAN vs SELF-RESCUE remains balanced (7829 vs 7800) and is the comparison to use.

## 25.3 ⛔⛔ THE OWING SIDE MOVED AGAIN, EXACTLY AS 19.5 WARNED — AND ONLY FOR THE LOAN ARM

| organic | 14.1, 2026-08-20 | tonight, 2026-08-21 |
|---|---|---|
| SF-LOAN still owing | 20.2% | **56.0%** |
| SELF-RESCUE still owing | 10.0% | **11.9%** |
| STILL-PARKED still owing | 7.3% | 33.9% |

**SELF-RESCUE barely moved (1.19x). SF-LOAN nearly tripled (2.77x).** This is 19.5's
standing correction repeating on a different table: *"the clean side is stable; the owing
side moved… quote the direction, not the multiple."*

⛔ **SO 14.2's PRICED TRADE-OFF MUST BE RESTATED, NOT REQUOTED.** It read *"the loan doubles
the odds of ending in debt and buys 19 percentage points of two-cycle attainment"*. On
tonight's data the loan **quintuples** the odds of ending in debt (56.0% vs 11.9%) and, at
equal exposure, buys **NEGATIVE twelve** points of two-cycle attainment (15.1% vs 27.3%).
**Both halves of that sentence have changed, one of them in sign. Do not quote 14.2.**

## 25.4 ⛔ WHAT THE TIER SPLIT DID EARN: A STEEP GRADIENT THAT THE POOLED NUMBER HIDES, AND IT IS THE LOAN ARM'S ALONE

| still owing, organic | T1 | T2 | T3 |
|---|---|---|---|
| **SF-LOAN** | 49.3% (n282) | 72.6% (n62) | **95.5% (21 of 22)** |
| **SELF-RESCUE** | 14.1% (n270) | 5.0% (n80) | 10.5% (n19) |

**Self-rescue is flat across tiers. The loan arm climbs from half to nearly all.** The
pooled 56.0% is an average over a gradient, and at T3 a loan is very nearly a permanent
debt. ⚠ **n=22 at T3 — report it as 21 of 22, not as 95.5%**, and the same for T2's 62. The
direction is what is safe here; the levels are thin.

Same pattern on 2+ cycles: SF-LOAN 80.1% / 64.5% / **4.5%** by tier against SELF-RESCUE's
73.3% / 51.3% / 84.2%.

## 25.5 ✅ WHAT HELD, ACROSS A POPULATION 1.7x BIGGER

* **EVICTED = 0 of 3,106.** Eviction has still never fired on live V8.48. 14.3 said this at
  1,803 episodes; it survives the population nearly doubling.
* **THE BELOW-RUNG SIDE IS STILL EMPTY** (0 episodes in 2500..3999, both cohorts), so
  section 4 still has no causal reading and the ladder has still never rejected anybody.
  99.8% of organic and 100% of bigfill episodes sit at or above the 4000 bps rung.
* **14.6's ORGANIC/BIGFILL SPLIT HOLDS AND WIDENS.** Bigfill SF-LOAN ends owing at **1.7%**
  against organic's 56.0%; bigfill self-rescuers at 0.0% against 11.9%. Scripts are still
  not members and their member-specific columns are still not facts about members.

## 25.6 ⛔ THE LIVE DIALS DISAGREE WITH THE SOURCE, AND THE RUN PRINTED IT

The header reads the chain, not the repo:

| dial | live V8.48 | source / decision |
|---|---|---|
| `insolvencyFloorBps` | **3400** | **5_000** in `StabilityFund.sol:915` since the owner decision of 2026-08-19 |
| `maxItemsPerUpkeep` | **15** | 20 in source (already on the backlog) |
| `sfRescueLadderPreset` | 1 | preset 1 — matches the decision to keep it |

⚠ **THE FLOOR ONE IS EXPECTED AND MUST STILL BE STATED WITH EVERY DEBT FIGURE ABOVE.**
V8.48 was deployed 2026-08-13, six days before PARAM 59 moved; nobody set it on the live
chain, and the A/B runs 5000. **So every "owing now" number in this section was produced
under a 3400 floor, and the A/B's under 5000.** They are not the same world. 13.11 already
said tonight's chain is the wrong basis for setting the floor; this is why.

## 25.7 ⚠ WHAT THIS DOES AND DOES NOT DO TO THE GATE DECISION

**It does not reopen it.** 18.18/19.0 set the base ceiling at 3000 bps on live *crossing*
data (19.2, 19.4) and on the A/B, neither of which this touches. 19.4's at-loan-time table —
zero-direct borrowers repaying 52.0% of the time against 94.1% at two directs — is a
different instrument and is unaffected.

**It points the same way, and that is worth one line:** an arm that at equal exposure
under-performs self-rescue on cycles and ends owing five times as often is not an argument
for lending more freely. ⛔ **But it is DESCRIPTIVE and the assignment is not random** —
self-rescuers chose to spend their own money and may simply be more engaged. **No causal
claim is made and none should be quoted.**

## 25.8 NEXT, IN ORDER — SUPERSEDES 24.5. ⚠ ITEM 1 IS DONE.
✅ **SUPERSEDED BY 26.5. ITEM 1 IS CLASSIFIED (26.0-26.3) AND ITEM 2 IS DECIDED.**

1. **CLASSIFY `:936`** (20.3a). Until it is settled nobody may write "exactly one door".
   ✅ Needs no chain.
2. ~~DECIDE WHETHER 14.1/14.2 GET A CORRECTION BANNER OR A REPLACEMENT.~~ ✅ **DECIDED
   2026-08-21: 14.1 KEEPS ITS BANNER, 14.2 IS STRUCK.** 14.1 still carries the balance
   table nobody else has and half of it survived the equal-window correction; 14.2 was one
   sentence pricing a trade-off and both halves of it are now wrong. 14.2 is struck in
   place rather than deleted — session 7's convention on session 6's park table — so the
   failure mode stays legible. **25.3 is the replacement.**
3. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4. Read
   20.5 first: the gate's own text still tests against `minGasPerItem` 3.5M and the source
   has been 5,000,000 since 2026-08-18.
4. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
5. Backlog: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4 counts the
   dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry; **`maxItemsPerUpkeep`
   live 15 vs 20 in source — re-confirmed on chain tonight (25.6)**; member-callable
   re-entry. Plus the three orphan session-13 fragments 19.18c flagged.

---

# ⬛ SESSION 24 STATE — 2026-08-21. READ AFTER SESSION 25.
# ⚠ 23.7 ITEM 1 IS PREPARED, NOT DONE. THE INSTRUMENT IS BUILT AND SELF-VALIDATED; THE
# MEASUREMENT NEEDS A LIVE V8.48 READ AND THIS SESSION HAD NO RPC.

Instrument only. **Nothing deployed, no contract file touched, no chain read.** One script
extended — `scripts/diag_parked_experiment.js` gains sections 5 and 6 plus a `SELFTEST`
mode. Sections 1-4 are untouched: they are the code that produced 14.1 and were not edited.

## 24.0 ⛔ THE HONEST STATUS: BLOCKED ON ACCESS, NOT ON WORK

23.7 item 1 is 14.4's open item — *"a per-tier split has not been run and should be before
this table is used to set anything"*, plus its companion *"no time-at-risk adjustment"*.
Both are corrections to **14.1's live V8.48 table**, so both need a Base Sepolia read.

**This session could not make one.** The container's egress allowlist does not include any
Base Sepolia RPC (`sepolia.base.org` and `base-sepolia-rpc.publicnode.com` both refuse),
and the device bridge has no network at all. There is no cached episode dump to fall back
on — `diag_parked_experiment.js` prints and does not persist, so 14.1's 1,803 episodes exist
only in a console transcript.

⛔ **SO THE NUMBERS IN 14.1 STILL CARRY 14.4's WARNING UNCHANGED. Nothing in this session
changes a single figure in that table, and it must not be read as if it had.**

## 24.1 ✅ WHAT WAS DONE INSTEAD: THE INSTRUMENT, BUILT AND ACTUALLY EXERCISED

Sections 5 and 6 are written as **pure functions over the episode array** — `tierSplit`,
`cappedWindow`, `med`, `p25` — with the chain-dependent half untouched above them. That is
not tidiness: it is what let them be validated on a machine with no RPC.

**`SELFTEST=1 node scripts/diag_parked_experiment.js` — 15 assertions, all passing.** It
runs **before any `require` of hardhat or the address book**, so it needs neither a chain
nor a deployment artifact. The synthetic fixture is deliberately lopsided in exactly the
way 14.4 suspected — the rescued arms all in T1, STILL-PARKED all in T2 — so a `tierSplit`
that could not surface a skew would fail rather than pass quietly. It also pins the two
window behaviours that are easy to get wrong: a cycle **outside** the window must not
count, and a censored episode must be reported as **censored, not as a zero**.

⚠ **WHAT THE SELF-TEST DOES NOT COVER: the chain half.** Log scanning, episode
construction, arm assignment and the covariates are unchanged and unexercised by it. They
are the same code that produced 14.1 — which is the argument for not having touched them.

## 24.2 ⛔ TWO DESIGN CALLS THE NEXT SESSION SHOULD NOT RE-LITIGATE

**(a) A FIXED WINDOW, NOT A RATE.** The obvious adjustment — cycles ÷ exposure — hands
every recently-exited episode a tiny denominator on one or two events and reads as noise.
Instead: pick `W` blocks, keep only episodes with **at least `W` blocks of exposure**, and
count only cycles landing inside `(t0, t0+W]`. Every surviving episode is then observed for
exactly the same length of time. `W` defaults to the **p25 of organic exposure** so three
quarters survive the cap, and is overridable with `WINDOW_BLOCKS`.

**(b) ⛔ CAPPING HAS ITS OWN SELECTION AND THE OUTPUT SAYS SO ON ITS FACE.** Requiring `W`
blocks of exposure keeps only OLDER episodes, so the capped table describes the early
population. `censored` is printed per arm beside `eligible` for exactly that reason — **an
arm that loses most of itself to the cap has not been adjusted, it has been replaced.** The
section prints the uncapped `medExposure` too, because if the arms differ there then 14.1's
cycle columns were comparing different observation lengths, which is the whole point.

⚠ **AND 14.4's RANKING SURVIVES THE FIX.** `2+ cycles` is still PARTLY MECHANICAL — a
rescued member is seated and a seated member cycles. The window removes the exposure bias;
it does nothing about that one, and section 6 says so in its own footer.

**ORGANIC ONLY.** 14.6 measured that the member-specific columns do not reproduce on a
population of scripts (bigfill ends owing at 1.1% against organic's 20.2%), so a per-tier
split of bigfill would be a split of the wrong thing.

## 24.3 ▶ WHAT TO RUN — ONE COMMAND, ON A MACHINE WITH AN RPC

```
npx hardhat run scripts/diag_parked_experiment.js --network baseSepolia
```

Read-only, nothing written to chain. Optional: `WINDOW_BLOCKS=<n>` to pin the window
instead of taking p25; `TIERS=1,2,3` as before. **Save the transcript** —
`parked_experiment.txt` is already in `.gitignore` and 14.1's own episodes were lost to a
console because nobody did.

## 24.4 ⛔ WHAT THE RESULT DECIDES, STATED BEFORE IT IS SEEN

**Section 5A is the table that matters, and its two outcomes are not equal:**

* **If the arms' tier shares are close** — 14.4's suspicion is refuted, 14.1's balance
  claim survives, and the per-tier cells in 5B are a bonus rather than a correction.
* **If STILL-PARKED skews to higher tiers as 14.4 suspected** — then 14.1's arms are NOT
  balanced on tier, and **every outcome difference in that table is part treatment and part
  tier, in unknown proportion.** 14.2's priced trade-off (20.2% vs 10.0% ending in debt)
  would then have to be re-read from 5B's within-tier cells, not from 14.1.

⚠ **STATING BOTH BRANCHES NOW IS DELIBERATE** — 7a rule 1. Whichever way it lands, nobody
gets to decide afterwards which reading the table was always going to support.

⚠ **AND `n` GOVERNS.** 14.1's arms were 238 / 219 / 192; splitting them three ways does not
add data. Section 5B prints `n` on every row and the footer says a handful of episodes is
not a rate.

## 24.5 NEXT, IN ORDER — SUPERSEDES 23.7.
✅ **SUPERSEDED BY 25.8. ITEM 1 BELOW WAS RUN 2026-08-21 — see 25.0.**

1. **RUN 24.3** on a machine with an RPC, then read 24.4. ⚠ V8.48 measurement; 18.0's
   caveat about re-measuring 14.1 on a private deploy still applies and this is not that.
2. **CLASSIFY `:936`** (20.3a). Until it is settled nobody may write "exactly one door".
   ✅ Doable with no chain — it is a Hardhat question.
3. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4. Read
   20.5 first: the gate's own text still tests against `minGasPerItem` 3.5M and the source
   has been 5,000,000 since 2026-08-18.
4. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
5. Backlog, untouched: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4
   counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry;
   `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry. Plus the three
   orphan session-13 fragments 19.18c flagged.

⚠ **A STANDING NOTE ON WHAT A CLOUD SESSION CAN AND CANNOT DO.** Hardhat unit tests, the
A/B harness and any pure-computation instrument all run here fine (the compiler is seeded
per 20.9b). **Anything that reads Base Sepolia does not.** Items that need the live chain
should be batched for a session on the owner's machine rather than discovered one at a time.

---

# ⬛ SESSION 23 STATE — 2026-08-21. READ AFTER SESSION 24.
# ✅ THE CLAWBACK PRESETS ARE PRICED. 19.17b's OPEN HALF IS CLOSED — AS A UNIT TEST.

Test-only session. **Nothing deployed, no contract file touched.** One new test file.

## 23.0 ✅ THE ANSWER, AND IT IS A FRACTION OF EVERY EARNING

`test/V8_50_ClawbackPresets.test.js` — **7 passing.** For a member who owes the fund, at
each settled pool share:

| preset | band 3 | redirected to the fund | **the member keeps** |
|---|---|---|---|
| 0 OFF | 0 | $0.0000 | **100%** |
| 1 GENTLE | 3000 | $0.4704 | **70%** |
| **2 CURRENT (shipped)** | 6000 | $0.9408 | **40%** |
| 3 HARD | 8000 | $1.2544 | **20%** |

(measured against a real accrued share of **$1.5680**; the dollar figures are this
fixture's, the **percentages are the dial** and are exact.)

⛔ **SO THE SHIPPED DEFAULT LEAVES AN INDEBTED MEMBER 40% OF EACH DISTRIBUTION.** That is
the number 19.17b said had never been measured — *"how fast debt retires and how much a
member can withdraw were NOT measured"* — and it is the one an owner needs to hold the
menu against. Preset 3 leaves them a fifth; preset 1 leaves them seven tenths.

## 23.1 ✅ WHAT ELSE THE RUN ESTABLISHED, NONE OF WHICH WAS KNOWN

* **THE ARITHMETIC IS EXACT.** The redirect is `share × band3 / 10000` to the unit at
  every preset, the member's debt falls by exactly that, and **the fund RECEIVES exactly
  that** — asserted on all three ledgers, not just the event.
* **THE MENU IS ORDERED AS IT READS.** Strictly monotone 0 < GENTLE < CURRENT < HARD, and
  `redirect + kept` reconstructs the share exactly, so no money leaves the ledger in
  between.
* **THE CLAMP WORKS AND RESETS THE BAND.** A debt smaller than the redirect clamps to the
  debt rather than over-collecting, clears it, and resets `debtIssuingTier` to 0 so a later
  debt re-bands from scratch (CP-5). That branch had no coverage.
* ✅ **THE ESTIMATE AND THE COLLECTION AGREE TO THE UNIT** (CP-6). 22.3 found
  `withdrawableOf`'s estimate moving while the A/B collected $0.00; that was the harness
  never firing the settle, not a divergence. When the settle DOES fire, the number the
  member was shown is the number they end up holding. **That is the thing that would have
  been a real defect, and it is now pinned.**
* **A TIER-0 DEBT RESOLVES TO BAND 3**, read off `clawbackBpsFor` rather than assumed
  (CP-0), and the four bands are read back and compared against this file's own table so a
  renumbered menu fails the run instead of silently pricing different values.

## 23.2 ⛔ THE TRIGGER CHOICE IS THE WHOLE EXPERIMENT, AND THE OBVIOUS ONE IS A TRAP

`withdrawCore` settles the pool too — and then repays the member's **ENTIRE remaining
debt** out of withdrawable (`MatrixLogicLib:1381-1395`), emitting a SECOND
`RescueDebtRepaid` in the same transaction. **A test built on `withdraw()` would see the
debt cleared at every preset and report "the preset does nothing"** — the same false null
the A/B produced in 22.0, arrived at by a different route and just as believable.

`softParkIdle` settles (`:1500`) and performs no other repayment, so exactly one repayment
site is in play and the number measured is the redirect itself.

⚠ **AND THE ORDERING IS THE CONTROL.** Registrations run first and identically in all four
worlds; the debt is booked and the preset armed only afterwards, so the accrued share is
the same number in every run. **CP-1 asserts that rather than trusting it** — without it a
difference in the redirect would be part dial and part fixture in unknown proportion, which
is the V8.49 run's own worst failure.

## 23.3 ⚠ WHAT THIS DOES NOT SAY

* **BAND 3 ONLY.** `_bandOf` sends T1-T3 to band 3 and this fixture is single-tier. Bands
  0-2 (T4-T10) are unpriced and no assertion here pretends otherwise. 19.17b's "in practice
  only band 3 has a population" is why that is the right scope, not a gap.
* **NOT A RETIREMENT RATE.** "How fast debt retires" has no single number: it is
  `band3` of each settle, and how often a member settles is a property of the population,
  not of the dial. What is measured is the fraction; the frequency is 22.0's territory and
  22.0 showed the A/B never reaches it.
* **NO POPULATION CLAIM.** A unit test proves the mechanism, not how many members are in
  it — 19.18a's caveat, and 14.3's before that.
* ⛔ **AND IT DOES NOT MAKE A RECOMMENDATION.** The bands are economics and economics is
  the owner's call. What changed is that the menu now has a measured meaning attached to
  every entry instead of only to preset 2.

## 23.4 ⛔ THE TWO FINDINGS TOGETHER ARE THE POLICY SHAPE, AND NEITHER IS OBVIOUS ALONE

22.0: on the A/B — a young, park-heavy population — **every preset collects $0.00 and
changes nothing**, because borrowers are parked and parked members hold no seat.
23.0: on a member who holds a seat through rotations, **the dial takes 0/30/60/80% of every
distribution.**

**So the clawback is a lever on ESTABLISHED indebted members and a no-op on new ones.** A
change to this menu would not be felt by the population the gate decision (18.18/19.0) was
argued about; it would be felt by members who have already settled in and are still
carrying debt. Nobody had those two halves side by side before, and either one on its own
invites the wrong conclusion.

## 23.5 ⚠ A NAMING COLLISION CAUGHT BY THE SUITE TRANSCRIPT, NOT BY THE TEST

The new file's cases were first written as `CB-0..CB-6`. **`CB-*` already belongs to
`test/V8_49_CrossingBuffer.test.js`** (CB-1..CB-8, the crossingBufferBps package), so the
full-suite transcript carried two different `CB-3`s. Nothing failed — test ids are just
strings — but this repo uses them as stable handles (GF-V1, ER-1, DP-5, GATE-2 all get
quoted in the handoff and grepped for), and a duplicate makes every future reference
ambiguous. **Renamed to `CP-0..CP-6`.**

⛔ **IT WAS ONLY VISIBLE IN THE FULL-SUITE OUTPUT.** Running the new file alone showed a
clean `CB-0..CB-6` and looked right. **Grep the suite for a new id prefix before adopting
it** — a single-file run cannot see a collision by construction.

## 23.6 SUITE

**648 passing / 7 pending / 0 failing** (`suite_session23.txt`) — 22's 641 plus the 7 new
ones, so nothing existing moved. ⚠ Container run on `solcjs`; 21.5 established that
reproduces the owner's machine to the unit, but 20.7's rule still holds — **no size figure
from a container run.**

## 23.7 NEXT, IN ORDER — SUPERSEDES 22.7. ⚠ ITEM 1 IS DONE.
⚠ **SUPERSEDED BY 24.5. ITEM 1 BELOW IS PREPARED, NOT DONE — the instrument is built and
self-validated but the measurement needs a live V8.48 read (24.0).**

1. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
2. **CLASSIFY `:936`** (20.3a). Until it is settled nobody may write "exactly one door".
3. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4. Read
   20.5 first: the gate's own text still tests against `minGasPerItem` 3.5M and the source
   has been 5,000,000 since 2026-08-18.
4. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
5. Backlog, untouched: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4
   counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry;
   `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry. Plus the three
   orphan session-13 fragments 19.18c flagged.

---

# ⬛ SESSION 22 STATE — 2026-08-21. READ AFTER SESSION 23.
# ⛔⛔ THE CLAWBACK PRESETS CANNOT BE PRICED ON THIS HARNESS. ALL FOUR COLLECT $0.00.

Measurement only. **Nothing deployed, no contract file touched.** Two additive instrument
changes (`AB_CLAWBACK` dial, the debt ledger) and one instrument DEFECT FIXED — 21.4's own
tail dial was missing from the output filename and destroyed a baseline within the hour
(22.5). Transcript: `ab_rerun_clawback_presets.txt`.

## 22.0 ⛔⛔ THE RESULT: EVERY PRESET COLLECTS EXACTLY $0.00, AND EVERY OUTCOME IS IDENTICAL

V8.50 arm, gate inert, `AB_CAP=5`, 288 members, `MATRIX_SIZE` 127, 12-tick tail. The
fixture is single-tier, so `_bandOf` sends every debt to **band 3** — the `band3` column is
the dial actually under test, and this sweep says nothing about bands 0-2 (19.17b: "in
practice only band 3 has a population").

| seed | preset | band 3 | repayments | **collected** | still owing | outstanding | **withdrawable** | rescues | loans | evict | parked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 OFF | 0 | 0 | **$0.00** | 31 | $58.15 | **$1,517.49** | 51 | 31 | 4 | 31 |
| 1 | 1 GENTLE | 3000 | 0 | **$0.00** | 31 | $58.15 | **$1,513.80** | 51 | 31 | 4 | 31 |
| 1 | **2 CURRENT** | 6000 | 0 | **$0.00** | 31 | $58.15 | **$1,510.32** | 51 | 31 | 4 | 31 |
| 1 | 3 HARD | 8000 | 0 | **$0.00** | 31 | $58.15 | **$1,508.01** | 51 | 31 | 4 | 31 |
| 2 | 0 OFF | 0 | 0 | **$0.00** | 26 | $47.35 | $1,497.48 | 53 | 26 | 3 | 32 |
| 2 | **2 CURRENT** | 6000 | 0 | **$0.00** | 26 | $47.35 | $1,491.14 | 53 | 26 | 3 | 32 |
| 2 | 3 HARD | 8000 | 0 | **$0.00** | 26 | $47.35 | $1,489.03 | 53 | 26 | 3 | 32 |

**Every debt-side and outcome column is byte-identical across all four presets, on both
seeds.** Not "similar" — identical. Turning the clawback OFF entirely and turning it up to
80% produce the same 31 borrowers owing the same $58.15, the same 51 rescues, the same 31
loans, the same 4 evictions. ⚠ Seed 2 ran presets 0/2/3 only; preset 1 sits between two
identical rows and was not spent.

**This reproduces session 16 on a different build and a different instrument.** 16.x
measured the clawback collecting $0.00 inside a MatB occupancy across the whole V8.48
deployment; it collects $0.00 across a whole V8.50 A/B run as well.

## 22.1 ⛔ WHY: THE BORROWERS AND THE CLAWBACK-ELIGIBLE ARE DISJOINT INSIDE THE MEASURED RUN

The redirect lives in `_settlePool` (`MatrixLogicLib:624-641`): it takes a slice of a
member's **settled pool share**. A pool share requires a SEAT and at least one rotation
since the member's checkpoint. **The members who borrow are the members who are PARKED** —
they hold no seat, accrue no pool share, and so present the redirect with nothing to take.
The second repayment path, the MatB cycle-out sweep, needs the borrower to reach a
cycle-out, which a parked member also does not do. Within 69 ticks neither ever happens.

## 22.2 ✅ THE ZERO IS REAL, NOT A BLIND DETECTOR — CHECKED WITH A PLANTED POSITIVE

⛔ A count of zero from an instrument that has never seen a one is not a measurement. The
same debt ledger was run against the **tail-200** sequence, where rescued borrowers have
had time to hold seats and rotate:

> **45 repayments, $40.40 collected** ($19.84 emitted by MatA, $20.56 by MatB), 104 members
> still owing $225.03.

So the instrument sees repayments when repayments exist. ⚠ **That row is NOT a pricing
row** — 21.0 established that a long tail is a different world, driven by idle-slot
reclamation that never fires in the measured one. It is offered only as proof the detector
works.

## 22.3 ⛔⛔ THE ONE THING THE DIAL DOES MOVE IS AN ESTIMATE, NOT MONEY — AND THAT IS THE FINDING WORTH KEEPING

`totalWithdrawable` is the only column that responds, and it responds monotonically:
**$1,517.49 → $1,513.80 → $1,510.32 → $1,508.01** across presets 0 → 3 on seed 1, a spread
of **$9.49 (0.63%)**; seed 2 traces the same direction ($1,497.48 → $1,491.14 → $1,489.03).

The mechanism is in the source, not inferred: `withdrawableOf`'s accrual view nets off the
banded clawback as an **ESTIMATE** on *un-settled* pool accrual
(`MatrixLogicLib:749-775`, "net of the member-level redirect estimate"), while the actual
redirect in `_settlePool` never fires. So a harder preset makes members **look poorer
without the fund collecting a cent**.

⛔ **AND `withdrawableOf` IS THE AFFORDABILITY FIGURE** the rescue and crossing paths read.
A preset therefore tightens what a member can afford before it collects anything from them.
⚠ **In these runs it crossed no threshold** — rescues, loans and evictions are identical
across presets — so this is a coupling that was measured and did not bite, NOT a measured
harm. Do not quote it as one. But it does mean "preset 3 is harsher" is true of the
estimate first and of the ledger only later, which is the opposite of how a menu reads.

## 22.4 ⛔ SO THE HONEST ANSWER TO 19.17b, WHICH ASKED FOR THIS SWEEP

19.17b said preset 2 is the only entry with evidence and that the A/B harness could price
the others "exactly the way it priced the base ceiling (one dial, three seeds)". **It
cannot.** The base ceiling bound on a quantity the measured run produces in quantity
(advances); the clawback bounds on a quantity the measured run produces **none of**.

* **PRESET 2 REMAINS THE ONLY ENTRY WITH EVIDENCE.** This sweep adds none for 0, 1 or 3 —
  it establishes that this harness cannot produce any at the measured length.
* **DO NOT READ "ALL FOUR ARE IDENTICAL" AS "THE PRESET IS SAFE TO CHANGE."** It means the
  fixture never reaches the state the dial governs. On a live chain with members seated
  across many rotations, the redirect is the ordinary case rather than the absent one.
* ✅ **WHAT WOULD ACTUALLY PRICE THEM — AND IT IS A UNIT TEST, NOT AN A/B.** Seat a
  borrower, rotate the matrix until a pool share settles, and read the redirect at each
  preset. Deterministic, seconds long, and it measures the mechanism the A/B cannot reach —
  the same shape as `V8_50_EvictionReserve.test.js`, which reached a state five sessions
  had called a deploy task. **That is the next item, and it replaces "price the presets on
  the A/B harness" wherever that appears.**

  ✅ **BUILT AND RUN 2026-08-21 — `test/V8_50_ClawbackPresets.test.js`, 7 passing. THE
  ANSWER IS IN 23.0:** the member keeps 100 / 70 / 40 / 20% of each settled share at
  presets 0 / 1 / 2 / 3. The shipped default leaves an indebted member 40%.

## 22.5 ⛔⛔ AN INSTRUMENT DEFECT THIS SESSION CREATED IN THE LAST ONE, AND IT BIT WITHIN THE HOUR

21.4 made the A/B tail a parameter. **It did not put the tail in the output filename.**
`replay.js` has carried the rule since session 8 — *"EVERY DIAL THAT CHANGES THE ANSWER GOES
IN THE FILENAME"*, written after a re-run destroyed a seed's population block — and the new
dial was added without obeying it. Consequence, one hour later: the tail-200 detector run
of 22.2 wrote to `ab_result_v850_s1_gate10000.json` and **silently replaced the tail-12
default-preset baseline**, which then appeared in the sweep table as a preset-2 row showing
121 loans and 43 evictions. It was caught because that row disagreed with its own
neighbours, not because anything complained.

**FIXED:** `tailTag` now reads `seq.tail` from the sequence FILE (a sequence with no `tail`
field predates the parameter and is a 12-tick tail by construction) and both affected rows
were re-run. ⛔ **THE STANDING LESSON IS 21.6's, POINTED AT THIS SESSION: A NEW DIAL IS NOT
FINISHED UNTIL IT IS IN THE FILENAME.** The VM cannot delete, so a clobbered result does not
even leave a gap — it leaves a plausible wrong number with a recent timestamp.

## 22.6 TOOLS — both additive, both fail loudly rather than quietly

* **`AB_CLAWBACK=<0..3>`** in `test_ab/world.js`. One compile serves the whole sweep, so a
  difference between rows can only be the dial. It is deliberately NOT `optional`: a missing
  `setClawbackPreset` means an older SF, and a run that continued would report "the preset
  changed nothing" — indistinguishable from a real null result, and this session shows how
  believable that reading would have been. It also **asserts the read-back bands against
  the expected table**, because the SF stores no preset id (19.17b) and the bands are the
  only evidence the call landed; a renumbered menu fails the run instead of sweeping the
  wrong values.
* **THE DEBT LEDGER** in `test_ab/replay.js` — the half 19.17b recorded as NOT measured.
  Repayment count and volume, **split by emitting half** (MatA can only be `_settlePool`'s
  clawback; MatB mixes it with the cycle-out sweep the preset does not control — labelled
  by half rather than guessed into site names), plus the end-state read: members still
  owing, outstanding total and median, total withdrawable, total crossing reserve.
  ⛔ It **reconciles two contracts' tallies of the same money** — `RescueDebtRepaid` from
  the matrix against `MemberDebtRepaid` from the SF — and voids both on disagreement, the
  same discipline the loan book uses against `raw.loanVolume`. ⚠ `stillOwing` is an
  end-state read, not a retirement rate; a fixed-length run cannot give a half-life and
  21.0 rules out lengthening it.
* `dials.clawbackBands` is read back off the contract and lands in the filename as
  `_cb<bands>`, never as a preset id.

## 22.7 NEXT, IN ORDER — SUPERSEDES 21.7.
⛔ **SUPERSEDED BY 23.6. ITEM 1 BELOW IS DONE — the presets are priced (23.0).**

1. **PRICE THE PRESETS AS A UNIT TEST** (22.4). Seat a borrower, rotate until a pool share
   settles, read the redirect at each preset. The A/B route is closed.
2. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
3. **CLASSIFY `:936`** (20.3a). Until it is settled nobody may write "exactly one door".
4. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4. Read
   20.5 first: the gate's own text still tests against `minGasPerItem` 3.5M and the source
   has been 5,000,000 since 2026-08-18.
5. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
6. Backlog, untouched: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4
   counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry;
   `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry. Plus the three
   orphan session-13 fragments 19.18c flagged.

---

# ⬛ SESSION 21 STATE — 2026-08-21. READ AFTER SESSION 22.
# ⛔⛔ 20.8 ITEM 1 IS ANSWERED BY REFUTING IT. THE A/B TAIL CANNOT DRAIN THE QUEUE.

Measurement only. **Nothing deployed, no contract file touched.** One additive change to
`test_ab/gen_sequence.js` (the tail becomes a parameter, default unchanged). Transcript:
`ab_rerun_tailsweep.txt`.

## 21.0 ⛔⛔ THE FINDING: "LENGTHEN THE TAIL UNTIL `stillParkedAtEnd` APPROACHES ZERO" IS NOT ACHIEVABLE, AND CHASING IT PRODUCES A DIFFERENT WORLD

18.19 prescribed it, 18.21 and 19.8 and 20.8 all carried it forward as a cheap item. **It
was never measured, and it does not work.** V8.50 arm, gate inert, `AB_CAP=5`, 288 members,
`MATRIX_SIZE` 127, tails 12 / 60 / 200 / 600, **two independent seeds**:

| seed | tail | stillParked | parkEvents | **of which idle-slot** | distinctParkers | evictions | loans |
|---|---|---|---|---|---|---|---|
| 1 | **12** | **31** | 86 | **0** | 72 | 4 | 31 |
| 1 | 60 | 24 | 183 | 17 | 137 | 23 | 83 |
| 1 | 200 | **79** | 423 | 144 | 287 | 43 | 121 |
| 1 | 600 | 58 | 766 | **415** | **289** | **231** | 172 |
| 2 | 60 | 18 | 185 | 13 | 135 | 27 | 83 |
| 2 | 200 | **76** | 417 | 137 | **289** | 44 | 118 |
| 2 | 600 | 56 | 775 | **419** | **289** | **233** | 174 |

**The queue never approaches zero. It does not even decrease monotonically** — 31 → 24 →
79 → 58, and seed 2 traces the same path (18 → 76 → 56). The two seeds agree to within a
handful on every column, so this is structure, not noise (rule 5 satisfied: two independent
populations, same answer).

## 21.1 ⛔⛔ WHY, AND IT IS TWO MECHANISMS — ONE OF THEM DOES NOT EXIST AT TAIL 12

**(1) THE TAIL ADDS TIME BUT NO MONEY.** The tail is keeper ticks with zero arrivals. No
arrivals means no entry fees, so no pool distribution and no referral income — the only two
things that move a parked member's balance toward the crossing price. A member short at
tick 69 is short forever. The only exits left are a LOAN (which the insolvency floor
eventually refuses, because debt only accumulates) and EVICTION. **The queue cannot drain;
it can only be evicted.** By tail 600, **231 of 288 members have been evicted** and
`distinctParkers` is **289 — every member plus W1.**

**(2) THE KEEPER STARTS DISMANTLING THE MATRIX. READ THE `idleSlotParks` COLUMN.**
`_doReclaimSlot` reclaims a seat after 7 days idle; the tail advances **86,400s — one day —
per tick**. So once arrivals stop, nothing rotates, every seat ages past the gate, and the
keeper begins parking **SEATED** members. That mechanism contributes **0** park events at
tail 12 and **415 / 419** at tail 600. It is more than half of all park events by tail 200.

⛔ **CONSEQUENCE: A LONG-TAIL RUN IS NOT "THE SAME RUN, FURTHER ALONG". IT IS THE TEARDOWN
OF A STOPPED SYSTEM,** driven by a keeper mechanism that never fires in the measured world.
The 172 loans at tail 600 are not the uncensored version of the 31 at tail 12; they are
loans from a regime the live chain will never be in while it has arrivals.

## 21.2 ✅ SO WHAT TO DO ABOUT 18.19's REAL CONCERN, WHICH IS STILL VALID

The concern stands: 18.6's "loans fall 85 → 72" is part refusal and part truncation, and
18.19 was right that nobody should quote it as pure refusal. Three ways out, and the
recommendation is the first two together:

1. **COMPARE ONLY AT EQUAL TAIL, AND QUOTE `stillParkedAtEnd` BESIDE EVERY LOAN COUNT.**
   The censoring is shared by both arms of a comparison at the same tail, so a
   *difference* is far more trustworthy than either *level*. This costs nothing and it is
   what 18.19 itself observed before prescribing the tail.
2. **BUY COVERAGE WITH ARRIVALS, NOT TICKS.** More members keeps the system in the
   arrival-driven regime while late rescues get reached; more ticks leaves the regime
   entirely. `gen_sequence.js` already takes a member count. ⚠ Not free — 288 members is
   already ~2 minutes a run and it scales worse than linearly.
3. ⚠ **IF THE UNDERLYING QUESTION IS EVER "DOES THE QUEUE DRAIN?", THE HONEST EXPERIMENT
   RAISES `extendedIdleTimeout` FOR THE TAIL** so mechanism (2) is off and only mechanism
   (1) is being measured. **NOT DONE HERE**, and it would answer a question nobody has
   asked yet. Recorded so nobody re-derives it.

⛔ **DO NOT PUT "LENGTHEN THE TAIL" BACK ON A NEXT-LIST.** It is refuted, and the reason is
mechanical rather than a matter of degree.

## 21.3 ✅ AND IT CLEARS THE ROAD FOR THE CLAWBACK SWEEP, WHICH WAS BLOCKED BEHIND IT

20.8 ordered the tail work BEFORE pricing the clawback presets, on the reasoning that a
sweep on a censoring harness inherits the artefact. **That ordering is now void** — there is
no cleaner harness to wait for. The clawback sweep should run on the 12-tick tail like every
other sweep, at equal tail across rows, quoting `stillParkedAtEnd` with each row. It is now
the next item.

⚠ **RAN 2026-08-21, AND IT CAME BACK EMPTY — SEE 22.0.** The unblocking was correct; the
sweep executed exactly as described here and every preset collected $0.00, because the
measured run never reaches the state the dial governs. The route is closed, not pending.

## 21.4 ✅ THE TAIL IS A PARAMETER NOW, AND THE CANONICAL FILES CANNOT BE OVERWRITTEN

`node test_ab/gen_sequence.js <seed> <members> <size> [tail]`. The default is **12**, and at
the default it writes the canonical `ab_sequence_s<seed>.json` exactly as before — verified
by regenerating seed 1 and diffing: **the only change is one added `"tail": 12` line**, 427
actions and 69 keeper ticks identical. Any other value writes
`ab_sequence_s<seed>_tail<n>.json`, so a tail experiment cannot silently replace the three
files sessions 18 and 19 measured on and that `diag_referral_threshold.js` section 4C reads
to build the fixture's referral tree (19.2/19.9). The LCG is consumed only by the arrival
loop, so **arrivals are byte-identical across tails** — the sweep varies exactly one thing.

## 21.5 ✅ A CAVEAT RETIRED: THE CONTAINER REPRODUCES THE OWNER'S MACHINE EXACTLY

20.7 flagged that this session's runs use `solcjs` rather than native `solc` and that
bytecode equivalence was **an inference, not a check**. It is now a check. Replaying seed 1
at the default tail in the container reproduces
`ab_result_v850_s1_census_evict_gate10000.json` — the owner-machine run of 2026-08-21 00:26
— **to the unit on every counter**: `stillParkedAtEnd` 31, rescued 37, evicted 4, episodes
72, loans 31, rescues 51, `batchGasHalted` 1, `loanVolume` 58,151,716.

✅ **AND A SECOND THING FELL OUT OF THE SAME RUN: THE GATE IS INERT IN EFFECT, NOT MERELY
IN GAS.** 19.13's GATE-2 measured a zero GAS delta on `loanHeadroom` alone; it said nothing
about the `directCount` SSTORE the router now does on every join, in a keeper world that is
gas-bounded. Checked directly by replaying the identical sequence against the **pre-gate
tree** (`c0b2913`, no `baseAdvanceBps` in the SF at all): **every economic counter is
identical** — 31 / 31 / 51 / 4 / 58,151,716. Only `totalGas` moves, +0.4%
(1,047,458,608 → 1,051,622,313), and it changes no outcome. The gate can be shipped inert
without re-baselining anything.

## 21.6 ⛔ THE TRAP THAT COST THIS SESSION AN HOUR: THE CANONICALLY-NAMED RESULT IS THE STALE ONE

`ab_result_v850_s1_census.json` — the obvious name, the one a session reaches for — is dated
**08-19 00:25** and predates the gate work entirely. The CURRENT inert-arm result lives under
the suffixed name `ab_result_v850_s1_census_evict_gate10000.json` (08-21 00:26), because
`AB_GATE_BPS` and `AB_EVICT` both push their values into the filename. Comparing a fresh run
against the plain name produced a confident, wrong "the tree has diverged since session 18",
and it took a full pre-gate replay to disprove.

⛔ **THE DEVICE VM CANNOT DELETE FILES, SO STALE RESULTS NEVER GO AWAY — THEY JUST STOP
BEING THE NEWEST.** Rule: **read `dials` and the file's date before quoting any
`ab_result_*.json`.** A result whose `dials` block lacks `baseAdvanceBps` was produced
before session 19 and is not comparable to anything produced now. Same family as 19.17d's
three suite transcripts in one day.

## 21.7 NEXT, IN ORDER — SUPERSEDES 20.8. ⚠ ITEM 1 IS REFUTED, NOT DONE.
⛔ **SUPERSEDED BY 22.7. ITEM 1 BELOW ("price the clawback presets on the A/B harness") IS
CLOSED THE WRONG WAY — the harness cannot price them at all. READ 22.0 BEFORE ACTING.**

1. **PRICE THE CLAWBACK PRESETS** (19.17b). Presets 0/1/3 shipped with no evidence and are
   one DAO vote from live; only preset 2 has any. One dial, three seeds, 12-tick tail,
   `stillParkedAtEnd` quoted on every row. **No longer blocked — see 21.3.**
2. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
3. **CLASSIFY `:936`** (20.3a). Until it is settled nobody may write "exactly one door".
4. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4. Read
   20.5 first: the gate's own text still tests against `minGasPerItem` 3.5M and the source
   has been 5,000,000 since 2026-08-18.
5. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
6. Backlog, untouched: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4
   counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry;
   `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry. Plus the three
   orphan session-13 fragments 19.18c flagged.

---

# ⬛ SESSION 20 STATE — 2026-08-21. READ AFTER SESSION 21.
# 19.8 ITEM 1 IS CLOSED. `EvictionReserveReleased` HAS NOW EXECUTED — AND IT NEEDED NO DEPLOY.

Test-only session. **Nothing deployed, no chain written to, no contract file touched.**
One new test file, one comment correction in an existing one. Suite run end to end.

## 20.0 ✅ THE RESULT: THE RELEASE PATH FIRES, AND THE MEMBER KEEPS EVERY CENT

`test/V8_50_EvictionReserve.test.js` — **3 passing.** ER-1 reaches the `:523`
cascade-refill park, drives `evictParked`, and gets
**`EvictionReserveReleased(member, $5.00)`** — the first execution of that path
anywhere, in the suite or on any chain. The reserve moves into `withdrawable`
(**$0.25 → $5.25**), `crossingReserve` goes to 0, the member is dequeued, and:

| checked | result |
|---|---|
| USDC balance of the matrix, before vs after | **unchanged** — a ledger move, not a transfer |
| USDC balance of the StabilityFund | **unchanged** — no penalty on an involuntary exit |
| `totalEarned` / `totalWithdrawn` / `cyclesCompleted` | **unchanged** |
| SF `memberDebtOf` | **unchanged** — eviction is not debt forgiveness |
| occupancy / rotationCount / matrixPos | **unchanged** |

**18.15's "removal, not confiscation" now holds on the half of the state it could
never reach.** Its 34 members all came from MatB holding nothing; this is the first
member evicted while actually holding a reserve.

## 20.1 ⛔ 19.18a WAS RIGHT AND IT IS WORTH RESTATING: NO DEPLOY, AND NO STAGED STATE EITHER

19.18a said this is a unit test, not a deploy. True — and the run went further than
that. **The `:523` state arises from ORDINARY REGISTRATIONS.** No impersonation, no
partner swing, no forced rotation: register members one after another into a
`matrixSize` 7 pair and the entrant at **#20** is parked by the cascade-refill branch
holding the full 50% carve. The construction that three sessions called a
private-deploy task is twenty `tr.register()` calls.

The mechanism, read off the run rather than reasoned about: entry lands in a FULL
MatA → `_cycleOutRoot` compacts the array, frees exactly slot `matrixSize` and sets
`nextSlot` there → the root crosses into a FULL MatB → MatB cycles ITS root out →
`handleCycleOut` re-enters that member into the pair's MatA, taking the one free slot
→ control returns to the outer frame, `_lowestFreeSlot` returns 0, the ENTRANT parks
at `:527-529`. Then `_distributePayments` at `:539` carves the reserve — **after** the
park, with `skipReserveCarve` false because a registration is not a crossing. That
ordering is the whole reason a reserve exists to release, and ER-1 asserts it rather
than assuming it.

## 20.2 ⛔⛔ FOUR SITES EMIT `MemberParked(m, 0)`. A ZERO SHORTFALL IS NOT THE SIGNATURE.

Line numbers below are **re-read from the current source**, not carried from an
earlier section — the ones this handoff has been quoting had drifted, and checking
them is what turned up 20.3's finding.

| site | who is parked | companion event |
|---|---|---|
| `:527-529` cascade-refill entry | **THE ENTRANT** | none |
| `:879-881` `handleCycleOut` catch (MatB) | the ROOT | `CycleOutFailed` |
| `:906-908` containment pre-check (MatA) | the ROOT | `CycleOutFailed` |
| `:936-938` `crossingInProgress` deferral | the crossing member | **none** |
| `:977-979` funding shortfall | the crossing member | (shortfall is non-zero) |

`driveToCascadeRefillPark` therefore requires the parked member to **BE the
transaction's entrant** and the receipt to carry **no `CycleOutFailed`** — which
separates `:523` from both root parks by construction rather than by luck, and from
`:936` because that one parks a root mid-crossing, never the entrant. ⚠ The helper
THROWS with a named message if it does not find the state inside its bound, rather
than returning nothing and letting the assertions pass vacuously.

## 20.3 ✅ THE :906 TRAP IS NOW A TEST, NOT A COMMENT — AND THE STALE TABLE HAD A SECOND COPY

19.18b warned that a fixture built against `:906` constructs a ghost, watches it
dequeue, and passes while proving nothing. **ER-2 pins that**: the same member, same
$5.00 reserve, given one partner seat, takes the GHOST branch — `GhostDequeued`
fires, `EvictionReserveReleased` does **not**, and the reserve is untouched. The
difference between the real test and the worthless one is one partner seat, so it is
held down by one partner seat.

⛔ **AND THE CORRECTION 19.18b MADE TO THE HANDOFF HAD NOT BEEN MADE TO THE SUITE.**
The same unreachability table lives inside `V8_48_GhostFloor.test.js`'s GF-V3
comment, and it still read *":906 … holds a reserve, not a ghost ← still reachable"*
and *"Only the last two survive"*. The handoff got a banner in session 19; the test
did not, and the test is what a session building a fixture actually opens. Corrected
in place, with a pointer to the new file. **A stale assertion does not live in only
one place just because you found it in one place — 19.18b's own standing lesson,
applied to the document 19.18b was written from.**

⚠ **ER-2 IS NOT GF-V1 REPEATED.** GF-V1's ghost reaches the queue via `softParkIdle`,
which releases the reserve on its way in (`:1447-1450`), so its "reserve unchanged"
assertion compares 0 against 0. ER-2's reserve is a real $5.00.

### 20.3a ⛔⛔ AND THE TABLE HAS ONE MORE PROBLEM: `:906` AND "THE MID-CASCADE DEFERRAL" ARE TWO DIFFERENT SITES

19.18b's row reads **`:906` mid-cascade deferral**. Those are not the same thing:

* **`:906` is the containment pre-check** in `_cycleOutRoot`'s MatA branch — it parks
  only inside `if (dest != 0 && dest.isActiveInMatrix(root))`. 19.18b's *reasoning*
  about that code is correct and stands: it is a ghost by construction, not a door.
* **The mid-cascade deferral is `:936`**, in `_crossToPartner`, guarded by
  `self.crossingInProgress` — a different function, a different condition, and
  crucially **no ghost test in it at all**. The member is parked while crossing, so
  they are seated in neither half and their reserve has not been spent yet. On its
  face that is a door.

**One row was carrying the name of one site and the analysis of another.** Every
session that read that row — including this one, until the line numbers were
re-checked — inherited both.

⚠ **WHETHER `:936` IS ACTUALLY REACHABLE IS NOT ESTABLISHED, AND THIS SESSION DOES
NOT CLAIM IT EITHER WAY.** Measured: a probe classifying every zero-shortfall park
across **45 registrations at `matrixSize` 7 saw `:936` fire ZERO times** while
correctly catching two `:523` parks in the same run — so the classifier is not blind,
but it has never seen a `:936` positive and by the standing rule its zero is not yet
worth much.

There is a structural reason to expect zero in THIS fixture, offered as an
explanation and **marked UNVERIFIED**: `:936` needs `_crossToPartner(MatA, ·)` while
MatA's own `crossingInProgress` is already true. The only cascade a one-pair,
one-tier fixture produces is MatA crossing → full MatB cycles out → re-entry into
MatA — and at that instant MatA has just freed a slot, so the re-entrant is seated
and no nested `_cycleOutRoot` runs. Firing `:936` needs MatA to be full DURING the
nested re-entry, which needs two members returning to MatA in one cascade or a second
pair routing back. **That is a hypothesis about why the count is zero, not a proof
that the count must be zero.** It goes on the open list (20.8 item 4), not into a
conclusion.

⛔ **SO: DO NOT WRITE "THERE IS EXACTLY ONE DOOR" ANYWHERE.** `:523` is a door and is
now exercised. `:906` is a ghost and is now pinned as one. `:936` is unclassified.

✅ **CLASSIFIED 2026-08-21 — SEE 26.0-26.3.** `:936` IS a door if it fires (parked root,
seated in neither half, reserve unspent, no ghost test in the branch). A one-pair world
cannot reach it and that is now an argument rather than a count; the two-pair route is real
but blocked by the wealth bound that caps cascade depth (0 doubles in 55 registrations).
**Unreached, not unreachable — and the rule above still stands.**

## 20.4 ✅ THIS ALSO CLOSES RISK 2 OF THE V8.50 PRIVATE DEPLOY GATE

The deploy gate lists four risks. Risk 2 is *"defect 9's code path has NO test
coverage — stated in the contract at `MatrixLogicLib:543`. No fixture builds a
cascade that refills every seat."* **That cascade IS this fixture.** One construction
retires 19.8 item 1 and deploy-gate risk 2 together. Risks 1, 3 and 4 are gas and
population questions and still need the private chain.

## 20.5 ⛔ A DOC DRIFT FOUND WHILE READING THE GATE — NOT FIXED, FLAGGED

The deploy-gate section still reads *"If (1) lands above 3.5M, `minGasPerItem` is
wrong and must move BEFORE the community deploy"*, and its table's "against" column
says `minGasPerItem = 3.5M`. **Source is `MatrixKeeper.sol:290 → 5_000_000`**, changed
by the owner decision of 2026-08-18 and recorded in this file two sections below the
stale text. The threshold sentence is measuring against a number that no longer
exists. Left as-is deliberately — it is the deploy gate's own text and whoever runs
the gate should re-read it — but **do not carry 3.5M into that run.**

## 20.6 ⚠ WHAT THIS SESSION DID NOT MEASURE — STATED SO NOBODY QUOTES IT WRONGLY

* **A UNIT TEST PROVES THE MECHANISM, NOT THE POPULATION** (19.18a's own caveat, and
  14.3 before it). ER-1 answers "if a MatA cascade-refill eviction happens, does the
  member get their reserve back" completely. It says **nothing** about how often that
  happens live, and 18.15's 0-in-1,803 still stands as the frequency.
* **`matrixSize` 7, not 127.** The cascade's SHAPE is what is pinned; no gas figure
  from this run is quotable and none is quoted.
* **NO GAS MEASUREMENT AT ALL.** The fixture caps every entry at Hardhat's 2^24 and
  was not built to price anything.

## 20.7 ⚠ THE BASIS FOR THE SUITE NUMBER, BECAUSE IT IS NOT THE OWNER'S MACHINE

**SUITE: 641 passing / 7 pending / 0 failing** (`suite_session20.txt`). Exactly
19.17d's 638 plus the three new tests, so nothing existing moved.

⚠ **RUN IN A LINUX CONTAINER ON `solcjs`, NOT ON THE OWNER'S NATIVE `solc`.** The
container's egress allows npm but not `binaries.soliditylang.org`, so the compiler
cache was seeded from the npm `solc@0.8.26` package and Hardhat fell through to its
WASM path. Same compiler version, same settings from `hardhat.config.js`. Bytecode
from solcjs and native solc of one version is identical, and the suite result landing
exactly on 638+3 is consistent with that — **but it is an inference, not a check.**
Nobody diffed the artifacts. **If a size figure is ever needed, run `scripts/sizes.js`
on the owner's machine; do not quote one from a container run.**

## 20.9 ⛔ TWO ENVIRONMENT TRAPS FOR ANY SESSION WORKING THROUGH THE DEVICE BRIDGE

Neither is a code finding; both cost real time and both will recur.

**(a) A COMMIT FROM THE DEVICE VM LEAVES A STALE `.git/HEAD.lock`, AND THE NEXT
COMMIT FAILS.** The VM cannot delete files, so git's own cleanup fails with
`unable to unlink '.git/HEAD.lock': Operation not permitted` — a WARNING, not an
error, so the commit itself SUCCEEDS and the failure surfaces one commit later as
`Unable to create '.git/HEAD.lock': File exists`. The same happens to
`.git/objects/*/tmp_obj_*`, which are harmless. **Fix: `mv` the lock aside — this
session put them in `.git/_stale_locks/` — and do not conclude the repo is wedged.**
Same family as every other "the device VM cannot delete" workaround already in
`.gitignore`.

**(b) THE SUITE CANNOT COMPILE IN A CLOUD CONTAINER WITHOUT SEEDING THE COMPILER.**
Egress allows npm but not `binaries.soliditylang.org`, so `hardhat compile` hangs and
then fails on the compiler download. Working recipe, in case it is wanted again:
`npm pack solc@0.8.26`, then write its `soljson.js` into
`~/.cache/hardhat-nodejs/compilers-v2/wasm/` with a hand-built `list.json` carrying
that file's keccak256, plus the same entry under `linux-amd64/` with a
`.does.not.work` marker so Hardhat falls through to the WASM path. **Read 20.7 before
quoting any number from such a run** — it is a different compiler backend from the
owner's.

## 20.8 NEXT, IN ORDER — SUPERSEDES 19.8. ⚠ ITEM 1 IS DONE.
⛔ **SUPERSEDED BY 21.7. ITEM 1 BELOW ("lengthen the A/B tail") IS REFUTED — READ 21.0
BEFORE ACTING ON THIS LIST.** The ordering note that item 1 must precede the clawback
sweep is void; 21.3 explains why.

1. **LENGTHEN THE A/B TAIL** until `stillParkedAtEnd` approaches zero, so the loan
   counts stop being censored (18.19). Cheap, and it makes 18.6 quotable. **Do this
   BEFORE item 2** — a preset sweep run on a censoring harness inherits the artefact.
2. **PRICE THE CLAWBACK PRESETS** on the cleaned harness (19.17b). Presets 0/1/3
   shipped with no evidence and are now one DAO vote from live; only preset 2 has any.
   One dial, three seeds — the shape that priced the base ceiling.
3. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
4. **CLASSIFY `:936`** (20.3a). Zero firings in 45 registrations at size 7, and a
   marked-UNVERIFIED reason to expect zero in a one-pair fixture. Either reach it —
   a two-pair or two-tier cascade where MatA is full during a nested re-entry — or
   establish that `crossingInProgress` cannot be true on a matrix entering its own
   `_cycleOutRoot`, which would close it by argument. **Cheap, and until it is done
   nobody may write "exactly one door".**
5. **THE PRIVATE V8.50 DEPLOY GATE** — risks 1, 3 and 4. Risk 2 is closed by 20.4.
   Read 20.5 before running it.
6. **POST-MIGRATION, NOT BEFORE:** GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the
   live histogram against 19.1, then arm at 3000. Then re-run `diag_referral_threshold.js`
   section 4 + the loan book against live V8.50 (19.6).
7. Backlog, untouched throughout: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js`
   v4 counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry;
   `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable re-entry. Plus the three
   orphan session-13 fragments 19.18c flagged, still untracked.

---

# ⬛ SESSION 19 STATE — 2026-08-21. READ AFTER SESSION 20.
# 18.21 ITEMS 1 AND 3 CLOSED — THE GATE IS IN THE TREE, INERT. PLUS THE ITEM-43 DAO SWEEP (19.17).

Measurement only. **Nothing deployed, no chain written to, no contract file touched.** One
script extended — `scripts/diag_referral_threshold.js` gains a section 4; tables 1-3 are
byte-for-byte the code that produced session 13's numbers and were not edited. Run once
against **live V8.48, blocks 45430468..45756873, every block range read cleanly**.

## 19.0 ⛔⛔ THE VERDICT: BASE CEILING STAYS AT 3000 bps. 18.18 IS CLOSED, NOT RE-OPENED.

18.18 named exactly one thing that could overturn the ceiling: *"the live `directCount`
distribution turning out so much thinner than the fixture's that $3.00 would refuse a large
share of real members rather than six per 288."* **It is thinner, but not so much thinner** —
and the way it is thinner is the argument FOR the gate rather than against it. Details below;
the decision does not move. What WOULD move it now is a different measurement entirely, and it
cannot be taken before V8.50 is live (19.6).

## 19.1 THE LIVE DISTRIBUTION — MEASURED, EXACT, AND THE FIRST TIME IT HAS BEEN COUNTED

406 registrations, 406 distinct members, **405 referrer edges** (everyone has a sponsor), 106
members with at least one direct. Zero edges point outside the member set, so nothing is being
silently dropped at the root.

| lifetime directs at head | ALL | organic | bigfill | leader |
|---|---|---|---|---|
| 0 | 300 | **87** | 212 | 1 |
| 1 | 37 | 36 | 0 | 1 |
| 2 | 19 | 19 | 0 | 0 |
| 3 | 3 | 3 | 0 | 0 |
| 4 | 26 | 5 | 0 | 21 |
| 5-9 | 13 | 5 | 0 | 8 |
| 10+ | 8 | 0 | 0 | 8 |
| **zero-direct share** | 73.9% | **56.1%** | 100.0% | 2.6% |

⚠ **ORGANIC IS THE ONLY COLUMN THIS DECISION RESTS ON.** bigfill is 212 scripts that have
sponsored nobody by construction — 14.6's standing reason its member-specific columns are not
facts about members. The leader column is the roster, and it is the mirror image (2.6% zero).

## 19.2 ⛔⛔ THE FINDING: THE POPULATION IS BARELY THINNER. THE BORROWERS ARE MUCH THINNER.

Two ratios, and they disagree — which is the whole result:

| | live organic | A/B fixture, pooled 3 seeds | ratio |
|---|---|---|---|
| zero-direct share of **MEMBERS** (lifetime) | 56.1% (87/155) | 49.7% (429/864) | **1.13x** |
| zero-direct share of **ADVANCES** (at that block) | **59.2% (183/309)** | 30.6% (26/85) | **1.94x** |

The fixture side is read off `ab_sequence_s{1,2,3}.json` by the script itself, not transcribed
— a regenerated sequence file cannot silently desynchronise the comparison.

**In the fixture, zero-direct members are UNDER-represented among borrowers (30.6% of advances
from 49.7% of members). On live they are OVER-represented (59.2% of advances from 56.1% of
members).** The gate's target population is not rarer on live; it borrows nearly twice as
often relative to its size.

⛔ **AND THAT IS THE CASE FOR THE GATE, NOT AGAINST IT.** Rule 1's "not at the expense of the
ecosystem" names precisely the member who has sponsored nobody and keeps drawing advances. The
live data says that member is more of the loan book than any fixture suggested, not less.

## 19.3 THE PROJECTION, AND EVERY BOUND ON IT

⚠ **PROJECTION, LABELLED AS ONE (7a rule 6). NOT A RUN.** Holding 18.4's V8.50 conditional
fixed — of 26 zero-sponsor advances, 14 exceeded $3.00, so P(refused | zero directs) = 53.8% —
and substituting the live zero-direct share of advances:

| | fixture, measured | live, projected |
|---|---|---|
| advances refused at base 3000 | 16.5% | **31.9%** |
| FLOOR refusals per 288 members per run | 6 | **~11.6** |

**Roughly double. Not an order of magnitude, and ~4% of members per run.** Three bounds sit on
top of it, all of them in the same direction:

* ⛔ **THE SHORTFALL HALF IS A FIXTURE QUANTITY AND CANNOT BE MEASURED ON THIS CHAIN.** There
  is no live V8.50 (18.10), and live V8.48 advance sizes are the wrong basis in BOTH directions
  at once — the crossing buffer inflates them (13.11) while V8.50 shortfalls are bigger again
  (18.3). The projection assumes live V8.50 shortfalls look like the fixture's.
* ✅ **THE ONE CROSS-CHECK AVAILABLE DOES NOT CONTRADICT IT.** On live V8.48, **85 of 183**
  zero-direct organic advances (**46.4%**) already exceed 3000 bps of the borrower's own tier
  fee — median 2,650 bps, max 8,600. Wrong build, so it confirms nothing; but 46.4% and 53.8%
  are the same neighbourhood, which is more than the projection was entitled to expect.
* ⛔ **EVERY REFUSAL FIGURE IS A NO-GRACE UPPER BOUND** (18.17). Live `evictionGracePeriod` is
  SEVEN DAYS. A refused member is PARKED, with the badge session 10 made visible, and inviting
  ONE person inside that week makes them eligible again. Nothing here models that, and the
  refused population is the one most able to act (18.16: they hold $5.58-$6.82 and owe $0.00).

## 19.4 ✅ THE STRONGEST PRO-GATE NUMBER OF THE WHOLE INVESTIGATION CAME OUT OF THE SAME RUN

Table 2, live organic, **directs the member ALREADY HELD at the block the advance was made** —
the figure a contract could enforce, with no lifetime hindsight in it:

| directs @ loan | loans | lent | members | fully repaid | still owing |
|---|---|---|---|---|---|
| 0 | **183** | $595.59 | 75 | **52.0%** | 36 |
| 1 | 83 | $269.64 | 30 | 60.0% | 12 |
| 2 | 33 | $108.55 | 17 | **94.1%** | 1 |
| 3 | 6 | $19.46 | 3 | 100.0% | 0 |
| 4 | 3 | $10.13 | 2 | 100.0% | 0 |
| 5+ | 1 | $1.53 | 1 | 100.0% | 0 |

**59% of organic advances go to the class that repays half the time.** The discriminator is
real and it is enforceable. ⚠ Selection, as ever: directs may mark an engaged member rather
than cause solvency. For a GATE that is sufficient — a filter only has to predict — and no
causal claim is made.

## 19.5 ⛔⛔ 13.11's "4.5x" DOES NOT REPRODUCE. THE CLEAN SIDE IS STABLE; THE OWING SIDE MOVED.

13.11 (2026-08-20) measured, among organic members who borrowed: **26 still owing, 3 (11.5%)
had sponsored anyone; 88 clean, 46 (52.3%)** — and concluded *"a member who has sponsored
someone is 4.5x more likely to have cleared their debt."* Derived from tonight's table 1, one
day later:

| | 13.11, 2026-08-20 | tonight, 2026-08-21 |
|---|---|---|
| clean borrowers | 88 | **75** |
| of those, had sponsored anyone | 46 = **52.3%** | 39 = **52.0%** |
| still owing | 26 | **49** |
| of those, had sponsored anyone | 3 = **11.5%** | 13 = **26.5%** |
| implied advantage | **4.5x** | **2.0x** |

**The clean side reproduced to a third of a percentage point across 36% population growth. The
owing side nearly tripled.** The arithmetic hangs together — borrowers 114 → 124, clean 88 →
75, owing 26 → 49: thirteen members who were clean took a new advance and are owing again, and
ten new borrowers all landed owing. Nothing is inconsistent; **the point estimate was just
never stable.**

> ⛔ **STANDING CORRECTION: DO NOT REQUOTE "4.5x". Quote the direction, not the multiple.**
> This is 7a rule 5 (one sample is not a measurement) catching a figure that had already been
> carried into three sections. The DIRECTION survives on a better instrument — 19.4's
> at-loan-time table, which has no hindsight in it and is not a single ratio — so nothing that
> was built on the direction falls. ⚠ WHY the owing side moved is NOT measured and is not
> guessed at here.

## 19.6 ⛔ WHAT WOULD MOVE 3000 bps NOW — AND IT IS NOT AVAILABLE YET

The directs question is answered and should not be re-asked. The only live quantity that could
still move the ceiling is **the V8.50 shortfall distribution with real members**, which needs
V8.50 LIVE and weeks of accrual (18.0's reasoning, unchanged). Two consequences:

* **THE CEILING SHIPS WITH A SETTER.** Already in 18.21 item 3's scope; this is the reason it
  is not optional. `baseAdvanceBps` must be a DAO/owner parameter so the number can be re-read
  against live V8.50 without a redeploy.
* **PUT THE RE-READ IN THE POST-MIGRATION LIST.** Re-run this script's section 4 plus the loan
  book a few weeks after migration; if live V8.50 zero-direct shortfalls cluster below $3.00
  the ceiling is loose and can come down, and if they cluster above it the gate is refusing
  more than 4% and the owner should see that number before it becomes routine.

## 19.7 ⚠ WHAT THIS SESSION DID NOT MEASURE — STATED SO NOBODY QUOTES IT WRONGLY

* **NO LIVE V8.50 ANYTHING.** There is no such chain. Every V8.50 figure quoted here is the
  A/B fixture's, and every one says so on its own line.
* **NO BEHAVIOURAL RESPONSE, ON EITHER SIDE.** Neither the fixture nor this chain contains a
  member who recruited *because* they were refused — the gate has never been live.
* **TIME-IN-SYSTEM IS NOT CONTROLLED.** Some of the 87 zero-direct organic members registered
  recently and have not had time to sponsor anyone. The zero-direct share is therefore an upper
  bound on the permanently-sponsorless population, not a measure of it.
* **THE LOAN-SIZE COLUMN IS THE WRONG BUILD** and is printed with that warning attached, twice.

## 19.8 NEXT, IN ORDER — SUPERSEDES 18.21. ⚠ ITEMS 1 AND 3 OF 18.21 ARE BOTH DONE.

1. **EXERCISE `EvictionReserveReleased` DELIBERATELY** (18.15) — **AS A HARDHAT UNIT TEST,
   NOT A DEPLOY (19.18a), AND AGAINST `:523`, WHICH IS THE ONLY SURVIVING DOOR (19.18b).**
   Every evicted member ever measured came from MatB with a zero reserve, so the release
   path has still never run. It is the last untested path in the eviction route the gate now
   feeds. ⛔ A test written against `:906` constructs a GHOST, watches it dequeue, and passes
   while proving nothing — read 19.18b first.
2. **LENGTHEN THE A/B TAIL** until `stillParkedAtEnd` approaches zero, so the loan counts
   stop being censored (18.19). Cheap, and it makes 18.6 quotable.
3. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
4. ~~The owner's question on a DAO parameter id.~~ **ANSWERED AND BUILT 2026-08-21 (19.17)**
   — five params added, three deliberately omitted. What remains is the MEASUREMENT: price
   the clawback presets on the A/B harness before anyone recommends moving off preset 2.
5. **POST-MIGRATION, NOT BEFORE:** run GO_LIVE_RUNBOOK PHASE 7b — pre-flight, check the live
   histogram against 19.1, then arm at 3000. Then re-run section 4 + the loan book against
   live V8.50 (19.6).
6. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic);
   `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff;
   @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable
   re-entry.

## 19.9 TOOL — `scripts/diag_referral_threshold.js` SECTION 4, read-only, additive

4A the live lifetime histogram by cohort · 4B directs at the moment of the advance · 4C the
fixture's tree read off `ab_sequence_s*.json` rather than transcribed · 4D the crossing, with
the live half and the fixture half labelled separately on every line. Guards: it ABORTS if no
member has any direct (the address-case fault that would look like the strongest possible
finding and would never throw — the loan book's `directsSanity` trap, 18.13), it reports how
many referrer edges point outside the member set, and it SKIPS the bps column rather than
guessing if `tierEntryFees` is unreadable. `AB_SEQ_FILES=` overrides the fixture file list.

## 19.10 ✅ THE GATE IS BUILT. 18.21 ITEM 3 IS DONE — CONTRACTS, TESTS, SUITE, RUNBOOK.

Still **nothing deployed and no chain written to.** What is in the tree on `v8.1`:

* **`TierRouter.directCount`** — `mapping(address => uint32) public`, incremented in
  `_bookkeepJoin` when the resolved referrer is non-zero. That is the ONLY write.
* **`StabilityFund.baseAdvanceBps`** (default **10_000**), `BaseAdvanceBpsSet`,
  `setBaseAdvanceBps` (`onlyOwnerOrGovernance`, capped at 10_000), the `directCount` entry
  added to `ITierRouterTierInfo`, and the gate itself inside **`loanHeadroom`** — 17.4's
  placement, unchanged, because that is the only place the ceiling arithmetic lives.
* **`test/V8_50_GateBase.test.js`** — 11 tests, all passing.
* **`test/V8_50_GateCost.test.js`** — UN-SKIPPED and rewritten (19.13).
* **`scripts/set_base_advance.js`** and **GO_LIVE_RUNBOOK PHASE 7b** (19.11).

## 19.11 ⛔⛔ TWO DESIGN CALLS THE SOURCE FORCED, NEITHER OF WHICH WAS IN 18.21 ITEM 3

**(a) `directCount` DOES NOT BACKFILL, SO THE GATE SHIPS INERT AT 10_000.**
These contracts carry no proxy machinery — no `Upgradeable`, no `initializer`, no `__gap`,
no `_authorizeUpgrade` in either file. **V8.50 is a FRESH DEPLOY**, `directCount` is a fresh
mapping, and `memberReferrer` is written in exactly one place that only a real registration
reaches. So on migration day **every member reads 0 directs, including a member who
sponsored twenty on V8.48**, until their downline re-registers on the new chain. A 3000
default would have refused them **for an empty counter rather than for a policy**, and
18.14 routes a refused rescue to eviction.

The fix costs no bytes: ship at 10_000 (inert), arm with the setter afterwards. That also
turns switching the gate on into a **measured event with a pre-flight** instead of a deploy
side-effect. `scripts/set_base_advance.js` is read-only unless `ARM=1`, and before it will
send anything it **rebuilds the expected `directCount` for every sponsor off-chain from the
`MemberRegistered` log, reads the on-chain mapping for each, and aborts on any
disagreement** — including the reverse check that non-sponsors read exactly 0 and that
`address(0)` holds none. Second instrument, same shape as the loan book reconciling against
`raw.loanVolume`. **A gate armed against a broken counter refuses real members silently,
which is the worst failure this system has available.** GO_LIVE_RUNBOOK **PHASE 7b** carries
the pre-flight, the arm, what to watch afterwards, and the one-call back-out.

**(b) THE READ SHORT-CIRCUITS AND FAILS OPEN.** `if (baseAdvanceBps < bps && tierRouter !=
address(0))` puts the dial check FIRST, so an inert gate never touches the router at all —
measured at exactly zero added gas (19.13, GATE-2). And the read sits in `try/catch`: if
the SF is ever wired to an older router with no `directCount`, the ordinary floor stays in
force. **`loanHeadroom` reverting would take a whole keeper batch with it** (the reason
IF-8 exists next door), so a gate that cannot read its counter must refuse nobody.

⚠ **BOTH CHANGES MEAN THE SHIPPED FORM IS NOT SESSION 17's FIXTURE**, which is why 19.13
re-measured rather than carrying 17.1 forward. `scripts/fixture_gate_apply.js` is now
SUPERSEDED and says so in its own header; it is kept because it is what 17.1, 18.4 and 18.6
were measured on.

## 19.12 ⛔ A STALE NOTE CORRECTED: ONE WRITE SITE, NOT TWO

`diag_referral_threshold.js` has said since session 13 that `memberReferrer` is assigned at
"TierRouter:762 register, :813 coupon path", and 13.11 and 16.5 both repeated it. **:813 is
a comment line.** V8.44's size diet funnelled BOTH join paths through `_bookkeepJoin`, so
there is exactly one assignment, and both callers (`_register` and `registerWithCoupon`)
revert on `globalJoined[msg.sender]` before reaching it. The counter therefore increments
**at most once per member and cannot double-count a re-entry** — checked in the source, and
pinned by GB-12. The single-anchor edit is complete, not a half-fix.

## 19.13 MEASURED THIS SESSION — SIZE, SUITE, GAS

**SIZE**, run with the gate in the tree: **TierRouter 24,046 / 530 spare**, StabilityFund
**15,513 / 9,063 spare**, EIP-170 limit 24,576. Identical headroom to 17.1's fixture on
TierRouter and 3 bytes tighter on the SF — the `try/catch` and short-circuit cost about
three bytes. ⚠ The gated figures were RUN; the "+136 / +450 versus no gate" deltas are
derived from 17.1's recorded baseline, which was NOT re-run today.

**SUITE: 629 passing / 8 pending / 0 failing.** Exactly session 17's 618 plus the 11 new
ones, so nothing existing moved. Transcript in `suite_session19.txt`. ⚠ The 618 baseline
was itself not re-verified in session 18; the arithmetic landing exactly is what makes it
trustworthy here.

**GAS — and it DISAGREES with 17.1, in the cheap direction.** The armed read costs
**5,634 cold / 1,134 warm**, against the fixture's 7,720 / 1,220.

| | fixture (17.1) | shipped (19) | gap |
|---|---|---|---|
| cold | 7,720 | **5,634** | 2,086 |
| warm | 1,220 | **1,134** | 86 |

A cold SLOAD is 2,100 and a warm one is 100. **Both gaps land within opcode noise of
exactly one SLOAD at the right temperature**, and there is a structural reason for exactly
one: the fixture put the `baseAdvanceBps` check INSIDE the router branch, so its plain arm
short-circuited on `tierRouter` and never loaded `baseAdvanceBps` — charging that SLOAD to
the delta. The shipped form loads it first in both arms, so it cancels.
⚠ **THAT READING IS AN INFERENCE FROM TWO ARITHMETIC AGREEMENTS, NOT A RUN — UNVERIFIED.**
Nobody re-applied session 17's ordering to confirm it. Two independent temperatures telling
the same single-SLOAD story is much stronger than one, and the decision does not depend on
it either way, but it must not be written up as measured.

✅ **AND THE ONE THAT PINS THE INERT DEFAULT: GATE-2 reads a delta of EXACTLY ZERO**, cold
and warm (12,884 / 2,373 on both arms). Shipping the gate switched off is free, not merely
cheap. That is the whole justification for PHASE 7b.

⛔ **DO NOT CARRY 18.5's +0.41% FORWARD AS "THE GATE'S COST".** It priced the fixture's
ALWAYS-READ form. The shipped form reads only when armed and not at all at the default, so
that figure is an upper bound on an armed run and simply does not describe an unarmed one.

## 19.14 TOOLS AND DOCS TOUCHED — all additive, none rebuilt

* `scripts/diag_referral_threshold.js` — section 4 (19.9).
* `scripts/set_base_advance.js` — NEW. Read-only pre-flight + reconciliation; `ARM=1` to send.
* `GO_LIVE_RUNBOOK.md` — NEW **PHASE 7b**, after bigfill, marked NOT on go-live day.
* `test_ab/world.js` — `AB_GATE_BPS`'s comment and error message rewritten: the guard still
  works (it tests for the setter, which now exists), but it pointed at a fixture that is
  gone. ⚠ It also now records that **an unswept replay measures the ungated world by
  DEFAULT rather than by ABSENCE** — say which one a result rests on.
* `scripts/fixture_gate_apply.js` — banner: SUPERSEDED, do not run, kept as the record of
  what 17.1/18.4/18.6 were measured on.

## 19.15 ⛔ ONE QUESTION THAT IS GENUINELY THE OWNER'S. ✅ ANSWERED 2026-08-21 — SEE 19.17.

`setBaseAdvanceBps` is `onlyOwnerOrGovernance`, so the owner can always move it. But
**`baseAdvanceBps` has no V8Governance parameter id**, which means the DAO cannot PROPOSE a
change to it the way it can for `insolvencyFloorBps` (param 59). Adding one is cheap —
V8Governance has 11,752 bytes of headroom — but whether the DAO should be able to vote on
the lending gate at all is a governance choice, not a technical one. **Not designed, not
promised. Ask before building.**

## 19.16 ✅ A TRAP THAT HAS COST SEVERAL SESSIONS IS NOW EXPLAINED, NOT JUST DESCRIBED

⛔ RESOLVED 2026-08-21 — THE MECHANISM OF THE LINE-ENDING TRAP IS `core.autocrlf`. Git said so out loud on the session-19 commit: `warning: in the working copy of '<file>', LF will be replaced by CRLF the next time Git touches it`, on all 11 files. The repo stores LF, the owner's working tree is CRLF, and Claude's bridge writes LF — so a file Claude has just written reads a different BYTE COUNT from one git considers clean, with a ZERO-LINE diff. **THE WARNING IS BENIGN AND WILL FIRE ON EVERY FILE CLAUDE WRITES THROUGH THE BRIDGE. It is not a finding and it needs no action.** The proof it does no harm is the commit's own stat line: 11 files, 1,350 insertions, 113 deletions — the size of the real changes, not a whole-file rewrite. STILL TRUE: never `git add -A`, and if a diff ever looks like whole-file churn, run `--ignore-all-space` and trust YOUR `git status`.

Every earlier note on this said WHAT happened and that it was measured; none said WHY. It is
not a bridge defect and it is not something to work around — it is one git setting behaving
exactly as configured, and the correct response to the warning is to ignore it.

## 19.17 ✅ THE ITEM-43 SWEEP — OWNER-CHANGEABLE NOW MEANS DAO-REACHABLE

**OWNER DECISION 2026-08-21:** *"anything owner can change should also be DAO governance
where possible."* That answers 19.15 and goes further than it asked. It is not a new policy
— it is an unfinished one. V8.48 fixed exactly this for `setCommunityOverflowBps` (param
60), and its comment named the defect class: a setter carrying an `onlyOwnerOrGovernance`
gate but **no param id**, so "DAO tunable" is owner-only in practice because governance has
no way to PROPOSE it. A sweep was run 2026-08-13 and clearly did not finish.

**THE SWEEP, RE-RUN PROPERLY: 55 gated setters, 47 with a governance path, 8 without.**

| id | setter | menu |
|---|---|---|
| **64** | `SF.setClawbackPreset` (new) | `0` off · `1` gentle · `2` current · `3` hard |
| **65** | `SF.setBaseAdvanceBps` | 1500, 2000, 2500, 3000, 3500, 4000, 5000, **10000 = inert** |
| **66** | `MK.setSelfFundedGracePeriod` | 0, 60, 300, 900, 1800, 3600 |
| **67** | `MK.setFrozenMatBTimeout` | 0, 300, 3600, 21600, 86400, 604800, 2592000 |
| **68** | `MK.setGhostEntryEnabled` | 0, 1 |

`PARAM_MAX_ID` moves 63 → 68.

⛔ **THREE ARE DELIBERATELY LEFT OUT, AND THE REASON IS IN THE SUITE (DP-7) NOT ONLY HERE.**
`setTierGateThreshold(uint8,uint256)` and `setTierWhaleGateActive(uint8,bool)` take TWO
arguments and a proposal carries one value — unreachable by construction, and the per-tier
whale gates already hold ids 52-57, which is the coverage that matters.
**`setUpkeepCaller(address,bool)` stays owner-only ON PURPOSE:** it is authorization, not
economics, and a compromised keeper key must be revocable in minutes rather than through a
vote plus a 48h timelock.

### 19.17a ✅ A SIDE EFFECT WORTH MORE THAN THE ITEM: THE GATE NOW HAS A DAO OFF-SWITCH

Param 65's menu includes **10000**, and `baseAdvanceBps >= insolvencyFloorBps` makes the
sponsorship gate inert. So **the DAO can switch the gate off with a single vote**, no
redeploy, no owner action. That did not exist when 19.10 shipped the gate. It also means
the arming step (PHASE 7b) and the disarming path are now symmetric: owner arms, DAO can
reverse.

### 19.17b ⛔ THE CLAWBACK PRESET — AND THE WARNING THAT SHIPS INSIDE IT

`setClawbackBands` takes a `uint256[4]`; a proposal carries one value. So the menu is a
PRESET id that expands inside the SF — the same shape
`MatrixKeeper.setSfRescueLadderPreset` already uses, for the same reason. Owner picked the
conservative menu:

```
0 = OFF      [     0,    0,    0,    0 ]   earnings never redirected; debt then retires
                                           only via the cycle-out sweep and upgrade fold
1 = GENTLE   [  6000, 5000, 4000, 3000 ]
2 = CURRENT  [  9000, 8000, 7000, 6000 ]   <- the declared default, always voteable back
3 = HARD     [ 10000, 9500, 9000, 8000 ]
```

⚠ **ITS EFFECT IS NOT MEASURED AND THE CODE SAYS SO.** 16.x measured that this clawback
collected **$0.00 inside a MatB occupancy** across the whole V8.48 deployment — it collects
in the MatA ledger, which is not the balance the forward hop is judged against — and
recorded that how fast debt retires and how much a member can withdraw were NOT measured.
**Preset 2 is the only entry with evidence behind it.** The A/B harness can price the
others exactly the way it priced the base ceiling (one dial, three seeds) and that should
happen before anyone RECOMMENDS a change. **A preset's presence on the menu is not evidence
it is safe**, and the declaration comment says that in the contract where a future session
will actually read it.

⛔ **NO PRESET ID IS STORED, ON PURPOSE.** `clawbackBpsByBand` is the single source of
truth. An id kept beside it would be two models of one rule, free to drift the moment
`setClawbackBands` is called directly — the same failure `loanHeadroom` already warns about
in that file. **DP-4 pins its absence**, in the style of the existing "the StabilityFund
still has no `activateLayer`" test.

### 19.17c ⛔ THE TEST THAT EARNS ITS KEEP IS DP-5, AND IT IS THE SECOND INSTRUMENT AGAIN

A governance menu and its target setter are two lists of the same thing, free to drift —
and when they drift **the failure is silent in the worst possible direction: a proposal
wins its vote, waits out the 48h timelock, and THEN reverts on execution.** So the menus
are not eyeballed against the setters. `test/V8_50_DaoParams.test.js` **feeds every value
of every new menu to the real setter on the real contract** and requires it to be accepted.
It also fails on an EMPTY menu, because a param nobody can propose is the item-43 defect
wearing a different hat. **7 passing**, and DP-5 was green on the first run that reached it.

⚠ The first run of this file failed all 7 in the FIXTURE — `MatrixKeeper` needs
`MatrixKeeperLib` linked and the fixture did not. Nothing about the contracts was exercised
by that run; do not read the first transcript as a contract finding.

### 19.17d SIZE AFTER THE SWEEP — run, not derived

| contract | deployed | spare | delta |
|---|---|---|---|
| StabilityFund | 16,119 | 8,457 | +606 (the preset) |
| V8Governance | 13,205 | 11,371 | +381 (five params) |
| TierRouter | 24,046 | 530 | untouched |

**The one contract with no room to spare was not touched by any of this.** MatrixKeeper
gained nothing — its three setters already existed; only their governance path is new.

**SUITE AFTER THE SWEEP: 638 passing / 7 pending / 0 failing** (`suite_session19c.txt`) —
631 plus these 7, so no existing governance test pinned the old `PARAM_MAX_ID`. ⚠ THREE
TRANSCRIPTS FROM ONE DAY AND NONE OF THEM IS DRIFT: 629/8/0 predates un-skipping GateCost,
631/7/0 predates the DAO params, 638/7/0 is the tree as committed. 18.1 applies to this
file's own outputs as much as to A/B results — check WHICH run before quoting a number.

## 19.18 ⛔⛔ TWO CORRECTIONS THAT WOULD HAVE COST THE NEXT SESSION A DAY

Both concern **19.8 item 1** — exercising `EvictionReserveReleased` — which is the very next
thing a session picks up. Both were found by reading the source after the owner pushed back
on the plan, and neither is in the record above.

### 19.18a ⛔ IT DOES NOT NEED A DEPLOY. IT IS A HARDHAT UNIT TEST.

18.15, 18.21 item 2 and 19.8 item 1 all say the release path *"needs a MatA eviction, which
the private V8.50 deploy can stage with `evictionGracePeriod` in minutes."* **That is
wrong.** `MatrixLogicLib.evictParked` releases the reserve under exactly three conditions
and no more: `parkedAt[member] > 0`, the member is NOT seated in this matrix or its partner,
and `crossingReserve > 0`. No chain, no keeper, no clock. Every session that said "deploy"
was reasoning from how the situation arises ORGANICALLY — which is rare — rather than from
what the function requires. **A test does not have to wait for the state to arise; it
constructs it.** That deletes a whole deploy cycle from the next session.

⚠ **AND THE LIMIT, WHICH IS 14.3 AGAIN.** A unit test proves the MECHANISM, not the
POPULATION. It answers "if a MatA eviction happens, does the member get their reserve back"
completely, and says nothing about how often that happens live. **That is the right trade
here**: if the path never fires nothing is lost, and if it does fire we would know it is
correct. The population question is not the safety question.

### 19.18b ⛔⛔ THE UNREACHABILITY TABLE IS WRONG ON `:906`. ONE DOOR SURVIVES, NOT TWO.

The owner's challenge was: *"MatA has no way to evict since the reserve always crosses them
to MatB."* He is right about the ordinary path — item A deleted the `:947` funding-shortfall
park, which the table already records. Checking the two the table claims survive:

* **`:906` mid-cascade deferral — IT IS A GHOST BY CONSTRUCTION.** It parks only inside
  `if (dest != address(0) && IFigureEightMatrixV8Cross(dest).isActiveInMatrix(root))` — the
  member is parked *because* they are already seated in the partner. That is **precisely the
  test `evictParked` runs first**, so it takes the GHOST branch, dequeues, and touches no
  balance. The table says "a ghost? no". **It is the same case as `:876`, one row above it.**
* **`:523` cascade-refill on entry — SURVIVES, and the ordering was checked not assumed.**
  The member is parked at line **527**; `_distributePayments` runs at line **539**, after the
  park, in the same transaction, and credits the 50% reserve at `:1143`. So they end parked
  in MatA, not seated anywhere, holding a reserve, not a ghost.

**CONSEQUENCE FOR WHOEVER BUILDS THE TEST: there is exactly ONE door and it is `:523`.**
The fixture has to reach "cascade refilled every seat" — matrix full, a cycle-out ran, and
the refill took every freed slot so there is nowhere to place the entrant. A test written
against `:906` will construct a ghost, watch it dequeue, and prove nothing; and because
`GhostDequeued` fires and no balance moves, **it would look like a passing test of the wrong
thing.** That is the expensive failure this correction exists to prevent.

⛔ **THE STANDING LESSON, AND IT IS THE OWNER'S RULE POINTED AT OUR OWN DOCUMENTS: A
MECHANISM TABLE IN A HANDOFF IS AN ASSERTION, NOT A MEASUREMENT.** The table at "NEW SCOPE
FINDING: `EvictionReserveReleased` IS NOW ALL BUT UNREACHABLE" was written from a source
walk and carried for several sessions without anyone re-reading the two rows it depended on.
A correction banner now sits on it. **When a table is what sends the next session to work,
re-walk it before you follow it.**

### 19.18c HOUSEKEEPING COMMITTED WITH THIS — small, but each one is a live trap

* **`.gitignore` was missing every instrument built since session 13.** `suite_*.txt`,
  `gas_size*.txt`, `ab_result_*.json` were ignored; `gate_*.txt`, `lb_*.txt`,
  `evict_ledger_*.txt`, `ab_rerun_*.txt`, `clawback_window*.txt`, `debt_sweep.txt`,
  `parked_experiment.txt` and the `*.bak_*` snapshots were not. **~40 untracked files made
  `git status` noisy enough to hide a genuinely new one** — and this session had two real new
  files in that list. Patterns added; the convention was already there, it just was not kept
  up.
* ⚠ **`handover_session13.md` and `archive/_session13_*.md` ARE ORPHAN FRAGMENTS.** Untracked,
  superseded, and named closely enough to a handoff to be opened as one. The entry point is
  and remains `V8_50_HANDOFF.md` (newest section first), then `V8_50_SCOPE.md`.

---

# ⬛ SESSION 18 STATE — 2026-08-20. READ AFTER SESSION 19.
# 17.7 ITEM 1 IS ANSWERED (NOT AS ASKED), AND THE OWNER'S GATE DECISION IS TAKEN — 18.14, 18.18.

Measurement only. **Nothing deployed, no chain written to.** The session-17 gate fixture was
applied, measured across a 15-run sweep, and reverted — `git status --short contracts/` is
empty **on the owner's machine**, which is the authoritative reading (17.6's bridge trap).
Two instruments added to the A/B harness, both additive, both kept: the LOAN BOOK in
`test_ab/replay.js` and the `AB_GATE_BPS` sweep dial in `test_ab/world.js`.

## 18.0 ⛔⛔ 17.7 ITEM 1 CANNOT BE RUN AS WRITTEN — AND IT DID NOT NEED TO BE

"RE-MEASURE 14.1 AND 16.2 ON THE PRIVATE V8.50 DEPLOY" contains a contradiction that three
sessions carried forward without noticing:

* **14.1's two CLEAN columns are the member-specific ones.** 14.6 measured that exactly
  those columns do NOT reproduce on a population of scripts — bigfill ends owing at 1.1%
  against organic's 20.2%, and bigfill self-rescuers clear the hop at 1.6% against organic's
  19.6%. Those are the columns 14.6 calls "worth spending".
* **A private deploy is `owner + bigfill only`** — section 1's table, and being off the
  frontend is *what makes it private*. So a private V8.50 deploy would re-measure 14.1 on
  scripts and return the bigfill answer, which is already known not to be a fact about
  members.

**Re-measuring 14.1 honestly requires V8.50 LIVE, with real members, weeks after migration.
It therefore cannot block the gate, and nothing should wait on it.** What the gate's ceiling
actually needed was a MECHANISM quantity — how much loan does V8.50 create for the same
arrivals — and the A/B harness has answered that since session 6: one recorded sequence,
two arms, three seeds. ⚠ Do not read this as "the private deploy is worthless": it is still
where eviction gets its end-to-end test (session 9's recipe) and where PARAM 59 gets
confirmed in force rather than in source. It is just not the instrument for 14.1.

## 18.1 ⛔ THE THREE SEEDS WERE NOT THREE SAMPLES OF ONE THING — CAUGHT BEFORE ANYTHING WAS QUOTED

`ab_result_*_s1.json` was re-run **2026-08-19 22:41Z** on the current `replay.js`. `s2` and
`s3` were from **2026-08-18 22:46Z**: an older instrument with no `lending` block, no
park-event split, and — the one that matters — **no `insolvencyFloorBps` recorded at all**,
written before the PARAM 59 = 5000 commit. Pooling them mixed two configurations, and the
parameter that differed was the one the files did not record.

Re-run on the current tree. **The v849b arm did not move on a single economic figure**
(loans 84/85, loanUSD 96.23/108.19, evictions 1/0, all identical); park EVENTS moved 131→140
and 133→142, which is session 7's `MemberParked` disambiguation counting, not behaviour.
**Every change was in the v850 arm**, and it was large:

| stale Aug-18 → current | parks | loans | evictions | loan $ |
|---|---|---|---|---|
| v850 s2 | 128 → **88** | 21 → **26** | **11 → 3** | 36.01 → **47.35** |
| v850 s3 | 128 → **85** | 22 → **28** | **10 → 5** | 45.06 → **63.36** |

> ⛔ **THE STANDING LESSON: A RESULT FILE IS NOT A RESULT.** It is a result *as of* an
> instrument version and a dial set. A file that does not record the dial that changed
> cannot be pooled with one that does — and the pooled table computed before this was caught
> reported "evictions +1150%", against the true +500%. Session 8 already learned the
> filename version of this ("every dial that changes the answer goes in the filename"); this
> is the same rule pointed at files that are already on disk. **Check the mtimes and the
> recorded dials of every result file before pooling it with a fresh one.**

The stale files are kept as `ab_result_*_s{2,3}.stale_aug18.json`. Do not quote them.

## 18.2 THE V8.50 NUMBERS — THREE VALID SEEDS, IDENTICAL SEQUENCES, `AB_CAP=5`, MATRIX_SIZE 127

| pooled, 3 seeds | v849b (floor 3400, buffer on) | v850 (floor 5000, buffer 0) | |
|---|---|---|---|
| loans | 255 | **85** | **−66.7%** |
| loan dollars | $311.33 | **$168.86** | **−45.8%** |
| park events | 424 | 259 | −38.9% |
| rescues | 258 | 154 | −40.3% |
| rescues costing the fund NOTHING | 3 | **69** (45% of rescues) | |
| evictions | 2 | **12** | |
| SF balance at end, mean | $19.49 | **$83.21** | |

**17.7 item 1's premise is confirmed on the half that was about volume**: V8.50 cuts the loan
book by two-thirds in count and by nearly half in dollars, and the fund ends four times
healthier. Three seeds, same direction every time.

## 18.3 ⛔⛔ BUT V8.50 LOANS ARE **BIGGER**, NOT SMALLER — AND THAT HALF OF THE PREMISE IS WRONG

17.7 item 1 says "less debt means less collection and **the whole table shrinks**". The table
shrinks in COUNT. Each surviving loan grows:

| | v849b | v850 |
|---|---|---|
| median loan | $1.27 | **$1.77** |
| mean loan | $1.22 | **$1.99** |
| largest loan | $2.26 (2,263 bps) | **$4.42 (4,421 bps)** |
| share of loans to members with NO sponsor | 119/255 = 46.7% | **26/85 = 30.6%** |

V8.50 does not make loans smaller. **It deletes the small buffer-manufactured ones and leaves
the genuinely-short members borrowing nearly twice as much each** — which is what item A
means: the reserve now covers the crossing outright for members who can be covered, so the
loans that remain are the real shortfalls.

⚠ **AND THE FLOOR IS NOW MUCH CLOSER TO BINDING THAN IT WAS.** On v849b the largest loan was
2,263 bps against a 3,400 ceiling — 1,137 bps of slack. On v850 it is 4,421 against 5,000 —
**579 bps.** PARAM 59 = 5000 is settled policy (17.0) and this does not re-open it, but a
later session cutting the floor should know the headroom is roughly half what it was.

## 18.4 THE BASE-CEILING CURVE — AND A FRAMING CORRECTION THAT MATTERS

⛔ **THE GATE ONLY LOWERS THE CEILING FOR MEMBERS WITH ZERO DIRECTS.** A loan to a member who
already has a sponsor is untouched at any base. So "how many of all loans fit under X" is NOT
a policy reading and must not be quoted as one — the only predictive column is the
zero-sponsor one. (This was mis-framed once inside this session and corrected before it
reached the handoff; it is written down because the wrong column is the intuitive one.)

`loanBook.fitsUnderBase`, pooled 3 seeds, V8.50, 85 loans of which 26 to zero-sponsor members:

| base | = at T1 | loans small enough to fit at all | **zero-sponsor loans refused** |
|---|---|---|---|
| 1500 bps | $1.50 | 31/85 | **26 of 26 — all of them** |
| 2000 | $2.00 | 43/85 | 22 of 26 |
| 2500 | $2.50 | 57/85 | 18 of 26 |
| 3000 | $3.00 | 66/85 | 14 of 26 |
| 3500 | $3.50 | 76/85 | 7 of 26 |
| 4000 | $4.00 | 82/85 | 1 of 26 |
| 5000 | $5.00 | 85/85 | 0 — gate inert |

**THIS EXPLAINS 17.2 RATHER THAN REPEATING IT.** Session 17's fixture used 1,500 bps and bound
so hard the run was uninterpretable. That was not bad luck: **1,500 bps refuses literally
every zero-sponsor borrower on the V8.50 distribution.** Any real policy lives between about
2,500 and 3,500; below that the gate refuses nearly everyone, at 4,000 it does nothing.

⛔ **AND THE SAME CURVE ON v849b IS THE ARGUMENT FOR WHY ITEM 1's INSTINCT WAS RIGHT.** On the
old build a base of **2,500 bps grants 100% of loans** — the gate would have been an ornament.
Sizing the ceiling on V8.48 numbers, which 13.11 and 16.5 were implicitly doing, would have
shipped a gate that does nothing at all. **The method in item 1 was wrong; the instinct behind
it was correct and this is the measurement that shows it.**

## 18.5 ⛔ THE CONTROL HELD — THE FIXTURE IS ECONOMICALLY INERT, MEASURED NOT ASSUMED

17.2's rule applied before the sweep: fixture applied, `AB_GATE_BPS=10000` (present, cannot
bind), all three seeds. **Every economic quantity came back identical to the ungated run** —
loans, parks, rescues, evictions, loan volume, final SF balance, per-member histograms.

The only thing that moved is total gas:

| seed | ungated | gate present, inert | delta |
|---|---|---|---|
| 1 | 1,047,458,608 | 1,051,767,276 | **+4,308,668 (+0.411%)** |
| 2 | 1,050,993,684 | 1,055,201,064 | +4,207,380 (+0.400%) |
| 3 | 1,060,177,280 | 1,064,235,044 | +4,057,764 (+0.383%) |

**That is a THIRD independent reading of the gate's cost and it agrees with 17.1's 7,720 cold
/ 1,220 warm** — and unlike session 17's end-to-end arm, **this one is at MATRIX_SIZE 127**,
which is the arm 17.4 recorded as not run. ⚠ It is whole-run gas over 69 keeper ticks plus
289 registrations, NOT a per-item figure, so it does not replace 17.4's item — it bounds it.
Nobody should quote a per-item 127 number from this.

## 18.6 ⛔⛔ THE SWEEP — THE GATE WORKS, AND HERE IS WHAT IT COSTS

Same bytecode in every row; only `baseAdvanceBps` differs. Pooled 3 seeds, 288 members each.

| base | loans | of those, to zero-sponsor members | evictions | still parked at end | SF at end |
|---|---|---|---|---|---|
| inert | 85 | 26 | **12** | 93 | $249.63 |
| 3500 ($3.50) | 78 | 16 | **24** | 81 | $265.72 |
| 3000 ($3.00) | 72 | 5 | **30** | 75 | $278.33 |
| 2500 ($2.50) | 67 | 1 | **34** | 71 | $286.01 |
| 2000 ($2.00) | 66 | 0 | **35** | 70 | $287.77 |

Monotone on every seed individually (seed 1 4→7→9→9→9 evictions, seed 2 3→9→10→12→13, seed 3
5→8→11→13→13). The gate does what it was designed to do and the fund ends stronger.

✅ **AND ONE GENUINELY ENCOURAGING MECHANISM READING: LENDING SHIFTS TOWARD SPONSORS RATHER
THAN JUST SHRINKING.** At base 3000 loans to zero-sponsor members fall 26 → 5, but loans to
members with a sponsor RISE 59 → 67. Members refused early borrow later, once a direct has
arrived beneath them. ⚠ That is TIMING, not persuasion: the referral tree is fixed by the
sequence file, so nobody in this world recruits *because* they were refused. A live member
might, which would make the real effect larger — but that is a hypothesis and it is marked as
one.

## 18.7 ⛔⛔ THE COST IS NOT THE ONE THE OWNER'S RULE INTENDED — THIS IS THE SESSION'S FINDING

The owner's design, recorded in `replay.js`'s own note on 2026-08-19: *"one or two loans, then
eviction if no invites."* **That is not what the gate produces.** Loans received BEFORE
eviction, pooled:

| base | members evicted | **never lent to at all** | evicted after borrowing |
|---|---|---|---|
| inert | 12 | 9 (75%) | 3 |
| 3500 | 24 | 20 (83%) | 4 |
| 3000 | 30 | **27 (90%)** | 3 |
| 2500 | 34 | 31 (91%) | 3 |
| 2000 | 35 | 32 (91%) | 3 |

**The count evicted AFTER borrowing is flat at 3–4 in every row. The entire increase is
members who were refused and then removed without ever having been lent to.** The gate does
not implement "one or two loans, then eviction". It implements "refused, then eviction".

## 18.8 ⛔⛔ WHY — AND IT CORRECTS 13.11's DESIGN SKETCH, WHICH 16.5 AND 17 BOTH CARRIED

13.11's shape was: *"a member who has sponsored nobody gets a small first advance; the rest of
the ceiling unlocks when they sponsor one person."* **A ceiling on `loanHeadroom` cannot
produce that, and the reason is structural:**

* The advance size is set by the MEMBER'S SHORTFALL, not by the ceiling — the keeper computes
  `sfShare` from what the crossing costs minus what the member has.
* `loanEligibleFor(member, tier, advance)` is a **boolean on the WHOLE advance**. There is no
  partial-funding path. A member whose shortfall exceeds the base does not receive the base;
  they receive nothing.
* A refused rescue is already routed to eviction by `_triageParked` (reason 4).
* And 18.3 is what makes it bite: **V8.50 shortfalls are BIGGER than V8.48's**, so most
  zero-sponsor members need more than any base worth setting.

**"A small first advance" and "a lower ceiling" are different mechanisms, and only the
measurement separated them.** Nothing in 13.11, 16.5 or 17 was wrong about where the gate
goes or what it costs — 17.4's placement finding stands — but the POLICY SHAPE all three
described is not the policy shape the fixture implements.

## 18.9 THE TWO INSTRUMENTS, AND WHERE THEY MEET

**BUILD THE SECOND INSTRUMENT — fourth session running, fourth time it paid.** The loan book's
counterfactual is arithmetic on a recorded run; the sweep replays with the gate installed and
lets the population move. They are independent and they agree:

| base | loan book predicts refused | sweep actually loses | gap |
|---|---|---|---|
| 3500 | 7 | **7** | 0 |
| 3000 | 14 | **13** | −1 |
| 2500 | 18 | **18** | 0 |
| 2000 | 22 | **19** | −3 |

The gaps are in the expected direction and grow with the tightness of the gate, which is the
population moving — a refused member's later history changes, so a few loans the static count
expected to refuse never get requested. **Agreement this close is what licenses quoting the
counterfactual table in 18.4 at all.**

## 18.10 ⚠ WHAT THIS SESSION DID NOT MEASURE — STATED SO NOBODY QUOTES IT WRONGLY

* **THE REFERRAL DISTRIBUTION IS THE FIXTURE'S, NOT THE LIVE CHAIN'S.** `gen_sequence.js`
  builds a real tree (every member picks a referrer already registered) — which is strictly
  better than session 17's KeeperGas star, where everyone referred to W1 and the gate refused
  essentially everybody. It is still not live. 13.11 measured the live shape (11.5% of members
  still owing had sponsored anyone; 52.3% of those who cleared) and a session that wants the
  live bite should cross the live directCount distribution with 18.4's curve.
* **NO BEHAVIOURAL RESPONSE.** Nobody in this world recruits because they were refused.
* **WHAT AN EVICTED MEMBER KEEPS WAS NOT MEASURED HERE.** The design intent (session 9's
  recipe, step 4) is that eviction preserves withdrawable, RELEASES the crossing reserve, and
  leaves the debt booked — removal, not confiscation. **Asserted from the recipe, not run.**
  It should be, before eviction volume triples.
* **NOTHING ON LIVE V8.50** — there is no such chain.
* **NO PER-ITEM GAS AT 127** — see 18.5's warning.

## 18.11 ⛔ THE OWNER'S DECISION, RESTATED AND SHARPENED. ⚠ ANSWERED — READ 18.14 AND 18.18 FIRST.
> **TAKEN 2026-08-20: YES, A REFUSED LOAN ROUTES TO EVICTION, AND THE CAP IS 3000 bps.** The
> reasoning below is kept because it is what the decision was taken against, not because
> anything here is still open.

17.5 asked two things: what base ceiling, and whether a refused loan should route to eviction
at all. **18.7 and 18.8 make the second one primary.** The base ceiling is a free choice only
if refusal→eviction is acceptable:

* **IF refusal→eviction is acceptable:** a base of **3000 bps ($3.00 at T1)** is the coherent
  point — it holds 72 of 85 loans, cuts zero-sponsor lending from 26 to 5, and costs roughly
  **six extra evictions per 288 members per run**, of which about nine in ten are members who
  never borrowed.
* **IF it is not:** the gate needs a shape nobody has scoped — the fund topping a member up to
  the base and leaving them PARKED rather than removing them. That is a contract change to the
  funding path, not a dial, and it must not be designed before the owner takes this decision.

**DO NOT DESIGN EITHER BRANCH BEFORE HE ANSWERS.** Everything measurable has been measured.

## 18.12 NEXT, IN ORDER   ⚠ ITEM 1 IS DONE — SEE 18.14. RENUMBERED IN 18.21.

1. ~~**THE OWNER'S CALL IN 18.11.**~~ **TAKEN 2026-08-20 (18.14).**
2. **CROSS 18.4's CURVE WITH THE LIVE `directCount` DISTRIBUTION.** Read every
   `memberReferrer` assignment off live V8.48, build the real directCount histogram, and apply
   18.4's zero-sponsor refusal column to it. That converts a fixture result into a live
   estimate and costs one read-only script. **This is the cheapest remaining thing worth doing
   and it does not need the owner's decision first.**
3. **MEASURE WHAT AN EVICTED MEMBER KEEPS** (18.10). Before any gate ships.
4. **SPLIT 14.1 BY TIER** and cap time-at-risk — 14.4's one real imbalance, still untouched
   since session 14. ⚠ Note it is a V8.48 measurement and 18.0 applies: it describes the old
   build.
5. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic);
   `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff;
   @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable
   re-entry.

## 18.13 TOOLS BUILT — both additive, both in `test_ab/`, neither changes an existing number

* **THE LOAN BOOK — `test_ab/replay.js`, always on, no extra chain read.** Every
  `RescueLoanIssued` with its amount, its size in **bps of the ENTRY FEE** (the basis
  `loanHeadroom` uses — the crossing cost is what the keeper SIZES against, the fee is what the
  fund MEASURES against, and recording dollars alone would force a later session to guess),
  and the borrower's `directCount` **at that moment**, derived from the sequence file's
  referral tree rather than a chain read. Plus `fitsUnderBase` and `directsSanity`.
  **It reconciles against `raw.loanVolume`, which is summed a different way; a disagreement
  voids both and says so.** `directsSanity` exists because a single address-case mismatch would
  make every `directsAtLoan` read 0 — which looks exactly like the strongest possible finding
  and would never throw.
* **`AB_GATE_BPS` — `test_ab/world.js`.** Sets `baseAdvanceBps` on the fixture's SF so ONE
  compile serves a whole sweep and every row is identical bytecode. ⛔ **Deliberately NOT
  wrapped in `optional()`**: if the fixture is not applied it ABORTS, because a run that
  continued would emit a row reading "the gate changed nothing", which is indistinguishable
  from a real null result. The value is read back off the contract, and the FILENAME tag comes
  from the contract too — never from the env var.
* **VERIFIED BEFORE USE:** all six baseline files were re-run after the loan-book edit and
  came back identical apart from the new block (seed 1 also gained a documentation string
  added to `replay.js` after its previous run; no measured quantity moved on any of the six).

## 18.14 ⛔⛔ THE OWNER'S DECISION, TAKEN 2026-08-20 — YES, A REFUSED LOAN ROUTES TO EVICTION

Verbatim: *"The answer is yes, we are giving some passive earnings and one needs to help
themselves in order to earn so invite, self rescue or get evicted."*

**18.11 IS CLOSED, AND SO IS 17.5.** The three-way is his frame and it is now the design:
**invite, self-rescue, or be evicted.** The "some passive earnings" half is what makes a
NON-ZERO base ceiling part of the decision rather than an optional softening — a member with
no sponsor still gets help, capped. Later sessions build on this without re-asking.

## 18.15 ✅ EVICTION IS REMOVAL, NOT CONFISCATION — MEASURED FOR THE FIRST TIME

Eviction has fired **0 times in 1,803 live episodes** (14.3), so what the valve actually does
to a member was known ONLY from session 9's recipe. That is now a measurement. Four A/B runs
(seed 1 inert + seeds 1/2/3 at base 3000), **34 evicted members**:

| | |
|---|---|
| kept their withdrawable in full | **34 of 34** |
| lost any withdrawable | **0** |
| still owed their advance afterwards | 4 of 4 who had borrowed |
| left holding a non-zero crossing reserve | 0 |

Withdrawable medians before → after: $0.25 → $0.25, $6.32 → $6.32, $6.04 → $6.04, $5.58 →
$5.58. **The recipe was right.**

⚠ **ONE PART IS STILL UNTESTED AND MUST NOT BE READ AS CONFIRMED.**
`EvictionReserveReleased` fired **0 times across all 34**. That is not a failure: every
evicted member came from **MatB, where `reserveZeroShare` is 1.00** — there was no reserve to
release. The release path has still never executed. This is consistent with the standing note
that `EvictionReserveReleased` is "all but unreachable", and it should be exercised
deliberately on the private V8.50 deploy before anyone relies on it.

## 18.16 ⛔⛔ WHO THE GATE ACTUALLY REFUSES — AND IT IS THE SAME SIX PEOPLE EVERY SEED

The evictions at base 3000 split into two kinds, and the split is identical on all three
seeds (**LADDER 4/4/5, FLOOR 6/6/6**):

* **13 LADDER evictions.** Members holding **$0.25** (one at $1.20) — `wBps` 250, i.e. 2.5%
  of the crossing price. Refused by the RESCUE LADDER, not by the gate, and they are evicted
  in the inert arm too. **Nothing to do with the base ceiling.** These are the members who
  genuinely cannot act.
* **18 FLOOR evictions.** These exist ONLY because the cap bound. Every single one:

| | |
|---|---|
| own money held | **$5.58 – $6.82** (median $6.43) |
| advance needed | **$3.18 – $4.42** |
| amount owed to the fund | **$0.00 — all eighteen** |

**They are near-misses, and they are the most engaged members who have not invited anyone.**
Sorted, the eighteen advances are $3.18, 3.25, 3.26, 3.29, 3.33, 3.46, 3.46, 3.49, 3.57,
3.60, 3.64, 3.64, 3.67, 3.68, 3.68, 3.89, 3.96, 4.42 — so the cap's placement relative to
that cluster is the whole decision:

| cap | of the 18, granted |
|---|---|
| $3.00 | **0** |
| $3.50 | 8 |
| $3.75 | 15 |
| $4.00 | **17** |
| $4.50 | 18 |

**There is no gentle setting.** Below ~$3.70 the gate refuses the cluster; at $4.00 it grants
all but one and stops asking anything.

## 18.17 ⛔⛔ THE CAVEAT THAT CHANGES THE HUMANE READING — THE A/B WORLD HAS NO GRACE PERIOD

`test_ab/world.js:116–118` sets **`parkedGracePeriod`, `selfFundedGracePeriod` AND
`evictionGracePeriod` all to 0**, on both arms, so that a timing difference between builds
cannot masquerade as an economic one. That is correct for the A/B — and it means **every
eviction in this sweep fires the instant the member is refused.**

**On live, `evictionGracePeriod` is SEVEN DAYS** (DAO param 62; 14.3 measured the soonest
clock of any parked member at 5.41 days). A refused member on live is PARKED for a week —
with the badge session 10 made visible — during which inviting one person makes them eligible
again. **Every eviction figure in 18.6, 18.7 and 18.16 is therefore a NO-GRACE UPPER BOUND**,
and the population it bounds is precisely the one most able to act inside the window.

> ⛔ **STANDING RULE THIS ADDS: THE A/B WORLD ZEROES THE CLOCKS.** Any A/B result about
> eviction VOLUME or TIMING is an upper bound and must say so. Results about who is eligible,
> what a rescue costs, or what a member keeps are unaffected. Nobody should quote an A/B
> eviction count as a live prediction.

## 18.18 ⛔ THE DECISION TAKEN, AND WHAT WOULD CHANGE IT

**BASE CEILING = 3000 bps ($3.00 at T1).** Claude's call under the owner's standing rule that
Claude decides approach and the owner decides economics — and it follows from his own words:

* The members it refuses have already accumulated two-thirds of the crossing price and owe
  nothing. They are the most engaged non-inviters, they keep every cent (18.15), and on live
  they get seven days in which inviting ONE person makes them eligible (18.17). That is
  exactly what "help themselves … invite" asks of them.
* The members it does NOT touch are the $0.25 LADDER cases, who cannot act either way.
* At $4.00 the gate grants 17 of the 18 and asks nothing. **"Help yourself" and "grants 17 of
  18" do not sit together.**

⚠ **WHAT WOULD OVERTURN IT:** the owner preferring the gate to be a backstop that almost
never fires (then $4.00, one dial, no redesign); or the live `directCount` distribution
(18.12 item 2) turning out so much thinner than the fixture's that $3.00 would refuse a large
share of real members rather than six per 288. **That measurement is still the cheapest
outstanding item and it does not need any further decision.**

## 18.19 ⚠ A CENSORING ARTEFACT FOUND WHILE CHECKING A DISAGREEMENT — READ BEFORE QUOTING 18.6

The loan book predicted 3 zero-sponsor loans would survive a $3.00 cap on seed 1; the replay
granted 0. **The disagreement was chased rather than explained, and it was not the gate.**
Those three were rescued at **ticks 68 and 69 — the last two ticks of a 69-tick run** — in the
inert arm. In the gated arm the queue evolved differently and they were never reached before
the replay stopped. They appear as **zero work items**, not as refusals.

**CONSEQUENCE: the sequence's 12-tick tail does not drain the queue** (26–31 members still
parked at the end on both arms), so late rescues are censored in BOTH arms. Part of "loans
fall 85 → 72" in 18.6 is truncation, not refusal. **The eviction counts are much less
affected — they fire at ticks 53–65 — which is why 18.16 is the trustworthy half of the
sweep.** A future session that needs the loan counts clean should lengthen the tail until
`stillParkedAtEnd` approaches zero, and re-run.

## 18.20 TOOL ADDED — THE EVICTION LEDGER, `test_ab/replay.js`, rides on `AB_CENSUS`/`AB_EVICT`

One row per `ParkedMemberEvicted`: withdrawable BEFORE (from the pre-tick snapshot — reading
it after the tick would describe the outcome and could be written up as the cause), and
withdrawable, crossing reserve and SF debt AFTER. The matrix is taken from the EVENT, never
from the snapshot: a member missing from the snapshot would otherwise be guessed into MatA and
every balance read off the wrong contract, silently, as zeros. Summary counts rather than
means, so a single bad row cannot hide, and the console shouts in capitals if
`lostWithdrawable` is ever non-zero.

---

## 18.21 NEXT, IN ORDER — SUPERSEDES 18.12

1. **CROSS 18.16's REFUSAL CLUSTER WITH THE LIVE `directCount` DISTRIBUTION.** The only thing
   that could overturn the 3000 bps decision (18.18). Read every `memberReferrer` assignment
   off live V8.48, build the real directCount histogram, and ask what share of live members
   would sit in the refused class. One read-only script; `scripts/diag_referral_threshold.js`
   already computes `directsAt(member, block)` and is the place to add it rather than a new
   tool. **Needs no further decision from the owner.**
2. **EXERCISE `EvictionReserveReleased` DELIBERATELY** (18.15). Every evicted member so far
   came from MatB with a zero reserve, so the release path has still never run. It needs a
   MatA eviction, which the private V8.50 deploy can stage with `evictionGracePeriod` in
   minutes (session 9's recipe).
3. **BUILD THE GATE FOR REAL.** Size, gas, placement, ceiling and eviction cost are all now
   measured; 18.8's correction means the shipped design is a CEILING and is honest about it,
   not "a small first advance". Promote `fixture_gate_apply.js`'s five edits into the tree,
   with `baseAdvanceBps = 3000` and its setter, plus tests.
4. **LENGTHEN THE A/B TAIL** until `stillParkedAtEnd` approaches zero, so the loan counts stop
   being censored (18.19). Cheap, and it makes 18.6 quotable.
5. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4). ⚠ V8.48 measurement; 18.0 applies.
6. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic);
   `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff;
   @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source; member-callable
   re-entry.

---

# ⬛ SESSION 17 STATE — 2026-08-20. READ AFTER SESSION 18. 16.6 ITEM 1 IS CLOSED.

Measurement only. **Nothing deployed, no chain written to.** Contract files were edited as a
FIXTURE, measured, and reverted — `git diff contracts/` is empty for both. Two new
instruments, both kept: `scripts/fixture_gate_apply.js` and `test/V8_50_GateCost.test.js`
(skipped in the suite on purpose — see 17.8).

## 17.0 ⛔ THE OWNER'S DECISION: 16.5 STANDS, ALL FIVE. IT IS NO LONGER A RECOMMENDATION.

Asked once at the top of the session, accepted as presented, 2026-08-20. **Keep lending;
price it at 20.2% vs 10.0%; PARAM 59 stays at 5000; do NOT cut the floor to 40% or 20%; do
NOT touch `setClawbackBands` for this purpose; the exit is sponsorship.** Later sessions may
build on all six points without re-asking. What is still open is the BUILD, not the policy.

## 17.1 ⛔⛔ THE ANSWER TO 16.6 ITEM 1: THE GATE FITS. SIZE AND GAS ARE NOT THE OBSTACLE.

The blocking item since 13.11 has been "`directCount` needs a router read at a call already
near the block gas ceiling — measure before promising". **Measured. It is not close.**

### SIZE — deployed bytecode, baseline vs fixture, EIP-170 limit 24,576

| contract | baseline | fixture | delta | headroom after |
|---|---|---|---|---|
| **TierRouter** | 23,910 | 24,046 | **+136** | **530** |
| **StabilityFund** | 15,063 | 15,510 | **+447** | 9,066 |
| MatrixPairFactory | 24,498 | 24,498 | **0** | 78 |
| MatrixLogicLib | 24,281 | 24,281 | **0** | 295 |
| FigureEightMatrixV8 | 14,230 | 14,230 | **0** | 10,346 |

**+583 bytes total and the two contracts with almost no room left did not move a byte.** That
was predicted before the run and it held: the matrix and the library are not touched, so the
factory — which embeds the matrix's CREATION code and has 78 bytes — cannot inflate. The
whole size cost lands on TierRouter (the mapping and one increment) and on the SF, which has
9k spare. ⚠ The SF's +447 includes a placeholder `baseAdvanceBps` param, its setter and its
event; a shipped design keeps roughly that much.

### GAS — the added read, measured alone, in gas units (`test/V8_50_GateCost.test.js`)

| arm | cold | warm |
|---|---|---|
| ungated (`tierRouter` unset — branch short-circuits) | 12,902 | 2,391 |
| gated, member with **0** directs | 20,622 | 3,611 |
| gated, member with **1** direct | 18,497 | 3,486 |
| **ADDED PER `loanHeadroom` CALL** | **7,720** | **1,220** |

The reading decomposes exactly against the EVM's own schedule, which is itself a validity
check nobody had to trust me for: 7,720 = cold account 2,600 + cold `directCount` slot 2,100
+ cold `baseAdvanceBps` 2,100 + ~920 of call and opcode overhead. And the 0-directs arm costs
**2,125 more than the 1-direct arm** because only the 0-directs path enters the branch and
SLOADs `baseAdvanceBps` — one cold SLOAD, 2,100, landing where it should.

### THE VERDICT, against the numbers that actually constrain

* Worst measured single item at **live MATRIX_SIZE 127: 4.37M gas**. The gate's absolute
  worst case adds **7,720 — 0.18% of one item.**
* A saturated 15-item batch adds at most **~53,000 gas** (one fully cold read, then 14 at
  ~3,220 each) against the **17.80M ceiling — 0.3%.**
* `minGasPerItem` is 5.00M against a 4.37M worst item, so the floor has 0.63M of headroom.
  **The gate spends at most 0.008M of it.** It does not touch the floor decision.
* Register pays one SSTORE on the sponsor's counter: worst REGISTER moved **2.00M → 2.01M**.

**Three orders of magnitude of margin. Size and gas are closed as objections. What remains
open about the gate is entirely POLICY and the V8.50 re-measure — not feasibility.**

## 17.2 ⛔⛔ THE FIRST RUN WAS UNINTERPRETABLE, AND THE REASON IS A RULE, NOT AN ACCIDENT

The fixture was first built with a REAL base ceiling (`baseAdvanceBps = 1500`) — the natural
thing to write. The gas run came back cheaper than baseline and two tests failed. It was not
noise. **The gate BOUND, the fund refused loans it had granted at baseline, and the keeper's
work list changed underneath the measurement:**

| batch mix at cap 15 | PARKED_RESCUE | EVICT_PARKED |
|---|---|---|
| baseline | **8** | 4 |
| binding fixture (1500 bps) | **2** | **10** |

Every gas figure in that run priced a DIFFERENT POPULATION. GAS-5 and GAS-7 failed because
too few SF-funded rescues existed to build a curve — the fixture's own instruments correctly
refusing to report on a world that had changed. **Nothing was wrong with the code; the
control arm had moved.**

The fix is the distinction this project already owns: a gate that EXISTS is not a gate that
BINDS (14.3). To price the MECHANISM, set the ceiling to 10,000 bps — the router read happens
on every call, so the gas is real, but the ceiling never drops. **The re-run's work mix came
back byte-identical at every cap (`PARKED_RESCUEx8 EVICT_PARKEDx4 RECLAIMx1`, 10 passing),
and that identity is what makes the delta mean anything.** `fixture_gate_apply.js` takes
`--binding` for the policy question and defaults to non-binding for the cost question, with
the trap written into its header.

## 17.3 THE TWO INSTRUMENTS, AND WHERE THEY MEET

**BUILD THE SECOND INSTRUMENT — third session running, third time it paid.**

| | |
|---|---|
| end-to-end, cap-15 batch containing **8** SF-funded rescues | 6.40M → **6.43M = +0.03M** |
| probe's prediction, one gated read per rescued member | 7,720 + 7 × 3,220 = **30,260** |
| probe's prediction, two reads per member | **40,020** |

**The measured delta lands on the one-read row.** Per-rescue that is ~3,750 gas, which sits
between the probe's warm reading (1,220) and its fresh-member reading (3,220) — the two
instruments bound each other and nothing is left unexplained.

⚠ **DO NOT OVERSTATE WHAT THAT IDENTIFIES.** `V8_50_KeeperGas` prints to 0.01M, so the
measured delta is 0.03M ± 0.01M and the one-read reading is CONSISTENT with the data, not
proven by it. The two-read row is not excluded with confidence. It does not matter for the
verdict — both rows are ~0.2% of one item — and resolving it would need a raw-gas end-to-end
probe nobody currently needs. **Recorded as consistent, not as established.**

Every single-item reading moved by the same +0.01M and none moved by more: sfFunded median
1.49M→1.50M, max 1.76M→1.77M, GAS-7 cold 1.50M→1.51M and marginal 0.99M→1.00M, GAS-9's three
arrival contexts 1.50→1.51 / 0.56→0.57 / 1.14→1.15. **A uniform shift with no outlier is what
a constant added read looks like; a single anomalous row would have been a finding.**

## 17.4 ⚠ WHAT THIS SESSION DID NOT MEASURE — STATED SO NOBODY QUOTES IT WRONGLY

* **THE END-TO-END DELTA AT MATRIX_SIZE 127 WAS NOT RUN.** The end-to-end arm is at size 7.
  The ADDED cost is one external read that touches no matrix storage and no position loop, so
  matrix size cannot plausibly change it — and the probe measured that read in exact gas with
  no matrix in the world at all. ⚠ **That last sentence is REASONING, not a measurement.** It
  is carried because the margin is 0.18% and a 127 delta costs two long runs; if anyone ever
  needs it, revert-run-apply-run with `GAS_MATRIX_SIZE=127`.
* **THE REGISTER SSTORE IS COARSE.** +0.01M at two-decimal resolution. On the EVM schedule
  that is 22,100 for a sponsor's first direct and 5,000 after — ⚠ schedule arithmetic, not a
  measurement. Nobody should quote a register figure tighter than "+0.01M measured".
* **THE PLACEMENT IS A SOURCE READING.** The gate belongs in `StabilityFund.loanHeadroom`
  because that is the only place the ceiling arithmetic lives — `loanEligibleFor`,
  `loanEligible` and `MatrixKeeperLib._triageParked` all derive from it, so the keeper's "can
  this member be rescued" and the fund's "will I lend" cannot drift apart. **This corrects
  13.11 and 16.5, which both said the read had to go into `coPayRescue`. It does not: the
  matrix never needs to change, and the SF already stores `tierRouter` (StabilityFund.sol:98).**
  Reading source is valid for WHERE CODE LIVES. It is not valid for what a population does —
  that is 14.3's lesson and it still stands.

## 17.5 ⛔ THE BINDING RUN LEFT A POLICY FINDING BEHIND. IT IS THE OWNER'S, NOT CLAUDE'S.

The failed first run is evidence about one thing, and it is not gas: **a binding sponsorship
gate converts rescues into evictions.** In that fixture 6 members who were rescued at baseline
were evicted instead.

⚠ **THAT IS A FIXTURE-WORLD RESULT AND MUST NOT BE READ AS A LIVE PREDICTION.** In the
KeeperGas harness every member refers to W1, so essentially nobody has a direct and the gate
refuses almost everyone — the harshest possible case. On live, 13.11 measured that 52.3% of
members who cleared their debt had sponsored someone (11.5% of those still owing), so the
refused share would be far smaller. **But the direction is real and it is exactly the trade
the owner has to price: eviction has fired 0 times in 1,803 live episodes (14.3), and a
binding gate is the mechanism that would start it firing.** Rule 3 ("if they cannot cover it
they are not given the loan") and rule 1 ("not at the expense of the ecosystem") meet here.
**NOT A DECISION FOR CLAUDE. Do not design the base ceiling before the V8.50 re-measure.**

## 17.6 STATE OF THE TREE — AND THE SUITE BASELINE IS 618/8/0, NOT 611/7/0

**Full suite re-run at the end of this session: 618 passing / 8 pending / 0 failing.** The
611/7/0 carried since the param 59 commit was STALE, not a regression: sessions 11 and 12
added `V8_50_CycleEconomics`, `V8_50_ReferralBreakeven` and `V8_50_MemberLedger` after that
figure was taken. Run alone those three report **exactly 7**, which accounts for the whole
difference — measured, not assumed. The 8th pending is `V8_50_GateCost.test.js` (17.8).
⚠ `V8_50_ReferralBreakeven` generates its five `R=0..4` cases from a loop, so counting `it(`
in the source undercounts it. Run the file if you need the number.


Contracts `v8.1` at **`d1d78ef`** (session 17's commit, pushed), frontend `admin` = `preview`
= `main` at `74a1588`. **NOTHING DEPLOYED, NO CHAIN WRITTEN TO, NO CONTRACT FILE CHANGED — the fixture was applied and reverted, and
`git diff` on `contracts/TierRouter.sol` and `contracts/StabilityFund.sol` is empty.**
New untracked files: `scripts/fixture_gate_apply.js`, `test/V8_50_GateCost.test.js`,
`contracts/test/GateProbe.sol`, and the run logs `gate_baseline_*.txt`, `gate_probe.txt`,
`gate_gas_nonbinding.txt`, `gate_sizes2.txt`.

### ⛔ A TRAP THIS SESSION CREATED AND THEN CAUGHT — READ IT BEFORE TRUSTING ANY `git status`

`contracts/test/CryptoNovaCommunityWallet.sol` reads as modified with 474 insertions and 474
deletions **from Claude's side and NOT from the owner's.** The owner's `git status --short
contracts/` returns empty; the same command through Claude's file bridge returns that file.
The first version of this section recorded it as an unexplained backlog item on the strength
of Claude's reading alone. **That was one instrument, unchecked, and it was the wrong one.**

Measured: `git diff --ignore-all-space` on the file is **empty**, the worktree copy holds
**474 carriage returns across 491 lines**, and the committed blob holds **0**. The file has
mixed line endings on disk, git stores it as LF, and the owner's git normalises on
comparison so it never appears. **There is nothing wrong with the repository.**

> ⛔ **THE STANDING TRAP: CLAUDE'S FILE BRIDGE DOES NOT APPLY THE OWNER'S LINE-ENDING
> NORMALISATION. `git status` and `git diff` read from Claude's side can show whole-file
> diffs that DO NOT EXIST for the owner.** Before recording any whole-file diff as a finding,
> run `git diff --ignore-all-space` and ask the owner what HIS `git status` says. His machine
> is the authoritative one. A session that "fixes" one of these will commit a 474-line churn
> that changes nothing and hides what else is in the commit.

## 17.7 NEXT, IN ORDER

1. **RE-MEASURE 14.1 AND 16.2 ON THE PRIVATE V8.50 DEPLOY.** Now the only blocking item.
   `crossingBufferBps = 0` is in the tree and NOT deployed; the buffer manufactured most of
   the debt behind every number in 13→16. Less debt means less collection and the whole table
   shrinks. **The gate's base ceiling must be chosen on V8.50 numbers, not V8.48 ones** — and
   17.1 means feasibility is no longer a reason to delay that.
2. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4's one real imbalance).
3. **THE GATE'S POLICY SHAPE — after item 1, and it is partly the owner's.** What base ceiling,
   and whether refusing a loan should route to eviction at all given 17.5.
4. Backlog: the 5 unexplained cycle-outs (still exactly 5, organic); `CryptoNovaCommunityWallet.sol`'s
   whole-file diff (17.6); `V8_50_ReferralBreakeven.test.js` v4 counts the dead event;
   stale-nonce retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20
   in source; member-callable re-entry.

## 17.8 TOOLS BUILT — both kept, both read the trap in their own headers

* **`scripts/fixture_gate_apply.js`** — applies the exact measured fixture (five edits, two
  files), `--binding` for the policy arm, `--undo` to revert. Refuses to half-apply: any
  anchor that does not match exactly once aborts the whole run. A later session gets THIS
  fixture rather than a new one it has to re-argue.
* **`test/V8_50_GateCost.test.js`** — the probe. **`describe.skip` ON PURPOSE**: without the
  fixture applied both arms are the same contract, the delta is 0 and the assertions fail.
  Its header carries the four-step run recipe. It also asserts the non-binding gate does not
  change the ANSWER (headroom identical across all three arms) — a free correctness check
  that would have caught a gate that silently altered the ceiling while looking cheap.
* **`contracts/test/GateProbe.sol`** — `probeTwice` measures cold and warm in one transaction,
  plus `MockDirectRouter` so the probe needs no matrix world. Not in the `sizes.js` watch
  list, never deployed.

---

# ⬛ SESSION 16 STATE — 2026-08-20. READ AFTER SESSION 17. IT CLOSES THE LENDING QUESTION.

Measurement only. **No contract file touched, nothing deployed, no chain written to.**
`scripts/diag_clawback_window.js` (v2, read-only). Live V8.48, blocks 45430468..45744353.
✅ no unreadable ranges. **This section is the conclusion of the 13→16 lending investigation.
If you read one section, read 16.4 and 16.5.**

## 16.1 ⛔ A DEFECT CAUGHT BEFORE IT SHIPPED, BY THE ONLY THING THAT CATCHES THEM

v1 of this script reported **36 of 123 organic borrowers held back by debt collection** and
printed "(a) IS ESTABLISHED". **It was wrong and it would have been quoted.** What caught it was
not review — it was that a SECOND instrument had already measured an overlapping quantity and
the two did not agree:

| | |
|---|---|
| `diag_debt_sweep.js`, total collected at organic hops | **$336.36** |
| v1's HOP class, same population, same blocks | **$535.76** |

**$199.40 — a third of the money — and the strict total was the entire finding.** The cause:
v1's window ran from the member's previous forward hop, block-INCLUSIVE, over collections from
EVERY matrix. So each cycle was charged the previous cycle's sweep, plus money taken in other
tiers' ledgers that never touched the balance this hop tests.

**v2's window is ONE OCCUPANCY** — from the member's most recent `MemberEntered` AT THE CYCLING
MATRIX to the hop, counting only collections EMITTED BY THAT MATRIX, because the hop tests
`self.members[root].withdrawable` in that matrix and nothing else can have spent it. v2 carries
a **boundary audit** that goes ⛔ across section 3 if HOP-class money ever appears from a second
transaction, which within one occupancy is impossible. **It now reads $336.36 and $0.00 leakage,
and 0 hops needed excluding for a missing anchor.** The two instruments agree.

> **THE RULE THIS EARNS, and it is the second time in two sessions: BUILD THE SECOND
> INSTRUMENT. Not a review pass, not a re-read — a different measurement of an overlapping
> quantity, and a printed line where they must meet.** 15.6's fund-vs-matrix cross-check
> ($696.85 = $696.85) and this session's boundary audit are the same device. Both defects this
> pair of sessions produced were caught by it and neither would have been caught by reasoning.

## 16.2 ⛔⛔ THE ANSWER: BOTH MECHANISMS ARE REFUTED. THERE IS NO FREE LEVER.

15.4 posed the fork — **(a)** the protocol's own debt collection is what stops borrowers
graduating, in which case `setClawbackBands` is a lever needing no redeploy; or **(b)** they
were simply short. ORGANIC, 385 forward-hop attempts, 123 of them parked while owing the fund:

| where the collected money came from, inside the occupancy | |
|---|---|
| **CLAWBACK** — the 60% band, deducted from pool credits in place | **$0.00 — 0.0%** |
| **HOP** — taken in the cycle-out transaction itself | **$336.36 — 100.0%** |
| CROSSING / WITHDRAWAL | $0.00 |

| | |
|---|---|
| parked short while owing | 123 |
| ...with any collection during the occupancy | 123 — 100% |
| **⛔ ...where the collection alone would have covered the shortfall** | **5 — 4.1%** |

**THE 60% CLAWBACK BAND TOOK NOTHING AT ALL INSIDE A MatB OCCUPANCY.** Not "a little" — zero,
across the entire deployment. Whatever the clawback collects (v1's wider window saw $23.58
organic), it collects it in the MatA ledger, which on V8.48 is not the balance the forward hop
is judged against. **And the hop-transaction collection was decisive in 5 of 123 — the same 5
`diag_debt_sweep.js` found independently.** (a) is dead. `setClawbackBands` is not the lever.

## 16.3 ⚠ BUT "DECISIVE" IS A HIGH BAR AND THE OTHER READING MATTERS — QUOTE BOTH

| | organic |
|---|---|
| collected in-occupancy | min $0.01 · p25 $1.54 · **med $3.40** · p75 $3.51 · max $8.24 |
| shortfall at the hop | min $0.48 · p25 $3.11 · **med $4.80** · p75 $5.00 · max $11.87 |
| **aggregate collected / aggregate shortfall** | **$330.39 / $490.25 = 67.4%** |

**The collection accounts for two-thirds of every dollar missing at the organic forward hop —
and still gets only 5 more members over the line.** In 118 of 123 cases the amount taken was
LESS than the shortfall, so removing it shrinks the gap without closing it. **Reducing a gap and
closing a gap are different results and this run produced one of each.** Never quote 67.4%
without 5-of-123 beside it, or the reverse.

⚠ **THE BIGFILL PANEL READS 37 of 127 DECISIVE (29.1%) AND THAT IS NOT A CONTRADICTION.**
Bigfill's median shortfall is **$2.36** against organic's $4.80, so the same ~$3.45 collection
clears the bar there. It shows the mechanism CAN be decisive when the shortfall is small. It
says nothing about members — 15.3 already established this control cannot carry a verdict, and
v1's boilerplate "(a) IS ESTABLISHED" line firing on the control was an instrument wording
defect, fixed in v2.1.

## 16.4 ⛔⛔ SO WHAT IS ACTUALLY STOPPING THEM — AND IT WAS ALREADY MEASURED IN SESSION 11

Nothing new is needed to explain the residual. Session 11's closed form: a member with no
referral income receives **pool 3136 + chain 1900 + own direct 500 = 5536 bps** of a cycle and
needs 10000; the leaks are the system take 2564 bps and orphaned L1 1900 bps. **A member who
never recruits cannot self-fund the forward hop while the protocol takes any fee at all.** That
is conservation of money, not tuning, and no split table, loan ceiling, clawback band or
threshold changes it.

**Debt collection is not why borrowers fail the hop. It makes their failure bigger, not their
success possible.** Sessions 14→16 have now ruled out, by measurement, every candidate that
would have made the graduation gap a policy artefact:

* the eviction ladder and ratio gates — **have never fired on live** (14.3)
* the debt sweep at cycle-out — **5 of 295 parks** (15.1)
* the continuous banded clawback — **$0.00 inside the occupancy** (16.2)

## 16.5 ⛔⛔ WHERE THIS LEAVES THE OWNER'S FIVE RULES — CLAUDE'S RECOMMENDATION, HIS DECISION

1. **KEEP LENDING. RULE 1's FIRST HALF IS VINDICATED BY MEASUREMENT.** From a common parked
   state, loan-rescued organic members reach 2+ cycles at **83.2%** against **13.0%** for the
   never-rescued (14.1). The owner's two-cycle bar is met and it is the loan that meets it.
2. **PRICE IT HONESTLY: 20.2% end still owing against 10.0% for self-rescuers** (14.2). That is
   rule 1's second half and it is the real cost. It is not a reason to stop lending; it is the
   number to state when explaining why lending has limits.
3. **PARAM 59 — KEEP 5000. Re-confirmed a third time and on a third basis.** 13.11 said the AB
   curve beats V8.48 data; 14.3 said the ladder has never rejected anybody on live; 16.2 says
   the collection machinery is not what binds either. **Nothing measured on V8.48 can calibrate
   this parameter.**
4. **DO NOT CUT THE FLOOR TO 40% OR 20%.** 13.11 showed 100% repayment is reachable only at
   1000 bps, which caps 101 of 114 borrowers — ending lending to keep the book clean. 14.3 adds
   that no member has ever been thin enough for the ladder to refuse them. **The floor is not
   the instrument the owner is looking for.**
5. **DO NOT TOUCH `setClawbackBands` FOR THIS PURPOSE.** It looked like a free lever for one
   session. Measured, it plays no part at the forward hop. ⚠ It may still matter for how fast
   debt retires and how much members can withdraw — that has NOT been measured and should not
   be assumed either way.
6. **THE EXIT IS SPONSORSHIP, AND THAT IS THE OWNER'S OWN RULE 4.** It is the only route with a
   measured effect left standing: of organic members still owing, 11.5% ever sponsored anyone;
   of those who cleared, 52.3% (13.11). Repayment at loan time by directs: 0 → 67.2%, 1 → 92.6%
   (13.6). ⚠ ASSOCIATION, NOT CAUSATION — sufficient for a GATE, never quotable as "recruiting
   makes you solvent".

**THE ONE BUILD THIS POINTS AT — and it is still not promised.** 13.11's shape: keep the floor
at 5000 as the outer ceiling, give a small first advance at 0 directs, unlock the rest of the
headroom at `directCount >= 1`. `directCount` does not exist (TierRouter:216 stores only
`memberReferrer`), and `coPayRescue` sees only `withdrawable` and `crossingReserve`, so the gate
needs a router read **at a call already near the block gas ceiling. SIZE AND GAS MUST BE
MEASURED BEFORE ANY OF IT IS PROMISED.** That measurement is next and it is the last thing
between this investigation and a decision the owner can act on.

## 16.6 NEXT, IN ORDER

1. **MEASURE SIZE AND GAS for `directCount` + the gate.** The only blocking item left. Build a
   fixture that adds the mapping and the router read, and measure contract size delta and the
   gas delta at `coPayRescue` / `forceCrossKeeper` against the block ceiling. **Do not design
   the gate before this number exists.**
2. **RE-MEASURE 14.1 AND 16.2 ON THE PRIVATE V8.50 DEPLOY.** `crossingBufferBps = 0` is in the
   tree and NOT deployed; the buffer manufactured most of the debt measured across 13→16. Less
   debt means less collection and the whole table shrinks. Every number in these four sections
   is on the old build.
3. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4's one real imbalance).
4. Backlog, untouched throughout: the 5 unexplained cycle-outs (still exactly 5, organic);
   `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce retry backoff;
   @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live **15** vs 20 in source;
   member-callable re-entry.

## 16.7 TOOL — `scripts/diag_clawback_window.js` v2.1, read-only

Per forward hop: the occupancy window, every debt collection inside it classified by what else
was in its transaction (the four `RescueDebtRepaid` emit sites cannot be told apart from logs,
so the transaction's other events are the discriminator), the shortfall, and the exact
counterfactual. Prints STRICT and LOOSE side by side so the ambiguity in the CROSSING and
WITHDRAWAL classes is visible rather than buried in one figure. Boundary audit in every panel.
v2.1 also stopped the control cohort from printing a verdict it is not entitled to.

---

# ⬛ SESSION 15 STATE — 2026-08-20. ⚠ 15.4's FORK IS ANSWERED BY 16.2 ABOVE — (a) IS REFUTED.

Measurement only. **No contract file touched, nothing deployed, no chain written to.** One new
read-only diagnostic, `scripts/diag_debt_sweep.js`. Live V8.48, blocks 45430468..45743935.
✅ no unreadable ranges, and the run's own cross-check closed exactly: $696.85 collected per the
matrices, $696.85 received per the fund, **0 transactions where the two readings disagree.**

## 15.1 ⛔⛔ 14.5's HYPOTHESIS IS REFUTED. THE CYCLE-OUT SWEEP DOES NOT COST MEMBERS THE HOP.

14.5 proposed that the debt sweep at MatB cycle-out takes the member's balance at exactly the
moment they need it for the forward hop. It was marked UNVERIFIED. **It has now been tested
with an exact same-transaction counterfactual — `swept >= shortfall`, both numbers off the
chain — and it is WRONG.**

| ORGANIC, 295 parks with a shortfall | |
|---|---|
| debt collected in the same transaction | 123 — 41.7% of parks |
| **⛔ collected ENOUGH to have caused the park** | **5 — 1.7% of parks** |
| collected, but less than the shortfall (made it worse, not decisive) | 118 |
| no collection at all — a genuine shortfall | 172 |

**Five cases, $3.45 of shortfall between them, across the entire deployment.** The sweep is not
the mechanism. Strike the 14.5 hypothesis; do not soften it, do not keep it as "partly true".

**AND THE INSTRUMENT WAS LOOKING AT THE WRONG MOMENT — that is the real lesson here.** The
median collection *in the hop's own transaction* is $3.40, which is small precisely BECAUSE the
member has already been skimmed all cycle: `clawbackBpsFor` redirects a band of EVERY pool share
to the fund (V8.31 raised it to 50%), and `withdrawCore` repays before it pays out. By the time
the sweep runs there is little left to take. **I measured the last bite and concluded there had
been no meal.**

## 15.2 ⛔⛔ AND THE SAME RUN PRODUCED A FAR STRONGER NUMBER THAN THE ONE IT WENT LOOKING FOR

| ORGANIC — 385 MatB forward-hop attempts | hops | re-entered | cleared |
|---|---|---|---|
| owed the fund NOTHING going in | 258 | 82 | **31.8%** |
| **owed the fund something going in** | 127 | 3 | **2.4%** |

**A member carrying debt into the forward hop graduates at 2.4%. A member carrying none
graduates at 31.8%.** Overall organic clearance 22.1%, consistent with 13.1's 22.49%.

⚠ **THIS TABLE IS CONFOUNDED AND THE HONEST NUMBER IS SMALLER — 14.1 ALREADY SUPPLIES IT.**
You owe the fund because you were short, so debtors were the weaker population first. The
balanced version of the same comparison is in 14.1, held to a common parked starting state:
**loan-rescued clear the hop at 8.0%, self-rescued at 19.6%.** A factor of ~2.4, not of 13.
**Quote 8.0/19.6, never 2.4/31.8.** The 13x is what the effect looks like before selection is
removed and it is exactly the shape 13.5 got burned by.

## 15.3 ⚠ THE BIGFILL CONTROL CANNOT DISCRIMINATE HERE — SAY SO RATHER THAN SPEND IT

| BIGFILL | hops | cleared |
|---|---|---|
| no debt going in | 360 | 1.4% |
| owed something | 130 | 2.3% |

The control's own no-debt baseline is **1.4%**, on the floor, because since 2026-08-19 bigfill
registers one fresh wallet per run with no referral income (13.1). **A control whose baseline is
already at the floor cannot show a penalty below it.** It neither supports nor refutes 15.2 and
must not be quoted in either direction. What it DOES confirm is that the collection machinery
bites hard when there is something to take: 37 of bigfill's parks were decisive by the same
exact test, uniformly $4.10 swept against a $2.10 shortfall — the machine, doing the same thing
every time.

## 15.4 ⛔ THE QUESTION THAT IS NOW THE LAST ONE STANDING ⚠ ANSWERED BY 16.2 — THERE IS NO FREE LEVER
> **16.2 RAN IT. (a) IS REFUTED.** The 60% clawback band collected **$0.00** inside a MatB
> occupancy across the whole deployment, and the hop-transaction collection was decisive in 5 of
> 123. `setClawbackBands` is NOT the lever this section hoped for. The fork below is the record
> of the question; 16.2 and 16.4 are the answer. Read those before quoting anything here.

15.1 killed the *concentrated* mechanism. That leaves two live explanations for 14.1's
balanced 8.0% vs 19.6%, and **they point at different decisions:**

* **(a) CONTINUOUS COLLECTION.** The banded clawback takes its share of every pool credit for
  the whole journey, so a borrower arrives at the hop having been drained gradually rather than
  at once. If this is it, **the protocol's own repayment schedule is what prevents borrowers
  graduating** — and the fix costs no new contract surface, because `clawbackBpsFor` is driven
  by **DAO param 50**, already governed, already on a menu.
* **(b) SELECTION.** Borrowers were simply poorer and would not have graduated either way. If
  this is it there is no lever and lending is a palliative, not a path.

**THE SAME EXACT COUNTERFACTUAL DECIDES IT, JUST OVER THE RIGHT WINDOW:** total debt collected
from the member between the loan and the hop, against the shortfall at the hop. If everything
taken from them across the journey would have covered the shortfall, (a) is established with the
same rigour that killed 14.5. **NOT YET RUN. Nothing about the lending rules should be settled
before it.**

⚠ AND THE FRAME THAT MUST TRAVEL WITH IT, unchanged from 14.9's script header: **THE MONEY IS
NOT FREE.** "Would have cleared without the collection" is not "should not have been collected"
— the debt would still be outstanding and would travel into the next cycle. This is an ORDERING
policy — collect now, or let them graduate and collect later — and choosing it is the owner's.

## 15.5 NEXT, IN ORDER

1. **THE EXTENDED-WINDOW COUNTERFACTUAL (15.4).** Decides (a) vs (b). Last thread before the
   lending rules can be settled.
2. **SPLIT 14.1 BY TIER** and cap time-at-risk (14.4's imbalance). Unchanged.
3. **MEASURE SIZE AND GAS for `directCount` + the gate.** Unchanged, still unmeasured, still
   must not be promised until it is. ⚠ Note the ordering point 15.4 raises: if (a) holds, param
   50 is a lever with NO new storage and NO new gas at a call already near the block ceiling,
   which makes it strictly cheaper than the `directCount` gate and it should be priced first.
4. **RE-MEASURE EVERYTHING ON THE PRIVATE V8.50 DEPLOY.** Unchanged.
5. Backlog: the 5 unexplained cycle-outs (5 again in this run, organic, at the same hop — the
   count has not moved); `V8_50_ReferralBreakeven.test.js` v4 counts the dead event; stale-nonce
   retry backoff; @bevmawire's Dashboard retry; `maxItemsPerUpkeep` live 15 vs 20 in source;
   member-callable re-entry.

## 15.6 TOOL BUILT — `scripts/diag_debt_sweep.js`, read-only

Every MatB cycle-out, its outcome in the same transaction (`MemberReentered` = cleared,
`MemberParked` with shortfall > 0 = failed), the member's debt going in, and every debt
repayment charged to them in that transaction. Organic and bigfill panels.

**Two design points worth keeping:**
* `RescueDebtRepaid` has **FOUR emit sites** (MatrixLogicLib:638 clawback, :853 the sweep, :1015
  a crossing, :1393 withdrawCore) and two of them can fire in one cycle-out transaction. They
  cannot be told apart from logs and **do not need to be** — both reduce the same numerator, so
  the script sums them and says so rather than pretending to attribute.
* **The same money is read twice** — `RescueDebtRepaid` at the matrix and `MemberDebtRepaid` at
  the fund — and printed side by side as an AGREE-not-add check. It closed at $696.85 = $696.85,
  0 disagreements. If it ever does not, stop and find the repayment path that misses the fund.

---

# ⬛ SESSION 14 STATE — 2026-08-20. ⚠ 14.5 IS REFUTED BY 15.1 ABOVE — READ 15.1 BEFORE QUOTING 14.5.

Measurement only. **No contract file touched, nothing deployed, no chain written to.** One new
read-only diagnostic, `scripts/diag_parked_experiment.js`. Live V8.48, blocks
45430468..45743290, tiers T1-T3, 12 matrices, ✅ no unreadable block ranges.

## 14.1 ⛔⛔ THE NEAR-EXPERIMENT RAN, THE ARMS CAME OUT BALANCED, AND 13.5's HEADLINE IS REFUTED
> ⛔⛔ **ITS HEADLINE IS OVERTURNED BY 25.0 — READ THAT FIRST.** "The loan meets the
> two-cycle bar" rested on outcomes measured to the head block. The loan arm's episodes are
> **1.71x older** than the self-rescue arm's, and on an EQUAL observation window the
> ordering reverses: **15.1% for the loan against 27.3% for self-rescue.** ✅ The arms ARE
> balanced on TIER (25.1, 14.4's suspicion refuted) — but 25.2 shows STILL-PARKED has since
> drifted 775 bps poorer and is no longer a balanced control. **The n's and the balance
> table below still stand as of 2026-08-20; the outcome columns must not be quoted without
> 25.0 beside them.**

13.9 item 1 asked for co-pay-rescued vs self-rescued vs never-rescued, all measured from the
same parked-with-shortfall state. **It exists now. 1,803 episodes, arms reconcile to 0
unaccounted.** ORGANIC cohort, by FILL_MNEMONIC key derivation:

| | n | cycled again | cleared hop | **2+ cycles** | **owing now** | med contribBps |
|---|---|---|---|---|---|---|
| **SF-LOAN** (rescued, debt booked) | 238 | 98.7% | 8.0% | **83.2%** | **20.2%** | 7939 |
| ASSIST-NOLOAN (rescued, no debt) | 8 | 75.0% | 25.0% | 50.0% | 0.0% | 9316 |
| **SELF-RESCUE** (own wallet money) | 219 | 83.6% | 19.6% | **64.4%** | **10.0%** | 7800 |
| **STILL PARKED** (never rescued) | 192 | 38.5% | 2.1% | **13.0%** | 7.3% | 7815 |
| EVICTED | **0** | — | — | — | — | — |

**AND THE ARMS ARE BALANCED AT BASELINE — the whole point of the design.** contribBps is
`(crossingReserve + withdrawable)` as bps of the crossing cost, reconstructed from the park
event's own shortfall, which IS the variable the selector uses:

| | min | p25 | med | p75 | max | debt@park | directs@park |
|---|---|---|---|---|---|---|---|
| SF-LOAN | 4653 | 6800 | 7939 | 8900 | 9979 | $0.00 | 0.65 |
| SELF-RESCUE | 4640 | 6800 | 7800 | 8668 | 9939 | $0.00 | 0.76 |
| STILL PARKED | 4667 | 6811 | 7815 | 8653 | 9974 | $0.00 | 0.70 |

Three arms, indistinguishable on every observable that goes into the decision, then wildly
different outcomes. **13.5 measured borrowers (7.1% reach 2+ cycles) against non-borrowers
(31.7%) across the whole population and warned in bold that it was selection. It was. Held to
the same starting state the ordering INVERTS: 83.2% for the loan, 64.4% for own money, 13.0%
for nothing.** Do not quote 13.5's table again without this one beside it.

**THE OWNER'S TWO-CYCLE BAR IS MET, AND IT IS THE LOAN THAT MEETS IT.**

## ~~14.2 AND THE COST IS IN THE SAME TABLE — THIS IS RULE 1's TRADE-OFF, PRICED~~
# ⛔⛔ WITHDRAWN 2026-08-21 BY 25.3. EVERY NUMBER IN THIS SECTION IS SUPERSEDED AND ONE OF
# THEM CHANGED SIGN. THE REPLACEMENT IS 25.3 — GO THERE.
#
# Owner decision, taken after 25.8 item 2 was put to him: **14.1 keeps its banner, 14.2 is
# struck.** 14.1 still carries a balance table nobody else has and half of it survived;
# 14.2 was one sentence pricing a trade-off, and both halves of that sentence are now wrong.
#
#   "doubles the odds of ending in debt"            -> QUINTUPLES   (56.0% vs 11.9%)
#   "buys 19 percentage points of two-cycle gain"   -> NEGATIVE 12  (15.1% vs 27.3%)
#
# The DIRECTION of the debt cost survives and is stronger than stated. The attainment
# benefit does not survive at all: it was an artefact of the loan arm's episodes being
# 1.71x older than the self-rescue arm's, and it disappears on an equal window.

~~**20.2% of loan-rescued episodes end with the member still owing, against 10.0% for the
members who paid their own way out of the identical position.** Same starting state, so this
one is not selection either. The loan doubles the odds of ending in debt and it buys 19
percentage points of two-cycle attainment. That is the whole of rule 1 — *"members need loans
and that is good, but not at the expense of the ecosystem"* — in two numbers, and it is the
first time the trade has been priced from a balanced comparison rather than asserted.~~

⚠ **KEPT STRUCK RATHER THAN DELETED**, the same convention session 7 used on session 6's
park table: the reasoning is the record of how it went wrong, and the failure mode —
comparing outcome columns across arms with unequal observation lengths — is the one worth
recognising next time. **Nothing above this line is a live number.**

## 14.3 ⛔⛔ TWO GATES AND ONE WHOLE ARM DO NOT EXIST ON LIVE — AND I CALLED THIS WRONG FIRST

**EVICTED = 0 of 1,803.** Eviction has still never fired on live V8.48 (session 9's addendum
said so; this confirms it across every episode, not just a snapshot). The "never-rescued"
counterfactual 13.5 wanted is STILL PARKED, not evicted, and those members are still sitting
there.

**AND NOBODY HAS EVER BEEN BELOW THE LADDER'S BOTTOM RUNG. 657 of 657 organic episodes and
1054 of 1054 bigfill episodes sit at or above 4000 bps; the lowest contribution ever observed
is 4640.** So `EVICT_LADDER` has never rejected anybody, and neither has `EVICT_RATIO` as far
as this run can see.

> ⛔ **A CORRECTION I OWE THE RECORD, AND IT IS RULE 1 IN MY OWN HANDS.** Before building this
> I read `MatrixKeeperLib._triageParked`, found the four gates (ghost / ratio / **ladder** /
> **floor**), and told the owner the near-experiment was dead — that assignment is "positive on
> wealth and positive on creditworthiness" and "there is no unfiltered arm anywhere". **The code
> reading was correct and the CONCLUSION FROM IT WAS NOT.** A gate that exists is not a gate
> that binds, and whether it binds is empirical. Two of the three merit gates have never fired,
> the arms came out balanced, and the comparison I declared dead is the strongest result of the
> session. **Reading source is measuring the MECHANISM, not the POPULATION. Do not let one
> stand in for the other again.**
>
> What survives from that reading: the gates are real and they will bind the moment the
> population gets poorer, and `EVICT_FLOOR` (insolvencyFloorBps, live at 3400) is the one gate
> this run cannot see fire, because a refused rescue emits nothing. **That is the instrument's
> biggest blind spot — a member the floor refused looks identical to one nobody reached.**

**CONSEQUENCE FOR THE FLOOR DECISION, AND IT STRENGTHENS 13.11:** the ladder has never rejected
a member and eviction has never fired, so live V8.48 cannot calibrate either. 13.11 said the
AB curve is the better basis for PARAM 59 than tonight's V8.48 data. This is the stronger form
of the same point. **RE-CONFIRM RECOMMENDATION UNCHANGED: KEEP 5000.**

## 14.4 ⚠ THE FOUR OUTCOME COLUMNS ARE NOT EQUALLY TRUSTWORTHY. RANK THEM BEFORE QUOTING THEM.

* **`cycled again` and `2+ cycles` are PARTLY MECHANICAL.** A rescued member is put back in a
  seat, and a seated member cycles. A parked member cannot cycle in the matrix they are parked
  in. The 38.5% the STILL-PARKED arm does show comes from activity in OTHER tiers, which is
  why it is not zero — but the gap is inflated by construction and must never be quoted as
  "the loan makes members 2.6x more active".
* **`owing now` is CLEAN.** Nothing about being seated forces a debt balance at the head block.
  20.2% vs 10.0% is the honest number in this table.
* **`cleared hop` is CLEAN and it is the surprising one.** See 14.5.
* ⚠ **ONE REAL IMBALANCE, and it is in dollars not ratios.** Median shortfall is $2.65 for
  STILL-PARKED against $1.58 / $1.60 for the two rescued arms, while contribBps is the same
  across all three. Same ratio, bigger dollars means **the never-rescued arm skews to higher
  tiers.** Not fatal — the selector works in bps — but a per-tier split has not been run and
  should be before this table is used to set anything.
* ⚠ No time-at-risk adjustment. Outcomes run to the head block, so an early rescue has had
  longer to produce cycles than a recent one.

## 14.5 ⛔ THE LOAN BUYS CYCLES BUT NOT GRADUATION ⚠ THE MECHANISM NAMED HERE IS REFUTED BY 15.1
> **THE FINDING STANDS, THE EXPLANATION DOES NOT.** 8.0% vs 19.6% is real and is still the
> honest number. The debt-sweep-at-cycle-out mechanism proposed below was tested in session 15
> with an exact same-transaction counterfactual and caused **5 of 295 organic parks**. Read 15.1
> and 15.4 — the surviving candidate is the CONTINUOUS banded clawback, not this.

**Loan-rescued members clear the forward hop at 8.0%. Members who paid their own way out of
the same position clear it at 19.6% — nearly two and a half times better — while cycling
LESS (83.6% vs 98.7%).** More laps, fewer exits. Those two columns point opposite ways and
that disagreement is the finding.

⚠ **UNVERIFIED HYPOTHESIS, STATED OUT LOUD PER RULE 1 BECAUSE IT IS NECESSARY AND IT IS
CHEAP TO TEST: the debt sweep at MatB cycle-out (`MatrixLogicLib:838-852) takes the member's
balance at precisely the moment they would need it for the forward hop.** A borrower goes round
and round the A↔B loop while the sweep and the banded clawback keep skimming the accumulation
the $10.00 forward hop requires. If that is right, lending as currently structured does not
merely fail to graduate members — it **holds them in the loop**, and that is a far more serious
finding than the debt number in 14.2. **NOBODY HAS MEASURED IT. It is next (14.8 item 1) and
nothing should be built on it until it has run.**

## 14.6 THE BIGFILL CONTROL EARNED ITS KEEP AGAIN — IT SPLITS MECHANISM FROM MEMBERS

| BIGFILL (known machine) | n | cycled again | cleared hop | 2+ cycles | owing now |
|---|---|---|---|---|---|
| SF-LOAN | 178 | 100.0% | 2.2% | 100.0% | **1.1%** |
| SELF-RESCUE | 859 | 80.3% | 1.6% | 61.9% | **0.0%** |
| STILL PARKED | 16 | 0.0% | 0.0% | 0.0% | 6.3% |

**THE CYCLING ORDERING IS IDENTICAL ON A POPULATION OF SCRIPTS.** loan > self > parked appears
in both panels, which confirms 14.4's warning: that ordering is a property of the MECHANISM
(seated members cycle), not a fact about members. **What does NOT reproduce is the debt: 1.1%
of bigfill loan episodes end owing against 20.2% organic, and organic self-rescuers clear the
hop at 19.6% against bigfill's 1.6%.** Those two are member-specific and they are the columns
worth spending.

## 14.7 ⛔ SECTION 4 OF THE OUTPUT IS VOID — THE DISCONTINUITY WINDOW HAS AN EMPTY SIDE

The script's regression-discontinuity window around the 4000 bps rung is unusable and says so
itself: the below-rung side is **0 episodes** in both cohorts, because of 14.3. **There is
therefore no clean causal reading anywhere in this run.** 14.1's balance table is the whole of
the case, and it is a strong one — but it is balance on OBSERVABLES, not randomisation. A
member who self-rescued had wallet money and chose to spend it; that choice is unobserved and
it is exactly the kind of thing that also predicts repayment. **State that sentence every time
14.1 is quoted.**

## 14.8 NEXT, IN ORDER

1. **THE DEBT SWEEP AND THE FORWARD HOP (14.5).** Does an outstanding balance at MatB cycle-out
   consume the accumulation the hop needs? Split forward-hop clearance by debt-at-cycle-out and
   measure what the sweep took in the same tx. This decides whether lending traps members, and
   nothing about the lending rules should be settled before it runs.
2. **SPLIT 14.1 BY TIER** (14.4's imbalance) and re-run with time-at-risk capped, so early and
   late episodes are compared over equal windows.
3. **MEASURE SIZE AND GAS for `directCount` + the gate** (13.6 / 13.11) — still unmeasured,
   still must not be promised until it is. TierRouter:216 stores only `memberReferrer`;
   `coPayRescue` sees only `withdrawable` and `crossingReserve`.
4. **RE-MEASURE EVERYTHING ON THE PRIVATE V8.50 DEPLOY.** Unchanged from 13.9.
5. Backlog, still untouched: the 5 unexplained cycle-outs; `V8_50_ReferralBreakeven.test.js` v4
   counts the dead event; stale-nonce retry backoff; @bevmawire's Dashboard retry;
   `maxItemsPerUpkeep` (read live tonight as **15**) vs the 20 in source; member-callable
   re-entry.

## 14.9 TOOL BUILT — `scripts/diag_parked_experiment.js`, read-only

Episode-based: a `MemberParked` with shortfall > 0 opens an episode, the first exit event in
that matrix closes it, and every event that does not fit is counted and printed rather than
dropped. Reads the live ladder / ratio / floor / maxItems off chain and prints them as the
basis before any result. Prints the BALANCE CHECK before the outcomes, by design. Runs the
whole analysis twice — organic and bigfill — because 13.8 cost a session's credibility to learn
that a fingerprint run only on the subject tells whichever story you went in wanting.

⚠ Two things noticed in its own output, both minor, both real:
* `crossingBufferBps` read as **unreadable (-1)** — the getter does not exist on the deployed
  V8.48 keeper. Not a script defect: it is direct confirmation that live predates the V8.49
  parameter, which is what 13.11 asserts.
* `maxItemsPerUpkeep` reads **15** on chain against **20** in `MatrixKeeper.sol:218`. Expected
  (it is settable) but it is the backlog item that has been restated wrongly twice — the live
  value is 15.

---

# ⬛ SESSION 13 STATE — 2026-08-20. ⚠ 13.5 IS REFUTED AND 13.9 IS RE-ORDERED BY SESSION 14 ABOVE — READ 14.1 FIRST.

Measurement only. **No contract file touched, nothing deployed, no chain written to.** Five
new read-only diagnostics. Everything below is live V8.48, blocks 45430468..~45741800.

## 13.1 ⛔⛔ THE COHORT ROW 12.7 DEMANDED — AND THE CONFOUND POINTED THE OTHER WAY

12.7 said the owner's A/B/C decision must not be taken until the bigfill wallets were
separated from organic members. **That row now exists. The confound was real and it was
BACKWARDS from what 12.6 feared.**

| | ORGANIC (real members) | BIGFILL (owner-funded) | LEADER (roster) |
|---|---|---|---|
| MatB hop attempts | 369 | 453 | 137 |
| RE-ENTERED | 83 | 8 | 85 |
| **cleared %** | **22.49%** | **1.77%** | 62.04% |
| borrowed | **$727.63** | $712.33 | $71.38 |
| repaid | **91.88%** | 99.82% | 100.00% |
| borrowers | 113 | 170 | 21 |

**ORGANIC IS THE LARGER HALF OF THE LOAN BOOK AND CLEARS THE HOP TWELVE TIMES BETTER THAN
BIGFILL.** 12.6 worried the 95.78% headline was the owner repaying the owner. It was not:
the owner-funded population was dragging the headline DOWN. Bigfill clears at 1.77% because
since 2026-08-19 it registers one fresh wallet per run with no referral income — it is the
fixture floor showing up live, exactly as 12.1's fixture predicted.

**The LEADER column is not evidence of anything.** The 41 roster addresses are bigfill's
round-robin sponsors, so every bigfill registration pays them L1. They clear at 62% because
bigfill feeds them. Do not spend that number in either direction.

## 13.2 HOW THE COHORT WAS ESTABLISHED — KEY DERIVATION, NOT RESEMBLANCE

12.7 proposed identifying bigfill by "round-robin leader sponsor, lifetime withdrawn $0.00,
reserve exactly $5.00". **All three are properties a real member can also have, so all three
can misclassify — and misclassifying a bigfill wallet as organic is the direction that
FLATTERS.** Instead `diag_forward_hop_cohort.js` re-derives the wallets from `FILL_MNEMONIC`
at `m/44'/60'/0'/0/i`, the same derivation `bigfill_v8.js` uses to create them. Exact test,
not a similarity test. Verified in a sandbox first: `deriveChild(i)` off the account node
gives byte-identical addresses to the full-path form.

**THREE LEAKS WERE HUNTED AND ALL THREE ARE CLOSED:**
1. **Short index window** — re-ran at COHORT_MAX 1200 and 2400. Identical output, highest
   index seen 296. The window was never leaking.
2. **A second phrase** — only `FILL_MNEMONIC` exists in `.env`. `organic_drip.js`,
   `community_drip.js`, `slow_drip.js` and `fill_t2.js` all read it; `community_sim.js`
   reads `MNEMONIC`, which is unset, so it cannot have populated anything.
3. **The VPS keeper** — `stress_keeper.js:22` reads `process.env.FILL_MNEMONIC` and derives
   `m/44'/60'/0'/0/${index}`: **the same phrase on the same path**, so its wallets were
   already inside BIGFILL. Owner confirmed independently: "the stress and the bigfill uses
   the same thing, we just run one or the other." **No VPS `.env` read was needed.**

## 13.3 ⛔ "ORGANIC" IS NOT AUTOMATICALLY "HUMAN" — AND THE DISAGREEMENT WAS THE FINDING

The first run classified **152 addresses as organic while BUGS.md holds 13**. A community of
dozens cannot be 152, so ORGANIC meant "everything the classifier could not name". Chasing it
produced the strongest evidence of the session, in `diag_who_are_they.js`, which runs the
same fingerprint over TWO CONTROL GROUPS (BIGFILL = known machine, NAMED = known human)
because a fingerprint run only on the subject tells whichever story you went in wanting:

| | BIGFILL | NAMED | UNIDENTIFIED |
|---|---|---|---|
| distinct sponsors | 38 | 8 | **70** |
| sponsored by a roster leader | **100.0%** | 36.4% | **16.1%** |
| biggest single sponsor's share | 17.0% | 36.4% | **4.9%** |

**A round-robin script produces 100% roster sponsorship. 70 distinct sponsors with no sponsor
above 4.9% is a referral tree spreading through people.** Combined with 13.2's three closed
leaks and six alternative derivation paths coming back clean, the 143 are real members.

## 13.4 ⛔ THE LOAN IS CREDIT, NOT PLUMBING — AND MY GUESS WAS WRONG

Borrowed and repaid match to the cent across most organic wallets, which looked like the SF
fronting a shortfall inside one atomic flow and taking it straight back. **Measured: 0 of 239
organic loans clear in their own transaction. 0 clear in the same block.** Median time to
zero debt: **13.5 hours organic, 40.5 hours bigfill**. These are real balances carried across
cycles. Option B carries genuine risk that has to be priced, and the "bookkeeping change"
reading is dead.

**42 of 239 organic loans (17.6%) never reached zero**, against 2 of 182 for bigfill.

⚠ **INSTRUMENT LIMIT, CARRY IT FORWARD:** loans are not tracked individually. "Cleared" means
the member's debt returned to zero at some point after that loan. At ~2.1 loans per borrower
one zero event can close several loans, so the 42 never-cleared count is solid but the median
time is smeared.

## 13.5 ⛔⛔ ⚠ THIS SECTION IS REFUTED BY 14.1. READ 14.1 FIRST.
> **14.1 RAN THE NEAR-EXPERIMENT THIS SECTION ASKED FOR AND THE ORDERING INVERTS.** Held to the
> same parked-with-shortfall starting state, loan-rescued organic members reach 2+ cycles at
> **83.2%**, self-rescued at 64.4%, never-rescued at 13.0%. The 7.1%-vs-31.7% table below is the
> selection effect its own warning predicted. Keep the table as the record of the confounded
> comparison; do not quote it as a result.

### THE OWNER'S BAR, MEASURED FOR THE FIRST TIME — AND IT FAILS BOTH HALVES (⚠ SUPERSEDED)

The bar is *"give members at least two full cycles but not at the expense of an unpaid loan."*
That is a COMPARISON, and nobody had run it. ORGANIC members only:

| | BORROWED | NEVER BORROWED |
|---|---|---|
| members | 113 | 41 |
| clear rate | 14.6% | 43.1% |
| cycles per member | 0.35 | 1.07 |
| **reached 2+ cycles** | **8 (7.1%)** | 13 (31.7%) |

⚠ **SELECTION, NOT CAUSATION — STATE IT EVERY TIME THIS TABLE IS QUOTED.** You borrow BECAUSE
you were short, so borrowers were the weaker population before the loan touched them. This
CANNOT show the loan harmed anyone. What it shows without confound is that lending as
currently priced does not deliver the two-cycle bar, and that 42 loans went unpaid.

**THE NEAR-EXPERIMENT NOBODY HAS RUN:** every co-pay borrower was PARKED WITH A SHORTFALL at
the moment of the loan — and so were the members who SELF-RESCUED with their own money, and
so were the ones who STAYED PARKED. Same starting condition, three outcomes, and the keeper
picks co-pay recipients by walking a queue rather than by merit. That is as close to random
assignment as this chain offers and it would separate "the loan did not help" from "these
members were already sinking."

## 13.6 THE OWNER'S FIVE RULES (2026-08-20) AND WHERE EACH ONE LANDED

Owner set these while calling for a conclusion: (1) members need loans but not at the expense
of the ecosystem; (2) find the number where 100% of loans are repayable; (3) no loan if
earnings cannot cover it; (4) 2-3 recruits or coupon-sponsored recruits make you
self-sustaining; (5) possibly enforce pay-it-forward in code for coupon members.

* **RULE 3 IS ALREADY IMPLEMENTED AND LIVE.** `payCoRescue` (StabilityFund:686) requires
  `loanEligibleFor(member, tier, advance)`, which caps total debt at
  `tierEntryFees[tier] * insolvencyFloorBps / 10_000`. The comment at StabilityFund:781
  states the intent in the owner's own words: *"expected per-cycle earnings ~= tier fee x
  insolvencyFloorBps."* **Live on V8.48 at 3400 bps = $3.40 at T1.**
* **RULE 2 HAS NO ANSWER IN THAT PARAMETER.** Peak debt does not predict repayment — CLEAN is
  94.7% in the $4-5 band but 76.0% at $1-2 and 0% at $2-3. No dose-response, so tuning the cap
  does not sort good loans from bad. The tightest setting tested avoids $43.79 of bad debt by
  refusing 103 of 113 members and withholding $382.85 of lending. That is not a gate.
* **RULE 2's REAL ANSWER IS ONE DIRECT REFERRAL.** Repayment by directs held AT LOAN TIME:
  **0 directs 67.2% (67 members), 1 direct 92.6% (27 members), 2 directs 93.3% (15).** The
  cliff is 0 -> 1; 1 -> 2 adds nothing measurable. The 100% buckets are 2, 1 and 1 members —
  **100% of two people is not a policy** and must not be quoted as the threshold.
* **RULE 4 IS SUPPORTED, BY A DIFFERENT MECHANISM THAN EXPECTED.** Recruiting barely improves
  REPAYMENT past the first direct; what it improves is CYCLING — 2+ cycles reached by 3.5%,
  10.8%, 27.8% at 0, 1, 2 directs. Two different mechanisms; keep them separate in member copy.
* **RULES 3-gate AND 5 BOTH NEED A COUNTER THAT DOES NOT EXIST.** TierRouter:216 stores only
  `memberReferrer` (child -> sponsor). Nothing counts a downline. Needs
  `mapping(address => uint32) public directCount;` incremented where `memberReferrer` is
  assigned (TierRouter:762 register, :813 coupon). New mapping, no existing struct touched —
  but `coPayRescue` reads only `withdrawable` and `crossingReserve`, so the gate needs the
  count passed in or read through the router, **and that call has to be paid for in gas at a
  point already near the block ceiling. Size and gas both need measuring before it is promised.**

## 13.7 ⛔ PARAM 59 — ⚠ THIS SECTION IS CORRECTED BY 13.11. READ 13.11 FIRST.

> **13.11 REVERSES THE CONCLUSION BELOW.** 5000 was measured on the V8.50 arm with the
> crossing buffer already at zero; the V8.48 data in this section was generated WITH the
> buffer, which is what pushed 62 members past the ceiling. For the floor VALUE the AB curve
> is the better basis. **Re-confirm recommendation: KEEP 5000.** The rest of this section
> still stands as the record of the exposure question.

Session 10 item 1 records the owner choosing **5000** on 2026-08-19, landed in source. Live
V8.48 runs **3400** because nothing has been deployed since — **this is NOT source/chain
drift, and a mid-session claim that it was drift was wrong and is corrected here.**

But note what the queued change does: **it raises the T1 debt cap from $3.40 to $5.00, 47%
more exposure per member.** It was chosen on the eviction curve (floor evictions 7/6/5 ->
0/0/0; evicted-never-lent-to 9 -> 3) — a member-protective rationale, and a real one. 13.4
and 13.5 supply the other side of that trade, which did not exist on 2026-08-19: more lending
means more unpaid debt, and **organic members still carrying debt average 0.04 cycles against
0.43 for those who cleared.** An unpaid loan does not merely go unpaid — the floor then caps
the member out of borrowing again, so they stop cycling entirely. **25 organic members, ~16%
of the organic population, are in that state now.** Direction of causation is not established
(they may carry debt because they stopped, not stop because they carry debt) but the standing
population is a fact. **The 5000 decision is the owner's and stands; it should be re-confirmed
against this section before V8.50 deploys, not silently.**

## 13.8 ⚠ THREE INSTRUMENT DEFECTS PAID FOR THIS SESSION — TWO CAUGHT, ONE SHIPPED

1. **THE CONTROL GROUP EARNED ITS KEEP.** The USDC funding panel read **14% for BIGFILL**, a
   group we KNOW is owner-funded. That is not a fact about bigfill — the scan window starts at
   the V8.48 deploy block while those wallets were funded on the same mock USDC long before.
   Without a known-machine control, "most bigfill wallets are self-funded" would have been
   reported as a finding. **Section B of `diag_who_are_they.js` is void; do not quote it.**
2. **TWO OF MY THREE HYPOTHESES WERE WRONG AND THE INSTRUMENTS CAUGHT BOTH.** "The loan is
   plumbing" — refuted, 0% same-transaction. "The registration bursts are one sponsor
   onboarding their team" — refuted, 21 of 25 bursts have mixed sponsors. The sampled bursts
   sit within ~3h of deployment, so a launch-day rush is the likely reading, **UNVERIFIED and
   marked as such.** The population conclusion rests on 13.3's sponsor tree, not on this.
3. **A DEFECT THAT SHIPPED — `diag_insolvency_floor.js` MIXES TIERS.** The ceiling is PER
   TIER ($3.40 at T1, $8.50 at T2) but tables 1 and 2 bucket raw dollars and apply the T1 cap
   to everyone, so the ">$5.00" band is largely T2 members sitting INSIDE their own cap rather
   than members who exceeded one. **Both floor tables are weaker than they look and neither
   should be used to set the parameter.** Fix: express peak debt as bps-of-own-tier-fee before
   bucketing. The 13.6 conclusion does not rest on them — it rests on the directs analysis,
   which has no tier-mixing problem — but a floor change does and must not be made until this
   is re-run. Also: 3400 was not among the hardcoded candidates, so the `<- CURRENT` marker
   never printed.

## 13.9 NEXT, IN ORDER   ⚠ item 2 is ANSWERED by 13.11 — the corrected floor run is done

1. **THE PARKED NEAR-EXPERIMENT (13.5).** Co-pay-rescued vs self-rescued vs never-rescued,
   all measured from the same parked-with-shortfall starting state. This is the one comparison
   that can separate selection from causation and it decides whether lending helps at all.
2. **RE-RUN THE FLOOR ANALYSIS IN BPS-OF-OWN-TIER-FEE** (13.8 item 3) before any floor change,
   and re-confirm PARAM 59's 5000 against 13.7.
3. **UNVERIFIED PROPOSAL, NOT MEASURED — first loan free, second needs a direct.** Allow the
   first loan at 0 directs so every member gets their shot at a cycle, require 1+ direct for a
   second. 0-direct members took 135 loans across 67 members (~2 each) with 22 still owing, so
   the exposure is concentrated in repeat lending. **This is an idea, not a finding — it needs
   a per-loan-sequence run before anyone builds it.**
4. **THEN the carried backlog**, still untouched: open one of the 5 unexplained cycle-outs
   (tx hashes in `diag_forward_hop_cohort.js` output, all 5 organic); fix
   `V8_50_ReferralBreakeven.test.js` v4 to count `MemberReentered`; stale-nonce retry backoff;
   @bevmawire's Dashboard retry; `maxItemsPerUpkeep` against 15; member-callable re-entry.

## 13.10 TOOLS BUILT THIS SESSION — all read-only, all default to `deployed_addresses_v8_48.json`

* `diag_forward_hop_cohort.js` — the hop split bigfill/leader/organic by key derivation, with
  the organic column split again into NAMED vs UNIDENTIFIED. Hard-exits if `FILL_MNEMONIC` is
  absent, warns if the HD window is saturated, and reconciles every cohort sum against the
  ungrouped total with a visible ✅/⛔ per line.
* `diag_who_are_they.js` — alternative derivation paths, USDC funding shape (**section B void,
  see 13.8**), registration bursts, sponsor spread. Two control groups.
* `diag_loan_lifetime.js` — burst composition, same-tx vs days-outstanding, borrowers vs
  non-borrowers on cycles, outstanding debt by cohort and age.
* `diag_referral_threshold.js` — directs vs repayment, lifetime AND at-loan-time, plus what a
  1/2/3-direct gate would have refused.
* `diag_insolvency_floor.js` — peak debt vs repayment, candidate bps replay, dead-end check.
  **v1 carried the tier-mixing defect in 13.8 item 3; v2 (shipped) fixes it — see 13.11.**

## 13.11 ⛔⛔ THE FLOOR, TIER-CORRECTED — AND THE ANSWER TO THE OWNER'S 100% TARGET

Owner's call, 2026-08-20: *"my call stands where we need to make the system not carry anyone's
debts — if they will not be able to pay we do not offer them a loan. I am looking for 100% loan
repayment, so if that means a reduction from 50% to 40% or even 20% so be it. The way to get out
would be to sponsor one or more."* Also: **PARAM 59 is to be RE-CONFIRMED, not shipped as-is**,
because it "was handed by a previous session before this evidence was presented."

`diag_insolvency_floor.js` v2 re-measures peak debt as **bps of the member's OWN tier fee** and
replaces v1's counterfactual with a purely observational question — *among members who never
exceeded B, what share ended clean?* Monotonic, and it answers the target directly:

| cap B | T1 cap | members at/below | clean | owing | CLEAN % |
|---|---|---|---|---|---|
| 1000 bps | $1.00 | 13 | 13 | 0 | **100.0%** |
| 1700 bps | $1.70 | 33 | 28 | 5 | 84.8% |
| 2500 bps | $2.50 | 45 | 36 | 9 | 80.0% |
| 3400 bps LIVE | $3.40 | 52 | 39 | 13 | 75.0% |

**THE FLOOR CAN REACH 100% — AT 1000 bps (10%), AND ONLY THERE.** The cost is in section 3 of
the output: **1000 bps would have capped 101 of 114 organic borrowers (88.6%)** to remove 26
defaulters. That is not "lending with a sane ceiling", it is ending lending to keep the book
clean, and it contradicts the first half of the owner's own rule 1 (*"members need loans to help
them and that is good"*). **The 100% target is reachable by parameter only by abolishing the
thing the parameter governs.**

### ⛔ AND TONIGHT'S DATA IS THE WRONG BASIS FOR SETTING THE FLOOR ANYWAY — A CORRECTION TO 13.7
Section 1 shows **62 organic members with peak debt ABOVE the live 3400 cap**, which should be
impossible. It is not a floor failure: `forceCrossKeeper` (MatrixLogicLib:1612) books
`sfContribution + crossingBuffer` as one advance, and the crossing buffer pushed members past the
ceiling — the exact effect recorded on 2026-08-15 as *"it exceeded insolvencyFloorBps so the floor
could refuse nobody"*. **`crossingBufferBps = 0` has been the default in the tree since V8.49
(MatrixKeeper.sol:153) but IS NOT DEPLOYED. V8.48 is live.**

**CONSEQUENCE, AND IT REVERSES 13.7's FRAMING:** most of the debt measured tonight was
manufactured by a mechanism already removed in the undeployed build. PARAM 59's 5000 was measured
on the **V8.50 arm — buffer already zero** — so for the FLOOR VALUE SPECIFICALLY the AB_FLOOR_BPS
curve is the BETTER evidence and tonight's numbers are the worse one. 13.7 said the 5000 decision
predated this evidence; that is true but misleading, because this evidence is on the old build.
**RE-CONFIRM RECOMMENDATION: KEEP 5000.** Nothing measured tonight improves on the basis it was
already chosen from, and lowering the floor on V8.48 data would be tuning against a mechanism
that will not exist in V8.50.

### ⛔ WHAT TONIGHT DOES ADD, AND IT IS THE ANSWER TO RULES 1-4 TOGETHER
The AB curve measured EVICTIONS. It never measured repayment or who repays. Section 4 does, and
it is the strongest single signal of the session — **the owner's own stated exit route, confirmed
observationally with no model behind it:**

| organic members | count | have sponsored anyone |
|---|---|---|
| STILL OWING | 26 | **3 (11.5%)** |
| CLEAN | 88 | **46 (52.3%)** |

**A member who has sponsored someone is 4.5x more likely to have cleared their debt.** With
13.6's at-loan-time figures (0 directs 67.2% repayment, 1 direct 92.6%), sponsorship is the
discriminating variable and the floor is not.

### THE SHAPE THAT SATISFIES ALL FIVE RULES AT ONCE
Not a decision — the owner's — but this is what the evidence supports, and it uses his own exit
route as the qualifying condition rather than inventing a new one:

* **Keep the floor at 5000** as the outer ceiling (re-confirmed on the V8.50-arm curve, above).
* **Gate the HEADROOM ABOVE A BASE on `directCount >= 1`.** A member who has sponsored nobody
  gets a small first advance; the rest of the ceiling unlocks when they sponsor one person.
  Rule 1 keeps lending alive, rule 2 targets the population that actually repays, rule 3 refuses
  the advance that cannot be covered, rule 4's "invite 2 or 3" becomes the literal mechanism, and
  rule 5's pay-it-forward is the same counter again.
* **⚠ UNVERIFIED — THE SPLIT IS ASSOCIATION, NOT CAUSATION.** Sponsoring may mark an engaged
  member rather than cause solvency. For a GATE that is sufficient (a filter only has to
  predict), but nobody should claim recruiting makes you solvent on this data.
* **BLOCKING WORK BEFORE ANY OF IT SHIPS:** `directCount` does not exist (TierRouter:216 stores
  only `memberReferrer`), and `coPayRescue` sees only `withdrawable` and `crossingReserve`, so the
  gate needs a router read **at a call already near the block gas ceiling. Measure size and gas
  first — this has not been done and must not be promised until it is.**
* **THEN RE-MEASURE ON V8.50.** With the buffer at zero, loans are the real shortfall only, debt
  per member falls, and the floor binds differently. Every number in 13.11 should be re-run on
  the private V8.50 deploy before the floor is touched again.


---

# ⬛ SESSION 12 STATE — 2026-08-20. ⚠ 12.6 IS RE-PRICED BY SESSION 13 ABOVE — READ 13.1 FIRST.

## 12.1 ⛔⛔ "ZERO GRADUATIONS" WAS THE COUNTER, NOT THE SYSTEM. 11.4 AND 11.5 ARE CORRECTED.

**THE HEADLINE: 23 MEMBERS WITH NO REFERRAL INCOME DID PAY THE FULL $10.00 AND TOOK
ANOTHER SEAT. 22 OF THEM WENT ROUND A SECOND TIME; ONE WENT ROUND THREE TIMES. Session
11 measured 0 because it was watching an event this code path cannot emit.**

### THE DEFECT, IN THE SOURCE
`_cycleOutRoot` (MatrixLogicLib:834) hands EVERY MatB cycle-out to
`TierRouter.handleCycleOut` whenever a tierRouter is wired — which is always, in every
fixture and on live. `_crossToPartner` is the ELSE branch and **is unreachable for a MatB
root.** `_crossToPartner` is the only emitter of `MemberCrossedToPartner`.

TierRouter, when the member CAN pay, calls `_takeSeat` and emits **`MemberReentered`**;
`PairManagerV8.registerFor` -> `_enterMatrix` emits `MemberEntered` at the destination.
Neither is `MemberCrossedToPartner`.

> **SUCCESS AT THE FORWARD HOP IS SILENT ON THE EVENT SESSION 11 COUNTED. ONLY FAILURE
> (`MemberParked`) IS LOUD.** A census built on `MemberCrossedToPartner@MatB` returns 0
> forever regardless of what members can afford. It is not a measurement of affordability.

This is the traps list's own rule — *an instrument must not report the absence of what it
cannot observe* — in a new hat. Session 11 wrote that rule about v2's stranded-L1 zero and
then walked into it two sections later. Session 12's first fixture did too, until the
ledger contradicted it.

### WHAT CAUGHT IT — THE LEDGER'S OWN COMPOSITION TABLE
Not reasoning. Two columns that must be equal and were not:

| | median | min | max |
|---|---|---|---|
| LIFETIME CREDITED | $5.5916 | $4.9192 | **$19.2583** |
| HELD AT THE HOP | $5.5916 | $4.9192 | **$9.9218** |

Equal at median and min, wildly apart at max. For a member with no debt and no withdrawal
those are the same number. And `direct entry` maxed at **$1.0000** — four $0.25 entry
carves, i.e. **four matrix entries = two complete A+B cycles.** You cannot start a second
cycle without having paid the $10.00 at the end of the first. At MATRIX_SIZE 7 the same
column maxes at exactly $0.50 and nobody re-enters — the control that makes it a finding.

### THE CORRECTED CENSUS — `test/V8_50_MemberLedger.test.js` (v3, session 12)
Counted three independent ways so no single event has to be trusted: `MemberCycledOut@B`
is the denominator, `MemberParked@B` the failures, `MemberReentered@TierRouter` the
successes. They reconcile with **0 unaccounted**.

| MATRIX_SIZE 127, 762 registrations, every member `referrer = address(0)` | |
|---|---|
| MatB cycle-outs (every attempt at the hop) | **508** |
| PARKED, could not afford it | **485** — 95.47% |
| PARKED, shortfall 0 (guard / deferral) | **0** |
| **RE-ENTERED — PAID THE FULL $10.00** | **23** — 4.53% |
| unaccounted for | **0** |
| `MemberCrossedToPartner` at MatB (the old counter) | **0** |
| members who entered MatA more than once | **22** (max 3 entries by one member) |

### ⛔ AND THIS IS THE PART THAT MATTERS — IT IS A STARTUP EFFECT, AND IT DECAYS TO ZERO

| after reg | hops at the gate | re-entered |
|---|---|---|
| 275 | 21 | 3 |
| 375 | 121 | 16 |
| 400 | 146 | 22 |
| 525 | 271 | **23** |
| 750 | 496 | **23** |
| end | 508 | **23** |

**EVERY SUCCESS HAPPENED WHILE MatA WAS STILL FILLING. THE LAST 237 CONSECUTIVE HOPS
PRODUCED ZERO.** Do not quote 4.53% as a graduation rate — it is a lifetime average over a
population that stopped graduating a third of the way through the run. The steady-state
rate measured here is **0**.

Same curve session 11 already saw in the shortfalls ($9.30, $9.35, $9.40, $9.45, then
$6.66, $6.71): a member who rode MatA while it filled was paid out of 127 full $10 entries,
a steady-state member is paid out of $5.00 crossings.

### SO WHAT STANDS AND WHAT FALLS
- ❌ **FALLS: "a member who never recruits can NEVER self-fund the forward hop" (11.4), and
  "ZERO GRADUATIONS AT EVERY RATE TESTED 0-4" (11.5).** Both rest on the dead counter.
- ❌ **FALLS: "the distribution is bounded below $10.00 / nobody has ever had enough"
  (11.5).** It is not bounded. Members above the line left the sample silently.
- ✅ **STANDS, and is now measured properly: in STEADY STATE a zero-referral member does
  not self-fund the forward hop.** 237 consecutive hops, zero successes.
- ✅ **STANDS UNTOUCHED: every shortfall number.** Those come off `MemberParked`, which
  fires correctly. The ledger reconciles them against every credit ever received —
  **largest disagreement across all six subjects, at both sizes: $0.0000, to the wei.**
  Median holding $5.5916 reproduces 11.4 exactly.
- ✅ **STANDS: the closed-form gap.** pool + chain + direct = $5.536 predicted vs $5.5916
  measured.
- ⚠ **THE TWO-CYCLE GOAL IS NOT UNREACHABLE — IT IS CURRENTLY A STARTUP PRIVILEGE.** The
  owner's bar is *"at least two full cycles but not at the expense of an unpaid loan."*
  With zero referrals AND zero loans, 22 members hit exactly that, then it stopped.

### ⛔ DO NOT RE-CHASE — CLOSED BY THE SAME RUN
The ledger reconciles the withdrawable at the hop against every credit ever received, three
readings, both sizes, **$0.0000 apart**. Nothing is lost, capped, withheld or settled late.
`un-settled pool still owed` is $0.00 and `crossingReserve held at the park` is $0.00 on
every subject. **The composition table IS the bound and there is nothing else to find.**

## 12.2 ⛔ ORPHANED L1 DOES NOT GO TO accountOne. 11.4's TABLE IS WRONG ON DESTINATION.
11.4 says L1 1900 bps goes to *"the referrer — or accountOne if orphaned."* Measured off
the contract's own `OrphanFeeRouted` event, 1,420 routings totalling $1,349.00 at size 127:

| destination | share | measured |
|---|---|---|
| accountOne (a ledger credit) | 20% | $269.80 |
| community wallet, or **Stability Fund** if unset | ~40% | $539.60 |
| **dev wallet**, transferred straight out | ~40% | $539.60 |

`_routeOrphanFee` (MatrixLogicLib:1250) takes 20% for accountOne, then splits the rest by
`_getOrphanRoutingRatios` (:1305), which **adapts** 4000/4000 -> 6000/2000 or 2000/6000 to
keep the running split near even. ⚠ `_forwardToCommunityPool` is a misleading name: it
sends to the community wallet or the SF, **NOT** to the members' rotation pool.

**11.4's CONCLUSION SURVIVES — none of it returns to the member side.** But **lever C reads
very differently**: reallocating orphaned L1 takes **80% of it from the community wallet
and the dev wallet**, not 100% from accountOne. That is an owner decision, not a knob.

## 12.3 THE CONSERVATION TABLE — AND THE DOUBLE-COUNT THAT WAS IN IT
v2's "where every dollar went" listed member ledger credits AND the matrices' USDC
balances as separate rows; the second contains the first. Now two levels, and it closes
exactly. At size 127, 762 x $10.00 = $7,620.00:

| | | |
|---|---|---|
| **LEFT THE PAIR** — Treasury $1,012.46 + SF $877.56 + dev/ops $1,009.62 | **$2,899.64** | 38.05% |
| **STILL INSIDE** — member ledgers $3,625.09 + accountOne $269.80 + unspent reserves & dust $825.47 | **$4,720.36** | 61.95% |
| | **$7,620.00** | EXACT |

## 12.4 STILL THE OWNER'S DECISION — UNCHANGED, BUT BETTER PRICED
A, B and C in 11.4 are still the three options and still his call. What session 12 changes
is the framing: the question is not *"how do we make graduation possible"* — it happens.
It is **"how do we keep it happening once the fill phase is over."**

## 12.5 ⛔ NEXT, AND IT IS CHEAP — COUNT `MemberReentered` ON LIVE V8.48
Nobody has ever counted this on chain. Live T1 pair 0 MatB shows 773 rotations and 4
members reaching **T1.2** — but re-entry goes to the member's **OWN** MatA by design
(`_sameTierTarget`, TierRouter:1571: *"Re-entry ALWAYS returns to the member's own MatA"*),
so T1.2 was never the destination for a T1.1 graduate and those 4 arrived by some other
route. **The number of real members who have completed a cycle and gone round again is
unknown and is one event query away.** Get it before taking the 11.4 decision.

⚠ **SESSION 11 AND SESSION 12 MERGED TWO QUESTIONS.** "Can a member afford to leave MatB"
and "why is T1.2 empty" are different questions with different answers. 12.1 answers the
first. The second is answered by `_sameTierTarget` and is not an affordability problem.

## 12.6 ⛔⛔ LIVE CHAIN, FIRST TIME EVER COUNTED — AND IT OVERTURNS 11.4's CASE AGAINST B
`scripts/diag_forward_hop.js` (session 12), live V8.48, blocks 45430468..45739452, whole
deployment. Read-only. **Every block range read cleanly — these are counts, not bounds.**

| tier | MatB hops | parked SHORT | park-0 | RE-ENTERED | cleared | unexplained |
|---|---|---|---|---|---|---|
| T1 | 861 | 699 | 15 | **156** | **18.12%** | 5 |
| T2 | 84 | 65 | 1 | **19** | **22.62%** | 0 |
| ALL | 945 | 764 | 16 | **175** | **18.52%** | 5 |

**91 DISTINCT MEMBERS HAVE CLEARED THE FORWARD HOP ON LIVE. 40 OF THEM MORE THAN ONCE.
ONE HAS DONE IT FIVE TIMES.** The project has never had this number.

⚠ `unexplained` = a MatB cycle-out whose own tx contains neither a park nor a re-entry.
5 of 945 (0.53%). 7 `DoubleEntryFired` exist overall and are the leading candidate but
that is **UNVERIFIED** — the 5 tx hashes are printed by the script; open one, do not
assume. The cleared % is good to within that residual and no better.

### WHO PAID — AND IT IS NOT THE STABILITY FUND
Tested on `MemberDebtIncreased`, the ONLY loan signal:

| | | |
|---|---|---|
| SF LOAN in the same tx as the clearance | **0** | 0.00% |
| SF discount in the same tx | **0** | 0.00% |
| **NO SF credit — paid from their own earnings** | **175** | **100.00%** |

⚠ **THIS TESTS THE CLEARING TRANSACTION ONLY.** A loan taken earlier and carried in
`withdrawable` would not show. **53 of the 91 clearers HAVE borrowed at some point** — the
SF sits UPSTREAM (funding the A->B crossing) rather than at the forward hop. The claim is
"self-funded AT THE HOP", not "never assisted". Do not let it drift into the stronger one.

### ⛔ THE LOAN BOOK — THIS IS WHAT 11.4 GOT WRONG

| population | borrowed | repaid | ratio |
|---|---|---|---|
| whole deployment — 304 members, 459 loans, 836 repayments | $1,511.3415 | $1,447.5106 | **95.78%** |
| restricted to the 91 hop-clearers (53 ever borrowed) | $233.5810 | $205.9208 | **88.16%** |

11.4 killed option B on this reasoning: *"a cycle consumes $10 and returns ~$5.59, so
lending $4.41 means arriving at the next hop owing $4.41 AND still short. The debt is never
repaid because there is never a surplus."* **That is refuted.** It reasoned only about the
cycle that TOOK the loan. Repayment is not drawn from that cycle — it is collected
continuously out of ongoing earnings by three paths that 11.4 never accounted for:
`withdrawCore` repaying before payout, the banded clawback, and the debt sweep at MatB
cycle-out (MatrixLogicLib:838-852). 836 repayments against 459 loans: the book retires in
pieces, and it retires. **OPTION B IS NOT DEAD ON ARITHMETIC. RE-PRICE IT BEFORE CHOOSING.**

### ⚠⚠ THE CONFOUND THAT COULD MAKE ALL OF 12.6 WORTHLESS — DO NOT SKIP THIS
**The live entry flow is currently BIGFILL, funded with the owner's own USDC.** The
repayment paths are mechanically proven — that much is real and holds regardless. But the
earnings that repay the loans come from entry fees, and right now the owner is supplying
those entries. **A 95.78% repayment ratio measured on an owner-funded entry stream is not
evidence that B works against organic membership.** It is not nothing either: it proves the
COLLECTION MECHANISM works, which is exactly the thing 11.4 asserted could not.

### ⚠ WHY LIVE CLEARS 18% WHERE THE FIXTURE CLEARS 0 IN STEADY STATE
Not a contradiction. The fixture gives EVERY member `referrer = address(0)`, so it is a
true worst case with no referral income anywhere in the population, and it runs with no
Stability Fund lending at all. Live has real referrers and upstream rescue loans.
**The fixture is the FLOOR, not the forecast.** Quote it as such.

## 12.7 ⛔ NEXT SESSION, IN ORDER — DO NOT REORDER 1 AND 2
1. **SEPARATE THE BIGFILL WALLETS FROM ORGANIC MEMBERS AND RE-RUN 12.6.** Until that is
   done, every number in 12.6 is measured on a population the owner is funding. Bigfill
   wallets are identifiable (round-robin leader sponsors, lifetime withdrawn $0.00,
   reserve exactly $5.00 — see the 2026-08-16 correction). Split the table by cohort. **The
   owner's 11.4 decision should not be taken until this row exists.**
2. **OPEN ONE OF THE 5 UNEXPLAINED CYCLE-OUTS** (tx hashes in the script output). Small,
   but it is the only thing between the cleared % and an exact partition.
3. **FIX `V8_50_ReferralBreakeven.test.js` (v4) TO COUNT `MemberReentered`.** It counts the
   same dead event, so its "0 graduations at rates 0-4" measured nothing and no row from it
   is quotable. This is why the referral break-even is still unknown.
4. Then the backlog from session 10: stale-nonce retry backoff, @bevmawire's Dashboard
   retry, `maxItemsPerUpkeep` restated against 15, member-callable re-entry after eviction.

---

# ⬛ SESSION 11 STATE — 2026-08-20, ⚠ 11.4 AND 11.5 ARE PARTLY WITHDRAWN BY SESSION 12 ABOVE — READ 12.1 FIRST.

## 11.1 ⛔ CLOSED FOR GOOD: "WHY IS T1.2 EMPTY / WHERE DO NEW MEMBERS LAND?"
**DO NOT CHASE THIS AGAIN. Owner instruction 2026-08-20: verify it, write it down, stop.**

**T1.1 (pair 0) is the ONLY place a new member can land, on every tier, permanently.**
`PairManagerV8._findExternalPair()` (:760) is:

```solidity
function _findExternalPair() internal pure returns (uint256) {
    return 0;
}
```

It is `pure`. It cannot read state. **So no threshold, no counter and no configured number
anywhere in the system can change where a new registration goes.** Every registration path and
every upgrade path calls `registerFor(..., 0)`.

**THERE IS NO "MAGIC NUMBER" THAT FLIPS ROUTING TO THE NEXT PAIR, AND THERE MUST NOT BE.**
The owner's intuition on 2026-08-20 — "we get to 254 and we are full, so 255 should be the
number where the other pair starts filling" — describes a mechanism that **existed twice and
was deleted twice**, because it is the direct cause of the worst freeze this project has had:

- `pairExpansionThreshold` — deleted in V8.46 once it was proved inert.
- `deployEntryThreshold` (375) / `routeEntryThreshold` (400/381) — deleted as ROUTING inputs in
  V8.48 (items 10b and 33). Kept only as the deploy trigger, then replaced there too.

Why they had to go, in the source's own words (PairManagerV8:169-186): a cumulative counter only
ever increments, so a pair that passed the threshold was excluded from new registrations FOREVER
— even after its members cycled out and freed seats. **A full MatA only rotates when it RECEIVES
an entry (MatrixLogicLib:407.)** Exclude it and it stops rotating, and every member in seats
2..127 stops moving. `route_rr.js` was written on 2026-07-27 purely to walk the threshold around
the pairs and mask this; when that keeper was switched off on 2026-08-06, **254 members froze in
T1.1 MatA within three days.**

**Concentrating every new entry into pair 0 is the thing that keeps pair 0 rotating.** Diluting
the front door across pairs is what stops it. This is settled design, not an open question.

## 11.2 THE MEASUREMENT THAT REPLACES THE QUESTION — live V8.48, head block 45733042
`diag_pair_chain.mjs`, 2026-08-20 13:59 UTC, against the 2026-08-19 16:57 UTC run (21h apart):

| T1 | occupancy | rotations | totalJoined | parked |
|---|---|---|---|---|
| pair 0 MatA | 127/127 (=) | 599 → **924** (+325) | 364 → **387** (+23) | 26 → **45** |
| pair 0 MatB | 126 → **127** | 447 → **773** (+326) | 352 → **370** (+18) | 81 → **83** |
| pair 1 MatA | 0 → **4** | 0 | 0 → **4** | 0 |
| pair 1 MatB | 0/127 | 0 | 0 | 0 |

Chain wiring verified correct on T1 (2 pairs) and T2 (3 pairs): every MatB's `chainNext` is the
next pair's MatA and the last MatB closes the circle back to pair 0 MatA. **Not a wiring defect.**

**THE TWO NUMBERS THAT DISAGREE — THIS IS THE FINDING:**

- **T1** pair 0 MatB: **773 lifetime rotations → 4 members have EVER reached T1.2.** 83 parked in it.
- **T2** pair 0 MatB: **75 lifetime rotations → 37 members reached T2.2** (and 3 more reached T2.3).

Same code, same wiring, ~100x difference in how many graduates come out the far end. T1.2 is not
starved of a routing rule. **T1.2 is starved of members who can afford to leave T1.1 MatB.**

## 11.3 THE GATE IS A PRICE, NOT A COUNT — `MatrixLogicLib._crossToPartner`
This is the mechanism, read off the source (MatrixLogicLib:~926-980):

```solidity
address destination = (!cfg.isMatrixA && self.chainNext != address(0))
    ? self.chainNext          // from MatB  -> the NEXT pair's MatA
    : self.partner;           // from MatA  -> this pair's MatB
uint256 reentryFee  = destination.ENTRY_FEE();
uint256 crossingCost = cfg.isMatrixA ? _crossingPrice(reentryFee) : reentryFee;
```

- **MatA → MatB** costs `_crossingPrice(fee)` — the discounted crossing, pre-funded by the 50%
  crossing reserve carved at MatA entry.
- **MatB → next pair's MatA** costs the **FULL ENTRY FEE**, because it is a NEW CYCLE, not a
  crossing — and the member's crossing reserve was already spent on the A→B hop.

Funding order is `crossingReserve` first, then `withdrawable`. If `withdrawable` is short:

```solidity
self.parkedMembers.push(member);
emit MemberParked(member, shortfall);
return;
```

**So graduating forward out of MatB costs a T1 member a fresh $10 of EARNED withdrawable, with
zero reserve behind it. That is the wall. 83 of them are stacked against it in T1.1 MatB right
now, and 4 have ever cleared it.**

Corollary for V8.50 item A: item A makes the A→B hop reserve-funded and removes mid-cycle
parking, which is real — but **it does not touch this hop.** The owner already accepted that
("they only need a loan when the full A+B cycle is completed", 2026-08-16). This measurement is
what that sentence looks like on live chain.

## 11.4 ⛔ THE OPEN QUESTION — NOW ANSWERED. MEASURED 2026-08-20.
"What number makes the loop self-sustaining?" is **not** a routing number. There is no
routing number (11.1). It is this, and it has now been measured, not reasoned about:

> **What does a member with NO referral income earn across one full A+B cycle, against the
> full entry fee they must pay to graduate forward out of MatB?**

**INSTRUMENT: `test/V8_50_CycleEconomics.test.js` (written session 11).** One pair, size 127,
every member registering with `referrer = address(0)` so nobody has referral income. It
censuses EVERY cycle-out at the forward hop. Run it with:
`$env:CYCLE_SIZE=127; npx hardhat test test/V8_50_CycleEconomics.test.js`

### THE RESULT — 485 cycle-outs at the forward hop, MATRIX_SIZE 127

| | |
|---|---|
| A→B crossing price | **$5.00**, funded $5.00 from reserve + **$0.00** from earnings |
| forward hop price (MatB → next MatA) | **$10.00**, full entry fee, no reserve behind it |
| **GRADUATED forward** | ~~**0** — 0.00%~~ ⛔ **WITHDRAWN — SEE 12.1. The real figure is 23 of 508; this counted an event the MatB path cannot emit.** |
| **PARKED, could not afford it** | **485** — 100.00% |
| PARKED, shortfall 0 (seat guard / deferral) | **0** — 0.00% |

~~**ZERO OF 485.** Without referral income the forward hop does not merely cost a lot — it
**never succeeds, not once.**~~

> ⛔⛔ **WITHDRAWN 2026-08-20 BY SESSION 12 — SEE 12.1 AT THE TOP OF THIS FILE.**
> `GRADUATED forward` counted `MemberCrossedToPartner@MatB`, which a MatB cycle-out
> **cannot emit** (it goes through TierRouter, which emits `MemberReentered`). Re-counted:
> **508 hops, 485 parked, 23 RE-ENTERED having paid the full $10.00**, 22 members round
> twice, one round three times. **The claim that a no-referral member can NEVER self-fund
> the hop is false as stated.** What IS true, and is what session 12 measured: every
> success came during the fill phase and **the last 237 consecutive hops produced zero**,
> so the STEADY-STATE rate is 0. **Every SHORTFALL number below is unaffected** — those
> come off `MemberParked`, and session 12 reconciled them to the wei.

The zero-shortfall bucket being empty is what makes the affordability claim legitimate.
`MemberParked` is emitted from three places and only one means "could not afford it"; the
other two (duplicate-seat guard, `crossingInProgress` deferral) both emit shortfall 0. They
are counted separately on purpose. **All 485 were real shortfalls.** Do not merge these
buckets in any future counter — a merged count would claim an affordability result the run
did not observe.

### WHAT THE MEMBER ACTUALLY ARRIVES HOLDING
Shortfall across the 485, straight from `MemberParked(member, shortfall)`:

| | shortfall | so they arrive holding | as % of the fee |
|---|---|---|---|
| best case | **$0.0782** | $9.9218 | 99.2% |
| **median** | **$4.4084** | **$5.5916** | **55.9%** |
| worst case | **$5.0808** | $4.9192 | 49.2% |

**THE MEDIAN NO-REFERRAL MEMBER FINISHES A FULL A+B CYCLE HOLDING ~56% OF ONE ENTRY FEE AND
NEEDS 100%.** That ~44% gap is the system's own take. It is the whole answer.

⚠ **AND IT GETS WORSE AS THE SYSTEM MATURES — this is the part worth acting on.** The
earliest cycle-outs nearly made it and later ones did not. Directly observed in the first
twelve parked members, in order: $9.30, $9.35, $9.40, $9.45, then $6.66, $6.71. The reason is
structural: a member who rode MatA while it was FILLING was paid out of 127 full $10 entry
fees, while a member in steady state is paid out of $5.00 crossings. **Startup economics
flatter the model. Do not generalise any early-life number to steady state.**
`min $0.0782` deserves one look on its own: a member completed an entire A+B cycle and
missed the next step **by eight cents.**

### ⚠ TWO THINGS IN THAT RUN'S OUTPUT THAT ARE NOT RESULTS
1. **`median lifetime earnings across the sample: $6.9748` IS BIASED — DO NOT QUOTE IT.**
   The sample is the FIRST 12 parked members, i.e. the earliest and richest cycle-outs, and
   the decline above is exactly why that is not the population. THE BATCH IS NOT THE
   POPULATION — already in the traps list, walked into anyway. The trustworthy figure is the
   **median shortfall**, which is computed over all 485 and comes straight off the contract's
   own event. Fix by sampling evenly across the run, or delete the line.
2. **CLOSED, NOT A DEFECT — and the OWNER closed it, 2026-08-20.** Claude flagged the
   identical MatA/MatB `totalEarned` as an anomaly on the grounds that "MatB is funded by
   $5.00 crossings while MatA is funded by $10.00 entries, so MatB should earn half." **That
   reasoning was wrong.** The owner's correction: *"only $5 is distributed which is the
   crossing fee as well so it should be the same not half... $10 goes in but only $5 is
   distributed and $5 laced for crossing which in turn is distributed then."*

   Verified in source, `MatrixLogicLib._distributePayments` (:1121-1156) and the item A
   docblock (:193-215):
   - `payBase = cfg.entryFee` — **the FULL entry fee, in BOTH halves.** Splits are absolute
     BPS of the entry fee, never of a sub-pool.
   - MatA entry: carve 5000 reserve, then distribute `250 + 4750 = 5000` bps = **$5.00**.
   - MatB crossing entry: `skipReserveCarve = true` (no second carve), then distribute the
     same `250 + 4750 = 5000` bps = **$5.00**, which is exactly the crossing price received.
   - The docblock states the invariant plainly: *"The destination is made whole because it
     skips its own reserve carve: direct 250 + splits 4750 = 5000 = exactly this price...
     NOT ONE SPLIT BPS CHANGES."*

   **So both halves distribute $5.00 and identical per-member earnings is the CORRECT
   result.** THIRD TIME THE OWNER HAS CORRECTED A CLAUDE FINDING ON MECHANISM AND BEEN
   RIGHT. Recorded as a working pattern: when he pushes back on how the money moves, read
   the code before defending the finding.

### ⛔ THE GAP IS NOW FULLY ACCOUNTED FOR — CLOSED FORM, AND IT MATCHES THE MEASUREMENT
Because both halves distribute 5000 bps of the entry fee, **a full A+B cycle distributes the
ENTIRE $10.00.** Nothing is retained. Doubling each split across the two halves:

| destination | bps per cycle | per $10 cycle | who gets it |
|---|---|---|---|
| pool (seats 2..127) | 3136 | **$3.136** | members |
| chain pay (6 levels) | 1900 | **$1.900** | members |
| direct earn | 500 | **$0.500** | the entrant themselves |
| **L1 referral** | 1900 | **$1.900** | the referrer — **or accountOne if orphaned** |
| **system** (treasury 1426, SF 476, dev 286, ops 190, community 96, buyback 90) | 2564 | **$2.564** | not members |
| | **10000** | **$10.00** | |

A no-referral member in a uniform population collects pool + chain + their own direct =
**$5.536 per cycle.** **MEASURED MEDIAN HOLDING AT THE HOP: $5.5916.** The structure and the
census agree to within six cents. The gap is therefore exactly the two leaks:

> **$2.564 system take + $1.900 orphaned L1 = $4.464 short.**
> **MEASURED MEDIAN SHORTFALL: $4.4084.** Same number.

**THE DECISIVE CONSEQUENCE — this is conservation of money, not a tuning problem:**
since a cycle distributes exactly 100% of the fee, a zero-referral member can only reach
100% if BOTH leaks go to zero. **So long as the protocol takes ANY fee at all, a member who
never recruits can NEVER self-fund the forward hop.** No split table, no loan ceiling and no
threshold changes that. It is arithmetic.

### ⚠ AND THE REFERRAL BAR IS LOWER THAN FIRST STATED — L1 PAYS IN BOTH HALVES
Claude first put break-even at ~4.6 invitees by counting L1 once at 950 bps. **Wrong for the
same reason as the "half" error above:** L1 is paid in BOTH halves, so a referrer earns
**1900 bps = $1.90 per invitee per invitee-cycle**, not $0.95.

`$4.464 / $1.90` ≈ **2.35 invitees per cycle.** ⚠ UNVERIFIED — arithmetic over measured
numbers, and it EXCLUDES chain pay from a growing downline, which pushes the true bar LOWER.
Measure it, do not quote it.

⚠ **AND IT IS A RATE, NOT A TOTAL.** ~2.35 invitees *per cycle the member takes*, not 2.35
ever. Recruit once and you fund one cycle. Whatever is said to members must not blur that.

### ⚠ ITEM A IS ALREADY IN THIS TREE, AND IT DOES NOT FIX THIS HOP
The fixture ran against the V8.50 source, so **item A was in force** — confirmed by its own
output: the A→B hop cost $5.00 funded **100% from reserve, $0.00 from earnings**. Item A
works exactly as designed and kills mid-cycle parking at the A→B crossing. **It still ends
0 for 485 at the forward hop.** Item A was never aimed here; do not let a future session
report it as the fix for the graduation chain. LIVE V8.48 does not have item A at all.

### THE DECISION THIS PUTS IN FRONT OF THE OWNER — HIS CALL, NOT CLAUDE'S
The gap is real, measured, and closes only three ways:
- **A. Accept it.** Matches his standing framing: "members are EXPECTED to take loans and be
  evicted if they never invite anyone." The cost is that T1.2 fills at ~0 without referrals,
  and the parked queue is the product for anyone who does not invite.
- **B. Lend it.** The SF covers the ~44%. Bounded by `insolvencyFloorBps` (PARAM 59, now
  5000). Note the live T1 loan ceiling is **$3.40** and the median shortfall is **$4.41** —
  **the current ceiling cannot cover the median member.** That is a new, concrete fact.
- **C. Change the splits** so one A+B cycle pays for the next entry. Structural, needs
  modelling against the live population before any contract code is written.

**DO NOT DECIDE THIS FROM THE CODE. It is an economic and product trade-off.**

---

## 11.5 THE REFERRAL BREAK-EVEN SWEEP — INSTRUMENT BUILT, ANSWER NOT YET TAKEN
**File: `test/V8_50_ReferralBreakeven.test.js`. THREE VERSIONS, THREE DIFFERENT FAULTS. The
current file is v4 and has NOT yet produced a trustworthy row. Do not quote any number from
sessions 11's runs of it.**

The question: the 11.4 census proves a ZERO-referral member never graduates. How many
invitees per cycle does it take before they do? That number is what goes to members.

| version | what it did | why it was wrong |
|---|---|---|
| v1 | R-ary referral tree over the whole population | Later invitees joined AFTER their referrer had crossed to MatB, so their L1 landed in a MatA the referrer had left. R=2,3,5 came back **identical to R=0 to the cent**; only R=1 differed, because in a chain the invitee always arrives before the referrer leaves. The harness conflated referral RATE with referral TIMING. |
| v2 | interleaved — each subject's invitees registered immediately after them | Fixed the timing, but then **reported "stranded L1 = zero" as a finding.** It is zero BY CONSTRUCTION: no invitee CAN arrive late in this design. An instrument must not report the absence of what it cannot observe. Also fixed-budget starved the high rates — R=5 had TWO subject hops and duly broke the trend. |
| v3 | budget scaled with R to even out subject counts | **Traded a small-sample problem for a far worse confound.** Shortfall grows with system maturity (11.4), so scaling the budget measured each rate at a different point in the system's life. Result was flatly non-monotonic with 100+ hops per row: R=0 $3.2390, R=1 $2.5096, R=2 $0.6472, **R=3 $3.3812 (worse than R=0)**, R=4 $1.6212. Two effects fighting inside one column. |
| **v4 (current)** | **budget FIXED across all rates**; L1 split into @entry vs @crossing; thin rows labelled | **NOT YET RUN.** |

### WHAT IS NEVERTHELESS ESTABLISHED FROM THOSE RUNS
- ✅ **CONTROL REPRODUCES EVERY TIME.** R=0 graduated 0 of 105 at size 127 and 0 of 28 at
  size 7, matching 11.4's 0 of 485. The baseline is solid.
- ✅ **EACH INVITEE IS WORTH EXACTLY $1.90** — 950 bps at the invitee's MatA entry plus 950
  bps again when that invitee crosses to MatB. Seen cleanly in the size-7 v2 run:
  $5.128 → $3.228 → $1.328 as invitees went 0 → 1 → 2. **L1 pays in BOTH halves;** counting
  it once at $0.95 was Claude's error and doubled the apparent referral bar.
- ✅ **AN INVITEE'S SECOND $0.95 ARRIVES MUCH LATER** — only when that invitee themselves
  crosses. A referrer who reaches the forward hop early collects only the first half of
  their newest invitees. The size-7 third invitee was worth $0.95, not $1.90, for exactly
  this reason. v4 splits the two buckets so this is visible, not inferred.
- ✅ **STRANDED L1 IS REAL — CONFIRMED, AND SMALL.** v3 measured it NON-ZERO even under
  interleaving: $9.50 / $13.30 / $15.20 / $16.15 at R=1..4, against ~$2,500 of L1 paid.
  **~0.6%.** Real behaviour, not a rounding artefact, but far too small to explain anything
  in 11.4. Do not promote it to a headline.
- ⛔ ~~**ZERO GRADUATIONS AT EVERY RATE TESTED, 0 THROUGH 4** — 1,120 subject hops and 2,495
  invitee hops, not one forward crossing.~~ **WITHDRAWN BY SESSION 12 — SEE 12.1.** Same
  dead counter. The rates were never measured on an instrument that could observe success,
  so the referral sweep must be re-run with `MemberReentered` counted before ANY row from
  it is quoted. v4 still needs this fix.

### ~~⛔ THE OPEN ANOMALY — NOBODY EVER REACHES THE FEE, EVEN WHEN CLOSE~~
### ⛔ CLOSED 2026-08-20 BY SESSION 12 — THERE WAS NO ANOMALY. SEE 12.1.
**They DO reach the fee. 23 of them did.** The distribution is not bounded below $10.00;
members above the line left the sample silently because success emits no event this census
watched. Everything below is the record of chasing a counter defect as if it were an
economic property — kept because the two ruled-out causes below are still correctly ruled
out, and because the reasoning is the record of how it went wrong. **Do not act on it.**
At R=2 the median parked subject was $0.6472 short, and the 11.4 census found a minimum
shortfall of **$0.0782**. Members get to within eight cents and stop. Across thousands of
hops the distribution never crosses $10.00. A graduating member would leave the shortfall
sample and appear in FORWARD, and FORWARD is 0 everywhere — **so this is not a sampling
artefact, nobody has ever had enough.**

**TWO CANDIDATE CAUSES ALREADY RULED OUT — do not re-chase these:**
- ❌ *Lazy pool settlement leaving earned-but-uncredited money out of the affordability
  check.* **REFUTED:** `_cycleOutRoot` calls `_settlePool(self, cfg, root)` at
  MatrixLogicLib:805, BEFORE the crossing logic at :900+. The pool is settled first.
- ❌ *An earnings or payout cap.* **REFUTED:** no cap exists in MatrixLogicLib; `_settlePool`
  computes an exact rational share `(k*dA1 - dAr) / W` with no ceiling.

**STILL OPEN.** Next session: take ONE parked member at the hop and account for their
withdrawable to the cent against every credit they ever received — pool, chain, direct, L1,
carried balance — and find what the distribution is bounded by. Do not reason about it.

### HOW TO RUN v4
```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:CYCLE_SIZE=127
npx hardhat test test/V8_50_ReferralBreakeven.test.js
Remove-Item Env:\CYCLE_SIZE
```
~17 minutes at size 127. Dials: `CYCLE_REFS` (default `0,1,2,3,4`), `CYCLE_BUDGET`
(default 6 x SIZE — **fixed across rates on purpose**), `CYCLE_MIN_HOPS` (default 10).

⚠ **NOTHING WAS DEPLOYED AND NO CONTRACT FILE WAS TOUCHED IN SESSION 11.** Two new test
files only: `V8_50_CycleEconomics.test.js` and `V8_50_ReferralBreakeven.test.js`. The owner
stated 2026-08-20: *"we are not changing code yet just discussing until we come to a
conclusion."* Honour that — the decision in 11.4 is his and is still open.

---

# ⬛ SESSION 10 STATE — 2026-08-19/20, LATEST. READ THIS FIRST, BEFORE SESSION 9.

**THE HEADLINE: THE PARKED-MEMBER BADGE WAS REACHING NOBODY — 0 OF 107 PARKED MEMBERS COULD
SEE IT — AND ITS V8.48 FALLBACK DISAGREED WITH THE CONTRACT ON TWO OF FIVE CASES. Both fixed,
both shipped ALL THE WAY TO MAIN (owner decision). The bug-report form's advertised-but-missing
fields are fixed and it now takes screenshots. Nothing was deployed, no chain was written to,
`.env` line 69 is unchanged, NO CONTRACT OR TEST FILE WAS TOUCHED, and the suite is untouched
at 611 passing / 7 pending / 0 failing (not re-run — nothing it covers moved).**

| repo | branch | at session end |
|---|---|---|
| `C:\CryptoNite-Smart-Contracts\CryptoNova` | `v8.1` | **`917b105`** — two new instruments + the session-10 docs |
| `C:\CryptoNova-Testnet-App` | `admin` = `preview` = `main` | **`74a1588`** — badge fix + bug form. **THE LADDER IS LEVEL; members have everything.** |

---

## 1. ⛔ THE BADGE WAS INVISIBLE. 107 OF 107 PARKED MEMBERS COULD NOT SEE IT.

`renderParkedList()` opened with `if (cands.length < 2) { box.style.display='none'; return; }`.
Measured on live V8.48 with the new `scripts/diag_badge_preview.js`:

| | |
|---|---|
| parked positions | 107 |
| distinct parked members | **107** |
| members holding 2+ positions (badge RENDERS) | **0** |
| members holding exactly 1 (badge HIDDEN) | **107** |
| **share of parked members who could see the feature** | **0.0%** |
| of those positions, gap a loan CANNOT cover | 37 |

The whole of session 9's badge work reached nobody, while 37 members sat on an uncoverable gap.

**THE GATE'S REASONING WAS HALF RIGHT AND THAT IS WHY IT SURVIVED.** "One position is the
existing card's job" is TRUE OF THE ACTION — the single-position card's Self Rescue and Copay
buttons work fine. It was NEVER TRUE OF THE STATUS: that card renders label, withdrawable,
reserve, fee and shortfall, and says nothing about the eviction clock or whether the fund can
cover the gap. Verified by reading the card's own render path (`index.html` ~5752-5807).

**FIXED:** the list now renders STATUS-ONLY for a single position — badge and clock line, no
per-row buttons, no bulk bar, no header — and does NOT hide the card's own buttons the way the
multi-row path does. It reuses `_evictInfo` rather than forming a second verdict.

⚠ **COST STATED SO IT IS NOT DISCOVERED LATER:** single-position members now also pay the
status reads, ~5 extra `eth_call`s per dashboard load. The wallet-balance read was moved BELOW
the status-only return so it is not paid by members who never see a button. If it ever needs
cutting, cache the two chain-wide reads (grace period, SF balance) across the page — those are
the part that does NOT differ per member.

---

## 2. ⛔ THE V8.48 HEADROOM FALLBACK DID NOT MATCH `loanHeadroom`. IT INVERTED THE VERDICT.

`StabilityFund.sol:956-964` has **THREE** outcomes. The shipped fallback implemented **one**:

| condition | contract returns | old fallback computed |
|---|---|---|
| `insolvencyFloorBps == 0` | `type(uint256).max` — **unlimited** | `fee * 0 / 10000` = **0** |
| `tierEntryFees[t] == 0` | `type(uint256).max` — **unlimited** | **0** |
| otherwise | `fee*bps/10000 - debt` | same ✅ |

A zero ceiling reads as zero headroom, which renders **PENDING EVICTION on every parked row** —
the exact INVERSE of the truth, and it fires at the moment PARAM 59 is set to 0, which is the
documented ESCAPE HATCH for disabling the floor. **Measured, not argued:** old and new run
against the contract's own logic, **old disagreed on 2 of 5 cases**. It was right on live only
because the chain happens to read 3400 and a $10.00 fee — right by luck, not by construction.
This is the "two models of one rule, drifting" failure `StabilityFund.sol:938` names by hand.

**ALSO FIXED IN THE SAME BLOCK:**
- **The clock fallback no longer fires on a FAILED read.** `evictionGracePeriod` (V8.49+) and
  `extendedIdleTimeout` (V8.48) are SEPARATE DIALS — `MatrixKeeper.sol:1066` says in terms
  "Do NOT re-point this at extendedIdleTimeout to keep them in step." On V8.48 both are 604800
  so substituting is correct THERE; the substitution used to happen on ANY failure of the first
  call, so on a V8.49+ chain one transient RPC hiccup would silently render a countdown from the
  IDLE-SLOT RECLAIM clock and look healthy doing it. Now gated on the chain reporting the
  function ABSENT (empty return / missing revert data), never on a read that merely failed.
- **The three derivation reads are no longer `Promise.all`.** That all-or-nothing shape is
  exactly what made `diag_eviction_clock.js` report 107 of 107 unknown; that script was rebuilt
  for it in session 9 and `index.html` still carried the original. Read separately, an
  unreadable `memberDebt` leaves the ceiling standing as an UPPER BOUND — so "a loan cannot
  cover this" stays sound while "you are fine" correctly downgrades to CHECKING.
- **A `Symbol` sentinel now carries "unlimited",** and it is caught BEFORE any `<` comparison.
  JavaScript throws a TypeError on `Symbol < BigInt`, which would have taken the whole parked
  list down rather than mislabelling one row.

✅ **REFUTED, SO NOBODY RE-RAISES IT:** the badge does NOT consult `loanEligible`, which exists
on V8.48 — and it does not need to. `StabilityFund.sol:988` is literally
`loanHeadroom(member, tierIdx) > 0`. It carries nothing the badge does not already have.
Separately, `loanEligibleFor` IS the enforcement rule (`advance <= loanHeadroom`), and the
badge's `headroom < shortfall` test is that rule reproduced correctly.

---

## 3. ⛔ A HANDOFF CORRECTION — SESSION 9 CREDITED AN INSTRUMENT WITH A RESULT IT NEVER PRODUCED

Session 9 records "`probe_sf_views.js` found `loanHeadroom` AND `evictionGracePeriod` are the
two absent ones". **It cannot have.** Its case list has ten entries and `evictionGracePeriod`
is not one of them — it probes the **StabilityFund**, and `evictionGracePeriod` is declared on
**MatrixKeeper** (`MatrixKeeper.sol:372`). The claim was read off the SOURCE TREE and attributed
to an instrument that never asked the question, so the keeper half of the badge's fallback had
**never been measured against the deployed keeper**.

**THIS IS THE SESSION 9 TRAP ONE LEVEL UP: an instrument must not report the absence of what it
cannot observe — AND A HANDOFF MUST NOT REPORT WHAT THE INSTRUMENT NEVER ASKED.**
(To session 9's credit, `diag_eviction_clock.js:66-76` records the SF probe results correctly
and in full. The sloppiness was only in the summary.)

Now measured, `scripts/probe_keeper_views.js`, live V8.48 keeper `0x9Ade59F9` (20,211 bytes),
**4 of 4 controls green so these are statements about the ABI and not the network**:

| view | verdict | value | note |
|---|---|---|---|
| `idleSlotTimeout()` | EXISTS [ctrl] | 259200 | |
| `maxItemsPerUpkeep()` | EXISTS [ctrl] | **15** | ⛔ source default is 20 |
| `stabilityFund()` | EXISTS [ctrl] | `0xeb36ee74…` | matches the addresses file |
| `tierRouter()` | EXISTS [ctrl] | `0xD78eD884…` | |
| `evictionGracePeriod()` | **ABSENT** | — | V8.49+; badge takes its fallback |
| `extendedIdleTimeout()` | EXISTS | 604800 | the fallback answers |
| `parkedGracePeriod()` | EXISTS | **86400** | ⚠ source default is 6 hours |
| `minGasPerItem()` | **ABSENT** | — | ⛔ not on live at all |

SF probe re-run the same minute: `insolvencyFloorBps` **3400**, `tierEntryFees(0)` **$10.00**,
`memberDebt` and `memberDebtOf` both present, `loanEligible` true, `loanHeadroom` and
`loanEligibleFor` ABSENT, `totalBalance` $486.66, `totalRescueLoaned` $1,375.43. **Live T1
ceiling = $3.40**, exactly as predicted.

### ⛔ TWO BACKLOG ITEMS ARE STATED AGAINST THE WRONG NUMBER — FIX THE ITEMS, NOT THE CHAIN
1. **"`maxItemsPerUpkeep` is still vestigial at 20"** describes the SOURCE default. **The live
   chain runs 15.** Restate the item against the real number before deciding whether to lower
   it to 10. There is a `scripts/set_max_items.js`, so it was set deliberately at some point.
2. **`minGasPerItem` DOES NOT EXIST ON LIVE V8.48.** The measured 5M owner decision is a
   V8.49+/V8.50 property and is **NOT in force on the community chain** — consistent with the
   live keeper scripts still carrying `GAS_PER_ITEM_DEFAULT = 3_500_000`, which the guardrails
   say was left alone deliberately. Do not quote 5M as a live figure.
3. Minor, same class: `parkedGracePeriod` is 86400 on live against `6 hours` in source.

---

## 4. ✅ THE PARKED POPULATION MOVES ON A SCALE OF SECONDS — SO MOST OF ITS NUMBERS ARE SNAPSHOTS

`diag_badge_preview.js` first reported 37 uncoverable of 107; `diag_eviction_clock.js`, run
3m40s later, reported 41 of 108. Two instruments, one population, different answers — treated as
the finding rather than averaged.

**On every member both instruments list, they agree TO THE CENT** — gap, headroom and verdict
(`0xAdf9C692CB` $1.36/$0.00, `0xA9B019e7` $4.39/$3.40, `0x396DFA14` $5.00/$2.90, `0x7e323C4d`
$5.00/$2.96). So the rules are the same rule.

**PROVED WITH ONE INSTRUMENT INSTEAD OF TWO:** `diag_badge_preview.js` run twice, **20 seconds
apart, scanned 109 then 110 positions.** Population drift is demonstrated outright; no
cross-instrument comparison was ever needed.

⚠ **AND A SECOND RESULT FELL OUT OF IT.** Across four readings the counts went
**37/107, 41/108, 40/109, 40/110** — the uncoverable count moves MORE SLOWLY than the
population. That is what you would expect if **new parkers arrive rescuable** and the
uncoverable set is the accumulated hard cases. Consistent with the 20-second pair, where the
population moved and the uncoverable count did not.

⛔ **THEREFORE: `44 -> 41 -> 37` IS NOT A TREND.** It is snapshots of a population being churned
by bigfill. Any parked-population figure taken while the loop runs is a snapshot with a
timestamp, not a measurement of a stable quantity. **To compare the two instruments honestly,
stop the bigfill loop first, or compare only the PER-MEMBER rows** — that check has no drift in
it. Written into `diag_badge_preview.js`'s own output so it is not rediscovered.

⚠ **AND THE DIRECTION IS WORTH WATCHING:** across this session the SF climbed
**$486.66 -> $507.13 -> $517.20 -> $529.20** while the parked queue grew **107 -> 110**.
**Parking is currently outrunning rescue even as the fund recovers.** Neither number alone says
that; both together do.

---

## 5. ✅ BUG-REPORT FORM — @bevmawire WAS RIGHT AND THE BUG WAS THE WORDING

Reported 2026-08-19: *"Additional notes (optional) tab does not seem to be giving access to
'Steps to reproduce, screenshot filename, error message'... it does not seem to have facility
for uploading screenshots either."*

There was **one** free-text box whose PLACEHOLDER listed three things, so it read as a section
that should open up three fields. It never had them. **A form must not advertise what it cannot
accept.** Fixed by giving him the fields it promised rather than deleting the promise.

- **Steps to reproduce** — new optional textarea, threaded form -> `/api/submit-bug` ->
  `BUGS.md`, rendered as a fenced block (multi-line by nature; a newline on the bullet line
  breaks the markdown list). **Optional server-side on purpose:** a cached `bug-report.html`
  keeps not sending it, and output for an old client is byte-identical to before.
- **Screenshot upload** (owner decision: *"build it in the repo, keep it simple, if anything in
  the future could be an issue we revert"*). Downscaled IN THE BROWSER to ~1200px JPEG q0.82
  (~200-400KB) because a phone screenshot is 2-5MB and Vercel caps a serverless body at 4.5MB.
  Committed to `bug-screenshots/` through the same GitHub Contents API the reports already use,
  and **linked, not embedded** — `![](...)` would render every screenshot full-size inline and
  make `BUGS.md` unscrollable within a dozen reports.
- ⛔ **THE REPORT SURVIVES A FAILED UPLOAD.** The image is written BEFORE `BUGS.md` is touched
  and that path never throws; any failure becomes a `screenshotError` and the report is filed
  anyway **with a line saying a screenshot was attached and did not upload**. Worst case is an
  orphaned image, which is cheap and obvious. The other order loses reports.
- **iPhone HEIC is handled out loud** — most browsers will not decode it into a canvas, so the
  picker says so and says what to do, rather than failing silently.
- `resetForm()` clears steps, the file input, the status line and the in-memory base64 —
  without it the NEXT report from the same page load carries the PREVIOUS member's screenshot.

✅ **VERIFIED END TO END 2026-08-20**, owner filed a real report from a real browser:
`bug-screenshots/2026-08-20T01-54-38-741Z-bugtest.jpg` — a valid JPEG (magic `ff d8 ff e0`),
**50,123 bytes**, so the client-side downscale worked. `BUGS.md` carries the fenced
**Steps to reproduce** block and a resolving **Screenshot:** link, inserted at the top of Open
Issues. **And the commit order is right: `97e2d6e` (image) lands BEFORE `4e038ef` (report)**,
which is the ordering that keeps a report alive when an upload fails.

⚠ **AND THE UNDERLYING COMPLAINT IS NOT CLOSED.** @bevmawire's actual problem was "Couldn't
find your status" on the Dashboard at **13:50 GMT**; the Base Sepolia state-read outage ran
**15:54-16:39**. **His report PREDATES the outage and has a different cause.** The likeliest
candidate is the `LOGS_DEPLOY_FLOOR` load problem now shipped at `9d0940f`. **Ask him to retry
— do not assume it is fixed.** (Session 9's commit `1aa9ce8` had already spotted this class.)

---

## 6. BIGFILL — ALIVE, AND THE OFFSET QUESTION IS CLOSED

Three runs all logged `HDR_OFFSET=289` and the second registered **0 of 1**, its own NEXT RUN
HINT saying the wallet was already registered. Not a loop defect: **the owner restarted the loop
three times, each with `-StartOffset 289`** (confirmed by him and by the process list — PID 2836
started 18:58:37 with `-StartOffset 289`, which is run 3's own timestamp). Left alone the loop
does its own `$offset++` and the next log should be named `...offset290.log`.

⚠ Worth keeping: those three runs registered **nobody** and the fund still climbed. That
isolates the sweep-only inflow by accident and is the cleanest evidence yet that **the SWEEPS,
not the registrations, feed the fund** — which is what `BIGFILL_RULES.md` already says. Not a
designed experiment; do not quote a rate from it.

---

## 7. ⛔ BIGFILL — TWO FIXES, ONE COSMETIC AND ONE THAT WAS HIDING A BROKEN SWEEP

### 7a. "T1 total registered" WAS A PEOPLE LABEL ON AN ENTRY COUNTER
Owner spotted it: the snapshot printed **895** while the site's Live Stats read **370** all-time
joins. Both numbers were correct; the LABEL was wrong. `PairManagerV8.sol:86` says so itself —
`totalRegistrations` "increments on EVERY routing — register, rescue re-entry, MatB placement,
doubles — so it is an ENTRY counter". With 597 system cycles the same people are routed over and
over, so it climbs far past the headcount and reads like runaway growth.
**This has bitten the codebase twice before**, which is why V8.48 item 7 added `uniqueMembers`:
the treasury's early-exit penalty ladder was reading 0, and Universe Mode's 500-MEMBER gate would
have opened on entry CHURN (~12 real members' worth of re-entries). The snapshot now prints both,
each named for what it counts. The `uniqueMembers` read is GUARDED — `pm1` is the local V8.50 ABI
pointed at a live V8.48 chain — and prints "unavailable", never 0, if it fails.

### 7b. ⛔ STALE-NONCE FAILURES WERE COUNTED AS MEMBER REFUSALS — HH110 IN A NEW HAT
A post-registration sweep logged `nonce too low` on **16 of 16** wallets and printed
**"Self-rescues: 0 succeeded - 16 skipped"**. Those members were never asked. Worse than the
original HH110 case, because the `else` branch also does `consecutiveTransport = 0`, so **every
stale-nonce failure RESET the 5-in-a-row abort guard** — the sweep could fail indefinitely
without tripping it, and `run_bigfill_loop.ps1` (which only looked for `NETWORK FAILURES`) judged
the run GOOD and advanced the offset.

**CAUSE, BY ELIMINATION RATHER THAN ASSUMPTION:** member wallets are plain
`w.connect(ethers.provider)` with **no NonceManager** (deliberate — see the funder comment), so
ethers fetches the count itself at send time; a process check found **exactly one** bigfill
running, ruling out a concurrent sweep; and each wallet was behind by roughly the number of
transactions it had already sent earlier in that same run. That is a load-balanced RPC answering
`getTransactionCount` from a replica that had not caught up — the same lag this file already
sleeps 90s for after funding, and the same class as session 9's stale top-up read.

**FIXED:** stale-nonce errors are classified separately, **retried once with an explicitly
re-fetched nonce**, counted in their own bucket, reported in the summary as
`STALE-NONCE FAILURES ... treat this sweep as INCOMPLETE`, and they no longer reset the transport
counter. `run_bigfill_loop.ps1` now treats that marker as a bad run, so two in a row stop the
loop. ⚠ **The loop change only takes effect when the LOOP restarts** (PowerShell has already read
the script); the bigfill change lands on the next run, since node re-reads it each time.

✅ **7a CONFIRMED AGAINST LIVE 2026-08-20**: the next snapshot read `T1 unique members: 370`
(exactly the site's Total Registered) against `T1 entries (all routings): 904`. That also settles
the guarded question — **`uniqueMembers` DOES exist on the deployed V8.48**, measured not assumed.
⚠ **7b IS NOT CONFIRMED.** That run's sweep was clean (18 succeeded) and printed no
`(recovered - stale nonce, resent at N)` line, so **the retry path was never exercised**. A quiet
run is not a passing test. Its first real test is the next time the RPC lags.

### 7c. THE SNAPSHOT WAS PRINTING AN **ARCHIVED** PAIR AS BARE "T1"
Same run's header: `T1 factory: 2 pairs. T1.1 archived (127/127). Active: T1.2`. **T1.1 has
filled both halves and the factory has moved on** — which is exactly what session 9 predicted
would happen via `chainNext` and asked the next session to verify. It happened.
But `matA1`/`matB1` are bound ONCE from the addresses file, so they are pair 0 forever, and the
snapshot was printing `T1 MatA occupancy: 127 / 127` with no pair name. **That number is now
frozen at full permanently** and will keep reading healthy while the pair actually taking entries
fills unwatched. Session 9 logged this as cosmetic; it stopped being cosmetic the moment the pair
archived. Fixed by NAMING the pair and printing the active one beside it — `matA1`/`matB1` were
deliberately NOT re-pointed, because 28 other sites use them.
⚠ **T2 has the same latent shape** — one pair today, so it has not bitten yet.
⚠ **STILL TO WATCH: does T1.2's MatA actually start filling?** That is the confirmation of
session 9's chainNext prediction, and it needs a few runs of observation.

### 7d. REGISTRATION NONCE COLLISIONS WERE "GENUINE FAILURES" AND THE LOOP WALKED PAST THEM
A later run failed registration with `replacement transaction underpriced` — a transaction with
that nonce already in the mempool, i.e. **the wallet was never asked**. It was counted under a
heading that literally read `Genuine failures`, and because the loop only greps for its own abort
markers, the run was judged GOOD and **the offset advanced over a wallet that never registered**.
Unattended overnight that quietly scatters gaps through the wallet range.
**FIXED:** registration failures are split into genuine on-chain reverts and nonce/transport
failures; the latter emit the same `STALE-NONCE FAILURES` marker the loop treats as a bad run, so
the offset holds. **THIS IS THE THIRD INSTANCE OF ONE MISTAKE IN ONE EVENING** — 7a, 7b and 7d are
all an infrastructure condition presented as a statement about members or about the chain's
answer.

### 7e. ⛔ OVERNIGHT RESULT 2026-08-19/20 — 15 RUNS, OFFSETS 294 -> 309, LOOP STILL ALIVE

✅ **THE CLASSIFIER AND THE LOOP HOLD ARE PROVEN IN PRODUCTION, NOT JUST IN THEORY.** The 00:58
run hit **24 STALE-NONCE FAILURES** in its post-registration sweep, `run_bigfill_loop.ps1` judged
the run BAD, **held the offset at 297 and re-ran it** — the log directory shows `offset297` twice,
which is the mechanism working. Before last night that run would have been judged GOOD, the
offset would have advanced, and 24 members would have been recorded as having declined.

⛔ **BUT THE RETRY DOES NOT WORK, AND THE SAME RUN PROVES IT: 24 of 24 RETRIES FAILED.**
`Self-rescues: 0 succeeded - 1 skipped - ! 24 STALE-NONCE FAILURES`. A 3-second sleep and one
re-fetch is not enough for the replica lag. **The ACCOUNTING is right and the RECOVERY is not** —
do not read 7b as closed. Note the shape, which repeats: the PRE-run sweep in that same run
succeeded 24/24 and the POST-registration sweep failed 24/24. The lag appears only after those
wallets have just transacted, which is consistent with a load-balanced replica and points at a
longer backoff (or several attempts with growing gaps) rather than a different mechanism.

⛔ **AND THE OPEN QUESTION THE NIGHT PRODUCED — TWO NUMBERS THAT DISAGREE:**

| | 00:58 | 09:33 |
|---|---|---|
| `T1 unique members` | 374 | **386** |
| `T1 ACTIVE pair: T1.2 MatA` | 4 / 127 | **4 / 127** |

**SIXTEEN NEW MEMBERS JOINED OVERNIGHT AND THE ACTIVE PAIR DID NOT MOVE.** T1.1 is archived and
full on both halves; T1.2's MatA has sat at 4/127 for nine hours across ~13 runs while
`T1 entries (all routings)` climbed 1000 -> 1079. **This is exactly session 9's "if T1.2 stays
empty, chase it" condition.** Where new registrations are actually landing is now the clearest
open question in the system, and the pair labelling added in 7c is what made it visible at all.
⚠ Do not theorise the mechanism — measure where a registration lands. `diag_pair_chain.mjs`
(frontend repo) reports every tier's pairs with occupancy, rotations, parked and `chainNext`.

✅ Fund: **$555 -> $1,041.60 overnight**, nearly doubled, on ~15 runs of sweeps.

---

## TRAPS ADDED THIS SESSION

- **A HANDOFF MUST NOT REPORT WHAT THE INSTRUMENT NEVER ASKED.** Session 9's summary credited
  `probe_sf_views.js` with an `evictionGracePeriod` verdict it has no case for. The detailed
  write-up in `diag_eviction_clock.js` was correct; the SUMMARY drifted. **When a handoff
  attributes a result to a named script, the cheapest possible check is to open the script and
  look for the case.** It took one grep and it was wrong.
- **A FALLBACK MUST REPRODUCE THE WHOLE DEFINITION, NOT THE ARITHMETIC.** `loanHeadroom` has two
  early returns before its formula and the frontend copy had neither, which inverted the verdict
  in exactly the configuration an operator would reach for in an emergency.
- **"THE FUNCTION IS ABSENT" AND "THE READ FAILED" ARE DIFFERENT ANSWERS.** Any fallback gated
  on a bare `catch` will substitute during an outage. Gate on the error SHAPE.
- **A FEATURE THAT RENDERS FOR NOBODY STILL PASSES EVERY CODE REVIEW.** The badge was correct,
  tested, committed — and gated behind a condition no live member satisfied. **Before shipping a
  conditional feature, measure how many real users meet the condition.**
- **A POPULATION THAT MOVES IN SECONDS CANNOT BE CROSS-CHECKED BY TWO SCRIPTS RUN MINUTES
  APART.** Compare per-member rows, or stop the thing that is changing it.
- **`Symbol < BigInt` THROWS IN JAVASCRIPT.** A sentinel added to a value that is later compared
  with `<` must be caught before the comparison or it takes out the whole render.
- **A NEW FORM FIELD NEEDS THREE EDITS, NOT ONE:** the input, the payload, and `resetForm`.
  Missing the third silently carries one member's data into the next member's report.
- **"INFRASTRUCTURE FAILURE DRESSED AS MEMBER BEHAVIOUR" IS THIS PROJECT'S RECURRING BUG.**
  Four instances now: `HH110` counted as refusals (session 9), stale nonces counted as `skipped`,
  nonce collisions counted as `Genuine failures`, and an entry counter labelled as people. The
  question to ask of EVERY counter: *if the chain never answered, which bucket does this land in,
  and does that bucket's NAME claim something the run did not observe?*
- **A QUIET RUN IS NOT A PASSING TEST.** The stale-nonce retry shipped and the next sweep was
  clean — but it printed no recovery line, so the retry never ran. Confirm a fix by observing the
  fix's own output, not by the absence of the symptom.
- **"COSMETIC" HAS A SHELF LIFE.** The snapshot printing pair 0 as bare "T1" was harmless for
  weeks and became actively misleading the hour T1.1 archived. A label that is merely ambiguous
  today is a wrong answer waiting for a state change.
- **`git commit` CAN FAIL ON A STALE `.git/index.lock` FROM A CRASHED EARLIER PROCESS.** Check
  `Get-Process git` FIRST — if none is running the lock is debris and its `CreationTime` tells
  you which session left it. (One was found here dated 18:49:54, from session 9.)

---

## STATE OF THE TREE

**Contracts (`v8.1`, `917b105`, pushed):** `scripts/probe_keeper_views.js` and
`scripts/diag_badge_preview.js`, both NEW, both ASCII-only with no BOM, both `node --check`
clean. **No contract file, no test file, no `.env` change.** Suite untouched at 611/7/0.
⚠ Still untracked and unexplained: `scripts/bigfill_v8.js.bak_ascii`, `test_ab/replay.js.bak_s9b`,
`test_ab/replay.js.bak_s9c` — session 9 leftovers. House pattern is to move strays into
`archive/`, not delete them.

**Frontend (`admin` = `preview` = `main`, `74a1588`, pushed):** `index.html` (badge visibility +
headroom + clock gating), `bug-report.html` and `api/submit-bug.js` (steps field + screenshots).
⚠ `COMMIT_MSG_s10.txt` is untracked debris in BOTH repos — delete it.
⚠ **Local `preview` and `main` are 30 commits behind their remotes.** Not touched, because the
ladder was pushed as `git push origin admin:preview` / `admin:main` (both fast-forwards —
`origin/main` and `origin/preview` were strict ancestors of `origin/admin`). **A future session
that checks out local `preview` and merges will make a mess.** Fix them or delete them.

---

## NEXT, IN ORDER

1. ~~Verify the screenshot upload end to end~~ — **DONE 2026-08-20, see section 5.**
   Instead: **confirm the two bigfill fixes actually took.** The next run's snapshot should read
   `T1 unique members: 370` (matching the site) rather than a 900-ish entry count, and no
   `STALE-NONCE FAILURES` line should appear. If it says "unavailable on this build",
   `uniqueMembers` is not on the deployed V8.48 and the people count must be derived another way.
2. **Ask @bevmawire to retry the Dashboard.** His fault predates the outage and the block-floor
   fix has now shipped to main. Either it is fixed or we have a second, still-unidentified cause.
3. **Restate the `maxItemsPerUpkeep` item against 15, not 20**, then decide.
4. ⛔ **MEMBER-CALLABLE RE-ENTRY AFTER EVICTION** — V8.50 scope, owner decision 2026-08-19.
   Unchanged from session 9; nothing this session touched it. `_recordJoin` is already
   idempotent, preserve `memberReferrer`, put any new loop in TierRouterLib (EIP-170 pressure).
5. **Eviction end to end in the V8.50 private deploy** — recipe in session 9's late addendum.
   The cohort must be left UNFUNDED or it self-rescues and never reaches the valve.
6. **Model self-rescue at a non-zero rate.** Still the headline caveat on the PARAM 59 basis,
   the eviction answer and the loans-per-member result.
7. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
8. **The open owner decision on live V8.48** (leave organic / bigfill / fund the SF) is STILL
   OPEN. ⚠ Re-measure before deciding — and note this session's finding that the parked queue is
   GROWING (107 -> 110) while the fund recovers ($486 -> $529). The bracket from session 9
   (-$136/day stopped vs +$111/day running) is unchanged but its inputs have moved again.

---

# ⬛ SESSION 9 STATE — 2026-08-19, LATEST. READ THIS FIRST, BEFORE SESSION 8.

**THE HEADLINE: PARAM 59 IS DECIDED AND LANDED (3_400 -> 5_000). THE SUITE HAS NOT BEEN RUN
YET — that is the first thing to do. Most of this session was spent on a LIVE CUSTOMER-FACING
INCIDENT on V8.48 which turned out to be an UPSTREAM BASE SEPOLIA OUTAGE and NOT our code, and
on an owner-raised routing concern which is now CLOSED — nothing reverted, nothing is skewed.
Nothing was deployed. No chain was written to. `.env` line 69 is unchanged.**

Contracts changed: `StabilityFund.sol` (the default + its full measured basis),
`V8Governance.sol` (param 59 docs only). Tests touched: six files that pinned or described the
old ceiling. **NONE of it is committed yet — see STATE OF THE TREE.**

---

## 1. ⛔ PARAM 59 — OWNER DECISION TAKEN 2026-08-19: **5_000**

Session 8 left this open with a measured curve and a recommendation. The owner chose **5000**.
Landed in source the same turn:

- `contracts/StabilityFund.sol:844` — `insolvencyFloorBps = 5_000`, with the whole basis
  written at the declaration: the AB_FLOOR_BPS curve, why 5000 and not the saturation point
  4500, what it costs, and the carried `SELF_RESCUE_RATE = 0` caveat.
- `contracts/V8Governance.sol` — PARAM 59 docs. **No menu change was needed**; 5000 was
  already in `_allowedValues[59]`. Same as `minGasPerItem`.
- `test/V8_49_InsolvencyFloor.test.js` — `FLOOR_BPS_DEFAULT` 3400n -> 5000n (CEIL derives
  from it, so the boundary tests follow automatically).
- `test/V8_48_GhostFloor.test.js` — GF-F1's declared-default assert 3400n -> 5000n.
- `test/CycleOutDebug.test.js`, `test/stress_test_full.js`, `test/V8_49_CrossingBuffer.test.js`
  — prose and assertion messages that described the old $3.40 ceiling. No logic changes; every
  one of those assertions holds at any on-menu ceiling.

⚠ **`V8_48_KeeperScan.test.js`'s PARAM 59 sweep STILL PROBES 3_400 AND THAT IS DELIBERATE.**
The variable was renamed `shipping` -> `cliff` and the reasoning written at the point of the
change. That row tests the SHAPE of the item-A divergence, and 3400 is the value where the
divergence is known to exist. Retargeting it at 5000 would assert a flip count nobody has
measured, and a zero there would go red for a reason unrelated to what the test is about. The
sweep prints every row, so what the shipped 5000 does is READABLE without being asserted.

⚠ **ONE DISAGREEMENT IS LOGGED, NOT RESOLVED.** `model_item_a.js` PHASE 7 measured 3400 and
5000 as refusing THE SAME ONE MEMBER of 40 — "identical outcome". The A/B curve measures them
as clearly different (9 -> 3 evicted-never-lent-to; 7/6/5 -> 0/0/0 floor evictions). Different
populations on different bases (40 live V8.48 MatB parkers projected post-E1, vs 288 members
inside a running V8.50 build) is a reason they COULD differ, not a measurement that they DO
differ for that reason. Written into StabilityFund.sol as UNRECONCILED. The instrument if it
matters again is phase 7 re-run against a private V8.50 chain.

**⛔ NOT DONE: THE SUITE HAS NOT BEEN RUN SINCE THE CHANGE.** Expected 611 passing / 7 pending
/ 0 failing. Anything red is a test that pinned the old ceiling and was missed.

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat compile --force
npx hardhat test 2>&1 | Tee-Object -FilePath suite_after_param59.txt
```

---

## 2. 🚨 THE LIVE V8.48 INCIDENT — UPSTREAM BASE SEPOLIA, PROVEN WITH A CONTROL

Owner reported the community site erroring, "ongoing for a while, getting worse". Symptoms:
dashboard "Couldn't load your status", Live Stats all `—`, Matrix Tree View
`missing revert data (data=null, reason=null)` on `0x3f728455`, Status page
`0/127 · MatA 0%` and "Could not read keeper this poll" while showing 109 parked and $87.50 SF.

**WHAT IT WAS: Base Sepolia stopped serving STATE READS while still producing blocks.**

| method | Base Sepolia | Base mainnet | Ethereum Sepolia |
|---|---|---|---|
| `eth_blockNumber` | ok, advancing | ok | ok |
| `eth_getCode` | **HTTP 503** | ok | ok |
| `eth_call` | **HTTP 503** | ok | ok |

Five QuickNode endpoints AND Coinbase's `sepolia.base.org` failed identically; two other
chains answered fine **from the same machine in the same minute**. Base's status page said
"all operational" throughout — it was wrong, or lagging. Timeline: healthy at 15:20 UTC
(`occupancy()` = 127), hard down 15:54, intermittent 16:14–16:38, stable from 16:39.
`base_sepolia_watch.csv` in the frontend repo is the timestamped record.

**ONE UPSTREAM CAUSE PRODUCED ALL FOUR SYMPTOMS**: `occupancy()` fails -> ethers reports
`missing revert data` (Matrix view); the same failure inside `rpc()` loses its 8-second race
and `.catch(()=>null)` discards it -> cards paint `—`; the keeper reads state the same way ->
"could not read keeper". **Parked rescues stall for the duration** — expect a backlog after any
future outage.

**THE INSTRUMENTS BUILT (all in `C:\CryptoNova-Testnet-App`, read-only, no keys):**
- `check_rpc.ps1` — per-endpoint health. ⚠ **ITS FIRST VERSION ONLY TESTED `eth_chainId` AND
  `eth_blockNumber` — the two methods that never broke — and reported "all six endpoints
  healthy" during a live outage.** See the traps section.
- `measure_page_rpc.mjs` — page workload + true contract creation blocks. Reads
  `LOGS_DEPLOY_FLOOR` BACK out of index.html rather than restating it.
- `check_matrix_calls.mjs` — every endpoint asked the same call, side by side.
- `repro_page_load.mjs` — reproduces the page's load shape (pooled provider, batching on).
- `check_chain_scope.mjs` — **the one that settled it.** Other chains, same machine.
- `watch_base_sepolia.mjs` — recovery sampler; calls recovery only on a 3-sample streak on
  BOTH operators, because a flapping service returns single green reads (it did, at 16:14).

---

## 3. ⛔ FRONTEND FINDING — `LOGS_DEPLOY_FLOOR` WAS 588,000 BLOCKS TOO LOW. FIXED, **UNPUSHED**.

Found while chasing the incident; **it is NOT the incident's cause** and must not be quoted as
one. It is real on its own measured merits.

`index.html` floored every lifetime log scan at block **44,840,000** (a V8.46-era number) and
walked back to it in 9,000-block windows. Measured 2026-08-19 with `measure_page_rpc.mjs`:

| | block | windows per lifetime scan |
|---|---|---|
| chain head | 45,691,990 | — |
| old floor | 44,840,000 | **95** |
| cnova created | 45,428,148 | 30 |
| tierRouter created | 45,428,223 | 30 |
| communityWallet created | 45,430,266 | 30 |

**65 of every 95 windows — 68% of ALL lifetime history reading the site does — scanned blocks
that provably contain nothing**, because they predate the creation of every contract queried.
Six call sites do a floor-bound scan. Measured 103 ms/window, **0 failed windows, 0 retries** —
the endpoints were never refusing us, the page was simply asking ~3.2x more than it needed to.

Changed to **45,428,000** (148 blocks below the earliest creation, as slack against an
off-by-one in the search). Safety is a property, not an estimate: a contract cannot emit an
event before the block it was created in. All five inline script blocks pass `node --check`.

⚠ **THE REAL DEFECT IS THAT THIS CONSTANT GOES STALE BY DESIGN.** The head moves ~43,200
blocks/day and the floor does not, so every scan grows ~4.8 windows/day — ~29 more requests per
dashboard load per day, forever. Raising it buys ~4 months and then the same curve resumes.
Structural fixes, in order of value: (1) `safeGetLogs` already takes `opts.fromBlock` so a deep
history could be paid ONCE per wallet and cached — no call site passes it; (2) per-contract
floors instead of one global one.

**STATUS: edited in the working tree of `C:\CryptoNova-Testnet-App`, NOT committed, NOT
pushed.** Backup at `index.html.bak_session9`. Held deliberately so it would not be deployed
mid-incident and confuse the before/after.

---

## 4. ✅ THE OWNER'S T2 ROUTING CONCERN — CLOSED. NOTHING REVERTED.

Owner: *"T2.2 opened and started filling before T2.1 was completely filled, and T1.1 is still
taking members and cycling while T1.2 is on standby like it should — so something got skewed in
that deploy, maybe something reverted."* Then, from memory: *"we opened a pair in the event a
member has double entry enabled and cannot seat in the existing pair — a new pair opens up to
accommodate them vs parking them silently."*

**Measured on the live chain (`diag_pair_chain.mjs`, `diag_pair1_occupants.mjs`,
`diag_pair_birth.mjs`, all in the frontend repo):**

| | T1 | T2 |
|---|---|---|
| pair0 MatA | 127/127, rot 599, parked 26 | 127/127, rot 124, parked 4 |
| pair0 MatB | 126/127, rot 447, parked 81 | 118/127, **rot 0**, parked 0 |
| pair1 MatA | 0/127 | **5/127** |
| MatB % at pair1's birth | **92.1%** | **90.6%** |

**THE ANSWER IS TWO ANSWERS, AND CONFLATING THEM IS WHAT MADE IT LOOK WRONG:**

1. **WHAT CREATED EACH PAIR: the routine trigger.** Both births were above
   `factoryExpandThresholdBps` (9000). `_forceExpand()` never fired, and could not have — it is
   only reached when `_freePairFor()` returns `type(uint256).max`, and `_tryAdvancePair()` runs
   FIRST on every entry path, so the fresh empty pair always gives it somewhere to point. **The
   "normally unreachable" comments at :351 and :569 STAND — do not weaken them.**
2. **WHAT FILLED T2.2: the double-entry accommodation, exactly as the owner remembered.** All
   **5 of 5** occupants already hold a seat in T2.1's **MatB**. They could not take a second
   seat in the same pair (universal pair guard, `MatrixLogicLib:278` rejects a seat in EITHER
   half), so `registerFor` (:561) routed them forward. Joined 00:55–03:45 the same morning at a
   ~50-minute cadence — **bigfill wallets, not organic members.**

Both mechanisms fired in the same transaction, in that order, which is precisely why it looks
from outside like the double created the pair.

**ALSO CLOSED, AND IT CORRECTS SOMETHING THIS SESSION SAID FIRST:**
- **CHAIN WIRING IS CORRECT ON EVERY TIER.** Each MatB's `chainNext` is the next pair's MatA;
  the last MatB points back to pair 0's MatA. The circle closes on T1 and T2. No deploy defect.
- **T1.2 BEING EMPTY IS NOT STARVATION.** This session first suggested T1's graduates were
  parking instead of graduating. The simpler explanation is right: **before T1.2 existed,
  `chainNext` pointed T1.1's MatB back at its OWN MatA** — the self-sustaining loop, which is
  why MatA has 599 rotations against MatB's 447. T1.2 was wired in only when MatB crossed 90%,
  so it is empty because MatB has not rotated SINCE. Meanwhile 249 have joined T2's MatA — the
  ladder is absorbing people.
- **T2.1's MatB has NEVER rotated (rot 0)**, so it has produced zero graduates. Any future
  claim that "pair 1 is receiving graduates" must check the SOURCE's rotation count first.

**STILL TRUE AND STILL THE REAL NUMBER: 107 of 111 parked members sit in T1** (81 in MatB, 26
in MatA). That is the crossing-cost problem V8.50 item A + E1 exist to fix. It is not a routing
fault and no routing change touches it.

---

## TRAPS ADDED THIS SESSION — ONE TRAP, **THREE** INSTANCES IN ONE AFTERNOON

**AN INSTRUMENT MUST NOT REPORT THE ABSENCE OF SOMETHING IT CANNOT OBSERVE.** Already on the
list from session 8 ("testing the wrong slice looks like a refutation"). It was walked into
three more times today, so it is restated with all three:

1. **`check_rpc.ps1` reported "all six endpoints healthy" DURING A LIVE OUTAGE** — it only sent
   `eth_chainId` and `eth_blockNumber`, the two methods that never broke. It never sent an
   `eth_call`. That reading sent the session down a load/latency detour.
2. **`diag_pair_chain.mjs` reported "pair 1 IS receiving graduates"** from the fact that pair 1
   had members — without checking that pair 0's MatB had ever rotated. It had not. Zero
   rotations means zero graduates; the members came from somewhere else entirely.
3. **`diag_pair_birth.mjs` reported "no registration in this tx"** because its hand-written ABI
   guesses did not match the deployed signatures, so every event decoded as `unknown(0x...)`.
   Fixed by building the topic0 dictionary from the repo's own `artifacts/` — **227 signatures
   instead of 9 guesses.**

**AND A FOURTH, WORSE, WHICH THE ABI FIX WOULD NOT HAVE CAUGHT: A DISCRIMINATOR THAT CANNOT
DISCRIMINATE.** `diag_pair_birth.mjs` v1 was built on "a registration tx means the routine
trigger, a cycle-out tx means the on-demand spawn". That premise is FALSE — `_tryAdvancePair()`
is the first statement of `registerDirectFor`, `registerFor` AND `registerForMatB`, so it runs
on every entry path and the transaction type carries NO information about which created the
pair. The script decoded real events into a conclusion the data could never support. **Before
building a discriminator, prove the two cases actually differ in what it measures.**

**WHEN TWO DISCRIMINATORS DISAGREE, ONE OF THEM IS BROKEN — GO FIND OUT WHICH.** v1 printed
92.1% and 90.6% (both above the trigger) in one column and "PATH B" in the next. The
disagreement was the finding, exactly as rule 1 says, and it was the instrument.

**A STATUS PAGE IS NOT A MEASUREMENT.** status.base.org said "All Systems Operational, 100%
uptime" throughout a total state-read outage.

**AND THE CONFOUND THAT NEARLY LANDED: SIX ENDPOINTS ON ONE NETWORK PATH ARE NOT SIX
INDEPENDENT OBSERVATIONS.** Every reading came from the owner's machine. A middlebox inspecting
POST bodies would pass `eth_blockNumber` and fail `eth_call` and look identical to an upstream
outage. `check_chain_scope.mjs` (other chains, same machine) is what made the conclusion safe.

---

## STATE OF THE TREE — ⚠ NOTHING FROM THIS SESSION IS COMMITTED

**Contracts repo (`v8.1`), all UNCOMMITTED working-tree edits:**
- `contracts/StabilityFund.sol`, `contracts/V8Governance.sol`
- `test/V8_49_InsolvencyFloor.test.js`, `test/V8_48_GhostFloor.test.js`,
  `test/V8_48_KeeperScan.test.js`, `test/CycleOutDebug.test.js`, `test/stress_test_full.js`,
  `test/V8_49_CrossingBuffer.test.js`
- Last commit remains `c177938`. **Run the suite BEFORE committing.**

**Frontend repo (`C:\CryptoNova-Testnet-App`), all UNCOMMITTED:**
- `index.html` — `LOGS_DEPLOY_FLOOR` 44840000 -> 45428000 + both stale comments corrected.
  Backup `index.html.bak_session9`.
- NEW diagnostics: `check_rpc.ps1`, `measure_page_rpc.mjs`, `check_matrix_calls.mjs`,
  `repro_page_load.mjs`, `check_chain_scope.mjs`, `watch_base_sepolia.mjs`,
  `diag_pair_chain.mjs`, `diag_pair1_occupants.mjs`, `diag_pair_birth.mjs`
- Result files: `rpc_health_*.json`, `page_rpc_workload_*.json`, `matrix_call_probe_*.json`,
  `repro_page_load_*.json`, `pair_chain_*.json`, `pair1_occupants_T2_*.json`,
  `pair_birth_*.json`, `base_sepolia_watch.csv`
- `INCIDENT_2026-08-19_BASE_SEPOLIA.md` — the incident write-up.
- ⚠ Remember the push ladder: `git push origin admin` — admin -> preview -> main, and MEMBERS
  SEE MAIN ONLY.

---

## NEXT, IN ORDER

1. **RUN THE SUITE** after the PARAM 59 change (command in section 1). Nothing else in the
   release is blocked on it, but nothing should be committed before it.
2. **Commit both repos** — explicit paths only. ⛔ NEVER `git add -A` from the device side
   (core.autocrlf unset there shows 31 files modified on line endings alone).
3. **Ship the `LOGS_DEPLOY_FLOOR` fix** to admin and re-run `measure_page_rpc.mjs` against the
   healthy chain to confirm 95 -> 30 windows end to end. It reads the constant back, so the
   re-run verifies the SHIPPED value.
4. **Owner decision 2 is STILL OPEN — live V8.48: leave organic, bigfill, or fund the SF?**
   ⛔ **SESSION 8'S "BIGFILL DOES NOT REPLENISH" IS WITHDRAWN — the owner corrected it
   2026-08-19 and he is right on mechanism.** It rested on one bps figure the same document
   flagged as unconfirmed, and missed three inflows: registrations (1-5 new wallets per run),
   UPGRADES to the highest eligible tier (a $25 T2 or $50 T3 fee carries a proportionally
   larger stability split than a $10 registration), and SELF-RESCUES (the crossing fee is
   still distributed so the SF gains its split, AND no SF loan is drawn).
   **The third dominates, and it is avoided OUTFLOW, not income:** a wallet that self-rescues
   does not draw the $3.42-$4.52 SF share and still pays in — roughly a $4 swing per event
   against the passive case, an order of magnitude above the $0.238-$0.30 that session 8
   reasoned from.
   ⛔ **THEREFORE THE DRAIN SERIES IS CONTAMINATED AND "PRESERVE THE BEFORE-PICTURE" IS DEAD
   AS AN ARGUMENT.** The bigfill wallets stay seated whether bigfill runs or not: with it
   stopped they still cycle out, park and get SF-rescued, but no longer register, upgrade or
   self-rescue. Stopping bigfill removed the income and kept the liability — the population is
   100% PASSIVE BY CONSTRUCTION, the same pathological extreme as `SELF_RESCUE_RATE = 0`.
   The ~$125/day drain may be an artifact of the regime, not a property of the economics.
   ✅ **MEASURED 2026-08-19 — OWNER RIGHT, ON GROUND-TRUTH USDC.** `scripts/diag_sf_flows.js`
   and `scripts/diag_sf_usdc_ledger.js` (both new). The USDC ledger reconciles EXACTLY
   (in $1,401.79 / out $1,364.86 / balance $36.94 = balanceOf = totalBalance) so there is NO
   LEAK. Daily net separates perfectly by regime: bigfill days 08-13..08-16 **+$72.87 /
   +$75.82 / +$81.39 / +$214.74**, quiet days 08-17..08-19 **-$114.31 / -$185.02 / -$108.55**.
   **+$111/day running vs -$136/day stopped, no overlap.** The -$136 matches the ~$125/day
   drain previously recorded — that series measured the passive regime, nothing more.
   Mechanism: stopping bigfill took keeper rescues 11.5 -> 44.3/day and SF lending
   $76.72 -> $345.68/day while self-rescues fell 73.5 -> 16.0/day.
   ⚠ `diag_sf_flows.js`'s `net/day` column is VOID (double-counts repayments, treats
   FundDeposit events as cash — they overstate real inflow ~$300 over this range) and its
   inflow ATTRIBUTION is misleading ("keeper-rescue 58.6%" is the fund's largest COST, not
   its largest source). Its OUTFLOW column is sound — it reconciles to the contract counter.
   ⚠ Neither regime is the real world (~100% vs 0% self-rescue) — read them as a BRACKET.
   This is the best empirical anchor yet for the open self-rescue-rate item.
   ⚠ Still also true: the figures are days old and the SF has moved ($212.35 -> $87.50 on the
   status page 2026-08-19), and `diag_parked_growth.js` with `WINDOW=3000` is still owed.
   ⚠ Operational: restarting bigfill collides with a future V8.50 private deploy on wallet
   nonces. Sequence them, never overlap.
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
5. ~~Router placement refusals, 11 -> 53~~ — **CLOSED 2026-08-19, they were never refusals.** See the addendum section below; the metric is a second label on parks already counted, and the no-strand epilogue measured clean (0 orphans, both arms).
6. **Model self-rescue at a non-zero rate.** Still the headline caveat on sections 2, 5 and 6 of
   session 8 and on the PARAM 59 basis.
7. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
8. **`maxItemsPerUpkeep`** — still vestigial at 20. Confirm deliberately or lower to 10.

---

## ⛔ LATE-SESSION ADDENDUM (2026-08-19, after the write-up above)

### THE TRAP THAT COST THE MOST: **V8.49/V8.50 NAMES CALLED AGAINST THE V8.48 CHAIN**
The repo tree is V8.50. **The community chain is V8.48.** A view added after V8.48 reverts
there with `missing revert data`, which looks exactly like a network fault and is not one.
Caught THREE times in one hour:
| called | added in | V8.48 has instead |
|---|---|---|
| `evictionGracePeriod()` | V8.49 item 1 (`b14eba7`) | `extendedIdleTimeout()` — same 604_800 |
| `loanHeadroom(addr,u8)` | V8.49 item 1b (`40d7843`) | derive: `fee*insolvencyFloorBps/10000 - memberDebt` |
| (same, in the new dashboard code) | | would have made every badge read CHECKING on live |
**RULE: any new code that calls the chain must be checked against the DEPLOYED ABI, not the
source tree.** `scripts/probe_v848_getters.js` exists for this; `scripts/probe_sf_views.js`
(new) is the narrow SF version. Extend them rather than re-inventing.

### EVICTION HAS NEVER FIRED ON LIVE V8.48 — AND CANNOT WHILE BIGFILL RUNS
`MemberEvicted` events: **0**, on a chain live since 2026-08-13. Not a broken valve — the
mechanism has never had an opportunity. Eviction needs BOTH the 7-day clock AND a non-NONE
`_triageParked` reason, and bigfill self-rescues at 100%, so parked members are rescued long
before the clock expires (54 of 57 in one run). Measured: soonest clock of ANY parked member
**5.41 days**; eviction candidates **not determinable** on V8.48 (see the ABI trap above).
**RECOMMENDATION, owner to confirm: do NOT test eviction on live V8.48.** It means racing a
5-day clock the sweep keeps resetting, and a V8.50 deploy resets the chain anyway. Test it in
the V8.50 private deploy with a cohort deliberately parked, UNFUNDED and EXCLUDED from the
sweep. Shortening the grace period on live is the only faster lever and it moves the deadline
for every real member — an owner policy call, not a test convenience.

### ⛔ EVICTION TEST — OWNER DECISION 2026-08-19: **NOT ON LIVE. DO IT IN THE V8.50 PRIVATE DEPLOY.**
Owner, verbatim in substance: *"we are definitely not going to make the 6 days, we will have
a deploy before that."* So the natural test on live V8.48 is dead — the soonest candidates
were ~146h out and the deploy lands first. **Stop holding anything back for them; bigfill may
self-rescue freely.**

✅ **AND THE PRIVATE CHAIN REMOVES THE TIMING PROBLEM ALTOGETHER — THIS IS THE UNLOCK.**
`evictionGracePeriod` is DAO param 62 with a setter. On live it is untouchable because it
moves the deadline for every real member. **On a private chain with no members, set it to
MINUTES.** The 7-day wait was never a property of the mechanism; it was a property of having
customers on the chain. The whole test collapses from 6 days to one coffee.

**THE RECIPE, so this is not re-derived:**
1. Deploy V8.50 privately. Confirm PARAM 59 = 5_000 on the deployed SF (`insolvencyFloorBps()`),
   not just in source — a dial set is not a dial in force.
2. `setEvictionGracePeriod(<minutes>)` on the keeper. **READ IT BACK.**
3. Seat a small cohort, cycle them out so they park, and leave them UNFUNDED — a funded
   wallet self-rescues and never reaches the valve, which is exactly why live V8.48 has
   produced ZERO `MemberEvicted` events in 6 days of running.
4. Run the keeper. Assert on `ParkedMemberEvicted` / `MemberEvicted`, and check the member
   keeps their withdrawable, the crossing reserve is RELEASED (`EvictionReserveReleased`),
   and the debt stays booked — the valve is supposed to remove them, not confiscate.
5. Then re-run with PARAM 59 at 3_400 as the control. On live V8.48 the T1 ceiling is
   $10.00 x 3400/10000 = **$3.40**, and parked gaps of $4.39 / $5.00 / $5.00 were measured
   sitting ABOVE it — uncoverable by any loan. At 5_000 the ceiling is $5.00 and all three
   are covered. That is the A/B curve's 9 -> 3 result reproduced from live data, and it is
   worth asserting end to end rather than trusting twice-derived numbers.
6. Also exercise the V8.50 member-callable re-entry (scope item above) — an evicted member
   returning under their own power is the half bigfill currently fakes with an owner override.

### BIGFILL — CHANGED, WORKING, AND THE FUND RECOVERED
`-Count` 127 -> **1** (owner rule; sweeps feed the fund, not bulk registration), plus the new
`reinstateEvicted()` phase (owner override — see BIGFILL_RULES.md action 4 for why that
simulates something production cannot do). Two robustness fixes, both measured not guessed:
- **Transport errors are no longer counted as refusals.** A run logged `HH110` on 31
  consecutive wallets and still printed "17 succeeded - 36 skipped" — a measurement of the
  NETWORK read as a measurement of MEMBERS. Now classified, counted separately, and 5 in a
  row ABORTS the sweep rather than producing a partial result that looks whole.
- **The USDC top-up verification read stale state.** Two runs PROVED it: `0xaFF03A85` was
  topped +$4.00, reported "DID NOT LAND [still $3.00]", and turned up next run holding
  exactly $7.00; `0x0f822360` +$2.11 -> $5.11. The transfers landed; the CHECK was wrong.
  Now retries the balance read 3x with 3s gaps before declaring failure.

**RESULT, on ground-truth USDC: SF $36.94 -> $352.58 in one afternoon.** Combined with the
regime table above (bigfill days +$111/day, quiet days -$136/day), the owner's correction is
confirmed twice over — by history and by live recovery.

### FRONTEND — PARKED-MEMBER STATUS BADGE (BUILT, **UNPUSHED**)
`index.html` `renderParkedList()` now labels each parked position **IN RESCUE QUEUE** /
**WAITING ON FUND** / **PENDING EVICTION** / **CHECKING**, with the eviction countdown. It
does NOT re-implement `_triageParked` (its reason is an internal uint8, never emitted) — it
compares two exact figures, `loanHeadroom` (with the V8.48 derivation above) against the
member's own gap, and reads the grace period from the keeper rather than hardcoding it.
Failed reads render CHECKING, never "fine". All 5 inline script blocks pass `node --check`.
⚠ Not tested against a live chain yet — do that before it goes past `admin`.

### ⛔ ROUTER PLACEMENT REFUSALS — **CLOSED 2026-08-19. THEY ARE NOT REFUSALS.**
Supersedes "explain the router placement refusals, 11 -> 53" in the session 8 and session 7
NEXT lists. Do not reopen it from those.

**What the code does.** `TierRouter:1449-1458`, the V8.44 no-strand epilogue: when a member
cycles out with re-entry ON and cannot fund it, the router calls
`matrixB.parkCycledOut(member, shortfall)` and THEN emits its own
`MemberParked(member, tier, "insufficient funds")`. `parkCycledOut` (MatrixLogicLib:1939)
emits the MATRIX `MemberParked` on its own line. **One underfunded cycle-out therefore
produces two differently-shaped events in one transaction**, and the harness was counting
them as two independent populations.

**Why that could not just be asserted.** Two branches break the pairing, and both matter:
`parkCycledOut` returns early if `parkedAt[member] > 0` (router event, no new queue entry),
and the call sits inside `try {} catch {}`, so a revert is SWALLOWED — router event, no park
anywhere, i.e. a member leaving with nothing holding them. That last case is exactly what the
epilogue's own comment ("NEVER a silent exit") claims is impossible. A count cannot tell the
three apart.

**Measured.** `test_ab/replay.js` now records the transaction hash of every parsed event (a
`WeakMap` keyed by the destination bucket, so the per-tick census bucket cannot contaminate
the cumulative one) and pairs each router event against a matrix park **in the same tx for
the same member** — `raw.parkRefusalPairing`. Seed 1, 288 members, MATRIX_SIZE 127, AB_CAP 5:

| | control v849b | V8.50 |
|---|---|---|
| router events | 12 | 59 |
| paired, same tx + same member | **12** | **59** |
| same tx, no matrix park | 0 | 0 |
| member never parked at all | **0** | **0** |

**Two conclusions, and only these two.**
1. `parkRefusalsRouter` is a MISLABEL. Every one of these sits on top of a park already
   counted in `parkEventsMatrix`. It is not an independent population and 11 -> 59 is not an
   anomaly — it is the share of parks arriving through the router epilogue rather than
   through the matrix's own park sites. The key keeps its name so sessions 6-9 results stay
   comparable; `raw.parkRefusalsRouterNote` now says this inside every result file.
2. **The no-strand epilogue holds.** Zero orphans on both arms is the all-clear on V8.44's
   central claim. If this number is ever non-zero it is a defect, not a metric.

⚠ ONE SEED, ONE SEQUENCE. The pairing is structural (it follows from the emit order) so a
second seed would be confirmation rather than discovery — but it has not been run, and
"12/12 and 59/59" is a statement about seed 1.

⚠ AND WHAT IS **NOT** CLOSED: the two arms differ on `insolvencyFloorBps` (3400 vs 5000) as
well as on build, so the CHANGE IN COMPOSITION of parking between them is confounded and is
not a finding. Only the pairing is.

### BIGFILL OUTPUT IS NOW ASCII-ONLY (owner request 2026-08-19)
Run logs were mangling dashes and arrows. Two causes, both fixed:
`scripts/bigfill_v8.js` had 171 non-ASCII characters in code and string literals — every one
that can reach the console is now ASCII (`-`, `->`, `!`, `...`, `ok`, `X`). **Comment banners
keep their box-drawing** — they never print, and flattening them would have made a 1,600-line
diff out of a cosmetic fix. The rewrite used a state machine over the file (code / line
comment / block comment / each quote type) rather than a blind replace, so nothing inside a
comment moved and no string was half-converted. Second, both `run_bigfill_rr.ps1` and
`run_bigfill_loop.ps1` now set `[Console]::OutputEncoding` and `$OutputEncoding` to UTF-8
before launching node: PowerShell 5.1 decodes a child process's stdout with the ANSI code
page otherwise, which is what produced the mojibake. That belt still matters for hardhat and
ethers messages, whose text we do not control. **Both .ps1 files are now pure ASCII (0
non-ASCII bytes)** — they have no BOM, and a non-ASCII byte in executable code broke a run on
2026-08-19.

**⚠ AND THE VERIFICATION OF THIS HAS ITS OWN TRAP.** `logs\bigfill_loop\*.log` are written
by `Tee-Object`, which on PowerShell 5.1 writes **UTF-16LE**. `Select-String` and
`Get-Content` decode it correctly; a byte-level `grep` does not, and returns "0 matches" for
every pattern — which reads exactly like "the log is clean". The first check run against the
ASCII fix came back 0 for that reason before it came back 0 for the right one. Decode the
file (or use `Select-String`) before believing any count taken from these logs. Confirmed
clean afterwards on positive evidence, not absence: the banner prints as 60 ASCII hyphens and
the header reads `bigfill_v8.js - 1 wallets - batch 1`. Note the self-rescue and CNOVA
buy-sweep lines were converted in source but had not printed yet in that run.

### STILL OPEN AT SESSION END
1. ~~The suite has still not been run~~ — **DONE**: 611 passing, committed and pushed as
   `e404d70` on `v8.1`. The ASCII + pairing work of the late session is a separate commit.
2. ~~`probe_sf_views.js`~~ — **DONE**: 8 of 10 views present on V8.48; `loanHeadroom` and
   `evictionGracePeriod` are the two absent ones, exactly as predicted, and the fallbacks in
   `diag_eviction_clock.js` and `index.html` are pointed at what answered.
3. T1.1 is now FULL on both halves (127/127). **Prediction to verify:** its MatB rotations
   should now graduate into T1.2's MatA via `chainNext`. If T1.2 stays empty, chase it.
4. Bigfill's batch line prints the ACTIVE pair's occupancy while the snapshot prints T1.1 —
   two different "T1" numbers in one output. Same class as the dashboard pill fixed with
   "Pair N of M". Cosmetic, but it has already caused confusion once.
5. `FUND_AMOUNT $11.00` is below the T2 ($25) upgrade fee, so members reach MatB and cannot
   climb — 6 wallets stuck on that in the last run. Raise it if you want the ladder exercised.

---

# ⬛ SESSION 8 STATE — 2026-08-19. READ AFTER SESSION 9, BEFORE SESSION 7.

**THE HEADLINE: THE ~10x EVICTIONS ARE EXPLAINED, REPLICATED 3/3, AND THEY ARE NOT A DEFECT.
They are three measured factors, and the largest of them is that V8.50 moves the parked
population out of MatA and into MatB. Session 7's open item 2 (the withdrawable variance) is
also CLOSED — the statistic was invalid, not the system. Nothing was deployed, no chain was
written to, `.env` line 69 is unchanged, and NO CONTRACT FILE WAS TOUCHED THIS SESSION.**

Changed: `test_ab/replay.js`, `test_ab/world.js`. That is the whole diff.

⛔ **OWNER FRAMING GIVEN THIS SESSION, 2026-08-19 — IT CHANGES WHAT IS A DEFECT.**
Recorded verbatim in substance because two sessions have now spent effort on the wrong bar:
- **Members are NOT meant to cross forever.** The bar is that they can get **one or two
  loans**, not that everyone crosses indefinitely.
- **Nobody can get stuck at the A→B crossing — everyone crosses on the reserve.**
- **Members are EXPECTED to take loans and to be evicted if they never invite anyone.**
So "V8.50 evicts 10x more" was never, on its own, a finding about a defect. The question is
only ever whether the eviction is the *designed* one.

---

## 1. THE INSTRUMENT — `AB_EVICT=1`, AND WHY IT IS NOT EVENT ARCHAEOLOGY

`ParkedMemberEvicted(matrix, member, totalWithdrawn)` carries **no reason**. The reason is
`_triageParked`'s `uint8` — an internal return inside a view library. Never emitted, never
stored, never in a log. An event-only instrument can count evictions forever and never say
why one happened. So this reads two other things:

1. **THE DECISION ITSELF, FOR FREE.** `checkUpkeep` returns `performData =
   abi.encode(WorkItem[])`, `WorkItem` is `(uint8 workType, uint8 tierIndex, address addr1,
   address addr2)` (field order declared load-bearing at MatrixKeeperLib:175), and the
   replay already holds that blob. Decoding costs ZERO chain calls and gives the exact
   routing: who went to `WORK_EVICT_PARKED` (6) and who to `WORK_PARKED_RESCUE` (4).
2. **THE BRANCH**, re-walked off-chain from the same public views the contract used. The
   ladder walk is **not re-implemented** — it is asked of the deployed
   `MatrixKeeperLib.rescueBpsFor`, which is `external pure` on BOTH arms. Only the ORDER of
   the four tests is JavaScript.

**IT RECONCILES ITSELF, IN THE FILE, EVERY RUN.** Routed to EVICT ⇒ derived reason ≠ NONE;
routed to RESCUE ⇒ reason == NONE. Disagreements land in `mismatches`, and a non-empty list
**VOIDS the entire reason column** — it does not mean "mostly right". Measured:
**`mismatchCount` 0 on every run this session** (429 routed items on the first six alone).

**THE ONE PLACE THE ARMS DIFFER IS MEASURED, NOT ASSUMED.** The price basis is the whole of
item A inside this function (v849b `fee`; V8.50 `isMatrixA ? fee/2 : fee`). Hard-coding
"this arm uses that one" would smuggle a hypothesis into the instrument, so BOTH bases are
scored against the contract's actual routing every run. Result: control reconciles on ENTRY
FEE, V8.50 on CROSSING COST. **Item A confirmed live inside discovery by reading, not by
assuming from the arm name.**

**AND IT HAS A BLIND SPOT, STATED SO IT IS NOT READ INTO.** Discovery reaches queue indices
0-2 while the queue behind runs 26-31 deep, so batch rows describe the HEAD only. Hence
`AB_QUEUE_EVERY` (default 5): every Nth tick it triages the ENTIRE parked queue of both
matrices, including members discovery never looked at. Those rows are **member-tick
observations of a sampled queue** — not members, not events. Never quote a raw count from
`population`; quote the shares and medians.

---

## 2. THE ~10x EVICTIONS — THREE FACTORS, ALL REPLICATED 3/3

### FACTOR 1 (LARGEST) — WHERE MEMBERS PARK

| parked queue, sampled | v849b (s1/s2/s3) | V8.50 (s1/s2/s3) |
|---|---|---|
| share of queue in MatB | .23 / .20 / .19 | **.95 / .96 / .97** |
| MatA observations evictable | **0** of 81 / 83 / 88 | **0** of 4 / 3 / 2 |
| MatB observations evictable | 5/24, 4/21, 4/21 | 18/72, 20/74, 21/75 |

**A PARKED MatA MEMBER WAS NEVER EVICTABLE, IN EITHER BUILD, IN 258 OBSERVATIONS.** All
eviction risk in this system lives in MatB. The control's queue is three-quarters MatA;
V8.50's is almost entirely MatB. ~4.5x on its own. **This also confirms the owner's
statement that nobody gets stuck at the A→B crossing** — median MatA reserve $5.00, median
wBps 10500 against a ladder whose bottom rung is 4000.

### FACTOR 2 — WHETHER DISCOVERY REACHES PARKED WORK (defect 6)

- **v849b: 25-26% of ticks with a NON-EMPTY parked queue produced ZERO parked work items**,
  all three seeds. The batch was full of VELOCITY + GHOST + RECLAIM. ~390 member-ticks per
  run went unscanned.
- **V8.50: 0%. All three seeds.**

⛔ **CORRECTION — SESSION 6'S GUESS WAS RIGHT AND SESSION 8 CALLED IT WRONG FIRST.** On seed
1 this session wrote "session 6's starvation guess does not survive", on the basis that
evicted and rescued members had identical queue positions (median 1, range 0-2). **That was
the wrong test.** Queue position INSIDE a batch that was reached cannot see a batch that was
never reached at all. Measured properly, defect 6's reordering is a real contributor, worth
~1.35x. The UNVERIFIED session-6 hypothesis is now VERIFIED.

### FACTOR 3 — THE RESERVE, VIA ONE THRESHOLD IDENTICAL ON BOTH ARMS

A member fails the floor when effective contribution < **$6.60** (price $10.00 − the $3.40
ceiling at PARAM 59 = 3400). The census lands on it exactly:

- v849b MatB — rescuable ≥ $6.65, floor-refused ≤ $6.02
- V8.50 MatB — rescuable ≥ $6.61, floor-refused ≤ $6.40

**Same rule, same place.** The difference is that a control MatB parker gets **$5.00 of that
$6.60 free** from the crossing-reserve carve (`reserveZeroShare` 0.00, all seeds), while
**every V8.50 MatB parker holds zero reserve** (1.00, all seeds, 221 observations). ~1.35x.

⛔ **$6.60 IS NOT A NEW NUMBER.** The phase-6 section already measured it on live V8.48
(2026-08-17, n=70, min = median = max = $6.60). This session reproduced the same boundary in
a fresh LOCAL fixture, different population, different build. **Two independent instruments
to the cent.** The evictions are not a new phenomenon — they are the known PARAM 59 /
MatB-ledger problem surfacing as evictions because V8.50's queue is 96% MatB.

**The three factors multiply to ~8x against an observed ~10x. THAT MULTIPLICATION IS
ARITHMETIC OVER MEASURED FACTORS, NOT AN INDEPENDENT MEASUREMENT** — independence was never
tested. Do not quote "8x" as a result.

---

## 3. ✅ OPEN ITEM 2 CLOSED — THE WITHDRAWABLE VARIANCE WAS AN INVALID STATISTIC

| | rescued MatA / MatB | pooled `atRescue` median |
|---|---|---|
| v849b | 88/0, 84/0, 86/0 — **100% MatA** | $3.73 / $3.75 / $3.72 |
| V8.50 | 19/28, 23/24, 23/23 — **40% / 49% / 50% MatA** | $7.43 / $4.45 / $2.15 |

The parked population holds two clusters that do not overlap: a MatA parker sits at **$0.25**
withdrawable (their money is in the crossing reserve), a MatB parker at **$7.38-$7.66**
(carried balance, no reserve). **The MatB medians are TIGHTER across seeds than the
control's.**

The control rescues one cluster only, so its median is steady. V8.50 rescues a near-50/50
mixture, so the 50th percentile lands wherever the mix falls and **flips between humps**.
The "3.5x spread straddling the control" is a pooled median of a bimodal distribution taken
exactly where the two humps are equal. **It describes no member in either hump and is not
evidence about member support in any direction.** Session 7 was right to refuse to write it
up.

`withdrawableUSD.atRescue` now carries a `WARNING` field and `atRescueByMatrix` beside it.
**Never quote the pooled figure on the V8.50 arm again.**

---

## 4. ✅ ITEM E1 IS FIRING — CONFIRMED, NOT ASSUMED

The handoff records E1's effect as "MatB ledger at the gate $7.66 → $8.32". This harness's
V8.50 arm measures the MatB parked median at **$7.66** — the PRE-E1 figure, to the cent. Two
numbers disagreeing is a finding, so it was measured rather than explained:
**`balanceCarried` 201 / 198 / 198 events, $913.10 / $909.99 / $904.80 carried.** E1 fires.
The $7.66 match was two different bases landing on the same number (live V8.48 population vs
this fixture). Counter is permanent in `raw`.

---

## 5. ⛔ THE PARAM 59 CURVE — MEASURED, 5 VALUES × 3 SEEDS, V8.50 ARM

| PARAM 59 | evictions | FLOOR | LADDER | **evicted having NEVER been lent to** | rescues | loanVol $ | SF end $ |
|---|---|---|---|---|---|---|---|
| 3400 | 9/10/10 | 7/6/5 | 2/4/5 | **9/9/9** | 47/47/45 | 40.02/38.98/47.29 | 96.54/97.82/88.80 |
| 4000 | 4/3/7 | 1/0/2 | 3/3/5 | 3/3/6 | 51/53/48 | 58.66/47.35/57.29 | 80.04/91.83/81.17 |
| **4500** | 4/3/5 | **0/0/0** | 4/3/5 | **3/3/3** | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |
| 5000 | 4/3/5 | 0/0/0 | 4/3/5 | 3/3/3 | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |
| 6800 | 4/3/5 | 0/0/0 | 4/3/5 | 3/3/3 | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |
| 10000 | 4/3/5 | 0/0/0 | 4/3/5 | 3/3/3 | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |

**THE CURVE SATURATES AT 4500. The `raw` block at 4500, 5000, 6800 and 10000 is BYTE-IDENTICAL
on all three seeds.** Above 4500 the floor does not bind at all. This is why the sweep was
run rather than argued: an earlier turn this session asserted from headroom arithmetic that
higher ceilings would keep helping. They do nothing.

⛔ **BUT 4500 IS TWO CENTS SHORT, AND ONLY THE POPULATION CENSUS SEES IT.** Across the 3400
runs the observed FLOOR ask (`advance`) ranges **$3.42 to $4.52**, n=55. A $4.50 ceiling is
**−$0.02 against the worst observed ask**; it measures identically to 6800 only because that
one member was never routed. **$5.00 gives $0.48 of margin at ZERO measured cost.** The ask
is structurally `crossingCost − effectiveContrib`, so a thinner population asks more.
**RECOMMENDATION: 5000, not 4500** — same measured outcome, real margin instead of a
rounding error. ⚠ OWNER DECISION STILL OPEN as of session end.

⛔ **AND THIS REVERSES THE PHASE-6 REVERSAL — CORRECTLY, BECAUSE E1 CHANGED THE INPUT.** The
phase-6 section measured **5000 as rescuing ZERO members** and said "DO NOT DEPLOY 5000".
That was **before E1**, when a MatB parker reached the gate holding $3.40 and asked $6.60.
Post-E1 they hold $7.4-7.7 and ask $3.42-$4.52. **The earlier reversal was right on the
evidence it had; E1 is what makes 5000 viable.** Do not read the phase-6 section as still
binding without carrying E1 with it.

**What 5000 costs and what it does NOT cost:** ~$11-16 of ending fund balance (SF ends
$77-92 vs $89-98), still **4-6x the control's $13-25**. `loansPerRescue` stays ~0.5 and
`unfundedRescueShare` ~0.39-0.51. **Item A's fund claims are untouched by the change.**

---

## 6. ✅ LOANS PER MEMBER — THE OWNER'S ACTUAL BAR, AND A THIRD ANSWER

Two independent views, reconciled every run: `RescueLoanIssued` (MatrixLogicLib) and
`MemberDebtIncreased` (StabilityFund, one writer). **They agreed on count AND on borrower
set in every run.**

- **159 loans across six runs, 159 distinct members, `max 1`. Not one second loan, at ANY
  ceiling value.**
- **7 / 11 / 10 members per run ARE rescued a second time** (`maxRescuesToOneMember` 2).
- Rescued-from-MatA (20/27/23) ≈ fund-free rescues (20/27/22).

⛔ **SO THE SECOND LOAN IS NEITHER REFUSED NOR UNREQUESTED — THE SECOND RESCUE IS FREE.**
Session 8 asserted "refused" (headroom arithmetic — killed by the 10000 row) and then
"never requested" (killed by the rescue counter). Both were wrong. The cycle:
- **MatB re-entry** — full fee, no reserve, needs the fund → **one loan.**
- **A→B crossing** — the reserve covers it → **free, no loan, no debt.**

That is item A's headline claim measured within-arm, exactly as `replay.js`'s own header says
it must be. **Against the owner's bar, a member takes one loan and then crosses on their own
money.** The "two" never arises because the second crossing was already paid for.

⚠ **FIXTURE LIMIT ON THAT CONCLUSION:** `SELF_RESCUE_RATE = 0`, one tier, one pair, 69 ticks,
288 members. Section 8 has called this a pathological extreme since before session 6.

---

## TRAPS ADDED THIS SESSION

- **ARITHMETIC OVER MEASURED NUMBERS IS NOT A MEASUREMENT.** Twice this session a correct
  input produced a confident wrong mechanism: "the floor refuses the second loan" (the 10000
  row disproved it — nothing changed) and "the second loan is never requested" (the rescue
  counter disproved it — 7-11 members ARE rescued twice). Both READ like results. Rule 2
  covers derivations from measured values, not just guesses.
- **TESTING THE WRONG SLICE LOOKS LIKE A REFUTATION.** Queue position *inside* reached
  batches said starvation was not happening. It cannot see a batch that was never reached.
  Before writing "X does not survive", check that the instrument can observe X's absence.
- **A POOLED MEDIAN OVER A BIMODAL POPULATION DESCRIBES NOBODY.** V8.50's rescued members
  are two non-overlapping clusters ($0.25 and ~$7.5). At a ~50/50 mix the median flips
  between humps and reads as 3.5x "variance". Split by population before quoting a median.
- **THE BATCH IS NOT THE POPULATION.** Discovery reached indices 0-2 of a 31-deep queue, and
  the CONTROL'S ENTIRE MatB COHORT — the one the comparison turns on — was never routed at
  all. A head-of-queue instrument has zero observations of it and will not say so.
- **A RE-RUN THAT SHARES AN OUTPUT FILENAME DESTROYS THE EARLIER RESULT.** A run with
  `AB_QUEUE_EVERY=0` silently overwrote a censused file and lost one seed's population
  block. Every dial that changes the answer is now in the filename (`_nopop`, `_floor<n>`).
- **A DIAL SET IS NOT A DIAL IN FORCE.** `insolvencyFloorBps` is read BACK into `dials` on
  every run. Same lesson as the cap, restated because the sweep would be void without it.
- **THE CONSOLE MUST BE LEGIBLE OR IT IS NOT READ.** The full AB_EVICT result is ~1,500
  lines. Console now prints a summary; the file keeps everything. Complement to "diagnostics
  go in the RESULT FILE", not a contradiction of it.

---

## STATE OF THE TREE

- **NO CONTRACT FILE CHANGED.** Suite untouched at 611 passing / 7 pending / 0 failing (not
  re-run this session — nothing it covers moved).
- **Committed and pushed as `51c57fd` on `v8.1`** — three explicit paths: `test_ab/replay.js`,
  `test_ab/world.js`, `V8_50_HANDOFF.md`. (Hash added in a follow-up commit; it did not exist
  when this section was written, and amending a pushed commit is worse than the gap.)
- `test_ab/replay.js` — `AB_EVICT`, `AB_QUEUE_EVERY`, `AB_FLOOR_BPS` plumbing, loans and
  rescues per member, per-matrix rescue medians, slim console, dial-encoded filenames.
- `test_ab/world.js` — returns the already-deployed `keeperLib`; optional
  `setInsolvencyFloorBps` from `AB_FLOOR_BPS`. No extra deployment, no extra transaction.
- Result files: `ab_result_v850_s{1,2,3}_census_evict[_floor{4000,4500,5000,6800,10000}].json`
  plus the v849b censused trio. The canonical no-census pair is untouched.

---

## NEXT, IN ORDER

1. **OWNER DECISION — PARAM 59.** Curve above; recommendation 5000. Nothing else in the
   release is blocked on it.
2. **⚠ OWNER QUESTION RAISED AT SESSION END, NOT YET ANSWERED — WHAT TO DO WITH LIVE V8.48:
   leave organic, bigfill to replenish the SF, or fund the SF directly.** Reasoning is in
   the session-8 write-up below this list. **The figures it would rest on ($212.35 balance,
   $518.24 outstanding, ~$125/day drain) ARE DAYS OLD AND ITEM 7 BELOW SAYS THEY ARE IN
   TENSION.** Re-measure before deciding.
3. **Router placement refusals, 11 → 53** on V8.50. Still unexplained. Untouched this
   session. Note they rose further under the floor sweep (57 → 59 at 6800), which is a clue
   that they track rescue throughput rather than being independent.
4. **Model self-rescue at a non-zero rate.** Now blocking more than before: sections 2, 5 and
   6 above all carry `SELF_RESCUE_RATE = 0` as their headline caveat.
5. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
6. **`maxItemsPerUpkeep`** — still vestigial at 20. Confirm deliberately or lower to 10.
7. **Re-run `diag_parked_growth.js` with `WINDOW=3000`.** Unchanged from session 7 and now
   also a prerequisite for item 2.

---

# ⬛ SESSION 7 STATE — 2026-08-18. READ AFTER SESSION 8, BEFORE SESSION 6.

**THE HEADLINE: SESSION 6'S ONE RESULT THAT "CONTRADICTS THE SCOPE" WAS AN INSTRUMENT
ARTIFACT. IT IS WITHDRAWN. Corrected and replicated 3 of 3 seeds: V8.50 CUTS TOTAL PARKING
BY ~42% AND HALVES DISTINCT EXPOSURE. Do not quote session 6's park table again — it is
struck through below.**

Also: the 68 VELOCITY `WorkItemFailed` are explained, fixed and gone (68 -> 0). Suite
606 -> 611 passing / 7 pending / 0 failing. Both pre-session-6 loose ends closed. Nothing
deployed, no chain written to, `.env` line 69 unchanged.

Commits: `8c60b64` (velocity), `e9d32b1` (diag_parked_growth), plus this session's harness
commit. Pushed to `v8.1`.

## ⛔ 1. THE 68 VELOCITY FAILURES — CAUSE FOUND, FIXED, CONFIRMED END TO END

`MatrixKeeper._setStabilityLayers` called `activateLayer(uint8,bool)` on the StabilityFund.
**That function was declared in `IStabilityFundKeeper` and implemented nowhere.**
`git log -S activateLayer -- contracts/StabilityFund.sol` returns **zero commits** — the
fund has never had it, in any version, since `a06aad4 V8.1 Elevator` introduced the caller.
The fund's layer model is 1, 3 and 5 (`receiveLayer` requires exactly those). Layers 2 and 4
do not exist in it. It was a call into a design V8.7 removed.

Measured (`test_ab/diag_velocity.js`, both arms, byte-identical): call 1 OK, calls 2-5
REVERTED "function selector was not recognized", `lastVelocityCheck` frozen from call 2,
`deflationState` never leaving NORMAL on any call.

**THE FAILED EVENT WAS NOT THE DAMAGE.** The revert discarded the whole of
`_doVelocityCheck`, including the `tierVelocityGreen` writes that run BEFORE the deflation
block. Harm band, per window: entries at/above `deflationThreshold` take the green branch and
pass; entries below `velocityThreshold` are correctly red anyway; **entries BETWEEN the two
mean the tier qualified for a green velocity gate and could not be given one.** That flag
throttles auto-upgrades and is read by index.html, status.html, gate_status.js, rr_keeper.js
and system_keeper.js.

Deleted rather than implemented: `deflationState` is read by NOTHING — no contract branches
on it, and there are zero hits for it, `DeflationStateChanged`, `activateLayer` or
`STATE_SLOW` across the frontend, keeper and mainnet repos.

**A/B re-run confirms it: V8.50 `workItemFailed` 68 -> 0, control unchanged at 68, and every
other figure byte-identical to session 6. Only `totalGas` moved, down 8,868,812.** So the
velocity bug was never confounding the park numbers — something else was.

⚠ **LIVE V8.48 STILL HAS THIS.** Caller since V8.1, implementation never. Every deployment
ever made carries it. Fixed for V8.50 only. Regression test: `test/V8_50_VelocityCheck.test.js`
(G5 is a tripwire that goes red if the fund ever gains an `activateLayer`).

## ⛔⛔ 2. THE PARK NUMBERS WERE WRONG. TWO DEFECTS, BOTH IN COUNTING, PULLING OPPOSITE WAYS.

**DEFECT A — TWO DIFFERENT EVENTS SHARE THE NAME `MemberParked`.**
`FigureEightMatrixV8.sol:98` — `MemberParked(address indexed member, uint256 shortfall)` —
a member ENTERING THE PARKED QUEUE.
`TierRouter.sol:372` — `MemberParked(address indexed member, uint8 tier, string reason)` —
TierRouter reporting it could NOT PLACE someone ("insufficient funds", "autoReentry
disabled"), emitted at :1458/:1496/:1499.

Different signatures, so different topic0, so the "first interface that parses wins" rule was
never violated — the damage was keying the bucket by `p.name`. Both landed in
`ev["MemberParked"]`. `args[0]` is `member` in both, so every per-member tally kept working,
silently, over a mixture. `args[1]` is `shortfall` in one and `tier` in the other, so
`shortfallVolume` was summing across both.

**DEFECT B — A QUEUE INSERTION THAT EMITS NO `MemberParked` AT ALL.**
`MatrixLogicLib:1516` (idle-slot reclaim) pushes to `parkedMembers` and emits
`SlotParkedIdle`, not `MemberParked`. The other six pushes (:527 :879 :906 :936 :977 :1937)
are each paired 1:1 with an emit on the next line, so the exact identity is:

> **queue insertions == MemberParked(matrix) + SlotParkedIdle**

Defect A inflated V8.50 (57 router refusals per run); defect B deflated the control (18-20
idle-slot parks per run). Opposite directions, different sizes per arm — which is the worst
possible shape, because it manufactures a difference between arms out of nothing.

### HOW IT WAS CAUGHT — THE QUEUE CENSUS, AND IT DISAGREED IMMEDIATELY

`test_ab/replay.js` now takes `AB_CENSUS=1`: it enumerates both matrices' parked arrays
before and after every keeper tick and diffs membership, so a member leaving the queue is
observed **whether or not anything was emitted**. Exits are attributed to a rescue or an
eviction only if a matching event fired in that same tick; everything else is recorded
SILENT rather than guessed.

First censused run: events said 139 park events / 71 distinct / 86% repeat. The census said
71 members, 71 episodes, **max 1 episode per member, ZERO re-parks.** Two instruments,
flatly opposed, same run. That contradiction was the whole finding — it was not explained,
it was measured.

⚠ It also refuted the guess this session STARTED with. Session 6's arithmetic gap
(139 - 47 - 9 = 83 expected vs 26 actual) looked like ~57 silent exits through the four
unemitting paths. **Measured `silentExitShare`: 0.0 on BOTH arms, all seeds.** The gap was
never exits. It was the park count itself. Predicting the answer before the instrument ran
would have sent the next session hunting a phantom.

### ✅ THE CORRECTED NUMBERS — 3 OF 3 SEEDS, `AB_CAP=5`, `MATRIX_SIZE` 127, 288 members

| | v849b (s1/s2/s3) | V8.50 (s1/s2/s3) |
|---|---|---|
| **queue insertions** | 142 / 140 / 142 | **82 / 82 / 80** |
| — of which idle-slot | 18 / 20 / 20 | **0 / 0 / 0** |
| router placement refusals | 12 / 11 / 11 | 57 / 51 / 51 |
| distinct parkers | 130 / 129 / 132 | **71 / 67 / 64** |
| repeat parkers (absolute) | 12 / 11 / 10 | 11 / 13 / 15 |
| repeat-park share | .092 / .085 / .076 | .155 / .194 / .234 |
| rescues | 88 / 84 / 86 | 47 / 47 / 45 |
| evictions | 1 / 1 / 0 | **9 / 10 / 10** |
| census episodes | 142 / 140 / 142 | 71 / 67 / 64 |
| censusMissed | **0 / 0 / 0** | 11 / 15 / 16 |

**READ IT THIS WAY:**

1. **Total parking is NOT unchanged. It falls ~42%** (141 avg -> 81 avg). Session 6's
   "~131 on both arms, every seed" was the artifact, and it was the entire basis for
   "V8.50 does not fix the loop".
2. **Distinct exposure halves** (130 avg -> 67 avg). That part session 6 had right.
3. **V8.50 eliminates idle-slot parking outright** — 18-20 per run on the control, ZERO on
   V8.50, all three seeds. Not previously noticed, and it is a real chunk of the reduction.
4. **The repeat-park "inversion" is mostly a denominator effect.** The ABSOLUTE number of
   repeat parkers is ~11 on the control and ~13 on V8.50 — the same handful of members. The
   SHARE rises from 8.4% to 19.4% because the base halved. That is a far weaker claim than
   "10% vs 86%", and it does not support "V8.50 concentrates parking onto repeat members".
5. **The census/event reconciliation is now printed every run.** Control reconciles EXACTLY
   (censusMissed 0). V8.50's gap of 11-16 is members who park and are rescued inside a single
   `performUpkeep`, invisible between snapshots — a lower-bound artifact of the census, and it
   tracks the repeat-parker count as it should. A NEGATIVE gap would mean an undiscovered
   insertion path; treat it as a stop-work signal.

### WHAT STILL STANDS, AND WHAT IS NOW OPEN

- **The fund claims are untouched** — loans per rescue, loan volume, SF balance, all
  unchanged by this correction. Item A holds.
- **Evictions ~10x, replicated 3/3 (9/10/10 vs 1/1/0), STILL UNEXPLAINED.** This is now the
  only surviving anomaly from session 6's list and it is the next thing to measure.
- ⛔ **`withdrawableOf` at rescue DOES NOT REPLICATE, and the failure to replicate is itself
  the observation.** Control: **$3.73 / $3.75 / $3.72** — remarkably tight. V8.50:
  **$7.43 / $4.45 / $2.15** — a 3.5x spread across seeds, straddling the control.
  Seed 1 alone would have read as "V8.50 rescues members with twice the support", which is
  the tidy refutation of session 6's UNVERIFIED hypothesis and was nearly written up as one.
  **It is not a result. Rule 5 caught it.** The variance itself needs explaining; sample
  sizes (29-36 vs 84-88) are smaller but not small enough to obviously account for it.
- **Router placement refusals jumped 11 -> 53** on V8.50. Unexplained, new, and it is the
  number that was polluting the park count — so it deserves a look on its own terms rather
  than as an accounting nuisance.

## TRAPS ADDED THIS SESSION

- **TWO CONTRACTS CAN DECLARE THE SAME EVENT NAME WITH DIFFERENT SIGNATURES, AND NOTHING
  WILL TELL YOU.** Bucketing parsed logs by `p.name` merges them. It is the sibling of the
  already-recorded double-count trap and it is harder to see, because the per-member
  accessors keep working. Key by name PLUS arity, or by topic0.
- **A NUMBER THAT LOOKS LIKE AN ANSWER, TWICE, FROM THE SAME BAD SOURCE.** Session 6 read
  139 park events on V8.50 and 136 on the control and concluded "unchanged". Both were wrong,
  by different amounts, and their agreeing was the artifact — two contaminated numbers that
  happen to be close read as a robust null result.
- **A DECLARED-BUT-UNIMPLEMENTED INTERFACE FUNCTION IS NOT A COMPILE ERROR.** Solidity
  compiles it and it fails at the one moment the branch is reached. `activateLayer` survived
  from V8.1 to now this way.
- **CHECK EVERY WRITER OF A QUEUE, NOT EVERY EMITTER OF AN EVENT.** `grep "push"` on the
  array found the seventh insertion path in one command; no amount of event archaeology would
  have. Same lesson as `diag_parked_growth.js` this session — count the state change, not the
  announcement of it.
- **THE INSTRUMENT MUST PRINT ITS OWN RECONCILIATION.** The census and the event tally are
  now compared in the result file on every run. Session 6 had both numbers available and no
  line that put them side by side, so a 2x discrepancy sat in plain sight.
- **`Select-String` filters are fine when the full result also lands in a FILE.** Used
  deliberately this session for the seed 2/3 runs; the JSON was written regardless.

## LOOSE ENDS — BOTH CLOSED

- **`scripts/diag_parked_growth.js`** — the uncommitted change was a previous session's
  finished work: it added `ParkedRescued` (the keeper's rescue, emitted by MatrixKeeper not
  the matrix, and the DOMINANT exit) and `GhostDequeued` to the exit accounting. Verified all
  three of its assumptions against the contracts before committing, then RAN it: **cumulative
  net 108 vs live queue 106.** Section 6f's "212 against a live queue of 105" is explained and
  closed. Committed as `e9d32b1`, plus it now REFUSES to start without `ADDRESSES_FILE` rather
  than defaulting to the dead V8.47 addresses — that standing trap is closed too.
  ⚠ That run reported **9 failed ranges** ("event-derived numbers are FLOORS"), while the SF
  section reconciled EXACTLY against the contract counters. Those two statements are in
  tension. Re-run with `WINDOW=3000` before quoting its park figures.
- **Eight stray `.txt` captures** — moved to `archive/captures/`, not deleted. Root is clean;
  `git status` shows only that untracked folder.

## STATE OF THE TREE

- `contracts/MatrixKeeper.sol` — `_setStabilityLayers` and its two call sites deleted, header
  corrected, full write-up left where the function was. 21,377 bytes, 3,199 headroom.
- `contracts/MatrixKeeperLib.sol` — the dead `activateLayer` declaration removed.
- `test/V8_50_VelocityCheck.test.js` — NEW, G1-G5. Red before the fix for the right reason.
- `test_ab/diag_velocity.js` — NEW, the velocity instrument, runs on both arms in seconds.
- `test_ab/replay.js` — event-name collision fixed, `SlotParkedIdle` counted, `AB_CENSUS=1`
  per-member queue census, census/event reconciliation printed every run. **Verified
  UNPERTURBED: a no-census run reproduces the canonical result byte-for-byte ignoring wall
  clock.** Censused runs write to `*_census.json` so they cannot overwrite the canonical pair.
- `scripts/diag_parked_growth.js` — committed, plus the addresses-file guard.
- `ab_results_session6/` — session 6's original result files, preserved before any re-run.

## NEXT, IN ORDER

1. **Explain the ~10x evictions (9/10/10 vs 1/1/0).** The last surviving session-6 anomaly.
   The census already records every eviction with its member and tick; extend it to record
   WHY discovery routed them to `WORK_EVICT_PARKED` rather than `WORK_PARKED_RESCUE` —
   `loanEligible` false, deadline order, or queue position. Session 6's UNVERIFIED guess
   (defect 6's deadline ordering reaching starved eviction work) is still unmeasured.
2. **Explain the withdrawable-at-rescue variance** ($2.15-$7.43 across seeds against a
   control that sits at $3.73 +/- $0.02). Until this is understood, no claim about member
   "support at rescue" is safe in either direction.
3. **Explain the router placement refusals, 11 -> 53.**
4. **Model self-rescue at a non-zero rate.** `SELF_RESCUE_RATE = 0` is still the pathological
   extreme by construction, and section 8 has said so since before session 6.
5. **Gate measurements 3 and 4** — MatA parkers freed outright, E1 base coincidence. These
   genuinely need a running system; that is what the private chain is FOR.
6. **`maxItemsPerUpkeep`** — still vestigial at 20; the floor halts the batch first. Confirm
   deliberately or lower to 10 on GAS-7's measured curve.

---

# ⬛ SESSION 6 STATE — 2026-08-18, LATER. ⚠ ITS PARK/LOOP TABLE IS WITHDRAWN — SEE SESSION 7.

**GATE MEASUREMENTS 1 AND 2 ARE ANSWERED. `minGasPerItem` MOVED 3_500_000 -> 5_000_000 ON
MEASUREMENT. NOTHING IS DEPLOYED, NO CHAIN WAS TOUCHED, `.env` LINE 69 IS UNCHANGED.**

Files changed: `contracts/MatrixKeeper.sol` (the value + its write-up),
`contracts/V8Governance.sol` (param 63 docs), `test/V8_50_KeeperGas.test.js` (six new
instruments). **Suite 602 -> 606 passing / 7 pending / 0 failing**, run in full after the
change (`npx hardhat compile --force` first). That file went 6 tests -> 10.

## ⛔ THE v8.49b vs V8.50 A/B — RUN, REPLICATED 3 SEEDS, AND IT CONTRADICTS PART OF THE SCOPE

**Harness:** `test_ab/` — one deterministic sequence file replayed on BOTH arms.
`contracts_v849b/` is `git archive de27329` (the V8.49 private-deploy commit); a second
hardhat config (`hardhat.v849b.config.js`) builds it into `artifacts_v849b/` so the V8.50
tree cannot be perturbed. `git log de27329..HEAD -- contracts/` = SIX commits, all V8.50, so
the A/B isolates exactly the release: item A + B + E1 + defects 2,4,5,6,7,8,9.

**Conditions:** 288 members, `MATRIX_SIZE` 127, seeds 1/2/3, `AB_CAP=5` on BOTH arms, all
grace periods 0, single tier, single pair. Validity gate passed on all three: 289 registered
and 0 keeper failures on both arms.

### ✅ THE FUND CLAIMS HOLD — 3 of 3 SEEDS, SAME DIRECTION

| | v849b | V8.50 |
|---|---|---|
| loans per rescue | 0.98 / 1.00 / 0.99 | **0.57 / 0.48 / 0.50** |
| loan volume | $106.91 / $96.23 / $108.19 | **$40.02 / $36.01 / $45.06** |
| SF balance at end | $20.23 / $24.97 / $13.28 | **$96.54 / $99.12 / $90.31** |
| distinct members who ever parked | 112 / 109 / 112 | **71 / 65 / 62** |

**Half of all rescues stop touching the fund. Lending volume falls ~60%. The fund ends 4-6x
healthier. ~40% fewer members are ever exposed to parking at all.** That is item A, measured
against a running control rather than projected onto V8.48 data.

### ⛔⛔ WITHDRAWN 2026-08-18 BY SESSION 7 — EVERY NUMBER IN THIS SUBSECTION IS WRONG.
###
### The park counts below came from a bucket that merged TWO DIFFERENT EVENTS both named
### `MemberParked` (the matrix's queue insertion, and TierRouter's placement REFUSAL), while
### missing a third insertion path that emits `SlotParkedIdle` instead. The errors run in
### OPPOSITE directions on the two arms, so the difference between them was manufactured.
###
### Corrected and replicated 3/3 seeds: queue insertions 142/140/142 (control) vs 82/82/80
### (V8.50) — a ~42% REDUCTION, not "unchanged". Repeat-park share .092/.085/.076 vs
### .155/.194/.234 — and the ABSOLUTE repeat-parker count is ~11 vs ~13, i.e. the same
### handful of members over a halved base. See SESSION 7 at the top of this file.
###
### KEPT BELOW UNALTERED because the reasoning is the record of how it went wrong, and
### because the FUND table above it is unaffected and still holds. Do not quote this table.

### ~~AND THE LOOP CLAIM DOES NOT HOLD. DO NOT QUOTE THE SCOPE ON THIS.~~

**~~TOTAL PARK EVENTS ARE UNCHANGED~~** — ~131 on both arms, every seed. What changes is who
they land on:

| | v849b | V8.50 |
|---|---|---|
| park events | 136 / 131 / 133 | 139 / 128 / 128 |
| distinct parkers | 112 / 109 / 112 | 71 / 65 / 62 |
| parked MORE THAN ONCE | 12 / 11 / 11 | **61 / 54 / 55** |
| repeat-park share | 0.11 / 0.10 / 0.10 | **0.86 / 0.83 / 0.89** |
| evictions | 1 / 1 / 0 | **9 / 11 / 10** |
| rescues | 88 / 84 / 86 | 47 / 44 / 44 |

**V8.50 HALVES THE NUMBER OF MEMBERS WHO EVER PARK, AND THE ONES WHO DO PARK CYCLE.**
Session 5's problem statement for live V8.48 was "83.2% came back". V8.50 shows **86%** here.
On this evidence V8.50 does not fix the loop — it reduces exposure to it.

**AND V8.50 EVICTS ~10x MORE** (≈10 vs ≈1 per run). Members removed rather than helped. It
performs HALF as many rescues yet ends with HALF as many parked; the arithmetic only closes
via those evictions plus repeat-rescues of the same members.

### WHAT IS HYPOTHESIS HERE, MARKED AS SUCH

- **UNVERIFIED:** that the extra evictions are defect 6's deadline-ordered discovery finally
  reaching eviction work V8.49 starved. Plausible and tidy; not measured.
- **UNVERIFIED:** that item A's cheaper rescues return a member with less support, so they
  re-park sooner. This is the obvious story for the repeat-park inversion and it is exactly
  the kind of explanation that is easy to believe because it is neat. **Measure it before
  building on it** — the instrument would be per-member: time-to-re-park and withdrawable
  balance at the moment of rescue, by arm.

### FIXTURE LIMITS — READ BEFORE GENERALISING ANY OF THE ABOVE

- `WorkItemFailed` is **68 VELOCITY on every run, both arms, identical**. Non-confounding
  (identical across arms) but unexplained. Worth a look before this harness is trusted further.
- **NO SELF-RESCUE IS MODELLED.** Section 8 already says `SELF_RESCUE_RATE = 0` is a
  pathological extreme, not a population — real members top up and pay. This harness is that
  extreme by construction, so the repeat-park figures are an upper bound on churn.
- Single tier, single pair, grace periods 0, cap pinned to 5 on both arms.

### ⛔ WHY THE CAP HAD TO BE PINNED — A REAL V8.50 BENEFIT, FOUND BY ACCIDENT

The first 127 run came back VOID: the CONTROL failed 7-8 keeper ticks, V8.50 failed none.
v849b has **no gas floor**, so with `gasLimit` 16.7M it attempts all 15 items, runs out of
gas and the transaction REVERTS. That is defect 8's rationale reproducing itself as an
experimental artifact — and it means **the control cannot execute the same workload the
subject can**. Pinning both arms to cap 5 (measured to fit at 5.11M) made the pairs valid.

Worth keeping: a whole class of V8.50 benefit is invisible in the valid runs precisely
BECAUSE the cap had to be pinned to make the comparison fair.

### HARNESS TRAPS — ALL FOUND BY THE INSTRUMENT CONTRADICTING ITSELF

- **Library events are not in a contract's ABI.** `RescueLoanIssued`, `SelfRescue` and
  `CoPayRescue` are all emitted from `MatrixLogicLib` (:1611/:1660/:1665/:1756). Parsing with
  contract interfaces alone reported **`loans: 0` alongside 18 completed rescues** — which
  would have read as "item A removed ALL the lending", the exact headline under test. **A
  zero that flatters the hypothesis deserves more suspicion than one that does not.**
- **Parsing one log with five interfaces double-counts.** The first version pushed every
  successful parse, multiplying every count. Ratios would have survived it; raw totals would
  have been silently wrong. It surfaced only because a second bug crashed the run.
- **A test's own leftover state is not a fact about the contract.** Record dials by READING
  THEM BACK; an intent flag proves nothing. The seed-1 equalised pair came back byte-identical
  to the default pair and there was no way to tell "the cap did not matter" from "the setter
  never fired".
- **`Select-String` with a non-ASCII pattern silently matches nothing** against a console that
  mangles UTF-8. It hid every keeper-failure line. Diagnostics go in the RESULT FILE.
- **A VOID pair is not a seed.** `compare.js` printed "3 seeds ✅" directly beneath three VOID
  banners before that was fixed.

### NEXT ON THE A/B

1. **Explain the repeat-park inversion** — per-member time-to-re-park and withdrawable-at-rescue,
   by arm. This is the one result that contradicts the scope and it should not stay a story.
2. **Explain the 68 VELOCITY failures.**
3. **Model self-rescue** at a non-zero rate; the current figures are the pathological extreme.
4. Only then treat the loop numbers as anything more than directional.

---

## ⛔ THE OWNER DECISION — `minGasPerItem` 3.5M -> 5M, TAKEN 2026-08-18

**The basis:** a cold SF-funded rescue at the live `MATRIX_SIZE` 127 measures **4.37M**.
3.5M sat below it, so the floor's own invariant — "the floor must exceed the worst single
item" — was violated. 5M is the smallest DAO menu value that clears it (15% headroom).

**The throughput cost, MEASURED after the change, not projected:**

| | floor 3.5M | floor 5.0M |
|---|---|---|
| GAS-1 cap 20 at 127 | 9 items, 12.22M | **8 items, 10.81M** |
| GAS-8 halt points across 6M..16M budgets | 2/4/6/6/8/9 | **1/3/5/6/7/8** |

About ONE item per batch — cheaper than the ~2 rescues/tick projected when the decision was
put to the owner. Deferred work is not lost; the next tick takes it.

**Why not keep 3.5M:** no cascade could be reproduced under it (GAS-8, zero
`WorkItemFailed` across every budget), because of a COUPLING — walking gas down to the floor
requires running rescues, and running rescues warms the path. But that is an ARGUMENT, it
holds only WITHIN ONE TIER, and per defect 8 the failure does not announce itself. **Why not
7.5M:** it costs roughly half the rescue throughput for headroom nothing measured needs.

⚠ **The live keeper scripts still carry `GAS_PER_ITEM_DEFAULT = 3_500_000`**
(`direct_keeper.js:27`, `direct_keeper_vps.js:26`). LEFT ALONE DELIBERATELY — they run
against **live V8.48**, which has neither item A nor E1, and editing them is a live change
on the community chain. Revisit them with the V8.50 deploy, not before.

## THE METHOD CHANGE THAT MADE THIS POSSIBLE — READ FIRST

**`MATRIX_SIZE` IS A CONSTRUCTOR ARGUMENT, NOT A COMPILE-TIME CONSTANT.**
`FigureEightMatrixV8.sol:43` declares it `immutable`; `:167` assigns it from `_matrixSize`.
`V8_50_KeeperGas.test.js`'s `deployWorld(size)` ALREADY took it as a parameter — the only
thing pinning the whole file to 7 was one line, `const SIZE = 7`.

So **live-size gas is measurable in-process, with no deploy and no chain**, in ~15 seconds
per run. The gate was scoped as "private chain, bigfill, hours not days" because nobody had
noticed that. The private chain is still needed for gate measurements 3 and 4 — those need
a running system — but the number the gate was BUILT for did not need it.

`SIZE` and the population are now env knobs (`GAS_MATRIX_SIZE`, `GAS_POP`), **defaulting to
exactly the old fixture**, so the suite result is unmoved. Run the gate measurement with:

```powershell
$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js
Remove-Item Env:\GAS_MATRIX_SIZE
```

## ⛔ GATE MEASUREMENT 1 — ANSWERED, AND IT IS NOT ONE NUMBER

**AN SF-FUNDED RESCUE HAS THREE DIFFERENT PRICES AT `MATRIX_SIZE` 127, AND WHICH ONE
APPLIES DEPENDS ENTIRELY ON WHERE IT SITS IN THE BATCH.** This is the single most important
thing in this section; every wrong turn below came from collapsing them into one figure.

| when it runs | cost | how it was measured |
|---|---|---|
| **item #1, all storage cold** | **4.37M** | GAS-2 isolated AND GAS-7 curve k=1 — two independent methods, agreeing to 0.1% |
| **first SF item mid-batch** (shared state warm, fund state cold) | **2.83M** | GAS-7, 2 self-funded first then +1 SF-funded |
| **fully warm, mid-batch** | **1.43M** | GAS-7 curve steps: 1.46 / 1.43 / 1.43 / 1.41 |

Self-funded (item A's shape): **2.38M cold, 0.84M marginal.**

`minGasPerItem = 3.50M` sits BETWEEN the mid-batch price and the cold price.

### THE SCALING NOBODY HAD EVER MEASURED

| | size 7 | size 31 | size 127 |
|---|---|---|---|
| worst SF-funded rescue (cold) | 1.76M | 2.16M | **4.37M** |
| self-funded (cold) | 0.93M | 1.24M | 2.38M |
| worst `register` | 2.00M | 2.62M | **7.50M** |
| SF ÷ self ratio | 1.61x | 1.72x | **1.83x** |

Roughly linear, ~23k gas per matrix position. **`_distributeChainPay` is why**
(`MatrixLogicLib:1317`): it walks the MATRIX POSITION tree (`parentPos = myPos / 2`), so
depth is set by `MATRIX_SIZE`. At 7 it reaches 2 levels; at 127 all 6 `CP_BPS` levels fire.

**ITEM A'S GAS DIVIDEND GROWS WITH MATRIX SIZE — 1.61x -> 1.72x -> 1.83x.** Item A is worth
more at live scale than any measurement before this showed.

## ⛔ GATE MEASUREMENT 2 — ANSWERED. THE GUARD WORKS.

`BatchGasHalted` fires at live matrix size, halts cleanly, and defers rather than drops.
Under the SHIPPED 3.50M floor, swept across six transaction budgets (GAS-8):

| budget | gasUsed | halted at | `WorkItemFailed` |
|---|---|---|---|
| 6M | 2.76M | 2/20 | **0** |
| 8M | 4.31M | 4/20 | **0** |
| 10M | 7.96M | 6/20 | **0** |
| 12M | 7.96M | 6/20 | **0** |
| 14M | 10.81M | 8/20 | **0** |
| 16M | 12.23M | 9/20 | **0** |

**ZERO items failed at any budget.** The floor halted first, every time.

### ✅ CLOSED BY MEASUREMENT — the 10M/12M rows were never an anomaly

Both halted at 6/20 with the same 7.96M `gasUsed`, but `gasRemaining` differs exactly as it
should: **1.43M at a 10M budget, 3.43M at 12M** — 2M apart, the budget difference. Overhead
is identical to the gas unit: `10.00 − 7.96 − 1.43 = 0.61M` and `12.00 − 7.96 − 3.43 = 0.61M`.

Both halted at the same item because both fell below the floor; the 12M case only *just*
did. **The refund hypothesis was unnecessary** — printing `gasRemaining` from the event made
the real answer obvious. Note how tight the guard runs at its boundary: **3.43M against a
3.50M floor is 70k of margin, and the 8M row halts at 3.48M — 20k under.**

## ⛔ THE FLOOR DECISION IS NOT YET SAFE TO TAKE — ONE MEASUREMENT SHORT

GAS-6 currently FAILS at 127: floor 3.50M vs worst item 4.37M. **That failure is honest and
it stays red until this is settled** — but the comparison may be the wrong one, and the
reason matters:

- The floor asks *"can I afford ONE MORE item?"*. It only ever answers for an item arriving
  **late**, when gas is scarce. At item #1 `gasleft` is the whole budget, ~15M, nowhere near
  any floor. **So the 4.37M cold price may be one the floor never has to cover.**
- Against the mid-batch price it actually covers — 2.83M — the 3.50M floor has 24% headroom,
  and GAS-8 measured zero failures across every budget.

**THE ONE THING THAT WOULD OVERTURN THAT: THIS FIXTURE HAS ONE TIER.** The cold premium is
paid by whichever item touches a given tier's storage FIRST. With one tier that is always
item #1, when gas is plentiful. **With two tiers, the first item touching tier 2 pays it
LATE, with gas scarce.** Decomposing the measured numbers: 4.37M cold − 2.83M first-touch =
~1.53M of shared/tier cold state. A cross-tier first touch mid-batch would plausibly cost
~2.83M + ~1.53M ≈ 4.36M, arriving when only ~3.5M remains.

**THAT IS A PROJECTION, MARKED UNVERIFIED. DO NOT SET THE FLOOR ON IT.** Live T2 exists
($25.00, per session 5), so multi-tier batches are reachable and this is not hypothetical.

### ⛔ GAS-9 — ARRIVAL CONTEXT SETTLES IT: THE INVARIANT IS GENUINELY VIOLATED

The 2.83M mid-batch figure was measured after a prefix of **self-funded rescues**, and a
self-funded rescue crosses A->B — it warms both matrices and most of the crossing path
before the SF item runs. That is a generous prefix and it flattered the floor.

Priced against three arrival contexts (GAS-9, `MATRIX_SIZE` 127):

| prefix | prefix gas | the SF rescue costs |
|---|---|---|
| item #1, nothing warm | — | **4.36M** |
| after 6 cheap items (evict/reclaim) | 0.37M | **4.31M** |
| after 2 self-funded rescues | 3.24M | 2.83M |

**CHEAP HOUSEKEEPING WARMS NOTHING THAT MATTERS.** An SF rescue after six evictions still
costs 4.31M — 99% of the full cold price. The smallest DAO menu value that clears it is
**5M**. So `minGasPerItem = 3.5M` does violate its stated invariant, and GAS-6 is right to
be red.

### ⚠ BUT A VIOLATED INVARIANT IS NOT A REACHABLE FAILURE — AND THAT DISTINCTION IS THE
### WHOLE ARGUMENT, SO DO NOT SKIP IT

For the cascade to actually fire, `gasleft` must be near the floor **at the moment a COLD
4.31M item starts**. In a SINGLE-TIER world those two cannot co-occur:

- burning ~12M of budget REQUIRES running rescues;
- running rescues WARMS the expensive path, after which the next one costs 1.43M;
- cheap items cost ~0.12M, so a cap-20 batch of nothing but evictions burns ~2.4M total —
  it can never walk gas down to the floor while leaving anything cold.

**GAS-8 measured exactly that: zero `WorkItemFailed` at every budget from 6M to 16M.**
The floor is currently saved by a COUPLING between "burning gas" and "warming state".

### ⛔ A SECOND TIER BREAKS THAT COUPLING. THAT IS NOW THE ONLY QUESTION LEFT.

Tier-1 rescues burn gas while **tier-2 storage stays cold**. That is the one shape where a
cold ~4.3M item can arrive with ~3.5M remaining — and it is the shape a live multi-tier
chain produces naturally. Live T2 exists ($25.00, session 5), so this is not hypothetical.

**DO NOT SETTLE `minGasPerItem` UNTIL THIS IS MEASURED.** If the coupling holds, 3.5M ships
and GAS-6 gets rebased with the reasoning written at the point of the change. If it breaks,
the answer is 5M, and GAS-8's table is the tool for costing the throughput given up.

### ⛔ THE CHEAP SHORTCUT IS DEAD — A SECOND *PAIR* CANNOT BE REACHED BY A RESCUE

A second matrix PAIR in the same tier looked like a free stand-in for a second tier: different
contracts, therefore cold storage, reachable without the upgrade gate. **It is not reachable
at all.** `PairManagerV8.rescueReentry` (V8.48 item 10):

```solidity
uint256 destPair = fromPairIndex;          // a rescued member ALWAYS returns to their own MatA
if (isActiveInMatrix(member) ...) { destPair = _freePairFor(...); }   // duplicate guard only
```

The second-pair branch fires ONLY for a member already seated in that pair. A PARKED member
holds no seat, so `destPair` is always the pair they came from. GAS-10 measured exactly this:
**`matA2 0 -> 0, matB2 0 -> 0`, `pair2 seats 0` on every row.**

That routing is CORRECT and deliberate — it fixed a measured live loop (2026-08-09: 65% of
parked members sitting in MatB, MatA rotating 9.8x slower). Do not "fix" it.

**THE LESSON IS THE INSTRUMENT, NOT THE ROUTING.** GAS-10 v1 had no occupancy check and
printed **"NO CASCADE"** — a clean pass over an experiment that never once touched cold
storage. It also swept five budgets in ONE world (snapshots undo deployments), so each row
tested a more depleted world than the last: the 16M row, nominally the strongest, burned
0.59M and rescued NOBODY, and was counted as a pass. Two independent ways of reporting a
false negative in one test. It now reads matA2/matB2 occupancy, prints a `pair2 seats`
column per row, rebuilds a FRESH world per budget, and says INCONCLUSIVE rather than passing
when the cold pair was never touched.

### BUILDING THE TWO-TIER FIXTURE — WHAT IT COSTS, MEASURED BEFORE STARTING

`PairManagerV8.registerFor` is gated (`require(msg.sender == tierRouter)`, `:529`) and
`TierRouter._manualUpgrade` (`:922`) requires `_requireUpgradeEligible`. **The gate has an
open door**: `_upgradeEligible` (`:888`) returns true for any member ACTIVE IN A MatB of the
previous tier, and this fixture has ~127 of those — no cycles or unlocks needed.

**The real cost is POPULATION, not the gate.** Tier 1 needs its own ~254 members to fill and
produce parked work, against 300 accounts configured in `hardhat.config.js` of which 298 are
already spent. That means impersonated accounts inside the test (`impersonateAccount` +
`setBalance`) — test-local, no shared config change — plus ~250 more registrations.

**⚠ AND IT IS ONLY NEEDED IF 3.5M IS KEPT.** Setting the floor to 5M satisfies the invariant
against the measured 4.37M worst item regardless of how many tiers exist, which makes this
whole build unnecessary for the FLOOR decision. It would remain interesting for the CAP.

### THE NEXT MEASUREMENT, AND IT IS THE LAST ONE BEFORE THE FLOOR CAN BE CHOSEN

Build a **TWO-TIER** fixture in `V8_50_KeeperGas.test.js` and measure the cost of the first
item touching tier 2 mid-batch. Then:

- if it stays under 3.50M — the shipped floor holds, and GAS-6 should be REBASED onto the
  mid-batch price with the reasoning written at the point of the change;
- if it exceeds 3.50M — the floor moves. Menu is 2.5M / 3.5M / 5M / 7.5M (DAO param 63);
  5M clears the 4.37M cold price by 15%, 7.5M by 72%, and GAS-8's table is the tool for
  costing the throughput each choice gives up.

## THE CAP — `maxItemsPerUpkeep` 20 IS FINE, AND GAS-4'S MODEL WAS WRONG

GAS-4 projected a saturated batch as `worst single rescue x cap` and concluded NOTHING fits
at 127 — not even a cap of 5 (21.83M vs the 17.80M ceiling). **GAS-1 measured a batch
containing 8 rescues at 12.22M on the same world in the same run.** Both cannot be true.

The projection multiplies a COLD-START cost by every slot. Slots 2..n find warm storage.
GAS-7 now measures cold and marginal separately, and a saturated SF-funded batch costs
`4.36M + (n−1) × 1.43M`:

| cap | projected | |
|---|---|---|
| 5 | 10.10M | fits |
| 10 | 17.27M | fits |
| 15 | 24.44M | EXCEEDS |

GAS-4's hard assertion is **demoted to a report off-baseline** — failing on a model this
file has itself disproved is the definition of crying wolf. It still guards the original
claim at size 7.

## TWO CORRECTIONS TO THINGS PREVIOUSLY WRITTEN DOWN

1. **`MatrixKeeper.sol:236` says the V8.49 chain "measured ~2.6M for the same item at the
   live 127". It did not.** `testchain_keeper.js:285` records the provenance: *"cost per
   rescue rose from ~600k (15 items, 9.0M) to ~2.6M (5 items, 12.9M)"* — **2.6M was a BATCH
   PER-ITEM AVERAGE**, 12.9M ÷ 5, not an isolated item cost. The comparable V8.50 figure is
   12.22M ÷ 9 = **1.36M per item**, i.e. V8.50 batches are CHEAPER per item than V8.49.
   This session initially claimed the estimate was "68% low" by comparing it against the
   4.37M isolated cost — two unlike quantities. **Fix the comment when the floor is settled.**
2. **The 17.8M CEILING is an RPC limit, not a registry setting.**
   `V8_46_CascadeGas.test.js:57`: *"public Base Sepolia rejects above ~17.8M (-32003)"*.
   `system_keeper.js:582` sends overflow batches with `gasLimit: 15_000_000`.

## TRAPS ADDED THIS SESSION

- **The hardhat provider caps ONE transaction at 2^24 = 16,777,216 gas.** The original
  `16_000_000` register limit sits just under it. A 29M limit is refused outright.
  **It is below the 17.8M ceiling**, so an in-process run CANNOT observe a batch costing
  between 16.78M and 17.80M — the tx is refused and reports no gas at all. Unhandled, that
  refusal reads as "the item did not complete", identical to a floor refusal. That is defect
  8's failure mode inside the instrument built to detect it. Every catch in the gas file now
  identifies the cap error explicitly; capped batch rows report UNMEASURABLE, never zero.
- **A cost curve that mixes rescue KINDS produces a number describing no item that exists.**
  GAS-7's first version reported "cold 2.38M, marginal 1.47M" — the 2.38M was the
  *self-funded* median, because discovery happened to hand it self-funded items first. The
  giveaway was the step column: 0.86 / 0.83 / **2.83** / 1.43 / 1.42. Curves are per-kind now.
- **A TEST THAT MUTATES A CONTRACT VALUE MUST RESTORE BEFORE REPORTING IT.** GAS-9's first
  version set `minGasPerItem` to 2.5M so the guard could not interfere with its measurement,
  then read the value back afterwards and printed **"shipped floor 2.50M"** — its own
  leftover state, reported as a fact about the contract. It now `snap.restore()`s before
  reading. A wrong figure printed confidently into a captured artifact is worse than none.
- **A deep-referral fixture would have been WASTED WORK.** Chain pay walks matrix POSITION
  (`myPos / 2`), not the referral graph. Referral depth changes one L1 credit slot from warm
  to cold — tens of thousands of gas, not millions. One grep, not a fixture.

## STATE OF THE TREE

- `contracts/MatrixKeeper.sol` — `minGasPerItem` 3_500_000 -> **5_000_000**, plus the
  measured write-up and the ~2.6M provenance correction.
- `contracts/V8Governance.sol` — param 63 docs corrected; allowed-values array already
  contained 5_000_000, so no menu change was needed.
- `test/V8_50_KeeperGas.test.js` — size/population knobs (`GAS_MATRIX_SIZE`, `GAS_POP`),
  GAS-7 (per-kind cost curves + mid-batch first touch), GAS-8 (floor sufficiency sweep),
  GAS-9 (cost by arrival context), GAS-10 (cold-pair coupling test — INCONCLUSIVE by
  construction, see above), cap-error handling throughout, and `ok` / `halted` /
  `gasLeft@halt` / `pair2 seats` reporting. `LIVE_WORST_COLD_RESCUE = 4_366_374n` is the
  named basis for GAS-6's live check.
- **`GAS-8` reads the shipped floor FROM THE CONTRACT** rather than restating it — a
  hardcoded copy would have kept asserting the old value's sufficiency after the default
  moved, passing while measuring a floor nobody ships.
- Baseline at size 7 re-verified byte-identical after every edit: 1.23/4.52/4.67/4.72/4.90/
  4.90M, 0.93/1.49/1.76/0.10/0.04M, 1.61x, `9 of 20`, `6.47M left`.
- Captures: `gas_size7_baseline.txt`, `gas_size31.txt`, `gas_size127*.txt` (all UTF-8, not
  `Tee-Object`).

## NEXT, IN ORDER

1. **Gate measurements 3 and 4** — MatA parkers freed outright (PHASE 2 projects 67 of 67)
   and E1 making the aggregate and ledger bases coincide. These DO need a running system,
   so they are what the private chain is now FOR. Measurements 1 and 2 are done and the
   private chain no longer has to discover them.
2. **Re-run `model_item_a.js`** against the private V8.50 chain and re-check PARAM 59 and
   the ladder rung on a running system. Expected to hold — which is a hypothesis, so rule 2.
3. **Two-tier fixture — NO LONGER BLOCKING.** 5M clears the measured worst item whatever
   the tier count, so this is now a CAP question, not a floor question. Worth doing before
   `maxItemsPerUpkeep` is revisited; not worth delaying the deploy for.
4. **`maxItemsPerUpkeep` is unfinished business.** GAS-7's measured curve says a saturated
   SF-funded batch fits the 17.8M ceiling at cap 10 (17.27M) and EXCEEDS at 15 (24.44M).
   The shipped cap is 20. It has never bitten because the floor stops the batch first — but
   the cap is now doing nothing the floor does not already do better, and that should be
   either confirmed deliberately or the cap lowered to 10 on this measurement.

---

# ⬛ SESSION 5 STATE — 2026-08-18. READ THIS FIRST, BEFORE SESSION 4.

**V8.50 IS CODE-COMPLETE ON EVERYTHING FOUND SO FAR. NOTHING IS DEPLOYED. NO CHAIN WAS
TOUCHED. `.env` line 69 is unchanged.** Suite: **602 passing / 7 pending / 0 failing**
after `npx hardhat compile --force`. Branch `v8.1`, pushed.

## BUILT AND TESTED THIS SESSION

| item | what it is |
|---|---|
| **E1** | the crossing carries the member's balance across — closed the LEDGER SPLIT that stranded journey-A earnings where the re-entry gate could not see them |
| **defect 2** | deleted `DIRECT_EARN_BPS` (public, and wrong since V8.32) |
| **defect 4** | `totalEarnedOf` added; keeper deliberately NOT repointed — renamed to `claimableEver` |
| **defect 5** | `maxItemsPerUpkeep` 15 -> 20, measured not estimated |
| **defect 6** | discovery ordered by DEADLINE — parked work no longer starves behind ghost/reclaim |
| **defect 7** | the KeeperScan pins never collapsed anything; a 4th pin stops the batch truncating |
| **defect 8** | **the gas floor.** An OOG batch does NOT revert — it cascades WorkItemFailed and looks like a refusal |
| **defect 9** | `MemberEntered` fired for members who were PARKED, not seated |

## CLOSED BY MEASURING — NO CODE CHANGE

- **PARAM 59 stays 3400.** 5000 refuses the identical member. Replicated across 3 samples.
- **Ladder stays preset 1.** Nobody below the 4000 rung; presets 2/3 rescue 0 more.
- **Tier-gate recalibration: nothing to recalibrate.** Live T2 is $25.00; 0 of 38 upgrade
  at cycle-out in EITHER world. The acceleration was V8Elevator's fixture ladder.
- **Item D: does not occur.** 0 shallow seats in 1412 real seatings, 0 reclaims.

## THE OPERATIONAL FINDING THAT MATTERS MOST

**The self-sustaining loop is real, and the fund is underwater.** 773 park events across
339 members — only **57 parked once and stayed out**; 83.2% came back. SF outstanding
**$509.46** against a balance of **$192.99**, draining all session. **Item A removes
62-65% of ALL funding parks (~$724 of lending) and frees 67-75 of 67-75 MatA parkers
outright.** On these numbers V8.50 is not an improvement, it is the fix.

## OPEN — NOTHING BLOCKING

1. **Nothing is deployed.** The scope's plan is V8.50 -> private chain -> measure -> the
   one member-facing deploy the community re-registers into. Both owner decisions and the
   PHASE 7 tables are PROJECTIONS onto V8.48 data; **re-run the model after a private
   deploy before treating them as settled for a running system.**
2. **Four exit paths emit nothing** (`enterMatrix` re-entry, `forceCross`, `exitSeat`,
   `deductForUpgrade`). `diag_parked_growth`'s `net` is an upper bound; `getParkedCount`
   is exact. Not a defect — a documented limit.
3. **The ACCELERATING/LINEAR rate label is noise** at current precision (crossed its
   threshold by 0.2 parks/day). The loop conclusion rests on the repeat share and the
   climbing SF outstanding, not on that label.
4. **Four commit bodies have mangled dollar figures** (`fe3f594`, `da622c1`, `56140d3`,
   `2011eed`). Not rewritten; **this document is the record.** Use `git commit -F` — see 6g.

## ⛔ THE V8.50 DEPLOY GATE — DECIDED 2026-08-18
> ✅ **THIS SECTION IS NOW A RUNBOOK PHASE — `GO_LIVE_RUNBOOK.md` PHASE G (session 27).**
> Four measurements, exact commands, pass/stop conditions on each. Run that, not this.
> ⛔ **AND TWO NUMBERS BELOW ARE STALE.** `minGasPerItem` has been **5,000,000** since the
> owner decision of 2026-08-18 (`MatrixKeeper.sol:290`); the "3.5M" in the risk list and in
> the measurement table's *against* column is the pre-decision value. **Do not carry 3.5M
> into the run.** ✅ And **risk 2 is CLOSED** — defect 9's cascade-refill path got coverage
> in `test/V8_50_EvictionReserve.test.js` (20.4). Risks 1, 3 and 4 remain.

**The question asked:** ship V8.50 to the community and measure it live, simultaneously?
**The answer: no — private chain first, but a SHORT one with a closed list.**

### WHY NOT STRAIGHT TO THE COMMUNITY

The economics are measured to exhaustion and are NOT the risk. Item A frees 67 of 67 MatA
parkers, removes 62-65% of funding parks, and both owner decisions replicated across three
independent samples. **The risk is one number and one untested path:**

1. **EVERY GAS FIGURE WE HAVE IS `MATRIX_SIZE` 7. LIVE IS 127.** `minGasPerItem = 3.5M` is
   a SAFETY mechanism, and its only live-size input is a ~2.6M ESTIMATE carried from V8.49.
   Set it too low and the batch enters work it cannot finish — which, per defect 8, does
   **not revert loudly**. It degrades into a cascade of `WorkItemFailed` indistinguishable
   from a floor refusal. **A wrong value here hides itself.**
2. **Defect 9's code path has NO test coverage** — stated in the contract at
   `MatrixLogicLib:543`. No fixture builds a cascade that refills every seat.
3. **Defect 8's gas floor has never run on a real chain.**
4. **PHASE 7/8 are PROJECTIONS onto V8.48 data.** E1 is not deployed anywhere.

And re-registration is something you do to a community **once**. A private failure costs a
redeploy; a community failure costs the one member-facing event the scope has been
protecting since it was written.

### THE GATE — FOUR MEASUREMENTS, THEN SHIP

Private chain at **`MATRIX_SIZE` 127**, bigfill to force real rescues. Hours, not days.
The community stays on V8.48 throughout — that IS the "simultaneous", with the risk on our
side of the line.

| # | measure | against |
|---|---|---|
| 1 | gas per SF-funded rescue at 127 | 1.76M measured at size 7; ~2.6M assumed at 127 |
| 2 | `BatchGasHalted` fires, and at what batch size | `GAS-5` halted 9 of 20 at size 7 |
| 3 | MatA parkers freed outright | PHASE 2 projects 67 of 67, 100% |
| 4 | E1 makes aggregate and ledger bases coincide | PHASE 6 claims it "by construction" |

**If (1) lands above 3.5M, `minGasPerItem` is wrong and must move BEFORE the community
deploy.** That single number is the whole reason this gate exists.

**THEN re-run `model_item_a.js` against the private V8.50 chain** and re-check PARAM 59 and
the ladder rung on a RUNNING system rather than a projection. Both are expected to hold —
they held across three samples — but "expected to hold" is a hypothesis, and rule 2 applies.

### AND RUN THE FRONTEND ABI AUDIT BEFORE THE ADDRESSES CHANGE

`scripts/audit_frontend_abi.js` (new, read-only). Walks EVERY ABI fragment the frontend
declares and diffs it against the compiled V8.50 artifacts. Two failure modes:

- **MISSING** — the frontend calls something V8.50 does not have. Breaks on deploy. Loud.
- **SHAPE DRIFT** — selector matches, OUTPUTS differ. The call succeeds and decodes to the
  **wrong value**. Silent, and the reason this is a tool rather than a grep.

A 2026-08-18 spot-check of the eight surfaces V8.50 changes came back clean: the frontend
does not read `DIRECT_EARN_BPS` (deleted in defect 2), does not consume `MemberEntered`
(defect 9), and its crossing hold at `index.html:7509` (`ENTRY_FEE - crossingReserve`)
matches `MatrixLogicLib:715`, which holds the FULL fee under item A **deliberately** — it
is the savings lock for the re-entry, not the crossing price. **Reassuring, not conclusive.
Run the full differ.**

### ✅ THE DIFFER RAN — V8.50 PASSES. 7 findings, ZERO of them V8.50's.

241 fragments across 23 frontend files against 106 compiled contracts.

**Every finding predates V8.50 and none blocks the deploy:**

| finding | verdict |
|---|---|
| `getMember` x2 (SHAPE DRIFT) | **V8.50 never touched it** — the only `getMember` in the diff is `getMemberTotalWithdrawn`, a substring. The live site runs this exact contract TODAY. All fields static, so the frontend's 9 decode positionally correct against the contract's 10; it reads `crossingReserve` separately via `crossingReserveOf`. Works, and is tech debt not a break. |
| `topUpAndCross` | **REMOVED AT V8.32** (`1e28ae9`), four versions ago. `api/rescue.js:131` still CALLS it. **The admin rescue endpoint is dead and has been since V8.32.** |
| `hasEverJoined` | never existed as a function — it is a FIELD of the `getMember` tuple. Frontend error. |
| `usdcBalance`, `distributeInterval`, `getFloorPrice` | never present in `contracts/`. `CryptoNovaLP.sol` and `CNOVADirectSale.sol` both exist, so these are functions the frontend invented. |

**THE ANSWER TO THE QUESTION ASKED: nothing V8.50 changes breaks the frontend.** The eight
V8.50-changed surfaces are clean and the full differ confirms it across all 241 fragments.

**SEPARATELY, FIX WHEN CONVENIENT — these are broken NOW, on V8.48:** the dead
`/api/rescue` endpoint is the only one with teeth; the other four are declarations the
frontend never successfully calls.

### ⛔ AND THE DIFFER'S FIRST RUN WAS WRONG — WHICH IS WHY IT GOT FIXED BEFORE USE

It reported **23 problems**. Seventeen were noise:

- **Output comparison used `format("full")`, which includes the PARAMETER NAME.** So
  `returns (uint256)` vs `returns (uint256 locked)` — identical types — read as drift.
  ~15 false alarms. Now compares TYPES only (`sighash`).
- **It assumed every fragment the frontend declares is ours.** Multicall3's `aggregate3`
  was reported as "MISSING from V8.50", which is true and irrelevant. Now reported as
  EXTERNAL, against a deliberately tight allowlist.

**A tool that cries wolf gets skimmed, and a skimmed tool is worse than none.** The report
was NOT handed over at 23; the instrument was fixed first and re-run. 23 -> 7 -> 0 that
matter.

⚠ **THE DIFFER CHECKS THE INTERFACE, NOT THE MEANING.** A function can keep its exact
signature and change what its number MEANS — item A halved the crossing price without
touching a single selector. Semantic drift needs reading, and the crossing-hold check above
is the shape of that reading.

---

## READ NEXT, IN THIS ORDER

**7a (THE TWO RULES)** — owner-set, and the session that earned them got five things wrong
by ignoring what they say. Then 6f (the loop and the fund), then 6d (the two decisions).

---

# ⬛ SESSION 4 STATE — 2026-08-16, LATE. READ THIS FIRST, BEFORE SESSION 3.

Session 3's "NEXT, IN ORDER" list is DONE, items 1–3. Nothing below this section is
contradicted; two things are **extended** and one **sharpened**, each marked.

## WHAT SHIPPED — SIX TEST FILES RE-FIXTURED, NO CONTRACT CHANGED

**Not one line of `contracts/` was touched this session.** Every change is in `test/`.
That is the headline: the 9 new failures session 3 attributed to item A were all
fixtures encoding pre-item-A economics, exactly as it said, and none of them was a
defect in the item A code.

| file | was | now |
|---|---|---|
| `V8_48_SplitGrace.test.js` | 3 failing | 0 |
| `V8_48_GhostFloor.test.js` (GF-D1) | 1 of its 3 | 0 of that 1 |
| `V8_49_InsolvencyFloor.test.js` (IF-7, IF-10) | 2 failing | 0 |
| `V8_49_EvictionClock.test.js` (EC-1/2/4) | 3 failing | 0 |
| `V8_48_RescueSurplus.test.js` | 3 failing | 0 |
| `V8_48_KeeperScan.test.js` | 9 failing | 0, **plus one new test** |

## ⛔ EXTENSION 1 — STEP 1 WAS SIX TESTS. IT IS NINE, AND THEY ARE ONE BUG.

Session 3's step 1 named `SplitGrace ×3, GF-D1, IF-7, IF-10`. Its own effect-(a)
paragraph also lists **the floor legs of EC-1/EC-2/EC-4**, and the run confirms those
three fail for the identical reason and are fixed by the identical edit. The "6 of 9" in
that paragraph is a slip: the list under it has nine entries and all nine are effect (a).

**All nine have ONE root cause and ONE fix.** Every one of them builds its parked member
on the `MockKeeperScan` harness with `MockMatrixK(FEE, true)` — a **MatA**. Under item A
a MatA crossing costs the reserve carve, and every one of those fixtures gives the member
a $5.00 reserve, so all nine members became SELF-FUNDED, `sfShare` went to 0, and the
ladder, the floor and the loan-grace window all stopped being reachable. The failures say
so literally: `expected [ 4 ] to deeply equal [ 6 ]` — RESCUE where the test wanted EVICT.

**THE FIX, AND WHY IT PRESERVES EVERY NUMBER.** Each member moved to the pair's MatB —
`MockMatrixK(FEE, false)` — where a cycle-out re-enters a MatA at the FULL fee and the
loan path still exists. Their money moved with them: **withdrawable becomes the old
(withdrawable + reserve), reserve becomes 0**, because item A leaves a MatB member holding
no reserve; it was spent getting them there.

That substitution is exact. `effectiveContrib` is unchanged, the price basis is back to
the full fee, so **every wBps, every shortfall and every sfShare in all nine tests is the
same number it was before item A**. Not one assertion's expected value was edited. The
fixtures changed matrix and pocket; the rules under test did not move.

- ONE EXCEPTION, and it is the rule not an exception to it: EvictionClock's **RATIO**
  member keeps `withdrawable $2.00`. `rescueRatioBps` is `withdrawn/(withdrawn +
  withdrawable)` and never looked at the reserve — folding it in would have moved that
  member from 8000 bps to 5333 and quietly retired the case. Noted in the file.
- Flipping the B-half's flag does NOT admit the frozen-MatB scan into these batches:
  `_isFrozenMatB` returns on `occupancy() < MATRIX_SIZE()` and `MockMatrixK.occupancy` is
  always 0 (there is no setter). Checked in source before relying on it.

## ⛔ SHARPENING — THE POPULATION NUMBER IN SplitGrace WAS PRE-ITEM-A AND IS NOW RE-MEASURED

`"the 84% member — the live median"` was 50% reserve + ~34% earnings at an A->B crossing,
measured 2026-08-11. **Item A retired that member.** The population it represents moved to
the MatB re-entry, so the test was re-pointed at where that population now lives and
renamed **"the MEDIAN re-entry member"**: `$7.29` of a `$10.00` re-entry, from
`model_item_a.js` on live V8.48 (n=63, median ask **$2.71**). Every other fixture amount
in these files was checked against that same measured band — a member arrives at a $10
re-entry holding **$5.72 to $10.00** — and all of them sit inside it.

## ⛔ CORRECTION TO SESSION 3'S CHARACTERISATION OF THE CLIFF — IT IS THE FLOOR, NOT THE LADDER

Session 3: *"an early-MatB member reads ~3,400 bps against preset 1's bottom rung of 4,000
and falls off it."* **Reproduced, and it is one rung further along than that.** The two
members that actually diverge in `KeeperScan` read **4,120 and 4,875 bps** — both ABOVE
the 4,000 rung. They get a ladder rung; what kills them is what the rung then asks for.

Losing the carve does not change the ladder arithmetic, it changes the **shortfall**:
`$0.88 -> $5.13` for those two. That ask is then refused by the **insolvency floor**.
Same family, same cause, but the lever is PARAM 59 and not `sfRescueThresholds` — which
matters, because the two are different owner decisions and session 3 pointed at the
second one. The ladder can still bite a poorer member; it is not what bit here.

## THE KeeperScan DECISION — SCOPED, NOT RETIRED, AND THE DIVERGENCE IS NOW PINNED

Session 2 and 3 both said the byte-identical premise is *structurally* incompatible with
item A, because item A is not a parameter and `MatrixKeeperPrev` will never know about it.
**That reading was wrong, and the run says so.**

Item A reprices a crossing out of a **MatA**. Out of a MatB, `_crossingCost` returns the
full entry fee — the same number the frozen keeper uses. And under item A a MatA parker's
reserve covers their crossing outright, so **MatA parks nobody for funding and the whole
parked queue this fixture builds lives in the MatB.** Both keepers ask the same question
about the same members. Measured across every scenario in the file:

```
insolvencyFloorBps      0 -> 0 slots differ   (BYTE-IDENTICAL)
insolvencyFloorBps   1700 -> 2 slots differ
insolvencyFloorBps   2500 -> 2
insolvencyFloorBps   3400 -> 2      <- the shipping value
insolvencyFloorBps   5000 -> 2
insolvencyFloorBps   6800 -> 0      (BYTE-IDENTICAL)
insolvencyFloorBps  10000 -> 0      (BYTE-IDENTICAL)
```

**The divergence is one-shaped and lives in one governed parameter.** Every differing slot
is OLD=`PARKED_RESCUE`, NEW=`EVICT_PARKED`, a MatB member, reserve 0 — never the reverse.

So the decision, recorded with its reason as session 2 asked:

1. **`insolvencyFloorBps` is pinned to 0 in `deployBoth()`**, a THIRD pin alongside item
   12's `selfFundedGracePeriod` and item 1's `evictionGracePeriod`. It is the same move
   for the same reason and it obeys the file's own doctrine — *"every pin here is an item
   that DID [change behaviour]."* It hides no keeper difference: both keepers call the
   same `loanEligibleFor`, and this suite was green at the shipping 3400 before item A.
   It neutralises the one INPUT item A moved.
2. **The divergence is asserted, not swept away**, by a new test at the bottom of the
   file: at floor 0 byte-identical; at the shipping floor every flip is RESCUE->EVICT, in
   the MatB, on a member holding no reserve; at floor 10000 identical again — which is
   what proves the cause is the floor and not the ladder.

Net: the file covers MORE than it did. The extraction is still pinned byte-for-byte, and
the economic change now has a test that fails if it ever stops happening.

## RescueSurplus — THE QUEUE MOVED, AND THAT IS ITEM A'S THESIS REPRODUCED LOCALLY

*"Fixture produced no parked member"* was the right failure to see. Measured on this
fixture's own world (`world(7)`, 41 registrations), stepping the count as it grows:

```
regs=10   matA.parked 0   matB.parked 0
regs=20   matA.parked 0   matB.parked 7
regs=40   matA.parked 0   matB.parked 27     every one at wd $2.436 / rs $0.00
regs=70   matA.parked 0   matB.parked 57
```

**MatA parks NOBODY. Not one, at any population size.** The entire queue is the MatB
cycle-out. That is the whole V8.50 argument, reproduced in a local fixture in seven
seconds, and it is worth more than the three tests it was found while fixing.

The file now builds its member in MatB, and asserts MatA's emptiness explicitly rather
than ignoring it — if a funding park ever appears in a MatA again, item A has regressed
and that is the cheapest line in the suite to find it on.

**ONE NEW FIXTURE STEP, AND IT IS NOT A FUDGE.** A journey earns at most ~34% of a fee, so
the only way past 100% is referral income — the member must be a referrer, and their
downline keeps crossing into MatB paying them `l1Bps` each time. Left alone, the RESCUE
TRANSACTION ITSELF pays them another $0.95 mid-flight and the post-rescue balance reads
`surplus + $0.95`. The fixture now drains that first: register outside their downline
until their withdrawable stops moving, measured, not counted. Then the surplus assertion
is exact — **verified delta $0.000000**. The comment says in the file: do not replace this
with a tolerance; the drain is what keeps the assertion sharp.

**MUTATION-CHECKED.** `_selfRescue`'s `withdrawable = surplus` was flipped back to
`withdrawable = 0` — the original V8.48 defect — recompiled, and the REGRESSION test
fails. The re-fixtured test still catches the bug it was written for.

## TEST STATE — AND HOW IT WAS MEASURED, WHICH YOU NEED TO KNOW BEFORE TRUSTING IT

⚠️ **THESE NUMBERS COME FROM A SANDBOX REPRODUCTION OF THE REPO, NOT FROM THE OWNER'S
MACHINE.** Contracts + tests were copied into a clean Linux container with a fresh
`npm install` and solc 0.8.26 from npm. It is a faithful reproduction — it reproduced
every one of the 12 target failures with byte-identical assertion messages before the fix
— but it is NOT the owner's environment and it **drifts by about two tests**: it shows 7
`KeeperScan` failures where the owner's `test_v850_task1b.txt` recorded 9, and it does not
show `V8.46-B cascade gas` (the known inherited `TypeError`). **The owner's run is the
authoritative one. Treat the prediction below as a prediction.**

| | passing | failing |
|---|---|---|
| session 3, owner's machine (`test_v850_task1b.txt`) | 534 | 60 |
| session 4, sandbox, six files re-fixtured | **555** | **40** |
| session 4, sandbox, + the `V8Elevator` fc() guard | **567** | **28** |
| **OWNER'S MACHINE, MEASURED** (`test_v850_task2.txt`) | **574** | **21** |

**60 -> 21. Thirty-nine tests went green.** The prediction was ~568/~27 and was BEATEN, not
missed — the sandbox over-predicted the remainder by 6 because several `V8.35` factory
tests and `V8.46-B cascade gas` fail there and pass on the owner's machine. **Read that as
the sandbox being pessimistic, not as a surprise: every one of the 24 re-fixtured tests and
every test the `fc()` guard was meant to reach went green exactly as predicted.** The
KeeperScan PARAM 59 sweep printed identically on both machines, to the row.

Predicting the ASSERTION and not the test, per session 3's own method note: **33 failing
tests should go green and 1 new test should appear**, and no test that was passing should
start failing. If the owner's run lands anywhere else, the diff — not the total — is the
thing to read.

**THE 40 THAT REMAIN ARE NOT OURS TO FIX THIS SESSION.** Every one was already in session
2's 51: real-pair fixtures that encode a full-fee A->B crossing (`V8.35` factory ×10,
`V8.39` ×5, `V8.38` ×3, `V8.44` ×5, `V8Elevator` ×4, `V8.10` ×4, and so on), plus
`GhostFloor`'s GF-V1 and GF-V3. They are the same class of work as this session's, at
larger scale.

**GF-V3 is worth naming because it is the cleanest statement of the remaining work:**
`precondition: cycle-out park must keep the crossing reserve: expected 0 to equal 5000000`.
Its precondition is now false BY DESIGN. Item A is the reason, and the fixture is right to
say so loudly rather than adapting quietly.

# ✅ ITEM E1 IS BUILT — AND THE SUITE IS GREEN FOR THE FIRST TIME THIS RELEASE

**595 passing / 7 pending / 0 failing.** Session 4 opened at 60 failing.

## WHAT E1 IS

`MatrixLogicLib._crossToPartner`, at the very end and **after** the SF debt clawback: the
member's remaining withdrawable moves with them. `forceApprove` to the destination, then a
partner-only `creditCarriedBalance(member, amount)` on the far side — the same door
`addRescueDebt` has used since V8.28 (`FigureEightMatrixV8:629`), not a new one.

- **NOT routed through `_credit()`.** A transfer is not an earning. Crediting it would
  inflate the member struct's `totalEarned` — the field defect 4 exists to clean up — and
  double-count in anything summing `EarningsCredited`, `model_item_a.js` included.
- **Emits `BalanceCarried(member, from, to, amount)`** so the movement is visible. The
  crossing buffer's sin at `:1368` is moving money into `withdrawable` invisibly; this must
  not repeat it.
- **AFTER the clawback, deliberately.** Debt settles from this ledger first and only the
  remainder travels. Carrying first would move money out from under `:882-897`.
- **ONE DIRECTION ONLY.** My own design note said it had to be symmetric. Wrong: a member
  cycling out of MatB leaves their remainder in MatB, re-enters their OWN pair, and returns
  to that same contract — so it waits for them and the next gate already reads it.

**Measured effect:** MatB ledger at the gate $7.66 -> **$8.32**, gate-basis ask
$2.34 -> **$1.68**.

## THE VALIDATION THAT MATTERS

**E1 fixed all three remaining walk-through items with no fixture change at all** —
the 15-registration re-entry-priority test, `V8_44_Overflow` O1+O2, and `V8.35` G4. Those
were the three I could not resolve and had planned to re-state. **They were failing because
of the defect.** Fixing the root cause turned them green untouched. Nothing else in this
session came close to that as evidence.

## THE FIXTURES E1 THEN BROKE, AND WHAT THEY TAUGHT

E1 took the suite 3 -> 8 failing, every one the same shape: *"precondition: shortfall
cycle-out must PARK the root in MatB"*. The fixtures could no longer make a poor member.

**The cause was the same in three files, and it was a fixture lie of long standing.**
`driveW1IntoMatB`, `parkW1InMatB` and `seedAndParkW1` all referred **fifteen fillers to
W1**, handing the fixture's "underfunded" member $14.25 of L1 and making them the richest
wallet in the pair. It only ever read as underfunded because that money sat in the MatA
ledger where the gate could not see it. **The fixtures were relying on the defect.** They
now chain the referrals, so W1 is the passive no-referral member the precondition always
described.

**Two more corrections came out of `V8_48_RescueSurplus`, both mine:**

1. **"MatA must park nobody" was too strong.** E1 changes cascade timing, so the mid-cascade
   DEFERRAL park (`:906`) now fires — measured: 2 MatA parkers, both holding a reserve of
   exactly $5.00, the full crossing price. They are not stuck; a deferral park hands them to
   the standard machinery for a later transaction and bounds recursion depth. Item A's claim
   is about FUNDING, so the test now asserts funding: **no MatA parker may hold less than
   the crossing price.** Stronger than a count, and it survives future cascade changes.
2. **The settle loop was replaced by accounting.** A rescue re-seats the member, which
   cascades, which can pay them L1 in the SAME transaction. The old fix quiesced their
   downline first; E1 changed the timing and a credit slipped back in. It now SUMS
   `EarningsCredited` from the receipt — with two traps recorded in the file, because both
   produced confident wrong answers: the event must be parsed from an EXPLICIT interface
   (solc does not copy a library's events into the using contract's ABI, and parsing
   through `matB.interface` silently returned zero), and it must be FILTERED BY EMITTER
   (credits are per-ledger — a rescue pays $0.95 L1 on the matrix being left and $0.25
   direct-earn on the one being entered; counting both over-states by exactly the
   direct-earn, the same error as summing both halves in phase 5).

## ⚠️ CONTRACT SIZE IS NOW A LIVE CONSTRAINT ON THE REST OF V8.50

```
  MatrixPairFactory   24,444   headroom   132     <- embeds the matrix init code
  MatrixLogicLib      24,274   headroom   302
  TierRouter          23,910   headroom   666
```

E1 cost MatrixPairFactory 216 bytes and MatrixLogicLib 261. **Defect 4 wants to ADD a
getter to the matrix, which grows the factory again.** With everything landing in V8.50 and
nothing deferring, size has to be managed deliberately from here — budget it before writing,
and `node scripts\sizes.js` after every contract change, not just at the end.

## NEXT

1. **Re-run `scripts/model_item_a.js` phase 6.** It now measures a fixed system. PARAM 59
   should finally be chosen against a basis that is true — the expectation is that the ask
   returns toward the scope's ~$3.20 and 3400 clears the population, but that is a
   prediction and the script is the answer.
2. Defects 2 and 4, within the size budget above.
3. `maxItemsPerUpkeep` 15 -> 5 or 10.
4. Item D and the organic growth reading. (The tier-gate recalibration is CLOSED — PHASE 8 measured it as fixture-specific; live T2 is $25 and nobody upgrades at cycle-out in either world.)

# ⛔⛔ OWNER DIRECTIVE, 2026-08-17: NOTHING DEPLOYS, NOTHING DEFERS

> *"we fix everything, deploy nothing until we have a solid ground to stand on. also would
> like everything we find to be in v8.50, nothing deferred to 8.51"*

**This supersedes every "ship it / defer it" recommendation elsewhere in this document,
including my own from earlier today.** V8.50 is now a FIX-EVERYTHING release. No partial
deploy, no interim PARAM value chosen to unblock a deploy that is no longer happening.

**Practical consequence: PARAM 59 does not need an interim answer.** The 6800 recommendation
existed only to unblock a deploy. With the deploy held, the right sequence is: fix the
ledger split FIRST, then re-measure, then choose the floor against the fixed system. A
floor chosen against the broken basis would be a number nobody could defend later.

## THE REAL V8.50 SCOPE, AS IT NOW STANDS

**Contract work — money path**
- **E1. CARRY THE MEMBER'S BALANCE WHEN THEY CHANGE MATRIX.** The headline fix. See the
  design fork below. Everything else on this list is small by comparison.
- **E2.** Correct the conservation comment in `TierRouter.handleCycleOut` — it currently
  asserts an equality that does not hold at that gate and is the most authoritative-looking
  place anyone will read.
- **E3.** `_executeAdditive`'s re-entry/upgrade fall-through: independent `if`s, not
  `else`. Unreachable on the real ascending ladder ($10 -> $25 -> $50), so the CODE is
  safe; the doc comment claiming "re-enter or PARK" is not. Comment fix at minimum.
- **E4.** Revisit the MatA withdraw lock. Session 2 kept it at the FULL fee on the
  reasoning that "a MatA member WILL need it for the re-entry, and this lock is what
  accumulates it". **The lock accumulates money in MatA and the re-entry gate reads MatB.**
  The lock and the gate are on different ledgers — the same defect from another angle. If
  E1 lands, the lock's premise becomes true for the first time.
- **Defect 2.** `MatrixKeeper.DIRECT_EARN_BPS = 500` — dead, public, and wrong (real value
  250). Delete it.
- **Defect 4.** No getter exposes the true `totalEarned`; `MatrixKeeperLib:426`
  reconstructs it as `withdrawn + withdrawable`, which includes crossing-buffer money, and
  the keeper's withdraw-ratio EVICTION test runs on the contaminated figure.

**Parameters — all decided AFTER E1, not before**
- PARAM 59 `insolvencyFloorBps`. With E1 the ask returns to ~$3.20 and 3400 clears
  everyone; without it, 6800 is the floor. **Do not fix this number until E1 is settled.**
- `crossingBufferBps` -> 0. Already governed in V8.49; confirm in predeploy.
- `maxItemsPerUpkeep` 15 -> 5 or 10 (scope §6: gas per rescue rose 600k -> 2.6M; a full
  15-item batch projects ~39M against a ~17.8M ceiling).

**Tests — 3 red, and 2 of them wait on decisions**
- 15-registration re-entry priority (waits on E3)
- `V8_44_Overflow` O1+O2 (needs a rule re-stated, not a fixture moved)
- `V8.35` G4 — FIXED in the sandbox, not yet committed
- New coverage for E1 will be needed and does not exist yet.

**Still unmeasured, and now in scope because nothing defers**
- **Item D, shallow seating.** T5 has never been able to fire. A member seated at seat 2
  pays a full fee and collects $0.25. If E1 lands, that member's balance travels — which
  changes item D's severity but not its existence.
- **The organic growth rate.** `logs/parked_baseline.csv` and `diag_parked_growth.js` —
  parks vs rescues vs EVICTIONS per day, still never run.
- ~~**Tier-gate recalibration** after the acceleration finding.~~ **CLOSED 2026-08-18.** `model_item_a.js` PHASE 8: live T2 is $25.00 and 0 of 39 can upgrade at cycle-out under EITHER V8.48 or item A. The acceleration was V8Elevator's fee ladder, not this chain's. No recalibration, no contract change.

## 🚨🚨 MEASURED ON CHAIN 2026-08-17: PARAM 59 = 5000 RESCUES **ZERO** MEMBERS

**THIS REVERSES THE OWNER DECISION TAKEN EARLIER TODAY. DO NOT DEPLOY 5000.**

`scripts/model_item_a.js` phase 6 (added for this question) computes the re-entry ask two
ways: the AGGREGATE across both halves — phase 5's basis, and what the 5000 decision was
made on — and the **MatB LEDGER alone**, which is the basis `handleCycleOut` and
`_triageParked` actually use. Live V8.48, block 45588411, n=70:

```
  ask, AGGREGATE (both halves)      min $1.23   median $1.90   max $2.58
  ask, MatB LEDGER (the real gate)  min $6.60   median $6.60   max $6.60
  MEDIAN UNDERSTATEMENT             $4.70

  PARAM 59 sweep on the LEDGER basis — rescued of 70:
     3400 bps  ceiling $3.40    aggregate 70    LEDGER   0
     5000 bps  ceiling $5.00    aggregate 70    LEDGER   0     <- THE DECISION WE TOOK
     6800 bps  ceiling $6.80    aggregate 70    LEDGER  70     <- first value that works
    10000 bps  ceiling $10.00   aggregate 70    LEDGER  70
```

**$6.60 for every single member, min = median = max.** That uniformity is itself the
proof: journey B earns the structural $3.40, a re-entry costs $10.00, the ask is $6.60,
and every one of these 70 is a no-referral member. It matches the hand-derivation exactly.

### WHAT THIS ACTUALLY MEANS — AND IT IS NOT "ITEM A IS BROKEN"

Item A's headline win is untouched and confirmed again this run: **40 of 40 MatA parkers
freed, 100%**, $48.93 of live shortfall to zero, 64.0% of all funding parks removed. Nobody
is evicted mid-cycle. **That is item B delivered and it does not depend on any of this.**

What is broken is the SECOND half of the story — the claim that the member arrives at
re-entry holding $6.80 and asks $3.20. They DO hold $6.80. It sits in two ledgers, $3.40
each, and the re-entry gate can only spend the MatB one.

**So at that gate item A makes the ask WORSE than V8.48, not better:**

```
  V8.48  MatB reserve $5.00 + earnings $1.80 (post-clawback) = $6.80  ->  ask $3.20
  V8.50  MatB reserve $0.00 + journey-B earnings     $3.40  = $3.40  ->  ask $6.60
```

The member is not poorer — their journey-A $3.40 is real, withdrawable, and usable for a
MANUAL `selfRescue` (which pulls a shortfall from the WALLET). **Item A moved money from
the automatic path to the manual path.** For a passive member, who is exactly who item A
exists for, the automatic path is the only one they use.

### THE THREE WAYS OUT

1. **PARAM 59 = 6800 and ship.** Clears all 70. Defensible framing, and better than the one
   it replaces: 3400 was "never lend more than one JOURNEY's earnings"; 6800 is "never lend
   more than one full A+B CYCLE's earnings" — which is exactly what a member at re-entry
   has completed. No code change. But it doubles the fund's per-rescue exposure against a
   balance that fell $451.66 -> $329.29 in one day.
2. **CARRY THE BALANCE ACROSS THE CROSSING.** At the A->B hop, move the member's remaining
   MatA withdrawable into their MatB ledger. They then reach the gate holding $6.80 and ask
   $3.20 — the scope's model, restored — and 3400 would clear everyone with room.
   **NOT A ONE-LINER:** withdrawable is backed by USDC held in the MatA contract, so the
   claim and the tokens must move together, across contracts, in the money path. Needs its
   own scope item and its own tests.
3. **BOTH** — do 2, keep the floor low, and treat 6800 as the interim while 2 is built.

**RECOMMENDATION: 1 now, 2 scoped for V8.51.** 6800 is honest, on the DAO menu, reversible
by vote, and unblocks the deploy. Option 2 is the real fix and should not be rushed into a
release whose test suite is still being re-fixtured.

### SECONDARY OBSERVATIONS FROM THE SAME RUN

- **The population has fully turned over to organic no-referral members.** One completed
  journey now earns min $3.40 / median $3.40 / **max $3.40** — the whole distribution has
  collapsed onto the structural minimum (it was min $3.40 / median $4.83 / max $6.34 on
  2026-08-16). The bigfill-era members with referral income have cycled out.
- **MatB parkers carrying debt: 0 of 70**, down from 23 of 72 yesterday. The clawback
  concern (scope defect 3) has no live population right now.
- **The Stability Fund fell $451.66 -> $329.29 in a day** while the queue drained 133 -> 110.
  Worth watching before committing to a higher lending ceiling.

## 🚨 THE CONSERVATION ARGUMENT HAS A HOLE — MEASURED 2026-08-17, READ BEFORE DEPLOY

**This contradicts a conclusion session 3 committed to source, and it bears on PARAM 59.**

### WHAT SESSION 3 WROTE, IN THE HANDOFF AND IN `TierRouter.handleCycleOut`

> V8.48  reserve $5.00 + earnings $3.40 - $1.60 crossing debt = **$6.80**
> V8.50  reserve $0.00 + earnings $3.40 (journey A, **KEPT**) + $3.40 = **$6.80**
> "The same $6.80 against the same $10 re-entry, so every funding gate below decides
> identically... that is why item A needed NO code change in this contract."

### WHY IT IS WRONG

Journey A's earnings are kept — **in the MatA ledger.** `handleCycleOut(member, tierIndex,
escrow, withdrawable)` receives ONLY the cycling matrix's two buckets, passed by
`MatrixLogicLib._cycleOutRoot` from **MatB**. There is no cross-matrix lookup. So the
"+$3.40 (journey A, KEPT)" term is real money that this gate never sees.

**MEASURED on `deployV8Fixture`, W1 at the MatB cycle-out:**

```
  MatA ledger  $7.31   <- STRANDED from this decision
  MatB ledger  $7.66   <- ALL that handleCycleOut receives
  aggregate   $14.97   <- what scripts/model_item_a.js sums
  T1 re-entry needs $10.00
```

The member holds $14.97 and the contract sees $7.66. Under V8.48 the same member reached
this gate with **$12.66**, because the $5 arrived as a carved MatB reserve. **Item A leaves
that money behind in MatA.** The member is not poorer overall — they are poorer AT THIS
GATE, which is the only place it matters for an automatic re-entry.

### THREE CONSEQUENCES, IN ORDER OF IMPORTANCE

1. **`model_item_a.js` IS OPTIMISTIC FOR THE POST-ITEM-A POPULATION.** Phase 5 computes
   holdings as *"credits across BOTH halves"*. That is CORRECT for the members it measured
   — today's V8.48 parkers, whose MatA money was already spent on their full-fee crossing,
   so aggregate ≈ MatB ledger. It is **wrong as a projection**, because under item A the
   money splits across two ledgers and only one funds the re-entry. **The measured median
   ask of $1.90 and "15 of 72 refused at 3400" are both understatements.** PARAM 59 at 5000
   still looks like the right call — the direction does not change — but the headroom it
   buys is smaller than the sweep suggested.

2. **A MEMBER CAN NOW UPGRADE INSTEAD OF RE-ENTERING, AND THE CODE PERMITS IT.**
   `_executeAdditive` (`:1351`, `:1362`) tries re-entry first, gated on
   `escrow + withdrawable >= curFee`, then tries the upgrade in an INDEPENDENT `if` —
   not an `else`. The doc comment says *"auto-reentry ON → member NEVER graduates:
   re-enter or PARK"*, and the code does not enforce the "or PARK". Under V8.48 the
   divergence was invisible: a member who could afford a $7 upgrade had almost always
   cleared the $10 re-entry first, because the $5 reserve got them there. **Item A opens a
   band — funds between the next-tier fee and the current-tier fee — where the member
   leaves T1 rather than completing another cycle.** Observed: W1 at $7.66 skipped a $10
   re-entry and took a $7 T2 upgrade.

3. **IT INTERACTS WITH ITEM B.** "No member evicted mid-cycle" is satisfied by item A at
   the A->B crossing. This is a different thing: a member who does not re-enter has not
   been evicted, but they have not continued either.

### WHAT IS *NOT* WRONG — CHECKED, SO NOBODY RE-OPENS IT

- **`disableUpgrade` is NOT being ignored.** `_executeAdditive:1336-1341` applies a
  member's options only once `cycles >= reentryMinCycles` / `autoUpgradeCycleThreshold`;
  below that the system default governs. That is V8.44 design (`V8_44_CycleOut` sets
  `setReentryMinCycles(1)` explicitly for exactly this reason). A first cycle-out ignoring
  the member's own toggle is intended, not a defect.
- **The member does not LOSE the MatA money.** It is withdrawable, and `selfRescue` pulls
  a shortfall from the WALLET, so a member can move it manually. **Item A moves money from
  the automatic path to the manual path** — that is the honest one-line summary.

### WHAT TO DO NEXT — NOT YET DONE

1. **Add a phase to `scripts/model_item_a.js` that splits holdings BY LEDGER** and reports
   the re-entry ask on the MatB balance alone. That is the basis the contract uses. Re-run
   PARAM 59's sweep on it. **Until then, treat the $1.90 median and the 5000-clears-all-72
   result as an upper bound on how good things are.**
2. **Decide whether the `_executeAdditive` fall-through is wanted.** Options: leave it (a
   member progressing a tier is not a bad outcome), or make the upgrade an `else` so
   "re-enter or PARK" means what it says. **This is an owner decision and a contract
   change, so it does not belong in a test fix.**
3. **Correct the comment in `TierRouter.handleCycleOut`** — it currently asserts a
   conservation that does not hold at that gate, and it is the most authoritative-looking
   place anyone will read.

**The 15-registration test stays RED until 2 is decided.** It was left failing on purpose
rather than being written around behaviour that is not yet understood.

## ⛔ THE 40 WERE TRIAGED, AND HALF OF THE BIGGEST CLUSTER WAS ONE LINE

Grouping the remaining failures by revert signature rather than by file: **20 of them —
by far the largest cluster — fail on `F8V8: already in matrix`**, which is the
duplicate-seat guard at `MatrixLogicLib:255` and has a history in this repo as a real
pair-wide DoS. That warranted looking at before any more re-fixturing.

**It is not a regression. It is item A succeeding where a fixture expected it to fail.**
The trace runs `test helper -> matA.forceCross -> _finalizeCrossing -> seat in MatB ->
require(!isInMatrix)`. `V8Elevator.test.js` has ONE shared `fc()` helper used at 21 call
sites, and the helper's own comment states the dead assumption outright:

```
// 7 registrations each trigger a MatA rotation; fc() pushes each parked root to MatB
```

Under item A **the root does not park** — its reserve pays the crossing, so it crosses
itself during the rotation and is already seated by the time `fc()` runs. The helper's
real contract was always "ensure this member is in MatB"; only the world made the two
readings identical. **One guard in the helper, and that file went from 22 failing to 10:**

```js
if (await matB.isActiveInMatrix(memberAddr)) return;   // item A got there first
```

The pattern was not invented here — `V8_48_KeeperScan.test.js` already guards its own
force-cross loop exactly this way, and so does `V8_47_UpgradeGate.test.js` at its call
site. This is that pattern hoisted into the helper.

**THREE MORE FILES CARRY THE SAME `ownerForceCross` IDIOM** (`V8_44_CycleOut`,
`V8_47_UpgradeGate`, `V8_44_Overflow`) **and the same guard was applied to them, measured,
and REVERTED: it fixed nothing.** Their 6 failures are the other family — a fixture that
needs a parked member item A no longer produces — and V8_47's call site was already
guarded. The guard would have been correct-by-design and dead in the diff, so it went
back out. Recorded because "it looked like the same bug and was not" is worth one line to
the next session.

**Where the remaining work stands after that:** sandbox **28 failing**, predicted **~27**
on the owner's machine. Two shapes, and neither is mysterious:

1. **The parked-member family** — `V8.10` ×4, `V8.44` ×5, `V8.47` G3, `V8.35` G4,
   `V8.38` L1/L2/L4, `GhostFloor` GF-V1/GF-V3, `CycleOutDebug`, whale gate. Each needs
   what `RescueSurplus` needed: build the member at the MatB cycle-out instead of the MatA
   crossing. **`RescueSurplus` and `GF-V3` are the two worked examples; the rest is that
   job repeated.**
2. **`stress_test_full.js` ×2** — `Expected 'F8V8: already in matrix' but got
   'F8V8: sfContribution exceeds fee'`. Session 3 already named these two as the bug that
   was sitting in plain sight in the 51, and they are now asserting the OLD revert string
   against a keeper that prices correctly. Fixture, one line each.

## ✅ BOTH OWNER DECISIONS ARE SETTLED — 2026-08-17, MEASURED THEN DECIDED

**Superseding the "STILL OPEN" section below, which is kept for its reasoning.**

### ⚠️ DECISION 1 — PARAM 59 3400 -> 5000 — **SUPERSEDED, SEE THE PHASE 6 SECTION ABOVE.**
### (original reasoning kept below; it was correct on the basis it had)

The owner's instinct was **4000**. A sweep added to `scripts/model_item_a.js` measured what
each ceiling actually buys, against the live population (n=72, block 45578581):

```
    0 bps  ceiling  $0.00   rescued   6/72   refused 66
 1700 bps  ceiling  $1.70   rescued  12/72   refused 60
 2500 bps  ceiling  $2.50   rescued  44/72   refused 28
 3400 bps  ceiling  $3.40   rescued  57/72   refused 15     <- today
 4000 bps  ceiling  $4.00   rescued  60/72   refused 12     <- OFF the DAO menu
 5000 bps  ceiling  $5.00   rescued  72/72   refused  0     <- DECIDED
 6800 bps  ceiling  $6.80   rescued  72/72   refused  0
10000 bps  ceiling $10.00   rescued  72/72   refused  0
```

**4000 was rejected on the data, not on taste. It buys THREE members** (57 -> 60) and still
refuses 12, because **12 of the 15 refused sit in a $0.28 band between $4.00 and $4.28** —
a $4.00 ceiling lands just underneath the cluster it was meant to catch. The tail is a
cliff, not a slope, and the sweep is the only thing that could have shown that; min/median/
max cannot answer "how many clear at X" for an X between them.

**AND 4000 IS SETTABLE BUT NOT VOTABLE.** `StabilityFund.setInsolvencyFloorBps` accepts any
bps <= 10_000 (a free range, not an enum), so it CAN be deployed — but `V8Governance.sol:496`
enumerates `[0, 1700, 2500, 3400, 5000, 6800, 10000]` and 4000 is not on it. Set it and the
DAO could never vote back to it. That is CLAUDE.md's `375/400` trap in a new costume:
on-chain state drifting from the source default with nothing keeping them equal. Deploying
4000 honestly would mean moving the source default, the DAO menu and the `GF-G1`
menu-discipline test together — three files, to buy three members.

**THE JUSTIFICATION IS NOT THE MEDIAN ANY MORE, AND THAT MATTERS.** Session 2 argued from
*"one completed journey earns min $3.40 / median $4.83 / max $6.34"*. The 2026-08-17 run
reads **min $3.40 / median $3.40 / max $5.93** — the median IS the structural no-referral
minimum now.

⛔ **I FIRST CALLED THIS "ONE OF THE TWO RUNS IS WRONG". THAT WAS WRONG, AND THE TELL WAS
IN THE NUMBERS I ALREADY HAD.** The MAXIMUM fell, $6.34 -> $5.93. A completed journey's
earnings cannot decrease for a member who stays, and adding members cannot lower a maximum.
**So the population TURNED OVER between the two readings — it did not merely grow.** The
$6.34 member left the MatB queue (rescued or evicted) and new ones arrived. Both runs are
correct; they measure different populations nine hours apart. The degraded reconciliations
(chain pay 97.3% -> 92.6%, pool 77.7% -> 50.2%) are separately explained: pool settles per
ROTATION and the chain has been organic and quiet since bigfill stopped, so more of it sits
unsettled in the accumulator. Neither needed to be a fault.

**AND THE TURNOVER SAYS SOMETHING WORTH KEEPING.** The queue is churning, and the member who
left was the RICHEST one — which is what you would expect, because the richest ask the least
and are the ones the fund can afford. **A queue that keeps losing its wealthiest members
gets poorer, and its median ask rises over time.** That is one observation, not a trend, and
it must not be quoted as one until a third reading exists. But it points the same way the
decision went.

**THE STANDING LESSON, because I nearly filed a false alarm as a finding:** two runs
disagreeing is not evidence that an instrument is broken. Check first whether they measured
the same thing. And it is the reason PARAM 59 is anchored to `CROSSING_RESERVE_BPS` and not
to a median — **a median over a churning queue is a snapshot, not a property of the system.**

The decision does not rest on it. **The operative number is the max ask, $4.28 — measured
twice, on two population sizes, identical to the cent.** And the defensible anchor is
structural rather than statistical:

> **5000 bps IS `CROSSING_RESERVE_BPS`. The fund lends at most what the system itself
> reserves for a crossing.**

That does not drift between runs, it is already on the DAO menu, and it reads honestly in
member comms — better than either "a median" or "one full journey's earnings", which was
the 3400 framing and is now contradicted by its own data.

**COST, BOUNDED:** the 15 extra members each ask between $3.40 and $4.28, so the entire
marginal exposure of 3400 -> 5000 is **$51.00 to $64.20**, against a fund holding $451.66
which item A simultaneously relieves of $96.70. Absolute worst case across all 72 is $308
if every member asked the maximum; none do, the median ask is $1.90.

**⛔ AND THE CORRECTION THAT SHOULD HAVE COME FIRST: PARAM 59 IS NOT REQUIRED BY ITEM B.**
Session 2 wrote that 5000 is needed *"so all 63 members at re-entry are rescued and item B's
promise holds."* **That is wrong.** Item B is about members evicted **MID-CYCLE**, and every
one of those is a MatA parker — all 61 of whom item A frees outright, 100%, measured twice.
The members the floor refuses are MatB parkers **at re-entry, having COMPLETED a full
cycle**. Evicting them does not violate item B. **Item A alone satisfies item B.** PARAM 59
is a purely economic generosity choice and was decided as one. Anyone re-opening it should
argue it on cost and member lifetime, never on item B.

**SECOND-ORDER EFFECT, ACCEPTED WITH EYES OPEN:** 23 of 72 re-entry members carry SF debt,
and `_crossToPartner` sweeps all remaining withdrawable to repay it (`:882-897`). Under item
A they arrive holding MORE, so an indebted member is clawed back HARDER, not spared. Raising
the ceiling means more members borrow, so that group grows next cycle. This is scope defect
3 and it is not fixed by this decision.

### DECISION 2 — THE SF RESCUE LADDER: **KEEP PRESET 1. NOTHING MOVES.**

Measured, and it closes the question session 3 opened: **the poorest live member at re-entry
holds $5.72 — 5,720 bps against preset 1's 4,000 bottom rung.** Not one member of the live
population falls off the ladder. Derived from the sweep: the largest ask is $4.28, so the
smallest holding is $10.00 - $4.28.

The ~3,400 bps case session 3 worried about belongs to a member **mid-journey-B**, and under
item A those never park — there is nothing to pay until cycle-out — so **they never meet the
ladder at all.** The cliff that showed up in `V8_48_KeeperScan.test.js` was the FLOOR, not
the ladder (see the correction above), and it is bought back by decision 1.

**Revisit only if item D (shallow seating) turns out to be real**: a member seated at seat 2
collects $0.25 of a journey and could arrive at re-entry far below anything on chain today.
That frequency is still unmeasured — it is test T5, and `scripts/diag_seating_depth.js`
exists but has never been able to fire.

### ✅ FINALISED IN SOURCE — NOT LEFT AS A DEPLOY STEP

- **`StabilityFund.sol` `insolvencyFloorBps` default is now `5_000`.** Done in source, not
  deferred to a setter call, and that choice is the point: **V8.50 is a fresh deployment, so
  the source value IS the live value from block one.** Leaving `3_400` would have needed a
  runbook step that can be forgotten, with the community's fund silently on the old ceiling
  until someone ran it — which is `375/400` in CLAUDE.md, exactly. 5_000 is already on the
  governance menu (`V8Governance.sol:496`), so the DAO retains full control.
- **The change cost six test edits and every one of them made the suite better.** Two
  "declared default" pins moved 3400n -> 5000n deliberately (they exist to catch accidental
  drift; this drift was chosen). Four boundary tests — `GF-F1`, `IF-1`, `IF-3`, `IF-5` — had
  the $3.40 ceiling HARD-CODED and silently became change detectors the moment the default
  moved. They now DERIVE the ceiling from `insolvencyFloorBps`, so the rule under test is
  "headroom == ceiling - debt" rather than a number. That is this suite's own item-42
  lesson, applied to itself.
- **VERIFIED, NOT ASSUMED: the change has ZERO net effect on the suite.** Full run before
  and after, same sandbox: **574 passing / 21 failing, and the failing SET is identical
  member-for-member.** Nothing else in the codebase keyed off 3400. (The same sandbox now
  matches the owner's machine exactly, 574/21 — the earlier "drifts by two tests" note was
  an artefact of running `KeeperScan` ALONE rather than in suite order. Worth knowing before
  trusting a single-file run again.)
- ⚠️ `contracts/StabilityFund.sol` is the FIRST contract file touched since `24c193c`. One
  constant plus comments, so bytecode is unmoved. **Sizes run, all watched contracts fit:**

```
  TierRouter        23,910  (666 spare)      MatrixLogicLib   24,013  (563)
  MatrixPairFactory 24,228  (348)            MatrixKeeper     21,229  (3,347)
  StabilityFund     15,063  (9,513)
```

  **THE BUILD REPRODUCES ACROSS TWO MACHINES BYTE-FOR-BYTE** — the sandbox container and the
  owner's Windows box produce identical deployed sizes on all five. That is a stronger
  statement than "it fits" and it retires the earlier worry about sandbox drift entirely.

- 🔎 **ONE UNEXPLAINED NUMBER, LOGGED RATHER THAN IGNORED: `MatrixKeeper` reads 21,229 here
  and session 3 recorded 21,282 — 53 bytes SMALLER now.** Nothing in this session touched
  `MatrixKeeper.sol` (mtime unchanged since session 3), and TierRouter, MatrixLogicLib and
  MatrixPairFactory all match session 3's figures EXACTLY, which rules out a toolchain or
  optimiser difference. The likely cause is mundane: session 3 ran `sizes.js` before its
  final edit to that file and recorded the earlier figure. **Direction is benign — headroom
  went UP, 3,294 -> 3,347 — so nothing is at risk.** Recorded because an unexplained number
  is an incomplete handoff, and 21,229 is now the figure to check future runs against.
- `sfRescueLadderPreset` stays **1**. No action.
- **The crossing buffer is the third lever and it is already decided by V8.49:** live V8.48
  hardcodes `CROSSING_BUFFER_BPS = 3600` and the model's Phase 1 warns about it every run —
  every rescue seeds 36% of the fee into withdrawable as SF money without passing through
  `_credit()`. V8.49 made it a governed param defaulting to **0**, and V8.50 carries that.
  Confirm it ships at 0 in the predeploy checks; it is worth more to the live fund's
  solvency than either decision above.

## ~~THE TWO OWNER DECISIONS — STILL OPEN~~ — SUPERSEDED BY THE SECTION ABOVE, KEPT FOR ITS REASONING

**1. PARAM 59 `insolvencyFloorBps` 3400 -> 5000.** Decided in session 2, still not applied.
**A new measurement complicates it and must be read before it is applied.** In the
`KeeperScan` world, 5000 does NOT close the cliff — those two members ask **$5.13** against
a $5.00 ceiling and are still evicted. Parity only returns at **6800**.

⚠️ **DO NOT CARRY THAT NUMBER TO THE LIVE CHAIN.** That world is `MATRIX_SIZE 7`, where one
journey earns **$2.44 (24%)** against the structural **$3.40 (34%)** at 127. Those members
are POORER than any real member and their ask is correspondingly larger. Live, `n=63`, the
maximum ask is **$4.28** — which 5000 clears with room, which is exactly why session 2
chose it. **The fixture measures the SHAPE of the cliff, not its live depth.** What it
does add, honestly: 5000 is not a large margin, the live max is 86% of the way to that
ceiling, and if journeys ever earn less than they do today the ceiling bites first.

**2. The SF rescue ladder's bottom rung.** Session 3 framed this as the lever. **The
reproduction says the floor is what bit, not the ladder** (see the correction above), so
the honest form of decision 2 is now: *is there a population that falls off the 4,000 rung
at all?* In the fixture, no — the poorest divergent member read 4,120. `model_item_a.js`
against the live population is what answers it.

**NEITHER IS SETTLED HERE, AND NEITHER SHOULD BE SETTLED FROM THE FIXTURES.** The command
is still the one session 3 gave, and it needs the owner because neither sandbox can reach
Base Sepolia:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
Remove-Item Env:ADDRESSES_FILE -ErrorAction SilentlyContinue
node scripts\model_item_a.js
```

## PROGRESS ON THE 21 — DOWN TO 3

Nine more closed after the owner's `test_v850_task2.txt` run. Every one was a fixture; no
contract logic changed (the only contract edit this session is the PARAM 59 default).

| what | tests | the fix |
|---|---|---|
| `V8.10` parkedAt / evictParked | 4 | new `parkOneAtReentry()` helper — follow the park to MatB |
| `V8.38` L1 / L2 / L4 | 3 | ensure-not-shove on `forceCross`; L1's precondition re-stated |
| `stress_test_full` S2 x2 | 2 | `sfContribution` = CROSSING_PRICE, not the full fee |

**`V8.10` x4 is the one worth reading**, because it is the template for most of what is
left. The fourteen-registration sequence used to leave `s0` parked in MatA. Measured now on
that exact fixture:

```
  matA  parked 0   occupancy 7   rotationCount 8     <- everyone crossed themselves
  matB  parked 1   [w1]          rotationCount 1     <- the one real park
```

So the tests follow the park to MatB via a shared helper that ASSERTS the precondition
loudly. They were never about which half the park happened in — they are about `parkedAt`
and `evictParked` mechanics — and saying so in the helper is most of the work.

**`stress_test_full` x2 is session 3's "bug sitting in plain sight", closed.** They passed
`sfContribution = T1_FEE` to `forceCrossKeeper` to make `memberShare` 0 and isolate the
seat guard. Under item A the whole crossing IS half a fee, so the full fee trips
`sfContribution <= crossingCost` FIRST and the seat guard was never reached. Now
`CROSSING_PRICE`, mirrored from `MatrixLogicLib`'s `internal` constant with its source
named — the same way `V8_48_SplitGrace.test.js` mirrors it.

### ✅ CLOSED 2026-08-18 ON MEASUREMENT — THE CLAIM BELOW IS FIXTURE-SPECIFIC

**READ THIS BEFORE THE SECTION IT PRECEDES.** Everything below was measured on
`V8Elevator`'s fixture, which picks its own tier fees. `scripts/model_item_a.js` PHASE 8
(added for this) reads the REAL ladder off each tier's MatA and asks the same question:

    THE LIVE FEE LADDER   T1 $10   T2 $25   T3 $50   T4 $100   T5 $250 ... T10 $10,000

    HOLDINGS AT THE MatA CYCLE-OUT, n=39 members who completed a journey
      V8.48 (crossing ate $5.00 of earnings)   min $0.00  median $0.00  max $5.90
      item A (reserve paid it in full)         min $3.40  median $3.40  max $10.90

    T2 ENTRY FEE $25.00 — who can upgrade at cycle-out?
      under V8.48    0 of 39
      under item A   0 of 39

**THE LOGGED CLAIM IS FALSE ON THIS CHAIN.** Nobody reaches T2 at their first cycle-out
in either world, so **T2's whale gate does not trip sooner, `tierGateThreshold` needs no
recalibration, and there is no contract change.** The `$7.66 against a $7 T2 fee` figure
below is the fixture's ladder; the live T2 fee is $25.00. **The open scope item is
CLOSED — measured, not real here.**

### ⛔ BUT THE REAL FINDING IS BIGGER THAN THE ONE THAT WAS LOGGED

Read the two holding rows again. **Under V8.48 the median member holds $0.00 after their
crossing.** A completed journey earns $3.40 and the crossing demands $5.00 of earnings on
top of the reserve — so the median member cannot fund the crossing at all. They park, or
they borrow. That is the 68 MatA parkers and the $727.05 of lending, seen from the
member's side rather than the fund's.

Under item A the same member keeps **$3.40 every cycle**.

So item A's effect on progression is not "T2 arrives one cycle sooner". It is that **T2
becomes reachable AT ALL for the median member** — roughly eight cycles of accumulation
at $3.40, against a V8.48 per-cycle balance of zero and no upward path whatsoever.

**Correct the framing wherever it appears.** This document has said "the benefit arriving
faster than predicted". It is not faster. It is **existing where it previously did not**.
That is a stronger claim, it is measured, and it is the one to use with members.

⚠ NOT MODELLED: multi-cycle accumulation. PHASE 8 answers only "does item A move the
FIRST cycle-out across the T2 line", which is the specific claim that was logged. The
eight-cycle figure above is arithmetic on the median, not a simulation. A real
progression model would simulate repeated cycles and is a separate piece of work.

---

### THE ORIGINAL ENTRY, KEPT VERBATIM — ⛔ ITS NUMBERS ARE THE FIXTURE'S, NOT THIS CHAIN'S


**Two failing tests turned out to be one finding, and it is not a test problem.**

At a MatA cycle-out under V8.48 the crossing consumed a full fee — $5 reserve + $5
earnings — leaving a T1 member $2.66 against the $7 T2 fee, so the additive cycle-out's
UPGRADE leg could not fire. Item A charges that crossing $5 and leaves **$7.66**. Measured
on `V8Elevator`'s own fixture: W1 now reaches **tier 2 inside nine registrations**, seated
in MatB and MatA2 at once.

**Nothing new fires and nothing leaked.** The additive cycle-out is V8.43 behaviour that
merely became AFFORDABLE; the T2 whale gate stays shut; and cycle-completed eligibility
bypassing a closed gate is deliberate and pinned by V8.44 UX3/C2. The member did not skip
MatB — they hold both seats.

**THE CONSEQUENCE IS ECONOMIC AND IT IS LIVE.** `tierGateThreshold` and
`whaleGateThreshold` were calibrated in a world where members could not afford to upgrade
at their first cycle-out. **T2's whale gate will now trip sooner than V8.48 modelled**,
because members reach the tier one cycle earlier. Owner decision 2026-08-17: **ACCEPT it —
this is the "more completed rotations, more tiers, more CNOVA" benefit the scope promised,
arriving faster than predicted — and log the threshold recalibration as an OPEN SCOPE
ITEM.** No contract change; nothing blocks the deploy.

**The two tests were asserting POVERTY, not the rule they were named for.**
`tierFirstEntries(2) == 0` was only ever true because nobody could afford to move. The
whale-gate test now asserts what it was always about — the gates are per-tier, and
tripping T1's does not trip T2's. **DONE.** The 15-registration test is NOT done and is a
walk-through item below, because its assertion pins a different rule.

**STILL OPEN, for whoever picks this up:** re-measure when T2's gate trips under item A
against the live population before the thresholds are trusted. `scripts/model_item_a.js`
does not model tier progression today; it would need a new phase.

### ⛔ NEW SCOPE FINDING: `EvictionReserveReleased` IS NOW ALL BUT UNREACHABLE

> ⛔⛔ **CORRECTED 2026-08-21 (19.18b) — THE TABLE BELOW IS WRONG ON `:906`, AND `:906` IS
> ONE OF THE TWO ROWS IT CONCLUDES WITH.** `:906` parks a member ONLY when they are already
> `isActiveInMatrix` in the partner, which is exactly the ghost test `evictParked` runs
> first — so it dequeues and releases nothing, the same as `:876` one row above it. **ONE
> door survives, not two, and it is `:523`.** Read 19.18b before building anything against
> this table. Also: exercising the release path does NOT need a deploy (19.18a).


Found while walking GF-V3, and it is worth more than the test fix it came from.

Releasing a crossing reserve on eviction needs a member who is **(a) parked, (b) holding a
reserve, and (c) NOT seated in the partner half** — because a holder seated in the partner
is a GHOST, and the valve dequeues those without touching a balance. Every park site in
`MatrixLogicLib` was walked against that three-part test:

| park site | holds a reserve? | a ghost? | reachable under item A |
|---|---|---|---|
| `:947` funding shortfall | yes | no | **NO — item A deleted this park** |
| `:876` duplicate seat | yes | **YES, by construction** | dequeue-only, releases nothing |
| `:1461` `softParkIdle` | no — releases it itself at `:1447-1450` | no | n/a |
| MatB, any cause | no — item A spent it | no | n/a |
| `:906` mid-cascade deferral | yes | no | yes |
| `:523` cascade-refill on entry | yes | no | yes |

**Only the last two survive, and no test in this suite constructs either deliberately.**
Measured, not reasoned: a duplicate holder parked in MatA was built and evicted — the
contract emitted `GhostDequeued`, not `MemberEvicted`, and released nothing. Correct
behaviour, and it closes off the one path that looked promising.

**So on the live chain, eviction will essentially never release a reserve under item A:
the members who still hold one when they park are ghosts, and ghosts are dequeued.** That
is not a bug — it is item A removing the poverty park, which was the only common way to be
parked while still holding a carve.

**WHAT NEEDS DECIDING (not urgent, not deploy-blocking):** whether the release path is
still worth carrying. It is live code with a live event and near-zero reachability. GF-V3
now pins the behaviour that actually ships — a MatB eviction releasing nothing — and
asserts `EvictionReserveReleased` count is **0**, which will fail loudly if anything ever
starts carving a MatB reserve again. That makes it a regression guard for item A rather
than coverage of the release.

### ⛔ WALK-THROUGH ITEMS — 3 LEFT OF 6

**DONE:** GF-V1 and GF-V3 (below), on the owner's go-ahead 2026-08-17.

**GF-V1 — SOLVED BY MOVING TO A CONSTRUCTION THAT STILL WORKS.** It swung *MatA's* partner
to the decoy and seated through `_enterMatrix` into a FULL MatA, which under item A
cascades a real cycle-out into an unwired decoy. `V8_46_PairGuard` G2's construction was
adopted instead — swing *MatB's* partner, seat both halves through the PairManager BEFORE
anything is full, restore — so nothing cascades and the decoy never has to accept a
crossing. Hoisted into shared `forceSeat()` / `seatBothHalves()` helpers in that file.

**GF-V3 — RESOLVED AS A FINDING, see above.**

**`CycleOutDebug` — REBUILT, NOT RETIRED, AND THE FIRST CALL ON IT WAS WRONG.** It was
triaged as "retire it, the behaviour is covered by `V8_44_CycleOut` and
`V8_48_RescueSurplus`". **That was judged from the filename and the error message, not
from reading the file, and it was wrong.** Those two cover `selfRescue` and `coPayRescue`
— the member paying for THEMSELVES. Checked properly: only two files call both
`payForceCross` and `forceCrossKeeper`, this one and `stress_test_full`, and
`stress_test_full` only exercises the REVERT paths. `V8_44_Keeper` covers force-rotation
and epochs, not member rescues.

**So this is the ONLY test in the suite where the Stability Fund successfully rescues
anybody** — and this handoff's own open-items list already says *"no end-to-end test that
a real rescue books shortfall and nothing more"*. Deleting it in the same release that
REPRICES rescues would have thinned a known-thin area at exactly the wrong moment.

It moved instead: members now park at the MatB cycle-out, where re-entry costs a full fee,
and that is where the live keeper will find them. The rebuilt flow asserts MatA parks
NOBODY, the member holds no reserve, the floor refuses a full-fee advance at the NEW $5.00
ceiling (PARAM 59 = 5000), the floor is raised, SF funds, `forceCrossKeeper` completes it,
and the member re-enters MatA **with a fresh $5.00 reserve carved**.

Two assertions were tried and abandoned on the way, both recorded in the file: "the queue
is empty" and "the count dropped by one". Both are wrong for the same reason — the rescue
re-seats the member, which cascades, which cycles ANOTHER member into their own re-entry
park. One out, one in, net zero. **That churn is item A's thesis showing up as a side
effect, not a fault.** The test scans for the rescued member's ABSENCE instead, which says
what the rescue promised and nothing about the fixture's shape.

**STATUS: 592 passing / 7 pending / 3 failing** (was 60 failing at the start of session 4).
Remaining: the 15-registration re-entry-priority test, `V8.35` G4, and `V8_44_Overflow`
O1+O2 — items 1, 6 and 4 of the walk-through list.

### ⛔ THE ORIGINAL SIX, FOR REFERENCE

**Owner instruction 2026-08-17: walk through each before changing anything.** They were
triaged as "the same fixture shape" and they are NOT. Every one asks what the test should
now MEAN, and each answer is a small policy decision. **The mechanical tail is finished;
this is the judgement tail.**

1. **`V8Elevator` — 15-registration re-entry priority** (`expected 2 to equal 1`).
   Pins the V8.44 rule *re-entry has priority over upgrade at a MatB cycle-out*. Item A
   moves the upgrade EARLIER — to the MatA cycle-out — so W1 is already T2 before the
   moment this test examines. The rule is still real; the fixture no longer isolates it.
   Complication: proving "funds went to re-entry, not upgrade" needs a tier ABOVE the
   member's current one to be available, and T3 is not deployed in this fixture.

2. **`GF-V1` — the ghost can no longer be constructed.** It swings MatA's partner to a
   decoy, seats W1 through the decoy, restores the pair. Under item A that entry cascades
   a REAL cycle-out; the root can now afford to cross; it crosses into the unwired decoy
   and dies on `F8V8: not authorized`. Under V8.48 the root was underfunded and simply
   parked, so the cascade never reached the partner. **Recommendation: build the ghost at
   a moment the matrix cannot cascade — do NOT wire the decoy, because a decoy that
   accepts crossings has stopped being a decoy.**

3. **`GF-V3` — eviction's reserve release may now be DEAD CODE, and that is the real
   question.** It asserts a cycle-out park keeps its $5 reserve, then that `evictParked`
   emits `EvictionReserveReleased` and folds it into withdrawable. Under item A a MatB
   parker holds $0.00, so nothing is released and the event does not fire
   (`releaseReserve` guards `r > 0`). **And a MatA parker — the only member who still
   holds a reserve — no longer exists: MatA parks nobody.** So before re-fixturing, answer
   the real question: **is `EvictionReserveReleased` reachable at all under item A?** If
   not, that is a scope finding, not a test edit.

4. **`V8_44_Overflow` O1+O2 — needs a member who no longer exists.** Requires a parked
   MatA member to `selfRescue` into a full MatB. The invariant it protects (own members
   return to their OWN pair, never a later one) is worth keeping, but re-pointing it at a
   MatB parker breaks one assertion outright: *"own MatB must rotate from the rescue
   entry"* stops being true, because a MatB parker re-enters MatA and does not rotate
   MatB. Something must be re-stated, not re-pointed.

5. **`CycleOutDebug` — its entire premise is what item A deletes.** The test is *"W1 parks
   on cycle-out (insufficient funds), keeper rescues to MatB"*. Item A means W1 crosses
   itself; there is no park and no rescue. **Recommendation: this one is a genuine
   RETIRE-or-repoint decision, and retiring it is defensible** — it is a diagnostic
   harness, its behaviour is covered by `V8_44_CycleOut` and `V8_48_RescueSurplus`, and
   keeping it means inventing a scenario item A worked to prevent.

6. **`V8.35` G4 — a member count moved** (`expected 9 to equal 8`). FIFO placement after a
   factory expansion. Item A changed who is seated where at the moment the factory fires,
   so the count shifted. **Needs reading before touching: this is the only one of the six
   where the FACTORY, not the parked queue, may be what moved.**

### THE 6 THAT REMAIN

- **9 of one shape — a fixture that needs a parked member item A no longer produces:**
  `V8_44_CycleOut` T1-T4, `V8_44_Overflow` O1+O2, `V8_47_UpgradeGate` G3, `CycleOutDebug`,
  `GhostFloor` GF-V3, `V8.35` G4. Four of them announce it outright with
  `expected 0 to equal 5000000` — a fixture asking for a $5 reserve item A no longer
  carves. `V8_48_RescueSurplus.test.js` and the `V8.10` helper are the two worked examples.
- **3 odd ones, each needing to be READ rather than pattern-matched:** `V8Elevator`'s
  15-registration re-entry count (`expected 2 to equal 1`), the `V8.21` whale gate
  (`expected 1 to equal 0` — a first-entry counter, possibly a genuine behaviour question
  rather than a fixture), and `GhostFloor` GF-V1 (`F8V8: not authorized` inside `seatVia`,
  a different failure entirely). **Do not assume these are the same job as the nine.**


## STATE OF THE TREE

**No chain was touched. No transaction sent, nothing deployed, no parameter set, the VPS
keeper untouched, live V8.48 exactly as it was.** `.env` line 69 is still
`deployed_addresses_v8_48.json`. Every command run was a read, a local build, or a test —
and every test ran in a sandbox container, never against a chain.

**`contracts/` is UNCHANGED from `24c193c`.** Seven files in `test/` are modified, plus `scripts/model_item_a.js` (the PARAM 59 sweep), and
nothing is staged. Git is the owner's to run:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
git status
git add test/V8_48_SplitGrace.test.js test/V8_48_GhostFloor.test.js test/V8_49_InsolvencyFloor.test.js test/V8_49_EvictionClock.test.js test/V8_48_RescueSurplus.test.js test/V8_48_KeeperScan.test.js test/V8Elevator.test.js scripts/model_item_a.js V8_50_HANDOFF.md
git commit -m "V8.50: re-fixture the 24 tests that encoded pre-item-A economics; scope the KeeperScan equivalence premise and pin its one divergence"
git push origin v8.1
```

**Before the run whose numbers you intend to trust** — session 3's rule, unchanged:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat compile --force
npx hardhat test 2>&1 | Tee-Object -FilePath test_v850_task2.txt
```

…and remember that capture will be **UTF-16**. Decode before searching it.

## NEXT, IN ORDER

1. **The owner runs the suite** and the diff is taken mechanically against
   `test_v850_task1b.txt` — failure titles as sets, both files decoded first. The
   prediction above is 21 green and 1 new.
2. ~~`model_item_a.js`, then the two decisions~~ — **DONE, both settled above.**
3. **The remaining 12**, listed above. Nine are one shape with two worked examples; three
   need reading rather than pattern-matching.
4. **Defects 2 and 4** from the scope (`DIRECT_EARN_BPS = 500`, `totalEarnedOf`).

## METHOD NOTE FROM THIS SESSION

**A sandbox reproduction of the repo paid for itself many times over, and its limits are
the first thing to state about it.** Building the project in a clean container turned a
four-minute owner round-trip into a seven-second loop, and three of this session's results
could not have been reached without iteration: the RescueSurplus queue measurement, the
$0.95 commission that was silently corrupting an exact assertion, and the PARAM 59 sweep
that overturned session 3's reading of the cliff. It also **drifts from the owner's
machine by two tests**, which is exactly why every number above says where it came from.
The repo's own standing rule applied to itself: give every instrument something to check
itself against, and say which instrument produced which number.

---

# ⬛ SESSION 3 STATE — 2026-08-16, EVENING. READ THIS FIRST, BEFORE SESSION 2.

Session 2's plan is still the plan. This section says what happened building step 1 of it,
**corrects two things session 2 got wrong**, and names the one decision that is the owner's.

## THE HEADLINE NUMBERS — MEASURED, NOT ESTIMATED

| | passing | failing |
|---|---|---|
| baseline, item A stashed (session 2) | 593 | 1 |
| item A only (session 2, `after.txt`) | **543** | **51** |
| + session 3 keeper fix (`test_v850_task1b.txt`) | **534** | **60** |

**9 new failures, 0 fixed, every one attributed below.** The diff was taken mechanically
against `after.txt`, not by eye — decode, slice from the `N failing` line, compare failure
titles as sets. Do that again rather than reading 60 stack traces.

⚠️ **`after.txt` AND EVERY `Tee-Object` CAPTURE IS UTF-16.** `grep` finds nothing in them and
exits 0, which reads exactly like "no failures". Decode before believing any search of these
files. Windows PowerShell 5.1's `Tee-Object` has **no `-Encoding` parameter** (that is
PowerShell 7+), so this cannot be fixed at the capture site — fix it at the read site.

## WHAT SHIPPED (branch `v8.1`, compiles, sizes checked)

**`MatrixKeeperLib.sol` + `MatrixKeeper.sol` — the keeper now prices a rescue at what the
crossing COSTS, not at the entry fee.** New `_crossingCost(mat, fee)` mirrors
`MatrixLogicLib._crossingPrice` and the `cfg.isMatrixA ? … : …` line that appears in six
places there. It feeds three things in BOTH discovery (`_triageParked`) and execution
(`_doParkedRescue`): the ladder's denominator, `maxShortfall`, and `sfShare`.

**This half is load-bearing, not polish.** `forceCrossKeeper` REQUIRES
`sfContribution <= crossingCost`; a keeper still computing against the full fee hands it up
to 2x that and reverts its own rescue. `stress_test_full.js` proves it — two tests there fail
with `'F8V8: sfContribution exceeds fee'`, and they failed that way in session 2's run too,
before any keeper change. That was the bug sitting in plain sight in the 51.

**`MatrixKeeper.sol:722` zero-balance trap is now gated on `isMatrixA()`.** `reserve == 0`
was evidence of destitution only while every seated member was guaranteed to hold one. Under
item A it is the normal healthy state for every MatB member. In a MatA the old evidence still
holds, and those members keep V8.48 behaviour exactly.

**`TierRouter.sol` — COMMENTS ONLY, no executable change. See correction 1.**

**Sizes (`node scripts\sizes.js`): MatrixKeeper 21,282 (3,294 spare) · TierRouter 23,910
(666) · MatrixLogicLib 24,013 (563) · MatrixPairFactory 24,228 (348).** All fit.

## ⛔ CORRECTION 1 — SESSION 2'S TASK 2 WAS A FALSE ALARM. NO CODE CHANGE WAS NEEDED.

Session 2 wrote: *"`TierRouter` escrow-zero … makes the `escrow > 0` graduation branch at
`TierRouter.sol:1428` unreachable and dropping members into a park labelled 'autoReentry
disabled' — a misleading reason for a healthy member."* Checked against the source:

1. **Nothing is lost.** That branch's only work is releasing an UN-CONSUMED reserve. At
   escrow 0 there is nothing to release, and `releaseReserve()` guards on `r > 0` anyway. A
   member who entered a MatB at full fee still trips `escrow > 0` and is still released — so
   the test stays rather than being deleted.
2. **No healthy member is mislabelled.** The underfunded member is caught by the FIRST
   branch, `!anySeat && reentryOn`, evaluated BEFORE escrow is read, emitting "insufficient
   funds". "autoReentry disabled" is only reachable when re-entry genuinely is disabled.

**And every funding gate decides identically, because the conservation is exact.** At a T1
MatB cycle-out with no referrals: V8.48 = $5.00 reserve + $3.40 earnings − $1.60 crossing
debt = **$6.80**; V8.50 = $0.00 + $3.40 (journey A, KEPT) + $3.40 = **$6.80**. Same money,
same $10 re-entry. The V8.48 member just borrowed twice and parked mid-cycle to get there.

**WHERE THE MISREADING CAME FROM, closed rather than left open:** neither graduation branch
calls `parkCycledOut`. They emit `MemberParked` and park nobody — the member GRADUATED. The
event name is V8.44 legacy and reads like an eviction in the logs. **That is a real naming
defect**, frontend-and-tooling scope, deliberately not dragged into the item A diff.

## ⛔ CORRECTION 2 — SESSION 2'S ATTRIBUTION WAS WRONG, AND SO WAS ITS PRESCRIPTION

Session 2 said *"`V8_48_KeeperScan.test.js` (~44)"* of the 51. **That suite has 13 tests and
9 of them fail.** The other ~42 were never attributed. Do not trust "each is attributed" —
the run itself is the list.

More importantly, session 2's prescription — *"the ladder must stop reading a spent reserve
as poverty"* — was **built, tested, and reverted the same hour.** The full write-up sits at
the top of `MatrixKeeperLib._triageParked` so the next session does not rebuild it:

- The credit was `withdrawable + max(reserve, carve)`. For a MatA member the DENOMINATOR is
  the carve, so `wBps >= 10_000` always: **it made `EVICT_LADDER` unreachable for everyone,
  in every matrix.** A member holding nothing read as a top-rung self-funder, the keeper
  queued a rescue `forceCrossKeeper` refuses, swallowed as `WorkItemFailed`, retried every
  tick. **An eviction traded for an infinite loop.**
- The premise double-counted borrowed money. The only position where V8.48 reads higher is
  mid-journey in a MatB ($6.70 vs $5.10), and that gap **is** the $1.60 SF loan that funded
  the old full-fee crossing and got carved into a reserve. V8.48's number was inflated by
  debt; "restoring" it restores an artefact of the double-lending item A exists to remove.

**PROOF THE BACK-OUT DID WHAT IT CLAIMS**, because "it feels right" is not evidence: `EC-1`
and `EC-4` name their failing leg. With the credit in they failed on **`ladder:`**; with it
out they fail on **`floor:`**. The ladder behaviour is restored; what remains is a different
cause.

## THE 9 NEW FAILURES — TWO EFFECTS, BOTH INTENDED, NEITHER A BUG

**(a) ADVANCES GOT SMALLER, so the insolvency floor stops refusing — 6 of 9.**
`GF-D1`, `IF-7`, `IF-10`, the floor legs of `EC-1`/`EC-2`/`EC-4`, and the three
`V8_48_SplitGrace` fixtures ("ONE UNIT SHORT is a loan", "the 84% member … is unaffected",
"a LOAN rescue does NOT fire when the fund cannot cover it"). **The 84% member is exactly who
item A is for** — they need $5, hold $5, borrow nothing. These encode the pre-item-A
economics and must be RE-FIXTURED, not fixed.

**(b) THE LADDER CLIFF IS REAL AND IS NOW REPRODUCED — the owner's decision.**
Inside the already-failing `KeeperScan` diffs, this code now **evicts** in slots where the
frozen V8.48 copy rescued. Honest arithmetic: an early-MatB member reads ~**3,400 bps**
against preset 1's bottom rung of **4,000** and falls off it — debt-free, where V8.48 kept
them on it owing $1.60. **This was analysis in session 3 and is now a fixture result.**
Deliberately NOT fixed in code: the lever is `sfRescueThresholds`, a governed preset (presets
2 and 3 reach 3,000 and 1,000). It is an economic trade-off, not an arithmetic one.

## ⛔ TWO OWNER DECISIONS, TAKEN TOGETHER, BEFORE THE RE-FIXTURE IS FINISHED

1. **PARAM 59 `insolvencyFloorBps` 3400 -> 5000** — decided in session 2, still not applied
   (a deploy-time setting, not code).
2. **The SF rescue ladder's bottom rung.** Keep preset 1 (bottom 4,000) and accept that
   early-MatB members fall off it, or move to preset 2 (3,000) / preset 3 (1,000). Framing:
   under item A these members carry NO debt where V8.48 gave them one, so falling off the
   ladder is not the same event it was.

**Do not settle 2 from the fixtures alone** — run `scripts/model_item_a.js` against the live
population the way session 2 did, so the answer is measured on real members.

## NEXT, IN ORDER

1. **Re-fixture the 6 old-economics tests** (`SplitGrace` ×3, `GF-D1`, `IF-7`, `IF-10`) at a
   MatB re-entry, where a full fee is still charged, instead of a MatA crossing.
2. **`V8_48_RescueSurplus.test.js` (3)** — still "fixture produced no parked member", still
   item A working, same re-fixture. Unchanged since session 2.
3. **Decide the `KeeperScan` premise.** It pins the keeper byte-identical to a frozen
   `MatrixKeeperPrev`; item A changes the WORLD, so the premise is structurally incompatible.
   Session 2's advice stands: decide deliberately, record which and why.
4. **Then** the two owner decisions, then defects 2 and 4 from the scope.

## METHOD NOTES FROM THIS SESSION

- **A prediction at the wrong granularity is not a wrong diagnosis.** I predicted 60 -> 57
  and got 60. The diagnosis was right — `EC-1`/`EC-4`'s ladder leg DID recover — but these
  are MULTI-ASSERTION tests and fixing one leg does not turn a test green. Predict the
  assertion, not the test.
- **`npx hardhat compile` printed "Nothing to compile" for a file that HAD changed.** The
  cache's `contentHash` matched the on-disk md5, so Hardhat had seen it — but stale-artifact
  risk under a 594-test run is not worth reasoning about. `npx hardhat compile --force`
  settles it in 90 seconds. Do that before any run whose numbers you intend to trust.
- **Verify a write landed via `device_bash`, not the upload cache** — `wc -c` plus a `grep`
  for a string you just wrote. The cache served a stale file earlier in this project and cost
  an hour.
- **Two orphaned docstrings found and closed**, both the same shape: a comment left behind
  when its function moved, silently re-attaching to the next function.
  `MatrixKeeper.pendingChainLinkCount()` carried the SF-ladder docstring (stranded by V8.48
  item 12a); `TierRouter` had `reservedFor`'s sitting above `setGlobalJoined`. Worth a sweep —
  this repo has moved a lot of code between files.

## STATE OF THE TREE

No chain was touched. **No transaction sent, nothing deployed, no parameter set, the VPS
keeper untouched, live V8.48 exactly as it was.** `.env` line 69 is still
`deployed_addresses_v8_48.json`. Every command run was a read, a local build, or a test.

Session 3's work is COMMITTED AND PUSHED to `v8.1` as **`24c193c`** (4 files, +500/-68):
`contracts/MatrixKeeperLib.sol`, `contracts/MatrixKeeper.sol`, `contracts/TierRouter.sol`
(comments only), and this file — this line was corrected in a follow-up commit, so the
handoff itself is one commit later than the code. New
scratch captures in the repo root: `test_v850_task1.txt` (ladder-credit run, superseded) and
`test_v850_task1b.txt` (current). Both redundant once the numbers above are read; session 2's
`after.txt`/`before.txt` are still the baseline and should be kept until the re-fixture lands.

---

# ⬛ SESSION 2 STATE — 2026-08-16, LATER THE SAME DAY.

Everything below section 1 is still the plan. This section says what
happened when we started building it, and **it contains one finding that reorders the work.**
**Read session 3 above first — it corrects this section's task 2 and its failure attribution.**

Read `V8_50_SCOPE.md`'s "⬛ MEASURED ON THE LIVE V8.48 COMMUNITY CHAIN" section next — it
carries the numbers, the five source defects, and the two wrong turns the new instrument
took before it was right.

## WHAT IS DONE

- **Item A modelled against the real population.** New tool `scripts/model_item_a.js`.
  Note the handoff's own pointer was wrong: `model_insolvency_floor.js` does NOT model
  item A, it models the three floor POLICIES. Item A is confirmed and sized — frees
  **76 of 139** parked members outright, premise holds **100%** on chain, removes
  **63.7%** of all funding parks. Re-entry ask afterwards: median **$2.71**, better than
  the $3.20 the plan predicted.
- **ITEM C IS DECIDED BY THE OWNER: `insolvencyFloorBps` 3400 -> 5000.** Measured, not
  asserted: the rule *"never lend more than one full journey's earnings"* was calibrated
  on the STRUCTURAL no-referral minimum, but one completed journey actually earns
  **min $3.40 / median $4.83 / max $6.34**. At 5000 the maximum measured ask ($4.28)
  clears, so **all 63 members at re-entry are rescued** and item B's promise holds.
  NOT YET APPLIED — it is a PARAM 59 setting, not a code change.
- **Item A's contract core is written and COMPILES** — `contracts/MatrixLogicLib.sol` on
  branch `v8.1`, one file. See "WHAT THE CODE DOES NOW". It is NOT deployed anywhere and
  **must not be** until step 1 below is done — see the finding immediately after this list.

## ⛔ THE FINDING THAT REORDERS THE WORK

**Item A creates a member state that has never existed before: a live mid-cycle member
holding a ZERO crossing reserve.** Every MatB member is now in that state, because their
reserve was spent getting them there and no new one is carved.

The keeper is not ready for it, and the failure is not benign:

```
MatrixKeeperLib._triageParked:432   effectiveContrib = reserve + withdrawable
MatrixKeeperLib._rescueBpsFor:359   wBps = effectiveContrib * 10_000 / entryFee
```

With `reserve == 0` a MatB member's `effectiveContrib` roughly HALVES, `wBps` drops, and
they fall off the bottom of the SF rescue ladder — which routes to **EVICT_LADDER**.
`MatrixKeeper.sol:722`'s `withdrawable == 0 && reserve == 0 && debt > 0` trap is a second
door to the same place.

**So item A shipped WITHOUT the keeper change does not merely fail to help members at
re-entry — it evicts members the old code would have rescued. That is the exact opposite
of item B.**

**THE KEEPER CHANGE IS LOAD-BEARING FOR ITEM A'S SAFETY, NOT POLISH. THEY SHIP TOGETHER
OR NOT AT ALL.** The ladder must stop reading a spent reserve as poverty: what matters is
what the member needs NEXT (a full fee at re-entry) against what they hold, not a reserve
that item A deliberately consumed.

## TEST STATE — MEASURED BOTH WAYS. DO NOT GUESS AT THIS.

| | passing | failing |
|---|---|---|
| baseline (item A stashed) | **593** | **1** |
| with item A | **543** | **51** |

**All 50 new failures are ours.** A confident prediction in this session that
`V8_48_KeeperScan.test.js` used mock matrices was WRONG — it deploys real
`FigureEightMatrixV8` with the real `MatrixLogicLib` at test:152-157. Caught only because
the baseline was actually run instead of reasoned about.

- **The 1 pre-existing failure is inherited debt and is a TEST bug, not a contract bug:**
  `V8.46-B — cascade gas versus ladder depth`, `TypeError: Cannot read properties of
  undefined (reading 'worst')`. Log it; do not let it confuse a future run.
- `V8_48_RescueSurplus.test.js` (3) fails with *"fixture produced no parked member"* —
  **that is item A working.** The fixture parks someone at a crossing they cannot afford;
  under item A their reserve covers it and they cross. Re-fixture at a MatB re-entry,
  where a full fee is still charged.
- `V8_48_KeeperScan.test.js` (~44) asserts the refactored keeper is byte-identical to the
  frozen `MatrixKeeperPrev` (a V8.48 artifact). **The file states its own doctrine at
  test:190-199: every later item that deliberately changes behaviour gets PINNED, and
  "every pin here is an item that DID."** Item A cannot be pinned that way — it changes
  the WORLD, not a keeper parameter, and `MatrixKeeperPrev` will never know about item A.
  **This suite's premise is structurally incompatible with V8.50.** Do NOT delete it
  reflexively; decide deliberately (retire with a note / re-baseline the frozen copy /
  scope it to untouched behaviours) and record which and why.

## WHAT THE CODE DOES NOW — `contracts/MatrixLogicLib.sol`

The discriminator is **`cfg.isMatrixA`, the matrix's own immutable flag**. Crossing out of
a MatA means crossing into a MatB, which is the hop the reserve pre-funded. Everything
else enters a MatA and begins a new cycle at full fee. No interface change, and no
cross-contract read added to the money path.

**This decides the tier-upgrade question the scope told us to decide deliberately:**
upgrades arrive via the PairManager, never as the partner, so they take the full-fee
branch automatically and fund their own reserve. It cannot fall out of the diff wrongly.

- `_crossingPrice(entryFee)` — new helper, `entryFee * CROSSING_RESERVE_BPS / BPS_DENOM`
- `_crossToPartner` — charges `crossingCost`; `CrossingFunded` now reports the real total
- `enterMatrix` — pulls the crossing price on a crossing. `isCrossingEntry` is the
  destination-side twin of the source's price decision and **the two must agree or the
  transferFrom reverts on allowance.**
- `_distributePayments(..., bool skipReserveCarve)` — **the other half of item A. THE
  CARVE AND THE PRICE MUST MOVE TOGETHER:** carve on + full fee in = 10_000; carve off +
  50% in = 5_000. Either alone breaks the contract's cash balance.
- `_finalizeCrossing` — same price rule, and **now emits `CrossingFunded` (defect 5)** so
  rescued crossings stop being invisible to event tooling
- `forceCross` — **BUG FIXED:** pulled a full fee for an A->B hop, stranding 50% in the
  matrix as unattributed surplus
- `forceCrossKeeper` — **BUG FIXED:** unconditionally zeroed the reserve, erasing anything
  above the crossing price. Harmless while reserve == fee; not any more.
- `coPayRescue` / `_selfRescue` — priced at `crossingCost`, so an A->B hop needs no loan
  and no out-of-pocket payment at all
- **DELIBERATE NON-CHANGE:** the withdraw lock (`crossNeeded`, at :686 and :1345) stays at
  the FULL fee. A MatA member no longer needs it for the hop but WILL need it for the
  re-entry, and this lock is what accumulates it. Measured: **0 of 63** members at
  re-entry had withdrawn to wallet — the lock is doing all of that work. Repricing it
  would send members into MatB with nothing. The code says so; do not "simplify" it.

## NEXT, IN ORDER

1. **`MatrixKeeperLib` + `MatrixKeeper` for the zero-reserve state.** Load-bearing, see
   above. The keeper interface already has `isMatrixA()` (`MatrixKeeperLib.sol:89`, used
   at `:342`), so it can discriminate without new plumbing.
2. **`TierRouter` escrow-zero.** `MatrixLogicLib:775` passes the reserve as `escrow` to
   `handleCycleOut`; at MatB cycle-out that is now always 0, making the `escrow > 0`
   graduation branch at `TierRouter.sol:1428` unreachable and dropping members into a park
   labelled "autoReentry disabled" — a misleading reason for a healthy member.
3. **Re-fixture the tests**, and decide the `KeeperScan` question above.
4. **Scope defects 2 and 4** — `MatrixKeeper.DIRECT_EARN_BPS = 500` (dead but public, and
   wrong) and `totalEarnedOf` (the true earnings field has no getter, and the keeper's
   withdraw-ratio eviction test runs on a reconstruction that includes buffer money).
   Defect 1, the stale split comments, is DONE.
5. **Set PARAM 59 to 5000** at deploy, per the owner's decision.
6. **Second organic reading** — `logs/parked_baseline.csv` has one row for this
   deployment; a growth RATE needs two, and bigfill restarting ends the window forever.

## STATE OF THE WORKING TREE AND EVERY LOOSE END

Nothing in this session touched a chain. **No transaction was sent, nothing was deployed,
no parameter was set, the VPS keeper was never touched, and live V8.48 is exactly as it
was.** Every command run was a read or a local build/test.

**Files changed or added by session 2** (all on branch `v8.1`, contracts push to `v8.1`):

| file | what |
|---|---|
| `contracts/MatrixLogicLib.sol` | item A core. Compiles. Not deployed. |
| `V8_50_HANDOFF.md` | this file |
| `V8_50_SCOPE.md` | the measured findings section |
| `scripts/model_item_a.js` | new read-only instrument |

**Scratch files left in the repo root, safe to delete, deliberately NOT deleted here:**

- `after.txt` / `before.txt` — the two test runs behind the 593/1 vs 543/51 table above.
  Both counts are recorded in this document, so the files are redundant once read.
- `predeploy_A.txt`, `predeploy_B.txt` (2026-08-16 early), `predeploy_out.txt`
  (2026-08-13) — **these predate session 2 and are NOT ours.** They are predeploy_check
  output from the V8.49 and V8.48 deploy days. Left alone deliberately: an unexplained
  file is an incomplete handoff from an earlier session, and deleting one to tidy up
  destroys the record rather than closing the loop. Someone should confirm what they were
  for and then either log or remove them.

**Open, and each one is written up above rather than left implicit:**

1. The keeper's zero-reserve handling — **blocking, and the reason item A must not ship
   alone.**
2. `TierRouter` escrow-zero at MatB cycle-out.
3. 50 failing tests, all attributable, none mysterious.
4. The `KeeperScan` premise decision.
5. Defects 2 and 4 from the scope's list.
6. PARAM 59 -> 5000 at deploy (decided by the owner, not yet applied).
7. **The second organic reading is DONE — and it raised a question. See below.**

## ⛔ THE ORGANIC READING: 41 MEMBERS LEFT THE QUEUE AND THE FUND DID NOT MOVE

Two `diag_floor_halt.js` readings on live V8.48, 2.0 hours apart, both fully organic
(no bigfill since 03:30:44 -04:00):

```
parked          139 -> 98     (-41)
SF totalBalance $458.35 -> $458.35   (UNCHANGED, to the cent)
debtors         29 -> 23      debt total $32.74 -> $28.20
```

`logs/parked_baseline.csv` now has 2 rows for this deployment and the script printed a
trend: **"-496.1/day"**.

**DO NOT QUOTE THAT NUMBER AS THE QUEUE DRAINING.** It is the first organic trend this
project has ever had and it is almost certainly not what it looks like:

- **A rescue costs the Stability Fund money. The fund did not move by one cent.** So
  whatever removed 41 members, it was not the rescue path.
- **Debt-carrying members left too** (29 -> 23, $32.74 -> $28.20) **and the fund did not
  RISE either** — so their debt was not repaid on the way out.
- The remaining top-20 are the same addresses with the same balances, 2.0h older. The 41
  came from elsewhere in the queue.

Three candidate mechanisms, none confirmed, and they mean completely different things:

1. **Eviction.** `evictParked` releases the reserve to withdrawable, removes the member,
   leaves the debt on the SF ledger, and costs the fund nothing. If this is it, **41
   community members were evicted in two hours** — which is precisely what item B exists
   to prevent, and it makes V8.50 more urgent, not less.
2. **Ghost / residue dequeue.** The V8.48 item 45 `clearParkRecord` and item 47 valve
   remove queue entries for members who are actually seated. `diag_ghost_parked.js`
   measured **41 ghosts** on 2026-08-13 — the same number, which is either a strong hint
   or a coincidence worth ruling out. If this is it, no member was harmed and the queue
   never really held 139.
3. **Self-rescue** from members' own wallets — costs the fund nothing, but bigfill is
   stopped and these are bigfill wallets, so this is the weakest of the three.

**Do not reason further about this — measure it.** `scripts/diag_parked_growth.js` exists
and answers exactly this question: parks vs rescues vs **evictions** per day, the
repeat-park loop signature, and the SF debt financing. It is read-only:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
Remove-Item Env:ADDRESSES_FILE -ErrorAction SilentlyContinue
node scripts\diag_parked_growth.js
```

Until that runs, treat "-496.1/day" as **an unexplained observation, not a trend**, and do
not let it into member comms or into any V8.50 justification.

One more thing the pair of readings says on its own: **the fund being unchanged to the
cent over two hours means there were essentially no new entries either** (the SF takes a
split of every entry fee). "Purely organic" may be measuring a very quiet chain. That is
worth knowing before anyone extrapolates a growth rate from it in either direction.

**Nothing else from session 2 is in flight.** No half-finished edit, no script waiting on
an answer, no chain state expecting a follow-up.

## STANDING LESSON FROM THIS SESSION

Three confident, plausible claims turned out wrong, and all three were caught the same
way — by rerunning or reading the source instead of reasoning from a convenient proxy.
A median ask 7x better than predicted (buffer money counted as member earnings). A control
that refused a verdict for an "impossible" condition that was actually normal. A
prediction that a test suite used mocks when it deploys the real library. **The pattern is
always substituting an easy observable for the question actually being asked, and the fix
is always the same: go and look.**

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

# 6c. DEFECT 6 — PARKED WORK IS STARVED IN DISCOVERY (found session 5, OPEN)

**`MatrixKeeperLib.discover` fills the batch in a fixed order and `_scanParked` runs
FIFTH**, after:

1. `WORK_VELOCITY` (at most 1)
2. `WORK_CHAIN_LINK` (one per pending link)
3. the frozen-MatB sweep -> `WORK_FORCE_ROTATE`
4. `_scanMatrix` -> `WORK_GHOST` / `WORK_RECLAIM`, **walked over every position of every
   matrix of every pair of every tier**
5. `_scanParked` -> `WORK_PARKED_RESCUE` / `WORK_EVICT_PARKED`   <- here

So **parked work is only reached when the WHOLE SYSTEM has fewer than
`maxItemsPerUpkeep` ghost/reclaim items pending.** `WORK_RECLAIM` has no rate limit;
`WORK_GHOST` at least has `lastGhostTime[matrix]`.

**This was observed live and then worked around, not diagnosed.** `scripts/set_max_items.js`
exists for exactly this: *"Currently: 14 Reclaim + 1 Velocity = 15, filling the cap and
leaving zero slots for WORK_PARKED_RESCUE (type 4)."* The operator's fix was to **raise**
the cap. `contracts/test/MatrixKeeperPrev.sol` orders it the same way, so this predates
the V8.48 item-12a extraction — it is not something V8.50 introduced.

**Why this is worse than it looks.** Starving reclaim leaves a dead seat sitting; nothing
expires. Starving a parked member runs their **eviction clock** — at `evictionGracePeriod`
(7 days) a member the fund would have RESCUED is EVICTED instead. Delay does not defer
that work, it **changes the answer**. Two other queues share the problem in milder form:
`WORK_ADVANCE_EPOCH` is dead last and has a **calendar** deadline (the 25th), and
`WORK_DISTRIBUTE_CW` sits beside it.

**It blocks defect 5.** Lowering `maxItemsPerUpkeep` 15 -> 5 on gas grounds tightens the
starvation condition from "fewer than 15 pending" to "fewer than 5 pending". **The cap and
the order land together or neither lands.** The cap is therefore HELD AT 15 with the full
gas case recorded in place at `MatrixKeeper.sol:maxItemsPerUpkeep`.

## The fix, and the one thing it costs

Reorder discovery by **deadline**, not by history:

    velocity -> chain links -> PARKED -> CW distribute/epoch -> force-rotate
             -> velocity gate -> ghost/reclaim

Ghost and reclaim go LAST because they are the only work in the system with no deadline
attached. Nothing is dropped; the tail of a full batch is deferred to the next upkeep,
which for housekeeping is free.

**The cost is `V8_48_KeeperScan.test.js`.** It proves the refactored keeper and the frozen
`MatrixKeeperPrev` return **byte-identical** `performData`, and a reorder makes that false
by construction. Its own header anticipates pins for deliberate behaviour changes — but a
reorder cannot be pinned back to the old value, because the order is not a parameter.

**It does not have to be retired.** When the batch is NOT truncated both keepers emit the
same SET of work items, only in a different order, so the harness survives as
**set-identity** with no loss: all four of its recorded mutation kills (`idleSlotTimeout`
<-> `extendedIdleTimeout`, emptied chain links, hardcoded `maxItems`, wrong community
wallet) change WHICH items appear, never merely their order. Only the one truncation test
genuinely diverges, and that test should be re-premised to assert the NEW priority
deliberately.

**Sizes are not a constraint here** (`MatrixKeeper` 3,347 headroom, `MatrixKeeperLib`
15,436, `V8Governance` 11,828). The tight contracts — `MatrixPairFactory` 132 and
`MatrixLogicLib` 302 — are not touched by this.

## MEASURED 2026-08-17 — AND IT IS NOT FIRING TODAY

`diag_keeper_discovery.js` against live V8.48, block time 13:49:18Z:

    maxItemsPerUpkeep 15   pendingChainLinks 0   configuredTierCount 10
    T1: pairs=2 parked=105 pastGrace=0
         p0A occ=127/127 rot=460 parked=36
         p0B occ=127/127 rot=300 parked=69
    T2..T10: parked=0
    checkUpkeep -> upkeepNeeded true, items 1 / 15:  VELOCITY x1

**Correct the record: ZERO reclaim items exist right now.** The batch is 1 of 15. The
"14 Reclaim + 1 Velocity" signature quoted from `set_max_items.js` is V8.30-era history,
not the state of this chain — an earlier draft of this section leaned on it as if it were
current, and it is not. Defect 6 is a **latent ordering hazard**, not an active outage.
That lowers its urgency and it does NOT lower its correctness: `WORK_RECLAIM` is unbounded
and scanned ahead of parked work, so the hazard is one idle cohort away at any time, and
lowering the cap to 5 brings that cohort five times closer.

## THE THING THAT DOES NOT ADD UP: 105 parked, pastGrace 0

`parkedGracePeriod` is 24h. Every one of 105 parked members would have to have parked
within the last day. Possible on a T1 pair at rot=460/300 — but **it is also exactly what
a swallowed read prints**. `diag_keeper_discovery.js` wraps both per-member reads:

    const mem = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
    const ts  = Number(await mx.parkedAt(mem).catch(() => 0n));

A member whose read reverts is still counted by `getParkedCount` and contributes 0 to the
age census. **This deployment is already on record returning `ARRAY_RANGE_ERROR` from
`getParkedMember` during active rescues** (section 8). So `parked=105 / pastGrace=0` has
two readings and the output cannot tell them apart — the same trap as the UTF-16
`Tee-Object` captures.

`scripts/diag_parked_ages.js` (new, read-only) settles it: it catches nothing silently,
names every failed read, prints the age histogram and the ten oldest with the numbers that
decide their verdict, and its closing verdict refuses to call the queue healthy unless
`aged == getParkedCount`. It also flags `parkedAt == 0 while queued` separately, which is
a state defect rather than a read failure — `_checkParked` reads that same slot, so the
keeper could not age such a member either.

### IT RAN — 2026-08-17 14:39Z, AND THE QUEUE IS CLEAN

    T1 p0A  queued=37  aged=37  readFailed=0  parkedAtZero=0  median 0.30d  oldest 0.85d
    T1 p0B  queued=69  aged=69  readFailed=0  parkedAtZero=0  median 0.60d  oldest 0.87d
    <1h 4   1-6h 14   6-24h 88   1-3d 0   3-7d 0   7-14d 0   14-30d 0   >30d 0
    getParkedCount 106 | aged 106 | read failures 0 | parkedAt==0 queued 0
    0 of 106 past the 24h grace.

**`pastGrace=0` was REAL.** All 106 aged with zero swallowed reads, so the earlier figure
was the queue being young, not the census failing. **Defect 6 is confirmed LATENT** — a
hazard, not an outage — and the reorder is cheap insurance rather than a fire drill.

Two things worth keeping from the reading:

- **The population is homogeneous, and it is a bigfill artefact, not an organic one.**
  Every one of the ten oldest holds exactly `$8.40` against a `$10.00` fee
  (`w=$3.40 res=$5.00`), `withdrawnRatio=0`. 88 of 106 sit in the 6-24h bucket, i.e. they
  parked before the chain went organic. Do not quote "35% of the parked queue" as an
  organic statistic.
- **`selfFundedGracePeriod` is 0.1h (6 min) live, `parkedGracePeriod` 24h.** These members
  hold $8.40 against a $10.00 crossing, so they are $1.60 short and wait the full 24h.
  Under item A a MatA parker's price is $5.00, their $8.40 covers it, `sfShare` is 0 and
  they take the **6-minute** window instead — 37 of these 106 (the p0A queue), which is
  the same effect `_triageParked` already records as "35 of 35 on the live chain, 76 of
  139 parked members across all tiers". Item A does nothing for the 69 MatB parkers; a
  MatB re-entry is still a full fee.
- **The whole 6-24h bucket crosses the grace within hours of each other.** 88 members
  become discoverable at nearly the same instant, against `maxItemsPerUpkeep` 15. That is
  the contention defect 6 is about, arriving on a timer.

### DONE — the reorder shipped

`MatrixKeeperLib.discover` now drains **bounded** sources first (velocity, chain links,
CW distribute+epoch, force-rotate, velocity gate), then runs the two **unbounded** scans
by deadline: **parked, then ghost/reclaim**. The rule is stated in full at the top of the
reordered block. No new storage, no new parameter, no bytes — the same code in a
different order.

`V8_48_KeeperScan.test.js` moved from byte-identity to **set-identity** (`canon` /
`expectSameSet`), its PARAM-59 sweep now matches flips **by member instead of by slot**
(index matching would have reported every item as flipped and started passing on noise),
and its truncation case was re-premised: the two keepers must still truncate to the same
SIZE, but which work survives is asserted against the NEW priority, not against Prev. A
new case, `DEFECT 6: parked work outranks ghost/reclaim`, squeezes the cap to 1 and
states the property on its own so it cannot quietly stop being tested.

**Still open — defect 5 (the cap).** Held at 15. The 2.6M-gas-per-rescued-item figure it
rests on predates items A and E1, and the reading above says item A turns a third of this
queue into `sfShare == 0` rescues with no SF round trip at all. **Measure post-item-A
rescue gas in a fixture before setting the cap** — that is a local test, no chain needed,
and it replaces a pessimistic estimate with a real number.

## DEFECT 7 — THE KeeperScan PINS NEVER COLLAPSED ANYTHING (found session 5, FIXED)

Surfaced by the V8.50 run, but it has been wrong since V8.48. `deployBoth()` pinned the
refactored keeper's `selfFundedGracePeriod` and `evictionGracePeriod` to **0** so the
frozen `MatrixKeeperPrev` — which has neither concept — stayed comparable. But
`_checkParked` gates on

    age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
    age < (isGhost      ? parkedGracePeriod     : evictionGracePeriod)

and Prev gates BOTH on `parkedGracePeriod`, **which the pins left at its 6h default.**
Setting the new keeper's two windows to 0 does not collapse the split — it opens it as
wide as it goes: V8.50 discovers a self-funded rescue and fires an eviction IMMEDIATELY
where Prev waits six hours. The missing line was `setParkedGracePeriod(0)` on BOTH keepers.

**Why the setters force zero.** `setSelfFundedGracePeriod` enumerates 0/60/300/900/1800/
3600; `setEvictionGracePeriod` enumerates 0/1d/2d/3d/4d/5d/7d. **They intersect at 0 and
nowhere else.** "Set each equal to `parkedGracePeriod`" — the collapse the file header
describes and `EC-4` asserts — is only REACHABLE with all three at zero. Any other value
is unsettable, so any test that claims to pin them at a nonzero window is not pinning
anything.

**The grace-period walk was doing exactly that.** It set
`setSelfFundedGracePeriod(g === 0 ? 0 : (g >= 3600 ? 3600 : 300))` under a comment
claiming the windows were "pinned together" — a one-hour self-funded window against a
thirty-day loan window — and never restored the value, so every later test in the shared
world inherited an un-collapsed split. Real, and worth fixing on its own.

**⚠ CORRECTION, AND IT MATTERS MORE THAN THE FINDING.** The first write-up of this section
blamed that expression for six of the eight failures. **That attribution was wrong.** The
next run — with the pins corrected — failed six times again, and the output made the real
cause unmissable: **both keepers were returning exactly 15 items, the cap**, one filled
with `PARKED_RESCUE` and the other with `RECLAIM`.

    new: VELOCITY, FORCE_ROTATE, PARKED_RESCUE x12, RECLAIM      (15 = cap)
    old: VELOCITY, FORCE_ROTATE, RECLAIM x13                     (15 = cap)

**The batch was TRUNCATING in the shared world, and neither keeper was wrong.** Defect 6
reordered discovery precisely so that a full batch keeps parked work and sheds
housekeeping; Prev is frozen doing the opposite. Once the cap bites, no content comparison
against Prev can mean anything — the difference IS the fix.

Twice in a row a mechanism was reasoned out and asserted before it was measured, and both
times the measurement said something else. The lesson is the one this project already
knows: an explanation that fits the numbers is not the same as the explanation, and
"3 items vs 2, batch not full" should have prompted a check of what the cap actually was
rather than a theory about grace windows.

### The fix: a FOURTH pin — the batch must not truncate

`deployBoth()` now raises `maxItemsPerUpkeep` from the 15 default to the enumerated
ceiling of **40**, so the shared world discovers everything and the two keepers emit the
same SET in a different sequence — which is what `expectSameSet` is for. This file asks
one question, "did the 12a extraction preserve which member gets which verdict", and batch
sizing was never that question. The two sizing cases set the cap deliberately and restore
it to 40 rather than 15.

⚠ The pin holds only while the fixture stays under 40 discoverable items. Measured union
today is roughly 30 (2 bounded + ~14 parked + ~14 reclaim, `MATRIX_SIZE` 7 across two
matrices). **If both keepers ever report exactly 40, suspect this pin before anything
else.**

Rewritten honestly: full equivalence at `g == 0` where it is reachable, and elsewhere the
real safety property — every item Prev queues, V8.50 must queue with the SAME verdict (a
shorter window can only bring work forward, never withhold it), and any extra item must be
one of the two PARKED verdicts, never a ghost, reclaim or chain link.

**It passed for two versions because the fixture never reached the state.** That is the
blind spot the comment directly above those pins warns about, reintroduced by the pins
written to prevent it. Worth stating plainly: the harness was green on luck, not on proof.

### The other two failures were the reorder, working

The idle sweep and the mutation probe park a dozen members against a cap of 15. With
parked work now ahead of ghost/reclaim it fills the batch and squeezes the sweep out —
measured new = 12x `PARKED_RESCUE` + 1x `GHOST`, old = 13x `GHOST`, both exactly 15. Both
keepers still truncate identically; what breaks is that the GHOST/RECLAIM classification
those tests exist to check becomes unobservable, which would have turned a MUTATION PROBE
into a test passing because it sees nothing. Both now raise the cap to 40. Truncation
priority is covered separately and deliberately.

### Still unexplained, and recorded rather than guessed

Why defect 7 surfaced on THIS run and not on the earlier three-file run. The reorder does
not change what is discovered in an untruncated batch, so the working assumption is that
the shared fixture's parked population differs between running KeeperScan alone and
running the full suite. **Not proven.** The fix stands on its own merits either way.

### `setMaxItemsPerUpkeep` is enumerated — 5/10/15/20/30/40

There is no cap of 1. The first draft of the new `DEFECT 6` test asked for one and
reverted with `MK: invalid max items`. Five is the floor, and five slots are not all
contested (velocity, chain links, CW, force-rotate and the velocity gate drain first), so
the property is stated as an implication instead: **if any housekeeping item is in a
capped batch, every parked decision must already be in it.** That is what starvation
violates, and it survives the enumeration changing.

---

## DEFECT 5 — CLOSED. maxItemsPerUpkeep 15 -> 5, MEASURED (2026-08-17)

`test/V8_50_KeeperGas.test.js` (new) builds a real world — no mocks — and costs a whole
`performUpkeep`, because the failure mode is a transaction running out of gas and gas is
consumed by transactions, not by items in isolation.

### Per item, MATRIX_SIZE 7

| item | median | max |
|---|---|---|
| SF-funded rescue | 1.49M | **1.76M** |
| self-funded rescue (item A) | 0.92M | 0.92M |
| eviction | 0.09M | 0.10M |
| ghost / reclaim | 0.04M | 0.04M |

**An SF-funded rescue costs 1.62x a self-funded one.** That is item A's gas dividend,
measured. An eviction is 18x cheaper than a rescue; a reclaim 44x.

### ⚠ THE BATCH TABLE IS A TRAP AND IT CAUGHT ME FIRST

GAS-1 costs the batch this fixture happens to produce, and it FLATTENS above cap 10 —
4.52M, 4.67M, 4.71M, 4.90M — with every cap "fitting" the 17.8M ceiling, up to 40. The
mix column says why: **this world only ever offers four `PARKED_RESCUE` items**, and every
slot above that fills with `RECLAIM` at 0.04M. The first draft of the test printed
"the largest cap under 17.80M is 40" as its conclusion. That would have been the same
class of error the whole exercise existed to correct — quoting a number whose population
had changed underneath it.

### THE VERDICT: a SATURATED batch, which defect 6 made ordinary

Discovery now takes parked work FIRST, so a deep parked queue yields a batch of rescues
and nothing else. That is no longer the pathological composition, it is the normal one
whenever the queue is deep — and a 25-member fixture cannot build it, so GAS-4 projects
it from the worst rescue actually measured.

    cap   projected   vs 17.8M   verdict
      5       8.82M       49%    fits
     10      17.64M       99%    fits, no margin whatsoever
     15      26.47M      148%    EXCEEDS
     20      35.29M      198%    EXCEEDS

**And that is the generous end.** MATRIX_SIZE here is 7; live tiers run 127, where the
V8.49 chain measured ~2.6M for the same item. At live size: **5 -> ~13M (73%) fits,
10 -> ~26M (146%) EXCEEDS.** Ten survives in the small world and fails in the real one,
which is precisely why the value is 5 and not the 10 the local table would permit.

**Set to 5 — for about an hour.** Then defect 8 replaced the control entirely and the cap
went to **20**. Both moves are correct and the sequence is the point: 5 was the right
answer to the wrong question.

### DEFECT 8 — THE GAS FLOOR (built same session, owner directive: nothing deferred)

**⛔ CORRECTION FIRST, BECAUSE THE DEFECT 5 REASONING ABOVE CONTAINED A FALSE PREMISE.**
An earlier draft of this document and of the `maxItemsPerUpkeep` docstring both said an
out-of-gas batch "reverts WHOLE". **IT DOES NOT.**

Every work item is dispatched as `try this._doXExternal()` — an external self-call. Under
EIP-150 a sub-call receives 63/64 of the remaining gas, so when the batch runs dry the
sub-call burns its 63/64, reverts on out-of-gas, and **the catch fires**. The loop then
continues with 1/64 of nothing and every remaining item fails the same way.

**So exhaustion presents as a CASCADE of `WorkItemFailed` events** — indistinguishable
from a floor refusal, an SF exhaustion, or an already-rescued member. The transaction
succeeds. The keeper looks like it ran. This is worse than a revert and it is the exact
shape that cost a day of misdiagnosis on 2026-07-30.

**The fix.** `MatrixKeeper.minGasPerItem` (default `3_500_000`, DAO param 63, menu
2.5M / 3.5M / 5M / 7.5M) is checked with `gasleft()` **before** dispatching each item;
below it the loop emits `BatchGasHalted(processed, total, gasRemaining)` and **breaks**.

- A break, not a revert: reverting would discard the items that ALREADY SUCCEEDED in this
  transaction, which is the opposite of what a gas guard is for. The skipped tail stays in
  the queue and `checkUpkeep` rediscovers it next tick.
- The floor MUST exceed the worst single item or it lets the batch enter work it cannot
  finish and the cascade returns one item later. 3.5M clears the ~2.6M a live-size rescue
  measured, with ~35% margin. `GAS-6` asserts this against the measured worst item AND
  separately against the known live figure the small world cannot see.
- Measured working: `GAS-5` hands a 20-item batch 12M against a 7.5M floor and it halts at
  **9 of 20 with 6.46M remaining**, with the tail still discoverable afterwards.

### AND THAT IS WHY THE CAP WENT UP, NOT DOWN

A count is the wrong unit. An eviction costs 1/18th of a rescue, a reclaim 1/44th, so any
count sized for the worst mix throws away nearly all the throughput on the common one —
GAS-1 measured a 28-item batch at 4.90M, a quarter of the ceiling, where a cap of 5 would
have run six items and stopped. With the floor doing the safety work, `maxItemsPerUpkeep`
is **20**: a batch of evictions runs all 20 for ~2M, a batch of rescues still stops after
four or five, and nothing has to predict in advance which it is.

Not 40: `performData` is calldata on the way back in, and `_scanMatrix` walks every
position of every matrix before the cap binds. 20 is the largest DAO menu value that keeps
both modest.

**Sizes after defect 8:** MatrixKeeper 21,590 (+381, 2,986 spare), V8Governance 12,824
(+76, 11,752 spare). The tight pair is untouched — MatrixPairFactory 24,498 (78),
MatrixLogicLib 24,274 (302).

---

## SUITE GREEN — 602 passing / 7 pending / 0 failing (2026-08-17, after defect 8)

After `npx hardhat compile --force`. That is the first CONFIRMED green run of V8.50; the
earlier "595/0" in this document was a projection that was never executed, and it should
not have been written as a result.

The road there, because the failures were more instructive than the pass:

| run | failing | cause |
|---|---|---|
| 1 | 8 | 6 x un-collapsed split grace (defect 7) + 2 x idle-sweep truncation |
| 2 | 1 | the new DEFECT 6 test asked for `maxItemsPerUpkeep(1)`; the setter enumerates 5/10/15/20/30/40 |
| 3 | 6 | **the real cause** — the shared batch truncating at 15, misattributed in run 1 |
| 4 | 0 | fourth pin: `maxItemsPerUpkeep` 40 in `deployBoth()`, no truncation |

**Five tracked files are CRLF-only churn and must stay OUT of any commit** — verified with
`git diff --ignore-all-space --ignore-blank-lines`, which comes back empty for each:
`scripts/deployed_addresses_v8_30/31/40.json`, `contracts/test/CryptoNovaCommunityWallet.sol`,
`archive/windows_keeper/corescue.bat`. The address files matter especially: a 148-line
diff on a `deployed_addresses_*.json` looks exactly like a repoint, and here it is nothing
at all. Check them the same way before every commit rather than trusting the line count.

---

**Owner decision, still open:** whether parked work may take the WHOLE batch when the
queue is long, or whether housekeeping keeps a reserved slot or two. **The reorder as
shipped lets parked take the whole batch** — defensible because parked work drains (a
rescue or an eviction removes the item) while housekeeping has no deadline to miss, but
it is a policy choice and it is reversible with a reserved-slots param if the owner wants
one.

---

# 6f. ⛔ THE SECOND ORGANIC READING — THE LOOP IS REAL AND THE FUND IS UNDERWATER

`node scripts/diag_parked_growth.js`, 2026-08-18, blocks 45,060,000..45,645,471
(2026-08-05 -> 2026-08-18, ~13.6 days). Read-only. This is the second organic reading the
handoff has been asking for since 2026-08-16, and it is the most consequential measurement
of the V8.50 work.

## 1. THE LOOP SIGNATURE — MEASURED, NOT INFERRED

    758 park events across 339 unique members
    1x: 59      2x: 167      3-5x: 113      6-10x: 0      11+: 0
    REPEAT SHARE: 48.2% of all park events come from members who parked 3+ times

**ONLY 59 OF 339 MEMBERS PARKED ONCE AND STAYED OUT. 82.6% CAME BACK.**

That is the rescue -> SF debt -> re-seat -> cycle out underfunded -> park again cycle,
observed directly. **A later run the same night, after the exit-counting fix, read 773 park
events across the same 339 members — 1x:57, 2x:161, 3-5x:120, 6-10x:1 — a repeat share of
51.0% and 83.2% of members returning at least once.** The direction is stable across runs.

⚠ **THE RATE CLASSIFICATION IS A COIN FLIP AND MUST NOT BE QUOTED AS A VERDICT.** The
script calls the loop real when an ACCELERATING rate joins the other two criteria. It
printed ROUGHLY LINEAR on one run (149.7/day) and ACCELERATING on the next (154.7/day) —
but its threshold is `lastThree > firstHalf * 1.5`, i.e. **154.5**, so the second run
crossed by **0.2 parks/day**. At that precision the label is noise, not a finding. What is
solid: the park rate is rising roughly 50% and sitting exactly on an arbitrary threshold.
**Do not report "all three criteria met".** The repeat share and the climbing SF
outstanding carry the loop conclusion on their own; the rate neither adds to it nor
subtracts from it at this precision.

## 2. THE FINANCING — THE FUND HAS LENT 2.4x WHAT IT HOLDS

    CONTRACT counters (ground truth)   loaned $961.65   repaid $443.41   OUTSTANDING $518.24
    SF totalBalance, same night                                          $212.35

    net-outstanding-delta by day:  08-13 +$0.33   08-14 +$34.58   08-15 +$96.66
                                   08-16 -$44.04  08-17 +$258.17  08-18 +$167.35

**Outstanding debt is 2.4x the remaining balance, and the last two days added $425.52 of
net new debt.** Independently corroborated: `model_item_a.js` PHASE 1 read SF totalBalance
four times across ~9.7 hours tonight — $262.79 -> $259.49 -> $243.19 -> $212.35, monotonic,
about -$5.20/hour or ~-$125/day. Two different instruments reading different events agree
on the direction and roughly on the rate.

⚠ TESTNET, BIGFILL STOPPED. Do not extrapolate a runway figure to mainnet demand. The
DIRECTION is the finding, not the date it reaches zero.

## 3. WHAT THIS DOES TO V8.50's FRAMING

**Item A stops being a throughput improvement and becomes the fix.** Every sample tonight
put the MatA crossing at **62-65% of ALL funding parks, ~$724 of lending**, and PHASE 2
confirmed 67-75 of 67-75 MatA parkers are freed OUTRIGHT — the reserve covers the halved
crossing price with no fund involvement at all. E1 handles the other half by carrying the
member's balance so the MatB re-entry is affordable. Together they attack both legs of the
loop the section above measures.

The live crossing buffer reads **3600 bps** and V8.50 ships `crossingBufferBps` at **0**.
Every rescue today seeds 36% of the fee into the member's withdrawable as FUND money. That
was recorded as a tuning decision; against a fund that has lent 2.4x its balance it is
better read as part of the same repair.

## 4. ⛔ TWO THINGS IN THIS OUTPUT THAT DO NOT ADD UP — OPEN, NOT EXPLAINED

**(a) ✅ RESOLVED SAME SESSION — A SNAPSHOT RACE, AND MY HYPOTHESIS WAS WRONG.**

The script printed `VERDICT INPUTS (no holes — complete)` and, four lines earlier,
`EVENTS DO NOT RECONCILE`:

    events   loaned $956.46   repaid $443.41
    counters loaned $961.65   repaid $443.41      gap: $5.19 on the LOANED side only

**I proposed a lending path that emits no event. Reading the source killed it:**
`StabilityFund` has exactly ONE writer of `memberDebt[member] +=` (:941) and exactly ONE
of `totalRescueLoaned +=` (:942), in the same function, emitting at :945 with the SAME
`amount`. No silent path exists, and none ever did.

**`scripts/diag_sf_debt_reconcile.js` (new) found the real cause.** Scanning the same fund
from block 0: **EXACT on both sides — $966.84 / $966.84 and $443.41 / $443.41.** And its
counter read $966.84 against the growth script's $961.65 — **the counter had moved by
exactly the missing $5.19.**

`diag_parked_growth.js` scans ~585k blocks across 22 matrices (minutes of wall clock) and
then read the counters at the CURRENT head while its events stopped at `tip`. On a live
chain the counters are ahead by whatever was lent during the scan. At the ~$211/day rate
that script itself measures, $5.19 is about 35 minutes — the length of the scan.

**FIXED:** the counter read is now pinned with `{ blockTag: tip }`, so both sides describe
the same instant, and the misleading "some ranges dropped" text is gone. If they ever
disagree again, the message says outright that scan timing does NOT explain it.

**⚠ THE LESSON, WHICH IS THE SAME ONE AS THE TRUNCATED BATCH AND THE SWALLOWED CENSUS:**
the instrument's own two statements contradicted each other — "no holes" and "does not
reconcile" — and that contradiction, not the numbers, was the finding. The wrong
explanation was reached first, twice, by reasoning instead of measuring. **The event-derived
debt totals were never wrong.** Nothing quoted from them needs revising.

**(b) ✅ RESOLVED SAME SESSION — THE SCRIPT COULD NOT SEE THE KEEPER'S OWN RESCUES.**

Cumulative-net read 212 against a live queue of 105. `MatrixLogicLib` has **ELEVEN** call
sites of `_removeFromParkedQueue`; the `net` column knew about **three**:

| exit | was it counted? |
|---|---|
| `CoPayRescue` (:1663), `SelfRescue` (:1754), `MemberEvicted` | yes |
| **`forceCrossKeeper` (:1601) — the keeper's automated rescue** | **NO** |
| `GhostDequeued` (:1825 / :1855 / :1863) | NO |
| `enterMatrix` re-entry (:400), `forceCross` (:1536), `exitSeat` (:1803), `deductForUpgrade` (:1913) | **emit nothing at all** |

**The keeper's rescue was missed for a specific and memorable reason: its event
`ParkedRescued` is emitted by `MatrixKeeper`, not by the matrix**, and the script only ever
read matrix events. That one omission is most of the gap.

**FIXED and re-measured: cumulative-net 108 against a live queue of 106.** The `keeper`
column carries 110 previously invisible exits. The residual 2 is the four silent paths,
which no event scan can ever subtract — `net` is now labelled an UPPER BOUND and
`getParkedCount` is the only exact figure. (`RescueLoanIssued` is not a usable substitute:
it is guarded on `totalLoan > 0`, so a self-funded rescue emits nothing there.
`ParkedRescued` always fires — checked, because V8.50 makes self-funded rescues the common
case and it would otherwise have been a real observability regression.)

**⚠ THE HEADLINE FINDINGS WERE NEVER AFFECTED.** The repeat share is computed from park
events alone and the financing verdict rests on the contract counters. Only the `net` and
`cumulative-net` columns were wrong, and they overstated growth.

Neither of these changes the two headline findings — the repeat share comes from park
events alone, and the financing verdict rests on the CONTRACT COUNTERS, not the events.
But both need closing before this document's numbers are quoted as exact.

---

# 6e. THREE SAMPLES IN ONE NIGHT — THE VERDICTS HOLD, THE FIGURES DO NOT

`model_item_a.js` was run three times on 2026-08-18 as phases were added. The chain was
live throughout, so each run is an INDEPENDENT SAMPLE of a moving population. That was not
the intent, and it turned out to be the most useful thing about it.

## ⛔ THE UNDERLYING FIGURES ARE VOLATILE. DO NOT QUOTE A POINT VALUE AS "THE" NUMBER.

`WHAT ONE COMPLETED JOURNEY EARNS`, the same quantity, measured three ways:

| when | n | min | median | max |
|---|---|---|---|---|
| 2026-08-16 | 63 | $3.40 | **$4.83** | $6.34 |
| 2026-08-18 block 45630741 | 33 | $3.40 | **$3.40** | $10.90 |
| 2026-08-18 block 45642648 | 38 | $3.40 | **$6.55** | $10.15 |

**The median nearly doubled in under seven hours** (~12,000 blocks). Other figures moved
with it — the re-entry ask went from a $2.85 median to $0.00, and the top ladder band from
8 members to 20. **Item C's case for raising the floor rested on the $4.83 median.** That
number is not reproducible; it is one draw from a distribution that also produces $3.40
and $6.55. Any future argument built on a single run's median is built on sand.

The MINIMUM is the stable figure: **$3.40 in all three samples**, exactly the structural
no-referral floor (250 direct + 1800 pool + 1350 chain). That is the number to reason with.

## ✅ AND THE VERDICTS SURVIVED ALL THREE, WHICH IS WHY THEY CAN BE TRUSTED

Every conclusion recorded tonight was reached on one sample and then, by accident, re-run
on two more:

| verdict | run 1 | run 2 | run 3 |
|---|---|---|---|
| PARAM 59 at 3400 refuses | 1 of 40 | 1 of 33 | 1 of 38 |
| PARAM 59 at 5000 refuses | 1 (same) | 1 (same) | 1 (same) |
| members below the 4000 rung | 0 | 0 | 0 |
| presets 2/3 rescue additionally | 0 | 0 | 0 |
| can afford T2 at cycle-out, item A | 0 of 39 | 0 of 33 | 0 of 38 |
| shallow seats | — | 0 of 1534 | 0 of 1412 |
| SlotReclaimed | — | 0 | 0 |

**Nothing moved.** The decisions are robust to a population that churned substantially
underneath them, which is a much stronger claim than any of them had when it was made.

## THE 5 -> 6 CO-MOVEMENT: the MemberEntered identification just got firmer

PHASE 9's position-0 count and PHASE 4's "deferral parks (shortfall 0)" were both **5** in
run 2 and both **6** in run 3. Two independently computed counts moving together across
samples is far better evidence that they are the same events than a single coincidence
was — the earlier note calling the cross-check "suggestive rather than conclusive" was
right to hedge, and the hedge has now been partly discharged. Still not proof: both park
paths emit `MemberParked(member, 0)` and only `:534` also emits `MemberEntered`.

## WHAT THIS MEANS FOR THE NEXT SESSION

**Run the model more than once before deciding anything.** A single run is a sample, not a
measurement, and this chain moves fast enough that the difference matters. Where a verdict
is a COUNT AT A THRESHOLD it appears stable; where it is a MEDIAN it is not.

---

# 6d. THE TWO OWNER DECISIONS — BOTH SETTLED 2026-08-18, BOTH "NO CHANGE"

Settled against `scripts/model_item_a.js` PHASE 7 (added for this), read on the live
V8.48 chain, 40 MatB parkers, post-E1 basis.

## PARAM 59 `insolvencyFloorBps` — STAYS AT 3400

    1700 -> refuses 35 of 40      3400 -> refuses  1   <- live default
    2500 -> refuses 32            5000 -> refuses  1   <- the proposal. SAME MEMBER.
                                  6800 -> refuses  0

**Raising 3400 -> 5000 refuses the identical member.** The change that opened this item
buys nothing measurable. Only 6800 moves the outcome, and that one member is one of the
two carrying existing debt — the exact case the floor exists to refuse. Nearly doubling
the ceiling to reach them inverts the mechanism.

**⚠ PHASE 5 AND PHASE 7 DISAGREE HERE AND PHASE 7 IS THE ONE TO QUOTE.** Phase 5's sweep
reports 3400 clearing 40 of 40; phase 7 reports one refusal. Different models: phase 5
compares the raw ask to the ceiling, phase 7 does what policy B does — trims the advance
to `min(sfShare, shortfall)` and adds EXISTING debt. Phase 5 is the optimistic bound.

## SF rescue ladder bottom rung — STAYS AT PRESET 1 (4000)

    10000+  6 | 8000-8500  3 | 7000-7500 24 | 6500-7000  7 | BELOW 4000  0

Nobody is off the bottom. Preset 2 would additionally rescue 0; preset 3, also 0.

**The ~3400 worry was a PRE-E1 artefact.** It only exists on the ledger basis, where
item A strands journey-A earnings in a MatA ledger the re-entry gate cannot read. E1
carries them across, so the whole population sits at 6500 bps and up. **E1 did not just
close the conservation hole — it removed the reason to touch the ladder.**

## What this run also established, independent of the decisions

- **Item A's premise holds on chain, exactly: 67 of 67 MatA parkers freed outright.**
  $103.35 of real shortfall becomes $0.00.
- **Item A removes 64.7% of all funding parks** — 458 of 708 — and $727.03 of lending.
- **Phase 3 reconciles on all 171 self-funded crossings**, with the 50/50
  reserve/withdrawable split falling out structurally rather than by coincidence.
- **The live crossing buffer is 3600 bps; V8.50 ships `crossingBufferBps` at 0.** Already
  a recorded decision with the knob documented at the declaration, but it means rescued
  members stop being seeded 36% of the fee as SF money. Watch it wherever V8.50 first runs.
- **MatB parkers carrying debt: 2 of 40**, and `_crossToPartner` claws back HARDER under
  item A, not softer — the member arrives holding more.

## ⚠ BOTH DECISIONS REST ON A PROJECTION, NOT A RUNNING SYSTEM

E1 is not deployed. The live chain is V8.48, so PHASE 7 projects V8.50 onto today's
members. Neither decision should be treated as settled for a running system until V8.50
runs somewhere and the model is re-read there. Both were "no change", so nothing is at
risk from the projection being wrong — but a FUTURE change to either must not cite this
table as if it were a measurement of V8.50 in operation.

## Also open, and it bit this session

`model_item_a.js` treats an RPC **503** as "constant unreadable" and aborts. Refusing to
assume `CROSSING_RESERVE_BPS` is correct — guessing it would corrupt every number
downstream — but a busy endpoint and a missing selector are different failures sharing
one code path. It needs a retry wrapper that distinguishes transport errors (503, 429,
timeouts, resets) from genuine call failures, and only declares a value unreadable after
several attempts. Same discipline as `diag_parked_ages.js`. **Do not "fix" it by changing
the endpoint** — public endpoints were tried in this site's read pool and removed.

---

# 6g. ⚠ FOUR COMMIT MESSAGES HAVE MANGLED DOLLAR FIGURES — THE HANDOFF IS THE RECORD

`git log` bodies for **`fe3f594`, `da622c1`, `56140d3`, `2011eed`** contain 16 destroyed
figures: `$956.46` reads as `\.46`, `$5.19` as `\.19`, and so on.

**CAUSE:** the messages were passed as `git commit -m "...\$956.46..."` from PowerShell.
`\` is NOT PowerShell's escape character — a backtick is. So `\$956` became a literal
backslash plus the EMPTY variable `$956`, and every dollar amount lost its digits. The
three clean commits of that session are clean only because they contained no `$` figures.

**NOT REWRITTEN, DELIBERATELY.** Every one of those figures is correct and intact in this
document, which is the authoritative record; the commit bodies are secondary. Force-pushing
four commits to fix presentation would trade a real risk for a cosmetic gain.

**THE FIX FOR NEXT TIME — WRITE THE MESSAGE TO A FILE:**

    # Claude writes .git/COMMIT_DRAFT.txt, then:
    git commit -F .git/COMMIT_DRAFT.txt

`-F` reads the file verbatim. No interpolation, no escaping, no quoting rules, and it
handles the em-dashes and unicode this project's messages are full of. **Use it for any
commit message longer than one line.** `.git/` is not tracked, so the draft never becomes
a stray repo file.

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

⛔ **AND STOP WRITING "WHOEVER PICKS THIS UP".** Owner correction, 2026-08-18. There is no
third party and there never has been. Every line here was written by a previous session of
Claude and executed by the owner. "Whoever picks this up" is **future-Claude reading its
own notes** — vague attribution invites vague standards, and a note addressed to nobody in
particular gets written to nobody's standard. Address it to yourself.

# ⛔ 7a. THE TWO RULES — OWNER-SET 2026-08-18, AFTER A SESSION THAT EARNED THEM

## RULE 1 — DO NOT HYPOTHESISE UNLESS NECESSARY.
## RULE 2 — MEASURE AND TEST BEFORE IMPLEMENTING. NEVER BUILD ON A HYPOTHESIS.

These are not general advice. They were set because of a specific, repeated failure in the
2026-08-18 session, and the evidence is worth keeping so the rules do not decay into slogans.

**EVERY WRONG ANSWER THAT SESSION CAME FROM REASONING AHEAD OF MEASURING:**

| the hypothesis, asserted confidently | what measurement said |
|---|---|
| "A lending path emits no event — find the silent path" | ONE writer, ONE emitter, same function. It was a **snapshot race**: counters read at the head after a multi-minute scan. |
| "Six KeeperScan failures are an un-collapsed split grace" | The **batch was truncating at 15**. Both keepers full, keeping different work by design. |
| "0.32% of entries are shallow seats — item D is real" | Position 0 **is not a seat**. Those were parks. Zero reclaims had fired, which made it impossible on its face. |
| "Item A accelerates tier progression; recalibrate the gates" | Measured on **V8Elevator's fixture ladder**. Live T2 is $25.00 and NOBODY upgrades at cycle-out in either world. |
| "The suite is at 595 passing / 0 failing" | Never executed. It was a **projection written as a result**. |

**AND EVERY CORRECT ANSWER CAME FROM BUILDING AN INSTRUMENT FIRST:**
`V8_50_KeeperGas.test.js` (the cap, measured not estimated) · `diag_parked_ages.js` (the
census with nothing swallowed) · `diag_sf_debt_reconcile.js` (the $5.19) · PHASE 7/8/9 of
`model_item_a.js` (both owner decisions, the tier gates, item D).

## HOW TO OBEY THEM IN PRACTICE

1. **When two numbers disagree, THE DISAGREEMENT IS THE FINDING.** Do not explain it —
   measure it. `no holes` beside `EVENTS DO NOT RECONCILE`; five shallow seats beside zero
   reclaims; a batch fitting the ceiling at every cap. Each contradiction was the whole
   answer and each was nearly explained away first.
2. **A number you have not run is not a result.** Never write a measurement in the past
   tense until it has executed. If it is a projection, label it a projection in the same
   sentence.
3. **Build the instrument before the fix.** It is cheaper than a wrong fix and it is the
   only thing that tells you the fix worked. Three V8.50 scope items closed with NO code
   change once measured.
4. **State the basis with every figure.** Which ledger, which deployment, which block,
   which matrix size. The 3400/5000 reversal happened because a floor was calibrated
   against a total the enforcing code could not see.
5. **One sample is not a measurement.** A count at a threshold held across three runs; a
   median nearly doubled in seven hours. Run it again before deciding.
6. **When a hypothesis IS necessary — and sometimes it is — say so out loud, mark it
   UNVERIFIED, and put measuring it at the top of the list.** Rule 1 says "unless
   necessary", not "never". What is forbidden is letting an unmarked guess become the
   basis for code.

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
- ~~**The live V8.48 chain has been organic since 03:30:44 -04:00 and has never been
  measured that way.** Take a reading before anything restarts bigfill.~~ **DONE
  2026-08-18 — see section 6f.** The reading found the self-sustaining loop (82.6% of
  parked members park more than once) and a fund that has lent 2.4x what it holds
  ($518.24 outstanding against a $212.35 balance). It also opened two unexplained
  discrepancies, both listed in 6f: a $5.19 loaned-side gap that looks like a lending path
  emitting no event, and cumulative-net 212 against a live queue of 105.
- ~~**A LENDING PATH MAY NOT EMIT `MemberDebtIncreased`.**~~ **RESOLVED 2026-08-18 — IT
  WAS A SNAPSHOT RACE, NOT A SILENT PATH.** `StabilityFund` has one writer of `memberDebt`
  and one of `totalRescueLoaned`, same function, emitting the same amount.
  `diag_sf_debt_reconcile.js` reconciles EXACTLY from block 0. `diag_parked_growth.js` was
  reading the counters at the head after a multi-minute scan whose events stopped at
  `tip`; the gap was ~35 minutes of lending. Counter read is now pinned to `tip`.
  **Event-derived debt totals were never wrong — nothing quoted from them needs revising.**
- **⚠ `diag_parked_growth.js` DEFAULTS TO `deployed_addresses_v8_47.json`** and reads the
  live V8.48 chain only because `.env` line 69 sets `ADDRESSES_FILE`. Every V8.47 address
  differs — StabilityFund, pair managers, matrices. **Run it with that variable unset and
  it silently measures a dead deployment while printing confident numbers.**
  `diag_sf_debt_reconcile.js` refuses to start without it, rather than guessing.
- **The SF is draining and two instruments agree.** `diag_parked_growth.js` daily deltas
  and four `model_item_a.js` PHASE 1 balance reads both say the fund is losing ground —
  roughly $125/day, monotonic across ~9.7 hours. Testnet with bigfill stopped, so the
  DIRECTION is the finding and not any runway date.
