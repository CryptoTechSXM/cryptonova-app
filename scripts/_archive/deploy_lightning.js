/**
 * deploy_lightning.js — CryptoNova Lightning Test Deploy
 * ─────────────────────────────────────────────────────────
 * Parameters vs standard deploy:
 *   ACTIVE_WINDOW : 2   (rotation every 2nd joiner)
 *   BELT_MAX      : 10  (belt flips after 10 members)
 *   USDC_UNIT     : 100_000 (0.1 USDC) → fees 10x cheaper
 *   Tier fees     : $1 / $2.50 / $5 / $10 / $25 / $50 / $100
 *   EPOCH_LIMIT   : 5   (epoch changes every 5 joins — already set)
 *   CW Tranches   : 5 / 10 slots
 *
 * Run: npx hardhat run scripts/deploy_lightning.js --network baseSepolia
 */
"use strict";
const { ethers } = require("hardhat");
require("dotenv").config();

const BASE_USDC     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LIGHTNING_UNIT = 100_000n;   // 0.1 USDC per unit → fees 10x cheaper

// Lightning fee multipliers (same as normal but unit is 0.1 USDC)
// T1: 10 × $0.10 = $1.00  T2: 25 × $0.10 = $2.50  etc.
const TIER_FEE_MULTIPLIERS = { 1:10, 2:25, 3:50, 4:100, 5:250, 6:500, 7:1000 };
const TIER_NAMES = {
  1:"Nova Seed", 2:"Nova Rise", 3:"Nova Star", 4:"Nova Prime",
  5:"SuperNova Genesis", 6:"SuperNova Elite", 7:"SuperNova Spark"
};

const ACTIVE_WINDOW = 2n;   // ⚡ lightning
const BELT_MAX      = 10n;  // ⚡ lightning

function sep() { console.log("─".repeat(60)); }
async function waitTx(tx, label) {
  const r = await tx.wait();
  console.log(`  [tx] ${label} ... ✓  (gas: ${r.gasUsed.toString()})`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const isTestnet  = network.chainId === 84532n;

  const devWallet   = process.env.DEV_WALLET_ADDRESS   || deployer.address;
  const opsWallet   = process.env.OPS_WALLET_ADDRESS   || deployer.address;
  const adminWallet = process.env.ADMIN_WALLET_ADDRESS || deployer.address;

  sep();
  console.log("  ⚡  CryptoNova LIGHTNING TEST Deploy");
  console.log("  AW=2 | BELT_MAX=10 | $1/$2.50/$5/$10/$25/$50/$100");
  sep();
  console.log(`  Deployer : ${deployer.address}`);

  // USDC — always reuse the existing MockUSDC so testers keep their balances
  const EXISTING_USDC = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
  const usdcAddress = EXISTING_USDC;
  console.log(`  → Reusing existing MockUSDC: ${usdcAddress}`);

  // 1. CNOVAToken
  sep();
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnova = await CNOVAToken.deploy(adminWallet);
  await cnova.waitForDeployment();
  const cnovaAddress = await cnova.getAddress();
  console.log(`  CNOVAToken      : ${cnovaAddress}`);

  // 2. Treasury
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await CNOVATreasury.deploy(cnovaAddress, usdcAddress, adminWallet);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log(`  CNOVATreasury   : ${treasuryAddress}`);

  // 3. CommunityWallet
  const CommunityWallet = await ethers.getContractFactory("CryptoNovaCommunityWallet");
  const communityWallet = await CommunityWallet.deploy(usdcAddress, adminWallet);
  await communityWallet.waitForDeployment();
  const communityAddress = await communityWallet.getAddress();
  console.log(`  CommunityWallet : ${communityAddress}`);

  // 4-10. Matrices (AW=2)
  sep();
  console.log("  Deploying 7 matrices (AW=2) + BeltManager (BELT_MAX=10)...");
  const MatrixV3 = await ethers.getContractFactory("CryptoNovaMatrixV3");
  const matrices = {};
  for (let tier = 1; tier <= 7; tier++) {
    const mult = TIER_FEE_MULTIPLIERS[tier];
    const matrix = await MatrixV3.deploy(
      usdcAddress, cnovaAddress, treasuryAddress,
      devWallet, opsWallet, communityAddress,
      adminWallet, LIGHTNING_UNIT, BigInt(mult), ACTIVE_WINDOW
    );
    await matrix.waitForDeployment();
    matrices[tier] = matrix;
    const fee = Number(LIGHTNING_UNIT) * mult / 1_000_000;
    console.log(`  Tier ${tier} (${TIER_NAMES[tier]}, $${fee.toFixed(2)}) : ${await matrix.getAddress()}`);
  }

  // 11. BeltManager (BELT_MAX=10)
  const BeltMgr = await ethers.getContractFactory("BeltManager");
  const beltManager = await BeltMgr.deploy(usdcAddress, adminWallet, BELT_MAX);
  await beltManager.waitForDeployment();
  const beltManagerAddress = await beltManager.getAddress();
  console.log(`  BeltManager (max 10/belt) : ${beltManagerAddress}`);

  // Extra belts B-J (9 extra + Belt A = 10 total, maintains 5-belt buffer)
  const extraBelts = [];
  for (let b = 0; b < 9; b++) {
    const belt = await MatrixV3.deploy(
      usdcAddress, cnovaAddress, treasuryAddress,
      devWallet, opsWallet, communityAddress,
      adminWallet, LIGHTNING_UNIT, 10n, ACTIVE_WINDOW
    );
    await belt.waitForDeployment();
    extraBelts.push(belt);
    console.log(`  Belt ${String.fromCharCode(66+b)}               : ${await belt.getAddress()}`);
  }

  // Add belts to BeltManager
  await (await beltManager.addBelt(await matrices[1].getAddress())).wait();
  for (const b of extraBelts) {
    await (await beltManager.addBelt(await b.getAddress())).wait();
  }

  // 12. TierManager
  const TierManager = await ethers.getContractFactory("CryptoNovaTierManager");
  const tierManager = await TierManager.deploy(
    usdcAddress, cnovaAddress, treasuryAddress,
    devWallet, opsWallet, communityAddress,
    adminWallet, LIGHTNING_UNIT
  );
  await tierManager.waitForDeployment();
  const tierManagerAddress = await tierManager.getAddress();
  console.log(`  TierManager     : ${tierManagerAddress}`);

  // 13. Wire everything
  sep();
  console.log("  Wiring roles...");
  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  const EPOCH  = await cnova.EPOCH_ROLE();
  const allBeltContracts = [matrices[1], ...extraBelts];

  for (let t = 1; t <= 7; t++) await (await cnova.grantRole(MINTER, await matrices[t].getAddress())).wait();
  await (await cnova.grantRole(MINTER, tierManagerAddress)).wait();
  await (await cnova.grantRole(BURNER, treasuryAddress)).wait();
  await (await cnova.grantRole(EPOCH,  await matrices[1].getAddress())).wait();
  for (const b of extraBelts) await (await cnova.grantRole(MINTER, await b.getAddress())).wait();

  for (let t = 1; t <= 7; t++) await (await tierManager.setMatrix(t, await matrices[t].getAddress())).wait();

  for (let t = 1; t <= 7; t++) {
    await (await communityWallet.setAuthorisedRegistrar(await matrices[t].getAddress(), true)).wait();
    await (await treasury.setAuthorizedCaller(await matrices[t].getAddress(), true)).wait();
  }
  await (await communityWallet.setAuthorisedRegistrar(tierManagerAddress, true)).wait();
  await (await communityWallet.setAuthorisedRegistrar(beltManagerAddress, true)).wait();

  for (let t = 2; t <= 7; t++) await (await matrices[t].setAuthorizedRegistrar(tierManagerAddress, true)).wait();
  await (await matrices[1].setAuthorizedRegistrar(beltManagerAddress, true)).wait();
  for (const b of extraBelts) {
    await (await b.setAuthorizedRegistrar(beltManagerAddress, true)).wait();
    await (await treasury.setAuthorizedCaller(await b.getAddress(), true)).wait();
    await (await communityWallet.setAuthorisedRegistrar(await b.getAddress(), true)).wait();
    await (await cnova.grantRole(MINTER, await b.getAddress())).wait();
  }

  await (await treasury.setCommunityWallet(communityAddress)).wait();
  await (await treasury.setTier1Matrix(beltManagerAddress)).wait();
  await (await tierManager.setBeltManager(beltManagerAddress)).wait();

  // Auto-upgrade wiring
  for (let t = 1; t <= 7; t++) {
    await (await matrices[t].setTierManager(tierManagerAddress)).wait();
    await (await tierManager.setAutoUpgradeCaller(await matrices[t].getAddress(), true)).wait();
  }
  for (const b of extraBelts) {
    await (await b.setTierManager(tierManagerAddress)).wait();
    await (await tierManager.setAutoUpgradeCaller(await b.getAddress(), true)).wait();
  }

  // V5: setBeltManagerCaller on all T1 belts so triggerReentry() works
  const bmAddr = await beltManager.getAddress();
  await (await matrices[1].setBeltManagerCaller(bmAddr)).wait();
  for (const b of extraBelts) await (await b.setBeltManagerCaller(bmAddr)).wait();

  console.log("  ✓ All roles wired");

  // Summary
  sep();
  console.log("  ⚡ LIGHTNING DEPLOY COMPLETE");
  sep();
  console.log(`  USDC            : ${usdcAddress}`);
  console.log(`  CNOVAToken      : ${cnovaAddress}`);
  console.log(`  CNOVATreasury   : ${treasuryAddress}`);
  console.log(`  CommunityWallet : ${communityAddress}`);
  console.log(`  BeltManager     : ${beltManagerAddress}`);
  console.log(`  TierManager     : ${tierManagerAddress}`);
  for (let t = 1; t <= 7; t++) {
    const fee = Number(LIGHTNING_UNIT) * TIER_FEE_MULTIPLIERS[t] / 1_000_000;
    console.log(`  Tier ${t} Matrix  : ${await matrices[t].getAddress()}  ($${fee.toFixed(2)})`);
  }
  sep();
  console.log("  Active Window   : 2  (rotation every 2nd joiner)");
  console.log("  Belt Max        : 10 (belt flips at 10 members)");
  console.log("  Fees            : $1 / $2.50 / $5 / $10 / $25 / $50 / $100");
  console.log("  Epoch trigger   : 5 joins");
  sep();
}

main().catch(e => { console.error(e); process.exit(1); });
