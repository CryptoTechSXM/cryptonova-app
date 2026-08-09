# AUTOMATION vs CODE AUDIT — 2026-08-09

Question asked: **can any of the automations be done by the smart contract
instead?** Method: enumerate the live crontab, map each job to the on-chain
work surface, and classify. Every claim below is from source, not inference.

## The central finding

`MatrixKeeper` defines **10 work types**. `performUpkeep` can execute all 10.
`checkUpkeep` can only DISCOVER **6**:

| work type | executable | discoverable |
|---|---|---|
| WORK_VELOCITY (0)      | yes | yes |
| WORK_GHOST (1)         | yes | **NO** |
| WORK_RECLAIM (2)       | yes | **NO** |
| WORK_CHAIN_LINK (3)    | yes | yes |
| WORK_PARKED_RESCUE (4) | yes | **NO** |
| WORK_VELOCITY_GATE (5) | yes | yes |
| WORK_EVICT_PARKED (6)  | yes | **NO** |
| WORK_DISTRIBUTE_CW (7) | yes | yes |
| WORK_FORCE_ROTATE (8)  | yes | yes |
| WORK_ADVANCE_EPOCH (9) | yes | yes |

**The contract can DO parked-rescue, eviction, ghost cleanup and reclaim — but
it cannot FIND them.** Something off-chain must enumerate the work and pass it
in `performData`. That is the single reason those keepers exist, and it is the
one change that would let them be retired.

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
