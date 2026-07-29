"use strict";
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, "deployed_addresses_v8_32.json"), "utf8"
  ));

  const T1 = addrs.tiers.T1;
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter);
  const pm = await ethers.getContractAt("PairManager", T1.pm);

  const totalMembers = await tr.globalJoinedCount();

  console.log("\n=== V8.32 STATE ===");
  console.log(`Total globally joined: ${totalMembers}`);

  // T1 active pair
  const pairCount = await pm.pairCount();
  const pmTotal   = await pm.totalMembers();
  console.log(`\nT1 pair count: ${pairCount}  totalMembers: ${pmTotal}`);

  const activePair = await pm.getActivePair();
  const matA = activePair[0], matB = activePair[1];
  const matAc = await ethers.getContractAt("FigureEightMatrixV8", matA);
  const matBc = await ethers.getContractAt("FigureEightMatrixV8", matB);
  const aOcc   = await matAc.occupancy();
  const bOcc   = await matBc.occupancy();
  const aMsize = await matAc.MATRIX_SIZE();
  const bMsize = await matBc.MATRIX_SIZE();
  const aRot   = await matAc.rotationCount();
  const bRot   = await matBc.rotationCount();
  console.log(`  Active MatA ${matA.slice(0,10)}: ${aOcc}/${aMsize} rot=${aRot}`);
  console.log(`  Active MatB ${matB.slice(0,10)}: ${bOcc}/${bMsize} rot=${bRot}`);

  // W1 state
  const w1 = addrs.accountOne;
  if (w1) {
    const matAc = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
    const m = await matAc.getMember(w1);
    console.log(`\nW1 (${w1.slice(0,10)}...):`);
    console.log(`  isInMatrix   : ${m.isInMatrix}`);
    console.log(`  withdrawable : $${(Number(m.withdrawable)/1e6).toFixed(4)}`);
    console.log(`  crossingRes  : $${(Number(m.crossingReserve)/1e6).toFixed(4)}`);
    console.log(`  totalEarned  : $${(Number(m.totalEarned)/1e6).toFixed(4)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
