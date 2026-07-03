# CryptoNova Smart Contracts — CLAUDE.md

Read this file at the start of every session before touching contracts, scripts, or deploy.

---

## Active deployment

| Item | Value |
|------|-------|
| Version | V8.31 |
| Network | Base Sepolia |
| Addresses file | `scripts/deployed_addresses_v8_31.json` |
| `.env` ADDRESSES_FILE | `deployed_addresses_v8_31.json` |
| Deployer | 0x5EaEfA3086F025099f224cBe64fc9b3787533BB4 |

**Check `.env` ADDRESSES_FILE before every deploy.** The wrong value caused V8.18 to overwrite V8.19 data.

---

## Wallet / key rules

| Wallet | Role | Rule |
|--------|------|------|
| 0x5EaEfA3... | Active deployer | Use for all deploys and admin calls |
| 0xCd0Af6... | BANNED for deploy | EIP-7702 delegated — will be rejected on-chain |
| 0x6512e9... | W1 (accountOne) | Root member, first MatA position |

**NEVER put private keys or credentials in PowerShell commands.** All keys live in `.env`. Only runtime params go on the command line (`HDR_OFFSET`, `COUNT`, `TIER`, `MSIZE`, etc.).

---

## PowerShell rules

- **NEVER chain commands with `&&`** — PowerShell does not support it. Always separate commands.
- **One command at a time.** Give one command, wait for output + no-error confirmation, then give the next. Never give multiple steps at once.
- Run scripts with hardhat, not node: `npx hardhat run scripts/X.js --network baseSepolia`

---

## Deploy protocol (every deploy, no exceptions)

1. **Disable all 7 CryptoNova keeper tasks** in Windows Task Scheduler before starting
2. Check `.env` `ADDRESSES_FILE` points to the correct file for this version
3. Run predeploy check: `npx hardhat run scripts/predeploy_check.js --network baseSepolia` (must pass 91/91)
4. Deploy: `npx hardhat run scripts/deploy_v8.js --network baseSepolia`
5. **Immediately commit the new addresses file:**
   ```powershell
   git add scripts/deployed_addresses_v8_XX.json
   git commit -m "Add V8.XX deployed addresses"
   git push
   ```
   ⚠️ V8.29 was lost because this step was skipped. Never skip it.
6. Update `.env` `ADDRESSES_FILE` to the new file
7. Run `setTierMatrices` — required separately from `registerTier` (see below)
8. Seed W1 via `seed_w1.js`
9. Re-enable keepers (only the ones that were active before — check last-run timestamps)

---

## setTierMatrices — required after EVERY deploy

`registerTier()` sets PairManager address + entry fee only.
`setTierMatrices()` sets matA and matB addresses separately.

**Both are required.** If `setTierMatrices` is not called, `manualUpgrade` will always revert.

---

## USDC mint rule (testnet)

MockUSDC `mint()` is `onlyOwner`. The deployed MockUSDC at `0x2D8B7b5...` is owned by old deployer `0xCd0Af6`. The active deployer `0x5EaEfA3` cannot call `mint()`.

**Workaround:** Use faucet or `transfer_usdc_to_w1.js` to move USDC from funded wallets.

---

## EIP-7702 deployer ban

Address `0xCd0Af6` was used in an EIP-7702 delegation transaction and is now treated as a contract by Base Sepolia. Deploy transactions from it will be rejected. Always use `0x5EaEfA3` for deploys.

---

## Nonce / deploy gotchas

- Remove any nonce reset logic before deploy (causes "nonce too low" errors)
- Keep the 8-second sleep between contract deployments (prevents nonce collisions)
- Disable all 7 keepers before deploy — active keepers submit transactions and advance the nonce mid-deploy

---

## Vercel force-push trigger

After a force-push that Vercel ignores:
```powershell
git commit --allow-empty -m "trigger deploy"
git push origin admin
```

---

## Test suite

```powershell
npx hardhat test
```
Must pass 173/173 (V8.31). Never deploy on a failing test suite.

---

## Address backup rule (CRITICAL)

Commit `deployed_addresses_vX_XX.json` immediately after every deploy. This is the only record of which contracts were deployed. Without it, the entire session of deploy work is unrecoverable if anything goes wrong.
