// diag_loan_lifetime.js — WHAT IS THE SF LOAN ACTUALLY DOING, AND DOES IT BUY A CYCLE?
//
// WHERE THIS CAME FROM (session 13, 2026-08-20). The population question is now closed:
//   * diag_forward_hop_cohort.js split the live hop by cohort. ORGANIC turned out to be the
//     LARGER half of the loan book: $727.63 borrowed, 91.88% repaid, 113 borrowers.
//   * diag_who_are_they.js could not derive any of the 143 unknown wallets from FILL_MNEMONIC
//     on six path families up to index 2400, and found their sponsor structure is a spread
//     referral tree (70 distinct sponsors, 16.1% roster-sponsored, biggest sponsor 4.9%)
//     where bigfill is 100% roster-sponsored at 5.3 members per sponsor.
//   * stress_keeper.js — the only other thing that registers — reads THE SAME FILL_MNEMONIC
//     on THE SAME path, so its wallets were already inside BIGFILL. Owner confirms bigfill
//     and stress are one wallet set, run one at a time. There is no third registrar.
//   => THE ORGANIC ROW IS REAL MEMBERS. It can be spent.
//
// ⚠ ONE SECTION B CAVEAT WORTH KEEPING: the funding-provenance panel read 14% for BIGFILL,
// a group we KNOW we funded. That is not a finding about bigfill, it is the scan window
// starting at the V8.48 deploy block while the wallets were funded on the same mock USDC
// long before it. The control group is the only reason that was visible instead of being
// reported as "most bigfill wallets are self-funded". Do not quote that panel.
//
// SO WHAT IS LEFT, AND IT IS THE ACTUAL DECISION:
// In the organic loan list, borrowed and repaid match TO THE CENT wallet after wallet —
// $16.16/$16.16, $14.02/$14.02, $14.48/$14.48 — with the aggregate shortfall concentrated in
// a handful. Uniform-to-the-cent repayment across a population is a MECHANICAL signature,
// and it raises the question the 91.88% cannot answer:
//
//     IF A LOAN IS EXTINGUISHED IN THE SAME FLOW THAT CREATES IT, THAT IS PLUMBING, NOT
//     CREDIT — AND OPTION B ("LEND TO CLOSE THE GAP") WOULD NOT MEAN WHAT WE THINK.
//
// And the owner's bar is not a repayment ratio at all. It is: "give members at least two
// full cycles but not at the expense of an unpaid loan." That is a comparison, not a rate,
// and nobody has run it: DO BORROWERS GET MORE CYCLES THAN NON-BORROWERS?
//
// SECTIONS
//   1. BURST COMPOSITION — the last loose thread on the population. 42.7% of organic members
//      registered within 30 blocks of another, a pattern matching NEITHER control. If burst
//      mates share a sponsor it is one person onboarding their group, which is the most
//      organic thing on the chain. If they do not, something else is going on. MEASURED, not
//      assumed — the sponsor-onboarding story is mine and it might be wrong.
//   2. LOAN TIMING — same transaction? same block? how long to full repayment? A loan repaid
//      in its own transaction is not credit.
//   3. DID THE LOAN BUY A CYCLE? — organic borrowers vs organic NON-borrowers, on hops
//      attempted and hops cleared. This is the owner's bar, measured directly.
//   4. WHAT IS STILL OWED, and how old it is.
//
// Run: npx hardhat run scripts/diag_loan_lifetime.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK = Number(process.env.CHUNK || 9000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 2400);
const BURST = Number(process.env.BURST || 30);

const lc = (a) => String(a).toLowerCase();
const usd = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
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
  if (!mnemo) { console.error("\n  ⛔ FILL_MNEMONIC not set — bigfill would be counted as organic. STOPPING."); process.exit(1); }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillSet.add(lc(acct.deriveChild(i).address));
  const ps1 = fs.readFileSync(path.join(__dirname, "..", "run_bigfill_rr.ps1"), "utf8");
  const blk = ps1.split(/\$leaders\s*=\s*@\(/)[1];
  if (!blk) { console.error("\n  ⛔ could not parse the leader roster. STOPPING."); process.exit(1); }
  for (const m of blk.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
}
const cohortOf = (a) => bigfillSet.has(lc(a)) ? "bigfill" : leaderSet.has(lc(a)) ? "leader" : "organic";

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => d ? `${(n * 100 / d).toFixed(1)}%` : "n/a";

async function main() {
  buildSets();
  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);

  // honest block->time conversion instead of assuming 2s
  const b0 = await ethers.provider.getBlock(from), b1 = await ethers.provider.getBlock(head);
  const SEC_PER_BLOCK = (b1.timestamp - b0.timestamp) / (head - from);
  const dur = (blocks) => {
    const s = blocks * SEC_PER_BLOCK;
    if (s < 90) return `${s.toFixed(0)}s`;
    if (s < 5400) return `${(s / 60).toFixed(0)}m`;
    if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };

  console.log("=".repeat(100));
  console.log(`  THE SF LOAN: WHAT IT IS, AND WHETHER IT BUYS A CYCLE — ${A.network}`);
  console.log(`  blocks ${from}..${head}   measured block time ${SEC_PER_BLOCK.toFixed(2)}s`);
  console.log("=".repeat(100));

  /* ── 1. BURST COMPOSITION ─────────────────────────────────────────────── */
  const tr = await ethers.getContractAt(
    ["event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)"], A.tierRouter);
  const regs = await scan(tr, tr.filters.MemberRegistered(), from, head);
  const regOf = new Map();
  for (const e of regs) { const m = lc(e.args.member); if (!regOf.has(m)) regOf.set(m, { block: e.blockNumber, ref: lc(e.args.referrer) }); }

  const organic = [...regOf.keys()].filter(m => cohortOf(m) === "organic");
  const seq = organic.map(m => ({ m, ...regOf.get(m) })).sort((a, b) => a.block - b.block);
  const bursts = [];
  let cur = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].block - seq[i - 1].block <= BURST) cur.push(seq[i]);
    else { if (cur.length > 1) bursts.push(cur); cur = [seq[i]]; }
  }
  if (cur.length > 1) bursts.push(cur);

  let sameSponsor = 0, mixed = 0, membersInSame = 0, membersInMixed = 0;
  for (const b of bursts) {
    const s = new Set(b.map(x => x.ref));
    if (s.size === 1) { sameSponsor++; membersInSame += b.length; } else { mixed++; membersInMixed += b.length; }
  }
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  1. THE LAST LOOSE THREAD ON THE POPULATION — what are the registration bursts?`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  organic registrations: ${seq.length}   bursts (2+ within ${BURST} blocks / ~${dur(BURST)}): ${bursts.length}`);
  console.log(`    bursts where EVERY member shares one sponsor . ${String(sameSponsor).padStart(4)}  (${membersInSame} members)`);
  console.log(`    bursts with mixed sponsors ................... ${String(mixed).padStart(4)}  (${membersInMixed} members)`);
  console.log(`  ONE SPONSOR PER BURST = one person signing up their group in a sitting, which is the`);
  console.log(`  most organic thing on this chain. MIXED = unrelated people happening to arrive together,`);
  console.log(`  which is normal at any busy moment and proves nothing either way. Neither pattern`);
  console.log(`  resembles bigfill, which registers one wallet per run and never bursts at all.`);
  for (const b of bursts.slice(0, 6)) {
    const s = new Set(b.map(x => x.ref));
    console.log(`    blk ${b[0].block}  ${String(b.length).padStart(2)} members  ${s.size === 1 ? "one sponsor " + [...s][0].slice(0, 10) : s.size + " sponsors"}`);
  }

  /* ── 2. LOAN TIMING ───────────────────────────────────────────────────── */
  const sf = await ethers.getContractAt(
    ["event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
     "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)"], A.stabilityFund);
  const inc = await scan(sf, sf.filters.MemberDebtIncreased(), from, head);
  const rep = await scan(sf, sf.filters.MemberDebtRepaid(),    from, head);

  const tl = new Map();   // member -> [{kind, block, tx, amt, newTotal}]
  const push = (kind, e) => {
    const m = lc(e.args.member);
    if (!tl.has(m)) tl.set(m, []);
    tl.get(m).push({ k: kind, b: e.blockNumber, tx: e.transactionHash,
                     a: BigInt(e.args.amount), t: BigInt(e.args.newTotal), i: e.index ?? e.logIndex ?? 0 });
  };
  for (const e of inc) push("inc", e);
  for (const e of rep) push("rep", e);
  for (const v of tl.values()) v.sort((x, y) => x.b - y.b || x.i - y.i);

  const timing = {};
  for (const grp of ["organic", "bigfill"]) {
    const t = { loans: 0, sameTx: 0, sameBlock: 0, clearBlocks: [], neverCleared: 0 };
    for (const [m, ev] of tl) {
      if (cohortOf(m) !== grp) continue;
      for (let i = 0; i < ev.length; i++) {
        if (ev[i].k !== "inc") continue;
        t.loans++;
        // find the event that first drives newTotal back to 0 at or after this loan
        let cleared = null;
        for (let j = i; j < ev.length; j++) if (ev[j].k === "rep" && ev[j].t === 0n) { cleared = ev[j]; break; }
        if (!cleared) { t.neverCleared++; continue; }
        if (cleared.tx === ev[i].tx) t.sameTx++;
        else if (cleared.b === ev[i].b) t.sameBlock++;
        t.clearBlocks.push(cleared.b - ev[i].b);
      }
    }
    timing[grp] = t;
  }
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  2. IS THIS CREDIT, OR PLUMBING? — how long a loan lives before it is cleared`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  ${"".padEnd(40)}${"ORGANIC".padStart(14)}${"BIGFILL (control)".padStart(20)}`);
  console.log("  " + "-".repeat(74));
  const t2 = (label, f) => console.log(`  ${label.padEnd(40)}${String(f("organic")).padStart(14)}${String(f("bigfill")).padStart(20)}`);
  t2("loans taken", g => timing[g].loans);
  t2("cleared in the SAME TRANSACTION", g => `${timing[g].sameTx} (${pct(timing[g].sameTx, timing[g].loans)})`);
  t2("cleared in the same block, other tx", g => `${timing[g].sameBlock} (${pct(timing[g].sameBlock, timing[g].loans)})`);
  t2("never reached zero debt", g => `${timing[g].neverCleared} (${pct(timing[g].neverCleared, timing[g].loans)})`);
  t2("median blocks to zero debt", g => { const m = median(timing[g].clearBlocks); return m === null ? "—" : `${m} (${dur(m)})`; });
  console.log(`\n  IF "SAME TRANSACTION" DOMINATES: the SF is not lending, it is fronting the shortfall`);
  console.log(`  inside one atomic flow and taking it straight back. Option B would then be a`);
  console.log(`  BOOKKEEPING change, cheap and low-risk, not a credit facility. IF THE MEDIAN IS`);
  console.log(`  DAYS: real balances are outstanding across cycles and B carries genuine risk that`);
  console.log(`  has to be priced. These are different decisions with the same name.`);

  /* ── 3. DID THE LOAN BUY A CYCLE? ─────────────────────────────────────── */
  const hopsBy = new Map(), clearedBy = new Map();
  const trRe = await ethers.getContractAt(["event MemberReentered(address indexed member, uint8 tier)"], A.tierRouter);
  for (const e of await scan(trRe, trRe.filters.MemberReentered(), from, head))
    clearedBy.set(lc(e.args.member), (clearedBy.get(lc(e.args.member)) || 0) + 1);
  const PM = ["function pairCount() view returns (uint256)", "function getPairAt(uint256) view returns (address,address)"];
  const MX = ["event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)"];
  for (const t of TIERS) {
    const pm = await ethers.getContractAt(PM, A.tiers[t].pm);
    const n = Number(await pm.pairCount().catch(() => 1));
    for (let p = 0; p < n; p++) {
      const [, mb] = await pm.getPairAt(p);
      if (mb === ethers.ZeroAddress) continue;
      const MB = await ethers.getContractAt(MX, mb);
      for (const e of await scan(MB, MB.filters.MemberCycledOut(), from, head))
        hopsBy.set(lc(e.args.member), (hopsBy.get(lc(e.args.member)) || 0) + 1);
    }
  }
  const borrowers = new Set([...tl.keys()].filter(m => tl.get(m).some(x => x.k === "inc")));
  const grpStat = (list) => {
    const hops = list.reduce((a, m) => a + (hopsBy.get(m) || 0), 0);
    const cl   = list.reduce((a, m) => a + (clearedBy.get(m) || 0), 0);
    const two  = list.filter(m => (clearedBy.get(m) || 0) >= 2).length;
    return { n: list.length, hops, cl, two,
             perHead: list.length ? (cl / list.length).toFixed(2) : "n/a",
             rate: pct(cl, hops), twoPct: pct(two, list.length) };
  };
  const oB = grpStat(organic.filter(m => borrowers.has(m)));
  const oN = grpStat(organic.filter(m => !borrowers.has(m)));
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  3. THE OWNER'S ACTUAL BAR — "at least two full cycles, but not at the expense of an`);
  console.log(`     unpaid loan". Borrowers vs non-borrowers, ORGANIC members only.`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  ${"".padEnd(40)}${"BORROWED".padStart(14)}${"NEVER BORROWED".padStart(18)}`);
  console.log("  " + "-".repeat(72));
  const t3 = (l, a, b) => console.log(`  ${l.padEnd(40)}${String(a).padStart(14)}${String(b).padStart(18)}`);
  t3("members", oB.n, oN.n);
  t3("MatB hop attempts", oB.hops, oN.hops);
  t3("hops cleared", oB.cl, oN.cl);
  t3("clear rate", oB.rate, oN.rate);
  t3("cycles per member", oB.perHead, oN.perHead);
  t3("reached TWO OR MORE cycles", `${oB.two} (${oB.twoPct})`, `${oN.two} (${oN.twoPct})`);
  console.log(`\n  ⚠ THIS IS A COMPARISON, NOT AN EXPERIMENT. Members are not randomly assigned to`);
  console.log(`  borrow — you borrow BECAUSE you were short, so borrowers are selected for being`);
  console.log(`  worse off to start with. If borrowers still match or beat non-borrowers, that is`);
  console.log(`  strong. If they trail, the gap is NOT the loan's fault and this cannot separate`);
  console.log(`  the two. State it that way or not at all.`);

  /* ── 4. WHAT IS STILL OWED ────────────────────────────────────────────── */
  const owed = new Map();
  for (const [m, ev] of tl) { const last = ev[ev.length - 1]; if (last.t > 0n) owed.set(m, { amt: last.t, since: last.b }); }
  const byCoh = { bigfill: [0n, 0], leader: [0n, 0], organic: [0n, 0] };
  for (const [m, o] of owed) { const c = cohortOf(m); byCoh[c][0] += o.amt; byCoh[c][1]++; }
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  4. STILL OUTSTANDING RIGHT NOW`);
  console.log(`  ${"=".repeat(96)}`);
  for (const c of ["organic", "bigfill", "leader"])
    console.log(`  ${c.padEnd(12)} ${usd(byCoh[c][0]).padStart(10)} owed by ${String(byCoh[c][1]).padStart(3)} members`);
  const oldest = [...owed.entries()].filter(([m]) => cohortOf(m) === "organic").sort((a, b) => a[1].since - b[1].since).slice(0, 8);
  if (oldest.length) {
    console.log(`\n  oldest ORGANIC balances (age = time since their last debt movement):`);
    for (const [m, o] of oldest) console.log(`    ${m}  ${usd(o.amt).padStart(9)}  untouched ${dur(head - o.since)}`);
  }

  if (gaps.length) {
    console.log(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE — lower bounds, not counts.`);
    for (const [a, b] of gaps.slice(0, 10)) console.log(`     ${a}..${b}`);
  } else console.log(`\n  ✅ every block range read cleanly.`);
  console.log("=".repeat(100));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
