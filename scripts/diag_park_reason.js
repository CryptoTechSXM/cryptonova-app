// diag_park_reason.js — DO MatA PARKS NEED A LOAN, OR ONLY MatB PARKS?
// And: is the empty MatA queue a FLOW/STOCK artifact, or are MatA parks really gone?
// READ-ONLY: no signer, no wallet, nothing signed, nothing sent. Built 2026-09-01 (session 55).
//
// THE TWO QUESTIONS, AND WHY ONE RUN ANSWERS BOTH
// ───────────────────────────────────────────────
// Q1 (owner, 2026-09-01): "matA parked yes but no loans required right"
//     The discriminator is IN THE EVENT and needs no interpretation:
//         MatrixLogicLib.sol:279  event MemberParked(address indexed member, uint256 shortfall)
//     shortfall == 0  -> NO-SEAT park. The member had the money; there was no seat.
//                        Emitted at :529 / :881 / :908 / :938 — all seat-shortage paths.
//     shortfall  > 0  -> FUNDING park. Emitted at :979 / :1939 with the amount owed.
//     So "does a MatA park need a loan" is not a matter of opinion: it is whether MatA's
//     park events carry a zero. This script reads that, per matrix, and never infers it.
//
// Q2 (54.6 follow-on, marked UNVERIFIED in memory): diag_parked_census.js found ZERO parked
//     in EVERY MatA chain-wide, against a recorded 152 no-seat parks per 24h. A snapshot
//     measures STOCK; that figure is a FLOW. If MatA parks are transient — a seat frees on
//     the next rotation and direct_keeper rescues within minutes — both are true at once and
//     nothing is wrong. ▶ THE TEST: count MatA MemberParked EVENTS in the window. A high
//     event count with an empty queue CONFIRMS transient. A near-zero event count means the
//     parks stopped happening, which is a different (and larger) claim about the chain.
//     ⛔ Either way the answer is a measurement. Do not carry the hypothesis forward.
//
// For members currently in a queue it also resolves WHY EACH ONE is there, by taking that
// address's MOST RECENT MemberParked event in the window. A member with no park event in
// the window is reported as UNRESOLVED — never silently bucketed.
//
// STRICT READS: retries, then FAIL LOUDLY with a label. No value-returning fallbacks; a
// failed getLogs is never reported as "zero events" (that is the mistake that makes a
// monitor say HEALTHY). Any failure marks the run INCOMPLETE.
//
// Run (owner, Windows, contracts repo C:\CryptoNite-Smart-Contracts\CryptoNova):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_50.json"
//   npx hardhat run scripts/diag_park_reason.js --network baseSepolia
//
// Env: ADDRESSES_FILE (required)  HOURS=24  TIER=T1  CHUNK=9000  RETRIES=4

const path = require("path");
const { ethers } = require("hardhat");

const PM_ABI  = ["function pairCount() view returns (uint256)",
                 "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = ["function occupancy() view returns (uint256)",
                 "function getParkedCount() view returns (uint256)",
                 "function getParkedMember(uint256 idx) view returns (address)",
                 "function isParked(address) view returns (bool)",
                 "event MemberParked(address indexed member, uint256 shortfall)"];

const line = (n = 100) => console.log("=".repeat(n));
const usd  = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const FAILURES = [];
const RETRIES  = Number(process.env.RETRIES || 4);

async function strict(label, fn) {
  let last = "";
  for (let i = 1; i <= RETRIES; i++) {
    try { return await fn(); }
    catch (e) { last = (e.shortMessage || e.message || String(e)).slice(0, 90);
                if (i < RETRIES) await new Promise(r => setTimeout(r, 400 * i)); }
  }
  FAILURES.push(`${label} :: ${last}`);
  throw new Error(`READ FAILED ${label}`);
}

async function scanParks(p, address, topic, from, head, chunk, label) {
  const out = [];
  for (let b = from; b <= head; b += chunk) {
    const to = Math.min(b + chunk - 1, head);
    out.push(...await strict(`${label}.getLogs[${b}..${to}]`,
      () => p.getLogs({ address, fromBlock: b, toBlock: to, topics: [topic] })));
  }
  return out;
}

async function main() {
  if (!process.env.ADDRESSES_FILE) {
    console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
    process.exit(1);
  }
  const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
  const p = ethers.provider;
  const head = await p.getBlockNumber();
  const HOURS = Number(process.env.HOURS || 24);
  const from  = Math.max(0, head - Math.round((HOURS * 3600) / 2)); // Base ~2s blocks
  const CHUNK = Number(process.env.CHUNK || 9000);
  const TIER_ONLY = (process.env.TIER || "").trim().toUpperCase();

  const iface = new ethers.Interface(MAT_ABI);
  const TOPIC = iface.getEvent("MemberParked").topicHash;

  line();
  console.log("diag_park_reason.js — READ-ONLY. Nothing is signed or sent.");
  console.log("Q1: do MatA parks carry a shortfall (loan) or a zero (no seat)?");
  console.log("Q2: is the empty MatA queue a transient-flow artifact, or did MatA parks stop?");
  console.log("addresses file :", process.env.ADDRESSES_FILE);
  console.log("window         :", `${HOURS}h  blocks ${from}..${head}`);
  console.log("discriminator  : MemberParked(member, shortfall) — 0 = NO-SEAT, >0 = FUNDING");
  line();

  const rows = [];
  for (const tk of Object.keys(A.tiers || {})) {
    if (TIER_ONLY && tk.toUpperCase() !== TIER_ONLY) continue;
    const pm = new ethers.Contract(A.tiers[tk].pm, PM_ABI, p);
    let pairCount;
    try { pairCount = Number(await strict(`${tk}.pairCount`, () => pm.pairCount())); }
    catch { console.log(`\n${tk}  ⛔ pairCount FAILED — tier NOT reported as zero`); continue; }
    if (!pairCount) continue;

    for (let i = 0; i < pairCount; i++) {
      let a, b;
      try { [a, b] = await strict(`${tk}.getPairAt(${i})`, () => pm.getPairAt(i)); }
      catch { continue; }

      for (const [half, addr] of [["MatA", a], ["MatB", b]]) {
        const label = `${tk}.${i + 1} ${half}`;
        const m = new ethers.Contract(addr, MAT_ABI, p);
        const row = { label, half, occ: null, queued: 0, evNoSeat: 0, evFunding: 0,
                      qNoSeat: 0, qFunding: 0, qUnresolved: 0, owed: 0n, incomplete: false };
        try {
          row.occ = Number(await strict(`${label}.occupancy`, () => m.occupancy()));
        } catch { row.incomplete = true; rows.push(row); continue; }
        if (row.occ === 0) { rows.push(row); continue; }   // never entered: nothing to say

        // ── FLOW: every park event in the window, split by the shortfall field ──
        let logs;
        try { logs = await scanParks(p, addr, TOPIC, from, head, CHUNK, label); }
        catch { row.incomplete = true; rows.push(row); continue; }

        const latest = new Map();   // member -> shortfall of most recent park
        for (const lg of logs) {
          const d = iface.decodeEventLog("MemberParked", lg.data, lg.topics);
          const who = d.member.toLowerCase();
          const sf  = d.shortfall;
          if (sf > 0n) row.evFunding++; else row.evNoSeat++;
          latest.set(who, sf);       // logs arrive ascending, so last write wins
        }

        // ── STOCK: who is in the queue right now, and why ──
        let qCount;
        try { qCount = Number(await strict(`${label}.getParkedCount`, () => m.getParkedCount())); }
        catch { row.incomplete = true; rows.push(row); continue; }

        for (let k = 0; k < qCount; k++) {
          let who;
          try { who = (await strict(`${label}.getParkedMember(${k})`, () => m.getParkedMember(k))).toLowerCase(); }
          catch { row.incomplete = true; break; }
          let live;
          try { live = await strict(`${label}.isParked`, () => m.isParked(who)); }
          catch { row.incomplete = true; break; }
          if (!live) continue;
          row.queued++;
          if (!latest.has(who)) { row.qUnresolved++; continue; }
          const sf = latest.get(who);
          if (sf > 0n) { row.qFunding++; row.owed += sf; } else row.qNoSeat++;
        }
        rows.push(row);
      }
    }
  }

  // ── Per-matrix ────────────────────────────────────────────────────────────
  console.log("");
  console.log("matrix          occ   parks in window          queue now (why they are there)");
  console.log("                      NO-SEAT   FUNDING        parked  NO-SEAT  FUNDING  unresolved   owed");
  for (const r of rows) {
    if (r.occ === 0 && !r.incomplete) continue;
    if (r.incomplete && r.occ === null) { console.log(`  ${r.label.padEnd(14)} ⛔ UNREADABLE — NOT counted as 0`); continue; }
    console.log(`  ${r.label.padEnd(14)}${String(r.occ).padStart(4)}` +
      `${String(r.evNoSeat).padStart(10)}${String(r.evFunding).padStart(10)}` +
      `${String(r.queued).padStart(15)}${String(r.qNoSeat).padStart(9)}${String(r.qFunding).padStart(9)}` +
      `${String(r.qUnresolved).padStart(12)}${(r.owed > 0n ? usd(r.owed) : "-").padStart(12)}` +
      `${r.incomplete ? "  ⛔INCOMPLETE" : ""}`);
  }

  const sum = (f, pred = () => true) => rows.filter(pred).reduce((s, r) => s + f(r), 0);
  const isA = (r) => r.half === "MatA", isB = (r) => r.half === "MatB";
  const owedTotal = rows.reduce((s, r) => s + r.owed, 0n);

  console.log("");
  line();
  console.log(`Q1 — DOES A PARK NEED A LOAN?   (park events in the last ${HOURS}h)`);
  line();
  console.log(`  MatA :  NO-SEAT ${sum(r => r.evNoSeat, isA)}   FUNDING ${sum(r => r.evFunding, isA)}`);
  console.log(`  MatB :  NO-SEAT ${sum(r => r.evNoSeat, isB)}   FUNDING ${sum(r => r.evFunding, isB)}`);
  const aFund = sum(r => r.evFunding, isA), aSeat = sum(r => r.evNoSeat, isA);
  if (aSeat + aFund === 0) {
    console.log("  ▶ NO MatA PARK EVENTS IN THE WINDOW AT ALL — Q1 is UNANSWERED by this run, not answered 'no'.");
  } else if (aFund === 0) {
    console.log("  ✅ CONFIRMED: every MatA park in the window carried shortfall 0 — A SEAT PROBLEM, NOT A MONEY PROBLEM.");
    console.log("     No loan or advance is involved in a MatA park. This is what V8.51's seating fix addresses.");
  } else {
    console.log(`  ⛔ NOT CONFIRMED: ${aFund} MatA park(s) carried a NON-ZERO shortfall. The clean split does NOT hold.`);
    console.log("     Do not tell members MatA parks never need funds until this is explained.");
  }

  console.log("");
  line();
  console.log("Q2 — IS THE EMPTY MatA QUEUE A FLOW/STOCK ARTIFACT?");
  line();
  console.log(`  MatA park EVENTS in window : ${aSeat + aFund}`);
  console.log(`  MatA still QUEUED now      : ${sum(r => r.queued, isA)}`);
  if (aSeat + aFund > 0 && sum(r => r.queued, isA) === 0) {
    console.log("  ✅ TRANSIENT CONFIRMED: MatA parks are happening and clearing. Stock 0, flow > 0 — both figures were");
    console.log("     always true together. The 152/24h record and the empty queue never actually disagreed.");
  } else if (aSeat + aFund === 0) {
    console.log("  ⛔ MatA PARKS HAVE STOPPED HAPPENING in this window — that is a BIGGER claim than 'transient' and");
    console.log("     it needs its own explanation (stress off since ~08-31? gate closed? nobody registering?).");
    console.log("     ⚠ Stress has been off ~23h under rr_keeper.OFF — arrivals may simply have stopped. Check before concluding.");
  } else {
    console.log("  ▶ MIXED — MatA has both events and a standing queue. Read the per-matrix rows.");
  }

  console.log("");
  line();
  console.log("WHAT IS ACTUALLY STUCK RIGHT NOW");
  line();
  console.log(`  queued positions        : ${sum(r => r.queued)}`);
  console.log(`  ├─ waiting on FUNDS     : ${sum(r => r.qFunding)}   total owed ${owedTotal > 0n ? usd(owedTotal) : "$0.00"}`);
  console.log(`  ├─ waiting on a SEAT    : ${sum(r => r.qNoSeat)}`);
  console.log(`  └─ UNRESOLVED (parked before the window) : ${sum(r => r.qUnresolved)}`);
  console.log("  ⚠ UNRESOLVED are not 'other' — widen HOURS to resolve them before quoting any split.");

  console.log("");
  if (FAILURES.length) {
    console.log("⛔ RUN IS INCOMPLETE — these totals are FLOORS, not counts. Do not quote them. Re-run.");
    for (const f of FAILURES.slice(0, 20)) console.log("   ✗ " + f);
    if (FAILURES.length > 20) console.log(`   … and ${FAILURES.length - 20} more`);
  } else {
    console.log("✅ Every read succeeded. No fallbacks were used anywhere in this run.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
