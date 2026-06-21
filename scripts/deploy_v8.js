"use strict";
/**
 * deploy_v8.js  --  V8.18 Full Deploy  (all 10 tiers, MATRIX_SIZE=127, auto-keeper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys the complete V8.8 stack:
 *
 *   Shared:   MockUSDC (testnet only)
 *             CNOVAToken · CNOVATreasury
 *             StabilityFund (+ 1% L1 carve to CommunityWallet)
 *             CommunityWallet (First-1000 lifetime USDC pool, 60/40 Genesis/Pioneer)
 *             TierRouter
 *             MatrixFactory (registry / wiring hub)
 *             MatrixKeeper  (Chainlink Automation upkeep)
 *             V8Governance  (DAO)
 *
 *   Per tier: PairManagerV8 · MatA · MatB  (all 10 tiers wired)
 *
 * V8.8 CHANGES vs V8.7
 * --------------------
 *   - Escrow storage removed from FigureEightMatrixV8; orphan fees → CommunityWallet
 *   - CNOVAToken tierMultipliers expanded to T8:160x T9:320x T10:640x
 *   - CommunityWallet deployed and wired into matrices + StabilityFund
 *   - V8.9: communityCarveOutBps=0 (community moved to SplitConfig in matrix)
   - V8.9: devOpsBps split into devBps+opsBps; separate DEV_WALLET / OPS_WALLET
   - V8.9: stabilityBps T1-T3 reduced 600→500; communityBps=100 in SplitConfig
   - V8.9: CNOVAToken.totalBurned tracker added; getVelocityGates bool[10] fixed
 *
 * ARCHITECTURE NOTE
 * -----------------
 * MatrixFactory no longer deploys FigureEightMatrixV8 contracts (EIP-170 limit).
 * Instead: deploy script deploys each MatA/MatB directly, then calls
 * MatrixFactory.registerPair() which validates ownership, wires, and records them.
 *
 * BPS SPLITS (V8.7/V8.8 — verified Jun 10 2026)
 * -----------------------------------------------
 * T1-T3:  l1=2000 l2=2000 chain=2000 pool=3300 treasury=100 devOps=500  sf=600  cw=6bps
 * T4-T5:  l1=2000 l2=2000 chain=2000 pool=3100 treasury=100 devOps=600  sf=500  cw=5bps
 * T6-T7:  l1=2000 l2=1750 chain=1750 pool=2950 treasury=200 devOps=700  sf=500  cw=5bps
 * T8-T10: l1=2000 l2=1750 chain=1750 pool=2750 treasury=200 devOps=800  sf=500  cw=5bps
 * (CW BPS are carved from SF share at SF level, not matrix level — sums to 10000)
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY   Gas-paying deployer
 *   W1_PRIVATE_KEY         Account #1 / root wallet
 *   DEV_WALLET_ADDRESS     Dev wallet (default: deployer)
 *   OPS_WALLET_ADDRESS     Ops wallet (default: deployer)
 *   ADMIN_WALLET_ADDRESS   Admin/owner   (default: deployer)
 *   USDC_ADDRESS           Reuse existing USDC; omit to deploy MockUSDC
 *   MATRIX_SIZE            127 (default) | 15 (quick dev cycle)
 *   DEPLOY_TIERS           Comma-separated list e.g. "1,2" (default: "1,2,3,4,5,6,7,8,9,10")
 *   ADDRESSES_FILE         Output filename (default: deployed_addresses_v8_20.json)
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
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_20.json"
);

// ── Config ────────────────────────────────────────────────────────────────────
// MATRIX_SIZE: 127 = 2^7-1 (complete 7-level BFS tree, best pay per cycle).
//              Pass MATRIX_SIZE=15 env var for quick dev cycles.
//              Pass MATRIX_SIZE=64 for the old v8_5 config.
const MATRIX_SIZE    = BigInt(process.env.MATRIX_SIZE || "127");
const DEPLOY_TIERS   = (process.env.DEPLOY_TIERS || "1,2,3,4,5,6,7,8,9,10").split(",").map(Number);

// ── Tier entry fees (USDC 6-decimal) ─────────────────────────────────────────
// T2 restored to $25 — with 64-seat matrices the MatB root accumulates ~$63
// in orphan escrow before cycling out, well above the $25 T2 gate.
const TIER_FEES = [
  10_000_000n,     // T1  $10
  25_000_000n,     // T2  $25
  50_000_000n,     // T3  $50
  100_000_000n,    // T4  $100
  250_000_000n,    // T5  $250
  500_000_000n,    // T6  $500
  1_000_000_000n,  // T7  $1,000
  2_500_000_000n,  // T8  $2,500
  5_000_000_000n,  // T9  $5,000
  10_000_000_000n, // T10 $10,000
];

// ── V8.19 BPS SplitConfigs ────────────────────────────────────────────────────
// Field order MUST match Solidity SplitConfig struct (10 fields):
//   l1Bps, chainBps, poolBps, treasuryBps, stabilityBps, devBps, opsBps, communityBps, buybackBps, liquidityBps
//
// V8.19 changes from V8.18 (June 2026):
//   Added liquidityBps=200 (2%) per entry → liquidityReserve (CNOVA/USDC LP)
//   T1-T3: pool 4500→4400 (−100), sf 1300→1200 (−100), lq 0→200 (+200), bbr 100→100
//   The LQ reserve feeds Aerodrome CNOVA/USDC LP at mainnet. Testnet: held at lq wallet.
//   Frontend display (index.html): Pool=44%, Chain=17%, SF=12%, LQ=2%, L1=10%, Treasury=10%,
//                                   Dev=2%, Ops=1%, Community=1%, Buyback=1%
//
//   [  l1,  chain,  pool, treasury,   sf,  dev,  ops,  cw,  bbr,   lq] sum
const SPLITS_T1_T3  = [1000,  1700,  4400,    1000, 1200,  200,  100, 100,  100,  200]; // 10000 ✓  pool=44% sf=12%
const SPLITS_T4_T5  = [2000,  2000,  2600,    1600,  800,  360,  240, 100,  100,  200]; // 10000 ✓
const SPLITS_T6_T7  = [2000,  1750,  2450,    1800,  800,  420,  280, 100,  200,  200]; // 10000 ✓
const SPLITS_T8_T10 = [2000,  1750,  2250,    1900,  800,  480,  320, 100,  200,  200]; // 10000 ✓

// ── Chain pay BPS per level (6 levels, must sum to chainBps for that tier) ───
// T1-T3:  chain=1700  →  850/340/255/127/64/64   = 1700
// T4-T5:  chain=2000  →  1000/400/300/150/75/75  = 2000
// T6-T10: chain=1750  →  875/350/262/131/66/66   = 1750
const CHAIN_PAY_T1_T3  = [850, 340, 255, 127, 64, 64];   // sum=1700 ✓
const CHAIN_PAY_T4_T5  = [1000, 400, 300, 150, 75, 75];  // sum=2000 ✓
const CHAIN_PAY_T6_T10 = [875, 350, 262, 131, 66, 66];   // sum=1750 ✓

function tierSplits(tierNum) {
  if (tierNum <= 3) return SPLITS_T1_T3;
  if (tierNum <= 5) return SPLITS_T4_T5;
  if (tierNum <= 7) return SPLITS_T6_T7;
  return SPLITS_T8_T10;
}
function tierChainPay(tierNum) {
  if (tierNum <= 3) return CHAIN_PAY_T1_T3;
  if (tierNum <= 5) return CHAIN_PAY_T4_T5;
  return CHAIN_PAY_T6_T10;
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
  const nonceMgr = new NonceManager(rawSigner);
  // Base Sepolia throttle: 3s pause before every TX + re-sync nonce from chain each time.
  // Re-syncing guards against external nonce consumers (keeper, scheduler) that may fire
  // during the 30-45 min deploy window and cause "nonce too low" errors.
  const _origSend = nonceMgr.sendTransaction.bind(nonceMgr);
  nonceMgr.sendTransaction = async (tx) => {
    await sleep(3000);
    const chainNonce = await rawSigner.provider.getTransactionCount(rawSigner.address, "pending");
    nonceMgr.reset(chainNonce);
    return _origSend(tx);
  };
  const deployer    = nonceMgr;
  const deployerAddr = rawSigner.address;

  if (!process.env.W1_PRIVATE_KEY) {
    console.error("  ✗  W1_PRIVATE_KEY missing from .env");
    process.exit(1);
  }

  const w1               = new ethers.Wallet(process.env.W1_PRIVATE_KEY);
  const accountOne       = w1.address;
  const devWallet        = process.env.DEV_WALLET_ADDRESS        || deployerAddr;
  const opsWallet        = process.env.OPS_WALLET_ADDRESS        || deployerAddr;
  const admin            = process.env.ADMIN_WALLET_ADDRESS      || deployerAddr;
  // V8.19: liquidityReserve — CNOVA/USDC LP wallet. Defaults to opsWallet until mainnet LP deployed.
  const liquidityReserve = process.env.LIQUIDITY_RESERVE_ADDRESS || opsWallet;

  console.log("\n  V8.20 Deploy — Pool=44% Chain=17% SF=12% LQ=2% L1=10% Treasury=10% Dev=2% Ops/CW/BBR=1% each");
  sep();
  console.log(`  Deployer        : ${deployerAddr}`);
  console.log(`  AccountOne      : ${accountOne}`);
  console.log(`  Admin           : ${admin}`);
  console.log(`  DevWallet       : ${devWallet}`);
  console.log(`  OpsWallet       : ${opsWallet}`);
  console.log(`  LiquidityReserve: ${liquidityReserve}`);
  console.log(`  MatrixSize      : ${MATRIX_SIZE}`);
  console.log(`  Tiers           : T${DEPLOY_TIERS.join(", T")}`);
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
    [usdcAddr, admin],
    "StabilityFund"
  );
  const sfAddr = await stabilityFund.getAddress();

  // Seed SF with per-tier entry fees (TierRouter wired after TierRouter deploy)
  for (const t of DEPLOY_TIERS) {
    await (await stabilityFund.setTierFee(t - 1, TIER_FEES[t - 1])).wait();
  }
  console.log("  ↳  Tier entry fees set in StabilityFund");

  // ── 4b. CNOVABuybackReserve ──────────────────────────────────────────────
  // Deployed with aerodromeRouter=ZeroAddress → testnet stub mode
  // (triggerBuyback() emits BuybackQueued event, no real DEX swap)
  sep("CNOVABuybackReserve");
  const CNOVABuybackReserve = await ethers.getContractFactory("CNOVABuybackReserve", deployer);
  const buybackReserve      = await deploy(
    CNOVABuybackReserve,
    [usdcAddr, cnovaAddr, ethers.ZeroAddress, ethers.ZeroAddress, admin],
    "CNOVABuybackReserve"
  );
  const bbrAddr = await buybackReserve.getAddress();

  // Wire BBR into SF (sliding withdrawal fee forwards here when SF healthy)
  await (await stabilityFund.setBuybackReserve(bbrAddr)).wait();
  console.log("  ↳  StabilityFund.setBuybackReserve OK");

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
      usdc:       usdcAddr,
      cnova:      cnovaAddr,
      treasury:   treasuryAddr,
      devWallet:  devWallet,
      opsWallet:  opsWallet,
      accountOne: accountOne,
      admin:      admin,             // factory wires over ownership
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
    // BuybackReserve
    await (await matA.setBuybackReserve(bbrAddr)).wait();
    await (await matB.setBuybackReserve(bbrAddr)).wait();
    // V8.19: LiquidityReserve
    await (await matA.setLiquidityReserve(liquidityReserve)).wait();
    await (await matB.setLiquidityReserve(liquidityReserve)).wait();
    // Circular chain: matA.chainNext = matB, matB.chainNext = matA (single pair loop)
    await (await matA.setChainNext(matBAddr)).wait();
    await (await matB.setChainNext(matAAddr)).wait();
    console.log(`       Matrix wiring complete T${tierNum}`);

    // Register tier in TierRouter (tierIndex, pairManager, entryFee)
    await (await tierRouter.registerTier(tIdx, pmAddr, fee)).wait();
    // Set tierMatrixAAddr / tierMatrixBAddr in TierRouter (required by manualUpgrade + onCrossToMatB)
    await (await tierRouter.setTierMatrices(tIdx, matAAddr, matBAddr)).wait();
    // Authorize matrices with TierRouter (required for handleCycleOut)
    await (await tierRouter.registerMatrix(matAAddr, tIdx)).wait();
    await (await tierRouter.registerMatrix(matBAddr, tIdx)).wait();
    console.log(`       TierRouter.registerTier + setTierMatrices + registerMatrix T${tierNum} OK`);

    // v8.6: Close velocity gate for T2-T7. Keeper auto-opens each one
    // when the previous tier's MatB reaches 80% occupancy.
    if (tierNum > 1) {
      await (await tierRouter.setTierVelocityGreen(tIdx, false)).wait();
      console.log(`       Velocity gate T${tierNum} CLOSED (keeper opens at 80% MatB fill)`);
    } else {
      console.log(`       Velocity gate T1 OPEN (T1 always open for registration)`);
    }

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

  // Wire keeper into TierRouter (required for setTierVelocityGreen + setDeflationState)
  // CRITICAL: without this call, TierRouter.matrixKeeper = address(0) and every
  // performUpkeep reverts with "TR: not keeper" — keeper is completely non-functional.
  await (await tierRouter.setMatrixKeeper(keeperAddr)).wait();
  console.log("  ↳  TierRouter.setMatrixKeeper OK");

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

  // V8.20: owner keeps emergency backstop on every target (Ownable/Ownable2Step
  // unchanged) -- this wires the SEPARATE co-governance address so V8Governance's
  // execute() calls actually succeed instead of reverting with an ownership error.
  // Previously (through V8.19) this wiring never happened: governance proposals
  // could be created and voted on but execute() always reverted for every param
  // except the 3 self-governed ones (votingPeriod/timelockPeriod/quorumBps).
  await (await keeper.setGovernance(govAddr)).wait();
  await (await tierRouter.setGovernance(govAddr)).wait();
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setGovernance(govAddr)).wait();
    await (await mB.setGovernance(govAddr)).wait();
  }
  // V8.20 second wave: StabilityFund and CNOVABuybackReserve are both already
  // deployed by this point (steps 4/6 above) -- wire them in now alongside
  // everything else. CNOVADirectSale and CommunityWallet deploy AFTER this
  // section (9c/9d below), so their setGovernance/GOVERNOR_ROLE wiring happens
  // right after each of those deploys instead.
  await (await stabilityFund.setGovernance(govAddr)).wait();
  await (await buybackReserve.setGovernance(govAddr)).wait();
  console.log("  ↳  V8Governance deployed + wired (owner retains backstop, governance co-governs)");

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

  // ── 9c. CommunityWallet ──────────────────────────────────────────────────────
  // First-1000 members lifetime USDC pool.
  //   • 60/40 Genesis/Pioneer split (DAO-adjustable)
  //   • 50% distributes monthly, 50% rolls into next round
  //   • Funded by: (1) orphan fees from each matrix, (2) 1% SF L1 carve
  //   • TierRouter has ENROLLOR_ROLE — auto-enrolls first 1000 unique addresses
  sep("CommunityWallet");
  const CommunityWallet = await ethers.getContractFactory("CommunityWallet", deployer);
  const cw     = await deploy(CommunityWallet, [usdcAddr, admin], "CommunityWallet");
  const cwAddr = await cw.getAddress();

  // Grant ENROLLOR_ROLE to TierRouter via setEnrollor() (owner-gated wrapper)
  await (await cw.setEnrollor(trAddr)).wait();
  console.log(`  ↳  setEnrollor(TierRouter) OK — TierRouter can now enroll first-1000 members`);

  // V8.20: grant GOVERNOR_ROLE to V8Governance. CommunityWallet's setGenesisBps/
  // setDistributeRatio/setDistributeInterval are GOVERNOR_ROLE-gated and have
  // existed since V8.8/V8.9 -- this grant never existed before V8.20, so the
  // DAO had zero call path into CommunityWallet despite the role-gating already
  // being in place.
  const CW_GOVERNOR_ROLE = await cw.GOVERNOR_ROLE();
  await (await cw.grantRole(CW_GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ↳  GOVERNOR_ROLE granted to V8Governance on CommunityWallet (${govAddr})`);

  // Wire CommunityWallet address into TierRouter (activates enroll() hook in register())
  await (await tierRouter.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  TierRouter.setCommunityWallet OK — enroll() hook active on every register()`);

  // Wire CommunityWallet into StabilityFund (triggers 1% L1 carve)
  await (await stabilityFund.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  StabilityFund.setCommunityWallet OK (communityCarveOutBps=0 in V8.9 -- carve is in SplitConfig)`);

  // Wire CommunityWallet into every deployed matrix (orphan fees route here)
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setCommunityWallet(cwAddr)).wait();
    await (await mB.setCommunityWallet(cwAddr)).wait();
    console.log(`  ↳  T${tierNum} MatA + MatB → CommunityWallet set`);
  }
  console.log("  ↳  CommunityWallet fully wired into SF + all matrices");

  // Wire CommunityWallet into MatrixKeeper (enables distributeReady() → distribute() via Chainlink)
  await (await keeper.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  MatrixKeeper.setCommunityWallet OK — monthly distribution auto-trigger active`);

  // ── 9d. CNOVADirectSale ──────────────────────────────────────────────────────
  // Investor CNOVA purchase contract (bonding curve, no matrix participation
  // required) — see buy.html. Routes USDC to Treasury (floor backing) / SF /
  // liquidityReserve per-purchase, mints CNOVA to the buyer. Whale caps default
  // on (maxTxBps=1%, maxWalletBps=5%) — see [[cnova_direct_sale]] memory note.
  sep("CNOVADirectSale");
  const DS_SF_TARGET_USD = Number(process.env.DS_SF_TARGET_USD || 500);
  const DS_LQ_TARGET_USD = Number(process.env.DS_LQ_TARGET_USD || 1000);
  const dsSfTarget = BigInt(DS_SF_TARGET_USD) * 1_000_000n;
  const dsLqTarget = BigInt(DS_LQ_TARGET_USD) * 1_000_000n;

  const CNOVADirectSale = await ethers.getContractFactory("CNOVADirectSale", deployer);
  const directSale = await deploy(
    CNOVADirectSale,
    [usdcAddr, cnovaAddr, treasuryAddr, sfAddr, liquidityReserve, dsSfTarget, dsLqTarget],
    "CNOVADirectSale"
  );
  const dsAddr = await directSale.getAddress();
  console.log(`  ↳  SF target $${DS_SF_TARGET_USD} / LQ target $${DS_LQ_TARGET_USD}`);

  // CNOVADirectSale.buyCNOVA() calls cnova.mintDirect() — needs MINTER_ROLE,
  // same role already granted to every matrix above.
  await (await cnova.grantRole(MINTER_ROLE, dsAddr)).wait();
  console.log(`  ↳  MINTER_ROLE granted to CNOVADirectSale (${dsAddr})`);

  // V8.20: wire governance co-control (setMaxTxBps/setMaxWalletBps/setSfTargetDS/
  // setLqTargetDS). directSale deploys after V8Governance, so this couldn't be
  // done in the main governance-wiring block above.
  await (await directSale.setGovernance(govAddr)).wait();
  console.log(`  ↳  CNOVADirectSale.setGovernance OK (${govAddr})`);

  // ── 10a. Save addresses BEFORE W1 seed (so a seed failure doesn't lose addresses) ──
  {
    sep("Save Addresses");
    const tierAddresses = {};
    for (const t of DEPLOY_TIERS) tierAddresses[`T${t}`] = deployed[t];
    const out = {
      network: (await ethers.provider.getNetwork()).name,
      deployedAt: new Date().toISOString(),
      matrixSize: Number(MATRIX_SIZE),
      deployer: deployerAddr, admin, accountOne, devWallet, opsWallet,
      usdc: usdcAddr, cnova: cnovaAddr, treasury: treasuryAddr,
      stabilityFund: sfAddr, buybackReserve: bbrAddr, tierRouter: trAddr,
      matrixFactory: mfAddr, matrixKeeper: keeperAddr,
      v8Governance: govAddr, communityWallet: cwAddr,
      liquidityReserve, directSale: dsAddr, tiers: tierAddresses,
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
      console.log(`  ⚠  W1 registration failed: ${e.reason || e.message}`);
      if (e.data) console.log(`     Revert data: ${e.data}`);
      console.log(`     Run scripts/seed_w1.js manually after deploy.`);
    }
  }

  // ── 11. Final summary ────────────────────────────────────────────────────
  sep("Deploy Complete");
  console.log(`  Network      : ${(await ethers.provider.getNetwork()).name}`);
  console.log(`  MockUSDC     : ${usdcAddr}`);
  console.log(`  CNOVAToken   : ${cnovaAddr}`);
  console.log(`  Treasury     : ${treasuryAddr}`);
  console.log(`  StabilityFund: ${sfAddr}`);
  console.log(`  BuybackReserve:${bbrAddr}`);
  console.log(`  TierRouter   : ${trAddr}`);
  console.log(`  MatrixFactory: ${mfAddr}`);
  console.log(`  MatrixKeeper : ${keeperAddr}`);
  console.log(`  V8Governance : ${govAddr}`);
  console.log(`  CommunityWallet:${cwAddr}`);
  for (const t of DEPLOY_TIERS) {
    console.log(`  T${t.toString().padStart(2,'0')} PM:${deployed[t].pm.slice(0,10)} MatA:${deployed[t].matA.slice(0,10)} MatB:${deployed[t].matB.slice(0,10)}`);
  }
  sep();
  console.log(`  Addresses file: ${require("path").basename(ADDRESSES_FILE)}`);
  console.log("  V8.20 Deploy complete.\n");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
