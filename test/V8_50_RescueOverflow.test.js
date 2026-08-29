"use strict";
/**
 * V8_50_RescueOverflow.test.js — V8.50 ITEM S, the saturation escape hatch.
 * Written 2026-08-29, session 49. Audience: the next session of Claude, plus the owner.
 *
 * WHAT IS BEING FIXED, AND HOW WE KNOW
 * ─────────────────────────────────────────────────────────────────────────────
 * Measured on chain (noseat_witness.js, live deployment, T1, blocks
 * 46103781..46129371): 105 members parked with shortfall 0 and ALL 105 had another
 * member take a seat in the SAME transaction. Zero exceptions.
 *
 * Counted through (handoff 49.1e): a pair full in BOTH halves cannot absorb anybody.
 * An arriving member cycles MatA's root R_A out (one seat free), R_A crosses into the
 * full MatB which cycles R_B out (R_A takes that seat), and R_B re-enters its OWN MatA
 * under V8.48 item 10 and takes the seat R_A freed. 254 seated before, 254 after — two
 * members swapped halves and the arrival was parked. T1.1 parks exactly one member per
 * entry, which is why the queue only ever grows (188 parked and climbing).
 *
 * THE FIX: when — and ONLY when — both halves of the member's own pair are full,
 * rescueReentry may route them to a pair that has a genuinely free seat.
 *
 * ⛔ THE REGRESSION THIS MUST NOT CAUSE, WHICH IS WHY O2 EXISTS.
 * V8.48 item 10 exists because routing rescues away from the own MatA created a real
 * MatB closed loop — measured 2026-08-09: T2.1 MatA rot 581 vs MatB rot 5684 (9.8x),
 * and 466 of 714 parked members (65%) sitting in MatB. Item 10 cured it by sending
 * every rescue to the own MatA. **O2 is the guard that item 10 still holds wherever the
 * own pair has room.** If O2 ever goes red, this fix has reopened a defect that took a
 * live incident to find. Do not weaken it.
 *
 *   O1  both halves full + another pair has room -> member is SEATED there, and
 *       RescueOverflowed is emitted so the diversion is countable.
 *   O2  own pair has room -> member returns to their OWN MatA and NO overflow fires,
 *       even though a pair with room exists and is reachable. (Item 10 intact.)
 *   O3  both halves full and NO pair has room -> the member parks exactly as today and
 *       the transaction DOES NOT REVERT. rescueReentry is called from MatrixLogicLib
 *       with no try/catch, so a revert here would take a member's whole cycle-out with
 *       it (the T3.1/T4.1 repairs of 2026-07-28).
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
const SIZE = 4;

const EV = new ethers.Interface([
  "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)",
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event RescueOverflowed(address indexed member, uint256 indexed fromPair, uint256 indexed toPair)",
  "event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix)",
]);
const eq  = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const usd = v => "$" + (Number(v) / 1e6).toFixed(2);

async function deployBase() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: trLib.target } }))
    .deploy(await usdc.getAddress(), owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE, owner.address);
  const lib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await lib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await lib.getAddress() },
  });
  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  return { usdc, cnova, treasury, sf, tr, pm, MX, dp, owner, W1,
           pmAddr: await pm.getAddress(), label: {} };
}

/** Deploy one pair, wire it, and register it with the PairManager. */
async function addPair(ctx, tag) {
  const matA = await ctx.MX.deploy(ctx.dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await ctx.MX.deploy(ctx.dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setPairManager(ctx.pmAddr);
    await m.setTierRouter(await ctx.tr.getAddress());
    await m.setStabilityFund(await ctx.sf.getAddress());
    await m.setMatrixKeeper(ctx.owner.address);
    await ctx.treasury.setAuthorizedCaller(await m.getAddress(), true);
    await ctx.sf.setMatrixAuthorized(await m.getAddress(), true);
    await ctx.tr.registerMatrix(await m.getAddress(), 0);
  }
  await ctx.pm.addPair(await matA.getAddress(), await matB.getAddress());
  ctx.label[(await matA.getAddress()).toLowerCase()] = `${tag}.MatA`;
  ctx.label[(await matB.getAddress()).toLowerCase()] = `${tag}.MatB`;
  return { matA, matB };
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

function trace(ctx, rc) {
  const out = [];
  for (const l of rc.logs) {
    let p = null;
    try { p = EV.parseLog({ topics: [...l.topics], data: l.data }); } catch { /* not ours */ }
    if (!p) continue;
    out.push({ ev: p.name, from: ctx.label[l.address.toLowerCase()] || "PairManager", args: p.args });
  }
  return out;
}
function printTrace(t, title) {
  console.log(`      ── ${title} ──`);
  for (const e of t) {
    let extra = "";
    if (e.ev === "MemberParked")      extra = ` shortfall ${usd(e.args[1])}`;
    if (e.ev === "MemberEntered")     extra = ` pos ${e.args[1]}`;
    if (e.ev === "RescueOverflowed")  extra = ` pair ${e.args[1]} -> pair ${e.args[2]}`;
    console.log(`         ${String(e.from).padEnd(12)} ${e.ev.padEnd(24)} ${String(e.args[0]).slice(0, 10)}${extra}`);
  }
}

/** Saturate pair 1 and leave at least one member parked in its MatB. */
async function saturate(ctx, p1) {
  for (let i = 0; i < SIZE * 12 + 24; i++) {
    await register(ctx, await newWallet(ctx), ctx.W1.address);
    if (await p1.matA.isFull() && await p1.matB.isFull() && (await p1.matB.getParkedCount()) > 0n) break;
  }
}
async function rescue(ctx, matB, victim) {
  const signer = await ethers.getImpersonatedSigner(victim);
  await ethers.provider.send("hardhat_setBalance", [victim, "0x" + (10n ** 20n).toString(16)]);
  await ctx.usdc.mint(victim, FEE * 4n);
  await ctx.usdc.connect(signer).approve(await matB.getAddress(), FEE * 4n);
  const rc = await (await matB.connect(signer).selfRescue({ gasLimit: 16_700_000 })).wait();
  return { rc, t: trace(ctx, rc) };
}
async function state(ctx, p1, p2, tag) {
  const f = async m => `${await m.occupancy()}/${SIZE}`;
  let line = `      [${tag}] P1 MatA ${await f(p1.matA)} MatB ${await f(p1.matB)} parkedB ${await p1.matB.getParkedCount()}`;
  if (p2) line += `  |  P2 MatA ${await f(p2.matA)} MatB ${await f(p2.matB)}`;
  console.log(line);
}

describe("V8.50 item S — a rescue must not be parked in a pair that is full in both halves", function () {
  this.timeout(1_800_000);

  it("O1: both halves full and pair 2 has room — the rescued member is SEATED in pair 2, not parked", async function () {
    const ctx = await deployBase();
    const p1  = await addPair(ctx, "P1");
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await saturate(ctx, p1);
    // Pair 2 is added AFTER pair 1 saturates — the live sequence (T1.2 was spawned once
    // T1.1 filled) and also necessary: addPair sets activePairIndex, so adding it first
    // would send every registration to pair 2 and pair 1 would never fill.
    const p2 = await addPair(ctx, "P2");
    await state(ctx, p1, p2, "setup ");

    expect(await p1.matA.isFull(), "premise failed: pair 1 MatA never saturated").to.equal(true);
    expect(await p1.matB.isFull(), "premise failed: pair 1 MatB never saturated").to.equal(true);
    expect(await p2.matA.isFull(), "premise failed: pair 2 must have room").to.equal(false);
    const parked = await p1.matB.getParkedCount();
    expect(parked, "premise failed: nobody parked in pair 1 MatB to rescue").to.be.gt(0n);

    const victim = await p1.matB.getParkedMember(0);
    const { t }  = await rescue(ctx, p1.matB, victim);
    printTrace(t, "rescue receipt");
    await state(ctx, p1, p2, "after ");

    const overflowed = t.find(e => e.ev === "RescueOverflowed" && eq(e.args[0], victim));
    const destPark   = t.find(e => e.ev === "MemberParked" && e.from === "P1.MatA" && eq(e.args[0], victim));
    const inP2       = await p2.matA.isActiveInMatrix(victim);
    const inP1       = await p1.matA.isActiveInMatrix(victim);

    expect(destPark,
      "the member is STILL parked in their own MatA — item S did not fire. Either _bothHalvesFull " +
      "read false, or _pairWithRoomFor found nothing. This is the unfixed behaviour."
    ).to.equal(undefined);
    expect(overflowed, "no RescueOverflowed event — the diversion is invisible to the keepers even if it happened").to.not.equal(undefined);
    expect(inP2, "the member was not seated in pair 2").to.equal(true);
    expect(inP1, "the member is somehow ALSO seated in pair 1 — a duplicate seat, which is worse than the bug").to.equal(false);
    console.log(`      [result] seated in P2.MatA: ${inP2}   overflow ${overflowed.args[1]} -> ${overflowed.args[2]}`);
  });

  it("O2 (V8.48 ITEM 10 REGRESSION GUARD): own pair has room — the member returns to their OWN MatA and does NOT overflow", async function () {
    // ⛔ IF THIS GOES RED, ITEM 10 IS BROKEN AND THE 2026-08-09 MatB CLOSED LOOP IS BACK.
    // Pair 2 exists and has 4 free seats throughout, so the ONLY thing keeping the member
    // in their own pair is item 10 plus item S's both-halves-full precondition.
    const ctx = await deployBase();
    const p1  = await addPair(ctx, "P1");
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await saturate(ctx, p1);
    const p2 = await addPair(ctx, "P2");

    // Open exactly one seat in the own MatA, so the pair is no longer full in both halves.
    const occupant = await p1.matA.posToMember(2);
    expect(occupant, "premise failed: pair 1 MatA position 2 is empty").to.not.equal(ethers.ZeroAddress);
    await p1.matA.connect(ctx.owner).softParkIdle(occupant);
    await state(ctx, p1, p2, "1 free");
    expect(await p1.matA.isFull(), "premise failed: softParkIdle did not free a MatA seat").to.equal(false);

    const parked = await p1.matB.getParkedCount();
    expect(parked, "premise failed: nobody parked in pair 1 MatB to rescue").to.be.gt(0n);
    const victim = await p1.matB.getParkedMember(0);

    const { t } = await rescue(ctx, p1.matB, victim);
    printTrace(t, "rescue receipt");
    await state(ctx, p1, p2, "after ");

    const overflowed = t.find(e => e.ev === "RescueOverflowed" && eq(e.args[0], victim));
    expect(overflowed,
      "⛔ THE MEMBER WAS DIVERTED OUT OF THEIR OWN PAIR WHILE IT HAD ROOM. That is exactly what " +
      "V8.48 item 10 was written to stop, and it caused the measured MatB closed loop of 2026-08-09 " +
      "(T2.1 MatA rot 581 vs MatB rot 5684; 65% of parked members stuck in MatB). Item S's " +
      "precondition must be BOTH halves full — check _bothHalvesFull."
    ).to.equal(undefined);
    expect(await p1.matA.isActiveInMatrix(victim), "the member did not return to their own MatA").to.equal(true);
    expect(await p2.matA.isActiveInMatrix(victim), "the member landed in pair 2 despite their own pair having room").to.equal(false);
  });

  it("O3: both halves full and NO pair has room — the member parks as before and the transaction MUST NOT revert", async function () {
    // The safety property. rescueReentry is called from MatrixLogicLib with NO try/catch,
    // so a revert here takes the caller's whole cycle-out with it. Item S must be able to
    // find nothing and fall through quietly.
    const ctx = await deployBase();
    const p1  = await addPair(ctx, "P1");
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await saturate(ctx, p1);
    await state(ctx, p1, null, "setup ");

    expect(await p1.matA.isFull(), "premise failed: MatA never saturated").to.equal(true);
    expect(await p1.matB.isFull(), "premise failed: MatB never saturated").to.equal(true);
    const parked = await p1.matB.getParkedCount();
    expect(parked, "premise failed: nobody parked to rescue").to.be.gt(0n);
    const victim = await p1.matB.getParkedMember(0);

    let threw = null;
    let t = [];
    try { ({ t } = await rescue(ctx, p1.matB, victim)); }
    catch (e) { threw = e.shortMessage || e.message; }
    if (t.length) printTrace(t, "rescue receipt");

    expect(threw,
      "⛔ THE RESCUE REVERTED WITH NO PAIR TO OVERFLOW TO. rescueReentry has no try/catch " +
      "around it in MatrixLogicLib, so this would kill the triggering member's cycle-out — " +
      "the T3.1/T4.1 failure mode of 2026-07-28. Item S must fall through silently, not require."
    ).to.equal(null);

    const overflowed = t.find(e => e.ev === "RescueOverflowed");
    expect(overflowed, "RescueOverflowed fired with only one pair in existence — there was nowhere to go").to.equal(undefined);
    console.log(`      [result] no revert; member seated in own MatA: ${await p1.matA.isActiveInMatrix(victim)}`);
  });
});
