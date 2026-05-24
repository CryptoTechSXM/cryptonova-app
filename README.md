# CryptoNova Frontend

## ⚠️ Must be served via HTTP — not opened as a file

MetaMask (and all Web3 wallets) **refuse to inject `window.ethereum`** into `file://` pages for security reasons. If you double-click `index.html`, MetaMask won't detect and the wallet connect button won't work.

### Quickest fix — 2 commands:

```bash
# From the CryptoNova folder
cd frontend
npx serve .
```

Then open **http://localhost:3000** in Chrome.

> `npx serve` downloads and runs the `serve` package automatically — no install needed.

### Alternatives

```bash
# Python (if you have Python 3)
python -m http.server 3000
# then open http://localhost:3000

# VS Code Live Server
# Install the "Live Server" extension, right-click index.html → "Open with Live Server"
```

---

## What's in the dApp

| Tab | What it does |
|---|---|
| **Home** | Live stats: members, floor price, reserve, epoch — reads straight from chain |
| **Register** | Approve $10 USDC + register in one flow, generates your referral link |
| **Dashboard** | Your earnings, CNOVA balance, withdraw button |
| **Matrix** | BFS tree view — load any node or "My Position" |

## Contract addresses (Base Sepolia testnet)

| Contract | Address |
|---|---|
| CryptoNovaMatrix | `0xc4D35A55387Ea239C2a531a821678577e75AFCcD` |
| CNOVATreasury | `0x7F31e1569c4910c2eC428B6D0d23300Aa3FCf396` |
| CNOVAToken | `0xA5F0E0118275225573efbdBfD589930A8d13d7bE` |
| MockUSDC | `0x32090959aD707f3E4c2e0c29865E74b467a4bDe7` |

Explorer: https://sepolia.basescan.org
