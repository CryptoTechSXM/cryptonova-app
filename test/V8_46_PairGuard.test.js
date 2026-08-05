"use strict";
/**
 * V8_46_PairGuard.test.js — the pair guard, containment, and double routing.
 *
 * WHAT THIS IS A REGRESSION FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-07-28 dupe_watch.js recorded duplicate seats FORMING, with the
 * transaction that created each one. 67 formations, 17 members, 18,700 blocks:
 *
 *      coPayRescue   52
 *      selfRescue     7
 *      manualUpgrade  6
 *      performUpkeep  2
 *
 * 57 of 67 formed in a tier BELOW the member's highest and ZERO above. An
 * upgrade always seats you ABOVE your highest, so the upgrade path — the one the
 * 2026-07-27 draft fix guarded — accounts for six of sixty-seven. The rescue
 * paths do 88%.
 *
 * MECHANISM: selfRescue:1108 and coPayRescue:1071 both require
 * !self.members[member].isInMatrix — THIS matrix, the one they are parked in.
 * They then seat the member through _finalizeCrossing into the PARTNER. The
 * destination is never checked. A member parked in one half while still seated
 * in the other is rescued straight into holding both.
 *
 * Harmless until they reach position 1. Then the rotation cycles them out of
 * MatA, _crossToPartner tries to seat them in the MatB they occupy, and that
 * revert propagates OUT of the rotation and kills whatever transaction triggered
 * it — a stranger's register(). T3.1 and T4.1 were both stopped this way and had
 * to be repaired on the live contracts.
 *
 * THE FIX IS THREE PARTS AND THIS FILE COVERS ALL THREE
 * ─────────────────────────────────────────────────────────────────────────────
 * G1  PREVENT   MatrixLogicLib:255 refuses a seat when the member holds the
 *               partner. Placed at the one point a seat is actually taken, so
 *               rescue, upgrade, crossing and registration are all covered by
 *               one guard rather than six patched call sites.
 * G2  CONTAIN   _cycleOutRoot checks the destination before crossing and PARKS
 *               instead of letting the revert escape. Prevention stops NEW
 *               duplicates; this protects the pair from the ~20 already live and
 *               from any cause nobody has found yet.
 * G3  ROUTE     A double seat goes to a DIFFERENT pair. The V8.45 double went to
 *               the other half of the member's own pair, which is a duplicate by
 *               construction — the feature was manufacturing the bug.
 *
 * NOTE ON G2's SETUP: with the guard in place, no supported path can create a
 * duplicate any more — which is the point, and which means the test cannot build
 * its own premise honestly through the front door. It constructs the state the
 * way the OLD code left it, by pointing MatB's partner at a decoy while seating,
 * then restoring it. That is a faithful reproduction of a pre-fix duplicate, not
 * a contrivance: it is exactly the state the 67 live formations left behind.
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
const SIZE = 4;                    // routing test, not a gas test

async function deployTier(extraPair = false) {
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

  const mk = async (isA) => MX.deploy(dp, FEE, SIZE, isA, 0, SPLITS, CP_BPS);
  const matA = await mk(true), matB = await mk(false);
  const all  = [matA, matB];
  let matA2 = null, matB2 = null;
  if (extraPair) { matA2 = await mk(true); matB2 = await mk(false); all.push(matA2, matB2); }

  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  if (extraPair) {
    await matA2.setPartner(await matB2.getAddress());
    await matB2.setPartner(await matA2.getAddress());
  }
  for (const m of all) {
    await m.setPairManager(await pm.getAddress());
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await matA.getAddress(), await matB.getAddress());
  if (extraPair) await pm.addPair(await matA2.getAddress(), await matB2.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await tr.setTierMatrices(0, await matA.getAddress(), await matB.getAddress());
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  await pm.setEntryThresholds(1, 2);
  return { usdc, tr, pm, matA, matB, matA2, matB2, owner, W1,
           pmAddr: await pm.getAddress(), MX, dp };
}

async function newWallet(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

async function register(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  return ctx.tr.connect(s).register(ref, { gasLimit: 16_000_000 });
}

/** Seat `member` into `matrix` by impersonating the PairManager, exactly as
 *  PairManagerV8.registerFor does (pre-transfer the fee, then enterFor). */
async function forceSeat(ctx, matrix, member, referrer) {
  const addr = await matrix.getAddress();
  await ctx.usdc.mint(ctx.owner.address, FEE);
  await ctx.usdc.connect(ctx.owner).transfer(addr, FEE);
  await ethers.provider.send("hardhat_impersonateAccount", [ctx.pmAddr]);
  await ethers.provider.send("hardhat_setBalance",
    [ctx.pmAddr, "0x" + (10n ** 20n).toString(16)]);
  const pmSigner = await ethers.getSigner(ctx.pmAddr);
  const tx = await matrix.connect(pmSigner).enterFor(member, referrer, { gasLimit: 16_000_000 });
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.pmAddr]);
  return tx;
}

describe("V8.46 — the pair guard", function () {
  this.timeout(900_000);

  it("G1: a member seated in MatA cannot also be seated in MatB of the same pair", async () => {
    const ctx = await deployTier();
    const m = await newWallet(ctx);

    await forceSeat(ctx, ctx.matA, m.address, ctx.W1.address);
    expect(await ctx.matA.isActiveInMatrix(m.address)).to.equal(true);

    // THE FIX. Pre-V8.46 this succeeded and left the member holding both halves
    // — the state that stopped T3.1 and T4.1 on the live contracts. The string is
    // reused deliberately: MatrixKeeper:558 already treats it as expected on the
    // parked-rescue path, so a co-pay that would duplicate is skipped cleanly.
    await expect(forceSeat(ctx, ctx.matB, m.address, ctx.W1.address))
      .to.be.revertedWith("F8V8: already in matrix");

    expect(await ctx.matB.isActiveInMatrix(m.address)).to.equal(false);
  });

  it("G1b: the guard is symmetric — MatB first also blocks MatA", async () => {
    const ctx = await deployTier();
    const m = await newWallet(ctx);
    await forceSeat(ctx, ctx.matB, m.address, ctx.W1.address);
    await expect(forceSeat(ctx, ctx.matA, m.address, ctx.W1.address))
      .to.be.revertedWith("F8V8: already in matrix");
  });

  it("G2: an EXISTING duplicate parks its holder instead of killing a stranger's transaction", async () => {
    const ctx = await deployTier();
    const victim = await newWallet(ctx);

    // Build the pre-fix state: point MatB's partner at a decoy so the new guard
    // looks the wrong way, seat the member in both halves, then restore. This is
    // the exact state the 67 live formations left behind.
    const decoy = await ctx.MX.deploy(ctx.dp, FEE, SIZE, true, 0, SPLITS, CP_BPS);
    await ctx.matB.setPartner(await decoy.getAddress());
    await forceSeat(ctx, ctx.matA, victim.address, ctx.W1.address);
    await forceSeat(ctx, ctx.matB, victim.address, ctx.W1.address);
    await ctx.matB.setPartner(await ctx.matA.getAddress());

    expect(await ctx.matA.isActiveInMatrix(victim.address)).to.equal(true);
    expect(await ctx.matB.isActiveInMatrix(victim.address)).to.equal(true);

    // Fill MatA so the duplicate holder reaches the root and the next entry
    // triggers the rotation that would cross them into the MatB they occupy.
    const others = [];
    for (let i = 0; i < SIZE + 2; i++) {
      const w = await newWallet(ctx);
      others.push(w);
      // THE ASSERTION THAT MATTERS: a stranger's registration must SUCCEED.
      // Pre-V8.46 the revert from _crossToPartner propagated out of the rotation
      // and reverted this transaction — one member's bad state denying service
      // to everyone entering the pair.
      await expect(register(ctx, w, ctx.W1.address)).to.not.be.reverted;
    }

    // And the duplicate holder must not have vanished: park-not-exit holds on
    // the failure path too, so they keep their funds and can be rescued once
    // their other seat cycles out.
    const stillA = await ctx.matA.isActiveInMatrix(victim.address);
    const stillB = await ctx.matB.isActiveInMatrix(victim.address);
    const parked = await ctx.matA.isParked(victim.address);
    expect(stillA && stillB, "must not still hold both halves after rotating through").to.equal(false);
    expect(stillA || stillB || parked, "must be seated somewhere or parked — never gone").to.equal(true);
  });

  it("G3: freePairFor picks a pair the member is not in, and reports when there is none", async () => {
    const ctx = await deployTier(true);          // two pairs in the tier
    const m = await newWallet(ctx);
    const MAX = (1n << 256n) - 1n;

    // Nobody seated anywhere: starting after pair 0 must offer pair 1.
    expect(await ctx.pm.freePairFor(m.address, 0)).to.equal(1n);

    // Seated in pair 0 -> the double must be sent to pair 1, NOT to pair 0's
    // other half. That same-pair placement is what made the double seat a
    // duplicate by construction in V8.45.
    await forceSeat(ctx, ctx.matA, m.address, ctx.W1.address);
    expect(await ctx.pm.freePairFor(m.address, 0)).to.equal(1n);

    // Seated in BOTH pairs -> no free pair. TierRouter skips the double rather
    // than attempting it: the double runs inside the cycle-out, so a revert
    // would roll back the re-entry and upgrade that already succeeded in the
    // same call. A skipped double costs a bonus seat; a reverted one costs the
    // member their place in the tier.
    await forceSeat(ctx, ctx.matA2, m.address, ctx.W1.address);
    expect(await ctx.pm.freePairFor(m.address, 0)).to.equal(MAX);
  });
});
