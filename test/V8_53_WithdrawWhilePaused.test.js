// V8_53_WithdrawWhilePaused.test.js — the P2 PROMISE TO MEMBERS, proven (MAINNET_READINESS.md §2 P2).
// "New registrations/upgrades are paused; withdrawals work as normal." Until this file that was a
// CODE READ (bulkWithdraw and the matrix withdraw* carry no pause modifier). Now it is a test:
// with the system paused BY THE PAUSER KEY (the watchdog's path), every withdrawal door still pays,
// and the front door (register) is really shut. Reuses the two-tier fixture of V8_48_BulkPartial.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployTwoTiers, reg, seedTwoTierEarnings, FEE1 } = require("./V8_48_BulkPartial.test.js");

describe("V8.53 — withdrawals survive a watchdog pause (P2 promise)", function () {
  this.timeout(600_000);

  async function pausedByWatchdog() {
    const ctx = await deployTwoTiers();
    const seeded = await seedTwoTierEarnings(ctx);
    const watchdog = ctx.sigs[9];
    await ctx.tr.connect(ctx.owner).setPauser(watchdog.address);
    await expect(ctx.tr.connect(watchdog).pauseSystem("test: SF below floor"))
      .to.emit(ctx.tr, "SystemPaused");
    expect(await ctx.tr.systemPaused()).to.be.true;
    const feeBps = await ctx.matA1.withdrawalFeeBps();
    const net = (g) => g - (g * feeBps) / 10_000n;
    return { ctx, ...seeded, watchdog, net };
  }

  it("WP1: the pause is real — register() reverts TRState while paused", async () => {
    const { ctx } = await pausedByWatchdog();
    const P = ctx.sigs[7];
    await ctx.usdc.mint(P.address, FEE1);
    await ctx.usdc.connect(P).approve(await ctx.pm1.getAddress(), FEE1);
    await expect(ctx.tr.connect(P).register(ctx.W1.address, { gasLimit: 16_000_000 }))
      .to.be.revertedWithCustomError(ctx.tr, "TRState");
  });

  it("WP2: bulkWithdraw() (all tiers, full) pays the whole free balance net of fee while paused", async () => {
    const { ctx, f1, f2, net } = await pausedByWatchdog();
    const before = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.tr.connect(ctx.W1)["bulkWithdraw()"]({ gasLimit: 16_000_000 });
    expect(await ctx.usdc.balanceOf(ctx.W1.address) - before).to.equal(net(f1) + net(f2));
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address)).to.equal(0n);
    expect(await ctx.matA2.freeWithdrawable(ctx.W1.address)).to.equal(0n);
  });

  it("WP3: bulkWithdraw(uint256) (partial) pays while paused", async () => {
    const { ctx, f1, net } = await pausedByWatchdog();
    const amt = f1 / 2n;
    const before = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.tr.connect(ctx.W1)["bulkWithdraw(uint256)"](amt, { gasLimit: 16_000_000 });
    expect(await ctx.usdc.balanceOf(ctx.W1.address) - before).to.equal(net(amt));
    expect(await ctx.matA1.freeWithdrawable(ctx.W1.address)).to.equal(f1 - amt);
  });

  it("WP4: direct matrix withdraw() and withdrawPartial() pay while paused", async () => {
    const { ctx, f1, f2, net } = await pausedByWatchdog();
    const part = f1 / 2n;
    let before = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.matA1.connect(ctx.W1).withdrawPartial(part);
    expect(await ctx.usdc.balanceOf(ctx.W1.address) - before, "withdrawPartial on T1 MatA").to.equal(net(part));
    before = await ctx.usdc.balanceOf(ctx.W1.address);
    await ctx.matA2.connect(ctx.W1).withdraw();
    expect(await ctx.usdc.balanceOf(ctx.W1.address) - before, "withdraw() on T2 MatA").to.equal(net(f2));
  });

  it("WP5: withdrawTo(recipient) pays a different address while paused", async () => {
    const { ctx, f1, net } = await pausedByWatchdog();
    const R = ctx.sigs[8];
    const before = await ctx.usdc.balanceOf(R.address);
    await ctx.matA1.connect(ctx.W1).withdrawTo(R.address);
    expect(await ctx.usdc.balanceOf(R.address) - before).to.equal(net(f1));
  });

  it("WP6: after the OWNER unpauses, register() works again (the pauser could not have done it)", async () => {
    const { ctx, watchdog } = await pausedByWatchdog();
    await expect(ctx.tr.connect(watchdog).unpauseSystem()).to.be.revertedWithCustomError(ctx.tr, "OwnableUnauthorizedAccount");
    await ctx.tr.connect(ctx.owner).unpauseSystem();
    const P = ctx.sigs[7];
    await reg(ctx, P, ctx.W1.address);
    expect(await ctx.tr.memberHighestTier(P.address)).to.be.gt(0n);
  });
});
