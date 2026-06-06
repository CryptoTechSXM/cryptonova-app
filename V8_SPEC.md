# CryptoNova V8 — The Elevator
## Full Contract Specification (Design Lock)
*Locked: 2026-06-05 — Do not start coding until this document is agreed.*

---

## 1. Vision

Seven-tier BFS matrix system. No belt queue. No waiting. Members enter at Tier 1 ($10),
earn USDC immediately from chain pay and referrals, build escrow automatically, and
cycle up through Tier 7 ($1,000) without any manual action. CNOVA token is a vesting
nest egg that appreciates as the community scales.

**The two V3 failures that this design eliminates:**
1. Belt queue stall — no queue exists in V8. Members enter the matrix directly.
2. Belt fragmentation — no BELT_MAX, no new belt opens. Capacity is handled by adding
   pairs within each tier's PairManager.

---

## 2. Tier Structure

| Tier | Name              | Entry Fee | CNOVA Multiplier | Treasury % |
|------|-------------------|-----------|-----------------|------------|
| T1   | Nova Seed         | $10       | 1×              | 5%         |
| T2   | Nova Rise         | $25       | 2×              | 5%         |
| T3   | Nova Star         | $50       | 4×              | 5%         |
| T4   | Nova Prime        | $100      | 8×              | 8%         |
| T5   | SuperNova Genesis | $250      | 20×             | 8%         |
| T6   | SuperNova Elite   | $500      | 40×             | 12%        |
| T7   | SuperNova Spark   | $1,000    | 80×             | 12%        |

---

## 3. Payment Splits

Splits must sum to exactly 10,000 BPS (100%) per tier group.

### T1–T3 (5% treasury)

| Split              | BPS   | $ at T1  | $ at T3   |
|--------------------|-------|----------|-----------|
| L1 Referral        | 2500  | $2.50    | $12.50    |
| L2 Override        | 300   | $0.30    | $1.50     |
| L3 Override        | 200   | $0.20    | $1.00     |
| Chain Pay (6 lvls) | 4000  | $4.00    | $20.00    |
| Follow-Me Escrow   | 1500  | $1.50    | $7.50     |
| Secondary Escrow   | 500   | $0.50    | $2.50     |
| Treasury           | 500   | $0.50    | $2.50     |
| Dev/Ops/Protocol   | 500   | $0.50    | $2.50     |
| **TOTAL**          | 10000 | **$10**  | **$50**   |

### T4–T5 (8% treasury)

| Split              | BPS   | $ at T4  | $ at T5   |
|--------------------|-------|----------|-----------|
| L1 Referral        | 2500  | $25.00   | $62.50    |
| L2 Override        | 300   | $3.00    | $7.50     |
| L3 Override        | 200   | $2.00    | $5.00     |
| Chain Pay (6 lvls) | 4000  | $40.00   | $100.00   |
| Follow-Me Escrow   | 1200  | $12.00   | $30.00    |
| Secondary Escrow   | 300   | $3.00    | $7.50     |
| Treasury           | 800   | $8.00    | $20.00    |
| Dev/Ops/Protocol   | 700   | $7.00    | $17.50    |
| **TOTAL**          | 10000 | **$100** | **$250**  |

### T6–T7 (12% treasury)

| Split              | BPS   | $ at T6  | $ at T7    |
|--------------------|-------|----------|------------|
| L1 Referral        | 2500  | $125.00  | $250.00    |
| L2 Override        | 300   | $15.00   | $30.00     |
| L3 Override        | 200   | $10.00   | $20.00     |
| Chain Pay (6 lvls) | 3500  | $175.00  | $350.00    |
| Follow-Me Escrow   | 1200  | $60.00   | $120.00    |
| Secondary Escrow   | 300   | $15.00   | $30.00     |
| Treasury           | 1200  | $60.00   | $120.00    |
| Dev/Ops/Protocol   | 800   | $40.00   | $80.00     |
| **TOTAL**          | 10000 | **$500** | **$1,000** |

### Chain Pay level weights (6 levels — applies to all tiers)

| Level | BPS  | $ at T1 | $ at T7  |
|-------|------|---------|---------|
| L1    | 2000 | $2.00   | $70.00  |
| L2    | 800  | $0.80   | $28.00  |
| L3    | 600  | $0.60   | $21.00  |
| L4    | 300  | $0.30   | $10.50  |
| L5    | 150  | $0.15   | $5.25   |
| L6    | 150  | $0.15   | $5.25   |
| **Total** | **4000** | **$4.00** | **$140.00** |

*Note: T6/T7 chain pay BPS = 3500, so scale proportionally.*

---

## 4. Matrix Configuration

| Setting             | Testnet       | Mainnet Launch | Scale Phase    |
|---------------------|---------------|----------------|----------------|
| MATRIX_SIZE         | 15 (4-level)  | 63 (6-level)   | 127 (7-level)  |
| Expand threshold    | 60%           | 60%            | 60%            |
| Epoch member limit  | 5             | 10,000         | 10,000         |

---

## 5. Upgrade Rules (The Elevator)

A member auto-upgrades from Tier N to Tier N+1 when ALL of the following are true
at the moment they cycle out of their Matrix B:

1. `cyclesCompleted[member] >= 1` — they have completed at least one full figure-8
2. `escrowBalance[member] >= nextTierFee` — escrow covers the next tier's entry fee
3. Member is not already in Tier N+1 (first position not yet held)

If conditions are NOT met → member re-enters Tier N automatically (same tier, next
available BFS position). They keep accumulating escrow until conditions are met.

**T7 is the apex — it loops forever.** T7 members never auto-upgrade (no T8 exists).
They re-enter T7 on every cycle-out.

**Voluntary re-entry to lower tiers:** A member in T3+ can always choose to re-enter
any lower tier by paying that tier's entry fee directly. This is always optional, never
automatic (except Double Entry toggle — see below).

---

## 6. Double Entry (Opt-In Toggle)

Toggle stored per member: `doubleEntryEnabled[address]` (default: false).
Member can set via `TierRouter.setDoubleEntry(bool)`.

**When Double Entry = ON and member cycles out:**

```
1. Attempt auto-upgrade to T(N+1) — deduct upgradeFeefrom escrow
2. Check: (escrow_remaining) >= currentTierFee
   → YES: also re-enter T(N) — deduct currentTierFee from escrow
   → NO:  silently skip second entry (no error, no failed tx)
```

At T7 (loop tier) with Double Entry ON:
```
1. Re-enter T7 — deduct $1,000 from escrow
2. Check: escrow_remaining >= $1,000
   → YES: enter T7 again (second simultaneous position)
   → NO:  single position only
```

Member ends up holding positions in two tiers simultaneously when Double Entry fires.
Both positions earn chain pay, referral overrides, and escrow independently.

---

## 7. Whale Gate

- **Tracker:** `t5MemberCount` in TierRouter — increments each time a member first
  enters T5 (not on re-entries, only first-time T5 entry).
- **Activation threshold:** 25 T5 first-time members.
- **Effect once active:** T4 members who have completed ≥1 T4 cycle may skip T5 and
  go directly to T6 on their next upgrade — if their escrow covers the T6 fee ($500).
- `whalGateActive` bool stored in TierRouter, emits `WhaleGateActivated()` event.
- Frontend shows the counter publicly: "X / 25 Genesis members — Whale Gate unlocks at 25."

---

## 8. CNOVA Token — Nest Egg Design

### 8.1 Hard Supply Cap
```
MAX_SUPPLY = 21,000,000 × 1e18
```
Once reached, `mintReward` is a no-op (no revert, just skips mint). Existing holders
benefit from permanent scarcity.

### 8.2 Epoch Halving
Same structure as V7 — reward halves every EPOCH_MEMBER_LIMIT registrations.
Base reward at Epoch 1: **50 CNOVA per entry** (before tier multiplier).

| Epoch | Base reward | T1 earns | T7 earns   |
|-------|-------------|----------|------------|
| 1     | 50          | 50       | 4,000      |
| 2     | 25          | 25       | 2,000      |
| 3     | 12          | 12       | 960        |
| 4     | 6           | 6        | 480        |
| 5+    | halving...  | ...      | ...        |

### 8.3 Vesting
- All CNOVA minted from matrix activity is **locked for vestDuration** (default: 6 months).
- Cliff vest: full amount unlocks at once after vestDuration from the date of earn.
- CNOVA earned from different entries has independent cliff dates.
- `vestDuration` is DAO-adjustable via governance.
- CNOVA purchased on DEX has no vesting lock.

```
Storage per address:
  VestBatch[] vestBatches  // amount + unlockAt per earn event
```

### 8.4 Staking Boost (DAO-Adjustable Defaults)
Holding (not staking contract required — just wallet balance) CNOVA boosts all USDC
earnings from chain pay and referrals.

| CNOVA held   | Boost on all USDC earnings |
|--------------|---------------------------|
| 0            | +0% (base)                |
| 100          | +5%                       |
| 500          | +10%                      |
| 1,000        | +15%                      |
| 5,000        | +25%                      |
| 10,000       | +40%                      |

Thresholds and rates are arrays in CNOVAToken, adjustable by GOVERNOR_ROLE (DAO).
Boost is applied at withdrawal time: `withdrawable × (10000 + boostBps) / 10000`.
Treasury covers the boost delta (small % of treasury reserve allocated to boost pool).

### 8.5 Buyback + Burn
- `buybackThreshold`: when `treasury.usdcReserve > MIN_FLOOR_BACKING × 130 / 100`
- Anyone can call `treasury.triggerBuyback()` — sends excess USDC to Aerodrome to
  buy CNOVA, then burns it.
- Caller receives 0.1% of buyback amount as gas incentive.
- `triggerBuyback` is permissionless once threshold is met.

---

## 9. Contract List

```
contracts/
  TierRouter.sol          — NEW. Central hub. Manages all 7 tiers.
  FigureEightMatrix.sol   — MODIFIED from V7. Minor changes only.
  PairManager.sol         — REUSE from V7. One instance per tier.
  CNOVAToken.sol          — MODIFIED. Cap + vesting + tier multiplier + boost.
  CNOVATreasury.sol       — MODIFIED. Tiered deposits + buyback.
  CommunityWallet.sol     — REUSE/MODIFY from V6. Nova Originals + Pioneers.
  MockUSDC.sol            — REUSE. Testnet only.

scripts/
  deploy_v8.js            — Deploys all 7 tiers in order, wires TierRouter.
  register_w1.js          — Registers Account #1 at T1 root (same as V7).
  bigfill_v8.js           — Stress test: fill multiple tiers, test auto-upgrade.
  check_v8_state.js       — Read all tier states, escrow levels, member positions.
```

---

## 10. TierRouter.sol — Interface Spec

```solidity
contract TierRouter {

  // ── Storage ────────────────────────────────────────────────────────────────
  address[7] public tierPairManagers;         // index 0=T1 ... 6=T7
  uint256[7] public tierEntryFees;            // $10, $25, $50, $100, $250, $500, $1000
  mapping(address => uint8)   public memberTier;        // 0=not joined, 1-7=current highest
  mapping(address => address) public memberReferrer;    // locked forever on first join
  mapping(address => bool)    public doubleEntryEnabled;
  mapping(address => bool)    public globalJoined;      // cross-tier L1 eligibility
  mapping(address => uint256) public memberCycles;      // total cycles across all tiers
  uint256 public t5FirstEntries;              // for Whale Gate counter
  bool    public whalGateActive;

  // ── Events ─────────────────────────────────────────────────────────────────
  event MemberRegistered(address indexed member, uint8 tier, address referrer);
  event MemberUpgraded(address indexed member, uint8 fromTier, uint8 toTier);
  event MemberReentered(address indexed member, uint8 tier);
  event DoubleEntryFired(address indexed member, uint8 primaryTier, uint8 secondaryTier);
  event WhaleGateActivated(uint256 t5Count);
  event CycleRecorded(address indexed member, uint8 tier, uint256 totalCycles);

  // ── External: member-facing ─────────────────────────────────────────────────
  function register(address referrer, uint8 tier) external;
    // First-time registration. tier=1 unless direct higher-tier join.
    // Locks referrer forever. Routes to tierPairManagers[tier-1].

  function setDoubleEntry(bool enabled) external;
    // Toggle double entry for msg.sender.

  // ── External: called by matrices on cycle-out ──────────────────────────────
  function handleCycleOut(
    address member,
    uint8   currentTier,
    uint256 escrowAvailable,
    uint256 withdrawableAvailable
  ) external;
    // Called by Matrix B when member reaches root and cycles out.
    // msg.sender must be an authorized matrix address.
    // Routing logic:
    //   1. Record cycle: memberCycles[member]++
    //   2. Determine destination:
    //      - If currentTier < 7 AND cycles >= 1 AND escrow >= nextFee → UPGRADE
    //      - Else → RE-ENTER same tier
    //   3. If whalGateActive AND currentTier==4 AND cycles[T4]>=1 AND escrow>=T6fee → skip to T6
    //   4. Fire Double Entry if enabled and surplus covers it
    //   5. Update memberTier if upgraded
    //   6. Emit appropriate events

  // ── Views ───────────────────────────────────────────────────────────────────
  function getMemberInfo(address member) external view returns (
    uint8   currentTier,
    address referrer,
    uint256 totalCycles,
    bool    doubleEntry,
    bool    whalGateEligible
  );

  function isUpgradeEligible(address member) external view returns (bool, uint8 nextTier);
}
```

---

## 11. FigureEightMatrix.sol — Changes from V7

Only three changes needed. Everything else stays identical.

### Change 1: Dynamic crossing fee
```solidity
// OLD:
uint256 reentryFee = ENTRY_FEE;

// NEW:
address destination = (!isMatrixA && chainNext != address(0))
    ? chainNext : address(partner);
uint256 reentryFee = (destination == address(partner))
    ? ENTRY_FEE
    : IFigureEightMatrix(destination).ENTRY_FEE();
```

### Change 2: Tier-parameterised splits
Constructor accepts split BPS values instead of hardcoded constants.
This allows TierRouter to deploy T1 matrices with 500 treasury BPS and
T7 matrices with 1200 treasury BPS from the same contract bytecode.

```solidity
constructor(
    // ...existing params...
    uint256 _splitL1Bps,
    uint256 _splitL2Bps,
    uint256 _splitL3Bps,
    uint256 _splitChainBps,
    uint256 _splitEscrowBps,
    uint256 _splitSecondaryBps,
    uint256 _splitTreasuryBps,
    uint256 _splitDevBps
)
```

### Change 3: Cycle-out hook to TierRouter
After `_cycleOutRoot()` triggers `_crossToPartner(root)`:

```solidity
// Notify TierRouter so it can handle cross-tier upgrade logic
if (tierRouter != address(0)) {
    ITierRouter(tierRouter).handleCycleOut(
        root,
        currentTierIndex,
        escrowBalance[root],
        members[root].withdrawable
    );
}
```

`tierRouter` is set once by owner after deploy. Same pattern as `setPairManager`.

---

## 12. CNOVATreasury.sol — Changes

### Tiered deposit amounts
Matrix calls `depositReserve(amount)` — amount already varies by tier since it is
calculated as `ENTRY_FEE × SPLIT_TREASURY_BPS / BPS_DENOM` inside the matrix.
No change needed to depositReserve signature.

### Buyback function (new)
```solidity
uint256 public buybackThreshold = 13000; // 130% in BPS
address public dexRouter;                // Aerodrome on mainnet, mock on testnet

function triggerBuyback() external nonReentrant {
    uint256 minBacking = (cnova.totalSupply() * floorPrice) / 1e18;
    require(usdcReserve > minBacking * buybackThreshold / 10000, "threshold not met");
    uint256 excess = usdcReserve - minBacking;
    uint256 buyAmount = excess * 9000 / 10000; // use 90% of excess
    uint256 callerReward = excess - buyAmount;   // 10% to caller as gas incentive

    // Swap USDC for CNOVA on DEX, burn received CNOVA
    // (DEX integration handled in separate AerodromeAdapter.sol for mainnet)
    usdc.safeTransfer(msg.sender, callerReward);
    // ... DEX swap + burn logic
    emit BuybackExecuted(buyAmount, callerReward);
}
```

---

## 13. DAO-Controlled Parameters

All parameters below are adjustable via CNOVAGovernance proposal + vote.
Defaults are set at deploy and are safe starting values.

| Parameter              | Default        | Contract           | Notes                          |
|------------------------|----------------|--------------------|-------------------------------|
| vestDuration           | 180 days       | CNOVAToken         | 6-month cliff vest            |
| boostThresholds[]      | [100,500,1000,5000,10000] | CNOVAToken | CNOVA held for boost     |
| boostRates[]           | [500,1000,1500,2500,4000] | CNOVAToken | BPS boost at each tier   |
| buybackThreshold       | 13000 BPS      | CNOVATreasury      | 130% before buyback triggers  |
| epochMemberLimit       | 10,000         | CNOVAToken         | Registrations per epoch       |
| whalGateThreshold      | 25             | TierRouter         | T5 members to activate gate   |
| expandThresholdBps     | 6000 (60%)     | PairManager        | Occupancy before new pair     |

---

## 14. Deploy Sequence

```
Step 1:  Deploy MockUSDC (testnet) / point to real USDC (mainnet)
Step 2:  Deploy CNOVAToken
Step 3:  Deploy CNOVATreasury
Step 4:  Deploy CommunityWallet
Step 5:  Deploy TierRouter (empty — no tiers yet)
Step 6:  For each tier T1–T7:
           a. Deploy PairManager(usdc, entryFee, admin)
           b. Deploy MatrixA with tier-specific split BPS
           c. Deploy MatrixB with tier-specific split BPS
           d. setPartner(A↔B)
           e. setPairManager on both matrices
           f. treasury.setAuthorizedCaller(matA, true)
           g. treasury.setAuthorizedCaller(matB, true)
           h. cnova.grantRole(MINTER_ROLE, matA)
           i. cnova.grantRole(MINTER_ROLE, matB)
           j. matA.setTierRouter(tierRouter)
           k. matB.setTierRouter(tierRouter)
           l. pm.addPair(matA, matB)
           m. tierRouter.registerTier(tierIndex, pm)
Step 7:  Register W1 (Account #1) in T1 via TierRouter.register(address(0), 1)
Step 8:  Verify all contracts on BaseScan
```

---

## 15. Test Plan (before any mainnet deploy)

### Unit tests (per contract)
- [ ] TierRouter: upgrade eligibility logic (cycles, escrow thresholds)
- [ ] TierRouter: double entry fires correctly, falls back silently
- [ ] TierRouter: Whale Gate counter + activation + T4→T6 skip
- [ ] TierRouter: global referrer L1 paid even when referrer in different tier
- [ ] FigureEightMatrix: dynamic crossing fee reads destination correctly
- [ ] FigureEightMatrix: tier-split BPS constructor params apply correctly
- [ ] CNOVAToken: supply cap enforced (no mint past 21M)
- [ ] CNOVAToken: vesting cliff — tokens locked, unlock after vestDuration
- [ ] CNOVAToken: tier multiplier — T7 entry earns 80× T1 base
- [ ] CNOVATreasury: buyback threshold check, caller reward

### Integration tests
- [ ] Full T1→T2 auto-upgrade: member cycles T1, escrow covers T2, lands in T2 root
- [ ] T1→T2 with double entry: member holds position in T1 AND T2 simultaneously
- [ ] Insufficient escrow: member re-enters T1 until escrow covers T2
- [ ] Whale Gate: 25 T5 entries → whalGateActive=true → T4 member skips to T6
- [ ] T7 loop: member cycles T7 three times, referrer earns L1 each time
- [ ] Cross-tier L1: referrer in T1 earns L1 when recruit enters T2, T3, T7
- [ ] 127-member circular chain test (port from V7, all passing)

### Stress test (bigfill_v8.js)
- [ ] 50 wallets through T1, confirm 3+ T1→T2 upgrades occur
- [ ] Check escrow math matches spec at each cycle-out
- [ ] Confirm treasury receives correct % per tier

---

## 16. What We Deliberately Leave Out of V1

These are intentional exclusions — not forgotten. Build them in V2+.

| Feature               | Reason deferred                              |
|-----------------------|----------------------------------------------|
| Aerodrome DEX buyback | Need mainnet. Testnet uses mock only.        |
| Staking contract      | Boost is wallet-balance-based for simplicity |
| TierManager upgrades  | Governance handles param changes             |
| T8+ tiers             | Community growth milestone to add later      |
| Mobile app            | Web dApp first, app after mainnet proven     |

---

*End of V8 Specification. Next step: implement contracts in order per Section 9.*


---
---

# V8.1 DESIGN LOCK — Full Addendum
*Locked: 2026-06-06 — All decisions below supersede conflicting V8 Phase 1 spec above.*

---

## V8.1-1. Vision Statement

CryptoNova V8.1 is a fully self-sustaining, zero-admin matrix elevator.
Once deployed, no individual can halt, redirect, or extract funds. The Treasury
is sacred — it backs the CNOVA floor price and is never touched for operations.
Every member always completes their cycle. The ecosystem runs itself.

---

## V8.1-2. Option B — Equalization BPS (Design Lock)

Replaces the escrow-concentrated model. Chain pay is halved; freed BPS plus
escrow and secondary redirect to an equalization pool distributed deficit-weighted
at every cycle-out. No single wallet (root) receives disproportionate escrow.

### T1–T3 (base fee: $10 / $25 / $50)

| Split                  | BPS  | $ at T1 | $ at T3  |
|------------------------|------|---------|---------|
| L1 Referral            | 2500 | $2.50   | $12.50  |
| L2 Override            | 300  | $0.30   | $1.50   |
| L3 Override            | 200  | $0.20   | $1.00   |
| Chain Pay (6 levels)   | 2000 | $2.00   | $10.00  |
| Equalization Pool      | 3800 | $3.80   | $19.00  |
| Treasury               | 500  | $0.50   | $2.50   |
| Dev/Ops/Protocol       | 500  | $0.50   | $2.50   |
| Stability Fund         | 200  | $0.20   | $1.00   |
| **TOTAL**              |10000 | **$10** | **$50** |

### T4–T5 (base fee: $100 / $250)

| Split                  | BPS  | $ at T4  | $ at T5   |
|------------------------|------|---------|---------|
| L1 Referral            | 2500 | $25.00  | $62.50  |
| L2 Override            | 300  | $3.00   | $7.50   |
| L3 Override            | 200  | $2.00   | $5.00   |
| Chain Pay (6 levels)   | 2000 | $20.00  | $50.00  |
| Equalization Pool      | 3300 | $33.00  | $82.50  |
| Treasury               | 800  | $8.00   | $20.00  |
| Dev/Ops/Protocol       | 700  | $7.00   | $17.50  |
| Stability Fund         | 200  | $2.00   | $5.00   |
| **TOTAL**              |10000 |**$100** |**$250** |

### T6–T7 (base fee: $500 / $1,000)

| Split                  | BPS  | $ at T6   | $ at T7    |
|------------------------|------|---------|---------|
| L1 Referral            | 2500 | $125.00 | $250.00 |
| L2 Override            | 300  | $15.00  | $30.00  |
| L3 Override            | 200  | $10.00  | $20.00  |
| Chain Pay (6 levels)   | 1750 | $87.50  | $175.00 |
| Equalization Pool      | 3050 | $152.50 | $305.00 |
| Treasury               | 1200 | $60.00  | $120.00 |
| Dev/Ops/Protocol       | 800  | $40.00  | $80.00  |
| Stability Fund         | 200  | $10.00  | $20.00  |
| **TOTAL**              |10000 |**$500** |**$1,000**|

### Chain Pay Level Weights (V8.1 — halved from V8)

| Level | BPS  | $ at T1 | $ at T7 |
|-------|------|---------|---------|
| L1    | 1000 | $1.00   | $35.00  |
| L2    | 400  | $0.40   | $14.00  |
| L3    | 300  | $0.30   | $10.50  |
| L4    | 150  | $0.15   | $5.25   |
| L5    | 75   | $0.075  | $2.625  |
| L6    | 75   | $0.075  | $2.625  |
| Total | 2000 | $2.00   | $70.00  |

*T6/T7 chain total BPS = 1750 — scale proportionally.*

### Equalization Pool — Deficit-Weighted Distribution

At every cycle-out, the pool accumulated from all entries since the last
cycle-out is distributed to all non-root members weighted by their deficit
from the root's chain pay earnings.

```
deficit[member] = root_chain_pay - member_chain_pay
share[member]   = deficit[member] / sum(all deficits)
payout[member]  = total_pool × share[member]
```

---

## V8.1-3. Member Automation Toggles

Three per-member toggles stored in TierRouter. All DAO-votable cycle thresholds.

| Toggle         | Default | Cycle Threshold | What it does                                      |
|----------------|---------|-----------------|---------------------------------------------------|
| autoUpgrade    | ON      | ≥ 5 cycles      | Upgrades to next tier if escrow ≥ escrowFloor     |
| autoReentry    | OFF     | ≥ 2 cycles      | Re-enters same tier from escrow                   |
| doubleReentry  | OFF     | ≥ 2 cycles      | Upgrade + simultaneous re-entry in source tier    |

### Priority Order (handleCycleOut)

```
1. autoUpgrade  ON  && tierCycles >= 5 && escrow >= escrowFloor  → UPGRADE
2. doubleReentry ON && tierCycles >= 2 && escrow >= 2 × fee      → DOUBLE SEAT
3. autoReentry  ON  && tierCycles >= 2                           → RE-ENTER
4. else                                                          → release to withdrawable
```

### setMemberOptions()

```solidity
function setMemberOptions(
    bool _autoUpgrade,
    bool _autoReentry,
    bool _doubleReentry
) external;
```

### Manual Upgrade (unchanged from V8 Phase 1)

Available from cycle 1. Pays from personal wallet. Does NOT touch escrow or
withdrawable. Member can hold simultaneous positions in source and destination tier.
_resolveDest guard prevents double-registration conflict.

---

## V8.1-4. Escrow Safety System

### Escrow Floor Guard

Auto-upgrade toggle only fires when:
```
escrowBalance[member] >= escrowFloor[tierIndex]
escrowFloor[tierIndex] = escrowFloorMultiplier × nextTierFee
```

Default: escrowFloorMultiplier = 1.2× (DAO-votable: 1.1×, 1.2×, 1.5×, 2.0×)

Ensures member retains buffer after upgrade. Example T1→T2:
- nextTierFee = $25
- escrowFloor = $30
- After upgrade: escrow = $5 minimum (never zero)

### Velocity Gate

Before auto-upgrade fires, keeper checks destination tier velocity.
If destVelocity puts projectedCycleTime > slowModeThreshold → upgrade deferred.
Member continues earning at source tier. Manual upgrade bypasses velocity gate.

### Early Escrow Release (Penalty)

Member may call earlyEscrowRelease() to withdraw escrow before cycle-out.
Penalty: earlyExitPenaltyBPS (default 2000 = 20%) of escrow amount.
Penalty USDC → StabilityFund. Remaining 80% → member withdrawable.
DAO-votable penalty: 1500, 2000, 2500, 3000 BPS.

---

## V8.1-5. Matrix Lifecycle

### Sizes

| Phase          | MATRIX_SIZE | BFS Depth | Members / pair |
|----------------|-------------|-----------|----------------|
| Testnet        | 15          | 4         | 30             |
| Mainnet Launch | 63          | 6         | 126            |
| Scale Phase    | 127         | 7         | 254            |

### Pair States

```
Active     → normal registrations, full earnings
Slow       → registrations continue, velocity discounts active
Paused     → new registrations redirected, existing members still cycle
Draining   → registrationsPaused=true, members exit via cycle-out or idle reclaim
Retired    → zero members, zero active (shell contract, never deleted)
```

### Re-Inflation Rule

A paused pair re-opens when keeper detects velocity recovery
(projectedCycleTime drops below slowModeThreshold). No new pair deployed.
Members who were frozen resume earning as new entries flow back in.

### New Pair Deployment (MatrixFactory)

Factory deploys new MatA+MatB pair only when:
projectedCycleTime < expansionThreshold (default 21 days, DAO-votable)

Factory auto-wires chainNext, registers with TierRouter.registerMatrixPair().

### Cycle-Out Routing Intelligence

On every cycle-out, TierRouter checks source pair velocity vs all active pairs.
If source pair is below slowModeThreshold → re-entry routes to most active pair.
Slow pair drains one member per cycle-out. No forced mid-cycle migration.

---

## V8.1-6. No-Idle-Member Guarantee (Completion Fund)

Every member is guaranteed to complete their cycle within maxMemberWait days.
If organic entries are insufficient, StabilityFund pays a ghost entry.

### Ghost Entry

A synthetic entry that:
- Pays chain pay to BFS ancestors (legitimate earnings)
- Contributes pool portion for the cycling-out member
- Does NOT pay L1/L2/L3 (no real referrer)
- Does NOT pay treasury (sacred)
- Does NOT pay DevOps (not a real operation)
- Cost = (chainBPS + poolBPS) × tierFee / 10000

### maxMemberWait (DAO-Votable)

| Option   | Days | Notes                                     |
|----------|------|-------------------------------------------|
| Aggressive | 14 | High fund spend, best member experience   |
| Default  | 30   | Balanced — recommended starting value     |
| Moderate | 60   | Lower fund spend, members feel delay      |
| Conservative | 90 | Treasury-preserving, members wait long  |

---

## V8.1-7. Stability Fund — 5 Layers

Separate contract. Zero connection to Treasury. Zero shared logic.

### Layer 1 — Pool Micro-Carve (permanent, always active)
- Source: 200 BPS carved from equalization pool on every entry
- DAO-votable: 100, 150, 200, 250, 300 BPS

### Layer 2 — Referral Micro-Carve (activates in slow mode)
- Source: 50 BPS from L1 referral redirected when slow mode active
- Full L1 restored in normal/growth mode
- DAO-votable: 25, 50, 75, 100 BPS

### Layer 3 — Withdrawal Health Fee (always active, on withdrawal)
- Source: 1.5% of any member withdrawal from withdrawable balance
- Counter-cyclical: builds largest reserves during healthy bull runs
- DAO-votable: 0.5%, 1.0%, 1.5%, 3.0%

### Layer 4 — DevOps Contribution (deep deflation only)
- Source: 50 BPS from DevOps BPS when deep deflation active
- Justified: transaction volume genuinely lower during deep deflation
- DAO-votable: 25, 50, 75, 100 BPS

### Layer 5 — Early Exit Penalties (on demand)
- Source: earlyExitPenaltyBPS of any early escrow release or matrix exit
- Counter-cyclical: spikes during bear markets when exits increase
- CNOVA vesting penalties do NOT go here (stay in CNOVA ecosystem)
- DAO-votable penalty: 15%, 20%, 25%, 30%

### StabilityFund.sol Interface

```solidity
contract StabilityFund {
    mapping(uint8 => uint256) public balanceByTier;
    uint256 public stabilityFloor;          // min balance before ghost entries fire

    function receive(uint8 tierIndex, uint256 amount) external;    // called by matrices
    function payGhostEntry(uint8 tierIndex) external;              // keeper only
    function payReentryDiscount(address member, uint256 discount) external; // keeper only
    function withdraw() external;                                  // governance only

    event FundDeposit(uint8 tier, uint256 amount, uint8 layer);
    event GhostEntryFunded(uint8 tier, uint256 cost);
    event DiscountPaid(address member, uint256 discount);
}
```

---

## V8.1-8. Velocity & Deflation System

### Velocity Calculation

```
velocity[tier]         = registrations in last 7 days / 7   (per day)
projectedCycleDays[tier] = MATRIX_SIZE / velocity[tier]
```

### System States

| State        | Condition                           | Actions                                                    |
|--------------|-------------------------------------|-----------------------------------------------------------|
| Growth       | cycle < 21 days                     | Factory expansion armed                                   |
| Normal       | 21–85 days                          | Standard operation, all toggles active                    |
| Slow         | 85–180 days                         | Layer 2 stability carve active, re-entry discount 20%     |
| Deflation    | 180–300 days                        | All failsafes, Layer 4 active, re-entry discount 50%      |
| Deep Deflation | > 300 days                        | Maximum response, ghost entries priority, discount 70%    |

### DAO-Votable Velocity Thresholds

| Parameter            | Options (days)           | Default |
|----------------------|--------------------------|---------|
| expansionThreshold   | 14, 21, 30               | 21      |
| slowModeThreshold    | 60, 85, 120              | 85      |
| deflationThreshold   | 120, 180, 240            | 180     |

---

## V8.1-9. DAO Governance — Enumerated Parameters

All governance parameter changes select from a fixed menu. Setters revert if value
not in allowed set. No freeform values — prevents governance attacks.

### Process
1. Any CNOVA holder above minimum stake proposes an option from the menu
2. 72-hour voting window, weighted by CNOVA balance
3. Passes with quorum + majority → enters 48-hour timelock
4. Keeper executes on-chain — no individual can override

### Full Parameter Menu

| Parameter              | Options                            | Default |
|------------------------|------------------------------------|---------|
| maxMemberWait          | 14, 30, 60, 90 days               | 30      |
| idleReclaimThreshold   | 60, 90, 120, 180 days             | 90      |
| slowModeThreshold      | 60, 85, 120 days                  | 85      |
| deflationThreshold     | 120, 180, 240 days                | 180     |
| expansionThreshold     | 14, 21, 30 days                   | 21      |
| escrowFloorMultiplier  | 1.1×, 1.2×, 1.5×, 2.0×           | 1.2×   |
| treasuryReserveFloor   | 10%, 25%, 40%                     | 25%     |
| slowModeDiscountBPS    | 1000, 2000, 3000                  | 2000    |
| deflationDiscountBPS   | 3000, 5000, 7000                  | 5000    |
| stabilityFundBPS (L1)  | 100, 150, 200, 250, 300           | 200     |
| referralCarveBPS (L2)  | 25, 50, 75, 100                   | 50      |
| withdrawalFeePct (L3)  | 0.5%, 1.0%, 1.5%, 3.0%           | 1.5%    |
| devopsCarve (L4)       | 25, 50, 75, 100                   | 50      |
| earlyExitPenaltyBPS    | 1500, 2000, 2500, 3000            | 2000    |

---

## V8.1-10. Updated Contract List

### Modified Contracts

```
FigureEightMatrixV8.sol   — Option B BPS, deficit-weighted pool, StabilityFund
                            hook, lastActivityTime, reclaimIdleSlot(),
                            earlyEscrowRelease() with penalty
TierRouter.sol            — 3 toggles, setMemberOptions(), cycle thresholds,
                            escrow floor guard, velocity tracking (7-day rolling),
                            4 deflation states, routing intelligence, withdrawal
                            health fee forwarding, velocity gate before upgrade
deploy_v8.js              — Full 7-tier V8.1, StabilityFund + Factory + Keeper
                            + Governance wiring, Chainlink registration
bigfill_v8.js             — New test scenarios for V8.1 mechanics
CNOVAToken.sol            — V8.1 tier vesting, cycle multiplier, staking boost,
                            early vesting exit → staking pool / burn (NOT StabilityFund)
```

### New Contracts

```
StabilityFund.sol         — 5-layer funding, ghost entries, re-entry discounts,
                            balanceByTier public view, keeper-only spend functions
MatrixFactory.sol         — Permissionless, immutable. Deploys MatA+MatB pairs,
                            wires chainNext, registers with TierRouter
MatrixKeeper.sol          — Chainlink Automation compatible. Velocity monitoring,
                            deflation state machine, ghost entry trigger, idle
                            slot reclaim, Layer 2+4 activation, expansion trigger
V8Governance.sol          — Enumerated DAO params, CNOVA-weighted voting, 72h
                            window, 48h timelock, setter validation
```

### Unchanged Contracts (zero modifications)

```
CNOVATreasury.sol         — Sacred. Only receives treasury BPS. Never called
                            by any V8.1 operational logic.
PairManager.sol           — Reused from V7
CommunityWallet.sol       — Reused/modified separately
MockUSDC.sol              — Testnet only
```

---

## V8.1-11. Build Phase Order

| Phase | Deliverable                                | Blocks         |
|-------|--------------------------------------------|----------------|
| 0     | V8_SPEC.md V8.1 update (this document)    | Everything     |
| 1a    | FigureEightMatrixV8.sol modifications      | Phase 2        |
| 1b    | TierRouter.sol modifications               | Phase 2        |
| 2a    | StabilityFund.sol                          | Phase 2b, 2c   |
| 2b    | MatrixFactory.sol                          | Phase 3        |
| 2c    | MatrixKeeper.sol                           | Phase 3        |
| 3a    | V8Governance.sol                           | Phase 4        |
| 3b    | CNOVAToken.sol V8.1                        | Phase 4        |
| 4a    | deploy_v8.js update                        | Phase 5        |
| 4b    | bigfill_v8.js update                       | Phase 5        |
| 4c    | Deployment guide + Member handbook         | Phase 5        |
| 5     | Base Sepolia testnet deploy + stress test  | GitHub + mainnet |

---

*V8.1 Design Lock — 2026-06-06*
*All parameters in Section V8.1-9 are DAO-votable from their listed menus.*
*Treasury (CNOVATreasury.sol) has zero interaction with any V8.1 operational contract.*
