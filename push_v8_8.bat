@echo off
if "%1"=="GO" goto :main
start "Push V8.8" cmd /k ""%~f0" GO"
exit /b

:main
cd /d "%~dp0"
echo =============================================
echo  CryptoNova Frontend - V8.8 Address Update
echo =============================================
echo.

:: Remove stale git lock if present
if exist .git\index.lock (
  echo Removing stale git lock...
  del /f .git\index.lock
)

:: Confirm we're on v8 branch
echo --- Current branch ---
git branch --show-current
echo.

:: Stage only index.html
git add index.html

:: Show what we're about to commit
echo --- Staged diff (addresses only) ---
git diff --cached --stat
echo.

:: Commit
git commit -m "V8.8: update all contract addresses (37 addrs + communityWallet)"

:: Push to v8 branch
echo.
echo Pushing to GitHub (v8 branch)...
git push origin v8

echo.
echo =============================================
echo  Done! Vercel will deploy to v8.crypto-nova.app
echo  Check deploy status at: https://vercel.com/dashboard
echo =============================================
echo.
echo (You can close this window now)
pause
