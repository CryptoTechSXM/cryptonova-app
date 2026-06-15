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
  const mk = await ethers.getContractAt("MatrixKeeper", addrs.matrixKeeper, deployer);

  const trOwner = await tr.owner();
  const mkOwner = await mk.owner();
  const mkAddr  = await tr.matrixKeeper();

  console.log(`\n  Deployer:              ${deployer.address}`);
  console.log(`  TierRouter owner:      ${trOwner}  ${trOwner.toLowerCase() === deployer.address.toLowerCase() ? '✓ match' : '✗ MISMATCH'}`);
  console.log(`  MatrixKeeper owner:    ${mkOwner}`);
  console.log(`  TR.matrixKeeper addr:  ${mkAddr}`);
  console.log(`  MatrixKeeper contract: ${addrs.matrixKeeper}`);
  console.log(`  MK wired to TR:        ${mkAddr.toLowerCase() === addrs.matrixKeeper.toLowerCase() ? '✓ yes' : '✗ NO'}`);

  // Try reading velocityGreen for multiple indices to find correct mapping
  for (let i = 0; i <= 3; i++) {
    const v = await tr.tierVelocityGreen(i);
    console.log(`  tierVelocityGreen(${i}): ${v}`);
  }
  console.log('');
}
main().catch(e => { console.error(e); process.exit(1); });
