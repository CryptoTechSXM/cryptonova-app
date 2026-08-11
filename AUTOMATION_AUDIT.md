# AUTOMATION vs CODE AUDIT — 2026-08-09

Question asked: **can any of the automations be done by the smart contract
instead?** Method: enumerate the live crontab, map each job to the on-chain
work surface, and classify. Every claim below is from source, not inference.

> ## ⚠️ CORRECTION 2026-08-11 — THE CENTRAL FINDING BELOW IS WRONG AT SOURCE LEVEL
>
> Checked before starting item 12, which this audit created. `git log -S` puts
> `_scanMatrix` (GHOST / RECLAIM) inside `checkUpkeep` since **V8.1** and
> `_checkParked` (PARKED_RESCUE / EVICT_PARKED) since **V8.10**. Both were already
> there in `bf8aee34` — the very commit that added this file — at
> `MatrixKeeper.sol:476-497`, a few lines below the `:465` this audit cites by number.
> A local fixture confirms the behaviour: with members registered and the clock
> advanced, `checkUpkeep` returns RECLAIM and PARKED_RESCUE items.
>
> So all four types marked "discoverable: **NO**" below were discoverable when this
> was written. The table is corrected in place; the original claim is kept struck
> through rather than deleted, because three keepers are still running on the
> strength of it.
>
> WHAT REMAINS OPEN is a different question, and a fair one: whether discovery
> actually FIRES on the live deployment. `scripts/diag_keeper_discovery.js` asks the
> chain directly — configuration, parked census, and `checkUpkeep`'s own output —
> and distinguishes the three possibilities that matter:
>   1. it fires → the three keepers are redundant today and item 12 is a retirement,
>      not a feature;
>   2. it is CROWDED OUT of a full `maxItemsPerUpkeep` batch → item 12 is a
>      prioritisation change, not a discovery one;
>   3. it genuinely never queues → the audit is right in effect, wrong in cause, and
>      the cause is what to fix.
>
> Do not act on the finding below until that script has been run.
>
> ### RESOLVED 2026-08-11 — it was run, twice, against Base Sepolia
>
> **Discovery works and is fully configured.** `configuredTierCount` 10, every
> `pairManagerForTier` set, 30 matrices reachable. `checkUpkeep` nonetheless returns
> ZERO items, and the reason is none of the three above:
>
> **915-923 parked members, and not ONE is past the 24h `parkedGracePeriod`.** Ages run
> 0 → 23.6h with a hard stop at the boundary: median 1.2h, p75 8.0h, max 23.6h. That is
> the shape of `copay_rescue.js` sweeping the queue the instant members cross 24h.
> Everyone below the line is simply waiting their turn. The queue is also CLEAN — 923
> entries, 923 unique, zero duplicates, zero `parkedAt == 0`, zero stale entries — so
> none of the corruption hypotheses hold either.
>
> **Nothing is broken.** On-chain discovery never fires because the off-chain keeper
> gets there first, by design, at exactly the policy boundary the contract defines.
>
> ### ~~TWO CORRECTIONS TO SECTION C~~ — RETRACTED, I READ A STALE FILE
>
> I first checked the keepers against `crontab_v8_45_staggered.txt` IN THIS REPO and
> reported that `fastlane_rescue.js` was not scheduled and `evict_parked.js` did not
> exist, concluding the audit's "three keepers" were really one. **Both claims were
> wrong.** That file is a config artifact and does not match the VPS.
>
> `crontab -l` on cryptonova-keeper, 2026-08-11:
>
> - `copay_rescue.js` — **LIVE**, `4-59/10` (every 10 min). Honours `parkedGracePeriod()`.
> - `fastlane_rescue.js` — **LIVE**, `3-59/10` (every 10 min). Last line of the crontab.
> - `evict_parked.js` — **LIVE**, `*/30` with `TIER=T1 LIVE=1 BUDGET=280`. It exists on
>   the VPS even though it is absent from the `CryptoNova-Keepers` folder in this repo.
>
> All three run. Section C's list was right.
>
> `route_rr.js` is **NOT** live — `TRIM-2026-08-06`, commented out, as section D says.
> That concern was unfounded; the repo file simply predates the trim.
>
> **A repo file is not live state.** This is the same error as item 12 and item 41, made
> while documenting them. See the rule in `CLAUDE.md`.
>
> ### WHAT THIS DOES TO THE SELF-FUNDED CENSUS
>
> It censors it. `fastlane_rescue.js` rescues exactly the members whose
> `withdrawable + crossingReserve >= entryFee` — the self-funded ones — every ten
> minutes. So "0 of 240 sampled are self-funded" CANNOT distinguish *none exist* from
> *they are cleared before a snapshot can see them*, and the 84.2% median describes the
> RESIDUAL population fastlane leaves behind, not the population at park time.
>
> The revert of item 12's split grace was therefore made on evidence that does not
> support it either way. **The decisive read is `fastlane.log` on the VPS**: if it reports
> real rescues run after run, self-funded members exist, fastlane has been doing
> on-chain-able work every 10 minutes, and the split grace should go back in.
>
> ### WHAT WAS BUILT, MEASURED, AND THROWN AWAY
>
> A split grace period was implemented for V8.48 item 12: apply `parkedGracePeriod` only
> when the rescue draws Stability Fund money, and a short race guard when the member
> funds their own re-entry (`withdrawable + crossingReserve >= entryFee`, so `sfShare`
> is already 0 in `_checkParked`). It compiled, kept the 486-test suite green, and was
> **REVERTED UNSHIPPED** — because the census says it would release nobody:
>
> **0 of 96 sampled parked members are self-funded.** Every one needs SF money and every
> one correctly waits the full 24 hours.
>
> ### ⚠️ THE SECTION BELOW OVERSTATED ITS EVIDENCE — CORRECTED 2026-08-11
>
> The six rows quoted below were not a sample of the parked population. The census
> that produced them printed a member ONLY when their effective contribution was
> **>= 90% of the fee**, capped at six entries. They are the top of a filter, and they
> were then written up as though they described everyone ("the system is a few percent
> away"). The distribution below 90% was never measured.
>
> What is actually established: **at least six parked members are within 2-9% of
> funding their own re-entry**, and **0 of 96 sampled are at or above 100%**. Whether
> the median parked member sits at 95% or at 40% is unknown, and the economics question
> turns entirely on that.
>
> `scripts/diag_parked_truth.js` now records EVERY ratio and prints percentiles, a
> histogram, and a table of how many members each extra point of
> `CROSSING_RESERVE_BPS` would lift over the line. It also samples evenly across each
> parked array rather than the two ends — head-and-tail sampling is right for spotting
> a stale queue and wrong for a distribution. Re-run it before acting on any of this.
>
> ### THE FINDING WORTH KEEPING — SIX MEMBERS ARE *JUST* SHORT
>
> The near misses cluster hard against the threshold:
>
> | tier | effective (withdrawable + reserve) | entry fee | % of fee |
> |---|---|---|---|
> | T1 | $9.83  | $10.00  | **98%** |
> | T3 | $47.18 | $50.00  | **94%** |
> | T4 | $91.04 | $100.00 | **91%** |
> | T4 | $91.47 | $100.00 | **91%** |
> | T4 | $91.91 | $100.00 | **92%** |
> | T4 | $92.35 | $100.00 | **92%** |
>
> Effective contribution is `withdrawable + crossingReserve`, and the reserve is a flat
> **50% of the fee** (`CROSSING_RESERVE_BPS`). So these members have accumulated 41-48%
> of a fee in withdrawable earnings and stop just under the 50% that would let them
> re-enter on their own. Not one crosses it.
>
> For THESE six, a few percent of accumulated earnings separates a self-funded re-entry
> from a Stability Fund loan. That is worth understanding before tuning
> `CROSSING_RESERVE_BPS` or the SF rescue ladder — but how much of the population it
> describes is exactly what the corrected census above has to answer first. Do not size
> a change off six filtered rows.

## The central finding

`MatrixKeeper` defines **10 work types**. `performUpkeep` can execute all 10.
~~`checkUpkeep` can only DISCOVER **6**~~ — **`checkUpkeep` discovers all 10; see the
correction above.** The original table follows with the four disputed rows marked:

| work type | executable | discoverable |
|---|---|---|
| WORK_VELOCITY (0)      | yes | yes |
| WORK_GHOST (1)         | yes | ~~**NO**~~ **yes** — `_scanMatrix`, since V8.1 |
| WORK_RECLAIM (2)       | yes | ~~**NO**~~ **yes** — `_scanMatrix`, since V8.1 |
| WORK_CHAIN_LINK (3)    | yes | yes |
| WORK_PARKED_RESCUE (4) | yes | ~~**NO**~~ **yes** — `_checkParked`, since V8.10 |
| WORK_VELOCITY_GATE (5) | yes | yes |
| WORK_EVICT_PARKED (6)  | yes | ~~**NO**~~ **yes** — `_checkParked`, since V8.10 |
| WORK_DISTRIBUTE_CW (7) | yes | yes |
| WORK_FORCE_ROTATE (8)  | yes | yes |
| WORK_ADVANCE_EPOCH (9) | yes | yes |

~~**The contract can DO parked-rescue, eviction, ghost cleanup and reclaim — but
it cannot FIND them.**~~ **It can find them, and could when this was written.** What
was never checked is whether it finds them IN PRODUCTION — see the correction above
and run `scripts/diag_keeper_discovery.js`. If discovery fires on chain, then
`copay_rescue`, `fastlane_rescue` and `evict_parked` have been duplicating work the
contract was already queuing, and retiring them is an operational decision rather
than a contract change.

`performUpkeep` is also allowlisted (owner / governance / `upkeepCaller`) since
V8.46 item 1 — "was external with NO guard, so anyone could drive the queue".
So even discoverable work needs an authorised caller.

## Verdicts

### A. Genuinely off-chain — no contract change can replace these

| job | why |
|---|---|
| `onramp_keeper.js` | `OnrampRewardPool.distributeReward` needs EXTERNAL revenue (Transak/Ramp fees). A contract cannot pull money that has not arrived. |
| `integrity_check.js` | alerting. A contract cannot page a human. |
| `sf_invariant_check.js` | alerting. |
| `monitor_v8.js`, `channel_pulse.js` | reporting to humans/channels. |
| `growth_snapshot.js`, `dupe_watch.js`, `system_keeper.js` | observability. |

Observability and alerting are correctly off-chain. No action.

### B. The engine — must stay

| job | why |
|---|---|
| `direct_keeper.js` (:05/10min) | drives `performUpkeep`. Allowlisted BY DESIGN. This is the authorised caller the contract requires. |

Note: `contracts/cre/AutomationReceiver.sol` + `cryptonova-keeper/` (Chainlink
CRE) exist as an alternative authorised caller. If CRE were live and registered
as an `upkeepCaller`, `direct_keeper.js` becomes a redundant fallback rather
than a single point of failure. **Worth confirming whether CRE is registered.**

### C. Off-chain ONLY because the contract cannot discover the work

| job | on-chain equivalent | blocker |
|---|---|---|
| `copay_rescue.js` | WORK_PARKED_RESCUE (4) | `checkUpkeep` never queues it |
| `fastlane_rescue.js` | WORK_PARKED_RESCUE (4) | same |
| `evict_parked.js` | WORK_EVICT_PARKED (6) | same |

**These are the answer to the owner's question.** They are not redundant today,
but they COULD be if `checkUpkeep` enumerated parked queues. The getters already
exist (`getParkedCount()`, `getParkedMember(i)`, `parkedAt(addr)` on every
matrix), and `maxItemsPerUpkeep = 15` already bounds the output, so the queue
would stay small regardless of how many are parked.

`checkUpkeep` is a `view` consumed off-chain (Chainlink pattern), so enumeration
cost is not a gas constraint on the transaction — only on the RPC call.

**CANDIDATE FOR V8.49:** extend `checkUpkeep` to discover parked rescues and
evictions. That would let `copay_rescue`, `fastlane_rescue` and `evict_parked`
be retired, leaving `direct_keeper` as the only operational keeper.

CAVEAT — the economic half does NOT move on-chain. `coPayRescue` is already
permissionless (anyone may call it), so the keeper is not providing permission;
it is providing the DECISION to spend Stability Fund money, plus gas. Discovery
can be automated. "Should the SF fund this rescue right now" is a policy choice
and stays a human/keeper decision.

### D. Compensating for a contract defect — should be DELETED after V8.48

| job | status | why |
|---|---|---|
| `route_rr.js` | TRIM-2026-08-06 | walked T1's `routeEntryThreshold` to spread members. Was masking the `rescueReentry` bug (backlog section 10). Turning it off on 08-06 is what exposed the freeze. **Do not re-enable — fix the contract instead.** |
| `frozen_matb_keeper.js` | **ACTIVE, likely redundant** | duplicates WORK_FORCE_ROTATE, which `checkUpkeep` DOES discover (`_isFrozenMatB` scan, :465) and `direct_keeper` executes at :05 — four minutes before this runs at :09. Owner's own crontab note: "on-chain also does this — watching for redundancy". |

## The design's own test gate

`MatrixKeeper.sol:455`, above the FORCE_ROTATE scan:

> "Backstop only: V8.44 contract-driven flow keeps MatBs churning; if this ever
> fires regularly, the routing design has failed (test gate: **keepers OFF ->
> rotationCount must still climb**)."

That is a falsifiable acceptance criterion the protocol sets for itself, and it
has never been run. It is also the cleanest possible answer to "how much of the
automation is really necessary". Proposed: after the V8.48 `rescueReentry` fix,
stop ALL keepers for a measured window and record which rotation counts keep
climbing. Whatever stalls is genuinely keeper-dependent; whatever keeps moving
is a keeper we are paying for without needing.

## Open items to close this audit

1. **Is `frozen_matb_keeper` doing anything?** Check whether its log shows real
   work or always-nothing (on-chain gets there at :05, it runs at :09):
   `grep -c "rotated\|forced\|OK" /root/keeper/frozen_matb.log`
2. **Is Chainlink CRE registered as an `upkeepCaller`?** If yes, `direct_keeper`
   is a fallback, not a dependency.
3. **Are WorkItemFailed events firing?** If `performUpkeep` is silently failing
   items, the off-chain scripts are masking it:
   scan `WorkItemFailed(uint8,uint8,address,address)` on MatrixKeeper.
4. **Run the keepers-OFF gate** after V8.48.

## Scope note

This audit covers automation-vs-contract only. **A systematic contract audit has
NOT been done.** Backlog sections 4, 7, 8, 9 and 10 were all found incidentally
while chasing copy claims and member tickets — including section 10 (254 frozen
members), which surfaced from an owner observation, not from any audit pass.
