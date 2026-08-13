// diag_debt_rank.js — WHO carries the SF rescue debt, and how concentrated is it?
// (V8.48 session, 2026-08-13 — second open question on the parked-loop deploy gate:
//  "is the $6,952 spread thin or carried by a few compounding accounts?" The answer
//  picks between the levers: an insolvency floor on loans targets a concentrated
//  book; crossing-reserve bps targets a thin one.)
//
// METHOD:
//   1. Scan SF MemberDebtIncreased / MemberDebtRepaid since the V8.47 deploy to
//      collect every wallet that ever borrowed (and per-member loaned/repaid sums,
//      plus the highest tier each member borrowed in).
//   2. Read memberDebtOf() LIVE for every unique borrower — counters over event
//      sums, the diag_parked_growth lesson (event totals ran ~$30 short of the
//      contract counters; dropped ranges).
//   3. Report: outstanding total (live sum vs SF counters), top 20 borrowers,
//      concentration (top 1% / 5% / 10% share), debt histogram, and the INSOLVENCY
//      table — members whose debt already exceeds ~34% of their loan tier's entry
//      fee, i.e. their ENTIRE expected next-cycle earnings are pre-committed to
//      repayment and the next shortfall is guaranteed (the "lending into a hole"
//      cohort an insolvency floor would stop).
//
// HONESTY NOTES:
//   - Failed log ranges are COUNTED AND PRINTED; the borrower SET with holes is a
//     floor (a member seen only in a dropped range is missed). Live debt reads for
//     the members we DID find are exact.
//   - The 34%-of-fee earnings estimate is the long-measured cycle average, used for
//     BANDING only — per-member cycle earnings vary. The bands are labeled with it.
//   - Read-only. No key needed.
//
// Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_debt_rank.js
// Optional: WINDOW=3000 (smaller eth_getLogs chunks), FROM=<block> override.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const FROM  = Number(process.env.FROM || 45_060_000);   // V8.47 deploy floor
const CHUNK = Number(process.env.WINDOW || 9000);

const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
  "function memberDebtOf(address) view returns (uint256)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
];
const TR_ABI = ["function tierEntryFees(uint256) view returns (uint256)"];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

(async () => {
  if (!RPC) { console.error("No RPC in .env (BASE_SEPOLIA_RPC_URL)"); process.exit(1); }
  const rp = new ethers.JsonRpcProvider(RPC);
  const sf = new ethers.Contract(A.stabilityFund || A.StabilityFund, SF_ABI, rp);
  const tr = new ethers.Contract(A.tierRouter || A.TierRouter, TR_ABI, rp);

  const tip = await rp.getBlockNumber();
  console.log(`scan ${FROM} -> ${tip} (${tip - FROM} blocks, chunk ${CHUNK})`);

  const loaned = new Map();   // member -> { loaned, repaid, events, maxTier }
  const rec = a => { if (!loaned.has(a)) loaned.set(a, { loaned: 0n, repaid: 0n, events: 0, maxTier: 0 }); return loaned.get(a); };
  let failedRanges = 0, failedBlocks = 0;

  for (let from = FROM; from <= tip; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, tip);
    try {
      const [inc, rep] = await Promise.all([
        sf.queryFilter(sf.filters.MemberDebtIncreased(), from, to),
        sf.queryFilter(sf.filters.MemberDebtRepaid(),    from, to),
      ]);
      for (const e of inc) {
        const m = rec(e.args.member.toLowerCase());
        m.loaned += BigInt(e.args.amount); m.events++;
        const t = Number(e.args.tier); if (t + 1 > m.maxTier) m.maxTier = t + 1;   // event tier is 0-based
      }
      for (const e of rep) rec(e.args.member.toLowerCase()).repaid += BigInt(e.args.amount);
    } catch {
      failedRanges++; failedBlocks += to - from + 1;
    }
    if (((from - FROM) / CHUNK) % 40 === 0) process.stdout.write(".");
  }
  console.log(`\nborrowers seen in events: ${loaned.size}` +
    (failedRanges ? `  ⚠ ${failedRanges} ranges (${failedBlocks} blocks) FAILED — the borrower set is a floor` : "  (no holes)"));

  // Live debt per borrower — the exact figure, counters over event math.
  // THROTTLED: QuickNode caps at 125 req/s and killed the first run of this script.
  // Batches of 10 with a 200ms gap (~50/s worst case), 3 retries with backoff —
  // a rate-limit error must never abort the whole measurement.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rows = [];
  const members = [...loaned.keys()];
  for (let i = 0; i < members.length; i += 10) {
    const batch = members.slice(i, i + 10);
    let debts = null;
    for (let attempt = 1; attempt <= 3 && !debts; attempt++) {
      try { debts = await Promise.all(batch.map(m => sf.memberDebtOf(m))); }
      catch { await sleep(1000 * attempt); }
    }
    if (!debts) { console.error(`\n⚠ batch at ${i} failed 3x — aborting rather than guessing`); process.exit(1); }
    batch.forEach((m, j) => rows.push({ m, debt: BigInt(debts[j]), ...loaned.get(m) }));
    await sleep(200);
    if (i % 100 === 0) process.stdout.write("+");
  }
  console.log("");
  rows.sort((a, b) => (b.debt > a.debt ? 1 : b.debt < a.debt ? -1 : 0));

  const liveSum = rows.reduce((s, r) => s + r.debt, 0n);
  const [tl, trp] = await Promise.all([sf.totalRescueLoaned(), sf.totalRescueRepaid()]);
  console.log(`\n== OUTSTANDING ==`);
  console.log(`live sum over ${rows.length} borrowers: ${usd(liveSum)}`);
  console.log(`SF counters: loaned ${usd(tl)} - repaid ${usd(trp)} = ${usd(BigInt(tl) - BigInt(trp))}` +
    `  (gap vs live sum = borrowers missed in dropped ranges, if any)`);

  const withDebt = rows.filter(r => r.debt > 0n);
  console.log(`borrowers with debt RIGHT NOW: ${withDebt.length} of ${rows.length} ever-borrowers`);

  // Concentration
  const share = n => {
    const k = Math.max(1, Math.ceil(withDebt.length * n));
    const s = withDebt.slice(0, k).reduce((a, r) => a + r.debt, 0n);
    return `top ${(n * 100).toFixed(0)}% (${k} wallets): ${usd(s)} = ${liveSum > 0n ? (Number(s * 10000n / liveSum) / 100).toFixed(1) : 0}%`;
  };
  console.log(`\n== CONCENTRATION ==\n${share(0.01)}\n${share(0.05)}\n${share(0.10)}`);

  // Top 20
  console.log(`\n== TOP 20 BORROWERS (live debt · lifetime loaned/repaid · loan events · max tier) ==`);
  for (const r of rows.slice(0, 20)) {
    console.log(`${r.m.slice(0, 10)}…  ${pad(usd(r.debt), 10)}  loaned ${pad(usd(r.loaned), 10)}  repaid ${pad(usd(r.repaid), 10)}  ${pad(r.events, 4)}ev  T${r.maxTier}`);
  }

  // Histogram
  const bands = [[0n, "0"], [1n, "under $1"], [1_000_000n, "$1-10"], [10_000_000n, "$10-50"], [50_000_000n, "$50-200"], [200_000_000n, "$200+"]];
  console.log(`\n== DEBT HISTOGRAM (live) ==`);
  for (let i = 0; i < bands.length; i++) {
    const lo = bands[i][0], hi = i + 1 < bands.length ? bands[i + 1][0] : null;
    const n = rows.filter(r => r.debt >= lo && (hi === null || r.debt < hi) && !(lo === 0n && r.debt !== 0n)).length;
    const count = lo === 0n ? rows.filter(r => r.debt === 0n).length : n;
    console.log(`${pad(bands[i][1], 10)}: ${count}`);
  }

  // Insolvency table: debt vs ~34%-of-fee expected next-cycle earnings, per member's
  // highest loan tier. debt >= earnings estimate => the whole next cycle is already
  // spoken for and the next shortfall is guaranteed (the insolvency-floor cohort).
  console.log(`\n== INSOLVENCY BANDS (debt vs ~34%-of-fee expected cycle earnings, banding only) ==`);
  const fees = [];
  for (let t = 0; t < 10; t++) { try { fees[t] = BigInt(await tr.tierEntryFees(t)); } catch { fees[t] = 0n; } }
  let insolvent = 0, half = 0, ok = 0, unknown = 0, insolventDebt = 0n;
  for (const r of withDebt) {
    const fee = r.maxTier > 0 ? fees[r.maxTier - 1] : 0n;
    if (fee === 0n) { unknown++; continue; }
    const cycleEarn = fee * 34n / 100n;
    if (r.debt >= cycleEarn) { insolvent++; insolventDebt += r.debt; }
    else if (r.debt * 2n >= cycleEarn) half++;
    else ok++;
  }
  console.log(`debt >= ~1 full cycle's earnings (next shortfall GUARANTEED): ${insolvent} wallets holding ${usd(insolventDebt)}`);
  console.log(`debt >= half a cycle's earnings: ${half}`);
  console.log(`debt below half a cycle: ${ok}` + (unknown ? `   (tier unknown: ${unknown})` : ""));
  console.log(`\nDone. Levers this feeds: insolvency floor (stop lending to the first cohort),`);
  console.log(`crossing-reserve bps (run diag_parked_truth.js for the lift table), eviction policy.`);
})();
