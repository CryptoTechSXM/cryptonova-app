// check_deploy_rpc.js — IS THE ENDPOINT BIGFILL/DEPLOY ACTUALLY USES HEALTHY?
//
// Built 2026-08-19 (session 9) after a bigfill run died with a wall of
// `HH110: Invalid JSON-RPC response received` while `watch_base_sepolia.mjs` was
// simultaneously reporting the network as fine.
//
// ⛔ BOTH WERE RIGHT, AND THAT IS THE POINT. They were watching different endpoints.
//   watch_base_sepolia.mjs   -> QuickNode EP1 + Coinbase public  (the SITE's read pool)
//   hardhat / bigfill        -> BASE_SEPOLIA_RPC from .env       (a SIXTH endpoint,
//                               fluent-neat-moon, in NO pool and in no monitor)
// So the monitor could not observe the failure it was being used to rule out. That is the
// session's recurring trap — an instrument reporting on a slice that does not contain the
// thing under test — and it is why this script exists: it probes THE ENDPOINT THE RUN
// ACTUALLY USES, read straight out of .env, and compares it against a known control.
//
// Symptoms this explains if the deploy endpoint is the sick one:
//   · HH110 on dozens of consecutive wallets while the site stays up
//   · "top-up DID NOT LAND — send reported success but balance did not change"
//     (a stale read after a confirmed transfer)
//   · "nonce too low: next nonce 418, tx nonce 417" and "replacement transaction
//     underpriced" — nonce tracking desyncs when the node answers from stale state
//
// Read-only. Prints HOSTS ONLY, never the API keys.
//
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\check_deploy_rpc.js
//   node scripts\check_deploy_rpc.js 10      (10 rounds instead of 5)

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROUNDS = Number(process.argv[2] || 5);

// ⛔ MEASURED 2026-08-21 (session 29), AND IT IS THE SAME TRAP THIS FILE'S HEADER DESCRIBES.
// This script used to prefer BASE_SEPOLIA_RPC. hardhat.config.js reads BASE_SEPOLIA_RPC_URL
// and ONLY that. On the owner's machine the two names hold DIFFERENT endpoints:
//     BASE_SEPOLIA_RPC      -> fluent-neat-moon
//     BASE_SEPOLIA_RPC_URL  -> cosmopolitan-still-fire   <- what deploys actually ran on
// So every "the endpoint is healthy" verdict this script gave during the four failed
// session-28 deploys was graded on an endpoint hardhat was not using. Precedence is now
// hardhat's, and when both names are set and differ, BOTH are probed and the mismatch is
// printed at the top where it cannot be missed.
const HARDHAT_RPC = process.env.BASE_SEPOLIA_RPC_URL;
const LEGACY_RPC  = process.env.BASE_SEPOLIA_RPC;
const DEPLOY_RPC  = HARDHAT_RPC || LEGACY_RPC;
if (!DEPLOY_RPC) { console.error("\n  Neither BASE_SEPOLIA_RPC_URL nor BASE_SEPOLIA_RPC is set in .env — nothing to check.\n"); process.exit(1); }
const SPLIT_BRAIN = Boolean(HARDHAT_RPC && LEGACY_RPC && HARDHAT_RPC !== LEGACY_RPC);

// A control the site is known to use. If the deploy endpoint fails while this one passes,
// the fault is the endpoint, not Base Sepolia.
const CONTROL = "https://frequent-misty-meme.base-sepolia.quiknode.pro/a71b4ace5a4da7005c54110096de8e422669824f/";

// T1 MatA occupancy() — the same call the site's watcher uses, so the two are comparable.
const CALL_TO = "0x7154485C8b630d13902CdAeAe80429734f0ac79c";
const CALL_DATA = "0x3f728455";

const host = (u) => { try { return new URL(u).host; } catch { return "unparseable"; } };
const pad = (s, n) => String(s).padEnd(n);

async function probe(url, method, params) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    if (r.status !== 200) return { ok: false, why: `HTTP ${r.status}`, ms: Date.now() - t0 };
    let j; try { j = JSON.parse(txt); } catch { return { ok: false, why: "NON-JSON body (this is what HH110 reports)", ms: Date.now() - t0 }; }
    if (j.error) return { ok: false, why: `RPC ${j.error.code} ${String(j.error.message).slice(0, 40)}`, ms: Date.now() - t0 };
    return { ok: true, val: j.result, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, why: (e.name === "TimeoutError" ? "TIMEOUT" : (e.message || "").slice(0, 50)), ms: Date.now() - t0 };
  }
}

(async () => {
  console.log("");
  console.log("DEPLOY-ENDPOINT HEALTH — " + new Date().toISOString());
  console.log(`  bigfill / hardhat uses : ${host(DEPLOY_RPC)}   <- .env ${HARDHAT_RPC ? "BASE_SEPOLIA_RPC_URL" : "BASE_SEPOLIA_RPC"} (hardhat.config.js reads BASE_SEPOLIA_RPC_URL)`);
  console.log(`  control                : ${host(CONTROL)}   <- known-good, site read pool`);
  if (SPLIT_BRAIN) {
    console.log("");
    console.log("  " + "!".repeat(78));
    console.log(`  !! .env HOLDS TWO DIFFERENT ENDPOINTS UNDER TWO NAMES.`);
    console.log(`  !!   BASE_SEPOLIA_RPC_URL -> ${host(HARDHAT_RPC)}   (hardhat / deploy / bigfill / testchain_keeper)`);
    console.log(`  !!   BASE_SEPOLIA_RPC     -> ${host(LEGACY_RPC)}   (some plain-node diag scripts)`);
    console.log(`  !! Both are probed below. Until they name the SAME healthy endpoint, a health`);
    console.log(`  !! verdict here can be about a node the run under test never touches.`);
    console.log("  " + "!".repeat(78));
  }
  console.log(`  ${ROUNDS} rounds, each: eth_blockNumber + eth_getCode + eth_call\n`);
  console.log(`  ${pad("endpoint", 26)} ${pad("blockNumber", 16)} ${pad("getCode", 16)} eth_call`);
  console.log("  " + "-".repeat(78));

  const score = {};
  // ⚠ DEPLOY must stay index 0 and CONTROL index 1 — the verdict below reads them by position.
  const targets = [["DEPLOY (" + host(DEPLOY_RPC).split(".")[0] + ")", DEPLOY_RPC], ["CONTROL (frequent-misty)", CONTROL]];
  if (SPLIT_BRAIN) targets.push(["OTHER (" + host(LEGACY_RPC).split(".")[0] + ")", LEGACY_RPC]);
  for (const [name, url] of targets) {
    score[name] = { bn: 0, gc: 0, ec: 0 };
    for (let i = 0; i < ROUNDS; i++) {
      const bn = await probe(url, "eth_blockNumber", []);
      const gc = await probe(url, "eth_getCode", [CALL_TO, "latest"]);
      const ec = await probe(url, "eth_call", [{ to: CALL_TO, data: CALL_DATA }, "latest"]);
      if (bn.ok) score[name].bn++; if (gc.ok) score[name].gc++; if (ec.ok) score[name].ec++;
      if (i === 0 || !bn.ok || !gc.ok || !ec.ok) {
        console.log(`  ${pad(name, 26)} ${pad(bn.ok ? "ok " + bn.ms + "ms" : bn.why, 16)} ${pad(gc.ok ? "ok " + gc.ms + "ms" : gc.why, 16)} ${ec.ok ? "ok " + ec.ms + "ms" : ec.why}`);
      }
    }
  }

  console.log("\n  PASS RATES over " + ROUNDS + " rounds");
  for (const [name, s] of Object.entries(score)) {
    console.log(`  ${pad(name, 26)} blockNumber ${s.bn}/${ROUNDS}   getCode ${s.gc}/${ROUNDS}   eth_call ${s.ec}/${ROUNDS}`);
  }

  const d = score[Object.keys(score)[0]], c = score[Object.keys(score)[1]];
  const dBad = d.ec < ROUNDS || d.gc < ROUNDS || d.bn < ROUNDS;
  const cBad = c.ec < ROUNDS || c.gc < ROUNDS || c.bn < ROUNDS;
  console.log("\n" + "=".repeat(82));
  if (dBad && !cBad) {
    console.log("  THE DEPLOY ENDPOINT IS THE PROBLEM, NOT BASE SEPOLIA.");
    console.log("  The control answered every call while the endpoint bigfill uses did not.");
    console.log("  FIX: point BASE_SEPOLIA_RPC_URL in .env (the one hardhat reads) at a healthy");
    console.log("  endpoint — and set BASE_SEPOLIA_RPC to the SAME value — then re-run. The");
    console.log("  HH110 wall, the 'top-up DID NOT LAND' lines and the nonce errors are all");
    console.log("  downstream of this — none of them are contract faults.");
  } else if (dBad && cBad) {
    console.log("  BOTH endpoints are failing — this is Base Sepolia, not one provider.");
    console.log("  Use watch_base_sepolia.mjs and wait for a clean streak before any run whose");
    console.log("  numbers you intend to trust.");
  } else if (!dBad && cBad) {
    console.log("  The deploy endpoint is fine and the CONTROL is failing — the site's read pool");
    console.log("  is the degraded one. Members are affected; bigfill is not.");
  } else {
    console.log("  Both endpoints healthy right now. If a run just failed, the fault was");
    console.log("  INTERMITTENT — re-run this with more rounds (e.g. 20) before concluding.");
    console.log("  One clean sample is not a measurement.");
  }
  if (SPLIT_BRAIN) {
    const o = score[Object.keys(score)[2]];
    console.log("");
    console.log(`  OTHER endpoint (BASE_SEPOLIA_RPC, ${host(LEGACY_RPC).split(".")[0]}): blockNumber ${o.bn}/${ROUNDS}  getCode ${o.gc}/${ROUNDS}  eth_call ${o.ec}/${ROUNDS}`);
    console.log("  Pick whichever of the two scored clean and put it under BOTH names in .env.");
  }
  console.log("=".repeat(82) + "\n");
})();
