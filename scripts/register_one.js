"use strict";
/**
 * register_one.js — Register a single random wallet to trigger the next cycle
 * Used to test what happens when a nearly-full matrix gets one more member.
 *
 * Run: npx hardhat run scripts/register_one.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
const FEE = 10_000_000n;

async function main() {
  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();
  const matA = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const usdc  = await ethers.getContractAt("MockUSDC",          addrs.USDC);

  const occ     = await matA.occupancy();
  const mSize   = await matA.MATRIX_SIZE();
  const root    = await matA.posToMember(1);
  const rootEsc = await matA.escrowOf(root);
  const rootEar = (await matA.getMember(root)).withdrawable;

  console.log(`\n  ─── Register One (trigger next cycle) ──────────────`);
  console.log(`  Matrix A: ${occ}/${mSize} occupied`);
  console.log(`  Current root: ${root.slice(0,10)}...`);
  console.log(`  Root funds:   $${(Number(rootEsc + rootEar)/1e6).toFixed(2)} (escrow $${(Number(rootEsc)/1e6).toFixed(2)} + earn $${(Number(rootEar)/1e6).toFixed(2)})`);
  console.log(`  Crossing needs: $10.00`);
  console.log(`  Will cross: ${(rootEsc + rootEar) >= 10_000_000n ? "✅ YES" : "⚠️  NO — will park (run check_stuck.js after)"}`);

  const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
  const ethTx = await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("0.005") });
  await ethTx.wait();
  await new Promise(r => setTimeout(r, 4000));  // wait for RPC to reflect balance
  await (await usdc.connect(deployer).mint(wallet.address, FEE * 2n)).wait();
  // Route via PairManager if available
  const regTarget = addrs.PairManager || addrs.MatrixA;
  await (await usdc.connect(wallet).approve(regTarget, FEE)).wait();

  const referrer = addrs.AccountOne;
  let tx;
  if (addrs.PairManager) {
    const pm = await ethers.getContractAt("PairManager", addrs.PairManager);
    tx = await pm.connect(wallet).register(referrer);
  } else {
    tx = await matA.connect(wallet).register(referrer);
  }
  await tx.wait();

  console.log(`\n  ✓ Registered: ${wallet.address.slice(0,10)}... tx: ${tx.hash}`);

  const rotA  = await matA.rotationCount();
  const totB  = await matB.totalMembers();
  const w1inB = (await matB.getMember(root)).isInMatrix;

  console.log(`\n  Matrix A rotations: ${rotA}`);
  console.log(`  Matrix B total:     ${totB}`);
  console.log(`  Previous root in B: ${w1inB ? "✅ crossed" : "⚠️  parked — run check_stuck.js"}`);

  // Check if PairManager routed to Pair 2
  if (addrs.PairManager && addrs.MatrixC) {
    const matC = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixC);
    const newMemberInC = (await matC.getMember(wallet.address)).isInMatrix;
    const activePair = await (await ethers.getContractAt("PairManager", addrs.PairManager)).activePairIndex();
    console.log(`  Active pair now:    Pair ${Number(activePair) + 1}`);
    console.log(`  New member in C:    ${newMemberInC ? "✅ YES — Pair 2 routing confirmed!" : "⚠️  still in Pair 1"}`);
  }
  console.log(`\n  Next: npx hardhat run scripts/check_stuck.js --network baseSepolia\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
