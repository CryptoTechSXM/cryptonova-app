"use strict";
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, "deployed_addresses_v8_6.json"), "utf8"
  ));

  const pm  = await ethers.getContractAt("PairManagerV8", addrs.pairManager || addrs.PairManagerV8);
  const sf  = await ethers.getContractAt("StabilityFund", addrs.stabilityFund);
  const tr  = await ethers.getContractAt("TierRouter",    addrs.tierRouter);

  // T1 pair count
  const pairCount = await pm.activePairCount(0); // tierIdx=0
  console.log(`\nT1 active pairs: ${pairCount}`);

  for (let i = 0; i < Number(pairCount); i++) {
    const [matA, matB] = await pm.getPairAt(0, i);
    const matAc = await ethers.getContractAt("FigureEightMatrixV8", matA);
    const matBc = await ethers.getContractAt("FigureEightMatrixV8", matB);
    const [aCount, aMsize] = [await matAc.memberCount(), await matAc.MATRIX_SIZE()];
    const [bCount, bMsize] = [await matBc.memberCount(), await matBc.MATRIX_SIZE()];
    const aRot = await matAc.rotationCount();
    const bRot = await matBc.rotationCount();
    console.log(`  Pair ${i}: MatA=${matA.slice(0,10)} ${aCount}/${aMsize} rot=${aRot}`);
    console.log(`           MatB=${matB.slice(0,10)} ${bCount}/${bMsize} rot=${bRot}`);
  }

  // SF balances
  const sfTotal = await sf.totalBalance();
  const sfT1    = await sf.balanceByTier(0);
  console.log(`\nSF total: $${Number(sfTotal)/1e6}  T1: $${Number(sfT1)/1e6}`);

  // TierRouter T1 stats
  const stats = await tr.getTierStats(0);
  console.log(`TierRouter T1: totalMembers=${stats.totalMembers}  activePairs=${stats.activePairs || "N/A"}`);
}

main().catch(e => { console.error(e); process.exit(1); });
