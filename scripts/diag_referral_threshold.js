// diag_referral_threshold.js — THE NUMBER. How many directs before a loan is always repaid?
//
// OWNER'S RULES, 2026-08-20, and this script exists to put a number on 2 and 3:
//   1. members need loans, but not at the expense of the ecosystem
//   2. find the number that makes it sane — 100% of members given a loan can pay it back
//   3. if the loan cannot be covered by earnings at the end of a cycle, it is not given
//   4. invite 2-3 recruits (or sponsor them by coupon) and you become self-sustaining
//   5. possibly enforce pay-it-forward in code for coupon-sponsored members
//
// ⛔ TWO CONTRACT FACTS THAT CONSTRAIN ANY ANSWER — verified in the source, not assumed:
//
//   (a) THERE IS NO DIRECT-REFERRAL COUNT ON CHAIN. TierRouter stores only
//       `memberReferrer[member]` (TierRouter:216) — a pointer UP to your sponsor. Nothing
//       counts your downline. A gate of the form "only lend at N+ directs" is therefore NOT
//       IMPLEMENTABLE TODAY. It needs a counter incremented where memberReferrer is already
//       written (TierRouter:762 and the coupon path at :813) — one line, new mapping, no
//       change to any existing struct.
//
//   (b) `coPayRescue` SEES ALMOST NOTHING. At the moment it lends it reads exactly
//       `withdrawable` and `crossingReserve` for THIS matrix (MatrixLogicLib ~1627-1640).
//       No earnings history, no downline, no rate. So rule 3 as written — "if earnings
//       cannot cover it" — cannot be evaluated in that function as it stands either.
//
// WHICH MAKES THIS SCRIPT'S JOB EXACT: find whether directs PREDICT repayment, and at what
// count the prediction becomes certainty. If a threshold exists, (a) is a one-line change
// and the rule ships. If no threshold exists, directs are the wrong gate and we need a
// different variable — better to learn that here than after writing the counter.
//
// ⚠ SELECTION, AND WHY IT DOES NOT SINK THIS ONE. Members with more directs are more
// engaged, so directs may predict repayment without causing it. For a GATE that is fine:
// a filter only has to predict. Causation would matter if we were claiming "recruiting
// makes you solvent" — that claim is NOT made here and the data cannot support it.
//
// Run: npx hardhat run scripts/diag_referral_threshold.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK = Number(process.env.CHUNK || 9000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 2400);

const lc = (a) => String(a).toLowerCase();
const usd = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
const pct = (n, d) => d ? `${(n * 100 / d).toFixed(1)}%` : "n/a";
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

const bigfillSet = new Set(), leaderSet = new Set();
function buildSets() {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) { console.error("\n  ⛔ FILL_MNEMONIC not set — bigfill would count as organic. STOPPING."); process.exit(1); }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillSet.add(lc(acct.deriveChild(i).address));
  const ps1 = fs.readFileSync(path.join(__dirname, "..", "run_bigfill_rr.ps1"), "utf8");
  const blk = ps1.split(/\$leaders\s*=\s*@\(/)[1];
  if (!blk) { console.error("\n  ⛔ could not parse the leader roster. STOPPING."); process.exit(1); }
  for (const m of blk.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
}
const cohortOf = (a) => bigfillSet.has(lc(a)) ? "bigfill" : leaderSet.has(lc(a)) ? "leader" : "organic";

async function main() {
  buildSets();
  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);
  console.log("=".repeat(100));
  console.log(`  THE REFERRAL THRESHOLD — at how many directs does a loan always come back?`);
  console.log(`  ${A.network}, blocks ${from}..${head}`);
  console.log("=".repeat(100));

  /* registrations -> who sponsored whom, with block so we can ask "directs AT LOAN TIME" */
  const tr = await ethers.getContractAt(
    ["event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)",
     "event MemberReentered(address indexed member, uint8 tier)"], A.tierRouter);
  const regs = await scan(tr, tr.filters.MemberRegistered(), from, head);
  const directBlocks = new Map();          // sponsor -> [block,...] ascending
  const isMember = new Set();
  for (const e of regs) {
    isMember.add(lc(e.args.member));
    const r = lc(e.args.referrer);
    if (r === ethers.ZeroAddress) continue;
    if (!directBlocks.has(r)) directBlocks.set(r, []);
    directBlocks.get(r).push(e.blockNumber);
  }
  for (const v of directBlocks.values()) v.sort((a, b) => a - b);
  const directsAt = (m, blk) => (directBlocks.get(m) || []).filter(b => b <= blk).length;
  const directsNow = (m) => (directBlocks.get(m) || []).length;

  const cycles = new Map();
  for (const e of await scan(tr, tr.filters.MemberReentered(), from, head))
    cycles.set(lc(e.args.member), (cycles.get(lc(e.args.member)) || 0) + 1);

  /* debt timeline */
  const sf = await ethers.getContractAt(
    ["event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
     "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)"], A.stabilityFund);
  const inc = await scan(sf, sf.filters.MemberDebtIncreased(), from, head);
  const rep = await scan(sf, sf.filters.MemberDebtRepaid(),    from, head);
  const borrowed = new Map(), repaid = new Map(), lastTotal = new Map(), loansOf = new Map();
  for (const e of inc) {
    const m = lc(e.args.member);
    borrowed.set(m, (borrowed.get(m) || 0n) + BigInt(e.args.amount));
    if (!loansOf.has(m)) loansOf.set(m, []);
    loansOf.get(m).push({ b: e.blockNumber, amt: BigInt(e.args.amount) });
  }
  for (const e of rep) {
    const m = lc(e.args.member);
    repaid.set(m, (repaid.get(m) || 0n) + BigInt(e.args.amount));
  }
  // final outstanding = newTotal of each member's LAST debt event
  const evAll = [...inc.map(e => ({ m: lc(e.args.member), b: e.blockNumber, i: e.index ?? 0, t: BigInt(e.args.newTotal) })),
                 ...rep.map(e => ({ m: lc(e.args.member), b: e.blockNumber, i: e.index ?? 0, t: BigInt(e.args.newTotal) }))]
                .sort((x, y) => x.b - y.b || x.i - y.i);
  for (const e of evAll) lastTotal.set(e.m, e.t);

  const organic = [...isMember].filter(m => cohortOf(m) === "organic");

  /* ── TABLE 1: LIFETIME DIRECTS vs OUTCOME ─────────────────────────────── */
  const BUCKETS = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 9], [10, 1e9]];
  const label = ([a, b]) => a === b ? `${a}` : (b > 1e8 ? `${a}+` : `${a}-${b}`);
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  1. EVERY ORGANIC MEMBER, BUCKETED BY HOW MANY PEOPLE THEY BROUGHT IN`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  ${"directs".padEnd(9)}${"members".padStart(9)}${"borrowers".padStart(11)}${"borrowed".padStart(11)}` +
              `${"repaid".padStart(11)}${"still owed".padStart(12)}${"CLEAN".padStart(9)}${"cyc/head".padStart(10)}${"2+ cycles".padStart(11)}`);
  console.log("  " + "-".repeat(93));
  const rows = [];
  for (const bk of BUCKETS) {
    const list = organic.filter(m => { const d = directsNow(m); return d >= bk[0] && d <= bk[1]; });
    if (!list.length) continue;
    const bs = list.filter(m => (borrowed.get(m) || 0n) > 0n);
    const bor = bs.reduce((a, m) => a + borrowed.get(m), 0n);
    const rpd = bs.reduce((a, m) => a + (repaid.get(m) || 0n), 0n);
    const owed = bs.reduce((a, m) => a + (lastTotal.get(m) || 0n), 0n);
    const clean = bs.filter(m => (lastTotal.get(m) || 0n) === 0n).length;
    const cyc = list.reduce((a, m) => a + (cycles.get(m) || 0), 0);
    const two = list.filter(m => (cycles.get(m) || 0) >= 2).length;
    rows.push({ bk, n: list.length, nb: bs.length, clean });
    console.log(`  ${label(bk).padEnd(9)}${String(list.length).padStart(9)}${String(bs.length).padStart(11)}` +
                `${usd(bor).padStart(11)}${usd(rpd).padStart(11)}${usd(owed).padStart(12)}` +
                `${pct(clean, bs.length).padStart(9)}${(cyc / list.length).toFixed(2).padStart(10)}${pct(two, list.length).padStart(11)}`);
  }
  console.log(`\n  CLEAN = of the members in that bucket who borrowed, the share who now owe ZERO.`);
  console.log(`  ⛔ RULE 2 ASKS FOR THE FIRST BUCKET WHERE CLEAN IS 100%. Read it off this column.`);
  console.log(`  ⚠ and read the "borrowers" count next to it — 100% of two people is not a policy.`);

  /* ── TABLE 2: DIRECTS AT THE MOMENT OF THE LOAN — the enforceable version ── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  2. THE ENFORCEABLE GATE — directs the member ALREADY HAD when the loan was made`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  Table 1 uses lifetime directs, which includes people recruited AFTER the loan. A gate`);
  console.log(`  cannot see the future, so this table re-asks the question using only what was true at`);
  console.log(`  the moment of lending. THIS is the number a contract could enforce.`);
  const loanRows = new Map();
  for (const m of organic) {
    for (const L of (loansOf.get(m) || [])) {
      const d = directsAt(m, L.b);
      const key = d >= 5 ? 5 : d;
      if (!loanRows.has(key)) loanRows.set(key, { loans: 0, amt: 0n, membersClean: new Set(), membersDirty: new Set() });
      const r = loanRows.get(key);
      r.loans++; r.amt += L.amt;
      ((lastTotal.get(m) || 0n) === 0n ? r.membersClean : r.membersDirty).add(m);
    }
  }
  console.log(`\n  ${"directs@loan".padEnd(14)}${"loans".padStart(8)}${"lent".padStart(11)}${"members".padStart(10)}` +
              `${"fully repaid".padStart(14)}${"still owing".padStart(13)}`);
  console.log("  " + "-".repeat(70));
  for (const k of [...loanRows.keys()].sort((a, b) => a - b)) {
    const r = loanRows.get(k);
    const tot = r.membersClean.size + r.membersDirty.size;
    console.log(`  ${(k >= 5 ? "5+" : String(k)).padEnd(14)}${String(r.loans).padStart(8)}${usd(r.amt).padStart(11)}` +
                `${String(tot).padStart(10)}${pct(r.membersClean.size, tot).padStart(14)}${String(r.membersDirty.size).padStart(13)}`);
  }

  /* ── TABLE 3: WHAT RULE 3 WOULD HAVE COST ─────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  3. WHAT RULE 3 WOULD HAVE DONE — refusing every loan below the threshold`);
  console.log(`  ${"=".repeat(96)}`);
  for (const N of [1, 2, 3]) {
    let refused = 0, refusedAmt = 0n, allowed = 0, allowedAmt = 0n, badAllowed = 0;
    for (const m of organic) for (const L of (loansOf.get(m) || [])) {
      if (directsAt(m, L.b) < N) { refused++; refusedAmt += L.amt; }
      else { allowed++; allowedAmt += L.amt; if ((lastTotal.get(m) || 0n) > 0n) badAllowed++; }
    }
    console.log(`  gate at ${N}+ directs: refuse ${String(refused).padStart(3)} loans (${usd(refusedAmt)}), allow ${String(allowed).padStart(3)} (${usd(allowedAmt)}),` +
                ` of which ${badAllowed} still owe`);
  }
  console.log(`\n  ⚠ A REFUSED LOAN IS NOT A FREE SAVING. Those members were PARKED and short; refusing`);
  console.log(`  the loan does not make them solvent, it leaves them parked. Rule 1 says "not at the`);
  console.log(`  expense of the ecosystem" — this table prices one side of that. The other side is`);
  console.log(`  how many members stop playing, which no chain query can answer.`);

  /* ── the implementability note, repeated where it will be read ─────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  TO SHIP ANY OF THIS, TWO THINGS MUST BE ADDED — verified in the source today`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  * NO DIRECT COUNT EXISTS. TierRouter:216 stores memberReferrer (child -> sponsor)`);
  console.log(`    only. Add \`mapping(address => uint32) public directCount;\` and increment it where`);
  console.log(`    memberReferrer is assigned (TierRouter:762 register, :813 coupon path). New`);
  console.log(`    mapping, no existing struct touched.`);
  console.log(`  * coPayRescue CANNOT SEE IT. MatrixLogicLib reads only withdrawable and`);
  console.log(`    crossingReserve for the current matrix. The gate needs the count passed in or`);
  console.log(`    read through the router, and that call has to be paid for in gas at a point`);
  console.log(`    already close to the block ceiling — size and gas both need checking before it`);
  console.log(`    is promised. Rule 5 (pay-it-forward for coupon members) needs the SAME counter,`);
  console.log(`    so both rules are gated behind this one addition.`);

  if (gaps.length) {
    console.log(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE — lower bounds, not counts.`);
    for (const [a, b] of gaps.slice(0, 10)) console.log(`     ${a}..${b}`);
  } else console.log(`\n  ✅ every block range read cleanly.`);
  console.log("=".repeat(100));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
