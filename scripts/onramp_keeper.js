"use strict";
/**
 * onramp_keeper.js — Onramp Partner Fee Distributor
 * ───────────────────────────────────────────────────────────────────────────
 * Polls the designated distributor wallet for incoming USDC (Transak / Ramp
 * partner fees).  When the balance exceeds the dust threshold, it approves
 * the OnrampRewardPool contract and calls distributeReward(), crediting all
 * current LP stakers pro-rata.
 *
 * Run via Windows Task Scheduler every 15 minutes (same cadence as
 * system_keeper.js).  Script exits cleanly after each run — Task Scheduler
 * handles the repeat.
 *
 * FLOW
 * ────
 *   1. Check USDC balance of DISTRIBUTOR_WALLET
 *   2. If balance < DUST_THRESHOLD_USD  →  log "nothing to distribute", exit
 *   3. Approve OnrampRewardPool for the full balance
 *   4. Call pool.distributeReward(balance)
 *   5. Send Telegram notification with amount + tx hash
 *   6. Exit 0
 *
 * ENV VARS (add to the same .env as system_keeper.js)
 * ────────────────────────────────────────────────────
 *   DISTRIBUTOR_PRIVATE_KEY    Required — private key of the wallet that
 *                              receives Transak/Ramp partner fees.
 *                              This is NOT the deployer key.
 *   ONRAMP_POOL_ADDRESS        Required — OnrampRewardPool contract address.
 *                              Set this after running deploy_onramp_pool.js.
 *   USDC_ADDRESS               USDC token address.
 *                              Defaults to reading from ADDRESSES_FILE.
 *   ADDRESSES_FILE             Deployed addresses JSON
 *                              (default: deployed_addresses_v8_22.json)
 *   DUST_THRESHOLD_USD         Minimum USD balance that triggers distribution.
 *                              (default: 1  →  $1.00 USDC)
 *   BASE_SEPOLIA_RPC_URL       RPC endpoint (default: https://sepolia.base.org)
 *   TELEGRAM_BOT_TOKEN         Telegram bot token for notifications
 *   TELEGRAM_CHAT_ID           Telegram chat ID for notifications
 *
 * USAGE
 * ─────
 *   node scripts/onramp_keeper.js
 *
 * TASK SCHEDULER COMMAND (example)
 * ──────────────────────────────────
 *   cmd /c "cd /d C:\CryptoNite-Smart-Contracts\CryptoNova && node scripts\onramp_keeper.js >> logs\onramp_keeper.log 2>&1"
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");
const https      = require("https");

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const ADDRESSES_FILE = path.join(
    __dirname, "..",
    process.env.ADDRESSES_FILE || "deployed_addresses_v8_22.json"
);
const DUST_THRESHOLD_USD = Number(process.env.DUST_THRESHOLD_USD || "1");
const DUST_THRESHOLD     = BigInt(Math.round(DUST_THRESHOLD_USD * 1_000_000)); // USDC 6 dec

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const POOL_ABI = [
    "function distributeReward(uint256 amount) external",
    "function totalStaked() view returns (uint256)",
    "function totalRewardDistributed() view returns (uint256)",
    "function DEPOSIT_UNIT() view returns (uint256)",
];

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tg(msg) {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" });
    return new Promise((resolve) => {
        const req = https.request(
            `https://api.telegram.org/bot${token}/sendMessage`,
            { method: "POST", headers: { "Content-Type": "application/json" } },
            (res) => { res.resume(); resolve(); }
        );
        req.on("error", () => resolve()); // non-fatal
        req.write(body);
        req.end();
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function usdStr(raw) {
    return "$" + (Number(raw) / 1_000_000).toFixed(2);
}

function ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
    console.log(`[${ts()}] ${msg}`);
}

// ── RPC preflight ─────────────────────────────────────────────────────────────

async function checkRpc(provider) {
    try {
        await Promise.race([
            provider.getBlockNumber(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
        ]);
        return true;
    } catch {
        return false;
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    log("onramp_keeper — start");

    // ── Validate env ──────────────────────────────────────────────────────────
    if (!process.env.DISTRIBUTOR_PRIVATE_KEY) {
        log("✗ DISTRIBUTOR_PRIVATE_KEY not set — exiting");
        process.exit(1);
    }

    // ── Pool address ──────────────────────────────────────────────────────────
    let poolAddress = process.env.ONRAMP_POOL_ADDRESS;
    if (!poolAddress) {
        // Try to read from the onramp-specific output file
        const onrampFile = path.join(__dirname, "..", "deployed_addresses_onramp_pool.json");
        if (fs.existsSync(onrampFile)) {
            poolAddress = JSON.parse(fs.readFileSync(onrampFile, "utf8")).onrampRewardPool;
        }
    }
    if (!poolAddress) {
        log("✗ ONRAMP_POOL_ADDRESS not set and deployed_addresses_onramp_pool.json not found");
        log("  Run deploy_onramp_pool.js first, then add ONRAMP_POOL_ADDRESS to .env");
        process.exit(1);
    }

    // ── USDC address ──────────────────────────────────────────────────────────
    let usdcAddress = process.env.USDC_ADDRESS;
    if (!usdcAddress) {
        if (!fs.existsSync(ADDRESSES_FILE)) {
            log(`✗ USDC_ADDRESS not set and addresses file not found: ${ADDRESSES_FILE}`);
            process.exit(1);
        }
        usdcAddress = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8")).usdc;
    }
    if (!usdcAddress) {
        log("✗ Could not determine USDC address — set USDC_ADDRESS in .env");
        process.exit(1);
    }

    // ── Provider + signer ─────────────────────────────────────────────────────
    const provider    = new ethers.JsonRpcProvider(RPC_URL);
    const distributor = new ethers.Wallet(process.env.DISTRIBUTOR_PRIVATE_KEY, provider);

    log(`  Distributor  ${distributor.address}`);
    log(`  Pool         ${poolAddress}`);
    log(`  USDC         ${usdcAddress}`);
    log(`  Dust threshold  ${usdStr(DUST_THRESHOLD)}`);

    // ── RPC health check ──────────────────────────────────────────────────────
    log("  Checking RPC connectivity…");
    const rpcOk = await checkRpc(provider);
    if (!rpcOk) {
        log("✗ RPC unreachable — skipping run (will retry next cycle)");
        process.exit(0); // soft exit, not a hard failure
    }
    log("  ✓  RPC OK");

    // ── Contracts ─────────────────────────────────────────────────────────────
    const usdc = new ethers.Contract(usdcAddress,  ERC20_ABI, distributor);
    const pool = new ethers.Contract(poolAddress,  POOL_ABI,  distributor);

    // ── Check pool has stakers ────────────────────────────────────────────────
    const totalStaked = await pool.totalStaked();
    if (totalStaked === 0n) {
        log("  No LP stakers yet — skipping distribution (funds would be locked)");
        log("  Wait for at least one LP to deposit before running this keeper");
        process.exit(0);
    }
    log(`  Total staked  ${usdStr(totalStaked)} USDC`);

    // ── Check distributor USDC balance ────────────────────────────────────────
    const balance = await usdc.balanceOf(distributor.address);
    log(`  Distributor USDC balance  ${usdStr(balance)}`);

    if (balance < DUST_THRESHOLD) {
        log(`  Below dust threshold (${usdStr(DUST_THRESHOLD)}) — nothing to distribute`);
        log("onramp_keeper — done (no action)");
        process.exit(0);
    }

    // ── Approve pool ──────────────────────────────────────────────────────────
    log(`  Approving pool for ${usdStr(balance)}…`);
    const currentAllowance = await usdc.allowance(distributor.address, poolAddress);
    if (currentAllowance < balance) {
        const approveTx = await usdc.approve(poolAddress, balance);
        await approveTx.wait();
        log(`  ✓  Approved  (tx: ${approveTx.hash})`);
    } else {
        log("  ✓  Allowance already sufficient");
    }

    // ── Call distributeReward ─────────────────────────────────────────────────
    log(`  Calling distributeReward(${usdStr(balance)})…`);
    const gas = await pool.distributeReward.estimateGas(balance).catch(() => 150_000n);
    const tx  = await pool.distributeReward(balance, {
        gasLimit: gas + gas / 4n, // 25% buffer
    });
    const receipt = await tx.wait();
    log(`  ✓  distributeReward confirmed  (tx: ${tx.hash})`);
    log(`     Gas used: ${receipt.gasUsed.toString()}`);

    // ── Stats after distribution ───────────────────────────────────────────────
    const totalDistributed = await pool.totalRewardDistributed();
    log(`  Cumulative distributed  ${usdStr(totalDistributed)}`);

    // ── Telegram notification ──────────────────────────────────────────────────
    const network = RPC_URL.includes("mainnet") ? "Base Mainnet" : "Base Sepolia";
    await tg(
        `💰 <b>OnrampRewardPool — Partner Fee Distributed</b>\n\n` +
        `Amount: <b>${usdStr(balance)}</b>\n` +
        `Total staked: ${usdStr(totalStaked)}\n` +
        `Cumulative distributed: ${usdStr(totalDistributed)}\n` +
        `Network: ${network}\n` +
        `Tx: <code>${tx.hash}</code>`
    );

    log("onramp_keeper — done ✓");
    process.exit(0);
}

main().catch((err) => {
    const msg = err?.message || String(err);
    log(`✗ onramp_keeper error: ${msg}`);
    tg(`🔴 <b>OnrampRewardPool keeper ERROR</b>\n<code>${msg}</code>`).then(() => {
        process.exit(1);
    });
});
