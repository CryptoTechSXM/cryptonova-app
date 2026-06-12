"use strict";
/**
 * diagnose_cross2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Simulates a FRESH REGISTRATION (the actual failing path) via eth_call
 * to extract the exact revert reason when MatA is full and cycle-out fires.
 *
 * Strategy:
 *   1. Derive a fresh wallet (HDR offset 9999) as the 65th member
 *   2. Mint USDC + approve T1 PM on-chain (two quick txs)
 *   3. eth_call tierRouter.register to get the revert string WITHOUT committing state
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
require("dotenv").config();

async function main() {
  const addrs = JSON.parse(
    fs.readFileSync("scripts/deployed_addresses_v8_2.json", "utf8")
  );

  const [deployer] = await ethers.getSigners();

  const usdc       = await ethers.getContractAt("MockUSDC",             addrs.usdc,          deployer);
  const matA1      = await ethers.getContractAt("FigureEightMatrixV8",  addrs.tiers.T1.matA, deployer);
  const matB1      = await ethers.getContractAt("FigureEightMatrixV8",  addrs.tiers.T1.matB, deployer);
  const tierRouter = await ethers.getContractAt("TierRouter",           addrs.tierRouter,    deployer);

  const T1_PM   = addrs.tiers.T1.pm;
  const T1_FEE  = await matA1.ENTRY_FEE();
  const W1      = "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435";

  console.log("════════════════════════════════════════════════════════════");
  console.log("  diagnose_cross2.js — simulate 65th registration");
  console.log("════════════════════════════════════════════════════════════\n");

  // Current state snapshot
  const occ     = await matA1.occupancy();
  const mSize   = await matA1.MATRIX_SIZE();
  const matBOcc = await matB1.occupancy();
  const w1IsIn  = (await matA1.getMember(W1)).isInMatrix;
  console.log(`  MatA: ${occ}/${mSize}  MatB: ${matBOcc}/64  W1.isInMatrix(MatA): ${w1IsIn}`);

  if (occ < mSize) {
    console.log("\n  MatA is not full yet — cycle won't trigger. Fill to 64 first.");
    process.exit(0);
  }

  // ── Create a fresh random wallet for simulation ────────────────────────────
  const testWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  const TEST_ADDR  = testWallet.address;

  console.log(`\n  Test wallet (idx 9999): ${TEST_ADDR}`);

  // Check if already registered
  const alreadyJoined = await tierRouter.globalJoined(TEST_ADDR);
  if (alreadyJoined) {
    console.log("  Already registered — using different index...");
    // Just exit for simplicity
    process.exit(1);
  }

  // Mint USDC + ETH + approve (these txs commit state but are setup-only)
  const ethBal = await ethers.provider.getBalance(TEST_ADDR);
  if (ethBal < ethers.parseEther("0.01")) {
    console.log("  Sending 0.02 ETH to test wallet...");
    await (await deployer.sendTransaction({ to: TEST_ADDR, value: ethers.parseEther("0.02") })).wait();
  }
  console.log("  Minting USDC to test wallet...");
  await (await usdc.mint(TEST_ADDR, T1_FEE)).wait();
  console.log("  Approving T1 PM...");
  await (await usdc.connect(testWallet).approve(T1_PM, T1_FEE)).wait();

  // Pick any registered member as referrer (use deployer if registered, else address(0))
  const refJoined = await tierRouter.globalJoined(deployer.address);
  const referrer  = refJoined ? deployer.address : ethers.ZeroAddress;
  console.log(`  Referrer: ${referrer.slice(0,10)}… (joined=${refJoined})`);

  // ── eth_call simulation ───────────────────────────────────────────────────
  console.log("\n  Simulating register() as eth_call...");
  try {
    const result = await ethers.provider.call({
      from:     TEST_ADDR,
      to:       addrs.tierRouter,
      data:     tierRouter.interface.encodeFunctionData("register", [referrer]),
      gasLimit: 6_000_000,
    });
    console.log("  ✓ eth_call SUCCEEDED (no revert) — result:", result);
  } catch (callErr) {
    console.log("  ✗ eth_call REVERTED");
    console.log(`  reason:   ${callErr.reason ?? "(null)"}`);
    console.log(`  data:     ${callErr.data   ?? "(null)"}`);
    if (callErr.data && callErr.data.length > 10) {
      // Try to decode as Error(string)
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["string"],
          "0x" + callErr.data.slice(10)
        );
        console.log(`  decoded string: "${decoded[0]}"`);
      } catch(_) {}
      // Try to decode as Panic(uint256)
      if (callErr.data.startsWith("0x4e487b71")) {
        const code = BigInt("0x" + callErr.data.slice(10));
        const panicCodes = {
          1n: "assert failure",
          17n: "arithmetic overflow/underflow",
          18n: "division by zero",
          33n: "out-of-bounds enum value",
          34n: "invalid storage slot",
          51n: "invalid shift",
          81n: "empty array pop",
          0x21n: "invalid enum",
          0x31n: "index out of bounds",
          0x41n: "allocation too large",
          0x51n: "invalid jump",
        };
        console.log(`  Panic code ${code}: ${panicCodes[code] ?? "unknown panic"}`);
      }
    }
    console.log(`  message:  ${callErr.message?.slice(0, 400)}`);
  }

  // ── Also try sending as a real tx for on-chain confirmation ───────────────
  console.log("\n  Sending as real tx to get hash for BaseScan trace...");
  try {
    const tx = await tierRouter.connect(testWallet).register(referrer, { gasLimit: 3_000_000 });
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      console.log(`  ✓ TX SUCCEEDED! gasUsed=${receipt.gasUsed}  hash=${receipt.hash}`);
      console.log("  🎉 Cycle-out is working!");
    } else {
      console.log(`  ✗ TX status=0  gasUsed=${receipt.gasUsed}  hash=${receipt.hash}`);
      console.log(`  → Check BaseScan trace: https://sepolia.basescan.org/tx/${receipt.hash}`);
    }
  } catch (txErr) {
    console.log(`  ✗ TX failed: ${txErr.shortMessage || txErr.message.slice(0,200)}`);
    if (txErr.receipt) {
      console.log(`  hash: ${txErr.receipt.hash}`);
      console.log(`  → Trace: https://sepolia.basescan.org/tx/${txErr.receipt.hash}`);
    }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
