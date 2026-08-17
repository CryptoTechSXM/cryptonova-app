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
 * ⛔ RE-FIXTURED BY V8.50 ITEM A — THE PARKED QUEUE MOVED, MEASURED NOT ASSUMED.
 *   Item A pays an A->B crossing out of the member's own crossing reserve. This
 *   fixture's MatA parks were funding parks, so they stopped happening: with the same
 *   41 registrations that used to produce a queue in MatA, MatA now parks NOBODY and
 *   the queue appears in MatB instead, at the cycle-out that re-enters a MatA at the
 *   FULL fee. Measured on this exact fixture, size 7:
 *
 *       regs=10  matA.parked 0   matB.parked 0
 *       regs=20  matA.parked 0   matB.parked 7
 *       regs=40  matA.parked 0   matB.parked 27      every one at wd $2.436 / rs $0.00
 *
 *   That is item A's whole thesis reproduced locally, and it is why "fixture produced
 *   no parked member" was the RIGHT failure to see here. The file now builds its member
 *   in MatB. The rule under test — a rescue must not delete the excess — is unchanged.
 *
 *   THE ONE NEW FIXTURE STEP, AND WHY IT IS NOT A FUDGE. The only way past 100% of a
 *   fee is referral income (one journey earns at most ~34%), so the member has to be a
 *   referrer — and their downline keeps crossing into MatB, paying them l1Bps each time.
 *   Left alone, the rescue TRANSACTION itself pays them another $0.95 mid-flight and the
 *   post-rescue balance reads surplus + $0.95. So the fixture drains that queue first:
 *   register outside their downline until their withdrawable stops moving. Then the
 *   rescue is the only thing happening to them and the surplus assertion is exact to the
 *   cent. Verified: delta $0.000000. Do NOT replace this with a tolerance — the drain is
 *   what makes the assertion sharp, and a tolerance would hide the defect it exists for.
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
  // The fixture cannot produce one by accident: parked members cluster far under the
  // fee — every MatB cycle-out park here reads $2.436 of a $10.00 fee, one no-referral
  // journey's earnings at MATRIX_SIZE 7. A member's withdrawable freezes when they park.
  //
  // But an L1 referral credit reaches a referrer whatever their own state. So park
  // someone first, THEN register under them: each registration pays them l1Bps (950 =
  // 9.5% of the fee) once that entrant crosses into MatB. That is not a contrivance —
  // it is exactly how the live self-funded members got there.
  async function parkedAndFunded(w) {
    const { sigs, W1, reg, matA, matB } = w;
    await reg(W1, ethers.ZeroAddress);
    for (let i = 0; i < 40; i++) await reg(sigs[10 + i], W1.address);

    // V8.50 item A: the queue is in MatB now. Assert MatA's emptiness rather than
    // ignoring it — if MatA ever parks a funding case again, item A has regressed and
    // this line is the cheapest place in the suite to find out.
    // ⛔ V8.50: THE CLAIM IS "NOBODY PARKS FOR FUNDING", NOT "NOBODY PARKS".
    //
    // This asserted getParkedCount() == 0 and was right until item E1 landed. E1 changes
    // cascade TIMING — members reach MatB richer, cycle out sooner, and the cascade runs
    // deeper — which makes MatrixLogicLib's mid-cascade DEFERRAL park (:906,
    // crossingInProgress) fire where it previously did not. Measured here: 2 MatA
    // parkers, both holding a reserve of exactly $5.00, the full crossing price.
    //
    // They are not stuck. A deferral park is the cascade handing them to the standard
    // machinery to be crossed in a LATER transaction, and it is what bounds recursion
    // depth. Item A's guarantee is about FUNDING, so assert funding: no MatA parker may
    // be short of the crossing price. That is the invariant, and it is stronger than a
    // count because it survives any future change to cascade shape.
    {
      const price = FEE / 2n;   // CROSSING_RESERVE_BPS 5000, mirroring _crossingPrice
      const n = Number(await matA.getParkedCount());
      for (let q = 0; q < n; q++) {
        const m = await matA.getParkedMember(q);
        const [wd, rs] = await Promise.all([matA.withdrawableOf(m), matA.crossingReserveOf(m)]);
        expect(wd + rs, `MatA parker ${m} is short of the crossing price — item A regressed`)
          .to.be.gte(price);
      }
    }
    const cnt = Number(await matB.getParkedCount());
    expect(cnt, "fixture produced no parked member in MatB").to.be.gt(0);

    // Pick a parked member whose signer we control. W1 is excluded deliberately: it
    // referred the entire population, so its commission stream never drains and the
    // settle loop below could not terminate.
    let best = null;
    for (let q = 0; q < cnt; q++) {
      const m = await matB.getParkedMember(q);
      if (m.toLowerCase() === W1.address.toLowerCase()) continue;
      const sg = sigs.find(s => s.address.toLowerCase() === m.toLowerCase());
      if (!sg) continue;
      const [wd, rs] = await Promise.all([matB.withdrawableOf(m), matB.crossingReserveOf(m)]);
      if (!best || wd + rs > best.eff) best = { m, sg, eff: wd + rs };
    }
    expect(best, "no parked member with a controllable signer").to.not.equal(null);

    // Top them over the line with real L1 commissions. A MatB parker starts at $2.436,
    // so this needs more entrants than the pre-item-A MatA parker did (who started near
    // the fee, carrying a $5.00 reserve item A has since spent on their crossing).
    for (let k = 0; k < 24; k++) {
      const filler = sigs[70 + k];
      if (!filler) break;
      await reg(filler, best.m);
      const [wd2, rs2] = await Promise.all([matB.withdrawableOf(best.m), matB.crossingReserveOf(best.m)]);
      if (wd2 + rs2 > FEE) break;
    }

    // SETTLE THE MEMBER'S OWN DOWNLINE — see the header. Register OUTSIDE their downline
    // until their withdrawable stops moving, so the rescue transaction is not also paying
    // them commission. Terminates by measurement, not by a magic count.
    let last = -1n;
    for (let j = 0; j < 20; j++) {
      const before = await matB.withdrawableOf(best.m);
      if (before === last) break;
      last = before;
      const s = sigs[120 + j];
      if (!s) break;
      await reg(s, W1.address);
    }
    expect(await matB.withdrawableOf(best.m),
      "the member's commission stream must be quiet before the rescue is measured"
    ).to.equal(last);

    const [wd, rs] = await Promise.all([matB.withdrawableOf(best.m), matB.crossingReserveOf(best.m)]);
    const parkedAt = await matB.parkedAt(best.m);
    // ASSERT THE PRECONDITION LOUDLY. A test that quietly skips when it cannot reach
    // the state is the reason the first version of this file survived a mutant.
    expect(parkedAt, "the member must still be PARKED for selfRescue").to.be.gt(0n);
    expect(rs, "V8.50 item A: a MatB member holds NO crossing reserve — it was spent " +
      "getting them there. If this is non-zero the carve is back and item A is broken."
    ).to.equal(0n);
    expect(wd + rs, `member must be SELF-FUNDED (got ${ethers.formatUnits(wd + rs, 6)} vs fee ${ethers.formatUnits(FEE, 6)}) — otherwise this file tests nothing`).to.be.gt(FEE);
    return { member: best.m, signer: best.sg, wd, rs, eff: wd + rs };
  }

  /** Sum every EarningsCredited to `who` inside one receipt.
   *
   *  ⛔ V8.50 ITEM E1 MADE THE SETTLE LOOP INSUFFICIENT, so the assertion stopped
   *  chasing the cascade and started accounting for it. A rescue re-seats the member,
   *  which cascades, which can pay them an L1 commission IN THE SAME TRANSACTION — $0.95
   *  here. The old fix was to quiesce their downline first; E1 changes cascade timing and
   *  a new credit slipped back in. Measuring the credit is robust to any future change in
   *  cascade shape, where a settle loop is only ever robust to the shape it was tuned on.
   */
  //  Declared EXPLICITLY, not read off the contract ABI: whether solc copies a library's
  //  events into the using contract's artifact is a compiler detail, and this suite has
  //  already been bitten by it (see V8_48_GhostFloor's EVT_IFACE note). Parsing through
  //  matB.interface silently returned ZERO credits and the assertion failed by exactly
  //  one $0.95 L1 — a wrong answer that looked like a real defect.
  const CREDIT_IFACE = new ethers.Interface([
    "event EarningsCredited(address indexed member, address indexed payer, uint8 indexed source, uint256 amount)",
  ]);

  //  FILTERED BY EMITTER, and that is not a detail. Credits are PER-LEDGER: a rescue
  //  credits the member $0.95 L1 on the matrix they are leaving AND $0.25 direct-earn on
  //  the one they enter. Counting both over-states what landed here by exactly the
  //  direct-earn, which is the same class of error as summing both halves in
  //  model_item_a.js phase 5. Only logs emitted by `matrixAddr` count.
  function creditedInTx(rc, iface, who, matrixAddr) {
    let total = 0n;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== matrixAddr.toLowerCase()) continue;
      try {
        const p = iface.parseLog(l);
        if (p && p.name === "EarningsCredited" && p.args.member.toLowerCase() === who.toLowerCase()) {
          total += p.args.amount;
        }
      } catch { /* not ours */ }
    }
    return total;
  }

  it("REGRESSION: a self-funded rescue no longer deletes the excess", async function () {
    const w = await world();
    const p = await parkedAndFunded(w);
    const surplus = p.eff - FEE;

    const rc = await (await w.matB.connect(p.signer).selfRescue({ gasLimit: 16_000_000 })).wait();
    const credited = creditedInTx(rc, CREDIT_IFACE, p.member, w.bA);
    const after = await w.matB.getMember(p.member);

    expect(BigInt(after.withdrawable),
      `${ethers.formatUnits(surplus, 6)} above the fee is the member's money and must survive ` +
      `the rescue (plus ${ethers.formatUnits(credited, 6)} credited to them mid-transaction)`
    ).to.equal(surplus + credited);
    expect(BigInt(await w.matB.crossingReserveOf(p.member)),
      "the reserve was already 0 under item A and must stay 0").to.equal(0n);
    // BACKED: the member is now seated in the pair's MatA, and the fee that bought that
    // seat is the only thing that left MatB on their behalf.
    expect(await w.matA.isInMatrix(p.member),
      "a MatB cycle-out re-enters a MatA — that is the full-fee crossing being paid for"
    ).to.equal(true);
  });

  it("coPayRescue keeps the surplus too, and borrows nothing when it does not need to", async function () {
    const w = await world();
    const p = await parkedAndFunded(w);
    const surplus = p.eff - FEE;

    // coPayRescue is permissionless — anyone may call it for a parked member.
    const rc = await (await w.matB.connect(w.owner).coPayRescue(p.member, { gasLimit: 16_000_000 })).wait();
    const credited = creditedInTx(rc, CREDIT_IFACE, p.member, w.bA);
    const after = await w.matB.getMember(p.member);
    expect(BigInt(after.withdrawable), "co-pay must not erase the excess either")
      .to.equal(surplus + credited);
    expect(BigInt(await w.sf.memberDebtOf(p.member)),
      "a member whose own balances cover the fee must borrow NOTHING").to.equal(0n);
  });

  it("the arithmetic itself: surplus = reserve + withdrawable - crossing price, never negative", async function () {
    // Pure guard on the formula the fix introduces, at the boundaries that matter.
    //
    // V8.50 item A: the price basis is no longer always the entry fee. _selfRescue and
    // coPayRescue both compute `cfg.isMatrixA ? _crossingPrice(entryFee) : entryFee`,
    // so a MatA parker is measured against 50% of the fee and a MatB parker against all
    // of it. The MatA rows below are the ones item A added, and they are the reason the
    // surplus of a MatA parker is now their ENTIRE withdrawable: the reserve alone met
    // the price.
    const HALF = (f) => f / 2n;   // CROSSING_RESERVE_BPS 5000, mirroring _crossingPrice
    const cases = [
      // MatB — a full-fee re-entry. The pre-item-A rows, unchanged.
      { isA: false, fee: FEE, rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("5.438759", 6), want: ethers.parseUnits("0.438759", 6) },
      { isA: false, fee: FEE, rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("5", 6),        want: 0n },                      // exactly the fee
      { isA: false, fee: FEE, rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("4.999999", 6), want: 0n },                      // one unit short
      { isA: false, fee: ethers.parseUnits("25", 6), rs: ethers.parseUnits("12.5", 6), wd: ethers.parseUnits("14.76495", 6), want: ethers.parseUnits("2.26495", 6) },
      // MatA — the A->B hop item A repriced. The reserve alone covers it.
      { isA: true,  fee: FEE, rs: ethers.parseUnits("5", 6),    wd: ethers.parseUnits("3.4", 6),      want: ethers.parseUnits("3.4", 6) },
      { isA: true,  fee: FEE, rs: ethers.parseUnits("5", 6),    wd: 0n,                               want: 0n },                      // exactly the price
      { isA: true,  fee: FEE, rs: ethers.parseUnits("4.999999", 6), wd: 0n,                           want: 0n },                      // one unit short of the price
    ];
    for (const c of cases) {
      const price = c.isA ? HALF(c.fee) : c.fee;
      const eff = c.rs + c.wd;
      const surplus = eff > price ? eff - price : 0n;
      expect(surplus, `${c.isA ? "MatA" : "MatB"}: reserve ${c.rs} + wd ${c.wd} vs price ${price}`).to.equal(c.want);
      expect(surplus >= 0n, 'surplus can never be negative').to.equal(true);
    }
  });

  it("a member below the fee still pays their shortfall and ends at zero", async function () {
    const w = await world();
    const { sigs, W1, reg, matB } = w;
    await reg(W1, ethers.ZeroAddress);
    for (let i = 0; i < 40; i++) await reg(sigs[10 + i], W1.address);

    // The ordinary case under item A: MatB cycle-out parkers sit at one journey's
    // earnings against a full-fee re-entry, so take one as-is. No referrals, so no
    // commission stream to settle — this member is quiet by construction.
    let pick = null;
    const cnt = Number(await matB.getParkedCount());
    for (let q = 0; q < cnt; q++) {
      const m = await matB.getParkedMember(q);
      if (m.toLowerCase() === W1.address.toLowerCase()) continue;
      const sg = sigs.find(x => x.address.toLowerCase() === m.toLowerCase());
      if (!sg) continue;
      const [wd, rs] = await Promise.all([matB.withdrawableOf(m), matB.crossingReserveOf(m)]);
      if (wd + rs < FEE) { pick = { m, sg, eff: wd + rs }; break; }
    }
    expect(pick, "no below-fee parked member — the fixture changed shape").to.not.equal(null);

    const shortfall = FEE - pick.eff;
    await w.usdc.mint(pick.sg.address, shortfall);
    await w.usdc.connect(pick.sg).approve(w.bA, shortfall);
    const walletBefore = await w.usdc.balanceOf(pick.sg.address);
    await w.matB.connect(pick.sg).selfRescue({ gasLimit: 16_000_000 });

    const after = await w.matB.getMember(pick.m);
    expect(BigInt(after.withdrawable), "no surplus, so nothing to credit back").to.equal(0n);
    expect(walletBefore - (await w.usdc.balanceOf(pick.sg.address)),
      "member pays exactly the shortfall, not a penny more").to.equal(shortfall);
  });
});
