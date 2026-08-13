// model_reserve_bps.js — THE COST SIDE of the CROSSING_RESERVE_BPS decision (V8.48 parked loop).
//
// WHY THIS EXISTS (owner decision 2026-08-13, via picker):
//   diag_parked_truth.js produced the BENEFIT side — a static lift table showing +20
//   reserve points would lift 49% of parked members over the self-funding line. That
//   table is wrong in a specific way: it moves today's balances over a moved line,
//   but the points a bigger reserve takes come OUT of the very splits that produced
//   those balances. Raise the reserve and every member EARNS LESS per cycle, so the
//   line moves and the population moves toward it at the same time. This script
//   models both sides together, per candidate value.
//
// THE PLUMBING, VERIFIED AGAINST SOURCE 2026-08-13 (re-verify if MatrixLogicLib changes):
//   _distributePayments (MatrixLogicLib.sol:922) carves every entry fee as:
//     CROSSING_RESERVE_BPS = 5_000  hardcoded constant :187 -> member's own crossingReserve
//     DIRECT_EARN_BPS      =   250  hardcoded constant :188 -> instant earnings to the entrant
//     the SplitConfig BPS array (sum 4_750, of the FULL fee, V8.32 model), live values
//     read back per matrix via getSplitConfig():
//       l1 500 · chain 1350 · pool 1800 · treasury 500 · sf 300 · dev 100 · ops 50
//       · community 100 · buyback 25 · liquidity 25       (deploy_v8.js SPLITS_ALL, V8.47)
//   MEMBER-facing money per entry  = direct 250 + l1 500 + chain 1350 + pool 1800 = 3_900
//   PROTOCOL money per entry       = treasury 500 + sf 300 + dev 100 + ops 50
//                                    + community 100 + buyback 25 + liquidity 25  =   850
//   Identity: splits 4_750 + direct 250 + reserve 5_000 = 10_000 (member 3_900 counts
//   the 250 direct plus 3_650 of the splits; protocol 850 is the rest of the splits).
//
// THE MODEL (assumptions stated once, loudly):
//   A candidate reserve R (bps) leaves 10_000 - R - 250 bps for the splits. We assume
//   PRO-RATA rescale: every SplitConfig entry scales by  s = (9_750 - R) / 4_750.
//   DIRECT_EARN_BPS stays 250 (it is a separate constant; nothing forces it to move).
//   A member's per-cycle earnings scale with the member-facing splits, so their
//   measured earnings ratio e = withdrawable/fee scales to e*s under the new regime.
//     - self-funded at cycle-out  iff  R/10_000 + e*s >= 1
//     - otherwise the SF loan per cycle is  g = fee * (1 - R/10_000 - e*s), and per
//       the repayment mechanics (loan repays first from next earnings) the member's
//       debt GROWS by g every cycle, forever. There is no middle band: converge or
//       compound. (System-level "exponential" = this linear per-member growth times
//       an accelerating park rate.)
//   CONSERVATIVE BIAS, deliberate: measured e comes from parked members whose
//   withdrawable froze AFTER past loan repayments were taken out of it, so e
//   understates gross per-cycle earnings and the DYNAMIC lift shares printed here
//   are floors, not midpoints.
//
// WHAT THIS DOES NOT MODEL (do not quote it as if it did):
//   behavioural response (members upgrading/leaving), pool-share timing, orphan
//   routing to accountOne, the existing $7.3k debt book (this is the steady state
//   AFTER items 46/47 clear it), and epoch/mint effects — though note: item 4 caps
//   mintReward at the treasury deposit, so a smaller treasury split ALSO means
//   smaller mints per seat; the floor stays protected by construction, it just
//   grows slower.
//
// STRICT READS ONLY. After model_epoch_policy.js v1 (a wrong selector behind a
// value fallback fabricated the answer it was asked to test): every read either
// succeeds, retries a transient error, or KILLS the run with the failing label.
// No .catch(() => value) anywhere in this file, ever.
//
// Run (owner, Windows, contracts repo):
//   npx hardhat run scripts/model_reserve_bps.js --network baseSepolia
// Env:
//   ECON_SAMPLE=25   parked members sampled per matrix (evenly spaced, not the ends)
//   TIERS=1,2        restrict tiers (default all configured)
//   CANDIDATES=5000,5500,6000,6500,7000,7500   reserve bps candidates
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const KEEPER = [
  "function configuredTierCount() view returns (uint8)",
  "function pairManagerForTier(uint8) view returns (address)",
];
const PM = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function isParked(address) view returns (bool)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function getSplitConfig() view returns (uint256 l1Bps, uint256 chainBps, uint256 poolBps, uint256 treasuryBps, uint256 stabilityBps, uint256 devBps, uint256 opsBps, uint256 communityBps, uint256 buybackBps, uint256 liquidityBps)",
];

const BPS = 10_000;
const DIRECT_BPS = 250;          // MatrixLogicLib.sol:188 — pinned by the identity check below
const RESERVE_BPS_LIVE = 5_000;  // MatrixLogicLib.sol:187 — pinned by the identity check below
const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";

// strict read: retry transient failures, then DIE with the label. Never a default.
async function strict(label, fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  console.error(`\nFATAL: read failed after ${tries} attempts: ${label}`);
  console.error("This model refuses to substitute a value for a failed read.");
  throw last;
}

async function main() {
  const p = ethers.provider;
  const k = new ethers.Contract(A.matrixKeeper, KEEPER, p);
  const ECON_SAMPLE = Number(process.env.ECON_SAMPLE || 25);
  const only = process.env.TIERS ? process.env.TIERS.split(",").map((s) => Number(s.trim())) : null;
  const CANDIDATES = (process.env.CANDIDATES || "5000,5500,6000,6500,7000,7500")
    .split(",").map((s) => Number(s.trim()));

  console.log("\n== PART 0 — PLUMBING CHECK (live chain, every matrix) ==");
  // Collect matrices per tier; verify every matrix carries the same splits and that
  // splits + reserve + direct == 10_000. getSplitConfig existing on live V8.47 is
  // itself unproven until this runs — if it reverts everywhere, the model CANNOT run
  // and says so, rather than proceeding on deploy_v8.js's declared values.
  const n = Number(await strict("configuredTierCount", () => k.configuredTierCount()));
  let splits = null; // [l1, chain, pool, treasury, sf, dev, ops, cw, bbr, lq]
  const tiers = []; // {t, fee, matrices: [{addr, lbl, parked}]}
  for (let t = 0; t < n; t++) {
    if (only && !only.includes(t + 1)) continue;
    const pmAddr = await strict(`pairManagerForTier(${t})`, () => k.pairManagerForTier(t));
    if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pmAddr, PM, p);
    const pc = Number(await strict(`T${t + 1} activePairCount`, () => pm.activePairCount()));
    const rec = { t, fee: 0n, matrices: [] };
    for (let i = 0; i < pc; i++) {
      const [a, b] = await strict(`T${t + 1} getPairAt(${i})`, () => pm.getPairAt(i));
      for (const [lbl, m] of [[`p${i}A`, a], [`p${i}B`, b]]) {
        if (!m || m === ethers.ZeroAddress) continue;
        const mx = new ethers.Contract(m, MX, p);
        const sc = await strict(`T${t + 1} ${lbl} getSplitConfig`, () => mx.getSplitConfig());
        const arr = [sc.l1Bps, sc.chainBps, sc.poolBps, sc.treasuryBps, sc.stabilityBps,
                     sc.devBps, sc.opsBps, sc.communityBps, sc.buybackBps, sc.liquidityBps].map(Number);
        if (splits === null) splits = arr;
        else if (splits.some((v, j) => v !== arr[j])) {
          throw new Error(`SplitConfig differs at T${t + 1} ${lbl}: [${arr}] vs [${splits}] — per-tier splits exist; this model assumed one config. Extend it before trusting any number it prints.`);
        }
        rec.fee = await strict(`T${t + 1} ${lbl} ENTRY_FEE`, () => mx.ENTRY_FEE());
        rec.matrices.push({ addr: m, lbl });
      }
    }
    if (rec.matrices.length) tiers.push(rec);
  }
  if (!splits) throw new Error("No matrices found — nothing to model.");
  const splitSum = splits.reduce((x, y) => x + y, 0);
  console.log(`  splits (identical across ${tiers.reduce((c, r) => c + r.matrices.length, 0)} matrices):`);
  console.log(`    l1 ${splits[0]} · chain ${splits[1]} · pool ${splits[2]} · treasury ${splits[3]} · sf ${splits[4]}`);
  console.log(`    dev ${splits[5]} · ops ${splits[6]} · community ${splits[7]} · buyback ${splits[8]} · liquidity ${splits[9]}   sum ${splitSum}`);
  if (splitSum + RESERVE_BPS_LIVE + DIRECT_BPS !== BPS) {
    throw new Error(`Identity broken: splits ${splitSum} + reserve ${RESERVE_BPS_LIVE} + direct ${DIRECT_BPS} != 10000. The library constants are not what this file claims — re-read MatrixLogicLib:187-188 before trusting anything here.`);
  }
  console.log(`  identity OK: ${splitSum} + ${RESERVE_BPS_LIVE} (reserve, lib :187) + ${DIRECT_BPS} (direct, lib :188) = 10000`);

  console.log("\n== PART 1 — LIVE PARKED POPULATION (earnings ratio e = withdrawable/fee) ==");
  // Evenly spaced sample per matrix (the diag_parked_truth lesson: the array ends are
  // the oldest and newest entries, not a cross-section). Skip stale entries
  // (isParked false) — they are history, not population.
  for (const rec of tiers) {
    rec.e = [];       // earnings ratio per sampled member (0..1+)
    rec.parked = 0;
    for (const { addr, lbl } of rec.matrices) {
      const mx = new ethers.Contract(addr, MX, p);
      const cnt = Number(await strict(`T${rec.t + 1} ${lbl} getParkedCount`, () => mx.getParkedCount()));
      rec.parked += cnt;
      if (cnt === 0) continue;
      const want = Math.min(ECON_SAMPLE, cnt);
      const idxs = new Set();
      for (let j = 0; j < want; j++) idxs.add(Math.floor((j * cnt) / want));
      for (const q of idxs) {
        const mem = await strict(`T${rec.t + 1} ${lbl} getParkedMember(${q})`, () => mx.getParkedMember(q));
        if (!mem || mem === ethers.ZeroAddress) continue;
        const live = await strict(`isParked(${mem.slice(0, 10)})`, () => mx.isParked(mem));
        if (!live) continue; // stale array entry — not population
        const wd = await strict(`withdrawableOf(${mem.slice(0, 10)})`, () => mx.withdrawableOf(mem));
        const rs = await strict(`crossingReserveOf(${mem.slice(0, 10)})`, () => mx.crossingReserveOf(mem));
        rec.e.push(Number((wd * 10000n) / rec.fee) / 10000);
        // sanity: reserve should sit at ~RESERVE_BPS_LIVE/BPS of fee for a parked member
        const rp = Number((rs * 10000n) / rec.fee) / 10000;
        (rec.rsPct ??= []).push(rp);
      }
    }
    if (rec.e.length) {
      const srt = [...rec.e].sort((x, y) => x - y);
      const med = srt[Math.floor(srt.length / 2)];
      const rsAvg = rec.rsPct.reduce((x, y) => x + y, 0) / rec.rsPct.length;
      console.log(`  T${rec.t + 1}  fee ${usd(rec.fee)}  parked ${String(rec.parked).padStart(4)}  sampled ${String(rec.e.length).padStart(3)}  e median ${pct(med)}  reserve avg ${pct(rsAvg)} (expect ~${pct(RESERVE_BPS_LIVE / BPS, 0)})`);
    } else {
      console.log(`  T${rec.t + 1}  fee ${usd(rec.fee)}  parked ${String(rec.parked).padStart(4)}  sampled 0 — excluded from population figures`);
    }
  }
  const all = tiers.flatMap((r) => r.e.map((e) => ({ t: r.t, e, fee: r.fee })));
  if (!all.length) throw new Error("Sampled nobody — model has no population to stand on.");
  const totalParked = tiers.reduce((c, r) => c + r.parked, 0);
  console.log(`  population: ${all.length} sampled of ${totalParked} live queue entries`);

  console.log("\n== PART 2 — PER-CANDIDATE TABLE (pro-rata rescale, s = (9750 - R) / 4750) ==");
  console.log("  Per $100 of entry fee. MEMBER = direct + l1 + chain + pool. PROTOCOL = the rest.");
  console.log("  DYNAMIC lift uses e*s (new-regime earnings); STATIC is diag_parked_truth's old table.");
  const rows = [];
  for (const R of CANDIDATES) {
    const s = (BPS - R - DIRECT_BPS) / splitSum;
    const d = (bps) => ((bps * s) / 100).toFixed(2).padStart(6);
    const memberPer100 = (DIRECT_BPS / 100) + (splits[0] + splits[1] + splits[2]) * s / 100;
    const protoPer100 = (splits[3] + splits[4] + splits[5] + splits[6] + splits[7] + splits[8] + splits[9]) * s / 100;

    // Lift + debt dynamics. Per-tier means first, then aggregated WEIGHTED BY LIVE
    // QUEUE COUNTS — the sample is capped per matrix, so raw sample shares would
    // misweight the tiers (T2/T3 dominate the real queue).
    let liftDynW = 0, liftStatW = 0, gW = 0, sfW = 0, wSum = 0;
    for (const rec of tiers) {
      if (!rec.e.length || rec.parked === 0) continue;
      const feeUsd = Number(rec.fee) / 1e6;
      let ld = 0, ls = 0, gT = 0;
      for (const e of rec.e) {
        const eNew = e * s;
        if (R / BPS + eNew >= 1) ld++;
        if (R / BPS + e >= 1) ls++; // the static table: today's e over the moved line
        gT += Math.max(0, 1 - R / BPS - eNew) * feeUsd;
      }
      const w = rec.parked;
      liftDynW += (ld / rec.e.length) * w;
      liftStatW += (ls / rec.e.length) * w;
      gW += (gT / rec.e.length) * w;
      sfW += (splits[4] * s / BPS) * feeUsd * w;
      wSum += w;
    }
    const liftDyn = liftDynW / wSum, liftStat = liftStatW / wSum;
    const gAvg = gW / wSum, sfAvg = sfW / wSum;
    rows.push({ R, s, liftDyn, liftStat, gAvg, sfAvg, memberPer100, protoPer100 });

    console.log(`\n  R = ${R} (${pct(R / BPS, 0)} reserve)   scale s = ${s.toFixed(3)}${R === RESERVE_BPS_LIVE ? "   << TODAY" : ""}`);
    console.log(`    member $/100: direct  2.50  l1 ${d(splits[0])}  chain ${d(splits[1])}  pool ${d(splits[2])}   = $${memberPer100.toFixed(2)}`);
    console.log(`    protocol $/100: treasury ${d(splits[3])}  sf ${d(splits[4])}  buyback ${d(splits[8])}  dev+ops ${d(splits[5] + splits[6])}  cw ${d(splits[7])}  lq ${d(splits[9])}   = $${protoPer100.toFixed(2)}`);
    console.log(`    self-funded at cycle-out (queue-weighted): DYNAMIC ${pct(liftDyn, 0)}   [static table said ${pct(liftStat, 0)}]`);
    console.log(`    mean SF loan per cycle-out $${gAvg.toFixed(2)} vs SF inflow per entry $${sfAvg.toFixed(2)}${gAvg > sfAvg ? "  — loans outrun inflow; repayments reshuffle WHEN, not WHETHER" : ""}`);
  }

  console.log("\n== PART 3 — READING IT ==");
  console.log("  Per-member law (from the repayment mechanics): a parked-loop member either");
  console.log("  clears the line (R/10000 + e*s >= 1, debt -> 0) or their debt grows by");
  console.log("  fee*(1 - R/10000 - e*s) EVERY cycle, forever. Item 46's floor decides what");
  console.log("  happens to the second group; this table decides how big that group is.");
  console.log("\n  R      dyn-lift  static  mean-loan/cycle  sf-in/entry  member$/100  protocol$/100");
  for (const r of rows) {
    console.log(`  ${String(r.R).padEnd(6)} ${pct(r.liftDyn, 0).padStart(6)}  ${pct(r.liftStat, 0).padStart(6)}  ${("$" + r.gAvg.toFixed(2)).padStart(12)}  ${("$" + r.sfAvg.toFixed(2)).padStart(10)}  ${("$" + r.memberPer100.toFixed(2)).padStart(10)}  ${("$" + r.protoPer100.toFixed(2)).padStart(12)}`);
  }
  console.log("\n  Remember the bias: e is net of past loan repayments, so dynamic lift is a");
  console.log("  FLOOR. And remember what is NOT here: behaviour, the existing debt book,");
  console.log("  pool timing, orphan routing. Decision inputs, not a verdict.");
  console.log("\n  Governability: CROSSING_RESERVE_BPS is a hardcoded library constant today");
  console.log("  (MatrixLogicLib:187). Whether V8.48 makes it a governed parameter is part of");
  console.log("  the same owner decision this table informs.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
