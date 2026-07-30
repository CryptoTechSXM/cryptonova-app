# V8.46 — PLAN

Status board. Update as items land. Written 2026-07-29 after the access-control
audit; supersedes the scattered V8.46 notes in CLAUDE.md, which stay as the
evidence trail.

---

## Scope, in priority order

| # | Item | State | Why it ranks here |
|---|------|-------|-------------------|
| **1** | `performUpkeep` allowlist + `_doEvictParked` idle gate | **BUILT, GREEN** | The only hole a stranger can use *on someone else* |
| **2** | `register` / `registerWithCoupon` → router-only | **BUILT, GREEN** | 6 live bypasses measured; frontend half already shipped |
| **3** | B — cascade depth cap | **BUILT, GREEN** | Members are hitting the gas ceiling in production |
| **4** | Pair guard (duplicate seats) | **BUILT, GREEN** | 415 tests pass; prevention + containment |
| **5** | `bulkUpgrade` fee/seating loop mismatch | **NOT BUILT** | Latent overcharge; must ship WITH the skip fix |
| **6** | Clear stale `parkedAt` on any successful seating | **NOT BUILT** | Counter-integrity: inflates parked count (7,405 vs 2,762 real); pairs with #9 |
| **7** | Rescue debt can never repay once the member leaves | **NOT BUILT** | Members carry debt forever while holding the funds to clear it |
| **8** | Entering a tier where you hold commission destroys the balance | **BUILT, GREEN** | **The only item that can DELETE member funds. Ship before the funded push.** |
| **9** | Epoch MEMBER trigger counts seat-events, not people | **BUILT, GREEN** | Figure-8 loop inflated epoch pacing; corrupts the halving/tokenomics before mainnet |

**Numbering is chronological, not severity order.** By severity the running order is
**8, 1, 2, 9, 6, 3, 4, 7, 5** — item 8 was found last (2026-07-29 21:30 EDT) and is the
only one where a member can lose money they already own, with no action by anyone
else and no way to recover the value from state afterwards. Item 1 stays second
because it is the only hole a stranger can use *on someone else*.

**Items 9 and 6 are a counter-integrity cluster — bumped 2026-07-30.** Both make
counters lie about members: #9 counts seat-events as epoch "members" (8,330 vs
2,762 real), #6 leaves stale `parkedAt` so parked count reads 7,405 vs 2,762 real.
Both cheap, both self-contained, ship together. NOTE (measured 2026-07-30): #6 is
NOT a steady-state rescue-throttle — a 120-tx live sample of keeper 0xd419681B
showed 0% revert, ~12 successful rescues/min. The revert-waste is real only in the
burst right after a keeper outage; the standing damage is the inflated count, not
lost rescues. Rank #6 for data integrity, not throughput.

**If V8.46 has to ship partially, ship 8 and 1.**

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

### BUILT 2026-07-30 — `test/V8_46_KeeperAuth.test.js` (4/4 GREEN)

- **Allowlist:** new `mapping(address=>bool) public upkeepCaller` + `setUpkeepCaller(addr,bool)` (onlyOwnerOrGovernance) + guard at top of `performUpkeep`: `owner() || governance || upkeepCaller[msg.sender]`. Tests: stranger reverts `MK: not authorized keeper`; owner + allowlisted EOA pass; de-allowlist re-blocks; setter is owner/gov-only.
- **Idle gate:** `_doEvictParked` now requires `rotationCount()>0` AND `block.timestamp - parkedAt(member) >= extendedIdleTimeout` (7d), mirroring `_doReclaimSlot`. Tests: fresh park not evicted, evicted after 7d, never-rotated not evicted. Mock: `contracts/test/MockEvictMatrix.sol`.
- **Interaction noted:** `_doEvictParked` is also called by `_doParkedRescue`'s zero-balance cleanup — the gate now gives a provably-unpayable member a 7-day grace before eviction instead of immediate. That path returns without advancing SF funds, so no drain in the interim; benign.

**DEPLOY-CHECKLIST ADDITION (mandatory):** locking `performUpkeep` means the DigitalOcean keeper EOA `0xd419681BA72992636f05e256168681c939826B4b` MUST be allowlisted immediately after deploy (`keeper.setUpkeepCaller(0xd419681B..., true)`) or all keeper work halts. Chainlink registry can be left off (that upkeep is being cancelled).

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

### BUILT 2026-07-30 — full suite 424 passing, 0 regressions

- **2a:** `FigureEightMatrixV8.register(address)` DELETED (commit cd28ac6). It was the measured bypass (selector `0x4420e486`, 6 txs / 8 seats / ~$20k). No contract or V8 test used it — legit entry is `TierRouter.register -> PairManager.registerFor -> enterFor` (pairManager-guarded). Bonus: freed factory bytecode, headroom 112 -> 423.
- **2b:** `FigureEightMatrixV8.registerWithCoupon(address,bytes32)` DELETED. Same bypass class (needs a paid coupon, so weaker, but still skips TierRouter progression). Legit coupon path is `TierRouter.registerWithCoupon -> enterWithCouponFrom` (router-guarded, kept). `Coupon.test.js`'s 19 direct calls rerouted through a `couponEnter` helper that calls `enterWithCouponFrom` as an authorized `router` signer; all 35 coupon tests green.

**FRONTEND DEPLOY DEPENDENCY (must ship with V8.46 frontend):** `doLimboReEntry()` (index.html) calls `matA.register(referrer)` — now DELETED, so that button will revert on V8.46. Since V8.33 `softParkIdle` PARKS reclaimed members (sets `parkedAt`, auto-rescued by the keeper), the parkedAt==0 "limbo" state can't occur on a fresh deploy — so replace the `matA.register()` call with `selfRescue()` (or remove the button). NOT a contract task; tracked for the frontend sync.

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

**Primary impact is data integrity, not rescue throughput (measured 2026-07-30).**
Parked count reads **7,405** against **2,762** real members — impossible for people,
because stale entries count parked POSITIONS across tiers and never clear. A live
120-tx sample of the keeper showed **0% revert / ~12 successful rescues per minute**,
so the "wasted attempts" cost is real only in post-outage bursts, not steady state.
Fix = clear `parkedAt` unconditionally on any successful seating. Same
"counter lies about members" class as item 9 — ship the two together. Frontend must
also stop reporting parked POSITIONS as parked MEMBERS.

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

## 8. Entering a tier where you already hold commission DESTROYS the balance

**Status: BUILT, GREEN (2026-07-29). Highest severity found that day — this one
can delete member funds, and it is live on V8.45 right now.**

**Verified in BOTH directions, which is the only way this test file is worth
anything.** Against the fix: 5/5 pass, and the full suite is **420 passing / 0
failing** (415 before, so no regression on a path every other suite exercises).
Against V8.45 with the library checked out from `HEAD~1`: **C1 $0.25 vs a $0.95
floor, C2 $0.00 vs $0.95, C3 $0.25 vs $0.95 — all three fail, C4/C5 still pass.**
C2 reproducing `totalWithdrawn == 0` is the exact on-chain signature read from
T3.1 MatA, so the fixture is faithful rather than merely plausible.

Sizes after the fix: `MatrixPairFactory` **24,464 / 112 headroom — unchanged**,
`TierRouter` 24,456 / 120 untouched. Confirms the library-linking claim: the fix
costs the two size-constrained contracts nothing. Ranks above items 5 and 6, and arguably
above everything except item 1.

`MatrixLogicLib._register` builds a fresh struct whenever `hasEverJoined` is false:

```solidity
if (!self.members[member].hasEverJoined) {          // :313
    self.totalJoined += 1;
    address l1; /* … cross-pair referrer resolution … */
    self.members[member] = Member({
        id:              self.totalJoined,
        referrer:        l1,
        joinedAt:        block.timestamp,
        withdrawable:    0,          // <-- DESTROYS AN EXISTING BALANCE
        totalEarned:     0,
        totalWithdrawn:  0,          // <-- DESTROYS WITHDRAWAL HISTORY
        cyclesCompleted: 0,
        isInMatrix:      false,
        hasEverJoined:   true,
        crossingReserve: 0
    });
}
```

The assumption is that `!hasEverJoined` means "no record exists yet". **It does
not.** Two other code paths write to a member's record without ever setting that
flag:

1. **`_credit` (:928)** adds to `withdrawable` and `totalEarned` directly.
   Referral commission is credited into the matrix where **your DOWNLINE**
   entered (`_distributePayments` → `_credit`), so every upline accumulates real
   balances in tiers they have never occupied. `hasEverJoined` stays false.
2. **`withdrawCore` (:948)** gates on `require(available > 0)`, never on
   membership, so a commission-only holder *can* withdraw — which increments
   `totalWithdrawn` (:996) while `hasEverJoined` remains false.

So the flag does not mean "no record"; it means "never took a seat here". The
moment such a member finally enters that tier, the initialiser runs and their
balance, their earnings and their withdrawal history are all overwritten with
zero. The USDC stays in the matrix contract as unattributed surplus — the member
simply no longer has a claim to it.

### Measured on 0xe8Ad7bbA (2026-07-29)

The owner reported "withdrew $1k twice but Total Withdrawn is wrong". Reconciling
USDC inflows against the ledgers (`wallet_inflow.js`) gave **$1,970.00 received =
$2,000.00 gross × 0.985**, against a stored total of **$1,947.50** — short exactly
**$52.50**. Sixteen payouts, fifteen reconciled to the cent; one did not:

| | |
|---|---|
| tx | `0xb11eee5801310dc5b1ce2b6df595e0ecb094f19d36a0ed2e6a56cff1e493fb27` |
| matrix | T3.1 MatA `0x827B8f8D316919aAC3BB1f5D75A7351D1fA32828` |
| call | `withdrawPartial(uint256)` selector `0x1211540c`, arg **$52.50** |
| events | `WithdrawalFeeCharged $0.79` **and** `EarningsWithdrawn $51.71`, status SUCCESS |
| withdrawal block | 44796516 (~21:40 UTC) |
| **`joinedAt` now** | **1785367802 = 23:30:02 UTC — nearly two hours LATER** |
| record now | `id 1136`, `isInMatrix true`, pos 104, `totalWithdrawn $0.00`, `totalEarned $1.25` |

`withdrawCore` demonstrably ran and demonstrably incremented the counter; the
seat taken at 23:30 zeroed it. T3.1 MatA was the only one of the sixteen the
member subsequently entered for real, which is exactly why it was the only one
affected.

**The owner escaped fund loss only by luck of ordering** — he had already
withdrawn, so `withdrawable` was $0 when the reset landed. Had he entered T3
first, the $52.50 would have been *deleted rather than merely unrecorded*.

### Fix

Field-wise update instead of a fresh struct. Preserves anything `_credit` or a
prior withdrawal already wrote:

```solidity
if (!self.members[member].hasEverJoined) {
    self.totalJoined += 1;
    address l1;
    /* … cross-pair referrer resolution unchanged … */

    // V8.46: UPDATE THE EXISTING RECORD, NEVER REPLACE IT.
    // `!hasEverJoined` means "never took a seat here", NOT "no record exists".
    // _credit(:928) writes withdrawable/totalEarned for a member who has never
    // joined this matrix, and withdrawCore gates on `withdrawable > 0` rather
    // than on membership, so such a holder can also have totalWithdrawn > 0.
    // Constructing a new Member here destroyed live balances and history.
    // Measured 2026-07-29 on 0xe8Ad7bbA: $52.50 of history erased in T3.1 MatA.
    Member storage mm = self.members[member];
    mm.id            = self.totalJoined;
    if (mm.referrer == address(0)) mm.referrer = l1;
    mm.joinedAt      = block.timestamp;
    mm.hasEverJoined = true;
    mm.isInMatrix    = false;   // the seat is taken further down this function
    // DELIBERATELY UNTOUCHED: withdrawable, totalEarned, totalWithdrawn,
    // cyclesCompleted, crossingReserve. Each is already 0 for a genuinely new
    // member, and each must be PRESERVED for a commission-only holder.
}
```

Notes:

- **`referrer` is guarded, not overwritten.** A commission-only holder has
  `referrer == address(0)` (the struct was never built), so the cross-pair
  resolution still applies on first real entry — but an existing referrer is
  never rewritten.
- **Contract size is not a concern.** This is in `MatrixLogicLib`, which is
  LINKED rather than embedded, so it costs `MatrixPairFactory` nothing. Field-wise
  writes should be marginally smaller than the struct construction. Run
  `scripts/sizes.js` anyway.
- **`isInMatrix = false` is retained deliberately.** A re-entering commission
  holder must not inherit a stale true from any earlier path.

### Tests — `test/V8_46_CreditPreservation.test.js` (WRITTEN, 5/5 GREEN)

- **C1** — downline entry credits an upline who has never joined that matrix;
  assert `withdrawable > 0` and `hasEverJoined == false`. Then the upline
  registers there. **Assert `withdrawable` is unchanged.** This is the fund-loss
  case and it fails on V8.45.
- **C2** — same setup, but the upline withdraws first, then registers. Assert
  `totalWithdrawn` survives. This is the measured 0xe8Ad7bbA case.
- **C3** — `totalEarned` survives the same transition.
- **C4** — a genuinely new member (no prior credit) still gets `id` assigned,
  `joinedAt` set, `hasEverJoined` true and zeros everywhere else. Guards against
  the fix breaking normal registration.
- **C5** — SHIPPED AS: the referrer guard still resolves an upline on first real
  entry. Retargeted deliberately during the build. The original C5 (crossingReserve
  survival) was worth less than testing the risk the FIX ITSELF introduces: the old
  code assigned `referrer: l1` unconditionally, the new code writes it only when the
  slot is empty. A commission-only holder has `referrer == address(0)` because the
  struct was never built, so if that guard were wrong they would enter with NO
  upline and lose their whole chain-pay position — a worse bug than the one being
  fixed. C5 now asserts the guard lets the legitimate first write through.

**Two assertions had to be corrected during the build, and both corrections
matter:** C1 and C3 originally used `equal` and failed against the FIXED code at
$1.20 vs $0.95. Taking a seat legitimately EARNS — the entrant picks up a pool
share from their own entry. The claim under test is that the pre-existing credit
was not destroyed, so the assertion is `gte` with the prior balance as the floor.
That still fails on V8.45 ($0.25), so nothing was weakened. The fixture also had
to call `setGlobalJoined(W1)`: without it `l1` resolved to `address(0)` for every
entrant and every referrer assertion was vacuous — a green test proving nothing.

### Exposure — who is at risk right now

Anyone with `hasEverJoined == false && withdrawable > 0` in any matrix loses that
balance the moment they enter that tier. Since `_credit` targets uplines, the
population is "every member whose direct went higher than they did" — most
leaders on this testnet.

**This matters for Thursday/Friday.** The plan is $30K/day of test funds and a
full deploy Friday, i.e. a lot of members entering a lot of new tiers. Every one
of those entries is a chance to wipe a commission balance.

Mitigations, in order of preference:

1. Ship item 8 in V8.46 before the funded push. Cheapest and complete.
2. If V8.46 slips, tell members holding commission in un-joined tiers to
   **withdraw before upgrading**. A withdrawn balance cannot be erased — only the
   (recoverable) history is lost.
3. Detector to build: `credit_at_risk.js` — for every known member, every matrix,
   report `hasEverJoined == false && withdrawable > 0`, sorted by amount. Run it
   on the VPS; at ~726 members × ~30 matrices it is too many reads for the free
   public endpoint interactively.

**Already-destroyed values are NOT recoverable from state** — they were
overwritten. They can be reconstructed from logs where needed: sum
`EarningsWithdrawn` for `totalWithdrawn`, and the credit events for `totalEarned`.
No member is owed USDC as a result of the history loss on 0xe8Ad7bbA, because the
money had already been paid out before the reset.

## 9. Epoch MEMBER trigger counts seat-events, not unique members

`CNOVAToken.mintReward()` ran `epochMemberCount += 1` on EVERY call
(CNOVAToken.sol). But `mintReward` is called from `MatrixLogicLib.enterMatrix` —
the single seat routine every action funnels through: registration, tier upgrade,
crossing to Matrix B, re-entry after cycle-out, rescue re-seat. So the counter
documented as "unique registrations" actually counted SEAT EVENTS, and the figure-8
self-sustaining loop ticked it several times per member per lap.

### Measured on V8.45 (2026-07-30, live chain read)
- `epochMemberCount` = **8,330** in epoch 9 alone vs **2,762** total unique members
  ever — impossible for people, proof it was not counting them.
- 54,537 system cycles vs 2,762 members (~20x) — the re-entry/rotation volume.
- Epoch forensics: epochs 2-4 fired on MINT, 5-9 on MEMBER — every advance driven
  by the loop, not real growth. Genesis->Final Frontier in ~4d8h under stress-keeper
  volume; `epochMemberLimit` never lowered (still 10,000), no `forceAdvanceEpoch`.

### Why it matters
With this bug the loop races the epoch counter through the high-reward epochs
(50 -> 40 -> 20 CNOVA) in days, silently breaking the "early adopters earn most"
halving tokenomics. Cosmetic on testnet, launch-blocker for mainnet.

### BUILT 2026-07-30 — `test/V8_46_EpochMemberCount.test.js` (3/3 GREEN, full suite 427 passing)
`CNOVAToken.sol`: added `mapping(address=>bool) public countedMember` (LIFETIME,
never reset per epoch) and gated the increment:
```solidity
if (!countedMember[to]) { countedMember[to] = true; epochMemberCount += 1; }
```
Gate lives in the token, so all tiers/pairs/re-entry paths are fixed at once.
Tests: (1) three members re-seated 15x total keep count at 3; (2) one member
re-minted 10x never advances the MEMBER trigger, four DISTINCT people do;
(3) a member counted in epoch 0 is not recounted after advancing to epoch 1.
Existing 5c epoch test unaffected (it uses distinct members).

### Not in scope (separate dial, not a bug)
The MINT trigger (1,000,000 CNOVA/epoch) is also loop-accelerated but tracks real
token issuance backed by the treasury floor; tune via governable `epochMintLimit`
if longer epochs are wanted. Decide separately from this correctness fix.

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

- [ ] **Item 2:** frontend `doLimboReEntry()` no longer calls the deleted `matA.register()` (use `selfRescue()` or remove the button)
- [ ] **Item 1:** `setUpkeepCaller(0xd419681B..., true)` on the new MatrixKeeper immediately post-deploy (else keepers halt)

- [ ] Full suite green on Windows against real config
- [ ] `scripts/sizes.js` — both TierRouter and MatrixPairFactory under 24,576
- [ ] `node integrity_check.js` = INTEGRITY OK
- [ ] Frontend shipped with it: `friendlyError` cases for any new custom errors,
      and a router-side replacement for `doLimboReEntry`
- [ ] `bypass_scan_full.js` re-run post-deploy — must report 0 with the
      `TARGET=` self-test still passing against a historical positive
