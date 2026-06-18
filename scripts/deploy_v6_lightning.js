/**
 * deploy_v6_lightning.js — CryptoNova V6 Lightning Self-Test Deploy
 * ─────────────────────────────────────────────────────────────────
 * All parameters shrunk to see full lifecycle in one sitting.
 * Price stays $10 — same as mainnet.
 *
 * Run: npx hardhat run scripts/deploy_v6_lightning.js --network baseSepolia
 */
"use strict";
const { ethers } = require("hardhat");
require("dotenv").config();
const { PARAMS, TIER_FEE_MULTIPLIERS, TIER_NAMES, USDC_UNIT } = require("./v6_params");
const P = PARAMS.lightning;

const EXISTING_USDC = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";

function sep() { console.log("─".repeat(60)); }
async function waitTx(tx, label) {
  const r = await tx.wait();
  console.log(`  [tx] ${label} ... ✓  (gas: ${r.gasUsed})`);
}

async function deployMatrix(MatrixV6, usdc, cnova, treasury, cw, dev, ops, admin, fee, matrixSize) {
  return MatrixV6.deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev, ops, await cw.getAddress(), admin, fee, matrixSize
  );
}

async function deployBeltSet(BeltMgr, MatrixV6, usdc, cnova, treasury, cw, dev, ops, admin, fee, tierLabel) {
  const bm = await BeltMgr.deploy(await usdc.getAddress(), admin, P.BELT_MAX);
  await bm.waitForDeployment();
  console.log(`  BeltManagerV6 (${tierLabel}) : ${await bm.getAddress()}`);

  // Deploy NUM_BELTS matrices as belts
  const belts = [];
  for (let b = 0; b < P.NUM_BELTS; b++) {
    const belt = await deployMatrix(MatrixV6, usdc, cnova, treasury, cw, dev, ops, admin, fee, P.MATRIX_SIZE);
    await belt.waitForDeployment();
    belts.push(belt);
    await (await bm.addBelt(await belt.getAddress())).wait();
    console.log(`    Belt ${String.fromCharCode(65+b)} (${tierLabel}) : ${await belt.getAddress()}`);
  }
  return { bm, belts };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const devWallet   = process.env.DEV_WALLET_ADDRESS   || deployer.address;
  const opsWallet   = process.env.OPS_WALLET_ADDRESS   || deployer.address;
  const adminWallet = process.env.ADMIN_WALLET_ADDRESS || deployer.address;

  sep();
  console.log(`  ⚡  CryptoNova V6 LIGHTNING DEPLOY`);
  console.log(`  ${P.label}`);
  console.log(`  MATRIX=${P.MATRIX_SIZE} | BELT_MAX=${P.BELT_MAX} | $10 | W=${P.ACTIVE_WINDOW}`);
  sep();
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Reusing MockUSDC: ${EXISTING_USDC}`);

  const usdc = await ethers.getContractAt("MockUSDC", EXISTING_USDC);

  // ── Core contracts ────────────────────────────────────────────────────────
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnova = await CNOVAToken.deploy(adminWallet);
  await cnova.waitForDeployment();
  console.log(`  CNOVAToken      : ${await cnova.getAddress()}`);

  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await CNOVATreasury.deploy(await cnova.getAddress(), EXISTING_USDC, adminWallet);
  await treasury.waitForDeployment();
  console.log(`  CNOVATreasury   : ${await treasury.getAddress()}`);

  const CW = await ethers.getContractFactory("CryptoNovaCommunityWallet");
  const cw = await CW.deploy(EXISTING_USDC, adminWallet);
  await cw.waitForDeployment();
  console.log(`  CommunityWallet : ${await cw.getAddress()}`);

  // ── Per-tier belt+matrix systems ─────────────────────────────────────────
  sep();
  console.log("  Deploying 7 tier belt systems...");
  const MatrixV6 = await ethers.getContractFactory("CryptoNovaMatrixV6");
  const BeltMgr  = await ethers.getContractFactory("BeltManagerV6");
  const TierMgr  = await ethers.getContractFactory("TierManagerV6");

  const tierSystems = {};
  for (let t = 1; t <= 7; t++) {
    const fee = BigInt(TIER_FEE_MULTIPLIERS[t]) * USDC_UNIT;
    const { bm, belts } = await deployBeltSet(
      BeltMgr, MatrixV6, usdc, cnova, treasury, cw,
      devWallet, opsWallet, adminWallet, fee, `T${t} ${TIER_NAMES[t]}`
    );
    tierSystems[t] = { bm, belts, fee };
  }

  // ── TierManagerV6 ─────────────────────────────────────────────────────────
  sep();
  const tm = await TierMgr.deploy(
    EXISTING_USDC, await cnova.getAddress(), await treasury.getAddress(),
    devWallet, opsWallet, adminWallet, USDC_UNIT,
    P.WHALE_GATE_T5, P.WHALE_GATE_T6, P.WHALE_GATE_T7
  );
  await tm.waitForDeployment();
  const tmAddr = await tm.getAddress();
  console.log(`  TierManagerV6   : ${tmAddr}`);

  // ── Wiring ────────────────────────────────────────────────────────────────
  sep();
  console.log("  Wiring roles and references...");
  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  const EPOCH  = await cnova.EPOCH_ROLE();

  for (let t = 1; t <= 7; t++) {
    const { bm, belts } = tierSystems[t];
    const bmAddr = await bm.getAddress();

    // CNOVA roles for all belts
    for (const belt of belts) {
      await cnova.grantRole(MINTER, await belt.getAddress());
      await treasury.setAuthorizedCaller(await belt.getAddress(), true);
      await cw.setAuthorisedRegistrar(await belt.getAddress(), true);
    }
    await cnova.grantRole(MINTER, tmAddr);

    // EPOCH_ROLE to T1 Belt A
    if (t === 1) await cnova.grantRole(EPOCH, await belts[0].getAddress());

    // TierManager knows this belt manager
    await tm.setBeltManagerV6(t, bmAddr);
    await cw.setAuthorisedRegistrar(bmAddr, true);

    // TierManager authorized as registrar on this BeltManager (for registerFor)
    await bm.setAuthorizedRegistrar(tmAddr, true);

    // BeltManager authorized on all belts
    for (const belt of belts) {
      await belt.setAuthorizedCaller(bmAddr, true);
      await belt.setBeltManagerCaller(bmAddr);
      await belt.setTierManager(tmAddr);
      await tm.setAutoUpgradeCaller(await belt.getAddress(), true);
    }

    console.log(`  T${t} ${TIER_NAMES[t]} wired ✓`);
  }

  await cnova.grantRole(BURNER, await treasury.getAddress());
  await treasury.setTier1Matrix(await tierSystems[1].bm.getAddress());
  await treasury.setCommunityWallet(await cw.getAddress());

  console.log("  ✓ All roles wired");

  // ── Summary ───────────────────────────────────────────────────────────────
  sep();
  console.log("  ⚡ V6 LIGHTNING DEPLOY COMPLETE");
  sep();
  console.log(`  USDC            : ${EXISTING_USDC}`);
  console.log(`  CNOVAToken      : ${await cnova.getAddress()}`);
  console.log(`  CNOVATreasury   : ${await treasury.getAddress()}`);
  console.log(`  CommunityWallet : ${await cw.getAddress()}`);
  console.log(`  TierManagerV6   : ${tmAddr}`);
  for (let t = 1; t <= 7; t++) {
    const fee = Number(TIER_FEE_MULTIPLIERS[t] * Number(USDC_UNIT) / 1_000_000);
    console.log(`  T${t} BeltManager  : ${await tierSystems[t].bm.getAddress()}  ($${fee} ${TIER_NAMES[t]})`);
  }
  sep();
  console.log(`  Matrix size     : ${P.MATRIX_SIZE} (lightning)`);
  console.log(`  Belt max        : ${P.BELT_MAX}`);
  console.log(`  Belts per tier  : ${P.NUM_BELTS}`);
  console.log(`  Whale gate      : ${P.WHALE_GATE_T5}/${P.WHALE_GATE_T6}/${P.WHALE_GATE_T7}`);
  console.log(`  Epoch limit     : ${P.EPOCH_MEMBER_LIMIT}`);
  sep();
}

main().catch(e => { console.error(e); process.exit(1); });
