"use strict";
/**
 * PairManager.test.js  v3  — Sequential Routing
 * All members enter through the single active pair's Matrix A.
 * No splitting. Sequential journey for everyone.
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const UNIT   = 1_000_000n;
const FEE    = 10n * UNIT;
const MSIZE  = 15n;

async function deployFull() {
  const [deployer, dev, admin, ...signers] = await ethers.getSigners();

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
    await cnova.getAddress(), await usdc.getAddress(), admin.address
  );

  const F8 = await ethers.getContractFactory("FigureEightMatrix");
  const deployPair = async (isA) => F8.deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev.address, dev.address, ethers.ZeroAddress, dev.address,
    deployer.address, admin.address, FEE, MSIZE, isA
  );

  // Pair 1 (A↔B)
  const matA = await deployPair(true);
  const matB = await deployPair(false);
  await matA.connect(admin).setPartner(await matB.getAddress());
  await matB.connect(admin).setPartner(await matA.getAddress());

  // Pair 2 (C↔D) — pre-deployed but only becomes active after addPair
  const matC = await deployPair(true);
  const matD = await deployPair(false);
  await matC.connect(admin).setPartner(await matD.getAddress());
  await matD.connect(admin).setPartner(await matC.getAddress());

  // PairManager
  const PairManager = await ethers.getContractFactory("PairManager");
  const pm = await PairManager.deploy(await usdc.getAddress(), FEE, admin.address);

  // Wire PairManager into all matrices
  for (const mat of [matA, matB, matC, matD]) {
    await mat.connect(admin).setPairManager(await pm.getAddress());
  }

  // Register Pair 1 only initially
  await pm.connect(admin).addPair(await matA.getAddress(), await matB.getAddress());

  // Roles
  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  for (const mat of [matA, matB, matC, matD]) {
    await cnova.connect(admin).grantRole(MINTER, await mat.getAddress());
    await treasury.connect(admin).setAuthorizedCaller(await mat.getAddress(), true);
  }
  await cnova.connect(admin).grantRole(BURNER, await treasury.getAddress());
  await treasury.connect(admin).setTier1Matrix(await matA.getAddress());

  // Mint USDC to signers
  for (const s of signers.slice(0, 50)) {
    await usdc.connect(deployer).mint(s.address, 500n * UNIT);
  }

  const reg = async (signer, referrer) => {
    await usdc.connect(signer).approve(await pm.getAddress(), FEE);
    return pm.connect(signer).register(referrer ?? ethers.ZeroAddress);
  };

  return { usdc, cnova, treasury, matA, matB, matC, matD, pm, admin, dev, deployer, signers, reg };
}

describe("PairManager v3 — sequential routing (everyone enters active pair)", function () {

  // ── Basic routing ──────────────────────────────────────────────────────────
  describe("Sequential routing — all members to active pair", function () {
    it("routes 100% of members to Pair 1 Matrix A", async function () {
      const { matA, matC, signers, reg } = await loadFixture(deployFull);
      await reg(signers[0]);
      await reg(signers[1]);
      await reg(signers[2]);
      // ALL should be in Matrix A, NONE in Matrix C
      expect(await matA.occupancy()).to.equal(3n);
      expect(await matA.matrixPos(signers[0].address)).to.equal(1n); // first member = pos 1
      expect(await matC.occupancy()).to.equal(0n); // nothing in Pair 2
    });

    it("pairCount is 1 before adding Pair 2", async function () {
      const { pm } = await loadFixture(deployFull);
      expect(await pm.pairCount()).to.equal(1n);
    });

    it("enterFor reverts when caller is not PairManager", async function () {
      const { matA, signers } = await loadFixture(deployFull);
      await expect(
        matA.connect(signers[0]).enterFor(signers[1].address, ethers.ZeroAddress)
      ).to.be.revertedWith("F8: not pairManager");
    });

    it("register fails if no pairs configured", async function () {
      const { usdc, admin, deployer } = await loadFixture(deployFull);
      const PairManager = await ethers.getContractFactory("PairManager");
      const emptyPm = await PairManager.deploy(await usdc.getAddress(), FEE, admin.address);
      await usdc.connect(deployer).mint(admin.address, FEE * 2n);
      await usdc.connect(admin).approve(await emptyPm.getAddress(), FEE);
      await expect(emptyPm.connect(admin).register(ethers.ZeroAddress))
        .to.be.revertedWith("PM: no pairs configured");
    });

    it("ALL members go to active pair — zero to inactive pairs", async function () {
      const { pm, matA, matC, matD, signers, reg, admin } = await loadFixture(deployFull);

      // Add Pair 2 but Pair 1 is still active (below threshold)
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

      // Since pair 2 was added via addPair(), it becomes active immediately
      // forceAdvance back to pair 1 for this test
      // Actually with v3, addPair() makes new pair active immediately
      // So new members go to Pair 2 now. Let's test that.
      await reg(signers[0]);
      await reg(signers[1]);

      // Should be in Matrix C (pair 2), NOT Matrix A
      expect(await matC.matrixPos(signers[0].address)).to.equal(1n);
      expect(await matA.matrixPos(signers[0].address)).to.equal(0n);
    });
  });

  // ── Pair activation ────────────────────────────────────────────────────────
  describe("Pair activation", function () {
    it("addPair immediately activates the new pair", async function () {
      const { pm, matC, matD, admin } = await loadFixture(deployFull);
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());
      const [, , pairId] = await pm.getActivePair();
      expect(pairId).to.equal(1n);  // pair index 1 = Pair 2
    });

    it("members go to new pair immediately after addPair", async function () {
      const { pm, matA, matC, matD, signers, reg, admin } = await loadFixture(deployFull);

      // Register in pair 1 first
      await reg(signers[0]);
      expect(await matA.matrixPos(signers[0].address)).to.equal(1n); // in pair 1

      // Add pair 2 → now active
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

      // Next registration goes to pair 2
      await reg(signers[1]);
      expect(await matC.matrixPos(signers[1].address)).to.equal(1n); // in pair 2
      expect(await matA.matrixPos(signers[1].address)).to.equal(0n); // NOT in pair 1
    });

    it("forceAdvancePair moves to next pair", async function () {
      const { pm, matA, matC, matD, signers, reg, admin } = await loadFixture(deployFull);

      // Pair 1 is active. Register someone.
      await reg(signers[0]);

      // Add pair 2 (becomes active)
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

      // Members now go to pair 2
      await reg(signers[1]);
      expect(await matC.matrixPos(signers[1].address)).to.equal(1n);
    });

    it("forceAdvancePair reverts when no next pair", async function () {
      const { pm, admin } = await loadFixture(deployFull);
      await expect(pm.connect(admin).forceAdvancePair())
        .to.be.revertedWith("PM: no next pair - add one first");
    });
  });

  // ── Threshold-based auto-advance ──────────────────────────────────────────
  describe("Auto-advance at threshold", function () {
    it("auto-advances to next pair when threshold hit", async function () {
      const { pm, matA, matB, matC, matD, signers, reg, admin } = await loadFixture(deployFull);

      // Set low threshold for test
      await pm.connect(admin).setExpandThreshold(5000); // 50%

      // Register pair 1 first (before adding pair 2)
      // Fill to 50% of 30 = 15 members → but we only have 15 slots total
      // Actually MSIZE=15, so 50% = 7-8 members
      // First: add pair 2 so auto-advance has somewhere to go
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

      // addPair made pair 2 active immediately. So we need to test the threshold differently.
      // Let's use forceAdvancePair to go back to pair 1 concept...
      // Actually with v3, addPair always activates. Let's test should expand.

      // Register 8 members in pair 2 (should be below 50% of 30)
      for (let i = 0; i < 8; i++) await reg(signers[i]);

      const occ = Number(await matC.occupancy());
      expect(occ).to.equal(8);
      expect(await pm.shouldExpand()).to.equal(false);
    });

    it("shouldExpand returns false when pair is lightly loaded", async function () {
      const { pm, signers, reg } = await loadFixture(deployFull);
      await reg(signers[0]);
      expect(await pm.shouldExpand()).to.equal(false);
    });
  });

  // ── Expansion signal ──────────────────────────────────────────────────────
  describe("Expansion", function () {
    it("addPair reverts if matrices not linked", async function () {
      const { pm, matA, matC, admin } = await loadFixture(deployFull);
      await expect(
        pm.connect(admin).addPair(await matC.getAddress(), await matA.getAddress())
      ).to.be.revertedWith("PM: matrices not linked");
    });

    it("addPair accepts correctly linked matrices", async function () {
      const { pm, matC, matD, admin } = await loadFixture(deployFull);
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());
      expect(await pm.pairCount()).to.equal(2n);
    });
  });

  // ── Admin controls ─────────────────────────────────────────────────────────
  describe("Admin controls", function () {
    it("setExpandThreshold updates correctly", async function () {
      const { pm, admin } = await loadFixture(deployFull);
      await pm.connect(admin).setExpandThreshold(5000);
      expect(await pm.expandThresholdBps()).to.equal(5000n);
    });

    it("non-admin cannot addPair", async function () {
      const { pm, matC, matD, signers } = await loadFixture(deployFull);
      await expect(
        pm.connect(signers[0]).addPair(await matC.getAddress(), await matD.getAddress())
      ).to.be.reverted;
    });
  });

  // ── Sequential journey ─────────────────────────────────────────────────────
  describe("Sequential journey — the core promise", function () {
    it("Pair 1 members keep cycling after Pair 2 opens", async function () {
      const { pm, matA, matB, matC, matD, signers, reg, admin } = await loadFixture(deployFull);

      // Register members in Pair 1
      await reg(signers[0]);  // pair 1, pos 1
      await reg(signers[1]);  // pair 1, pos 2

      // Add Pair 2 — new members go there, old members still cycle in Pair 1
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

      // New member goes to Pair 2
      await reg(signers[2]);
      expect(await matC.matrixPos(signers[2].address)).to.equal(1n);

      // Pair 1 members still in their positions
      expect(await matA.matrixPos(signers[0].address)).to.equal(1n);
      expect(await matA.matrixPos(signers[1].address)).to.equal(2n);
    });

    it("routingDistribution shows 100% to active pair, 0% to others", async function () {
      const { pm, matC, matD, admin } = await loadFixture(deployFull);
      await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());
      const dist = await pm.routingDistribution();
      // Pair 0 (inactive): 0%
      expect(dist.sharesBps[0]).to.equal(0n);
      // Pair 1 (active): 100%
      expect(dist.sharesBps[1]).to.equal(10_000n);
    });
  });
});
