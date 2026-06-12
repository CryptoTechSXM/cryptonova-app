@echo off
setlocal EnableDelayedExpansion

:: ─────────────────────────────────────────────────────────────
:: CryptoNova App — Deploy Script
:: Commits changes on v8, merges to main, pushes both branches.
:: Usage: deploy.bat
::        deploy.bat "your commit message here"
:: ─────────────────────────────────────────────────────────────

cd /d "%~dp0"

echo.
echo ===============================================
echo   CryptoNova App Deploy
echo ===============================================
echo.

:: ── Get commit message ──────────────────────────────────────
if "%~1"=="" (
  set /p COMMIT_MSG="Commit message: "
) else (
  set COMMIT_MSG=%~1
)

if "!COMMIT_MSG!"=="" (
  echo ERROR: Commit message cannot be empty.
  pause
  exit /b 1
)

:: ── Verify we are on v8 branch ──────────────────────────────
for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set CURRENT_BRANCH=%%b
echo Current branch: !CURRENT_BRANCH!

if /i "!CURRENT_BRANCH!" neq "v8" (
  echo.
  echo WARNING: You are not on the v8 branch ^(you are on !CURRENT_BRANCH!^).
  set /p SWITCH_CONFIRM="Switch to v8 before deploying? [Y/N]: "
  if /i "!SWITCH_CONFIRM!"=="Y" (
    git checkout v8
    if errorlevel 1 ( echo ERROR: Could not switch to v8. & pause & exit /b 1 )
  ) else (
    echo Aborting deploy.
    pause
    exit /b 1
  )
)

:: ── Stage all changes ───────────────────────────────────────
echo.
echo [1/6] Staging changes...
git add -A
if errorlevel 1 ( echo ERROR: git add failed. & pause & exit /b 1 )
git status --short

:: ── Commit ──────────────────────────────────────────────────
echo.
echo [2/6] Committing: "!COMMIT_MSG!"
git commit -m "!COMMIT_MSG!"
if errorlevel 1 (
  echo NOTE: Nothing to commit, or commit failed.
  echo Checking if there are staged changes...
  git diff --cached --quiet
  if errorlevel 1 ( echo ERROR: Commit failed. & pause & exit /b 1 )
  echo Nothing new to commit -- continuing with push.
)

:: ── Push v8 ─────────────────────────────────────────────────
echo.
echo [3/6] Pushing v8 to origin...
git push origin v8
if errorlevel 1 ( echo ERROR: Push to v8 failed. & pause & exit /b 1 )

:: ── Switch to main ──────────────────────────────────────────
echo.
echo [4/6] Switching to main...
git checkout main
if errorlevel 1 ( echo ERROR: Could not checkout main. & pause & exit /b 1 )

:: ── Merge v8 → main ─────────────────────────────────────────
echo.
echo [5/6] Merging v8 into main...
git merge v8 --no-ff -m "merge: !COMMIT_MSG!"
if errorlevel 1 (
  echo.
  echo ERROR: Merge conflict detected.
  echo Resolve conflicts, then run:
  echo   git add -A
  echo   git commit
  echo   git push origin main
  echo   git checkout v8
  pause
  exit /b 1
)

:: ── Push main ───────────────────────────────────────────────
echo.
echo [6/6] Pushing main to origin...
git push origin main
if errorlevel 1 ( echo ERROR: Push to main failed. & pause & exit /b 1 )

:: ── Return to v8 ────────────────────────────────────────────
git checkout v8

echo.
echo ===============================================
echo   Deploy complete!
echo   v8   -> v8.crypto-nova.app  (preview)
echo   main -> crypto-nova.app     (production)
echo ===============================================
echo.
pause
