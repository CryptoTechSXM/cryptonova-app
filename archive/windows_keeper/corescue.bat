@echo off
powershell -NonInteractive -Command "cd 'C:\CryptoNite-Smart-Contracts\CryptoNova'; npx hardhat run scripts/corescue_keeper.js --network baseSepolia 2>&1 | Add-Content 'C:\CryptoNite-Smart-Contracts\CryptoNova\logs\corescue.log'"
