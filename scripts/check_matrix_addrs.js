// check_matrix_addrs.js — reads TierRouter public arrays for T1-T4 matrix addresses
const hre = require("hardhat");
const { ethers } = hre;

const TIER_ROUTER = "0xd2290Aa027e4570D354F9E6327372D095CBB2a34"; // V8.27

const ABI = [
  "function tierMatrixAAddr(uint256 index) external view returns (address)",
  "function tierMatrixBAddr(uint256 index) external view returns (address)",
];

async function main() {
  const tr = new ethers.Contract(TIER_ROUTER, ABI, hre.ethers.provider);
  console.log("\n-- V8.27 Matrix Addresses (from TierRouter) --");
  for (let i = 0; i < 4; i++) {
    try {
      const matA = await tr.tierMatrixAAddr(i);
      const matB = await tr.tierMatrixBAddr(i);
      console.log("T" + (i+1) + " matA:", matA);
      console.log("T" + (i+1) + " matB:", matB);
    } catch(e) { console.log("T" + (i+1) + ": (not registered)"); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
