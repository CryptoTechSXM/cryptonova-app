"use strict";
const { ethers } = require("hardhat");

const MX_ADDR = "0x171cb088d489E4cc9856d795fB942A6dFE19a385";  // Midscale v2 Belt A T1
const BM_ADDR = "0x8FC04BFc5675428dBC81C0337bf6AF0fe16f4fdc";  // Midscale v2 T1 BeltManager
const W1 = "0x19a59fbD6d2c1289668795D41453e1505B7B8102";

async function main() {
  const mx = await ethers.getContractAt("CryptoNovaMatrixV6", MX_ADDR);
  const bm = await ethers.getContractAt("BeltManagerV6", BM_ADDR);

  const m = await mx.getMember(W1);
  const pos = await mx.matrixPos(W1);
  const totalJoined = await mx.totalMembers();
  const rotations = await mx.rotationCount();
  const occupancy = await mx.occupancy();
  const queuePos = await bm.queuePosition(W1);
  const beltIdx = await bm.memberBeltIndex(W1);

  console.log("\n=== WALLET #1 STATE ===");
  console.log("Member ID    :", m.id.toString());
  console.log("Cycles done  :", m.cyclesCompleted.toString());
  console.log("Withdrawable :", ethers.formatUnits(m.withdrawable, 6));
  console.log("Total earned :", ethers.formatUnits(m.totalEarned, 6));
  console.log("isInMatrix   :", m.isInMatrix);
  console.log("matrixPos    :", pos.toString());
  console.log("doubleReentry:", await bm.doubleReentry(W1));
  console.log("queuePos     :", queuePos.toString(), "(0 = not in queue)");
  console.log("beltIndex    :", beltIdx.toString());
  console.log("\n=== MATRIX STATE ===");
  console.log("totalJoined  :", totalJoined.toString());
  console.log("rotations    :", rotations.toString());
  console.log("occupancy    :", occupancy.toString());
  console.log("\n=== CURRENT MATRIX POSITIONS ===");
  for(let i=1;i<=7;i++){
    const a = await mx.posToMember(i);
    if(a !== ethers.ZeroAddress){
      const mm = await mx.getMember(a);
      console.log(`  Pos ${i}: ${a.slice(0,8)}... | withdrawable: $${ethers.formatUnits(mm.withdrawable,6)}`);
    } else {
      console.log(`  Pos ${i}: empty`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
