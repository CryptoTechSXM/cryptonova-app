// set_grace_period.js
// One-off: sets parkedGracePeriod on the live MatrixKeeper contract.
//
// Allowed values (V8.26+): 0 (immediate) or any value between 300 (5min) and 2592000 (30d)
//
// Testnet: 0  (immediate rescue — no waiting period)
// Mainnet: 3600 (1hr) or 21600 (6hrs) recommended
//
// Run: npx hardhat run scripts/set_grace_period.js --network baseSepolia

const { ethers } = require("hardhat");
require("dotenv").config();

const MATRIX_KEEPER = "0x3de9c7bD20cC82238BC39c98D7A1aC15dd1280df"; // V8.26

// ─── Set this before running ─────────────────────────────────────────────────
const NEW_GRACE_PERIOD = 300; // seconds  (300 = 5 minutes — testnet grace period testing)
// ─────────────────────────────────────────────────────────────────────────────

const ABI = [
  "function parkedGracePeriod() external view returns (uint256)",
  "function setParkedGracePeriod(uint256 v) external",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Signer : ${signer.address}`);
  console.log(`Keeper : ${MATRIX_KEEPER}`);

  const keeper = new ethers.Contract(MATRIX_KEEPER, ABI, signer);

  const current = await keeper.parkedGracePeriod();
  console.log(`Current parkedGracePeriod: ${current.toString()}s (${Number(current) / 86400} days)`);
  console.log(`Target  parkedGracePeriod: ${NEW_GRACE_PERIOD}s`);

  if (current === BigInt(NEW_GRACE_PERIOD)) {
    console.log("Already set — nothing to do.");
    return;
  }

  console.log("\nSending setParkedGracePeriod transaction...");
  const tx = await keeper.setParkedGracePeriod(NEW_GRACE_PERIOD, { gasLimit: 100_000 });
  console.log(`TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed — block ${receipt.blockNumber}  status ${receipt.status === 1 ? "OK ✅" : "FAILED ❌"}`);

  const updated = await keeper.parkedGracePeriod();
  console.log(`\nNew parkedGracePeriod: ${updated.toString()}s ✅`);
}

main().catch(e => {
  console.error("Fatal:", e.