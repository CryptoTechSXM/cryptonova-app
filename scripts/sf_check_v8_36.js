/**
 * sf_check_v8_36.js — Quick StabilityFund health check for V8.36
 * Usage: npx hardhat run scripts/sf_check_v8_36.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const SF_ABI = [
  'function totalBalance() view returns (uint256)',
  'function stabilityFloor() view returns (uint256)',
  'function balanceByTier(uint8) view returns (uint256)',
  'function healthBps() view returns (uint256)',
  'function sfTarget() view returns (uint256)',
  'function sfTargetAutoMode() view returns (bool)',
];

const MK_ABI = [
  'function sfRescueLadderPreset() view returns (uint8)',
  'function parkedGracePeriod() view returns (uint256)',
];

const MAT_ABI = [
  'function getParkedCount() view returns (uint256)',
  'function occupancy() view returns (uint256)',
  'function rotationCount() view returns (uint256)',
];

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_36.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const sf = new ethers.Contract(addrs.stabilityFund, SF_ABI, ethers.provider);
  const mk = new ethers.Contract(addrs.matrixKeeper,  MK_ABI, ethers.provider);
  const matA = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, ethers.provider);
  const matB = new ethers.Contract(addrs.tiers.T1.matB, MAT_ABI, ethers.provider);

  const [total, floor, health, target, autoMode, preset, grace] = await Promise.all([
    sf.totalBalance(),
    sf.stabilityFloor(),
    sf.healthBps(),
    sf.sfTarget(),
    sf.sfTargetAutoMode(),
    mk.sfRescueLadderPreset(),
    mk.parkedGracePeriod(),
  ]);

  // balanceByTier for first 3 tiers
  const tierBals = [];
  for (let i = 0; i < 3; i++) {
    try { tierBals.push(await sf.balanceByTier(i)); }
    catch { tierBals.push(0n); }
  }

  const [matAOcc, matBOcc, matBRot, parkedCount] = await Promise.all([
    matA.occupancy(),
    matB.occupancy(),
    matB.rotationCount().catch(() => 0n),
    matA.getParkedCount().catch(() => 0n),
  ]);

  console.log('\n══════════════════════════════════════════════');
  console.log('  V8.36 StabilityFund Health Check');
  console.log('══════════════════════════════════════════════');
  console.log(`  totalBalance:    $${(Number(total)/1e6).toFixed(2)}`);
  console.log(`  sfTarget:        $${(Number(target)/1e6).toFixed(2)}  (autoMode=${autoMode})`);
  console.log(`  stabilityFloor:  $${(Number(floor)/1e6).toFixed(2)}`);
  console.log(`  healthBps:       ${health} bps  (${(Number(health)/100).toFixed(1)}%)`);
  console.log(`  ladderPreset:    ${preset}`);
  console.log(`  parkedGrace:     ${grace}s  (${(Number(grace)/3600).toFixed(1)}h)`);
  console.log('\n  balanceByTier:');
  tierBals.forEach((b,i) => console.log(`    T${i+1}: $${(Number(b)/1e6).toFixed(4)}`));
  console.log('\n  T1 MatA occupancy:', matAOcc.toString());
  console.log('  T1 MatB occupancy:', matBOcc.toString(), '  rotations:', matBRot.toString());
  console.log('  MatA parked count:', parkedCount.toString());

  const pct = Number(total) / Number(target);
  if (pct < 0.3) {
    console.log(`\n  ⚠️  SF is LOW (${(pct*100).toFixed(1)}% of target) — topup recommended`);
  } else if (pct < 0.6) {
    console.log(`\n  🟡  SF is moderate (${(pct*100).toFixed(1)}% of target)`);
  } else {
    console.log(`\n  ✅  SF is healthy (${(pct*100).toFixed(1)}% of target)`);
  }
  console.log('══════════════════════════════════════════════\n');
}

main().catch(console.error);
