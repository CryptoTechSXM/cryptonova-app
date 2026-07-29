"use strict";
/**
 * diag_lavern2.js — check T1 PairManager for all pairs, check if Lavern was recently rescued
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const LAVERN = "0x728ff08035fffbc5a2f512a081cc88a4221f5f00";

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

const PM_ABI = [
  "function allPairsStatus() view returns (address[] matAs, address[] matBs, uint256[] matAOcc, uint256[] matBOcc, uint256[] matARot, uint256[] matBRot)",
  "function pairCount() view returns (uint256)",
];
const MAT_ABI = [
  "function hasEverJoined(address) view returns (bool)",
  "function isActiveInMatrix(address) view returns (bool)",
  "function parkedAt(address) view returns (uint256)",
  "function isParked(address) view returns (bool)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function entryFee() view returns (uint256)",
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [signer] = await ethers.getSigners();
  const provider = signer.provider;

  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, provider);
  const pm   = new ethers.Contract(addrs.tiers.T1.pm, PM_ABI, provider);

  console.log("=== T1 PairManager — all pairs ===");
  console.log(`PM: ${addrs.tiers.T1.pm}`);

  const [matAs, matBs, matAOccs, matBOccs, matARots, matBRots] = await pm.allPairsStatus();
  console.log(`\nTotal pairs: ${matAs.length}`);

  const usdcBal = await usdc.balanceOf(LAVERN);
  console.log(`\nLavern USDC balance: $${(Number(usdcBal)/1e6).toFixed(4)}`);
  console.log(`Lavern wallet: ${LAVERN}\n`);

  for (let i = 0; i < matAs.length; i++) {
    const matAAddr = matAs[i];
    const matBAddr = matBs[i];
    console.log(`--- Pair ${i+1} ---`);
    console.log(`  MatA: ${matAAddr}  occ=${matAOccs[i]}  rot=${matARots[i]}`);
    console.log(`  MatB: ${matBAddr}  occ=${matBOccs[i]}  rot=${matBRots[i]}`);

    // Check Lavern in MatA
    if (matAAddr && matAAddr !== ethers.ZeroAddress) {
      const mc = new ethers.Contract(matAAddr, MAT_ABI, provider);
      const [ever, inMat, parkedAt, isParked, w, res, fee] = await Promise.all([
        mc.hasEverJoined(LAVERN).catch(()=>false),
        mc.isActiveInMatrix(LAVERN).catch(()=>false),
        mc.parkedAt(LAVERN).catch(()=>0n),
        mc.isParked(LAVERN).catch(()=>false),
        mc.withdrawableOf(LAVERN).catch(()=>0n),
        mc.crossingReserveOf(LAVERN).catch(()=>0n),
        mc.entryFee().catch(()=>0n),
      ]);
      if (ever) {
        const shortfall = fee > (w + res) ? fee - (w + res) : 0n;
        const allowance = await usdc.allowance(LAVERN, matAAddr);
        console.log(`  Lavern in MatA${i+1}:`);
        console.log(`    hasEverJoined:${ever} inMatrix:${inMat} parkedAt:${parkedAt} isParked:${isParked}`);
        console.log(`    withdrawable:$${(Number(w)/1e6).toFixed(4)} reserve:$${(Number(res)/1e6).toFixed(4)} fee:$${(Number(fee)/1e6).toFixed(2)} shortfall:$${(Number(shortfall)/1e6).toFixed(4)}`);
        console.log(`    USDC allowance to MatA: $${(Number(allowance)/1e6).toFixed(4)}`);

        if (isParked || parkedAt > 0n) {
          console.log(`  *** PARKED IN MatA${i+1} — simulating selfRescue ***`);
          try {
            await provider.call({ from: LAVERN, to: matAAddr, data: "0x2af4d727" }); // selfRescue()
            console.log("  ✓ selfRescue would SUCCEED");
          } catch(e) {
            console.log(`  ✗ selfRescue REVERTS: ${e.reason || e.data || e.message}`);
          }
        }
      }
    }
  }

  // Also scan recent SelfRescue events for Lavern
  console.log("\n=== Checking for recent SelfRescue events (last 5000 blocks) ===");
  const matAAddr = addrs.tiers.T1.matA;
  const mc = new ethers.Contract(matAAddr, ["event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)"], provider);
  const currentBlock = await provider.getBlockNumber();
  const events = await mc.queryFilter(mc.filters.SelfRescue(LAVERN), currentBlock - 5000, currentBlock).catch(() => []);
  if (events.length > 0) {
    console.log(`Found ${events.length} SelfRescue event(s) for Lavern:`);
    events.forEach(e => console.log(`  block ${e.blockNumber}: shortfall=$${(Number(e.args.shortfallPaid)/1e6).toFixed(4)} withdrawable=$${(Number(e.args.withdrawableUsed)/1e6).toFixed(4)}`));
  } else {
    console.log("No SelfRescue events found for Lavern in last 5000 blocks.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
