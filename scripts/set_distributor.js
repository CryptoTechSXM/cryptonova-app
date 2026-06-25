"use strict";
/**
 * set_distributor.js — Wire distributor wallet into OnrampRewardPool
 * One-off fix script (run after deploy_onramp_pool.js if setDistributor tx failed).
 */
require("dotenv").config();
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
    const addrFile = path.join(__dirname, "..", "deployed_addresses_onramp_pool.json");
    const addrs    = JSON.parse(fs.readFileSync(addrFile, "utf8"));

    const poolAddress   = addrs.onrampRewardPool;
    const distributorWallet = addrs.distributorWallet;

    const [deployer] = await ethers.getSigners();
    console.log(`Deployer:    ${deployer.address}`);
    console.log(`Pool:        ${poolAddress}`);
    console.log(`Distributor: ${distributorWallet}`);

    const pool = await ethers.getContractAt("OnrampRewardPool", poolAddress, deployer);
    const current = await pool.distributor();
    console.log(`Current distributor: ${current || "(not set)"}`);

    if (current.toLowerCase() === distributorWallet.toLowerCase()) {
        console.log("✓ Already set — nothing to do.");
        return;
    }

    console.log("Setting distributor…");
    const tx = await pool.setDistributor(distributorWallet);
    await tx.wait();
    console.log(`✓ Done  (tx: ${tx.hash})`);

    const confirmed = await pool.distributor();
    console.log(`Confirmed distributor: ${confirmed}`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
