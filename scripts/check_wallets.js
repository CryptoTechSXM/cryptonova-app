const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const funder   = signers[1];

  const depBal  = await ethers.provider.getBalance(deployer.address);
  const depNonce = await ethers.provider.getTransactionCount(deployer.address, "latest");
  const depPend  = await ethers.provider.getTransactionCount(deployer.address, "pending");

  console.log(`Deployer:  ${deployer.address}`);
  console.log(`  ETH:     ${ethers.formatEther(depBal)}`);
  console.log(`  nonce:   ${depNonce} (confirmed)  /  ${depPend} (pending)`);
  console.log(`  stuck:   ${depPend - depNonce} TXs`);

  if (funder && funder.address !== deployer.address) {
    const funBal   = await ethers.provider.getBalance(funder.address);
    const funNonce = await ethers.provider.getTransactionCount(funder.address, "latest");

    // Load USDC from addresses file
    const fs   = require("fs");
    const path = require("path");
    const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "scripts/deployed_addresses_v8_6.json"), "utf8"));
    const usdcAddr = addrs.usdc || addrs.USDC;
    const usdc = await ethers.getContractAt("MockUSDC", usdcAddr);
    const depUsdc  = await usdc.balanceOf(deployer.address);
    const funUsdc  = await usdc.balanceOf(funder.address);

    console.log(`\nFunder:    ${funder.address}`);
    console.log(`  ETH:     ${ethers.formatEther(funBal)}`);
    console.log(`  USDC:    $${Number(funUsdc)/1e6}`);
    console.log(`  nonce:   ${funNonce}`);
    console.log(`\nDeployer USDC: $${Number(depUsdc)/1e6}`);
    console.log(`\nUSAGE ESTIMATE (COUNT=101 wallets, T1_FEE=$10):`);
    const T1_FEE = await (await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA)).ENTRY_FEE();
    const needed = T1_FEE * 101n;
    const ethNeeded = ethers.parseEther("0.02") * 101n;
    console.log(`  USDC needed: $${Number(needed)/1e6}   (funder has: $${Number(funUsdc)/1e6})  ${funUsdc >= needed ? "✓ OK" : "❌ NEED FUND"}`);
    console.log(`  ETH  needed: ${ethers.formatEther(ethNeeded)}  (funder has: ${ethers.formatEther(funBal)})  ${funBal >= ethNeeded ? "✓ OK" : "❌ NEED FUND"}`);
  } else {
    console.log(`\n⚠  FILL_FUNDER_KEY not set — funder = deployer`);
  }
}
main().catch(console.error);
