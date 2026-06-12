/**
 * Mint test USDC to one or more wallets on Base Sepolia
 * Usage: npx hardhat run scripts/mint-testusdc.js --network baseSepolia
 *
 * Edit RECIPIENTS below with the wallet addresses you want to fund.
 * Each address receives AMOUNT test USDC (default $500).
 */

const { ethers } = require("hardhat");

const MOCK_USDC = "0xc7D007D60210eAF1C291B4873A0d285De0B97C8F";

// ── Add your test wallet addresses here ──────────────────────────────────────
const RECIPIENTS = [
  "0x558E7848BD190C32251f7610c14329C594E5b0A0",
  // "0xSecondWalletAddress",
  // "0xThirdWalletAddress",
  // add as many as you need
];

const AMOUNT = "500"; // $500 USDC each (6 decimals)

async function main() {
  if (RECIPIENTS.length === 0) {
    console.error("❌  Add wallet addresses to RECIPIENTS in this script first.");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  console.log("Minter:", deployer.address);

  const usdc = await ethers.getContractAt("MockUSDC", MOCK_USDC, deployer);
  const amount = ethers.parseUnits(AMOUNT, 6);

  for (const addr of RECIPIENTS) {
    const tx = await usdc.mint(addr, amount);
    await tx.wait();
    console.log(`  ✅ Minted ${AMOUNT} USDC → ${addr}`);
  }

  console.log("\nDone! All wallets funded.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
