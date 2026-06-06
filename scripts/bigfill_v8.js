"use strict";
/**
 * bigfill_v8.js — V8 Elevator stress test
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads deployed_addresses_v8.json (Phase 1 deploy must be done + W1 registered).
 *
 * What it does:
 *   1. Funds COUNT wallets with ETH + USDC
 *   2. Registers them all into T1 via TierRouter (referrer = W1 / Account #1)
 *   3. After each batch: prints occupancy, cycle-outs, W1 earnings, W1 tier
 *   4. Confirms W1 auto-upgrades to T2 after enough T1 cycle-outs
 *   5. Final snapshot: treasury balance, CNOVA minted, TierRouter state
 *
 * Env vars (all optional):
 *   COUNT=50          total wallets to register  (default 50)
 *   BATCH_SIZE=5      parallel registrations per batch (default 5)
 *   BATCH_DELAY=8     seconds between batches (default 8)
 *   HDR_OFFSET=500    BIP-44 index offset for wallet derivation (default 500)
 *                     Change to 1000+ if all wallets at default offset are already globalJoined
 *   REFERRER=0x...    override referrer (default = AccountOne from addresses file)
 *
 * Run: npx hardhat run scripts/bigfill_v8.js --network baseSepolia
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses_v8_1.json");

const COUNT       = Number(process.env.COUNT       || 50);
const BATCH_SIZE  = Number(process.env.BATCH_SIZE  || 5);
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 8);
const HDR_OFFSET  = Number(process.env.HDR_OFFSET  || 500); // BIP-44 index offset (change to avoid globalJoined collisions)
const ETH_PER     = ethers.parseEther("0.01");   // gas budget per wallet (approve + register on Base Sepolia)

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep  = s  => new Promise(r => setTimeout(r, s * 1000));
const fmt6   = n  => "$" + (Number(n) / 1e6).toFixed(2);
const pct    = (a, b) => b === 0n ? "0%" : (Number(a * 100n / b)).toFixed(0) + "%";

function sep(label = "") {
  const dashes = "─".repeat(60);
  if (label) console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 56 - label.length))}`);
  else       console.log(`  ${dashes}`);
}

// Generate COUNT deterministic wallets from a fixed mnemonic
function makeWallets(count) {
  const mnemo = "test test test test test test test test test test test junk";
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const path = `m/44'/60'/0'/0/${i + HDR_OFFSET}`; // configurable offset — change HDR_OFFSET env var to get fresh addresses
    wallets.push(ethers.HDNodeWallet.fromPhrase(mnemo, undefined, path));
  }
  return wallets;
}

// ── Snapshot helper (V8.1) ────────────────────────────────────────────────────
async function snapshot(label, { tierRouter, pm1, matA1, matB1, matA2, matB2,
                                   cnova, treasury, stabilityFund, w1Addr }) {
  sep(label);
  const w1Tier   = await tierRouter.memberHighestTier(w1Addr);
  const w1Cycles = await tierRouter.tierCycles(w1Addr, 0);
  const totalCyc = await tierRouter.totalSystemCycles();
  const paused   = await tierRouter.systemPaused();
  const totalReg = await pm1.totalRegistrations();

  const occ1A = await matA1.occupancy();
  const occ1B = await matB1.occupancy();
  const mSize = await matA1.MATRIX_SIZE();

  console.log(`  T1 total registered: ${totalReg}`);
  console.log(`  T1 MatA occupancy:   ${occ1A} / ${mSize}`);
  console.log(`  T1 MatB occupancy:   ${occ1B} / ${mSize}`);
  console.log(`  W1 highest tier:     T${w1Tier}`);
  console.log(`  W1 T1 cycles:        ${w1Cycles}`);
  console.log(`  Total system cycles: ${totalCyc}`);
  console.log(`  System paused:       ${paused}`);

  // V8.1: equalization pool accumulators
  try {
    const poolA = await matA1.poolAccumulator();
    const poolB = await matB1.poolAccumulator();
    if (poolA > 0n || poolB > 0n) {
      console.log(`  T1 Pool accumulator: A=${fmt6(poolA)}  B=${fmt6(poolB)}`);
    }
  } catch {}

  // V8.1: StabilityFund balance
  if (stabilityFund) {
    try {
      const sfBal = await stabilityFund.totalBalance();
      console.log(`  StabilityFund bal:   ${fmt6(sfBal)}`);
    } catch {}
  }

  try {
    const w1Member = await matA1.getMember(w1Addr);
    if (w1Member.hasEverJoined) {
      console.log(`  W1 T1 withdrawable:  ${fmt6(w1Member.withdrawable)}`);
    }
  } catch {}

  if (w1Tier >= 2n) {
    try {
      const w1T2 = await matA2.getMember(w1Addr);
      if (w1T2.hasEverJoined) {
        console.log(`  W1 T2 withdrawable:  ${fmt6(w1T2.withdrawable)}`);
        console.log(`  W1 T2 BFS pos:       ${w1T2.bfsPosition}`);
      }
    } catch {}
    const w1T2Cycles = await tierRouter.tierCycles(w1Addr, 1);
    console.log(`  W1 T2 cycles:        ${w1T2Cycles}`);

    // V8.1: equalization pool in T2
    try {
      const pool2A = await matA2.poolAccumulator();
      if (pool2A > 0n) console.log(`  T2 Pool accumulator: A=${fmt6(pool2A)}`);
    } catch {}
  }

  const treasuryBal = await cnova.balanceOf(await treasury.getAddress());
  const totalSupply = await cnova.totalSupply();
  console.log(`  CNOVA minted:        ${ethers.formatEther(totalSupply)}`);
  console.log(`  Treasury CNOVA:      ${ethers.formatEther(treasuryBal)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n  ❌  ${ADDRESSES_FILE} not found. Run deploy_v8.js first.`);
    process.exit(1);
  }

  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  // ── Load contracts ──────────────────────────────────────────────────────────
  // V8.1 address file uses lowercase keys and tiers nested object
  const USDC_ADDR   = addrs.usdc        || addrs.USDC;
  const CNOVA_ADDR  = addrs.cnova       || addrs.CNOVAToken;
  const TREAS_ADDR  = addrs.treasury    || addrs.CNOVATreasury;
  const TR_ADDR     = addrs.tierRouter  || addrs.TierRouter;
  const SF_ADDR     = addrs.stabilityFund;
  const T1          = addrs.tiers?.T1   || { matA: addrs.T1?.MatrixA,  matB: addrs.T1?.MatrixB,  pm: addrs.T1?.PairManager };
  const T2          = addrs.tiers?.T2   || { matA: addrs.T2?.MatrixA,  matB: addrs.T2?.MatrixB,  pm: addrs.T2?.PairManager };

  const usdc         = await ethers.getContractAt("MockUSDC",            USDC_ADDR);
  const cnova        = await ethers.getContractAt("CNOVAToken",          CNOVA_ADDR);
  const treasury     = await ethers.getContractAt("CNOVATreasury",       TREAS_ADDR);
  const tierRouter   = await ethers.getContractAt("TierRouter",          TR_ADDR);
  const matA1        = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
  const matB1        = await ethers.getContractAt("FigureEightMatrixV8", T1.matB);
  const pm1          = await ethers.getContractAt("PairManagerV8",       T1.pm);
  const matA2        = T2.matA ? await ethers.getContractAt("FigureEightMatrixV8", T2.matA) : null;
  const matB2        = T2.matB ? await ethers.getContractAt("FigureEightMatrixV8", T2.matB) : null;
  const stabilityFund = SF_ADDR ? await ethers.getContractAt("StabilityFund", SF_ADDR) : null;

  const T1_FEE  = await matA1.ENTRY_FEE();
  const mSize   = await matA1.MATRIX_SIZE();
  const W1_ADDR = process.env.REFERRER || addrs.accountOne || addrs.AccountOne;

  sep(`bigfill_v8.js — ${COUNT} wallets · batch ${BATCH_SIZE} · delay ${BATCH_DELAY}s · offset ${HDR_OFFSET}`);
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  Referrer:   ${W1_ADDR}  (W1 / Account #1)`);
  console.log(`  T1 fee:     ${fmt6(T1_FEE)}`);
  console.log(`  Matrix sz:  ${mSize}  (testnet)`);
  console.log(`  TierRouter: ${addrs.TierRouter}`);
  sep();

  // ── Guard: W1 must be registered ───────────────────────────────────────────
  const w1Check = await tierRouter.memberHighestTier(W1_ADDR);
  if (w1Check === 0n) {
    console.error("  ❌  W1 not registered. Run deploy_v8.js first (step 7/7).");
    process.exit(1);
  }
  console.log(`  ✓ W1 confirmed registered (tier ${w1Check})`);

  // ── Guard: system must not be paused ───────────────────────────────────────
  if (await tierRouter.systemPaused()) {
    console.error("  ❌  TierRouter.systemPaused = true. Cannot register.");
    process.exit(1);
  }

  // ── Generate wallets ───────────────────────────────────────────────────────
  const wallets = makeWallets(COUNT);
  console.log(`  Generated ${wallets.length} test wallets`);
  sep();

  // ── Pre-snapshot ───────────────────────────────────────────────────────────
  await snapshot("PRE-FILL SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── Fund wallets in slices (explicit nonces to avoid collision) ─────────────
  sep("Funding wallets — ETH + USDC");
  const SLICE = 20;
  let ok = 0;

  // Skip already-funded wallets (idempotent: ETH ≥ ETH_PER/2 AND USDC ≥ T1_FEE)
  const walletsToFund = [];
  for (const w of wallets) {
    const ethBal  = await ethers.provider.getBalance(w.address);
    const usdcBal = await usdc.balanceOf(w.address);
    if (ethBal < ETH_PER / 2n || usdcBal < T1_FEE) {
      walletsToFund.push(w);
    }
  }
  console.log(`  Wallets needing funding: ${walletsToFund.length} / ${wallets.length} (${wallets.length - walletsToFund.length} already funded)`);

  // Pre-flight: verify deployer has enough ETH to fund unfunded wallets
  const deployerBal = await ethers.provider.getBalance(deployer.address);
  const ethNeeded   = ETH_PER * BigInt(walletsToFund.length);
  console.log(`  Deployer ETH:   ${ethers.formatEther(deployerBal)}`);
  console.log(`  ETH needed:     ${ethers.formatEther(ethNeeded)}  (${walletsToFund.length} × ${ethers.formatEther(ETH_PER)})`);
  if (deployerBal < ethNeeded) {
    console.error(`  ❌  Deployer has insufficient ETH. Get more from the Base Sepolia faucet.`);
    console.error(`      https://www.alchemy.com/faucets/base-sepolia`);
    process.exit(1);
  }
  console.log(`  ✓ Deployer has enough ETH`);

  for (let i = 0; i < walletsToFund.length; i += SLICE) {
    const slice = walletsToFund.slice(i, i + SLICE);

    // Re-fetch nonce fresh each slice — avoids stale nonce on first wallet
    // "pending" counts in-flight txs so it's always accurate even mid-run
    let nonce = await deployer.provider.getTransactionCount(deployer.address, "pending");

    // ETH — explicit nonce per tx to prevent replacement-underpriced errors
    const ethTxs = await Promise.all(
      slice.map((w, j) =>
        deployer.sendTransaction({ to: w.address, value: ETH_PER, nonce: nonce + j })
      )
    );
    nonce += slice.length;
    await Promise.all(ethTxs.map(tx => tx.wait()));

    // USDC mint — explicit nonce continues from ETH sends
    const usdcTxs = await Promise.all(
      slice.map((w, j) =>
        usdc.mint(w.address, T1_FEE, { nonce: nonce + j })
      )
    );
    await Promise.all(usdcTxs.map(tx => tx.wait()));

    ok += slice.length;

    // Sanity-check: warn any wallet that has far less ETH than expected after funding
    for (const w of slice) {
      const bal = await ethers.provider.getBalance(w.address);
      if (bal < ETH_PER / 2n) {
        console.warn(`  ⚠  Wallet ${w.address.slice(0,10)} only has ${ethers.formatEther(bal)} ETH after funding (expected ~${ethers.formatEther(ETH_PER)})`);
      }
    }

    console.log(`  ✓ Funded ${ok} / ${walletsToFund.length} (${wallets.length} total)`);
  }

  // Give the Base Sepolia RPC time to reflect the funded balances
  // (same eventual-consistency lag that affects view calls on freshly deployed contracts)
  console.log(`  ⏳ Waiting 6s for RPC to catch up with funded balances…`);
  await sleep(6);
  sep();

  // ── Register wallets in batches ────────────────────────────────────────────
  sep("Registering wallets via TierRouter");
  let registered = 0;
  const failures = [];
  const upgradedAt = [];

  const batches = [];
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    batches.push(wallets.slice(i, i + BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchNum = b + 1;

    // Register all wallets in the batch — each wallet signs its own tx
    // (different signers → no nonce collision)
    const results = await Promise.allSettled(
      batch.map(async (wallet) => {
        // Connect wallet to provider
        const connected = wallet.connect(ethers.provider);

        // Skip wallets already registered (idempotent re-runs after partial failures)
        const alreadyJoined = await tierRouter.globalJoined(wallet.address);
        if (alreadyJoined) {
          throw new Error(`wallet ${wallet.address.slice(0,10)} already registered — skip`);
        }

        // Skip wallets with insufficient ETH for gas
        const bal = await ethers.provider.getBalance(wallet.address);
        if (bal < 200_000_000_000n) { // < 0.0002 ETH — not enough for register
          throw new Error(`wallet ${wallet.address.slice(0,10)} has ${ethers.formatEther(bal)} ETH — skipped (need ≥0.0002)`);
        }

        // Approve T1 PairManager to spend USDC — skip if allowance already sufficient
        // (previous runs may have already set the allowance, re-approving wastes gas)
        const allowance = await usdc.allowance(wallet.address, addrs.T1.PairManager);
        if (allowance < T1_FEE) {
          const approveTx = await usdc.connect(connected).approve(addrs.T1.PairManager, T1_FEE);
          await approveTx.wait();
        }

        // Register via TierRouter (routes to active T1 pair).
        // gasLimit is explicit: cycle-out path uses ~1.26M gas but parallel
        // batching means the RPC estimate may be stale (sees occ < MATRIX_SIZE)
        // and return a ~150K estimate.  A cycle-out at the wrong moment would
        // then OOG silently.  3M covers the full cross + distribute path.
        const regTx = await tierRouter.connect(connected).register(W1_ADDR, { gasLimit: 3_000_000 });
        const receipt = await regTx.wait();
        return receipt;
      })
    );

    // Count successes / failures
    for (const r of results) {
      if (r.status === "fulfilled") {
        registered++;
      } else {
        failures.push(r.reason?.message || "unknown");
      }
    }

    // Check if W1 upgraded this batch
    const curTier = await tierRouter.memberHighestTier(W1_ADDR);
    if (curTier >= 2n && upgradedAt.length === 0) {
      upgradedAt.push(registered);
      console.log(`\n  🎉  W1 UPGRADED to T2 after ${registered} registrations!`);
    }

    // Per-batch stats
    const occ1A    = await matA1.occupancy();
    const occ1B    = await matB1.occupancy();
    const sysCyc   = await tierRouter.totalSystemCycles();
    const w1Tier   = await tierRouter.memberHighestTier(W1_ADDR);
    const w1Cyc    = await tierRouter.tierCycles(W1_ADDR, 0);
    const paused   = await tierRouter.systemPaused();

    console.log(
      `  Batch ${String(batchNum).padStart(3)} | ` +
      `reg ${String(registered).padStart(4)}/${COUNT} | ` +
      `T1A ${occ1A}/${mSize}  T1B ${occ1B}/${mSize} | ` +
      `cycles ${sysCyc} | ` +
      `W1→T${w1Tier}(cyc${w1Cyc}) | ` +
      (paused ? "⚠ PAUSED" : "running")
    );

    if (paused) {
      console.log("  ⚠  System paused — stopping registration.");
      break;
    }

    if (b < batches.length - 1) await sleep(BATCH_DELAY);
  }

  // ── Post-registration snapshot ────────────────────────────────────────────
  sep();
  await snapshot("POST-REGISTRATION SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── forceCross phase: push parked MatA alumni into MatB ───────────────────
  // Most wallets park after cycling out of MatA (not enough escrow to self-fund
  // the crossing).  The keeper-bot / admin calls forceCross() to manually fund
  // and execute the crossing.  We do it here to complete the full figure-8 test.
  sep("ForceCross — filling MatB");
  {
    const matBOcc = await matB1.occupancy();
    const matBSize = await matB1.MATRIX_SIZE();
    console.log(`  MatB before forceCross: ${matBOcc} / ${matBSize}`);

    // Build a comprehensive scan list covering ALL wallet offsets ever used.
    // When HDR_OFFSET != 500 (e.g. 1000), new registrations cycle out wallets
    // from the ORIGINAL offset-500 batch — those parked wallets won't appear
    // in the current `wallets` array unless we explicitly scan the old range too.
    const MNEMO_SCAN = "test test test test test test test test test test test junk";
    const scanSet = new Map(); // address → wallet (dedup)
    // Always scan the default offset-500 range (historical batches)
    for (let i = 0; i < 70; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(MNEMO_SCAN, undefined, `m/44'/60'/0'/0/${500 + i}`);
      scanSet.set(w.address, w);
    }
    // Also scan the current batch (may be a different offset)
    for (const w of wallets) scanSet.set(w.address, w);

    // Collect wallets that cycled out of MatA but haven't entered MatB yet
    // hasEverJoined=true in MatA AND isInMatrix=false in MatA AND hasEverJoined=false in MatB
    const parked = [];
    for (const [, w] of scanSet) {
      const mA = await matA1.getMember(w.address);
      if (!mA.hasEverJoined) continue;          // never joined MatA
      if (mA.isInMatrix)     continue;          // still in MatA
      const mB = await matB1.getMember(w.address);
      if (mB.isInMatrix || mB.hasEverJoined) continue; // already in / done MatB
      parked.push(w.address);
    }
    // Also check W1 (not in wallets array)
    const w1mA = await matA1.getMember(W1_ADDR);
    const w1mB = await matB1.getMember(W1_ADDR);
    if (w1mA.hasEverJoined && !w1mA.isInMatrix && !w1mB.hasEverJoined && !w1mB.isInMatrix) {
      parked.unshift(W1_ADDR); // W1 first if parked (should have already crossed but check anyway)
    }

    console.log(`  Parked wallets found: ${parked.length}`);

    // How many more slots does MatB need (include +1 to trigger W1's cycle-out)
    const needed = Number(matBSize) - Number(matBOcc) + 1; // +1 for the cycle-out trigger
    const toCross = parked.slice(0, needed);
    console.log(`  Will forceCross ${toCross.length} (${Number(matBSize) - Number(matBOcc)} to fill + 1 trigger)`);

    if (toCross.length === 0) {
      console.log("  Nothing to forceCross — MatB already handled");
    } else {
      // Mint USDC to deployer for each forceCross if needed
      const usdcNeeded   = T1_FEE * BigInt(toCross.length);
      const deployerUsdc = await usdc.balanceOf(deployer.address);
      if (deployerUsdc < usdcNeeded) {
        const toMint = usdcNeeded - deployerUsdc;
        console.log(`  Minting ${fmt6(toMint)} USDC to deployer for forceCross…`);
        await (await usdc.mint(deployer.address, toMint)).wait();
      }

      let crossed = 0;
      for (const addr of toCross) {
        const occNow = await matB1.occupancy();
        console.log(`  forceCross ${addr.slice(0,10)}… (MatB ${occNow}/${matBSize})`);
        try {
          await (await usdc.approve(await matA1.getAddress(), T1_FEE)).wait();
          const tx = await matA1.forceCross(addr, { gasLimit: 3_000_000 });
          const rc  = await tx.wait();
          crossed++;
          console.log(`    ✓ crossed  gasUsed: ${rc.gasUsed}`);

          // Check upgrade mid-loop
          const curTierFC = await tierRouter.memberHighestTier(W1_ADDR);
          if (curTierFC >= 2n && upgradedAt.length === 0) {
            upgradedAt.push(`forceCross #${crossed}`);
            console.log(`\n  🎉  W1 UPGRADED TO T2 during forceCross!`);
          }
        } catch (e) {
          console.warn(`    ⚠ failed: ${e.reason || e.message?.slice(0,120)}`);
        }
        await sleep(2);
      }
      console.log(`  Done: ${crossed}/${toCross.length} crossed`);
    }

    const finalOccB = await matB1.occupancy();
    console.log(`  MatB after forceCross: ${finalOccB} / ${matBSize}`);
  }
  sep();

  // ── Post-fill snapshot ────────────────────────────────────────────────────
  await snapshot("POST-FILL SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── Summary ────────────────────────────────────────────────────────────────
  sep("SUMMARY");
  console.log(`  Wallets funded:   ${wallets.length}`);
  console.log(`  Registered:       ${registered}`);
  console.log(`  Failures:         ${failures.length}`);
  if (failures.length > 0) {
    failures.slice(0, 5).forEach((e, i) => console.log(`    [${i}] ${e}`));
    if (failures.length > 5) console.log(`    ... and ${failures.length - 5} more`);
  }

  const finalTier  = await tierRouter.memberHighestTier(W1_ADDR);
  const finalCyc   = await tierRouter.totalSystemCycles();

  if (finalTier >= 2n) {
    console.log(`\n  ✅  UPGRADE CONFIRMED — W1 is at T${finalTier}`);
    console.log(`  Total system cycles: ${finalCyc}`);
    const w1mBfinal = await matB1.getMember(W1_ADDR);
    if (w1mBfinal.hasEverJoined) {
      console.log(`  W1 MatB cycles:      ${w1mBfinal.cyclesCompleted}`);
    }
    if (upgradedAt.length > 0) {
      console.log(`  Upgraded at reg:     ${upgradedAt[0]}`);
    }
  } else {
    console.log(`
  ⚠   W1 still at T${finalTier} — more forceCrosses or registrations needed`);
    // Show W1's MatB state to help diagnose
    const w1mbS = await matB1.getMember(W1_ADDR);
    if (w1mbS.hasEverJoined) {
      console.log(`      W1 in MatB: isInMatrix=${w1mbS.isInMatrix}, escrow=$${Number(await matB1.escrowOf(W1_ADDR))/1e6}`);
    }
    const t2fee = await matB1.ENTRY_FEE ? await matB1.ENTRY_FEE() : 25_000_000n;
    console.log(`      T2 fee needed: $${Number(t2fee)/1e6}`);
    console.log(`  Total system cycles: ${finalCyc}`);
  }

  sep();
  console.log("  NEXT STEPS:");
  if (finalTier >= 2n) {
    console.log("    ✅  W1 upgraded to T2 — stress test complete!");
    console.log("    Run with COUNT=200 for full stress test across multiple T1 cycles");
  } else {
    console.log("    1. Re-run — forceCross logic will pick up remaining parked wallets");
    console.log("    2. If W1 not upgrading, check W1 MatB escrow vs T2 fee above");
    if (registered === 0 && failures.length === wallets.length) {
      console.log(`    3. All ${wallets.length} wallets already registered at offset ${HDR_OFFSET}`);
      console.log(`       Try: HDR_OFFSET=${HDR_OFFSET + 500} COUNT=6 npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
    } else {
      console.log("    3. bigfill_v8.js again with COUNT=200 for full stress test");
    }
  }
  sep();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
