"use strict";
/**
 * V8_48_RescueRouting.test.js — V8.48 item 10.
 *
 * THE DEFECT (PairManagerV8.rescueReentry, pre-fix):
 *     address dest = p.totalRegistered >= routeEntryThreshold ? p.matrixB : p.matrixA;
 *
 * totalRegistered is CUMULATIVE and only ever increments, so once a pair passed the
 * threshold EVERY subsequent rescue went to MatB, permanently. A member cycled out of
 * MatB, could not fund the crossing, parked, was rescued -- and was put straight back
 * into the same MatB. A closed loop.
 *
 * Measured live 2026-08-09 before the fix:
 *   T2.1 MatA rot 581 vs MatB rot 5684 (9.8x);  T3.1 434 vs 870 (2.0x)
 *   parked census: 466 of 714 parked members (65%) were sitting in MatB.
 *
 * THE FIX mirrors TierRouterLib.sameTierTarget: own MatA by default, own MatB ONLY
 * when the member already occupies that MatA (the V8.46-C collision guard, which is
 * NOT optional -- without it, re-entry hits require(!isInMatrix) and the member is
 * swallowed by an empty catch: 6 members, $467.50, replayed at block 44702114).
 *
 * Routing is asserted directly via the MemberRouted event, with the calling matrix
 * impersonated, so the branch is isolated from the cycle-out machinery.
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

describe("V8.48 item 10 — rescueReentry returns to own MatA", function () {
  this.timeout(600_000);

  it("routes a rescued member to own MatA regardless of the pair's cumulative entry count", async function () {
    const ctx = await deployPair(7);
    // Drive totalRegistered up — the exact condition that used to divert every later
    // rescue to MatB, permanently. The threshold it was compared against is deleted
    // as of V8.48 item 30; the counter it read still exists, so this stays meaningful.
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    await reg(ctx, ctx.sigs[10], ctx.W1.address);
    const rec = await ctx.pm.pairs(0);
    expect(rec[3]).to.be.gte(2n, "pair must have real entry history for this to be meaningful");

    const victim = ctx.sigs[11];
    const dest = await routeRescue(ctx, ctx.aAddr, victim.address, ctx.W1.address);

    expect(dest).to.equal(ctx.aAddr,
      "rescued member must return to own MatA — pre-fix this returned MatB and created " +
      "the recycle loop that held 466 of 714 parked members on 2026-08-09");
    expect(dest).to.not.equal(ctx.bAddr);
  });

  it("a member who already holds a pair seat is rejected centrally, not steered to MatB", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);          // W1 now seated in MatA
    expect(await ctx.a.isActiveInMatrix(ctx.W1.address)).to.equal(true);

    // V8.46's UNIVERSAL PAIR GUARD (MatrixLogicLib:278) rejects a seat in EITHER half,
    // so there is no destination within the pair for an already-seated member. A
    // collision branch routing to MatB would swap one revert for another. The revert is
    // the DESIGNED outcome: MatrixKeeper:558 treats "F8V8: already in matrix" as
    // expected-and-swallowable on the parked-rescue path, so the keeper skips cleanly.
    await ethers.provider.send("hardhat_impersonateAccount", [ctx.aAddr]);
    await ethers.provider.send("hardhat_setBalance", [ctx.aAddr, "0x56BC75E2D63100000"]);
    const asMatrix = await ethers.getSigner(ctx.aAddr);
    await ctx.usdc.mint(ctx.aAddr, FEE);
    await ctx.usdc.connect(asMatrix).approve(ctx.pmAddr, FEE);

    // V8.48: a duplicate is no longer rejected -- it is ROUTED to the next pair where the
    // member holds nothing (freePairFor, the same call TierRouter:1382 makes). Before this,
    // the re-entry reverted, and rescueReentry is called with NO try/catch at
    // MatrixLogicLib:773, so the revert took the entire cycle-out with it and the pair
    // STOPPED DEAD -- see TierRouter:1372 on T3.1 and T4.1 being repaired live 2026-07-28.
    // With only ONE pair deployed and no factory wired there is nowhere to go and no way to
    // spawn, so it fails LOUDLY rather than stranding the member.
    await expect(
      ctx.pm.connect(asMatrix).rescueReentry(ctx.W1.address, ctx.W1.address, 0,
        { gasLimit: 16_000_000 })
    ).to.be.revertedWith("PM8: no seat available for duplicate");

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.aAddr]);
  });

  it("the cumulative entry counter does not steer rescues at either extreme", async function () {
    // RETARGETED V8.48 item 30. This used to set routeEntryThreshold to 1 in one
    // context and 1,000,000 in another and assert the destination was the same. The
    // threshold is DELETED, so that comparison is no longer expressible — and a test
    // that can only be written against a knob dies with the knob.
    //
    // What it was really protecting is still live and still worth a gate: rescue
    // routing must not vary with `pair.totalRegistered`, the CUMULATIVE counter that
    // only ever increments. That counter still exists (it drives nothing, but it is
    // still written on every entry), so the invariant is tested directly by comparing
    // a pair with real history against a nearly-empty one.
    const busy = await deployPair(7);
    await reg(busy, busy.W1, ethers.ZeroAddress);
    for (let i = 10; i < 16; i++) await reg(busy, busy.sigs[i], busy.W1.address);

    const quiet = await deployPair(7);
    await reg(quiet, quiet.W1, ethers.ZeroAddress);

    const busyCount  = (await busy.pm.pairs(0))[3];
    const quietCount = (await quiet.pm.pairs(0))[3];
    expect(busyCount, "the two pairs must actually differ for this to compare anything")
      .to.be.gt(quietCount * 3n);

    const hi = await routeRescue(busy,  busy.aAddr,  busy.sigs[20].address,  busy.W1.address);
    const lo = await routeRescue(quiet, quiet.aAddr, quiet.sigs[20].address, quiet.W1.address);

    expect(hi).to.equal(busy.aAddr);
    expect(lo).to.equal(quiet.aAddr);
    // Same answer at both extremes: entry history does not steer rescues.
  });
});
