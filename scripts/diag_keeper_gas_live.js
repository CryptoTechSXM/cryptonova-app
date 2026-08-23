// diag_keeper_gas_live.js — what does a keeper item COST on a real chain? (session 27)
//
// WHY THIS EXISTS
// ---------------
// Every gas figure V8.50 has is MATRIX_SIZE 7 (V8_50_KeeperGas.test.js: SF-funded rescue
// 1.49M median, 1.76M max). LIVE IS 127. The ~2.6M-per-item figure the deploy gate tests
// against is an ESTIMATE carried forward from V8.49, taken before items A and E1 existed,
// so it describes a population that no longer exists. `minGasPerItem` is read OFF THE
// CHAIN at :213 and is never assumed here — it shipped at 5,000,000 and moved to
// 7,500,000 on 2026-08-22 after this tool's own measurement (61 rescues, max 4.58M).
// Nothing in V8.50 has ever run at 127 on a real chain, and no tool measured this.
//
// ⛔ THE FAILURE MODE THIS IS AGAINST, AND WHY IT NEEDS MEASURING RATHER THAN WATCHING.
//    minGasPerItem is checked BEFORE an item is dispatched (MatrixKeeper.sol:798): if the
//    remaining gas is below it the batch emits BatchGasHalted and breaks — visible, clean,
//    and the work is rediscovered next tick. That is the guard WORKING.
//    Set it too LOW and the guard passes, the item starts, and it runs out of gas INSIDE
//    the try/catch — surfacing as WorkItemFailed, which carries a work type and addresses
//    and NO REASON. An out-of-gas rescue and a rescue that reverted for any other cause
//    are the same line in the log. On a community chain that reads as "members are not
//    being rescued", which is also what an ordinary refusal looks like.
//
// THE MEASUREMENT, AND IT IS DELIBERATELY NOT A REGRESSION
// -------------------------------------------------------
// gasUsed is per BATCH, so a mixed batch cannot be attributed item by item without
// solving for the parts — and a fitted number is a model, not a measurement. Instead:
// pin maxItemsPerUpkeep to 1, so every performUpkeep runs exactly ONE item and its
// gasUsed IS that item's cost plus a fixed overhead. The overhead is read off the
// cheapest work type in the same run (a reclaim/ghost is ~0.04M at size 7), so it is
// measured too, never assumed. This is the same trick V8_50_KeeperGas.test.js uses at
// size 7 — which is what makes the two comparable at all.
//
// Run — PHASE G of GO_LIVE_RUNBOOK.md drives this; do not run it freehand:
//   node scripts/diag_keeper_gas_live.js
// Env: FROM=<block> TO=<block>  (default: the whole deployment)  CHUNK=4000
//      ADDRESSES_FILE=deployed_addresses_v8_50_private.json
//      SELFTEST=1   pure aggregation only — no chain, no address book
//
// ⛔ SELFTEST RUNS BEFORE ANY require OF THE ADDRESS BOOK, ON PURPOSE. The aggregation is
//    pure and can be exercised on a machine with no RPC; the chain half cannot be, and is
//    not covered by it. Same split as diag_parked_experiment.js sections 5/6.
"use strict";

if (process.env.SELFTEST === "1") {
  console.log("\n  SELFTEST — diag_keeper_gas_live aggregation (no chain, no address book)\n");
  selftest();
}

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("./rpc_resilience");   // 29.2: Base Sepolia sheds state reads; retry + endpoint fail-over
require("./run_log");   // G.3 measurement transcript -> logs/runs/diag_keeper_gas_live/

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));
const CHUNK = Number(process.env.CHUNK || 4000);

const WORK = {
  0: "VELOCITY", 1: "GHOST", 2: "RECLAIM", 3: "CHAIN_LINK",
  4: "PARKED_RESCUE", 5: "VELOCITY_GATE", 6: "EVICT_PARKED",
};

const KEEPER_ABI = [
  "function performUpkeep(bytes performData) external",
  "function minGasPerItem() view returns (uint256)",
  "function maxItemsPerUpkeep() view returns (uint256)",
  "event BatchGasHalted(uint256 processed, uint256 total, uint256 gasRemaining)",
  "event WorkItemFailed(uint8 indexed workType, uint8 tierIndex, address addr1, address addr2)",
];

/* ═══════════════════════════════════════════════════════════════════════════════
 * PURE AGGREGATION — everything below this line is exercised by SELFTEST
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** Median, lower on even counts. */
function med(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) / 2)];
}

/**
 * Fold a list of decoded upkeep transactions into the table the gate reads.
 *
 * Each row: { gasUsed, types: [workTypeNumber...], halted: {processed,total,gasRemaining}|null,
 *             failed: [workTypeNumber...] }
 *
 * ⛔ SINGLE-ITEM BATCHES ARE THE ONLY ONES THAT PRICE AN ITEM. A mixed batch tells you
 *    what the batch cost and nothing about the parts. Rows with more than one item are
 *    counted and reported so the sample is visible, but they never enter a per-item
 *    figure — the alternative is a fitted number, and 7a rule 1 is the reason not to.
 */
function foldUpkeeps(rows) {
  const perType = {};          // workType -> [gasUsed] from SINGLE-item batches only
  let mixed = 0, empty = 0;
  const halts = [];
  const failures = {};
  // ⛔ ADDED 2026-08-23 (session 31). The count alone was not actionable: G.4 reported
  //    `PARKED_RESCUE = 1` and the handoff then said "the tx is in logs/runs/" — IT WAS
  //    NOT. Nothing in this file printed WHICH transaction failed, so the one item the
  //    whole run existed to catch could not be looked up afterwards. A detector that
  //    says "1" without saying WHERE sends the next session hunting through 200,000
  //    blocks by hand. Keep the tx, the gas it burned, and whether it also halted.
  const failedTxs = [];
  for (const r of rows) {
    if (r.halted) halts.push(r.halted);
    for (const f of r.failed || []) {
      failures[f] = (failures[f] || 0) + 1;
      failedTxs.push({ tx: r.tx, type: f, gasUsed: r.gasUsed,
                       items: (r.types || []).length, halted: r.halted });
    }
    const n = (r.types || []).length;
    if (n === 0) { empty++; continue; }
    if (n > 1)   { mixed++;  continue; }
    const t = r.types[0];
    (perType[t] ||= []).push(r.gasUsed);
  }
  const out = { perType: {}, mixedBatches: mixed, emptyBatches: empty, halts, failures, failedTxs };
  for (const [t, xs] of Object.entries(perType)) {
    out.perType[t] = {
      n: xs.length,
      min: Math.min(...xs),
      median: med(xs),
      max: Math.max(...xs),
    };
  }
  return out;
}

/**
 * The gate's verdict on measurement 1, computed rather than eyeballed.
 *
 * `overhead` is taken from the CHEAPEST observed work type in the same run — the fixed
 * cost of a performUpkeep that does almost nothing. Subtracting it from the dearest item
 * gives the marginal cost of that item.
 *
 * ⚠ RETURNS null RATHER THAN A NUMBER when the run cannot support the claim: no rescue
 *   was ever priced, or no cheap type was seen to measure the overhead with. A verdict
 *   assembled from missing halves is exactly the failure this file exists to avoid.
 */
function gateVerdict(folded, minGasPerItem) {
  const RESCUE = "4";
  const rescue = folded.perType[RESCUE];
  if (!rescue) return { ok: null, why: "no single-item PARKED_RESCUE batch was observed — nothing to price" };
  const cheapCandidates = ["2", "1", "6"].map((t) => folded.perType[t]).filter(Boolean);
  if (!cheapCandidates.length) {
    return { ok: null, why: "no cheap single-item batch (reclaim/ghost/evict) — the fixed overhead is unmeasured" };
  }
  const overhead = Math.min(...cheapCandidates.map((c) => c.min));
  const marginalMax = rescue.max - overhead;
  return {
    ok: marginalMax < minGasPerItem,
    rescueMaxBatch: rescue.max,
    overhead,
    marginalMax,
    minGasPerItem,
    headroom: minGasPerItem - marginalMax,
    why: marginalMax < minGasPerItem
      ? "the dearest rescue observed fits under the guard"
      : "⛔ THE DEAREST RESCUE EXCEEDS minGasPerItem — the guard would let it start and it would die inside",
  };
}

/* ── SELFTEST ─────────────────────────────────────────────────────────────────── */
function selftest() {
  let fails = 0;
  const eq = (got, want, what) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { fails++; console.log(`  FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
    else console.log(`  ok   ${what}`);
  };

  const rows = [
    { gasUsed: 3_100_000, types: [4], halted: null, failed: [] },   // rescue, single
    { gasUsed: 2_900_000, types: [4], halted: null, failed: [] },   // rescue, single
    { gasUsed: 3_500_000, types: [4], halted: null, failed: [] },   // rescue, single (dearest)
    { gasUsed:   140_000, types: [2], halted: null, failed: [] },   // reclaim -> the overhead
    { gasUsed: 9_000_000, types: [4, 4, 6], halted: null, failed: [] },  // mixed: must NOT price
    { gasUsed: 1_000_000, types: [], halted: { processed: 0, total: 5, gasRemaining: 4_900_000 }, failed: [] },
    { gasUsed: 2_000_000, types: [4], halted: null, failed: [4] },
  ];
  const f = foldUpkeeps(rows);
  eq(f.perType["4"].n, 4, "only single-item batches are priced (4 of 5 rescue rows)");
  eq(f.perType["4"].max, 3_500_000, "max rescue is the dearest SINGLE-item batch, not the mixed one");
  eq(f.mixedBatches, 1, "the mixed batch is counted, not silently dropped");
  eq(f.emptyBatches, 1, "a batch that halted before item 0 has no types");
  eq(f.halts.length, 1, "halts are collected");
  eq(f.failures["4"], 1, "WorkItemFailed is tallied by work type");

  const v = gateVerdict(f, 5_000_000);
  eq(v.overhead, 140_000, "overhead comes from the cheapest observed type");
  eq(v.marginalMax, 3_360_000, "marginal cost = dearest rescue batch - overhead");
  eq(v.ok, true, "3.36M marginal fits under a 5M guard");

  const v2 = gateVerdict(f, 3_000_000);
  eq(v2.ok, false, "the same data FAILS a 3M guard — the verdict is not a rubber stamp");

  // The two ways the verdict must refuse to answer rather than guess.
  eq(gateVerdict({ perType: {}, halts: [], failures: {} }, 5e6).ok, null,
     "no rescue priced -> null, never a pass");
  eq(gateVerdict({ perType: { 4: { n: 1, min: 1, median: 1, max: 9e6 } }, halts: [], failures: {} }, 5e6).ok, null,
     "no cheap type -> overhead unmeasured -> null, never a pass");

  console.log(fails ? `\n  ⛔ SELFTEST FAILED (${fails})` : `\n  ✅ SELFTEST PASSED — aggregation exercised; the CHAIN half is not.`);
  process.exit(fails ? 1 : 0);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * CHAIN HALF — not covered by the self-test
 * ═══════════════════════════════════════════════════════════════════════════════ */

const usdGas = (g) => (g === null || g === undefined ? "n/a" : (g / 1e6).toFixed(2) + "M");

async function main() {
  if (!RPC) throw new Error("no RPC — set BASE_SEPOLIA_RPC_URL in .env");
  const provider = new ethers.JsonRpcProvider(RPC);
  const keeperAddr = A.matrixKeeper || A.MatrixKeeper || (A.core && A.core.matrixKeeper);
  if (!keeperAddr) throw new Error("no matrixKeeper in the address file — refusing to guess");
  const keeper = new ethers.Contract(keeperAddr, KEEPER_ABI, provider);
  const iface = new ethers.Interface(KEEPER_ABI);

  const head = await provider.getBlockNumber();
  const from = Number(process.env.FROM || 0) || (head - 200_000);
  const to   = Number(process.env.TO || head);
  const minGas = Number(await keeper.minGasPerItem());
  const cap    = Number(await keeper.maxItemsPerUpkeep());

  console.log(`\n  ${"=".repeat(96)}`);
  console.log(`  KEEPER GAS ON A REAL CHAIN — keeper ${keeperAddr}`);
  console.log(`  blocks ${from}..${to}   minGasPerItem ${usdGas(minGas)}   maxItemsPerUpkeep ${cap}`);
  console.log(`  ${"=".repeat(96)}`);
  if (cap !== 1) {
    console.log(`  ⚠ maxItemsPerUpkeep is ${cap}. Batches with more than one item CANNOT price an`);
    console.log(`    item and are reported separately.`);
    // ⛔⛔ CORRECTED 2026-08-23 (session 31). This block used to read "DO NOT try to set
    //    the cap to 1 — setMaxItemsPerUpkeep accepts 5|10|15|20|30|40 and reverts on
    //    anything else (handoff 27.5)". THAT IS NO LONGER TRUE and it now points the
    //    wrong way: 1 and 2 were ADDED to the menu on 2026-08-22 (30.10a), and cap 1 is
    //    the SHIPPED configuration and the guard the whole gas design rests on (30.10b).
    //    A warning that survived the change it was warning about would have told the next
    //    session the shipped default is impossible.
    console.log(`    ▶ ON A V8.50 DEPLOYMENT, SET THE CAP TO 1 — it is on the menu as of`);
    console.log(`      2026-08-22 (1|2|5|10|15|20|30|40) and it is the SHIPPED default. At cap 1`);
    console.log(`      every batch prices its item by construction and nothing goes unpriced.`);
    console.log(`      ⚠ This chain was deployed BEFORE the menu widened, so its setter may still`);
    console.log(`      refuse 1. Check the revert before concluding anything about the code.`);
    console.log(`    Otherwise drive ONE ITEM PER TRANSACTION from the driver side:`);
    console.log(`      $env:ONE_ITEM="1"; $env:ONE_ITEM_TYPE="PARKED_RESCUE"; $env:GAS_LIMIT="16500000"`);
    console.log(`      npx hardhat run scripts\\testchain_keeper.js --network baseSepolia`);
    console.log(`    ⚠ GAS_LIMIT is NOT optional: eth_estimateGas prices the BatchGasHalted path`);
    console.log(`    (~0.09M), not the item (~2.4M), because halting SUCCEEDS. Measured 2026-08-22.`);
    console.log(`    ⚠ AND 15,000,000 IS NO LONGER THE RIGHT VALUE — the drivers moved to 16.5M`);
    console.log(`    on 2026-08-22, and a 15M limit CENSORS any item above it (30.10).`);
  }

  // Collect the keeper's own logs to find the transactions, then read each receipt once.
  const txs = new Set();
  const gaps = [];
  for (let b = from; b <= to; b += CHUNK) {
    const hi = Math.min(b + CHUNK - 1, to);
    try {
      const logs = await provider.getLogs({ address: keeperAddr, fromBlock: b, toBlock: hi });
      for (const l of logs) txs.add(l.transactionHash);
    } catch (e) {
      gaps.push([b, hi]);
    }
  }
  console.log(`  keeper-touching transactions: ${txs.size}${gaps.length ? `   ⛔ ${gaps.length} UNREADABLE RANGES` : "   ✅ no unreadable ranges"}`);

  const rows = [];
  for (const h of txs) {
    const tx = await provider.getTransaction(h);
    if (!tx || !tx.data || tx.data.length < 10) continue;
    let decoded = null;
    try { decoded = iface.parseTransaction({ data: tx.data }); } catch { continue; }
    if (!decoded || decoded.name !== "performUpkeep") continue;      // not an upkeep tx
    const rc = await provider.getTransactionReceipt(h);
    if (!rc || rc.status !== 1) continue;                            // a reverted batch prices nothing

    let items = [];
    try {
      items = ethers.AbiCoder.defaultAbiCoder()
        .decode(["tuple(uint8,uint8,address,address)[]"], decoded.args[0])[0];
    } catch { /* leave empty — reported as such, never guessed at */ }

    const row = { tx: h, gasUsed: Number(rc.gasUsed), types: items.map((it) => Number(it[0])),
                  halted: null, failed: [] };
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== keeperAddr.toLowerCase()) continue;
      let p; try { p = iface.parseLog(l); } catch { continue; }
      if (!p) continue;
      if (p.name === "BatchGasHalted") {
        row.halted = { processed: Number(p.args[0]), total: Number(p.args[1]), gasRemaining: Number(p.args[2]) };
        // Items after the halt did not run, so they must not be priced.
        row.types = row.types.slice(0, row.halted.processed);
      }
      if (p.name === "WorkItemFailed") row.failed.push(Number(p.args[0]));
    }
    rows.push(row);
  }

  const f = foldUpkeeps(rows);

  console.log(`\n  1. PER-ITEM COST — SINGLE-ITEM BATCHES ONLY (a mixed batch prices nothing)`);
  console.log(`     ${"work type".padEnd(16)}${"n".padStart(5)}${"min".padStart(10)}${"median".padStart(10)}${"max".padStart(10)}`);
  const keys = Object.keys(f.perType).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) console.log(`     (none — every batch ran more than one item)`);
  for (const t of keys) {
    const c = f.perType[t];
    console.log(`     ${(WORK[t] || `type ${t}`).padEnd(16)}${String(c.n).padStart(5)}` +
      `${usdGas(c.min).padStart(10)}${usdGas(c.median).padStart(10)}${usdGas(c.max).padStart(10)}`);
  }
  console.log(`     mixed batches (not priced) ${f.mixedBatches}   batches that ran nothing ${f.emptyBatches}`);

  console.log(`\n  2. THE GAS GUARD`);
  console.log(`     BatchGasHalted events: ${f.halts.length}`);
  for (const h of f.halts.slice(0, 20)) {
    console.log(`       processed ${String(h.processed).padStart(3)} of ${String(h.total).padStart(3)}   gasRemaining ${usdGas(h.gasRemaining)}`);
  }
  if (f.halts.length > 20) console.log(`       … ${f.halts.length - 20} more`);
  console.log(`     WorkItemFailed by type: ${Object.keys(f.failures).length
    ? Object.entries(f.failures).map(([t, n]) => `${WORK[t] || t}=${n}`).join("  ") : "none"}`);
  console.log(`     ⛔ A WorkItemFailed ON PARKED_RESCUE IS THE SIGNAL THIS RUN EXISTS TO CATCH.`);
  console.log(`        The event carries no reason, so an out-of-gas item and an ordinary revert`);
  console.log(`        look identical. Any non-zero count here must be explained before go-live.`);
  // ⛔ AND NAME THE TRANSACTION, 2026-08-23. Without this the count is a dead end.
  if (f.failedTxs && f.failedTxs.length) {
    console.log(`     ▶ THE FAILING TRANSACTIONS — trace these, do not re-derive them:`);
    for (const x of f.failedTxs.slice(0, 10)) {
      console.log(`       ${WORK[x.type] || x.type}  ${x.tx}`);
      console.log(`         gasUsed ${usdGas(x.gasUsed)} · ${x.items} item(s) in the batch` +
        `${x.halted ? ` · ALSO HALTED at ${x.halted.processed}/${x.halted.total}, ${usdGas(x.halted.gasRemaining)} left` : ` · no halt in this tx`}`);
    }
    if (f.failedTxs.length > 10) console.log(`       … ${f.failedTxs.length - 10} more`);
    console.log(`     ⚠ READ THE TWO NUMBERS TOGETHER. A single-item batch that burned close to`);
    console.log(`       its whole gas limit is an OUT-OF-GAS item. One that failed cheaply, with`);
    console.log(`       gas to spare, reverted for its OWN reasons and is not a floor problem.`);
    console.log(`       That is the distinction defect 8 destroys and this line restores.`);
  }

  const v = gateVerdict(f, minGas);
  console.log(`\n  3. GATE MEASUREMENT 1 — VERDICT`);
  if (v.ok === null) {
    console.log(`     ⚠ NO VERDICT: ${v.why}`);
    console.log(`       This is not a pass. Price ONE cheap item (reclaim/ghost/evict) with ONE_ITEM_TYPE + GAS_LIMIT.`);
  } else {
    console.log(`     dearest single-rescue batch  ${usdGas(v.rescueMaxBatch)}`);
    console.log(`     fixed performUpkeep overhead ${usdGas(v.overhead)}   (cheapest observed work type)`);
    console.log(`     marginal cost of a rescue    ${usdGas(v.marginalMax)}`);
    console.log(`     minGasPerItem                ${usdGas(v.minGasPerItem)}   headroom ${usdGas(v.headroom)}`);
    console.log(`     ${v.ok ? "✅" : "⛔"} ${v.why}`);
  }

  console.log(`\n  ⚠ WHAT THIS CANNOT SEE: the cost of an item TYPE that never ran alone, the cost`);
  console.log(`    at a matrix size other than this chain's, and the reason behind any`);
  console.log(`    WorkItemFailed. It measures gas; it does not measure economics.`);
  if (gaps.length) console.log(`  ⛔ ${gaps.length} BLOCK RANGES WERE UNREADABLE — every count is a LOWER BOUND.`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
