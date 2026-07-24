# CryptoNova — V4 Fix List & Mainnet Prep
*Last updated: 2026-07-23*
*V8.43 is live on testnet (Base Sepolia) — community testing + full-ladder stress run in progress*

---

## 🟠 MAINNET FINDING (2026-07-23) — Full-matrix registration gas cascade

**Observed during V8.43 stress run** (T1 pair 0 at 248 cumulative entries, MatA full 127/127, MatB 115/127):

A registration landing on a **full matrix** measured **~15.45M gas** — vs a routine seat-fill's small fraction of that. Cause: one transaction chains the full rotation cascade — rotate MatA root out → position-weighted pool distribution across 126 seats → root crossing into MatB → (when MatB also full) MatB rotation + its own pool distribution → TierRouter `handleCycleOut` → additive re-entry/upgrade seats. The pool distribution loop over 126 members is the dominant cost and runs once per full-matrix entry.

**Mainnet implications / action items:**
- [ ] Any keeper, bot, or integration that hardcodes a gas limit will start failing exactly when matrices fill (highest-activity moment). Use per-tx `estimateGas` + ≥50% buffer everywhere (stress keeper fixed 2026-07-23 — pattern to copy).
- [ ] Verify frontend register/upgrade/self-rescue paths rely on wallet gas estimation, not fixed limits.
- [ ] Members registering into full matrices pay noticeably more gas than seat-fillers — cheap on Base, but document it (FAQ "why did my gas vary?") to preempt support tickets.
- [ ] **RPC policy cap, not block limit, is the binding constraint.** Measured on Base Sepolia public RPC (sepolia.base.org): block gas limit 1.2B, but the node rejects tx gasLimit somewhere below ~17.8M (`-32003 gas limit too high`; 15.5M accepted, 17.8M rejected). Cascade registrations at est≈15.5M only clear it with an exact-estimate gas limit (keeper now uses a retry ladder: est×1.15 → est×1.05 → est). If worst-case cascade gas (both matrices full + max additive toggles + overflow routing) grows past the public-RPC cap, registrations become impossible for anyone on the default endpoint — frontend included. Measure worst case during this stress run as pairs saturate (375/381); if it approaches ~17M, mainnet needs either a dedicated RPC for the dapp or the V9 pool-loop amortization below.
- [ ] Pull-based pool distribution — pulled INTO V8.44 scope (owner decision 2026-07-24: nothing deferred). Spec in V8_44_PLAN.md section D; resolves this gas finding at the root.

---

## 🔴 V4 CONTRACT FIXES (requires redeployment)
---

## 🔴 V4 CONTRACT FIX — Paid Re-entry

### Re-entry Fee System
**Decision:** $0.50 launch rate → upgrade to $1.00 at 500+ active cycling members

**The problem with free re-entry (V3):**
- Members fully recover $10 entry after ~3 cycles
- Zero incentive to keep recruiting after that
- System can stall — free riders with nothing to lose

**V4 Solution:** Charge a small re-entry fee on every cycle rotation.

**Implementation:**
```solidity
// In CryptoNovaMatrixV3.sol constructor:
uint256 public reentryFeeBps = 500;  // 500 bps = 5% of entry fee ($0.50 for Tier 1)
// Admin can update: setReentryFeeBps(1000) → 10% = $1.00 for Tier 1

// In _enqueue() when rotation happens (matrix full):
if (reentryFeeBps > 0) {
    uint256 reentryFee = (ENTRY_FEE * reentryFeeBps) / 10000;
    usdc.safeTransferFrom(rotatedMember, address(this), reentryFee);
    // Split: 70% treasury, 20% original referrer, 10% dev/ops
    uint256 toTreasury = (reentryFee * 70) / 100;
    uint256 toReferrer = (reentryFee * 20) / 100;
    uint256 toDev      = reentryFee - toTreasury - toReferrer;
    treasury.depositReserve(toTreasury);
    _creditMember(members[rotatedMember].originalReferrer, toReferrer);
    usdc.safeTransfer(devWallet, toDev);
}
// NO new CNOVA minted on re-entry — floor price only goes up
```

**Phase 1 — Launch (V4):** `reentryFeeBps = 500` → $0.50 at Tier 1
**Phase 2 — Scale (500+ members):** admin calls `setReentryFeeBps(1000)` → $1.00 at Tier 1

**Economics at $0.50 (Tier 1):**
| | Amount |
|---|---|
| Member re-entry fee | $0.50 |
| Member net per cycle | $2.70 (chain $3.20 - $0.50) |
| → Treasury | $0.35 |
| → Original referrer | $0.10 |
| → Dev/ops | $0.05 |
| Cycles to recover $10 entry | ~3.7× |
| Referrer lifetime (20 cycles) | $5.00 ($3 initial + $2 re-entry share) |

**Important:** Member must approve TierManager (or matrix) for re-entry fee
before rotation. Need to handle approval UX or use pre-approved allowance.
Recommend: member approves `MAX_UINT` once on registration.



### 1. TierManager — Public Tier1 Sync
**Issue:** Members who register directly on Tier 1 matrix have `memberTier=0` in TierManager,
blocking them from calling `upgradeTier()`. Admin must manually run sync script.

**Fix:** Add public `syncTier1(address member)` to TierManager:
```solidity
function syncTier1(address member) external {
    require(memberTier[member] == 0, "TM: already synced");
    require(IMatrix(matrices[1]).members(member).isRegistered, "TM: not in Tier 1");
    memberTier[member] = 1;
    tierJoinedAt[member][1] = block.timestamp;
    emit TierUpgraded(member, 0, 1, 0, 0);
}
```

**Workaround for V3:** Run `scripts/sync_tier1_members.js` after every batch of registrations.
Auto-sync bat: `scripts/auto_sync.bat` runs every 5 minutes.

---

### 2. CNOVA Minting — Flat 50 per Tier Upgrade
**Issue:** Current tierCnovaRate is proportional to fee — Tier 2 mints 1,250 CNOVA, Tier 7 mints 20,000.
This floods supply and kills floor price appreciation.

**Fix:** Change constructor rates to produce flat 50 CNOVA per upgrade:
```solidity
tierCnovaRate[2] = 2 * 1e18;    // 2 CNOVA/$ × $25  = 50 CNOVA
tierCnovaRate[3] = 1 * 1e18;    // 1 CNOVA/$ × $50  = 50 CNOVA
tierCnovaRate[4] = 5e17;        // 0.5 CNOVA/$ × $100 = 50 CNOVA
tierCnovaRate[5] = 2e17;        // 0.2 CNOVA/$ × $250 = 50 CNOVA
tierCnovaRate[6] = 1e17;        // 0.1 CNOVA/$ × $500 = 50 CNOVA
tierCnovaRate[7] = 5e16;        // 0.05 CNOVA/$ × $1000 = 50 CNOVA
```
**Price impact:** Every tier upgrade pumps treasury massively but only adds 50 CNOVA to supply → floor price rises sharply with whale upgrades.

---

### 3. ACTIVE_WINDOW — Community Feedback on Size
**Current:** 64 slots (confirmed working, rotations verified)
**Discussion:** 25, 50 options also valid. Settle before V4 deploy.

---

## 🟡 V4 FRONTEND FIXES (no contract change needed)

### 4. Queue Viewer — Show Only Active 64 Positions
**Issue:** Queue shows all members by join order. Should show only the 64 currently active positions.
**Fix:** Filter queue table to show `positionOf(addr) > 0 && positionOf(addr) <= 64` only,
sorted by queue position not join order.

### 5. Per-Tier Cycles in Dashboard
**Issue:** Dashboard per-tier earnings shows cycles but only for tiers member has reached.
**Request:** Show cycle progress clearly for each tier — how many done, how many needed.

### 6. Tier Upgrade Referrer
**Status:** ✅ Fixed in V3 — auto-fills from Tier 1 referrer, locked read-only.

### 7. Load Queue Error
**Issue:** Intermittent `0x76e92559` error on Load Queue. Cause unknown — may be RPC timeout.
**Monitor:** Watch if it persists with more members.

---

## 🟢 V3 CONFIRMED WORKING (do not change)

- [x] 7-tier ladder deployed — Nova Seed → SuperNova Spark
- [x] ACTIVE_WINDOW=64 — rotations confirmed at 65th join
- [x] Cycle-gated upgrades (1-2-2-2-3-3) enforced at contract level
- [x] Whale gate (25 SuperNova Genesis unlocks fast-track)
- [x] Founding member pool (50 members, round-robin rotation)
- [x] Queue position display in My Position banner
- [x] My Position shows current queue pos, cycles, earned
- [x] Tier 1 referrer locked on upgrade form
- [x] FAQ accordion working
- [x] Contract addresses verified on BaseScan Sepolia
- [x] 42/42 unit tests passing
- [x] Auto-sync script running every 5 min

---

## 📋 V4 DEPLOY CHECKLIST (when ready)

1. [ ] Apply all V4 contract fixes above
2. [ ] Update tests for new tierCnovaRate values
3. [ ] Run 42/42 tests
4. [ ] Keep same CNOVA_ADDRESS from V3 (or fresh — decide)
5. [ ] Deploy V4 to Base Sepolia testnet
6. [ ] Verify all contracts
7. [ ] Update frontend addresses
8. [ ] Run sync script
9. [ ] Community test V4
10. [ ] If all good → Mainnet prep begins

---

## 📋 MAINNET CHECKLIST (after V4 passes)

1. [ ] Fresh deployer wallet (one-time use)
2. [ ] Remove CNOVA_ADDRESS from .env (fresh token)
3. [ ] Set real Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
4. [ ] Update chain ID: 84532 → 8453
5. [ ] Update RPC URL to Base mainnet
6. [ ] Deploy to Base Mainnet
7. [ ] Verify all contracts on BaseScan
8. [ ] Update frontend + push
9. [ ] Admin wallet — dedicated, consider multi-sig
10. [ ] Plan admin renouncement timeline (3-6 months post-launch)


---

## 🔴 V4 CONTRACT FIX — Staged Whale Gate

### Current (V3):
Single threshold: 25 Genesis members → fast-track unlocks ALL top tiers at once.

### New (V4): Staged fast-track unlock
| Threshold reached | Fast-track unlocks |
|---|---|
| 25 members at T5 (Genesis) | Whales can skip directly to T5 only |
| 15 members at T6 (Elite)   | Whales can skip to T5 or T6 |
| 5 members at T7 (Spark)    | Whales can skip to any tier (full fast-track) |

### Implementation in TierManager:

```solidity
// Replace single fastTrackEnabled with staged counters + flags
uint256 public genesisCount;    // members at T5+
uint256 public eliteCount;      // members at T6+  
uint256 public sparkCount;      // members at T7

uint256 public constant GENESIS_GATE = 25;
uint256 public constant ELITE_GATE   = 15;
uint256 public constant SPARK_GATE   = 5;

// Staged unlock flags
bool public t5FastTrackEnabled;  // 25 at Genesis reached
bool public t6FastTrackEnabled;  // 15 at Elite reached
bool public t7FastTrackEnabled;  // 5 at Spark reached (full unlock)

// In upgradeTier() fast-track logic:
// targetTier=5: allowed if t5FastTrackEnabled
// targetTier=6: allowed if t6FastTrackEnabled
// targetTier=7: allowed if t7FastTrackEnabled

// On each tier upgrade, update counters:
if (toTier == 5) {
    genesisCount++;
    if (!t5FastTrackEnabled && genesisCount >= GENESIS_GATE) {
        t5FastTrackEnabled = true;
        emit GenesisGateOpened(genesisCount);
    }
}
if (toTier == 6) {
    eliteCount++;
    if (!t6FastTrackEnabled && eliteCount >= ELITE_GATE) {
        t6FastTrackEnabled = true;
        emit EliteGateOpened(eliteCount);
    }
}
if (toTier == 7) {
    sparkCount++;
    if (!t7FastTrackEnabled && sparkCount >= SPARK_GATE) {
        t7FastTrackEnabled = true;
        emit SparkGateOpened(sparkCount);  // full fast-track now open
    }
}
```

### Frontend changes:
- Whale gate card shows 3 progress bars instead of 1:
  - Genesis Gate: X / 25 🐋
  - Elite Gate:   X / 15 💎
  - Spark Gate:   X / 5  👑
- Dropdown locks each fast-track tier behind its specific gate
- Toast notifications when each gate opens

### Why this works:
- T5 is reachable quickly — 25 people = relatively early
- T6 requires 15 people to have cycled through T5 AND paid $500 entry
- T7 requires 5 real whales who grinded all the way to $1,000
- Each gate opening is a community milestone worth celebrating
- Prevents instant whale rush to T7 at launch


---

## 🔴 V4 CONTRACT FIX — 30-Day Referrer Escrow Window

### Concept
When a recruit upgrades to a tier ABOVE their referrer's current tier,
the referrer commission is held in escrow for 30 days.
- Referrer upgrades within 30 days → claims the pending amount
- 30 days expire without upgrade → amount goes to Community Wallet
- Referrer is a CW founder → earns a small piece back via epoch anyway

### Why it's fair
- Referrer gets a real chance to act
- Creates urgency — recruit's success pulls referrer forward
- No money wasted — always flows somewhere productive
- Community benefits from forfeited commissions

### Implementation in TierManager:

```solidity
struct PendingBonus {
    uint256 amount;
    uint256 deadline;   // block.timestamp + 30 days
    uint8   tier;       // tier the referrer must reach to claim
    bool    claimed;
}

// referrer → tier → pending bonus
mapping(address => mapping(uint8 => PendingBonus)) public pendingReferrerBonus;

// When whale upgrades to toTier and referrer is below toTier:
function _handleReferrerBonus(address referrer, uint8 toTier, uint256 amount) internal {
    if (memberTier[referrer] >= toTier) {
        // Referrer is already in this tier — pay immediately
        _creditMember(referrer, amount);
    } else {
        // Referrer is behind — escrow for 30 days
        pendingReferrerBonus[referrer][toTier] = PendingBonus({
            amount:   amount,
            deadline: block.timestamp + 30 days,
            tier:     toTier,
            claimed:  false
        });
        emit ReferrerBonusEscrowed(referrer, toTier, amount, block.timestamp + 30 days);
    }
}

// Referrer calls this after upgrading to the required tier
function claimPendingBonus(uint8 tier) external {
    PendingBonus storage pb = pendingReferrerBonus[msg.sender][tier];
    require(pb.amount > 0,      "Nothing to claim");
    require(!pb.claimed,        "Already claimed");
    require(block.timestamp <= pb.deadline, "Expired — sent to community");
    require(memberTier[msg.sender] >= tier, "Upgrade first");
    pb.claimed = true;
    _creditMember(msg.sender, pb.amount);
    emit ReferrerBonusClaimed(msg.sender, tier, pb.amount);
}

// Anyone can sweep expired bonuses to Community Wallet
function sweepExpiredBonus(address referrer, uint8 tier) external {
    PendingBonus storage pb = pendingReferrerBonus[referrer][tier];
    require(pb.amount > 0 && !pb.claimed, "Nothing to sweep");
    require(block.timestamp > pb.deadline, "Not expired yet");
    pb.claimed = true;
    usdc.safeTransfer(communityWallet, pb.amount);
    emit ReferrerBonusExpired(referrer, tier, pb.amount);
}
```

### Frontend — Dashboard Pending Commissions Card:
```
💰 Pending Referrer Bonuses
┌─────────────────────────────────────────────────┐
│  $75.00  from whale recruit → Nova Genesis (T5) │
│  ⏳ 27 days remaining                            │
│  [Upgrade to T5 to Claim]                        │
├─────────────────────────────────────────────────┤
│  $150.00 from whale recruit → Nova Elite (T6)   │
│  ⏳ 14 days remaining                            │
│  [Upgrade to T6 to Claim]                        │
└─────────────────────────────────────────────────┘
```
- Red urgency when < 7 days
- Auto-sweep button for expired entries
- Toast notification when new pending bonus arrives

### Events needed:
- `ReferrerBonusEscrowed(referrer, tier, amount, deadline)`
- `ReferrerBonusClaimed(referrer, tier, amount)`
- `ReferrerBonusExpired(referrer, tier, amount)`  ← goes to CW


---

## 🔴 V4 CONTRACT FIX — ACTIVE_WINDOW = 50

### Decision
Change `ACTIVE_WINDOW` from 64 → 50.

**Why 50:**
- Round number — easy to explain: *"50 people join after you = 1 cycle"*
- Fast cycles (10 days at 5 joins/day vs 13 days at W=64)
- Only $0.08 less per cycle vs W=100 — negligible
- Combined with L7 ramp-up redirect (see below), treasury still wins

**Contract change:**
```solidity
uint256 public constant ACTIVE_WINDOW = 50;  // was 64
```

**Test updates required:**
- `slice(0, 63)` → `slice(0, 49)`
- `members[63]` → `members[49]`
- `withArgs(alice.address, 1n, 63n)` → `withArgs(alice.address, 1n, 49n)`
- `to.equal(64n)` → `to.equal(50n)`

---

## 🔴 V4 CONTRACT FIX — L7 Ramp-up → Treasury (not devWallet)

### Decision
At W=50, L7 chain pay NEVER finds an ancestor (max position = 51, L7 needs 64 back).
Currently: 80% of L7 ramp-up → devWallet (orphaned, not useful to community).
Fix: redirect L7 ramp-up 80% → Treasury reserve instead.

**Why it matters:**
- +$4.00 treasury per Tier 1 cycle (50 joins × $0.08)
- +$100.00 treasury per Tier 5 cycle
- +$400.00 treasury per Tier 7 cycle
- Over 1,000 mixed-tier joins: +$562 extra treasury
- Floor price improvement: +$0.011 per CNOVA at 1,000 join scale
- Dev still earns 3% SPLIT_DEV on every join — main income unchanged

**Contract change in `_distributeChainPay()`:**
```solidity
// Current (ramp-up sends to dev):
if (ancestorPos < 1) {
    usdc.safeTransfer(devWallet, toEarn);
    treasury.depositReserve(toTreasury);
}

// V4 (ramp-up sends to treasury):
if (ancestorPos < 1) {
    // Redirect member portion to treasury instead of dev
    treasury.depositReserve(toEarn + toTreasury);  // full level amount to treasury
}
```

**Note:** Only applies to levels where ancestor doesn't exist (ramp-up).
Normal chain pay (ancestor exists) is unchanged: 80% member, 20% treasury.

---

## 🔴 V4 CONTRACT FIX — Re-entry Fee $0.50 (5% of entry fee)

### Decision
Launch with 5% re-entry fee (= $0.50 at Tier 1, scales per tier).
Upgrade to 10% ($1.00) when 500+ members actively cycling.

*(Full spec already documented above in "Paid Re-entry" section)*

---

## 📊 V4 Combined Floor Price Improvement Summary

All three changes together vs current V3:

| Change | Treasury benefit | Notes |
|--------|-----------------|-------|
| W=50 (from 64) | Faster cycles → more joins → more treasury | Speed improvement |
| L7 ramp-up → treasury | +$0.08/join at T1, up to +$8/join at T7 | Free redirect |
| $0.50 re-entry fee | +$0.35/re-entry at T1, up to +$35/re-entry at T7 | New revenue stream |

Combined: CNOVA floor supported by 3 streams instead of 1.
New entries + tier upgrades + re-entries ALL push floor price up.


---

## 🔴 V4 CONTRACT FIX — CNOVA Minting on Re-entry (C+E Hybrid)

### Decision
Mint CNOVA as incentive on every cycle re-entry using the C+E hybrid formula.
Protected by a minimum floor guard to prevent early dilution.

### Formula: max(C, E) per tier
- **C** = 1 CNOVA per $1 of re-entry fee (proportional)
- **E** = tier number × 2 CNOVA (rewards tier commitment)
- **Hybrid** = whichever is larger

| Tier | Re-entry fee | C | E | **Minted** | Neutral floor |
|------|-------------|---|---|------------|---------------|
| T1 Nova Seed       | $0.50  | 0.5  | 2  | **2 CNOVA**  | $0.175 |
| T2 Nova Rise       | $1.25  | 1.25 | 4  | **4 CNOVA**  | $0.219 |
| T3 Nova Star       | $2.50  | 2.5  | 6  | **6 CNOVA**  | $0.292 |
| T4 Nova Prime      | $5.00  | 5.0  | 8  | **8 CNOVA**  | $0.4375|
| T5 SuperNova Genesis| $12.50| 12.5 | 10 | **12.5 CNOVA**| $0.70 |
| T6 SuperNova Elite | $25.00 | 25.0 | 12 | **25 CNOVA** | $0.70  |
| T7 SuperNova Spark | $50.00 | 50.0 | 14 | **50 CNOVA** | $0.70  |

### Why C+E is self-healing
- T5-T7 only cycle after floor naturally exceeds $0.70 from whale upgrades
- T2-T4 only cycle after mid-tier activity pushes floor above their threshold
- T1 is the only brief risk window (floor starts at $0.046, needs $0.175)

### Floor Guard — the safety net
```solidity
// In CryptoNovaMatrixV3.sol or TierManager:
uint256 public minReentryMintFloor = 100_000; // $0.10 in 6-decimal USDC

function _mintReentryReward(address member, uint8 tier) internal {
    if (treasury.floorPrice() < minReentryMintFloor) return; // skip if floor too low
    
    uint256 reentryFee    = (ENTRY_FEE * reentryFeeBps) / 10000;
    uint256 feeDollars    = reentryFee / _unit;
    uint256 cOption       = feeDollars * 1e18;               // 1 CNOVA per $1
    uint256 eOption       = uint256(tier) * 2 * 1e18;        // tier × 2
    uint256 mintAmount    = cOption > eOption ? cOption : eOption;
    
    cnova.mintDirect(member, mintAmount);
    emit ReentryMintRewarded(member, tier, mintAmount);
}

// Admin can adjust minimum floor threshold
function setMinReentryMintFloor(uint256 floor) external onlyOwner {
    minReentryMintFloor = floor;
}
```

### Behaviour below/above floor guard:
- **Floor < $0.10:** Re-entry happens, fee collected, treasury grows. No CNOVA minted.
- **Floor ≥ $0.10:** Re-entry happens, fee collected, treasury grows. CNOVA minted! 🎉
- Floor guard crossed automatically as system grows — no admin action needed.

### Phase upgrade path:
Once floor is consistently above $0.10 and system is stable:
- Admin can lower `minReentryMintFloor` to $0.05 to activate earlier
- Or raise to $0.20 if community wants stricter protection

### Events needed:
- `ReentryMintRewarded(address member, uint8 tier, uint256 amount)`
- `MinReentryMintFloorUpdated(uint256 oldFloor, uint256 newFloor)`


---

## 📋 V3 FRONTEND FIXES — Document for V4 Carry-Forward

These were fixed in V3 frontend (JS only) but should be properly implemented
in V4 contracts/architecture where applicable.

### FE-01: Referrer Pool — On-chain Index
**Issue:** `fallbackRoundRobin` counter reset to 0 on every page load → member #1 selected too often.
**V3 Fix:** Use `totalMembers() % poolSize` as index — on-chain, consistent across all browsers.
**V4 Note:** Consider moving founding member pool selection fully on-chain in TierManager.
`effectiveReferrer = foundingPool[totalJoined % foundingPoolSize]`

### FE-02: Conveyor Belt Card — Personal Cycle Tracking
**Issue:** "Next Cycle At" showed global rotation, not user's personal cycle.
**V3 Fix:** Added "Your Next Cycle" using `positionOf(userAddr)` + totalMembers.
Formula: `mem < 65 ? (64 + queuePos) : (totalMembers + queuePos)`
**V4 Note:** Contract should expose `myNextCycleAt(address)` view function for cleaner reads.

### FE-03: Pre-full Window Rotation Math
**Issue:** Tiers with < 64 members showed wrong "next rotation" (said +1 when actually needs 65 total).
**V3 Fix:** `nextRot = mem < 65 ? 65 : mem + 1`
**V4 Note:** Confirm formula holds with W=50.

### FE-04: CNOVA Supply Display
**Issue:** `totalSupply` showed "—" because it was batched with other calls that could fail silently.
**V3 Fix:** Added separate try/catch fetch for `totalSupply` independent of main batch.
**V4 Note:** Architecture should not batch unrelated RPC calls that can mask failures.

### FE-05: Tier-Aware Cycle Tracking
**Issue:** Conveyor Belt card hardcoded to Tier 1 only.
**V3 Fix:** Added tier dropdown — reads `positionOf`, `totalMembers`, `cyclesCompleted` per selected tier.
**V4 Note:** Dashboard should show all tiers the member is in with cycle status per tier.

### FE-06: Upgrade Button State
**Issue:** Step 2 "Upgrade Tier" button froze after Step 1 approval due to missing `doUpgrade` function.
**V3 Fix:** Added `doUpgrade()` with on-click allowance verification.
**V4 Note:** Re-entry fee approval (from V4 paid re-entry) will need same pattern.

### FE-07: Cycle Requirements Reading Wrong Tier
**Issue:** Upgrade card read cycles from Tier 1 matrix regardless of current tier.
**V3 Fix:** `currentMx = matrices[currentTier]` — reads from member's actual current tier.
**V4 Note:** TierManager should expose `cyclesInCurrentTier(address)` as a single view call.

### FE-08: TierManager Sync Gap
**Issue:** Direct Tier 1 registrations bypass TierManager → `memberTier = 0` → upgrade blocked.
**V3 Workaround:** `auto_sync.bat` runs `sync_tier1_members.js` every 5 minutes.
**V4 Fix Required:** Add public `syncTier1(address)` to TierManager (full spec in V4 section above).

### FE-09: Wallet Connect — Stats Not Refreshing
**Issue:** `loadConveyorBeltStats()` ran at page load before wallet connected → showed stale data.
**V3 Fix:** Call `loadConveyorBeltStats()` and `loadHomeStats()` again after wallet connects.
**V4 Note:** All wallet-dependent stats should have a "refresh on connect" pattern.

---

## 📊 V3 TESTING SUMMARY — Issues Confirmed Working

- [x] Registration flow (Tier 1 direct + auto-referrer rotation)
- [x] Queue viewer (64-slot active window, sorted by position)
- [x] Tier upgrade flow (approve → upgrade, sequential gate enforced)
- [x] Cycle-gated upgrades (reads from correct tier matrix)
- [x] My Position (shows current queue position, cycles, earnings)
- [x] Multi-tier dashboard (per-tier earnings + withdraw all)
- [x] My Directs (reads from Tier 1 referrer field)
- [x] FAQ accordion (working, V3 content)
- [x] Auto-sync script (corrected to W=64 contracts)
- [x] Founding member pool rotation (on-chain totalMembers index)
- [x] Conveyor Belt card (tier dropdown, personal + global cycle)
- [x] 126+ rotations confirmed at 191 members (W=64 working)
- [x] CNOVA floor price updating ($0.01 at testnet scale)
- [x] Treasury reserve growing ($772.80 at 191 members)


---

## 🔴 V4 CONTRACT FIX — Idle Account Freeze (45 Days)

### Decision
Accounts inactive for **45 days** get frozen — forfeiting their active queue position.
Previously considered 90 days; 45 days keeps the queue healthier and more active.

### What counts as "activity"?
Any on-chain interaction with the member's address:
- `withdraw()` — claimed earnings
- `upgradeTier()` — moved to next tier
- `register()` in any tier — new registration
- Any referral bonus received (passive — does NOT count)

### What does "frozen" mean?
- Member's position in active queue is released
- They drop to re-entry queue (or removed entirely)
- Earnings stop accumulating
- They can "unfreeze" by making any on-chain interaction (paying a small reactivation fee?)
- Their CNOVA balance and withdrawn USDC are unaffected — only queue position is lost

### Implementation in CryptoNovaMatrixV3:
```solidity
uint256 public constant IDLE_FREEZE_DAYS = 45 days;

// Add to Member struct:
uint256 lastActiveAt;  // updated on every withdraw/register

// In withdraw():
members[msg.sender].lastActiveAt = block.timestamp;

// Add freeze check function:
function isIdleFrozen(address member) public view returns (bool) {
    if (!members[member].isRegistered) return false;
    return block.timestamp > members[member].lastActiveAt + IDLE_FREEZE_DAYS;
}

// In _distributeChainPay() — skip frozen members:
if (!isIdleFrozen(ancestor)) {
    members[ancestor].withdrawable += toEarn;
} else {
    // Redirect to treasury or community wallet
    treasury.depositReserve(toEarn);
}

// Admin can trigger freeze removal of a slot:
function freezeIdleSlot(address member) external onlyOwner {
    require(isIdleFrozen(member), "Not idle");
    // Remove from active window, emit event
}
```

### Why 45 days beats 90 days:
- 45 days = ~1.5 months — reasonable grace period
- Prevents "ghost" accounts holding queue positions indefinitely
- Faster queue turnover = more active members in earning positions
- Frozen members' chain pay redirects to treasury → floor price support
- Members who ARE active benefit from reduced queue congestion

### Reactivation:
- Frozen member can reactivate by paying a small fee (e.g., $1 USDC)
- This resets their `lastActiveAt` and places them at the back of the queue
- Reactivation fee goes to treasury

### Frontend changes needed:
- Show "⚠️ Account freezes in X days" warning in Dashboard
- Show countdown timer when < 7 days remaining
- "Stay Active" one-click button that triggers a small on-chain interaction
- Frozen accounts shown differently in Queue Viewer


---

## 🔴 V4 CONTRACT FIX — Early CNOVA Redemption Penalty

### Decision
Members who redeem CNOVA for USDC within 120 days of first registration pay a penalty.
Clock starts from T1 registration date (`joinedAt`). Applies to ALL CNOVA regardless of when earned.

### Penalty Schedule
| Days Since Registration | Penalty |
|---|---|
| 0–30 days | 45% |
| 31–60 days | 30% |
| 61–90 days | 15% |
| 91–120 days | 5% |
| 121+ days | 0% (penalty-free) |

### Penalty Distribution (80/20 split)
- **80% → Treasury reserve** — recycles back as floor price support; patient holders benefit
- **20% → Community Wallet** — rewards the founding community

### Why it works
- Prevents farm-and-dump: register, get CNOVA, immediately cash out
- Rewards patience: hold 121+ days → full floor price, no penalty
- Every early exit strengthens the floor for remaining holders
- Clock is per-member (T1 joinedAt), not per-CNOVA-token

### Implementation
- `earlyExitPenaltyBps(address member)` view function in CNOVATreasury
- Applied inside `redeemAtFloor()` before USDC transfer
- `EarlyExitPenalty(member, penalty, penaltyBps, toTreasury, toCommunity)` event


---

## 8. Epoch System (V4 Implementation)

### Engine Test Settings
| Parameter | Engine Test | Mainnet |
|---|---|---|
| `EPOCH_MEMBER_LIMIT` | 5 | 1,000 |
| `EPOCH_TIME_LIMIT` | 30 days | 30 days |

> **Change before mainnet deploy:** `EPOCH_MEMBER_LIMIT = 1_000` in `CNOVAToken.sol`

### Re-entry CNOVA: Epoch-Aware (V4)
Re-entry CNOVA rewards now scale with the current epoch, matching the same halving schedule as new-member rewards.

**Formula:**
```
baseAmt = max(1 CNOVA per $1 re-entry fee, tier × 2)
mintAmt = baseAmt × currentEpochReward / 50e18
```

| Epoch | New-member reward | Re-entry scale | Example (T1 re-entry) |
|---|---|---|---|
| 1 | 50 CNOVA | 100% | 2 CNOVA |
| 2 | 40 CNOVA | 80%  | 1.6 CNOVA |
| 3 | 32 CNOVA | 64%  | 1.28 CNOVA |
| 4 | 25 CNOVA | 50%  | 1 CNOVA |
| 5 | 20 CNOVA | 40%  | 0.8 CNOVA |
| 6 | 15 CNOVA | 30%  | 0.6 CNOVA |
| 7 | 10 CNOVA | 20%  | 0.4 CNOVA |
| 8 |  5 CNOVA | 10%  | 0.2 CNOVA |

**Why epoch-aware re-entry:**
- Keeps tokenomics consistent — all CNOVA generation halves at the same rate
- Early members benefit from higher rewards on both joins AND re-entries
- Natural inflation slowdown as the system matures
- Prevents late-joiner re-entry CNOVA from diluting early minters' position

### What does NOT advance the epoch counter
- `mintDirect()` calls (tier upgrade bonuses, re-entry CNOVA) — these use `mintDirect` and bypass the epoch member counter
- Only `mintReward()` calls (T1 registrations) increment `epochMemberCount`
- This is correct: only genuine new member joins should drive epoch halving
