/**
 * debug_keeper.js
 * Calls checkUpkeep → decodes performData → staticCall performUpkeep to get exact revert reason.
 * Run: npx hardhat run scripts/debug_keeper.js --network baseSepolia
 */

const hre = require("hardhat");
require("dotenv").config();

const MATRIX_KEEPER = "0x3f90161d548Add21e6134478070eA8b94805F9fe"; // V8.27

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
];

const MATRIX_ABI = [
  "function getMemberInfo(address member) external view returns (uint8 matrixIndex, uint8 position, bool isActive, uint256 withdrawableBalance, uint256 parkedAt)",
  "function parkedCount() external view returns (uint256)",
];

const WORK_TYPES = { 0: "NONE", 1: "FORCE_CROSS", 2: "DISTRIBUTE", 3: "VELOCITY_GATE", 4: "PARKED_RESCUE", 5: "EVICT_PARKED" };

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const keeper   = new hre.ethers.Contract(MATRIX_KEEPER, ABI, signer);
  const coder    = hre.ethers.AbiCoder.defaultAbiCoder();
  const WI_TYPE  = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";

  console.log("\n-- debug_keeper.js -----------------------------------------------");
  console.log("Caller:", signer.address);
  console.log("Keeper:", MATRIX_KEEPER);

  // 1. checkUpkeep
  let upkeepNeeded, performData;
  try {
    [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  } catch (e) {
    console.error("checkUpkeep FAILED:", e.message);
    process.exit(1);
  }

  console.log("\n[checkUpkeep]");
  console.log("  upkeepNeeded:", upkeepNeeded);
  console.log("  performData :", performData ? performData.slice(0, 80) + "..." : "(empty)");

  if (!upkeepNeeded) {
    console.log("\nNo work needed -- keeper is idle.");
    return;
  }

  // 2. Decode work items
  let items = [];
  try {
    const [raw] = coder.decode([WI_TYPE], performData);
    items = Array.from(raw);
    console.log("\n[Work items] " + items.length + " total");
    for (const item of items) {
      const wt = Number(item.workType);
      console.log("  workType=" + wt + "(" + (WORK_TYPES[wt]||"?") + ")  tier=" + item.tierIndex + "  addr1=" + item.addr1 + "  addr2=" + item.addr2);
    }
  } catch (e) {
    console.error("  Failed to decode performData:", e.message);
  }

  // 3. staticCall to get exact revert reason
  console.log("\n[staticCall performUpkeep]");
  try {
    await keeper.performUpkeep.staticCall(performData);
    console.log("  staticCall SUCCEEDED -- revert may be transient (nonce/timing)");
  } catch (e) {
    console.log("  REVERTED");
    console.log("  reason :", e.reason   || "(null)");
    console.log("  code   :", e.code     || "(null)");
    console.log("  data   :", e.data     || "(null)");
    console.log("  message:", (e.message || "").slice(0, 400));

    if (e.data && e.data !== "0x") {
      console.log("  Raw revert selector:", e.data.slice(0, 10));
    }
  }

  // 4. Check each parked member's on-chain state (addr2 = member, addr1 = matrix)
  const rescueItems = items.filter(i => Number(i.workType) === 4);
  if (rescueItems.length > 0) {
    console.log("\n[Member state for first 5 rescue candidates]");
    const matContracts = {};

    for (const item of rescueItems.slice(0, 5)) {
      const matAddr = item.addr1;
      if (!matContracts[matAddr]) {
        matContracts[matAddr] = new hre.ethers.Contract(matAddr, MATRIX_ABI, signer);
      }
      const mat    = matContracts[matAddr];
      const member = item.addr2;

      try {
        const info = await mat.getMemberInfo(member);
        const now  = Math.floor(Date.now() / 1000);
        const parkedAgo = info.parkedAt > 0n
          ? (now - Number(info.parkedAt)) + "s ago"
          : "parkedAt=0";
        console.log("  " + member);
        console.log("    matrixIdx=" + info.matrixIndex + "  pos=" + info.position + "  active=" + info.isActive);
        console.log("    withdrawable=$" + (Number(info.withdrawableBalance)/1e6).toFixed(4) + "  parked=" + parkedAgo);
      } catch (e2) {
        console.log("  " + member + "  getMemberInfo FAILED: " + e2.message.slice(0, 80));
      }
    }
  }

  console.log("\n-- done ----------------------------------------------------------");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
