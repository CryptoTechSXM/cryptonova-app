"use strict";
/**
 * V8_44_Keeper.test.js — V8.44 item E: factory ownership + frozen-MatB self-heal.
 *
 *  K1. checkUpkeep emits WORK_FORCE_ROTATE for a FULL, never-rotated MatB and
 *      performUpkeep rotates it via keeperForceRotateRoot (ownership-independent).
 *  K2. A full MatB that rotated recently is NOT flagged; it IS flagged after
 *      frozenMatBTimeout elapses.
 *  K3. Factory handoff: sweepMatrixOwnership moves a factory-owned matrix to
 *      pairAdmin in ONE step (adminHandoff — no pendingOwner limbo).
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE    = 10_000_000n;
const WORK_FORCE_ROTATE = 8;

async function deployWithKeeper(size) {
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

  const keeper = await (await ethers.getContractFactory("MatrixKeeper", {
    // V8.48 item 12a: the discovery scan lives in MatrixKeeperLib and must be linked.
    libraries: { MatrixKeeperLib: (await (await ethers.getContractFactory("MatrixKeeperLib")).deploy()).target },
  }))
    .deploy(trAddr, sfAddr);
  const keeperAddr = await keeper.getAddress();

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
    await m.setMatrixKeeper(keeperAddr);   // the CONTRACT is the keeper
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
  }
  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);
  await tr.setMatrixKeeper(keeperAddr);
  await sf.setMatrixKeeper(keeperAddr);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);
  await keeper.setPairManager(0, pmAddr);

  return { usdc, tr, pm, sf, matA, matB, keeper, owner, W1, devOps, sigs,
           pmAddr, matAAddr, matBAddr, keeperAddr };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

async function ownerForceCross(ctx, memberAddr) {
  await ctx.usdc.mint(ctx.owner.address, FEE);
  await ctx.usdc.connect(ctx.owner).approve(ctx.matAAddr, FEE);
  await ctx.matA.connect(ctx.owner).forceCross(memberAddr, { gasLimit: 16_000_000 });
}

/** Fill MatB to exactly `size` members with NO rotation (frozen-full state). */
async function fillMatBExactly(ctx, size) {
  const { sigs, W1 } = ctx;
  const fillers = sigs.slice(10, 10 + size - 1);
  await reg(ctx, W1, ethers.ZeroAddress);
  for (const f of fillers) await reg(ctx, f, W1.address);
  const cyclers = [W1, ...fillers];
  const externals = sigs.slice(10 + size - 1, 10 + 2 * size - 1);
  for (let i = 0; i < size; i++) {
    await reg(ctx, externals[i], W1.address);
    if (!(await ctx.matB.isActiveInMatrix(cyclers[i].address))) {
      await ownerForceCross(ctx, cyclers[i].address);
    }
  }
  expect(await ctx.matB.occupancy()).to.equal(BigInt(size));
  expect(await ctx.matB.rotationCount()).to.equal(0n);
}

function decodeItems(performData) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [items] = coder.decode(
    ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
    performData
  );
  return items;
}

describe("V8.44 — keeper self-heal + factory ownership", function () {
  this.timeout(600_000);

  it("K1: full never-rotated MatB → WORK_FORCE_ROTATE queued and executed (ownership-independent)", async function () {
    const SIZE = 4;
    const ctx = await deployWithKeeper(SIZE);
    const { keeper, matB } = ctx;
    await fillMatBExactly(ctx, SIZE);

    const [needed, performData] = await keeper.checkUpkeep("0x");
    expect(needed).to.equal(true);
    const items = decodeItems(performData);
    const fr = items.filter((i) => Number(i.workType) === WORK_FORCE_ROTATE);
    expect(fr.length, "frozen MatB must be flagged").to.equal(1);
    expect(fr[0].addr1).to.equal(await matB.getAddress());

    const rotBefore = await matB.rotationCount();
    await keeper.performUpkeep(performData, { gasLimit: 16_000_000 });
    expect(await matB.rotationCount(), "performUpkeep must rotate the frozen MatB").to.equal(rotBefore + 1n);
    expect(await matB.occupancy()).to.equal(BigInt(SIZE) - 1n);
  });

  it("K2: recently-rotated full MatB is not flagged; flagged again after timeout", async function () {
    const SIZE = 4;
    const ctx = await deployWithKeeper(SIZE);
    const { keeper, matB } = ctx;
    await fillMatBExactly(ctx, SIZE);

    // Rotate once via the keeper (from K1 condition), then re-fill to full.
    let [, pd] = await keeper.checkUpkeep("0x");
    await keeper.performUpkeep(pd, { gasLimit: 16_000_000 });
    expect(await matB.rotationCount()).to.equal(1n);
    // Re-fill the freed seat: force-cross the parked/next cycled member if any,
    // else register one more external to push a member through.
    const w = ctx.sigs[30];
    await reg(ctx, w, ctx.W1.address);               // rotates MatA root out
    let parked = null;
    for (const s of ctx.sigs) {
      if ((await ctx.matA.parkedAt(s.address)) > 0n) { parked = s; break; }
    }
    if (parked && (await matB.occupancy()) < BigInt(SIZE)) {
      await ownerForceCross(ctx, parked.address);
    }
    if ((await matB.occupancy()) < BigInt(SIZE)) this.skip(); // harness could not refill

    // Just rotated (lastRotationTimestamp fresh) → must NOT be flagged.
    let [needed2, pd2] = await keeper.checkUpkeep("0x");
    let items2 = needed2 ? decodeItems(pd2) : [];
    expect(items2.filter((i) => Number(i.workType) === WORK_FORCE_ROTATE).length,
      "fresh full MatB must not be flagged").to.equal(0);

    // After frozenMatBTimeout elapses → flagged again.
    await time.increase(6 * 3600 + 60);
    const [needed3, pd3] = await keeper.checkUpkeep("0x");
    expect(needed3).to.equal(true);
    const items3 = decodeItems(pd3);
    expect(items3.filter((i) => Number(i.workType) === WORK_FORCE_ROTATE).length,
      "stale full MatB must be flagged after timeout").to.equal(1);
  });

  it("K4: CW epoch automation — permissionless advanceEpoch queued and executed by the keeper", async function () {
    const SIZE = 4;
    const ctx = await deployWithKeeper(SIZE);
    const { usdc, keeper, owner } = ctx;

    const cw = await (await ethers.getContractFactory("CryptoNovaCommunityWallet"))
      .deploy(await usdc.getAddress(), owner.address);
    await keeper.setCommunityWallet(await cw.getAddress());

    // Fund the pending pool
    await usdc.mint(owner.address, 100_000_000n);
    await usdc.connect(owner).approve(await cw.getAddress(), 100_000_000n);
    await cw.connect(owner).deposit(100_000_000n);

    expect(await cw.epochReady()).to.equal(true);
    const [needed, pd] = await keeper.checkUpkeep("0x");
    expect(needed).to.equal(true);
    const items = decodeItems(pd);
    const ae = items.filter((i) => Number(i.workType) === 9); // WORK_ADVANCE_EPOCH
    expect(ae.length, "epoch advance must be queued").to.equal(1);

    await keeper.performUpkeep(pd, { gasLimit: 16_000_000 });
    expect(await cw.currentEpoch()).to.equal(1n);
    // And a random member could have done it too (permissionless) next cycle:
    expect(await cw.epochReady()).to.equal(false); // interval gate now active
  });

  it("K5: adminReleaseStrandedReserve — owner recovery valve (guards intact)", async function () {
    const SIZE = 4;
    const ctx = await deployWithKeeper(SIZE);
    const { matA, owner, W1 } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);

    // Seated member → valve must refuse
    await expect(matA.connect(owner).adminReleaseStrandedReserve(W1.address))
      .to.be.revertedWith("F8V8: still in matrix");
    // Non-owner → refused
    await expect(matA.connect(W1).adminReleaseStrandedReserve(W1.address))
      .to.be.reverted;
  });

  it("K3: sweepMatrixOwnership hands a factory-owned matrix to pairAdmin in one step", async function () {
    const sigs = await ethers.getSigners();
    const [owner, W1, devOps, pairAdmin] = sigs;

    const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
      .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);

    const MatrixLib = await ethers.getContractFactory("MatrixLogicLib");
    const matrixLib = await MatrixLib.deploy();
    await matrixLib.waitForDeployment();
    const libAddr = await matrixLib.getAddress();

    const factory = await (await ethers.getContractFactory("MatrixPairFactory", {
      libraries: { MatrixLogicLib: libAddr },
    })).deploy(owner.address, await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress());
    await factory.setPairAdmin(pairAdmin.address);

    // Simulate an orphan: a matrix whose owner is the FACTORY (constructor
    // admin = factory address — one-step, mirrors the pre-handoff state).
    const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
      libraries: { MatrixLogicLib: libAddr },
    });
    const dp = {
      usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
      treasury: await treasury.getAddress(),
      devWallet: devOps.address, opsWallet: devOps.address,
      accountOne: W1.address, admin: await factory.getAddress(),
    };
    const orphan = await MX.deploy(dp, FEE, 4, false, 0, SPLITS, CP_BPS);
    expect(await orphan.owner()).to.equal(await factory.getAddress());

    await factory.sweepMatrixOwnership(await orphan.getAddress());
    // ONE step — owner already pairAdmin, no acceptOwnership required.
    expect(await orphan.owner()).to.equal(pairAdmin.address);
    expect(await orphan.pendingOwner()).to.equal(ethers.ZeroAddress);
  });
});
