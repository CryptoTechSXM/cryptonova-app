"use strict";
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"), "utf8"
  ));
  const [signer] = await ethers.getSigners();
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter, signer);
  const pm = await ethers.getContractAt("PairManagerV8",
    addrs.tiers?.T1?.pm || addrs.T1?.pm, signer);

  // Check receipt of last update attempt
  const TX_HASH = "0xcb54c161e5da143779fadf4f596881afe77aad236f7ab82962239d784746969a";
  const receipt = await ethers.provider.getTransactionReceipt(TX_HASH);
  console.log(`\nReceipt for update tx:`);
  console.log(`  status : ${receipt?.status} ${receipt?.status === 1 ? "(SUCCESS)" : "(REVERTED)"}`);
  console.log(`  gasUsed: ${receipt?.gasUsed}`);

  // Current state
  console.log(`\nCurrent TierRouter state:`);
  console.log(`  tierMatrixAAddr[0]: ${await tr.tierMatrixAAddr(0)}`);
  console.log(`  tierMatrixBAddr[0]: ${await tr.tierMatrixBAddr(0)}`);

  // PairManager addresses
  const pmAddr = addrs.tiers?.T1?.pm || addrs.T1?.pm;
  console.log(`\nPairManager (${pmAddr}):`);
  const matA = await pm.currentMatA().catch(e => `ERROR: ${e.message?.slice(0,60)}`);
  const matB = await pm.currentMatB().catch(e => `ERROR: ${e.message?.slice(0,60)}`);
  console.log(`  currentMatA(): ${matA}`);
  console.log(`  currentMatB(): ${matB}`);

  // Owner check
  const owner = await tr.owner();
  console.log(`\nTierRouter owner : ${owner}`);
  console.log(`Signer           : ${signer.address}`);
  console.log(owner.toLowerCase() === signer.address.toLowerCase() ? "✓ Match" : "✗ MISMATCH");

  // Try staticCall of setTierMatrices to see if it would revert
  if (matA && !matA.startsWith("ERROR") && matB && !matB.startsWith("ERROR")) {
    console.log(`\nTesting setTierMatrices via staticCall...`);
    try {
      await tr.setTierMatrices.staticCall(0, matA, matB);
      console.log("  staticCall PASSED — tx should work");
    } catch (e) {
      console.log(`  staticCall REVERTED: ${e.message?.slice(0, 200)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
