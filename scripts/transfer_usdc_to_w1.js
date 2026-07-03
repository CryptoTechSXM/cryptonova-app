"use strict";
/**
 * transfer_usdc_to_w1.js — One-shot: transfer $10 USDC from deployer to W1
 *
 * Use when deployer has USDC (e.g. received from faucet) but can't mint
 * because the MockUSDC owner is a different wallet.
 *
 * Run:
 *   npx hardhat run scripts/transfer_usdc_to_w1.js --network baseSepolia
 */
const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_31.json"
);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [rawSigner]  = await ethers.getSigners();
  const deployer     = new NonceManager(rawSigner);
  const deployerAddr = rawSigner.address;

  const W1_ADDR  = addrs.accountOne;
  const USDC_ADDR = addrs.usdc;

  console.log(`Deployer : ${deployerAddr}`);
  console.log(`W1       : ${W1_ADDR}`);
  console.log(`USDC     : ${USDC_ADDR}`);

  const usdc    = new ethers.Contract(USDC_ADDR, ERC20_ABI, deployer);
  const T1_FEE  = 10_000_000n;  // $10 in 6-decimal USDC

  const deployerBal = await usdc.balanceOf(deployerAddr);
  const w1Bal       = await usdc.balanceOf(W1_ADDR);

  console.log(`\nDeployer USDC : $${(Number(deployerBal) / 1e6).toFixed(2)}`);
  console.log(`W1 USDC       : $${(Number(w1Bal) / 1e6).toFixed(2)}`);

  if (w1Bal >= T1_FEE) {
    console.log("\n✓  W1 already has enough USDC — nothing to transfer.");
    return;
  }

  const needed = T1_FEE - w1Bal;
  if (deployerBal < needed) {
    console.error(`\n❌  Deployer only has $${(Number(deployerBal) / 1e6).toFixed(2)} USDC`);
    console.error(`    Need $${(Number(needed) / 1e6).toFixed(2)} more.`);
    console.error(`    Get USDC from the testnet faucet at v8.crypto-nova.app`);
    console.error(`    and send it to the deployer: ${deployerAddr}`);
    process.exit(1);
  }

  console.log(`\n── Transferring $${(Number(needed) / 1e6).toFixed(2)} USDC to W1…`);
  const tx = await usdc.transfer(W1_ADDR, needed);
  await tx.wait();
  console.log(`   ✓  Transferred  tx: ${tx.hash}`);

  const w1BalAfter = await usdc.balanceOf(W1_ADDR);
  console.log(`\n   W1 USDC after : $${(Number(w1BalAfter) / 1e6).toFixed(2)}`);
  console.log(`\n  Next: npx hardhat run scripts/seed_w1.js --network baseSepolia`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
