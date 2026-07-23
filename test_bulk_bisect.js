// test_bulk_bisect.js — which bulkUpgrade target reverts for the fresh test wallet?
// Estimates gas for bulkUpgrade(1..4) = targets T2..T5. Read-only (no tx sent).
// Also checks per-tier state that could block: velocity gate, whale gate, pair 0 occupancy.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ADDRS_FILE   = process.env.ADDRESSES_FILE || "deployed_addresses_v8_42.json";
const WALLET_INDEX = Number(process.env.TEST_INDEX || 990_001);

const TR_ABI = [
  "function bulkUpgrade(uint8) external",
  "function tierVelocityGreen(uint256) external view returns (bool)",
  "function isWhaleGateActiveForTier(uint8) external view returns (bool)",
  "function memberHighestTier(address) external view returns (uint8)",
];
const PM_ABI = [
  "function getPairAt(uint256) external view returns (address, address)",
  "function pairCount() external view returns (uint256)",
];
const MAT_ABI = ["function occupancy() external view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const addrs    = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRS_FILE), "utf8"));
  const tr       = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);
  const mn = ethers.Mnemonic.fromPhrase(process.env.FILL_MNEMONIC);
  const w  = ethers.HDNodeWallet.fromMnemonic(mn, `m/44'/60'/0'/0/${WALLET_INDEX}`).connect(provider);

  console.log(`Wallet: ${w.address} | highestTier: ${await tr.memberHighestTier(w.address)}\n`);

  // Per-tier state
  for (let t = 2; t <= 5; t++) {
    const tk  = "T" + t;
    const idx = t - 1;
    const vel   = await tr.tierVelocityGreen(idx).catch(() => "?");
    const whale = await tr.isWhaleGateActiveForTier(t).catch(() => "?");
    let occA = "?";
    try {
      const pm = new ethers.Contract(addrs.tiers[tk].pm, PM_ABI, provider);
      const [matA] = await pm.getPairAt(0);
      occA = (await new ethers.Contract(matA, MAT_ABI, provider).occupancy()).toString();
    } catch {}
    console.log(`${tk}: velocityGreen=${vel} whaleGateActive=${whale} pair0.MatA occ=${occA}/127`);
  }

  console.log("\nestimateGas per target:");
  for (let target = 1; target <= 4; target++) {
    try {
      const est = await tr.connect(w).bulkUpgrade.estimateGas(target);
      console.log(`  bulkUpgrade(${target}) → T${target+1}: ✅ ${est.toString()} gas`);
    } catch (e) {
      console.log(`  bulkUpgrade(${target}) → T${target+1}: ❌ ${e.reason || e.shortMessage || (e.message || "").slice(0, 90)}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
