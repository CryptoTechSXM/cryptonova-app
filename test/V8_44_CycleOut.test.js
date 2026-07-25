"use strict";
/**
 * V8_44_CycleOut.test.js — V8.44 build, plan tests 1-4 (V8_44_PLAN.md).
 *
 * Reproduces the V8.43 MatB cycle-out bug (silent exit + stranded crossing
 * reserve for passive members with auto re-entry ON) and specifies the V8.44
 * contract behavior:
 *
 *  T1. Passive member (zero referrals), re-entry ON, underfunded
 *      → must PARK (never silently exit); reserve preserved for rescue.
 *  T2. reserve + withdrawable >= fee, re-entry ON
 *      → auto re-entry fires, funded from BOTH buckets (escrow + earnings).
 *  T3. Parked-at-MatB member selfRescue with shortfall
 *      → completes re-entry into own pair, no debt, reserve consumed.
 *  T4. Re-entry OFF (explicit opt-out, cycles >= reentryMinCycles)
 *      → clean exit WITH crossing reserve released to withdrawable.
 *
 * All four FAIL against V8.43 sources; they are the gate for the V8.44 fix
 * (MatrixLogicLib._cycleOutRoot escrow pass-through, deductForUpgrade reserve
 * accounting, TierRouter._takeSeat split funding, park-not-exit, reserve
 * release on opted-out exit).
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};  // sum = 4750
const CP_BPS = [380, 238, 119, 95, 71, 47];  // sum = 950 = chainBps
const FEE    = 10_000_000n;                  // $10 USDC (6 decimals)
const HALF   = FEE / 2n;                     // $5 crossing reserve

async function deploySystem(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];

  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter"))
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
  const matA = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

  await matA.setPartner(matBAddr);
  await matB.setPartner(matAAddr);
  for (const m of [matA, matB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(trAddr);
    await m.setStabilityFund(sfAddr);
  }
  await matA.setMatrixKeeper(owner.address);
  await matB.setMatrixKeeper(owner.address);
  await sf.setMatrixKeeper(owner.address);

  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);

  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);

  await treasury.setAuthorizedCaller(matAAddr, true);
  await treasury.setAuthorizedCaller(matBAddr, true);
  await sf.setMatrixAuthorized(matAAddr, true);
  await sf.setMatrixAuthorized(matBAddr, true);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);

  return { usdc, cnova, treasury, sf, tr, pm, matA, matB, owner, W1, devOps, sigs,
           pmAddr, matAAddr, matBAddr, trAddr };
}

/** Register a brand-new member through TierRouter (first-time path). */
async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

/** Owner-funded forceCross of a cycled-out (not-in-matrix) member into MatB. */
async function ownerForceCross(ctx, member) {
  await ctx.usdc.mint(ctx.owner.address, FEE);
  await ctx.usdc.connect(ctx.owner).approve(ctx.matAAddr, FEE);
  await ctx.matA.connect(ctx.owner).forceCross(member.address, { gasLimit: 16_000_000 });
}

/**
 * Drive a size-`size` pair until MatB is FULL, in cycle-out order
 * [W1, f1, ... f(size-2)], with `extra` fresh externals left seated in MatA.
 * Returns the list of members seated in MatB (in seat order).
 */
async function fillMatB(ctx, size, refAllToW1) {
  const { sigs, W1 } = ctx;
  const fillers = sigs.slice(10, 10 + size - 1);          // f1..f(size-1)
  // 1. Fill MatA: W1 + fillers
  await reg(ctx, W1, ethers.ZeroAddress);
  for (let i = 0; i < fillers.length; i++) {
    const ref = refAllToW1 ? W1.address
      : (i === 0 ? W1.address : fillers[i - 1].address);
    await reg(ctx, fillers[i], ref);
  }
  expect(await ctx.matA.occupancy()).to.equal(BigInt(size));

  // 2. Cycle out size members (W1 + f1..f(size-1)) one by one and force-cross
  //    each into MatB. Each fresh external registration rotates MatA once.
  const cyclers = [W1, ...fillers];
  const externals = sigs.slice(10 + size - 1, 10 + size - 1 + size);
  const inMatB = [];
  for (let i = 0; i < size; i++) {
    await reg(ctx, externals[i], W1.address);             // rotates MatA root out
    const m = cyclers[i];
    expect(await ctx.matA.isActiveInMatrix(m.address)).to.equal(false);
    // Well-funded members (reserve + withdrawable >= fee) auto-cross on
    // cycle-out; underfunded ones park and need the owner-funded forceCross.
    if (!(await ctx.matB.isActiveInMatrix(m.address))) {
      await ownerForceCross(ctx, m);                      // seat in MatB
    }
    expect(await ctx.matB.isActiveInMatrix(m.address)).to.equal(true);
    inMatB.push(m);
  }
  expect(await ctx.matB.occupancy()).to.equal(BigInt(size));
  return { inMatB, externals };
}

/** Trigger one MatB rotation by force-crossing the next cycled-out MatA member. */
async function rotateMatBOnce(ctx, externalsUsed, nextExternalIdx) {
  const { sigs, matB } = ctx;
  const rotBefore = await matB.rotationCount();
  const fresh = sigs[nextExternalIdx];
  await reg(ctx, fresh, ctx.W1.address);                  // rotates MatA
  if ((await matB.rotationCount()) > rotBefore) return;   // funded root auto-crossed into full MatB
  // otherwise the MatA root parked underfunded — force-cross it into full MatB
  let parked = null;
  for (const s of sigs) {
    if ((await ctx.matA.parkedAt(s.address)) > 0n) { parked = s; break; }
  }
  expect(parked, "expected a parked MatA member to force-cross").to.not.equal(null);
  await ownerForceCross(ctx, parked);                     // enters FULL MatB → rotates it
}

describe("V8.44 — MatB cycle-out: fund from reserve, park-not-exit", function () {
  this.timeout(600_000);

  it("T1: passive underfunded member with re-entry ON parks (never silently exits), reserve preserved", async function () {
    const ctx = await deploySystem(4);
    const { matB, W1 } = ctx;
    await fillMatB(ctx, 4, false);

    // Drain W1's MatB withdrawable so re-entry is genuinely underfunded:
    // reserve $5 + withdrawable $0 < $10 fee.
    if ((await matB.withdrawableOf(W1.address)) > 0n) {
      await matB.connect(W1).withdraw();
    }
    expect(await matB.withdrawableOf(W1.address)).to.equal(0n);
    expect(await matB.crossingReserveOf(W1.address)).to.equal(HALF);

    const rotBefore = await matB.rotationCount();
    await rotateMatBOnce(ctx, null, 17);
    expect(await matB.rotationCount()).to.equal(rotBefore + 1n);

    // W1 cycled out of MatB underfunded with re-entry ON (default).
    // V8.43 BUG: silent exit — not parked, not re-seated, $5 reserve stranded.
    // V8.44: must be parked in MatB with the reserve intact.
    expect(await matB.isActiveInMatrix(W1.address)).to.equal(false);
    expect(await ctx.matA.isActiveInMatrix(W1.address)).to.equal(false);
    expect(await matB.parkedAt(W1.address), "member must PARK, not silently exit").to.be.gt(0n);
    expect(await matB.crossingReserveOf(W1.address), "reserve must be preserved while parked").to.equal(HALF);
  });

  it("T2: reserve + withdrawable >= fee → auto re-entry fires funded by both buckets", async function () {
    const ctx = await deploySystem(7);
    const { matA, matB, W1 } = ctx;
    await fillMatB(ctx, 7, true);   // all fillers referred by W1 → W1 earns L1 in MatB

    const wBefore = await matB.withdrawableOf(W1.address);
    const rBefore = await matB.crossingReserveOf(W1.address);
    expect(rBefore).to.equal(HALF);
    // W1 must have >= $5 withdrawable (6 × $0.95 L1 + chain pay + direct earn)
    expect(wBefore, "test setup: W1 needs >= $5 MatB earnings").to.be.gte(HALF);
    expect(wBefore, "test setup: W1 must NOT self-fund the full fee from earnings alone").to.be.lt(FEE);

    await rotateMatBOnce(ctx, null, 25);

    // V8.43 BUG: escrow hardcoded to 0 → funds = withdrawable only (< fee) → silent exit.
    // V8.44: funds = reserve + withdrawable >= fee → re-entry seat taken.
    expect(await matA.isActiveInMatrix(W1.address), "auto re-entry must re-seat the member").to.equal(true);
    expect(await matB.crossingReserveOf(W1.address), "escrow bucket must fund the re-entry").to.equal(0n);
    // fee = 5 escrow + 5 withdrawable → remaining earnings stay withdrawable,
    // plus the $0.95 L1 credited AFTER the cycle-out by the triggering member's
    // own MatB entry (they were referred by W1; distribution runs post-rotation).
    expect(await matB.withdrawableOf(W1.address)).to.equal(wBefore - (FEE - HALF) + 950_000n);
    expect(await matB.parkedAt(W1.address)).to.equal(0n);
  });

  it("T3: parked-at-MatB member selfRescue pays shortfall → re-enters own pair, no debt", async function () {
    const ctx = await deploySystem(4);
    const { usdc, matA, matB, W1, matBAddr } = ctx;
    await fillMatB(ctx, 4, false);
    if ((await matB.withdrawableOf(W1.address)) > 0n) {
      await matB.connect(W1).withdraw();
    }
    await rotateMatBOnce(ctx, null, 17);
    expect(await matB.parkedAt(W1.address), "precondition: T1 parking behavior").to.be.gt(0n);

    // shortfall = fee − (reserve + withdrawable) = $10 − $5 = $5
    await usdc.mint(W1.address, HALF);
    await usdc.connect(W1).approve(matBAddr, HALF);
    await matB.connect(W1).selfRescue({ gasLimit: 16_000_000 });

    expect(await matB.parkedAt(W1.address)).to.equal(0n);
    expect(await matB.crossingReserveOf(W1.address)).to.equal(0n);
    // Re-entered own pair (below saturation → own MatA)
    expect(await matA.isActiveInMatrix(W1.address)).to.equal(true);
    expect(await matA.rescueDebtOf(W1.address)).to.equal(0n);
    expect(await matB.rescueDebtOf(W1.address)).to.equal(0n);
  });

  it("T4: re-entry OFF (explicit opt-out) → clean exit WITH reserve released to withdrawable", async function () {
    const ctx = await deploySystem(4);
    const { tr, matA, matB, W1, owner } = ctx;
    await fillMatB(ctx, 4, false);

    // Opt out: reentryMinCycles=1 so the member's explicit choice applies on cycle 1.
    await tr.connect(owner).setReentryMinCycles(1);
    await tr.connect(W1).setMemberOptions(true /*disable upgrade*/, false /*re-entry OFF*/, false);

    if ((await matB.withdrawableOf(W1.address)) > 0n) {
      await matB.connect(W1).withdraw();
    }
    expect(await matB.crossingReserveOf(W1.address)).to.equal(HALF);

    await rotateMatBOnce(ctx, null, 17);

    // Clean graduation: not parked, not re-seated — and the un-consumed
    // crossing reserve must NOT be stranded: released to withdrawable.
    expect(await matB.isActiveInMatrix(W1.address)).to.equal(false);
    expect(await matA.isActiveInMatrix(W1.address)).to.equal(false);
    expect(await matB.parkedAt(W1.address)).to.equal(0n);
    expect(await matB.crossingReserveOf(W1.address), "reserve must not strand on opt-out exit").to.equal(0n);
    // released $5 reserve + the $0.95 L1 credited after the cycle-out by the
    // triggering member's own MatB entry (referred by W1).
    expect(await matB.withdrawableOf(W1.address), "reserve must be released to withdrawable").to.equal(HALF + 950_000n);
  });
});
