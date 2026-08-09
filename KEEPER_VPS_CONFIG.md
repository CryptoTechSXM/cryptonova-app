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
| `ADDRESSES_FILE` | **must match the live deploy.** Live value 2026-08-09: `deployed_addresses_v8_47.json`. See "Addresses pointer" below — on a release bump prefer moving the symlink to updating this. |
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

## Referrer round-robin — TWO env vars (verified 2026-08-05)

- `SPONSORS` — read by rr_keeper.js (the ACTIVE stress jobs A/B/C): cursor
  rotation across the list, W1 fallback if empty. THIS is the one that must
  be current before enabling stress.
- `ROUND_ROBIN` — read by stress_keeper.js (legacy) and the Phase 7.2b
  registered-leaders pre-check. Keep both lines identical.
- Frontend DEFAULT_SPONSOR_POOL (index.html) = first 8 leaders of the same
  list; contract _resolveRef falls back to W1 for unregistered sponsors, so
  an outdated pool can't revert a registration.

## Addresses pointer — hardening applied 2026-08-09

**The problem found.** 53 keeper scripts hardcoded `process.env.ADDRESSES_FILE ||
"deployed_addresses_v8_45.json"` — two releases stale. Seven more hardcoded an
absolute path with NO env override at all (`require("/root/keeper/deployed_addresses_v8_46.json")`),
which `.env` cannot reach. Every one of them was correct on the day only because a
single `.env` line overrode it. Lose or reset that line and 49 scripts silently aim
the owner key at dead contracts — no crash, just valid-looking addresses that are
not the live protocol.

**The fix.** One pointer, not 60 literals:

```bash
ln -sfn deployed_addresses_v8_47.json /root/keeper/deployed_addresses_current.json
```

Every fallback now reads `deployed_addresses_current.json`. Verified 2026-08-09
with `ADDRESSES_FILE=` forced empty so the fallback fires:

```
resolved: deployed_addresses_current.json
tierRouter: 0xE93A931b6C01f120962169a533614d1cC7b0AC9e
T1 pm:      0xB76fACd6234e1a0510599CBd185289444D58E2D3
```

Both match `scripts/deployed_addresses_v8_47.json` in this repo exactly.

**On every release bump, this is the whole procedure:**

```bash
ln -sfn deployed_addresses_v8_48.json /root/keeper/deployed_addresses_current.json
```

Do NOT reintroduce version literals into keeper source. If a script must pin an
old release (a version-specific verifier), archive it instead — see
`/root/keeper/archive_v846/`.

**Archived 2026-08-09** (moved out of the active keeper directory):
`preflight_v846.js`, `verify_v846.js` — V8.46-specific by name, would silently
become "V8.46 checks" running against V8.48. `b_block.js` — never syntactically
valid (top-level `await` outside async), so it has never run.

**Backup of all 53 pre-rewrite scripts:** `/root/keeper/_backup_addrfile/`.
Restore with `cp /root/keeper/_backup_addrfile/*.js /root/keeper/`.

## HOLDING CONFIGURATION — do not drift before V8.48

| item | state | why |
|---|---|---|
| `routeEntryThreshold` **ALL TIERS T1-T10** | `type(uint256).max` = `115792089237316195423570985008687907853269984665640564039457584007913129639935` | Set 2026-08-09 17:07 UTC across all ten tiers. |
| `deployEntryThreshold` all tiers | `375` (unchanged) | Deliberately untouched — factory expansion still triggers normally. Only the ROUTE lever moved. |

**Why max and not a big number.** This started at `1000000`. The owner asked what happens
when entries pass it — the honest answer is the mitigation SILENTLY EXPIRES and the bug
returns with no error and nothing in the logs. Note what increments the counter:
`rescueReentry` also does `p.totalRegistered += 1` (:291), so rescues count too — T1.1
showed 3,496 entries against only 378 MatA rotations, and T2.1 took +112 in twenty
minutes. The counter tracks protocol activity, not headcount, so any finite sentinel is
a timer nobody set deliberately. `1000000` encodes "saturate at a million"; what we mean
is "never saturate". Same defect class as the fixed block-lookback windows fixed in the
frontend the same day: correct when written, silently wrong later.

Verified safe before setting: `setEntryThresholds` has no upper bound
(`require(_deploy > 0 && _route >= _deploy)`); all three reads of `routeEntryThreshold`
(:267, :286, :581) are COMPARISONS with no arithmetic, so no overflow; `overflowActive`
(:265, the :267 reader) is dead code — declared in the MatrixLogicLib interface, defined
in PairManagerV8, called from nowhere in production, only from two tests.

**Frontend prerequisite (shipped first, admin 69a2f3e).** The Tiers card printed
`thr.toLocaleString()` into member-facing copy — at max that is a 78-digit string, and
even at 1,000,000 it told members *"T1.2 is already built and starts receiving at
1,000,000 entries"*, which reads as "never" while being presented as a design parameter.
Now: above a `THR_UNBOUNDED = 100000` bound it describes where entries are actually
going, in words. V8.48's round-robin removes the saturation-threshold concept entirely,
so that copy had to change regardless.

**Revert (restores pre-2026-08-09 behaviour):** `DEPLOY=375 ROUTE=400 node set_entry_thresholds.js`
for T2-T10, plus `DEPLOY=375 ROUTE=400 TIERS=T1 INCLUDE_T1=1 node set_entry_thresholds.js`.
Every change is logged with its own revert line in `/root/keeper/threshold_changes.log`.

**Measured effect within 20 minutes of the T2/T3 change:** T2.1 went 5,986 -> 6,098
entries and T3.1 1,153 -> 1,194. Both had been receiving NOTHING (permanently excluded at
route 400). Two independent instruments agreed: entry counts, and MatA rotation counts.

### Two tooling defects found and fixed on the VPS 2026-08-09

These live in `/root/keeper/` (not in git) — recorded here so they are not re-lost.

1. **`set_entry_thresholds.js` reported the WRONG routing pair.** It used
   `s[5].findIndex(x => x)` — `allPairsStatus`'s ACTIVE flag, which `addPair()` advances
   to the newest EMPTY buffer pair. Registrations don't go there:
   `_findExternalPair` (:578) takes the FIRST pair under threshold. So it named the
   standby pair as the routing pair, and a threshold change that WORKED looked like it
   had failed (it reported "routing pair T1.3 at 8 entries" while T1.1 was demonstrably
   taking every entry). Patched to mirror the contract:
   `let idx = s[4].findIndex(r => BigInt(r) < curR); if (idx < 0) idx = s[4].length - 1;`
   This is the same bug the frontend fixed in V8.45 for `currentMatA()`.
2. **`set_entry_thresholds.js` verified its write with no retry — FIXED.** T4, T8 and T10
   printed `*** VERIFY MISMATCH ***` on writes that had succeeded; all three confirmed in
   ~0.22s while every tier taking ~4.3s verified clean. The warning correlated with
   CONFIRMATION SPEED, not failure. Now retries the read 5x over ~6s before warning, and
   the warning text says to re-read manually before re-running. The hazard was never the
   false alarm — it was re-running a state-changing command that had already worked.
3. **`diag_overflow.js` — two bugs, one hiding the other. FIXED.** It hardcoded
   `getPairAt(3)` (T1.4) from the V8.45/46 deployment; V8.47 redeployed 2026-08-05 and T1
   has 3 pairs, so every run reverted `PM8: idx out of range` and produced nothing.
   Parameterised (TIER / PAIR, defaults to auto-select). That exposed a SECOND bug that
   had never executed: it called `getParkedMember(0)` assuming a parked member existed,
   panicking `ARRAY_RANGE_ERROR(50)` on a MatA with none. Now reports parked count per
   pair first and auto-selects a pair that has any.
4. **No log rotation existed at all — FIXED.** `/root/keeper/rescue.log` had reached
   **124 MB** and was unbounded; 31 logs totalling ~150 MB. Added
   `/etc/logrotate.d/cryptonova-keeper` (daily, keep 7, compress, `copytruncate` because
   the keepers append via `>>` from cron). `delaycompress` was deliberately REMOVED — it
   exists for processes holding an open fd, which `copytruncate` makes moot, and it just
   deferred the space saving a full cycle. First pass took rescue.log 124 MB -> 21 MB
   gzipped; disk 3.5G -> 3.3G used.

**Live parked population, measured 2026-08-09:** T1 parked per MatA = **[24, 19, 0]** —
43 members cycled out who could not fund the crossing and are waiting on rescue.
| `route_rr.js` cron | commented out `# TRIM-2026-08-06` | |
| `route_rr.js` kill switch | `/root/keeper/route_rr.OFF` present since 2026-08-09 | Blocks manual runs too. A dry run showed it wanted `route 1000000 -> 696`, which excludes T1.1 (3483 entries) and **refreezes the 254 members**. |

**Cost of the mitigation — corrected 2026-08-09 from live data.** The first version of
this note said the mitigation starves the younger pairs outright. It does not:
`rescueReentry` reads the SAME threshold, so at 1,000,000 every rescued member is
re-seated into their OWN pair's MatA. T1.2's MatA rotated 300 -> 301 under the
mitigation with no new registrations at all. The real cost is narrower: the youngest
pair (T1.3 at 8/127, T2.2 at 35/127, T3.2 at 3/127) stops receiving NEW members and so
stops filling. A partly-full matrix never rotates — `_cycleOutRoot` fires only at
`occupancy >= matrixSize` (MatrixLogicLib:407) — so those members wait until their
matrix reaches 127. Verified against source, not assumed.

This is a holding position, not a resting state. `V8_48_SCOPE.md` item 10b (round-robin
`_findExternalPair`) is the real fix; item 16 reverts these thresholds AFTER it ships.

**Known tooling defect (2026-08-09):** `set_entry_thresholds.js` verifies its write
IMMEDIATELY with no retry. On a fast confirmation the read lands on a pool node still
behind and it prints `*** VERIFY MISMATCH ***` for a change that succeeded — observed
on T3, verified 0.213s after the tx, while T2 (4.3s) read back clean. A delayed re-read
showed both correct. Do not re-run a state change on that warning alone; re-read after
~20s first.

