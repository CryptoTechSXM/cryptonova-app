// diag_parked_growth.js — IS the parked queue growing, WHAT SHAPE, and IS IT A LOOP?
// (V8.48 session, 2026-08-12 — owner-raised deploy gate: "parked members are growing
//  exponentially and I want to investigate before deploying V8.48.")
//
// Three questions, answered separately so the theory cannot outrun the data:
//   1. TRAJECTORY — parks vs rescues vs evictions per day since the V8.47 deploy.
//      Growth can be linear (inflow rate > sweep capacity) or accelerating
//      (each rescue seeds the next park). The curve tells them apart.
//   2. THE LOOP SIGNATURE — parks per unique member. If the queue grows on NEW
//      members, it is adoption outrunning the sweeps. If the SAME members park
//      3, 5, 10 times, it is the rescue -> re-seat (with SF debt) -> cycle out
//      underfunded -> park-again loop. Repeat share is the number that decides.
//   3. THE FINANCING — SF MemberDebtIncreased vs MemberDebtRepaid daily, plus the
//      live totalRescueLoaned/totalRescueRepaid counters. A self-sustaining loop
//      shows up as outstanding debt climbing with the queue.
//
// HONESTY NOTES, read before quoting numbers:
//   - Days are approximated from block numbers (Base Sepolia ~2s blocks), anchored
//     on the REAL timestamps of the first and last block scanned and interpolated
//     linearly. Good for shape, not for hour precision.
//   - Any failed log range is COUNTED AND PRINTED; totals with holes are floors.
//   - "Currently parked" is read live from getParkedCount() per matrix — that part
//     is exact, not derived from events.
//
// Read-only. Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_parked_growth.js
// Optional: WINDOW=3000 (smaller eth_getLogs chunks), FROM=<block> to override the
// V8.47 deploy floor of 45,060,000.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const FROM   = Number(process.env.FROM || 45_060_000);   // V8.47 deploy floor
const CHUNK  = Number(process.env.WINDOW || 9000);

const TR_ABI  = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI  = ["function pairCount() view returns (uint256)",
                 "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)",
  "event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed)",
  "event MemberEvicted(address indexed member, uint256 totalWithdrawn)",
  "function getParkedCount() view returns (uint256)",
];
const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

async function chunkedLogs(c, filter, from, to, label, holes) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(a + CHUNK - 1, to);
    let got = null, lastErr = null;
    for (let att = 0; att < 3 && got === null; att++) {
      try { got = await c.queryFilter(filter, a, b); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 700 * (att + 1))); }
    }
    if (got === null) {
      holes.n++;
      if (!holes.said) { console.log(`    ${label}: blocks ${a}-${b} FAILED (${(lastErr?.shortMessage || lastErr?.message || "").slice(0, 80)})`); holes.said = true; }
    } else out.push(...got);
  }
  return out;
}

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env or pass RPC=..."); process.exit(1); }
  const p   = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const tip = await p.getBlockNumber();
  const t0  = (await p.getBlock(FROM)).timestamp;
  const t1  = (await p.getBlock(tip)).timestamp;
  const blkToTs = bn => t0 + (bn - FROM) * (t1 - t0) / (tip - FROM);
  const dayOf   = bn => new Date(blkToTs(bn) * 1000).toISOString().slice(0, 10);

  console.log(`\nparked-growth diagnosis — blocks ${FROM}..${tip}`);
  console.log(`window ${new Date(t0 * 1000).toISOString().slice(0, 10)} -> ${new Date(t1 * 1000).toISOString().slice(0, 10)} (~${((t1 - t0) / 86400).toFixed(1)} days)\n`);

  const [pms] = await new ethers.Contract(A.tierRouter, TR_ABI, p).getAllTiers();
  const holes = { n: 0, said: false };

  // day -> {park, self, copay, evict}; member -> park count; live queue census
  const daily = new Map();
  const bump  = (bn, k) => { const d = dayOf(bn); if (!daily.has(d)) daily.set(d, { park: 0, self: 0, copay: 0, evict: 0 }); daily.get(d)[k]++; };
  const parksByMember = new Map();
  let liveParked = 0;
  const liveByTier = [];

  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    let n = 0; try { n = Number(await pm.pairCount()); } catch { holes.n++; continue; }
    let tierLive = 0;
    for (let i = 0; i < n; i++) {
      let pr; try { pr = await pm.getPairAt(i); } catch { holes.n++; continue; }
      for (const addr of [pr[0], pr[1]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const c = new ethers.Contract(addr, MAT_ABI, p);
        const label = `T${t + 1}.${i + 1}`;
        try { tierLive += Number(await c.getParkedCount()); } catch { holes.n++; }
        for (const ev of await chunkedLogs(c, c.filters.MemberParked(),  FROM, tip, label, holes)) {
          bump(ev.blockNumber, "park");
          parksByMember.set(ev.args.member, (parksByMember.get(ev.args.member) || 0) + 1);
        }
        for (const ev of await chunkedLogs(c, c.filters.SelfRescue(),    FROM, tip, label, holes)) bump(ev.blockNumber, "self");
        for (const ev of await chunkedLogs(c, c.filters.CoPayRescue(),   FROM, tip, label, holes)) bump(ev.blockNumber, "copay");
        for (const ev of await chunkedLogs(c, c.filters.MemberEvicted(), FROM, tip, label, holes)) bump(ev.blockNumber, "evict");
      }
    }
    liveByTier.push(`T${t + 1}: ${tierLive}`);
    liveParked += tierLive;
  }

  // ── 1. trajectory ──────────────────────────────────────────────────────────
  console.log("1. TRAJECTORY — per (approx) day");
  console.log("day          parks   selfR   copay   evict   net(+q)   cumulative-net");
  console.log("─".repeat(76));
  let cum = 0;
  const rows = [...daily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const netByDay = [];
  for (const [d, r] of rows) {
    const net = r.park - r.self - r.copay - r.evict;
    cum += net; netByDay.push(r.park);
    console.log(`${d}  ${pad(r.park, 5)}  ${pad(r.self, 6)}  ${pad(r.copay, 6)}  ${pad(r.evict, 6)}  ${pad(net, 8)}  ${pad(cum, 15)}`);
  }
  console.log(`\n  LIVE queue right now (getParkedCount, exact): ${liveParked}   [${liveByTier.join("  ")}]`);
  if (rows.length >= 6) {
    const firstHalf = netByDay.slice(0, Math.floor(netByDay.length / 2)).reduce((a, x) => a + x, 0) / Math.floor(netByDay.length / 2);
    const lastThree = netByDay.slice(-3).reduce((a, x) => a + x, 0) / Math.min(3, netByDay.length);
    console.log(`  park RATE: first-half avg ${firstHalf.toFixed(1)}/day vs last-3-day avg ${lastThree.toFixed(1)}/day`
      + `  ->  ${lastThree > firstHalf * 1.5 ? "ACCELERATING" : lastThree < firstHalf * 0.67 ? "SLOWING" : "ROUGHLY LINEAR"}`);
  }

  // ── 2. the loop signature ──────────────────────────────────────────────────
  const counts = [...parksByMember.values()];
  const totalParks = counts.reduce((a, x) => a + x, 0);
  const buckets = { "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11+": 0 };
  let repeatParks = 0;
  for (const c of counts) {
    if (c === 1) buckets["1"]++; else if (c === 2) buckets["2"]++;
    else if (c <= 5) buckets["3-5"]++; else if (c <= 10) buckets["6-10"]++; else buckets["11+"]++;
    if (c >= 3) repeatParks += c;
  }
  console.log(`\n2. LOOP SIGNATURE — ${totalParks} park events across ${parksByMember.size} unique members`);
  console.log(`   parks-per-member histogram: 1x: ${buckets["1"]}   2x: ${buckets["2"]}   3-5x: ${buckets["3-5"]}   6-10x: ${buckets["6-10"]}   11+x: ${buckets["11+"]}`);
  console.log(`   REPEAT SHARE: ${(100 * repeatParks / Math.max(totalParks, 1)).toFixed(1)}% of all park events come from members who parked 3+ times`);
  const top = [...parksByMember.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("   top repeat parkers:");
  for (const [m, c] of top) console.log(`     ${m}  x${c}`);

  // ── 3. the financing ───────────────────────────────────────────────────────
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);
  let loaned = 0n, repaid = 0n;
  const sfDaily = new Map();
  const sfBump = (bn, k, amt) => { const d = dayOf(bn); if (!sfDaily.has(d)) sfDaily.set(d, { loaned: 0n, repaid: 0n }); sfDaily.get(d)[k] += amt; };
  for (const ev of await chunkedLogs(sf, sf.filters.MemberDebtIncreased(), FROM, tip, "SF", holes)) { loaned += ev.args.amount; sfBump(ev.blockNumber, "loaned", ev.args.amount); }
  for (const ev of await chunkedLogs(sf, sf.filters.MemberDebtRepaid(),    FROM, tip, "SF", holes)) { repaid += ev.args.amount; sfBump(ev.blockNumber, "repaid", ev.args.amount); }
  console.log(`\n3. FINANCING — SF rescue debt per (approx) day`);
  console.log("day          loaned        repaid        net-outstanding-delta");
  console.log("─".repeat(64));
  let sfCum = 0n;
  for (const [d, r] of [...sfDaily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const net = r.loaned - r.repaid; sfCum += net;
    console.log(`${d}  ${pad(usd(r.loaned), 11)}  ${pad(usd(r.repaid), 11)}  ${pad(usd(net), 12)}`);
  }
  console.log(`   events total: loaned ${usd(loaned)} / repaid ${usd(repaid)} / outstanding-from-events ${usd(loaned - repaid)}`);
  // ⛔ READ THE COUNTERS AT `tip`, NOT AT "NOW". THIS USED TO BE A RACE AND IT PRINTED
  //    A WRONG DIAGNOSIS.
  //
  // The event scan above walks ~585k blocks across 22 matrices — minutes of wall clock.
  // This call used to run afterwards with no blockTag, so it read the counters at the
  // CURRENT head while the events stopped at `tip`. On a live chain the counters are
  // therefore ahead by whatever was lent during the scan, and the script announced
  // "EVENTS DO NOT RECONCILE — some ranges dropped" — blaming a cause that was not there.
  //
  // MEASURED 2026-08-18: this script reported events $956.46 against counters $961.65,
  // a $5.19 gap, while printing "no holes — complete" in the same breath. Those two
  // statements cannot both be true, which is what made it worth chasing.
  // scripts/diag_sf_debt_reconcile.js then scanned the SAME fund from block 0 and
  // reconciled EXACTLY ($966.84 / $966.84) — and its counter read $966.84 against this
  // run's $961.65, i.e. the counter had moved by exactly the missing $5.19. At the daily
  // lending rate this script itself measures (~$211/day), $5.19 is about 35 minutes:
  // the length of the scan. A snapshot race, not a defect and not a dropped range.
  //
  // Pinning the read to `tip` makes the two sides describe the same instant. If they
  // still disagree after this, the cause is real and the message below says so.
  try {
    const [L, R] = await Promise.all([
      sf.totalRescueLoaned({ blockTag: tip }),
      sf.totalRescueRepaid({ blockTag: tip }),
    ]);
    console.log(`   CONTRACT counters (ground truth, AT BLOCK ${tip}): loaned ${usd(L)} / repaid ${usd(R)} / OUTSTANDING ${usd(L - R)}`
      + (L - R === loaned - repaid
        ? "   (events reconcile exactly)"
        : "   << EVENTS DO NOT RECONCILE AT THE SAME BLOCK — this is NOT the old snapshot race and NOT explained by scan timing. Investigate."));
  } catch (e) {
    // An archive node is needed for a historical blockTag. Say which failure this is
    // rather than silently falling back to a head read and re-creating the race.
    console.log(`   counters unreadable AT BLOCK ${tip}: ${(e.shortMessage || e.message || "").slice(0, 70)}`);
    console.log(`   (a pinned read needs archive access; a head read here would reintroduce`);
    console.log(`    the snapshot race this comment documents — not doing it silently.)`);
  }

  console.log(`\nVERDICT INPUTS${holes.n ? `  (${holes.n} failed range(s)/read(s) — event-derived numbers are FLOORS; re-run with WINDOW=3000)` : "  (no holes — complete)"}`);
  console.log("  Read the three sections together: an ACCELERATING park rate + a high repeat");
  console.log("  share + climbing SF outstanding = the self-sustaining loop is real. A linear");
  console.log("  rate + mostly-1x members = inflow outrunning sweep capacity, a different fix.");
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message || e); process.exit(1); });
