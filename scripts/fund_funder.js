"use strict";
/**
 * fund_funder.js — one-time setup for bigfill fresh funder wallet
 *
 * The main deployer is rate-limited to ~1 in-flight TX at a time on Base Sepolia
 * after accumulating a high nonce.  This script burns those two slots once:
 *   TX1: deployer → funder  (ETH top-up)
 *   TX2: deployer → usdc.mint(funder, BULK)  (USDC bulk mint)
 *
 * After this runs, bigfill_v8.js uses funder.transfer() for USDC distribution
 * and funder.sendTransaction() for ETH sends — deployer never touched in the loop.
 *
 * Usage: npx hardhat run scripts/fund_funder.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs          = require("fs");
const path        = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_11.json");
const ETH_AMOUNT     = ethers.parseEther("10");       // 10 ETH to funder
const USDC_AMOUNT    = 2_000_000n * 1_000_000n;       // $2,000,000 USDC (6 decimals) — enough for 200,000 registrations
const COOLDOWN       = 180;                           // seconds between deployer TXs

const sleep = s => new Promise(r => setTimeout(r, s * 1000));

async function main() {
  const signers     = await ethers.getSigners();
  const rawDeployer = signers[0];
  const rawFunder   = signers[1];

  if (!rawFunder || rawFunder.address === rawDeployer.address) {
    console.error("❌  FILL_FUNDER_KEY not set in .env / hardhat.config.js. Cannot proceed.");
    process.exit(1);
  }

  const deployerAddr = rawDeployer.address;
  const funderAddr   = rawFunder.address;

  const addrs    = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const usdcAddr = addrs.usdc || addrs.USDC;
  const usdc     = await ethers.getContractAt("MockUSDC", usdcAddr, rawDeployer);

  const deployerEth  = await ethers.provider.getBalance(deployerAddr);
  const funderEth    = await ethers.provider.getBalance(funderAddr);
  const funderUsdc   = await usdc.balanceOf(funderAddr);

  console.log(`\nDeployer: ${deployerAddr}  (${ethers.formatEther(deployerEth)} ETH)`);
  console.log(`Funder:   ${funderAddr}  (${ethers.formatEther(funderEth)} ETH, $${Number(funderUsdc)/1e6} USDC)`);

  // ── TX1: ETH top-up ───────────────────────────────────────────────────────
  if (funderEth >= ethers.parseEther("5")) {
    console.log(`\n✓ Funder already has ${ethers.formatEther(funderEth)} ETH — skipping ETH top-up`);
  } else {
    console.log(`\nTX1: Sending ${ethers.formatEther(ETH_AMOUNT)} ETH to funder…`);
    try {
      const tx = await rawDeployer.sendTransaction({ to: funderAddr, value: ETH_AMOUNT });
      console.log(`  tx: ${tx.hash}`);
      await tx.wait();
      console.log(`  ✓ ETH delivered`);
      const newBal = await ethers.provider.getBalance(funderAddr);
      console.log(`  Funder ETH: ${ethers.formatEther(newBal)}`);
    } catch(e) {
      console.error(`  ❌ ETH send failed: ${e.message.slice(0,120)}`);
      console.error(`     Deployer may still be in rate-limit cooldown. Wait a few minutes and retry.`);
      process.exit(1);
    }
    console.log(`\n⏳ Waiting ${COOLDOWN}s for deployer rate-limit cooldown before TX2…`);
    await sleep(COOLDOWN);
  }

  // ── TX2: Bulk USDC mint to funder ─────────────────────────────────────────
  if (funderUsdc >= USDC_AMOUNT / 2n) {
    console.log(`✓ Funder already has $${Number(funderUsdc)/1e6} USDC — skipping mint`);
  } else {
    console.log(`TX2: Minting $${Number(USDC_AMOUNT)/1e6} USDC to funder…`);
    try {
      const tx = await usdc.mint(funderAddr, USDC_AMOUNT);
      console.log(`  tx: ${tx.hash}`);
      await tx.wait();
      const newUsdc = await usdc.balanceOf(funderAddr);
      console.log(`  ✓ USDC delivered — funder now has $${Number(newUsdc)/1e6}`);
    } catch(e) {
      console.error(`  ❌ USDC mint failed: ${e.message.slice(0,120)}`);
      console.error(`     Deployer still rate-limited. Run this script again in a few minutes.`);
      process.exit(1);
    }
  }

  console.log(`\n✓ Funder fully loaded. Run bigfill_v8.js — deployer no longer needed in the loop.`);
}

main().catch(e => { console.error(e); process.exit(1); });
