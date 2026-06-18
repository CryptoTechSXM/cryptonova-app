"use strict";
/**
 * debug_upgrade.js — diagnose why manualUpgrade(1) fails for W1
 * Run: npx hardhat run scripts/debug_upgrade.js --network baseSepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const addrs   = require("./deployed_addresses_v8_12.json");
  const W1_ADDR = addrs.accountOne;
  const TR_ADDR = addrs.tierRouter;

  console.log("W1:", W1_ADDR);
  console.log("TierRouter:", TR_ADDR);

  const tr     = await ethers.getContractAt("TierRouter",            TR_ADDR);
  const matA2  = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T2.matA);
  const matB1  = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T1.matB);
  const pm2    = await ethers.getContractAt("PairManagerV8",         addrs.tiers.T2.pm);
  const usdc   = await ethers.getContractAt("MockUSDC",              addrs.usdc);

  console.log("\n── State checks ──");
  console.log("W1 globalJoined:    ", await tr.globalJoined(W1_ADDR));
  console.log("W1 T1 cycles:       ", (await tr.tierCycles(W1_ADDR, 0)).toString());
  console.log("W1 inT1MatB:        ", await matB1.isActiveInMatrix(W1_ADDR));
  console.log("W1 inT2MatA:        ", await matA2.isActiveInMatrix(W1_ADDR));
  console.log("T2MatA partner:     ", await matA2.partner());
  console.log("T2MatA pairManager: ", await matA2.pairManager());
  console.log("T2 PM pair count:   ", (await pm2.pairCount()).toString());
  console.log("TR T2 PM:           ", await tr.tierPairManagers(1));
  console.log("T2 entry fee:       $", Number(await tr.tierEntryFees(1)) / 1e6);
  console.log("W1 USDC bal:        $", Number(await usdc.balanceOf(W1_ADDR)) / 1e6);
  console.log("W1 allowance→TR:    $", Number(await usdc.allowance(W1_ADDR, TR_ADDR)) / 1e6);
  console.log("T2 velocity gate:   ", (await tr.getVelocityGates())[1]);
  console.log("System paused:      ", await tr.systemPaused());

  console.log("\n── Simulating manualUpgrade(1) as W1 ──");
  try {
    await tr.manualUpgrade.staticCall(1, { from: W1_ADDR });
    console.log("✅ staticCall PASSED — upgrade should work");
  } catch (e) {
    console.log("❌ staticCall FAILED:", e.reason || e.message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
