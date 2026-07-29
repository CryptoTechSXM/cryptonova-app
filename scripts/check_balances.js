"use strict";
/**
 * check_balances.js — Quick pre-bigfill wallet health check
 *
 * Reads FILL_FUNDER_KEY from .env, reports ETH + USDC balance,
 * and advises whether you have enough to run bigfill for COUNT wallets.
 *
 * Run: npx hardhat run scripts/check_balances.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const key = process.env.FILL_FUNDER_KEY;
  if (!key) throw new Error("FILL_FUNDER_KEY not set in .env");

  const addrFile = path.join(
    __dirname,
    process.env.ADDRESSES_FILE || "deployed_addresses_v8_33.json"
  );
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8"));

  const funder = new ethers.Wallet(key, ethers.provider);
  const usdc   = await ethers.getContractAt("MockUSDC", addrs.usdc || addrs.USDC);

  const [ethBal, usdcBal] = await Promise.all([
    ethers.provider.getBalance(funder.address),
    usdc.balanceOf(funder.address),
  ]);

  const COUNT        = Number(process.env.COUNT || 127);
  const FUND_USDC    = Number(process.env.FUND_AMOUNT_USDC || 100); // default $100/wallet
  const ethNeeded    = COUNT * 0.02;
  const usdcNeeded   = COUNT * FUND_USDC;
  const ethHave      = Number(ethers.formatEther(ethBal));
  const usdcHave     = Number(usdcBal) / 1e6;

  console.log(`\n  ── Balance Check ──────────────────────────────────────────`);
  console.log(`  FILL_FUNDER: ${funder.address}`);
  console.log(`  ETH:         ${ethHave.toFixed(4)} ETH`);
  console.log(`  USDC:        $${usdcHave.toFixed(2)}`);
  console.log(`\n  ── Bigfill requirements (COUNT=${COUNT}, $${FUND_USDC}/wallet) ─`);
  console.log(`  ETH needed:  ~${ethNeeded.toFixed(2)} ETH   ${ethHave >= ethNeeded ? "✅ OK" : "⚠️  NEED MORE"}`);
  console.log(`  USDC needed: ~$${usdcNeeded.toFixed(0)}    ${usdcHave >= usdcNeeded ? "✅ OK" : "⚠️  NEED MORE"}`);
  console.log();

  if (ethHave < ethNeeded || usdcHave < usdcNeeded) {
    console.log(`  💡 To reduce USDC needed: set FUND_AMOUNT_USDC=15 (T1-only run, $15/wallet)`);
    console.log(`     That would need: $${(COUNT * 15).toFixed(0)} USDC for COUNT=${COUNT}`);
  }

  // Also show deployer balance (useful to know)
  const [dep] = await ethers.getSigners();
  const depEth = await ethers.provider.getBalance(dep.address);
  console.log(`  ── Deployer ────────────────────────────────────────────────`);
  console.log(`  ${dep.address}   ETH: ${Number(ethers.formatEther(depEth)).toFixed(4)}`);
  console.log();
}

main().catch(e => { console.error("\n  ❌", e.message); process.exit(1); });
