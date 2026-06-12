/**
 * mint_usdc.js
 * Mints 200,000 USDC to every address in the RECIPIENTS list.
 * Run: npx hardhat run scripts/mint_usdc.js --network baseSepolia
 */

"use strict";

const { ethers } = require("hardhat");

const USDC_ADDRESS = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const AMOUNT       = 200_000n * 1_000_000n; // 200,000 USDC (6 decimals)

// ── Add any addresses that need USDC here ──────────────────────
const RECIPIENTS = [
  "0xCd0Af6a4116f2062c1594aDf34c1821D45175506", // deployer / admin
  // "0xABCD...", // add more as needed
];
// ───────────────────────────────────────────────────────────────

const ABI = ["function mint(address to, uint256 amount) external",
             "function balanceOf(address) view returns (uint256)"];

async function main() {
  const [deployer] = await ethers.getSigners();
  const usdc = new ethers.Contract(USDC_ADDRESS, ABI, deployer);

  console.log(`\nMinting $200,000 USDC to ${RECIPIENTS.length} address(es)...`);
  console.log(`Deployer: ${deployer.address}\n`);

  for (const addr of RECIPIENTS) {
    const before = await usdc.balanceOf(addr);
    const tx = await usdc.mint(addr, AMOUNT);
    await tx.wait();
    const after = await usdc.balanceOf(addr);
    console.log(`✓ ${addr}`);
    console.log(`  Before : $${(Number(before) / 1e6).toFixed(2)}`);
    console.log(`  After  : $${(Number(after)  / 1e6).toFixed(2)}\n`);
  }

  console.log("Done!");
}

main().catch(e => { console.error(e); process.exit(1); });
