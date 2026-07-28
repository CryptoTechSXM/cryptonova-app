"use strict";
/**
 * V8_45_NestedEntry.test.js — regression for the 2026-07-26 live incident.
 *
 * SYMPTOM ON V8.44 (T1.0 MatB, after 217 rotations):
 *   occupancy = 127/127 but only 83 real occupants (drift +44),
 *   44 empty BFS positions including position 1, one member at PHANTOM position 128,
 *   and every subsequent entry reverting "F8V8: no root" -> matrix permanently wedged,
 *   42 members unable to self-rescue.
 *
 * ROOT CAUSE: entering a FULL matrix calls _cycleOutRoot, whose handleCycleOut callback
 * can seat a member back into THAT SAME matrix (own-pair re-entry, or the partner MatA
 * cycling out and crossing back in). The nested entry consumed the freed slot and moved
 * nextSlot; the outer call then placed its member at the stale slot — overwriting the
 * nested occupant or writing past matrixSize.
 *
 * N1: after a rotation that re-enters the same matrix, EVERY occupant sits at a unique
 *     position within 1..MATRIX_SIZE, occupancy equals the real count, and nothing is
 *     written above MATRIX_SIZE.
 * N2: a matrix whose position 1 is empty must still rotate (self-heal) rather than
 *     revert "F8V8: no root".
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
const FEE  = 10_000_000n;
const SIZE = 4;   // small matrix => saturation and rotations happen fast

async function deployPair() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter"))
    .deploy(await usdc.getAddress(), owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE, owner.address);

  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const lib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await lib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await lib.getAddress() },
  });
  const matA = await MX.deploy(dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setPairManager(await pm.getAddress());
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await matA.getAddress(), await matB.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await tr.setTierMatrices(0, await matA.getAddress(), await matB.getAddress());
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  // Saturate immediately so same-tier re-entries target the OWN pair's MatB —
  // the exact routing that produced the live corruption.
  await pm.setEntryThresholds(1, 2);
  // V8.46 (2026-07-27): pairExpansionThreshold and its setter were DELETED.
  // The knob compared a cumulative lifetime counter against a value documented
  // as capacity, so every pair crossed it permanently and its MatA lost every
  // entry source. _sameTierTarget is now unconditional (plus a collision guard),
  // which is exactly what setting it to 127 was approximating here.
  return { usdc, tr, pm, matA, matB, owner, W1, sigs, pmAddr: await pm.getAddress() };
}

async function reg(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(s).register(ref, { gasLimit: 16_000_000 });
}

/** Owner-funded force-cross of every parked MatA member into MatB.
 *  Passive members park at the crossing (no earnings), so without this MatB
 *  never fills and the nested-entry path under test is never reached. */
async function drainParkedIntoMatB(ctx) {
  const matAAddr = await ctx.matA.getAddress();
  for (const s of ctx.sigs.slice(0, 40)) {
    if ((await ctx.matA.parkedAt(s.address)) > 0n) {
      await ctx.usdc.mint(ctx.owner.address, FEE);
      await ctx.usdc.connect(ctx.owner).approve(matAAddr, FEE);
      await ctx.matA.connect(ctx.owner).forceCross(s.address, { gasLimit: 16_000_000 });
    }
  }
}

/** Every occupant unique, inside 1..SIZE, occupancy == real count, nothing above SIZE. */
async function assertIntegrity(mat, label) {
  const size = Number(await mat.MATRIX_SIZE());
  const occ  = Number(await mat.occupancy());
  const seen = new Map();
  let real = 0;
  for (let i = 1; i <= size; i++) {
    const a = await mat.posToMember(i);
    if (a !== ethers.ZeroAddress) {
      expect(seen.has(a), `${label}: ${a} occupies two positions`).to.equal(false);
      seen.set(a, i);
      real++;
    }
  }
  for (let i = size + 1; i <= size + 6; i++) {
    expect(await mat.posToMember(i), `${label}: PHANTOM member at out-of-range position ${i}`)
      .to.equal(ethers.ZeroAddress);
  }
  expect(occ, `${label}: occupancy ${occ} != real occupants ${real} (drift)`).to.equal(real);
  return { occ, real, size };
}

describe("V8.45 — nested entry during rotation must not corrupt the BFS array", function () {
  this.timeout(600_000);

  it("N1: sustained rotations with own-pair re-entry keep occupancy and positions exact", async function () {
    const ctx = await deployPair();
    const { matA, matB, W1, sigs } = ctx;

    await reg(ctx, W1, ethers.ZeroAddress);
    // Drive well past the point where MatA fills, crosses into MatB, and MatB itself
    // starts rotating — every one of those rotations re-enters via handleCycleOut.
    for (let i = 0; i < 12; i++) {
      await reg(ctx, sigs[10 + i], W1.address);
      await assertIntegrity(matA, `MatA after reg ${i}`);
      await assertIntegrity(matB, `MatB after reg ${i}`);
      // Push parked members across so MatB fills and starts rotating — each of
      // those rotations re-enters MatB through handleCycleOut, which is the
      // exact path that corrupted the array on V8.44.
      await drainParkedIntoMatB(ctx);
      await assertIntegrity(matA, `MatA after cross ${i}`);
      await assertIntegrity(matB, `MatB after cross ${i}`);
    }

    // The whole point: MatB must actually have been cycling, not sitting frozen.
    expect(await matA.rotationCount(), "MatA never rotated — test drove nothing").to.be.gt(0n);
    const rotB = await matB.rotationCount();
    expect(rotB, "MatB never rotated — nested-entry path never exercised").to.be.gt(0n);
  });

  it("N2: a matrix with an empty position 1 still rotates (self-heal, no 'no root' wedge)", async function () {
    const ctx = await deployPair();
    const { matA, matB, W1, sigs } = ctx;

    await reg(ctx, W1, ethers.ZeroAddress);
    for (let i = 0; i < 3; i++) await reg(ctx, sigs[10 + i], W1.address);
    expect(await matA.occupancy()).to.equal(BigInt(SIZE));

    // Vacate position 1 the way the live incident did (seat emptied, no compaction).
    const rootMember = await matA.posToMember(1);
    const signer = ctx.sigs.find(s => s.address === rootMember);
    if (!signer) this.skip();
    await matA.connect(ctx.owner).reclaimIdleSlot(rootMember);   // keeper path, frees seat 1
    expect(await matA.posToMember(1)).to.equal(ethers.ZeroAddress);

    // On V8.44 the next entry into this matrix reverted "F8V8: no root" forever.
    await reg(ctx, sigs[20], W1.address);
    await reg(ctx, sigs[21], W1.address);
    await assertIntegrity(matA, "MatA after self-heal");
    expect(await matA.occupancy(), "matrix should be usable again").to.be.gt(0n);
  });
});
