"use strict";
/**
 * V8_48_Withdrawable.test.js — scope item 1.
 *
 * THE ONE ASSERTION THAT MATTERED AND DID NOT EXIST:
 *   freeWithdrawable() must equal what withdrawCore ACTUALLY PAYS.
 *
 * Measured on Base Sepolia 2026-08-10, before the fix: the view summed to $0.00 for
 * 0x1C56C6 while that member withdrew $124.99 in two transactions minutes later. Across a
 * six-account cohort it under-reported by $199, $191 and $178 on the three largest, and
 * returned a flat zero on three live balances. The frontend had already stopped trusting
 * it and computed its own headline.
 *
 * It survived multiple releases because every test asked "does the view return a plausible
 * number", and none asked "does it match the function it describes". These tests compare
 * the view to the transaction, every time.
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
const FEE    = 10_000_000n;

async function deployPair(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter",
      { libraries: { TierRouterLib: trLib.target } })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(usdcAddr, FEE, owner.address);
  const pmAddr = await pm.getAddress();

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8",
    { libraries: { MatrixLogicLib: await matrixLib.getAddress() } });

  const a = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const b = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  await a.setPartner(await b.getAddress());
  await b.setPartner(await a.getAddress());
  for (const m of [a, b]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());

  return { usdc, pm, pmAddr, tr, a, b, owner, W1, sigs,
           aAddr: await a.getAddress(), bAddr: await b.getAddress() };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

/** Impersonate a pair matrix and call rescueReentry; return the routed destination. */
async function routeRescue(ctx, fromMatrixAddr, member, referrer) {
  await ethers.provider.send("hardhat_impersonateAccount", [fromMatrixAddr]);
  await ethers.provider.send("hardhat_setBalance",
    [fromMatrixAddr, "0x56BC75E2D63100000"]);            // 100 ETH for gas
  const asMatrix = await ethers.getSigner(fromMatrixAddr);

  await ctx.usdc.mint(fromMatrixAddr, FEE);
  await ctx.usdc.connect(asMatrix).approve(ctx.pmAddr, FEE);

  const tx = await ctx.pm.connect(asMatrix)
    .rescueReentry(member, referrer, 0, { gasLimit: 16_000_000 });
  const rc = await tx.wait();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [fromMatrixAddr]);

  const ev = rc.logs
    .map(l => { try { return ctx.pm.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find(e => e.name === "MemberRouted");
  expect(ev, "MemberRouted not emitted").to.not.equal(undefined);
  return ev.args[2];                                      // dest
}



/** Read the views, perform the withdrawal, and require they agreed. */
async function viewMustMatchWithdrawal(ctx, matrix, member, label) {
  const free = await matrix.freeWithdrawable(member.address);
  const net  = await matrix.netClaimableOf(member.address);

  const memBefore  = await matrix.getMember(member.address);
  const usdcBefore = await ctx.usdc.balanceOf(member.address);

  if (free === 0n) {
    // withdrawCore reverts when there is nothing claimable. The view saying 0 and the
    // action reverting is AGREEMENT — the old view returned 0 while money was claimable.
    await expect(matrix.connect(member).withdraw()).to.be.reverted;
    return { free, net, withdrew: 0n };
  }

  await (await matrix.connect(member).withdraw({ gasLimit: 8_000_000 })).wait();

  const memAfter = await matrix.getMember(member.address);
  const paid = memAfter.totalWithdrawn - memBefore.totalWithdrawn;
  const recv = (await ctx.usdc.balanceOf(member.address)) - usdcBefore;

  expect(paid, `${label}: freeWithdrawable() must equal what withdrawCore pays`).to.equal(free);
  expect(recv, `${label}: netClaimableOf() must equal what lands in the wallet`).to.equal(net);
  return { free, net, withdrew: paid };
}

describe("V8.48 item 1 — freeWithdrawable mirrors withdrawCore", function () {
  this.timeout(600_000);

  it("W1: the view equals the payout, with automation ON (reserve + crossing lock apply)", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    for (let i = 10; i < 16; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);

    const r = await viewMustMatchWithdrawal(ctx, ctx.a, ctx.W1, "automation ON");
    // Whatever the number is, the view and the transaction must agree — that is the test.
    expect(r.free).to.be.a("bigint");
  });

  it("THE BUG: automation OFF must NOT lock the crossing reserve", async function () {
    // This is the case that produced the $199 divergence. withdrawCore gates the crossing
    // lock on `automationReserve > 0`; the old view applied it unconditionally, so a member
    // who had opted OUT of auto-reentry was told their money was held for a crossing they
    // had explicitly declined.
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    for (let i = 10; i < 16; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);

    // opt out entirely: (disableUpgrade, enableReentry, enableDouble)
    await ctx.tr.connect(ctx.W1).setMemberOptions(true, false, false);
    expect(await ctx.tr.reservedFor(ctx.W1.address),
      "member has opted out, so nothing is reserved").to.equal(0n);

    // PRECONDITIONS ASSERTED, NOT ASSUMED. The first version of this test wrapped the
    // assertion below in `if (m.isInMatrix && m.withdrawable > 0n)`. Had W1 not been
    // seated with a balance, the one check that actually catches the bug would have
    // silently skipped and the test would still have reported green — the exact vacuous
    // pass that O5b and O8 exist to prevent, written into the test for a bug that survived
    // because nobody verified the check was real. If the fixture stops producing this
    // state, this must FAIL rather than quietly stop testing anything.
    const m = await ctx.a.getMember(ctx.W1.address);
    expect(m.isInMatrix,
      "precondition: W1 must be SEATED — the crossing lock only applies in-matrix").to.equal(true);
    expect(m.withdrawable,
      "precondition: W1 must hold a balance, or there is nothing to lock or free").to.be.gt(0n);

    const free = await ctx.a.freeWithdrawable(ctx.W1.address);
    expect(free,
      "automation off: the WHOLE balance is free — no crossing is being saved for. " +
      "Pre-fix this returned balance minus (ENTRY_FEE - crossingReserve)."
    ).to.equal(await ctx.a.withdrawableOf(ctx.W1.address));
    await viewMustMatchWithdrawal(ctx, ctx.a, ctx.W1, "automation OFF");
  });

  it("netClaimableOf is exactly freeWithdrawable minus the withdrawal fee", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    for (let i = 10; i < 16; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);

    const free = await ctx.a.freeWithdrawable(ctx.W1.address);
    const net  = await ctx.a.netClaimableOf(ctx.W1.address);
    const bps  = await ctx.a.withdrawalFeeBps();
    expect(bps, "default withdrawal fee is 1.5%").to.equal(150n);
    expect(net).to.equal(free - (free * bps / 10_000n));
  });

  it("a member with nothing claimable: the view says 0 AND the withdrawal reverts", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    const stranger = ctx.sigs[40];
    expect(await ctx.a.freeWithdrawable(stranger.address)).to.equal(0n);
    expect(await ctx.a.netClaimableOf(stranger.address)).to.equal(0n);
    await expect(ctx.a.connect(stranger).withdraw()).to.be.reverted;
  });
});
