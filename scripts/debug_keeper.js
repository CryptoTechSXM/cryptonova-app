/**
 * debug_keeper.js
 * Checks whether StabilityFund and FigureEightMatrixV8 (T1 MatA)
 * have the correct matrixKeeper address stored.
 *
 * If either is wrong, performUpkeep / payForceCross / forceCrossKeeper
 * will always revert with "not keeper".
 *
 * Usage: node scripts/debug_keeper.js
 */

const { ethers } = require('ethers');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// ── V8.8 Addresses ─────────────────────────────────────────────────────────────
const MATRIX_KEEPER = '0x3009f21D51f7C46ED7EBDC9Fe7f26a4e4C596AAe';
const T1_MATA       = '0xE23eF8d2c5d90CD8239ea729479fEdd1E9Fd3e1b';
const T1_MATB       = '0xF059Da5E6C86A7aDeA9AaEAA2Fb8f717BcCD0E4d';
const TIER_ROUTER   = '0x16c34eE760868E54E2450d6B10c0C44B0f704856';

const KEEPER_ABI = [
  'function stabilityFund() external view returns (address)',
  'function tierRouter() external view returns (address)',
  'function pairManagerForTier(uint8) external view returns (address)',
];

const SF_ABI = [
  'function matrixKeeper() external view returns (address)',
  'function totalBalance() external view returns (uint256)',
  'function stabilityFloor() external view returns (uint256)',
  'function balanceByTier(uint8) external view returns (uint256)',
];

const MATA_ABI = [
  'function matrixKeeper() external view returns (address)',
  'function partner() external view returns (address)',
  'function pairManager() external view returns (address)',
  'function getParkedCount() external view returns (uint256)',
  'function getParkedMember(uint256) external view returns (address)',
  'function isParked(address) external view returns (bool)',
  'function ENTRY_FEE() external view returns (uint256)',
  'function occupancy() external view returns (uint256)',
];

const MATB_ABI = [
  'function matrixKeeper() external view returns (address)',
  'function partner() external view returns (address)',
  'function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
];

function check(label, actual, expected) {
  const ok = actual.toLowerCase() === expected.toLowerCase();
  console.log(`  ${label}`);
  console.log(`    actual  : ${actual}`);
  console.log(`    expected: ${expected}`);
  console.log(`    match   : ${ok ? '✅ OK' : '❌ MISMATCH ← REVERT CAUSE'}`);
  return ok;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });

  const keeper = new ethers.Contract(MATRIX_KEEPER, KEEPER_ABI, provider);
  const matA   = new ethers.Contract(T1_MATA,       MATA_ABI,   provider);
  const matB   = new ethers.Contract(T1_MATB,       MATB_ABI,   provider);

  console.log('═══════════════════════════════════════════════');
  console.log(' KEEPER ADDRESS DIAGNOSTIC');
  console.log('═══════════════════════════════════════════════\n');

  // ── MatrixKeeper internal addresses ──────────────────────────────────────────
  const [sfAddr, routerAddr, pmAddr] = await Promise.all([
    keeper.stabilityFund(),
    keeper.tierRouter(),
    keeper.pairManagerForTier(0),
  ]);
  console.log('── MatrixKeeper config ───────────────────────');
  console.log(`  MATRIX_KEEPER   : ${MATRIX_KEEPER}`);
  console.log(`  stabilityFund() : ${sfAddr}`);
  console.log(`  tierRouter()    : ${routerAddr}`);
  console.log(`  pmForTier[0]    : ${pmAddr}`);
  check('tierRouter vs expected', routerAddr, TIER_ROUTER);

  // ── StabilityFund ─────────────────────────────────────────────────────────────
  const sf = new ethers.Contract(sfAddr, SF_ABI, provider);
  const [sfKeeper, sfTotal, sfFloor, sfT1Bal] = await Promise.all([
    sf.matrixKeeper(),
    sf.totalBalance(),
    sf.stabilityFloor(),
    sf.balanceByTier(0),
  ]);
  console.log('\n── StabilityFund ─────────────────────────────');
  console.log(`  SF address      : ${sfAddr}`);
  console.log(`  totalBalance    : $${(Number(sfTotal)/1e6).toFixed(2)}`);
  console.log(`  stabilityFloor  : $${(Number(sfFloor)/1e6).toFixed(2)}`);
  console.log(`  balanceByTier[0]: $${(Number(sfT1Bal)/1e6).toFixed(2)}`);
  const sfOk = check('SF.matrixKeeper vs MATRIX_KEEPER', sfKeeper, MATRIX_KEEPER);

  // ── T1 MatA ───────────────────────────────────────────────────────────────────
  const [matAKeeper, matAPartner, matAPM, parkedCount, entryFee, matAOcc] = await Promise.all([
    matA.matrixKeeper(),
    matA.partner(),
    matA.pairManager(),
    matA.getParkedCount(),
    matA.ENTRY_FEE(),
    matA.occupancy(),
  ]);
  console.log('\n── T1 MatA ───────────────────────────────────');
  console.log(`  MatA address    : ${T1_MATA}`);
  console.log(`  partner()       : ${matAPartner}  (should be MatB)`);
  console.log(`    vs T1_MATB    : ${matAPartner.toLowerCase() === T1_MATB.toLowerCase() ? '✅' : '❌'}`);
  console.log(`  pairManager()   : ${matAPM}`);
  console.log(`  occupancy       : ${matAOcc}/127`);
  console.log(`  getParkedCount  : ${parkedCount}`);
  console.log(`  ENTRY_FEE       : $${(Number(entryFee)/1e6).toFixed(2)}`);
  const matAOk = check('MatA.matrixKeeper vs MATRIX_KEEPER', matAKeeper, MATRIX_KEEPER);

  // ── T1 MatB ───────────────────────────────────────────────────────────────────
  const [matBKeeper, matBPartner] = await Promise.all([
    matB.matrixKeeper(),
    matB.partner(),
  ]);
  console.log('\n── T1 MatB ───────────────────────────────────');
  console.log(`  MatB address    : ${T1_MATB}`);
  console.log(`  partner()       : ${matBPartner}  (should be MatA)`);
  console.log(`    vs T1_MATA    : ${matBPartner.toLowerCase() === T1_MATA.toLowerCase() ? '✅' : '❌'}`);
  const matBOk = check('MatB.matrixKeeper vs MATRIX_KEEPER', matBKeeper, MATRIX_KEEPER);

  // ── Parked members snapshot ───────────────────────────────────────────────────
  if (parkedCount > 0n) {
    console.log('\n── Parked member check (first 5) ─────────────');
    const toCheck = parkedCount < 5n ? parkedCount : 5n;
    for (let i = 0n; i < toCheck; i++) {
      const addr = await matA.getParkedMember(i);
      const [isParkedInA, memberDataB] = await Promise.all([
        matA.isParked(addr),
        matB.getMember(addr).catch(() => null),
      ]);
      const inMatB = memberDataB ? memberDataB.isInMatrix : '(error)';
      const hasJoinedB = memberDataB ? memberDataB.hasEverJoined : '(error)';
      console.log(`  [${i}] ${addr}`);
      console.log(`       MatA.isParked()    = ${isParkedInA}`);
      console.log(`       MatB.isInMatrix    = ${inMatB}  hasEverJoinedB = ${hasJoinedB}`);
      if (inMatB === true) {
        console.log(`       ⚠️  ALREADY IN MATB — rescue call would revert!`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════');

  if (!sfOk) {
    console.log('  ❌ SF.matrixKeeper MISMATCH — payForceCross() will revert "SF: not keeper"');
    console.log(`     Fix: call sf.setMatrixKeeper(${MATRIX_KEEPER}) from owner`);
  }
  if (!matAOk) {
    console.log('  ❌ MatA.matrixKeeper MISMATCH — forceCrossKeeper() will revert "F8V8: not keeper"');
    console.log(`     Fix: call matA.setMatrixKeeper(${MATRIX_KEEPER}) from owner`);
  }
  if (!matBOk) {
    console.log('  ❌ MatB.matrixKeeper MISMATCH');
    console.log(`     Fix: call matB.setMatrixKeeper(${MATRIX_KEEPER}) from owner`);
  }
  if (sfOk && matAOk && matBOk) {
    console.log('  ✅ All keeper addresses match — NOT a keeper mismatch');
    console.log('  Check: parked members already in MatB (duplicate queue entries)');
    console.log('  Fix: run push_parked.js with ONE-AT-A-TIME mode');
  }

  console.log('');
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
