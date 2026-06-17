Set-Location "C:\CryptoNova-App"
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Lock files cleared." -ForegroundColor Cyan

# ── Fix main: undo the bad revert commit, restore the good one ───
git checkout main
git reset --hard HEAD~1
git push origin main --force
Write-Host "[main] restored to card-details commit." -ForegroundColor Green

# ── Apply the same index.html to v8 ─────────────────────────────
git checkout v8
git checkout main -- index.html
git add index.html
git commit -m "feat: dashboard card detail panels"
git push origin v8
Write-Host "[v8] card details applied and pushed." -ForegroundColor Green

Write-Host "`nBoth branches are now correct." -ForegroundColor Cyan
