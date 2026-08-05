# CryptoNova GO-LIVE RUNBOOK — community-involved deploys (V8.44+)

*Owner-approved order (2026-07-25). Every deploy from now on follows this.
Legend: 🖥️PS = PowerShell in `C:\CryptoNite-Smart-Contracts\CryptoNova` ·
🖥️PS-FE = PowerShell in `C:\CryptoNova-Testnet-App` · 🌐VPS = ssh to 167.99.0.250 ·
🦊 = browser/wallet · 📢 = Telegram/community. One command at a time — wait for
output before the next.*

---

## PHASE 0 — Prep (fresh session, clean head)

**0.1** Start a NEW Claude session with the anchor line from the current plan file.
*Why: full context, no leftover assumptions.*

**0.2** Disable automation. **ALL keepers run on the VPS — nothing is scheduled on the
Windows machine any more (Task Scheduler is retired).**
```powershell
ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250
```
then 🌐VPS:
```
crontab -e
```
Put a `#` in front of EVERY keeper line, save (Ctrl+O, Enter), exit (Ctrl+X). Verify:
```
crontab -l | grep -v "^#"
```
Should print nothing.
*Why: keepers sign transactions; any that fires mid-deploy corrupts the deploy nonce.*

**0.3** Verify the signing wallet:
```powershell
npx hardhat run scripts/whoami.js --network baseSepolia
```
🖥️PS — must print the expected deployer + "✅". `.env` needs `EXPECTED_DEPLOYER=0x...` set.
*Why: catches a stale key swap before it deploys from the wrong wallet (happened 2026-07-25).*

**0.4** Confirm nothing is in flight (run twice, ~30s apart — same number = quiet):
```powershell
Invoke-RestMethod -Uri https://sepolia.base.org -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionCount","params":["0xCd0Af6a4116f2062c1594aDf34c1821D45175506","pending"]}'
```
🖥️PS. *Why: a keeper run finishing mid-deploy shifts the nonce.*

**0.5** Edit `.env`: set `ADDRESSES_FILE=deployed_addresses_vX_XX.json` (the NEW version).
*Why: the deploy script WRITES there — pointing at the old file overwrites the old deploy record.*

**0.6** Pre-deploy validation:
```powershell
npx hardhat run scripts/predeploy_check.js
```
🖥️PS — must end "All N checks passed — safe to deploy".

---

## PHASE 1 — Deploy

**1.1** Deploy (15–30 min, do not interrupt):
```powershell
npx hardhat run scripts/deploy_v8.js --network baseSepolia
```
🖥️PS — check the banner shows the right Deployer before letting it run on.

**1.2** IMMEDIATELY commit the addresses file (V8.29 was lost by skipping this):
```powershell
git add scripts/deployed_addresses_vX_XX.json
```
```powershell
git commit -m "Add VX.XX deployed addresses"
```
🖥️PS.

**1.3** Snapshot the fresh state:
```powershell
npx hardhat run scripts/check_state.js --network baseSepolia
```
🖥️PS — expect T1 MatA occ=1 (W1 at root), all else 0.

**1.4 MANDATORY INTEGRITY GATE (added after the 2026-07-26 incident).**
Copy the addresses file + checker to the VPS and run it. **Nothing goes to the
frontend until this says INTEGRITY OK.**
```powershell
scp -i C:\Users\CryptoTech\.ssh\do_keeper C:\CryptoNite-Smart-Contracts\CryptoNova\scripts\deployed_addresses_vX_XX.json root@167.99.0.250:/root/keeper/
```
```powershell
scp -i C:\Users\CryptoTech\.ssh\do_keeper C:\CryptoNova-Keepers\integrity_check.js root@167.99.0.250:/root/keeper/
```
🌐VPS (after setting ADDRESSES_FILE in /root/keeper/.env):
```
cd /root/keeper && node integrity_check.js
```
It verifies, for EVERY matrix: no member in two seats, nothing written above
MATRIX_SIZE, occupancy == real occupant count, and no empty position 1 while full.
**Re-run it hourly during the first day of any release** (or add a cron line) —
V8.44 shipped with all unit tests green and still corrupted a live matrix within
4 hours. Only on-chain state proves the invariants hold under real cascades.

---

## PHASE 2 — Community announcement 📢

Post the announcement: what's improved (member-facing, code-verified claims ONLY),
site goes offline in X hrs, expected return time. Template lives with Claude —
regenerate per version. *Why: community knows the window, expects the reset,
and is primed to test + report.*

---

## PHASE 3 — Frontend on admin

**3.1** Update every hardcoded address + version tag (incl. the Telegram bot — mandatory):
```powershell
python update_addrs_vX_XX.py
```
🖥️PS-FE.

**3.2** Truncation check — ALWAYS FIRST, before blaming RPC/wallet/cache:
```powershell
Get-Content index.html -Tail 5
```
🖥️PS-FE — must end `</body></html>`.

**3.3** Commit and push to admin:
```powershell
git add -A
```
```powershell
git commit -m "chore(VX.XX): update all contract addresses"
```
```powershell
git push origin admin
```
🖥️PS-FE — Vercel builds take 1–3 min.

**3.4** 🦊 Hard refresh `admin.crypto-nova.app` (Ctrl+Shift+R), connect wallet.
Spinners without a wallet connected are normal, not a bug.

---

## PHASE 4 — Owner human test (on admin) 🦊

Register 2–3 of your own test accounts through the UI. Checklist:
- registration completes (V8.44: one popup, options included)
- dashboard shows position, withdrawable, reserve breakdown, toggles
- a withdraw works; numbers match `check_state.js`
*Why: this is the first HUMAN pass — catches wallet/UI issues no simulation finds.
Anything odd → report to Claude before proceeding.*

---

## PHASE 5 — Keepers re-pointed + on (BEFORE go-live)

**5.1** Copy the new addresses file to the VPS (key: `do_keeper`):
```powershell
scp -i C:\Users\CryptoTech\.ssh\do_keeper C:\CryptoNite-Smart-Contracts\CryptoNova\scripts\deployed_addresses_vX_XX.json root@167.99.0.250:/root/keeper/
```
🖥️PS. (VPS login likewise: `ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250`)

**5.2** 🌐VPS: edit `/root/keeper/.env` → `ADDRESSES_FILE=deployed_addresses_vX_XX.json`
and confirm the keeper's key matches the deployment owner wallet.
*Why (V8.44+): keepers must sign as the wallet that owns the contracts — 0xCd0Af6.*

**5.3** 🌐VPS: re-enable the RESCUE / MONITOR keepers only.

> ⚠️ **NEVER restore a crontab backup blindly** (`crontab crontab.*.bak`). Those
> backups are usually taken while stress was RUNNING, so restoring silently turns
> the stress keeper back on — which violates the owner rule that stress stays OFF
> until real members are in and the owner gives the green light (Phase 7.3).
> Caught live 2026-07-26. Restore, then IMMEDIATELY re-comment stress:
> ```
> cd /root/keeper && crontab -l | sed "s|^\*/5 \* \* \* \* flock -n /tmp/stress_keeper.lock|# */5 * * * * flock -n /tmp/stress_keeper.lock|" | crontab - && crontab -l | grep -v "^#"
> ```
> Then confirm the stress line is absent from the active list before moving on.

Or edit by hand with `crontab -e`: un-comment the rescue/monitor lines only.
The STRESS keeper line stays commented out until Phase 7. Verify what is live:
```
crontab -l | grep -v "^#"
```
*Why: rescue automation should be running when real users arrive; synthetic stress
load comes only after go-live. (All keepers are VPS cron jobs — there is no Windows
Task Scheduler in this system.)*

---

## PHASE 6 — Go live

**6.1** Push preview + your quick QA pass (10 min: register, withdraw, status page):
```powershell
git push origin admin:preview --force
```
🖥️PS-FE — set the gate countdown to the go-live time per the usual flag.

**6.2** At window close, push main:
```powershell
git push origin admin:main --force
```
🖥️PS-FE. If Vercel ignores the force-push:
```powershell
git commit --allow-empty -m "trigger deploy"
```
```powershell
git push origin admin:main --force
```

**6.3** 🦊 Hard refresh `crypto-nova.app`, connect wallet, one real registration. LIVE. 📢 announce.

---

## PHASE 7 — Bigfill + monitor (AFTER live, alongside real users)

**7.1** First fill wave (~10 min). **ALWAYS use the wrapper — never call
bigfill_v8.js directly** (its raw defaults enable CNOVA buys/sells/burn, which the
owner rule forbids; see BIGFILL_RULES.md):
```powershell
powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1 -Count 127 -Offset 0
```
🖥️PS — bigfill does FOUR things only: **register, self rescue, manual upgrade,
repeat.** Next wave uses `-Offset 127`, then `-Offset 254`, etc.

**7.2** Snapshot between waves:
```powershell
npx hardhat run scripts/check_state.js --network baseSepolia
```
🖥️PS. **V8.44 watch-list:** MatB `rot` climbing on EVERY pair (the metric that froze at
0 on V8.43); parked count draining (self-rescue + keeper); no member with reserve>0
who is neither seated nor parked (stranded = bug, report immediately).

**7.2b PRE-CHECK before enabling the stress keeper - round-robin referrers.**
The stress keeper spreads L1 commissions across the leader wallets in `ROUND_ROBIN`
(wallet[idx] -> RR[idx % len]), but it SKIPS any address not yet registered on the
CURRENT deployment (`memberHighestTier(addr) > 0`). After a fresh deploy none of them
are registered, so everything defaults to W1 and leaders earn nothing from synthetic
volume. Check how many are live:
```
cd /root/keeper && node -e "require('dotenv').config({path:'/root/keeper/.env'}); const {ethers}=require('ethers'); const fs=require('fs'); const a=JSON.parse(fs.readFileSync('/root/keeper/'+process.env.ADDRESSES_FILE,'utf8')); const p=new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL); const tr=new ethers.Contract(a.tierRouter,['function memberHighestTier(address) view returns (uint8)'],p); (async()=>{ const rr=(process.env.ROUND_ROBIN||'').split(',').map(s=>s.trim()).filter(Boolean); let ok=0; for(const x of rr){ const t=Number(await tr.memberHighestTier(x)); console.log((t>0?'[x] T'+t:'[ ] NOT REGISTERED'), x); if(t>0) ok++; } console.log(ok+'/'+rr.length+' round-robin leaders registered'); })();"
```
Wait until leaders have registered (they are early-access members) before enabling
stress, or accept that W1 absorbs all synthetic L1. The keeper logs the same fact
every run: `RR referrers: X/N registered - rotating`.

**7.3** Once waves look clean: 🌐VPS `crontab -e` and un-comment the STRESS keeper
line. Confirm with `crontab -l | grep -v "^#"`, then watch `/root/keeper/stress.log`
and the deployer's ETH/USDC. Reset `stress_state.json` to wallet #0 first on a fresh
deploy (backup: `stress_state.v8XX.json`).

---

## HARD-WON LESSONS (from the V8.44 go-live, 2026-07-25)

1. **NEVER retype a redacted value into a live file.** Masking secrets when *sharing*
   is right; typing `xxx` into `/root/keeper/.env` destroyed every key on the VPS.
   Rule: `cp .env .env.bak` BEFORE editing, and only ever edit real values.
2. **Rebuild env files with a script, not by hand** —
   `build_keeper_env.ps1` + `finish_keeper_env.ps1` copy values across without
   displaying them, normalise missing `0x` prefixes on private keys, and print a
   `[x]/[ ]` checklist that is safe to paste into chat.
3. **Vercel "Sensitive" env vars can never be read back** (padlock, no eye icon).
   A lost token there = create a new one. Non-sensitive vars CAN be revealed.
4. **PowerShell has no `&&`** — chained commands only work on the VPS (Linux).
   If you see "The token '&&' is not a valid statement separator", you ran a
   Linux command in PowerShell: `ssh` in first.
5. **Scripts must be ASCII-only.** An em-dash in a .ps1 broke the parser
   (the same reason predeploy_check.js bans em-dashes in .sol files).
6. **`C:\` root is admin-protected** — write generated files to `$env:USERPROFILE`.
7. **Notepad appends `.txt`** unless "Save as type: All Files" is selected.
8. **Deployer wallet drift is real.** 2026-07-25 a deploy started under the wrong
   (banned-in-docs) wallet because `DEPLOYER_PRIVATE_KEY` had been swapped for a
   MockUSDC mint. `whoami.js` + `EXPECTED_DEPLOYER` now guard this. Verify wallet
   rules against the CHAIN (`eth_getCode` for 7702 delegation), not just the docs.
9. **Token expiry:** the VPS `GITHUB_TOKEN` (`cryptonova-vps-bug-manager`) expires
   **2026-08-24**. Renew before then or community bug reports stop syncing.
10. **Delete the local upload file** (`%USERPROFILE%\keeper_env_upload.txt`) once
    installed — it holds live keys in plaintext.
11. **Green unit tests are NOT proof of a safe release.** V8.44 passed 400 tests and
    still corrupted a live matrix in 4 hours: the tests covered *routing* (does the
    member land in the right matrix) but never asserted *array integrity* after a
    nested entry. Any change touching entry/rotation MUST be paired with an
    invariant test (occupancy == real occupants, unique seats, nothing above
    MATRIX_SIZE) AND the on-chain integrity gate at 1.4.
12. **Re-entrancy is the hazard in this codebase.** `_cycleOutRoot` calls out to
    TierRouter, which can call straight back into the SAME matrix. Never cache a
    storage value (like `nextSlot`) across such a call — re-read it afterwards.
13. **Stopping a keeper cron does NOT stop a run already in flight.** Comment the
    crontab, then `pgrep -f "node stress_keeper.js"` and wait for it to clear, THEN
    confirm the deployer's pending nonce is stable across two checks before deploying.
14. **Gate the site the moment a live deployment is known-broken.** Members hitting
    failures on contracts you are about to discard costs more goodwill than an
    honest countdown screen. The gate is independent of the deploy — run it first.

## PHASE 8 — Community feedback loop 📢

Real-user bug reports → BUGS.md triage (Claude session) → fix on admin → phases 3–6
again. Bounties: update `paid_usd` in bounties.json at triage.
*This loop is a MAINNET GATE: no mainnet until a full community test cycle on the
final testnet build reports clean — real human testing is part of the release, not
an afterthought.*
