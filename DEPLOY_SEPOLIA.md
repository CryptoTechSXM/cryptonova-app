# CryptoNova — Base Sepolia Testnet Deploy Guide

## Pre-flight checklist

### 1. Confirm your .env has these variables set

Open `CryptoNova/.env` and verify:

```
DEPLOYER_PRIVATE_KEY=0x...        # one-time deploy key (has Sepolia ETH)
DEV_WALLET_ADDRESS=0x7fc2158892F14b9A1fB6e39B788d4d08daF49C0a
OPS_WALLET_ADDRESS=0xa23A0492A823a2FfB6D3998dDd487695F5ba4019
ADMIN_WALLET_ADDRESS=0x...        # your admin/owner wallet (can be same as deployer for testnet)
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASESCAN_API_KEY=...              # from basescan.org/apis
USDC_ADDRESS=                     # leave BLANK — MockUSDC will be auto-deployed
```

> **Important:** `USDC_ADDRESS` must be empty/absent on testnet. The script
> auto-deploys MockUSDC and mints 100,000 test USDC to your deployer wallet.

### 2. Fund your deployer wallet with Sepolia ETH

Get free Base Sepolia ETH from:
- https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- https://faucet.quicknode.com/base/sepolia

You'll need roughly **0.05–0.1 ETH** to cover all 9 contract deploys + wiring txs.

---

## Deploy commands

Open a terminal in the `CryptoNova/` folder and run:

```bash
# Step 1 — compile (first time downloads solc ~30s)
npx hardhat compile

# Step 2 — deploy to Base Sepolia
npx hardhat run scripts/deploy_tier_system.js --network baseSepolia
```

The script will print every contract address and save a JSON manifest to:
```
CryptoNova/deployments/tier_system_<timestamp>.json
```

---

## Post-deploy verification (optional but recommended)

After deploy succeeds, verify each contract on BaseScan Sepolia so the
source code is public. Use the addresses printed by the deploy script:

```bash
# Replace each address with the actual deployed address from your manifest

# CNOVAToken
npx hardhat verify --network baseSepolia <CNOVA_ADDRESS> <ADMIN_WALLET>

# CNOVATreasury
npx hardhat verify --network baseSepolia <TREASURY_ADDRESS> \
  <USDC_ADDRESS> <CNOVA_ADDRESS> <ADMIN_WALLET> 1000000

# CryptoNovaCommunityWallet
npx hardhat verify --network baseSepolia <COMMUNITY_ADDRESS> \
  <USDC_ADDRESS> <ADMIN_WALLET>

# Each MatrixV3 (run once per tier, 1-5)
npx hardhat verify --network baseSepolia <MATRIX_TIER1_ADDRESS> \
  <USDC_ADDRESS> <CNOVA_ADDRESS> <TREASURY_ADDRESS> \
  <DEV_WALLET> <OPS_WALLET> <COMMUNITY_ADDRESS> <ADMIN_WALLET> 1000000

# CryptoNovaTierManager
npx hardhat verify --network baseSepolia <TIER_MANAGER_ADDRESS> \
  <USDC_ADDRESS> <CNOVA_ADDRESS> <TREASURY_ADDRESS> \
  <DEV_WALLET> <OPS_WALLET> <COMMUNITY_ADDRESS> <ADMIN_WALLET> 1000000
```

---

## What gets deployed (in order)

| Step | Contract                  | Notes                                      |
|------|---------------------------|--------------------------------------------|
| 1    | MockUSDC                  | Testnet USDC — 100k minted to deployer     |
| 2    | CNOVAToken                | ERC-20, 8 epochs, 100M cap                 |
| 3    | CNOVATreasury             | USDC reserve, backs CNOVA floor price      |
| 4    | CryptoNovaCommunityWallet | 2,000 founder slots, 50/50 payout          |
| 5–9  | CryptoNovaMatrixV3 ×5     | Tiers 1–5 ($10/$25/$50/$100/$250)          |
| 10   | CryptoNovaTierManager     | 7-tier ladder, whale gate, CNOVA bonuses   |

## Wiring (auto, done by script)

- MINTER_ROLE → all 5 matrices + TierManager
- BURNER_ROLE → Treasury
- EPOCH_ROLE  → Tier-1 matrix
- TierManager.setMatrix(1..5)
- CommunityWallet.setAuthorisedRegistrar → all 5 matrices + TierManager

---

## Test the deploy

After deploy, mint some test USDC to a test wallet and call `register()`:

```bash
# Start a hardhat console connected to Sepolia
npx hardhat console --network baseSepolia

# In console:
const usdc = await ethers.getContractAt("MockUSDC", "<MOCK_USDC_ADDRESS>")
const matrix = await ethers.getContractAt("CryptoNovaMatrixV3", "<MATRIX_TIER1_ADDRESS>")
const [signer] = await ethers.getSigners()

// Approve matrix to spend 10 USDC
await usdc.approve(matrix.target, 10_000_000n)

// Register with no referrer
await matrix.register(ethers.ZeroAddress)

// Check position
await matrix.positionOf(signer.address)
```

---

## Mainnet checklist (when ready)

- [ ] Testnet full run complete with no errors
- [ ] All 5 tier upgrades tested manually
- [ ] Community wallet epoch advance tested
- [ ] Set `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` in .env
- [ ] Use a fresh one-time deployer key (never reuse)
- [ ] Deployer has real ETH on Base mainnet for gas
- [ ] Change `--network baseSepolia` → `--network baseMainnet`
