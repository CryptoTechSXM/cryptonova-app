const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");
const { ethers } = hre;

async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_34.json"), "utf8"));
  console.log("MatrixKeeper:", addrs.matrixKeeper);

  const MAT_ABI = [
    "function occupancy() view returns (uint256)",
    "function MATRIX_SIZE() view returns (uint256)",
    "function getParkedCount() view returns (uint256)",
    "function isFull() view returns (bool)",
  ];

  for (const [tier, info] of Object.entries(addrs.tiers || {})) {
    for (const [mat, addr] of [["MatA", info.matA], ["MatB", info.matB]]) {
      if (!addr) continue;
      try {
        const c = new ethers.Contract(addr, MAT_ABI, hre.ethers.provider);
        const [occ, size, parked] = await Promise.all([c.occupancy(), c.MATRIX_SIZE(), c.getParkedCount()]);
        const tag = occ >= size ? " FULL" : "";
        if (occ > 0n || parked > 0n) console.log(tier + " " + mat + ": " + occ + "/" + size + tag + "  (" + parked + " parked)");
      } catch(e) { console.log(tier + " " + mat + ": err — " + (e.shortMessage||e.message).slice(0,60)); }
    }
  }
}
main().catch(console.error);
