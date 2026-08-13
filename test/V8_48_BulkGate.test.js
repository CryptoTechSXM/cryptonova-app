"use strict";
/**
 * V8.48 item 15/O1 — bulkUpgrade joins the V8.47 upgrade gate (owner decision
 * 2026-08-13: "align in v8.48").
 *
 * Before this change, bulkUpgrade was the ONE upgrade path without _walletFold:
 * manualUpgrade and hybridUpgrade both refused to advance a member past unpaid
 * rescue debt, while bulkUpgrade climbed straight over it. Found by the item-15
 * approvals sweep (PARITY_AUDIT.md, observation O1).
 *
 *  B1  bulkUpgrade with debt → debt folded (SF repaid, ledger cleared), seat
 *      granted, wallet charged Σfees + debt — mirror of the manual path's G1.
 *  B2  bulkUpgrade with debt but allowance covering the fees only → REVERTS;
 *      debt intact, member stays put. That revert IS the gate — and it is the
 *      exact under-approval the frontend/bigfill fee+debt approves now prevent.
 *
 * Fixture copied from V8_47_UpgradeGate.test.js (each suite self-contained).
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
  await tr.setTierVelocityGreen(1, true);
  await tr.setStabilityFund(await sf.getAddress());

  return { usdc, tr, pm1, pm2, matA1, matB1, matA2, matB2, sf, owner, W1, devOps, sigs };
}

async function reg(ctx, signer, referrer, pm = null, fee = FEE1) {
  const pmAddr = await (pm || ctx.pm1).getAddress();
  await ctx.usdc.mint(signer.address, fee);
  await ctx.usdc.connect(signer).approve(pmAddr, fee);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

// Give `member` a completed T1 cycle so they're manual-upgrade eligible without a rotation.
async function completeCycle(ctx, member) {
  await ctx.tr.connect(ctx.owner).setReentryMinCycles(1);
  await ctx.tr.connect(member).setMemberOptions(false, false, false);
  await ctx.tr.registerMatrix(ctx.owner.address, 0);
  await ctx.tr.connect(ctx.owner).handleCycleOut(member.address, 0, 0, 0);
}

describe("V8.48 — bulkUpgrade joins the upgrade gate (item 15/O1)", function () {
  this.timeout(600_000);

  it("B1: bulkUpgrade folds outstanding rescue debt, member advances CLEAN", async () => {
    const ctx = await deployTwoTiers();
    const { usdc, tr, sf, matA2, W1 } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    await completeCycle(ctx, W1);

    const debt = 2_000_000n; // $2 outstanding rescue debt
    await sf.connect(ctx.owner).increaseMemberDebt(W1.address, 0, debt);
    expect(await sf.memberDebt(W1.address)).to.equal(debt);

    await usdc.mint(W1.address, FEE2 + debt);
    await usdc.connect(W1).approve(await tr.getAddress(), FEE2 + debt);
    const walletBefore = await usdc.balanceOf(W1.address);
    const repaidBefore = await sf.totalRescueRepaid();

    await tr.connect(W1).bulkUpgrade(1, { gasLimit: 16_000_000 });

    expect(await tr.memberHighestTier(W1.address), "seated at T2").to.equal(2);
    expect(await matA2.isActiveInMatrix(W1.address), "holds a T2 seat").to.equal(true);
    expect(await sf.memberDebt(W1.address), "debt cleared — advanced clean").to.equal(0n);
    expect(await sf.totalRescueRepaid() - repaidBefore, "exactly the debt repaid to SF").to.equal(debt);
    expect(walletBefore - (await usdc.balanceOf(W1.address)), "wallet charged fees + debt").to.equal(FEE2 + debt);
  });

  it("B2: bulkUpgrade with debt but allowance for the fees only REVERTS (the gate)", async () => {
    const ctx = await deployTwoTiers();
    const { usdc, tr, sf, W1 } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    await completeCycle(ctx, W1);

    const debt = 2_000_000n;
    await sf.connect(ctx.owner).increaseMemberDebt(W1.address, 0, debt);

    await usdc.mint(W1.address, FEE2 + debt);                 // money is there…
    await usdc.connect(W1).approve(await tr.getAddress(), FEE2); // …allowance is fees-only

    await expect(tr.connect(W1).bulkUpgrade(1, { gasLimit: 16_000_000 })).to.be.reverted;

    expect(await sf.memberDebt(W1.address), "debt untouched").to.equal(debt);
    expect(await tr.memberHighestTier(W1.address), "did not advance").to.equal(1);
  });
});
