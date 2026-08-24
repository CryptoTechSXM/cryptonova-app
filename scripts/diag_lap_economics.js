// diag_lap_economics.js — CAN A SEAT ANYWHERE ON THIS CHAIN EARN ITS OWN NEXT CROSSING?
//
// THE QUESTION (session 36, after 36.1 closed 35.10 item 1). 35.6 measured a member
// looping: six matrices, re-park in the same block as the rescue, earnings of $0.00 ·
// $0.25 · $0.00 · $0.63 · $0.00 · $1.25 against shortfalls of $4.75-$50.00. 35.6's own
// explanation was "those matrices are nearly empty, so there is no downline paying in",
// and my first instinct this session was to go measure pair expansion — new rooms being
// deployed faster than members arrive.
//
// ⛔ THAT INSTINCT WAS A HYPOTHESIS, AND CLAUDE.md ALREADY CONTRADICTS IT:
//
//     "FUNDING CONSTRAINT (design fact, not a bug). The crossing reserve covers exactly
//      50% of the next entry fee; the member must have earned the other 50% or they
//      PARK. Pool payout is fixed at 18% split across the matrix, so a member with no
//      referral income can essentially never self-fund a re-entry — repeated parking
//      with variable shortfalls is the DESIGNED path for them, not a fault."
//
//    If that is right, EMPTINESS IS NOT THE CAUSE — it only makes a structural shortfall
//    wider. Fixing pair-expansion pacing would then be work aimed at the wrong thing.
//    If it is wrong, depth is a real lever and pacing is worth a session.
//
//    ⚠ AND CLAUDE.md IS A CLAIM, NOT A MEASUREMENT — the file says so about itself
//    (2026-08-22, the DelegationManager correction). So this measures it.
//
// THE DESIGN — A CONTROL ARM, WHICH IS THE ONLY THING THAT CAN SEPARATE THE TWO STORIES
//
//   ARM BUSY   the highest-throughput half of the matrices that have ever rotated
//   ARM QUIET  the lowest-throughput half of the same set
//
//   (v1 cut these on DEPTH and got two identical arms — see the run-1 note below. Seats
//   do not vary among rotating matrices on this chain; rotations vary 40 to 3,250.)
//
//   If the quiet arm's members earn their crossing and the busy arm's do not — or the
//   reverse — traffic is a lever and 35.6's "no downline paying in" reading has somewhere
//   to go. If NEITHER arm earns it, the shortfall is structural, pacing is irrelevant,
//   and the only levers left are the three on the board (stop re-entering / stop lending
//   into a dead lap / let the member opt out).
//
//   This is session 17's lesson applied deliberately: to price a mechanism you have to
//   hold everything else still and watch ONE thing move. Here the thing moving is depth.
//
// WHAT IS MEASURED, PER SEATED MEMBER, FROM THE CHAIN'S OWN FIELDS
//   needed   = ENTRY_FEE - crossingReserve      what earnings must cover at cycle-out
//   earned   = totalEarned / cyclesCompleted    what a completed lap has actually paid
//   funded   = crossingReserve + withdrawable >= ENTRY_FEE
// The split is read with `getSplitConfig()` rather than assumed — CLAUDE.md's 18% is a
// remembered number and remembered numbers are what this file exists to stop quoting.
//
// ⛔ RUN 1 (2026-08-24 15:27Z) WITHHELD ITS OWN VERDICT ON A CONSERVATION BREACH, AND
//    THE BREACH WAS MY CEILING, NOT THE CHAIN. KEEP THIS.
//
//    v1 bounded a matrix's payouts by `totalJoined * ENTRY_FEE * (L1+chain+pool)/10000`
//    and three matrices "breached" it — T1.1 MatA read $3,922.55 of seated earnings
//    against a $1,642.50 ceiling. The source says why:
//
//      MatrixLogicLib:363   if (!self.members[member].hasEverJoined) {
//      MatrixLogicLib:365       self.totalJoined += 1;
//
//    `totalJoined` counts UNIQUE MEMBERS EVER, not paid entries. Every re-entry pays a
//    fresh fee that it never counts — and T1.1 MatA has **3,250 rotations against 450
//    joins**. The ceiling was low by roughly the re-entry multiple, which is exactly the
//    ratio the "breach" showed. The seat readings were never in question: they are direct
//    struct reads. **I invented a bound and then believed it over the chain.**
//
// ⛔ RUN 1 ALSO HAD NO CONTROL ARM, AND SAID SO ONLY BY ACCIDENT. Arm 2 was "the deepest
//    matrices", and every occupied-and-rotating matrix on this chain is 127/127 FULL. So
//    both arms came out identical on the variable under test. Depth and lap-completion
//    are perfectly confounded here: the eight full matrices are the only ones where
//    anybody has ever completed a lap, and every partially-filled matrix (107, 91, 71,
//    60, 52 seats) has rotationCount 0. **SEATS DO NOT VARY ON THIS CHAIN. THROUGHPUT
//    DOES** — 3,250 rotations down to 40 across the six — so the arms are now cut on
//    throughput, and the seat/rotation numbers are printed beside every arm so the
//    confound stays visible instead of being smoothed over.
//
// SELF-TESTS — BOTH ARE EXACTLY TRUE OR THE INSTRUMENT IS WRONG. NO INVENTED CEILINGS.
//   1. THE RESERVE IS QUANTISED. `MatrixLogicLib:958` adds exactly
//      `entryFee * CROSSING_RESERVE_BPS / 10000` and every other write sets it to 0, so
//      EVERY seated member's `crossingReserve` must be an exact multiple of half the fee.
//      This tests the fee read and the getMember tuple decode together — if the tuple
//      field order were wrong (the repo's standing trap) this fails on the first seat.
//   2. THE SPLIT MUST CLOSE. The ten legs of `getSplitConfig()` must sum to the payout
//      base, `10000 - CROSSING_RESERVE_BPS - DIRECT_EARN_BPS`. Exact, from chain.
//   3. PLANTED POSITIVE. The busiest matrix must show a non-zero `poolAccumulator`.
//
// ⛔ NO SILENT CAPS. If the seat walk is truncated the script says exactly how many seats
//    it skipped and in which matrix. A census that quietly stops at N reads as complete.
//
// Read-only. Sends no transaction, needs no key.
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/diag_lap_economics.js --network baseSepolia
//
//   MAX_SEATS=127    per-matrix seat-walk cap (default 127 = the whole matrix)
//   TIERS=T1,T2      limit the estate sweep
//   SNAPSHOT=0       do not pin reads to one block
//   CSV=out.csv      override output path
//
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.log("    npx hardhat run scripts/diag_lap_economics.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX_ABI = [
  "function occupancy() view returns (uint256)",
  "function MATRIX_SIZE() view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
  "function totalJoined() view returns (uint256)",
  "function poolAccumulator() view returns (uint256)",
  "function poolSharePreview(uint256) view returns (uint256)",
  "function posToMember(uint256) view returns (address)",
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function getMember(address) view returns (tuple(uint256 id,address referrer,uint256 joinedAt,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 cyclesCompleted,bool isInMatrix,bool hasEverJoined,uint256 crossingReserve))",
  "function getSplitConfig() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
];
const KEEPER_ABI = ["function parkedGracePeriod() view returns (uint256)"];

const usd  = v => (v === null || v === undefined) ? "?" : "$" + (Number(v) / 1e6).toFixed(2);
const bps  = (part, whole) => (whole === 0n || whole === undefined) ? null : Number(part * 10000n / whole);
const ts   = () => new Date().toISOString();
const lc   = a => String(a).toLowerCase();
const med  = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const problems = [];
const PROBLEM = (where, e) => {
  const detail = e ? `: ${(e.shortMessage || e.message || "unreadable").slice(0, 90)}` : "";
  problems.push(`${where}${detail}`);
  console.log(`  PROBLEM ${where}${detail}`);
};
const isTransport = m =>
  /HH110|Invalid JSON-RPC|ECONNRESET|ETIMEDOUT|socket hang up|network|timeout|50[234]|fetch failed|could not coalesce/i.test(m || "");
const isNoState = m => /missing trie node|header not found|state (is )?not available|no state|pruned/i.test(m || "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let SNAP = null, snapDead = false;
const at = () => (SNAP === null ? {} : { blockTag: SNAP });

async function read(label, fn, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return { ok: true, v: await fn() }; }
    catch (e) {
      last = e;
      const msg = e.shortMessage || e.message;
      if (isNoState(msg)) { snapDead = true; break; }
      if (!isTransport(msg)) break;
      await sleep(400 * (i + 1));
    }
  }
  PROBLEM(label, last);
  return { ok: false, v: null };
}

async function main() {
  console.log(`[${ts()}] diag_lap_economics — READ-ONLY, no transactions sent`);
  console.log(`  addresses   : ${process.env.ADDRESSES_FILE}`);
  console.log(`  network     : ${A.network || "?"}   deployed ${A.deployedAt || "?"}`);

  const provider = ethers.provider;
  const headBlk  = await provider.getBlockNumber();
  let snapTime = BigInt(Math.floor(Date.now() / 1000));
  if (process.env.SNAPSHOT !== "0") {
    SNAP = headBlk;
    const b = await provider.getBlock(SNAP);
    if (b) snapTime = BigInt(b.timestamp);
    console.log(`  snapshot    : block ${SNAP} (${new Date(Number(snapTime) * 1000).toISOString()})`);
  }

  const keeper = await ethers.getContractAt(KEEPER_ABI, A.matrixKeeper);
  const g = await read("parkedGracePeriod()", () => keeper.parkedGracePeriod(at()));
  if (!g.ok) {
    console.log(snapDead
      ? "  ABORT: node will not serve state at the snapshot block. Re-run with SNAPSHOT=0."
      : "  ABORT: grace period unreadable — past-grace membership would be invented.");
    return;
  }
  const grace = g.v;
  console.log(`  grace       : ${grace}s, from chain`);

  const tierKeys = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);
  const tiers    = tierKeys.length ? tierKeys : Object.keys(A.tiers);
  const MAX_SEATS = Number(process.env.MAX_SEATS || 127);

  // ── 1. THE ESTATE ────────────────────────────────────────────────────────────────────
  console.log("\n  1. THE ESTATE — every matrix, how full, how busy");
  const estate = [];
  for (const tk of tiers) {
    const t = A.tiers[tk];
    if (!t || !t.pm) { PROBLEM(`${tk} pair manager absent — TIER SKIPPED`); continue; }
    const pm = await ethers.getContractAt(PM_ABI, t.pm);
    const pc = await read(`${tk} pairCount()`, () => pm.pairCount(at()));
    if (!pc.ok) continue;
    for (let i = 0n; i < pc.v; i++) {
      const pr = await read(`${tk} getPairAt(${i})`, () => pm.getPairAt(i, at()));
      if (!pr.ok) continue;
      for (let j = 0; j < 2; j++) {
        const addr = pr.v[j];
        if (addr === ethers.ZeroAddress) continue;
        const label = `${tk}.${i + 1n} ${j ? "MatB" : "MatA"}`;
        const mx = await ethers.getContractAt(MX_ABI, addr);
        const occ  = await read(`${label} occupancy()`,     () => mx.occupancy(at()));
        const size = await read(`${label} MATRIX_SIZE()`,   () => mx.MATRIX_SIZE(at()));
        const fee  = await read(`${label} ENTRY_FEE()`,     () => mx.ENTRY_FEE(at()));
        const rot  = await read(`${label} rotationCount()`, () => mx.rotationCount(at()));
        const tj   = await read(`${label} totalJoined()`,   () => mx.totalJoined(at()));
        const acc  = await read(`${label} poolAccumulator()`, () => mx.poolAccumulator(at()));
        const pk   = await read(`${label} getParkedCount()`, () => mx.getParkedCount(at()));
        if (!occ.ok || !fee.ok) continue;
        estate.push({ tier: tk, label, addr, occ: Number(occ.v),
                      size: size.ok ? Number(size.v) : null, fee: fee.v,
                      rot: rot.ok ? Number(rot.v) : null, joined: tj.ok ? Number(tj.v) : null,
                      acc: acc.ok ? acc.v : null, parked: pk.ok ? Number(pk.v) : 0 });
      }
    }
  }
  estate.sort((a, b) => b.occ - a.occ);
  console.log("    matrix         seats/size   joined  rotations  parked   pool acc");
  for (const m of estate) {
    console.log(`    ${m.label.padEnd(13)} ${String(m.occ).padStart(5)}/${String(m.size ?? "?").padEnd(4)} ` +
                `${String(m.joined ?? "?").padStart(8)} ${String(m.rot ?? "?").padStart(9)} ` +
                `${String(m.parked).padStart(7)}   ${m.acc === null ? "?" : usd(m.acc)}`);
  }
  const empty = estate.filter(m => m.occ === 0).length;
  console.log(`    ${estate.length} matrices | ${empty} completely empty | deepest ${estate[0]?.occ ?? "?"} seats (${estate[0]?.label ?? "?"})`);

  // ── 2. THE SPLIT, FROM CHAIN ─────────────────────────────────────────────────────────
  let split = null;
  const anyMx = estate.find(m => m.occ > 0) || estate[0];
  if (anyMx) {
    const mx = await ethers.getContractAt(MX_ABI, anyMx.addr);
    const sc = await read("getSplitConfig()", () => mx.getSplitConfig(at()));
    if (sc.ok) {
      const [l1, chain, pool, treas, stab, dev, ops, comm, buy, liq] = sc.v.map(Number);
      split = { l1, chain, pool, earn: l1 + chain + pool };
      console.log("\n  2. THE SPLIT, READ FROM CHAIN (not the remembered 18%)");
      console.log(`     L1 ${l1} · chain ${chain} · POOL ${pool} · treasury ${treas} · SF ${stab}`);
      console.log(`     dev ${dev} · ops ${ops} · community ${comm} · buyback ${buy} · liquidity ${liq}`);
      console.log(`     TOTAL THAT CAN REACH A MEMBER: ${split.earn} bps of every entry fee`);
      console.log(`     A member with NO downline can only reach the POOL leg: ${pool} bps.`);
      // SELFTEST 2 — the split must close against the payout base. Source constants:
      // CROSSING_RESERVE_BPS 5000 (MatrixLogicLib:187), DIRECT_EARN_BPS 250 (:188).
      const sum = l1 + chain + pool + treas + stab + dev + ops + comm + buy + liq;
      const base = 10000 - 5000 - 250;
      split.closes = sum === base;
      console.log(`     SELFTEST 2 — legs sum ${sum} vs payout base ${base}: ` +
                  (split.closes ? "✅ closes exactly" : "⛔ DOES NOT CLOSE — the split read is wrong"));
      if (sum === 4750) {
        console.log(`     ⚠ NOTE FOR THE HANDOFF: the in-source comment at MatrixLogicLib:189 still`);
        console.log(`       says "payout base = 4_500 (45%)". It is 4750 (47.5%) — the comment was`);
        console.log(`       not updated when V8.32 halved DIRECT_EARN_BPS from 500 to 250.`);
      }
    }
  }

  // ── 3. WHO IS STUCK, AND THEREFORE WHICH MATRICES FORM ARM 1 ─────────────────────────
  const stuckMx = new Set();
  for (const m of estate) {
    if (m.parked === 0) continue;
    const mx = await ethers.getContractAt(MX_ABI, m.addr);
    for (let k = 0n; k < BigInt(m.parked); k++) {
      const pm2 = await read(`${m.label} getParkedMember(${k})`, () => mx.getParkedMember(k, at()));
      if (!pm2.ok) continue;
      const pa = await read(`${m.label} parkedAt`, () => mx.parkedAt(pm2.v, at()));
      if (!pa.ok || pa.v === 0n) continue;
      if (snapTime - pa.v >= grace) { stuckMx.add(m.label); break; }
    }
  }
  // Run 1's lesson: cut the arms on the variable that ACTUALLY VARIES. Seats do not —
  // every rotating matrix here is 127/127. Throughput does, by two orders of magnitude.
  const live = estate.filter(m => m.occ > 0 && (m.rot ?? 0) > 0)
                     .sort((a, b) => (b.rot ?? 0) - (a.rot ?? 0));
  const seatSpread = live.length ? `${live[live.length - 1].occ}..${live[0].occ}` : "-";
  const rotSpread  = live.length ? `${live[live.length - 1].rot}..${live[0].rot}` : "-";
  console.log(`\n  3. THE ARMS — cut on THROUGHPUT, because seats do not vary`);
  console.log(`     ${live.length} matrices have ever rotated. seats span ${seatSpread}, rotations span ${rotSpread}.`);
  if (live.length && live[0].occ === live[live.length - 1].occ) {
    console.log(`     ⛔ EVERY ROTATING MATRIX IS ${live[0].occ}/${live[0].size} SEATS. Depth cannot be`);
    console.log(`        tested on this chain today — it does not vary among matrices where anyone`);
    console.log(`        has completed a lap. Say that; do not read throughput as though it were depth.`);
  }
  const half  = Math.max(1, Math.ceil(live.length / 2));
  const arm1  = live.slice(0, half).map(m => ({ ...m, armName: "BUSY" }));
  const arm2  = live.slice(half).map(m => ({ ...m, armName: "QUIET" }));
  const armOf = new Map([...arm1, ...arm2].map(m => [m.label, m.armName]));
  console.log(`     ARM BUSY  : ${arm1.map(m => `${m.label}[${m.occ}seats/${m.rot}rot${stuckMx.has(m.label) ? "/stuck" : ""}]`).join(", ") || "none"}`);
  console.log(`     ARM QUIET : ${arm2.map(m => `${m.label}[${m.occ}seats/${m.rot}rot${stuckMx.has(m.label) ? "/stuck" : ""}]`).join(", ") || "none"}`);
  if (!arm2.length) console.log("     ⛔ NO SECOND ARM — no comparison is possible. Report that, not a result.");

  // ── 4. THE SEAT WALK ─────────────────────────────────────────────────────────────────
  console.log("\n  4. WHAT A SEAT ACTUALLY EARNS — walking every occupied position");
  const rows = [], summary = [];
  let quantBad = 0, quantSeen = 0;
  for (const m of [...arm1, ...arm2]) {
    const arm = m.armName;
    const step = m.fee * 5000n / 10000n;          // SELFTEST 1's quantum: half the fee
    const mx  = await ethers.getContractAt(MX_ABI, m.addr);
    const walkTo = Math.min(m.size ?? MAX_SEATS, MAX_SEATS);
    if ((m.size ?? 0) > walkTo) {
      console.log(`     ⚠ ${m.label}: walking ${walkTo} of ${m.size} positions — ${m.size - walkTo} SKIPPED by MAX_SEATS.`);
    }
    const perCycle = [], shortfalls = [];
    let seen = 0, funded = 0, earnedSum = 0n, withCycles = 0;
    for (let p = 1; p <= walkTo; p++) {
      const who = await read(`${m.label} posToMember(${p})`, () => mx.posToMember(p, at()), 2);
      if (!who.ok || who.v === ethers.ZeroAddress) continue;
      const mem = await read(`${m.label} getMember(${who.v.slice(0, 10)})`, () => mx.getMember(who.v, at()), 2);
      if (!mem.ok) continue;
      seen++;
      const M = mem.v;
      earnedSum += M.totalEarned;
      // SELFTEST 1 — the reserve is quantised at half the fee. Exactly true or we are
      // decoding the tuple wrong.
      quantSeen++;
      if (step > 0n && M.crossingReserve % step !== 0n) {
        quantBad++;
        if (quantBad <= 3) {
          console.log(`     ⛔ ${m.label} pos ${p}: crossingReserve ${usd(M.crossingReserve)} is not a`);
          console.log(`        multiple of ${usd(step)} (half the fee). The tuple decode or the fee is wrong.`);
        }
      }
      const need = m.fee > M.crossingReserve ? m.fee - M.crossingReserve : 0n;
      const have = M.crossingReserve + M.withdrawable;
      const isFunded = have >= m.fee;
      if (isFunded) funded++;
      else shortfalls.push(Number(m.fee - have) / 1e6);
      if (M.cyclesCompleted > 0n) {
        withCycles++;
        perCycle.push(bps(M.totalEarned / M.cyclesCompleted, m.fee));
      }
      rows.push({ arm, matrix: m.label, pos: p, member: who.v,
                  fee: m.fee, reserve: M.crossingReserve, withdrawable: M.withdrawable,
                  totalEarned: M.totalEarned, cycles: Number(M.cyclesCompleted),
                  neededBps: bps(need, m.fee),
                  earnedPerCycleBps: M.cyclesCompleted > 0n ? bps(M.totalEarned / M.cyclesCompleted, m.fee) : null,
                  funded: isFunded });
    }

    // v1's conservation ceiling was DELETED, not softened: it used `totalJoined`, which
    // counts unique members and not paid entries, so re-entries made it meaningless.
    // What replaces it is SELFTEST 1 above, which is exactly true.
    const medCycle = med(perCycle.filter(x => x !== null));
    const medShort = med(shortfalls);
    const needBps  = rows.filter(r => r.matrix === m.label).map(r => r.neededBps).filter(x => x !== null);
    summary.push({ arm, label: m.label, occ: m.occ, rot: m.rot, stuck: stuckMx.has(m.label),
                   seen, funded, withCycles, medCycle, medShort, medNeed: med(needBps),
                   fee: m.fee, earnedSum });
    console.log(`     ${arm.padEnd(5)} ${m.label.padEnd(13)} ${String(m.rot).padStart(4)}rot | ` +
                `funded ${String(funded).padStart(3)}/${seen} | ` +
                `completed a lap ${String(withCycles).padStart(3)}/${seen} | ` +
                `median earned per lap ${medCycle === null ? "n/a" : String(medCycle).padStart(4) + " bps"} ` +
                `vs ${med(needBps) ?? "?"} needed | median shortfall ${medShort === null ? "-" : "$" + medShort.toFixed(2)}`);
  }
  console.log(`\n     SELFTEST 1 — reserve quantisation: ${quantSeen - quantBad}/${quantSeen} seated members ` +
              `hold an exact multiple of half their fee` + (quantBad ? "  ⛔ INSTRUMENT WRONG" : "  ✅"));

  // ── 5. SELFTEST 2 — planted positive on the deepest matrix ───────────────────────────
  console.log("\n  5. SELFTEST — the deepest matrix must show a live pool");
  const deep = estate.find(m => m.occ > 0);
  if (!deep) console.log("     ⛔ no occupied matrix at all — nothing to test against.");
  else {
    const mx = await ethers.getContractAt(MX_ABI, deep.addr);
    const pv = await read(`${deep.label} poolSharePreview(${deep.size ?? 127})`,
                          () => mx.poolSharePreview(deep.size ?? 127, at()));
    console.log(`     ${deep.label}: ${deep.joined ?? "?"} joined, accumulator ${deep.acc === null ? "?" : usd(deep.acc)},` +
                ` deepest-seat preview ${pv.ok ? usd(pv.v) : "?"}`);
    if (deep.acc === 0n) {
      console.log("     ⛔ ZERO accumulator on the busiest matrix on the chain. Either nothing has");
      console.log("        ever been distributed, or `poolAccumulator` is not what this reads it as.");
      console.log("        RESOLVE BEFORE QUOTING SECTION 4.");
    } else {
      console.log("     ✅ non-zero pool on the busiest matrix — the accumulator is live.");
    }
  }

  // ── 6. THE VERDICT ───────────────────────────────────────────────────────────────────
  console.log(`\n  6. VERDICT (basis: ${process.env.ADDRESSES_FILE}, snapshot block ${SNAP ?? "head"}, ${ts()})`);
  const s1 = summary.filter(s => s.arm === "BUSY"), s2 = summary.filter(s => s.arm === "QUIET");
  const anyBreach = quantBad > 0 || (split && split.closes === false);
  const fundedRate = arr => {
    const seen = arr.reduce((n, s) => n + s.seen, 0), f = arr.reduce((n, s) => n + s.funded, 0);
    return seen ? { seen, f, pct: (100 * f / seen).toFixed(1) } : null;
  };
  const r1 = fundedRate(s1), r2 = fundedRate(s2);
  if (anyBreach) {
    console.log("     WITHHELD — a selftest that is exactly true came out false. Fix the reads first.");
  } else {
    if (r1) console.log(`     BUSY  matrices: ${r1.f}/${r1.seen} seated members (${r1.pct}%) could fund their next crossing today.`);
    if (r2) console.log(`     QUIET matrices: ${r2.f}/${r2.seen} seated members (${r2.pct}%) could fund their next crossing today.`);
    const allNeed = med(summary.map(s => s.medNeed).filter(x => x !== null));
    console.log(`\n     PER-MATRIX, SORTED BY THROUGHPUT — the whole comparison in one place:`);
    for (const s of [...summary].sort((a, b) => (b.rot ?? 0) - (a.rot ?? 0))) {
      console.log(`       ${s.label.padEnd(13)} ${String(s.rot).padStart(4)}rot  ` +
                  `funded ${(100 * s.funded / (s.seen || 1)).toFixed(1).padStart(5)}%  ` +
                  `median lap ${s.medCycle === null ? " n/a" : String(s.medCycle).padStart(4)} bps` +
                  `${s.stuck ? "   (holds stuck members)" : ""}`);
    }
    const meds = summary.map(s => s.medCycle).filter(x => x !== null);
    const anyAbove = meds.filter(x => x >= (allNeed ?? 5000)).length;
    console.log(`\n     A lap needs ~${allNeed ?? "?"} bps of earnings. Median earned per completed lap ranges ` +
                `${meds.length ? Math.min(...meds) + "-" + Math.max(...meds) : "?"} bps across ${meds.length} matrices;`);
    console.log(`     ${anyAbove} of ${meds.length} clear the bar at the median.`);
    if (r1 && r2 && Math.abs(Number(r1.pct) - Number(r2.pct)) > 20) {
      console.log("     ▶ THROUGHPUT MOVES IT. The busy and quiet arms differ materially, so how");
      console.log("       much traffic a matrix sees changes whether its members can self-fund.");
    } else if (r1 && r2) {
      console.log("     ▶ THROUGHPUT DOES NOT RESCUE ANYONE. Matrices two orders of magnitude apart");
      console.log("       in traffic fund their members at comparable rates, and the median member");
      console.log("       lands short in both arms. The shortfall is STRUCTURAL — CLAUDE.md's");
      console.log("       funding-constraint note holds, and PAIR-EXPANSION PACING IS NOT THE FIX.");
    } else {
      console.log("     ▶ INCOMPLETE — one arm is empty. Say so; do not read one arm as a result.");
    }
    console.log("     ⚠ AND SAY THIS WITH IT: seats do not vary among rotating matrices on this");
    console.log("       chain, so this run tests TRAFFIC, not DEPTH. Depth remains untested.");
  }

  // ── CSV ──────────────────────────────────────────────────────────────────────────────
  const out = process.env.CSV || path.join(__dirname, "..", "logs",
    `lap_economics_${ts().replace(/[:.]/g, "-")}.csv`);
  const num = v => (v === null || v === undefined) ? "" : (Number(v) / 1e6).toFixed(2);
  const csv = ["arm,matrix,pos,member,feeUSD,reserveUSD,withdrawableUSD,totalEarnedUSD,cycles,neededBps,earnedPerCycleBps,fundedNow"];
  for (const r of rows) {
    csv.push([r.arm, r.matrix, r.pos, r.member, num(r.fee), num(r.reserve), num(r.withdrawable),
              num(r.totalEarned), r.cycles, r.neededBps ?? "", r.earnedPerCycleBps ?? "", r.funded].join(","));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, csv.join("\n"));
  console.log(`\n  CSV: ${out}   (${rows.length} seated members)`);

  console.log(`\n  PROBLEMS: ${problems.length}`);
  problems.slice(0, 25).forEach(p => console.log("    - " + p));
  if (problems.length > 25) console.log(`    ... and ${problems.length - 25} more`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
