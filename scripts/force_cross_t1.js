"use strict";
/**
 * force_cross_t1.js — manually trigger MatrixKeeper performUpkeep
 * Calls checkUpkeep() to get performData, then calls performUpkeep() with it.
 * Use when Chainlink hasn't fired and MatA is stuck at 127/127.
 *
 * Run: npx hardhat run scripts/force_cross_t1.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, "deployed_addresses_v8_32.json"), "utf8"
  ));

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const keeper = await ethers.getContractAt("MatrixKeeper", addrs.matrixKeeper, deployer);

  // Check what keeper wants to do
  console.log("\nCalling checkUpkeep...");
  const [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  console.log("upkeepNeeded:", upkeepNeeded);
  console.log("performData length:", performData.length);

  if (!upkeepNeeded || performData === "0x" || performData.length <= 2) {
    console.log("\n⚠  Keeper says no upkeep needed — checking MatA directly...");

    // Check MatA state directly
    const matA = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA);
    const occ  = await matA.occupancy();
    const msize = await matA.MATRIX_SIZE();
    const rot  = await matA.rotationCount();
    console.log(`MatA: ${occ}/${msize} rot=${rot}`);

    // Check crossing reserve total
    const pm = await ethers.getContractAt("PairManager", addrs.tiers.T1.pm);
    console.log("T1 PairManager totalMembers:", await pm.totalMembers());
    console.log("\nKeeper reports nothing to do. Check if crossing threshold is unmet.");
    return;
  }

  console.log("\n✓ Keeper has work — calling performUpkeep...");
  const tx = await keeper.performUpkeep(performData, { gasLimit: 15_000_000 });
  console.log("TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("✓ Confirmed in block", receipt.blockNumber, "gas used:", receipt.gasUsed.toString());

  // Post-state
  const matA = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA);
  const matB = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matB);
  console.log("\nPost-upkeep:");
  console.log(`  MatA: ${await matA.occupancy()}/${await matA.MATRIX_SIZE()} rot=${await matA.rotationCount()}`);
  console.log(`  MatB: ${await matB.occupancy()}/${await matB.MATRIX_SIZE()} rot=${await matB.rotationCount()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
