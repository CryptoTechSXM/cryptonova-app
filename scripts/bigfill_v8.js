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
 *   BURN_SIMULATE=false  skip the earlyUnlockAll() burn sweep (default = true/on)
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
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_17.json"
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
const WATCH_EVERY  = Number(process.env.WATCH_EVERY  || 5);
// RESCUE_SCAN: max parked slots to inspect per inline rescue pass (0 = all)
// RESCUE_CAP:  max members to rescue per pass (0 = all)
// RESCUE_ALL:  when true (default), loop rescue passes until SF is dry or queue is empty.
//              This simulates the keeper running at full capacity — "real life" mode.
//              Set RESCUE_ALL=false to revert to the old single-pass capped behaviour.
const RESCUE_SCAN  = Number(process.env.RESCUE_SCAN  || 0);  // 0 = no limit
const RESCUE_CAP   = Number(process.env.RESCUE_CAP   || 0);  // 0 = no limit
const RESCUE_ALL   = (process.env.RESCUE_ALL ?? "true") !== "false";
const ETH_PER      = ethers.parseEther("0.02");   // gas budget per wallet — 0.02 ETH covers approve + register even at 10+ gwei on Base Sepolia
// UPGRADE_RATE: fraction of T1-MatB-eligible wallets to manually upgrade each batch (0–1).
// 0.75 = 75% of eligible wallets self-upgrade.  Set to 0 to disable.
const UPGRADE_RATE = Number(process.env.UPGRADE_RATE ?? "0.75");

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

// ── Burn Sweep — simulate organic early-unlock sell pressure ─────────────────
// After each matrix cycle, wallets that earned CNOVA (cliff-vested) call
// earlyUnlockAll(). The contract deducts a sliding penalty (up to 50% at max)
// which is burned (penaltyDestination=0) or sent to the buyback fund — either
// way it strengthens the floor.  Released tokens are now freely transferable.
// Set BURN_SIMULATE=false in .env to skip this step.
async function burnSweep(walletList, cnova) {
  if (process.env.BURN_SIMULATE === "false") return;

  sep("Early Unlock Sweep — simulating member sell pressure");
  let swept = 0, skipped = 0;
  let totalPenalty = 0n;

  for (const w of walletList) {
    try {
      // Only proceed if wallet has locked CNOVA to unlock
      const locked = await cnova.lockedBalanceOf(w.address);
      if (locked === 0n) { skipped++; continue; }

      // Wallet needs ETH for gas
      const ethBal = await ethers.provider.getBalance(w.address);
      if (ethBal < 500_000_000_000n) { skipped++; continue; } // < 0.0005 ETH

      const connected = w.connect(ethers.provider);
      const supplyBefore = await cnova.totalSupply();
      await (await cnova.connect(connected).earlyUnlockAll({ gasLimit: 500_000 })).wait();
      const supplyAfter = await cnova.totalSupply();

      // Supply drop = tokens burned as penalty
      const burned = supplyBefore > supplyAfter ? supplyBefore - supplyAfter : 0n;
      totalPenalty += burned;
      swept++;
    } catch {
      skipped++; // wallet had no vest batches or failed — silent skip
    }
  }

  const totalBurnedOnChain = await cnova.totalBurned().catch(() => 0n);
  console.log(`  Swept: ${swept} wallets unlocked | ${skipped} skipped (no vest batches)`);
  console.log(`  Penalty burned this sweep:  ${ethers.formatEther(totalPenalty)} CNOVA`);
  console.log(`  Contract totalBurned:       ${ethers.formatEther(totalBurnedOnChain)} CNOVA`);
}

// ── Withdraw sweep — simulate members cashing out earned USDC ───────────────
// Called on every matrix cycle. Sweeps all wallets for withdrawable USDC in
// MatA and MatB and calls withdraw() — simulates organic selling pressure /
// members realising gains as the matrix cycles.
async function withdrawSweep(walletList, matA1, matB1) {
  let swept = 0;
  let totalWithdrawn = 0n;
  for (const w of walletList) {
    try {
      const conn    = w.connect(ethers.provider);
      const ethBal  = await ethers.provider.getBalance(w.address);
      if (ethBal < 500_000_000_000n) continue; // need ETH for gas
      // Withdraw from MatA if earned
      const mA = await matA1.getMember(w.address);
      if (mA.hasEverJoined && mA.withdrawable > 0n) {
        await (await matA1.connect(conn).withdraw({ gasLimit: 300_000 })).wait();
        totalWithdrawn += mA.withdrawable;
        swept++;
      }
      // Withdraw from MatB if earned
      const mB = await matB1.getMember(w.address);
      if (mB.hasEverJoined && mB.withdrawable > 0n) {
        await (await matB1.connect(conn).withdraw({ gasLimit: 300_000 })).wait();
        totalWithdrawn += mB.withdrawable;
        swept++;
      }
    } catch {
      // wallet had no withdrawable or failed — silent skip
    }
  }
  console.log(`  Withdraw sweep: ${swept} withdrawals | ${fmt6(totalWithdrawn)} USDC total`);
}

// ── Inline parked-wallet rescue ───────────────────────────────────────────────
// Called after every registration batch. Scans up to RESCUE_SCAN parked members,
// rescues up to RESCUE_CAP using the sliding-scale SF contribution (V8.13).
// Uses SF balance only — no deployer top-up. Silent no-op when nothing to rescue.
const _WORK_PARKED_RESCUE = 4;
const _GAS_RESCUE_NORMAL   = 800_000;
const _GAS_RESCUE_OVERFLOW = 15_000_000;
const _rescueCoder = ethers.AbiCoder.defaultAbiCoder();

// ── Give-up list: wallets skipped GIVE_UP_AFTER times are permanently abandoned ──
// Prevents 28-line skip blocks every batch for wallets that can never be rescued.
const GIVE_UP_AFTER = 3;          // consecutive skips before giving up
const _skipCount    = new Map();  // addr (lc) → skip count this run
const _giveUpSet    = new Set();  // addrs permanently abandoned

function _sfRescueBpsInline(withdrawable, fee) {
  const wBps = withdrawable * 10000n / fee;
  if (wBps >= 10000n) return    0n;
  if (wBps >=  9500n) return 1000n;
  if (wBps >=  9000n) return 1500n;
  if (wBps >=  8500n) return 2000n;
  if (wBps >=  8000n) return 2500n;
  if (wBps >=  7500n) return 3000n;
  if (wBps >=  7000n) return 3500n;
  if (wBps >=  6500n) return 4000n;
  if (wBps >=  6000n) return 4500n;
  if (wBps >=  5000n) return 5000n;
  if (wBps >=  4000n) return 6000n;  // 40–49% → SF covers 60% (script-side; contract needs V8.18 patch)
  return null; // < 40% withdrawable — not keeper-eligible
}

// _inlineRescuePass: one scan-and-rescue sweep over the parked queue.
// Returns the number of wallets rescued this pass (0 = done / SF dry).
async function _inlineRescuePass({ matA1, matB1, stabilityFund, matrixKeeper, rawDeployer, entryFee, scanLimit, capLimit }) {
  const parkedCount = await matA1.getParkedCount().catch(() => 0n);
  if (parkedCount === 0n) return 0;

  const sfBal = await stabilityFund.balanceByTier(0).catch(() => 0n);
  const minSfShare = entryFee * 1000n / 10000n; // 10% of fee = lowest sliding-scale tier
  if (sfBal < minSfShare) return 0;

  const matA1Addr = await matA1.getAddress();
  const matBSize  = await matB1.MATRIX_SIZE();
  let   matBOcc   = await matB1.occupancy();

  // Scan up to scanLimit parked members (0 = all)
  const scanCount = (scanLimit === 0)
    ? Number(parkedCount)
    : Math.min(Number(parkedCount), scanLimit);
  const eligible  = [];
  const seen      = new Set();
  const capActive = capLimit > 0;

  for (let i = 0; i < scanCount; i++) {
    if (capActive && eligible.length >= capLimit) break;
    const addr = await matA1.getParkedMember(i).catch(() => null);
    if (!addr || addr === ethers.ZeroAddress) continue;
    const addrLc = addr.toLowerCase();
    if (seen.has(addrLc)) continue;
    seen.add(addrLc);

    // Skip wallets permanently abandoned due to repeated un-rescuable shortfall
    if (_giveUpSet.has(addrLc)) continue;

    // Skip stale slots — member already crossed to MatB
    let inMatB = false;
    try { const m = await matB1.getMember(addr); inMatB = m.isInMatrix; } catch {}
    if (inMatB) continue;

    const withdrawable = await matA1.withdrawableOf(addr).catch(() => 0n);
    const bps = _sfRescueBpsInline(withdrawable, entryFee);
    if (bps === null) {
      // < 40% withdrawable — track and give up after GIVE_UP_AFTER skips
      const cnt = (_skipCount.get(addrLc) || 0) + 1;
      _skipCount.set(addrLc, cnt);
      if (cnt >= GIVE_UP_AFTER) {
        _giveUpSet.add(addrLc); // silent from now on
      } else {
        const shortfall = entryFee - withdrawable;
        process.stdout.write(`  🏥 skip ${addr.slice(0,10)} (only ${fmt6(withdrawable)}, shortfall ${fmt6(shortfall)} > 60%)\n`);
      }
      continue;
    }

    const sfShare = entryFee * bps / 10000n;
    eligible.push({ addr, sfShare, withdrawable });
  }

  if (eligible.length === 0) return 0;

  // Cap to what SF can currently cover
  const toRescue = [];
  let sfRunning = sfBal;
  for (const e of eligible) {
    if (sfRunning < e.sfShare) break;
    sfRunning -= e.sfShare;
    toRescue.push(e);
  }
  if (toRescue.length === 0) return 0;

  process.stdout.write(`  🏥 Parked rescue: ${parkedCount} queued → rescuing ${toRescue.length} (SF ${fmt6(sfBal)})… `);
  let rescued = 0;

  // Use rawDeployer + explicit nonce to avoid the NonceManager "gapped-nonce tx from
  // delegated accounts" cascade. Base Sepolia limits high-nonce wallets to 1 in-flight TX.
  // On any failure the NonceManager loses sync; explicit nonce + re-sync-on-error is safe.
  const mkRaw = matrixKeeper.connect(rawDeployer);
  let dNonce = Number(await rawDeployer.provider.getTransactionCount(rawDeployer.address, 'pending'));

  for (const { addr, withdrawable } of toRescue) {
    const item = [{ workType: _WORK_PARKED_RESCUE, tierIndex: 0, addr1: matA1Addr, addr2: addr }];
    const performData = _rescueCoder.encode(
      ['tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]'],
      [item]
    );
    const gasLimit = (matBOcc >= matBSize) ? _GAS_RESCUE_OVERFLOW : _GAS_RESCUE_NORMAL;
    try {
      const tx = await mkRaw.performUpkeep(performData, { gasLimit, nonce: dNonce });
      const receipt = await tx.wait();
      if (receipt.status === 1) {
        rescued++;
        dNonce++;
        if (gasLimit !== _GAS_RESCUE_OVERFLOW) matBOcc++;
      } else {
        console.warn(`  ⚠  rescue ${addr.slice(0,10)} tx status=0 (gasUsed ${receipt.gasUsed})`);
        // Re-sync nonce — the failed TX may have consumed the nonce slot
        dNonce = Number(await rawDeployer.provider.getTransactionCount(rawDeployer.address, 'pending'));
      }
    } catch (err) {
      const msg = err.shortMessage || err.message?.slice(0, 100) || 'unknown';
      console.warn(`  ⚠  rescue ${addr.slice(0,10)} failed: ${msg}`);
      // Re-sync nonce after any RPC rejection — NonceManager would have incremented
      // its counter on the failed call; rawDeployer does not but we resync to be safe.
      dNonce = Number(await rawDeployer.provider.getTransactionCount(rawDeployer.address, 'pending'));
    }
    // Respect Base Sepolia's 1-in-flight limit for delegated accounts: wait 6s between rescues
    await new Promise(r => setTimeout(r, (gasLimit === _GAS_RESCUE_OVERFLOW) ? 2000 : 6000));
  }
  console.log(`${rescued}/${toRescue.length} rescued ✅`);
  if (_giveUpSet.size > 0) {
    console.log(`  🏥 Give-up list: ${_giveUpSet.size} wallet(s) abandoned (shortfall always >60% — not rescuable)`);
  }
  return rescued;
}

// inlineRescueParked: outer driver.
// In RESCUE_ALL mode (default = real-life simulation): loops rescue passes until
// the parked queue is empty or SF is exhausted — same behaviour as the keeper bot
// running continuously between fills.
// In legacy mode (RESCUE_ALL=false): single pass capped at RESCUE_SCAN / RESCUE_CAP.
async function inlineRescueParked({ matA1, matB1, stabilityFund, matrixKeeper, rawDeployer, deployer, entryFee }) {
  if (!stabilityFund || !matrixKeeper) return;

  if (!RESCUE_ALL) {
    // Legacy single-pass mode
    await _inlineRescuePass({ matA1, matB1, stabilityFund, matrixKeeper, rawDeployer, entryFee,
                               scanLimit: RESCUE_SCAN, capLimit: RESCUE_CAP });
    return;
  }

  // Real-life exhaustive mode: keep rescuing until queue is empty or SF dry.
  // Each pass may trigger a MatB cascade that frees slots for the next pass.
  let totalRescued = 0;
  let passNo = 0;
  while (true) {
    passNo++;

    // Ghost-loop guard: read parked count BEFORE the pass.
    // MatrixKeeper.performUpkeep wraps everything in try/catch — if a wallet is already
    // active, the inner call reverts silently and the TX returns status=1 with no state
    // change. This means `rescued > 0` can be true even when nothing actually happened.
    // Comparing parked count before/after detects this and exits cleanly.
    const parkedBefore = Number(await matA1.getParkedCount().catch(() => 0n));
    if (parkedBefore === 0) break; // truly empty — fast exit without a full pass

    const rescued = await _inlineRescuePass({
      matA1, matB1, stabilityFund, matrixKeeper, rawDeployer, entryFee,
      scanLimit: 0,   // scan all parked
      capLimit:  0,   // rescue all eligible
    });
    totalRescued += rescued;
    if (rescued === 0) break; // SF dry or no eligible wallets

    // Check whether the parked count actually decreased.
    // If it didn't, performUpkeep is no-oping on ghost entries → break to avoid infinite loop.
    const parkedAfter = Number(await matA1.getParkedCount().catch(() => 0n));
    if (parkedAfter >= parkedBefore) {
      console.log(`  🏥 Ghost-loop guard: parked count unchanged (${parkedBefore}→${parkedAfter}) — breaking`);
      break;
    }

    // Short pause between passes to let Base Sepolia process the previous batch of TXs
    await new Promise(r => setTimeout(r, 2000));
  }
  if (totalRescued > 0) {
    console.log(`  🏥 Total rescued this batch: ${totalRescued} wallet(s) across ${passNo - 1} pass(es)`);
  }
}

// ── Manual upgrade simulation (V8.18, self-funded + multi-tier as of V8.19) ──
// After each batch, finds wallets currently sitting in a tier's MatB (upgrade-
// eligible) that haven't yet entered the next tier up. Eligibility requires
// the member to ALREADY hold the next tier's fee in their OWN wallet —
// simulating a real member who deliberately keeps extra USDC on hand (e.g.
// $100 total in the wallet at registration: $10 signup + $25 reserved for T2
// + enough left to also self-upgrade T2→T3) rather than depending on matrix
// withdrawable earnings.
// The funder tops up ETH for gas only (gas is an operational/testnet concern,
// not part of the economic simulation) — it NEVER tops up the USDC upgrade fee.
// A wallet that wasn't pre-funded with enough reserve (FUND_AMOUNT, see funding
// loop above) simply isn't eligible and is silently excluded — it is NOT
// charity-funded into eligibility.
// Of the wallets that ARE self-funded-eligible, UPGRADE_RATE% are randomly
// selected to actually submit the upgrade this batch (simulates members not
// all clicking "upgrade" the instant they qualify).
// Generic across tier hops — call once per hop (T1 MatB→T2, T2 MatB→T3, …).
// Returns the updated fNonce so the caller can keep its state consistent.
async function simulateManualUpgrades({
  walletList, tierRouter, fromMatB, toMatA, usdc, usdcFunder, rawFunder,
  funderAddr, fNonce, tierRouterAddr, fee, targetTierIndex, tierLabel,
}) {
  if (UPGRADE_RATE <= 0) return fNonce;
  if (!fromMatB || !toMatA) return fNonce;   // this tier hop not deployed yet
  if (fee === 0n) return fNonce;

  // Find eligible wallets: in the source tier's MatB, NOT already in the
  // target tier's MatA, AND already holding the target tier's fee in their
  // own wallet (self-funded — no funder top-up, ever).
  const eligible = [];
  let notSelfFunded = 0;
  for (const w of walletList) {
    try {
      const [inMatB, inTargetA] = await Promise.all([
        fromMatB.isActiveInMatrix(w.address).catch(() => false),
        toMatA.isActiveInMatrix(w.address).catch(() => false),
      ]);
      if (!inMatB)    continue;     // not yet in source tier's MatB — skip
      if (inTargetA)  continue;     // already in target tier's MatA — skip

      const ownUsdc = await usdc.balanceOf(w.address).catch(() => 0n);
      if (ownUsdc < fee) { notSelfFunded++; continue; } // can't self-upgrade — not eligible

      eligible.push(w);
    } catch { /* skip on RPC error */ }
  }

  if (eligible.length === 0) {
    if (notSelfFunded > 0) {
      console.log(`  Manual upgrade → ${tierLabel}: 0 eligible (${notSelfFunded} in prior MatB but lack own-wallet ${tierLabel} fee — not self-funded)`);
    }
    return fNonce;
  }

  // Randomly select UPGRADE_RATE fraction
  const shuffled = eligible.sort(() => Math.random() - 0.5);
  const toUpgrade = shuffled.slice(0, Math.max(1, Math.round(shuffled.length * UPGRADE_RATE)));

  sep(`Manual Upgrade Simulation → ${tierLabel} — ${eligible.length} self-funded eligible (+${notSelfFunded} lacking own funds) → upgrading ${toUpgrade.length} (${Math.round(UPGRADE_RATE * 100)}%)`);
  let upgraded = 0, skipped = 0;

  for (const w of toUpgrade) {
    try {
      const conn = w.connect(ethers.provider);

      // Fund wallet with ETH if needed — gas only. The tier fee itself is
      // NEVER funded here; eligibility above already guaranteed the member
      // holds it from their own wallet.
      const ethBal = await ethers.provider.getBalance(w.address);
      if (ethBal < 200_000_000_000n) {
        // Re-sync immediately before use, not just trust the value threaded in
        // from the caller — other funder-wallet operations elsewhere in this
        // same batch (registration funding, forceCross USDC transfers) can
        // advance the on-chain nonce in between, leaving fNonce stale here.
        // This mirrors the re-sync-before-use pattern used everywhere else
        // in this file (see the catch block right below, and the funding/
        // forceCross loops).
        fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, 'pending'));
        const tx = await rawFunder.sendTransaction({ to: w.address, value: ethers.parseEther("0.02"), nonce: fNonce });
        await tx.wait();
        fNonce++;
      }

      // Approve TierRouter to spend the target tier's fee
      const allowance = await usdc.allowance(w.address, tierRouterAddr);
      if (allowance < fee) {
        await (await usdc.connect(conn).approve(tierRouterAddr, fee)).wait();
      }

      await (await tierRouter.connect(conn).manualUpgrade(targetTierIndex, { gasLimit: 15_000_000 })).wait();
      console.log(`  ✓ manualUpgrade ${tierLabel}  ${w.address.slice(0, 10)}…`);
      upgraded++;
    } catch (e) {
      const msg = e.shortMessage || e.message?.slice(0, 100) || 'unknown';
      // "TR: cross to MatB first" = not eligible yet — quiet skip
      if (!msg.includes("cross to MatB")) {
        console.warn(`  ⚠ upgrade ${w.address.slice(0, 10)}… failed: ${msg}`);
      }
      skipped++;
      try { fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, 'pending')); } catch {}
    }
    await new Promise(r => setTimeout(r, 3000)); // 3s between upgrades — avoid in-flight limit
  }

  if (upgraded > 0 || skipped > 0) {
    const occ = await toMatA.occupancy().catch(() => 0n);
    console.log(`  Upgrades: ${upgraded} succeeded, ${skipped} skipped | ${tierLabel} MatA occ: ${occ}`);
  }
  return fNonce;
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
        console.log(`  W1 T2 member ID:     ${w1T2.id}  (join order in T2 MatA)`);
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
  const T1          = addrs.tiers?.T1   || { matA: addrs.T1?.matA || addrs.T1?.MatrixA,  matB: addrs.T1?.matB || addrs.T1?.MatrixB,  pm: addrs.T1?.pm || addrs.T1?.PairManager };
  const T2          = addrs.tiers?.T2   || { matA: addrs.T2?.matA || addrs.T2?.MatrixA,  matB: addrs.T2?.matB || addrs.T2?.MatrixB,  pm: addrs.T2?.pm || addrs.T2?.PairManager };
  const T3          = addrs.tiers?.T3   || { matA: addrs.T3?.matA || addrs.T3?.MatrixA,  matB: addrs.T3?.matB || addrs.T3?.MatrixB,  pm: addrs.T3?.pm || addrs.T3?.PairManager };

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
  const matA3        = T3.matA ? await ethers.getContractAt("FigureEightMatrixV8", T3.matA) : null;
  const matB3        = T3.matB ? await ethers.getContractAt("FigureEightMatrixV8", T3.matB) : null;
  const stabilityFund = SF_ADDR ? await ethers.getContractAt("StabilityFund", SF_ADDR) : null;
  const MK_ADDR    = addrs.matrixKeeper || addrs.MatrixKeeper || null;
  const matrixKeeper = MK_ADDR ? await ethers.getContractAt("MatrixKeeper", MK_ADDR, deployer) : null;

  // CommunityWallet for watched-wallet cohort queries (graceful fallback if not in addresses file)
  const CW_ADDR = addrs.communityWallet || addrs.CommunityWallet || null;
  const communityWallet = CW_ADDR ? await ethers.getContractAt("CommunityWallet", CW_ADDR) : null;
  const usdcContract = await ethers.getContractAt("MockUSDC", addrs.usdc || addrs.USDC);

  const T1_FEE  = await matA1.ENTRY_FEE();
  const T2_FEE  = matA2 ? await matA2.ENTRY_FEE().catch(() => 0n) : 0n;
  const T3_FEE  = matA3 ? await matA3.ENTRY_FEE().catch(() => 0n) : 0n;
  // V8.19: members are pre-funded well past the signup fee — a real member who
  // wants to self-upgrade at every crossing deliberately keeps a cash reserve
  // in their wallet (your example: $100 total = $10 signup + $25 for T2 + the
  // rest earmarked for T3, instead of relying on matrix withdrawable earnings).
  // Default reserve is a flat $100 USDC (covers T1+T2+T3 = $85 with headroom);
  // override with FUND_AMOUNT_USDC env var if tiers/fees change. Manual upgrade
  // never tops anyone up from the funder — see simulateManualUpgrades().
  const TIER_FEE_SUM = T1_FEE + T2_FEE + T3_FEE;
  const FUND_AMOUNT  = process.env.FUND_AMOUNT_USDC
    ? ethers.parseUnits(process.env.FUND_AMOUNT_USDC, 6)
    : ethers.parseUnits("100", 6);
  if (FUND_AMOUNT < TIER_FEE_SUM) {
    console.log(`  ⚠  FUND_AMOUNT (${fmt6(FUND_AMOUNT)}) is less than T1+T2+T3 fees (${fmt6(TIER_FEE_SUM)}) — some wallets won't be able to self-fund all the way to T3.`);
  }
  const mSize   = await matA1.MATRIX_SIZE();
  const W1_ADDR = process.env.REFERRER || addrs.accountOne || addrs.AccountOne;

  // Build watched wallet list: always include W1, add any from WATCH_WALLETS env
  const watchAddrs = [W1_ADDR,
    ...WATCH_WALLETS_RAW.split(',').map(a => a.trim()).filter(a => ethers.isAddress(a))
  ].filter((a, i, arr) => a && arr.indexOf(a) === i); // dedupe

  sep(`bigfill_v8.js — ${COUNT} wallets · batch ${BATCH_SIZE} · delay ${BATCH_DELAY}s · offset ${HDR_OFFSET}`);
  console.log(`  Deployer:   ${deployerAddr}`);
  console.log(`  Referrer:   ${W1_ADDR}  (W1 / Account #1)`);
  console.log(`  T1 fee:     ${fmt6(T1_FEE)}  (T2: ${fmt6(T2_FEE)}  T3: ${fmt6(T3_FEE)})`);
  console.log(`  Wallet reserve: ${fmt6(FUND_AMOUNT)} per member at registration (self-funds T1 signup + up to T2/T3 upgrades)`);
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

  // Skip already-funded wallets (idempotent: ETH ≥ ETH_PER/2 AND USDC ≥ FUND_AMOUNT)
  const walletsToFund = [];
  for (const w of wallets) {
    const ethBal  = await ethers.provider.getBalance(w.address);
    const usdcBal = await usdc.balanceOf(w.address);
    if (ethBal < ETH_PER / 2n || usdcBal < FUND_AMOUNT) {
      walletsToFund.push(w);
    }
  }
  console.log(`  Wallets needing funding: ${walletsToFund.length} / ${wallets.length} (${wallets.length - walletsToFund.length} already funded)`);

  // Pre-flight: verify funder has enough ETH AND USDC to cover all unfunded wallets.
  // Run scripts/fund_funder.js first if either balance is too low.
  const funderBal2   = await ethers.provider.getBalance(funderAddr);
  const funderUsdc2  = await usdc.balanceOf(funderAddr);
  const ethNeeded    = ETH_PER     * BigInt(walletsToFund.length);
  const usdcNeeded2  = FUND_AMOUNT * BigInt(walletsToFund.length);
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
      // V8.19: send T1 fee + T2 reserve up front (FUND_AMOUNT) so the member's
      // own wallet already holds enough to self-upgrade later — no funder
      // top-up at upgrade time.
      try {
        const tx = await usdcFunder.transfer(w.address, FUND_AMOUNT, { nonce: fNonce });
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
  let skippedAlready = 0;  // wallets already registered from a prior run — not failures
  const failures = [];
  const upgradedAt = [];
  let prevSysCyc    = await tierRouter.totalSystemCycles(); // track cycle changes for burn sweep
  let forceFCCheck  = false; // set true on cycle detection to trigger immediate forceCross

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

        // Skip wallets already registered (idempotent re-runs after partial failures).
        // Use a special sentinel so the outer loop can count these separately from
        // genuine failures — seeing "all wallets already registered" means wrong HDR_OFFSET.
        const alreadyJoined = await tierRouter.globalJoined(wallet.address);
        if (alreadyJoined) {
          throw Object.assign(new Error(`wallet ${wallet.address.slice(0,10)} already registered — skip`), { _alreadyJoined: true });
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
        const err = r.reason;
        if (err?._alreadyJoined) {
          skippedAlready++;  // prior-run wallet — not a real failure
        } else {
          const msg = err?.shortMessage || err?.message || "unknown";
          failures.push(msg);
          // Print the actual revert reason so we can diagnose mainnet issues
          // (e.g. "already in matrix", "velocity gate", "OOG", etc.)
          if (msg && !msg.includes("insufficient ETH") && !msg.includes("skip")) {
            console.warn(`    ⚠ reg fail: ${msg.slice(0, 120)}`);
          }
        }
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

    const skipStr = skippedAlready > 0 ? ` skip(dup)=${skippedAlready}` : '';
    const failStr = failures.length  > 0 ? ` fail=${failures.length}` : '';
    console.log(
      `  Batch ${String(batchNum).padStart(3)} | ` +
      `reg ${String(registered).padStart(4)}/${COUNT}${skipStr}${failStr} | ` +
      `T1A ${occ1A}/${mSize}  T1B ${occ1B}/${mSize} | ` +
      `cycles ${sysCyc} | ` +
      `W1→T${w1Tier}(cyc${w1Cyc}) | ` +
      (paused ? "⚠ PAUSED" : "running")
    );

    if (paused) {
      console.log("  ⚠  System paused — stopping registration.");
      break;
    }

    // Burn + withdraw sweep + force forceCross — runs on every new matrix cycle
    if (sysCyc > prevSysCyc) {
      console.log(`\n  🔄 Cycle detected (${prevSysCyc} → ${sysCyc})`);
      console.log(`  ↳ Running early-unlock burn sweep…`);
      await burnSweep(wallets, cnova);
      console.log(`  ↳ Running withdraw sweep (simulate sell)…`);
      await withdrawSweep(wallets, matA1, matB1);
      forceFCCheck = true; // execute forceCross this batch regardless of batchNum
      prevSysCyc = sysCyc;
    }

    // Inline parked rescue — after every batch, rescue any eligible parked members
    await inlineRescueParked({ matA1, matB1, stabilityFund, matrixKeeper, rawDeployer: rawSigner, deployer: rawSigner, entryFee: T1_FEE });

    // V8.19: Manual upgrade simulation — UPGRADE_RATE% of eligible, self-funded
    // wallets upgrade each hop. Run T1→T2 first, then T2→T3 — a wallet can
    // chain both in the same batch if it's already crossed T1 MatB AND holds
    // enough of its own USDC reserve to cover both fees.
    fNonce = await simulateManualUpgrades({
      walletList: wallets, tierRouter, fromMatB: matB1, toMatA: matA2,
      usdc, usdcFunder, rawFunder,
      funderAddr, fNonce,
      tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
      fee: T2_FEE, targetTierIndex: 1, tierLabel: "T2",
    });
    fNonce = await simulateManualUpgrades({
      walletList: wallets, tierRouter, fromMatB: matB2, toMatA: matA3,
      usdc, usdcFunder, rawFunder,
      funderAddr, fNonce,
      tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
      fee: T3_FEE, targetTierIndex: 2, tierLabel: "T3",
    });

    // Inline forceCross check — every 10 batches OR immediately after a cycle
    if (batchNum % 10 === 0 || forceFCCheck) {
      forceFCCheck = false; // reset — consumed
      console.log(`\n  🔍 [forceCross check @ reg ${registered}/${COUNT}]`);
      const _fcRot  = await matA1.rotationCount();
      const _fcAOcc = await matA1.occupancy();
      const _fcASz  = await matA1.MATRIX_SIZE();
      if (_fcRot === 0n && _fcAOcc < _fcASz) {
        console.log(`  ↳ MatA ${_fcAOcc}/${_fcASz}, rotationCount=0 — nothing to cross yet`);
      } else {
        // Scan current batch wallets + W1 for parked members
        const _parked = [];
        for (const _w of wallets) {
          const _mA = await matA1.getMember(_w.address);
          if (!_mA.hasEverJoined || _mA.isInMatrix) continue;
          const _mB = await matB1.getMember(_w.address);
          if (_mB.isInMatrix || _mB.hasEverJoined) continue;
          _parked.push(_w.address);
        }
        const _w1mA = await matA1.getMember(W1_ADDR);
        const _w1mB = await matB1.getMember(W1_ADDR);
        if (_w1mA.hasEverJoined && !_w1mA.isInMatrix && !_w1mB.hasEverJoined && !_w1mB.isInMatrix) {
          _parked.unshift(W1_ADDR);
        }
        console.log(`  ↳ Parked wallets found: ${_parked.length}`);
        if (_parked.length > 0) {
          const _matBOcc  = await matB1.occupancy();
          const _matBSz   = await matB1.MATRIX_SIZE();
          const _needed   = Number(_matBSz) - Number(_matBOcc) + 1;
          const _toCross  = _parked.slice(0, _needed);
          console.log(`  ↳ MatB ${_matBOcc}/${_matBSz} — crossing ${_toCross.length} wallets`);
          const _usdcNeed  = T1_FEE * BigInt(_toCross.length);
          const _matA1Addr = await matA1.getAddress();
          // Re-sync funder nonce to avoid drift from registration txs
          fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, 'pending'));
          console.log(`  ↳ Transferring ${fmt6(_usdcNeed)} USDC funder→deployer (fNonce ${fNonce})…`);
          await (await usdcFunder.transfer(deployerAddr, _usdcNeed, { nonce: fNonce })).wait();
          fNonce++;
          await sleep(8);
          let _dN = Number(await ethers.provider.getTransactionCount(deployerAddr, 'pending'));
          console.log(`  ↳ Deployer approving matA1 (dNonce ${_dN})…`);
          await (await usdc.connect(rawSigner).approve(_matA1Addr, _usdcNeed, { nonce: _dN })).wait();
          _dN++;
          await sleep(8);
          const _matA1Raw = matA1.connect(rawSigner);
          for (const _addr of _toCross) {
            try {
              const _tx = await _matA1Raw.forceCross(_addr, { nonce: _dN, gasLimit: 15_000_000 });
              await _tx.wait();
              _dN++;
              console.log(`  ↳ ✓ forceCross(${_addr.slice(0,10)}…)`);
            } catch (_e) {
              console.warn(`  ↳ ⚠ forceCross(${_addr.slice(0,10)}…) failed: ${_e.shortMessage || _e.message.slice(0,80)}`);
              _dN = Number(await ethers.provider.getTransactionCount(deployerAddr, 'pending'));
            }
          }
        }
      }
    }

    // Withdraw sweep every 10 batches — simulate ongoing sell pressure
    if (batchNum % 10 === 0) {
      await withdrawSweep(wallets, matA1, matB1);
    }

    // Watched wallet report (every WATCH_EVERY batches, always on last batch)
    if (watchAddrs.length > 0 && (batchNum % WATCH_EVERY === 0 || b === batches.length - 1)) {
      await reportWatchedWallets(watchAddrs, { tierRouter, matA1, matB1, communityWallet, usdc: usdcContract });
    }

    if (b < batches.length - 1) await sleep(BATCH_DELAY);
  }

  // ── Registration summary ──────────────────────────────────────────────────
  sep("Registration summary");
  console.log(`  Registered:       ${registered} / ${COUNT}`);
  if (skippedAlready > 0) {
    console.log(`  Already joined:   ${skippedAlready}  ← wrong HDR_OFFSET, not real failures`);
  }
  if (failures.length > 0) {
    console.log(`  Genuine failures: ${failures.length}`);
  }

  // ── Post-registration snapshot ────────────────────────────────────────────
  sep();
  await snapshot("POST-REGISTRATION SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── Final burn sweep — catch any remaining vest batches ───────────────────
  sep("Final Burn Sweep");
  console.log("  Running earlyUnlockAll() on all wallets with remaining vest batches…");
  await burnSweep(wallets, cnova);

  // ── forceCross phase: push parked MatA alumni into MatB ───────────────────
  // Most wallets park after cycling out of MatA (not enough escrow to self-fund
  // the crossing).  The keeper-bot / admin calls forceCross() to manually fund
  // and execute the crossing.  We do it here to complete the full figure-8 test.
  //
  // Set SKIP_ADMIN_CROSS=1 to run in SF-only rescue mode (no deployer-funded forceCross).
  // Useful for testing how many wallets the SF can handle without admin intervention.
  sep("ForceCross — filling MatB");
  if (process.env.SKIP_ADMIN_CROSS) {
    console.log(`  SKIP_ADMIN_CROSS=1 — SF-only rescue mode. Admin forceCross disabled.`);
    console.log(`  Any remaining parked wallets below the SF floor will stay parked.`);
    console.log(`  Run push_parked.js with FORCE_ADMIN=1 afterward to manually handle them.`);
  } else {
    // Guard: only run forceCross after at least one MatA rotation has completed.
    // Use matA1.rotationCount() — this increments on every _cycleOutRoot().
    // NOTE: tierRouter.totalSystemCycles() counts T1→T2 upgrades (0 until MatB cycles),
    //       NOT MatA rotations — using it as the guard skips forceCross incorrectly.
    const _fcRotCount = await matA1.rotationCount();
    const _fcMatBOcc  = await matB1.occupancy();
    const _fcMatAOcc  = await matA1.occupancy();
    const _fcMatASize = await matA1.MATRIX_SIZE();
    // Only skip forceCross if MatA is NOT yet full — once MatA is at capacity
    // (even with rotationCount=0) we must run forceCross to push alumni to MatB.
    if (_fcRotCount === 0n && _fcMatAOcc < _fcMatASize) {
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
    // V8.12 fill used offsets 0,50,100,150,200,250,300,350… add here as new HDR_OFFSETs are used.
    // Old SCAN_OFFSETS (500+) were for a different mnemonic era — kept for safety but unused in V8.12.
    const SCAN_OFFSETS = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600,
                          1000, 1500, 1700, 1800, 2000, 2500, 3000]; // extended June 13 V8.12
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

      // 1. Move USDC funder → deployer so deployer can fund the crossings.
      //    Re-fetch fNonce here — it may have drifted during inline rescue attempts
      //    which also use the funder wallet (performUpkeep calls).
      fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, 'pending'));
      const matA1Addr = await matA1.getAddress();
      console.log(`  Transferring ${fmt6(usdcNeededFC)} USDC: funder → deployer for forceCross (nonce ${fNonce})…`);
      await (await usdcFunder.transfer(deployerAddr, usdcNeededFC, { nonce: fNonce })).wait();
      fNonce++;

      // 2. Deployer approves matA1 — use rawSigner with EXPLICIT nonce (not NonceManager).
      //    The deployer is a "delegated account" on Base Sepolia, rate-limited to 1 in-flight TX.
      //    NonceManager loses internal sync on any RPC rejection and causes a "gapped-nonce tx
      //    from delegated accounts" cascade for all subsequent calls.  Explicit nonce + re-sync
      //    on failure is the same pattern used for fNonce on the funder.
      // Extra wait: the registration phase blasts 50+ txs from the deployer. Even after the
      // 90s post-fund sleep those may still be in-flight. Give the RPC another 60s to drain
      // before starting the approve → forceCross sequence.
      console.log(`  ⏳ Waiting 60s for deployer in-flight queue to drain before forceCross…`);
      await sleep(60);
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

    } // end else (toCross.length === 0)
    } // end else (forceCross — cycles have happened)
  } // end else (SKIP_ADMIN_CROSS not set)

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
  if (skippedAlready === wallets.length) {
    console.log(`  ⚠  ALL ${wallets.length} wallets at HDR_OFFSET=${HDR_OFFSET} were already registered on a prior run.`);
    console.log(`     This is why reg showed 0/${COUNT} — NOT a payment or cascade bug.`);
    console.log(`     Use the next offset to get fresh wallets:`);
    console.log(`     HDR_OFFSET=${nextOffset} COUNT=${COUNT} npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
  } else {
    console.log(`  To continue with fresh wallets:`);
    console.log(`  HDR_OFFSET=${nextOffset} COUNT=${COUNT} npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
    if (skippedAlready > 0) {
      console.log(`  (${skippedAlready} wallets were already registered from a prior run — use HDR_OFFSET=${nextOffset} to avoid)`);
    }
    if (failures.length > 0) {
      console.log(`  (${failures.length} genuine registration failures — check ⚠ lines above for revert reasons)`);
    }
  }
  sep();
}


main().catch(e => {
  console.error('\n  ❌  bigfill_v8.js fatal error:', e);
  process.exit(1);
});
