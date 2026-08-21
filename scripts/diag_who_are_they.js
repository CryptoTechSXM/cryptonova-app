// diag_who_are_they.js — ARE THE 141 "ORGANIC" WALLETS PEOPLE, OR SOMETHING WE BUILT?
//
// WHY THIS SCRIPT EXISTS (session 13, 2026-08-20):
// diag_forward_hop_cohort.js split the live forward hop three ways and the organic column
// turned out to be the LARGER half of the loan book — $727.63 borrowed, 91.88% repaid,
// against bigfill's $712.33. That would settle option B, except for one disagreement:
//
//     ORGANIC holds 152 distinct addresses. BUGS.md — every member who has ever filed a
//     report — holds 13. The community is dozens of people, not 152.
//
// So "ORGANIC" currently means "everything the classifier could not name", and 141 of the
// 152 are unidentified. They carry $708.44 of the $727.63. The organic repayment ratio is
// THEIR ratio, and until we know what they are it is not a member repayment ratio.
//
// ⛔ THE DESIGN POINT — THIS SCRIPT HAS TWO CONTROL GROUPS ON PURPOSE.
// Measuring only the unknowns would produce a story either way: any pattern can be read as
// "looks like a bot" or "looks like a person" once you know which answer you want. So the
// SAME fingerprint runs over three groups:
//
//     BIGFILL      known machine   (derived from FILL_MNEMONIC — certainty, not inference)
//     NAMED        known human     (wallets that filed bug reports)
//     UNIDENTIFIED the subject
//
// If UNIDENTIFIED matches BIGFILL on every axis, they are ours. If it matches NAMED, they
// are people. If it matches neither, we have found a third thing and must not force it into
// one of the two buckets. The controls are what make a wrong answer visible.
//
// WHAT IT MEASURES, all of it cheap and all of it on indexed filters:
//   A. ALTERNATIVE DERIVATION PATHS — free, instant, and decisive when it hits. If some
//      earlier script made wallets from the same phrase on a different path, they are ours
//      and the search finds them outright.
//   B. USDC FUNDING PROVENANCE — the mock USDC is ours, so every token movement is project
//      traffic. A wallet funded straight from the deployer, in a uniform amount, is being
//      operated. Amount uniformity is the fingerprint; the deployer also funds real members,
//      so the SOURCE alone is not the test — the SHAPE is.
//   C. REGISTRATION CLUSTERING — script registrations arrive in tight bursts, people do not.
//   D. SPONSOR SHAPE — round-robin allocation leaves an even spread across the leader
//      roster. Word of mouth does not.
//
// ⚠ WHAT THIS CANNOT SEE, STATED BEFORE THE RESULT: a wallet funded by another member, or
// by a contract payout, has no deployer transfer and lands in "no direct funding found".
// That is not evidence of humanity — it is absence of evidence, and it is reported as its
// own bucket rather than folded into either answer.
//
// Run: npx hardhat run scripts/diag_who_are_they.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const CHUNK = Number(process.env.CHUNK || 9000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 2400);
const BURST = Number(process.env.BURST || 30);        // blocks; two events closer than this are one burst

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

/* ── the same classifier as diag_forward_hop_cohort.js ───────────────────── */
const bigfillIndexOf = new Map(), leaderSet = new Set(), humanSet = new Set();

function buildSets() {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) { console.error("\n  ⛔ FILL_MNEMONIC not set — every bigfill wallet would look organic. STOPPING."); process.exit(1); }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillIndexOf.set(lc(acct.deriveChild(i).address), i);

  const ps1 = fs.readFileSync(path.join(__dirname, "..", "run_bigfill_rr.ps1"), "utf8");
  const blk = ps1.split(/\$leaders\s*=\s*@\(/)[1];
  if (!blk) { console.error("\n  ⛔ could not parse the leader roster. STOPPING."); process.exit(1); }
  for (const m of blk.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));

  const bugs = path.join(__dirname, "..", "..", "..", "CryptoNova-Testnet-App", "BUGS.md");
  if (fs.existsSync(bugs)) for (const m of fs.readFileSync(bugs, "utf8").matchAll(/0x[0-9a-fA-F]{40}/g)) humanSet.add(lc(m[0]));
  for (const m of (process.env.KNOWN_HUMANS || "").match(/0x[0-9a-fA-F]{40}/g) || []) humanSet.add(lc(m));
}
const groupOf = (a) => bigfillIndexOf.has(lc(a)) ? "BIGFILL"
                     : leaderSet.has(lc(a))      ? null            // leaders excluded, unverified funding
                     : humanSet.has(lc(a))       ? "NAMED"
                     : "UNIDENTIFIED";

const GROUPS = ["BIGFILL", "NAMED", "UNIDENTIFIED"];
const pad = (s, n = 16) => String(s).padStart(n);
function line(label, vals) { console.log(`  ${label.padEnd(38)}${GROUPS.map(g => pad(vals[g])).join("")}`); }
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function main() {
  buildSets();
  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);
  console.log("=".repeat(100));
  console.log(`  WHO ARE THE UNIDENTIFIED WALLETS? — ${A.network}, blocks ${from}..${head}`);
  console.log(`  two control groups: BIGFILL = known machine, NAMED = known human (${humanSet.size} roster wallets)`);
  console.log("=".repeat(100));

  /* population = everyone who ever registered on this deployment */
  const tr = await ethers.getContractAt(
    ["event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)"], A.tierRouter);
  const regs = await scan(tr, tr.filters.MemberRegistered(), from, head);
  const regOf = new Map();                       // address -> {block, referrer}
  for (const e of regs) {
    const m = lc(e.args.member);
    if (!regOf.has(m)) regOf.set(m, { block: e.blockNumber, referrer: lc(e.args.referrer) });
  }
  const members = { BIGFILL: [], NAMED: [], UNIDENTIFIED: [] };
  for (const m of regOf.keys()) { const g = groupOf(m); if (g) members[g].push(m); }

  console.log(`\n  registered members on this deployment: ${regOf.size}`);
  line("group size (registered)", Object.fromEntries(GROUPS.map(g => [g, members[g].length])));
  if (!members.UNIDENTIFIED.length) { console.log("\n  nothing unidentified — nothing to answer."); return; }

  /* ── A. ALTERNATIVE DERIVATION PATHS ──────────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  A. DID SOME EARLIER SCRIPT MAKE THESE FROM THE SAME PHRASE ON A DIFFERENT PATH?`);
  console.log(`  ${"=".repeat(96)}`);
  const want = new Set(members.UNIDENTIFIED);
  const mnemo = process.env.FILL_MNEMONIC;
  const CANDIDATES = [
    ["m/44'/60'/0'/1",  (n, i) => n.deriveChild(i)],
    ["m/44'/60'/1'/0",  (n, i) => n.deriveChild(i)],
    ["m/44'/60'/2'/0",  (n, i) => n.deriveChild(i)],
    ["m/44'/60'/0'",    (n, i) => n.deriveChild(i)],
    ["m/44'/1'/0'/0",   (n, i) => n.deriveChild(i)],
    ["m",               (n, i) => n.deriveChild(i)],
  ];
  let anyHit = false;
  for (const [base, step] of CANDIDATES) {
    let node; try { node = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, base); } catch { continue; }
    let hits = 0, first = null;
    for (let i = 0; i < COHORT_MAX; i++) {
      const a = lc(step(node, i).address);
      if (want.has(a)) { hits++; if (first === null) first = i; }
    }
    const verdict = hits ? `⛔ ${hits} HIT(S) — these are OURS (first at index ${first})` : "clean";
    console.log(`  ${base.padEnd(20)}/0..${COHORT_MAX - 1}   ${verdict}`);
    if (hits) anyHit = true;
  }
  console.log(anyHit
    ? `  ⛔ At least one alternative path matches. Those wallets are machine wallets and the\n     organic loan-book row must be recomputed with them reclassified.`
    : `  ✅ No alternative path off this phrase produces any of them. They were NOT made by a\n     script using FILL_MNEMONIC. That does not clear a DIFFERENT phrase (e.g. the VPS).`);

  /* ── B. USDC FUNDING PROVENANCE ───────────────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  B. WHERE DID THEIR USDC COME FROM? (the mock USDC is ours, so all of it is project traffic)`);
  console.log(`  ${"=".repeat(96)}`);
  const usdc = await ethers.getContractAt(
    ["event Transfer(address indexed from, address indexed to, uint256 value)"], A.usdc);
  const sources = [["deployer", A.deployer], ["mint (0x0)", ethers.ZeroAddress], ["accountOne/W1", A.accountOne]];
  const firstFund = new Map();                   // address -> {block, value, src}
  for (const [name, addr] of sources) {
    const evs = await scan(usdc, usdc.filters.Transfer(addr, null), from, head);
    for (const e of evs) {
      const to = lc(e.args.to);
      const prev = firstFund.get(to);
      if (!prev || e.blockNumber < prev.block) firstFund.set(to, { block: e.blockNumber, value: BigInt(e.args.value), src: name });
    }
    console.log(`  scanned Transfer(from=${name.padEnd(13)}) -> ${evs.length} transfers`);
  }

  const stat = {};
  for (const g of GROUPS) {
    const list = members[g];
    const funded = list.filter(m => firstFund.has(m));
    const amounts = funded.map(m => firstFund.get(m).value.toString());
    const histo = new Map();
    for (const v of amounts) histo.set(v, (histo.get(v) || 0) + 1);
    const top = [...histo.entries()].sort((a, b) => b[1] - a[1])[0];
    stat[g] = { n: list.length, funded: funded.length, distinctAmounts: histo.size,
                topAmount: top ? top[0] : null, topCount: top ? top[1] : 0 };
  }
  line("registered", Object.fromEntries(GROUPS.map(g => [g, stat[g].n])));
  line("funded directly by us", Object.fromEntries(GROUPS.map(g => [g, stat[g].funded])));
  line("  as % of group", Object.fromEntries(GROUPS.map(g => [g, stat[g].n ? (stat[g].funded * 100 / stat[g].n).toFixed(1) + "%" : "n/a"])));
  line("no direct funding found", Object.fromEntries(GROUPS.map(g => [g, stat[g].n - stat[g].funded])));
  line("distinct first-fund amounts", Object.fromEntries(GROUPS.map(g => [g, stat[g].distinctAmounts])));
  line("most common amount", Object.fromEntries(GROUPS.map(g => [g, stat[g].topAmount ? usd(stat[g].topAmount) : "—"])));
  line("  how many got exactly that", Object.fromEntries(GROUPS.map(g => [g, stat[g].topCount])));
  console.log(`\n  READ IT LIKE THIS: one amount repeated across a whole group is an operator paying a`);
  console.log(`  fixed stake per wallet. A wide spread of amounts is people funding themselves at`);
  console.log(`  whatever size they chose. Compare UNIDENTIFIED against BOTH controls, not against`);
  console.log(`  your expectation. "no direct funding found" means their USDC came from somewhere`);
  console.log(`  else entirely — another member, or a contract payout — and is its own answer.`);

  /* ── C. REGISTRATION CLUSTERING ───────────────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  C. DID THEY ARRIVE IN BURSTS? (a script registers in bursts; people trickle)`);
  console.log(`  ${"=".repeat(96)}`);
  const clus = {};
  for (const g of GROUPS) {
    const blocks = members[g].map(m => regOf.get(m).block).sort((a, b) => a - b);
    const diffs = blocks.slice(1).map((b, i) => b - blocks[i]);
    let bursts = 0, inBurst = 0, run = 1, biggest = 1;
    for (const d of diffs) {
      if (d <= BURST) { run++; } else { if (run > 1) { bursts++; inBurst += run; biggest = Math.max(biggest, run); } run = 1; }
    }
    if (run > 1) { bursts++; inBurst += run; biggest = Math.max(biggest, run); }
    clus[g] = { med: median(diffs), bursts, inBurst, biggest,
                pct: blocks.length ? (inBurst * 100 / blocks.length).toFixed(1) + "%" : "n/a" };
  }
  line(`median gap between registrations`, Object.fromEntries(GROUPS.map(g => [g, clus[g].med === null ? "—" : clus[g].med + " blk"])));
  line(`registered inside a burst (<=${BURST} blk)`, Object.fromEntries(GROUPS.map(g => [g, clus[g].pct])));
  line("largest single burst", Object.fromEntries(GROUPS.map(g => [g, clus[g].biggest])));

  /* ── D. SPONSOR SHAPE ─────────────────────────────────────────────────── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  D. WHO SPONSORED THEM? (round-robin spreads evenly across the roster; word of mouth does not)`);
  console.log(`  ${"=".repeat(96)}`);
  const spon = {};
  for (const g of GROUPS) {
    const refs = members[g].map(m => regOf.get(m).referrer);
    const h = new Map();
    for (const r of refs) h.set(r, (h.get(r) || 0) + 1);
    const onRoster = refs.filter(r => leaderSet.has(r)).length;
    const top = [...h.entries()].sort((a, b) => b[1] - a[1]);
    spon[g] = { distinct: h.size, onRoster: refs.length ? (onRoster * 100 / refs.length).toFixed(1) + "%" : "n/a",
                topShare: refs.length ? (top[0][1] * 100 / refs.length).toFixed(1) + "%" : "n/a",
                perSponsor: h.size ? (refs.length / h.size).toFixed(1) : "n/a" };
  }
  line("distinct sponsors", Object.fromEntries(GROUPS.map(g => [g, spon[g].distinct])));
  line("sponsored BY a roster leader", Object.fromEntries(GROUPS.map(g => [g, spon[g].onRoster])));
  line("members per sponsor (mean)", Object.fromEntries(GROUPS.map(g => [g, spon[g].perSponsor])));
  line("biggest single sponsor share", Object.fromEntries(GROUPS.map(g => [g, spon[g].topShare])));

  /* ── VERDICT SCAFFOLD — states what would settle it, does not settle it ── */
  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  HOW TO CONCLUDE FROM THIS — the rule, written before the numbers were read`);
  console.log(`  ${"=".repeat(96)}`);
  console.log(`  * UNIDENTIFIED tracks BIGFILL on funding shape AND burst AND sponsor spread`);
  console.log(`      -> they are ours. Reclassify, recompute the loan book, and the organic row`);
  console.log(`         collapses to the 11 named wallets, which is too small to decide on.`);
  console.log(`  * UNIDENTIFIED tracks NAMED instead`);
  console.log(`      -> they are people we simply never recorded, the organic row stands at ~$708`);
  console.log(`         borrowed / 91.66% repaid, and option B has real evidence behind it.`);
  console.log(`  * UNIDENTIFIED matches NEITHER control`);
  console.log(`      -> a third population exists. Do not force it either way; find out what it is.`);
  console.log(`  * ANY alternative-path hit in section A overrides all of the above — key`);
  console.log(`    derivation is proof, the rest of this script is inference.`);

  if (gaps.length) {
    console.log(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE — these are lower bounds, not counts.`);
    for (const [a, b] of gaps.slice(0, 10)) console.log(`     ${a}..${b}`);
  } else console.log(`\n  ✅ every block range read cleanly.`);
  console.log("=".repeat(100));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
