// check_cre_relay_tx.js
// Confirms a CRE-relayed tx actually succeeded inside MatrixKeeperReceiver.onReport() —
// the receiver try/catches performUpkeep, so a successful outer tx can still mask a
// silently-failed inner call. Distinguishes ReportRelayed (success) from
// PerformUpkeepFailed (swallowed revert) by decoding the tx's logs.
//
// Run with: TX_HASH=0x... npx hardhat run scripts/check_cre_relay_tx.js --network baseSepolia

const hre = require("hardhat");

const TX_HASH = process.env.TX_HASH;

async function main() {
  if (!TX_HASH) {
    console.error("Set TX_HASH env var to the transaction hash to inspect.");
    process.exit(1);
  }

  const receipt = await hre.ethers.provider.getTransactionReceipt(TX_HASH);
  if (!receipt) {
    console.error("No receipt found for that tx hash (yet) — try again in a few seconds.");
    process.exit(1);
  }

  console.log("Tx status:", receipt.status === 1 ? "SUCCESS (1)" : `FAILED (${receipt.status})`);
  console.log("Block:", receipt.blockNumber);
  console.log("Logs found:", receipt.logs.length);

  const receiver = await hre.ethers.getContractAt("MatrixKeeperReceiver", receipt.to || receipt.logs[0]?.address);
  const iface = receiver.interface;

  let sawRelayed = false;
  let sawFailed = false;

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      if (parsed.name === "ReportRelayed") {
        sawRelayed = true;
        console.log("\n✓ ReportRelayed — performUpkeep succeeded");
        console.log("  performData:", parsed.args.performData);
      } else if (parsed.name === "PerformUpkeepFailed") {
        sawFailed = true;
        console.log("\n✗ PerformUpkeepFailed — performUpkeep reverted (swallowed by try/catch)");
        console.log("  performData:", parsed.args.performData);
        console.log("  reason (raw bytes):", parsed.args.reason);
      }
    } catch {
      // not a MatrixKeeperReceiver event — ignore (could be from MatrixKeeper itself, etc.)
    }
  }

  console.log("\n=== RESULT ===");
  if (sawRelayed) {
    console.log("CRE → Receiver → MatrixKeeper.performUpkeep() chain confirmed working end-to-end.");
  } else if (sawFailed) {
    console.log("CRE → Receiver delivery worked, but performUpkeep() itself reverted. Investigate reason bytes above.");
  } else {
    console.log("Neither event found in this tx's logs — check the receiver address / tx hash.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
