"use strict";
/**
 * check_matA_pos1.js — diagnose the "no root" stuck state
 * Checks who is at each position in MatA, especially position 1.
 *
 * Run: npx hardhat run scripts/check_matA_pos1.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, "deployed_addresses_v8_32.json"), "utf8"
  ));

  const matA = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA);
  const occ   = await matA.occupancy();
  const msize = await matA.MATRIX_SIZE();
  const rot   = await matA.rotationCount();
  const next  = await matA.nextSlot();

  console.log(`\nMatA: ${occ}/${msize}  rot=${rot}  nextSlot=${next}`);

  // Check first 10 positions and last 5
  console.log("\nFirst 10 positions:");
  for (let i = 1; i <= 10; i++) {
    const m = await matA.posToMember(i);
    const idle = m !== ethers.ZeroAddress
      ? Math.floor((Date.now()/1000) - Number(await matA.lastActivityTime(m)))
      : null;
    console.log(`  pos ${String(i).padStart(3)}: ${m === ethers.ZeroAddress ? '(empty)' : m.slice(0,12) + '...  idle=' + idle + 's'}`);
  }

  // Count empty positions
  let empty = 0;
  let firstEmpty = null;
  for (let i = 1; i <= Number(msize); i++) {
    const m = await matA.posToMember(i);
    if (m === ethers.ZeroAddress) {
      empty++;
      if (!firstEmpty) firstEmpty = i;
    }
  }
  console.log(`\nEmpty positions: ${empty}  (first empty: pos ${firstEmpty})`);
  console.log(`Occupied: ${Number(msize) - empty} (matches occupancy=${occ}: ${Number(msize) - empty === Number(occ) ? 'YES' : 'NO'})`);
}

main().catch(e => { console.error(e); process.exit(1); });
