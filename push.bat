@echo off
:: Force the window to stay open by relaunching with cmd /k
if "%1"=="GO" goto :main
start "CryptoNova Push" cmd /k ""%~f0" GO"
exit /b

:main
cd /d "%~dp0"
echo =============================================
echo  CryptoNova Frontend - Git Push
echo =============================================
echo.

:: Remove stale git lock if present
if exist .git\index.lock (
  echo Removing stale git lock...
  del /f .git\index.lock
)

:: Show current status
echo --- git status ---
git status
echo.

:: Stage index.html
git add index.html

:: Write commit message to temp file
echo feat: replace tx history with basescan link > _commit_msg.tmp
echo. >> _commit_msg.tmp
echo - Replace in-app event query with direct BaseScan link >> _commit_msg.tmp
echo - Link updates dynamically to connected wallet address on connect >> _commit_msg.tmp
echo - Remove unused loadTxHistory function >> _commit_msg.tmp

:: Commit
git commit -F _commit_msg.tmp
del _commit_msg.tmp 2>nul

:: Push
echo.
echo Pushing to GitHub...
git push origin main

echo.
echo =============================================
echo  Done! Check https://crypto-nova.app in ~60s
echo =============================================
echo.
echo (You can close this window now)
