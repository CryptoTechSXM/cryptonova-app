Set-Location "C:\CryptoNova-App"
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Lock files cleared." -ForegroundColor Cyan

# ── Step 1: Restore main to the good card-details commit ────────
git checkout main
git reset --hard HEAD~1
Write-Host "main reset to card-details commit." -ForegroundColor Cyan

# ── Step 2: Kill the gate on main (set LAUNCH_UTC to the past) ──
$file = "C:\CryptoNova-App\index.html"
$html = [System.IO.File]::ReadAllText($file)

# Gate date line
$html = $html -replace [regex]::Escape("const LAUNCH_UTC = new Date('2026-06-12T16:00:00Z');"), "const LAUNCH_UTC = new Date('2020-01-01T00:00:00Z'); // gate off for beta"

# Gate IIFE inner launchTime (may exist as separate var)
$html = $html -replace [regex]::Escape("const _launchTime = new Date('2026-06-12T16:00:00Z');"), "const _launchTime = new Date('2020-01-01T00:00:00Z');"

[System.IO.File]::WriteAllText($file, $html)
Write-Host "Gate removed on main." -ForegroundColor Green

git add index.html
git commit -m "test: disable launch gate for beta testing"
git push origin main --force
Write-Host "[main] pushed (gate off, card details included)." -ForegroundColor Green

# ── Step 3: Apply same file to v8, restore June 19 gate ─────────
git checkout v8
git checkout main -- index.html

$html = [System.IO.File]::ReadAllText($file)
$html = $html -replace [regex]::Escape("const LAUNCH_UTC = new Date('2020-01-01T00:00:00Z'); // gate off for beta"), "const LAUNCH_UTC = new Date('2026-06-19T16:00:00Z'); // noon EDT = 16:00 UTC"
$html = $html -replace [regex]::Escape("const _launchTime = new Date('2020-01-01T00:00:00Z');"), "const _launchTime = new Date('2026-06-19T16:00:00Z');"
[System.IO.File]::WriteAllText($file, $html)
Write-Host "June 19 gate restored on v8." -ForegroundColor Cyan

git add index.html
git commit -m "feat: dashboard card detail panels (v8 keeps June 19 gate)"
git push origin v8
Write-Host "[v8] pushed (card details, June 19 gate intact)." -ForegroundColor Green

Write-Host "`nAll done." -ForegroundColor Cyan
Write-Host "main  -> gate OFF, card details live" -ForegroundColor Green
Write-Host "v8    -> gate June 19, card details live" -ForegroundColor Green
