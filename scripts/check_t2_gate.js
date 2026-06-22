/**
 * check_t2_gate.js
 * Diagnoses why T2 has no members.
 * Checks: T1 MatB occupancy, T2 velocity gate, MatrixKeeper config,
 *         W1 withdrawable balance, and guard-by-guard _resolveDest simulation.
 *
 * Usage:  node scripts/check_t2_gate.js
 */

const { ethers } = require('ethers');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const W1_ADDR = process.env.W1_ADDRESS || '0x0';

// ── Addresses (V8.8) ─────────────────────────────────────────────────────────
const TIER_ROUTER   = '0x16c34eE760868E54E2450d6B10c0C44B0f704856';
const MATRIX_KEEPER = '0x3009f21D51f7C46ED7EBDC9Fe7f26a4e4C596AAe';
const T1_PM         = '0x3F95a92b029e0aD84d9d544Bb89c65656A145b4C';
const T1_MATB       = '0xF059Da5E6C86A7aDeA9AaEAA2Fb8f717BcCD0E4d';
const T2_PM         = '0x72344b6B2633dab8611D0b10097C6c775ca86661';
const T2_MATA       = '0xb024A680FEA2bf465FB9871b25a5380f5871559b';

// ── ABIs ─────────────────────────────────────────────────────────────────────
const MATRIX_ABI = [
  'function occupancy() external view returns (uint256)',
  'function MATRIX_SIZE() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function isActiveInMatrix(address) external view returns (bool)',
];

const TIER_ROUTER_ABI = [
  'function getVelocityGates() external view returns (bool[7] memory green)',
  'function tierEntryFees(uint8) external view returns (uint256)',
  'function autoUpgradeCycleThreshold() external view returns (uint256)',
  // V8.21: escrowFloorMultiplier() removed -- Guard f was deleted, the param was inert.
  'function memberOptions(address) external view returns (bool autoUpgradeDisabled)',
  'function tierPairManagers(uint8) external view returns (address)',
  'function tierMatrixAAddr(uint8) external view returns (address)',
  'function setTierVelocityGreen(uint8, bool) external',
];

const MATRIX_KEEPER_ABI = [
  'function configuredTierCount() external view returns (uint8)',
  'function maxItemsPerUpkeep() external view returns (uint256)',
  'function pairManagerForTier(uint8) external view returns (address)',
  'function checkUpkeep(bytes) external view returns (bool upkeepNeeded, bytes performData)',
];

const PM_ABI = [
  'function activePairIndex() external view returns (uint256)',
  'function pairCount() external view returns (uint256)',
  'function allPairsStatus() external view returns (address[], address[], uint256[], uint256[], uint256[], bool[])',
];

const MATRIX_WITHDRAWABLE_ABI = [
  'function withdrawable(address) external view returns (uint256)',
];

// ── Helper ────────────────────────────────────────────────────────────────────
function fmt6(n) { return (Number(n) / 1e6).toFixed(2); }
function pct(n, d) { return d > 0 ? (Number(n) * 100 / Number(d)).toFixed(1) + '%' : 'n/a'; }

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const tierRouter   = new ethers.Contract(TIER_ROUTER,   TIER_ROUTER_ABI,   provider);
  const matrixKeeper = new ethers.Contract(MATRIX_KEEPER, MATRIX_KEEPER_ABI, provider);
  const t1MatB       = new ethers.Contract(T1_MATB,       MATRIX_ABI,        provider);
  const t2MatA       = new ethers.Contract(T2_MATA,       MATRIX_ABI,        provider);
  const t1Pm         = new ethers.Contract(T1_PM,         PM_ABI,            provider);

  console.log('═══════════════════════════════════════════════');
  console.log(' T2 VELOCITY GATE DIAGNOSTIC');
  console.log('═══════════════════════════════════════════════\n');

  // ── 1. T1 MatB occupancy ──────────────────────────────────────────────────
  const [t1MatBOcc, t1MatBSize, t1MatBRotations] = await Promise.all([
    t1MatB.occupancy(),
    t1MatB.MATRIX_SIZE(),
    t1MatB.rotationCount(),
  ]);
  const threshold80 = Math.ceil(Number(t1MatBSize) * 80 / 100);
  const meetsThreshold = t1MatBOcc >= BigInt(threshold80);
  console.log('── T1 MatB (pair 0) ──────────────────────────');
  console.log(`  Address   : ${T1_MATB}`);
  console.log(`  Occupancy : ${t1MatBOcc} / ${t1MatBSize}  (${pct(t1MatBOcc, t1MatBSize)})`);
  console.log(`  80% gate  : ${threshold80} needed  →  ${meetsThreshold ? '✅ THRESHOLD MET' : '❌ BELOW THRESHOLD'}`);
  console.log(`  Rotations : ${t1MatBRotations}`);

  // ── 2. PairManager active pair ────────────────────────────────────────────
  const [activePairIdx, pairCnt] = await Promise.all([
    t1Pm.activePairIndex(),
    t1Pm.pairCount(),
  ]);
  console.log(`\n── T1 PairManager ────────────────────────────`);
  console.log(`  Address        : ${T1_PM}`);
  console.log(`  Total pairs    : ${pairCnt}`);
  console.log(`  Active pair    : ${activePairIdx}`);
  if (Number(activePairIdx) > 0) {
    console.log(`  ⚠️  Active pair is NOT pair 0 — keeper may have been checking WRONG matB`);
  }

  // All pairs status
  try {
    const [matAs, matBs, occAs, occBs,, actives] = await t1Pm.allPairsStatus();
    console.log(`  Pairs detail:`);
    for (let i = 0; i < matAs.length; i++) {
      console.log(`    [${i}] MatA occ=${occAs[i]}  MatB occ=${occBs[i]}  active=${actives[i]}`);
    }
  } catch (e) {
    console.log(`  allPairsStatus error: ${e.message}`);
  }

  // ── 3. T2 velocity gate ───────────────────────────────────────────────────
  const [gates, t2Fee, cycleThreshold] = await Promise.all([
    tierRouter.getVelocityGates(),
    tierRouter.tierEntryFees(1),
    tierRouter.autoUpgradeCycleThreshold(),
  ]);
  const t2GateOpen = gates[1];
  console.log(`\n── Velocity Gates (all tiers) ────────────────`);
  for (let i = 0; i < gates.length; i++) {
    console.log(`  T${i+1}: ${gates[i] ? '✅ OPEN' : '❌ CLOSED'}${i === 1 ? ' ← T2' : ''}`);
  }
  console.log(`\n  T2 gate (gates[1])   : ${t2GateOpen ? '✅ OPEN' : '❌ CLOSED ← ROOT CAUSE'}`);
  console.log(`  T2 entry fee         : $${fmt6(t2Fee)} USDC`);
  console.log(`  autoUpgradeCycleThr  : ${cycleThreshold} (guard b early-phase boundary)`);
  // V8.21: Guard f (escrowFloorMultiplier) was deleted -- it never had a real
  // on-chain effect (escrow is always 0), so there's nothing left to report here.

  // ── 4. T2 MatA occupancy ──────────────────────────────────────────────────
  const [t2Occ, t2Size] = await Promise.all([
    t2MatA.occupancy().catch(() => BigInt(0)),
    t2MatA.MATRIX_SIZE().catch(() => BigInt(127)),
  ]);
  console.log(`\n── T2 MatA occupancy ─────────────────────────`);
  console.log(`  Occupancy : ${t2Occ} / ${t2Size}`);

  // ── 5. MatrixKeeper config ────────────────────────────────────────────────
  const [keeperTierCount, keeperMaxItems] = await Promise.all([
    matrixKeeper.configuredTierCount(),
    matrixKeeper.maxItemsPerUpkeep(),
  ]);
  console.log(`\n── MatrixKeeper config ───────────────────────`);
  console.log(`  Address            : ${MATRIX_KEEPER}`);
  console.log(`  configuredTierCount: ${keeperTierCount}`);
  console.log(`  maxItemsPerUpkeep  : ${keeperMaxItems}`);

  // Check what PM the keeper knows for T1
  const keeperT1PM = await matrixKeeper.pairManagerForTier(0).catch(() => '(error)');
  const keeperT2PM = await matrixKeeper.pairManagerForTier(1).catch(() => '(error)');
  console.log(`  pairManagerForTier[0] (T1): ${keeperT1PM}`);
  console.log(`    Expected           : ${T1_PM}`);
  console.log(`    Match              : ${keeperT1PM.toLowerCase() === T1_PM.toLowerCase() ? '✅' : '❌ MISMATCH'}`);
  console.log(`  pairManagerForTier[1] (T2): ${keeperT2PM}`);
  console.log(`    Expected           : ${T2_PM}`);
  console.log(`    Match              : ${keeperT2PM.toLowerCase() === T2_PM.toLowerCase() ? '✅' : '❌ MISMATCH'}`);

  // ── 6. checkUpkeep simulation ─────────────────────────────────────────────
  console.log(`\n── checkUpkeep simulation ────────────────────`);
  try {
    const [needed, perfData] = await matrixKeeper.checkUpkeep('0x');
    console.log(`  upkeepNeeded : ${needed ? '✅ YES — keeper would fire' : '❌ NO — keeper is idle'}`);
    if (needed && perfData !== '0x') {
      console.log(`  performData  : ${perfData.slice(0, 80)}…`);
    }
  } catch (e) {
    console.log(`  checkUpkeep error: ${e.message}`);
  }

  // ── 7. W1 wallet guard simulation ────────────────────────────────────────
  if (W1_ADDR && W1_ADDR !== '0x0') {
    console.log(`\n── W1 _resolveDest guard simulation ─────────`);
    const t1MatAContract = new ethers.Contract(
      '0xE23eF8d2c5d90CD8239ea729479fEdd1E9Fd3e1b', // T1 MatA
      MATRIX_WITHDRAWABLE_ABI,
      provider
    );
    const [w1Withdrawable, w1Options, w1InT2MatA, w1RotCount] = await Promise.all([
      t1MatAContract.withdrawable(W1_ADDR).catch(() => BigInt(0)),
      tierRouter.memberOptions(W1_ADDR).catch(() => ({ autoUpgradeDisabled: false })),
      t2MatA.isActiveInMatrix(W1_ADDR).catch(() => false),
      t1MatB.rotationCount().catch(() => BigInt(0)),
    ]);
    console.log(`  W1 address           : ${W1_ADDR}`);
    console.log(`  W1 withdrawable      : $${fmt6(w1Withdrawable)}`);
    console.log(`  autoUpgradeDisabled  : ${w1Options.autoUpgradeDisabled}`);
    console.log(`  Already in T2 MatA   : ${w1InT2MatA}`);
    console.log(`  T1 MatB rotations    : ${w1RotCount}`);

    const earlyPhase = w1RotCount < cycleThreshold;
    const canAfford  = w1Withdrawable >= t2Fee;
    const floorOk    = earlyPhase || (w1Withdrawable * BigInt(100) >= t2Fee * escrowFloor);
    console.log(`\n  Guard checks for W1 upgrade to T2:`);
    console.log(`  [a] T10 loop    : n/a (T1)`);
    console.log(`  [b] earlyPhase  : ${earlyPhase} (cycles=${w1RotCount} < threshold=${cycleThreshold})  → autoUpgrade skip: ${!earlyPhase && w1Options.autoUpgradeDisabled ? '❌ BLOCKED' : '✅ OK'}`);
    console.log(`  [c] T2 deployed : ${(await tierRouter.tierPairManagers(1)) !== ethers.ZeroAddress ? '✅ YES' : '❌ NO'}`);
    console.log(`  [d] funds       : $${fmt6(w1Withdrawable)} withdrawable vs $${fmt6(t2Fee)} fee  →  ${canAfford ? '✅ SUFFICIENT' : '❌ INSUFFICIENT'}`);
    console.log(`  [e] escrow floor: earlyPhase=${earlyPhase} → ${earlyPhase ? '✅ SKIPPED (early phase)' : floorOk ? '✅ OK' : '❌ BLOCKED'}`);
    console.log(`  [f] velocity gate: tierVelocityGreen[1]=${t2GateOpen}  →  ${t2GateOpen ? '✅ OPEN' : '❌ BLOCKED ← this is the one'}`);
    console.log(`  [g] not in T2   : ${w1InT2MatA ? '❌ ALREADY IN T2 MATA' : '✅ OK'}`);
  }

  // ── 8. Summary & fix ──────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════');

  if (!t2GateOpen) {
    console.log('  ROOT CAUSE: T2 velocity gate is CLOSED');
    console.log('  REASON   : deploy_v8.js closes T2-T7 at deploy;');
    console.log('             MatrixKeeper should auto-open at T1 MatB ≥80%');
    console.log(`  T1 MatB  : ${t1MatBOcc}/${t1MatBSize} = ${pct(t1MatBOcc, t1MatBSize)} (need ≥80% = ${threshold80})`);
    if (meetsThreshold) {
      console.log('  ⚠️  MatB IS ≥80% — keeper should have fired but DIDN\'T');
    } else {
      console.log(`  MatB is below 80% — keeper hasn't fired yet (correct behavior)`);
      console.log(`  Need ${threshold80 - Number(t1MatBOcc)} more registrations in T1 MatB to trigger auto-open`);
    }
    console.log('\n  FIX OPTIONS:');
    console.log('  Option A (immediate): run open_t2_gate.js to manually call setTierVelocityGreen(1, true)');
    console.log('  Option B (correct)  : wait for T1 MatB to reach ≥80% fill — keeper auto-opens');
  } else {
    console.log('  T2 velocity gate is OPEN — velocity gate is NOT the blocker');
    console.log('  Review other guards above for the actual cause');
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
