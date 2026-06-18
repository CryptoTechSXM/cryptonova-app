"use strict";
const { ethers } = require("hardhat");

const BM_T1    = "0x8E6178f31325ca63C4670704E0F75b159d772475";
const BELT_A   = "0xb26d517D3F67FE100f8AafEe43ba5F5e3bDf8260";
const TREASURY = "0x6D9b6A28aB20197D0202dDbB5B4e4223769629dF";
const USDC     = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const MEMBER   = "0x19a59fbD6d2c1289668795D41453e1505B7B8102";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const usdc = await ethers.getContractAt("MockUSDC", USDC);
  const bm   = await ethers.getContractAt("BeltManagerV6", BM_T1);
  const mx   = await ethers.getContractAt("CryptoNovaMatrixV6", BELT_A);
  const tr   = await ethers.getContractAt("CNOVATreasury", TREASURY);

  const fmt = v => "$" + (Number(v)/1e6).toFixed(4);

  console.log("\n=== USDC Balance Check ===");
  console.log("BeltManagerV6 USDC balance:", fmt(await usdc.balanceOf(BM_T1)));
  console.log("Belt A matrix USDC balance:", fmt(await usdc.balanceOf(BELT_A)));
  console.log("Treasury USDC balance:     ", fmt(await usdc.balanceOf(TREASURY)));

  console.log("\n=== Authorization Check ===");
  const isBMAuthorized  = await mx.authorizedCallers(BM_T1);
  const isMXAuth        = await tr.authorizedCallers(BELT_A).catch(()=>
    tr.isAuthorizedCaller ? tr.isAuthorizedCaller(BELT_A) : "N/A");
  console.log("Belt A authorized in matrix:", isBMAuthorized, "(BeltManager should be true)");
  console.log("Belt A authorized in treasury:", isMXAuth);

  console.log("\n=== Simulate enterMatrix (static call) ===");
  try {
    await mx.enterMatrix.staticCall(MEMBER, ethers.ZeroAddress, { from: BM_T1 });
    console.log("Static call PASSED — enterMatrix would succeed");
  } catch(e) {
    console.log("Static call FAILED:", e.reason || e.message);
  }

  console.log("\n=== Matrix state ===");
  console.log("MATRIX_SIZE:", (await mx.MATRIX_SIZE()).toString());
  console.log("occupancy:  ", (await mx.occupancy()).toString());
  console.log("nextSlot:   ", (await mx.nextSlot()).toString());
  console.log("ENTRY_FEE:  ", fmt(await mx.ENTRY_FEE()));
  console.log("tierManager:", await mx.tierManager());
  console.log("communityWallet:", await mx.communityWallet());
}
main().catch(e => { console.error(e); process.exit(1); });
