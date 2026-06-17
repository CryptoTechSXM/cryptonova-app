# push-faucet.ps1
# Commits the faucet feature + package.json to main and v8.

Set-Location "C:\CryptoNova-App"
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue

# Disable autocrlf so Linux-written LF files show as changed
git config core.autocrlf false

$msg = "feat: add USDC faucet to Telegram support bot

- /faucet 0xAddress command sends 20 USDC instantly
- Natural-language detection: address + need-usdc keywords auto-triggers faucet
- Per-address 24h cooldown (in-memory, resets on cold start)
- Balance preflight check before transfer
- Basescan tx link in confirmation reply
- Uses FAUCET_PRIVATE_KEY env var (separate wallet, not deployer)
- package.json with ethers v6 dependency added
- System prompt updated: faucet instructions replace admin-for-USDC note"

# -- main -----------------------------------------------------------------------
git checkout main
git add api/telegram-qa.js package.json
git status
git diff --cached --stat
git commit -m $msg
git push origin main
Write-Host "[main] pushed." -ForegroundColor Green

# -- v8 -------------------------------------------------------------------------
git checkout v8
git checkout main -- api/telegram-qa.js package.json
git add api/telegram-qa.js package.json
git commit -m $msg
git push origin v8
Write-Host "[v8] pushed." -ForegroundColor Green

git config core.autocrlf true
Write-Host ""
Write-Host "Done. Both branches updated." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Add FAUCET_PRIVATE_KEY to Vercel env vars" -ForegroundColor White
Write-Host "  2. Add BASE_SEPOLIA_RPC to Vercel env vars (Alchemy URL)" -ForegroundColor White
Write-Host "  3. Run .\fund-faucet.ps1 to pre-load the faucet wallet with USDC" -ForegroundColor White
Write-Host "  4. Re-register webhook: .\setup-webhook.ps1" -ForegroundColor White
Write-Host ""
