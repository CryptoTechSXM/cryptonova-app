// set_test_clocks.js — shorten MatrixKeeper's two member clocks on a PRIVATE TEST chain.
//
// Written 2026-09-17 (session 87). Owner decision: "as a test we can reduce the days into
// hrs or minutes … we reduced the matrix size, so lets reduce everything". The V8.54 private
// chain was paused because parkedGracePeriod (24h) and evictionGracePeriod (7d) made every
// rescue / eviction step a day-or-week wait.
//
// WHAT IT SETS (both onlyOwnerOrGovernance, signed with DEPLOYER_PRIVATE_KEY):
//   PARKED_SECS -> setParkedGracePeriod   contract range: 0, or 300..2592000
//   EVICT_SECS  -> setEvictionGracePeriod contract menu : 0/86400/172800/259200/345600/432000/604800
//                  (0 = evict the moment triage refuses; the next non-zero option is a full day)
// The CONTRACT is the authority on those ranges; this script does not restate them, it
// surfaces the revert reason (same rule as set_parked_grace.js).
//
// ⛔ WHY IT HAS TWO GUARDS. These are the loan clock and the eviction clock. A 5-minute
//    parked grace on the LIVE chain would lend real members' gaps before they could fund
//    themselves, and eviction 0 would release refused members instantly. So:
//    1. the book name must contain "_private" — this script refuses every other book;
//    2. CONFIRM_MATRIX_KEEPER must equal the keeper address in that book (naming a file
//       is not enough — the set_graduation.js rule).
//
// Usage (PowerShell, from C:\CryptoNite-Smart-Contracts\CryptoNova, all in ONE window):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_54_private.json"
//   $env:CONFIRM_MATRIX_KEEPER="0x..."    # must equal matrixKeeper in that file
//   $env:PARKED_SECS="300"; $env:EVICT_SECS="0"
//   node scripts/set_test_clocks.js
// DRY_RUN=1 reads and prints, sends nothing.

require('dotenv').config();
const { ethers } = require('ethers');
const path = require('path');
const fs   = require('fs');

function die(msg) { console.error(msg); process.exit(1); }

const BOOK = (process.env.ADDRESSES_FILE || '').trim();
if (!BOOK) die('ADDRESSES_FILE is not set. Set it in THIS window: $env:ADDRESSES_FILE="deployed_addresses_v8_54_private.json"');
if (!BOOK.includes('_private')) die(`REFUSED: "${BOOK}" is not a _private book. This script only shortens clocks on a private test chain.`);

const parkedRaw = process.env.PARKED_SECS, evictRaw = process.env.EVICT_SECS;
if (parkedRaw === undefined || evictRaw === undefined) die('Set BOTH PARKED_SECS and EVICT_SECS explicitly (no defaults on purpose).');
const PARKED = Number(parkedRaw), EVICT = Number(evictRaw);
if (!Number.isInteger(PARKED) || PARKED < 0 || !Number.isInteger(EVICT) || EVICT < 0) die('PARKED_SECS and EVICT_SECS must be whole non-negative seconds.');
const DRY = process.env.DRY_RUN === '1';

const A = JSON.parse(fs.readFileSync(path.join(__dirname, BOOK), 'utf8'));
if (!A.matrixKeeper) die(`No matrixKeeper in ${BOOK}.`);
const confirm = (process.env.CONFIRM_MATRIX_KEEPER || '').trim();
if (confirm.toLowerCase() !== A.matrixKeeper.toLowerCase()) {
  die(`REFUSED: CONFIRM_MATRIX_KEEPER does not match the keeper in ${BOOK}.\n  If this is the chain you mean:  $env:CONFIRM_MATRIX_KEEPER="${A.matrixKeeper}"`);
}

const ABI = [
  'function parkedGracePeriod() view returns (uint256)',
  'function evictionGracePeriod() view returns (uint256)',
  'function setParkedGracePeriod(uint256 v)',
  'function setEvictionGracePeriod(uint256 v)',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => `${s}s (${(s / 3600).toFixed(2)}h)`;

async function setOne(mk, label, getter, setter, want) {
  const cur = Number(await mk[getter]());
  console.log(`${label.padEnd(20)}: current ${fmt(cur)}  ->  want ${fmt(want)}`);
  if (cur === want) { console.log(`${''.padEnd(20)}  already set — nothing sent`); return; }
  if (DRY) { console.log(`${''.padEnd(20)}  [dry run] not sent`); return; }
  let tx;
  try { tx = await mk[setter](want); }
  catch (e) { die(`The CONTRACT refused ${setter}(${want}): ${e.shortMessage || e.message}`); }
  console.log(`${''.padEnd(20)}  tx ${tx.hash}`);
  const r = await tx.wait();
  console.log(`${''.padEnd(20)}  mined block ${r.blockNumber} status ${r.status === 1 ? 'OK' : 'FAILED'}`);
  for (let i = 1; i <= 5; i++) {
    const now = Number(await mk[getter]());
    if (now === want) { console.log(`${''.padEnd(20)}  read-back ${fmt(now)} OK`); return; }
    await sleep(1500);
  }
  console.log(`${''.padEnd(20)}  read-back still stale after ~6s — the tx WAS mined. RE-READ later; do NOT re-run.`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const mk       = new ethers.Contract(A.matrixKeeper, ABI, wallet);
  console.log(`book           : ${BOOK}`);
  console.log(`MatrixKeeper   : ${A.matrixKeeper}`);
  console.log(`signer         : ${wallet.address}${DRY ? '   [DRY RUN]' : ''}`);
  await setOne(mk, 'parkedGracePeriod',   'parkedGracePeriod',   'setParkedGracePeriod',   PARKED);
  await setOne(mk, 'evictionGracePeriod', 'evictionGracePeriod', 'setEvictionGracePeriod', EVICT);
  console.log('done.');
}
main().catch(e => die(e.shortMessage || e.message));
