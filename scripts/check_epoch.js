"use strict";
const { ethers } = require("hardhat");
const CNOVA = "0xC16f4BD8Dd2294629650ebb74D075E977aD4552D";
async function main() {
  const tk = await ethers.getContractAt("CNOVAToken", CNOVA);
  console.log("currentEpoch:", (await tk.currentEpoch()).toString());
  console.log("epochMemberCount:", (await tk.epochMemberCount()).toString());
  console.log("totalMinted:", ethers.formatEther(await tk.totalMinted()));
  console.log("MAX_SUPPLY:", ethers.formatEther(await tk.MAX_SUPPLY()));
  console.log("TOTAL_EPOCHS:", (await tk.TOTAL_EPOCHS()).toString());
  console.log("EPOCH_MEMBER_LIMIT:", (await tk.EPOCH_MEMBER_LIMIT()).toString());
  console.log("currentRewardPerEntry:", ethers.formatEther(await tk.currentRewardPerEntry()));
  console.log("currentEpochNumber:", (await tk.currentEpochNumber()).toString());
  console.log("epochRewards[0]:", ethers.formatEther(await tk.epochRewards(0)));
  console.log("epochRewards[8]:", ethers.formatEther(await tk.epochRewards(8)));
  console.log("isFinalFrontier:", await tk.isFinalFrontier());
}
main().catch(e => { console.error(e); process.exit(1); });
