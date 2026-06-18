"use strict";
/**
 * run_keeper.js — manually trigger MatrixKeeper.performUpkeep() until drained
 *
 * Calls checkUpkeep() to get pending work items, then calls performUpkeep()
 * using the funder wallet (no deployer / no rate limit).
 * performUpkeep has no access control — anyone can call it.
 *
 * The keeper rescues parked wallets by pulling funds from StabilityFund
 * (not from deployer/funder wallet) so no USDC approval needed.
 *
 * Usage: npx hardhat run scripts/run_keeper.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs          = require("fs");
const path        = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_6.json"
);
const MAX_ROUNDS = 50; // safety cap
const sleep = s => new Promise(r => setTimeout(r, s * 1000));

async function main() {
  const signers  = await ethers.getSigners();
  const rawFunder = signers[1] || signers[0];

  const addrs      = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const keeperAddr = addrs.matrixKeeper || addrs.MatrixKeeper;
  const sfAddr     = addrs.stabilityFund;
  const usdcAddr   = addrs.usdc || addrs.USDC;

  if (!keeperAddr) {
    console.error("❌  matrixKeeper address not found in addresses file.");
    process.exit(1);
  }

  const keeper = await ethers.getContractAt("MatrixKeeper",  keeperAddr, rawFunder);
  const usdc   = await ethers.getContractAt("MockUSDC",      usdcAddr);

  console.log(`\nMatrixKeeper: ${keeperAddr}`);
  console.log(`Caller:       ${rawFunder.address}  (funder — no owner required)`);

  // Show SF T1 balance before
  if (sfAddr) {
    const sf = await ethers.getContractAt("StabilityFund", sfAddr);
    const sfT1 = await sf.balanceByTier(0);
    const sfTotal = await sf.totalBalance();
    console.log(`SF totalBalance: $${Number(sfTotal)/1e6}`);
    console.log(`SF T1 balance:   $${Number(sfT1)/1e6}  (T1 fee = $10 → up to ${Number(sfT1)/10e6 | 0} rescues)`);
  }
  console.log("");

  let round = 0;
  let totalRescued = 0;

  while (round < MAX_ROUNDS) {
    round++;
    console.log(`─── Round ${round} ────────────────────────────────────────────`);

    // checkUpkeep
    let upkeepNeeded, performData;
    try {
      ({ upkeepNeeded, performData } = await keeper.checkUpkeep("0x"));
    } catch(e) {
      console.error(`  checkUpkeep failed: ${e.message.slice(0,120)}`);
      break;
    }

    if (!upkeepNeeded) {
      console.log("  ✓ checkUpkeep returned false — no pending work.");
      break;
    }

    // Decode and display items
    const WorkItemType = ["(uint8,uint8,address,address)[]"];
    let items;
    try {
      [items] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["(uint8 workType,uint8 tierIdx,address addr1,address addr2)[]"],
        performData
      );
    } catch(e) {
      // raw decode attempt
      items = null;
    }
    if (items) {
      const WORK_NAMES = {0:"VELOCITY",1:"GHOST",2:"RECLAIM",3:"?",4:"PARKED_RESCUE",5:"VEL_GATE"};
      for (const item of items) {
        const wt = Number(item.workType);
        console.log(`  item: ${WORK_NAMES[wt]||wt}  tier=${item.tierIdx}  addr=${item.addr2?.slice(0,12)||item.addr1?.slice(0,12)}`);
      }
    }

    // performUpkeep
    console.log(`  Calling performUpkeep…`);
    try {
      const tx = await keeper.performUpkeep(performData, { gasLimit: 15_000_000 });
      const receipt = await tx.wait();
      console.log(`  ✓ TX: ${receipt.hash.slice(0,14)}  gas: ${receipt.gasUsed}`);

      // Count ParkedRescued events
      const rescued = receipt.logs.filter(l => {
        try {
          const parsed = keeper.interface.parseLog(l);
          return parsed?.name === "ParkedRescued";
        } catch { return false; }
      }).length;
      if (rescued > 0) {
        totalRescued += rescued;
        console.log(`  🎉 ${rescued} wallets rescued this round  (total: ${totalRescued})`);
      }
    } catch(e) {
      console.error(`  ❌ performUpkeep failed: ${e.message.slice(0,120)}`);
      break;
    }

    await sleep(3); // let chain state settle
  }

  // Final SF balance
  if (sfAddr) {
    const sf = await ethers.getContractAt("StabilityFund", sfAddr);
    const sfT1 = await sf.balanceByTier(0);
    const sfTotal = await sf.totalBalance();
    console.log(`\nSF totalBalance after: $${Number(sfTotal)/1e6}`);
    console.log(`SF T1 balance after:   $${Number(sfT1)/1e6}`);
  }

  console.log(`\n✓ Done. Total rescued: ${totalRescued}`);
  console.log(`  T1 MatB is now receiving parked wallets.`);
  console.log(`  Run bigfill_v8.js with more wallets to keep filling.`);
}

main().catch(e => { console.error(e); process.exit(1); });
