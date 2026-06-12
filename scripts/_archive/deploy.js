/**
 * CryptoNova Deploy Script — Base Chain  (v2: auto re-entry, referrer-for-life)
 * ─────────────────────────────────────────────────────────────────
 * Deploy order (each depends on the previous):
 *   1. CNOVAToken      — BEP20/ERC-20 CNOVA token
 *   2. CNOVATreasury   — USDC reserve + rising floor price engine
 *   3. CryptoNovaMatrix — $10 binary matrix, BFS placement, referrals
 *
 * Post-deploy wiring:
 *   4. Grant MINTER_ROLE  on CNOVAToken → Matrix
 *   5. Grant BURNER_ROLE  on CNOVAToken → Treasury
 *   6. Grant EPOCH_ROLE   on CNOVAToken → Matrix
 *   7. setMatrixContract  on Treasury   → Matrix address
 *
 * Chain addresses:
 *   Base Mainnet USDC   : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (Circle native)
 *   Base Mainnet USDC decimals: 6  ← NOTE: Base USDC uses 6 decimals unlike BSC!
 *   Aerodrome Router    : 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
 *
 * ⚠️  IMPORTANT — USDC DECIMALS ON BASE:
 *     Circle's native USDC on Base uses 6 decimals (not 18).
 *     The contracts currently use 1e18 as the decimal base.
 *     Before deploying to Base mainnet, confirm the USDC decimal
 *     count by calling usdc.decimals() and adjust ENTRY_FEE
 *     and all SPLIT constants in CryptoNovaMatrix.sol accordingly:
 *       $10.00 with 6 decimals = 10_000_000 (10 * 1e6)
 *     Or deploy with a wrapped/18-decimal USDC variant.
 *     The MockUSDC for testnet uses 18 decimals — fine for testing.
 *
 * Usage:
 *   Base Sepolia (testnet): npx hardhat run scripts/deploy.js --network baseSepolia
 *   Base Mainnet:           npx hardhat run scripts/deploy.js --network baseMainnet
 *   Local:                  npx hardhat run scripts/deploy.js --network hardhat
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY
 *   DEV_WALLET_ADDRESS    — receives $0.30/entry dev fee
 *   OPS_WALLET_ADDRESS    — receives $0.20/entry ops fee
 *   USDC_ADDRESS          — leave blank on testnet (MockUSDC auto-deployed)
 */

const { ethers } = require("hardhat");
require("dotenv").config();

// ─── Chain addresses ─────────────────────────────────────────────────────────
const ADDRESSES = {
  // Base Mainnet
  8453: {
    usdc:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // Circle native USDC (6 dec)
    router:  "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",  // Aerodrome Router
    name:    "Base Mainnet",
  },
  // Base Sepolia Testnet
  84532: {
    usdc:    "0xc7D007D60210eAF1C291B4873A0d285De0B97C8F",  // existing MockUSDC — reuse, no redeploy
    router:  null,
    name:    "Base Sepolia",
  },
  // BNB Chain Mainnet (future expansion)
  56: {
    usdc:    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",  // Binance-pegged USDC (18 dec)
    router:  "0x10ED43C718714eb63d5aA57B78B54704E256024E",  // PancakeSwap V2 Router
    name:    "BNB Chain Mainnet",
  },
  // Local hardhat
  31337: {
    usdc:    null,
    router:  null,
    name:    "Hardhat Local",
  },
};

// Wait for N block confirmations — prevents "could not decode result data" on testnets
const waitConfirm = async (contract, confirmations = 2) => {
  const tx = contract.deploymentTransaction();
  if (tx) await tx.wait(confirmations);
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const chainId    = Number(network.chainId);
  const chainInfo  = ADDRESSES[chainId] || { usdc: null, router: null, name: `Chain ${chainId}` };

  console.log("═══════════════════════════════════════════════");
  console.log("  CryptoNova — Deploy Script");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Network    : ${chainInfo.name} (chainId: ${chainId})`);
  console.log(`  Deployer   : ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`  Balance    : ${ethers.formatEther(balance)} ETH`);
  console.log("═══════════════════════════════════════════════\n");

  // ── Resolve wallet addresses ─────────────────────────────────────────────────
  const devWallet = process.env.DEV_WALLET_ADDRESS || deployer.address;
  const opsWallet = process.env.OPS_WALLET_ADDRESS || deployer.address;
  let usdcAddress = process.env.USDC_ADDRESS || chainInfo.usdc;

  // Deploy MockUSDC for testnet / local if no address provided
  if (!usdcAddress) {
    console.log("  No USDC_ADDRESS set — deploying MockUSDC for testing...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUsdc = await MockUSDC.deploy(deployer.address);
    await mockUsdc.waitForDeployment();
    usdcAddress = await mockUsdc.getAddress();
    console.log(`  MockUSDC deployed at: ${usdcAddress}`);

    // Mint test USDC to deployer — 6 decimals like real Base USDC
    // 10_000 * 1e6 = $10,000 for testing
    await mockUsdc.mint(deployer.address, ethers.parseUnits("10000", 6));
    console.log("  Minted 10,000 test USDC (6 dec) to deployer\n");
  }

  // ── 1. Deploy CNOVAToken ──────────────────────────────────────────────────────
  console.log("[1/7] Deploying CNOVAToken...");
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnovaToken = await CNOVAToken.deploy(deployer.address);
  await cnovaToken.waitForDeployment();
  await waitConfirm(cnovaToken);
  const cnovaAddress = await cnovaToken.getAddress();
  console.log(`  ✓ CNOVAToken : ${cnovaAddress}`);

  // ── 2. Deploy CNOVATreasury ───────────────────────────────────────────────────
  console.log("\n[2/7] Deploying CNOVATreasury...");
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await CNOVATreasury.deploy(
    cnovaAddress,
    usdcAddress,
    deployer.address
  );
  await treasury.waitForDeployment();
  await waitConfirm(treasury);
  const treasuryAddress = await treasury.getAddress();
  console.log(`  ✓ CNOVATreasury : ${treasuryAddress}`);

  // ── 3. Deploy CryptoNovaMatrix ────────────────────────────────────────────────
  console.log("\n[3/7] Deploying CryptoNovaMatrix...");
  const CryptoNovaMatrix = await ethers.getContractFactory("CryptoNovaMatrix");
  const matrix = await CryptoNovaMatrix.deploy(
    usdcAddress,
    cnovaAddress,
    treasuryAddress,
    devWallet,
    opsWallet,
    deployer.address,
    1_000_000n        // UNIT = 1e6 — Base USDC uses 6 decimals
  );
  await matrix.waitForDeployment();
  await waitConfirm(matrix);
  const matrixAddress = await matrix.getAddress();
  console.log(`  ✓ CryptoNovaMatrix : ${matrixAddress}`);

  // ── 4. Grant MINTER_ROLE → Matrix ─────────────────────────────────────────────
  console.log("\n[4/7] Granting MINTER_ROLE to Matrix...");
  const MINTER_ROLE = await cnovaToken.MINTER_ROLE();
  await (await cnovaToken.grantRole(MINTER_ROLE, matrixAddress)).wait();
  console.log("  ✓ MINTER_ROLE granted");

  // ── 5. Grant BURNER_ROLE → Treasury ───────────────────────────────────────────
  console.log("\n[5/7] Granting BURNER_ROLE to Treasury...");
  const BURNER_ROLE = await cnovaToken.BURNER_ROLE();
  await (await cnovaToken.grantRole(BURNER_ROLE, treasuryAddress)).wait();
  console.log("  ✓ BURNER_ROLE granted");

  // ── 6. Grant EPOCH_ROLE → Matrix ──────────────────────────────────────────────
  console.log("\n[6/7] Granting EPOCH_ROLE to Matrix...");
  const EPOCH_ROLE = await cnovaToken.EPOCH_ROLE();
  await (await cnovaToken.grantRole(EPOCH_ROLE, matrixAddress)).wait();
  console.log("  ✓ EPOCH_ROLE granted");

  // ── 7. Wire Treasury → Matrix ─────────────────────────────────────────────────
  console.log("\n[7/7] Wiring Treasury to Matrix...");
  await (await treasury.setMatrixContract(matrixAddress)).wait();
  console.log("  ✓ Treasury.matrixContract set");

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  DEPLOY COMPLETE ✓");
  console.log("═══════════════════════════════════════════════");
  console.log(`  CNOVAToken       : ${cnovaAddress}`);
  console.log(`  CNOVATreasury    : ${treasuryAddress}`);
  console.log(`  CryptoNovaMatrix : ${matrixAddress}`);
  console.log(`  USDC             : ${usdcAddress}`);
  console.log(`  Dev wallet       : ${devWallet}`);
  console.log(`  Ops wallet       : ${opsWallet}`);
  console.log(`  DEX router       : ${chainInfo.router || "N/A (testnet)"}`);
  console.log("═══════════════════════════════════════════════");

  console.log("\n  Next steps:");
  const networkName = chainId === 8453n ? "baseMainnet" : "baseSepolia";
  console.log(`  1. Verify contracts on BaseScan (${networkName}):`);
  console.log(`       npx hardhat verify --network ${networkName} ${cnovaAddress} "${deployer.address}"`);
  console.log(`       npx hardhat verify --network ${networkName} ${treasuryAddress} "${cnovaAddress}" "${usdcAddress}" "${deployer.address}"`);
  console.log(`       npx hardhat verify --network ${networkName} ${matrixAddress} "${usdcAddress}" "${cnovaAddress}" "${treasuryAddress}" "${devWallet}" "${opsWallet}" "${deployer.address}" "1000000"`);
  console.log("  2. Copy contract addresses to your frontend .env");
  console.log("  3. Test register() with a small entry on testnet");
  console.log("  4. At 500 members: call treasury.setFreeMode() → Universe Mode");
  console.log("  5. Add Aerodrome CNOVA/USDC liquidity via treasury.addDexLiquidity()");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
