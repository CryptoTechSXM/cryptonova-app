@echo off
echo Installing CryptoNova Keeper V8.16 scheduled task...
schtasks /create /tn "CryptoNova Keeper V8.16" /tr "C:\CryptoNite-Smart-Contracts\CryptoNova\keeper_task.bat" /sc minute /mo 2 /f
if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS - Task registered. Keeper will run every 2 minutes.
    echo Log file: C:\CryptoNite-Smart-Contracts\CryptoNova\keeper.log
) else (
    echo.
    echo ERROR - Task creation failed. Try running as Administrator.
)
pause
