"use strict";
/**
 * check_state.js  — quick snapshot of all matrix pairs + W1 location
 *
 * Run:
 *   npx hardhat run scripts/check_state.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

const fmt6 = n => "$" + (Number(n) / 1e6).toFixed(2);

async function matrixRow(label, contract, usdc) {
  const [occ, rot, pool, bal] = await Promise.all([
    contract.occupancy(),
    contract.rotationCount(),
    contract.poolAccumulator(),
    usdc.balanceOf(await contract.getAddress()),
  ]);
  const parked = await contract.getParkedCount().catch(() => 0n);
  return `  ${label.padEnd(16)} occ=${String(occ).padStart(3)}/127  rot=${rot}  parked=${parked}  pool=${fmt6(pool)}  USDC=${fmt6(bal)}`;
}

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const usdc  = await ethers.getContractAt("MockUSDC", addrs.usdc || addrs.USDC);

  // ── Build tier map ────────────────────────────────────────────────────────
  const tierMap = {};
  if (addrs.tiers) {
    for (const [tier, data] of Object.entries(addrs.tiers)) {
      if (data.pairs)      tierMap[tier] = data.pairs;
      else if (data.matA)  tierMap[tier] = [{ matA: data.matA, matB: data.matB }];
    }
  } else {
    for (const key of Object.keys(addrs)) {
      if (/^T\d+$/.test(key) && addrs[key]?.matA) {
        tierMap[key] = [{ matA: addrs[key].matA, matB: addrs[key].matB }];
      }
    }
  }

  console.log("\n════ Matrix State Snapshot ════\n");

  for (const [tier, pairs] of Object.entries(tierMap).sort()) {
    for (let p = 0; p < pairs.length; p++) {
      const { matA, matB } = pairs[p];
      const pairLabel = pairs.length > 1 ? `${tier}.${p + 1}` : tier;
      try {
        const cA = await ethers.getContractAt("FigureEightMatrixV8", matA);
        const cB = await ethers.getContractAt("FigureEightMatrixV8", matB);
        console.log(`${pairLabel}:`);
        console.log(await matrixRow("MatA", cA, usdc));
        console.log(await matrixRow("MatB", cB, usdc));
      } catch (e) {
        console.log(`${pairLabel}: ERROR — ${e.message?.slice(0, 80)}`);
      }
    }
  }

  // ── W1 location ──────────────────────────────────────────────────────────
  const W1_ADDR = process.env.W1_ADDR || addrs.w1 || addrs.W1;
  if (W1_ADDR) {
    console.log(`\n════ W1 (${W1_ADDR.slice(0, 10)}…) ════\n`);
    for (const [tier, pairs] of Object.entries(tierMap).sort()) {
      for (let p = 0; p < pairs.length; p++) {
        const { matA, matB } = pairs[p];
        const pairLabel = pairs.length > 1 ? `${tier}.${p + 1}` : tier;
        try {
          const cA = await ethers.getContractAt("FigureEightMatrixV8", matA);
          const cB = await ethers.getContractAt("FigureEightMatrixV8", matB);
          const [mA, mB] = await Promise.all([cA.getMember(W1_ADDR), cB.getMember(W1_ADDR)]);
          if (mA.hasEverJoined) {
            console.log(`  ${pairLabel} MatA: inMatrix=${mA.isInMatrix}  cycles=${mA.cyclesCompleted}  withdrawable=${fmt6(mA.withdrawable)}  crossReserve=${fmt6(mA.crossingReserve)}`);
          }
          if (mB.hasEverJoined) {
            console.log(`  ${pairLabel} MatB: inMatrix=${mB.isInMatrix}  cycles=${mB.cyclesCompleted}  withdrawable=${fmt6(mB.withdrawable)}  crossReserve=${fmt6(mB.crossingReserve)}`);
          }
        } catch {}
      }
    }
    if (addrs.tierRouter) {
      try {
        const tr   = await ethers.getContractAt("TierRouter", addrs.tierRouter);
        const info = await tr.getMemberInfo(W1_ADDR).catch(() => null);
        if (info) console.log(`  TierRouter: currentTier=${info.currentTier}  totalCycles=${info.totalCycles}`);
      } catch {}
    }
  } else {
    console.log("\n(tip: set W1_ADDR=0x… env var to see W1 location across all matrices)");
  }

  // ── SF + Treasury balances ────────────────────────────────────────────────
  console.log("\n════ SF / Treasury ════\n");
  const sfAddr = addrs.stabilityFund;
  const trAddr = addrs.treasury || addrs.CNOVATreasury;
  if (sfAddr) console.log(`  SF       : ${fmt6(await usdc.balanceOf(sfAddr))}`);
  if (trAddr) console.log(`  Treasury : ${fmt6(await usdc.balanceOf(trAddr))}`);

  console.log("\n════ DONE ════");
}

main().catch(e => { console.error(e); process.exit(1); });
