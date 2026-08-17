"use strict";
/**
 * V8_48_JoinedAt.test.js — item 7 (+ the deploy wiring of items 13/14).
 *
 * TWO CONSUMERS, ONE MISSING FACT. CNOVATreasury needs a PERSON-denominated
 * answer from the T1 PairManager and never had one:
 *
 *   earlyExitPenaltyBps(member) — the redeem-at-floor penalty ladder
 *   (45/30/15/5/0% over 120 days) runs on "days since FIRST T1 registration".
 *   PairManagerV8 had no memberJoinedAt, the treasury's defensive try/catch read
 *   0, and every penalty was 0 — the ladder never applied to anyone, ever.
 *
 *   setFreeMode() — Universe Mode is IRREVERSIBLE and gated at 500+ MEMBERS,
 *   but totalMembers() returned totalRegistrations, an ENTRY counter that every
 *   rescue re-entry increments. Live measurement (item 42): ~41 seats per
 *   person — ~12 real members' worth of churn would have opened the gate.
 *
 * THE FIX: memberJoinedAt[member] stamped ONCE at a member's first routing
 * through the PairManager (all five routing sites; re-entries are no-ops), and
 * totalMembers() now returns uniqueMembers. deploy_v8.js wires
 * treasury.setMemberTracker(T1 pm) — never called before V8.48 (item 13) — and
 * predeploy_check.js fails if either half ships without the other (item 14).
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const FEE = 10_000_000n;
const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

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
  // The item-13 wiring, exactly as deploy_v8.js now does it.
  await treasury.setMemberTracker(pmAddr);
  return { usdc, pm, pmAddr, tr, sf, treasury, a, b, owner, W1, sigs,
           aAddr: await a.getAddress(), bAddr: await b.getAddress() };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

/** Register W1 + 15 fillers (matrix size 15 → W1 crosses to MatB on the 16th entry),
 *  then force W1's MatB shortfall cycle-out so a rescue re-entry can be driven. */
async function seedAndParkW1(ctx) {
  // ⛔ V8.50 ITEM E1: the fillers refer EACH OTHER, not W1. Referring them all to W1 gave
  // the fixture's "underfunded" member fifteen L1 commissions; it only read as
  // underfunded because that money was stranded in the MatA ledger. E1 carries a
  // member's balance across the crossing, so W1 would now fund the re-entry outright.
  // Chaining leaves W1 with one L1 plus their own pool and chain pay — the passive
  // member this precondition describes. Same change as V8_48_GhostFloor and
  // V8_48_Permit; the three move together.
  await reg(ctx, ctx.W1, ethers.ZeroAddress);
  for (let i = 3; i < 3 + 15; i++) {
    await reg(ctx, ctx.sigs[i], i === 3 ? ctx.W1.address : ctx.sigs[i - 1].address);
  }
  expect(await ctx.b.isActiveInMatrix(ctx.W1.address),
    "precondition: W1 must have crossed into MatB").to.equal(true);
  await ctx.b.adminForceRotateRoot({ gasLimit: 16_000_000 });
  expect(await ctx.b.parkedAt(ctx.W1.address),
    "precondition: W1 must be parked in MatB").to.be.gt(0n);
}

describe("V8.48 item 7 — memberJoinedAt: people get a clock, gates count people", function () {
  this.timeout(600_000);

  it("J1: MEMBER vs ENTRY — a rescue re-entry bumps registrations, never members", async function () {
    const ctx = await deployPair(15);
    await seedAndParkW1(ctx);

    // 16 people, 16 routings so far.
    expect(await ctx.pm.uniqueMembers()).to.equal(16n);
    expect(await ctx.pm.totalMembers()).to.equal(16n);
    const regsBefore = await ctx.pm.totalRegistrations();

    // W1 self-rescues → PairManager.rescueReentry → one more ROUTING, zero new PEOPLE.
    await ctx.usdc.mint(ctx.W1.address, FEE);
    await ctx.usdc.connect(ctx.W1).approve(ctx.bAddr, FEE);
    await ctx.b.connect(ctx.W1).selfRescue({ gasLimit: 16_000_000 });

    expect(await ctx.pm.totalRegistrations(),
      "the re-entry IS a registration event").to.equal(regsBefore + 1n);
    expect(await ctx.pm.uniqueMembers(),
      "…but W1 is not a new person — the ~41x entry inflation must not leak into members").to.equal(16n);
    expect(await ctx.pm.totalMembers()).to.equal(16n);
  });

  it("J2: memberJoinedAt is the FIRST-join clock — later routings never move it", async function () {
    const ctx = await deployPair(15);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    const t0 = await ctx.pm.memberJoinedAt(ctx.W1.address);
    expect(t0, "stamped at first registration").to.be.gt(0n);

    await time.increase(3600);
    // V8.50 item E1: chained referrals, same reason as seedAndParkW1 above — W1 must be
    // the passive member, not the fixture's richest wallet, or they fund the re-entry
    // themselves and selfRescue reverts "not parked".
    for (let i = 3; i < 3 + 15; i++) {
      await reg(ctx, ctx.sigs[i], i === 3 ? ctx.W1.address : ctx.sigs[i - 1].address);
    }
    await ctx.b.adminForceRotateRoot({ gasLimit: 16_000_000 });
    expect(await ctx.b.parkedAt(ctx.W1.address),
      "precondition: W1 must be parked for selfRescue to mean anything").to.be.gt(0n);
    await ctx.usdc.mint(ctx.W1.address, FEE);
    await ctx.usdc.connect(ctx.W1).approve(ctx.bAddr, FEE);
    await ctx.b.connect(ctx.W1).selfRescue({ gasLimit: 16_000_000 });

    expect(await ctx.pm.memberJoinedAt(ctx.W1.address),
      "a penalty clock that resets on re-entry would re-penalise loyal members forever").to.equal(t0);
  });

  it("J3: the treasury's penalty ladder finally runs — 45% → 30% → 15% → 5% → 0% from first join", async function () {
    const ctx = await deployPair(15);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);

    // Day 0: the steepest band. Before item 7 this read 0 for EVERYONE — the
    // ladder had never applied to a single member since V4 wrote it.
    expect(await ctx.treasury.earlyExitPenaltyBps(ctx.W1.address)).to.equal(4500n);
    await time.increase(31 * 24 * 3600);
    expect(await ctx.treasury.earlyExitPenaltyBps(ctx.W1.address)).to.equal(3000n);
    await time.increase(30 * 24 * 3600);
    expect(await ctx.treasury.earlyExitPenaltyBps(ctx.W1.address)).to.equal(1500n);
    await time.increase(30 * 24 * 3600);
    expect(await ctx.treasury.earlyExitPenaltyBps(ctx.W1.address)).to.equal(500n);
    await time.increase(31 * 24 * 3600);
    expect(await ctx.treasury.earlyExitPenaltyBps(ctx.W1.address)).to.equal(0n);
    // A wallet that never joined has no clock and no penalty.
    expect(await ctx.treasury.earlyExitPenaltyBps(ctx.sigs[9].address)).to.equal(0n);
  });

  it("J4: setFreeMode reaches the member count and refuses — the gate counts PEOPLE now", async function () {
    const ctx = await deployPair(15);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    // Wired but under-populated: the revert must be the COUNT check, not the old
    // "member tracker not set" — proving the whole chain (item 13) is connected
    // and denominated in members (16 people << 500, however many entries churn).
    await expect(ctx.treasury.setFreeMode())
      .to.be.revertedWith("Treasury: need 500+ members first");
  });
});
