const { ethers } = require("ethers");
require("dotenv").config({ path: "/sessions/happy-amazing-curie/mnt/CryptoNite-Smart-Contracts/CryptoNova/.env" });

const addrs = require("/sessions/happy-amazing-curie/mnt/CryptoNite-Smart-Contracts/CryptoNova/scripts/deployed_addresses_v8_12.json");

const MAT_ABI = [
  'function totalMembers() view returns (uint256)',
  'function getOccupancy() view returns (uint256 occupied, uint256 total)',
];
const TR_ABI = [
  'function getVelocityGates() external view returns (bool[10])',
  'function tierCycles(address,uint8) view returns (uint256)',
];

async function main() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const w1 = addrs.accountOne;
  const tr = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);
  const matA1 = new ethers.Contract(addrs.tiers.T1.matA, MAT_ABI, provider);
  const matB1 = new ethers.Contract(addrs.tiers.T1.matB, MAT_ABI, provider);

  const [gates, t1aOcc, t1bOcc, cyc] = await Promise.all([
    tr.getVelocityGates(),
    matA1.getOccupancy(),
    matB1.getOccupancy(),
    tr.tierCycles(w1, 0),
  ]);

  console.log("T1 MatA:", t1aOcc[0].toString(), "/ 127");
  console.log("T1 MatB:", t1bOcc[0].toString(), "/ 127");
  console.log("W1 T1 tierCycles:", cyc.toString());
  console.log("Velocity gates (T1-T10):", gates.map(g => g ? "OPEN" : "closed").join(", "));
}
main().catch(console.error);
