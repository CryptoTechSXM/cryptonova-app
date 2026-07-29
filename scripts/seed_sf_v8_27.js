/**
 * seed_sf_v8_27.js
 * Injects USDC into the V8.27 StabilityFund via receiveLayer().
 * receiveLayer() transfers USDC from the deployer wallet AND updates
 * totalBalance so the dashboard and rescue eligibility both reflect it.
 *
 * Run:
 *   npx hardhat run scripts/seed_sf_v8_27.js --network baseSepolia
 */

const hre = require("hardhat");
const { ethers } = hre;

const SF_ADDR   = "0xd170af139D17ed9aEfA1Ba4C81E3a87078C7b722"; // V8.27 StabilityFund
const USDC_ADDR = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a"; // Base Sepolia USDC

// ── Set seed amount here ────────────────────────────────────────────────
const SEED_USDC = 5000;  // dollars — bigfill flood cover
// ───────────────────────────────────────────────────────────────────────

const SF_ABI = [
  "function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external",
  "function totalBalance() external view returns (uint256)",
  "function stabilityFloor() external view returns (uint256)",
];

const USDC_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const [signer] = await ethers.getSigners(); // plain signer -- no NonceManager

  const sf   = new ethers.Contract(SF_ADDR,   SF_ABI,   signer);
  const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, signer);

  const amount = BigInt(SEED_USDC) * 1_000_000n; // 6 decimals

  console.log("\n-- Seed StabilityFund V8.27 ------------------------------------------");
  console.log("Deployer :", signer.address);
  console.log("SF       :", SF_ADDR);
  console.log("Amount   : $" + SEED_USDC + " USDC");

  // Pre-flight checks
  const deployerBal = await usdc.balanceOf(signer.address);
  const sfBefore    = await sf.totalBalance();
  const sfFloor     = await sf.stabilityFloor();

  console.log("\nDeployer USDC  : $" + (Number(deployerBal) / 1e6).toFixed(2));
  console.log("SF totalBalance: $" + (Number(sfBefore) / 1e6).toFixed(2));
  console.log("SF floor       : $" + (Number(sfFloor) / 1e6).toFixed(2));

  if (deployerBal < amount) {
    console.error("\nERROR: deployer only has $" + (Number(deployerBal)/1e6).toFixed(2) + " -- need $" + SEED_USDC);
    process.exit(1);
  }

  // Step 1: Approve (skip if allowance already sufficient)
  const allowance = await usdc.allowance(signer.address, SF_ADDR);
  if (allowance < amount) {
    console.log("\n[1/2] Approving SF to spend USDC...");
    const approveTx = await usdc.approve(SF_ADDR, amount);
    await approveTx.wait();
    console.log("      Approved.");
    console.log("      Waiting 4s for RPC to clear in-flight limit...");
    await sleep(4000);
  } else {
    console.log("\n[1/2] Allowance already sufficient -- skipping approve.");
  }

  // Step 2: receiveLayer (tier=0, layer=1 = pool carve -- standard deposit path)
  console.log("[2/2] Calling receiveLayer...");
  const tx = await sf.receiveLayer(0, amount, 1, { gasLimit: 200_000 });
  console.log("      TX sent:", tx.hash);
  const receipt = await tx.wait();
  console.log("      Confirmed -- block", receipt.blockNumber, " status", receipt.status === 1 ? "OK" : "FAILED");

  // Verify
  const sfAfter = await sf.totalBalance();
  console.log("\nSF totalBalance before : $" + (Number(sfBefore) / 1e6).toFixed(2));
  console.log("SF totalBalance after  : $" + (Number(sfAfter)  / 1e6).toFixed(2));
  console.log("Delta                  : +$" + ((Number(sfAfter) - Number(sfBefore)) / 1e6).toFixed(2));
  console.log("\nStability Fund seeded. Keeper rescues now have SF backing.");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
