// diag_velocity_live.js — WHY IS THE VELOCITY ITEM RE-SERVED EVERY TICK ON A LIVE CHAIN?
//
// Written session 41 (2026-08-25) after the first G.4 driver run on the private2 chain:
// 120 ticks, every one VELOCITY at ~30k gas, zero rescues reached, lastVelocityCheck
// suspected frozen. The keeper dispatches VELOCITY through a bare
// `try/catch { emit WorkItemFailed }`, so the revert reason is swallowed on-chain
// (same shape test_ab/diag_velocity.js was built for on the A/B worlds — this is the
// LIVE-chain version of that probe; that one deploys its own world and cannot be
// pointed at a deployment).
//
// WHAT IT DOES (all read-only — eth_call only, nothing signed, nothing sent):
//   1. reads lastVelocityCheck / velocityWindow / now — is the clock frozen?
//   2. static-calls manualVelocityCheck() AS the owner — same internal
//      _doVelocityCheck() with NO catch, so the real revert reason comes back.
//   3. scans recent blocks for WorkItemFailed / VelocityUpdated on the keeper,
//      counted by work type, over a bounded REPORTED window (40.8's rule).
//
// Run:
//   $env:ADDRESSES_FILE="deployed_addresses_v8_50_private2.json"
//   node scripts\diag_velocity_live.js
// Options: LOOKBACK=20000 (blocks, default 20,000) | FROM_BLOCK=<n> pins the floor.
//
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing a stale default (34.1/39.4/40.8).");
  process.exit(1);
}
const A = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE), "utf8"));
const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env."); process.exit(1); }

const KEEPER_ABI = [
  "function lastVelocityCheck() view returns (uint256)",
  "function velocityWindow() view returns (uint256)",
  "function velocityThreshold() view returns (uint256)",
  "function owner() view returns (address)",
  "function manualVelocityCheck()",
  "event WorkItemFailed(uint8 indexed workType, uint8 tierIndex, address addr1, address addr2)",
  "event VelocityUpdated(uint8 indexed tier, bool green, uint256 entryCount)",
  "event BatchGasHalted(uint256 processed, uint256 total, uint256 gasRemaining)",
];
const WORK = ["VELOCITY","GHOST","RECLAIM","CHAIN_LINK","PARKED_RESCUE","VELOCITY_GATE",
              "EVICT_PARKED","DISTRIBUTE_CW","FORCE_ROTATE","ADVANCE_EPOCH"];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const keeper = new ethers.Contract(A.matrixKeeper, KEEPER_ABI, provider);
  const latest = await provider.getBlock("latest");

  console.log(`VELOCITY LIVE DIAGNOSTIC — ${path.basename(process.env.ADDRESSES_FILE)}`);
  console.log(`  keeper ${A.matrixKeeper}  block ${latest.number}  now ${latest.timestamp}`);

  // 1. the clock
  const [last, win, owner] = await Promise.all([
    keeper.lastVelocityCheck(), keeper.velocityWindow(), keeper.owner(),
  ]);
  const due = BigInt(latest.timestamp) >= last + win;
  console.log(`\n  lastVelocityCheck : ${last}  (${new Date(Number(last) * 1000).toISOString()})`);
  console.log(`  velocityWindow    : ${win}s`);
  console.log(`  item due now?     : ${due}   <- stays true forever if the check keeps reverting`);
  console.log(`  age of last check : ${latest.timestamp - Number(last)}s`);

  // 2. the swallowed reason — same code path, no catch, as the owner, read-only
  console.log(`\n  static-calling manualVelocityCheck() as owner ${owner} ...`);
  try {
    await keeper.manualVelocityCheck.staticCall({ from: owner });
    console.log("  -> SUCCEEDS. The inner check does NOT revert under eth_call.");
    console.log("     Then the freeze needs another explanation — do not stop here:");
    console.log("     compare gas: a real performUpkeep tx spent ~30k, success spends more.");
  } catch (e) {
    console.log("  -> REVERTS — THIS is what the keeper's bare catch has been swallowing:");
    console.log(`     reason : ${e.reason ?? "(none decoded)"}`);
    console.log(`     message: ${(e.shortMessage || e.message || "").slice(0, 220)}`);
    if (e.data) console.log(`     data   : ${String(e.data).slice(0, 140)}`);
  }

  // 3. the event record, bounded and reported
  const CHUNK = 9_000;
  const LOOKBACK = Number(process.env.LOOKBACK || 20_000);
  const floorBlk = process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK)
                                          : Math.max(latest.number - LOOKBACK, 0);
  const failCounts = {}; let velocityUpdated = 0; let failTotal = 0;
  let halts = 0; let haltSample = null;
  for (let from = floorBlk; from <= latest.number; from += CHUNK + 1) {
    const to = Math.min(from + CHUNK, latest.number);
    const [fails, oks, hs] = await Promise.all([
      keeper.queryFilter(keeper.filters.WorkItemFailed(), from, to),
      keeper.queryFilter(keeper.filters.VelocityUpdated(), from, to),
      keeper.queryFilter(keeper.filters.BatchGasHalted(), from, to),
    ]);
    for (const f of fails) {
      const t = WORK[Number(f.args.workType)] ?? `type${f.args.workType}`;
      failCounts[t] = (failCounts[t] || 0) + 1; failTotal++;
    }
    velocityUpdated += oks.length;
    halts += hs.length;
    if (hs.length && !haltSample) haltSample = hs[0];
  }
  console.log(`\n  events, blocks ${floorBlk}..${latest.number}:`);
  console.log(`    WorkItemFailed  : ${failTotal}${failTotal ? "  by type: " + JSON.stringify(failCounts) : ""}`);
  console.log(`    VelocityUpdated : ${velocityUpdated}   <- a successful check emits one per tier`);
  console.log(`    BatchGasHalted  : ${halts}   <- the batch stopped BEFORE dispatching an item`);
  if (haltSample) {
    const a = haltSample.args;
    console.log(`      sample: processed ${a.processed} of ${a.total}, gasRemaining ${a.gasRemaining} (block ${haltSample.blockNumber})`);
    console.log(`      gasRemaining far below minGasPerItem = the SENDER's gas limit was too small (a driver/estimate artifact, not a contract fault).`);
  }
  console.log(`  (window is bounded — widen with LOOKBACK= or pin FROM_BLOCK= if this may miss the run)`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
