"use strict";
/**
 * diag_lavern.js — diagnose why selfRescue fails for Lavern_Gay
 * Reports: parked state, shortfall, USDC balance, allowance, simulate tx
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const LAVERN = "0x728ff08035fffbc5a2f512a081cc88a4221f5f00";

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

const MAT_ABI = [
  "function isActiveInMatrix(address) view returns (bool)",
  "function hasEverJoined(address) view returns (bool)",
  "function parkedAt(address) view returns (uint256)",
  "function isParked(address) view returns (bool)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function entryFee() view returns (uint256)",
  "function selfRescue() external",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const TR_ABI = [
  "function globalJoined(address) view returns (bool)",
  "function memberHighestTier(address) view returns (uint8)",
];

async function checkWallet(label, wallet, addrs, provider) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}: ${wallet}`);
  console.log('='.repeat(60));

  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, provider);
  const tr   = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);

  const usdcBal = await usdc.balanceOf(wallet).catch(() => 0n);
  const joined  = await tr.globalJoined(wallet).catch(() => false);
  const highest = await tr.memberHighestTier(wallet).catch(() => 0);
  console.log(`globalJoined:      ${joined}`);
  console.log(`memberHighestTier: ${highest}`);
  console.log(`USDC balance:      $${(Number(usdcBal)/1e6).toFixed(6)}`);

  if (!joined) { console.log("→ Not a member — skip matrix checks."); return; }

  // Check all matrices across all tiers
  const tiers = Object.entries(addrs.tiers); // [["T1", {matA, matB}], ...]
  let foundParked = false;

  for (const [tier, addrsT] of tiers) {
    const matrices = [];
    if (addrsT.matA) matrices.push({ label: `${tier} MatA`, addr: addrsT.matA });
    if (addrsT.matB) matrices.push({ label: `${tier} MatB`, addr: addrsT.matB });
    // Handle multi-pair (matA2, matB2, etc.)
    for (let i = 2; i <= 5; i++) {
      if (addrsT[`matA${i}`]) matrices.push({ label: `${tier} MatA${i}`, addr: addrsT[`matA${i}`] });
      if (addrsT[`matB${i}`]) matrices.push({ label: `${tier} MatB${i}`, addr: addrsT[`matB${i}`] });
    }

    for (const m of matrices) {
      const mc = new ethers.Contract(m.addr, MAT_ABI, provider);
      const [everJoined, inMatrix, parkedAt, isParked] = await Promise.all([
        mc.hasEverJoined(wallet).catch(() => false),
        mc.isActiveInMatrix(wallet).catch(() => false),
        mc.parkedAt(wallet).catch(() => 0n),
        mc.isParked(wallet).catch(() => false),
      ]);
      if (!everJoined) continue;

      const withdrawable = await mc.withdrawableOf(wallet).catch(() => 0n);
      const reserve      = await mc.crossingReserveOf(wallet).catch(() => 0n);
      const fee          = await mc.entryFee().catch(() => 0n);
      const effective    = withdrawable + reserve;
      const shortfall    = fee > effective ? fee - effective : 0n;
      const allowance    = await usdc.allowance(wallet, m.addr).catch(() => 0n);

      console.log(`\n  [${m.label}] ${m.addr}`);
      console.log(`    hasEverJoined: ${everJoined}`);
      console.log(`    isActiveInMatrix: ${inMatrix}`);
      console.log(`    parkedAt: ${parkedAt}  isParked: ${isParked}`);
      console.log(`    withdrawable:   $${(Number(withdrawable)/1e6).toFixed(4)}`);
      console.log(`    crossingReserve:$${(Number(reserve)/1e6).toFixed(4)}`);
      console.log(`    entryFee:       $${(Number(fee)/1e6).toFixed(4)}`);
      console.log(`    shortfall:      $${(Number(shortfall)/1e6).toFixed(4)}`);
      console.log(`    USDC allowance to matrix: $${(Number(allowance)/1e6).toFixed(4)}`);

      if (isParked || parkedAt > 0n) {
        foundParked = true;
        console.log(`\n  *** PARKED HERE — simulating selfRescue() ***`);
        const iface = new ethers.Interface(["function selfRescue() external"]);
        const calldata = iface.encodeFunctionData("selfRescue", []);
        try {
          await provider.call({ from: wallet, to: m.addr, data: calldata });
          console.log("  ✓ selfRescue static call SUCCEEDED — tx should work");
        } catch (e) {
          console.log(`  ✗ selfRescue REVERTS: ${e.reason || e.data || e.message}`);
          if (e.data) {
            // Try to decode ERC20 custom errors
            const erc20iface = new ethers.Interface([
              "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
              "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
            ]);
            try {
              const decoded = erc20iface.parseError(e.data);
              console.log(`     Custom error: ${decoded?.name}`, decoded?.args);
            } catch (_) {}
          }
          // Root cause summary
          if (shortfall > 0n && usdcBal < shortfall) {
            console.log(`  ROOT CAUSE: insufficient USDC — needs $${(Number(shortfall)/1e6).toFixed(2)}, has $${(Number(usdcBal)/1e6).toFixed(2)}`);
          } else if (shortfall > 0n && allowance < shortfall) {
            console.log(`  ROOT CAUSE: USDC not approved to matrix — needs $${(Number(shortfall)/1e6).toFixed(2)}, approved $${(Number(allowance)/1e6).toFixed(2)}`);
          }
        }
      }
    }
  }

  if (!foundParked) {
    console.log("\n  → Not parked in any matrix.");
  }
}

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;

  console.log("=== Lavern_Gay Self-Rescue Diagnostic ===");
  console.log(`Addresses file: ${ADDRESSES_FILE}`);

  // Check the reported wallet
  await checkWallet("Lavern primary", LAVERN, addrs, provider);

  console.log("\n\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
