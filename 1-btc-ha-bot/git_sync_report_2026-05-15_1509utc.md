# Git Sync Report — 2026-05-15 15:09 UTC (standalone run record)

**Status: NOT RUN.** The scheduled task could not perform the sync. Same structural blocker as every unattended run since 2026-05-10.

Written as a standalone file (not appended to the shared per-day `git_sync_report_2026-05-15.md`) because that file is being clobbered by overlapping runs of this task — see the 11:10 UTC report for details. Prior runs at 11:10, 13:09 and 14:10 UTC followed the same standalone-file pattern.

## What was checked this run

Re-verified the full sandbox state in two batched bash calls (`date -u` = `Fri May 15 15:09:34 UTC 2026`):

1. **The script is unreachable.** `python C:\CryptoNite-MT5-Bots\git_sync.py` cannot run. Only four child folders are shared with Cowork — `0-tg-mt5-bot`, `1-btc-ha-bot`, `6-Quick-Scalp-NAS100`, `CryptoNite-Free-Signals`. Their parent `C:\CryptoNite-MT5-Bots\` — which holds `git_sync.py` and the `.git/` checkout — is **not** mounted. `ls` of that path returns "No such file or directory". The script cannot be run or even inspected.
2. **No sandbox-side git fallback.** `find -maxdepth 4` finds no `git_sync.py` and no `.git/` anywhere in the sandbox. None of the four mounted folders is itself a git repo, and none contains a `.gitignore`. A `git add / commit / push` from the sandbox is impossible. (`git` v2.34.1 is installed, but there is no repo or remote for it to act on.)
3. **No Windows-side run occurred either.** No leftover `_sync_output.txt` or `sync_done.flag` in `1-btc-ha-bot/`.
4. **Desktop control isn't available unattended.** Running the command through the Windows shell needs an interactive `request_access` approval, which has timed out (~180 s) on every unattended run in this 5-day series. Not retried this run, per standing guidance from prior reports — retrying only burns ~3 minutes.

No commit, push, or filesystem change was made other than creating this report. The four `.env` files (one per bot folder) were not touched, read for content, or exposed.

Note: because `git_sync.py` cannot be inspected, its claim of "respecting .gitignore so .env files are never committed" remains **unverified**.

## Action required from the user — the task cannot succeed as configured

**Option 1 (recommended): move the sync to Windows Task Scheduler.** Create a Windows scheduled task that runs `python C:\CryptoNite-MT5-Bots\git_sync.py` on your desired interval. It runs under the Windows account with the existing git credentials and bypasses the Cowork sandbox entirely. The existing `1-btc-ha-bot\_temp_run_sync.bat` wrapper (it `cd`s to `C:\CryptoNite-MT5-Bots` and runs `python git_sync.py`) is a ready-made target.

**Option 2: share `C:\CryptoNite-MT5-Bots\` itself with Cowork.** Add the parent directory as a Cowork folder, not just the four child folders. The sandbox would then see `git_sync.py` and `.git/` directly. The script's hardcoded Windows path would need adjusting, and a prior report flagged a Unicode character in its final `print` that crashes under Windows' default code page when stdout is redirected.

**In the meantime: pause or delete this Cowork scheduled task.** It has failed every run since 2026-05-10 and now also spawns overlapping instances that race on the shared per-day report file. Until Option 1 or Option 2 is in place, every run only produces another failure report like this one.
