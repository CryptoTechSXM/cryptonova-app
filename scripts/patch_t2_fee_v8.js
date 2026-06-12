"use strict";
/**
 * patch_t2_fee_v8.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces the T2 PairManager with a new one that charges $15 instead of $25.
 *
 * Why: With a 15-person matrix and no referrers (testnet), the MatB root
 * accumulates ~$22.80 (chain pay $6 + orphan escrow $16.80) before cycling
 * out. The original $25 T2 fee is $2.20 above that ceiling, blocking every
 * auto-upgrade. $15 gives a comfortable $7.80 margin.
 *
 * What this script does:
 *   1. Deploy new PairManagerV8 at T2 entry fee = $15
 *   2. Wire newPm.setTierRouter(trAddr)
 *   3. Re-point T2 matrices: matA.setPairManager(newPm) + matB.setPairManager(newPm)
 *   4. newPm.addPair(t2MatA, t2MatB)  — registers matrices + sets chainNext
 *   5. tierRouter.registerTier(1, newPm, 15_000_000)  — overwrite PM + fee
 *   6. Patch deployed_addresses_v8_1.json with new T2 PM address
 *
 *   npx hardhat run scripts/patch_t2_fee_v8.js --network baseSepolia
 */
const { ethers, NonceManager } = require("ethers");
const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses_v8_1.json");
const NEW_T2_FEE     = 15_000_000n;   // $15 USDC (6 dec)

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const { ethers: hEthers } = hre;
  const [rawSigner] = await hEthers.getSigners();
  const deployer    = new NonceManager(rawSigner);
  const admin       = rawSigner.address;

  console.log(`Deployer: ${admin}`);
  console.log(`T2 fee:   $${Number(NEW_T2_FEE) / 1e6}`);

  const trAddr  = addrs.tierRouter;
  const t2MatA  = addrs.tiers.T2.matA;
  const t2MatB  = addrs.tiers.T2.matB;
  const oldPM   = addrs.tiers.T2.pm;

  console.log(`\nOld T2 PM:  ${oldPM}`);
  console.log(`T2 MatA:    ${t2MatA}`);
  console.log(`T2 MatB:    ${t2MatB}`);

  // ── 1. Deploy new T2 PairManagerV8 ────────────────────────────────────────
  console.log("\n── 1. Deploy new PairManagerV8 (T2 $15)");
  const PMV8Factory = await hEthers.getContractFactory("PairManagerV8", deployer);
  const newPm = await PMV8Factory.deploy(addrs.usdc, NEW_T2_FEE, admin);
  await newPm.waitForDeployment();
  const newPmAddr = await newPm.getAddress();
  console.log(`  ✓ New T2 PM deployed: ${newPmAddr}`);

  // ── 2. Wire tierRouter into new PM ─────────────────────────────────────────
  console.log("\n── 2. setTierRouter on new PM");
  await (await newPm.setTierRouter(trAddr)).wait();
  console.log(`  ✓ newPm.setTierRouter(${trAddr})`);

  // ── 3. Re-point T2 matrices to new PM ─────────────────────────────────────
  console.log("\n── 3. Update T2 matrices → new PM");
  const matA = await hEthers.getContractAt("FigureEightMatrixV8", t2MatA, deployer);
  const matB = await hEthers.getContractAt("FigureEightMatrixV8", t2MatB, deployer);
  await (await matA.setPairManager(newPmAddr)).wait();
  console.log(`  ✓ T2 MatA.setPairManager → ${newPmAddr.slice(0,10)}`);
  await (await matB.setPairManager(newPmAddr)).wait();
  console.log(`  ✓ T2 MatB.setPairManager → ${newPmAddr.slice(0,10)}`);

  // ── 4. Register pair in new PM ─────────────────────────────────────────────
  console.log("\n── 4. newPm.addPair(T2 MatA, T2 MatB)");
  await (await newPm.addPair(t2MatA, t2MatB)).wait();
  console.log(`  ✓ addPair OK`);

  // ── 5. Register new PM + fee in TierRouter ─────────────────────────────────
  console.log("\n── 5. tierRouter.registerTier(1, newPm, $15)");
  const tierRouter = await hEthers.getContractAt("TierRouter", trAddr, deployer);
  await (await tierRouter.registerTier(1, newPmAddr, NEW_T2_FEE)).wait();
  console.log(`  ✓ TierRouter updated`);

  // ── 6. Verify + patch addresses file ──────────────────────────────────────
  const pmCheck = await tierRouter.tierPairManagers(1);
  const feeCheck = await tierRouter.tierEntryFees(1);
  console.log(`\n  Verify TierRouter T2 PM:  ${pmCheck}`);
  console.log(`  Verify TierRouter T2 fee: $${Number(feeCheck) / 1e6}`);
  if (pmCheck.toLowerCase() !== newPmAddr.toLowerCase()) {
    throw new Error("TierRouter T2 PM mismatch — aborting JSON update");
  }

  addrs.tiers.T2.pm = newPmAddr;
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addrs, null, 2));
  console.log(`\n  ✓ deployed_addresses_v8_1.json updated (T2 PM → ${newPmAddr.slice(0,10)})`);

  console.log("\n  ✅ T2 fee patch complete. Re-run bigfill to confirm T1→T2 upgrade.");
  console.log(`     HDR_OFFSET=1500 $env:COUNT=35; npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
