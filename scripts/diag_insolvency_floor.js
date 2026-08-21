// diag_insolvency_floor.js — v2, TIER-CORRECTED. Does a lower floor reach 100% repayment?
//
// ⛔ WHY v2 EXISTS — v1 HAD A DEFECT AND IT SHIPPED (session 13, 2026-08-20).
// The ceiling is PER TIER: `tierEntryFees[tier] * insolvencyFloorBps / 10_000`. At 3400 bps
// that is $3.40 at T1 but $8.50 at T2. v1 bucketed peak debt in RAW DOLLARS and applied the
// T1 cap to everybody, so its ">$5.00" band was mostly T2 members sitting INSIDE their own
// ceiling rather than members who had exceeded one, and its replay table refused T2 members
// against a T1 cap. Every number in v1's sections 1 and 2 is void. v2 measures peak debt as
// a FRACTION OF THE MEMBER'S OWN TIER CEILING BASIS, in bps, which is the unit the parameter
// is actually set in.
//
// ⛔ AND v2 AVOIDS THE COUNTERFACTUAL v1 WALKED INTO.
// v1 asked "if the cap had been B, how much would we not have lent?" — which assumes a capped
// member borrows the excess-less amount and then behaves identically. Nobody knows that. A
// member refused their advance is PARKED, and a parked member earns differently from a seated
// one. That is a simulation dressed as a measurement.
// v2 asks a purely OBSERVATIONAL question instead:
//
//     AMONG MEMBERS WHOSE PEAK DEBT NEVER EXCEEDED B, WHAT SHARE ENDED UP CLEAN?
//
// No counterfactual, no assumed behaviour — just the members the chain already ran at or
// below each level. If that share reaches 100% at some B, a cap at B is supported by
// evidence. If it never reaches 100% at any B, THE FLOOR CANNOT DELIVER 100% REPAYMENT and
// the owner's target needs the referral gate instead. Both answers are useful; the second
// one is the one a flattering instrument would hide.
//
// OWNER'S DECISION THIS SERVES (2026-08-20): "the system must not carry anyone's debts — if
// they will not be able to pay we do not offer them a loan. I am looking for 100% loan
// repayment, so if that means a reduction from 50% to 40% or even 20% so be it. The way to
// get out would be to sponsor one or more."
//
// ⚠ CENSORING, UNCHANGED FROM v1 AND STILL BINDING: the live floor is 3400 bps, so no member
// was ever ALLOWED past 3400 bps of their own tier fee. This data can justify LOWERING the
// floor. It can say nothing about 5000 or 6800 — nobody was permitted to get there. PARAM
// 59's queued 5000 is outside what this can see, by construction.
//
// Run: npx hardhat run scripts/diag_insolvency_floor.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

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
  if (!mnemo) { console.error("\n  ⛔ FILL_MNEMONIC not set. STOPPING."); process.exit(1); }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillSet.add(lc(acct.deriveChild(i).address));
  const ps1 = fs.readFileSync(path.join(__dirname, "..", "run_bigfill_rr.ps1"), "utf8");
  const blk = ps1.split(/\$leaders\s*=\s*@\(/)[1];
  for (const m of blk.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
}
const cohortOf = (a) => bigfillSet.has(lc(a)) ? "bigfill" : leaderSet.has(lc(a)) ? "leader" : "organic";

async function main() {
  buildSets();
  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);

  const sf = await ethers.getContractAt(
    ["event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
     "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
     "function insolvencyFloorBps() view returns (uint256)",
     "function tierEntryFees(uint256) view returns (uint256)"], A.stabilityFund);

  let liveBps = null;
  try { liveBps = Number(await sf.insolvencyFloorBps()); } catch { }
  const fee = [];
  for (let i = 0; i < 10; i++) { try { fee.push(BigInt(await sf.tierEntryFees(i))); } catch { fee.push(0n); } }
  if (!fee[0]) { console.error("  ⛔ tierEntryFees unreadable — every bps figure below would be fiction. STOPPING."); process.exit(1); }

  console.log("=".repeat(100));
  console.log(`  THE INSOLVENCY FLOOR v2 (TIER-CORRECTED) — ${A.network}, blocks ${from}..${head}`);
  console.log(`  LIVE: insolvencyFloorBps = ${liveBps} (${(liveBps / 100).toFixed(1)}%)   T1 fee ${usd(fee[0])} -> cap ${usd(fee[0] * BigInt(liveBps) / 10000n)}`);
  console.log(`                                                 T2 fee ${usd(fee[1])} -> cap ${usd(fee[1] * BigInt(liveBps) / 10000n)}`);
  console.log(`  ⚠ v1 of this script mixed those two ceilings. Its sections 1 and 2 are VOID.`);
  console.log("=".repeat(100));

  const inc = await scan(sf, sf.filters.MemberDebtIncreased(), from, head);
  const rep = await scan(sf, sf.filters.MemberDebtRepaid(),    from, head);
  const evs = [...inc.map(e => ({ m: lc(e.args.member), b: e.blockNumber, i: e.index ?? 0,
                                  t: BigInt(e.args.newTotal), tier: Number(e.args.tier), kind: "inc" })),
               ...rep.map(e => ({ m: lc(e.args.member), b: e.blockNumber, i: e.index ?? 0,
                                  t: BigInt(e.args.newTotal), tier: -1, kind: "rep" }))]
              .sort((x, y) => x.b - y.b || x.i - y.i);

  /* peak debt, AND the tier that was in force when the peak was reached */
  const peak = new Map(), peakTier = new Map(), last = new Map(), nLoans = new Map(), curTier = new Map();
  for (const e of evs) {
    if (e.kind === "inc") { curTier.set(e.m, e.tier); nLoans.set(e.m, (nLoans.get(e.m) || 0) + 1); }
    if (!peak.has(e.m) || e.t > peak.get(e.m)) {
      peak.set(e.m, e.t);
      peakTier.set(e.m, curTier.get(e.m) ?? 0);
    }
    last.set(e.m, e.t);
  }
  const organic = [...peak.keys()].filter(m => cohortOf(m) === "organic");

  // peak as bps of the member's OWN tier fee — the unit the parameter is set in
  const peakBps = new Map();
  for (const m of organic) {
    const f = fee[peakTier.get(m)] || fee[0];
    peakBps.set(m, f > 0n ? Number(peak.get(m) * 10000n / f) : 0);
  }
  const clean = (m) => last.get(m) === 0n;

  /* ── 1. WHERE DO THE DEFAULTERS SIT? ──────────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  1. PEAK DEBT AS % OF THE MEMBER'S OWN TIER FEE — clean vs still-owing, side by side`);
  console.log(`  ${"=".repeat(96)}`);
  const BANDS = [[0, 500], [500, 1000], [1000, 1700], [1700, 2500], [2500, 3400], [3400, 100000]];
  console.log(`  ${"peak (bps of own fee)".padEnd(24)}${"members".padStart(9)}${"clean".padStart(8)}${"OWING".padStart(8)}${"clean %".padStart(10)}${"still owed".padStart(12)}`);
  console.log("  " + "-".repeat(71));
  for (const [lo2, hi2] of BANDS) {
    const list = organic.filter(m => peakBps.get(m) > lo2 && peakBps.get(m) <= hi2);
    if (!list.length) continue;
    const c = list.filter(clean).length;
    const owed = list.reduce((a, m) => a + last.get(m), 0n);
    const lbl = hi2 > 99999 ? `> ${lo2}` : `${lo2}-${hi2}`;
    console.log(`  ${lbl.padEnd(24)}${String(list.length).padStart(9)}${String(c).padStart(8)}` +
                `${String(list.length - c).padStart(8)}${pct(c, list.length).padStart(10)}${usd(owed).padStart(12)}`);
  }
  console.log(`\n  IF THE OWING COLUMN IS CONCENTRATED AT HIGH BPS, a lower floor removes those members`);
  console.log(`  and the owner's 100% target is reachable by setting the parameter. IF DEFAULTERS APPEAR`);
  console.log(`  AT EVERY LEVEL INCLUDING THE LOWEST, no floor value can deliver 100% — the parameter is`);
  console.log(`  not the discriminating variable and the referral gate is the only route to the target.`);

  /* ── 2. THE OBSERVATIONAL ANSWER TO "WHICH SETTING GIVES 100%?" ───────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  2. ⛔ THE OWNER'S QUESTION, ANSWERED WITHOUT A COUNTERFACTUAL`);
  console.log(`     "Among members who never exceeded B, what share ended CLEAN?"`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  ${"setting".padEnd(18)}${"T1 cap".padStart(9)}${"members at/below".padStart(18)}${"clean".padStart(8)}${"OWING".padStart(8)}${"CLEAN %".padStart(10)}`);
  console.log("  " + "-".repeat(71));
  let firstClean = null;
  for (const B of [500, 1000, 1700, 2000, 2500, 3000, 3400]) {
    const list = organic.filter(m => peakBps.get(m) <= B);
    if (!list.length) { console.log(`  ${(B + " bps").padEnd(18)}${usd(fee[0] * BigInt(B) / 10000n).padStart(9)}${"0".padStart(18)}`); continue; }
    const c = list.filter(clean).length;
    if (c === list.length && firstClean === null && list.length >= 10) firstClean = B;
    console.log(`  ${(B + " bps (" + (B / 100).toFixed(0) + "%)").padEnd(18)}${usd(fee[0] * BigInt(B) / 10000n).padStart(9)}` +
                `${String(list.length).padStart(18)}${String(c).padStart(8)}${String(list.length - c).padStart(8)}${pct(c, list.length).padStart(10)}` +
                (B === liveBps ? "   <- LIVE" : ""));
  }
  console.log(`\n  ⚠ READ THE "members at/below" COLUMN BEFORE THE PERCENTAGE. A 100% that rests on four`);
  console.log(`  members is not a policy — the same warning that killed "3 directs" as an answer.`);
  console.log(firstClean !== null
    ? `\n  => LOWEST SETTING REACHING 100% ON A MEANINGFUL SAMPLE (n>=10): ${firstClean} bps (${(firstClean / 100).toFixed(0)}%)`
    : `\n  => ⛔ NO SETTING REACHES 100% ON A SAMPLE OF 10 OR MORE. Defaulters exist at every level`
      + `\n     the chain has run. THE FLOOR CANNOT DELIVER THE OWNER'S 100% TARGET ON ITS OWN.`);

  /* ── 3. WHAT A LOWER FLOOR COSTS IN COVERAGE ─────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  3. WHAT IT COSTS — how many members the cap would have stopped serving`);
  console.log(`  ${"=".repeat(96)}`);
  const totalOrg = organic.length;
  for (const B of [500, 1000, 1700, 2000, 2500, 3000, 3400]) {
    const above = organic.filter(m => peakBps.get(m) > B);
    const aboveOwing = above.filter(m => !clean(m)).length;
    console.log(`  ${(B + " bps").padEnd(10)} would have capped ${String(above.length).padStart(3)} of ${totalOrg} organic borrowers` +
                ` (${pct(above.length, totalOrg)}), of whom ${String(aboveOwing).padStart(2)} are the ones still owing`);
  }
  console.log(`\n  THE TRADE IN ONE SENTENCE: a cap that removes the defaulters also removes members who`);
  console.log(`  borrowed the same amount and PAID IT BACK. The second number in each row is the part`);
  console.log(`  you wanted gone; the difference is the collateral.`);

  /* ── 4. THE OWNER'S EXIT ROUTE, CHECKED ──────────────────────────────── */
  const tr = await ethers.getContractAt(
    ["event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)"], A.tierRouter);
  const directs = new Map();
  for (const e of await scan(tr, tr.filters.MemberRegistered(), from, head)) {
    const r = lc(e.args.referrer);
    if (r !== ethers.ZeroAddress) directs.set(r, (directs.get(r) || 0) + 1);
  }
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  4. "THE WAY OUT WOULD BE TO SPONSOR ONE OR MORE" — checked against the members in debt`);
  console.log(`  ${"=".repeat(96)}`);
  const owing = organic.filter(m => !clean(m));
  const owingWithDirects = owing.filter(m => (directs.get(m) || 0) > 0).length;
  const cleanWithDirects = organic.filter(clean).filter(m => (directs.get(m) || 0) > 0).length;
  const cleanN = organic.filter(clean).length;
  console.log(`  organic members STILL OWING ......... ${String(owing.length).padStart(4)}   of whom ${owingWithDirects} have sponsored anyone (${pct(owingWithDirects, owing.length)})`);
  console.log(`  organic members CLEAN .............. ${String(cleanN).padStart(4)}   of whom ${cleanWithDirects} have sponsored anyone (${pct(cleanWithDirects, cleanN)})`);
  console.log(`\n  If sponsoring is genuinely the exit, members in debt should be the ones who never`);
  console.log(`  sponsored. This is the cheapest possible test of the owner's stated escape route and`);
  console.log(`  it is observational — no model, no assumption about what a refused member would do.`);

  if (gaps.length) console.log(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE — lower bounds, not counts.`);
  else console.log(`\n  ✅ every block range read cleanly.`);
  console.log("=".repeat(100));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
