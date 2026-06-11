"use strict";
/**
 * system_keeper.js — Autonomous Health Monitor & Auto-Funder for V8.8
 *
 * Runs every hour (via Claude Scheduled Task or Windows Task Scheduler).
 * Checks, alerts, and acts — then exits cleanly.
 *
 * MONITORS:
 *   ✓ StabilityFund USDC balance (total + per tier)
 *   ✓ SF health score (healthBps = balance / sfTarget)
 *   ✓ T1/T2 MatA+MatB occupancy and parked queue counts
 *   ✓ W1 withdrawable across T1 MatA, T1 MatB, T2 MatA (system treasury)
 *   ✓ Total system cycles + W1 highest tier
 *   ✓ Chainlink MatrixKeeper (placeholder — requires upkeep registration on mainnet)
 *
 * ACTIONS (controlled by env flags, all OFF by default):
 *   AUTO_RESCUE=true   → calls performUpkeep() for parked rescues when queue > RESCUE_THRESHOLD
 *   SF_AUTOFUND=true   → tops up SF when balance < SF_MIN_USD, funded by deployer USDC
 *                        (deployer calls receiveLayer as owner — no contract changes needed)
 *   W1_WITHDRAW=true   → withdraws W1 earnings from T1 MatA to W1 wallet before SF top-up
 *                        (requires W1_PRIVATE_KEY in .env)
 *
 * ALERTS (via Telegram if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set in .env):
 *   🔴 CRITICAL  SF < SF_CRITICAL_USD  OR  parked > PARKED_CRITICAL
 *   🟡 WARNING   SF < SF_MIN_USD       OR  parked > PARKED_WARN
 *   🟢 OK        Everything healthy
 *
 * USAGE:
 *   node scripts/system_keeper.js          (from CryptoNite-Smart-Contracts\CryptoNova)
 *
 * ENV VARS (all optional — sensible defaults for testnet):
 *   BASE_SEPOLIA_RPC_URL     RPC endpoint  (default: https://sepolia.base.org)
 *   DEPLOYER_PRIVATE_KEY     Required for AUTO_RESCUE and SF_AUTOFUND
 *   W1_PRIVATE_KEY           Required for W1_WITHDRAW (separate from deployer on mainnet)
 *   ADDRESSES_FILE           Path to deployed addresses JSON  (default: deployed_addresses_v8_8.json)
 *   SF_MIN_USD               SF warning threshold in USD      (default: 100)
 *   SF_CRITICAL_USD          SF critical threshold in USD     (default: 30)
 *   PARKED_WARN              Parked queue warning threshold   (default: 50)
 *   PARKED_CRITICAL          Parked queue critical threshold  (default: 200)
 *   RESCUE_THRESHOLD         Auto-rescue fires above this     (default: 20)
 *   RESCUE_BATCH             Rescues per auto-rescue run      (default: 10)
 *   SF_TOPUP_AMOUNT_USD      USDC to inject per SF top-up     (default: 500)
 *   AUTO_RESCUE              Enable auto parked rescue        (default: false)
 *   SF_AUTOFUND              Enable SF auto top-up            (default: false)
 *   W1_WITHDRAW              Enable W1 earnings withdrawal    (default: false)
 *   TELEGRAM_BOT_TOKEN       Telegram bot token for alerts
 *   TELEGRAM_CHAT_ID         Telegram chat ID for alerts
 *   KEEPER_LOG               Log file path (default: logs/keeper.log)
 *   DRY_RUN                  Log what would happen, no TXs    (default: false)
 */

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL        = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const DEPLOYER_KEY   = process.env.DEPLOYER_PRIVATE_KEY;
const W1_KEY         = process.env.W1_PRIVATE_KEY;          // optional — W1 separate key
const ADDR_FILE      = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_9.json');
const LOG_FILE       = process.env.KEEPER_LOG
  ? path.resolve(process.env.KEEPER_LOG)
  : path.join(__dirname, '../logs/keeper.log');

// Thresholds
const SF_MIN_USD         = Number(process.env.SF_MIN_USD        || 100);
const SF_CRITICAL_USD    = Number(process.env.SF_CRITICAL_USD   || 30);
const PARKED_WARN        = Number(process.env.PARKED_WARN       || 50);
const PARKED_CRITICAL    = Number(process.env.PARKED_CRITICAL   || 200);
const RESCUE_THRESHOLD   = Number(process.env.RESCUE_THRESHOLD  || 20);
const RESCUE_BATCH       = Number(process.env.RESCUE_BATCH      || 10);
const SF_TOPUP_AMOUNT_USD= Number(process.env.SF_TOPUP_AMOUNT_USD || 500);

// Action flags
const AUTO_RESCUE  = process.env.AUTO_RESCUE  === 'true';
const SF_AUTOFUND  = process.env.SF_AUTOFUND  === 'true';
const W1_WITHDRAW  = process.env.W1_WITHDRAW  === 'true';
const DRY_RUN      = process.env.DRY_RUN      === 'true';

// Telegram
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID;
const TG_ENABLED = !!(TG_TOKEN && TG_CHAT);

// Work type constants (MatrixKeeper)
const WORK_PARKED_RESCUE = 4;

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt6  = n  => '$' + (Number(n) / 1e6).toFixed(2);
const fmt6n = n  => (Number(n) / 1e6).toFixed(2);
const ts    = () => new Date().toISOString();

// Log to console + file
const logLines = [];
function log(line = '') {
  console.log(line);
  logLines.push(line);
}

function flushLog() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');
  } catch (_) { /* log write failure is non-fatal */ }
}

async function safeCall(fn, defaultVal) {
  try { return await fn(); }
  catch { return defaultVal; }
}

// ── Telegram alert ────────────────────────────────────────────────────────────
// Returns true on HTTP 200, false on any error. Never throws.
function sendTelegram(message) {
  return new Promise((resolve) => {
    if (!TG_ENABLED) return resolve(false);
    const body = JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${TG_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        const ok = res.statusCode === 200;
        if (!ok) {
          console.error(`  📱 Telegram HTTP ${res.statusCode}: ${raw.slice(0, 120)}`);
        }
        resolve(ok);
      });
    });
    req.on('error', e => {
      console.error(`  📱 Telegram network error: ${e.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const SF_ABI = [
  'function balanceByTier(uint8) external view returns (uint256)',
  'function totalBalance() external view returns (uint256)',
  'function sfTarget() external view returns (uint256)',
  'function healthBps() external view returns (uint256)',
  'function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external',
];
const TR_ABI = [
  'function totalSystemCycles() external view returns (uint256)',
  'function memberHighestTier(address) external view returns (uint8)',
];
const MAT_ABI = [
  'function occupancy() external view returns (uint256)',
  'function MATRIX_SIZE() external view returns (uint256)',
  'function getParkedCount() external view returns (uint256)',
  'function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
  'function getParkedMember(uint256 idx) external view returns (address)',
  'function isParked(address) external view returns (bool)',
  'function withdraw() external',
  'function ENTRY_FEE() external view returns (uint256)',
];
const MAT_B_ABI = [
  'function occupancy() external view returns (uint256)',
  'function MATRIX_SIZE() external view returns (uint256)',
  'function isActiveInMatrix(address) external view returns (bool)',
  'function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
];
const KEEPER_ABI = [
  'function performUpkeep(bytes calldata performData) external',
  'function stabilityFund() external view returns (address)',
];
const USDC_ABI = [
  'function balanceOf(address) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function mint(address to, uint256 amount) external',   // testnet MockUSDC only
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('');
  log('╔═══════════════════════════════════════════════════════════════╗');
  log('║        CryptoNova V8.8 — System Keeper                       ║');
  log('╚═══════════════════════════════════════════════════════════════╝');
  log(`  Run at:    ${ts()}`);
  log(`  Log file:  ${LOG_FILE}`);
  log(`  Dry run:   ${DRY_RUN}`);
  log(`  Actions:   AUTO_RESCUE=${AUTO_RESCUE}  SF_AUTOFUND=${SF_AUTOFUND}  W1_WITHDRAW=${W1_WITHDRAW}`);
  log('');

  if (!fs.existsSync(ADDR_FILE)) {
    log(`  ERROR: Addresses file not found: ${ADDR_FILE}`);
    flushLog();
    process.exit(1);
  }

  const addrs  = JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));
  const T1     = addrs.tiers?.T1 || addrs.T1;
  const T2     = addrs.tiers?.T2 || addrs.T2;
  const W1     = addrs.accountOne || addrs.W1;

  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const sf       = new ethers.Contract(addrs.stabilityFund, SF_ABI,    provider);
  const tr       = new ethers.Contract(addrs.tierRouter,    TR_ABI,    provider);
  const usdc     = new ethers.Contract(addrs.usdc,          USDC_ABI,  provider);
  const matA1    = new ethers.Contract(T1.matA,             MAT_ABI,   provider);
  const matB1    = new ethers.Contract(T1.matB,             MAT_B_ABI, provider);
  const matA2    = T2 ? new ethers.Contract(T2.matA, MAT_ABI,   provider) : null;
  const matB2    = T2 ? new ethers.Contract(T2.matB, MAT_B_ABI, provider) : null;
  const keeper   = new ethers.Contract(addrs.matrixKeeper, KEEPER_ABI, provider);

  // ── RPC preflight — must pass before reading ANY contract state ─────────
  // safeCall() swallows ALL errors, including EAI_AGAIN (DNS failure) and
  // ECONNREFUSED. Without this check, a network outage returns all-zero values
  // which looks identical to a fully drained/empty system → false CRITICAL.
  log('  ── RPC Preflight ─────────────────────────────────────────────────');
  try {
    const blockNum = await provider.getBlockNumber();
    log(`  ✅ Base Sepolia reachable — block ${blockNum}`);
  } catch (e) {
    const reason = e.code || e.message || String(e);
    log(`  ❌ RPC UNREACHABLE: ${reason}`);
    log(`  STATUS: RPC_DOWN`);
    log(`  All contract reads skipped — zero values would be false reads.`);
    log(`  Re-run once network access is restored.`);
    if (TG_ENABLED) {
      const tgOk = await sendTelegram(
        `🔌 <b>CryptoNova Keeper: RPC DOWN</b>\n\n` +
        `Could not reach Base Sepolia RPC.\n` +
        `Error: <code>${reason.slice(0, 100)}</code>\n\n` +
        `No readings taken. No actions taken.\n<i>${ts()}</i>`
      );
      log(tgOk ? '  📱 RPC_DOWN alert sent to Telegram.' : '  📱 Telegram send failed.');
    }
    flushLog();
    process.exit(0);  // Exit 0 — network issue, not a code bug
  }
  log('');

  // ── Section 1: StabilityFund ──────────────────────────────────────────────
  log('  ── StabilityFund ─────────────────────────────────────────────────');
  const [sfTotal, sfTarget, sfHealth, sfT1, sfT2] = await Promise.all([
    safeCall(() => sf.totalBalance(), 0n),
    safeCall(() => sf.sfTarget(), 0n),
    safeCall(() => sf.healthBps(), 0n),
    safeCall(() => sf.balanceByTier(0), 0n),
    safeCall(() => sf.balanceByTier(1), 0n),
  ]);
  const sfTotalUSD  = Number(sfTotal) / 1e6;
  const sfTargetUSD = Number(sfTarget) / 1e6;
  const sfHealthPct = Number(sfHealth) / 100;
  const sfHealthBar = '█'.repeat(Math.round(sfHealthPct / 5)) + '░'.repeat(20 - Math.round(sfHealthPct / 5));

  log(`  Total balance : ${fmt6(sfTotal)} of ${fmt6(sfTarget)} target`);
  log(`  Health        : ${sfHealthPct.toFixed(1)}%  [${sfHealthBar}]`);
  log(`  T1 balance    : ${fmt6(sfT1)}`);
  log(`  T2 balance    : ${fmt6(sfT2)}`);

  const sfStatus = sfTotalUSD < SF_CRITICAL_USD ? '🔴 CRITICAL'
                 : sfTotalUSD < SF_MIN_USD       ? '🟡 WARNING'
                 : '🟢 OK';
  log(`  Status        : ${sfStatus}  (warn<$${SF_MIN_USD}  critical<$${SF_CRITICAL_USD})`);
  log('');

  // ── Section 2: Matrix State ───────────────────────────────────────────────
  log('  ── Matrix State ──────────────────────────────────────────────────');
  const [
    t1aOcc, t1aSize, t1aParked,
    t1bOcc, t1bSize,
  ] = await Promise.all([
    safeCall(() => matA1.occupancy(), 0n),
    safeCall(() => matA1.MATRIX_SIZE(), 127n),
    safeCall(() => matA1.getParkedCount(), 0n),
    safeCall(() => matB1.occupancy(), 0n),
    safeCall(() => matB1.MATRIX_SIZE(), 127n),
  ]);

  let t2aOcc = 0n, t2aParked = 0n, t2bOcc = 0n, t2aSize = 127n;
  if (matA2) {
    [t2aOcc, t2aParked, t2bOcc, t2aSize] = await Promise.all([
      safeCall(() => matA2.occupancy(), 0n),
      safeCall(() => matA2.getParkedCount(), 0n),
      safeCall(() => matB2.occupancy(), 0n),
      safeCall(() => matA2.MATRIX_SIZE(), 127n),
    ]);
  }

  const totalParked = Number(t1aParked) + Number(t2aParked);
  log(`  T1 MatA : ${t1aOcc}/${t1aSize}  parked=${t1aParked}`);
  log(`  T1 MatB : ${t1bOcc}/${t1bSize}`);
  log(`  T2 MatA : ${t2aOcc}/${t2aSize}  parked=${t2aParked}`);
  log(`  T2 MatB : ${t2bOcc}/127`);

  const parkedStatus = totalParked > PARKED_CRITICAL ? '🔴 CRITICAL'
                     : totalParked > PARKED_WARN      ? '🟡 WARNING'
                     : '🟢 OK';
  log(`  Parked  : ${totalParked} total  ${parkedStatus}`);
  log('');

  // ── Section 3: W1 Earnings ────────────────────────────────────────────────
  log('  ── W1 Earnings (System Treasury) ────────────────────────────────');
  const [w1T1A, w1T1B, w1T2A, w1T2B] = await Promise.all([
    safeCall(() => matA1.getMember(W1), null),
    safeCall(() => matB1.getMember(W1), null),
    matA2 ? safeCall(() => matA2.getMember(W1), null) : Promise.resolve(null),
    matB2 ? safeCall(() => matB2.getMember(W1), null) : Promise.resolve(null),
  ]);

  const w1T1AW = w1T1A?.withdrawable ?? 0n;
  const w1T1BW = w1T1B?.withdrawable ?? 0n;
  const w1T2AW = w1T2A?.withdrawable ?? 0n;
  const w1T2BW = w1T2B?.withdrawable ?? 0n;
  const w1Total = w1T1AW + w1T1BW + w1T2AW + w1T2BW;

  log(`  T1 MatA : ${fmt6(w1T1AW)}`);
  log(`  T1 MatB : ${fmt6(w1T1BW)}`);
  log(`  T2 MatA : ${fmt6(w1T2AW)}`);
  log(`  T2 MatB : ${fmt6(w1T2BW)}`);
  log(`  Total   : ${fmt6(w1Total)}  (available to top up SF)`);
  log('');

  // ── Section 4: System Health ──────────────────────────────────────────────
  log('  ── System Health ─────────────────────────────────────────────────');
  const [sysCycles, w1Tier, deployerUsdc, w1WalletUsdc] = await Promise.all([
    safeCall(() => tr.totalSystemCycles(), 0n),
    safeCall(() => tr.memberHighestTier(W1), 0n),
    safeCall(() => usdc.balanceOf(DEPLOYER_KEY
      ? new ethers.Wallet(DEPLOYER_KEY).address : ethers.ZeroAddress), 0n),
    safeCall(() => usdc.balanceOf(W1), 0n),
  ]);
  const deployerAddr = DEPLOYER_KEY ? new ethers.Wallet(DEPLOYER_KEY).address : '(no key)';

  log(`  System cycles : ${sysCycles}`);
  log(`  W1 tier       : T${w1Tier}`);
  log(`  W1 wallet USD : ${fmt6(w1WalletUsdc)}`);
  log(`  Deployer USDC : ${fmt6(deployerUsdc)}  (${deployerAddr.slice(0,10)}…)`);
  log('');

  // ── Section 5: Decisions ──────────────────────────────────────────────────
  log('  ── Decisions ─────────────────────────────────────────────────────');

  const needsRescue  = AUTO_RESCUE  && totalParked > RESCUE_THRESHOLD;
  const needsFund    = SF_AUTOFUND  && sfTotalUSD < SF_MIN_USD;
  const needsW1Draw  = W1_WITHDRAW  && Number(w1T2AW) > 0;

  const actions = [];
  if (needsRescue) actions.push(`AUTO_RESCUE: ${Math.min(RESCUE_BATCH, totalParked)} parked wallets`);
  if (needsFund)   actions.push(`SF_AUTOFUND: inject $${SF_TOPUP_AMOUNT_USD} into StabilityFund`);
  if (needsW1Draw) actions.push(`W1_WITHDRAW: move ${fmt6(w1T2AW)} from T2 MatA to W1 wallet`);

  if (actions.length === 0) {
    log('  ✅ No actions required this cycle.');
  } else {
    for (const a of actions) log(`  ⚙️  ${a}`);
  }
  log('');

  // ── Action: W1 withdraw ───────────────────────────────────────────────────
  if (needsW1Draw && !DRY_RUN) {
    const w1Key = W1_KEY || DEPLOYER_KEY;
    if (!w1Key) {
      log('  ⚠️  W1_WITHDRAW=true but no W1_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY set — skipping');
    } else {
      log('  ⚙️  Withdrawing W1 T2 MatA earnings…');
      try {
        const signer  = new ethers.Wallet(w1Key, provider);
        const mat2Sig = matA2.connect(signer);
        const tx      = await mat2Sig.withdraw({ gasLimit: 200_000 });
        const receipt = await tx.wait();
        log(`  ✅ W1 withdrew ${fmt6(w1T2AW)} from T2 MatA  tx=${tx.hash.slice(0, 12)}…  gas=${receipt.gasUsed}`);
      } catch (e) {
        log(`  ❌ W1 withdraw failed: ${(e.reason || e.shortMessage || e.message || '').slice(0, 100)}`);
      }
    }
  }

  // ── Action: SF auto-fund ─────────────────────────────────────────────────
  // Flow: deployer (owner) approves SF → calls receiveLayer(0, amount, 1)
  // SF's receiveLayer pulls USDC from msg.sender (deployer) and increments totalBalance.
  // On testnet the deployer can mint MockUSDC. On mainnet deployer needs real USDC balance.
  if (needsFund && !DRY_RUN) {
    if (!DEPLOYER_KEY) {
      log('  ⚠️  SF_AUTOFUND=true but DEPLOYER_PRIVATE_KEY not set — skipping');
    } else {
      const topUpAmount = BigInt(SF_TOPUP_AMOUNT_USD) * 1_000_000n;
      log(`  ⚙️  Topping up SF with $${SF_TOPUP_AMOUNT_USD}…`);

      try {
        const signer    = new ethers.Wallet(DEPLOYER_KEY, provider);
        const usdcSig   = usdc.connect(signer);
        const sfSig     = sf.connect(signer);
        const depBal    = await usdc.balanceOf(signer.address);

        // On testnet: mint USDC to deployer if needed (MockUSDC)
        if (depBal < topUpAmount) {
          log(`  ⚙️  Deployer USDC short — minting $${SF_TOPUP_AMOUNT_USD} (testnet only)…`);
          const mintTx = await usdcSig.mint(signer.address, topUpAmount, { gasLimit: 100_000 });
          await mintTx.wait();
          log('  ✅ Minted USDC to deployer');
        }

        // Approve SF to pull
        const appTx = await usdcSig.approve(addrs.stabilityFund, topUpAmount, { gasLimit: 80_000 });
        await appTx.wait();
        log('  ✅ Approved SF to pull USDC');

        // receiveLayer(tier=0, amount, layer=1) — deployer is owner, so authorized
        const rx = await sfSig.receiveLayer(0, topUpAmount, 1, { gasLimit: 150_000 });
        const rcpt = await rx.wait();
        log(`  ✅ SF topped up with $${SF_TOPUP_AMOUNT_USD}  tx=${rx.hash.slice(0, 12)}…  gas=${rcpt.gasUsed}`);

        // Wait 2s for RPC to catch up before reading state
        await new Promise(r => setTimeout(r, 2000));
        const [newTotal, sfRawUsdc] = await Promise.all([
          sf.totalBalance(),
          usdc.balanceOf(addrs.stabilityFund),
        ]);
        log(`  SF totalBalance (accounting): ${fmt6(newTotal)}`);
        log(`  SF raw USDC balance:          ${fmt6(sfRawUsdc)}`);
        if (sfRawUsdc > newTotal + 100_000n) {
          log(`  ⚠️  Raw USDC > totalBalance by ${fmt6(sfRawUsdc - newTotal)} -- Chainlink may have spent funds concurrently.`);
        }
      } catch (e) {
        log(`  ❌ SF auto-fund failed: ${(e.reason || e.shortMessage || e.message || '').slice(0, 100)}`);
      }
    }
  }

  // ── Action: Auto rescue ───────────────────────────────────────────────────
  if (needsRescue && !DRY_RUN) {
    if (!DEPLOYER_KEY) {
      log('  ⚠️  AUTO_RESCUE=true but DEPLOYER_PRIVATE_KEY not set — skipping');
    } else {
      log(`  ⚙️  Auto-rescuing up to ${RESCUE_BATCH} parked wallets…`);
      try {
        const signer    = new ethers.Wallet(DEPLOYER_KEY, provider);
        const keeperSig = keeper.connect(signer);
        const coder     = ethers.AbiCoder.defaultAbiCoder();
        const ENTRY_FEE = await safeCall(() => matA1.ENTRY_FEE(), 10_000_000n);
        const MSIZE     = await safeCall(() => matB1.MATRIX_SIZE(), 127n);
        const matBOcc   = await safeCall(() => matB1.occupancy(), 0n);
        let rescued     = 0;

        // Pre-scan: read up to SCAN_WINDOW entries to find RESCUE_BATCH eligible ones.
        // Fixes the getParkedMember(0) bug (same address every iteration) and handles
        // duplicate addresses at the front of the parked queue.
        const SCAN_WINDOW = Math.min(100, Number(totalParked));
        const seenAddrs   = new Set();
        const eligible    = [];
        let   scanSkipped = 0;

        log(`  Scanning ${SCAN_WINDOW} queue entries for up to ${RESCUE_BATCH} eligible...`);
        for (let si = 0; si < SCAN_WINDOW; si++) {
          if (eligible.length >= RESCUE_BATCH) break;
          const addr = await safeCall(() => matA1.getParkedMember(si), null);
          if (!addr || addr === ethers.ZeroAddress) break;
          const key = addr.toLowerCase();
          if (seenAddrs.has(key)) { scanSkipped++; continue; }
          seenAddrs.add(key);
          const inMatB = await safeCall(() => matB1.isActiveInMatrix(addr), false);
          if (inMatB) {
            log(`  [scan ${si}] ${addr.slice(0,10)}... already in MatB -- skip`);
            scanSkipped++;
            continue;
          }
          eligible.push(addr);
        }
        log(`  Found ${eligible.length} eligible (scanned ${SCAN_WINDOW}, skipped ${scanSkipped} dup/MatB)`);

        for (let ri = 0; ri < eligible.length; ri++) {
          const parkedAddr = eligible[ri];
          const item = [{ workType: WORK_PARKED_RESCUE, tierIndex: 0,
                          addr1: T1.matA, addr2: parkedAddr }];
          const performData = coder.encode(
            ['tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]'], [item]);
          const isOverflow  = matBOcc >= MSIZE;
          const gasLimit    = isOverflow ? 15_000_000 : 800_000;

          try {
            const tx  = await keeperSig.performUpkeep(performData, { gasLimit });
            const rcp = await tx.wait();
            if (rcp.status === 1) {
              rescued++;
              log(`  [${ri}] Rescued ${parkedAddr.slice(0,10)}...  gas=${rcp.gasUsed}`);
            }
          } catch (e) {
            const msg = e.reason || e.shortMessage || e.message || '';
            if (msg.includes('in-flight') || msg.includes('coalesce')) {
              log('  RPC throttle -- waiting 5s...');
              await new Promise(r => setTimeout(r, 5000));
            } else {
              log(`  [${ri}] Rescue failed ${parkedAddr.slice(0,10)}...: ${msg.slice(0, 80)}`);
            }
          }
          if (isOverflow) await new Promise(r => setTimeout(r, 1500));
        }
        log(`  Rescue run complete: ${rescued} rescued`);
      } catch (e) {
        log(`  ❌ Auto-rescue error: ${(e.reason || e.shortMessage || e.message || '').slice(0, 100)}`);
      }
    }
  }

  log('  -- Summary -------------------------------------------------------');

  const isCritical = sfTotalUSD < SF_CRITICAL_USD || totalParked > PARKED_CRITICAL;
  const isWarning  = sfTotalUSD < SF_MIN_USD       || totalParked > PARKED_WARN;
  const overallStatus = isCritical ? '\u{1F534} CRITICAL' : isWarning ? '\u{1F7E1} WARNING' : '\u{1F7E2} HEALTHY';

  log('  Overall: ' + overallStatus);
  log('  SF: ' + fmt6(sfTotal) + ' (' + sfHealthPct.toFixed(0) + '% health)  |  Parked: ' + totalParked + '  |  Cycles: ' + sysCycles + '  |  W1: T' + w1Tier);
  log('');

  if (TG_ENABLED && (isCritical || isWarning)) {
    const emoji = isCritical ? '\u{1F534}' : '\u{1F7E1}';
    const lines = [
      emoji + ' <b>CryptoNova Keeper Alert</b>',
      '',
      '<b>StabilityFund:</b> ' + fmt6(sfTotal) + ' (' + sfHealthPct.toFixed(0) + '% health)',
    ];
    if (sfTotalUSD < SF_CRITICAL_USD) lines.push('SF CRITICAL -- below $' + SF_CRITICAL_USD + '!');
    else if (sfTotalUSD < SF_MIN_USD) lines.push('SF WARNING -- below $' + SF_MIN_USD);
    lines.push('');
    lines.push('<b>Parked wallets:</b> ' + totalParked);
    if (totalParked > PARKED_CRITICAL) lines.push('Parked CRITICAL -- >' + PARKED_CRITICAL + '!');
    else if (totalParked > PARKED_WARN) lines.push('Parked WARNING -- >' + PARKED_WARN);
    lines.push('');
    lines.push('<b>W1 withdrawable:</b> ' + fmt6(w1Total));
    lines.push('<b>System cycles:</b> ' + sysCycles + '  |  <b>W1 tier:</b> T' + w1Tier);
    lines.push('');
    lines.push('<i>' + ts() + '</i>');

    const msg   = lines.filter(l => l !== undefined).join('\n');
    const tgOk  = await sendTelegram(msg);
    log(tgOk ? '  Telegram alert sent.' : '  Telegram send FAILED -- check BOT_TOKEN/CHAT_ID in .env.');
  } else if (TG_ENABLED) {
    log('  Telegram: system healthy -- no alert sent.');
  } else {
    log('  Telegram: not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable).');
  }

  flushLog();
}

main().catch(e => {
  log('\n  FATAL: ' + (e.message || e));
  flushLog();
  process.exit(1);
});
