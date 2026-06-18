"use strict";
/**
 * check_stuck.js — Detect and fix stuck crossings
 * ─────────────────────────────────────────────────────────────────────────────
 * A member is "stuck" when they cycled out of a matrix but couldn't self-fund
 * the $10 crossing (escrow + earnings < $10). This happens during burst fills
 * when the root didn't have enough time to accumulate escrow.
 *
 * This script:
 *   1. Scans all known members of Matrix A who have cycled out
 *   2. Checks if they are NOT in Matrix B (stuck)
 *   3. For each stuck member, calls forceCross() funded by the Protocol Reserve
 *
 * The Protocol Reserve (1% per entry = $0.10) exists precisely for this purpose.
 * On mainnet, the keeper bot runs this on schedule so no member stays parked.
 *
 * Run: npx hardhat run scripts/check_stuck.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses.json");
const FEE = 10_000_000n;

const fmt6 = n => "$" + (Number(n) / 1e6).toFixed(2);

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error("deployed_addresses.json not found"); process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const matA = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixA);
  const matB = await ethers.getContractAt("FigureEightMatrix", addrs.MatrixB);
  const usdc  = await ethers.getContractAt("MockUSDC",          addrs.USDC);

  const mSize     = Number(await matA.MATRIX_SIZE());
  const totalA    = Number(await matA.totalMembers());
  const rotations = Number(await matA.rotationCount());

  console.log(`\n  ─── Stuck Crossing Scanner ──────────────────────────`);
  console.log(`  Matrix A: ${totalA} total members | ${rotations} rotations`);
  console.log(`  Scanning for members who cycled out but aren't in Matrix B...`);

  // Collect all addresses that ever joined Matrix A via MemberEntered events
  // Base Sepolia limits event queries to 2000 blocks — paginate from deploy block
  const filter      = matA.filters.MemberEntered();
  const currentBlock = await ethers.provider.getBlockNumber();
  const fromBlock    = addrs.deployedAtBlock || Math.max(0, currentBlock - 50000);
  const PAGE         = 1999;

  const events = [];
  for (let start = fromBlock; start <= currentBlock; start += PAGE) {
    const end   = Math.min(start + PAGE, currentBlock);
    const batch = await matA.queryFilter(filter, start, end);
    events.push(...batch);
  }
  const allAddrs = [...new Set(events.map(e => e.args.member))];

  console.log(`  Found ${allAddrs.length} unique addresses in Matrix A history\n`);

  const stuck = [];

  for (const addr of allAddrs) {
    const mA = await matA.getMember(addr);
    const mB = await matB.getMember(addr);

    // Stuck = has cycled out of A (cycles > 0) AND is not currently in A or B
    if (Number(mA.cyclesCompleted) > 0 && !mA.isInMatrix && !mB.isInMatrix) {
      const escrow   = await matA.escrowOf(addr);
      const earnings = mA.withdrawable;
      const total    = escrow + earnings;
      stuck.push({ addr, escrow, earnings, total, cycles: Number(mA.cyclesCompleted) });
    }
  }

  if (stuck.length === 0) {
    console.log(`  ✅  No stuck members found. All crossings completed successfully.`);
    return;
  }

  console.log(`  ⚠️   Found ${stuck.length} stuck member(s):\n`);
  for (const s of stuck) {
    console.log(`  ${s.addr.slice(0,10)}...  escrow:${fmt6(s.escrow)}  earnings:${fmt6(s.earnings)}  total:${fmt6(s.total)}  cycles:${s.cycles}`);
    console.log(`  → Shortfall: ${fmt6(FEE - s.total < 0n ? 0n : FEE - s.total)}`);
  }

  // ── Fix: forceCross each stuck member ──────────────────────────────────────
  console.log(`\n  Fixing stuck crossings via forceCross()...`);
  console.log(`  (Admin/Protocol Reserve funds the shortfall)\n`);

  for (const s of stuck) {
    try {
      // Mint the full fee to deployer (on testnet — on mainnet Protocol Reserve has real USDC)
      await (await usdc.connect(deployer).mint(deployer.address, FEE)).wait();
      await (await usdc.connect(deployer).approve(addrs.MatrixA, FEE)).wait();

      const tx = await matA.connect(deployer).forceCross(s.addr);
      await tx.wait();

      const mB = await matB.getMember(s.addr);
      const pos = await matB.matrixPos(s.addr);
      console.log(`  ✅  ${s.addr.slice(0,10)}... → Matrix B pos ${pos}  (${mB.isInMatrix ? "success" : "check manually"})`);
    } catch(e) {
      console.log(`  ❌  ${s.addr.slice(0,10)}... forceCross failed: ${e.shortMessage || e.message}`);
    }
  }

  // Final state
  console.log(`\n  ── Post-fix Matrix B ────────────────────────────────`);
  const occB  = await matB.occupancy();
  const totB  = await matB.totalMembers();
  console.log(`  Matrix B: ${totB} total joined | ${occB}/${mSize} occupied`);
  console.log(`\n  Run check_f8_state.js to see the full updated state.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
