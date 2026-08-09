# V8.48 — LOCKED SCOPE (owner decision 2026-08-09: NOTHING DEFERS)

Policy, owner's words: *"I want everything we find placed in the scope for v8.48
and not defer to later versions, we keep pushing back deploy bcuz we defer, cost
is building."* Every finding below ships in V8.48. This file is the execution
list; `V8_48_BACKLOG.md` holds the evidence for each.

## Contract changes

| # | change | contract | source |
|---|---|---|---|
| 1 | `freeWithdrawable()` becomes a line-for-line mirror of `withdrawCore` (V8.32 opt-out + debt). Add `netClaimableOf(member)`. | FigureEightMatrixV8 / MatrixLogicLib | §1 |
| 2 | `reservedHeldFor(member)` getter **or** bind reserve across all tiers — DECISION NEEDED | TierRouter(Lib) | §2 |
| 3 | `bulkWithdraw(uint256 amount)` — one-signature partial withdrawals | TierRouterLib | §3 |
| 4 | Mint cap: `amount <= deposit / floorPrice()` in `mintReward` | CNOVAToken | §4 |
| 5 | `require(floorPrice() >= floorBefore)` in `addDexLiquidity` + `emergencyWithdraw` | CNOVATreasury | §4 |
| 6 | `_floorPriceE6()` must read `usdcReserve`, not `balanceOf(treasury)` | CNOVADirectSale | §4 |
| 7 | Real cross-pair `memberJoinedAt` so `earlyExitPenaltyBps` can work | PairManagerV8 | §7 |
| 8 | `lockedBalanceOf` returns `min(sum(batches), balanceOf(wallet))` | CNOVAToken | §8 |
| 9 | Prune/reduce vest batches on BURN inside `_update` | CNOVAToken | §8 |
| 10 | `rescueReentry` returns own MatA — mirror `TierRouterLib.sameTierTarget` incl. the V8.46-C collision guard | PairManagerV8 | §10 |
| 10b | **`_findExternalPair` cumulative-counter exclusion — THIRD site of the V8.46 root cause, never fixed.** `pairs[i].totalRegistered < routeEntryThreshold` with a counter that only ever increments (:426). A pair that passes the threshold is excluded from new registrations FOREVER — its MatA stops receiving entries and freezes. Masked since 2026-07-27 by `route_rr.js`. Fix: `routingIdx = totalRegistrations % pairs.length` — round-robin. Equal share regardless of history, no monotonic trap, O(1) (deletes the loop), and exactly what `route_rr.js` imposes externally. Feeding a full MatA is safe: V8.41 root rotation frees the seat (regression S3). **NOT argmin** — cumulative totals across pairs born at different times are not comparable; live `[3483,595,8]` would send 587 consecutive entries to T1.3 and starve the other two. | PairManagerV8 :578-584 | NEW, verified 2026-08-09 — **live incident, see below** |
| 11 | **selfRescue / coPayRescue surplus loss** — `crossingReserve` and `withdrawable` are zeroed UNCONDITIONALLY while `_finalizeCrossing` forwards only `entryFee`. Surplus is erased. Must credit the excess back to `withdrawable`. | MatrixLogicLib :1265-66 | NEW, verified 2026-08-09 |
| 12 | `checkUpkeep` must DISCOVER WORK_PARKED_RESCUE, WORK_EVICT_PARKED (and GHOST/RECLAIM). Executable today but undiscoverable — retires 3 keepers. | MatrixKeeper | AUTOMATION_AUDIT.md |
| 24 | **Keeper policy != contract policy on frozen MatB.** `_isFrozenMatB` (MatrixKeeper:633) requires full AND (never rotated OR `frozenMatBTimeout` = **6 hours** stale). `frozen_matb_keeper.js` rotates the moment a MatB reads full (`occ=127/127 nextSlot=128`), i.e. within 10 minutes. The protocol has been running on the KEEPER's policy for 6,726 rotations, which is why the contract's own failure gate ("if this ever fires regularly, the routing design has failed", :453) never tripped — on-chain it almost never fires. Decide the real policy and make ONE layer own it. | MatrixKeeper | NEW, verified 2026-08-09 |
| 25 | ~~`adminForceRotateRoot` reverts at scale~~ **WITHDRAWN 2026-08-09 — NOT a live defect.** The "29%" was a LIFETIME ratio I presented as a current rate. Per-day distribution: 152 on 07-18, 90 on 07-19, **2,583 on 07-24 (91% of all of them, a single day)**, 2 on 08-02, and **nothing since**. 07-24 is the V8.44 go-live and 07-18/19 is the `occ=127/127 rot=0` signature the contract comments name — i.e. these are the incidents V8.44/V8.46 were built to fix, already fixed. The two most recent `ERROR` lines (08-03, 08-04) are QuickNode `50/second request limit reached`, not reverts. `frozen_matb_keeper.js` already guards with `staticCall` (:152) and `estimateGas` (:172). **Keep that guard when item 24 moves the trigger on-chain** — `checkUpkeep` has no equivalent, and that is the real carry-over. | — | withdrawn after verification |
| 12a | **Extract `MatrixKeeperLib`** (same pattern as TierRouterLib / MatrixLogicLib). MatrixKeeper has 535 free bytes — item 12 does not fit. This is a prerequisite task, NOT a deferral of 12. | MatrixKeeper | size baseline below |

## Deploy / script changes

| # | change | file |
|---|---|---|
| 13 | Call `setTier1Matrix` / `setMemberTracker` — never called, so `earlyExitPenaltyBps` returns 0 and `setFreeMode` (Universe Mode) reverts | scripts/deploy_v8.js | §7 |
| 14 | Assert every wiring setter was called; fail the gate if not | scripts/predeploy_check.js | §7 |
| 15 | Re-verify every ERC20 approval amount against what the release CHARGES | frontend + scripts/ + /root/keeper/ | §9 |

## Post-deploy actions

| # | action |
|---|---|
| 16 | Revert the live mitigation: `setEntryThresholds(375, 400)` once #10 ships |
| 17 | DELETE `route_rr.js` — **gated on 10b, NOT on 10.** It masks `_findExternalPair`, not `rescueReentry`. Deleting it after a 10-only fix re-freezes MatA in every mature pair — the 26 Jul state (T1.1=2129, T1.2=890, T1.3=101 vs threshold 381, two dead pairs). |
| 18 | **REVERSED 2026-08-09 — DO NOT RETIRE `frozen_matb_keeper.js`.** The log check was run and the earlier "redundant" call was based on MY bad grep (searched lowercase `rotated`/`forced`; the log writes `Rotated`/`forcing`, so 2 matches meant my pattern missed, not that the keeper was idle). Actual: **6,751 successful rotations, total_rotations=6726, runs=38445**, still rotating T1.1/T2.1/T3.1 every 10 minutes. Retiring it would freeze every MatB in the protocol. Replaced by item 24. |
| 19 | Retire `copay_rescue` / `fastlane_rescue` / `evict_parked` once #12 lands |
| 20 | Run the protocol's own gate: **keepers OFF -> rotationCount must still climb** (MatrixKeeper.sol:455) |

## Frontend (ships with, not after)

| # | change |
|---|---|
| 21 | Disable "Unlock early" / "Max Unlock" when `balanceOf < penaltyAmt` — currently offers an action that always reverts (§8) |
| 22 | Remove the interim self-rescue surplus warning once #11 ships |
| 23 | Restore the exit-penalty ladder copy once #7 makes it real |

## 10b IS NOT THEORETICAL — IT ALREADY FIRED

Timeline, established 2026-08-09 from the VPS crontab and `route_rr.js` state:

| when | what |
|---|---|
| 2026-07-27 | `route_rr.js` written to work around `_findExternalPair`. Live T1 was `[2129, 890, 101]` against threshold 381 — two pairs already dead. |
| 2026-08-06 | cron line commented out (`# TRIM-2026-08-06`). The mask is removed. Nothing else changes. |
| 2026-08-08/09 | **254 members frozen in T1.1 MatA.** Owner reports pair-A not rotating; member ticket (Sherwyn) says the same. |
| 2026-08-09 | Mitigated with `setEntryThresholds(_, 1000000)` — every pair under threshold, so pair 0 always wins. T1.1 MatA 316 -> 333 rotations, 254 members released. |

Three days between removing the workaround and the freeze. The mitigation treated
the symptom; `_findExternalPair` is the cause and was not identified until the
keeper source was read on 2026-08-09.

**The mitigation is not a resting state.** At `route=1000000` pair 0 takes every
new registration, so T1.2 and T1.3 MatA are now starved — live entry counts
`[3483, 595, 8]`. It traded a T1.1 freeze for a T1.2/T1.3 freeze. This is why
10b ships in V8.48 rather than living on as a threshold value.

**Current holding configuration (must not drift before V8.48):**
- `routeEntryThreshold = 1000000` (the mitigation)
- `route_rr.js` cron trimmed 2026-08-06 AND kill switch `route_rr.OFF` set 2026-08-09
- Item 16 reverts the threshold; item 17 deletes the script — both AFTER 10b ships

## TOPOLOGY RE-VERIFIED FROM SOURCE 2026-08-09 (third pass)

Earlier in this work I diagnosed the pair topology wrong twice before landing on
`rescueReentry`. Re-read end to end rather than trusted from memory:

| path | code | threshold read? | status |
|---|---|---|---|
| cycle-out re-entry | `handleCycleOut` -> `_sameTierTarget` -> `TierRouterLib.sameTierTarget` | **no** | **CORRECT.** Own MatA unconditionally; `toMatB` only when the member already occupies own MatA. V8.46 DELETED `pairExpansionThreshold` and its setter. |
| rescue re-seat | `PairManagerV8.rescueReentry` :286 | **yes** — `routeEntryThreshold` | **BROKEN — item 10** |
| new registration | `PairManagerV8._findExternalPair` :578 | **yes** — `routeEntryThreshold` | **BROKEN — item 10b** |

Two survivors of the V8.46 root cause, not three. Nothing else reads a cumulative
counter to make a routing decision.

**Item 10 is ALREADY RUNNING LIVE, unintentionally.** `rescueReentry` compares
`totalRegistered >= routeEntryThreshold`, and the mitigation set that threshold to
1,000,000. No pair has a million cumulative entries, so the comparison is false
everywhere and **every rescued member is being re-seated into own MatA right now** —
exactly the behaviour item 10 makes permanent.

Evidence collected 2026-08-09 while running that way:

| metric | value |
|---|---|
| T1.1 MatA rotations | 316 -> 333 -> **374**, still climbing |
| T1.1 MatB occupancy | 126/127 — did NOT starve |
| T1.2 MatB occupancy | 127/127 — did NOT starve |
| frozen members released | 254 |

The one real risk in item 10 was starving MatB of its rescue feed. That risk is now
measured rather than argued: MatB stayed full while MatA resumed rotating.

**The collision guard is NOT optional.** `_sameTierTarget`'s comments record what
unconditional-MatA cost before V8.46-C: fork replay of graduation tx `0xff488549...`
(block 44702114) — member already held a T4.1 MatA seat, re-entry hit
`require(!isInMatrix)` at MatrixLogicLib:255, the empty catch at :513 swallowed it,
**9 events, 6 members, $467.50 lost.** Item 10 must mirror
`toMatB = isActiveInMatrix(member)`, not just "return MatA".

## WHY PAIR A ROTATES SLOWER THAN PAIR B — ANSWERED 2026-08-09

The owner reported on day two: *"members are not rotating fast enough in T1A or any
pair A as fast as the B pair"* and stated the intended design: *"when T1B cycles out
it should not go back to T1b it should go to T1A or T2A and continue up the ladder."*

Measured live across all 10 tiers (`diag_matb_freeze2.js`, paced + retried so no
failed read is mistaken for data):

| pair | entries | thr | MatA rot | MatB rot | ratio | `rescueReentry` target |
|---|---:|---:|---:|---:|---:|---|
| T2.1 | 5986 | 400 | 581 | 5684 | **9.8x** | MatB (saturated) |
| T1.1 | 3496 | **1000000** | 378 | 3210 | 8.5x (accrued BEFORE the mitigation) | **MatA** (mitigated) |
| T3.1 | 1153 | 400 | 434 | 870 | 2.0x | MatB (saturated) |
| T4.1 | 242 | 400 | 115 | 0 | — | MatA (under threshold) |

**Mechanism, confirmed.** `PairManagerV8.rescueReentry` :286 re-seats a rescued member
into own **MatB** once `totalRegistered >= routeEntryThreshold`. A member cycles out of
MatB, cannot fund the crossing, parks, is rescued — and is put back into MatB. A closed
loop. MatB churns, MatA crawls, and no one climbs the ladder. This is exactly the
behaviour the owner described from watching members, before it was found in code.

**The earlier hypothesis was WRONG and is recorded so it is not re-derived:** "MatA is
starved of all feed, so MatB gets no crossings and goes inert." T2.1 and T3.1 are
EXCLUDED by 10b yet their MatAs rotated 0.3h ago — cycle-out re-entry
(`sameTierTarget` -> own MatA) still feeds them. 10b's harm is that NEW members never
reach a mature pair (T2.2 has 35 entries, T3.2 has 3, while T2.1 has 5986); item 10's
harm is the MatB recycle loop. Two distinct defects, both real, both in scope.

**T1 is the control group.** It is the only tier carrying the mitigation
(`routeEntryThreshold = 1000000`), which forces `rescueReentry` down the MatA branch —
item 10's exact semantics. T1.1 MatA has gone 316 -> 333 -> 374 -> 378 today while its
MatB held 126/127. The fix is proven on live members before a line of it is written.

**Blast radius of 10b right now:** T2.1 (5986 entries vs threshold 400) and T3.1 (1153
vs 400) are permanently excluded from new registrations. T1 is masked by the mitigation.
T4-T10 are under threshold and therefore not yet affected — they WILL be, at 400 entries
each, with no code change required to trigger it.

## ITEM 10 MEASURED IN MEMBERS — PARKED CENSUS 2026-08-09 19:00 UTC

Rotation ratios say MatB churns faster than MatA. The parked census says who is paying
for it. Both halves, every tier (`parked_census.js`):

| tier | MatA parked | MatB parked | subtotal |
|---|---:|---:|---:|
| T1 | 24, 20, 0 | 62, 30, 0 | 136 |
| T2 | 69, 0 | **209**, 0 | 278 |
| T3 | 85, 0 | **165**, 0 | 250 |
| T4 | 50 | 0 | 50 |
| **TOTAL** | **248** | **466 (65%)** | **714** |

**466 members parked in MatB.** A member cycles out of MatB, cannot fund the crossing,
parks there — and `rescueReentry` at saturation re-seats them into that same MatB
(PairManagerV8:286). Two-thirds of everyone parked sits in the half that was recycling
them. This is item 10's cost expressed in people rather than rotation counts, and it is
the same defect the owner identified from member behaviour on day two.

**The rescue system itself is HEALTHY — verified, not assumed.** On-chain parked total
(714) reconciles EXACTLY with `copay_rescue`'s "714 still in grace" (86400s window).
Zero members are past grace awaiting a rescue that is not coming. `copay_rescue` runs
every 10 minutes, advances real USDC (3 rescued / $16.53 in one run), reports 0 failed;
`fastlane_rescue` and `evict_parked` are also scheduled. SF ~$10,900 and rising, ledger
conserving to the cent, fully backed.

Note for anyone re-deriving this: `rescue.log` is EMPTY and that is NOT a fault — no cron
writes to it. The live rescuers are `copay_rescue.js`, `fastlane_rescue.js` and
`evict_parked.js`. `rescue.log` is a stale log from a script no longer scheduled.

**Expected effect of the 2026-08-09 17:07 threshold change:** with every tier's
`routeEntryThreshold` unreachable, `rescueReentry` now takes the MatA branch everywhere,
so those 466 are re-seated into MatA as they are rescued rather than back into MatB. The
MatB share of parked members should fall. That is the metric to re-check tomorrow, and it
is the same behaviour item 10 makes permanent.

## SIZE BASELINE — measured 2026-08-09, before any V8.48 code

Deployed-bytecode size vs the EIP-170 limit of 24,576 bytes.

| contract | bytes | free | touched by | verdict |
|---|---:|---:|---|---|
| TierRouter | 24,434 | **142** | 2, 3 | **BLOCKED** — must land in TierRouterLib |
| MatrixPairFactory | 24,220 | **356** | — | leave alone; no scope item touches it |
| MatrixKeeper | 24,041 | **535** | 12 | **BLOCKED** — needs 12a MatrixKeeperLib first |
| MatrixLogicLib | 21,504 | 3,072 | 1, 11 | room, but it absorbs TierRouter overflow too — watch it |
| FigureEightMatrixV8 | 14,212 | 10,364 | 1 | clear |
| PairManagerV8 | 13,528 | 11,048 | 7, 10 | clear |
| StabilityFund | 13,372 | 11,204 | — | clear |
| V8Governance | 12,179 | 12,397 | — | clear |
| CNOVAToken | 12,878 | 11,698 | 4, 8, 9 | clear |
| CNOVADirectSale | 8,832 | 15,744 | 6 | clear |
| CommunityWallet | 7,827 | 16,749 | — | clear |
| CNOVATreasury | 7,138 | 17,438 | 5 | clear |
| CNOVABuybackReserve | 6,392 | 18,184 | — | clear |
| CouponRegistry | 4,271 | 20,305 | — | clear |
| OnrampRewardPool | 3,745 | 20,831 | — | clear |
| TierRouterLib | 3,085 | **21,491** | 2, 3 | the destination — 21 KB of room |

All 16 watched contracts fit today. But three are within 600 bytes of the
limit, and two of the three carry scope items (TierRouter: 2, 3 — MatrixKeeper:
12). That is the single largest schedule risk in V8.48 — bigger than any
individual defect on the list.

The good news the baseline buys us: **every other contract in the release is
under 13 KB.** Items 4/5/6/7/8/9/10/11 all land in contracts with 10 KB+ of
headroom and carry effectively zero size risk. The size problem is not a
release-wide problem — it is exactly two contracts, and both have a library
already built or planned to absorb the overflow (TierRouterLib at 3,085 bytes
has 21 KB free; MatrixKeeperLib per item 12a does not exist yet).

`scripts/sizes.js` WATCH list was itself incomplete: it omitted CNOVATreasury
and CNOVADirectSale, both of which V8.48 modifies (items 5 and 6). Extended
8 -> 16 contracts, and the gate now covers every contract the release touches.

**Rule for this release:** run `scripts/sizes.js` after EVERY contract edit, not
at the end. On a 142-byte budget, discovering the overflow at deploy time costs
a full re-architecture round.

## THE HARD CONSTRAINT — read before writing any code

**`TierRouter` had +142 bytes of EIP-170 headroom at V8.47.** Items 2 and 3 touch
it. They MUST go into `TierRouterLib`, not the router. This is physics, not
preference — the deploy simply fails otherwise.

Run `npx hardhat run scripts/sizes.js` BEFORE and AFTER every contract edit.
If any contract crosses 24,576 bytes the release cannot ship, and the only
remedies are library extraction or splitting the release. Establish the
before-baseline first.

## Suggested order (dependency, not priority)

1. **Sizes baseline** — `scripts/sizes.js`, record every contract.
2. **#10b `_findExternalPair` + #10 `rescueReentry` — SHIP TOGETHER.** 10 alone is
   unsafe: it redirects rescued members from MatB to MatA, and rescues are MatB's
   dominant feed today (T1 MatA rot 761 vs MatB 3,216). 10b is what makes 10 safe —
   it restores new-registration flow to every pair's MatA, so MatA rotation climbs,
   so crossings climb, so MatB is fed through its DESIGNED channel
   (`_finalizeCrossing` MatA -> partner) instead of through a bug's side effect.
   Fixing either one alone starves the other half.
3. **#11 surplus** — money loss, self-contained, same file.
4. **#4/#5/#6 floor set** — one-liners, already decided, already live in copy.
5. **#8/#9 vest ledger** — self-contained in CNOVAToken.
6. **#1/#2/#3 view parity + bulkWithdraw** — biggest size risk, do while headroom is known.
7. **#7/#13/#14 exit penalty + wiring + gate** — needs the design decision on cross-pair join dates.
8. **#12a MatrixKeeperLib extraction**, then **#12 checkUpkeep discovery** — largest new surface; retires 3 keepers. Extraction first or 12 cannot compile.

## Test gates before deploy

- Full suite green (402+ tests at V8.45; expect additions per item)
- New regression per numbered item — every one above is a live-verified defect,
  so each has a reproducible case
- `predeploy_check.js` passes INCLUDING the new wiring assertions (#14)
- Contract sizes under 24,576 bytes
- Keepers-OFF rotation gate (#20) on the fresh deploy
