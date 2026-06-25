// diagnose_keeper.js
// Simulates checkUpkeep → decodes work items → staticCalls performUpkeep to get actual revert reason.
// Run: npx hardhat run scripts/diagnose_keeper.js --network baseSepolia

const hre = require("hardhat");
require("dotenv").config();

const MATRIX_KEEPER        = "0x3de9c7bD20cC82238BC39c98D7A1aC15dd1280df"; // V8.26
const WORK_PARKED_RESCUE   = 4;
const MAX_RESCUE_PER_BATCH = 8;

const WORK_NAMES = {
  0: "WORK_NONE",
  1: "WORK_VELOCITY_GATE",
  2: "WORK_AUTO_UPGRADE",
  3: "WORK_COMMUNITY_DIST",
  4: "WORK_PARKED_RESCUE",
  5: "WORK_MATRIX_CYCLE",
};

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
  "function parkedGracePeriod() external view returns (uint256)",
];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const keeper = new hre.ethers.Contract(MATRIX_KEEPER, ABI, signer);

  console.log(`\n── diagnose_keeper.js ─────────────────────────────────────`);
  console.log(`Keeper : ${MATRIX_KEEPER}`);
  console.log(`Signer : ${signer.address}`);

  const grace = await keeper.parkedGracePeriod();
  console.log(`parkedGracePeriod: ${grace.toString()}s`);

  // Step 1: checkUpkeep
  let upkeepNeeded, performData;
  try {
    [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  } catch (e) {
    console.error(`\nERROR calling checkUpkeep: ${e.message}`);
    return;
  }

  console.log(`\nupkeepNeeded: ${upkeepNeeded}`);
  if (!upkeepNeeded) {
    console.log("No work needed — keeper is idle.");
    return;
  }

  // Step 2: Decode work items
  const coder = hre.ethers.AbiCoder.defaultAbiCoder();
  const WI_TYPE = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
  let items = [];
  try {
    const [rawItems] = coder.decode([WI_TYPE], performData);
    items = rawItems;
    console.log(`\n── Work items returned by checkUpkeep (${items.length} total) ─────`);
    for (let i = 0; i < items.length; i++) {
      const wi = items[i];
      const wName = WORK_NAMES[Number(wi.workType)] || `UNKNOWN(${wi.workType})`;
      console.log(`  [${i}] workType=${wName}  tier=${wi.tierIndex}  addr1=${wi.addr1}  addr2=${wi.addr2}`);
    }
  } catch (e) {
    console.error(`\nERROR decoding performData: ${e.message}`);
    console.log("Raw performData:", performData);
    return;
  }

  // Step 3: Cap rescue batch (same logic as direct_keeper.js)
  const rescueItems = items.filter(i => Number(i.workType) === WORK_PARKED_RESCUE);
  const otherItems  = items.filter(i => Number(i.workType) !== WORK_PARKED_RESCUE);
  let cappedItems = items;
  if (rescueItems.length > MAX_RESCUE_PER_BATCH) {
    cappedItems = [...otherItems, ...rescueItems.slice(0, MAX_RESCUE_PER_BATCH)];
    console.log(`\nRescue batch capped: ${rescueItems.length} → ${MAX_RESCUE_PER_BATCH}`);
  }
  const cappedData = coder.encode(
    [WI_TYPE],
    [cappedItems.map(i => [Number(i.workType), Number(i.tierIndex), i.addr1, i.addr2])]
  );

  // Step 4: staticCall performUpkeep to get actual revert reason
  console.log(`\n── staticCall performUpkeep (${cappedItems.length} items) ──────────`);
  try {
    await keeper.performUpkeep.staticCall(cappedData, { gasLimit: 15_000_000 });
    console.log("staticCall SUCCEEDED — no revert. TX should work.");
  } catch (e) {
    console.log(`staticCall REVERTED`);
    console.log(`  message  : ${e.message?.slice(0, 500)}`);
    console.log(`  reason   : ${e.reason ?? "(null)"}`);
    console.log(`  errorName: ${e.errorName ?? "(null)"}`);
    console.log(`  data     : ${e.data ?? "(null)"}`);

    // Try to decode a custom error if present
    if (e.data && e.data !== "0x") {
      console.log(`  raw data : ${e.data}`);
    }
  }

  // Step 5: Try each item individually to isolate which one(s) revert
  console.log(`\n── Individual item simulation ──────────────────────────────`);
  for (let i = 0; i < cappedItems.length; i++) {
    const wi = cappedItems[i];
    const wName = WORK_NAMES[Number(wi.workType)] || `UNKNOWN(${wi.workType})`;
    const singleData = coder.encode(
      [WI_TYPE],
      [[[Number(wi.workType), Number(wi.tierIndex), wi.addr1, wi.addr2]]]
    );
    try {
      await keeper.performUpkeep.staticCall(singleData, { gasLimit: 15_000_000 });
      console.log(`  [${i}] ${wName} tier=${wi.tierIndex} → OK`);
    } catch (e) {
      const reason = e.reason ?? e.message?.slice(0, 150) ?? "unknown";
      console.log(`  [${i}] ${wName} tier=${wi.tierIndex} → REVERT: ${reason}`);
    }
  }

  console.log(`\n── Done ────────────────────────────────────────────────────\n`);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
