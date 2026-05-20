# Git Sync Report — 2026-05-15 14:09 UTC (standalone run record)

**Status: NOT RUN.** The scheduled task could not perform the sync. Same structural blocker
as every unattended run since 2026-05-10.

Written as a standalone, timestamped file (not an append to `git_sync_report_2026-05-15.md`)
because that shared per-day file is still being clobbered by overlapping runs of this task —
see the 11:10 and 13:09 UTC reports for the details of that race.

## What was checked this run

Verified fresh at `date -u` = Fri May 15 14:09:55 UTC 2026:

1. **The script is unreachable.** `ls "C:\CryptoNite-MT5-Bots\git_sync.py"` →
   *"No such file or directory."* Only four child folders are shared with Cowork —
   `0-tg-mt5-bot`, `1-btc-ha-bot`, `6-Quick-Scalp-NAS100`, `CryptoNite-Free-Signals`.
   Their parent `C:\CryptoNite-MT5-Bots\`, which holds `git_sync.py` and the `.git/`
   checkout, is **not** mounted. The script cannot be run or even inspected.
2. **No sandbox-side git fallback.** `find -maxdepth 4` across the sandbox finds no
   `git_sync.py`, no `.git/`, and no `.gitignore`. None of the four mounted folders is a
   git repository, so a `git add / commit / push` from the sandbox is impossible.
3. **No Windows-side run happened either.** No `_sync_output.txt` and no `sync_done.flag`
   in `1-btc-ha-bot/` — the `_temp_run_sync.bat` / `_cowork_runner.bat` wrappers did not
   fire this cycle.
4. **Desktop control isn't available unattended.** Running the command through the Windows
   shell needs an interactive `request_access` approval. With no user present that dialog
   cannot be granted (it has timed out on every unattended run for this 5-day series). Not
   retried this run, consistent with the standing decision in prior reports.

No commit, push, or filesystem change was made other than creating this report file.
`heartbeat.txt` files were left untouched.

## Safety note — .env exposure remains UNVERIFIED

Because `git_sync.py` cannot be inspected, its claim of *"respecting .gitignore so .env
files are never committed"* still cannot be confirmed. All four bot folders contain a
`.env` file and **none** contains a `.gitignore`. If the real repo at the parent level
also lacks a `.gitignore` covering these paths, a successful sync could push secrets to
GitHub. This should be confirmed before the sync is made to run.

## This task has now failed for 5 days straight

Every 30-minute run since 2026-05-10 has hit this same wall — well over 200 unattended
failures — and recent cycles also spawn overlapping instances that race on the shared
report file. The task cannot succeed in its current configuration. It needs a
configuration change from you; I did not make one myself because that is your call and the
task file did not request it.

## What will fix it (pick one)

**Option 1 — recommended: move the sync to Windows Task Scheduler.** Create a native
Windows scheduled task that runs `python C:\CryptoNite-MT5-Bots\git_sync.py` every 30
minutes. It runs under your Windows account with the existing git credentials and bypasses
the Cowork sandbox entirely. `1-btc-ha-bot\_temp_run_sync.bat` already does exactly this
(`cd /d C:\CryptoNite-MT5-Bots` then `python git_sync.py`) and is a ready-made target.
Then **delete this Cowork scheduled task** so it stops generating failure reports.

**Option 2 — share the parent folder with Cowork.** Add `C:\CryptoNite-MT5-Bots\` itself
as a Cowork folder (not just the four child folders). The sandbox would then see
`git_sync.py` and `.git/` directly and could run the sync. Note: a prior report flagged a
Unicode character in the script's final `print()` that crashes under Windows' default code
page when stdout is redirected, and the script's hardcoded Windows path may need adjusting
to run from the sandbox.

**Until then:** consider pausing or deleting this Cowork scheduled task. As configured it
can only produce another failure report like this one every 30 minutes.

## Cleanup suggestion

`1-btc-ha-bot/` now holds eight `git_sync_report_*` files. Once you've read this, the older
ones (`2026-05-10` through `2026-05-14`, plus the two earlier 05-15 standalone files) are
safe to delete — they all document the same blocker.
