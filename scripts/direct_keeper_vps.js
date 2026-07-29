// direct_keeper.js  (standalone ethers.js — no Hardhat)
// Polls checkUpkeep -> calls performUpkeep on MatrixKeeper.
// Run: node direct_keeper.js
// Cron: */2 * * * * cd /root/keeper && node direct_keeper.js >> /root/keeper/keeper.log 2>&1

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── Config ──────────────────────────────────────────────────────────────────
const RPC_URL       = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY   = process.env.KEEPER_PRIVATE_KEY;
const ADDRESSES_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_33.json";

if (!PRIVATE_KEY) { console.error("KEEPER_PRIVATE_KEY not set in .env"); process.exit(1); }

const ADDRS       = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRESSES_FILE), "utf8"));
const MATRIX_KEEPER = ADDRS.matrixKeeper;

const GAS_LIMIT            = 15_000_000;
const GAS_SAFE             = 14_000_000;
const WORK_PARKED_RESCUE   = 4;
const MIN_RESCUE_BATCH     = 1;
const MAX_RESCUE_BATCH     = 25;
const GAS_PER_ITEM_DEFAULT = 3_500_000;
const HEARTBEAT_EVERY      = 5;

const LOG_FILE   = path.join(__dirname, "keeper.log");
const STATE_FILE = path.join(__dirname, "keeper_state.json");

const ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
  "event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex)",
  "event WorkItemFailed(uint8 workType, uint8 tierIndex, address addr1, address addr2)",
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { noWorkCount: 0, totalRuns: 0, lastActive: null, activeWorkCount: 0 }; }
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

function adaptiveRescueBatch(performData, state) {
  try {
    const coder  = ethers.AbiCoder.defaultAbiCoder();
    const WI_TYPE = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
    const [rawItems] = coder.decode([WI_TYPE], performData);

    const rescueItems = [];
    const otherItems  = [];
    for (const item of rawItems) {
      if (Number(item.workType) === WORK_PARKED_RESCUE) rescueItems.push(item);
      else otherItems.push(item);
    }

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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  const keeper   = new ethers.Contract(MATRIX_KEEPER, ABI, signer);

  const state       = loadState();
  state.totalRuns   = (state.totalRuns  || 0) + 1;
  state.noWorkCount = state.noWorkCount || 0;

  let upkeepNeeded, performData;
  try {
    [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");
  } catch (e) {
    log(`ERROR checkUpkeep: ${e.message}`);
    saveState(state);
    process.exit(1);
  }

  if (!upkeepNeeded) {
    state.noWorkCount += 1;
    if (state.noWorkCount % HEARTBEAT_EVERY === 0) {
      const lastActive = state.lastActive ? `last_active=${state.lastActive}` : "never_active";
      const msg = `💓 Keeper alive — quiet_runs=${state.noWorkCount}  total=${state.totalRuns}  ${lastActive}`;
      log(msg);
      await sendTelegram(msg);
    }
    saveState(state);
    return;
  }

  const cap = adaptiveRescueBatch(performData, state);
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
      const gasEth = ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
      costStr = `  cost=${parseFloat(gasEth).toFixed(6)} ETH`;
    } catch {}

    log(`  Confirmed -- block=${receipt.blockNumber}  status=${ok ? "OK" : "FAILED"}  gasUsed=${receipt.gasUsed.toLocaleString()}${costStr}`);

    if (ok) {
      let rescueCount = 0;
      const failedItems = [];

      for (const log_ of receipt.logs) {
        try {
          const parsed = keeper.interface.parseLog({ topics: [...log_.topics], data: log_.data });
          if (parsed?.name === "ParkedRescued") rescueCount++;
          if (parsed?.name === "WorkItemFailed")
            failedItems.push(`workType=${parsed.args.workType} tier=${parsed.args.tierIndex}`);
        } catch {}
      }

      if (rescueCount > 0) {
        const actualGasPerItem = Number(receipt.gasUsed) / rescueCount;
        const prevEst = state.gasPerItem || GAS_PER_ITEM_DEFAULT;
        state.gasPerItem = Math.round(0.3 * actualGasPerItem + 0.7 * prevEst);
        const newCap  = Math.max(MIN_RESCUE_BATCH, Math.min(MAX_RESCUE_BATCH, Math.floor(GAS_SAFE / state.gasPerItem)));
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

      if (rescueCount === 0 && failedItems.length === 0) {
        state.activeWorkCount = (state.activeWorkCount || 0) + 1;
        if (state.activeWorkCount % HEARTBEAT_EVERY === 0) {
          const awMsg = `⚡ Keeper active — non-rescue work (force-cross / distribution)\nactive_cycles=${state.activeWorkCount}  total=${state.totalRuns}\nBlock ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}${costStr}`;
          log(awMsg);
          await sendTelegram(awMsg);
        }
      }
    } else {
      const isOOG = BigInt(receipt.gasUsed.toString()) >= BigInt(GAS_LIMIT) * 95n / 100n;
      if (isOOG) {
        const prevCap = state.currentCap != null ? state.currentCap : MAX_RESCUE_BATCH;
        state.currentCap = Math.max(MIN_RESCUE_BATCH, Math.floor(prevCap / 2));
        const reason = `Out of gas (used ${receipt.gasUsed.toLocaleString()} / ${GAS_LIMIT.toLocaleString()}) — cap: ${prevCap} -> ${state.currentCap}`;
        log(`  OOG on-chain -- ${reason}`);
        await sendTelegram(`⚠️ <b>Keeper OOG</b>\n${reason}\nTX: ${tx.hash}\nBlock: ${receipt.blockNumber}`);
      } else {
        const reason = "Transaction reverted (status=0)";
        log(`  performUpkeep FAILED -- ${reason}`);
        await sendTelegram(`FAIL <b>Keeper performUpkeep failed</b>\n${reason}\nTX: ${tx.hash}\nBlock: ${receipt.blockNumber}`);
      }
      saveState(state);
      process.exit(1);
    }
  } catch (e) {
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

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
