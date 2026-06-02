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
**Architecture:** Binary tree, fixed levels, BFS placement  
**Why it failed:**
- Permanent position — root earns from ALL members forever
- Bottom member earns $0 regardless of activity
- Hard ceiling when rows fill
- No cycling, no fairness mechanism

---

### V2 — Auto Re-entry Pool
**Status:** ❌ Deprecated  
**Architecture:** Linear queue with passive re-entry pool  
**Why it failed:**
- Pool accumulated but trigger was dollar threshold, not cycle-based
- No active window — still a growing queue with no fairness
- `setMatrixContract` renamed in treasury (wiring broke)
- Payment splits hardcoded, didn't scale with tiers
- No multi-tier support

---

### V3 — 7-Tier Conveyor Belt (Single Queue)
**Status:** ✅ Complete — deployed on `main` (live site)  
**Architecture:** Single conveyor belt queue per tier, ACTIVE_WINDOW=100  
**Key Features:** 7-tier ladder, chain pay 7 levels, CNOVA epoch rewards, community wallet, whale gate  
**Errors Fixed:** Active window hardcoded, referrer rotation stuck, treasury wiring, `total` scope bug

---

### V4 — Engine Test (W=5, $10 fees)
**Status:** ✅ Complete — deployed on `main`, team tested  
**Architecture:** Single belt per tier, V4 features added  
**Key Features added:**
- Re-entry fee (5%) on-chain
- Epoch-aware CNOVA (re-entry scales with epoch)
- EPOCH_MEMBER_LIMIT=5 (engine test)
- Staged whale gate (2/1/1 engine test, 25/15/5 mainnet)
- Early exit penalty (45/30/15/5/0%)
- Community Wallet fully wired (ICommunityWallet interface)
- `setCommunityWallet` on Treasury

**Errors Fixed:** Community wallet not receiving funds, re-entry fee approval issue, positionOf CALL_EXCEPTION, RPC rate limiting, dashboard detection of BeltManager registration

---

### V5 — Multi-Belt System (W=2 Lightning / W=5 Engine)
**Status:** 🔵 SELF-TESTING — Lightning Test active on `v5` branch  
**Branch:** `v5` → `v5.crypto-nova.app`  
**Architecture:** BeltManager routes T1 across multiple belts, all 7 tiers get BeltManagers  

**V5 Architecture Summary:**
- `BeltManager.sol` — routes registrations across belts, maintains 5-belt buffer
- Multi-belt per tier (7 BeltManagers, one per tier T1-T7)
- Belt keeper bot (`belt_keeper.js`) — auto-deploys new belts when buffer < 5
- Re-entry pool Option B — new joiners pre-fund older belt pools
- `triggerReentry()` — keeps full belts spinning when new members join newer belts
- `registrationCost()` — exact USDC needed including reentry contributions (capped at 3 belts, $1.50 max overhead)
- Auto-upgrade — opt-in, fires automatically on cycle completion
- Dynamic ACTIVE_WINDOW and BELT_MAX (constructor params)
- 10 belts at launch, keeper maintains 5-belt buffer forever
- MAX_BELTS = 1,000 (effectively unlimited)
- Re-entry cap = 3 belts max overhead regardless of scale

**Lightning Test Parameters:**
| Parameter | Lightning | Engine Test | Mainnet |
|---|---|---|---|
| ACTIVE_WINDOW | 2 | 5 | 50 |
| BELT_MAX | 10 | 50 | 500 |
| EPOCH_MEMBER_LIMIT | 5 | 5 | 10,000 |
| Entry fee (T1) | $1 | $10 | $10 |
| Belts at launch | 10 | 10 | 10 |

**V5 Self-Test Bugs Found & Fixed:**
- registrationCost() missing from ABI → added
- Button labels hardcoded "$10" → dynamic from TIER_FEES[1]
- Belt A stops rotating when full → triggerReentry() + pre-funded pool
- Re-entry pool exhausts at scale → Option B (joiner pre-pays, capped at 3 belts)
- CNOVA not minted on BeltManager registration → registerForWithCnova(true)
- ReentrancyGuard double-lock → registerFor → _registerFor internal split
- Registration fails after Belt A fills → registrationCost() returns $1.05 for Belt B
- Belt overview only showing Belt A → fixed flex wrap, all belts show as tiles
- Direct referrals error → only scanned Belt A, now scans all belt matrices
- Dashboard member ID missing for Belt B+ → getUserT1Matrix() helper
- Upgrade card not showing for Belt B+ → reads from user's own belt
- Matrix stats showing frozen Belt A → reads from active belt
- Tier dropdown freezes UI → 3s timeout + async allowance check
- Epoch 9 shows no name → added "Final Frontier"
- AW/whale gate hardcoded values → all dynamic from contract
- 0 CNOVA per entry after epochs → shows "All epochs complete"
- Withdrawal HTTP 429 → needs paid RPC for mainnet

**V5 Testing Protocol:**
- [ ] Self test lightning (2x) — IN PROGRESS
- [ ] Lightning team test (5x)
- [ ] Engine test (W=5, $10) self (2x)
- [ ] Engine test team (5x)

---

### V6 — Matrix + Belt Hybrid (DESIGN PHASE)
**Status:** 🟡 DESIGN COMPLETE — ready to build after V5 testing passes  

**Core concept:** Belt feeds Matrix. Matrix cycles to Belt. Full $10 re-entry. CNOVA mints every cycle.

**Architecture:**
```
External member → BELT (queue, AW=50) → MATRIX (127-member BFS tree)
                                                    ↓
                              Chain pay flows UP BFS tree to ancestors
                                                    ↓
                              Matrix fills → position 1 cycles out
                                                    ↓
                         Back of BELT queue (fair, not priority)
                                                    ↓
                              Wait → re-enter MATRIX at next BFS slot
                                                    ↓ (repeat forever)
```

**V6 Key Design Decisions:**
- **Matrix size:** 127 members (7-level binary tree)
- **Belt active window:** 50 (proportional)
- **Re-entry cost:** FULL $10 (not 5%) — every cycle is a full economic event
- **Each re-entry distributes:** $3 referrer + $4 chain pay + $1.50 treasury + $1 community + $0.50 dev/ops
- **CNOVA mints on every cycle** (new join OR re-entry)
- **Each tier has its own independent 127-member matrix + belt system**
- **Re-entry goes to back of queue** (fair, no priority)

**Earnings per cycle (127-member matrix, 1,000 community, 100/day):**
- Matrix chain pay per stint: $62.69
- Belt cycling per stint: $47.14
- Referrer bonus: $3.00
- Gross per cycle: $112.83
- Re-entry cost: -$10.00
- Net per cycle: $102.83 ✅ (self-sustaining at ALL scales)

**CNOVA Epoch System (V6 update):**
- Both triggers: 1,000 events (joins+re-entries) OR 30 days
- EPOCH_MEMBER_LIMIT = 10,000 (adjusted from 1,000)
- All 8 epochs + Final Frontier (epoch 9 = 1 CNOVA/event until 100M cap)
- Epochs 1-8 distribute: 985,000 CNOVA total (0.98% of 100M)
- Final Frontier: 99M+ CNOVA available at 1/event (takes 1,356 years at 200/day)
- Floor price converges toward $1.50 in Final Frontier (treasury/$1.50 per CNOVA)

**Multi-tier treasury injection (why CNOVA appreciates):**
- T1 ($10): $1.50/event to treasury
- T2 ($25): $3.75/event
- T3 ($50): $7.50/event
- T4 ($100): $15.00/event
- T5 ($250): $37.50/event
- T6 ($500): $75.00/event
- T7 ($1,000): $150.00/event (100x more than T1)
- All tiers active (1,000 each): $21M/yr treasury → floor $14.50 yr1 → $34.85 yr10

**Sustainability proof:**
- 100 members: net $55/cycle ✅
- 1,000 members: net $103/cycle ✅
- 50,000 members: net $3,367/cycle ✅
- Self-sustaining at every scale, indefinitely

**Pending design decisions:**
- [ ] Early bird pricing: $10 (first 500) → $12.50 (501-1,500) → $15 (1,501+)
- [ ] Community test parameters (1 cycle to upgrade, whale gate 1 per tier, CW epoch 30 min)
- [ ] Pricing extra funds split (re-entry pool + community wallet)

---

## MAINNET CHECKLIST (applies to final version)

**Contract constants:**
```
ACTIVE_WINDOW         = 50 (mainnet, vs 2 lightning / 5 engine)
BELT_MAX              = 500 (mainnet, vs 10 lightning / 50 engine)
EPOCH_MEMBER_LIMIT    = 10,000 (adjusted from 1,000)
GENESIS_GATE_THRESHOLD = 25 (mainnet, vs 2 engine)
ELITE_GATE_THRESHOLD  = 15 (mainnet, vs 1 engine)
SPARK_GATE_THRESHOLD  = 5 (mainnet, vs 1 engine)
CW TRANCHE_A_MAX      = 1,000 (mainnet, vs 10 test)
CW MAX_FOUNDERS       = 2,000 (mainnet, vs 20 test)
MATRIX_SIZE           = 127 (V6)
REENTRY_COST          = FULL entry fee (V6, vs 5% V5)
EPOCH_LIMIT           = 10,000 events per epoch
```

**Infrastructure:**
- [ ] Paid RPC (Alchemy/Infura) — public endpoint rate limits on testnet
- [ ] Belt keeper bot running on production server (auto-deploys new belts)
- [ ] Subgraph or indexer for belt/matrix/queue data at scale
- [ ] Admin multisig for owner functions
- [ ] Security audit of BeltManager, TierManager, Treasury, Matrix
- [ ] Emergency pause tested on all contracts

**Testing gates before mainnet:**
- [ ] V5 self test (2x lightning) complete
- [ ] V5 team test (5x lightning) complete
- [ ] V5 self test (2x engine $10) complete
- [ ] V5 team test (5x engine) complete
- [ ] V6 self test (2x lightning) complete
- [ ] V6 team test (5x) complete
- [ ] V6 community test complete
- [ ] All unit tests passing on mainnet config
- [ ] Security review complete

---

## RULES FOR THIS DOCUMENT

1. **Every error found gets added here** — date, description, which test found it
2. **Every fix gets added here** — what changed, which file, what the fix was
3. **No skipping stages** — lightning → engine → community → mainnet in order
4. **Version only advances** when previous version has zero open bugs
5. **Both developer and owner review** this document before each stage

---

*Last updated: V5 self-test in progress | V6 design complete — pending build*
