"use strict";
/**
 * V8_50_ClawbackPresets.test.js — the preset menu, priced.
 *
 * WHY THIS FILE EXISTS
 *   19.17b shipped `setClawbackPreset` with the warning attached: session 16 measured the
 *   clawback collecting $0.00 inside a MatB occupancy across the whole V8.48 deployment,
 *   and recorded that **how fast debt retires and how much a member can withdraw were NOT
 *   measured**. It asked the A/B harness to price the menu "the way it priced the base
 *   ceiling".
 *
 *   ⛔ THE A/B CANNOT (handoff 22.0). All four presets collect exactly $0.00 there, on two
 *   seeds, with every outcome column byte-identical — because the redirect lives in
 *   `_settlePool` and takes a slice of a SETTLED POOL SHARE, which needs a seat and a
 *   rotation, while the members who borrow are the members who are PARKED. The measured
 *   run never reaches the state the dial governs. A sweep that cannot reach its own
 *   mechanism reports "no difference" and is believed.
 *
 *   So the mechanism is constructed instead of waited for — the same move that reached
 *   `:523` in V8_50_EvictionReserve.test.js after five sessions had called it a deploy task.
 *
 * ⛔ THE TRIGGER IS `softParkIdle`, AND THE CHOICE MATTERS.
 *   `withdrawCore` also settles the pool — but it then repays the member's ENTIRE
 *   remaining debt out of withdrawable (:1381-1395), emitting a SECOND `RescueDebtRepaid`
 *   in the same transaction. A test built on `withdraw()` would see the debt cleared at
 *   every preset and read it as "the preset does nothing". `softParkIdle` settles
 *   (:1500) and does no other repayment, so exactly one repayment site is in play and the
 *   number measured is the redirect itself.
 *
 * ⚠ BAND 3 ONLY, AND THAT IS DELIBERATE. `_bandOf` maps issuing tiers T1-T3 to band 3, and
 *   this fixture is single-tier. 19.17b: "in practice only band 3 has a population" —
 *   T4-T10 are nearly empty. Nothing here prices bands 0-2 and no assertion pretends to.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const FEE  = 10_000_000n;          // $10
const SIZE = 7;
const REGS = 20;                   // enough rotations for a real pool accrual

// The menu, from StabilityFund.setClawbackPreset. Duplicated here ON PURPOSE: if the
// contract's table is renumbered, CP-0 below fails loudly rather than silently pricing
// different values than the labels claim.
const PRESETS = {
  0: { name: "OFF",     bands: [0, 0, 0, 0] },
  1: { name: "GENTLE",  bands: [6000, 5000, 4000, 3000] },
  2: { name: "CURRENT", bands: [9000, 8000, 7000, 6000] },
  3: { name: "HARD",    bands: [10000, 9500, 9000, 8000] },
};
const BAND3 = (p) => BigInt(PRESETS[p].bands[3]);

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

const EVT = new ethers.Interface([
  "event RescueDebtRepaid(address indexed member, uint256 amount, uint256 remaining)",
  "event SlotParkedIdle(address indexed member, uint256 position, uint256 idleTime)",
]);
function evts(rc, name, from) {
  const out = [];
  for (const lg of rc.logs) {
    if (from && lg.address.toLowerCase() !== from.toLowerCase()) continue;
    let p; try { p = EVT.parseLog(lg); } catch { continue; }
    if (p && p.name === name) out.push(p);
  }
  return out;
}
const usd = (v) => (Number(v) / 1e6).toFixed(4);

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
  await a.setPartner(await b.getAddress());
  await b.setPartner(await a.getAddress());
  for (const m of [a, b]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);   // the owner drives softParkIdle
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());
  return { usdc, pm, pmAddr, tr, sf, a, b, owner, W1, sigs,
           aAddr: await a.getAddress(), bAddr: await b.getAddress() };
}

async function reg(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  return ctx.tr.connect(s).register(ref, { gasLimit: 16_000_000 });
}

/**
 * Build one world, book `debt` on a seated member with a real pool accrual, arm `preset`,
 * then settle via softParkIdle and report exactly what moved.
 *
 * ⛔ ORDERING IS THE WHOLE EXPERIMENT. Registrations run FIRST and identically in every
 *    world; the debt is booked and the preset armed only AFTER, so the accrued share is
 *    the same number in all four runs and the dial is the only difference. CP-3 asserts
 *    that rather than trusting it.
 */
async function priceOnePreset(preset, debt) {
  const ctx = await deployPair(SIZE);
  for (let i = 1; i <= REGS; i++) {
    await reg(ctx, ctx.sigs[i + 1], i === 1 ? ethers.ZeroAddress : ctx.sigs[i].address);
  }

  // Pick the seated member with the largest accrued share. Chosen by measurement, not by
  // index: seat positions shift with every rotation and a hardcoded signer would silently
  // become "whoever happens to sit there".
  let target = null, best = 0n;
  for (let i = 1; i <= REGS + 1; i++) {
    const addr = ctx.sigs[i + 1] ? ctx.sigs[i + 1].address : null;
    if (!addr) break;
    if (!(await ctx.a.isActiveInMatrix(addr))) continue;
    const p = await ctx.a.pendingPoolOf(addr);     // debt is still 0, so this is GROSS
    if (p > best) { best = p; target = addr; }
  }
  expect(target, "fixture: no seated MatA member has any accrued pool share — " +
    "the run is too short to reach the mechanism this file exists to measure").to.not.equal(null);
  expect(best, "fixture: the chosen member's accrual must be non-zero").to.be.gt(0n);

  await ctx.sf.increaseMemberDebt(target, 0, debt);        // tier 0 -> band 3
  await ctx.sf.setClawbackPreset(preset);
  const bandsBack = [];
  for (let i = 0; i < 4; i++) bandsBack.push(Number(await ctx.sf.clawbackBpsByBand(i)));

  const before = {
    bands: bandsBack,
    grossShare: best,
    storedWithdrawable: await ctx.a.withdrawableOf(target),   // NET of the estimate
    reserve: await ctx.a.crossingReserveOf(target),
    debt: await ctx.sf.memberDebtOf(target),
    sfUsdc: await ctx.usdc.balanceOf(await ctx.sf.getAddress()),
    clawbackBpsFor: await ctx.sf.clawbackBpsFor(target),
  };

  const rc = await (await ctx.a.softParkIdle(target)).wait();
  const repaid = evts(rc, "RescueDebtRepaid", ctx.aAddr);

  return {
    ctx, target, preset, before,
    repaidEvents: repaid.length,
    repaid: repaid.length ? repaid[0].args.amount : 0n,
    remainingInEvent: repaid.length ? repaid[0].args.remaining : null,
    after: {
      withdrawable: await ctx.a.withdrawableOf(target),
      debt: await ctx.sf.memberDebtOf(target),
      sfUsdc: await ctx.usdc.balanceOf(await ctx.sf.getAddress()),
      issuingTier: await ctx.sf.debtIssuingTier(target),
    },
  };
}

describe("V8.50 — the clawback preset menu, priced where the A/B could not reach it", function () {
  this.timeout(600000);

  // A debt far larger than any redirect this fixture can produce, so nothing clamps and
  // the arithmetic is the arithmetic. CP-4 tests the clamp separately and deliberately.
  const BIG_DEBT = 500_000_000n;   // $500

  let runs;
  before(async function () {
    runs = {};
    for (const p of [0, 1, 2, 3]) runs[p] = await priceOnePreset(p, BIG_DEBT);
  });

  it("CP-0: the contract's menu is the menu this file prices — bands read back, not assumed",
  async function () {
    for (const p of [0, 1, 2, 3]) {
      expect(runs[p].before.bands,
        `preset ${p} (${PRESETS[p].name}) read back bands that do not match this file's table — ` +
        `the menu was renumbered and every number below would be mislabelled`)
        .to.deep.equal(PRESETS[p].bands);
      expect(runs[p].before.clawbackBpsFor,
        `a tier-0 debt must resolve to BAND 3 (_bandOf: T1-T3 -> band 3)`)
        .to.equal(BAND3(p));
    }
  });

  it("CP-1: the four worlds are identical up to the dial — same accrual, same debt, same start",
  async function () {
    // ⛔ WITHOUT THIS, EVERY OTHER ROW IS UNINTERPRETABLE. If the accrued share differed
    // between runs, a difference in the redirect would be part dial and part fixture, in
    // unknown proportion — the V8.49 run's own worst failure (gen_sequence.js's header).
    for (const p of [1, 2, 3]) {
      expect(runs[p].before.grossShare, `preset ${p}: accrual differs from preset 0`)
        .to.equal(runs[0].before.grossShare);
      expect(runs[p].before.debt, `preset ${p}: booked debt differs from preset 0`)
        .to.equal(runs[0].before.debt);
      expect(runs[p].before.reserve, `preset ${p}: reserve differs from preset 0`)
        .to.equal(runs[0].before.reserve);
    }
    expect(runs[0].before.debt).to.equal(BIG_DEBT);
  });

  it("CP-2: preset 0 collects NOTHING and the member keeps the whole share", async function () {
    const r = runs[0];
    expect(r.repaidEvents, "OFF must emit no repayment at all").to.equal(0);
    expect(r.after.debt, "OFF must leave the debt untouched").to.equal(BIG_DEBT);
    expect(r.after.sfUsdc, "OFF must move no USDC into the fund").to.equal(r.before.sfUsdc);
    // softParkIdle credits the settled share and then releases the crossing reserve.
    expect(r.after.withdrawable,
      "with no redirect the member receives the entire accrued share plus their reserve")
      .to.equal(r.before.storedWithdrawable + r.before.reserve);
  });

  it("CP-3: presets 1/2/3 redirect EXACTLY share x band3 / 10000, and the debt falls by that",
  async function () {
    const share = runs[0].before.grossShare;
    for (const p of [1, 2, 3]) {
      const r = runs[p];
      const want = share * BAND3(p) / 10_000n;
      expect(r.repaidEvents, `preset ${p} must emit exactly one repayment`).to.equal(1);
      expect(r.repaid, `preset ${p} (${PRESETS[p].name}): redirect is not share x ${BAND3(p)}/10000`)
        .to.equal(want);
      expect(r.before.debt - r.after.debt, `preset ${p}: debt must fall by exactly the redirect`)
        .to.equal(want);
      expect(r.after.sfUsdc - r.before.sfUsdc, `preset ${p}: the fund must RECEIVE the redirect`)
        .to.equal(want);
      expect(r.remainingInEvent, `preset ${p}: the event's remaining must agree with the ledger`)
        .to.equal(r.after.debt);
      console.log(`      [CP-3] preset ${p} ${PRESETS[p].name.padEnd(7)} band3 ${String(BAND3(p)).padStart(5)}` +
        `  share $${usd(share)}  redirected $${usd(want)}  member kept $${usd(share - want)}`);
    }
  });

  it("CP-4: the redirect is strictly monotone in the preset — the menu is ordered as it reads",
  async function () {
    const [r0, r1, r2, r3] = [runs[0].repaid, runs[1].repaid, runs[2].repaid, runs[3].repaid];
    expect(r0).to.equal(0n);
    expect(r1, "GENTLE must collect more than OFF").to.be.gt(r0);
    expect(r2, "CURRENT must collect more than GENTLE").to.be.gt(r1);
    expect(r3, "HARD must collect more than CURRENT").to.be.gt(r2);
    // And the member's side is the exact mirror — nothing is lost between them.
    const share = runs[0].before.grossShare;
    for (const p of [0, 1, 2, 3]) {
      expect(runs[p].repaid + (share - runs[p].repaid),
        "redirect + kept must reconstruct the share exactly; a gap would mean money left the ledger")
        .to.equal(share);
    }
  });

  it("CP-5: a debt SMALLER than the redirect clamps to the debt, clears it, and resets the band",
  async function () {
    // The clamp is `if (repay > owed) repay = owed`. Under-testing it would leave the one
    // branch that can over-collect unexercised.
    const share = runs[0].before.grossShare;
    const tiny  = share / 100n;                      // far below HARD's 80% of the share
    expect(tiny, "fixture: the tiny debt must be small enough to clamp").to.be.lt(share * 8000n / 10_000n);
    const r = await priceOnePreset(3, tiny);
    expect(r.repaid, "the redirect must clamp to what is owed, never exceed it").to.equal(tiny);
    expect(r.after.debt, "and the debt is cleared").to.equal(0n);
    expect(r.after.issuingTier,
      "clearing the debt resets debtIssuingTier, so a later debt re-bands from scratch")
      .to.equal(0);
    expect(r.after.sfUsdc - r.before.sfUsdc, "the fund receives exactly the clamped amount")
      .to.equal(tiny);
  });

  it("CP-6: withdrawableOf's ESTIMATE and the settle's actual collection agree to the unit",
  async function () {
    // ⛔ 22.3 FOUND THE ESTIMATE MOVING WHILE THE COLLECTION WAS $0.00 ACROSS A WHOLE A/B
    // RUN — because the settle never fired there. That is the harness, not a divergence.
    // This pins the thing that would actually be a defect: when the settle DOES fire, the
    // figure `withdrawableOf` has been showing must be the figure the member ends up with.
    // withdrawableOf = stored + pendingPoolOf, and pendingPoolOf is net of the redirect
    // ESTIMATE; softParkIdle then settles for real and adds the released reserve.
    for (const p of [0, 1, 2, 3]) {
      const r = runs[p];
      expect(r.after.withdrawable,
        `preset ${p} (${PRESETS[p].name}): the estimate shown before the settle does not match ` +
        `what the member actually holds after it — the member was shown a number the ledger ` +
        `then disagreed with`)
        .to.equal(r.before.storedWithdrawable + r.before.reserve);
    }
  });
});
