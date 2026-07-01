/**
 * manual_rescue.js
 * Calls performUpkeep directly with hand-crafted rescue-only performData,
 * bypassing checkUpkeep (which is blocked by Reclaim items or slot limits).
 *
 * Scans ALL configured tiers (T1–T10), both MatA and MatB, collecting every
 * eligible parked member across the system — not just T1.
 *
 * Root cause for isInMatrix-block: IFigureEightKeeper declares isInMatrix()
 * but V8.29 deployed contract implemented isActiveInMatrix() — wrong selector,
 * every Reclaim silently failed and flooded all keeper slots.
 * V8.30 fix: isInMatrix() added to FigureEightMatrixV8.
 *
 * Usage: npx hardhat run scripts/manual_rescue.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const BATCH            = 3; // rescue up to this many per TX (gas safety)
const MAX_BATCHES_PER_RUN = 4; // 4 TXs × 3 members = 12 rescued per scheduler run

const TIER_KEYS = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10'];

// Rescue ladder Preset 1 (Default) minimum withdrawable floor = 40%.
// Members below this floor will NEVER be rescued — skip them to avoid wasted gas.
const RESCUE_FLOOR_BPS = 4_000n; // 40%

const MK_ABI = [
  'function performUpkeep(bytes calldata performData) external',
  'function checkUpkeep(bytes calldata) external view returns (bool, bytes memory)',
  'function parkedGracePeriod() view returns (uint256)',
];

const MAT_ABI = [
  'function getParkedCount() view returns (uint256)',
  'function getParkedMember(uint256 idx) view returns (address)',
  'function isParked(address) view returns (bool)',
  'function parkedAt(address) view returns (uint256)',
  'function withdrawableOf(address) view returns (uint256)',
  'function rescueDebtOf(address) view returns (uint256)',
  'function ENTRY_FEE() view returns (uint256)',  // fee varies per tier
];

const WI_TYPE = 'tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]';
const WORK_PARKED_RESCUE = 4;

async function main() {
  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_30.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const [signer] = await hre.ethers.getSigners();
  console.log('Signer:', signer.address);

  const mk = new ethers.Contract(addrs.matrixKeeper, MK_ABI, signer);
  const gracePeriod = await mk.parkedGracePeriod();
  const now = Math.floor(Date.now() / 1000);
  console.log(`Grace period: ${gracePeriod}s`);

  // ── Scan a single matrix for eligible parked members ──────────────────────
  async function scanParked(matAddr, label, entryFee, tierIdx) {
    const mat = new ethers.Contract(matAddr, MAT_ABI, ethers.provider);
    const total = await mat.getParkedCount();
    if (Number(total) === 0) return [];

    console.log(`\n[T${tierIdx + 1}] ${label}: ${total} parked`);
    const eligible = [];
    let skippedGrace = 0, skippedFloor = 0;

    for (let i = 0; i < Number(total); i++) {
      let member;
      try {
        member = await mat.getParkedMember(i);
      } catch {
        console.log(`  ⚠️  Array shrunk at index ${i} (concurrent rescue) — stopping.`);
        break;
      }

      const isParked = await mat.isParked(member);
      const ts       = await mat.parkedAt(member);
      const age      = now - Number(ts);

      if (!isParked || age < Number(gracePeriod)) {
        skippedGrace++;
        continue;
      }

      // Rescue floor check: withdrawable must be >= 40% of entry fee
      const withdrawable = await mat.withdrawableOf(member);
      const wBps = entryFee > 0n ? (BigInt(withdrawable) * 10_000n) / BigInt(entryFee) : 0n;
      if (wBps < RESCUE_FLOOR_BPS) {
        skippedFloor++;
        console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ❌ (withdrawable $${(Number(withdrawable)/1e6).toFixed(2)} < 40% floor — needs eviction)`);
        continue;
      }

      eligible.push({ member, matAddr, tierIdx });
      console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ✅ $${(Number(withdrawable)/1e6).toFixed(2)}`);
    }

    if (skippedGrace  > 0) console.log(`  ⏳ ${skippedGrace} in grace period`);
    if (skippedFloor  > 0) console.log(`  ⚠️  ${skippedFloor} below rescue floor — run manual_evict.js`);
    return eligible;
  }

  // ── Collect eligible members across all configured tiers ─────────────────
  const allEligible = []; // [{member, matAddr, tierIdx}]

  for (let t = 0; t < TIER_KEYS.length; t++) {
    const key = TIER_KEYS[t];
    if (!addrs.tiers || !addrs.tiers[key]) continue;

    const matAAddr = addrs.tiers[key].matA;
    const matBAddr = addrs.tiers[key].matB;
    if (!matAAddr || !matBAddr) continue;

    // Read entry fee from contract (avoids hardcoding per-tier amounts)
    let entryFee = 10_000_000n; // $10 fallback
    try {
      const matRef = new ethers.Contract(matAAddr, MAT_ABI, ethers.provider);
      entryFee = await matRef.ENTRY_FEE();
    } catch {
      console.log(`  ⚠️  T${t+1}: could not read ENTRY_FEE() — using $10 fallback`);
    }

    // MatB first (tends to have more parked members at higher occupancy)
    const fromB = await scanParked(matBAddr, 'MatB', entryFee, t);
    const fromA = await scanParked(matAAddr, 'MatA', entryFee, t);
    allEligible.push(...fromB, ...fromA);
  }

  if (allEligible.length === 0) {
    console.log('\nNo eligible members to rescue across any tier.');
    return;
  }

  console.log(`\nTotal eligible for rescue: ${allEligible.length} member(s) across all tiers`);

  // ── Process in batches ────────────────────────────────────────────────────
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let batchNum = 0;

  for (let start = 0; start < allEligible.length; start += BATCH) {
    if (batchNum >= MAX_BATCHES_PER_RUN) {
      const remaining = allEligible.length - start;
      console.log(`\nCapped at ${MAX_BATCHES_PER_RUN} batch(es)/run — ${remaining} member(s) deferred to next run.`);
      break;
    }

    const batch = allEligible.slice(start, start + BATCH);
    const items = batch.map(({ member, matAddr, tierIdx }) => ({
      workType:  WORK_PARKED_RESCUE,
      tierIndex: tierIdx,
      addr1:     matAddr,
      addr2:     member,
    }));

    const performData = coder.encode([WI_TYPE], [items]);

    console.log(`\nBatch ${batchNum + 1}: rescuing ${batch.length} member(s)…`);
    batch.forEach(({ member, tierIdx }, i) =>
      console.log(`  ${i+1}. [T${tierIdx+1}] ${member}`)
    );

    // Simulate first — catch revert before wasting gas
    try {
      await mk.performUpkeep.staticCall(performData);
      console.log('  Simulation: ✅ OK');
    } catch (e) {
      console.log('  Simulation: ❌ REVERTED —', e.message.slice(0, 200));
      console.log('  Skipping this batch.');
      batchNum++;
      continue;
    }

    const tx = await mk.performUpkeep(performData, { gasLimit: 14_000_000 });
    console.log('  TX:', tx.hash);
    const receipt = await tx.wait();
    console.log('  Status:', receipt.status === 1 ? '✅ success' : '❌ failed', `gas=${receipt.gasUsed}`);
    batchNum++;
  }

  // ── Final parked counts across all tiers ─────────────────────────────────
  console.log('\n── Post-rescue parked counts ──');
  let grandTotal = 0n;
  for (let t = 0; t < TIER_KEYS.length; t++) {
    const key = TIER_KEYS[t];
    if (!addrs.tiers || !addrs.tiers[key]) continue;
    const matAAddr = addrs.tiers[key].matA;
    const matBAddr = addrs.tiers[key].matB;
    if (!matAAddr || !matBAddr) continue;
    const matA = new ethers.Contract(matAAddr, MAT_ABI, ethers.provider);
    const matB = new ethers.Contract(matBAddr, MAT_ABI, ethers.provider);
    const cA = await matA.getParkedCount();
    const cB = await matB.getParkedCount();
    const total = BigInt(cA) + BigInt(cB);
    if (total > 0n) console.log(`  T${t+1}: MatA=${cA}  MatB=${cB}  (${total})`);
    grandTotal += total;
  }
  console.log(`  TOTAL: ${grandTotal}`);
}

main().catch(e => { console.error(e); process.exit(1); });
