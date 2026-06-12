"use strict";
const { ethers } = require("hardhat");

const BM_ADDR = "0xDdaDc31c9e1854fFAacCe520e5843b135eCB5B41";  // Deploy 9
const W1 = "0x19a59fbD6d2c1289668795D41453e1505B7B8102";

async function main() {
  const bm = await ethers.getContractAt("BeltManagerV6", BM_ADDR);
  const usdc = await ethers.getContractAt("MockUSDC", "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a");

  console.log("\n=== BELTMANAGER STATE ===");
  console.log("activeBeltIndex:", (await bm.activeBeltIndex()).toString());
  console.log("queueLength:", (await bm.queueLength()).toString());
  console.log("BM USDC balance:", ethers.formatUnits(await usdc.balanceOf(bm.target), 6));

  console.log("\n=== BELT STATUS ===");
  const totalBelts = Number(await bm.totalBelts());
  for(let i = 0; i < totalBelts; i++) {
    const [addr, cnt, full, active] = await bm.beltStatus(i);
    const mx = await ethers.getContractAt("CryptoNovaMatrixV6", addr);
    const pool = await mx.reentryPool();
    const mxUsdc = await usdc.balanceOf(addr);
    const w1pos = await mx.matrixPos(W1);
    const w1m = await mx.getMember(W1);
    console.log(`Belt ${i}: ${cnt} members | full:${full} | active:${active} | pool:$${ethers.formatUnits(pool,6)} | usdcBal:$${ethers.formatUnits(mxUsdc,6)}`);
    if(Number(w1pos) > 0) console.log(`  *** W1 in Belt ${i} at position ${w1pos} ***`);
    if(w1m.hasEverJoined) console.log(`  W1 in this matrix: withdrawable=$${ethers.formatUnits(w1m.withdrawable,6)} cycles=${w1m.cyclesCompleted}`);
  }

  console.log("\n=== W1 QUEUE POSITION ===");
  console.log("queuePos:", (await bm.queuePosition(W1)).toString());
  console.log("memberBeltIndex:", (await bm.memberBeltIndex(W1)).toString());
}
main().catch(e=>{console.error(e);process.exit(1);});
