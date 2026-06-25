// direct_keeper.js
// Local keeper bridge: polls checkUpkeep → calls performUpkeep on V8.23 MatrixKeeper.
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
//   - Telegram: rescue success + any failure always notified.

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const MATRIX_KEEPER   = "0x6CF638431d8C4cAa735d6aBd23b5AdB322481A3e"; // V8.23 (mintForSale+DIRECT_SALE_ROLE, W1 default referrer)
const GAS_LIMIT       = 25_000_000; // 15 WORK_PARKED_RESCUE items × ~1.58M gas each = ~23.7M; raised from 15M (OOG with full batch)
const LOG_FILE        = path.join(__dirname, "..", "keeper.log");
const STATE_FILE      = path.join(__dirname, "..", "keeper_state.json");
const HEARTBEAT_EVERY = 30; // quiet runs between heartbeat lines (~1 hr at 2-min interval)

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
  "event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex)",
  "event WorkItemFailed(uint8 workType, uint8 tierIndex, address addr1, address addr2)",
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

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const signers = await hre.ethers.getSigners();
  // Use funder (signers[1]=FILL_FUNDER_KEY) not deployer (signers[0]).
  // direct_keeper.js and the CRE simulate task both use the deployer wallet;
  // overlapping invocations cause nonce collisions → TX rejected before mining
  // (ethers action="sendTransaction", reason=null, data=null, 3-in-a-row errors).
  // performUpkeep has no access control so any wallet can call it.
  const signer = signers[1] || signers[0];
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
    const ok      = receipt.status === 1;

    let costStr = "";
    try {
      const gasEth = hre.ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
      costStr = `  cost=${parseFloat(gasEth).toFixed(6)} ETH`;
    } catch {}

    log(`  Confirmed — block=${receipt.blockNumber}  status=${ok ? "OK" : "FAILED"}  gasUsed=${receipt.gasUsed.toLocaleString()}${costStr}`);

    if (ok) {
      // Count rescue events in this TX
      const rescuedEvt  = keeper.interface.getEvent("ParkedRescued");
      const failedEvt   = keeper.interface.getEvent("WorkItemFailed");
      let rescueCount   = 0;
      let failedItems   = [];

      for (const log_ of receipt.logs) {
        try {
          const parsed = keeper.interface.parseLog({ topics: [...log_.topics], data: log_.data });
          if (parsed && parsed.name === "ParkedRescued") rescueCount++;
          if (parsed && parsed.name === "WorkItemFailed")
            failedItems.push(`workType=${parsed.args.workType} tier=${parsed.args.tierIndex}`);
        } catch {}
      }

      if (rescueCount > 0) {
        const msg = `✅ <b>Keeper rescued ${rescueCount} member${rescueCount > 1 ? "s" : ""}</b>\nBlock ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}${costStr}`;
        log(`  ✅ ParkedRescued events: ${rescueCount}`);
        await sendTelegram(msg);
      }

      if (failedItems.length > 0) {
        const msg = `⚠️ <b>Keeper: ${failedItems.length} work item(s) failed</b>\n${failedItems.join("\n")}\nBlock ${receipt.blockNumber}`;
        log(`  ⚠  WorkItemFailed events: ${failedItems.length}`);
        await sendTelegram(msg);
      }

      state.lastActive   = new Date().toISOString();
      state.lastRescueCount = (state.lastRescueCount || 0) + rescueCount;
    } else {
      // TX confirmed but reverted (status=0)
      const isOOG = BigInt(receipt.gasUsed.toString()) >= BigInt(GAS_LIMIT) * 95n / 100n;
      const reason = isOOG
        ? `Out of gas (used ${receipt.gasUsed.toLocaleString()} / ${GAS_LIMIT.toLocaleString()} limit)`
        : "Transaction reverted (status=0, no revert reason available)";
      log(`  ❌ performUpkeep FAILED — ${reason}`);
      await sendTelegram(`❌ <b>Keeper performUpkeep failed</b>\n${reason}\nTX: ${tx.hash}\nBlock: ${receipt.blockNumber}`);
      saveState(state);
      process.exit(1);
    }
  } catch (e) {
    // TX rejected before confirmation (RPC error, nonce issue, etc.)
    const msg = e.message?.slice(0, 200) || "unknown error";
    log(`ERROR performUpkeep: ${msg}`);
    await sendTelegram(`❌ <b>Keeper performUpkeep error</b>\n${msg}`);
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
