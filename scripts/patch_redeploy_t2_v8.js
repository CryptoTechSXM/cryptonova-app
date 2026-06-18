"use strict";
/**
 * patch_redeploy_t2_v8.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Root cause: FigureEightMatrixV8.ENTRY_FEE is immutable.  The original T2
 * matrices were deployed with ENTRY_FEE = $25.  patch_t2_fee_v8.js deployed
 * a new PairManager with $15 entryFee and updated TierRouter.tierEntryFees[1]
 * to $15 — but the matrices themselves still have ENTRY_FEE = $25.
 *
 * When handleCycleOut fires and TierRouter approves the T2 PM for $15, the PM
 * transfers $15 to T2 MatA.  _distributePayments then calculates BPS splits
 * based on ENTRY_FEE ($25) and tries to push out $25 worth of USDC — but only
 * $15 is present → arithmetic shortfall → revert → root stays parked, T2
 * occupancy stays at 0.
 *
 * This script:
 *   1. Deploys new T2 MatA + MatB with ENTRY_FEE = $15
 *   2. Deploys new T2 PairManagerV8 with entryFee = $15
 *   3. Full wiring: partners, tierRouter, pairManager, stabilityFund, chainNext
 *   4. addPair + setTierRouter on new PM
 *   5. TierRouter: registerTier(1) + setTierMatrices(1) + registerMatrix × 2
 *   6. Treasury: setAuthorizedCaller for both new matrices
 *   7. MatrixFactory: configureTier(1) + registerPair(1)
 *   8. Deregisters old T2 matrices from TierRouter
 *   9. Patches deployed_addresses_v8_1.json
 *
 * Run:
 *   npx hardhat run scripts/patch_redeploy_t2_v8.js --network baseSepolia
 */
const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses_v8_1.json");
const NEW_T2_FEE     = 15_000_000n;   // $15 USDC (6 dec)
const MATRIX_SIZE    = 15n;

// V8.1 BPS splits — T2 uses SPLITS_T1_T3 (same as T1)
// Field order matches Solidity SplitConfig struct:
//   l1Bps, l2Bps, l3Bps, chainBps, poolBps, treasuryBps, devOpsBps, stabilityBps
const SPLITS_T2 = [2500, 300, 200, 2000, 3800, 500, 500, 200]; // sum=10000
const CHAIN_PAY_T2 = [1000, 400, 300, 150, 75, 75];             // sum=2000 = chainBps

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [rawSigner]  = await ethers.getSigners();
  const deployer     = new NonceManager(rawSigner);
  const deployerAddr = rawSigner.address;
  console.log(`Deployer:   ${deployerAddr}`);
  console.log(`New T2 fee: $${Number(NEW_T2_FEE) / 1e6}`);

  // ── Resolved addresses ─────────────────────────────────────────────────────
  const usdcAddr     = addrs.usdc;
  const cnovaAddr    = addrs.cnova;
  const treasuryAddr = addrs.treasury;
  const sfAddr       = addrs.stabilityFund;
  const devOps       = addrs.devOps;
  const accountOne   = addrs.accountOne;
  const trAddr       = addrs.tierRouter;
  const factoryAddr  = addrs.matrixFactory;

  const oldT2MatA = addrs.tiers.T2.matA;
  const oldT2MatB = addrs.tiers.T2.matB;
  const oldT2Pm   = addrs.tiers.T2.pm;

  console.log(`\nOld T2 MatA: ${oldT2MatA}`);
  console.log(`Old T2 MatB: ${oldT2MatB}`);
  console.log(`Old T2 PM:   ${oldT2Pm}`);

  // ── Contract handles ───────────────────────────────────────────────────────
  const tierRouter   = await ethers.getContractAt("TierRouter",      trAddr,       deployer);
  const treasury     = await ethers.getContractAt("CNOVATreasury",   treasuryAddr, deployer);
  const matFactory   = await ethers.getContractAt("MatrixFactory",   factoryAddr,  deployer);

  const F8V8 = await ethers.getContractFactory("FigureEightMatrixV8", deployer);
  const PMV8 = await ethers.getContractFactory("PairManagerV8",       deployer);

  // DeployParams struct (mirrors Solidity struct field order)
  const dpStruct = {
    usdc:         usdcAddr,
    cnova:        cnovaAddr,
    treasury:     treasuryAddr,
    devOpsWallet: devOps,
    accountOne:   accountOne,
    admin:        deployerAddr,
  };

  // ── 1. Deploy new T2 PairManagerV8 ($15) ───────────────────────────────────
  console.log("\n── 1. Deploy new T2 PairManagerV8 ($15)");
  const newPm = await PMV8.deploy(usdcAddr, NEW_T2_FEE, deployerAddr);
  await newPm.waitForDeployment();
  const newPmAddr = await newPm.getAddress();
  console.log(`  ✓ New T2 PM: ${newPmAddr}`);

  // ── 2. Deploy new T2 MatA with ENTRY_FEE = $15 ────────────────────────────
  console.log("\n── 2. Deploy new T2 MatA (ENTRY_FEE=$15, isMatrixA=true, tierIndex=1)");
  const newMatA = await F8V8.deploy(
    dpStruct,
    NEW_T2_FEE,
    MATRIX_SIZE,
    true,   // isMatrixA
    1,      // tierIndex (0-based: T2 = index 1)
    SPLITS_T2,
    CHAIN_PAY_T2
  );
  await newMatA.waitForDeployment();
  const newMatAAddr = await newMatA.getAddress();
  console.log(`  ✓ New T2 MatA: ${newMatAAddr}`);

  // ── 3. Deploy new T2 MatB with ENTRY_FEE = $15 ────────────────────────────
  console.log("\n── 3. Deploy new T2 MatB (ENTRY_FEE=$15, isMatrixA=false, tierIndex=1)");
  const newMatB = await F8V8.deploy(
    dpStruct,
    NEW_T2_FEE,
    MATRIX_SIZE,
    false,  // isMatrixA
    1,      // tierIndex
    SPLITS_T2,
    CHAIN_PAY_T2
  );
  await newMatB.waitForDeployment();
  const newMatBAddr = await newMatB.getAddress();
  console.log(`  ✓ New T2 MatB: ${newMatBAddr}`);

  // ── 4. Wire matrices ───────────────────────────────────────────────────────
  console.log("\n── 4. Wire new T2 matrices");

  // Partner links
  await (await newMatA.setPartner(newMatBAddr)).wait();
  await (await newMatB.setPartner(newMatAAddr)).wait();
  console.log(`  ✓ setPartner: MatA↔MatB`);

  // TierRouter
  await (await newMatA.setTierRouter(trAddr)).wait();
  await (await newMatB.setTierRouter(trAddr)).wait();
  console.log(`  ✓ setTierRouter on both`);

  // PairManager
  await (await newMatA.setPairManager(newPmAddr)).wait();
  await (await newMatB.setPairManager(newPmAddr)).wait();
  console.log(`  ✓ setPairManager on both`);

  // StabilityFund (stabilityBps=200 in SPLITS_T2 — must be wired)
  await (await newMatA.setStabilityFund(sfAddr)).wait();
  await (await newMatB.setStabilityFund(sfAddr)).wait();
  console.log(`  ✓ setStabilityFund on both`);

  // ChainNext — figure-8 loop: MatA → MatB → MatA
  await (await newMatA.setChainNext(newMatBAddr)).wait();
  await (await newMatB.setChainNext(newMatAAddr)).wait();
  console.log(`  ✓ setChainNext: MatA→MatB→MatA`);

  // ── 5. Wire new PM ─────────────────────────────────────────────────────────
  console.log("\n── 5. Wire new T2 PairManagerV8");
  await (await newPm.setTierRouter(trAddr)).wait();
  console.log(`  ✓ newPm.setTierRouter`);
  await (await newPm.addPair(newMatAAddr, newMatBAddr)).wait();
  console.log(`  ✓ newPm.addPair(newMatA, newMatB)`);

  // ── 6. TierRouter: register new PM + update matrix pointers ───────────────
  console.log("\n── 6. TierRouter wiring");
  await (await tierRouter.registerTier(1, newPmAddr, NEW_T2_FEE)).wait();
  console.log(`  ✓ registerTier(1, newPm, $15)`);
  await (await tierRouter.setTierMatrices(1, newMatAAddr, newMatBAddr)).wait();
  console.log(`  ✓ setTierMatrices(1, newMatA, newMatB)`);
  await (await tierRouter.registerMatrix(newMatAAddr, 1)).wait();
  await (await tierRouter.registerMatrix(newMatBAddr, 1)).wait();
  console.log(`  ✓ registerMatrix: newMatA + newMatB authorized`);

  // Deregister old matrices (prevents stale handleCycleOut from old contracts)
  await (await tierRouter.deregisterMatrix(oldT2MatA)).wait();
  await (await tierRouter.deregisterMatrix(oldT2MatB)).wait();
  console.log(`  ✓ deregisterMatrix: old T2 MatA + MatB removed`);

  // ── 7. Treasury: authorize new matrices ───────────────────────────────────
  console.log("\n── 7. CNOVATreasury authorization");
  await (await treasury.setAuthorizedCaller(newMatAAddr, true)).wait();
  await (await treasury.setAuthorizedCaller(newMatBAddr, true)).wait();
  console.log(`  ✓ setAuthorizedCaller: newMatA + newMatB`);

  // ── 8. MatrixFactory: update tier record ──────────────────────────────────
  console.log("\n── 8. MatrixFactory update");
  try {
    await (await matFactory.configureTier(1, newPmAddr, MATRIX_SIZE)).wait();
    console.log(`  ✓ configureTier(1, newPm, ${MATRIX_SIZE})`);
    await (await matFactory.registerPair(1, newMatAAddr, newMatBAddr)).wait();
    console.log(`  ✓ registerPair(1, newMatA, newMatB)`);
  } catch (e) {
    console.log(`  ⚠ MatrixFactory update skipped: ${e.reason || e.message?.slice(0,80)}`);
    console.log(`    (factory records are informational only — TierRouter is source of truth)`);
  }

  // ── 9. Verify on-chain ─────────────────────────────────────────────────────
  console.log("\n── 9. Verify");
  const pmCheck  = await tierRouter.tierPairManagers(1);
  const feeCheck = await tierRouter.tierEntryFees(1);
  const matACheck = await tierRouter.tierMatrixAAddr(1);
  const matBCheck = await tierRouter.tierMatrixBAddr(1);
  const authA    = await tierRouter.authorizedMatrices(newMatAAddr);
  const authB    = await tierRouter.authorizedMatrices(newMatBAddr);
  const oldAuthA = await tierRouter.authorizedMatrices(oldT2MatA);
  const feeOnMatA = await newMatA.ENTRY_FEE();

  console.log(`  TierRouter T2 PM:     ${pmCheck}`);
  console.log(`  TierRouter T2 fee:    $${Number(feeCheck)/1e6}`);
  console.log(`  TierRouter T2 MatA:   ${matACheck}`);
  console.log(`  TierRouter T2 MatB:   ${matBCheck}`);
  console.log(`  newMatA authorized:   ${authA}`);
  console.log(`  newMatB authorized:   ${authB}`);
  console.log(`  oldMatA deregistered: ${!oldAuthA}`);
  console.log(`  newMatA ENTRY_FEE:    $${Number(feeOnMatA)/1e6}`);

  const ok = pmCheck.toLowerCase()  === newPmAddr.toLowerCase()
          && matACheck.toLowerCase() === newMatAAddr.toLowerCase()
          && matBCheck.toLowerCase() === newMatBAddr.toLowerCase()
          && authA && authB && !oldAuthA
          && feeCheck === NEW_T2_FEE
          && feeOnMatA === NEW_T2_FEE;

  if (!ok) throw new Error("Verification failed — aborting JSON update. Check logs above.");

  // ── 10. Patch addresses JSON ────────────────────────────────────────────────
  addrs.tiers.T2.pm   = newPmAddr;
  addrs.tiers.T2.matA = newMatAAddr;
  addrs.tiers.T2.matB = newMatBAddr;
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addrs, null, 2));
  console.log(`\n  ✓ deployed_addresses_v8_1.json updated`);

  console.log(`
  ════════════════════════════════════════════════════════════
  ✅  T2 redeploy complete.

  New T2 PM:   ${newPmAddr}
  New T2 MatA: ${newMatAAddr}
  New T2 MatB: ${newMatBAddr}

  ENTRY_FEE on both matrices is now $15 (was $25 — immutable).
  The 41 parked wallets are still valid — forceCross will push
  them into T1 MatB.  The NEXT root to cycle out of T1 MatA
  will successfully auto-upgrade to T2.

  Next: re-seed W1 and re-run bigfill:
    $env:SEED_W1_KEY="<key>"; $env:COUNT="35"; $env:HDR_OFFSET="2500"; npx hardhat run scripts/bigfill_v8.js --network baseSepolia
  ════════════════════════════════════════════════════════════
`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
