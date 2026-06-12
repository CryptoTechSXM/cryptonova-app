"use strict";
/**
 * register_w1.js — Register Account #1 (Wallet #1) into Matrix A
 * ─────────────────────────────────────────────────────────────────────────────
 * Wallet #1 is the designated root for the self-test. It must be registered
 * BEFORE running quickfill_f8.js so all L1 referral earnings flow to it.
 *
 * What this script does:
 *   1. Deploys USDC to Wallet #1 from the deployer (mock mint)
 *   2. Registers Wallet #1 into Matrix A with no referrer (first ever member)
 *
 * Requirements:
 *   - W1_PRIVATE_KEY in .env  (private key for 0x19a59fbD6d2c1289668795D41453e1505B7B8102)
 *   - OR the deployer IS Wallet #1 (same key in DEPLOYER_PRIVATE_KEY)
 *
 * Run: npx hardhat run scripts/register_w1.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
const FEE            = 10_000_000n;   // $10 USDC

// Derive W1 address from the private key — no hardcoding, works for any key rotation
if (!process.env.W1_PRIVATE_KEY) {
  console.error("  ❌  W1_PRIVATE_KEY missing from .env");
  process.exit(1);
}
const W1_ADDRESS = new ethers.Wallet(process.env.W1_PRIVATE_KEY).address;

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("  deployed_addresses.json not found — run deploy_figure8_test.js first");
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [deployer] = await ethers.getSigners();
  const matA = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const usdc  = await ethers.getContractAt("MockUSDC",          addrs.USDC);

  // Check if already registered
  const existing = await matA.getMember(W1_ADDRESS);
  if (existing.hasEverJoined) {
    console.log(`\n  ✅  Wallet #1 already registered in Matrix A`);
    console.log(`  Position: ${await matA.matrixPos(W1_ADDRESS)}`);
    console.log(`  You can now run: npx hardhat run scripts/quickfill_f8.js --network baseSepolia\n`);
    return;
  }

  console.log(`\n  ─── Registering Wallet #1 ──────────────────────────────`);
  console.log(`  Address:  ${W1_ADDRESS}`);
  console.log(`  Matrix A: ${addrs.MatrixA}`);

  // Option A: deployer IS Wallet #1
  if (deployer.address.toLowerCase() === W1_ADDRESS.toLowerCase()) {
    console.log(`\n  Using deployer as Wallet #1 (same address)`);
    await (await usdc.connect(deployer).mint(deployer.address, FEE * 2n)).wait();
    await (await usdc.connect(deployer).approve(addrs.MatrixA, FEE)).wait();
    const tx = await matA.connect(deployer).register(ethers.ZeroAddress);
    await tx.wait();
    console.log(`  ✅  Wallet #1 registered! tx: ${tx.hash}`);
  }

  // Option B: W1_PRIVATE_KEY set in .env
  else if (process.env.W1_PRIVATE_KEY) {
    console.log(`\n  Using W1_PRIVATE_KEY from .env`);
    const w1 = new ethers.Wallet(process.env.W1_PRIVATE_KEY, ethers.provider);

    // Check ETH balance
    const ethBal = await ethers.provider.getBalance(w1.address);
    if (ethBal < ethers.parseEther("0.002")) {
      console.log(`  ⚠️   Low ETH on Wallet #1 (${ethers.formatEther(ethBal)} ETH)`);
      console.log(`  Sending 0.005 ETH from deployer...`);
      const ethTx = await deployer.sendTransaction({
        to: w1.address,
        value: ethers.parseEther("0.005")
      });
      await ethTx.wait();
      // Wait an extra block for the balance to reflect on the RPC node
      await new Promise(r => setTimeout(r, 4000));
      const newBal = await ethers.provider.getBalance(w1.address);
      console.log(`  ✓ Wallet #1 ETH balance: ${ethers.formatEther(newBal)} ETH`);
    }

    // Mint USDC to W1 from deployer
    await (await usdc.connect(deployer).mint(w1.address, FEE * 2n)).wait();
    console.log(`  ✓ Minted $20 USDC to Wallet #1`);

    // Approve + register
    await (await usdc.connect(w1).approve(addrs.MatrixA, FEE)).wait();
    const tx = await matA.connect(w1).register(ethers.ZeroAddress);
    await tx.wait();
    console.log(`  ✅  Wallet #1 registered! tx: ${tx.hash}`);
    // Wait for RPC state to propagate before reading confirmation
    await new Promise(r => setTimeout(r, 4000));
  }

  // Option C: Neither — deployer registers on behalf (using admin fund approach)
  else {
    console.log(`\n  ⚠️   W1_PRIVATE_KEY not in .env and deployer ≠ Wallet #1`);
    console.log(`\n  To register Wallet #1, choose one of:`);
    console.log(`\n  OPTION 1 — Add to .env:`);
    console.log(`    W1_PRIVATE_KEY=<private key for ${W1_ADDRESS}>`);
    console.log(`    Then re-run this script.`);
    console.log(`\n  OPTION 2 — Use BaseScan:`);
    console.log(`    1. Go to https://sepolia.basescan.org/address/${addrs.USDC}#writeContract`);
    console.log(`       Call mint(${W1_ADDRESS}, 10000000)`);
    console.log(`    2. Go to https://sepolia.basescan.org/address/${addrs.USDC}#writeContract`);
    console.log(`       Call approve(${addrs.MatrixA}, 10000000)  — connect as Wallet #1`);
    console.log(`    3. Go to https://sepolia.basescan.org/address/${addrs.MatrixA}#writeContract`);
    console.log(`       Call register(0x0000000000000000000000000000000000000000) — connect as Wallet #1`);
    console.log(`\n  OPTION 3 — Use deployer as the first member:`);
    console.log(`    Set W1_ADDRESS in register_w1.js to your deployer address.`);
    console.log(`    The deployer will be root of the matrix.\n`);
    return;
  }

  // Confirm
  const m = await matA.getMember(W1_ADDRESS);
  const pos = await matA.matrixPos(W1_ADDRESS);
  console.log(`\n  Position: ${pos} (should be 1 — root)`);
  console.log(`  hasEverJoined: ${m.hasEverJoined}`);
  console.log(`  isInMatrix: ${m.isInMatrix}`);
  console.log(`\n  Next: npx hardhat run scripts/quickfill_f8.js --network baseSepolia\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
