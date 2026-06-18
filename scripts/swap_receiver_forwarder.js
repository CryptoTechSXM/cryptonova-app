// swap_receiver_forwarder.js
// Updates AutomationReceiver forwarder from Mock → Production before deploying workflow to CRE DON.
// Run with: npx hardhat run scripts/swap_receiver_forwarder.js --network baseSepolia

const hre = require("hardhat");

const RECEIVER_ADDRESS      = "0x8E5187C348aeC17767611f4052c16249BE7E23E1";
const PRODUCTION_FORWARDER  = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482"; // Base Sepolia production KeystoneForwarder

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Signer:", deployer.address);

  const receiver = await hre.ethers.getContractAt("AutomationReceiver", RECEIVER_ADDRESS);

  const current = await receiver.getForwarderAddress();
  console.log("Current forwarder:", current);

  if (current.toLowerCase() === PRODUCTION_FORWARDER.toLowerCase()) {
    console.log("Already set to production forwarder — nothing to do.");
    return;
  }

  console.log("Swapping to production forwarder:", PRODUCTION_FORWARDER);
  const tx = await receiver.setForwarderAddress(PRODUCTION_FORWARDER);
  console.log("TX sent:", tx.hash);
  await tx.wait();
  console.log("Confirmed.");

  const updated = await receiver.getForwarderAddress();
  console.log("New forwarder:", updated);
}

main().catch((e) => { console.error(e); process.exit(1); });
