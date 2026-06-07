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
 * BPS SPLITS (V8.1 Option B)
 * --------------------------
 * T1-T3: l1=2500 l2=300 l3=200 chain=2000 pool=3800 treasury=500  devOps=500  stability=200
 * T4-T5: l1=2500 l2=300 l3=200 chain=2000 pool=3300 treasury=800  devOps=700  stability=200
 * T6-T7: l1=2500 l2=300 l3=200 chain=1750 pool=3050 treasury=1200 devOps=800  stability=200
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY   Gas-paying deployer
 *   W1_PRIVATE_KEY         Account #1 / root wallet
 *   DEV_WALLET_ADDRESS     DevOps wallet (default: deployer)
 *   ADMIN_WALLET_ADDRESS   Admin/owner   (default: deployer)
 *   USDC_ADDRESS           Reuse existing USDC; omit to deploy MockUSDC
 *   MATRIX_SIZE            15 (testnet) | 63 (mainnet launch)
 *   DEPLOY_TIERS           Comma-separated list e.g. "1,2" (default: "1,2")
 *
 * Run: npx hardhat run scripts/deploy_v8.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

// ── Addresses output file ─────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses_v8_1.json");

// ── Config ────────────────────────────────────────────────────────────────────
const MATRIX_SIZE    = BigInt(process.env.MATRIX_SIZE || "15");
const DEPLOY_TIERS   = (process.env.DEPLOY_TIERS || "1,2").split(",").map(Number);

// ── Tier entry fees (USDC 6-decimal) ─────────────────────────────────────────
const TIER_FEES = [
  10_000_000n,   // T1 $10
  25_000_000n,   // T2 $25
  50_000_000n,   // T3 $50
  100_000_000n,  // T4 $100
  250_000_000n,  // T5 $250
  500_000_000n,  // T6 $500
  1_000_000_000n // T7 $1000
];

// ── V8.1 BPS SplitConfigs ─────────────────────────────────────────────────────
// Field order MUST match Solidity SplitConfig struct:
//   l1Bps, l2Bps, l3Bps, chainBps, poolBps, treasuryBps, devOpsBps, stabilityBps
const SPLITS_T1_T3 = [2500, 300, 200, 2000, 3800, 500, 500, 200]; // sum=10000
const SPLITS_T4_T5 = [2500, 300, 200, 2000, 3300, 800, 700, 200]; // sum=10000
const SPLITS_T6_T7 = [2500, 300, 200, 1750, 3050, 1200, 800, 200];// sum=10000

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
  const [deployer] = await ethers.getSigners();

  if (!process.env.W1_PRIVATE_KEY) {
    console.error("  ✗  W1_PRIVATE_KEY missing from .env");
    process.exit(1);
  }

  const w1          = new ethers.Wallet(process.env.W1_PRIVATE_KEY);
  const accountOne  = w1.address;
  const devOps      = process.env.DEV_WALLET_ADDRESS   || deployer.address;
  const admin       = process.env.ADMIN_WALLET_ADDRESS || deployer.address;

  console.log("\n  V8.1 Elevator Deploy");
  sep();
  console.log(`  Deployer   : ${deployer.address}`);
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
    usdc = await ethers.getContractAt("IERC20", process.env.USDC_ADDRESS);
    console.log(`  ↳  Existing USDC       ${process.env.USDC_ADDRESS}`);
  } else {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await deploy(MockUSDC, [], "MockUSDC");
    // Mint 10M to deployer for testnet
    await (await usdc.mint(deployer.address, 10_000_000_000_000n)).wait();
    console.log("  ↳  Minted 10M USDC to deployer");
  }
  const usdcAddr = await usdc.getAddress();

  // ── 2. CNOVA Token ────────────────────────────────────────────────────────
  sep("CNOVA Token");
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnova      = await deploy(CNOVAToken, [deployer.address], "CNOVAToken");
  const cnovaAddr  = await cnova.getAddress();

  // ── 3. Treasury ───────────────────────────────────────────────────────────
  sep("Treasury");
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury      = await deploy(CNOVATreasury, [usdcAddr, cnovaAddr, admin], "CNOVATreasury");
  const treasuryAddr  = await treasury.getAddress();

  // ── 4. StabilityFund ──────────────────────────────────────────────────────
  sep("StabilityFund");
  const StabilityFund = await ethers.getContractFactory("StabilityFund");
  const stabilityFund = await deploy(
    StabilityFund,
    [usdcAddr, admin],
    "StabilityFund"
  );
  const sfAddr = await stabilityFund.getAddress();

  // Seed SF with per-tier entry fees
  for (const t of DEPLOY_TIERS) {
    await (await stabilityFund.setTierEntryFee(t - 1, TIER_FEES[t - 1])).wait();
  }
  console.log("  ↳  Tier entry fees set in StabilityFund");

  // ── 5. TierRouter ────────────────────────────────────────────────────────
  sep("TierRouter");
  const TierRouter = await ethers.getContractFactory("TierRouter");
  const tierRouter  = await deploy(
    TierRouter,
    [usdcAddr, cnovaAddr, treasuryAddr, devOps, accountOne, admin, sfAddr],
    "TierRouter"
  );
  const trAddr = await tierRouter.getAddress();

  // ── 6. MatrixFactory ─────────────────────────────────────────────────────
  sep("MatrixFactory");
  const MatrixFactory = await ethers.getContractFactory("MatrixFactory");
  const matFactory    = await deploy(
    MatrixFactory,
    [admin, trAddr, sfAddr, ethers.ZeroAddress], // matrixKeeper set later
    "MatrixFactory"
  );
  const mfAddr = await matFactory.getAddress();

  // ── 7. PairManagers + Matrix pairs ───────────────────────────────────────
  sep("Tier Pairs");

  const F8V8  = await ethers.getContractFactory("FigureEightMatrixV8");
  const PMV8  = await ethers.getContractFactory("PairManagerV8");

  const deployed = {};  // t => { pm, matA, matB }

  for (const tierNum of DEPLOY_TIERS) {
    const tIdx   = tierNum - 1;   // 0-based
    const fee    = TIER_FEES[tIdx];
    const splits = tierSplits(tierNum);
    const cpBps  = tierChainPay(tierNum);

    console.log(`\n  T${tierNum} (fee=$${Number(fee) / 1e6})`);

    // PairManager
    const pm   = await deploy(PMV8, [usdcAddr, cnovaAddr, trAddr, admin, fee], `PairManagerV8 T${tierNum}`);
    const pmAddr = await pm.getAddress();

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

    // Circular chain: matA.chainNext = matB, matB.chainNext = matA (single pair loop)
    await (await matA.setChainNext(matBAddr)).wait();
    await (await matB.setChainNext(matAAddr)).wait();
    console.log(`       Chain wired T${tierNum}: A→B→A`);

    // Register tier in TierRouter
    await (await tierRouter.registerTier(tIdx, pmAddr)).wait();
    console.log(`       TierRouter.registerTier T${tierNum} OK`);

    // Authorize StabilityFund to receive from these matrices
    await (await stabilityFund.authorizeMatrix(matAAddr)).wait();
    await (await stabilityFund.authorizeMatrix(matBAddr)).wait();

    deployed[tierNum] = { pm: pmAddr, matA: matAAddr, matB: matBAddr };
  }

  // ── 8. MatrixKeeper ──────────────────────────────────────────────────────
  sep("MatrixKeeper");
  const MatrixKeeper = await ethers.getContractFactory("MatrixKeeper");
  const keeper       = await deploy(MatrixKeeper, [trAddr, sfAddr], "MatrixKeeper");
  const keeperAddr   = await keeper.getAddress();

  // Register tier PairManagers with keeper
  for (const tierNum of DEPLOY_TIERS) {
    await (await keeper.setPairManager(tierNum - 1, deployed[tierNum].pm)).wait();
  }
  console.log("  ↳  PairManagers registered with MatrixKeeper");

  // Point matrices at keeper
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB);
    await (await mA.setMatrixKeeper(keeperAddr)).wait();
    await (await mB.setMatrixKeeper(keeperAddr)).wait();
  }
  console.log("  ↳  MatrixKeeper set on all matrices");

  // Wire matrixKeeper into MatrixFactory (upgrade the immutable isn't possible,
  // so we note: factory was deployed with ZeroAddress for keeper;
  // future pairs registered via factory will call setMatrixKeeper manually)

  // ── 9. V8Governance ──────────────────────────────────────────────────────
  sep("V8Governance");
  const V8Gov    = await ethers.getContractFactory("V8Governance");
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

  // ── 10. Register W1 (Account #1) as first member in T1 ───────────────────
  sep("W1 Registration");
  const T1_FEE = TIER_FEES[0];
  const usdcDecimals = 6;

  // Deployer approves USDC for W1 registration (testnet: deployer holds USDC)
  await (await usdc.approve(trAddr, T1_FEE)).wait();
  console.log(`  ↳  Approved ${T1_FEE / BigInt(10 ** usdcDecimals)} USDC for W1`);

  // W1 joins via TierRouter.join(referrer=0, tier=1)
  // Note: TierRouter.join() requires the caller to hold USDC; on testnet deployer joins as W1
  try {
    await (await tierRouter.join(ethers.ZeroAddress, 0)).wait(); // tier 0-based
    console.log(`  ✓  W1 (${accountOne}) registered in T1`);
  } catch (e) {
    console.log(`  ⚠  W1 registration skipped (${e.message.slice(0,60)})`);
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
    deployer:       deployer.address,
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
