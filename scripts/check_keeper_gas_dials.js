// check_keeper_gas_dials.js — WHAT ARE minGasPerItem AND maxItemsPerUpkeep ON THE **LIVE** CHAIN?
//
// Built 2026-08-22 (session 29) to answer one question that gates the community deploy.
// Session 29 measured (handoff 29.13) that eth_estimateGas prices the BatchGasHalted path,
// not the item, because halting SUCCEEDS. A keeper sized from that estimate sends far too
// little gas, the batch halts, the transaction SUCCEEDS, and nobody is rescued — with no
// WorkItemFailed and no revert anywhere to notice.
//
// Both live keepers have that exposure:
//   direct_keeper.js:175   est = performUpkeep.estimateGas(...)  -> ladder, NO FLOOR
//   system_keeper.js:579   gasLimit = isOverflow ? 15_000_000 : 800_000
// Whether it BITES depends on the live chain's minGasPerItem, and 25.6 already caught the
// live dials disagreeing with source. So read the chain, do not read the source.
//
// ⛔ DELIBERATELY IGNORES $env:ADDRESSES_FILE and reads the value out of .env ON DISK.
//    This script exists to ask about the LIVE deployment, and a session variable left over
//    from a private-chain run would silently point it at the wrong chain — the exact trap
//    handoff 29.3c cost this project an evening on.
//
//   node scripts\check_keeper_gas_dials.js
//   node scripts\check_keeper_gas_dials.js deployed_addresses_v8_50_private.json   (override)

const fs   = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("./rpc_resilience");
const { ethers } = require("ethers");

function dotenvValue(key) {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const m = txt.match(new RegExp("^\\s*" + key + "\\s*=\\s*(.+?)\\s*$", "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

(async () => {
  const file = process.argv[2] || dotenvValue("ADDRESSES_FILE");
  if (!file) { console.error("\n  No ADDRESSES_FILE in .env and none given.\n"); process.exit(1); }
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
  const rpc = process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
  const p = new ethers.JsonRpcProvider(rpc, 84532, { staticNetwork: true });
  const k = new ethers.Contract(addrs.matrixKeeper, [
    "function minGasPerItem() view returns (uint256)",
    "function maxItemsPerUpkeep() view returns (uint256)",
  ], p);

  console.log("");
  console.log(`  chain read     : ${file}${process.argv[2] ? "  (override)" : "  <- from .env ON DISK, not the session"}`);
  console.log(`  MatrixKeeper   : ${addrs.matrixKeeper}`);
  // ⛔ A GETTER THAT REVERTS IS AN ANSWER — "this deployment does not have it" — and it
  //    must be REPORTED, not thrown. The first version of this file crashed on exactly
  //    that case, repeating the empty-catch mistake recorded in handoff 29.4 within the
  //    hour of writing it up. minGasPerItem arrived with DEFECT 8 (2026-08-17) and does
  //    NOT exist on V8.48, which is precisely the fact this script exists to establish.
  async function dial(name, fn) {
    try { return await fn(); }
    catch (e) {
      const missing = /missing revert data|execution reverted|CALL_EXCEPTION/i.test(String(e && (e.message || e.shortMessage)));
      console.log(`  ${name.padEnd(18)} ${missing ? "NOT PRESENT on this deployment" : "READ FAILED: " + String(e && e.shortMessage || e).slice(0, 60)}`);
      return null;
    }
  }

  const mg = await dial("minGasPerItem", () => k.minGasPerItem());
  if (mg !== null) console.log(`  minGasPerItem      ${mg}   (${(Number(mg) / 1e6).toFixed(2)}M)`);
  const mi = await dial("maxItemsPerUpkeep", () => k.maxItemsPerUpkeep());
  if (mi !== null) console.log(`  maxItemsPerUpkeep  ${mi}`);

  console.log("");
  console.log("  -- WHAT THIS DECIDES -------------------------------------------------");
  if (mg === null) {
    console.log("  NO GAS FLOOR ON THIS CHAIN. minGasPerItem does not exist here, so there is");
    console.log("  no BatchGasHalted path for eth_estimateGas to converge on — an estimate");
    console.log("  prices the ITEM, and direct_keeper.js's ladder is sound as written.");
    console.log("");
    console.log("  ⛔ THAT CHANGES THE MOMENT V8.50 SHIPS. Defect 8 adds the floor, and with");
    console.log("     it the trap measured in handoff 29.13: a floorless estimate then prices");
    console.log("     the HALT (~0.09M) instead of the item (~4.4M), the transaction SUCCEEDS,");
    console.log("     and nobody is rescued — no revert, no WorkItemFailed, nothing to notice.");
    console.log("     direct_keeper.js:175 and system_keeper.js:579 MUST gain a floor BEFORE");
    console.log("     the community deploy, not after it.");
  } else {
    console.log(`  A performUpkeep tx carrying LESS than ${(Number(mg) / 1e6).toFixed(2)}M gas halts before`);
    console.log("  dispatching anything, SUCCEEDS, and rescues nobody.");
    console.log("    direct_keeper.js  sizes from estimateGas with NO floor");
    console.log("    system_keeper.js  sends a hardcoded 800,000 when not in overflow");
    console.log(`  800,000 is ${800000n < mg ? "BELOW  <- system_keeper's normal path CANNOT dispatch an item" : "above the floor - system_keeper's normal path is fine"}`);
    console.log("");
    console.log("  ⚠ DIALS ONLY. Whether direct_keeper is actually halting is a separate");
    console.log("    measurement: look for BatchGasHalted with processed 0 in its recent");
    console.log("    transactions, or read gasUsed in /root/keeper/keeper.log.");
  }
  console.log("");
})();
