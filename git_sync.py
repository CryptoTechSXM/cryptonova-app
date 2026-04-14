"""
git_sync.py — CryptoNite auto-backup to GitHub
===============================================
Run manually:       python git_sync.py
Via Task Scheduler: runs automatically every 30 min

No credentials stored here — uses the remote URL set
during git_setup.bat (stored in .git/config only).
"""

import subprocess
import sys
from datetime import datetime

REPO = r"C:\CryptoNite-MT5-Bots"


def run(cmd):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)


def sync():
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    # Stage all changes (respects .gitignore — .env files never staged)
    run(["git", "add", "."])

    # Check if there is anything new to commit
    status = run(["git", "status", "--porcelain"])
    if not status.stdout.strip():
        print(f"[{now}] Nothing to commit — already up to date.")
        return

    # Show what changed
    changed = [l.strip() for l in status.stdout.strip().splitlines()]
    print(f"[{now}] Changes detected ({len(changed)} files):")
    for f in changed[:10]:
        print(f"         {f}")
    if len(changed) > 10:
        print(f"         ... and {len(changed) - 10} more")

    # Commit with timestamp
    commit_msg = f"Auto-sync {now}"
    commit = run(["git", "commit", "-m", commit_msg])
    if commit.returncode != 0:
        print(f"[{now}] Commit failed:\n{commit.stderr}")
        sys.exit(1)

    # Push
    push = run(["git", "push"])
    if push.returncode == 0:
        print(f"[{now}] Pushed to GitHub ✅")
    else:
        print(f"[{now}] Push failed ❌")
        print(push.stderr)
        sys.exit(1)


if __name__ == "__main__":
    sync()
