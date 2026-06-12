const { ethers } = require('ethers');

const RPC = 'https://base-sepolia.g.alchemy.com/v2/JR2WFAmOMRcX9O4vR-wyy';
const provider = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: ethers.Network.from(84532) });

const W1       = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';
const MAT_A1   = '0xE23eF8d2c5d90CD8239ea729479fEdd1E9Fd3e1b';
const MAT_B1   = '0xF059Da5E6C86A7aDeA9AaEAA2Fb8f717BcCD0E4d';
const TIER_R   = '0x16c34eE760868E54E2450d6B10c0C44B0f704856';
const MAT_A2   = '0xb024A680FEA2bf465FB9871b25a5380f5871559b';
const KEEPER   = '0x3009f21D51f7C46ED7EBDC9Fe7f26a4e4C596AAe';

const MAT_ABI = [
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function posToMember(uint256) external view returns (address)',
  'function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
  'function isActiveInMatrix(address) external view returns (bool)',
  'function poolAccumulator() external view returns (uint256)',
];
const TR_ABI = [
  'function memberHighestTier(address) external view returns (uint8)',
  'function tierCycles(address, uint8) external view returns (uint256)',
  'function getMemberInfo(address) external view returns (uint8 highestTier, address referrer, uint256 totalCycles, bool doubleEntry, bool whaleGateEligible, bool autoUpgradeEnabled, bool autoReentryEnabled)',
  'function totalSystemCycles() external view returns (uint256)',
  'function tierVelocityGreen(uint8) external view returns (bool)',
  'function globalJoined(address) external view returns (bool)',
];
const KEEPER_ABI = [
  'function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData)',
];

const matA1 = new ethers.Contract(MAT_A1, MAT_ABI, provider);
const matB1 = new ethers.Contract(MAT_B1, MAT_ABI, provider);
const matA2 = new ethers.Contract(MAT_A2, MAT_ABI, provider);
const tr    = new ethers.Contract(TIER_R, TR_ABI, provider);
const keeper = new ethers.Contract(KEEPER, KEEPER_ABI, provider);

async function main() {
  const fmt6 = v => '$' + (Number(v) / 1e6).toFixed(2);

  // ── T1 MatA ────────────────────────────────────────────────────────
  const [a1occ, a1rot, a1pos1, a1pool] = await Promise.all([
    matA1.occupancy(), matA1.rotationCount(), matA1.posToMember(1), matA1.poolAccumulator()
  ]);
  console.log('\n=== T1 MATRIX A ===');
  console.log(`  Occupancy:      ${a1occ}/127`);
  console.log(`  Rotation count: ${a1rot}`);
  console.log(`  Position #1:    ${a1pos1}`);
  console.log(`  Pool accumulator: ${fmt6(a1pool)}`);

  // ── T1 MatB ────────────────────────────────────────────────────────
  const [b1occ, b1rot, b1pos1, b1pool] = await Promise.all([
    matB1.occupancy(), matB1.rotationCount(), matB1.posToMember(1), matB1.poolAccumulator()
  ]);
  console.log('\n=== T1 MATRIX B ===');
  console.log(`  Occupancy:      ${b1occ}/127`);
  console.log(`  Rotation count: ${b1rot}`);
  console.log(`  Position #1:    ${b1pos1}`);
  console.log(`  Pool accumulator: ${fmt6(b1pool)}`);

  // ── T2 MatA ────────────────────────────────────────────────────────
  const [a2occ, a2rot] = await Promise.all([matA2.occupancy(), matA2.rotationCount()]);
  console.log('\n=== T2 MATRIX A ===');
  console.log(`  Occupancy:      ${a2occ}/127`);
  console.log(`  Rotation count: ${a2rot}`);

  // ── TierRouter — system + W1 ───────────────────────────────────────
  const [sysCycles, w1joined, w1info, w1t1cycles, t1green, t2green] = await Promise.all([
    tr.totalSystemCycles(),
    tr.globalJoined(W1),
    tr.getMemberInfo(W1),
    tr.tierCycles(W1, 0),
    tr.tierVelocityGreen(0),
    tr.tierVelocityGreen(1),
  ]);
  console.log('\n=== TIER ROUTER ===');
  console.log(`  Total system cycles: ${sysCycles}`);
  console.log(`  T1 gate (idx 0):     ${t1green ? 'OPEN' : 'GATED'}`);
  console.log(`  T2 gate (idx 1):     ${t2green ? 'OPEN' : 'GATED'}`);

  console.log('\n=== W1 STATUS ===');
  console.log(`  globalJoined:     ${w1joined}`);
  console.log(`  highestTier:      T${w1info.highestTier + 1} (idx ${w1info.highestTier})`);
  console.log(`  totalCycles:      ${w1info.totalCycles}`);
  console.log(`  autoUpgrade:      ${w1info.autoUpgradeEnabled}`);
  console.log(`  autoReentry:      ${w1info.autoReentryEnabled}`);
  console.log(`  doubleEntry:      ${w1info.doubleEntry}`);
  console.log(`  T1 cycles done:   ${w1t1cycles}`);

  // W1 in each matrix
  const [w1inA1, w1inB1, w1inA2] = await Promise.all([
    matA1.isActiveInMatrix(W1).catch(()=>'err'),
    matB1.isActiveInMatrix(W1).catch(()=>'err'),
    matA2.isActiveInMatrix(W1).catch(()=>'err'),
  ]);
  console.log(`  Active in T1 MatA: ${w1inA1}`);
  console.log(`  Active in T1 MatB: ${w1inB1}`);
  console.log(`  Active in T2 MatA: ${w1inA2}`);

  const w1memberB1 = await matB1.getMember(W1).catch(()=>null);
  if (w1memberB1) {
    console.log(`\n  W1 in T1 MatB:`);
    console.log(`    id:             ${w1memberB1.id}`);
    console.log(`    withdrawable:   ${fmt6(w1memberB1.withdrawable)}`);
    console.log(`    totalEarned:    ${fmt6(w1memberB1.totalEarned)}`);
    console.log(`    cyclesComplete: ${w1memberB1.cyclesCompleted}`);
    console.log(`    isInMatrix:     ${w1memberB1.isInMatrix}`);
    console.log(`    hasEverJoined:  ${w1memberB1.hasEverJoined}`);
  }

  // ── Chainlink keeper ──────────────────────────────────────────────
  console.log('\n=== CHAINLINK KEEPER ===');
  try {
    const [needed, data] = await keeper.checkUpkeep('0x');
    console.log(`  checkUpkeep needed: ${needed}`);
    if (data && data !== '0x') console.log(`  performData: ${data}`);
  } catch(e) {
    console.log(`  checkUpkeep REVERTED: ${e.message.slice(0,120)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
