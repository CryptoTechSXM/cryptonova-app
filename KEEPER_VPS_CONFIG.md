# VPS Keeper Config Reference — 167.99.0.250 (`/root/keeper/`)

*Captured 2026-07-25 during the V8.44 go-live. **Secrets are intentionally redacted
as `xxx` — never store real keys in this repo or paste them into a session.**
Only non-secret values (addresses, IDs, filenames, thresholds) are recorded here.*

## Access

```powershell
ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250
```
File copy:
```powershell
scp -i C:\Users\CryptoTech\.ssh\do_keeper <local-file> root@167.99.0.250:/root/keeper/
```

## `/root/keeper/.env` — shape (values redacted)

| Key | Value / note |
|-----|--------------|
| `BASE_SEPOLIA_RPC_URL` | Alchemy Base Sepolia endpoint (private URL — treat as secret) |
| `ADDRESSES_FILE` | **must match the live deploy** → `deployed_addresses_v8_44.json` (was v8_43) |
| `KEEPER_PRIVATE_KEY` | `xxx` — signs keeper upkeep txs |
| `DISTRIBUTOR_PRIVATE_KEY` | `xxx` — OnrampRewardPool distributor |
| `DEPLOYER_PRIVATE_KEY` | `xxx` — **must be the wallet that OWNS the deployment** (V8.44: 0xCd0Af6a4116f2062c1594aDf34c1821D45175506) |
| `FILL_MNEMONIC` | `xxx` — BIP-44 seed for stress/bigfill test wallets |
| `GITHUB_TOKEN` | `xxx` — used by the bug-report → repo commit flow |
| `TELEGRAM_BOT_TOKEN` | `xxx` |
| `TELEGRAM_CHAT_ID` | `-1003929944148` (ops/alerts group) |
| `TELEGRAM_ANNOUNCE_CHANNEL_ID` | `-1003833364004` (community announcements) |
| `ONRAMP_POOL_ADDRESS` | `0x387055f332C5558a2439D76FfFB4a5A3EbABc4EA` |
| `PARKED_WARN` | `200` — alert threshold on parked count |
| `ROUND_ROBIN` | comma-separated referrer rotation list, starts `0x19a59fbD6d2c1289668795D41453e1505B7B8102,0x1D3E33aAFFDb694E5a45d793B6946120467e93A…` (truncated in capture) |

## Post-deploy checklist for this VPS (every deploy)

1. `scp` the new `deployed_addresses_vX_XX.json` into `/root/keeper/`.
2. Update `ADDRESSES_FILE=` in `/root/keeper/.env` to the new filename.
3. Confirm `DEPLOYER_PRIVATE_KEY` resolves to the deployment's owner wallet —
   print the ADDRESS ONLY, never the key:
   ```
   cd /root/keeper && node -e "require('dotenv').config({path:'/root/keeper/.env'}); const {Wallet}=require('ethers'); console.log('KEEPER   :', new Wallet(process.env.KEEPER_PRIVATE_KEY).address); console.log('DEPLOYER :', new Wallet(process.env.DEPLOYER_PRIVATE_KEY).address);"
   ```
4. Reset the stress-ladder state file so it restarts at wallet #0 on fresh matrices
   (identify it first: `ls /root/keeper/ | grep -i state`).
5. Keep the stress cron commented out (`crontab -e`) until the go-live fill phase.

## Known keeper scripts (masters live in `CryptoNite-MT5-Bots/`)

`stress_keeper.js` · `manual_rescue` · `direct` · `frozen_matb` cascade keepers —
all four use the estimateGas ladder (est×1.15 → ×1.05 → est), never static gas
limits, because a full-matrix cascade needs ~15.5M and the public RPC caps tx gas
near 17.8M. Logs: `/root/keeper/stress.log`, diagnostics `/root/keeper/diag_overflow.js`.

## RPC allocation (QuickNode x10, set 2026-08-05 pre-V8.47-go-live)

Keys live ONLY in .env files / index.html - this table maps by app name.
Keeper scripts read BASE_SEPOLIA_RPC_URL (dotenv does NOT override an
already-set env var, so a cron-line prefix pins a keeper to its own endpoint).

| App (QuickNode) | Consumer |
|---|---|
| thrilling-newest-seed | VPS /root/keeper/.env default (rescue keeper + diagnostics) |
| fluent-neat-moon | Windows deploy/ops machine (contracts repo .env) |
| summer-silent-crater | monitor keeper (cron-line BASE_SEPOLIA_RPC_URL= prefix) |
| autumn-rough-sky | stress keeper (cron-line prefix; enabled only at Phase 7.3) |
| fabled-delicate-leaf | spare / bug_manager |
| wiser-proportionate-forest | frontend fallback (RPC_FALLBACK) |
| cosmopolitan-still-fire | frontend pool EP2 |
| newest-cold-isle | frontend pool EP3 |
| side-silent-sheet | frontend pool EP4 |
| frequent-misty-meme | frontend primary (RPC_URL) |

Frontend apps are publicly visible in index.html - set a referrer/domain
allowlist on them in the QuickNode dashboard.
