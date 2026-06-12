"use strict";
const { ethers } = require("hardhat");

// Current addresses from v3_index.html
const BELT_MANAGER = "0x5b12E5adEA89F8FA09573B91eBbca43AD7C0fC27";
const MATRIX_T1    = "0x02D03794922F9918a7cc09d2c93cE4220D23Ad31";

async function main() {
  const bm = await ethers.getContractAt("BeltManager", BELT_MANAGER);
  const mx = await ethers.getContractAt("CryptoNovaMatrixV3", MATRIX_T1);

  const [aw, beltMax, entryFee, totalBelts, totalMembers] = await Promise.all([
    mx.ACTIVE_WINDOW(),
    bm.BELT_MAX(),
    mx.ENTRY_FEE(),
    bm.totalBelts(),
    bm.totalMembers(),
  ]);

  console.log("\n  Contract Version Check");
  console.log("  ─────────────────────────────");
  console.log("  BeltManager   :", BELT_MANAGER);
  console.log("  Matrix T1     :", MATRIX_T1);
  console.log("  ACTIVE_WINDOW :", aw.toString(), aw == 2n ? "✅ LIGHTNING" : aw == 5n ? "⚠️  ENGINE (not lightning!)" : "❓");
  console.log("  BELT_MAX      :", beltMax.toString(), beltMax == 10n ? "✅ LIGHTNING" : "⚠️  NOT LIGHTNING");
  console.log("  Entry fee     : $" + (Number(entryFee)/1e6).toFixed(2), entryFee == 1_000_000n ? "✅ $1 LIGHTNING" : "⚠️  NOT $1");
  console.log("  Total belts   :", totalBelts.toString());
  console.log("  Total members :", totalMembers.toString());
  console.log();
}
main().catch(e => { console.error(e); process.exit(1); });
