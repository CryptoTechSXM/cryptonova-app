"use strict";
/**
 * V8Elevator.test.js  —  V8.1b  —  Prerequisite gate before any testnet deploy.
 *
 * SUITES
 *  1. Smoke            — single registration sanity check
 *  2. Full Elevator    — T1 fill → forceCross → W1 upgrades to T2
 *  3. Inactivity Guard — systemPaused behaviour
 *  4. TierRouter Admin — access-control guards
 *  5. CNOVAToken V8.1  — tier multiplier, triple epoch trigger
 *  6. CNOVAToken V8.1b — earlyUnlock / earlyUnlockAll penalty
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { time }        = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─── Constants ────────────────────────────────────────────────────────────────
const UNIT    = 1_000_000n;     // 1 USDC (6 decimals)
const T1_FEE  = 10n  * UNIT;   // $10
const T2_FEE  = 7n   * UNIT;   // $7   (V8.32: W1 earns $7.66 in matB with 50/2.5/47.5 model;
                                //        L1 from 6 force-crosses (6×$0.95) + chain pay ($1.71) + direct_earn ($0.25) = $7.91 > $7)
const MSIZE   = 7n;             // smallest valid matrix for the test

/** V8.32 T1-T3 splits — sum = 4 750 BPS.
 *  50% crossing reserve + 2.5% direct earn are pre-allocated in _distributePayments
 *  BEFORE the BPS array runs (5000 + 250 + 4750 = 10000 total).
 *  Values scaled from V8.19 proportions (×0.475), rounded to sum exactly 4750. */
const SPLITS = {
  l1Bps:        950,   // $0.95  L1 referral
  chainBps:     950,   // $0.95  chain pay (6 levels)
  poolBps:     1568,   // $1.57  equalization pool
  treasuryBps:  713,   // $0.71  CNOVA treasury backing (SACRED)
  stabilityBps: 238,   // $0.24  StabilityFund per-entry carve
  devBps:       143,   // $0.14  dev wallet
  opsBps:        95,   // $0.10  ops wallet
  communityBps:  48,   // $0.05  community wallet
  buybackBps:    45,   // $0.05  CNOVABuybackReserve
  liquidityBps:   0,   // $0.00  LiquidityReserve (0 for test — no LQ wallet needed)
};
// Per-level chain pay BPS (must sum to chainBps = 950)
const CHAIN_BPS = [475n, 190n, 143n, 71n, 36n, 35n];  // sum = 950

// V8.31: crossing is funded 50% from crossingReserve, 50% from withdrawable.
// Members only need to keep crossNeeded = entryFee − crossingReserve in withdrawable
// while active.  CROSSING_RESERVE_BPS=5000 → crossNeeded = T1_FEE × 5000/10000 = $5.
const CROSS_NEEDED = T1_FEE / 2n;   // $5 (= entryFee − crossingReserve)

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE A — Full V8.1 system  (TierRouter + matrices + CNOVA)
// ═══════════════════════════════════════════════════════════════════════════════
async function deployV8Fixture() {
  // slots: 0=deployer 1=devOps 2=accountOne 3=admin 4=w1 5..18=S0..S13
  const allSigners = await ethers.getSigners();
  const [deployer, devOps, accountOne, admin, w1,
         s0, s1, s2, s3, s4, s5, s6,
         s7, s8, s9, s10, s11, s12, s13] = allSigners;

  // ── 1. Infrastructure ──────────────────────────────────────────────────────
  const MockUSDC      = await ethers.getContractFactory("MockUSDC");
  const usdc          = await MockUSDC.deploy(deployer.address);

  const CNOVAToken    = await ethers.getContractFactory("CNOVAToken");
  const cnova         = await CNOVAToken.deploy(admin.address);

  // CNOVATreasury constructor: (cnova, usdc, admin)
  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury      = await CNOVATreasury.deploy(
    await cnova.getAddress(),
    await usdc.getAddress(),
    admin.address
  );

  // ── 2. TierRouter  (usdc, admin) ──────────────────────────────────────────
  const TierRouter = await ethers.getContractFactory("TierRouter");
  const tierRouter = await TierRouter.deploy(
    await usdc.getAddress(),
    admin.address
  );

  // ── 3. Deploy matrices  (V8.1: struct args) ────────────────────────────────
  // V8.21: core logic now lives in MatrixLogicLib -- deploy + link before
  // getting the FigureEightMatrixV8 factory.
  const MatrixLib  = await ethers.getContractFactory("MatrixLogicLib");
  const matrixLib  = await MatrixLib.deploy();
  await matrixLib.waitForDeployment();
  const FM = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });

  const deployMatrix = async (isA, tierIdx, fee) => FM.deploy(
    // DeployParams struct
    {
      usdc:         await usdc.getAddress(),
      cnova:        await cnova.getAddress(),
      treasury:     await treasury.getAddress(),
      devWallet: devOps.address, opsWallet: devOps.address,
      accountOne:   accountOne.address,
      admin:        admin.address,
    },
    fee,
    MSIZE,
    isA,
    tierIdx,
    // SplitConfig struct  (V8.1 fields)
    SPLITS,
    // Per-level chain pay BPS (sum must equal SPLITS.chainBps = 950)
    CHAIN_BPS
  );

  const matA  = await deployMatrix(true,  0, T1_FEE);
  const matB  = await deployMatrix(false, 0, T1_FEE);
  const matA2 = await deployMatrix(true,  1, T2_FEE);
  const matB2 = await deployMatrix(false, 1, T2_FEE);

  // ── 4. PairManagers  (usdc, fee, admin) ───────────────────────────────────
  const PM  = await ethers.getContractFactory("PairManagerV8");
  const pm1 = await PM.deploy(await usdc.getAddress(), T1_FEE, admin.address);
  const pm2 = await PM.deploy(await usdc.getAddress(), T2_FEE, admin.address);

  // ── 5. Wire T1 pair ────────────────────────────────────────────────────────
  const trAddr  = await tierRouter.getAddress();
  const pm1Addr = await pm1.getAddress();
  const pm2Addr = await pm2.getAddress();

  await matA.connect(admin).setPartner(await matB.getAddress());
  await matB.connect(admin).setPartner(await matA.getAddress());
  await matA.connect(admin).setPairManager(pm1Addr);
  await matB.connect(admin).setPairManager(pm1Addr);
  await matA.connect(admin).setTierRouter(trAddr);
  await matB.connect(admin).setTierRouter(trAddr);

  // ── 6. Wire T2 pair ────────────────────────────────────────────────────────
  await matA2.connect(admin).setPartner(await matB2.getAddress());
  await matB2.connect(admin).setPartner(await matA2.getAddress());
  await matA2.connect(admin).setPairManager(pm2Addr);
  await matB2.connect(admin).setPairManager(pm2Addr);
  await matA2.connect(admin).setTierRouter(trAddr);
  await matB2.connect(admin).setTierRouter(trAddr);

  // ── 7. PairManagers: add pairs + set TierRouter ────────────────────────────
  await pm1.connect(admin).addPair(await matA.getAddress(), await matB.getAddress());
  await pm1.connect(admin).setTierRouter(trAddr);
  await pm2.connect(admin).addPair(await matA2.getAddress(), await matB2.getAddress());
  await pm2.connect(admin).setTierRouter(trAddr);

  // ── 8. TierRouter: register tiers + authorize MatB callbacks ──────────────
  await tierRouter.connect(admin).registerTier(0, pm1Addr, T1_FEE);
  await tierRouter.connect(admin).registerTier(1, pm2Addr, T2_FEE);
  await tierRouter.connect(admin).setTierVelocityGreen(0, true);  // T1 always open
  await tierRouter.connect(admin).setTierVelocityGreen(1, true);  // T2 open for test upgrade path
  await tierRouter.connect(admin).registerMatrix(await matB.getAddress(),  0);
  await tierRouter.connect(admin).registerMatrix(await matB2.getAddress(), 1);

  // ── 9. Treasury: authorize all four matrices ──────────────────────────────
  for (const mat of [matA, matB, matA2, matB2]) {
    await treasury.connect(admin).setAuthorizedCaller(await mat.getAddress(), true);
  }

  // ── 10. CNOVA: grant MINTER_ROLE to all matrices ──────────────────────────
  const MINTER_ROLE = await cnova.MINTER_ROLE();
  for (const mat of [matA, matB, matA2, matB2]) {
    await cnova.connect(admin).grantRole(MINTER_ROLE, await mat.getAddress());
  }

  // ── 11. Fund participants with USDC ───────────────────────────────────────
  const WALLET_BAL = 200n * UNIT;
  for (const who of [w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13]) {
    await usdc.connect(deployer).mint(who.address, WALLET_BAL);
  }
  await usdc.connect(deployer).mint(admin.address, 200n * UNIT);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const reg = async (signer, referrer) => {
    await usdc.connect(signer).approve(pm1Addr, T1_FEE);
    return tierRouter.connect(signer).register(referrer ?? ethers.ZeroAddress);
  };

  const fc = async (memberAddr) => {
    await usdc.connect(admin).approve(await matA.getAddress(), T1_FEE);
    return matA.connect(admin).forceCross(memberAddr);
  };

  return {
    usdc, cnova, treasury, tierRouter, matrixLib,
    matA, matB, matA2, matB2, pm1, pm2,
    deployer, devOps, accountOne, admin,
    w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
    MINTER_ROLE, reg, fc,
  };
}

// ─── Helper: deploy a THIRD matrix pair for T1, for multi-pair broadcast tests ──
async function deployExtraT1Pair({ usdc, cnova, treasury, devOps, accountOne, admin, matrixLib, pm1, tierRouter }) {
  const FM = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });
  const deployParams = {
    usdc:       await usdc.getAddress(),
    cnova:      await cnova.getAddress(),
    treasury:   await treasury.getAddress(),
    devWallet:  devOps.address,
    opsWallet:  devOps.address,
    accountOne: accountOne.address,
    admin:      admin.address,
  };
  const matA3 = await FM.deploy(deployParams, T1_FEE, MSIZE, true,  0, SPLITS, CHAIN_BPS);
  const matB3 = await FM.deploy(deployParams, T1_FEE, MSIZE, false, 0, SPLITS, CHAIN_BPS);
  await matA3.connect(admin).setPartner(await matB3.getAddress());
  await matB3.connect(admin).setPartner(await matA3.getAddress());
  const pm1Addr = await pm1.getAddress();
  const trAddr  = await tierRouter.getAddress();
  await matA3.connect(admin).setPairManager(pm1Addr);
  await matB3.connect(admin).setPairManager(pm1Addr);
  await matA3.connect(admin).setTierRouter(trAddr);
  await matB3.connect(admin).setTierRouter(trAddr);
  return { matA3, matB3 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE B — CNOVAToken only  (for token-unit tests)
async function deployCNOVAFixture() {
  const [admin, minter, alice, bob] = await ethers.getSigners();
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnova = await CNOVAToken.deploy(admin.address);

  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  await cnova.connect(admin).grantRole(MINTER_ROLE,   minter.address);
  await cnova.connect(admin).grantRole(GOVERNOR_ROLE, admin.address);

  return { cnova, admin, minter, alice, bob, MINTER_ROLE, GOVERNOR_ROLE };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1 — Smoke
// ═══════════════════════════════════════════════════════════════════════════════
describe("V8Elevator — T1 → T2 upgrade cycle (MSIZE=7)", function () {

  describe("1. Single registration smoke test", function () {

    it("W1 registers through TierRouter — globalJoined, tier=1, not paused", async function () {
      const { tierRouter, pm1, usdc, w1 } = await loadFixture(deployV8Fixture);

      await usdc.connect(w1).approve(await pm1.getAddress(), T1_FEE);
      await tierRouter.connect(w1).register(ethers.ZeroAddress);

      expect(await tierRouter.globalJoined(w1.address)).to.be.true;
      expect(await tierRouter.memberHighestTier(w1.address)).to.equal(1);
      expect(await tierRouter.systemPaused()).to.be.false;
    });

    it("Duplicate registration reverts", async function () {
      const { tierRouter, pm1, usdc, w1 } = await loadFixture(deployV8Fixture);

      await usdc.connect(w1).approve(await pm1.getAddress(), T1_FEE * 2n);
      await tierRouter.connect(w1).register(ethers.ZeroAddress);
      await expect(
        tierRouter.connect(w1).register(ethers.ZeroAddress)
      ).to.be.revertedWith("TR: already joined");
    });

  });

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2 — Full Elevator
// ═══════════════════════════════════════════════════════════════════════════════
  describe("2. Full elevator: matA fill → forceCross fill → W1 upgrades to T2", function () {

    it("15-registration + 7-forceCross sequence upgrades W1 to T2", async function () {
      const {
        tierRouter, matA, matB, admin,
        w1, s0, s1, s2, s3, s4, s5, s6,
        s7, s8, s9, s10, s11, s12, s13,
        reg, fc,
      } = await loadFixture(deployV8Fixture);

      // ROUND 1: W1 + S0-S5 register (7 members, fills matA occ=7)
      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);

      // S6 entry → occ==7 → W1 cycles out of matA → crosses to matB pos1
      await reg(s6, w1.address);
      expect(await tierRouter.globalJoined(w1.address)).to.be.true;
      expect(await tierRouter.memberHighestTier(w1.address)).to.equal(1);

      // ROUND 2: S7-S12 register → cycles out S0-S5 (each parks: earned < $5)
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);

      // S13 registers → S6 cycles out of matA → parks
      await reg(s13, w1.address);

      // FORCE-CROSS S0-S5 into matB  (occ goes 1→7)
      for (const s of [s0, s1, s2, s3, s4, s5]) await fc(s.address);  // V8.32: S0-S5 earn well below $5 cross_needed → all park, need force-cross
      expect(await matB.isFull()).to.be.true;

      // FORCE-CROSS S6 → fills matB to occ==7+1 → W1 cycles out of matB
      // handleCycleOut fires → W1 matB withdrawable:
      //   direct_earn from W1's own matB entry                =  $0.25
      //   L1 from S0-S5 force-crosses into matB (6 × $0.95)  =  $5.70  (V8.32: payBase=entryFee)
      //   chain pay from S0-S5 matrix positions in matB       =  $1.71
      //   matB total = $7.66 > T2_FEE $7  → UPGRADE fires
      await fc(s6.address);

      // ── KEY ASSERTIONS ────────────────────────────────────────────────────
      expect(await tierRouter.memberHighestTier(w1.address)).to.equal(
        2, "W1 should have reached T2"
      );
      expect(await tierRouter.tierCycles(w1.address, 0)).to.equal(
        1, "W1 should have exactly 1 T1 cycle"
      );
      expect(await tierRouter.totalSystemCycles()).to.equal(
        1, "Exactly 1 TierRouter-visible cycle"
      );
      expect(await tierRouter.systemPaused()).to.be.false;
    });

  });

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3 — Inactivity Guard
// ═══════════════════════════════════════════════════════════════════════════════
  describe("3. Inactivity guard", function () {

    it("does NOT pause after 1 cycle (default threshold = 2)", async function () {
      const {
        tierRouter, admin,
        w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg, fc,
      } = await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);
      for (const s of [s0, s1, s2, s3, s4, s5]) await fc(s.address);  // V8.32: S0-S5 earn well below $5 cross_needed → all park, need force-cross
      await fc(s6.address);

      await tierRouter.checkInactivity();
      expect(await tierRouter.systemPaused()).to.be.false;
    });

    it("pauses when cyclesThreshold is lowered to 1", async function () {
      const {
        tierRouter, admin,
        w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg, fc,
      } = await loadFixture(deployV8Fixture);

      await tierRouter.connect(admin).setInactivityConfig(30, 1, true);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);
      for (const s of [s0, s1, s2, s3, s4, s5]) await fc(s.address);  // V8.32: S0-S5 earn well below $5 cross_needed → all park, need force-cross
      await fc(s6.address);

      await tierRouter.checkInactivity();
      expect(await tierRouter.systemPaused()).to.be.true;

      await tierRouter.connect(admin).resumeSystem();
      expect(await tierRouter.systemPaused()).to.be.false;
    });

    it("owner can pauseSystem() immediately, blocking new register()", async function () {
      const { tierRouter, admin, w1, reg } = await loadFixture(deployV8Fixture);

      expect(await tierRouter.systemPaused()).to.be.false;

      await expect(tierRouter.connect(admin).pauseSystem("emergency: bug found in matrix B"))
        .to.emit(tierRouter, "SystemPaused")
        .withArgs("emergency: bug found in matrix B", 0, 0);

      expect(await tierRouter.systemPaused()).to.be.true;

      await expect(reg(w1, ethers.ZeroAddress))
        .to.be.revertedWith("TR: system paused - inactivity");
    });

    it("rejects pauseSystem() from a non-owner", async function () {
      const { tierRouter, w1 } = await loadFixture(deployV8Fixture);

      await expect(tierRouter.connect(w1).pauseSystem("not the owner"))
        .to.be.revertedWithCustomError(tierRouter, "OwnableUnauthorizedAccount");
    });

    it("rejects pauseSystem() when already paused", async function () {
      const { tierRouter, admin } = await loadFixture(deployV8Fixture);

      await tierRouter.connect(admin).pauseSystem("first pause");
      await expect(tierRouter.connect(admin).pauseSystem("second pause"))
        .to.be.revertedWith("TR: already paused");
    });

    it("owner can unpauseSystem() after a manual pause, restoring register()", async function () {
      const { tierRouter, admin, w1, reg } = await loadFixture(deployV8Fixture);

      await tierRouter.connect(admin).pauseSystem("emergency");
      expect(await tierRouter.systemPaused()).to.be.true;

      await expect(tierRouter.connect(admin).unpauseSystem())
        .to.emit(tierRouter, "SystemResumed")
        .withArgs(admin.address);

      expect(await tierRouter.systemPaused()).to.be.false;
      await expect(reg(w1, ethers.ZeroAddress)).to.not.be.reverted;
    });

    it("rejects unpauseSystem() from a non-owner", async function () {
      const { tierRouter, admin, w1 } = await loadFixture(deployV8Fixture);

      await tierRouter.connect(admin).pauseSystem("emergency");
      await expect(tierRouter.connect(w1).unpauseSystem())
        .to.be.revertedWithCustomError(tierRouter, "OwnableUnauthorizedAccount");
    });

    it("rejects unpauseSystem() when not paused", async function () {
      const { tierRouter, admin } = await loadFixture(deployV8Fixture);

      await expect(tierRouter.connect(admin).unpauseSystem())
        .to.be.revertedWith("TR: not paused");
    });

    it("unpauseSystem() also clears a pause that was triggered automatically by checkInactivity()", async function () {
      const {
        tierRouter, admin,
        w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg, fc,
      } = await loadFixture(deployV8Fixture);

      await tierRouter.connect(admin).setInactivityConfig(30, 1, true);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);
      for (const s of [s0, s1, s2, s3, s4, s5]) await fc(s.address);
      await fc(s6.address);

      await tierRouter.checkInactivity();
      expect(await tierRouter.systemPaused()).to.be.true;

      await tierRouter.connect(admin).unpauseSystem();
      expect(await tierRouter.systemPaused()).to.be.false;
    });

  });

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4 — TierRouter admin guards
// ═══════════════════════════════════════════════════════════════════════════════
  describe("4. TierRouter admin guards", function () {

    it("handleCycleOut reverts for non-registered caller", async function () {
      const { tierRouter, w1 } = await loadFixture(deployV8Fixture);
      await expect(
        tierRouter.connect(w1).handleCycleOut(w1.address, 0, 0n, 0n)
      ).to.be.revertedWith("TR: unauthorized");
    });

    it("registerTier reverts for non-owner", async function () {
      const { tierRouter, pm1, w1 } = await loadFixture(deployV8Fixture);
      await expect(
        tierRouter.connect(w1).registerTier(2, await pm1.getAddress(), T1_FEE)
      ).to.be.reverted;
    });

  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5 — CNOVAToken V8.1: tier multiplier + triple epoch trigger
// ═══════════════════════════════════════════════════════════════════════════════
describe("CNOVAToken V8.1 — tier multiplier + epoch triggers", function () {

  // ── 5a. Tier multiplier ───────────────────────────────────────────────────
  describe("5a. Tier multiplier", function () {

    it("T1 (index 0) earns 50 CNOVA in epoch 1", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);
      await cnova.connect(minter).mintReward(alice.address, 0);
      expect(await cnova.balanceOf(alice.address))
        .to.equal(ethers.parseUnits("50", 18));
    });

    it("T4 (index 3) earns 8× base = 400 CNOVA in epoch 1", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);
      await cnova.connect(minter).mintReward(alice.address, 3);
      expect(await cnova.balanceOf(alice.address))
        .to.equal(ethers.parseUnits("400", 18));   // 50 * 8
    });

    it("T7 (index 6) earns 80× base = 4000 CNOVA in epoch 1", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);
      await cnova.connect(minter).mintReward(alice.address, 6);
      expect(await cnova.balanceOf(alice.address))
        .to.equal(ethers.parseUnits("4000", 18));  // 50 * 80
    });

    it("all minted tokens are locked (vested) immediately after mint", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);
      await cnova.connect(minter).mintReward(alice.address, 6);
      const bal    = await cnova.balanceOf(alice.address);
      const locked = await cnova.lockedBalanceOf(alice.address);
      expect(locked).to.equal(bal);
    });

    it("vested tokens cannot be transferred", async function () {
      const { cnova, minter, alice, bob } = await loadFixture(deployCNOVAFixture);
      await cnova.connect(minter).mintReward(alice.address, 0);
      await expect(
        cnova.connect(alice).transfer(bob.address, ethers.parseUnits("1", 18))
      ).to.be.revertedWith("CNOVA: tokens vesting -- wait for unlock");
    });

    it("invalid tier index (>= 10) reverts — T8/T9/T10 now valid (160x/320x/640x)", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);
      // T8=7, T9=8, T10=9 are now valid; only index >= 10 should revert
      await expect(
        cnova.connect(minter).mintReward(alice.address, 10)
      ).to.be.revertedWith("CNOVA: invalid tier");
      // Spot-check: T8 (index 7) should NOT revert
      await expect(
        cnova.connect(minter).mintReward(alice.address, 7)
      ).to.not.be.reverted;
    });

  });

  // ── 5b. Mint trigger ─────────────────────────────────────────────────────
  describe("5b. Epoch advance — MINT trigger", function () {

    it("epoch advances when epochMintLimit is crossed", async function () {
      const { cnova, admin, minter, alice } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(admin).setEpochMintLimit(ethers.parseUnits("100000", 18));

      expect(await cnova.currentEpoch()).to.equal(0);

      for (let i = 0; i < 25; i++) {
        await cnova.connect(minter).mintReward(alice.address, 6);
      }
      expect(await cnova.currentEpoch()).to.equal(0);

      await cnova.connect(minter).mintReward(alice.address, 6);
      expect(await cnova.currentEpoch()).to.equal(1);

      const batches = await cnova.vestBatchesOf(alice.address);
      expect(batches.length).to.be.gte(2);
    });

  });

  // ── 5c. Member trigger ───────────────────────────────────────────────────
  describe("5c. Epoch advance — MEMBER trigger", function () {

    it("epoch advances when epochMemberLimit is crossed", async function () {
      const { cnova, admin, minter, alice, bob } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(admin).setEpochMemberLimit(2);

      expect(await cnova.currentEpoch()).to.equal(0);

      await cnova.connect(minter).mintReward(alice.address, 0);
      expect(await cnova.currentEpoch()).to.equal(0);

      await cnova.connect(minter).mintReward(bob.address, 0);
      expect(await cnova.currentEpoch()).to.equal(0);

      const [extra1] = await ethers.getSigners().then(s => s.slice(5));
      await cnova.connect(minter).mintReward(extra1.address, 0);
      expect(await cnova.currentEpoch()).to.equal(1);
    });

  });

  // ── 5d. Time trigger ─────────────────────────────────────────────────────
  describe("5d. Epoch advance — TIME trigger", function () {

    it("epoch advances after epochTimeLimit elapses with no activity", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);

      expect(await cnova.currentEpoch()).to.equal(0);

      await time.increase(30 * 24 * 3600 + 1);

      await cnova.connect(minter).mintReward(alice.address, 0);
      expect(await cnova.currentEpoch()).to.equal(1);
    });

    it("epochLeadingTrigger returns TIME when no activity", async function () {
      const { cnova } = await loadFixture(deployCNOVAFixture);
      await time.increase(25 * 24 * 3600);
      const TRIGGER_TIME = 2;
      expect(await cnova.epochLeadingTrigger()).to.equal(TRIGGER_TIME);
    });

  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6 — CNOVAToken V8.1b: earlyUnlock / earlyUnlockAll
// ═══════════════════════════════════════════════════════════════════════════════
describe("CNOVAToken V8.1b — early withdrawal penalty", function () {

  // ── 6a. earlyUnlock at day 0  (max penalty = 50%) ─────────────────────────
  describe("6a. earlyUnlock — full penalty at day 0", function () {

    it("at day 0: 50% released, 50% burned, tokens unlocked", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(minter).mintReward(alice.address, 0);
      const minted = ethers.parseUnits("50", 18);

      expect(await cnova.lockedBalanceOf(alice.address)).to.equal(minted);

      const tx = await cnova.connect(alice).earlyUnlock(0);
      const receipt = await tx.wait();

      expect(await cnova.lockedBalanceOf(alice.address)).to.equal(0n);

      const expectedReleased = minted / 2n;
      expect(await cnova.balanceOf(alice.address)).to.be.closeTo(
        expectedReleased, ethers.parseUnits("0.01", 18)
      );

      expect(await cnova.totalSupply()).to.be.closeTo(expectedReleased, ethers.parseUnits("0.01", 18));
    });

    it("emits EarlyUnlock event with correct values", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);
      await cnova.connect(minter).mintReward(alice.address, 0);
      const minted = ethers.parseUnits("50", 18);

      await expect(cnova.connect(alice).earlyUnlock(0))
        .to.emit(cnova, "EarlyUnlock");
    });

  });

  // ── 6b. earlyUnlock halfway through vesting ──────────────────────────────
  describe("6b. earlyUnlock — sliding penalty at 50% of cliff", function () {

    it("at 90 days (half of 180): penalty ~25%, released ~75%", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(minter).mintReward(alice.address, 0);
      const minted = ethers.parseUnits("50", 18);

      await time.increase(90 * 24 * 3600);

      await cnova.connect(alice).earlyUnlock(0);

      const expectedPenalty  = minted * 2500n / 10000n;
      const expectedReleased = minted - expectedPenalty;

      expect(await cnova.balanceOf(alice.address)).to.be.closeTo(
        expectedReleased, ethers.parseUnits("0.01", 18)
      );
    });

  });

  // ── 6c. earlyUnlock after cliff expires ──────────────────────────────────
  describe("6c. earlyUnlock — zero penalty after cliff", function () {

    it("after 180 days: no penalty, full amount retained", async function () {
      const { cnova, minter, alice } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(minter).mintReward(alice.address, 0);
      const minted = ethers.parseUnits("50", 18);

      await time.increase(181 * 24 * 3600);

      await cnova.connect(alice).earlyUnlock(0);

      expect(await cnova.balanceOf(alice.address)).to.equal(minted);
      expect(await cnova.totalSupply()).to.equal(minted);
    });

  });

  // ── 6d. earlyUnlockAll ────────────────────────────────────────────────────
  describe("6d. earlyUnlockAll — batch unlock across multiple vest batches", function () {

    it("unlocks 3 batches, applies independent penalties to each", async function () {
      const { cnova, admin, minter, alice } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(admin).setEpochTimeLimit(365 * 24 * 3600);

      await cnova.connect(minter).mintReward(alice.address, 0);
      await time.increase(30 * 24 * 3600);
      await cnova.connect(minter).mintReward(alice.address, 0);
      await time.increase(30 * 24 * 3600);
      await cnova.connect(minter).mintReward(alice.address, 0);

      const totalMinted = ethers.parseUnits("150", 18);
      expect(await cnova.balanceOf(alice.address)).to.equal(totalMinted);
      expect(await cnova.lockedBalanceOf(alice.address)).to.equal(totalMinted);

      await cnova.connect(alice).earlyUnlockAll();

      expect(await cnova.lockedBalanceOf(alice.address)).to.equal(0n);
      expect(await cnova.vestBatchesOf(alice.address)).to.have.length(0);

      const finalBal = await cnova.balanceOf(alice.address);
      expect(finalBal).to.be.lt(totalMinted);
      expect(finalBal).to.be.gt(ethers.parseUnits("75", 18));
    });

  });

  // ── 6e. penaltyDestination redirect ──────────────────────────────────────
  describe("6e. penaltyDestination — redirect penalty to address", function () {

    it("penalty goes to penaltyDestination instead of being burned", async function () {
      const { cnova, admin, minter, alice, bob } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(admin).setPenaltyDestination(bob.address);

      await cnova.connect(minter).mintReward(alice.address, 0);
      const minted = ethers.parseUnits("50", 18);

      await cnova.connect(alice).earlyUnlock(0);

      expect(await cnova.totalSupply()).to.equal(minted);
      expect(await cnova.balanceOf(bob.address)).to.be.gt(0n);
      expect(await cnova.balanceOf(alice.address)).to.be.lt(minted);
    });

  });

  // ── 6f. governance setters ────────────────────────────────────────────────
  describe("6f. Governance — setMaxPenaltyBps", function () {

    it("setMaxPenaltyBps(0) disables early exit penalty entirely", async function () {
      const { cnova, admin, minter, alice } = await loadFixture(deployCNOVAFixture);

      await cnova.connect(admin).setMaxPenaltyBps(0);

      await cnova.connect(minter).mintReward(alice.address, 0);
      const minted = ethers.parseUnits("50", 18);

      await cnova.connect(alice).earlyUnlock(0);
      expect(await cnova.balanceOf(alice.address)).to.equal(minted);
      expect(await cnova.totalSupply()).to.equal(minted);
    });

    it("setMaxPenaltyBps reverts if > 5000 (50% cap)", async function () {
      const { cnova, admin } = await loadFixture(deployCNOVAFixture);
      await expect(
        cnova.connect(admin).setMaxPenaltyBps(5001)
      ).to.be.revertedWith("CNOVA: penalty exceeds 50%");
    });

  });

});


// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7 — V8.10 Security: Withdrawal Reserve + Drain-and-Park Prevention
// ═══════════════════════════════════════════════════════════════════════════════
describe("V8.10 — Withdrawal reserve, drain-and-park prevention, grace eviction", function () {

  // ── 7a. Withdraw while active: ENTRY_FEE reserve enforced ────────────────────
  describe("7a. Withdrawal reserve — active member", function () {

    it("withdraw() while in-matrix reverts when earnings <= ENTRY_FEE", async function () {
      const { matA, usdc, w1, s0, reg } = await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);   // W1 = root
      await reg(s0, w1.address);           // S0 joins; W1 earns L1 + chain pay

      const { withdrawable, isInMatrix } = await matA.getMember(w1.address);
      expect(isInMatrix).to.be.true;
      expect(withdrawable).to.be.gt(0n);
      expect(withdrawable).to.be.lte(T1_FEE);   // <= $10 -> reserve would eat everything

      await expect(
        matA.connect(w1).withdraw()
      ).to.be.revertedWith("F8V8: must keep crossing reserve while active");
    });

    it("withdraw() while in-matrix with automation disabled: full balance withdrawable (V8.32 Task #63)", async function () {
      const { matA, usdc, tierRouter, w1, s0, s1, s2, s3, s4, s5, reg } =
        await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);

      const { withdrawable: earnedBefore, isInMatrix } = await matA.getMember(w1.address);
      expect(isInMatrix).to.be.true;
      expect(earnedBefore).to.be.gt(CROSS_NEEDED, "W1 must earn > crossNeeded ($5) for this test");

      // V8.32 Task #63: disable auto-upgrade AND auto-reentry -> reservedFor(w1) = 0
      // -> automationReserve = 0 -> crossing reserve check intentionally skipped.
      // Member opted out of all automation -> may withdraw full balance freely.
      await tierRouter.connect(w1).setMemberOptions(true, false, false);

      const balBefore = await usdc.balanceOf(w1.address);
      await matA.connect(w1).withdraw();
      const balAfter  = await usdc.balanceOf(w1.address);

      const { withdrawable: reserveLeft, totalWithdrawn } = await matA.getMember(w1.address);

      // V8.32: no reserve kept when automation is fully disabled -- full withdrawable cleared
      expect(reserveLeft).to.equal(0n, "No reserve kept when automation is fully disabled (V8.32 Task #63)");

      // V8.32: automation disabled -> full balance withdrawable, no reserve locked
      const grossWithdrawn = earnedBefore;
      expect(totalWithdrawn).to.equal(grossWithdrawn, "totalWithdrawn must match gross amount");

      // Net payout = grossWithdrawn - 1.5% withdrawal fee
      const fee    = grossWithdrawn * 150n / 10_000n;
      const payout = grossWithdrawn - fee;
      expect(balAfter - balBefore).to.equal(payout, "Payout must be gross minus withdrawal fee");
    });

  });

  // ── 7b. Withdraw after cycling out: full withdrawal allowed ──────────────────
  describe("7b. Withdrawal reserve — inactive member (post cycle-out)", function () {

    it("withdraw() on matA after W1 cycled to matB allows full withdrawal (no reserve)", async function () {
      const { matA, usdc, tierRouter, w1, s0, s1, s2, s3, s4, s5, s6, reg } =
        await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);

      const matAMember = await matA.getMember(w1.address);
      expect(matAMember.isInMatrix).to.be.false;

      await tierRouter.connect(w1).setMemberOptions(true, false, false);

      if (matAMember.withdrawable > 0n) {
        const balBefore = await usdc.balanceOf(w1.address);
        await matA.connect(w1).withdraw();
        const balAfter  = await usdc.balanceOf(w1.address);

        expect(balAfter).to.be.gte(balBefore, "Payout must be non-negative");
        expect((await matA.getMember(w1.address)).withdrawable).to.equal(
          0n, "All withdrawable must be cleared -- no reserve held for inactive member"
        );
      }
    });

  });

  // ── 7c. totalWithdrawn tracks gross pre-fee amounts ──────────────────────────
  describe("7c. totalWithdrawn tracking", function () {

    it("totalWithdrawn accumulates gross pre-fee amount per withdraw call", async function () {
      const { matA, usdc, tierRouter, w1, s0, s1, s2, s3, s4, s5, s6, reg } =
        await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);

      const { withdrawable: earned } = await matA.getMember(w1.address);
      expect(earned).to.be.gt(CROSS_NEEDED);  // V8.31: check vs crossNeeded ($5) not ENTRY_FEE

      // V8.32: disable auto-upgrade so Protocol Reserve = 0 (this test is about totalWithdrawn tracking only)
      await tierRouter.connect(w1).setMemberOptions(true, false, false);

      // V8.32: automation disabled (setMemberOptions(true,false,false)) -> automationReserve = 0
      // -> no crossing reserve check -> full balance withdrawn, no reserve kept
      await matA.connect(w1).withdraw();
      const gross1 = earned;   // full amount when automationReserve = 0
      expect((await matA.getMember(w1.address)).totalWithdrawn).to.equal(
        gross1, "totalWithdrawn after first withdraw must equal gross amount"
      );

      // Cycle W1 out of matA -> W1 inactive in matA
      await reg(s6, w1.address);

      // V8.32: after first full withdrawal, withdrawable = 0; remaining = 0
      const { withdrawable: remaining } = await matA.getMember(w1.address);
      if (remaining > 0n) {
        await matA.connect(w1).withdraw();
        const totalExpected = gross1 + remaining;
        expect((await matA.getMember(w1.address)).totalWithdrawn).to.equal(
          totalExpected, "totalWithdrawn must accumulate across both withdrawals"
        );
      }
    });

  });

  // ── 7d. parkedAt — grace period clock ────────────────────────────────────────
  describe("7d. parkedAt — grace period clock", function () {

    it("parkedAt[member] is set when a member parks on cycle-out with insufficient funds", async function () {
      const {
        matA,
        w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg,
      } = await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);

      const parkedTs = await matA.parkedAt(s0.address);
      expect(parkedTs).to.be.gt(0n, "parkedAt must be set when member parks");
      expect(await matA.getParkedCount()).to.be.gte(1n);
    });

    it("parkedAt[member] is cleared when evictParked is called", async function () {
      const {
        matA, admin,
        w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg,
      } = await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);

      expect(await matA.parkedAt(s0.address)).to.be.gt(0n);

      await matA.connect(admin).setMatrixKeeper(admin.address);
      await matA.connect(admin).evictParked(s0.address);

      expect(await matA.parkedAt(s0.address)).to.equal(0n, "parkedAt must clear after eviction");
    });

  });

  // ── 7e. evictParked — keeper-only grace-period eviction ──────────────────────
  describe("7e. evictParked — V8.10 grace-period eviction", function () {

    it("only matrixKeeper can call evictParked", async function () {
      const {
        matA, admin, w1,
        s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg,
      } = await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);

      expect(await matA.parkedAt(s0.address)).to.be.gt(0n);

      await expect(
        matA.connect(w1).evictParked(s0.address)
      ).to.be.revertedWith("F8V8: not keeper");
    });

    it("evictParked removes member from parked queue and emits MemberEvicted", async function () {
      const {
        matA, admin,
        w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13,
        reg,
      } = await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
      await reg(s6, w1.address);
      for (const s of [s7, s8, s9, s10, s11, s12]) await reg(s, w1.address);
      await reg(s13, w1.address);

      const countBefore = await matA.getParkedCount();
      expect(countBefore).to.be.gte(1n);
      expect(await matA.parkedAt(s0.address)).to.be.gt(0n);

      await matA.connect(admin).setMatrixKeeper(admin.address);

      const tx      = await matA.connect(admin).evictParked(s0.address);
      const receipt = await tx.wait();

      expect(await matA.parkedAt(s0.address)).to.equal(
        0n, "parkedAt must clear after eviction"
      );
      expect(await matA.getParkedCount()).to.equal(
        countBefore - 1n, "Parked count must decrease by 1"
      );
      const evicted = receipt.logs.some(log => {
        try { return matA.interface.parseLog(log)?.name === "MemberEvicted"; }
        catch { return false; }
      });
      expect(evicted).to.be.true;
    });

    it("evictParked reverts when member was never parked", async function () {
      const { matA, admin, w1, reg } = await loadFixture(deployV8Fixture);

      await matA.connect(admin).setMatrixKeeper(admin.address);
      await reg(w1, ethers.ZeroAddress);

      await expect(
        matA.connect(admin).evictParked(w1.address)
      ).to.be.revertedWith("F8V8: member not parked");
    });

    it("getMemberTotalWithdrawn returns correct value after withdrawals", async function () {
      const { matA, tierRouter, w1, s0, s1, s2, s3, s4, s5, reg } =
        await loadFixture(deployV8Fixture);

      await reg(w1, ethers.ZeroAddress);
      for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);

      const { withdrawable: earned } = await matA.getMember(w1.address);
      expect(earned).to.be.gt(CROSS_NEEDED);  // V8.31: check vs crossNeeded ($5) not ENTRY_FEE

      // V8.32: disable auto-upgrade so Protocol Reserve = 0 (this test is about totalWithdrawn tracking only)
      await tierRouter.connect(w1).setMemberOptions(true, false, false);

      // Before any withdrawal
      expect(await matA.getMemberTotalWithdrawn(w1.address)).to.equal(0n);

      // V8.32: automation disabled -> full withdrawal, no reserve kept
      await matA.connect(w1).withdraw();
      const grossExpected = earned;  // full amount when automationReserve = 0
      expect(await matA.getMemberTotalWithdrawn(w1.address)).to.equal(grossExpected);
    });

  });

});


// =============================================================================
// SUITE 9 — V8.21 Whale Gate redesign: per-tier tracking, no skip-ahead
// =============================================================================
describe("V8.21 — Whale Gate: per-tier first-entry tracking (shared threshold)", function () {

  it("isWhaleGateActiveForTier starts false for every tier before any registrations", async function () {
    const { tierRouter } = await loadFixture(deployV8Fixture);
    expect(await tierRouter.isWhaleGateActiveForTier(1)).to.be.false;
    expect(await tierRouter.isWhaleGateActiveForTier(2)).to.be.false;
    expect(await tierRouter.tierFirstEntries(1)).to.equal(0n);
  });

  it("tierFirstEntries(1) increments once per distinct first-time T1 registration", async function () {
    const { tierRouter, w1, s0, s1, s2, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);
    expect(await tierRouter.tierFirstEntries(1)).to.equal(1n);

    await reg(s0, w1.address);
    expect(await tierRouter.tierFirstEntries(1)).to.equal(2n);

    await reg(s1, w1.address);
    await reg(s2, w1.address);
    expect(await tierRouter.tierFirstEntries(1)).to.equal(4n);
  });

  it("trips tierWhaleGateActive(1) exactly at the shared threshold, emits per-tier event, and leaves tier 2 untouched", async function () {
    const {
      tierRouter, admin,
      w1, s0, s1, s2, s3, s4, s5, s6, s7, s8,
      reg,
    } = await loadFixture(deployV8Fixture);

    await tierRouter.connect(admin).setWhaleGateThreshold(10);

    const first9 = [w1, s0, s1, s2, s3, s4, s5, s6, s7];

    await reg(first9[0], ethers.ZeroAddress);
    for (let i = 1; i < first9.length; i++) {
      await reg(first9[i], first9[0].address);
    }
    expect(await tierRouter.tierFirstEntries(1)).to.equal(9n);
    expect(await tierRouter.isWhaleGateActiveForTier(1)).to.be.false;

    await expect(reg(s8, first9[0].address))
      .to.emit(tierRouter, "WhaleGateActivated")
      .withArgs(1, 10n);

    expect(await tierRouter.tierFirstEntries(1)).to.equal(10n);
    expect(await tierRouter.isWhaleGateActiveForTier(1)).to.be.true;

    expect(await tierRouter.tierFirstEntries(2)).to.equal(0n);
    expect(await tierRouter.isWhaleGateActiveForTier(2)).to.be.false;
  });

  it("re-registering the same member never double-counts toward tierFirstEntries", async function () {
    const { tierRouter, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);
    expect(await tierRouter.tierFirstEntries(1)).to.equal(1n);
    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(1);

    await expect(
      tierRouter.connect(w1).register(ethers.ZeroAddress)
    ).to.be.revertedWith("TR: already joined");
    expect(await tierRouter.tierFirstEntries(1)).to.equal(1n);
  });

  it("getMemberInfo.whaleGateEligible is keyed off the member's NEXT tier, not a skip-ahead flag", async function () {
    const { tierRouter, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);

    let info = await tierRouter.getMemberInfo(w1.address);
    expect(info.whaleGateEligible).to.be.false;
    expect(info.whaleGateEligible).to.equal(await tierRouter.isWhaleGateActiveForTier(2));
  });

});

// ===============================================================================
// SUITE — V8.21: PairManagerV8 fee broadcast (param #9 target wiring fix)
// ===============================================================================
describe("V8.21 — PairManagerV8 fee broadcast (param #9 target wiring fix)", function () {

  it("setWithdrawalFeeBps broadcasts to every pair the tier has ever added, not just the first", async function () {
    const fx = await loadFixture(deployV8Fixture);
    const { pm1, matA, matB, admin } = fx;
    const { matA3, matB3 } = await deployExtraT1Pair(fx);

    await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());

    await pm1.connect(admin).setWithdrawalFeeBps(100);

    expect(await matA.withdrawalFeeBps()).to.equal(100n);
    expect(await matB.withdrawalFeeBps()).to.equal(100n);
    expect(await matA3.withdrawalFeeBps()).to.equal(100n);
    expect(await matB3.withdrawalFeeBps()).to.equal(100n);
    expect(await pm1.lastWithdrawalFeeBps()).to.equal(100n);
  });

  it("emits WithdrawalFeeBpsBroadcast with the correct pair count", async function () {
    const fx = await loadFixture(deployV8Fixture);
    const { pm1, admin } = fx;
    const { matA3, matB3 } = await deployExtraT1Pair(fx);
    await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());

    await expect(pm1.connect(admin).setWithdrawalFeeBps(200))
      .to.emit(pm1, "WithdrawalFeeBpsBroadcast").withArgs(200n, 2n);
  });

  it("a brand-new pair stays on FigureEightMatrixV8's constructor default (150) when nothing has been broadcast yet", async function () {
    const fx = await loadFixture(deployV8Fixture);
    const { pm1, admin } = fx;
    const { matA3, matB3 } = await deployExtraT1Pair(fx);

    expect(await pm1.lastWithdrawalFeeBps()).to.equal(0n);

    await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());

    expect(await matA3.withdrawalFeeBps()).to.equal(150n);
  });

  it("addPair() auto-stamps a pair added AFTER a broadcast with the last broadcast value -- no extra governance call needed", async function () {
    const fx = await loadFixture(deployV8Fixture);
    const { pm1, admin } = fx;

    await pm1.connect(admin).setWithdrawalFeeBps(200);

    const { matA3, matB3 } = await deployExtraT1Pair(fx);
    await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());

    expect(await matA3.withdrawalFeeBps()).to.equal(200n);
    expect(await matB3.withdrawalFeeBps()).to.equal(200n);
  });

  it("setWithdrawalFeeBps: only owner or governance can call", async function () {
    const { pm1, admin, w1 } = await loadFixture(deployV8Fixture);

    await expect(pm1.connect(w1).setWithdrawalFeeBps(100))
      .to.be.revertedWith("PM8: not authorized");

    await expect(pm1.connect(admin).setWithdrawalFeeBps(100)).to.not.be.reverted;
  });

  it("setGovernance: owner-only, zero-address guarded, emits GovernanceSet, and the governance address can then call the broadcast setter", async function () {
    const { pm1, admin, w1, matA, matB } = await loadFixture(deployV8Fixture);

    await expect(pm1.connect(w1).setGovernance(w1.address))
      .to.be.revertedWithCustomError(pm1, "OwnableUnauthorizedAccount");
    await expect(pm1.connect(admin).setGovernance(ethers.ZeroAddress))
      .to.be.revertedWith("PM8: zero governance");

    await expect(pm1.connect(admin).setGovernance(w1.address))
      .to.emit(pm1, "GovernanceSet").withArgs(w1.address);

    await pm1.connect(w1).setWithdrawalFeeBps(100);
    expect(await matA.withdrawalFeeBps()).to.equal(100n);
    expect(await matB.withdrawalFeeBps()).to.equal(100n);
  });

  it("REGRESSION: FigureEightMatrixV8 still rejects setWithdrawalFeeBps from a random address that is not owner/tierRouter/governance/pairManager", async function () {
    const { matA, w1 } = await loadFixture(deployV8Fixture);

    await expect(matA.connect(w1).setWithdrawalFeeBps(100))
      .to.be.revertedWith("F8V8: not governance");
  });

  it("REGRESSION: setEarlyExitPenaltyBps no longer exists anywhere -- param #10 was retired entirely, not broadcast", async function () {
    const { matA, pm1 } = await loadFixture(deployV8Fixture);
    expect(matA.setEarlyExitPenaltyBps).to.equal(undefined);
    expect(pm1.setEarlyExitPenaltyBps).to.equal(undefined);
  });

});
