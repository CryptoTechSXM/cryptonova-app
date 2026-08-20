// diag_forward_hop.js — HOW MANY REAL MEMBERS CLEAR THE FORWARD HOP, AND WHO PAYS FOR IT?
//
// WHY THIS SCRIPT EXISTS (session 12, 2026-08-20):
// Sessions 11 and 12 both measured the MatB forward hop by counting
// `MemberCrossedToPartner` at MatB and both got 0. That event CANNOT fire there.
// `_cycleOutRoot` (MatrixLogicLib:834) reads:
//
//     if (!cfg.isMatrixA && self.tierRouter != address(0)) { ... handleCycleOut ... }
//
// so every MatB cycle-out goes to TierRouter, and `_crossToPartner` — the only emitter of
// MemberCrossedToPartner — is the unreachable ELSE branch. TierRouter emits
// `MemberReentered(member, tier)` instead (TierRouter:1356, ONE emit site, ONE caller).
// SUCCESS IS SILENT ON THE OLD COUNTER; ONLY FAILURE IS LOUD.
//
// ⚠ THREE TRAPS ALREADY PAID FOR — DO NOT REINTRODUCE:
//  1. `MemberParked` at MatB has SIX emit sites in MatrixLogicLib (529, 881, 908, 938,
//     979, 1939) and only TWO carry a real shortfall. Merging them made v1 report more
//     outcomes than attempts (-9). Split by shortfall, always. Handoff 11.4 says so.
//  2. "the SF emitted a log in this tx" is NOT evidence of a loan — `FundDeposit` fires on
//     every entry's stability split, so that proxy reads 100% and means nothing. v2 shipped
//     it and it duly saturated. The loan signal is `MemberDebtIncreased`, nothing else.
//  3. A DEBT SNAPSHOT IS NOT A REPAYMENT HISTORY. `memberDebtOf` today says nothing about
//     what was borrowed and cleared last week. Scan both debt events.
//
// Re-entry targets the member's OWN MatA by design (TierRouter:1575), so this is NOT the
// "why is T1.2 empty" question. Pair-1 arrivals are reported separately.
//
// Run: npx hardhat run scripts/diag_forward_hop.js --network baseSepolia
//      TIERS=1,2 npx hardhat run scripts/diag_forward_hop.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK = Number(process.env.CHUNK || 9000);

const TR = ["event MemberReentered(address indexed member, uint8 tier)",
            "event MemberUpgraded(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee)",
            "event DoubleEntryFired(address indexed member, uint8 primaryTier, uint8 secondaryTier)"];
const MX = ["event MemberEntered(address indexed member, uint256 position, uint256 id, address matrix)",
            "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)",
            "event MemberParked(address indexed member, uint256 shortfall)"];
const PM = ["function pairCount() view returns (uint256)",
            "function getPairAt(uint256) view returns (address,address)"];
const SFA = ["event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
             "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
             "event DiscountPaid(address indexed member, uint256 discount, uint256 remainingBalance)"];

/* NO SILENT EMPTY CHUNKS — the house `.catch(() => [])` turns an RPC failure into "no
 * events", which is the same class of error as a counter that cannot see success. */
const gaps = [];
async function scan(c, filter, from, to, span = CHUNK) {
  const out = [];
  for (let b = from; b <= to; b += span) {
    const end = Math.min(b + span - 1, to);
    let got = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try { got = await c.queryFilter(filter, b, end); }
      catch {
        if (attempt === 2) {
          if (span > 500) got = await scan(c, filter, b, end, Math.floor(span / 4));
          else { gaps.push([b, end]); got = []; }
        } else await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    out.push(...got);
  }
  return out;
}

async function deployFloor(head) {
  if (process.env.FROM_BLOCK) return Number(process.env.FROM_BLOCK);
  const want = Math.floor(new Date(A.deployedAt).getTime() / 1000);
  let lo = 1, hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const blk = await ethers.provider.getBlock(mid);
    if (!blk) { lo = mid + 1; continue; }
    if (blk.timestamp < want) lo = mid + 1; else hi = mid;
  }
  return Math.max(1, lo - 50);
}

const pctOf = (n, d) => d ? `${(n * 100 / d).toFixed(2)}%` : "n/a";
const usd   = (x) => `$${(Number(x) / 1e6).toFixed(4)}`;
const lc    = (a) => String(a).toLowerCase();

async function main() {
  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);
  console.log("=".repeat(96));
  console.log(`  THE FORWARD HOP ON LIVE CHAIN — ${A.network}, ${process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"}`);
  console.log(`  deployed ${A.deployedAt}   blocks ${from}..${head}  (${head - from})`);
  console.log("=".repeat(96));

  const tr    = await ethers.getContractAt(TR, A.tierRouter);
  const reent = await scan(tr, tr.filters.MemberReentered(), from, head);
  const dbl   = await scan(tr, tr.filters.DoubleEntryFired(), from, head);

  // key: txHash|member  — a re-entry and its cause are always in the same transaction
  const reentKey = new Set(reent.map(e => `${e.transactionHash}|${lc(e.args.member)}`));

  console.log(`\n  ${"tier".padEnd(6)}${"MatB hops".padStart(11)}${"SHORT".padStart(9)}${"park-0".padStart(9)}` +
              `${"RE-ENTERED".padStart(12)}${"cleared".padStart(10)}${"unexplained".padStart(13)}`);
  console.log("  " + "-".repeat(70));

  let totHops = 0, totRe = 0, totShort = 0, totZero = 0;
  const orphanHops = [];
  for (const t of TIERS) {
    const n = Number(t.slice(1));
    const pm = await ethers.getContractAt(PM, A.tiers[t].pm);
    const npairs = Number(await pm.pairCount().catch(() => 1));
    let hops = 0, pShort = 0, pZero = 0;
    for (let p = 0; p < npairs; p++) {
      const [, mb] = await pm.getPairAt(p);
      if (mb === ethers.ZeroAddress) continue;
      const MB = await ethers.getContractAt(MX, mb);
      const outs   = await scan(MB, MB.filters.MemberCycledOut(), from, head);
      const parks  = await scan(MB, MB.filters.MemberParked(),    from, head);
      const parkKey = new Set();
      for (const e of parks) {
        if (BigInt(e.args.shortfall) > 0n) pShort++; else pZero++;
        parkKey.add(`${e.transactionHash}|${lc(e.args.member)}`);
      }
      hops += outs.length;
      /* MEASURE the residual instead of guessing at it: a cycle-out whose own transaction
       * contains neither a park nor a re-entry for that member is an outcome we cannot
       * name, and it gets listed rather than absorbed. */
      for (const e of outs) {
        const k = `${e.transactionHash}|${lc(e.args.member)}`;
        if (!parkKey.has(k) && !reentKey.has(k))
          orphanHops.push({ tier: t, member: lc(e.args.member), block: e.blockNumber, tx: e.transactionHash });
      }
    }
    const re = reent.filter(e => Number(e.args.tier) === n).length;
    totHops += hops; totRe += re; totShort += pShort; totZero += pZero;
    console.log(`  ${t.padEnd(6)}${String(hops).padStart(11)}${String(pShort).padStart(9)}${String(pZero).padStart(9)}` +
                `${String(re).padStart(12)}${pctOf(re, hops).padStart(10)}` +
                `${String(orphanHops.filter(o => o.tier === t).length).padStart(13)}`);
  }
  console.log("  " + "-".repeat(70));
  console.log(`  ${"ALL".padEnd(6)}${String(totHops).padStart(11)}${String(totShort).padStart(9)}${String(totZero).padStart(9)}` +
              `${String(totRe).padStart(12)}${pctOf(totRe, totHops).padStart(10)}${String(orphanHops.length).padStart(13)}`);

  if (orphanHops.length) {
    console.log(`\n  ⚠ ${orphanHops.length} CYCLE-OUT(S) WITH NO NAMED OUTCOME (${pctOf(orphanHops.length, totHops)} of attempts).`);
    console.log(`    Neither a park nor a re-entry in their own transaction. ${dbl.length} DoubleEntryFired`);
    console.log(`    exist overall and are the leading candidate, but that is UNVERIFIED — listed so`);
    console.log(`    the next session can open one rather than assume. The cleared % is accurate to`);
    console.log(`    within this residual and no better.`);
    for (const o of orphanHops.slice(0, 8)) console.log(`      ${o.tier} blk ${o.block}  ${o.member}  ${o.tx}`);
  }

  const per = new Map();
  for (const e of reent) { const k = lc(e.args.member); per.set(k, (per.get(k) || 0) + 1); }
  const counts = [...per.values()].sort((a, b) => b - a);
  console.log(`\n  DISTINCT MEMBERS WHO HAVE CLEARED THE HOP: ${per.size}`);
  if (per.size) console.log(`  cleared it more than once: ${counts.filter(c => c > 1).length}   most by one member: ${counts[0]}`);

  /* ⛔ WHO PAID — the tight version. `MemberDebtIncreased` is the ONLY loan signal. */
  const sf   = await ethers.getContractAt(SFA, A.stabilityFund);
  const inc  = await scan(sf, sf.filters.MemberDebtIncreased(), from, head);
  const rep  = await scan(sf, sf.filters.MemberDebtRepaid(),    from, head);
  const disc = await scan(sf, sf.filters.DiscountPaid(),        from, head);
  const incKey = new Set(inc.map(e => `${e.transactionHash}|${lc(e.args.member)}`));
  const dscKey = new Set(disc.map(e => `${e.transactionHash}|${lc(e.args.member)}`));

  let loanFunded = 0, discountFunded = 0, selfFunded = 0;
  for (const e of reent) {
    const k = `${e.transactionHash}|${lc(e.args.member)}`;
    if (incKey.has(k)) loanFunded++;
    else if (dscKey.has(k)) discountFunded++;
    else selfFunded++;
  }
  console.log(`\n  ${"=".repeat(92)}`);
  console.log(`  WHO PAID FOR THE ${reent.length} CLEARANCES — on MemberDebtIncreased, not on "the SF was involved"`);
  console.log(`  ${"=".repeat(92)}`);
  console.log(`  SF LOAN taken in the same transaction ......... ${String(loanFunded).padStart(5)}  ${pctOf(loanFunded, reent.length)}`);
  console.log(`  SF discount paid in the same transaction ...... ${String(discountFunded).padStart(5)}  ${pctOf(discountFunded, reent.length)}`);
  console.log(`  NO SF credit — paid from their own earnings ... ${String(selfFunded).padStart(5)}  ${pctOf(selfFunded, reent.length)}`);

  /* ⛔ IS THE DEBT EVER REPAID? History, not a snapshot. 11.4 argues B cannot work
   * because a cycle returns less than it costs, so a lent shortfall is never recovered. */
  const lent = new Map(), paid = new Map();
  for (const e of inc) lent.set(lc(e.args.member), (lent.get(lc(e.args.member)) || 0n) + BigInt(e.args.amount));
  for (const e of rep) paid.set(lc(e.args.member), (paid.get(lc(e.args.member)) || 0n) + BigInt(e.args.amount));
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0n);
  console.log(`\n  THE LOAN BOOK OVER THE WHOLE DEPLOYMENT (every member, not just clearers):`);
  console.log(`    borrowed ${usd(sum(lent))} across ${inc.length} loans to ${lent.size} members`);
  console.log(`    repaid   ${usd(sum(paid))} across ${rep.length} repayments by ${paid.size} members`);
  const l = sum(lent), p = sum(paid);
  console.log(`    repayment ratio: ${l > 0n ? (Number(p) * 100 / Number(l)).toFixed(2) + "%" : "n/a"}`);

  const clearers = [...per.keys()];
  const cl = clearers.reduce((a, m) => a + (lent.get(m) || 0n), 0n);
  const cp = clearers.reduce((a, m) => a + (paid.get(m) || 0n), 0n);
  const borrowed = clearers.filter(m => (lent.get(m) || 0n) > 0n).length;
  console.log(`\n  RESTRICTED TO THE ${clearers.length} MEMBERS WHO HAVE CLEARED THE HOP:`);
  console.log(`    ever borrowed: ${borrowed} of ${clearers.length}`);
  console.log(`    borrowed ${usd(cl)}   repaid ${usd(cp)}   ratio ${cl > 0n ? (Number(cp) * 100 / Number(cl)).toFixed(2) + "%" : "n/a"}`);
  console.log(`    ⛔ THIS IS THE TEST OF HANDOFF 11.4's CASE AGAINST OPTION B. If these members`);
  console.log(`       borrowed and repaid, a lent shortfall IS recoverable and B must be re-priced.`);
  console.log(`       If they borrowed and did not repay, 11.4 is right and B is dead.`);
  console.log(`    ⚠ CONFOUND, STATE IT WITH THE NUMBER: much of this population is bigfill, which`);
  console.log(`       self-rescues with owner-supplied USDC. Owner-funded repayment is NOT organic`);
  console.log(`       repayment. Do not read this as proof B works until the bigfill wallets are`);
  console.log(`       separated out.`);

  for (const t of TIERS) {
    const pm = await ethers.getContractAt(PM, A.tiers[t].pm);
    if (Number(await pm.pairCount().catch(() => 1)) < 2) continue;
    const [a2] = await pm.getPairAt(1);
    if (a2 === ethers.ZeroAddress) continue;
    const M = await ethers.getContractAt(MX, a2);
    const ent = await scan(M, M.filters.MemberEntered(), from, head);
    console.log(`\n  ${t}.2 MatA entries: ${ent.length} (${new Set(ent.map(e => lc(e.args.member))).size} distinct)` +
                `  <- SEPARATE QUESTION: re-entry targets the member's OWN MatA,`);
    console.log(`     so these did NOT arrive by clearing the ${t}.1 forward hop.`);
  }

  if (gaps.length) {
    console.log(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE — TOTALS ARE LOWER BOUNDS, NOT COUNTS.`);
    for (const [a, b] of gaps.slice(0, 10)) console.log(`     ${a}..${b}`);
  } else console.log(`\n  every block range read cleanly — these are counts, not lower bounds.`);
  console.log("=".repeat(96));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
