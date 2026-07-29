"use strict";
/**
 * diag_gemma.js — why doesn't T2 show as open for Gemma after crossing to T1 MatB?
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const GEMMA = "0x85ec71aac242084905e2b385d81e129be7913cb7";

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

const TR_ABI = [
  "function globalJoined(address) view returns (bool)",
  "function memberHighestTier(address) view returns (uint8)",
  "function tierCycles(address,uint8) view returns (uint256)",
  "function tierWhaleGateActive(uint8) view returns (bool)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function tierVelocityGateOpen(uint8) view returns (bool)",
  "function manualUpgrade(uint8)",
];
const PM_ABI = [
  "function allPairsStatus() view returns (address[] matAs, address[] matBs, uint256[] matAOcc, uint256[] matBOcc, uint256[] matARot, uint256[] matBRot)",
];
const MAT_ABI = [
  "function hasEverJoined(address) view returns (bool)",
  "function isActiveInMatrix(address) view returns (bool)",
  "function parkedAt(address) view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;

  const tr   = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);
  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, provider);
  const pm1  = new ethers.Contract(addrs.tiers.T1.pm, PM_ABI, provider);

  console.log("=== Gemma T2 Gate Diagnostic ===");
  console.log(`Wallet: ${GEMMA}\n`);

  // Member state
  const [joined, highest, cycles0, cycles1] = await Promise.all([
    tr.globalJoined(GEMMA),
    tr.memberHighestTier(GEMMA),
    tr.tierCycles(GEMMA, 0),
    tr.tierCycles(GEMMA, 1).catch(() => 0n),
  ]);
  const usdcBal  = await usdc.balanceOf(GEMMA);
  const t2Fee    = await tr.tierEntryFees(1).catch(() => 0n); // T2 = index 1

  console.log(`globalJoined:      ${joined}`);
  console.log(`memberHighestTier: ${highest} (T${highest})`);
  console.log(`tierCycles[0] T1:  ${cycles0}`);
  console.log(`tierCycles[1] T2:  ${cycles1}`);
  console.log(`USDC balance:      $${(Number(usdcBal)/1e6).toFixed(4)}`);
  console.log(`T2 entry fee:      $${(Number(t2Fee)/1e6).toFixed(2)}`);

  // Gate state
  const whaleGate5 = await tr.tierWhaleGateActive(5).catch(() => null);
  const velGate2   = await tr.tierVelocityGateOpen(2).catch(() => 'N/A (fn not found)');
  console.log(`\nWhale gate[5]:     ${whaleGate5}  (unlocks T2-T5 manual upgrade)`);
  console.log(`Velocity gate T2:  ${velGate2}`);

  // Check all T1 pairs for Gemma's position
  console.log("\n=== T1 Matrix positions ===");
  const [matAs, matBs] = await pm1.allPairsStatus();
  for (let i = 0; i < matAs.length; i++) {
    for (const [label, addr] of [[`T1 MatA${i+1}`, matAs[i]], [`T1 MatB${i+1}`, matBs[i]]]) {
      if (!addr || addr === ethers.ZeroAddress) continue;
      const mc = new ethers.Contract(addr, MAT_ABI, provider);
      const ever = await mc.hasEverJoined(GEMMA).catch(() => false);
      if (!ever) continue;
      const [inMat, parkedAt, w, res, occ, rot] = await Promise.all([
        mc.isActiveInMatrix(GEMMA).catch(() => false),
        mc.parkedAt(GEMMA).catch(() => 0n),
        mc.withdrawableOf(GEMMA).catch(() => 0n),
        mc.crossingReserveOf(GEMMA).catch(() => 0n),
        mc.occupancy().catch(() => 0n),
        mc.rotationCount().catch(() => 0n),
      ]);
      console.log(`\n  [${label}] ${addr}`);
      console.log(`    isActiveInMatrix: ${inMat}  parkedAt: ${parkedAt}  occ: ${occ}  rot: ${rot}`);
      console.log(`    withdrawable: $${(Number(w)/1e6).toFixed(4)}  reserve: $${(Number(res)/1e6).toFixed(4)}`);
    }
  }

  // Simulate manualUpgrade(1) = upgrade to T2
  console.log("\n=== Simulating manualUpgrade(1) as Gemma ===");
  const iface = new ethers.Interface(["function manualUpgrade(uint8)"]);
  try {
    await provider.call({ from: GEMMA, to: addrs.tierRouter, data: iface.encodeFunctionData("manualUpgrade", [1]) });
    console.log("✓ manualUpgrade(1) would SUCCEED — no revert");
  } catch(e) {
    console.log(`✗ manualUpgrade(1) REVERTS: ${e.reason || e.data || e.message}`);
  }

  // T2 allowance check
  const t2Allowance = await usdc.allowance(GEMMA, addrs.tierRouter);
  console.log(`\nT2 USDC allowance to TierRouter: $${(Number(t2Allowance)/1e6).toFixed(4)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
