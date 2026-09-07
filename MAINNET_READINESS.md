# MAINNET_READINESS.md — MOVED 2026-09-07 (session 66)

The live document is **`C:\CryptoNova-Mainnet-App\MAINNET_READINESS.md`** (github
CryptoTechSXM/cryptonova-mainnet-app, branch `main`, commit 18154e5). Owner rule 2026-09-07:
everything for mainnet lives in the Mainnet-App repo. Do not edit this pointer; edit the live file.

What stays in THIS repo (one source of code for both networks): the Solidity, Hardhat config,
`scripts/deploy_v8.js`, `seed_w1.js`, `postdeploy_check.js`, `chain_guard.js`, the tests. The
mainnet deploy is these scripts run with a mainnet `.env` built from
`C:\CryptoNova-Mainnet-App\env.mainnet.deploy.template`.
