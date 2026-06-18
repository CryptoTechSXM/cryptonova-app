# CryptoNova — Quick Start

## What you have
- `contracts/CNOVAToken.sol` — CNOVA token, 8-epoch proof-of-participation mining
- `contracts/CNOVATreasury.sol` — USDC reserve, rising floor price, burn-to-redeem
- `contracts/CryptoNovaMatrix.sol` — $10 binary BFS matrix, referral system, auto-cycling
- `test/CryptoNova.test.js` — 20 tests covering all core flows
- `scripts/deploy.js` — deploys all 3 contracts in correct order

---

## Step 1 — Install dependencies

Open a terminal, `cd` into this folder, then run:

```bash
cd C:\CryptoNite-Smat-Contracts\CryptoNova
npm install
```

This installs Hardhat, OpenZeppelin v5, ethers, and all test tools.
Takes about 1–2 minutes.

---

## Step 2 — Compile

```bash
npx hardhat compile
```

You should see:
```
Compiled 6 Solidity files successfully
```

---

## Step 3 — Run tests

```bash
npx hardhat test
```

You should see all tests passing:
```
  CryptoNova — Deploy
    ✓ deploys all contracts with correct addresses wired
    ✓ cycle 1 is initialised

  CryptoNova — Registration
    ✓ member #1 registers with no referrer
    ✓ member #2 registers with member #1 as referrer
    ✓ cannot register twice
    ✓ cannot register with an unregistered referrer
    ✓ totalMembers increments correctly

  CryptoNova — Payment splits
    ✓ member #1 entry: ops wallet gets referrer share
    ✓ member #2 entry: referrer (member #1) gets $4.00 in earnings
    ✓ member #2 entry: dev wallet gets $0.30
    ✓ treasury receives $1.50 per entry
    ✓ new member's re-entry pool gets $1.00
    ✓ $10 entry fully accounts for all splits

  ... (20 tests total)

  20 passing
```

---

## Step 4 — Deploy to Base Sepolia (testnet)

### First time setup:
1. Copy `.env.example` to `.env`
2. Fill in your `DEPLOYER_PRIVATE_KEY` (a throwaway wallet, not your main one)
3. Get free Base Sepolia ETH from the faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
4. Get a free BaseScan API key: https://basescan.org/apis
5. Get a free Alchemy Base RPC: https://www.alchemy.com (optional — public RPC works too)

### Deploy:
```bash
npx hardhat run scripts/deploy.js --network baseSepolia
```

Output will show all 3 contract addresses. Copy them into a safe place.

### Verify on BaseScan (so anyone can read the source code):
```bash
npx hardhat verify --network baseSepolia <CNOVAToken address> "<your wallet address>"
npx hardhat verify --network baseSepolia <Treasury address> "<cnova>" "<usdc>" "<your wallet>"
npx hardhat verify --network baseSepolia <Matrix address> "<usdc>" "<cnova>" "<treasury>" "<dev>" "<ops>" "<your wallet>"
```

---

## Step 5 — Deploy to Base Mainnet

Once testnet is solid:

```bash
npx hardhat run scripts/deploy.js --network baseMainnet
```

⚠️ Checklist before mainnet:
- [ ] All 20 tests passing
- [ ] Testnet deploy worked, contracts verified on BaseScan
- [ ] You manually tested register → earn → withdraw on testnet
- [ ] `DEV_WALLET_ADDRESS` and `OPS_WALLET_ADDRESS` are set to real wallets you control
- [ ] Deployer wallet has ~0.01 ETH on Base for gas (usually costs < $0.50 total)

---

## Key numbers (reminder)

| | Amount | % |
|---|---|---|
| Entry fee | $10 USDC | — |
| Referrer bonus | $4.00 | 40% |
| Matrix chain pay (L1–L7) | $3.00 | 30% |
| Your re-entry pool | $1.00 | 10% |
| USDC reserve → floor price | $1.50 | 15% |
| Dev fee | $0.30 | 3% |
| Ops fee | $0.20 | 2% |

Passive cycle earnings (203 fills, zero referrals): **$43.60**
Active earnings (2 referrals): **$51.60** → take home ~$41.60 after re-entry

---

## Contract addresses (fill in after deploy)

| Contract | Testnet | Mainnet |
|---|---|---|
| CNOVAToken | 0xA5F0E0118275225573efbdBfD589930A8d13d7bE | |
| CNOVATreasury | 0x7F31e1569c4910c2eC428B6D0d23300Aa3FCf396 | |
| CryptoNovaMatrix | 0xc4D35A55387Ea239C2a531a821678577e75AFCcD | |
| USDC | 0x32090959aD707f3E4c2e0c29865E74b467a4bDe7 (MockUSDC) | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| Aerodrome Router | N/A | 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 |
| Deployer | 0x661f0864eF647A70c5320DAd891C9E57e00c80Ae | — |
