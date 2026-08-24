// set_velocity_gate.js — set the velocity gate's window and threshold. WRITES TO CHAIN.
//
// THE DECISION THIS EXECUTES (session 36, 2026-08-24, owner). 33.8 established that the
// velocity gate binds only the AUTOMATIC upgrade at cycle-out — the path real members use
// — while bigfill upgrades through `manualUpgrade`, which never reads it. So the gate
// throttles roughly a dozen organic leaders today and would throttle EVERYONE at community
// launch. Shipped defaults are `velocityWindow 3600` / `velocityThreshold 3`: three entries
// an hour, per tier.
//
// OWNER'S CALL: window 14400 (4h), threshold 2 — one entry per two hours, 6x looser than
// the shipped 3/hour, and not the loosest available. The reasoning, kept because the
// obvious answer was the wrong one:
//
//   The ONLY case separating threshold 1 from 2 is a tier seeing exactly one entry in the
//   window. Threshold 1 opens that tier and auto-promotes members into it. But this
//   session's own seat census (36.5) measured the crossing shortfall by tier —
//   T1 $4.48 · T2 $11.20 · T3 $20.70 · T4 $44.80 — so promotion into a thin HIGH tier is
//   how a member acquires the largest shortfall in the system. An over-open gate is not
//   merely suboptimal for that member; it is the more expensive error. Claude initially
//   recommended the loosest setting on a "fail open" argument that ignored this gradient.
//
//   And the escape hatch covers the case that matters: `TierRouter:1180` force-opens the
//   next tier's gate on a MatB crossing, so a member who genuinely becomes eligible has
//   the gate opened BY THEIR OWN CROSSING. The periodic check governs sustained quiet,
//   which is what a deflation throttle is for.
//
// ⛔ BOTH SETTERS ARE ENUMERATED — THIS IS WHY THIS FILE EXISTS RATHER THAN A CONSOLE CALL.
//    MatrixKeeper.sol:271-278 (deployed, git show d382d37):
//        setVelocityWindow    require(v == 1800 || v == 3600 || v == 7200 || v == 14400)
//        setVelocityThreshold require(v == 1 || v == 2 || v == 3 || v == 5)
//    A session recommended 86400 without checking, and it would have reverted on-chain in
//    front of the owner. `setMaxItemsPerUpkeep` (5/10/15/20/30/40) caught this repo once
//    already. **This script validates against the enumerations BEFORE it sends anything.**
//
// ⚠ WHAT THIS IS NOT: a calibrated number. Today's entry counts are overwhelmingly bigfill
//   through `manualUpgrade`, which never reads this gate, so the ORGANIC rate it will face
//   cannot be measured from the current chain. This is a launch-safety setting chosen on
//   the shape of the two errors, not on data. **THE WATCH ITEM, AGREED IN ADVANCE: after
//   the community deploy, re-run `diag_velocity_gate.js`. If any tier with a NON-ZERO wide-
//   window count is sitting closed, the periodic check is beating the escape hatch — go to
//   threshold 1.** A tier at ZERO is not evidence of anything; nobody was trying.
//
// Run (contracts repo, owner or governance signer):
//   ADDRESSES_FILE=deployed_addresses_v8_48.json DRY_RUN=1 \
//     npx hardhat run scripts/set_velocity_gate.js --network baseSepolia
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/set_velocity_gate.js --network baseSepolia
//
//   WINDOW=14400   THRESHOLD=2   override the owner's decision (still enumeration-checked)
//
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.error("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.error("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.error("    npx hardhat run scripts/set_velocity_gate.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

// The enumerations, copied from the DEPLOYED build, not the working tree (34.5).
const VALID_WINDOW    = [1800, 3600, 7200, 14400];
const VALID_THRESHOLD = [1, 2, 3, 5];

const WINDOW    = Number(process.env.WINDOW    || 14400);
const THRESHOLD = Number(process.env.THRESHOLD || 2);
const DRY       = process.env.DRY_RUN === "1";

const KEEPER_ABI = [
  "function velocityWindow() view returns (uint256)",
  "function velocityThreshold() view returns (uint256)",
  "function setVelocityWindow(uint256) external",
  "function setVelocityThreshold(uint256) external",
  "function owner() view returns (address)",
];

async function main() {
  // ── Validate BEFORE touching the chain. An enumerated setter that reverts has still
  //    cost gas and, worse, leaves the pair half-applied if the first call succeeded.
  const bad = [];
  if (!VALID_WINDOW.includes(WINDOW))       bad.push(`WINDOW ${WINDOW} — allowed: ${VALID_WINDOW.join(", ")}`);
  if (!VALID_THRESHOLD.includes(THRESHOLD)) bad.push(`THRESHOLD ${THRESHOLD} — allowed: ${VALID_THRESHOLD.join(", ")}`);
  if (bad.length) {
    console.error("REFUSING TO SEND — the contract would revert:");
    bad.forEach(b => console.error("   " + b));
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  const keeper = await ethers.getContractAt(KEEPER_ABI, A.matrixKeeper, signer);

  console.log(`MatrixKeeper : ${A.matrixKeeper}`);
  console.log(`Signer       : ${signer.address}${DRY ? "   [DRY RUN — nothing will be sent]" : ""}`);
  let owner = null;
  try { owner = await keeper.owner(); } catch { /* governance-only build; not fatal */ }
  if (owner) {
    console.log(`Keeper owner : ${owner}`);
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      console.log("⚠ signer is NOT the keeper owner — this only works if the signer is governance.");
    }
  }

  const curW = await keeper.velocityWindow();
  const curT = await keeper.velocityThreshold();
  const rate = (t, w) => (Number(t) / (Number(w) / 3600)).toFixed(2);
  console.log(`\nBEFORE : window ${curW}s (${(Number(curW) / 3600).toFixed(1)}h)  threshold ${curT}` +
              `   => ${curT} entries per ${(Number(curW) / 3600).toFixed(1)}h = ${rate(curT, curW)}/hour`);
  console.log(`AFTER  : window ${WINDOW}s (${(WINDOW / 3600).toFixed(1)}h)  threshold ${THRESHOLD}` +
              `   => ${THRESHOLD} entries per ${(WINDOW / 3600).toFixed(1)}h = ${rate(THRESHOLD, WINDOW)}/hour`);
  const loosening = Number(rate(curT, curW)) / Number(rate(THRESHOLD, WINDOW));
  console.log(`         ${loosening >= 1 ? loosening.toFixed(1) + "x LOOSER" : (1 / loosening).toFixed(1) + "x TIGHTER"} than the current setting`);

  if (Number(curW) === WINDOW && Number(curT) === THRESHOLD) {
    console.log("\nAlready at these values — nothing to do.");
    return;
  }
  if (DRY) {
    console.log("\n[DRY RUN] would send setVelocityWindow and setVelocityThreshold. Nothing sent.");
    return;
  }

  // Window first, then threshold. If the second fails the gate is LOOSER than intended,
  // never tighter — the safer half-applied state for a launch setting.
  if (Number(curW) !== WINDOW) {
    const tx = await keeper.setVelocityWindow(WINDOW);
    console.log(`\nsetVelocityWindow(${WINDOW})    tx ${tx.hash}`);
    await tx.wait();
  }
  if (Number(curT) !== THRESHOLD) {
    const tx = await keeper.setVelocityThreshold(THRESHOLD);
    console.log(`setVelocityThreshold(${THRESHOLD})   tx ${tx.hash}`);
    await tx.wait();
  }

  // ── Verify from chain. A setter that was not read back is not a result.
  //
  // ⛔ AND IT MUST RETRY. On the 2026-08-24 live run this read back
  //    "window 14400s threshold 3" and aborted — both transactions had in fact
  //    succeeded. The threshold is the SECOND write, so its read landed a beat too
  //    early and a load-balanced public RPC served pre-transaction state. A dry run
  //    thirty seconds later showed 14400/2.
  //
  //    THE LESSON IS NOT "THE CHECK WAS WRONG TO FIRE" — refusing to claim success is
  //    correct, and it is the reason this was caught rather than assumed. The lesson is
  //    that ONE READ IS NOT A MEASUREMENT against an RPC that can serve stale state:
  //    a single disagreeing read must be retried before it is believed, in EITHER
  //    direction. A false alarm that sends the owner chasing a phantom costs the same
  //    trust as a missed failure.
  const AT = 6, GAP = 2000;
  let newW = null, newT = null, ok = false;
  for (let i = 1; i <= AT; i++) {
    newW = await keeper.velocityWindow();
    newT = await keeper.velocityThreshold();
    ok = Number(newW) === WINDOW && Number(newT) === THRESHOLD;
    if (ok) {
      if (i > 1) console.log(`   (read-back settled on attempt ${i} — the RPC served stale state before that)`);
      break;
    }
    if (i < AT) {
      console.log(`   read-back attempt ${i}/${AT}: window ${newW}s threshold ${newT} — not settled, retrying in ${GAP / 1000}s`);
      await new Promise(r => setTimeout(r, GAP));
    }
  }
  console.log(`\nVERIFIED FROM CHAIN: window ${newW}s  threshold ${newT}`);
  if (!ok) {
    console.error(`⛔ CHAIN STILL DOES NOT MATCH AFTER ${AT} READS OVER ${(AT * GAP) / 1000}s.`);
    console.error("   This is no longer explainable as a stale read. Check the receipts of the");
    console.error("   two transactions above before re-running — a re-run is safe (it skips a");
    console.error("   value already at target) but will not fix a reverted transaction.");
    process.exit(1);
  }
  console.log(`✅ RULE NOW IN FORCE: green = (entries in last ${WINDOW}s) >= ${THRESHOLD}`);
  console.log(`   The gate re-evaluates on the keeper's next velocity check — re-run`);
  console.log(`   scripts/diag_velocity_gate.js afterwards to see the gates settle.`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
