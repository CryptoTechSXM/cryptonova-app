# V8.48 — LOCKED SCOPE (owner decision 2026-08-09: NOTHING DEFERS)

Policy, owner's words: *"I want everything we find placed in the scope for v8.48
and not defer to later versions, we keep pushing back deploy bcuz we defer, cost
is building."* Every finding below ships in V8.48. This file is the execution
list; `V8_48_BACKLOG.md` holds the evidence for each.

## Contract changes

| # | change | contract | source |
|---|---|---|---|
| 1 | `freeWithdrawable()` becomes a line-for-line mirror of `withdrawCore` (V8.32 opt-out + debt). Add `netClaimableOf(member)`. **CONFIRMED ON-CHAIN AND QUANTIFIED 2026-08-10 — the view under-reports on EVERY account measured.** Six-account cohort: `0x09D160` view $33.15 vs claimable $340.23 (under by **$307.09**); `0xa2f6FB` $18.41 vs $313.01 (**$294.60**); `0x7a245E` $85.55 vs $268.28 (**$182.73**); three smaller accounts all report **$0.00** against real balances. **Proven by withdrawal, not by reading:** `freeWithdrawable` summed to $0.00 for `0x1C56C6` while that member withdrew **$124.99** in two transactions minutes later. **ROOT CAUSE:** `freeWithdrawable` applies the crossing-reserve lock in EVERY matrix; `withdrawCore` applies it only where `automationReserve > 0`, i.e. the member's HIGHEST tier (`highest - 1 == cfg.tierIndex`). In every other matrix the real withdrawal path has no lock at all. Secondary divergence: `withdrawCore` repays SF debt off the top, `freeWithdrawable` does not model debt. **The frontend already knows and works around it** — `index.html:6626` computes the headline itself as *"raw withdrawable + pendingPoolOf"* and carries the note *"Contract backlog for next redeploy: make the freeWithdrawable VIEW mirror"*, which is why the dashboard is correct while the contract view is not. Direction is SAFE (understates, never over-promises) but a member reading it would believe their money is locked. **Also verified while testing:** withdrawal SETTLES pending pool first, so `totalEarned` understates until settlement ($74.52 -> $174.48 on one account across a single withdrawal); and the SF clawback works exactly as the loan panel promises ($15.25 borrowed, $15.25 repaid, $0.00 owed after withdrawing). | FigureEightMatrixV8 / MatrixLogicLib | §1, measured 2026-08-10 |
| 2 | `reservedHeldFor(member)` getter **or** bind reserve across all tiers — DECISION NEEDED | TierRouter(Lib) | §2 |
| 3 | `bulkWithdraw(uint256 amount)` — one-signature partial withdrawals | TierRouterLib | §3 |
| 4 | Mint cap: `amount <= deposit / floorPrice()` in `mintReward` | CNOVAToken | §4 |
| 5 | `require(floorPrice() >= floorBefore)` in `addDexLiquidity` + `emergencyWithdraw` | CNOVATreasury | §4 |
| 6 | `_floorPriceE6()` must read `usdcReserve`, not `balanceOf(treasury)` | CNOVADirectSale | §4 |
| 7 | Real cross-pair `memberJoinedAt` so `earlyExitPenaltyBps` can work | PairManagerV8 | §7 |
| 8 | `lockedBalanceOf` returns `min(sum(batches), balanceOf(wallet))` | CNOVAToken | §8 |
| 9 | Prune/reduce vest batches on BURN inside `_update` | CNOVAToken | §8 |
| 10 | ✅ **IMPLEMENTED 2026-08-09.** `dest = p.matrixA`, unconditional. NO collision branch: V8.46's UNIVERSAL PAIR GUARD (MatrixLogicLib:278) already rejects a seat in EITHER half, so steering an already-seated member to MatB swaps one revert for another — my first draft did exactly that and the test caught it. MatrixKeeper:558 treats the revert as expected-and-swallowable. Tests: `test/V8_48_RescueRouting.test.js` (3). ORIGINAL: `rescueReentry` returns own MatA — mirror `TierRouterLib.sameTierTarget` incl. the V8.46-C collision guard | PairManagerV8 | §10 |
| 10b | ✅ **IMPLEMENTED 2026-08-09 — final rule: share the stream across every FULL pair, plus exactly ONE pair being filled.** No configured threshold at all; capacity is read from the matrices (`occupancy()` vs `MATRIX_SIZE()`), turn-taking from `totalRegistrations`. **Three wrong attempts first, each caught by a test — recorded so they are not retried:** (a) *round-robin over all pairs* — spreads entries so no pair reaches MATRIX_SIZE, and below that NOTHING rotates (MatrixLogicLib:407); T1.3 at 8 members / rot=0 is what that looks like. (b) *strict one-door* — pairs 1+ never receive externals, never rotate; broke the O4 design-law gate. (c) *divert at physical fullness* — a full MatA only rotates when it RECEIVES an entry, so diverting away from a full pair FREEZES it; broke "pair-0 MatB must rotate WITHOUT any keeper". The two needs genuinely conflict — a full pair needs a CONTINUING stream, a filling pair needs a CONCENTRATED one — and the final rule serves both. `routeEntryThreshold` is now DEAD (only `overflowActive`, itself dead code, still reads it). ORIGINAL: **`_findExternalPair` cumulative-counter exclusion — THIRD site of the V8.46 root cause, never fixed.** `pairs[i].totalRegistered < routeEntryThreshold` with a counter that only ever increments (:426). A pair that passes the threshold is excluded from new registrations FOREVER — its MatA stops receiving entries and freezes. Masked since 2026-07-27 by `route_rr.js`. Fix: `routingIdx = totalRegistrations % pairs.length` — round-robin. Equal share regardless of history, no monotonic trap, O(1) (deletes the loop), and exactly what `route_rr.js` imposes externally. Feeding a full MatA is safe: V8.41 root rotation frees the seat (regression S3). **NOT argmin** — cumulative totals across pairs born at different times are not comparable; live `[3483,595,8]` would send 587 consecutive entries to T1.3 and starve the other two. | PairManagerV8 :578-584 | NEW, verified 2026-08-09 — **live incident, see below** |
| 11 | **selfRescue / coPayRescue surplus loss** — `crossingReserve` and `withdrawable` are zeroed UNCONDITIONALLY while `_finalizeCrossing` forwards only `entryFee`. Surplus is erased. Must credit the excess back to `withdrawable`. | MatrixLogicLib :1265-66 | NEW, verified 2026-08-09 |
| 12 | `checkUpkeep` must DISCOVER WORK_PARKED_RESCUE, WORK_EVICT_PARKED (and GHOST/RECLAIM). Executable today but undiscoverable — retires 3 keepers. | MatrixKeeper | AUTOMATION_AUDIT.md |
| 24 | **Keeper policy != contract policy on frozen MatB.** `_isFrozenMatB` (MatrixKeeper:633) requires full AND (never rotated OR `frozenMatBTimeout` = **6 hours** stale). `frozen_matb_keeper.js` rotates the moment a MatB reads full (`occ=127/127 nextSlot=128`), i.e. within 10 minutes. The protocol has been running on the KEEPER's policy for 6,726 rotations, which is why the contract's own failure gate ("if this ever fires regularly, the routing design has failed", :453) never tripped — on-chain it almost never fires. Decide the real policy and make ONE layer own it. | MatrixKeeper | NEW, verified 2026-08-09 |
| 25 | ~~`adminForceRotateRoot` reverts at scale~~ **WITHDRAWN 2026-08-09 — NOT a live defect.** The "29%" was a LIFETIME ratio I presented as a current rate. Per-day distribution: 152 on 07-18, 90 on 07-19, **2,583 on 07-24 (91% of all of them, a single day)**, 2 on 08-02, and **nothing since**. 07-24 is the V8.44 go-live and 07-18/19 is the `occ=127/127 rot=0` signature the contract comments name — i.e. these are the incidents V8.44/V8.46 were built to fix, already fixed. The two most recent `ERROR` lines (08-03, 08-04) are QuickNode `50/second request limit reached`, not reverts. `frozen_matb_keeper.js` already guards with `staticCall` (:152) and `estimateGas` (:172). **Keep that guard when item 24 moves the trigger on-chain** — `checkUpkeep` has no equivalent, and that is the real carry-over. | — | withdrawn after verification |
| 12a | **Extract `MatrixKeeperLib`** (same pattern as TierRouterLib / MatrixLogicLib). MatrixKeeper has 535 free bytes — item 12 does not fit. This is a prerequisite task, NOT a deferral of 12. | MatrixKeeper | size baseline below |

| 26 | **SF L1 surplus redirect to CommunityWallet** (owner proposal 2026-08-09). Add `communityOverflowBps` (default **0** = no behaviour change at deploy) + `setCommunityOverflowBps` `onlyOwnerOrGovernance`. In `receiveLayer` layer==1 only: when `totalBalance >= sfTarget()` and `communityWallet != address(0)`, route `amount * communityOverflowBps / 10000` to CW via `ICommunityWallet.deposit` (SF must `forceApprove` CW first), remainder to SF as today. Add `totalRoutedToCommunity` + event. **Do NOT touch L3** — that overflow funds BuybackReserve, which supports the CNOVA floor (items 4/5/6). Evaluate `totalBalance` BEFORE crediting the deposit so the deposit cannot tip its own test. | StabilityFund (11,204 bytes free) | NEW |
| 27 | ✅ **IMPLEMENTED 2026-08-09** (owner: *"we will be redeploying before then, please make the necessary fixes to future proof it"*). `perGenesis = genesisTotal / COHORT_SIZE`, same for Pioneer; unfilled-seat share rolls over instead of concentrating. Contract got 22 bytes SMALLER (7,827 -> 7,805). New suite `test/V8_48_CohortSplit.test.js` — 4 tests, covering the exact live 500/146 state, per-head invariance across enrolment, every ramp point incl. an empty cohort, and no cross-cohort leakage. Full suite 444 passing / 0 failing, so nothing had encoded the old behaviour. **CommunityWallet had NO dedicated test file before this** — a contract holding member money, reachable only incidentally from two other suites, which is why the inversion survived. ORIGINAL: **cohort inversion — divide by `COHORT_SIZE`, not live count.** `distribute()` computes `perGenesis = genesisTotal / gCount` and `perPioneer = pioneerTotal / pCount` using LIVE lengths, so while the Pioneer cohort is partly filled each Pioneer out-earns each Genesis member. Live 2026-08-09: G=500, P=146 -> next distribution pays Genesis **$2.24** and Pioneer **$5.11**, 2.3x, on a wallet whose entire premise is rewarding early membership. Inverted for any Pioneer count below 334 (totalEnrolled < 834). Fix: divide both by `COHORT_SIZE` (500) so per-head value is fixed and unfilled seats simply roll over; keep `actualDist = perGenesis*gCount + perPioneer*pCount` so undistributed value stays in the pool. | CommunityWallet (16,749 bytes free) | NEW |
| 28 | **Distribution expiry silently forfeits member money.** A distribution expires after `distributeInterval` (30d) and `_sweepExpired()` returns it to the pool. Members are told nothing. Exposure is $0.81 today but the 2026-09-04 distribution will be ~$1,865. Decide: keep expiry (and surface it loudly), or remove it. If kept, the frontend MUST show claimable amount + days remaining, and `claimable(address)` (:373) already provides the number. | CommunityWallet + frontend | NEW |
| 29 | **`StabilityFund.sol:18` documents a carve rate that does not exist.** Header says *"L1: Per-entry stabilityBps carve (6% T1-T3, 5% T4-T10)"*. Deployed config is `SPLITS_ALL[4] = 300` bps — a flat **3% on all ten tiers** (`deploy_v8.js:103`, `tierSplits()` returns the same array for every tier). The comment is both tier-varying (it isn't) and ~2x the real rate. Modelling item 26 from it would have been 2x wrong. | StabilityFund (comment only) | NEW |

| 30 | ✅ **IMPLEMENTED 2026-08-09.** Deleted from PairManagerV8: `deployEntryThreshold`, `routeEntryThreshold`, `setEntryThresholds`, the `EntryThresholdsSet` event and `overflowActive()`, plus the dead `overflowActive` declaration in MatrixLogicLib's interface. **Verified before cutting: ZERO production reads of either value, no governance parameter wiring, no call from `deploy_v8.js` or `predeploy_check.js`** — the knobs were reachable only from the owner setter, and `overflowActive` only from tests. A tombstone comment replaces them explaining WHY a cumulative counter compared against a fixed number is the defect, so it is not reintroduced as a routing input. Tests: 36 call sites across 11 files. Two V8Elevator tests DELETED rather than retargeted (the setter's bounds/ownership check and the `overflowActive` view) — they asserted that a knob stores what you hand it and that a view agrees with the knob; neither describes member-facing behaviour and there is nothing left to point them at. One RETARGETED: `"routing no longer depends on routeEntryThreshold at all"` in V8_48_RescueRouting worked by setting the threshold to 1 vs 1,000,000 — no longer expressible, but `pair.totalRegistered` still exists and still must not steer routing, so it now compares a pair with real entry history against a nearly-empty one. **Frontend shipped with it** (see below). | PairManagerV8 | NEW |
| 31 | ✅ **IMPLEMENTED 2026-08-09.** `rescueReentry` routes a member already seated in the pair to `_freePairFor(member, fromPairIndex)` — the same call TierRouter:1382 makes. Seated in EVERY pair: calls `_forceExpand()` (try/catch) and retries, then fails loudly with `PM8: no seat available for duplicate` rather than stranding. Counters and `MemberRouted` credit the DESTINATION pair. Removes the mechanism TierRouter:1372 documents — *"a duplicate stops its pair dead the moment its holder reaches position 1"* — because rescueReentry is called with NO try/catch at MatrixLogicLib:773, so that revert took the whole cycle-out with it. ORIGINAL: **Double-entry members have no route to the next pair.** A member cannot hold two seats in one pair (V8.46 universal pair guard), and `rescueReentry` is called with NO try/catch at MatrixLogicLib:773 — so when a double reaches MatB position 1 the re-entry reverts and takes the whole cycle-out with it. `TierRouter:1372` already documents the consequence: *"a duplicate stops its pair dead the moment its holder reaches position 1 (T3.1 and T4.1 both had to be repaired live on 2026-07-28)"*. Likely a large share of what `frozen_matb_keeper.js` force-rotates 6,726 times. Fix: mirror TierRouter:1382 — `freePairFor(member, fromPairIndex)`. **OPEN DECISION:** when the member is seated in EVERY pair (`freePairFor` returns `uint256.max`), park them in the matrix they cycled out of (keeps the pair turning, strands nobody, existing rescue machinery handles parked members) vs revert (wedges the pair) vs skip silently (strands the fee behind a live approval). Owner recommendation pending. | PairManagerV8 | NEW |

| 32 | **Backup keeper: detect `PM8: no seat available for duplicate` and spawn a pair.** The contract already tries `_forceExpand()` itself (try/catch, so it can never revert a member's cycle-out), but a factory failure still leaves the member unseated. Owner: *"a member eligible to cross or enter a new pair should not be parked, a new pair should be spawned so they have space to sit."* Keeper watches for the revert and triggers expansion out-of-band. Should be unreachable — the 90% factory trigger keeps a standby pair open. | /root/keeper/ | NEW |
| 33 | **Spawn a pair when the newest is FULL** (owner approved, not yet implemented). `_tryAdvancePair` fires on `newest.totalRegistered >= deployEntryThreshold` (cumulative — same family as 10b) or newest MatB >= 90%. Replace the cumulative trigger with `_pairFull(pairs.length - 1)`; keep 90% as the early warning that preserves deploy lead time. Makes `deployEntryThreshold` dead, joining `routeEntryThreshold` in item 30. | PairManagerV8 | NEW |
| 34 | ✅ **IMPLEMENTED 2026-08-09.** Four new tests in `V8_44_Overflow.test.js`, on a new `deployOnePairWithFactory` fixture (the existing O-fixture added its second pair BY HAND, so `_tryAdvancePair` never had a factory to call and neither trigger could fire). **O5** — the EARLY trigger: asserts the successor pair is deployed while pair 0 STILL HAS SEATS, which is the entire reason for keeping a 90% trigger. **O5b** — NEGATIVE CONTROL, identical drive with the threshold at 100%, proving occupancy crossing the threshold is what CAUSED the expansion rather than merely co-occurring with it. **O6** — the FULL-pair backstop. **O7** — the strengthened O4 the owner asked for: drives pure member-driven churn until pair 1 genuinely fills, then proves BOTH limbs of the routing rule from one event log (every member's first `MemberRouted` is pair 0; every routing INTO pair 1 belongs to a member already in the protocol), and NAMES THE ROUTE via `DoubleEntryFired` because `freePairFor` has two callers that emit the same event. Also locks the V8.46 universal pair guard under real duplicate volume: two pairs yes, both halves of one pair never. **FINDING, recorded not deleted: `fullTrigger` is SUBSUMED by `matBTrigger`.** `setFactoryExpandThreshold` caps at BPS_DENOM and occupancy can never exceed MATRIX_SIZE, so a full pair implies a full MatB implies 10000 bps — `_pairFull` can never be the SOLE cause of an expansion. It is defence in depth, earning its bytes only if occupancy drifts ABOVE MATRIX_SIZE (the V8.44 phantom-seat class, "occupancy drift +44"), where MatB reads 6/7 while the pair sums to full. **Do not reclaim those bytes under item 30's doctrine without reading this.** | test/V8_44_Overflow.test.js | NEW |

| 35 | ✅ **IMPLEMENTED 2026-08-09 — TWO ROUTING RULES IN ONE CONTRACT, AND THE VIEWS FOLLOWED THE WRONG ONE.** Found while wiring the tier card for item 30. `_findRoutingPair()` (V8.40: *"oldest pair whose MatA still has a free seat, else the newest"*) survived item 10b, which moved actual entry routing to `_findExternalPair()` — constant 0, ONE DOOR. **The two agree only while pair 0's MatA has room, and a FULL pair 0 is the designed steady state** — concentrating the front door is what holds it at MATRIX_SIZE and keeps it rotating. So the rule diverged precisely when the design was working. **Three PUBLIC VIEWS reported the stale rule as "the routing target": `getActivePair()`, `allPairsStatus().active[]`, `routingDistribution()` — and the member-facing tier card reads all three.** It would have labelled the empty standby pair "taking new entries", and because the home card selects which matrices to draw its seat bars from using that same flag, T1.1 could hold 254 members while the card drew T1.2's empty ones — the *"T1.2 reads 0/127 while the community fills T1.1"* bug the frontend comments already record, reintroduced from the contract side. **None of the three had a test.** Fix: `_findRoutingPair()` DELETED, all four call sites (incl. the legacy V7-compat `register()`) read `_findExternalPair()`. One rule, one place. Regression **O8** asserts all three views name pair 0 while pair 0's MatA is full, then registers a member to confirm the views agree with what the contract DOES — and recomputes the deleted rule inside the test, asserting it points at pair 1, so O8 proves it is standing on the divergence rather than on a state where both rules coincide (which is every state where pair 0 has room, i.e. most of them). **Fourth instrument in this project caught disagreeing with the mechanism it reports on**, after `set_entry_thresholds.js`'s routing-pair label, `diag_overflow.js`'s hardcoded pair index and the tier card's threshold copy. | PairManagerV8 | NEW, verified 2026-08-09 |
| 36 | **Frontend, shipped with item 30.** `index.html`: both threshold entries removed from `PM_ABI`; the `routeEntryThreshold().catch(() => 381n)` read in `_fetchStats` DELETED — after cutover that call reverts, the catch swallows it, and the card quietly reports a threshold of 381 that exists nowhere (a swallowed read impersonating a value, aimed at members). `renderTierPairHeader` loses its `threshold`/`deployThreshold` parameters; the threshold-derived `'saturated'` state label is gone; the standby-buffer prose is replaced by **seats remaining in the pair taking new entries** (owner decision 2026-08-09) — bounded at 254 and drawn from the same occupancy figures as the bars, so sentence and bar cannot disagree. Also removes **20 RPC calls per page load** on an endpoint we are already rate-limited on. Verified: all 5 inline script blocks parse, no orphaned variables, file ends `</body></html>`, 622,565 → 620,358 bytes. | CryptoNova-Testnet-App | NEW |

| 37 | **EARNINGS SOURCE TRANSPARENCY — members cannot see WHY they were paid** (owner decision 2026-08-10: *"I would like to have full transparency and if they want it and it is cheap why not"*). `_credit()` (MatrixLogicLib:~1030) increments `withdrawable` + `totalEarned` and **emits NOTHING**. Two of the four earning paths are therefore invisible to any consumer: the **2.5% direct earn** on entry (`DIRECT_EARN_BPS`, :805) and the **L1 referral payment** (:811). Chain pay (`ChainPayDistributed`, :964) and pool share (`PoolShareCredited`) DO emit, so the dashboard can attribute those two and only those two. **The failure case is observable while the success case is not:** an ORPHANED L1 emits `OrphanFeeRouted`, but an L1 that actually pays a referrer is silent. Consequence today: the member dashboard's breakdown is PER-TIER, not per-source — a member sees their balance rise with no way to learn whether it came from a referral, from someone entering below them, from the pool, or from their own crossing. **FIX:** add `uint8 source` to `_credit` and emit `EarningsCredited(address indexed member, address indexed payer, uint8 indexed source, uint256 amount)`. Eight call sites to tag (MatrixLogicLib :500 pool share, :805 direct entry, :811 L1 referral, :894/:913/:934/:936 accountOne + orphan fallbacks, :964 chain pay). **KEEP `ChainPayDistributed` and `PoolShareCredited`** — the frontend and the VPS keepers read them today, so removing them in the same release breaks live tooling; retire them only once the frontend has migrated to the unified stream. Cost is small: MatrixLogicLib has **3,072 bytes free**, an indexed event plus eight emits is well inside it — but run `sizes.js` after, MatrixLogicLib is the second-tightest contract in the system. **Ships with a frontend change** that groups the dashboard breakdown by SOURCE as well as by tier; without that the event exists and nobody sees it. | MatrixLogicLib + frontend | NEW 2026-08-10 |

| 38 | **CODE↔FRONTEND PARITY AUDIT — make it a deploy gate** (owner rule 2026-08-10: *"code is truth but should also be reflected on the frontend/website"*). Three divergences were found in a single session, all member-facing, none caught by 452 passing tests — because the tests verify the CONTRACT and nothing verifies that the SITE says the same thing. (a) the tier card told members a standby pair opens at N entries, reading a knob that steered nothing, behind a `.catch(() => 381n)` that would have survived the knob's deletion and printed a stale 381 for ever; (b) the card named T1.3 as "taking new entries" while every new member entered T1.1, because it read `allPairsStatus().active[]` — computed from `_findRoutingPair`, a DIFFERENT rule from the `_findExternalPair` registrations actually use (item 35); (c) the earnings breakdown groups by tier and cannot group by source, because `_credit()` emits nothing for L1 or direct-earn (item 37). **DELIVERABLE:** `PARITY_AUDIT.md` — one row per member-facing claim on the site, the contract function/constant that backs it, and a verified date. Anything without a named source does not ship. **Add to `scripts/predeploy_check.js`** the mechanical half: fail the gate if `index.html` references any contract member absent from the deployed ABI (catches exactly the item-30 class, where the frontend outlives a deleted getter). The judgement half stays a human read of the checklist. | frontend + scripts/predeploy_check.js | NEW 2026-08-10 |

| 39 | **"WHY HAVEN'T I CYCLED?" — the dashboard shows cycles but never shows DISTANCE TO THE NEXT ONE.** Two members have now reported this independently: Sherwyn 2026-08-08 (6 cycles vs 1) and CryptoJan22 2026-08-10 (*"this account has 5 directs... shows that it cycled only 2 times... i figured there would have been more cycles"*). **Neither is a defect — both are the interface failing to teach the mechanism.** Cycles come from `_cycleOutRoot` advancing every member one seat toward position 1 on each rotation; **direct referrals do not affect cycle rate at all.** What sets it is (a) the seat you were given and (b) whether your matrix is still receiving entries. Members have no other model available, so they reach for the one number they can see — their directs. Diagnosed live for CryptoJan22 (`0x79470c63…`): T1.1 MatA **seat 88/127**, 3 cycles, **87 rotations from cycling out**, in the pair that IS receiving entries (630 rotations) — i.e. perfectly healthy and roughly a day and a half away at the observed ~62 rotations/day. `diag_cycle_rate.js` prints that in one line; the dashboard cannot. **FIX:** surface seat position and rotations-remaining on the dashboard — `matrixPos` is ALREADY read by the frontend (`index.html:4930/7282/7353`) so the data is in hand and unused. Add "seat N of 127 · M rotations until you cycle" plus the matrix's recent rotation rate so the number means something in time. **ALSO REVIEW while there:** (a) the cycles read is behind `.catch(() => 0n)` at `index.html:4022/4804/5726` — an RPC hiccup renders "0 cycles" to a member who has cycled, the same swallowed-read class as item 30's tier card; (b) the locked-feature hint at `:4049` explains a cycle as *"MatA fills (126 members), then MatB fills (127 members)"*, which is not the rotation mechanism the contract implements and is a candidate for the same misunderstanding. | frontend | NEW 2026-08-10, from BUGS.md |

| 40 | **ONE-CLICK "CLEAR ALL" FOR MULTIPLE PARKED POSITIONS** (member request via QA, 2026-08-10). A member parked in more than one matrix must today approve and Self Rescue each one separately — 2 positions = 4 wallet transactions for a total of **$4.28**. The panel already computes and shows the total correctly; what is missing is a single action. **WHY ONE APPROVAL CANNOT COVER BOTH:** `selfRescue()` takes no arguments and spends the member's ERC-20 allowance granted to THAT MATRIX, so each position has a different spender. There is no multicall contract in the system, and a batch helper cannot work because `selfRescue` derives the member from `msg.sender` — a helper would rescue itself. **SHIP NOW (frontend only, no deploy):** one `Clear all (N) — $X.XX` button that sequences approve->selfRescue per position, plus `Copay all — borrow $X.XX` for the loan route. MUST re-read state after each step and report partial completion honestly ("cleared 1 of 2, T3.1 failed: <reason>") — a clear-all that reports success it did not verify is the same defect class as the top-up that printed a landed transfer while the balance was unchanged (bigfill, 2026-08-10). **SHIP WITH V8.48 (halves the transactions):** add `selfRescueWithPermit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)` mirroring the existing `TierRouter.manualUpgradeWithPermit` (:910). MockUSDC already has ERC20Permit (V8.44 G1) and native USDC on Base supports EIP-2612, so the approval becomes a FREE off-chain signature and each position costs ONE transaction instead of two — 2 positions goes from 4 transactions to 2. **LATER:** EIP-5792 `wallet_sendCalls` would make it a true single confirmation, but wallet support is uneven; needs the sequenced path as fallback regardless. | frontend + FigureEightMatrixV8 | NEW 2026-08-10, member request |

## Deploy / script changes

| # | change | file |
|---|---|---|
| 13 | Call `setTier1Matrix` / `setMemberTracker` — never called, so `earlyExitPenaltyBps` returns 0 and `setFreeMode` (Universe Mode) reverts | scripts/deploy_v8.js | §7 |
| 14 | Assert every wiring setter was called; fail the gate if not | scripts/predeploy_check.js | §7 |
| 15 | Re-verify every ERC20 approval amount against what the release CHARGES | frontend + scripts/ + /root/keeper/ | §9 |

## Post-deploy actions

| # | action |
|---|---|
| 16 | ~~Revert the live mitigation~~ **WITHDRAWN — nothing to revert.** These are not proxies; V8.48 is a FRESH DEPLOY as V8.47 was on 2026-08-05. The `uint256.max` thresholds live on the OLD contracts and cease to exist at deploy. `routeEntryThreshold` is also no longer read by any routing path. |
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

## THE ROUTING RULE — OWNER'S SPEC, STATED THREE TIMES 2026-08-09

Encode this and do not drift from it. Every wrong turn tonight came from violating it.

**NEW MEMBERS HAVE ONE ENTRY POINT. Never dilute new entries across pairs.**
`_findExternalPair()` returns 0. Always. Concentrating the front door is what holds pair 0
at MATRIX_SIZE and keeps it rotating — a full MatA only rotates when it RECEIVES an entry
(MatrixLogicLib:407), so diverting new members away from a full pair FREEZES it. That is
the 2026-08-06 incident, 254 members.

**EXISTING MEMBERS CYCLE, and that is what populates later pairs:**

| route | when | code |
|---|---|---|
| A -> B -> A **same pair** | default | `TierRouterLib.sameTierTarget` -> own MatA; `rescueReentry` -> own MatA |
| A -> B -> A **2nd pair** | member already holds a seat in this pair (V8.46 universal pair guard forbids two seats in one pair) | `_freePairFor(member, fromPairIndex)` |
| A -> B -> A **upgrade pair** | tier upgrade | TierRouter upgrade path |

Three attempts at `_findExternalPair` were rejected for violating the first rule, each
caught by a test rather than by reasoning: round-robin (dilutes; no pair reaches
MATRIX_SIZE so nothing rotates), share-across-full-pairs-plus-one-filling (dilutes),
divert-at-physical-fullness (freezes the pair it diverts from). **The answer was never a
routing formula for new entries — it was one door, plus giving CYCLING members the
2nd-pair route they were missing.**

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

## COMMUNITY WALLET — VERIFIED STATE AND TWO FALSE BELIEFS 2026-08-09

Owner asked to verify two beliefs against code. **Both are false, and both match the
OLD FRONTEND's gating** — removed in Batch 1 (`b1ddefd`), which is where the mental
model came from. Recorded here so neither is re-derived.

| belief | reality (code) |
|---|---|
| "Genesis get paid when we hit 500, Pioneer at 1000" | **No cohort-fullness gate exists.** `distribute()` requires only `totalEnrolled > 0` (:262); it divides by LIVE `genesisMembers.length` / `pioneerMembers.length`. `claim()` requires only `cohort[msg.sender] != COHORT_NONE`. **A distribution already ran 2026-08-05** with G=500, P=146. |
| "Can claim once the 25th of the month hits" | **No calendar date anywhere.** `distribute()` gates on `block.timestamp >= lastDistributionTime + distributeInterval` — a ROLLING 30-day timer that drifts each cycle. Last 2026-08-05, next due **2026-09-04**. `claim()` has NO time gate at all. |

Verified live state:

| field | value |
|---|---|
| totalEnrolled | 646 / 1000 (Genesis **500**, Pioneer **146**) |
| split | 60% Genesis / 40% Pioneer (frontend modal says 65/35 — still wrong, separate) |
| distributeRatioBps | 5000 — 50% distributes, 50% rolls over |
| distributeInterval | 30 days (NOT 25, NOT day-of-month) |
| lastDistributionTime | 2026-08-05T05:09:42Z |
| next due | **2026-09-04T05:09:42Z** |
| CW USDC balance | $3,730.94 |
| totalActivePending | $0.81 unclaimed |

**Payout model for item 26** (constants read from source, not assumed). Blended SF carve
**$1.08 per entry** at a plausible tier mix (T1 55%, T2 22%, T3 13%, T4 6%, T5 3%, T6 1%),
100% of L1 redirected while SF >= target, both cohorts full:

| members | cycles/mo | SF->CW /mo | Genesis ea | Pioneer ea |
|---:|---:|---:|---:|---:|
| 1,000 | 2 | $2,160 | $2.59 | $1.73 |
| 2,500 | 2 | $5,400 | $6.48 | $4.32 |
| 5,000 | 2 | $10,800 | $12.96 | $8.64 |
| 5,000 | 4 | $21,600 | $25.92 | $17.28 |
| 10,000 | 4 | $43,200 | $51.84 | $34.56 |

Linear in members x cycles x redirect fraction. **Be honest in the announcement copy:**
at today's scale this is a few dollars a month; it only becomes material at 5-10k active
members.

**The redirect is self-limiting, and the DAO dial already exists.** `sfTarget()` =
`tierEntryFee[highestOpenTier-1] * sfTargetMultiplier` (currently **20**). Target ladder:
T5 $5,000 -> T6 $10,000 -> T7 $20,000 -> T8 $50,000 -> T9 $100,000 -> T10 **$200,000**.
As high tiers open the SF must hold far more before a cent redirects, so payouts throttle
naturally. `setSfTargetMultiplierT1..T6` are ALREADY `onlyOwnerOrGovernance` — that
multiplier, not a new threshold, is the lever the DAO votes on. Lower = more to members,
higher = harder fund.

**Current SF surplus:** target $5,000, balance $10,929.31, **$5,929.31 idle**, healthBps
maxed at 10000. Owner decision 2026-08-09: **leave it** — T6 opening moves the target to
$10,000 and T7 to $20,000, so growth absorbs it, and no privileged sweep function needs
to be written or audited.

**Why the existing overflow does nothing:** lifetime `totalRoutedToBuyback` = **$6.88**
and `totalRoutedToSF` = **$0.77**. The entire sliding mechanism has governed $7.65 while
$10,929 accumulated through L1/L5, which have no ceiling. The design is sound but attached
to the wrong layer.

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
