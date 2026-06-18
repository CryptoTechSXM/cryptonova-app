/**
 * add_tier.js  --  Add a new tier to an existing V8.1 deployment
 *
 * Usage (PowerShell):
 *   $env:ADD_TIER="3"   # tier number to add (default: 3)
 *   npx hardhat run scripts/add_tier.js --network baseSepolia
 *
 * Resume after partial deploy (PM already live):
 *   $env:ADD_TIER="3"; $env:RESUME_PM="0x4bC413790bA94929FC71b19C4b5DB9e7BD07Dae8"
 *   npx hardhat run scripts/add_tier.js --network baseSepolia
 *
 * What it does:
 *   1. Loads existing deployed_addresses_v8_5.json
 *   2. Deploys PairManager + MatA + MatB for the new tier
 *   3. Wires all contracts (partner, tierRouter, pairManager, SF, chainNext, keeper)
 *   4. Registers tier in TierRouter + MatrixKeeper
 *   5. Grants MINTER_ROLE on CNOVA to new matrices
 *   6. Sets tierVelocityGreen = true for the new tier
 *   7. Updates deployed_addresses_v8_5.json with new addresses
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses_v8_5.json");
const ADD_TIER       = Number(process.env.ADD_TIER || "3");
const RESUME_PM      = process.env.RESUME_PM || "";   // skip PM deploy if set
const MATRIX_SIZE    = 64n;

// Tier fees (0-indexed): T1=$10, T2=$25, T3=$50, T4=$100, T5=$250, T6=$500, T7=$1000
const TIER_FEES = [
  10_000_000n,   // T1  $10
  25_000_000n,   // T2  $25
  50_000_000n,   // T3  $50
  100_000_000n,  // T4  $100
  250_000_000n,  // T5  $250
  500_000_000n,  // T6  $500
  1_000_000_000n // T7  $1000
];

// BPS splits: [l1, l2, l3, chain, pool, treasury, devOps, stability]
const SPLITS_T1_T3 = [2000, 300, 200, 2000, 3300, 200, 500,  1500];
const SPLITS_T4_T5 = [2000, 300, 200, 2000, 3000, 200, 700,  1600];
const SPLITS_T6_T7 = [2000, 300, 200, 1750, 2550, 200, 800,  2200];

// Chain pay BPS arrays (6 levels)
const CHAIN_PAY_T1_T5 = [1000, 400, 300, 150, 75, 75];
const CHAIN_PAY_T6_T7 = [875,  350, 262, 131, 66, 66];

function tierSplits(t) {
  if (t <= 3) return SPLITS_T1_T3;
  if (t <= 5) return SPLITS_T4_T5;
  return SPLITS_T6_T7;
}
function tierChainPay(t) {
  return t <= 5 ? CHAIN_PAY_T1_T5 : CHAIN_PAY_T6_T7;
}

function sep(label) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(60));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // ── Load existing addresses ───────────────────────────────────────────────
  if (!fs.existsSync(ADDRESSES_FILE)) {
    throw new Error(`Addresses file not found: ${ADDRESSES_FILE}`);
  }
  const saved = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const tierKey = `T${ADD_TIER}`;
  if (saved.tiers && saved.tiers[tierKey]) {
    throw new Error(`T${ADD_TIER} already deployed in ${ADDRESSES_FILE} — aborting.`);
  }

  if (RESUME_PM) {
    sep(`Resuming T${ADD_TIER} deploy — PM already at ${RESUME_PM}`);
  } else {
    sep(`Add Tier ${ADD_TIER} ($${Number(TIER_FEES[ADD_TIER-1])/1e6}) to v8_5`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`  Deployer   : ${deployer.address}`);
  console.log(`  New Tier   : T${ADD_TIER} — fee $${Number(TIER_FEES[ADD_TIER-1])/1e6}`);

  const tIdx = ADD_TIER - 1; // 0-based

  // ── Attach existing contracts ─────────────────────────────────────────────
  const usdcAddr     = saved.usdc;
  const cnovaAddr    = saved.cnova;
  const treasuryAddr = saved.treasury;
  const sfAddr       = saved.stabilityFund;
  const trAddr       = saved.tierRouter;
  const keeperAddr   = saved.matrixKeeper;
  const devOps       = saved.devOps;
  const accountOne   = saved.accountOne;
  const admin        = deployer.address;

  const tierRouter    = await ethers.getContractAt("TierRouter", trAddr, deployer);
  const stabilityFund = await ethers.getContractAt("StabilityFund", sfAddr, deployer);
  const treasury      = await ethers.getContractAt("CNOVATreasury", treasuryAddr, deployer);
  const cnova         = await ethers.getContractAt("CNOVAToken", cnovaAddr, deployer);
  const keeper        = await ethers.getContractAt("MatrixKeeper", keeperAddr, deployer);

  console.log(`\n  TierRouter   : ${trAddr}`);
  console.log(`  StabilityFund: ${sfAddr}`);
  console.log(`  MatrixKeeper : ${keeperAddr}`);

  // ── Deploy or attach PairManager ──────────────────────────────────────────
  sep(`T${ADD_TIER} PairManager`);
  let pmAddr;
  const fee = TIER_FEES[tIdx];

  if (RESUME_PM) {
    pmAddr = RESUME_PM;
    console.log(`  PairManagerV8 T${ADD_TIER}: ${pmAddr}  (resumed — skipping deploy)`);
    // Still set tierRouter in case it wasn't set before the nonce failure
    const pm = await ethers.getContractAt("PairManagerV8", pmAddr, deployer);
    await (await pm.setTierRouter(trAddr)).wait();
    console.log(`  ↳  setTierRouter confirmed OK`);
    // Settle nonce before proceeding
    console.log(`  ⏳ Waiting 5s for nonce to settle…`);
    await sleep(5000);
  } else {
    const PMV8 = await ethers.getContractFactory("PairManagerV8", deployer);
    const pm   = await PMV8.deploy(usdcAddr, fee, admin);
    await pm.waitForDeployment();
    pmAddr = await pm.getAddress();
    console.log(`  PairManagerV8 T${ADD_TIER}: ${pmAddr}`);
    await (await pm.setTierRouter(trAddr)).wait();
    console.log(`  ↳  setTierRouter OK`);
    // Settle nonce before deploying matrices
    console.log(`  ⏳ Waiting 5s for nonce to settle…`);
    await sleep(5000);
  }

  // ── Deploy MatA + MatB ────────────────────────────────────────────────────
  sep(`T${ADD_TIER} Matrices`);
  const F8V8    = await ethers.getContractFactory("FigureEightMatrixV8", deployer);
  const splits  = tierSplits(ADD_TIER);
  const cpBps   = tierChainPay(ADD_TIER);

  const dpStruct = {
    usdc:         usdcAddr,
    cnova:        cnovaAddr,
    treasury:     treasuryAddr,
    devOpsWallet: devOps,
    accountOne:   accountOne,
    admin:        admin,
  };

  console.log(`  Deploying MatA T${ADD_TIER}…`);
  const matA     = await F8V8.deploy(dpStruct, fee, MATRIX_SIZE, true,  tIdx, splits, cpBps);
  await matA.waitForDeployment();
  const matAAddr = await matA.getAddress();
  console.log(`  MatA T${ADD_TIER}: ${matAAddr}`);

  console.log(`  Deploying MatB T${ADD_TIER}…`);
  const matB     = await F8V8.deploy(dpStruct, fee, MATRIX_SIZE, false, tIdx, splits, cpBps);
  await matB.waitForDeployment();
  const matBAddr = await matB.getAddress();
  console.log(`  MatB T${ADD_TIER}: ${matBAddr}`);

  // ── Wire matrices ─────────────────────────────────────────────────────────
  sep(`Wiring T${ADD_TIER}`);

  await (await matA.setPartner(matBAddr)).wait();
  await (await matB.setPartner(matAAddr)).wait();
  console.log(`  ↳  partner links set`);

  await (await matA.setTierRouter(trAddr)).wait();
  await (await matB.setTierRouter(trAddr)).wait();
  console.log(`  ↳  tierRouter set`);

  await (await matA.setPairManager(pmAddr)).wait();
  await (await matB.setPairManager(pmAddr)).wait();
  console.log(`  ↳  pairManager set`);

  await (await matA.setStabilityFund(sfAddr)).wait();
  await (await matB.setStabilityFund(sfAddr)).wait();
  console.log(`  ↳  stabilityFund set`);

  // Circular chain within the pair (MatA <-> MatB loop)
  await (await matA.setChainNext(matBAddr)).wait();
  await (await matB.setChainNext(matAAddr)).wait();
  console.log(`  ↳  chainNext set (MatA<->MatB loop)`);

  await (await matA.setMatrixKeeper(keeperAddr)).wait();
  await (await matB.setMatrixKeeper(keeperAddr)).wait();
  console.log(`  ↳  matrixKeeper set`);

  // ── Register with TierRouter ──────────────────────────────────────────────
  sep(`TierRouter Registration`);

  await (await tierRouter.registerTier(tIdx, pmAddr, fee)).wait();
  console.log(`  ↳  registerTier(${tIdx}, pm, fee) OK`);

  await (await tierRouter.registerMatrix(matAAddr, tIdx)).wait();
  await (await tierRouter.registerMatrix(matBAddr, tIdx)).wait();
  console.log(`  ↳  registerMatrix MatA + MatB OK`);

  const pm = await ethers.getContractAt("PairManagerV8", pmAddr, deployer);
  await (await pm.addPair(matAAddr, matBAddr)).wait();
  console.log(`  ↳  PairManager.addPair OK`);

  // ── StabilityFund authorization ───────────────────────────────────────────
  await (await stabilityFund.setMatrixAuthorized(matAAddr, true)).wait();
  await (await stabilityFund.setMatrixAuthorized(matBAddr, true)).wait();
  console.log(`  ↳  StabilityFund authorized for MatA + MatB`);

  // ── Treasury authorization ────────────────────────────────────────────────
  await (await treasury.setAuthorizedCaller(matAAddr, true)).wait();
  await (await treasury.setAuthorizedCaller(matBAddr, true)).wait();
  console.log(`  ↳  Treasury.setAuthorizedCaller OK`);

  // ── CNOVA MINTER_ROLE ─────────────────────────────────────────────────────
  sep(`CNOVA MINTER_ROLE`);
  const MINTER_ROLE = await cnova.MINTER_ROLE();
  await (await cnova.grantRole(MINTER_ROLE, matAAddr)).wait();
  await (await cnova.grantRole(MINTER_ROLE, matBAddr)).wait();
  console.log(`  ↳  MINTER_ROLE granted to MatA + MatB`);

  // ── MatrixKeeper ──────────────────────────────────────────────────────────
  sep(`MatrixKeeper`);
  await (await keeper.setPairManager(tIdx, pmAddr)).wait();
  console.log(`  ↳  keeper.setPairManager(${tIdx}, pm) OK`);

  // ── Velocity gate — open T3 for auto-upgrades ─────────────────────────────
  sep(`Velocity Gate`);
  await (await tierRouter.setTierVelocityGreen(tIdx, true)).wait();
  console.log(`  ↳  tierVelocityGreen[${tIdx}] = true  (T${ADD_TIER} open for upgrades)`);

  // ── Save updated addresses ────────────────────────────────────────────────
  sep(`Save Addresses`);
  if (!saved.tiers) saved.tiers = {};
  saved.tiers[tierKey] = { pm: pmAddr, matA: matAAddr, matB: matBAddr };
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(saved, null, 2));
  console.log(`  ↳  ${ADDRESSES_FILE} updated with T${ADD_TIER}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  sep(`T${ADD_TIER} Deploy Complete`);
  console.log(`  PairManager : ${pmAddr}`);
  console.log(`  MatA        : ${matAAddr}`);
  console.log(`  MatB        : ${matBAddr}`);
  console.log(`  Entry Fee   : $${Number(fee)/1e6}`);
  console.log(`  Velocity    : OPEN`);
  console.log(`\n  Next: update index.html ADDRS.T${ADD_TIER} with these addresses`);
  console.log(`        and add T3 matrices to the dashboard matrix loop.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
