"use strict";
/**
 * update_tier_matrices.js
 *
 * Reads the current active MatA/MatB from the T1 PairManager and calls
 * setTierMatrices(0, matA, matB) on TierRouter so that manualUpgrade()
 * correctly recognises members in T1.2 MatB (the factory-created pair).
 *
 * Root cause: tierMatrixBAddr[0] was set to T1.1 MatB at deploy time and
 * never updated when MatrixPairFactory created T1.2. Members in T1.2 MatB
 * fail the inPrevMatB check and can't manually upgrade to T2.
 *
 * Run:
 *   npx hardhat run scripts/update_tier_matrices.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

async function main() {
  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [owner] = await ethers.getSigners();

  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter, owner);
  const pm = await ethers.getContractAt("PairManagerV8",
    addrs.tiers?.T1?.pm || addrs.T1?.pm, owner);

  // Current tracked addresses
  const currentMatA = await tr.tierMatrixAAddr(0);
  const currentMatB = await tr.tierMatrixBAddr(0);
  console.log(`TierRouter currently tracks:`);
  console.log(`  T1 MatA : ${currentMatA}`);
  console.log(`  T1 MatB : ${currentMatB}`);

  // Active pair from PairManager
  const activeMatA = await pm.currentMatA();
  const activeMatB = await pm.currentMatB();
  console.log(`\nPairManager active pair:`);
  console.log(`  T1 MatA : ${activeMatA}`);
  console.log(`  T1 MatB : ${activeMatB}`);

  if (currentMatB.toLowerCase() === activeMatB.toLowerCase()) {
    console.log("\n✓ Already pointing at the active pair — nothing to do.");
    return;
  }

  console.log(`\nUpdating TierRouter to track active pair...`);
  const tx = await tr.setTierMatrices(0, activeMatA, activeMatB, { gasLimit: 200_000 });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const newMatA = await tr.tierMatrixAAddr(0);
  const newMatB = await tr.tierMatrixBAddr(0);
  console.log(`\nAfter update:`);
  console.log(`  T1 MatA : ${newMatA}`);
  console.log(`  T1 MatB : ${newMatB}`);
  console.log(newMatB.toLowerCase() === activeMatB.toLowerCase()
    ? "✓ Done — members in T1.2 MatB can now manually upgrade to T2."
    : "✗ Update failed — check owner permissions.");
}

main().catch(e => { console.error(e); process.exit(1); });
