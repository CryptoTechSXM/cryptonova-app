/**
 * CryptoNova — BNB Chain Mainnet Deploy Script
 *
 * Stablecoin : USDT on BSC (18 decimals)
 *   Address  : 0x55d398326f99059fF775485246999027B3197955
 *
 * Unit param : 1e18  (18-decimal USDT — same as ETH)
 *
 * Usage:
 *   npx hardhat run scripts/deploy_bsc.js --network bscMainnet
 *
 * After deploy, verify each contract:
 *   npx hardhat verify --network bscMainnet <TOKEN_ADDR> "<DEPLOYER>"
 *   npx hardhat verify --network bscMainnet <TREASURY_ADDR> "<TOKEN_ADDR>" "<DEPLOYER>"
 *   npx hardhat verify --network bscMainnet <MATRIX_ADDR> \
 *     "<USDT_ADDR>" "<TOKEN_ADDR>" "<TREASURY_ADDR>" \
 *     "<DEV_WALLET>" "<OPS_WALLET>" "<DEPLOYER>" "1000000000000000000"
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY
 *   BSC_RPC_URL        (or use free: https://bsc-dataseed.binance.org/)
 *   BSCSCAN_API_KEY    (for verification)
 *   BSC_DEV_WALLET     (permanent dev wallet — not the deployer!)
 *   BSC_OPS_WALLET     (permanent ops wallet — not the deployer!)
 */

const { ethers } = require("hardhat");

// ── BSC USDT (Binance-Peg USDT, 18 decimals) ──────────────────────────────
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

// ── Unit: 1e18 for 18-decimal USDT ────────────────────────────────────────
const UNIT = ethers.parseUnits("1", 18); // = 1_000_000_000_000_000_000n

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("=".repeat(60));
  console.log("CryptoNova — BNB Chain Mainnet Deploy");
  console.log("=".repeat(60));
  console.log("Deployer :", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("BNB balance:", ethers.formatEther(balance), "BNB");

  if (balance < ethers.parseEther("0.1")) {
    throw new Error("Low BNB balance — need at least 0.1 BNB for gas");
  }

  // ── Wallet addresses ───────────────────────────────────────────────────
  const devWallet = process.env.BSC_DEV_WALLET  || deployer.address;
  const opsWallet = process.env.BSC_OPS_WALLET  || deployer.address;
  const admin     = deployer.address;

  if (devWallet === deployer.address || opsWallet === deployer.address) {
    console.warn("\n⚠️  WARNING: DEV/OPS wallets are set to the deployer address.");
    console.warn("   Set BSC_DEV_WALLET and BSC_OPS_WALLET in .env before mainnet launch.\n");
  }

  console.log("\nWallet config:");
  console.log("  Dev wallet :", devWallet);
  console.log("  Ops wallet :", opsWallet);
  console.log("  Admin      :", admin);
  console.log("  USDT (BSC) :", USDT_BSC);
  console.log("  Unit (1e18):", UNIT.toString());

  // ── 1. Deploy CNOVAToken ───────────────────────────────────────────────
  console.log("\n[1/3] Deploying CNOVAToken...");
  const Token = await ethers.getContractFactory("CNOVAToken");
  const token = await Token.deploy(admin);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("    ✅ CNOVAToken :", tokenAddr);

  // ── 2. Deploy CNOVATreasury ────────────────────────────────────────────
  console.log("\n[2/3] Deploying CNOVATreasury...");
  const Treasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await Treasury.deploy(tokenAddr, admin);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log("    ✅ CNOVATreasury :", treasuryAddr);

  // ── 3. Deploy CryptoNovaMatrix ─────────────────────────────────────────
  console.log("\n[3/3] Deploying CryptoNovaMatrix...");
  const Matrix = await ethers.getContractFactory("CryptoNovaMatrix");
  const matrix = await Matrix.deploy(
    USDT_BSC,      // stablecoin (USDT on BSC)
    tokenAddr,     // CNOVA token
    treasuryAddr,  // treasury
    devWallet,     // dev wallet
    opsWallet,     // ops wallet
    admin,         // owner/admin
    UNIT           // 1e18 — 18-decimal USDT
  );
  await matrix.waitForDeployment();
  const matrixAddr = await matrix.getAddress();
  console.log("    ✅ CryptoNovaMatrix :", matrixAddr);

  // ── 4. Wire contracts ──────────────────────────────────────────────────
  console.log("\n[4/4] Wiring contracts...");

  // Grant Matrix the MINTER_ROLE on CNOVAToken
  const MINTER_ROLE = await token.MINTER_ROLE();
  await token.grantRole(MINTER_ROLE, matrixAddr);
  console.log("    ✅ MINTER_ROLE granted to Matrix");

  // Grant Matrix the BURNER_ROLE on CNOVAToken
  const BURNER_ROLE = await token.BURNER_ROLE();
  await token.grantRole(BURNER_ROLE, treasuryAddr);
  console.log("    ✅ BURNER_ROLE granted to Treasury");

  // Register Matrix with Treasury
  await treasury.setMatrix(matrixAddr);
  console.log("    ✅ Matrix registered with Treasury");

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("✅  DEPLOY COMPLETE — BNB Chain");
  console.log("=".repeat(60));
  console.log("CNOVAToken      :", tokenAddr);
  console.log("CNOVATreasury   :", treasuryAddr);
  console.log("CryptoNovaMatrix:", matrixAddr);
  console.log("USDT (BSC)      :", USDT_BSC);
  console.log("Unit            : 1e18 (18-decimal USDT)");
  console.log("Chain           : BNB Smart Chain (56)");
  console.log("=".repeat(60));

  console.log("\n📋 Save these addresses to your .env and frontend config!");
  console.log("\n🔍 Verify commands:");
  console.log(`npx hardhat verify --network bscMainnet ${tokenAddr} "${admin}"`);
  console.log(`npx hardhat verify --network bscMainnet ${treasuryAddr} "${tokenAddr}" "${admin}"`);
  console.log(`npx hardhat verify --network bscMainnet ${matrixAddr} "${USDT_BSC}" "${tokenAddr}" "${treasuryAddr}" "${devWallet}" "${opsWallet}" "${admin}" "${UNIT.toString()}"`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
