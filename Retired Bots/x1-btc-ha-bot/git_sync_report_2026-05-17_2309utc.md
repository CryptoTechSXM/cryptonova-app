# Git Sync Report — 2026-05-17 23:09 UTC

**Status: NOT RUN.** 16th consecutive failure today, **44th failure file overall** since 2026-05-10. No change in conditions since the 22:12 UTC report.

## Summary

- `python C:\CryptoNite-MT5-Bots\git_sync.py` cannot be executed: the script's parent directory `C:\CryptoNite-MT5-Bots\` is not mounted in the Cowork sandbox. Only the four child folders are mounted, and none of them contains the script or a `.git` directory visible from the sandbox.
- `request_access` for a Windows terminal was **not** attempted this run — the prior 15 attempts today all timed out at 180 s because the user is not present during scheduled runs. Calling it again would just burn another 3 minutes producing the same result.
- No commit, no push, no file change in any of the four bot folders. `.env` files untouched.

## This will keep failing until one of these is done

1. **Recommended — move the sync to Windows Task Scheduler.** Point it at `C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_temp_run_sync.bat` (or `_run_git_sync.bat`). It runs under the logged-in user with existing git credentials, no Cowork approval needed, and it works whether or not Cowork is open.
2. **Alternative — add `C:\CryptoNite-MT5-Bots\` as a Cowork folder** so the sandbox can see `git_sync.py` and `.git` directly. Then this scheduled task can actually execute the script.
3. **Stopgap — pause or delete the Cowork `cryptonite-git-sync` scheduled task** to stop generating these report files every 30 minutes.

See `git_sync_report_2026-05-17_2212utc.md` and earlier for the full diagnostic history.
