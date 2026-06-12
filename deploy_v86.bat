@echo off
setlocal enabledelayedexpansion
title CryptoNova V8.6 Deploy Pipeline
color 0A

echo.
echo  ===================================================
echo   CryptoNova V8.6 -- Full Deploy Pipeline
echo   MATRIX_SIZE=127 -- All 7 Tiers -- Auto-Keeper
echo  ===================================================
echo.

cd /d %~dp0

:: ── Step 0: clear git lock ──────────────────────────────────────────────────
echo [STEP 0] Clearing git index lock...
if exist ".git\index.lock" (
    del /f ".git\index.lock"
    echo         index.lock removed OK
) else (
    echo         no lock present, continuing
)

:: ── Step 1: git add + commit ────────────────────────────────────────────────
echo.
echo [STEP 1] Staging v8.6 files...
git add contracts/FigureEightMatrixV8.sol contracts/StabilityFund.sol contracts/MatrixKeeper.sol
git add scripts/deploy_v8.js scripts/bigfill_v8.js scripts/predeploy_check.js
git add scripts/growth_sim.js test/stress_test_full.js
git add V8_6_DEPLOY_RUNBOOK.md

git diff --cached --name-only
echo.
git commit -m "feat: v8.6 -- MATRIX_SIZE=127, all 7 tiers, parked rescue, velocity gate"
if %errorlevel% neq 0 (
    echo  [INFO] Nothing new to commit, or already committed. Continuing...
)
git push
if %errorlevel% neq 0 (
    echo  [WARN] Push failed -- check remote. Continuing with local deploy.
)

:: ── Step 2: predeploy_check ─────────────────────────────────────────────────
echo.
echo [STEP 2] Running predeploy_check.js...
call npx hardhat run scripts/predeploy_check.js
if %errorlevel% neq 0 (
    echo.
    echo  [FAIL] predeploy_check.js reported failures.
    echo         Fix the issues above before deploying.
    pause
    exit /b 1
)

:: ── Step 3: test suite ──────────────────────────────────────────────────────
echo.
echo [STEP 3] Running V8 test suite (V8Elevator + stress_test_full)...
echo         (V6 archive tests skipped -- incompatible with V8.1 contracts)
call npx hardhat test test/V8Elevator.test.js test/stress_test_full.js
if %errorlevel% neq 0 (
    echo.
    echo  [FAIL] Tests failed. Fix before deploying.
    pause
    exit /b 1
)

:: ── Step 4: fresh deploy ────────────────────────────────────────────────────
echo.
echo [STEP 4] Deploying v8.6 to Base Sepolia...
echo          MATRIX_SIZE=127, all 7 tiers, gates T2-T7 closed
echo.
call npx hardhat run scripts/deploy_v8.js --network baseSepolia
if %errorlevel% neq 0 (
    echo.
    echo  [FAIL] Deploy failed. Check output above.
    pause
    exit /b 1
)

:: ── Step 5: seed W1 ────────────────────────────────────────────────────────
echo.
echo [STEP 5] Seeding W1...
call npx hardhat run scripts/seed_w1.js --network baseSepolia
if %errorlevel% neq 0 (
    echo  [WARN] seed_w1.js failed or W1 already registered.
)

:: ── Step 6: stress test on fresh deploy ────────────────────────────────────
echo.
echo [STEP 6] Stress test -- 20 wallets, keeper paths, velocity gate...
set N_SEED=15
set COMMUNITY_THRESHOLD=15
set ADD_INTERVAL_MS=2000
set MAX_WALLETS=20
set GAS_LIMIT=8000000
call npx hardhat run scripts/growth_sim.js --network baseSepolia
if %errorlevel% neq 0 (
    echo  [WARN] growth_sim.js exited non-zero -- check output above.
)

echo.
echo  ===================================================
echo   Deploy complete!
echo.
echo   NEXT STEPS:
echo   1. Register MatrixKeeper on Chainlink Automation
echo      URL: https://automation.chain.link (Base Sepolia)
echo      Gas: 6,000,000  --  LINK: 5
echo.
echo   2. Seed StabilityFund with $500+ USDC
echo      npx hardhat run scripts/seed_sf.js --network baseSepolia
echo.
echo   3. Paste T4-T7 addresses from deployed_addresses_v8_6.json
echo      into CryptoNova-App\index.html  (or use updateAddrsFromDeployed)
echo.
echo   4. git add + push index.html, then redeploy to Vercel
echo.
echo   5. Invite community!
echo  ===================================================
echo.
pause
