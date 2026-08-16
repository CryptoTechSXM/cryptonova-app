"use strict";
const hre = require("hardhat");
const { ethers } = hre;
require("dotenv").config();

// ── 2026-08-16: THIS SCRIPT GAVE A CONFIDENT, PLAUSIBLE, WRONG ANSWER ───────
// Run as `node scripts/check_nonce.js` — no --network — hardhat falls back to
// its IN-MEMORY chain, ethers.getSigners() returns the well-known test
// accounts, and this printed:
//     Deployer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
//     Confirmed nonce: 0   Pending nonce: 0   Stuck txs: 0
// That is Hardhat account #0 on a chain that does not exist. It was run three
// times, immediately before a live deploy, to establish that the real deployer
// key was quiet. It established nothing — and it looked exactly like success.
//
// A diagnostic that answers about the wrong chain is worse than one that
// errors: you run it precisely because you do not already know the answer, so
// there is nothing to check the plausible-looking output against.
// Same family as the empty-catch and stale-ADDRESSES_FILE traps in CLAUDE.md.
if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
  console.error("");
  console.error("  REFUSING TO ANSWER.");
  console.error(`  Network is '${hre.network.name}' — hardhat's in-memory chain, not a live one.`);
  console.error("  getSigners() here returns Hardhat's built-in test accounts, so any nonce");
  console.error("  printed would describe a wallet you do not use, on a chain that does not exist.");
  console.error("");
  console.error("  Run it against the real network:");
  console.error("    npx hardhat run scripts/check_nonce.js --network baseSepolia");
  console.error("");
  process.exit(1);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const confirmed = await ethers.provider.getTransactionCount(deployer.address, "latest");
  const pending   = await ethers.provider.getTransactionCount(deployer.address, "pending");
  console.log(`\n  Network:  ${hre.network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Confirmed nonce: ${confirmed}`);
  console.log(`  Pending nonce:   ${pending}`);
  console.log(`  Stuck txs:       ${pending - confirmed}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
