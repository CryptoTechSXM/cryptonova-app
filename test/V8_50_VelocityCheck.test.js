"use strict";
/**
 * V8_50_VelocityCheck.test.js — the velocity check has never survived a quiet hour.
 *
 * WHY THIS FILE EXISTS
 *   The V8.49b-vs-V8.50 A/B reported `WorkItemFailed` 68 times per run, ALL of work type 0
 *   (VELOCITY), identical on both arms, every seed. Identical across arms means it could
 *   not confound the comparison — but "it cancels out" is not "it is understood", and the
 *   session-6 handoff put it in writing: do not trust that harness further until this is
 *   explained.
 *
 * WHAT WAS MEASURED (test_ab/diag_velocity.js, 2026-08-18, BOTH arms, results identical)
 *   call 1: OK.  calls 2-5: REVERTED, "function selector was not recognized and there's
 *   no fallback function".  `lastVelocityCheck` frozen from call 2 onward.
 *   `deflationState` never left NORMAL on any call.
 *
 *   The selector is `activateLayer(uint8,bool)`. `MatrixKeeper._setStabilityLayers` called
 *   it on the StabilityFund; it is DECLARED in `IStabilityFundKeeper`
 *   (MatrixKeeperLib.sol:52) and IMPLEMENTED NOWHERE. `git log -S activateLayer --
 *   contracts/StabilityFund.sol` returns ZERO commits: the fund has never had it, in any
 *   version, since `a06aad4 V8.1 Elevator`. The fund's layer model is layers 1, 3 and 5
 *   (`receiveLayer` requires exactly those, StabilityFund.sol:504) — layers 2 and 4, the
 *   ones the keeper was toggling, do not exist in it at all.
 *
 * WHY IT WAS A DELETION AND NOT AN IMPLEMENTATION
 *   `deflationState` is read by NOTHING. Across the entire contracts tree it is written by
 *   MatrixKeeper's own state machine, mirrored into TierRouter (:1663) and emitted, and
 *   that is the complete list of consumers — no contract branches on it. Outside the
 *   contracts it is worse: zero hits for `deflationState`, `DeflationStateChanged`,
 *   `activateLayer` or `STATE_SLOW` across the frontend, keeper and mainnet repos.
 *   Implementing `activateLayer` would have meant inventing layer semantics the fund does
 *   not have, adding bytes to a contract whose size is a live V8.50 constraint, to serve a
 *   value nothing reads.
 *
 * THE CONSEQUENCE THAT ACTUALLY MATTERS — AND IT IS NOT THE FAILED EVENT
 *   The revert rolls back the WHOLE of `_doVelocityCheck`, and the per-tier
 *   `tierVelocityGreen` writes (MatrixKeeper.sol:1094-1095) happen BEFORE the deflation
 *   block that reverts. So they are discarded too.
 *
 *   That leaves a precise harm band, and G3 below is built on it. Per window:
 *     entries >= deflationThreshold (10)      -> green branch, no layer call, check passes
 *     entries <  velocityThreshold  (3)       -> tier is correctly red anyway
 *     entries in 3..9  <- THE BAND            -> the tier QUALIFIES for a green velocity
 *                                                gate, and cannot be given one, because
 *                                                the same transaction reverts on the
 *                                                deflation transition.
 *   `tierVelocityGreen` is what throttles auto-upgrades (TierRouter:1374), and it is read
 *   by index.html, status.html, gate_status.js, rr_keeper.js, system_keeper.js and the
 *   mainnet builds. A tier stuck red during a slow patch is a real member-facing effect,
 *   and it self-heals only when traffic climbs back over 10 entries/window.
 *
 * ⚠ THIS IS LIVE ON V8.48. The caller has existed since V8.1 and the implementation never
 *   has, so every deployment this project has ever made carries it. Fixed here for V8.50;
 *   the live chain keeps it until V8.50 deploys.
 *
 * Run: npx hardhat test test/V8_50_VelocityCheck.test.js
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE = 10_000_000n;
const SIZE = 7;

/**
 * Self-contained deploy. It deliberately does NOT import test_ab/world.js: that module is
 * the A/B experiment's, and the 606-test suite should not break because an experiment
 * harness moved. The wiring below is the same shape, kept minimal.
 */
async function deployWorld() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund")).deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", {
    libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target },
  })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8")).deploy(usdcAddr, FEE, owner.address);
  const [tresAddr, sfAddr, trAddr, pmAddr] = [
    await treasury.getAddress(), await sf.getAddress(),
    await tr.getAddress(), await pm.getAddress(),
  ];

  const keeper = await (await ethers.getContractFactory("MatrixKeeper", {
    libraries: { MatrixKeeperLib: (await (await ethers.getContractFactory("MatrixKeeperLib")).deploy()).target },
  })).deploy(trAddr, sfAddr);
  const keeperAddr = await keeper.getAddress();

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: (await (await ethers.getContractFactory("MatrixLogicLib")).deploy()).target },
  });
  const matA = await MX.deploy(dp, FEE, SIZE, true, 0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

  await matA.setPartner(matBAddr);
  await matB.setPartner(matAAddr);
  for (const m of [matA, matB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(trAddr);
    await m.setStabilityFund(sfAddr);
    await m.setMatrixKeeper(keeperAddr);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
  }
  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);
  await tr.setMatrixKeeper(keeperAddr);
  await sf.setMatrixKeeper(keeperAddr);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);
  await keeper.setPairManager(0, pmAddr);

  return { owner, W1, sigs, usdc, sf, tr, pm, keeper, matA, matB, pmAddr, sfAddr, trAddr };
}

async function register(w, sg, referrer) {
  await w.usdc.mint(sg.address, FEE);
  await w.usdc.connect(sg).approve(w.pmAddr, FEE);
  await (await w.tr.connect(sg).register(referrer, { gasLimit: 16_000_000 })).wait();
}

describe("V8.50 — velocity check survives a quiet window", function () {
  this.timeout(180000);

  let w, WINDOW;

  before(async () => {
    w = await deployWorld();
    WINDOW = Number(await w.keeper.velocityWindow());
  });

  /**
   * G1 — THE HEADLINE. Two consecutive windows with no entries is the ordinary state of any
   * chain overnight, and it is what the whole failure needs. Call 1 banks one red window;
   * call 2 is the NORMAL -> SLOW transition, which is the only place `_setStabilityLayers`
   * was ever reachable from. Before the fix this call reverts and every call after it does
   * too, forever.
   */
  it("G1: three consecutive quiet windows complete without reverting", async () => {
    for (let i = 1; i <= 3; i++) {
      await expect(w.keeper.manualVelocityCheck(), `velocity check ${i} of 3`).to.not.be.reverted;
      await time.increase(WINDOW + 60);
    }
  });

  /**
   * G2 — the state machine works AT ALL. `deflationStateEver: ["0"]` was the diagnostic's
   * verdict on both arms: NORMAL, always, because the only transition out of it reverted.
   * Asserting SLOW here is asserting that the machine ran, not that SLOW is desirable.
   */
  it("G2: the deflation state machine reaches SLOW after two quiet windows", async () => {
    expect(await w.keeper.deflationState()).to.equal(1); // STATE_SLOW
  });

  /**
   * G3 — THE MEMBER-FACING CONSEQUENCE, and the reason this is a bug and not a tidy-up.
   * 5 entries sits in the 3..9 band: at or above velocityThreshold (3) so the tier has
   * EARNED a green gate, and below deflationThreshold (10) so the same call still takes the
   * red-window branch. Pre-fix, the tier is denied its green gate by a revert that has
   * nothing to do with velocity.
   *
   * The flag is read back FROM TierRouter rather than inferred from the call succeeding —
   * a call that does not revert is not evidence that the write landed.
   */
  it("G3: a tier that earns a green gate gets one, even in a below-deflation window", async () => {
    expect(await w.tr.tierVelocityGreen(0)).to.equal(false, "precondition: quiet windows left the tier red");

    for (let i = 0; i < 5; i++) await register(w, w.sigs[10 + i], w.W1.address);

    const sysCount = await w.tr.getSystemEntryCount(await time.latest() - WINDOW);
    expect(sysCount).to.be.gte(3, "fixture must land in the 3..9 band");
    expect(sysCount).to.be.lt(await w.keeper.deflationThreshold(), "fixture must land in the 3..9 band");

    await expect(w.keeper.manualVelocityCheck()).to.not.be.reverted;
    expect(await w.tr.tierVelocityGreen(0)).to.equal(true);
  });

  /**
   * G4 — why the A/B saw 68 failures and not 2. `lastVelocityCheck` is written at the top of
   * `_doVelocityCheck`, so a revert discards it, and MatrixKeeperLib:233 re-queues the item
   * on every tick where `block.timestamp >= lastVelocityCheck + velocityWindow`. A frozen
   * clock turns one broken transition into a permanent per-tick failure. Rediscovery is the
   * mechanism behind the count; this asserts the clock moves.
   */
  it("G4: lastVelocityCheck advances on every check", async () => {
    const before = await w.keeper.lastVelocityCheck();
    await time.increase(WINDOW + 60);
    await w.keeper.manualVelocityCheck();
    expect(await w.keeper.lastVelocityCheck()).to.be.gt(before);
  });

  /**
   * G5 — a tripwire for the next session, not a behaviour test.
   *
   * The fix deleted the CALLER because the callee does not exist. If somebody later
   * implements `activateLayer` on the StabilityFund — a reasonable thing to want, since the
   * original intent was to lean on extra funding layers during a downturn — this test goes
   * RED, and its failure message is the note saying the keeper side was removed on purpose
   * and needs restoring deliberately rather than by accident. It fails when the world
   * changes, which is exactly when someone needs to read this file.
   */
  it("G5: the StabilityFund still has no activateLayer — see the note if this fails", async () => {
    const probe = new ethers.Contract(w.sfAddr,
      ["function activateLayer(uint8 layer, bool active) external"], w.owner);
    let reverted = false;
    try { await probe.activateLayer.staticCall(2, true); } catch { reverted = true; }
    expect(reverted, "StabilityFund now implements activateLayer(uint8,bool). MatrixKeeper's " +
      "_setStabilityLayers was DELETED in V8.50 because it did not exist and reverted every " +
      "velocity check that reached a deflation transition. If the fund now has layer 2/4 " +
      "semantics, re-introduce the keeper side deliberately — and keep it out of the path " +
      "that writes tierVelocityGreen.").to.equal(true);
  });
});
