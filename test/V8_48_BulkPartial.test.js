"use strict";
/**
 * V8_48_BulkPartial.test.js — scope item 3: bulkWithdraw(uint256), the ONE-SIGNATURE
 * partial withdrawal.
 *
 * WHY THIS EXISTS: the dapp's partial withdraw walked matrix-by-matrix, one signature
 * each. Some legs landed, some failed, and the member watched half their money move
 * with no explanation — "clicked max, only 50% went through" (CryptoJan22,
 * 2026-08-11), Deborah's failed $50 (2026-08-10). And for EIP-7702 smart accounts
 * every leg is a separate relayer round-trip (found 2026-08-12), so the loop is even
 * more fragile than it looked. One router call retires the whole failure class.
 *
 * METHOD: every expected value is derived from freeWithdrawable() — the item-1
 * line-for-line withdrawCore mirror, whose own suite (V8_48_Withdrawable) proves it
 * equals what withdrawCore pays. These tests then assert the SWEEP agrees with the
 * view, per matrix and in the wallet. Setup preconditions are asserted loudly, never
 * skipped — a fixture that fails to produce free earnings in BOTH tiers must fail
 * the test, not vacuously pass it (the item-11 lesson).
 *
 * DRAW-ORDER is load-bearing and mutation-killable: BP2 requests exactly (f1 + 1);
 * a reversed tier loop would pull ~f2 from T2 instead of $0.000001.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE1 = 10_000_000n;   // T1 $10
const FEE2 = 7_000_000n;    // T2 $7
const SIZE = 7;

async function deployTwoTiers() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
    .deploy(await usdc.getAddress(), owner.address);
  const pm1 = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE1, owner.address);
  const pm2 = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE2, owner.address);

  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await matrixLib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });

  const mk = async (isA, tier, fee) => MX.deploy(dp, fee, SIZE, isA, tier, SPLITS, CP_BPS);
  const matA1 = await mk(true, 0, FEE1), matB1 = await mk(false, 0, FEE1);
  const matA2 = await mk(true, 1, FEE2), matB2 = await mk(false, 1, FEE2);

  const wire = async (a, b, pm) => {
    await a.setPartner(await b.getAddress());
    await b.setPartner(await a.getAddress());
    for (const m of [a, b]) {
      await m.setPairManager(await pm.getAddress());
      await m.setTierRouter(await tr.getAddress());
      await m.setStabilityFund(await sf.getAddress());
      await m.setMatrixKeeper(owner.address);
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
    }
    await pm.addPair(await a.getAddress(), await b.getAddress());
    await pm.setTierRouter(await tr.getAddress());
  };
  await wire(matA1, matB1, pm1);
  await wire(matA2, matB2, pm2);

  await tr.registerTier(0, await pm1.getAddress(), FEE1);
  await tr.registerTier(1, await pm2.getAddress(), FEE2);
  await tr.setTierMatrices(0, await matA1.getAddress(), await matB1.getAddress());
  await tr.setTierMatrices(1, await matA2.getAddress(), await matB2.getAddress());
  for (const m of [matA1, matB1]) await tr.registerMatrix(await m.getAddress(), 0);
  for (const m of [matA2, matB2]) await tr.registerMatrix(await m.getAddress(), 1);
  await sf.setTierFee(0, FEE1);
  await sf.setTierFee(1, FEE2);
  await sf.setMatrixKeeper(owner.address);
  await sf.setTierRouter(await tr.getAddress());
  await tr.setTierVelocityGreen(1, true);       // T2 open for upgrade
  await tr.setStabilityFund(await sf.getAddress());

  return { usdc, tr, pm1, pm2, matA1, matB1, matA2, matB2, sf, owner, W1, devOps, sigs };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE1);
  await ctx.usdc.connect(signer).approve(await ctx.pm1.getAddress(), FEE1);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

// Give `member` a completed T1 cycle so they're manual-upgrade eligible without a
// rotation (same shim as V8_47_UpgradeGate.test.js).
async function completeCycle(ctx, member) {
  await ctx.tr.connect(ctx.owner).setReentryMinCycles(1);
  await ctx.tr.connect(member).setMemberOptions(false, false, false);
  await ctx.tr.registerMatrix(ctx.owner.address, 0);
  await ctx.tr.connect(ctx.owner).handleCycleOut(member.address, 0, 0, 0);
}

/**
 * W1 with free earnings in TWO tiers:
 *  - T1 MatA: L1 commissions from M and N registering under W1;
 *  - T2 MatA: the V8.45 sponsor commission from M's manualUpgrade — credited to W1 in
 *    a tier W1 never joined, which is exactly the state the per-matrix loop mishandled.
 * Automation is then turned fully OFF for W1 (reservedFor -> 0), so by the V8.32
 * opt-out every dollar is free and the numbers are deterministic.
 */
async function seedTwoTierEarnings(ctx) {
  const { tr, usdc, W1, sigs } = ctx;
  const M = sigs[5], N = sigs[6];
  await reg(ctx, W1, ethers.ZeroAddress);
  await reg(ctx, M, W1.address);
  await reg(ctx, N, W1.address);
  await completeCycle(ctx, M);
  await usdc.mint(M.address, FEE2);
  await usdc.connect(M).approve(await tr.getAddress(), FEE2);
  await tr.connect(M).manualUpgrade(1, { gasLimit: 16_000_000 });
  await tr.connect(W1).setMemberOptions(true, false, false);   // all automation OFF

  const f1 = await ctx.matA1.freeWithdrawable(W1.address);
  const f2 = await ctx.matA2.freeWithdrawable(W1.address);
  expect(f1, "SETUP: W1 must hold free T1 earnings (L1 on two registrations)").to.be.gt(0n);
  expect(f2, "SETUP: W1 must hold free T2 earnings (L1 on M's upgrade)").to.be.gt(0n);
  return { f1, f2, M, N };
}

describe("V8.48 item 3 — bulkWithdraw(uint256): one-signature partial withdrawal", function () {
  this.timeout(600_000);

  let feeBps;
  const net = g => g - (g * feeBps) / 10_000n;

  it("BP1: a partial smaller than the first matrix's free balance draws from it ALONE, pays net-of-fee, and leaves the remainder in place", async () => {
    const ctx = await deployTwoTiers();
    const { f1 } = await seedTwoTierEarnings(ctx);
    feeBps = await ctx.matA1.withdrawalFeeBps();

    const amt = f1 / 2n;
    expect(amt, "SETUP: half of f1 must be non-zero").to.be.gt(0n);
    const walletBefore = await ctx.usdc.balanceOf(ctx.W1.address);
    const tw1Before = await ctx.matA1.getMemberTotalWithdrawn(ctx.W1.address);
    const tw2Before = await ctx.matA2.getMemberTotalWithdrawn(ctx.W1.address);

    await ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](amt, { gasLimit: 16_000_000 });

    expect(await ctx.usdc.balanceOf(ctx.W1.address) - walletBefore,
      "wallet received exactly amount minus the 1.5% fee").to.equal(net(amt));
    expect(await ctx.matA1.getMemberTotalWithdrawn(ctx.W1.address) - tw1Before,
      "T1 MatA ledger moved by exactly the gross draw").to.equal(amt);
    expect(await ctx.matA2.getMemberTotalWithdrawn(ctx.W1.address) - tw2Before,
      "T2 was NOT touched — the request fit inside T1").to.equal(0n);
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address),
      "the remainder is still free in T1").to.equal(f1 - amt);
  });

  it("BP2: draw order is lowest-tier-first — requesting (f1 + $0.000001) drains T1 and takes exactly 1 micro-unit from T2", async () => {
    const ctx = await deployTwoTiers();
    const { f1 } = await seedTwoTierEarnings(ctx);
    feeBps = await ctx.matA1.withdrawalFeeBps();

    const tw1Before = await ctx.matA1.getMemberTotalWithdrawn(ctx.W1.address);
    const tw2Before = await ctx.matA2.getMemberTotalWithdrawn(ctx.W1.address);

    await ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](f1 + 1n, { gasLimit: 16_000_000 });

    expect(await ctx.matA1.getMemberTotalWithdrawn(ctx.W1.address) - tw1Before,
      "T1 drained exactly").to.equal(f1);
    // A reversed tier loop would have pulled ~f2 from T2 here, not 1 micro-unit.
    expect(await ctx.matA2.getMemberTotalWithdrawn(ctx.W1.address) - tw2Before,
      "T2 supplied exactly the 1-unit overflow — proves T1 drew FIRST").to.equal(1n);
  });

  it("BP3: over-asking is a PARTIAL FILL, not a revert — everything free moves, nothing more", async () => {
    const ctx = await deployTwoTiers();
    const { f1, f2 } = await seedTwoTierEarnings(ctx);
    feeBps = await ctx.matA1.withdrawalFeeBps();

    const walletBefore = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](f1 + f2 + 1_000_000n, { gasLimit: 16_000_000 });

    expect(await ctx.usdc.balanceOf(ctx.W1.address) - walletBefore,
      "wallet received net of BOTH draws").to.equal(net(f1) + net(f2));
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address), "T1 empty").to.equal(0n);
    expect(await ctx.matA2.freeWithdrawable(ctx.W1.address), "T2 empty").to.equal(0n);
  });

  it("BP4: nothing drawable reverts TRState (never a paid no-op); amount 0 reverts TRZero; a stranger reverts TRState", async () => {
    const ctx = await deployTwoTiers();
    await seedTwoTierEarnings(ctx);

    // P registered LAST: seated, but nobody entered after them — no L1, no accrual.
    const P = ctx.sigs[7];
    await reg(ctx, P, ethers.ZeroAddress);
    expect(await ctx.matA1.freeWithdrawable(P.address),
      "SETUP: P must have nothing free, or this test asserts nothing").to.equal(0n);
    await expect(ctx.tr.connect(P)["bulkWithdraw(uint256)"](1_000_000n, { gasLimit: 16_000_000 }))
      .to.be.revertedWithCustomError(ctx.tr, "TRState");

    await expect(ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](0n))
      .to.be.revertedWithCustomError(ctx.tr, "TRZero");

    const stranger = ctx.sigs[8];
    await expect(ctx.tr.connect(stranger)["bulkWithdraw(uint256)"](1_000_000n))
      .to.be.revertedWithCustomError(ctx.tr, "TRState");
  });

  it("BP5: the V8.44 full sweep still works through the re-signed matrix wrapper (amount = 0 path)", async () => {
    const ctx = await deployTwoTiers();
    const { f1, f2 } = await seedTwoTierEarnings(ctx);
    feeBps = await ctx.matA1.withdrawalFeeBps();

    const walletBefore = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.tr.connect(ctx.W1)["bulkWithdraw()"]({ gasLimit: 16_000_000 });

    expect(await ctx.usdc.balanceOf(ctx.W1.address) - walletBefore,
      "full sweep pays net of everything free").to.equal(net(f1) + net(f2));
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address)).to.equal(0n);
    expect(await ctx.matA2.freeWithdrawable(ctx.W1.address)).to.equal(0n);
  });

  it("BP6: outstanding SF rescue debt is repaid off the FIRST draw — the view models it, the sweep clears it, the wallet gets net of the request", async () => {
    const ctx = await deployTwoTiers();
    const { f1 } = await seedTwoTierEarnings(ctx);
    feeBps = await ctx.matA1.withdrawalFeeBps();

    const debt = f1 / 2n;
    expect(debt, "SETUP: debt must be non-zero").to.be.gt(0n);
    await ctx.sf.connect(ctx.owner).increaseMemberDebt(ctx.W1.address, 0, debt);

    // The item-1 mirror must model the debt off the top — if this fails, item 1
    // regressed and BP6's arithmetic below would be meaningless.
    const f1d = await ctx.matA1.freeWithdrawable(ctx.W1.address);
    expect(f1d, "freeWithdrawable models the new debt off the top").to.equal(f1 - debt);

    const walletBefore = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](f1d, { gasLimit: 16_000_000 });

    expect(await ctx.usdc.balanceOf(ctx.W1.address) - walletBefore,
      "member received net of the REQUEST — the debt came out of the gross balance, not the payout").to.equal(net(f1d));
    expect(await ctx.sf.memberDebt(ctx.W1.address), "debt fully repaid by the first draw").to.equal(0n);
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address), "T1 free is exactly zero after").to.equal(0n);
  });
});
