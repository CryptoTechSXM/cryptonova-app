"use strict";
const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const confirmed = await ethers.provider.getTransactionCount(deployer.address, "latest");
  const pending   = await ethers.provider.getTransactionCount(deployer.address, "pending");
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Confirmed nonce: ${confirmed}`);
  console.log(`  Pending nonce:   ${pending}`);
  console.log(`  Stuck txs:       ${pending - confirmed}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
