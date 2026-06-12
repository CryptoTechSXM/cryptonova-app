"use strict";
const { ethers } = require("hardhat");

const BM_T1  = "0x8E6178f31325ca63C4670704E0F75b159d772475";
const BELT_A = "0xb26d517D3F67FE100f8AafEe43ba5F5e3bDf8260";
const TREASURY = "0x6D9b6A28aB20197D0202dDbB5B4e4223769629dF";
const MEMBER  = process.env.MEMBER || "0x19a59fbD6d2c1289668795D41453e1505B7B8102";

async function main() {
  const bm = await ethers.getContractAt("BeltManagerV6", BM_T1);
  const mx = await ethers.getContractAt("CryptoNovaMatrixV6", BELT_A);
  const tr = await ethers.getContractAt("CNOVATreasury", TREASURY);

  console.log("\n=== V6 State Check ===");
  console.log("BeltManager totalMembers:", (await bm.totalMembers()).toString());
  console.log("Belt A totalJoined:",       (await mx.totalMembers()).toString());
  console.log("Belt A occupancy:",          (await mx.occupancy()).toString());
  console.log("Belt A nextSlot:",           (await mx.nextSlot()).toString());
  console.log("Treasury reserve:",         "$" + (Number(await tr.usdcReserve())/1e6).toFixed(4));
  console.log("BM queue length:",           (await bm.queueLength()).toString());
  console.log("BM activeBeltIndex:",        (await bm.activeBeltIndex()).toString());

  const isReg = await bm.hasRegistered(MEMBER);
  console.log(`\nMember ${MEMBER.slice(0,10)}...`);
  console.log("hasRegistered:", isReg);
  if (isReg) {
    const beltAddr = await bm.beltOf(MEMBER);
    console.log("beltOf:", beltAddr);
    const m = await mx.getMember(MEMBER).catch(() => null);
    console.log("isInMatrix:", m?.isInMatrix ?? "N/A");
    console.log("matrixPos:", (await mx.matrixPos(MEMBER)).toString());
    console.log("queuePosition:", (await bm.queuePosition(MEMBER)).toString());
  }
  console.log("===================\n");
}
main().catch(e => { console.error(e); process.exit(1); });
