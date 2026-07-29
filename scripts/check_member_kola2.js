const { ethers } = require('hardhat');

// ── Kola wallet 2 — withdrawal blocked / $21 locked / F8V8 error ──
const WALLET = '0x5704e5f537069127a8a53e7c85d522264a0135ed';

// ── V8.30 addresses ────────────────────────────────────────────
const TIER_ROUTER = '0x43eBF15e6433318b184180A8455e380B7358F161';

const TIERS = [
  { name:'T1', matA:'0x5E52d5A6d118F7539D56C2f37555B25e6308545D', matB:'0x85ac86445F72c3458C2feC3C2D6F268dC124DBCe' },
  { name:'T2', matA:'0xE65338CDFF103FACC47ace7C44669aD99483C576', matB:'0x2b85f9E7Ce05a2925F81254009c3B6352f970741' },
  { name:'T3', matA:'0x6770A506fDbBD1e23c5abc0a2c708e1B98923552', matB:'0x3F595EcA799dE67D59B2905281b2d15C8C019864' },
  { name:'T4', matA:'0x4C48Bd4fBc69530F4d9164dABd7e31E3b7CB1763', matB:'0xfD74590beC228911e29acC34f7DAcF7D86087db1' },
  { name:'T5', matA:'0x464641e5c27B457D85923eA49034FB79DCDFE18a', matB:'0x757FBD778045b1FD213a8170A024e93788Ae298f' },
];

const MAT_ABI = [
  'function getMember(address) view returns (uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined)',
  'function isParked(address) view returns (bool)',
  'function parkedAt(address) view returns (uint256)',
  'function rescueDebtOf(address) view returns (uint256)',
];

const ROUTER_ABI = [
  'function globalJoined(address) view returns (bool)',
  'function getMemberInfo(address) view returns (uint8 highestTier, address referrer, uint256 totalCycles, bool doubleEntry, bool whaleGateEligible, bool autoUpgradeEnabled, bool autoReentryEnabled)',
  'function getMemberOptions(address) view returns (bool autoUpgradeDisabled, bool autoReentryEnabled, bool doubleReentryEnabled, bool optionsSet)',
  'function tierCycles(address, uint8) view returns (uint256)',
];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Kola Wallet 2 diagnostic — V8.30`);
  console.log(`  ${WALLET}`);
  console.log(`${'='.repeat(60)}\n`);

  const router = await ethers.getContractAt(ROUTER_ABI, TIER_ROUTER);

  const gj   = await router.globalJoined(WALLET);
  const info  = await router.getMemberInfo(WALLET);

  console.log(`=== TierRouter ===`);
  console.log(`  globalJoined:       ${gj}`);
  console.log(`  highestTier:        T${info.highestTier}`);
  console.log(`  referrer:           ${info.referrer}`);
  console.log(`  totalCycles:        ${info.totalCycles}`);
  console.log(`  autoReentryEnabled: ${info.autoReentryEnabled}`);
  console.log(`  autoUpgradeEnabled: ${info.autoUpgradeEnabled}`);
  console.log(`  doubleEntry:        ${info.doubleEntry}`);

  for (let i = 0; i < 5; i++) {
    const c = await router.tierCycles(WALLET, i);
    if (c > 0n) console.log(`  T${i+1} cycles:          ${c}`);
  }

  for (const t of TIERS) {
    for (const [label, addr] of [['MatA', t.matA], ['MatB', t.matB]]) {
      try {
        const mat = await ethers.getContractAt(MAT_ABI, addr);
        const m   = await mat.getMember(WALLET);
        if (!m.hasEverJoined) continue;

        const parked = await mat.isParked(WALLET);
        const pAt    = await mat.parkedAt(WALLET);
        const debt   = await mat.rescueDebtOf(WALLET);

        console.log(`\n=== ${t.name} ${label} (${addr.slice(0,10)}…) ===`);
        console.log(`  memberId:        ${m.id}`);
        console.log(`  isInMatrix:      ${m.isInMatrix}`);
        console.log(`  hasEverJoined:   ${m.hasEverJoined}`);
        console.log(`  isParked:        ${parked}`);
        console.log(`  parkedAt:        ${pAt > 0n ? new Date(Number(pAt)*1000).toISOString() : 'n/a'}`);
        console.log(`  withdrawable:    $${ethers.formatUnits(m.withdrawable, 6)}`);
        console.log(`  totalEarned:     $${ethers.formatUnits(m.totalEarned, 6)}`);
        console.log(`  totalWithdrawn:  $${ethers.formatUnits(m.totalWithdrawn, 6)}`);
        console.log(`  cyclesCompleted: ${m.cyclesCompleted}`);
        console.log(`  rescueDebt:      $${ethers.formatUnits(debt, 6)}`);
        console.log(`  joinedAt:        ${m.joinedAt > 0n ? new Date(Number(m.joinedAt)*1000).toISOString() : 'never'}`);

        if (m.hasEverJoined && !m.isInMatrix && !parked) {
          console.log(`  ⚠️  RECLAIMED-LIMBO: hasEverJoined=true, isInMatrix=false, parkedAt=0`);
        }
      } catch(e) {}
    }
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

main().catch(console.error);