"use strict";
/**
 * simulate_upgrade.js — simulate manualUpgrade(1) from W1's actual signer
 *
 * Uses W1_PRIVATE_KEY from .env so staticCall runs as W1 (not a Hardhat impersonation).
 * This gives the real revert reason if the upgrade would fail.
 *
 * Run:
 *   npx hardhat run scripts/simulate_upgrade.js --network baseSepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

const MATRIX_ABI = [
  "function isActiveInMatrix(address) view returns (bool)",
];

async function main() {
  const addrs  = require("./deployed_addresses_v8_12.json");
  const W1_KEY = process.env.W1_PRIVATE_KEY;
  if (!W1_KEY) { console.error("W1_PRIVATE_KEY not in .env"); process.exit(1); }

  const provider = ethers.provider;
  const w1       = new ethers.Wallet(W1_KEY, provider);
  const W1_ADDR  = w1.address;

  console.log("W1:", W1_ADDR);
  console.log("TierRouter:", addrs.tierRouter);

  const tr   = await ethers.getContractAt("TierRouter",          addrs.tierRouter, w1);
  const usdc = await ethers.getContractAt("MockUSDC",            addrs.usdc);
  const matB = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matB);

  // ── State recap ──
  const joined    = await tr.globalJoined(W1_ADDR);
  const cycles    = await tr.tierCycles(W1_ADDR, 0);
  const fee       = await tr.tierEntryFees(1);
  const inMatB    = await matB.isActiveInMatrix(W1_ADDR);
  const gates     = await tr.getVelocityGates();
  const paused    = await tr.systemPaused();
  const bal       = await usdc.balanceOf(W1_ADDR);
  const allowance = await usdc.allowance(W1_ADDR, addrs.tierRouter);

  console.log("\n── State recap ──");
  console.log("globalJoined:    ", joined);
  console.log("T1 cycles:       ", cycles.toString());
  console.log("inT1MatB:        ", inMatB);
  console.log("T2 entry fee:    $" + Number(fee) / 1e6);
  console.log("T2 gate open:    ", gates[1]);
  console.log("systemPaused:    ", paused);
  console.log("USDC balance:    $" + Number(bal) / 1e6);
  console.log("USDC allowance:  $" + Number(allowance) / 1e6);

  const eligible = (Number(cycles) >= 1 || inMatB);
  console.log("Eligible:        ", eligible);

  if (!eligible) {
    console.log("\n❌ Would revert: TR: cross to MatB first to unlock upgrade");
    return;
  }
  if (Number(allowance) < Number(fee)) {
    console.log("\n❌ Insufficient allowance — approve $" + Number(fee)/1e6 + " first");
    return;
  }

  // ── staticCall from W1's actual signer ──
  console.log("\n── staticCall manualUpgrade(1) as W1 ──");
  try {
    await tr.manualUpgrade.staticCall(1);
    console.log("✅ PASSED — manualUpgrade(1) will succeed on-chain");
    console.log("   The upgrade button should work. If the frontend shows an error,");
    console.log("   check: MetaMask gas estimation, network (Base Sepolia), or USDC allowance step.");
  } catch (e) {
    const reason = e.reason || e.shortMessage || e.message;
    console.log("❌ REVERTED:", reason);
    if (e.data) console.log("   Error data:", e.data);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
