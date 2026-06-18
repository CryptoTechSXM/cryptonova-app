"use strict";
/**
 * run_simulation.js — Fully Automatic 127-Member Simulation
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE COMMAND. Zero intervention needed after this starts.
 *
 * What it does automatically:
 *   1. Verifies deployed_addresses.json exists (deploy first if not)
 *   2. Registers Wallet #1 as the root if not already in the matrix
 *   3. Registers wallets every INTERVAL_SECONDS until TARGET_MEMBERS reached
 *   4. After every registration:
 *       → Detects stuck crossings → calls forceCross() automatically
 *       → Detects pair expansion threshold → deploys Pair 2 automatically
 *   5. Generates growth_report.js output when simulation completes
 *
 * Configuration (env vars):
 *   INTERVAL_SECONDS=10     Time between registrations (default 10s)
 *   TARGET_MEMBERS=127      Total members to register (default 127)
 *   TWO_PAIRS=true          Pre-deploy Pair 2 before simulation starts (default false)
 *
 * Prerequisites:
 *   1. Deploy first: MATRIX_SIZE=127 npx hardhat run scripts/deploy_figure8_test.js --network baseSepolia
 *   2. Then run:     npx hardhat run scripts/run_simulation.js --network baseSepolia
 *
 * Run: npx hardhat run scripts/run_simulation.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
const { execSync } = require("child_process");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
const LOG_FILE       = path.join(__dirname, "simulation_log.json");

const INTERVAL_S   = parseInt(process.env.INTERVAL_SECONDS || "10");
const TARGET       = parseInt(process.env.TARGET_MEMBERS   || "127");
const TWO_PAIRS    = process.env.TWO_PAIRS === "true";
const FEE          = 10_000_000n;
const ETH_PER      = ethers.parseEther("0.005");

const fmt6  = n  => "$" + (Number(n) / 1e6).toFixed(2);
const stamp = () => new Date().toISOString().slice(11, 19);  // HH:MM:SS
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Auto-fix: stuck crossings ────────────────────────────────────────────
async function fixStuckCrossings(matA, matB, usdc, deployer, addrs) {
  const currentBlock = await ethers.provider.getBlockNumber();
  const fromBlock    = addrs.deployedAtBlock || Math.max(0, currentBlock - 200000);
  const PAGE         = 1999;
  const events = [];
  for (let start = fromBlock; start <= currentBlock; start += PAGE) {
    const end   = Math.min(start + PAGE, currentBlock);
    const batch = await matA.queryFilter(matA.filters.MemberEntered(), start, end);
    events.push(...batch);
  }
  const allAddrs = [...new Set(events.map(e => e.args.member))];
  const stuck = [];
  for (const addr of allAddrs) {
    const mA = await matA.getMember(addr);
    const mB = await matB.getMember(addr);
    if (Number(mA.cyclesCompleted) > 0 && !mA.isInMatrix && !mB.isInMatrix) {
      stuck.push(addr);
    }
  }
  if (stuck.length > 0) {
    console.log(`  ⚠️  [${stamp()}] ${stuck.length} stuck crossing(s) — auto-fixing...`);

    // Pre-mint enough USDC for all forceCrosses in one go (avoids nonce issues)
    try {
      const totalNeeded = FEE * BigInt(stuck.length);
      await (await usdc.connect(deployer).mint(deployer.address, totalNeeded)).wait();
      await sleep(1500);
      await (await usdc.connect(deployer).approve(addrs.MatrixA, totalNeeded)).wait();
      await sleep(1500);
    } catch(e) {
      if (e.message?.includes('already known')) await sleep(4000);
      else { console.log(`  ❌ Pre-mint failed: ${e.shortMessage || e.message}`); return 0; }
    }

    for (const addr of stuck) {
      try {
        await (await matA.connect(deployer).forceCross(addr)).wait();
        console.log(`  ✅  [${stamp()}] Force-crossed: ${addr.slice(0,10)}...`);
        await sleep(300);  // brief pause between crosses
      } catch(e) {
        if (e.message?.includes('already known')) {
          await sleep(3000);
          try {
            await (await matA.connect(deployer).forceCross(addr)).wait();
            console.log(`  ✅  [${stamp()}] Force-crossed (retry): ${addr.slice(0,10)}...`);
          } catch(_) { console.log(`  ⚠️  Skipped: ${addr.slice(0,10)}...`); }
        } else {
          console.log(`  ⚠️  forceCross failed: ${e.shortMessage || e.message}`);
        }
      }
    }
  }
  return stuck.length;
}

// ─── Auto-expand: deploy Pair 2 when threshold hit ────────────────────────
async function autoExpandIfNeeded(pm, deployer, addrs, cnova, treasury) {
  const shouldExpand = await pm.shouldExpand();
  if (!shouldExpand) return false;

  // Check if we already have more than 1 pair
  const pairCount = Number(await pm.pairCount());
  if (pairCount > 1) return false;  // already expanded

  console.log(`\n  ⚡  [${stamp()}] EXPANSION TRIGGERED — deploying Pair 2 (C↔D)...`);

  const devWallet      = process.env.DEV_WALLET_ADDRESS      || deployer.address;
  const opsWallet      = process.env.OPS_WALLET_ADDRESS      || deployer.address;
  const protocolWallet = process.env.PROTOCOL_WALLET_ADDRESS || devWallet;
  const adminWallet    = process.env.ADMIN_WALLET_ADDRESS    || deployer.address;
  const accountOne     = addrs.AccountOne;

  const matA    = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const MSIZE   = await matA.MATRIX_SIZE();
  const EFEE    = await matA.ENTRY_FEE();

  const F8 = await ethers.getContractFactory("FigureEightMatrix");
  const matC = await F8.deploy(addrs.USDC, addrs.CNOVAToken, addrs.CNOVATreasury,
    devWallet, opsWallet, ethers.ZeroAddress, protocolWallet, accountOne,
    adminWallet, EFEE, MSIZE, true);
  await matC.waitForDeployment();

  const matD = await F8.deploy(addrs.USDC, addrs.CNOVAToken, addrs.CNOVATreasury,
    devWallet, opsWallet, ethers.ZeroAddress, protocolWallet, accountOne,
    adminWallet, EFEE, MSIZE, false);
  await matD.waitForDeployment();

  const matCAddr = await matC.getAddress();
  const matDAddr = await matD.getAddress();

  await (await matC.setPartner(matDAddr)).wait();
  await (await matD.setPartner(matCAddr)).wait();
  await (await matC.setPairManager(addrs.PairManager)).wait();
  await (await matD.setPairManager(addrs.PairManager)).wait();

  const MINTER = await cnova.MINTER_ROLE();
  await (await cnova.grantRole(MINTER, matCAddr)).wait();
  await (await cnova.grantRole(MINTER, matDAddr)).wait();
  await (await treasury.setAuthorizedCaller(matCAddr, true)).wait();
  await (await treasury.setAuthorizedCaller(matDAddr, true)).wait();

  await (await pm.addPair(matCAddr, matDAddr)).wait();

  addrs.MatrixC = matCAddr;
  addrs.MatrixD = matDAddr;
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addrs, null, 2));

  console.log(`  ✅  [${stamp()}] Pair 2 deployed! C=${matCAddr.slice(0,10)}  D=${matDAddr.slice(0,10)}`);
  console.log(`  → ALL new members now enter Pair 2 (sequential chain)\n`);
  return true;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n  ❌  deployed_addresses.json not found.`);
    console.error(`  Deploy first: MATRIX_SIZE=127 npx hardhat run scripts/deploy_figure8_test.js --network baseSepolia\n`);
    process.exit(1);
  }

  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const matA     = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB     = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const usdc     = await ethers.getContractAt("MockUSDC",           addrs.USDC);
  const cnova    = await ethers.getContractAt("CNOVAToken",         addrs.CNOVAToken);
  const treasury = await ethers.getContractAt("CNOVATreasury",      addrs.CNOVATreasury);
  const pm       = await ethers.getContractAt("PairManager",        addrs.PairManager);

  const MSIZE    = Number(await matA.MATRIX_SIZE());
  const REFERRER = addrs.AccountOne;
  const regTarget = addrs.PairManager;

  console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
  console.log(`  ║    CryptoNova V7 — Fully Automatic Simulation            ║`);
  console.log(`  ╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Matrix:   ${MSIZE}-member (mainnet scale)`);
  console.log(`  Target:   ${TARGET} members  |  Interval: ${INTERVAL_S}s`);
  console.log(`  Duration: ~${Math.ceil(TARGET * INTERVAL_S / 60)} minutes`);
  console.log(`  Two pairs: ${TWO_PAIRS ? "YES — pre-deploying Pair 2" : "NO — expands automatically at threshold"}`);
  console.log(`  Fully autonomous: stuck crossings auto-fixed, pairs auto-expanded`);

  // ── Step 1: Register W1 if needed ────────────────────────────────────────
  const w1Member = await matA.getMember(REFERRER);
  if (!w1Member.hasEverJoined) {
    console.log(`\n  ─── Step 1: Registering Wallet #1 as root ──────────────`);
    if (!process.env.W1_PRIVATE_KEY) {
      console.error("  ❌  W1_PRIVATE_KEY missing from .env"); process.exit(1);
    }
    const w1 = new ethers.Wallet(process.env.W1_PRIVATE_KEY, ethers.provider);
    const ethBal = await ethers.provider.getBalance(w1.address);
    if (ethBal < ethers.parseEther("0.002")) {
      await (await deployer.sendTransaction({ to: w1.address, value: ETH_PER })).wait();
      await sleep(4000);
    }
    await (await usdc.connect(deployer).mint(w1.address, FEE * 2n)).wait();
    await (await usdc.connect(w1).approve(addrs.MatrixA, FEE)).wait();
    await (await matA.connect(w1).register(ethers.ZeroAddress)).wait();
    await sleep(3000);
    console.log(`  ✅  Wallet #1 registered at position 1 (root)`);
  } else {
    console.log(`\n  ✅  Wallet #1 already at position ${await matA.matrixPos(REFERRER)}`);
  }

  // ── Step 2: Pre-deploy Pair 2 if requested ────────────────────────────────
  if (TWO_PAIRS && Number(await pm.pairCount()) === 1) {
    await autoExpandIfNeeded({ shouldExpand: async () => true, pairCount: async () => 1, addPair: pm.addPair.bind(pm) }, deployer, addrs, cnova, treasury);
  }

  // ── Step 3: Load or init simulation log ──────────────────────────────────
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); } catch(_) {}
  }
  const startAt = log.length;
  console.log(`\n  ─── Starting simulation from member #${startAt + 1} ───────────────`);

  if (startAt >= TARGET) {
    console.log(`  ✅  Target already reached. Running report...`);
  }

  // Pre-fund initial batch
  const BATCH = Math.min(10, TARGET - startAt);
  const walletQueue = [];
  console.log(`  Pre-funding ${BATCH} wallets...`);
  for (let i = 0; i < BATCH; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    walletQueue.push(w);
    try {
      await (await deployer.sendTransaction({ to: w.address, value: ETH_PER })).wait();
      await sleep(1000); // brief pause between funding txs to avoid nonce collision
      await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait();
    } catch(e) {
      if (e.message?.includes('already known')) {
        await sleep(3000); // RPC duplicate — wait and retry once
        try {
          await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait();
        } catch(_) {}
      }
    }
  }
  console.log(`  ✅  Ready. Starting in 3s...\n`);
  await sleep(3000);

  let walletCursor = 0;
  let universeActivated = false;  // tracks whether Universe Mode has been activated

  // Check if already active from a previous run
  try {
    universeActivated = await treasury.isUniverseMode();
    if (universeActivated) console.log(`  ✅  Universe Mode already active from previous run`);
  } catch(_) {}

  for (let reg = startAt; reg < TARGET; reg++) {
    // Refill wallet queue
    if (walletCursor >= walletQueue.length) {
      const batch = Math.min(10, TARGET - reg);
      for (let i = 0; i < batch; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        walletQueue.push(w);
        try {
          await (await deployer.sendTransaction({ to: w.address, value: ETH_PER })).wait();
          await sleep(800);
          await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait();
        } catch(e) {
          if (e.message?.includes('already known')) {
            await sleep(3000);
            try { await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait(); } catch(_) {}
          }
        }
      }
    }

    const wallet = walletQueue[walletCursor++];

    // Capture before state
    const rootBefore   = await matA.posToMember(1);
    const escrowBefore = rootBefore !== ethers.ZeroAddress ? await matA.escrowOf(rootBefore) : 0n;
    const rotBefore    = await matA.rotationCount();

    // Register
    try {
      await (await usdc.connect(wallet).approve(regTarget, FEE)).wait();
      await (await pm.connect(wallet).register(REFERRER)).wait();
    } catch(e) {
      console.log(`  [${String(reg+1).padStart(3)}] ❌ ${e.shortMessage || e.message}`);
      continue;
    }

    // Capture after state — read from ACTIVE pair's Matrix A for display
    const freshAddrsCurrent = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
    const activePairIdx = Number(await pm.activePairIndex());
    const pairStatus    = await pm.allPairsStatus();
    const activeMatAAddr = pairStatus[0][activePairIdx];
    const activeMatBAddr = pairStatus[1][activePairIdx];
    const activeMatA = await ethers.getContractAt("FigureEightMatrix", activeMatAAddr);
    const activeMatB = await ethers.getContractAt("FigureEightMatrix", activeMatBAddr);
    const pairLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const activePairLabel = pairLetters[activePairIdx * 2]; // A for pair 0, C for pair 1, E for pair 2

    const rotAfter   = await matA.rotationCount();
    const crossed    = rotAfter > rotBefore;
    const rootAfter  = await activeMatA.posToMember(1);
    const escrowAfter = rootAfter !== ethers.ZeroAddress ? await activeMatA.escrowOf(rootAfter) : 0n;
    const occA = await activeMatA.occupancy();
    const occB = await activeMatB.occupancy();
    const supply = await cnova.totalSupply();
    const epoch  = await cnova.currentEpochNumber();
    const reserve = await treasury.usdcReserve();
    const floor   = await treasury.floorPrice();
    const pairCount = Number(await pm.pairCount());

    // Capture BFS position earnings (first 15 positions)
    const positionEarnings = [];
    const maxPos = Math.min(Number(occA), 15);
    for (let pos = 1; pos <= maxPos; pos++) {
      const addr = await matA.posToMember(pos);
      if (addr !== ethers.ZeroAddress) {
        const m   = await matA.getMember(addr);
        const esc = await matA.escrowOf(addr);
        positionEarnings.push({
          pos, addr: addr.slice(0,10),
          withdrawable: Number(m.withdrawable)/1e6,
          escrow:       Number(esc)/1e6,
          totalEarned:  Number(m.totalEarned)/1e6,
        });
      }
    }

    // Log
    const entry = {
      reg: reg + 1, timestamp: stamp(),
      member: wallet.address.slice(0,10),
      crossed, rotations: Number(rotAfter),
      occA: Number(occA), occB: Number(occB),
      rootAddr:  rootAfter !== ethers.ZeroAddress ? rootAfter.slice(0,10) : "none",
      rootEscrow: Number(escrowAfter)/1e6,
      escrowDelta: (Number(escrowAfter) - Number(escrowBefore))/1e6,
      supply: Number(supply)/1e18,
      epoch: Number(epoch), pairs: pairCount,
      treasury: Number(reserve)/1e6,
      floorPrice: Number(floor)/1e6,
      positionEarnings,
    };
    log.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

    // Console
    const crossTag = crossed ? "  🔄 CROSSED!" : "";
    const pairTag  = pairCount > 1 ? `  pairs:${pairCount}` : "";
    console.log(
      `  [${String(reg+1).padStart(3)}/${TARGET}] ${wallet.address.slice(0,10)}` +
      `  ${activePairLabel}:${occA}/${MSIZE}  esc:${fmt6(escrowAfter)}` +
      `  epoch:${epoch}  floor:$${(Number(floor)/1e6).toFixed(5)}${pairTag}${crossTag}`
    );

    // ── Auto-fix stuck crossings ────────────────────────────────────────
    if (crossed) {
      await sleep(2000);  // let state settle
      await fixStuckCrossings(matA, matB, usdc, deployer, addrs);
    }

    // ── Auto-expand pairs ───────────────────────────────────────────────
    const freshAddrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
    await autoExpandIfNeeded(pm, deployer, freshAddrs, cnova, treasury);

    // ── Auto-activate Universe Mode when 500 members reached ────────────
    if (!universeActivated) {
      try {
        const universeMode = await treasury.isUniverseMode();
        if (!universeMode) {
          const total = await pm.totalMembers();
          if (Number(total) >= 500) {
            console.log(`\n  🌌 [${stamp()}] 500 members reached — activating Universe Mode...`);
            await (await treasury.connect(deployer).setFreeMode()).wait();
            console.log(`  ✅  [${stamp()}] Universe Mode ACTIVE — governance is live!\n`);
            universeActivated = true;
          }
        } else {
          universeActivated = true;
        }
      } catch(_) {}
    }

    if (reg < TARGET - 1) await sleep(INTERVAL_S * 1000);
  }

  // ── Final report ──────────────────────────────────────────────────────
  console.log(`\n  ✅  Simulation complete — ${TARGET} members registered.`);
  console.log(`\n  Running analysis report...\n`);

  const { execSync } = require("child_process");
  try {
    const report = execSync("node scripts/growth_report.js", { encoding: "utf8" });
    console.log(report);
  } catch(e) {
    console.log(`  Run manually: node scripts/growth_report.js`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
