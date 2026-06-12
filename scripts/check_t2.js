const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

async function main() {
  const file = process.env.ADDRESSES_FILE || "scripts/deployed_addresses_v8_2.json";
  const addrs = JSON.parse(fs.readFileSync(file, "utf8"));
  const tr  = await ethers.getContractAt("TierRouter", addrs.tierRouter);
  const mA2 = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T2.matA);
  const mB2 = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T2.matB);

  const occ2A = await mA2.occupancy();
  const occ2B = await mB2.occupancy();
  const size  = await mA2.MATRIX_SIZE();
  const fee2  = await mA2.ENTRY_FEE();
  const total = await tr.totalSystemCycles();
  const pm2   = await ethers.getContractAt("PairManagerV8", addrs.tiers.T2.pm);
  const reg2  = await pm2.totalRegistrations();

  console.log(`T2 MatA occupancy:   ${occ2A} / ${size}`);
  console.log(`T2 MatB occupancy:   ${occ2B} / ${size}`);
  console.log(`T2 entry fee:        $${Number(fee2)/1e6}`);
  console.log(`T2 total reg:        ${reg2}`);
  console.log(`Total system cycles: ${total}`);

  // Scan all test wallets across offsets 500-2070 to find any in T2
  const mnemo = "test test test test test test test test test test test junk";
  console.log("\nScanning for T2 members across offsets 500-2070...");
  let found = 0;
  for (const base of [500, 1000, 1500, 2000]) {
    for (let i = 0; i < 70; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, `m/44'/60'/0'/0/${base+i}`);
      const t = await tr.memberHighestTier(w.address);
      if (t >= 2n) {
        const m = await mA2.getMember(w.address);
        console.log(`  T2 member: ${w.address.slice(0,14)}  tier=${t}  T2A_pos=${m.bfsPosition}  T2A_inMatrix=${m.isInMatrix}`);
        found++;
      }
    }
  }
  if (found === 0) console.log("  none found — auto-upgrade has not fired for any test wallet");
  else console.log(`  ${found} test wallets are in T2`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
