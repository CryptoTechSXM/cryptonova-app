"use strict";
/**
 * manual_upgrade_w1.js — Manually upgrades W1 from T1 → T2 via TierRouter.manualUpgrade().
 * W1 pays the T2 entry fee ($25) from their own USDC balance.
 * Requires W1 to have: >= 1 T1 cycle, not be seated in T1 MatB, and enough USDC.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_13.json"), "utf8"));

  // W1 is a standalone wallet defined by W1_PRIVATE_KEY in .env (set during deploy_v8.js)
  const w1Key = process.env.W1_PRIVATE_KEY;
  if (!w1Key) { console.error("W1_PRIVATE_KEY not set in .env"); process.exit(1); }
  const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);

  const tr   = await ethers.getContractAt("TierRouter", addrs.tierRouter, w1Wallet);
  const usdc = await ethers.getContractAt("MockUSDC",   addrs.usdc,       w1Wallet);

  const T2_INDEX = 1; // 0-indexed: T1=0, T2=1
  const t2fee    = await tr.tierEntryFees(T2_INDEX);

  console.log(`\n  W1 address:       ${w1Wallet.address}`);
  console.log(`  T2 entry fee:     $${Number(t2fee) / 1e6}`);

  const w1Cycles  = await tr.tierCycles(w1Wallet.address, 0);
  const w1Highest = await tr.memberHighestTier(w1Wallet.address);
  const w1Usdc    = await usdc.balanceOf(w1Wallet.address);
  console.log(`  W1 T1 cycles:     ${w1Cycles}`);
  console.log(`  W1 highestTier:   T${w1Highest}`);
  console.log(`  W1 USDC balance:  $${Number(w1Usdc) / 1e6}`);

  if (Number(w1Highest) >= T2_INDEX) {
    console.log(`  W1 is already T${w1Highest} — nothing to do. Exiting cleanly.`);
    process.exit(0);
  }
  if (w1Cycles < 1n) { console.error("  W1 has no T1 cycles yet — cannot upgrade"); process.exit(1); }
  if (w1Usdc < t2fee) { console.error("  W1 insufficient USDC for T2 fee"); process.exit(1); }

  console.log(`\n  Approving TierRouter for $${Number(t2fee) / 1e6} USDC...`);
  await (await usdc.approve(addrs.tierRouter, t2fee)).wait();

  console.log(`  Calling manualUpgrade(${T2_INDEX}) from W1...`);
  const tx = await tr.manualUpgrade(T2_INDEX);
  const receipt = await tx.wait();
  console.log(`  TX status: ${receipt.status === 1 ? "SUCCESS ✓" : "REVERTED ✗"}`);

  const afterTier = await tr.memberHighestTier(w1Wallet.address);
  console.log(`  W1 highestTier after: T${afterTier}\n`);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
