"use strict";
/**
 * organic_sim.js — Real-World Sustainability Simulation for V8.8
 *
 * WHY: The push_parked.js backlog (1264 parked wallets) is a testnet artifact
 * from batch-registering 941 wallets in 10h. In real mainnet operation, members
 * join organically — one at a time over days or weeks — and accumulate chain-pay
 * earnings BEFORE cycling out as MatA root. Theory says root earns $15.60 from
 * 126 subsequent entries ($2+$1.60+$2.40+$2.40+$2.40+$4.80 across 6 BFS levels),
 * well above the $10 ENTRY_FEE needed to cross to MatB.
 *
 * This script VALIDATES that theory empirically by:
 *   1. Querying the current MatA root's withdrawable BEFORE each registration
 *   2. Detecting cycle-outs (root address changes after the TX)
 *   3. Checking if the old root ended up in MatB (self-funded) or parked (SF needed)
 *   4. Tracking parked-count delta per registration
 *   5. Printing a sustainability scorecard at the end
 *
 * Run (PowerShell):
 *   npx hardhat run scripts/organic_sim.js --network baseSepolia
 *
 * Overrides:
 *   $env:COUNT="200"        how many wallets to register (default 200)
 *   $env:HDR_OFFSET="1504"  BIP-44 index start         (default 1504)
 *   $env:DELAY_MIN="0.5"    minutes between registrations (default 0.5)
 *   $env:JITTER="true"      +/-40% random jitter       (default true)
 *   $env:VERBOSE="true"     print root withdrawable every entry (default false)
 */

const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(__dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_11.json");

const COUNT      = Number(process.env.COUNT      || 200);
const HDR_OFFSET = Number(process.env.HDR_OFFSET || 1504);
const DELAY_MIN  = parseFloat(process.env.DELAY_MIN || "0.5");
const JITTER     = process.env.JITTER   !== "false";
const VERBOSE    = process.env.VERBOSE  === "true";
const ETH_PER    = ethers.parseEther("0.01");

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep   = s  => new Promise(r => setTimeout(r, s * 1000));
const fmt6    = n  => "$" + (Number(n) / 1e6).toFixed(2);
const ts      = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const bar     = n  => "█".repeat(n) + "░".repeat(Math.max(0, 20 - n));

function pad2(n) { return String(Math.floor(n)).padStart(2, "0"); }
function fmtDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return h + "h " + pad2(m) + "m";
  return pad2(m) + "m " + pad2(s) + "s";
}

function nextDelaySec() {
  const base = DELAY_MIN * 60;
  if (!JITTER) return base;
  return base * (0.6 + Math.random() * 0.8);  // +/-40%
}

function makeWallet(index) {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("  FILL_MNEMONIC not set in .env");
    process.exit(1);
  }
  return ethers.HDNodeWallet.fromPhrase(mnemo, undefined,
    "m/44'/60'/0'/0/" + (index + HDR_OFFSET));
}

// Sustainability classification
const SELF_FUNDED = "self-funded";   // withdrew >= ENTRY_FEE, crossed to MatB
const PARKED      = "parked";        // withdrew < ENTRY_FEE, stuck in queue
const NO_CYCLE    = "no-cycle";      // this registration didn't trigger a cycle-out

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("  " + ADDRESSES_FILE + " not found.");
    process.exit(1);
  }

  const addrs  = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const signers    = await ethers.getSigners();
  const rawSigner  = signers[0];
  const rawFunder  = signers[1] || rawSigner;
  const deployer   = new NonceManager(rawSigner);

  const USDC_ADDR = addrs.usdc || addrs.USDC;
  const TR_ADDR   = addrs.tierRouter || addrs.TierRouter;
  const T1        = addrs.tiers?.T1 || addrs.T1;
  const W1_ADDR   = addrs.accountOne || addrs.W1;
  const PM_ADDR   = T1?.pm || T1?.pairManager;

  if (!T1 || !T1.matA || !PM_ADDR) {
    console.error("  T1 addresses missing (need tiers.T1.matA and tiers.T1.pm)");
    process.exit(1);
  }

  // Extra ABI entries needed for sustainability tracking
  const MATA_ABI_EXTRA = [
    'function posToMember(uint256) external view returns (address)',
    'function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
    'function getParkedCount() external view returns (uint256)',
    'function isParked(address) external view returns (bool)',
    'function occupancy() external view returns (uint256)',
    'function MATRIX_SIZE() external view returns (uint256)',
    'function ENTRY_FEE() external view returns (uint256)',
    'function rotationCount() external view returns (uint256)',
  ];
  const MATB_ABI_EXTRA = [
    'function isActiveInMatrix(address) external view returns (bool)',
    'function occupancy() external view returns (uint256)',
    'function MATRIX_SIZE() external view returns (uint256)',
  ];
  const TR_ABI_EXTRA = [
    'function globalJoined(address) external view returns (bool)',
    'function totalSystemCycles() external view returns (uint256)',
    'function memberHighestTier(address) external view returns (uint8)',
  ];

  const usdc  = await ethers.getContractAt("MockUSDC", USDC_ADDR, deployer);
  const matA  = new ethers.Contract(T1.matA, MATA_ABI_EXTRA, ethers.provider);
  const matB  = new ethers.Contract(T1.matB, MATB_ABI_EXTRA, ethers.provider);
  const tr    = new ethers.Contract(TR_ADDR, TR_ABI_EXTRA, ethers.provider);

  const ENTRY_FEE = await matA.ENTRY_FEE();
  const MSIZE     = await matA.MATRIX_SIZE();
  const UPLINE    = process.env.REFERRER || W1_ADDR;

  // Funder ETH check
  const funderEth  = await ethers.provider.getBalance(rawFunder.address);
  const ethNeeded  = ETH_PER * BigInt(COUNT);
  if (funderEth < ethNeeded) {
    const short = Number(ethers.formatEther(ethNeeded - funderEth)).toFixed(3);
    console.error("  Funder ETH short by " + short + " ETH. Run fund_funder.js first.");
    process.exit(1);
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  const estMs  = COUNT * DELAY_MIN * 60 * 1000;
  const etaStr = new Date(Date.now() + estMs)
    .toLocaleTimeString("en-US", { hour12: false });

  console.log("\n  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║       organic_sim.js — Sustainability Simulation        ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝\n");
  console.log("  Wallets:   " + COUNT + "  (HDR offset " + HDR_OFFSET + "–" + (HDR_OFFSET+COUNT-1) + ")");
  console.log("  Delay:     ~" + DELAY_MIN + " min/reg" + (JITTER ? " ±40% jitter" : ""));
  console.log("  ENTRY_FEE: " + fmt6(ENTRY_FEE) + "  |  MSIZE: " + MSIZE);
  console.log("  Start:     " + ts() + "  |  Est. finish: " + etaStr + "  (" + fmtDuration(estMs) + ")");

  // ── Pre-run snapshot ──────────────────────────────────────────────────────
  const [matAOccInit, matBOccInit, parkedInit, rotInit, sysCycInit, w1TierInit] =
    await Promise.all([
      matA.occupancy(), matB.occupancy(), matA.getParkedCount(),
      matA.rotationCount(), tr.totalSystemCycles(), tr.memberHighestTier(W1_ADDR),
    ]);

  console.log("\n  PRE-RUN STATE");
  console.log("  T1 MatA: " + matAOccInit + "/" + MSIZE + "  (rotations: " + rotInit + ")");
  console.log("  T1 MatB: " + matBOccInit + "/" + MSIZE);
  console.log("  Parked:  " + parkedInit);
  console.log("  Sys cyc: " + sysCycInit + "  |  W1 tier: T" + w1TierInit);

  // ── Sustainability ledger ─────────────────────────────────────────────────
  // cycleEvents[]: { registration#, root, withdrawableBefore, outcome }
  const cycleEvents  = [];
  let newParkedTotal = 0;   // net new parked wallets created this run
  let registered     = 0;
  let skipped        = 0;
  let failed         = 0;
  const startTime    = Date.now();

  // Current root tracking
  let prevRoot = await matA.posToMember(1).catch(() => ethers.ZeroAddress);

  console.log("\n  Current MatA root: " + prevRoot);
  try {
    const rootMember = await matA.getMember(prevRoot);
    console.log("  Root withdrawable: " + fmt6(rootMember.withdrawable) +
      (rootMember.withdrawable >= ENTRY_FEE ? "  ✅ > ENTRY_FEE" : "  ⚠️  < ENTRY_FEE"));
  } catch (_) {}

  console.log("\n  " + "─".repeat(62));
  console.log("  [Legend]  📈 cycle-out  ✅ self-funded  🆘 parked  🔢 no-cycle\n");

  const cntW = String(COUNT).length;

  // ── Main drip loop ────────────────────────────────────────────────────────
  for (let i = 0; i < COUNT; i++) {
    const wallet   = makeWallet(i);
    const walletRp = wallet.connect(ethers.provider);
    const short    = wallet.address.slice(0, 10) + "…";
    const num      = String(i + 1).padStart(cntW);

    // Skip if already joined
    let joined = false;
    try { joined = await tr.globalJoined(wallet.address); } catch (_) {}
    if (joined) {
      process.stdout.write("  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  SKIP\n");
      skipped++;
      continue;
    }

    // ── Pre-TX: capture root state ──────────────────────────────────────────
    let rootBefore = ethers.ZeroAddress;
    let rootWithdrawable = 0n;
    let parkedBefore = 0n;
    let matBOccBefore = 0n;

    try {
      [rootBefore, parkedBefore, matBOccBefore] = await Promise.all([
        matA.posToMember(1),
        matA.getParkedCount(),
        matB.occupancy(),
      ]);
      if (rootBefore !== ethers.ZeroAddress) {
        const rm = await matA.getMember(rootBefore);
        rootWithdrawable = rm.withdrawable;
      }
    } catch (_) {}

    if (VERBOSE) {
      console.log("  [" + ts() + "]  ROOT before: " + rootBefore.slice(0,10) +
        "…  wdrawable: " + fmt6(rootWithdrawable) +
        (rootWithdrawable >= ENTRY_FEE ? " ✅" : " ⚠️ "));
    }

    // ── Fund ETH ────────────────────────────────────────────────────────────
    const ethBal = await ethers.provider.getBalance(wallet.address);
    if (ethBal < ETH_PER / 2n) {
      try {
        const tx = await rawFunder.sendTransaction({ to: wallet.address, value: ETH_PER });
        await tx.wait();
      } catch (e) {
        console.log("  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  FAIL ETH fund");
        failed++;
        continue;
      }
    }

    // ── Fund USDC ───────────────────────────────────────────────────────────
    const usdcBal = await usdc.balanceOf(wallet.address);
    if (usdcBal < ENTRY_FEE) {
      try {
        const tx = await usdc.mint(wallet.address, ENTRY_FEE + ENTRY_FEE / 10n);
        await tx.wait();
      } catch (e) {
        console.log("  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  FAIL USDC mint");
        failed++;
        continue;
      }
    }

    // ── Register ─────────────────────────────────────────────────────────────
    let regOk = false;
    try {
      const usdcW = usdc.connect(walletRp);
      const trW   = new ethers.Contract(TR_ADDR, [
        'function register(address referrer) external',
      ], walletRp);
      await (await usdcW.approve(PM_ADDR, ENTRY_FEE, { gasLimit: 80_000 })).wait();
      await (await trW.register(UPLINE, { gasLimit: 10_000_000 })).wait();
      registered++;
      regOk = true;
    } catch (e) {
      const reason = e.reason || e.shortMessage || (e.message || "").slice(0, 80);
      console.log("  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  FAIL: " + reason);
      failed++;
    }

    if (!regOk) continue;

    // ── Post-TX: detect cycle-out ─────────────────────────────────────────
    let cycleOutcome = NO_CYCLE;
    let newParkedThis = 0;

    try {
      const [rootAfter, parkedAfter, matBOccAfter, matAOccAfter] = await Promise.all([
        matA.posToMember(1),
        matA.getParkedCount(),
        matB.occupancy(),
        matA.occupancy(),
      ]);

      const parkedDelta = Number(parkedAfter) - Number(parkedBefore);

      // Cycle-out detected: root address changed
      if (rootAfter.toLowerCase() !== rootBefore.toLowerCase() &&
          rootBefore !== ethers.ZeroAddress) {

        // Check if old root ended up in MatB (self-funded cross)
        let inMatB = false;
        try {
          inMatB = await matB.isActiveInMatrix(rootBefore);
        } catch (_) {}

        const selfFunded = rootWithdrawable >= ENTRY_FEE;

        if (inMatB) {
          cycleOutcome = SELF_FUNDED;
        } else if (await matA.isParked(rootBefore).catch(() => false)) {
          cycleOutcome = PARKED;
        } else {
          // They crossed to MatB but might not be active (already progressed)
          cycleOutcome = selfFunded ? SELF_FUNDED : PARKED;
        }

        cycleEvents.push({
          reg:              i + 1,
          root:             rootBefore,
          withdrawable:     rootWithdrawable,
          selfFundedCheck:  selfFunded,
          outcome:          cycleOutcome,
          parkedDelta,
          matBOccAfter:     Number(matBOccAfter),
        });

        const icon   = cycleOutcome === SELF_FUNDED ? "✅" : "🆘";
        const wLabel = fmt6(rootWithdrawable).padStart(7);
        const delta  = parkedDelta >= 0 ? "+" + parkedDelta : String(parkedDelta);

        console.log(
          "  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  OK  " +
          "📈 CYCLE " + icon + "  root_bal=" + wLabel +
          "  parked_Δ=" + delta + "  MatB=" + matBOccAfter + "/" + MSIZE
        );
      } else {
        // No cycle: just log normal status
        let occLine = "";
        try {
          const matAOcc = await matA.occupancy();
          occLine = "  MatA=" + matAOcc + "/" + MSIZE +
                    "  MatB=" + matBOccAfter + "/" + MSIZE;
        } catch (_) {}

        console.log(
          "  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  OK 🔢" + occLine
        );

        if (parkedDelta > 0) {
          newParkedThis = parkedDelta;
          console.log("    ⚠️  Parked queue grew by " + parkedDelta + " (unexpected — no cycle-out detected)");
        }
      }

      newParkedTotal += Math.max(0, parkedDelta);

    } catch (_) {
      console.log("  [" + ts() + "] " + num + "/" + COUNT + "  " + short + "  OK (state query failed)");
    }

    // ── Delay ───────────────────────────────────────────────────────────────
    if (i < COUNT - 1) {
      const delaySec = nextDelaySec();
      const wakeAt   = new Date(Date.now() + delaySec * 1000)
        .toLocaleTimeString("en-US", { hour12: false });
      const delStr   = JITTER
        ? "~" + (delaySec / 60).toFixed(1) + " min"
        : DELAY_MIN + " min";
      process.stdout.write(
        "  [" + ts() + "]  ⏳ next in " + delStr + " → " + wakeAt + "\n\n"
      );
      await sleep(delaySec);
    }

    // Watch for W1 tier upgrade
    try {
      const wt = await tr.memberHighestTier(W1_ADDR);
      if (Number(wt) > Number(w1TierInit)) {
        const tc = await tr.totalSystemCycles();
        console.log("\n  *** 🎉  W1 AUTO-UPGRADED TO T" + wt + "! System cycles: " + tc + " ***\n");
      }
    } catch (_) {}
  }

  // ── Sustainability Report ─────────────────────────────────────────────────
  const totalTime = Date.now() - startTime;

  console.log("\n  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║                SUSTAINABILITY REPORT                    ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝\n");

  console.log("  Registrations: " + registered + " OK  " + skipped + " skip  " + failed + " fail");
  console.log("  Runtime:       " + fmtDuration(totalTime));

  const selfFundedEvents = cycleEvents.filter(e => e.outcome === SELF_FUNDED);
  const parkedEvents     = cycleEvents.filter(e => e.outcome === PARKED);
  const totalCycles      = cycleEvents.length;

  console.log("\n  CYCLE-OUT EVENTS: " + totalCycles);

  if (totalCycles === 0) {
    console.log("  (No cycle-outs detected in this run — need more registrations to fill MatA)");
  } else {
    const pctSelf = ((selfFundedEvents.length / totalCycles) * 100).toFixed(0);
    const pctPark = ((parkedEvents.length / totalCycles) * 100).toFixed(0);
    const filledBars = Math.round(selfFundedEvents.length / totalCycles * 20);

    console.log("  Self-funded: " + selfFundedEvents.length + "/" + totalCycles +
      "  (" + pctSelf + "%)  " + bar(filledBars));
    console.log("  Parked:      " + parkedEvents.length + "/" + totalCycles +
      "  (" + pctPark + "%)");

    if (cycleEvents.length > 0) {
      const avgWithdrawable = cycleEvents.reduce((a, e) => a + e.withdrawable, 0n) /
        BigInt(cycleEvents.length);
      const minWithdrawable = cycleEvents.reduce((a, e) => e.withdrawable < a ? e.withdrawable : a,
        cycleEvents[0].withdrawable);
      const maxWithdrawable = cycleEvents.reduce((a, e) => e.withdrawable > a ? e.withdrawable : a,
        cycleEvents[0].withdrawable);

      console.log("\n  Root withdrawable at cycle-out:");
      console.log("    Avg: " + fmt6(avgWithdrawable));
      console.log("    Min: " + fmt6(minWithdrawable) + (minWithdrawable >= ENTRY_FEE ? "  ✅" : "  ❌ below ENTRY_FEE"));
      console.log("    Max: " + fmt6(maxWithdrawable));
      console.log("    ENTRY_FEE: " + fmt6(ENTRY_FEE));
    }

    if (parkedEvents.length > 0) {
      console.log("\n  ⚠️  PARKED roots (did not self-fund):");
      for (const e of parkedEvents.slice(0, 10)) {
        console.log("    reg #" + e.reg + "  " + e.root.slice(0,10) + "…  bal=" +
          fmt6(e.withdrawable) + "  Δparked=" + e.parkedDelta);
      }
      if (parkedEvents.length > 10) {
        console.log("    ... and " + (parkedEvents.length - 10) + " more");
      }
    }

    // Verdict
    console.log("\n  VERDICT:");
    if (parkedEvents.length === 0) {
      console.log("  ✅ SELF-SUSTAINING — 100% of cycle-outs self-funded. SF not needed.");
      console.log("     Mainnet organic growth will NOT generate a parking backlog.");
    } else if (parkedEvents.length / totalCycles < 0.05) {
      console.log("  ✅ MOSTLY SELF-SUSTAINING — <5% parking rate.");
      console.log("     SF handles rare edge cases. Mainnet SF should stay healthy.");
    } else if (parkedEvents.length / totalCycles < 0.20) {
      console.log("  ⚠️  MODERATE PARKING — " + pctPark + "% parking rate.");
      console.log("     SF will be needed regularly. Review member earnings before mainnet.");
    } else {
      console.log("  ❌ HIGH PARKING RATE — " + pctPark + "% of cycle-outs park.");
      console.log("     SF will drain faster than it earns. Investigate before mainnet.");
    }
  }

  // Final on-chain state
  console.log("\n  FINAL ON-CHAIN STATE:");
  try {
    const [matAOccF, matBOccF, parkedF, rotF, sysCycF, w1TF] = await Promise.all([
      matA.occupancy(), matB.occupancy(), matA.getParkedCount(),
      matA.rotationCount(), tr.totalSystemCycles(), tr.memberHighestTier(W1_ADDR),
    ]);

    console.log("  T1 MatA: " + matAOccF + "/" + MSIZE + "  (rotations: " + rotF + ")");
    console.log("  T1 MatB: " + matBOccF + "/" + MSIZE);
    console.log("  Parked:  " + parkedInit + " → " + parkedF +
      "  (net Δ this run: " + (Number(parkedF) - Number(parkedInit)) + ")");
    console.log("  Sys cyc: " + sysCycInit + " → " + sysCycF +
      "  (+" + (sysCycF - sysCycInit) + ")");
    console.log("  W1 tier: T" + w1TierInit + " → T" + w1TF);
  } catch (e) {
    console.log("  (state query error: " + (e.message||"").slice(0,60) + ")");
  }

  console.log("\n  Net new parked this run: " + newParkedTotal);
  if (newParkedTotal === 0) {
    console.log("  ✅ No new parks — system generating ZERO parking backlog at this pace.");
  } else {
    console.log("  ⚠️  " + newParkedTotal + " new parks detected. SF needed for rescue.");
  }

  console.log("\n  Continue with:");
  console.log("  $env:HDR_OFFSET=\"" + (HDR_OFFSET + COUNT) +
    "\"; $env:COUNT=\"200\"; npx hardhat run scripts/organic_sim.js --network baseSepolia\n");
}

main().catch(e => {
  console.error("\n  organic_sim.js fatal error:", e);
  process.exit(1);
});
