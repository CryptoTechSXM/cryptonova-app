// set_parked_grace.js — Set MatrixKeeper.parkedGracePeriod
//
// Usage:  node scripts/set_parked_grace.js <value>
//   <value> ending in "s" is SECONDS   e.g.  300s   0s
//   otherwise it is HOURS              e.g.  6      24      0.5
//
// ── TWO DEFECTS FIXED 2026-08-16 ───────────────────────────────────────────
// 1. The addresses fallback was "deployed_addresses_v8_33.json" — SIXTEEN
//    releases stale. It never bit only because .env supplies ADDRESSES_FILE.
//    Lose that line and this script points the owner key at dead contracts and
//    prints a confident success. Replaced with a refusal, not a newer literal:
//    a newer literal just resets the same clock.
//
// 2. It could not express the value the CONTRACT documents for this situation.
//    The old guard was `if (!hours || hours < 0.1) exit`, which rejects 0
//    outright (!0 is true) and anything under six minutes. But
//    MatrixKeeper.setParkedGracePeriod requires
//        v == 0 || (v >= 5 minutes && v <= 30 days)
//    and its own doc says "0 = no grace period (testing/admin override) …
//    Testnet: 0 or 5-10 minutes". So the script forbade what the chain allows.
//    This is the selfFundedGracePeriod defect in reverse — there a CHECK demanded
//    a value no setter would accept; here a SCRIPT refused one the contract
//    accepts. Same root cause: a rule written down twice, drifting apart.
//
// So this version does NOT restate the contract's range. It validates only that
// the input is a non-negative number, sends it, and surfaces the contract's own
// revert reason if the chain refuses. The setter is the authority; a duplicated
// rule is a rule that will disagree with it eventually.

require('dotenv').config();
const { ethers } = require('ethers');
const path = require('path');
const fs   = require('fs');

const raw = process.argv[2];
if (raw === undefined) {
  console.error('Usage: node scripts/set_parked_grace.js <hours | Ns>');
  console.error('  e.g.  6        -> 6 hours');
  console.error('        300s     -> 300 seconds (contract doc: testnet 0 or 5-10 min)');
  console.error('        0s       -> no grace (contract doc: testing/admin override)');
  process.exit(1);
}

let seconds, how;
if (/^\d+(\.\d+)?s$/i.test(raw)) {
  seconds = Math.round(parseFloat(raw));
  how = `${seconds}s`;
} else {
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    console.error(`Not a non-negative number: ${raw}`);
    process.exit(1);
  }
  seconds = Math.round(hours * 3600);
  how = `${hours}h = ${seconds}s`;
}

if (!process.env.ADDRESSES_FILE) {
  console.error('ADDRESSES_FILE is not set. This script writes a keeper parameter with the');
  console.error('owner key — it will not guess the deployment. Set it explicitly, e.g.');
  console.error('  $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"');
  process.exit(1);
}
const ADDR_FILE = path.join(__dirname, process.env.ADDRESSES_FILE);
const addrs = JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));

const ABI = [
  'function parkedGracePeriod() external view returns (uint256)',
  'function setParkedGracePeriod(uint256 v) external',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const mk       = new ethers.Contract(addrs.matrixKeeper, ABI, wallet);

  console.log(`addresses file : ${process.env.ADDRESSES_FILE}`);
  console.log(`MatrixKeeper   : ${addrs.matrixKeeper}`);
  console.log(`signer         : ${wallet.address}`);
  console.log(`setting        : ${how}`);

  const current = await mk.parkedGracePeriod();
  console.log(`current        : ${Number(current)}s = ${(Number(current) / 3600).toFixed(2)}h`);
  if (Number(current) === seconds) { console.log('Already at that value — nothing to do.'); return; }

  let tx;
  try {
    tx = await mk.setParkedGracePeriod(seconds);
  } catch (e) {
    console.error(`\nThe CONTRACT refused this value: ${e.shortMessage || e.message}`);
    console.error('That message is the authority, not this script. Read it and pick a value it allows.');
    process.exit(1);
  }
  console.log(`tx sent        : ${tx.hash}`);
  await tx.wait();

  // ── READ-BACK WITH RETRY (added 2026-08-16, after this script cried wolf) ──
  // The first version verified ONCE, immediately, and printed
  // "READ-BACK DISAGREES" for a write that had in fact succeeded — the read
  // landed on a pool node still behind the transaction.
  //
  // KEEPER_VPS_CONFIG.md already records this exact failure in
  // set_entry_thresholds.js: three tiers printed "*** VERIFY MISMATCH ***" on
  // successful writes, and the warning "correlated with CONFIRMATION SPEED, not
  // failure". Its own conclusion is the important part:
  //   "The hazard was never the false alarm — it was re-running a state-changing
  //    command that had already worked."
  // A false alarm on a WRITE is more dangerous than no alarm, because the
  // obvious response to it is to send the transaction again.
  //
  // So: retry the read for ~6s before saying anything, and if it still
  // disagrees, say plainly that the fix is to RE-READ, never to re-run.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let updated = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    updated = await mk.parkedGracePeriod();
    if (Number(updated) === seconds) {
      console.log(`updated        : ${Number(updated)}s = ${(Number(updated) / 3600).toFixed(2)}h  OK` +
                  (attempt > 1 ? `  (confirmed on read ${attempt})` : ''));
      return;
    }
    if (attempt < 5) await sleep(1500);
  }
  console.log(`updated        : still reads ${Number(updated)}s after 5 reads over ~6s`);
  console.log(`  The transaction above was mined. A stale read is the common cause and it`);
  console.log(`  clears on its own. RE-READ in 20s before concluding anything:`);
  console.log(`    node -e "require('dotenv').config();const {ethers}=require('ethers');` +
              `const a=require('./scripts/${process.env.ADDRESSES_FILE}');(async()=>{` +
              `const p=new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);` +
              `const c=new ethers.Contract(a.matrixKeeper,['function parkedGracePeriod() view returns (uint256)'],p);` +
              `console.log((await c.parkedGracePeriod()).toString());})()"`);
  console.log(`  DO NOT re-run this script on the strength of this message — that would send`);
  console.log(`  a second state-changing transaction for a write that already succeeded.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
