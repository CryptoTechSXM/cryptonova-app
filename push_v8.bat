@echo off
cd /d "C:\CryptoNite-Smart-Contracts\CryptoNova"

REM Remove stale lock if present
if exist ".git\index.lock" del /f /q ".git\index.lock"

REM Switch to v8 branch (already created, but in case we need to re-create)
git checkout v8 2>nul || git checkout -b v8

REM Stage all V8 files (exclude frontend deletions and generated artifacts)
git add contracts/
git add scripts/
git add test/
git add hardhat.config.js
git add package.json
git add package-lock.json
git add .env.example
git add V8_SPEC.md
git add DEPLOY_SEPOLIA.md
git add MAINNET_TODO.md
git add MAINNET_CONVEYOR_SCOPE.md
git add QUICKSTART.md
git add SECURITY_REVIEW.md
git add _archive_contracts/
git add _test_archive/

REM Commit
git commit -m "feat: V8 Elevator architecture — TierRouter + FigureEightMatrixV8 + PairManagerV8

- FigureEightMatrixV8: 7-tier BFS matrix, forceCross, deductForUpgrade
- PairManagerV8: multi-pair routing, registerDirectFor, registerFor
- TierRouter: 7-tier router, handleCycleOut, upgrade/re-entry logic
  inactivity pause guard (30 days / 2 cycles, DAO-adjustable)
  whale gate (T4 bypass for T6 when funded)
- deploy_v8.js: Phase 1 T1+T2 deploy script (Base Sepolia)
- V8Elevator.test.js: 106 tests passing — elevator cycle + upgrade + guards
- V8_SPEC.md: full architecture spec"

REM Push to origin v8
git push -u origin v8

echo.
echo ===== DONE =====
pause
