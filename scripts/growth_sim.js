"use strict";
/**
 * growth_sim.js  —  v8.6 automated growth simulation
 *
 * Phases:
 *   Phase 1  (SEED)     : Register W1 + N_SEED wallets immediately (default 10)
 *   Phase 2  (IDLE)     : Poll every POLL_MS until COMMUNITY_THRESHOLD accounts reached
 *   Phase 3  (GROWTH)   : Add 1 wallet every ADD_INTERVAL_MS indefinitely (default 60 000 = 1 min)
 *   Phase 4  (KEEPER)   : Before every add-wallet, run keeper upkeep (parked rescue + velocity gate)
 *
 * Environment variables (all optional — safe defaults for testnet):
 *   DEPLOYED_FILE     path to deployed_addresses_v8_6.json   (default: deployed_addresses_v8_6.json)
 *   N_SEED            wallets to register immediately (default 10)
 *   COMMUNITY_THRESHOLD  accounts before growth phase starts (default 100)
 *   ADD_INTERVAL_MS   ms between each new wallet addition in growth phase (default 60000)
 *   POLL_MS           ms between idle polls (default 10000)
 *   MAX_WALLETS       stop after this many total registered wallets (default 0 = run forever)
 *   GAS_LIMIT         gas limit per registration tx (default 8000000)
 *   DRY_RUN           if "true", log actions but don't send txs (default false)
 *
 * Usage:
 *   npx hardhat run scripts/growth_sim.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");

// ─── Config ────────────────────────────────────────────────────────────────────
const DEPLOYED_FILE        = process.env.DEPLOYED_FILE        || "deployed_addresses_v8_6.json";
const N_SEED               = parseInt(process.env.N_SEED               || "10",  10);
const COMMUNITY_THRESHOLD  = parseInt(process.env.COMMUNITY_THRESHOLD  || "100", 10);
const ADD_INTERVAL_MS      = parseInt(process.env.ADD_INTERVAL_MS      || "60000", 10);
const POLL_MS              = parseInt(process.env.POLL_MS              || "10000", 10);
const MAX_WALLETS          = parseInt(process.env.MAX_WALLETS          || "0",   10);
const GAS_LIMIT            = parseInt(process.env.GAS_LIMIT            || "8000000", 10);
const DRY_RUN              = process.env.DRY_RUN === "true";

// ─── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts    = ()  => new Date().toISOString().replace("T", " ").slice(0, 19);
const log   = (tag, msg) => console.log(`[${ts()}] [${tag}] ${msg}`);

function loadAddresses() {
  const candidates = [
    path.join(__dirname, DEPLOYED_FILE),          // scripts/deployed_addresses_v8_6.json
    DEPLOYED_FILE,                                  // relative to cwd
    path.join(__dirname, "..", DEPLOYED_FILE),     // project root
    path.join(process.cwd(), DEPLOYED_FILE),       // cwd absolute
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  throw new Error(`Cannot find ${DEPLOYED_FILE}. Run deploy_v8.js first.`);
}

// ─── Keeper helpers ─────────────────────────────────────────────────────────────
async function runKeeperUpkeep(keeper, matrixKeeper) {
  try {
    const [needsUpkeep, performData] = await matrixKeeper.checkUpkeep("0x");
    if (!needsUpkeep) {
      log("KEEPER", "no work needed");
      return;
    }
    if (DRY_RUN) {
      log("KEEPER", `DRY_RUN: would call performUpkeep (${performData.length} bytes)`);
      return;
    }
    const tx = await matrixKeeper.connect(keeper).performUpkeep(performData, { gasLimit: 6_000_000 });
    const rc = await tx.wait();
    log("KEEPER", `performUpkeep OK  gas=${rc.gasUsed.toLocaleString()}  tx=${tx.hash}`);
  } catch (e) {
    log("KEEPER", `upkeep error: ${e.message}`);
  }
}

// ─── Registration helper ────────────────────────────────────────────────────────
async function registerWallet(wallet, referrer, tierRouter, pm1Addr, usdc, entryFee, label) {
  if (DRY_RUN) {
    log("REG", `DRY_RUN: would register ${wallet.address} (${label}) ref=${referrer}`);
    return true;
  }
  try {
    // Fund wallet with USDC (on testnet MockUSDC available; on mainnet must be pre-funded)
    const mockUSDC = await ethers.getContractAt(
      ["function mint(address,uint256) external"],
      await usdc.getAddress()
    );
    try {
      await mockUSDC.connect(wallet).mint(wallet.address, entryFee);
    } catch {
      // On mainnet or if MockUSDC not available, wallet must be pre-funded
      const bal = await usdc.balanceOf(wallet.address);
      if (bal < entryFee) {
        log("REG", `SKIP ${label}: insufficient USDC (${bal} < ${entryFee})`);
        return false;
      }
    }

    // Approve PM
    await usdc.connect(wallet).approve(pm1Addr, entryFee);

    const tx = await tierRouter.connect(wallet).register(
      referrer || ethers.ZeroAddress,
      { gasLimit: GAS_LIMIT }
    );
    const rc = await tx.wait();
    log("REG", `registered ${wallet.address} (${label})  gas=${rc.gasUsed.toLocaleString()}  tx=${tx.hash}`);
    return true;
  } catch (e) {
    log("REG", `FAILED ${label} ${wallet.address}: ${e.message.slice(0, 120)}`);
    return false;
  }
}

// ─── State helpers ──────────────────────────────────────────────────────────────
async function countRegistered(tierRouter, matAAddr) {
  try {
    const matA = await ethers.getContractAt(
      ["function totalRegistered() view returns (uint256)"],
      matAAddr
    );
    return await matA.totalRegistered();
  } catch {
    return 0n;
  }
}

async function printStats(tierRouter, matAAddr, matBAddr, sf) {
  try {
    const matA = await ethers.getContractAt([
      "function totalRegistered() view returns (uint256)",
      "function occupancy() view returns (uint256)",
    ], matAAddr);
    const matB = await ethers.getContractAt([
      "function totalRegistered() view returns (uint256)",
      "function occupancy() view returns (uint256)",
    ], matBAddr);

    const matATotal = await matA.totalRegistered();
    const matAOcc   = await matA.occupancy();
    const matBTotal = await matB.totalRegistered();
    const matBOcc   = await matB.occupancy();
    const sfBal     = await sf.totalBalance();

    log("STATS", `MatA registered=${matATotal}  occ=${matAOcc}  |  MatB registered=${matBTotal}  occ=${matBOcc}  |  SF=$${(sfBal / 1_000_000n).toString()}`);
  } catch (e) {
    log("STATS", `error: ${e.message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const addrs = loadAddresses();

  // Locate T1 addresses
  const t1 = addrs.tiers?.["T1"] || addrs.tiers?.["1"] || addrs;  // support v8.6 (T1) and older formats
  const trAddr   = addrs.tierRouter  || t1.tierRouter;
  const sfAddr   = addrs.stabilityFund;
  const mkAddr   = addrs.matrixKeeper;
  const matAAddr = t1.matA || t1.matAAddr;
  const matBAddr = t1.matB || t1.matBAddr;
  const pm1Addr  = t1.pairManager || t1.pm;
  const usdcAddr = addrs.usdc || t1.usdc;
  const w1Addr   = addrs.w1Addr;

  if (!trAddr || !matAAddr || !matBAddr || !pm1Addr || !usdcAddr) {
    throw new Error(`Missing required addresses in ${DEPLOYED_FILE}. Got: ${JSON.stringify(addrs, null, 2)}`);
  }

  log("INIT", `Loaded addresses from ${DEPLOYED_FILE}`);
  log("INIT", `TierRouter  : ${trAddr}`);
  log("INIT", `MatA (T1)   : ${matAAddr}`);
  log("INIT", `MatB (T1)   : ${matBAddr}`);
  log("INIT", `SF          : ${sfAddr}`);
  log("INIT", `MatrixKeeper: ${mkAddr || "(none)"}`);
  log("INIT", `DRY_RUN=${DRY_RUN}  N_SEED=${N_SEED}  COMMUNITY_THRESHOLD=${COMMUNITY_THRESHOLD}  ADD_INTERVAL_MS=${ADD_INTERVAL_MS}`);

  const signers = await ethers.getSigners();
  if (signers.length < 2) throw new Error("Need at least 2 signers. Set DEPLOYER_PRIVATE_KEY + mnemonics.");

  const [deployer, ...pool] = signers;
  log("INIT", `Deployer: ${deployer.address}  |  Wallet pool: ${pool.length} addresses`);

  const tierRouter   = await ethers.getContractAt("TierRouter",              trAddr);
  const usdc         = await ethers.getContractAt("MockUSDC",                usdcAddr);
  const sf           = await ethers.getContractAt("StabilityFund",           sfAddr);
  const matrixKeeper = mkAddr
    ? await ethers.getContractAt("MatrixKeeper", mkAddr)
    : null;

  // Get T1 entry fee from TierRouter
  let entryFee;
  try {
    const info = await tierRouter.getTierInfo(0);
    entryFee = info.fee || info[1] || 10_000_000n;
  } catch {
    entryFee = 10_000_000n; // $10 default
  }
  log("INIT", `Entry fee T1: $${(entryFee / 1_000_000n).toString()}`);

  // ── Phase 1: SEED ─────────────────────────────────────────────────────────────
  log("PHASE", "=== Phase 1: SEED ===");

  // Find W1 — either from address file or use deployer
  let w1Signer = deployer;
  if (w1Addr) {
    const found = pool.find(s => s.address.toLowerCase() === w1Addr.toLowerCase());
    if (found) w1Signer = found;
    else log("SEED", `W1 address ${w1Addr} not in signer pool; using deployer as ref`);
  }

  // Check if W1 already registered
  let w1Registered = false;
  try {
    const info = await tierRouter.getMemberInfo(w1Signer.address);
    w1Registered = info.isRegistered || info[0];
  } catch {
    try {
      const matA = await ethers.getContractAt(
        ["function getMember(address) view returns (bool isInMatrix, uint256 matrixPos, uint256 cyclesCompleted, uint256 totalEarned, uint256 withdrawable, uint256 escrow)"],
        matAAddr
      );
      const m = await matA.getMember(w1Signer.address);
      w1Registered = m.isInMatrix || m.cyclesCompleted > 0n;
    } catch { /* not registered */ }
  }

  if (!w1Registered) {
    log("SEED", `Registering W1 (${w1Signer.address}) as root...`);
    await registerWallet(w1Signer, ethers.ZeroAddress, tierRouter, pm1Addr, usdc, entryFee, "W1");
  } else {
    log("SEED", `W1 (${w1Signer.address}) already registered — skipping`);
  }

  // Register N_SEED wallets from pool
  let walletsUsed = 0;
  let registered  = 1; // W1 counted
  for (let i = 0; i < Math.min(N_SEED, pool.length); i++) {
    const ok = await registerWallet(pool[i], w1Signer.address, tierRouter, pm1Addr, usdc, entryFee, `seed-${i + 1}`);
    if (ok) { registered++; walletsUsed = i + 1; }
    await sleep(500); // small gap to avoid nonce collisions
  }
  log("SEED", `Seed complete. Registered approx ${registered} wallets.`);
  await printStats(tierRouter, matAAddr, matBAddr, sf);

  // ── Phase 2: IDLE — wait for COMMUNITY_THRESHOLD ──────────────────────────────
  log("PHASE", `=== Phase 2: IDLE — waiting for ${COMMUNITY_THRESHOLD} community wallets ===`);
  log("IDLE", `Polling every ${POLL_MS / 1000}s. Invite community now and watch this counter.`);

  let lastCount = await countRegistered(tierRouter, matAAddr);
  log("IDLE", `Current registered (MatA): ${lastCount}`);

  while (true) {
    const count = await countRegistered(tierRouter, matAAddr);
    if (count !== lastCount) {
      log("IDLE", `New registrations: ${count} (+${count - lastCount})`);
      lastCount = count;
    }
    if (count >= BigInt(COMMUNITY_THRESHOLD)) {
      log("IDLE", `Threshold reached (${count} >= ${COMMUNITY_THRESHOLD}) — starting growth phase`);
      break;
    }
    await sleep(POLL_MS);
  }

  await printStats(tierRouter, matAAddr, matBAddr, sf);

  // ── Phase 3 + 4: GROWTH — 1 wallet/interval + keeper upkeep ─────────────────
  log("PHASE", `=== Phase 3: GROWTH — 1 wallet every ${ADD_INTERVAL_MS / 1000}s ===`);

  let growthIdx = walletsUsed; // continue from where seed left off
  let totalAdded = 0;

  while (true) {
    // 4a. Run keeper upkeep before each addition
    if (matrixKeeper) {
      await runKeeperUpkeep(deployer, matrixKeeper);
    }

    // 4b. Pick next wallet from pool
    if (growthIdx >= pool.length) {
      log("GROWTH", `WARNING: wallet pool exhausted at index ${growthIdx}. Generating fresh wallet...`);
      // Generate a fresh random wallet (testnet only — no private key saved)
      const fresh = ethers.Wallet.createRandom().connect(ethers.provider);
      // Deployer must fund gas + USDC for fresh wallet
      if (!DRY_RUN) {
        await deployer.sendTransaction({ to: fresh.address, value: ethers.parseEther("0.005") });
      }
      const ok = await registerWallet(fresh, w1Signer.address, tierRouter, pm1Addr, usdc, entryFee, `fresh-${growthIdx}`);
      if (ok) { totalAdded++; growthIdx++; }
    } else {
      const wallet = pool[growthIdx];
      // Check if already registered
      let alreadyIn = false;
      try {
        const matA = await ethers.getContractAt(
          ["function getMember(address) view returns (bool isInMatrix, uint256 matrixPos, uint256 cyclesCompleted, uint256 totalEarned, uint256 withdrawable, uint256 escrow)"],
          matAAddr
        );
        const m = await matA.getMember(wallet.address);
        alreadyIn = m.isInMatrix || m.cyclesCompleted > 0n;
      } catch { /* assume not in */ }

      if (!alreadyIn) {
        const ok = await registerWallet(
          wallet, w1Signer.address, tierRouter, pm1Addr, usdc, entryFee,
          `growth-${totalAdded + 1}`
        );
        if (ok) totalAdded++;
      } else {
        log("GROWTH", `wallet[${growthIdx}] ${wallet.address} already in — skipping`);
      }
      growthIdx++;
    }

    // Stats every 10 additions
    if (totalAdded % 10 === 0 && totalAdded > 0) {
      await printStats(tierRouter, matAAddr, matBAddr, sf);
    }

    // MAX_WALLETS guard
    if (MAX_WALLETS > 0 && totalAdded >= MAX_WALLETS) {
      log("GROWTH", `MAX_WALLETS=${MAX_WALLETS} reached — stopping.`);
      break;
    }

    // 4c. Wait before next wallet
    await sleep(ADD_INTERVAL_MS);
  }

  log("DONE", `Growth simulation ended. Total added in growth phase: ${totalAdded}`);
  await printStats(tierRouter, matAAddr, matBAddr, sf);
}

main().catch(e => { console.error(e); process.exit(1); });
