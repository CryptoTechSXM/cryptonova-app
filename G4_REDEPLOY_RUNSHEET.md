# G.4 PRIVATE REDEPLOY — RUNSHEET (session 41, 2026-08-25)

**DECIDED (40.6 item 1): redeploy the private gate chain from current source.** Basis in
`V8_50_HANDOFF.md` SESSION 41 STATE. This sheet is the session-specific INSTANTIATION of
`GO_LIVE_RUNBOOK.md` PHASE 0/1 + G.PRE + G.0/G.1 — **the runbook stays the authority on
criteria; if this sheet and the runbook disagree, the runbook wins and this sheet is stale.**

🖥️PS — everything below runs in ONE PowerShell window at
`C:\CryptoNite-Smart-Contracts\CryptoNova`, on branch `v8.1` at `fd61223` or later.
The session env block below is what makes it a PRIVATE deploy — **if the window is lost,
set the block again before ANY further command** (G.PRE-2: a lost `ADDRESSES_FILE` means
`deploy_v8.js` falls back to `.env`, which names the LIVE chain; its exists-guard is the
backstop, not the plan).

## 0. Session env — set FIRST, verify, never touch `.env`

```powershell
$env:ADDRESSES_FILE="deployed_addresses_v8_50_private2.json"
$env:MATRIX_SIZE="127"
$env:DEPLOY_TIERS="1,2,3"
$env:PARKED_GRACE_SECS="300"
```

* **`private2`, not `private` — deliberate.** The 08-21 chain
  (`deployed_addresses_v8_50_private.json`) stays as the MEASUREMENT deployment: G.3's
  closed result and the G.5/G.7 economics of 40.4 are recorded against it, and
  `deploy_v8.js` refuses to overwrite an existing file anyway.
* `PARKED_GRACE_SECS=300` is G.PRE-3 and MANDATORY — at the 86,400 default the fund never
  lends inside the gate window and G.4's queue holds no dear items.
* `DEPLOY_TIERS="1,2,3"` is G.PRE-4: SIZE drives per-item gas, not tier count.

## 1. PHASE 0, with the G.PRE corrections

| Step | Do |
|---|---|
| 0.2 | **DO NOT run as written.** G.PRE-1: back up crontab (`crontab -l > /root/crontab.backup.phaseG`), comment ONLY the three deployer-key lines — `copay_rescue`, `fastlane_rescue`, `system_keeper`. **`direct_keeper` keeps running** (member-facing). Restore the moment 1.1 finishes. |
| 0.3 | `npx hardhat run scripts/whoami.js --network baseSepolia` — expect deployer + ✅ |
| 0.4 | Nonce check as written, twice ~30s apart, same number both times |
| 0.5 | **SKIP.** G.PRE-2 — `.env` is not touched; the session block above replaces this step |
| 0.6 | `npx hardhat run scripts/predeploy_check.js` — must end "safe to deploy" |
| RPC | `node scripts\check_deploy_rpc.js 20` — TWO clean runs minutes apart. ⚠ it reads the endpoint from `.env` ON DISK. Widen `$env:FALLBACK_RPCS` for the long run per G.PRE |

## 2. PHASE 1

| Step | Do |
|---|---|
| 1.1 | `npx hardhat run scripts/deploy_v8.js --network baseSepolia` — banner must show the right deployer AND `addresses file target: deployed_addresses_v8_50_private2.json (does not exist yet)`. 15–30 min, do not interrupt |
| 1.2 | IMMEDIATELY: `git add scripts/deployed_addresses_v8_50_private2.json` + commit (V8.29 was lost by skipping this) |
| — | Restore the VPS crontab NOW (three lines back in, verify with `crontab -l`) |
| 1.3 | `npx hardhat run scripts/check_state.js --network baseSepolia` — T1 MatA occ=1, all else 0 |
| 1.3c | **SKIP.** `testchain_keeper.js` signs as the deployer, so no `setUpkeepCaller` is needed on the gate chain (runbook G.2 note). The "second `upkeepCaller` decision" stays a COMMUNITY-deploy item (40.6 item 4) |
| 1.4 | Integrity gate — run LOCALLY, VPS `.env` untouched: `copy scripts\deployed_addresses_v8_50_private2.json C:\CryptoNova-Keepers\` then `node C:\CryptoNova-Keepers\integrity_check.js` (session `ADDRESSES_FILE` wins over that folder's `.env` — dotenv does not override live env). **Nothing proceeds until INTEGRITY OK** |

## 3. Config read-back — the step the 08-21 chain made necessary

```powershell
node scripts\diag_keeper_work.js
```
It now prints the config it measured under (40.5). **Expect `maxItemsPerUpkeep 1` and
`minGasPerItem 7,500,000`.** Anything else and the deploy did not come from the source you
think it did — STOP and read the chain, not the plan (rule 2; this exact assumption is how
the 08-21 chain sat mislabelled for four days).

## 4. G.1 — fill (burst mode, self-rescue turned DOWN)

```powershell
powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1 -Count 300 -Offset 0 -SelfRescueRate 0.1 -UpgradeRate 0.75 -AddressesFile deployed_addresses_v8_50_private2.json -BatchSize 5 -BatchDelay 8
```
(Only change from the runbook's G.1 line: the addresses file name.) Then **G.1b**:
`node scripts\diag_keeper_work.js` — need `PARKED_RESCUE` in the discovered list; do not
proceed on an empty queue.

## 5. Continue in the runbook at G.2

* G.2/G.3: G.3 is CLOSED (30.12) — re-running on this chain is optional confirmation, not
  required. If run, one `ONE_ITEM=1` pass is the method.
* **G.4 is the point of this redeploy.** Run it against the REWRITTEN criterion (runbook,
  2026-08-25) — cap 1, floor 7.5M, four PASS conditions, `WorkItemFailed` on
  `PARKED_RESCUE` the primary signal. ⚠ That criterion is marked UNVERIFIED: this first
  run should say so and record whether it discriminates.
* **G.5: use the new instrument** — `scripts\g5_sf_ratio.js` (session 41) computes the
  `selfFundedRescues / rescues` ratio the runbook asks for and `model_item_a.js` never
  did (40.4). Pin `FROM_BLOCK` to this chain's deploy block for a whole-of-chain ratio.
* G.6 / G.7 per the runbook, on this chain, quoting THIS chain's `insolvencyFloorBps`.
