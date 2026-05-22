# CryptoNite Git Sync - Per-Run Report

- Run timestamp: 2026-05-19 19:12 UTC (Tuesday)
- Outcome: BLOCKED - could not execute
- Day 10 of this blocker (since 2026-05-10)

## What was requested

The scheduled task asked me to execute:

    python C:\CryptoNite-MT5-Bots\git_sync.py

## Why it could not run

The script lives at `C:\CryptoNite-MT5-Bots\git_sync.py` and operates on
the git repository rooted at `C:\CryptoNite-MT5-Bots\`. That parent
folder is not shared with the Cowork sandbox - only its four bot
subfolders are mounted:

- `C:\CryptoNite-MT5-Bots\1-btc-ha-bot`
- `C:\CryptoNite-MT5-Bots\0-tg-mt5-bot`
- `C:\CryptoNite-MT5-Bots\6-Quick-Scalp-NAS100`
- `C:\CryptoNite-MT5-Bots\CryptoNite-Free-Signals`

None of the subfolders is itself a git repository (re-verified this run:
`git rev-parse --show-toplevel` from inside `1-btc-ha-bot` returns
"not a git repository"). So the sync cannot be reproduced inside the
sandbox even partially - there is no `.git` directory to act on, and the
sandbox has no GitHub credentials anyway.

## What I tried this run

1. Re-verified the four subfolder mounts and the absence of `.git` in
   any of them.
2. Called `request_access` for "Windows PowerShell" with reason
   "Run the scheduled git sync script for CryptoNite MT5 Bots."
   Result: timed out after 180 seconds. No user was at the keyboard to
   click Allow - this is an unattended scheduled run.

Even if approval had come through, Windows PowerShell is granted at the
computer-use "click" tier, which blocks `type` and key input. I could
click a Run button in a pre-loaded session, but I cannot type
`python C:\CryptoNite-MT5-Bots\git_sync.py` into a terminal. So the
computer-use path cannot complete this task unattended regardless.

## Cumulative status

Same blocker on every unattended Cowork run since 2026-05-10
(approx. 10 days, hundreds of failed cycles). No commits have been
pushed by this scheduled task in that window. The previous status file
in `1-btc-ha-bot\.cowork-git-sync-status.txt` already documents this
pattern.

## Recommended fix

Move this schedule out of Cowork and onto Windows Task Scheduler:

- Trigger: every 30 minutes (or whatever cadence you want)
- Action: `python C:\CryptoNite-MT5-Bots\git_sync.py`
- Run as: your Windows user account
- Run whether user is logged on or not: yes

That runs the script natively on Windows, with the real git credentials
and the real repo, with no sandbox and no approval prompt. After it's
working, delete this Cowork scheduled task to stop the failed-run
churn.

Alternative (worse): share `C:\CryptoNite-MT5-Bots\` itself with Cowork
instead of the four subfolders, so the sandbox can see `git_sync.py`
and `.git\`. Even then the sandbox would still need GitHub credentials
to push, and the script's environment expectations (Windows paths,
Python on PATH) may not match the Linux sandbox.
