# V8.50 AUTOMATION NAMING TABLE — proposal, nothing renamed yet

Written 2026-08-23 (session 32) against handoff 30.9, which scoped this and said a naming
table must be agreed **before a single file is touched**. This is that table.

Audience: the next session of Claude, plus the owner. There is no third party.

**Owner's rule, verbatim in intent:** drop the vendor naming; *name each automation for the
action it performs — for what they do.*

**The naming convention proposed throughout: `verb_object`.** `rescue_parked_copay`, not
`copay_rescue`. `report_system_health`, not `system_keeper`. The word "keeper" describes a
role, not an action, and it is what let a vendor's name sit unexamined for months.

---

## 0. READ THIS BEFORE RENAMING ANYTHING — FOUR LANDMINES

**L1. ⛔⛔ `WORK_CHAIN_LINK` IS NOT THE VENDOR. IT IS AN ON-CHAIN WORK-TYPE ID.**
`MatrixKeeper.sol:158  uint8 public constant WORK_CHAIN_LINK = 3;` — it LINKS a new MatA/MatB
pair into the CHAIN of pairs. **The value 3 is encoded into `performData` by every keeper and
decoded on chain.** Renaming the identifier is cosmetic; touching the VALUE, or renaming it in
the contract but not in the keepers, silently misroutes work items. (30.9 established this.)

**L2. ⛔⛔ `ChainLinked` IS AN EVENT, AND ITS NAME IS ITS TOPIC.**
`MatrixKeeper.sol:505  event ChainLinked(address newMatA, address newMatB, address prevMatB);`
Renaming an event changes `topic0`. Every log scanner, indexer and frontend filter keyed to it
goes silent — and goes silent QUIETLY, returning zero results rather than an error. Same for
`queueChainLink` (a function selector other contracts may call). **These are ABI, not naming.**

**L3. ⚠ `checkUpkeep` / `performUpkeep` ARE AN INTERFACE, NOT BRANDING.**
They are the AutomationCompatibleInterface convention, but they are also the ABI our driver,
the frontend and the V8.50 private deployment all speak. **Renaming them is a redeploy plus a
coordinated keeper/frontend update — a migration, not a cleanup.** 30.9's recommendation
stands: keep the function names, drop the vendor from the DOCS.

**L4. ⛔ THE LIVE CRONTAB IS NOT THE MIRROR, AND PHASE G HAS IT REDUCED.**
`crontab_live_mirror.txt` is dated 2026-08-11 and says of itself *"THIS FILE IS A MIRROR, NOT
THE SOURCE OF TRUTH. The VPS is."* Handoff 29.11 records the live crontab **cut to 8 lines for
PHASE G**, with `copay_rescue`, `fastlane_rescue` and `system_keeper` paused, to be restored
from `/root/crontab.backup.phaseG` (11 active lines) when PHASE G ends.
**A rename applied to the live crontab now is UNDONE the moment that backup is restored.**
Either do this after the restore, or rename in the backup file too — and verify both.

---

## 1. TIER 1 — FREE. Cron comment labels and lockfiles. Zero blast radius.

✅ **DONE 2026-08-27 (session 43), applied on the VPS by `rename_tier1_locks.sh`**
(keepers repo — kept as the record of the op; undo at
`/root/crontab.backup.pre_rename_2026-08-27`). All 7 ACTIVE locks renamed + the two
NECESSARY-section comment labels; verified per section 7: 11 active lines, every
renamed job produced its new lock file and fresh log entries within one cron cycle.
`frozen_matb` and `evict` rows are moot (job deleted 2026-08-26 / cron line absent);
locks on PAUSED/TRIM lines deliberately untouched — rename them with their Tier 3
script renames when stress is revisited.

Lockfile paths are referenced nowhere but their own cron line. Rename freely.

| current lock | proposed | the job's actual action |
|---|---|---|
| `/tmp/direct_keeper.lock` | `/tmp/run_work_queue.lock` | executes the contract's own work queue via `performUpkeep` |
| `/tmp/copay.lock` | `/tmp/rescue_parked_copay.lock` | rescues parked members with a Stability Fund co-pay |
| `/tmp/fastlane.lock` | `/tmp/rescue_parked_selffunded.lock` | rescues parked members who can already cover the fee (zero-debt) |
| `/tmp/frozen_matb.lock` | `/tmp/rotate_frozen_matb.lock` | force-rotates a MatB that has stopped churning |
| `/tmp/dupe_watch.lock` | `/tmp/watch_duplicate_seats.lock` | catches a duplicate seat as it forms |
| `/tmp/growth.lock` | `/tmp/snapshot_growth.lock` | appends one CSV row per pair per run |
| `/tmp/system_keeper.lock` | `/tmp/report_system_health.lock` | health snapshot |
| `/tmp/onramp.lock` | `/tmp/distribute_onramp_rewards.lock` | pays out external on-ramp revenue |
| `/root/keeper/evict.lock` | `/root/keeper/evict_parked.lock` | drains the parked queue |

Cron **comment** labels get the same treatment; they are documentation only.

---

## 2. TIER 2 — LOG FILE NAMES. ⛔ NOT FREE, AND I RECOMMEND NOT DOING MOST OF IT.

**This is the one that looks cosmetic and is not.** `keeper.log` in particular is load-bearing:

* every gas figure in `V8_50_HANDOFF.md` was extracted from it by name
* `gas_sample_census.sh` greps `keeper.log` and `keeper.log.*.gz` by name
* logrotate on the droplet rotates it daily at 23:55 by name — **a rename that misses the
  logrotate config gives you an unrotated log that grows without bound, and a rotation set
  that stops at the old name.** 31.5's `.1.gz` planted positive depended on that rotation.
* 31.6's dated de-censoring re-run reads it in ~3-10 days

**RECOMMENDATION: leave the log filenames alone for now.** If they are renamed later, do it as
its own dated cutover: update logrotate in the same step, keep the old rotated `.gz` files in
place, and write the cutover date into the handoff so a future extraction knows the archive
spans two names. The naming win is small; the chance of quietly breaking the historical record
is not.

*(Exception worth taking: `health.log` for `system_keeper.js` and `monitor.log`/`pulse.log`
are reporting outputs nothing quotes. Those are safe if you want them.)*

---

## 3. TIER 3 — SCRIPT FILENAMES. Medium risk: cron lines, docs and handoffs reference them.

Grouped by `AUTOMATION_AUDIT.md`'s own verdicts, because the verdict IS the action.

### B — the engine
| current | proposed | action |
|---|---|---|
| `direct_keeper.js` | `run_work_queue.js` | drives `performUpkeep`; the contract's authorised caller |

### C — off-chain only because the contract cannot discover the work
| current | proposed | action |
|---|---|---|
| `copay_rescue.js` | `rescue_parked_copay.js` | SF co-pay rescue |
| `fastlane_rescue.js` | `rescue_parked_selffunded.js` | zero-debt rescue, no loan grace |
| `evict_parked.js` | *(keep)* | already named for the action |
| `manual_rescue.js` | `rescue_parked_manual.js` | operator-driven rescue |

### A — genuinely off-chain (alerting, reporting, observability)
| current | proposed | action |
|---|---|---|
| `integrity_check.js` | *(keep)* | already action-named; and it is cron'd hourly with `ALERT=1` |
| `sf_invariant_check.js` | *(keep)* | ditto |
| `system_keeper.js` | `report_system_health.js` | **"keeper" here does no keeping — it reports** |
| `monitor_v8.js` | `report_daily.js` | version in the filename is the same trap as the old crontab name |
| `channel_pulse.js` | `report_channel_pulse.js` | posts to the community channel |
| `growth_snapshot.js` | `snapshot_growth.js` | verb first, consistent with the rest |
| `dupe_watch.js` | `watch_duplicate_seats.js` | |
| `onramp_keeper.js` | `distribute_onramp_rewards.js` | **another "keeper" that distributes rather than keeps** |

### D — compensating for a contract defect
| current | proposed | action |
|---|---|---|
| `frozen_matb_keeper.js` | `rotate_frozen_matb.js` | force-rotates a frozen MatB — ⚠ audit says likely REDUNDANT with on-chain `WORK_FORCE_ROTATE`; **settle that before renaming it, since the right answer may be deletion** |
| `route_rr.js` | *(do not rename — do not re-enable)* | masked the `rescueReentry` bug; audit §D says fix the contract instead |

### stress engine (all paused)
| current | proposed |
|---|---|
| `rr_keeper.js` | `stress_round_robin.js` |
| `pool_primer.js` | `stress_prime_wallet_pool.js` |

⚠ **A script rename must land in the same commit as its cron line, its lockfile, and any
`scp` runbook step that names it.** A renamed file with an unrenamed cron line is a job that
silently stops running — and every one of these is on a 10-to-30-minute timer, so it fails
quietly for hours before anyone notices.

---

## 4. TIER 4 — CONTRACT COMMENTS. No bytecode change. Do these first; they are simply false.

| file:line | current text | why it is wrong |
|---|---|---|
| `MatrixKeeper.sol:9` | "Chainlink Automation-compatible keeper" | our DigitalOcean cron calls it |
| `MatrixKeeper.sol:46` | "Chainlink Automation calls checkUpkeep() each block" | it does not, and never has |
| `MatrixKeeper.sol:57` | "Set Chainlink upkeep gas limit to 3,000,000" | **actively dangerous — the shipped budget is 16.5M (30.10a)** |
| `MatrixKeeper.sol:454` | "Chainlink forwarder if kept" | 30.5e settled it: not Chainlink |
| `MatrixKeeper.sol:802` | "simulated OFF-CHAIN by Chainlink" | simulated off-chain by our driver |
| `CommunityWallet.sol:38, 272, 403` | three more "Chainlink Automation" mentions | same |

⚠ `MatrixKeeper.sol:57` is not a naming problem wearing a comment. **A comment naming a
3,000,000 gas limit, in a contract whose measured worst item is 13.03M, is a trap for whoever
reads it next.** Fix it in this pass whatever is decided about names.

Also in this tier, from 30.9 item 2: **CLAUDE.md's selector row mislabelling `0xcef6d209`
(30.5d) — fix FIRST.** It is the line that cost session 30 three rounds. And per 31.8 item 9,
`0xdb9B1e94…` now needs only "MetaMask DelegationManager, external, not ours".

---

## 5. TIER 5 — THE `ChainLink` IDENTIFIERS. Deliberate and tested, or not at all.

Proposed, and **only as one reviewed commit with the values pinned by a test**:

| current | proposed | risk |
|---|---|---|
| `WORK_CHAIN_LINK = 3` | `WORK_PAIR_LINK = 3` | **value must stay 3** — see L1 |
| `_doChainLink` / `_doChainLinkExternal` | `_doPairLink` / `_doPairLinkExternal` | internal/self-only; low |
| `pendingChainLinks` | `pendingPairLinks` | **public array — the auto-generated getter's selector changes** |
| `_flushChainLinks` | `_flushPairLinks` | internal; low |
| `queueChainLink` | `queuePairLink` | **selector change — check every on-chain and off-chain caller** |
| `event ChainLinked` | `event PairLinked` | **topic0 change — see L2. Highest risk item on this page.** |

▶ **The safe subset is the internal ones** (`_doChainLink`, `_flushChainLinks`) plus the
constant, with a test asserting `WORK_PAIR_LINK == 3`. The public getter, the function
selector and the event are an ABI change and belong with the next redeploy, not with a
naming pass. **V8.50 is a fresh deploy anyway (no proxy machinery) — so if it is going to be
done, the V8.50 migration is the cheapest moment it will ever have.**

---

## 6. PROPOSED ORDER

* **1.** CLAUDE.md selector row (30.5d) — smallest, and it is actively misleading.
* **2.** Contract comments, Tier 4 — no bytecode, includes the 3M gas-limit trap.
* **3.** ✅ DONE 2026-08-27 — Tier 1 lockfiles + cron comment labels (see section 1).
* **4.** ✅ SETTLED 2026-08-26 — `frozen_matb_keeper` was DELETED (audit item 1 verdict);
  its cron line and file are gone from the VPS.
* **5.** Tier 3 script renames, each with its cron line and lockfile in the same commit.
* **6.** Tier 5 identifiers — internal subset now, ABI subset with the V8.50 deploy.
* **NOT NOW:** log filenames (Tier 2), and nothing at all until 31.6's de-censoring re-run has
  read `keeper.log` under the name it has today.

## 7. VERIFICATION — what proves a rename did not break anything

* After any cron change: `crontab -l | grep -c "^[^#]"` — **11 active lines** post-PHASE-G.
* After any script rename: wait one full cron interval, then confirm the job's log has a new
  entry. **A renamed job that stopped running looks exactly like a quiet one.**
* After Tier 5: `npx hardhat test` full suite, plus a direct assertion that the work-type ids
  still read 0-9 in the order at `MatrixKeeper.sol:155-172`.
* After the contract comments: nothing to verify — but re-run `node scripts/sizes.js` anyway,
  because a comment edit that accidentally lands in code is the failure this catches.
