const { ethers } = require("ethers");
require("dotenv").config();

const MATA = "0x62D2b758c2bC4cd73DCe8bF895e189e6FD57dCA3";
const MATB = "0x40E9aA52a25997146fC016404653c9491b2F069A";
const MK   = "0xFe7ADd5c62695F0E437835670Bc88223EaA51865";
const SF   = "0x77243188415c6ec7E899303766E4425fa814b6Aa";

const ABI = [
  "function partner() external view returns (address)",
  "function chainNext() external view returns (address)",
  "function isParked(address) external view returns (bool)",
  "function withdrawableOf(address) external view returns (uint256)",
  "function ENTRY_FEE() external view returns (uint256)",
  "function getParkedMember(uint256) external view returns (address)",
  "function getParkedCount() external view returns (uint256)",
  "function addRescueDebt(address,uint256) external",
];
const MK_ABI = [
  "function checkUpkeep(bytes) external view returns (bool, bytes)",
  "function maxItemsPerUpkeep() external view returns (uint256)",
  "function parkedGracePeriod() external view returns (uint256)",
];

async function main() {
  const { JsonRpcProvider } = require("ethers");
  const provider = new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org");
  const matA = new ethers.Contract(MATA, ABI, provider);
  const matB = new ethers.Contract(MATB, ABI, provider);
  const mk   = new ethers.Contract(MK, MK_ABI, provider);

  console.log("=== MatA config ===");
  const partnerA = await matA.partner().catch(e => "ERR: " + e.message.slice(0,60));
  console.log("MatA.partner:", partnerA);
  console.log("Expected MatB:", MATB);
  console.log("Partner matches MatB?", partnerA?.toLowerCase() === MATB.toLowerCase());

  const chainA = await matA.chainNext().catch(e => "N/A");
  console.log("MatA.chainNext:", chainA);

  console.log("\n=== MatB config ===");
  const partnerB = await matB.partner().catch(e => "ERR: " + e.message.slice(0,60));
  console.log("MatB.partner:", partnerB);
  console.log("Expected MatA:", MATA);
  console.log("Partner matches MatA?", partnerB?.toLowerCase() === MATA.toLowerCase());

  console.log("\n=== checkUpkeep result ===");
  const maxItems = await mk.maxItemsPerUpkeep().catch(() => "?");
  console.log("maxItemsPerUpkeep:", maxItems?.toString());
  const [needed, data] = await mk.checkUpkeep("0x").catch(e => [false, "0x"]);
  console.log("upkeepNeeded:", needed);
  if (needed && data !== "0x") {
    const WI = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
    const items = ethers.AbiCoder.defaultAbiCoder().decode([WI], data)[0];
    const TYPES = {0:"Velocity",1:"Ghost",2:"Reclaim",3:"ChainLink",4:"RescueParked",5:"VelocityGate",6:"EvictParked",7:"DistributeCW"};
    const counts = {};
    for (const item of items) {
      const t = TYPES[Number(item.workType)] || `Unknown(${item.workType})`;
      counts[t] = (counts[t] || 0) + 1;
    }
    console.log("Work items:", items.length, "total:", JSON.stringify(counts));
    // Show first rescue item detail
    const rescueItem = items.find(i => Number(i.workType) === 4);
    if (rescueItem) {
      const addr = rescueItem.addr2;
      const isP  = await matA.isParked(addr).catch(() => "ERR");
      const w    = await matA.withdrawableOf(addr).catch(() => "ERR");
      console.log(`\nFirst RescueParked item: matrix=${rescueItem.addr1} member=${addr}`);
      console.log(`  isParked=${isP}  withdrawable=$${Number(w)/1e6}`);
    }
  }
}
main().catch(console.error);
