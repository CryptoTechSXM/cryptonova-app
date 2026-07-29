"use strict";
/**
 * diag_lavern3.js
 * 1. Check T1.1 MatB for Lavern (missed in diag_lavern2 which only checked MatAs)
 * 2. Check T1.1 MatB crossing state — occ=127 rot=0 is suspicious
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const LAVERN = "0x728ff08035fffbc5a2f512a081cc88a4221f5f00";

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

const MAT_ABI = [
  "function hasEverJoined(address) view returns (bool)",
  "function isActiveInMatrix(address) view returns (bool)",
  "function parkedAt(address) view returns (uint256)",
  "function isParked(address) view returns (bool)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function entryFee() view returns (uint256)",
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
  "function crossingInProgress() view returns (bool)",
  "function getParkedCount() view returns (uint256)",
  "function selfRescue() external",
];
const PM_ABI = [
  "function allPairsStatus() view returns (address[] matAs, address[] matBs, uint256[] matAOcc, uint256[] matBOcc, uint256[] matARot, uint256[] matBRot)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;
  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, provider);
  const pm   = new ethers.Contract(addrs.tiers.T1.pm, PM_ABI, provider);

  const [matAs, matBs] = await pm.allPairsStatus();
  const usdcBal = await usdc.balanceOf(LAVERN);
  console.log(`Lavern USDC balance: $${(Number(usdcBal)/1e6).toFixed(4)}\n`);

  // Check ALL MatBs for Lavern
  console.log("=== Checking all MatBs for Lavern ===");
  for (let i = 0; i < matBs.length; i++) {
    const addr = matBs[i];
    if (!addr || addr === ethers.ZeroAddress) continue;
    const mc = new ethers.Contract(addr, MAT_ABI, provider);
    const [ever, inMat, parkedAt, isParked, w, res, fee, occ, rot, crossing, parkedCount] = await Promise.all([
      mc.hasEverJoined(LAVERN).catch(()=>false),
      mc.isActiveInMatrix(LAVERN).catch(()=>false),
      mc.parkedAt(LAVERN).catch(()=>0n),
      mc.isParked(LAVERN).catch(()=>false),
      mc.withdrawableOf(LAVERN).catch(()=>0n),
      mc.crossingReserveOf(LAVERN).catch(()=>0n),
      mc.entryFee().catch(()=>0n),
      mc.occupancy().catch(()=>0n),
      mc.rotationCount().catch(()=>0n),
      mc.crossingInProgress().catch(()=>false),
      mc.getParkedCount().catch(()=>0n),
    ]);
    console.log(`\nT1 MatB${i+1} (${addr}):`);
    console.log(`  occ=${occ}  rot=${rot}  crossingInProgress=${crossing}  parkedCount=${parkedCount}`);
    if (ever) {
      const shortfall = fee > (w + res) ? fee - (w + res) : 0n;
      const allowance = await usdc.allowance(LAVERN, addr);
      console.log(`  Lavern found here!`);
      console.log(`    hasEverJoined=${ever} inMatrix=${inMat} parkedAt=${parkedAt} isParked=${isParked}`);
      console.log(`    withdrawable=$${(Number(w)/1e6).toFixed(4)} reserve=$${(Number(res)/1e6).toFixed(4)}`);
      console.log(`    fee=$${(Number(fee)/1e6).toFixed(2)} shortfall=$${(Number(shortfall)/1e6).toFixed(4)}`);
      console.log(`    USDC allowance to MatB: $${(Number(allowance)/1e6).toFixed(4)}`);
    } else {
      console.log(`  Lavern NOT in this MatB.`);
    }
  }

  // Check ALL MatAs for Lavern (including T1.2)
  console.log("\n=== Checking all MatAs for Lavern ===");
  for (let i = 0; i < matAs.length; i++) {
    const addr = matAs[i];
    if (!addr || addr === ethers.ZeroAddress) continue;
    const mc = new ethers.Contract(addr, MAT_ABI, provider);
    const [ever, inMat, parkedAt, isParked, w, res, fee, occ, rot, crossing, parkedCount] = await Promise.all([
      mc.hasEverJoined(LAVERN).catch(()=>false),
      mc.isActiveInMatrix(LAVERN).catch(()=>false),
      mc.parkedAt(LAVERN).catch(()=>0n),
      mc.isParked(LAVERN).catch(()=>false),
      mc.withdrawableOf(LAVERN).catch(()=>0n),
      mc.crossingReserveOf(LAVERN).catch(()=>0n),
      mc.entryFee().catch(()=>0n),
      mc.occupancy().catch(()=>0n),
      mc.rotationCount().catch(()=>0n),
      mc.crossingInProgress().catch(()=>false),
      mc.getParkedCount().catch(()=>0n),
    ]);
    console.log(`\nT1 MatA${i+1} (${addr}):`);
    console.log(`  occ=${occ}  rot=${rot}  crossingInProgress=${crossing}  parkedCount=${parkedCount}`);
    if (ever) {
      console.log(`  Lavern found here!`);
      console.log(`    hasEverJoined=${ever} inMatrix=${inMat} parkedAt=${parkedAt} isParked=${isParked}`);
      console.log(`    withdrawable=$${(Number(w)/1e6).toFixed(4)} reserve=$${(Number(res)/1e6).toFixed(4)}`);
    } else {
      console.log(`  Lavern NOT in this MatA.`);
    }
  }

  // Check T1.1 MatB crossing state more carefully — occ=127 rot=0 suspicious
  console.log("\n=== T1.1 MatB deep check (occ=127 rot=0) ===");
  const matB1 = new ethers.Contract(matBs[0], MAT_ABI, provider);
  const [occ1, rot1, crossing1, parked1] = await Promise.all([
    matB1.occupancy(),
    matB1.rotationCount(),
    matB1.crossingInProgress(),
    matB1.getParkedCount(),
  ]);
  console.log(`  occ=${occ1}  rot=${rot1}  crossingInProgress=${crossing1}  parkedCount=${parked1}`);
  if (crossing1) {
    console.log("  ⚠️  crossingInProgress=true — MatB crossing is STUCK (likely OOG or keeper not running)");
  } else if (occ1 === 127n && rot1 === 0n) {
    console.log("  ⚠️  127 members, no rotations, crossing not in progress — MatB has never crossed.");
    console.log("  This means 127 members are sitting in MatB waiting for their payout crossing.");
    console.log("  Check if the keeper is calling the cross function.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
