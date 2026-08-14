# CryptoNova Smart Contracts — CLAUDE.md

Read this file at the start of every session before touching contracts, scripts, or deploy.

---

## STANDING DESIGN POLICY — THE STABILITY FUND AND THE PARKED CLOCKS (owner, 2026-08-13)

Owner statement, on V8.48 deploy day, correcting a session that proposed the opposite:

> "The SF always grows organically... we do not seed SF, it grows organically.
> 24hrs of registrations before automated rescue kicks in on testnet and 48hrs on
> mainnet — that is by design, to have members rescue themselves before SF takes over.
> Eviction should not happen for 3 to 5 days."

**THE STABILITY FUND IS NEVER SEEDED OR TOPPED UP TO MAKE RESCUES HAPPEN.** It fills
from fee splits and that is the whole design. A fresh deployment therefore starts with
an almost-empty fund, `copay_rescue.js` stands down under its own `SF_FLOOR` (default
$250), and **parked members simply wait — that is CORRECT, not an outage.** On deploy
day 2026-08-13 a session read "SF $67, 24 parked, keeper standing down" as a launch
emergency and proposed running `topup_sf.js`. It is not an emergency. Do not propose it.
(`topup_sf.js` exists for genuine operational top-ups and is invariant-safe via
`receiveLayer` — never a raw ERC20 transfer, which is the bug `seed_sf.js` cleaned up
after. But reach for it only when the OWNER asks.)

**The grace ladder, and which knob is which:**

| clock | what it governs | where it comes from | testnet | mainnet |
|---|---|---|---|---|
| `selfFundedGracePeriod` | member covers their own re-entry — the rescue costs the fund NOTHING | contract default **5 min**; `deploy_v8.js` NEVER sets it | 5 min OK | **must be 6h — nothing sets it, so a mainnet deploy silently ships 5 min** |
| `parkedGracePeriod` | SF-FUNDED rescue, i.e. a LOAN the member never asked for | `deploy_v8.js` sets it (`PARKED_GRACE_SECS`, default 86400) | 24h | **172800 (48h)** |
| eviction | removing a floored / too-thin / high-withdrawal member | **NO SEPARATE PARAM — shares `parkedGracePeriod`** | 24h (wrong) | (wrong) |

**The last row is a KNOWN GAP, not the design:** owner policy is 3-5 days and the
contract has no eviction clock of its own (`MatrixKeeperLib.sol:458`). It is **V8.49
item 1** — see `V8_49_SCOPE.md`. It matters from V8.48 onward because V8.48 is the
first version where evictions can fire AT ALL (on-chain valve + the keeper EOA finally
authorized; `evict_parked.js` never once ran in any earlier version). Do NOT "fix" it
by raising `parkedGracePeriod` — one knob drives both clocks, so that breaks the 24h
rescue design. `predeploy_check.js` now prints all three clocks and turns them into
hard failures under `MAINNET=1`.

---

## Active deployment

| Item | Value |
|------|-------|
| Version | **V8.45** (deployed 2026-07-26 ~02:45 UTC — emergency fix, see incident below) |
| Network | Base Sepolia |
| Addresses file | `scripts/deployed_addresses_v8_45.json` (commit 3b4afc4) |
| `.env` ADDRESSES_FILE | `deployed_addresses_v8_45.json` (Windows AND /root/keeper/.env) |
| Deployer | **0xCd0Af6a4116f2062c1594aDf34c1821D45175506** (owner decision — see wallet rules) |
| TierRouter | 0xC44c1A511DFAebE58D9BB719D087aB540224686A |
| PairFactory | 0x71020540eAcAdAbD8877Bf3e467bFBB295EE8129 |
| MatrixKeeper | 0x603db2d933F3B24Ce1aB23BFc2495622D5600C84 |
| MatrixLogicLib | 0x51bd1BB1Abb4b8d7e87379F8cb2E70e6D6B66feF |
| KEEPERS | **ALL 8 VPS cron jobs ACTIVE** since 2026-07-26 ~04:20 UTC (rescue, onramp, monitor, direct, frozen_matb, channel_pulse, system_keeper, **stress**). Owner green-lit stress after pre-checks passed: 68 real members registered, INTEGRITY OK, 32/39 round-robin leaders registered. Stress state was reset to offset 0 (backup: stress_state.v844.json). Owner rule stands for future deploys: stress stays OFF until members are in and the owner says go — and NEVER restore a crontab backup blindly, it re-enables stress silently. |
| Integrity gate | `node /root/keeper/integrity_check.js` — **run after every deploy and at least hourly on day 1.** 2026-07-26 12:11 UTC after a full night live: **INTEGRITY OK**, T1 MatB **rot=841** (V8.43 froze at 0; V8.44 corrupted at 217), T2 MatB rot=86, T3 filling. Fix proven under load. |
| Parked count is NOT a backlog | 2026-07-26 18:00: dashboard showed **408 parked**, which looks alarming but is a ROLLING WINDOW, not a queue. Diagnosis: `DRY_RUN=1 MAX=500 node copay_rescue.js` reported **17 eligible, 0 failed, 389 still in grace** — 95% had parked within the last hour. Stress keeper had done **16,228 self-rescues** and was running one every ~8s. Little's Law: parked ≈ park-rate × grace. At ~390 parks/hour with 1h grace, steady state IS ~400. Lever = grace period: 1h→~400, 30m→~200, 15m→~100, 5m→~35. Owner decided 2026-07-26 to observe a couple more hours before dropping to 900s (15m). **Diagnostic to distinguish steady-state from real backlog: watch the "still in grace" number — flat ≈ healthy, climbing = park rate outpacing rescue.** |
| Live tuning 2026-07-26 | **parkedGracePeriod 86400 → 3600s (1h)** — the deploy script sets the mainnet-appropriate 24h, which left 114 members parked and looking "stuck" (all showed "in grace period" in rescue.log; nothing was broken). Testnet wants 1h so the rescue keeper visibly drains. **MAINNET: 6h per the V8.25 decision.** Also **ROUND_ROBIN trimmed 39 → 13 leaders** (owner list, W1 0x6512e9B5 included). Keeper re-reads .env each run — no restart needed. NOTE: the Windows bigfill wrapper `run_bigfill_rr.ps1` keeps its OWN 39-address list — trim separately if desired. |

---

## 🟠 OPEN BUG for V8.46 — `addRescueDebt` breaks keeper rescue of MatB-parked members

**Found live 2026-07-26 (pre-existing, V8.43-era — NOT from the V8.45 work).**
`MatrixLogicLib.forceCrossKeeper` records the SF loan with
`IFigureEightMatrixV8Cross(destination).addRescueDebt(...)`, where `destination` is
`chainNext` for a MatB. `addRescueDebt` requires `msg.sender == _state.partner`.
With ONE pair that holds (MatB.chainNext == own MatA, whose partner is that MatB).
**Once a second pair exists**, pair-0 MatB.chainNext points at pair-1 MatA — whose
partner is pair-1 MatB — so the call reverts **`F8V8: only partner`** and
MatrixKeeper skips the whole rescue batch. Symptom: MatA parked drains normally,
MatB parked never does (T1 MatB stuck at 64 while MatA went 7→0).

**Live workaround (no redeploy):** `/root/keeper/copay_rescue.js` uses the
contract's OTHER rescue path, `coPayRescue()`, which records the debt LOCALLY
(`self.rescueDebt[member] += shortfall`) and never makes the cross-contract call.
Unauthenticated, SF-funded, identical economics. Verified 2026-07-26: 55/55
rescues succeeded, 0 failed, integrity clean throughout. **Cron: every 10 min at
minutes 2,12,22,32,42,52 with MAX=120.**
- MAX matters: the script walks tiers in order, so a low cap is consumed entirely
  by T1 and T2+ never gets serviced (seen live: T1 drained while T2 MatB climbed
  to 156 parked). 120 covers all tiers in one pass.
- Cost is negligible: **40 cascading rescues ≈ 0.002 ETH**. Keeper wallet
  0xd419681B holds ~1.63 ETH = ~800 runs of headroom.
- SF is self-sustaining under this load: it GREW $1,510 → $3,502 while rescuing,
  because entry fees fund it faster than co-pays drain it.
- No per-member cooldown (unlike manual_rescue.js's 24h one). Passive members can
  be rescued repeatedly; acceptable while SF grows, but watch for a member whose
  rescueDebt climbs without repayment — MatrixKeeper's zero-balance guard evicts
  those (withdrawable==0 && reserve==0 && debt>0).

**V8.46 proper fix (pick one):** (a) call `addRescueDebt` on the matrix the member
actually lands in, or (b) let `addRescueDebt` accept any matrix registered to the
same PairManager (`isPairMatrix[msg.sender]`), or (c) drop the cross-contract call
and record the debt locally like `coPayRescue` does.

---

## 🔴 INCIDENT 2026-07-26 — V8.44 nested-entry BFS corruption (read before touching entry/rotation code)

**Symptom:** members could not self-rescue; 3 bug reports in ~2h. T1 pair-0 MatB showed
`occupancy 127` but only **83 real occupants** (drift +44), 44 empty seats including
**position 1**, and one member at **phantom position 128**. Every entry reverted
`F8V8: no root`; 42 members were stuck. MatA was untouched.

**Root cause (V8.44 overflow rework, my change):** entering a FULL matrix calls
`_cycleOutRoot`, which calls `handleCycleOut` → `TierRouter._executeAdditive` →
`_takeSeat`, which — at pair saturation — seated the member back into **the same matrix
that was mid-rotation** (`registerForMatB`). The nested entry consumed the freed slot and
advanced `nextSlot`; the outer call then placed its member at the **stale** slot,
overwriting the nested occupant or writing past `MATRIX_SIZE`. One orphan + `occupancy`
+1 per event; holes migrate down one position per rotation until position 1 empties and
the matrix wedges permanently (no rescue, no registration, no admin path back).

**V8.45 fix (MatrixLogicLib):**
1. `enterMatrix` resolves the seat **after** the rotation via `_lowestFreeSlot()` (live
   storage), never trusts a cached `nextSlot`, and **parks** the member (fee still
   distributed, rescue path intact) if the cascade refilled every seat.
2. `_cycleOutRoot` scans forward for the **lowest occupied** position instead of assuming
   position 1 — so a gap at position 1 self-heals instead of wedging.
3. Regression tests `V8_45_NestedEntry.test.js` — N1 asserts, after every registration and
   crossing, that occupancy == real occupants, no duplicate seats, nothing above
   MATRIX_SIZE; N2 empties position 1 and proves rotation still works.

**Rules this bought (do not relearn the hard way):**
- **`MatrixLogicLib` is linked at deploy time** — there is NO way to patch a live matrix.
  Any library bug = full redeploy + matrix reset.
- **Never cache storage across a call that can re-enter.** `_cycleOutRoot` calls out to
  TierRouter which calls straight back in.
- **Green unit tests are not proof.** V8.44 shipped with 400 passing tests; they covered
  routing, never array integrity under nested entry. Pair any entry/rotation change with
  an invariant test AND the on-chain integrity gate.

**Check `.env` ADDRESSES_FILE before every deploy.** The wrong value caused V8.18 to overwrite V8.19 data.

---

## Wallet / key rules

| Wallet | Role | Rule |
|--------|------|------|
| 0xCd0Af6... | **Active TESTNET deployer (owner decision 2026-07-25, V8.44+)** | Owns MockUSDC → direct mint. EIP-7702 delegated to MetaMask stateless delegator 0x63c0c19a… (signature-gated; verified via eth_getCode 2026-07-25). The old "rejected on-chain" note is STALE — deploys from it succeed. Accepted risk on TESTNET ONLY. |
| 0x5EaEfA3... | Previous deployer (V8.31–V8.43) | Clean EOA. Cannot mint MockUSDC. Still holds prior-era balances — check before assuming funds moved. |
| 0x6512e9... | W1 (accountOne) | Root member, first MatA position |

**MAINNET RULE: fresh, NEVER-delegated deployer wallet. The 7702 exception above does not carry over.**

**Before every deploy:** `npx hardhat run scripts/whoami.js --network baseSepolia` — prints
signer + 7702 status; set `EXPECTED_DEPLOYER=0xCd0Af6a4116f2062c1594aDf34c1821D45175506`
in `.env` so deploy_v8.js hard-aborts on any silent key swap.

**KEEPERS RUN ON THE VPS ONLY (167.99.0.250, cron).** Windows Task Scheduler is
RETIRED — nothing keeper-related is scheduled on the Windows machine. Control them
with `crontab -e` / `crontab -l | grep -v "^#"` after
`ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250`.

**KEEPER ALIGNMENT (V8.44+):** owner-gated calls must be signed by the wallet that
owns the deployment (0xCd0Af6 for V8.44) via `DEPLOYER_PRIVATE_KEY`; the separate
keeper EOA (0xd419681B…, 1.6 ETH) only pays gas for the permissionless
`performUpkeep`. Verify both with the address-print one-liner in KEEPER_VPS_CONFIG.md
before re-enabling. Also confirm the stress ladder's funding USDC sits in the
deployer wallet.

**NEVER put private keys or credentials in PowerShell commands.** All keys live in `.env`. Only runtime params go on the command line (`HDR_OFFSET`, `COUNT`, `TIER`, `MSIZE`, etc.).

---

## PowerShell rules

**Never put `$` in a double-quoted PowerShell string.** `"...\$199..."` does NOT escape it —
backslash is not an escape character in PowerShell, and `$199` is parsed as a variable
reference, so it expands to nothing. A commit message written that way silently loses every
figure in it (happened 2026-08-10: "under-reports by up to \$199" committed as
"under-reports by up to \"). PowerShell escapes with a BACKTICK: `` `$199 ``. Simplest fix
for commit messages: use single quotes, or write "199 USD" and avoid the symbol entirely.

- **NEVER chain commands with `&&`** — PowerShell does not support it. Always separate commands.
- **One command at a time.** Give one command, wait for output + no-error confirmation, then give the next. Never give multiple steps at once.
- Run scripts with hardhat, not node: `npx hardhat run scripts/X.js --network baseSepolia`

---

## Deploy protocol (every deploy, no exceptions)

1. **Disable all 7 CryptoNova keeper tasks** in Windows Task Scheduler before starting
2. Check `.env` `ADDRESSES_FILE` points to the correct file for this version
3. Run predeploy check: `npx hardhat run scripts/predeploy_check.js --network baseSepolia` (must pass 91/91)
4. Deploy: `npx hardhat run scripts/deploy_v8.js --network baseSepolia`
5. **Immediately commit the new addresses file:**
   ```powershell
   git add scripts/deployed_addresses_v8_XX.json
   git commit -m "Add V8.XX deployed addresses"
   git push
   ```
   ⚠️ V8.29 was lost because this step was skipped. Never skip it.
6. Update `.env` `ADDRESSES_FILE` to the new file
7. Run `setTierMatrices` — required separately from `registerTier` (see below)
8. Seed W1 via `seed_w1.js`
9. Re-enable keepers (only the ones that were active before — check last-run timestamps)

---

## CODE↔FRONTEND PARITY — audit on EVERY deploy (owner rule 2026-08-10)

**Code is truth. The website must SAY the same truth.** A member never reads the
contract; they read the site. A site that disagrees with the contract is not a
cosmetic bug — it is the protocol lying to the people in it, and it has misled the
owner too (two owner beliefs, "Genesis get paid at 500" and "claim on the 25th",
came from the old buggy UI, not from the contract).

**Before every deploy, for every member-facing number and claim on the site, name the
contract source that backs it.** No source = it does not ship. Track in
`PARITY_AUDIT.md`.

Three divergences found in ONE session (2026-08-09/10) — this is not a rare failure:

| site said | contract said | how it happened |
|---|---|---|
| "next pair opens at N entries" | no such threshold exists | read a knob that steered nothing, behind `.catch(() => 381n)` |
| "T1.3 is taking new entries" | entries go to T1.1 | read `active[]`, which is a DIFFERENT routing rule than the one registrations use |
| earnings breakdown by tier | 2 of 4 earning paths emit no event | `_credit()` is silent, so L1 + direct-earn cannot be attributed |

Failure modes to check for specifically:
1. **A frontend `.catch(() => <value>)` on a contract read.** A failed read must never
   come back wearing a plausible number. Print `READ FAILED` or omit it.
2. **The frontend recomputing something the contract already answers.** Two
   independent answers to one question WILL disagree on screen.
3. **A view that reports on a mechanism it does not share.** `allPairsStatus().active[]`
   used `_findRoutingPair` while registrations used `_findExternalPair`.
4. **Copy describing a knob or threshold.** Every one of these has gone stale.

## setTierMatrices — required after EVERY deploy

`registerTier()` sets PairManager address + entry fee only.
`setTierMatrices()` sets matA and matB addresses separately.

**Both are required.** If `setTierMatrices` is not called, `manualUpgrade` will always revert.

---

## USDC mint rule (testnet)

MockUSDC `mint()` is `onlyOwner`. The deployed MockUSDC at `0x2D8B7b5...` is owned by old deployer `0xCd0Af6`. The active deployer `0x5EaEfA3` cannot call `mint()`.

**Workaround:** Use faucet or `transfer_usdc_to_w1.js` to move USDC from funded wallets.

---

## EIP-7702 deployer ban

Address `0xCd0Af6` was used in an EIP-7702 delegation transaction and is now treated as a contract by Base Sepolia. Deploy transactions from it will be rejected. Always use `0x5EaEfA3` for deploys.

---

## Nonce / deploy gotchas

- Remove any nonce reset logic before deploy (causes "nonce too low" errors)
- Keep the 8-second sleep between contract deployments (prevents nonce collisions)
- Disable all 7 keepers before deploy — active keepers submit transactions and advance the nonce mid-deploy

---

## Vercel force-push trigger

After a force-push that Vercel ignores:
```powershell
git commit --allow-empty -m "trigger deploy"
git push origin admin
```

---

## Test suite

```powershell
npx hardhat test
```
Must pass 173/173 (V8.31). Never deploy on a failing test suite.

---

## Address backup rule (CRITICAL)

Commit `deployed_addresses_vX_XX.json` immediately after every deploy. This is the only record of which contracts were deployed. Without it, the entire session of deploy work is unrecoverable if anything goes wrong.

## WHERE TRAFFIC COMES FROM — TWO MACHINES, DO NOT MIX THEM UP (owner statement 2026-08-13)

Sessions have flip-flopped on this; the owner has now said it plainly. There are TWO
sources of on-chain activity and they live on DIFFERENT machines:

1. **KEEPERS run on the VPS** (167.99.0.250, cron) — rescue/copay/fastlane, onramp,
   monitor, integrity, frozen MatB, etc. This was already the rule above; it stands.
2. **BIGFILL (bot entry/cycle traffic) runs from the OWNER'S WINDOWS MACHINE**
   (`run_bigfill_rr.ps1` in the contracts repo), started and stopped MANUALLY by the
   owner. It is NOT on the VPS — there are no stress/drip cron jobs there (verified
   2026-08-13: crontab has none; stress.log and organic_drip.log are empty).

Consequence: before reasoning about a change in traffic (entries, self-rescues,
parks), ASK THE OWNER whether bigfill was running on their machine that day. The
2026-08-12 "self-rescues collapsed 4,584 → 84" anomaly was exactly this — nothing on
the VPS changed; the driver lived on the Windows machine. Pick ONE source of truth
per activity type and check it first: VPS for keepers, the owner for bigfill.

## WHO THESE DOCS ARE FOR (2026-08-11)

Two people touch this code: the owner and Claude. There is no team, no incoming
contributor, no "someone six months from now". Every comment, doc and handoff is
addressed to **a future session of Claude, plus the owner** — write for a reader who
has the whole codebase available and none of this conversation.

Practically: say what was measured and where to re-measure it. Skip the defensive
framing aimed at a hypothetical third party — it costs words and helps no one.

## VERIFY THE PREMISE BEFORE IMPLEMENTING A SCOPE ITEM (2026-08-11)

A backlog entry is a CLAIM about the code, and claims go stale or start wrong.
Before writing anything, check the premise against source AND chain:

- `git log -S "<symbol>"` — when did this actually enter or leave the code?
- Read the file at the commit that MADE the claim, not just at HEAD.
- If the claim is about live behaviour, read the live contract. A doc that
  disagrees with a view function is the doc's problem.

Item 12 asserted `checkUpkeep` could not discover parked rescues. It had
discovered them since V8.10 — including in the very commit that wrote the claim.
Item 41 was the mirror: a belief about "the 25th" the contract never supported.
Both cost a session. Both were one `git log -S` away.

**Corollary — prove a behaviour change changes behaviour for someone real.**
Item 12's fix compiled, kept all 486 tests green, and released nobody: 0 of 96
sampled members met its condition. Green is not evidence of effect.

**Corollary — a filtered list is not a distribution.** The same session's census
printed parked members only at >= 90% of the entry fee, capped at six, and those
six were then written up as though they described everyone. Measuring properly
moved the median from an assumed ~95% to 84.2%. When quoting a statistic, state
what was sampled and what was excluded.

**Corollary — the right sample depends on the question.** Head-and-tail sampling
finds a stale queue; it cannot describe a population. Reusing one sampler for both
is how that bias got in.
