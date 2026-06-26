# CryptoNova Windows Task Scheduler Reference

**Last updated:** 2026-06-26  
**Active deploy:** V8.26 (Base Sepolia)  
**MatrixKeeper:** `0x3de9c7bD20cC82238BC39c98D7A1aC15dd1280df`

Update this file every time you redeploy or change a keeper script.

---

## Active Tasks (Enabled)

### \CryptoNova Health Report
| Field      | Value |
|------------|-------|
| .bat       | `run_keeper.bat` |
| Script     | `scripts/system_keeper.js` |
| Interval   | Every **15 minutes** |
| Log        | `logs/keeper.log` |
| Purpose    | **Monitor only — no rescue.** Checks SF balance, parked count, gate status, W1 earnings, deployer USDC. Sends Telegram heartbeat (min 15-min gap). `AUTO_RESCUE=false` in `.env` — all rescue is handled exclusively by Rescue Keeper. |
| On redeploy | Addresses load from `ADDRESSES_FILE` in `.env` — no script edit needed. Verify `.env` points to correct `deployed_addresses_v8_XX.json`. |

---

### \CryptoNova Rescue Keeper
| Field      | Value |
|------------|-------|
| .bat       | `keeper_task.bat` |
| Script     | `scripts/direct_keeper.js` |
| Interval   | Every **2 minutes** |
| Log        | none (stdout only via hardhat) |
| Purpose    | **All on-chain rescue work.** Calls MatrixKeeper.checkUpkeep/performUpkeep. Handles: fill escalation, parked wallet rescue, SF ladder. Caps rescue batch at **4** per run — V8.26 rescueDebt path costs ~3.5M gas/item (SF USDC transfer + debt write), confirmed via static-call binary search: 4 items passes, 5 OOGs. Runs every 2 min for fast response. |
| On redeploy | Reads MATRIX_KEEPER from `deployed_addresses_*.json` via `.env` `ADDRESSES_FILE` — no script edit needed. |

---

### \CryptoNova Onramp Keeper
| Field      | Value |
|------------|-------|
| .bat       | `run_onramp_keeper.bat` |
| Script     | `scripts/onramp_keeper.js` |
| Interval   | Every **15 minutes** |
| Log        | `logs/onramp_keeper.log` |
| Purpose    | Polls the distributor wallet for incoming USDC from onramp partners (Transak etc.). Calls `OnrampRewardPool.distributeReward()` when balance is detected. |
| On redeploy | Update `ONRAMP_POOL` address in `onramp_keeper.js` if OnrampRewardPool was redeployed. |

---

### \CryptoNova-V8-Monitor
| Field      | Value |
|------------|-------|
| .bat       | `run_monitor.bat` |
| Script     | `scripts/monitor_v8.js` |
| Schedule   | **Daily at 08:00** (no repeat interval) |
| Log        | `monitor_log.txt` (rotates at 500KB → `monitor_log_prev.txt`) |
| Purpose    | Daily chain health snapshot. Reads all tier matrices, member counts, SF/treasury balances, CNOVA supply. Sends summary to Telegram. |
| On redeploy | Update contract addresses in `monitor_v8.js`. |

---

### \CryptoNite-Git-Sync
| Field      | Value |
|------------|-------|
| Script     | `C:\CryptoNite-MT5-Bots\git_sync.py` (Python) |
| Interval   | Every **30 minutes** |
| Purpose    | Auto-syncs the MT5 trading bots repo to Git. Unrelated to CryptoNova contracts. |
| On redeploy | No action needed. |

---

### \CryptoNiteShadow
| Field      | Value |
|------------|-------|
| Script     | `C:\CryptoNite-DEX-Bots\hyperliquid\run_shadow_hidden.vbs` (VBScript wrapper) |
| Interval   | Every **15 minutes** |
| Purpose    | Runs the Hyperliquid shadow/DEX bot silently in background. Unrelated to CryptoNova contracts. |
| On redeploy | No action needed. |

---

## Disabled Tasks (Stale — Do Not Delete)

### \CryptoNova CRE Keeper Staging
| Field      | Value |
|------------|-------|
| .bat       | `cryptonova-keeper/cre_keeper_task.bat` |
| Script     | `cre workflow simulate` (Chainlink CRE CLI) |
| Interval   | Every 5 minutes (when enabled) |
| Status     | **DISABLED** — Last ran 2026-06-24 |
| Purpose    | Chainlink CRE simulate loop for MatrixKeeper. Validates that `checkUpkeep` returns true and `performUpkeep` would execute. Used during CRE staging/testing before CRE deploy access was granted. |
| Re-enable when | CRE deploy access granted and you want CRE to handle upkeep instead of direct_keeper.js. |

---

### \CryptoNova-CoRescue
| Field      | Value |
|------------|-------|
| .bat       | `corescue.bat` |
| Script     | `scripts/corescue_keeper.js` |
| Interval   | Every 5 minutes (when enabled) |
| Status     | **DISABLED** — Last ran 2026-06-24 |
| Log        | `logs/corescue.log` |
| Purpose    | Co-rescue keeper — supplemental rescue script that ran alongside system_keeper.js when rescue load was high. Superseded by rescue batch logic in direct_keeper.js (capRescueBatch=8). |
| Re-enable when | Rescue queue consistently overflows and direct_keeper.js alone can't clear it. |

---

## Deploy Checklist (addresses that need updating after each redeploy)

After any `deploy_v8.js` run, check these:

- [ ] `.env` — `ADDRESSES_FILE` points to correct `deployed_addresses_v8_XX.json` **(most important — both keepers read from this)**
- [ ] `monitor_v8.js` — update contract addresses block near top of file
- [ ] `onramp_keeper.js` — `ONRAMP_POOL` address (only if OnrampRewardPool was redeployed)
- [ ] Telegram: wait for next Health Report cycle (≤15 min) and verify it shows new MatrixKeeper address

**Quick verify `.env` is pointing at the right file:**
```powershell
Select-String -Path "C:\CryptoNite-Smart-Contracts\CryptoNova\.env" -Pattern "ADDRESSES_FILE"
```

---

## Task Status Quick-Check Command

```powershell
schtasks /query /fo TABLE /tn "\CryptoNova Health Report"
schtasks /query /fo TABLE /tn "\CryptoNova Rescue Keeper"
schtasks /query /fo TABLE /tn "\CryptoNova Onramp Keeper"
schtasks /query /fo TABLE /tn "\CryptoNova-V8-Monitor"
```

Or all CryptoNova tasks at once:
```powershell
schtasks /query /fo LIST | Select-String -Pattern "CryptoNova|CryptoNite" -Context 0,1
```
