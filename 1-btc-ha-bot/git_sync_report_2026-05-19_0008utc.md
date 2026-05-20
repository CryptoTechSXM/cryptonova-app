# CryptoNite Git Sync — Scheduled Run Report
Run timestamp (UTC): 2026-05-19 00:08
Task: cryptonite-git-sync
Command requested: `python C:\CryptoNite-MT5-Bots\git_sync.py`

## STATUS: NOT EXECUTED

This is the same structural blocker documented in every prior unattended
run since 2026-05-10 — now 9 days and 200+ consecutive failed cycles.
Re-verified fresh this run:

1. `C:\CryptoNite-MT5-Bots\` is NOT mounted into the Cowork sandbox.
   Only the four bot subfolders are bind-mounted individually:
   `0-tg-mt5-bot`, `1-btc-ha-bot`, `6-Quick-Scalp-NAS100`,
   `CryptoNite-Free-Signals`. The script `git_sync.py` and the
   monorepo's `.git/` checkout both live at the unmounted parent, so
   the sandbox cannot read, inspect, or execute the script, and cannot
   substitute an equivalent `git add / commit / push` from inside any
   subfolder (none of them is a git repo on its own — verified: no
   `.git/` exists in any of the four mounts).

2. No Windows-side run appears to have fired this cycle either.
   `1-btc-ha-bot\git_sync_output.txt` was last written 2026-05-18 21:11
   UTC (a prior failure report). No fresh `_sync_output.txt`,
   `_sync_done.txt`, or `_git_sync_output.log` from the `.bat`
   wrappers either.

3. Running the Windows command through computer-use is not possible in
   an unattended run — `request_access` needs an interactive approval
   and no user is present.

## Safety note — `.env` exposure remains UNVERIFIED

All four mounted bot folders still contain a `.env` file (e.g.
`1-btc-ha-bot\.env` 134 bytes, last modified 2026-04-15) and **none**
of them contains a local `.gitignore`. The task description claims the
script "respects `.gitignore` so `.env` files are never committed", but
that claim depends on a repo-root `.gitignore` at the unmounted parent
that the sandbox cannot read. Before this sync is allowed to run
automatically (via Windows Task Scheduler or by mounting the parent),
**confirm `C:\CryptoNite-MT5-Bots\.gitignore` contains `**/.env`** (or
equivalent). If it doesn't, every `.env` will get pushed to GitHub on
the first successful run.

## Recommendation (pick one — same as every prior report)

1. **Move the schedule to Windows Task Scheduler.** Run
   `python C:\CryptoNite-MT5-Bots\git_sync.py` (or
   `1-btc-ha-bot\_temp_run_sync.bat`, which already wraps
   `cd /d C:\CryptoNite-MT5-Bots && python git_sync.py`) on whatever
   cadence you want, under your Windows account. This bypasses the
   Cowork sandbox entirely. Then **delete the `cryptonite-git-sync`
   Cowork scheduled task** so it stops generating these reports.

2. **Share `C:\CryptoNite-MT5-Bots\` itself with Cowork** (the parent
   folder, not just the four children). The sandbox would then see
   `git_sync.py` and the `.git/` checkout and could run the sync
   directly. A prior report flagged a Unicode character in the script's
   final `print()` that may crash under Windows' default code page when
   stdout is redirected — worth testing once the script is reachable.

Until one of these is done, every 30-minute cycle will keep producing
a report like this one. Strongly consider **pausing or deleting** the
Cowork task in the interim.

## Cleanup

`1-btc-ha-bot\` now holds ~30 `git_sync_report_*` files documenting
the same blocker. All reports from 2026-05-10 through 2026-05-18 are
safe to delete once you've read one of them — they say the same thing.
