"use strict";
/**
 * rpc_resilience.js — SURVIVE BASE SEPOLIA SHEDDING STATE READS.
 *
 * USE — one line, at the top of ANY hardhat script:
 *     require("./rpc_resilience");
 *
 * WHY THIS EXISTS, MEASURED 2026-08-21 (handoff 29.2). Three health runs eight minutes
 * apart, each of three QuickNode endpoints healthy at one sample and HTTP 503 on every
 * state call at another, while eth_blockNumber answered 20/20 on all of them throughout —
 * and Coinbase's public endpoint 503'd alongside them. Base Sepolia sheds STATE reads
 * across providers; it does not stop producing blocks. Two things follow:
 *   - retrying the SAME endpoint is the wrong move (a healthy one usually exists), and
 *   - a long run dies on a single blip unless something absorbs it. A deploy is hundreds
 *     of sequential calls; bigfill is thousands.
 *
 * WHERE IT PATCHES, AND WHY IT TOOK FOUR TRIES (handoff 29.3b). Hardhat's wrapper
 * providers call `this._wrappedProvider.request(...)` DIRECTLY, so patching the provider
 * hardhat hands you never sees them — a deploy died at
 *     HH110 ... at AutomaticGasPriceProvider._getGasPrice (gas-providers.ts:221)
 * having never entered the retry. Walking the chain failed too: at require time the object
 * is a LazyInitializationProviderAdapter and the real chain does not exist yet.
 * So this patches the CLASS — `HttpProvider.prototype.request`. Every instance, no
 * walking, no timing, no lazy anything.
 *
 * SENDS ARE NEVER RETRIED AND NEVER MOVED. After local signing a send is
 * `eth_sendRawTransaction`, deliberately absent from RETRYABLE. It may have landed before
 * the transport failed, and re-sending it is how you get a duplicate and a wrecked nonce.
 * A failed send still aborts the run, loudly, which is the correct outcome.
 *
 * IT DOES NOT COVER PLAIN-NODE SCRIPTS. Anything that builds its own
 * `new ethers.JsonRpcProvider(...)` — diag_keeper_gas_live.js, model_item_a.js,
 * diag_sf_debt_reconcile.js, audit_frontend_abi.js — never constructs a hardhat
 * HttpProvider, so this is inert there. Those need their own treatment; do not assume
 * requiring this file protected them.
 */

if (!global.__cnova_rpc_resilience__) {
  global.__cnova_rpc_resilience__ = true;   // idempotent: requiring twice must not double-retry

  const path = require("path");
  try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

  const RPC_RETRIES = Number(process.env.RPC_RETRIES || 5);

  // Reads only. If a method is not on this list it passes straight through untouched.
  const RETRYABLE = new Set([
    "eth_call", "eth_getCode", "eth_estimateGas", "eth_blockNumber", "eth_chainId",
    "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionReceipt",
    "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_getBlockByHash",
    "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas", "eth_getLogs",
    "eth_getStorageAt", "eth_accounts", "eth_syncing", "net_version",
  ]);

  // MEASURED 2026-08-21, from a false positive in diag_keeper_work.js: a legitimate
  // `execution reverted: "MK: not authorized keeper"` was retried FIVE times and then
  // tripped the circuit breaker, which routed a minute of perfectly good reads to
  // fallbacks. Two bugs in one line:
  //   1. bare 3-digit codes (503|502|504|429) were matched against a message that
  //      EMBEDS THE FULL CALLDATA AS HEX - a long hex blob contains "503" by chance.
  //      Numeric codes must be anchored to "HTTP"/"status" or they match noise.
  //   2. a REVERT IS AN ANSWER, NOT A TRANSPORT FAILURE. The node replied, correctly,
  //      and retrying cannot change the reply. It must bail before anything else.
  function looksTransient(e) {
    const code = String((e && e.code) || "");
    const msg  = String((e && e.message) || e || "");
    if (code === "CALL_EXCEPTION" || /execution reverted|CALL_EXCEPTION/i.test(msg)) return false;
    if (/^(SERVER_ERROR|NETWORK_ERROR|TIMEOUT)$/.test(code)) return true;
    return /HH110|Invalid JSON-RPC|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network socket|fetch failed|bad response|unexpected token|\bHTTP\s*(429|50[234])\b|status\s*(429|50[234])\b|timed?\s?out/i.test(msg);
  }
  const hostOf = (u) => { try { return new URL(u).host.split(".")[0]; } catch { return "?"; } };
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));

  function rawRpcAt(url, method, params) {
    return fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }),
      signal: AbortSignal.timeout(15000),
    }).then(async (r) => {
      if (r.status !== 200) return { ok: false };
      const j = await r.json();
      return j.error ? { ok: false } : { ok: true, val: j.result };
    }).catch(() => ({ ok: false }));
  }

  // Deduplicated against whatever hardhat resolved, so the primary is never re-tried as
  // a "fallback" — that was the bug in the first version of this.
  function fallbackUrls() {
    const seen = new Set(), out = [];
    try { seen.add(require("hardhat").network.config.url); } catch {}
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
    (process.env.FALLBACK_RPCS || "").split(",").map(x => x.trim()).filter(Boolean).forEach(add);
    add(process.env.BASE_SEPOLIA_RPC);
    add(process.env.BASE_SEPOLIA_RPC_URL);
    add("https://sepolia.base.org");
    return out;
  }

  const FALLBACKS = fallbackUrls();
  let retried = 0, failedOver = 0, viaBreaker = 0;

  // -- CIRCUIT BREAKER --------------------------------------------------------
  // MEASURED during G.1, 2026-08-21: the primary failed EVERY eth_call for minutes
  // while a fallback answered every one. Fail-over alone still pays a doomed attempt
  // plus a fallback round trip on every single read - correct, but slow enough to
  // matter over the thousands of calls a bigfill makes.
  // So: after COOL_AFTER consecutive transient failures, stop asking the primary first
  // for COOL_MS. Reads go straight to the fallbacks; the primary is retried once the
  // window expires, because 29.2 measured that these outages ROTATE - today's dead
  // endpoint is tomorrow's healthy one, and pinning away from it permanently would be
  // the same mistake in the other direction.
  const COOL_AFTER = Number(process.env.RPC_COOL_AFTER || 5);
  const COOL_MS    = Number(process.env.RPC_COOL_MS    || 60000);
  let consecutive = 0, coolUntil = 0;

  async function tryFallbacks(args) {
    for (const u of FALLBACKS) {
      const r = await rawRpcAt(u, args.method, args.params);
      if (r.ok) return { ok: true, val: r.val, host: hostOf(u) };
    }
    return { ok: false };
  }

  function wrap(original) {
    return async function (args) {
      if (!RETRYABLE.has(args && args.method)) return original.call(this, args);

      // Primary is cooling off - go straight to the fallbacks.
      if (Date.now() < coolUntil) {
        const alt = await tryFallbacks(args);
        if (alt.ok) { viaBreaker++; return alt.val; }
        coolUntil = 0;            // every fallback is down too; give the primary a go
      }

      let lastErr;
      for (let i = 1; i <= RPC_RETRIES; i++) {
        try {
          const out = await original.call(this, args);
          consecutive = 0;
          return out;
        }
        catch (e) {
          if (!looksTransient(e)) throw e;
          lastErr = e; retried++; consecutive++;
          if (consecutive === COOL_AFTER) {
            coolUntil = Date.now() + COOL_MS;
            console.log(`  ~~  primary has failed ${COOL_AFTER} reads in a row - routing reads to fallbacks for ${COOL_MS / 1000}s, then retrying it.`);
          } else {
            console.log(`  !!  ${args.method} failed (${String(e.message).slice(0, 70)}) - retry ${i}/${RPC_RETRIES}`);
          }
          const alt = await tryFallbacks(args);
          if (alt.ok) {
            failedOver++;
            console.log(`  ->  served ${args.method} from ${alt.host} instead`);
            return alt.val;
          }
          await sleep(2000 * i);
        }
      }
      console.log(`  XX  ${args.method} failed on the primary AND every fallback - state reads are down everywhere.`);
      throw lastErr;
    };
  }

  const installedOn = [];

  // (a) hardhat scripts: every call funnels through HttpProvider.request.
  try {
    const { HttpProvider } = require("hardhat/internal/core/providers/http");
    HttpProvider.prototype.request = wrap(HttpProvider.prototype.request);
    installedOn.push("hardhat HttpProvider.prototype");
  } catch { /* not a hardhat script - normal for the plain-node diagnostics */ }

  // (b) PLAIN-NODE scripts. diag_keeper_work.js, diag_keeper_gas_live.js (G.3),
  //     model_item_a.js (G.5) and diag_sf_debt_reconcile.js (G.6) build their own
  //     `new ethers.JsonRpcProvider(...)` and never construct a hardhat HttpProvider,
  //     so (a) is INERT for them. Against the network measured on 2026-08-21 - a G.1
  //     run needing 8,609 retries, 8,583 of them served by a different endpoint -
  //     they would die on their first read. In ethers v6 every read funnels through
  //     JsonRpcApiProvider.prototype.send, so that is the equivalent choke point.
  //     Same rule as everywhere else: eth_sendRawTransaction is not on RETRYABLE and
  //     passes straight through, so a broadcast is never repeated.
  try {
    const { JsonRpcApiProvider } = require("ethers");
    const origSend = JsonRpcApiProvider.prototype.send;
    JsonRpcApiProvider.prototype.send = async function (method, params) {
      if (!RETRYABLE.has(method)) return origSend.call(this, method, params);
      const args = { method, params };
      if (Date.now() < coolUntil) {
        const alt = await tryFallbacks(args);
        if (alt.ok) { viaBreaker++; return alt.val; }
        coolUntil = 0;
      }
      let lastErr;
      for (let i = 1; i <= RPC_RETRIES; i++) {
        try { const out = await origSend.call(this, method, params); consecutive = 0; return out; }
        catch (e) {
          if (!looksTransient(e)) throw e;
          lastErr = e; retried++; consecutive++;
          if (consecutive === COOL_AFTER) {
            coolUntil = Date.now() + COOL_MS;
            console.log(`  ~~  primary has failed ${COOL_AFTER} reads in a row - routing reads to fallbacks for ${COOL_MS / 1000}s, then retrying it.`);
          } else {
            console.log(`  !!  ${method} failed (${String(e.message).slice(0, 70)}) - retry ${i}/${RPC_RETRIES}`);
          }
          const alt = await tryFallbacks(args);
          if (alt.ok) { failedOver++; console.log(`  ->  served ${method} from ${alt.host} instead`); return alt.val; }
          await sleep(2000 * i);
        }
      }
      throw lastErr;
    };
    installedOn.push("ethers JsonRpcApiProvider.prototype.send");
  } catch { /* ethers not resolvable - leave a gap rather than a false claim */ }

  console.log(`  rpc resilience: ${installedOn.length ? installedOn.join(" + ") : "NOT INSTALLED - this run has NO transport retry"}`);
  console.log(`  read fail-over endpoints: ${FALLBACKS.map(hostOf).join(", ") || "(none)"}`);

  process.on("exit", () => {
    if (retried || viaBreaker) console.log(`\n  transport retries this run: ${retried} (${failedOver} served by a fallback after a failure, ${viaBreaker} routed straight to a fallback by the circuit breaker)`);
  });

  module.exports = { rawRpcAt, fallbackUrls, hostOf, looksTransient, RETRYABLE };
}
