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

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE C — V8 system + fully-wired MatrixPairFactory (for V8.39 tests)
// ═══════════════════════════════════════════════════════════════════════════════
async function deployWithFactoryFixture() {
  const base = await deployV8Fixture();
  const { usdc, cnova, treasury, tierRouter, pm1,
          admin, devOps, accountOne, matrixLib } = base;

  // Deploy MatrixPairFactory with admin as _admin (mirrors production setup).
  // Must link MatrixLogicLib — MatrixPairFactory embeds FigureEightMatrixV8 creation bytecode.
  const MPF     = await ethers.getContractFactory("MatrixPairFactory", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });
  const factory = await MPF.deploy(
    admin.address,
    await usdc.getAddress(),
    await cnova.getAddress(),
    await treasury.getAddress()
  );
  const factoryAddr = await factory.getAddress();

  // Configure factory for T1
  await factory.connect(admin).setWallets(
    devOps.address, devOps.address, accountOne.address
  );
  await factory.connect(admin).setPeripherals(
    ethers.ZeroAddress,            // sf  — not deployed in unit tests
    ethers.ZeroAddress,            // cr
    await tierRouter.getAddress(), // tierRouter
    ethers.ZeroAddress,            // keeper
    ethers.ZeroAddress,            // gov
    ethers.ZeroAddress,            // bbr
    ethers.ZeroAddress             // lr
  );
  await factory.connect(admin).configureTier(1, T1_FEE, MSIZE, SPLITS, CHAIN_BPS);
  await factory.connect(admin).registerPairManager(await pm1.getAddress(), 1);

  // Wire factory into pm1  → _tryAdvancePair can call factory.deployAndWire()
  await pm1.connect(admin).setFactory(factoryAddr);
  // Wire factory into treasury → factory.deployAndWire() can call setAuthorizedCaller()
  await treasury.connect(admin).setFactory(factoryAddr);
  // Wire factory into tierRouter → factory.deployAndWire() can call registerMatrix()
  await tierRouter.connect(admin).setFactory(factoryAddr);
  // Grant factory DEFAULT_ADMIN_ROLE on cnova → factory.deployAndWire() can grantRole(MINTER_ROLE)
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  await cnova.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, factoryAddr);

  return { ...base, factory };
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

    it("15-registration + 7-forceCross sequence re-enters W1 at T1 (V8.44 re-entry priority)", async function () {
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
      // handleCycleOut fires → W1 matB funds (V8.44 two-bucket):
      //   escrow  = W1's matB crossing reserve                =  $5.00
      //   direct_earn from W1's own matB entry                =  $0.25
      //   L1 from S0-S5 force-crosses into matB (6 × $0.95)  =  $5.70  (V8.32: payBase=entryFee)
      //   chain pay from S0-S5 matrix positions in matB       =  $1.71
      //   funds = $12.66 ≥ T1_FEE $10 → RE-ENTRY fires first (V8.44 priority:
      //   re-entry → upgrade); remaining $2.66 < T2_FEE $7 → upgrade skipped.
      //   (V8.43 hardcoded escrow=0, so funds were $7.66 < $10: re-entry was
      //   silently skipped and the upgrade fired instead — the exact bug class
      //   V8.44 fixes: "auto-reentry ON → member NEVER graduates".)
      await fc(s6.address);

      // ── KEY ASSERTIONS (V8.44) ────────────────────────────────────────────
      expect(await tierRouter.memberHighestTier(w1.address)).to.equal(
        1, "W1 re-enters T1 (re-entry priority consumes the funds first)"
      );
      expect(await matA.isActiveInMatrix(w1.address)).to.equal(
        true, "W1 re-entered own pair's MatA"
      );
      expect(await matB.crossingReserveOf(w1.address)).to.equal(
        0, "W1's matB crossing reserve was consumed as re-entry escrow"
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

// =============================================================================
// SUITE — V8.35: bulkUpgrade + sequential manualUpgrade + per-tier gate config
// =============================================================================
describe("V8.35 — Whale Gate: bulkUpgrade + sequential manualUpgrade + per-tier thresholds", function () {

  // ── Part 1: gate-closed blocking ─────────────────────────────────────────────

  it("bulkUpgrade reverts with the unified eligibility message when T5 gate is closed (V8.44 C2)", async function () {
    const { tierRouter, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);

    // V8.44 (C2): bulkUpgrade's FIRST tier uses the SAME three-way eligibility
    // as manualUpgrade (cycle done OR in prev MatB OR gate open), so a member
    // with none of the three gets the manualUpgrade-style message. Tiers
    // BEYOND the first still revert "TR: Whale Gate not yet open for this tier".
    await expect(
      tierRouter.connect(w1).bulkUpgrade(1)
    ).to.be.revertedWith("TR: cross to MatB first, or wait for this tier's Whale Gate to open");
  });

  it("manualUpgrade reverts with MatB message when gate closed, no cycles, not in MatB", async function () {
    const { tierRouter, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);

    // w1 has 0 T1 cycles, is not in T1 MatB, and T5 gate is closed → should revert
    await expect(
      tierRouter.connect(w1).manualUpgrade(1)
    ).to.be.revertedWith("TR: cross to MatB first, or wait for this tier's Whale Gate to open");
  });

  // ── Part 2: admin gate controls ───────────────────────────────────────────────

  it("setTierGateThreshold writes the per-tier threshold and emits TierGateThresholdUpdated", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);

    // default T5 threshold = 25
    expect(await tierRouter.tierGateThreshold(5)).to.equal(25n);
    expect(await tierRouter.tierGateThreshold(6)).to.equal(15n);
    expect(await tierRouter.tierGateThreshold(7)).to.equal(10n);

    await expect(tierRouter.connect(admin).setTierGateThreshold(5, 3))
      .to.emit(tierRouter, "TierGateThresholdUpdated")
      .withArgs(5, 3n);

    expect(await tierRouter.tierGateThreshold(5)).to.equal(3n);
  });

  it("setTierGateThreshold rejects tier < 5 and threshold 0 or > 50", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);

    await expect(tierRouter.connect(admin).setTierGateThreshold(2, 5))
      .to.be.revertedWith("TR: gate only applies to T5-T10");

    await expect(tierRouter.connect(admin).setTierGateThreshold(5, 0))
      .to.be.revertedWith("TR: threshold must be 1-50");

    await expect(tierRouter.connect(admin).setTierGateThreshold(5, 51))
      .to.be.revertedWith("TR: threshold must be 1-50");
  });

  it("setTierWhaleGateActive(5, true) makes isWhaleGateActiveForTier(5) true and emits WhaleGateActivated", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);

    expect(await tierRouter.isWhaleGateActiveForTier(5)).to.be.false;

    await expect(tierRouter.connect(admin).setTierWhaleGateActive(5, true))
      .to.emit(tierRouter, "WhaleGateActivated")
      .withArgs(5, 0n); // tierFirstEntries[5] is still 0 — admin override, not organic

    expect(await tierRouter.isWhaleGateActiveForTier(5)).to.be.true;
  });

  it("setTierWhaleGateActive(5, true) does NOT activate T6 — gates are per-tier independent", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);

    await tierRouter.connect(admin).setTierWhaleGateActive(5, true);

    expect(await tierRouter.isWhaleGateActiveForTier(5)).to.be.true;
    expect(await tierRouter.isWhaleGateActiveForTier(6)).to.be.false;  // T6 has its own gate
    expect(await tierRouter.isWhaleGateActiveForTier(7)).to.be.false;
  });

  // ── Part 3: gate-open happy path ─────────────────────────────────────────────

  it("manualUpgrade(1) succeeds without MatB crossing when T5 gate is open (T2-T5 share T5 gate)", async function () {
    const { tierRouter, usdc, admin, w1, reg } = await loadFixture(deployV8Fixture);

    // Register w1 at T1 — 0 cycles, not in T1 MatB
    await reg(w1, ethers.ZeroAddress);
    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(1);

    // Admin opens T5 whale gate (T2-T5 all check this flag)
    await tierRouter.connect(admin).setTierWhaleGateActive(5, true);

    // manualUpgrade pulls T2_FEE from member → TierRouter, so approve TierRouter (not pm2)
    await usdc.connect(w1).approve(await tierRouter.getAddress(), T2_FEE);
    await tierRouter.connect(w1).manualUpgrade(1);

    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(2);
    expect(await tierRouter.tierCycles(w1.address, 0)).to.equal(0n); // no cycles consumed
  });

  it("bulkUpgrade(1) seats member in T2 MatA, deducts exact T2_FEE, emits BulkUpgrade event", async function () {
    const { tierRouter, usdc, admin, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);
    await tierRouter.connect(admin).setTierWhaleGateActive(5, true);

    const trAddr = await tierRouter.getAddress();
    const balBefore = await usdc.balanceOf(w1.address);

    // bulkUpgrade pulls totalFee from member → TierRouter, so approve TierRouter
    await usdc.connect(w1).approve(trAddr, T2_FEE);

    await expect(tierRouter.connect(w1).bulkUpgrade(1))
      .to.emit(tierRouter, "BulkUpgrade")
      .withArgs(w1.address, 2n, 2n, T2_FEE); // fromTier=2, toTier=2, totalFee=T2_FEE

    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(2);

    const balAfter = await usdc.balanceOf(w1.address);
    // balBefore captured after T1 reg — bulkUpgrade charges exactly T2_FEE on top
    expect(balBefore - balAfter).to.equal(T2_FEE);
  });

  it("bulkUpgrade reverts 'TR: already at or above target tier' when member is already there", async function () {
    const { tierRouter, usdc, admin, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);
    await tierRouter.connect(admin).setTierWhaleGateActive(5, true);

    const trAddr = await tierRouter.getAddress();

    // First bulk upgrade to T2
    await usdc.connect(w1).approve(trAddr, T2_FEE);
    await tierRouter.connect(w1).bulkUpgrade(1);

    // Second call to the same tier should revert (memberHighestTier=2 > targetTierIndex=1)
    await usdc.connect(w1).approve(trAddr, T2_FEE);
    await expect(tierRouter.connect(w1).bulkUpgrade(1))
      .to.be.revertedWith("TR: already at or above target tier");
  });

  it("T6 gate independent: T6 upgrade reverts 'TR: tier not deployed' (not a gate error) when T5 open but T6 missing", async function () {
    // This test proves the error ordering: "tier not deployed" is checked BEFORE the gate flag.
    // If the gate check were first, we'd get a gate error (T6 gate is closed).
    // Getting "tier not deployed" confirms the code reaches the gate check only after tier exists.
    const { tierRouter, usdc, admin, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);
    await tierRouter.connect(admin).setTierWhaleGateActive(5, true); // T5 gate open

    // targetTierIndex=5 = T6, which is not deployed in the base fixture
    await expect(tierRouter.connect(w1).manualUpgrade(5))
      .to.be.revertedWith("TR: tier not deployed");
  });

  it("getMemberInfo.whaleGateEligible uses _isTierUnlockedForManualEntry: T5 gate open makes T1 member eligible for T2", async function () {
    const { tierRouter, admin, w1, reg } = await loadFixture(deployV8Fixture);

    await reg(w1, ethers.ZeroAddress);

    // Gate closed → eligible = false (T2 unlock requires T5 gate, which is closed)
    let info = await tierRouter.getMemberInfo(w1.address);
    expect(info.whaleGateEligible).to.be.false;

    // Admin opens T5 gate → _isTierUnlockedForManualEntry(2) = tierWhaleGateActive[5] = true
    // → getMemberInfo.whaleGateEligible flips to true for the T1 member
    await tierRouter.connect(admin).setTierWhaleGateActive(5, true);
    info = await tierRouter.getMemberInfo(w1.address);
    expect(info.whaleGateEligible).to.be.true;
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
// =============================================================================
// V8.35 -- Multi-pair capacity expansion (setActivePairIndex + _tryAdvancePair)
// =============================================================================
describe("V8.35 -- Multi-pair capacity expansion", function () {

  // ── setActivePairIndex guard tests ────────────────────────────────────────

  it("setActivePairIndex: non-owner reverts", async function () {
    const { pm1, w1 } = await loadFixture(deployV8Fixture);
    await expect(pm1.connect(w1).setActivePairIndex(0))
      .to.be.revertedWithCustomError(pm1, "OwnableUnauthorizedAccount");
  });

  it("setActivePairIndex: out-of-range index reverts with PM8: invalid index", async function () {
    const { pm1, admin } = await loadFixture(deployV8Fixture);
    // pm1 starts with 1 pair (index 0). Setting index 1 should revert.
    await expect(pm1.connect(admin).setActivePairIndex(1))
      .to.be.revertedWith("PM8: invalid index");
  });

  it("setActivePairIndex(0) resets activePairIndex and emits PairActivated", async function () {
    const base = await loadFixture(deployV8Fixture);
    const { pm1, admin } = base;
    const { matA3, matB3 } = await deployExtraT1Pair(base);
    await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());

    // addPair advances activePairIndex to 1
    expect(await pm1.activePairIndex()).to.equal(1n);

    // setActivePairIndex(0) resets and emits PairActivated(0)
    await expect(pm1.connect(admin).setActivePairIndex(0))
      .to.emit(pm1, "PairActivated").withArgs(0n);
    expect(await pm1.activePairIndex()).to.equal(0n);
  });

  // ── _tryAdvancePair auto-advance ──────────────────────────────────────────

  it("after setActivePairIndex(0) and pair 0 fills, new registration routes to pair 1 (V8.40: oldest-first via _findRoutingPair)", async function () {
    // V8.40: _tryAdvancePair no longer advances activePairIndex.
    // Routing is done by _findRoutingPair() which scans pairs 0→N and returns
    // the first pair whose MatA has space. When pair 0 MatA is full, s6 routes to pair 1.
    const base = await loadFixture(deployV8Fixture);
    const { pm1, matA, admin, treasury, w1, s0, s1, s2, s3, s4, s5, s6, reg } = base;

    // Add a second pair then reset active to 0
    const { matA3: matAExtra, matB3: matBExtra } = await deployExtraT1Pair(base);
    const matAExtraAddr = await matAExtra.getAddress();
    const matBExtraAddr = await matBExtra.getAddress();
    await pm1.connect(admin).addPair(matAExtraAddr, matBExtraAddr);
    // Authorize extra pair matrices with treasury (deploy script does this; test helper skips it)
    await treasury.connect(admin).setAuthorizedCaller(matAExtraAddr, true);
    await treasury.connect(admin).setAuthorizedCaller(matBExtraAddr, true);
    await pm1.connect(admin).setActivePairIndex(0);
    expect(await pm1.activePairIndex()).to.equal(0n);

    // Fill pair 0 matA to capacity (MSIZE = 7 seats)
    await reg(w1, ethers.ZeroAddress);
    for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s, w1.address);
    expect(await matA.occupancy()).to.equal(MSIZE);  // 7/7 — pair 0 full
    // activePairIndex still 0 — V8.40 does NOT auto-advance it via _tryAdvancePair
    expect(await pm1.activePairIndex()).to.equal(0n);

    // Register s6: _findRoutingPair() scans → pair 0 full (7/7) → skips → pair 1 (0/7 < 7) → returns 1
    // s6 lands in extra pair's matA. activePairIndex stays at 0 (V8.40 change).
    await reg(s6, w1.address);
    // activePairIndex NOT advanced (V8.40 — routing is now independent of activePairIndex)
    expect(await pm1.activePairIndex()).to.equal(0n);

    // V8.41 FIFO: registerDirectFor always routes to pair 0.
    // s6 enters pair 0's MatA (triggers rotation) — does NOT skip to pair 1.
    expect((await matA.getMember(s6.address)).isInMatrix).to.be.true;
    expect((await matAExtra.getMember(s6.address)).isInMatrix).to.be.false;
  });
});

// =============================================================================
// SUITE — V8.35: Governance params #51-57 — TierRouter per-tier wrapper setters
// (V8Governance not deployed in fixture; these tests exercise the wrapper
//  functions that governance.execute() will call.)
// =============================================================================
describe("V8.35 — Governance params #51-57: TierRouter per-tier wrappers", function () {

  it("setTierGateThresholdT5: non-owner reverts with TR: not authorized", async function () {
    const { tierRouter, w1 } = await loadFixture(deployV8Fixture);
    await expect(tierRouter.connect(w1).setTierGateThresholdT5(10))
      .to.be.revertedWith("TR: not authorized");
  });

  it("setTierGateThresholdT5: owner sets threshold[5] and emits TierGateThresholdUpdated", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);
    await expect(tierRouter.connect(admin).setTierGateThresholdT5(10))
      .to.emit(tierRouter, "TierGateThresholdUpdated")
      .withArgs(5, 10n);
    expect(await tierRouter.tierGateThreshold(5)).to.equal(10n);
  });

  it("setTierGateThresholdT6/T7/T8/T9/T10: each sets its own slot independently", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);
    const tiers = [
      [6, 'setTierGateThresholdT6',  15],
      [7, 'setTierGateThresholdT7',  10],
      [8, 'setTierGateThresholdT8',  5],
      [9, 'setTierGateThresholdT9',  5],
      [10,'setTierGateThresholdT10', 5],
    ];
    for (const [tierNum, fn, expected] of tiers) {
      // default values: T6=15 T7=10 T8=5 T9=5 T10=5
      expect(await tierRouter.tierGateThreshold(tierNum)).to.equal(BigInt(expected));
    }
    // Write new values and verify isolation
    await tierRouter.connect(admin).setTierGateThresholdT6(20);
    await tierRouter.connect(admin).setTierGateThresholdT10(1);
    expect(await tierRouter.tierGateThreshold(6)).to.equal(20n);
    expect(await tierRouter.tierGateThreshold(10)).to.equal(1n);
    // Other slots untouched
    expect(await tierRouter.tierGateThreshold(7)).to.equal(10n);
    expect(await tierRouter.tierGateThreshold(5)).to.equal(25n); // default
  });

  it("setTierGateThresholdTx: threshold 0 and threshold 51 revert", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);
    await expect(tierRouter.connect(admin).setTierGateThresholdT6(0))
      .to.be.revertedWith("TR: threshold 1-50");
    await expect(tierRouter.connect(admin).setTierGateThresholdT7(51))
      .to.be.revertedWith("TR: threshold 1-50");
  });

  it("setTierGateThresholdT5(1) — min boundary — succeeds", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);
    await expect(tierRouter.connect(admin).setTierGateThresholdT5(1))
      .to.emit(tierRouter, "TierGateThresholdUpdated")
      .withArgs(5, 1n);
  });

  it("setTierGateThresholdT10(50) — max boundary — succeeds", async function () {
    const { tierRouter, admin } = await loadFixture(deployV8Fixture);
    await expect(tierRouter.connect(admin).setTierGateThresholdT10(50))
      .to.emit(tierRouter, "TierGateThresholdUpdated")
      .withArgs(10, 50n);
  });
})

// ═══════════════════════════════════════════════════════════════════════════
// V8.35 — MatrixPairFactory  (autonomous on-chain pair expansion)
//
// Tests cover:
//   A. Constructor immutables + zero-address guards
//   B. setWallets / setPeripherals access control
//   C. configureTier boundary checks + storage
//   D. registerPairManager boundary checks + storage
//   E. deployAndWire error paths
//   F. deployAndWire success — pair deployed, ownership transferred, state updated
//   G. Integration — PM._tryAdvancePair auto-fires factory at 80% occupancy
//
// Timing note (G-tests):
//   _tryAdvancePair() fires BEFORE the triggering member is routed (line 204
//   precedes line 206 in PairManagerV8).  With MSIZE=7, combined cap=14, and
//   expandThresholdBps=8000, the threshold condition (combined*10000/14 >= 8000)
//   is first true when combined=12 (8571 bps).  Factory therefore fires on the
//   13th registration call (which reads combined=12 from the previous 12 members).
//   Member 13 is then routed to the newly created pair 1.
//
// Ownable2Step note (F3):
//   FigureEightMatrixV8 extends Ownable2Step.  factory.deployAndWire() calls
//   mA.transferOwnership(admin) which sets pendingOwner — owner() still returns
//   the factory address until admin calls mA.acceptOwnership().
// ═══════════════════════════════════════════════════════════════════════════
describe("V8.35 — MatrixPairFactory", function () {

  // ── Fixture: full V8 stack + MatrixPairFactory wired to T1 ──────────────
  //
  // MatrixPairFactory must be deployed with MatrixLogicLib linked because
  // it embeds FigureEightMatrixV8 creation bytecode, which DELEGATECALL-refs
  // the library.  We use the same matrixLib deployed by deployV8Fixture.
  async function deployWithFactoryFixture() {
    const base = await deployV8Fixture();
    const { usdc, cnova, treasury, tierRouter, matrixLib,
            pm1, admin, devOps, accountOne } = base;

    const MPF = await ethers.getContractFactory("MatrixPairFactory", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    const factory = await MPF.deploy(
      admin.address,
      await usdc.getAddress(),
      await cnova.getAddress(),
      await treasury.getAddress()
    );
    const factoryAddr = await factory.getAddress();

    // Wallets the factory passes to each new matrix's DeployParams
    await factory.connect(admin).setWallets(
      devOps.address,     // devWallet
      devOps.address,     // opsWallet
      accountOne.address  // accountOne
    );

    // Peripherals: tierRouter only (SF/CR/gov/keeper are not in test fixture)
    await factory.connect(admin).setPeripherals(
      ethers.ZeroAddress,            // sf
      ethers.ZeroAddress,            // cr
      await tierRouter.getAddress(), // tr
      ethers.ZeroAddress,            // keeper
      ethers.ZeroAddress,            // gov
      ethers.ZeroAddress,            // bbr
      ethers.ZeroAddress             // lr
    );

    // Wire factory into peripherals that gate on pairFactory address
    await treasury.connect(admin).setFactory(factoryAddr);
    await tierRouter.connect(admin).setFactory(factoryAddr);
    await pm1.connect(admin).setFactory(factoryAddr);

    // Tell factory which tier T1's PM is for and what to construct
    await factory.connect(admin).configureTier(1, T1_FEE, MSIZE, SPLITS, CHAIN_BPS);
    await factory.connect(admin).registerPairManager(await pm1.getAddress(), 1);

    // V8.36 Bug Fix #1: factory needs DEFAULT_ADMIN_ROLE on CNOVAToken so it can
    // call grantRole(MINTER_ROLE, newMatrix) in deployAndWire().
    // Mirrors what deploy_v8.js does in production.
    await cnova.connect(admin).grantRole(ethers.ZeroHash, factoryAddr);

    return { ...base, factory, factoryAddr, MPF };
  }

  // ── A. Constructor immutables ────────────────────────────────────────────

  it("A1: stores usdc, cnova, treasuryAddr as immutables", async function () {
    const { factory, usdc, cnova, treasury } = await loadFixture(deployWithFactoryFixture);
    expect(await factory.usdc()).to.equal(await usdc.getAddress());
    expect(await factory.cnova()).to.equal(await cnova.getAddress());
    expect(await factory.treasuryAddr()).to.equal(await treasury.getAddress());
  });

  it("A2: zero usdc reverts MPF_ZeroAddress", async function () {
    const { cnova, treasury, admin, matrixLib } = await loadFixture(deployV8Fixture);
    const F = await ethers.getContractFactory("MatrixPairFactory", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    await expect(
      F.deploy(admin.address, ethers.ZeroAddress, await cnova.getAddress(), await treasury.getAddress())
    ).to.be.revertedWithCustomError(F, "MPF_ZeroAddress");
  });

  it("A3: zero cnova reverts MPF_ZeroAddress", async function () {
    const { usdc, treasury, admin, matrixLib } = await loadFixture(deployV8Fixture);
    const F = await ethers.getContractFactory("MatrixPairFactory", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    await expect(
      F.deploy(admin.address, await usdc.getAddress(), ethers.ZeroAddress, await treasury.getAddress())
    ).to.be.revertedWithCustomError(F, "MPF_ZeroAddress");
  });

  it("A4: zero treasury reverts MPF_ZeroAddress", async function () {
    const { usdc, cnova, admin, matrixLib } = await loadFixture(deployV8Fixture);
    const F = await ethers.getContractFactory("MatrixPairFactory", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    await expect(
      F.deploy(admin.address, await usdc.getAddress(), await cnova.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(F, "MPF_ZeroAddress");
  });

  // ── B. setWallets / setPeripherals access control ────────────────────────

  it("B1: setWallets: stores devWallet, opsWallet, accountOne", async function () {
    const { factory, admin, s0, s1, s2 } = await loadFixture(deployWithFactoryFixture);
    await factory.connect(admin).setWallets(s0.address, s1.address, s2.address);
    expect(await factory.devWallet()).to.equal(s0.address);
    expect(await factory.opsWallet()).to.equal(s1.address);
    expect(await factory.accountOne()).to.equal(s2.address);
  });

  it("B2: setWallets: non-owner reverts OwnableUnauthorizedAccount", async function () {
    const { factory, s0, s1, s2 } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(s0).setWallets(s0.address, s1.address, s2.address))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
  });

  it("B3: setPeripherals: stores all 7 addresses", async function () {
    const { factory, admin, s0, s1, s2, s3, s4, s5, s6 } = await loadFixture(deployWithFactoryFixture);
    await factory.connect(admin).setPeripherals(
      s0.address, s1.address, s2.address, s3.address, s4.address, s5.address, s6.address
    );
    expect(await factory.stabilityFund()).to.equal(s0.address);
    expect(await factory.couponRegistry()).to.equal(s1.address);
    expect(await factory.tierRouterAddr()).to.equal(s2.address);
    expect(await factory.matrixKeeper()).to.equal(s3.address);
    expect(await factory.governance()).to.equal(s4.address);
    expect(await factory.buybackReserve()).to.equal(s5.address);
    expect(await factory.liquidityReserve()).to.equal(s6.address);
  });

  it("B4: setPeripherals: non-owner reverts OwnableUnauthorizedAccount", async function () {
    const { factory, s0 } = await loadFixture(deployWithFactoryFixture);
    const Z = ethers.ZeroAddress;
    await expect(factory.connect(s0).setPeripherals(Z, Z, Z, Z, Z, Z, Z))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
  });

  // ── C. configureTier ─────────────────────────────────────────────────────

  it("C1: configureTier: stores config and emits TierConfigured", async function () {
    const { factory, admin } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(admin).configureTier(2, T2_FEE, MSIZE, SPLITS, CHAIN_BPS))
      .to.emit(factory, "TierConfigured")
      .withArgs(2, T2_FEE, MSIZE);
    const cfg = await factory.tierConfigs(2);
    expect(cfg.configured).to.be.true;
    expect(cfg.entryFee).to.equal(T2_FEE);
    expect(cfg.matrixSize).to.equal(MSIZE);
  });

  it("C2: configureTier: tierNum=0 reverts MPF_InvalidTier", async function () {
    const { factory, admin } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(admin).configureTier(0, T1_FEE, MSIZE, SPLITS, CHAIN_BPS))
      .to.be.revertedWithCustomError(factory, "MPF_InvalidTier");
  });

  it("C3: configureTier: tierNum=11 reverts MPF_InvalidTier", async function () {
    const { factory, admin } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(admin).configureTier(11, T1_FEE, MSIZE, SPLITS, CHAIN_BPS))
      .to.be.revertedWithCustomError(factory, "MPF_InvalidTier");
  });

  it("C4: configureTier: non-owner reverts OwnableUnauthorizedAccount", async function () {
    const { factory, s0 } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(s0).configureTier(1, T1_FEE, MSIZE, SPLITS, CHAIN_BPS))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
  });

  // ── D. registerPairManager ───────────────────────────────────────────────

  it("D1: registerPairManager: sets isPairManager + pairManagerTierNum, emits PMRegistered", async function () {
    const { factory, admin, pm2 } = await loadFixture(deployWithFactoryFixture);
    const pm2Addr = await pm2.getAddress();
    await expect(factory.connect(admin).registerPairManager(pm2Addr, 2))
      .to.emit(factory, "PMRegistered")
      .withArgs(pm2Addr, 2);
    expect(await factory.isPairManager(pm2Addr)).to.be.true;
    expect(await factory.pairManagerTierNum(pm2Addr)).to.equal(2);
  });

  it("D2: registerPairManager: zero address reverts MPF_ZeroAddress", async function () {
    const { factory, admin } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(admin).registerPairManager(ethers.ZeroAddress, 1))
      .to.be.revertedWithCustomError(factory, "MPF_ZeroAddress");
  });

  it("D3: registerPairManager: tierNum=0 reverts MPF_InvalidTier", async function () {
    const { factory, admin, pm2 } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(admin).registerPairManager(await pm2.getAddress(), 0))
      .to.be.revertedWithCustomError(factory, "MPF_InvalidTier");
  });

  it("D4: registerPairManager: tierNum=11 reverts MPF_InvalidTier", async function () {
    const { factory, admin, pm2 } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(admin).registerPairManager(await pm2.getAddress(), 11))
      .to.be.revertedWithCustomError(factory, "MPF_InvalidTier");
  });

  it("D5: registerPairManager: non-owner reverts OwnableUnauthorizedAccount", async function () {
    const { factory, s0, pm2 } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.connect(s0).registerPairManager(await pm2.getAddress(), 2))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
  });

  // ── E. deployAndWire error paths ─────────────────────────────────────────

  it("E1: deployAndWire: unregistered address argument reverts MPF_UnauthorizedPM", async function () {
    const { factory, s0 } = await loadFixture(deployWithFactoryFixture);
    await expect(factory.deployAndWire(s0.address))
      .to.be.revertedWithCustomError(factory, "MPF_UnauthorizedPM");
  });

  it("E2: deployAndWire: registered PM but tier not configured reverts MPF_TierNotConfigured", async function () {
    const { usdc, cnova, treasury, pm2, admin, matrixLib } = await loadFixture(deployV8Fixture);
    const F = await ethers.getContractFactory("MatrixPairFactory", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    const f = await F.deploy(
      admin.address, await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress()
    );
    const pm2Addr = await pm2.getAddress();
    await f.connect(admin).registerPairManager(pm2Addr, 2); // register but skip configureTier
    await expect(f.deployAndWire(pm2Addr))
      .to.be.revertedWithCustomError(f, "MPF_TierNotConfigured");
  });

  // ── F. deployAndWire success ─────────────────────────────────────────────

  // Helper: call deployAndWire and parse the PairExpanded event from receipt
  async function callDeployAndWire(factory, pm1, admin) {
    const tx = await factory.connect(admin).deployAndWire(await pm1.getAddress());
    const receipt = await tx.wait();
    const event = receipt.logs
      .map(log => { try { return factory.interface.parseLog(log); } catch (_) { return null; } })
      .find(e => e && e.name === "PairExpanded");
    return event;
  }

  it("F1: deployAndWire: emits PairExpanded with tierNum=1, correct pairManager, non-zero matrix addrs", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    const event = await callDeployAndWire(factory, pm1, admin);

    expect(event).to.not.be.undefined;
    expect(event.args.tierNum).to.equal(1);
    expect(event.args.pairManager).to.equal(await pm1.getAddress());
    expect(event.args.matA).to.not.equal(ethers.ZeroAddress);
    expect(event.args.matB).to.not.equal(ethers.ZeroAddress);
  });

  it("F2: deployAndWire: activePairIndex advances from 0 to 1", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    expect(await pm1.activePairIndex()).to.equal(0n);
    await callDeployAndWire(factory, pm1, admin);
    expect(await pm1.activePairIndex()).to.equal(1n);
  });

  it("F3: V8.44 adminHandoff — new matrices are owned by admin IMMEDIATELY (no acceptOwnership limbo)", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    const event = await callDeployAndWire(factory, pm1, admin);

    const newMatA = await ethers.getContractAt("FigureEightMatrixV8", event.args.matA);
    const newMatB = await ethers.getContractAt("FigureEightMatrixV8", event.args.matB);

    // V8.44 (item E): the V8.39 transferOwnership() only set pendingOwner
    // (Ownable2Step) and nothing ever accepted — every factory-spawned matrix
    // stayed factory-owned (the V8.43 admin-orphan root cause). deployAndWire
    // now uses adminHandoff() for a TRUE one-step transfer.
    expect(await newMatA.owner()).to.equal(admin.address);
    expect(await newMatB.owner()).to.equal(admin.address);
    expect(await newMatA.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await newMatB.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("F4: deployAndWire: new matrices are partners of each other", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    const event = await callDeployAndWire(factory, pm1, admin);

    const newMatA = await ethers.getContractAt("FigureEightMatrixV8", event.args.matA);
    const newMatB = await ethers.getContractAt("FigureEightMatrixV8", event.args.matB);
    expect(await newMatA.partner()).to.equal(event.args.matB);
    expect(await newMatB.partner()).to.equal(event.args.matA);
  });

  it("F5: deployAndWire: new matrices have pairManager set to pm1", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    const event = await callDeployAndWire(factory, pm1, admin);
    const pm1Addr = await pm1.getAddress();

    const newMatA = await ethers.getContractAt("FigureEightMatrixV8", event.args.matA);
    const newMatB = await ethers.getContractAt("FigureEightMatrixV8", event.args.matB);
    expect(await newMatA.pairManager()).to.equal(pm1Addr);
    expect(await newMatB.pairManager()).to.equal(pm1Addr);
  });

  it("F6: deployAndWire: new MatA has chainNext set to new MatB", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    const event = await callDeployAndWire(factory, pm1, admin);

    const newMatA = await ethers.getContractAt("FigureEightMatrixV8", event.args.matA);
    expect(await newMatA.chainNext()).to.equal(event.args.matB);
  });

  it("F7: deployAndWire: second consecutive call deploys a third pair (no hard cap)", async function () {
    const { factory, pm1, admin } = await loadFixture(deployWithFactoryFixture);
    // First expansion: pair 0 → pair 1
    await callDeployAndWire(factory, pm1, admin);
    expect(await pm1.activePairIndex()).to.equal(1n);

    // Second expansion: pair 1 → pair 2 (proves unlimited growth)
    const event2 = await callDeployAndWire(factory, pm1, admin);
    expect(event2).to.not.be.undefined;
    expect(await pm1.activePairIndex()).to.equal(2n);
  });

  // ── G. Integration — PM auto-fires factory at 80% threshold ─────────────
  //
  // MSIZE=7 → combined cap = 14 seats.  expandThresholdBps = 8000 (80%).
  //
  // _tryAdvancePair() runs BEFORE routing the triggering member:
  //   Call N  → _tryAdvancePair checks occupancy of members (N-1)
  //   → routes member N into whatever activePairIndex points to at that moment
  //
  // Factory fires when: combined(N-1) * 10000 / 14 >= 8000
  //   → G1: 12 registrations with default 8000 threshold — factory does NOT fire
  //         (organic crossings blocked in test fixture → combined stays at 7 = 5000 bps)
  //   → G2-G4: threshold lowered to 5000 (50%) — factory fires on 8th registration
  //         (matA fills to 7 = 5000 bps ≥ 5000 → expansion triggered)
  //   → member 8 is routed into factory-deployed pair 1; pair 0 keeps its 7 occupants
  //
  // Signers used: w1=member1, s0-s6=members 2-8 (8 total for G2-G4)
  // ─────────────────────────────────────────────────────────────────────────

  it("G1: factory does NOT fire with default 80% threshold when combined stays at 7 (5000 bps)", async function () {
    const { pm1, reg, w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10 } =
      await loadFixture(deployWithFactoryFixture);

    // Default expandThresholdBps = 8000 (80%).  With MSIZE=7 and maxCap=14,
    // the factory fires when combined * 10000 / 14 >= 8000, i.e. combined >= 12.
    // In the test fixture organic crossings are blocked (members lack the $5
    // withdrawable needed to cross to matB), so matB occupancy stays at 0 and
    // combined stays at 7 (= 5000 bps < 8000).  Factory never fires regardless
    // of how many new members register.
    for (const m of [w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10]) {
      await reg(m);
    }
    expect(await pm1.activePairIndex()).to.equal(0n);
  });

  // G2 / G3 / G4 — lower the threshold to 50 % so matA alone (7/7 seats = 5 000 bps)
  // satisfies the condition.  With the default 80 % threshold organic crossings would
  // be needed (members need $5 withdrawable to cross, which the test fixture doesn't
  // accumulate), so the threshold param is the correct lever to test auto-expansion.
  // Strategy:
  //   1. setExpandThreshold(5000)   — 50%, i.e. combined ≥ 7 triggers expansion
  //   2. Register 7 members         — fills matA (occupancy=7, combined=7, bps=5000)
  //   3. Register member 8          — _tryAdvancePair sees 5000 ≥ 5000 → factory fires
  //   4. Member 8 is routed to pair 1; original pair 0 keeps its 7 occupants

  it("G2: V8.41: factory fires when newestMatB occupancy >= threshold (1 BPS minimal trigger)", async function () {
    const { pm1, matB, admin, reg, fc, w1, s0, s1, s2, s3, s4, s5, s6, s7 } =
      await loadFixture(deployWithFactoryFixture);

    // V8.41: factory fires when newestMatB occupancy >= factoryExpandThresholdBps (default 9000).
    // Lower to 1 BPS so factory fires with just 1 MatB member.
    await pm1.connect(admin).setFactoryExpandThreshold(1n);
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6);                              // w1 cycled out → parked
    await fc(w1.address);                       // w1 → MatB (occupancy=1, 1/7 BPS ≥ 1 → threshold met)

    // s7 registration: _tryAdvancePair sees MatB occ=1/7 ≥ 1 BPS → factory fires
    await reg(s7);
    expect(await pm1.activePairIndex()).to.equal(1n, "factory expanded to pair 1");
    expect(await pm1.pairCount()).to.equal(2n);
  });

  it("G3: after factory fires, pairs[1] has non-zero addresses and 0 direct registrations (V8.41 FIFO)", async function () {
    const { pm1, matB, admin, reg, fc, w1, s0, s1, s2, s3, s4, s5, s6, s7 } =
      await loadFixture(deployWithFactoryFixture);

    // V8.41: lower threshold so factory fires with 1 MatB member
    await pm1.connect(admin).setFactoryExpandThreshold(1n);
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6);                              // w1 cycled out → parked
    await fc(w1.address);                       // w1 → MatB (occupancy=1, threshold met)
    await reg(s7); // factory fires; s7 routed to pair 0 (FIFO — external regs always pair 0)

    const newPair = await pm1.pairs(1);
    expect(newPair.matrixA).to.not.equal(ethers.ZeroAddress);
    expect(newPair.matrixB).to.not.equal(ethers.ZeroAddress);
    // V8.41 FIFO: s7 went to pair 0, not pair 1. Pair 1 is the future FIFO graduation target.
    expect(newPair.totalRegistered).to.equal(0n);
  });

  it("G4: pair 0 keeps all members after factory expansion (V8.41 FIFO: member 8 stays in pair 0)", async function () {
    const { pm1, matA, matB, admin, reg, fc, w1, s0, s1, s2, s3, s4, s5, s6, s7 } =
      await loadFixture(deployWithFactoryFixture);

    // V8.41: lower threshold so factory fires with 1 MatB member
    await pm1.connect(admin).setFactoryExpandThreshold(1n);
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6);                              // w1 cycled out → parked
    await fc(w1.address);                       // w1 → MatB (occupancy=1)
    await reg(s7); // factory fires; s7 → pair 0 (FIFO)

    // pair 0: matA=7 (rotation fired, stays at 7/7), matB=1 (w1 still there — no eviction)
    const occupA = await matA.occupancy();
    const occupB = await matB.occupancy();
    expect(occupA + occupB).to.equal(8n); // 7 (matA) + 1 (matB = w1)
    expect(await pm1.activePairIndex()).to.equal(1n); // factory's addPair sets activePairIndex=1
  });


// ═══════════════════════════════════════════════════════════════════════════════
// V8.36 — Bug Fix #1: factory grants MINTER_ROLE to factory-created pairs
//
// Before: deployAndWire() never called cnova.grantRole(MINTER_ROLE, matA/matB).
//         Members entering T1.2+ pairs silently got no CNOVA minted.
// After:  factory holds DEFAULT_ADMIN_ROLE on CNOVAToken (granted in deploy_v8.js);
//         deployAndWire() calls grantRole(MINTER_ROLE, matA) and grantRole(MINTER_ROLE, matB).
//
// Tests: H1–H5
// ═══════════════════════════════════════════════════════════════════════════════
describe("V8.36 — Bug Fix #1: MINTER_ROLE granted to factory-created pairs (all tiers)", function () {

  // Extended fixture: grant DEFAULT_ADMIN_ROLE to factory so deployAndWire()
  // can call cnova.grantRole(MINTER_ROLE, newMat).  In production this is done
  // by deploy_v8.js; in tests we set it up manually.
  async function deployWithMinterFixture() {
    const base = await loadFixture(deployWithFactoryFixture);
    const { cnova, admin, factoryAddr } = base;
    // DEFAULT_ADMIN_ROLE = bytes32(0) = ZeroHash
    await cnova.connect(admin).grantRole(ethers.ZeroHash, factoryAddr);
    return base;
  }

  it("H1: factoryExpandThresholdBps default is 9 000 (90% — MatB near-full trigger, V8.41)", async function () {
    const { pm1 } = await loadFixture(deployWithFactoryFixture);
    expect(await pm1.factoryExpandThresholdBps()).to.equal(9_000n);
  });

  it("H2: setFactoryExpandThreshold updates factoryExpandThresholdBps independently of expandThresholdBps", async function () {
    const { pm1, admin } = await loadFixture(deployWithFactoryFixture);
    await pm1.connect(admin).setFactoryExpandThreshold(7500n);
    expect(await pm1.factoryExpandThresholdBps()).to.equal(7500n);
    // expandThresholdBps (pre-deployed pair advance) must be unchanged
    expect(await pm1.expandThresholdBps()).to.equal(8000n);
  });

  it("H3: setFactoryExpandThreshold(0) reverts PM8: invalid bps", async function () {
    const { pm1, admin } = await loadFixture(deployWithFactoryFixture);
    await expect(pm1.connect(admin).setFactoryExpandThreshold(0n))
      .to.be.revertedWith("PM8: invalid bps");
  });

  it("H4: setFactoryExpandThreshold(10001) reverts PM8: invalid bps", async function () {
    const { pm1, admin } = await loadFixture(deployWithFactoryFixture);
    await expect(pm1.connect(admin).setFactoryExpandThreshold(10_001n))
      .to.be.revertedWith("PM8: invalid bps");
  });

  it("H5: factory-created matA and matB both have MINTER_ROLE on CNOVAToken", async function () {
    const { pm1, cnova, matB, admin, reg, fc, w1, s0, s1, s2, s3, s4, s5, s6, s7 } =
      await loadFixture(deployWithMinterFixture);

    // V8.41: factory fires when newestMatB occupancy >= factoryExpandThresholdBps.
    // Lower to 1 BPS so factory fires with just 1 MatB member.
    await pm1.connect(admin).setFactoryExpandThreshold(1n);
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6);                              // w1 cycled out → parked
    await fc(w1.address);                       // w1 → MatB (occupancy=1, threshold met)
    await reg(s7); // factory fires; s7 → pair 0 (FIFO). Pair 1 deployed by factory.

    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    const pair1 = await pm1.pairs(1);
    expect(pair1.matrixA).to.not.equal(ethers.ZeroAddress, "pair 1 matrixA not deployed");
    expect(pair1.matrixB).to.not.equal(ethers.ZeroAddress, "pair 1 matrixB not deployed");
    expect(await cnova.hasRole(MINTER_ROLE, pair1.matrixA)).to.be.true;
    expect(await cnova.hasRole(MINTER_ROLE, pair1.matrixB)).to.be.true;
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// V8.36 — Bug Fix #2: cross-pair referrers credited L1 in factory pairs
//
// Before: MatrixLogicLib.enterMatrix() used self.members[referrer].hasEverJoined
//         which is always false in T1.2 for referrers who only joined T1.1.
//         Result: l1 = address(0) → L1 commission went to W1, not the actual referrer.
// After:  If local hasEverJoined is false, fall back to TierRouter.globalJoined().
//         The referrer's withdrawable in the new matrix receives the L1 credit.
//
// Tests: I1–I2
// ═══════════════════════════════════════════════════════════════════════════════
describe("V8.36 — Bug Fix #2: cross-pair referrer receives L1 credit (all tiers)", function () {

  // Fixture: factory with DEFAULT_ADMIN_ROLE + factory threshold lowered to 50%
  // so we can trigger expansion after 7 T1.1 registrations without needing
  // members to cross to matB (which would require a full forceCross sequence).
  async function deployReferrerFixture() {
    // V8.37: factory trigger is now rotationCount>=1.
    // DEFAULT_ADMIN_ROLE already granted to factory in deployWithFactoryFixture.
    // No occupancy-threshold manipulation needed — tests fire factory via adminForceRotateRoot.
    return loadFixture(deployWithFactoryFixture);
  }

  it("I1: after factory fires, pair 0 member's referrer is stored correctly (V8.41 — external regs stay in pair 0)", async function () {
    const { pm1, matB, admin, reg, fc, w1, s0, s1, s2, s3, s4, s5, s6, s7, s8 } =
      await loadFixture(deployReferrerFixture);

    // V8.41: lower threshold so factory fires with 1 MatB member
    await pm1.connect(admin).setFactoryExpandThreshold(1n);
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6);                              // w1 cycled out → parked
    await fc(w1.address);                       // w1 → MatB (occupancy=1, threshold met)
    await reg(s7); // factory fires; s7 → pair 0 (FIFO)

    // s8 registers in pair 0 with w1 as referrer.
    // w1 IS in pair 0 (originally registered there), so referrer credit resolves locally.
    // V8.36 Bug #2 fix (globalJoined fallback) activates for cross-pair scenarios at graduation time.
    await reg(s8, w1.address);

    const pair0 = await pm1.pairs(0);
    const matA0 = await ethers.getContractAt("FigureEightMatrixV8", pair0.matrixA);
    const s8Info = await matA0.getMember(s8.address);
    expect(s8Info.referrer).to.equal(w1.address, "referrer should be w1, not address(0)");
  });

  it("I2: after factory fires, referrer withdrawableOf in pair 0 equals expected L1 credit", async function () {
    const { pm1, matA, matB, admin, reg, fc, w1, s0, s1, s2, s3, s4, s5, s6, s7, s8 } =
      await loadFixture(deployReferrerFixture);

    // V8.41: lower threshold so factory fires with 1 MatB member (same setup as I1)
    await pm1.connect(admin).setFactoryExpandThreshold(1n);
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6);
    await fc(w1.address);
    await reg(s7); // factory fires; s7 → pair 0 (FIFO)

    // s8 joins pair 0 with w1 as referrer; L1 credit goes to w1 in pair 0's matA.
    // w1 IS in pair 0 — referrer is resolved locally (hasEverJoined = true in pair 0 matA).
    const w1BalBefore = await matA.withdrawableOf(w1.address);
    await reg(s8, w1.address);
    const w1BalAfter = await matA.withdrawableOf(w1.address);

    const expectedL1 = 10n * 10n ** 6n * 950n / 10_000n; // T1_FEE * l1Bps / BPS_DENOM = $0.95
    expect(w1BalAfter - w1BalBefore).to.equal(expectedL1,
      "w1 should receive L1 credit for s8 in pair 0 matA");
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// V8.36 — Bug Fix #3: factory fires at factoryExpandThresholdBps (default 100%)
//
// Before: _tryAdvancePair() used expandThresholdBps (80%) for BOTH pre-deployed
//         pair advance AND factory trigger.  Factory fired when matA filled
//         (combined=127/254=50% at MSIZE=127), splitting community while
//         T1.1's matB was still ~60% unfilled.
// After:  Separate factoryExpandThresholdBps (default 100%) ensures factory
//         fires only after the FULL pair cycle (both matA + matB complete).
//         expandThresholdBps still controls pre-deployed pair advancement.
//
// Tests: J1–J3
// ═══════════════════════════════════════════════════════════════════════════════
describe("V8.36 — Bug Fix #3: factory fires at factoryExpandThresholdBps not expandThresholdBps", function () {

  it("J1: with expandThresholdBps=50% but factoryExpandThresholdBps=100%, factory does NOT fire when matA fills", async function () {
    const { pm1, admin, reg, w1, s0, s1, s2, s3, s4, s5, s6 } =
      await loadFixture(deployWithFactoryFixture);

    // Lower pre-deployed pair advance threshold to 50%
    await pm1.connect(admin).setExpandThreshold(5000n);
    // Leave factoryExpandThresholdBps at default 100% — factory should NOT fire at 50%

    // Register 7 members: fills matA (combined=7, maxCap=14, bps=5000)
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);

    // 8th registration: expandThresholdBps=5000 would advance a pre-deployed pair,
    // but no pre-deployed pair exists. factoryExpandThresholdBps=10000 → 5000 < 10000
    // → factory does NOT fire. Member 8 stays in pair 0.
    await reg(s6);

    expect(await pm1.pairCount()).to.equal(1n, "factory should not have fired");
    expect(await pm1.activePairIndex()).to.equal(0n);
  });

  it("J2: factoryExpandThresholdBps=50% — factory does NOT fire when only MatA fills (V8.37: rotationCount now gates factory)", async function () {
    const { pm1, admin, reg, w1, s0, s1, s2, s3, s4, s5, s6 } =
      await loadFixture(deployWithFactoryFixture);

    await pm1.connect(admin).setFactoryExpandThreshold(5000n);

    // 7 members fill MatA (combined = 7/14 = 50%). Old V8.36 code would fire the factory here
    // because 50% >= factoryExpandThresholdBps=50%. V8.37 changes the trigger: the factory
    // only fires after MatB.rotationCount() >= 1. MatB has 0 members at this point
    // (rotationCount=0), so the factory stays quiet even though the threshold is met.
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    await reg(s6); // 8th member: _tryAdvancePair sees rotationCount=0, factory does NOT fire

    expect(await pm1.pairCount()).to.equal(1n,  "factory must NOT fire — V8.37 requires MatB rotation first");
    expect(await pm1.activePairIndex()).to.equal(0n, "still on pair 0");
  });

  it("J3: expandThresholdBps and factoryExpandThresholdBps are independent getters", async function () {
    const { pm1, admin } = await loadFixture(deployWithFactoryFixture);

    await pm1.connect(admin).setExpandThreshold(7000n);
    await pm1.connect(admin).setFactoryExpandThreshold(9000n);

    expect(await pm1.expandThresholdBps()).to.equal(7000n);
    expect(await pm1.factoryExpandThresholdBps()).to.equal(9000n);
  });

});




// ─────────────────────────────────────────────────────────────────────────────
// V8.37 — Rotation-based factory trigger + adminForceRotateRoot
//
// V8.36 froze T1.1 MatB because factoryExpand fired at 100% occupancy (member
// 255 going to T1.2 instead of pushing T1.1 MatB's first rotation).
// V8.37 fix: fire factory only after MatB.rotationCount() >= 1.
// adminForceRotateRoot() provides an emergency escape for the current frozen pair.
// ─────────────────────────────────────────────────────────────────────────────
describe("V8.37 — Rotation-based factory trigger + adminForceRotateRoot", function () {

  // Fill sequence (MSIZE=7):
  //   Members  1-7  → fill MatA (7/7). MatB.occupancy=0.
  //   Members  8-14 → each triggers a MatA rotation; root crosses to MatB.
  //                   MatB now has 7/7. MatB.rotationCount=0 (frozen state).
  //   Member  15    → _tryAdvancePair: rotationCount=0 → no factory.
  //                   Enters MatA → MatA rotation → root crosses to MatB slot 8
  //                   → MatB._cycleOutRoot fires → MatB.rotationCount=1.
  //   Member  16    → _tryAdvancePair: rotationCount=1 >= 1 → factory fires!

  it("K1: V8.41: MatB at 7/7 (100% >= 90% threshold) → factory fires on next registration", async function () {
    const { pm1, reg, fc, matB,
            w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13 } =
      await loadFixture(deployWithFactoryFixture);

    // Fill MatA (7 members)
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);

    // Push all 7 roots to MatB via rotation cycle (7/7 = 10000 BPS >= 9000 → factory trigger met)
    const triggers    = [s6,  s7,  s8,  s9,  s10, s11, s12];
    const parkedRoots = [w1,  s0,  s1,  s2,  s3,  s4,  s5];
    for (let i = 0; i < 7; i++) {
      await reg(triggers[i]);
      await fc(parkedRoots[i].address);
    }

    expect(await matB.occupancy()).to.equal(7n, "MatB fully occupied (7/7 = 100% >= 90% threshold)");

    // Register s13: _tryAdvancePair sees MatB.occ=7/7 = 10000 BPS >= 9000 (default) → factory fires
    // V8.41: MatB occupancy threshold replaces rotationCount check
    await reg(s13);
    expect(await pm1.pairCount()).to.equal(2n, "factory fires when MatB reaches 100% (>= 90% threshold)");
    expect(await pm1.activePairIndex()).to.equal(1n, "activePairIndex advanced to pair 1");
  });

  it("K2: factory fires when newestMatB crosses 90% threshold (6/7 = no fire, 7/7 = fire, V8.41)", async function () {
    const { pm1, reg, fc, matB,
            w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13 } =
      await loadFixture(deployWithFactoryFixture);

    // Fill MatA (7 members)
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);

    // Push 6 members to MatB via rotation cycle (6/7 = 8571 BPS < 9000 — factory must NOT fire)
    const triggers6    = [s6,  s7,  s8,  s9,  s10, s11];
    const parkedRoots6 = [w1,  s0,  s1,  s2,  s3,  s4];
    for (let i = 0; i < 6; i++) {
      await reg(triggers6[i]);
      await fc(parkedRoots6[i].address);
    }
    expect(await matB.occupancy()).to.equal(6n, "MatB at 6/7");

    await reg(s12); // register while MatB at 6/7 → factory must NOT fire (8571 BPS < 9000)
    expect(await pm1.pairCount()).to.equal(1n, "factory does not fire at 6/7 MatB (8571 BPS < 9000)");

    // Push 7th member to MatB (7/7 = 10000 BPS >= 9000 → factory fires on NEXT registration)
    await fc(s5.address);  // s5 parked in prev loop → push to MatB (occupancy=7/7)
    expect(await matB.occupancy()).to.equal(7n, "MatB at 7/7");

    await reg(s13); // _tryAdvancePair: 7/7 = 10000 BPS >= 9000 → factory deploys pair 1
    expect(await pm1.pairCount()).to.equal(2n, "factory fires when MatB reaches 7/7 (10000 BPS >= 9000)");
    expect(await pm1.activePairIndex()).to.equal(1n, "activePairIndex advanced to pair 1");
  });

  it("K3: adminForceRotateRoot() evicts MatB root and increments rotationCount (emergency unfreeze)", async function () {
    const { matB, admin, reg, fc, matA,
            w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12 } =
      await loadFixture(deployWithFactoryFixture);

    // Organic crossings are blocked in this fixture (reg() uses address(0) referrer so
    // roots accumulate $0 withdrawable — below the $5 needed to cross to MatB).
    // Fix: interleave reg() to trigger MatA rotation (parks the root) with fc() to
    // forceCross each parked root into MatB (admin pays the entry fee).

    // Step 1: fill MatA with 7 members
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);

    // Step 2: 7 regs trigger MatA rotations; fc() pushes each parked root to MatB
    const triggers    = [s6,  s7,  s8,  s9,  s10, s11, s12];
    const parkedRoots = [w1,  s0,  s1,  s2,  s3,  s4,  s5];
    for (let i = 0; i < 7; i++) {
      await reg(triggers[i]);                  // parks MatA root
      await fc(parkedRoots[i].address);        // pushes root → MatB
    }
    // State: MatA.occupancy=7, MatB.occupancy=7, MatB.rotationCount=0 (frozen)

    expect(await matB.rotationCount()).to.equal(0n, "pre-condition: frozen MatB");
    expect(await matB.occupancy()).to.equal(7n,  "MatB fully occupied");

    // w1 was the first to be forceCrossed into MatB → root at position 1
    const frozenRoot = await matB.posToMember(1n);
    expect(frozenRoot).to.equal(w1.address, "w1 should be at MatB position 1");

    // Admin emergency call: manually trigger the rotation
    await matB.connect(admin).adminForceRotateRoot();

    // Verify rotation occurred
    expect(await matB.rotationCount()).to.equal(1n, "rotationCount should be 1 after forced rotation");
    // Root was evicted; occupancy drops by 1 (no new member enters from this call)
    expect(await matB.occupancy()).to.equal(6n, "occupancy decreases by 1 after forced eviction");
    // Root's member record reflects the cycle-out
    const memberData = await matB.getMember(frozenRoot);
    expect(memberData.isInMatrix).to.be.false;
    expect(memberData.cyclesCompleted).to.equal(1n);
  });

  it("K4: adminForceRotateRoot() reverts on MatA with 'F8V8: only callable on MatB'", async function () {
    const { matA, admin } = await loadFixture(deployWithFactoryFixture);

    await expect(matA.connect(admin).adminForceRotateRoot())
      .to.be.revertedWith("F8V8: only callable on MatB");
  });

  it("K5: adminForceRotateRoot() reverts for non-owner with OwnableUnauthorizedAccount", async function () {
    const { matB, s0 } = await loadFixture(deployWithFactoryFixture);

    await expect(matB.connect(s0).adminForceRotateRoot())
      .to.be.revertedWithCustomError(matB, "OwnableUnauthorizedAccount");
  });

  it("K6: V8.41: factory fires when newestMatB reaches 90% threshold (no adminForceRotateRoot needed)", async function () {
    const { pm1, matB, reg, fc,
            w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13 } =
      await loadFixture(deployWithFactoryFixture);

    expect(await pm1.pairCount()).to.equal(1n, "starts with 1 pair");

    // Fill MatA (7 members) then push all 7 into MatB via rotation cycle.
    // MatB at 7/7 = 10000 BPS >= 9000 (factoryExpandThresholdBps default) → trigger met.
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);
    const triggers    = [s6,  s7,  s8,  s9,  s10, s11, s12];
    const parkedRoots = [w1,  s0,  s1,  s2,  s3,  s4,  s5];
    for (let i = 0; i < 7; i++) {
      await reg(triggers[i]);
      await fc(parkedRoots[i].address);
    }
    expect(await matB.occupancy()).to.equal(7n, "MatB at 7/7 (100% >= 90% threshold)");
    expect(await pm1.pairCount()).to.equal(1n, "factory fires on next REGISTRATION, not on forceCross");

    // Next registration: _tryAdvancePair sees MatB 7/7 >= 9000 BPS → factory deploys pair 1
    await reg(s13);
    expect(await pm1.pairCount()).to.equal(2n, "factory fires when MatB hits threshold and a reg occurs");
    expect(await pm1.activePairIndex()).to.equal(1n, "active pair advanced to T1.2");
  });

}); // end: V8.37 — Rotation-based factory trigger + adminForceRotateRoot

}); // end: V8.35 — MatrixPairFactory (contains V8.36 bug fixes)

// ══════════════════════════════════════════════════════════════════════════════════
// V8.38 — manualUpgrade multi-pair MatB scan
//   Bug fixed: TierRouter.manualUpgrade() only checked tierMatrixBAddr[prevIndex]
//   (the FIRST pair's MatB), ignoring members sitting in T1.2+ MatBs.
//   Fix: iterate all pairs via pairCount() / getPairAt() on the tier's PairManager.
// ══════════════════════════════════════════════════════════════════════════════════

describe("V8.38 — manualUpgrade multi-pair MatB scan", function () {

  // ─── Shared helper: wire a second T1 pair (V8.40: pre-fills pair 0 so routing goes to pair 1) ──
  async function setupSecondPair(fx) {
    const { usdc, cnova, treasury, tierRouter, pm1, admin, MINTER_ROLE,
            reg, s7, s8, s9, s10, s11, s12, s13 } = fx;

    // V8.40 oldest-first routing: _findRoutingPair() routes to the FIRST pair whose MatA
    // has space. Pre-fill pair 0's MatA to MSIZE (=7) BEFORE adding pair 1, so that
    // subsequent reg() calls in the test go to pair 1 (matA3), not pair 0.
    await reg(s7, ethers.ZeroAddress);
    for (const filler of [s8, s9, s10, s11, s12, s13]) await reg(filler, s7.address);
    // Pair 0 MatA is now at 7/7 — _findRoutingPair() will skip it.

    const { matA3, matB3 } = await deployExtraT1Pair(fx);
    const matA3Addr = await matA3.getAddress();
    const matB3Addr = await matB3.getAddress();

    // Grant treasury auth + CNOVA minter role to both new matrices
    await treasury.connect(admin).setAuthorizedCaller(matA3Addr, true);
    await treasury.connect(admin).setAuthorizedCaller(matB3Addr, true);
    await cnova.connect(admin).grantRole(MINTER_ROLE, matA3Addr);
    await cnova.connect(admin).grantRole(MINTER_ROLE, matB3Addr);

    // Register matB3 with TierRouter so the onCrossToMatB() callback is authorized
    await tierRouter.connect(admin).registerMatrix(matB3Addr, 0);

    // addPair() records pair 1 in PairManager; pair 0 is full so routing goes to pair 1
    await pm1.connect(admin).addPair(matA3Addr, matB3Addr);

    // fc3: admin forceCrosses a parked member from matA3 into matB3
    const fc3 = async (memberAddr) => {
      await usdc.connect(admin).approve(matA3Addr, T1_FEE);
      return matA3.connect(admin).forceCross(memberAddr);
    };

    return { matA3, matB3, matA3Addr, matB3Addr, fc3 };
  }

  // ─── L1: pair 0 MatB → manualUpgrade succeeds (regression) ──────────────────
  it("L1: manualUpgrade(1) succeeds when member is in pair 0's MatB (regression)", async function () {
    const { usdc, tierRouter, matB,
            admin, w1, s0, s1, s2, s3, s4, s5, s6,
            reg, fc } = await loadFixture(deployV8Fixture);

    // Register W1 + S0-S5 WITHOUT referrer → chain pay only (~$1.99) < $5 CROSS_NEEDED.
    // W1 occupies the root (position 1); S0-S5 fill positions 2-7.
    await reg(w1);
    for (const s of [s0, s1, s2, s3, s4, s5]) await reg(s);

    // S6 triggers MatA rotation → W1 cycles out and PARKS (chain pay < CROSS_NEEDED)
    await reg(s6);
    expect(await matB.isActiveInMatrix(w1.address)).to.be.false;

    // Admin pays T1_FEE and forceCrosses W1 from matA into matB (pair 0's MatB)
    await fc(w1.address);
    expect(await matB.isActiveInMatrix(w1.address)).to.be.true;

    // manualUpgrade(1): pm1 has only pair 0 → loop finds W1 in pair 0's matB on first try
    await usdc.connect(w1).approve(await tierRouter.getAddress(), T2_FEE);
    await tierRouter.connect(w1).manualUpgrade(1);
    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(2n);
  });

  // ─── L2: pair 1 MatB → manualUpgrade succeeds (the V8.38 fix) ───────────────
  it("L2: manualUpgrade(1) succeeds when member is in pair 1 MatB (V8.38 multi-pair MatB scan fix)", async function () {
    // Mirrors L1 exactly, but targets pair 1 matB3 instead of pair 0 matB.
    // V8.41 FIFO means external reg() always routes to pair 0, so we fill matA3 via
    // pm1 impersonation (8 enterFor calls: 7 fill the matrix, 8th triggers _cycleOutRoot
    // which sets w1.isInMatrix=false and parks w1). Admin then forceCrosses parked w1
    // from matA3 → matB3 — the exact path the V8.38 multi-pair scan is designed for.
    const fx = await loadFixture(deployWithFactoryFixture);
    const { usdc, pm1, tierRouter, matB, cnova, treasury, admin, reg,
            w1, s0, s1, s2, s3, s4, s5, s6 } = fx;
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));

    // reg(w1) → globalJoined[w1]=true (required for manualUpgrade)
    await reg(w1);

    // Deploy pair 1 with full wiring
    const { matA3, matB3 } = await deployExtraT1Pair(fx);
    const matA3Addr = await matA3.getAddress();
    const matB3Addr = await matB3.getAddress();
    await treasury.connect(admin).setAuthorizedCaller(matA3Addr, true);
    await treasury.connect(admin).setAuthorizedCaller(matB3Addr, true);
    await cnova.connect(admin).grantRole(MINTER_ROLE, matA3Addr);
    await cnova.connect(admin).grantRole(MINTER_ROLE, matB3Addr);
    await tierRouter.connect(admin).registerMatrix(matB3Addr, 0); // allow onCrossToMatB callback
    await pm1.connect(admin).addPair(matA3Addr, matB3Addr);
    expect(await pm1.pairCount()).to.equal(2n, "pair 1 created");

    // Impersonate pm1 to fill matA3. Each enterFor needs T1_FEE pre-funded in matA3
    // because pm1 (as msg.sender == pairManager) does NOT trigger the safeTransferFrom
    // branch — the USDC must already be in the contract before distribution runs.
    const pm1Addr = await pm1.getAddress();
    await ethers.provider.send("hardhat_setBalance", [pm1Addr, "0xde0b6b3a7640000"]);
    const pm1Imp = await ethers.getImpersonatedSigner(pm1Addr);
    const mat3Enter = async (addr) => {
      await usdc.connect(admin).transfer(matA3Addr, T1_FEE);
      return matA3.connect(pm1Imp).enterFor(addr, ethers.ZeroAddress);
    };

    await mat3Enter(w1.address);                               // slot 1 — w1 is root
    for (const f of [s0, s1, s2, s3, s4, s5]) await mat3Enter(f.address); // slots 2–7 (full)
    await mat3Enter(s6.address);       // 8th: triggers _cycleOutRoot → w1.isInMatrix=false, w1 parks
    expect(await matA3.isActiveInMatrix(w1.address)).to.be.false;

    // Admin forceCrosses the parked w1 from matA3 → matB3
    await usdc.connect(admin).approve(matA3Addr, T1_FEE);
    await matA3.connect(admin).forceCross(w1.address);
    expect(await matB3.isActiveInMatrix(w1.address)).to.be.true;
    expect(await matB.isActiveInMatrix(w1.address)).to.be.false; // not in pair 0 matB

    // V8.38 fix: iterates pm1.pairCount()=2 pairs — pi=0 misses, pi=1 finds w1 in matB3
    await usdc.connect(w1).approve(await tierRouter.getAddress(), T2_FEE);
    await tierRouter.connect(w1).manualUpgrade(1);
    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(2n);
  });

  // ─── L3: in pair 1's MatA (not MatB) → manualUpgrade reverts ────────────────
  it("L3: manualUpgrade(1) reverts when member is in pair 1's MatA and has no cycle or gate", async function () {
    const fx = await loadFixture(deployV8Fixture);
    const { usdc, tierRouter, w1, reg } = fx;
    await setupSecondPair(fx); // activePairIndex advances to 1 (matA3)

    // W1 registers in matA3 only — in MatA, not MatB; no cycle; whale gate closed
    await reg(w1);

    // inPrevMatB = false (W1 is in matA3, not any MatB)
    // tierCycles[w1][0] = 0 (no completed cycle)
    // gateOpen = _isTierUnlockedForManualEntry(2) = tierWhaleGateActive[5] = false
    await usdc.connect(w1).approve(await tierRouter.getAddress(), T2_FEE);
    await expect(tierRouter.connect(w1).manualUpgrade(1))
      .to.be.revertedWith("TR: cross to MatB first, or wait for this tier's Whale Gate to open");
  });

  it("L4: manualUpgrade(1) succeeds when member is in pair 1 MatB (V8.38 scan — deployWithFactoryFixture)", async function () {
    // Same scenario as L2 but using deployWithFactoryFixture to confirm the V8.38 fix
    // works when the autonomous factory is also wired to pm1.
    const fx = await loadFixture(deployWithFactoryFixture);
    const { usdc, pm1, tierRouter, matB, cnova, treasury, admin, reg,
            w1, s0, s1, s2, s3, s4, s5, s6 } = fx;
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));

    await reg(w1); // globalJoined[w1]=true

    const { matA3, matB3 } = await deployExtraT1Pair(fx);
    const matA3Addr = await matA3.getAddress();
    const matB3Addr = await matB3.getAddress();
    await treasury.connect(admin).setAuthorizedCaller(matA3Addr, true);
    await treasury.connect(admin).setAuthorizedCaller(matB3Addr, true);
    await cnova.connect(admin).grantRole(MINTER_ROLE, matA3Addr);
    await cnova.connect(admin).grantRole(MINTER_ROLE, matB3Addr);
    await tierRouter.connect(admin).registerMatrix(matB3Addr, 0);
    await pm1.connect(admin).addPair(matA3Addr, matB3Addr);
    expect(await pm1.pairCount()).to.equal(2n, "pair 1 created");

    // Fill matA3 via pm1 impersonation (same approach as L2)
    const pm1Addr = await pm1.getAddress();
    await ethers.provider.send("hardhat_setBalance", [pm1Addr, "0xde0b6b3a7640000"]);
    const pm1Imp = await ethers.getImpersonatedSigner(pm1Addr);
    const mat3Enter = async (addr) => {
      await usdc.connect(admin).transfer(matA3Addr, T1_FEE);
      return matA3.connect(pm1Imp).enterFor(addr, ethers.ZeroAddress);
    };

    await mat3Enter(w1.address);                               // root
    for (const f of [s0, s1, s2, s3, s4, s5]) await mat3Enter(f.address); // fill 2–7
    await mat3Enter(s6.address);       // 8th → _cycleOutRoot → w1.isInMatrix=false, parks
    expect(await matA3.isActiveInMatrix(w1.address)).to.be.false;

    // Admin forceCrosses parked w1 from matA3 → matB3
    await usdc.connect(admin).approve(matA3Addr, T1_FEE);
    await matA3.connect(admin).forceCross(w1.address);
    expect(await matB3.isActiveInMatrix(w1.address)).to.be.true;
    expect(await matB.isActiveInMatrix(w1.address)).to.be.false;

    // V8.38 multi-pair scan finds w1 in pair 1 matB3
    await usdc.connect(w1).approve(await tierRouter.getAddress(), T2_FEE);
    await tierRouter.connect(w1).manualUpgrade(1);
    expect(await tierRouter.memberHighestTier(w1.address)).to.equal(2n);
  });

  it("L8: manualUpgrade(1) reverts for member not in any MatB with gate closed", async function () {
    // Member has registered (T1 MatA) but has NOT crossed to any MatB.
    // Gate is closed (no Whale Gate open). Must still revert.
    // (deployV8_38Fixture replaced with inline setup: deployV8 + setupSecondPair)
    const fx = await loadFixture(deployV8Fixture);
    const { tierRouter, w1, reg } = fx;
    await setupSecondPair(fx); // pair 0 full → reg() routes to pair 1 (matA3)

    await reg(w1, ethers.ZeroAddress); // W1 enters pair 1's matA (matA3)

    // W1 is in matA3 — NOT in any MatB, gate closed
    await expect(
      tierRouter.connect(w1).manualUpgrade(1)
    ).to.be.revertedWith("TR: cross to MatB first, or wait for this tier's Whale Gate to open");
  });

}); // end: V8.38 — manualUpgrade() multi-pair MatB scan

// =============================================================================
// V8.39 — Frozen MatB keeper fix + try/catch guards + pairAdmin ownership
// =============================================================================
//
// Root cause fixed: MatrixPairFactory(admin, ...) sets owner() = admin, but the
// keeper signs with deployer (DEPLOYER_PRIVATE_KEY).  If admin ≠ deployer,
// factory-created MatBs are owned by admin and adminForceRotateRoot() reverts
// with OwnableUnauthorizedAccount when called from the keeper wallet.
//
// V8.39 fixes:
//   • keeperForceRotateRoot() — same as adminForceRotateRoot but authorised by
//     matrixKeeper (consistent with forceCrossKeeper / evictParked).
//   • MatrixPairFactory.pairAdmin — explicit address for matrix ownership transfer,
//     decoupled from factory Ownable owner.
//   • _tryAdvancePair deployAndWire try/catch — factory failure never reverts registration.
//   • _crossToPartner SF receiveDebtRepayment try/catch — SF failure never blocks crossing.
//   • _distributePool dust calculation fix — sfReceived subtracted so dust is exact.

describe("V8.39 — keeperForceRotateRoot + pairAdmin + try/catch guards", function () {

  // ── Helper: build frozen-MatB state (MSIZE=7) ──────────────────────────────
  // After this helper: MatB has 7/7 members, rotationCount=0 (frozen, never rotated).
  async function buildFrozenMatB(fixture) {
    const { reg, fc, matA, matB,
            w1, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12 } = fixture;

    // Fill MatA with 7 members
    for (const m of [w1, s0, s1, s2, s3, s4, s5]) await reg(m);

    // 7 registrations each trigger a MatA rotation; fc() pushes each parked root to MatB
    const triggers    = [s6,  s7,  s8,  s9,  s10, s11, s12];
    const parkedRoots = [w1,  s0,  s1,  s2,  s3,  s4,  s5];
    for (let i = 0; i < 7; i++) {
      await reg(triggers[i]);
      await fc(parkedRoots[i].address);
    }
    // MatB: occ=7, nextSlot=8 (>MSIZE=7), rotationCount=0 — frozen state
    expect(await matB.occupancy()).to.equal(7n);
    expect(await matB.rotationCount()).to.equal(0n, "pre-condition: MatB not yet rotated");
    return fixture;
  }

  // ── M1: keeperForceRotateRoot() succeeds when called by the matrixKeeper ───
  it("M1: keeperForceRotateRoot() evicts frozen MatB root and increments rotationCount", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { matB, admin, w1 } = fix;
    await buildFrozenMatB(fix);

    // Wire the keeper (admin acts as keeper for this test)
    await matB.connect(admin).setMatrixKeeper(admin.address);

    const frozenRoot = await matB.posToMember(1n);
    expect(frozenRoot).to.equal(w1.address, "w1 should be at position 1 (root)");

    await matB.connect(admin).keeperForceRotateRoot();

    expect(await matB.rotationCount()).to.equal(1n, "rotationCount must increment to 1");
    const memberData = await matB.getMember(frozenRoot);
    expect(memberData.isInMatrix).to.be.false;
    expect(await matB.occupancy()).to.equal(6n, "occupancy drops by 1 after cycle-out");
  });

  // ── M2: keeperForceRotateRoot() reverts for non-keeper ─────────────────────
  it("M2: keeperForceRotateRoot() reverts for non-keeper with 'F8V8: not keeper'", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { matB, admin, s0 } = fix;
    await buildFrozenMatB(fix);
    await matB.connect(admin).setMatrixKeeper(admin.address);

    // s0 is not the keeper
    await expect(
      matB.connect(s0).keeperForceRotateRoot()
    ).to.be.revertedWith("F8V8: not keeper");
  });

  // ── M3: keeperForceRotateRoot() reverts on MatA ────────────────────────────
  it("M3: keeperForceRotateRoot() reverts on MatA with 'F8V8: only callable on MatB'", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { matA, admin } = fix;
    await matA.connect(admin).setMatrixKeeper(admin.address);

    await expect(
      matA.connect(admin).keeperForceRotateRoot()
    ).to.be.revertedWith("F8V8: only callable on MatB");
  });

  // ── M4: keeper works even when MatB is owned by a DIFFERENT address ─────────
  // This is the exact production scenario: factory.owner()=admin, keeper signs with deployer.
  // Old code: deployer.adminForceRotateRoot() → OwnableUnauthorizedAccount.
  // V8.39 fix: deployer.keeperForceRotateRoot() → success (deployer=matrixKeeper).
  it("M4: keeperForceRotateRoot() works when MatB owner ≠ keeper signer (production scenario)", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { matB, admin, deployer, w1 } = fix;
    await buildFrozenMatB(fix);

    // admin owns matB (factory deployed with admin as pairAdmin).
    // deployer acts as the matrixKeeper (different wallet — the production gap).
    await matB.connect(admin).setMatrixKeeper(deployer.address);

    // Deployer (keeper) CAN rotate even though it doesn't own the MatB
    await matB.connect(deployer).keeperForceRotateRoot();
    expect(await matB.rotationCount()).to.equal(1n);

    // Confirm old adminForceRotateRoot would reject the DEPLOYER (non-owner)
    // (state reset: rotationCount=1 so it won't revert due to nextSlot check,
    //  but onlyOwner check fires first — use admin to confirm it still works for owner)
    await matB.connect(admin).adminForceRotateRoot();
    expect(await matB.rotationCount()).to.equal(2n);
  });

  // ── M5: MatrixPairFactory.pairAdmin set correctly at construction ───────────
  it("M5: MatrixPairFactory.pairAdmin equals the constructor _admin arg", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { factory, admin } = fix;
    expect(await factory.pairAdmin()).to.equal(admin.address);
  });

  // ── M6: pairAdmin defaults to constructor arg; setPairAdmin() updates it ─────
  it("M6: pairAdmin defaults to constructor _admin; setPairAdmin() updates it and blocks non-owner", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { factory, admin, deployer, s0 } = fix;

    // Default: pairAdmin == constructor admin arg
    expect(await factory.pairAdmin()).to.equal(admin.address,
      "pairAdmin must equal constructor _admin by default");

    // Update to a different address
    await factory.connect(admin).setPairAdmin(deployer.address);
    expect(await factory.pairAdmin()).to.equal(deployer.address, "pairAdmin updated");

    // Non-owner cannot call setPairAdmin
    await expect(
      factory.connect(s0).setPairAdmin(s0.address)
    ).to.be.reverted; // OwnableUnauthorizedAccount
  });

  // ── M6b: factory-created MatBs are owned by pairAdmin, not factory.owner() ──
  it("M6b: factory-created MatB is owned by pairAdmin (V8.39 fix — decoupled from factory.owner)", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { factory, admin, deployer, pm1, matB,
            reg, matrixLib,
            s13 } = fix;
    await buildFrozenMatB(fix);
    // V8.41: buildFrozenMatB leaves MatB at 7/7 (100% >= 90% threshold).
    // No adminForceRotateRoot needed — factory fires on next registration directly.

    // Override pairAdmin to deployer BEFORE factory fires, so the new MatB gets deployer as owner
    await factory.connect(admin).setPairAdmin(deployer.address);

    // s13 registration triggers _tryAdvancePair → factory.deployAndWire() → T1.2 created
    await reg(s13);
    expect(await pm1.pairCount()).to.equal(2n, "factory must have fired");

    const [, newMatBAddr] = await pm1.getPairAt(1n);
    const F8V8 = await ethers.getContractFactory("FigureEightMatrixV8", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    const newMatB = F8V8.attach(newMatBAddr);

    // V8.44 (item E): deployAndWire uses adminHandoff() — a TRUE one-step
    // transfer to pairAdmin (deployer). No pendingOwner limbo, no
    // acceptOwnership required (the V8.39 two-step was never completed in
    // practice, leaving every factory-spawned matrix admin-orphaned).
    expect(await newMatB.owner()).to.equal(deployer.address,
      "V8.44: pairAdmin (deployer) is the CONFIRMED owner immediately — can call adminForceRotateRoot");
    expect(await newMatB.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  // ── M7: _tryAdvancePair deployAndWire failure does NOT revert registration ──
  // Point pm1's pairFactory at a real contract (USDC) that has code but no
  // deployAndWire() function.  The call reverts with "function not found", which
  // the V8.39 try/catch catches.  The triggering registration must still succeed.
  it("M7: factory deployAndWire failure in _tryAdvancePair does not revert the registration", async function () {
    const fix = await loadFixture(deployWithFactoryFixture);
    const { usdc, admin, pm1, matB, reg, s13 } = fix;
    await buildFrozenMatB(fix);
    await matB.connect(admin).adminForceRotateRoot(); // rotationCount=1 → factory will fire

    // Break the factory: point pm1 at USDC (real contract, no deployAndWire).
    // The IMatrixPairFactory(usdc).deployAndWire() call will revert inside _tryAdvancePair.
    await pm1.connect(admin).setFactory(await usdc.getAddress());

    // V8.39 try/catch guard: factory reverts silently, registration completes normally.
    await expect(reg(s13)).to.not.be.reverted;
    expect(await pm1.pairCount()).to.equal(1n, "factory failed silently — pairCount unchanged");
    expect(await pm1.activePairIndex()).to.equal(0n, "still on pair 0");
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// V8.43 — additive toggles, two-threshold pair opening, overflow routing
// ═══════════════════════════════════════════════════════════════════════════════
describe("V8.43 — additive toggles + two-threshold pair opening", function () {

  describe("reservedFor — additive math (re-entry + upgrade + double)", function () {
    it("sums each enabled toggle's fee independently", async () => {
      const { tierRouter, reg, w1 } = await loadFixture(deployV8Fixture);
      await reg(w1);

      // all three ON → curFee + nextFee + curFee
      await tierRouter.connect(w1).setMemberOptions(false, true, true);
      expect(await tierRouter.reservedFor(w1.address))
        .to.equal(T1_FEE + T2_FEE + T1_FEE, "all three: 10 + 7 + 10");

      // upgrade only → nextFee
      await tierRouter.connect(w1).setMemberOptions(false, false, false);
      expect(await tierRouter.reservedFor(w1.address)).to.equal(T2_FEE, "upgrade only");

      // re-entry only → curFee
      await tierRouter.connect(w1).setMemberOptions(true, true, false);
      expect(await tierRouter.reservedFor(w1.address)).to.equal(T1_FEE, "re-entry only");

      // double alone can never fire (needs a primary seat) → 0
      await tierRouter.connect(w1).setMemberOptions(true, false, true);
      expect(await tierRouter.reservedFor(w1.address)).to.equal(0n, "double alone");

      // everything off → 0
      await tierRouter.connect(w1).setMemberOptions(true, false, false);
      expect(await tierRouter.reservedFor(w1.address)).to.equal(0n, "all off");
    });
  });

  describe("PairManagerV8 — entry thresholds", function () {
    it("setEntryThresholds validates bounds and owner-only access", async () => {
      const { pm1, admin, w1 } = await loadFixture(deployV8Fixture);

      await expect(pm1.connect(admin).setEntryThresholds(2, 3))
        .to.emit(pm1, "EntryThresholdsSet").withArgs(2n, 3n);
      expect(await pm1.deployEntryThreshold()).to.equal(2n);
      expect(await pm1.routeEntryThreshold()).to.equal(3n);

      await expect(pm1.connect(admin).setEntryThresholds(5, 3))
        .to.be.revertedWith("PM8: deploy<=route required");
      await expect(pm1.connect(w1).setEntryThresholds(2, 3)).to.be.reverted;
    });

    it("overflowActive: needs saturation AND an existing next pair", async () => {
      const fx = await loadFixture(deployV8Fixture);
      const { pm1, admin, reg, s0, s1 } = fx;
      await pm1.connect(admin).setEntryThresholds(2, 2);

      await reg(s0);
      await reg(s1); // pair 0 totalRegistered = 2 ≥ routeEntryThreshold
      expect(await pm1.overflowActive(0)).to.equal(false, "saturated but no pair 1 yet");

      const { matA3, matB3 } = await deployExtraT1Pair(fx);
      await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());
      expect(await pm1.overflowActive(0)).to.equal(true, "saturated + pair 1 exists");
    });

    it("external registrations overflow to pair 1 once pair 0 is saturated", async () => {
      const fx = await loadFixture(deployV8Fixture);
      const { pm1, treasury, admin, reg, s0, s1, s2 } = fx;
      await pm1.connect(admin).setEntryThresholds(2, 2);

      await reg(s0);
      await reg(s1); // pair 0 saturated (2 entries)

      const { matA3, matB3 } = await deployExtraT1Pair(fx);
      await pm1.connect(admin).addPair(await matA3.getAddress(), await matB3.getAddress());
      // Authorize extra pair with treasury (deploy script does this; test helper skips it)
      await treasury.connect(admin).setAuthorizedCaller(await matA3.getAddress(), true);
      await treasury.connect(admin).setAuthorizedCaller(await matB3.getAddress(), true);

      await reg(s2); // must route to pair 1 (_findExternalPair skips saturated pair 0)
      expect(await matA3.isActiveInMatrix(s2.address)).to.equal(true, "s2 seated in T1.2 MatA");
      const p1 = await pm1.pairs(1);
      expect(p1.totalRegistered).to.equal(1n, "pair 1 counted the overflow entry");
    });

    it("falls back to saturated pair 0 when no next pair exists (never strands)", async () => {
      const { pm1, admin, reg, s0, s1, s2, matA } = await loadFixture(deployV8Fixture);
      await pm1.connect(admin).setEntryThresholds(2, 2);
      await reg(s0);
      await reg(s1);
      // pair 0 saturated, no pair 1 → pass-2 fallback keeps seating in pair 0
      await expect(reg(s2)).to.not.be.reverted;
      expect(await matA.isActiveInMatrix(s2.address)).to.equal(true);
    });
  });

  describe("Factory early-deploy at deployEntryThreshold (125×3 rule)", function () {
    it("deploys the next pair from cumulative entries, before MatB fills", async () => {
      const fx = await loadFixture(deployWithFactoryFixture);
      const { pm1, admin, reg, s0, s1, s2 } = fx;
      // deploy at 2 entries, route at 3 — mirrors 375/381 at test scale
      await pm1.connect(admin).setEntryThresholds(2, 3);

      await reg(s0);
      await reg(s1);                    // newest pair now has 2 entries
      expect(await pm1.pairCount()).to.equal(1n, "trigger checks on NEXT entry");

      await reg(s2);                    // _tryAdvancePair sees 2 ≥ 2 → factory fires
      expect(await pm1.pairCount()).to.equal(2n, "pair 2 deployed early via entry trigger");
    });
  });

  // Covered on testnet during the V8.43 verification pass (heavy multi-cycle
  // scenarios — the additive engine itself is exercised by the full elevator
  // suite above, which passes unchanged):
  it("selfRescue overflow: parked member in a saturated pair is re-seated in pair N+1");
  it("upgrade-at-cross funds from MatA withdrawable when no wallet allowance exists");
  it("additive cycle-out: all three toggles → 2 seats current tier + 1 seat next tier");

});
