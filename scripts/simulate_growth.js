"use strict";
/**
 * simulate_growth.js — Timed Member Growth Simulation
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers one new member every INTERVAL_SECONDS, capturing real contract state
 * after each registration. Validates all earnings numbers against actual on-chain data.
 *
 * Configuration (env vars or defaults):
 *   INTERVAL_SECONDS=60   Time between registrations (default 60s)
 *   TARGET_MEMBERS=127    Stop after this many new members (default 127)
 *   REFERRER=<addr>       Referral address (default: AccountOne from addresses.json)
 *
 * Output:
 *   Console: live status after each registration
 *   simulation_log.json: full history for growth_report.js analysis
 *
 * Run: npx hardhat run scripts/simulate_growth.js --network baseSepolia
 *
 * Duration: 127 members × 60s = ~2 hours. Can run overnight.
 * The log survives interruption — restart picks up where it left off.
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
const LOG_FILE       = path.join(__dirname, "simulation_log.json");

const INTERVAL_S   = parseInt(process.env.INTERVAL_SECONDS || "60");
const TARGET       = parseInt(process.env.TARGET_MEMBERS   || "127");
const FEE          = 10_000_000n;
const ETH_PER      = ethers.parseEther("0.005");

const fmt6  = n => "$" + (Number(n) / 1e6).toFixed(4);
const fmtE  = n => Number(ethers.formatEther(n)).toFixed(6) + " ETH";
const stamp = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("  deployed_addresses.json not found — deploy first"); process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const matA     = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB     = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const usdc     = await ethers.getContractAt("MockUSDC",           addrs.USDC);
  const cnova    = await ethers.getContractAt("CNOVAToken",         addrs.CNOVAToken);
  const treasury = await ethers.getContractAt("CNOVATreasury",      addrs.CNOVATreasury);
  const pm       = addrs.PairManager
    ? await ethers.getContractAt("PairManager", addrs.PairManager)
    : null;

  const REFERRER   = addrs.AccountOne || (await matA.accountOne());
  const MSIZE      = Number(await matA.MATRIX_SIZE());
  const regTarget  = pm ? addrs.PairManager : addrs.MatrixA;

  console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
  console.log(`  ║         CryptoNova V7 — Growth Simulation                ║`);
  console.log(`  ╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Matrix size:  ${MSIZE}-member (${MSIZE === 127 ? "MAINNET SCALE" : "test"})`);
  console.log(`  Target:       ${TARGET} members`);
  console.log(`  Interval:     ${INTERVAL_S}s between registrations`);
  console.log(`  Est. duration: ${Math.ceil(TARGET * INTERVAL_S / 60)} minutes`);
  console.log(`  Referrer:     ${REFERRER.slice(0,10)}... (Account #1)`);
  console.log(`  Log file:     ${LOG_FILE}`);
  console.log(`\n  Press Ctrl+C to pause — restart continues from log.\n`);

  // Load or init log
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try {
      log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
      console.log(`  ✓ Resuming from ${log.length} previous registrations`);
    } catch(_) { log = []; }
  }

  const startAt = log.length;
  if (startAt >= TARGET) {
    console.log(`  ✅  Target of ${TARGET} already reached. Run growth_report.js to analyze.\n`);
    return;
  }

  // Pre-fund wallets in a batch to minimize waits
  const PREFUND_BATCH = Math.min(10, TARGET - startAt);
  console.log(`  Pre-funding ${PREFUND_BATCH} wallets...`);
  const walletQueue = [];
  for (let i = 0; i < PREFUND_BATCH; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    walletQueue.push(w);
    await (await deployer.sendTransaction({ to: w.address, value: ETH_PER })).wait();
    await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait();
  }
  console.log(`  ✓ ${PREFUND_BATCH} wallets pre-funded\n`);

  let walletCursor = 0;

  for (let reg = startAt; reg < TARGET; reg++) {
    // Refill queue if needed
    if (walletCursor >= walletQueue.length) {
      console.log(`  Refilling wallet queue...`);
      const batch = Math.min(10, TARGET - reg);
      for (let i = 0; i < batch; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        walletQueue.push(w);
        await (await deployer.sendTransaction({ to: w.address, value: ETH_PER })).wait();
        await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait();
      }
      console.log(`  ✓ ${batch} more wallets queued`);
    }

    const wallet = walletQueue[walletCursor++];

    // Capture STATE BEFORE registration
    const rootBefore   = await matA.posToMember(1);
    const escrowBefore = rootBefore !== ethers.ZeroAddress
      ? await matA.escrowOf(rootBefore) : 0n;
    const occABefore   = await matA.occupancy();
    const rotBefore    = await matA.rotationCount();

    // Register
    const t0 = Date.now();
    try {
      await (await usdc.connect(wallet).approve(regTarget, FEE)).wait();
      if (pm) {
        await (await pm.connect(wallet).register(REFERRER)).wait();
      } else {
        await (await matA.connect(wallet).register(REFERRER)).wait();
      }
    } catch (e) {
      console.log(`  [${reg+1}/${TARGET}] ❌ FAILED: ${e.shortMessage || e.message}`);
      continue;
    }
    const elapsed = Date.now() - t0;

    // Capture STATE AFTER registration
    const rotAfter   = await matA.rotationCount();
    const crossed    = rotAfter > rotBefore;
    const rootAfter  = await matA.posToMember(1);
    const escrowAfter= rootAfter !== ethers.ZeroAddress
      ? await matA.escrowOf(rootAfter) : 0n;
    const occA       = await matA.occupancy();
    const occB       = await matB.occupancy();
    const totA       = await matA.totalMembers();
    const totB       = await matB.totalMembers();
    const supply     = await cnova.totalSupply();
    const epoch      = await cnova.currentEpochNumber();
    const reserve    = await treasury.usdcReserve();
    const floor      = await treasury.floorPrice();

    // Chain pay snapshot — who is at each position and their earnings
    const positionEarnings = [];
    const maxPos = Math.min(Number(occA), 15);  // show first 15 positions
    for (let pos = 1; pos <= maxPos; pos++) {
      const addr = await matA.posToMember(pos);
      if (addr !== ethers.ZeroAddress) {
        const m   = await matA.getMember(addr);
        const esc = await matA.escrowOf(addr);
        positionEarnings.push({
          pos,
          addr:        addr.slice(0,10),
          withdrawable: Number(m.withdrawable) / 1e6,
          escrow:      Number(esc) / 1e6,
          totalEarned: Number(m.totalEarned) / 1e6,
        });
      }
    }

    // Log entry
    const entry = {
      reg:         reg + 1,
      timestamp:   stamp(),
      member:      wallet.address.slice(0,10),
      crossed,
      rotations:   Number(rotAfter),
      occA:        Number(occA),
      occB:        Number(occB),
      totA:        Number(totA),
      totB:        Number(totB),
      rootAddr:    rootAfter !== ethers.ZeroAddress ? rootAfter.slice(0,10) : "none",
      rootEscrow:  Number(escrowAfter) / 1e6,
      escrowDelta: (Number(escrowAfter) - Number(escrowBefore)) / 1e6,
      supply:      Number(supply) / 1e18,
      epoch:       Number(epoch),
      treasury:    Number(reserve) / 1e6,
      floorPrice:  Number(floor) / 1e6,
      positionEarnings,
      txMs:        elapsed,
    };
    log.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

    // Console output
    const crossTag = crossed ? "  🔄 CROSSING!" : "";
    console.log(
      `  [${String(reg+1).padStart(3)}/${TARGET}] ${wallet.address.slice(0,10)}...` +
      `  A:${occA}/${MSIZE}  B:${occB}/${MSIZE}` +
      `  root_escrow:${fmt6(escrowAfter)}` +
      `  +${fmt6(BigInt(Math.round(entry.escrowDelta * 1e6)))}` +
      `  floor:$${(Number(floor)/1e6).toFixed(6)}` +
      `  epoch:${epoch}${crossTag}`
    );

    if (crossed) {
      console.log(`      ↳ Rotation ${rotAfter} — root cycled to Matrix B`);
    }

    // Wait for next interval (skip wait after last registration)
    if (reg < TARGET - 1) {
      process.stdout.write(`  ⏳ Next in ${INTERVAL_S}s...`);
      await sleep(INTERVAL_S * 1000);
      process.stdout.write(`\r                          \r`);
    }
  }

  console.log(`\n  ✅  Simulation complete! ${TARGET} members registered.`);
  console.log(`  Log saved: ${LOG_FILE}`);
  console.log(`  Run: npx hardhat run scripts/growth_report.js --network baseSepolia\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
