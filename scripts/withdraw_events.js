// withdraw_events.js — every withdrawal this member has ever made, from the LOGS,
// reconciled against the per-matrix `totalWithdrawn` ledger field.
//
// WHY (2026-07-29): the dashboard was fixed to sum `totalWithdrawn` across every
// matrix and now reports $1,947.50 on 0xe8Ad7bbA. The owner says he withdrew
// $1,000 twice. $52.50 is unaccounted for and the 1.5% fee CANNOT explain it,
// because the fee runs the wrong way:
//
//   MatrixLogicLib.withdrawCore:995-1008
//     withdrawable   -= amt;
//     totalWithdrawn += amt;                       <- GROSS, before the fee
//     fee    = amt * withdrawalFeeBps / 10000;     <- 150 bps = 1.5%
//     payout = amt - fee;
//     usdc.safeTransfer(recipient, payout);        <- NET, what reaches the wallet
//     emit EarningsWithdrawn(member, payout);      <- NET
//
// So `totalWithdrawn` is always LARGER than the cash received. A screen showing
// less than the member requested cannot be a fee artifact.
//
// All five entry points (withdraw, withdrawPartial, withdrawPartialTo,
// withdrawTo, and the keeper's forced full withdraw) go through withdrawCore, and
// exitSeat moves reserve into `withdrawable` without transferring out, so there is
// no supported path that pays a member without incrementing the counter. If the
// events and the ledger disagree, that is a genuine bug, not a rounding story.
//
// WHAT THIS PRINTS
//   1. Every EarningsWithdrawn / WithdrawalFeeCharged pair, per matrix, with tx.
//      NOTE the event carries the NET payout, so gross is reconstructed as
//      payout + fee — never by dividing, which would hide a mismatched fee.
//   2. Per matrix: summed gross from events  vs  the stored totalWithdrawn.
//      These must be EQUAL. A difference is the bug.
//   3. Totals: gross requested, fees paid, net received. Compare "net received"
//      against the wallet, and "gross" against the dashboard.
//
// Read-only. No key. Chunks eth_getLogs for the free public RPC.
//
// Run:  ADDR=0x... node withdraw_events.js
//       ADDR=0x... WINDOW=5000 node withdraw_events.js     (smaller chunks)

// PORTABLE BY DESIGN. `ethers` is only installed in the contracts repo and on the
// VPS, not in CryptoNite-MT5-Bots, so this script has to be runnable from wherever
// the module actually lives. It therefore searches for .env and for the addresses
// JSON instead of assuming both sit beside it, and every candidate it tried is
// printed on failure — a diagnostic that cannot find its config must say so
// loudly rather than fall back to a default and report the wrong chain's state.
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const CANDIDATE_DIRS = [
  __dirname,
  process.cwd(),
  "C:/CryptoNite-MT5-Bots",
  "C:/CryptoNite-Smart-Contracts/CryptoNova",
  "/root/keeper",
  path.join(__dirname, "..", "CryptoNite-Smart-Contracts", "CryptoNova"),
];

function findFile(name, extra = []) {
  for (const d of [...extra, ...CANDIDATE_DIRS]) {
    if (!d) continue;
    const f = path.join(d, name);
    try { if (fs.existsSync(f)) return f; } catch (_) {}
  }
  return null;
}

for (const d of CANDIDATE_DIRS) {
  const f = d && path.join(d, ".env");
  try { if (f && fs.existsSync(f)) require("dotenv").config({ path: f }); } catch (_) {}
}

// RPC= on the command line wins. The paid Alchemy endpoint expired on 2026-07-29,
// so a stale .env may still name a dead provider; passing RPC=https://sepolia.base.org
// must always be possible without editing any file.
const RPC_URL    = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRS_NAME = process.env.ADDRESSES_FILE || "deployed_addresses_v8_45.json";
const ADDRS_PATH = process.env.ADDRESSES_PATH || findFile(ADDRS_NAME);
const WHO        = (process.env.ADDR || "").trim();
const WINDOW     = Number(process.env.WINDOW || 9000);
const PROBE      = process.env.PROBE === "1";
const QUIET      = process.env.QUIET === "1";

const TR_ABI  = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI  = ["function pairCount() view returns (uint256)",
                 "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "event EarningsWithdrawn(address indexed member, uint256 amount)",
  "event WithdrawalFeeCharged(address indexed member, uint256 fee)",
  "function getMemberTotalWithdrawn(address) view returns (uint256)",
  "function withdrawalFeeBps() view returns (uint256)",
];

const usd = v => "$" + Number(ethers.formatUnits(v, 6)).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

async function rd(fn, dflt = null) { try { return await fn(); } catch { return dflt; } }

function why(e) {
  return (e && (e.shortMessage || e.info?.error?.message || e.error?.message || e.message) || String(e))
    .replace(/\s+/g, " ").slice(0, 190);
}

// Chunked queryFilter. A failed chunk is REPORTED WITH ITS REASON, never swallowed
// — a missing range understates the total and looks exactly like the bug we are
// chasing. The first version of this printed only the block range, which produced
// 644 identical lines and told us nothing about the cause. One reason per matrix
// is enough; the rest are counted.
async function logsOf(c, filter, from, to, label) {
  const out = []; let holes = 0; let reported = false;
  try { return { logs: await c.queryFilter(filter, from, to), holes: 0 }; }
  catch (e) {
    if (!QUIET) console.log(`    ${label}: wide query failed (${why(e)}) — chunking at ${WINDOW}`);
  }
  for (let a = from; a <= to; a += WINDOW) {
    const b = Math.min(a + WINDOW - 1, to);
    let got = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try { got = await c.queryFilter(filter, a, b); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 700 * (attempt + 1))); }
    }
    if (got === null) {
      holes++;
      if (!reported) { console.log(`    ${label}: blocks ${a}-${b} FAILED — ${why(lastErr)}`); reported = true; }
    } else out.push(...got);
  }
  if (holes > 1) console.log(`    ${label}: ${holes} ranges failed in total (same reason)`);
  return { logs: out, holes };
}

// Learn the provider's actual eth_getLogs limits BEFORE looping over 30 matrices.
// Distinguishes the two failure modes that look identical from the outside:
//   - a RANGE cap  -> small windows near the tip succeed, large ones fail
//   - a RETENTION/archive cut-off -> recent blocks succeed, historic ones fail
async function probe(c, filter, tip, label) {
  console.log(`\nPROBE — ${label} (learning this endpoint's eth_getLogs limits)`);
  const tests = [
    ["recent, 50 blocks",      Math.max(0, tip - 50),     tip],
    ["recent, 500 blocks",     Math.max(0, tip - 500),    tip],
    ["recent, 2,000 blocks",   Math.max(0, tip - 2000),   tip],
    ["recent, 9,000 blocks",   Math.max(0, tip - 9000),   tip],
    ["recent, 50,000 blocks",  Math.max(0, tip - 50000),  tip],
    ["HISTORIC, 500 blocks",   44_700_000,                44_700_499],
    ["HISTORIC, 9,000 blocks", 44_700_000,                44_708_999],
  ];
  let smallRecentOk = false, historicOk = false;
  for (const [name, a, b] of tests) {
    try {
      const r = await c.queryFilter(filter, a, b);
      console.log(`  OK    ${name.padEnd(24)} (${r.length} logs)`);
      if (name.startsWith("recent, 50 ")) smallRecentOk = true;
      if (name.startsWith("HISTORIC")) historicOk = true;
    } catch (e) {
      console.log(`  FAIL  ${name.padEnd(24)} ${why(e)}`);
    }
  }
  console.log(`  READING: ` + (
    !smallRecentOk ? "even a 50-block query near the tip fails — the ABI/filter or the endpoint is the problem, not the range."
    : historicOk   ? "historic ranges work; the failures were range size or rate limiting. Lower WINDOW."
                   : "recent works but HISTORIC does not — this endpoint does not serve archive logs. Use a provider that does."
  ));
}

async function main() {
  if (!WHO) { console.log("Usage: ADDR=0x... node withdraw_events.js"); process.exit(1); }
  if (!RPC_URL) {
    console.log("FATAL: no RPC. Set RPC=https://sepolia.base.org or put BASE_SEPOLIA_RPC_URL in a .env in one of:");
    CANDIDATE_DIRS.forEach(d => console.log("   " + d));
    process.exit(1);
  }
  if (!ADDRS_PATH) {
    console.log(`FATAL: could not find ${ADDRS_NAME}. Looked in:`);
    CANDIDATE_DIRS.forEach(d => console.log("   " + d));
    console.log("Pass an explicit path with ADDRESSES_PATH=C:/CryptoNite-MT5-Bots/" + ADDRS_NAME);
    process.exit(1);
  }
  const who = ethers.getAddress(WHO);
  const p   = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const a   = JSON.parse(fs.readFileSync(ADDRS_PATH, "utf8"));
  console.log(`rpc ${String(RPC_URL).replace(/\/v2\/.*/, "/v2/****")}`);
  console.log(`addresses ${ADDRS_PATH}`);
  const tip = await p.getBlockNumber();
  // V8.45 deployed 2026-07-26 ~02:45 UTC. Earliest block referenced in the V8.45
  // record is 44671830 (the 8:25 PM threshold change), so 44,600,000 sits safely
  // before any V8.45 matrix existed. Scanning from 0 would be ~5,000 chunked
  // eth_getLogs calls PER MATRIX on the free public endpoint.
  // Override with FROM= if a matrix somehow predates it.
  const from = Number(process.env.FROM || 44_600_000);

  const [pms] = await new ethers.Contract(a.tierRouter, TR_ABI, p).getAllTiers();

  console.log(`withdraw_events — ${who}`);
  console.log(`blocks ${from}..${tip}   ·   ${new Date().toISOString()}\n`);

  let gGross = 0n, gFee = 0n, gNet = 0n, gLedger = 0n, holes = 0, feeBps = null;
  const rows = [], events = [];
  let probed = false;

  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    const n  = Number(await rd(() => pm.pairCount(), 0n));
    for (let i = 0; i < n; i++) {
      const pr = await rd(() => pm.getPairAt(i));
      if (!pr) continue;
      for (const [half, addr] of [["MatA", pr[0]], ["MatB", pr[1]]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const label = `T${t + 1}.${i + 1} ${half}`;
        const c = new ethers.Contract(addr, MAT_ABI, p);

        const ledger = await rd(() => c.getMemberTotalWithdrawn(who), null);
        if (ledger === null) { console.log(`  ${label}: totalWithdrawn unreadable — SKIPPED, total is a floor`); holes++; continue; }

        // Only pay for logs where the ledger says a withdrawal happened. This
        // gives up detecting the INVERSE bug (a payout event with no ledger
        // entry), which is acceptable because `withdrawable -= amt` and
        // `totalWithdrawn += amt` are consecutive statements in the only function
        // that transfers to a member — there is no code path that emits one
        // without the other. The saving is ~30x the RPC calls on a free endpoint.
        if (ledger === 0n) continue;

        if (PROBE && !probed) { await probe(c, c.filters.EarningsWithdrawn(who), tip, label); probed = true; process.exit(0); }

        const w = await logsOf(c, c.filters.EarningsWithdrawn(who), from, tip, label);
        holes += w.holes;

        const f = await logsOf(c, c.filters.WithdrawalFeeCharged(who), from, tip, label);
        holes += f.holes;
        const feeByTx = new Map();
        for (const ev of f.logs) feeByTx.set(ev.transactionHash, (feeByTx.get(ev.transactionHash) || 0n) + ev.args.fee);

        if (feeBps === null) feeBps = await rd(() => c.withdrawalFeeBps(), null);

        let mGross = 0n, mFee = 0n, mNet = 0n;
        for (const ev of w.logs) {
          const net = ev.args.amount;
          const fee = feeByTx.get(ev.transactionHash) ?? 0n;
          const gross = net + fee;
          mNet += net; mFee += fee; mGross += gross;
          events.push({ block: ev.blockNumber, label, gross, fee, net, tx: ev.transactionHash });
        }
        rows.push({ label, count: w.logs.length, gross: mGross, fee: mFee, net: mNet, ledger });
        gGross += mGross; gFee += mFee; gNet += mNet; gLedger += ledger;
      }
    }
  }

  events.sort((x, y) => x.block - y.block);
  console.log("EVERY WITHDRAWAL, OLDEST FIRST");
  console.log("block      matrix           gross        fee         net received   tx");
  console.log("─".repeat(112));
  for (const e of events) {
    console.log(`${pad(e.block, 9)}  ${e.label.padEnd(15)} ${pad(usd(e.gross), 11)} ${pad(usd(e.fee), 10)} ` +
                `${pad(usd(e.net), 14)}   ${e.tx.slice(0, 18)}…`);
  }
  if (!events.length) console.log("  (none found)");

  console.log(`\nPER MATRIX — events vs the stored ledger field`);
  console.log("matrix            n   gross(events)   totalWithdrawn(stored)   agree?");
  console.log("─".repeat(112));
  let mismatch = 0;
  for (const r of rows) {
    const ok = r.gross === r.ledger;
    if (!ok) mismatch++;
    console.log(`${r.label.padEnd(15)} ${pad(r.count, 3)}   ${pad(usd(r.gross), 13)}   ${pad(usd(r.ledger), 22)}   ` +
                (ok ? "yes" : `NO  (off by ${usd(r.ledger > r.gross ? r.ledger - r.gross : r.gross - r.ledger)})`));
  }

  console.log(`\nTOTALS`);
  console.log(`  gross requested (sum of events)      ${usd(gGross)}`);
  console.log(`  withdrawal fees paid                 ${usd(gFee)}` +
              (feeBps !== null ? `   (${Number(feeBps) / 100}% — goes to the StabilityFund, layer 3)` : ""));
  console.log(`  NET RECEIVED IN WALLET               ${usd(gNet)}   <- compare against your wallet`);
  console.log(`  stored totalWithdrawn (dashboard)    ${usd(gLedger)}   <- compare against the screen`);

  console.log(`\nVERDICT`);
  if (holes > 0) {
    console.log(`  INCONCLUSIVE — ${holes} block range(s) or read(s) failed. Totals are a FLOOR, not a total.`);
    console.log(`  Re-run with a smaller WINDOW (e.g. WINDOW=3000) before trusting any number here.`);
  } else if (mismatch > 0) {
    console.log(`  REAL BUG: ${mismatch} matrix/matrices where the events and the ledger field disagree.`);
    console.log(`  Every payout path increments totalWithdrawn in the same statement that debits`);
    console.log(`  withdrawable (withdrawCore:995-996), so they cannot legitimately differ.`);
  } else {
    console.log(`  Events and ledger agree everywhere. The chain has no record of any withdrawal`);
    console.log(`  beyond ${usd(gGross)} gross / ${usd(gNet)} net.`);
    console.log(`  If you expected more, the missing amount was never withdrawn from a matrix —`);
    console.log(`  check whether it was a bulk/"withdraw all" that took only what was FREE at the`);
    console.log(`  time (freeWithdrawable, after the crossing and automation reserves), rather than`);
    console.log(`  the round figure you asked for.`);
  }
}

main().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
