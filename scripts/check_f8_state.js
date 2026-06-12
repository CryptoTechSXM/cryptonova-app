"use strict";
/**
 * check_f8_state.js — V7 Figure-8 State Inspector
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads deployed_addresses.json and prints full V7 state:
 *   · Both matrix positions + escrow balances
 *   · Wallet #1 earnings, escrow, crossing funds
 *   · Pool health monitor snapshot
 *   · CNOVA / treasury stats
 *   · Governance state
 *
 * Run: npx hardhat run scripts/check_f8_state.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");

function sep(label = "") {
  if (label) console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 50 - label.length))}`);
  else        console.log(`  ${"─".repeat(54)}`);
}
function fmt6(n)  { return "$" + (Number(n) / 1e6).toFixed(4); }
function fmt18(n) { return (Number(ethers.formatEther(n))).toFixed(4) + " CNOVA"; }

async function main() {
  // Load addresses
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n  ❌  ${ADDRESSES_FILE} not found.`);
    console.error(`  Run deploy_figure8_test.js first.\n`);
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  // W1 = Account #1, derived from the key used at deploy — no hardcoded address
  const W1 = addrs.AccountOne;

  const matA     = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB     = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const cnova    = await ethers.getContractAt("CNOVAToken",        addrs.CNOVAToken);
  const treasury = await ethers.getContractAt("CNOVATreasury",     addrs.CNOVATreasury);
  const gov      = await ethers.getContractAt("CNOVAGovernance",   addrs.CNOVAGovernance);

  // Load all pairs from PairManager if available
  let allPairs = [{ matrixA: addrs.MatrixA, matrixB: addrs.MatrixB, label: "Pair 1 (A↔B)" }];
  let activePairIdx = 0;
  if (addrs.PairManager) {
    try {
      const pm = await ethers.getContractAt("PairManager", addrs.PairManager);
      const status = await pm.allPairsStatus();
      activePairIdx = Number(await pm.activePairIndex());
      allPairs = [];
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (let i = 0; i < status.matrixAs.length; i++) {
        allPairs.push({
          matrixA: status.matrixAs[i],
          matrixB: status.matrixBs[i],
          label:   `Pair ${i + 1} (${letters[i*2]}↔${letters[i*2+1]})`,
          active:  status.active[i],
          registered: Number(status.registered[i])
        });
      }
    } catch(_) { /* PairManager not available, use defaults */ }
  }

  console.log("\n  ╔══════════════════════════════════════════════════════╗");
  console.log("  ║       CryptoNova V7 — Figure-8 State Inspector      ║");
  console.log("  ╚══════════════════════════════════════════════════════╝");
  console.log(`  Deployed: ${addrs.deployedAt}`);
  console.log(`  Network:  ${addrs.network}`);

  // ── All pairs overview ────────────────────────────────────────────────────
  const mSize = await matA.MATRIX_SIZE();

  if (addrs.PairManager) {
    sep(`ALL PAIRS  (active: Pair ${activePairIdx + 1})`);
    for (let i = 0; i < allPairs.length; i++) {
      const p  = allPairs[i];
      const mA = await ethers.getContractAt("FigureEightMatrix", p.matrixA);
      const mB = await ethers.getContractAt("FigureEightMatrix", p.matrixB);
      const [oA, tA, rA] = await Promise.all([mA.occupancy(), mA.totalJoined(), mA.rotationCount()]);
      const [oB, tB, rB] = await Promise.all([mB.occupancy(), mB.totalJoined(), mB.rotationCount()]);
      const combined = Number(oA) + Number(oB);
      const pct      = Math.round(combined * 100 / (Number(mSize) * 2));
      const isActive = (i === activePairIdx);
      const tag      = isActive ? " ← ACTIVE (100% of new registrations)" : " (cycling — existing members only)";
      console.log(`  ${p.label}${tag}  ${combined}/${Number(mSize)*2} combined (${pct}%)`);
      console.log(`    Matrix A: ${oA}/${mSize} occ | ${tA} joined | ${rA} rotations`);
      console.log(`    Matrix B: ${oB}/${mSize} occ | ${tB} joined | ${rB} rotations`);
    }
  } else {
    sep("MATRIX OVERVIEW");
    const [occA, totA, rotA, joinA] = await Promise.all([
      matA.occupancy(), matA.totalJoined(), matA.rotationCount(), matA.joinCountSinceRotation()
    ]);
    const [occB, totB, rotB] = await Promise.all([
      matB.occupancy(), matB.totalJoined(), matB.rotationCount()
    ]);
    console.log(`  Matrix A:  ${occA}/${mSize} occupied | ${totA} total joined | ${rotA} rotations | ${joinA} since last rotation`);
    console.log(`  Matrix B:  ${occB}/${mSize} occupied | ${totB} total joined | ${rotB} rotations`);
  }

  // ── Follow Me Escrow totals ────────────────────────────────────────────────
  sep("FOLLOW ME ESCROW");
  const escrowTotalA = await matA.totalEscrowHeld();
  const escrowTotalB = await matB.totalEscrowHeld();
  console.log(`  Pair 1 Matrix A escrow: ${fmt6(escrowTotalA)}`);
  console.log(`  Pair 1 Matrix B escrow: ${fmt6(escrowTotalB)}`);
  const entryFee   = Number(await matA.ENTRY_FEE());
  const escrowBps  = Number(await matA.SPLIT_ESCROW_BPS());
  const perEntry   = entryFee * escrowBps / 10000;
  const mSizeNum   = Number(mSize);
  console.log(`  Per-entry escrow credit:    ${fmt6(perEntry)} ($1.50 @ 15%)`);
  console.log(`  ${mSizeNum}-member target for root:  ${fmt6(perEntry * (mSizeNum - 1))} (${mSizeNum-1} × $1.50 before crossing)`);

  // ── Pool health monitor ────────────────────────────────────────────────────
  sep("ORPHAN FEE HEALTH MONITOR");
  const health = await matA.poolHealthSnapshot();
  console.log(`  Escrow routed (total):   ${fmt6(health.escrowRouted)}`);
  console.log(`  Founders routed (total): ${fmt6(health.foundersRouted)}`);
  console.log(`  Escrow share:            ${health.escrowPct}%`);
  console.log(`  Routing state:           ${health.healthState}`);

  // ── Wallet #1 ─────────────────────────────────────────────────────────────
  sep(`WALLET #1   ${W1.slice(0, 10)}...`);
  const mA  = await matA.getMember(W1);
  const mB  = await matB.getMember(W1);
  const escA = await matA.escrowOf(W1);
  const escB = await matB.escrowOf(W1);
  const [crossTotal, crossEsc, crossEarn] = await matA.crossingFundsOf(W1);

  console.log(`  Matrix A:`);
  console.log(`    In matrix:      ${mA.isInMatrix ? "YES" : "no"}  |  Position: ${await matA.matrixPos(W1)}`);
  console.log(`    Cycles done:    ${mA.cyclesCompleted}`);
  console.log(`    Withdrawable:   ${fmt6(mA.withdrawable)}`);
  console.log(`    Escrow balance: ${fmt6(escA)}  (crossing fund)`);
  console.log(`    Total earned:   ${fmt6(mA.totalEarned)}`);
  console.log(`    Crossing ready: ${fmt6(crossTotal)} total  (${fmt6(crossEsc)} escrow + ${fmt6(crossEarn)} earnings)`);
  const canCross = (BigInt(escA) + BigInt(mA.withdrawable)) >= BigInt(entryFee);
  console.log(`    Can self-cross: ${canCross ? "✅ YES" : "❌ NO — forceCross needed"}`);

  console.log(`  Matrix B:`);
  console.log(`    In matrix:      ${mB.isInMatrix ? "YES" : "no"}  |  Position: ${await matB.matrixPos(W1)}`);
  console.log(`    Cycles done:    ${mB.cyclesCompleted}`);
  console.log(`    Withdrawable:   ${fmt6(mB.withdrawable)}`);
  console.log(`    Escrow balance: ${fmt6(escB)}`);

  // ── Matrix A positions (filled slots only) ────────────────────────────────
  sep("MATRIX A — BFS POSITIONS (filled only)");
  let filledA = 0;
  for (let i = 1; i <= Number(mSize); i++) {
    const addr = await matA.posToMember(i);
    if (addr !== ethers.ZeroAddress) {
      filledA++;
      const m   = await matA.getMember(addr);
      const esc = await matA.escrowOf(addr);
      const tag = addr.toLowerCase() === W1.toLowerCase() ? " ← #1 (root)" : "";
      console.log(
        `  Pos ${String(i).padStart(3)}: ${addr.slice(0,10)}...` +
        `  earn:${fmt6(m.withdrawable).padEnd(10)}` +
        `  escrow:${fmt6(esc)}${tag}`
      );
    }
  }
  if (filledA === 0) console.log("  (no members in Matrix A)");

  // ── Matrix B positions (filled slots only) ────────────────────────────────
  sep("MATRIX B — BFS POSITIONS (filled only)");
  let filledB = 0;
  for (let i = 1; i <= Number(mSize); i++) {
    const addr = await matB.posToMember(i);
    if (addr !== ethers.ZeroAddress) {
      filledB++;
      const m   = await matB.getMember(addr);
      const esc = await matB.escrowOf(addr);
      const tag = addr.toLowerCase() === W1.toLowerCase() ? " ← #1" : "";
      console.log(
        `  Pos ${String(i).padStart(3)}: ${addr.slice(0,10)}...` +
        `  earn:${fmt6(m.withdrawable).padEnd(10)}` +
        `  escrow:${fmt6(esc)}${tag}`
      );
    }
  }
  if (filledB === 0) console.log("  (no members in Matrix B)");

  // ── CNOVA & Treasury ──────────────────────────────────────────────────────
  sep("CNOVA & TREASURY");
  const supply    = await cnova.totalSupply();
  const minted    = await cnova.totalMinted();
  const epoch     = await cnova.currentEpochNumber();
  const rewardPct = await cnova.rewardPct();
  const reserve   = await treasury.usdcReserve();
  const floor     = await treasury.floorPrice();

  console.log(`  Total supply:   ${fmt18(supply)}`);
  console.log(`  Total minted:   ${fmt18(minted)}`);
  console.log(`  Epoch:          ${epoch}/9  ${epoch == 9 ? "← Final Frontier" : ""}`);
  console.log(`  rewardPct:      ${rewardPct}%  (governable, 10–75%)`);
  console.log(`  Treasury:       ${fmt6(reserve)}`);
  const floorNum = Number(floor) / 1e6;
  console.log(`  Floor price:    ${floorNum < 0.000001 ? "not set" : "$" + floorNum.toFixed(6)} per CNOVA`);
  if (floorNum > 0) {
    const ffReward = Math.min(2.5, Number(rewardPct) * 1.5 / floorNum);
    console.log(`  FF reward now:  ~${ffReward.toFixed(4)} CNOVA  (min(2.5, ${rewardPct}% × $1.50 / floor))`);
  }

  // ── Governance ────────────────────────────────────────────────────────────
  sep("GOVERNANCE");
  const univMode  = await treasury.isUniverseMode();
  const propCount = await gov.proposalCount();
  const minCreate = await gov.minCreateBurn();
  const minQuorum = await gov.minQuorumBurn();
  const votPeriod = await gov.votingPeriod();
  const execDelay = await gov.executionDelay();
  const isPaused  = await gov.paused();

  console.log(`  Universe Mode:     ${univMode ? "✅ ACTIVE — governance live" : "⏳ locked (needs 500 members)"}`);
  console.log(`  Paused:            ${isPaused ? "⚠️  YES" : "no"}`);
  console.log(`  Proposals created: ${propCount}`);
  console.log(`  minCreateBurn:     ${fmt18(minCreate)}`);
  console.log(`  minQuorumBurn:     ${fmt18(minQuorum)}`);
  console.log(`  votingPeriod:      ${Number(votPeriod)/3600}h`);
  console.log(`  executionDelay:    ${Number(execDelay)/3600}h`);

  if (Number(propCount) > 0) {
    sep("ACTIVE PROPOSALS");
    for (let i = 1; i <= Number(propCount); i++) {
      const p     = await gov.getProposal(i);
      const state = await gov.proposalState(i);
      const states = ["ACTIVE","PASSED","QUEUED","EXECUTED","DEFEATED","CANCELED"];
      const now   = Math.floor(Date.now() / 1000);
      const timeLeft = Number(p.endTime) > now
        ? `${Math.round((Number(p.endTime) - now) / 3600)}h left`
        : "closed";
      console.log(`  #${i}: [${states[state]}] ${p.description.slice(0, 40)}`);
      console.log(`       FOR: ${fmt18(p.burnedFor)}  AGAINST: ${fmt18(p.burnedAgainst)}  (${timeLeft})`);
    }
  }

  sep();
  console.log("  Done.\n");
}

main().catch(e => { console.error(e); process.exit(1); });
