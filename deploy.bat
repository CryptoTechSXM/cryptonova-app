@echo off
:: Force the window to stay open by relaunching with cmd /k
if "%1"=="GO" goto :main
start "CryptoNova Deploy" cmd /k ""%~f0" GO %2"
exit /b

:main
cd /d "%~dp0"
echo =============================================
echo  CryptoNova Frontend - Deploy
echo =============================================
echo.

:: Remove stale git lock if present
if exist .git\index.lock (
  echo Removing stale git lock...
  del /f .git\index.lock
)

:: Show current branch
for /f %%b in ('git branch --show-current') do set BRANCH=%%b
echo Current branch: %BRANCH%
echo.

:: Confirm we're on v8 branch
if /i not "%BRANCH%"=="v8" (
  echo WARNING: You are not on the v8 branch.
  echo Current branch: %BRANCH%
  echo.
  set /p SWITCH="Switch to v8 branch? (y/n): "
  if /i "%SWITCH%"=="y" (
    git checkout v8
    if errorlevel 1 ( echo ERROR: Could not switch to v8. & pause & exit /b 1 )
  ) else (
    echo Proceeding on branch: %BRANCH%
  )
)

:: Show status
echo --- git status ---
git status --short
echo.

:: Get commit message
if not "%~2"=="" (
  set "MSG=%~2"
) else (
  set /p MSG="Commit message: "
)
if "%MSG%"=="" (
  echo ERROR: Commit message cannot be empty.
  pause & exit /b 1
)

:: Stage all changes
git add -A
if errorlevel 1 ( echo ERROR: git add failed. & pause & exit /b 1 )

:: Commit
git commit -m "%MSG%"
if errorlevel 1 ( echo ERROR: git commit failed. & pause & exit /b 1 )

:: Push v8
echo.
echo Pushing to origin/v8...
git push origin v8
if errorlevel 1 ( echo ERROR: git push v8 failed. & pause & exit /b 1 )

:: Merge into main
echo.
echo Merging v8 into main...
git checkout main
if errorlevel 1 ( echo ERROR: could not checkout main. & pause & exit /b 1 )

git merge v8 --no-ff -m "merge: %MSG%"
if errorlevel 1 ( echo ERROR: merge failed. & pause & exit /b 1 )

:: Push main
echo.
echo Pushing to origin/main...
git push origin main
if errorlevel 1 ( echo ERROR: git push main failed. & pause & exit /b 1 )

:: Return to v8
git checkout v8

echo.
echo =============================================
echo  Done! Vercel will deploy in ~60 seconds.
echo  Preview : https://v8.crypto-nova.app
echo  Live    : https://crypto-nova.app
echo =============================================
echo.
echo (You can close this window now)
pause
