"use strict";
/**
 * V8_46_MatAStarvation.test.js — the 2026-07-26/27 live finding.
 *
 * SYMPTOM ON V8.45 (measured live 2026-07-26 23:30-23:41 UTC, keepers running):
 *   T1.0 MatA rot 254 -> 254, T1.1 MatA 254 -> 254, T3.0 MatA 333 -> 333,
 *   T4.0 MatA 254 -> 254, T5.0 MatA 86 -> 86 over ten minutes, while the
 *   partner MatBs climbed freely (T1.0 MatB 1675 -> 1733). Members reported
 *   "haven't crossed from T1.1 Matrix A to B, not even once" across four
 *   separate wallets.
 *
 * ROOT CAUSE: TierRouter._sameTierTarget sends a re-entering member to their
 * own MatB when `pairEntries >= pairExpansionThreshold`, and to their own MatA
 * below it. `pairEntries` reads pairs[i].totalRegistered — a CUMULATIVE
 * lifetime counter, not the "combined occupancy" the doc comment describes
 * (TierRouter:230). It only ever grows, so every pair saturates permanently
 * (live: T2.0 at 2835 vs a threshold of 381). Once saturated, and once
 * overflow routes new externals to a newer pair, MatA has ZERO entry sources
 * and cannot rotate. Everyone in seats 2..127 is frozen forever.
 *
 * S1: REPRODUCE — saturated pair, no external entries: MatA rot must stay flat
 *     while MatB keeps turning. This is the live bug; it FAILS once fixed.
 * S2: FIX — below saturation the same drive must make MatA rot CLIMB with zero
 *     external registrations (the self-sustaining figure-eight).
 * S3: NO PARKING STORM — the member whose entry triggers a cascade must keep a
 *     seat, not lose the freed slot to the member cycling out beneath them.
 *     This is the risk that stopped us flipping the threshold live.
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

/** @param threshold pairExpansionThreshold. Low => saturated (re-entry to MatB,
 *  the live config). High => self-sustaining (re-entry to MatA, the proposed fix). */
async function deployPair(threshold) {
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
  // V8.46 (2026-07-27): the setter is gone — the starvation it caused is now
  // fixed in code rather than configured around. `threshold` is kept in the
  // fixture signature so the suite still reads as documentation of the original
  // bug, but it no longer has anything to set.
  void threshold;
  return { usdc, tr, pm, matA, matB, owner, W1, sigs, members: [], pmAddr: await pm.getAddress() };
}

async function reg(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(s).register(ref, { gasLimit: 16_000_000 });
  if (!ctx.members.some(m => m.address === s.address)) ctx.members.push(s);
}

/** A never-seen address, funded with gas. The signer pool is finite and a
 *  repeat address reverts "TR: already joined", so sustained churn needs
 *  fresh wallets rather than a modulo over ethers.getSigners(). */
async function newMember(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

/** Owner-funded force-cross of every parked MatA member into MatB, so MatB
 *  fills and begins rotating. Each MatB rotation cycles a member OUT, which is
 *  what produces a re-entry — the event whose destination this test is about. */
async function drainParkedIntoMatB(ctx) {
  const matAAddr = await ctx.matA.getAddress();
  for (const s of ctx.members) {
    if ((await ctx.matA.parkedAt(s.address)) > 0n) {
      await ctx.usdc.mint(ctx.owner.address, FEE);
      await ctx.usdc.connect(ctx.owner).approve(matAAddr, FEE);
      await ctx.matA.connect(ctx.owner).forceCross(s.address, { gasLimit: 16_000_000 });
    }
  }
}

/** Fill the pair and get MatB turning, then report MatA/MatB rotationCount.
 *  `rounds` drives how much earnings the seated members accumulate: a member
 *  only re-enters when escrow + withdrawable >= entry fee, so too few rounds
 *  means everyone parks and the routing branch is never reached. */
async function saturate(ctx, rounds = 8) {
  await reg(ctx, ctx.W1, ethers.ZeroAddress);
  for (let i = 0; i < rounds; i++) {
    await reg(ctx, await newMember(ctx), ctx.W1.address);
    await drainParkedIntoMatB(ctx);
  }
  return {
    rotA: await ctx.matA.rotationCount(),
    rotB: await ctx.matB.rotationCount(),
  };
}

/** How close is MatB's current root to affording a re-entry seat? */
async function rootFunding(ctx) {
  const root = await ctx.matB.posToMember(1);
  if (root === ethers.ZeroAddress) return { root, escrow: 0n, wd: 0n, total: 0n, fee: FEE };
  const [escrow, wd] = await Promise.all([
    ctx.matB.crossingReserveOf(root),
    ctx.matB.withdrawableOf(root),
  ]);
  return { root, escrow, wd, total: escrow + wd, fee: FEE };
}

/** Turn MatB WITHOUT registering anyone new — the live overnight condition,
 *  where the only activity is members cycling out and re-entering. */
async function turnMatBOnly(ctx, times) {
  for (let i = 0; i < times; i++) {
    try { await ctx.matB.connect(ctx.owner).adminForceRotateRoot({ gasLimit: 16_000_000 }); }
    catch { /* nothing left to rotate this pass */ }
  }
}

/** Decode every log a tx produced against the contracts we know, so a cycle-out
 *  can be read directly: did the re-entry route to MatA, to MatB, or did it
 *  park because the member could not fund the seat? Asserting on rotationCount
 *  alone cannot tell those apart. */
function decode(ctx, receipt) {
  const ifaces = [ctx.pm.interface, ctx.tr.interface, ctx.matA.interface];
  const out = [];
  for (const log of receipt.logs) {
    for (const iface of ifaces) {
      let parsed = null;
      try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { /* not ours */ }
      if (parsed) { out.push({ name: parsed.name, args: parsed.args, from: log.address }); break; }
    }
  }
  return out;
}

/** Rotate MatB until its root can actually afford a re-entry, then decode THAT
 *  rotation. An underfunded root parks before routing is ever consulted (the
 *  reserve covers exactly 50% of the fee, so the member must have earned the
 *  other half), which is why rotating blindly measures funding, not routing. */
async function rotateUntilFundedRoot(ctx) {
  const size = Number(await ctx.matB.MATRIX_SIZE());

  // Find a seated member who can afford the seat. Rotating blindly cycles the
  // poor ones out first and empties the matrix before ever reaching a solvent
  // one, so locate the position instead and walk it to the front.
  let target = 0;
  for (let pos = 1; pos <= size; pos++) {
    const m = await ctx.matB.posToMember(pos);
    if (m === ethers.ZeroAddress) continue;
    const [escrow, wd] = await Promise.all([
      ctx.matB.crossingReserveOf(m), ctx.matB.withdrawableOf(m),
    ]);
    if (escrow + wd >= FEE) { target = pos; break; }
  }
  if (target === 0) return { found: false, funding: await rootFunding(ctx) };

  // A member at position k reaches the root seat after k-1 rotations.
  for (let i = 0; i < target - 1; i++) {
    try { await ctx.matB.connect(ctx.owner).adminForceRotateRoot({ gasLimit: 16_000_000 }); }
    catch { break; }
  }
  const funding = await rootFunding(ctx);
  if (funding.total < funding.fee) return { found: false, funding };
  return { found: true, funding, ...(await rotateAndDecode(ctx)) };
}

/** One forced MatB rotation, fully decoded. */
async function rotateAndDecode(ctx) {
  const tx = await ctx.matB.connect(ctx.owner).adminForceRotateRoot({ gasLimit: 16_000_000 });
  const rc = await tx.wait();
  const events = decode(ctx, rc);
  const routed = events.filter(e => e.name === "MemberRouted");
  const parked = events.filter(e => e.name === "MemberParked");
  const reentered = events.filter(e => e.name === "MemberReentered");
  return { events, routed, parked, reentered, gasUsed: rc.gasUsed };
}

describe("V8.46 — MatA must not starve once a pair saturates", function () {
  this.timeout(600_000);

  // RETIRED 2026-07-27. S1 reproduced the freeze by setting a LOW
  // pairExpansionThreshold. V8.46 DELETED that knob — _sameTierTarget no longer
  // consults any threshold, so the starvation this test demonstrated can no
  // longer be configured into existence. The scenario is kept as the written
  // record of the bug; it cannot be executed against a contract that lacks the
  // setter. Do not "fix" it by re-adding the knob.
  it.skip("S1 (RETIRED): saturated pair froze MatA when the expansion threshold was low", async function () {
    const ctx = await deployPair(127);          // minimum allowed => saturated immediately
    const before = await saturate(ctx);

    await turnMatBOnly(ctx, 10);

    const rotA = await ctx.matA.rotationCount();
    const rotB = await ctx.matB.rotationCount();

    // MatB kept turning...
    expect(rotB, "MatB did not turn — the drive did nothing, test is invalid")
      .to.be.gt(before.rotB);
    // ...while MatA did not. This is the live symptom.
    expect(rotA, "MatA rotated — starvation not reproduced")
      .to.equal(before.rotA);
  });

  // S2 — DELIBERATELY PENDING. Read this before writing a fourth version.
  //
  // The routing fix (V8.46-A: _sameTierTarget always returns own MatA) has NO
  // direct unit coverage, and three attempts failed for the same underlying
  // reason. Documenting it here so the next person does not repeat them:
  //
  //   attempt 1 — rotate MatB and assert MatA rotationCount climbs.
  //               Failed: every root was underfunded and parked, so routing was
  //               never reached. Measured escrow 5.000 + withdrawable 2.436 vs a
  //               10.0 fee — the reserve covers exactly 50% and earnings must
  //               cover the rest.
  //   attempt 2 — walk W1 (universal referrer, ~$22 of L1 income) to the MatB
  //               root. Skipped: with the fix working W1 re-enters MatA, so it
  //               is not in MatB when looked for. The test was written around
  //               the old behaviour.
  //   attempt 3 — pair MemberReentered with MemberRouted in the same tx and read
  //               the destination. Failed: zero re-entries fired at all.
  //
  // ROOT REASON: earnings accrue PER MATRIX. Referral income is credited in the
  // MatA where the registration happened; the cycle-out that needs funding
  // happens in MatB, and handleCycleOut is passed MatB's own reserve and
  // withdrawable. A member's MatB balance comes only from pool accrual inside
  // MatB (18% split across its seats). With SIZE=4 and ~12 rotations that is
  // negligible. Live T1.1 MatB has 127 seats and 2,700+ rotations, which is why
  // roughly 1,600 funded re-entries have occurred there.
  //
  // TO CLOSE THIS PROPERLY: run the fixture at SIZE=127 and drive enough MatB
  // rotations for pool accrual to exceed 50% of the fee. Slow (minutes) but it
  // is the only faithful reproduction. A cheaper alternative would be a public
  // view exposing _sameTierTarget, but TierRouter has ~80 bytes of headroom
  // against the EIP-170 limit, so that is not currently affordable.
  //
  // MEANWHILE the fix rests on: (a) the code — _sameTierTarget now returns
  // (false, pairIndex) unconditionally, which is unambiguous; and (b) live
  // evidence — forcing the same behaviour via pairExpansionThreshold=1,000,000
  // at 8:25 PM EDT 2026-07-26 restarted MatA rotation on every saturated pair
  // within seconds, and it has held for 19+ hours with integrity clean.
  it("S2: ROUTING — funded re-entry seats in own MatA (needs SIZE=127 harness)");

  it("S3: a cascade must not steal the entrant's seat (no parking storm)", async function () {
    const ctx = await deployPair(1_000_000);
    await saturate(ctx);

    // A fresh member enters a full MatA. That cycles MatA's root out, which
    // crosses into a full MatB, which cycles ITS root out, which re-enters —
    // now targeting MatA, competing for the very slot just freed.
    const newcomer = await newMember(ctx);
    await reg(ctx, newcomer, ctx.W1.address);

    const seatedA  = await ctx.matA.isActiveInMatrix(newcomer.address);
    const seatedB  = await ctx.matB.isActiveInMatrix(newcomer.address);
    const parkedA  = await ctx.matA.parkedAt(newcomer.address);
    const parkedB  = await ctx.matB.parkedAt(newcomer.address);

    expect(
      seatedA || seatedB,
      `newcomer lost the seat race to the cascade — parkedA=${parkedA} parkedB=${parkedB}. ` +
      `This is the parking storm: raising the threshold live would park entrants ` +
      `system-wide instead of seating them.`
    ).to.equal(true);
  });
});
