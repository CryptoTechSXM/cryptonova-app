"use strict";
/**
 * quickfill_f8.js — V7 Quick-fill for Figure-8 Self-Test
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads deployed_addresses.json and registers N random wallets into Matrix A.
 * Uses Account #1 as referrer so all L1 earnings flow to Wallet #1.
 *
 * After running, check escrow accumulation with check_f8_state.js.
 * Set COUNT=127 env var for a full fill — triggers root crossing.
 * The (MATRIX_SIZE+1)th registration triggers:
 *   1. Root (Wallet #1) cycles out of Matrix A
 *   2. Follow Me Escrow ($14) covers $10 crossing fee automatically
 *   3. Wallet #1 appears in Matrix B — figure-8 confirmed ✅
 *
 * Run: npx hardhat run scripts/quickfill_f8.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
// Referrer = Account #1, derived from deployed_addresses.json (set at deploy from W1_PRIVATE_KEY)
const _addrsForRef = fs.existsSync(ADDRESSES_FILE) ? JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8")) : {};
const REFERRER = _addrsForRef.AccountOne || new ethers.Wallet(process.env.W1_PRIVATE_KEY || "0x" + "1".repeat(64)).address;
const COUNT       = Number(process.env.COUNT      || 126);  // total wallets; 126 fills matrix A
const BATCH_SIZE  = Number(process.env.BATCH_SIZE  || 15);   // parallel txns per batch
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 60);   // seconds between batches
const FEE         = 10_000_000n;
const ETH_PER     = ethers.parseEther("0.002");

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n  ❌  deployed_addresses.json not found.`);
    console.error(`  Run deploy_figure8_test.js first.\n`);
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [deployer] = await ethers.getSigners();
  const matA      = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB      = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const usdc      = await ethers.getContractAt("MockUSDC",           addrs.USDC);
  // Use PairManager for registration if available, else fall back to direct matA
  const usePairManager = !!addrs.PairManager;
  const regTarget      = usePairManager ? addrs.PairManager : addrs.MatrixA;

  console.log(`\n  ─── Figure-8 V7 Quickfill ───────────────────────────`);
  console.log(`  Routing:   ${usePairManager ? "via PairManager" : "direct Matrix A"}`);
  console.log(`  Target:    ${regTarget}`);
  console.log(`  Referrer:  ${REFERRER.slice(0,10)}...  (Account #1)`);
  console.log(`  Count:     ${COUNT} wallets`);
  console.log(`  ─────────────────────────────────────────────────────`);

  // Guard: Account #1 must be registered first
  const w1Member = await matA.getMember(REFERRER);
  if (!w1Member.hasEverJoined) {
    console.log(`\n  ⚠️   Account #1 is not yet registered in Matrix A.`);
    console.log(`  Register Wallet #1 first then re-run this script.`);
    console.log(`  Steps:`);
    console.log(`    1. Fund ${REFERRER} with 0.001 ETH on Base Sepolia`);
    console.log(`    2. usdc.mint(${REFERRER}, 10000000)  → $10`);
    console.log(`    3. usdc.approve(MatrixA, 10000000)  from Wallet #1`);
    console.log(`    4. matA.register(ethers.ZeroAddress) from Wallet #1\n`);
    return;
  }

  const occ   = await matA.occupancy();
  const mSize = await matA.MATRIX_SIZE();
  console.log(`\n  Matrix A currently: ${occ}/${mSize} occupied`);
  console.log(`  Wallet #1 escrow:   $${(Number(await matA.escrowOf(REFERRER))/1e6).toFixed(2)}\n`);

  // Create all wallets upfront
  const wallets = Array.from({ length: COUNT }, () =>
    ethers.Wallet.createRandom().connect(ethers.provider)
  );

  const totalBatches = Math.ceil(COUNT / BATCH_SIZE);
  console.log(`  Wallets:    ${COUNT}  |  Batch size: ${BATCH_SIZE}  |  Batches: ${totalBatches}  |  Delay: ${BATCH_DELAY}s`);

  // ── Pre-fund all wallets (ETH + USDC) in parallel batches ──────────────────
  console.log(`\n  Pre-funding ${COUNT} wallets (ETH + USDC)...`);
  for (let b = 0; b < totalBatches; b++) {
    const slice = wallets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    await Promise.all(slice.map(w =>
      deployer.sendTransaction({ to: w.address, value: ETH_PER }).then(tx => tx.wait())
    ));
    await Promise.all(slice.map(w =>
      usdc.connect(deployer).mint(w.address, FEE * 2n).then(tx => tx.wait())
    ));
    process.stdout.write(`  ✓ batch ${b + 1}/${totalBatches} funded\r`);
  }
  console.log(`  ✓ All ${COUNT} wallets funded.           `);

  // ── Register in batches ────────────────────────────────────────────────────
  console.log(`\n  Registering in batches of ${BATCH_SIZE}...\n`);
  let ok = 0;

  const registerOne = async (w, idx) => {
    await (await usdc.connect(w).approve(regTarget, FEE * 2n)).wait();
    if (usePairManager) {
      const pm = new ethers.Contract(addrs.PairManager,
        ["function register(address referrer) external"], w);
      await (await pm.register(REFERRER)).wait();
    } else {
      await (await matA.connect(w).register(REFERRER)).wait();
    }
    return idx;
  };

  for (let b = 0; b < totalBatches; b++) {
    const slice  = wallets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const base   = b * BATCH_SIZE;

    // Fire all in batch in parallel
    const results = await Promise.allSettled(
      slice.map((w, i) => registerOne(w, base + i))
    );

    results.forEach((r, i) => {
      if (r.status === "fulfilled") ok++;
      else console.log(`  [${String(base+i+1).padStart(3)}] FAILED: ${r.reason?.shortMessage || r.reason?.message || r.reason}`);
    });

    // Snapshot after batch
    const root   = await matA.posToMember(1);
    const escrow = root !== ethers.ZeroAddress ? await matA.escrowOf(root) : 0n;
    const isW1   = root.toLowerCase() === REFERRER.toLowerCase();
    const occNow = await matA.occupancy();
    const rotNow = await matA.rotationCount();
    const w1inB  = (await matB.getMember(REFERRER)).isInMatrix;

    console.log(
      `  Batch ${String(b+1).padStart(2)}/${totalBatches}  ` +
      `registered: ${ok}/${COUNT}  ` +
      `occ: ${occNow}/${mSize}  ` +
      `rot: ${rotNow}  ` +
      `root escrow: $${(Number(escrow)/1e6).toFixed(2)}${isW1 ? " (W1)" : ""}` +
      `${w1inB ? "  🎉 W1 IN MATRIX B!" : ""}`
    );

    // Wait between batches (skip after last)
    if (b < totalBatches - 1) {
      process.stdout.write(`  ⏳ waiting ${BATCH_DELAY}s before next batch...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY * 1000));
      process.stdout.write(`  ✓ continuing\n`);
    }
  }

  // Summary
  const [totA, occA, rotA]  = await Promise.all([matA.totalJoined(), matA.occupancy(), matA.rotationCount()]);
  const totB   = await matB.totalJoined();
  const w1inB  = (await matB.getMember(REFERRER)).isInMatrix;
  const w1escA = await matA.escrowOf(REFERRER);
  const w1earn = (await matA.getMember(REFERRER)).withdrawable;

  console.log(`\n  ─── Self-Test Results ─────────────────────────────`);
  console.log(`  Registered:    ${ok}/${COUNT} wallets`);
  console.log(`  Matrix A:      ${totA} total | ${occA}/${mSize} occupied | ${rotA} rotations`);
  console.log(`  Matrix B:      ${totB} total joined`);
  console.log(`  Wallet #1 in Matrix B: ${w1inB ? "✅ YES — Follow Me Escrow crossing confirmed!" : "❌ not crossed yet (need " + (Number(mSize) - Number(occA) + 1) + " more registrations)"}`);
  console.log(`  Wallet #1 escrow (A):  $${(Number(w1escA)/1e6).toFixed(2)}`);
  console.log(`  Wallet #1 earnings:    $${(Number(w1earn)/1e6).toFixed(2)}`);
  if (rotA > 0n) {
    console.log(`\n  🎉  Figure-8 V7 self-test PASSED — root crossed via escrow!`);
  }
  console.log(`\n  Next: npx hardhat run scripts/check_f8_state.js --network baseSepolia\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
