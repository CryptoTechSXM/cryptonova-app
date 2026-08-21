// diag_forward_hop_cohort.js — THE FORWARD HOP, SPLIT BY WHO PAID FOR THE WALLET.
//
// WHY THIS SCRIPT EXISTS (session 13, 2026-08-20):
// diag_forward_hop.js (session 12) measured the live V8.48 forward hop for the first time
// and got 945 hops -> 175 re-entries (18.52%) and a loan book of $1,511.34 borrowed /
// $1,447.51 repaid = 95.78%. Session 12 flagged its own confound in the output and the
// handoff repeats it: THE LIVE ENTRY FLOW IS BIGFILL, FUNDED WITH THE OWNER'S OWN USDC.
// A 95.78% repayment ratio measured on a population the owner is paying for is not
// evidence that a member who never recruits can repay a loan. The repayment MECHANISM is
// proven either way (withdrawCore, the banded clawback, the MatB debt sweep all collect,
// and they collected 836 times). ORGANIC VIABILITY IS NOT.
//
// This script is diag_forward_hop.js with one extra dimension: every member is classified
// into exactly one cohort, and every table is split by it.
//
//   BIGFILL  address is derived from FILL_MNEMONIC at m/44'/60'/0'/0/i for some i in the
//            scan window. This is an EXACT test, not a heuristic. The handoff suggested
//            identifying bigfill by "round-robin leader sponsor, lifetime withdrawn $0.00,
//            reserve exactly $5.00" — all three are properties a real member could also
//            have, so all three can misclassify. Key derivation cannot.
//   LEADER   address is on the 41-address round-robin sponsor roster in run_bigfill_rr.ps1
//            (parsed from that file at runtime — one source of truth, no second copy to
//            drift). Includes W1/accountOne. NOT folded into either other bucket: whether
//            these are owner-funded or real community leaders is UNVERIFIED, so they get
//            their own row and are excluded from the organic claim.
//   ORGANIC  everything else. This is the only bucket that can answer the owner's question.
//
// ⚠ FOUR TRAPS ALREADY PAID FOR — DO NOT REINTRODUCE:
//  1. MemberParked at MatB has SIX emit sites and only TWO carry a real shortfall.
//     Merging them made v1 report more outcomes than attempts (-9). Split by shortfall.
//  2. "the SF emitted a log in this tx" is NOT a loan. FundDeposit fires on every entry's
//     stability split, so that proxy reads 100% and means nothing. Loan = MemberDebtIncreased.
//  3. A DEBT SNAPSHOT IS NOT A REPAYMENT HISTORY. Scan both debt events over all blocks.
//  4. AN INSTRUMENT CANNOT REPORT THE ABSENCE OF WHAT IT CANNOT OBSERVE. MemberCrossedToPartner
//     cannot fire on a MatB cycle-out; TierRouter emits MemberReentered. We count the live one.
//
// ⛔ AND THE ONE THIS SCRIPT ITSELF COULD WALK INTO:
//     IF FILL_MNEMONIC IS MISSING OR WRONG, EVERY BIGFILL WALLET FALLS INTO "ORGANIC" AND
//     THE ORGANIC ROW READS BEAUTIFULLY. That is the flattering failure mode, so it is a
//     HARD EXIT, not a warning — plus a saturation check on the index window, plus a
//     reconciliation that the three cohorts sum to the ungrouped total on every line.
//
// Run: npx hardhat run scripts/diag_forward_hop_cohort.js --network baseSepolia
//      COHORT_MAX=2400 npx hardhat run scripts/diag_forward_hop_cohort.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK = Number(process.env.CHUNK || 9000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 1200);   // HD indices 0..COHORT_MAX-1

// Session 12's ungrouped numbers, for a visible before/after. A delta here is EXPECTED if
// bigfill has run since; it is printed, never asserted.
const S12 = { hops: 945, reentered: 175, borrowedUsd: 1511.34, repaidUsd: 1447.51 };

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
const COH   = ["bigfill", "leader", "organic"];
const zero  = () => ({ bigfill: 0, leader: 0, organic: 0 });
const zeroB = () => ({ bigfill: 0n, leader: 0n, organic: 0n });

/* ─────────────────────────────────────────────────────────────────────────────
 * COHORT MEMBERSHIP. Both halves are derived from a file or a key, never typed
 * in here — a second copy of the leader roster in this file would drift the
 * moment the roster is trimmed, and a drifted roster silently reassigns members
 * to "organic", which is the direction that flatters.
 * ──────────────────────────────────────────────────────────────────────────── */
const bigfillIndexOf = new Map();   // address -> HD index
const leaderSet = new Set();
const humanSet  = new Set();        // wallets we can NAME as real people
let humanSource = "";

/* ⛔ SESSION 13 FINDING THAT MADE THIS NECESSARY.
 * The first run classified 152 distinct addresses as ORGANIC. BUGS.md — every member who
 * has ever filed a report — contains 13 wallets. The real community is on the order of
 * dozens, not 152. "ORGANIC" is therefore not "human", it is "everything I could not
 * name", and a repayment ratio computed over it is not a member repayment ratio.
 * So the organic column is split again: NAMED vs UNIDENTIFIED.
 * BUGS.md is a FLOOR on the human roster, never the roster — a member who never filed a
 * bug is human and lands in UNIDENTIFIED. Read the split as "at least this many are real",
 * never as "the rest are bots". */
function buildHumans() {
  const extra = (process.env.KNOWN_HUMANS || "").match(/0x[0-9a-fA-F]{40}/g) || [];
  for (const a of extra) humanSet.add(lc(a));
  const p = path.join(__dirname, "..", "..", "..", "CryptoNova-Testnet-App", "BUGS.md");
  if (fs.existsSync(p)) {
    for (const m of fs.readFileSync(p, "utf8").matchAll(/0x[0-9a-fA-F]{40}/g)) humanSet.add(lc(m[0]));
    humanSource = `BUGS.md (${p})` + (extra.length ? ` + ${extra.length} from KNOWN_HUMANS` : "");
  } else {
    humanSource = extra.length ? `KNOWN_HUMANS only — BUGS.md NOT FOUND at ${p}` : "⛔ NONE — no roster available";
  }
}

function buildBigfill() {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("\n  ⛔ FILL_MNEMONIC is not set. STOPPING.");
    console.error("     Without it every bigfill wallet would be classified ORGANIC and the");
    console.error("     organic row would read as a triumph. That is exactly the failure this");
    console.error("     script exists to prevent, so it exits instead of reporting.");
    process.exit(1);
  }
  // derive the account node ONCE, then index off it — same addresses bigfill_v8.js's
  // `m/44'/60'/0'/0/${i}` produces, without redoing four hardened steps 1,200 times.
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillIndexOf.set(lc(acct.deriveChild(i).address), i);
}

function buildLeaders() {
  const p = path.join(__dirname, "..", "run_bigfill_rr.ps1");
  const txt = fs.readFileSync(p, "utf8");
  const block = txt.split(/\$leaders\s*=\s*@\(/)[1];
  if (!block) { console.error("\n  ⛔ could not find the $leaders block in run_bigfill_rr.ps1. STOPPING."); process.exit(1); }
  for (const m of block.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
  if (leaderSet.size > 60) {
    console.log(`  ⚠ parsed ${leaderSet.size} leader addresses (expected ~41) — the end-of-array match may have`);
    console.log(`    over-run into the rest of the file. That INFLATES the leader row and SHRINKS organic,`);
    console.log(`    i.e. it errs conservative, but check the roster before quoting the leader column.`);
  }
  if (leaderSet.size < 10) {
    console.error(`\n  ⛔ parsed only ${leaderSet.size} leader addresses from run_bigfill_rr.ps1 (expected ~41). STOPPING.`);
    console.error("     A short roster reassigns leaders to ORGANIC, which is the flattering direction.");
    process.exit(1);
  }
}

// bigfill first: a leader address that is ALSO a derived wallet is bigfill in substance.
const cohortOf = (a) => bigfillIndexOf.has(lc(a)) ? "bigfill" : (leaderSet.has(lc(a)) ? "leader" : "organic");

function row(label, c, pad = 34) {
  return `  ${label.padEnd(pad)}${String(c.bigfill).padStart(11)}${String(c.leader).padStart(10)}${String(c.organic).padStart(10)}` +
         `${String(c.bigfill + c.leader + c.organic).padStart(10)}`;
}
const HDR = `  ${"".padEnd(34)}${"BIGFILL".padStart(11)}${"LEADER".padStart(10)}${"ORGANIC".padStart(10)}${"ALL".padStart(10)}`;

async function main() {
  buildBigfill();
  buildLeaders();
  buildHumans();

  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);
  console.log("=".repeat(100));
  console.log(`  THE FORWARD HOP BY COHORT — ${A.network}, ${process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"}`);
  console.log(`  deployed ${A.deployedAt}   blocks ${from}..${head}  (${head - from})`);
  console.log(`  bigfill window: HD m/44'/60'/0'/0/0 .. ${COHORT_MAX - 1}   leader roster: ${leaderSet.size} addresses`);
  console.log("=".repeat(100));

  const tr    = await ethers.getContractAt(TR, A.tierRouter);
  const reent = await scan(tr, tr.filters.MemberReentered(), from, head);
  const dbl   = await scan(tr, tr.filters.DoubleEntryFired(), from, head);
  const reentKey = new Set(reent.map(e => `${e.transactionHash}|${lc(e.args.member)}`));

  /* ── pass 1: the hop, per tier, per pair, per cohort ───────────────────── */
  const hops = zero(), pShort = zero(), pZero = zero(), reCoh = zero();
  const perTier = {};
  const orphanHops = [];
  const hopsBy = new Map();                 // address -> MatB cycle-out attempts
  const seenIdx = [];                     // HD indices actually observed on chain
  const noteIdx = (a) => { const i = bigfillIndexOf.get(lc(a)); if (i !== undefined) seenIdx.push(i); };
  const allMembers = new Set();

  for (const t of TIERS) {
    const n = Number(t.slice(1));
    const pm = await ethers.getContractAt(PM, A.tiers[t].pm);
    const npairs = Number(await pm.pairCount().catch(() => 1));
    const th = zero(), ts = zero(), tz = zero();
    for (let p = 0; p < npairs; p++) {
      const [, mb] = await pm.getPairAt(p);
      if (mb === ethers.ZeroAddress) continue;
      const MB = await ethers.getContractAt(MX, mb);
      const outs  = await scan(MB, MB.filters.MemberCycledOut(), from, head);
      const parks = await scan(MB, MB.filters.MemberParked(),    from, head);
      const parkKey = new Set();
      for (const e of parks) {
        const c = cohortOf(e.args.member);
        noteIdx(e.args.member); allMembers.add(lc(e.args.member));
        if (BigInt(e.args.shortfall) > 0n) { ts[c]++; pShort[c]++; } else { tz[c]++; pZero[c]++; }
        parkKey.add(`${e.transactionHash}|${lc(e.args.member)}`);
      }
      for (const e of outs) {
        const c = cohortOf(e.args.member);
        noteIdx(e.args.member); allMembers.add(lc(e.args.member));
        th[c]++; hops[c]++;
        hopsBy.set(lc(e.args.member), (hopsBy.get(lc(e.args.member)) || 0) + 1);
        const k = `${e.transactionHash}|${lc(e.args.member)}`;
        if (!parkKey.has(k) && !reentKey.has(k))
          orphanHops.push({ tier: t, cohort: c, member: lc(e.args.member), block: e.blockNumber, tx: e.transactionHash });
      }
    }
    const tre = zero();
    for (const e of reent) if (Number(e.args.tier) === n) tre[cohortOf(e.args.member)]++;
    for (const c of COH) reCoh[c] += tre[c];
    perTier[t] = { th, ts, tz, tre };
  }
  for (const e of reent) { noteIdx(e.args.member); allMembers.add(lc(e.args.member)); }

  /* ── THE TABLE ─────────────────────────────────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  MatB FORWARD HOP — attempts and outcomes, split three ways`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(HDR);
  console.log("  " + "-".repeat(75));
  for (const t of TIERS) {
    const d = perTier[t];
    console.log(row(`${t}  MatB cycle-outs (attempts)`, d.th));
    console.log(row(`${t}  parked WITH shortfall`, d.ts));
    console.log(row(`${t}  parked, shortfall 0`, d.tz));
    console.log(row(`${t}  RE-ENTERED`, d.tre));
    console.log(`  ${(t + "  cleared %").padEnd(34)}${pctOf(d.tre.bigfill, d.th.bigfill).padStart(11)}` +
                `${pctOf(d.tre.leader, d.th.leader).padStart(10)}${pctOf(d.tre.organic, d.th.organic).padStart(10)}` +
                `${pctOf(d.tre.bigfill + d.tre.leader + d.tre.organic, d.th.bigfill + d.th.leader + d.th.organic).padStart(10)}`);
    console.log("  " + "-".repeat(75));
  }
  console.log(row("ALL TIERS  attempts", hops));
  console.log(row("ALL TIERS  parked WITH shortfall", pShort));
  console.log(row("ALL TIERS  parked, shortfall 0", pZero));
  console.log(row("ALL TIERS  RE-ENTERED", reCoh));
  console.log(`  ${"ALL TIERS  CLEARED %".padEnd(34)}${pctOf(reCoh.bigfill, hops.bigfill).padStart(11)}` +
              `${pctOf(reCoh.leader, hops.leader).padStart(10)}${pctOf(reCoh.organic, hops.organic).padStart(10)}` +
              `${pctOf(reCoh.bigfill + reCoh.leader + reCoh.organic, hops.bigfill + hops.leader + hops.organic).padStart(10)}`);

  /* distinct clearers, and how many rounds they got */
  const perMember = new Map();
  for (const e of reent) { const k = lc(e.args.member); perMember.set(k, (perMember.get(k) || 0) + 1); }
  const distinct = zero(), twice = zero(), best = zero();
  for (const [m, n] of perMember) {
    const c = cohortOf(m);
    distinct[c]++; if (n > 1) twice[c]++; if (n > best[c]) best[c] = n;
  }
  console.log(`\n${HDR}`);
  console.log("  " + "-".repeat(75));
  console.log(row("DISTINCT members who cleared", distinct));
  console.log(row("  ...cleared more than once", twice));
  // no ALL column here on purpose: a total of three maxima is not a quantity.
  console.log(`  ${"  ...most rounds by one member".padEnd(34)}${String(best.bigfill).padStart(11)}${String(best.leader).padStart(10)}${String(best.organic).padStart(10)}${"—".padStart(10)}`);

  /* ── WHO PAID, per cohort ──────────────────────────────────────────────── */
  const sf   = await ethers.getContractAt(SFA, A.stabilityFund);
  const inc  = await scan(sf, sf.filters.MemberDebtIncreased(), from, head);
  const rep  = await scan(sf, sf.filters.MemberDebtRepaid(),    from, head);
  const disc = await scan(sf, sf.filters.DiscountPaid(),        from, head);
  const incKey = new Set(inc.map(e => `${e.transactionHash}|${lc(e.args.member)}`));
  const dscKey = new Set(disc.map(e => `${e.transactionHash}|${lc(e.args.member)}`));

  const loanFunded = zero(), discountFunded = zero(), selfFunded = zero();
  for (const e of reent) {
    const c = cohortOf(e.args.member);
    const k = `${e.transactionHash}|${lc(e.args.member)}`;
    if (incKey.has(k)) loanFunded[c]++;
    else if (dscKey.has(k)) discountFunded[c]++;
    else selfFunded[c]++;
  }
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  WHO PAID FOR EACH CLEARANCE — on MemberDebtIncreased, not on "the SF was involved"`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(HDR);
  console.log("  " + "-".repeat(75));
  console.log(row("SF LOAN in the same tx", loanFunded));
  console.log(row("SF discount in the same tx", discountFunded));
  console.log(row("NO SF credit — own earnings", selfFunded));

  /* ── THE LOAN BOOK, per cohort. THIS IS THE ROW THE DECISION WAITS ON. ─── */
  const lent = new Map(), paid = new Map();
  for (const e of inc) { const m = lc(e.args.member); lent.set(m, (lent.get(m) || 0n) + BigInt(e.args.amount)); allMembers.add(m); noteIdx(m); }
  for (const e of rep) { const m = lc(e.args.member); paid.set(m, (paid.get(m) || 0n) + BigInt(e.args.amount)); allMembers.add(m); noteIdx(m); }

  const bor = zeroB(), rpd = zeroB(), nLoans = zero(), nReps = zero(), borrowers = zero(), repayers = zero();
  for (const e of inc) nLoans[cohortOf(e.args.member)]++;
  for (const e of rep) nReps[cohortOf(e.args.member)]++;
  for (const [m, v] of lent) { const c = cohortOf(m); bor[c] += v; if (v > 0n) borrowers[c]++; }
  for (const [m, v] of paid) { const c = cohortOf(m); rpd[c] += v; if (v > 0n) repayers[c]++; }

  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  ⛔ THE LOAN BOOK BY COHORT — the row the owner's A/B/C decision was waiting on`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(HDR);
  console.log("  " + "-".repeat(75));
  console.log(`  ${"borrowed".padEnd(34)}${usd(bor.bigfill).padStart(11)}${usd(bor.leader).padStart(10)}${usd(bor.organic).padStart(10)}${usd(bor.bigfill + bor.leader + bor.organic).padStart(10)}`);
  console.log(`  ${"repaid".padEnd(34)}${usd(rpd.bigfill).padStart(11)}${usd(rpd.leader).padStart(10)}${usd(rpd.organic).padStart(10)}${usd(rpd.bigfill + rpd.leader + rpd.organic).padStart(10)}`);
  console.log(row("loans taken", nLoans));
  console.log(row("repayments made", nReps));
  console.log(row("distinct borrowers", borrowers));
  console.log(row("distinct repayers", repayers));
  console.log(`  ${"REPAYMENT RATIO".padEnd(34)}` +
    COH.map(c => (bor[c] > 0n ? (Number(rpd[c]) * 100 / Number(bor[c])).toFixed(2) + "%" : "n/a").padStart(c === "bigfill" ? 11 : 10)).join("") +
    ((bor.bigfill + bor.leader + bor.organic) > 0n
      ? (Number(rpd.bigfill + rpd.leader + rpd.organic) * 100 / Number(bor.bigfill + bor.leader + bor.organic)).toFixed(2) + "%"
      : "n/a").padStart(10));

  console.log(`\n  HOW TO READ THIS ROW — and how NOT to:`);
  console.log(`    * The BIGFILL column is the owner repaying the owner. It says the collection`);
  console.log(`      MACHINERY works (withdrawCore, the banded clawback, the MatB debt sweep all`);
  console.log(`      fire and land), and nothing about whether a member can afford to repay.`);
  console.log(`    * The LEADER column is UNVERIFIED as to funding source. Do not spend it either way.`);
  console.log(`    * The ORGANIC column is the only one that speaks to option B. If it is thin, say`);
  console.log(`      "we do not know yet" — a small-n ratio is not a rate. n is printed above it on`);
  console.log(`      purpose: read the counts BEFORE the percentage.`);

  /* restricted to clearers, per cohort */
  const cl = zeroB(), cp = zeroB(), everBorrowed = zero();
  for (const m of perMember.keys()) {
    const c = cohortOf(m);
    cl[c] += (lent.get(m) || 0n); cp[c] += (paid.get(m) || 0n);
    if ((lent.get(m) || 0n) > 0n) everBorrowed[c]++;
  }
  console.log(`\n  RESTRICTED TO MEMBERS WHO HAVE CLEARED THE HOP AT LEAST ONCE:`);
  console.log(HDR);
  console.log("  " + "-".repeat(75));
  console.log(row("clearers who ever borrowed", everBorrowed));
  console.log(`  ${"  their lifetime borrowed".padEnd(34)}${usd(cl.bigfill).padStart(11)}${usd(cl.leader).padStart(10)}${usd(cl.organic).padStart(10)}${usd(cl.bigfill + cl.leader + cl.organic).padStart(10)}`);
  console.log(`  ${"  their lifetime repaid".padEnd(34)}${usd(cp.bigfill).padStart(11)}${usd(cp.leader).padStart(10)}${usd(cp.organic).padStart(10)}${usd(cp.bigfill + cp.leader + cp.organic).padStart(10)}`);

  /* ── ⛔ IS "ORGANIC" ACTUALLY HUMAN? ───────────────────────────────────────
   * The whole point of the organic column is that it stands in for real members. It only
   * does that if the addresses in it are real members. This section tests that instead of
   * assuming it, because assuming it is the flattering direction. */
  const orgAddrs = [...allMembers].filter(m => cohortOf(m) === "organic");
  const named = orgAddrs.filter(m => humanSet.has(m));
  const unknown = orgAddrs.filter(m => !humanSet.has(m));
  const tally = (list) => {
    const t = { addrs: list.length, hops: 0, cleared: 0, loans: 0, reps: 0, bor: 0n, rpd: 0n };
    for (const m of list) {
      t.hops    += hopsBy.get(m) || 0;
      t.cleared += perMember.get(m) || 0;
      t.bor     += lent.get(m) || 0n;
      t.rpd     += paid.get(m) || 0n;
    }
    return t;
  };
  const tN = tally(named), tU = tally(unknown);
  tN.loans = inc.filter(e => cohortOf(e.args.member) === "organic" &&  humanSet.has(lc(e.args.member))).length;
  tU.loans = inc.filter(e => cohortOf(e.args.member) === "organic" && !humanSet.has(lc(e.args.member))).length;
  tN.reps  = rep.filter(e => cohortOf(e.args.member) === "organic" &&  humanSet.has(lc(e.args.member))).length;
  tU.reps  = rep.filter(e => cohortOf(e.args.member) === "organic" && !humanSet.has(lc(e.args.member))).length;

  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  ⛔ IS THE ORGANIC COLUMN HUMAN? — splitting it by whether we can NAME the wallet`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  human roster source: ${humanSource}`);
  console.log(`  roster size: ${humanSet.size} wallets`);
  console.log(`  ⚠ THIS ROSTER IS A FLOOR, NOT A CENSUS. It is the members who filed a bug report.`);
  console.log(`    A real member who never filed one lands in UNIDENTIFIED. So NAMED is "at least`);
  console.log(`    this many are real people" and UNIDENTIFIED is "not yet traced" — NOT "bots".`);
  const r2 = (label, a, b) => console.log(`  ${label.padEnd(34)}${String(a).padStart(14)}${String(b).padStart(16)}`);
  console.log(`\n  ${"".padEnd(34)}${"NAMED (human)".padStart(14)}${"UNIDENTIFIED".padStart(16)}`);
  console.log("  " + "-".repeat(64));
  r2("distinct organic addresses", tN.addrs, tU.addrs);
  r2("MatB hop attempts", tN.hops, tU.hops);
  r2("hops CLEARED", tN.cleared, tU.cleared);
  r2("loans taken", tN.loans, tU.loans);
  r2("repayments made", tN.reps, tU.reps);
  r2("borrowed", usd(tN.bor), usd(tU.bor));
  r2("repaid", usd(tN.rpd), usd(tU.rpd));
  r2("REPAYMENT RATIO",
     tN.bor > 0n ? (Number(tN.rpd) * 100 / Number(tN.bor)).toFixed(2) + "%" : "n/a",
     tU.bor > 0n ? (Number(tU.rpd) * 100 / Number(tU.bor)).toFixed(2) + "%" : "n/a");
  console.log(`\n  THE UNIDENTIFIED ADDRESSES, most active first — these are the ones to trace next.`);
  console.log(`  Every one of them is either a real member we have no record of, or a wallet some`);
  console.log(`  earlier script created that we have lost track of. Both answers matter and they`);
  console.log(`  point opposite ways, so do not guess which.`);
  const rank = unknown.map(m => ({ m, h: hopsBy.get(m) || 0, c: perMember.get(m) || 0,
                                   l: Number(lent.get(m) || 0n) / 1e6, p: Number(paid.get(m) || 0n) / 1e6 }))
                      .sort((a, b) => (b.h + b.c + b.l) - (a.h + a.c + a.l));
  console.log(`  ${"address".padEnd(44)}${"hops".padStart(6)}${"cleared".padStart(9)}${"borrowed".padStart(11)}${"repaid".padStart(11)}`);
  for (const r of rank.slice(0, 20))
    console.log(`  ${r.m.padEnd(44)}${String(r.h).padStart(6)}${String(r.c).padStart(9)}${("$" + r.l.toFixed(2)).padStart(11)}${("$" + r.p.toFixed(2)).padStart(11)}`);
  if (rank.length > 20) console.log(`  ... and ${rank.length - 20} more`);

  /* ── unexplained cycle-outs, now with a cohort ─────────────────────────── */
  const totHops = hops.bigfill + hops.leader + hops.organic;
  if (orphanHops.length) {
    const oc = zero(); for (const o of orphanHops) oc[o.cohort]++;
    console.log(`\n  ⚠ ${orphanHops.length} CYCLE-OUT(S) WITH NO NAMED OUTCOME (${pctOf(orphanHops.length, totHops)} of attempts).`);
    console.log(row("  by cohort", oc));
    console.log(`    Neither a park nor a re-entry in their own transaction. ${dbl.length} DoubleEntryFired exist`);
    console.log(`    overall and are the leading candidate — UNVERIFIED. Open one; do not assume.`);
    for (const o of orphanHops.slice(0, 8)) console.log(`      ${o.tier} ${o.cohort.padEnd(8)} blk ${o.block}  ${o.member}  ${o.tx}`);
  }

  /* ── SELF-CHECKS. Read these before believing anything above. ──────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  SELF-CHECKS — if any of these fails, the numbers above are void`);
  console.log(`  ${"=".repeat(96)}`);

  const maxSeen = seenIdx.length ? Math.max(...seenIdx) : -1;
  const distinctIdx = new Set(seenIdx).size;
  console.log(`  bigfill wallets actually seen on chain ....... ${distinctIdx} distinct, highest HD index ${maxSeen}`);
  if (maxSeen < 0) {
    console.log(`  ⛔ ZERO derived wallets matched anything on chain. Either FILL_MNEMONIC is the`);
    console.log(`     WRONG phrase for this deployment, or the derivation path changed. The cohort`);
    console.log(`     split above is meaningless — every bigfill wallet is sitting in ORGANIC.`);
  } else if (maxSeen >= COHORT_MAX - 32) {
    console.log(`  ⛔ SATURATED: the highest index seen (${maxSeen}) is at the edge of the ${COHORT_MAX}-wide`);
    console.log(`     window, so bigfill wallets above it are being counted as ORGANIC. Re-run with`);
    console.log(`     COHORT_MAX=${COHORT_MAX * 2} before reading the organic column.`);
  } else {
    console.log(`  ✅ window not saturated — ${COHORT_MAX - 1 - maxSeen} unused indices above the highest wallet seen,`);
    console.log(`     so no bigfill wallet is leaking into ORGANIC through a short window.`);
  }

  const census = zero();
  for (const m of allMembers) census[cohortOf(m)]++;
  console.log(row("distinct addresses seen, by cohort", census));

  console.log(`\n  RECONCILIATION vs the same quantities ungrouped (must be exact):`);
  const chk = (name, c, whole) => {
    const s = c.bigfill + c.leader + c.organic;
    console.log(`    ${name.padEnd(30)} cohorts ${String(s).padStart(6)}   ungrouped ${String(whole).padStart(6)}   ${s === whole ? "✅" : "⛔ MISMATCH"}`);
  };
  chk("re-entries", reCoh, reent.length);
  chk("loans (MemberDebtIncreased)", nLoans, inc.length);
  chk("repayments (MemberDebtRepaid)", nReps, rep.length);
  const borAll = bor.bigfill + bor.leader + bor.organic, rpdAll = rpd.bigfill + rpd.leader + rpd.organic;
  console.log(`    ${"borrowed total".padEnd(30)} cohorts ${usd(borAll)}   (session 12 ungrouped: $${S12.borrowedUsd.toFixed(2)})`);
  console.log(`    ${"repaid total".padEnd(30)} cohorts ${usd(rpdAll)}   (session 12 ungrouped: $${S12.repaidUsd.toFixed(2)})`);
  console.log(`    ${"hops total".padEnd(30)} cohorts ${String(totHops).padStart(6)}   (session 12: ${S12.hops})`);
  console.log(`    ${"re-entered total".padEnd(30)} cohorts ${String(reent.length).padStart(6)}   (session 12: ${S12.reentered})`);
  console.log(`    A DELTA vs session 12 IS EXPECTED if bigfill has run since — it is printed, not asserted.`);
  console.log(`    A MISMATCH on the ✅/⛔ lines is a broken classifier and voids the split.`);

  if (gaps.length) {
    console.log(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE — TOTALS ARE LOWER BOUNDS, NOT COUNTS.`);
    for (const [a, b] of gaps.slice(0, 10)) console.log(`     ${a}..${b}`);
  } else console.log(`\n  ✅ every block range read cleanly — these are counts, not lower bounds.`);
  console.log("=".repeat(100));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
