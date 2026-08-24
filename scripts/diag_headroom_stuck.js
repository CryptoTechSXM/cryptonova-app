// diag_headroom_stuck.js — WHY is a past-grace parked member being refused?
//
// THE QUESTION (session 34, 2026-08-24). copay_rescue.js's coverage run proved the
// sweep reaches every tier and every pair: 321 parked, 0 unreadable reads, and the
// ~40 members past the 24h grace ARE attempted. Every T1 attempt then failed with
// `execution reverted: "SF: insolvency floor"`, while the fund held $1,679 and the
// shortfalls were $1.15-$2.67. 33.7 called that "refusing on policy, not on money".
// This asks WHICH policy, per member, from the contract rather than from a story.
//
// ⛔ WHAT THE FIRST RUN OF THIS SCRIPT TAUGHT, 2026-08-24 — KEEP IT.
//   v1 asked the chain for loanHeadroom / loanEligibleFor / baseAdvanceBps and got 31
//   `execution reverted`. Those are V8.49 and V8.50 functions. THE WORKING TREE IS NOT
//   THE DEPLOYMENT. I read the mechanism out of contracts/StabilityFund.sol on branch
//   v8.1 and quoted it as live, while the comments in that very file said "V8.49" and
//   "V8.50 SPONSORSHIP GATE" and handoff 33.7 says Policy B is not deployed.
//   The verdict refusing to conclude is the ONLY reason this did not become a confident
//   wrong answer. That refusal is load-bearing — do not soften it.
//
// THE RULE THAT IS ACTUALLY DEPLOYED (V8.48, commit d382d37, 2026-08-13):
//   loanEligible(member, tierIdx) = memberDebt[member] < tierEntryFees[tierIdx] * bps/10000
//   It is a FLAT gate on existing debt. It never reads the amount being asked for, so a
//   member $0.31 over the line is refused a $2.67 rescue exactly as hard as one $14 over.
//   At T1 with bps=3400 the ceiling is $10.00 * 0.34 = $3.40 of LIFETIME debt.
//
// SO THIS SCRIPT PROBES FOR THE RULE INSTEAD OF ASSUMING ONE. It tries the V8.49+
// signature, falls back to the V8.48 one, and NAMES which answered. A version mismatch
// becomes a stated fact instead of a wall of PROBLEM lines.
//
// Run: npx hardhat run scripts/diag_headroom_stuck.js --network baseSepolia
//   MEMBERS=0xabc,0xdef   override the default list
//   TIER=0                tier INDEX (0 = T1), default 0
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

// The ten oldest past-grace parked members, from diag_parked_ages.js at
// 2026-08-24T01:52:38Z. Ages 3.03-3.86d, all T1 MatA except one T2 MatB.
const DEFAULT_MEMBERS = [
  "0x0D103Cb2", "0x3905DA1f", "0x396DFA14", "0xadc23E10", "0x3c175568",
  "0x52BEA7CE", "0x3af00D73", "0xd85770db", "0x4a547E4a", "0xB3Ceb3cB",
];

const SF = [
  "function insolvencyFloorBps() view returns (uint256)",
  "function baseAdvanceBps() view returns (uint256)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function memberDebtOf(address) view returns (uint256)",
  "function loanHeadroom(address,uint8) view returns (uint256)",       // V8.49+
  "function loanEligibleFor(address,uint8,uint256) view returns (bool)", // V8.49+
  "function loanEligible(address,uint8) view returns (bool)",            // V8.48
  "function totalBalance() view returns (uint256)",
];
const TR = ["function directCount(address) view returns (uint32)"];
const MX = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
let problems = 0;
const PROBLEM = (what, e) => {
  problems++;
  console.log(`  PROBLEM ${what}: ${(e && (e.shortMessage || e.message) || "unreadable").slice(0, 90)}`);
};

async function main() {
  const TIER = Number(process.env.TIER || 0);
  const sf = await ethers.getContractAt(SF, A.stabilityFund);
  const tr = await ethers.getContractAt(TR, A.tierRouter);

  console.log("  StabilityFund :", A.stabilityFund);
  console.log("  addresses     :", process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json");
  console.log("  tier index    :", TIER, `(T${TIER + 1})`);

  let floorBps = null, fee = null, bal = null;
  try { floorBps = await sf.insolvencyFloorBps(); } catch (e) { PROBLEM("insolvencyFloorBps()", e); }
  try { fee = await sf.tierEntryFees(TIER); } catch (e) { PROBLEM(`tierEntryFees(${TIER})`, e); }
  try { bal = await sf.totalBalance(); } catch (e) { PROBLEM("totalBalance()", e); }

  // PROBE, do not assume. An absent function is a DEPLOYMENT FACT, not a failure —
  // it is reported as such and never counted as a PROBLEM.
  const probe = async (name, fn) => { try { await fn(); return true; } catch { return false; } };
  const zero = "0x0000000000000000000000000000000000000000";
  const hasV49 = await probe("loanEligibleFor", () => sf.loanEligibleFor(zero, TIER, 1n));
  const hasV48 = await probe("loanEligible",    () => sf.loanEligible(zero, TIER));
  const hasSponsor = await probe("baseAdvanceBps", () => sf.baseAdvanceBps());
  const RULE = hasV49 ? "V8.49+ loanEligibleFor(member,tier,advance) — amount-aware"
             : hasV48 ? "V8.48 loanEligible(member,tier) — FLAT gate, ignores the amount asked for"
             : "NONE FOUND — cannot determine the deployed rule";

  console.log(`  insolvencyFloorBps: ${floorBps}  (working tree ships 5000)`);
  console.log(`  tier entry fee    : ${fee === null ? "?" : usd(fee)}`);
  console.log(`  SF totalBalance   : ${bal === null ? "?" : usd(bal)}  <- NOT read by the gate`);
  console.log(`  DEPLOYED RULE     : ${RULE}`);
  console.log(`  sponsorship gate  : ${hasSponsor ? "present (V8.50)" : "ABSENT on this deployment"}`);
  if (!hasV49 && !hasV48) {
    console.log("  ⛔ Neither signature answers. Stop and identify the deployed build before reading on.");
    return;
  }
  let ceiling = null;
  if (floorBps !== null && fee !== null) {
    ceiling = fee * floorBps / 10000n;
    console.log(`  => ceiling = fee * bps/10000 = ${usd(ceiling)} of LIFETIME debt at this tier`);
  }

  // Resolve the short prefixes against the live parked queues so the script works
  // from the census output without hand-copying 40-char addresses.
  const want = (process.env.MEMBERS || DEFAULT_MEMBERS.join(",")).split(",").map(s => s.trim()).filter(Boolean);
  const full = [];
  const t = A.tiers[`T${TIER + 1}`];
  for (const key of ["matA", "matB"]) {
    if (!t || !t[key]) continue;
    const c = await ethers.getContractAt(MX, t[key]);
    let n = 0n;
    try { n = await c.getParkedCount(); } catch (e) { PROBLEM(`${key} getParkedCount()`, e); continue; }
    for (let k = 0n; k < n; k++) {
      try {
        const m = await c.getParkedMember(k);
        if (want.some(w => m.toLowerCase().startsWith(w.toLowerCase())) && !full.find(f => f.m === m)) {
          full.push({ m, mx: c, where: key });
        }
      } catch (e) { PROBLEM(`${key} getParkedMember(${k})`, e); }
    }
  }
  const unresolved = want.filter(w => !full.some(f => f.m.toLowerCase().startsWith(w.toLowerCase())));
  if (unresolved.length) console.log(`  NOT FOUND in this tier's parked queues: ${unresolved.join(", ")}`);

  console.log("\n  member       debt    ceiling  shortfall  eligible?  verdict");
  console.log("  " + "-".repeat(92));
  let capExhausted = 0, otherRefusal = 0, wouldPass = 0;
  for (const { m, mx, where } of full) {
    let debt = null, short = null, ok = null;
    try { debt = await sf.memberDebtOf(m); } catch (e) { PROBLEM(`memberDebtOf(${m.slice(0, 10)})`, e); }
    try {
      const [f, res, wd] = await Promise.all([mx.ENTRY_FEE(), mx.crossingReserveOf(m), mx.withdrawableOf(m)]);
      const eff = res + wd;
      short = f > eff ? f - eff : 0n;
    } catch (e) { PROBLEM(`price ${m.slice(0, 10)}`, e); }
    // The CONTRACT's own answer, from whichever signature this deployment has.
    try {
      ok = hasV49 ? await sf.loanEligibleFor(m, TIER, short === null ? 1n : short)
                  : await sf.loanEligible(m, TIER);
    } catch (e) { PROBLEM(`eligibility(${m.slice(0, 10)})`, e); }

    let verdict = "?";
    if (ok === true) { verdict = "ELIGIBLE — refused by something else, follow that"; wouldPass++; }
    else if (ok === false && debt !== null && ceiling !== null) {
      if (debt >= ceiling) {
        verdict = `CAP EXHAUSTED — debt ${usd(debt)} >= ceiling ${usd(ceiling)}, over by ${usd(debt - ceiling)}`;
        capExhausted++;
      } else { verdict = "refused though debt < ceiling — SOMETHING ELSE IS GATING"; otherRefusal++; }
    }
    console.log(
      `  ${m.slice(0, 10)}  ${(debt === null ? "?" : usd(debt)).padStart(8)}  ` +
      `${(ceiling === null ? "?" : usd(ceiling)).padStart(7)}  ${(short === null ? "?" : usd(short)).padStart(9)}  ` +
      `${String(ok).padStart(9)}  ${verdict}  [${where}]`);
  }

  console.log("\n  -- VERDICT --");
  console.log(`    members examined : ${full.length} of ${want.length} requested`);
  console.log(`    read failures    : ${problems}`);
  console.log(`    cap exhausted    : ${capExhausted}`);
  console.log(`    refused, cap NOT the cause : ${otherRefusal}`);
  console.log(`    eligible (refused elsewhere): ${wouldPass}`);
  if (problems > 0) {
    console.log("    READS FAILED — this verdict is INCOMPLETE. Do not quote it.");
  } else if (capExhausted === full.length && full.length > 0) {
    console.log("    HYPOTHESIS HOLDS: every one is at its lifetime cap. Fund balance is irrelevant;");
    console.log("    raising insolvencyFloorBps or forgiving debt is the only thing that moves them.");
  } else if (otherRefusal > 0 || wouldPass > 0) {
    console.log("    HYPOTHESIS LOSES for at least one member — the cap is not the whole story.");
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
