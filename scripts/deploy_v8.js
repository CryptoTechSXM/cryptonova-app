"use strict";
/**
 * deploy_v8.js  --  V8.35 Full Deploy  (all 10 tiers, MATRIX_SIZE=127, auto-keeper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys the complete V8.35 stack:
 *
 *   Shared:   MockUSDC (testnet only)
 *             CNOVAToken · CNOVATreasury
 *             StabilityFund (+ 1% L1 carve to CommunityWallet)
 *             CommunityWallet (First-1000 lifetime USDC pool, 60/40 Genesis/Pioneer)
 *             TierRouter
 *             MatrixFactory (registry / wiring hub)
 *             MatrixPairFactory (autonomous on-chain pair expansion — no hard cap)
 *             MatrixKeeper  (Chainlink Automation upkeep)
 *             V8Governance  (DAO)
 *
 *   Per tier: PairManagerV8 · MatA · MatB  (1 pair per tier at deploy)
 *             MatrixPairFactory auto-deploys new pairs inline when a pair hits 80%.
 *
 * V8.35 CHANGES vs V8.34
 * --------------------
 *   - MatrixPairFactory: autonomous on-chain pair expansion eliminates the hard cap.
 *     When the active pair reaches 80% occupancy and no next pair is pre-deployed,
 *     the factory deploys a fresh MatA+MatB, wires all permissions, and routes the
 *     triggering member into the new pair — all in the same transaction.
 *   - Whale Gate redesign: per-tier pioneer thresholds (T5=25, T6=15, T7=10, T8-T10=5).
 *     T2-T5 share T5's gate. Governance params #52-57. bulkUpgrade() for whale entry.
 *   - PAIRS_PER_TIER simplified to all-1s — factory replaces static multi-pair deploy.
 *
 * ARCHITECTURE NOTE
 * -----------------
 * MatrixFactory no longer deploys FigureEightMatrixV8 contracts (EIP-170 limit).
 * Instead: deploy script deploys each MatA/MatB directly, then calls
 * MatrixFactory.registerPair() which validates ownership, wires, and records them.
 *
 * MatrixPairFactory deploys future MatA/MatB pairs autonomously on-chain when any
 * PairManager's active pair crosses 80% occupancy and no pre-deployed next pair exists.
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
 *   ADDRESSES_FILE         Output filename (default: deployed_addresses_v8_47.json)
 *
 * Run: npx hardhat run scripts/deploy_v8.js --network baseSepolia
 */

const { ethers }      = require("hardhat");
const { NonceManager } = require("ethers"); // v6 local nonce tracking
const fs              = require("fs");
const path            = require("path");
require("dotenv").config();

// ── Addresses output file ─────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"
);

// ── Config ────────────────────────────────────────────────────────────────────
const MATRIX_SIZE    = BigInt(process.env.MATRIX_SIZE || "127");
const DEPLOY_TIERS   = (process.env.DEPLOY_TIERS || "1,2,3,4,5,6,7,8,9,10").split(",").map(Number);

// ── Pair capacity: 1 pair per tier at deploy ──────────────────────────────────
// MatrixPairFactory handles all subsequent expansion autonomously on-chain.
// When the active pair crosses 80% occupancy and no next pair exists, the
// factory deploys a new MatA+MatB inline in the same tx as the triggering
// registration — no human intervention needed, no hard cap on members.
const PAIRS_PER_TIER = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; // factory handles expansion

// ── Tier entry fees (USDC 6-decimal) ─────────────────────────────────────────
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
// [  l1, chain,  pool, treasury,   sf,  dev,  ops,  cw,  bbr,   lq] sum
const SPLITS_ALL    = [ 500,  1350,  1800,     500,  300,  100,   50,  100,   25,   25]; // V8.47: community 50→100, buyback/liquidity 50→25 (net-zero, sum 4750 ✓)

// ── Chain pay BPS per level (6 slots, must sum to chainBps = 1350) ────────────
const CHAIN_PAY_ALL = [270, 270, 270, 270, 270, 0];  // sum=1350 ✓

function tierSplits(tierNum)   { return SPLITS_ALL; }
function tierChainPay(tierNum) { return CHAIN_PAY_ALL; }

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

  // V8.44 deployer guard (owner decision 2026-07-25): 0xCd0Af6… is the ACTIVE
  // testnet deployer again (it owns MockUSDC → direct mint). It is EIP-7702
  // delegated to MetaMask's stateless delegator (0x63c0c19a… — signature-gated,
  // accepted risk on TESTNET ONLY). The guard now: (a) prints the delegation
  // status of whatever wallet is signing, (b) aborts only if EXPECTED_DEPLOYER
  // is set in .env and doesn't match — so a stale key swap can never silently
  // deploy from the wrong wallet again. MAINNET RULE: fresh, never-delegated
  // deployer — do not carry this exception over.
  {
    const code = await ethers.provider.getCode(rawSigner.address);
    if (code.startsWith("0xef0100")) {
      console.log(`  ⚠️  Signer ${rawSigner.address} is EIP-7702 delegated to 0x${code.slice(8)} (testnet-accepted)`);
    }
    const expected = (process.env.EXPECTED_DEPLOYER || "").toLowerCase();
    if (expected && rawSigner.address.toLowerCase() !== expected) {
      throw new Error(`Signer ${rawSigner.address} != EXPECTED_DEPLOYER ${process.env.EXPECTED_DEPLOYER} — fix .env before deploying.`);
    }
  }

  const nonceMgr = new NonceManager(rawSigner);
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
  const liquidityReserve = process.env.LIQUIDITY_RESERVE_ADDRESS || opsWallet;

  console.log("\n  V8.41 Deploy — FIFO pair routing (external→pair 0, graduates→pairIndex+1)");
  console.log("  Remember: ADDRESSES_FILE=deployed_addresses_v8_47.json must be set in .env BEFORE this deploy (script writes there).");
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
  const stabilityFund = await deploy(StabilityFund, [usdcAddr, admin], "StabilityFund");
  const sfAddr = await stabilityFund.getAddress();

  for (const t of DEPLOY_TIERS) {
    await (await stabilityFund.setTierFee(t - 1, TIER_FEES[t - 1])).wait();
  }
  console.log("  ↳  Tier entry fees set in StabilityFund");

  // ── 4b. CNOVABuybackReserve ──────────────────────────────────────────────
  sep("CNOVABuybackReserve");
  const CNOVABuybackReserve = await ethers.getContractFactory("CNOVABuybackReserve", deployer);
  const buybackReserve      = await deploy(
    CNOVABuybackReserve,
    [usdcAddr, cnovaAddr, ethers.ZeroAddress, ethers.ZeroAddress, admin],
    "CNOVABuybackReserve"
  );
  const bbrAddr = await buybackReserve.getAddress();

  await (await stabilityFund.setBuybackReserve(bbrAddr)).wait();
  console.log("  ↳  StabilityFund.setBuybackReserve OK");

  // ── 5a. TierRouterLib (V8.47: linked lib holding TierRouter's extracted upgrade helpers)
  sep("TierRouterLib");
  const TierRouterLibF = await ethers.getContractFactory("TierRouterLib", deployer);
  const tierRouterLib  = await deploy(TierRouterLibF, [], "TierRouterLib");
  const trLibAddr      = await tierRouterLib.getAddress();

  // ── 5. TierRouter (links TierRouterLib) ─────────────────────────────────────
  sep("TierRouter");
  const TierRouter = await ethers.getContractFactory("TierRouter", {
    libraries: { TierRouterLib: trLibAddr },
  });
  const tierRouter  = await deploy(TierRouter, [usdcAddr, admin], "TierRouter");
  const trAddr = await tierRouter.getAddress();

  await (await stabilityFund.setTierRouter(trAddr)).wait();
  console.log("  ↳  StabilityFund.setTierRouter OK");
  await (await tierRouter.setStabilityFund(sfAddr)).wait();  // V8.47 upgrade gate
  console.log("  ↳  TierRouter.setStabilityFund OK");

  // ── 6. MatrixFactory (registry/wiring hub) ───────────────────────────────
  sep("MatrixFactory");
  const MatrixFactory = await ethers.getContractFactory("MatrixFactory", deployer);
  const matFactory    = await deploy(
    MatrixFactory,
    [admin, trAddr, sfAddr, ethers.ZeroAddress],
    "MatrixFactory"
  );
  const mfAddr = await matFactory.getAddress();

  // ── 6b. MatrixLogicLib (must deploy before MatrixPairFactory — it embeds F8V8 bytecode)
  sep("MatrixLogicLib");
  const MatrixLib    = await ethers.getContractFactory("MatrixLogicLib", deployer);
  const matrixLib    = await deploy(MatrixLib, [], "MatrixLogicLib");
  const matrixLibAddr = await matrixLib.getAddress();

  // ── 6c. MatrixPairFactory (autonomous expansion — no hard cap) ────────────
  sep("MatrixPairFactory");
  const MPFactory   = await ethers.getContractFactory("MatrixPairFactory", {
    libraries: { MatrixLogicLib: matrixLibAddr },
    signer: deployer,
  });
  const pairFactory = await deploy(
    MPFactory,
    [admin, usdcAddr, cnovaAddr, treasuryAddr],
    "MatrixPairFactory"
  );
  const pairFactoryAddr = await pairFactory.getAddress();

  // Set wallets — needed by factory when constructing new FigureEightMatrixV8 instances
  await (await pairFactory.setWallets(devWallet, opsWallet, accountOne)).wait();
  console.log("  ↳  MatrixPairFactory.setWallets OK");

  // Wire factory into peripherals already deployed at this point.
  // keeper, couponRegistry, and governance are wired via setPeripherals() later.
  await (await pairFactory.setPeripherals(
    sfAddr, ethers.ZeroAddress, trAddr,
    ethers.ZeroAddress, ethers.ZeroAddress,
    bbrAddr, liquidityReserve
  )).wait();
  console.log("  ↳  MatrixPairFactory.setPeripherals (partial — keeper/cr/gov wired after deploy)");

  // Allow factory to call setMatrixAuthorized / setAuthorizedCaller / registerMatrix
  await (await stabilityFund.setFactory(pairFactoryAddr)).wait();
  await (await treasury.setFactory(pairFactoryAddr)).wait();
  await (await tierRouter.setFactory(pairFactoryAddr)).wait();
  console.log("  ↳  factory wired into StabilityFund, Treasury, TierRouter");

  // ── 7. PairManagers + Matrix pairs ───────────────────────────────────────
  sep("Tier Pairs");

  const F8V8  = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: matrixLibAddr },
    signer: deployer,
  });
  const PMV8  = await ethers.getContractFactory("PairManagerV8", deployer);

  const deployed = {};  // t => { pm, matA, matB }

  for (const tierNum of DEPLOY_TIERS) {
    const tIdx   = tierNum - 1;
    const fee    = TIER_FEES[tIdx];
    const splits = tierSplits(tierNum);
    const cpBps  = tierChainPay(tierNum);

    console.log(`\n  T${tierNum} (fee=$${Number(fee) / 1e6})`);

    const pm   = await deploy(PMV8, [usdcAddr, fee, admin], `PairManagerV8 T${tierNum}`);
    const pmAddr = await pm.getAddress();
    await (await pm.setTierRouter(trAddr)).wait();
    console.log(`       PairManagerV8.setTierRouter T${tierNum} OK`);

    // Wire MatrixPairFactory → PairManager (enables autonomous expansion)
    await (await pm.setFactory(pairFactoryAddr)).wait();
    console.log(`       PairManagerV8.setFactory T${tierNum} OK`);

    await (await matFactory.configureTier(tIdx, pmAddr, MATRIX_SIZE)).wait();
    console.log(`       MatrixFactory.configureTier T${tierNum} OK`);

    const dpStruct = {
      usdc:       usdcAddr,
      cnova:      cnovaAddr,
      treasury:   treasuryAddr,
      devWallet:  devWallet,
      opsWallet:  opsWallet,
      accountOne: accountOne,
      admin:      admin,
    };

    const matA = await deploy(
      F8V8,
      [dpStruct, fee, MATRIX_SIZE, true, tIdx, splits, cpBps],
      `MatA T${tierNum}`
    );

    const matB = await deploy(
      F8V8,
      [dpStruct, fee, MATRIX_SIZE, false, tIdx, splits, cpBps],
      `MatB T${tierNum}`
    );

    const matAAddr = await matA.getAddress();
    const matBAddr = await matB.getAddress();

    await (await matFactory.registerPair(tIdx, matAAddr, matBAddr)).wait();
    console.log(`       MatrixFactory.registerPair T${tierNum} OK`);

    // Wire matrices
    await (await matA.setPartner(matBAddr)).wait();
    await (await matB.setPartner(matAAddr)).wait();
    await (await matA.setTierRouter(trAddr)).wait();
    await (await matB.setTierRouter(trAddr)).wait();
    await (await matA.setPairManager(pmAddr)).wait();
    await (await matB.setPairManager(pmAddr)).wait();
    await (await matA.setStabilityFund(sfAddr)).wait();
    await (await matB.setStabilityFund(sfAddr)).wait();
    await (await matA.setBuybackReserve(bbrAddr)).wait();
    await (await matB.setBuybackReserve(bbrAddr)).wait();
    await (await matA.setLiquidityReserve(liquidityReserve)).wait();
    await (await matB.setLiquidityReserve(liquidityReserve)).wait();
    await (await matA.setChainNext(matBAddr)).wait();
    await (await matB.setChainNext(matAAddr)).wait();
    console.log(`       Matrix wiring complete T${tierNum}`);

    await (await tierRouter.registerTier(tIdx, pmAddr, fee)).wait();
    await (await tierRouter.setTierMatrices(tIdx, matAAddr, matBAddr)).wait();
    await (await tierRouter.registerMatrix(matAAddr, tIdx)).wait();
    await (await tierRouter.registerMatrix(matBAddr, tIdx)).wait();
    console.log(`       TierRouter.registerTier + setTierMatrices + registerMatrix T${tierNum} OK`);

    if (tierNum > 1) {
      await (await tierRouter.setTierVelocityGreen(tIdx, false)).wait();
      console.log(`       Velocity gate T${tierNum} CLOSED (keeper opens at 80% MatB fill)`);
    } else {
      console.log(`       Velocity gate T1 OPEN (T1 always open for registration)`);
    }

    await (await pm.addPair(matAAddr, matBAddr)).wait();
    console.log(`       PairManager.addPair T${tierNum} OK`);

    await (await stabilityFund.setMatrixAuthorized(matAAddr, true)).wait();
    await (await stabilityFund.setMatrixAuthorized(matBAddr, true)).wait();

    await (await treasury.setAuthorizedCaller(matAAddr, true)).wait();
    await (await treasury.setAuthorizedCaller(matBAddr, true)).wait();
    console.log(`       Treasury.setAuthorizedCaller T${tierNum} OK`);

    // Configure this tier in MatrixPairFactory.
    // When the active pair hits 80% occupancy, factory.deployAndWire() fires
    // and uses these params to construct the next MatA+MatB pair.
    await (await pairFactory.configureTier(
      tierNum,      // 1-based tier number
      fee,
      MATRIX_SIZE,
      splits,       // SplitConfig array — same order as Solidity struct
      cpBps         // uint256[6] chainPayBps
    )).wait();
    await (await pairFactory.registerPairManager(pmAddr, tierNum)).wait();
    console.log(`       MatrixPairFactory: T${tierNum} configured + PM registered`);

    deployed[tierNum] = { pm: pmAddr, matA: matAAddr, matB: matBAddr };
  }

  // ── 8. MatrixKeeper ──────────────────────────────────────────────────────
  sep("MatrixKeeper");
  const MatrixKeeper = await ethers.getContractFactory("MatrixKeeper", deployer);
  const keeper       = await deploy(MatrixKeeper, [trAddr, sfAddr], "MatrixKeeper");
  const keeperAddr   = await keeper.getAddress();

  await (await stabilityFund.setMatrixKeeper(keeperAddr)).wait();
  console.log("  ↳  StabilityFund.setMatrixKeeper OK");

  await (await tierRouter.setMatrixKeeper(keeperAddr)).wait();
  console.log("  ↳  TierRouter.setMatrixKeeper OK");

  for (const tierNum of DEPLOY_TIERS) {
    await (await keeper.setPairManager(tierNum - 1, deployed[tierNum].pm)).wait();
  }
  console.log("  ↳  PairManagers registered with MatrixKeeper");

  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setMatrixKeeper(keeperAddr)).wait();
    await (await mB.setMatrixKeeper(keeperAddr)).wait();
  }
  console.log("  ↳  MatrixKeeper set on all matrices");

  // Update MatrixPairFactory with keeper — factory-deployed pairs will call keeper wiring
  // NOTE: couponRegistry and governance still ZeroAddress — updated in final setPeripherals below
  await (await pairFactory.setPeripherals(
    sfAddr, ethers.ZeroAddress, trAddr,
    keeperAddr, ethers.ZeroAddress,
    bbrAddr, liquidityReserve
  )).wait();
  console.log("  ↳  MatrixPairFactory.setPeripherals updated with keeper");

  // ── 9. V8Governance ──────────────────────────────────────────────────────
  sep("V8Governance");
  const V8Gov    = await ethers.getContractFactory("V8Governance", deployer);
  const gov      = await deploy(V8Gov, [cnovaAddr, trAddr, keeperAddr], "V8Governance");
  const govAddr  = await gov.getAddress();

  await (await keeper.setGovernance(govAddr)).wait();
  await (await tierRouter.setGovernance(govAddr)).wait();
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setGovernance(govAddr)).wait();
    await (await mB.setGovernance(govAddr)).wait();
    const pm = await ethers.getContractAt("PairManagerV8", deployed[tierNum].pm, deployer);
    await (await pm.setGovernance(govAddr)).wait();
  }
  console.log("  ↳  V8Governance wired onto all matrices + PairManagers");
  await (await stabilityFund.setGovernance(govAddr)).wait();
  await (await buybackReserve.setGovernance(govAddr)).wait();
  console.log("  ↳  V8Governance deployed + wired (owner retains backstop, governance co-governs)");

  // ── 9b. Wire CNOVA roles ─────────────────────────────────────────────────
  sep("CNOVA Role Grants");
  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  for (const tierNum of DEPLOY_TIERS) {
    const { matA, matB } = deployed[tierNum];
    await (await cnova.grantRole(MINTER_ROLE, matA)).wait();
    await (await cnova.grantRole(MINTER_ROLE, matB)).wait();
    console.log(`  ↳  MINTER_ROLE granted to T${tierNum} MatA + MatB`);
  }
  await (await cnova.grantRole(GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ↳  GOVERNOR_ROLE granted to V8Governance (${govAddr})`);

  // V8.36 Bug Fix #1: Grant DEFAULT_ADMIN_ROLE to MatrixPairFactory so it can
  // call cnova.grantRole(MINTER_ROLE, newMatA/matB) when deploying factory pairs.
  // Without this, T1.2+, T2.2+, … members receive no CNOVA rewards.
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // 0x00...00 (OpenZeppelin AccessControl)
  await (await cnova.grantRole(DEFAULT_ADMIN_ROLE, pairFactoryAddr)).wait();
  console.log(`  ↳  DEFAULT_ADMIN_ROLE granted to MatrixPairFactory (${pairFactoryAddr}) — enables MINTER_ROLE grant on factory expansion`);

  // ── 9c. CommunityWallet ──────────────────────────────────────────────────
  sep("CommunityWallet");
  const CommunityWallet = await ethers.getContractFactory("CommunityWallet", deployer);
  const cw     = await deploy(CommunityWallet, [usdcAddr, admin], "CommunityWallet");
  const cwAddr = await cw.getAddress();

  await (await cw.setEnrollor(trAddr)).wait();
  console.log(`  ↳  setEnrollor(TierRouter) OK`);

  const CW_GOVERNOR_ROLE = await cw.GOVERNOR_ROLE();
  await (await cw.grantRole(CW_GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ↳  GOVERNOR_ROLE granted to V8Governance on CommunityWallet`);

  await (await tierRouter.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  TierRouter.setCommunityWallet OK`);

  await (await stabilityFund.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  StabilityFund.setCommunityWallet OK`);

  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setCommunityWallet(cwAddr)).wait();
    await (await mB.setCommunityWallet(cwAddr)).wait();
    console.log(`  ↳  T${tierNum} MatA + MatB → CommunityWallet set`);
  }
  console.log("  ↳  CommunityWallet fully wired into SF + all matrices");

  await (await keeper.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  MatrixKeeper.setCommunityWallet OK`);

  // ── 9d. CNOVADirectSale ──────────────────────────────────────────────────
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

  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await (await cnova.grantRole(DIRECT_SALE_ROLE, dsAddr)).wait();
  console.log(`  ↳  DIRECT_SALE_ROLE granted to CNOVADirectSale`);

  await (await directSale.setGovernance(govAddr)).wait();
  console.log(`  ↳  CNOVADirectSale.setGovernance OK`);

  // ── 9e. CouponRegistry ──────────────────────────────────────────────────
  sep("CouponRegistry");
  const COUPON_AMOUNT_USD = Number(process.env.COUPON_AMOUNT_USD || 10);
  const couponAmountWei   = BigInt(COUPON_AMOUNT_USD) * 1_000_000n;
  const CouponRegistry    = await ethers.getContractFactory("CouponRegistry", deployer);
  const couponRegistry    = await deploy(CouponRegistry, [usdcAddr, couponAmountWei], "CouponRegistry");
  const crAddr            = await couponRegistry.getAddress();
  console.log(`  ↳  CouponRegistry deployed — default coupon = $${COUPON_AMOUNT_USD} USDC`);

  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    await (await couponRegistry.setAuthorizedMatrix(deployed[tierNum].matA, true)).wait();
    await (await mA.setCouponRegistry(crAddr)).wait();
    console.log(`  ↳  T${tierNum} MatA authorized + wired → CouponRegistry`);
  }

  const gasGiftWalletAddr = process.env.GAS_GIFT_WALLET_ADDRESS || opsWallet;
  await (await couponRegistry.setGasGiftWallet(gasGiftWalletAddr)).wait();
  console.log(`  ↳  CouponRegistry.setGasGiftWallet → ${gasGiftWalletAddr.slice(0,10)}…`);

  // Wire MatrixPairFactory into CouponRegistry (factory can authorize new MatA on expansion)
  await (await couponRegistry.setFactory(pairFactoryAddr)).wait();
  console.log("  ↳  CouponRegistry.setFactory → MatrixPairFactory OK");

  // ── 9f. MatrixPairFactory final wiring ───────────────────────────────────
  // All addresses now known. Call setPeripherals once more with the full set.
  // This is the definitive configuration — factory-deployed pairs will be
  // fully authorized into SF, Treasury, TierRouter, CouponRegistry, and registered
  // with keeper, co-governed by V8Governance.
  sep("MatrixPairFactory Final Wiring");
  await (await pairFactory.setPeripherals(
    sfAddr, crAddr, trAddr,
    keeperAddr, govAddr,
    bbrAddr, liquidityReserve
  )).wait();
  console.log("  ↳  MatrixPairFactory.setPeripherals FINAL (all addresses wired)");

  // V8.34: Set parkedGracePeriod
  const GRACE_PERIOD_SECS = process.env.PARKED_GRACE_SECS
    ? Number(process.env.PARKED_GRACE_SECS)
    : 86400; // 24h testnet default
  await (await keeper.setParkedGracePeriod(GRACE_PERIOD_SECS)).wait();
  console.log(`  ↳  MatrixKeeper.setParkedGracePeriod → ${GRACE_PERIOD_SECS}s (${GRACE_PERIOD_SECS/3600}h)`);

  // ── 10a. Save addresses BEFORE W1 seed ────────────────────────────────────
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
      matrixFactory: mfAddr, pairFactory: pairFactoryAddr,
      matrixKeeper: keeperAddr,
      v8Governance: govAddr, communityWallet: cwAddr,
      liquidityReserve, directSale: dsAddr, couponRegistry: crAddr,
      tiers: tierAddresses,
    };
    fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(out, null, 2));
    console.log(`  ✓  Addresses saved → ${path.basename(ADDRESSES_FILE)}`);
  }

  // ── 10b. Register W1 (Account #1) as position-1 root of T1 MatA ─────────
  sep("W1 Registration");
  const T1_FEE     = TIER_FEES[0];
  const T1_PM_ADDR = deployed[1].pm;
  const w1Key      = process.env.SEED_W1_KEY || process.env.W1_PRIVATE_KEY;

  if (!w1Key) {
    console.log(`  ⚠  SEED_W1_KEY / W1_PRIVATE_KEY not set — skipping W1 seed.`);
    console.log(`     Run: $env:SEED_W1_KEY="0x<key>"; npx hardhat run scripts/seed_w1.js --network baseSepolia`);
  } else {
    try {
      const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);
      const W1_ADDR  = w1Wallet.address;

      const alreadyJoined = await tierRouter.globalJoined(W1_ADDR);
      if (alreadyJoined) {
        console.log(`  ✓  W1 (${W1_ADDR}) already registered — skip`);
      } else {
        const w1Eth = await ethers.provider.getBalance(W1_ADDR);
        if (w1Eth < ethers.parseEther("0.01")) {
          await (await deployer.sendTransaction({ to: W1_ADDR, value: ethers.parseEther("0.02") })).wait();
          console.log(`  ↳  Funded W1 with 0.02 ETH for gas`);
        }
        await (await usdc.mint(W1_ADDR, T1_FEE)).wait();
        console.log(`  ↳  Minted $${Number(T1_FEE) / 1e6} USDC to W1`);
        await (await usdc.connect(w1Wallet).approve(T1_PM_ADDR, T1_FEE)).wait();
        console.log(`  ↳  W1 approved T1 PM (${T1_PM_ADDR.slice(0,10)})`);
        await (await tierRouter.connect(w1Wallet).register(ethers.ZeroAddress, { gasLimit: 3_000_000 })).wait();
        console.log(`  ✓  W1 (${W1_ADDR}) registered as T1 MatA root (position-1)`);
      }

      await (await tierRouter.setDefaultReferrer(W1_ADDR)).wait();
      console.log(`  ✓  TierRouter.setDefaultReferrer → W1 (${W1_ADDR})`);
    } catch (e) {
      console.log(`  ⚠  W1 registration failed: ${e.reason || e.message}`);
      if (e.data) console.log(`     Revert data: ${e.data}`);
      console.log(`     Run scripts/seed_w1.js manually after deploy.`);
    }
  }

  // ── 11. Final summary ────────────────────────────────────────────────────
  sep("Deploy Complete");
  console.log(`  Network       : ${(await ethers.provider.getNetwork()).name}`);
  console.log(`  MockUSDC      : ${usdcAddr}`);
  console.log(`  CNOVAToken    : ${cnovaAddr}`);
  console.log(`  Treasury      : ${treasuryAddr}`);
  console.log(`  StabilityFund : ${sfAddr}`);
  console.log(`  BuybackReserve: ${bbrAddr}`);
  console.log(`  TierRouter    : ${trAddr}`);
  console.log(`  MatrixFactory : ${mfAddr}`);
  console.log(`  PairFactory   : ${pairFactoryAddr}`);
  console.log(`  MatrixKeeper  : ${keeperAddr}`);
  console.log(`  V8Governance  : ${govAddr}`);
  console.log(`  CommunityWallet:${cwAddr}`);
  for (const t of DEPLOY_TIERS) {
    console.log(`  T${t.toString().padStart(2,'0')} PM:${deployed[t].pm.slice(0,10)} MatA:${deployed[t].matA.slice(0,10)} MatB:${deployed[t].matB.slice(0,10)}`);
  }
  sep();
  console.log(`  Addresses file: ${require("path").basename(ADDRESSES_FILE)}`);
  console.log("  V8.41 Deploy complete.\n");
  console.log("  NEXT STEP: run scripts/seed_w1.js then scripts/bigfill_v8.js\n");
  sep();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
