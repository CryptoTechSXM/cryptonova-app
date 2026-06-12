"use strict";
/**
 * forcecross_f8.js — Force-cross stuck members to partner matrix
 * Used when members cycled out but had insufficient earnings to self-fund
 * This simulates the CW Protocol Reserve auto-fill mechanism
 */
const { ethers } = require("hardhat");

const MATRIX_A = "0x95590Ea97FBdc3b086EC18a1692bD607F4AB9641";
const MATRIX_B = "0x18A2ecef59CD76f9eC99b96f70a298b9f21b340B";
const USDC_ADDR = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const FEE = 10_000_000n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const matA = await ethers.getContractAt("FigureEightMatrix", MATRIX_A);
  const matB = await ethers.getContractAt("FigureEightMatrix", MATRIX_B);
  const usdc = await ethers.getContractAt("MockUSDC", USDC_ADDR);

  // Get all members who joined Matrix A but are NOT currently in any matrix
  const totalA = Number(await matA.totalMembers());
  console.log(`\nChecking ${totalA} Matrix A members for stuck crossings...`);

  const stuck = [];
  for (let i = 1; i <= 31; i++) {
    try {
      // posToMember only shows current — need to check by querying known addresses
      // Instead check Matrix B occupancy and find who should be there
    } catch(_) {}
  }

  // Simpler: just check if Matrix B has fewer members than expected
  const occB = await matB.occupancy();
  const totalB = await matB.totalMembers();
  console.log(`Matrix B: ${totalB} joined, ${occB} occupancy`);
  console.log(`Matrix A rotations: ${await matA.rotationCount()}`);

  // Find stuck members: joined Matrix A, not in Matrix A, not in Matrix B
  // We know wallet #1 is in Matrix B. Others who cycled out are stuck.
  // For this test, we'll force-cross the member at pos 1 of each cycle.

  // The deployer needs USDC to fund the crosses
  const needed = FEE * 15n; // fund 15 potential crosses
  await usdc.mint(deployer.address, needed);
  await usdc.approve(MATRIX_A, needed);
  console.log(`Funded ${ethers.formatUnits(needed, 6)} USDC for force-crosses`);

  // We need to find which members are stuck (cycled out of A, not in B)
  // Check all quickfill wallets - but we don't have their addresses
  // Instead, let's just check: all members who have cycles > 0 in A but aren't in B

  console.log("\nTo force-cross specific members, call:");
  console.log("matA.forceCross(memberAddress) for each stuck member");
  console.log("\nNote: This requires knowing stuck member addresses.");
  console.log("In production, keeper bot monitors and auto-crosses.");
}

main().catch(e => { console.error(e); process.exit(1); });
