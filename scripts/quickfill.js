"use strict";
/**
 * quickfill.js — Auto-fill the matrix with system wallets
 *
 * Usage:
 *   npx hardhat run scripts/quickfill.js --network baseSepolia
 *
 * What it does:
 *   - Generates COUNT fresh wallets
 *   - Mints test USDC to each ($10.50 each)
 *   - Funds each with ETH for gas
 *   - Registers each in the BeltManager (using the REFERRER address as referrer)
 *
 * Run after each real registration to fill positions around real members.
 * All earnings from system wallets go to whoever they referred through
 * (no referrer = Community Wallet).
 */

const { ethers } = require("hardhat");

// ── CONFIG ─────────────────────────────────────────────────────────────────
const BM_ADDR   = "0x8FC04BFc5675428dBC81C0337bf6AF0fe16f4fdc";  // Midscale v2 BELT_MAX=200
const USDC_ADDR = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";  // MockUSDC
const COUNT     = 120;  // 1 real + 120 quickfill = 121, then 7 real = 128 → first cycle
const REFERRER  = "0x19a59fbD6d2c1289668795D41453e1505B7B8102";  // Wallet #1 as referrer
const ETH_PER_WALLET = ethers.parseEther("0.001");  // Gas money per wallet (0.001 × 70 = 0.07 ETH total)

async function main() {
  const [deployer] = await ethers.getSigners();
  const bm   = await ethers.getContractAt("BeltManagerV6", BM_ADDR);
  const usdc = await ethers.getContractAt("MockUSDC", USDC_ADDR);

  const [totalCost, entryFee] = await bm.registrationCost();
  console.log(`\nEntry fee: $${ethers.formatUnits(entryFee, 6)}`);
  console.log(`Total per wallet (with pool): $${ethers.formatUnits(totalCost, 6)}`);
  console.log(`Filling ${COUNT} positions — total USDC: $${ethers.formatUnits(totalCost * BigInt(COUNT), 6)}`);
  console.log(`ETH per wallet: ${ethers.formatEther(ETH_PER_WALLET)}`);
  console.log(`Deployer: ${deployer.address}\n`);

  const wallets = [];
  for (let i = 0; i < COUNT; i++) {
    wallets.push(ethers.Wallet.createRandom().connect(ethers.provider));
  }

  console.log("Step 1: Funding wallets with ETH for gas...");
  for (const w of wallets) {
    const tx = await deployer.sendTransaction({ to: w.address, value: ETH_PER_WALLET });
    await tx.wait();
  }
  console.log("  ETH funded ✓");

  console.log("Step 2: Minting USDC to each wallet...");
  for (const w of wallets) {
    const tx = await usdc.connect(deployer).mint(w.address, totalCost + 1_000_000n);
    await tx.wait();
  }
  console.log("  USDC minted ✓");

  console.log("Step 3: Registering wallets...");
  let registered = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      // Approve
      const approveTx = await usdc.connect(w).approve(BM_ADDR, totalCost * 2n); // Extra approval buffer
      await approveTx.wait();
      // Register
      const regTx = await bm.connect(w).register(REFERRER);
      await regTx.wait();
      registered++;
      console.log(`  [${registered}/${COUNT}] Registered ${w.address.slice(0,8)}...`);
    } catch (e) {
      console.log(`  [${i+1}/${COUNT}] FAILED: ${e.shortMessage || e.message}`);
      // On failure, wait longer before retrying next wallet
      await new Promise(r => setTimeout(r, 1000));
    }
    // Delay between registrations to let RPC sync (important after belt flips)
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n✅ Done! ${registered}/${COUNT} system wallets registered.`);
  console.log(`Referrer ${REFERRER.slice(0,8)}... earned $${ethers.formatUnits(BigInt(registered) * entryFee * 2500n / 10000n, 6)} in L1 bonuses.`);

  // Show matrix state
  const [bmAddr2] = await bm.beltStatus(0);
  const mx = await ethers.getContractAt("CryptoNovaMatrixV6", bmAddr2);
  console.log(`\nMatrix state after fill:`);
  console.log(`  totalJoined: ${await mx.totalMembers()}`);
  console.log(`  occupancy:   ${await mx.occupancy()}`);
  console.log(`  rotations:   ${await mx.rotationCount()}`);
  console.log(`  activeBelt:  ${await bm.activeBeltIndex()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
