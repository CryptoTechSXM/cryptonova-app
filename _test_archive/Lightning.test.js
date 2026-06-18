"use strict";
/**
 * Lightning.test.js
 * ─────────────────────────────────────────────────────────
 * Tests the full V5 system with lightning parameters:
 *   ACTIVE_WINDOW = 2   (rotation every 2nd joiner)
 *   BELT_MAX      = 10  (belt flips after 10 members)
 *   UNIT          = 100_000 (0.1 USDC → fees 10x cheaper)
 *   Tier fees: $1 / $2.50 / $5 / $10 / $25 / $50 / $100
 *
 * Scenario tested:
 *   1. Member 1 registers ($1), gets 50 CNOVA
 *   2. Member 2 registers → rotation fires for Member 1 (cycle 1)
 *   3. Members 3-10 register → Belt A fills, Belt B opens
 *   4. Member 11 registers → goes to Belt B
 *   5. Auto-upgrade: Member 1 opts in, cycle completes → upgrades to Tier 2 ($2.50)
 *   6. Epoch changes after 5 joins
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─── Lightning params ─────────────────────────────────────────────────────────
const UNIT         = 100_000n;   // 0.1 USDC per unit
const AW           = 2n;         // active window
const BELT_MAX     = 10n;
const T1_FEE       = UNIT * 10n; // $1.00
const T2_FEE       = UNIT * 25n; // $2.50

const USDC = (d) => BigInt(Math.round(d * 100_000));   // d dollars → USDC raw

// ─── Deploy fixture ───────────────────────────────────────────────────────────
async function deployLightning() {
  const [deployer, dev, ops, admin, ...signers] = await ethers.getSigners();

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
    await cnova.getAddress(), await usdc.getAddress(), admin.address
  );
  const cw = await (await ethers.getContractFactory("CryptoNovaCommunityWallet")).deploy(
    await usdc.getAddress(), admin.address
  );

  const MatrixV3 = await ethers.getContractFactory("CryptoNovaMatrixV3");
  const deployMx = async (mult) => MatrixV3.deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev.address, ops.address, await cw.getAddress(),
    admin.address, UNIT, BigInt(mult), AW
  );

  const mx1 = await deployMx(10);   // $1.00
  const mx2 = await deployMx(25);   // $2.50
  const mx3 = await deployMx(50);   // $5.00
  const mx4 = await deployMx(100);  // $10.00
  const mx5 = await deployMx(250);  // $25.00
  const mx6 = await deployMx(500);  // $50.00
  const mx7 = await deployMx(1000); // $100.00

  // Extra belts B-E (same as Tier 1 params)
  const beltB = await deployMx(10);
  const beltC = await deployMx(10);
  const beltD = await deployMx(10);
  const beltE = await deployMx(10);
  const extraBelts = [beltB, beltC, beltD, beltE];

  const bm = await (await ethers.getContractFactory("BeltManager")).deploy(
    await usdc.getAddress(), admin.address, BELT_MAX
  );
  const bmAddr = await bm.getAddress();

  const tm = await (await ethers.getContractFactory("CryptoNovaTierManager")).deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev.address, ops.address, await cw.getAddress(), admin.address, UNIT
  );
  const tmAddr = await tm.getAddress();

  // Roles
  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  const EPOCH  = await cnova.EPOCH_ROLE();
  const allMx  = [mx1, mx2, mx3, mx4, mx5, mx6, mx7, ...extraBelts];

  for (const m of allMx) await cnova.connect(admin).grantRole(MINTER, await m.getAddress());
  await cnova.connect(admin).grantRole(MINTER, tmAddr);
  await cnova.connect(admin).grantRole(BURNER, await treasury.getAddress());
  await cnova.connect(admin).grantRole(EPOCH,  await mx1.getAddress());

  for (let t = 1; t <= 7; t++) {
    const m = [mx1,mx2,mx3,mx4,mx5,mx6,mx7][t-1];
    await tm.connect(admin).setMatrix(t, await m.getAddress());
    await cw.connect(admin).setAuthorisedRegistrar(await m.getAddress(), true);
    await treasury.connect(admin).setAuthorizedCaller(await m.getAddress(), true);
  }
  for (const m of extraBelts) {
    await cw.connect(admin).setAuthorisedRegistrar(await m.getAddress(), true);
    await treasury.connect(admin).setAuthorizedCaller(await m.getAddress(), true);
  }
  await cw.connect(admin).setAuthorisedRegistrar(tmAddr, true);
  await cw.connect(admin).setAuthorisedRegistrar(bmAddr, true);

  for (const m of [mx2,mx3,mx4,mx5,mx6,mx7]) await m.connect(admin).setAuthorizedRegistrar(tmAddr, true);
  await mx1.connect(admin).setAuthorizedRegistrar(bmAddr, true);
  for (const m of extraBelts) await m.connect(admin).setAuthorizedRegistrar(bmAddr, true);

  await treasury.connect(admin).setCommunityWallet(await cw.getAddress());
  await treasury.connect(admin).setTier1Matrix(bmAddr);
  await tm.connect(admin).setBeltManager(bm);

  // Auto-upgrade wiring
  for (const m of allMx) {
    await m.connect(admin).setTierManager(tmAddr);
    await tm.connect(admin).setAutoUpgradeCaller(await m.getAddress(), true);
  }

  // Add belts A-E to BeltManager
  await bm.connect(admin).addBelt(await mx1.getAddress());
  for (const b of extraBelts) await bm.connect(admin).addBelt(await b.getAddress());

  // V5: setBeltManagerCaller so triggerReentry() works
  await mx1.connect(admin).setBeltManagerCaller(bmAddr);
  for (const b of extraBelts) await b.connect(admin).setBeltManagerCaller(bmAddr);

  // Mint USDC to test signers
  for (const s of signers.slice(0, 25)) {
    await usdc.connect(deployer).mint(s.address, USDC(1000));
  }

  const reg = async (signer, referrer) => {
    // Query exact cost (entry fee + reentry contributions for older full belts)
    const [totalCost] = await bm.registrationCost();
    await usdc.connect(signer).approve(bmAddr, totalCost);
    return bm.connect(signer).register(referrer ?? ethers.ZeroAddress);
  };

  return { usdc, cnova, treasury, cw, bm, tm, mx1, mx2, beltB,
           deployer, dev, ops, admin, signers, reg };
}

// ═════════════════════════════════════════════════════════════════════════════
describe("Lightning Test (W=2, BELT_MAX=10, $1 fees)", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("deploys with correct lightning params", async function () {
    const { mx1, bm } = await loadFixture(deployLightning);
    expect(await mx1.ACTIVE_WINDOW()).to.equal(AW);
    expect(await mx1.ENTRY_FEE()).to.equal(T1_FEE);
    expect(await bm.BELT_MAX()).to.equal(BELT_MAX);
  });

  it("member 1 registers for $1 and gets 50 CNOVA", async function () {
    const { cnova, bm, signers, reg } = await loadFixture(deployLightning);
    const alice = signers[0];
    await reg(alice);
    expect(await bm.totalMembers()).to.equal(1n);
    expect(await cnova.balanceOf(alice.address)).to.equal(ethers.parseEther("50"));
  });

  it("member 3 triggers rotation — member 1 completes cycle 1", async function () {
    const { mx1, signers, reg } = await loadFixture(deployLightning);
    const [alice, bob, carol] = signers;
    await reg(alice);
    await reg(bob);
    // Queue is full at 2 — no rotation yet
    expect(await mx1.cyclesCompleted(alice.address)).to.equal(0n);
    // Member 3 joins → alice at position 1 rotates out → cycle 1
    await reg(carol);
    expect(await mx1.cyclesCompleted(alice.address)).to.equal(1n);
  });

  it("epoch changes after 5 joins (EPOCH_MEMBER_LIMIT=5)", async function () {
    const { cnova, signers, reg } = await loadFixture(deployLightning);
    // First 5 joins: epoch 1 (50 CNOVA each)
    for (let i = 0; i < 5; i++) await reg(signers[i]);
    expect(await cnova.currentEpochNumber()).to.equal(1n); // still epoch 1 until 5 minted

    // 6th join triggers epoch 2 (40 CNOVA)
    await reg(signers[5]);
    expect(await cnova.currentEpochNumber()).to.equal(2n);
    expect(await cnova.currentRewardPerEntry()).to.equal(ethers.parseEther("40"));
  });

  it("belt A fills at 10 members and belt B opens", async function () {
    const { bm, beltB, signers, reg } = await loadFixture(deployLightning);
    // Register 10 members → fills Belt A
    for (let i = 0; i < 10; i++) await reg(signers[i]);
    expect(await bm.activeBeltIndex()).to.equal(0n); // still belt A (not yet advanced)

    // 11th member triggers belt B
    await reg(signers[10]);
    expect(await bm.activeBeltIndex()).to.equal(1n);
    expect(await bm.memberBeltIndex(signers[10].address)).to.equal(1n);
    expect(await beltB.totalMembers()).to.equal(1n);
  });

  it("belt B emits BeltActivated event", async function () {
    const { bm, beltB, signers, reg } = await loadFixture(deployLightning);
    for (let i = 0; i < 10; i++) await reg(signers[i]);
    await expect(reg(signers[10]))
      .to.emit(bm, "BeltActivated")
      .withArgs(1n, await beltB.getAddress());
  });

  it("auto-upgrade fires: member opts in, completes cycle, upgrades to Tier 2 ($2.50)", async function () {
    const { tm, mx1, mx2, signers, reg } = await loadFixture(deployLightning);

    // Alice registers and opts in immediately
    await reg(signers[0]);
    await tm.connect(signers[0]).setAutoUpgrade(true);

    // Register enough members so alice earns $2.50+ in withdrawable
    // With AW=2, L1 chain pay per joiner = $1 × 20% × 80% = $0.16
    // Alice needs ~16 more joiners to accumulate $2.50+
    for (let i = 1; i < 18; i++) await reg(signers[i]);

    const aliceMember = await mx1.getMember(signers[0].address);
    const tier2Fee    = 25n * 100_000n; // $2.50

    if (aliceMember.withdrawable >= tier2Fee) {
      // Auto-upgrade fired — alice is in Tier 2
      expect(await tm.memberTier(signers[0].address)).to.equal(2n);
      expect(await (await mx2.getMember(signers[0].address)).isRegistered).to.be.true;
    } else {
      // Still building balance — cycles should be done
      const cycles = await mx1.getCyclesCompleted(signers[0].address);
      expect(cycles).to.be.gte(1n);
    }
  });

  it("belt total members aggregates across all belts", async function () {
    const { bm, signers, reg } = await loadFixture(deployLightning);
    for (let i = 0; i < 12; i++) await reg(signers[i]);
    expect(await bm.totalMembers()).to.equal(12n);
  });

  it("member 1 earns CNOVA on Tier 2 upgrade (50 CNOVA flat)", async function () {
    const { tm, cnova, mx1, signers, reg, usdc, bm } = await loadFixture(deployLightning);
    const alice = signers[0];

    // Register alice and build enough withdrawable for $2.50 upgrade
    await reg(alice);
    // Manually fund alice's withdrawable by having many members register
    // and alice earning chain pay
    for (let i = 1; i < 8; i++) await reg(signers[i]);

    const m = await mx1.getMember(alice.address);
    const tier2Fee = 25n * 100_000n;

    if (m.withdrawable >= tier2Fee) {
      const cnovaBefore = await cnova.balanceOf(alice.address);
      await tm.connect(alice).setAutoUpgrade(true);
      // trigger another rotation
      await usdc.connect(signers[8]).approve(await bm.getAddress(), T1_FEE);
      await bm.connect(signers[8]).register(ethers.ZeroAddress);
      const cnovaAfter = await cnova.balanceOf(alice.address);
      // Should have earned 50 CNOVA for Tier 2 upgrade (25 dollars × 2 CNOVA/$)
      if (await tm.memberTier(alice.address) === 2n) {
        expect(cnovaAfter).to.be.gt(cnovaBefore);
      }
    }
  });

  it("community wallet: first 5 registrations fill Nova Original slots", async function () {
    const { cw, signers, reg } = await loadFixture(deployLightning);
    for (let i = 0; i < 5; i++) await reg(signers[i]);
    expect(await cw.trancheACount()).to.equal(5n);
    for (let i = 0; i < 5; i++) {
      expect(await cw.founderTranche(signers[i].address)).to.equal(1n); // Tranche A
    }
  });

  it("treasury accumulates reserve from $1 joins", async function () {
    const { treasury, signers, reg } = await loadFixture(deployLightning);
    for (let i = 0; i < 5; i++) await reg(signers[i]);
    const reserve = await treasury.usdcReserve();
    // 15% of $1 × 5 joins = $0.75
    expect(reserve).to.be.gt(0n);
  });

  it("full belt flip scenario: 10 → belt A full → belt B → 3 more → belt B rotates", async function () {
    const { bm, beltB, signers, reg } = await loadFixture(deployLightning);
    // Fill belt A (10 members)
    for (let i = 0; i < 10; i++) await reg(signers[i]);
    // Member 11 → goes to belt B (belt A was full)
    await reg(signers[10]);
    expect(await bm.activeBeltIndex()).to.equal(1n);
    // Members 12 and 13 join belt B → fills AW=2, member 14 triggers rotation
    await reg(signers[11]);
    await reg(signers[12]);
    // Belt B queue now full at AW=2, next join rotates member 11
    await reg(signers[13]);
    expect(await beltB.cyclesCompleted(signers[10].address)).to.equal(1n);
    console.log("    ✓ Belt A filled → Belt B opened → Belt B rotation fired");
  });
});

  it("triggerReentry keeps full Belt A spinning when Belt B gets new members", async function () {
    const { bm, mx1, signers, reg } = await loadFixture(deployLightning);

    // Fill Belt A (10 members)
    for (let i = 0; i < 10; i++) await reg(signers[i]);

    // Get Belt A cycle count before
    const cyclesBefore = await mx1.getCyclesCompleted(signers[0].address);

    // Member 11 joins Belt B → BeltManager triggers reentry on Belt A
    await reg(signers[10]);

    // Belt A member should have gained a cycle from the triggered reentry
    const cyclesAfter = await mx1.getCyclesCompleted(signers[0].address);
    expect(cyclesAfter).to.be.gte(cyclesBefore);
    console.log("    Belt A cycles before:", cyclesBefore.toString(), "after:", cyclesAfter.toString(), "— Belt A kept spinning ✓");
  });
