# DEPLOY CARD — V8.48 (written 2026-08-13, all audits clean)

**This is `GO_LIVE_RUNBOOK.md` with the V8.48 specifics filled in.** The runbook is the
law; this card is the version-specific parameters, the deviations, and the things that
only apply to this release. Read the runbook phase, then this card's notes for it.

Audience: a future session of Claude + the owner. Claude edits files; **the owner runs
every command.** One step at a time — wait for output before the next.

Legend: 🖥️PS = `C:\CryptoNite-Smart-Contracts\CryptoNova` · 🖥️PS-FE =
`C:\CryptoNova-Testnet-App` · 🌐VPS = `ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250`

---

## GREEN LIGHTS ALREADY BANKED (2026-08-13 — do not redo, but DO re-run if anything changed since)

| gate | result |
|---|---|
| Full test suite | **565 passing · 7 pending · 0 failing** |
| `predeploy_check.js` | **114/114 PASS — "safe to deploy"** |
| Item 38 — PARITY_AUDIT.md | audit RUN; 26 defects found; live-truth batch shipped to `admin` |
| Item 15 — approvals sweep | 17 charge paths tabled; A1/A2/A3 fixed; O1 aligned + tested |
| Compile | clean, no EIP-170 size warning after the bulk gate |

**Everything member-facing that must change WITH this deploy is already committed on
`admin`** (cutover batch `4dddfcf` + functional batch `30ec605`). Promoting `admin` → `main`
in Phase 6 IS the cutover. Nothing further needs writing on deploy day except addresses.

---

## PHASE 0 — Prep

**0.1 — START A FRESH CLAUDE SESSION.** Anchor line: *"Read V8_48_HANDOFF.md then
DEPLOY_V8_48_CARD.md in C:\CryptoNite-Smart-Contracts\CryptoNova — we are deploying V8.48."*

**0.2 — Disable ALL keepers** (runbook as written). `crontab -l | grep -v "^#"` must print
nothing. Then confirm nothing is still running:
```
pgrep -f "node .*keeper" ; pgrep -f "node .*rescue"
```
*(Runbook lesson 13: commenting cron does not stop a run already in flight.)*

**0.3 / 0.4 — whoami + nonce quiet.** As written. Deployer must be **0xCd0Af6a4…**.

**0.5 — ⚠️ V8.48 BLOCKER, CONFIRMED STILL WRONG 2026-08-13:**
`.env` line 69 reads `ADDRESSES_FILE=deployed_addresses_v8_47.json`. **Change it to
`deployed_addresses_v8_48.json`.** Every script default was bumped to v8_48 in code, but
`.env` overrides all of them — leaving it would make `deploy_v8.js` **overwrite the live
V8.47 address record**, which is how V8.29's record was lost.

**0.6 — predeploy_check.** Expect **114/114**. Note: the ℹ line
`transitional: 'distributeInterval' declared for the V8.47 fallback` is EXPECTED and
correct until Phase 7b removes it.

---

## PHASE 1 — Deploy

**1.1** `npx hardhat run scripts/deploy_v8.js --network baseSepolia` (15–30 min).
V8.48 deploy-specific things this run does that earlier ones did not:
- writes **`deployed_addresses_v8_48.json`**
- calls `treasury.setMemberTracker(T1 PairManager)` (**item 13** — never called before V8.48;
  without it `earlyExitPenaltyBps` returns 0 and `setFreeMode` reverts)
- authorizes **CNOVADirectSale as a treasury caller** (**item 6** — without it EVERY CNOVA
  purchase reverts)
- deploys + links **MatrixKeeperLib** (item 12a) alongside MatrixLogicLib/TierRouterLib
- declared defaults now shipping: `epochMemberLimit` 1,000 · `epochTimeLimit` 180 days ·
  `sfTargetMultiplier` 10 · `insolvencyFloorBps` 3,400 · `communityOverflowBps` 10,000 ·
  `proposalFee` 100e18 · `distributionDayOfMonth` 25 · `frozenMatBTimeout` 15 min

**1.2** Commit the addresses file IMMEDIATELY:
```powershell
git add scripts/deployed_addresses_v8_48.json
git commit -m "Add V8.48 deployed addresses"
```

**1.3** `check_state.js` — expect T1 MatA occ=1 (W1 at root), all else 0.

**1.3b — V8.48 ON-CHAIN GETTER PROBE (new, do not skip).** The frontend feature-detects
five V8.48-only members; prove they answer on the NEW deployment before any promotion.
Claude will supply the exact script; it must confirm:
`reservedHeldFor(address)` · `bulkWithdraw(uint256)` · `selfRescueWithPermit(...)` ·
`StabilityFund.loanEligible(address,uint8)` · `V8Governance.proposalFee()` — plus
`insolvencyFloorBps`, `communityOverflowBps`, `distributionDayOfMonth`, the three epoch
limits, and `sfTargetMultiplier(0) == 10`.
**Also probe the USDC being reused** (`.env` USDC_ADDRESS): does it answer
`DOMAIN_SEPARATOR()` and `nonces(addr)`? MockUSDC gained `ERC20Permit` only in **V8.44** —
if the reused testnet token predates that, item 40's one-signature self-rescue will
correctly fall back to approve+selfRescue on testnet (mainnet native USDC IS EIP-2612,
verified 2026-08-13). Not a blocker either way — but know which path members are on.

**1.4 MANDATORY INTEGRITY GATE.** As written — nothing reaches the frontend until
`integrity_check.js` says INTEGRITY OK.

---

## PHASE 2 — Community announcement

Claims must come from `PARITY_AUDIT.md`, not memory. Member-visible in V8.48:
one-signature partial withdrawals (item 3) · one-transaction self-rescue where the token
supports permit (item 40) · rescue surplus no longer erased (item 11 — this was live money
loss) · burning locked CNOVA no longer bricks the wallet (items 8+9) · governance proposal
fee is real and DAO-tunable (item 43) · plain-language explanations on all 55 params
(item 44) · distributions on **the 25th** · epochs now 1,000 members / 180 days (item 42) ·
"no loan" now explains itself (item 46).
**Do not claim** anything not in the audit.

---

## PHASE 3 — Frontend on admin

**3.1** `python update_addrs_v8_48.py` 🖥️PS-FE — reads
`deployed_addresses_v8_47.json` → `..._v8_48.json` and rewrites addresses + every stale
version label across index/status/buy/governance/liquidity/early/**compensation/faq/terms**/
**locales/en.json**/**api/telegram-qa.js**. Fill the deploy date into the ADDRS comment
replacement first (it currently reads `2026-08-XX`).

**3.2** Truncation check FIRST: `Get-Content index.html -Tail 5` → must end `</body></html>`.
Also `python -c "import json; json.load(open('locales/en.json',encoding='utf-8'))"`.

**3.3** Commit + push to `admin`. **Deviation from the runbook: do NOT `git add -A`** in this
repo — the bug endpoint pushes `BUGS.md` commits to `origin/admin` on its own; `git fetch
origin` + rebase first, then stage explicit paths.

---

## PHASE 4 — Owner human test (on admin)

Runbook checklist, plus the V8.48 paths that have never been exercised against a live chain:
- **partial withdraw** → must take ONE signature (item 3); a failing estimate must report the
  contract's reason, never silently loop per-matrix
- **self-rescue while parked** → one signature if the token supports permit, otherwise the
  classic two-step (both are correct; note which fired)
- **bulk upgrade while carrying rescue debt** → approve must be Σfees **+ debt** (O1); it
  should NOT revert on allowance
- **reserve badge** → reads `reservedHeldFor` (item 2)
- **governance** → proposal fee shows a real number and burns on propose (item 43)

---

## PHASE 5 — Keepers re-pointed + on

**5.1 / 5.2** As written — new addresses file to `/root/keeper/`, and set
`ADDRESSES_FILE=deployed_addresses_v8_48.json` in `/root/keeper/.env`
(`cp .env .env.bak` FIRST — runbook lesson 1).

**5.3 — ⚠️ V8.48 RETIREMENT LIST. Two cron lines must be DELETED, not re-enabled:**

| line | why it goes |
|---|---|
| `frozen_matb_keeper.js` | **item 24** — the contract now owns frozen-MatB rotation at `frozenMatBTimeout = 15 minutes`. The script would duplicate on-chain work. |
| `evict_parked.js` | **item 47** — the two-branch valve owns eviction on-chain. The script never actually ran (its `pgrep -f evict_loop.sh` guard matched its own parent shell) AND it borrows the matrixKeeper slot and skips the `rescueRatioBps` check. Do not "fix the guard" — delete the line. |

Re-enable the rest of the rescue/monitor set as usual. **Stress stays OFF until Phase 7.3.**
`copay_rescue` + `fastlane_rescue` stay live as backup by standing owner decision.

Expect **copay.log to start logging floor reverts** (`SF: insolvency floor`) — that is
item 46 working as designed, not a fault.

---

## PHASE 6 — Go live

As written (`admin:preview` → QA → `admin:main`). **Promoting `main` IS the text cutover** —
the moment `main` moves, members read the V8.48 wording (epochs 180d/1,000, the 25th, 10x SF
hints, params 59/60, corrected SF-repay and wallet-pull copy). Verify Vercel production shows
Ready before announcing.

---

## PHASE 7 — Bigfill + monitor

**7.1** Wrapper only: `run_bigfill_rr.ps1` (never `bigfill_v8.js` directly — BIGFILL_RULES.md).
Note: bigfill runs from the OWNER'S WINDOWS MACHINE and is the system's traffic driver; when
it stops, the parked-debt loop becomes visible (that is the 2026-08-12 "flip", not an outage).

**7.2** Watch-list additions for V8.48: SF outstanding-debt trend (items 46/47 should bend it),
ghost count (`diag_ghost_parked.js` — was 41; item 45's prevention should drive it toward 0),
and evictions actually occurring (they never have, in any version).

**7b — POST-DEPLOY CLEANUP (same session, once main is live):**
1. Remove index.html's V8.47 fallbacks: the `distributeInterval` ABI line + its null-guarded
   call, and the item-41 CW feature-detects (`nextDistributionTime` is now real).
2. Re-run `predeploy_check.js` — the ℹ transitional line should be gone, replaced by
   `✓ index.html: no distributeInterval() call remains (post-cutover state)`.
3. Update `PARITY_AUDIT.md` section 11 verified dates + `V8_48_HANDOFF.md` to a V8.49 handoff.
4. Re-run `diag_ghost_parked.js` and `diag_parked_growth.js` for fresh post-deploy numbers.

---

## OPEN, NON-BLOCKING (carried into the deploy knowingly)

- **O2** — index.html's coupon-issue approve hardcodes `T1_FEE` while `couponAmount` is an
  owner-settable contract value (equal today). Switch to the getter when the coupon UI is
  next touched.
- **D2** — ~50 `.catch(() => <literal>)` display fallbacks remain in index.html (zeros/defaults
  rendered as fact). None gate an action any more; the 2026-08-07 failure-as-zero sweep is
  still open.
- **D3** — `CHAIN_ID` referenced but undefined on compensation/faq/terms (chainChanged handler
  throws); liquidity's theme toggle targets a non-existent `btn-theme`.
- **Liquidity/yield-pool contracts are NOT in this deploy set** — liquidity.html's fact set
  stays unverified against source until those contracts are next touched.
