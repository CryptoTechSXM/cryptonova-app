"use strict";
/**
 * deploy_v8.js  --  V8.1 "Elevator" Full Deploy  (T1-T7 scaffold, Phase 1 active)
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys the complete V8.1 stack:
 *
 *   Shared:   MockUSDC (testnet only)
 *             CNOVAToken · CNOVATreasury
 *             StabilityFund
 *             TierRouter
 *             MatrixFactory (registry / wiring hub)
 *             MatrixKeeper  (Chainlink Automation upkeep)
 *             V8Governance  (DAO)
 *
 *   Per tier: PairManagerV8 · MatA · MatB  (all 7 tiers wired below)
 *
 * ARCHITECTURE NOTE
 * -----------------
 * MatrixFactory no longer deploys FigureEightMatrixV8 contracts (EIP-170 limit).
 * Instead: deploy script deploys each MatA/MatB directly, then calls
 * MatrixFactory.registerPair() which validates ownership, wires, and records them.
 *
 * BPS SPLITS (V8.1 Option B — revised Jun 7 2026, corrected Jun 8 2026)
 * -----------------------------------------------------------------------
 * StabilityFund backs CNOVA floor price directly — must be 15% to hit $0.03 start price.
 * (50 CNOVA per T1 entry, $10 fee: floor = sfBal/supply = $1.50/50 = $0.03)
 * Treasury = DAO reserve only (2% — small, grows via buyback profits).
 * T1-T3: l1=2000 l2=300 l3=200 chain=2000 pool=3300 treasury=200  devOps=500  stability=1500
 * T4-T5: l1=2000 l2=300 l3=200 chain=2000 pool=2800 treasury=200  devOps=700  stability=1800
 * T6-T7: l1=2000 l2=300 l3=200 chain=1750 pool=2550 treasury=200  devOps=800  stability=2200
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY   Gas-paying deployer
 *   W1_PRIVATE_KEY         Account #1 / root wallet
 *   DEV_WALLET_ADDRESS     DevOps wallet (default: deployer)
 *   ADMIN_WALLET_ADDRESS   Admin/owner   (default: deployer)
 *   USDC_ADDRESS           Reuse existing USDC; omit to deploy MockUSDC
 *   MATRIX_SIZE            64 (default — mainnet launch size) | 15 (quick dev cycle)
 *   DEPLOY_TIERS           Comma-separated list e.g. "1,2" (default: "1,2")
 *   ADDRESSES_FILE         Output filename (default: deployed_addresses_v8_5.json)
 *
 * Run: npx hardhat run scripts/deploy_v8.js --network baseSepolia
 */

const { ethers }      = require("hardhat");
const { NonceManager } = require("ethers"); // v6 local nonce tracking
const fs              = require("fs");
const path            = require("path");
require("dotenv").config();

// ── Addresses output file ─────────────────────────────────────────────────────
// v8_1 = size-15 testnet (retired).  v8_2 = size-64 pre-mainnet stress test.
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_5.json"
);

// ── Config ────────────────────────────────────────────────────────────────────
// MATRIX_SIZE: 64 for final pre-mainnet test and mainnet launch.
//              Pass MATRIX_SIZE=15 env var to reuse the small-matrix dev config.
const MATRIX_SIZE    = BigInt(process.env.MATRIX_SIZE || "64");
const DEPLOY_TIERS   = (process.env.DEPLOY_TIERS || "1,2").split(",").map(Number);

// ── Tier entry fees (USDC 6-decimal) ─────────────────────────────────────────
// T2 restored to $25 — with 64-seat matrices the MatB root accumulates ~$63
// in orphan escrow before cycling out, well above the $25 T2 gate.
const TIER_FEES = [
  10_000_000n,   // T1  $10
  25_000_000n,   // T2  $25  (mainnet fee — affordable at 64-seat scale)
  50_000_000n,   // T3  $50
  100_000_000n,  // T4  $100
  250_000_000n,  // T5  $250
  500_000_000n,  // T6  $500
  1_000_000_000n // T7  $1000
];

// ── V8.1 BPS SplitConfigs ─────────────────────────────────────────────────────
// Field order MUST match Solidity SplitConfig struct:
//   l1Bps, l2Bps, l3Bps, chainBps, poolBps, treasuryBps, devOpsBps, stabilityBps
const SPLITS_T1_T3 = [2000, 300, 200, 2000, 3300,  200, 500, 1500]; // sum=10000  stability=15% treasury=2%
const SPLITS_T4_T5 = [2000, 300, 200, 2000, 2800,  200, 700, 1800]; // sum=10000  stability=18% treasury=2%
const SPLITS_T6_T7 = [2000, 300, 200, 1750, 2550,  200, 800, 2200]; // sum=10000  stability=22% treasury=2%

// ── Chain pay BPS per level (6 levels, must sum to chainBps) ─────────────────
// T1-T5: chain=2000  →  1000/400/300/150/75/75   = 2000
// T6-T7: chain=1750  →  875/350/262/131/66/66    = 1750
const CHAIN_PAY_T1_T5 = [1000, 400, 300, 150, 75, 75];
const CHAIN_PAY_T6_T7 = [875, 350, 262, 131, 66, 66];

function tierSplits(tierNum) {
  if (tierNum <= 3) return SPLITS_T1_T3;
  if (tierNum <= 5) return SPLITS_T4_T5;
  return SPLITS_T6_T7;
}
function tierChainPay(tierNum) {
  return tierNum <= 5 ? CHAIN_PAY_T1_T5 : CHAIN_PAY_T6_T7;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt   = a   => `${a.slice(0,10)}…`;
const sleep = ms  => new Promise(r => setTimeout(r, ms));
function sep(label = "") {
  if (label) console.log(`\n  ── ${label} ${"─".repeat(Math.max(1, 56 - label.length))}`);
  else        console.log("  " + "─".repeat(60));
}

async function deploy(factory, args = [], label = "") {
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  if (label) console.log(`  ✓  ${label.padEnd(28)} ${addr}`);
  return c;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [rawSigner] = await ethers.getSigners();
  // NonceManager tracks nonces locally — prevents "nonce too low" on slow public RPCs
  // that return stale eth_getTransactionCount after a tx is mined.
  const deployer    = new NonceManager(rawSigner);
  const deployerAddr = rawSigner.address;

  if (!process.env.W1_PRIVATE_KEY) {
    console.error("  ✗  W1_PRIVATE_KEY missing from .env");
    process.exit(1);
  }

  const w1          = new ethers.Wallet(process.env.W1_PRIVATE_KEY);
  const accountOne  = w1.address;
  const devOps      = process.env.DEV_WALLET_ADDRESS   || deployerAddr;
  const admin       = process.env.ADMIN_WALLET_ADDRESS || deployerAddr;

  console.log("\n  V8.1 Elevator Deploy");
  sep();
  console.log(`  Deployer   : ${deployerAddr}`);
  console.log(`  AccountOne : ${accountOne}`);
  console.log(`  Admin      : ${admin}`);
  console.log(`  DevOps     : ${devOps}`);
  console.log(`  MatrixSize : ${MATRIX_SIZE}`);
  console.log(`  Tiers      : T${DEPLOY_TIERS.join(", T")}`);
  sep();

  // ── 1. USDC ────────────────────────────────────────────────────────────────
  sep("USDC");
  let usdc;
  if (process.env.USDC_ADDRESS) {
    usdc = await ethers.getContractAt("MockUSDC", process.env.USDC_ADDRESS, deployer);
    console.log(`  ↳  Existing USDC       ${process.env.USDC_ADDRESS}`);
  } else {
    const MockUSDC = await ethers.getContractFactory("MockUSDC", deployer);
    usdc = await deploy(MockUSDC, [], "MockUSDC");
    // Mint 10M to deployer for testnet
    await (await usdc.mint(deployerAddr, 10_000_000_000_000n)).wait();
    console.log("  ↳  Minted 10M USDC to deployer");
  }
  const usdcAddr = await usdc.getAddress();

  // ── 2. CNOVA Token ────────────────────────────────────────────────────────
  sep("CNOVA Token");
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken", deployer);
  const cnova      = await deploy(CNOVAToken, [deployerAddr], "CNOVAToken");
  const cnovaAddr  = await cnova.getAddress();

  // ── 3. Treasury ───────────────────────────────────────────────────────────
  sep("Treasury");
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury", deployer);
  const treasury      = await deploy(CNOVATreasury, [cnovaAddr, usdcAddr, admin], "CNOVATreasury");
  const treasuryAddr  = await treasury.getAddress();

  // ── 4. StabilityFund ──────────────────────────────────────────────────────
  sep("StabilityFund");
  const StabilityFund = await ethers.getContractFactory("StabilityFund", deployer);
  const stabilityFund = await deploy(
    StabilityFund,
    [usdcAddr, cnovaAddr, admin],
    "StabilityFund"
  );
  const sfAddr = await stabilityFund.getAddress();

  // Seed SF with per-tier entry fees (TierRouter wired after TierRouter deploy)
  for (const t of DEPLOY_TIERS) {
    await (await stabilityFund.setTierFee(t - 1, TIER_FEES[t - 1])).wait();
  }
  console.log("  ↳  Tier entry fees set in StabilityFund");

  // ── 5. TierRouter ────────────────────────────────────────────────────────
  sep("TierRouter");
  const TierRouter = await ethers.getContractFactory("TierRouter", deployer);
  const tierRouter  = await deploy(
    TierRouter,
    [usdcAddr, admin],
    "TierRouter"
  );
  const trAddr = await tierRouter.getAddress();

  // Wire TierRouter into StabilityFund (needed for L2 routing)
  await (await stabilityFund.setTierRouter(trAddr)).wait();
  console.log("  ↳  StabilityFund.setTierRouter OK");

  // ── 6. MatrixFactory ─────────────────────────────────────────────────────
  sep("MatrixFactory");
  const MatrixFactory = await ethers.getContractFactory("MatrixFactory", deployer);
  const matFactory    = await deploy(
    MatrixFactory,
    [admin, trAddr, sfAddr, ethers.ZeroAddress], // matrixKeeper set later
    "MatrixFactory"
  );
  const mfAddr = await matFactory.getAddress();

  // ── 7. PairManagers + Matrix pairs ───────────────────────────────────────
  sep("Tier Pairs");

  const F8V8  = await ethers.getContractFactory("FigureEightMatrixV8", deployer);
  const PMV8  = await ethers.getContractFactory("PairManagerV8", deployer);

  const deployed = {};  // t => { pm, matA, matB }

  for (const tierNum of DEPLOY_TIERS) {
    const tIdx   = tierNum - 1;   // 0-based
    const fee    = TIER_FEES[tIdx];
    const splits = tierSplits(tierNum);
    const cpBps  = tierChainPay(tierNum);

    console.log(`\n  T${tierNum} (fee=$${Number(fee) / 1e6})`);

    // PairManager — constructor(usdc, entryFee, admin); tierRouter wired post-deploy
    const pm   = await deploy(PMV8, [usdcAddr, fee, admin], `PairManagerV8 T${tierNum}`);
    const pmAddr = await pm.getAddress();
    await (await pm.setTierRouter(trAddr)).wait();
    console.log(`       PairManagerV8.setTierRouter T${tierNum} OK`);

    // Configure tier in MatrixFactory
    await (await matFactory.configureTier(tIdx, pmAddr, MATRIX_SIZE)).wait();
    console.log(`       MatrixFactory.configureTier T${tierNum} OK`);

    // Deploy params struct
    const dpStruct = {
      usdc:         usdcAddr,
      cnova:        cnovaAddr,
      treasury:     treasuryAddr,
      devOpsWallet: devOps,
      accountOne:   accountOne,
      admin:        admin,           // factory wires over ownership
    };

    // Deploy MatA
    const matA = await deploy(
      F8V8,
      [dpStruct, fee, MATRIX_SIZE, true, tIdx, splits, cpBps],
      `MatA T${tierNum}`
    );

    // Deploy MatB
    const matB = await deploy(
      F8V8,
      [dpStruct, fee, MATRIX_SIZE, false, tIdx, splits, cpBps],
      `MatB T${tierNum}`
    );

    const matAAddr = await matA.getAddress();
    const matBAddr = await matB.getAddress();

    // Both must be owned by admin before registerPair
    // (they are because dpStruct.admin = admin which is the deployer here)

    // Register pair: factory validates, wires, records
    await (await matFactory.registerPair(tIdx, matAAddr, matBAddr)).wait();
    console.log(`       MatrixFactory.registerPair T${tierNum} OK`);

    // ── Wire matrices (factory can't do this — it doesn't own them) ──────────
    // Partner link
    await (await matA.setPartner(matBAddr)).wait();
    await (await matB.setPartner(matAAddr)).wait();
    // TierRouter
    await (await matA.setTierRouter(trAddr)).wait();
    await (await matB.setTierRouter(trAddr)).wait();
    // PairManager
    await (await matA.setPairManager(pmAddr)).wait();
    await (await matB.setPairManager(pmAddr)).wait();
    // StabilityFund
    await (await matA.setStabilityFund(sfAddr)).wait();
    await (await matB.setStabilityFund(sfAddr)).wait();
    // Circular chain: matA.chainNext = matB, matB.chainNext = matA (single pair loop)
    await (await matA.setChainNext(matBAddr)).wait();
    await (await matB.setChainNext(matAAddr)).wait();
    console.log(`       Matrix wiring complete T${tierNum}`);

    // Register tier in TierRouter (tierIndex, pairManager, entryFee)
    await (await tierRouter.registerTier(tIdx, pmAddr, fee)).wait();
    // Authorize matrices with TierRouter (required for handleCycleOut)
    await (await tierRouter.registerMatrix(matAAddr, tIdx)).wait();
    await (await tierRouter.registerMatrix(matBAddr, tIdx)).wait();
    console.log(`       TierRouter.registerTier + registerMatrix T${tierNum} OK`);

    // Register matrix pair with PairManager
    await (await pm.addPair(matAAddr, matBAddr)).wait();
    console.log(`       PairManager.addPair T${tierNum} OK`);

    // Authorize StabilityFund to receive from these matrices
    await (await stabilityFund.setMatrixAuthorized(matAAddr, true)).wait();
    await (await stabilityFund.setMatrixAuthorized(matBAddr, true)).wait();

    // Authorize matrices as callers on CNOVATreasury (required by onlyMatrix guard)
    await (await treasury.setAuthorizedCaller(matAAddr, true)).wait();
    await (await treasury.setAuthorizedCaller(matBAddr, true)).wait();
    console.log(`       Treasury.setAuthorizedCaller T${tierNum} OK`);

    deployed[tierNum] = { pm: pmAddr, matA: matAAddr, matB: matBAddr };
  }

  // ── 8. MatrixKeeper ──────────────────────────────────────────────────────
  sep("MatrixKeeper");
  const MatrixKeeper = await ethers.getContractFactory("MatrixKeeper", deployer);
  const keeper       = await deploy(MatrixKeeper, [trAddr, sfAddr], "MatrixKeeper");
  const keeperAddr   = await keeper.getAddress();

  // Wire keeper into StabilityFund (needed for ghost entry authorization)
  await (await stabilityFund.setMatrixKeeper(keeperAddr)).wait();
  console.log("  ↳  StabilityFund.setMatrixKeeper OK");

  // Register tier PairManagers with keeper
  for (const tierNum of DEPLOY_TIERS) {
    await (await keeper.setPairManager(tierNum - 1, deployed[tierNum].pm)).wait();
  }
  console.log("  ↳  PairManagers registered with MatrixKeeper");

  // Point matrices at keeper
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setMatrixKeeper(keeperAddr)).wait();
    await (await mB.setMatrixKeeper(keeperAddr)).wait();
  }
  console.log("  ↳  MatrixKeeper set on all matrices");

  // Wire matrixKeeper into MatrixFactory (upgrade the immutable isn't possible,
  // so we note: factory was deployed with ZeroAddress for keeper;
  // future pairs registered via factory will call setMatrixKeeper manually)

  // ── 9. V8Governance ──────────────────────────────────────────────────────
  sep("V8Governance");
  const V8Gov    = await ethers.getContractFactory("V8Governance", deployer);
  const gov      = await deploy(V8Gov, [cnovaAddr, trAddr, keeperAddr], "V8Governance");
  const govAddr  = await gov.getAddress();

  // Transfer TierRouter ownership to governance (DAO controls param changes)
  // For testnet: keep admin as owner, governance can co-govern via setters
  // (TierRouter setters check owner() OR tierRouter, V8Governance calls setters directly)
  console.log("  ↳  V8Governance deployed (testnet: owner retains control)");

  // ── 9b. Wire CNOVA roles ─────────────────────────────────────────────────
  // CRITICAL: Without MINTER_ROLE, every matrix cycle-out reverts on mintReward().
  // Without GOVERNOR_ROLE, V8Governance cannot tune epoch/vesting params after deploy.
  sep("CNOVA Role Grants");

  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  // Grant MINTER_ROLE to every deployed matrix (MatA + MatB for each tier)
  for (const tierNum of DEPLOY_TIERS) {
    const { matA, matB } = deployed[tierNum];
    await (await cnova.grantRole(MINTER_ROLE, matA)).wait();
    await (await cnova.grantRole(MINTER_ROLE, matB)).wait();
    console.log(`  ↳  MINTER_ROLE granted to T${tierNum} MatA + MatB`);
  }

  // Grant GOVERNOR_ROLE to V8Governance (allows DAO to tune epoch/vesting params)
  await (await cnova.grantRole(GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ↳  GOVERNOR_ROLE granted to V8Governance (${govAddr})`);

  // ── 10a. Save addresses BEFORE W1 seed (so a seed failure doesn't lose addresses) ──
  {
    sep("Save Addresses");
    const tierAddresses = {};
    for (const t of DEPLOY_TIERS) tierAddresses[`T${t}`] = deployed[t];
    const out = {
      network: (await ethers.provider.getNetwork()).name,
      deployedAt: new Date().toISOString(),
      matrixSize: Number(MATRIX_SIZE),
      deployer: deployerAddr, admin, accountOne, devOps,
      usdc: usdcAddr, cnova: cnovaAddr, treasury: treasuryAddr,
      stabilityFund: sfAddr, tierRouter: trAddr,
      matrixFactory: mfAddr, matrixKeeper: keeperAddr,
      v8Governance: govAddr, tiers: tierAddresses,
    };
    fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(out, null, 2));
    console.log(`  ✓  Addresses saved → ${path.basename(ADDRESSES_FILE)}`);
  }

  // ── 10b. Register W1 (Account #1) as position-1 root of T1 MatA ─────────
  // W1 must be registered FIRST so it sits at position-1 (root) and accumulates
  // orphan fees from every subsequent member. Requires SEED_W1_KEY env var.
  // If the key is absent the step is skipped — run scripts/seed_w1.js separately.
  sep("W1 Registration");
  const T1_FEE     = TIER_FEES[0];
  const T1_PM_ADDR = deployed[1].pm; // already an address string from deploy loop
  const w1Key      = process.env.SEED_W1_KEY || process.env.W1_PRIVATE_KEY;

  if (!w1Key) {
    console.log(`  ⚠  SEED_W1_KEY / W1_PRIVATE_KEY not set — skipping W1 seed.`);
    console.log(`     Run: $env:SEED_W1_KEY="0x<key>"; npx hardhat run scripts/seed_w1.js --network baseSepolia`);
  } else {
    try {
      const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);
      const W1_ADDR  = w1Wallet.address;

      // Already registered? (idempotent)
      const alreadyJoined = await tierRouter.globalJoined(W1_ADDR);
      if (alreadyJoined) {
        console.log(`  ✓  W1 (${W1_ADDR}) already registered — skip`);
      } else {
        // Ensure W1 has ETH for gas
        const w1Eth = await ethers.provider.getBalance(W1_ADDR);
        if (w1Eth < ethers.parseEther("0.01")) {
          await (await deployer.sendTransaction({ to: W1_ADDR, value: ethers.parseEther("0.02") })).wait();
          console.log(`  ↳  Funded W1 with 0.02 ETH for gas`);
        }
        // Mint USDC to W1
        await (await usdc.mint(W1_ADDR, T1_FEE)).wait();
        console.log(`  ↳  Minted $${Number(T1_FEE) / 1e6} USDC to W1`);
        // W1 approves T1 PairManager (NOT TierRouter — PM pulls the USDC)
        await (await usdc.connect(w1Wallet).approve(T1_PM_ADDR, T1_FEE)).wait();
        console.log(`  ↳  W1 approved T1 PM (${T1_PM_ADDR.slice(0,10)})`);
        // W1 registers
        await (await tierRouter.connect(w1Wallet).register(ethers.ZeroAddress, { gasLimit: 3_000_000 })).wait();
        console.log(`  ✓  W1 (${W1_ADDR}) registered as T1 MatA root (position-1)`);
      }
    } catch (e) {
      console.log(`  ⚠  W1 registration failed: ${e.reason || e.message?.slice(0, 80)}`);
      console.log(`     Run scripts/seed_w1.js manually after deploy.`);
    }
  }

  // ── 11. Save addresses ────────────────────────────────────────────────────
  sep("Save Addresses");

  const tierAddresses = {};
  for (const tierNum of DEPLOY_TIERS) {
    tierAddresses[`T${tierNum}`] = deployed[tierNum];
  }

  const out = {
    network:        (await ethers.provider.getNetwork()).name,
    deployedAt:     new Date().toISOString(),
    matrixSize:     Number(MATRIX_SIZE),
    deployer:       deployerAddr,
    admin:          admin,
    accountOne:     accountOne,
    devOps:         devOps,
    // Shared contracts
    usdc:           usdcAddr,
    cnova:          cnovaAddr,
    treasury:       treasuryAddr,
    stabilityFund:  sfAddr,
    tierRouter:     trAddr,
    matrixFactory:  mfAddr,
    matrixKeeper:   keeperAddr,
    v8Governance:   govAddr,
    // Tier-specific
    tiers:          tierAddresses,
  };

  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(out, null, 2));
  console.log(`  ↳  Addresses saved → ${ADDRESSES_FILE}`);

  // ── 12. Summary ───────────────────────────────────────────────────────────
  sep("Summary");
  console.log(`  USDC          ${usdcAddr}`);
  console.log(`  CNOVAToken    ${cnovaAddr}`);
  console.log(`  Treasury      ${treasuryAddr}`);
  console.log(`  StabilityFund ${sfAddr}`);
  console.log(`  TierRouter    ${trAddr}`);
  console.log(`  MatrixFactory ${mfAddr}`);
  console.log(`  MatrixKeeper  ${keeperAddr}`);
  console.log(`  V8Governance  ${govAddr}`);
  for (const tierNum of DEPLOY_TIERS) {
    const d = deployed[tierNum];
    console.log(`  T${tierNum} PM/A/B      ${fmt(d.pm)} / ${fmt(d.matA)} / ${fmt(d.matB)}`);
  }
  sep();
  console.log("\n  NEXT STEPS");
  console.log("  1. Register MatrixKeeper with Chainlink Automation (gas limit: 3,000,000)");
  console.log(`     Upkeep target: ${keeperAddr}`);
  console.log("  2. Fund StabilityFund with seed USDC (covers ghost entries)");
  console.log(`     SF address:    ${sfAddr}`);
  console.log("  3. Run bigfill_v8.js to stress-test the T1→T2 upgrade path");
  console.log("  4. Verify contracts on BaseScan:");
  console.log("     npx hardhat verify --network baseSepolia <address> <args...>");
  console.log();
}

main().catch(err => {
  console.error("\n  ✗  Deploy failed:", err.message);
  process.exit(1);
});
