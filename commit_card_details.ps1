Set-Location "C:\CryptoNova-App"

# Remove stale git lock files
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Lock files cleared." -ForegroundColor Cyan

$msg = @"
feat: dashboard card detail panels

All 6 stat cards are now clickable inline drill-down panels.
Withdrawable shows accounting breakdown and fee preview.
Total Earned shows cycles per tier and average per cycle.
CNOVA shows balance, floor price, USD value and epoch schedule.
CNOVA Burned shows redemption history from Transfer events.
Community Pool shows eligibility, group share and est monthly payout.
"@

# ── Commit to v8 ────────────────────────────────────────────────
git checkout v8
git add index.html
git commit -m $msg
git push origin v8
Write-Host "`n[v8] committed and pushed." -ForegroundColor Green

# ── Apply to main ────────────────────────────────────────────────
git checkout main
git checkout v8 -- index.html
git add index.html
git commit -m $msg
git push origin main
Write-Host "`n[main] committed and pushed." -ForegroundColor Green

Write-Host "`nDone! Both branches updated." -ForegroundColor Cyan
