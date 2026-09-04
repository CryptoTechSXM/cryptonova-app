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
 *
 *  V8.48 item 34 — the two OCCUPANCY expansion triggers (item 33 replaced the
 *  cumulative `deployEntryThreshold` rule with them, and nothing asserted either):
 *
 *  O5. EARLY trigger — newest MatB crosses factoryExpandThresholdBps (90% in
 *      production) and the factory spawns the next pair WHILE THE CURRENT ONE
 *      STILL HAS SEATS. The lead time is the point: the successor is deployed and
 *      wired before anyone needs it, not mid-cycle-out on top of a cascade.
 *  O6. FULL backstop — a pair that reaches MATRIX_SIZE in both halves always has a
 *      successor, so the routing rule always has somewhere to send a member who
 *      cannot stay in their own pair (rescueReentry -> _freePairFor).
 *
 *  These need a rig small enough to actually FILL a pair, which is why they live
 *  here (size 7) rather than in V8Elevator (size 127 = 254 registrations).
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

/**
 * ONE pair (pair 0) plus a fully wired MatrixPairFactory, so `_tryAdvancePair()`
 * can really deploy pair 1 instead of being stubbed. Mirrors deployTwoPairs()
 * exactly up to the point where the second pair would be added by hand.
 *
 * StabilityFund is deliberately NOT given to the factory (`setPeripherals` sf =
 * address(0)): `sf.setMatrixAuthorized` is owner-gated and the factory is not the
 * SF owner here, so passing it would make `deployAndWire` revert — and
 * `_tryAdvancePair` swallows that revert in a try/catch, which would show up as
 * "the trigger never fired" rather than as a wiring error. Pair 0 keeps its real
 * SF; the spawned pair does not need one for these assertions.
 */
async function deployOnePairWithFactory(size) {
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
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await matrixLib.waitForDeployment();
  const matrixLibAddr = await matrixLib.getAddress();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: matrixLibAddr },
  });

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
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(trAddr);
  await pm.setActivePairIndex(0);

  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());
  await sf.setMatrixKeeper(owner.address);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);

  // ── the factory, wired for tier 1 (tierNum 1 == tierIndex 0) ──────────────
  const factory = await (await ethers.getContractFactory("MatrixPairFactory", {
    libraries: { MatrixLogicLib: matrixLibAddr },
  })).deploy(owner.address, usdcAddr, cnovaAddr, tresAddr);
  const factoryAddr = await factory.getAddress();

  await factory.setWallets(devOps.address, devOps.address, W1.address);
  await factory.setPeripherals(
    ethers.ZeroAddress,   // sf — see note above
    ethers.ZeroAddress,   // couponRegistry
    trAddr,               // tierRouter
    owner.address,        // matrixKeeper (so forceCross works on spawned pairs too)
    ethers.ZeroAddress,   // governance
    ethers.ZeroAddress,   // buybackReserve
    ethers.ZeroAddress    // liquidityReserve
  );
  await factory.configureTier(1, FEE, size, SPLITS, CP_BPS);
  await factory.registerPairManager(pmAddr, 1);

  await pm.setFactory(factoryAddr);                       // _tryAdvancePair -> deployAndWire
  await treasury.setFactory(factoryAddr);                 // deployAndWire -> setAuthorizedCaller
  await tr.setFactory(factoryAddr);                       // deployAndWire -> registerMatrix
  await cnova.grantRole(ethers.ZeroHash, factoryAddr);    // deployAndWire -> grantRole(MINTER_ROLE)

  return {
    usdc, cnova, treasury, sf, tr, pm, factory, owner, W1, devOps, sigs,
    pmAddr, trAddr, factoryAddr,
    matA: a, matB: b,
    matAAddr: await a.getAddress(),
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

/** Fill pair-0 MatA only (size members, W1 first). Refs all → W1. */
async function fillMatAOnly(ctx, size) {
  const { sigs, W1 } = ctx;
  const fillers = sigs.slice(10, 10 + size - 1);
  await reg(ctx, W1, ethers.ZeroAddress);
  for (const f of fillers) await reg(ctx, f, W1.address);
  expect(await ctx.matA.occupancy()).to.equal(BigInt(size));
  return {
    cyclers:   [W1, ...fillers],
    externals: sigs.slice(10 + size - 1, 10 + 3 * size),
  };
}

/**
 * One external registration into the (full) MatA rotates its root out; make sure
 * that root ends up SEATED in MatB. A funded root crosses by itself — the
 * force-cross is only for roots that parked at the crossing for want of the other
 * half of the fee, which at this rig size is most of them.
 */
async function growMatBByOne(ctx, cyclers, externals, i) {
  await reg(ctx, externals[i], ctx.W1.address);
  const m = cyclers[i];
  if (m && !(await ctx.matB.isActiveInMatrix(m.address))) {
    await ownerForceCross(ctx, m.address);
  }
}

async function combinedOccupancy(ctx) {
  return (await ctx.matA.occupancy()) + (await ctx.matB.occupancy());
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

    // V8.48 item 30: there is no longer a threshold to "saturate" a pair with. The
    // assertions below hold on physical state alone, which is the point of deleting it.

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
    // ⛔ RETARGETED AGAIN — V8.50 ITEM S (session 53, 2026-08-31). This line read
    //     expect(await matA2.occupancy(), "pair-1 is standby: idle, not frozen").to.equal(0n);
    // and it went RED the moment item S shipped: pair-1 MatA held 4 members. That is item S
    // WORKING, not a regression. rescueReentry now routes a member out of a pair that is full
    // in BOTH halves into a pair that has room (PairManagerV8, the _bothHalvesFull branch),
    // and this run's rescueParked() loop saturates pair 0 and then rescues — precisely that
    // case. Measured on chain the same day (noseat_witness.js, 24h, live V8.50): ~1,676 free
    // seats sat idle at rotation 0 in expansion pairs while 152 members/24h parked for want
    // of a seat. An expansion pair that never receives anybody is the defect, not the law.
    //
    // ⛔ THE LAW IS UNCHANGED AND STILL ENFORCED: nothing reaches pair 1 through the FRONT
    // DOOR. What is dropped is only the stronger assumption that nothing reaches pair 1 AT
    // ALL, which item S deliberately made false. Every occupant must be explained by a
    // NAMED route — a silent arrival in a standby pair is exactly what this gate forbids.
    const overflowedO4 = await ctx.pm.queryFilter(ctx.pm.filters.RescueOverflowed());
    if ((await matA2.occupancy()) > 0n) {
      expect(overflowedO4.length,
        "pair 1 has occupants, so item S's RescueOverflowed must account for them"
      ).to.be.gt(0);
      for (const ev of overflowedO4) {
        expect(ev.args.toPair, "an overflow must LEAVE the saturated pair, never re-target it")
          .to.not.equal(ev.args.fromPair);
      }
    }

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

  // ───────────────────────────────────────────────────────────────────────────
  // V8.48 item 34 — THE TWO OCCUPANCY EXPANSION TRIGGERS
  //
  // Item 33 replaced `newest.totalRegistered >= deployEntryThreshold` (a CUMULATIVE
  // counter versus a configured number — the same shape that froze 254 members in
  // T1.1 MatA on 2026-08-06) with two triggers read from the matrices themselves:
  //
  //   matBTrigger — newest MatB occupancy >= factoryExpandThresholdBps (90% live)
  //   fullTrigger — newest pair at MATRIX_SIZE in both halves
  //
  // Neither was asserted anywhere: the test that covered the old cumulative rule was
  // retargeted to prove the counter NO LONGER fires, which says nothing about what
  // does. These two close that gap, on a rig small enough to actually fill a pair.
  // ───────────────────────────────────────────────────────────────────────────

  it("O5: EARLY trigger — the successor pair is deployed while pair 0 still has seats", async function () {
    const SIZE = 7;
    const ctx  = await deployOnePairWithFactory(SIZE);
    const { pm, matA, matB, owner, W1 } = ctx;

    // 4000 bps on a 7-seat MatB fires at 3 seats (3 * 10000 / 7 = 4285). Production
    // runs 9000, which on 127 seats is 114/127 — 13 seats of runway. Same shape,
    // scaled: what is being asserted is that expansion happens WITH ROOM TO SPARE,
    // not that any particular number is the right one. The lead time is the whole
    // point of keeping an early trigger at all — the next pair is deployed and wired
    // before anyone needs it, rather than mid-cycle-out on top of a cascade.
    await pm.connect(owner).setFactoryExpandThreshold(4_000n);
    expect(await pm.pairCount(), "one pair to start").to.equal(1n);

    const { cyclers, externals } = await fillMatAOnly(ctx, SIZE);

    // Cross members into MatB until it is past the threshold. Driven by a live read
    // rather than a fixed count: how many roots cross under their own funding versus
    // park at the crossing is not the thing under test.
    let i = 0;
    while ((await matB.occupancy()) < 3n && i < externals.length) {
      await growMatBByOne(ctx, cyclers, externals, i);
      i++;
    }
    expect(await matB.occupancy(), "MatB is past 4000 bps").to.be.gte(3n);

    // _tryAdvancePair only runs on an ENTRY, and it reads occupancy BEFORE seating —
    // so the crossing that met the threshold cannot itself have fired the factory.
    expect(await pm.pairCount(),
      "nothing has registered since the threshold was met").to.equal(1n);

    const trigger = externals[i];
    await reg(ctx, trigger, W1.address);

    expect(await pm.pairCount(), "the factory must spawn the successor pair").to.equal(2n);

    // THE LEAD TIME: pair 0 is not yet full when its successor arrives.
    expect(await combinedOccupancy(ctx),
      "expansion must happen EARLY — pair 0 still has seats").to.be.lt(BigInt(2 * SIZE));

    const p1    = await pm.pairs(1);
    const matA2 = await ethers.getContractAt("FigureEightMatrixV8", p1.matrixA);
    const matB2 = await ethers.getContractAt("FigureEightMatrixV8", p1.matrixB);
    expect(await matA2.partner(), "spawned MatA wired to its MatB").to.equal(p1.matrixB);
    expect(await matB2.partner(), "spawned MatB wired to its MatA").to.equal(p1.matrixA);
    expect(await matA2.pairManager(), "spawned pair answers to this PairManager").to.equal(ctx.pmAddr);

    // NO DILUTION. Spawning a pair must not open a second front door: the member
    // whose entry triggered the expansion still enters pair 0, and pair 1 stays empty
    // until an EXISTING member is routed into it.
    expect(await matA.isActiveInMatrix(trigger.address),
      "the triggering member enters pair 0 — one point of entry").to.equal(true);
    expect(await matA2.occupancy(),
      "a freshly spawned pair receives nothing from the front door").to.equal(0n);
    expect(p1.totalRegistered).to.equal(0n);
  });

  it("O5b: NEGATIVE CONTROL — the identical drive with the trigger at 100% does NOT expand", async function () {
    const SIZE = 7;
    const ctx  = await deployOnePairWithFactory(SIZE);
    const { pm, matB, owner, W1 } = ctx;

    // Identical to O5 in every respect except the one number under test. Without
    // this, O5 proves only that a pair APPEARED during a run that registered
    // members — not that MatB occupancy crossing the threshold is what caused it.
    // A detector that reports a positive has to be shown reporting a negative:
    // bypass_scan_full.js printed "0 direct-entry seats" twice, confidently, with a
    // proven positive sitting inside its own scanned range.
    await pm.connect(owner).setFactoryExpandThreshold(10_000n);

    const { cyclers, externals } = await fillMatAOnly(ctx, SIZE);
    let i = 0;
    while ((await matB.occupancy()) < 3n && i < externals.length) {
      await growMatBByOne(ctx, cyclers, externals, i);
      i++;
    }
    expect(await matB.occupancy(), "same MatB state that fired the factory in O5").to.be.gte(3n);

    await reg(ctx, externals[i], W1.address);

    expect(await pm.pairCount(),
      "3/7 is under 100% — the THRESHOLD decides, not the drive").to.equal(1n);
  });

  it("O6: FULL-pair backstop — a pair at MATRIX_SIZE in both halves always gets a successor", async function () {
    const SIZE = 7;
    const ctx  = await deployOnePairWithFactory(SIZE);
    const { pm, matA, matB, owner, W1 } = ctx;

    // Early trigger pushed to its maximum so it cannot fire before the pair is
    // physically full.
    //
    // THE HONEST LIMIT OF THIS ISOLATION, recorded rather than papered over:
    // setFactoryExpandThreshold caps at BPS_DENOM and occupancy() can never exceed
    // MATRIX_SIZE, so a full pair implies a full MatB implies 10000 bps — i.e.
    // `fullTrigger` implies `matBTrigger` for EVERY legal setting, and can never be
    // the sole cause of an expansion. `_pairFull` is DEFENCE IN DEPTH, not a second
    // independent trigger. It earns its bytes in exactly one place: if occupancy ever
    // drifts ABOVE MATRIX_SIZE (the V8.44 phantom-seat class — "occupancy drift +44"),
    // MatB can read 6/7 while the pair sums to full, and only fullTrigger sees it.
    // Worth knowing before anyone reclaims those bytes under the item-30 doctrine.
    await pm.connect(owner).setFactoryExpandThreshold(10_000n);

    const { cyclers, externals } = await fillMatAOnly(ctx, SIZE);

    let i = 0;
    while ((await combinedOccupancy(ctx)) < BigInt(2 * SIZE) && i < externals.length) {
      await growMatBByOne(ctx, cyclers, externals, i);
      i++;
    }

    expect(await combinedOccupancy(ctx), "pair 0 is physically full").to.equal(BigInt(2 * SIZE));
    expect(await pm.pairCount(), "…and still has no successor").to.equal(1n);

    // This is the member-facing invariant the backstop exists for: the routing rule
    // must always have somewhere to send a member who cannot stay in their own pair
    // (rescueReentry -> _freePairFor). A full protocol with no successor is a member
    // parked for want of a seat.
    await reg(ctx, externals[i], W1.address);
    expect(await pm.pairCount(),
      "an entry meeting a full pair must spawn the next one").to.equal(2n);

    const p1 = await pm.pairs(1);
    expect(p1.matrixA).to.not.equal(ethers.ZeroAddress);
    expect(p1.matrixB).to.not.equal(ethers.ZeroAddress);

    // And a free seat genuinely exists for the next member who must move.
    const matA2 = await ethers.getContractAt("FigureEightMatrixV8", p1.matrixA);
    expect(await matA2.occupancy()).to.be.lt(await matA2.MATRIX_SIZE());
    expect(await pm.freePairFor(W1.address, 0),
      "freePairFor now has a real destination").to.equal(1n);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // V8.48 item 34 (part B) — O4 STRENGTHENED.
  //
  // O4's pair-1 assertion had to be softened to "wired and standing by" because a
  // 27-registration run generates no duplicates, so pair 1 legitimately received
  // nothing and there was nothing honest to assert. That is a real gap: it leaves
  // the SECOND HALF of the routing rule untested. The rule has two limbs —
  //
  //   new members       -> one door, pair 0, always
  //   existing members  -> own pair, or the NEXT FREE PAIR when they already hold a
  //                        seat here (PairManagerV8.freePairFor), or up a tier
  //
  // — and only the first was covered. This gate drives enough volume that the
  // second limb actually fires, then proves BOTH limbs from the same event log:
  // every member's FIRST routing is pair 0, and every routing INTO pair 1 belongs
  // to a member who was already in the protocol.
  // ───────────────────────────────────────────────────────────────────────────

  it("O7: DESIGN-LAW GATE, strengthened — pair 1 fills from EXISTING members cycling, never from the front door (restored V8.52b)", async function () {
    const SIZE = 4;
    const ctx  = await deployTwoPairs(SIZE);
    const { pm, tr, matA, matB, matA2, matB2, W1, sigs, owner, usdc } = ctx;

    await reg(ctx, W1, ethers.ZeroAddress);

    // The member-driven route into a second pair is the DOUBLE seat
    // (TierRouter:1382 -> PairManagerV8.freePairFor). It is gated on
    // `cycles >= reentryMinCycles`; lower that to the minimum the enumerated DAO
    // setter accepts (it refuses 0, so 1 is the floor).
    await tr.connect(owner).setReentryMinCycles(1);
    // (disableUpgrade, enableReentry, enableDouble) — note the FIRST flag is
    // disable-upgrade, not enable-reentry. Upgrade is disabled deliberately: there
    // is one tier on this rig, so an upgrade attempt is noise, and what is under
    // test is the SAME-TIER second-pair route.
    await tr.connect(W1).setMemberOptions(true, true, true);

    // W1 refers everyone, so W1 is the member who actually accrues enough to fund a
    // second seat. That is not a rigged shortcut — it is the funding constraint the
    // protocol already documents: the crossing reserve covers exactly 50% of the
    // next fee, and referral income is what closes the gap.
    const wallets = sigs.slice(10, 160);
    const allMats = [matA, matB, matA2, matB2];
    const rescueParked = async () => {
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

    // Pure member-driven churn — registrations plus selfRescue, no keeper anywhere.
    let wi = 0, reached = false;
    for (let i = 0; i < 70 && !reached; i++) {
      await reg(ctx, wallets[wi++], W1.address);
      await rescueParked();
      reached = ((await matA2.occupancy()) + (await matB2.occupancy())) > 0n;
    }

    // Diagnostic rather than a bare boolean: if the second limb never fires we want
    // to know HOW FAR it got, not just that an expectation failed.
    expect(reached,
      `pair 1 never received a member after ${wi} registrations ` +
      `(pair0 MatA ${await matA.occupancy()}/${SIZE}, MatB ${await matB.occupancy()}/${SIZE}, ` +
      `MatA rot ${await matA.rotationCount()}, MatB rot ${await matB.rotationCount()})`
    ).to.equal(true);

    // ── Both limbs of the routing rule, read off the same event log ───────────
    const routed  = await pm.queryFilter(pm.filters.MemberRouted());
    const firstAt = new Map();
    routed.forEach((ev, idx) => {
      if (!firstAt.has(ev.args.member)) firstAt.set(ev.args.member, idx);
    });

    // LIMB 1 — ONE DOOR. Every member's first appearance is pair 0. New entries are
    // never diluted across pairs.
    //
    // HISTORY, KEPT PER REGRESSION_REGISTER R11 (2026-09-03/04): V8.52a briefly restated
    // this law as "the front door is the least-rotated FULL MatA", because the one door had
    // left every later pair with no entry source (T1.2 MatA 127/127 at 0 rotations, live
    // 2026-09-03). Measured on the private chain it starved pair 0 instead (R3). V8.52b
    // RESTORES this law unchanged and cures R1 where the owner said it belonged: the
    // CIRCULATION — re-entries and rescues, which end in a real `enterFor` — enters a full
    // later pair (`_fullPairWaitingLongest`) and that entry is what rotates it. Asserted as
    // F4 (no registration's first seat is pair 1) + F1 (pair 1 rotates anyway) in
    // test/V8_52_FrozenPair.test.js.
    for (const [member, idx] of firstAt) {
      expect(routed[idx].args.pairId,
        `member ${member} entered through pair ${routed[idx].args.pairId}, not the front door`
      ).to.equal(0n);
    }

    // LIMB 2 — EXISTING MEMBERS POPULATE LATER PAIRS, through the real route.
    const intoPair1 = routed
      .map((ev, idx) => ({ ev, idx }))
      .filter(({ ev }) => ev.args.pairId === 1n);

    expect(intoPair1.length,
      "pair 1 must have received at least one member from member-driven flow").to.be.gt(0);

    for (const { ev, idx } of intoPair1) {
      expect(idx, `${ev.args.member} was routed straight into pair 1 on its first appearance`)
        .to.be.gt(firstAt.get(ev.args.member));
    }

    // And it is a real seat, not a bookkeeping entry.
    expect((await matA2.occupancy()) + (await matB2.occupancy()),
      "pair 1 holds live members").to.be.gt(0n);

    // NAME THE ROUTE. "An existing member reached pair 1" is only half a claim —
    // freePairFor has two callers (the DOUBLE at TierRouter:1382, and the duplicate
    // branch of PairManagerV8.rescueReentry) and they emit the same MemberRouted
    // event, so the log alone cannot tell them apart. DoubleEntryFired can.
    //
    // It must be the double here, and only the double: rescueReentry's branch needs
    // a member who ALREADY holds a seat in the pair they are re-entering, which on a
    // fresh deploy can only come from a prior second-pair seat. The first entry into
    // pair 1 therefore has to be the double — this asserts that rather than assuming
    // it. (TierRouterLib.sameTierTarget returns the member's OWN pairIndex, so there
    // is no forward-graduation path that could have filled pair 1 instead.)
    //
    // ⛔ RETARGETED — V8.50 ITEM S (session 53, 2026-08-31). The paragraph above argued the
    // double must be the ONLY possible feeder, because "rescueReentry's branch needs a member
    // who ALREADY holds a seat in the pair they are re-entering". Item S added a SECOND
    // rescueReentry route into a later pair — the _bothHalvesFull escape hatch — which needs
    // no duplicate seat at all. So that reasoning is now false, DoubleEntryFired came back 0,
    // and this assertion failed for the right reason. THE LAW IS UNTOUCHED: "pair 1 fills from
    // EXISTING members cycling, never from the front door" is still asserted by LIMB 1 and by
    // the firstAt check above. What changes is only that the route must be NAMED, and there
    // are now two legitimate names.
    const doubles = await tr.queryFilter(tr.filters.DoubleEntryFired());
    const overflowed = await ctx.pm.queryFilter(ctx.pm.filters.RescueOverflowed());
    expect(doubles.length + overflowed.length,
      "pair 1 must have been fed by a NAMED route — the DOUBLE seat (TierRouter:1382 -> " +
      "freePairFor) or item S's saturation escape hatch (PairManagerV8 _bothHalvesFull -> " +
      "_pairWithRoomFor). Zero of BOTH means somebody reached pair 1 by a path nobody declared."
    ).to.be.gt(0);

    const routedMembers = new Set([
      ...doubles.map((d) => d.args.member),
      ...overflowed.map((o) => o.args.member),
    ]);
    const inPair1 = [];
    for (const m of routedMembers) {
      if ((await matA2.isActiveInMatrix(m)) || (await matB2.isActiveInMatrix(m))) inPair1.push(m);
    }
    expect(inPair1.length,
      "a member named by one of those two routes is the one holding the pair-1 seat").to.be.gt(0);

    // The V8.46 universal pair guard still holds while all this is happening: a
    // member may hold a seat in TWO PAIRS, never in both halves of ONE pair. That is
    // the invariant the whole second-pair route exists to respect.
    for (const m of routedMembers) {
      expect(
        (await matA.isActiveInMatrix(m)) && (await matB.isActiveInMatrix(m)),
        `${m} holds both halves of pair 0`).to.equal(false);
      expect(
        (await matA2.isActiveInMatrix(m)) && (await matB2.isActiveInMatrix(m)),
        `${m} holds both halves of pair 1`).to.equal(false);
    }

    // The law O4 asserts must still hold while all of that happens.
    expect(await matA.rotationCount(), "pair-0 MatA still cycling").to.be.gt(0n);
    expect(await matB.rotationCount(), "pair-0 MatB still rotating WITHOUT any keeper").to.be.gt(0n);
  });

  it("O8: the routing VIEWS report the door new members actually use, even with pair 0 full", async function () {
    // V8.48 — found while wiring the tier card. Three public views claimed to report
    // "the routing target" via _findRoutingPair() ("oldest pair with a free MatA seat,
    // else the newest"), but registrations go through _findExternalPair(), which returns
    // 0. The two agree ONLY while pair 0's MatA has room — and a full pair 0 is the
    // DESIGNED STEADY STATE, so the views went wrong precisely when the design worked.
    //
    // The frontend reads all three. It would have labelled the empty standby pair
    // "taking new entries" and drawn the home card's seat bars from that pair's empty
    // matrices — the "T1.2 reads 0/127 while the community fills T1.1" bug, reintroduced
    // from the contract side. Not one of the three had a test.
    const SIZE = 7;
    const ctx  = await deployTwoPairs(SIZE);
    const { pm, matA, matA2, W1, sigs } = ctx;

    await fillMatAOnly(ctx, SIZE);
    expect(await matA.occupancy(), "pair 0 MatA must be FULL — the state that broke them")
      .to.equal(BigInt(SIZE));

    // PROVE THIS TEST IS ON THE DIVERGENCE, not on a state where both rules agree.
    // Recompute the DELETED rule here in the test — "oldest pair whose MatA still has a
    // free seat, else the newest" — and assert it gives a DIFFERENT answer to the one
    // the views must now report. Without this, O8 would still pass if someone
    // reintroduced _findRoutingPair and the fixture happened to sit where the two rules
    // coincide, which is any state where pair 0 has room. That is most states, so the
    // odds of a silently-vacuous regression test here are high.
    let legacyIdx = -1;
    for (let p = 0; p < 2; p++) {
      const m = p === 0 ? matA : matA2;
      if ((await m.occupancy()) < (await m.MATRIX_SIZE())) { legacyIdx = p; break; }
    }
    expect(legacyIdx, "the deleted rule must point somewhere ELSE here, or this test proves nothing")
      .to.equal(1);

    const [, , activeId] = await pm.getActivePair();
    expect(activeId, "getActivePair must name the door, not the first pair with a free seat")
      .to.equal(0n);

    const status = await pm.allPairsStatus();
    expect(status[5][0], "allPairsStatus must flag pair 0 as active").to.equal(true);
    expect(status[5][1], "…and must NOT flag the empty standby pair").to.equal(false);

    const dist = await pm.routingDistribution();
    expect(dist.sharesBps[0], "routingDistribution: 100% to pair 0").to.equal(10_000n);
    expect(dist.sharesBps[1], "routingDistribution: nothing to pair 1").to.equal(0n);

    // …and the views agree with what the contract actually DOES.
    const newcomer = sigs[60];
    await reg(ctx, newcomer, W1.address);
    expect(await matA.isActiveInMatrix(newcomer.address),
      "the new member really did enter pair 0").to.equal(true);
    expect(await matA2.isActiveInMatrix(newcomer.address)).to.equal(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // V8.48 — THE 2ND-PAIR ROUTE ON THE ORDINARY RE-ENTRY PATH.
  //
  // Owner's rule: A -> B -> A **2nd pair** when the member already holds a seat in
  // this pair. It was live on rescueReentry (item 31) and on the double
  // (TierRouter:1382) but NOT on ordinary re-entry: sameTierTarget steered an
  // already-seated member to their own MatB, which V8.46's universal pair guard
  // refuses outright, so the re-entry reverted and the member PARKED — for want of a
  // seat that existed one pair over.
  // ───────────────────────────────────────────────────────────────────────────

  async function callRegisterFor(ctx, member, targetPair) {
    await ethers.provider.send("hardhat_impersonateAccount", [ctx.trAddr]);
    await ethers.provider.send("hardhat_setBalance", [ctx.trAddr, "0x56BC75E2D63100000"]);
    const asRouter = await ethers.getSigner(ctx.trAddr);
    await ctx.usdc.mint(ctx.trAddr, FEE);
    await ctx.usdc.connect(asRouter).approve(ctx.pmAddr, FEE);
    const rc = await (await ctx.pm.connect(asRouter)
      .registerFor(member, ctx.W1.address, targetPair, { gasLimit: 16_000_000 })).wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.trAddr]);
    const ev = rc.logs
      .map(l => { try { return ctx.pm.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find(e => e.name === "MemberRouted");
    expect(ev, "MemberRouted not emitted").to.not.equal(undefined);
    return ev.args.pairId;
  }

  it("O9: re-entry into a pair the member already occupies takes the 2ND-PAIR route, never parks", async function () {
    const ctx = await deployTwoPairs(4);
    const { matA, matA2, W1 } = ctx;

    await reg(ctx, W1, ethers.ZeroAddress);
    expect(await matA.isActiveInMatrix(W1.address),
      "W1 holds a seat in pair 0 — the duplicate condition").to.equal(true);

    // TierRouter's re-entry passes the member's OWN pair (sameTierTarget). Pre-fix this
    // aimed at pair 0's MatB and the universal pair guard refused it.
    const dest = await callRegisterFor(ctx, W1.address, 0);

    expect(dest, "must be routed to the next pair where the member holds nothing").to.equal(1n);
    expect(await matA2.isActiveInMatrix(W1.address), "…and actually seated there").to.equal(true);

    // The V8.46 invariant still holds: two PAIRS yes, both halves of one pair never.
    expect((await matA.isActiveInMatrix(W1.address)) && (await ctx.matB.isActiveInMatrix(W1.address)),
      "must not hold both halves of pair 0").to.equal(false);
  });

  it("O9b: CONTROL — a member who holds nothing in the target pair still seats THERE", async function () {
    // Without this, O9 would pass if registerFor simply always diverted, which would
    // break the DEFAULT route (A -> B -> A same pair) and quietly dilute every re-entry
    // into the next pair. The branch must fire ONLY on a real duplicate.
    const ctx = await deployTwoPairs(4);
    const { matA, matA2, W1, sigs } = ctx;

    await reg(ctx, W1, ethers.ZeroAddress);
    const fresh = sigs[30];
    expect(await matA.isActiveInMatrix(fresh.address), "holds nothing anywhere").to.equal(false);

    const dest = await callRegisterFor(ctx, fresh.address, 0);

    expect(dest, "no duplicate, so the target pair stands — own pair by default").to.equal(0n);
    expect(await matA.isActiveInMatrix(fresh.address)).to.equal(true);
    expect(await matA2.isActiveInMatrix(fresh.address), "must NOT have been diverted").to.equal(false);
  });
});
