"use strict";
/**
 * open_whale_gate.js
 * Forces tierWhaleGateActive[5] = true on TierRouter, unlocking T2-T5
 * for manual entry.
 *
 * On testnet: the threshold (25 T5 pioneers) is too high to reach
 * organically before launch — open it manually so all T1 members can
 * see and use the T2-T5 upgrade path.
 *
 * Run:
 *   npx hardhat run scripts/open_whale_gate.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

async function main() {
  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [owner] = await ethers.getSigners();
  const tr      = await ethers.getContractAt("TierRouter", addrs.tierRouter, owner);

  console.log(`TierRouter : ${addrs.tierRouter}`);
  console.log(`Deployer   : ${owner.address}`);

  // Read current state
  const before = await tr.tierWhaleGateActive(5);
  const t5First  = await tr.tierFirstEntries(5).catch(() => 0n);
  const t5Thresh = await tr.tierGateThreshold(5).catch(() => 25n);
  console.log(`\nBefore: tierWhaleGateActive[5] = ${before}`);
  console.log(`        tierFirstEntries[5]     = ${t5First}`);
  console.log(`        tierGateThreshold[5]    = ${t5Thresh}`);

  if (before) {
    console.log("\n✓ Gate already open — nothing to do.");
    return;
  }

  console.log("\nOpening T5 whale gate (unlocks T2-T5 for manual entry)...");
  const tx = await tr.setTierWhaleGateActive(5, true, { gasLimit: 200_000 });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const after = await tr.tierWhaleGateActive(5);
  console.log(`\nAfter: tierWhaleGateActive[5] = ${after}`);
  console.log(after ? "✓ T2-T5 unlocked." : "✗ Still closed — check owner permissions.");
}

main().catch(e => { console.error(e); process.exit(1); });
