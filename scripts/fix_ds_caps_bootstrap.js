// fix_ds_caps_bootstrap.js
// One-shot admin fix: temporarily disable CNOVADirectSale whale caps during
// the bootstrap phase (near-zero CNOVA supply).
//
// ROOT CAUSE:
//   CNOVADirectSale.buyCNOVA() enforces:
//     maxTxBps     (default 100 = 1%)  -> cnovaOut <= supplyBefore * maxTxBps / 10000
//     maxWalletBps (default 500 = 5%)  -> balanceAfter <= supplyAfter * maxWalletBps / 10000
//   Both caps are a PERCENTAGE OF CURRENT CNOVA TOTAL SUPPLY. Right after a
//   fresh deploy, total supply is still near-zero (just W1's registration
//   mint), so the cap itself is a tiny absolute number — any normal-sized
//   USDC purchase mints far more CNOVA than 1% (or even the governance-safe
//   max of 5%) of that near-zero supply. This isn't a deploy bug; it's a
//   cold-start mismatch between percentage-of-supply caps and near-zero supply.
//
// EFFECT OF THE BUG:
//   Every buyCNOVA() call reverts "DS: exceeds per-tx cap" (confirmed via
//   BaseScan trace on tx 0x9eeaf11e3aa94e522684b4c2b0431909bf9e72496bf7dbb22db5a24f3c2c6364),
//   even for a $5 test purchase. The direct-sale page is unusable until
//   supply grows or the caps are relaxed.
//
// FIX:
//   Use the legacy owner-only setCaps(uint256,uint256) setter — NOT the new
//   governance-safe setMaxTxBps/setMaxWalletBps, which only accept a fixed
//   enum of values (0/50/100/200/300/500 and 0/250/500/1000/1500/2000) and
//   cap out at 5%/20% respectively, which is still not enough at near-zero
//   supply. setCaps() has no such restriction (just <= 10000 = 100%), so we
//   use it to fully disable both caps (0, 0) for the bootstrap window.
//
//   IMPORTANT: re-enable real caps (via setCaps or the governance setters)
//   once organic CNOVA supply has grown to a meaningful size — these caps
//   exist to stop a single whale purchase from massively diluting the token
//   once there's real supply/liquidity to protect. Leaving them at (0,0)
//   long-term defeats their purpose. This is a temporary testing unblock,
//   not a permanent config change.
//
// Usage:
//   npx hardhat run scripts/fix_ds_caps_bootstrap.js --network baseSepolia

const hre  = require("hardhat");
const path = require("path");
const fs   = require("fs");

const ADDRS_FILE = path.join(__dirname, "deployed_addresses_v8_20.json");

const DIRECT_SALE_ABI = [
  "function maxTxBps() view returns (uint256)",
  "function maxWalletBps() view returns (uint256)",
  "function setCaps(uint256 _maxTxBps, uint256 _maxWalletBps) external",
  "function owner() view returns (address)"
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  const dsAddr = addrs.directSale || addrs.cnovaDirectSale;

  if (!dsAddr) {
    throw new Error("directSale address missing from addresses file");
  }

  console.log(`CNOVADirectSale: ${dsAddr}`);

  const ds = new hre.ethers.Contract(dsAddr, DIRECT_SALE_ABI, deployer);

  const owner = await ds.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Not the owner. Owner = ${owner}, deployer = ${deployer.address}`);
  }

  const beforeTx     = await ds.maxTxBps();
  const beforeWallet = await ds.maxWalletBps();
  console.log(`\nCurrent maxTxBps:     ${beforeTx} (${Number(beforeTx) / 100}%)`);
  console.log(`Current maxWalletBps: ${beforeWallet} (${Number(beforeWallet) / 100}%)`);

  if (beforeTx === 0n && beforeWallet === 0n) {
    console.log("✓ Caps already disabled — nothing to do.");
    return;
  }

  console.log("\nCalling directSale.setCaps(0, 0) to disable both caps for bootstrap testing...");
  const tx = await ds.setCaps(0, 0);
  console.log(`TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed — block ${receipt.blockNumber}  status=${receipt.status === 1 ? "OK" : "FAILED"}`);

  const afterTx     = await ds.maxTxBps();
  const afterWallet = await ds.maxWalletBps();
  if (afterTx !== 0n || afterWallet !== 0n) {
    throw new Error(`Verification failed — maxTxBps=${afterTx}, maxWalletBps=${afterWallet}`);
  }
  console.log(`\n✓ Caps disabled. maxTxBps=0, maxWalletBps=0.`);
  console.log("  buy.html purchases should now succeed regardless of current CNOVA supply.");
  console.log("  REMINDER: re-enable caps (setCaps or governance setMaxTxBps/setMaxWalletBps)");
  console.log("  once organic supply has grown — don't leave whale protection off long-term.");
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
