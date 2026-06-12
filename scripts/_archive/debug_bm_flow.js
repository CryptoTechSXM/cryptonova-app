"use strict";
const { ethers } = require("hardhat");

const BM_T1  = "0x8E6178f31325ca63C4670704E0F75b159d772475";
const BELT_A = "0xb26d517D3F67FE100f8AafEe43ba5F5e3bDf8260";
const USDC   = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const TEST_MEMBER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // signers[1]

async function main() {
  const [deployer] = await ethers.getSigners();
  const usdc = await ethers.getContractAt("MockUSDC", USDC);
  const bm   = await ethers.getContractAt("BeltManagerV6", BM_T1);
  const mx   = await ethers.getContractAt("CryptoNovaMatrixV6", BELT_A);

  // Use deployer as test member (create fresh wallet for unregistered test)
  const testWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  // Fund with ETH for gas
  await deployer.sendTransaction({ to: testWallet.address, value: ethers.parseEther("0.01") });
  // Mint $10 USDC
  await usdc.connect(deployer).mint(testWallet.address, 10_000_000n);
  console.log("Test wallet:", testWallet.address);
  console.log("USDC balance:", (Number(await usdc.balanceOf(testWallet.address))/1e6).toFixed(2));

  // Approve BeltManager
  const [cost] = await bm.registrationCost();
  console.log("Registration cost:", (Number(cost)/1e6).toFixed(2));
  await usdc.connect(testWallet).approve(BM_T1, cost);
  console.log("Approved. Allowance:", (Number(await usdc.allowance(testWallet.address, BM_T1))/1e6).toFixed(2));

  console.log("\nCalling bm.register...");
  try {
    const tx = await bm.connect(testWallet).register(ethers.ZeroAddress);
    const receipt = await tx.wait();
    console.log("register() TX succeeded. Gas used:", receipt.gasUsed.toString());
    console.log("Belt A totalJoined after:", (await mx.totalMembers()).toString());
    console.log("Member isInMatrix:", (await mx.getMember(testWallet.address)).isInMatrix);
    console.log("BM totalMembers:", (await bm.totalMembers()).toString());
  } catch(e) {
    console.log("register() FAILED:", e.reason || e.shortMessage || e.message || String(e));
    if (e.data) console.log("Error data:", e.data);
    // Check if USDC got pulled or stayed with wallet
    console.log("Wallet USDC after fail:", (Number(await usdc.balanceOf(testWallet.address))/1e6).toFixed(2));
    console.log("BM USDC after fail:", (Number(await usdc.balanceOf(BM_T1))/1e6).toFixed(2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
