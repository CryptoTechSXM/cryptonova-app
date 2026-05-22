# Git Sync Report — 2026-05-15 13:09 UTC (standalone run record)

**Status: NOT RUN.** The scheduled task could not perform the sync. Same structural blocker as every unattended run since 2026-05-10.

Written as a standalone file (not an append to `git_sync_report_2026-05-15.md`) because that shared per-day file is still being clobbered by overlapping runs — see "Concurrent-write race" below.

## Why the sync cannot run

The task asks for `python C:\CryptoNite-MT5-Bots\git_sync.py` to be executed. Re-verified this run (`date -u` = Fri May 15 13:09:34 UTC 2026):

1. **The script is unreachable.** Only four child folders are shared with Cowork — `0-tg-mt5-bot`, `1-btc-ha-bot`, `6-Quick-Scalp-NAS100`, `CryptoNite-Free-Signals`. Their parent `C:\CryptoNite-MT5-Bots\` — which holds `git_sync.py` and the `.git/` checkout — is **not** mounted. `ls` of that path returns "No such file or directory". The script cannot be run or even inspected.
2. **No sandbox-side git fallback.** `find -maxdepth 4` finds no `git_sync.py` and no `.git/` anywhere in the sandbox. `git rev-parse --is-inside-work-tree` fails for all four mounted folders — none is a git repo, and none contains a `.gitignore`. A `git add / commit / push` from the sandbox is impossible. (`git` v2.34.1 is installed, but there is no repo or remote for it to act on.)
3. **Desktop control isn't available unattended.** Running the command via the Windows shell needs an interactive `request_access` approval, which has timed out at ~180 s on every unattended run for this 5-day series. Not retried this run, per standing guidance from prior reports.

No leftover `_sync_output.txt` or `sync_done.flag` in `1-btc-ha-bot/`, so no Windows-side run occurred either. `heartbeat.txt` held `1778850571.3091693` at the start of this run and was left untouched. No commit, push, or filesystem change was made other than creating this file.

Because `git_sync.py` cannot be inspected, its claim of "respecting .gitignore so .env files are never committed" remains **unverified**. All four bot folders contain a `.env` file and none contains a `.gitignore`.

## Concurrent-write race on the shared report file (still happening)

`git_sync_report_2026-05-15.md` is being modified by overlapping runs of this scheduled task. This run observed the file in two different states minutes apart: the Read tool saw 49 lines ending at a 12:09 UTC note, while a `wc -l` moments later showed 43 lines ending at a *truncated, mid-sentence* 11:09 UTC note. Earlier instances clobber later ones and vice versa. The shared per-day file is therefore unreliable, which is why this run wrote a standalone file instead.

## Action required from the user — the task cannot succeed as configured

**Option 1 (recommended): move the sync to Windows Task Scheduler.** Create a Windows scheduled task that runs `python C:\CryptoNite-MT5-Bots\git_sync.py` every 30 minutes. It runs under the Windows account with the existing git credentials and bypasses the Cowork sandbox entirely. The existing `1-btc-ha-bot\_temp_run_sync.bat` wrapper (it `cd`s to `C:\CryptoNite-MT5-Bots` and runs `python git_sync.py`) is a ready-made target.

**Option 2: share `C:\CryptoNite-MT5-Bots\` itself with Cowork.** Add the parent directory as a Cowork folder, not just the four child folders. The sandbox would then see `git_sync.py` and `.git/` directly. Note: a prior report flagged a Unicode character in the script's final `print` that crashes under Windows' default code page when stdout is redirected, and its hardcoded Windows path may need adjusting to run from the sandbox.

**In the meantime: pause or delete this Cowork scheduled task.** It has failed every 30-minute run since 2026-05-10 — well over 200 unattended runs — and now also spawns overlapping instances that race on the report file. Until Option 1 or Option 2 is in place, every run only produces another failure report like this one. (I did not pause or delete the task myself — that is a configuration change that is the user's call, and the task file did not request it.)
