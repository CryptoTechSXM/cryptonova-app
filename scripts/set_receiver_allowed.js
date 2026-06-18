// set_receiver_allowed.js
// Run after deploy_receiver.js to allowlist MatrixKeeper.performUpkeep on the receiver.
// Usage: npx hardhat run scripts/set_receiver_allowed.js --network baseSepolia

const hre = require("hardhat");

const RECEIVER_ADDRESS = "0x8E5187C348aeC17767611f4052c16249BE7E23E1"; // deployed by deploy_receiver.js
const MATRIX_KEEPER    = "0x2fBF319C7648185f4EACF2ba8b7f8418eedc2EF0"; // V8.16
const PERFORM_UPKEEP_SELECTOR = "0x4585e33b"; // keccak256("performUpkeep(bytes)")[0:4]

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Signer:", deployer.address);

  const receiver = await hre.ethers.getContractAt("AutomationReceiver", RECEIVER_ADDRESS);

  // Check current state first
  const alreadyAllowed = await receiver.isCallAllowed(MATRIX_KEEPER, PERFORM_UPKEEP_SELECTOR);
  if (alreadyAllowed) {
    console.log("Already allowed — nothing to do.");
    return;
  }

  console.log("Calling setCallAllowed...");
  const tx = await receiver.setCallAllowed(MATRIX_KEEPER, PERFORM_UPKEEP_SELECTOR, true);
  console.log("TX sent:", tx.hash);
  await tx.wait();
  console.log("Confirmed.");

  const allowed = await receiver.isCallAllowed(MATRIX_KEEPER, PERFORM_UPKEEP_SELECTOR);
  console.log("isCallAllowed:", allowed);
}

main().catch((e) => { console.error(e); process.exit(1); });
