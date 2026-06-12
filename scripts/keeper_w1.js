"use strict";
/**
 * keeper_w1.js — Account #1 Self-Funding Keeper Bot
 * ─────────────────────────────────────────────────────────────────────────────
 * Monitors Account #1's ETH balance (needed for gas on all transactions).
 * When ETH drops below the critical threshold:
 *   1. Withdraws earned USDC from Matrix A and Matrix B
 *   2. Swaps USDC → ETH via Aerodrome DEX (mainnet) or signals (testnet)
 *   3. Account #1 is now refuelled and can keep signing transactions
 *
 * VISION: Once Universe Mode activates (500+ members), this bot runs forever
 * without any human involvement. Account #1 earns USDC from orphan fees
 * continuously, the bot converts just enough to cover gas, and the system
 * sustains itself as long as participation stays above 40%.
 *
 * RUN ONCE:
 *   npx hardhat run scripts/keeper_w1.js --network baseSepolia
 *
 * RUN ON SCHEDULE (cron — every 6 hours):
 *   0 *\/6 * * * cd /path/to/project && npx hardhat run scripts/keeper_w1.js --network baseSepolia
 *
 * Or use the Cowork scheduled task to run this automatically.
 */

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
// W1 address derived from private key — works automatically after any key rotation
if (!process.env.W1_PRIVATE_KEY) { console.error("W1_PRIVATE_KEY missing"); process.exit(1); }
const W1_ADDRESS = new ethers.Wallet(process.env.W1_PRIVATE_KEY).address;

// ─── Health thresholds ────────────────────────────────────────────────────────
const ETH_CRITICAL   = ethers.parseEther("0.005");   // below this → act NOW
const ETH_TARGET     = ethers.parseEther("0.02");    // refuel to this level
const USDC_MIN_SWAP  = 5_000_000n;                   // don't swap less than $5 USDC

// ─── Aerodrome router on Base mainnet ─────────────────────────────────────────
// Uniswap V2-compatible interface. Same ABI works for Aerodrome on Base.
const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const WETH_BASE        = "0x4200000000000000000000000000000000000006";

// ─── Testnet detection ────────────────────────────────────────────────────────
const TESTNET_CHAIN_IDS = [84532, 97, 31337]; // Base Sepolia, BSC Testnet, Hardhat

const SWAP_ABI = [
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"
];

// ─── Formatting helpers ───────────────────────────────────────────────────────
const fmt6  = n  => "$" + (Number(n) / 1e6).toFixed(4);
const fmtE  = n  => Number(ethers.formatEther(n)).toFixed(6) + " ETH";
const stamp = () => new Date().toISOString();

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("  deployed_addresses.json not found — run deploy_figure8_test.js first");
    process.exit(1);
  }
  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const isTestnet = TESTNET_CHAIN_IDS.includes(chainId);

  console.log(`\n  ╔══════════════════════════════════════════════════════╗`);
  console.log(`  ║         Account #1 — Keeper Health Check             ║`);
  console.log(`  ╚══════════════════════════════════════════════════════╝`);
  console.log(`  Timestamp: ${stamp()}`);
  console.log(`  Network:   ${network.name} (chain ${chainId}) ${isTestnet ? "— TESTNET" : "— MAINNET"}`);
  console.log(`  Account:   ${W1_ADDRESS}`);

  // ─── Load contracts ──────────────────────────────────────────────────────
  const matA = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const usdc  = await ethers.getContractAt(
    isTestnet ? "MockUSDC" : "IERC20",
    addrs.USDC
  );

  // ─── Read current state ───────────────────────────────────────────────────
  const ethBalance    = await ethers.provider.getBalance(W1_ADDRESS);
  const earnedA       = (await matA.getMember(W1_ADDRESS)).withdrawable;
  const earnedB       = (await matB.getMember(W1_ADDRESS)).withdrawable;
  const escrowA       = await matA.escrowOf(W1_ADDRESS);
  const escrowB       = await matB.escrowOf(W1_ADDRESS);
  const totalEarned   = earnedA + earnedB;
  const totalEscrow   = escrowA + escrowB;

  console.log(`\n  ── HEALTH SNAPSHOT ──────────────────────────────────`);
  console.log(`  ETH balance:      ${fmtE(ethBalance)}`);
  console.log(`  USDC withdrawable:${fmt6(totalEarned)}  (MatA: ${fmt6(earnedA)}  MatB: ${fmt6(earnedB)})`);
  console.log(`  USDC escrow:      ${fmt6(totalEscrow)}  (crossing fund — do not swap)`);

  const ethStatus =
    ethBalance >= ETH_TARGET   ? "✅ HEALTHY" :
    ethBalance >= ETH_CRITICAL ? "⚠️  LOW — action soon" :
                                  "🚨 CRITICAL — acting now";

  console.log(`\n  ETH status:  ${ethStatus}`);
  console.log(`  USDC status: ${totalEarned >= USDC_MIN_SWAP ? "✅ has swappable balance" : "⚠️  low (waiting to accumulate)"}`);

  // ─── No action needed ─────────────────────────────────────────────────────
  if (ethBalance >= ETH_TARGET) {
    console.log(`\n  ✅  No action needed. Next check in 6 hours.`);
    _writelog({ timestamp: stamp(), chainId, ethBalance: fmtE(ethBalance), action: "none", status: "healthy" });
    return;
  }

  // ─── Action: need to refuel ETH ───────────────────────────────────────────
  const ethDeficit  = ETH_TARGET - ethBalance;
  const needSwapUsdc = BigInt(Math.ceil(Number(ethDeficit) / 1e18 * 2600 * 1e6)); // rough: $2600/ETH

  console.log(`\n  ── ACTION: REFUEL ETH ─────────────────────────────`);
  console.log(`  ETH deficit:      ${fmtE(ethDeficit)}`);
  console.log(`  USDC to swap:     ~${fmt6(needSwapUsdc)} (estimate at $2600/ETH)`);

  if (totalEarned < USDC_MIN_SWAP) {
    console.log(`\n  ⚠️  Not enough USDC to swap yet (${fmt6(totalEarned)} < ${fmt6(USDC_MIN_SWAP)} minimum)`);
    console.log(`  Waiting for more orphan fees to accumulate.`);
    console.log(`  As more members join without referrers, W1 earns 20% of their fees.`);
    _writelog({ timestamp: stamp(), chainId, ethBalance: fmtE(ethBalance), action: "waiting", reason: "insufficient_usdc" });
    return;
  }

  // Load W1 signer
  if (!process.env.W1_PRIVATE_KEY) {
    console.error(`\n  ❌  W1_PRIVATE_KEY not in .env — cannot sign withdrawal`);
    process.exit(1);
  }
  const w1 = new ethers.Wallet(process.env.W1_PRIVATE_KEY, ethers.provider);

  // ─── Step 1: Withdraw earned USDC from both matrices ─────────────────────
  const usdcToWithdraw = earnedA + earnedB;

  if (earnedA > 0n) {
    console.log(`\n  Withdrawing ${fmt6(earnedA)} from Matrix A...`);
    await (await matA.connect(w1).withdraw()).wait();
    console.log(`  ✓ Matrix A withdrawal complete`);
  }
  if (earnedB > 0n) {
    console.log(`  Withdrawing ${fmt6(earnedB)} from Matrix B...`);
    await (await matB.connect(w1).withdraw()).wait();
    console.log(`  ✓ Matrix B withdrawal complete`);
  }

  const usdcBalance = await usdc.balanceOf(W1_ADDRESS);
  console.log(`  W1 USDC wallet balance: ${fmt6(usdcBalance)}`);

  // ─── Step 2: Swap USDC → ETH ─────────────────────────────────────────────
  if (isTestnet) {
    // ── TESTNET: can't use real DEX — log what would happen and request manual top-up
    console.log(`\n  ── TESTNET MODE ─────────────────────────────────────`);
    console.log(`  On mainnet this would swap ${fmt6(usdcBalance)} USDC → ETH via Aerodrome`);
    console.log(`  On testnet DEX not available — requesting manual ETH top-up from deployer...`);

    const [deployer] = await ethers.getSigners();
    const deployerEth = await ethers.provider.getBalance(deployer.address);
    if (deployerEth > ETH_TARGET * 2n) {
      console.log(`  Deployer sending ${fmtE(ETH_TARGET)} to W1...`);
      await (await deployer.sendTransaction({ to: W1_ADDRESS, value: ETH_TARGET })).wait();
      await new Promise(r => setTimeout(r, 4000));
      const newBal = await ethers.provider.getBalance(W1_ADDRESS);
      console.log(`  ✅  W1 ETH balance: ${fmtE(newBal)}`);
    } else {
      console.log(`  ⚠️  Deployer also low on testnet ETH. Get more from faucet:`);
      console.log(`  https://faucet.quicknode.com/base/sepolia`);
    }
  } else {
    // ── MAINNET: real Aerodrome swap ──────────────────────────────────────
    console.log(`\n  ── MAINNET SWAP: USDC → ETH via Aerodrome ───────────`);
    const router = new ethers.Contract(AERODROME_ROUTER, SWAP_ABI, w1);

    // Estimate output: how much ETH for our USDC
    const swapAmount  = usdcBalance < needSwapUsdc ? usdcBalance : needSwapUsdc;
    const path        = [addrs.USDC, WETH_BASE];
    const amountsOut  = await router.getAmountsOut(swapAmount, path);
    const expectedEth = amountsOut[1];
    const minEth      = expectedEth * 95n / 100n;  // 5% slippage tolerance

    console.log(`  Swapping:     ${fmt6(swapAmount)} USDC`);
    console.log(`  Expected ETH: ${fmtE(expectedEth)}`);
    console.log(`  Min ETH (5%): ${fmtE(minEth)}`);

    // Approve router
    await (await usdc.connect(w1).approve(AERODROME_ROUTER, swapAmount)).wait();
    console.log(`  ✓ Router approved`);

    // Execute swap
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
    const swapTx   = await router.swapExactTokensForETH(
      swapAmount, minEth, path, W1_ADDRESS, deadline
    );
    const receipt  = await swapTx.wait();
    console.log(`  ✓ Swap complete! tx: ${receipt.hash}`);

    const finalEth = await ethers.provider.getBalance(W1_ADDRESS);
    console.log(`  W1 ETH balance: ${fmtE(finalEth)}`);
  }

  // ─── Step 3: Stall detection — inject from Protocol Reserve if needed ────────
  // Trigger: no rotation for STALL_DAYS days (default 30, configurable)
  const STALL_DAYS = parseInt(process.env.STALL_DAYS || "30");

  if (addrs.PairManager) {
    try {
      const pm = await ethers.getContractAt("PairManager", addrs.PairManager);
      const [partPct, combined, total] = await pm.systemParticipationPct();
      const [daysSince] = await pm.daysSinceLastActivity();
      const daysNum = Number(daysSince);

      console.log(`\n  ── SYSTEM HEALTH ─────────────────────────────────────`);
      console.log(`  Combined occupancy: ${combined}/${total} (${partPct}%)`);
      console.log(`  Days since last rotation: ${daysNum} / ${STALL_DAYS} day threshold`);
      console.log(`  Status: ${daysNum >= STALL_DAYS ? '⚠️  STALLED' : daysNum > STALL_DAYS/2 ? '⚠️  Slowing' : '✅ Active'}`);

      // Inject when EITHER: no activity for STALL_DAYS OR occupancy below 40%
      const needsBoost = daysNum >= STALL_DAYS || (Number(total) > 0 && Number(partPct) < 40);

      if (needsBoost) {
        console.log(`  ⚡  BOOST NEEDED — injecting from Protocol Reserve...`);

        // Check Protocol Reserve has USDC
        const protoWallet = process.env.PROTOCOL_WALLET_ADDRESS || deployer.address;
        const protoUsdc   = await usdc.balanceOf(protoWallet);
        const injectCount = Math.min(5, Math.floor(Number(protoUsdc) / 10_000_000));

        if (injectCount > 0) {
          console.log(`  Injecting ${injectCount} member(s) to boost participation...`);
          const protocolSigner = deployer; // on mainnet: separate protocol wallet signer

          for (let i = 0; i < injectCount; i++) {
            const w = ethers.Wallet.createRandom().connect(ethers.provider);
            await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.005") })).wait();
            await (await usdc.connect(deployer).mint(w.address, FEE * 2n)).wait();
            await (await usdc.connect(w).approve(addrs.PairManager, FEE)).wait();
            const pmContract = await ethers.getContractAt("PairManager", addrs.PairManager, w);
            await (await pmContract.register(W1_ADDRESS)).wait();
            console.log(`  ✓ Injected member ${i+1}/${injectCount}`);
          }

          const [newPct] = await pm.systemParticipationPct();
          console.log(`  New participation: ${newPct}%`);
        } else {
          console.log(`  ⚠️  Protocol Reserve insufficient USDC — manual top-up needed`);
        }
      }
    } catch(e) {
      console.log(`  participation check skipped: ${e.shortMessage || e.message}`);
    }
  }

  // ─── Final status ─────────────────────────────────────────────────────────
  const finalEth  = await ethers.provider.getBalance(W1_ADDRESS);
  const finalUsdc = await usdc.balanceOf(W1_ADDRESS);

  console.log(`\n  ── POST-ACTION STATUS ───────────────────────────────`);
  console.log(`  ETH:  ${fmtE(finalEth)}`);
  console.log(`  USDC: ${fmt6(finalUsdc)}`);
  console.log(`  ${finalEth >= ETH_CRITICAL ? "✅  Account #1 is healthy — autopilot continues" : "⚠️  ETH still low — check again soon"}`);

  _writelog({
    timestamp:   stamp(),
    chainId,
    ethBefore:   fmtE(ethBalance),
    ethAfter:    fmtE(finalEth),
    usdcSwapped: fmt6(usdcToWithdraw),
    action:      "refuelled",
    status:      finalEth >= ETH_CRITICAL ? "healthy" : "still_low"
  });
}

// ─── Simple log writer ────────────────────────────────────────────────────────
function _writelog(entry) {
  const logFile = path.join(__dirname, "keeper_w1_log.json");
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logFile, "utf8")); } catch(_) {}
  log.push(entry);
  // Keep last 100 entries
  if (log.length > 100) log = log.slice(-100);
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
