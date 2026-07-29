"use strict";
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
require("dotenv").config();
const BARBARA = "0x997b9a4f7c107b07ae5b5ab9ce19f6a8b728b4f6";
const ADDRS_FILE = path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json");
const TR_ABI = ["function globalJoined(address) view returns (bool)", "function memberHighestTier(address) view returns (uint8)"];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];
async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE));
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;
  const tr = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);
  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, provider);
  const [joined, highest, bal, allowance] = await Promise.all([
    tr.globalJoined(BARBARA), tr.memberHighestTier(BARBARA),
    usdc.balanceOf(BARBARA), usdc.allowance(BARBARA, addrs.tierRouter)
  ]);
  console.log(`Barbara (${BARBARA})`);
  console.log(`  globalJoined: ${joined}`);
  console.log(`  memberHighestTier: ${highest}`);
  console.log(`  USDC balance: $${(Number(bal)/1e6).toFixed(4)}`);
  console.log(`  USDC allowance to TierRouter: $${(Number(allowance)/1e6).toFixed(4)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
