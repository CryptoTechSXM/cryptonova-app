# V8.46 — PLAN

Status board. Update as items land. Written 2026-07-29 after the access-control
audit; supersedes the scattered V8.46 notes in CLAUDE.md, which stay as the
evidence trail.

---

## Scope, in priority order

| # | Item | State | Why it ranks here |
|---|------|-------|-------------------|
| **1** | `performUpkeep` allowlist + `_doEvictParked` idle gate | **NOT BUILT** | The only hole a stranger can use *on someone else* |
| **2** | `register` / `registerWithCoupon` → router-only | **NOT BUILT** | 6 live bypasses measured; frontend half already shipped |
| **3** | B — cascade depth cap | **BUILT, GREEN** | Members are hitting the gas ceiling in production |
| **4** | Pair guard (duplicate seats) | **BUILT, GREEN** | 415 tests pass; prevention + containment |
| **5** | `bulkUpgrade` fee/seating loop mismatch | **NOT BUILT** | Latent overcharge; must ship WITH the skip fix |
| **6** | Clear stale `parkedAt` on any successful seating | **NOT BUILT** | Cheap; stops the copay keeper wasting attempts |
| **7** | Rescue debt can never repay once the member leaves | **NOT BUILT** | Members carry debt forever while holding the funds to clear it |

---

## 1. performUpkeep is open to the world — and eviction is a weapon

`MatrixKeeper.performUpkeep(bytes calldata) external` (:532) has **no access
control**. Anyone can `abi.encode` a `WorkItem[]` and drive the whole queue.

Most work items are saved by their own preconditions:

| Work item | Guard | Safe? |
|-----------|-------|-------|
| `_doReclaimSlot` | `rotationCount > 0`, `isInMatrix`, `idle >= extendedIdleTimeout` (7d) | yes |
| `_doForceRotate` | `_isFrozenMatB(matB)` | yes |
| `_doGhostEntry` | `ghostEntryEnabled` — off by default | yes |
| `_doVelocityCheck` | recomputed from chain state | yes |
| **`_doEvictParked`** | **`parkedAt != 0` and nothing else** | **NO** |

### Why eviction is the serious one

```
anyone → performUpkeep(crafted)      no guard
       → this._doEvictParkedExternal()   onlySelf — satisfied, we ARE `this`
       → _doEvictParked()                only checks parkedAt != 0
       → matrix.evictParked()            onlyKeeper — satisfied, caller IS the keeper
```

The matrix-level `onlyKeeper` looks protective and is not: MatrixKeeper is the
keeper, so anything that can drive MatrixKeeper inherits its authority.

`MatrixLogicLib.evictParked` (:1273) **does not move funds**. It calls
`_removeFromParkedQueue`, which zeroes `parkedAt`. And:

- `selfRescue` requires `parkedAt > 0` (:1185)
- `coPayRescue` requires `parkedAt > 0` (:1148)

**So an evicted member cannot re-enter, by either route.** The rescue keeper no
longer sees them (off the queue) and they cannot rescue themselves. Their
`withdrawable` and `crossingReserve` survive and can still be withdrawn — the
money is safe, the position is not. Cost to the attacker: gas. Testnet carries
~30 parked members at any moment; all of them could be locked out in one call.

### Fix

```solidity
// MatrixKeeper
mapping(address => bool) public upkeepCaller;   // owner-managed

function performUpkeep(bytes calldata performData) external {
    require(
        upkeepCaller[msg.sender] || msg.sender == owner() || msg.sender == governance,
        "MK: not authorized"
    );
    ...
}

// and give eviction the gate reclaim already has
function _doEvictParked(address matrix, address member) internal {
    IFigureEightKeeper mat = IFigureEightKeeper(matrix);
    uint256 pAt = mat.parkedAt(member);
    if (pAt == 0) return;
    if (block.timestamp - pAt < extendedIdleTimeout) return;   // <-- NEW
    ...
}
```

Seed `upkeepCaller` with the DigitalOcean keeper EOAs at deploy. Add the
Chainlink forwarder only if Chainlink is kept — see the operational note below.

**Tests to write:** an unauthorised `performUpkeep` reverts; an authorised one
still processes every work type; eviction is a no-op before the timeout and
succeeds after it; an evicted member can still `withdraw`.

---

## 2. `register` / `registerWithCoupon` must be router-only

`FigureEightMatrixV8.register(address)` (:396) and `registerWithCoupon` (:409)
are `external` with no guard. Anyone holding the fee can seat themselves in ANY
tier's matrix, bypassing TierRouter entirely:

- `memberHighestTier` never advances
- `_checkTierFirstEntry` never runs → whale-gate milestones uncounted
- `_upgradeEligible` never consulted → no tier progression required

### Measured, not theorised

`bypass_scan_full.js` over the full V8.45 history (25,306 seatings into T2–T10):
**6 transactions, 8 seats, ~$20,025**, blocks 44752308–44781263. Members
0x1e8e2dcf, 0x5816e46a, 0x536685f0, 0x0f509981, 0xd6fbdf7a, 0x0af85760,
0x1acc0225, 0x84a4d33a.

Nobody exploited anything — **our own dashboard invited them.** The limbo panel
had no history test and offered "your slot was cleared, pay to re-enter" for any
tier where the member merely held referral credit. Frontend fixed 2026-07-29
(commit 77c26ed). Whale gates are unharmed: uncounted entries make a gate open
LATE, never early.

### Fix

`_onlyTierRouter()` already exists (FigureEightMatrixV8:195) and is used in five
places, so the guard costs no new revert string — which matters because
`MatrixPairFactory` embeds this contract's creation code and has ~112 bytes of
EIP-170 headroom.

**But do not just bolt the guard on.** Both bodies assume `msg.sender` IS the
member; with the guard, `msg.sender` becomes the router. Delete them and route
through the router's existing equivalents — `routerCouponEntry` (:419) is the
model that already does this correctly.

**Frontend dependency:** `doLimboReEntry` calls `matA.register(referrer)`
directly and needs a router-side replacement, or confirmation the path is dead
(it only fires after `MatrixKeeper._doReclaimSlot`, which needs the 7-day timer).

---

## 3. B — cascade depth cap (BUILT)

Threaded depth counter in transient storage; `_executeAdditive` stops after
`maxCascadeDepth` links and parks instead. `setMaxCascadeDepth` is owner-guarded.
Tests `V8_46_DepthCap.test.js` D1/D1b/D2/D3 green via `MockNestingPM`.

### Production evidence (2026-07-28/29)

| Measured | Action | Gas |
|----------|--------|-----|
| owner's wallet | `selfRescue` | 17,762,199 |
| `0x1acc0225` | T1→T2 bulk | 19,111,664 |
| `0xe8Ad7bbA` | T2→T3 manual | 19,171,785 |
| `0xe8Ad7bbA` | T2 `selfRescue` | 20,252,946 |

Against a ~17.8M per-tx cap. **Rising as tiers deepen**, and members are already
locked out of re-entry. `gas_probe` on `0xdE5fe7cB` showed T2→T3 at 14,903,722
in the *quiet* mode — 99.4% of our 15M refusal line, with 660k of headroom after
wallet padding.

Cost is **bimodal**: ~12.9M when the entry takes a seat, ~19M when it fills MatA
and triggers the rotation. Keeper wallets do the same move for 1.9M because they
are fresh — depth is a function of accrued wealth in the chain, not of the tier.

---

## 4. Pair guard — duplicate seats (BUILT)

Prevention at `MatrixLogicLib.enterMatrix` (the one chokepoint), containment in
`_cycleOutRoot` (park instead of letting the revert kill a stranger's tx), and
`freePairFor` sending the double seat to a DIFFERENT pair. 415 tests green.
Sizes: TierRouter 24,541 (35 spare) · MatrixPairFactory 24,464 (112).
**Run `scripts/sizes.js` after every edit** — the factory embeds the matrix's
creation code, so a matrix change silently inflates it.

---

## 5. `bulkUpgrade` fee loop vs seating loop (NOT BUILT)

The fee loop (:976-980) sums EVERY tier from `startIdx` to target; the seating
loop (:984-989) `continue`s past tiers the member already holds. The member is
charged for a tier they are not seated in. Latent today because the skip never
fires — **becomes a live overcharge the moment the skip is fixed. Both must ship
together.**

---

## 6. Clear stale `parkedAt` on any successful seating (NOT BUILT)

`_removeFromParkedQueue` (:1198) only clears `parkedAt` when the member is FOUND
in the `parkedMembers` array, so a re-seating path that misses it leaves the
timestamp set. Members read as seated AND parked simultaneously. Harmless to the
member (`selfRescue` also checks `!isInMatrix`) but the copay keeper wastes
attempts rescuing seated members, failing with "still in matrix" — swallowed at
MatrixKeeper:558. **The reliable test everywhere else is
`parkedAt > 0 && !isActiveInMatrix`.**

---

## 7. Rescue debt has no repayment path once the member leaves that matrix

Reported on the community call as *"Sherwyn's $1.68 loan not repaying despite
multiple Tier 1 rotations"*. It is not a rate problem and not a keeper problem —
there is no event left that can trigger repayment.

`rescueDebt` is **per-matrix** (`MatrixLogicLib:115`) and clears exactly two ways:

| Path | Site | Gate |
|------|------|------|
| Gradual, from a pool share | `_settlePool:450` | `if (share == 0) return;` sits ABOVE the debt block |
| At cycle-out, from withdrawable | `_cycleOutRoot:548` | needs `withdrawable > 0` at that instant |

Both require the member to be **active in that specific matrix**. A member who
has moved on earns no pool share there and will never cycle out of it again, so
the debt is frozen. Rotating anywhere else does nothing — the debt is not theirs
globally, it belongs to a matrix they have left.

`rescueRepayBps` is **10,000 (100%)**, so the whole of any pool share would go to
the debt. The rate is not the problem; there is simply no share.

### Measured on 0xe8Ad7bbA (2026-07-29, `member_ledger.js`)

```
T1.1 MatA   $2.07 owed · $1.00 withdrawable here · not seated
T2.1 MatA   $2.75 owed · $35.00 withdrawable here · not seated
```

**And this is the sharp part: `withdrawCore` never looks at `rescueDebt`.** This
member can withdraw the $35.00 sitting in T2.1 MatA while the $2.75 owed *in that
same matrix* stays outstanding. The funds to clear the debt are in the same place
as the debt, and the withdrawal path walks straight past them.

### Fix

One deduction in `withdrawCore`, after `_settlePool` has brought the balance
current and before the payout:

```solidity
// after _settlePool(self, cfg, member), before computing `amt`
uint256 debt = self.rescueDebt[member];
if (debt > 0 && self.stabilityFund != address(0) && available > 0) {
    uint256 repay = available >= debt ? debt : available;
    self.rescueDebt[member] -= repay;
    available               -= repay;
    SafeERC20.forceApprove(cfg.usdc, self.stabilityFund, repay);
    try IStabilityFund(self.stabilityFund).receiveDebtRepayment(repay) {} catch {}
    emit RescueDebtRepaid(member, repay, self.rescueDebt[member]);
}
```

Matches the design intent — a soft loan repaid from earnings — and guarantees
repayment on the one action a member with a stranded debt WILL still take. No new
state, no new event, and the existing `try/catch` policy around the SF is kept so
an SF failure can never block a withdrawal.

**Frontend note:** the member should be told. A withdrawal that quietly returns
less than the quoted figure is the same class of problem as the $10 lock. Show
the deduction: *"$35.00 available − $2.75 rescue loan repaid = $32.25 to your
wallet."*

**Tests:** debt clears on a withdrawal large enough to cover it; a partial
withdrawal repays what it can and leaves the remainder; a withdrawal with zero
debt is unchanged; an SF that reverts does not block the payout.

**Not in scope:** making debt follow a member across matrices. That would need a
router-level ledger and is a bigger design change — worth discussing for mainnet,
but item 7 above removes the practical harm.

---

## Operational, not contract

**Cancel the Chainlink upkeep.** Registry `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`
drove 63 seatings in 11 days while the DigitalOcean keepers drove 18 direct
`performUpkeep` calls — two systems on one queue, and LINK burning for the
privilege. Cancel at automation.chain.link.

**This is housekeeping, not security.** `performUpkeep` is open to anyone, so
removing the registry removes one caller out of infinitely many. Item 1 is the
security fix.

---

## Deploy gates

- [ ] Full suite green on Windows against real config
- [ ] `scripts/sizes.js` — both TierRouter and MatrixPairFactory under 24,576
- [ ] `node integrity_check.js` = INTEGRITY OK
- [ ] Frontend shipped with it: `friendlyError` cases for any new custom errors,
      and a router-side replacement for `doLimboReEntry`
- [ ] `bypass_scan_full.js` re-run post-deploy — must report 0 with the
      `TARGET=` self-test still passing against a historical positive
