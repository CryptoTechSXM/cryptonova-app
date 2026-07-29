/**
 * patch_roles_v8_28.js
 * Completes the two calls skipped by fix_wiring_v8_28.js due to RPC rate limits:
 *   1. CommunityWallet.setEnrollor(TierRouter)
 *   2. CNOVAToken.grantRole(DIRECT_SALE_ROLE, CNOVADirectSale)
 *
 * Run:
 *   npx hardhat run scripts/patch_roles_v8_28.js --network baseSepolia
 */

const { ethers } = require("hardhat");
require("dotenv").config();

const CW_ADDR  = "0x87E47De24c44A3BB23601D39195c81e24d3899dA";
const TR_ADDR  = "0x4CAEf2333c4473f5ceFD05879D9578568B700475";
const CNOVA    = "0x5eFe45CC9A902c2d8Cae97Eec22BF10629e0FF47";
const DS_ADDR  = "0x7aB46E77c1da6C16cC625ef2B5a2e0354c4094Bc";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n── patch_roles_v8_28.js ─────────────────────────────────────────");
  console.log(`  Deployer : ${deployer.address}\n`);

  const cw    = await ethers.getContractAt("CommunityWallet", CW_ADDR,  deployer);
  const cnova = await ethers.getContractAt("CNOVAToken",      CNOVA,    deployer);

  // 1. CommunityWallet.setEnrollor(TierRouter)
  console.log("[1] CommunityWallet.setEnrollor(TierRouter)...");
  const tx1 = await cw.setEnrollor(TR_ADDR);
  await tx1.wait();
  console.log("  ✓  setEnrollor OK");
  await sleep(3000);

  // 2. CNOVAToken.grantRole(DIRECT_SALE_ROLE, CNOVADirectSale)
  console.log("[2] CNOVAToken.grantRole(DIRECT_SALE_ROLE, CNOVADirectSale)...");
  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  const tx2 = await cnova.grantRole(DIRECT_SALE_ROLE, DS_ADDR);
  await tx2.wait();
  console.log("  ✓  DIRECT_SALE_ROLE granted");

  console.log("\n  V8.28 roles fully patched. Run seed_w1.js next.");
  console.log("─────────────────────────────────────────────────────────────────\n");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
