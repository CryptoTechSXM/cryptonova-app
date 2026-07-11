"use strict";
/**
 * deploy_v8.js  --  V8.31 Full Deploy  (all 10 tiers, MATRIX_SIZE=127, auto-keeper)
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
 *   ADDRESSES_FILE         Output filename (default: deployed_addresses_v8_35.json)
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
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_35.json"
);

// ── Config ────────────────────────────────────────────────────────────────────
// MATRIX_SIZE: 127 = 2^7-1 (complete 7-level BFS tree, best pay per cycle).
//              Pass MATRIX_SIZE=15 env var for quick dev cycles.
//              Pass MATRIX_SIZE=64 for the old v8_5 config.
const MATRIX_SIZE    = BigInt(process.env.MATRIX_SIZE || "127");
const DEPLOY_TIERS   = (process.env.DEPLOY_TIERS || "1,2,3,4,5,6,7,8,9,10").split(",").map(Number);

// ── Multi-pair capacity expansion (V8.35) ─────────────────────────────────────
// PairManager._tryAdvancePair() auto-advances to the next pair at 80% occupancy,
// giving each tier infinite horizontal capacity (T1.1 → T1.2 → T1.3 …).
// New members always register into the ACTIVE pair; natural cycle-outs are
// routed through TierRouter → PairManager → active pair.  Force-cross (keeper)
// stays within each pair via circular chainNext (A→B→A).
// MatrixKeeper auto-discovers all pairs via getPairAt() — no keeper changes needed.
// Index 0 = T1.  Min 1 (at least the primary pair must always be deployed).
const PAIRS_PER_TIER = [3, 2, 2, 1, 1, 1, 1, 1, 1, 1]; // T1=3, T2-T3=2, T4-T10=1

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

// ── V8.32 BPS SplitConfigs (50/2.5/47.5 crossing reserve model) ─────────────
// Field order MUST match Solidity SplitConfig struct (10 fields):
//   l1Bps, chainBps, poolBps, treasuryBps, stabilityBps, devBps, opsBps, communityBps, buybackBps, liquidityBps
//
// V8.32 changes from V8.31: BPS values are now applied to the FULL entry fee (payBase = entryFee).
//   Before BPS distribution: 50% → crossingReserve, 2.5% → direct earnings, 47.5% = splits (sum 4750 BPS).
//
//   At T1 ($10 entry, payBase = $10):
//     L1  direct referrer :  500 bps × $10 = $0.50
//     L2-L6 chain (each) :  270 bps × $10 = $0.27 × 5 = $1.35 total
//     Pool               : 1800 bps × $10 = $1.80 per cycle
//     SF                 :  300 bps × $10 = $0.30
//     Treasury (CNOVA)   :  500 bps × $10 = $0.50
//     Dev                :  100 bps × $10 = $0.10
//     Ops                :   50 bps × $10 = $0.05
//     Community          :   50 bps × $10 = $0.05
//     Buyback (CNOVA)    :   50 bps × $10 = $0.05
//     Liquidity reserve  :   50 bps × $10 = $0.05
//   Sum of splits: 500+1350+1800+500+300+100+50+50+50+50 = 4750 ✓
//   Total: 5000 (cross) + 250 (instant) + 4750 (splits) = 10000 ✓
//
//   Crossing math (all tiers):
//     Crossing cost  = 50% of entry fee (funded from crossingReserve first, then withdrawable)
//     Pool per cycle = 1800/10000 × $10 = $1.80 at T1  (unchanged)
//     Cycles to next cross (after reserve exhausted) = ceil(50%/18%) = 3 cycles ✓
//     Buffer: $0.40 at T1 (3 × $1.80 = $5.40 > $5.00 crossing cost)
//
//   [  l1, chain,  pool, treasury,   sf,  dev,  ops,  cw,  bbr,   lq] sum
const SPLITS_ALL    = [ 500,  1350,  1800,     500,  300,  100,   50,  50,   50,   50]; // 4750 BPS of entryFee ✓

// ── Chain pay BPS per level (6 slots, must sum to chainBps = 3000) ────────────
// Option B: L2-L6 equal (600 each = 3000), L7 slot unused (0).
// "L2–L6 earn identically; L1 gets a small recruiting premium."
const CHAIN_PAY_ALL = [270, 270, 270, 270, 270, 0];  // sum=1350 ✓ (each L2-L6 = $0.27 at T1)

function tierSplits(tierNum)   { return SPLITS_ALL; }     // unified across all tiers
function tierChainPay(tierNum) { return CHAIN_PAY_ALL; }  // unified across all tiers

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
    await sleep(8000);
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

  console.log("\n  V8.32 Deploy — 50/2.5/47.5 BPS + gas gift on-chain + DAO param #50 + Task #59/#60/#63 + setGlobalJoined");
  console.log("  Remember: set ADDRESSES_FILE=deployed_addresses_v8_35.json in .env after this deploy.");
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

  // V8.21: FigureEightMatrixV8's core logic now lives in MatrixLogicLib,
  // deployed ONCE and delegatecall-linked into every one of the 20 matrix
  // instances below (was previously duplicated in full in each of the 20).
  // Must deploy + link before getting the FigureEightMatrixV8 factory --
  // Hardhat requires the library address at factory-creation time, not
  // at individual deploy() calls.
  const MatrixLib    = await ethers.getContractFactory("MatrixLogicLib", deployer);
  const matrixLib     = await deploy(MatrixLib, [], "MatrixLogicLib");
  const matrixLibAddr = await matrixLib.getAddress();

  const F8V8  = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: matrixLibAddr },
    signer: deployer,
  });
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

    // V8.35: Deploy extra pairs for multi-instance capacity expansion.
    // Each pair is self-contained (chainNext loops A→B→A within the pair).
    // PairManager._tryAdvancePair() routes new registrations to the next pair
    // when the active pair reaches 80% occupancy — no manual intervention needed.
    const numExtraPairs = Math.max(0, (PAIRS_PER_TIER[tIdx] || 1) - 1);
    const extraPairs = [];
    for (let ep = 0; ep < numExtraPairs; ep++) {
      const pairNum = ep + 2;  // "2", "3", etc.
      console.log(`\n     ── T${tierNum}.${pairNum} (extra pair ${pairNum}/${PAIRS_PER_TIER[tIdx]}) ──`);

      const matAx = await deploy(
        F8V8,
        [dpStruct, fee, MATRIX_SIZE, true, tIdx, splits, cpBps],
        `MatA T${tierNum}.${pairNum}`
      );
      const matBx = await deploy(
        F8V8,
        [dpStruct, fee, MATRIX_SIZE, false, tIdx, splits, cpBps],
        `MatB T${tierNum}.${pairNum}`
      );
      const matAxAddr = await matAx.getAddress();
      const matBxAddr = await matBx.getAddress();

      // Register with MatrixFactory
      await (await matFactory.registerPair(tIdx, matAxAddr, matBxAddr)).wait();
      // Partner link
      await (await matAx.setPartner(matBxAddr)).wait();
      await (await matBx.setPartner(matAxAddr)).wait();
      // TierRouter
      await (await matAx.setTierRouter(trAddr)).wait();
      await (await matBx.setTierRouter(trAddr)).wait();
      // PairManager
      await (await matAx.setPairManager(pmAddr)).wait();
      await (await matBx.setPairManager(pmAddr)).wait();
      // StabilityFund
      await (await matAx.setStabilityFund(sfAddr)).wait();
      await (await matBx.setStabilityFund(sfAddr)).wait();
      // BuybackReserve
      await (await matAx.setBuybackReserve(bbrAddr)).wait();
      await (await matBx.setBuybackReserve(bbrAddr)).wait();
      // LiquidityReserve
      await (await matAx.setLiquidityReserve(liquidityReserve)).wait();
      await (await matBx.setLiquidityReserve(liquidityReserve)).wait();
      // matAx.chainNext = matBx — addPair does NOT set matA.chainNext, so we set it manually
      // matBx.chainNext is overwritten by addPair to point to chainHead (matA0), completing
      // the global loop: matA0→matB0→matA1→matB1→…→matAn→matBn→matA0
      await (await matAx.setChainNext(matBxAddr)).wait();
      // Register with TierRouter (handleCycleOut authorization)
      await (await tierRouter.registerMatrix(matAxAddr, tIdx)).wait();
      await (await tierRouter.registerMatrix(matBxAddr, tIdx)).wait();
      // Add to PairManager — keeper auto-discovers via getPairAt(), no keeper changes needed
      await (await pm.addPair(matAxAddr, matBxAddr)).wait();
      // Authorize in StabilityFund and Treasury
      await (await stabilityFund.setMatrixAuthorized(matAxAddr, true)).wait();
      await (await stabilityFund.setMatrixAuthorized(matBxAddr, true)).wait();
      await (await treasury.setAuthorizedCaller(matAxAddr, true)).wait();
      await (await treasury.setAuthorizedCaller(matBxAddr, true)).wait();

      extraPairs.push({ matA: matAxAddr, matB: matBxAddr });
      console.log(`       T${tierNum}.${pairNum} wired + registered OK (matA=${matAxAddr.slice(0,10)}…)`);
    }

    deployed[tierNum] = { pm: pmAddr, matA: matAAddr, matB: matBAddr, pairs: extraPairs };
  }

  // ── 7b. Reset activePairIndex to 0 for tiers with pre-deployed extra pairs ──
  // addPair() sets activePairIndex = last-added pair on every call.
  // After pre-deploying T1=3 pairs, T2/T3=2 pairs, activePairIndex ends at the last
  // index. Reset to 0 so seed_w1.js and bigfill fill pair 0 (T1.1).
  // _tryAdvancePair() auto-advances 0→1→2 as each pair reaches 80% occupancy.
  sep("Reset activePairIndex");
  for (const tierNum of DEPLOY_TIERS) {
    if (deployed[tierNum].pairs.length > 0) {
      const pm = await ethers.getContractAt("PairManagerV8", deployed[tierNum].pm, deployer);
      await (await pm.setActivePairIndex(0)).wait();
      console.log(`  ↳  T${tierNum} PairManager activePairIndex → 0 (bigfill fills T${tierNum}.1 first)`);
    }
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
    // V8.35: wire extra pairs' matrices at keeper
    for (const ep of deployed[tierNum].pairs) {
      const mAx = await ethers.getContractAt("FigureEightMatrixV8", ep.matA, deployer);
      const mBx = await ethers.getContractAt("FigureEightMatrixV8", ep.matB, deployer);
      await (await mAx.setMatrixKeeper(keeperAddr)).wait();
      await (await mBx.setMatrixKeeper(keeperAddr)).wait();
    }
  }
  console.log("  ↳  MatrixKeeper set on all matrices (primary + extra pairs)");

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
    // V8.35: also wire governance on extra pairs
    for (const ep of deployed[tierNum].pairs) {
      const mAx = await ethers.getContractAt("FigureEightMatrixV8", ep.matA, deployer);
      const mBx = await ethers.getContractAt("FigureEightMatrixV8", ep.matB, deployer);
      await (await mAx.setGovernance(govAddr)).wait();
      await (await mBx.setGovernance(govAddr)).wait();
    }
    // V8.21: PARAM_WITHDRAWAL_FEE_BPS (id 9) now targets PairManagerV8 (one per
    // tier) instead of a single matrix instance -- PairManagerV8.setWithdrawalFeeBps()
    // broadcasts to every pair the tier has ever added. Without this wiring,
    // execute() on param 9 would revert with "PM8: not authorized" for every tier.
    const pm = await ethers.getContractAt("PairManagerV8", deployed[tierNum].pm, deployer);
    await (await pm.setGovernance(govAddr)).wait();
  }
  console.log("  ↳  V8Governance wired onto all matrices + extra pairs + PairManagers");
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

  // V8.23: CNOVADirectSale.buyCNOVA() calls cnova.mintForSale() — needs DIRECT_SALE_ROLE
  // (not MINTER_ROLE). mintForSale mints with no vesting, replacing the removed mintDirect().
  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await (await cnova.grantRole(DIRECT_SALE_ROLE, dsAddr)).wait();
  console.log(`  ↳  DIRECT_SALE_ROLE granted to CNOVADirectSale (${dsAddr})`);

  // V8.20: wire governance co-control (setMaxTxBps/setMaxWalletBps/setSfTargetDS/
  // setLqTargetDS). directSale deploys after V8Governance, so this couldn't be
  // done in the main governance-wiring block above.
  await (await directSale.setGovernance(govAddr)).wait();
  console.log(`  ↳  CNOVADirectSale.setGovernance OK (${govAddr})`);

  // ── 9e. CouponRegistry ──────────────────────────────────────────────────────
  // Lets any USDC holder issue a coupon (hash of a plaintext code).
  // New members can redeem the coupon at registration to cover part/all of the
  // T1 entry fee. Registry holds USDC on behalf of the issuer until redemption
  // or expiry (30 days). Only authorized matrices can call redeemCoupon().
  sep("CouponRegistry");
  const COUPON_AMOUNT_USD = Number(process.env.COUPON_AMOUNT_USD || 10);
  const couponAmountWei   = BigInt(COUPON_AMOUNT_USD) * 1_000_000n; // 6-decimal USDC
  const CouponRegistry    = await ethers.getContractFactory("CouponRegistry", deployer);
  const couponRegistry    = await deploy(CouponRegistry, [usdcAddr, couponAmountWei], "CouponRegistry");
  const crAddr            = await couponRegistry.getAddress();
  console.log(`  ↳  CouponRegistry deployed — default coupon = $${COUPON_AMOUNT_USD} USDC`);

  // Wire registry into every MatA (coupon registration only works on MatA)
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    await (await couponRegistry.setAuthorizedMatrix(deployed[tierNum].matA, true)).wait();
    await (await mA.setCouponRegistry(crAddr)).wait();
    console.log(`  ↳  T${tierNum} MatA authorized + wired → CouponRegistry`);
    // V8.35: also wire extra pairs' MatA so coupons work in expanded pairs
    for (const ep of deployed[tierNum].pairs) {
     