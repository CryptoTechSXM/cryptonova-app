// set_grace_period.js
// One-off: sets parkedGracePeriod on the live MatrixKeeper contract.
//
// Allowed values: 0, 3600 (1hr), 21600 (6hrs), 432000 (5d), 864000 (10d), 1296000 (15d)
//
// Testnet: 0  (immediate rescue — no waiting period)
// Mainnet: 3600 (1hr) or 21600 (6hrs) recommended
//
// Run: npx hardhat run scripts/set_grace_period.js --network baseSepolia

const { ethers } = require("hardhat");
require("dotenv").config();

const MATRIX_KEEPER = "0x6CF638431d8C4cAa735d6aBd23b5AdB322481A3e"; // V8.23

// ─── Set this before running ─────────────────────────────────────────────────
const NEW_GRACE_PERIOD = 0; // seconds  (0 = immediate rescue)
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
  console.error("Fatal:", e.message);
  process.exit(1);
});
