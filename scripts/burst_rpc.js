// burst_rpc.js — AT WHAT REQUEST RATE DOES THIS ENDPOINT START REFUSING?
//
// Built 2026-08-19 (session 9). A bigfill run died on a wall of
// `HH110: Invalid JSON-RPC response received`, yet check_deploy_rpc.js then found the same
// endpoint answering 5/5 on every method. BOTH RESULTS ARE REAL — a gentle probe and a
// 53-wallet sweep are not the same load, and only one of them failed.
//
// ⛔ SO THE QUESTION IS NOT "IS THE ENDPOINT UP". IT IS "AT WHAT RATE DOES IT STOP
//    ANSWERING". A single sequential probe cannot observe a rate limit — it never reaches
//    one. That is the same instrument-scope error that has cost this session five times
//    today, so this script applies the load instead of asking politely.
//
// THIS IS NOT A NEW HYPOTHESIS — IT IS THIS PROJECT'S OWN OPERATIONAL HISTORY. A keeper
// failure on 2026-08-07 was traced to "QuickNode 50/sec cap on endpoint #1" with fastlane,
// copay and direct all sharing one endpoint; the fix was pinning jobs to separate ones.
// The bigfill endpoint (fluent-neat-moon) is 3x slower than the site's EP1 at rest
// (575ms vs 173ms on eth_blockNumber), which is itself consistent with a busier or
// lower-tier endpoint.
//
// WHAT IT DOES: fires N genuinely simultaneous eth_call requests, for N = 1,5,10,20,40,80,
// and reports how many came back OK, how many were refused, and what the refusal looked
// like. Any non-JSON body is flagged explicitly, because THAT is what hardhat surfaces as
// HH110 — the same error the run died on.
//
// ⚠ READ THE FAILURE MODE, NOT JUST THE COUNT. A clean 80/80 means the ceiling is above 80
//   and the run failed for some other reason. A cliff between two levels IS the rate limit.
//
// Read-only. Hosts printed, keys never.
//
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\burst_rpc.js
//   node scripts\burst_rpc.js 3          (3 passes at each level, default 2)

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PASSES = Number(process.argv[2] || 2);
const DEPLOY_RPC = process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_RPC_URL;
if (!DEPLOY_RPC) { console.error("\n  BASE_SEPOLIA_RPC is not set in .env.\n"); process.exit(1); }
const CONTROL = "https://frequent-misty-meme.base-sepolia.quiknode.pro/a71b4ace5a4da7005c54110096de8e422669824f/";

const CALL_TO = "0x7154485C8b630d13902CdAeAe80429734f0ac79c";
const CALL_DATA = "0x3f728455";                       // occupancy()
const LEVELS = [1, 5, 10, 20, 40, 80];

const host = (u) => { try { return new URL(u).host.split(".")[0]; } catch { return "?"; } };
const pad = (s, n) => String(s).padEnd(n);

async function one(url, id) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: CALL_TO, data: CALL_DATA }, "latest"] }),
      signal: AbortSignal.timeout(20000),
    });
    const txt = await r.text();
    const ms = Date.now() - t0;
    if (r.status === 429) return { ok: false, kind: "429 rate limited", ms };
    if (r.status !== 200) return { ok: false, kind: `HTTP ${r.status}`, ms };
    try { const j = JSON.parse(txt); return j.error ? { ok: false, kind: `RPC ${j.error.code}`, ms } : { ok: true, ms }; }
    catch { return { ok: false, kind: "NON-JSON body  <-- THIS IS WHAT HH110 REPORTS", ms }; }
  } catch (e) {
    return { ok: false, kind: e.name === "TimeoutError" ? "TIMEOUT" : (e.message || "").slice(0, 40), ms: Date.now() - t0 };
  }
}

(async () => {
  console.log("");
  console.log("RPC BURST TEST — " + new Date().toISOString());
  console.log(`  DEPLOY  : ${host(DEPLOY_RPC)}   (what bigfill/hardhat uses)`);
  console.log(`  CONTROL : ${host(CONTROL)}   (site read pool EP1)`);
  console.log(`  ${PASSES} pass(es) per level. Concurrency levels: ${LEVELS.join(", ")}\n`);

  const results = {};
  for (const [name, url] of [["DEPLOY " + host(DEPLOY_RPC), DEPLOY_RPC], ["CONTROL " + host(CONTROL), CONTROL]]) {
    console.log(`  ${name}`);
    console.log(`    ${pad("concurrency", 13)} ${pad("ok", 9)} ${pad("failed", 9)} ${pad("p50 ms", 9)} failure mode`);
    console.log("    " + "-".repeat(74));
    results[name] = [];
    for (const n of LEVELS) {
      let ok = 0, fail = 0; const lat = []; const kinds = {};
      for (let pass = 0; pass < PASSES; pass++) {
        const res = await Promise.all(Array.from({ length: n }, (_, i) => one(url, i)));
        for (const r of res) {
          if (r.ok) { ok++; lat.push(r.ms); } else { fail++; kinds[r.kind] = (kinds[r.kind] || 0) + 1; }
        }
        await new Promise((r) => setTimeout(r, 1200));   // let any window reset between passes
      }
      lat.sort((a, b) => a - b);
      const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : "-";
      const mode = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(", ") || "";
      console.log(`    ${pad(n, 13)} ${pad(ok, 9)} ${pad(fail, 9)} ${pad(p50, 9)} ${mode}`);
      results[name].push({ n, ok, fail });
    }
    console.log("");
  }

  console.log("=".repeat(84));
  for (const [name, rows] of Object.entries(results)) {
    const firstFail = rows.find((r) => r.fail > 0);
    if (!firstFail) console.log(`  ${name}: no refusals up to ${LEVELS[LEVELS.length - 1]} concurrent. Ceiling is ABOVE this test.`);
    else console.log(`  ${name}: first refusals at concurrency ${firstFail.n} (${firstFail.fail} of ${firstFail.ok + firstFail.fail}).`);
  }
  console.log("");
  console.log("  READ IT THIS WAY:");
  console.log("   · DEPLOY refuses at a LOWER level than CONTROL -> bigfill is out-running its");
  console.log("     endpoint. Fix is pacing or a bigger endpoint, NOT a contract change, and the");
  console.log("     HH110 wall / stale top-ups / nonce errors are all downstream of it.");
  console.log("   · BOTH refuse at the same low level -> it is the provider tier, not this endpoint.");
  console.log("   · NEITHER refuses -> the run's failure was NOT a rate limit. Re-run the sweep and");
  console.log("     capture the exact moment it breaks before changing anything.");
  console.log("=".repeat(84) + "\n");
})();
