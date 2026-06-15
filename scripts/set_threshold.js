"use strict";
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_13.json"), "utf8"));
  const [deployer] = await ethers.getSigners();
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter, deployer);

  const before = await tr.autoUpgradeCycleThreshold();
  const target  = Number(process.env.THRESHOLD || 1);
  console.log(`\n  autoUpgradeCycleThreshold: ${before} → ${target}`);
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  console.log(`  Sending with explicit nonce ${nonce}...`);
  const tx = await tr.setAutoUpgradeCycleThreshold(target, { nonce });
  const receipt = await tx.wait();
  console.log(`  TX hash:   ${receipt.hash}`);
  console.log(`  TX status: ${receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
  const after = await tr.autoUpgradeCycleThreshold();
  console.log(`  Done: ${after}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
