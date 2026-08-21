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
// ⛔ SESSION 19, 2026-08-21 — SECTION 4 ADDED. 18.21 ITEM 1.
//   18.18 took the gate ceiling at 3000 bps and named ONE thing that could overturn it: the
//   live directCount distribution being much thinner than the A/B fixture's referral tree.
//   Section 4 measures that. It reads every live referrer edge off chain (exact), reads the
//   fixture's tree off `ab_sequence_s*.json` (not transcribed), and crosses the two with
//   18.4's zero-sponsor refusal column. ⛔ THE SHORTFALL HALF STAYS A FIXTURE QUANTITY —
//   there is no live V8.50 chain (18.10) and live V8.48 advance sizes are the wrong basis
//   (13.11's crossing buffer, 18.3's bigger V8.50 loans). Every projected line says so.
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

  /* ── TABLE 4: THE LIVE directCount DISTRIBUTION vs THE FIXTURE'S ───────── */
  //
  // 18.21 ITEM 1. Added 2026-08-21, session 19. Why this section exists:
  //
  //   * 18.4 established that `baseAdvanceBps` ONLY lowers the ceiling for members with ZERO
  //     directs. A loan to a member who already has a sponsor is untouched at any base. So
  //     the only column that predicts anything is the zero-sponsor one.
  //   * 18.18 took the decision (base = 3000 bps) and named exactly one thing that could
  //     overturn it: the LIVE directCount distribution being so much thinner than the A/B
  //     fixture's referral tree that $3.00 would refuse a large share of real members rather
  //     than six per 288.
  //   * 18.10 recorded that the fixture's tree "is still not live" and that a session wanting
  //     the live bite should cross the live directCount distribution with 18.4's curve.
  //
  // ⛔ WHAT THIS SECTION CAN AND CANNOT MEASURE — read before quoting any of it.
  //   THE DIRECTS HALF IS LIVE AND EXACT. Every `MemberRegistered` referrer in the window is
  //   read off chain, so the histogram below is a fact about the real population.
  //   THE SHORTFALL HALF IS NOT AND CANNOT BE. Whether a zero-direct member's advance exceeds
  //   the base depends on V8.50 shortfalls, and there is no live V8.50 chain (18.10). Worse,
  //   live V8.48 advances are the WRONG basis for it in a specific, measured way: 13.11 found
  //   62 organic members with peak debt above the 3400 cap because `forceCrossKeeper` books
  //   `sfContribution + crossingBuffer` as one advance, and `crossingBufferBps = 0` is in the
  //   tree but NOT DEPLOYED. 18.3 measured the other direction on the V8.50 arm: mean loan
  //   $1.22 -> $1.99, largest $2.26 -> $4.42. So live loan SIZES are neither build's truth.
  //   Section 4D therefore takes the size half from the V8.50 loan book and the directs half
  //   from this chain, and says which is which on every line.
  //
  // The fixture side is READ OFF `ab_sequence_s*.json` rather than transcribed out of the
  // handoff, so a sequence file that is regenerated cannot silently desynchronise this table.
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  4. THE LIVE directCount DISTRIBUTION — 18.21 item 1, the last thing that could move 3000 bps`);
  console.log(`  ${"=".repeat(96)}`);

  const DBUCKETS = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 9], [10, 1e9]];
  const dlabel = ([a, b]) => a === b ? `${a}` : (b > 1e8 ? `${a}+` : `${a}-${b}`);
  const allMembers = [...isMember];
  const byCohort = { organic: [], bigfill: [], leader: [] };
  for (const m of allMembers) byCohort[cohortOf(m)].push(m);

  /* SANITY — a single address-case mismatch would make every member read 0 directs, which
     looks exactly like the strongest possible finding and would never throw. Same trap the
     loan book's `directsSanity` exists for (18.13). */
  const totalDirectEdges = [...directBlocks.values()].reduce((a, v) => a + v.length, 0);
  const edgesToNonMembers = [...directBlocks.entries()]
    .filter(([r]) => !isMember.has(r)).reduce((a, [, v]) => a + v.length, 0);
  const membersWithAny = allMembers.filter(m => directsNow(m) > 0).length;
  console.log(`\n  SANITY: ${regs.length} registrations, ${allMembers.length} distinct members,` +
              ` ${totalDirectEdges} referrer edges, ${membersWithAny} members with >=1 direct.`);
  console.log(`          ${edgesToNonMembers} edge(s) point at an address that is NOT a member registered in this` +
              ` window (W1 / pre-floor roots) — expected, and they are excluded from the member histogram.`);
  if (membersWithAny === 0) {
    console.error(`\n  ⛔⛔ ZERO members have any direct. That is an address-case or ABI fault, not a finding. STOPPING.`);
    process.exit(1);
  }

  console.log(`\n  4A. LIFETIME DIRECTS AT HEAD — every registered member, by cohort`);
  console.log(`  ${"directs".padEnd(9)}${"ALL".padStart(10)}${"organic".padStart(11)}${"bigfill".padStart(11)}${"leader".padStart(10)}`);
  console.log("  " + "-".repeat(51));
  const shareZero = {};
  for (const bk of DBUCKETS) {
    const cnt = (list) => list.filter(m => { const d = directsNow(m); return d >= bk[0] && d <= bk[1]; }).length;
    console.log(`  ${dlabel(bk).padEnd(9)}${String(cnt(allMembers)).padStart(10)}${String(cnt(byCohort.organic)).padStart(11)}` +
                `${String(cnt(byCohort.bigfill)).padStart(11)}${String(cnt(byCohort.leader)).padStart(10)}`);
  }
  console.log("  " + "-".repeat(51));
  for (const [k, list] of [["ALL", allMembers], ["organic", byCohort.organic], ["bigfill", byCohort.bigfill], ["leader", byCohort.leader]]) {
    const z = list.filter(m => directsNow(m) === 0).length;
    shareZero[k] = list.length ? z / list.length : null;
    console.log(`  ZERO DIRECTS, ${k.padEnd(8)} ${String(z).padStart(4)} of ${String(list.length).padStart(4)} = ${pct(z, list.length)}`);
  }
  console.log(`\n  ⚠ LIFETIME IS AN UPPER BOUND ON WHAT A GATE COULD SEE. It counts people recruited AFTER`);
  console.log(`  the moment the gate would have fired. 4B is the enforceable version; read that one.`);
  console.log(`  ⚠ bigfill is a SCRIPT population with a tree shape nobody chose for realism (14.6 is the`);
  console.log(`  standing reason its member-specific columns are not facts about members). ORGANIC is the`);
  console.log(`  column this decision rests on.`);

  console.log(`\n  4B. DIRECTS AT THE MOMENT OF THE ADVANCE — the figure a gate could actually enforce`);
  const loanRecs = inc.map(e => ({ m: lc(e.args.member), b: e.blockNumber, amt: BigInt(e.args.amount), tier: Number(e.args.tier) }));
  const liveAdv = {};
  for (const [k, list] of [["ALL", allMembers], ["organic", byCohort.organic]]) {
    const set = new Set(list);
    const mine = loanRecs.filter(L => set.has(L.m));
    const zero = mine.filter(L => directsAt(L.m, L.b) === 0);
    liveAdv[k] = { loans: mine.length, zero: zero.length, share: mine.length ? zero.length / mine.length : null };
    console.log(`  ${k.padEnd(8)} ${String(mine.length).padStart(4)} advances, of which ${String(zero.length).padStart(4)}` +
                ` went to a member with ZERO directs at that block = ${pct(zero.length, mine.length)}`);
  }

  /* fee basis — only used to SHOW the live size distribution, which is flagged as the wrong
     build. Read from the SF so nothing here is a typed-in constant. */
  const sfFees = await ethers.getContractAt(["function tierEntryFees(uint256) view returns (uint256)"], A.stabilityFund);
  const fee = [];
  for (let i = 0; i < 6; i++) { try { fee.push(BigInt(await sfFees.tierEntryFees(i))); } catch { fee.push(0n); } }
  if (!fee[0]) {
    console.log(`\n  ⚠ tierEntryFees unreadable — the live bps column below is SKIPPED rather than guessed.`);
  } else {
    const organicSet = new Set(byCohort.organic);
    const zeroLoans = loanRecs.filter(L => organicSet.has(L.m) && directsAt(L.m, L.b) === 0);
    const bpsOf = (L) => { const f = fee[L.tier] || fee[0]; return f ? Number(L.amt * 10000n / f) : 0; };
    const bps = zeroLoans.map(bpsOf).sort((a, b) => a - b);
    if (bps.length) {
      const med = bps[Math.floor(bps.length / 2)];
      console.log(`\n  ⛔ FOR CONTEXT ONLY — NOT A POLICY READING. Live V8.48 zero-direct organic advances,`);
      console.log(`     as bps of the borrower's own tier fee (T1 fee ${usd(fee[0])}):`);
      console.log(`     n=${bps.length}  min ${bps[0]}  median ${med}  max ${bps[bps.length - 1]}  |  over 3000 bps: ${bps.filter(b => b > 3000).length}`);
      console.log(`     ⛔ THIS IS THE WRONG BUILD FOR THE QUESTION and must not be quoted as "the gate would`);
      console.log(`        refuse N live loans". The crossing buffer inflates some of these (13.11) and V8.50`);
      console.log(`        shortfalls are BIGGER again (18.3). Only the DIRECTS half of this section transfers.`);
    }
  }

  console.log(`\n  4C. THE FIXTURE'S SAME NUMBERS — read off the A/B sequence files, not transcribed`);
  const seqFiles = (process.env.AB_SEQ_FILES || "ab_sequence_s1.json,ab_sequence_s2.json,ab_sequence_s3.json").split(",").map(s => s.trim());
  let fixMembers = 0, fixZero = 0, fixSeeds = 0;
  for (const f of seqFiles) {
    const p = path.join(__dirname, "..", f);
    if (!fs.existsSync(p)) { console.log(`  ⚠ ${f} not found — skipped.`); continue; }
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const d = new Map(), ids = [];
    for (const a of j.actions) {
      if (a.op !== "register") continue;
      if (a.m >= 0) ids.push(a.m);
      if (a.ref !== undefined && a.ref !== -2) d.set(a.ref, (d.get(a.ref) || 0) + 1);
    }
    const z = ids.filter(m => !(d.get(m) > 0)).length;
    fixMembers += ids.length; fixZero += z; fixSeeds++;
    console.log(`  ${f.padEnd(24)} ${String(ids.length).padStart(4)} members, ${String(z).padStart(4)} with zero directs = ${pct(z, ids.length)}`);
  }
  const fixShareZero = fixMembers ? fixZero / fixMembers : null;
  if (fixSeeds) console.log(`  ${"POOLED".padEnd(24)} ${String(fixMembers).padStart(4)} members, ${String(fixZero).padStart(4)} with zero directs = ${pct(fixZero, fixMembers)}`);

  console.log(`\n  4D. THE CROSSING — 18.4's zero-sponsor column applied to the live population`);
  console.log(`  ${"-".repeat(96)}`);
  // From the V8.50 LOAN BOOK, pooled 3 seeds, MATRIX_SIZE 127 (18.4 / 18.6 / 18.16). These are
  // the ONLY numbers here that come from the handoff rather than from this run, and the reason
  // is 18.10: there is no live V8.50 chain to take them from.
  const FIX_LOANS = 85, FIX_ZERO_LOANS = 26, FIX_REFUSED_3000 = 14;
  const FIX_FLOOR_EVICTIONS_PER_SEED = 6, FIX_MEMBERS_PER_SEED = 288;
  const pRefusedGivenZero = FIX_REFUSED_3000 / FIX_ZERO_LOANS;
  console.log(`  V8.50 fixture, base 3000: ${FIX_ZERO_LOANS} of ${FIX_LOANS} advances went to zero-direct members` +
              ` (${(FIX_ZERO_LOANS * 100 / FIX_LOANS).toFixed(1)}%),`);
  console.log(`  and ${FIX_REFUSED_3000} of those ${FIX_ZERO_LOANS} exceeded $3.00 and were refused` +
              ` — P(refused | zero directs) = ${(pRefusedGivenZero * 100).toFixed(1)}%.`);
  console.log(`  ⚠ THAT CONDITIONAL IS A V8.50 SHORTFALL FACT AND CANNOT BE MEASURED ON THIS CHAIN.`);
  if (liveAdv.organic && liveAdv.organic.share !== null) {
    const zLive = liveAdv.organic.share;
    const zFix = FIX_ZERO_LOANS / FIX_LOANS;
    console.log(`\n  live organic advances to zero-direct members : ${(zLive * 100).toFixed(1)}%`);
    console.log(`  fixture advances to zero-direct members       : ${(zFix * 100).toFixed(1)}%`);
    console.log(`  ratio live / fixture                          : ${(zLive / zFix).toFixed(2)}x`);
    console.log(`\n  ⚠ PROJECTION, LABELLED AS ONE (rule 6). Holding the V8.50 shortfall conditional fixed and`);
    console.log(`  substituting the live zero-direct share, base 3000 would refuse about`);
    console.log(`  ${(zLive * pRefusedGivenZero * 100).toFixed(1)}% of advances against the fixture's` +
                ` ${(zFix * pRefusedGivenZero * 100).toFixed(1)}%, i.e. roughly` +
                ` ${(FIX_FLOOR_EVICTIONS_PER_SEED * (zLive / zFix)).toFixed(1)} FLOOR refusals per ${FIX_MEMBERS_PER_SEED} members`);
    console.log(`  per run against the fixture's ${FIX_FLOOR_EVICTIONS_PER_SEED}. THIS HAS NOT BEEN RUN — it is arithmetic on two`);
    console.log(`  measurements, and it assumes live V8.50 shortfalls look like the fixture's. It is the`);
    console.log(`  overturn test 18.18 named, nothing more.`);
    console.log(`\n  ⛔ AND THE LIVE FIGURE IS ITSELF AN UPPER BOUND ON THE BITE, for a reason 18.17 already`);
    console.log(`  recorded: on live, \`evictionGracePeriod\` is SEVEN DAYS. A refused member is PARKED with`);
    console.log(`  the badge session 10 made visible, and inviting ONE person inside that week makes them`);
    console.log(`  eligible again. Nothing in this table models that.`);
  }
  if (fixShareZero !== null && shareZero.organic !== null) {
    console.log(`\n  POPULATION-LEVEL CHECK (lifetime, both sides, weaker than the advance-level one above):`);
    console.log(`  live organic zero-direct share ${(shareZero.organic * 100).toFixed(1)}%  vs  fixture ${(fixShareZero * 100).toFixed(1)}%` +
                `  — ratio ${(shareZero.organic / fixShareZero).toFixed(2)}x`);
    console.log(`  ⚠ 13.11 measured the same shape a different way on live (11.5% of still-owing organic`);
    console.log(`  members had sponsored anyone, against 52.3% of clean ones). If this line and 13.11`);
    console.log(`  disagree, THE DISAGREEMENT IS THE FINDING (rule 1) — do not reconcile them in prose.`);
  }

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
