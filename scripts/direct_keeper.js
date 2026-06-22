// direct_keeper.js
// Local keeper bridge: polls checkUpkeep → calls performUpkeep on V8.22 MatrixKeeper.
// Replaces Chainlink Automation while CLA registrations are disabled / CRE access is pending.
//
// Run manually:  npx hardhat run scripts/direct_keeper.js --network baseSepolia
// Scheduled:     Windows Task Scheduler — every 2 min, see keeper_task.bat
//
// Logging behaviour:
//   - Quiet runs (no work needed): suppressed. One heartbeat line every HEARTBEAT_EVERY runs (~1 hr).
//   - Active runs (performUpkeep called): always logged with TX hash, block, status, gasUsed, cost.
//   - Errors: always logged regardless.
//   - State persisted to keeper_state.json so counters survive between invocations.

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const MATRIX_KEEPER   = "0xEfA866A4546843Ad9E523507606c0Ed9718737a5"; // V8.22 (per-tier SF mult DAO voting deploy)
const GAS_LIMIT       = 6_000_000;
const LOG_FILE        = path.join(__dirname, "..", "keeper.log");
const STATE_FILE      = path.join(__dirname, "..", "keeper_state.json");
const HEARTBEAT_EVERY = 30; // quiet runs between heartbeat lines (~1 hr at 2-min interval)

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external"
];

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { noWorkCount: 0, totalRuns: 0, lastActive: null };
  }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const keeper   = new hre.ethers.Contract(MATRIX_KEEPER, ABI, signer);

  const state      = loadState();
  state.totalRuns  = (state.totalRuns  || 0) + 1;
  state.noWorkCount = state.noWorkCount || 0;

  // ── checkUpkeep (read-only) ───────────────────────────────────────────────
  let upkeepNeeded, performData;
  try {
    [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  } catch (e) {
    log(`ERROR checkUpkeep: ${e.message}`);
    saveState(state);
    process.exit(1);
  }

  // ── no work needed ───────────────────────────────────────────────────────
  if (!upkeepNeeded) {
    state.noWorkCount += 1;
    if (state.noWorkCount % HEARTBEAT_EVERY === 0) {
      const lastActive = state.lastActive
        ? `last_active=${state.lastActive}`
        : "never_active_this_session";
      log(`♡ Heartbeat — quiet_runs=${state.noWorkCount}  total_runs=${state.totalRuns}  ${lastActive}`);
    }
    saveState(state);
    return;
  }

  // ── work needed ──────────────────────────────────────────────────────────
  log(`► Work needed — calling performUpkeep  (wallet=${signer.address})`);
  state.noWorkCount = 0;

  try {
    const tx      = await keeper.performUpkeep(performData, { gasLimit: GAS_LIMIT });
    log(`  TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    const status  = receipt.status === 1 ? "OK" : "FAILED";

    let costStr = "";
    try {
      const gasEth = hre.ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
      costStr = `  cost=${parseFloat(gasEth).toFixed(6)} ETH`;
    } catch {}

    log(`  Confirmed — block=${receipt.blockNumber}  status=${status}  gasUsed=${receipt.gasUsed.toLocaleString()}${costStr}`);
    state.lastActive = new Date().toISOString();

    if (receipt.status !== 1) { saveState(state); process.exit(1); }
  } catch (e) {
    log(`ERROR performUpkeep: ${e.message}`);
    saveState(state);
    process.exit(1);
  }

  saveState(state);
}

main().catch(e => {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] FATAL: ${e.message}\n`);
  console.error(e);
  process.exit(1);
});
