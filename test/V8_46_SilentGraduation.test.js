"use strict";
/**
 * V8_46_SilentGraduation.test.js — regression for the 2026-07-27 live finding.
 *
 * SYMPTOM: members disappeared from a tier entirely. Not parked, not re-entered,
 * not upgraded — gone, with NO event emitted. W1 (0x6512e9…) lost its T1, T2 and
 * T3 seats this way while its MemberOptions were correct throughout
 * (autoReentryEnabled true, upgrade enabled, double enabled), which is what made
 * it look like the V8.43 "graduation" bug returning.
 *
 * ROOT CAUSE: MatrixLogicLib._cycleOutRoot removes the root from the seat map,
 * THEN calls TierRouter.handleCycleOut inside a try/catch whose catch block was
 * EMPTY. Any revert in the additive engine — deep-cascade out of gas, TierRouter
 * short of USDC/allowance for registerFor, any nested failure — was swallowed
 * whole. The member was already out and nothing put them back.
 *
 * Live blast radius: 5 wallets, 8 events, $267.50 of crossing reserve stranded.
 *
 * G1: when handleCycleOut reverts, the member MUST end up parked (rescuable),
 *     never silently removed. Fails on the pre-V8.46 empty catch.
 * G2: CycleOutFailed must be emitted so the failure is diagnosable rather than
 *     invisible — silence was what let this run for days unnoticed.
 * G3: with a healthy router the fallback must NOT fire (no false parking).
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
const FEE  = 10_000_000n;
const SIZE = 4;

async function deploy() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
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
  const matA = await MX.deploy(dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());

  // The whole point: a router whose handleCycleOut reverts on command.
  const bad = await (await ethers.getContractFactory("RevertingTierRouter")).deploy();

  for (const m of [matA, matB]) {
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await m.setTierRouter(await bad.getAddress());
    // enterFor is gated to the PairManager (FigureEightMatrixV8:442). Point it at
    // the owner so the harness can seat members directly, without dragging the
    // whole PairManager/TierRouter registration flow into a test about one catch.
    await m.setPairManager(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
  }
  return { usdc, matA, matB, bad, owner, W1, sigs };
}

/** Seat `n` members straight into MatB via the keeper entry path, so a forced
 *  rotation has a root to cycle out without needing the full router flow. */
async function seed(ctx, n) {
  const matBAddr = await ctx.matB.getAddress();
  const seated = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
    // PairManagerV8.registerFor transfers the fee to the matrix BEFORE calling
    // enterFor, so the matrix distributes from its own balance. Mirror that here.
    await ctx.usdc.mint(ctx.owner.address, FEE);
    await ctx.usdc.connect(ctx.owner).transfer(matBAddr, FEE);
    await ctx.matB.connect(ctx.owner).enterFor(w.address, ethers.ZeroAddress, { gasLimit: 16_000_000 });
    seated.push(w);
  }
  return seated;
}

describe("V8.46 — a failed cycle-out must park the member, never vanish them", function () {
  this.timeout(600_000);

  it("G1/G2: handleCycleOut reverts -> member is PARKED and CycleOutFailed is emitted", async function () {
    const ctx = await deploy();
    const seated = await seed(ctx, SIZE);
    const root = await ctx.matB.posToMember(1);
    expect(root, "no root seated — harness did not set up").to.not.equal(ethers.ZeroAddress);

    await ctx.bad.setShouldRevert(true);
    const tx = await ctx.matB.connect(ctx.owner).adminForceRotateRoot({ gasLimit: 16_000_000 });
    const rc = await tx.wait();

    // The member must not simply be gone.
    const parkedAt = await ctx.matB.parkedAt(root);
    expect(parkedAt, `member ${root} vanished — not seated, not parked. This is the silent graduation.`)
      .to.be.gt(0n);

    // And the failure must be visible on-chain.
    const iface = new ethers.Interface(["event CycleOutFailed(address indexed member, uint8 tierIndex)"]);
    const sawFailure = rc.logs.some(l => {
      try { return iface.parseLog({ topics: [...l.topics], data: l.data })?.name === "CycleOutFailed"; }
      catch { return false; }
    });
    expect(sawFailure, "CycleOutFailed not emitted — the failure is invisible to monitoring").to.equal(true);
  });

  it("G3: a healthy router must NOT trigger the park fallback", async function () {
    const ctx = await deploy();
    await seed(ctx, SIZE);
    const root = await ctx.matB.posToMember(1);

    await ctx.bad.setShouldRevert(false);
    await ctx.matB.connect(ctx.owner).adminForceRotateRoot({ gasLimit: 16_000_000 });

    expect(await ctx.matB.parkedAt(root),
      "member was parked even though handleCycleOut succeeded — fallback is too eager")
      .to.equal(0n);
  });
});
