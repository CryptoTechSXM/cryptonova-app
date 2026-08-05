"use strict";
/**
 * V8.47 integration — the member-level rescue-debt ledger, exercised through the
 * REAL FigureEightMatrixV8 + StabilityFund (not the mock). Proves the wiring:
 *   1. Migration sweeps a stranded per-matrix debt into the member ledger, idempotently.
 *   2. A withdrawal collects member-level debt via withdrawCore's redirect — i.e. the
 *      exact 0xa2Df…702C case (debt owed, member's balance clears it) now settles.
 *
 * The full TierRouter upgrade-gate path is type-checked by the build and covered by
 * the SF-conservation invariant; its end-to-end fixture runs in the main suite.
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
const FEE = 10_000_000n;
const SIZE = 4;

async function deployCore() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const lib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await lib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await lib.getAddress() },
  });
  return { sigs, owner, W1, devOps, usdc, cnova, treasury, sf, dp, MX };
}

async function deployPair(ctx) {
  const matA = await ctx.MX.deploy(ctx.dp, FEE, SIZE, true, 0, SPLITS, CP_BPS);
  const matB = await ctx.MX.deploy(ctx.dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setStabilityFund(await ctx.sf.getAddress());
    await m.setMatrixKeeper(ctx.owner.address);
    await m.setPairManager(ctx.owner.address);
    await ctx.treasury.setAuthorizedCaller(await m.getAddress(), true);
    await ctx.sf.setMatrixAuthorized(await m.getAddress(), true);
  }
  return { matA, matB };
}

async function seat(ctx, mat, memberAddr) {
  const matAddr = await mat.getAddress();
  await ctx.usdc.mint(ctx.owner.address, FEE);
  await ctx.usdc.connect(ctx.owner).transfer(matAddr, FEE);
  await mat.connect(ctx.owner).enterFor(memberAddr, ethers.ZeroAddress, { gasLimit: 16_000_000 });
}

describe("V8.47 integration — member-level rescue-debt ledger", function () {
  this.timeout(600000);

  it("migration: a stranded per-matrix debt sweeps into the member ledger, idempotently", async () => {
    const ctx = await deployCore();
    const { matA } = await deployPair(ctx);
    const member = ethers.Wallet.createRandom().address;

    // Seed a legacy stranded local debt (the $1.30 0xa2Df…702C case). addRescueDebt is
    // partner-gated, so point the partner at owner to write it directly.
    await matA.setPartner(ctx.owner.address);
    await matA.connect(ctx.owner).addRescueDebt(member, 1_300_000n);
    expect(await matA.rescueDebtOf(member)).to.equal(1_300_000n);
    expect(await ctx.sf.memberDebt(member)).to.equal(0n);

    // Migrate: clearRescueDebt reports + zeroes the local silo; owner books it on the ledger.
    const cleared = await matA.connect(ctx.owner).clearRescueDebt.staticCall(member);
    expect(cleared, "clearRescueDebt returns the swept amount").to.equal(1_300_000n);
    await matA.connect(ctx.owner).clearRescueDebt(member);
    await ctx.sf.connect(ctx.owner).increaseMemberDebt(member, 0, 1_300_000n);

    expect(await matA.rescueDebtOf(member), "local silo drained").to.equal(0n);
    expect(await ctx.sf.memberDebt(member), "booked on member ledger").to.equal(1_300_000n);
    expect(await ctx.sf.totalRescueLoaned()).to.equal(1_300_000n);

    // Idempotent: a second clear reports 0, so a re-run of the sweep double-counts nothing.
    expect(await matA.connect(ctx.owner).clearRescueDebt.staticCall(member)).to.equal(0n);
  });

  it("stranded debt collects on withdrawal via the member ledger (the 0xa2Df case)", async () => {
    const ctx = await deployCore();
    const { matB } = await deployPair(ctx);
    const member = ctx.sigs[6];
    await seat(ctx, matB, member.address);

    const wBefore = await matB.withdrawableOf(member.address);
    expect(wBefore, "seated member has withdrawable (direct earn)").to.be.gt(0n);

    // Book a member-level debt that the member's balance can cover — models a loan issued
    // in a matrix they've since moved on from (V8.46 could not collect this).
    const debt = wBefore / 2n;
    await ctx.sf.connect(ctx.owner).increaseMemberDebt(member.address, 0, debt);

    // Withdraw: withdrawCore redirects the debt to the SF member ledger before paying out.
    await matB.connect(member).withdraw();

    expect(await ctx.sf.memberDebt(member.address), "member debt cleared on withdrawal").to.equal(0n);
    // totalRescueRepaid moves ONLY by the applied debt amount (independent of withdrawal fees).
    expect(await ctx.sf.totalRescueRepaid(), "exactly the debt was repaid to SF").to.equal(debt);
  });
});
