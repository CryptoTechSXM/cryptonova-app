// probe_addr_consistency.js — DOES THIS ADDRESS HAVE CODE, ACCORDING TO WHOM?
//
// Built 2026-08-21 (session 29) after a PHASE G deploy died like this:
//   MatrixPairFactory deployed at 0x52d4e8E1…, code confirmed (24498 bytes)
//   … three successful calls to it, including configureTier() one line earlier …
//   STALE NODE: still no code at 0x52d4e8E1… after 60s
// The same endpoint that had just transacted with the contract then reported it
// as codeless for twenty consecutive probes. That is not "the deploy has not
// propagated yet" — 28.1's reading — because the deploy had already propagated
// and been used. Two candidate explanations, and they are distinguishable:
//
//   (a) THE ENDPOINT is serving inconsistent state (a pool with a bad backend,
//       or a connection pinned to one). Then OTHER endpoints still see the code.
//   (b) A REORG dropped the block holding the deployment, so the contract really
//       is gone from the canonical chain. Then EVERY endpoint says 0x, and the
//       whole run's contracts are gone together.
//
// This asks every endpoint we have, at three block tags, and prints the answers
// side by side. It concludes nothing on one sample — it shows you the split.
//
// Read-only. Hosts only, never keys.
//
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\probe_addr_consistency.js 0xADDR [0xADDR2 ...]

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ADDRS = process.argv.slice(2).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
if (!ADDRS.length) { console.error("\n  Give me at least one 0x address.\n"); process.exit(1); }

const ENDPOINTS = [];
if (process.env.BASE_SEPOLIA_RPC_URL) ENDPOINTS.push(["RPC_URL (hardhat)", process.env.BASE_SEPOLIA_RPC_URL]);
if (process.env.BASE_SEPOLIA_RPC && process.env.BASE_SEPOLIA_RPC !== process.env.BASE_SEPOLIA_RPC_URL)
  ENDPOINTS.push(["RPC (diag scripts)", process.env.BASE_SEPOLIA_RPC]);
ENDPOINTS.push(["CONTROL (frequent-misty)", "https://frequent-misty-meme.base-sepolia.quiknode.pro/a71b4ace5a4da7005c54110096de8e422669824f/"]);
ENDPOINTS.push(["PUBLIC (sepolia.base.org)", "https://sepolia.base.org"]);

const host = (u) => { try { return new URL(u).host.split(".")[0]; } catch { return "unparseable"; } };
const pad  = (s, n) => String(s).padEnd(n);

async function rpc(url, method, params) {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status !== 200) return { err: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.error) return { err: `RPC ${j.error.code}` };
    return { val: j.result };
  } catch (e) { return { err: e.name === "TimeoutError" ? "TIMEOUT" : (e.message || "").slice(0, 30) }; }
}

const codeSize = (r) => r.err ? r.err : (!r.val || r.val === "0x" ? "*** 0x NO CODE ***" : ((r.val.length - 2) / 2) + " bytes");

(async () => {
  console.log("");
  console.log("ADDRESS CONSISTENCY PROBE — " + new Date().toISOString());
  console.log("");

  for (const [name, url] of ENDPOINTS) {
    const bn = await rpc(url, "eth_blockNumber", []);
    console.log(`  ${pad(name, 26)} ${pad(host(url), 26)} block ${bn.err || parseInt(bn.val, 16)}`);
  }

  for (const addr of ADDRS) {
    console.log("");
    console.log("  " + addr);
    console.log(`  ${pad("endpoint", 26)} ${pad("latest", 22)} ${pad("safe", 22)} finalized`);
    console.log("  " + "-".repeat(94));
    for (const [name, url] of ENDPOINTS) {
      const [l, s, f] = await Promise.all([
        rpc(url, "eth_getCode", [addr, "latest"]),
        rpc(url, "eth_getCode", [addr, "safe"]),
        rpc(url, "eth_getCode", [addr, "finalized"]),
      ]);
      console.log(`  ${pad(name, 26)} ${pad(codeSize(l), 22)} ${pad(codeSize(s), 22)} ${codeSize(f)}`);
    }
  }

  console.log("");
  console.log("=".repeat(96));
  console.log("  HOW TO READ THIS");
  console.log("  Some endpoints show code, others 0x  -> THE ENDPOINT is inconsistent. Deploy elsewhere.");
  console.log("  EVERY endpoint says 0x at every tag  -> the contracts are genuinely gone (reorg).");
  console.log("  Code at finalized but 0x at latest   -> the chain head is unstable right now. Wait.");
  console.log("=".repeat(96));
  console.log("");
})();
