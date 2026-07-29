/**
 * sf_diag_v830.js — StabilityFund + rescue state diagnostic for V8.30
 * npx hardhat run scripts/sf_diag_v830.js --network baseSepolia
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
];
const MK_ABI = [
  'function sfRescueLadderPreset() view returns (uint8)',
  'function parkedGracePeriod() view returns (uint256)',
];
const MAT_ABI = [
  'function withdrawableOf(address) view returns (uint256)',
  'function getParkedCount() view returns (uint256)',
  'function getParkedMember(uint256) view returns (address)',
  'function isParked(address) view returns (bool)',
  'function parkedAt(address) view returns (uint256)',
];
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
const USDC = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';

async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployed_addresses_v8_30.json'), 'utf8'));
  const sf    = new ethers.Contract(addrs.stabilityFund, SF_ABI, ethers.provider);
  const mk    = new ethers.Contract(addrs.matrixKeeper,  MK_ABI, ethers.provider);
  const matA  = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, ethers.provider);
  const usdc  = new ethers.Contract(USDC, USDC_ABI, ethers.provider);

  const [total, floor, t0bal, t1bal, health, target, preset, grace, sfRaw] = await Promise.all([
    sf.totalBalance(), sf.stabilityFloor(),
    sf.balanceByTier(0), sf.balanceByTier(1),
    sf.healthBps(), sf.sfTarget(),
    mk.sfRescueLadderPreset(), mk.parkedGracePeriod(),
    usdc.balanceOf(addrs.stabilityFund),
  ]);

  console.log('=== StabilityFund V8.30 ===');
  console.log('totalBalance:     $' + (Number(total)/1e6).toFixed(2));
  console.log('raw USDC held:    $' + (Number(sfRaw)/1e6).toFixed(2));
  console.log('stabilityFloor:   $' + (Number(floor)/1e6).toFixed(2));
  console.log('balanceByTier[0]: $' + (Number(t0bal)/1e6).toFixed(2) + '  (T1 bucket)');
  console.log('balanceByTier[1]: $' + (Number(t1bal)/1e6).toFixed(2) + '  (T2 bucket)');
  console.log('sfTarget:         $' + (Number(target)/1e6).toFixed(2));
  console.log('healthBps:        ' + health + ' (' + (Number(health)/100).toFixed(1) + '%)');
  console.log('ladderPreset:     ' + preset);
  console.log('gracePeriod:      ' + (Number(grace)/3600).toFixed(1) + 'h');

  const parkedCount = await matA.getParkedCount();
  const now = Math.floor(Date.now()/1000);
  const ENTRY_FEE = 10_000_000n;
  const FLOOR_BPS = 4_000n;
  let eligible = 0, inGrace = 0, total_parked = Number(parkedCount);

  console.log('\n=== MatA Parked (' + total_parked + ' total) ===');
  for (let i = 0; i < Math.min(10, total_parked); i++) {
    const m  = await matA.getParkedMember(i);
    const w  = await matA.withdrawableOf(m);
    const ts = await matA.parkedAt(m);
    const age = now - Number(ts);
    const ageH = (age/3600).toFixed(1);
    const wBps = (BigInt(w) * 10000n) / ENTRY_FEE;
    const shortfall = ENTRY_FEE > BigInt(w) ? Number(ENTRY_FEE - BigInt(w))/1e6 : 0;
    if (age < Number(grace)) { inGrace++; console.log('[' + i + '] ' + m.slice(0,10) + '… $' + (Number(w)/1e6).toFixed(2) + ' ⏳grace age=' + ageH + 'h'); }
    else if (wBps >= FLOOR_BPS) { eligible++; console.log('[' + i + '] ' + m.slice(0,10) + '… $' + (Number(w)/1e6).toFixed(2) + ' ✅ shortfall=$' + shortfall.toFixed(2) + ' age=' + ageH + 'h'); }
    else { console.log('[' + i + '] ' + m.slice(0,10) + '… $' + (Number(w)/1e6).toFixed(2) + ' ❌below-floor age=' + ageH + 'h'); }
  }
  if (total_parked > 10) console.log('... (' + (total_parked-10) + ' more not shown)');
  console.log('\nSummary: ' + eligible + ' rescue-eligible, ' + inGrace + ' in grace, rest below floor or not counted');
  console.log('\nSF can cover ~' + Math.floor(Number(total)/1e6 / 3.82) + ' rescues at ~$3.82 avg shortfall');
}

main().catch(e => { console.error(e); process.exit(1); });
