"use strict";
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
require("dotenv").config();
const ADDRS_FILE = path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json");
const MAT_ABI = [
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
  "function crossingInProgress() view returns (bool)",
  "function getParkedCount() view returns (uint256)",
  "function parkedMembers(uint256) view returns (address)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
];
const PM_ABI = ["function allPairsStatus() view returns (address[] matAs, address[] matBs, uint256[] matAOcc, uint256[] matBOcc, uint256[] matARot, uint256[] matBRot)"];
const TR_ABI = ["function tierEntryFees(uint256) view returns (uint256)"];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE));
  const [signer] = await ethers.getSigners();
  const p = signer.provider;
  const pm   = new ethers.Contract(addrs.tiers.T1.pm, PM_ABI, p);
  const tr   = new ethers.Contract(addrs.tierRouter, TR_ABI, p);
  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, p);

  const [matAs, matBs] = await pm.allPairsStatus();
  const sfBal = await usdc.balanceOf(addrs.stabilityFund).catch(() => 0n);
  const t1Fee = await tr.tierEntryFees(0); // T1 = index 0
  console.log(`SF USDC balance: $${(Number(sfBal)/1e6).toFixed(4)}`);
  console.log(`T1 entry fee:   $${(Number(t1Fee)/1e6).toFixed(2)}\n`);

  for (let i = 0; i < matAs.length; i++) {
    // MatA
    const mc = new ethers.Contract(matAs[i], MAT_ABI, p);
    const [occ, rot, crossing, parked] = await Promise.all([
      mc.occupancy().catch(()=>0n),
      mc.rotationCount().catch(()=>0n),
      mc.crossingInProgress().catch(()=>'N/A'),
      mc.getParkedCount().catch(()=>0n),
    ]);
    console.log(`T1 MatA${i+1} (${matAs[i]})`);
    console.log(`  occ=${occ}  rot=${rot}  crossingInProgress=${crossing}  parkedCount=${parked}`);

    if (Number(parked) > 0) {
      console.log(`  Parked members (first 5 of ${parked}):`);
      const count = Math.min(5, Number(parked));
      for (let j = 0; j < count; j++) {
        const addr = await mc.parkedMembers(j).catch(() => null);
        if (!addr) continue;
        const [w, res] = await Promise.all([
          mc.withdrawableOf(addr).catch(()=>0n),
          mc.crossingReserveOf(addr).catch(()=>0n),
        ]);
        const effective = w + res;
        const shortfall = t1Fee > effective ? t1Fee - effective : 0n;
        console.log(`    [${j}] ${addr.slice(0,10)}…  withdrawable=$${(Number(w)/1e6).toFixed(4)}  reserve=$${(Number(res)/1e6).toFixed(4)}  shortfall=$${(Number(shortfall)/1e6).toFixed(4)}`);
      }
    }

    // MatB
    const mcB = new ethers.Contract(matBs[i], MAT_ABI, p);
    const [occB, rotB, crossingB, parkedB] = await Promise.all([
      mcB.occupancy().catch(()=>0n),
      mcB.rotationCount().catch(()=>0n),
      mcB.crossingInProgress().catch(()=>'N/A'),
      mcB.getParkedCount().catch(()=>0n),
    ]);
    console.log(`T1 MatB${i+1} (${matBs[i]})`);
    console.log(`  occ=${occB}  rot=${rotB}  crossingInProgress=${crossingB}  parkedCount=${parkedB}\n`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
