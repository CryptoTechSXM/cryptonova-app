"use strict";
/**
 * V8_56_DebtPerMatrix.test.js — MEASUREMENT FIRST, no fix in this file's first commit.
 *
 * WHAT IS BEING MEASURED (V8_50_HANDOFF 62.67 / session 91):
 * The live V8.52 withdraw sweep (block 46986548) found 49 multi-matrix debtors whose
 * dashboard card ([2], freeWithdrawable summed) sits far below MAX / withdrawCore replay.
 * Source reading: MatrixLogicLib._claimableAndHeld subtracts the member's WHOLE SF debt
 * inside EVERY matrix (the debt is member-level, one ledger). Two money paths cap their
 * per-matrix take at that view:
 *   - TierRouterLib.drawTierToMember -> bulkWithdraw(uint256)   (partial, one signature)
 *   - TierRouterLib.drawFreeEarnings -> hybridUpgrade           (upgrade from earnings)
 *
 * THE CASE: two matrices with free balances f1, f2 and a debt D where
 *   f1 < D, f2 < D, D < f1 + f2   — no single matrix covers the debt, together they do.
 * The member's TRUE claimable is f1 + f2 - D > 0.
 *
 * PREDICTIONS, written before the first run (session 91, from source):
 *   DP1 each matrix's freeWithdrawable reads 0 although f1 + f2 - D > 0.       [view]
 *   DP2 bulkWithdraw(f1 + f2 - D) reverts TRState: every per-matrix cap is 0.   [money path]
 *   DP3 the full sweep bulkWithdraw() — NOT PREDICTED; measured and printed.
 *   DP4 withdraw() on T1 MatA alone — NOT PREDICTED; measured and printed.
 *   DP5 (added after DP1-DP4 were read) hybridUpgrade with earnings in T1 MatA AND T1 MatB,
 *       debt bigger than each, smaller than both: draws $0 from earnings; the wallet pays the
 *       WHOLE T2 fee plus the WHOLE debt (_walletFold); both matrix balances are untouched.
 * DP3/DP4 assert nothing about the outcome yet; they record it. A later commit turns the
 * measured behaviour into assertions once it is read.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { deployTwoTiers, seedTwoTierEarnings, reg, FEE2 } = require("./V8_48_BulkPartial.test.js");

const usd = v => "$" + (Number(v) / 1e6).toFixed(6);

async function seedDebtBiggerThanEachMatrix() {
  const ctx = await deployTwoTiers();
  const { f1, f2 } = await seedTwoTierEarnings(ctx);
  const lo = f1 > f2 ? f1 : f2;                       // debt must exceed the LARGER one
  const D = lo + (f1 + f2 - lo) / 2n;                 // lo < D < f1 + f2
  expect(D > f1 && D > f2 && D < f1 + f2, "SETUP: f1 < D, f2 < D, D < f1+f2").to.equal(true);
  await ctx.sf.connect(ctx.owner).increaseMemberDebt(ctx.W1.address, 0, D);
  expect(await ctx.sf.memberDebtOf(ctx.W1.address), "SETUP: debt booked").to.equal(D);
  console.log(`      f1 ${usd(f1)} · f2 ${usd(f2)} · debt ${usd(D)} · true claimable ${usd(f1 + f2 - D)}`);
  return { ctx, f1, f2, D };
}

describe("V8.56 measurement — member debt subtracted in EVERY matrix", function () {
  this.timeout(600_000);

  it("DP1: each matrix's freeWithdrawable reads 0 though the member's true claimable is > 0", async () => {
    const { ctx, f1, f2, D } = await seedDebtBiggerThanEachMatrix();
    const v1 = await ctx.matA1.freeWithdrawable(ctx.W1.address);
    const v2 = await ctx.matA2.freeWithdrawable(ctx.W1.address);
    console.log(`      view T1 ${usd(v1)} · view T2 ${usd(v2)} · sum ${usd(v1 + v2)} vs true ${usd(f1 + f2 - D)}`);
    expect(v1).to.equal(0n);
    expect(v2).to.equal(0n);
    expect(f1 + f2 - D).to.be.gt(0n);
  });

  it("DP2: bulkWithdraw(true claimable) reverts TRState — the partial path can reach none of it", async () => {
    const { ctx, f1, f2, D } = await seedDebtBiggerThanEachMatrix();
    await expect(ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](f1 + f2 - D, { gasLimit: 16_000_000 }))
      .to.be.revertedWithCustomError(ctx.tr, "TRState");
  });

  it("DP3 (record only): full sweep bulkWithdraw() — what reaches the wallet, what debt is left", async () => {
    const { ctx, f1, f2, D } = await seedDebtBiggerThanEachMatrix();
    const before = await ctx.usdc.balanceOf(ctx.W1.address);
    let outcome = "OK";
    try { await (await ctx.tr.connect(ctx.W1)["bulkWithdraw()"]({ gasLimit: 16_000_000 })).wait(); }
    catch (e) { outcome = "REVERT " + (e.shortMessage || e.message).slice(0, 90); }
    const got = (await ctx.usdc.balanceOf(ctx.W1.address)) - before;
    const debtLeft = await ctx.sf.memberDebtOf(ctx.W1.address);
    const w1 = await ctx.matA1.withdrawableOf(ctx.W1.address);
    const w2 = await ctx.matA2.withdrawableOf(ctx.W1.address);
    console.log(`      MEASURED DP3: ${outcome} · wallet +${usd(got)} · debt left ${usd(debtLeft)} · ` +
                `stored T1 ${usd(w1)} T2 ${usd(w2)} · (true claimable was ${usd(f1 + f2 - D)})`);
  });

  it("DP4 (record only): withdraw() on T1 MatA alone", async () => {
    const { ctx, f1, D } = await seedDebtBiggerThanEachMatrix();
    const before = await ctx.usdc.balanceOf(ctx.W1.address);
    let outcome = "OK";
    try { await (await ctx.matA1.connect(ctx.W1).withdraw({ gasLimit: 16_000_000 })).wait(); }
    catch (e) { outcome = "REVERT " + (e.shortMessage || e.message).slice(0, 90); }
    const got = (await ctx.usdc.balanceOf(ctx.W1.address)) - before;
    console.log(`      MEASURED DP4: ${outcome} · wallet +${usd(got)} · debt left ${usd(await ctx.sf.memberDebtOf(ctx.W1.address))} ` +
                `(f1 ${usd(f1)}, debt was ${usd(D)})`);
  });

  it("DP5: hybridUpgrade draws $0 from earnings in two T1 matrices; the wallet pays the whole fee AND the whole debt", async () => {
    const ctx = await deployTwoTiers();
    const { usdc, tr, matA1, matB1, sf, owner, W1, sigs } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    // Automation OFF BEFORE the referrals: with it on (the default) the 7th referral's
    // crossing auto-upgraded W1 into T2 and hybridUpgrade then reverts TRState (already
    // seated) — measured in a probe, session 91. With it off, 7 referrals leave W1 crossed
    // into T1 MatB (upgrade-eligible) with earnings in BOTH halves: A $0.95, B $8.292.
    await tr.connect(W1).setMemberOptions(true, false, false);
    for (let i = 0; i < 7; i++) await reg(ctx, sigs[9 + i], W1.address);
    expect(await ctx.pm2.holdsSeatIn(W1.address), "SETUP: W1 must NOT already hold a T2 seat").to.equal(false);
    const a = await matA1.withdrawableOf(W1.address), b = await matB1.withdrawableOf(W1.address);
    const fa = await matA1.freeWithdrawable(W1.address), fb = await matB1.freeWithdrawable(W1.address);
    expect(fa, "SETUP: MatA free = stored (no holds)").to.equal(a);
    expect(fb, "SETUP: MatB free = stored (no holds)").to.equal(b);
    const hi = a > b ? a : b;
    const D = hi + (a + b - hi) / 2n;
    expect(D > a && D > b && D < a + b, "SETUP: debt bigger than each, smaller than both").to.equal(true);
    await sf.connect(owner).increaseMemberDebt(W1.address, 0, D);
    console.log(`      T1 MatA ${usd(a)} · T1 MatB ${usd(b)} · debt ${usd(D)} · earnings net of debt ${usd(a + b - D)} · T2 fee ${usd(FEE2)}`);

    await usdc.mint(W1.address, FEE2 + D);
    await usdc.connect(W1).approve(await tr.getAddress(), FEE2 + D);
    const before = await usdc.balanceOf(W1.address);
    await tr.connect(W1).hybridUpgrade(1, { gasLimit: 16_000_000 });
    const spent = before - (await usdc.balanceOf(W1.address));
    const a2 = await matA1.withdrawableOf(W1.address), b2 = await matB1.withdrawableOf(W1.address);
    console.log(`      MEASURED DP5: wallet paid ${usd(spent)} · MatA left ${usd(a2)} · MatB left ${usd(b2)} · ` +
                `debt left ${usd(await sf.memberDebtOf(W1.address))}`);
    expect(await tr.memberHighestTier(W1.address), "upgraded to T2").to.equal(2);
    expect(spent, "wallet paid the whole fee AND the whole debt").to.equal(FEE2 + D);
    expect(a2, "MatA untouched").to.equal(a);
    expect(b2, "MatB untouched").to.equal(b);
    expect(await sf.memberDebtOf(W1.address), "debt cleared from the wallet").to.equal(0n);
  });
});
