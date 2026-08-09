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
| 11 | **selfRescue / coPayRescue surplus loss** — `crossingReserve` and `withdrawable` are zeroed UNCONDITIONALLY while `_finalizeCrossing` forwards only `entryFee`. Surplus is erased. Must credit the excess back to `withdrawable`. | MatrixLogicLib :1265-66 | NEW, verified 2026-08-09 |
| 12 | `checkUpkeep` must DISCOVER WORK_PARKED_RESCUE, WORK_EVICT_PARKED (and GHOST/RECLAIM). Executable today but undiscoverable — retires 3 keepers. | MatrixKeeper | AUTOMATION_AUDIT.md |
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
| 17 | DELETE `route_rr.js` — it existed to mask #10 |
| 18 | Trim `frozen_matb_keeper.js` — duplicates WORK_FORCE_ROTATE (pending log check) |
| 19 | Retire `copay_rescue` / `fastlane_rescue` / `evict_parked` once #12 lands |
| 20 | Run the protocol's own gate: **keepers OFF -> rotationCount must still climb** (MatrixKeeper.sol:455) |

## Frontend (ships with, not after)

| # | change |
|---|---|
| 21 | Disable "Unlock early" / "Max Unlock" when `balanceOf < penaltyAmt` — currently offers an action that always reverts (§8) |
| 22 | Remove the interim self-rescue surplus warning once #11 ships |
| 23 | Restore the exit-penalty ladder copy once #7 makes it real |

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
| CNOVAToken | 12,878 | 11,698 | 4, 8, 9 | clear |
| CNOVATreasury | not measured | — | 5 | **measure before editing** |
| CNOVADirectSale | not measured | — | 6 | **measure before editing** |

Three of the ten contracts in this release are within 600 bytes of the limit,
and two of the three carry scope items. That is the single largest schedule
risk in V8.48 — bigger than any individual defect.

`scripts/sizes.js` WATCH list was itself incomplete: it omitted CNOVATreasury
and CNOVADirectSale, both of which V8.48 modifies (items 5 and 6). Extended
8 -> 16 contracts. Re-run to fill the two "not measured" rows before item 4/5/6
work begins.

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
2. **#10 rescueReentry** — the live defect; smallest change, proven template.
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
