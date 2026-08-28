/**
 * check_verification_v850.js — READ-ONLY. Asks BaseScan whether every V8.50
 * contract in the address book has verified source, and prints a pass/fail table.
 *
 *   node scripts/check_verification_v850.js
 *
 * ⛔ WHY (session 45, 2026-08-28). We are about to tell Blockaid, in an appeal
 * against a "malicious site" flag, that every contract is verified on BaseScan.
 * Session 44 ran scripts/verify_all_v850.js and reported success — but a claim
 * that has not been re-run is not a result, and if ONE address is unverified the
 * appeal is gone and the flag re-scans dirty. This script re-runs the claim.
 * It sends nothing, signs nothing and costs no gas: one getsourcecode read per
 * address, paced so the free BaseScan tier does not rate-limit us.
 *
 * It prints the exact BaseScan URLs, which is also the list to attach to the reply.
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const KEY  = process.env.BASESCAN_API_KEY || '';
const API  = 'https://api.etherscan.io/v2/api?chainid=84532';
const BROWSER = 'https://sepolia.basescan.org/address/';
const FILE = process.env.ADDRESSES_FILE || 'deployed_addresses_v8_50.json';

// Wallets and plain values are NOT contracts — never report them as unverified.
const SKIP_KEYS = new Set([
  'network','deployedAt','matrixSize','deployer','admin','accountOne',
  'devWallet','opsWallet'
]);

function collect(A) {
  const out = [];
  for (const [k, v] of Object.entries(A)) {
    if (SKIP_KEYS.has(k)) continue;
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out.push([k, v]);
    else if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (typeof v2 === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v2)) out.push([`${k}.${k2}`, v2]);
        else if (v2 && typeof v2 === 'object') {
          for (const [k3, v3] of Object.entries(v2)) {
            if (typeof v3 === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v3)) out.push([`${k}.${k2}.${k3}`, v3]);
          }
        }
      }
    }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * ⛔ AN ADDRESS WITH NO BYTECODE IS A WALLET, NOT AN UNVERIFIED CONTRACT.
 * Measured 2026-08-28: the first run of this script reported `liquidityReserve`
 * 0x961fDE5C… as UNVERIFIED and told us to stop the Blockaid appeal. It is not a
 * contract at all — deploy_v8.js:459 reads it straight from
 * LIQUIDITY_RESERVE_ADDRESS in .env (there is no LiquidityReserve.sol anywhere in
 * contracts/), and .env holds its PRIVATE KEY. It is a destination wallet passed
 * into other contracts' constructors. A hardcoded skip-list cannot keep up with
 * that — every new address book would need editing — so we ASK THE CHAIN instead:
 * eth_getCode returns '0x' for an EOA. Same rule as everywhere else in this
 * codebase: read the state, do not reconstruct it from a list someone maintains.
 */
async function hasCode(addr) {
  const url = `${API}&module=proxy&action=eth_getCode&address=${addr}&tag=latest&apikey=${KEY}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      const code = j && typeof j.result === 'string' ? j.result : null;
      if (code === null) { await sleep(1500 * attempt); continue; }
      return code !== '0x' && code !== '0x0' && code.length > 2;
    } catch (e) { await sleep(1500 * attempt); }
  }
  return null;   // unknown — never let a failed read decide
}

async function isVerified(addr) {
  const url = `${API}&module=contract&action=getsourcecode&address=${addr}&apikey=${KEY}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      const row = Array.isArray(j.result) ? j.result[0] : null;
      // A rate-limit answer is NOT a verdict — never let it read as "unverified".
      if (!row || typeof row !== 'object') { await sleep(1500 * attempt); continue; }
      const src  = (row.SourceCode || '').trim();
      const name = (row.ContractName || '').trim();
      return { ok: src.length > 0, name: name || '(unnamed)' };
    } catch (e) {
      await sleep(1500 * attempt);
    }
  }
  return { ok: null, name: 'READ FAILED' };   // null = unknown, not a fail
}

(async () => {
  if (!KEY) { console.error('BASESCAN_API_KEY missing from .env — aborting rather than guessing.'); process.exit(2); }
  const A = JSON.parse(fs.readFileSync(path.join(__dirname, FILE), 'utf8'));
  const list = collect(A);
  console.log(`\nChecking ${list.length} addresses from ${FILE} (deployed ${A.deployedAt}) on ${A.network}\n`);

  const verified = [], missing = [], unknown = [], wallets = [];
  for (const [label, addr] of list) {
    const { ok, name } = await isVerified(addr);
    await sleep(260);
    if (ok === true) {
      console.log(`VERIFIED   ${label.padEnd(22)} ${addr}  ${name}`);
      verified.push([label, addr, name]);
    } else {
      // Not verified — but is it even a contract? Ask the chain before judging.
      const code = await hasCode(addr);
      if (code === false) {
        console.log(`WALLET     ${label.padEnd(22)} ${addr}  (no bytecode — an EOA, nothing to verify)`);
        wallets.push([label, addr]);
      } else if (code === true) {
        console.log(`UNVERIFIED ${label.padEnd(22)} ${addr}  ⛔ has bytecode and no source`);
        missing.push([label, addr]);
      } else {
        console.log(`UNKNOWN    ${label.padEnd(22)} ${addr}  (read failed)`);
        unknown.push([label, addr]);
      }
    }
    await sleep(260);            // free tier is ~5 req/s; stay well under
  }

  console.log(`\n── SUMMARY ─────────────────────────────`);
  console.log(`  verified   : ${verified.length}  (contracts with source on BaseScan)`);
  console.log(`  wallets    : ${wallets.length}  (EOAs in the address book — nothing to verify)`);
  console.log(`  UNVERIFIED : ${missing.length}`);
  console.log(`  unknown    : ${unknown.length}  (read failed — re-run, do not report as either)`);
  if (missing.length) {
    console.log(`\n⛔ DO NOT SEND THE APPEAL YET. Run verify_all_v850.js for these first:`);
    for (const [l, a] of missing) console.log(`   ${l}  ${a}`);
  }
  if (unknown.length) {
    console.log(`\n⚠ Unknown (not a verdict):`);
    for (const [l, a] of unknown) console.log(`   ${l}  ${a}`);
  }
  if (!missing.length && !unknown.length) {
    console.log(`\n✅ ALL ${verified.length} CONTRACTS VERIFIED. BaseScan links for the Blockaid reply:\n`);
    for (const [l, a, n] of verified) console.log(`   ${(n||l).padEnd(22)} ${BROWSER}${a}#code`);
    if (wallets.length) {
      console.log(`\n   (not contracts, listed for completeness:)`);
      for (const [l, a] of wallets) console.log(`   ${l.padEnd(22)} ${BROWSER}${a}`);
    }
  }
})();
