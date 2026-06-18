/**
 * sim_community_wallet.js
 * ─────────────────────────────────────────────────────────────
 * Full Community Wallet simulation:
 *  1. Deploy all contracts (local Hardhat network)
 *  2. Register 25 members → fills Tranche A (1-10) + Tranche B (11-20)
 *  3. Warp time +25 days
 *  4. Call advanceEpoch()
 *  5. Every Tranche A & B founder claims
 *  6. Print full payout summary
 *
 * Run:  npx hardhat run scripts/sim_community_wallet.js
 * ─────────────────────────────────────────────────────────────
 */

"use strict";

const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");

const UNIT = 1_000_000n; // 1e6 USDC
const u6   = n => '$' + (Number(n) / 1e6).toFixed(2);

async function main() {
  const [deployer, dev, ops, admin, ...members] = await ethers.getSigners();

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Community Wallet — Full Payout Simulation");
  console.log("════════════════════════════════════════════════════════\n");

  // ── 1. Deploy ──────────────────────────────────────────────
  console.log("▶ Deploying contracts...");

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);

  const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
    await cnova.getAddress(),
    await usdc.getAddress(),
    admin.address
  );

  const cw = await (await ethers.getContractFactory("CryptoNovaCommunityWallet")).deploy(
    await usdc.getAddress(),
    admin.address
  );

  const matrix = await (await ethers.getContractFactory("CryptoNovaMatrixV3")).deploy(
    await usdc.getAddress(),
    await cnova.getAddress(),
    await treasury.getAddress(),
    dev.address,
    ops.address,
    await cw.getAddress(),
    admin.address,
    UNIT,
    10n   // feeMultiplier=10 → $10 tier
  );

  const mxAddr = await matrix.getAddress();

  // Wire roles
  const MINTER = await cnova.MINTER_ROLE();
  const BURNER  = await cnova.BURNER_ROLE();
  const EPOCH   = await cnova.EPOCH_ROLE();
  await cnova.connect(admin).grantRole(MINTER, mxAddr);
  await cnova.connect(admin).grantRole(BURNER, await treasury.getAddress());
  await cnova.connect(admin).grantRole(EPOCH,  mxAddr);
  await treasury.connect(admin).setTier1Matrix(mxAddr);
  await treasury.connect(admin).setAuthorizedCaller(mxAddr, true);
  await treasury.connect(admin).setCommunityWallet(await cw.getAddress());
  await cw.connect(admin).setAuthorisedRegistrar(mxAddr, true);

  const ENTRY_FEE = UNIT * 10n; // $10

  // Mint USDC for members
  for (const m of members.slice(0, 25)) {
    await usdc.connect(deployer).mint(m.address, UNIT * 200n);
  }

  console.log("  ✓ Deployed & wired\n");

  // ── 2. Register 25 members ─────────────────────────────────
  console.log("▶ Registering 25 members...\n");

  for (let i = 0; i < 25; i++) {
    const m = members[i];
    const referrer = i === 0 ? ethers.ZeroAddress : members[0].address;
    await usdc.connect(m).approve(mxAddr, ENTRY_FEE);
    await matrix.connect(m).register(referrer);

    const slot    = i + 1;
    const tranche = slot <= 10 ? "Tranche A" : slot <= 20 ? "Tranche B" : "No slot  ";
    console.log(`  Member #${String(slot).padStart(2)}  [${tranche}]  ${m.address.slice(0,10)}…`);
  }

  const pendingBefore = await cw.pendingPool();
  const founderCount  = await cw.founderCount();
  const trACount      = await cw.trancheACount();
  const trBCount      = await cw.trancheBCount();

  console.log(`\n  Pending pool after 25 joins : ${u6(pendingBefore)}`);
  console.log(`  Founders: ${founderCount}  (A: ${trACount}, B: ${trBCount})`);

  // ── 3. Warp time +25 days ──────────────────────────────────
  console.log("\n▶ Warping time forward 25 days...");
  await time.increase(25 * 24 * 60 * 60);
  console.log("  ✓ Done\n");

  // ── 4. Advance epoch ───────────────────────────────────────
  console.log("▶ Calling advanceEpoch()...");
  await cw.connect(admin).advanceEpoch();
  const epochNow  = await cw.currentEpoch();   // = 1 after first advance
  const epochInfo = await cw.epochs(epochNow); // epochs[1] is the live epoch
  console.log(`  ✓ Epoch ${epochNow} started`);
  console.log(`  Payout pot (50%) : ${u6(epochInfo.payoutPot)}`);
  console.log(`  Rolled over      : ${u6(epochInfo.rolledFromPool)}\n`);

  // ── 5. Each founder claims ─────────────────────────────────
  console.log("▶ Founders claiming from epoch 1...\n");

  const claimEpoch = epochNow; // claim the current (first) epoch
  let totalPaidA = 0n, totalPaidB = 0n;

  for (let i = 0; i < 20; i++) {
    const m       = members[i];
    const tranche = i < 10 ? "A" : "B";
    const before  = await usdc.balanceOf(m.address);
    await cw.connect(m).claim(claimEpoch);
    const earned  = (await usdc.balanceOf(m.address)) - before;
    if (tranche === "A") totalPaidA += earned; else totalPaidB += earned;
    console.log(`  Member #${String(i+1).padStart(2)} [Tranche ${tranche}]  claimed ${u6(earned)}`);
  }

  // ── 6. Summary ─────────────────────────────────────────────
  const cwBalAfter  = await usdc.balanceOf(await cw.getAddress());
  const nextPending = await cw.pendingPool();

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  PAYOUT SUMMARY");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Pool at epoch open          : ${u6(pendingBefore)}`);
  console.log(`  Payout pot (50%)            : ${u6(epochInfo.payoutPot)}`);
  console.log(`    Tranche A total paid      : ${u6(totalPaidA)}  (${trACount} members × ${u6(totalPaidA / BigInt(trACount))} each)`);
  console.log(`    Tranche B total paid      : ${u6(totalPaidB)}  (${trBCount} members × ${u6(totalPaidB / BigInt(trBCount))} each)`);
  console.log(`  Rolled into epoch 2 pool    : ${u6(epochInfo.rolledFromPool)}`);
  console.log(`  Current pending pool        : ${u6(nextPending)}`);
  console.log(`  CW USDC balance remaining   : ${u6(cwBalAfter)}`);
  console.log("\n  ✅ Simulation complete");
  console.log("════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
