/**
 * fix_velocity_t3.js — set tierVelocityGreen[2] = true on TierRouter
 * Run after add_tier.js crashes on the velocity step.
 *
 *   npx hardhat run scripts/fix_velocity_t3.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const saved = JSON.parse(
    fs.readFileSync(path.join(__dirname, "deployed_addresses_v8_5.json"), "utf8")
  );

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer    : ${deployer.address}`);
  console.log(`TierRouter  : ${saved.tierRouter}`);

  const tr = await ethers.getContractAt("TierRouter", saved.tierRouter, deployer);

  // Check current state first
  let already = false;
  try {
    already = await tr.tierVelocityGreen(2);
  } catch(_) {}

  if (already) {
    console.log("tierVelocityGreen[2] already true -- nothing to do.");
    return;
  }

  console.log("Setting tierVelocityGreen[2] = true ...");
  await (await tr.setTierVelocityGreen(2, true)).wait();
  console.log("OK  tierVelocityGreen[2] = true  (T3 open for upgrades)");
}

main().catch(e => { console.error(e); process.exit(1); });
