// deploy_receiver.js
// Deploys AutomationReceiver for CRE workflow integration.
// Run with: npx hardhat run scripts/deploy_receiver.js --network baseSepolia
//
// FORWARDER addresses (from https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts):
//   Mock (simulation):  0x82300bd7c3958625581cc2f77bc6464dcecdf3e5  ← use for `cre workflow simulate`
//   Production (live):  0xF8344CFd5c43616a4366C34E3EEE75af79a74482  ← use when deploying workflow to CRE DON

const hre = require("hardhat");

// Toggle: false = mock forwarder (simulation), true = production forwarder (live CRE DON)
const USE_PRODUCTION_FORWARDER = false;

const MOCK_FORWARDER       = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";
const PRODUCTION_FORWARDER = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482";

const MATRIX_KEEPER = "0x2fBF319C7648185f4EACF2ba8b7f8418eedc2EF0"; // V8.16

// performUpkeep(bytes) selector = keccak256("performUpkeep(bytes)")[0:4]
const PERFORM_UPKEEP_SELECTOR = "0x4585e33b";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const forwarder = USE_PRODUCTION_FORWARDER ? PRODUCTION_FORWARDER : MOCK_FORWARDER;
  const label = USE_PRODUCTION_FORWARDER ? "PRODUCTION" : "MOCK (simulation)";
  console.log(`\nForwarder: ${forwarder}  [${label}]`);
  console.log("MatrixKeeper:", MATRIX_KEEPER);

  console.log("\n--- Deploying AutomationReceiver ---");
  const Factory = await hre.ethers.getContractFactory("AutomationReceiver");
  const receiver = await Factory.deploy(forwarder);
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  console.log("AutomationReceiver deployed:", receiverAddress);

  console.log("\n--- Allowing performUpkeep(bytes) on MatrixKeeper ---");
  const tx = await receiver.setCallAllowed(MATRIX_KEEPER, PERFORM_UPKEEP_SELECTOR, true);
  await tx.wait();
  console.log("setCallAllowed tx:", tx.hash);

  // Verify
  const allowed = await receiver.isCallAllowed(MATRIX_KEEPER, PERFORM_UPKEEP_SELECTOR);
  console.log("isCallAllowed:", allowed);

  console.log("\n=== DONE ===");
  console.log("AutomationReceiver:", receiverAddress);
  console.log("\nNext: update config.test.json with:");
  console.log(`  "receiverAddress": "${receiverAddress}"`);
  console.log(`  "chainSelectorName": "ethereum-testnet-sepolia-base-1"`);
  console.log(`  "targetAddress": "${MATRIX_KEEPER}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
