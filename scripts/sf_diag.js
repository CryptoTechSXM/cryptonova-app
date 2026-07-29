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
];

const MAT_ABI = [
  'function withdrawableOf(address) view returns (uint256)',
  'function getParkedCount() view returns (uint256)',
  'function getParkedMember(uint256) view returns (address)',
  'function isParked(address) view returns (bool)',
  'function parkedAt(address) view returns (uint256)',
];

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_29.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const sf   = new ethers.Contract(addrs.stabilityFund, SF_ABI, ethers.provider);
  const mk   = new ethers.Contract(addrs.matrixKeeper,  MK_ABI, ethers.provider);
  const matA = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, ethers.provider);

  const total  = await sf.totalBalance();
  const floor  = await sf.stabilityFloor();
  const t0bal  = await sf.balanceByTier(0);
  const t1bal  = await sf.balanceByTier(1);
  const health = await sf.healthBps();
  const target = await sf.sfTarget();
  const preset = await mk.sfRescueLadderPreset();

  console.log('=== StabilityFund State ===');
  console.log('totalBalance:     $' + (Number(total)/1e6).toFixed(2));
  console.log('stabilityFloor:   $' + (Number(floor)/1e6).toFixed(2));
  console.log('balanceByTier[0]: $' + (Number(t0bal)/1e6).toFixed(2) + '  (T1 rescue pool)');
  console.log('balanceByTier[1]: $' + (Number(t1bal)/1e6).toFixed(2) + '  (T2)');
  console.log('sfTarget:         $' + (Number(target)/1e6).toFixed(2));
  console.log('healthBps:        ' + health + ' (' + (Number(health)/100) + '%)');
  console.log('ladderPreset:     ' + preset);

  const parkedCount = await matA.getParkedCount();
  console.log('\n=== First 5 of ' + parkedCount + ' parked (MatA) ===');
  for (let i = 0; i < Math.min(5, Number(parkedCount)); i++) {
    const m  = await matA.getParkedMember(i);
    const w  = await matA.withdrawableOf(m);
    const ip = await matA.isParked(m);
    const ts = await matA.parkedAt(m);
    const age = Math.floor(Date.now()/1000) - Number(ts);
    console.log('[' + i + '] ' + m.slice(0,10) + '... withdrawable=$' + (Number(w)/1e6).toFixed(4) + '  isParked=' + ip + '  age=' + (age/3600).toFixed(1) + 'h');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
