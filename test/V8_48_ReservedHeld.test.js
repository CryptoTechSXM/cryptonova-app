"use strict";
/**
 * V8_48_ReservedHeld.test.js — scope item 2 (owner decision 2026-08-12, corrected same
 * day: KEEP high-tier-only reserve semantics, ADD `reservedHeldFor(member)`).
 *
 * WHAT THE GETTER IS: the on-chain version of the frontend's `_claimableAll.heldNow`
 * reconstruction — what the crossing lock + automation reserve ACTUALLY withhold right
 * now, as opposed to `reservedFor` (the TARGET). Behavior is UNCHANGED by this item;
 * only visibility is added.
 *
 * METHOD (the item-1 discipline): the view must equal what withdrawCore enforces, so
 * the core assertion compares the view to the TRANSACTION — after a full withdrawal,
 * what stays behind in the matrix must be exactly what reservedHeldOf reported before
 * it. Expected values are derived from the contract's OTHER views (reservedFor,
 * crossingReserveOf, ENTRY_FEE, withdrawableOf, pendingPoolOf), never hardcoded.
 * Setup preconditions are asserted loudly, never skipped (the item-11 lesson): a
 * fixture that stops producing free-AND-held balances must FAIL, not vacuously pass.
 *
 * Implementation note: claimableOf and reservedHeldOf share ONE internal
 * (`_claimableAndHeld`), so the partition `free + held == post-debt balance` is true
 * by construction — these tests exist to pin the ENFORCEMENT side (withdrawCore) to
 * that same arithmetic, which no refactor of either half may silently break.
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
const FEE2 = 2_000_000n;    // T2 $2 — small next-tier fee so W1's default
                            // auto-upgrade reserve can't swallow the whole balance
const SIZE = 15;            // room for W1 + 13 registrations with NO rotation

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

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE1);
  await ctx.usdc.connect(signer).approve(await ctx.pm1.getAddress(), FEE1);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

// Same shim as V8_47_UpgradeGate / V8_48_BulkPartial: one completed T1 cycle so the
// member is manual-upgrade eligible without driving a real rotation.
async function completeCycle(ctx, member) {
  await ctx.tr.connect(ctx.owner).setReentryMinCycles(1);
  await ctx.tr.connect(member).setMemberOptions(false, false, false);
  await ctx.tr.registerMatrix(ctx.owner.address, 0);
  await ctx.tr.connect(ctx.owner).handleCycleOut(member.address, 0, 0, 0);
}

/**
 * W1 seated in T1 MatA with a balance LARGE enough that, with automation on, the
 * crossing lock + reserve bind WITHOUT consuming everything — i.e. free > 0 AND
 * held > 0 simultaneously, the state every assertion here needs. 13 L1 commissions
 * (13 x $0.95) plus pool accrual clears the worst-case hurdle (crossing lock up to
 * $10 + auto-upgrade reserve $2). W1's member options are left at their DEFAULTS —
 * whatever reservedFor(W1) reads is taken from the contract, not assumed.
 */
async function seedHeldAndFree(ctx) {
  expect(ctx.sigs.length, "SETUP: fixture needs at least 24 signers").to.be.gte(24);
  await reg(ctx, ctx.W1, ethers.ZeroAddress);
  for (let i = 10; i < 23; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);

  const free = await ctx.matA1.freeWithdrawable(ctx.W1.address);
  const held = await ctx.matA1.reservedHeldOf(ctx.W1.address);
  expect(await ctx.tr.reservedFor(ctx.W1.address),
    "SETUP: W1's default options must reserve something, or nothing here is held").to.be.gt(0n);
  expect(free, "SETUP: W1 must have free earnings ABOVE the holds").to.be.gt(0n);
  expect(held, "SETUP: the holds must bind — a zero here means the fixture no longer " +
    "produces the free-AND-held state and every test below is vacuous").to.be.gt(0n);
  return { free, held };
}

describe("V8.48 item 2 — reservedHeldFor: what is ACTUALLY held toward the reserve target", function () {
  this.timeout(600_000);

  it("RH1: free + held partition the balance, held = crossing shortfall + reserve, and the router sums the highest tier", async () => {
    const ctx = await deployTwoTiers();
    const { free, held } = await seedHeldAndFree(ctx);

    // Partition: the two views split (withdrawable + pool accrual) exactly. No debt yet.
    expect(await ctx.sf.memberDebt(ctx.W1.address), "SETUP: no debt in this test").to.equal(0n);
    const raw  = await ctx.matA1.withdrawableOf(ctx.W1.address);
    const pool = await ctx.matA1.pendingPoolOf(ctx.W1.address);
    expect(free + held, "free + held must equal the full balance — nothing vanishes, " +
      "nothing is counted twice").to.equal(raw + pool);

    // Composition: while free > 0, held is EXACTLY the crossing shortfall plus the
    // reserve — the two figures withdrawCore subtracts before paying.
    const fee = await ctx.matA1.ENTRY_FEE();
    const cr  = await ctx.matA1.crossingReserveOf(ctx.W1.address);
    const crossNeeded = fee > cr ? fee - cr : 0n;
    expect(held).to.equal(crossNeeded + (await ctx.tr.reservedFor(ctx.W1.address)));

    // The router view is the per-matrix view summed over the HIGHEST tier only.
    const hA1 = await ctx.matA1.reservedHeldOf(ctx.W1.address);
    const hB1 = await ctx.matB1.reservedHeldOf(ctx.W1.address);
    expect(await ctx.tr.reservedHeldFor(ctx.W1.address)).to.equal(hA1 + hB1);
  });

  it("RH2: THE ENFORCEMENT CHECK — after a full withdrawal, what stays behind equals what the view said was held", async () => {
    const ctx = await deployTwoTiers();
    const { held } = await seedHeldAndFree(ctx);

    await (await ctx.matA1.connect(ctx.W1).withdraw({ gasLimit: 8_000_000 })).wait();

    // withdrawCore settled the pool, paid everything payable, and left exactly the
    // holds. If this fails, the view and the enforcement have diverged — the precise
    // defect class item 1 existed to kill.
    expect(await ctx.matA1.withdrawableOf(ctx.W1.address),
      "remaining stored balance must be exactly the pre-withdrawal held figure").to.equal(held);
    expect(await ctx.matA1.pendingPoolOf(ctx.W1.address),
      "pool fully settled by the withdrawal").to.equal(0n);
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address),
      "nothing free remains").to.equal(0n);
    expect(await ctx.matA1.reservedHeldOf(ctx.W1.address),
      "withdrawing what is free must not disturb what is held").to.equal(held);
  });

  it("RH3: earnings OUTSIDE the highest tier are never held — T2 money is free while W1's highest is T1", async () => {
    const ctx = await deployTwoTiers();
    await seedHeldAndFree(ctx);

    // Give W1 T2 earnings the way the live chain does: sponsor commission on a
    // downline's manualUpgrade — money in a tier W1 never joined.
    const M = ctx.sigs[5];
    await reg(ctx, M, ctx.W1.address);
    await completeCycle(ctx, M);
    await ctx.usdc.mint(M.address, FEE2);
    await ctx.usdc.connect(M).approve(await ctx.tr.getAddress(), FEE2);
    await ctx.tr.connect(M).manualUpgrade(1, { gasLimit: 16_000_000 });

    const f2 = await ctx.matA2.freeWithdrawable(ctx.W1.address);
    expect(f2, "SETUP: W1 must hold T2 earnings (sponsor commission on M's upgrade), " +
      "or this test proves nothing about tier scoping").to.be.gt(0n);

    // W1's highest tier is still T1: nothing in T2 is held, and the router figure is
    // exclusively the T1 sum. withdrawCore enforces no reserve in T2 for W1, so the
    // view reporting anything there would be a lie about the enforcement.
    expect(await ctx.matA2.reservedHeldOf(ctx.W1.address)).to.equal(0n);
    expect(await ctx.matB2.reservedHeldOf(ctx.W1.address)).to.equal(0n);
    const hA1 = await ctx.matA1.reservedHeldOf(ctx.W1.address);
    const hB1 = await ctx.matB1.reservedHeldOf(ctx.W1.address);
    expect(await ctx.tr.reservedHeldFor(ctx.W1.address)).to.equal(hA1 + hB1);
  });

  it("RH4: automation OFF means NOTHING is held — the V8.32 opt-out reads as zero, not as a phantom hold", async () => {
    const ctx = await deployTwoTiers();
    await seedHeldAndFree(ctx);

    await ctx.tr.connect(ctx.W1).setMemberOptions(true, false, false);   // all automation OFF
    expect(await ctx.tr.reservedFor(ctx.W1.address),
      "SETUP: opted out, so the target itself is zero").to.equal(0n);

    expect(await ctx.matA1.reservedHeldOf(ctx.W1.address)).to.equal(0n);
    expect(await ctx.tr.reservedHeldFor(ctx.W1.address)).to.equal(0n);
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address),
      "with no holds, everything is free").to.equal(
        (await ctx.matA1.withdrawableOf(ctx.W1.address))
        + (await ctx.matA1.pendingPoolOf(ctx.W1.address)));
  });

  it("RH5: a balance entirely below the crossing shortfall is entirely held — view says all-held, withdrawCore agrees by reverting", async () => {
    // Deliberately NOT seedHeldAndFree: its 14 occupants would make Q and R the 15th
    // and 16th entries, and the 16th enters a FULL matrix and rotates the root — a
    // W1 cycle-out has no business inside a test about Q's small balance.
    const ctx = await deployTwoTiers();

    // Q holds one L1 commission (~$0.95) — far under the ~$10 crossing shortfall —
    // and turns re-entry ON so the holds apply.
    const Q = ctx.sigs[7], R = ctx.sigs[8];
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    await reg(ctx, Q, ctx.W1.address);
    await reg(ctx, R, Q.address);
    await ctx.tr.connect(Q).setMemberOptions(false, true, false);

    const bal = (await ctx.matA1.withdrawableOf(Q.address))
              + (await ctx.matA1.pendingPoolOf(Q.address));
    expect(bal, "SETUP: Q must hold a small balance").to.be.gt(0n);
    expect(await ctx.matA1.freeWithdrawable(Q.address),
      "SETUP: the whole balance must sit below the holds").to.equal(0n);

    expect(await ctx.matA1.reservedHeldOf(Q.address),
      "everything Q has is held toward the crossing").to.equal(bal);
    expect(await ctx.tr.reservedHeldFor(Q.address)).to.equal(bal);
    // View 0-free and transaction reverting is AGREEMENT (item-1 doctrine).
    await expect(ctx.matA1.connect(Q).withdraw()).to.be.reverted;
  });

  it("RH6: SF debt is held toward REPAYMENT, not toward the reserve target — booking debt moves free, never held", async () => {
    const ctx = await deployTwoTiers();
    const { free: f0, held: h0 } = await seedHeldAndFree(ctx);

    const debt = f0 / 2n;
    expect(debt, "SETUP: debt must be non-zero and inside the free portion").to.be.gt(0n);
    await ctx.sf.connect(ctx.owner).increaseMemberDebt(ctx.W1.address, 0, debt);

    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address),
      "item-1 regression: the mirror models debt off the top").to.equal(f0 - debt);
    expect(await ctx.matA1.reservedHeldOf(ctx.W1.address),
      "the debt came out of the FREE side; the held figure must not move — counting " +
      "debt as 'held for automation' would overstate the reserve's funding").to.equal(h0);

    // Enforcement, with debt in play: full withdrawal repays the debt AND leaves the holds.
    await (await ctx.matA1.connect(ctx.W1).withdraw({ gasLimit: 8_000_000 })).wait();
    expect(await ctx.sf.memberDebt(ctx.W1.address), "debt cleared on the way out").to.equal(0n);
    expect(await ctx.matA1.withdrawableOf(ctx.W1.address),
      "what stays behind is still exactly the held figure").to.equal(h0);
  });
});
