"use strict";
/**
 * slow_drip.js -- 1000-wallet overnight registration stress test
 *
 * Registers one wallet at a time with a configurable delay between each,
 * simulating organic user signups. Designed to run unattended overnight.
 *
 * After Run 4 (HDR_OFFSET=454, COUNT=50), MatA2 is partially filled.
 * This script continues from HDR_OFFSET=504 and will naturally:
 *   1. Fill MatA2 (~77 more wallets) -> MatA2 cycles -> wallets cross to MatB
 *   2. MatB reaches 127/127 -> cycles out -> W1 auto-upgrades to T2
 *   3. Continue filling T2 MatA, T2 MatB -> W1 upgrades to T3
 *
 * Env vars:
 *   COUNT=1000      total wallets to register  (default 1000)
 *   HDR_OFFSET=504  BIP-44 index offset        (default 504 -- after Run 4)
 *   DELAY_MIN=0.5   minutes between each reg   (default 0.5 = 30s, decimals ok)
 *   JITTER=true     +/-40% random delay jitter (default true -- looks organic)
 *   REFERRER=0x...  upline override            (default = W1 from addresses file)
 *
 * Run:
 *   npx hardhat run scripts/slow_drip.js --network baseSepolia
 *
 * Override examples (PowerShell):
 *   $env:COUNT="1000"; $env:DELAY_MIN="0.5"; npx hardhat run scripts/slow_drip.js --network baseSepolia
 *   $env:DELAY_MIN="1"; $env:JITTER="false"; npx hardhat run scripts/slow_drip.js --network baseSepolia
 */
const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

// -- Config -------------------------------------------------------------------
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_11.json"
);
const COUNT      = Number(process.env.COUNT      || 1000);
const HDR_OFFSET = Number(process.env.HDR_OFFSET || 504);
const DELAY_MIN  = parseFloat(process.env.DELAY_MIN || "0.5"); // 30s default -> ~8.5h for 1000
const JITTER     = process.env.JITTER !== "false";   // true by default
const ETH_PER    = ethers.parseEther("0.01");        // 0.01 ETH per wallet (approve+register ~200k gas on Base)

// -- Helpers ------------------------------------------------------------------
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
const fmt6  = n => "$" + (Number(n) / 1e6).toFixed(2);
const ts    = () => new Date().toLocaleTimeString("en-US", { hour12: false });

function pad2(n) { return String(Math.floor(n)).padStart(2, "0"); }

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + "h " + pad2(m) + "m";
  return pad2(m) + "m " + pad2(s) + "s";
}

// Returns delay in SECONDS with optional +/-40% jitter
function nextDelaySec() {
  const base = DELAY_MIN * 60;
  if (!JITTER) return base;
  // Uniform random in [0.6*base, 1.4*base]
  return base * (0.6 + Math.random() * 0.8);
}

function makeWallet(index) {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("\n  FILL_MNEMONIC not set in .env");
    console.error("  Generate: node -e \"const {ethers}=require('ethers');console.log(ethers.Wallet.createRandom().mnemonic.phrase)\"");
    process.exit(1);
  }
  const bip44 = "m/44'/60'/0'/0/" + (index + HDR_OFFSET);
  return ethers.HDNodeWallet.fromPhrase(mnemo, undefined, bip44);
}

// -- Main ---------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("\n  " + ADDRESSES_FILE + " not found. Run deploy_v8.js first.");
    process.exit(1);
  }

  const addrs     = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const signers   = await ethers.getSigners();
  const rawSigner = signers[0];
  const rawFunder = signers[1] || rawSigner;
  const deployer     = new NonceManager(rawSigner);
  const deployerAddr = rawSigner.address;
  const funderAddr   = rawFunder.address;

  // -- Load addresses ---------------------------------------------------------
  const USDC_ADDR = addrs.usdc  || addrs.USDC;
  const TR_ADDR   = addrs.tierRouter || addrs.TierRouter;
  // Support both flat (addrs.T1) and nested (addrs.tiers.T1) layouts
  const T1        = addrs.T1 || addrs.tiers && addrs.tiers.T1;
  const T2_ADDRS  = addrs.T2 || addrs.tiers && addrs.tiers.T2;
  const W1_ADDR   = addrs.accountOne || addrs.W1;
  const PM_ADDR   = T1 && (T1.pm || T1.pairManager);

  if (!T1 || !T1.matA || !PM_ADDR) {
    console.error("  T1 addresses missing in addresses file (need T1.matA and T1.pm)");
    process.exit(1);
  }

  // -- Contracts --------------------------------------------------------------
  const usdc  = await ethers.getContractAt("MockUSDC",            USDC_ADDR, deployer);
  const matA1 = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
  const matB1 = await ethers.getContractAt("FigureEightMatrixV8", T1.matB);
  const tr    = await ethers.getContractAt("TierRouter",          TR_ADDR);

  const T1_FEE = await matA1.ENTRY_FEE();
  const MSIZE  = await matA1.MATRIX_SIZE();
  const UPLINE = process.env.REFERRER || W1_ADDR;

  // T2 contracts for upgrade detection (optional -- may not exist yet)
  let matA2 = null, matB2 = null;
  try {
    if (T2_ADDRS && T2_ADDRS.matA) {
      matA2 = await ethers.getContractAt("FigureEightMatrixV8", T2_ADDRS.matA);
      matB2 = await ethers.getContractAt("FigureEightMatrixV8", T2_ADDRS.matB);
    }
  } catch (_) { /* T2 not deployed yet -- fine */ }

  // -- Pre-flight funder ETH check -------------------------------------------
  const funderEth  = await ethers.provider.getBalance(funderAddr);
  const ethNeeded  = ETH_PER * BigInt(COUNT);
  const funderEtF  = Number(ethers.formatEther(funderEth)).toFixed(3);
  const neededEtF  = Number(ethers.formatEther(ethNeeded)).toFixed(3);

  // -- Banner -----------------------------------------------------------------
  const estTotalMs = COUNT * DELAY_MIN * 60 * 1000;
  const etaTime    = new Date(Date.now() + estTotalMs).toLocaleTimeString("en-US", { hour12: false });

  console.log("\n  ============================================================");
  console.log("  slow_drip.js -- 1000-Wallet Overnight Stress Test");
  console.log("  ============================================================");
  console.log("  Wallets:    " + COUNT + "  (HDR offset " + HDR_OFFSET + "--" + (HDR_OFFSET + COUNT - 1) + ")");
  console.log("  Delay:      ~" + DELAY_MIN + " min per reg" + (JITTER ? " (+/-40% jitter)" : ""));
  console.log("  T1 fee:     " + fmt6(T1_FEE));
  console.log("  Matrix sz:  " + MSIZE);
  console.log("  Upline:     " + UPLINE);
  console.log("  Deployer:   " + deployerAddr);
  console.log("  Funder:     " + funderAddr + "  (" + funderEtF + " ETH, need " + neededEtF + ")");
  console.log("  Start:      " + ts());
  console.log("  Est. end:   " + etaTime + "  (" + fmtDuration(estTotalMs) + " at " + DELAY_MIN + " min/reg)");

  if (funderEth < ethNeeded) {
    const shortfall = Number(ethers.formatEther(ethNeeded - funderEth)).toFixed(3);
    console.log("\n  WARNING: Funder short by " + shortfall + " ETH.");
    console.log("  Run fund_funder.js first:");
    console.log("    npx hardhat run scripts/fund_funder.js --network baseSepolia");
    console.log("  Then re-run this script.\n");
    process.exit(1);
  }
  console.log("  Funder ETH: OK");
  console.log("  ------------------------------------------------------------");

  // -- Pre-run sanity: W1 registered? ----------------------------------------
  const w1Joined = await tr.globalJoined(W1_ADDR).catch(() => false);
  if (!w1Joined) {
    console.error("  W1 is not registered. Run bigfill_v8.js first to seed W1.");
    process.exit(1);
  }

  // -- Pre-drip state snapshot -----------------------------------------------
  {
    const occA = await matA1.occupancy();
    const occB = await matB1.occupancy();
    const wt   = await tr.memberHighestTier(W1_ADDR);
    const tc   = await tr.totalSystemCycles();
    const need = Math.max(0, Number(MSIZE) - Number(occB));
    console.log("\n  PRE-DRIP STATE");
    console.log("  T1 MatA: " + occA + "/" + MSIZE + "   T1 MatB: " + occB + "/" + MSIZE);
    console.log("  W1 tier: T" + wt + "   System cycles: " + tc);
    console.log("  MatB needs " + need + " more fills to cycle -> W1 upgrades to T2");
    if (matA2 && matB2) {
      try {
        const o2A = await matA2.occupancy();
        const o2B = await matB2.occupancy();
        console.log("  T2 MatA: " + o2A + "/" + MSIZE + "   T2 MatB: " + o2B + "/" + MSIZE);
      } catch (_) {}
    }
    console.log("");
  }

  // -- Main drip loop ---------------------------------------------------------
  let registered = 0;
  let skipped    = 0;
  let failed     = 0;
  const startTime = Date.now();
  const countWidth = String(COUNT).length;

  for (let i = 0; i < COUNT; i++) {
    const wallet    = makeWallet(i);
    const walletRp  = wallet.connect(ethers.provider);
    const shortAddr = wallet.address.slice(0, 10) + "...";
    const num       = String(i + 1).padStart(countWidth, " ");

    // Already joined? Skip immediately (no delay)
    let alreadyJoined = false;
    try { alreadyJoined = await tr.globalJoined(wallet.address); } catch (_) {}
    if (alreadyJoined) {
      console.log("  [" + ts() + "] " + num + "/" + COUNT + "  " + shortAddr + "  SKIP already joined");
      skipped++;
      continue;
    }

    // Fund ETH if needed
    const ethBal = await ethers.provider.getBalance(wallet.address);
    if (ethBal < ETH_PER / 2n) {
      try {
        const tx = await rawFunder.sendTransaction({ to: wallet.address, value: ETH_PER });
        await tx.wait();
      } catch (e) {
        console.error("  [" + ts() + "] " + num + "/" + COUNT + "  " + shortAddr + "  FAIL ETH fund: " + (e.message || "").slice(0, 60));
        failed++;
        continue;
      }
    }

    // Fund USDC if needed
    const usdcBal = await usdc.balanceOf(wallet.address);
    if (usdcBal < T1_FEE) {
      try {
        const mintAmt = T1_FEE + T1_FEE / 10n; // +10% buffer
        const tx = await usdc.mint(wallet.address, mintAmt);
        await tx.wait();
      } catch (e) {
        console.error("  [" + ts() + "] " + num + "/" + COUNT + "  " + shortAddr + "  FAIL USDC mint: " + (e.message || "").slice(0, 60));
        failed++;
        continue;
      }
    }

    // Approve PairManager + Register
    let regOk = false;
    try {
      const usdcW = usdc.connect(walletRp);
      const trW   = tr.connect(walletRp);
      const appTx = await usdcW.approve(PM_ADDR, T1_FEE, { gasLimit: 80_000 });
      await appTx.wait();
      const regTx = await trW.register(UPLINE, { gasLimit: 10_000_000 });
      await regTx.wait();
      registered++;
      regOk = true;
    } catch (e) {
      const reason = e.reason || e.shortMessage || (e.message || "").slice(0, 80);
      console.error("  [" + ts() + "] " + num + "/" + COUNT + "  " + shortAddr + "  FAIL register: " + reason);
      failed++;
    }

    // Status line
    let occLine = "";
    try {
      const occA = await matA1.occupancy();
      const occB = await matB1.occupancy();
      occLine = "  MatA " + occA + "/" + MSIZE + "  MatB " + occB + "/" + MSIZE;
    } catch (_) {}

    let w1Line = "";
    try {
      const wt = await tr.memberHighestTier(W1_ADDR);
      const tc = await tr.totalSystemCycles();
      w1Line = "  W1->T" + wt + "(cyc " + tc + ")";
      if (Number(wt) >= 2) {
        console.log("\n  *** W1 AUTO-UPGRADED TO T" + wt + "! System cycles: " + tc + " ***\n");
      }
    } catch (_) {}

    const elapsed   = Date.now() - startTime;
    const remaining = COUNT - i - 1;
    const avgMs     = (registered + failed) > 0 ? elapsed / (registered + failed) : DELAY_MIN * 60000;
    const etaMs     = remaining * avgMs;
    const statusStr = regOk ? "OK  " : "FAIL";

    console.log(
      "  [" + ts() + "] " + num + "/" + COUNT + "  " + shortAddr + "  " +
      statusStr + occLine + w1Line + "  ETA " + fmtDuration(etaMs)
    );

    // Delay before next registration (skip delay after last wallet)
    if (i < COUNT - 1) {
      const delaySec = nextDelaySec();
      const wakeAt   = new Date(Date.now() + delaySec * 1000).toLocaleTimeString("en-US", { hour12: false });
      const delayStr = JITTER
        ? "~" + (delaySec / 60).toFixed(1) + " min"
        : DELAY_MIN + " min";
      console.log("  [" + ts() + "]  ... next in " + delayStr + " -> " + wakeAt + "\n");
      await sleep(delaySec);
    }
  }

  // -- Final summary ----------------------------------------------------------
  const totalTime = Date.now() - startTime;
  console.log("\n  ============================================================");
  console.log("  DRIP COMPLETE");
  console.log("  ============================================================");
  console.log("  Registered: " + registered + "   Skipped: " + skipped + "   Failed: " + failed);
  console.log("  Runtime:    " + fmtDuration(totalTime));
  try {
    const occA = await matA1.occupancy();
    const occB = await matB1.occupancy();
    const wt   = await tr.memberHighestTier(W1_ADDR);
    const tc   = await tr.totalSystemCycles();
    console.log("  T1 MatA: " + occA + "/" + MSIZE + "   T1 MatB: " + occB + "/" + MSIZE);
    console.log("  W1 tier: T" + wt + "   System cycles: " + tc);
    if (matA2 && matB2) {
      const o2A = await matA2.occupancy().catch(() => "?");
      const o2B = await matB2.occupancy().catch(() => "?");
      console.log("  T2 MatA: " + o2A + "/" + MSIZE + "   T2 MatB: " + o2B + "/" + MSIZE);
    }
    const need = Math.max(0, Number(MSIZE) - Number(occB));
    if (need > 0) {
      console.log("\n  MatB still needs " + need + " more fills. Continue with:");
      console.log("  $env:HDR_OFFSET=\"" + (HDR_OFFSET + COUNT) + "\"; $env:COUNT=\"200\"; npx hardhat run scripts/slow_drip.js --network baseSepolia");
    } else if (Number(wt) < 2) {
      console.log("\n  MatB full but W1 not yet T2 -- Chainlink keeper may need to trigger.");
    } else {
      console.log("\n  W1 is T" + wt + " -- stress test complete!");
    }
  } catch (e) {
    console.log("  (Final state query error: " + (e.message || "").slice(0, 60) + ")");
  }
  console.log("  ============================================================\n");
  console.log("  Next run: $env:HDR_OFFSET=\"" + (HDR_OFFSET + COUNT) + "\"; $env:COUNT=\"1000\"; npx hardhat run scripts/slow_drip.js --network baseSepolia");
}

main().catch(e => {
  console.error("\n  slow_drip.js fatal error:", e);
  process.exit(1);
});
