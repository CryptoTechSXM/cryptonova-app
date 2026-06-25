// direct_keeper.js
// Local keeper bridge: polls checkUpkeep -> calls performUpkeep on V8.25 MatrixKeeper.
// Replaces Chainlink Automation while CLA registrations are disabled / CRE access is pending.
//
// Run manually:  npx hardhat run scripts/direct_keeper.js --network baseSepolia
// Scheduled:     Windows Task Scheduler -- every 2 min, see keeper_task.bat
//
// Logging behaviour:
//   - Quiet runs (no work needed): suppressed. One heartbeat line every HEARTBEAT_EVERY runs (~1 hr).
//   - Active runs (performUpkeep called): always logged with TX hash, block, status, gasUsed, cost.
//   - Errors: always logged regardless.
//   - State persisted to keeper_state.json so counters survive between invocations.
//   - Telegram: rescue success + any failure always notified.

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const MATRIX_KEEPER        = "0x3de9c7bD20cC82238BC39c98D7A1aC15dd1280df"; // V8.26
const GAS_LIMIT            = 15_000_000; // RPC hard cap is 15M (20M/25M rejected "gas limit too high")
const MAX_RESCUE_PER_BATCH = 5;          // post-cycle rescues cost ~1.67M each; 5 x 1.67M = 8.35M + other items leaves ~6M headroom under 15M cap
const WORK_PARKED_RESCUE   = 4;          // workType constant from MatrixKeeper.sol
const WORK_NONE            = 0;          // checkUpkeep returns this post-cycle; skip it from gas budget (otherItems)
const LOG_FILE        = path.join(__dirname, "..", "keeper.log");
const STATE_FILE      = path.join(__dirname, "..", "keeper_state.json");
const HEARTBEAT_EVERY = 30; // quiet runs between heartbeat lines (~1 hr at 2-min interval)

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
  "event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex)",
  "event WorkItemFailed(uint8 workType, uint8 tierIndex, address addr1, address addr2)",
];

// helpers

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

async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML" }),
    });
  } catch {}
}

// Cap rescue items in performData so the batch fits under the 15M gas cap.
// checkUpkeep can return up to 15 WORK_PARKED_RESCUE items; each costs ~1.58M gas.
// 10+ items OOGs. We decode the WorkItem[], limit rescue items, then re-encode.
function capRescueBatch(performData, ethers) {
  try {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const WI_TYPE = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
    const [rawItems] = coder.decode([WI_TYPE], performData);

    const rescueItems = [];
    const otherItems  = [];
    for (const item of rawItems) {
      if (Number(item.workType) === WORK_PARKED_RESCUE) rescueItems.push(item);
      else if (Number(item.workType) !== WORK_NONE) otherItems.push(item); // skip WORK_NONE — post-cycle sentinel, not a real gas cost
    }

    if (rescueItems.length <= MAX_RESCUE_PER_BATCH) return { performData, capped: false };

    const limited = [...otherItems, ...rescueItems.slice(0, MAX_RESCUE_PER_BATCH)];
    const encoded = coder.encode(
      [WI_TYPE],
      [limited.map(i => [Number(i.workType), Number(i.tierIndex), i.addr1, i.addr2])]
    );
    return { performData: encoded, capped: true, total: rescueItems.length, kept: MAX_RESCUE_PER_BATCH };
  } catch (err) {
    // If decode fails for any reason, send the original and let the contract handle it
    return { performData, capped: false, decodeError: err.message };
  }
}

// main

async function main() {
  const signers = await hre.ethers.getSigners();
  // Use funder (signers[1]=FILL_FUNDER_KEY) not deployer (signers[0]).
  // direct_keeper.js and the CRE simulate task both ran on the deployer wallet;
  // overlapping invocations caused nonce collisions. performUpkeep has no access
  // control so any wallet can call it.
  const signer = signers[1] || signers[0];
  const keeper = new hre.ethers.Contract(MATRIX_KEEPER, ABI, signer);

  const state       = loadState();
  state.totalRuns   = (state.totalRuns  || 0) + 1;
  state.noWorkCount = state.noWorkCount || 0;

  // checkUpkeep (read-only)
  let upkeepNeeded, performData;
  try {
    [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  } catch (e) {
    log(`ERROR checkUpkeep: ${e.message}`);
    saveState(state);
    process.exit(1);
  }

  // no work needed
  if (!upkeepNeeded) {
    state.noWorkCount += 1;
    if (state.noWorkCount % HEARTBEAT_EVERY === 0) {
      const lastActive = state.lastActive
        ? `last_active=${state.lastActive}`
        : "never_active_this_session";
      log(`Heartbeat -- quiet_runs=${state.noWorkCount}  total_runs=${state.totalRuns}  ${lastActive}`);
    }
    saveState(state);
    return;
  }

  // work needed -- cap rescue batch before sending
  const cap = capRescueBatch(performData, hre.ethers);
  if (cap.decodeError) {
    log(`  WARN performData decode failed (using original): ${cap.decodeError.slice(0, 100)}`);
  } else if (cap.capped) {
    log(`  INFO Rescue batch capped: ${cap.total} items -> ${cap.kept} (gas budget)`);
  }
  performData = cap.performData;

  log(`Work needed -- calling performUpkeep  (wallet=${signer.address})`);
  state.noWorkCount = 0;

  try {
    const tx      = await keeper.performUpkeep(performData, { gasLimit: GAS_LIMIT });
    log(`  TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    const ok      = receipt.status === 1;

    let costStr = "";
    try {
      const gasEth = hre.ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
      costStr = `  cost=${parseFloat(gasEth).toFixed(6)} ETH`;
    } catch {}

    log(`  Confirmed -- block=${receipt.blockNumber}  status=${ok ? "OK" : "FAILED"}  gasUsed=${receipt.gasUsed.toLocaleString()}${costStr}`);

    if (ok) {
      let rescueCount = 0;
      let failedItems = [];

      for (const log_ of receipt.logs) {
        try {
          const parsed = keeper.interface.parseLog({ topics: [...log_.topics], data: log_.data });
          if (parsed && parsed.name === "ParkedRescued") rescueCount++;
          if (parsed && parsed.name === "WorkItemFailed")
            failedItems.push(`workType=${parsed.args.workType} tier=${parsed.args.tierIndex}`);
        } catch {}
      }

      if (rescueCount > 0) {
        const msg = `Keeper rescued ${rescueCount} member${rescueCount > 1 ? "s" : ""}\nBlock ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}${costStr}`;
        log(`  ParkedRescued events: ${rescueCount}`);
        await sendTelegram(`SUCCESS <b>Keeper rescued ${rescueCount} member${rescueCount > 1 ? "s" : ""}</b>\n${msg}`);
      }

      if (failedItems.length > 0) {
        const msg = `Keeper: ${failedItems.length} work item(s) failed\n${failedItems.join("\n")}\nBlock ${receipt.blockNumber}`;
        log(`  WorkItemFailed events: ${failedItems.length}`);
        await sendTelegram(`WARNING <b>${msg}</b>`);
      }

      state.lastActive      = new Date().toISOString();
      state.lastRescueCount = (state.lastRescueCount || 0) + rescueCount;
    } else {
      // TX confirmed but reverted (status=0)
      const isOOG = BigInt(receipt.gasUsed.toString