// diag_sf_debt_reconcile.js — WHERE IS THE $5.19?
//
// THE QUESTION
//   diag_parked_growth.js reported, on the live V8.48 StabilityFund:
//       events   loaned $956.46   repaid $443.41
//       counters loaned $961.65   repaid $443.41      gap: $5.19, LOANED SIDE ONLY
//   and printed "no holes — complete" in the same breath.
//
// WHAT WAS RULED OUT BY READING THE SOURCE (2026-08-18)
//   StabilityFund has exactly ONE writer of memberDebt[member] += (:941) and exactly ONE
//   writer of totalRescueLoaned += (:942). They sit in the same function and the event
//   fires three lines later (:945) with the SAME `amount`. There is NO silent lending
//   path — that hypothesis is dead, and it was the leading one.
//
//   So the counters and the events CANNOT disagree about a loan that happened inside the
//   scanned window. The gap must therefore be a loan the SCAN did not cover: either
//   before the window's floor, or in a range that failed without being counted.
//
// WHAT THIS SCRIPT DOES
//   Scans ONLY the StabilityFund, ONLY its two debt events, from block 0 by default, and
//   reports the FIRST and LAST event block. If the earliest MemberDebtIncreased sits below
//   diag_parked_growth's floor of 45,060,000, the gap is explained and neither tool is
//   broken — the floor was simply set for V8.47's deploy and the V8.48 fund predates it.
//
//   Nothing is caught silently. Failed ranges are counted, named, and the verdict refuses
//   to call the reconciliation clean while any range failed. Same discipline as
//   diag_parked_ages.js: a swallowed error must never read as an all-clear.
//
// Run: node scripts/diag_sf_debt_reconcile.js
//   FROM=0            override the scan floor
//   WINDOW=9000       eth_getLogs chunk size
const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

require("./rpc_resilience");   // 29.2: Base Sepolia sheds state reads; retry + endpoint fail-over
const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
// ⛔ NO v8_47 DEFAULT HERE, ON PURPOSE. diag_parked_growth.js defaults to
// deployed_addresses_v8_47.json and reads the LIVE v8_48 chain only because .env line 69
// sets ADDRESSES_FILE. Run it with that variable unset and it silently measures a dead
// deployment while printing confident numbers. This script fails loudly instead.
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) { console.log("FATAL: ADDRESSES_FILE is not set (.env line 69). Refusing to guess a deployment."); process.exit(1); }
const A = require(path.join(__dirname, ADDRFILE));

const FROM   = Number(process.env.FROM || 0);
const CHUNK  = Number(process.env.WINDOW || 9000);
const usd = v => "$" + (Number(v) / 1e6).toFixed(2);

const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
  "function totalBalance() view returns (uint256)",
];

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);
  const tip = await p.getBlockNumber();

  console.log(`\n  addresses file   ${ADDRFILE}`);
  console.log(`  StabilityFund    ${A.stabilityFund}`);
  console.log(`  scanning         ${FROM}..${tip}   (diag_parked_growth's floor is 45,060,000)`);

  const [cLoaned, cRepaid, bal] = await Promise.all([
    sf.totalRescueLoaned(), sf.totalRescueRepaid(), sf.totalBalance(),
  ]);

  let eLoaned = 0n, eRepaid = 0n, nInc = 0, nRep = 0;
  let firstInc = null, lastInc = null;
  const failed = [];
  for (let f = FROM; f <= tip; f += CHUNK) {
    const t = Math.min(f + CHUNK - 1, tip);
    try {
      for (const l of await sf.queryFilter(sf.filters.MemberDebtIncreased(), f, t)) {
        eLoaned += l.args.amount; nInc++;
        if (firstInc === null) firstInc = l.blockNumber;
        lastInc = l.blockNumber;
      }
    } catch (e) { failed.push(`inc ${f}-${t}: ${e.shortMessage || e.message}`); }
    try {
      for (const l of await sf.queryFilter(sf.filters.MemberDebtRepaid(), f, t)) { eRepaid += l.args.amount; nRep++; }
    } catch (e) { failed.push(`rep ${f}-${t}: ${e.shortMessage || e.message}`); }
  }

  console.log(`\n  CONTRACT COUNTERS (ground truth)`);
  console.log(`    totalRescueLoaned  ${usd(cLoaned)}`);
  console.log(`    totalRescueRepaid  ${usd(cRepaid)}`);
  console.log(`    OUTSTANDING        ${usd(cLoaned - cRepaid)}`);
  console.log(`    totalBalance       ${usd(bal)}`);
  console.log(`\n  EVENT SUMS over ${FROM}..${tip}`);
  console.log(`    MemberDebtIncreased  ${String(nInc).padStart(5)} events  ${usd(eLoaned)}`);
  console.log(`    MemberDebtRepaid     ${String(nRep).padStart(5)} events  ${usd(eRepaid)}`);
  console.log(`    first / last increase at block  ${firstInc ?? "-"} / ${lastInc ?? "-"}`);

  const gapL = cLoaned - eLoaned, gapR = cRepaid - eRepaid;
  console.log(`\n  GAP (counter - events)   loaned ${usd(gapL)}   repaid ${usd(gapR)}`);

  console.log(`\n  ── VERDICT ──`);
  if (failed.length) {
    console.log(`  ⚠ ${failed.length} RANGE(S) FAILED — this run cannot reconcile anything. Every one:`);
    for (const f of failed.slice(0, 20)) console.log(`     ${f}`);
    if (failed.length > 20) console.log(`     ... and ${failed.length - 20} more`);
    console.log(`  Re-run with WINDOW=3000.`);
  } else if (gapL === 0n && gapR === 0n) {
    console.log(`  ✅ EXACT on both sides from block ${FROM}.`);
    if (firstInc !== null && firstInc < 45_060_000) {
      console.log(`  AND THE EARLIEST LOAN IS AT BLOCK ${firstInc}, BELOW diag_parked_growth's`);
      console.log(`  45,060,000 FLOOR. That is the whole $5.19: loans issued before that`);
      console.log(`  script starts looking. Neither tool is broken and there is NO silent`);
      console.log(`  lending path — the floor was set for V8.47's deploy, not this fund's.`);
      console.log(`  FIX: give diag_parked_growth a FROM at or below ${firstInc}, or state`);
      console.log(`  in its output that its debt totals begin at its floor.`);
    } else {
      console.log(`  The earliest loan is at ${firstInc}, at or above the 45,060,000 floor,`);
      console.log(`  so the window does NOT explain the gap that script reported. Something`);
      console.log(`  else differed between the two runs — compare their StabilityFund`);
      console.log(`  addresses before looking any further.`);
    }
  } else {
    console.log(`  ⛔ STILL DOES NOT RECONCILE from block ${FROM}, with zero failed ranges.`);
    console.log(`  Source reading says StabilityFund has ONE writer of memberDebt (:941) and`);
    console.log(`  ONE of totalRescueLoaned (:942), both emitting at :945 with the same`);
    console.log(`  amount — so this SHOULD be impossible. Do not explain it away. Check`);
    console.log(`  whether the counters were seeded at deploy or migrated from a prior fund.`);
  }
  console.log("");
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
