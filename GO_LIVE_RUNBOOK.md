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

**1.3c AUTHORIZE THE KEEPER EOA — EVERY DEPLOY (added 2026-08-13).**
`deploy_v8.js` does NOT do this. Since V8.46 item 1, `performUpkeep` is allowlisted
(`upkeepCaller`), so on a fresh deployment the VPS keeper reverts with
`MK: not authorized keeper` on every run — and because the revert data is empty it
looks like out-of-gas, so the keeper silently halves its batch cap and never recovers.
```powershell
npx hardhat run scripts/set_upkeep_caller.js --network baseSepolia
```
The read-back may print `false FAILED` (stale block right after the tx) — re-run it;
`upkeepCaller before: true` is the truth. Verify with `node scripts\diag_keeper_work.js`.

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

## PHASE G.PRE — FOUR THINGS A PRIVATE DEPLOY DOES DIFFERENTLY FROM A COMMUNITY ONE

⛔ **PHASES 0 AND 1 ARE WRITTEN FOR A COMMUNITY DEPLOY. For a PRIVATE gate chain, four of
their steps are wrong.** All four were established on 2026-08-21; handoff 28.2 has the
evidence.

**1. DO NOT DISABLE ALL KEEPERS (contra PHASE 0.2).** The community stays LIVE on the old
build during a private deploy and still needs rescuing. The only real risk is nonce
collision on the DEPLOYING wallet, so pause only the cron lines that sign with it:
```powershell
ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250 "cd /root/keeper && grep -l DEPLOYER_PRIVATE_KEY *.js"
```
Measured 2026-08-21: of 11 active lines, exactly THREE use the deployer key —
`copay_rescue`, `fastlane_rescue`, `system_keeper`. **`direct_keeper`, the main engine,
signs with the KEEPER key and must keep running.** Back the crontab up first
(`crontab -l > /root/crontab.backup.phaseG`), comment only those three, and **restore it
the moment the deploy is done** — that is member-facing service.

**2. DO NOT REPOINT `.env` (contra PHASE 0.5).** `testchain_keeper.js` REFUSES to run when
`ADDRESSES_FILE` matches what `.env` names — an inherited value means nobody chose it, and
`.env` names the LIVE chain by definition. Name the private file in the SESSION instead:
```powershell
$env:ADDRESSES_FILE="deployed_addresses_v8_50_private.json"
```
⚠ That variable lives only in that PowerShell window. If it is lost, `deploy_v8.js` falls
back to `.env` and **overwrites the live addresses record.** Guard every command with it.

**3. `PARKED_GRACE_SECS=300` IS MANDATORY.** The default is 86,400s, and that is the clock
gating LOAN-BACKED rescues — the exact item measurement 1 prices. Left alone, PHASE G waits
a day and looks like "the fund never lends".

**4. `DEPLOY_TIERS="1,2,3"`.** Matrix SIZE drives per-item gas, not tier count, and
discovery's scan is a `checkUpkeep` VIEW that costs no transaction gas. Ten tiers is ~3x the
transactions for zero measurement benefit — and fewer transactions survive a flaky node.

⛔ **AND BEFORE STARTING, CHECK THE CHAIN IS BEHAVING:** `node scripts\check_deploy_rpc.js 20`.
⚠ It reads the endpoint from `.env` ON DISK and **cannot see a session override** — it will
silently report on a different endpoint than hardhat is using. ⚠ Never judge an endpoint by
`eth_blockNumber` alone; that answers from cache while state calls 503. A 503 on state calls
with block height still moving means **check the QuickNode invoice before the code.**

⚠ **IF A TRANSACTION FAILS WITH `gasUsed == gasLimit` AT ~22k RIGHT AFTER A CONTRACT
DEPLOY**, that is out-of-gas from an `estimateGas` priced against an address the node could
not see — not a revert.

⛔ **DO NOT REACH FOR `gasMultiplier`. IT IS A NO-OP AND THIS IS MEASURED (handoff 29.1).**
`hardhat-ethers` sets `gasLimit` itself before sending, so hardhat's `AutomaticGasProvider` —
the only thing `gasMultiplier` configures — never fires. A fixed `gas:` number in the network
config is ignored for baseSepolia too. **`deploy_v8.js` now carries the guard instead**: it
waits for `eth_getCode` to actually return bytecode after each deploy, rejects any estimate
under 30,000 gas for a call that has calldata, asks the node directly when the provider
disagrees, and floors the limit at 300,000. Nothing needs setting for this — it is on.

⛔ **AND THE 503s ROTATE BETWEEN PROVIDERS — CHECK FOR A HEALTHY ENDPOINT, NOT A CULPRIT.**
Measured 2026-08-21 across three runs eight minutes apart: each of three QuickNode endpoints
was healthy at one sample and serving `HTTP 503` on every state call at another, while
`eth_blockNumber` answered 20/20 on all of them throughout, and Coinbase's public endpoint
503'd alongside them. This is Base Sepolia shedding STATE reads across providers, not one
bad node and not a stopped chain. `deploy_v8.js` now fails read calls over to the other
endpoints automatically (sends never move). Widen the pool for a long run:
```powershell
$env:FALLBACK_RPCS="https://<endpoint-a>/,https://<endpoint-b>/"
```
⚠ **Do not start a 15-30 minute deploy while the endpoint hardhat uses is 0/20 on
`eth_getCode` / `eth_call`.** Wait for two clean `check_deploy_rpc.js 20` runs minutes apart —
one clean sample is not a measurement.

---

## PHASE G — THE PRIVATE GATE. ⛔ BEFORE PHASE 2, AND IT IS THE ONLY THING BETWEEN A GREEN SUITE AND THE COMMUNITY.

**Private chain, closed list, `MATRIX_SIZE` 127, bigfill to force real rescues. Hours, not
days. The community stays on the old build throughout — that IS the "simultaneous", with
the risk on our side of the line.**

⛔ **THIS IS A GAS TEST, NOT AN ECONOMICS TEST, AND THE DISTINCTION IS THE WHOLE POINT.**
The economics are measured to exhaustion and are not the risk. What has never been measured
is what a keeper item COSTS at 127 on a real chain — every gas figure V8.50 has is
`MATRIX_SIZE` 7. Gas is also the one thing a chain of scripts measures HONESTLY: gas does
not care whether an address belongs to a person or to bigfill. Anything member-shaped
(behaviour under refusal, the live shortfall distribution, 14.1 re-measured) this chain
CANNOT answer and is not being asked — those wait for the community, and nothing should be
held back for them.

⚠ **THE FAILURE MODE, so the stop conditions below make sense.** `minGasPerItem` is checked
BEFORE an item is dispatched. If the remaining gas is under it, the batch emits
`BatchGasHalted` and breaks — visible, clean, work rediscovered next tick. **That is the
guard working.** Set it too LOW and the guard passes, the item starts, and it dies inside
the `try/catch` as `WorkItemFailed` — an event carrying a work type and addresses and **no
reason**. An out-of-gas rescue and a rescue that reverted for any other cause are the same
line in the log. On a community chain that reads as "members are not being rescued", which
is also what an ordinary refusal looks like. **That is why this cannot be watched live.**

⛔ **CORRECTED 2026-08-25 (session 40) — THIS LINE WAS ITSELF THE STALE NUMBER IT WARNS
ABOUT.** It read *"`minGasPerItem` IS 5,000,000 ... any older note testing against 3.5M is
stale"*. **Read from source today: `minGasPerItem = 7_500_000` (`MatrixKeeper.sol:378`) and
`maxItemsPerUpkeep = 1` (`:256`)**, both moved by 30.10 / 31.4 and both setter menus widened
on 2026-08-22 (`setMinGasPerItem` gained 12.5M and 15M; `setMaxItemsPerUpkeep` gained 1 and 2).
**Every PASS threshold written below in units of 5,000,000 predates that change.** The basis
for 7.5M is 160 live per-item samples over 8 days: **p50 3.94M, p90 7.00M, max 14.67M, with
8.1% of rescues above 7.5M** — so the floor is deliberately BELOW the worst observed item and
the 12.5M/15M rungs exist for that reason.
⚠ **THE LIVE V8.48 CHAIN IS A DIFFERENT WORLD AGAIN (handoff 39.0): `maxItemsPerUpkeep`
reads 15 there and `minGasPerItem` is ABSENT FROM THAT BYTECODE ENTIRELY** — it postdates the
2026-08-13 deploy. Say which deployment any gas figure is about, every time.

**G.0** Deploy privately: PHASE 0 and PHASE 1 exactly as written, with `MATRIX_SIZE` 127
and the frontend NOT repointed. Being off the frontend is what makes it private.
*Why: PHASE 1.4's integrity gate applies here too — a corrupted matrix invalidates every
gas number taken after it.*

**G.1 ⛔ FILL IT WITH SELF-RESCUE TURNED DOWN — OR MEASUREMENT 1 IS IMPOSSIBLE.**
```powershell
powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1 -Count 300 -Offset 0 -SelfRescueRate 0.1 -UpgradeRate 0.75 -AddressesFile deployed_addresses_v8_50_private.json -BatchSize 5 -BatchDelay 8
```

⛔ **TWO CORRECTIONS, 2026-08-21 — THE ORIGINAL LINE COULD NOT HAVE RUN (handoff 29.9).**
* **`-AddressesFile` IS MANDATORY HERE.** The wrapper refuses any `-SelfRescueRate` other
  than 1.0 unless the chain is named explicitly: a cohort that cannot self-fund parks,
  accrues debt and is evicted, which must never touch the community chain. Without it the
  run prints `REFUSING TO RUN` and exits 1.
* **`-BatchSize 5 -BatchDelay 8` OR THIS TAKES A DAY.** The wrapper defaults to
  `-BatchSize 1 -BatchDelay 300` — one registration every five minutes (owner rule
  2026-08-19, so the fund is fed by sweeps rather than bulk registration). At `-Count 300`
  that is ~25 hours, and PHASE G is explicitly "hours, not days". Burst mode is the
  wrapper's own documented alternative for exactly this case.
⚠ Also automatic and correct: `-SelfRescueRate 0.1` pins `-ScanFrom` to the offset, so this
cohort cannot reach back and apply its own self-rescue rate to earlier wallets.
🖥️PS — always through the wrapper, never `npx hardhat run scripts\bigfill_v8.js` directly
(BIGFILL_RULES.md: the raw defaults switch on CNOVA buy/sell and the burn sweep, which the
owner rule forbids).

⛔ *`-SelfRescueRate 0.1` is a DELIBERATE DEPARTURE from the wrapper's normal `1.0`, and it
is the difference between this phase working and returning nothing. At 1.0 **every parked
wallet pays its own shortfall**, the fund never lends, no `WORK_PARKED_RESCUE` with
`sfShare > 0` is ever queued — and an SF-funded rescue is exactly the item measurement 1
exists to price. G.3 would return "NO VERDICT" forever and it would look like a tooling
problem.*

⚠ *This is not a claim about realism. Live V8.48 self-rescues about 72% of episodes
(handoff 25). **Gas does not care** — the item costs what it costs. Turn the rate back up
for anything economic.*

*Why fill at all: a keeper batch that only reclaims idle slots costs 0.04M and proves
nothing. The queue has to contain the dear item.*

**G.1b** Confirm the queue actually holds fund-backed work before spending a measurement on it:
```powershell
node scripts\diag_keeper_work.js
```
🖥️PS — you want `PARKED_RESCUE` items in the discovered list. If there are none, bigfill
more or drop `-SelfRescueRate` further. ⛔ **Do not proceed to G.2 on an empty queue.**

**G.2 ⛔ DRIVE ONE ITEM PER TRANSACTION. This step is what makes measurement 1 possible.**
```powershell
$env:ADDRESSES_FILE="deployed_addresses_v8_50_private.json"
$env:ONE_ITEM="1"
$env:INTERVAL_SECS="3"
$env:MAX_TICKS="60"
npx hardhat run scripts\testchain_keeper.js --network baseSepolia
```
🖥️PS — `testchain_keeper.js` is the private-chain driver (signs as the deployer, so no
`setUpkeepCaller` is needed, uses an estimateGas ladder, and survives a revert instead of
exiting on it). `ONE_ITEM=1` sends the FIRST discovered work item as its own transaction
and leaves the rest for the next tick.

⛔ *Why drive one item per transaction rather than rely on the cap:* **the "not on the menu"
reason this note used to give is OBSOLETE — corrected 2026-08-25. `setMaxItemsPerUpkeep` was
widened on 2026-08-22 and now accepts **1 | 2 | 5 | 10 | 15 | 20 | 30 | 40**, and the source
default IS 1. The method below is still the right one, for a better reason: it does not
depend on what the cap happens to be set to on the chain under test, and 39.0 measured that
source (1) and live V8.48 (15) disagree. Driving one item explicitly makes the basis certain.
*`performUpkeep` decodes its work list
straight from calldata and never checks that the list came from `checkUpkeep`, and the
owner is always allowlisted — so the driver just sends one item.*

⛔ *Why one item at all: `gasUsed` is per BATCH, and `gasUsed / items.length` is a **fitted
number, not a measurement** — an eviction costs 1/18th of a rescue, so a mixed batch's mean
describes nothing that happened. One item per transaction makes the figure exact. It is the
same basis `V8_50_KeeperGas.test.js` used at size 7, which is what makes the two
comparable.*

⚠ Defect 6 orders discovery to take parked work FIRST, so the first item is usually the
dear one — which is the one the gate needs priced. Watch the console: each tick prints the
work type it sent and `k/item EXACT`.

**G.3** Then measure:
```powershell
node scripts\diag_keeper_gas_live.js
```
🖥️PS — **plain node, not `npx hardhat run`**: it builds its own provider from
`BASE_SEPOLIA_RPC_URL` in `.env`, so there is no `--network` flag. Set
`$env:ADDRESSES_FILE` first. **Save the output** — `gate_size127.txt` is gitignored.

> **MEASUREMENT 1 — gas per SF-funded rescue at 127.**
> The script prints its own verdict. It computes the marginal cost as *dearest single-rescue
> batch − the fixed overhead*, where the overhead is read off the cheapest work type in the
> same run rather than assumed.
> ✅ **G.3 IS CLOSED (handoff 30.12) — recorded as correct and final for that chain.** It was
> closed by proving no cheap item can exist there (fixed overhead 0.03M, dearest single-item
> SF-funded rescue 4.58M), not by pricing one. Kept here as the method, not as an open step.
> **PASS: marginal max < `minGasPerItem` with visible headroom.**
> ⛔ **THE LITERAL `5,000,000` THAT USED TO BE WRITTEN HERE IS SUPERSEDED** — the floor is
> 7,500,000 today. ✅ **The INSTRUMENT was already right when this text was wrong:**
> `diag_keeper_gas_live.js:153` computes `ok: marginalMax < minGasPerItem` by READING the
> floor off the chain, so its verdict self-updates. Trust the script's verdict over any
> number typed into this runbook — including the ones I have just typed.
> ⛔ **STOP:** marginal max ≥ the floor the script read. `minGasPerItem` must move to the next
> menu rung BEFORE the community deploy. **This single number is the whole reason this phase exists.**
> ⚠ **"NO VERDICT" IS NOT A PASS.** If no single-item rescue was observed, or no cheap type
> was seen to measure the overhead with, the script refuses to answer. Fill more and re-run.

**G.4** Now the opposite: full batches against a deep queue. Drop `ONE_ITEM`, let bigfill
build the queue past one batch, and run the driver normally:
```powershell
Remove-Item Env:\ONE_ITEM
npx hardhat run scripts\testchain_keeper.js --network baseSepolia
```
then re-run `node scripts\diag_keeper_gas_live.js`.
⚠ `maxItemsPerUpkeep` should be at its normal value for this (20 in source, 15 on live —
handoff 25.6). **Record which one this chain is running**; the halt behaviour depends on it.

> **MEASUREMENT 2 — REWRITTEN 2026-08-25 (session 40). ⛔ DO NOT RE-RUN AGAINST THE OLD TEXT.**
> The original PASS was *"`BatchGasHalted` fires, `processed < total`, `gasRemaining` just
> under 5,000,000"*. That was written for a **5M floor at cap 20**. At **7.5M floor and cap 1**
> there is no in-batch halt left to observe — one item receives the whole budget — so the old
> criterion cannot be satisfied by a healthy system and cannot be failed by a sick one.
> **A criterion that no outcome can move is not a gate.** (Same shape as 31.1's constant and
> 31.2's scenario: both printed green while checking a world that no longer existed.)
>
> **THE QUESTION IS NOW: at cap 1, does a deep queue drain cleanly, and is 7.5M the right rung?**
> **PASS — all four:**
>   1. Every tick processes **exactly one** item (`processed == 1`, `total > 1`) — which also
>      confirms on chain which cap the chain under test is actually running (39.0: source 1,
>      live V8.48 15; assume neither, read it).
>   2. **ZERO `WorkItemFailed` on `PARKED_RESCUE`.** Unchanged, and now the PRIMARY signal
>      rather than a side condition.
>   3. `BatchGasHalted` count is **expected 0** at cap 1. If it DOES fire, the item was
>      dispatched with under 7.5M left, which at cap 1 means the DRIVER's gas limit is too
>      low — a driver finding, not a contract one. `testchain_keeper.js` uses an estimateGas
>      ladder rather than a static limit, so read the limit off the run; do not assume 16.5M.
>   4. Observed per-item **max** stays inside the driver's limit less the fixed overhead, and
>      the distribution is reported next to the 160-sample live baseline (p50 3.94M, p90 7.00M,
>      max 14.67M). **This is the real content of the measurement now.**
> ⛔ **STOP:** any `WorkItemFailed` on `PARKED_RESCUE` — the event carries no reason, so an
> out-of-gas item and an ordinary revert are indistinguishable, and every non-zero count must
> be explained before go-live, not waved through. Also STOP if the per-item max at 127 exceeds
> the 14.67M live baseline materially: 7.5M would then be under-floored for this size and the
> menu's 12.5M / 15M rungs exist for exactly that move.
> ⚠ **UNVERIFIED — this rewritten criterion has not itself been run.** It is a criterion, not
> a result. The first run to use it should say so and record whether it discriminates.
>
> ⛔⛔ **AND THE CRITERION YOU NEED DEPENDS ON WHICH CHAIN — MEASURED 2026-08-25, AFTER THE
> REWRITE ABOVE WAS ALREADY WRITTEN.** I rewrote the PASS for cap 1 because that is what the
> SOURCE ships, **without first reading what the chain under test actually runs. That is rule 2
> broken in the act of fixing a rule-2 defect.** `diag_keeper_work.js` now prints the config:
>
>     private V8.50 chain (deployed_addresses_v8_50_private.json, block 45946005)
>       maxItemsPerUpkeep  20      <- NOT the source default of 1
>       minGasPerItem      5,000,000   <- NOT the source default of 7,500,000
>
> **It is not misconfigured — it PREDATES the configuration.** It was deployed 2026-08-21 from
> `8c60b64` (2026-08-18), whose declared defaults are exactly 20 and 5,000,000. The V8.50 gas
> configuration was settled in `5a07cab` on 2026-08-23, **two days later.** Same shape as 39.1's
> PARAM 59: a chain that predates a decision is not a chain violating one.
>
> ⛔ **AND IT CANNOT BE CONFIGURED INTO THE SHIPPING WORLD. `setMaxItemsPerUpkeep` AT THAT
> COMMIT IS `require(v == 5 || 10 || 15 || 20 || 30 || 40)` — 1 IS NOT ON THE MENU, AND A
> `require()` CANNOT BE WIDENED AFTER DEPLOYMENT.** The lowest cap reachable on that chain is 5.
> (`minGasPerItem` 7,500,000 IS reachable — it was already on the old menu.) **This is the
> menu-immutability warning at `setMinGasPerItem` coming true on a live gate chain.**
>
> **SO, PER MEASUREMENT — and this is the useful part, because the gate is PARTLY RUNNABLE NOW:**
>   * **G.4 CANNOT produce a V8.50-representative result on this chain.** Either redeploy
>     privately from current source (G.0/G.1 again — hours, and "a private failure costs a
>     redeploy nobody sees"), or run it here against the ORIGINAL cap-20/5M criterion and label
>     the result as describing the pre-`5a07cab` configuration. ⚠ The original criterion is
>     not junk — it was written for exactly this chain's configuration and is valid ON IT.
>     ⚠ Note the direction: cap 1 is strictly SAFER for gas than cap 20, so a pass here is
>     conservative — but "wrong number in the harmless direction" is not a control (38.6).
>     ✅ **DECIDED 2026-08-25 (session 41, handoff 41.0): REDEPLOY from current source.**
>     `G4_REDEPLOY_RUNSHEET.md` (repo root) instantiates PHASE 0/1 + G.PRE + G.0/G.1 for it;
>     the new addresses file is `deployed_addresses_v8_50_private2.json`, and the 08-21
>     chain stays as the measurement deployment. The waiver option above is therefore
>     historical: it was not taken, for the reasons 38.6 gives.
>   * ✅ **G.5 IS VALID ON THIS CHAIN AS IT STANDS.** Measurement 3 is ECONOMIC —
>     `selfFundedRescues / rescues`, driven by `sfShare == 0`. The batch cap does not change
>     whether a rescue was self-funded. **Run it here; no redeploy needed.**
>   * ✅ **G.7 IS ALSO ECONOMIC and valid here**, with the `insolvencyFloorBps` caveat already
>     written at G.7. Read the floor off THIS chain before quoting any figure from it.
>   * ✅ **G.3's CLOSED RESULT SURVIVES.** It was taken with `ONE_ITEM=1` in the DRIVER, which
>     sends one item per transaction regardless of the contract's cap — so its per-item figure
>     is basis-exact and independent of this finding. That is why G.2 drives one item.

**G.5**
```powershell
node scripts\g5_sf_ratio.js
```
🖥️PS — plain node; reads the RPC from `.env`, `ADDRESSES_FILE` from the SESSION (mandatory —
it refuses a default). Pin `FROM_BLOCK` to the chain's deploy block for a whole-of-chain ratio.
> ⛔ **CORRECTED 2026-08-25 (session 41, handoff 41.1).** This step used to say
> `model_item_a.js` — **that script never computes the ratio this PASS names** (session 40,
> 40.4: its PHASE 2 is a PROJECTION, structurally zero on a chain that already has item A,
> which is why G.5 returned NO VERDICT). `g5_sf_ratio.js` is the instrument that computes it.
> `model_item_a.js` remains the tool for G.7's PHASE 7/8 re-confirmation, not for this step.
> ⛔ **CORRECTED AGAIN THE SAME DAY (41.3) — THE `CoPayRescue.sfShare == 0` CRITERION WAS
> ITSELF WRONG.** The instrument's first run found ZERO CoPayRescue events on a chain that
> had just performed 110 keeper rescues, and the window was not the reason: **the keeper's
> rescue path (`forceCrossKeeper`) NEVER emits `CoPayRescue`** — that event belongs to
> `coPayRescue()`, the VPS co-pay keeper's entry point, which nothing calls on a private
> chain. 40.4 wrote the PASS from the event DECLARATION, not the call path.
> **The measured basis (v2, emit sites verified):** every keeper rescue emits
> `ParkedRescued` (keeper); the fund-backed ones also emit `RescueLoanIssued` (matrix) in
> the same transaction. A `ParkedRescued` whose tx carries no loan event is a rescue the
> fund paid nothing for — joined by txHash, not subtraction. `SelfRescue` counts the
> member-paid episodes alongside.
> **MEASUREMENT 3 — `selfFundedRescues / rescues` on the V8.50 arm**, computed as above.
> (PHASE 2 of `model_item_a.js` projected 67 of 67, 100%, as the reference point.)
> **PASS:** the share is at or near the projection.
> ⚠ A shortfall here is an ECONOMIC finding on a population of scripts. Read handoff 14.6
> before treating it as a fact about members — and on a `-SelfRescueRate 0.1` bigfill
> cohort the ratio describes THAT SETTING, stated in the script's own output.

**G.6**
```powershell
node scripts\diag_sf_debt_reconcile.js
```
🖥️PS — plain node; reads `ADDRESSES_FILE` and the RPC from `.env`.
> **MEASUREMENT 4 — E1 makes the aggregate and ledger bases coincide.** PHASE 6 claims this
> "by construction"; this is the first time it runs anywhere.
> **PASS:** the two bases agree.
> ⛔ **STOP:** they do not. A conservation gap found on the community chain is found in
> members' money.

**G.7 THEN RE-CONFIRM THE TWO OWNER DECISIONS ON A RUNNING SYSTEM.** Re-run
`model_item_a.js` PHASE 7/8 against the private chain and re-check PARAM 59 and the rescue
ladder rung. Both are expected to hold — they held across three samples — **but "expected to
hold" is a hypothesis and rule 2 applies.**
⚠ Note the live V8.48 chain runs `insolvencyFloorBps` **3400** while source ships 5,000
(handoff 25.6). The private V8.50 deploy will come up at **5,000**. They are not the same
world; do not compare a private figure against a V8.48 one without saying so.
⛔ **AND DO NOT "FIX" THAT DIVERGENCE (handoff 39.1).** 5000 is the DECIDED V8.50 value
(owner 2026-08-19, re-confirmed by 16.5 / 17.0 / 19). Live 3400 is a chain that PREDATES the
decision, not a policy the deploy is about to violate. Session 38 concluded the opposite and
prescribed writing 3400 into `deploy_v8.js`; that would have overturned a decision confirmed
three times, on the dial that decides who is allowed to borrow. The DRIFT row is CORRECT.

**G.8 RUN THE FRONTEND ABI AUDIT BEFORE THE ADDRESSES CHANGE:**
```powershell
node scripts\audit_frontend_abi.js
```
🖥️PS — plain node. It defaults `FRONTEND` to `C:\CryptoNova-Testnet-App`; override with
`$env:FRONTEND` for the mainnet app.
Two failure modes it exists for: **MISSING** (the frontend calls something V8.50 does not
have — breaks on deploy, loud) and **SHAPE DRIFT** (selector matches, OUTPUTS differ — the
call succeeds and decodes to the WRONG VALUE, silent).

> ✅ **RUN 2026-08-25 (session 40) — FIRST TIME EVER AGAINST V8.50. IT FAILED, 7 PROBLEMS,
> WHICH IS WHY IT EXISTS. NOW AT 1, AND 1 IS THE PASS.**
> **PASS CONDITION FROM HERE: exactly one MISSING row — `distributeInterval()` in index.html —
> and SHAPE DRIFT 0.** Anything else is new and must be triaged before the cutover.
> That one row is a WAIVER, marked in place at the call site: it is the pre-V8.48 fallback,
> guarded by `.catch(() => null)`, deliberately kept while this app serves a LIVE chain.
> **Remove it AT the cutover, not before** — and re-run G.8 once more after removing it.
>
> ⛔ **WHAT THE FIRST RUN CAUGHT, AND ONLY ONE OF THE SEVEN WAS REAL.** Triage each row to its
> CALL SITE before believing the count — three of the seven came from one dead file.
>   * ⛔ **`getFloorPrice()` in liquidity.html — THE REAL ONE, AND NOT A V8.50 PROBLEM AT ALL.**
>     `git log -S 'getFloorPrice' -- contracts/` returns NOTHING: that name has never existed
>     in any version. The call sat inside `catch (_) { set('amm-vs-floor',''); }`, so the
>     "vs bonding floor" line has been silently blank on every page load since it was written.
>     Real getter is `floorPriceE6()`; it returns `treasury.floorPrice()`, 6-dec USDC per full
>     CNOVA, so the existing `/1e6` was already correct — only the NAME was wrong. Fixed, and
>     the catch now logs its reason. **Found by the gate, not by a member. This is the return.**
>   * ⚠ **The two SHAPE DRIFT rows were BENIGN, and that was MEASURED, not assumed.**
>     `MATRIX_ABI`'s `getMember` declared 9 fields against V8's 10 (`crossingReserve`, a V8.31
>     field — so this predates V8.48 and is what the live site runs on today). Encoding a
>     10-field tuple and decoding it with the 9-field ABI in ethers v6 **decodes cleanly with
>     all nine values correct**: identical field order, trailing word discarded. No site read
>     `crossingReserve` off `getMember` — every one uses `crossingReserveOf`. Widened anyway.
>     ⚠ The tool also compares against DEAD contracts (`CryptoNovaMatrixV6`,
>     `FigureEightMatrix`) the frontend never talks to, which inflates a drift row.
>   * `hasEverJoined`, `topUpAndCross` and one drift row were all in **`api/rescue.js`, a dead
>     V8.29 endpoint nothing fetches** — deleted. `usdcBalance()` in buy.html and
>     `distributeInterval()` in governance.html were **declared and never called** — removed.
>   * ⚠ **One of the three "unparsable" lines IS a real fragment**, not prose: `index.html`
>     splits it across lines with `+`. Confirmed correct (the 10-field form). **Check all three
>     every run** — the tool lists them rather than dropping them precisely for this.
>   * ⛔ **A BULK VERSION-LABEL REPLACE HAD CORRUPTED PROSE COMMENTS.** `update_addrs_vX_XX.py`
>     rewrote `V8.47` → `V8.48` inside COMMENTS, leaving a block reading "V8.48 replaces V8.48"
>     that no reader could recover without git. Restored from `17b6c02`. **That script will do
>     it again to whatever the comments say at the time — scope its replace to code and
>     addresses, or diff its comment changes before committing.**
> Commits: `250f9b9`, `23e8f3d` (testnet app, `admin`).

---

### ⛔ THE GATE'S OWN STOP RULE

**If G.3 or G.6 stops, nothing proceeds to PHASE 2.** A private failure costs a redeploy
nobody sees. A community failure costs the re-registration you only get to ask for once —
V8.50 carries no proxy machinery, so migration means every member re-registering on new
addresses, and that is a one-shot event.

### ✅ WHAT THIS GATE DOES NOT COVER, STATED SO NOBODY READS IT AS "READY"

* **No member behaviour.** Nothing here contains a member who invited someone *because*
  they were refused. The seven-day grace window is untested by construction.
* **No live shortfall distribution.** The only quantity left that could move the 3000 bps
  ceiling needs V8.50 live plus weeks of accrual (handoff 19.6).
* **Risk 2 of the original four is already closed** — defect 9's cascade-refill path got
  coverage in `test/V8_50_EvictionReserve.test.js` (handoff 20.4). It is not re-tested here.

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

**5.2b — CAP-1 CADENCE (decided 2026-08-25, handoff SESSION 42).** The community
chain ships `maxItemsPerUpkeep = 1` (G.4-validated — items are NOT cheaper at depth,
measured max 13.86M, so the cap stays). Throughput comes from the DRAIN LOOP in
`direct_keeper.js`, not from cron frequency: **copy the drain-loop
`direct_keeper.js` (master: `C:\CryptoNova-Keepers\direct_keeper.js`, loop added
2026-08-25) to the VPS alongside the addresses file** — a pre-drain VPS copy does
6 items/hour at cap 1 and starves any backlog. Cron stays `5-59/10` (writer-slot
layout unchanged). The loop sends sequential performUpkeep txs while checkUpkeep
reports work: 16.5M budget per tick, DRAIN_MAX_TICKS=40, 7-min wall-clock budget,
breaks on a processed-0 BatchGasHalted. Ceiling ~240 items/hour burst vs live
V8.48's 90/hour. ⚠ A full drain spends up to ~40× a one-shot slot from the keeper
EOA — **watch its ETH balance, not just liveness** (2026-07-30: a near-zero gas
tank IS an outage).

**5.2c — KEEPER FAILOVER (decided 2026-08-26, handoff SESSION 42): no second
`upkeepCaller` is granted.** The break-glass is the owner key itself —
`performUpkeep` accepts `owner() || governance || upkeepCaller[msg.sender]`
(MatrixKeeper.sol:914). If the droplet dies:
```powershell
cd C:\CryptoNova-Keepers   # .env: ADDRESSES_FILE=<community file>, KEEPER_PRIVATE_KEY=<deployer key>
node direct_keeper.js       # drains up to 40 items/run; repeat as needed
```
🖥️PS. Parked members are parked-not-lost in the interim, and the drain loop catches
up fast when the VPS returns. `setUpkeepCaller` is deliberately not DAO-gated, so a
standing second caller is minutes away if ever wanted. While in 5.x, also: delete the
VPS's stale `frozen_matb_keeper.js` (repo copy deleted 2026-08-26) and **resync
`crontab_live_mirror.txt` from `crontab -l`** — it still shows a frozen_matb line the
2026-08-23 audit measured as gone.

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

## PHASE 7b — ARM THE SPONSORSHIP GATE (V8.50+). ⛔ NOT ON GO-LIVE DAY.

**The contract ships with the gate INERT** (`StabilityFund.baseAdvanceBps = 10_000`). That
is deliberate and it is not an oversight to "fix" during deploy.

**WHY.** `TierRouter.directCount` is a fresh mapping on a fresh deploy. **It does not
backfill.** On migration day every member reads 0 directs — including a member who
sponsored twenty people on V8.48 — because their downline has not re-registered on THIS
deployment yet. Arming the gate before the tree rebuilds refuses real members for an
**empty counter** rather than for a policy, and a refused rescue routes to eviction
(handoff 18.8, 18.14). Ceiling value and reasoning: 18.18 and 19.0.

**7b.1** Pre-flight, read-only. Send nothing; just look:
```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:ADDRESSES_FILE="deployed_addresses_v8_50.json"
npx hardhat run scripts/set_base_advance.js --network baseSepolia
```
🖥️PS. It rebuilds the expected `directCount` for every sponsor from the `MemberRegistered`
log, reads the on-chain mapping for each one, and **aborts if they disagree** — a gate
armed against a broken counter refuses members silently, which is the worst failure this
system has available. Then it prints the live zero-direct histogram.

**7b.2** Read the histogram against the pre-migration numbers (handoff 19.1): live V8.48
organic **56.1%** zero-direct, A/B fixture pooled **49.7%**. A share far above those means
the tree has not rebuilt — **wait, do not arm.** Also run the cohort split, because a
filled chain reads high for a reason that is not about members:
```powershell
npx hardhat run scripts/diag_referral_threshold.js --network baseSepolia
```
🖥️PS — section 4. bigfill is 100% zero-direct by construction; **organic is the only
column this decision rests on** (14.6).

**7b.3** Only once 7b.2 looks like a rebuilt tree, arm it:
```powershell
$env:ARM="1"
npx hardhat run scripts/set_base_advance.js --network baseSepolia
```
🖥️PS. Same checks run again, then `setBaseAdvanceBps(3000)`. Confirm the script prints
`baseAdvanceBps = 3000` and the new zero-direct T1 ceiling of $3.00.

**7b.4** ⚠ **EXPECT EVICTIONS TO RISE, AND WATCH WHO.** The gate converts some refused
rescues into evictions by design — the owner's frame is *invite, self-rescue, or be
evicted* (18.14, verbatim). What to watch:
* **`ParkedMemberEvicted` count week over week.** The A/B measured ~6 extra FLOOR
  evictions per 288 members per run and the live crossing projects roughly double
  (19.3) — but **every A/B eviction figure is a NO-GRACE UPPER BOUND** (18.17): the A/B
  world zeroes all three grace clocks and live `evictionGracePeriod` is SEVEN DAYS.
* **Who they are.** 18.16: the members the cap refuses hold $5.58–$6.82 of their own
  money and owe $0.00 — near-misses, the most engaged non-inviters. If evictions start
  landing on members holding ~$0.25 instead, that is the RESCUE LADDER, not this gate,
  and lowering the base will not help.
* **`EvictionReserveReleased`.** Still never executed anywhere (18.15) — every evicted
  member so far came from MatB with a zero reserve. First live MatA eviction is the first
  real exercise of that path.
* Eviction is **removal, not confiscation** — 34 of 34 kept their withdrawable to the cent
  (18.15). If any member ever loses withdrawable at eviction, stop and report it.

**7b.5** To back it out at any time — one call, no redeploy, effective immediately:
```powershell
$env:ARM="1"; $env:BASE_BPS="10000"
npx hardhat run scripts/set_base_advance.js --network baseSepolia
```
🖥️PS. `base >= floor` makes the gate inert and the router is not even read.

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
