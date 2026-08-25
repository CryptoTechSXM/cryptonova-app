// g5_sf_ratio.js — THE METRIC G.5 ACTUALLY ASKS FOR: selfFundedRescues / rescues.
//
// WHY THIS EXISTS (session 41, 2026-08-25): the runbook's G.5 PASS is
// `selfFundedRescues / rescues` via `CoPayRescue.sfShare == 0`, and session 40 (40.4)
// established that `model_item_a.js` NEVER COMPUTES THAT NUMBER — its PHASE 2 prints a
// projection of item A's benefit onto a pre-item-A chain, which on a chain that already
// has item A is structurally zero. G.5 therefore returned NO VERDICT. This script is the
// missing instrument: one event scan, no control needed, because `CoPayRescue` carries
// `sfShare` directly and `sfShare == 0` IS "the fund paid nothing".
//
// WHAT IT DOES: scans every tier's matA/matB for `CoPayRescue` events and reports
//   rescues total, self-funded (sfShare == 0), fund-backed (sfShare > 0), the ratio,
//   and the money split (sfShare / memberWalletShare / withdrawableUsed sums),
// per matrix and in aggregate, stating the basis (addresses file, network, block range).
//
// WHAT IT DOES NOT DO: judge the ratio. G.5's PASS ("at or near the projection") is a
// runbook call, and handoff 14.6 applies — a shortfall here is an ECONOMIC finding on a
// population of scripts, not a fact about members. On a chain bigfilled with
// -SelfRescueRate 0.1 the ratio DESCRIBES THAT COHORT SETTING; say so when quoting it.
//
// RULES HONOURED (the four-hardcoded-instruments day, 40.5 / 40.8):
//   * ADDRESSES_FILE is MANDATORY — refuses to start on a stale default (34.1, 39.4).
//   * No hardcoded chain assumption: every address comes from the file, and the output
//     prints which file and network it measured.
//   * eth_getLogs chunked at 9,000 blocks (endpoint caps at 10,000 — 40.8), with a
//     BOUNDED lookback that REPORTS the range searched, because an empty result must
//     never be readable as "no rescues" when it means "not in this window".
//
// Run (plain node, not `npx hardhat run` — builds its own provider from .env):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_50_private.json"
//   node scripts\g5_sf_ratio.js
// Options:
//   LOOKBACK=250000     how far back from latest to scan (blocks). Default 250,000
//                       (~5.8 days at Base's 2s blocks — covers a fresh private deploy).
//   FROM_BLOCK=45900000 pin the scan floor explicitly (overrides LOOKBACK). Use the
//                       deployment block for a whole-of-chain ratio.
//
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  (34.1's trap, and 39.4's, and 40.8 found a FOURTH instrument with a dead");
  console.log("   hardcoded address. This one starts from the file or not at all.)");
  process.exit(1);
}
const A = JSON.parse(
  fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE), "utf8")
);

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
if (!RPC) {
  console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env.");
  process.exit(1);
}

const EVT = "CoPayRescue(address,uint256,uint256,uint256)";
const TOPIC = ethers.id(EVT);
const IFACE = new ethers.Interface([
  "event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed)",
]);

const usd = (v) =>
  "$" +
  (Number(v) / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const pct = (n, d) => (d === 0 ? "n/a" : ((100 * n) / d).toFixed(1) + "%");

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const latest = await provider.getBlockNumber();

  // Every matrix address, labelled, straight from the file — nothing assumed.
  const matrices = [];
  for (const [tier, t] of Object.entries(A.tiers || {})) {
    if (t.matA) matrices.push({ label: `${tier} matA`, addr: t.matA });
    if (t.matB) matrices.push({ label: `${tier} matB`, addr: t.matB });
  }
  if (matrices.length === 0) {
    console.log("FATAL: no tiers/matrices in the addresses file — wrong file?");
    process.exit(1);
  }
  const byAddr = new Map(matrices.map((m) => [m.addr.toLowerCase(), m.label]));

  // Bounded window, reported. 40.8: an empty result must never read as "nobody was
  // rescued" when it means "not in this window".
  const CHUNK = 9_000;
  const LOOKBACK = Number(process.env.LOOKBACK || 250_000);
  const floorBlk = process.env.FROM_BLOCK
    ? Number(process.env.FROM_BLOCK)
    : Math.max(latest - LOOKBACK, 0);

  console.log("G.5 — selfFundedRescues / rescues, via CoPayRescue.sfShare");
  console.log(`  basis: ${path.basename(process.env.ADDRESSES_FILE)}` +
    `  network=${A.network}  matrixSize=${A.matrixSize}  deployedAt=${A.deployedAt}`);
  console.log(`  scanning blocks ${floorBlk}..${latest} ` +
    `(${latest - floorBlk} blocks, ${CHUNK}-block chunks, ${matrices.length} matrices)`);

  const events = [];
  let chunks = 0;
  for (let from = floorBlk; from <= latest; from += CHUNK + 1) {
    const to = Math.min(from + CHUNK, latest);
    const logs = await provider.getLogs({
      address: matrices.map((m) => m.addr),
      topics: [TOPIC],
      fromBlock: from,
      toBlock: to,
    });
    for (const lg of logs) {
      const p = IFACE.parseLog({ topics: lg.topics, data: lg.data });
      events.push({
        matrix: byAddr.get(lg.address.toLowerCase()) || lg.address,
        member: p.args.member,
        sfShare: p.args.sfShare,
        memberWalletShare: p.args.memberWalletShare,
        withdrawableUsed: p.args.withdrawableUsed,
        block: lg.blockNumber,
      });
    }
    chunks++;
    if (chunks % 10 === 0)
      process.stdout.write(`\r  ...block ${to} (${events.length} rescues so far)   `);
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  // Aggregate, then per matrix.
  const agg = { n: 0, self: 0, sf: 0n, wallet: 0n, wd: 0n };
  const per = new Map();
  for (const e of events) {
    const buckets = [agg, per.get(e.matrix) || per.set(e.matrix, { n: 0, self: 0, sf: 0n, wallet: 0n, wd: 0n }).get(e.matrix)];
    for (const b of buckets) {
      b.n++;
      if (e.sfShare === 0n) b.self++;
      b.sf += e.sfShare;
      b.wallet += e.memberWalletShare;
      b.wd += e.withdrawableUsed;
    }
  }

  console.log(`\n  rescues (CoPayRescue events)   ${agg.n}`);
  console.log(`  self-funded (sfShare == 0)     ${agg.self}   <- "the fund paid nothing"`);
  console.log(`  fund-backed (sfShare  > 0)     ${agg.n - agg.self}`);
  console.log(`  selfFundedRescues / rescues    ${pct(agg.self, agg.n)}   <- THE G.5 METRIC`);
  console.log(`  money: fund sfShare ${usd(agg.sf)} | member wallet ${usd(agg.wallet)} | withdrawable ${usd(agg.wd)}`);

  if (per.size > 0) {
    console.log("\n  per matrix:");
    for (const [label, b] of [...per.entries()].sort()) {
      console.log(
        `    ${label.padEnd(9)} rescues ${String(b.n).padStart(5)}  ` +
          `self ${String(b.self).padStart(5)} (${pct(b.self, b.n).padStart(6)})  ` +
          `fund ${usd(b.sf)}`
      );
    }
  }

  console.log(`\n  searched blocks ${floorBlk}..${latest}.`);
  if (!process.env.FROM_BLOCK && floorBlk > 0) {
    console.log("  ⚠ If this window may not reach back to the DEPLOYMENT, the ratio is a");
    console.log("    window ratio, not a chain ratio. Pin the floor to the deploy block:");
    console.log("      FROM_BLOCK=<deploy block> ADDRESSES_FILE=... node scripts\\g5_sf_ratio.js");
  }
  if (agg.n === 0) {
    console.log("  ⚠ ZERO events is a statement about THIS WINDOW on THIS chain — check the");
    console.log("    range above before reading it as \"no rescues ever\". NO VERDICT on G.5.");
  } else {
    console.log("  Judge against the runbook's G.5 PASS (\"at or near the projection\").");
    console.log("  ⚠ Handoff 14.6: this is an economic figure about a population of scripts;");
    console.log("    on a -SelfRescueRate 0.1 bigfill cohort it describes that setting, not members.");
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
