// diag_cohort_split.js — attribute SF loan activity to the split cohorts.
//
// WHY THIS EXISTS (2026-08-16): the V8.49 test was designed as a split cohort —
// A at SELF_RESCUE_RATE 1.0 (control), B at 0 (subject) — and BIP-44 index is
// THE ONLY THING distinguishing them on chain. Every read during the run pooled
// them, so "14 members refused" was never attributed to a cohort and T6 ("the
// control is unharmed") stayed unanswered. This closes that.
//
// METHOD: derive each cohort's addresses from FILL_MNEMONIC, then bucket the
// StabilityFund's own debt events by cohort. Event-sourced, not snapshot-based:
// memberDebt is a BALANCE and the clawback repays each loan in full, so a
// member who borrowed and repaid reads $0.00 and is invisible to any snapshot.
//
// SELF-TEST: the bucketed totals are reconciled against totalRescueLoaned() and
// totalRescueRepaid(), the counters the contract keeps. If they disagree the
// scan is incomplete and the script says so instead of printing a clean answer.
// (A capped scan producing a plausible wrong total has bitten this project
// twice; diag_loan_history already carries the same check.)
//
// A LIMITATION, STATED: loans made to addresses OUTSIDE every declared range are
// reported as "unattributed" rather than silently dropped. W1, leaders and any
// earlier offset land there. A large unattributed count means the ranges below
// do not describe this chain — fix the ranges, do not ignore the bucket.
//
// Run (contracts repo, Windows):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
//   node scripts\diag_cohort_split.js
// Optional: COHORTS="A:6000:127,B:6200:127,TRAFFIC:6327:127"

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
const A = require(path.join(__dirname, FILE));

// name:offset:count — the ranges actually run on 2026-08-16.
const SPEC = process.env.COHORTS || "A:6000:127,B:6200:127,TRAFFIC:6327:127";
const COHORTS = SPEC.split(",").map(s => {
  const [name, offset, count] = s.split(":");
  return { name, offset: Number(offset), count: Number(count), self: {} };
});

// Copied verbatim from StabilityFund.sol:761-762. DO NOT write these from memory.
//
// The first draft declared:
//   MemberDebtIncreased(address indexed member, uint256 amount, uint8 tierIdx)
//   MemberDebtRepaid(address indexed member, uint256 amount)
// Both wrong. The real events carry a `tier` BEFORE the amount and a trailing
// `newTotal`. Two consequences, and the second is the dangerous one:
//   1. The topic hash did not match, so parseLog returned null for every log and
//      the scan found ZERO events on a chain holding 150 of them.
//   2. Had the hash matched, args[1] is the TIER, not the amount — every loan
//      would have been recorded as $0.000001 and the totals would have been
//      quietly, plausibly wrong.
// Only the self-test against totalRescueLoaned caught (1). Nothing would have
// caught (2) except reading the contract, which is what should have happened.
const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
  "function memberDebt(address) view returns (uint256)",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
const CHUNK = Number(process.env.CHUNK || 5000);

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env"); process.exit(1); }
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) { console.log("FATAL: FILL_MNEMONIC not set — cannot derive cohort addresses."); process.exit(1); }

  // Derive each cohort's address set. Same derivation path bigfill uses.
  const owner = new Map();   // address(lower) -> cohort name
  for (const c of COHORTS) {
    for (let i = 0; i < c.count; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, `m/44'/60'/0'/0/${i + c.offset}`);
      owner.set(w.address.toLowerCase(), c.name);
    }
  }

  const p    = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const sf   = new ethers.Contract(A.stabilityFund, SF_ABI, p);
  const head = await p.getBlockNumber();
  const from = Number(process.env.FROM_BLOCK || 0) || Math.max(0, head - 200_000);

  console.log(`\naddresses ${FILE}   SF ${A.stabilityFund}`);
  console.log(`scanning ${from}..${head}  (${head - from} blocks, chunk ${CHUNK})`);
  console.log(`cohorts: ${COHORTS.map(c => `${c.name} ${c.offset}-${c.offset + c.count - 1}`).join("  ·  ")}\n`);

  const iface = new ethers.Interface(SF_ABI);
  const inc = [], rep = [];
  for (let start = from; start <= head; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, head);
    let logs;
    try {
      logs = await p.getLogs({ address: A.stabilityFund, fromBlock: start, toBlock: end });
    } catch (e) {
      console.log(`FATAL: getLogs failed on ${start}-${end}: ${e.shortMessage || e.message}`);
      console.log("The scan is INCOMPLETE — lower CHUNK and re-run. Nothing below would be trustworthy.");
      process.exit(1);
    }
    for (const l of logs) {
      let ev = null;
      try { ev = iface.parseLog(l); } catch { continue; }
      if (!ev) continue;
      // Index by NAME, not position, so a signature change breaks loudly rather
      // than silently reading the wrong field. MemberDebtIncreased is
      // (member, tier, amount, newTotal) — args[1] is the TIER.
      if (ev.name === "MemberDebtIncreased") inc.push({ m: ev.args[0].toLowerCase(), amt: ev.args.amount });
      else if (ev.name === "MemberDebtRepaid") rep.push({ m: ev.args[0].toLowerCase(), amt: ev.args.amount });
    }
  }

  // ── SELF-TEST against counters the contract keeps ────────────────────────
  const sumInc = inc.reduce((a, e) => a + e.amt, 0n);
  const sumRep = rep.reduce((a, e) => a + e.amt, 0n);
  const cLoaned = await sf.totalRescueLoaned();
  const cRepaid = await sf.totalRescueRepaid();
  console.log("SCAN SELF-TEST");
  console.log(`  loans      : ${inc.length} events ${usd(sumInc)}  vs totalRescueLoaned ${usd(cLoaned)}  ` +
              (sumInc === cLoaned ? "MATCH" : "*** MISMATCH — SCAN INCOMPLETE ***"));
  console.log(`  repayments : ${rep.length} events ${usd(sumRep)}  vs totalRescueRepaid ${usd(cRepaid)}  ` +
              (sumRep === cRepaid ? "MATCH" : "*** MISMATCH — SCAN INCOMPLETE ***"));
  if (sumInc !== cLoaned || sumRep !== cRepaid) {
    console.log("\n  Refusing to attribute anything from an incomplete scan. Widen FROM_BLOCK and re-run.");
    process.exit(1);
  }
  console.log("");

  const bucket = {};
  for (const c of COHORTS) bucket[c.name] = { loans: 0, borrowed: 0n, repaid: 0n, members: new Set(), reps: 0 };
  bucket["(unattributed)"] = { loans: 0, borrowed: 0n, repaid: 0n, members: new Set(), reps: 0 };

  for (const e of inc) {
    const k = owner.get(e.m) || "(unattributed)";
    bucket[k].loans++; bucket[k].borrowed += e.amt; bucket[k].members.add(e.m);
  }
  for (const e of rep) {
    const k = owner.get(e.m) || "(unattributed)";
    bucket[k].reps++; bucket[k].repaid += e.amt;
  }

  console.log("LOAN ACTIVITY BY COHORT");
  console.log("  cohort          loans  borrowers   borrowed    repaid   outstanding");
  for (const k of Object.keys(bucket)) {
    const b = bucket[k];
    if (b.loans === 0 && b.reps === 0) continue;
    console.log(`  ${k.padEnd(15)} ${String(b.loans).padStart(5)} ${String(b.members.size).padStart(10)} ` +
                `${usd(b.borrowed).padStart(10)} ${usd(b.repaid).padStart(9)} ${usd(b.borrowed - b.repaid).padStart(13)}`);
  }

  // Outstanding right now, per cohort — the snapshot view, printed BESIDE the
  // event view so the difference between them is visible rather than confusing.
  console.log("\nOUTSTANDING NOW (memberDebt), for members who have EVER borrowed");
  for (const c of COHORTS) {
    const b = bucket[c.name];
    if (!b.members.size) { console.log(`  ${c.name.padEnd(15)} no borrowers`); continue; }
    let live = 0, total = 0n;
    for (const m of b.members) {
      const d = await sf.memberDebt(m);
      if (d > 0n) { live++; total += d; }
    }
    console.log(`  ${c.name.padEnd(15)} ${b.members.size} ever borrowed · ${live} carry debt now · ${usd(total)}`);
    if (b.members.size > 0 && live === 0) {
      console.log(`      all repaid — invisible to any memberDebt snapshot. This is the clawback.`);
    }
  }

  console.log(`\nT6 READS ON THE CONTROL COHORT. A cohort run at -SelfRescueRate 1.0 should show`);
  console.log(`FEW loans: its members top themselves up instead of asking the fund. A control with`);
  console.log(`loan volume comparable to the subject means the cohorts were not isolated — check`);
  console.log(`-ScanFrom on every run, and remember self-rescue only happens WHILE that cohort's`);
  console.log(`bigfill process is alive. After it exits, its members behave like the subject.`);
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
