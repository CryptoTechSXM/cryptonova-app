# CryptoNova Snapshot Space — Setup Guide

## Overview

Snapshot is the off-chain signaling layer. Members vote with their CNOVA balance (gas-free).
Winning proposals get submitted on-chain via `governance.html` → V8Governance contract.

Two-phase flow:
1. **Snapshot** — community signals intent (off-chain, gas-free, 7 days)
2. **governance.html** — deployer or any CNOVA holder submits the winning value on-chain (72h vote + 48h timelock)

---

## Step 1 — Get an ENS Name (required for mainnet Snapshot space)

1. Go to **app.ens.domains**
2. Search `cryptonova` — if taken, try `cryptonova-dao` or `cryptonova.eth`
3. Register with your **Deployer wallet** (`0xCd0Af6a4116f2062c1594aDf34c1821D45175506`)
4. Cost: ~$5–15/yr on mainnet

> **Testnet shortcut**: Snapshot supports "demo" spaces without ENS at `testnet.snapshot.org`.
> Use `testnet.snapshot.org/#/cryptonova-testnet` during the testnet phase, then migrate.

---

## Step 2 — Create the Space

1. Go to **snapshot.org** (or testnet.snapshot.org for testnet)
2. Click **Create a space**
3. Connect your Deployer wallet (`0xCd0Af6a4116f2062c1594aDf34c1821D45175506`)
4. Enter your ENS name (or demo handle)
5. Paste in the settings below

---

## Space Settings (copy-paste into Snapshot UI)

```
Name:        CryptoNova DAO
About:       Governance for the CryptoNova 10-tier matrix protocol on Base.
             CNOVA holders vote on protocol parameters — results are executed
             on-chain via the V8Governance contract with a 72h vote + 48h timelock.
Network:     Base (8453)  [use Base Sepolia 84532 for testnet space]
Symbol:      CNOVA
Website:     https://cryptonova.ai
Twitter/X:   (add when available)
```

**Voting Strategy** (add under Strategies):
```json
{
  "name": "erc20-balance-of",
  "network": "8453",
  "params": {
    "address": "CNOVA_MAINNET_ADDRESS",
    "symbol": "CNOVA",
    "decimals": 18
  }
}
```
> Replace `CNOVA_MAINNET_ADDRESS` with the deployed token address after mainnet deploy.
> For testnet space use network `"84532"` and address `"0xEab971fAEc2D2c81EFF732f01E6bDe3eF563cD7c"`.

**Admins** (add under Members → Admins):
```
0xCd0Af6a4116f2062c1594aDf34c1821D45175506   (Deployer)
```

**Proposal threshold**: `1` CNOVA (any holder can propose)
**Quorum**: `200` BPS = 2% of circulating supply (matches V8Governance default)
**Voting period**: `7 days`
**Voting type**: `Single choice`

---

## Step 3 — Post the 3 Seed Proposals

See `snapshot-proposals.md` for the full text of each proposal, ready to paste.

Order to post:
1. **PROP-1** first (housekeeping / introductory)
2. **PROP-2** after PROP-1 goes live
3. **PROP-3** can overlap with PROP-2

---

## After Proposals Pass

For each winning Snapshot vote:
1. Go to **cryptonova.ai → Governance** tab (governance.html)
2. Click **Create Proposal**
3. Select the matching parameter from the dropdown
4. Enter the winning value
5. Submit on-chain — 72h vote opens
6. After vote passes, **Finalize** → wait 48h timelock → **Execute**
