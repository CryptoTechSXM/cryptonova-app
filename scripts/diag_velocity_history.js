// diag_velocity_history.js — WHAT DID THE VELOCITY CHECK ACTUALLY SEE, TICK BY TICK?
//
// Written session 74 (2026-09-11), and the reason it exists is worth stating because it
// is the shape of every instrument in this repo:
//
//   `velocityThreshold` was taken 2 -> 1 on the live V8.52 chain (62.45, tx 0x296de43a…).
//   The case it was made for was T6, measured at ONE entry against a bar of TWO at
//   16:41Z with the next check ~1.6h out. After the check ran, T6 read OPEN — and the
//   entry count had climbed to THREE. **So the outcome was right and the cause was
//   unestablished.** If T6 already held 2+ when the check fired, it would have survived
//   the old bar too, and the change decided nothing. A gate that is open tells you the
//   gate is open; it does not tell you which rule kept it open.
//
//   ▶▶ `VelocityUpdated(tier, green, entryCount)` carries the EXACT number the check
//   compared, at the moment it compared it. That is the measurement. `diag_velocity_live.js`
//   already queries this event — and only COUNTS the results, so the number that settles
//   the question was being fetched and thrown away every run.
//
// IT ALSO SETTLES T7, which `diag_velocity_gate.js` has flagged on every run and told us
// to resolve exactly this way: T7 sits at 0 entries with a CLOSED gate while T6 has 300+
// lifetime MatB crossings, and `TierRouter:1205` force-opens a gate on a MatB crossing.
// Two different faults wear that one appearance:
//     (a) no T6 member has crossed to MatB recently        -> nothing is wrong
//     (b) a crossing DID open T7 and the check re-closed it -> THE FEEDBACK LOOP, live
// A `VelocityGateSet(7,true)` followed later by a `VelocityUpdated(7,false)` is (b),
// and nothing else is.
//
// READ-ONLY. eth_getLogs + eth_call only. Nothing is signed and nothing is sent.
//
// Run (contracts repo):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_52.json"
//   npx hardhat run scripts/diag_velocity_history.js --network baseSepolia
// Options:
//   LOOKBACK=50000   how many blocks back to scan (default 20000, ~11h on Base Sepolia)
//   TIER=6           restrict the per-event detail to one tier (0-based index; 6 = T7)
//
// ⛔ THE 10k LOG CAP IS REAL (QuickNode; it is what forced status.html's window from
//    100,000 blocks to 9,000 and then printed the old number in ten languages for a week).
//    This pages in 9,000-block chunks and REPORTS the window it actually covered, every
//    run, in blocks AND in hours. A window is a result, not a detail (40.8).
//
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.error("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.error('  $env:ADDRESSES_FILE="deployed_addresses_v8_52.json"');
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

const LOOKBACK  = Number(process.env.LOOKBACK || 20000);
const CHUNK     = 9000;
const ONLY_TIER = process.env.TIER === undefined ? null : Number(process.env.TIER);

const KEEPER_ABI = [
  "function velocityWindow() view returns (uint256)",
  "function velocityThreshold() view returns (uint256)",
  "function lastVelocityCheck() view returns (uint256)",
  "function configuredTierCount() view returns (uint8)",
  "event VelocityUpdated(uint8 indexed tier, bool green, uint256 entryCount)",
];
const ROUTER_ABI = [
  "function tierVelocityGreen(uint8) view returns (bool)",
  "event VelocityGateSet(uint8 indexed tier, bool green)",
];

const tname = (idx) => `T${idx + 1}`;

async function pagedQuery(contract, filter, from, to) {
  const out = [];
  for (let lo = from; lo <= to; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK - 1, to);
    // ⛔ Do NOT swallow a failure here. An empty result and a refused query look identical
    //    downstream, and "no events" is exactly the answer this script must never guess.
    out.push(...await contract.queryFilter(filter, lo, hi));
  }
  return out;
}

async function main() {
  const provider = ethers.provider;
  const keeper = await ethers.getContractAt(KEEPER_ABI, A.matrixKeeper, provider);
  const router = await ethers.getContractAt(ROUTER_ABI, A.tierRouter, provider);

  const head = await provider.getBlockNumber();
  const from = Math.max(0, head - LOOKBACK);

  const [win, thr, lastChk, tierCount] = await Promise.all([
    keeper.velocityWindow(), keeper.velocityThreshold(),
    keeper.lastVelocityCheck(), keeper.configuredTierCount(),
  ]);

  const headBlk  = await provider.getBlock(head);
  const fromBlk  = await provider.getBlock(from);
  const spanHrs  = ((headBlk.timestamp - fromBlk.timestamp) / 3600).toFixed(1);

  console.log("");
  console.log("=".repeat(96));
  console.log("  VELOCITY HISTORY — what the check actually compared, tick by tick");
  console.log(`  addresses ${process.env.ADDRESSES_FILE}`);
  console.log(`  MatrixKeeper ${A.matrixKeeper}`);
  console.log(`  TierRouter   ${A.tierRouter}`);
  console.log("=".repeat(96));
  console.log(`  RULE IN FORCE NOW : green = (entries in last ${win}s) >= ${thr}`);
  console.log(`  last check        : ${new Date(Number(lastChk) * 1000).toISOString()}`);
  console.log(`  WINDOW SCANNED    : blocks ${from}..${head}  (${head - from} blocks, ${spanHrs}h)`);
  console.log(`                      anything older than this is NOT ABSENT, it is UNSCANNED.`);
  console.log("");

  const updates = await pagedQuery(keeper, keeper.filters.VelocityUpdated(), from, head);
  const gateSet = await pagedQuery(router, router.filters.VelocityGateSet(), from, head);

  // Block timestamps, fetched once per distinct block.
  const blocks = [...new Set([...updates, ...gateSet].map(e => e.blockNumber))];
  const ts = {};
  for (const b of blocks) ts[b] = (await provider.getBlock(b)).timestamp;
  const when = (b) => new Date(ts[b] * 1000).toISOString().replace("T", " ").slice(0, 19);

  console.log(`  VelocityUpdated events : ${updates.length}   (a completed check emits one PER TIER)`);
  console.log(`  VelocityGateSet events : ${gateSet.length}   (keeper 80% rule, a MatB crossing, or a manual call)`);
  console.log("");

  // ── 1. THE CHECKS, grouped into ticks ────────────────────────────────────────────────
  // A tick is one _doVelocityCheck: every tier in the same transaction. Group by tx hash
  // rather than by block — two checks could in principle land in one block, and a group
  // that silently merges them would report a count that no single comparison ever used.
  const byTx = new Map();
  for (const e of updates) {
    if (!byTx.has(e.transactionHash)) byTx.set(e.transactionHash, []);
    byTx.get(e.transactionHash).push(e);
  }
  const ticks = [...byTx.entries()]
    .map(([tx, evs]) => ({ tx, block: evs[0].blockNumber, evs }))
    .sort((a, b) => a.block - b.block);

  console.log("  ── EVERY VELOCITY CHECK IN THE WINDOW ──");
  if (!ticks.length) console.log("     none — no check completed in the scanned window.");
  for (const t of ticks) {
    console.log(`\n     ${when(t.block)}  block ${t.block}  tx ${t.tx.slice(0, 12)}…`);
    for (const e of t.evs.sort((a, b) => Number(a.args.tier) - Number(b.args.tier))) {
      const idx = Number(e.args.tier), cnt = Number(e.args.entryCount), green = e.args.green;
      if (ONLY_TIER !== null && idx !== ONLY_TIER) continue;
      // ▶ THE COLUMN THIS SCRIPT EXISTS FOR: what the SAME count would have done under
      //   the old bar of 2. It answers "did the change decide this?" instead of leaving
      //   an open gate to be read as evidence for whatever anyone already believed.
      const under2 = cnt >= 2 ? "OPEN" : "CLOSED";
      const under1 = cnt >= 1 ? "OPEN" : "CLOSED";
      const decided = (under1 !== under2) ? "   <<< THRESHOLD 1 DECIDED THIS" : "";
      console.log(
        `        ${tname(idx).padEnd(4)} entries ${String(cnt).padStart(3)}` +
        `   -> ${green ? "OPEN  " : "CLOSED"}` +
        `   (would be ${under2.padEnd(6)} at threshold 2, ${under1.padEnd(6)} at 1)${decided}`
      );
    }
  }

  // ── 2. GATE OPENINGS vs RE-CLOSURES, per tier ────────────────────────────────────────
  console.log("\n\n  ── GATE TIMELINE PER TIER (openings from any source, closures from the check) ──");
  const timeline = [
    ...gateSet.map(e => ({ b: e.blockNumber, tier: Number(e.args.tier), green: e.args.green, src: "GateSet" })),
    ...updates.map(e => ({ b: e.blockNumber, tier: Number(e.args.tier), green: e.args.green, src: "Check", cnt: Number(e.args.entryCount) })),
  ].sort((a, b) => a.b - b.b);

  const nTiers = Number(tierCount);
  for (let idx = 0; idx < nTiers; idx++) {
    if (ONLY_TIER !== null && idx !== ONLY_TIER) continue;
    const rows = timeline.filter(r => r.tier === idx);
    if (!rows.length) continue;
    const liveGreen = await router.tierVelocityGreen(idx);
    console.log(`\n     ${tname(idx)}  (live now: ${liveGreen ? "OPEN" : "AUTO-PAUSED"})`);
    for (const r of rows) {
      console.log(
        `        ${when(r.b)}  ${r.src.padEnd(8)} -> ${r.green ? "OPEN  " : "CLOSED"}` +
        (r.cnt === undefined ? "" : `   (entries ${r.cnt})`)
      );
    }
    // ⛔ THE FEEDBACK LOOP, DETECTED RATHER THAN INFERRED: an opening from any source
    //    followed later by a check that closed the same tier.
    let lastOpen = null, loop = null;
    for (const r of rows) {
      if (r.green) lastOpen = r;
      else if (lastOpen && r.src === "Check") { loop = { open: lastOpen, close: r }; lastOpen = null; }
    }
    if (loop) {
      console.log(`        ⛔⛔ FEEDBACK LOOP OBSERVED: opened by ${loop.open.src} at ${when(loop.open.b)},`);
      console.log(`            re-closed by the velocity check at ${when(loop.close.b)} on ${loop.close.cnt} entries.`);
    }
  }

  console.log("\n\n  ── HOW TO READ THIS ──");
  console.log("    · A tier OPEN today proves nothing about WHY. The entries column at each check is the why.");
  console.log("    · 'THRESHOLD 1 DECIDED THIS' marks a check where the count was exactly 1 — the only case");
  console.log("      in which the 2026-09-11 change changed an outcome. No such line means the change has");
  console.log("      not yet been exercised, NOT that it does not work.");
  console.log("    · No events for a tier means no check and no gate write reached it in the scanned window.");
  console.log(`      The window was ${head - from} blocks / ${spanHrs}h — widen with LOOKBACK before concluding.`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
