"use strict";
const { ethers } = require("hardhat");

const BM_T1    = "0x8E6178f31325ca63C4670704E0F75b159d772475";
const BELT_A   = "0xb26d517D3F67FE100f8AafEe43ba5F5e3bDf8260";
const TREASURY = "0x6D9b6A28aB20197D0202dDbB5B4e4223769629dF";
const USDC     = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const MEMBER   = "0x19a59fbD6d2c1289668795D41453e1505B7B8102";
// Deployer / admin
const ADMIN    = "0xCd0Af6a4116f2062c1594aDf34c1821D45175506";

async function main() {
  const [deployer] = await ethers.getSigners();
  const usdc = await ethers.getContractAt("MockUSDC", USDC);
  const mx   = await ethers.getContractAt("CryptoNovaMatrixV6", BELT_A);

  console.log("\n=== Add deployer as authorized caller on Belt A ===");
  const tx1 = await mx.connect(deployer).setAuthorizedCaller(deployer.address, true);
  await tx1.wait();
  console.log("✓ Deployer now authorized");

  console.log("\n=== Give deployer $10 USDC and approve Belt A ===");
  await (await usdc.connect(deployer).mint(deployer.address, 10_000_000n)).wait();
  await (await usdc.connect(deployer).approve(BELT_A, 10_000_000n)).wait();
  console.log("✓ $10 minted and approved");

  console.log("\n=== Call enterMatrix directly ===");
  try {
    const tx2 = await mx.connect(deployer).enterMatrix(MEMBER, ethers.ZeroAddress);
    await tx2.wait();
    console.log("SUCCESS! enterMatrix worked.");
  } catch(e) {
    const msg = e.reason || e.shortMessage || e.message;
    console.log("FAILED:", msg);
    // Try to extract the revert reason more clearly
    if (e.data) console.log("Error data:", e.data);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
