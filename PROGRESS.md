# CryptoNova — Testing Progress & Version Tracker

> **Rule:** Every bug found gets logged here. Every fix gets logged here.
> No version moves forward until all bugs from the previous version are resolved.
> No mainnet until the final version passes ALL stages with zero issues.

---

## Testing Pipeline

```
Self Test (2x) → Lightning Team Test (5x) → Community Test → Mainnet
```

---

## VERSION HISTORY

---

### V1 — BFS Binary Tree Matrix
**Status:** ❌ Deprecated  
**Architecture:** Binary tree, fixed levels  
**Errors Found:**
- Tree structure caused uneven earnings
- Hard to scale past 63 members cleanly
- No cycle tracking
- No tier system

**Decision:** Scrapped. Moved to conveyor belt design.

---

### V2 — V2 Auto Re-entry Pool
**Status:** ❌ Deprecated  
**Architecture:** Linear queue with auto re-entry pool  
**Errors Found:**
- Re-entry pool accumulated but `setMatrixContract` renamed in V4 treasury
- Payment splits hardcoded, didn't scale with tiers
- No multi-tier support
- No epoch system

**Decision:** Kept as legacy test suite reference. Moved to V3.

---

### V3 — 7-Tier Conveyor Belt (Single Queue)
**Status:** ✅ Complete — deployed on `main` (live site)  
**Architecture:** Single conveyor belt queue per tier, ACTIVE_WINDOW=100  
**Key Features:**
- 7-tier ladder ($10 → $1,000)
- Chain pay 7 levels
- CNOVA epoch rewards
- Community wallet (Tranche A/B)
- Whale gate at Tier 5

**Errors Found:**
- Active window filter hardcoded to 64 (fixed → dynamic AW)
- Referrer rotation stuck on member #1 (fixed → round-robin)
- `total is not defined` in loadQueueView (fixed → scoped)
- Community wallet `setMatrixContract` → renamed `setTier1Matrix`

**Improvements carried to V4:**
- Epoch-aware re-entry CNOVA
- Re-entry fee (5%) from withdrawable
- L7 → treasury redirect
- Staged whale gate (25/15/5)
- Early exit penalty (45/30/15/5/0%)

---

### V4 — V4 Engine Test (W=5, BELT_MAX=50)
**Status:** 🟡 ACTIVE — deployed on `main` (live site), team testing  
**Architecture:** Single belt per tier, ACTIVE_WINDOW=5 (engine test)  
**Contracts:** Base Sepolia  
**Key Features added over V3:**
- Re-entry fee (5%) implemented on-chain
- CNOVA epoch-aware (re-entry scales with epoch)
- EPOCH_MEMBER_LIMIT=5 (engine test, mainnet=1000)
- Staged whale gate (2/1/1 engine test, 25/15/5 mainnet)
- Early exit penalty in Treasury
- Community wallet fully wired (deposit + registerFounder)
- ICommunityWallet interface (deposit, registerFounder)
- `setCommunityWallet` on Treasury

**Errors Found During Testing:**
- `awNum is not defined` → fixed, AW fetched dynamically
- Community wallet not receiving funds → ICommunityWallet interface added
- `pendingPool` never updated → `deposit()` called instead of raw transfer
- Referrer pool stuck on account #1 → sessionStorage round-robin
- `setMatrixContract` → `setTier1Matrix` mismatch
- Re-entry fee needed `recordDirectDeposit` push pattern
- `ERC20InsufficientAllowance` on Treasury → `setAuthorizedCaller` added
- `positionOf` CALL_EXCEPTION → defensive try/catch added
- Rate limiting (HTTP 429) → throttled RPC calls with delays
- Redeem USDC failing → `setCommunityWallet` not called in deploy (fixed in deploy script)
- Dashboard not detecting BeltManager registration → BeltManager check added
- Register tab not detecting already-registered → `hasRegistered` check added

**Testing Protocol:**
- [ ] Self test by owner (2x) — IN PROGRESS
- [ ] Team test (5x)
- [ ] Document all remaining bugs before moving to V5

---

### V5 — Multi-Belt System (W=2 Lightning / W=5 Engine)
**Status:** 🔵 SELF-TESTING — Lightning Test (W=2, BELT_MAX=10, $1 fees)  
**Branch:** `v5` on GitHub → `v5.crypto-nova.app` (Vercel)  
**Contracts:** Base Sepolia (Lightning)  

**Architecture changes over V4:**
- BeltManager.sol (NEW) — routes T1 registrations across multiple belts
- Multi-belt per tier (7 BeltManagers, one per tier)
- Belt A-J deployed at launch (10 belts, 5-belt buffer always maintained)
- Belt keeper bot (`belt_keeper.js`) — auto-deploys new belts when buffer drops to 5
- Re-entry pool (Option B) — new joiners pre-fund older belt pools
- `triggerReentry()` — keeps full belts spinning when new members join newer belts
- `registrationCost()` — returns exact USDC needed including re-entry contributions
- Auto-upgrade — members opt-in, fires automatically on cycle completion
- `deductWithdrawable` — pulls upgrade fee from earned balance
- Dynamic ACTIVE_WINDOW — constructor param (2 lightning, 5 engine, 50 mainnet)
- Dynamic BELT_MAX — constructor param (10 lightning, 50 engine, 500 mainnet)
- Re-entry cap = 3 belts — overhead stays at $0.15/$0.50/$1.50 max forever

**Lightning Test Parameters:**
| Parameter | Lightning | Engine Test | Mainnet |
|---|---|---|---|
| ACTIVE_WINDOW | 2 | 5 | 50 |
| BELT_MAX | 10 | 50 | 500 |
| EPOCH_MEMBER_LIMIT | 5 | 5 | 1,000 |
| Entry fee (T1) | $1 | $10 | $10 |
| Belts at launch | 10 | 10 | 10 |
| Re-entry cap | 3 belts | 3 belts | 3 belts |

**Errors Found During V5 Testing:**
- `registrationCost()` missing from BELT_MANAGER_ABI → added
- Button labels hardcoded "$10" → dynamic from `TIER_FEES[1]`
- Belt A stops rotating when full → `triggerReentry()` + pre-funded pool
- Re-entry pool exhausts at scale → Option B (joiner pre-pays) implemented
- `REENTRY_FEE_BPS()` call in `registrationCost()` → confirmed public constant
- Belt B joiner overhead 495% at 100 belts → capped at 3 belts ($1.50 max)
- CNOVA not minted on BeltManager registration → `registerForWithCnova(true)` 
- Registration fails after Belt A fills → Belt B requires $1.05 ($1 + $0.05 reentry) but approval hardcoded at $1 → fixed: all three approval calls now use `registrationCost()` dynamically
- ReentrancyGuard double-lock → `registerFor` → `_registerFor` internal split

**Testing Protocol:**
- [ ] Self test lightning (2x) — IN PROGRESS
- [ ] Lightning team test (5x)
- [ ] Engine test (W=5, $10 fees) self (2x)
- [ ] Engine test team (5x)
- [ ] Document all remaining bugs before V6 or mainnet

---

## PENDING — V5 → MAINNET CHECKLIST

Before ANY mainnet deploy:

**Contract constants to change:**
```
ACTIVE_WINDOW    = 2 (lightning) → 50 (mainnet)
BELT_MAX         = 10 (lightning) → 500 (mainnet)  
EPOCH_MEMBER_LIMIT = 5 → 1,000
GENESIS_GATE_THRESHOLD = 2 → 25
ELITE_GATE_THRESHOLD   = 1 → 15
SPARK_GATE_THRESHOLD   = 1 → 5
CW TRANCHE_A_MAX = 10 → 1,000
CW MAX_FOUNDERS  = 20 → 2,000
```

**Infrastructure:**
- [ ] Belt keeper bot running on production server
- [ ] Paid RPC (Alchemy or Infura) — no more public endpoint rate limits
- [ ] Subgraph or indexer for belt/queue data
- [ ] Admin multisig for owner functions
- [ ] Real USDC address (Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- [ ] Emergency pause tested on all 7 tier matrices

**Testing gates:**
- [ ] V5 self test passed (2x) — lightning
- [ ] V5 team test passed (5x) — lightning  
- [ ] V5 self test passed (2x) — engine (W=5, $10)
- [ ] V5 team test passed (5x) — engine
- [ ] Community test on final version passed
- [ ] Security review of BeltManager, TierManager, Treasury
- [ ] All 106 unit tests passing on mainnet config

---

## RULES FOR THIS DOCUMENT

1. **Every error found gets added here** — date, description, which test found it
2. **Every fix gets added here** — what changed, which file, what the fix was
3. **No skipping stages** — lightning → engine → community → mainnet in order
4. **Version only advances** when previous version has zero open bugs
5. **Both developer and owner review** this document before each stage

---

*Last updated: Testing V5 Lightning — self test in progress*
