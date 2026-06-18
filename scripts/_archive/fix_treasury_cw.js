/**
 * fix_treasury_cw.js
 * Sets the communityWallet on CNOVATreasury so redeemAtFloor() works.
 * Run: npx hardhat run scripts/fix_treasury_cw.js --network baseSepolia
 */
"use strict";
const { ethers } = require("hardhat");

const TREASURY         = "0x1a2cB8B61A22b9b4B572CE925d485CF25d2696F9";
const COMMUNITY_WALLET = "0x2C95F5c115864b155176F6E5fcfe0D2f9649464F";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const treasury = await ethers.getContractAt("CNOVATreasury", TREASURY);

  const current = await treasury.communityWallet();
  console.log("Current communityWallet:", current);

  if (current !== ethers.ZeroAddress) {
    console.log("Already set — nothing to do.");
    return;
  }

  const tx = await treasury.setCommunityWallet(COMMUNITY_WALLET);
  await tx.wait();
  console.log("Done! communityWallet set to:", COMMUNITY_WALLET);
}

main().catch(e => { console.error(e); process.exit(1); });
