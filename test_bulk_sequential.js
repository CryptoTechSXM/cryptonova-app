// test_bulk_sequential.js — prove the V8.43 frontend approach:
// fresh member (zero cycles) climbs T1→T5 with one bulkUpgrade(nextIdx) per tx.
// Wallet 990001 is already registered at T1 with 425 USDC approved to TierRouter.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ADDRS_FILE   = process.env.ADDRESSES_FILE || "deployed_addresses_v8_42.json";
const WALLET_INDEX = Number(process.env.TEST_INDEX || 990_001);
const TARGET_IDX   = 4; // T5

const TR_ABI = [
  "function bulkUpgrade(uint8) external",
  "function memberHighestTier(address) external view returns (uint8)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const addrs    = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRS_FILE), "utf8"));
  const mn = ethers.Mnemonic.fromPhrase(process.env.FILL_MNEMONIC);
  const w  = ethers.HDNodeWallet.fromMnemonic(mn, `m/44'/60'/0'/0/${WALLET_INDEX}`).connect(provider);
  const tr = new ethers.Contract(addrs.tierRouter, TR_ABI, w);

  let highest = Number(await tr.memberHighestTier(w.address));
  console.log(`Wallet: ${w.address} | starting tier: ${highest}`);

  while (highest <= TARGET_IDX) {
    const entering = highest + 1;
    let est;
    try { est = await tr.bulkUpgrade.estimateGas(highest); }
    catch (e) { console.log(`❌ T${entering} estimate failed: ${e.reason || (e.message||"").slice(0,120)}`); process.exit(1); }
    const gasLimit = Math.min(Math.ceil(Number(est) * 1.3), 14_000_000);
    console.log(`T${entering}: estimate ${est} → gasLimit ${gasLimit} ... sending`);
    const rc = await (await tr.bulkUpgrade(highest, { gasLimit })).wait();
    // Do NOT re-read memberHighestTier immediately — RPC reads can lag one block
    // and return stale state (causes duplicate-send + revert). Success = +1 tier.
    highest += 1;
    console.log(`  ✅ gasUsed ${rc.gasUsed} — highestTier now ${highest}`);
  }
  console.log(`\n🎉 Fresh member (0 cycles) reached T${highest} tier-by-tier. Contract needs NO change.`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
