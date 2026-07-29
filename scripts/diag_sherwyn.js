"use strict";
/**
 * diag_sherwyn.js — diagnose why manualUpgrade reverts for Sherwyn
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const SHERWYN = "0x774481DAc8584CfAFb5B6b6fAD883787b343C573";

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;

  const TR_ABI = [
    "function globalJoined(address) view returns (bool)",
    "function memberHighestTier(address) view returns (uint8)",
    "function tierCycles(address,uint8) view returns (uint256)",
    "function memberReferrer(address) view returns (address)",
    "function tierWhaleGateActive(uint8) view returns (bool)",
    "function tierEntryFees(uint8) view returns (uint256)",
    "function tierMatrixAAddr(uint8) view returns (address)",
    "function tierMatrixBAddr(uint8) view returns (address)",
    "function tierPairManagers(uint8) view returns (address)",
  ];
  const MAT_ABI = [
    "function isActiveInMatrix(address) view returns (bool)",
    "function getOccupancy() view returns (uint256)",
    "function crossingInProgress() view returns (bool)",
    "function rotationCount() view returns (uint256)",
  ];
  const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ];

  const tr   = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);
  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, provider);

  console.log("=== Sherwyn Diagnostic ===");
  console.log(`Wallet: ${SHERWYN}`);

  const joined  = await tr.globalJoined(SHERWYN);
  const highest = await tr.memberHighestTier(SHERWYN);
  const cycles0 = await tr.tierCycles(SHERWYN, 0);
  const cycles1 = await tr.tierCycles(SHERWYN, 1);
  const referrer = await tr.memberReferrer(SHERWYN);

  console.log(`\nMember state:`);
  console.log(`  globalJoined:      ${joined}`);
  console.log(`  memberHighestTier: ${highest}`);
  console.log(`  tierCycles[0] (T1): ${cycles0}`);
  console.log(`  tierCycles[1] (T2): ${cycles1}`);
  console.log(`  referrer:          ${referrer}`);

  // T1 matrix state
  const t1MatA = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, provider);
  const t1MatB = new ethers.Contract(addrs.tiers.T1.matB, MAT_ABI, provider);
  const inT1MatA = await t1MatA.isActiveInMatrix(SHERWYN).catch(() => "err");
  const inT1MatB = await t1MatB.isActiveInMatrix(SHERWYN).catch(() => "err");
  console.log(`\nT1 Matrix:`);
  console.log(`  T1 MatA: ${addrs.tiers.T1.matA} — inMatrix: ${inT1MatA}`);
  console.log(`  T1 MatB: ${addrs.tiers.T1.matB} — inMatrix: ${inT1MatB}`);

  // T2 MatA state
  const t2MatA = new ethers.Contract(addrs.tiers.T2.matA, MAT_ABI, provider);
  const t2MatB = new ethers.Contract(addrs.tiers.T2.matB, MAT_ABI, provider);
  const inT2MatA = await t2MatA.isActiveInMatrix(SHERWYN).catch(() => "err");
  const inT2MatB = await t2MatB.isActiveInMatrix(SHERWYN).catch(() => "err");
  const t2MatAOcc  = await t2MatA.getOccupancy().catch(() => "err");
  const t2MatACross = await t2MatA.crossingInProgress().catch(() => "err");
  const t2MatARot  = await t2MatA.rotationCount().catch(() => "err");
  const t2MatBOcc  = await t2MatB.getOccupancy().catch(() => "err");
  const t2MatBCross = await t2MatB.crossingInProgress().catch(() => "err");
  console.log(`\nT2 Matrix:`);
  console.log(`  T2 MatA: occ=${t2MatAOcc}, crossingInProgress=${t2MatACross}, rotCount=${t2MatARot}`);
  console.log(`  T2 MatA — inMatrix(Sherwyn): ${inT2MatA}`);
  console.log(`  T2 MatB: occ=${t2MatBOcc}, crossingInProgress=${t2MatBCross}`);
  console.log(`  T2 MatB — inMatrix(Sherwyn): ${inT2MatB}`);

  // Whale gate state
  const gate5 = await tr.tierWhaleGateActive(5);
  const fee1  = await tr.tierEntryFees(1); // T2 (index 1)
  console.log(`\nWhole gate[5]: ${gate5}`);
  console.log(`T2 entry fee:  $${Number(fee1) / 1e6}`);

  // USDC
  const bal = await usdc.balanceOf(SHERWYN);
  const allowance = await usdc.allowance(SHERWYN, addrs.tierRouter);
  console.log(`\nSherwyn USDC balance:   $${Number(bal) / 1e6}`);
  console.log(`Sherwyn USDC allowance: $${Number(allowance) / 1e6} to TierRouter`);
}

main().catch(e => { console.error(e); process.exit(1); });
