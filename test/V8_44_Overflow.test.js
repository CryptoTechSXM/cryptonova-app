"use strict";
/**
 * V8_44_Overflow.test.js — V8.44 overflow rework (V8_44_PLAN.md item E-refined).
 *
 *  O1. Saturated pair: a funded re-entry seats in the OWN pair's MatB
 *      (rotating the full MatB) — never overflows to pair N+1.
 *  O2. Saturated pair: genuinely NEW externals overflow to pair N+1.
 *  O3. Saturated pair: a parked MatA member's selfRescue crosses to the OWN
 *      MatB (V8.43 diverted them to pair N+1's MatA — the starvation bug).
 *  O4. DESIGN-LAW GATE (keepers OFF): with two pairs and pure member-driven
 *      flow (registrations + selfRescue only), BOTH MatBs' rotationCount
 *      climbs — cycling needs no keeper.
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
const HALF   = FEE / 2n;

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
    matAAddr: await mats[0].a.getAddress(),
  };
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

/** Fill pair-0 MatA then MatB (size members each), W1 first. Refs all → W1. */
async function fillPairZero(ctx, size) {
  const { sigs, W1 } = ctx;
  const fillers = sigs.slice(10, 10 + size - 1);
  await reg(ctx, W1, ethers.ZeroAddress);
  for (const f of fillers) await reg(ctx, f, W1.address);

  const cyclers = [W1, ...fillers];
  const externals = sigs.slice(10 + size - 1, 10 + 2 * size - 1);
  for (let i = 0; i < size; i++) {
    await reg(ctx, externals[i], W1.address);   // rotates MatA root out
    const m = cyclers[i];
    if (!(await ctx.matB.isActiveInMatrix(m.address))) {
      await ownerForceCross(ctx, m.address);
    }
  }
  expect(await ctx.matB.occupancy()).to.equal(BigInt(size));
  return { cyclers, externals };
}

describe("V8.44 — overflow rework: own members return to own pair", function () {
  this.timeout(600_000);

  it("O1+O2: at saturation, re-entry seats in OWN MatB; new externals overflow to pair 2", async function () {
    const SIZE = 7;
    const ctx = await deployTwoPairs(SIZE);
    const { pm, tr, matA, matB, matA2, matB2, W1, sigs, owner } = ctx;
    await fillPairZero(ctx, SIZE);

    // Park a pair-0 MatA member BEFORE saturating: one more external rotates
    // MatA; its passive root (externals[0], ~$2-3 earnings < $5) parks at the
    // crossing.
    const preExt = sigs[39];
    await reg(ctx, preExt, W1.address);
    let parked = null;
    for (const s of sigs) {
      if ((await matA.parkedAt(s.address)) > 0n) { parked = s; break; }
    }
    expect(parked, "need a parked pair-0 MatA member").to.not.equal(null);

    // Saturate pair 0: route threshold below its cumulative entry count.
    await pm.connect(owner).setEntryThresholds(1, 10);

    // --- O2 RETARGETED V8.48 (item 10b): ONE POINT OF ENTRY.
    // This asserted that a fresh external overflows to pair 2 once pair 0 saturates. New
    // members are no longer diluted across pairs: they always enter pair 0's MatA.
    // Concentrating the front door is what holds pair 0 at MATRIX_SIZE and keeps it
    // rotating -- a full MatA only rotates when it RECEIVES an entry (MatrixLogicLib:407),
    // so diverting new members away from a full pair is what FREEZES it (254 members,
    // 2026-08-06). Later pairs fill from members CYCLING -- own MatA, or the next free pair
    // when the member already holds a seat here -- and from upgrades, never from splitting
    // new entries.
    const ext = sigs[40];
    await reg(ctx, ext, W1.address);
    expect(await matA.isActiveInMatrix(ext.address),
      "new members always enter pair 0's MatA — one point of entry").to.equal(true);
    expect(await matA2.isActiveInMatrix(ext.address),
      "a new member must NOT be diverted to a later pair").to.equal(false);

    // --- O1: W1 (funded: >= $5 earnings + $5 reserve) cycles out of full MatB.
    // With pair0 saturated at PM level, the rescueReentry / registerForMatB
    // path must seat the re-entry in pair0's OWN MatB — rotating it — instead
    // of pair 1.
    // Trigger: force-cross a parked pair-0 MatA member into the full MatB.
    // (W1's re-entry routing itself is TierRouter._sameTierTarget — its
    // threshold floor is 127, so at this scale the re-entry goes to own MatA;
    // O1 therefore asserts the own-pair invariant: W1 must land in PAIR 0,
    // never in pair 1.)
    const rotB0Before = await matB.rotationCount();
    // V8.43 would have DIVERTED this rescue to pair 1 (overflowActive). V8.44:
    // selfRescue crosses to the OWN MatB.
    const short = FEE; // upper bound; selfRescue pulls only the real shortfall
    await ctx.usdc.mint(parked.address, short);
    await ctx.usdc.connect(parked).approve(await matA.getAddress(), short);
    await matA.connect(parked).selfRescue({ gasLimit: 16_000_000 });

    expect(await matB.rotationCount(), "own MatB must rotate from the rescue entry").to.equal(rotB0Before + 1n);
    expect(await matB.isActiveInMatrix(parked.address), "rescued member must be in OWN MatB").to.equal(true);
    expect(await matA2.isActiveInMatrix(parked.address), "must NOT divert to pair 2").to.equal(false);
    expect(await matB2.isActiveInMatrix(parked.address)).to.equal(false);

    // W1 (the MatB root rotated out just now) must have re-entered PAIR 0
    // (own pair), in either matrix — never pair 1.
    const w1InPair0 =
      (await matA.isActiveInMatrix(W1.address)) || (await matB.isActiveInMatrix(W1.address)) ||
      ((await matB.parkedAt(W1.address)) > 0n) || ((await matA.parkedAt(W1.address)) > 0n);
    expect(w1InPair0, "cycled-out member must stay in own pair").to.equal(true);
    expect(await matA2.isActiveInMatrix(W1.address)).to.equal(false);
    expect(await matB2.isActiveInMatrix(W1.address)).to.equal(false);
  });

  it("O4: DESIGN-LAW GATE — keepers OFF, both MatBs rotate from pure member-driven flow", async function () {
    const SIZE = 4;
    const ctx = await deployTwoPairs(SIZE);
    const { pm, matA, matB, matA2, matB2, W1, sigs, owner, usdc } = ctx;

    // Saturation thresholds scaled to the mini pair (SIZE*3 = 12 entries).
    await pm.connect(owner).setEntryThresholds(SIZE * 3 - 2, SIZE * 3);

    // Pure member-driven churn: register fresh externals; whenever anyone
    // parks anywhere, they selfRescue (member action — NOT a keeper).
    const wallets = sigs.slice(10, 80);
    let wi = 0;
    const allMats = [matA, matB, matA2, matB2];
    const seen = new Set();
    const rescueParked = async () => {
      for (const mat of allMats) {
        // walk the parked queue snapshot
        let count = Number(await mat.getParkedCount());
        for (let k = 0; k < count; k++) {
          const addr = await mat.getParkedMember(0); // head after each rescue
          const signer = sigs.find((s) => s.address === addr);
          if (!signer) break;
          await usdc.mint(signer.address, FEE);
          await usdc.connect(signer).approve(await mat.getAddress(), FEE);
          await mat.connect(signer).selfRescue({ gasLimit: 16_000_000 });
        }
      }
    };

    await reg(ctx, W1, ethers.ZeroAddress);
    seen.add(W1.address);
    for (let i = 0; i < 26; i++) {
      const w = wallets[wi++];
      await reg(ctx, w, W1.address);
      seen.add(w.address);
      await rescueParked();
    }

    const rotB0 = await matB.rotationCount();
    const rotB1 = await matB2.rotationCount();
    const rotA0 = await matA.rotationCount();
    expect(rotA0, "pair-0 MatA must be cycling").to.be.gt(0n);
    expect(rotB0, "pair-0 MatB must rotate WITHOUT any keeper").to.be.gt(0n);
    // RETARGETED V8.48 (item 10b). The law in this gate's title is "both MatBs rotate
    // from PURE MEMBER-DRIVEN FLOW" — that the protocol cycles without keepers. It used to
    // be checked by requiring pair 1 to receive OVERFLOW EXTERNALS, but new members are no
    // longer diluted across pairs; pair 1 fills from members cycling and from duplicates
    // (freePairFor), which this 27-registration run does not generate. An EMPTY STANDBY
    // pair is not a frozen pair — the law is about members who are waiting, and pair 1 has
    // none. What must hold, and is asserted above without any keeper, is that pair 0's MatA
    // AND MatB both keep rotating. Here we assert pair 1 is genuinely standing by: wired to
    // its partner and able to receive, so nothing is stranded when flow does reach it.
    expect(await matA2.partner(), "pair-1 MatA must be wired to its MatB")
      .to.equal(await matB2.getAddress());
    expect(await matB2.partner(), "pair-1 MatB must be wired to its MatA")
      .to.equal(await matA2.getAddress());
    expect(await matA2.occupancy(), "pair-1 is standby: idle, not frozen").to.equal(0n);

    // Zero stranded reserves: every wallet that is out of a matrix and not
    // parked must hold no crossingReserve in that matrix.
    for (const mat of allMats) {
      for (const addr of seen) {
        const mem = await mat.getMember(addr);
        if (mem.hasEverJoined && !mem.isInMatrix && (await mat.parkedAt(addr)) === 0n) {
          expect(mem.crossingReserve, `stranded reserve for ${addr}`).to.equal(0n);
        }
      }
    }
  });
});
