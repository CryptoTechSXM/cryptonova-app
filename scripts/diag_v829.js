const { ethers } = require("ethers");
require("dotenv").config();

const RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const provider = new ethers.JsonRpcProvider(RPC);

const MK_ADDR = "0xFe7ADd5c62695F0E437835670Bc88223EaA51865";
const SF_ADDR = "0x77243188415c6ec7E899303766E4425fa814b6Aa";
const MATB    = "0x40E9aA52a25997146fC016404653c9491b2F069A";
const MATA    = "0x62D2b758c2bC4cd73DCe8bF895e189e6FD57dCA3";

const MK_ABI = [
  "function parkedGracePeriod() external view returns (uint256)",
  "function sfRescueLadderPreset() external view returns (uint8)",
  "function sfRescueThresholds(uint256) external view returns (uint256)",
  "function sfRescueBpsLadder(uint256) external view returns (uint256)",
  "function matrixKeeper() external view returns (address)",
];
const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function balanceByTier(uint8) external view returns (uint256)",
  "function stabilityFloor() external view returns (uint256)",
  "function matrixKeeper() external view returns (address)",
];
const MAT_ABI = [
  "function getParkedCount() external view returns (uint256)",
  "function getParkedMember(uint256) external view returns (address)",
  "function withdrawableOf(address) external view returns (uint256)",
  "function isParked(address) external view returns (bool)",
  "function parkedAt(address) external view returns (uint256)",
  "function occupancy() external view returns (uint256)",
];

async function main() {
  const mk = new ethers.Contract(MK_ADDR, MK_ABI, provider);
  const sf = new ethers.Contract(SF_ADDR, SF_ABI, provider);
  const matA = new ethers.Contract(MATA, MAT_ABI, provider);
  const matB = new ethers.Contract(MATB, MAT_ABI, provider);

  console.log("=== MatrixKeeper ===");
  const grace = await mk.parkedGracePeriod().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("parkedGracePeriod:", grace, "seconds =", Number(grace)/3600, "hrs");
  const preset = await mk.sfRescueLadderPreset().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("sfRescueLadderPreset:", preset);
  // try to read first few thresholds
  let thresholds = [];
  for (let i = 0; i < 12; i++) {
    try { thresholds.push(Number(await mk.sfRescueThresholds(i))); }
    catch(e) { break; }
  }
  console.log("sfRescueThresholds (length=" + thresholds.length + "):", thresholds);

  console.log("\n=== StabilityFund ===");
  const sfTotal = await sf.totalBalance().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("totalBalance:", Number(sfTotal)/1e6, "USDC");
  const sfT0 = await sf.balanceByTier(0).catch(e => "ERR: " + e.message.slice(0,50));
  console.log("balanceByTier[0]:", Number(sfT0)/1e6, "USDC");
  const floor = await sf.stabilityFloor().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("stabilityFloor:", Number(floor)/1e6, "USDC");
  const sfMK = await sf.matrixKeeper().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("SF.matrixKeeper:", sfMK);
  console.log("Expected MK:    ", MK_ADDR);
  console.log("MK registered?", sfMK?.toLowerCase() === MK_ADDR.toLowerCase());

  console.log("\n=== MatA parked queue ===");
  const cntA = await matA.getParkedCount().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("MatA parkedCount:", cntA?.toString());

  console.log("\n=== MatB parked queue ===");
  const cntB = await matB.getParkedCount().catch(e => "ERR: " + e.message.slice(0,50));
  console.log("MatB parkedCount:", cntB?.toString());
  if (Number(cntB) > 0) {
    for (let i = 0; i < Math.min(Number(cntB), 3); i++) {
      const addr = await matB.getParkedMember(i).catch(e => "ERR");
      const w = await matB.withdrawableOf(addr).catch(e => "ERR");
      const p = await matB.parkedAt(addr).catch(e => "ERR");
      const ip = await matB.isParked(addr).catch(e => "ERR");
      console.log(`  [${i}] ${addr} withdrawable=${Number(w)/1e6} USDC isParked=${ip} parkedAt=${new Date(Number(p)*1000).toISOString()}`);
    }
  }
}

main().catch(console.error);
