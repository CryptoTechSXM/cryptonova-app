# Git Sync Report — 2026-05-18 01:14 UTC

**Status: NOT RUN.** 1st failure file for 2026-05-18 UTC, **45th failure file overall** since 2026-05-10. First run after the 2026-05-17 23:09 UTC report. No change in conditions.

## Summary

- `python C:\CryptoNite-MT5-Bots\git_sync.py` cannot be executed: `C:\CryptoNite-MT5-Bots\` is still not mounted in the Cowork sandbox. Re-verified: `find /mnt -maxdepth 3 -name git_sync.py` and `find /mnt -maxdepth 3 -name .git -type d` both return nothing.
- `request_access` for the Run dialog / File Explorer **was attempted this run** and timed out at 180 s (same as every prior unattended attempt). The 23:09 UTC report flagged that future runs should skip this call to avoid burning 3 minutes; noting that for the next run — the next scheduled execution should go straight to writing this report without calling `request_access`.
- No commit, no push, no file change in any of the four bot folders. `.env` files untouched.

## Heartbeats — still aging, no bot process is updating them

- `1-btc-ha-bot/heartbeat.txt` — 2026-05-15 00:23:53 UTC → **~72h 50m stale (3d 0h)**
- `6-Quick-Scalp-NAS100/heartbeat.txt` — 2026-05-14 15:07:52 UTC → **~82h 6m stale (3d 10h)**
- `0-tg-mt5-bot/heartbeat.txt` — 2026-05-11 00:09:48 UTC → **~169h 4m stale (~7d 1h)**
- `CryptoNite-Free-Signals/heartbeat.txt` — still absent

Heartbeat staleness has continued to grow linearly across all four bots — same as every prior report, which means none of them are running on the Windows side either.

## This will keep failing until one of these is done

1. **Recommended — move the sync to Windows Task Scheduler.** Point it at `C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_run_git_sync.bat` (or `_temp_run_sync.bat`). Runs under the logged-in user with existing git credentials. No Cowork approval needed.
2. **Alternative — add `C:\CryptoNite-MT5-Bots\` itself as a Cowork folder** (not just the four child folders) so the sandbox can see `git_sync.py` and `.git/`.
3. **Stopgap — pause or delete the Cowork `cryptonite-git-sync` scheduled task** to stop generating a failure file every ~30–60 minutes.

See `git_sync_report_2026-05-17_2309utc.md` and earlier for the full diagnostic history.
