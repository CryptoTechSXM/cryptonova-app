// diag_member_events.js — EVERY EVENT THAT NAMES ONE MEMBER, IN A BLOCK RANGE.  READ-ONLY.
//
// Written 2026-09-17 (session 87, handoff 62.64) for Noah's ticket. Measured 09-16/17 night:
// SF memberDebt $23.83 (T4 rescue), T5 RESCUE due 09-17 14:08Z (+$80), T1 LADDER refusal. Measured
// 09-17 ~14:05Z: SF memberDebt $0.0 AND no parked position at all. Two readings disagree; the
// disagreement is the finding. This tool reads WHAT HAPPENED to the member instead of explaining it.
//
// HOW: eth_getLogs with NO address filter and the member's address as topic1, topic2 or topic3
// (three queries per chunk), so every INDEXED appearance of the member in ANY contract is found —
// MemberParked, ParkedRescued, RescueDebtRepaid, SelfRescue, MemberEvicted, Transfer, … — decoded
// against every ABI in artifacts/. ⚠ An event where the member is NOT indexed is not found by this
// method; the footer says so rather than implying completeness.
//
// Run (PowerShell, from C:\CryptoNite-Smart-Contracts\CryptoNova):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_52.json"
//   $env:MEMBER="0x1acc02252bfb5c7434771bf848f6d77d11f60949"
//   $env:FROM="46910000"      # TO defaults to the chain head
//   node scripts/diag_member_events.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function die(m) { console.log(m); process.exit(1); }
const BOOK = (process.env.ADDRESSES_FILE || "").trim();
if (!BOOK) die("ADDRESSES_FILE not set.");
const MEMBER = (process.env.MEMBER || "").trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(MEMBER)) die("Set MEMBER to a 0x address.");
const FROM = Number(process.env.FROM);
if (!Number.isInteger(FROM) || FROM < 0) die("Set FROM (block number).");
const CHUNK = Number(process.env.CHUNK || 5000);
const RPC = (process.env.BASE_SEPOLIA_RPC_URL || "").trim();
if (!RPC) die("BASE_SEPOLIA_RPC_URL not set in .env.");

const book = JSON.parse(fs.readFileSync(path.join(__dirname, BOOK), "utf8"));
const LABEL = new Map();
(function walk(o, pre) {
  for (const [k, v] of Object.entries(o || {})) {
    const n = pre ? `${pre}.${k}` : k;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) { if (!LABEL.has(v.toLowerCase())) LABEL.set(v.toLowerCase(), n); }
    else if (v && typeof v === "object") walk(v, n);
  }
})(book, "");
LABEL.set(MEMBER.toLowerCase(), "MEMBER");
const lab = a => LABEL.get(String(a).toLowerCase()) || `${a.slice(0, 8)}…${a.slice(-4)}`;

const TOPICS = new Map();
(function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { scan(p); continue; }
    if (!f.name.endsWith(".json") || f.name.endsWith(".dbg.json")) continue;
    let j; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (!Array.isArray(j.abi)) continue;
    const evs = j.abi.filter(x => x.type === "event");
    if (!evs.length) continue;
    const iface = new ethers.Interface(evs);
    for (const ev of iface.fragments.filter(x => x.type === "event")) {
      if (!TOPICS.has(ev.topicHash)) TOPICS.set(ev.topicHash, []);
      TOPICS.get(ev.topicHash).push(iface);
    }
  }
})(path.join(__dirname, "..", "artifacts", "contracts"));
if (!TOPICS.size) die("No event ABIs under artifacts/contracts — run npx hardhat compile first.");

const USD6 = /amount|advance|short|fee|debt|balance|cost|paid|credit|reserve|loan|repaid|withdrawn|value/i;
const fmtArg = (name, v, emitter) => {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return `${name}=${lab(v)}`;
  if (typeof v === "bigint") {
    const isCnova = LABEL.get(emitter.toLowerCase()) === "cnova";
    return (USD6.test(name) && !isCnova) ? `${name}=${v} ($${(Number(v) / 1e6).toFixed(2)})` : `${name}=${v}`;
  }
  return `${name}=${String(v)}`;
};

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: ethers.Network.from(84532) });
  const head = await p.getBlockNumber();
  const TO = process.env.TO ? Math.min(Number(process.env.TO), head) : head;
  const topic = ethers.zeroPadValue(MEMBER.toLowerCase(), 32);
  console.log("=".repeat(96));
  console.log("diag_member_events.js — READ-ONLY. Nothing is signed or sent.");
  console.log(`book ${BOOK} | member ${MEMBER} | blocks ${FROM}..${TO} (chunk ${CHUNK}) | rpc host ${new URL(RPC).host}`);
  console.log("=".repeat(96));

  const seen = new Map();   // dedupe by txHash:logIndex
  let failedChunks = 0;
  for (let a = FROM; a <= TO; a += CHUNK) {
    const b = Math.min(a + CHUNK - 1, TO);
    for (const pos of [1, 2, 3]) {
      const topics = [null, null, null, null].slice(0, pos + 1); topics[pos] = topic;
      let logs = null;
      for (let t = 1; t <= 4 && !logs; t++) {
        try { logs = await p.getLogs({ fromBlock: a, toBlock: b, topics }); }
        catch (e) { if (t === 4) { console.log(`chunk ${a}..${b} topic${pos}: FAILED (${(e.shortMessage || e.message).slice(0, 60)}) — NOT covered`); failedChunks++; } else await new Promise(r => setTimeout(r, 500 * t)); }
      }
      for (const lg of logs || []) seen.set(`${lg.transactionHash}:${lg.index}`, lg);
    }
    process.stdout.write(`  scanned ${a}..${b}  (${seen.size} events so far)\n`);
  }

  const all = [...seen.values()].sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  const tsCache = new Map();
  let lastTx = "";
  for (const lg of all) {
    if (!tsCache.has(lg.blockNumber)) { try { tsCache.set(lg.blockNumber, (await p.getBlock(lg.blockNumber)).timestamp); } catch { tsCache.set(lg.blockNumber, null); } }
    const ts = tsCache.get(lg.blockNumber);
    if (lg.transactionHash !== lastTx) {
      console.log(`\nblock ${lg.blockNumber}  ${ts ? new Date(ts * 1000).toISOString().replace(".000", "") : "?"}  tx ${lg.transactionHash}`);
      lastTx = lg.transactionHash;
    }
    let out = null;
    for (const iface of TOPICS.get(lg.topics[0]) || []) {
      try { const d = iface.parseLog(lg); out = `${d.name}  ` + d.fragment.inputs.map((inp, i) => fmtArg(inp.name || `arg${i}`, d.args[i], lg.address)).join("  "); break; } catch {}
    }
    console.log(`  ${lab(lg.address).padEnd(24)} ${out || "UNDECODED topic0 " + lg.topics[0]}`);
  }
  console.log("\n" + "=".repeat(96));
  console.log(`events naming the member (indexed): ${all.length}   failed chunk queries: ${failedChunks}${failedChunks ? "  — INCOMPLETE" : ""}`);
  console.log("⚠ events where the member is a NON-indexed argument are not found by this method.");
}
main().catch(e => die("FAILED: " + (e.shortMessage || e.message)));
