# V8.6 Deploy Runbook
Generated: 2026-06-09

## Pre-flight (do ONCE before anything)

### Step 0 — clear the git lock (Windows cmd)
```
del C:\CryptoNite-Smart-Contracts\CryptoNova\.git\index.lock
```

### Step 1 — commit & push all v8.6 changes
```
cd C:\CryptoNite-Smart-Contracts\CryptoNova
git add contracts/FigureEightMatrixV8.sol ^
        contracts/StabilityFund.sol ^
        contracts/MatrixKeeper.sol ^
        scripts/deploy_v8.js ^
        scripts/bigfill_v8.js ^
        scripts/predeploy_check.js ^
        scripts/growth_sim.js ^
        test/stress_test_full.js

git commit -m "feat: v8.6 — MATRIX_SIZE=127, all 7 tiers, parked rescue, velocity gate"
git push
```

### Step 2 — run full test suite (all 26 + new stress tests)
```
npx hardhat test
```
Expected: 26+ passing, 0 failing.  If EPERM on artifacts, use:
```
npx hardhat test --config hardhat.tmp.config.js
```

### Step 3 — run predeploy_check
```
npx hardhat run scripts/predeploy_check.js
```
Must show: "All 13 checks passed -- safe to deploy"

---

## Deploy (Base Sepolia)

### Step 4 — deploy fresh v8.6 (all 7 tiers, MATRIX_SIZE=127)
```
npx hardhat run scripts/deploy_v8.js --network baseSepolia
```
This creates `deployed_addresses_v8_6.json`.  Check the output for:
- 7 x PairManager deployed
- 7 x MatA + MatB deployed (14 matrices)
- Velocity gates T2-T7 CLOSED
- MatrixKeeper registered

### Step 5 — paste T4-T7 addresses into index.html
After deploy, copy the T4-T7 addresses from `deployed_addresses_v8_6.json`
into `C:\CryptoNova-App\index.html` ADDRS block, or run:
```
// In browser console after connecting:
fetch('./deployed_addresses_v8_6.json').then(r=>r.json()).then(updateAddrsFromDeployed)
```

### Step 6 — seed W1
```
npx hardhat run scripts/seed_w1.js --network baseSepolia
```

### Step 7 — register MatrixKeeper as Chainlink Automation
- Go to https://automation.chain.link (Base Sepolia)
- Register upkeep: Custom Logic
- Target: matrixKeeper address from deployed_addresses_v8_6.json
- Gas limit: 6,000,000
- Starting LINK: 5 LINK

### Step 8 — seed StabilityFund
Deposit at least $500 USDC into SF (tier 0).
```
npx hardhat run scripts/seed_sf.js --network baseSepolia
```

---

## Stress test

### Step 9 — run stress_test_full.js
```
npx hardhat test test/stress_test_full.js
```
All 5 suites should pass.

### Step 10 — run growth simulation (15 wallets, then idle until 100)
```
N_SEED=15 COMMUNITY_THRESHOLD=100 ADD_INTERVAL_MS=5000 MAX_WALLETS=30 \
  npx hardhat run scripts/growth_sim.js --network baseSepolia
```
Watch for:
- No parked wallets that don't self-rescue
- Velocity gate opens automatically at 80% MatB fill
- No human intervention required

---

## Invite community

Once Step 10 completes cleanly:
1. Deploy updated index.html to Vercel
2. Run growth_sim.js with real timing:
   ```
   N_SEED=0 COMMUNITY_THRESHOLD=100 ADD_INTERVAL_MS=60000 \
     npx hardhat run scripts/growth_sim.js --network baseSepolia
   ```
3. Share link — community registers via index.html

---

## Fee schedule (for reference)

| Tier | Entry Fee | Name                  |
|------|-----------|-----------------------|
| T1   | $10       | Nova Entry            |
| T2   | $25       | Nova Rise             |
| T3   | $50       | Nova Star             |
| T4   | $100      | Nova Prime            |
| T5   | $250      | SuperNova Genesis     |
| T6   | $500      | SuperNova Elite       |
| T7   | $1000     | SuperNova Spark       |

MATRIX_SIZE=127 (2^7 - 1) — complete 7-level BFS binary tree.  
Each cycle-out at T1: 127 entries x some % to root = ~$150+ to root wallet.
