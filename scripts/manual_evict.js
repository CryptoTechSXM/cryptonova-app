/**
 * manual_evict.js
 * Evicts parked members who are below the SF rescue ladder floor
 * (withdrawable < 40% of entry fee = $4 for T1 $10 tier).
 *
 * These members CANNOT be rescued — the contract reverts with
 * "F8V8: insufficient withdrawable for rescue" for them. Eviction
 * removes them from the parked list so the keeper queue clears.
 *
 * Evicted members lose their matrix position. They can re-register
 * normally if they fund a new $10 entry.
 *
 * Usage: npx hardhat run scripts/manual_evict.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const BATCH = 5; // evictions are cheap (~50k gas each), can do more per TX

const MK_ABI = [
  'function performUpkeep(bytes calldata performData) external',
];

const MAT_ABI = [
  'function getParkedCount() view returns (uint256)',
  'function getParkedMember(uint256 idx) view returns (address)',
  'function isParked(address) view returns (bool)',
  'function parkedAt(address) view returns (uint256)',
  'function withdrawableOf(address) view returns (uint256)',
];

const MK_GOV_ABI = [
  'function parkedGracePeriod() view returns (uint256)',
];

const WI_TYPE = 'tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]';
const WORK_EVICT_PARKED = 6;

// Rescue ladder Preset 1 floor: withdrawable must be >= 40% of entry fee to be rescuable.
// Anyone below this needs eviction, not rescue.
const ENTRY_FEE_USDC = 10_000_000n;
const RESCUE_FLOOR_BPS = 4_000n;

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_29.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const [signer] = await hre.ethers.getSigners();
  console.log('Signer:', signer.address);

  const mk   = new ethers.Contract(addrs.matrixKeeper, [...MK_ABI, ...MK_GOV_ABI], signer);
  const matA = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, ethers.provider);
  const matB = new ethers.Contract(addrs.tiers.T1.matB, MAT_ABI, ethers.provider);

  const gracePeriod = await mk.parkedGracePeriod();
  const now = Math.floor(Date.now() / 1000);
  console.log(`Grace period: ${gracePeriod}s`);

  async function scanEvictable(mat, label, addr) {
    const total = await mat.getParkedCount();
    console.log(`\nScanning ${label} (${total} parked)...`);
    const evictable = [];
    for (let i = 0; i < Number(total); i++) {
      const member = await mat.getParkedMember(i);
      const isParked = await mat.isParked(member);
      const ts = await mat.parkedAt(member);
      const age = now - Number(ts);
      if (!isParked || age < Number(gracePeriod)) continue; // still in grace
      const withdrawable = await mat.withdrawableOf(member);
      const wBps = (BigInt(withdrawable) * 10_000n) / ENTRY_FEE_USDC;
      if (wBps < RESCUE_FLOOR_BPS) {
        evictable.push(member);
        console.log(`  [${i}] ${member.slice(0,10)}… withdrawable=$${(Number(withdrawable)/1e6).toFixed(2)} → EVICT`);
      }
      // Members above the floor should be rescued by manual_rescue.js, not evicted here
    }
    return { evictable, matAddr: addr };
  }

  const results = [
    await scanEvictable(matB, 'T1 MatB', addrs.tiers.T1.matB),
    await scanEvictable(matA, 'T1 MatA', addrs.tiers.T1.matA),
  ];

  let totalEvictable = results.reduce((s, r) => s + r.evictable.length, 0);
  if (totalEvictable === 0) {
    console.log('\nNo members to evict.');
    return;
  }
  console.log(`\nTotal evictable: ${totalEvictable}`);

  for (const { evictable, matAddr } of results) {
    if (evictable.length === 0) continue;
    const tierIdx = 0;

    for (let start = 0; start < evictable.length; start += BATCH) {
      const batch = evictable.slice(start, start + BATCH);
      const items = batch.map(member => ({
        workType: WORK_EVICT_PARKED,
        tierIndex: tierIdx,
        addr1: matAddr,
        addr2: member,
      }));

      const coder = ethers.AbiCoder.defaultAbiCoder();
      const performData = coder.encode([WI_TYPE], [items]);

      console.log(`\nEvict batch ${Math.floor(start/BATCH)+1}: ${batch.length} members from ${matAddr.slice(0,10)}…`);
      batch.forEach((m, i) => console.log(`  ${i+1}. ${m}`));

      try {
        await mk.performUpkeep.staticCall(performData);
        console.log('  Simulation: ✅ OK');
      } catch (e) {
        console.log('  Simulation: ❌ REVERTED —', e.message.slice(0, 150));
        console.log('  Skipping batch.');
        continue;
      }

      const tx = await mk.performUpkeep(performData, { gasLimit: 5_000_000 });
      console.log('  TX:', tx.hash);
      const receipt = await tx.wait();
      console.log('  Status:', receipt.status === 1 ? '✅ success' : '❌ failed', `gas=${receipt.gasUsed}`);
    }
  }

  const remainingA = await matA.getParkedCount();
  const remainingB = await matB.getParkedCount();
  console.log(`\nParked after eviction — MatA: ${remainingA}  MatB: ${remainingB}  Total: ${Number(remainingA) + Number(remainingB)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
