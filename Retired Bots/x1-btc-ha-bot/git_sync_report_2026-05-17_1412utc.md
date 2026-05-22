# Git Sync Report — 2026-05-17 14:12 UTC (standalone run record)

**Status: NOT RUN.** Same structural blocker as every unattended run since 2026-05-10. The 13:xx UTC slot appears to have been skipped (no report file present between the 12:12 UTC entry and this one). Full background is in the 2026-05-17_1212utc / 1113utc / 0913utc reports and the 2026-05-14 / 2026-05-15 entries; this file only notes what changed.

## What was checked this run

Sandbox time: `2026-05-17 14:12:57 UTC`.

1. **`request_access` was NOT retried this run.** Per the standing note left by prior agents, the Windows-shell access request times out at 180 s on every unattended run; skipping it.
2. **Script still unreachable.** Only the four child folders plus `outputs/` and `uploads/` are mounted under `/sessions/.../mnt/`; `C:\CryptoNite-MT5-Bots\git_sync.py` and the `.git/` checkout remain outside the sandbox.
3. **No Windows-side run since 05:14 UTC (~9 h ago).** No `_sync_output.txt`, no `_sync_done.txt`, no `_git_sync_output.log` in `1-btc-ha-bot/`. None of the three pre-existing wrappers (`_git_sync_run.bat`, `_run_git_sync.bat`, `_temp_run_sync.bat`) fired from any other source in the intervening hours.
4. **Heartbeats — still aging, no bot process touching them.**
   - `1-btc-ha-bot/heartbeat.txt` mtime `2026-05-15 00:23:53 UTC` → **~61h 49m stale (~2.58 days)**.
   - `6-Quick-Scalp-NAS100/heartbeat.txt` mtime `2026-05-14 15:07:52 UTC` → **~71h 05m stale (~2.96 days)**.
   - `0-tg-mt5-bot/heartbeat.txt` mtime `2026-05-11 00:09:48 UTC` → **~158h 03m stale (~6.59 days)**.
   - `CryptoNite-Free-Signals/heartbeat.txt` — still absent.

No commit, push, or repository change was made other than creating this report. The four `.env` files were not read, touched, or exposed.

## Action required from the user — unchanged

This Cowork scheduled task has now failed on every unattended run for **8 calendar days** (2026-05-10 through 2026-05-17). It structurally cannot succeed under the current setup.

- **Option 1 (recommended):** move the sync to Windows Task Scheduler, pointing at the existing `1-btc-ha-bot\_git_sync_run.bat` wrapper. Runs under your Windows account with your existing git credentials, bypasses the Cowork sandbox.
- **Option 2:** share `C:\CryptoNite-MT5-Bots\` itself with Cowork (not just the four child folders) so the sandbox can see `git_sync.py` and `.git/` directly.

**Until one of those is in place, please pause or delete this Cowork scheduled task** — each run only produces another no-op report like this one. The aging heartbeats (~62h, ~71h, ~158h stale, one fully missing) also indicate the bots themselves are not running on the Windows side; worth a look the next time you're at the machine.

**Note to the next agent on this schedule:** start by `Read`ing this file and the 12:12 UTC / 11:13 UTC reports from earlier today. Do NOT call `request_access` — it times out at 180 s on every unattended run. Do NOT write throwaway `.bat` wrappers into `outputs/` — the three pre-existing wrappers in `1-btc-ha-bot/` already cover Option 1, and `outputs/` is cleared between sessions.
