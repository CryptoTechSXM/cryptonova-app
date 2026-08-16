"use strict";
/**
 * whoami.js — print the signer hardhat will use for deploys/admin calls,
 * plus its EIP-7702 delegation status. Run BEFORE every deploy:
 *   npx hardhat run scripts/whoami.js --network baseSepolia
 *
 * Optional .env: EXPECTED_DEPLOYER=0x... → exits 1 on mismatch.
 * Owner decision 2026-07-25: active TESTNET deployer is 0xCd0Af6… (owns
 * MockUSDC; 7702-delegated to MetaMask stateless delegator — accepted risk).
 * MAINNET: fresh, never-delegated deployer required.
 */
const hre = require("hardhat");
const { ethers } = hre;

// 2026-08-16: the same trap that made check_nonce.js report Hardhat account #0
// as "the deployer" three times immediately before a live deploy. Without
// --network, hardhat uses its in-memory chain and getSigners() returns the
// built-in test accounts. This file is PARTLY protected by EXPECTED_DEPLOYER —
// but only when that var is set; unset, it would print a fake signer and then
// "✅ Signer matches expectation — safe to proceed."
// A pre-deploy identity check must never be able to bless the wrong chain.
if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
  console.error("");
  console.error("  REFUSING TO ANSWER.");
  console.error(`  Network is '${hre.network.name}' — hardhat's in-memory chain.`);
  console.error("  getSigners() returns built-in test accounts here, so the signer");
  console.error("  reported would not be the one that signs your deploy.");
  console.error("");
  console.error("    npx hardhat run scripts/whoami.js --network baseSepolia");
  console.error("");
  process.exit(1);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = signer.address;
  console.log("Network:", hre.network.name);
  const [bal, code] = await Promise.all([
    ethers.provider.getBalance(addr),
    ethers.provider.getCode(addr),
  ]);
  console.log("Signer :", addr);
  console.log("ETH    :", ethers.formatEther(bal));
  if (code.startsWith("0xef0100")) {
    console.log("7702   : delegated to 0x" + code.slice(8), "(testnet-accepted; NEVER for mainnet)");
  } else if (code === "0x") {
    console.log("7702   : clean EOA (no delegation)");
  } else {
    console.log("7702   : ⚠️ address has contract code?!", code.slice(0, 20) + "…");
  }
  const expected = (process.env.EXPECTED_DEPLOYER || "").toLowerCase();
  if (expected && addr.toLowerCase() !== expected) {
    console.log(`❌ Signer != EXPECTED_DEPLOYER (${process.env.EXPECTED_DEPLOYER}) — fix .env.`);
    process.exit(1);
  }
  console.log("✅ Signer matches expectation — safe to proceed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
