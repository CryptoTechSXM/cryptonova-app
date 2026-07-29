/**
 * diag_wallet.js — diagnose why a wallet shows no crossing reserve
 * Usage: node scripts/diag_wallet.js [walletAddress]
 * Default wallet: 0x95EBdE6a7C0A91699EAC972C8cD3284F45d5e1e5
 */
require('dotenv').config();
const { ethers } = require('ethers');

const TARGET = process.env.WALLET || process.argv[2] || '0x95EBdE6a7C0A91699EAC972C8cD3284F45d5e1e5';
const RPC    = process.env.BASE_SEPOLIA_RPC_URL;

const ADDRS = {
  tierRouter: '0x8c854e61E92999dE1741943C145b58Df743422c7',
  T1: {
    matA: '0xf22C99AcA9388Fc2cee8bD5B24D311e8D40b14A5',
    matB: '0x623664De078F012E6D1F7B33DDaeA1b8d64A3D41',
  },
  T2: {
    matA: '0x9eFFDa63d88856f59c98774099863F373B671A66',
    matB: '0xf72106ddB79FD7a7F13a9cbA2Ae6DFAde5c151DD',
  },
};

const TR_ABI = [
  'function globalJoined(address) external view returns (bool)',
  'function memberHighestTier(address) external view returns (uint256)',
  'function globalJoinedCount() external view returns (uint256)',
];

const MAT_ABI = [
  'function isInMatrix(address) external view returns (bool)',
  'function crossingReserveOf(address) external view returns (uint256)',
  'function memberData(address) external view returns (uint256 id, uint256 joinedAt, uint256 parkedAt, uint256 totalEarned, uint256 totalWithdrawn, uint256 withdrawable, uint256 crossingReserve)',
  'function rescueDebt(address) external view returns (uint256)',
  'function matrixSize() external view returns (uint256)',
  'function memberCount() external view returns (uint256)',
];

async function main() {
  if (!RPC) { console.error('Missing BASE_SEPOLIA_RPC_URL in .env'); process.exit(1); }
  const rp = new ethers.JsonRpcProvider(RPC);
  const tr = new ethers.Contract(ADDRS.tierRouter, TR_ABI, rp);

  console.log('\n══════════════════════════════════════════════');
  console.log(' Wallet diagnostic:', TARGET);
  console.log('══════════════════════════════════════════════\n');

  // ── TierRouter level ────────────────────────────────────────────────
  const [joined, highestTier, totalMembers] = await Promise.all([
    tr.globalJoined(TARGET).catch(() => null),
    tr.memberHighestTier(TARGET).catch(() => null),
    tr.globalJoinedCount().catch(() => null),
  ]);

  console.log('── TierRouter ────────────────────────────');
  console.log('  globalJoined:     ', joined);
  console.log('  memberHighestTier:', highestTier !== null ? Number(highestTier) : 'error');
  console.log('  totalMembers:     ', totalMembers !== null ? Number(totalMembers) : 'error');

  if (!joined) {
    console.log('\n  ⚠️  Wallet is NOT registered (globalJoined = false)');
    console.log('     No crossing reserve will ever show — member never joined.\n');
    return;
  }

  // ── Per-matrix check (T1 and T2 for now) ────────────────────────────
  const tierSlots = [
    { label: 'T1 MatA', addr: ADDRS.T1.matA },
    { label: 'T1 MatB', addr: ADDRS.T1.matB },
    { label: 'T2 MatA', addr: ADDRS.T2.matA },
    { label: 'T2 MatB', addr: ADDRS.T2.matB },
  ];

  for (const slot of tierSlots) {
    const mc = new ethers.Contract(slot.addr, MAT_ABI, rp);
    const [inMatrix, crRaw, data, debt, mCount] = await Promise.all([
      mc.isInMatrix(TARGET).catch(() => null),
      mc.crossingReserveOf(TARGET).catch(() => null),
      mc.memberData(TARGET).catch(() => null),
      mc.rescueDebt(TARGET).catch(() => 0n),
      mc.memberCount().catch(() => null),
    ]);

    const cr = crRaw !== null ? Number(crRaw) / 1e6 : null;
    console.log(`\n── ${slot.label} (${slot.addr.slice(0,10)}…) ────`);
    console.log('  memberCount:     ', mCount !== null ? Number(mCount) : 'error');
    console.log('  isInMatrix:      ', inMatrix);
    console.log('  crossingReserve: ', cr !== null ? `$${cr.toFixed(6)}` : 'error');

    if (data) {
      const fmt = v => `$${(Number(v) / 1e6).toFixed(2)}`;
      console.log('  memberData:');
      console.log('    id:            ', Number(data.id));
      console.log('    joinedAt:      ', data.joinedAt > 0n ? new Date(Number(data.joinedAt)*1000).toISOString() : '—');
      console.log('    parkedAt:      ', data.parkedAt > 0n ? new Date(Number(data.parkedAt)*1000).toISOString() : '— (not parked)');
      console.log('    totalEarned:   ', fmt(data.totalEarned));
      console.log('    totalWithdrawn:', fmt(data.totalWithdrawn));
      console.log('    withdrawable:  ', fmt(data.withdrawable));
      console.log('    crossingReserve (struct):', fmt(data.crossingReserve));
      if (data.id > 0n && Number(data.crossingReserve) === 0 && inMatrix) {
        console.log('\n  ⚠️  Member IS in matrix but crossingReserve = $0');
        console.log('     Likely joined before V8.32 crossing reserve model was active,');
        console.log('     OR their crossing reserve was consumed (cycle completed).');
      }
    }
    if (Number(debt) > 0) {
      console.log('  rescueDebt:      $' + (Number(debt)/1e6).toFixed(2) + ' (SF loan outstanding)');
    }
  }

  console.log('\n══════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
