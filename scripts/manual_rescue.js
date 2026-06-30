/**
 * manual_rescue.js
 * Calls performUpkeep directly with hand-crafted rescue-only performData,
 * bypassing checkUpkeep (which is blocked by 19 failing Reclaim items).
 *
 * Root cause: IFigureEightKeeper declares isInMatrix() but the deployed
 * contract implements isActiveInMatrix() — wrong selector, every Reclaim
 * silently fails and floods all keeper slots, rescue never runs.
 *
 * Usage: npx hardhat run scripts/manual_rescue.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const BATCH = 3; // rescue up to this many per TX (gas safety)
const MAX_BATCHES_PER_RUN = 1; // send at most 1 TX per scheduler invocation (prevents overlap)

const MK_ABI = [
  'function performUpkeep(bytes calldata performData) external',
  'function checkUpkeep(bytes calldata) external view returns (bool, bytes memory)',
];

const MAT_ABI = [
  'function getParkedCount() view returns (uint256)',
  'function getParkedMember(uint256 idx) view returns (address)',
  'function isParked(address) view returns (bool)',
  'function parkedAt(address) view returns (uint256)',
  'function withdrawableOf(address) view returns (uint256)',
];

// Rescue ladder Preset 1 (Default) minimum: withdrawable >= 40% of entry fee.
// Members below this floor will NEVER be rescued — skip them to avoid wasted gas.
// (The contract reverts with "F8V8: insufficient withdrawable for rescue" for these.)
const ENTRY_FEE_USDC = 10_000_000n; // $10 with 6 decimals
const RESCUE_FLOOR_BPS = 4_000n;    // 40% = preset 1 floor

const MK_GOV_ABI = [
  'function parkedGracePeriod() view returns (uint256)',
];

const WI_TYPE = 'tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]';
const WORK_PARKED_RESCUE = 4;

async function main() {
  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_30.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const [signer] = await hre.ethers.getSigners();
  console.log('Signer:', signer.address);

  const mk    = new ethers.Contract(addrs.matrixKeeper, [...MK_ABI, ...MK_GOV_ABI], signer);
  const matA  = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, ethers.provider);
  const matB  = new ethers.Contract(addrs.tiers.T1.matB, MAT_ABI, ethers.provider);

  const gracePeriod = await mk.parkedGracePeriod();
  const now = Math.floor(Date.now() / 1000);
  console.log(`Grace period: ${gracePeriod}s`);

  // Scan both matrices; rescue from whichever has eligible members (matB first — larger queue)
  async function scanParked(mat, label, addr) {
    const total = await mat.getParkedCount();
    console.log(`Parked members in ${label}: ${total}`);
    const eligible = [];
    let skippedFloor = 0;
    for (let i = 0; i < Number(total); i++) {
      let member;
      try {
        member = await mat.getParkedMember(i);
      } catch (e) {
        // Array shrank mid-scan (concurrent rescue run removed a member). Stop here.
        console.log(`  ⚠️  Array shrunk at index ${i} (concurrent rescue) — stopping scan early.`);
        break;
      }
      const isParked = await mat.isParked(member);
      const ts = await mat.parkedAt(member);
      const age = now - Number(ts);
      if (!isParked || age < Number(gracePeriod)) {
        console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ⏳ (grace)`);
        continue;
      }
      // Check rescue ladder eligibility: withdrawable must be >= 40% of entry fee
      const withdrawable = await mat.withdrawableOf(member);
      const wBps = (BigInt(withdrawable) * 10_000n) / ENTRY_FEE_USDC;
      if (wBps < RESCUE_FLOOR_BPS) {
        skippedFloor++;
        console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ❌ (withdrawable $${(Number(withdrawable)/1e6).toFixed(2)} < floor — needs eviction)`);
        continue;
      }
      eligible.push(member);
      console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ✅ withdrawable=$${(Number(withdrawable)/1e6).toFixed(2)}`);
    }
    if (skippedFloor > 0) console.log(`  ⚠️  ${skippedFloor} member(s) below rescue floor — run manual_evict.js to clear them.`);
    return { eligible, matAddr: addr };
  }

  // matB first (larger parked queue), fall back to matA
  let { eligible, matAddr } = await scanParked(matB, 'MatB', addrs.tiers.T1.matB);
  if (eligible.length === 0) {
    ({ eligible, matAddr } = await scanParked(matA, 'MatA', addrs.tiers.T1.matA));
  }

  if (eligible.length === 0) {
    console.log('No eligible members to rescue.');
    return;
  }

  // Process in batches
  const tierIdx = 0;
  const matAAddr = matAddr;

  for (let start = 0; start < eligible.length; start += BATCH) {
    const batch = eligible.slice(start, start + BATCH);
    const items = batch.map(member => ({
      workType: WORK_PARKED_RESCUE,
      tierIndex: tierIdx,
      addr1: matAAddr,
      addr2: member,
    }));

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const performData = coder.encode([WI_TYPE], [items]);

    console.log(`\nBatch ${Math.floor(start/BATCH)+1}: rescuing ${batch.length} members…`);
    batch.forEach((m,i) => console.log(`  ${i+1}. ${m}`));

    // Simulate first
    try {
      await mk.performUpkeep.staticCall(performData);
      console.log('  Simulation: ✅ OK');
    } catch (e) {
      console.log('  Simulation: ❌ REVERTED —', e.message.slice(0, 150));
      console.log('  Skipping this batch.');
      continue;
    }

    const tx = await mk.performUpkeep(performData, { gasLimit: 14_000_000 });
    console.log('  TX:', tx.hash);
    const receipt = await tx.wait();
    console.log('  Status:', receipt.status === 1 ? '✅ success' : '❌ failed', `gas=${receipt.gasUsed}`);

    if (Math.floor(start / BATCH) + 1 >= MAX_BATCHES_PER_RUN) {
      const remaining = Math.ceil((eligible.length - start - BATCH) / BATCH);
      if (remaining > 0) console.log(`  Capped at ${MAX_BATCHES_PER_RUN} batch(es)/run — ${remaining} batch(es) deferred to next run.`);
      break;
    }
  }

  const remainingA = await matA.getParkedCount();
  const remainingB = await matB.getParkedCount();
  console.log(`\nParked count after rescue — MatA: ${remainingA}  MatB: ${remainingB}  Total: ${Number(remainingA) + Number(remainingB)}`);
}

main().catch(e => { console.e