# commit-telegram-bot.ps1
# Commits the Telegram Q&A bot to both main and v8 branches.

Set-Location "C:\CryptoNova-App"
Get-ChildItem ".git" -Recurse -Filter "*.lock" | Remove-Item -Force -ErrorAction SilentlyContinue

$msg = @"
feat: add Claude-powered Telegram Q&A bot

api/telegram-qa.js - Vercel serverless webhook handler
  Receives Telegram messages, calls Claude Haiku for answers
  CryptoNova knowledge base in system prompt covers all FAQ topics
  Group support via @cnova_support_bot mention
  Rate limiting per user (6 messages per minute)
  Commands: /start /help /register /stats
  Live on-chain member count for /stats

setup-webhook.ps1 - one-time webhook registration script
  Run once after every deploy to register the webhook URL
"@

# -- Commit to main -----------------------------------------------------------
git checkout main
git add api/telegram-qa.js setup-webhook.ps1
git commit -m $msg
git push origin main
Write-Host "[main] bot committed and pushed." -ForegroundColor Green

# -- Commit to v8 -------------------------------------------------------------
git checkout v8
git checkout main -- api/telegram-qa.js setup-webhook.ps1
git add api/telegram-qa.js setup-webhook.ps1
git commit -m $msg
git push origin v8
Write-Host "[v8] bot committed and pushed." -ForegroundColor Green

Write-Host ""
Write-Host "Done. Both branches updated." -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: add env vars in Vercel dashboard then run .\setup-webhook.ps1" -ForegroundColor Yellow
Write-Host ""
