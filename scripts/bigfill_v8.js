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
const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
// ADDRESSES_FILE: point to whichever deployment you want to stress-test.
//   v8_1 = size-15 testnet (retired)
//   v8_2 = size-64 pre-mainnet  ← default
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_6.json"
);

// COUNT: for 127-seat matrices, 260 fills MatA + MatB (W1 seeds pos-1, 126 fill
// wallets complete MatA, 126 more fill MatB triggering T2 upgrade) + buffer.
// also trigger a second MatA cycle and confirm W1 auto-upgrades to T2.
const COUNT       = Number(process.env.COUNT       || 260);
const BATCH_SIZE  = Number(process.env.BATCH_SIZE  || 5);
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 8);
const HDR_OFFSET  = Number(process.env.HDR_OFFSET  || 500); // BIP-44 index offset (change to avoid globalJoined collisions)
const ETH_PER     = ethers.parseEther("0.02");   // gas budget per wallet — 0.02 ETH covers approve + register even at 10+ gwei on Base Sepolia

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
  console.log(`  W1 highest tier:     T${w1Tier}  ${w1Tier === 0n ? "(not yet registered as matrix member)" : ""}`);
  console.log(`  W1 T1 cycles:        ${w1Cycles}`);
  console.log(`  Total system cycles: ${totalCyc}`);
  console.log(`  System paused:       ${paused}`);

  // T2 state — always shown so we can detect auto-upgrades even when W1 isn't the
  // member that upgraded (W1 = accountOne fee-recipient; it's only tracked if it
  // was explicitly registered as position-1 seed before the fill started)
  if (matA2) {
    try {
      const occ2A = await matA2.occupancy();
      const fee2  = await matA2.ENTRY_FEE();
      console.log(`  T2 MatA occupancy:   ${occ2A} / ${mSize}`);
      if (matB2) {
        const occ2B = await matB2.occupancy();
        console.log(`  T2 MatB occupancy:   ${occ2B} / ${mSize}`);
      }
      console.log(`  T2 entry fee:        ${fmt6(fee2)}`);
    } catch {}
  }

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

  const treasuryBal  = await cnova.balanceOf(await treasury.getAddress());
  const totalSupply  = await cnova.totalSupply();
  try {
    const usdcAddr = await matA1.usdc();
    const usdcR    = await ethers.getContractAt("MockUSDC", usdcAddr);
    const tUsdc    = await usdcR.balanceOf(await treasury.getAddress());
    console.log(`  Treasury USDC:       ${fmt6(tUsdc)}`);
  } catch {}
  console.log(`  CNOVA minted:        ${ethers.formatEther(totalSupply)}`);
  console.log(`  Treasury CNOVA:      ${ethers.formatEther(treasuryBal)} (via buybacks only — 0 is normal)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n  ❌  ${ADDRESSES_FILE} not found. Run deploy_v8.js first.`);
    process.exit(1);
  }

  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [rawSigner]  = await ethers.getSigners();
  const deployer     = new NonceManager(rawSigner); // avoids nonce collisions in parallel batch sends
  const deployerAddr = rawSigner.address;           // NonceManager doesn't expose .address

  // ── Load contracts ──────────────────────────────────────────────────────────
  // V8.1 address file uses lowercase keys and tiers nested object
  const USDC_ADDR   = addrs.usdc        || addrs.USDC;
  const CNOVA_ADDR  = addrs.cnova       || addrs.CNOVAToken;
  const TREAS_ADDR  = addrs.treasury    || addrs.CNOVATreasury;
  const TR_ADDR     = addrs.tierRouter  || addrs.TierRouter;
  const SF_ADDR     = addrs.stabilityFund;
  const T1          = addrs.tiers?.T1   || { matA: addrs.T1?.MatrixA,  matB: addrs.T1?.MatrixB,  pm: addrs.T1?.PairManager };
  const T2          = addrs.tiers?.T2   || { matA: addrs.T2?.MatrixA,  matB: addrs.T2?.MatrixB,  pm: addrs.T2?.PairManager };

  const usdc         = await ethers.getContractAt("MockUSDC",            USDC_ADDR, deployer);
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
  console.log(`  Deployer:   ${deployerAddr}`);
  console.log(`  Referrer:   ${W1_ADDR}  (W1 / Account #1)`);
  console.log(`  T1 fee:     ${fmt6(T1_FEE)}`);
  console.log(`  Matrix sz:  ${mSize}  (testnet)`);
  console.log(`  TierRouter: ${addrs.tierRouter || addrs.TierRouter}`);
  sep();

  // ── W1 status (informational — referrer need not be registered) ───────────
  {
    const w1Tier = await tierRouter.memberHighestTier(W1_ADDR);
    if (w1Tier === 0n) {
      console.log(`  ℹ  W1 not yet registered — referrer resolves to address(0), OK`);
    } else {
      console.log(`  ✓ W1 confirmed registered (tier ${w1Tier})`);
    }
  }

  // ── Guard: system must not be paused ───────────────────────────────────────
  if (await tierRouter.systemPaused()) {
    console.error("  ❌  TierRouter.systemPaused = true. Cannot register.");
    process.exit(1);
  }

  // ── Seed W1 as position-1 root (idempotent) ───────────────────────────────
  // W1_ADDR is accountOne — a passive fee-recipient in the deploy JSON.  For the
  // T1→T2 upgrade to be VISIBLE in this script we need W1 to actually be in the
  // matrix at position-1 (root) so its escrow accumulates with each new entrant.
  // Skip silently if W1 is already globalJoined (idempotent re-runs).
  sep("Seeding W1 as T1 MatA root");
  {
    const w1Joined = await tierRouter.globalJoined(W1_ADDR);
    if (w1Joined) {
      const t = await tierRouter.memberHighestTier(W1_ADDR);
      console.log(`  ✓ W1 already registered (tier ${t}) — skip seed`);
    } else {
      // W1 needs a private key to sign transactions. If SEED_W1_KEY is set use
      // that signer; otherwise fund + register via deployer using enterFor-style
      // call.  Most straightforward: deployer calls register on W1's behalf
      // through a seedForMember helper — but TierRouter.register requires
      // msg.sender to be the member.  Instead we fund W1 and it signs itself.
      const w1Key = process.env.SEED_W1_KEY;
      if (!w1Key) {
        console.log(`  ⚠  SEED_W1_KEY not set — W1 cannot self-register.`);
        console.log(`     Set SEED_W1_KEY=<private-key-of-${W1_ADDR.slice(0,10)}> to enable.`);
        console.log(`     W1 upgrade tracking will not work this run.`);
      } else {
        const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);
        // Fund W1 with ETH if needed
        const w1Eth = await ethers.provider.getBalance(W1_ADDR);
        if (w1Eth < ETH_PER / 2n) {
          console.log(`  Sending ETH to W1…`);
          await (await deployer.sendTransaction({ to: W1_ADDR, value: ETH_PER })).wait();
        }
        // Fund W1 with USDC if needed
        const w1Usdc = await usdc.balanceOf(W1_ADDR);
        if (w1Usdc < T1_FEE) {
          console.log(`  Minting USDC for W1…`);
          await (await usdc.mint(W1_ADDR, T1_FEE)).wait();
        }
        // Approve + register
        const allowance = await usdc.allowance(W1_ADDR, T1.pm);
        if (allowance < T1_FEE) {
          console.log(`  W1 approving T1 PM…`);
          await (await usdc.connect(w1Wallet).approve(T1.pm, T1_FEE)).wait();
        }
        console.log(`  W1 registering…`);
        await (await tierRouter.connect(w1Wallet).register(ethers.ZeroAddress, { gasLimit: 8_000_000 })).wait();
        console.log(`  ✓ W1 registered as T1 MatA seed (position-1 root)`);
      }
    }
  }
  sep();

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
  const deployerBal = await ethers.provider.getBalance(deployerAddr);
  const ethNeeded   = ETH_PER * BigInt(walletsToFund.length);
  console.log(`  Deployer ETH:   ${ethers.formatEther(deployerBal)}`);
  console.log(`  ETH needed:     ${ethers.formatEther(ethNeeded)}  (${walletsToFund.length} × ${ethers.formatEther(ETH_PER)})`);
  if (deployerBal < ethNeeded) {
    console.error(`  ❌  Deployer has insufficient ETH. Get more from the Base Sepolia faucet.`);
    console.error(`      https://www.alchemy.com/faucets/base-sepolia`);
    process.exit(1);
  }
  console.log(`  ✓ Deployer has enough ETH`);

  const fundingFailed = []; // addresses where ETH send failed (e.g. contract addresses)
  for (let i = 0; i < walletsToFund.length; i += SLICE) {
    const slice = walletsToFund.slice(i, i + SLICE);

    // ETH + USDC — fully sequential, all through NonceManager (deployer).
    // NEVER mix rawSigner and NonceManager for the same deployer address:
    // rawSigner re-fetches pending nonce independently and corrupts NonceManager's
    // cached delta, causing "nonce too low" on the very next NonceManager call.
    for (const w of slice) {
      // ETH send
      try {
        const tx = await deployer.sendTransaction({ to: w.address, value: ETH_PER });
        await tx.wait();
      } catch (e) {
        console.warn(`  ⚠  ETH send to ${w.address.slice(0,10)} failed: ${e.shortMessage || e.message.slice(0,80)}`);
        fundingFailed.push(w.address);
      }
      // USDC mint (sequential — same NonceManager keeps delta correct)
      try {
        const tx = await usdc.mint(w.address, T1_FEE);
        await tx.wait();
      } catch (e) {
        console.warn(`  ⚠  USDC mint to ${w.address.slice(0,10)} failed: ${e.shortMessage || e.message.slice(0,80)}`);
      }
    }

    ok += slice.length;

    console.log(`  ✓ Funded ${ok} / ${walletsToFund.length} (${wallets.length} total)`);
  }

  // Give the Base Sepolia RPC time to reflect the funded balances.
  // publicnode sometimes lags 30-60s on balance queries even after confirmation.
  // 113/300 wallets showed 0 ETH at 30s on June 8 run — increased to 90s.
  console.log(`  ⏳ Waiting 90s for RPC to catch up with funded balances…`);
  await sleep(90);

  // Post-sleep verification: check all funded wallets actually have ETH
  let fundingOk = 0, fundingFail = 0;
  for (const w of walletsToFund) {
    const bal = await ethers.provider.getBalance(w.address);
    if (bal < ETH_PER / 2n) {
      console.warn(`  ⚠  ${w.address.slice(0,10)} only has ${ethers.formatEther(bal)} ETH after funding — retrying`);
      // One retry: sequential send
      try {
        const tx = await deployer.sendTransaction({ to: w.address, value: ETH_PER });
        await tx.wait();
        await sleep(8);
        fundingOk++;
      } catch(e) {
        console.warn(`     retry failed: ${e.message.slice(0,80)}`);
        fundingFail++;
      }
    } else {
      fundingOk++;
    }
  }
  console.log(`  Post-sleep check: ${fundingOk} funded OK, ${fundingFail} still failed`);
  if (fundingFailed.length > 0) {
    console.log(`  Unfundable addresses (contract collision): ${fundingFailed.map(a => a.slice(0,10)).join(", ")}`);
  }
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

        // Skip wallets with insufficient ETH for gas.
        // Base Sepolia RPC (publicnode) is load-balanced; a lagging node may return
        // 0 for a wallet whose funding tx confirmed seconds ago.  Retry once with a
        // short sleep before giving up so parallel batches don't discard funded wallets.
        let bal = await ethers.provider.getBalance(wallet.address);
        if (bal < 200_000_000_000n) {
          await new Promise(r => setTimeout(r, 10_000)); // 10s retry for RPC lag
          bal = await ethers.provider.getBalance(wallet.address);
        }
        if (bal < 200_000_000_000n) { // < 0.0002 ETH — not enough for register
          throw new Error(`wallet ${wallet.address.slice(0,10)} has ${ethers.formatEther(bal)} ETH — skipped (need ≥0.0002)`);
        }

        // Approve T1 PairManager to spend USDC — skip if allowance already sufficient
        // (previous runs may have already set the allowance, re-approving wastes gas)
        const allowance = await usdc.allowance(wallet.address, T1.pm);
        if (allowance < T1_FEE) {
          const approveTx = await usdc.connect(connected).approve(T1.pm, T1_FEE);
          await approveTx.wait();
        }

        // Register via TierRouter (routes to active T1 pair).
        // gasLimit is explicit: at MATRIX_SIZE=64 the cycle-out path distributes
        // pool shares to 63 members.  32 of those (BFS leaf level, positions 33-64)
        // have zero-valued withdrawable/totalEarned/lastActivityTime slots, each
        // costing 20k gas (zero→nonzero SSTORE).  32×3×20k ≈ 1.92M gas for
        // _distributePool alone, plus ~0.9M for the position-shift loop.
        // 3M was too tight (OOG mid-loop, reason:null).  6M gives ample headroom.
        const regTx = await tierRouter.connect(connected).register(W1_ADDR, { gasLimit: 8_000_000 });
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
    // Guard: only run forceCross after at least one MatA rotation has completed.
    // Use matA1.rotationCount() — this increments on every _cycleOutRoot().
    // NOTE: tierRouter.totalSystemCycles() counts T1→T2 upgrades (0 until MatB cycles),
    //       NOT MatA rotations — using it as the guard skips forceCross incorrectly.
    const _fcRotCount = await matA1.rotationCount();
    const _fcMatBOcc  = await matB1.occupancy();
    const _fcMatAOcc  = await matA1.occupancy();
    if (_fcRotCount === 0n && _fcMatAOcc > 0n) {
      console.log(`  MatA at ${_fcMatAOcc}/${mSize}, rotationCount=0 — no cycle yet, skipping forceCross`);
    } else {
    const matBOcc = await matB1.occupancy();
    const matBSize = await matB1.MATRIX_SIZE();
    console.log(`  MatB before forceCross: ${matBOcc} / ${matBSize}`);

    // Build a comprehensive scan list covering ALL wallet offsets ever used.
    // When HDR_OFFSET != 500 (e.g. 1000), new registrations cycle out wallets
    // from the ORIGINAL offset-500 batch — those parked wallets won't appear
    // in the current `wallets` array unless we explicitly scan the old range too.
    const MNEMO_SCAN = "test test test test test test test test test test test junk";
    const scanSet = new Map(); // address → wallet (dedup)
    // Scan all historically used offset ranges so parked wallets from prior runs
    // are picked up even if their HDR_OFFSET differs from the current batch.
    // Add new offsets here as runs accumulate (e.g. 2500, 3000 after more fills).
    const SCAN_OFFSETS = [500, 1000, 1500, 1700, 1800, 2000, 2500]; // 1800 added June 8 (v8_4 run 2)
    for (const base of SCAN_OFFSETS) {
      for (let i = 0; i < 70; i++) {
        const w = ethers.HDNodeWallet.fromPhrase(MNEMO_SCAN, undefined, `m/44'/60'/0'/0/${base + i}`);
        scanSet.set(w.address, w);
      }
    }
    // Also scan the current batch in case HDR_OFFSET isn't in the static list above
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
      const deployerUsdc = await usdc.balanceOf(deployerAddr);
      if (deployerUsdc < usdcNeeded) {
        const toMint = usdcNeeded - deployerUsdc;
        console.log(`  Minting ${fmt6(toMint)} USDC to deployer for forceCross…`);
        await (await usdc.mint(deployerAddr, toMint)).wait();
      }

      // Reset NonceManager before approve — after 40+ registration batches the cached
      // nonce delta can lag behind the chain state, causing "nonce too low" on the approve.
      // reset() forces a fresh eth_getTransactionCount on the next send.
      deployer.reset();
      await sleep(2);

      // Single bulk approve — avoids per-iteration approve+forceCross double-tx nonce collision
      await (await usdc.approve(await matA1.getAddress(), usdcNeeded)).wait();

      let crossed = 0;
      for (const addr of toCross) {
        const occNow = await matB1.occupancy();
        console.log(`  forceCross ${addr.slice(0,10)}… (MatB ${occNow}/${matBSize})`);
        try {
          await (await matA1.forceCross(addr, { gasLimit: 12_000_000 })).wait();
          crossed++;
        } catch (e) {
          console.warn(`    ⚠ forceCross failed for ${addr.slice(0,10)}: ${e.message.slice(0,100)}`);
          // Nonce too low means the NonceManager cached a stale nonce — reset it so
          // the next call fetches the current on-chain nonce fresh from the RPC.
          if (e.message.includes("nonce too low") || e.message.includes("nonce has already been used")) {
            deployer.reset();
            await sleep(3);
          }
        }
      }

      const matBAfter = await matB1.occupancy();
      console.log(`  MatB after forceCross: ${matBAfter} / ${matBSize}`);
      console.log(`  Crossed: ${crossed} / ${toCross.length}`);
    } // end if toCross.length > 0

    } // end else (forceCross — cycles have happened)
  } // end outer forceCross block

  // ── Post-fill snapshot ────────────────────────────────────────────────────
  sep();
  await snapshot("POST-FILL SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── Summary ───────────────────────────────────────────────────────────────
  sep("SUMMARY");
  console.log(`  Wallets funded:   ${wallets.length}`);
  console.log(`  Registered:       ${registered}`);
  console.log(`  Failures:         ${failures.length}`);
  const showN = Math.min(failures.length, 5);
  for (let i = 0; i < showN; i++) console.log(`    [${i}] ${failures[i]}`);
  if (failures.length > showN) console.log(`    ... and ${failures.length - showN} more`);

  const finalTier = await tierRouter.memberHighestTier(W1_ADDR);
  if (finalTier >= 2n) {
    console.log(`\n  ✅  W1 (${W1_ADDR.slice(0,10)}) upgraded to T${finalTier}!`);
  } else {
    console.log(`\n  ⚠   W1 (${W1_ADDR.slice(0,10)}) still at T${finalTier}`);
    console.log(`      W1 = accountOne fee-recipient — it only upgrades if it was`);
    console.log(`      pre-registered as position-1 seed before the fill started.`);
    const matA2occ = await matA2.occupancy();
    const t2fee    = await matA2.ENTRY_FEE();
    console.log(`      Check T2 MatA occupancy above to see if OTHER roots upgraded.`);
    console.log(`      T2 entry fee: $${Number(t2fee)/1e6}  |  T2 MatA occ: ${matA2occ}/64`);
  }

  console.log("");
  sep();
  console.log("  NEXT STEPS:");
  console.log("    1. Re-run — forceCross logic will pick up remaining parked wallets");
  console.log("    2. If W1 not upgrading, check W1 MatB escrow vs T2 fee above");
  if (registered === 0 && failures.length === wallets.length) {
    console.log(`    3. All ${wallets.length} wallets already registered at offset ${HDR_OFFSET}`);
    console.log(`       Try: HDR_OFFSET=${HDR_OFFSET + 500} COUNT=6 npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
  } else {
    console.log("    3. bigfill_v8.js again with COUNT=200 for full stress test");
  }
  sep();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
