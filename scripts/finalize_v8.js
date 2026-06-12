"use strict";
/**
 * finalize_v8.js  --  Recovery script for timed-out deploy_v8.js
 *
 * All 13 contracts deployed successfully. The RPC timed out after
 * StabilityFund.setMatrixKeeper. This script completes the remaining steps:
 *   1. keeper.setPairManager for T1 + T2
 *   2. setMatrixKeeper on T1/T2 MatA + MatB
 *   3. Deploy V8Governance
 *   4. Grant MINTER_ROLE to all matrices (CRITICAL -- without this, cycle-out reverts)
 *   5. Grant GOVERNOR_ROLE to V8Governance
 *   6. Write deployed_addresses_v8_4.json
 *
 * Run: npx hardhat run scripts/finalize_v8.js --network baseSepolia
 */

const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

// ── Known addresses from the deploy output ───────────────────────────────────
const ADDRS = {
  usdc:          "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a",
  cnova:         "0x497FD670cd6Cf1680CD02862f48CDABc5Dbb76AA",
  treasury:      "0x88b924046677E9E6F76D10235A43bDCcD7cB67C5",
  stabilityFund: "0x912b5F535b01e3d9C0BFF5328D87a3011652baB0",
  tierRouter:    "0x9220F372113A91b3429aba43A2620047155183f8",
  matrixFactory: "0xC9bcD131B16dA0F5884D0D278EC798f6Eb4F3e7c",
  matrixKeeper:  "0x519A9e2CdAa9ad25F2d3a32bCDe7e0f4967053de",
  deployer:      "0xCd0Af6a4116f2062c1594aDf34c1821D45175506",
  admin:         "0xCd0Af6a4116f2062c1594aDf34c1821D45175506",
  accountOne:    "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435",
  devOps:        "0x7fc2158892F14b9A1fB6e39B788d4d08daF49C0a",
  tiers: {
    T1: {
      pm:   "0xDbB808C4749e47eC566fC461c56FB4b73524310B",
      matA: "0x278866dB90ef2B8D251447BdeCaAe3287Eb274E2",
      matB: "0x099db973B19964C3D787bb1c5587030354FF076c",
    },
    T2: {
      pm:   "0xE3A689aa159d3C2A63e1350F13b6d2a350712425",
      matA: "0x29A1577819A66E9f6a633D6FB315e9887E05c2F1",
      matB: "0x0D52D79B528245a3C187e1ed964Ef3f1D8725F8e",
    },
  },
};

const OUTPUT_FILE = path.join(__dirname, "deployed_addresses_v8_4.json");

async function main() {
  const [rawSigner]  = await ethers.getSigners();
  const deployer     = new NonceManager(rawSigner);
  const deployerAddr = rawSigner.address;
  console.log(`Deployer: ${deployerAddr}\n`);

  // ── Contract handles ───────────────────────────────────────────────────────
  const keeper = await ethers.getContractAt("MatrixKeeper",          ADDRS.matrixKeeper,  deployer);
  const cnova  = await ethers.getContractAt("CNOVAToken",            ADDRS.cnova,         deployer);
  const tiers  = [
    { num: 1, ...ADDRS.tiers.T1 },
    { num: 2, ...ADDRS.tiers.T2 },
  ];

  // ── Step 1: Register PairManagers with MatrixKeeper ───────────────────────
  console.log("── Step 1: keeper.setPairManager ────────────────────────────");
  for (const t of tiers) {
    try {
      await (await keeper.setPairManager(t.num - 1, t.pm)).wait();
      console.log(`  ✓  T${t.num} PairManager registered with keeper`);
    } catch (e) {
      console.log(`  ℹ  T${t.num} setPairManager: ${e.message.slice(0, 80)} (may already be set)`);
    }
  }

  // ── Step 2: Set MatrixKeeper on all matrices ───────────────────────────────
  console.log("\n── Step 2: matrices.setMatrixKeeper ─────────────────────────");
  for (const t of tiers) {
    for (const [label, addr] of [["MatA", t.matA], ["MatB", t.matB]]) {
      try {
        const mat = await ethers.getContractAt("FigureEightMatrixV8", addr, deployer);
        await (await mat.setMatrixKeeper(ADDRS.matrixKeeper)).wait();
        console.log(`  ✓  T${t.num} ${label} setMatrixKeeper OK`);
      } catch (e) {
        console.log(`  ℹ  T${t.num} ${label}: ${e.message.slice(0, 80)} (may already be set)`);
      }
    }
  }

  // ── Step 3: Deploy V8Governance ───────────────────────────────────────────
  console.log("\n── Step 3: Deploy V8Governance ──────────────────────────────");
  const V8Gov   = await ethers.getContractFactory("V8Governance", deployer);
  const gov     = await V8Gov.deploy(ADDRS.cnova, ADDRS.tierRouter, ADDRS.matrixKeeper);
  await gov.waitForDeployment();
  const govAddr = await gov.getAddress();
  console.log(`  ✓  V8Governance deployed: ${govAddr}`);

  // ── Step 4: Grant MINTER_ROLE to all matrices ─────────────────────────────
  console.log("\n── Step 4: CNOVA MINTER_ROLE grants ─────────────────────────");
  const MINTER_ROLE = await cnova.MINTER_ROLE();
  for (const t of tiers) {
    for (const [label, addr] of [["MatA", t.matA], ["MatB", t.matB]]) {
      try {
        const already = await cnova.hasRole(MINTER_ROLE, addr);
        if (already) {
          console.log(`  ✓  T${t.num} ${label} already has MINTER_ROLE`);
        } else {
          await (await cnova.grantRole(MINTER_ROLE, addr)).wait();
          console.log(`  ✓  MINTER_ROLE granted to T${t.num} ${label}`);
        }
      } catch (e) {
        console.error(`  ✗  T${t.num} ${label} MINTER_ROLE: ${e.message.slice(0, 80)}`);
      }
    }
  }

  // ── Step 5: Grant GOVERNOR_ROLE to V8Governance ───────────────────────────
  console.log("\n── Step 5: CNOVA GOVERNOR_ROLE grant ────────────────────────");
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();
  try {
    await (await cnova.grantRole(GOVERNOR_ROLE, govAddr)).wait();
    console.log(`  ✓  GOVERNOR_ROLE granted to V8Governance`);
  } catch (e) {
    console.log(`  ℹ  GOVERNOR_ROLE: ${e.message.slice(0, 80)}`);
  }

  // ── Step 6: Write addresses JSON ──────────────────────────────────────────
  console.log("\n── Step 6: Save addresses ────────────────────────────────────");
  const out = {
    network:       "baseSepolia",
    deployedAt:    new Date().toISOString(),
    matrixSize:    64,
    deployer:      ADDRS.deployer,
    admin:         ADDRS.admin,
    accountOne:    ADDRS.accountOne,
    devOps:        ADDRS.devOps,
    usdc:          ADDRS.usdc,
    cnova:         ADDRS.cnova,
    treasury:      ADDRS.treasury,
    stabilityFund: ADDRS.stabilityFund,
    tierRouter:    ADDRS.tierRouter,
    matrixFactory: ADDRS.matrixFactory,
    matrixKeeper:  ADDRS.matrixKeeper,
    v8Governance:  govAddr,
    tiers: {
      T1: ADDRS.tiers.T1,
      T2: ADDRS.tiers.T2,
    },
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`  ✓  Addresses saved → deployed_addresses_v8_4.json`);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  ✅  Finalization complete — ready to seed W1");
  console.log("══════════════════════════════════════════════════════════════\n");
  console.log("Next steps:");
  console.log("  1. npx hardhat run scripts/seed_w1.js --network baseSepolia");
  console.log("  2. Register 2-3 wallets manually via frontend");
  console.log("  3. $env:COUNT=\"300\"; $env:HDR_OFFSET=\"1500\"; npx hardhat run scripts/bigfill_v8.js --network baseSepolia");
}

main().catch(e => { console.error("\n✗  Finalize failed:", e.message); process.exit(1); });
