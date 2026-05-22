# Git Sync Report — 2026-05-16 05:14 UTC (standalone run record)

**Status: NOT RUN.** Same structural blocker as every unattended run since 2026-05-10. This is the 2nd standalone failure file for 2026-05-16 (00:13 UTC daily file, then this 05:14 UTC run).

Written as a standalone timestamped file (not appended to the shared per-day report `git_sync_report_2026-05-16.md`) to avoid the documented concurrent-write race — overlapping unattended instances of this scheduled task clobber each other's appends.

## What was checked this run (`date -u` = `Sat May 16 05:14:47 UTC 2026`)

1. **The script is still unreachable.** `python C:\CryptoNite-MT5-Bots\git_sync.py` cannot run from the Cowork sandbox. Only the four child folders are mounted (`0-tg-mt5-bot`, `1-btc-ha-bot`, `6-Quick-Scalp-NAS100`, `CryptoNite-Free-Signals`) plus `outputs`/`uploads`/`.claude`. The parent `C:\CryptoNite-MT5-Bots\` — which holds `git_sync.py` and the `.git/` checkout — is **not** mounted. Re-verified by listing `/sessions/.../mnt/`.
2. **No sandbox-side git fallback.** `git --version` is available (2.34.1), but `ls .git` and `stat .git` return "No such file or directory" for all four mounted folders. None of them is a git repo on its own, and a sandbox-side `git init / add / commit / push` would also risk leaking the `.env` files that exist in every bot folder (no `.gitignore` is present in any of the four mounts to suppress them).
3. **Desktop control still not viable unattended.** `request_access(["File Explorer"])` was called once at the start of this run as an attempt to drive a `.bat` wrapper via File Explorer's address bar. It **timed out at the full 180 s** with no user response, exactly as predicted by the 23:08 UTC May 15 report's standing guidance. Should not be retried on future unattended runs — recording that here so the next run doesn't repeat the mistake.
4. **No Windows-side run occurred either.** No `_sync_output.txt` and no `sync_done.flag` left behind in `1-btc-ha-bot/` from any other source. The existing `_temp_run_sync.bat` wrapper did not fire. `1-btc-ha-bot/heartbeat.txt` (`May 15 00:23` mtime) is untouched.

## Missteps this run (recorded so the pattern stops)

- **Retried `request_access` once.** Standing guidance from prior reports said don't bother — it always times out. Cost ~180 s of this run.
- **Wrote a `run_sync.bat` into `outputs/`.** Pointless: `outputs/` is a sandbox-only temp folder cleared between sessions, the user can't see it, and even if it survived, there's no unattended way to launch it without `request_access`. The pre-existing `1-btc-ha-bot/_temp_run_sync.bat` is already the right wrapper for Option 1 below. The `outputs/` file will be GC'd by the harness; no action needed.

No commit, push, or filesystem change was made to any of the four bot folders other than creating this report. No `.env` files were read.

## Action still required — the task cannot succeed as configured

This task has now failed on every run for 6+ days (100+ failures) and is producing roughly one failure report per hour. Either of the two fixes from prior reports is still needed:

- **Option 1 (recommended):** Move the sync to Windows Task Scheduler running `python C:\CryptoNite-MT5-Bots\git_sync.py` (the existing `1-btc-ha-bot\_temp_run_sync.bat` is a ready-made wrapper). It runs under your Windows account, uses your existing git credentials, and bypasses the Cowork sandbox entirely. This Cowork task could then be reduced to a read-only status check that surfaces failures.
- **Option 2:** Share `C:\CryptoNite-MT5-Bots\` itself with Cowork (not just the four child folders), so the sandbox can see `git_sync.py` and `.git/` directly. If you take this route, also fix the Unicode-in-final-print bug a prior report flagged (crashes under Windows' default code page when stdout is redirected).

**Until one of those is in place, please pause or delete this Cowork scheduled task** — every run only produces another report like this one and spawns overlapping instances racing on the shared per-day file.
