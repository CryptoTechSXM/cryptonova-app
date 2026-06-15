"use strict";
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_13.json"), "utf8"));
  const [deployer] = await ethers.getSigners();
  const tr   = await ethers.getContractAt("TierRouter", addrs.tierRouter, deployer);
  const matA = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA, deployer);
  const matB = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matB, deployer);

  const w1 = addrs.accountOne;
  const t2matA = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T2.matA, deployer);
  const t2matB = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T2.matB, deployer);
  const usdc   = await ethers.getContractAt("MockUSDC", addrs.usdc, deployer);

  const [threshold, highestTier, t2green, matACycles, matBCycles, matAOcc, matBOcc,
         w1PersonalCycles, t2matAOcc, t2matBOcc, w1T2Cycles, w1Usdc, w1InT2MatA, w1InT2MatB] = await Promise.all([
    tr.autoUpgradeCycleThreshold(),
    tr.memberHighestTier(w1),
    tr.tierVelocityGreen(1),
    matA.rotationCount(),
    matB.rotationCount(),
    matA.occupancy(),
    matB.occupancy(),
    tr.tierCycles(w1, 0),
    t2matA.occupancy(),
    t2matB.occupancy(),
    tr.tierCycles(w1, 1),
    usdc.balanceOf(w1),
    t2matA.isActiveInMatrix(w1),
    t2matB.isActiveInMatrix(w1),
  ]);

  console.log("\n  ── Upgrade Status ────────────────────────────────────────");
  console.log(`  autoUpgradeCycleThreshold: ${threshold}`);
  console.log(`  W1 highestTier:            T${highestTier}`);
  console.log(`  W1 USDC balance:           $${(Number(w1Usdc)/1e6).toFixed(3)}`);
  console.log(`  W1 personal T1 cycles:     ${w1PersonalCycles}`);
  console.log(`  W1 personal T2 cycles:     ${w1T2Cycles}`);
  console.log(`  W1 in T2 MatA:             ${w1InT2MatA}`);
  console.log(`  W1 in T2 MatB:             ${w1InT2MatB}`);
  console.log(`  T1 MatA rotationCount:     ${matACycles}`);
  console.log(`  T1 MatB rotationCount:     ${matBCycles}`);
  console.log(`  T1 MatA occupancy:         ${matAOcc}/127`);
  console.log(`  T1 MatB occupancy:         ${matBOcc}/127`);
  console.log(`  T2 MatA occupancy:         ${t2matAOcc}/127`);
  console.log(`  T2 MatB occupancy:         ${t2matBOcc}/127`);
  console.log(`  T2 velocityGreen:          ${t2green}`);
  console.log('');
}
main().catch(e => { console.error(e); process.exit(1); });
