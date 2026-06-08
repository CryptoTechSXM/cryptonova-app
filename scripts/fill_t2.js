/**
 * fill_t2.js — V8 T2 cycle stress test
 *
 * Strategy: repeatedly forceCross parked T1A wallets → triggers T1B to cycle.
 * Once T1B has filled once, occupancy stays at 64 permanently: every _enterMatrix
 * call on a full T1B triggers _cycleOutRoot() inline before placing the new member.
 * Each forceCross generates one T1B cycle-out. The cycled-out root is routed to T2 by
 * TierRouter.handleCycleOut() IF escrowBalance + withdrawable >= T2_FEE ($25).
 * In rapid test scenarios, test wallets haven't accumulated enough escrow, so
 * auto-upgrade falls to guard "e" (funds insufficient) and parks the member.
 * This script detects parked roots and drives them via manualUpgrade(1) instead,
 * which pulls T2_FEE from the wallet's own USDC balance (we mint it as needed).
 *
 * Unlike bigfill_v8.js, this script:
 *   - Does NOT register new wallets (no ETH/USDC wallet funding)
 *   - Drives entirely via forceCross on T1 MatA + T2 MatA
 *   - T1B forceCross cost: T1_FEE ($10) per call from deployer
 *   - T2A forceCross cost: T2_FEE ($25) per call from deployer (for parked T2 alumni)
 *   - Both are MockUSDC on testnet, so deployer mints as needed
 *
 * Prerequisites:
 *   - W1 must have already completed T1 cycle and auto-upgraded to T2
 *   - T1B occupancy will be 64/64 in normal cycling mode (this is correct -- not an error)
 *   - Parked T1A wallets must exist (bigfill_v8.js must have run)
 *
 * Usage:
 *   npx hardhat run scripts/fill_t2.js --network baseSepolia
 *
 * Optional env vars:
 *   ADDRESSES_FILE   path to deployed JSON (default: deployed_addresses_v8_4.json)
 *   MAX_ITERS        max T1B forceCross iterations (default: 200)
 */
"use strict";

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");

// ── Config ─────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_4.json"
);
const MAX_ITERS  = Number(process.env.MAX_ITERS || 200);
const GAS_LIMIT  = 12_000_000;

// Scan all historically used HDR_OFFSETs (70 wallets each)
// Update when new bigfill runs are done with new offsets.
const SCAN_OFFSETS = [500, 1000, 1500, 1700, 1800, 2000, 2500];
const SCAN_WIDTH   = 70;
const MNEMO        = "test test test test test test test test test test test junk";

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep = s  => new Promise(r => setTimeout(r, s * 1000));
const fmt6  = n  => "$" + (Number(n) / 1e6).toFixed(2);

function sep(label) {
  if (label) console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 54 - label.length))}`);
  else       console.log(`  ${"─".repeat(60)}`);
}

// Build deterministic test-wallet scan set from all known HDR_OFFSETs
function buildScanSet() {
  const m = new Map();
  for (const base of SCAN_OFFSETS) {
    for (let i = 0; i < SCAN_WIDTH; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(MNEMO, undefined, `m/44'/60'/0'/0/${base + i}`);
      m.set(w.address, w);
    }
  }
  return m;
}

// Return addresses that are in matA (cycled out) but not yet in matB.
// These are candidates for forceCross.
// matA and matB must be contract instances with getMember().
async function getParked(matA, matB, scanSet, extraAddr) {
  const parked = [];

  // Optionally check a specific address first (e.g. W1 or accountOne)
  if (extraAddr) {
    const mA = await matA.getMember(extraAddr);
    if (mA.hasEverJoined && !mA.isInMatrix) {
      const mB = await matB.getMember(extraAddr);
      if (!mB.hasEverJoined && !mB.isInMatrix) {
        parked.push(extraAddr);
      }
    }
  }

  for (const [addr] of scanSet) {
    const mA = await matA.getMember(addr);
    if (!mA.hasEverJoined || mA.isInMatrix) continue;   // never joined or still in
    const mB = await matB.getMember(addr);
    if (mB.hasEverJoined || mB.isInMatrix)  continue;   // already in/done MatB
    parked.push(addr);
  }

  return parked;
}

// Print a full state snapshot
async function snapshot(label, ctx) {
  const { tierRouter, matA1, matB1, matA2, matB2, stabilityFund, w1Addr } = ctx;
  sep(label);
  const mSize      = await matA1.MATRIX_SIZE();
  const occ1A      = await matA1.occupancy();
  const occ1B      = await matB1.occupancy();
  const occ2A      = await matA2.occupancy();
  const occ2B      = await matB2.occupancy();
  const rot1A      = await matA1.rotationCount();
  const rot2A      = await matA2.rotationCount();
  const w1Tier     = await tierRouter.memberHighestTier(w1Addr);
  const w1T1cyc    = await tierRouter.tierCycles(w1Addr, 0);
  const w1T2cyc    = await tierRouter.tierCycles(w1Addr, 1);
  const sysCyc     = await tierRouter.totalSystemCycles();

  console.log(`  T1A: ${occ1A}/${mSize} (rot ${rot1A})   T1B: ${occ1B}/${mSize}`);
  console.log(`  T2A: ${occ2A}/${mSize} (rot ${rot2A})   T2B: ${occ2B}/${mSize}`);
  console.log(`  W1 tier: T${w1Tier}   T1-cycles: ${w1T1cyc}   T2-cycles: ${w1T2cyc}`);
  console.log(`  System cycles: ${sysCyc}`);

  // W1 T2 earnings
  if (w1Tier >= 2n) {
    try {
      const m2 = await matA2.getMember(w1Addr);
      if (m2.hasEverJoined) {
        console.log(`  W1 T2A withdrawable: ${fmt6(m2.withdrawable)}`);
      }
      const m2B = await matB2.getMember(w1Addr);
      if (m2B.hasEverJoined) {
        console.log(`  W1 T2B withdrawable: ${fmt6(m2B.withdrawable)}`);
      }
    } catch {}
  }

  if (stabilityFund) {
    try {
      const sfBal = await stabilityFund.totalBalance();
      console.log(`  StabilityFund bal:   ${fmt6(sfBal)}`);
    } catch {}
  }
}


/**
 * Fund a wallet with T2_FEE USDC + ETH for gas, then call manualUpgrade(1).
 * Used for T1B roots that get parked because their matrix escrow < T2_FEE.
 * manualUpgrade() pulls from the wallet's own USDC balance, bypassing escrow.
 */
async function fundAndManualUpgrade(targetAddr, scanSet, usdc, tierRouter, addrs, T2_FEE, deployer, provider) {
  const wallet = scanSet.get(targetAddr);
  if (!wallet) {
    console.log(`    ⚠  ${targetAddr.slice(0,10)} not in scan set — skip manualUpgrade`);
    return false;
  }
  try {
    const connectedWallet = wallet.connect(provider);

    // Top up ETH for gas if needed (approve + manualUpgrade = ~2 txs)
    const ethBal = await provider.getBalance(targetAddr);
    const minEth = ethers.parseEther("0.001");
    if (ethBal < minEth) {
      await (await deployer.sendTransaction({ to: targetAddr, value: minEth - ethBal })).wait();
    }

    // Mint T2_FEE to wallet (deployer is MockUSDC minter)
    deployer.reset();
    await sleep(1);
    const usdcBal = await usdc.balanceOf(targetAddr);
    if (usdcBal < T2_FEE) {
      await (await usdc.mint(targetAddr, T2_FEE - usdcBal)).wait();
    }

    // Wallet approves TierRouter for T2_FEE
    deployer.reset();
    await sleep(1);
    const usdcFromWallet = usdc.connect(connectedWallet);
    const allow = await usdc.allowance(targetAddr, addrs.tierRouter);
    if (allow < T2_FEE) {
      await (await usdcFromWallet.approve(addrs.tierRouter, T2_FEE, { gasLimit: 100_000 })).wait();
    }

    // Wallet calls manualUpgrade(1) = upgrade from T1 → T2
    const trFromWallet = tierRouter.connect(connectedWallet);
    await (await trFromWallet.manualUpgrade(1, { gasLimit: 6_000_000 })).wait();

    return true;
  } catch (e) {
    console.log(`    ✗  manualUpgrade failed: ${e.message.slice(0, 100)}`);
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n  ERR  ${ADDRESSES_FILE} not found.`);
    process.exit(1);
  }

  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [rawSigner]  = await ethers.getSigners();
  const deployer     = new ethers.NonceManager(rawSigner);
  const provider     = ethers.provider;
  const deployerAddr = rawSigner.address;

  const T1       = addrs.tiers?.T1  || {};
  const T2       = addrs.tiers?.T2  || {};
  const W1_ADDR  = addrs.accountOne || addrs.AccountOne;
  const SF_ADDR  = addrs.stabilityFund;

  const usdc          = await ethers.getContractAt("MockUSDC",            addrs.usdc,        deployer);
  const tierRouter    = await ethers.getContractAt("TierRouter",          addrs.tierRouter);
  const matA1         = await ethers.getContractAt("FigureEightMatrixV8", T1.matA,           deployer);
  const matB1         = await ethers.getContractAt("FigureEightMatrixV8", T1.matB);
  const matA2         = await ethers.getContractAt("FigureEightMatrixV8", T2.matA,           deployer);
  const matB2         = await ethers.getContractAt("FigureEightMatrixV8", T2.matB);
  const stabilityFund = SF_ADDR
    ? await ethers.getContractAt("StabilityFund", SF_ADDR)
    : null;

  const T1_FEE = await matA1.ENTRY_FEE();
  const T2_FEE = await matA2.ENTRY_FEE();
  const mSize  = await matA1.MATRIX_SIZE();

  sep("fill_t2.js — T2 cycle stress test");
  console.log(`  Deployer:    ${deployerAddr}`);
  console.log(`  W1 / acct1:  ${W1_ADDR}`);
  console.log(`  T1 fee:      ${fmt6(T1_FEE)}   T2 fee: ${fmt6(T2_FEE)}`);
  console.log(`  Matrix size: ${mSize}`);
  console.log(`  Max iters:   ${MAX_ITERS}`);
  sep();

  // ── Sanity checks ────────────────────────────────────────────────────────────
  const w1Tier = await tierRouter.memberHighestTier(W1_ADDR);
  if (w1Tier < 2n) {
    console.error(`  ERR  W1 is at T${w1Tier} — must be T2+ before running fill_t2.`);
    console.error(`       Run bigfill_v8.js first to complete the T1 cycle.`);
    process.exit(1);
  }

  const t1bOccStart = await matB1.occupancy();
  // T1B at 64/64 is the EXPECTED state once cycling has begun.
  // _enterMatrix on a full T1B triggers _cycleOutRoot() inline — occupancy
  // decrements then increments back to 64.  It never falls below 64 again.
  // A value < 64 means T1B hasn't fully cycled yet (rare early state).
  if (t1bOccStart < mSize) {
    console.log(`  ⚠  T1B at ${t1bOccStart}/${mSize} — not yet full. Each forceCross fills one slot.`);
  }
  console.log(`  W1 is T${w1Tier} ✓   T1B ${t1bOccStart}/${mSize} — ready to forceCross.`);

  // ── Initial snapshot ─────────────────────────────────────────────────────────
  await snapshot("INITIAL STATE", { tierRouter, matA1, matB1, matA2, matB2, stabilityFund, w1Addr: W1_ADDR });

  // ── Build scan set ──────────────────────────────────────────────────────────
  sep("Building scan set");
  const scanSet = buildScanSet();
  console.log(`  ${SCAN_OFFSETS.length} offsets x ${SCAN_WIDTH} wallets = ${scanSet.size} addresses`);

  // Pre-scan T1A parked count
  const t1aParkedInit = await getParked(matA1, matB1, scanSet, null);
  console.log(`  T1A parked (pre-run): ${t1aParkedInit.length}`);
  // NOTE: do NOT exit here if T1A queue is empty — the repair loop below may
  // have enough parked T1B→T2A wallets to complete the T2 cycle on its own.
  // The main loop exits cleanly with a STOP message if T1A is still empty
  // after the repair pass.

  // Pre-mint USDC buffer for deployer (enough for 200 T1 crosses + 100 T2 crosses)
  const mintBuffer = T1_FEE * 200n + T2_FEE * 100n;
  const deployerUsdcInit = await usdc.balanceOf(deployerAddr);
  if (deployerUsdcInit < mintBuffer) {
    const toMint = mintBuffer - deployerUsdcInit;
    console.log(`  Minting ${fmt6(toMint)} USDC to deployer…`);
    await (await usdc.mint(deployerAddr, toMint)).wait();
  }
  // Reset NonceManager before approves — ensures fresh on-chain nonce after
  // any preceding txs (mint above, or prior bigfill runs in same session).
  deployer.reset();
  await sleep(2);
  // Bulk approve both MatA contracts upfront
  const allow1 = await usdc.allowance(deployerAddr, T1.matA);
  if (allow1 < T1_FEE * 200n) {
    await (await usdc.approve(T1.matA, T1_FEE * 200n)).wait();
    console.log(`  Approved T1 MatA for ${fmt6(T1_FEE * 200n)}`);
  }
  const allow2 = await usdc.allowance(deployerAddr, T2.matA);
  if (allow2 < T2_FEE * 100n) {
    await (await usdc.approve(T2.matA, T2_FEE * 100n)).wait();
    console.log(`  Approved T2 MatA for ${fmt6(T2_FEE * 100n)}`);
  }


  // ── Repair previously parked wallets ────────────────────────────────────────
  // Wallets that cycled out of T1B with insufficient escrow are "parked" in
  // TierRouter (tierCycles[addr][0] = 1, not in T2A or T2B, not in T1B).
  // Drive them via manualUpgrade(1) so T2A occupancy catches up.
  sep("Repairing parked T1B→T2A wallets");
  let repairedCount = 0;
  for (const [addr] of scanSet) {
    if (addr.toLowerCase() === W1_ADDR.toLowerCase()) continue;
    const cycles = await tierRouter.tierCycles(addr, 0);
    if (cycles < 1n) continue;                                    // never completed T1
    const inT1B = await matB1.getMember(addr);
    if (inT1B.isInMatrix) continue;                               // still in T1B
    const inT2A = await matA2.getMember(addr);
    const inT2B = await matB2.getMember(addr);
    if (inT2A.isInMatrix || inT2A.hasEverJoined) continue;        // already T2A
    if (inT2B.isInMatrix || inT2B.hasEverJoined) continue;        // already T2B
    // Found a parked wallet
    process.stdout.write(`  Repairing ${addr.slice(0,10)}… `);
    const ok = await fundAndManualUpgrade(addr, scanSet, usdc, tierRouter, addrs, T2_FEE, deployer, provider);
    if (ok) {
      repairedCount++;
      const t2aNow = await matA2.occupancy();
      console.log(`✓  T2A ${t2aNow}/${mSize}`);
    }
  }
  if (repairedCount > 0) console.log(`  Repaired ${repairedCount} parked wallets — T2A now ${await matA2.occupancy()}/${mSize}`);
  else                   console.log(`  No parked wallets found.`);

  // If repair loop already completed the T2 cycle, skip main loop entirely
  const w1T2cycAfterRepair = await tierRouter.tierCycles(W1_ADDR, 1);
  if (w1T2cycAfterRepair >= 1n) {
    sep("T2 CYCLE COMPLETE (via repair)");
    console.log(`  W1 has completed T2 cycle! tierCycles(W1, 1) = ${w1T2cycAfterRepair}`);
    await snapshot("FINAL STATE", { tierRouter, matA1, matB1, matA2, matB2, stabilityFund, w1Addr: W1_ADDR });
    console.log(`
  SUCCESS  W1 completed full T2 cycle!`);
    console.log(`  Next steps:`);
    console.log(`    1. v8_5 redeploy — fix PairManagerV8 (activePairCount/getPairAt) + TierRouter keeper fns`);
    console.log(`    2. Re-register Chainlink upkeep with new MatrixKeeper address`);
    console.log(`    3. Community testing — invite 3-5 real wallets to v8.crypto-nova.app`);
    sep();
    return;
  }

  // If T1A queue is empty AND repair found nothing, we need more bigfill
  if (t1aParkedInit.length === 0 && repairedCount === 0) {
    console.error(`  ERR  No parked T1A wallets and no parked T1B wallets to repair.`);
    console.error(`       Run bigfill_v8.js (HDR_OFFSET=2200 COUNT=200) to register more members.`);
    process.exit(1);
  }

  // ── Main loop ───────────────────────────────────────────────────────────────
  // Drive T1B cycles to auto-generate T2 MatA members.
  // After T2 MatA fills (W1 auto-crosses to T2 MatB), continue driving until
  // T2 MatB fills and W1 cycles out of T2.

  sep("Main loop — T1B forceCross to generate T2 members");

  let iter         = 0;
  let t1bCrossed   = 0;
  let t2aCrossed   = 0;
  let t2aCyclesDone = 0;
  let t2bFilled    = false;
  let t2aPrevRot   = await matA2.rotationCount();
  let parkedT1A    = [...t1aParkedInit]; // working queue

  while (iter < MAX_ITERS) {
    iter++;

    // ── Goal check ──────────────────────────────────────────────────────────
    const w1T2cyc = await tierRouter.tierCycles(W1_ADDR, 1);
    if (w1T2cyc >= 1n) {
      sep("T2 CYCLE COMPLETE");
      console.log(`  W1 has completed T2 cycle! tierCycles(W1, 1) = ${w1T2cyc}`);
      break;
    }

    const t2bOcc = await matB2.occupancy();
    const t2aOcc = await matA2.occupancy();
    const t1bOcc = await matB1.occupancy();

    // ── Refresh parked T1A queue if empty ───────────────────────────────────
    if (parkedT1A.length === 0) {
      parkedT1A = await getParked(matA1, matB1, scanSet, null);
      if (parkedT1A.length === 0) {
        console.log(`\n  STOP  No parked T1A wallets remaining.`);
        console.log(`        Run bigfill_v8.js (HDR_OFFSET=2000+ COUNT=200) to register more members.`);
        break;
      }
      console.log(`  Refreshed parked T1A queue: ${parkedT1A.length} wallets`);
    }

    const t1aTarget = parkedT1A.shift();

    // ── T1B forceCross ───────────────────────────────────────────────────────
    // Peek at who's root of T1B right now — that's who will cycle out
    const nextT1BRoot = await matB1.posToMember(1n);

    const t2aOccBefore = await matA2.occupancy();
    const t2bOccBefore = await matB2.occupancy();

    const t1bStatus = Number(t1bOcc) >= Number(mSize) ? `${t1bOcc}/${mSize}(cycling)` : `${t1bOcc}→${Number(t1bOcc)+1}/${mSize}`;
    process.stdout.write(
      `  [${String(iter).padStart(3)}] T1B cross ${t1aTarget.slice(0,10)}  ` +
      `T1B ${t1bStatus}  ` +
      `T2A ${t2aOcc}/${mSize}  T2B ${t2bOcc}/${mSize}  `
    );

    try {
      await (await matA1.forceCross(t1aTarget, { gasLimit: GAS_LIMIT })).wait();
      t1bCrossed++;

      const t1bNow = await matB1.occupancy();
      let t2aNow   = await matA2.occupancy();
      const t2bNow = await matB2.occupancy();
      const w1TierNow = await tierRouter.memberHighestTier(W1_ADDR);

      // Detect what happened
      const t2aGained = Number(t2aNow) - Number(t2aOccBefore);
      const t2bGained = Number(t2bNow) - Number(t2bOccBefore);

      let note = `→ T1B ${t1bNow}  T2A ${t2aNow}  T2B ${t2bNow}  W1:T${w1TierNow}`;
      if (t2aGained > 0) note += `  (+${t2aGained} T2A)`;
      if (t2bGained > 0) note += `  (+${t2bGained} T2B !)`;
      console.log(note);

      // Auto-upgrade guard e failed (escrow < T2_FEE) → drive via manualUpgrade
      // The T1B root that just cycled out is the wallet we peeked at above.
      if (t2aGained === 0 && nextT1BRoot !== ethers.ZeroAddress) {
        process.stdout.write(`  ↳ T2A unchanged, manualUpgrade ${nextT1BRoot.slice(0,10)}… `);
        const upgraded = await fundAndManualUpgrade(
          nextT1BRoot, scanSet, usdc, tierRouter, addrs, T2_FEE, deployer, provider
        );
        if (upgraded) {
          t2aNow = await matA2.occupancy();
          console.log(`✓  T2A ${t2aNow}/${mSize}`);
        }
      }

      // Check if T2 MatA rotation count increased (T2 MatA cycled, root crossed/parked)
      const t2aRotNow = await matA2.rotationCount();
      if (t2aRotNow > t2aPrevRot) {
        const newCycles = Number(t2aRotNow) - Number(t2aPrevRot);
        t2aCyclesDone += newCycles;
        t2aPrevRot = t2aRotNow;
        console.log(`\n  *** T2 MatA cycled x${newCycles} (total T2A rotations: ${t2aRotNow}) ***`);
        if (newCycles === 1 && Number(t2aRotNow) === 1) {
          console.log(`  *** W1 has crossed to T2 MatB — T2B is now ${t2bNow}/${mSize} ***`);
        }

        // ── T2 MatA forceCross for parked T2A alumni ─────────────────────
        // Scan for T2 MatA alumni that couldn't self-fund the T2B crossing
        const t2aParked = await getParked(matA2, matB2, scanSet, W1_ADDR);
        if (t2aParked.length > 0) {
          console.log(`\n  T2A parked alumni: ${t2aParked.length} — pushing to T2B…`);

          // Ensure allowance is still sufficient
          const allow2Now = await usdc.allowance(deployerAddr, T2.matA);
          if (allow2Now < T2_FEE * BigInt(t2aParked.length)) {
            await (await usdc.approve(T2.matA, T2_FEE * BigInt(t2aParked.length + 10))).wait();
          }
          // Ensure USDC balance
          const dep2Usdc = await usdc.balanceOf(deployerAddr);
          if (dep2Usdc < T2_FEE * BigInt(t2aParked.length)) {
            const toMint2 = T2_FEE * BigInt(t2aParked.length + 10);
            await (await usdc.mint(deployerAddr, toMint2)).wait();
          }

          for (const t2aAddr of t2aParked) {
            const t2bBefore2 = await matB2.occupancy();
            process.stdout.write(`    T2A cross ${t2aAddr.slice(0,10)}… `);
            try {
              await (await matA2.forceCross(t2aAddr, { gasLimit: GAS_LIMIT })).wait();
              t2aCrossed++;
              const t2bAfter2 = await matB2.occupancy();
              console.log(`T2B ${t2bBefore2} → ${t2bAfter2}/${mSize}`);
            } catch (e) {
              console.log(`FAILED: ${e.message.slice(0, 80)}`);
              if (e.message.includes("nonce too low") || e.message.includes("nonce has already been used")) {
                deployer.reset();
                await sleep(3);
              }
            }
          }
        } else {
          console.log(`  (T2A parked: 0 — all T2A alumni self-funded their T2B crossing)`);
        }
        console.log("");
      }

    } catch (e) {
      console.log(`FAILED`);
      console.warn(`    ERR: ${e.message.slice(0, 120)}`);
      if (e.message.includes("nonce too low") || e.message.includes("nonce has already been used")) {
        deployer.reset();
        await sleep(3);
      }
      // Put the wallet back at the end of the queue for retry
      parkedT1A.push(t1aTarget);
    }

    await sleep(1); // 1s pause to avoid hammering RPC
  }

  // ── Final snapshot + summary ─────────────────────────────────────────────────
  await snapshot("FINAL STATE", { tierRouter, matA1, matB1, matA2, matB2, stabilityFund, w1Addr: W1_ADDR });

  sep("SUMMARY");
  console.log(`  Iterations run:         ${iter}`);
  console.log(`  T1B forceCross calls:   ${t1bCrossed}`);
  console.log(`  T2A forceCross calls:   ${t2aCrossed}`);
  console.log(`  T2A cycle-outs seen:    ${t2aCyclesDone}`);

  const finalW1Tier   = await tierRouter.memberHighestTier(W1_ADDR);
  const finalW1T2cyc  = await tierRouter.tierCycles(W1_ADDR, 1);
  const finalT2bOcc   = await matB2.occupancy();

  if (finalW1T2cyc >= 1n) {
    console.log(`\n  SUCCESS  W1 completed full T2 cycle!`);
    console.log(`  W1 tier: T${finalW1Tier}   T2-cycles: ${finalW1T2cyc}`);
    console.log(`\n  Next steps:`);
    console.log(`    1. Community testing — invite 3-5 real wallets to v8.crypto-nova.app`);
    console.log(`    2. Register Chainlink Automation for MatrixKeeper.sol (gasLimit 6M)`);
    console.log(`    3. Fund upkeep with LINK on Base Sepolia`);
  } else {
    console.log(`\n  W1 has NOT yet completed T2 cycle. T2B: ${finalT2bOcc}/${mSize}`);
    console.log(`  Re-run fill_t2.js to continue. T2B needs ${Number(mSize) - Number(finalT2bOcc)} more members.`);
    console.log(`\n  If parked T1A wallets are exhausted, run first:`);
    console.log(`    $env:COUNT="200"; $env:HDR_OFFSET="2000"`);
    console.log(`    npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
  }
  sep();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
