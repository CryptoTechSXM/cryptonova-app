# Git Sync Report — 2026-05-22 11:11 UTC

## Status: UNABLE TO RUN

## Reason

The structural blocker that has prevented every unattended run since
2026-05-10 remains in place.

- `git_sync.py` lives at `C:\CryptoNite-MT5-Bots\git_sync.py`
- Cowork's sandbox only mounts the **three bot subfolders**, not the
  parent `C:\CryptoNite-MT5-Bots\` directory
- None of the mounted subfolders contains a `.git/` directory —
  the monorepo's `.git/` is at the unmounted parent
- Computer-use fallback (opening a terminal) is not viable for
  unattended scheduled runs: `request_access` requires user approval
  at the desktop (dialog timed out after 180 s with no user present)

## Recommendation

Two paths to fix this permanently:

1. **Add the parent folder to Cowork** — Share `C:\CryptoNite-MT5-Bots`
   (the parent) with Cowork so the sandbox can see both `git_sync.py`
   and the monorepo's `.git/` checkout. The scheduled task will then
   work as intended.

2. **Move to Windows Task Scheduler** — Create a native Windows
   scheduled task that runs:
   ```
   python C:\CryptoNite-MT5-Bots\git_sync.py
   ```
   directly, without the Cowork sandbox gate. Then delete this Cowork
   scheduled task.

Until one of those changes is made, every run will produce this same
report.
