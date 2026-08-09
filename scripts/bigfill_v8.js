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
 *   5. Self-rescue simulation — parked members pay own shortfall (SELF_RESCUE_RATE %)
 *   6. Final snapshot: treasury balance, CNOVA minted, TierRouter state
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
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"
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
// SCAN_FROM: BIP-44 start index for the historical wallet scan used by rescue/upgrade.
// Set to 0 to cover ALL wallets ever registered (default). If you started fresh at
// a higher offset (e.g. HDR_OFFSET=500) and want to skip truly old wallets, raise this.
const SCAN_FROM   = Number(process.env.SCAN_FROM   ?? "0");
const BATCH_SIZE  = Number(process.env.BATCH_SIZE  || 5);
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 8);
const HDR_OFFSET  = Number(process.env.HDR_OFFSET  || 0); // BIP-44 index offset — fresh V8.9 deploy starts at 0
// WATCH_WALLETS: comma-separated addresses to report after each batch.
// e.g. WATCH_WALLETS=0xAbc...,0xDef... node scripts/bigfill_v8.js
// Always includes W1_ADDR automatically.
const WATCH_WALLETS_RAW = process.env.WATCH_WALLETS || '';
// WATCH_EVERY: print watched wallet status every N batches (default 5, set to 1 for every batch)
const WATCH_EVERY  = Number(process.env.WATCH_EVERY  || 5);
// CNOVA_BUY_RATE: fraction of registered wallets that buy CNOVA each cycle (0–1).
// e.g. 0.25 = 25% of wallets buy CNOVA when a system cycle fires. Set to 0 to disable.
const CNOVA_BUY_RATE = Number(process.env.CNOVA_BUY_RATE ?? "0.25");
// CNOVA_BUY_MIN / CNOVA_BUY_MAX: random USDC spend range per wallet (6 decimals).
const CNOVA_BUY_MIN  = Number(process.env.CNOVA_BUY_MIN  || 2_000_000);  // $2
const CNOVA_BUY_MAX  = Number(process.env.CNOVA_BUY_MAX  || 8_000_000);  // $8
// CNOVA_SELL_RATE: fraction of wallets that earlyUnlock (burn/sell) CNOVA each cycle.
const CNOVA_SELL_RATE = Number(process.env.CNOVA_SELL_RATE ?? "0.15");  // 15% sell each cycle
const ETH_PER      = ethers.parseEther("0.02");   // gas budget per wallet — 0.02 ETH covers approve + register even at 10+ gwei on Base Sepolia
// UPGRADE_RATE: fraction of T1-MatB-eligible wallets to manually upgrade each batch (0–1).
// 0.75 = 75% of eligible wallets self-upgrade.  Set to 0 to disable.  Set to 1 for 100%.
const UPGRADE_RATE = Number(process.env.UPGRADE_RATE ?? "0.75");
// SELF_RESCUE_RATE: fraction of parked test wallets that immediately pay their own
// shortfall via selfRescue() (0–1). The rest wait for the VPS keeper's coPayRescue.
// 0.5 = 50% self-rescue, 50% take the SF loan. Set to 0 to disable.
const SELF_RESCUE_RATE  = Number(process.env.SELF_RESCUE_RATE ?? "0.5");
// RESCUE_APPROVAL: max USDC approved per wallet to the matrix contract for selfRescue.
// The contract only pulls what it needs; $15 covers any T1 shortfall with headroom.
const RESCUE_APPROVAL   = BigInt(process.env.RESCUE_APPROVAL ?? "15000000"); // $15 USDC
// TEMP 2026-08-08: RESCUE_DEBUG=1 prints the per-wallet approval decision.
const RESCUE_DEBUG      = process.env.RESCUE_DEBUG === "1";
// RESCUE_SCAN_EVERY: also run rescue scan every N batches (always runs on cycle detect).
const RESCUE_SCAN_EVERY = Number(process.env.RESCUE_SCAN_EVERY ?? "5");

// ROUND_ROBIN: comma-separated list of pre-registered addresses to rotate as referrer.
// If set, wallet[i] uses ROUND_ROBIN[i % len] as its sponsor instead of W1.
// All addresses must already be registered or bigfill will abort.
// Example: ROUND_ROBIN=0xABCD...,0x1234...,0x5678...
const ROUND_ROBIN_RAW   = process.env.ROUND_ROBIN || "";
const ROUND_ROBIN_ADDRS = ROUND_ROBIN_RAW
  ? ROUND_ROBIN_RAW.split(",").map(a => a.trim()).filter(a => ethers.isAddress(a))
  : [];

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
function makeWallets(count, startOffset) {
  if (startOffset === undefined) startOffset = HDR_OFFSET;
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("\n  ❌  FILL_MNEMONIC not set in .env.");
    console.error("     Generate one: node -e \"const {ethers}=require('ethers');console.log(ethers.Wallet.createRandom().mnemonic.phrase)\"");
    console.error("     Then add FILL_MNEMONIC=<phrase> to .env");
    process.exit(1);
  }
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const path = `m/44'/60'/0'/0/${i + startOffset}`; // startOffset = HDR_OFFSET for new wallets, SCAN_FROM for historical
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
// Called on every matrix cycle. Sweeps all wallets for withdrawable USDC across
// ALL discovered matrix pairs (T1.1, T1.2, T2, T3 …) — simulates organic
// selling pressure / members realising gains as the matrix cycles.
// V8.36: accepts matrices array (not two separate contracts) so factory-spawned
// pairs like T1.2 are covered automatically.
async function withdrawSweep(walletList, matrices) {
  let swept = 0;
  let totalWithdrawn = 0n;
  for (const w of walletList) {
    try {
      const conn   = w.connect(ethers.provider);
      const ethBal = await ethers.provider.getBalance(w.address);
      if (ethBal < 500_000_000_000n) continue; // need ETH for gas
      for (const { matrix } of matrices) {
        try {
          const mData = await matrix.getMember(w.address);
          if (mData.hasEverJoined && mData.withdrawable > 0n) {
            await (await matrix.connect(conn).withdraw({ gasLimit: 300_000 })).wait();
            totalWithdrawn += mData.withdrawable;
            swept++;
          }
        } catch { /* no earnings in this matrix — skip */ }
      }
    } catch {
      // wallet query failed — silent skip
    }
  }
  console.log(`  Withdraw sweep: ${swept} withdrawals | ${fmt6(totalWithdrawn)} USDC total`);
}

// ── CNOVA buy sweep — simulate members purchasing CNOVA via DirectSale ────────
// Runs on every system cycle. A random CNOVA_BUY_RATE fraction of registered
// wallets each spend a random $CNOVA_BUY_MIN–$CNOVA_BUY_MAX of their USDC on CNOVA.
// Rescue is fully delegated to the keeper (direct_keeper.js / MatrixKeeper.performUpkeep).
async function cnovaBuySweep(walletList, directSale, usdc) {
  if (!directSale || CNOVA_BUY_RATE <= 0) return;
  const dsAddr = await directSale.getAddress();

  // Randomly sample CNOVA_BUY_RATE of registered wallets
  const candidates = walletList.filter(() => Math.random() < CNOVA_BUY_RATE);
  if (candidates.length === 0) { console.log(`  💰 CNOVA buy sweep: no wallets selected this cycle`); return; }

  let bought = 0, skipped = 0;
  let totalUsdcSpent = 0n, totalCnovaReceived = 0n;

  for (const w of candidates) {
    try {
      const ethBal = await ethers.provider.getBalance(w.address);
      if (ethBal < 500_000_000_000n) { skipped++; continue; } // need ETH for gas

      // Random spend: $CNOVA_BUY_MIN to $CNOVA_BUY_MAX
      const range  = CNOVA_BUY_MAX - CNOVA_BUY_MIN;
      const spend  = BigInt(CNOVA_BUY_MIN + Math.floor(Math.random() * range));
      const usdcBal = await usdc.balanceOf(w.address);
      const RESERVE = 5_000_000n; // keep $5 USDC reserve — don't drain wallet
      if (usdcBal < spend + RESERVE) { skipped++; continue; }

      const conn = w.connect(ethers.provider);
      // Approve exact spend (directSale pulls exact amount)
      await (await usdc.connect(conn).approve(dsAddr, spend, { gasLimit: 80_000 })).wait();
      const tx = await directSale.connect(conn).buyCNOVA(spend, { gasLimit: 300_000 });
      const receipt = await tx.wait();
      if (receipt.status === 1) {
        // Parse CNOVAPurchased event for actual CNOVA received
        const iface = directSale.interface;
        let cnovaOut = 0n;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'CNOVAPurchased') { cnovaOut = BigInt(parsed.args.cnovaOut); break; }
          } catch {}
        }
        totalUsdcSpent    += spend;
        totalCnovaReceived += cnovaOut;
        bought++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  const cnovaFmt = totalCnovaReceived > 0n
    ? (Number(totalCnovaReceived) / 1e18).toFixed(2) + ' CNOVA'
    : '—';
  console.log(`  💰 CNOVA buy sweep: ${bought}/${candidates.length} bought | ${fmt6(totalUsdcSpent)} USDC → ${cnovaFmt} (${skipped} skipped)`);
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
      const [inMatB, inTargetA, hTier] = await Promise.all([
        fromMatB.isActiveInMatrix(w.address).catch(() => false),
        toMatA.isActiveInMatrix(w.address).catch(() => false),
        tierRouter.memberHighestTier(w.address).catch(() => 0n),
      ]);
      if (!inMatB)    continue;     // not yet in source tier's MatB — skip
      if (inTargetA)  continue;     // already in target tier's MatA — skip
      // V8.47 wave-2 lesson: a member at/above the target tier still HOLDS their
      // old MatB seat, so without this check they were re-selected every batch
      // and the contract reverted each attempt (~40 wasted txs in wave 2).
      if (Number(hTier) >= targetTierIndex + 1) continue;

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

      // Approve TierRouter for fee + outstanding rescue debt.
      // AUDIT 2026-08-08: this approved only `fee`, so every upgrade reverted for
      // members carrying rescue debt — i.e. everyone the self-rescue step had just
      // processed (observed: 12/12 T5 upgrades failed). V8.47's upgrade gate folds
      // SF.memberDebtOf(member) into the same transaction. Identical to the
      // frontend defect fixed 2026-08-07 via _upgradeDebtDue.
      // NOTE: simulateManualUpgrades is a TOP-LEVEL function — main()'s SF_ADDR is
      // NOT in scope here. Resolve from the addresses file, which IS module-scope.
      let _debtDue = 0n;
      try {
        const _sfAddr = require(ADDRESSES_FILE).stabilityFund;
        if (_sfAddr) {
          _debtDue = BigInt(await new ethers.Contract(
            _sfAddr, ['function memberDebtOf(address) view returns (uint256)'],
            ethers.provider).memberDebtOf(w.address));
        }
      } catch (_) { _debtDue = 0n; }
      const _need = fee + _debtDue;
      const allowance = await usdc.allowance(w.address, tierRouterAddr);
      if (allowance < _need) {
        await (await usdc.connect(conn).approve(tierRouterAddr, _need)).wait();
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


// ── Self-rescue simulation (V8.33) ───────────────────────────────────────────
// After each registration batch or system cycle, scans all test wallets for
// parked members (parkedAt > 0 on any matrix). SELF_RESCUE_RATE % of them
// immediately pay their own shortfall by calling selfRescue() from their own
// wallet — simulating real members who prefer zero debt over waiting for the
// keeper's SF loan.
//
// This is SAFE to run alongside the VPS keeper:
//   • selfRescue() is called FROM THE MEMBER'S OWN WALLET (not keeper or funder)
//   • Keeper conflict = keeper rescues first → selfRescue reverts "not parked" → caught
//   • Only ETH top-up uses rawFunder — brief tx, rarely races in practice
//
// matrices: array of { matrix, label, addr } for all deployed tiers.
// Returns updated fNonce.
async function simulateSelfRescues({ walletList, matrices, usdc, rawFunder, funderAddr, fNonce }) {
  if (SELF_RESCUE_RATE <= 0) return fNonce;

  // Scan all wallets across all matrices to find parked members.
  // A member can only be parked on ONE matrix at a time — break on first hit.
  const parked = [];
  for (const w of walletList) {
    for (const matObj of matrices) {
      try {
        const ts = await matObj.matrix.parkedAt(w.address);
        if (ts > 0n) {
          parked.push({ w, ...matObj });
          break;
        }
      } catch { /* RPC hiccup — skip */ }
    }
  }

  if (parked.length === 0) {
    console.log(`  🆘 Self-rescue scan: 0 parked members in test wallets`);
    return fNonce;
  }

  // Randomly select SELF_RESCUE_RATE fraction to rescue right now.
  const shuffled  = parked.sort(() => Math.random() - 0.5);
  const toRescue  = shuffled.slice(0, Math.max(1, Math.round(shuffled.length * SELF_RESCUE_RATE)));
  const remaining = parked.length - toRescue.length;

  sep(
    `Self-Rescue — ${parked.length} parked · rescuing ${toRescue.length}` +
    ` (${Math.round(SELF_RESCUE_RATE * 100)}%) · ${remaining} wait for keeper`
  );

  let rescued = 0, skipped = 0;
  for (const { w, matrix, label, addr } of toRescue) {
    try {
      const conn = w.connect(ethers.provider);

      // Skip wallets with no USDC — keeper's SF loan will handle them instead.
      const usdcBal = await usdc.balanceOf(w.address);
      if (usdcBal === 0n) {
        console.log(`  ⚠ selfRescue ${label} ${w.address.slice(0, 10)}… — $0 USDC, keeper SF path`);
        skipped++;
        continue;
      }

      // Top up ETH for gas if the wallet is dry (gas-only, not USDC).
      const ethBal = await ethers.provider.getBalance(w.address);
      if (ethBal < 200_000_000_000n) { // < ~$0.00005 worth of gas
        fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, 'pending'));
        const tx = await rawFunder.sendTransaction({
          to: w.address, value: ethers.parseEther("0.01"), nonce: fNonce
        });
        await tx.wait();
        fNonce++;
        await sleep(1);
      }

      // Approve matrix to pull shortfall (contract pulls only what it needs).
      // AUDIT 2026-08-08: RESCUE_APPROVAL is a flat $15 and its own comment says
      // it was sized for T1. Self-rescue now runs on every tier, where the
      // shortfall can reach fee - reserve (T3 $25, T5 $125), so higher tiers
      // reverted with ERC20InsufficientAllowance. Approve this matrix's own
      // ENTRY_FEE, which covers any possible shortfall at any tier.
      let _needApprove = RESCUE_APPROVAL;
      let _feeErr = '';
      try {
        const _entryFee = BigInt(await matrix.ENTRY_FEE());
        if (_entryFee > _needApprove) _needApprove = _entryFee;
      } catch (e) { _feeErr = ' ENTRY_FEE_READ_FAILED:' + (e.shortMessage || e.message || '?').slice(0, 60); }
      const allowance = await usdc.allowance(w.address, addr);
      let _approved = false, _after = allowance;
      if (allowance < _needApprove) {
        await (await usdc.connect(conn).approve(addr, _needApprove)).wait();
        _approved = true;
        // Poll until the new allowance is VISIBLE to reads. Mined != readable on a
        // load-balanced RPC, and the static call below reads through the same pool.
        _after = 0n;
        for (let _try = 0; _try < 6; _try++) {
          await sleep(1);
          _after = await usdc.allowance(w.address, addr);
          if (_after >= _needApprove) break;
        }
      }
      // TEMP INSTRUMENTATION 2026-08-08: the ENTRY_FEE-sized approval did not take
      // effect on some wallets (observed allowance $11.00 where $25 was expected).
      // Print the actual decision so the next run says WHY instead of us guessing.
      if (RESCUE_DEBUG) {
        console.log(`     · approve[${label}] ${w.address.slice(0,10)}… need=${fmt6(_needApprove)} ` +
                    `before=${fmt6(allowance)} approved=${_approved} after=${fmt6(_after)} spender=${addr}${_feeErr}`);
      }

      // Dry-run first (staticCall) to surface the exact revert reason before
      // spending gas on a doomed transaction.  Ethers v6 staticCall throws with
      // the decoded revert string; we log that and bail rather than submitting.
      try {
        await matrix.connect(conn).selfRescue.staticCall({ gasLimit: 15_000_000 });
      } catch (staticErr) {
        // Decode the best available reason string from the static-call error.
        const reason =
          staticErr.reason ||
          staticErr.errorName ||
          staticErr.shortMessage ||
          staticErr.message?.replace(/\n/g, ' ')?.slice(0, 200) ||
          'unknown reason';
        if (reason.includes('not parked') || reason.includes('not a member') ||
            reason.includes('already in matrix') || reason.includes('still in matrix')) {
          console.log(`  ℹ  ${w.address.slice(0, 10)}… keeper rescued first — all good`);
        } else {
          // Log wallet state to help diagnose
          let walletState = '';
          try {
            const m         = await matrix.getMember(w.address);
            const parkedTs  = await matrix.parkedAt(w.address);
            const usdcW     = await usdc.balanceOf(w.address);
            walletState = ` [joined=${m.hasEverJoined} inMatrix=${m.isInMatrix} parkedAt=${parkedTs} withdrawable=${fmt6(m.withdrawable)} reserve=${fmt6(m.crossingReserve)} walletUSDC=${fmt6(usdcW)}]`;
          } catch { walletState = ' [state query failed]'; }
          const rawHex = staticErr.data ?? staticErr.error?.data ?? staticErr.info?.error?.data ?? null;
          // AUDIT 2026-08-08: RAW was truncated at 130 chars, which cut off the
          // allowance/needed words — the only numbers that say WHY it failed.
          // Decode the two OZ errors this path actually produces.
          let rawHexStr = rawHex ? ` | RAW=${String(rawHex).slice(0, 200)}` : '';
          try {
            if (rawHex) {
              const _i = new ethers.Interface([
                'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
                'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
              ]);
              const _d = _i.parseError(rawHex);
              if (_d?.name === 'ERC20InsufficientAllowance') {
                rawHexStr = ` | ALLOWANCE TOO LOW: spender=${_d.args[0]} allowance=${fmt6(_d.args[1])} needed=${fmt6(_d.args[2])}`;
              } else if (_d?.name === 'ERC20InsufficientBalance') {
                rawHexStr = ` | WALLET TOO POOR: balance=${fmt6(_d.args[1])} needed=${fmt6(_d.args[2])}`;
              }
            }
          } catch (_) {}
          console.warn(`  ⚠ selfRescue ${label} ${w.address.slice(0, 10)}… STATIC CALL REVERT: ${reason}${walletState}${rawHexStr}`);
        }
        skipped++;
        continue; // skip the actual send — it would definitely fail
      }

      // Static call passed — submit the real transaction.
      // Call selfRescue() — member pays own shortfall, zero SF debt incurred.
      // gasLimit 15M: selfRescue can trigger a 127-seat MatB cycle-out (double
      // cycle-out costs ~8M gas) — same ceiling used for register() and manualUpgrade().
      await (await matrix.connect(conn).selfRescue({ gasLimit: 15_000_000 })).wait();
      console.log(`  ✓ selfRescue ${label}  ${w.address.slice(0, 10)}…  (${fmt6(usdcBal)} USDC in wallet)`);
      rescued++;
    } catch (e) {
      const msg = e.shortMessage || e.message?.slice(0, 120) || 'unknown';
      if (msg.includes("not parked")) {
        // Keeper rescued them first — totally fine, member is back in matrix
        console.log(`  ℹ  ${w.address.slice(0, 10)}… keeper rescued first — all good`);
      } else {
        console.warn(`  ⚠ selfRescue ${w.address.slice(0, 10)}… unexpected TX error: ${msg}`);
      }
      skipped++;
      try { fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, 'pending')); } catch {}
    }
    await sleep(2); // 2s gap — stay under Base Sepolia in-flight limit
  }

  console.log(
    `  Self-rescues: ${rescued} succeeded · ${skipped} skipped` +
    (remaining > 0 ? ` · ${remaining} parked wallets left for keeper` : '')
  );
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
  const deployer     = new NonceManager(rawSigner); // owner calls only (manualUpgrade, etc.)
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
  // All deployed matrices — used by simulateSelfRescues() to scan parkedAt.
  // Null entries (T2/T3 if not deployed) are filtered out.
  // V8.36: declared `let` so the PM discovery block below can expand it with
  // factory-spawned pairs like T1.2 without re-declaring.
  let allMatrices = [
    { matrix: matA1, label: "T1.1 MatA", addr: T1.matA },
    { matrix: matB1, label: "T1.1 MatB", addr: T1.matB },
    ...(matA2 ? [{ matrix: matA2, label: "T2 MatA", addr: T2.matA }] : []),
    ...(matB2 ? [{ matrix: matB2, label: "T2 MatB", addr: T2.matB }] : []),
    ...(matA3 ? [{ matrix: matA3, label: "T3 MatA", addr: T3.matA }] : []),
    ...(matB3 ? [{ matrix: matB3, label: "T3 MatB", addr: T3.matB }] : []),
  ];

  // ── V8.48 shakedown (owner 2026-08-08): ALL tiers in play ──────────────────
  // T4..T10 handles from the addresses file, so simulateSelfRescues() scans
  // every tier's parked members and the upgrade ladder can climb past T3.
  // Wallet-funded upgrades at every rung are the point of the $30k leader
  // funding — they exercise the V8.47 debt-fold and higher-tier reserves.
  const tierMats = { 2: { matA: matA2, matB: matB2 }, 3: { matA: matA3, matB: matB3 } };
  for (let tn = 4; tn <= 10; tn++) {
    const T = (addrs.tiers || {})[`T${tn}`];
    if (!T || !T.matA) { tierMats[tn] = null; continue; }
    const mA = await ethers.getContractAt("FigureEightMatrixV8", T.matA);
    const mB = T.matB ? await ethers.getContractAt("FigureEightMatrixV8", T.matB) : null;
    tierMats[tn] = { matA: mA, matB: mB };
    allMatrices.push({ matrix: mA, label: `T${tn} MatA`, addr: T.matA });
    if (mB) allMatrices.push({ matrix: mB, label: `T${tn} MatB`, addr: T.matB });
  }

  // ── Discover factory-spawned T1 pairs via PairManager ──────────────────────
  // When T1.1 reaches 127/127 (both matrices), the factory autonomously spawns
  // T1.2 and sets activePairIndex = 1.  All subsequent registrations go to T1.2.
  // We query allPairsStatus() to find T1.2 (and any future T1.3, T1.4…) so that:
  //   • simulateSelfRescues() scans T1.2 parked members (not just T1.1)
  //   • occupancy display shows T1.2 live fill (not T1.1's archived 127/127)
  //   • withdrawSweep catches T1.2 earnings
  //   • simulateManualUpgrades checks T1.2 MatB → T2 eligibility
  let activeMatA1    = matA1;   // T1.1 MatA — default pre-factory
  let activeMatB1    = matB1;   // T1.1 MatB — default pre-factory
  let activeMatA1Addr = T1.matA;
  let activeMatB1Addr = T1.matB;
  try {
    const pm1View = await ethers.getContractAt("PairManagerV8", T1.pm);
    const [pmMatAs, pmMatBs] = await pm1View.allPairsStatus();
    if (pmMatAs.length > 1) {
      const lastPair = pmMatAs.length - 1;
      activeMatA1Addr = pmMatAs[lastPair];
      activeMatB1Addr = pmMatBs[lastPair];
      activeMatA1 = await ethers.getContractAt("FigureEightMatrixV8", activeMatA1Addr);
      activeMatB1 = await ethers.getContractAt("FigureEightMatrixV8", activeMatB1Addr);
      console.log(`  ℹ  T1 factory: ${pmMatAs.length} pairs. T1.1 archived (127/127). Active: T1.${pmMatAs.length} (${activeMatA1Addr.slice(0,10)}…)`);
      // Rebuild allMatrices: T1.1 (archived) + T1.2 … T1.N (active) + T2 + T3
      allMatrices = [
        { matrix: matA1, label: "T1.1 MatA", addr: T1.matA },
        { matrix: matB1, label: "T1.1 MatB", addr: T1.matB },
      ];
      for (let pi = 1; pi < pmMatAs.length; pi++) {
        const pairLabel = `T1.${pi + 1}`;
        allMatrices.push(
          { matrix: await ethers.getContractAt("FigureEightMatrixV8", pmMatAs[pi]), label: `${pairLabel} MatA`, addr: pmMatAs[pi] },
          { matrix: await ethers.getContractAt("FigureEightMatrixV8", pmMatBs[pi]), label: `${pairLabel} MatB`, addr: pmMatBs[pi] },
        );
      }
      if (matA2) allMatrices.push({ matrix: matA2, label: "T2 MatA", addr: T2.matA });
      if (matB2) allMatrices.push({ matrix: matB2, label: "T2 MatB", addr: T2.matB });
      if (matA3) allMatrices.push({ matrix: matA3, label: "T3 MatA", addr: T3.matA });
      if (matB3) allMatrices.push({ matrix: matB3, label: "T3 MatB", addr: T3.matB });
      console.log(`  allMatrices rebuilt: ${allMatrices.map(m => m.label).join(', ')}`);
    }
  } catch(e) {
    console.warn(`  ⚠  PM pair discovery failed — using T1.1 static addresses: ${e.message?.slice(0,80)}`);
  }

  const MK_ADDR    = addrs.matrixKeeper || addrs.MatrixKeeper || null;
  const matrixKeeper = MK_ADDR ? await ethers.getContractAt("MatrixKeeper", MK_ADDR, deployer) : null;
  const DS_ADDR    = addrs.directSale || addrs.CNOVADirectSale || null;
  const directSale = DS_ADDR ? await ethers.getContractAt("CNOVADirectSale", DS_ADDR) : null;
  if (DS_ADDR) console.log(`  📦 CNOVADirectSale: ${DS_ADDR}`);
  else         console.log(`  ⚠  CNOVADirectSale not in addresses file — CNOVA buy sweep disabled`);

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

  // ── Validate ROUND_ROBIN addresses ────────────────────────────────────────
  // V8.44: SKIP unregistered addresses instead of aborting the whole run (matches
  // stress_keeper.js behaviour). On a fresh deploy most leaders have not registered
  // yet; aborting made a long round-robin list unusable. Unregistered sponsors would
  // silently resolve to defaultReferrer (W1) on-chain, so we drop them up front and
  // rotate only across the ones that will actually earn the L1.
  if (ROUND_ROBIN_ADDRS.length > 0) {
    console.log(`\n  Round-robin referrers (${ROUND_ROBIN_ADDRS.length} supplied):`);
    const _registered = [];
    for (const addr of ROUND_ROBIN_ADDRS) {
      const tier = await tierRouter.memberHighestTier(addr);
      if (tier === 0n) {
        console.log(`  [ ] ${addr} NOT registered — skipped`);
        continue;
      }
      console.log(`    ✓ ${addr}  (tier ${tier})`);
      _registered.push(addr);
    }
    // Rotate only across registered sponsors.
    ROUND_ROBIN_ADDRS.length = 0;
    ROUND_ROBIN_ADDRS.push(..._registered);
    if (ROUND_ROBIN_ADDRS.length === 0) {
      console.log(`  !  No round-robin address is registered yet — falling back to W1 for every wallet.`);
    } else {
      console.log(`  => ${ROUND_ROBIN_ADDRS.length} active sponsor(s) in rotation.`);
    }
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
  const wallets = makeWallets(COUNT, HDR_OFFSET);
  // allWallets = every wallet ever registered (SCAN_FROM..HDR_OFFSET-1) + new batch.
  // Used for rescue/upgrade scans — historical wallets may be parked or upgrade-ready.
  const historicalCount = Math.max(0, HDR_OFFSET - SCAN_FROM);
  const allWallets = historicalCount > 0
    ? [...makeWallets(historicalCount, SCAN_FROM), ...wallets]
    : [...wallets];
  console.log(`  Generated ${wallets.length} new test wallets  (HDR_OFFSET=${HDR_OFFSET})`);
  if (historicalCount > 0)
    console.log(`  + ${historicalCount} historical wallets (SCAN_FROM=${SCAN_FROM}..${HDR_OFFSET - 1}) → ${allWallets.length} total for rescue/upgrade`);
  sep();

  // ── Pre-snapshot ───────────────────────────────────────────────────────────
  await snapshot("PRE-FILL SNAPSHOT", { tierRouter, pm1, matA1, matB1, matA2, matB2, cnova, treasury, stabilityFund, w1Addr: W1_ADDR });

  // ── V8.48 shakedown: continue the upgrade ladder T3→T4 … T9→T10 ────────────
  // Same simulator per rung — fee read on-chain per tier, the memberHighestTier
  // guard inside skips completed rungs, self-funded wallets only.
  async function upgradeLadderHigh(fNonceIn) {
    let n = fNonceIn;
    for (let tn = 4; tn <= 10; tn++) {
      const prev = tierMats[tn - 1], cur = tierMats[tn];
      if (!prev || !cur || !prev.matB || !cur.matA) continue;
      const hopFee = await cur.matA.ENTRY_FEE().catch(() => 0n);
      if (hopFee === 0n) continue;
      n = await simulateManualUpgrades({
        walletList: allWallets, tierRouter, fromMatB: prev.matB, toMatA: cur.matA,
        usdc, usdcFunder, rawFunder, funderAddr, fNonce: n,
        tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
        fee: hopFee, targetTierIndex: tn - 1, tierLabel: `T${tn}`,
      });
    }
    return n;
  }

  // ── Pre-run: rescue + upgrade ALL historical wallets ──────────────────────
  // Runs BEFORE new registrations so parked/eligible old wallets are handled
  // immediately without waiting for the registration loop to encounter them.
  if (allWallets.length > wallets.length) {
    sep(`Pre-run sweep — ${historicalCount} historical wallets (rescue + upgrade)`);
    fNonce = await simulateSelfRescues({
      walletList: allWallets, matrices: allMatrices, usdc: usdcContract,
      rawFunder, funderAddr, fNonce,
    });
    if (matA2) {
      fNonce = await simulateManualUpgrades({
        walletList: allWallets, tierRouter, fromMatB: matB1, toMatA: matA2,
        usdc, usdcFunder, rawFunder, funderAddr, fNonce,
        tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
        fee: T2_FEE, targetTierIndex: 1, tierLabel: "T2 (from T1.1 MatB)",
      });
      // If factory spawned T1.2, also check T1.2 MatB → T2
      if (activeMatB1Addr !== T1.matB) {
        fNonce = await simulateManualUpgrades({
          walletList: allWallets, tierRouter, fromMatB: activeMatB1, toMatA: matA2,
          usdc, usdcFunder, rawFunder, funderAddr, fNonce,
          tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
          fee: T2_FEE, targetTierIndex: 1, tierLabel: "T2 (from T1.2 MatB)",
        });
      }
    }
    if (matA3) {
      fNonce = await simulateManualUpgrades({
        walletList: allWallets, tierRouter, fromMatB: matB2, toMatA: matA3,
        usdc, usdcFunder, rawFunder, funderAddr, fNonce,
        tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
        fee: T3_FEE, targetTierIndex: 2, tierLabel: "T3",
      });
    }
    fNonce = await upgradeLadderHigh(fNonce);   // V8.48 shakedown: T4..T10
  }

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

  // ── USDC post-fund verification + retry (#157) ────────────────────────────
  // ETH retry above is robust — match it for USDC: wallets with < FUND_AMOUNT
  // get up to 3 transfer retries before being flagged as insufficientUsdc.
  const insufficientUsdc = new Set();
  let usdcOk = 0, usdcFail = 0;
  for (const w of walletsToFund) {
    const usdcBal = await usdc.balanceOf(w.address).catch(() => 0n);
    if (usdcBal < FUND_AMOUNT) {
      const deficit = FUND_AMOUNT - usdcBal;
      console.warn(`  ⚠  ${w.address.slice(0,10)} only has ${fmt6(usdcBal)} USDC (need ${fmt6(FUND_AMOUNT)}) — retrying`);
      let retried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await usdcFunder.transfer(w.address, deficit, { nonce: fNonce });
          await tx.wait();
          fNonce++;
          await sleep(15);
          const newBal = await usdc.balanceOf(w.address).catch(() => 0n);
          if (newBal >= FUND_AMOUNT) {
            usdcOk++;
            retried = true;
            break;
          }
          console.warn(`     attempt ${attempt+1}: still ${fmt6(newBal)} USDC — retrying`);
        } catch(e) {
          console.warn(`     attempt ${attempt+1} failed: ${e.message.slice(0,80)}`);
          fNonce = Number(await ethers.provider.getTransactionCount(funderAddr, "pending"));
        }
      }
      if (!retried) {
        console.warn(`     ❌ ${w.address.slice(0,10)} could not receive USDC after 3 attempts — will skip registration`);
        insufficientUsdc.add(w.address);
        usdcFail++;
      }
    } else {
      usdcOk++;
    }
  }
  console.log(`  USDC post-fund check: ${usdcOk} OK, ${usdcFail} failed`);
  sep();

  // ── Register wallets in batches ────────────────────────────────────────────
  sep("Registering wallets via TierRouter");
  let registered = 0;
  let skippedAlready = 0;  // wallets already registered from a prior run — not failures
  const failures = [];
  const upgradedAt = [];
  let prevSysCyc    = await tierRouter.totalSystemCycles(); // track cycle changes for burn sweep

  // ── Assign referrers (W1 or round-robin) ─────────────────────────────────
  // referrerFor[wallet.address] = sponsor address to use for that wallet's register() call.
  // Round-robin distributes L1 commissions across multiple seed accounts evenly.
  const referrerFor = new Map();
  for (let i = 0; i < wallets.length; i++) {
    referrerFor.set(
      wallets[i].address,
      ROUND_ROBIN_ADDRS.length > 0 ? ROUND_ROBIN_ADDRS[i % ROUND_ROBIN_ADDRS.length] : W1_ADDR
    );
  }
  if (ROUND_ROBIN_ADDRS.length > 0) {
    console.log(`  Round-robin: ${wallets.length} wallets → ${ROUND_ROBIN_ADDRS.length} referrers (${Math.round(wallets.length / ROUND_ROBIN_ADDRS.length)} each avg)`);
  }

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
        if (insufficientUsdc.has(wallet.address)) {
          throw new Error(`wallet ${wallet.address.slice(0,10)} had insufficient USDC after all funding attempts — skipped`);
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
        const regTx = await tierRouter.connect(connected).register(referrerFor.get(wallet.address) || W1_ADDR, { gasLimit: 15_000_000 });
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

    // Per-batch stats — use ACTIVE pair (T1.2 after factory) not archived T1.1
    const occ1A    = await activeMatA1.occupancy();
    const occ1B    = await activeMatB1.occupancy();
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

    // Burn + withdraw sweep + CNOVA buy sweep — runs on every new matrix cycle
    if (sysCyc > prevSysCyc) {
      console.log(`\n  🔄 Cycle detected (${prevSysCyc} → ${sysCyc})`);
      if (process.env.BURN_SIMULATE !== "false") { console.log(`  ↳ Running early-unlock burn sweep (simulate CNOVA sell)…`); }
      await burnSweep(wallets, cnova);
      console.log(`  ↳ Running withdraw sweep (USDC exit simulation)…`);
      await withdrawSweep(wallets, allMatrices);
      if (Number(process.env.CNOVA_BUY_RATE ?? "0.25") > 0) { console.log(`  ↳ Running CNOVA buy sweep (simulate purchases via DirectSale)…`); }
      await cnovaBuySweep(wallets, directSale, usdc);
      // Self-rescue sweep on every cycle — most likely time wallets just got parked
      fNonce = await simulateSelfRescues({
        walletList: allWallets, matrices: allMatrices, usdc: usdcContract,
        rawFunder, funderAddr, fNonce,
      });
      prevSysCyc = sysCyc;
    }
    // Self-rescue simulation: runs on every cycle (keeper may also rescue in parallel —
    // selfRescue uses member wallets, not the keeper/funder wallet, so no nonce conflict).
    // Also scans every RESCUE_SCAN_EVERY batches to catch delayed parks.

    // V8.19: Manual upgrade simulation — UPGRADE_RATE% of eligible, self-funded
    // wallets upgrade each hop. Run T1→T2 first, then T2→T3 — a wallet can
    // chain both in the same batch if it's already crossed T1 MatB AND holds
    // enough of its own USDC reserve to cover both fees.
    fNonce = await simulateManualUpgrades({
      walletList: allWallets, tierRouter, fromMatB: matB1, toMatA: matA2,
      usdc, usdcFunder, rawFunder,
      funderAddr, fNonce,
      tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
      fee: T2_FEE, targetTierIndex: 1, tierLabel: "T2 (from T1.1 MatB)",
    });
    // If factory spawned T1.2, also check T1.2 MatB → T2 (members who crossed in T1.2)
    if (activeMatB1Addr !== T1.matB && matA2) {
      fNonce = await simulateManualUpgrades({
        walletList: allWallets, tierRouter, fromMatB: activeMatB1, toMatA: matA2,
        usdc, usdcFunder, rawFunder,
        funderAddr, fNonce,
        tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
        fee: T2_FEE, targetTierIndex: 1, tierLabel: "T2 (from T1.2 MatB)",
      });
    }
    fNonce = await simulateManualUpgrades({
      walletList: allWallets, tierRouter, fromMatB: matB2, toMatA: matA3,
      usdc, usdcFunder, rawFunder,
      funderAddr, fNonce,
      tierRouterAddr: addrs.tierRouter || addrs.TierRouter,
      fee: T3_FEE, targetTierIndex: 2, tierLabel: "T3",
    });
    fNonce = await upgradeLadderHigh(fNonce);   // V8.48 shakedown: T4..T10

    // Withdraw sweep every 10 batches — simulate ongoing sell pressure
    if (batchNum % 10 === 0) {
      await withdrawSweep(wallets, allMatrices);
    }

    // Periodic self-rescue scan — catch members parked between cycles
    if (batchNum % RESCUE_SCAN_EVERY === 0) {
      fNonce = await simulateSelfRescues({
        walletList: allWallets, matrices: allMatrices, usdc: usdcContract,
        rawFunder, funderAddr, fNonce,
      });
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
  if (process.env.BURN_SIMULATE !== "false") {
    sep("Final Burn Sweep");
    console.log("  Running earlyUnlockAll() on all wallets with remaining vest batches…");
  }
  await burnSweep(wallets, cnova);

  // ── Post-fill snapshot ────────────────────────────────────────────────────
  // NOTE: forceCross has been removed from bigfill. Parked members are crossed
  // exclusively by direct_keeper.js → MatrixKeeper.forceCrossKeeper(). This
  // lets the V8.27 rescue loan system (SF crossing buffer + 15% gradual repay)
  // operate without any admin interference.
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
