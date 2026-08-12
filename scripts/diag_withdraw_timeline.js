// diag_withdraw_timeline.js — WHEN did this member's withdrawals happen, relative
// to the moment the withdraw fixes went live? (V8.48 session, 2026-08-12)
//
// WHY: CryptoJan22 reported "clicked max, only 50% went through" at 10:46 GMT on
// 2026-08-11. The withdraw fixes (per-matrix try/catch + gas estimate + receipt,
// Testnet-App commit bc96ea2) were pushed 2026-08-11 03:15 GMT. The handoff's
// standing order: establish OLD BUILD vs NEW BUILD before treating the report as
// evidence either way. Submission time cannot answer that — the withdrawal itself
// might predate the push, or her tab might predate it. The chain knows when each
// leg actually ran, and each tx says WHO sent it and HOW.
//
// RETRACTION (2026-08-12, same day): v1 of this header claimed gasLimit was a
// build fingerprint (old build = exactly 200k, new = estimate+25%). That
// reasoning silently assumed tx.from == the member. CryptoJan22's wallet is a
// MetaMask Smart Account (EIP-7702): her withdrawals are executed by a MetaMask
// RELAYER via "Redeem Delegations" on the DelegationManager, so the gasLimit
// belongs to the relayer, not to any build of index.html. The script now prints
// tx.from and labels relayed legs; gasLimit proves nothing for a relayed leg.
// EarningsWithdrawn(member=X) does NOT mean X sent the tx. Check tx.from FIRST.
// (Also verified 2026-08-12: members are served MAIN — an admin-only push is
// not member-facing at all, so "which build" is usually answered by branches.)
//
// Prints every EarningsWithdrawn leg since WINDOW_START with its UTC + Bolivia
// time, BEFORE/AFTER the fix-live moment, the calling path, and the gas verdict.
// Read-only. No key needed.
//
// Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_withdraw_timeline.js 0x79470c63b5421e333ab4149b3206d55a39c17532
//
// Optional: RPC=... to override .env; second arg = ISO window start.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

// The moment bc96ea2 (withdraw fixes) + 9f76398 (clear-all) went live on
// v8.crypto-nova.app: pushed 2026-08-10 23:15 America/La_Paz = 03:15 GMT, plus
// ~2 min for the Vercel build. If the push time is ever re-established more
// precisely, change ONLY this line.
const FIX_LIVE = Date.parse("2026-08-11T03:17:00Z") / 1000;

// Cover Deborah's Aug-10 report too. Override with a second CLI arg if needed.
const WINDOW_START = Date.parse(process.argv[3] || "2026-08-10T00:00:00Z") / 1000;

// V8.47 deploy block — safely before 2026-08-10, used as the bisection floor.
const SEARCH_FLOOR = 45_060_000;

const TR_ABI  = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI  = ["function pairCount() view returns (uint256)",
                 "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "event EarningsWithdrawn(address indexed member, uint256 amount)",
  "event WithdrawalFeeCharged(address indexed member, uint256 fee)",
];

const usd = v => "$" + Number(ethers.formatUnits(v, 6)).toFixed(2);
const CHUNK = Number(process.env.WINDOW || 9000);

function stamp(tsSec) {
  const d = new Date(tsSec * 1000);
  const gmt = d.toISOString().replace(".000Z", "Z");
  const local = new Date(d.getTime() - 4 * 3600 * 1000).toISOString().replace(".000Z", "").replace("T", " ");
  return `${gmt}  (${local} Bolivia)`;
}

async function chunkedLogs(c, filter, from, to, label, holesRef) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(a + CHUNK - 1, to);
    let got = null, lastErr = null;
    for (let att = 0; att < 3 && got === null; att++) {
      try { got = await c.queryFilter(filter, a, b); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 700 * (att + 1))); }
    }
    if (got === null) {
      holesRef.n++;
      console.log(`    ${label}: blocks ${a}-${b} FAILED (${(lastErr?.shortMessage || lastErr?.message || lastErr)})`);
    } else out.push(...got);
  }
  return out;
}

(async () => {
  const who = process.argv[2] && ethers.getAddress(process.argv[2]);
  if (!who) { console.log("Usage: node scripts\\diag_withdraw_timeline.js 0xWALLET [ISO-window-start]"); process.exit(1); }
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env or pass RPC=..."); process.exit(1); }

  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const tip = await p.getBlockNumber();

  // Bisect the first block at/after WINDOW_START. A failed getBlock aborts —
  // never guess a block range and report a partial window as the whole story.
  let lo = SEARCH_FLOOR, hi = tip;
  const tsOf = async n => { const b = await p.getBlock(n); if (!b) throw new Error(`getBlock(${n}) returned null`); return b.timestamp; };
  if (await tsOf(lo) > WINDOW_START) { console.log(`NOTE: search floor ${lo} is already inside the window; scanning from it.`); hi = lo; }
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); (await tsOf(mid) < WINDOW_START) ? lo = mid + 1 : hi = mid; }
  const from = lo;

  console.log(`\nwithdraw timeline — ${who}`);
  console.log(`window ${stamp(WINDOW_START)}  ->  now   ·   blocks ${from}..${tip}`);
  console.log(`fix-live moment: ${stamp(FIX_LIVE)}\n`);

  const [pms] = await new ethers.Contract(A.tierRouter, TR_ABI, p).getAllTiers();
  const holes = { n: 0 };
  const events = [];

  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    let n = 0;
    try { n = Number(await pm.pairCount()); }
    catch { console.log(`  T${t + 1}: pairCount unreadable — SKIPPED, results are a floor`); holes.n++; continue; }
    for (let i = 0; i < n; i++) {
      let pr; try { pr = await pm.getPairAt(i); } catch { holes.n++; console.log(`  T${t + 1}.${i + 1}: getPairAt failed — SKIPPED`); continue; }
      for (const [half, addr] of [["MatA", pr[0]], ["MatB", pr[1]]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const label = `T${t + 1}.${i + 1} ${half}`;
        const c = new ethers.Contract(addr, MAT_ABI, p);
        const w = await chunkedLogs(c, c.filters.EarningsWithdrawn(who), from, tip, label, holes);
        const f = await chunkedLogs(c, c.filters.WithdrawalFeeCharged(who), from, tip, label, holes);
        const feeByTx = new Map();
        for (const ev of f) feeByTx.set(ev.transactionHash, (feeByTx.get(ev.transactionHash) || 0n) + ev.args.fee);
        for (const ev of w) events.push({ block: ev.blockNumber, label, net: ev.args.amount, fee: feeByTx.get(ev.transactionHash) ?? 0n, tx: ev.transactionHash });
      }
    }
  }

  events.sort((x, y) => x.block - y.block);

  if (!events.length) {
    console.log("NO withdrawal events in the window." + (holes.n ? ` BUT ${holes.n} range(s) failed — INCONCLUSIVE, re-run with WINDOW=3000.` : ""));
    if (!holes.n) console.log("Every leg of the reported attempt either predates the window or never landed on-chain (all legs failed / wallet rejected).");
    process.exit(0);
  }

  const blockTs = new Map(), txMeta = new Map();
  for (const e of events) {
    if (!blockTs.has(e.block)) { const b = await p.getBlock(e.block); blockTs.set(e.block, b ? b.timestamp : null); }
    if (!txMeta.has(e.tx))     { const t = await p.getTransaction(e.tx); txMeta.set(e.tx, t ? { from: t.from, to: t.to, gasLimit: t.gasLimit } : null); }
  }

  const trAddr = ethers.getAddress(A.tierRouter);
  console.log("time                                          matrix         net        when       sender             path              gasLimit   tx");
  console.log("─".repeat(140));
  let before = 0, after = 0, unknown = 0, relayed = 0;
  for (const e of events) {
    const ts = blockTs.get(e.block);
    const m  = txMeta.get(e.tx);
    const when = ts === null ? (unknown++, "UNKNOWN") : ts < FIX_LIVE ? (before++, "BEFORE fix") : (after++, "AFTER fix");
    let sender = "?", pathLabel = "?", gasNote = "?";
    if (m) {
      const self = ethers.getAddress(m.from) === who;
      sender = self ? "member (self)" : (relayed++, `RELAYED ${m.from.slice(0, 8)}…`);
      pathLabel = ethers.getAddress(m.to) === trAddr ? "router (1-sig)"
                : self ? "per-matrix leg" : "delegation mgr";
      gasNote = `${m.gasLimit}${self ? "" : " (relayer's)"}`;
    }
    console.log(`${ts === null ? "(block ts unreadable)".padEnd(45) : stamp(ts).padEnd(45)} ${e.label.padEnd(13)} ${usd(e.net + e.fee).padStart(9)}  ${when.padEnd(10)} ${sender.padEnd(18)} ${pathLabel.padEnd(17)} ${String(gasNote).padEnd(10)} ${e.tx.slice(0, 14)}…`);
  }

  console.log(`\nVERDICT`);
  if (holes.n) console.log(`  ${holes.n} range(s)/read(s) FAILED — every count below is a FLOOR. Re-run with WINDOW=3000 before trusting it.`);
  console.log(`  legs before the fix-live moment: ${before}   ·   after: ${after}${unknown ? `   ·   timestamp unreadable: ${unknown}` : ""}`);
  if (relayed) console.log(`  ${relayed} leg(s) were RELAYED (EIP-7702 smart account) — sender is not the member; timing`);
  if (relayed) console.log(`  and gas say nothing about which frontend build the member was on.`);
  console.log(`  Which BUILD the member saw is a branch question first: members are served MAIN`);
  console.log(`  (Vercel, verified 2026-08-12) — if the fix only reached admin, every member was on the old build.`);
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message || e); process.exit(1); });
