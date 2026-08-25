// g5_sf_ratio.js — THE METRIC G.5 ACTUALLY ASKS FOR: selfFundedRescues / rescues.
//
// ⛔ VERSION 2, SAME DAY (session 41, 2026-08-25). Version 1 scanned `CoPayRescue` because
// the runbook's G.5 PASS names that event — AND THE KEEPER PATH NEVER EMITS IT. On its
// first run, against a chain that had just performed 110 keeper rescues, it found ZERO
// events, and its own zero-events guard said "check the window before believing this."
// The window was fine; the CRITERION was wrong: `CoPayRescue` fires only in
// `coPayRescue()` — the VPS co-pay keeper's entry point, which nothing calls on a
// private gate chain. Session 40 (40.4) wrote that PASS from the event DECLARATION,
// not the call path. Same lesson as every instrument defect this week: read what the
// code DOES, not what its names promise.
//
// WHAT ACTUALLY FIRES, verified at the emit sites (MatrixKeeper.sol:1164,
// MatrixLogicLib.sol:1611/1660/1756):
//   ParkedRescued(matrix, member, tier)          KEEPER addr — EVERY keeper rescue
//   RescueLoanIssued(member, amount, type)       MATRIX addr — only when the SF LENT
//                                                 (type "forceCrossKeeper" | "coPayRescue")
//   SelfRescue(member, shortfallPaid, wdUsed)    MATRIX addr — member paid themselves
//   CoPayRescue(member, sfShare, ...)            MATRIX addr — co-pay path only
//
// THE JOIN: a ParkedRescued whose transaction carries NO RescueLoanIssued is a rescue
// the fund paid NOTHING for — matched by txHash, not by subtraction of counts.
//
// Run (plain node; ADDRESSES_FILE mandatory, no stale defaults):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_50_private2.json"
//   $env:FROM_BLOCK="<deploy block>"        # pin for a whole-of-chain ratio
//   node scripts\g5_sf_ratio.js
// Options: LOOKBACK=250000 (blocks) when FROM_BLOCK is not pinned.
//
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing a stale default (34.1/39.4/40.8).");
  process.exit(1);
}
const A = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE), "utf8"));
const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env."); process.exit(1); }

const KEEPER_ABI = [
  "event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex)",
];
const MATRIX_ABI = [
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
  "event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)",
  "event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed)",
];

const usd = (v) => "$" + (Number(v) / 1e6).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n, d) => (d === 0 ? "n/a" : ((100 * n) / d).toFixed(1) + "%");

async function scan(contract, filter, fromBlk, toBlk) {
  const CHUNK = 9_000;
  const out = [];
  for (let from = fromBlk; from <= toBlk; from += CHUNK + 1) {
    const to = Math.min(from + CHUNK, toBlk);
    out.push(...await contract.queryFilter(filter, from, to));
  }
  return out;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const latest = await provider.getBlockNumber();
  const keeper = new ethers.Contract(A.matrixKeeper, KEEPER_ABI, provider);

  const matrices = [];
  for (const [tier, t] of Object.entries(A.tiers || {})) {
    if (t.matA) matrices.push({ label: `${tier} matA`, addr: t.matA });
    if (t.matB) matrices.push({ label: `${tier} matB`, addr: t.matB });
  }
  if (!matrices.length) { console.log("FATAL: no tiers in the addresses file — wrong file?"); process.exit(1); }
  const byAddr = new Map(matrices.map((m) => [m.addr.toLowerCase(), m.label]));

  const LOOKBACK = Number(process.env.LOOKBACK || 250_000);
  const floorBlk = process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK)
                                          : Math.max(latest - LOOKBACK, 0);

  console.log("G.5 — selfFundedRescues / rescues (v2: ParkedRescued ⋈ RescueLoanIssued by tx)");
  console.log(`  basis: ${path.basename(process.env.ADDRESSES_FILE)}  network=${A.network}` +
    `  matrixSize=${A.matrixSize}  deployedAt=${A.deployedAt}`);
  console.log(`  scanning blocks ${floorBlk}..${latest} (${matrices.length} matrices + keeper)`);

  // keeper: every keeper rescue
  const rescued = await scan(keeper, keeper.filters.ParkedRescued(), floorBlk, latest);

  // matrices: loans, self-rescues, copay (address-array filter over all six)
  const matAll = new ethers.Contract(matrices[0].addr, MATRIX_ABI, provider);
  const mkFilter = (name) => ({ address: matrices.map((m) => m.addr),
                                topics: [matAll.interface.getEvent(name).topicHash] });
  const [loanLogs, selfLogs, copayLogs] = [
    await scan({ queryFilter: (f, a, b) => provider.getLogs({ ...f, fromBlock: a, toBlock: b }) }, mkFilter("RescueLoanIssued"), floorBlk, latest),
    await scan({ queryFilter: (f, a, b) => provider.getLogs({ ...f, fromBlock: a, toBlock: b }) }, mkFilter("SelfRescue"), floorBlk, latest),
    await scan({ queryFilter: (f, a, b) => provider.getLogs({ ...f, fromBlock: a, toBlock: b }) }, mkFilter("CoPayRescue"), floorBlk, latest),
  ];
  const loans = loanLogs.map((lg) => ({ ...matAll.interface.parseLog(lg), tx: lg.transactionHash,
                                        matrix: byAddr.get(lg.address.toLowerCase()) }));

  // THE JOIN — by transaction hash
  const loanTx = new Map();
  for (const l of loans) loanTx.set(l.tx, (loanTx.get(l.tx) || 0n) + l.args.loanAmount);
  let selfFunded = 0, fundBacked = 0; let lentTotal = 0n;
  const perMat = {};   // 41.3b: the PASS is judged per MATRIX — item A's 100% claim is
                       // about MatA (reserve covers a MatA crossing; MatB prices at the
                       // full fee by design), so a lumped ratio can fail a passing chain.
  for (const r of rescued) {
    const mat = byAddr.get(r.args.matrix.toLowerCase()) || r.args.matrix;
    perMat[mat] = perMat[mat] || { n: 0, self: 0 };
    perMat[mat].n++;
    if (loanTx.has(r.transactionHash)) { fundBacked++; lentTotal += loanTx.get(r.transactionHash); }
    else { selfFunded++; perMat[mat].self++; }
  }
  const byType = {};
  for (const l of loans) byType[l.args.rescueType] = (byType[l.args.rescueType] || 0) + 1;

  console.log(`\n  KEEPER RESCUES (ParkedRescued)      ${rescued.length}`);
  console.log(`    self-funded (no loan in the tx)   ${selfFunded}   <- the fund paid nothing`);
  console.log(`    fund-backed (RescueLoanIssued)    ${fundBacked}   lent ${usd(lentTotal)}`);
  console.log(`    selfFundedRescues / rescues       ${pct(selfFunded, rescued.length)}   <- THE G.5 METRIC (keeper path)`);
  for (const [mat, v] of Object.entries(perMat).sort())
    console.log(`      ${mat.padEnd(9)}: ${String(v.n).padStart(4)} rescues, ${String(v.self).padStart(4)} self-funded (${pct(v.self, v.n)})` +
                (mat.includes("matA") ? "   <- item A's claim is judged HERE" : ""));
  if (Object.keys(byType).length > 1 || (loans.length && !byType["forceCrossKeeper"]))
    console.log(`    loan types seen: ${JSON.stringify(byType)}`);

  console.log(`\n  MEMBER SELF-RESCUES (SelfRescue)    ${selfLogs.length}   <- member paid, no fund, no keeper`);
  console.log(`  CO-PAY RESCUES (CoPayRescue)        ${copayLogs.length}   <- the path the old criterion named`);

  const epTotal = rescued.length + selfLogs.length + copayLogs.length;
  const epSelf = selfFunded + selfLogs.length; // copay split needs sfShare — only if present
  console.log(`\n  ALL RESCUE EPISODES                 ${epTotal}`);
  console.log(`    needing no fund money             ${epSelf}${copayLogs.length ? " (+ copay split not counted — decode sfShare)" : ""}`);
  console.log(`    overall self-funded share         ${pct(epSelf, epTotal)}`);

  console.log(`\n  searched blocks ${floorBlk}..${latest}.`);
  if (!process.env.FROM_BLOCK && floorBlk > 0)
    console.log("  ⚠ window may not reach the deployment — pin FROM_BLOCK=<deploy block> for a chain ratio.");
  if (!rescued.length && !selfLogs.length)
    console.log("  ⚠ ZERO events is a statement about THIS WINDOW — check the range before concluding.");
  console.log("  Judge against the runbook's G.5 PASS. ⚠ Handoff 14.6: this is a population of");
  console.log("  scripts; on a -SelfRescueRate 0.1 bigfill cohort the ratio describes that setting.");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
