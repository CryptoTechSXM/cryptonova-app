@echo off
:: CryptoNova V8 — Daily Chain Health Monitor
:: Runs at 08:00 via Windows Task Scheduler
:: Logs to monitor_log.txt (last 7 days kept)

cd /d "C:\CryptoNite-Smart-Contracts\CryptoNova"

:: Rotate log if > 500KB
for %%F in (monitor_log.txt) do if %%~zF GTR 512000 (
    copy /y monitor_log.txt monitor_log_prev.txt >nul
    del monitor_log.txt >nul
)

echo. >> monitor_log.txt
echo ========================================== >> monitor_log.txt
echo %DATE% %TIME% — Monitor starting >> monitor_log.txt
echo ========================================== >> monitor_log.txt

node scripts/monitor_v8.js >> monitor_log.txt 2>&1

if %ERRORLEVEL% EQU 0 (
    echo %DATE% %TIME% — Monitor completed OK >> monitor_log.txt
) else (
    echo %DATE% %TIME% — Monitor FAILED (exit code %ERRORLEVEL%) >> monitor_log.txt
)
