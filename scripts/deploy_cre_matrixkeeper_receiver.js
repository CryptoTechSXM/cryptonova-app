// deploy_cre_matrixkeeper_receiver.js
// Deploys MatrixKeeperReceiver — the CRE onReport() adapter that forwards into
// MatrixKeeper.performUpkeep(bytes). Fresh contract, not a migration of the old
// AutomationReceiver (see deploy_receiver.js, superseded — kept only for reference).
//
// Run with: npx hardhat run scripts/deploy_cre_matrixkeeper_receiver.js --network baseSepolia
//
// FORWARDER addresses (https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts):
//   Mock (simulation):  0x82300bd7c3958625581cc2f77bc6464dcecdf3e5  ← use for `cre workflow simulate --broadcast`
//   Production (live):  0xF8344CFd5c43616a4366C34E3EEE75af79a74482  ← use once the workflow is deployed to the CRE DON
//
// The deployed contract's forwarder can be changed later without redeploying via
// receiver.setForwarderAddress(newForwarder) — owner-only. So you can deploy once
// against the mock forwarder, simulate, then flip to production before going live.

const hre = require("hardhat");

// Toggle: false = mock forwarder (simulation), true = production forwarder (live CRE DON)
const USE_PRODUCTION_FORWARDER = false;

const MOCK_FORWARDER       = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";
const PRODUCTION_FORWARDER = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482";

// Current live MatrixKeeper (V8.18 — confirmed in scripts/deployed_addresses_v8_18.json).
// V8.19 deploy (#131) is still pending; update this if/when that lands.
const MATRIX_KEEPER = "0xc85A54319ec73e51F9Ad3033068c373e773312fb";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const forwarder = USE_PRODUCTION_FORWARDER ? PRODUCTION_FORWARDER : MOCK_FORWARDER;
  const label = USE_PRODUCTION_FORWARDER ? "PRODUCTION" : "MOCK (simulation)";
  console.log(`\nForwarder: ${forwarder}  [${label}]`);
  console.log("MatrixKeeper:", MATRIX_KEEPER);

  console.log("\n--- Deploying MatrixKeeperReceiver ---");
  const Factory = await hre.ethers.getContractFactory("MatrixKeeperReceiver");
  const receiver = await Factory.deploy(forwarder, MATRIX_KEEPER);
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  console.log("MatrixKeeperReceiver deployed:", receiverAddress);

  // Sanity check — confirm on-chain state matches what we just passed in.
  const onChainForwarder = await receiver.getForwarderAddress();
  const onChainKeeper = await receiver.matrixKeeper();
  console.log("\nVerifying on-chain state:");
  console.log("  forwarder   :", onChainForwarder, onChainForwarder.toLowerCase() === forwarder.toLowerCase() ? "✓" : "✗ MISMATCH");
  console.log("  matrixKeeper:", onChainKeeper, onChainKeeper.toLowerCase() === MATRIX_KEEPER.toLowerCase() ? "✓" : "✗ MISMATCH");

  console.log("\n=== DONE ===");
  console.log("MatrixKeeperReceiver:", receiverAddress);
  console.log("\nNext: update cryptonova-keeper/my-workflow/config.staging.json with:");
  console.log(`  "chainSelectorName": "ethereum-testnet-sepolia-base-1"`);
  console.log(`  matrixKeeperAddress (read):     "${MATRIX_KEEPER}"`);
  console.log(`  receiverAddress     (write):    "${receiverAddress}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
