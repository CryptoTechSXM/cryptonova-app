// postdeploy_check.js — READ-ONLY. The per-deployment settings a deploy run does NOT make.
//
//   $env:ADDRESSES_FILE="deployed_addresses_v8_52.json"; node scripts/postdeploy_check.js
//
// Run it against the NEW address book between "verified on BaseScan" and "frontend cut
// over" (R14). It exits 1 on any FAIL so a runbook line `&& echo cut over` cannot proceed.
//
// WHY THIS EXISTS (REGRESSION_REGISTER R14, two instances so far, both on the V8.52
// community deploy of 2026-09-04):
//   1. MatrixKeeper.upkeepCaller[keeper EOA] is a mapping on the NEW contract. Nobody ran
//      scripts/set_upkeep_caller.js; performUpkeep reverted `MK: not authorized keeper` for
//      ~4h and the only signal was a Telegram FAIL with reason=null.
//   2. StabilityFund.stabilityFloor is a STORED value, $0 on every fresh fund. The owner's
//      rule ("10 x 10 = 100", handoff 58.4) had been applied by hand on V8.51 only. Found
//      by sf_floor_probe.js 29h after cutover (handoff 62.26); the fund had been lending
//      with no buffer the whole time. Fixed with set_stability_floor.js --from-t1.
//   3. TierRouter.graduationEnabled (item G) — was remembered this time; checked anyway,
//      because "remembered this time" is exactly what the first two were on V8.51.
//
// Every read is issued individually. A failed read prints FAIL with the reason — it never
// degrades into a default (a swallowed read impersonating PASS is how the first two were
// missed). Nothing is signed. No signer is constructed.
//
// Fix commands (each signs as the deployer, run them on the PC in the contracts repo):
//   node scripts/set_upkeep_caller.js               (grant the keeper EOA)
//   node scripts/set_stability_floor.js --from-t1   (apply the T1 rule)
//   setGraduationEnabled(true) — see handoff 62.22 for the call used on V8.52

require('dotenv').config();
const { ethers } = require('ethers');
const path = require('path');

if (!process.env.ADDRESSES_FILE) {
  console.error('FATAL: ADDRESSES_FILE not set — refusing to check a default book.');
  console.error('  $env:ADDRESSES_FILE="deployed_addresses_v8_52.json"; node scripts/postdeploy_check.js');
  process.exit(2);
}
if (!process.env.BASE_SEPOLIA_RPC_URL) {
  console.error('FATAL: BASE_SEPOLIA_RPC_URL missing from .env');
  process.exit(2);
}

const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
const KEEPER_EOA = process.env.KEEPER_WALLET || '0xd419681BA72992636f05e256168681c939826B4b';
const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);

const MK = new ethers.Contract(A.matrixKeeper, [
  'function upkeepCaller(address) view returns (bool)',
], provider);
const SF = new ethers.Contract(A.stabilityFund, [
  'function stabilityFloor() view returns (uint256)',
  'function tierEntryFees(uint256) view returns (uint256)',
  'function sfTargetMultiplier(uint256) view returns (uint256)',
  'function totalBalance() view returns (uint256)',
], provider);
const TR = new ethers.Contract(A.tierRouter, [
  'function graduationEnabled() view returns (bool)',
], provider);

const usd = (x) => '$' + (Number(x) / 1e6).toFixed(2);
let fails = 0;
function verdict(ok, name, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
  if (!ok) fails++;
}
async function read(label, fn) {
  try { return await fn(); }
  catch (e) { verdict(false, label, `read failed: ${(e.shortMessage || e.message || String(e)).slice(0, 120)}`); return undefined; }
}

(async () => {
  const blk = await provider.getBlockNumber();
  console.log(`=== post-deploy check ${new Date().toISOString()} (${process.env.ADDRESSES_FILE}) block=${blk} ===`);
  console.log(`  matrixKeeper  ${A.matrixKeeper}`);
  console.log(`  stabilityFund ${A.stabilityFund}`);
  console.log(`  tierRouter    ${A.tierRouter}`);
  console.log(`  keeper EOA    ${KEEPER_EOA}`);
  console.log('  --- per-deployment settings (R14) ---');

  // 1. keeper grant
  const granted = await read('upkeepCaller[keeper EOA]', () => MK.upkeepCaller(KEEPER_EOA));
  if (granted !== undefined) {
    verdict(granted === true, 'upkeepCaller[keeper EOA]',
      granted ? 'granted' : 'NOT granted -> node scripts/set_upkeep_caller.js');
  }

  // 2. stability floor vs the T1 rule
  const floor = await read('stabilityFloor', () => SF.stabilityFloor());
  const fee   = await read('tierEntryFees[0]', () => SF.tierEntryFees(0));
  const mult  = await read('sfTargetMultiplier[0]', () => SF.sfTargetMultiplier(0));
  if (floor !== undefined && fee !== undefined && mult !== undefined) {
    const rule = fee * mult;
    verdict(floor === rule, 'stabilityFloor == T1 fee x mult',
      `stored ${usd(floor)} · rule ${usd(fee)} x ${mult} = ${usd(rule)}` +
      (floor === rule ? '' : ' -> node scripts/set_stability_floor.js --from-t1'));
    const bal = await read('totalBalance', () => SF.totalBalance());
    if (bal !== undefined) console.log(`        totalBalance ${usd(bal)} · spendable above floor ${usd(bal > floor ? bal - floor : 0n)}`);
  }

  // 3. graduation (item G)
  const grad = await read('graduationEnabled', () => TR.graduationEnabled());
  if (grad !== undefined) {
    verdict(grad === true, 'graduationEnabled (item G)', grad ? 'ON' : 'OFF -> setGraduationEnabled(true)');
  }

  console.log('  --- VERDICT ---');
  if (fails === 0) {
    console.log('  ALL PASS — the settings a deploy does not make are in place. Safe to cut over.');
  } else {
    console.log(`  ${fails} FAIL — do NOT point the frontend or keepers at this book until fixed.`);
  }
  console.log('Done. Nothing was signed or sent.');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.shortMessage || e.message || e);
  process.exit(1);
});
