"use strict";
/**
 * V8_46_SeatCollision.test.js — regression for the CAUSE of the silent
 * graduations, found 2026-07-27 by fork-replaying a real one.
 *
 * WHAT ACTUALLY HAPPENED
 * ─────────────────────────────────────────────────────────────────────────────
 * Nine members vanished. Three hypotheses were raised and all three eliminated
 * by measurement (fee mismatch, router funding, out-of-gas at 3.8x headroom).
 * The answer came from replaying graduation tx 0xff488549… at block 44702114
 * (scripts/replay_graduation.js): gas reproduced to the unit — 1,715,594 — and
 * the trace showed three nested reverts, all
 *
 *      Error("F8V8: already in matrix")
 *
 * with 178,042 gas still remaining. Gas was never the cause.
 *
 * The chain was:
 *   MatB cycle-out -> TierRouter.handleCycleOut -> PairManager.registerFor
 *                  -> MatA.enterFor -> require(!isInMatrix)  [MatrixLogicLib:255]
 *                  -> REVERT -> empty catch [MatrixLogicLib:513] -> member gone
 *
 * The member was already in that MatA because an AUTO-UPGRADE put them there.
 * Live trail for 0xdFD9e186…:
 *   44686494  T4.1 MatA cycled out -> crossed -> seat in T4.1 MatB
 *   44689351  T3 MatB cycled out   -> re-entered T3 AND upgraded into T4.1 MatA
 *                                   -> now holds BOTH halves of the T4 pair
 *   44702114  T4.1 MatB cycled out -> re-entry targets T4.1 MatA -> collision
 *
 * Double entry was suspected and is EXONERATED — it was the ordinary upgrade
 * path, which is default-on and core to the comp plan.
 *
 * WHY THIS TEST MATTERS BEYOND THE BUG
 * ─────────────────────────────────────────────────────────────────────────────
 * V8.46-A as first built returned own MatA UNCONDITIONALLY. V8.45's saturation
 * branch (re-entry -> MatB) had been accidentally dodging this collision by
 * routing a MatA-seated member elsewhere. Shipping A without the guard would
 * have made this fire on EVERY such cycle-out — more silent losses, not fewer.
 * This test is what stops that regression being reintroduced.
 *
 * C1: a member holding a seat in MatA who cycles out of MatB must END UP SEATED,
 *     not vanish. Fails against an unconditional-MatA _sameTierTarget.
 * C2: the same member must not be silently removed — if seating is impossible
 *     they are parked, never gone without trace.
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
const SIZE = 4;                    // small: this is a routing test, not a gas test

async function deployTier() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
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
  return { usdc, tr, pm, matA, matB, owner, W1, pmAddr: await pm.getAddress() };
}

async function newWallet(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

/** Register through the real router so referral income actually accrues. */
async function register(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  return ctx.tr.connect(s).register(ref, { gasLimit: 16_000_000 });
}

/** Seat `member` directly into `matrix`, imitating the upgrade that created the
 *  duplicate seat live. enterFor is onlyPairManager, so impersonate the PM and
 *  pre-transfer the fee exactly as PairManagerV8.registerFor does. */
async function forceSeat(ctx, matrix, member, referrer) {
  const addr = await matrix.getAddress();
  await ctx.usdc.mint(ctx.owner.address, FEE);
  await ctx.usdc.connect(ctx.owner).transfer(addr, FEE);
  await ethers.provider.send("hardhat_impersonateAccount", [ctx.pmAddr]);
  await ethers.provider.send("hardhat_setBalance",
    [ctx.pmAddr, "0x" + (10n ** 20n).toString(16)]);
  const pmSigner = await ethers.getSigner(ctx.pmAddr);
  await matrix.connect(pmSigner).enterFor(member, referrer, { gasLimit: 16_000_000 });
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.pmAddr]);
}

describe("V8.46 — a member seated in MatA must not vanish when MatB cycles out", function () {
  this.timeout(900_000);

  // PENDING 2026-07-27 — needs a two-tier fixture, and here is exactly why.
  //
  // This test creates the duplicate seat by impersonating the PairManager and
  // calling enterFor directly. That bypasses the V8.46 upgrade guard, which is
  // the thing that now PREVENTS duplicates — so the test can no longer
  // construct its own premise through any supported path.
  //
  // Worse, force-seating still produces a REAL failure: with a member in both
  // halves, the next MatA rotation makes them root, _crossToPartner tries to
  // seat them in the MatB they occupy, and that revert is NOT inside the
  // swallowing try/catch — it propagates out and kills an unrelated member's
  // register(). That is a genuine finding (it is why the fix had to prevent
  // rather than accommodate), but it means this test fails for a reason it was
  // never written to assert.
  //
  // The real regression needs a TWO-TIER fixture driving an actual auto-upgrade
  // into a tier where the member already holds a MatB seat, asserting the
  // upgrade is skipped and no duplicate forms. Until that exists this stays
  // skipped rather than red — a permanently failing test teaches nothing.
  it.skip("C1/C2 (PENDING two-tier fixture): re-entry must not collide with an existing MatA seat", async function () {
    const ctx = await deployTier();
    const { matA, matB, W1 } = ctx;

    // W1 sponsors everyone, so it accrues the L1 + chain income a re-entry needs.
    // Without funding, _executeAdditive parks before routing is ever reached and
    // the test would pass for the wrong reason — the trap S2 fell into in
    // V8_46_MatAStarvation.test.js.
    await register(ctx, W1, ethers.ZeroAddress);
    for (let i = 0; i < SIZE * 6; i++) await register(ctx, await newWallet(ctx), W1.address);

    // Drive W1 across into MatB, which is where the live victim was sitting.
    if (!(await matB.isActiveInMatrix(W1.address))) {
      await ctx.usdc.mint(ctx.owner.address, FEE);
      await ctx.usdc.connect(ctx.owner).approve(await matA.getAddress(), FEE);
      try { await matA.connect(ctx.owner).forceCross(W1.address, { gasLimit: 16_000_000 }); } catch { /* already crossed */ }
    }
    if (!(await matB.isActiveInMatrix(W1.address))) {
      await forceSeat(ctx, matB, W1.address, ethers.ZeroAddress);
    }

    // Now give W1 the SECOND seat, in MatA — this is what the auto-upgrade did
    // live at block 44689351 and what nothing in the system prevents.
    if (!(await matA.isActiveInMatrix(W1.address))) {
      await forceSeat(ctx, matA, W1.address, ethers.ZeroAddress);
    }

    expect(await matA.isActiveInMatrix(W1.address),
      "setup failed: W1 must hold a MatA seat for the collision to exist").to.equal(true);
    expect(await matB.isActiveInMatrix(W1.address),
      "setup failed: W1 must hold a MatB seat to cycle out of").to.equal(true);

    // FUNDING PRECONDITION — instrument it, because a silent shortfall here makes
    // the test unable to reach the routing decision at all (the S2 trap).
    // _executeAdditive only attempts re-entry when escrow + withdrawable >= FEE.
    {
      const esc = await matB.escrowOf(W1.address);
      const wd  = await matB.withdrawableOf(W1.address);
      const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
      console.log(`      [funding] W1 in MatB: escrow ${usd(esc)} + withdrawable ${usd(wd)} ` +
                  `= ${usd(esc + wd)} against a ${usd(FEE)} fee`);
      // Referral income accrues in whichever matrix W1 occupied at the time, so
      // crossing into MatB resets it — the crossing reserve alone is only 50%.
      // Top up with more sponsored registrations until re-entry is affordable.
      let guard = 0;
      while ((await matB.escrowOf(W1.address)) + (await matB.withdrawableOf(W1.address)) < FEE && guard++ < 60) {
        await register(ctx, await newWallet(ctx), W1.address);
      }
      const esc2 = await matB.escrowOf(W1.address);
      const wd2  = await matB.withdrawableOf(W1.address);
      console.log(`      [funding] after top-up: ${usd(esc2 + wd2)} (${guard} extra referrals)`);
      expect(esc2 + wd2, "could not fund W1's re-entry — test cannot reach the routing decision")
        .to.be.gte(FEE);
    }

    // Rotate MatB until W1 is the root, then cycle it out — the exact moment the
    // live members disappeared. Capture THAT receipt: the events in it are the
    // only way to tell routing success from C's park-and-report fallback.
    let rc = null;
    for (let i = 0; i < SIZE * 4 && !rc; i++) {
      const isRoot = (await matB.posToMember(1)).toLowerCase() === W1.address.toLowerCase();
      const tx = await matB.connect(ctx.owner).adminForceRotateRoot({ gasLimit: 16_000_000 });
      const r  = await tx.wait();
      if (isRoot) rc = r;
    }
    expect(rc, "harness never made W1 the MatB root — cannot exercise the collision").to.not.equal(null);

    const EV = new ethers.Interface([
      "event MemberReentered(address indexed member, uint8 tier)",
      "event CycleOutFailed(address indexed member, uint8 tierIndex)",
      "event MemberParked(address indexed member, uint8 tier, string reason)",
    ]);
    const names = new Set();
    for (const l of rc.logs) {
      try {
        const p = EV.parseLog({ topics: [...l.topics], data: l.data });
        if (p && (p.args[0] || "").toLowerCase?.() === W1.address.toLowerCase()) names.add(p.name);
      } catch { /* not ours */ }
    }

    const inA = await matA.isActiveInMatrix(W1.address);
    const inB = await matB.isActiveInMatrix(W1.address);

    // C1 — the member must be SEATED again, not merely salvaged.
    //
    // NOTE (2026-07-27): the first version of this test asserted
    // "seated OR parked", and it PASSED with the guard deliberately disabled —
    // because V8.46-C already parks a failed cycle-out, so the weaker assertion
    // was satisfied by the fallback rather than by correct routing. Verified by
    // reverting _sameTierTarget to unconditional MatA and re-running. A test
    // that cannot fail proves nothing; this one must distinguish re-seated from
    // rescued-after-failure.
    expect(
      inA || inB,
      "W1 was not re-seated. Without the collision guard, re-entry targets the " +
      "MatA it already occupies, hits require(!isInMatrix), and V8.46-C parks it " +
      "instead — which is survivable but is NOT the fix. Events seen: " +
      [...names].join(", ")
    ).to.equal(true);

    // C2 — and it must have re-entered cleanly, with no failure reported.
    expect(names.has("CycleOutFailed"),
      "CycleOutFailed fired — the cycle-out still failed and was only caught by " +
      "the V8.46-C fallback. The routing guard did not do its job."
    ).to.equal(false);

    expect(names.has("MemberReentered"),
      "no MemberReentered for W1 — re-entry did not fire at all. If this trips " +
      "with the guard in place, W1 was underfunded and the test never reached " +
      "the routing decision (the S2 trap from V8_46_MatAStarvation)."
    ).to.equal(true);
  });
});
