// verify_cre_receiver.js
// Re-checks MatrixKeeperReceiver state after a deploy, with retries to ride out
// Base Sepolia public RPC propagation lag (same flakiness deploy_v8.js works around
// for nonces). Pass the deployed address as an arg via env var RECEIVER_ADDRESS.
//
// Run with: RECEIVER_ADDRESS=0x... npx hardhat run scripts/verify_cre_receiver.js --network baseSepolia

const hre = require("hardhat");

const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!RECEIVER_ADDRESS) {
    console.error("Set RECEIVER_ADDRESS env var to the deployed MatrixKeeperReceiver address.");
    process.exit(1);
  }

  const receiver = await hre.ethers.getContractAt("MatrixKeeperReceiver", RECEIVER_ADDRESS);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const forwarder = await receiver.getForwarderAddress();
      const matrixKeeper = await receiver.matrixKeeper();
      console.log(`\nAttempt ${attempt} succeeded:`);
      console.log("  forwarder   :", forwarder);
      console.log("  matrixKeeper:", matrixKeeper);
      return;
    } catch (e) {
      console.log(`Attempt ${attempt} failed (${e.code || e.message}), retrying in 5s...`);
      await sleep(5000);
    }
  }
  console.error("Gave up after 5 attempts.");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
