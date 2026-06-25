// fix_wiring_v8_24.js
// Completion script for the V8.24 deploy that crashed at "in-flight transaction
// limit reached" during the governance wiring section.
//
// What the main deploy DID complete:
//   ✓  All 10 tier pairs (MatA + MatB + PairManagerV8) deployed and wired
//   ✓  MatrixKeeper deployed + setMatrixKeeper on SF + TierRouter
//   ✓  V8Governance deployed
//
// What this script finishes:
//   1.  setGovernance on MatrixKeeper, TierRouter, all MatA/MatB, all PairManagerV8
//   2.  setGovernance on StabilityFund + BuybackReserve
//   3.  CNOVA role grants (MINTER_ROLE to every matrix, GOVERNOR_ROLE to governance)
//   4.  Deploy CommunityWallet + full wiring
//   5.  Deploy CNOVADirectSale + DIRECT_SALE_ROLE + setGovernance
//   6.  TierRouter.setDefaultReferrer(W1)
//   7.  Update deployed_addresses_v8_24.json with new contract addresses
//
// Run:
//   npx hardhat run scripts/fix_wiring_v8_24.js --network baseSepolia
//
// Safe to re-run: every setGovernance call is idempotent; role grants are idempotent.
// If CommunityWallet or DirectSale already deployed (addresses non-empty in JSON),
// the script will skip re-deployment and only do the wiring.

const hre    = require("hardhat");
const ethers = hre.ethers;
const fs     = require("fs");
const path   = require("path");
require("dotenv").config();

const ADDR_FILE = path.join(__dirname, "deployed_addresses_v8_24.json");
const DEPLOY_TIERS = [1,2,3,4,5,6,7,8,9,10];

// 1.5 second gap between TX to avoid the "in-flight limit" RPC error
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DELAY = 1500;

async function tx(call, label) {
  process.stdout.write(`  → ${label} ... `);
  const receipt = await (await call).wait();
  console.log(`OK  (block ${receipt.blockNumber})`);
  await sleep(DELAY);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n  Deployer: ${deployer.address}`);

  // ── load addresses ──────────────────────────────────────────────────────────
  const addrs = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

  const govAddr  = addrs.v8Governance;
  const sfAddr   = addrs.stabilityFund;
  const bbrAddr  = addrs.buybackReserve;
  const trAddr   = addrs.tierRouter;
  const keeperAddr = addrs.matrixKeeper;
  const cnovaAddr  = addrs.cnova;
  const usdcAddr   = addrs.usdc;
  const treasuryAddr = addrs.treasury;
  const liquidityReserve = addrs.liquidityReserve;

  // ABIs / factories
  const FE = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA, deployer);  // just for interface
  const keeper      = await ethers.getContractAt("MatrixKeeper",   keeperAddr, deployer);
  const tierRouter  = await ethers.getContractAt("TierRouter",     trAddr,     deployer);
  const stabilityFund  = await ethers.getContractAt("StabilityFund",      sfAddr,  deployer);
  const buybackReserve = await ethers.getContractAt("CNOVABuybackReserve", bbrAddr, deployer);
  const cnova = await ethers.getContractAt("CNOVAToken", cnovaAddr, deployer);

  // ── 1. setGovernance on keeper + tierRouter ─────────────────────────────────
  console.log("\n  ── 1. setGovernance: keeper + tierRouter ───────────────────────");
  await tx(keeper.setGovernance(govAddr),     "keeper.setGovernance");
  await tx(tierRouter.setGovernance(govAddr), "tierRouter.setGovernance");

  // ── 2. setGovernance on all matrices + PairManagers ─────────────────────────
  console.log("\n  ── 2. setGovernance: all matrices + PairManagerV8 ─────────────");
  for (const tierNum of DEPLOY_TIERS) {
    const { matA, matB, pm } = addrs.tiers[`T${tierNum}`];
    const mA = await ethers.getContractAt("FigureEightMatrixV8", matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", matB, deployer);
    const pairMgr = await ethers.getContractAt("PairManagerV8", pm, deployer);
    await tx(mA.setGovernance(govAddr),      `T${tierNum} MatA.setGovernance`);
    await tx(mB.setGovernance(govAddr),      `T${tierNum} MatB.setGovernance`);
    await tx(pairMgr.setGovernance(govAddr), `T${tierNum} PM.setGovernance`);
  }

  // ── 3. setGovernance on SF + BuybackReserve ─────────────────────────────────
  console.log("\n  ── 3. setGovernance: StabilityFund + BuybackReserve ───────────");
  await tx(stabilityFund.setGovernance(govAddr),  "stabilityFund.setGovernance");
  await tx(buybackReserve.setGovernance(govAddr), "buybackReserve.setGovernance");

  // ── 4. CNOVA role grants ─────────────────────────────────────────────────────
  console.log("\n  ── 4. CNOVA role grants ────────────────────────────────────────");
  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  for (const tierNum of DEPLOY_TIERS) {
    const { matA, matB } = addrs.tiers[`T${tierNum}`];
    await tx(cnova.grantRole(MINTER_ROLE, matA), `T${tierNum} MatA MINTER_ROLE`);
    await tx(cnova.grantRole(MINTER_ROLE, matB), `T${tierNum} MatB MINTER_ROLE`);
  }
  await tx(cnova.grantRole(GOVERNOR_ROLE, govAddr), "V8Governance GOVERNOR_ROLE on CNOVA");

  // ── 5. CommunityWallet ───────────────────────────────────────────────────────
  console.log("\n  ── 5. CommunityWallet ──────────────────────────────────────────");
  let cwAddr = addrs.communityWallet;
  let cw;
  if (cwAddr && cwAddr.length === 42) {
    console.log(`  ℹ  CommunityWallet already deployed at ${cwAddr} — skipping deploy`);
    cw = await ethers.getContractAt("CommunityWallet", cwAddr, deployer);
  } else {
    const admin = deployer.address;
    const CommunityWallet = await ethers.getContractFactory("CommunityWallet", deployer);
    const cwContract = await CommunityWallet.deploy(usdcAddr, admin);
    await cwContract.waitForDeployment();
    cwAddr = await cwContract.getAddress();
    cw = cwContract;
    console.log(`  ✓  CommunityWallet deployed at ${cwAddr}`);
    await sleep(DELAY);
  }

  await tx(cw.setEnrollor(trAddr),                               "CW.setEnrollor(TierRouter)");
  const CW_GOVERNOR_ROLE = await cw.GOVERNOR_ROLE();
  await tx(cw.grantRole(CW_GOVERNOR_ROLE, govAddr),              "CW GOVERNOR_ROLE → V8Governance");
  await tx(tierRouter.setCommunityWallet(cwAddr),                "tierRouter.setCommunityWallet");
  await tx(stabilityFund.setCommunityWallet(cwAddr),             "stabilityFund.setCommunityWallet");
  await tx(keeper.setCommunityWallet(cwAddr),                    "keeper.setCommunityWallet");

  for (const tierNum of DEPLOY_TIERS) {
    const { matA, matB } = addrs.tiers[`T${tierNum}`];
    const mA = await ethers.getContractAt("FigureEightMatrixV8", matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", matB, deployer);
    await tx(mA.setCommunityWallet(cwAddr), `T${tierNum} MatA.setCommunityWallet`);
    await tx(mB.setCommunityWallet(cwAddr), `T${tierNum} MatB.setCommunityWallet`);
  }

  // ── 6. CNOVADirectSale ──────────────────────────────────────────────────────
  console.log("\n  ── 6. CNOVADirectSale ──────────────────────────────────────────");
  let dsAddr = addrs.directSale;
  let directSale;
  if (dsAddr && dsAddr.length === 42) {
    console.log(`  ℹ  CNOVADirectSale already deployed at ${dsAddr} — skipping deploy`);
    directSale = await ethers.getContractAt("CNOVADirectSale", dsAddr, deployer);
  } else {
    const DS_SF_TARGET_USD = Number(process.env.DS_SF_TARGET_USD || 500);
    const DS_LQ_TARGET_USD = Number(process.env.DS_LQ_TARGET_USD || 1000);
    const dsSfTarget = BigInt(DS_SF_TARGET_USD) * 1_000_000n;
    const dsLqTarget = BigInt(DS_LQ_TARGET_USD) * 1_000_000n;

    const CNOVADirectSale = await ethers.getContractFactory("CNOVADirectSale", deployer);
    const ds = await CNOVADirectSale.deploy(
      usdcAddr, cnovaAddr, treasuryAddr, sfAddr, liquidityReserve, dsSfTarget, dsLqTarget
    );
    await ds.waitForDeployment();
    dsAddr = await ds.getAddress();
    directSale = ds;
    console.log(`  ✓  CNOVADirectSale deployed at ${dsAddr} (SF target $${DS_SF_TARGET_USD} / LQ $${DS_LQ_TARGET_USD})`);
    await sleep(DELAY);
  }

  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await tx(cnova.grantRole(DIRECT_SALE_ROLE, dsAddr),  "DIRECT_SALE_ROLE → CNOVADirectSale");
  await tx(directSale.setGovernance(govAddr),           "directSale.setGovernance");

  // ── 7. setDefaultReferrer to W1 ─────────────────────────────────────────────
  console.log("\n  ── 7. setDefaultReferrer ───────────────────────────────────────");
  const w1Key = process.env.W1_PRIVATE_KEY;
  if (!w1Key) {
    console.log("  ⚠  W1_PRIVATE_KEY not set — skipping setDefaultReferrer");
  } else {
    const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);
    await tx(tierRouter.setDefaultReferrer(w1Wallet.address), `setDefaultReferrer → ${w1Wallet.address}`);
  }

  // ── 8. Save updated addresses ────────────────────────────────────────────────
  console.log("\n  ── 8. Saving updated addresses ─────────────────────────────────");
  addrs.communityWallet = cwAddr;
  addrs.directSale      = dsAddr;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(addrs, null, 2));
  console.log(`  ✓  deployed_addresses_v8_24.json updated`);

  console.log("\n  ══════════════════════════════════════════════════════════");
  console.log("  V8.24 wiring complete.");
  console.log("  CommunityWallet : " + cwAddr);
  console.log("  CNOVADirectSale : " + dsAddr);
  console.log("  Next: update direct_keeper.js MATRIX_KEEPER to " + keeperAddr);
  console.log("  Then: PRESET=1 npx hardhat run scripts/set_rescue_ladder.js --network baseSepolia");
  console.log("  ══════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
