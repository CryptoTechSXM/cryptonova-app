// diag_upkeep_callers.js — WHO IS ALLOWED TO DRIVE THE KEEPER?
//
// THE QUESTION (AUTOMATION_AUDIT.md open item 2, 2026-08-09, never closed): "Is Chainlink
// CRE registered as an upkeepCaller? If yes, direct_keeper is a fallback, not a dependency."
//
// ⛔ THE AUDIT ASKED IT AS ONE READ AND IT IS NOT ONE READ. `MatrixKeeper.sol:914` gates
//    performUpkeep on THREE routes, any one of which is sufficient:
//
//        msg.sender == owner()  ||  msg.sender == governance  ||  upkeepCaller[msg.sender]
//
//    and `upkeepCaller` is a `mapping(address => bool)` (:505), not an address — there is no
//    getter that enumerates it. So an empty mapping does NOT mean nobody can drive the
//    keeper; it means whoever drives it is the OWNER or GOVERNANCE. That distinction is the
//    whole answer to the audit item, and it is a security answer as much as an ops one:
//    if the driver signs as owner, then the deployer key IS the keeper key.
//
// This enumerates all three. Read-only. It sends no transaction and needs no key.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// HOW THE MAPPING IS ENUMERATED, since Solidity will not do it for us: every write emits
// `UpkeepCallerSet(address indexed caller, bool allowed)` (:568, emitted at :606 — the only
// write site, checked). Scan that event from the deployment block, collect every address it
// has ever named, then read `upkeepCaller(addr)` for each so the CURRENT state comes from
// the mapping and not from the last event. An address granted and later revoked appears
// with allowed=false rather than vanishing, which is what you want in an audit.
//
// THE DEPLOYMENT BLOCK IS FOUND BY BINARY SEARCH ON BLOCK TIMESTAMPS against the
// `deployedAt` in the addresses file — about 26 reads, exact, and it means this script does
// not carry a hardcoded start block that goes stale the next time anything is deployed.
//
// ⛔ NO SILENT FALLBACKS. A failed read raises a named PROBLEM and the process exits
//    non-zero. A chunk of the log scan that fails is halved and retried, and if it still
//    fails the scan ABORTS — a partial event scan that reports "no other callers" is exactly
//    the confident wrong answer this repo keeps catching (bypass_scan_full's "0 direct-entry
//    seats", withdraw_probe v1's "$0.00 everywhere", 38.3's empty test file).
// ─────────────────────────────────────────────────────────────────────────────────────
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/diag_upkeep_callers.js --network baseSepolia
//
//   FROM_BLOCK=n   skip the binary search and start here
//   CHUNK=n        log-scan chunk size (default 10000; halved automatically on RPC refusal)
//
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.log("    npx hardhat run scripts/diag_upkeep_callers.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

const ABI = [
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function upkeepCaller(address) view returns (bool)",
  "event UpkeepCallerSet(address indexed caller, bool allowed)",
];

const problems = [];

// Binary search for the first block at or after `wantTs`.
async function blockAtTime(provider, wantTs, tip) {
  let lo = 0, hi = tip, reads = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    reads++;
    if (!b) { problems.push(`getBlock(${mid}) returned null during deploy-block search`); return null; }
    if (b.timestamp < wantTs) lo = mid + 1; else hi = mid;
  }
  console.log(`  deploy block found by binary search: ${lo} (${reads} reads)`);
  return lo;
}

async function scanLogs(provider, addr, topic, from, to, chunk) {
  const out = [];
  let start = from;
  while (start <= to) {
    let size = chunk;
    for (;;) {
      const end = Math.min(start + size - 1, to);
      try {
        const logs = await provider.getLogs({ address: addr, topics: [topic], fromBlock: start, toBlock: end });
        out.push(...logs);
        start = end + 1;
        break;
      } catch (e) {
        if (size <= 100) {
          problems.push(`getLogs failed irrecoverably at ${start}-${end}: ${e.message.split("\n")[0]}`);
          return null;                       // ⛔ abort, never return a partial scan
        }
        size = Math.floor(size / 2);         // RPC range refusal — halve and retry
      }
    }
  }
  return out;
}

async function main() {
  const addr = A.matrixKeeper;
  if (!addr) { console.log("FATAL: addresses file has no 'matrixKeeper'"); process.exit(1); }
  const provider = ethers.provider;
  const k = new ethers.Contract(addr, ABI, provider);
  const tip = await provider.getBlockNumber();

  console.log("");
  console.log("WHO CAN DRIVE THE KEEPER — AUTOMATION_AUDIT open item 2");
  console.log(`  addresses   : ${process.env.ADDRESSES_FILE}  (${A.network}, deployed ${A.deployedAt})`);
  console.log(`  MatrixKeeper: ${addr}`);
  console.log(`  tip block   : ${tip}`);
  console.log("");

  // ── Route 1 and 2: owner() and governance ────────────────────────────────────────
  let owner = null, gov = null;
  try { owner = await k.owner(); } catch (e) { problems.push(`owner() read failed: ${e.message.split("\n")[0]}`); }
  try { gov   = await k.governance(); } catch (e) { problems.push(`governance() read failed: ${e.message.split("\n")[0]}`); }

  // ── Route 3: enumerate the mapping from its only write site's event ──────────────
  const from = process.env.FROM_BLOCK
    ? Number(process.env.FROM_BLOCK)
    : await blockAtTime(provider, Math.floor(new Date(A.deployedAt).getTime() / 1000), tip);
  if (from === null) { report(owner, gov, []); process.exit(1); }

  const topic = ethers.id("UpkeepCallerSet(address,bool)");
  const logs = await scanLogs(provider, addr, topic, from, tip, Number(process.env.CHUNK || 10000));
  if (logs === null) { report(owner, gov, []); process.exit(1); }
  console.log(`  UpkeepCallerSet events: ${logs.length} across blocks ${from}..${tip}`);
  console.log("");

  const iface = new ethers.Interface(ABI);
  const seen = new Map();                    // address -> {grants, revokes, lastBlock}
  for (const lg of logs) {
    const p = iface.parseLog(lg);
    const a = ethers.getAddress(p.args.caller);
    const e = seen.get(a) || { grants: 0, revokes: 0, lastBlock: 0 };
    if (p.args.allowed) e.grants++; else e.revokes++;
    e.lastBlock = Math.max(e.lastBlock, lg.blockNumber);
    seen.set(a, e);
  }

  // CURRENT state comes from the mapping, not from the last event.
  const rows = [];
  for (const [a, e] of seen) {
    let now = null;
    try { now = await k.upkeepCaller(a); }
    catch (err) { problems.push(`upkeepCaller(${a}) read failed: ${err.message.split("\n")[0]}`); }
    rows.push({ addr: a, ...e, allowed: now });
  }

  // ── Phase 2: WHO ACTUALLY SENDS THE TRANSACTIONS ─────────────────────────────────
  // A grant is permission, not evidence. AUTOMATION_AUDIT item 2's real question is
  // whether direct_keeper is a DEPENDENCY or a FALLBACK, and only the senders answer it.
  //
  // ⛔ THE ANCHOR IS BIASED AND THIS SCRIPT SAYS SO. performUpkeep emits nothing on a
  //    fully successful batch — WorkItemFailed (:560) fires per FAILED item, so this
  //    samples batches that contained at least one failure. On this chain that is nearly
  //    all of them (~20 `SF: insolvency floor` refusals per 10-minute run, 33.7), but a
  //    driver whose batches always fully succeed would be INVISIBLE here. Stated, not
  //    silently assumed away.
  const win  = Number(process.env.SENDER_WINDOW || 50000);
  const cap  = Number(process.env.SENDER_TX_CAP || 200);
  const sFrom = Math.max(from, tip - win);
  console.log(`SENDER SAMPLE — WorkItemFailed over blocks ${sFrom}..${tip} (${win} blocks)`);
  const wif = await scanLogs(provider, addr, ethers.id("WorkItemFailed(uint8,uint8,address,address)"), sFrom, tip, Number(process.env.CHUNK || 10000));
  const senders = new Map();
  if (wif === null) {
    console.log("  scan aborted — see PROBLEMS");
  } else {
    const txs = [...new Set(wif.map(l => l.transactionHash))];
    const use = txs.slice(0, cap);
    if (txs.length > use.length) {
      console.log(`  ⚠ CAP APPLIED: ${txs.length} unique transactions found, reading ${use.length}.`);
      console.log("    Raise SENDER_TX_CAP for the full set. (No silent truncation.)");
    }
    for (const h of use) {
      try {
        const t = await provider.getTransaction(h);
        if (!t) { problems.push(`getTransaction(${h}) returned null`); continue; }
        const a = ethers.getAddress(t.from);
        senders.set(a, (senders.get(a) || 0) + 1);
      } catch (e) { problems.push(`getTransaction(${h}) failed: ${e.message.split("\n")[0]}`); }
    }
    console.log(`  ${wif.length} WorkItemFailed events across ${txs.length} transactions; ${use.length} read`);
    console.log("");
  }

  report(owner, gov, rows, senders, await codeMap(provider, [owner, gov, ...rows.map(r => r.addr)]));
  if (problems.length) process.exit(1);
}

// EOA or contract? A Chainlink Automation registry is a CONTRACT. An address with no code
// is somebody's private key on a machine somewhere, which is a different kind of answer.
async function codeMap(provider, addrs) {
  const m = new Map();
  for (const a of addrs.filter(Boolean)) {
    if (m.has(a)) continue;
    try { const c = await provider.getCode(a); m.set(a, c && c !== "0x" ? "contract" : "EOA"); }
    catch (e) { m.set(a, "UNREADABLE"); problems.push(`getCode(${a}) failed: ${e.message.split("\n")[0]}`); }
  }
  return m;
}

function label(a) {
  if (!a) return "";
  const hit = Object.entries(A).find(([, v]) => typeof v === "string" && v.toLowerCase() === a.toLowerCase());
  return hit ? `  <- ${hit[0]} in the addresses file` : "";
}

function report(owner, gov, rows, senders = new Map(), kinds = new Map()) {
  const kind = (a) => a && kinds.get(a) ? ` [${kinds.get(a)}]` : "";
  console.log("THE THREE ROUTES INTO performUpkeep (MatrixKeeper.sol:914)");
  console.log(`  1. owner()      ${owner || "UNREADABLE"}${kind(owner)}${label(owner)}`);
  console.log(`  2. governance   ${gov   || "UNREADABLE"}${kind(gov)}${label(gov)}`);
  console.log(`  3. upkeepCaller mapping — ${rows.length} address(es) ever set:`);
  if (!rows.length) {
    console.log("       (none — the mapping has never been written)");
  } else {
    for (const r of rows) {
      const state = r.allowed === null ? "UNREADABLE" : (r.allowed ? "ALLOWED" : "revoked");
      console.log(`       ${r.addr}  ${state.padEnd(11)}${kind(r.addr)} grants ${r.grants} revokes ${r.revokes} last block ${r.lastBlock}${label(r.addr)}`);
    }
  }
  console.log("");

  if (senders.size) {
    console.log("WHO ACTUALLY SENT THE performUpkeep TRANSACTIONS (sampled)");
    const total = [...senders.values()].reduce((a, b) => a + b, 0);
    for (const [a, n] of [...senders].sort((x, y) => y[1] - x[1])) {
      const route = a === owner ? "owner()"
                  : a === gov ? "governance"
                  : rows.find(r => r.addr === a && r.allowed) ? "upkeepCaller grant"
                  : "⛔ NO ROUTE — this sender should not be able to call performUpkeep";
      console.log(`  ${a}  ${String(n).padStart(4)}/${total} tx  via ${route}${kind(a)}`);
    }
    console.log("");
  }

  const live = rows.filter(r => r.allowed === true);
  console.log("VERDICT");
  if (live.length) {
    console.log(`  ${live.length} authorised caller(s) beyond owner/governance:`);
    for (const r of live) {
      const k = kinds.get(r.addr);
      console.log(`    ${r.addr} [${k || "?"}]`);
      if (k === "EOA") {
        console.log("      ⛔ AN EOA, SO IT IS NOT A CHAINLINK AUTOMATION REGISTRY — a registry is a");
        console.log("         CONTRACT. This is somebody's private key on a machine. AUTOMATION_AUDIT");
        console.log("         item 2 therefore answers NO, and direct_keeper is a DEPENDENCY.");
      } else if (k === "contract") {
        console.log("      A contract — it MAY be an Automation registry. ⛔ Do not label it from that");
        console.log("      alone: CLAUDE.md's 2026-07-29 census labelled 0xdb9B1e94 'Chainlink registry'");
        console.log("      on no evidence and two sessions built conclusions on it (identify_driver.js).");
        console.log("      Decode one of its calls before naming it.");
      }
    }
  } else {
    console.log("  ⛔ NOBODY holds a delegated upkeepCaller grant. So whatever drives performUpkeep");
    console.log("     today does so as OWNER or as GOVERNANCE — and if that is the droplet's");
    console.log("     direct_keeper, then the DEPLOYER KEY IS THE KEEPER KEY, running on a cron");
    console.log("     every few minutes. That is an availability AND a custody question, not a");
    console.log("     naming one. Confirm by matching the droplet signer against owner() above.");
    console.log("     ⛔ Chainlink CRE is NOT registered — AUTOMATION_AUDIT item 2 answers NO.");
  }
  console.log("");
  if (problems.length) {
    console.log(`PROBLEMS: ${problems.length}`);
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log("PROBLEMS: 0");
  }
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
