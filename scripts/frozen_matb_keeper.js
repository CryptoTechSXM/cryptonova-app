// frozen_matb_keeper.js
// Detects MatBs that are full (occupancy == MATRIX_SIZE) but frozen — no natural
// 128th entrant is coming because new crossings go to newer pairs.
// Calls adminForceRotateRoot() (onlyOwner) to force one cycle-out per frozen MatB.
//
// Why this matters:
//   _cycleOutRoot only fires when a 128th member tries to enter a full 127-seat MatB.
//   After T1.2 is created, new crossings go to T1.2 MatB, not T1.1 MatB.
//   T1.1 MatB sits full at 127/127 forever — nobody rotates, nobody gets paid.
//   This keeper detects that and forces the rotation, unblocking the payout queue.
//   Same applies to T2, T3 ... T10 whenever a new pair is spawned.
//
// Run (standalone — no hardhat needed):
//   node scripts/frozen_matb_keeper.js
// Requires in .env: BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ADDRESSES_FILE
// Cron: add to VPS alongside direct_keeper — every 5 minutes is plenty.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL            = process.env.BASE_SEPOLIA_RPC_URL;
const DEPLOYER_KEY       = process.env.DEPLOYER_PRIVATE_KEY;
const ADDRESSES_FILE     = process.env.ADDRESSES_FILE || "deployed_addresses_v8_39.json";
const MATRIX_SIZE        = 127;
// How long (ms) to wait before force-rotating the same MatB again.
// 10 min is comfortable — the matrix needs new crossings to refill before another rotation.
const ROTATION_COOLDOWN_MS = 10 * 60 * 1000;
const GAS_LIMIT_ROTATE   = 8_000_000;  // adminForceRotateRoot shifts 127 slots + pool distrib
const LOG_FILE            = path.join(__dirname, "..", "frozen_matb.log");
const STATE_FILE          = path.join(__dirname, "..", "frozen_matb_state.json");
const TIER_KEYS           = ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10"];
const HEARTBEAT_EVERY     = 12; // log alive message every N runs (~1 hr at 5-min interval)

// ── ABIs ──────────────────────────────────────────────────────────────────────
const PM_ABI = [
  "function pairCount() external view returns (uint256)",
  "function getPairAt(uint256 idx) external view returns (address matA, address matB)",
];

const MATB_ABI = [
  "function occupancy() external view returns (uint256)",
  "function nextSlot() external view returns (uint256)",
  // adminForceRotateRoot() is onlyOwner — T1.1 MatB owner = DEPLOYER_PRIVATE_KEY (0xCd0Af6).
  // Factory-created MatBs (T1.2+) are owned by MatrixPairFactory.pairAdmin which must also
  // match DEPLOYER_PRIVATE_KEY, or ownership must be transferred at deploy time.
  "function adminForceRotateRoot() external",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { lastRotated: {}, totalRuns: 0, totalRotations: 0 }; }
}

function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!RPC_URL)      { log("FATAL: BASE_SEPOLIA_RPC_URL not set in .env"); process.exit(1); }
  if (!DEPLOYER_KEY) { log("FATAL: DEPLOYER_PRIVATE_KEY not set in .env"); process.exit(1); }

  // adminForceRotateRoot is onlyOwner — must use DEPLOYER_PRIVATE_KEY (signers[0])
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

  const addrsPath = path.join(__dirname, ADDRESSES_FILE);
  if (!fs.existsSync(addrsPath)) {
    log(`ERROR: addresses file not found: ${addrsPath}`);
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(addrsPath, "utf8"));

  const state = loadState();
  state.totalRuns     = (state.totalRuns    || 0) + 1;
  state.totalRotations = (state.totalRotations || 0);
  state.lastRotated   = state.lastRotated || {};

  const now = Date.now();
  let rotatedThisRun = 0;
  let checkedMatBs   = 0;

  for (const tierKey of TIER_KEYS) {
    const tierData = addrs.tiers?.[tierKey];
    if (!tierData?.pm) continue;

    const pm = new ethers.Contract(tierData.pm, PM_ABI, deployer);
    let pairCount = 0;
    try { pairCount = Number(await pm.pairCount()); }
    catch (e) {
      log(`WARN pairCount failed for ${tierKey}: ${(e.message||"").slice(0,80)}`);
      continue;
    }

    for (let i = 0; i < pairCount; i++) {
      let matBAddr;
      try {
        const [, matB] = await pm.getPairAt(i);
        matBAddr = matB;
      } catch { continue; }

      if (!matBAddr || matBAddr === ethers.ZeroAddress) continue;
      checkedMatBs++;

      const key = matBAddr.toLowerCase();

      // Cooldown: don't hammer the same MatB repeatedly
      const lastRot = state.lastRotated[key] || 0;
      if (now - lastRot < ROTATION_COOLDOWN_MS) continue;

      const matB = new ethers.Contract(matBAddr, MATB_ABI, deployer);
      let occ, nextSlot;
      try {
        [occ, nextSlot] = await Promise.all([
          matB.occupancy().then(Number),
          matB.nextSlot().then(Number),
        ]);
      } catch { continue; }

      // Frozen condition: MatB is exactly full AND nextSlot is past the end
      // (i.e., the next natural entrant would trigger _cycleOutRoot, but nobody is coming)
      if (occ < MATRIX_SIZE || nextSlot <= MATRIX_SIZE) continue;

      log(`⚠️  Frozen MatB: ${tierKey}.${i+1} (${matBAddr.slice(0,10)}…) occ=${occ}/${MATRIX_SIZE} nextSlot=${nextSlot} → forcing rotation`);

      try {
        const tx = await matB.adminForceRotateRoot({ gasLimit: GAS_LIMIT_ROTATE });
        log(`  TX: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
          const cost = (() => {
            try { return parseFloat(ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice)).toFixed(6) + " ETH"; }
            catch { return "?"; }
          })();
          log(`  ✅ Rotated ${tierKey}.${i+1} — block ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}  cost ${cost}`);
          state.lastRotated[key] = Date.now();
          state.totalRotations++;
          rotatedThisRun++;
          await sendTelegram(
            `✅ <b>Frozen MatB unblocked</b>\n` +
            `Tier ${tierKey} pair ${i+1} (${matBAddr.slice(0,10)}…)\n` +
            `Block ${receipt.blockNumber} · gas ${receipt.gasUsed.toLocaleString()} · cost ${cost}`
          );
        } else {
          log(`  ❌ adminForceRotateRoot reverted — ${tierKey}.${i+1}`);
          await sendTelegram(`❌ <b>Frozen MatB rotate FAILED</b>\nTier ${tierKey} pair ${i+1} (${matBAddr.slice(0,10)}…)\nTX: ${tx.hash}`);
        }
      } catch (e) {
        const msg = (e.message || "").slice(0, 200);
        log(`  ERROR adminForceRotateRoot ${tierKey}.${i+1}: ${msg}`);
        // Don't alert on every failure — only if it looks unexpected
        if (!msg.includes("no members") && !msg.includes("only callable on MatB")) {
          await sendTelegram(`⚠️ <b>Frozen MatB keeper error</b>\n${tierKey}.${i+1}: ${msg.slice(0,100)}`);
        }
      }
    }
  }

  // Heartbeat log
  if (rotatedThisRun > 0 || state.totalRuns % HEARTBEAT_EVERY === 0) {
    const summary = rotatedThisRun > 0
      ? `Rotated ${rotatedThisRun} frozen MatB(s) this run`
      : `💓 Frozen MatB keeper alive`;
    log(`${summary} — runs=${state.totalRuns}  total_rotations=${state.totalRotations}  matBs_checked=${checkedMatBs}`);
  }

  saveState(state);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
