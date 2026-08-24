"use strict";
/**
 * deploy_v8.js  --  V8.35 Full Deploy  (all 10 tiers, MATRIX_SIZE=127, auto-keeper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys the complete V8.35 stack:
 *
 *   Shared:   MockUSDC (testnet only)
 *             CNOVAToken · CNOVATreasury
 *             StabilityFund (+ 1% L1 carve to CommunityWallet)
 *             CommunityWallet (First-1000 lifetime USDC pool, 60/40 Genesis/Pioneer)
 *             TierRouter
 *             MatrixFactory (registry / wiring hub)
 *             MatrixPairFactory (autonomous on-chain pair expansion — no hard cap)
 *             MatrixKeeper  (Chainlink Automation upkeep)
 *             V8Governance  (DAO)
 *
 *   Per tier: PairManagerV8 · MatA · MatB  (1 pair per tier at deploy)
 *             MatrixPairFactory auto-deploys new pairs inline when a pair hits 80%.
 *
 * V8.35 CHANGES vs V8.34
 * --------------------
 *   - MatrixPairFactory: autonomous on-chain pair expansion eliminates the hard cap.
 *     When the active pair reaches 80% occupancy and no next pair is pre-deployed,
 *     the factory deploys a fresh MatA+MatB, wires all permissions, and routes the
 *     triggering member into the new pair — all in the same transaction.
 *   - Whale Gate redesign: per-tier pioneer thresholds (T5=25, T6=15, T7=10, T8-T10=5).
 *     T2-T5 share T5's gate. Governance params #52-57. bulkUpgrade() for whale entry.
 *   - PAIRS_PER_TIER simplified to all-1s — factory replaces static multi-pair deploy.
 *
 * ARCHITECTURE NOTE
 * -----------------
 * MatrixFactory no longer deploys FigureEightMatrixV8 contracts (EIP-170 limit).
 * Instead: deploy script deploys each MatA/MatB directly, then calls
 * MatrixFactory.registerPair() which validates ownership, wires, and records them.
 *
 * MatrixPairFactory deploys future MatA/MatB pairs autonomously on-chain when any
 * PairManager's active pair crosses 80% occupancy and no pre-deployed next pair exists.
 *
 * BPS SPLITS (V8.7/V8.8 — verified Jun 10 2026)
 * -----------------------------------------------
 * T1-T3:  l1=2000 l2=2000 chain=2000 pool=3300 treasury=100 devOps=500  sf=600  cw=6bps
 * T4-T5:  l1=2000 l2=2000 chain=2000 pool=3100 treasury=100 devOps=600  sf=500  cw=5bps
 * T6-T7:  l1=2000 l2=1750 chain=1750 pool=2950 treasury=200 devOps=700  sf=500  cw=5bps
 * T8-T10: l1=2000 l2=1750 chain=1750 pool=2750 treasury=200 devOps=800  sf=500  cw=5bps
 * (CW BPS are carved from SF share at SF level, not matrix level — sums to 10000)
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY   Gas-paying deployer
 *   W1_PRIVATE_KEY         Account #1 / root wallet
 *   DEV_WALLET_ADDRESS     Dev wallet (default: deployer)
 *   OPS_WALLET_ADDRESS     Ops wallet (default: deployer)
 *   ADMIN_WALLET_ADDRESS   Admin/owner   (default: deployer)
 *   USDC_ADDRESS           Reuse existing USDC; omit to deploy MockUSDC
 *   MATRIX_SIZE            127 (default) | 15 (quick dev cycle)
 *   DEPLOY_TIERS           Comma-separated list e.g. "1,2" (default: "1,2,3,4,5,6,7,8,9,10")
 *   ADDRESSES_FILE         Output filename (default: deployed_addresses_v8_48.json)
 *
 * Run: npx hardhat run scripts/deploy_v8.js --network baseSepolia
 */

require("./run_log");   // tee this whole run to logs/runs/deploy_v8/ (owner request, 29.x)
const { ethers }      = require("hardhat");
const { NonceManager } = require("ethers"); // v6 local nonce tracking
const fs              = require("fs");
const path            = require("path");
require("dotenv").config();

// ── Addresses output file ─────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(
  __dirname,
  // V8.48 (2026-08-13): bumped from v8_47 — the old default would have silently
  // OVERWRITTEN the live V8.47 address record on deploy day.
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"
);

// ── ⛔ OVERWRITE GUARD (session 29) ───────────────────────────────────────────
// A deploy WRITES this file at the very end. If it already exists, this run is
// about to destroy the record of a deployment that exists on chain — and for a
// PRIVATE deploy that is one lost PowerShell variable away at all times:
// 28.2(b) requires ADDRESSES_FILE to be named in the SESSION only, and if that
// window is lost, hardhat.config.js:2 `dotenv.config()` quietly refills it from
// .env, which by definition names the LIVE chain. testchain_keeper.js already
// documents that trap (its own guard header, 2026-08-16) — this is the same
// reasoning applied to the script that WRITES rather than reads.
//
// The test is deliberately "does the file exist" and not "does it look live":
// it is version-agnostic, it needs no literal that can go stale, and it catches
// the lost variable, the stale hardcoded default and a mistyped version alike.
// A legitimate redeploy over an existing record opts in explicitly.
function dotenvAddressesFile() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const m = txt.match(/^\s*ADDRESSES_FILE\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

(function guardAddressesFile() {
  const requested = process.env.ADDRESSES_FILE || null;
  const fromEnv   = dotenvAddressesFile();
  const allow     = process.env.ALLOW_ADDRESSES_OVERWRITE === "1";

  if (requested && fromEnv && requested === fromEnv) {
    console.log("");
    console.log("  ⚠️  ADDRESSES_FILE matches what .env names — so nothing in THIS session chose it.");
    console.log("     For a PRIVATE deploy that means the session variable was lost. See 28.2(b).");
  }
  if (!requested) {
    console.log("");
    console.log("  ⚠️  ADDRESSES_FILE is not set anywhere — falling back to the hardcoded default.");
  }

  if (fs.existsSync(ADDRESSES_FILE) && !allow) {
    console.error("");
    console.error("  ⛔  REFUSING TO DEPLOY.");
    console.error(`  ${path.basename(ADDRESSES_FILE)} ALREADY EXISTS.`);
    console.error("  This script writes that file at the end of a successful run, so continuing");
    console.error("  would overwrite the address record of a deployment that is live on chain.");
    console.error("");
    console.error("  If this is a PRIVATE gate deploy, the session variable is probably missing:");
    console.error('    $env:ADDRESSES_FILE="deployed_addresses_v8_50_private.json"');
    console.error("  If you really do mean to overwrite this record, say so explicitly:");
    console.error('    $env:ALLOW_ADDRESSES_OVERWRITE="1"');
    console.error("");
    process.exit(1);
  }
  console.log(`  ✓  addresses file target: ${path.basename(ADDRESSES_FILE)} (does not exist yet)`);
})();

// ── Config ────────────────────────────────────────────────────────────────────
const MATRIX_SIZE    = BigInt(process.env.MATRIX_SIZE || "127");
const DEPLOY_TIERS   = (process.env.DEPLOY_TIERS || "1,2,3,4,5,6,7,8,9,10").split(",").map(Number);

// ── Pair capacity: 1 pair per tier at deploy ──────────────────────────────────
// MatrixPairFactory handles all subsequent expansion autonomously on-chain.
// When the active pair crosses 80% occupancy and no next pair exists, the
// factory deploys a new MatA+MatB inline in the same tx as the triggering
// registration — no human intervention needed, no hard cap on members.
const PAIRS_PER_TIER = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; // factory handles expansion

// ── Tier entry fees (USDC 6-decimal) ─────────────────────────────────────────
const TIER_FEES = [
  10_000_000n,     // T1  $10
  25_000_000n,     // T2  $25
  50_000_000n,     // T3  $50
  100_000_000n,    // T4  $100
  250_000_000n,    // T5  $250
  500_000_000n,    // T6  $500
  1_000_000_000n,  // T7  $1,000
  2_500_000_000n,  // T8  $2,500
  5_000_000_000n,  // T9  $5,000
  10_000_000_000n, // T10 $10,000
];

// ── V8.32 BPS SplitConfigs (50/2.5/47.5 crossing reserve model) ─────────────
// Field order MUST match Solidity SplitConfig struct (10 fields):
//   l1Bps, chainBps, poolBps, treasuryBps, stabilityBps, devBps, opsBps, communityBps, buybackBps, liquidityBps
//
// [  l1, chain,  pool, treasury,   sf,  dev,  ops,  cw,  bbr,   lq] sum
const SPLITS_ALL    = [ 500,  1350,  1800,     500,  300,  100,   50,  100,   25,   25]; // V8.47: community 50→100, buyback/liquidity 50→25 (net-zero, sum 4750 ✓)

// ── Chain pay BPS per level (6 slots, must sum to chainBps = 1350) ────────────
const CHAIN_PAY_ALL = [270, 270, 270, 270, 270, 0];  // sum=1350 ✓

function tierSplits(tierNum)   { return SPLITS_ALL; }
function tierChainPay(tierNum) { return CHAIN_PAY_ALL; }

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt   = a   => `${a.slice(0,10)}…`;
const sleep = ms  => new Promise(r => setTimeout(r, ms));
function sep(label = "") {
  if (label) console.log(`\n  ── ${label} ${"─".repeat(Math.max(1, 56 - label.length))}`);
  else        console.log("  " + "─".repeat(60));
}

// ── V8.50 session 29: STALE-NODE GUARD ──────────────────────────────
// Session 28 lost four deploys to `gasUsed == gasLimit` at ~22k on the FIRST call
// to a freshly deployed contract. Cause (28.1): eth_estimateGas was answered from
// a block that did not yet contain the deployment, so the node saw an address with
// NO CODE and priced a bare transfer.
//
// ⛔ 28.1 proposed `gasMultiplier` on the baseSepolia network in hardhat.config.js.
// VERIFIED 2026-08-21 AGAINST THE INSTALLED PACKAGES TO BE A NO-OP:
//   * node_modules/@nomicfoundation/hardhat-ethers/signers.js `_sendUncheckedTransaction`
//     sets `gasLimit` ITSELF (`this.provider.estimateGas(...)`) before it calls
//     eth_sendTransaction;
//   * node_modules/hardhat/internal/core/providers/gas-providers.js AutomaticGasProvider
//     applies gasMultiplier only `if (tx.gas === undefined)` — it never is;
//   * a fixed `gas: <number>` in the network config is read by signers.js `create`
//     ONLY for the `hardhat` and `localhost` networks, never for baseSepolia.
// So the guard has to live HERE, where the transaction is actually built.
const GAS_MULTIPLIER   = Number(process.env.GAS_MULTIPLIER || 2);  // headroom on OUR estimate
const GAS_FLOOR_CALL   = 300000n;   // last-resort limit for a contract call
// CALIBRATED 2026-08-21 FROM A FALSE POSITIVE, not from reasoning. At 30000 this fired
// six times on `setSelfFundedGracePeriod`, whose true estimate is 29,438 - 21,000 base +
// a non-zero -> non-zero SSTORE + an event. That is a REAL price, and a detector that
// cries wolf on good data is one you stop reading. 24000 still catches the two figures
// this exists for (28.1's 22,414 and 22,056) with room to spare, and clears a genuine
// single-slot setter. Move it only against a measured estimate, never a guessed one.
const IMPLAUSIBLE_CALL = 24000n;
const CODE_WAIT_TRIES  = 20;
const CODE_WAIT_MS     = 3000;

// ── SECOND OPINION, STRAIGHT TO THE NODE ─────────────────────────────────────
// MEASURED 2026-08-21, session 29, and it corrects 28.1. A PHASE G deploy died
// with "no code" at MatrixPairFactory 60s AFTER that contract had been deployed,
// byte-verified AND transacted with four times, configureTier() one line earlier.
// probe_addr_consistency.js then asked four endpoints at three block tags: ALL
// FOUR reported the code present at latest and at safe, same byte count, same
// height. So the chain was fine and every node could see it — the 0x came from
// the ethers/hardhat provider's own view, not from a chain that was behind.
//
// 28.1 read this family of failures as "the node has not caught up". That is not
// what the measurement says. Rather than guess at the client stack, ask the node
// DIRECTLY with a plain fetch whenever the provider claims no code, and print
// both answers. The next occurrence becomes a reading instead of a dead end.
function rpcHost() {
  try { return new URL(require("hardhat").network.config.url).host.split(".")[0]; }
  catch { return "unknown"; }
}
async function rawRpc(method, params) {
  try {
    const url = require("hardhat").network.config.url;   // never printed — it carries the API key
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status !== 200) return null;
    const j = await r.json();
    return j.error ? null : j.result;
  } catch { return null; }
}
const sizeOf = (hex) => (!hex || hex === "0x") ? "0x NO CODE" : (((hex.length - 2) / 2) + " bytes");

async function waitForCode(addr, label = "") {
  let reported = false;
  let threwCount = 0, saidEmptyCount = 0, lastThrow = null;
  for (let i = 1; i <= CODE_WAIT_TRIES; i++) {
    // ⛔ AN EXCEPTION IS NOT AN ANSWER. The first version of this loop wrote
    // `catch { code = "0x" }`, which turned "the node failed to reply" into a
    // confident "this address has no code" — and produced a wrong diagnosis
    // within the hour (session 29). HH110 / 503 / TIMEOUT are the endpoint
    // refusing to answer; only a returned "0x" means the address is empty.
    // Same family as the empty-catch trap in CLAUDE.md.
    let code = null;
    try { code = await ethers.provider.getCode(addr); }
    catch (e) { threwCount++; lastThrow = e; }

    if (code && code !== "0x") {
      if (i > 1) console.log(`  ⏳  node saw code at ${fmt(addr)} ${label} after ${i} probes`);
      return (code.length - 2) / 2;
    }
    if (code === "0x") saidEmptyCount++;

    if (!reported) {
      reported = true;
      if (threwCount > 0) {
        console.log(`  ⚠️  provider.getCode(${fmt(addr)}) ${label} THREW — the endpoint did not answer:`);
        console.log(`        ${String(lastThrow && lastThrow.message).slice(0, 120)}`);
      } else {
        console.log(`  ⚠️  provider.getCode(${fmt(addr)}) ${label} returned 0x.`);
      }
      console.log(`      asking ${rpcHost()} directly:`);
    }

    // Ask the node itself, so a refusal to answer is never mistaken for an answer.
    const [rawLatest, rawSafe, bn] = await Promise.all([
      rawRpc("eth_getCode", [addr, "latest"]),
      rawRpc("eth_getCode", [addr, "safe"]),
      rawRpc("eth_blockNumber", []),
    ]);
    if (i === 1) {
      console.log(`        raw eth_getCode latest : ${sizeOf(rawLatest)}`);
      console.log(`        raw eth_getCode safe   : ${sizeOf(rawSafe)}`);
      console.log(`        node block             : ${bn ? parseInt(bn, 16) : "NO ANSWER (endpoint is not replying)"}`);
    }
    if (rawLatest && rawLatest !== "0x") {
      console.log(`  ->  THE NODE HAS THE CODE. The hardhat/ethers provider ${threwCount > 0 ? "could not get an answer" : "reported 0x"}.`);
      console.log(`      Continuing on the node's own reply; the gas estimate below is floored in case it is wrong too.`);
      return (rawLatest.length - 2) / 2;
    }

    // ⛔ GAP FOUND MID-RUN, 2026-08-21: the second opinion only ever asked the PRIMARY
    // endpoint. When the primary is simply BEHIND — it answers cleanly, it just has not
    // seen the deployment yet — asking it again is asking the one node that cannot know.
    // The fail-over pool is right there and 29.2 measured that a healthy endpoint usually
    // exists. Ask them all before concluding anything.
    for (const u of fallbackUrls()) {
      const alt = await rawRpcAt(u, "eth_getCode", [addr, "latest"]);
      if (alt.ok && alt.val && alt.val !== "0x") {
        console.log(`  ->  ${hostOf(u)} HAS the code (${sizeOf(alt.val)}) while the primary does not.`);
        console.log(`      The primary is behind, not the chain. Continuing on that answer.`);
        return (alt.val.length - 2) / 2;
      }
    }
    await sleep(CODE_WAIT_MS);
  }
  // Say WHICH it was. "No code" and "no answer" need different responses from a
  // human, and last session lost four deploys partly to conflating them.
  if (saidEmptyCount === 0) {
    throw new Error(
      `ENDPOINT NOT ANSWERING for ${addr} ${label}: ${CODE_WAIT_TRIES} probes, ` +
      `${threwCount} threw, 0 returned a value, and a direct fetch to the node got nothing either. ` +
      `This is the endpoint being unavailable, NOT evidence about the contract. ` +
      `Last error: ${String(lastThrow && lastThrow.message).slice(0, 160)}`
    );
  }
  throw new Error(
    `NO CODE at ${addr} ${label} after ${(CODE_WAIT_TRIES * CODE_WAIT_MS) / 1000}s. ` +
    `The provider returned 0x ${saidEmptyCount} time(s) and a direct fetch to the node agreed. ` +
    `Aborting rather than sending a 21k gas limit.`
  );
}

// -- TRANSPORT RETRY — MEASURED CAUSE, NOT A GUESS (session 29) ---------------
// 2026-08-21: fluent-neat-moon scored eth_blockNumber 20/20 while eth_getCode and
// eth_call returned HTTP 503 on all 20 — 28.4's exact signature — forty minutes
// after the same endpoint scored 20/20 on everything. The account degrades
// endpoint by endpoint, mid-session. A deploy is hundreds of sequential calls
// over 15-30 minutes, so a single blip killed the whole run twice today
// (once as HH110 at the first state call, once as a bogus "no code").
//
// So: retry TRANSPORT failures on READ calls. Deliberately NOT on sends —
// eth_sendRawTransaction may have landed before the transport failed, and
// re-sending it is how you get a duplicate transaction and a wrecked nonce.
// A failed send still aborts the run, loudly, which is the correct outcome.
const RPC_RETRIES = 5;
const RETRYABLE = new Set([
  "eth_call", "eth_getCode", "eth_estimateGas", "eth_blockNumber", "eth_chainId",
  "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionReceipt",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_gasPrice", "eth_feeHistory",
  "eth_maxPriorityFeePerGas", "eth_getLogs", "eth_getStorageAt", "net_version",
  "eth_getTransactionByHash", "eth_blockNumber", "eth_accounts", "eth_syncing",
]);
function looksTransient(msg) {
  const m = String(msg || "");
  return /HH110|Invalid JSON-RPC|503|502|504|429|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network socket|timeout|fetch failed/i.test(m);
}
// Transport retry + endpoint fail-over now live in ONE place — scripts/rpc_resilience.js.
// This script carried a private copy while bigfill_v8.js had none, and bigfill duly died
// on an HH110 during a read that the copy would have absorbed. Duplicated resilience is
// resilience that protects whichever script you happened to edit last.
const { rawRpcAt, fallbackUrls, hostOf } = require("./rpc_resilience");


async function deploy(factory, args = [], label = "") {
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  const size = await waitForCode(addr, label);   // ⛔ 28.1: prove the node sees it BEFORE anything calls it
  if (label) console.log(`  ✓  ${label.padEnd(28)} ${addr}  (${size} bytes)`);
  return c;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [rawSigner] = await ethers.getSigners();

  // V8.44 deployer guard (owner decision 2026-07-25): 0xCd0Af6… is the ACTIVE
  // testnet deployer again (it owns MockUSDC → direct mint). It is EIP-7702
  // delegated to MetaMask's stateless delegator (0x63c0c19a… — signature-gated,
  // accepted risk on TESTNET ONLY). The guard now: (a) prints the delegation
  // status of whatever wallet is signing, (b) aborts only if EXPECTED_DEPLOYER
  // is set in .env and doesn't match — so a stale key swap can never silently
  // deploy from the wrong wallet again. MAINNET RULE: fresh, never-delegated
  // deployer — do not carry this exception over.
  {
    const code = await ethers.provider.getCode(rawSigner.address);
    if (code.startsWith("0xef0100")) {
      console.log(`  ⚠️  Signer ${rawSigner.address} is EIP-7702 delegated to 0x${code.slice(8)} (testnet-accepted)`);
    }
    const expected = (process.env.EXPECTED_DEPLOYER || "").toLowerCase();
    if (expected && rawSigner.address.toLowerCase() !== expected) {
      throw new Error(`Signer ${rawSigner.address} != EXPECTED_DEPLOYER ${process.env.EXPECTED_DEPLOYER} — fix .env before deploying.`);
    }
  }

  const nonceMgr = new NonceManager(rawSigner);
  const _origSend = nonceMgr.sendTransaction.bind(nonceMgr);
  nonceMgr.sendTransaction = async (tx) => {
    await sleep(8000);

    // ⛔ 28.1 guard: only for CONTRACT CALLS (a deployment has no `to`, and those
    // never failed). Deployments keep ethers' own estimate untouched.
    const to      = typeof tx.to === "string" ? tx.to : null;
    const isCall  = to !== null && tx.data && tx.data !== "0x";
    const noLimit = tx.gasLimit === undefined || tx.gasLimit === null;

    if (isCall && noLimit) {
      await waitForCode(to, "(callee)");

      let est = null, lastErr = null, lowSeen = null;
      for (let i = 1; i <= 6; i++) {
        let e = null;
        try { e = await ethers.provider.estimateGas({ ...tx, from: rawSigner.address }); lastErr = null; }
        catch (err) { lastErr = err; }
        if (e !== null && e >= IMPLAUSIBLE_CALL) { est = e; break; }
        if (e !== null) {
          lowSeen = e;
          console.log(`  ⚠️  estimateGas says ${e} for a call WITH calldata — that is a bare-transfer ` +
                      `price, i.e. a node that cannot price the code. Re-estimating (${i}/6)…`);
        }
        await sleep(4000);
      }

      // Same treatment for the estimate: if the provider will not give a plausible
      // one, ask the node directly before falling back to the floor.
      if (est === null) {
        const rawEst = await rawRpc("eth_estimateGas", [{
          from: rawSigner.address, to,
          data: typeof tx.data === "string" ? tx.data : undefined,
          value: tx.value ? "0x" + BigInt(tx.value).toString(16) : undefined,
        }]);
        if (rawEst) {
          const r = BigInt(rawEst);
          if (r >= IMPLAUSIBLE_CALL) {
            console.log(`  ⛔  the node estimates ${r} directly while the provider would not — using the node's figure.`);
            est = r; lastErr = null;
          }
        }
      }

      let want;
      if (est !== null) {
        want = (est * BigInt(Math.round(GAS_MULTIPLIER * 100))) / 100n;
        if (want < GAS_FLOOR_CALL) want = GAS_FLOOR_CALL;
      } else if (lastErr !== null) {
        throw lastErr;                       // the node could not estimate at all — stop, do not guess
      } else {
        console.log(`  ⚠️  estimate stayed at ${lowSeen} after 6 tries (code IS present) — ` +
                    `falling back to the ${GAS_FLOOR_CALL} floor rather than sending ${lowSeen}.`);
        want = GAS_FLOOR_CALL;
      }

      const blk = await ethers.provider.getBlock("latest");
      const cap = (blk.gasLimit * 9n) / 10n;
      if (want > cap) want = cap;

      return _origSend({ ...tx, gasLimit: want });
    }

    return _origSend(tx);
  };
  const deployer    = nonceMgr;
  const deployerAddr = rawSigner.address;

  if (!process.env.W1_PRIVATE_KEY) {
    console.error("  ✗  W1_PRIVATE_KEY missing from .env");
    process.exit(1);
  }

  const w1               = new ethers.Wallet(process.env.W1_PRIVATE_KEY);
  const accountOne       = w1.address;
  const devWallet        = process.env.DEV_WALLET_ADDRESS        || deployerAddr;
  const opsWallet        = process.env.OPS_WALLET_ADDRESS        || deployerAddr;
  const admin            = process.env.ADMIN_WALLET_ADDRESS      || deployerAddr;
  const liquidityReserve = process.env.LIQUIDITY_RESERVE_ADDRESS || opsWallet;

  console.log("\n  V8.50 Deploy — FIFO pair routing (external->pair 0, graduates->pairIndex+1)");
  // 29.7: the old line here told the reader to set ADDRESSES_FILE in .env and named
  // v8_47. Both are wrong now — 28.2(b) requires the SESSION variable and .env left
  // alone for a private deploy, and the overwrite guard above enforces it.
  console.log(`  ADDRESSES_FILE is taken from the SESSION, not .env (28.2b). Target: ${path.basename(ADDRESSES_FILE)}`);
  sep();
  console.log(`  Deployer        : ${deployerAddr}`);
  console.log(`  AccountOne      : ${accountOne}`);
  console.log(`  Admin           : ${admin}`);
  console.log(`  DevWallet       : ${devWallet}`);
  console.log(`  OpsWallet       : ${opsWallet}`);
  console.log(`  LiquidityReserve: ${liquidityReserve}`);
  console.log(`  MatrixSize      : ${MATRIX_SIZE}`);
  console.log(`  Tiers           : T${DEPLOY_TIERS.join(", T")}`);
  sep();

  // ── 1. USDC ────────────────────────────────────────────────────────────────
  sep("USDC");
  let usdc;
  if (process.env.USDC_ADDRESS) {
    usdc = await ethers.getContractAt("MockUSDC", process.env.USDC_ADDRESS, deployer);
    console.log(`  ↳  Existing USDC       ${process.env.USDC_ADDRESS}`);
  } else {
    const MockUSDC = await ethers.getContractFactory("MockUSDC", deployer);
    usdc = await deploy(MockUSDC, [], "MockUSDC");
    await (await usdc.mint(deployerAddr, 10_000_000_000_000n)).wait();
    console.log("  ↳  Minted 10M USDC to deployer");
  }
  const usdcAddr = await usdc.getAddress();

  // ── 2. CNOVA Token ────────────────────────────────────────────────────────
  sep("CNOVA Token");
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken", deployer);
  const cnova      = await deploy(CNOVAToken, [deployerAddr], "CNOVAToken");
  const cnovaAddr  = await cnova.getAddress();

  // ── 3. Treasury ───────────────────────────────────────────────────────────
  sep("Treasury");
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury", deployer);
  const treasury      = await deploy(CNOVATreasury, [cnovaAddr, usdcAddr, admin], "CNOVATreasury");
  const treasuryAddr  = await treasury.getAddress();

  // ── 4. StabilityFund ──────────────────────────────────────────────────────
  sep("StabilityFund");
  const StabilityFund = await ethers.getContractFactory("StabilityFund", deployer);
  const stabilityFund = await deploy(StabilityFund, [usdcAddr, admin], "StabilityFund");
  const sfAddr = await stabilityFund.getAddress();

  for (const t of DEPLOY_TIERS) {
    await (await stabilityFund.setTierFee(t - 1, TIER_FEES[t - 1])).wait();
  }
  console.log("  ↳  Tier entry fees set in StabilityFund");

  // ── 4b. CNOVABuybackReserve ──────────────────────────────────────────────
  sep("CNOVABuybackReserve");
  const CNOVABuybackReserve = await ethers.getContractFactory("CNOVABuybackReserve", deployer);
  const buybackReserve      = await deploy(
    CNOVABuybackReserve,
    [usdcAddr, cnovaAddr, ethers.ZeroAddress, ethers.ZeroAddress, admin],
    "CNOVABuybackReserve"
  );
  const bbrAddr = await buybackReserve.getAddress();

  await (await stabilityFund.setBuybackReserve(bbrAddr)).wait();
  console.log("  ↳  StabilityFund.setBuybackReserve OK");

  // ── 5a. TierRouterLib (V8.47: linked lib holding TierRouter's extracted upgrade helpers)
  sep("TierRouterLib");
  const TierRouterLibF = await ethers.getContractFactory("TierRouterLib", deployer);
  const tierRouterLib  = await deploy(TierRouterLibF, [], "TierRouterLib");
  const trLibAddr      = await tierRouterLib.getAddress();

  // ── 5. TierRouter (links TierRouterLib) ─────────────────────────────────────
  sep("TierRouter");
  const TierRouter = await ethers.getContractFactory("TierRouter", {
    libraries: { TierRouterLib: trLibAddr },
    signer: deployer,
  });
  const tierRouter  = await deploy(TierRouter, [usdcAddr, admin], "TierRouter");
  const trAddr = await tierRouter.getAddress();

  await (await stabilityFund.setTierRouter(trAddr)).wait();
  console.log("  ↳  StabilityFund.setTierRouter OK");
  await (await tierRouter.setStabilityFund(sfAddr)).wait();  // V8.47 upgrade gate
  console.log("  ↳  TierRouter.setStabilityFund OK");

  // ── 6. MatrixFactory (registry/wiring hub) ───────────────────────────────
  sep("MatrixFactory");
  const MatrixFactory = await ethers.getContractFactory("MatrixFactory", deployer);
  const matFactory    = await deploy(
    MatrixFactory,
    [admin, trAddr, sfAddr, ethers.ZeroAddress],
    "MatrixFactory"
  );
  const mfAddr = await matFactory.getAddress();

  // ── 6b. MatrixLogicLib (must deploy before MatrixPairFactory — it embeds F8V8 bytecode)
  sep("MatrixLogicLib");
  const MatrixLib    = await ethers.getContractFactory("MatrixLogicLib", deployer);
  const matrixLib    = await deploy(MatrixLib, [], "MatrixLogicLib");
  const matrixLibAddr = await matrixLib.getAddress();

  // ── 6c. MatrixPairFactory (autonomous expansion — no hard cap) ────────────
  sep("MatrixPairFactory");
  const MPFactory   = await ethers.getContractFactory("MatrixPairFactory", {
    libraries: { MatrixLogicLib: matrixLibAddr },
    signer: deployer,
  });
  const pairFactory = await deploy(
    MPFactory,
    [admin, usdcAddr, cnovaAddr, treasuryAddr],
    "MatrixPairFactory"
  );
  const pairFactoryAddr = await pairFactory.getAddress();

  // Set wallets — needed by factory when constructing new FigureEightMatrixV8 instances
  await (await pairFactory.setWallets(devWallet, opsWallet, accountOne)).wait();
  console.log("  ↳  MatrixPairFactory.setWallets OK");

  // Wire factory into peripherals already deployed at this point.
  // keeper, couponRegistry, and governance are wired via setPeripherals() later.
  await (await pairFactory.setPeripherals(
    sfAddr, ethers.ZeroAddress, trAddr,
    ethers.ZeroAddress, ethers.ZeroAddress,
    bbrAddr, liquidityReserve
  )).wait();
  console.log("  ↳  MatrixPairFactory.setPeripherals (partial — keeper/cr/gov wired after deploy)");

  // Allow factory to call setMatrixAuthorized / setAuthorizedCaller / registerMatrix
  await (await stabilityFund.setFactory(pairFactoryAddr)).wait();
  await (await treasury.setFactory(pairFactoryAddr)).wait();
  await (await tierRouter.setFactory(pairFactoryAddr)).wait();
  console.log("  ↳  factory wired into StabilityFund, Treasury, TierRouter");

  // ── 7. PairManagers + Matrix pairs ───────────────────────────────────────
  sep("Tier Pairs");

  const F8V8  = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: matrixLibAddr },
    signer: deployer,
  });
  const PMV8  = await ethers.getContractFactory("PairManagerV8", deployer);

  const deployed = {};  // t => { pm, matA, matB }

  for (const tierNum of DEPLOY_TIERS) {
    const tIdx   = tierNum - 1;
    const fee    = TIER_FEES[tIdx];
    const splits = tierSplits(tierNum);
    const cpBps  = tierChainPay(tierNum);

    console.log(`\n  T${tierNum} (fee=$${Number(fee) / 1e6})`);

    const pm   = await deploy(PMV8, [usdcAddr, fee, admin], `PairManagerV8 T${tierNum}`);
    const pmAddr = await pm.getAddress();
    await (await pm.setTierRouter(trAddr)).wait();
    console.log(`       PairManagerV8.setTierRouter T${tierNum} OK`);

    // Wire MatrixPairFactory → PairManager (enables autonomous expansion)
    await (await pm.setFactory(pairFactoryAddr)).wait();
    console.log(`       PairManagerV8.setFactory T${tierNum} OK`);

    await (await matFactory.configureTier(tIdx, pmAddr, MATRIX_SIZE)).wait();
    console.log(`       MatrixFactory.configureTier T${tierNum} OK`);

    const dpStruct = {
      usdc:       usdcAddr,
      cnova:      cnovaAddr,
      treasury:   treasuryAddr,
      devWallet:  devWallet,
      opsWallet:  opsWallet,
      accountOne: accountOne,
      admin:      admin,
    };

    const matA = await deploy(
      F8V8,
      [dpStruct, fee, MATRIX_SIZE, true, tIdx, splits, cpBps],
      `MatA T${tierNum}`
    );

    const matB = await deploy(
      F8V8,
      [dpStruct, fee, MATRIX_SIZE, false, tIdx, splits, cpBps],
      `MatB T${tierNum}`
    );

    const matAAddr = await matA.getAddress();
    const matBAddr = await matB.getAddress();

    await (await matFactory.registerPair(tIdx, matAAddr, matBAddr)).wait();
    console.log(`       MatrixFactory.registerPair T${tierNum} OK`);

    // Wire matrices
    await (await matA.setPartner(matBAddr)).wait();
    await (await matB.setPartner(matAAddr)).wait();
    await (await matA.setTierRouter(trAddr)).wait();
    await (await matB.setTierRouter(trAddr)).wait();
    await (await matA.setPairManager(pmAddr)).wait();
    await (await matB.setPairManager(pmAddr)).wait();
    await (await matA.setStabilityFund(sfAddr)).wait();
    await (await matB.setStabilityFund(sfAddr)).wait();
    await (await matA.setBuybackReserve(bbrAddr)).wait();
    await (await matB.setBuybackReserve(bbrAddr)).wait();
    await (await matA.setLiquidityReserve(liquidityReserve)).wait();
    await (await matB.setLiquidityReserve(liquidityReserve)).wait();
    await (await matA.setChainNext(matBAddr)).wait();
    await (await matB.setChainNext(matAAddr)).wait();
    console.log(`       Matrix wiring complete T${tierNum}`);

    await (await tierRouter.registerTier(tIdx, pmAddr, fee)).wait();
    await (await tierRouter.setTierMatrices(tIdx, matAAddr, matBAddr)).wait();
    await (await tierRouter.registerMatrix(matAAddr, tIdx)).wait();
    await (await tierRouter.registerMatrix(matBAddr, tIdx)).wait();
    console.log(`       TierRouter.registerTier + setTierMatrices + registerMatrix T${tierNum} OK`);

    if (tierNum > 1) {
      await (await tierRouter.setTierVelocityGreen(tIdx, false)).wait();
      console.log(`       Velocity gate T${tierNum} CLOSED (keeper opens at 80% MatB fill)`);
    } else {
      console.log(`       Velocity gate T1 OPEN (T1 always open for registration)`);
    }

    await (await pm.addPair(matAAddr, matBAddr)).wait();
    console.log(`       PairManager.addPair T${tierNum} OK`);

    await (await stabilityFund.setMatrixAuthorized(matAAddr, true)).wait();
    await (await stabilityFund.setMatrixAuthorized(matBAddr, true)).wait();

    await (await treasury.setAuthorizedCaller(matAAddr, true)).wait();
    await (await treasury.setAuthorizedCaller(matBAddr, true)).wait();
    console.log(`       Treasury.setAuthorizedCaller T${tierNum} OK`);

    // V8.48 items 7+13: wire the treasury's member tracker to the T1 PairManager.
    // NEVER CALLED before this line existed — so earlyExitPenaltyBps read 0 for
    // everyone (no early-exit penalty ever applied) and setFreeMode (Universe
    // Mode) reverted "member tracker not set". PM8 now serves both consumers
    // honestly: memberJoinedAt(member) = first T1 routing (the penalty ladder's
    // clock) and totalMembers() = UNIQUE people (the 500-member gate — it must
    // never count entries; see PairManagerV8.totalMembers).
    if (tierNum === 1) {
      await (await treasury.setMemberTracker(pmAddr)).wait();
      console.log(`       Treasury.setMemberTracker(T1 PairManager) OK (items 7+13)`);
    }

    // Configure this tier in MatrixPairFactory.
    // When the active pair hits 80% occupancy, factory.deployAndWire() fires
    // and uses these params to construct the next MatA+MatB pair.
    await (await pairFactory.configureTier(
      tierNum,      // 1-based tier number
      fee,
      MATRIX_SIZE,
      splits,       // SplitConfig array — same order as Solidity struct
      cpBps         // uint256[6] chainPayBps
    )).wait();
    await (await pairFactory.registerPairManager(pmAddr, tierNum)).wait();
    console.log(`       MatrixPairFactory: T${tierNum} configured + PM registered`);

    deployed[tierNum] = { pm: pmAddr, matA: matAAddr, matB: matBAddr };
  }

  // ── 8. MatrixKeeper ──────────────────────────────────────────────────────
  sep("MatrixKeeper");
  // V8.48 item 12a: the discovery scan lives in MatrixKeeperLib and MUST be linked.
  // Without this the factory throws at getContractFactory time rather than producing a
  // broken keeper, which is the failure mode we want — a keeper deployed with an
  // unlinked library reverts on every checkUpkeep and Chainlink simply goes quiet.
  const KeeperLib     = await ethers.getContractFactory("MatrixKeeperLib", deployer);
  const keeperLib     = await deploy(KeeperLib, [], "MatrixKeeperLib");
  const keeperLibAddr = await keeperLib.getAddress();

  const MatrixKeeper = await ethers.getContractFactory("MatrixKeeper", {
    libraries: { MatrixKeeperLib: keeperLibAddr },
    signer: deployer,
  });
  const keeper       = await deploy(MatrixKeeper, [trAddr, sfAddr], "MatrixKeeper");
  const keeperAddr   = await keeper.getAddress();

  await (await stabilityFund.setMatrixKeeper(keeperAddr)).wait();
  console.log("  ↳  StabilityFund.setMatrixKeeper OK");

  await (await tierRouter.setMatrixKeeper(keeperAddr)).wait();
  console.log("  ↳  TierRouter.setMatrixKeeper OK");

  for (const tierNum of DEPLOY_TIERS) {
    await (await keeper.setPairManager(tierNum - 1, deployed[tierNum].pm)).wait();
  }
  console.log("  ↳  PairManagers registered with MatrixKeeper");

  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setMatrixKeeper(keeperAddr)).wait();
    await (await mB.setMatrixKeeper(keeperAddr)).wait();
  }
  console.log("  ↳  MatrixKeeper set on all matrices");

  // Update MatrixPairFactory with keeper — factory-deployed pairs will call keeper wiring
  // NOTE: couponRegistry and governance still ZeroAddress — updated in final setPeripherals below
  await (await pairFactory.setPeripherals(
    sfAddr, ethers.ZeroAddress, trAddr,
    keeperAddr, ethers.ZeroAddress,
    bbrAddr, liquidityReserve
  )).wait();
  console.log("  ↳  MatrixPairFactory.setPeripherals updated with keeper");

  // ── 9. V8Governance ──────────────────────────────────────────────────────
  sep("V8Governance");
  const V8Gov    = await ethers.getContractFactory("V8Governance", deployer);
  const gov      = await deploy(V8Gov, [cnovaAddr, trAddr, keeperAddr], "V8Governance");
  const govAddr  = await gov.getAddress();

  await (await keeper.setGovernance(govAddr)).wait();
  await (await tierRouter.setGovernance(govAddr)).wait();
  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setGovernance(govAddr)).wait();
    await (await mB.setGovernance(govAddr)).wait();
    const pm = await ethers.getContractAt("PairManagerV8", deployed[tierNum].pm, deployer);
    await (await pm.setGovernance(govAddr)).wait();
  }
  console.log("  ↳  V8Governance wired onto all matrices + PairManagers");
  await (await stabilityFund.setGovernance(govAddr)).wait();
  await (await buybackReserve.setGovernance(govAddr)).wait();
  console.log("  ↳  V8Governance deployed + wired (owner retains backstop, governance co-governs)");

  // ── 9b. Wire CNOVA roles ─────────────────────────────────────────────────
  sep("CNOVA Role Grants");
  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  for (const tierNum of DEPLOY_TIERS) {
    const { matA, matB } = deployed[tierNum];
    await (await cnova.grantRole(MINTER_ROLE, matA)).wait();
    await (await cnova.grantRole(MINTER_ROLE, matB)).wait();
    console.log(`  ↳  MINTER_ROLE granted to T${tierNum} MatA + MatB`);
  }
  await (await cnova.grantRole(GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ↳  GOVERNOR_ROLE granted to V8Governance (${govAddr})`);

  // V8.36 Bug Fix #1: Grant DEFAULT_ADMIN_ROLE to MatrixPairFactory so it can
  // call cnova.grantRole(MINTER_ROLE, newMatA/matB) when deploying factory pairs.
  // Without this, T1.2+, T2.2+, … members receive no CNOVA rewards.
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // 0x00...00 (OpenZeppelin AccessControl)
  await (await cnova.grantRole(DEFAULT_ADMIN_ROLE, pairFactoryAddr)).wait();
  console.log(`  ↳  DEFAULT_ADMIN_ROLE granted to MatrixPairFactory (${pairFactoryAddr}) — enables MINTER_ROLE grant on factory expansion`);

  // ── 9c. CommunityWallet ──────────────────────────────────────────────────
  sep("CommunityWallet");
  const CommunityWallet = await ethers.getContractFactory("CommunityWallet", deployer);
  const cw     = await deploy(CommunityWallet, [usdcAddr, admin], "CommunityWallet");
  const cwAddr = await cw.getAddress();

  await (await cw.setEnrollor(trAddr)).wait();
  console.log(`  ↳  setEnrollor(TierRouter) OK`);

  const CW_GOVERNOR_ROLE = await cw.GOVERNOR_ROLE();
  await (await cw.grantRole(CW_GOVERNOR_ROLE, govAddr)).wait();
  console.log(`  ↳  GOVERNOR_ROLE granted to V8Governance on CommunityWallet`);

  await (await tierRouter.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  TierRouter.setCommunityWallet OK`);

  await (await stabilityFund.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  StabilityFund.setCommunityWallet OK`);

  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matB, deployer);
    await (await mA.setCommunityWallet(cwAddr)).wait();
    await (await mB.setCommunityWallet(cwAddr)).wait();
    console.log(`  ↳  T${tierNum} MatA + MatB → CommunityWallet set`);
  }
  console.log("  ↳  CommunityWallet fully wired into SF + all matrices");

  await (await keeper.setCommunityWallet(cwAddr)).wait();
  console.log(`  ↳  MatrixKeeper.setCommunityWallet OK`);

  // ── 9d. CNOVADirectSale ──────────────────────────────────────────────────
  sep("CNOVADirectSale");
  const DS_SF_TARGET_USD = Number(process.env.DS_SF_TARGET_USD || 500);
  const DS_LQ_TARGET_USD = Number(process.env.DS_LQ_TARGET_USD || 1000);
  const dsSfTarget = BigInt(DS_SF_TARGET_USD) * 1_000_000n;
  const dsLqTarget = BigInt(DS_LQ_TARGET_USD) * 1_000_000n;

  const CNOVADirectSale = await ethers.getContractFactory("CNOVADirectSale", deployer);
  const directSale = await deploy(
    CNOVADirectSale,
    [usdcAddr, cnovaAddr, treasuryAddr, sfAddr, liquidityReserve, dsSfTarget, dsLqTarget],
    "CNOVADirectSale"
  );
  const dsAddr = await directSale.getAddress();
  console.log(`  ↳  SF target $${DS_SF_TARGET_USD} / LQ target $${DS_LQ_TARGET_USD}`);

  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await (await cnova.grantRole(DIRECT_SALE_ROLE, dsAddr)).wait();
  console.log(`  ↳  DIRECT_SALE_ROLE granted to CNOVADirectSale`);

  // V8.48 item 6: every purchase deposits its floor-backing portion through
  // treasury.depositReserve() (the floor reads usdcReserve, and a plain transfer
  // would dilute it). depositReserve is onlyMatrix — WITHOUT this authorization
  // every buyCNOVA reverts "Treasury: caller not matrix".
  await (await treasury.setAuthorizedCaller(dsAddr, true)).wait();
  console.log(`  ↳  Treasury.setAuthorizedCaller(directSale) OK (item 6)`);

  await (await directSale.setGovernance(govAddr)).wait();
  console.log(`  ↳  CNOVADirectSale.setGovernance OK`);

  // ── 9e. CouponRegistry ──────────────────────────────────────────────────
  sep("CouponRegistry");
  const COUPON_AMOUNT_USD = Number(process.env.COUPON_AMOUNT_USD || 10);
  const couponAmountWei   = BigInt(COUPON_AMOUNT_USD) * 1_000_000n;
  const CouponRegistry    = await ethers.getContractFactory("CouponRegistry", deployer);
  const couponRegistry    = await deploy(CouponRegistry, [usdcAddr, couponAmountWei], "CouponRegistry");
  const crAddr            = await couponRegistry.getAddress();
  console.log(`  ↳  CouponRegistry deployed — default coupon = $${COUPON_AMOUNT_USD} USDC`);

  for (const tierNum of DEPLOY_TIERS) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", deployed[tierNum].matA, deployer);
    await (await couponRegistry.setAuthorizedMatrix(deployed[tierNum].matA, true)).wait();
    await (await mA.setCouponRegistry(crAddr)).wait();
    console.log(`  ↳  T${tierNum} MatA authorized + wired → CouponRegistry`);
  }

  const gasGiftWalletAddr = process.env.GAS_GIFT_WALLET_ADDRESS || opsWallet;
  await (await couponRegistry.setGasGiftWallet(gasGiftWalletAddr)).wait();
  console.log(`  ↳  CouponRegistry.setGasGiftWallet → ${gasGiftWalletAddr.slice(0,10)}…`);

  // Wire MatrixPairFactory into CouponRegistry (factory can authorize new MatA on expansion)
  await (await couponRegistry.setFactory(pairFactoryAddr)).wait();
  console.log("  ↳  CouponRegistry.setFactory → MatrixPairFactory OK");

  // ── 9f. MatrixPairFactory final wiring ───────────────────────────────────
  // All addresses now known. Call setPeripherals once more with the full set.
  // This is the definitive configuration — factory-deployed pairs will be
  // fully authorized into SF, Treasury, TierRouter, CouponRegistry, and registered
  // with keeper, co-governed by V8Governance.
  sep("MatrixPairFactory Final Wiring");
  await (await pairFactory.setPeripherals(
    sfAddr, crAddr, trAddr,
    keeperAddr, govAddr,
    bbrAddr, liquidityReserve
  )).wait();
  console.log("  ↳  MatrixPairFactory.setPeripherals FINAL (all addresses wired)");

  // V8.34: Set parkedGracePeriod  (THE LOAN CLOCK - see MatrixKeeper.sol declaration)
  //
  // ⛔ 2026-08-24: this line defaulted to 86400 on EVERY network. On mainnet that ships
  //    the TESTNET window silently - 24h where owner policy is 48h - and nothing in the
  //    deploy or the predeploy check would have said a word. The value is not decoration:
  //    it is how long a member has to fund their own re-entry before the SF lends them
  //    the gap and books a debt against them.
  //
  //    THE DEFAULT NOW FAILS SAFE. An unrecognised network is treated as MAINNET, so a
  //    new network name added to hardhat.config.js gets the LONGER window until someone
  //    deliberately lists it as a testnet. Getting this wrong in the safe direction costs
  //    a tester 24 extra hours; getting it wrong the other way costs a real member a loan
  //    they did not need.
  const _netName   = (() => { try { return require("hardhat").network.name; } catch (_) { return ""; } })();
  const _TESTNETS  = ["hardhat", "localhost", "baseSepolia", "sepolia"];
  const _isTestnet = _TESTNETS.includes(_netName);
  const GRACE_PERIOD_SECS = process.env.PARKED_GRACE_SECS
    ? Number(process.env.PARKED_GRACE_SECS)
    : (_isTestnet ? 86400 : 172800);   // 24h testnet policy / 48h mainnet policy
  // The setter takes a RANGE (0, or 5min..30d), so a typo cannot be caught by the
  // contract the way a menu value would be. Check it here instead.
  if (!(GRACE_PERIOD_SECS === 0 || (GRACE_PERIOD_SECS >= 300 && GRACE_PERIOD_SECS <= 2592000))) {
    throw new Error(
      `PARKED_GRACE_SECS=${GRACE_PERIOD_SECS} is outside setParkedGracePeriod's range ` +
      `(0, or 300..2592000). Owner policy: mainnet 172800 (48h), testnet 86400 (24h).`
    );
  }
  if (!_isTestnet && GRACE_PERIOD_SECS < 172800) {
    throw new Error(
      `Refusing to deploy to "${_netName || "unknown"}" with parkedGracePeriod=${GRACE_PERIOD_SECS}s. ` +
      `Owner policy is 48h (172800) on mainnet. Set PARKED_GRACE_SECS explicitly if this is deliberate.`
    );
  }
  console.log(`  ↳  network="${_netName || "unknown"}" treated as ${_isTestnet ? "TESTNET" : "MAINNET"} for the loan clock`);
  await (await keeper.setParkedGracePeriod(GRACE_PERIOD_SECS)).wait();
  console.log(`  ↳  MatrixKeeper.setParkedGracePeriod → ${GRACE_PERIOD_SECS}s (${GRACE_PERIOD_SECS/3600}h)`);

  // V8.49: set selfFundedGracePeriod EXPLICITLY, so it ships by decision rather than by
  // whatever the declaration happens to say.
  //
  // ⚠ READ BEFORE CHANGING THIS NUMBER. The old note here — and in predeploy_check.js,
  // and in the contract's own declaration — said "mainnet default 6h". THAT WAS NEVER
  // REACHABLE: setSelfFundedGracePeriod's menu is 0/60/300/900/1800/3600, capped at ONE
  // HOUR, and the cap is deliberate. V8.48 item 12 redefined this value as a RACE GUARD
  // (it stops a rescue being queued in the same minute a member is mid-registration or
  // mid-upgrade, matching fastlane_rescue.js's MIN_AGE=300), NOT as a protection window.
  // The protection window is parkedGracePeriod, which is where a long value belongs.
  // "6h" was a stale V8.25 statement that item 12 superseded and nobody deleted, so the
  // deploy was being told to set a value no setter would have accepted.
  //
  // 300s is therefore correct on MAINNET as well as testnet: the race it guards is the
  // same on both networks, and it costs a self-funded member five minutes' wait for money
  // that is already theirs. Override with SELF_GRACE_SECS, but only with a MENU value.
  const SELF_GRACE_SECS = process.env.SELF_GRACE_SECS
    ? Number(process.env.SELF_GRACE_SECS)
    : 300; // 5 min — the race guard, both networks
  if (![0, 60, 300, 900, 1800, 3600].includes(SELF_GRACE_SECS)) {
    throw new Error(
      `SELF_GRACE_SECS=${SELF_GRACE_SECS} is not on setSelfFundedGracePeriod's menu ` +
      `(0/60/300/900/1800/3600). Failing here rather than mid-deploy.`);
  }
  await (await keeper.setSelfFundedGracePeriod(SELF_GRACE_SECS)).wait();
  console.log(`  ↳  MatrixKeeper.setSelfFundedGracePeriod → ${SELF_GRACE_SECS}s (race guard, V8.48 item 12)`);

  // ── 10a. Save addresses BEFORE W1 seed ────────────────────────────────────
  {
    sep("Save Addresses");
    const tierAddresses = {};
    for (const t of DEPLOY_TIERS) tierAddresses[`T${t}`] = deployed[t];
    const out = {
      network: (await ethers.provider.getNetwork()).name,
      deployedAt: new Date().toISOString(),
      matrixSize: Number(MATRIX_SIZE),
      deployer: deployerAddr, admin, accountOne, devWallet, opsWallet,
      usdc: usdcAddr, cnova: cnovaAddr, treasury: treasuryAddr,
      stabilityFund: sfAddr, buybackReserve: bbrAddr, tierRouter: trAddr,
      matrixFactory: mfAddr, pairFactory: pairFactoryAddr,
      matrixKeeper: keeperAddr,
      // V8.48 item 12a: LINKED LIBRARY ADDRESSES. Three contracts now ship with a linked
      // library and none of the addresses were being recorded — Basescan verification of a
      // linked contract REQUIRES them, and after the fact they are only recoverable by
      // reading the deploy transcript or diffing bytecode. Record them at deploy time.
      libraries: {
        MatrixLogicLib:  matrixLibAddr,     // FigureEightMatrixV8, MatrixPairFactory
        TierRouterLib:   trLibAddr,         // TierRouter
        MatrixKeeperLib: keeperLibAddr,     // MatrixKeeper
      },
      v8Governance: govAddr, communityWallet: cwAddr,
      liquidityReserve, directSale: dsAddr, couponRegistry: crAddr,
      tiers: tierAddresses,
    };
    fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(out, null, 2));
    console.log(`  ✓  Addresses saved → ${path.basename(ADDRESSES_FILE)}`);
  }

  // ── 10b. Register W1 (Account #1) as position-1 root of T1 MatA ─────────
  sep("W1 Registration");
  const T1_FEE     = TIER_FEES[0];
  const T1_PM_ADDR = deployed[1].pm;
  const w1Key      = process.env.SEED_W1_KEY || process.env.W1_PRIVATE_KEY;

  if (!w1Key) {
    console.log(`  ⚠  SEED_W1_KEY / W1_PRIVATE_KEY not set — skipping W1 seed.`);
    console.log(`     Run: $env:SEED_W1_KEY="0x<key>"; npx hardhat run scripts/seed_w1.js --network baseSepolia`);
  } else {
    try {
      const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);
      const W1_ADDR  = w1Wallet.address;

      const alreadyJoined = await tierRouter.globalJoined(W1_ADDR);
      if (alreadyJoined) {
        console.log(`  ✓  W1 (${W1_ADDR}) already registered — skip`);
      } else {
        const w1Eth = await ethers.provider.getBalance(W1_ADDR);
        if (w1Eth < ethers.parseEther("0.01")) {
          await (await deployer.sendTransaction({ to: W1_ADDR, value: ethers.parseEther("0.02") })).wait();
          console.log(`  ↳  Funded W1 with 0.02 ETH for gas`);
        }
        await (await usdc.mint(W1_ADDR, T1_FEE)).wait();
        console.log(`  ↳  Minted $${Number(T1_FEE) / 1e6} USDC to W1`);
        await (await usdc.connect(w1Wallet).approve(T1_PM_ADDR, T1_FEE)).wait();
        console.log(`  ↳  W1 approved T1 PM (${T1_PM_ADDR.slice(0,10)})`);
        await (await tierRouter.connect(w1Wallet).register(ethers.ZeroAddress, { gasLimit: 3_000_000 })).wait();
        console.log(`  ✓  W1 (${W1_ADDR}) registered as T1 MatA root (position-1)`);
      }

      await (await tierRouter.setDefaultReferrer(W1_ADDR)).wait();
      console.log(`  ✓  TierRouter.setDefaultReferrer → W1 (${W1_ADDR})`);
    } catch (e) {
      console.log(`  ⚠  W1 registration failed: ${e.reason || e.message}`);
      if (e.data) console.log(`     Revert data: ${e.data}`);
      console.log(`     Run scripts/seed_w1.js manually after deploy.`);
    }
  }

  // ── 11. Final summary ────────────────────────────────────────────────────
  sep("Deploy Complete");
  console.log(`  Network       : ${(await ethers.provider.getNetwork()).name}`);
  console.log(`  MockUSDC      : ${usdcAddr}`);
  console.log(`  CNOVAToken    : ${cnovaAddr}`);
  console.log(`  Treasury      : ${treasuryAddr}`);
  console.log(`  StabilityFund : ${sfAddr}`);
  console.log(`  BuybackReserve: ${bbrAddr}`);
  console.log(`  TierRouter    : ${trAddr}`);
  console.log(`  MatrixFactory : ${mfAddr}`);
  console.log(`  PairFactory   : ${pairFactoryAddr}`);
  console.log(`  MatrixKeeper  : ${keeperAddr}`);
  console.log(`  V8Governance  : ${govAddr}`);
  console.log(`  CommunityWallet:${cwAddr}`);
  for (const t of DEPLOY_TIERS) {
    console.log(`  T${t.toString().padStart(2,'0')} PM:${deployed[t].pm.slice(0,10)} MatA:${deployed[t].matA.slice(0,10)} MatB:${deployed[t].matB.slice(0,10)}`);
  }
  sep();
  console.log(`  Addresses file: ${require("path").basename(ADDRESSES_FILE)}`);
  console.log("  V8.50 Deploy complete.\n");
  console.log("  NEXT STEP: run scripts/seed_w1.js then scripts/bigfill_v8.js\n");
  sep();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
