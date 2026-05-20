# CryptoNite Git Sync — Scheduled Run Report

- Run timestamp (UTC): 2026-05-19 16:14
- Task: `cryptonite-git-sync`
- Command requested: `python C:\CryptoNite-MT5-Bots\git_sync.py`

## Status: NOT EXECUTED

Same structural blocker that has held since 2026-05-10. No new diagnosis
this run; the situation is unchanged.

## What was attempted this run

1. Re-verified the four mounted bot folders. None contains a `.git/`
   directory; the monorepo's `.git/` lives at the unmounted parent
   `C:\CryptoNite-MT5-Bots\`. Git operations cannot be reproduced from
   the sandbox.
2. `git_sync.py` is not visible from the sandbox (parent folder unmounted).
3. Attempted computer-use fallback: `request_access(["Run", "Command
   Prompt", "File Explorer", "Notepad"])` — timed out after 180 s, as
   expected for an unattended scheduled run with no one at the keyboard
   to approve the access dialog.

## Result

No files were staged, committed, or pushed. No changes were made to any
git repo. This run produced only status/report files inside
`1-btc-ha-bot`.

## To unblock future runs

Pick one of:

1. **Move this schedule to Windows Task Scheduler.** Simplest fix.
   `python C:\CryptoNite-MT5-Bots\git_sync.py` on a 30-min trigger under
   your user account runs the script directly with all credentials in
   place — no Cowork sandbox, no approval dialog. After that, delete
   this Cowork scheduled task.
2. **Share the parent `C:\CryptoNite-MT5-Bots` folder with Cowork** (not
   just the four subfolders). The sandbox could then run `git_sync.py`
   itself — but it would still need git auth that works headlessly
   (SSH deploy key, or a cached PAT / credential helper inside the
   sandbox).
3. **Be at the keyboard when this fires** so you can click Allow on the
   computer-use approval prompt. Not realistic at a 30-min cadence.

Until one of (1) or (2) is done, every cycle will produce a report
identical in substance to this one.
