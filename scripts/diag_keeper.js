const hre = require("hardhat");
require("dotenv").config();
const fs = require("fs");

const MATRIX_KEEPER = "0x3de9c7bD20cC82238BC39c98D7A1aC15dd1280df";
const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
  "function sfTarget() external view returns (uint256)",
];

const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function balance() external view returns (uint256)",
];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const keeper = new hre.ethers.Contract(MATRIX_KEEPER, ABI, signer);

  // 1. checkUpkeep
  console.log("=== checkUpkeep ===");
  const [needed, perfData] = await keeper.checkUpkeep("0x");
  console.log("upkeepNeeded:", needed);
  if (!needed) { console.log("No work needed — queue is clear."); return; }

  // 2. Decode performData
  console.log("\n=== performData items ===");
  const coder = hre.ethers.AbiCoder.defaultAbiCoder();
  const WI_TYPE = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
  const [items] = coder.decode([WI_TYPE], perfData);
  console.log("Total items:", items.length);
  for (const it of items) {
    console.log(`  workType=${it.workType} tier=${it.tierIndex} addr1=${it.addr1}`);
  }

  // 3. Cap to 8 rescue items
  const WORK_PARKED_RESCUE = 4n;
  const MAX = 8;
  const rescue = items.filter(i => BigInt(i.workType) === WORK_PARKED_RESCUE);
  const other  = items.filter(i => BigInt(i.workType) !== WORK_PARKED_RESCUE);
  const limited = [...other, ...rescue.slice(0, MAX)];
  const cappedData = coder.encode(
    [WI_TYPE],
    [limited.map(i => [Number(i.workType), Number(i.tierIndex), i.addr1, i.addr2])]
  );
  console.log(`\nCapped batch: ${limited.length} items (${rescue.slice(0,MAX).length} rescue)`);

  // 4. Binary search for max batch size that fits under 15M gas
  console.log("\n=== Batch size gas test ===");
  const encodeN = (n) => coder.encode(
    [WI_TYPE],
    [rescue.slice(0, n).map(i => [Number(i.workType), Number(i.tierIndex), i.addr1, i.addr2])]
  );

  for (let n = 1; n <= Math.min(rescue.length, 10); n++) {
    try {
      await keeper.performUpkeep.staticCall(encodeN(n), { gasLimit: 15_000_000 });
      console.log(`  ${n} items: SUCCEEDED`);
    } catch (e) {
      const msg = e.message?.slice(0, 80) || "unknown";
      console.log(`  ${n} items: FAILED -- ${msg}`);
      break; // stop at first failure
    }
  }

  // 6. SF balance
  console.log("\n=== SF Balance ===");
  const addrFile = process.env.ADDRESSES_FILE || "deployed_addresses_v8_26.json";
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8"));
  const sfAddr = addrs.stabilityFund || addrs.StabilityFund;
  console.log("SF addr:", sfAddr);
  if (sfAddr) {
    const sf = new hre.ethers.Contract(sfAddr, SF_ABI, signer);
    try {
      const bal = await sf.totalBalance();
      console.log("SF totalBalance:", hre.ethers.formatUnits(bal, 6), "USDC");
    } catch {
      try {
        const bal = await sf.balance();
        console.log("SF balance:", hre.ethers.formatUnits(bal, 6), "USDC");
      } catch(e3) { console.log("SF read failed:", e3.message?.slice(0,80)); }
    }
  }

  // 7. sfTarget
  try {
    const t = await keeper.sfTarget();
    console.log("sfTarget:", hre.ethers.formatUnits(t, 6), "USDC");
  } catch(e) { console.log("sfTarget() failed:", e.message?.slice(0,80)); }
}

main().catch(console.error);
