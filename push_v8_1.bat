@echo off
REM push_v8_1.bat — commit and push all V8.1 contracts to GitHub
cd /d "C:\CryptoNite-Smart-Contracts\CryptoNova"

echo Removing stale git lock (if any)...
del ".git\index.lock" 2>nul
del ".git\HEAD.lock" 2>nul
del ".git\refs\heads\v8.1.lock" 2>nul

echo.
echo Creating / switching to v8.1 branch...
git checkout -b v8.1 2>nul || git checkout v8.1

echo.
echo Staging V8.1 files...
git add contracts/FigureEightMatrixV8.sol
git add contracts/TierRouter.sol
git add contracts/StabilityFund.sol
git add contracts/MatrixFactory.sol
git add contracts/MatrixKeeper.sol
git add contracts/V8Governance.sol
git add scripts/deploy_v8.js
git add scripts/bigfill_v8.js
git add hardhat.config.js
git add push_v8_1.bat
git add V8_SPEC.md

echo.
echo Status:
git status

echo.
echo Committing...
git commit -m "feat: V8.1 Elevator -- full contract suite

New contracts:
- StabilityFund.sol   : 5-layer health fund
- MatrixFactory.sol   : registry + wiring hub (3.8 KB, EIP-170 OK)
- MatrixKeeper.sol    : Chainlink Automation upkeep
- V8Governance.sol    : DAO (CNOVA-weighted, enumerated params, 72h+48h)

Modified contracts:
- FigureEightMatrixV8.sol : Option B BPS, equalization pool, DeployParams struct
- TierRouter.sol          : member toggles, velocity gate, escrow floor guard

Scripts:
- deploy_v8.js   : full 7-tier scaffold, registry-pattern deploy
- bigfill_v8.js  : V8.1 snapshot (poolAccumulator + StabilityFund balance)

35 Solidity files compile clean, evm target paris"

echo.
echo Pushing to origin v8.1...
git push -u origin v8.1

echo.
echo ============================================================
echo  DONE - v8.1 branch pushed to GitHub
echo ============================================================
echo.
pause
