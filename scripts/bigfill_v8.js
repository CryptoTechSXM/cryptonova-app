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
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_9.json"
);

// COUNT: for 127-seat matrices, 260 fills MatA + MatB (W1 seeds pos-1, 126 fill
// wallets complete MatA, 126 more fill MatB triggering T2 upgrade) + buffer.
// also trigger a second MatA cycle and confirm W1 auto-upgrades to T2.
//
// V8.9 fresh deploy — start HDR_OFFSET=0 (new contracts, no globalJoined collisions)
// Previous V8.8 runs used HDR_OFFSET=0..3249. V8.9 is a brand-new deploy so 0 is clean.
// Suggested run sequence for V8.9:
//   HDR_OFFSET=0   COUNT=127  → fill T1 MatA → trigger first MatA cycle-out
//   HDR_OFFSET=127 COUNT=127  → fill T1 MatB → trigger MatB cycle → auto-open T2
//   HDR_OFFSET=254 COUNT=200  → drive W1 T2 upgrade + T2 MatA fill
const COUNT       = Number(process.env.COUNT       || 127);
const BATCH_SIZE  = Number(process.env.BATCH_SIZE  || 5);
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 8);
const HDR_OFFSET  = Number(process.env.HDR_OFFSET  || 0); // BIP-44 index offset — fresh V8.9 deploy starts at 0
// WATCH_WALLETS: comma-separated addresses to report after each batch.
// e.g. WATCH_WALLETS=0xAbc...,0xDef... node scripts/bigfill_v8.js
// Always includes W1_ADDR automatically.
const WATCH_WALLETS_RAW = process.env.WATCH_WALLETS || '';
// WATCH_EVERY: print watched wallet status every N batches (default 5, set to 1 for every batch)
const WATCH_EVERY = Number(process.env.WATCH_EVERY || 5);
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

// Generate COUNT deterministic wallets from a private mnemonic.
// IMPORTANT: Do NOT use the public "test junk" mnemonic on Base Sepolia —
// EIP-7702 drainer contracts have been set on those well-known addresses.
// Set FILL_MNEMONIC in .env to a private mnemonic only this project knows.
function makeWallets(count) {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("\n  ❌  FILL_MNEMONIC not set in .env.");
    console.error("     Generate one: node -e \"const {ethers}=require('ethers');console.log(ethers.Wallet.createRandom().mnemonic.phrase)\"");
    console.error("     Then add FILL_MNEMONIC=<phrase> to .env");
    process.exit(1);
  }
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const path = `m/44'/60'/0'/0/${i + HDR_OFFSET}`; // configurable offset — change HDR_OFFSET env var to get fresh addresses
    wallets.push(ethers.HDNodeWallet.fromPhrase(mnemo, undefined, path));
  }
  return wallets;
}

// ── Watched Wallet Reporter ───────────────────────────────────────────────────
// Queries a list of addresses and prints a compact status table.
// Call after batches to track key wallets (W1, test accounts, etc.) during a fill run.
async function reportWatchedWallets(watchList, { tierRouter, matA1, matB1, communityWallet, usdc }) {
  if (watchList.length === 0) return;
  console.log('');
  sep('WATCHED WALLETS');
  const COHORT = ['—', 'Genesis', 'Pioneer'];
  for (const addr of watchList) {
    try {
      const [tier, wdA, wdB, cohortVal, cwBalance] = await Promise.all([
        tierRouter.memberHighestTier(addr).catch(() => 0n),
        matA1.withdrawableOf(addr).catch(() => 0n),
        matB1.withdrawableOf(addr).catch(() => 0n),
        communityWallet ? communityWallet.cohort(addr).catch(() => 0n) : Promise.resolve(0n),
        usdc.balanceOf(addr).catch(() => 0n),
      ]);
      const label = addr.slice(0, 10) + '…';
      const cohortStr = COHORT[Number(cohortVal)] || '—';
      const wdStr = (wdA > 0n || wdB > 0n)
        ? `T1A: ${fmt6(wdA)}  T1B: ${fmt6(wdB)}`
        : 'no withdrawable';
      console.log(
        `  ${label}  T${tier || 0}  ${wdStr.padEnd(30)}  CW: ${cohortStr.padEnd(8)}  USDC: ${fmt6(cwBalance)}`
      );
    } catch (e) {
      console.warn(`  ⚠  watchWallet ${addr.slice(0,10)} query failed: ${e.message.slice(0,60)}`);
    }
  }
  console.log('');
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
  const signers      = await ethers.getSigners();
  const rawSigner    = signers[0];
  // FILL_FUNDER: a fresh wallet (low nonce, no throttle) used for ETH sends only.
  // The main deployer is throttled to 1 in-flight TX at a time on Base Sepolia after
  // accumulating a high nonce count.  Keep deployer for USDC mints (owner-only), use
  // funder for ETH transfers which have no special access requirements.
  const rawFunder    = signers[1] || rawSigner;  // falls back to deployer if no funder key set
  const deployer     = new NonceManager(rawSigner); // forceCross approve + rare owner calls only
  // DO NOT use NonceManager for the funder — it accumulates internal nonce drift on any TX
  // failure, causing "replacement transaction underpriced" cascades for all subsequent sends.
  // Instead we track fNonce explicitly (re-synced from chain after every error).
  const deployerAddr = rawSigner.address;
  const funderAddr   = rawFunder.address;
  if (funderAddr === deployerAddr) {
    console.log(`  ⚠  FILL_FUNDER_KEY not set — using deployer for ETH sends (may hit in-flight limit)`);
  } else {
    console.log(`  Funder:     ${funderAddr}  (ETH + USDC sends — fresh wallet)`);
    // Do NOT auto-topup here — that would burn the deployer's 1 allowed TX slot.
    // Run fund_funder.js once before bigfill to pre-load funder with ETH + bulk USDC.
  }

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
  // usdcFunder: same contract, but signed by the fresh funder wallet.
  // Used for ERC-20 transfer() calls (not mint) — avoids burning deployer's throttled TX slot.
  const usdcFunder   = await ethers.getContractAt("MockUSDC",            USDC_ADDR, rawFunder);

  // Initialize fNonce from the pending nonce so we pick up after any prior partial run.
  // Initialized here (before W1 seed block) so all funder TXs use explicit nonce tracking.
  let fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, "pending"));
  const cnova        = await ethers.getContractAt("CNOVAToken",          CNOVA_ADDR);
  const treasury     = await ethers.getContractAt("CNOVATreasury",       TREAS_ADDR);
  const tierRouter   = await ethers.getContractAt("TierRouter",          TR_ADDR);
  const matA1        = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
  const matB1        = await ethers.getContractAt("FigureEightMatrixV8", T1.matB);
  const pm1          = await ethers.getContractAt("PairManagerV8",       T1.pm);
  const matA2        = T2.matA ? await ethers.getContractAt("FigureEightMatrixV8", T2.matA) : null;
  const matB2        = T2.matB ? await ethers.getContractAt("FigureEightMatrixV8", T2.matB) : null;
  const stabilityFund = SF_ADDR ? await ethers.getContractAt("StabilityFund", SF_ADDR) : null;

  // CommunityWallet for watched-wallet cohort queries (graceful fallback if not in addresses file)
  const CW_ADDR = addrs.communityWallet || addrs.CommunityWallet || null;
  const communityWallet = CW_ADDR ? await ethers.getContractAt("CommunityWallet", CW_ADDR) : null;
  const usdcContract = await ethers.getContractAt("MockUSDC", addrs.usdc || addrs.USDC);

  const T1_FEE  = await matA1.ENTRY_FEE();
  const mSize   = await matA1.MATRIX_SIZE();
  const W1_ADDR = process.env.REFERRER || addrs.accountOne || addrs.AccountOne;

  // Build watched wallet list: always include W1, add any from WATCH_WALLETS env
  const watchAddrs = [W1_ADDR,
    ...WATCH_WALLETS_RAW.split(',').map(a => a.trim()).filter(a => ethers.isAddress(a))
  ].filter((a, i, arr) => a && arr.indexOf(a) === i); // dedupe

  sep(`bigfill_v8.js — ${COUNT} wallets · batch ${BATCH_SIZE} · delay ${BATCH_DELAY}s · offset ${HDR_OFFSET}`);
  console.log(`  Deployer:   ${deployerAddr}`);
  console.log(`  Referrer:   ${W1_ADDR}  (W1 / Account #1)`);
  console.log(`  T1 fee:     ${fmt6(T1_FEE)}`);
  console.log(`  Matrix sz:  ${mSize}  (testnet)`);
  console.log(`  TierRouter: ${addrs.tierRouter || addrs.TierRouter}`);
  console.log(`  Watching:   ${watchAddrs.length} wallet(s) — report every ${WATCH_EVERY} batches`);
  if (watchAddrs.length > 0) watchAddrs.forEach(a => console.log(`              ${a}`));
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
          console.log(`  Sending ETH to W1 from funder (nonce ${fNonce})…`);
          await (await rawFunder.sendTransaction({ to: W1_ADDR, value: ETH_PER, nonce: fNonce })).wait();
          fNonce++;
        }
        // Fund W1 with USDC if needed — use funder.transfer() (not mint) to avoid
        // burning the deployer's rate-limited TX slot.
        const w1Usdc = await usdc.balanceOf(W1_ADDR);
        if (w1Usdc < T1_FEE) {
          console.log(`  Transferring USDC for W1 from funder (nonce ${fNonce})…`);
          await (await usdcFunder.transfer(W1_ADDR, T1_FEE, { nonce: fNonce })).wait();
          fNonce++;
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

  // Pre-flight: verify funder has enough ETH AND USDC to cover all unfunded wallets.
  // Run scripts/fund_funder.js first if either balance is too low.
  const funderBal2   = await ethers.provider.getBalance(funderAddr);
  const funderUsdc2  = await usdc.balanceOf(funderAddr);
  const ethNeeded    = ETH_PER * BigInt(walletsToFund.length);
  const usdcNeeded2  = T1_FEE  * BigInt(walletsToFund.length);
  console.log(`  Deployer ETH:   ${ethers.formatEther(await ethers.provider.getBalance(deployerAddr))}`);
  console.log(`  Funder ETH:     ${ethers.formatEther(funderBal2)}  (need ${ethers.formatEther(ethNeeded)})`);
  console.log(`  Funder USDC:    ${fmt6(funderUsdc2)}  (need ${fmt6(usdcNeeded2)})`);
  if (funderBal2 < ethNeeded) {
    console.error(`  ❌  Funder has insufficient ETH (${ethers.formatEther(funderBal2)} < ${ethers.formatEther(ethNeeded)}).`);
    console.error(`      Run: npx hardhat run scripts/fund_funder.js --network baseSepolia`);
    process.exit(1);
  }
  if (funderUsdc2 < usdcNeeded2) {
    console.error(`  ❌  Funder has insufficient USDC (${fmt6(funderUsdc2)} < ${fmt6(usdcNeeded2)}).`);
    console.error(`      Run: npx hardhat run scripts/fund_funder.js --network baseSepolia`);
    process.exit(1);
  }
  console.log(`  ✓ Funder has enough ETH + USDC`);

  // Re-sync fNonce before the funding loop in case the W1 seed block incremented it.
  fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, "pending"));
  console.log(`  Funder nonce:   ${fNonce} (pending)`);

  const fundingFailed = []; // addresses where ETH send failed (e.g. contract addresses)
  for (let i = 0; i < walletsToFund.length; i += SLICE) {
    const slice = walletsToFund.slice(i, i + SLICE);

    // ETH + USDC — fully sequential, all through NonceManager (deployer).
    // NEVER mix rawSigner and NonceManager for the same deployer address:
    // rawSigner re-fetches pending nonce independently and corrupts NonceManager's
    // cached delta, causing "nonce too low" on the very next NonceManager call.
    for (const w of slice) {
      // ETH send — explicit nonce, no NonceManager drift possible.
      try {
        const tx = await rawFunder.sendTransaction({ to: w.address, value: ETH_PER, nonce: fNonce });
        await tx.wait();
        fNonce++; // only increment after confirmed
      } catch (e) {
        console.warn(`  ⚠  ETH send to ${w.address.slice(0,10)} failed: ${e.shortMessage || e.message.slice(0,80)}`);
        fundingFailed.push(w.address);
        // Re-sync nonce from chain so next wallet uses correct nonce (don't guess)
        fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, "pending"));
      }
      // USDC transfer — explicit nonce override on the contract call.
      // funder holds a pre-minted bulk balance from fund_funder.js (2M USDC).
      try {
        const tx = await usdcFunder.transfer(w.address, T1_FEE, { nonce: fNonce });
        await tx.wait();
        fNonce++; // only increment after confirmed
      } catch (e) {
        console.warn(`  ⚠  USDC transfer to ${w.address.slice(0,10)} failed: ${e.shortMessage || e.message.slice(0,80)}`);
        // Re-sync nonce from chain
        fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, "pending"));
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
  // BUG FIX: retry must re-verify balance — tx.wait() returning ≠ ETH actually landed
  let fundingOk = 0, fundingFail = 0;
  const insufficientEth = new Set(); // wallets that still lack ETH after retry
  for (const w of walletsToFund) {
    const bal = await ethers.provider.getBalance(w.address);
    if (bal < ETH_PER / 2n) {
      console.warn(`  ⚠  ${w.address.slice(0,10)} only has ${ethers.formatEther(bal)} ETH after funding — retrying`);
      // One retry: sequential send — wait longer then VERIFY balance actually updated
      let retried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Use funder (not deployer) — deployer is rate-limited on Base Sepolia
          const tx = await rawFunder.sendTransaction({ to: w.address, value: ETH_PER, nonce: fNonce });
          await tx.wait();
          fNonce++;
          await sleep(20); // give RPC extra time to reflect
          const newBal = await ethers.provider.getBalance(w.address);
          if (newBal >= ETH_PER / 2n) {
            fundingOk++;
            retried = true;
            break;
          }
          console.warn(`     attempt ${attempt+1}: still ${ethers.formatEther(newBal)} ETH — retrying`);
        } catch(e) {
          console.warn(`     attempt ${attempt+1} failed: ${e.message.slice(0,80)}`);
          fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, "pending"));
        }
      }
      if (!retried) {
        console.warn(`     ❌ ${w.address.slice(0,10)} could not be funded after 3 attempts — will skip registration`);
        insufficientEth.add(w.address);
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

        // Skip wallets that failed funding after all retries
        if (insufficientEth.has(wallet.address)) {
          throw new Error(`wallet ${wallet.address.slice(0,10)} had insufficient ETH after all funding attempts — skipped`);
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
        // gasLimit is explicit: at MATRIX_SIZE=127 the DOUBLE cycle-out path
        // (both T1A and T1B simultaneously full) is the limiting case.
        //
        // Gas breakdown per double cycle-out at MSIZE=127:
        //   MatrixA shift loop (cold): 126 × 25k ≈ 3.15M
        //   MatrixA _distributePool (cold, 127 members): 0.64M
        //   MatrixB shift loop (cold): 3.15M
        //   MatrixB _distributePool: 0.64M
        //   Third MatrixA cycle-out (warm slots): ~0.1M
        //   _distributePayments × 2 + ERC20s + TierRouter overhead: ~1.0M
        //   Total: ~8.8M
        //
        // The 63/64 sub-call gas forwarding rule is the actual failure point:
        //   MatrixA consumes ~3.86M → 4.14M remaining → forwards ~4.07M to MatrixB
        //   MatrixB consumes ~3.86M for its cycle-out → ~0.21M left for _distributePayments
        //   _distributePayments needs ~200K → OOGs → revert propagates (no try/catch).
        //
        // At gasLimit=8M, gasUsed=7,571,404 with status=0, logs=[] confirms this.
        // 15M gives MatrixB ~7M forwarded gas, more than enough for the full path.
        const regTx = await tierRouter.connect(connected).register(W1_ADDR, { gasLimit: 15_000_000 });
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

    // Watched wallet report (every WATCH_EVERY batches, always on last batch)
    if (watchAddrs.length > 0 && (batchNum % WATCH_EVERY === 0 || b === batches.length - 1)) {
      await reportWatchedWallets(watchAddrs, { tierRouter, matA1, matB1, communityWallet, usdc: usdcContract });
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
    // IMPORTANT: use FILL_MNEMONIC — the public "test junk" mnemonic wallets
    // are EIP-7702 drained on Base Sepolia and cannot hold ETH/USDC.
    const MNEMO_SCAN = process.env.FILL_MNEMONIC;
    if (!MNEMO_SCAN) {
      console.warn("  ⚠  FILL_MNEMONIC not set — forceCross scan will only cover current batch");
    }
    const scanSet = new Map(); // address → wallet (dedup)
    // Scan all historically used offset ranges so parked wallets from prior runs
    // are picked up even if their HDR_OFFSET differs from the current batch.
    // Keep this list up to date as new HDR_OFFSETs are used.
    const SCAN_OFFSETS = [500, 1000, 1500, 1700, 1800, 2000, 2500, 3000]; // 3000 added June 9 (v8_6 fill)
    if (MNEMO_SCAN) {
      for (const base of SCAN_OFFSETS) {
        for (let i = 0; i < 70; i++) {
          const w = ethers.HDNodeWallet.fromPhrase(MNEMO_SCAN, undefined, `m/44'/60'/0'/0/${base + i}`);
          scanSet.set(w.address, w);
        }
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
      // forceCross is onlyOwner — must be called from deployer (owner).
      // Strategy: transfer USDC funder→deployer, deployer approves matA1, deployer calls forceCross.
      const usdcNeededFC  = T1_FEE * BigInt(toCross.length);
      const funderUsdcBal = await usdc.balanceOf(funderAddr);
      if (funderUsdcBal < usdcNeededFC) {
        console.error(`  ❌  Funder has insufficient USDC for forceCross (${fmt6(funderUsdcBal)} < ${fmt6(usdcNeededFC)}).`);
        console.error(`      Run: npx hardhat run scripts/fund_funder.js --network baseSepolia`);
        process.exit(1);
      }

      // 1. Move USDC funder → deployer so deployer can fund the crossings
      const matA1Addr = await matA1.getAddress();
      console.log(`  Transferring ${fmt6(usdcNeededFC)} USDC: funder → deployer for forceCross (nonce ${fNonce})…`);
      await (await usdcFunder.transfer(deployerAddr, usdcNeededFC, { nonce: fNonce })).wait();
      fNonce++;

      // 2. Deployer approves matA1 — use rawSigner with EXPLICIT nonce (not NonceManager).
      //    The deployer is a "delegated account" on Base Sepolia, rate-limited to 1 in-flight TX.
      //    NonceManager loses internal sync on any RPC rejection and causes a "gapped-nonce tx
      //    from delegated accounts" cascade for all subsequent calls.  Explicit nonce + re-sync
      //    on failure is the same pattern used for fNonce on the funder.
      let dNonce = Number(await ethers.provider.getTransactionCount(deployerAddr, 'pending'));
      console.log(`  Deployer approving matA1 for ${fmt6(usdcNeededFC)} USDC (deployer nonce ${dNonce})…`);
      await (await usdc.connect(rawSigner).approve(matA1Addr, usdcNeededFC, { nonce: dNonce })).wait();
      dNonce++;
      // Wait after the approve — Base Sepolia's "delegated account" rate limiter rejects
      // the very first forceCross if it arrives too soon after the preceding approve TX.
      // The sleep here prevents the first-call failure that otherwise always hits nonce N+1.
      await sleep(8);

      // 3. Connect matA1 to rawSigner (owner) — forceCross is onlyOwner.
      //    rawSigner + explicit dNonce avoids the NonceManager nonce-drift problem.
      const matA1Raw = matA1.connect(rawSigner);

      let crossed = 0;
      for (const addr of toCross) {
        const occNow = await matB1.occupancy();
        console.log(`  forceCross ${addr.slice(0,10)}… (MatB ${occNow}/${matBSize}, nonce ${dNonce})`);
        try {
          await (await matA1Raw.forceCross(addr, { gasLimit: 12_000_000, nonce: dNonce })).wait();
          dNonce++;
          crossed++;
   
          await sleep(6); // pause between crossings — Base Sepolia in-flight limit for delegated accounts
        } catch (e) {
          console.warn(`    ⚠ forceCross failed for ${addr.slice(0,10)}: ${e.message.slice(0,120)}`);
          await sleep(10);
          dNonce = Number(await ethers.provider.getTransactionCount(deployerAddr, 'pending'));
        }
      }

      const matBAfter = await matB1.occupancy();
      console.log(`  MatB after forceCross: ${matBAfter} / ${matBSize}`);
      console.log(`  Crossed ${crossed} / ${toCross.length} wallets`);

    } // end else (forceCross — cycles have happened)
  } // end outer forceCross block

  // ── Post-fill snapshot ────────────────────────────────────────────────────
  sep();
  await snapshot("POST-FILL SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── Watched wallets — final report ────────────────────────────────────────
  if (watchAddrs.length > 0) {
    await reportWatchedWallets(watchAddrs, { tierRouter, matA1, matB1, communityWallet, usdc: usdcContract });
  }

  // ── Next-run hint ─────────────────────────────────────────────────────────
  sep("NEXT RUN HINT");
  const nextOffset = HDR_OFFSET + wallets.length;
  console.log(`    To continue with fresh wallets:`);
  console.log(`    HDR_OFFSET=${nextOffset} COUNT=${COUNT} npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
  if (wallets.filter(w => w._skip).length > 0) {
    console.log(`    (Some wallets were skipped — check logs above)`);
  }
  if (wallets.length === wallets.filter((_, i) => i < wallets.length).length) {
    console.log(`    3. All ${wallets.length} wallets already registered at offset ${HDR_OFFSET}`);
    console.log(`       Try: HDR_OFFSET=${nextOffset} COUNT=6 npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
  }
  sep();
}
}


main().catch(e => {
  console.error('\n  ❌  bigfill_v8.js fatal error:', e);
  process.exit(1);
});
