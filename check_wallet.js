const { ethers } = require('ethers');
const rp = new ethers.JsonRpcProvider('https://sepolia.base.org');

const ADDR = '0x1D3E33aAFFDb694E5a45d793B6946120467e93AB';

const ADDRS = {
  tierRouter: '0xD405C5012658025f3c4c83d420561F42F3954c38',
  T1: {
    matA: '0xf5F4B67e4DAF9bd7a00cb264FF2e95493d32ae50',
    matB: '0x9Cf2d1ef0fEf07D4Fc1e2b2e4b7F8E9d3A5c6B8',
  },
  T2: {
    matA: '0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0',
    matB: '0xB2c3D4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9B0c1',
  },
};

const MATRIX_ABI = [
  'function getMember(address) external view returns (tuple(uint256 id, address referrer, address l2Sponsor, address l3Sponsor, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined, uint256 bfsPosition, uint256 lastActivityTime))',
  'function escrowOf(address) external view returns (uint256)',
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function poolAccumulator() external view returns (uint256)',
  'function MATRIX_SIZE() external view returns (uint256)',
];

const TR_ABI = [
  'function globalJoined(address) external view returns (bool)',
  'function memberTier(address) external view returns (uint8)',
  'function tierCycles(address, uint8) external view returns (uint256)',
];

const fmt6 = (v) => '$' + (Number(v) / 1e6).toFixed(2);

async function main() {
  const tr = new ethers.Contract(ADDRS.tierRouter, TR_ABI, rp);
  const joined = await tr.globalJoined(ADDR).catch(() => false);
  const tier   = await tr.memberTier(ADDR).catch(() => 0);
  console.log(`\nWallet: ${ADDR}`);
  console.log(`Registered: ${joined} | Highest tier: T${tier}`);

  const labels = ['T1 MatA', 'T1 MatB', 'T2 MatA', 'T2 MatB'];
  const addrs  = [ADDRS.T1.matA, ADDRS.T1.matB, ADDRS.T2.matA, ADDRS.T2.matB];

  for (let i = 0; i < addrs.length; i++) {
    const mc = new ethers.Contract(addrs[i], MATRIX_ABI, rp);
    const [member, escrow, occ, cycles, pool, msize] = await Promise.all([
      mc.getMember(ADDR).catch(() => null),
      mc.escrowOf(ADDR).catch(() => 0n),
      mc.occupancy().catch(() => 0n),
      mc.rotationCount().catch(() => 0n),
      mc.poolAccumulator().catch(() => 0n),
      mc.MATRIX_SIZE().catch(() => 64n),
    ]);
    if (member && member.hasEverJoined) {
      console.log(`\n--- ${labels[i]} ---`);
      console.log(`  Member ID:      #${member.id}`);
      console.log(`  BFS Position:   ${member.bfsPosition} of ${msize} (${member.isInMatrix ? 'IN MATRIX' : 'cycled out'})`);
      console.log(`  Withdrawable:   ${fmt6(member.withdrawable)}`);
      console.log(`  Total Earned:   ${fmt6(member.totalEarned)}`);
      console.log(`  Escrow:         ${fmt6(escrow)}`);
      console.log(`  Cycles done:    ${member.cyclesCompleted}`);
      console.log(`  Matrix cycles:  ${cycles} total | Occupancy: ${occ}/${msize}`);
      console.log(`  Pool now:       ${fmt6(pool)} (shared by ~63 members at next cycle-out)`);
      console.log(`  Referrer:       ${member.referrer}`);
      
      // Calculate expected pool share
      const poolShare = Number(pool) / 63 / 1e6;
      console.log(`  Pool share est: $${poolShare.toFixed(4)} at next cycle-out`);
      
      // BFS position analysis
      const bfs = Number(member.bfsPosition);
      const msz = Number(msize);
      const firstLeaf = Math.floor(msz / 2) + 1;
      if (bfs >= firstLeaf) {
        console.log(`  Position type:  LEAF (pos ${bfs} >= ${firstLeaf}) — earns pool only, no chain pay from below`);
      } else {
        const subtreeSize = msz - bfs; // rough estimate
        console.log(`  Position type:  INTERNAL (pos ${bfs}) — receives chain pay from members registering in subtree`);
      }
    }
  }
}

main().catch(console.error);
