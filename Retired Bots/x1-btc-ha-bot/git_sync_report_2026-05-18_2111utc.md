# CryptoNite Git Sync — Scheduled Run Report
Run timestamp (UTC): 2026-05-18 21:11
Task: cryptonite-git-sync
Command requested: python C:\CryptoNite-MT5-Bots\git_sync.py

STATUS: NOT EXECUTED

Reason
------
Same structural blocker as every prior unattended run since 2026-05-17.
The script lives at C:\CryptoNite-MT5-Bots\git_sync.py — the parent
folder C:\CryptoNite-MT5-Bots itself is NOT mounted into Cowork's Linux
sandbox; only its four bot subfolders are bind-mounted individually:
  - C:\CryptoNite-MT5-Bots\1-btc-ha-bot
  - C:\CryptoNite-MT5-Bots\0-tg-mt5-bot
  - C:\CryptoNite-MT5-Bots\6-Quick-Scalp-NAS100
  - C:\CryptoNite-MT5-Bots\CryptoNite-Free-Signals

Consequences:
  1. The sandbox cannot read or run git_sync.py directly (path not visible).
  2. None of the subfolders contain a .git directory — the monorepo's .git
     is in the unmounted parent, so equivalent git operations also can't
     be performed from the sandbox.
  3. Running the script therefore requires driving the Windows desktop
     via the computer-use tool, which needs explicit user approval.
  4. This is an unattended scheduled run. The request_access call this
     run timed out at 180s, matching every prior attempt this week.

This run's per-run report is at:
  C:\CryptoNite-MT5-Bots\1-btc-ha-bot\git_sync_report_2026-05-18_2111utc.md

Recommendation
--------------
1. Move this schedule to Windows Task Scheduler — it can run
   git_sync.py directly with no user-approval gate. One of the existing
   wrapper batch files (_run_git_sync.bat / _git_sync_run.bat /
   _temp_run_sync.bat) is ready to use. The Cowork scheduled task can
   then be repurposed to verify the sync (check latest commit, remote
   freshness) rather than execute it.
2. Alternatively, mount C:\CryptoNite-MT5-Bots itself (rather than just
   the four sub-bot folders individually) so the sandbox can run an
   equivalent git workflow directly.

Without one of these changes, every scheduled run will continue to
produce this same report.
