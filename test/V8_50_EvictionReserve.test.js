"use strict";
/**
 * V8_50_EvictionReserve.test.js — the release path, exercised deliberately.
 *
 * WHY THIS FILE EXISTS
 *   `EvictionReserveReleased` had never executed. Not in production (18.15: 0
 *   evictions in 1,803 live episodes) and not in the suite: all 34 evicted members
 *   ever measured came out of a MatB, where item A has already spent the crossing
 *   reserve, so there was nothing to release. V8_48_GhostFloor's GF-V3 says so in
 *   its own comment and pins the behaviour that ships instead.
 *
 *   It also closes the second of the V8.50 private-deploy gate's four risks:
 *   "defect 9's code path has NO test coverage — no fixture builds a cascade that
 *   refills every seat." That cascade IS this fixture. One construction, two items.
 *
 * ⛔ THE DOOR IS `MatrixLogicLib:523`, AND IT IS THE ONLY ONE.
 *   Walking every park site against evictParked's own ghost test — seated in this
 *   matrix OR in the partner half (:1850-1853):
 *
 *     :947  funding shortfall     ITEM A DELETED IT
 *     :876  duplicate seat        A GHOST by construction -> dequeued, nothing released
 *     :1461 softParkIdle          releases the reserve itself at :1447-1450
 *     MatB, any cause             nothing to hold — item A spent it
 *     :906  mid-cascade deferral  A GHOST — it parks only inside
 *                                 `if (dest != 0 && dest.isActiveInMatrix(root))`,
 *                                 which is precisely the ghost test. NOT a door.
 *     :523  cascade-refill entry  parked in MatA, seated in neither half, holding
 *                                 the 50% carve -> THE ONLY DOOR
 *
 *   The `:906` row is the correction: two earlier walks recorded it as reachable and
 *   the handoff carried that for several sessions. A test written against `:906`
 *   constructs a ghost, watches it dequeue, and PASSES while proving nothing — which
 *   is why ER-2 below pins the ghost branch's refusal to release, rather than leaving
 *   the distinction in a comment.
 *
 * HOW :523 IS REACHED — read off a run (probe, size 7), not reasoned about:
 *   Entry lands in a FULL MatA -> _cycleOutRoot compacts the array, frees exactly
 *   slot `matrixSize` and sets nextSlot there -> the root crosses into a FULL MatB
 *   -> MatB cycles ITS root out -> handleCycleOut re-enters that member into the
 *   pair's MatA, taking the one free slot -> control returns to the outer frame,
 *   _lowestFreeSlot returns 0, and the ENTRANT is parked at :527-529. Ordinary
 *   registrations produce it at #20 with matrixSize 7; nothing is impersonated and
 *   no partner is swung to reach it.
 *
 *   The entrant then falls through to `_distributePayments` at :539 with
 *   skipReserveCarve = false (this is a registration, not a crossing), so the 50%
 *   carve is credited AFTER the park. That ordering is the whole reason a reserve
 *   exists to release, and it is asserted, not assumed.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const FEE     = 10_000_000n;          // $10
const RESERVE = FEE / 2n;             // CROSSING_RESERVE_BPS = 5000
const INSTANT = FEE * 250n / 10_000n; // DIRECT_EARN_BPS = 250 -> $0.25
const SIZE    = 7;                    // smallest size that reproduces the cascade

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

// Parse with EXPLICIT fragments. Whether solc copies a library's events into the
// using contract's artifact ABI is a compiler detail — GhostFloor's first run found
// GhostDequeued absent while MemberEvicted was present. Pin the topic0s here so no
// assertion in this file can depend on it.
const EVT = new ethers.Interface([
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event CycleOutFailed(address indexed member, uint8 tierIndex)",
  "event GhostDequeued(address indexed member, uint256 staleParkedAt)",
  "event EvictionReserveReleased(address indexed member, uint256 amount)",
  "event MemberEvicted(address indexed member, uint256 totalWithdrawn)",
]);

/** Every log in `rc` that parses as `name` AND was emitted by `from` (when given). */
function evts(rc, name, from) {
  const out = [];
  for (const lg of rc.logs) {
    if (from && lg.address.toLowerCase() !== from.toLowerCase()) continue;
    let p; try { p = EVT.parseLog(lg); } catch { continue; }
    if (p && p.name === name) out.push(p);
  }
  return out;
}

async function deployPair(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund")).deploy(usdcAddr, owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter",
      { libraries: { TierRouterLib: trLib.target } })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8")).deploy(usdcAddr, FEE, owner.address);
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
  // A complete, isolated second pair, registered with nothing. ER-2 swings MatA's
  // partner to `decoy` to build a ghost that still holds a reserve — the one state
  // GF-V1 cannot produce, because softParkIdle spends the reserve on its way in.
  // It is a real PAIR rather than a lone matrix because `enterFor` runs
  // `_requirePartner` (:199) before it will seat anybody.
  const decoy  = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const decoyB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);

  await a.setPartner(await b.getAddress());
  await b.setPartner(await a.getAddress());
  await decoy.setPartner(await decoyB.getAddress());
  await decoyB.setPartner(await decoy.getAddress());
  for (const m of [a, b, decoy, decoyB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
  }
  for (const m of [a, b]) await tr.registerMatrix(await m.getAddress(), 0);
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());

  return { usdc, pm, pmAddr, tr, sf, a, b, decoy, owner, W1, sigs,
           aAddr: await a.getAddress(), bAddr: await b.getAddress(),
           decoyAddr: await decoy.getAddress() };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  return ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

/**
 * Register ordinary members until one is parked by the :523 cascade-refill branch,
 * and return that member with the receipt that parked them.
 *
 * ⛔ THE IDENTIFICATION IS THE DELICATE PART. FOUR sites emit `MemberParked(m, 0)`
 *    with a zero shortfall, and only one of them is :523 (line numbers re-read from
 *    the current MatrixLogicLib, not carried from a handoff — the carried ones had
 *    drifted):
 *      :527-529  cascade-refill entry     — parks THE ENTRANT, no companion event
 *      :879-881  handleCycleOut catch     — parks THE ROOT, + CycleOutFailed
 *      :906-908  containment pre-check    — parks THE ROOT, + CycleOutFailed
 *      :936-938  crossingInProgress defer — parks the crossing member, NO companion
 *    So a zero shortfall alone is not the signature. This requires the parked member
 *    to BE the transaction's entrant and the receipt to carry no CycleOutFailed —
 *    which separates :523 from both root parks by construction rather than by luck,
 *    and from :936 because that one parks a root mid-crossing, never the entrant.
 *
 * ⚠ :936 IS UNCLASSIFIED, AND THIS FILE DOES NOT SETTLE IT. A probe classifying every
 *    zero-shortfall park saw it fire ZERO times in 45 registrations at size 7 while
 *    catching two :523 parks in the same run. It has no ghost test in it and the
 *    member's reserve is unspent, so on its face it is a second door. Do not write
 *    "exactly one door" until somebody either reaches it or rules it out — see
 *    V8_50_HANDOFF.md 20.3a and 20.8 item 4.
 */
async function driveToCascadeRefillPark(ctx, maxRegs = 40) {
  for (let i = 1; i <= maxRegs; i++) {
    const entrant = ctx.sigs[i + 1];
    if (!entrant) break;
    const rc = await (await reg(ctx, entrant, i === 1 ? ethers.ZeroAddress : ctx.sigs[i].address)).wait();

    const parks = evts(rc, "MemberParked", ctx.aAddr)
      .filter((p) => p.args.member.toLowerCase() === entrant.address.toLowerCase());
    if (parks.length === 0) continue;

    expect(parks[0].args.shortfall,
      ":523 parks with a zero shortfall — a non-zero one is a funding park, wrong site")
      .to.equal(0n);
    expect(evts(rc, "CycleOutFailed").length,
      "CycleOutFailed present: this is a ROOT park (:888/:922), not the :523 entrant park")
      .to.equal(0);

    return { member: entrant.address, rc, atReg: i };
  }
  throw new Error(
    `:523 never reached in ${maxRegs} registrations at matrixSize ${SIZE}. ` +
    `The fixture, not the contract, is what changed — re-run the probe before editing assertions.`
  );
}

describe("V8.50 — EvictionReserveReleased, the last untested path in the eviction route", function () {
  this.timeout(600000);

  it("ER-1: the :523 cascade-refill parker is EVICTED and their crossing reserve is RELEASED, not confiscated",
  async function () {
    const ctx = await deployPair(SIZE);
    const { member, atReg } = await driveToCascadeRefillPark(ctx);

    // ── Preconditions, asserted loudly (item-11 lesson) ──────────────────────
    // Everything evictParked's EVICTION branch requires, and the ghost test it
    // must fail. If any of these drifts, the test must die here rather than
    // quietly exercise the ghost branch and report success.
    expect(await ctx.a.occupancy(),
      "precondition: the cascade must have refilled EVERY seat — that is what :523 means")
      .to.equal(BigInt(SIZE));
    expect(await ctx.a.parkedAt(member),
      "precondition: parked in MatA").to.be.gt(0n);
    expect(await ctx.a.isActiveInMatrix(member),
      "precondition: NOT seated in MatA — otherwise this is a ghost").to.equal(false);
    expect(await ctx.b.isActiveInMatrix(member),
      "precondition: NOT seated in MatB — otherwise this is a ghost").to.equal(false);
    expect(await ctx.a.crossingReserveOf(member),
      "precondition: _distributePayments ran AFTER the park (:539) and carved the 50%")
      .to.equal(RESERVE);

    const wdBefore   = await ctx.a.withdrawableOf(member);
    const pkBefore   = await ctx.a.getParkedCount();
    const usdcBefore = await ctx.usdc.balanceOf(ctx.aAddr);
    const sfBefore   = await ctx.usdc.balanceOf(await ctx.sf.getAddress());
    expect(wdBefore, "the instant 2.5% earn is all a never-seated entrant holds").to.equal(INSTANT);

    // ── The act ─────────────────────────────────────────────────────────────
    const rc = await (await ctx.a.evictParked(member)).wait();

    const released = evts(rc, "EvictionReserveReleased", ctx.aAddr);
    expect(released.length,
      "THE POINT OF THIS FILE: the release path must actually execute").to.equal(1);
    expect(released[0].args.member).to.equal(member);
    expect(released[0].args.amount, "the whole reserve, to the unit").to.equal(RESERVE);

    expect(evts(rc, "MemberEvicted", ctx.aAddr).length,
      "an eviction must be reported as one").to.equal(1);
    expect(evts(rc, "GhostDequeued", ctx.aAddr).length,
      "a ghost dequeue here would mean the fixture built the wrong state").to.equal(0);

    // ── Removal, not confiscation (18.15, now on the path that has a reserve) ─
    expect(await ctx.a.crossingReserveOf(member), "reserve cleared").to.equal(0n);
    expect(await ctx.a.withdrawableOf(member),
      "the reserve moved INTO withdrawable — no exitSeat penalty on an involuntary exit")
      .to.equal(wdBefore + RESERVE);
    expect(await ctx.a.parkedAt(member), "dequeued").to.equal(0n);
    expect(await ctx.a.getParkedCount()).to.equal(pkBefore - 1n);

    // A ledger move, not a transfer: no USDC leaves the matrix and the SF is not
    // paid a penalty. 18.15 measured "34 of 34 kept their withdrawable in full"
    // but could never check the reserve half, because none of the 34 had one.
    expect(await ctx.usdc.balanceOf(ctx.aAddr),
      "eviction moves a ledger entry; it must not move money").to.equal(usdcBefore);
    expect(await ctx.usdc.balanceOf(await ctx.sf.getAddress()),
      "no penalty is routed to the SF on an INVOLUNTARY exit").to.equal(sfBefore);

    console.log(`      [ER-1] :523 reached at registration #${atReg}, size ${SIZE}; ` +
                `released $${(Number(RESERVE) / 1e6).toFixed(2)}`);
  });

  it("ER-2: the same member, given a partner seat, takes the GHOST branch and NOTHING is released",
  async function () {
    // ⛔ THIS IS THE 19.18b GUARD, AS A TEST RATHER THAN A COMMENT.
    //
    // `:906` parks a member *because* they are already seated in the partner, which
    // is exactly the condition evictParked tests first. A session that builds its
    // fixture against `:906` gets GhostDequeued, no balance moves, the test goes
    // green, and the release path is still untested. The difference between that
    // failure and ER-1 is ONE partner seat, so it is pinned with one partner seat.
    //
    // Not covered by GF-V1: that victim reaches the queue via softParkIdle, which
    // releases the reserve on its way in (:1447-1450), so its "reserve unchanged"
    // assertion compares 0 against 0. Here the reserve is a real $5.00.
    const ctx = await deployPair(SIZE);
    const { member } = await driveToCascadeRefillPark(ctx);
    expect(await ctx.a.crossingReserveOf(member)).to.equal(RESERVE);

    // Seat the parked member in a matrix, then make that matrix MatA's partner.
    // Same partner-swing shape as V8_46_PairGuard's G2 and GhostFloor's
    // seatBothHalves; the decoy is empty, so nothing cascades.
    await ctx.usdc.mint(ctx.owner.address, FEE);
    await ctx.usdc.connect(ctx.owner).transfer(ctx.decoyAddr, FEE);
    const asPm = await impersonate(ctx.pmAddr);
    await ctx.decoy.connect(asPm).enterFor(member, ctx.W1.address, { gasLimit: 16_000_000 });
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.pmAddr]);
    await ctx.a.setPartner(ctx.decoyAddr);

    expect(await ctx.decoy.isActiveInMatrix(member),
      "ghost setup failed: not seated in the partner").to.equal(true);
    expect(await ctx.a.parkedAt(member),
      "ghost setup failed: no longer parked in MatA").to.be.gt(0n);

    const wdBefore = await ctx.a.withdrawableOf(member);
    const rc = await (await ctx.a.evictParked(member)).wait();

    expect(evts(rc, "GhostDequeued", ctx.aAddr).length,
      "a member holding a partner seat is a ghost — dequeue only").to.equal(1);
    expect(evts(rc, "EvictionReserveReleased", ctx.aAddr).length,
      "⛔ THE TRAP: a ghost must NOT release. If this ever fires, a :906-style " +
      "fixture would be indistinguishable from ER-1 and prove nothing.").to.equal(0);
    expect(evts(rc, "MemberEvicted", ctx.aAddr).length,
      "a ghost is not evicted").to.equal(0);

    expect(await ctx.a.crossingReserveOf(member), "reserve untouched").to.equal(RESERVE);
    expect(await ctx.a.withdrawableOf(member), "withdrawable untouched").to.equal(wdBefore);
    expect(await ctx.a.parkedAt(member), "but the stale record IS cleared").to.equal(0n);

    await ctx.a.setPartner(ctx.bAddr);
  });

  it("ER-3: eviction touches the reserve and nothing else — history, debt and the seat map are unchanged",
  async function () {
    // 18.15 established removal-not-confiscation across 34 members, but every one
    // came from MatB holding no reserve, so "what else does eviction move?" was
    // only ever answered on the cheap half of the state. This answers it on the
    // path where the release actually fires.
    const ctx = await deployPair(SIZE);
    const { member } = await driveToCascadeRefillPark(ctx);

    const before = {
      earned:    await ctx.a.totalEarnedOf(member),
      withdrawn: await ctx.a.getMemberTotalWithdrawn(member),
      cycles:    await ctx.a.getCyclesCompleted(member),
      debt:      await ctx.sf.memberDebtOf(member),
      occupancy: await ctx.a.occupancy(),
      rotations: await ctx.a.rotationCount(),
      pos:       await ctx.a.matrixPos(member),
    };

    await (await ctx.a.evictParked(member)).wait();

    expect(await ctx.a.totalEarnedOf(member),
      "earnings history is not rewritten by an eviction").to.equal(before.earned);
    expect(await ctx.a.getMemberTotalWithdrawn(member),
      "withdrawal history is not rewritten").to.equal(before.withdrawn);
    expect(await ctx.a.getCyclesCompleted(member),
      "an eviction is not a cycle").to.equal(before.cycles);
    expect(await ctx.sf.memberDebtOf(member),
      "an evicted member still owes the fund — eviction is not debt forgiveness (18.15)")
      .to.equal(before.debt);
    expect(await ctx.a.occupancy(),
      "the parked member held no seat, so the seat map cannot move").to.equal(before.occupancy);
    expect(await ctx.a.rotationCount(), "and nothing rotated").to.equal(before.rotations);
    expect(await ctx.a.matrixPos(member), "still seated nowhere").to.equal(before.pos);
  });
});
