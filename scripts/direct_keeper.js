// direct_keeper.js
// Local keeper bridge: polls checkUpkeep → calls performUpkeep on V8.17 MatrixKeeper.
// Replaces Chainlink Automation while CLA registrations are disabled / CRE access is pending.
//
// Run manually:  npx hardhat run scripts/direct_keeper.js --network baseSepolia
// Scheduled:     Windows Task Scheduler — see keeper_task.bat in this folder

const hre = require("hardhat");

const MATRIX_KEEPER = "0x63198dD709933B6c6E02Fd533a44B0b0Cd9137BA"; // V8.17
const GAS_LIMIT     = 6_000_000;
const LOG_FILE      = require("path").join(__dirname, "..", "keeper.log");

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external"
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  require("fs").appendFileSync(LOG_FILE, line + "\n");
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  log(`Keeper wallet: ${signer.address}`);

  const keeper = new hre.ethers.Contract(MATRIX_KEEPER, ABI, signer);

  // --- checkUpkeep (read-only) ---
  let upkeepNeeded, performData;
  try {
    [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  } catch (e) {
    log(`ERROR checkUpkeep: ${e.message}`);
    process.exit(1);
  }

  if (!upkeepNeeded) {
    log("No work needed — skipping.");
    return;
  }

  log("Work needed — calling performUpkeep...");

  // --- performUpkeep (state-changing) ---
  try {
    const tx = await keeper.performUpkeep(performData, { gasLimit: GAS_LIMIT });
    log(`TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    const status = receipt.status === 1 ? "OK" : "FAILED";
    log(`Confirmed — block ${receipt.blockNumber}  status=${status}  gasUsed=${receipt.gasUsed.toString()}`);
    if (receipt.status !== 1) process.exit(1);
  } catch (e) {
    log(`ERROR performUpkeep: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => {
  require("fs").appendFileSync(LOG_FILE, `[${new Date().toISOString()}] FATAL: ${e.message}\n`);
  console.error(e);
  process.exit(1);
});
