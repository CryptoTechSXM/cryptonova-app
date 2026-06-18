const { ethers } = require("hardhat");

const T1 = "0x082CC1C454aA7504e2B2781579b9Ea8faaeFEF62"; // V4 Tier 1
const ABI = [
  {"inputs":[],"name":"totalMembers","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"memberById","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"cyclesCompleted","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"member","type":"address"}],"name":"positionOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"ACTIVE_WINDOW","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
];

async function main() {
  const t1 = await ethers.getContractAt(ABI, T1);
  const total  = Number(await t1.totalMembers());
  const window = Number(await t1.ACTIVE_WINDOW());
  console.log(`Total members  : ${total}`);
  console.log(`ACTIVE_WINDOW  : ${window}`);
  console.log(`Expected rotations: ${Math.max(0, total - window)}`);
  console.log("\nAll members:");
  for (let i = 1; i <= total; i++) {
    const addr    = await t1.memberById(i);
    const cycles  = await t1.cyclesCompleted(addr);
    const qpos    = await t1.positionOf(addr).catch(()=>0n);
    console.log(`  #${i}: ${addr.slice(0,10)}… | cycles: ${cycles} | queue pos: ${qpos}`);
  }
}
main().catch(console.error);
