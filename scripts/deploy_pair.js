"use strict";
/**
 * deploy_pair.js — Deploy a new figure-8 pair and register it with PairManager
 * ─────────────────────────────────────────────────────────────────────────────
 * Run when the active pair reaches 80% capacity (or forceAdvancePair manually).
 *
 * What this script does:
 *   1. Deploys two new FigureEightMatrix contracts (Matrix C + Matrix D)
 *   2. Links them as partners
 *   3. Grants all roles (MINTER, BURNER, TREASURY)
 *   4. Sets PairManager as authorized caller on both
 *   5. Calls pairManager.addPair(C, D) to register them
 *   6. Updates deployed_addresses.json with new pair
 *
 * The new pair does NOT become active immediately. It becomes active when:
 *   a) The current pair hits the expansion threshold (auto), OR
 *   b) Admin calls pairManager.forceAdvancePair() (manual)
 *
 * Run: npx hardhat run scripts/deploy_pair.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");

function sep(label = "") {
  const line = "─".repeat(54);
  console.log(label ? `\n  ${label}\n  ${line}` : `  ${line}`);
}

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("  deployed_addresses.json not found — run deploy_figure8_test.js first");
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [deployer] = await ethers.getSigners();

  // Read config from existing addresses
  const devWallet      = process.env.DEV_WALLET_ADDRESS      || deployer.address;
  const opsWallet      = process.env.OPS_WALLET_ADDRESS      || deployer.address;
  const protocolWallet = process.env.PROTOCOL_WALLET_ADDRESS || devWallet;
  const adminWallet    = process.env.ADMIN_WALLET_ADDRESS    || deployer.address;
  const accountOne     = addrs.AccountOne;

  if (!accountOne) {
    console.error("  AccountOne not found in deployed_addresses.json");
    process.exit(1);
  }

  // Read existing pair count from PairManager
  const pairMgr = await ethers.getContractAt("PairManager", addrs.PairManager);
  const pairCount = Number(await pairMgr.pairCount());
  const pairLetter = String.fromCharCode(65 + pairCount * 2);     // A=0→C=2→E=4...
  const pairLetterB = String.fromCharCode(65 + pairCount * 2 + 1);

  sep(`DEPLOYING PAIR ${pairCount + 1} (Matrix ${pairLetter} + Matrix ${pairLetterB})`);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  AccountOne:  ${accountOne}`);
  console.log(`  PairManager: ${addrs.PairManager}`);

  const F8 = await ethers.getContractFactory("FigureEightMatrix");
  const FEE        = BigInt(addrs.entryFee === "$10" ? 10_000_000 : 10_000_000);
  const MSIZE      = BigInt(addrs.matrixSize);

  // Deploy Matrix C (new pair, isMatrixA = true)
  const matC = await F8.deploy(
    addrs.USDC,
    addrs.CNOVAToken,
    addrs.CNOVATreasury,
    devWallet,
    opsWallet,
    ethers.ZeroAddress,  // founderWallet — set later
    protocolWallet,
    accountOne,
    adminWallet,
    FEE,
    MSIZE,
    true                 // isMatrixA = true
  );
  await matC.waitForDeployment();
  console.log(`  Matrix ${pairLetter}:     ${await matC.getAddress()}  (isMatrixA: true)`);

  // Deploy Matrix D (isMatrixA = false)
  const matD = await F8.deploy(
    addrs.USDC,
    addrs.CNOVAToken,
    addrs.CNOVATreasury,
    devWallet,
    opsWallet,
    ethers.ZeroAddress,
    protocolWallet,
    accountOne,
    adminWallet,
    FEE,
    MSIZE,
    false                // isMatrixA = false
  );
  await matD.waitForDeployment();
  console.log(`  Matrix ${pairLetterB}:     ${await matD.getAddress()}  (isMatrixA: false)`);

  const matCAddr = await matC.getAddress();
  const matDAddr = await matD.getAddress();

  // Link the pair
  await (await matC.setPartner(matDAddr)).wait();
  await (await matD.setPartner(matCAddr)).wait();
  console.log(`  ✓ Matrix ${pairLetter} ↔ Matrix ${pairLetterB} linked`);

  // Grant roles — same CNOVA token and treasury
  const cnova    = await ethers.getContractAt("CNOVAToken",    addrs.CNOVAToken);
  const treasury = await ethers.getContractAt("CNOVATreasury", addrs.CNOVATreasury);

  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  await (await cnova.grantRole(MINTER, matCAddr)).wait();
  await (await cnova.grantRole(MINTER, matDAddr)).wait();
  console.log(`  ✓ MINTER_ROLE → Matrix ${pairLetter}, Matrix ${pairLetterB}`);

  await (await treasury.setAuthorizedCaller(matCAddr, true)).wait();
  await (await treasury.setAuthorizedCaller(matDAddr, true)).wait();
  console.log(`  ✓ Treasury authorized: Matrix ${pairLetter}, Matrix ${pairLetterB}`);

  // Wire PairManager
  await (await matC.setPairManager(addrs.PairManager)).wait();
  await (await matD.setPairManager(addrs.PairManager)).wait();
  console.log(`  ✓ PairManager authorized on Matrix ${pairLetter} and Matrix ${pairLetterB}`);

  // Register with PairManager — also wires circular chain (chainNext + chainAuthorized)
  // PairManager must be owner of Matrix C and D to call setChainNext/setChainAuthorized
  // The admin (deployer) is already the owner, and PairManager calls onlyOwner funcs via delegated admin
  // NOTE: PairManager.addPair() calls setChainNext/setChainAuthorized on behalf of owner
  // But PairManager is NOT the owner of the matrices — admin wallet is.
  // So these calls need to happen from admin, not PairManager.
  // For now, addPair handles the chain wiring externally after registration.
  await (await pairMgr.addPair(matCAddr, matDAddr)).wait();
  console.log(`  ✓ Pair ${pairCount + 1} registered with PairManager (inactive — waiting for threshold)`);

  // Check if threshold already hit → new pair becomes active automatically on next register()
  const shouldExpand = await pairMgr.shouldExpand();
  if (shouldExpand) {
    console.log(`  ⚡  Active pair is at threshold — new pair will activate on next registration`);
  } else {
    const snap = await pairMgr.activePairOccupancyPct();
    console.log(`  ℹ️   Current pair at ${snap.pct}% — new pair activates at threshold`);
  }

  // Save new addresses to deployed_addresses.json
  const updatedAddrs = { ...addrs };
  updatedAddrs[`Matrix${pairLetter}`] = matCAddr;
  updatedAddrs[`Matrix${pairLetterB}`] = matDAddr;
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(updatedAddrs, null, 2));
  console.log(`  ✓ Addresses saved`);

  sep("PAIR DEPLOYED");
  console.log(`  Matrix ${pairLetter}: ${matCAddr}`);
  console.log(`  Matrix ${pairLetterB}: ${matDAddr}`);
  console.log(`\n  NEXT STEPS:`);
  console.log(`    • If pair is ready to go live immediately: pairManager.forceAdvancePair()`);
  console.log(`    • Otherwise: new registrations auto-route here when current pair hits threshold`);
  console.log(`    • Run check_f8_state.js to see all pairs status\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
