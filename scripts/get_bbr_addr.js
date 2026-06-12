// get_bbr_addr.js — queries T1 MatA to recover the CNOVABuybackReserve address
// Run: npx hardhat run scripts/get_bbr_addr.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const fs   = require("fs");

const ADDRS_FILE = path.join(__dirname, "deployed_addresses_v8_7.json");
const MAT_A_ABI  = ["function buybackReserve() external view returns (address)"];

async function main() {
  const addrs  = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  const matA   = new ethers.Contract(addrs.tiers.T1.matA, MAT_A_ABI, ethers.provider);
  const bbrAddr = await matA.buybackReserve();
  console.log("CNOVABuybackReserve:", bbrAddr);

  // Patch the addresses file
  addrs.buybackReserve = bbrAddr;
  fs.writeFileSync(ADDRS_FILE, JSON.stringify(addrs, null, 2));
  console.log("✓ deployed_addresses_v8_7.json updated with buybackReserve");
}

main().catch(console.error);
