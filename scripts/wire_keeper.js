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

  const before = await tr.matrixKeeper();
  console.log(`\n  TierRouter.matrixKeeper before: ${before}`);
  console.log(`  Setting to:                     ${addrs.matrixKeeper}`);

  const tx = await tr.setMatrixKeeper(addrs.matrixKeeper);
  await tx.wait();

  const after = await tr.matrixKeeper();
  console.log(`  TierRouter.matrixKeeper after:  ${after}`);
  console.log(`  Wired: ${after.toLowerCase() === addrs.matrixKeeper.toLowerCase() ? '✓' : '✗ FAILED'}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
