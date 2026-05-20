# Git Sync Report — 2026-05-17 08:09 UTC (standalone run record)

**Status: NOT RUN.** Same structural blocker. ~56 min after the previous standalone report (`git_sync_report_2026-05-17_0713utc.md`). Full background is in that file and the 2026-05-15 11:10 UTC report; this entry only notes what changed.

## What was checked this run

Sandbox time: `Sun May 17 08:09:33 UTC 2026`.

1. **Script still unreachable.** `ls /mnt/CryptoNite-MT5-Bots` → "No such file or directory". Only the four child folders plus `outputs`/`uploads` are mounted; `C:\CryptoNite-MT5-Bots\git_sync.py` and the `.git/` checkout remain outside the sandbox. `find -maxdepth 4 -name git_sync.py` → nothing; `find -maxdepth 3 -name .git -type d` → nothing.
2. **No Windows-side run since 05:14 UTC (~3 h ago).** No `_sync_output.txt`, no `_sync_done.txt`, no `sync_done.flag` in `1-btc-ha-bot/`. The three pre-existing wrappers (`_git_sync_run.bat` 302 B mtime 2026-05-16 13:09, `_run_git_sync.bat` 303 B mtime 2026-05-17 05:09, `_temp_run_sync.bat` 267 B mtime 2026-05-12 15:09) did not fire from any other source in the last ~3 hours.
3. **`request_access` deliberately NOT called this run.** Confirmed in every prior unattended report that it times out at 180 s — calling it just adds 3 min of wasted latency.
4. **Leftover `_run_git_sync.bat` from 05:09 UTC still present.** Sandbox cannot delete it (no delete grant on this folder). Please remove it manually next time you're at the machine, or grant Cowork delete permission here.
5. **Heartbeats continue to age — no bot process is touching them.**
   - `1-btc-ha-bot/heartbeat.txt` mtime `2026-05-15 00:23:53 UTC` → **~55h 46m stale (~2.3 days)**.
   - `6-Quick-Scalp-NAS100/heartbeat.txt` mtime `2026-05-14 15:07:52 UTC` → **~65h 02m stale (~2.7 days)**.
   - `0-tg-mt5-bot/heartbeat.txt` mtime `2026-05-11 00:09:48 UTC` → **~152h 00m stale (~6.3 days)**.
   - `CryptoNite-Free-Signals/heartbeat.txt` — still absent.

No commit, push, or repository change was made other than creating this report. The four `.env` files were not read, touched, or exposed.

## Action required from the user — unchanged

This Cowork scheduled task has now failed on every unattended run for **8 calendar days** (2026-05-10 through 2026-05-17). It structurally cannot succeed under the current setup.

- **Option 1 (recommended):** move the sync to Windows Task Scheduler, pointing at the existing `1-btc-ha-bot\_git_sync_run.bat` wrapper. Runs under your Windows account with your existing git credentials, bypasses the Cowork sandbox.
- **Option 2:** share `C:\CryptoNite-MT5-Bots\` itself with Cowork (not just the four child folders) so the sandbox can see `git_sync.py` and `.git/` directly.

**Until one of those is in place, please pause or delete this Cowork scheduled task** — each run only produces another no-op report like this one. The aging heartbeats (55h–152h stale, one fully missing) also indicate the bots themselves are not running on the Windows side; worth a look the next time you're at the machine.
