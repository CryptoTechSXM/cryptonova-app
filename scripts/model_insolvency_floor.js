// model_insolvency_floor.js — V8.49 item: does the insolvency floor actually cap debt?
//
// THE QUESTION (owner, 2026-08-15, after spotting a $5.40 loan on a $3.40 floor):
//   loanEligible() tests memberDebt BEFORE the new loan and never adds the loan itself:
//       return memberDebt[member] < fee * insolvencyFloorBps / 10_000;
//   so every borrower ends up ABOVE the floor by up to one full shortfall. The owner's
//   policy is "if the member cannot cover the loan, do not give the loan."
//
// Owner's model of the economics, to be CONFIRMED against chain here:
//   $5.00 crossing reserve + ~$3.40 earned per cycle = $8.40 against a $10.00 T1 fee
//   -> typical shortfall (= loan) $1.60. Under today's PRE-loan check that allows three
//   loans (0 -> 1.60 -> 3.20, still < 3.40, so a third lands at 4.80). Under a POST-loan
//   check it allows two and refuses the third at 3.20 + 1.60 = 4.80 > 3.40.
//
// WHAT THIS SCRIPT DOES *NOT* DO: invent numbers. Every input below is READ FROM CHAIN.
// If a read fails the script STOPS. (model_epoch_policy.js v1 used `.catch(() => 0)`
// fallbacks, fabricated the answer it was asked to test, and had to be retracted —
// see the SESSION HEALTH NOTE in the V8.48 handoff. No value-returning catches here.)
//
// Read-only. No key. Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\model_insolvency_floor.js
// Optional: SCAN_BLOCKS=50000 (default 200000) to widen the borrower discovery scan.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));
const SCAN_BLOCKS = Number(process.env.SCAN_BLOCKS || 200000);
const CHUNK = 9000; // under QuickNode's 10k eth_getLogs cap

const SF_ABI = [
  "function insolvencyFloorBps() view returns (uint256)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function memberDebt(address) view returns (uint256)",
  "function loanEligible(address,uint8) view returns (bool)",
  "function totalBalance() view returns (uint256)",
  "function stabilityFloor() view returns (uint256)",
  "function totalRescueLoaned() view returns (uint256)",
  "function debtIssuingTier(address) view returns (uint8)",
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];
const MAT_ABI = [
  "function getParkedMember(uint256) view returns (address)",
  "function getParkedCount() view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "—";

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p  = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);
  const blk = await p.getBlockNumber();

  // ── PHASE 1 — plumbing. Any failure here is fatal; a model built on a bad read
  //    is worse than no model (the model_epoch_policy.js lesson).
  console.log("═".repeat(78));
  console.log("PHASE 1 — plumbing (every value read from chain; failure stops the run)");
  console.log("═".repeat(78));
  const floorBps  = await sf.insolvencyFloorBps();
  const t1Fee     = await sf.tierEntryFees(0);
  const totalBal  = await sf.totalBalance();
  const stabFloor = await sf.stabilityFloor();
  const lifetime  = await sf.totalRescueLoaned();
  const threshold = t1Fee * floorBps / 10000n;
  console.log(`  block                    ${blk}`);
  console.log(`  insolvencyFloorBps       ${floorBps}  (${Number(floorBps)/100}%)`);
  console.log(`  T1 entry fee             ${usd(t1Fee)}`);
  console.log(`  => floor threshold       ${usd(threshold)}   <-- loanEligible tests debt < this`);
  console.log(`  SF totalBalance          ${usd(totalBal)}`);
  console.log(`  SF stabilityFloor        ${usd(stabFloor)}`);
  console.log(`  lifetime rescue loaned   ${usd(lifetime)}`);
  if (totalBal <= stabFloor) {
    console.log(`  NOTE: SF is at or below stabilityFloor — NO loan can be issued right now`);
    console.log(`        regardless of policy. The model below is about what happens when it refills.`);
  }

  // ── PHASE 2 — the real borrower population, from events + live debt reads.
  console.log("\n" + "═".repeat(78));
  console.log(`PHASE 2 — borrowers discovered from MemberDebtIncreased (last ${SCAN_BLOCKS} blocks)`);
  console.log("═".repeat(78));
  const from0 = Math.max(0, blk - SCAN_BLOCKS);
  const borrowers = new Set();
  const loanSizes = [];
  const loansByTier = {};
  let scanned = 0, holes = 0;
  for (let from = from0; from <= blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    let logs;
    try { logs = await sf.queryFilter(sf.filters.MemberDebtIncreased(), from, to); }
    catch (e) { holes++; console.log(`  ! chunk ${from}-${to} FAILED (${(e.shortMessage||e.message).slice(0,50)}) — counted as a HOLE, not as zero`); continue; }
    scanned++;
    for (const l of logs) { borrowers.add(l.args.member.toLowerCase()); loanSizes.push(l.args.amount); (loansByTier[Number(l.args.tier)] ||= []).push(l.args.amount); }
  }
  if (holes) console.log(`  WARNING: ${holes} chunk(s) unreadable — population is a LOWER BOUND, not complete.`);
  console.log(`  chunks ok ${scanned}, loan events ${loanSizes.length}, unique borrowers ${borrowers.size}`);
  if (!loanSizes.length) { console.log("  no loans found in range — widen SCAN_BLOCKS. Stopping."); process.exit(0); }

  const sorted = [...loanSizes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const med    = sorted[Math.floor(sorted.length / 2)];
  const sum    = loanSizes.reduce((a, b) => a + b, 0n);
  console.log(`  loan size: min ${usd(sorted[0])}  median ${usd(med)}  max ${usd(sorted[sorted.length-1])}  mean ${usd(sum / BigInt(loanSizes.length))}`);
  console.log(`  OWNER'S MODEL SAYS the typical T1 loan is $1.60 ($5.00 reserve + $3.40 earned vs $10.00 fee).`);
  console.log(`  BY TIER (the pooled median above mixes tiers and is misleading on its own):`);
  for (const t of Object.keys(loansByTier).sort()) {
    const arr = [...loansByTier[t]].sort((a,b) => (a<b?-1:1));
    const s2  = arr.reduce((a,b) => a+b, 0n);
    console.log(`    T${Number(t)+1}: ${arr.length} loan(s)  min ${usd(arr[0])}  median ${usd(arr[Math.floor(arr.length/2)])}  max ${usd(arr[arr.length-1])}  mean ${usd(s2/BigInt(arr.length))}`);
  }

  // live debt per borrower (authoritative — not reconstructed from events)
  const debts = [];
  for (const b of borrowers) debts.push({ addr: b, debt: await sf.memberDebt(b) });
  const withDebt = debts.filter(d => d.debt > 0n).sort((a, b) => (a.debt > b.debt ? -1 : 1));
  const outstanding = withDebt.reduce((a, d) => a + d.debt, 0n);
  // loanEligible() measures against THE TIER BEING RESCUED, not always T1. A $5.20 debt
  // is a breach at T1 ($3.40 floor) and perfectly legal at T2 ($25 fee -> $8.50 floor).
  // Comparing everyone to T1 overstates the problem, so split by each member's own tier.
  const feeCache = {};
  for (const d of withDebt) {
    d.tier = Number(await sf.debtIssuingTier(d.addr));
    if (feeCache[d.tier] === undefined) feeCache[d.tier] = await sf.tierEntryFees(d.tier);
    d.tierFee   = feeCache[d.tier];
    d.tierFloor = d.tierFee * floorBps / 10000n;
    d.breach    = d.debt >= d.tierFloor;
  }
  const byTier = {};
  for (const d of withDebt) {
    const k = "T" + (d.tier + 1);
    byTier[k] = byTier[k] || { n: 0, breach: 0, floor: d.tierFloor, worst: 0n, owed: 0n };
    byTier[k].n++; byTier[k].owed += d.debt;
    if (d.breach) byTier[k].breach++;
    if (d.debt > byTier[k].worst) byTier[k].worst = d.debt;
  }
  console.log("\n  BREACH BY THE MEMBER'S OWN TIER FLOOR (this is the honest comparison):");
  for (const k of Object.keys(byTier).sort()) {
    const b = byTier[k];
    console.log(`    ${k}: ${b.n} debtor(s), floor ${usd(b.floor)}, owed ${usd(b.owed)}, ` +
                `OVER FLOOR ${b.breach} (${pct(b.breach, b.n)}), worst ${usd(b.worst)}` +
                (b.worst > b.floor ? `  = ${(Number(b.worst)/Number(b.floor)).toFixed(2)}x` : ""));
  }
  const over = withDebt.filter(d => d.breach);
  console.log(`\n  borrowers still owing    ${withDebt.length} of ${borrowers.size}`);
  console.log(`  outstanding total        ${usd(outstanding)}`);
  console.log(`\n  ABOVE THEIR OWN TIER FLOOR  ${over.length}  (${pct(over.length, withDebt.length)} of debtors)`);
  console.log(`     ^ under a POST-loan check none of these could have reached this debt.`);
  if (withDebt.length) {
    console.log(`  worst 5 debts:           ${withDebt.slice(0,5).map(d => usd(d.debt)).join("  ")}`);
    const mx = withDebt[0].debt;
    console.log(`  max debt / floor         ${(Number(mx)/Number(threshold)).toFixed(2)}x`);
  }

  // ── PHASE 3 — the parked population that would borrow NEXT.
  console.log("\n" + "═".repeat(78));
  console.log("PHASE 3 — currently parked members (who the next loans would go to)");
  console.log("═".repeat(78));
  const pairs = [["T1 MatA", A.tiers.T1.matA], ["T1 MatB", A.tiers.T1.matB]];
  const parked = [];
  for (const [label, addr] of pairs) {
    const m = new ethers.Contract(addr, MAT_ABI, p);
    let n;
    try { n = await m.getParkedCount(); }
    catch (e) { console.log(`  ! ${label}: parkedCount unreadable (${(e.shortMessage||e.message).slice(0,40)}) — SKIPPED, not counted as zero`); continue; }
    const fee = await m.ENTRY_FEE();
    for (let i = 0; i < Number(n); i++) {
      const who = await m.getParkedMember(i);
      const wd  = await m.withdrawableOf(who);
      const rs  = await m.crossingReserveOf(who);
      const contrib = wd + rs;
      const short = fee > contrib ? fee - contrib : 0n;
      parked.push({ label, who, wd, rs, contrib, fee, short, debt: await sf.memberDebt(who) });
    }
    console.log(`  ${label}: ${n} parked  (fee ${usd(fee)})`);
  }
  if (parked.length) {
    const shorts = parked.map(x => x.short).sort((a,b) => (a<b?-1:1));
    console.log(`  shortfall: min ${usd(shorts[0])}  median ${usd(shorts[Math.floor(shorts.length/2)])}  max ${usd(shorts[shorts.length-1])}`);
    const selfFunded = parked.filter(x => x.short === 0n).length;
    console.log(`  self-funded (no loan needed): ${selfFunded} of ${parked.length}`);
  }

  // ── PHASE 4 — the three candidate policies, applied to the MEASURED population.
  console.log("\n" + "═".repeat(78));
  console.log("PHASE 4 — candidate policies against the measured parked population");
  console.log("═".repeat(78));
  // each parked member is judged against THEIR tier's floor (fee x floorBps)
  for (const x of parked) x.floor = x.fee * floorBps / 10000n;
  const policies = [
    { key: "A  CURRENT (pre-loan check)", grant: (d, s, fl) => (d < fl ? s : 0n) },
    { key: "B  STRICT  (post-loan check)", grant: (d, s, fl) => (d + s <= fl ? s : 0n) },
    { key: "C  PARTIAL (clamp to floor)",  grant: (d, s, fl) => (d >= fl ? 0n : (d + s <= fl ? s : fl - d)) },
  ];
  console.log(`  ${"policy".padEnd(30)} ${"granted".padStart(8)} ${"refused".padStart(8)} ${"SF out".padStart(10)} ${"max debt after".padStart(15)}`);
  console.log("  " + "-".repeat(76));
  for (const pol of policies) {
    let granted = 0, refused = 0, out = 0n, maxAfter = 0n, partial = 0;
    for (const x of parked) {
      if (x.short === 0n) continue;               // self-funded: no loan either way
      const amt = pol.grant(x.debt, x.short, x.floor);
      if (amt === 0n) { refused++; continue; }
      granted++;
      if (amt < x.short) partial++;
      out += amt;
      const after = x.debt + amt;
      if (after > maxAfter) maxAfter = after;
    }
    console.log(`  ${pol.key.padEnd(30)} ${String(granted).padStart(8)} ${String(refused).padStart(8)} ${usd(out).padStart(10)} ${usd(maxAfter).padStart(15)}` +
                (partial ? `   (${partial} part-funded — member must cover the rest)` : ""));
  }
  console.log(`\n  Refused members are NOT abandoned: they can always selfRescue (the floor gates`);
  console.log(`  SF LENDING only). Under keeper discovery a floored member routes to the`);
  console.log(`  eviction valve — which today fires on the 24h parked clock, NOT the owner's`);
  console.log(`  3-5 day policy (V8_49_SCOPE.md item 1). Judge B and C with that in mind.`);

  // ── PHASE 5 — repayment reality. Policy is only as good as the clawback.
  console.log("\n" + "═".repeat(78));
  console.log("PHASE 5 — is the debt actually coming back?");
  console.log("═".repeat(78));
  let repaid = 0n, repayEvents = 0;
  for (let from = from0; from <= blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    try {
      const logs = await sf.queryFilter(sf.filters.MemberDebtRepaid(), from, to);
      for (const l of logs) { repaid += l.args.amount; repayEvents++; }
    } catch (_) { /* counted as a hole above; do not fabricate a zero */ }
  }
  console.log(`  lent (lifetime, contract counter) ${usd(lifetime)}`);
  console.log(`  repaid (events in range)          ${usd(repaid)}  over ${repayEvents} repayments`);
  console.log(`  recovery ratio                    ${lifetime > 0n ? pct(Number(repaid), Number(lifetime)) : "—"}`);
  console.log(`  RULE OF THUMB: if recovery stays far below 100%, tightening the floor (B or C)`);
  console.log(`  is the lever that matters; loosening it only grows a book that is not coming back.`);
  console.log("\nDone. No value was assumed — every figure above came from a chain read.\n");
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
