/**
 * diag_matrix_state.js
 * Dumps occupancy + rotationCount for all tier matrices.
 * Run: npx hardhat run scripts/diag_matrix_state.js --network baseSepolia
 */
const { ethers } = require('hardhat');
const fs   = require('fs');
const path = require('path');

// Look for the addresses file in both root and scripts/ subdirectory
const ADDRS_FILE = (function() {
  const candidates = [
    process.env.ADDRESSES_FILE,
    'scripts/deployed_addresses_v8_33.json',
    'deployed_addresses_v8_33.json',
  ].filter(Boolean);
  for (const f of candidates) {
    const resolved = path.resolve(f);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error('Could not find deployed_addresses_v8_33.json — tried: ' + candidates.join(', '));
})();
const ADDRS = JSON.parse(fs.readFileSync(ADDRS_FILE));

const matAbi = [
  'function occupancy()     external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function MATRIX_SIZE()   external view returns (uint256)',
  'function isFull()        external view returns (bool)',
  'function nextSlot()      external view returns (uint256)',
  'function totalJoined()   external view returns (uint256)',
];
const trAbi = [
  'function globalJoinedCount() external view returns (uint256)',
  'function globalJoined(address) external view returns (bool)',
  'function memberReferrer(address) external view returns (address)',
  'function tierCycles(address, uint8) external view returns (uint256)',
  'function memberHighestTier(address) external view returns (uint8)',
];

async function checkMat(label, addr, provider) {
  if (!addr || addr === ethers.ZeroAddress) {
    console.log(`  ${label}: (not deployed)`);
    return;
  }
  const mc = new ethers.Contract(addr, matAbi, provider);
  try {
    const [occ, size, rot, full, next, joined] = await Promise.all([
      mc.occupancy().catch(() => '?'),
      mc.MATRIX_SIZE().catch(() => 127),
      mc.rotationCount().catch(() => '?'),
      mc.isFull().catch(() => '?'),
      mc.nextSlot().catch(() => '?'),
      mc.totalJoined().catch(() => '?'),
    ]);
    const fullTag = full === true ? ' ← FULL' : '';
    console.log(`  ${label}: ${occ}/${size} seats  rotations=${rot}  nextSlot=${next}  totalJoined=${joined}${fullTag}`);
  } catch (e) {
    console.log(`  ${label}: ERROR — ${e.message.slice(0, 80)}`);
  }
}

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;

  const tr = new ethers.Contract(ADDRS.tierRouter, trAbi, provider);
  const total = await tr.globalJoinedCount().catch(() => '?');
  console.log('=== V8.33 Matrix State ===');
  console.log(`TierRouter: ${ADDRS.tierRouter}`);
  console.log(`Total registered members: ${total}`);
  console.log('');

  const tiers = ADDRS.tiers || {};
  for (const [key, val] of Object.entries(tiers)) {
    if (!val) continue;
    console.log(`${key}:`);
    await checkMat('MatA', val.matA, provider);
    await checkMat('MatB', val.matB, provider);
  }

  // Also check the from-address that reverted
  const TARGET = '0x7308daF433804e8F10Dd267C70332609bd491477';
  console.log('\n=== Member #10 (upgrade reverter) ===');
  console.log(`Address: ${TARGET}`);
  try {
    const [joined, referrer, t1cycles, highest] = await Promise.all([
      tr.globalJoined(TARGET).catch(() => '?'),
      tr.memberReferrer(TARGET).catch(() => '?'),
      tr.tierCycles(TARGET, 0).catch(() => '?'),   // T1 index = 0
      tr.memberHighestTier(TARGET).catch(() => '?'),
    ]);
    console.log(`globalJoined      : ${joined}`);
    console.log(`referrer          : ${referrer}`);
    console.log(`T1 cycles (idx 0) : ${t1cycles}`);
    console.log(`memberHighestTier : ${highest}`);
  } catch (e) {
    console.log('Error checking address:', e.message.slice(0, 80));
  }
}

main().catch(console.error);
