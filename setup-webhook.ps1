# ═══════════════════════════════════════════════════════════════════════════════
# setup-webhook.ps1
# Registers the Telegram webhook with the cnova_support_bot after every deploy.
#
# Run once from PowerShell after pushing to Vercel:
#   cd C:\CryptoNova-App
#   $env:TELEGRAM_QA_BOT_TOKEN = "8748084483:AAHwOrCwIi39J0z-2FkD_RGdfEakfWs-3Gw"
#   .\setup-webhook.ps1
# ═══════════════════════════════════════════════════════════════════════════════

$token = $env:TELEGRAM_QA_BOT_TOKEN
if (-not $token) {
    Write-Host ""
    Write-Host "ERROR: TELEGRAM_QA_BOT_TOKEN is not set." -ForegroundColor Red
    Write-Host ""
    Write-Host "Set it first:" -ForegroundColor Yellow
    Write-Host '  $env:TELEGRAM_QA_BOT_TOKEN = "your-bot-token-here"' -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

$webhookUrl = "https://crypto-nova.app/api/telegram-qa"
Write-Host ""
Write-Host "Registering webhook..." -ForegroundColor Cyan
Write-Host "  Bot:     @cnova_support_bot"
Write-Host "  Target:  $webhookUrl"
Write-Host ""

# Register
$setUrl  = "https://api.telegram.org/bot$token/setWebhook?url=$([uri]::EscapeDataString($webhookUrl))&allowed_updates=message,channel_post"
$setResp = Invoke-WebRequest -Uri $setUrl -UseBasicParsing
$setData = $setResp.Content | ConvertFrom-Json

if ($setData.ok) {
    Write-Host "Webhook registered!" -ForegroundColor Green
    Write-Host "  $($setData.description)"
} else {
    Write-Host "Failed to set webhook:" -ForegroundColor Red
    Write-Host "  $($setData.description)"
    exit 1
}

# Verify
Write-Host ""
Write-Host "Verifying..." -ForegroundColor Cyan
$infoUrl  = "https://api.telegram.org/bot$token/getWebhookInfo"
$infoResp = Invoke-WebRequest -Uri $infoUrl -UseBasicParsing
$infoData = $infoResp.Content | ConvertFrom-Json

if ($infoData.ok) {
    $wh = $infoData.result
    Write-Host ""
    Write-Host "Webhook info:" -ForegroundColor Cyan
    Write-Host "  URL:            $($wh.url)"
    Write-Host "  Pending updates: $($wh.pending_update_count)"
    if ($wh.last_error_date) {
        Write-Host "  Last error:     $($wh.last_error_message)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "All done. The support bot is live." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Add bot to CryptoNovaSupport group as admin"
Write-Host "  2. Test by sending: @cnova_support_bot how does the matrix work?"
Write-Host "  3. Test /stats command for live on-chain data"
Write-Host ""
