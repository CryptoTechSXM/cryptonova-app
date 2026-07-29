"use strict";
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

async function main() {
  const TX = "0x98725410f635a4070db68aa8c5fbef507e4289e850f02a416745b5bd67f07afc";
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [owner] = await ethers.getSigners();
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter, owner);

  const receipt = await ethers.provider.getTransactionReceipt(TX);
  console.log(`tx status : ${receipt?.status} ${receipt?.status===1?"(SUCCESS)":"(REVERTED)"}`);
  console.log(`gasUsed   : ${receipt?.gasUsed}`);

  const val = await tr.tierWhaleGateActive(5);
  console.log(`\ntierWhaleGateActive[5] (fresh read): ${val}`);

  try {
    await tr.setTierWhaleGateActive.staticCall(5, true);
    console.log("staticCall setTierWhaleGateActive(5,true): PASSED");
  } catch(e) {
    console.log("staticCall FAILED:", e.message?.slice(0,200));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
