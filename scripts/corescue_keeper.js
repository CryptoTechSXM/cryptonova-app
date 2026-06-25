"use strict";
/**
 * corescue_keeper.js — SF-funded coPayRescue for all T1 parked wallets
 * ─────────────────────────────────────────────────────────────────────
 * Replaces the broken keeper rescue path (empty sfRescueThresholds bug
 * in MatrixKeeper.sol) until V8.23 is deployed.
 *
 * Why coPayRescue instead of topUpAndCross?
 *   - SF covers most of the shortfall automatically
 *   - Caller (deployer) only covers residual memberShare when withdrawable < entryFee×2/3
 *     Formula: sfShare=withdrawable/2, memberShare=max(0, shortfall-sfShare)
 *     e.g. $6.10 withdrawable → sfShare=$3.05, memberShare=$0.85 (deployer pays $0.85)
 *   - Works on V8.22 without any contract changes
 *   - MatA is already in SF's authorizedMatrices (wired in deploy_v8.js)
 *
 * Run manually:
 *   npx hardhat run scripts/corescue_keeper.js --network baseSepolia
 *
 * Scheduled via Windows Task Scheduler — runs every 5 minutes.
 * ─────────────────────────────────────────────────────────────────────
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(
  __dirname, "..",
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_22.json"
);

// ── ABIs ──────────────────────────────────────────────────────────────────────
const MAT_ABI = [
  "function getParkedCount() external view returns (uint256)",
  "function getParkedMember(uint256 idx) external view returns (address)",
  "function isParked(address) external view returns (bool)",
  "function withdrawableOf(address) external view returns (uint256)",
  "function ENTRY_FEE() external view returns (uint256)",
  "function coPayRescue(address member) external",
];

const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function stabilityFloor() external view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt6  = n  => "$" + (Number(n) / 1e6).toFixed(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts    = ()  => new Date().toISOString().slice(0, 19).replace("T", " ");

async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML" }),
    });
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE))
    throw new Error(`Addresses file not found: ${ADDRESSES_FILE}`);

  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const matAAddr = addrs.tiers.T1.matA;
  const sfAddr   = addrs.stabilityFund;
  const usdcAddr = addrs.usdc;

  const matA = new ethers.Contract(matAAddr, MAT_ABI,   deployer);
  const sf   = new ethers.Contract(sfAddr,   SF_ABI,    deployer);
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, deployer);

  // ── Fast-exit if nothing to do ────────────────────────────────────────────
  const initialCount = await matA.getParkedCount();
  if (initialCount === 0n) {
    console.log(`[${ts()}] CoRescue: 0 parked — nothing to do.`);
    return;
  }

  console.log(`[${ts()}] CoRescue Keeper starting — ${initialCount} parked`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  T1 MatA  : ${matAAddr}`);
  console.log(`  SF       : ${sfAddr}`);

  const sfBal   = await sf.totalBalance();
  const sfFloor = await sf.stabilityFloor();
  const sfUsable = sfBal > sfFloor ? sfBal - sfFloor : 0n;
  console.log(`  SF bal   : ${fmt6(sfBal)}  floor: ${fmt6(sfFloor)}  usable: ${fmt6(sfUsable)}`);

  const entryFee = await matA.ENTRY_FEE();

  let round = 0;
  let totalRescued = 0;

  // ── Cascade loop — keeps running until queue is empty or stuck ─────────────
  // Each rescue triggers BFS cycles that may park additional members.
  while (true) {
    const parkedCount = await matA.getParkedCount();
    if (parkedCount === 0n) {
      console.log(`[${ts()}] Queue empty after ${round} round(s). Total rescued: ${totalRescued}`);
      if (totalRescued > 0) {
        await sendTelegram(
          `✅ <b>CoRescue complete</b>\n` +
          `Rescued ${totalRescued} parked member(s) in ${round} round(s).\n` +
          `SF balance: ${fmt6(await sf.totalBalance())}`
        );
      }
      break;
    }

    round++;
    console.log(`\n[${ts()}] Round ${round} — ${parkedCount} parked`);

    // Snapshot parked queue
    const parkedList = [];
    for (let i = 0; i < Number(parkedCount); i++) {
      parkedList.push(await matA.getParkedMember(i));
    }

    // ── Compute caller share per member (sfShare = withdrawable/2, callerShare = shortfall - sfShare) ──
    let totalCallShare = 0n;
    const callerShareMap = new Map();
    for (const addr of parkedList) {
      const w         = await matA.withdrawableOf(addr);
      const sfShare   = w / 2n;
      const shortfall = entryFee > w ? entryFee - w : 0n;
      const callShare = shortfall > sfShare ? shortfall - sfShare : 0n;
      callerShareMap.set(addr, callShare);
      totalCallShare += callShare;
    }

    // ── Approve deployer USDC if any member needs a caller contribution ──────
    if (totalCallShare > 0n) {
      console.log(`  Caller USDC needed: ${fmt6(totalCallShare)} — approving...`);
      const curAllowance = await usdc.allowance(deployer.address, matAAddr);
      if (curAllowance < totalCallShare) {
        const aTx = await usdc.approve(matAAddr, totalCallShare, { gasLimit: 100_000 });
        console.log(`  Approve TX: ${aTx.hash}`);
        await aTx.wait();
        console.log(`  ✅ Approved. Waiting 5s for RPC to settle...`);
        await sleep(5000);
      } else {
        console.log(`  ✅ Allowance already sufficient (${fmt6(curAllowance)})`);
      }
    }

    let roundRescued = 0;
    let roundFailed  = 0;
    const failedAddrs = [];

    for (let i = 0; i < parkedList.length; i++) {
      const addr = parkedList[i];
      const withdrawable = await matA.withdrawableOf(addr);
      process.stdout.write(
        `  [${i + 1}/${parkedList.length}] ${addr}  bal=${fmt6(withdrawable)} ... `
      );

      // Verify still parked (a prior TX in this round may have already rescued them)
      const stillParked = await matA.isParked(addr);
      if (!stillParked) {
        console.log("skipped (no longer parked)");
        continue;
      }

      // Per-member estimateGas — catches revert reasons and gives real gas limit
      // Gas varies wildly (~700k to 12M) depending on how full the matrix is.
      let memberGas = 2_000_000n;
      try {
        const est = await matA.coPayRescue.estimateGas(addr);
        memberGas = est * 130n / 100n;  // +30% buffer
      } catch (eg) {
        const reason = eg.reason ?? eg.errorArgs?.[0] ?? eg.message?.slice(0, 120);
        console.log(`⚠  estimateGas reverted: ${reason}`);
        roundFailed++;
        failedAddrs.push(addr);
        if (i < parkedList.length - 1) await sleep(1000);
        continue;
      }

      // Execute rescue
      try {
        const tx = await matA.coPayRescue(addr, { gasLimit: memberGas });
        const receipt = await tx.wait();

        if (receipt.status === 1) {
          console.log(`✅ rescued  (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toLocaleString()})`);
          roundRescued++;
          totalRescued++;
        } else {
          console.log(`❌ TX status=0`);
          roundFailed++;
          failedAddrs.push(addr);
        }
      } catch (e) {
        console.log(`❌ ${e.message?.slice(0, 100)}`);
        roundFailed++;
        failedAddrs.push(addr);
      }

      // 3s gap between TXs — avoids in-flight RPC limit
      if (i < parkedList.length - 1) await sleep(3000);
    }

    console.log(`  Round ${round}: rescued=${roundRescued}  failed=${roundFailed}`);

    // Reset deployer allowance to 0 after each round
    if (totalCallShare > 0n) {
      const remaining = await usdc.allowance(deployer.address, matAAddr);
      if (remaining > 0n) {
        const rTx = await usdc.approve(matAAddr, 0n, { gasLimit: 100_000 });
        await rTx.wait();
      }
    }

    // Stuck: no progress made — alert and stop to avoid infinite loop
    if (roundRescued === 0) {
      console.log(`[${ts()}] ⚠  No progress in round ${round} — stopping.`);
      const failList = failedAddrs.map(a => `  • ${a}`).join("\n");
      await sendTelegram(
        `⚠️ <b>CoRescue stuck</b>\n` +
        `${roundFailed} member(s) could not be rescued — manual review needed.\n` +
        failList
      );
      process.exit(1);
    }

    // Brief pause before checking for cascade-parked members
    await sleep(2000);
  }
}

main().catch(async e => {
  const msg = `[${ts()}] ❌ Fatal: ${e.message}`;
  console.error(msg);
  await sendTelegram(`❌ <b>CoRescue fatal error</b>\n${e.message?.slice(0, 200)}`);
  process.exit(1);
});
