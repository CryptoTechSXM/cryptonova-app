"use strict";
const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    "scripts/deployed_addresses_v8_2.json", "utf8"
  ));

  const [rawSigner] = await ethers.getSigners();
  const usdc  = await ethers.getContractAt("MockUSDC",             addrs.usdc,          rawSigner);
  const matA1 = await ethers.getContractAt("FigureEightMatrixV8",  addrs.tiers.T1.matA, rawSigner);
  const matB1 = await ethers.getContractAt("FigureEightMatrixV8",  addrs.tiers.T1.matB, rawSigner);
  const T1_FEE = await matA1.ENTRY_FEE();

  console.log("── Trying forceCross on MatA for W1 ────────────────");
  const W1 = "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435";

  // forceCross: deployer approves MatA for T1_FEE, MatA pulls it and crosses W1 to MatB
  const approveTx = await usdc.approve(await matA1.getAddress(), T1_FEE);
  await approveTx.wait();
  console.log("  ✓ Approved MatA for $" + Number(T1_FEE)/1e6);

  try {
    const crossTx = await matA1.forceCross(W1, { gasLimit: 3_000_000 });
    const receipt = await crossTx.wait();
    console.log("  ✓ forceCross succeeded! gasUsed:", receipt.gasUsed.toString());

    const occ = await matB1.occupancy();
    const w1B = await matB1.getMember(W1);
    const w1BPos = await matB1.matrixPos(W1);
    console.log("  MatB occupancy:", occ.toString());
    console.log("  W1 in MatB:", w1B.isInMatrix, "pos:", w1BPos.toString());
  } catch(e) {
    console.log("  ✗ forceCross FAILED");
    // Try to get revert reason
    try {
      await ethers.provider.call({
        to: await matA1.getAddress(),
        data: matA1.interface.encodeFunctionData("forceCross", [W1]),
        from: rawSigner.address,
        gasLimit: 3_000_000,
      });
    } catch(callErr) {
      console.log("  Revert reason:", callErr.reason || callErr.data || callErr.message.slice(0,200));
    }
    console.log("  Error:", e.shortMessage || e.message.slice(0,200));
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
