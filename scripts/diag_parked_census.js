// diag_parked_census.js — SETTLES 54.6: does `Parked: 0 total 🟢 OK` describe the chain,
// or only the two matrices system_keeper happens to look at?
// READ-ONLY: no signer, no wallet, nothing signed, nothing sent. Built 2026-09-01 (session 55).
//
// THE DISAGREEMENT (V8_50_HANDOFF 54.6)
// ─────────────────────────────────────
//   health.log says   : "Parked: 0 total 🟢 OK", "Overall: 🟢 HEALTHY", and Telegrams it.
//   08-31 measurement : 446 parked positions across the live chain (72 in T1.2, 46 in
//                       T2.2, 46 in T2.3 ... none of which system_keeper can see).
//
// THREE LIVE HYPOTHESES. This script does not choose between them by argument; it prints
// the numbers that separate them, all taken at ONE PINNED BLOCK.
//
//   H-BLIND  system_keeper reads only matA1.getParkedCount() + matA2.getParkedCount()
//            (system_keeper.js:360, :369, summed at :375) — TIER 1 AND TIER 2, PAIR 0,
//            MatA ONLY. It never calls pairCount(), so T1.2, T2.2+, every MatB and all of
//            T3-T10 are structurally invisible. Then "0" is true of its two matrices and
//            says nothing about the chain.
//
//   H-EMPTY  stress has been off ~23h (rr_keeper.OFF) with direct_keeper still draining,
//            so the queue genuinely emptied. Then the monitor is right and the 08-31
//            figure is simply old. THIS IS A REAL POSSIBILITY — do not skip past it.
//
//   H-FAILOPEN  system_keeper reads those counts through
//            `safeCall(() => matA1.getParkedCount(), 0n)`. safeCall swallows the error and
//            returns the fallback, so a DROPPED RPC READ PRINTS AS `parked=0` and grades
//            🟢 OK. This is the SAME defect family as 54.1's getVelocityGates fallback —
//            which was fixed — sitting unfixed on the parked path. An unreadable count and
//            an empty queue must never print the same, and here they do.
//
// ⛔ AND A FOURTH THING THAT IS NOT A HYPOTHESIS BUT A KNOWN PROPERTY OF THE NUMBER ITSELF:
//    getParkedCount() IS THE RAW QUEUE LENGTH AND IS KNOWN-INFLATED. diag_parked_truth.js
//    established that the array is not compacted (H3) and that _removeFromParkedQueue drops
//    only the FIRST matching entry (H1b), so rescued members and duplicate slots stay in it
//    with parkedAt == 0. "915 parked" was quoted for weeks and was not a count of parked
//    members. ▶ So this script reports THREE different numbers and never conflates them:
//       RAW    = sum of getParkedCount()               (what a monitor would print)
//       LIVE   = entries where isParked(addr) is true   (positions actually parked)
//       PEOPLE = distinct addresses among the LIVE ones (members actually stuck)
//    A member-facing sentence may only ever use PEOPLE.
//
// STRICT READS (model_epoch_policy v1). Every read retries N times and then FAILS LOUDLY
// with its label. There is not one value-returning fallback in this file — that is the
// whole point of it. Any failure marks the run INCOMPLETE and the totals unquotable.
//
// Run (owner, Windows, contracts repo C:\CryptoNite-Smart-Contracts\CryptoNova):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_50.json"
//   npx hardhat run scripts/diag_parked_census.js --network baseSepolia
//
// Env: ADDRESSES_FILE (required, no default — a stale default is how 49.1d lost a session)
//      TIER=T1        limit to one tier
//      SAMPLE=n       cap queue entries walked per matrix (default 0 = walk all)
//      BLOCK=n        pin to this block (default: head - 3, to sit behind node lag)
//      RETRIES=n      per-read attempts (default 4)

const path = require("path");
const { ethers } = require("hardhat");

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MAT_ABI = [
  "function occupancy() view returns (uint256)",
  "function MATRIX_SIZE() view returns (uint256)",
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256 idx) view returns (address)",
  "function isParked(address) view returns (bool)",
  "function parkedAt(address) view returns (uint256)",
];

const line = (n = 100) => console.log("=".repeat(n));
const short = (a) => `${a.slice(0, 10)}…`;

let FAILURES = [];
const RETRIES = Number(process.env.RETRIES || 4);

// The only read path in this file. Retries, then throws with a LABEL.
// It never returns a substitute value — an unread number must not become a number.
async function strict(label, fn) {
  let last = "";
  for (let i = 1; i <= RETRIES; i++) {
    try { return await fn(); }
    catch (e) {
      last = (e.shortMessage || e.message || String(e)).slice(0, 90);
      if (i < RETRIES) await new Promise(r => setTimeout(r, 400 * i));
    }
  }
  FAILURES.push(`${label} :: ${last}`);
  throw new Error(`READ FAILED ${label}`);
}

async function censusMatrix(p, label, addr, blockTag, sampleCap) {
  const m = new ethers.Contract(addr, MAT_ABI, p);
  const o = { label, addr, occ: null, size: null, raw: null, live: 0, stale: 0, dupes: 0,
              zeroTs: 0, people: new Set(), walked: 0, incomplete: false };

  try {
    o.occ  = Number(await strict(`${label}.occupancy`,     () => m.occupancy({ blockTag })));
    o.size = Number(await strict(`${label}.MATRIX_SIZE`,   () => m.MATRIX_SIZE({ blockTag })));
    o.raw  = Number(await strict(`${label}.getParkedCount`,() => m.getParkedCount({ blockTag })));
  } catch { o.incomplete = true; return o; }

  const walkTo = sampleCap > 0 ? Math.min(o.raw, sampleCap) : o.raw;
  const seen = new Set();
  for (let i = 0; i < walkTo; i++) {
    let a;
    try { a = await strict(`${label}.getParkedMember(${i})`, () => m.getParkedMember(i, { blockTag })); }
    catch { o.incomplete = true; break; }
    o.walked++;
    if (seen.has(a.toLowerCase())) o.dupes++;
    seen.add(a.toLowerCase());

    let parked;
    try { parked = await strict(`${label}.isParked(${short(a)})`, () => m.isParked(a, { blockTag })); }
    catch { o.incomplete = true; break; }

    if (parked) { o.live++; o.people.add(a.toLowerCase()); }
    else o.stale++;

    // parkedAt is diagnostic colour, not a verdict: H1 (ts == 0) is why discovery can be
    // structurally blind. A failure here does not invalidate the live/stale split.
    try {
      const ts = Number(await strict(`${label}.parkedAt(${short(a)})`, () => m.parkedAt(a, { blockTag })));
      if (parked && ts === 0) o.zeroTs++;
    } catch { /* colour only — already recorded in FAILURES */ }
  }
  if (sampleCap > 0 && o.raw > walkTo) o.incomplete = true;
  return o;
}

async function main() {
  if (!process.env.ADDRESSES_FILE) {
    console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
    console.log("       Live community chain is deployed_addresses_v8_50.json (V8.51 has no members yet).");
    process.exit(1);
  }
  const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
  const p = ethers.provider;
  const head = await p.getBlockNumber();
  const blockTag = Number(process.env.BLOCK || Math.max(0, head - 3));
  const TIER_ONLY = (process.env.TIER || "").trim().toUpperCase();
  const SAMPLE = Number(process.env.SAMPLE || 0);

  line();
  console.log("diag_parked_census.js — READ-ONLY. Nothing is signed or sent.");
  console.log("question       : is `Parked: 0 total 🟢 OK` true of the CHAIN, or only of T1/T2 pair 0 MatA?");
  console.log("addresses file :", process.env.ADDRESSES_FILE);
  console.log("head block     :", head, " | ALL READS PINNED TO BLOCK:", blockTag);
  console.log("queue walk     :", SAMPLE > 0 ? `SAMPLED, max ${SAMPLE} per matrix (totals will be marked INCOMPLETE)` : "FULL (every queue entry)");
  line();

  const all = [];
  let skTotal = null, skParts = [];

  for (const tk of Object.keys(A.tiers || {})) {
    if (TIER_ONLY && tk.toUpperCase() !== TIER_ONLY) continue;
    const pmAddr = A.tiers[tk].pm;
    const pm = new ethers.Contract(pmAddr, PM_ABI, p);

    let pairCount;
    try { pairCount = Number(await strict(`${tk}.pairCount`, () => pm.pairCount({ blockTag }))); }
    catch { console.log(`\n${tk}  ⛔ pairCount READ FAILED — tier NOT reported as zero, run is INCOMPLETE`); continue; }
    if (pairCount === 0) { console.log(`\n${tk}  (no pairs)`); continue; }

    console.log(`\n── ${tk}  PairManager ${pmAddr}  (${pairCount} pair${pairCount === 1 ? "" : "s"}) ──`);

    for (let i = 0; i < pairCount; i++) {
      let a, b;
      try { [a, b] = await strict(`${tk}.getPairAt(${i})`, () => pm.getPairAt(i, { blockTag })); }
      catch { console.log(`   ⛔ getPairAt(${i}) FAILED — pair skipped, run is INCOMPLETE`); continue; }

      for (const [half, addr] of [["MatA", a], ["MatB", b]]) {
        const label = `${tk}.${i + 1} ${half}`;
        const r = await censusMatrix(p, label, addr, blockTag, SAMPLE);
        all.push({ tier: tk, pair: i, half, ...r });

        if (r.incomplete && r.raw === null) {
          console.log(`   ${label.padEnd(14)} ⛔ UNREADABLE — NOT counted as 0`);
        } else {
          const flag = r.live > 0 ? "⚠" : " ";
          console.log(`   ${label.padEnd(14)} occ ${String(r.occ).padStart(3)}/${String(r.size).padEnd(3)}` +
            `  RAW ${String(r.raw).padStart(4)}  LIVE ${String(r.live).padStart(4)}  people ${String(r.people.size).padStart(4)}` +
            `  stale ${String(r.stale).padStart(4)}  dupes ${String(r.dupes).padStart(3)}` +
            `${r.zeroTs ? `  ts=0 ${r.zeroTs}` : ""}${r.incomplete ? "  ⛔INCOMPLETE" : ""} ${flag}`);
        }

        // system_keeper's exact field of view: T1/T2, pair 0, MatA only.
        if ((tk.toUpperCase() === "T1" || tk.toUpperCase() === "T2") && i === 0 && half === "MatA") {
          if (r.raw !== null) { skTotal = (skTotal || 0) + r.raw; skParts.push(`${tk} MatA pair0 raw=${r.raw}`); }
          else skParts.push(`${tk} MatA pair0 UNREADABLE`);
        }
      }
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const readable = all.filter(r => r.raw !== null);
  const RAW    = readable.reduce((s, r) => s + r.raw, 0);
  const LIVE   = readable.reduce((s, r) => s + r.live, 0);
  const STALE  = readable.reduce((s, r) => s + r.stale, 0);
  const DUPES  = readable.reduce((s, r) => s + r.dupes, 0);
  const PEOPLE = new Set();
  for (const r of readable) for (const a of r.people) PEOPLE.add(a);
  const incomplete = all.some(r => r.incomplete) || FAILURES.length > 0;

  console.log("");
  line();
  console.log("CHAIN-WIDE CENSUS  (all tiers, ALL pairs, both halves) — one block, no fallbacks");
  line();
  console.log(`  matrices read        : ${readable.length} of ${all.length}`);
  console.log(`  RAW  queue entries   : ${RAW}      <- what a getParkedCount() monitor prints`);
  console.log(`  LIVE parked positions: ${LIVE}      <- isParked() true`);
  console.log(`  PEOPLE actually stuck: ${PEOPLE.size}      <- distinct addresses. THE ONLY NUMBER A MEMBER POST MAY USE.`);
  console.log(`  stale queue slots    : ${STALE}      <- rescued/never-compacted (diag_parked_truth H3)`);
  console.log(`  duplicate slots      : ${DUPES}      <- same address twice in one queue (H1b)`);

  console.log("");
  console.log("SYSTEM_KEEPER'S FIELD OF VIEW  (system_keeper.js:360/:369, summed :375)");
  console.log(`  it reads             : ${skParts.join("  +  ") || "(nothing — T1/T2 pair 0 not reached)"}`);
  console.log(`  its 'Parked: N total': ${skTotal === null ? "UNREADABLE" : skTotal}`);
  if (skTotal !== null) {
    console.log(`  chain RAW it misses  : ${RAW - skTotal}`);
    console.log(`  live positions missed: ${LIVE - readable.filter(r => (r.tier.toUpperCase() === "T1" || r.tier.toUpperCase() === "T2") && r.pair === 0 && r.half === "MatA").reduce((s, r) => s + r.live, 0)}`);
  }

  console.log("");
  line();
  if (incomplete) {
    console.log("⛔ RUN IS INCOMPLETE — one or more reads failed. THESE TOTALS ARE FLOORS, NOT COUNTS.");
    console.log("   Do not quote them, and do not grade the monitor on them. Re-run.");
    for (const f of FAILURES.slice(0, 25)) console.log("   ✗ " + f);
    if (FAILURES.length > 25) console.log(`   … and ${FAILURES.length - 25} more`);
  } else if (LIVE === 0 && RAW === 0) {
    console.log("▶ VERDICT SUPPORTS H-EMPTY: the queue really is empty chain-wide at this block.");
    console.log("  system_keeper's '0' happens to be right — but it is right BY LUCK, not by coverage:");
    console.log("  it still reads only T1/T2 pair 0 MatA, and still turns a dropped read into '0'.");
  } else if (skTotal === 0 && LIVE > 0) {
    console.log("▶▶ VERDICT SUPPORTS H-BLIND: the monitor's two matrices are empty while the CHAIN IS NOT.");
    console.log(`  ${PEOPLE.size} distinct members are parked where system_keeper cannot see them.`);
    console.log("  '🟢 HEALTHY' is being Telegrammed over that. Fix coverage before any member post.");
  } else {
    console.log("▶ MIXED: read the per-matrix lines above. RAW != LIVE means the queue is not compacted;");
    console.log("  that is expected (H3/H1b) and is why only PEOPLE may be quoted to members.");
  }
  line();
  console.log("REMINDER: this settles COVERAGE. The fail-open (safeCall(..., 0n) at system_keeper.js:360/:369)");
  console.log("is a separate defect and is NOT disproved by a matching number — it only shows when a read drops.");
}

main().catch((e) => { console.error(e); process.exit(1); });
