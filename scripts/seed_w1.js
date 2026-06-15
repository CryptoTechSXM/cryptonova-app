"use strict";
/**
 * seed_w1.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers W1 (accountOne / the seed root) as position-1 member of T1 MatA.
 *
 * W1 must be at position-1 (root) so its escrow accumulates orphan fees from
 * every subsequent registrant and it can auto-upgrade to T2 after a full cycle.
 *
 * Env vars required:
 *   SEED_W1_KEY  — private key of the accountOne wallet (0x6512e9B5…)
 *
 * Env vars optional:
 *   ADDRESSES_FILE — path to deployed JSON (default: deployed_addresses_v8_13.json)
 *
 * Run:
 *   $env:SEED_W1_KEY="0x<key>"; npx hardhat run scripts/seed_w1.js --network baseSepolia
 */
const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_13.json"
);
const ETH_FOR_GAS = ethers.parseEther("0.02");  // 0.02 ETH covers approve + register

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`\n❌  ${ADDRESSES_FILE} not found. Run deploy_v8.js first.`);
    process.exit(1);
  }

  const w1Key = process.env.SEED_W1_KEY || process.env.W1_PRIVATE_KEY;
  if (!w1Key) {
    console.error("\n❌  Neither SEED_W1_KEY nor W1_PRIVATE_KEY is set.");
    console.error("    Set W1_PRIVATE_KEY in .env  -or-");
    console.error("    $env:SEED_W1_KEY=\"0x<private-key>\"");
    process.exit(1);
  }

  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [rawSigner]  = await ethers.getSigners();
  const deployer     = new NonceManager(rawSigner);
  const deployerAddr = rawSigner.address;

  const w1Wallet  = new ethers.Wallet(w1Key, ethers.provider);
  const W1_ADDR   = w1Wallet.address;

  console.log(`Deployer: ${deployerAddr}`);
  console.log(`W1 addr:  ${W1_ADDR}`);
  console.log(`Addresses: ${ADDRESSES_FILE}\n`);

  // Guard: must match accountOne in the deployment
  if (W1_ADDR.toLowerCase() !== addrs.accountOne.toLowerCase()) {
    console.warn(`⚠  SEED_W1_KEY resolves to ${W1_ADDR}`);
    console.warn(`   but accountOne in JSON is  ${addrs.accountOne}`);
    console.warn(`   Proceeding anyway — W1 will be registered under ${W1_ADDR}`);
  }

  const usdc       = await ethers.getContractAt("MockUSDC",   addrs.usdc,       deployer);
  const tierRouter = await ethers.getContractAt("TierRouter", addrs.tierRouter, deployer);

  const T1_PM   = addrs.tiers.T1.pm;
  const T1_FEE  = await (await ethers.getContractAt("PairManagerV8", T1_PM)).entryFee();

  console.log(`T1 PM:    ${T1_PM}`);
  console.log(`T1 fee:   $${Number(T1_FEE) / 1e6}`);

  // ── Guard: already registered? ─────────────────────────────────────────────
  const alreadyJoined = await tierRouter.globalJoined(W1_ADDR);
  if (alreadyJoined) {
    const tier = await tierRouter.memberHighestTier(W1_ADDR);
    console.log(`\n✓  W1 already registered (tier ${tier}) — nothing to do.`);
    return;
  }

  // ── 1. Fund W1 with ETH for gas ────────────────────────────────────────────
  const ethBal = await ethers.provider.getBalance(W1_ADDR);
  if (ethBal < ETH_FOR_GAS / 2n) {
    console.log(`\n── Sending ETH to W1 for gas…`);
    const deployerEth = await ethers.provider.getBalance(deployerAddr);
    if (deployerEth < ETH_FOR_GAS) {
      console.error(`❌  Deployer only has ${ethers.formatEther(deployerEth)} ETH — need ${ethers.formatEther(ETH_FOR_GAS)}`);
      process.exit(1);
    }
    await (await deployer.sendTransaction({ to: W1_ADDR, value: ETH_FOR_GAS })).wait();
    console.log(`   ✓ Sent ${ethers.formatEther(ETH_FOR_GAS)} ETH to W1`);
  } else {
    console.log(`\n── W1 ETH: ${ethers.formatEther(ethBal)} ETH — sufficient`);
  }

  // ── 2. Mint USDC to W1 ─────────────────────────────────────────────────────
  const usdcBal = await usdc.balanceOf(W1_ADDR);
  if (usdcBal < T1_FEE) {
    console.log(`── Minting $${Number(T1_FEE) / 1e6} USDC to W1…`);
    await (await usdc.mint(W1_ADDR, T1_FEE)).wait();
    console.log(`   ✓ Minted`);
  } else {
    console.log(`── W1 USDC: $${Number(usdcBal) / 1e6} — sufficient`);
  }

  // Give RPC a moment to reflect funded balances
  await new Promise(r => setTimeout(r, 4000));

  // ── 3. W1 approves T1 PairManager ─────────────────────────────────────────
  // CRITICAL: approval must be on T1.pm (PairManager) — NOT TierRouter.
  // PairManager.registerDirectFor calls usdc.safeTransferFrom(member, matA, fee)
  // so the spender must be the PairManager address.
  const allowance = await usdc.allowance(W1_ADDR, T1_PM);
  if (allowance < T1_FEE) {
    console.log(`── W1 approving T1 PM (${T1_PM.slice(0,10)})…`);
    await (await usdc.connect(w1Wallet).approve(T1_PM, T1_FEE)).wait();
    console.log(`   ✓ Approved`);
  } else {
    console.log(`── W1 T1 PM allowance: $${Number(allowance) / 1e6} — sufficient`);
  }

  // ── 4. W1 registers via TierRouter ────────────────────────────────────────
  console.log(`── W1 calling TierRouter.register(address(0))…`);
  const regTx = await tierRouter.connect(w1Wallet).register(
    ethers.ZeroAddress,
    { gasLimit: 3_000_000 }
  );
  const receipt = await regTx.wait();
  console.log(`   ✓ Registered  gasUsed: ${receipt.gasUsed}  txHash: ${receipt.hash.slice(0,14)}…`);

  // ── 5. Verify ──────────────────────────────────────────────────────────────
  const joined  = await tierRouter.globalJoined(W1_ADDR);
  const tier    = await tierRouter.memberHighestTier(W1_ADDR);
  const matA1   = await ethers.getContractAt("FigureEightMatrixV8", addrs.tiers.T1.matA);
  const member  = await matA1.getMember(W1_ADDR);
  const bfsPos  = await matA1.matrixPos(W1_ADDR);   // position lives in matrixPos mapping
  const occ     = await matA1.occupancy();
  const mSize   = await matA1.MATRIX_SIZE();

  console.log(`\n  globalJoined:      ${joined}`);
  console.log(`  highestTier:       T${tier}`);
  console.log(`  T1 MatA position:  ${bfsPos}`);
  console.log(`  T1 MatA isActive:  ${member.isInMatrix}`);
  console.log(`  T1 MatA occupancy: ${occ} / ${mSize}`);

  if (joined && bfsPos === 1n) {
    console.log(`\n  ✅  W1 is at position-1 (root) of T1 MatA.`);
    console.log(`      Every subsequent registrant's orphan L1 fee (~$1.00) flows`);
    console.log(`      to W1's escrow.  After ${mSize - 1n} more join, W1 cycles out`);
    console.log(`      with ~$${Math.round(Number(mSize - 1n) * 1.0)} escrow and auto-upgrades to T2.`);
    console.log(`\n  Next: run bigfill`);
    console.log(`    $env:COUNT="70"; $env:HDR_OFFSET="500"; npx hardhat run scripts/bigfill_v8.js --network baseSepolia`);
  } else if (joined && bfsPos !== 1n) {
    console.log(`\n  ⚠  W1 registered but at position ${bfsPos} (not root).`);
    console.log(`     Another member is already at position 1 — W1 won't be the upgrade candidate.`);
  } else {
    console.log(`\n  ❌  Registration may have failed — globalJoined is false.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
