// diag_seating_depth.js — TEST T5. Does a member ever pay a full entry fee for a
// fraction of a journey, because they were seated into a slot someone else vacated?
//
// V8_50_SCOPE.md item D: _lowestFreeSlot scans from position 1 UPWARD, so a freed
// slot is refilled BEFORE seat 127. A member seated shallow inherits the tail of
// someone else's ride: at seat 2 they collect $0.25 against a $10 fee, reach the
// crossing $4.75 short, and are refused by the floor. FREQUENCY IS UNMEASURED —
// that is this script.
//
// ⛔ THE TEST PLAN'S TOOL SPEC FOR T5 IS WRONG, AND WRONG IN THE DIRECTION THAT
//    LOOKS LIKE GOOD NEWS. It says "count SlotReclaimed events by position".
//    SlotReclaimed is emitted ONLY by MatrixLogicLib.reclaimIdleSlot (:1288), and
//    MatrixKeeper._doIdleReclaim STOPPED CALLING IT — it calls softParkIdle (:911)
//    because reclaimIdleSlot sent members to limbo with no path back. softParkIdle
//    emits SlotParkedIdle (:1320) instead. A script written to the plan's spec
//    scans for SlotReclaimed, finds ZERO, and reports that shallow seating never
//    happens. That is a clean, plausible, wrong negative — and it would retire
//    item D on the strength of it.
//    This script scans ALL THREE seat-freeing events and PRINTS THE COUNT OF EACH,
//    so which path is live is observed rather than assumed.
//
// SEAT-FREEING EVENTS (all emitted by the library, logged under the matrix address):
//   SlotParkedIdle  (member, position, idleDuration)   <- softParkIdle, THE LIVE PATH
//   SlotReclaimed   (member, position, idleDuration)   <- reclaimIdleSlot, believed dead
//   MemberExitedSeat(member, position, reserveReleased, penalty)
// SEATING EVENT:
//   MemberEntered   (member, bfsPosition, memberId, matrix)
//
// METHOD: a freeing event at position P is paired with the NEXT MemberEntered at
// that same position in the same matrix. That pairing IS the mechanism — a backfill
// only matters when someone actually inherits the seat. During the initial fill
// every member is seated shallow and none of it is a defect, which is why a naive
// histogram of bfsPosition answers nothing.
//
// Run (contracts repo, Windows):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
//   node scripts\diag_seating_depth.js
// Optional: TIERS=T1,T2   FROM_BLOCK=45540000   CHUNK=5000

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC  = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const FILE = process.env.ADDRESSES_FILE;
if (!FILE) {
  console.log("FATAL: ADDRESSES_FILE not set. Name the deployment explicitly:");
  console.log('  $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"');
  process.exit(1);
}
const A     = require(path.join(__dirname, FILE));
const TIERS = (process.env.TIERS || "T1").split(",").map(s => s.trim()).filter(Boolean);
const CHUNK = Number(process.env.CHUNK || 5000);

const usd = v => `$${(Number(v) / 1e6).toFixed(2)}`;

// V8_50_SCOPE item D, for reading the histogram against consequences rather than
// as bare counts. Total earned over a full ride from that seat, T1 $10 fee.
const EARN_AT = [
  [127, "$3.40"], [64, "$2.06"], [32, "$1.45"], [8, "$0.80"], [2, "$0.25"],
];

const EVENT_ABI = [
  "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)",
  "event SlotParkedIdle(address indexed member, uint256 position, uint256 idleDuration)",
  "event SlotReclaimed(address indexed member, uint256 position, uint256 idleDuration)",
  "event MemberExitedSeat(address indexed member, uint256 position, uint256 reserveReleased, uint256 penalty)",
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix)",
];
const MAT_ABI = [
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
  "function matrixSize() view returns (uint256)",
];

// Chunked scan. NEVER a single unbounded getLogs: this project has twice produced
// a clean, plausible, wrong answer from a capped scan. The range actually covered
// is printed, so a short scan cannot be mistaken for a quiet chain.
async function scan(p, iface, address, fromBlock, toBlock) {
  const out = [];
  let chunks = 0;
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    let logs;
    try {
      logs = await p.getLogs({ address, fromBlock: start, toBlock: end });
    } catch (e) {
      throw new Error(`getLogs FAILED on ${start}-${end}: ${e.shortMessage || e.message}\n` +
        `  The scan is INCOMPLETE. Do not read the output below as a result — lower CHUNK and re-run.`);
    }
    chunks++;
    for (const l of logs) {
      let parsed = null;
      try { parsed = iface.parseLog(l); } catch { continue; }
      if (parsed) out.push({ name: parsed.name, args: parsed.args, block: l.blockNumber, index: l.index });
    }
  }
  return { events: out, chunks };
}

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env"); process.exit(1); }
  const p     = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const iface = new ethers.Interface(EVENT_ABI);
  const head  = await p.getBlockNumber();
  const from  = Number(process.env.FROM_BLOCK || 0) || Math.max(0, head - 500_000);

  console.log(`\naddresses ${FILE}   head ${head}   scanning from ${from}  (${head - from} blocks, chunk ${CHUNK})`);
  console.log(`tiers: ${TIERS.join(", ")}\n`);

  let grandBackfills = 0, grandEntries = 0;

  for (const tier of TIERS) {
    const t = A.tiers && A.tiers[tier];
    if (!t) { console.log(`${tier}: not in addresses file — skipped`); continue; }

    for (const [label, addr] of [[`${tier} MatA`, t.matA], [`${tier} MatB`, t.matB]]) {
      if (!addr) continue;
      const mat = new ethers.Contract(addr, MAT_ABI, p);
      const { events, chunks } = await scan(p, iface, addr, from, head);

      const entered = events.filter(e => e.name === "MemberEntered");
      const parked  = events.filter(e => e.name === "SlotParkedIdle");
      const reclaim = events.filter(e => e.name === "SlotReclaimed");
      const exited  = events.filter(e => e.name === "MemberExitedSeat");
      const cycled  = events.filter(e => e.name === "MemberCycledOut");

      let occ = "?", rot = "?", size = 127n;
      try { occ = await mat.occupancy(); rot = await mat.rotationCount(); size = await mat.matrixSize(); } catch {}

      console.log("=".repeat(76));
      console.log(`${label}  ${addr}`);
      console.log(`  scanned ${chunks} chunk(s)   occupancy ${occ}/${size}   rotations ${rot}`);
      console.log(`  MemberEntered ${entered.length}   MemberCycledOut ${cycled.length}`);
      console.log(`  seat-freeing events —  SlotParkedIdle ${parked.length}   ` +
                  `SlotReclaimed ${reclaim.length}   MemberExitedSeat ${exited.length}`);

      if (reclaim.length === 0 && parked.length > 0) {
        console.log(`    NOTE: SlotReclaimed is 0 and SlotParkedIdle is ${parked.length}. This is EXPECTED —`);
        console.log(`    the keeper calls softParkIdle, not reclaimIdleSlot. A T5 script written to the`);
        console.log(`    test plan's original spec would have scanned only SlotReclaimed and concluded`);
        console.log(`    shallow seating never happens.`);
      }

      // ── SELF-TEST against a counter the contract keeps ────────────────────
      // occupancy should equal (seated) - (freed) - (cycled out), within the
      // scanned window. A mismatch means the window missed events; it does NOT
      // mean the chain is wrong, and the numbers below are then a lower bound.
      const freedTotal = parked.length + reclaim.length + exited.length;
      const predicted  = entered.length - freedTotal - cycled.length;
      const occNum     = Number(occ);
      console.log(`  SELF-TEST: entered ${entered.length} - freed ${freedTotal} - cycled ${cycled.length}` +
                  ` = ${predicted}   vs occupancy ${occNum}`);
      if (predicted !== occNum) {
        console.log(`    *** MISMATCH (${predicted - occNum}). The scan window does not cover this matrix's`);
        console.log(`    *** full history, so every count here is a LOWER BOUND. Set FROM_BLOCK to the`);
        console.log(`    *** deployment block and re-run before drawing a conclusion.`);
      } else {
        console.log(`    ✓ reconciles with the contract's own occupancy`);
      }

      // ── THE ACTUAL T5 MEASUREMENT ────────────────────────────────────────
      // Pair each freeing at position P with the next entry at P in this matrix.
      const freeings = [...parked, ...reclaim, ...exited]
        .map(e => ({ pos: Number(e.args[1]), block: e.block, index: e.index }))
        .sort((a, b) => a.block - b.block || a.index - b.index);
      const entries = entered
        .map(e => ({ pos: Number(e.args[1]), block: e.block, index: e.index, member: e.args[0] }))
        .sort((a, b) => a.block - b.block || a.index - b.index);

      const usedEntry = new Set();
      const backfills = [];
      for (const f of freeings) {
        const hit = entries.find((en, i) =>
          !usedEntry.has(i) && en.pos === f.pos &&
          (en.block > f.block || (en.block === f.block && en.index > f.index)));
        if (hit) {
          usedEntry.add(entries.indexOf(hit));
          backfills.push({ pos: f.pos, member: hit.member, freedAt: f.block, seatedAt: hit.block });
        }
      }

      grandEntries += entries.length;
      grandBackfills += backfills.length;

      console.log(`  BACKFILLS (a freed seat inherited by a later entrant): ${backfills.length}`);
      if (backfills.length === 0) {
        console.log(`    none in this window.`);
      } else {
        const buckets = [[1, 8], [9, 32], [33, 64], [65, 126], [127, 100000]];
        for (const [lo, hi] of buckets) {
          const n = backfills.filter(b => b.pos >= lo && b.pos <= hi).length;
          if (n === 0) continue;
          const bar = "#".repeat(Math.min(40, n));
          console.log(`    seat ${String(lo).padStart(3)}-${String(hi === 100000 ? size : hi).padStart(3)} : ${String(n).padStart(4)} ${bar}`);
        }
        const shallow = backfills.filter(b => b.pos <= 50);
        console.log(`    seated at 50 or below: ${shallow.length} of ${backfills.length}` +
                    `  <- T5 PASSES if this is rare or zero`);
        shallow.slice(0, 10).forEach(b =>
          console.log(`      seat ${String(b.pos).padStart(3)}  ${b.member}  freed@${b.freedAt} seated@${b.seatedAt}`));
      }
      console.log("");
    }
  }

  console.log("=".repeat(76));
  console.log(`TOTAL entries ${grandEntries}   TOTAL backfills ${grandBackfills}`);
  console.log(`\nWhat a shallow seat costs, over a FULL ride from that seat (T1, $10 fee):`);
  for (const [seat, earn] of EARN_AT) console.log(`  seat ${String(seat).padStart(3)} -> ${earn}`);
  console.log(`\nA member seated at 2 pays $10 and collects $0.25. No funds leak — the slices`);
  console.log(`they did not collect went to deeper members — but they paid full price for a`);
  console.log(`fraction of a ride, and the floor then refuses them for being short.`);
  console.log(`\nT5 PASS  = backfills below ~seat 50 are rare or absent; item D is theoretical.`);
  console.log(`T5 FAIL  = they happen regularly; V8.50 must fix SEATING, not the floor.`);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
