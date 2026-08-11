"use strict";
/**
 * V8_48_RescueSurplus.test.js — V8.48 item 11: a rescue must not erase the surplus.
 *
 * THE DEFECT
 *   selfRescue and coPayRescue both did:
 *
 *       effectiveContrib = crossingReserve + withdrawable
 *       shortfall        = entryFee > effectiveContrib ? entryFee - effectiveContrib : 0
 *       crossingReserve  = 0
 *       withdrawable     = 0        <-- unconditionally
 *
 *   while _finalizeCrossing forwards ONLY entryFee. So when a member's own balances
 *   exceeded the fee, the excess was DELETED: not spent, not locked, just gone, with
 *   the USDC still sitting in the matrix and the member's claim on it zeroed.
 *
 * WHO IT HIT
 *   Exactly the self-funded rescue — reserve + withdrawable >= fee. Live, from
 *   fastlane.log on 2026-08-11: $5.00 + $5.438759 against a $10.00 fee, and
 *   $12.50 + $14.76495 against $25.00. $0.44 and $2.26 erased, roughly one an hour.
 *
 *   V8.48 item 12 makes those rescues fire in 5 minutes instead of 24 hours, so
 *   shipping 12 without 11 would have increased the rate of the loss.
 *
 * THE ASSERTION
 *   Not "the code sets a variable" — the member's claimable balance AFTER the rescue
 *   must equal what they had over the fee, and the matrix must still hold the USDC
 *   backing it. Both are checked.
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
const FEE = ethers.parseUnits("10", 6);

describe("V8.48 item 11 — a rescue keeps the member's surplus", function () {
  this.timeout(600_000);

  async function world(size = 7) {
    const sigs = await ethers.getSigners();
    const [owner, W1, devOps] = sigs;
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    const [ua, ca] = [await usdc.getAddress(), await cnova.getAddress()];
    const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(ca, ua, owner.address);
    const sf = await (await ethers.getContractFactory("StabilityFund")).deploy(ua, owner.address);
    const tr = await (await ethers.getContractFactory("TierRouter", {
      libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target },
    })).deploy(ua, owner.address);
    const pm = await (await ethers.getContractFactory("PairManagerV8")).deploy(ua, FEE, owner.address);
    const [ta, sa, ra, pa] = [await treasury.getAddress(), await sf.getAddress(), await tr.getAddress(), await pm.getAddress()];

    const dp = {
      usdc: ua, cnova: ca, treasury: ta, devWallet: devOps.address,
      opsWallet: devOps.address, accountOne: W1.address, admin: owner.address,
    };
    const mlib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
    const MX = await ethers.getContractFactory("FigureEightMatrixV8", { libraries: { MatrixLogicLib: await mlib.getAddress() } });
    const matA = await MX.deploy(dp, FEE, size, true, 0, SPLITS, CP_BPS);
    const matB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
    const [aA, bA] = [await matA.getAddress(), await matB.getAddress()];
    await matA.setPartner(bA); await matB.setPartner(aA);
    for (const m of [matA, matB]) {
      await m.setPairManager(pa); await m.setTierRouter(ra); await m.setStabilityFund(sa);
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
    }
    await pm.addPair(aA, bA); await pm.setTierRouter(ra);
    await tr.registerTier(0, pa, FEE); await tr.setTierMatrices(0, aA, bA);
    await tr.registerMatrix(aA, 0); await tr.registerMatrix(bA, 0);
    await sf.setTierFee(0, FEE); await sf.setTierRouter(ra);

    const reg = async (s, r) => {
      await usdc.mint(s.address, FEE);
      await usdc.connect(s).approve(pa, FEE);
      await tr.connect(s).register(r, { gasLimit: 16_000_000 });
    };
    return { usdc, tr, pm, sf, matA, matB, owner, W1, sigs, pa, aA, bA, reg };
  }

  // BUILD A SELF-FUNDED PARKED MEMBER DETERMINISTICALLY.
  //
  // The fixture cannot produce one by accident: parked members cluster JUST under the
  // fee — best observed here is $9.875 of a $10.00 fee, and the live chain shows the
  // same 91-98% band. A member's withdrawable freezes when they park.
  //
  // But an L1 referral credit reaches a referrer whatever their own state. So park
  // someone first, THEN register under them: each registration pays them l1Bps (950 =
  // 9.5% of the fee), and two or three pushes them over. That is not a contrivance —
  // it is exactly how the live self-funded members got there.
  async function parkedAndFunded(w) {
    const { sigs, W1, reg, matA } = w;
    await reg(W1, ethers.ZeroAddress);
    for (let i = 0; i < 40; i++) await reg(sigs[10 + i], W1.address);

    const cnt = Number(await matA.getParkedCount());
    expect(cnt, "fixture produced no parked member").to.be.gt(0);

    // Pick the parked member closest to the fee whose signer we control.
    let best = null;
    for (let q = 0; q < cnt; q++) {
      const m = await matA.getParkedMember(q);
      const sg = sigs.find(s => s.address.toLowerCase() === m.toLowerCase());
      if (!sg) continue;
      const [wd, rs] = await Promise.all([matA.withdrawableOf(m), matA.crossingReserveOf(m)]);
      if (!best || wd + rs > best.eff) best = { m, sg, eff: wd + rs };
    }
    expect(best, "no parked member with a controllable signer").to.not.equal(null);

    // Top them over the line with real L1 commissions.
    for (let k = 0; k < 6; k++) {
      const filler = sigs[70 + k];
      if (!filler) break;
      await reg(filler, best.m);
      const [wd2, rs2] = await Promise.all([matA.withdrawableOf(best.m), matA.crossingReserveOf(best.m)]);
      if (wd2 + rs2 > FEE) break;
    }

    const [wd, rs] = await Promise.all([matA.withdrawableOf(best.m), matA.crossingReserveOf(best.m)]);
    const parkedAt = await matA.parkedAt(best.m);
    // ASSERT THE PRECONDITION LOUDLY. A test that quietly skips when it cannot reach
    // the state is the reason the first version of this file survived a mutant.
    expect(parkedAt, "the member must still be PARKED for selfRescue").to.be.gt(0n);
    expect(wd + rs, `member must be SELF-FUNDED (got ${ethers.formatUnits(wd + rs, 6)} vs fee ${ethers.formatUnits(FEE, 6)}) — otherwise this file tests nothing`).to.be.gt(FEE);
    return { member: best.m, signer: best.sg, wd, rs, eff: wd + rs };
  }

  it("REGRESSION: a self-funded rescue no longer deletes the excess", async function () {
    const w = await world();
    const p = await parkedAndFunded(w);
    const surplus = p.eff - FEE;

    const matBalBefore = await w.usdc.balanceOf(w.aA);
    await w.matA.connect(p.signer).selfRescue({ gasLimit: 16_000_000 });
    const after = await w.matA.getMember(p.member);

    expect(BigInt(after.withdrawable),
      `${ethers.formatUnits(surplus, 6)} above the fee is the member's money and must survive the rescue`
    ).to.equal(surplus);
    expect(BigInt(await w.matA.crossingReserveOf(p.member)),
      "the reserve itself is consumed by the crossing").to.equal(0n);
    // BACKED: only entryFee may leave the matrix.
    expect(matBalBefore - (await w.usdc.balanceOf(w.aA)),
      "only the entry fee may leave the matrix").to.equal(FEE);
  });

  it("coPayRescue keeps the surplus too, and borrows nothing when it does not need to", async function () {
    const w = await world();
    const p = await parkedAndFunded(w);
    const surplus = p.eff - FEE;

    // coPayRescue is permissionless — anyone may call it for a parked member.
    await w.matA.connect(w.owner).coPayRescue(p.member, { gasLimit: 16_000_000 });
    const after = await w.matA.getMember(p.member);
    expect(BigInt(after.withdrawable), "co-pay must not erase the excess either").to.equal(surplus);
    expect(BigInt(await w.sf.memberDebtOf(p.member)),
      "a member whose own balances cover the fee must borrow NOTHING").to.equal(0n);
  });

  it("the arithmetic itself: surplus = reserve + withdrawable - fee, never negative", async function () {
    // Pure guard on the formula the fix introduces, at the three boundaries that matter.
    const cases = [
      { rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("5.438759", 6), want: ethers.parseUnits("0.438759", 6) },
      { rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("5", 6),        want: 0n },                      // exactly the fee
      { rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("4.999999", 6), want: 0n },                      // one unit short
      { rs: ethers.parseUnits("12.5", 6), wd: ethers.parseUnits("14.76495", 6), want: ethers.parseUnits("17.26495", 6) },
    ];
    for (const c of cases) {
      const eff = c.rs + c.wd;
      const surplus = eff > FEE ? eff - FEE : 0n;
      expect(surplus, `reserve ${c.rs} + wd ${c.wd}`).to.equal(c.want);
      expect(surplus >= 0n, 'surplus can never be negative').to.equal(true);
    }
  });

  it("a member below the fee still pays their shortfall and ends at zero", async function () {
    const w = await world();
    const { sigs, W1, reg, matA } = w;
    await reg(W1, ethers.ZeroAddress);
    for (let i = 0; i < 40; i++) await reg(sigs[10 + i], W1.address);

    // The ordinary case: parked members cluster JUST under the fee, so take one as-is.
    let pick = null;
    const cnt = Number(await matA.getParkedCount());
    for (let q = 0; q < cnt; q++) {
      const m = await matA.getParkedMember(q);
      const sg = sigs.find(x => x.address.toLowerCase() === m.toLowerCase());
      if (!sg) continue;
      const [wd, rs] = await Promise.all([matA.withdrawableOf(m), matA.crossingReserveOf(m)]);
      if (wd + rs < FEE) { pick = { m, sg, eff: wd + rs }; break; }
    }
    expect(pick, "no below-fee parked member — the fixture changed shape").to.not.equal(null);

    const shortfall = FEE - pick.eff;
    await w.usdc.mint(pick.sg.address, shortfall);
    await w.usdc.connect(pick.sg).approve(w.aA, shortfall);
    const walletBefore = await w.usdc.balanceOf(pick.sg.address);
    await w.matA.connect(pick.sg).selfRescue({ gasLimit: 16_000_000 });

    const after = await w.matA.getMember(pick.m);
    expect(BigInt(after.withdrawable), "no surplus, so nothing to credit back").to.equal(0n);
    expect(walletBefore - (await w.usdc.balanceOf(pick.sg.address)),
      "member pays exactly the shortfall, not a penny more").to.equal(shortfall);
  });
});
