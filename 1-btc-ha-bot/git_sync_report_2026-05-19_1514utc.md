# CryptoNite Git Sync - Run Report

**Run:** 2026-05-19 15:14 UTC (Tuesday)
**Task:** `cryptonite-git-sync` (auto-backup every 30 minutes)
**Command requested:** `python C:\CryptoNite-MT5-Bots\git_sync.py`
**Outcome:** BLOCKED - the script was not executed and nothing was committed or pushed.

## What I tried this run

1. Looked for `git_sync.py` from the sandbox at `C:\CryptoNite-MT5-Bots\git_sync.py`. Not reachable - the parent folder is not mounted into the Cowork sandbox. Only the four bot subfolders are.
2. Checked each mounted subfolder for a `.git` directory so I could replicate the operations sandbox-side. None of them is itself a git repo, which is consistent with the repo root living in the un-mounted parent.
3. Fell back to driving Windows. Wrote a wrapper at
   `outputs\run_git_sync.bat` that calls the script and pipes stdout/stderr to a log, planning to fire it through the Run dialog. Called `request_access` for the Run app - the dialog timed out after 180 seconds because the user is not at the machine to approve it. Without that approval, computer-use refuses every action.

## Root cause

The scheduled task runs unattended, but executing `git_sync.py` requires either:

- direct sandbox access to `C:\CryptoNite-MT5-Bots\` (so I can run git from the Linux sandbox without any GUI), or
- a user at the keyboard to approve a computer-use prompt for a Windows app.

Neither is true on a 30-minute autonomous schedule, so every tick fails the same way.

## Recommended fix (in order of effort)

1. **Move the schedule to Windows Task Scheduler.** Have Windows run `python C:\CryptoNite-MT5-Bots\git_sync.py` on a 30-minute trigger under your user account. All git credentials are already configured locally, no Cowork involvement needed. This is the cleanest fix.
2. **Share `C:\CryptoNite-MT5-Bots\` with Cowork** (the parent, not just the subfolders). Then I can run the git plumbing from the sandbox on every tick. Requires a credential helper or SSH deploy key usable from the sandbox.
3. **Keep the Cowork schedule but supervise it.** Be at the machine when the task fires and click Allow. Not realistic at this cadence.

## Files touched

- `1-btc-ha-bot\.cowork-git-sync-status.txt` - status updated for this run.
- `1-btc-ha-bot\git_sync_report_2026-05-19_1514utc.md` - this report.

No source files in any bot folder were modified. No commits, no pushes.
