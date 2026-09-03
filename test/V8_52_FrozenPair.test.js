"use strict";
/**
 * V8_52_FrozenPair.test.js — REGRESSION_REGISTER R1, asserted DIRECTLY.
 *
 *  Audience: the next session of Claude, plus the owner.
 *
 *  THE LAW (R1): a matrix with no entry source freezes. `MatrixLogicLib:517` rotates a
 *  matrix ONLY when an ENTRY arrives at it full. So: no MatA may sit at MATRIX_SIZE with
 *  rotationCount 0, and no MatB may sit empty while its own MatA is full.
 *
 *  THIS TEST MUST BE RED ON THE CODE AS OF 2026-09-03 (commit 2a7e803 and earlier). It is
 *  the harness reproducing the live freeze measured that day: T1.2 MatA 127/127 with 0
 *  rotations and T1.2 MatB 0/127, because `PairManagerV8._findExternalPair()` returns 0
 *  and item S overflow SEATS members into later MatAs without ever ENTERING one.
 *  If F1 passes on unfixed code, the rig is not reproducing the freeze and the test is
 *  worthless — see R8 ("a detector that reports zero must first find a planted positive").
 *
 *  F1  pair 1's MatA, once full, must rotate — and its MatB must receive someone —
 *      under registrations + selfRescue ONLY (keepers OFF).           RED today.
 *  F2  pair 0 must KEEP rotating after pair 1 has become a door.
 *      This is the relocated-freeze guard: every previous cure of R1 moved the freeze
 *      somewhere else (see R1's table). A fix that passes F1 and fails F2 is that again.
 *  F3  while ANY MatA is full, the front door never sends a member to a NON-full one.
 *      The thin-spread guard: `_findExternalPair`'s doc is right that spreading entries
 *      across non-full pairs means nothing reaches MATRIX_SIZE and nothing rotates.
 *      (Routing into a non-full pair 0 while nothing is full yet is the bootstrap, fine.)
 *
 *  The rig is the one V8_44_Overflow.test.js uses (two hand-wired pairs, size 4), copied
 *  rather than imported because that file registers its own describe() at require time.
 *  History is O4 in that file: titled "both MatBs rotate", retargeted twice until it
 *  asserted nothing about pair 1 (REGRESSION_REGISTER R11). This file is O4's original law.
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

async function deployTwoPairs(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
    .deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(usdcAddr, FEE, owner.address);
  const [tresAddr, sfAddr, trAddr, pmAddr] = [
    await treasury.getAddress(), await sf.getAddress(),
    await tr.getAddress(),       await pm.getAddress(),
  ];

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const MatrixLib = await ethers.getContractFactory("MatrixLogicLib");
  const matrixLib = await MatrixLib.deploy();
  await matrixLib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });

  const mats = [];
  for (let p = 0; p < 2; p++) {
    const a = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
    const b = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
    await a.setPartner(await b.getAddress());
    await b.setPartner(await a.getAddress());
    for (const m of [a, b]) {
      await m.setPairManager(pmAddr);
      await m.setTierRouter(trAddr);
      await m.setStabilityFund(sfAddr);
      await m.setMatrixKeeper(owner.address);
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
      await tr.registerMatrix(await m.getAddress(), 0);
    }
    mats.push({ a, b });
  }
  await pm.addPair(await mats[0].a.getAddress(), await mats[0].b.getAddress());
  await pm.addPair(await mats[1].a.getAddress(), await mats[1].b.getAddress());
  await pm.setTierRouter(trAddr);
  await pm.setActivePairIndex(0);

  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await mats[0].a.getAddress(), await mats[0].b.getAddress());
  await sf.setMatrixKeeper(owner.address);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);

  return {
    usdc, cnova, treasury, sf, tr, pm, owner, W1, devOps, sigs, pmAddr, trAddr,
    matA: mats[0].a, matB: mats[0].b, matA2: mats[1].a, matB2: mats[1].b,
  };
}

/** Front-door registration. Returns the pairId the PairManager routed THIS member to. */
async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  const tx = await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
  const rc = await tx.wait();
  let routedTo = null;
  for (const log of rc.logs) {
    let ev;
    try { ev = ctx.pm.interface.parseLog(log); } catch { continue; }
    if (ev && ev.name === "MemberRouted" && ev.args.member === signer.address) routedTo = ev.args.pairId;
  }
  return routedTo;
}

/**
 * Pure member-driven churn: whenever anyone is parked anywhere they selfRescue.
 * A member action, not a keeper — exactly O4's loop.
 */
function makeRescuer(ctx, allMats) {
  const { sigs, usdc } = ctx;
  return async () => {
    for (const mat of allMats) {
      const count = Number(await mat.getParkedCount());
      for (let k = 0; k < count; k++) {
        const addr   = await mat.getParkedMember(0);
        const signer = sigs.find((s) => s.address === addr);
        if (!signer) break;
        await usdc.mint(signer.address, FEE);
        await usdc.connect(signer).approve(await mat.getAddress(), FEE);
        await mat.connect(signer).selfRescue({ gasLimit: 16_000_000 });
      }
    }
  };
}

/**
 * Drive the rig with registrations until pair 1's MatA is FULL (phase 1), then keep
 * driving for `extra` more registrations (phase 2). Records, per registration, whether
 * the front door sent the member to a pair whose MatA was NOT full at that moment.
 */
async function drive(SIZE, extra) {
  const ctx = await deployTwoPairs(SIZE);
  const { matA, matB, matA2, matB2, W1, sigs } = ctx;
  const allMats = [matA, matB, matA2, matB2];
  const rescueParked = makeRescuer(ctx, allMats);
  const wallets = sigs.slice(10, 200);
  let wi = 0;
  const thinSpread = []; // { member, pairId, occA } — a front-door arrival at a non-full MatA

  const oneReg = async (w) => {
    const occBefore = [await matA.occupancy(), await matA2.occupancy()];
    const pairId = await reg(ctx, w, W1.address);
    if (pairId !== null) {
      const idx = Number(pairId);
      // Thin-spread = sent to a NON-full MatA while some MatA WAS full. Routing to a
      // non-full MatA when nothing is full yet (the bootstrap of pair 0) is correct.
      const anyFull = occBefore.some((o) => o >= BigInt(SIZE));
      if (anyFull && occBefore[idx] < BigInt(SIZE)) thinSpread.push({ member: w.address, pairId: idx, occA: occBefore[idx] });
    }
    await rescueParked();
  };

  await reg(ctx, W1, ethers.ZeroAddress);
  // Phase 1: until pair 1's MatA is full. Cap generously; if it never fills, the rig
  // is not producing the state under test and the test must say so, not pass.
  let filled = false;
  for (let i = 0; i < 12 * SIZE && !filled; i++) {
    await oneReg(wallets[wi++]);
    filled = (await matA2.occupancy()) === BigInt(SIZE);
  }
  const rotA0AtFill  = await matA.rotationCount();
  const rotA2AtFill  = await matA2.rotationCount();
  const occB2AtFill  = await matB2.occupancy();

  // Phase 2: keep the front door busy. Every one of these is an ENTRY somewhere.
  for (let i = 0; i < extra; i++) await oneReg(wallets[wi++]);

  return {
    ctx, filled, thinSpread, registrations: wi,
    rotA0AtFill, rotA2AtFill, occB2AtFill,
    rotA0End: await matA.rotationCount(),  rotB0End: await matB.rotationCount(),
    rotA2End: await matA2.rotationCount(), occB2End: await matB2.occupancy(),
    occA2End: await matA2.occupancy(),
  };
}

describe("V8.52 — REGRESSION_REGISTER R1: a matrix with no entry source freezes", function () {
  this.timeout(600_000);
  const SIZE = 4;
  let r;
  before(async () => { r = await drive(SIZE, 4 * SIZE); });

  it("rig: pair 1's MatA actually fills under registrations + selfRescue (else nothing below means anything)", async function () {
    expect(r.filled, `pair 1 MatA never reached ${SIZE}/${SIZE} in ${r.registrations} registrations — the rig is not reproducing the state under test`).to.equal(true);
    // The planted positive: at the moment it filled, pair 1 had been SEATED into, never ENTERED.
    expect(r.rotA2AtFill, "at the moment of filling, pair 1 MatA must read 0 rotations (it was filled by overflow seats, not entries)").to.equal(0n);
  });

  it("F1: a FULL later MatA must rotate, and its MatB must receive someone — RED on one-door code", async function () {
    expect(r.rotA2End,
      `R1 VIOLATED: pair 1 MatA is ${r.occA2End}/${SIZE} with rotationCount ${r.rotA2End} after ${4 * SIZE} further front-door entries — no entry ever reaches it`)
      .to.be.gt(0n);
    expect(r.occB2End,
      `R1 VIOLATED: pair 1 MatB is empty (${r.occB2End}) while its own MatA is full — nobody is crossing into it`)
      .to.be.gt(0n);
  });

  it("F2: pair 0 keeps rotating after pair 1 becomes a door — the relocated-freeze guard", async function () {
    expect(r.rotA0End, "pair 0 MatA stopped rotating once pair 1 filled — the freeze has been RELOCATED, not cured")
      .to.be.gt(r.rotA0AtFill);
    expect(r.rotB0End, "pair 0 MatB must rotate WITHOUT any keeper").to.be.gt(0n);
  });

  it("F3: while any MatA is full, the front door never reaches a non-full one — the thin-spread guard", async function () {
    expect(r.thinSpread.length,
      `front door sent members to a NON-full MatA: ${JSON.stringify(r.thinSpread.map((t) => ({ pair: t.pairId, occA: String(t.occA) })))}`)
      .to.equal(0);
  });
});
