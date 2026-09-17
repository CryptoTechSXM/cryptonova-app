// diag_block_events.js — WHAT DID A SENDER'S TRANSACTIONS ACTUALLY DO?  READ-ONLY.
//
// Written 2026-09-17 (session 87, handoff 62.64). The private V8.54 sandbox keeper sent six
// performUpkeep txs at 12:52Z: the first used 486,876 gas and force-rotated T1.1 MatB; the next
// FIVE used exactly 154,533 gas each and changed nothing any read-only tool could see, while
// checkUpkeep kept reporting work. Gas figures and state reads cannot say what those five did.
// Their EVENTS can. This prints every log of every tx the SENDER sent in a block range, decoded
// by event name against every ABI in artifacts/, with the emitter named from the address book.
//
// Nothing is signed. No key is read. Unknown topics print as UNDECODED with the raw topic —
// an event this tool cannot name is still reported, never dropped.
//
// Run (PowerShell, from C:\CryptoNite-Smart-Contracts\CryptoNova):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_54_private.json"
//   $env:FROM="46940625"; $env:TO="46940650"
//   $env:SENDER="0xd419681BA72992636f05e256168681c939826B4b"
//   node scripts/diag_block_events.js
// Needs: artifacts/ compiled (npx hardhat compile), BASE_SEPOLIA_RPC_URL in .env.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function die(m) { console.log(m); process.exit(1); }
const BOOK = (process.env.ADDRESSES_FILE || "").trim();
if (!BOOK) die("ADDRESSES_FILE not set.");
const FROM = Number(process.env.FROM), TO = Number(process.env.TO);
if (!Number.isInteger(FROM) || !Number.isInteger(TO) || TO < FROM) die("Set FROM and TO block numbers (TO >= FROM).");
if (TO - FROM > 500) die("Range over 500 blocks — narrow it.");
const SENDER = (process.env.SENDER || "").trim().toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(SENDER)) die("Set SENDER to the address whose txs to decode.");
const RPC = (process.env.BASE_SEPOLIA_RPC_URL || "").trim();
if (!RPC) die("BASE_SEPOLIA_RPC_URL not set in .env.");

// ── labels from the book (recursively) ──
const book = JSON.parse(fs.readFileSync(path.join(__dirname, BOOK), "utf8"));
const LABEL = new Map();
(function walk(o, pre) {
  for (const [k, v] of Object.entries(o || {})) {
    const name = pre ? `${pre}.${k}` : k;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) { if (!LABEL.has(v.toLowerCase())) LABEL.set(v.toLowerCase(), name); }
    else if (v && typeof v === "object") walk(v, name);
  }
})(book, "");
const short = a => `${a.slice(0, 8)}…${a.slice(-4)}`;
const lab = a => LABEL.get(a.toLowerCase()) || short(a);

// ── every event ABI in artifacts/ ──
const TOPICS = new Map();   // topic0 -> [{iface, contract}]
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
      const t = ev.topicHash;
      if (!TOPICS.has(t)) TOPICS.set(t, []);
      TOPICS.get(t).push({ iface, contract: j.contractName });
    }
  }
})(path.join(__dirname, "..", "artifacts", "contracts"));
if (!TOPICS.size) die("No event ABIs found under artifacts/contracts — run npx hardhat compile first.");

const fmtArg = (name, v) => {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return `${name}=${lab(v)}`;
  if (typeof v === "bigint") {
    const usdish = /amount|advance|short|fee|debt|balance|value|cost|paid|credit|reserve|loan/i.test(name);
    return usdish ? `${name}=${v} ($${(Number(v) / 1e6).toFixed(2)})` : `${name}=${v}`;
  }
  return `${name}=${String(v)}`;
};

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: ethers.Network.from(84532) });
  console.log("=".repeat(96));
  console.log("diag_block_events.js — READ-ONLY. Nothing is signed or sent.");
  console.log(`book ${BOOK} | blocks ${FROM}..${TO} | sender ${SENDER} | rpc host ${new URL(RPC).host} | event ABIs ${TOPICS.size}`);
  console.log("=".repeat(96));
  // ⛔ CLAMP TO THE CHAIN HEAD. RE-APPLIED 2026-09-17 (session 88) — 62.64 recorded this fix
  // as done (md5 bde76d40) and it was NOT in the file or in git; the only commit is 8d6935b,
  // the pre-clamp version. A fix that exists only in a handoff line is not a fix.
  //
  // WHY IT MATTERS: a range whose TO is past the head prints one "UNREADABLE — this block is
  // NOT covered" line per missing block (319 of them, measured), which reads exactly like an
  // RPC failure over real blocks. A block that does not exist yet and a block we failed to
  // read are different facts and must not share a message.
  let head = null;
  for (let t = 1; t <= 3 && head === null; t++) {
    try { head = await p.getBlockNumber(); } catch { await new Promise(r => setTimeout(r, 400 * t)); }
  }
  let to = TO;
  if (head === null) {
    console.log("⚠ could not read the chain head — scanning the full range as given; blocks past the head will read UNREADABLE.");
  } else if (TO > head) {
    to = head;
    console.log(`▶ TO ${TO} is past the chain head ${head} — clamped to ${to}. Blocks ${head + 1}..${TO} do not exist yet and are NOT reported as unreadable.`);
  }
  if (FROM > to) die(`FROM ${FROM} is past the chain head ${head} — nothing to scan.`);

  let txs = 0, unknownBlocks = 0;
  for (let b = FROM; b <= to; b++) {
    let blk = null;
    for (let t = 1; t <= 4 && !blk; t++) { try { blk = await p.getBlock(b, true); } catch { await new Promise(r => setTimeout(r, 400 * t)); } }
    if (!blk) { console.log(`block ${b}: UNREADABLE — this block is NOT covered`); unknownBlocks++; continue; }
    for (const tx of blk.prefetchedTransactions) {
      if ((tx.from || "").toLowerCase() !== SENDER) continue;
      txs++;
      const rc = await p.getTransactionReceipt(tx.hash);
      const sel = (tx.data || "0x").slice(0, 10);
      console.log(`\nblock ${b}  tx ${tx.hash}`);
      console.log(`  to ${tx.to ? lab(tx.to) : "(create)"}  selector ${sel}  status ${rc.status === 1 ? "OK" : "FAILED"}  gasUsed ${rc.gasUsed}  logs ${rc.logs.length}`);
      for (const lg of rc.logs) {
        const cands = TOPICS.get(lg.topics[0]) || [];
        let done = false;
        for (const c of cands) {
          try {
            const d = c.iface.parseLog(lg);
            const args = d.fragment.inputs.map((inp, i) => fmtArg(inp.name || `arg${i}`, d.args[i])).join("  ");
            console.log(`  #${lg.index} ${lab(lg.address).padEnd(22)} ${d.name}  ${args}`);
            done = true; break;
          } catch { /* try the next ABI with this topic */ }
        }
        if (!done) console.log(`  #${lg.index} ${lab(lg.address).padEnd(22)} UNDECODED topic0 ${lg.topics[0]}`);
      }
    }
  }
  console.log("\n" + "=".repeat(96));
  console.log(`txs from sender: ${txs}   unreadable blocks: ${unknownBlocks}${unknownBlocks ? "  — INCOMPLETE, not a full answer" : ""}`);
}
main().catch(e => die("FAILED: " + (e.shortMessage || e.message)));
