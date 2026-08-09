# V8.48 — CONTRACT BACKLOG

Items discovered live on V8.47 that need a REDEPLOY to fix. Frontend already
compensates for both (index.html `_claimableAll`, 2026-08-07) — no member harm
meanwhile — but the chain should agree with itself at the next version.

## 1. freeWithdrawable() view disagrees with withdrawCore (the enforcement)

Found 2026-08-07 (Sherwyn ticket ea89ba8 + owner's Nova Rise / Nova Core
screenshots). The VIEW pre-dates two rules that live only in withdrawCore:

- **V8.32 opt-out missing**: `freeWithdrawable` (FigureEightMatrixV8:623)
  subtracts the seated crossing hold (`ENTRY_FEE − crossingReserve`)
  UNCONDITIONALLY, but `withdrawCore` (MatrixLogicLib:992) enforces it ONLY
  while the automation reserve is active on that matrix
  (`automationReserve > 0`). A member with all automation off can withdraw
  freely, yet the view under-reports.
- **Reserve netting asymmetry**: the view subtracts `reservedFor` on the
  highest-tier matrix — correct — but every UI that then subtracted the
  reserve AGAIN on top of the view double-counted it. A `reservedHeldFor()`
  getter (see item 2) removes the temptation.
- **V8.47 debt not reflected**: withdrawCore repays `SF.memberDebtOf(member)`
  FIRST out of any withdrawal; no view exposes "net after debt".

**Fix**: make the view a line-for-line mirror of withdrawCore (or extract one
shared internal both call), and consider a `netClaimableOf(member)` convenience
view = what a full withdrawal would actually pay before the withdrawal fee.

**ON-CHAIN CONSEQUENCE (found 2026-08-08)**: the contract itself consumes the
broken view — `hybridUpgrade` draws earnings via `_drawFreeEarnings` →
`TierRouterLib.drawFreeEarnings` → `freeWithdrawable()` (TierRouter:973). The
under-report means hybrid upgrades draw LESS from earnings and pull MORE from
the member's wallet than withdrawCore would actually allow. Fixing the view
fixes this automatically — one fix, two effects.

## 2. Automation reserve only binds the highest tier — automation can be left underfunded

`withdrawCore` applies `reservedFor` ONLY where `(memberHighestTier − 1) ==
tierIndex`. Lower-tier balances are withdrawable in full, so a member can
drain T1..T(n−1) and leave the reserve target mostly unfunded (live example
2026-08-07: target $450, actually held $32.40). Consequences are soft — the
V8.47 upgrade gate no-ops when short and auto re-entry waits for new earnings
— but "reserved" promises more than the chain holds.

**Decide one of**:
- (a) bind the reserve across ALL tiers' withdrawals (waterfall: hold up to
  `reservedFor` across matrices, highest tier first), or
- (b) keep best-effort semantics and add an on-chain `reservedHeldFor(member)`
  getter (what is actually held now) so UIs never have to reconstruct it.

Frontend currently reconstructs (b) client-side (`_claimableAll.heldNow`) and
words the badge as "Reserve target $X · $Y held from current earnings".

## 3. bulkWithdraw(uint256 amount) — one-signature PARTIAL withdrawals (owner UX decision 2026-08-08)

Live test on wallet 0xaAda…3c15: a $168.04 typed/MAX withdrawal needed SEVEN
wallet signatures (the frontend loops withdrawPartial per matrix), while
Withdraw All is ONE signature via `TierRouter.bulkWithdraw()` (V8.44 G2 —
no-arg full sweep only). Owner's call: EVERY withdrawal — MAX or typed amount —
should source across tiers first and ask for ONE approval.

**Fix**: add `bulkWithdraw(uint256 amount)` to TierRouter — walk the member's
matrices (same order as the sweep), draw up to `amount` total via the
withdrawCore path, stop when satisfied. Same eligibility/debt/hold semantics
as the full sweep. Mind EIP-170 headroom (TierRouter is 142 bytes under —
lean on TierRouterLib for the loop body).

Frontend meanwhile (Testnet-App, shipped 2026-08-08): a full-amount request is
auto-routed to the no-arg sweep (one signature), and the per-matrix partial
loop now caps draws with the withdrawCore mirror instead of freeWithdrawable
(which left $49.04 of $168.04 "unsourced"). Typed partials remain multi-
signature until this router function ships.

## 4. floorPrice() can DROP — "never down" is a comment, not a rule

Found 2026-08-07 answering the owner's question "the floor cannot be revisited
correct?". Verified against source; the answer is no.

`CNOVATreasury.sol:213` — the $0.01 return is a **divide-by-zero guard only**
(`if (supply == 0)`), dead forever after the first mint. The contract's own
comment says so. Past that it is pure `(usdcReserve * 1e18) / supply` with no
`MIN_FLOOR`, no clamp, no ratchet anywhere in the file.

Line 209 asserts *"It can only ever go up — never down — by design."* This is
the source of the website claim. **Nothing enforces it.**

### Three leaks

1. **`addDexLiquidity` (:365)** — `usdcReserve -= usdcAmount`, no CNOVA burned.
   Owner-only + Universe Mode.
2. **`emergencyWithdraw` (:384)** — same shape, `onlyOwner` is the only gate.
   Its own comment says "Best practice: protect with a Timelock at deploy."
   We did not deploy it behind a timelock.
3. **Ordinary registrations** — LIVE NOW. Each join mints
   (`MatrixLogicLib:425`) and deposits 500bps (`:819`). Marginal ratio:
   T1 **$0.010000**, T2–T7 $0.012500, T8–T10 $0.015625. The floor moves
   toward the marginal ratio of whatever just happened, so **T1 entries
   dilute whenever the floor is above $0.01** — it is $0.011561 today.

**Amplifier:** figure-8 re-entries mint again. `countedMember`
(`CNOVAToken:452`) gates only the epoch MEMBER trigger, not the mint. Wave 3
ran 1,448 T1 entry events from 576 members — dilution is per-ENTRY at ~2.5x
per member, not per-join.

### Two things that do NOT raise the floor (corrected)

- **DirectSale is floor-NEUTRAL by design.** `CNOVADirectSale:295` deposits
  `toTreasury = cnovaOut * floorE6` — exactly floor value — and diverts the
  entire 1.25x–2x premium to SF and LQ. Purchases never raise the floor.
  Site copy implies otherwise.
- **Redemption is neutral-then-positive.** `redeemAtFloor` burns supply and
  debits reserve at exactly the floor (ratio unchanged), then recycles 80% of
  the exit penalty into `usdcReserve` with no matching mint. This is the ONLY
  genuine upward force.

### View divergence (separate small item)

`DirectSale._floorPriceE6()` reads `usdc.balanceOf(treasury)`;
`Treasury.floorPrice()` reads the `usdcReserve` accumulator. Equal today; any
USDC reaching the treasury outside `depositReserve` makes them disagree.
Fold into the item-1 view-parity work.

### Decisions

- **Owner side — DECIDED 2026-08-07:** hard `require(floorPrice() >=
  floorBefore)` in both `addDexLiquidity` and `emergencyWithdraw`. No
  override, no timelock escape. addDexLiquidity must then pair at or above
  the floor ratio; emergencyWithdraw becomes unusable against reserve.
- **Mint side — DECIDED 2026-08-08: OPTION A.** Cap the mint at the value
  the registration's own treasury deposit backs at the current floor.
  Owner's framing for the copy: *"starts at 50 CNOVA, then auto-corrects
  as the floor rises."* Scheduled rewards and the epoch table are
  UNCHANGED — the cap is a backing ceiling, not a new schedule.
  Consequence to state plainly: minted amount x floor == treasury deposit
  exactly whenever the cap binds, so the reward's BACKING VALUE is
  constant ($0.50 per T1 entry) while the token COUNT falls as the floor
  rises. This makes the launch equation ($0.50 / 50 = $0.01) a permanent
  rule rather than a one-time coincidence.

### Mint-side options + modelled results

Model: `/home/claude/floor_model.py` (mechanics traced to source), chart
`floor_options.png`. Start state R=$2,900.75 S=250,900 (floor $0.011561),
5,000 new members at 2.5 entries each.

| option | realistic mix (upgrades + 8% exits) | pure T1 wave |
|---|---|---|
| **C** no change | min **$0.011499 (−0.54%)** @ +3,000, recovers to +5.3% after the epoch-2 halving | **$0.010522, −8.99%, no recovery** |
| **B** T1 split 500→625bps | never dips; +14.0% | +5.4% |
| **A** cap mint at floor value | never dips; +9.7% | **exactly flat, 0.00%** |

- **A** — in `mintReward`, after the tier multiplier:
  `backed = deposit * 1e18 / floorPrice(); if (amount > backed) amount = backed;`
  Mint runs BEFORE the deposit (`:425` vs `:819`), so the cap uses the
  pre-deposit floor and the registration is **exactly** floor-neutral
  (algebra: `(R+D)/(S+D/F) == F`), floor-positive when the schedule is under
  the cap. Clamps 6.6% of mints, essentially all epoch-1 T1 (43.25 vs 50
  CNOVA today, −13.5%). **Self-releases at the epoch-2 halving** — clamp
  thresholds by epoch, T1: e1 $0.0100, e2 $0.0125, e3 $0.0250, e4 $0.0500,
  e5 $0.1000, e6–9 $0.2000 (×1.25 for T2–T7, ×1.5625 for T8–T10).
  Reuses the mechanism the token ALREADY ships for Final Frontier
  (`CNOVAToken:434` mints inversely proportional to floor) — plumbing proven,
  `treasuryRef` wired, already inside a try/catch at the call site.
- **B** — T1 treasury split 500→625bps (NOT 250bps; 50 CNOVA × $0.0125 =
  $0.625). 125bps must come out of T1 pool (1800→1675, −6.9%) or chain pay
  (1350→1225, −9.3%) to hold the hard-required 4750bps invariant. Costs
  $1,215 of member USDC over the modelled run. Permanent, not one epoch.
- **C** — no mint-side change; rewrite site copy instead.

### Blocked on this decision

- Copy item **B1** (frontend audit, "absolute floor can never be revisited")
  is UNAPPLIED pending the outcome. If A or B ships, the guarantee can be
  stated plainly. If C ships, B1 must be rewritten to the real rule.
- Group B copy items B2–B8 continue independently.

### Shipping decision 2026-08-08

Owner call: **ship all B1 copy to main NOW**, ahead of the V8.48 deploy.
Rationale: testnet (no real funds), V8.48 expected within 48h.

**Standing dependency created — V8.48 MUST ship BOTH floor items or the live
copy becomes a false claim:**
1. mint cap at floor value in `CNOVAToken.mintReward`
2. `require(floorPrice() >= floorBefore)` in `CNOVATreasury.addDexLiquidity`
   and `emergencyWithdraw`

If either slips out of V8.48, the B1 copy must be rolled back the same day.
Sites carrying the claim: compensation.html (s4_p2_b/s4_p2_a), faq.html
(q20_a2, q21_a2, q21_a2b), index.html (dash.cnova_balance_tip,
dash.cnova_wallet_note, dash.cnova_detail_note).

## 5. B2 verification result (copy already corrected, contract unchanged)

Verified against source 2026-08-08 — copy was false, contract is fine:
- `TierRouter.pauseSystem(string)` :686 is `onlyOwner`; `checkInactivity()`
  :650 auto-pauses at 30 days / 2 cycles (defaults :329-331), permissionless.
- `whenNotPaused` is ONLY on register/upgrade (:710,722,740,806,904,915,955,
  1049). `bulkWithdraw()` :1020 and all `FigureEightMatrixV8.withdraw*` are
  UNGATED — **a pause cannot block withdrawals.** Good property, now stated.
- No upgrade proxy anywhere (no Initializable/UUPS/ERC1967; delegatecall is
  linked-library only). `FigureEightMatrixV8` has NO fee-split setter.
- Governance 72h vote / 48h timelock / 2% quorum (:260-264).
- **Audit's "~35 DAO params" was WRONG: PARAM_MAX_ID = 57, three retired
  (3 escrow floor mult, 10 early-exit penalty, 36 boost-table scalar path)
  = 54.** Copy says "more than 50" to avoid drift.

## 6. B3 verification result

- `CNOVAToken.vestDuration = 180 days` (:163, governable). Matrix-minted CNOVA
  is CLIFF-vested — counts in balanceOf but is non-transferable until cliff.
- **TWO separate penalties, both can apply to the same exit:**
  (a) early UNLOCK of vested CNOVA — `maxPenaltyBps` default **5000 (50%)**,
      slides linearly to 0 as the cliff approaches (:171, :353-361).
  (b) `CNOVATreasury.earlyExitPenaltyBps` on redemption — **4500 / 3000 /
      1500 / 500 / 0** at **30 / 60 / 90 / 120** days (:253-257). Audit's
      ladder was CORRECT.
- (b) measures tenure from `tier1Matrix.memberJoinedAt(member)`, NOT from
  token receipt — and returns **0** if the T1 lookup fails or joinedAt == 0.
- On redemption, 80% of penalty (b) recycles to `usdcReserve`, 20% to the
  Community Wallet (:284-290).

### On-chain verification 2026-08-08 (scripts/check_floor_sources.js)

    floorPrice()        11824   $0.011824   <-- redemption pays this
    balance/supply      11824   $0.011824   <-- old frontend formula
    usdcReserve()   5811750000   $5811.75
    balanceOf(T)    5811750000   $5811.75
    totalSupply()      491500 CNOVA
    DRIFT = 0

**No divergence today.** Frontend commit d25b718 (all three floor displays now
read `floorPrice()`) is DEFENSIVE, not a live-bug fix. The V8.48 view-parity
item stays on the list but is not urgent.

**Growth since the model (was $2,900.75 / 250,900 = $0.011561):**
reserve +$2,911.00, supply +240,600 CNOVA → marginal ratio **$0.012099**,
above the floor, so the floor ROSE to $0.011824 (+2.3%). Upgrade activity is
carrying it — consistent with the model's mixed-growth case. The T1 dilution
risk is unchanged, just currently masked by heavy upgrade volume; a pure
onboarding wave would still walk it toward $0.01.

**Option A clamp is DEEPER than quoted at decision time:**
- at decision (floor $0.011561): 50 → 43.25 CNOVA, **−13.5%**
- today (floor $0.011824):      50 → **42.29 CNOVA, −15.4%**
The clamp deepens as the floor rises. Owner approved at −13.5%; flagged.

**Epoch 1 is 49.1% done** (491,500 / 1,000,000 `epochMintLimit`). At epoch 2
the base drops 50 → 40, lifting the T1 clamp threshold $0.0100 → $0.0125.
Current floor $0.011824 < $0.0125, so **the clamp releases at the halving** —
confirming the "one epoch, not permanent" argument the decision rested on.
Watch: if the floor passes $0.0125 before epoch 2, the clamp persists into it.

## 7. earlyExitPenaltyBps is DEAD CODE on every V8 deploy

Found 2026-08-08 from an owner screenshot: the Redeem panel showed
"No early-exit penalty — you have passed 120 days of membership" on a
deployment that was **three days old**.

**Root cause:** `scripts/deploy_v8.js` never calls `setTier1Matrix()` or
`setMemberTracker()`. Only the V6 / archived / figure8-test deploy scripts do.
So `CNOVATreasury.tier1Matrix == address(0)` on every V8 deploy, and
`earlyExitPenaltyBps` returns on its FIRST line (:243).

**Belt and braces — it would still return 0 if wired:**
- `setMemberTracker` is documented to point at the PairManager, and
  `PairManager.memberJoinedAt()` is a stub: `return 0; // PairManager doesn't
  track individual join timestamps` (:280).
- `PairManagerV8` does not implement `memberJoinedAt` at all → the `try` at
  :246 catches → returns 0.
- Pointing it at T1 matA instead would charge pair-1 members and let every
  pair-2+ member off free (`joinedAt == 0` on the wrong matrix). Unequal, and
  it worsens as the factory spawns pairs.

**Consequences (all live on V8.47):**
1. The 4500/3000/1500/500/0 ladder has NEVER charged anyone.
2. The penalty split in `redeemAtFloor` (80% → `usdcReserve`, 20% → Community
   Wallet) sits inside `if (penalty > 0)` — it has never executed. The CW has
   received nothing from exits; the Treasury no penalty top-up.
3. **`setFreeMode()` also requires `tier1Matrix != address(0)` (:308), so
   Universe Mode CANNOT be activated** — which in turn gates `addDexLiquidity`.
4. Redemption is exactly floor-neutral. Correcting the 2026-08-08 floor
   analysis: penalty recycling is NOT an upward force because it never runs.
   The genuine upward forces are (a) higher-tier marginal ratios and
   (b) `CNOVAToken.earlyUnlock` penalty BURNS — supply falls, reserve
   unchanged, floor rises. `earlyUnlock` is self-contained and DOES work.

**Copy corrected 2026-08-08** (was describing a mechanism that does not run):
`faqPage.q21_a3`, `faqPage.g3_def`, `compPage.s5_p2`, and the Redeem panel's
else branch in index.html (which invented "120 days" as the reason for a zero
that has four possible causes).

**V8.48 work — owner decision 2026-08-08: wire it properly.**
- Add cross-pair join-date tracking so tenure is correct for members in ANY
  T1 pair (PairManager needs a real `memberJoinedAt`, or the Treasury needs a
  different source).
- Call the setter in `deploy_v8.js` — and add it to `predeploy_check.js` so a
  missing wire fails the gate instead of silently zeroing the penalty.
- Restore the ladder copy only once it actually charges.
- Decide separately whether Universe Mode should stay blocked meanwhile.

## 8. Redeeming vesting CNOVA corrupts the vest ledger (locked > balance)

PROVEN on-chain 2026-08-08 from an owner test redeem. Wallet held 1000 CNOVA,
ALL of it in vest batches. A 1-CNOVA `redeemAtFloor` SUCCEEDED: balance went
1000 -> 999 while `lockedBalanceOf` still returned 1000.

### Two separate facts, both previously mis-stated on the site

1. **Vesting does NOT block redemption.** `CNOVAToken._update` (:710) runs the
   vesting guard only `if (from != address(0) && to != address(0))`. A burn has
   `to == address(0)`, so it skips entirely. `redeemAtFloor` checks
   `balanceOf`, never `unlockedBalanceOf`. The cliff blocks TRANSFERS (no
   selling above floor before unlock); exit at floor is always open. The
   carve-out looks deliberate and is defensible design - the site copy simply
   never described it correctly.
2. **Burning does NOT prune vest batches.** `lockedBalanceOf` (:532) sums
   `_vestBatches`; only `earlyUnlock` removes them. So after redeeming from a
   locked balance, `lockedBalanceOf` is STALE and can exceed `balanceOf`.

### Consequence of (2) - this is the bug

`unlockedBalanceOf` = `total > locked ? total - locked : 0`, and `_update`
computes `available` the same way. Once locked > balance:
- `unlockedBalanceOf` returns **0**
- **every transfer reverts** with "CNOVA: tokens vesting -- wait for unlock"

The wallet loses transferable allowance equal to whatever it redeemed from
locked, until the batches naturally expire (180 days). Redeem the full locked
amount and CNOVA bought LATER via DirectSale - minted unvested and supposed to
be immediately transferable - is stranded too, because the guard compares a
fresh balance against a stale lock.

### Fix options for V8.48

- (a) Cheapest and safest: cap the view -
  `lockedBalanceOf` returns `min(sum(batches), balanceOf(wallet))`. One line,
  no burn-path changes, makes `_update` correct immediately.
- (b) Correct at source: reduce/prune vest batches inside `_update` on burn
  (soonest-unlocking first). More faithful accounting, more surface area.
- (a) does not repair the ledger, only its effects. Prefer (a) for V8.48;
  consider (b) after, or do both.

### CONFIRMED WORSE 2026-08-08 (owner reproduced end-to-end)

Owner redeemed the FULL locked balance. Resulting wallet state:

    CNOVA Held            0.00
    Transferable          0.00
    Vesting (locked)  1,000.00   <-- GHOST: batches with no tokens behind them
    USD Value at Floor   $0.00

`earlyUnlock(batchIndex)` now REVERTS for every batch. Sequence: it pops the
batch, then burns/transfers `penaltyAmt` from `msg.sender` - who holds 0
tokens - so `_burn` reverts on insufficient balance and the whole tx rolls
back. The batches can never be unlocked and never had tokens behind them.

**Severity is higher than first logged.** Not merely an accounting drift:
1. `lockedBalanceOf` (1000) > `balanceOf` (0) => `_update` computes
   `available = 0` => the wallet CANNOT TRANSFER ANY CNOVA, including tokens
   bought later via DirectSale that are minted unvested.
2. `earlyUnlock` reverts on every batch - the documented escape hatch is dead
   for this wallet.
3. The UI truthfully reports 1,000 CNOVA vesting that does not exist.
4. Self-heals only when each batch passes its `unlockAt` (Feb 2027), because
   `lockedBalanceOf` stops counting expired batches. Until then the wallet is
   effectively frozen for transfers.

**This changes the fix.** Option (a) alone (cap `lockedBalanceOf` at
`balanceOf`) clears the frozen-transfer symptom and the ghost display, but
`earlyUnlock` STILL reverts because the orphan batches remain. V8.48 needs
option (b) as well: reduce/prune vest batches inside `_update` on burn
(soonest-unlocking first), so redeeming vested CNOVA consumes its batches.
Do (a) for the immediate symptom AND (b) for correctness.

**Frontend, meanwhile:** the "Unlock early" buttons and the Max Unlock action
should be disabled when `balanceOf < penaltyAmt` rather than offering an
action that always reverts. Currently the member gets a confirm dialog
promising "100.01 CNOVA, transferable immediately" followed by an on-chain
failure.

**Operational note:** do not redeem vesting CNOVA on any wallet that matters
until V8.48 ships. The test wallet is frozen for transfers until Feb 2027.

### Frontend corrected 2026-08-08 (was asserting the opposite)

- Redeem panel vesting note: now "can be redeemed at floor right now, but
  cannot be transferred or sold until it unlocks".
- Max Unlock explainer: unlocking buys TRANSFERABILITY, not redeemability.
- STILL TO DO: the earlier B3 copy fix the same day said locked CNOVA "cannot
  be transferred or redeemed" - half right. `faqPage.q21_a3`, `faqPage.g3_def`
  and `compPage.s5_p2` still carry that wording and need the same correction.

## 9. V8.47 changed the upgrade CHARGE — tooling was never updated

Pattern worth generalising, found twice on 2026-08-08 in unrelated codebases.

V8.47's upgrade gate charges **entry fee + outstanding SF rescue debt** in one
transaction. Two independent callers still approved only the fee:

- **Frontend** `_executeUpgrade` — fixed 2026-08-07 (`_upgradeDebtDue`), surfaced
  by an owner screenshot showing a 26.6000 approval.
- **`scripts/bigfill_v8.js`** — fixed 2026-08-08. Symptom was total: **0 of 12
  T5 upgrades succeeded**, every one "transaction execution reverted", because
  the wallets had just been self-rescued and therefore all carried debt.
  After the fix: **12/12 T4 and 23/23 T5 succeeded.**

Neither was a contract bug. Both were tooling carrying a pre-V8.47 assumption
that nothing re-read after the contract changed.

### Related, same run

- `RESCUE_APPROVAL` was a flat $15 whose own comment said it was sized for T1,
  while self-rescue had been extended to every tier (T3 needs up to $25, T5
  $125). Now sized to the matrix's own `ENTRY_FEE()`.
- Approve-then-read races: `.wait()` confirms on one node, the next read can hit
  a node that is behind, so a just-approved allowance can read as $0.00 and the
  static call reverts. Now polls until the allowance is visible.
- `F8V8: already in matrix` / `still in matrix` are the VPS keepers
  (copay_rescue, fastlane_rescue, both every 10 min) winning the race against
  the bigfill sweep on the same parked queue. Benign; now a quiet skip.
  NOTE: the standing "bigfill OR stress keeper, never both" rule predates these
  two jobs and does not cover them — worth deciding whether it should.

### Action for V8.48

Extend the `predeploy_check.js` idea beyond wiring assertions: when a release
changes what a member is CHARGED, grep every caller that builds an ERC20
approval (frontend + scripts/ + /root/keeper/) and re-verify the amount. The
wiring check catches "nothing calls this"; this catches "callers still believe
the old price".

## 10. CRITICAL — saturated pairs trap their members; chainNext is dead code

Found 2026-08-09 from the owner's observation that "members in T1A are not
rotating". Verified in source AND on-chain. This is the most severe finding of
the audit and should gate the V8.48 release.

### The defect

`MatrixLogicLib._finalizeCrossing` (:769):

    if (!cfg.isMatrixA && self.pairManager != address(0)) {
        ... IPairManagerOverflow(self.pairManager).rescueReentry(member, ref, pIdx);
        return;                                  // <-- ALWAYS returns here
    }
    address destination = (!cfg.isMatrixA && self.chainNext != address(0))
        ? self.chainNext : self.partner;         // <-- unreachable from MatB

A PairManager is always set in production, so the `chainNext` branch NEVER
executes for MatB. Its own comment admits it: "chainNext is only a legacy
fallback for deployments without a PairManager."

`PairManagerV8.rescueReentry` (:285) then does:

    dest = p.totalRegistered >= routeEntryThreshold ? p.matrixB : p.matrixA;

So at saturation a pair's MatB cycle-outs are seated back into THE SAME MatB.

### Consequence

Each pair is a CLOSED system. Nothing ever crosses between pairs:
- new registrations -> routing pair's MatA only (`registerDirectFor` :424)
- MatA cycle-out    -> own MatB (`self.partner`)
- MatB cycle-out    -> own MatB once saturated (never leaves)

**A saturated pair's MatA receives NOTHING and freezes permanently.** Members
seated there can never cycle again — not slowly, never.

### Live evidence 2026-08-09 (scripts/diag_pair_starvation.js)

    routeEntryThreshold = 400   active routing pair = T1.3

    T1.1  registered 3427/400  SATURATED
         MatA  occ 127  rotations   316  parked  0   <-- FROZEN (315 -> 316 in 24h)
         MatB  occ 127  rotations  3160  parked 85   <-- circulating in place
    T1.2  registered  588/400  SATURATED
         MatA  occ 127  rotations   289  parked 11   <-- FROZEN
         MatB  occ 126  rotations   322  parked 39
    T1.3  registered    8/400  below threshold
         MatA  occ   8  rotations     0
         MatB  occ   0  rotations     0

T1.1 MatB rotated 3,160 times; its configured chainNext target (T1.2 MatA) sits
at 289 — and those 289 came from T1.2's OWN registrations while it was the
routing pair. **Zero cross-pair movement has ever occurred.**

**254 members (127 in T1.1 MatA + 127 in T1.2 MatA) are permanently frozen.**
Member ticket: Sherwyn 0x7d3c94885d2022200934d4908bca7b47905bbcf6, seat 12 of
T1.1 MatA. Previously answered as "~11 rotations out" — that answer was WRONG
and rests on the dead chainNext reading; it must be corrected.

### Fix (owner's proposal, and the wiring already exists)

Owner 2026-08-09: "T1A is the only way in, but when T1B cycles out it should go
to a pair A and continue up the ladder." Correct. `chainNext` is ALREADY
configured as a complete ring: T1.1MatA->T1.1MatB->T1.2MatA->T1.2MatB->
T1.3MatA->T1.3MatB->T1.1MatA. The fix is to let the MatB branch USE it.

**Do NOT simply revert to V8.43.** That version forwarded saturated-pair rescues
to pair N+1 and starved the new pairs' MatBs (comment cites MatA rot 254-291
with MatB rot 0 on pairs 2-5). A COMPLETE ring avoids this — each MatB is fed by
its own MatA, each MatA by the previous pair's MatB — but the ring must be
unbroken, and the factory must wire chainNext on every new pair it spawns
(VERIFY: does MatrixPairFactory set chainNext, and does it re-point the last
pair's MatB back to pair 1 when a new pair is added?).

### Open questions — ANSWERED 2026-08-09

**1. Does the factory wire chainNext, and re-point the ring on expansion? YES.**
`PairManagerV8.addPair` (:480) already does all of it:

    if (pairId == 0) { chainHead = matA; lastChainB = matB;
                       matB.setChainNext(matA); }
    else { lastChainB.setChainNext(matrixA);              // prev B -> new A
           matrixA.setChainAuthorized(lastChainB, true);
           matrixB.setChainNext(chainHead);               // new B  -> first A
           chainHead.setChainAuthorized(matrixB, true);
           lastChainB = matrixB; }

It maintains the ring on every spawn AND grants the cross-matrix `_enterMatrix`
permission (`chainAuthorized`, enforced at MatrixLogicLib:250). Confirmed live:
T1.1MatA->T1.1MatB->T1.2MatA->T1.2MatB->T1.3MatA->T1.3MatB->T1.1MatA.
**Nothing needs building. The ring exists, is permissioned, and self-maintains —
`_finalizeCrossing` simply never reads it.**

**2. Does restoring the ring unfreeze the existing 254? YES, in this order.**
- T1.1 MatB cycle-outs enter T1.2 MatA (full) -> each arrival rotates it ->
  **T1.2 MatA unfreezes immediately**
- cascade continues into T1.2 MatB, then T1.3 MatA (occ 8/127) where it parks
  until that fills
- **T1.1 MatA is LAST**: needs T1.3 MatA to reach 127 and T1.3 MatB to fill and
  begin cycling — roughly **246 crossings**. T1.1 MatB has 127 seated + 85
  parked and rotates fast, so this should clear without intervention.
- `adminForceRotateRoot` is available to accelerate T1.1 MatA if needed.

### LIVE MITIGATION APPLIED 2026-08-09 — TEMPORARY, MUST BE REVERTED AFTER V8.48

**T1 PairManager `routeEntryThreshold` raised 400 -> 1,000,000.**

    contract  0xB76fACd6234e1a0510599CBd185289444D58E2D3  (T1 PairManager)
    call      setEntryThresholds(375, 1000000)
    tx        0xaaa1bbd1d633e11d6b384bcac950923a5744573f309c1c925b36ca5471a2387d
    block     45256563   2026-08-09 13:16:54 UTC
    by        0xCd0Af6a4116f2062c1594aDf34c1821D45175506 (owner)

**Why:** `rescueReentry` (:286) tests `p.totalRegistered >= routeEntryThreshold`
— a cumulative counter — so every mature pair read as permanently saturated and
its rescued members were routed back into their own MatB forever. Raising the
threshold above any reachable value makes the test false, so rescues return to
own MatA. Same technique V8.46 used to prove the TierRouter fix.

**Result — immediate and unambiguous:**

    T1.1 MatA rotations   316 (frozen 24h+)  ->  323 -> 324 -> 327 in minutes
    T1.1 MatB parked       85  ->  79 -> 78 -> 75   (draining into MatA)
    T1.1 MatB rotations  3167 -> 3168 -> 3168 -> 3168 (stopped self-recycling)
    T1.2 MatA rotations   289  ->  291

**Side effect (accepted, and currently harmless):** `_findExternalPair` (:581)
shares this knob, so ALL new registrations now route to pair 0 (T1.1 MatA).
That is additive right now — each one rotates the previously frozen matrix. But
newer pairs receive no externals while this holds, and pair expansion via
`_tryAdvancePair` keys off the newest pair's MatB occupancy, which will not
advance. **Do not leave this in place long-term.**

**REVERT COMMAND (after the V8.48 rescueReentry fix ships):**

    setEntryThresholds(375, 400)
    // scripts/unfreeze_matA.js with NEW_ROUTE=400 APPLY=1

**Related discovery:** `route_rr.js` — the round-robin keeper that PairManagerV8
:156 says drives T1's routeEntryThreshold at runtime — has been DISABLED since
2026-08-06 (`# TRIM-2026-08-06` in crontab), the same day `manual_rescue` was
trimmed. The threshold stopped being walked, every pair stayed above it, and
MatA starved. **Turning off route_rr is very likely what triggered the freeze**;
the rescueReentry bug has existed since V8.44 but the keeper's threshold walk
was masking it. Read route_rr.js before finalising the V8.48 fix so the contract
does not end up depending on behaviour a keeper was quietly providing.


### Scope conclusion

The fix is ONE BRANCH in `_finalizeCrossing` — let the MatB path fall through to
`chainNext` instead of short-circuiting into `rescueReentry`. All supporting
infrastructure (ring wiring, chainAuthorized permissions, fee approval pattern)
is already present and proven.

Remaining design decision: what `rescueReentry` should still be used for. It was
added in V8.44 to stop frozen MatBs, but with a complete ring each MatB is fed
by its own MatA and each MatA by the previous pair's MatB, so the starvation it
guarded against cannot recur while the ring is unbroken. Options: (a) delete the
short-circuit entirely, (b) keep rescueReentry only for the PARKED/idle path and
send normal cycle-outs through chainNext.


## Context

- Deploy version at discovery: deployed_addresses_v8_47.json, Base Sepolia.
- Frontend compensation commits (Testnet-App, admin): 427beb5 (unified
  `_claimableAll` withdrawCore mirror) + follow-up badge-truth commit.
- Owner decisions 2026-08-07: badge shows both figures; this backlog logged.
- Related standing rule: mainnet grace = 48h (testnet 24h) — keeper config,
  not a contract change.
