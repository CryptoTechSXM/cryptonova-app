// direct_keeper.js
// Local keeper bridge: polls checkUpkeep -> calls performUpkeep on V8.29 MatrixKeeper.
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

// MatrixKeeper address — read from deployed_addresses file so no manual edit needed on redeploy
const MATRIX_KEEPER = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_30.json'), 'utf8')).matrixKeeper; // V8.30: 0x49462597Ce4F58AeE94202a296810Aa458f357Bb
const GAS_LIMIT            = 15_000_000; // RPC hard cap is 15M (20M/25M rejected "gas limit too high")
const WORK_PARKED_RESCUE   = 4;          // workType constant from MatrixKeeper.sol
const GAS_SAFE             = 14_000_000; // target ceiling — stay under 15M RPC hard cap
const MIN_RESCUE_BATCH     = 1;          // floor: always attempt at least 1
const MAX_RESCUE_BATCH     = 25;         // ceiling: keeper self-limits via gas learning
const GAS_PER_ITEM_DEFAULT = 3_500_000;  // conservative starting estimate
// Self-healing batch sizing (two-layer):
//   gasPerItem  — EMA of actual gas/rescue, updated on SUCCESS only (alpha=0.3).
//   currentCap  — working batch cap stored in keeper_state.json.
//     On SUCCESS : currentCap = clamp(floor(GAS_SAFE/gasPerItem), MIN, MAX)  [grows as gas drops]
//     On OOG     : currentCap = max(MIN, floor(currentCap/2))                [halves immediately]
//     On non-gas : currentCap unchanged (might be transient RPC / logic error)
// Net effect: starts aggressive (up to 25), backs off when it hits gas walls,
// recovers automatically as costs fall (e.g. post-contract optimisation).
const LOG_FILE        = path.join(__dirname, "..", "keeper.log");
const STATE_FILE      = path.join(__dirname, "..", "keeper_state.json");
const HEARTBEAT_EVERY = 5;  // quiet runs between heartbeat lines (~10 min at 2-min interval)

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
    return { noWorkCount: 0, totalRuns: 0, lastActive: null, activeWorkCount: 0 };
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

// Adaptive rescue batch sizing.
// Reads gasPerItem from keeper_state.json (updated after each successful rescue).
// Calculates maxItems = clamp(floor(GAS_SAFE / gasPerItem), MIN, MAX).
// When V8 gas costs drop (e.g. post-optimisation), the batch auto-grows.
function adaptiveRescueBatch(performData, ethers, state) {
  try {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const WI_TYPE = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
    const [rawItems] = coder.decode([WI_TYPE], performData);

    const rescueItems = [];
    const otherItems  = [];
    for (const item of rawItems) {
      if (Number(item.workType) === WORK_PARKED_RESCUE) rescueItems.push(item);
      else otherItems.push(item);
    }

    // Calculate adaptive cap from stored gas-per-item estimate
    const gasPerItem = state.gasPerItem || GAS_PER_ITEM_DEFAULT;
    const emaCap     = Math.max(MIN_RESCUE_BATCH, Math.min(MAX_RESCUE_BATCH, Math.floor(GAS_SAFE / gasPerItem)));
    const adaptive   = state.currentCap != null ? state.currentCap : emaCap;

    if (rescueItems.length <= adaptive) return { performData, capped: false, adaptive, gasPerItem };

    const limited = [...otherItems, ...rescueItems.slice(0, adaptive)];
    const encoded = coder.encode(
      [WI_TYPE],
      [limited.map(i => [Number(i.workType), Number(i.tierIndex), i.addr1, i.addr2])]
    );
    return { performData: encoded, capped: true, total: rescueItems.length, kept: adaptive, adaptive, gasPerItem };
  } catch (err) {
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
        : "never_active";
      const msg = `💓 Keeper alive — quiet_runs=${state.noWorkCount}  total=${state.totalRuns}  ${lastActive}`;
      log(msg);
      await sendTelegram(msg);
    }
    saveState(state);
    return;
  }

  // work needed -- adaptive batch sizing before sending
  const cap = adaptiveRescueBatch(performData, hre.ethers, state);
  if (cap.decodeError) {
    log(`  WARN performData decode failed (using original): ${cap.decodeError.slice(0, 100)}`);
  } else if (cap.capped) {
    log(`  INFO Adaptive batch: ${cap.total} items -> ${cap.kept} (gasPerItem=${(cap.gasPerItem/1e6).toFixed(2)}M → cap=${cap.adaptive})`);
  } else {
    log(`  INFO Batch size: ${cap.adaptive} max (gasPerItem=${((cap.gasPerItem||GAS_PER_ITEM_DEFAULT)/1e6).toFixed(2)}M)`);
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
        // Update adaptive gas-per-item estimate (EMA, alpha=0.3)
        const actualGasPerItem = Number(receipt.gasUsed) / rescueCount;
        const prevEst = state.gasPerItem || GAS_PER_ITEM_DEFAULT;
        state.gasPerItem = Math.round(0.3 * actualGasPerItem + 0.7 * prevEst);
        const newCap = Math.max(MIN_RESCUE_BATCH, Math.min(MAX_RESCUE_BATCH, Math.floor(GAS_SAFE / state.gasPerItem)));
        const prevCap = state.currentCap != null ? state.currentCap : newCap;
        state.currentCap = newCap;
        const capChange = newCap !== prevCap ? ` (cap ${prevCap}->${newCap})` : "";
        log(`  Gas/item: actual=${(actualGasPerItem/1e6).toFixed(2)}M  ema=${(state.gasPerItem/1e6).toFixed(2)}M  next_cap=${newCap}${capChange}`);

        const msg = `Keeper rescued ${rescueCount} member${rescueCount > 1 ? "s" : ""}\nBlock ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}${costStr}\nNext batch cap: ${newCap}`;
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

      // Active-work heartbeat: force-crosses / distributions produce no ParkedRescued events.
      // Without this, the keeper goes completely silent on Telegram for hours during busy periods.
      if (rescueCount === 0 && failedItems.length === 0) {
        state.activeWorkCount = (state.activeWorkCount || 0) + 1;
        if (state.activeWorkCount % HEARTBEAT_EVERY === 0) {
          const awMsg = `⚡ Keeper active — non-rescue work (force-cross / distribution)\nactive_cycles=${state.activeWorkCount}  total=${state.totalRuns}\nBlock ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}${costStr}`;
          log(awMsg);
          await sendTelegram(awMsg);
        }
      }
    } else {
      // TX confirmed but reverted (status=0)
      const isOOG = BigInt(receipt.gasUsed.toString()) >= BigInt(GAS_LIMIT) * 95n / 100n;
      if (isOOG) {
        const prevCap = state.currentCap != null ? state.currentCap : MAX_RESCUE_BATCH;
        state.currentCap = Math.max(MIN_RESCUE_BATCH, Math.floor(prevCap / 2));
        const reason = `Out of gas (used ${receipt.gasUsed.toLocaleString()} / ${GAS_LIMIT.toLocaleString()}) — cap: ${prevCap} -> ${state.currentCap}`;
        log(`  OOG on-chain -- ${reason}`);
        await sendTelegram(`⚠️ <b>Keeper OOG</b>\n${reason}\nTX: ${tx.hash}\nBlock: ${receipt.blockNumber}`);
      } else {
        const reason = "Transaction reverted (status=0, no revert reason available)";
        log(`  performUpkeep FAILED -- ${reason}`);
        await sendTelegram(`FAIL <b>Keeper performUpkeep failed</b>\n${reason}\nTX: ${tx.hash}\nBlock: ${receipt.blockNumber}`);
      }
      saveState(state);
      process.exit(1);
    }
  } catch (e) {
    // TX rejected before confirmation (RPC error, nonce issue, etc.)
    // Detect OOG: ethers v6 surfaces this as reason=null, data=null/0x
    const looksLikeOOG = !e.reason && (!e.data || e.data === null || e.data === "0x" || e.data === "");
    const msg = e.message?.slice(0, 200) || "unknown error";
    if (looksLikeOOG) {
      const prevCap = state.currentCap != null ? state.currentCap : MAX_RESCUE_BATCH;
      state.currentCap = Math.max(MIN_RESCUE_BATCH, Math.floor(prevCap / 2));
      log(`  OOG pre-flight -- cap halved: ${prevCap} -> ${state.currentCap}  (${msg})`);
      await sendTelegram(`⚠️ <b>Keeper OOG pre-flight</b>\nCap: ${prevCap} → ${state.currentCap}\n${msg}`);
    } else {
      log(`ERROR performUpkeep: ${msg}`);
      await sendTelegram(`FAIL <b>Keeper performUpkeep error</b>\n${msg}`);
    }
    saveState(state);
    process.exit(1);
  }

  saveState(state);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
