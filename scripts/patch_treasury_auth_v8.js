"use strict";
/**
 * patch_treasury_auth_v8.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time patch: authorize all deployed V8.1 matrices as callers on
 * CNOVATreasury.  The deploy script forgot these calls, so every
 * registration hits the `onlyMatrix` guard and silently reverts.
 *
 * Run once — idempotent (setAuthorizedCaller is a simple mapping write).
 *
 *   npx hardhat run scripts/patch_treasury_auth_v8.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(
    fs.readFileSync(path.join(__dirname, "deployed_addresses_v8_1.json"), "utf8")
  );

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const treasury = await ethers.getContractAt("CNOVATreasury", addrs.treasury, deployer);

  const matrices = [
    { label: "T1 MatA", addr: addrs.tiers.T1.matA },
    { label: "T1 MatB", addr: addrs.tiers.T1.matB },
    { label: "T2 MatA", addr: addrs.tiers.T2.matA },
    { label: "T2 MatB", addr: addrs.tiers.T2.matB },
  ];

  for (const { label, addr } of matrices) {
    const already = await treasury.authorizedCallers(addr);
    if (already) {
      console.log(`  ✓ ${label} (${addr.slice(0,10)}) already authorized — skip`);
    } else {
      await (await treasury.setAuthorizedCaller(addr, true)).wait();
      console.log(`  ✓ ${label} (${addr.slice(0,10)}) authorized`);
    }
  }

  console.log("\n  All matrices authorized on CNOVATreasury. Ready to re-run bigfill.");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
