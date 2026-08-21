"use strict";
/**
 * set_base_advance.js — ARM (or read) the V8.50 sponsorship gate. Session 19, 2026-08-21.
 *
 * WHAT THE GATE IS: StabilityFund.baseAdvanceBps is a LOWER borrowing ceiling applied to
 * members whose TierRouter.directCount is 0. Policy value 3000 bps ($3.00 at a $10 T1
 * fee), decided in handoff 18.18 and re-confirmed against the live referral distribution
 * in 19.0. It is NOT "a small first advance" — 18.8 — it is a ceiling, and a zero-direct
 * member whose shortfall exceeds it receives nothing and is routed to eviction.
 *
 * ⛔ WHY THIS SCRIPT EXISTS RATHER THAN A ONE-LINE setBaseAdvanceBps CALL.
 *   directCount is a FRESH MAPPING ON A FRESH DEPLOY. It does not backfill. On migration
 *   day every member reads 0 directs, including members with twenty, so arming the gate
 *   early would refuse them for an EMPTY COUNTER rather than for a policy. That is why
 *   StabilityFund ships at 10_000 (inert) and why this is a separate, deliberate step.
 *
 * ⛔ AND IT IS THE SECOND INSTRUMENT, WHICH IS WHY IT REFUSES TO ARM BLIND.
 *   Before it will send anything it rebuilds the expected directCount for every sponsor
 *   OFF-CHAIN from MemberRegistered events, then reads the ON-CHAIN mapping for each one
 *   and requires them to agree exactly. Two independent derivations of one quantity: if
 *   the counter is not being maintained correctly on this deployment, the disagreement is
 *   the finding and NOTHING is armed. A gate armed against a broken counter refuses real
 *   members silently, which is the worst failure this system has available to it.
 *
 * READ-ONLY BY DEFAULT.
 *   node/hardhat run without --arm  ->  reconcile, print the histogram, send nothing.
 *   with --arm                       ->  same checks, then setBaseAdvanceBps(BASE_BPS).
 *
 * Run (from C:\CryptoNite-Smart-Contracts\CryptoNova):
 *   $env:ADDRESSES_FILE="deployed_addresses_v8_50.json"
 *   npx hardhat run scripts/set_base_advance.js --network baseSepolia
 *   # then, only once the histogram looks like a rebuilt tree:
 *   $env:ARM="1"; npx hardhat run scripts/set_base_advance.js --network baseSepolia
 *
 * (hardhat run swallows argv, so ARM is an env var. BASE_BPS overrides the 3000 default.)
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ARM = process.env.ARM === "1";
const TARGET_BPS = Number(process.env.BASE_BPS || 3000);
const CHUNK = Number(process.env.CHUNK || 9000);

const lc = (a) => String(a).toLowerCase();
const pct = (n, d) => (d ? `${(n * 100 / d).toFixed(1)}%` : "n/a");
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

async function main() {
  const ethers = hre.ethers;
  if (hre.network.name !== "baseSepolia") throw new Error(`Wrong network: ${hre.network.name}`);

  const addrsFile = process.env.ADDRESSES_FILE || "deployed_addresses_v8_50.json";
  let p = path.join(__dirname, addrsFile);
  if (!fs.existsSync(p)) p = path.join(__dirname, "..", addrsFile);
  if (!fs.existsSync(p)) throw new Error(`addresses file not found: ${addrsFile}`);
  const A = JSON.parse(fs.readFileSync(p, "utf8"));

  const [owner] = await ethers.getSigners();
  const sf = await ethers.getContractAt("StabilityFund", A.stabilityFund, owner);
  const tr = await ethers.getContractAt("TierRouter", A.tierRouter, owner);

  console.log("=".repeat(96));
  console.log(`  THE SPONSORSHIP GATE — ${ARM ? "ARM" : "READ-ONLY PRE-FLIGHT"}   (${addrsFile})`);
  console.log(`  signer ${owner.address}`);
  console.log("=".repeat(96));

  const floorBps = Number(await sf.insolvencyFloorBps());
  const baseBps  = Number(await sf.baseAdvanceBps());
  const fee0     = await sf.tierEntryFees(0);
  const usd = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
  console.log(`  insolvencyFloorBps ${floorBps}  ->  T1 ceiling ${usd(fee0 * BigInt(floorBps) / 10000n)}`);
  console.log(`  baseAdvanceBps     ${baseBps}${baseBps >= floorBps ? "  (INERT — base >= floor, router never read)" : `  -> zero-direct ceiling ${usd(fee0 * BigInt(baseBps) / 10000n)}`}`);
  console.log(`  target             ${TARGET_BPS}  -> zero-direct ceiling ${usd(fee0 * BigInt(TARGET_BPS) / 10000n)}`);

  /* ── rebuild directCount off-chain from the registration log ─────────────── */
  const head = await ethers.provider.getBlockNumber();
  const from = Number(process.env.FROM_BLOCK || 0) ||
    Math.max(1, (await (async () => {
      const want = Math.floor(new Date(A.deployedAt).getTime() / 1000);
      let lo = 1, hi = head;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const blk = await ethers.provider.getBlock(mid);
        if (!blk) { lo = mid + 1; continue; }
        if (blk.timestamp < want) lo = mid + 1; else hi = mid;
      }
      return lo;
    })()) - 50);

  console.log(`\n  scanning MemberRegistered, blocks ${from}..${head} ...`);
  const evTr = await ethers.getContractAt(
    ["event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)"], A.tierRouter);
  const regs = await scan(evTr, evTr.filters.MemberRegistered(), from, head);

  const expected = new Map();          // sponsor -> expected directCount
  const members = new Set();
  for (const e of regs) {
    members.add(lc(e.args.member));
    const r = lc(e.args.referrer);
    if (r === ethers.ZeroAddress) continue;
    expected.set(r, (expected.get(r) || 0) + 1);
  }
  console.log(`  ${regs.length} registrations, ${members.size} distinct members, ${expected.size} distinct sponsors.`);

  if (gaps.length) {
    console.error(`\n  ⛔⛔ ${gaps.length} BLOCK RANGE(S) UNREADABLE. The off-chain rebuild is a LOWER BOUND,`);
    console.error(`     so it cannot reconcile against the chain and NOTHING will be armed.`);
    for (const [a, b] of gaps.slice(0, 10)) console.error(`     ${a}..${b}`);
    process.exit(1);
  }

  /* ── THE RECONCILIATION — two derivations, one printed line where they meet ─ */
  console.log(`\n  RECONCILING the on-chain counter against the rebuilt log ...`);
  let mismatches = 0, checked = 0;
  for (const [addr, want] of expected) {
    const got = Number(await tr.directCount(addr));
    checked++;
    if (got !== want) {
      if (mismatches < 20) console.error(`  ⛔ ${addr}  chain ${got}  log ${want}`);
      mismatches++;
    }
  }
  // members who sponsored nobody must read exactly 0 — the other half of the check, and
  // the half that catches a counter incrementing the wrong address.
  let phantom = 0;
  for (const m of members) {
    if (expected.has(m)) continue;
    const got = Number(await tr.directCount(m));
    checked++;
    if (got !== 0) { if (phantom < 20) console.error(`  ⛔ ${m}  chain ${got}  log 0 (phantom credit)`); phantom++; }
  }
  const zeroAddrCount = Number(await tr.directCount(ethers.ZeroAddress));
  if (zeroAddrCount !== 0) console.error(`  ⛔ address(0) holds ${zeroAddrCount} directs — the _bookkeepJoin guard is not working`);

  if (mismatches || phantom || zeroAddrCount) {
    console.error(`\n  ⛔⛔ ${mismatches} undercount/overcount, ${phantom} phantom, address(0)=${zeroAddrCount}.`);
    console.error(`  THE COUNTER AND THE LOG DISAGREE. THE DISAGREEMENT IS THE FINDING — measure it,`);
    console.error(`  do not explain it. NOTHING WAS ARMED.`);
    process.exit(1);
  }
  console.log(`  ✅ ${checked} addresses checked, chain and log agree exactly. address(0) holds 0.`);

  /* ── the histogram the decision rests on ─────────────────────────────────── */
  const BUCKETS = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 9], [10, 1e9]];
  const label = ([a, b]) => (a === b ? `${a}` : b > 1e8 ? `${a}+` : `${a}-${b}`);
  const all = [...members];
  const directsOf = (m) => expected.get(m) || 0;
  console.log(`\n  LIVE directCount HISTOGRAM on this deployment`);
  for (const bk of BUCKETS) {
    const n = all.filter(m => { const d = directsOf(m); return d >= bk[0] && d <= bk[1]; }).length;
    if (n) console.log(`    ${label(bk).padEnd(6)}${String(n).padStart(6)}   ${pct(n, all.length)}`);
  }
  const zero = all.filter(m => directsOf(m) === 0).length;
  console.log(`    ZERO DIRECTS: ${zero} of ${all.length} = ${pct(zero, all.length)}`);
  console.log(`\n  ⚠ COMPARE THAT AGAINST THE PRE-MIGRATION READING BEFORE ARMING (handoff 19.1):`);
  console.log(`    live V8.48 organic 56.1%, A/B fixture pooled 49.7%. A share far ABOVE those means`);
  console.log(`    the tree has not rebuilt yet and the counter is empty rather than the members`);
  console.log(`    being sponsorless. ARMING INTO THAT REFUSES REAL MEMBERS FOR A MISSING NUMBER.`);
  console.log(`  ⚠ And it is a whole-population figure. Section 4 of diag_referral_threshold.js`);
  console.log(`    splits it by cohort — bigfill reads 100% zero by construction and is not a fact`);
  console.log(`    about members. Run that too before arming on a chain that has been filled.`);

  if (!ARM) {
    console.log(`\n  READ-ONLY. Nothing was sent. To arm:  $env:ARM="1"; npx hardhat run scripts/set_base_advance.js --network baseSepolia`);
    console.log("=".repeat(96));
    return;
  }

  if (TARGET_BPS > 10_000) throw new Error("BASE_BPS > 10000");
  console.log(`\n  ARMING: setBaseAdvanceBps(${TARGET_BPS}) ...`);
  const tx = await sf.setBaseAdvanceBps(TARGET_BPS);
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();
  const after = Number(await sf.baseAdvanceBps());
  if (after !== TARGET_BPS) throw new Error(`did not update — reads ${after}`);
  console.log(`  ✅ baseAdvanceBps = ${after}. Zero-direct T1 ceiling is now ${usd(fee0 * BigInt(after) / 10000n)}.`);
  console.log(`  ⚠ Eviction volume is expected to RISE. handoff 18.16 is who it refuses and 18.17 is`);
  console.log(`    why the live seven-day grace makes every A/B eviction count an upper bound.`);
  console.log("=".repeat(96));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
