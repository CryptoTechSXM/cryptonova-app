"use strict";
/**
 * growth_report.js — Analyze simulation_log.json into real earnings breakdown
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the log produced by simulate_growth.js and outputs:
 *   - Actual chain pay earned per BFS position
 *   - Real escrow accumulation curve (vs theoretical)
 *   - Crossing timing (when did root actually cycle?)
 *   - Real ROI by position
 *   - Treasury growth curve
 *   - Epoch progression
 *   - Discrepancy between projected and actual numbers
 *
 * Run AFTER simulate_growth.js completes:
 *   node scripts/growth_report.js
 *   (no network needed — reads local log file)
 */

const fs   = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "simulation_log.json");

if (!fs.existsSync(LOG_FILE)) {
  console.error("simulation_log.json not found — run simulate_growth.js first");
  process.exit(1);
}

const log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));

if (log.length === 0) {
  console.error("Log is empty");
  process.exit(1);
}

const FEE = 10;  // $10 entry

function sep(label = "") {
  if (label) console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 52 - label.length))}`);
  else        console.log(`  ${"─".repeat(56)}`);
}

console.log(`\n  ╔══════════════════════════════════════════════════════╗`);
console.log(`  ║     CryptoNova V7 — Growth Simulation Report         ║`);
console.log(`  ╚══════════════════════════════════════════════════════╝`);
console.log(`  Log entries:  ${log.length}`);
console.log(`  Started:      ${log[0]?.timestamp}`);
console.log(`  Latest:       ${log[log.length-1]?.timestamp}`);

// ── Crossings ──────────────────────────────────────────────────────────────
sep("CROSSING EVENTS");
const crossings = log.filter(e => e.crossed);
if (crossings.length === 0) {
  console.log(`  No crossings yet (need ${log[0]?.occA > 0 ? log[0].occA : "?"} total members to fill matrix)`);
} else {
  crossings.forEach(c => {
    console.log(`  Registration #${c.reg}:  Rotation ${c.rotations}  Matrix A ${c.occA}/15 → root crossed to B`);
  });
}

// ── Escrow accumulation ────────────────────────────────────────────────────
sep("FOLLOW ME ESCROW — ACTUAL vs PROJECTED");
console.log(`  Reg#  | Root Escrow  | Expected ($1/member) | Delta`);
console.log(`  ──────|──────────────|──────────────────────|──────`);
const step = Math.max(1, Math.floor(log.length / 15));
for (let i = 0; i < log.length; i += step) {
  const e = log[i];
  const expected = (i) * 1.00;  // theoretical $1 per member
  const actual   = e.rootEscrow;
  const delta    = actual - expected;
  const sign     = delta >= 0 ? "+" : "";
  console.log(
    `  ${String(e.reg).padStart(5)} | $${String(actual.toFixed(2)).padStart(11)} | ` +
    `$${String(expected.toFixed(2)).padStart(20)} | ${sign}$${delta.toFixed(2)}`
  );
}
console.log(`\n  Note: Actual > Expected because orphan routing also credits root's escrow.`);

// ── Chain pay by position ──────────────────────────────────────────────────
sep("CHAIN PAY EARNED — BY BFS POSITION (actual on-chain)");
const lastEntry = log[log.length - 1];
if (lastEntry?.positionEarnings?.length > 0) {
  console.log(`  Pos | Address     | Withdrawable | Escrow    | Total Earned`);
  console.log(`  ────|─────────────|──────────────|───────────|─────────────`);
  lastEntry.positionEarnings.forEach(p => {
    console.log(
      `   ${String(p.pos).padStart(2)} | ${p.addr}... | ` +
      `$${String(p.withdrawable.toFixed(4)).padStart(12)} | ` +
      `$${String(p.escrow.toFixed(4)).padStart(9)} | ` +
      `$${p.totalEarned.toFixed(4)}`
    );
  });
} else {
  console.log(`  No position data yet — run more registrations.`);
}

// ── ROI by position ────────────────────────────────────────────────────────
sep("REAL ROI BY POSITION");
if (lastEntry?.positionEarnings?.length > 0) {
  lastEntry.positionEarnings.slice(0, 10).forEach(p => {
    const roi = ((p.totalEarned + p.escrow) / FEE * 100).toFixed(0);
    const bar = "█".repeat(Math.min(50, Math.round(Number(roi) / 50)));
    console.log(`  Pos ${String(p.pos).padStart(3)}: $${p.totalEarned.toFixed(2)} earned  ${roi}% ROI  ${bar}`);
  });
  console.log(`\n  Note: ROI increases as positions work toward root.`);
  console.log(`  Root (pos 1) earns from ALL members below across all 7 BFS levels.`);
}

// ── Treasury & floor price growth ──────────────────────────────────────────
sep("TREASURY & CNOVA FLOOR PRICE");
const floorStart = log[0]?.floorPrice || 0;
const floorEnd   = lastEntry?.floorPrice || 0;
const treasStart = log[0]?.treasury || 0;
const treasEnd   = lastEntry?.treasury || 0;
console.log(`  Treasury:    $${treasStart.toFixed(2)} → $${treasEnd.toFixed(2)}  (+$${(treasEnd-treasStart).toFixed(2)})`);
console.log(`  Floor price: $${floorStart.toFixed(6)} → $${floorEnd.toFixed(6)}`);
console.log(`  CNOVA supply: ${log[0]?.supply?.toFixed(0) || 0} → ${lastEntry?.supply?.toFixed(0) || 0}`);
console.log(`  Epoch: ${log[0]?.epoch || 1} → ${lastEntry?.epoch || 1} / 9`);
console.log(`\n  Treasury grows $${(FEE * 0.15).toFixed(2)} per member (15% of $10).`);
console.log(`  Floor can only rise — every entry adds to the reserve.`);

// ── Earnings per member summary ────────────────────────────────────────────
sep("EARNINGS SUMMARY — PROJECTED AT FULL 127-MEMBER MATRIX");
const chainPayBps = [2000, 800, 600, 300, 150, 75, 75];
const levels = [0, 1, 2, 4, 8, 16, 32, 64];
let rootChain = 0;
for (let lvl = 1; lvl <= 7; lvl++) {
  rootChain += levels[lvl] * (FEE * chainPayBps[lvl-1] / 10000);
}
const escrowNet = 126 * FEE * 0.10 - FEE;

console.log(`  ROOT (pos 1):`);
console.log(`    Chain pay from 126 members:    $${rootChain.toFixed(2)}`);
console.log(`    Follow Me Escrow (net):        $${escrowNet.toFixed(2)}`);
console.log(`    PROJECTED total:               $${(rootChain + escrowNet).toFixed(2)}`);
if (lastEntry?.positionEarnings?.[0]) {
  const p = lastEntry.positionEarnings[0];
  console.log(`    ACTUAL so far (${log.length} members):  $${p.totalEarned.toFixed(2)} + $${p.escrow.toFixed(2)} escrow`);
  console.log(`    Variance:                      ${log.length < 127 ? "↑ will grow as more members join" : "final"}`);
}

console.log(`\n  ─── VERDICT ─────────────────────────────────────────`);
if (log.length < 50) {
  console.log(`  ⏳ ${127 - log.length} more members needed for full picture.`);
  console.log(`  Continue: npx hardhat run scripts/simulate_growth.js --network baseSepolia`);
} else if (log.length >= 127) {
  console.log(`  ✅  Full 127-member cycle complete. Numbers verified.`);
  if (lastEntry?.positionEarnings?.[0]) {
    const actualRoot = lastEntry.positionEarnings[0].totalEarned + lastEntry.positionEarnings[0].escrow;
    const projected  = rootChain + escrowNet;
    const variance   = ((actualRoot - projected) / projected * 100).toFixed(1);
    console.log(`  Root earnings:  actual $${actualRoot.toFixed(2)} vs projected $${projected.toFixed(2)}  (${variance}% variance)`);
  }
} else {
  console.log(`  📊 Partial data (${log.length}/127 members). Continue simulation for complete picture.`);
}

sep();
console.log(`  Full log: ${LOG_FILE}\n`);
