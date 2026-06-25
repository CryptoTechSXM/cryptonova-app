"use strict";
/**
 * deploy_onramp_pool.js — Deploy OnrampRewardPool (standalone)
 * ─────────────────────────────────────────────────────────────
 * Deploys the OnrampRewardPool contract and optionally sets the distributor
 * wallet.  Completely independent of deploy_v8.js — can be run before or
 * after the main protocol deploy.
 *
 * WHAT IT DEPLOYS
 * ───────────────
 *   OnrampRewardPool  — USDC LP staking pool that distributes Transak/Ramp
 *                       partner-fee revenue pro-rata to liquidity providers.
 *
 * WIRING AFTER DEPLOY
 * ───────────────────
 *   1. In your Transak / Ramp Network partner dashboard, set the "partner fee
 *      recipient" wallet to the DISTRIBUTOR_WALLET address (the wallet that
 *      will receive on-ramp partner fees).
 *   2. Fund that wallet with a small amount of ETH for gas.
 *   3. Run onramp_keeper.js (via Task Scheduler) so it polls the distributor
 *      wallet balance and calls distributeReward() automatically.
 *
 * USAGE
 * ─────
 *   node scripts/deploy_onramp_pool.js
 *
 *   # Optionally point at a different addresses file:
 *   ADDRESSES_FILE=deployed_addresses_v8_22.json node scripts/deploy_onramp_pool.js
 *
 * ENV VARS
 * ────────
 *   DEPLOYER_PRIVATE_KEY     Required — deployer / owner of the pool contract
 *   USDC_ADDRESS             Override USDC address (else read from ADDRESSES_FILE)
 *   ADDRESSES_FILE           Path to existing deployed-addresses JSON
 *                            (default: deployed_addresses_v8_22.json)
 *   DISTRIBUTOR_WALLET       Wallet that will receive Transak partner fees and
 *                            call distributeReward().  If omitted, defaults to
 *                            deployer (you can setDistributor() later on-chain).
 *   BASE_SEPOLIA_RPC_URL     RPC endpoint (default: https://sepolia.base.org)
 *   NETWORK                  "mainnet" to use Base mainnet RPC
 *
 * OUTPUT
 *   Writes deployed_addresses_onramp_pool.json to the CryptoNova directory.
 */

require("dotenv").config();
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────

const ADDRESSES_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_22.json";
const OUT_FILE       = "deployed_addresses_onramp_pool.json";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  OnrampRewardPool — Deploy");
    console.log("══════════════════════════════════════════════════════════\n");

    // ── Signer ────────────────────────────────────────────────────────────────
    if (!process.env.DEPLOYER_PRIVATE_KEY) {
        throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
    }

    const provider = ethers.provider;
    const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    console.log(`  Deployer   ${deployer.address}`);

    const balance = await provider.getBalance(deployer.address);
    console.log(`  ETH balance  ${ethers.formatEther(balance)} ETH`);
    if (balance === 0n) throw new Error("Deployer has no ETH for gas");

    // ── USDC address ──────────────────────────────────────────────────────────
    let usdcAddress = process.env.USDC_ADDRESS;

    if (!usdcAddress) {
        const addrPath = path.join(__dirname, "..", ADDRESSES_FILE);
        if (!fs.existsSync(addrPath)) {
            throw new Error(
                `USDC_ADDRESS not set and addresses file not found: ${addrPath}\n` +
                "Set USDC_ADDRESS in your .env or specify ADDRESSES_FILE."
            );
        }
        const addrs = JSON.parse(fs.readFileSync(addrPath, "utf8"));
        usdcAddress = addrs.usdc;
        if (!usdcAddress) throw new Error(`'usdc' key missing from ${ADDRESSES_FILE}`);
        console.log(`  USDC       ${usdcAddress}  (from ${ADDRESSES_FILE})`);
    } else {
        console.log(`  USDC       ${usdcAddress}  (from env)`);
    }

    // ── Distributor wallet ────────────────────────────────────────────────────
    const distributorWallet = process.env.DISTRIBUTOR_WALLET || deployer.address;
    const isDefaultDist     = distributorWallet === deployer.address;
    console.log(
        `  Distributor  ${distributorWallet}` +
        (isDefaultDist ? "  ⚠ defaulting to deployer — update with setDistributor() later" : "")
    );

    // ── Deploy OnrampRewardPool ───────────────────────────────────────────────
    console.log("\n── Deploying OnrampRewardPool ──────────────────────────");
    const Pool = await ethers.getContractFactory("OnrampRewardPool", deployer);
    const pool = await Pool.deploy(usdcAddress, deployer.address);
    await pool.waitForDeployment();
    const poolAddress = await pool.getAddress();
    console.log(`  ✓  OnrampRewardPool  ${poolAddress}`);

    // ── Set distributor ───────────────────────────────────────────────────────
    if (distributorWallet !== deployer.address) {
        console.log("\n── Setting distributor ─────────────────────────────────");
        const tx = await pool.setDistributor(distributorWallet);
        await tx.wait();
        console.log(`  ✓  Distributor set to ${distributorWallet}`);
    }

    // ── Verify constants ──────────────────────────────────────────────────────
    console.log("\n── Verifying deployment ────────────────────────────────");
    const depositUnit = await pool.DEPOSIT_UNIT();
    const storedDist  = await pool.distributor();
    const storedUsdc  = await pool.usdc();
    console.log(`  DEPOSIT_UNIT  ${depositUnit.toString()}  ($${Number(depositUnit) / 1e6})`);
    console.log(`  distributor   ${storedDist || "(owner only)"}`);
    console.log(`  usdc          ${storedUsdc}`);
    if (storedUsdc.toLowerCase() !== usdcAddress.toLowerCase()) {
        throw new Error("USDC address mismatch — deployment may be corrupt");
    }
    console.log("  ✓  All checks passed");

    // ── Write output file ─────────────────────────────────────────────────────
    const outPath = path.join(__dirname, "..", OUT_FILE);
    const existing = fs.existsSync(outPath)
        ? JSON.parse(fs.readFileSync(outPath, "utf8"))
        : {};

    const out = {
        ...existing,
        network:          (await provider.getNetwork()).name,
        deployedAt:       new Date().toISOString(),
        onrampRewardPool: poolAddress,
        distributorWallet,
        usdc:             usdcAddress,
        owner:            deployer.address,
    };
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n  ✓  Addresses written → ${OUT_FILE}`);

    // ── Next steps ────────────────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  NEXT STEPS");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`
  1. Add to .env:
       ONRAMP_POOL_ADDRESS=${poolAddress}
       DISTRIBUTOR_WALLET=${distributorWallet}

  2. In Transak / Ramp partner dashboard:
       Set "partner fee recipient" to: ${distributorWallet}

  3. Fund distributor wallet with ETH for gas (a few dollars worth)

  4. Schedule onramp_keeper.js via Task Scheduler (every 15 min)
       The keeper will auto-detect incoming USDC and call distributeReward()

  5. Community members can now deposit USDC at multiples of $10 to start
     earning partner-fee yield.
`);
}

main().catch((err) => {
    console.error("\n✗ Deploy failed:", err.message || err);
    process.exit(1);
});
