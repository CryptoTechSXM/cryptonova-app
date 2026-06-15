"use strict";
/**
 * open_gate.js — Manually open a velocity gate for a tier (owner-only).
 * Use when Chainlink hasn't run performUpkeep yet and MatB is already >=80%.
 *
 *   TIER=1 npx hardhat run scripts/open_gate.js --network baseSepolia
 *   (TIER is 0-indexed: T1=0, T2=1, T3=2, ...)
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_13.json");

async function main() {
  const tierIdx = Number(process.env.TIER ?? 1); // default: open T2 gate
  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter, deployer);

  const before = await tr.tierVelocityGreen(tierIdx);
  console.log(`\n  Tier ${tierIdx + 1} gate before: ${before ? "OPEN" : "CLOSED"}`);
  if (before) {
    console.log(`  Already open — nothing to do.`);
    return;
  }
  console.log(`  Opening T${tierIdx + 1} gate...`);
  const tx = await tr.setTierVelocityGreen(tierIdx, true);
  await tx.wait();
  const after = await tr.tierVelocityGreen(tierIdx);
  console.log(`  Tier ${tierIdx + 1} gate after:  ${after ? "OPEN ✓" : "CLOSED (failed)"}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
