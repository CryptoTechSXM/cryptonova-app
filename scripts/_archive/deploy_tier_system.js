/**
 * CryptoNova Tier System Deploy Script — Base Chain
 * ─────────────────────────────────────────────────────────────────
 * Deploys the full 7-tier CryptoNova Tier Ladder:
 *
 *  Deploy order:
 *   1.  CNOVAToken                  — shared across all tiers
 *   2.  CNOVATreasury               — shared USDC reserve / floor price engine
 *   3.  CryptoNovaCommunityWallet   — founding member pool (2,000 slots)
 *   4.  CryptoNovaMatrixV3 (Tier 1) — Nova Seed              $10
 *   5.  CryptoNovaMatrixV3 (Tier 2) — Nova Rise              $25
 *   6.  CryptoNovaMatrixV3 (Tier 3) — Nova Star              $50
 *   7.  CryptoNovaMatrixV3 (Tier 4) — Nova Prime            $100
 *   8.  CryptoNovaMatrixV3 (Tier 5) — SuperNova Genesis     $250  ← Whale Gate
 *   9.  CryptoNovaMatrixV3 (Tier 6) — SuperNova Elite       $500
 *  10.  CryptoNovaMatrixV3 (Tier 7) — SuperNova Spark     $1,000
 *  11.  CryptoNovaTierManager       — upgrade controller
 *
 *  Post-deploy wiring:
 *   12. Grant MINTER_ROLE  on CNOVAToken  → all 7 matrices + TierManager
 *   13. Grant BURNER_ROLE  on CNOVAToken  → CNOVATreasury
 *   14. Grant EPOCH_ROLE   on CNOVAToken  → Tier-1 matrix
 *   15. setMatrix()        on TierManager → matrices 1–7
 *   16. setAuthorisedRegistrar() on CommunityWallet → all 7 matrices + TierManager
 *   17. setAuthorizedRegistrar() on each V3 matrix (tiers 2–7) → TierManager
 *       (TierManager calls registerFor() on tier upgrade)
 *
 * Usage:
 *   Base Sepolia  : npx hardhat run scripts/deploy_tier_system.js --network baseSepolia
 *   Base Mainnet  : npx hardhat run scripts/deploy_tier_system.js --network baseMainnet
 *   Local         : npx hardhat run scripts/deploy_tier_system.js --network hardhat
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY      — one-time deploy key (never reuse)
 *   DEV_WALLET_ADDRESS        — 0x7fc2158892F14b9A1fB6e39B788d4d08daF49C0a
 *   OPS_WALLET_ADDRESS        — 0xa23A0492A823a2FfB6D3998dDd487695F5ba4019
 *   ADMIN_WALLET_ADDRESS      — multi-sig or admin EOA (contract owner)
 *   USDC_ADDRESS              — leave blank on testnet (MockUSDC auto-deployed)
 */

"use strict";

const { ethers } = require("hardhat");
require("dotenv").config();

// ─── Chain configuration ──────────────────────────────────────────────────────
const BASE_USDC     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_UNIT     = 1_000_000n;      // 1e6 — Base USDC has 6 decimals
const ACTIVE_WINDOW = 5n;              // engine test (lightning: 2, mainnet: 50)
const BELT_MAX      = 50n;             // engine test (lightning: 10, mainnet: 500)
const USDC_DECIMALS = 6;

// Tier names (must match TierManager constructor comments)
const TIER_NAMES = {
  1: "Nova Seed",
  2: "Nova Rise",
  3: "Nova Star",
  4: "Nova Prime",           // Whale Gate — fast-track unlocks here
  5: "SuperNova Genesis",
  6: "SuperNova Elite",
  7: "SuperNova Spark",
};

// Fee in whole dollars — passed as _feeMultiplier to V3 constructor
// Must match tierFee[] in TierManager constructor
const TIER_FEE_MULTIPLIERS = {
  1:    10,   // $10
  2:    25,   // $25
  3:    50,   // $50
  4:   100,   // $100
  5:   250,   // $250
  6:   500,   // $500
  7:  1000,   // $1,000
};

// Full fee amounts in USDC native units (for manifest)
const TIER_FEES = Object.fromEntries(
  Object.entries(TIER_FEE_MULTIPLIERS).map(([t, m]) => [t, BigInt(m) * USDC_UNIT])
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`  → ${msg}`); }
function sep()    { console.log("─".repeat(60)); }

async function waitTx(tx, label) {
  process.stdout.write(`  [tx] ${label} ... `);
  const receipt = await tx.wait();
  console.log(`✓  (gas: ${receipt.gasUsed.toString()})`);
  return receipt;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  sep();
  console.log("  CryptoNova Tier System — Full Deploy (7 Matrices)");
  sep();

  // ── Signers ───────────────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  log(`Deployer   : ${deployer.address}`);

  const devWallet   = process.env.DEV_WALLET_ADDRESS;
  const opsWallet   = process.env.OPS_WALLET_ADDRESS;
  const adminWallet = process.env.ADMIN_WALLET_ADDRESS || deployer.address;

  if (!devWallet)   throw new Error("Missing DEV_WALLET_ADDRESS in .env");
  if (!opsWallet)   throw new Error("Missing OPS_WALLET_ADDRESS in .env");

  log(`Dev wallet : ${devWallet}`);
  log(`Ops wallet : ${opsWallet}`);
  log(`Admin      : ${adminWallet}`);

  // ── USDC ──────────────────────────────────────────────────────────────────
  let usdcAddress = process.env.USDC_ADDRESS;
  let mockUsdc;

  if (!usdcAddress || usdcAddress === "") {
    sep();
    console.log("  [1] Deploying MockUSDC (testnet only)");
    // MockUSDC lives in contracts/test/MockUSDC.sol and takes (address admin)
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc    = await MockUSDC.deploy(deployer.address);
    await mockUsdc.waitForDeployment();
    usdcAddress = await mockUsdc.getAddress();
    log(`MockUSDC deployed at: ${usdcAddress}`);

    // Mint 1,000,000 USDC to deployer for testnet testing (need more for higher tiers)
    const mintAmount = 1_000_000n * USDC_UNIT;
    await waitTx(await mockUsdc.mint(deployer.address, mintAmount), "Mint 1,000,000 USDC → deployer");
  } else {
    log(`Using existing USDC : ${usdcAddress}`);
  }

  const usdc = await ethers.getContractAt("IERC20", usdcAddress);

  // ── 1. CNOVAToken ─────────────────────────────────────────────────────────
  // If CNOVA_ADDRESS is set in .env, reuse the already-deployed token
  let cnovaAddress = process.env.CNOVA_ADDRESS;
  let cnovaToken;
  if (cnovaAddress && cnovaAddress !== "") {
    log(`Reusing CNOVAToken  : ${cnovaAddress}`);
    cnovaToken = await ethers.getContractAt("CNOVAToken", cnovaAddress);
  } else {
    sep();
    console.log("  [1] Deploying CNOVAToken");
    const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
    cnovaToken = await CNOVAToken.deploy(adminWallet);
    await cnovaToken.waitForDeployment();
    cnovaAddress = await cnovaToken.getAddress();
  }
  log(`CNOVAToken : ${cnovaAddress}`);

  // ── 2. CNOVATreasury ──────────────────────────────────────────────────────
  sep();
  console.log("  [2] Deploying CNOVATreasury");
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await CNOVATreasury.deploy(
    cnovaAddress,   // _cnova
    usdcAddress,    // _usdc
    adminWallet     // _admin
  );
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  log(`CNOVATreasury : ${treasuryAddress}`);

  // ── 3. CryptoNovaCommunityWallet ──────────────────────────────────────────
  sep();
  console.log("  [3] Deploying CryptoNovaCommunityWallet");
  const CommunityWallet = await ethers.getContractFactory("CryptoNovaCommunityWallet");
  const communityWallet = await CommunityWallet.deploy(
    usdcAddress,
    adminWallet
  );
  await communityWallet.waitForDeployment();
  const communityAddress = await communityWallet.getAddress();
  log(`CommunityWallet : ${communityAddress}`);

  // ── 4–10. CryptoNovaMatrixV3 instances (tiers 1–7) ───────────────────────
  sep();
  console.log("  [4–10] Deploying 7× CryptoNovaMatrixV3 matrices");
  const MatrixV3 = await ethers.getContractFactory("CryptoNovaMatrixV3");
  const matrices = {};

  for (let tier = 1; tier <= 7; tier++) {
    const mult = TIER_FEE_MULTIPLIERS[tier];
    process.stdout.write(`  Deploying Tier ${tier} (${TIER_NAMES[tier]}, $${mult}) ... `);
    const matrix = await MatrixV3.deploy(
      usdcAddress,
      cnovaAddress,
      treasuryAddress,
      devWallet,
      opsWallet,
      communityAddress,
      adminWallet,
      USDC_UNIT,
      BigInt(mult),      // _feeMultiplier — scales all splits proportionally
      ACTIVE_WINDOW
    );
    await matrix.waitForDeployment();
    matrices[tier] = matrix;
    const addr = await matrix.getAddress();
    console.log(`✓  ${addr}`);
  }

  // ── 11. BeltManager + extra Tier-1 belts (V5 multi-belt) ────────────────────
  sep();
  console.log("  [11] Deploying BeltManager + 4 extra Tier-1 belts (V5)");
  const BeltMgr = await ethers.getContractFactory("BeltManager");
  const beltManager = await BeltMgr.deploy(usdcAddress, adminWallet, BELT_MAX);
  await beltManager.waitForDeployment();
  const beltManagerAddress = await beltManager.getAddress();
  log(`BeltManager : ${beltManagerAddress}`);

  // Deploy 4 extra Tier-1 belts (Belt A = matrices[1] already deployed)
  // Belt A = matrices[1], Belts B-E = extraBelts[0..3]
  const EXTRA_BELTS = 4;
  const extraBelts = [];
  for (let b = 0; b < EXTRA_BELTS; b++) {
    process.stdout.write(`  Deploying Belt ${String.fromCharCode(66 + b)} (Tier 1, $10) ... `);
    const belt = await MatrixV3.deploy(
      usdcAddress, cnovaAddress, treasuryAddress,
      devWallet, opsWallet, communityAddress,
      adminWallet, USDC_UNIT, 10n, ACTIVE_WINDOW
    );
    await belt.waitForDeployment();
    extraBelts.push(belt);
    console.log(`✓  ${await belt.getAddress()}`);
  }

  // Register all belts in BeltManager (A first, then B-E)
  await waitTx(
    await beltManager.addBelt(await matrices[1].getAddress()),
    "BeltManager.addBelt → Belt A (Tier 1 matrix)"
  );
  for (let b = 0; b < EXTRA_BELTS; b++) {
    const label = String.fromCharCode(66 + b);
    await waitTx(
      await beltManager.addBelt(await extraBelts[b].getAddress()),
      `BeltManager.addBelt → Belt ${label}`
    );
  }

  // ── 12. CryptoNovaTierManager ─────────────────────────────────────────────
  sep();
  console.log("  [12] Deploying CryptoNovaTierManager");
  const TierManager = await ethers.getContractFactory("CryptoNovaTierManager");
  const tierManager = await TierManager.deploy(
    usdcAddress,
    cnovaAddress,
    treasuryAddress,
    devWallet,
    opsWallet,
    communityAddress,
    adminWallet,
    USDC_UNIT
  );
  await tierManager.waitForDeployment();
  const tierManagerAddress = await tierManager.getAddress();
  log(`TierManager : ${tierManagerAddress}`);

  // ── Wiring ────────────────────────────────────────────────────────────────
  sep();
  console.log("  [12] Wiring roles and references");

  const MINTER_ROLE = await cnovaToken.MINTER_ROLE();
  const BURNER_ROLE = await cnovaToken.BURNER_ROLE();
  const EPOCH_ROLE  = await cnovaToken.EPOCH_ROLE();

  // Grant MINTER_ROLE to all 7 matrices and TierManager
  for (let tier = 1; tier <= 7; tier++) {
    const addr = await matrices[tier].getAddress();
    await waitTx(
      await cnovaToken.grantRole(MINTER_ROLE, addr),
      `MINTER_ROLE → Tier ${tier} matrix (${TIER_NAMES[tier]})`
    );
  }
  await waitTx(
    await cnovaToken.grantRole(MINTER_ROLE, tierManagerAddress),
    "MINTER_ROLE → TierManager"
  );

  // Grant BURNER_ROLE to Treasury
  await waitTx(
    await cnovaToken.grantRole(BURNER_ROLE, treasuryAddress),
    "BURNER_ROLE → Treasury"
  );

  // Grant MINTER_ROLE to extra belt contracts (B-E)
  for (let b = 0; b < extraBelts.length; b++) {
    const label = String.fromCharCode(66 + b);
    await waitTx(
      await cnovaToken.grantRole(MINTER_ROLE, await extraBelts[b].getAddress()),
      `MINTER_ROLE → Belt ${label}`
    );
  }

  // Grant EPOCH_ROLE to Tier-1 Belt A (drives epoch progression)
  await waitTx(
    await cnovaToken.grantRole(EPOCH_ROLE, await matrices[1].getAddress()),
    "EPOCH_ROLE → Belt A (Tier-1 matrix)"
  );

  // Register all 7 matrices in TierManager
  for (let tier = 1; tier <= 7; tier++) {
    const addr = await matrices[tier].getAddress();
    await waitTx(
      await tierManager.setMatrix(tier, addr),
      `TierManager.setMatrix(${tier}, ...)  [${TIER_NAMES[tier]}]`
    );
  }

  // Authorise registrars in CommunityWallet (all 7 matrices + TierManager)
  for (let tier = 1; tier <= 7; tier++) {
    const addr = await matrices[tier].getAddress();
    await waitTx(
      await communityWallet.setAuthorisedRegistrar(addr, true),
      `CommunityWallet.authorise Tier ${tier} matrix`
    );
  }
  await waitTx(
    await communityWallet.setAuthorisedRegistrar(tierManagerAddress, true),
    "CommunityWallet.authorise TierManager"
  );

  // Authorise TierManager to call registerFor() on tier 2–7 matrices
  // (Tier 1 members register directly via V3.register(); no registerFor needed)
  for (let tier = 2; tier <= 7; tier++) {
    await waitTx(
      await matrices[tier].setAuthorizedRegistrar(tierManagerAddress, true),
      `Matrix Tier ${tier}.setAuthorizedRegistrar → TierManager`
    );
  }

  // Authorise all 7 matrices to call Treasury.depositReserve()
  for (let tier = 1; tier <= 7; tier++) {
    const addr = await matrices[tier].getAddress();
    await waitTx(
      await treasury.setAuthorizedCaller(addr, true),
      `Treasury.setAuthorizedCaller → Tier ${tier} matrix (${TIER_NAMES[tier]})`
    );
  }
  // Authorise extra belt contracts (B-E) to call Treasury
  for (let b = 0; b < extraBelts.length; b++) {
    const label = String.fromCharCode(66 + b);
    await waitTx(
      await treasury.setAuthorizedCaller(await extraBelts[b].getAddress(), true),
      `Treasury.setAuthorizedCaller → Belt ${label}`
    );
  }

  // Authorise extra belts in CommunityWallet
  for (let b = 0; b < extraBelts.length; b++) {
    const label = String.fromCharCode(66 + b);
    await waitTx(
      await communityWallet.setAuthorisedRegistrar(await extraBelts[b].getAddress(), true),
      `CommunityWallet.authorise Belt ${label}`
    );
  }
  // Authorise BeltManager in CommunityWallet
  await waitTx(
    await communityWallet.setAuthorisedRegistrar(beltManagerAddress, true),
    "CommunityWallet.authorise BeltManager"
  );

  // Authorise BeltManager to call registerFor() on Belt A (Tier-1 matrix)
  await waitTx(
    await matrices[1].setAuthorizedRegistrar(beltManagerAddress, true),
    "Belt A.setAuthorizedRegistrar → BeltManager"
  );
  // Authorise BeltManager on all extra belts too
  for (let b = 0; b < extraBelts.length; b++) {
    const label = String.fromCharCode(66 + b);
    await waitTx(
      await extraBelts[b].setAuthorizedRegistrar(beltManagerAddress, true),
      `Belt ${label}.setAuthorizedRegistrar → BeltManager`
    );
  }

  // Set communityWallet on Treasury (needed for early exit penalty in redeemAtFloor)
  await waitTx(
    await treasury.setCommunityWallet(communityAddress),
    "Treasury.setCommunityWallet → CommunityWallet"
  );

  // Set BeltManager as tier1Matrix in Treasury (aggregates totalMembers across belts)
  await waitTx(
    await treasury.setTier1Matrix(beltManagerAddress),
    "Treasury.setTier1Matrix → BeltManager"
  );

  // Set BeltManager in TierManager for auto-sync
  await waitTx(
    await tierManager.setBeltManager(beltManagerAddress),
    "TierManager.setBeltManager → BeltManager"
  );

  // V5: Auto-upgrade — wire setTierManager + setAutoUpgradeCaller on all matrices and belts
  // All 7 tier matrices
  for (let tier = 1; tier <= 7; tier++) {
    await waitTx(
      await matrices[tier].setTierManager(tierManagerAddress),
      `Matrix Tier ${tier}.setTierManager → TierManager`
    );
    await waitTx(
      await tierManager.setAutoUpgradeCaller(await matrices[tier].getAddress(), true),
      `TierManager.setAutoUpgradeCaller → Tier ${tier} matrix`
    );
  }
  // Extra T1 belts (B-E)
  for (let b = 0; b < extraBelts.length; b++) {
    const label = String.fromCharCode(66 + b);
    await waitTx(
      await extraBelts[b].setTierManager(tierManagerAddress),
      `Belt ${label}.setTierManager → TierManager`
    );
    await waitTx(
      await tierManager.setAutoUpgradeCaller(await extraBelts[b].getAddress(), true),
      `TierManager.setAutoUpgradeCaller → Belt ${label}`
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  sep();
  console.log("  ✅  DEPLOY COMPLETE — Save these addresses!");
  sep();
  console.log(`  USDC                : ${usdcAddress}`);
  console.log(`  CNOVAToken          : ${cnovaAddress}`);
  console.log(`  CNOVATreasury       : ${treasuryAddress}`);
  console.log(`  CommunityWallet     : ${communityAddress}`);
  for (let tier = 1; tier <= 7; tier++) {
    const addr = await matrices[tier].getAddress();
    const fee  = TIER_FEE_MULTIPLIERS[tier];
    console.log(`  MatrixV3 Tier ${tier}    : ${addr}  ($${fee} — ${TIER_NAMES[tier]})`);
  }
  console.log(`  BeltManager         : ${beltManagerAddress}`);
  console.log(`  TierManager         : ${tierManagerAddress}`);
  // Extra belts
  for (let b = 0; b < extraBelts.length; b++) {
    const label = String.fromCharCode(66 + b);
    console.log(`  Belt ${label} (Tier 1 extra) : ${await extraBelts[b].getAddress()}`);
  }
  sep();

  // ── Deployment manifest ───────────────────────────────────────────────────
  const manifest = {
    network:    (await ethers.provider.getNetwork()).name,
    deployedAt: new Date().toISOString(),
    deployer:   deployer.address,
    contracts: {
      usdc:           usdcAddress,
      cnovaToken:     cnovaAddress,
      treasury:       treasuryAddress,
      communityWallet: communityAddress,
      tierManager:    tierManagerAddress,
      matrices: {},
    },
    wallets: {
      dev:   devWallet,
      ops:   opsWallet,
      admin: adminWallet,
    },
  };
  for (let tier = 1; tier <= 7; tier++) {
    manifest.contracts.matrices[`tier${tier}`] = {
      address:       await matrices[tier].getAddress(),
      name:          TIER_NAMES[tier],
      feeMultiplier: TIER_FEE_MULTIPLIERS[tier],
      feeUSDC:       TIER_FEES[tier].toString(),
    };
  }

  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });
  const filename = `tier_system_${Date.now()}.json`;
  fs.writeFileSync(path.join(outPath, filename), JSON.stringify(manifest, null, 2));
  log(`Manifest saved → deployments/${filename}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
