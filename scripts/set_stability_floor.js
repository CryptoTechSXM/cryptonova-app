// set_stability_floor.js — Set StabilityFund.stabilityFloor
//
// Usage:  node scripts/set_stability_floor.js --from-t1
//         node scripts/set_stability_floor.js <dollars>        e.g.  100   0
//
//   --from-t1   compute the floor as tierEntryFees[0] x sfTargetMultiplier[0],
//               read live from the contract. This is the OWNER'S RULE stated
//               2026-09-02: "the buffer should be whatever the T1 multiplier is
//               set to, so currently 10 x 10 = 100".
//
// ── WHY THE RULE IS A FLAG AND NOT A NUMBER ────────────────────────────────
// stabilityFloor is a STORED uint256, not a derived view. The contract will
// never recompute it. So if the DAO moves sfTargetMultiplier[0] from 10 to 20,
// or T1's entry fee changes, the floor SITS AT ITS OLD VALUE while the owner's
// rule says it should have moved. That is the same shape as every defect this
// codebase keeps finding: one fact written down in two places, drifting apart.
// Two things follow, and both are deliberate:
//   1. `--from-t1` reads both inputs off the chain at run time, so re-applying
//      the rule after any governance change is one command with no arithmetic.
//   2. sf_floor_probe.js reports DRIFT when the stored floor no longer equals
//      tierEntryFees[0] x sfTargetMultiplier[0]. The setter cannot keep them in
//      step by itself; the probe is what notices.
//
// ── WHAT THIS SCRIPT DOES NOT DO ───────────────────────────────────────────
// It does not restate the contract's own constraint (`floor <= sfTarget()`).
// set_parked_grace.js learned that the hard way: a script that duplicates a
// contract rule eventually forbids what the chain allows. The setter is the
// authority — we send, and surface the contract's revert reason verbatim.
// It DOES warn (never blocks) about two consequences the contract is happy to
// let you cause: a floor at or above the current balance, and a floor equal to
// sfTarget(), either of which means NO rescue can be paid until the fund grows.
//
// MEASURED BEFORE THIS EXISTED (sf_floor_probe.js, 2026-09-02, block 46297216):
//   stabilityFloor $0.00 · totalBalance $167.40 · sfTarget() $250.00
//   T1 fee $10.00 x multiplier 10 = $100.00

require('dotenv').config();
const { ethers } = require('ethers');
const path = require('path');
const fs   = require('fs');

const raw = process.argv[2];
if (raw === undefined) {
  console.error('Usage: node scripts/set_stability_floor.js --from-t1');
  console.error('       node scripts/set_stability_floor.js <dollars>');
  console.error('  --from-t1  = tierEntryFees[0] x sfTargetMultiplier[0], read live');
  console.error('  100        = $100.00');
  console.error('  0          = no floor (the pre-2026-09-02 state)');
  process.exit(1);
}
const FROM_T1 = raw === '--from-t1';
let wantUsd = null;
if (!FROM_T1) {
  wantUsd = parseFloat(raw);
  if (!Number.isFinite(wantUsd) || wantUsd < 0) {
    console.error(`Not a non-negative number: ${raw}`);
    process.exit(1);
  }
}

if (!process.env.ADDRESSES_FILE) {
  console.error('ADDRESSES_FILE is not set. This script writes a fund parameter with the');
  console.error('owner key — it will not guess the deployment. Set it explicitly, e.g.');
  console.error('  $env:ADDRESSES_FILE="deployed_addresses_v8_51.json"');
  process.exit(1);
}
const ADDR_FILE = path.join(__dirname, process.env.ADDRESSES_FILE);
const addrs = JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));

const ABI = [
  'function stabilityFloor() external view returns (uint256)',
  'function setStabilityFloor(uint256 floor) external',
  'function sfTarget() external view returns (uint256)',
  'function totalBalance() external view returns (uint256)',
  'function tierEntryFees(uint256) external view returns (uint256)',
  'function sfTargetMultiplier(uint256) external view returns (uint256)',
  'function owner() external view returns (address)',
  'function governance() external view returns (address)',
];

const usd = v => '$' + Number(ethers.formatUnits(v, 6)).toFixed(2);

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const sf       = new ethers.Contract(addrs.stabilityFund, ABI, wallet);

  console.log(`addresses file : ${process.env.ADDRESSES_FILE}`);
  console.log(`StabilityFund  : ${addrs.stabilityFund}`);
  console.log(`signer         : ${wallet.address}`);

  // Authorisation is checked BEFORE anything else, because "SF: not authorized"
  // arriving as a revert after a wasted tx is a worse way to learn this.
  const owner = await sf.owner();
  const gov   = await sf.governance();
  const me    = wallet.address.toLowerCase();
  const authorised = me === owner.toLowerCase() || me === gov.toLowerCase();
  console.log(`owner          : ${owner}`);
  console.log(`governance     : ${gov}`);
  if (!authorised) {
    console.error('');
    console.error('This signer is NEITHER owner NOR governance. setStabilityFloor would revert');
    console.error('with "SF: not authorized". Nothing sent. Use the owner key, or route the');
    console.error('change through governance.');
    process.exit(1);
  }

  const current = await sf.stabilityFloor();
  const target  = await sf.sfTarget();
  const balance = await sf.totalBalance();
  const t1fee   = await sf.tierEntryFees(0);
  const t1mult  = await sf.sfTargetMultiplier(0);
  const t1rule  = t1fee * t1mult;

  console.log('');
  console.log(`current floor  : ${usd(current)}`);
  console.log(`sfTarget()     : ${usd(target)}   (the contract caps the floor at this)`);
  console.log(`totalBalance   : ${usd(balance)}`);
  console.log(`T1 rule        : ${usd(t1fee)} fee x ${t1mult} multiplier = ${usd(t1rule)}`);

  const want = FROM_T1 ? t1rule : BigInt(Math.round(wantUsd * 1e6));
  console.log(`setting        : ${usd(want)}${FROM_T1 ? '   (from the live T1 rule)' : ''}`);

  if (current === want) { console.log('Already at that value — nothing to do.'); return; }

  // Warnings, not refusals. The contract permits all of these; the owner should
  // simply not be surprised by them.
  if (want >= balance) {
    console.log('');
    console.log(`  ⚠ This floor (${usd(want)}) is at or above the fund's balance (${usd(balance)}).`);
    console.log(`    Every rescue will be refused until the fund grows past it. That may be`);
    console.log(`    exactly what you want while nobody is parked — just know it is the effect.`);
  }
  if (want === target) {
    console.log('');
    console.log(`  ⚠ Floor == sfTarget(). The fund can then never spend, even at 100% health.`);
  }
  if (!FROM_T1 && want !== t1rule) {
    console.log('');
    console.log(`  ⚠ ${usd(want)} does not match the T1 rule (${usd(t1rule)}). If you meant the rule,`);
    console.log(`    re-run with --from-t1 so it stays reproducible.`);
  }

  let tx;
  try {
    tx = await sf.setStabilityFloor(want);
  } catch (e) {
    console.error(`\nThe CONTRACT refused this value: ${e.shortMessage || e.message}`);
    console.error('That message is the authority, not this script. Read it and pick a value it allows.');
    process.exit(1);
  }
  console.log('');
  console.log(`tx sent        : ${tx.hash}`);
  await tx.wait();

  // Read-back with retry — same reasoning as set_parked_grace.js. A false alarm
  // on a WRITE is more dangerous than no alarm, because the obvious response to
  // it is to send the transaction again.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let updated = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    updated = await sf.stabilityFloor();
    if (updated === want) {
      console.log(`updated        : ${usd(updated)}  OK` + (attempt > 1 ? `  (confirmed on read ${attempt})` : ''));
      const spend = balance > updated ? balance - updated : 0n;
      console.log(`spendable now  : ${usd(balance)} balance - ${usd(updated)} floor = ${usd(spend)}`);
      return;
    }
    if (attempt < 5) await sleep(1500);
  }
  console.log(`updated        : still reads ${usd(updated)} after 5 reads over ~6s`);
  console.log(`  The transaction above was mined. A stale read is the common cause and it`);
  console.log(`  clears on its own. RE-READ in 20s with sf_floor_probe.js before concluding`);
  console.log(`  anything. DO NOT re-run this script on the strength of this message — that`);
  console.log(`  would send a second state-changing transaction for a write that succeeded.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
