# CryptoNova V8.1 — Deploy Runbook

**Purpose**: Standardized checklist for every deploy cycle (testnet or mainnet).  
**Philosophy**: Testnet is the mainnet dry run. Every step here maps directly to mainnet.  
Keep this file updated when new gotchas are discovered.

---

## Pre-Deploy Checklist (do this first — every time)

### 1. Environment sanity
```powershell
# Confirm .env has all required vars
# DEPLOYER_PRIVATE_KEY  — gas-paying deployer
# W1_PRIVATE_KEY        — accountOne / seed root
# BASESCAN_API_KEY      — for contract verification (optional but useful)
# Do NOT import .env to Vercel — it contains private keys
```

### 2. Run local unit tests — must be 26/26
```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat test test/V8Elevator.test.js
```
**Expected output**: `26 passing` — zero failing.  
If any test fails: **STOP. Fix the contract before deploying.**

Known test coverage:
- S5 auto-cross to T2
- T2 entry fee ceiling ($20)
- epochMintLimit minimum
- earlyUnlock precision + earlyUnlockAll epoch drift

### 3. Run the pre-deploy validator
```powershell
npx hardhat run scripts/predeploy_check.js
```
This script checks constructor arg counts, gasLimit values, ADDRESSES_FILE consistency,
and that no em-dashes appear in Solidity string literals.

---

## Step 1 — Deploy Contracts

```powershell
npx hardhat run scripts/deploy_v8.js --network baseSepolia
```

**What it deploys** (in order):
1. MockUSDC (testnet only — omit by setting `USDC_ADDRESS` env var on mainnet)
2. CNOVAToken
3. CNOVATreasury ← SACRED: never wired to any V8 operational contract
4. StabilityFund v2 — constructor: `(usdc, cnova, admin)` — 3 args
5. TierRouter
6. MatrixFactory
7. MatrixKeeper
8. V8Governance
9. Per tier: PairManagerV8, MatrixA, MatrixB (T1 + T2 for Phase 1)

**Output**: `scripts/deployed_addresses_v8_4.json` (or whatever `ADDRESSES_FILE` is set to)

**What to look for**:
```
✓  MockUSDC deployed:         0x...
✓  CNOVAToken deployed:       0x...
✓  StabilityFund deployed:    0x...
...
✓  All wiring complete
✓  Addresses written to deployed_addresses_v8_4.json
```

**If it fails**:
- `incorrect number of arguments to constructor` on StabilityFund → check line ~176 in deploy_v8.js: must be `[usdcAddr, cnovaAddr, admin]` (3 args)
- `nonce too low` → Hardhat compilation cache + NonceManager drift; try `npx hardhat clean` then redeploy
- Always deploy from scratch — do NOT attempt partial recovery by re-running mid-deploy

**Critical rule — DEPLOY_RULE**:  
After a failed deploy, **always start fresh**. Never use a partial deploy's addresses.  
Increment the ADDRESSES_FILE version (v8_4 → v8_5) so stale files can't be accidentally used.

---

## Step 2 — Seed W1 (Register Account #1 as Root)

W1 must land at **position 1** (root of T1 MatA) so its escrow accumulates orphan fees
and it auto-upgrades to T2 after the first cycle-out.

```powershell
$env:SEED_W1_KEY="0x<w1-private-key>"
npx hardhat run scripts/seed_w1.js --network baseSepolia
```

**What to look for**:
```
✓  W1 registered successfully at position 1
    Tier: T1 | Matrix: MatA | Pos: 1
```

**If W1 is already registered**: script detects and exits cleanly — no double-reg.

**Critical**: W1's approve target is `T1 PairManager` (NOT TierRouter).  
seed_w1.js handles this automatically.

---

## Step 3 — Manual Sign-Ups (Human Factor Test)

Before the automated fill, register **2–5 real wallets** via the frontend.  
This tests:
- Registration flow (approve USDC → register)  
- Dashboard loads correctly after registration  
- CNOVA Mining section shows correct epoch  
- StabilityFund floor price displays  

**Frontend**: Push updated `ADDRS` to index.html first (see Step 5 below).

**Approval target**: T1 PairManager address (NOT TierRouter) — this is shown in the UI.

---

## Step 4 — Bigfill Stress Test

### 4a. T1 Fill (bigfill_v8.js)

```powershell
$env:COUNT="300"; $env:HDR_OFFSET="1500"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
```

**Parameters**:
- `COUNT` — total wallets to register (300 fills T1 multiple times + triggers T2 fill)
- `HDR_OFFSET` — BIP-44 derivation index offset. **Must be fresh** (higher than any prior run's max index). Prior runs:
  - Run 1 (v8_2, wrong contracts): offset 500, ~130 wallets → used indices 500–629
  - Run 2 (v8_3): offset 500–1499 used
  - Run 3 (v8_4): HDR_OFFSET=1500+1800, confirmed W1→T2. Next: 2000.
  - Increment by COUNT each fresh run to avoid `globalJoined` collisions

**SCAN_OFFSETS** (in script):
```js
[500, 1000, 1500, 1700, 1800, 2000, 2500]
```
These are cycle-out scan windows. Always add new HDR_OFFSETs here after each run.

### 4b. T2 Cycle Stress Test (fill_t2.js)

After W1 is confirmed at T2 (bigfill step above), run the T2 cycle test:

```powershell
npx hardhat run scripts/fill_t2.js --network baseSepolia
```

**What it does** (no new wallet registrations needed):
1. forceCross parked T1A wallets one-by-one into T1B
2. Each T1B cross triggers T1B to fill (63+1=64) → T1B fires → root auto-upgrades to T2 MatA
3. Repeat 63 times → T2 MatA fills to 64 → W1 auto-crosses to T2 MatB
4. Continue 63 more → T2 MatA keeps cycling → T2 MatA alumni forceCrossed to T2 MatB
5. T2 MatB fills → W1 cycles out of T2 → `tierCycles(W1,1)` = 1

**Cost**: ~$10 per T1B cross + ~$25 per T2 alumni cross (all from deployer MockUSDC, auto-minted).

**Gas**: 12M per forceCross (some cross calls trigger nested T2 MatA fill — can reach ~8M in one tx).

**If parked T1A wallets exhausted mid-run**:
```powershell
$env:COUNT="200"; $env:HDR_OFFSET="2000"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
# Then re-run fill_t2.js
```

**Success indicator**:
```
SUCCESS  W1 completed full T2 cycle!
W1 tier: T2   T2-cycles: 1
```

**Gas limits** (both set correctly):
- Registration: `gasLimit: 6_000_000`
- forceCross: `gasLimit: 12_000_000` ← must be 12M — 6M caused silent OOG on cycle-out

**What to watch for**:
```
reg  300/300
T1 MatA: 64/64  ✓ (cycle 1 complete)
T2 MatA: X/64   (W1 auto-upgraded here)
forceCross: N crossed
```

**W1 upgrade check** — after bigfill completes, verify on frontend:
- W1 should appear as T2 member
- Dashboard shows T2 MatA position
- `tierCycles(W1, 0)` should be ≥ 1

If W1 is still T1 with cycles=0 after fill → handleCycleOut silently failed (OOG).
**Do not attempt recovery.** Redeploy with fresh addresses version.

**Nonce warnings** — `nonce too low` logs during forceCross are non-blocking.
Script continues and most crosses succeed despite these warnings.

---

## Step 5 — Update Frontend & Push to Vercel

### 5a. Update ADDRS in index.html
After deploy outputs `deployed_addresses_v8_4.json`, copy all addresses into
the `const ADDRS = { ... }` block in `C:\CryptoNova-App\index.html`.

Addresses to update:
```
usdc, cnova, treasury, stabilityFund, tierRouter,
matrixFactory, matrixKeeper, v8Governance,
tiers.T1.pm, tiers.T1.matA, tiers.T1.matB,
tiers.T2.pm, tiers.T2.matA, tiers.T2.matB
```

### 5b. Commit and push
```powershell
cd C:\CryptoNova-App
git add index.html
git commit -m "chore: update ADDRS to v8_4 deploy"
git push origin v8
```

Vercel auto-deploys on push to the `v8` branch. Check Vercel dashboard for
build status. If build fails, check console — usually a syntax error in ADDRS.

**NEVER import full .env to Vercel** — it contains private keys.
Only add non-sensitive vars (RPC URL, network name) via Vercel environment settings.

---

## Mainnet Differences (when the time comes)

| Step | Testnet | Mainnet |
|------|---------|---------|
| USDC | MockUSDC deployed by script | Set `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base) |
| ETH source | Faucet | Real ETH |
| CNOVA | Fresh deploy | Fresh deploy (same) |
| Treasury | Wired for accounting only | Same — NEVER touched operationally |
| ADDRESSES_FILE | deployed_addresses_v8_4.json | deployed_addresses_mainnet.json |
| Vercel | Preview URL | Production domain |
| Bigfill | Run automated stress test | Invite community — no automated fill |

---

## Gotchas Reference (lessons learned the hard way)

### StabilityFund constructor — 3 args, not 2
```js
// CORRECT
deploy(StabilityFund, [usdcAddr, cnovaAddr, admin], "StabilityFund")
// WRONG (old — caused "incorrect number of arguments" error)
deploy(StabilityFund, [usdcAddr, admin], "StabilityFund")
```

### forceCross gasLimit must be 12M
`_distributePool()` burns ~3.5M gas at MATRIX_SIZE=64. With 6M limit only ~2.5M remains
for `handleCycleOut` → OOG. Empty `try {} catch {}` in the contract swallows it silently.
W1 gets stuck at T1 with cycles=0. Fix: forceCross uses `gasLimit: 12_000_000`.

### Empty catch in FigureEightMatrixV8 (lines ~514-520)
```solidity
try ITierRouter(tierRouter).handleCycleOut(...) {} catch {}
```
Any revert inside handleCycleOut is silently swallowed. Always check W1 tier after
bigfill — don't trust the fill log alone.

### lastActivityTime removed from _credit()
Passive credit (pool/chain distributions) is NOT member activity. Updating lastActivityTime
in _credit() caused ~860k extra gas per cycle-out (32 cold SSTOREs). Already fixed in source.

### Wrong addresses file default
bigfill.js and seed_w1.js default to `deployed_addresses_v8_4.json`.
If you deploy to a different filename, pass: `$env:ADDRESSES_FILE="deployed_addresses_vX.json"`

### HDR_OFFSET collisions
Wallets are derived deterministically. Re-using an offset means wallets are already
`globalJoined` — registrations silently skip. Always use a fresh offset higher than
(previous_offset + previous_COUNT).

### NonceManager — no .sync() in ethers v6
```js
// CORRECT
const deployer = new NonceManager(rawSigner);
// WRONG — ethers v6 NonceManager has no .sync() method
await deployer.sync();
```

### NEVER mix rawSigner + NonceManager for same address
Using both `rawSigner.sendTransaction()` and `nonceManager.sendTransaction()` for the
same deployer causes nonce conflicts. Pick one and stick with it per script.

### Em-dashes in Solidity strings
```solidity
// WRONG — causes compilation error
require(false, "this — fails");
// CORRECT
require(false, "this -- succeeds");
```

### TierRouter approval target
Members approve **T1 PairManager** for USDC — NOT TierRouter.
Manual upgrade approves **TierRouter** for USDC.
These are different! seed_w1.js and the frontend handle this correctly.

### TierRouter ABI — tierEntryFees takes uint256, not uint8
```js
// CORRECT
'function tierEntryFees(uint256) external view returns (uint256)'
// WRONG — causes execution reverted
'function tierEntryFees(uint8) external view returns (uint256)'
```

---

## Quick Reference — Key Addresses (v8_3, Base Sepolia)

> After fresh deploy these will be in `deployed_addresses_v8_4.json`.
> Always use the JSON file as source of truth — not this table.

| Contract | v8_3 Address |
|----------|-------------|
| USDC (mock) | 0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a |
| CNOVAToken | 0x2ECB1b19f9B9c41F0F4A83844A176729Abc41a43 |
| StabilityFund v2 | 0x2a994AE149B6CE208909B5Fea5caa35F94e0D2ce |
| TierRouter | 0x394FB648840E2d07324458Af64EA9480D54598a8 |
| T1 PairManager | 0x7e6693b747F5d66e6c7859B8c452C91aA0B7D459 |
| T2 PairManager | 0x09707B188B602ea36Ed870F5C53508A212a532c4 |
| Deployer/Admin | 0xCd0Af6a4116f2062c1594aDf34c1821D45175506 |
| W1 (seed root) | 0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435 |

---

*Last updated: June 8, 2026 — v8_3 deploy cycle*
