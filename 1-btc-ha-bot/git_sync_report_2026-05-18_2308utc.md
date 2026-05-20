# CryptoNite Git Sync — Scheduled Run Report
Run timestamp (UTC): 2026-05-18 23:08
Task: cryptonite-git-sync
Command requested: python C:\CryptoNite-MT5-Bots\git_sync.py

STATUS: NOT EXECUTED

Reason
------
Same structural blocker as every prior unattended run since 2026-05-10
(now 8+ days, 200+ failed cycles). Verified fresh this run:

1. `C:\CryptoNite-MT5-Bots\` is NOT mounted into the Cowork sandbox.
   Only the four bot subfolders are bind-mounted individually:
     - 0-tg-mt5-bot
     - 1-btc-ha-bot
     - 6-Quick-Scalp-NAS100
     - CryptoNite-Free-Signals
   `git_sync.py` and the monorepo's `.git/` live at the unmounted parent,
   so the sandbox cannot read, inspect, or execute the script, and cannot
   run an equivalent `git add / commit / push` from inside any subfolder
   (none of them is a git repo on its own).

2. No Windows-side run fired this cycle either. `git_sync_output.txt`
   was last written 2026-05-18 21:11 UTC (the previous cycle's failure
   report) — no `sync_done.flag`, no fresh `_sync_output.txt`.

3. Running the command through the Windows shell requires computer-use,
   which needs an interactive `request_access` approval. This is an
   unattended run; no user is present to approve it.

Safety note — .env exposure remains UNVERIFIED
----------------------------------------------
All four mounted bot folders still contain a `.env` file and **none**
contains a local `.gitignore`. The script's claim of "respecting
.gitignore so .env files are never committed" cannot be confirmed from
the sandbox because the parent `.gitignore` (if any) is not visible.
Before this sync is allowed to run automatically, confirm that the
repo-root `.gitignore` excludes `**/.env`.

Recommendation (pick one)
-------------------------
1. **Move the schedule to Windows Task Scheduler.** Run
   `python C:\CryptoNite-MT5-Bots\git_sync.py` (or
   `1-btc-ha-bot\_temp_run_sync.bat`, which already does
   `cd /d C:\CryptoNite-MT5-Bots && python git_sync.py`) every 30 min
   under your Windows account. Bypasses the Cowork sandbox entirely.
   Then **delete this Cowork scheduled task** so it stops generating
   failure reports.

2. **Share `C:\CryptoNite-MT5-Bots\` with Cowork** (the parent, not just
   the four children). The sandbox would then see `git_sync.py` and the
   `.git/` checkout and could run the sync directly. A prior report noted
   a Unicode character in the script's final `print()` that may crash
   under Windows' default code page when stdout is redirected — worth
   testing once the script is reachable.

Until one of these is done, every 30-minute cycle will keep producing a
report like this one. Consider pausing or deleting the Cowork task in
the meantime.

Cleanup
-------
`1-btc-ha-bot/` now holds 20+ `git_sync_report_*` files all documenting
the same blocker. The 2026-05-10 through 2026-05-17 reports, plus
earlier 2026-05-18 reports, are safe to delete once you've read this.
