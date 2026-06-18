const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const addrFile = path.join(__dirname, "deployed_addresses_v8_5.json");
const raw = JSON.parse(fs.readFileSync(addrFile));

// Normalize address structure
const ADDRS = {
  tierRouter: raw.tierRouter,
  T1: raw.tiers ? raw.tiers.T1 : raw.T1,
  T2: raw.tiers ? raw.tiers.T2 : raw.T2,
};

const RPC = "https://sepolia.base.org";
const provider = new ethers.JsonRpcProvider(RPC);

const MATRIX_ABI = [
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function MATRIX_SIZE() external view returns (uint256)',
  'function getMember(address) external view returns (uint256 memberId, bool hasEverJoined, uint256 bfsPosition, uint256 cycleCount, uint256 withdrawable, uint256 totalEarned)',
  'function escrowOf(address) external view returns (uint256)',
  'function poolAccumulator() external view returns (uint256)',
];
const TR_ABI = [
  'function tierCycles(address, uint8) external view returns (uint256)',
  'function getMemberInfo(address) external view returns (uint8 highestTier, address referrer, uint256 totalCycles, bool doubleEntry, bool whaleGateEligible, bool autoUpgradeEnabled, bool autoReentryEnabled)',
];

const W1 = "0xF4D27E6DfE8688B3F8C8e0D2d9ec4BCa38ed1e63";

async function main() {
  const matrices = [
    { addr: ADDRS.T1.matA, label: 'T1 Matrix A' },
    { addr: ADDRS.T1.matB, label: 'T1 Matrix B' },
    { addr: ADDRS.T2.matA, label: 'T2 Matrix A' },
    { addr: ADDRS.T2.matB, label: 'T2 Matrix B' },
  ];

  console.log("=== MATRIX STATUS ===");
  for (const m of matrices) {
    const mc = new ethers.Contract(m.addr, MATRIX_ABI, provider);
    const [occ, size, rot, pool] = await Promise.all([
      mc.occupancy().catch(()=>0n),
      mc.MATRIX_SIZE().catch(()=>64n),
      mc.rotationCount().catch(()=>0n),
      mc.poolAccumulator().catch(()=>0n),
    ]);
    const w1m = await mc.getMember(W1).catch(()=>null);
    const w1esc = await mc.escrowOf(W1).catch(()=>0n);
    console.log(`${m.label}: ${occ}/${size} seats | rotations: ${rot} | pool: $${(Number(pool)/1e6).toFixed(2)}`);
    if (w1m && w1m.hasEverJoined) {
      const w = Number(w1m.withdrawable)/1e6;
      const e = Number(w1m.totalEarned)/1e6;
      const esc = Number(w1esc)/1e6;
      console.log(`  W1 @ BFS#${w1m.bfsPosition} | cycles:${w1m.cycleCount} | withdrawable:$${w.toFixed(2)} | earned:$${e.toFixed(2)} | escrow:$${esc.toFixed(2)}`);
    }
  }

  console.log("\n=== W1 TIER STATUS ===");
  const tr = new ethers.Contract(ADDRS.tierRouter, TR_ABI, provider);
  const info = await tr.getMemberInfo(W1).catch(()=>null);
  if (info) {
    console.log(`Highest Tier: T${info.highestTier}`);
    console.log(`Total Cycles: ${info.totalCycles}`);
    console.log(`autoUpgrade: ${info.autoUpgradeEnabled} | autoReentry: ${info.autoReentryEnabled} | doubleEntry: ${info.doubleEntry}`);
  }
  const t1cyc = await tr.tierCycles(W1, 0).catch(()=>0n);
  const t2cyc = await tr.tierCycles(W1, 1).catch(()=>0n);
  console.log(`T1 cycles: ${t1cyc} | T2 cycles: ${t2cyc}`);
}

main().catch(console.error);
