"use strict";
/**
 * deploy_figure8_test.js — V7 Full Test Deploy
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys the complete V7 CryptoNova stack:
 *   MockUSDC (testnet) · CNOVAToken · CNOVATreasury
 *   FigureEightMatrix A ↔ B · CNOVAGovernance
 *
 * Uses 15-member (4-level) matrices for fast self-testing.
 * Mainnet deploy uses 127-member (7-level) matrices.
 *
 * Saves all deployed addresses to deployed_addresses.json so other
 * scripts (quickfill, check_state, forcecross) pick them up automatically.
 *
 * Run: npx hardhat run scripts/deploy_figure8_test.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const EXISTING_USDC = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const FEE           = 10_000_000n;   // $10 USDC (6-decimal)

// MATRIX_SIZE: 15  = 4-level  (fast local test)
//              31  = 5-level  (LAUNCH size — ~1000 regs/loop, good at 50+/day)
//              127 = 7-level  (mainnet scale — needs 500+/day)
const MATRIX_SIZE   = BigInt(process.env.MATRIX_SIZE || "31");
const IS_LAUNCH     = MATRIX_SIZE === 31n;
const IS_MAINNET    = MATRIX_SIZE === 127n;
const MODE = IS_MAINNET ? "127-MEMBER MAINNET" : IS_LAUNCH ? "31-MEMBER LAUNCH" : "15-MEMBER TEST";
const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");

function sep(label = "") {
  const line = "─".repeat(62);
  console.log(label ? `\n  ${label}\n  ${line}` : `  ${line}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const devWallet      = process.env.DEV_WALLET_ADDRESS      || deployer.address;
  const opsWallet      = process.env.OPS_WALLET_ADDRESS      || deployer.address;
  const protocolWallet = process.env.PROTOCOL_WALLET_ADDRESS || devWallet;
  const adminWallet    = process.env.ADMIN_WALLET_ADDRESS    || deployer.address;

  // Account #1 — derives address from W1_PRIVATE_KEY so testnet/mainnet rotation
  // is just a key swap in .env with no contract code change needed.
  if (!process.env.W1_PRIVATE_KEY) {
    console.error("  ❌  W1_PRIVATE_KEY missing from .env — required for Account #1");
    process.exit(1);
  }
  const w1Wallet   = new ethers.Wallet(process.env.W1_PRIVATE_KEY);
  const accountOne = w1Wallet.address;

  sep(`V7 CRYPTONOVA — ${MODE} DEPLOY`);
  console.log(`  Deployer:         ${deployer.address}`);
  console.log(`  Account #1 (W1):  ${accountOne}`);
  console.log(`  Dev wallet:       ${devWallet}`);
  console.log(`  Ops wallet:       ${opsWallet}`);
  console.log(`  Protocol wallet:  ${protocolWallet}${protocolWallet === devWallet ? "  (shared with dev)" : ""}`);
  console.log(`  Admin wallet:     ${adminWallet}`);
  console.log(`  Matrix size:  ${MATRIX_SIZE} members (${IS_MAINNET ? "7-level mainnet" : IS_LAUNCH ? "5-level launch" : "4-level test"})`);
  // For chain simulation test: deploy TWO pairs so chain A→B→C→D→A is validated
  const DEPLOY_TWO_PAIRS = process.env.DEPLOY_TWO_PAIRS === 'true';
  console.log(`  Entry fee:    $10`);
  sep();

  // ── 1. Core token contracts ───────────────────────────────────────────────
  sep("1 / 5  Core token contracts");

  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnova = await CNOVAToken.deploy(adminWallet);
  await cnova.waitForDeployment();
  console.log(`  CNOVAToken:    ${await cnova.getAddress()}`);

  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await CNOVATreasury.deploy(
    await cnova.getAddress(),
    EXISTING_USDC,
    adminWallet
  );
  await treasury.waitForDeployment();
  console.log(`  CNOVATreasury: ${await treasury.getAddress()}`);

  // Wire treasury reference into CNOVA (enables Final Frontier floor formula)
  await (await cnova.setTreasuryRef(await treasury.getAddress())).wait();
  console.log(`  ✓ CNOVAToken.treasuryRef set`);

  // Epoch member limit:
  //   4   → 31-member launch: 9 epochs × ~3-4 = visible in one A fill
  //   30  → 127-member mainnet: 9 epochs across full fill
  //   5   → 15-member test: lightning
  const epochLimit = IS_MAINNET ? 30 : IS_LAUNCH ? 4 : 5;
  const epochDesc  = IS_MAINNET ? "mainnet" : IS_LAUNCH ? "launch — 9 epochs in 31 members" : "test — lightning";
  await (await cnova.setEpochMemberLimit(epochLimit)).wait();
  console.log(`  ✓ epochMemberLimit: ${epochLimit}  (${epochDesc})`);

  // ── 2. Figure-8 matrices ──────────────────────────────────────────────────
  sep("2 / 5  Figure-8 matrix pair");

  const F8 = await ethers.getContractFactory("FigureEightMatrix");

  // V7 constructor: usdc, cnova, treasury, dev, ops, founder, protocol, accountOne, admin, fee, size, isA
  const matA = await F8.deploy(
    EXISTING_USDC,
    await cnova.getAddress(),
    await treasury.getAddress(),
    devWallet,           // devWallet      (2%)
    opsWallet,           // opsWallet      (2%)
    ethers.ZeroAddress,  // founderWallet  — set later via setFounderWallet()
    protocolWallet,      // protocolWallet (1%)
    accountOne,          // accountOne     — gets 20% of orphan fees
    adminWallet,
    FEE,
    MATRIX_SIZE,
    true                 // isMatrixA = true
  );
  await matA.waitForDeployment();
  console.log(`  Matrix A:      ${await matA.getAddress()}  (isMatrixA: true)`);

  const matB = await F8.deploy(
    EXISTING_USDC,
    await cnova.getAddress(),
    await treasury.getAddress(),
    devWallet,
    opsWallet,
    ethers.ZeroAddress,
    protocolWallet,
    accountOne,          // accountOne — same across both matrices
    adminWallet,
    FEE,
    MATRIX_SIZE,
    false                // isMatrixA = false
  );
  await matB.waitForDeployment();
  console.log(`  Matrix B:      ${await matB.getAddress()}  (isMatrixA: false)`);

  // Capture addresses early — used by PairManager section below
  const matAAddr = await matA.getAddress();
  const matBAddr = await matB.getAddress();

  // Link the figure-8 pair
  await (await matA.setPartner(matBAddr)).wait();
  await (await matB.setPartner(matAAddr)).wait();
  console.log(`  ✓ Matrix A ↔ Matrix B linked`);

  // ── 3. PairManager ────────────────────────────────────────────────────────
  sep("3 / 5  PairManager");

  const PairManager = await ethers.getContractFactory("PairManager");
  const pairManager = await PairManager.deploy(EXISTING_USDC, FEE, adminWallet);
  await pairManager.waitForDeployment();
  console.log(`  PairManager:   ${await pairManager.getAddress()}`);

  // Wire PairManager into both matrices FIRST — required before addPair,
  // because addPair calls setChainNext/setChainAuthorized on the matrices,
  // which check: msg.sender == owner() || msg.sender == pairManager
  const pmAddr = await pairManager.getAddress();
  await (await matA.setPairManager(pmAddr)).wait();
  await (await matB.setPairManager(pmAddr)).wait();
  console.log(`  ✓ PairManager authorized on Matrix A and Matrix B`);

  // NOW register Pair 1 (A↔B) — PairManager is recognized by both matrices
  await (await pairManager.addPair(matAAddr, matBAddr)).wait();
  console.log(`  ✓ Pair 1 (A↔B) registered with PairManager`);

  // Expansion threshold:
  //   70% for 31-member launch  (62 × 0.70 = ~43 combined → next pair activates)
  //   80% for 127-member mainnet
  //   60% for 15-member test    (quick trigger for local testing)
  const threshold     = IS_MAINNET ? 8000 : IS_LAUNCH ? 7000 : 6000;
  const thresholdDesc = IS_MAINNET ? "mainnet — 80%" : IS_LAUNCH ? "launch — 70%" : "test — 60%";
  await (await pairManager.setExpandThreshold(threshold)).wait();
  console.log(`  ✓ Expansion threshold: ${threshold/100}%  (${thresholdDesc})`);

  // ── 3b. Pre-deploy Pair 2 for chain test (DEPLOY_TWO_PAIRS=true) ──────────
  if (DEPLOY_TWO_PAIRS) {
    sep("3b / 5  Pair 2 (C↔D) — pre-deploy chain");
    const matC = await F8.deploy(
      EXISTING_USDC, await cnova.getAddress(), await treasury.getAddress(),
      devWallet, opsWallet, ethers.ZeroAddress, protocolWallet,
      accountOne, adminWallet, FEE, MATRIX_SIZE, true
    );
    await matC.waitForDeployment();
    const matD = await F8.deploy(
      EXISTING_USDC, await cnova.getAddress(), await treasury.getAddress(),
      devWallet, opsWallet, ethers.ZeroAddress, protocolWallet,
      accountOne, adminWallet, FEE, MATRIX_SIZE, false
    );
    await matD.waitForDeployment();
    const matCAddr = await matC.getAddress();
    const matDAddr = await matD.getAddress();
    await (await matC.setPartner(matDAddr)).wait();
    await (await matD.setPartner(matCAddr)).wait();
    await (await matC.setPairManager(await pairManager.getAddress())).wait();
    await (await matD.setPairManager(await pairManager.getAddress())).wait();
    // addPair wires the chain: B.chainNext=C, D.chainNext=A, authorizations
    await (await pairManager.addPair(matCAddr, matDAddr)).wait();
    console.log(`  Matrix C:      ${matCAddr}  (chainNext for B)`);
    console.log(`  Matrix D:      ${matDAddr}  (chainNext = Matrix A)`);
    console.log(`  ✓ Chain wired: A→B→C→D→A (full circle)`);
    // Save to addresses
    const addrsNow = JSON.parse(fs.readFileSync(ADDRESSES_FILE, 'utf8'));
    addrsNow.MatrixC = matCAddr;
    addrsNow.MatrixD = matDAddr;
    fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addrsNow, null, 2));
  }

  // ── 4. Governance + roles ─────────────────────────────────────────────────
  sep("4 / 5  Governance + roles");

  const CNOVAGovernance = await ethers.getContractFactory("CNOVAGovernance");
  const governance = await CNOVAGovernance.deploy(
    await cnova.getAddress(),
    await treasury.getAddress(),
    adminWallet
  );
  await governance.waitForDeployment();
  console.log(`  CNOVAGovernance: ${await governance.getAddress()}`);

  // Reduce voting period for testnet convenience (1 day instead of 7)
  await (await governance.setVotingPeriod(1 * 24 * 3600)).wait();
  await (await governance.setExecutionDelay(1 * 3600)).wait();   // 1 hour delay on testnet
  console.log(`  ✓ Testnet params: votingPeriod=1d  executionDelay=1h`);

  // ── 4. Role wiring ────────────────────────────────────────────────────────
  sep("4 / 5  Role wiring");

  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const BURNER_ROLE   = await cnova.BURNER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  // matAAddr and matBAddr already defined above (section 2)
  const govAddr  = await governance.getAddress();
  const treAddr  = await treasury.getAddress();

  // Matrix contracts mint CNOVA on every entry
  await (await cnova.grantRole(MINTER_ROLE, matAAddr)).wait();
  await (await cnova.grantRole(MINTER_ROLE, matBAddr)).wait();
  console.log(`  ✓ MINTER_ROLE  → Matrix A, Matrix B`);

  // Treasury burns CNOVA on floor redemptions
  await (await cnova.grantRole(BURNER_ROLE, treAddr)).wait();
  console.log(`  ✓ BURNER_ROLE  → Treasury`);

  // Governance burns CNOVA from voters (no separate approve needed)
  await (await cnova.grantRole(BURNER_ROLE, govAddr)).wait();
  console.log(`  ✓ BURNER_ROLE  → Governance`);

  // Governance can update rewardPct after a successful vote
  await (await cnova.grantRole(GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ✓ GOVERNOR_ROLE → Governance`);

  // Treasury: authorize matrices to call depositReserve()
  await (await treasury.setAuthorizedCaller(matAAddr, true)).wait();
  await (await treasury.setAuthorizedCaller(matBAddr, true)).wait();
  console.log(`  ✓ Treasury authorized callers: Matrix A, Matrix B`);

  // Treasury: set tier-1 matrix reference (initial — for fallback)
  await (await treasury.setTier1Matrix(matAAddr)).wait();
  console.log(`  ✓ Treasury.tier1Matrix = Matrix A (initial)`);

  // Treasury: update to PairManager as member tracker (aggregates across all pairs)
  // Universe Mode activates when PairManager.totalRegistrations() >= 500
  // Anyone can call setFreeMode() once threshold is reached — no admin needed
  await (await treasury.setMemberTracker(await pairManager.getAddress())).wait();
  console.log(`  ✓ Treasury.memberTracker = PairManager (counts all pairs)`);

  // ── 5. Save all addresses ─────────────────────────────────────────────────
  sep("5 / 5  Saving addresses");

  const deployBlock = await ethers.provider.getBlockNumber();

  const addresses = {
    network:          "baseSepolia",
    deployedAt:       new Date().toISOString(),
    deployedAtBlock:  deployBlock,
    matrixSize:       Number(MATRIX_SIZE),
    entryFee:         "$10",

    // Account #1 — derived from W1_PRIVATE_KEY. Rotate key in .env for mainnet.
    AccountOne:      accountOne,

    // Token layer
    USDC:            EXISTING_USDC,
    CNOVAToken:      await cnova.getAddress(),
    CNOVATreasury:   await treasury.getAddress(),

    // Matrix layer — Pair 1
    MatrixA:         matAAddr,
    MatrixB:         matBAddr,

    // Routing layer
    PairManager:     await pairManager.getAddress(),

    // Governance layer
    CNOVAGovernance: govAddr,

    // Wallets used
    devWallet,
    opsWallet,
    adminWallet,
  };

  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addresses, null, 2));
  console.log(`  ✓ Addresses saved → ${ADDRESSES_FILE}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  sep("DEPLOY COMPLETE");
  console.log(`  USDC:            ${addresses.USDC}`);
  console.log(`  CNOVAToken:      ${addresses.CNOVAToken}`);
  console.log(`  CNOVATreasury:   ${addresses.CNOVATreasury}`);
  console.log(`  Matrix A:        ${addresses.MatrixA}`);
  console.log(`  Matrix B:        ${addresses.MatrixB}`);
  console.log(`  PairManager:     ${addresses.PairManager}`);
  console.log(`  CNOVAGovernance: ${addresses.CNOVAGovernance}`);
  sep();
  console.log("  V7 PAYMENT SPLITS (per $10 entry):");
  console.log("    L1 Referrer    15%  $1.50");
  console.log("    L2 Override     3%  $0.30");
  console.log("    L3 Override     2%  $0.20");
  console.log("    Chain Pay      40%  $4.00   (7 BFS levels)");
  console.log("    Treasury       10%  $1.00   UNTOUCHABLE");
  console.log("    Secondary Spon  5%  $0.50   follow-the-leader → root escrow");
  console.log("    Escrow         15%  $1.50   Follow Me Crossing Fund");
  console.log("    Founders        5%  $0.50");
  console.log("    Dev             2%  $0.20");
  console.log("    Ops             2%  $0.20");
  console.log("    Protocol        1%  $0.10");
  sep();
  console.log("  GOVERNANCE:");
  console.log(`    rewardPct:      25% default (governable 10-75%)`);
  console.log(`    votingPeriod:   1 day (testnet)`);
  console.log(`    executionDelay: 1 hour (testnet)`);
  console.log(`    minCreateBurn:  5 CNOVA`);
  console.log(`    minQuorumBurn:  50 CNOVA`);
  sep();
  console.log("  NEXT STEPS:");
  console.log("    1. npx hardhat run scripts/quickfill_f8.js --network baseSepolia");
  console.log("       (register wallet #1 first, then run quickfill)");
  console.log("    2. npx hardhat run scripts/check_f8_state.js --network baseSepolia");
  console.log("       (verify escrow accumulation + crossing)");
  sep();
}

main().catch(e => { console.error(e); process.exit(1); });
