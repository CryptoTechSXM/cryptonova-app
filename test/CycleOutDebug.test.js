"use strict";
/**
 * CycleOutDebug.test.js
 * MATRIX_SIZE=4 local test of the FULL PRODUCTION KEEPER RESCUE, end to end:
 * a member parks underfunded, the Stability Fund refuses on the insolvency floor,
 * the floor is raised, SF funds the crossing and forceCrossKeeper completes it.
 *
 * ⛔ REBUILT FOR V8.50 ITEM A — AND KEPT RATHER THAN RETIRED, DELIBERATELY.
 *
 *   THE OLD PREMISE IS GONE. This used to park W1 at the MatA->MatB crossing: W1 earned
 *   ~$2.53 against a $5 crossing need and could not fund it. Item A pays that crossing
 *   from the member's own $5 reserve, so it ALWAYS succeeds now and W1 never parks there.
 *   Measured on this fixture: MatA parks nobody.
 *
 *   RETIRING THIS FILE WAS CONSIDERED AND REJECTED, and the reason is worth writing down
 *   because the name invites it. Despite "Debug", this is the ONLY test in the suite that
 *   walks a SUCCESSFUL Stability-Fund rescue end to end. Only two files call both
 *   payForceCross and forceCrossKeeper — this one and stress_test_full — and
 *   stress_test_full only exercises the REVERT paths (wrong caller, already-in-MatB, debt
 *   guards). V8_44_Keeper covers force-rotation and epochs, not member rescues.
 *   V8_44_CycleOut and V8_48_RescueSurplus cover selfRescue and coPayRescue — the member
 *   paying for THEMSELVES. Nothing else proves the fund can rescue anybody.
 *
 *   V8_50_HANDOFF.md's own open-items list already says "no end-to-end test that a real
 *   rescue books shortfall and nothing more". Deleting this in the same release that
 *   REPRICES rescues would have thinned a known-thin area at exactly the wrong moment.
 *
 *   SO IT MOVED INSTEAD OF DYING. The keeper rescue did not disappear under item A, it
 *   relocated: members now park at the MatB CYCLE-OUT, where re-entry costs a full fee,
 *   and that is where the live keeper will find them. The flow below is the one that
 *   ships.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

/** V8.32 10-field SplitConfig — splits sum to 4750 BPS.
 *  50% crossing reserve + 2.5% direct earn are pre-allocated in _distributePayments
 *  BEFORE the BPS array runs (5000 + 250 + 4750 = 10000 total).
 *  Values scaled from V8.19 proportions (×0.475), rounded to sum exactly 4750. */
const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};  // sum = 4750
const CP_BPS  = [380, 238, 119, 95, 71, 47];  // sum = 950 = chainBps
const FEE     = 10_000_000n;  // $10 USDC (6 decimals)
const SF_SEED = 50_000_000n;  // $50 pre-seeded so keeper can fund the rescue

async function deploy(size = 4) {
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

  // DeployParams struct: usdc, cnova, treasury, devOpsWallet, accountOne, admin
  const dp = {
    usdc:         usdcAddr,
    cnova:        cnovaAddr,
    treasury:     tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne:   W1.address,
    admin:        owner.address,
  };

  // V8.21: core logic now lives in MatrixLogicLib -- deploy + link first.
  const MatrixLib  = await ethers.getContractFactory("MatrixLogicLib");
  const matrixLib  = await MatrixLib.deploy();
  await matrixLib.waitForDeployment();
  const MX   = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });
  const matA = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

  // Wire: partner
  await matA.setPartner(matBAddr);
  await matB.setPartner(matAAddr);

  // Wire: pairManager, tierRouter, stabilityFund on each matrix
  for (const m of [matA, matB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(trAddr);
    await m.setStabilityFund(sfAddr);
  }

  // Set owner as matrixKeeper on matA AND sf (allows keeper rescue calls in tests)
  await matA.setMatrixKeeper(owner.address);
  // V8.50 item A: the rescue happens on the MatB side now, so MatB needs the keeper too.
  await matB.setMatrixKeeper(owner.address);
  await sf.setMatrixKeeper(owner.address);

  // PairManager: add pair + set tierRouter
  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);

  // TierRouter
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);

  // Authorize in treasury + SF
  await treasury.setAuthorizedCaller(matAAddr, true);
  await treasury.setAuthorizedCaller(matBAddr, true);
  await sf.setMatrixAuthorized(matAAddr, true);
  await sf.setMatrixAuthorized(matBAddr, true);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);

  // Pre-seed SF: MSIZE=4 gives W1 ~$2.53 in earnings, not enough for the $5 cross_needed.
  // SF covers the gap. In production, keeper checks SF.balanceByTier[tier] >= fee before rescue.
  await usdc.mint(owner.address, SF_SEED);
  await usdc.connect(owner).approve(sfAddr, SF_SEED);
  await sf.connect(owner).receiveLayer(0, SF_SEED, 1);

  return { usdc, cnova, treasury, sf, tr, pm, matA, matB, owner, W1, devOps, sigs };
}

describe("CycleOutDebug", function () {
  this.timeout(300_000);

  it("MatB cycle-out: W1 parks underfunded, the floor refuses, the keeper+SF rescue completes it", async function () {
    const { usdc, treasury, sf, matA, matB, tr, pm, owner, W1, sigs } = await deploy(4);
    const pmAddr   = await pm.getAddress();
    const matAAddr = await matA.getAddress();
    const matBAddr = await matB.getAddress();

    expect(await treasury.authorizedCallers(matAAddr), "MatA not authed in treasury").to.be.true;
    expect(await treasury.authorizedCallers(matBAddr), "MatB not authed in treasury").to.be.true;

    const reg = async (signer, referrer) => {
      await usdc.mint(signer.address, FEE);
      await usdc.connect(signer).approve(pmAddr, FEE);
      return tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
    };

    // ── Phase 1: W1 into MatA, then let item A carry them across ──────────────
    await reg(W1, ethers.ZeroAddress);
    expect(await matA.matrixPos(W1.address)).to.equal(1n);
    console.log("  W1 at position 1: OK");

    // Drive registrations until W1 has cycled out of MatB and PARKED there. Item A
    // crosses them into MatB for free on the way; the park happens one cycle later, at
    // the re-entry that still costs a full fee. Bounded and asserted rather than counted,
    // because the exact number of entries depends on cascade shape.
    let parked = false;
    for (let i = 0; i < 24 && !parked; i++) {
      await reg(sigs[10 + i], W1.address);
      parked = (await matB.parkedAt(W1.address)) > 0n;
    }

    // ── Phase 2: the parked state, asserted loudly ────────────────────────────
    console.log("  MatA parked count: " + (await matA.getParkedCount()).toString() + " (expect 0 — item A)");
    expect(await matA.getParkedCount(),
      "V8.50 item A: a MatA parker's reserve covers their crossing, so MatA must park " +
      "nobody. A non-zero count here means item A regressed.").to.equal(0n);

    expect(await matB.parkedAt(W1.address),
      "fixture must reach a MatB cycle-out park — if it does not, this test proves nothing"
    ).to.be.gt(0n);
    expect(await matB.isActiveInMatrix(W1.address)).to.equal(false);
    expect(await matA.isActiveInMatrix(W1.address),
      "not a ghost — nobody is holding a seat for them").to.equal(false);

    const w1Wd = await matB.withdrawableOf(W1.address);
    const w1Rs = await matB.crossingReserveOf(W1.address);
    console.log("  W1 parked in matB:          true");
    console.log("  W1 withdrawable (earnings): $" + (Number(w1Wd) / 1e6).toFixed(6));
    console.log("  W1 crossing reserve:        $" + (Number(w1Rs) / 1e6).toFixed(6) + " (expect $0 — item A spent it)");
    expect(w1Rs, "item A: a MatB member holds no reserve").to.equal(0n);
    expect(w1Wd, "the re-entry must be genuinely underfunded, or the rescue is a no-op").to.be.lt(FEE);

    // ── Phase 3: the insolvency floor refuses first ───────────────────────────
    // Production flow: MatrixKeeper.performUpkeep() → _doParkedRescue():
    //   1. sf.payForceCross(member, tierIdx, sourceMatrix, fee) — SF sends funds to the matrix
    //   2. matrix.forceCrossKeeper(member, sfContribution, buffer) — the matrix crosses them
    // Here both steps are driven directly, with owner acting as keeper.
    //
    // This fixture models "the SF covers 100% of the fee" — an advance of the WHOLE $10
    // against the declared 5000bps ceiling ($5.00). So the default floor refuses,
    // correctly, and that refusal is asserted FIRST because a fixture that merely
    // sidestepped it would hide the rule.
    //
    // The ceiling is read from the SF rather than written here on purpose: PARAM 59 went
    // 3400 -> 5000 -> 3400 inside one day in V8.50 (the first 5000 case was measured
    // against a balance the enforcing code cannot see), and then 3400 -> 5000 for good on
    // 2026-08-19 on the AB_FLOOR_BPS curve — see StabilityFund.sol. A hard-coded number
    // here would have survived all three moves while quietly meaning something else. Note
    // the phase-3 assertion holds at ANY ceiling: a full $10 advance is above all of them.
    const floorBps = await sf.insolvencyFloorBps();
    console.log("  insolvencyFloorBps: " + floorBps.toString() + " → ceiling $" +
                (Number(FEE * floorBps / 10_000n) / 1e6).toFixed(2) + " vs a $10.00 advance");
    expect(await sf.loanEligibleFor(W1.address, 0, FEE),
      "policy B: a full-fee advance is far above the declared ceiling, whatever it is set to").to.equal(false);
    await expect(sf.connect(owner).payForceCross(W1.address, 0, matBAddr, FEE))
      .to.be.revertedWith("SF: insolvency floor");

    // ── Phase 4: raise the ceiling, then rescue for real ──────────────────────
    // 10_000 bps is on the DAO menu (PARAM 59) — the fixture declaring its own
    // assumption out loud rather than inheriting a default that happens to permit it.
    await sf.connect(owner).setInsolvencyFloorBps(10_000);
    await sf.connect(owner).payForceCross(W1.address, 0, matBAddr, FEE);
    // sfContribution = FEE: the SF covers 100%. forceCrossKeeper requires
    // sfContribution <= crossingCost, and a MatB crossing costs the FULL fee under item A
    // — which is exactly why the rescue path still exists here and not in MatA.
    await matB.connect(owner).forceCrossKeeper(W1.address, FEE, 0n);

    // ── Phase 5: the member is back in play ───────────────────────────────────
    expect(await matB.parkedAt(W1.address), "parked queue entry must clear").to.equal(0n);
    // NOT "the queue is empty", and not "the count dropped by one" either — both were
    // tried and both are wrong. The rescue seats W1 back in MatA, which cascades, which
    // cycles ANOTHER member out of MatB into their own re-entry park: one out, one in,
    // net zero. That churn is item A's thesis showing up as a side effect, not a fault.
    // Scan for W1's ABSENCE instead — it says exactly what the rescue promised and
    // nothing about the fixture's shape.
    const queued = [];
    for (let q = 0; q < Number(await matB.getParkedCount()); q++) {
      queued.push((await matB.getParkedMember(q)).toLowerCase());
    }
    expect(queued, "the rescued member must be OFF the parked queue").to.not.include(W1.address.toLowerCase());
    expect(await matA.isActiveInMatrix(W1.address),
      "a MatB cycle-out re-enters a MatA — that is the crossing the fund just paid for"
    ).to.equal(true);
    // ...and the full-fee entry carved them a fresh reserve for the NEXT crossing.
    expect(await matA.crossingReserveOf(W1.address),
      "entry carves, crossing spends — the rescued member is funded for their next hop"
    ).to.equal(FEE / 2n);
    console.log("  SUCCESS: W1 rescued by keeper+SF and re-entered MatA with a fresh reserve");
  });
});
