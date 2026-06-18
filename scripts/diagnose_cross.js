"use strict";
/**
 * diagnose_cross.js
 * ────────────────────────────────────────────────────────────────────────────
 * Deep-dives the MatA→MatB cycle cross to identify the exact revert reason.
 *
 * Checks:
 *   1. treasury.authorizedCallers(MatA / MatB)
 *   2. stabilityFund.authorizedMatrices(MatA / MatB)
 *   3. All BPS splits sum + values
 *   4. USDC allowances in play (MatA→MatB, MatB→treasury)
 *   5. Static-call simulation of forceCross to extract the revert string
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(
    fs.readFileSync("scripts/deployed_addresses_v8_2.json", "utf8")
  );

  const [deployer] = await ethers.getSigners();

  const usdc     = await ethers.getContractAt("MockUSDC",              addrs.usdc,            deployer);
  const treasury = await ethers.getContractAt("CNOVATreasury",         addrs.treasury,        deployer);
  const sf       = await ethers.getContractAt("StabilityFund",         addrs.stabilityFund,   deployer);
  const matA1    = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T1.matA,   deployer);
  const matB1    = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T1.matB,   deployer);
  const matA2    = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T2.matA,   deployer);
  const matB2    = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T2.matB,   deployer);

  const W1 = "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435";

  const matAAddr = addrs.tiers.T1.matA;
  const matBAddr = addrs.tiers.T1.matB;
  const matA2Addr = addrs.tiers.T2.matA;
  const matB2Addr = addrs.tiers.T2.matB;

  console.log("════════════════════════════════════════════════════════════");
  console.log("  diagnose_cross.js — cycle-out revert investigation");
  console.log("════════════════════════════════════════════════════════════\n");

  // ── 1. Treasury authorization ────────────────────────────────────────────
  console.log("── 1. Treasury.authorizedCallers ────────────────────────────");
  const tAuthMatA1 = await treasury.authorizedCallers(matAAddr);
  const tAuthMatB1 = await treasury.authorizedCallers(matBAddr);
  const tAuthMatA2 = await treasury.authorizedCallers(matA2Addr);
  const tAuthMatB2 = await treasury.authorizedCallers(matB2Addr);
  console.log(`  T1 MatA: ${tAuthMatA1 ? "✓ authorized" : "✗ NOT AUTHORIZED ← ISSUE"}`);
  console.log(`  T1 MatB: ${tAuthMatB1 ? "✓ authorized" : "✗ NOT AUTHORIZED ← ISSUE"}`);
  console.log(`  T2 MatA: ${tAuthMatA2 ? "✓ authorized" : "✗ NOT AUTHORIZED"}`);
  console.log(`  T2 MatB: ${tAuthMatB2 ? "✓ authorized" : "✗ NOT AUTHORIZED"}`);

  // ── 2. StabilityFund authorization ───────────────────────────────────────
  console.log("\n── 2. StabilityFund.authorizedMatrices ──────────────────────");
  const sfAuthMatA1 = await sf.authorizedMatrices(matAAddr);
  const sfAuthMatB1 = await sf.authorizedMatrices(matBAddr);
  const sfAuthMatA2 = await sf.authorizedMatrices(matA2Addr);
  const sfAuthMatB2 = await sf.authorizedMatrices(matB2Addr);
  console.log(`  T1 MatA: ${sfAuthMatA1 ? "✓" : "✗ NOT AUTHORIZED (try/catch guards this)"}`);
  console.log(`  T1 MatB: ${sfAuthMatB1 ? "✓" : "✗ NOT AUTHORIZED (try/catch guards this)"}`);
  console.log(`  T2 MatA: ${sfAuthMatA2 ? "✓" : "✗"}`);
  console.log(`  T2 MatB: ${sfAuthMatB2 ? "✓" : "✗"}`);

  // ── 3. T1 MatB BPS splits ────────────────────────────────────────────────
  console.log("\n── 3. T1 MatB BPS splits & fee ──────────────────────────────");
  const fee     = await matB1.ENTRY_FEE();
  const l1Bps   = await matB1.SPLIT_L1_BPS();
  const l2Bps   = await matB1.SPLIT_L2_BPS();
  const l3Bps   = await matB1.SPLIT_L3_BPS();
  const chainBps = await matB1.SPLIT_CHAIN_BPS();
  const poolBps  = await matB1.SPLIT_POOL_BPS();
  const tresBps  = await matB1.SPLIT_TREASURY_BPS();
  const devBps   = await matB1.SPLIT_DEVOPS_BPS();
  const stabBps  = await matB1.SPLIT_STABILITY_BPS();
  const sum      = l1Bps + l2Bps + l3Bps + chainBps + poolBps + tresBps + devBps + stabBps;
  console.log(`  ENTRY_FEE:      $${Number(fee)/1e6}`);
  console.log(`  L1:             ${l1Bps}  ($${Number(fee)*Number(l1Bps)/1e10})`);
  console.log(`  L2:             ${l2Bps}`);
  console.log(`  L3:             ${l3Bps}`);
  console.log(`  Chain:          ${chainBps}`);
  console.log(`  Pool:           ${poolBps}`);
  console.log(`  Treasury:       ${tresBps}  ($${Number(fee)*Number(tresBps)/1e10})`);
  console.log(`  DevOps:         ${devBps}`);
  console.log(`  Stability:      ${stabBps}`);
  console.log(`  SUM:            ${sum}  ${sum === 10000n ? "✓" : "✗ NOT 10000!"}`);

  // ── 4. USDC allowances ───────────────────────────────────────────────────
  console.log("\n── 4. Current USDC allowances ────────────────────────────────");
  const deployerBal  = await usdc.balanceOf(deployer.address);
  const matAAllow    = await usdc.allowance(deployer.address, matAAddr);
  const matBAllow    = await usdc.allowance(matAAddr, matBAddr);
  const tresAllow    = await usdc.allowance(matBAddr, addrs.treasury);
  const sfAllow      = await usdc.allowance(matBAddr, addrs.stabilityFund);
  console.log(`  Deployer USDC bal:            $${Number(deployerBal)/1e6}`);
  console.log(`  Deployer → MatA allowance:    $${Number(matAAllow)/1e6}`);
  console.log(`  MatA → MatB allowance:        $${Number(matBAllow)/1e6}  (set by forceCross/crossToPartner)`);
  console.log(`  MatB → Treasury allowance:    $${Number(tresAllow)/1e6}  (set by forceApprove in distribute)`);
  console.log(`  MatB → StabilityFund allow:   $${Number(sfAllow)/1e6}`);

  // ── 5. MatA & MatB current state ────────────────────────────────────────
  console.log("\n── 5. Current matrix state ───────────────────────────────────");
  const matAOcc   = await matA1.occupancy();
  const matANext  = await matA1.nextSlot();
  const matBOcc   = await matB1.occupancy();
  const matABal   = await usdc.balanceOf(matAAddr);
  const matBBal   = await usdc.balanceOf(matBAddr);
  const w1EscA    = await matA1.escrowBalance(W1);
  const w1WdrA    = (await matA1.getMember(W1)).withdrawable;
  const mSize     = await matA1.MATRIX_SIZE();
  console.log(`  MatA occupancy: ${matAOcc} / ${mSize}  nextSlot: ${matANext}`);
  console.log(`  MatB occupancy: ${matBOcc} / ${mSize}`);
  console.log(`  MatA USDC:      $${Number(matABal)/1e6}`);
  console.log(`  MatB USDC:      $${Number(matBBal)/1e6}`);
  console.log(`  W1 escrow (A):  $${Number(w1EscA)/1e6}`);
  console.log(`  W1 earns  (A):  $${Number(w1WdrA)/1e6}`);
  console.log(`  W1 total (A):   $${(Number(w1EscA)+Number(w1WdrA))/1e6}  (need $${Number(fee)/1e6} for cross)`);

  // ── 6. Simulate forceCross via eth_call to get exact revert reason ────────
  console.log("\n── 6. forceCross simulation (eth_call) ───────────────────────");
  // First set allowance so the forceCross safeTransferFrom doesn't fail:
  const deployerAllowance = await usdc.allowance(deployer.address, matAAddr);
  if (deployerAllowance < fee) {
    console.log(`  Setting deployer→MatA allowance to $${Number(fee)/1e6} for simulation…`);
    await (await usdc.approve(matAAddr, fee)).wait();
  }

  // Try as a normal tx first (to get tx hash for etherscan):
  try {
    const tx = await matA1.forceCross(W1, { gasLimit: 3_000_000 });
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      console.log(`  ✓ forceCross SUCCEEDED! gasUsed: ${receipt.gasUsed}`);
      const w1InB = await matB1.getMember(W1);
      console.log(`  W1 in MatB: isInMatrix=${w1InB.isInMatrix} hasEverJoined=${w1InB.hasEverJoined}`);
    } else {
      console.log(`  ✗ tx confirmed but status=0  hash: ${receipt.hash}`);
    }
  } catch (sendErr) {
    console.log(`  ✗ forceCross tx failed: ${sendErr.shortMessage || sendErr.message.slice(0,120)}`);

    // Try eth_call to get revert reason:
    try {
      await ethers.provider.call({
        from:     deployer.address,
        to:       matAAddr,
        data:     matA1.interface.encodeFunctionData("forceCross", [W1]),
        gasLimit: 3_000_000,
      });
      console.log(`  (eth_call succeeded — issue may be gas or nonce related)`);
    } catch (callErr) {
      const reason = callErr.reason
        || (callErr.data ? ethers.toUtf8String("0x" + callErr.data.slice(10)) : null)
        || callErr.message.slice(0, 300);
      console.log(`  Revert reason: ${reason}`);
      // Also log raw error data:
      if (callErr.data) {
        console.log(`  Raw error data: ${callErr.data}`);
      }
    }
  }

  console.log("\n════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
