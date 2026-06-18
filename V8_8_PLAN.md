# V8.8 — Complete Change Audit & Redeploy Plan

*Compiled: 2026-06-10*

---

## Why V8.8

Fresh deploy incorporating every fix found during V8.7 stress testing:
- Gas OOG at MSIZE=127 double cycle-out (15M gas limit)
- Escrow storage removed — orphan fees now grow the community pool
- 141 parked wallets from OOG-era testnet reset to clean state
- MatB occupancy anomaly (128/127) reset to clean state
- Chainlink Automation registered and running (keeper replaces manual forceCross)

---

## Contract Changes Summary

### FigureEightMatrixV8.sol ✅ (committed)

| Change | Detail |
|--------|--------|
| **REMOVE** `escrowBalance` mapping | Storage was only written by orphan routing — now rerouted |
| **REMOVE** `totalEscrowHeld` | Tracking var for removed mapping |
| **REMOVE** `earlyEscrowRelease()` | Nothing to release — escrow always $0 |
| **REMOVE** `EscrowCredited` event | Replaced by `OrphanFeePooled` |
| **ADD** `communityWallet` address + setter | Points to CommunityWallet.sol (deferred to mainnet) |
| **ADD** `noReferrerPoolRouted` | Rename of `noReferrerEscrowRouted` — same ratio logic |
| **ADD** `_forwardToCommunityPool()` | CW.deposit() → SF layer 6 fallback → accountOne fallback |
| **ADD** `OrphanFeePooled` event | Emitted on every community pool deposit |
| **UPDATE** `_routeOrphanFee()` | escrow credit → `_forwardToCommunityPool(poolShare)` |
| **UPDATE** `_getOrphanRoutingRatios()` | Variable rename only — 35/65 swing thresholds unchanged |
| **UPDATE** `_crossToPartner()` | Withdrawable-only crossing (escrow was always $0 anyway) |
| **UPDATE** `_cycleOutRoot()` | Pass `0` for escrow to `handleCycleOut` |
| **UPDATE** `deductForUpgrade()` | `escrowAmt` param kept for ABI compat, logic stripped |
| **UPDATE** `escrowOf()` | Returns 0, now `pure` |

**TierRouter.sol** — zero changes needed. `_computeSplit` already handles `escrow=0` path;
`handleCycleOut` receives `0` from matrix and `_computeSplit` returns `fromEscrow=0, fromWithdrawable=fee`. All paths work.

**MatrixKeeper.sol** — already has `WORK_PARKED_RESCUE` / `_doParkedRescue` / `forceCrossKeeper`.
Just needs Chainlink Automation registration (step 4 below).

---

## Test Suite Status

| File | Status |
|------|--------|
| V8Elevator.test.js | 26/26 passing (June 6) |
| Msize15.test.js | `escrowBalance` → `escrowOf` fix applied ✅ |
| FigureEight.test.js | No escrow refs — unaffected |
| Governance.test.js | No escrow refs — unaffected |
| PairManager.test.js | No escrow refs — unaffected |

**Required before deploy:** Re-run V8Elevator.test.js + Msize15.test.js against V8.8 contract.

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat test test/V8Elevator.test.js --network hardhat
npx hardhat test test/Msize15.test.js --network hardhat
```

---

## bigfill_v8.js Updates Needed

### 1. SCAN_OFFSETS — add all prior offset ranges
```js
// Current (needs update):
const SCAN_OFFSETS = [500, 1000, 1500, 2000, 2500, 3000];

// V8.8 fresh deploy — start fresh, offset 0:
const SCAN_OFFSETS = [];  // clean deploy, no prior wallets to scan
```

### 2. Default COUNT + HDR_OFFSET for V8.8 fresh deploy
```js
const COUNT       = Number(process.env.COUNT       || 250);  // fill both T1 matrices
const HDR_OFFSET  = Number(process.env.HDR_OFFSET  || 0);    // fresh deploy, start at 0
```

### 3. forceCross logic — no change needed
MatrixKeeper handles all parked wallets automatically via Chainlink.
bigfill's manual forceCross section remains as emergency fallback only.

---

## Deploy Sequence (V8.8)

### Step 0 — Pre-deploy checks
```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat test test/V8Elevator.test.js --network hardhat
npx hardhat run scripts/predeploy_check.js --network baseSepolia
```

### Step 1 — Deploy all contracts
```powershell
npx hardhat run scripts/deploy_v8.js --network baseSepolia
```

Produces `deployed_addresses_v8_8.json`. Contracts deployed in this order:
1. MockUSDC (testnet)
2. CNOVAToken
3. CNOVATreasury
4. CNOVABuybackReserve
5. StabilityFund v3 (sfTarget=$300, buybackReserve wired)
6. TierRouter
7. T1–T10 MatrixA + MatrixB × 10 tiers = 20 matrices
8. PairManager × 10
9. MatrixFactory
10. MatrixKeeper
11. V8Governance

Wire calls (all in deploy_v8.js):
- Each matrix: `setTierRouter`, `setPairManager`, `setStabilityFund`, `setBuybackReserve`, `setMatrixKeeper`
- TierRouter: `registerMatrixPair` × 10, `setMatrixKeeper`
- MatrixKeeper: `setTierRouter`, `setStabilityFund`, `setPairManagerForTier` × 10

### Step 2 — Seed W1 as T1 MatA root
```powershell
# Already handled by bigfill_v8.js "Seeding W1" section
# Or manually:
$env:SEED_ONLY="true"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
```

### Step 3 — Fund funder wallet
```powershell
npx hardhat run scripts/fund_funder.js --network baseSepolia
# Needs: 4 ETH + $2500 USDC for 250-wallet run
```

### Step 4 — Register MatrixKeeper with Chainlink Automation

Go to: https://automation.chain.link/base-sepolia

1. "Register new Upkeep" → Custom Logic
2. Contract address: `<matrixKeeper address from v8_8 JSON>`
3. Upkeep name: `CryptoNova-V8.8-Keeper`
4. Gas limit: **6,000,000**
5. Starting balance: **5 LINK** (Base Sepolia testnet LINK from faucet)
6. Check data: `0x` (empty)
7. Register → confirm TX

Verify: `checkUpkeep("0x")` should return `(false, "")` on fresh deploy (nothing to do yet).

### Step 5 — Bigfill run 1 (fill T1 matrices)
```powershell
$env:HDR_OFFSET="0"; $env:COUNT="250"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
```

Expected: 250 registrations, T1 MatA fills to 127, T1 MatB fills toward 127.
W1 T1 cycles should increment. MatrixKeeper handles any parked wallets automatically.

### Step 6 — Bigfill run 2 (drive W1 to T2)
```powershell
$env:HDR_OFFSET="250"; $env:COUNT="200"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
```

Expected: W1 upgrades to T2, T2 MatA occupancy = 1/127.

### Step 7 — Verify full automation
After run 2, **do not run bigfill again for 5 minutes**.

Check Chainlink Automation dashboard:
- Upkeep should show 1+ "Perform Upkeep" executions
- Any parked wallets should have been auto-rescued by the keeper
- Ghost entry logic fires if any matrix slot idles for > `idleSlotTimeout`

```powershell
# Snapshot to confirm:
npx hardhat run scripts/snapshot.js --network baseSepolia
```

### Step 8 — Bigfill run 3 (full T2 stress test)
```powershell
$env:HDR_OFFSET="450"; $env:COUNT="300"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
```

Target: T2 MatA + MatB both fill and cycle. W1 upgrades to T3.

---

## Open Items for Mainnet (Not V8.8)

| Item | Status |
|------|--------|
| CommunityWallet.sol — First-1000 lifetime pool | Deferred — contract exists, needs final spec |
| `setCommunityWallet()` call in deploy_v8.js | Add when CW is ready |
| SF layer 6 label ("orphan community pool") | Minor — label in StabilityFund.sol |
| Whale Gate UI counter ("X/25 Genesis members") | Frontend only |
| Mainnet LINK funding for Chainlink keeper | ~25 LINK for 1 year at low velocity |
| `aerodromeRouter` address in CNOVABuybackReserve | Needs Aerodrome Base mainnet address |
| `triggerBuyback()` unhide on frontend | After mainnet launch |
| CNOVA vesting unlock UI | Month 6 post-launch |

---

## Known Remaining Anomalies (testnet only, not mainnet concerns)

| Anomaly | Root cause | Status |
|---------|-----------|--------|
| T1 MatB occupancy 128/127 on V8.7 deploy | OOG revert incremented occupancy without completing cycle-out | Resets on V8.8 fresh deploy |
| 141 parked wallets on V8.7 deploy | Same OOG-era registrations | Resets on V8.8 fresh deploy |
| W1 still at T1 (V8.7) | MatB anomaly blocked 2nd cycle | Resets — V8.8 stress test confirms upgrade |
| Funder ETH low (0.619 ETH) | Used across prior runs | Fund before V8.8 run: `fund_funder.js` |

---

## Gas Reference (V8.8 / MSIZE=127)

| Scenario | Gas needed | gasLimit to use |
|----------|-----------|----------------|
| Normal registration (no cycle-out) | ~500K | 2M (safe margin) |
| Single cycle-out (MatA full) | ~4.5M | 8M |
| Double cycle-out (both full simultaneously) | ~8.8M | **15M** ← current default |
| forceCross (keeper-initiated) | ~2M | 6M |
| MatrixKeeper performUpkeep (batch) | ~1.5M/item | 6M Chainlink gas limit |

bigfill_v8.js already uses `gasLimit: 15_000_000` — no change needed.

---

## Immediate Next Steps

1. **Remove index.lock + commit V8.8 patch:**
   ```powershell
   Remove-Item "C:\CryptoNite-Smart-Contracts\CryptoNova\.git\index.lock" -Force
   cd C:\CryptoNite-Smart-Contracts\CryptoNova
   git add contracts/FigureEightMatrixV8.sol test/Msize15.test.js
   git commit -m "V8.8: remove escrow, route orphan fees to community pool"
   git push origin v8.1
   ```

2. **Run tests locally to confirm 26/26 still pass**

3. **Deploy V8.8** — Steps 0–4 above

4. **Bigfill runs 1–3** — Steps 5–8 above

5. **Let Chainlink run overnight** — verify no stuck wallets
