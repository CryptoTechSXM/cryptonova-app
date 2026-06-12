/**
 * Mint test USDC to any address (testnet only)
 * ──────────────────────────────────────────────
 * Usage:
 *   npx hardhat run scripts/mint-test-usdc.js --network baseSepolia
 *
 * PowerShell (Windows):
 *   $env:RECIPIENT="0xYourAddress"; npx hardhat run scripts/mint-test-usdc.js --network baseSepolia
 *
 * bash/Mac/Linux:
 *   RECIPIENT=0xYourAddress npx hardhat run scripts/mint-test-usdc.js --network baseSepolia
 *
 * OR just edit the HARDCODED_RECIPIENT line below and run without env vars.
 *
 * Requires DEPLOYER_PRIVATE_KEY in .env (the wallet that deployed MockUSDC)
 */

const { ethers } = require("hardhat");
require("dotenv").config();

const MOCK_USDC   = "0x32090959aD707f3E4c2e0c29865E74b467a4bDe7";
const MINT_AMOUNT = "1000"; // $1,000 test USDC per call

// ── Optional: hardcode recipient here instead of using env var ──────────
// const HARDCODED_RECIPIENT = "0x558E7848BD190C32251f7610c14329C594E5b0A0";
const HARDCODED_RECIPIENT = "";
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();

  // Priority: hardcoded > env var > deployer itself
  const recipient = HARDCODED_RECIPIENT || process.env.RECIPIENT || deployer.address;

  if (!ethers.isAddress(recipient)) {
    console.error("❌ Invalid RECIPIENT address:", recipient);
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════");
  console.log("  CryptoNova — Mint Test USDC");
  console.log("═══════════════════════════════════════════");
  console.log(`  Deployer  : ${deployer.address}`);
  console.log(`  Recipient : ${recipient}`);
  console.log(`  Amount    : $${MINT_AMOUNT} USDC`);
  console.log("═══════════════════════════════════════════\n");

  const MockUSDC = await ethers.getContractAt(
    ["function mint(address to, uint256 amount) external",
     "function balanceOf(address) view returns (uint256)",
     "function decimals() view returns (uint8)"],
    MOCK_USDC,
    deployer
  );

  const decimals = await MockUSDC.decimals();
  const amount   = ethers.parseUnits(MINT_AMOUNT, decimals);

  const balBefore = await MockUSDC.balanceOf(recipient);
  console.log(`  Balance before: $${ethers.formatUnits(balBefore, decimals)}`);

  console.log(`  Minting $${MINT_AMOUNT} USDC...`);
  const tx = await MockUSDC.mint(recipient, amount);
  await tx.wait();

  const balAfter = await MockUSDC.balanceOf(recipient);
  console.log(`  Balance after : $${ethers.formatUnits(balAfter, decimals)}`);
  console.log(`\n  ✓ Done! Tx: ${tx.hash}`);
  console.log(`  BaseScan: https://sepolia.basescan.org/tx/${tx.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
