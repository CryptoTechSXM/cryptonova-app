// diag_velocity_gate.js — WHY IS A TIER "Auto-Paused"? Read-only, no signer.
//
// ⛔ THE QUESTION THIS EXISTS FOR (session 33, 2026-08-23). The frontend's tier table
//    showed T4 "Nova Core", T5 "Nova Prime" and T6+ as **Auto-Paused** while T1-T3 read
//    Open, and the owner reported T4/T5 "moving very slow". That pill is NOT the Whale
//    Gate. `index.html` renders it from `TierRouter.getVelocityGates()`, i.e.
//    `tierVelocityGreen[]` — the VELOCITY gate, which the keeper writes.
//
// ⛔⛔ THE LOOP THIS PRINTS, AND THE REASON IT IS WORTH A FILE.
//    `MatrixKeeper._doVelocityCheck()` runs every tier through:
//        cnt   = tierRouter.getTierEntryCount(t, now - velocityWindow)
//        green = cnt >= velocityThreshold
//    Shipped defaults: velocityWindow 3600s, velocityThreshold 3 — **three entries an
//    hour, per tier.** A tier that goes quiet is set NOT GREEN.
//    And `TierRouter:1398` makes the auto-upgrade at cycle-out conditional on
//    `tierVelocityGreen[nextIndex]`. So:
//
//        few entries -> gate closes -> auto-upgrades INTO the tier are blocked
//                    -> even fewer entries -> gate stays closed
//
//    **A slow tier is made slower by the thing that measured it as slow.** At $250 (T5)
//    and $500 (T6), three entries per hour is a bar the upper tiers may never clear on
//    their own, and nothing in the check ever grants an exception for a tier that has
//    simply not been reached yet.
//
// ✅ THE ONE ESCAPE HATCH, AND WHY IT MAY NOT BE FIRING. `TierRouter:1180-1183` force-opens
//    the NEXT tier's gate when a member crosses into MatB ("MatB crossing IS the gate-open
//    signal", V8.15). So the gate should reopen whenever somebody crosses in the tier below.
//    If a tier is closed while the tier below IS crossing members, that escape hatch is not
//    working and THAT is the bug — this script prints both halves so the two cannot be
//    confused.
//
// ⚠ WHAT THIS SCRIPT DOES NOT DO. It does not prove the gate is what is holding a member
//    back — manual upgrades and the Whale Gate are separate paths, and the velocity gate
//    binds only the AUTOMATIC upgrade at cycle-out. It reports the gate, the entry rate
//    that drives it, and whether the tier below is crossing. Deciding is not its job.
//
// Run (from CryptoNite-Smart-Contracts/CryptoNova/):
//   $env:ADDRESSES_FILE = "deployed_addresses_v8_48.json"
//   node scripts\diag_velocity_gate.js
"use strict";
const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
if (!RPC_URL) { console.error("FATAL: BASE_SEPOLIA_RPC_URL not set in .env"); process.exit(1); }

// Same refusal-to-guess as diag_sf_debt_reconcile.js: a diagnostic pointed at the wrong
// deployment prints confident numbers about a chain nobody asked about.
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) { console.error("FATAL: ADDRESSES_FILE is not set. Refusing to guess a deployment."); process.exit(1); }
const A = require(path.join(__dirname, ADDRFILE));

const TIER_KEYS = ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10"];
const NAMES = ["Nova Seed","Nova Rise","Nova Star","Nova Core","Nova Prime","Nova Apex",
               "Nova Pinnacle","SuperNova Titan","SuperNova Legend","SuperNova Apex"];

const TR_ABI = [
  "function getVelocityGates() view returns (bool[10])",
  "function getTierEntryCount(uint8 tier, uint256 fromTimestamp) view returns (uint256)",
  "function highestOpenTier() view returns (uint8)",
  "function tierPairManagers(uint256) view returns (address)",
];
const MK_ABI = [
  "function velocityWindow() view returns (uint256)",
  "function velocityThreshold() view returns (uint256)",
  "function lastVelocityCheck() view returns (uint256)",
  "function configuredTierCount() view returns (uint8)",
];
const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address matA, address matB)",
];
const MAT_ABI = [
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
];

const ago = (secs) => {
  if (secs < 0) return "in the future";
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  return `${(secs / 3600).toFixed(1)}h ago`;
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const tr = new ethers.Contract(A.tierRouter,   TR_ABI, provider);
  const mk = new ethers.Contract(A.matrixKeeper, MK_ABI, provider);

  const blk = await provider.getBlock("latest");
  const now = blk.timestamp;

  const [gates, window_, threshold, lastCheck, tierCount, highest] = await Promise.all([
    tr.getVelocityGates(), mk.velocityWindow(), mk.velocityThreshold(),
    mk.lastVelocityCheck(), mk.configuredTierCount(), tr.highestOpenTier(),
  ]);
  const windowStart = BigInt(now) - window_;

  // WINDOW_SECS: a SECOND, wider window, for "where did the ladder actually stop?".
  // The gate's own 3600s window answers "is the gate open"; it cannot answer "did
  // anybody climb today", because a tier can take 2 entries an hour all day and still
  // read red on every check. These are different questions and the script prints both
  // rather than letting one stand in for the other.
  const wideSecs = process.env.WINDOW_SECS ? BigInt(process.env.WINDOW_SECS) : null;
  const wideStart = wideSecs ? BigInt(now) - wideSecs : null;

  console.log("=".repeat(96));
  console.log("  VELOCITY GATE — why a tier reads Auto-Paused");
  console.log(`  addresses ${ADDRFILE}`);
  console.log(`  TierRouter ${A.tierRouter}`);
  console.log(`  block ${blk.number} @ ${new Date(now * 1000).toISOString()}`);
  console.log("=".repeat(96));
  console.log(`  RULE IN FORCE: green = (entries in last ${window_}s) >= ${threshold}`);
  console.log(`  last velocity check ${lastCheck === 0n ? "NEVER" : ago(now - Number(lastCheck))}` +
              `   configuredTierCount ${tierCount}   highestOpenTier ${highest}`);
  console.log("");
  if (wideStart !== null)
    console.log(`  WIDE WINDOW: also counting entries in the last ${wideSecs}s ` +
                `(${(Number(wideSecs) / 3600).toFixed(1)}h) — "did anybody climb", which the gate window cannot answer.`);
  console.log("");
  console.log("  tier  name              deployed  gate         entries/window  needs  " +
              (wideStart !== null ? "entries/WIDE  " : "") + "tier BELOW crossing?");
  console.log("  " + "-".repeat(wideStart !== null ? 106 : 92));

  const rows = [];
  for (let i = 0; i < 10; i++) {
    const pm = await tr.tierPairManagers(i);
    const deployed = pm !== ethers.ZeroAddress;
    let cnt = null;
    try { cnt = await tr.getTierEntryCount(i, windowStart); } catch { /* leave null */ }
    let wide = null;
    if (wideStart !== null) {
      try { wide = await tr.getTierEntryCount(i, wideStart); } catch { /* leave null */ }
    }

    // "Is the tier below crossing?" — rotations on the tier-below MatB are the escape
    // hatch's trigger (TierRouter:1180). Read as a LEVEL here, not a rate; the caveat
    // is printed below rather than hidden.
    let belowRot = null;
    if (i > 0) {
      try {
        const pmB = await tr.tierPairManagers(i - 1);
        if (pmB !== ethers.ZeroAddress) {
          const pmc = new ethers.Contract(pmB, PM_ABI, provider);
          const n = await pmc.pairCount();
          let tot = 0n;
          for (let p = 0n; p < n; p++) {
            const [, matB] = await pmc.getPairAt(p);
            if (matB !== ethers.ZeroAddress)
              tot += await new ethers.Contract(matB, MAT_ABI, provider).rotationCount();
          }
          belowRot = tot;
        }
      } catch { /* leave null */ }
    }

    rows.push({ i, deployed, green: gates[i], cnt, wide, belowRot });
    console.log(
      `  T${String(i + 1).padEnd(4)}${NAMES[i].padEnd(18)}` +
      `${(deployed ? "yes" : "NO ").padEnd(10)}` +
      `${(gates[i] ? "OPEN" : "AUTO-PAUSED").padEnd(13)}` +
      `${(cnt === null ? "unreadable" : String(cnt)).padEnd(16)}` +
      `${String(threshold).padEnd(7)}` +
      `${wideStart !== null ? String(wide === null ? "?" : wide).padEnd(11) : ""}` +
      `${belowRot === null ? "-" : belowRot + " MatB rotations"}`
    );
  }

  console.log("");
  console.log("  ── WHAT THIS SAYS ──");
  const stuck = rows.filter(r => r.deployed && !r.green);
  if (!stuck.length) {
    console.log("  ✅ Every deployed tier is OPEN. The velocity gate is not throttling anything.");
  } else {
    for (const r of stuck) {
      const below = r.i > 0 ? rows[r.i - 1] : null;
      const belowMoving = below && below.belowRot !== null;
      console.log(`  ⛔ T${r.i + 1} is AUTO-PAUSED with ${r.cnt === null ? "?" : r.cnt} entr` +
                  `${r.cnt === 1n ? "y" : "ies"} in the window (needs ${threshold}).`);
      console.log(`     Auto-upgrades INTO T${r.i + 1} at cycle-out are blocked while this is false ` +
                  `(TierRouter:1398).`);
      if (r.i > 0 && belowMoving) {
        console.log(`     ⚠ T${r.i} HAS crossed members into MatB (${rows[r.i - 1].belowRot} rotations ` +
                    `lifetime). TierRouter:1180 force-opens this gate on a MatB crossing, so a gate ` +
                    `that is STILL closed means either no crossing has happened recently, or the ` +
                    `velocity check re-closed it afterwards. Those are different faults — separate ` +
                    `them with VelocityUpdated / VelocityGateSet event timestamps before acting.`);
      }
    }
    console.log("");
    console.log("  ⚠ THE FEEDBACK LOOP, STATED: a tier below threshold is closed, being closed blocks");
    console.log("    the auto-upgrades that would have been its entries, and the next check therefore");
    console.log("    measures it as slow again. Read the two columns together — a tier with 0 entries");
    console.log("    AND a closed gate cannot distinguish 'nobody wanted in' from 'nobody was let in'.");
  }
  if (wideStart !== null) {
    console.log("");
    console.log(`  ── WHERE THE LADDER STOPPED IN THE LAST ${(Number(wideSecs) / 3600).toFixed(1)}h ──`);
    const climbed = rows.filter(r => r.wide !== null && r.wide > 0n);
    const top = climbed.length ? Math.max(...climbed.map(r => r.i)) : -1;
    if (top < 0) {
      console.log("  ⛔ NOBODY entered ANY tier in this window. That is a stopped system, not a slow one.");
    } else {
      console.log(`  Highest tier anyone entered: T${top + 1} (${rows[top].wide} entr${rows[top].wide === 1n ? "y" : "ies"}).`);
      for (const r of rows) {
        if (!r.deployed) continue;
        const tag = r.wide === 0n ? "  <-- NOBODY entered this tier in the window" : "";
        console.log(`    T${String(r.i + 1).padEnd(4)} ${String(r.wide).padStart(5)} entries${tag}`);
      }
      console.log("");
      console.log("  ⚠ READ THIS AGAINST THE GATE COLUMN, NOT INSTEAD OF IT. A tier with entries in the");
      console.log("    wide window but a closed gate is being throttled. A tier with ZERO in the wide");
      console.log("    window has nobody trying — and for those, opening the gate changes nothing.");
      console.log("    ⛔ A MANUAL upgrade (bigfill) does not need the gate open; an AUTOMATIC upgrade");
      console.log("       at cycle-out does. Entries here do NOT say which path they came through.");
    }
  }

  console.log("");
  console.log("  ⚠ CAVEATS. Entry counts are a LIVE window and change between runs — re-run before");
  console.log("    quoting one. 'tier below crossing' is a LIFETIME rotation total, not a rate, so it");
  console.log("    answers 'has it ever' and not 'is it now'. The velocity gate binds only the");
  console.log("    AUTOMATIC upgrade at cycle-out; manual upgrades and the Whale Gate are separate.");
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
