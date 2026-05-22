# Git Sync Report — 2026-05-15 11:10 UTC (standalone run record)

**Status: NOT RUN.** The scheduled task could not perform the sync. Same structural blocker as every unattended run since 2026-05-10.

This is a standalone file rather than an append to `git_sync_report_2026-05-15.md` because that shared per-day file is currently being overwritten by overlapping runs (see "New finding" below) and could not be appended to reliably.

## Why the sync cannot run

The task asks for `python C:\CryptoNite-MT5-Bots\git_sync.py` to be executed. Re-verified this run (`date -u` = Fri May 15 11:10 UTC 2026):

1. **The script is unreachable.** Only four child folders are shared with Cowork — `0-tg-mt5-bot`, `1-btc-ha-bot`, `6-Quick-Scalp-NAS100`, `CryptoNite-Free-Signals`. Their parent `C:\CryptoNite-MT5-Bots\` — which holds `git_sync.py` and the `.git/` checkout — is **not** mounted. `ls` of that path returns "No such file or directory", and the Read tool reports it is "outside this session's connected folders". The script cannot be run or even inspected.
2. **No sandbox-side git fallback.** `find -maxdepth 4` finds no `git_sync.py` and no `.git/` anywhere in the sandbox. None of the four mounted folders is itself a git repo, and none contains a `.gitignore`. A `git add / commit / push` from the sandbox is impossible. (`git` v2.34.1 is installed, but there is no repo or remote for it to act on.)
3. **Desktop control isn't available unattended.** Running the command via the Windows shell needs an interactive `request_access` approval, which has timed out at ~180 s on every unattended run for this 5-day series. Not retried this run, per standing guidance from prior reports.

No leftover `_sync_output.txt` or `sync_done.flag` in `1-btc-ha-bot/`, so no Windows-side run occurred either. No commit, push, or filesystem change was made other than creating this file (and two append attempts to the shared report that were both overwritten — see below).

Note: because `git_sync.py` cannot be inspected, its claim of "respecting .gitignore so .env files are never committed" remains **unverified**. All four bot folders contain a `.env` file and none contains a `.gitignore`.

## New finding this run — concurrent-write race on the report file

The shared `git_sync_report_2026-05-15.md` is being modified by **overlapping runs of this scheduled task**:

- At the start of this run the file ended at the 07:10 UTC note (34 lines).
- Mid-run, notes for 08:09 and 09:09 UTC appeared in it from other writers.
- A first append for this run (~11:09:45) was overwritten by another writer at 11:10:03.
- A second append (~11:10:xx) was again overwritten within 2 seconds — the file's md5 changed and grew by 2 lines, but those lines were another run's content, not this run's.

This indicates the scheduler is firing overlapping/backlogged instances that race on the same per-day file and clobber each other's writes. That is an additional, independent reason to stop the schedule.

## Action required from the user — the task cannot succeed as configured

**Option 1 (recommended): move the sync to Windows Task Scheduler.** Create a Windows scheduled task that runs `python C:\CryptoNite-MT5-Bots\git_sync.py` every 30 minutes. It runs under the Windows account with the existing git credentials and bypasses the Cowork sandbox entirely. The existing `1-btc-ha-bot\_temp_run_sync.bat` wrapper (it `cd`s to `C:\CryptoNite-MT5-Bots` and runs `python git_sync.py`) is a ready-made target.

**Option 2: share `C:\CryptoNite-MT5-Bots\` itself with Cowork.** Add the parent directory as a Cowork folder, not just the four child folders. The sandbox would then see `git_sync.py` and `.git/` directly. The script's hardcoded Windows path would need adjusting, and a prior report flagged a Unicode character in its final `print` that crashes under Windows' default code page when stdout is redirected.

**In the meantime: pause or delete this Cowork scheduled task.** It has failed every 30-minute run since 2026-05-10 (well over 200 unattended runs) and now also spawns overlapping instances that race on the report file. Until Option 1 or Option 2 is in place, every run only produces another failure report.
