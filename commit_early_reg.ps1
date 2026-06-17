Set-Location "C:\CryptoNova-App"

# Remove stale git lock files
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Lock files cleared." -ForegroundColor Cyan

# ── Commit to v8 ────────────────────────────────────────────────
git checkout v8
git add early.html vercel.json
git commit -m "feat: early registration page + subdomain routing"
git push origin v8
Write-Host "`n[v8] committed and pushed." -ForegroundColor Green

# ── Apply same files to main ─────────────────────────────────────
git checkout main
git checkout v8 -- early.html vercel.json
git add early.html vercel.json
git commit -m "feat: early registration page + subdomain routing"
git push origin main
Write-Host "`n[main] committed and pushed." -ForegroundColor Green

Write-Host "`nDone! Both branches updated." -ForegroundColor Cyan
Write-Host "Next: add early.crypto-nova.app as a domain alias in Vercel dashboard." -ForegroundColor Yellow
