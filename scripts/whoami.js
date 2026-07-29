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
const { ethers } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = signer.address;
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
