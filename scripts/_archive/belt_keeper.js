/**
 * belt_keeper.js — CryptoNova Belt Buffer Keeper
 * ─────────────────────────────────────────────────────────────────
 * Maintains a 5-belt buffer ahead of the active belt at all times.
 * Runs continuously, polling every 2 minutes.
 *
 * Rule: whenever activeBeltIndex advances and beltsAhead < BUFFER,
 *       deploy a new belt and call beltManager.addBelt().
 *
 * Usage:
 *   node scripts/belt_keeper.js --network baseSepolia
 *   node scripts/belt_keeper.js --network baseMainnet
 *
 * Or as a background service:
 *   pm2 start scripts/belt_keeper.js --name "cn-belt-keeper"
 *
 * Requires .env:
 *   DEPLOYER_PRIVATE_KEY
 *   BELT_MANAGER_ADDRESS
 *   TIER_MANAGER_ADDRESS
 *   COMMUNITY_WALLET_ADDRESS
 *   TREASURY_ADDRESS
 *   CNOVA_TOKEN_ADDRESS
 *   USDC_ADDRESS
 *   DEV_WALLET_ADDRESS
 *   OPS_WALLET_ADDRESS
 *   ADMIN_WALLET_ADDRESS
 *   RPC_URL
 */

"use strict";

const { ethers } = require("ethers");
require("dotenv").config();

// ── Config ─────────────────────────────────────────────────────────────────
const BELT_BUFFER   = 5;          // always keep this many belts ahead
const POLL_INTERVAL = 2 * 60 * 1000; // check every 2 minutes
const FILL_THRESHOLD = 0.80;     // deploy new belt when active belt is 80% full

// Addresses — read from env or override here
const BELT_MANAGER   = process.env.BELT_MANAGER_ADDRESS;
const TIER_MANAGER   = process.env.TIER_MANAGER_ADDRESS;
const COMMUNITY_ADDR = process.env.COMMUNITY_WALLET_ADDRESS;
const TREASURY_ADDR  = process.env.TREASURY_ADDRESS;
const CNOVA_ADDR     = process.env.CNOVA_TOKEN_ADDRESS;
const USDC_ADDR      = process.env.USDC_ADDRESS;
const DEV_WALLET     = process.env.DEV_WALLET_ADDRESS;
const OPS_WALLET     = process.env.OPS_WALLET_ADDRESS;
const ADMIN_WALLET   = process.env.ADMIN_WALLET_ADDRESS;
const RPC_URL        = process.env.RPC_URL || "https://mainnet.base.org";

// ── ABIs (minimal) ─────────────────────────────────────────────────────────
const BM_ABI = [
  "function activeBeltIndex() view returns (uint256)",
  "function totalBelts() view returns (uint256)",
  "function BELT_MAX() view returns (uint256)",
  "function beltStatus(uint256) view returns (address, uint256, bool, bool)",
  "function addBelt(address belt) external",
  "event BeltActivated(uint256 indexed beltIndex, address beltAddress)",
];
const TM_ABI  = ["function setMatrix(uint8,address) external", "function setBeltManager(address) external", "function setAutoUpgradeCaller(address,bool) external"];
const CW_ABI  = ["function setAuthorisedRegistrar(address,bool) external"];
const TR_ABI  = ["function setAuthorizedCaller(address,bool) external"];
const TOK_ABI = ["function grantRole(bytes32,address) external", "function MINTER_ROLE() view returns (bytes32)"];
const MX_ABI  = ["function setAuthorizedRegistrar(address,bool) external", "function setTierManager(address) external", "function setBeltManagerCaller(address) external"];

// ── State ──────────────────────────────────────────────────────────────────
let lastActiveBelt   = -1;
let beltsDeployed    = 0;
let provider, signer, bm, MatrixFactory;

// ── Logging ────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Deploy a new belt and wire it ──────────────────────────────────────────
async function deployNewBelt() {
  log("Deploying new belt...");

  // Get reference belt params (from Belt A)
  const [beltAAddr] = await bm.beltStatus(0);
  const beltA = new ethers.Contract(beltAAddr, [
    "function ENTRY_FEE() view returns (uint256)",
    "function UNIT() view returns (uint256)",
    "function FEE_MULTIPLIER() view returns (uint256)",
    "function ACTIVE_WINDOW() view returns (uint256)",
    "function REENTRY_FEE_BPS() view returns (uint256)",
  ], provider);

  const [unit, mult, aw] = await Promise.all([
    beltA.UNIT(), beltA.FEE_MULTIPLIER(), beltA.ACTIVE_WINDOW()
  ]);

  // Deploy new matrix
  const newBelt = await MatrixFactory.deploy(
    USDC_ADDR, CNOVA_ADDR, TREASURY_ADDR,
    DEV_WALLET, OPS_WALLET, COMMUNITY_ADDR,
    ADMIN_WALLET, unit, mult, aw
  );
  await newBelt.waitForDeployment();
  const newAddr = await newBelt.getAddress();
  log(`  New belt deployed: ${newAddr}`);

  // Wire roles
  const cnova = new ethers.Contract(CNOVA_ADDR, TOK_ABI, signer);
  const tr    = new ethers.Contract(TREASURY_ADDR, TR_ABI, signer);
  const cw    = new ethers.Contract(COMMUNITY_ADDR, CW_ABI, signer);
  const mxNew = new ethers.Contract(newAddr, MX_ABI, signer);
  const MINTER_ROLE = await cnova.MINTER_ROLE();

  await (await cnova.grantRole(MINTER_ROLE, newAddr)).wait();
  await (await tr.setAuthorizedCaller(newAddr, true)).wait();
  await (await cw.setAuthorisedRegistrar(newAddr, true)).wait();
  await (await mxNew.setAuthorizedRegistrar(BELT_MANAGER, true)).wait();
  await (await mxNew.setTierManager(TIER_MANAGER)).wait();
  await (await mxNew.setBeltManagerCaller(BELT_MANAGER)).wait();

  // Register tier manager as auto-upgrade caller
  const tm = new ethers.Contract(TIER_MANAGER, TM_ABI, signer);
  await (await tm.setAutoUpgradeCaller(newAddr, true)).wait();

  // Add to BeltManager
  await (await bm.addBelt(newAddr)).wait();

  const totalBelts = await bm.totalBelts();
  log(`  Belt added. Total belts: ${totalBelts}. Buffer: ${Number(totalBelts) - lastActiveBelt - 1} belts ahead.`);
  beltsDeployed++;
  return newAddr;
}

// ── Main check loop ─────────────────────────────────────────────────────────
async function check() {
  try {
    const [activeIdx, totalBelts, beltMax] = await Promise.all([
      bm.activeBeltIndex(),
      bm.totalBelts(),
      bm.BELT_MAX(),
    ]);
    const active     = Number(activeIdx);
    const total      = Number(totalBelts);
    const beltsAhead = total - active - 1;

    // Check if belt has advanced since last poll
    if (active !== lastActiveBelt) {
      log(`Belt advanced: ${lastActiveBelt} → ${active} | Total: ${total} | Buffer: ${beltsAhead} ahead`);
      lastActiveBelt = active;
    }

    // Also check if active belt is filling up fast
    const [, activeCount] = await bm.beltStatus(active);
    const fillPct = Number(activeCount) / Number(beltMax);
    if (fillPct >= FILL_THRESHOLD) {
      log(`Active belt ${active} is ${(fillPct*100).toFixed(0)}% full.`);
    }

    // Deploy if buffer is below threshold
    if (beltsAhead < BELT_BUFFER) {
      log(`Buffer low (${beltsAhead} < ${BELT_BUFFER}). Deploying new belt...`);
      await deployNewBelt();
    }

  } catch (e) {
    log(`ERROR: ${e.message}`);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────
async function main() {
  if (!BELT_MANAGER) throw new Error("BELT_MANAGER_ADDRESS not set in .env");
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY not set");

  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  bm       = new ethers.Contract(BELT_MANAGER, BM_ABI, signer);

  const { ethers: hEthers } = require("hardhat");
  MatrixFactory = await hEthers.getContractFactory("CryptoNovaMatrixV3");

  log("Belt Keeper started");
  log(`BeltManager : ${BELT_MANAGER}`);
  log(`Buffer      : ${BELT_BUFFER} belts ahead`);
  log(`Poll        : every ${POLL_INTERVAL/1000}s`);

  // Listen for BeltActivated events for instant response
  bm.on("BeltActivated", async (beltIndex, beltAddress) => {
    log(`EVENT: Belt ${beltIndex} activated (${beltAddress})`);
    await check();
  });

  // Initial check
  await check();

  // Polling loop as backup
  setInterval(check, POLL_INTERVAL);
  log("Keeper running. Press Ctrl+C to stop.");
}

main().catch(e => { console.error(e); process.exit(1); });
