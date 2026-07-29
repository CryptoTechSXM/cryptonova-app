// community_drip.js — Organic community-safe testnet fill
// ─────────────────────────────────────────────────────────────────────────────
// Registers test wallets ONE at a time, every INTERVAL_MINS minutes.
// Designed to run on the VPS alongside the normal keeper.
//
// Hard rules:
//   ✅  1 wallet registered per interval (organic pace)
//   ✅  Manual upgrade — if a wallet cycled out and has enough own USDC → upgrade
//   ❌  No withdrawals        (earnings stay in contract, no cash-out pressure)
//   ❌  No force-cross        (fills happen naturally, no shortcuts)
//   ❌  No SF rescue          (keeper can run, but WE don't trigger coPayRescue)
//   ❌  No CNOVA sell/burn    (no earlyUnlock, no sell pressure)
//
// Run:   node community_drip.js
// Stop:  Ctrl+C  (state is saved to community_drip_state.json — safe to resume)
//
// Copy to VPS:  scp community_drip.js root@167.99.0.250:/root/keeper/
// Run on VPS:   cd /root/keeper && node community_drip.js >> drip.log 2>&1 &
//
// Env vars (same .env as keeper scripts):
//   BASE_SEPOLIA_RPC_URL    RPC endpoint
//   DEPLOYER_KEY            Funder wallet private key (needs USDC + ETH)
//   FILL_MNEMONIC           BIP-39 mnemonic for deterministic test wallets
//   ADDRESSES_FILE          Path to deployed_addresses_v8_35.json (default: auto-detect)
//   HDR_OFFSET              BIP-44 start index  (default 0 — change to avoid reuse)
//   COUNT                   Total wallets to register  (default 127 = 1 full T1 MatA)
//   INTERVAL_MINS           Minutes between registrations  (default 5)
//   REFERRER                Referrer address override  (default: accountOne / W1)
//   TELEGRAM_BOT_TOKEN      Optional — Telegram alerts
//   TELEGRAM_CHAT_ID        Optional — Telegram chat ID
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── Validate required env vars ────────────────────────────────────────────────

const DEPLOYER_KEY  = process.env.DEPLOYER_KEY;
const FILL_MNEMONIC = process.env.FILL_MNEMONIC;
if (!DEPLOYER_KEY)  { console.error("❌  DEPLOYER_KEY not set in .env");  process.exit(1); }
if (!FILL_MNEMONIC) { console.error("❌  FILL_MNEMONIC not set in .env"); process.exit(1); }

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL       = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const HDR_OFFSET    = Number(process.env.HDR_OFFSET    ?? 0);
const COUNT         = Number(process.env.COUNT         ?? 127);
const INTERVAL_MINS = Number(process.env.INTERVAL_MINS ?? 5);
const INTERVAL_MS   = INTERVAL_MINS * 60 * 1000;

// Gas budget per new wallet (covers USDC approve ~60k + register ~600k + any future manualUpgrade ~600k)
const ETH_PER_WALLET    = ethers.parseEther("0.008");
// Extra ETH top-up when a wallet needs gas for manualUpgrade but has run dry
const ETH_UPGRADE_TOPUP = ethers.parseEther("0.003");

// ── Address file ──────────────────────────────────────────────────────────────

function loadAddresses() {
  if (process.env.ADDRESSES_FILE) {
    const p = path.isAbsolute(process.env.ADDRESSES_FILE)
      ? process.env.ADDRESSES_FILE
      : path.join(__dirname, process.env.ADDRESSES_FILE);
    if (!fs.existsSync(p)) { console.error(`❌  ADDRESSES_FILE not found: ${p}`); process.exit(1); }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  // Auto-detect: pick the highest-numbered v8_XX file
  const files = fs.readdirSync(__dirname)
    .filter(f => /^deployed_addresses_v8_\d+/.test(f) && f.endsWith(".json") && !f.includes("_real"))
    .sort();
  if (!files.length) { console.error("❌  No deployed_addresses_v8_*.json found"); process.exit(1); }
  const chosen = files[files.length - 1];
  log(`📂  Using: ${chosen}`);
  return JSON.parse(fs.readFileSync(path.join(__dirname, chosen), "utf8"));
}

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const TR_ABI = [
  // Registration
  "function register(address referrer) external",
  // Upgrade — called by the member wallet; pulls fee from wallet's own USDC
  "function manualUpgrade(uint8 targetTierIndex) external",
  // Read-only
  "function globalJoined(address) external view returns (bool)",
  "function memberHighestTier(address) external view returns (uint8)",
  "function tierEntryFees(uint256 tierNum) external view returns (uint256)",
  "function globalJoinedCount() external view returns (uint256)",
  "function tierCycles(address member, uint8 tierIndex) external view returns (uint256)",
];

const MATRIX_ABI = [
  "function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))",
  "function isParked(address) external view returns (bool)",
  "function parkedAt(address) external view returns (uint256)",
  "function occupancy() external view returns (uint256)",
  "function isActiveInMatrix(address) external view returns (bool)",
];

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  // Testnet MockUSDC — some deploys allow deployer to mint
  "function mint(address to, uint256 amount) external",
];

// ── Persistence ───────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, "community_drip_state.json");
const LOG_FILE   = path.join(__dirname, "community_drip.log");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      nextWalletIndex:    HDR_OFFSET,
      registeredAddrs:    [],  // all addresses we've successfully registered
      upgradedAddrs:      [],  // addresses that have reached T2+
      startedAt:          new Date().toISOString(),
    };
  }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function bar(label) {
  const pad = "─".repeat(Math.max(0, 54 - label.length));
  log(`  ── ${label} ${pad}`);
}

function fmt6(n)      { return "$" + (Number(n) / 1e6).toFixed(2); }
function short(addr)  { return `${addr.slice(0, 8)}…${addr.slice(-5)}`; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tg(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML" }),
    });
  } catch {}
}

// ── Wallet derivation ─────────────────────────────────────────────────────────

function deriveWallet(index) {
  return ethers.HDNodeWallet.fromPhrase(FILL_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
}

// ── Fund a fresh wallet from deployer ─────────────────────────────────────────
// Tries mint() first (works on testnet when deployer is MockUSDC owner).
// Falls back to transfer() if mint reverts (e.g. deployer is not owner).

async function fundWallet(deployer, usdc, walletAddr) {
  // ETH for gas
  const ethTx = await deployer.sendTransaction({ to: walletAddr, value: ETH_PER_WALLET });
  await ethTx.wait();
  log(`       ETH ✓  ${ethers.formatEther(ETH_PER_WALLET)} ETH`);

  // USDC — try mint first, fall back to transfer
  const T1_FEE = 10_000_000n;
  try {
    await (await usdc.connect(deployer).mint(walletAddr, T1_FEE, { gasLimit: 120_000 })).wait();
    log(`       USDC ✓  ${fmt6(T1_FEE)} (minted)`);
  } catch {
    await (await usdc.connect(deployer).transfer(walletAddr, T1_FEE, { gasLimit: 120_000 })).wait();
    log(`       USDC ✓  ${fmt6(T1_FEE)} (transferred)`);
  }
}

// ── Register a wallet via TierRouter ─────────────────────────────────────────
// 1. Approve PairManager to spend USDC  (PairManager is the actual spender)
// 2. Call TierRouter.register(referrer)

async function registerWallet(provider, wallet, tierRouter, usdc, pmAddr, referrer) {
  const conn    = wallet.connect(provider);
  const trAddr  = await tierRouter.getAddress();
  const T1_FEE  = 10_000_000n;

  // Approve PairManager (the contract that actually pulls USDC on register)
  const pmAllowance = await usdc.allowance(wallet.address, pmAddr);
  if (pmAllowance < T1_FEE) {
    await (await usdc.connect(conn).approve(pmAddr, T1_FEE, { gasLimit: 100_000 })).wait();
    log(`       Approved PM ${short(pmAddr)}`);
  }

  // Also approve TierRouter for manualUpgrade calls later
  const trAllowance = await usdc.allowance(wallet.address, trAddr);
  if (trAllowance < ethers.MaxUint256 / 2n) {
    await (await usdc.connect(conn).approve(trAddr, ethers.MaxUint256, { gasLimit: 100_000 })).wait();
    log(`       Approved TierRouter`);
  }

  // Register
  const tx = await tierRouter.connect(conn).register(referrer, { gasLimit: 800_000 });
  const receipt = await tx.wait();
  log(`       Register ✓  tx: ${receipt.hash.slice(0, 18)}…`);
  return receipt;
}

// ── Manual upgrade scan ───────────────────────────────────────────────────────
// After each registration, checks every registered wallet:
//   • Completed at least 1 T1 cycle (via tierCycles)?
//   • Not yet at T2?
//   • Has enough USDC in own wallet to pay T2 fee?
// If all three: calls manualUpgrade(1) from that wallet.
//
// Note: manualUpgrade() requires the member to hold the tier fee in their
// EXTERNAL wallet USDC — it is not drawn from on-chain withdrawable.
// Members who don't have enough just stay parked; no SF rescue is triggered.

async function scanUpgrades(provider, deployer, tierRouter, matA, matB, usdc, state, tierFees) {
  let upgraded = 0;

  for (let i = 0; i < state.registeredAddrs.length; i++) {
    const addr = state.registeredAddrs[i];
    if (state.upgradedAddrs.includes(addr.toLowerCase())) continue;

    try {
      // Already at T2+?
      const highestTier = await tierRouter.memberHighestTier(addr);
      if (highestTier > 0) {
        state.upgradedAddrs.push(addr.toLowerCase());
        log(`  📈  ${short(addr)} → already at T${highestTier + 1} (noted)`);
        continue;
      }

      // Has at least 1 T1 cycle?
      const cycles = await tierRouter.tierCycles(addr, 0);
      if (cycles < 1n) continue;

      // Parked in MatA or MatB?
      const [parkedA, parkedB] = await Promise.all([
        matA.isParked(addr).catch(() => false),
        matB.isParked(addr).catch(() => false),
      ]);
      if (!parkedA && !parkedB) continue;

      // Has enough own USDC for T2 fee?
      const t2Fee   = tierFees[1];          // T2 entry fee
      const ownUsdc = await usdc.balanceOf(addr);

      const parkedLabel = parkedA ? "MatA" : "MatB";
      log(`  🅿️   ${short(addr)} parked in ${parkedLabel} | own USDC: ${fmt6(ownUsdc)} | T2 fee: ${fmt6(t2Fee)}`);

      if (ownUsdc < t2Fee) {
        log(`       Not self-funded for T2 — waiting for organic earnings (no rescue)`);
        continue;
      }

      // All checks pass — trigger manual upgrade
      const idx        = HDR_OFFSET + i;
      const wallet     = deriveWallet(idx);
      const conn       = wallet.connect(provider);

      // Top up ETH if needed for the manualUpgrade gas
      const ethBal = await provider.getBalance(addr);
      if (ethBal < ethers.parseEther("0.001")) {
        log(`       ⛽  Low on gas — topping up for upgrade`);
        const tx = await deployer.sendTransaction({ to: addr, value: ETH_UPGRADE_TOPUP });
        await tx.wait();
      }

      log(`  ⬆️   ${short(addr)} calling manualUpgrade(T2) …`);
      const tx = await tierRouter.connect(conn).manualUpgrade(1, { gasLimit: 800_000 });
      await tx.wait();

      state.upgradedAddrs.push(addr.toLowerCase());
      upgraded++;
      log(`  ✅  ${short(addr)} → T2!`);
      await tg(`⬆️ <b>Manual Upgrade</b>\n${short(addr)} → T2\nOwn USDC was ${fmt6(ownUsdc)}`);

      await sleep(3000); // 3s between upgrades — avoid nonce race
    } catch (e) {
      const msg = e.shortMessage || e.message?.slice(0, 100) || "unknown";
      if (!msg.includes("not parked") && !msg.includes("cross to MatB")) {
        log(`  ⚠️   upgrade scan ${short(addr)}: ${msg}`);
      }
    }
  }

  if (upgraded > 0) saveState(state);
  return upgraded;
}

// ── Status snapshot ───────────────────────────────────────────────────────────

async function printStatus(provider, tierRouter, matA, matB, state) {
  try {
    const [globalCount, matAOcc, matBOcc] = await Promise.all([
      tierRouter.globalJoinedCount(),
      matA.occupancy(),
      matB.occupancy(),
    ]);
    bar("STATUS");
    log(`  Script registered: ${state.registeredAddrs.length} / ${COUNT}`);
    log(`  Chain total:       ${globalCount} members`);
    log(`  T1 MatA:           ${matAOcc} / 127 seats`);
    log(`  T1 MatB:           ${matBOcc} / 127 seats`);
    log(`  Upgraded to T2+:   ${state.upgradedAddrs.length}`);
    log(`  Next wallet index: ${state.nextWalletIndex}`);
    const finishAt = new Date(Date.now() + (COUNT - state.registeredAddrs.length) * INTERVAL_MS);
    log(`  Est. completion:   ${finishAt.toLocaleString()} (${INTERVAL_MINS} min/reg)`);
    log(`  ${"─".repeat(58)}`);
  } catch (e) {
    log(`  ⚠️   Status query: ${e.message?.slice(0, 60)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

  log("════════════════════════════════════════════════════════════════");
  log("  🐢  community_drip.js — slow organic fill, no pressure");
  log("════════════════════════════════════════════════════════════════");
  log(`  Deployer:    ${deployer.address}`);
  log(`  Count:       ${COUNT} wallets  |  Interval: ${INTERVAL_MINS} min`);
  log(`  HDR_OFFSET:  ${HDR_OFFSET}`);
  log(`  Est. time:   ~${Math.round(COUNT * INTERVAL_MINS / 60)}h ${(COUNT * INTERVAL_MINS) % 60}m`);
  log(`  Rules:       no withdraw · no force-cross · no sell · manual upgrade only`);
  log("  ────────────────────────────────────────────────────────────");

  // ── Load addresses ──
  const ADDRS   = loadAddresses();
  const trAddr  = ADDRS.tierRouter;
  const usdcAddr = ADDRS.usdc || "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
  const t1       = ADDRS.tiers?.T1 || {};
  const pmAddr   = t1.pm  || "0x129A64326f3C49B32f29731d5e225c2ce847809b"; // T1 PairManager
  const matAAddr = t1.matA || "0xB213373df3da9eBE386d52A4e0e16B345859E315"; // T1 MatA
  const matBAddr = t1.matB || "0x71CC1aD8Ad94EA4f7E93465E7F0423002b8172A2"; // T1 MatB

  if (!trAddr) { log("❌  tierRouter not in addresses file"); process.exit(1); }

  log(`  TierRouter:  ${trAddr}`);
  log(`  T1 PM:       ${pmAddr}`);
  log(`  T1 MatA:     ${matAAddr}`);
  log(`  T1 MatB:     ${matBAddr}`);

  const tierRouter = new ethers.Contract(trAddr, TR_ABI, provider);
  const matA       = new ethers.Contract(matAAddr, MATRIX_ABI, provider);
  const matB       = new ethers.Contract(matBAddr, MATRIX_ABI, provider);
  const usdc       = new ethers.Contract(usdcAddr, USDC_ABI, provider);

  // ── Load tier fees ──
  let tierFees = [];
  try {
    for (let i = 0; i < 3; i++) tierFees.push(await tierRouter.tierEntryFees(i));
    log(`  T1: ${fmt6(tierFees[0])}  T2: ${fmt6(tierFees[1])}  T3: ${fmt6(tierFees[2])}`);
  } catch {
    tierFees = [10_000_000n, 25_000_000n, 50_000_000n];
    log(`  ⚠️   Using default tier fees (RPC may be slow)`);
  }

  // ── Referrer ──
  const referrer = process.env.REFERRER
    || ADDRS.accountOne
    || ADDRS.w1Address
    || "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435"; // W1 fallback
  log(`  Referrer:    ${referrer}`);

  // ── Deployer balances ──
  const [depEth, depUsdc] = await Promise.all([
    provider.getBalance(deployer.address),
    usdc.balanceOf(deployer.address),
  ]);
  log(`  Deployer ETH:  ${ethers.formatEther(depEth)}`);
  log(`  Deployer USDC: ${fmt6(depUsdc)}`);

  const ethNeeded  = ETH_PER_WALLET * BigInt(COUNT);
  const usdcNeeded = 10_000_000n * BigInt(COUNT);
  if (depEth  < ethNeeded)  log(`  ⚠️   ETH may run low (need ~${ethers.formatEther(ethNeeded)})`);
  if (depUsdc < usdcNeeded) log(`  ⚠️   USDC may run low (need ~${fmt6(usdcNeeded)})`);

  // ── W1 registered? ──
  const w1Joined = await tierRouter.globalJoined(referrer).catch(() => false);
  if (!w1Joined) {
    log(`  ⚠️   Referrer ${short(referrer)} is not registered — registrations may revert!`);
    log(`       Run seed_w1.js first if W1 hasn't been seeded yet.`);
  }

  // ── Resume state ──
  const state = loadState();
  if (state.registeredAddrs.length > 0) {
    log(`\n  ♻️   Resuming from ${state.registeredAddrs.length} already registered`);
  }
  log("  ────────────────────────────────────────────────────────────");

  await tg(`🐢 <b>community_drip.js started</b>\n${COUNT} wallets · ${INTERVAL_MINS} min/reg · no withdraw · no sell\nDeployer: ${short(deployer.address)}`);

  await printStatus(provider, tierRouter, matA, matB, state);

  // ── Registration loop ─────────────────────────────────────────────────────
  while (state.registeredAddrs.length < COUNT) {
    const walletIdx = state.nextWalletIndex;
    const wallet    = deriveWallet(walletIdx);
    const addr      = wallet.address;
    const n         = state.registeredAddrs.length + 1;

    bar(`WALLET ${n}/${COUNT}  ·  index ${walletIdx}`);
    log(`  Address: ${addr}`);

    // ── Skip already-registered wallets without waiting ──
    try {
      const joined = await tierRouter.globalJoined(addr);
      if (joined) {
        log(`  ↩️   Already on-chain — skipping`);
        if (!state.registeredAddrs.includes(addr)) state.registeredAddrs.push(addr);
        state.nextWalletIndex++;
        saveState(state);
        await sleep(2000);
        continue;
      }
    } catch { /* RPC hiccup — proceed */ }

    // ── Fund + Register ──
    let success = false;
    try {
      log(`  💸  Funding…`);
      await fundWallet(deployer, usdc, addr);
      log(`  📝  Registering…`);
      await registerWallet(provider, wallet, tierRouter, usdc, pmAddr, referrer);
      state.registeredAddrs.push(addr);
      state.nextWalletIndex++;
      saveState(state);
      success = true;
      log(`  🎉  Registered! Total script count: ${state.registeredAddrs.length}`);
      await tg(`✅ <b>Registered</b> #${state.registeredAddrs.length}/${COUNT}\n${short(addr)}`);
    } catch (e) {
      const msg = e.shortMessage || e.message?.slice(0, 100) || "unknown";
      log(`  ❌  Failed: ${msg}`);
      log(`       Same wallet will retry next interval`);
      await tg(`❌ <b>Registration failed</b>\n${short(addr)}: ${msg.slice(0, 80)}`);
    }

    // ── Upgrade scan (after every successful registration) ──
    if (success) {
      const upgraded = await scanUpgrades(
        provider, deployer, tierRouter, matA, matB, usdc, state, tierFees
      );
      if (upgraded > 0) log(`  ⬆️   ${upgraded} wallet(s) upgraded to next tier`);
    }

    // ── Status every 10 wallets ──
    if (state.registeredAddrs.length % 10 === 0 && state.registeredAddrs.length > 0) {
      await printStatus(provider, tierRouter, matA, matB, state);
    }

    // ── Wait for next slot ──
    if (state.registeredAddrs.length < COUNT) {
      const nextAt = new Date(Date.now() + INTERVAL_MS);
      log(`\n  ⏱️   Next registration: ${nextAt.toLocaleTimeString()} (${INTERVAL_MINS} min)\n`);
      await sleep(INTERVAL_MS);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  bar("COMPLETE");
  log(`  🏁  All ${COUNT} wallets registered!`);
  await printStatus(provider, tierRouter, matA, matB, state);
  await tg(`🏁 <b>community_drip complete</b>\nAll ${COUNT} wallets registered!`);
}

main().catch(e => {
  log(`\n💥  Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
