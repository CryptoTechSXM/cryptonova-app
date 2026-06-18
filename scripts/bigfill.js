"use strict";
/**
 * bigfill.js — Large-scale Figure-8 stress test
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Reads deployed_addresses.json (Pair 1 must already be deployed + W1 registered)
 * 2. Calculates how many extra pairs are needed for the requested COUNT
 * 3. Auto-deploys and wires up those pairs (C↔D, E↔F, ...) into PairManager
 * 4. Batch-registers COUNT wallets in groups of BATCH_SIZE with BATCH_DELAY between
 * 5. Shows per-batch stats: active pair, occupancy, rotations, crossing events
 *
 * Env vars (all optional):
 *   COUNT=500        total wallets to register  (default 500)
 *   BATCH_SIZE=20    parallel registrations per batch (default 20)
 *   BATCH_DELAY=60   seconds between batches (default 60)
 *   SKIP_DEPLOY=true skip pair pre-deploy (if already done)
 *
 * Run: npx hardhat run scripts/bigfill.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");

const COUNT       = Number(process.env.COUNT       || 50);
const BATCH_SIZE  = Number(process.env.BATCH_SIZE  || 2);
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 10);
const SKIP_DEPLOY = process.env.SKIP_DEPLOY === "true";
const FEE         = 10_000_000n;
const ETH_PER     = ethers.parseEther("0.002");

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt6  = n => "$" + (Number(n) / 1e6).toFixed(2);
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
function sep(label = "") {
  const line = "─".repeat(60);
  if (label) console.log(`\n  ── ${label} ─${"─".repeat(Math.max(0,56-label.length))}`);
  else        console.log(`  ${line}`);
}

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("\n  ❌  deployed_addresses.json not found. Run deploy_figure8_test.js first.");
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [deployer] = await ethers.getSigners();
  const pm      = await ethers.getContractAt("PairManager",      addrs.PairManager);
  const matA    = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const usdc    = await ethers.getContractAt("MockUSDC",          addrs.USDC);
  const cnova   = await ethers.getContractAt("CNOVAToken",        addrs.CNOVAToken);

  const REFERRER = addrs.AccountOne;
  const mSize    = Number(await matA.MATRIX_SIZE());

  // Each pair holds mSize×2 slots; at 80% threshold ~mSize×1.6 before auto-advance
  const thresholdBps = Number(await pm.expandThresholdBps());
  const slotsPerPair = mSize * 2;
  const triggerAt    = Math.floor(slotsPerPair * thresholdBps / 10000);
  const pairsNeeded  = Math.ceil(COUNT / triggerAt) + 2;  // +2 buffer (active pair needs a next pair)

  sep(`bigfill.js — ${COUNT} wallets · batch ${BATCH_SIZE} · delay ${BATCH_DELAY}s`);
  console.log(`  Deployer:       ${deployer.address.slice(0,10)}...`);
  console.log(`  Referrer (W1):  ${REFERRER.slice(0,10)}...`);
  console.log(`  Matrix size:    ${mSize}  (${slotsPerPair} slots/pair)`);
  console.log(`  Expand trigger: ${triggerAt} members/pair (${thresholdBps/100}%)`);
  console.log(`  Pairs needed:   ${pairsNeeded} (1 already deployed)`);
  sep();

  // Guard: W1 must be registered
  const w1 = await matA.getMember(REFERRER);
  if (!w1.hasEverJoined) {
    console.error("  ❌  W1 not registered. Run register_w1.js first.");
    process.exit(1);
  }

  // ── Step 1: Pre-deploy extra pairs ─────────────────────────────────────────
  const pairStatus0   = await pm.allPairsStatus();
  const existingPairs = pairStatus0.matrixAs.length;
  const toDeploy = Math.max(0, pairsNeeded - existingPairs);

  if (toDeploy > 0 && !SKIP_DEPLOY) {
    sep(`Deploying ${toDeploy} additional pair(s)`);

    const F8 = await ethers.getContractFactory("FigureEightMatrix");
    const devWallet      = addrs.devWallet      || deployer.address;
    const opsWallet      = addrs.opsWallet      || deployer.address;
    const protocolWallet = process.env.PROTOCOL_WALLET_ADDRESS || devWallet;
    const adminWallet    = addrs.adminWallet    || deployer.address;

    for (let i = 0; i < toDeploy; i++) {
      const pairNum = existingPairs + i + 1;
      console.log(`  Deploying Pair ${pairNum} (${pairNum * 2 - 1}↔${pairNum * 2})...`);

      const newMatA = await F8.deploy(
        addrs.USDC, addrs.CNOVAToken, addrs.CNOVATreasury,
        devWallet, opsWallet, ethers.ZeroAddress, protocolWallet,
        REFERRER, adminWallet, FEE, mSize, true
      );
      await newMatA.waitForDeployment();

      const newMatB = await F8.deploy(
        addrs.USDC, addrs.CNOVAToken, addrs.CNOVATreasury,
        devWallet, opsWallet, ethers.ZeroAddress, protocolWallet,
        REFERRER, adminWallet, FEE, mSize, false
      );
      await newMatB.waitForDeployment();

      const addrA = await newMatA.getAddress();
      const addrB = await newMatB.getAddress();

      // Link pair
      await (await newMatA.setPartner(addrB)).wait();
      await (await newMatB.setPartner(addrA)).wait();

      // Wire PairManager BEFORE addPair (avoids "F8: not chain admin")
      await (await newMatA.setPairManager(addrs.PairManager)).wait();
      await (await newMatB.setPairManager(addrs.PairManager)).wait();

      // Grant MINTER_ROLE
      const MINTER = await cnova.MINTER_ROLE();
      await (await cnova.grantRole(MINTER, addrA)).wait();
      await (await cnova.grantRole(MINTER, addrB)).wait();

      // Wire treasury
      const treasury = await ethers.getContractAt("CNOVATreasury", addrs.CNOVATreasury);
      await (await treasury.setAuthorizedCaller(addrA, true)).wait();
      await (await treasury.setAuthorizedCaller(addrB, true)).wait();

      // Register with PairManager (auto-wires chain)
      await (await pm.addPair(addrA, addrB)).wait();

      console.log(`  ✓ Pair ${pairNum}: MatA=${addrA.slice(0,10)}… MatB=${addrB.slice(0,10)}…`);

      // Save to addresses
      const key = `Pair${pairNum}`;
      addrs[key] = { MatrixA: addrA, MatrixB: addrB };
    }

    fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addrs, null, 2));
    console.log(`  ✓ deployed_addresses.json updated`);
  } else if (SKIP_DEPLOY) {
    console.log(`  SKIP_DEPLOY=true — using existing pairs`);
  } else {
    console.log(`  ✓ Enough pairs already deployed (${existingPairs} pairs)`);
  }

  // Show pair summary
  const status = await pm.allPairsStatus();
  const totalPairs = status.matrixAs.length;
  sep(`Pair lineup (${totalPairs} pairs)`);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pairLabel = i => i < 13
    ? `(${letters[i*2]}↔${letters[i*2+1]})`
    : `(P${(i*2)+1}↔P${(i*2)+2})`;
  for (let i = 0; i < totalPairs; i++) {
    const mA2 = await ethers.getContractAt("FigureEightMatrix", status.matrixAs[i]);
    const mB2 = await ethers.getContractAt("FigureEightMatrix", status.matrixBs[i]);
    const [oA, oB] = await Promise.all([mA2.occupancy(), mB2.occupancy()]);
    const combined = Number(oA) + Number(oB);
    const pct = Math.round(combined * 100 / slotsPerPair);
    const active = (i === Number(await pm.activePairIndex())) ? " ← ACTIVE" : "";
    console.log(`  Pair ${i+1} ${pairLabel(i)}: ${combined}/${slotsPerPair} (${pct}%)${active}`);
  }

  // ── Step 2: Create and fund all wallets ────────────────────────────────────
  const totalBatches = Math.ceil(COUNT / BATCH_SIZE);
  sep(`Creating ${COUNT} wallets`);
  const wallets = Array.from({ length: COUNT }, () =>
    ethers.Wallet.createRandom().connect(ethers.provider)
  );
  console.log(`  ✓ ${COUNT} wallets generated`);
  console.log(`  Funding in parallel batches...`);

  // Use pending nonce so we don't collide with any txs still sitting in the mempool
  let fundNonce = Number(await ethers.provider.getTransactionCount(deployer.address, "pending"));
  for (let b = 0; b < totalBatches; b++) {
    const slice = wallets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    // ETH sends — pre-assign nonces to avoid "replacement underpriced" on Base Sepolia
    const ethTxs = await Promise.all(slice.map((w, i) =>
      deployer.sendTransaction({ to: w.address, value: ETH_PER, nonce: fundNonce + i })
    ));
    fundNonce += slice.length;
    // USDC mints — pre-assign nonces
    const usdcTxs = await Promise.all(slice.map((w, i) =>
      usdc.connect(deployer).mint(w.address, FEE * 2n, { nonce: fundNonce + i })
    ));
    fundNonce += slice.length;
    // Wait for all to confirm
    await Promise.all([...ethTxs, ...usdcTxs].map(t => t.wait()));
    process.stdout.write(`  ✓ funded ${Math.min((b+1)*BATCH_SIZE, COUNT)}/${COUNT}\r`);
  }
  console.log(`  ✓ All ${COUNT} wallets funded.              `);

  // ── Step 3: Batch register ─────────────────────────────────────────────────
  sep(`Registering ${COUNT} wallets — ${totalBatches} batches of ${BATCH_SIZE}`);
  console.log(`  Each batch fires ${BATCH_SIZE} approve+register transactions in parallel`);
  console.log(`  ${BATCH_DELAY}s cooldown between batches\n`);

  let ok = 0;
  let lastActivePair = -1;

  for (let b = 0; b < totalBatches; b++) {
    const slice = wallets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

    // Use full hardhat ABI so custom errors are decoded properly
    const pmFull = await ethers.getContractAt("PairManager", addrs.PairManager);

    const results = await Promise.allSettled(slice.map(async w => {
      await (await usdc.connect(w).approve(addrs.PairManager, FEE * 2n)).wait();
      const pmW = pmFull.connect(w);
      // Dry-run first to surface the actual revert reason
      try {
        await pmW.register.staticCall(REFERRER);
      } catch (simErr) {
        const reason = simErr.reason || simErr.shortMessage || simErr.message;
        const data   = simErr.data ? ` [data:${simErr.data}]` : "";
        throw new Error(`SIM: ${reason}${data}`);
      }
      await (await pmW.register(REFERRER)).wait();
    }));

    const batchOk  = results.filter(r => r.status === "fulfilled").length;
    const batchFail = results.filter(r => r.status === "rejected").length;
    ok += batchOk;
    if (batchFail > 0) {
      results.filter(r=>r.status==="rejected").forEach((r,i) =>
        console.log(`  [batch ${b+1} slot ${i}] FAILED: ${r.reason?.shortMessage || r.reason?.message}`));
    }

    // Snapshot — re-fetch pair status each batch so the index never goes out of bounds
    const snapStatus = await pm.allPairsStatus();
    const activePairIdx = await pm.activePairIndex();
    const aPairIdx = Math.min(Number(activePairIdx), snapStatus.matrixAs.length - 1);
    const aMat = await ethers.getContractAt("FigureEightMatrix", snapStatus.matrixAs[aPairIdx]);
    const bMat = await ethers.getContractAt("FigureEightMatrix", snapStatus.matrixBs[aPairIdx]);
    const [oA, oB, rotA, rotB] = await Promise.all([
      aMat.occupancy(), bMat.occupancy(), aMat.rotationCount(), bMat.rotationCount()
    ]);
    const w1escrow = await aMat.escrowOf(REFERRER);
    const w1inB    = (await bMat.getMember(REFERRER)).isInMatrix;

    // Detect pair advance
    let pairTag = "";
    if (aPairIdx !== lastActivePair && lastActivePair !== -1) {
      pairTag = `  🚀 PAIR ${aPairIdx + 1} NOW ACTIVE`;
    }
    lastActivePair = aPairIdx;

    console.log(
      `  Batch ${String(b+1).padStart(2)}/${totalBatches}` +
      `  ok:${batchOk}/${slice.length}` +
      `  total:${ok}/${COUNT}` +
      `  pair:${aPairIdx+1}` +
      `  occ:${Number(oA)+Number(oB)}/${slotsPerPair}` +
      `  rot:A${rotA}/B${rotB}` +
      `  W1escrow:${fmt6(w1escrow)}` +
      (w1inB ? `  W1→B✅` : ``) +
      pairTag
    );

    if (b < totalBatches - 1) {
      process.stdout.write(`  ⏳ ${BATCH_DELAY}s cooldown...`);
      await sleep(BATCH_DELAY);
      process.stdout.write(`  ✓ next batch\n`);
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  sep("FINAL STATE");
  const finalStatus = await pm.allPairsStatus();
  for (let i = 0; i < finalStatus.matrixAs.length; i++) {
    const mA2 = await ethers.getContractAt("FigureEightMatrix", finalStatus.matrixAs[i]);
    const mB2 = await ethers.getContractAt("FigureEightMatrix", finalStatus.matrixBs[i]);
    const [oA2, tA2, rotA2, escA2] = await Promise.all([
      mA2.occupancy(), mA2.totalJoined(), mA2.rotationCount(), mA2.totalEscrowHeld()
    ]);
    const [oB2, tB2, rotB2] = await Promise.all([
      mB2.occupancy(), mB2.totalJoined(), mB2.rotationCount()
    ]);
    const combined = Number(oA2) + Number(oB2);
    const active = (i === Number(await pm.activePairIndex())) ? " ← ACTIVE" : "";
    console.log(`  Pair ${i+1}${active}`);
    console.log(`    Matrix A: ${oA2}/${mSize} occ | ${tA2} joined | ${rotA2} rotations`);
    console.log(`    Matrix B: ${oB2}/${mSize} occ | ${tB2} joined | ${rotB2} rotations`);
    console.log(`    Combined: ${combined}/${slotsPerPair} | escrow held: ${fmt6(escA2)}`);
  }
  sep();
  console.log(`  Total registered:  ${ok}/${COUNT}`);
  console.log(`  Batches completed: ${totalBatches}`);
  console.log(`  Successful joins:  ${ok}/${COUNT}`);
  console.log(`\n  Next: npx hardhat run scripts/check_f8_state.js --network baseSepolia\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
