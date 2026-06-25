"use strict";
/**
 * test_onramp_pool.js — End-to-end testnet verification for OnrampRewardPool
 *
 * Steps:
 *   1. Check pool state (distributor, totalStaked)
 *   2. Deposit $10 USDC as LP
 *   3. Simulate a $5 partner fee arriving (distributor calls distributeReward)
 *   4. Read pending reward — should be $5 (solo LP gets 100%)
 *   5. Harvest reward — verify USDC lands in wallet
 *   6. Check final balances
 */
require("dotenv").config();
const { ethers } = require("hardhat");
const fs = require("path");

const POOL_ADDRESS = "0x387055f332C5558a2439D76FfFB4a5A3EbABc4EA";
const USDC_ADDRESS = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";

const POOL_ABI = [
    "function deposit(uint256 amount) external",
    "function harvest() external",
    "function distributeReward(uint256 amount) external",
    "function pendingReward(address lp) view returns (uint256)",
    "function staked(address) view returns (uint256)",
    "function totalStaked() view returns (uint256)",
    "function distributor() view returns (address)",
    "function lpInfo(address) view returns (uint256 stakedAmount, uint256 pendingAmount, uint256 sharePercent)",
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)",
    "function decimals() view returns (uint8)",
];

function fmt(raw) { return "$" + (Number(raw) / 1_000_000).toFixed(2); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const [deployer] = await ethers.getSigners();
    const provider   = ethers.provider;

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  OnrampRewardPool — Testnet Verification");
    console.log("══════════════════════════════════════════════════════════\n");
    console.log(`  Wallet   ${deployer.address}`);

    const pool = await ethers.getContractAt(POOL_ABI, POOL_ADDRESS, deployer);
    const usdc = await ethers.getContractAt(ERC20_ABI, USDC_ADDRESS, deployer);

    // ── Step 1: Pool state ────────────────────────────────────────────────────
    console.log("\n── Step 1: Pool state ──────────────────────────────────");
    const dist        = await pool.distributor();
    const totalStaked = await pool.totalStaked();
    const usdcBal     = await usdc.balanceOf(deployer.address);
    console.log(`  Distributor   ${dist}`);
    console.log(`  Total staked  ${fmt(totalStaked)}`);
    console.log(`  My USDC bal   ${fmt(usdcBal)}`);

    if (usdcBal < 10_000_000n) {
        console.log("\n✗ Wallet has less than $10 test USDC — mint some first");
        console.log("  Use the CryptoNova faucet or call MockUSDC.mint()");
        process.exit(1);
    }

    // ── Step 2: Deposit $10 ───────────────────────────────────────────────────
    console.log("\n── Step 2: Deposit $10 as LP ───────────────────────────");
    const depositAmt = 10_000_000n; // $10

    console.log("  Approving pool for $10…");
    const approveTx = await usdc.approve(POOL_ADDRESS, depositAmt);
    await approveTx.wait();
    console.log("  ✓ Approved");
    await sleep(4000);

    console.log("  Depositing $10…");
    const depositTx = await pool.deposit(depositAmt);
    await depositTx.wait();
    console.log(`  ✓ Deposited  (tx: ${depositTx.hash})`);
    await sleep(6000);

    const stakedAfter = await pool.staked(deployer.address);
    console.log(`  My staked:  ${fmt(stakedAfter)}`);

    // ── Step 3: Simulate $5 partner fee ───────────────────────────────────────
    console.log("\n── Step 3: Simulate $5 partner fee distribution ────────");
    const rewardAmt = 5_000_000n; // $5

    console.log("  Approving pool for $5 reward…");
    const approveRewardTx = await usdc.approve(POOL_ADDRESS, rewardAmt);
    await approveRewardTx.wait();
    console.log("  ✓ Approved");
    await sleep(4000);

    console.log("  Calling distributeReward($5)…");
    const distTx = await pool.distributeReward(rewardAmt);
    await distTx.wait();
    console.log(`  ✓ Distributed  (tx: ${distTx.hash})`);
    await sleep(6000);

    // ── Step 4: Check pending reward ──────────────────────────────────────────
    console.log("\n── Step 4: Pending reward ──────────────────────────────");
    const pending = await pool.pendingReward(deployer.address);
    console.log(`  Pending reward: ${fmt(pending)}`);

    const info = await pool.lpInfo(deployer.address);
    console.log(`  LP share:       ${(Number(info.sharePercent) / 10000).toFixed(2)}%`);

    if (pending !== rewardAmt) {
        console.log(`  ⚠ Expected ${fmt(rewardAmt)}, got ${fmt(pending)} — rounding or timing issue`);
    } else {
        console.log("  ✓ Pending reward matches distributed amount exactly");
    }

    // ── Step 5: Harvest ───────────────────────────────────────────────────────
    console.log("\n── Step 5: Harvest reward ──────────────────────────────");
    await sleep(4000);
    const balBefore = await usdc.balanceOf(deployer.address);
    const harvestTx = await pool.harvest();
    await harvestTx.wait();
    await sleep(6000);
    const balAfter  = await usdc.balanceOf(deployer.address);
    const received  = balAfter - balBefore;

    console.log(`  ✓ Harvested  (tx: ${harvestTx.hash})`);
    console.log(`  USDC received: ${fmt(received)}`);

    const pendingAfter = await pool.pendingReward(deployer.address);
    console.log(`  Pending after harvest: ${fmt(pendingAfter)}`);

    // ── Step 6: Final summary ─────────────────────────────────────────────────
    console.log("\n── Step 6: Final summary ───────────────────────────────");
    const finalStaked  = await pool.staked(deployer.address);
    const finalTotal   = await pool.totalStaked();
    const finalUsdcBal = await usdc.balanceOf(deployer.address);

    console.log(`  My staked:      ${fmt(finalStaked)}  (principal intact)`);
    console.log(`  Total staked:   ${fmt(finalTotal)}`);
    console.log(`  My USDC bal:    ${fmt(finalUsdcBal)}`);

    const allGood = received === rewardAmt && pendingAfter === 0n && finalStaked === depositAmt;
    console.log(`\n  ${allGood ? "✅  All checks passed — pool is working correctly" : "⚠  Some checks failed — review above"}`);
    console.log("\n══════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
