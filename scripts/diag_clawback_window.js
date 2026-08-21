// diag_clawback_window.js — WAS IT THE CONTINUOUS CLAWBACK? (handoff 15.4 / 15.5 item 1)
//
// WHERE THIS SITS. Three runs have narrowed one question to one fork:
//   14.1  held to the same parked starting state, loan-rescued organic members clear the
//         forward hop at 8.0% and self-rescued members at 19.6%. Balanced at baseline, so
//         that ~2.4x is not selection alone.
//   15.1  the sweep at MatB cycle-out was tested with an exact same-transaction counterfactual
//         and caused 5 of 295 organic parks. REFUTED. Not the concentrated mechanism.
//   15.2  a member carrying debt into the hop clears it at 2.4% against 31.8% with none —
//         confounded, but the balanced 8.0/19.6 says something real survives.
//
// SO EITHER:
//   (a) CONTINUOUS COLLECTION — `clawbackBpsFor` redirects a band of EVERY pool credit to the
//       fund for the whole journey (T1-T3 band is 60% in source; this script reads the LIVE
//       value and prints it). The borrower is drained gradually instead of at once, and arrives
//       at the hop short. If so, THE PROTOCOL'S OWN REPAYMENT SCHEDULE is what stops borrowers
//       graduating — and `setClawbackBands` is owner/DAO-tunable with NO new storage, NO new
//       gas at the block ceiling, and no redeploy.
//   (b) SELECTION — borrowers were poorer and would not have graduated regardless. No lever.
//
// THIS SCRIPT DECIDES IT, with the same exact counterfactual that killed 15.1, over the RIGHT
// WINDOW. 15.1's instrument looked at the hop's own transaction and found the median collection
// there is only $3.40 — small BECAUSE the member has already been skimmed all cycle. So the
// window here is THE WHOLE CYCLE: from the member's previous forward hop (or their first entry)
// up to and including this one. Then:
//
//     collected during the cycle >= shortfall at the hop   =>   THE COLLECTION IS WHY
//
// ⛔⛔ AND THE HONEST PART, WHICH DECIDES WHETHER THE ANSWER IS USABLE:
// NOT EVERY DOLLAR COLLECTED WOULD HAVE BEEN SITTING THERE AT THE HOP. Money taken during a
// WITHDRAWAL was money the member was removing from the system anyway; handing it back does not
// mean it would have been in the balance the hop tests. Money taken by the CLAWBACK never
// reached the member at all — it was deducted from a pool credit in place, and without the
// deduction it would still be there. Those are different claims and this script does NOT merge
// them. The four `RescueDebtRepaid` emit sites cannot be told apart from logs, so each
// collection is classified BY WHAT ELSE HAPPENED IN ITS TRANSACTION:
//
//   WITHDRAWAL  the tx also holds EarningsWithdrawn for this member      -> MatrixLogicLib:1393
//   HOP         the tx also holds MemberCycledOut at a MatB              -> :853 and/or :638
//   CROSSING    the tx also holds CoPayRescue / SelfRescue / CrossedTo   -> :1015
//   CLAWBACK    none of the above — a pool settlement during someone
//               else's entry, deducted before the credit ever landed     -> :638
//
//   STRICT counterfactual = CLAWBACK + HOP        (money removed from a balance sitting in place)
//   LOOSE  counterfactual = all four              (an upper bound, prints beside it)
//
// ⛔⛔ v2 — v1's WINDOW WAS WRONG AND TWO INSTRUMENTS DISAGREEING IS WHAT CAUGHT IT.
// v1 ran the window from the member's previous forward hop, block-INCLUSIVE, over collections
// from EVERY matrix. diag_debt_sweep.js measured $336.36 collected at organic hops; v1's HOP
// class read $535.76 over the same population. The $199.40 gap was each cycle being charged the
// PREVIOUS cycle's sweep, plus money taken in other tiers' matrices that never touched the
// balance this hop is judged against. v1's "36 of 123 decisive" was inflated by that and MUST
// NOT BE QUOTED.
// v2's window is ONE OCCUPANCY: from the member's most recent MemberEntered AT THE CYCLING
// MATRIX, to the hop, counting only collections EMITTED BY THAT MATRIX — because the hop tests
// `self.members[root].withdrawable` in that matrix and nothing else can have spent it. A
// boundary audit prints in every panel and goes ⛔ if HOP-class money ever appears from a
// second transaction, which within one occupancy is impossible.
//
// **REPORT THE STRICT NUMBER. The loose one is printed only so the gap between them is visible
// rather than hidden inside a single figure.**
//
// ⚠ TRAPS CARRIED FORWARD: MemberParked has six emit sites, only two carry a real shortfall.
// Forward-hop success is MemberReentered on the TierRouter, never MemberCrossedToPartner.
// A control cohort is not optional — but see 15.3: BIGFILL's own no-debt baseline is 1.4%, ON
// THE FLOOR, so it CANNOT show a penalty below itself. It is printed and it is not evidence.
//
// Read-only. Nothing is written to chain.
//
// Run: npx hardhat run scripts/diag_clawback_window.js --network baseSepolia
// Env: TIERS=1,2,3  CHUNK=4000  COHORT_MAX=1200  ADDRESSES_FILE=...
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS      = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK      = Number(process.env.CHUNK || 4000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 1200);

const lc  = (a) => String(a).toLowerCase();
const usd = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
const pct = (n, d) => d ? `${(n * 100 / d).toFixed(1)}%` : "  n/a";
const pad = (s, n) => String(s).padStart(n);

const MATRIX_ABI = [
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)",
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining)",
  "event MemberEntered(address indexed member, uint256 position, uint256 id, address matrix)",
  "event EarningsWithdrawn(address indexed member, uint256 amount)",
  "event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix)",
  "event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed)",
  "event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)",
];
const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];
const TR_ABI = ["event MemberReentered(address indexed member, uint8 tier)"];
const PM_ABI = ["function pairCount() view returns (uint256)",
                "function getPairAt(uint256) view returns (address,address)"];
const MAT_VIEW = ["function ENTRY_FEE() view returns (uint256)", "function isMatrixA() view returns (bool)"];
const SF_VIEW  = ["function clawbackBpsByBand(uint256) view returns (uint256)",
                  "function insolvencyFloorBps() view returns (uint256)"];

const gaps = [];
async function scanLogs(addresses, topic0s, from, to, span) {
  const out = [];
  for (let b = from; b <= to; b += span) {
    const end = Math.min(b + span - 1, to);
    let got = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try { got = await ethers.provider.getLogs({ address: addresses, topics: [topic0s], fromBlock: b, toBlock: end }); }
      catch {
        if (attempt === 2) {
          if (span > 250) got = await scanLogs(addresses, topic0s, b, end, Math.floor(span / 4));
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

const bigfillIndexOf = new Map(), leaderSet = new Set();
function buildBigfill() {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) { console.error("\n  ⛔ FILL_MNEMONIC is not set. STOPPING — bigfill would land in ORGANIC."); process.exit(1); }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillIndexOf.set(lc(acct.deriveChild(i).address), i);
}
function buildLeaders() {
  const p = path.join(__dirname, "..", "run_bigfill_rr.ps1");
  const block = fs.readFileSync(p, "utf8").split(/\$leaders\s*=\s*@\(/)[1];
  if (!block) { console.error("\n  ⛔ no $leaders block in run_bigfill_rr.ps1. STOPPING."); process.exit(1); }
  for (const m of block.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
  if (leaderSet.size < 10) { console.error(`\n  ⛔ only ${leaderSet.size} leaders parsed. STOPPING.`); process.exit(1); }
}
const cohortOf = (a) => bigfillIndexOf.has(lc(a)) ? "bigfill" : (leaderSet.has(lc(a)) ? "leader" : "organic");

function quantiles(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: s.length, min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

async function main() {
  buildBigfill(); buildLeaders();
  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);

  console.log("=".repeat(104));
  console.log(`  THE CONTINUOUS CLAWBACK, OVER A WHOLE CYCLE — ${A.network}`);
  console.log(`  deployed ${A.deployedAt}   blocks ${from}..${head}  (${head - from})   MATRIX_SIZE ${A.matrixSize}`);
  console.log("=".repeat(104));

  const sfv = await ethers.getContractAt(SF_VIEW, A.stabilityFund);
  const bands = [];
  for (let i = 0; i < 4; i++) bands.push(Number(await sfv.clawbackBpsByBand(i).catch(() => -1)));
  const floorBps = Number(await sfv.insolvencyFloorBps().catch(() => -1));
  console.log(`\n  THE LEVER, READ OFF CHAIN — StabilityFund.clawbackBpsByBand`);
  console.log(`    band0 (T8-T10) ${bands[0]}   band1 (T6-T7) ${bands[1]}   band2 (T4-T5) ${bands[2]}   band3 (T1-T3) ${bands[3]}`);
  console.log(`    ⛔ T1-T3 members repaying a loan give up ${(bands[3] / 100).toFixed(0)}% OF EVERY POOL CREDIT until the debt clears.`);
  console.log(`    Tunable by setClawbackBands (owner/DAO) — no redeploy, no new storage, no new gas.`);
  console.log(`    insolvencyFloorBps ${floorBps}`);

  const mats = new Map(), matBs = new Set();
  for (const t of TIERS) {
    const pm = await ethers.getContractAt(PM_ABI, A.tiers[t].pm);
    const npairs = Number(await pm.pairCount().catch(() => 1));
    for (let p = 0; p < npairs; p++) {
      const [ma, mb] = await pm.getPairAt(p);
      for (const addr of [ma, mb]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const c = await ethers.getContractAt(MAT_VIEW, addr);
        const isA = await c.isMatrixA();
        mats.set(lc(addr), { addr, tier: t, pair: p, isA, fee: BigInt(await c.ENTRY_FEE()), label: `${t}p${p}${isA ? "A" : "B"}` });
        if (!isA) matBs.add(lc(addr));
      }
    }
  }

  const mIface = new ethers.Interface(MATRIX_ABI);
  const sfIface = new ethers.Interface(SF_ABI);
  const trIface = new ethers.Interface(TR_ABI);
  const top = (iface, abi) => abi.map(s => iface.getEvent(s.match(/event (\w+)/)[1]).topicHash);

  console.log(`\n  scanning ${head - from} blocks in ${CHUNK}-block chunks …`);
  const rawM = await scanLogs([...mats.values()].map(m => m.addr), top(mIface, MATRIX_ABI), from, head, CHUNK);
  const rawS = await scanLogs([A.stabilityFund], top(sfIface, SF_ABI), from, head, CHUNK);
  const rawT = await scanLogs([A.tierRouter], top(trIface, TR_ABI), from, head, CHUNK);
  console.log(`  matrix logs ${rawM.length}   SF logs ${rawS.length}   router logs ${rawT.length}` +
              (gaps.length ? `   ⛔ ${gaps.length} UNREADABLE RANGES — LOWER BOUNDS ONLY` : `   ✅ no unreadable ranges`));

  const dec = (iface, l) => { const p = iface.parseLog(l); return { name: p.name, args: p.args, b: l.blockNumber,
                              li: l.index ?? l.logIndex, tx: l.transactionHash, at: lc(l.address) }; };
  const evM = rawM.map(l => dec(mIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);
  const evS = rawS.map(l => dec(sfIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);
  const evT = rawT.map(l => dec(trIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);

  /* per-(tx,member) context flags, so each collection can be classified by what else happened */
  const ctx = new Map();
  const flag = (k, f) => { const c = ctx.get(k) || {}; c[f] = true; ctx.set(k, c); };
  for (const e of evM) {
    const k = `${e.tx}|${lc(e.args.member)}`;
    if (e.name === "EarningsWithdrawn") flag(k, "wd");
    else if (e.name === "MemberCycledOut" && matBs.has(e.at)) flag(k, "hop");
    else if (e.name === "CoPayRescue" || e.name === "SelfRescue" || e.name === "MemberCrossedToPartner") flag(k, "cross");
  }

  /* collections, per member, classified, ascending. `at` is the EMITTING MATRIX and it is
   * load-bearing — see the window rule below. */
  const CLASSES = ["CLAWBACK", "HOP", "CROSSING", "WITHDRAWAL"];
  const collByMember = new Map();
  for (const e of evM) {
    if (e.name !== "RescueDebtRepaid") continue;
    const m = lc(e.args.member), c = ctx.get(`${e.tx}|${m}`) || {};
    const cls = c.wd ? "WITHDRAWAL" : c.hop ? "HOP" : c.cross ? "CROSSING" : "CLAWBACK";
    if (!collByMember.has(m)) collByMember.set(m, []);
    collByMember.get(m).push({ b: e.b, tx: e.tx, at: e.at, amt: BigInt(e.args.repaid), cls });
  }

  /* ⛔ THE WINDOW — v1's DEFECT AND WHY IT IS NOW DEFINED THIS WAY.
   * v1 ran the window from the member's PREVIOUS forward hop, block-inclusive, across every
   * matrix. It was wrong twice over and two instruments disagreeing is what caught it:
   * diag_debt_sweep.js measured $336.36 collected at organic hops, v1's HOP class read $535.76
   * over the same population. The $199.40 gap was each cycle being charged the PREVIOUS
   * cycle's sweep, plus collections from OTHER TIERS' matrices that never touched the balance
   * this hop is judged against.
   *
   * The hop tests `self.members[root].withdrawable` IN THE CYCLING MatB. So the only money
   * that can have cost a member this hop is money taken OUT OF THAT MATRIX'S LEDGER during
   * THIS occupancy of it. The window is therefore: from the member's most recent MemberEntered
   * AT THAT MATRIX, to the hop, counting only collections EMITTED BY THAT MATRIX. Entry to
   * exit, one occupancy, one ledger — no boundary to leak across and no cross-tier money.
   *
   * A member whose entry predates the scan window has no MemberEntered to anchor to. Those
   * hops are EXCLUDED and COUNTED, never silently given a truncated window. */
  const entryAt = new Map();               // `${member}|${matrix}` -> [block,...] ascending
  for (const e of evM) if (e.name === "MemberEntered") {
    const k = `${lc(e.args.member)}|${e.at}`;
    if (!entryAt.has(k)) entryAt.set(k, []);
    entryAt.get(k).push(e.b);
  }
  for (const v of entryAt.values()) v.sort((a, b) => a - b);
  const reentKey = new Set(evT.filter(e => e.name === "MemberReentered").map(e => `${e.tx}|${lc(e.args.member)}`));
  const parkByKey = new Map();
  for (const e of evM) if (e.name === "MemberParked" && matBs.has(e.at))
    parkByKey.set(`${e.tx}|${lc(e.args.member)}`, BigInt(e.args.shortfall));

  const debtEv = new Map();
  for (const e of evS) {
    const m = lc(e.args.member);
    if (!debtEv.has(m)) debtEv.set(m, []);
    debtEv.get(m).push({ b: e.b, tx: e.tx, d: e.name === "MemberDebtIncreased" ? BigInt(e.args.amount) : -BigInt(e.args.amount) });
  }
  const debtBeforeTx = (m, blk, tx) =>
    (debtEv.get(m) || []).reduce((s, x) => (x.b < blk || (x.b === blk && x.tx !== tx)) ? s + x.d : s, 0n);

  /* hops per member, ascending — the window for hop i starts at hop i-1 (or first entry) */
  const hopsByMember = new Map();
  for (const e of evM) {
    if (e.name !== "MemberCycledOut" || !matBs.has(e.at)) continue;
    const m = lc(e.args.member);
    if (!hopsByMember.has(m)) hopsByMember.set(m, []);
    hopsByMember.get(m).push(e);
  }

  const hops = [];
  let noAnchor = 0;
  for (const [m, list] of hopsByMember) {
    list.sort((a, b) => a.b - b.b || a.li - b.li);
    for (let i = 0; i < list.length; i++) {
      const e = list[i], key = `${e.tx}|${m}`;
      // most recent entry AT THIS MATRIX strictly before the hop — the occupancy that built
      // the balance the hop is about to test.
      const entries = entryAt.get(`${m}|${e.at}`) || [];
      let winFrom = -1;
      for (const b of entries) if (b <= e.b) winFrom = b;
      if (winFrom < 0) { noAnchor++; continue; }
      const sf = parkByKey.has(key) ? parkByKey.get(key) : null;
      const inWin = (collByMember.get(m) || []).filter(c => c.at === e.at && c.b >= winFrom && c.b <= e.b);
      const sum = (f) => inWin.filter(f).reduce((s, c) => s + c.amt, 0n);
      const hopSameTx = inWin.filter(c => c.cls === "HOP" && c.tx === e.tx).reduce((s, c) => s + c.amt, 0n);
      const hopOtherTx = sum(c => c.cls === "HOP") - hopSameTx;
      hops.push({
        member: m, cohort: cohortOf(m), label: mats.get(e.at).label, b: e.b, tx: e.tx,
        cycleIndex: i, winFrom, winBlocks: e.b - winFrom,
        outcome: reentKey.has(key) ? "REENTERED" : sf === null ? "UNEXPLAINED" : sf > 0n ? "PARKED-SHORT" : "PARKED-ZERO",
        shortfall: sf === null ? 0n : sf,
        debtBefore: debtBeforeTx(m, e.b, e.tx),
        strict: sum(c => c.cls === "CLAWBACK" || c.cls === "HOP"),
        loose:  sum(() => true),
        byClass: Object.fromEntries(CLASSES.map(k => [k, sum(c => c.cls === k)])),
        hopSameTx, hopOtherTx,
      });
    }
  }
  console.log(`\n  hops excluded — entry predates the scan window, no anchor for the occupancy: ${noAnchor}`);

  const panel = (cohort) => {
    const H = hops.filter(h => h.cohort === cohort);
    console.log(`\n  ${"=".repeat(100)}`);
    console.log(`  COHORT: ${cohort.toUpperCase()}   ${H.length} forward-hop attempts`);
    if (cohort === "bigfill")
      console.log(`  ⚠ 15.3: this control's own no-debt baseline sits ON THE FLOOR, so it cannot show a`);
    if (cohort === "bigfill")
      console.log(`    penalty below itself. Printed for completeness. IT IS NOT EVIDENCE EITHER WAY.`);
    console.log(`  ${"=".repeat(100)}`);
    if (!H.length) { console.log("  (none)"); return; }

    /* 1. where the money actually goes */
    console.log(`\n  1. EVERY DOLLAR COLLECTED, BY WHAT ELSE WAS IN ITS TRANSACTION`);
    console.log(`     (the four emit sites cannot be told apart from logs — this is the discriminator)`);
    console.log(`\n  ${"class".padEnd(14)}${pad("total", 12)}${pad("share", 9)}   what it means for the hop`);
    console.log("  " + "-".repeat(92));
    const tot = {}; let grand = 0n;
    for (const k of CLASSES) { tot[k] = H.reduce((s, h) => s + h.byClass[k], 0n); grand += tot[k]; }
    const meaning = {
      CLAWBACK:   "deducted from a pool credit IN PLACE — would still be there",
      HOP:        "taken in the cycle-out tx itself — would still be there",
      CROSSING:   "taken during a rescue/crossing — ambiguous",
      WITHDRAWAL: "member was removing it from the system anyway — NOT recoverable",
    };
    for (const k of CLASSES)
      console.log(`  ${k.padEnd(14)}${pad(usd(tot[k]), 12)}${pad(pct(Number(tot[k]), Number(grand)), 9)}   ${meaning[k]}`);
    console.log(`  ${"TOTAL".padEnd(14)}${pad(usd(grand), 12)}`);

    /* ⛔ THE BOUNDARY AUDIT — this is the check that catches v1's defect if it ever returns.
     * A member occupies a MatB once per cycle and cycles out of it once, so within one
     * occupancy there can be exactly ONE hop transaction. Any HOP-class money from a
     * DIFFERENT transaction means the window has leaked into an adjacent cycle. */
    const sameTx = H.reduce((s, h) => s + h.hopSameTx, 0n);
    const otherTx = H.reduce((s, h) => s + h.hopOtherTx, 0n);
    console.log(`\n  boundary audit — HOP money in the hop's OWN tx ${usd(sameTx)}   from any OTHER tx ${usd(otherTx)}   ` +
                (otherTx === 0n ? "✅ window is one occupancy" : "⛔ THE WINDOW HAS LEAKED — DO NOT READ SECTION 3"));
    console.log(`  cross-check: that first figure is the same quantity diag_debt_sweep.js reports as`);
    console.log(`  "total collected at the hop". If the two runs disagree, one of them is wrong.`);

    /* 2. clearance by debt, restated for context */
    const withDebt = H.filter(h => h.debtBefore > 0n), noDebt = H.filter(h => h.debtBefore <= 0n);
    const clr = (g) => pct(g.filter(h => h.outcome === "REENTERED").length, g.length);
    console.log(`\n  2. CLEARANCE — no debt ${clr(noDebt)} (n=${noDebt.length})   owed something ${clr(withDebt)} (n=${withDebt.length})`);
    console.log(`     ⚠ CONFOUNDED (15.2). The balanced version is 14.1's 8.0% vs 19.6%. Quote that one.`);

    /* 3. THE ANSWER */
    const ps = H.filter(h => h.outcome === "PARKED-SHORT" && h.debtBefore > 0n);
    const decStrict = ps.filter(h => h.strict >= h.shortfall);
    const decLoose  = ps.filter(h => h.loose  >= h.shortfall);
    const anyColl   = ps.filter(h => h.loose > 0n);
    console.log(`\n  3. ⛔ THE ANSWER — over the WHOLE CYCLE, would the collection have covered the shortfall?`);
    console.log(`\n  ${"parked short WHILE OWING THE FUND".padEnd(52)}${pad(ps.length, 6)}`);
    console.log(`  ${"  ...with any collection during the cycle".padEnd(52)}${pad(anyColl.length, 6)}  ${pct(anyColl.length, ps.length)}`);
    console.log(`  ${"  ⛔ STRICT — clawback+hop money alone >= shortfall".padEnd(52)}${pad(decStrict.length, 6)}  ${pct(decStrict.length, ps.length)}`);
    console.log(`  ${"     LOOSE  — every collection >= shortfall (upper bd)".padEnd(52)}${pad(decLoose.length, 6)}  ${pct(decLoose.length, ps.length)}`);
    const qs = quantiles(ps.map(h => Number(h.strict) / 1e6));
    const qf = quantiles(ps.map(h => Number(h.shortfall) / 1e6));
    if (qs) {
      console.log(`\n  ${"collected in-cycle (strict)".padEnd(30)}min ${usd(qs.min * 1e6)}  p25 ${usd(qs.p25 * 1e6)}  med ${usd(qs.med * 1e6)}  p75 ${usd(qs.p75 * 1e6)}  max ${usd(qs.max * 1e6)}`);
      console.log(`  ${"shortfall at the hop".padEnd(30)}min ${usd(qf.min * 1e6)}  p25 ${usd(qf.p25 * 1e6)}  med ${usd(qf.med * 1e6)}  p75 ${usd(qf.p75 * 1e6)}  max ${usd(qf.max * 1e6)}`);
      console.log(`\n  aggregate — collected (strict) ${usd(ps.reduce((s, h) => s + h.strict, 0n))}` +
                  `   total shortfall ${usd(ps.reduce((s, h) => s + h.shortfall, 0n))}` +
                  `   coverage ${pct(Number(ps.reduce((s, h) => s + h.strict, 0n)), Number(ps.reduce((s, h) => s + h.shortfall, 0n)))}`);
    }
    if (decStrict.length >= 20 && cohort === "bigfill") {
      console.log(`\n  ⚠ ${decStrict.length} of ${ps.length} decisive — but this is the CONTROL, and 15.3 already said it`);
      console.log(`    cannot carry a verdict. What it shows is that the mechanism CAN be decisive when the`);
      console.log(`    shortfall is small (median ${usd(qf.med * 1e6)} here). It says nothing about members.`);
    } else if (decStrict.length >= 20) {
      console.log(`\n  ⛔⛔ (a) IS ESTABLISHED FOR THIS COHORT. The protocol's own repayment schedule, not the`);
      console.log(`      member's poverty, is what held ${decStrict.length} of ${ps.length} borrowers back at the hop.`);
      console.log(`      setClawbackBands is the lever and it needs no redeploy. THE ORDERING IS THE OWNER'S CALL.`);
    } else if (ps.length >= 20) {
      console.log(`\n  ✅ (a) IS NOT ESTABLISHED — only ${decStrict.length} of ${ps.length}. The clawback is not what stops`);
      console.log(`     them either. That points at (b) SELECTION, and it means there is NO free lever here:`);
      console.log(`     lending would be a palliative, and the referral route (13.11) is the only exit measured.`);
    } else {
      console.log(`\n  ⚠ ONLY ${ps.length} EPISODES QUALIFY. That is not a measurement. Report the count, not the rate.`);
    }
    if (decStrict.length) {
      console.log(`\n  first 10 decisive (strict) — open one before quoting the rest:`);
      for (const h of decStrict.slice(0, 10))
        console.log(`    ${h.label} cyc${h.cycleIndex} blk ${h.b}  strict ${usd(h.strict).padStart(7)}  short ${usd(h.shortfall).padStart(7)}  ${h.tx}`);
    }
  };

  panel("organic");
  panel("bigfill");

  console.log(`\n  ${"=".repeat(100)}`);
  console.log(`  WHAT THIS INSTRUMENT CANNOT SEE`);
  console.log(`  ${"=".repeat(100)}`);
  console.log(`  · ⛔ THE MONEY IS NOT FREE. "Would have cleared without the collection" is NOT "should`);
  console.log(`    not have been collected" — the debt would still be outstanding and would travel into`);
  console.log(`    the next cycle. This is an ORDERING policy: collect now, or let them graduate and`);
  console.log(`    collect later. Choosing it is the owner's, not this script's.`);
  console.log(`  · The WITHDRAWAL class is excluded from STRICT on purpose. A member who withdrew was`);
  console.log(`    taking money out; returning it does not put it in the balance the hop tests.`);
  console.log(`  · The CROSSING class is excluded from STRICT because it is genuinely ambiguous. The`);
  console.log(`    gap between STRICT and LOOSE is that ambiguity, printed rather than buried.`);
  console.log(`  · ⛔ "DECISIVE" IS A HIGH BAR AND IT IS NOT THE ONLY READING. It asks whether the`);
  console.log(`    collection ALONE explains the failure. The aggregate coverage line answers a`);
  console.log(`    different question — how much of the missing money it accounts for — and the two`);
  console.log(`    can diverge sharply. Removing a collection that is 70% of a member's shortfall`);
  console.log(`    removes most of the gap and still does not get them over the line. Quote both.`);
  console.log(`  · Hops whose entry predates the scan window are EXCLUDED and counted at the top, not`);
  console.log(`    given a truncated window (v1 did the latter — see the header).`);
  console.log(`  · V8.48 ONLY. The crossing buffer manufactured debt on this build (13.11). With it at`);
  console.log(`    zero in V8.50 there is less debt, less clawback, and this whole table shrinks.`);
  if (gaps.length) console.log(`  · ⛔ ${gaps.length} BLOCK RANGES UNREADABLE — every count is a LOWER BOUND.`);
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
