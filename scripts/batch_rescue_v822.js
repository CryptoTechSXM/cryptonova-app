"use strict";
/**
 * batch_rescue_v822.js — Deployer-funded topUpAndCross for all T1 parked wallets
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses topUpAndCross() on T1 MatA to rescue every parked member.
 * The deployer covers the shortfall for each member (withdrawable < $10).
 *
 * Run:
 *   npx hardhat run scripts/batch_rescue_v822.js --network baseSepolia
 *
 * Optional env overrides:
 *   DRY_RUN=true   (read-only — shows plan without sending any TXs)
 *   ADDRESSES_FILE=deployed_addresses_v8_22.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(
  __dirname,
  "..",
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_22.json"
);
const DRY_RUN = (process.env.DRY_RUN || "false") === "true";

// ── ABIs ──────────────────────────────────────────────────────────────────────
const MAT_ABI = [
  "function getParkedCount() external view returns (uint256)",
  "function getParkedMember(uint256 idx) external view returns (address)",
  "function isParked(address) external view returns (bool)",
  "function withdrawableOf(address) external view returns (uint256)",
  "function topUpAndCross(address member) external",
  "function ENTRY_FEE() external view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt6  = n  => "$" + (Number(n) / 1e6).toFixed(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sep(label = "") {
  const line = "─".repeat(60);
  console.log(label ? `\n${line}\n  ${label}\n${line}` : line);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) throw new Error(`Addresses file not found: ${ADDRESSES_FILE}`);

  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const matAAddr = addrs.tiers.T1.matA;
  const usdcAddr = addrs.usdc;

  const matA = new ethers.Contract(matAAddr, MAT_ABI, deployer);
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, deployer);

  sep("BATCH RESCUE — V8.22 T1 MatA");
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  T1 MatA  : ${matAAddr}`);
  console.log(`  USDC     : ${usdcAddr}`);
  console.log(`  Mode     : ${DRY_RUN ? "DRY RUN (no TXs)" : "LIVE"}`);
  console.log();

  // ── Read parked queue ──────────────────────────────────────────────────────
  const parkedCount = await matA.getParkedCount();
  console.log(`  Parked members on-chain: ${parkedCount}`);

  if (parkedCount === 0n) {
    console.log("  Nothing to rescue. Exiting.");
    return;
  }

  const entryFee = await matA.ENTRY_FEE();
  console.log(`  Entry fee: ${fmt6(entryFee)}`);

  // Collect full parked list
  const parkedList = [];
  for (let i = 0; i < Number(parkedCount); i++) {
    parkedList.push(await matA.getParkedMember(i));
  }

  // ── Compute shortfalls ────────────────────────────────────────────────────
  sep("Shortfall scan");
  let totalNeeded = 0n;
  const members = [];

  for (const addr of parkedList) {
    const withdrawable = await matA.withdrawableOf(addr);
    const shortfall    = withdrawable >= entryFee ? 0n : entryFee - withdrawable;
    totalNeeded += shortfall;
    members.push({ addr, withdrawable, shortfall });
    console.log(`  ${addr}  withdrawable=${fmt6(withdrawable)}  shortfall=${fmt6(shortfall)}`);
  }

  console.log();
  console.log(`  Total parked  : ${members.length}`);
  console.log(`  USDC needed   : ${fmt6(totalNeeded)}`);

  // ── Check deployer USDC balance ───────────────────────────────────────────
  const deployerBal = await usdc.balanceOf(deployer.address);
  console.log(`  Deployer bal  : ${fmt6(deployerBal)}`);

  if (deployerBal < totalNeeded) {
    throw new Error(`Insufficient deployer USDC. Need ${fmt6(totalNeeded)}, have ${fmt6(deployerBal)}`);
  }

  if (DRY_RUN) {
    sep("DRY RUN complete — no TXs sent");
    console.log(`  Would rescue ${members.length} members for ${fmt6(totalNeeded)} USDC`);
    return;
  }

  // ── Approve USDC (must happen BEFORE estimateGas so simulation sees allowance) ─
  sep("Approving USDC");
  const currentAllowance = await usdc.allowance(deployer.address, matAAddr);
  if (currentAllowance < totalNeeded) {
    console.log(`  Approving ${fmt6(totalNeeded)} USDC for T1 MatA...`);
    const approveTx = await usdc.approve(matAAddr, totalNeeded, { gasLimit: 100_000 });
    console.log(`  Approve TX: ${approveTx.hash}`);
    const receipt = await approveTx.wait();
    console.log(`  ✅ Approved (block ${receipt.blockNumber})`);
    console.log(`  Waiting 5s for RPC to settle...`);
    await sleep(5000);
  } else {
    console.log(`  ✅ Allowance already sufficient (${fmt6(currentAllowance)})`);
  }

  // ── Gas estimate + revert diagnostic ─────────────────────────────────────
  sep("Gas estimate (member [1])");
  let gasEstimate = 1_500_000n; // safe fallback
  try {
    gasEstimate = await matA.topUpAndCross.estimateGas(members[0].addr);
    const gasWithBuffer = gasEstimate * 130n / 100n; // +30% buffer
    console.log(`  Estimated gas : ${gasEstimate.toLocaleString()}`);
    console.log(`  With +30% buf : ${gasWithBuffer.toLocaleString()}`);
    gasEstimate = gasWithBuffer;
  } catch (e) {
    console.log(`  estimateGas REVERTED (allowance is set — this is a contract revert):`);
    console.log(`    reason  : ${e.reason ?? "null"}`);
    console.log(`    data    : ${e.data ?? "null"}`);
    console.log(`    message : ${e.message?.slice(0, 300)}`);
    console.log("\n  ⚠  Proceeding anyway — per-member estimateGas will catch individual failures.");
  }

  // ── Rescue loop ───────────────────────────────────────────────────────────
  sep("Rescuing parked members");
  let rescued = 0, failed = 0, skipped = 0;
  const failedList = [];

  for (let i = 0; i < members.length; i++) {
    const { addr, shortfall } = members[i];
    process.stdout.write(`  [${i + 1}/${members.length}] ${addr} shortfall=${fmt6(shortfall)} ... `);

    try {
      const stillParked = await matA.isParked(addr);
      if (!stillParked) {
        console.log("skipped (no longer parked)");
        skipped++;
        continue;
      }

      // Per-member gas estimate — captures current matrix state and surfaces revert reason
      let memberGas = 1_500_000n; // generous fallback
      try {
        const est = await matA.topUpAndCross.estimateGas(addr);
        memberGas = est * 130n / 100n;
      } catch (eg) {
        const reason  = eg.reason  ?? eg.errorArgs?.[0] ?? "null";
        const data    = eg.data    ?? "null";
        const errName = eg.errorName ?? "null";
        console.log(`\n    ⚠ estimateGas REVERTED — skipping`);
        console.log(`      errorName : ${errName}`);
        console.log(`      reason    : ${reason}`);
        console.log(`      data      : ${typeof data === "string" ? data.slice(0, 120) : JSON.stringify(data)}`);
        console.log(`      message   : ${eg.message?.slice(0, 200)}`);
        failed++;
        failedList.push({ addr, reason: reason?.toString() ?? eg.message?.slice(0, 80) });
        if (i < members.length - 1) await sleep(1000);
        continue;
      }

      const tx = await matA.topUpAndCross(addr, { gasLimit: memberGas });
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        console.log(`✅ rescued  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
        rescued++;
      } else {
        console.log(`❌ TX status=0`);
        failed++;
        failedList.push({ addr, reason: "status=0" });
      }
    } catch (e) {
      console.log(`❌ error: ${e.message?.slice(0, 100)}`);
      failed++;
      failedList.push({ addr, reason: e.message?.slice(0, 80) });
    }

    // Give each TX 3s to settle before the next one
    if (i < members.length - 1) await sleep(3000);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  sep("Summary");
  console.log(`  Rescued : ${rescued}`);
  console.log(`  Skipped : ${skipped}`);
  console.log(`  Failed  : ${failed}`);
  if (failedList.length) {
    console.log("\n  Failed addresses:");
    failedList.forEach(({ addr, reason }) => console.log(`    ${addr}  (${reason})`));
  }

  const remaining = await matA.getParkedCount();
  console.log(`\n  Parked remaining on-chain: ${remaining}`);
  if (remaining === 0n) console.log("  🎉 Queue fully cleared!");
}

main().catch(e => {
  console.error("\n❌ Fatal:", e.message);
  process.exit(1);
});
