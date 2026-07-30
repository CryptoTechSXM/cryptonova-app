@echo off
echo Installing CryptoNova Health Keeper scheduled task...
schtasks /create /tn "CryptoNova Health Keeper" /tr "C:\CryptoNite-Smart-Contracts\CryptoNova\run_keeper.bat" /sc minute /mo 15 /f
if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS - Task registered. system_keeper.js will run every 15 minutes.
    echo It sends a Telegram health report immediately on any alert/action, and
    echo at least every 15 minutes ^(HEARTBEAT_MINUTES^) even when everything is healthy.
    echo Log file: C:\CryptoNite-Smart-Contracts\CryptoNova\logs\keeper.log
    echo Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set in .env to actually send.
) else (
    echo.
    echo ERROR - Task creation failed. Try running as Administrator.
)
pause
