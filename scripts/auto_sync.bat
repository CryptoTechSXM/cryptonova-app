@echo off
:: Self-relaunch with cmd /k so window NEVER closes
if "%1"=="GO" goto :main
start "CryptoNova AutoSync" cmd /k ""%~f0" GO"
exit /b

:main
title CryptoNova — Auto Sync (every 5 min)
echo =============================================
echo  CryptoNova Auto Sync — Running continuously
echo  Press Ctrl+C to stop
echo =============================================
echo.

cd /d C:\CryptoNite-Smat-Contracts\CryptoNova

:loop
echo.
echo [%date% %time%] === Running sync ===

:: Use 'call' so errors in npx don't kill the parent script
call npx hardhat run scripts/sync_tier1_members.js --network baseSepolia 2>&1

echo.
echo [%date% %time%] Done. Sleeping 5 minutes...
timeout /t 300 /nobreak > nul
goto :loop
