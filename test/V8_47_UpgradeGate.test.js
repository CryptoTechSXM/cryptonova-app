"use strict";
/**
 * V8.47 — upgrade-gate fold, end-to-end through the real TierRouter + matrices.
 *
 * The gate: a member cannot climb to a higher tier while carrying rescue debt — the
 * upgrade FOLDS the outstanding debt into its cost (repays the SF) so they advance CLEAN,
 * and if they can't cover fee + debt the upgrade is blocked.
 *
 *  G1  manualUpgrade with debt  → debt folded (SF repaid, ledger cleared), seat granted,
 *      wallet charged fee + debt.
 *  G2  manualUpgrade under-funded (wallet covers fee but not fee + debt) → REVERTS; debt
 *      intact, member stays put. That revert IS the gate.
 *  G3  auto-upgrade at a REAL MatB cycle-out (re-entry off, upgrade on) → the additive
 *      engine folds the debt from the member's cycle-out funds before seating them at T2.
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
const HALF1 = FEE1 / 2n;    // $5 crossing reserve at T1
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
  await tr.setTierVelocityGreen(1, true);       // T2 open for auto-upgrade
  // V8.47: wire the SF into the router so the upgrade gate can read + fold rescue debt.
  await tr.setStabilityFund(await sf.getAddress());

  return { usdc, tr, pm1, pm2, matA1, matB1, matA2, matB2, sf, owner, W1, devOps, sigs,
           pm1Addr: await pm1.getAddress(), matA1Addr: await matA1.getAddress() };
}

async function reg(ctx, signer, referrer, pm = null, fee = FEE1) {
  const pmAddr = await (pm || ctx.pm1).getAddress();
  await ctx.usdc.mint(signer.address, fee);
  await ctx.usdc.connect(signer).approve(pmAddr, fee);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

async function ownerForceCross(ctx, member) {
  await ctx.usdc.mint(ctx.owner.address, FEE1);
  await ctx.usdc.connect(ctx.owner).approve(ctx.matA1Addr, FEE1);
  await ctx.matA1.connect(ctx.owner).forceCross(member.address, { gasLimit: 16_000_000 });
}

/** Fill T1 MatB with [W1, f1..f(SIZE-1)], all fillers referred by W1 so W1 earns in MatB. */
async function fillMatB1(ctx) {
  const { sigs, W1 } = ctx;
  const fillers = sigs.slice(10, 10 + SIZE - 1);
  await reg(ctx, W1, ethers.ZeroAddress);
  for (const f of fillers) await reg(ctx, f, W1.address);
  const cyclers = [W1, ...fillers];
  const externals = sigs.slice(10 + SIZE - 1, 10 + SIZE - 1 + SIZE);
  for (let i = 0; i < SIZE; i++) {
    await reg(ctx, externals[i], W1.address);            // rotates MatA root out
    const m = cyclers[i];
    if (!(await ctx.matB1.isActiveInMatrix(m.address))) await ownerForceCross(ctx, m);
    expect(await ctx.matB1.isActiveInMatrix(m.address)).to.equal(true);
  }
}

/** Trigger one T1 MatB rotation by cycling the next MatA member into full MatB. */
async function rotateMatB1Once(ctx, nextIdx) {
  const rotBefore = await ctx.matB1.rotationCount();
  await reg(ctx, ctx.sigs[nextIdx], ctx.W1.address);
  if ((await ctx.matB1.rotationCount()) > rotBefore) return;
  for (const s of ctx.sigs) {
    if ((await ctx.matA1.parkedAt(s.address)) > 0n) { await ownerForceCross(ctx, s); return; }
  }
}

// Give `member` a completed T1 cycle so they're manual-upgrade eligible without a rotation.
async function completeCycle(ctx, member) {
  await ctx.tr.connect(ctx.owner).setReentryMinCycles(1);
  await ctx.tr.connect(member).setMemberOptions(false, false, false);
  await ctx.tr.registerMatrix(ctx.owner.address, 0);
  await ctx.tr.connect(ctx.owner).handleCycleOut(member.address, 0, 0, 0);
}

describe("V8.47 — upgrade-gate fold (end-to-end)", function () {
  this.timeout(600_000);

  it("G1: manualUpgrade folds outstanding rescue debt, member advances CLEAN", async () => {
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

    await tr.connect(W1).manualUpgrade(1, { gasLimit: 16_000_000 });

    expect(await tr.memberHighestTier(W1.address), "seated at T2").to.equal(2);
    expect(await matA2.isActiveInMatrix(W1.address), "holds a T2 seat").to.equal(true);
    expect(await sf.memberDebt(W1.address), "debt cleared — advanced clean").to.equal(0n);
    expect(await sf.totalRescueRepaid() - repaidBefore, "exactly the debt repaid to SF").to.equal(debt);
    expect(walletBefore - (await usdc.balanceOf(W1.address)), "wallet charged fee + debt").to.equal(FEE2 + debt);
  });

  it("G2: manualUpgrade with debt but only enough wallet for the fee REVERTS (the gate)", async () => {
    const ctx = await deployTwoTiers();
    const { usdc, tr, sf, W1 } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    await completeCycle(ctx, W1);

    const debt = 2_000_000n;
    await sf.connect(ctx.owner).increaseMemberDebt(W1.address, 0, debt);

    await usdc.mint(W1.address, FEE2);                    // fee only — not fee + debt
    await usdc.connect(W1).approve(await tr.getAddress(), FEE2);

    await expect(tr.connect(W1).manualUpgrade(1, { gasLimit: 16_000_000 })).to.be.reverted;

    expect(await sf.memberDebt(W1.address), "debt untouched").to.equal(debt);
    expect(await tr.memberHighestTier(W1.address), "did not advance").to.equal(1);
  });

  it("G3: at a real MatB cycle-out the debt follows the account, is collected, and the member auto-upgrades to T2 clean", async () => {
    const ctx = await deployTwoTiers();
    const { tr, sf, matB1, matA2, W1 } = ctx;
    await fillMatB1(ctx);

    // W1 sits in T1 MatB with reserve $5 + earnings. Turn re-entry OFF and upgrade ON so its
    // cycle-out takes the UPGRADE step. reentryMinCycles=1 so the opt-out applies on the
    // first cycle-out (cycles becomes 1 before the additive engine runs).
    await tr.connect(ctx.owner).setReentryMinCycles(1);
    // setMemberOptions(disableUpgrade, enableReentry, enableDouble): upgrade ON, re-entry OFF.
    await tr.connect(W1).setMemberOptions(false, false, false);

    const reserve = await matB1.crossingReserveOf(W1.address);
    const wBal    = await matB1.withdrawableOf(W1.address);
    const debt    = 1_000_000n; // $1
    expect(reserve + wBal, "setup: funds must cover next fee + debt").to.be.gte(FEE2 + debt);

    await sf.connect(ctx.owner).increaseMemberDebt(W1.address, 0, debt);
    const repaidBefore = await sf.totalRescueRepaid();

    // Cycle W1 out of MatB. The wired follow-mechanism (cycle-out redirect + the upgrade-gate
    // fold) clears the member-level debt as part of the SAME cycle-out that seats them at T2 —
    // proving the debt genuinely followed the account through a real advance, not a unit shim.
    await rotateMatB1Once(ctx, 40);

    expect(await matA2.isActiveInMatrix(W1.address), "auto-upgraded into T2").to.equal(true);
    expect(await tr.memberHighestTier(W1.address)).to.equal(2);
    expect(await sf.memberDebt(W1.address), "debt collected at cycle-out — advanced clean").to.equal(0n);
    expect(await sf.totalRescueRepaid() - repaidBefore, "exactly the debt repaid to SF").to.equal(debt);
  });
});
