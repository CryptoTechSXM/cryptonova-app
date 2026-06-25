"use strict";
/**
 * diagnose_parked.js — Inspect each parked member's state and surface
 * the exact coPayRescue revert reason via callStatic.
 *
 * Run:
 *   npx hardhat run scripts/diagnose_parked.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname, "..",
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_22.json"
);

const MAT_ABI = [
  "function getParkedCount() external view returns (uint256)",
  "function getParkedMember(uint256 idx) external view returns (address)",
  "function isParked(address) external view returns (bool)",
  "function withdrawableOf(address) external view returns (uint256)",
  "function ENTRY_FEE() external view returns (uint256)",
  "function coPayRescue(address member) external",
  "function topUpAndCross(address member) external",
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function stabilityFloor() external view returns (uint256)",
];

const fmt6 = n => "$" + (Number(n) / 1e6).toFixed(2);

async function main() {
  const addrs   = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const matAAddr = addrs.tiers.T1.matA;
  const sfAddr   = addrs.stabilityFund;
  const usdcAddr = addrs.usdc;

  const matA = new ethers.Contract(matAAddr, MAT_ABI,   deployer);
  const sf   = new ethers.Contract(sfAddr,   SF_ABI,    deployer);
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, deployer);

  console.log("=== Parked Member Diagnostics ===");
  console.log(`Deployer : ${deployer.address}`);
  console.log(`T1 MatA  : ${matAAddr}`);
  console.log(`SF       : ${sfAddr}`);
  console.log();

  // ethers version
  const ethersVersion = ethers.version ?? require("ethers").version ?? "unknown";
  console.log(`ethers version: ${ethersVersion}`);
  console.log();

  const entryFee = await matA.ENTRY_FEE();
  const sfBal    = await sf.totalBalance();
  const sfFloor  = await sf.stabilityFloor();
  const deployerUSDC = await usdc.balanceOf(deployer.address);
  const deployerAllow = await usdc.allowance(deployer.address, matAAddr);

  console.log(`Entry fee       : ${fmt6(entryFee)}`);
  console.log(`SF balance      : ${fmt6(sfBal)}`);
  console.log(`SF floor        : ${fmt6(sfFloor)}`);
  console.log(`Deployer USDC   : ${fmt6(deployerUSDC)}`);
  console.log(`Deployer→MatA allowance: ${fmt6(deployerAllow)}`);
  console.log();

  const parkedCount = await matA.getParkedCount();
  console.log(`Parked count    : ${parkedCount}`);
  console.log();

  for (let i = 0; i < Number(parkedCount); i++) {
    const addr = await matA.getParkedMember(i);
    const w    = await matA.withdrawableOf(addr);
    const isP  = await matA.isParked(addr);

    // Compute callerShare (same formula as coPayRescue in MatrixLogicLib.sol)
    const sfShare   = w / 2n;
    const shortfall = entryFee > w ? entryFee - w : 0n;
    const callShare = shortfall > sfShare ? shortfall - sfShare : 0n;

    console.log(`Member [${i}]: ${addr}`);
    console.log(`  withdrawable : ${fmt6(w)}  (raw: ${w})`);
    console.log(`  isParked     : ${isP}`);
    console.log(`  sfShare      : ${fmt6(sfShare)}  shortfall: ${fmt6(shortfall)}  callerShare: ${fmt6(callShare)}`);

    // Try coPayRescue via callStatic / staticCall
    console.log(`  coPayRescue callStatic...`);
    try {
      // ethers v6
      if (matA.coPayRescue.staticCall) {
        await matA.coPayRescue.staticCall(addr);
        console.log(`    ✅ staticCall SUCCEEDED (no revert)`);
      } else {
        // ethers v5
        await matA.callStatic.coPayRescue(addr);
        console.log(`    ✅ callStatic SUCCEEDED (no revert)`);
      }
    } catch (e) {
      console.log(`    ❌ REVERTED`);
      console.log(`       errorName : ${e.errorName  ?? "null"}`);
      console.log(`       reason    : ${e.reason     ?? "null"}`);
      console.log(`       code      : ${e.code       ?? "null"}`);
      console.log(`       data      : ${typeof e.data === "string" ? e.data.slice(0, 200) : JSON.stringify(e.data)}`);
      console.log(`       message   : ${e.message?.slice(0, 300)}`);
    }

    // Try topUpAndCross via callStatic as fallback check
    console.log(`  topUpAndCross callStatic...`);
    try {
      if (matA.topUpAndCross.staticCall) {
        await matA.topUpAndCross.staticCall(addr);
        console.log(`    ✅ staticCall SUCCEEDED`);
      } else {
        await matA.callStatic.topUpAndCross(addr);
        console.log(`    ✅ callStatic SUCCEEDED`);
      }
    } catch (e) {
      console.log(`    ❌ REVERTED: ${e.reason ?? e.errorName ?? e.message?.slice(0, 120)}`);
    }

    console.log();
  }
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
