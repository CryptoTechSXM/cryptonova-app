# push-bot-fix.ps1
# Commits all pending telegram-qa.js changes to both branches.
# Works around CRLF normalization by temporarily disabling autocrlf.

Set-Location "C:\CryptoNova-App"

# Clear any stale lock files from previous run
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Lock files cleared." -ForegroundColor Cyan

# Stash index.html and other dirty files so checkout works
git stash --include-untracked -m "temp stash for bot push" 2>$null
Write-Host "Stashed local changes." -ForegroundColor Cyan

# Disable CRLF normalisation so git can see the LF-written changes
git config core.autocrlf false

$msg = "fix: upgrade fee from withdrawable earnings, 254-seat cycle, markdown stripper, max_tokens 1024"

# ── main ─────────────────────────────────────────────────────────────────────
git checkout main
git add api/telegram-qa.js vercel.json
git status
git commit -m $msg
git push origin main
Write-Host "[main] pushed." -ForegroundColor Green

# ── v8 ───────────────────────────────────────────────────────────────────────
git checkout v8
git checkout main -- api/telegram-qa.js vercel.json
git add api/telegram-qa.js vercel.json
git commit -m $msg
git push origin v8
Write-Host "[v8] pushed." -ForegroundColor Green

# Restore autocrlf and stash
git config core.autocrlf true
git stash pop 2>$null
Write-Host "Settings restored." -ForegroundColor Cyan

Write-Host ""
Write-Host "Done. Both branches updated." -ForegroundColor Green
