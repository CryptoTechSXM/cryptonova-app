@echo off
echo Installing CryptoNova CRE Keeper (staging) scheduled task...
schtasks /create /tn "CryptoNova CRE Keeper Staging" /tr "C:\CryptoNite-Smart-Contracts\CryptoNova\cryptonova-keeper\cre_keeper_task.bat" /sc minute /mo 5 /f
if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS - Task registered. CRE keeper will run every 5 minutes ^(matches config.staging.json schedule^).
    echo Log file: C:\CryptoNite-Smart-Contracts\CryptoNova\cryptonova-keeper\cre_keeper.log
) else (
    echo.
    echo ERROR - Task creation failed. Try running as Administrator.
)
pause
