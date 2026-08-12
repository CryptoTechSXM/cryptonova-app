"use strict";
/**
 * V8_48_FloorGuards.test.js — scope items 4, 5, 6: the floor-price cluster.
 *
 * The floor's public promise (CNOVATreasury.floorPrice() doc, and the site copy
 * shipped as B1): "it can only ever go up — never down — by design." Before these
 * items that sentence was an intention; three code paths could break it:
 *   item 4 — mintReward minted scheduled amounts with no backing check, so a T1
 *            wave DILUTED the floor (modelled −8.99% in V8_48_BACKLOG.md);
 *   item 5 — addDexLiquidity / emergencyWithdraw spent reserve with no guard;
 *   item 6 — DirectSale priced the floor off usdc.balanceOf(treasury), which any
 *            direct USDC transfer inflates past what the treasury honours.
 *
 * DECISIONS ENCODED HERE, NOT INVENTED HERE: the hard no-override floor guard was
 * owner-decided 2026-08-07 ("emergencyWithdraw becomes unusable against reserve"
 * — that is asserted below as the INTENDED behaviour, not tolerated as a bug),
 * and the mint cap is Option A, owner-decided 2026-08-08.
 *
 * ORDERING: deposits run BEFORE the mint in MatrixLogicLib, so FG2/FG3 deposit
 * first and mint second, mirroring the contract. The invariant proven is the
 * honest one: no seat leaves the floor LOWER than it found it.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E18 = 10n ** 18n;

async function deployFloorFixture() {
  const [owner, alice, bob, dave] = await ethers.getSigners();
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);

  await cnova.grantRole(await cnova.MINTER_ROLE(), owner.address);
  await cnova.setTreasuryRef(await treasury.getAddress());
  await treasury.setAuthorizedCaller(owner.address, true);

  // Owner can deposit reserve at will (mirrors a matrix's depositReserve call).
  const deposit = async (amt6) => {
    await usdc.mint(owner.address, amt6);
    await usdc.approve(await treasury.getAddress(), amt6);
    await treasury.depositReserve(amt6);
  };

  return { owner, alice, bob, dave, usdc, cnova, treasury, deposit };
}

describe("V8.48 items 4/5/6 — the floor-price guards", function () {
  this.timeout(600_000);

  // ── item 4: mint cap at backed value ────────────────────────────────────────

  it("FG1 (item 4): the launch equation — $0.50 deposit at the $0.01 seed floor backs exactly the scheduled 50 CNOVA", async () => {
    const { cnova, alice, deposit } = await loadFixture(deployFloorFixture);
    // Mirror contract order: the seat's deposit lands before its mint.
    await deposit(500_000n);                       // $0.50
    await cnova.mintReward(alice.address, 0, 500_000n);
    // supply was 0 at mint time -> floorPrice() returns the $0.01 seed, and
    // 0.50 / 0.01 = 50 — cap exactly EQUALS the schedule. "Starts at 50 CNOVA."
    expect(await cnova.balanceOf(alice.address)).to.equal(50n * E18);
  });

  it("FG2 (item 4): when the floor has risen the cap BINDS — minted × floor == deposit exactly, and the entry leaves the floor no lower than it found it", async () => {
    const { cnova, treasury, alice, bob, deposit } = await loadFixture(deployFloorFixture);
    await deposit(500_000n);
    await cnova.mintReward(alice.address, 0, 500_000n);          // 50 CNOVA @ seed

    // Push the floor to $0.10: reserve $5.00 against 50 CNOVA.
    await deposit(4_500_000n);
    const floorPreEntry = await treasury.floorPrice();
    expect(floorPreEntry, "SETUP: floor must be $0.10").to.equal(100_000n);

    // Bob's seat: deposit $0.50, then mint (contract order).
    await deposit(500_000n);
    const floorAtMint = await treasury.floorPrice();             // includes bob's deposit
    const balBefore = await cnova.balanceOf(bob.address);
    await cnova.mintReward(bob.address, 0, 500_000n);
    const minted = (await cnova.balanceOf(bob.address)) - balBefore;

    expect(minted, "cap must bind well below the scheduled 50").to.be.lt(50n * E18);
    expect(minted, "backing equation: minted == deposit / floor-at-mint")
      .to.equal(500_000n * E18 / floorAtMint);
    // The promise, proven: bob's whole entry (deposit + capped mint) left the
    // floor ABOVE where it stood before he arrived.
    expect(await treasury.floorPrice(), "no seat leaves the floor lower than it found it")
      .to.be.gte(floorPreEntry);
  });

  it("FG3 (item 4): a seat that deposited NOTHING mints NOTHING — the cap is strict, not advisory", async () => {
    const { cnova, dave, deposit } = await loadFixture(deployFloorFixture);
    await deposit(500_000n);
    await cnova.mintReward(dave.address, 0, 500_000n);           // create supply + floor
    const before = await cnova.balanceOf(dave.address);
    await cnova.mintReward(dave.address, 0, 0);                  // deposit6 = 0
    expect((await cnova.balanceOf(dave.address)) - before,
      "zero backing = zero mint").to.equal(0n);
  });

  it("FG4 (item 4): with NO treasuryRef the cap cannot price and is NOT applied — the pre-item-4 fixtures stay valid", async () => {
    const { owner, alice } = await loadFixture(deployFloorFixture);
    const cnova2 = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    await cnova2.grantRole(await cnova2.MINTER_ROLE(), owner.address);
    await cnova2.mintReward(alice.address, 0, 0);                // no ref, deposit 0
    expect(await cnova2.balanceOf(alice.address),
      "schedule applies untouched when no floor exists to price against")
      .to.equal(50n * E18);
  });

  // ── item 5: hard floor guard on owner functions ────────────────────────────

  it("FG5 (item 5): emergencyWithdraw against reserve REVERTS once supply exists — 'unusable against reserve' is the decided design", async () => {
    const { cnova, treasury, owner, alice, deposit } = await loadFixture(deployFloorFixture);
    await deposit(500_000n);
    await cnova.mintReward(alice.address, 0, 500_000n);          // supply > 0
    await deposit(9_500_000n);                                   // $10 reserve
    await expect(treasury.emergencyWithdraw(owner.address, 1n, "test"))
      .to.be.revertedWith("Treasury: floor would drop");
  });

  it("FG5b (item 5): before ANY supply exists, emergencyWithdraw still works — the seed floor is constant on both reads", async () => {
    const { treasury, owner, usdc, deposit } = await loadFixture(deployFloorFixture);
    await deposit(10_000_000n);                                  // $10, supply still 0
    const before = await usdc.balanceOf(owner.address);
    await treasury.emergencyWithdraw(owner.address, 3_000_000n, "pre-launch recovery");
    expect((await usdc.balanceOf(owner.address)) - before).to.equal(3_000_000n);
    expect(await treasury.usdcReserve()).to.equal(7_000_000n);
  });

  it("FG6 (item 5): addDexLiquidity spending reserve REVERTS on the floor guard, even through a compliant router", async () => {
    const { cnova, treasury, alice, deposit } = await loadFixture(deployFloorFixture);
    await deposit(500_000n);
    await cnova.mintReward(alice.address, 0, 500_000n);          // supply > 0
    await deposit(9_500_000n);

    // Open Universe Mode via the 500-member gate, with a mock tracker.
    const tracker = await (await ethers.getContractFactory("MockMemberCount")).deploy();
    await treasury.setMemberTracker(await tracker.getAddress());
    await treasury.setFreeMode();

    const router = await (await ethers.getContractFactory("MockDexRouter")).deploy();
    await expect(treasury.addDexLiquidity(
      await router.getAddress(), 0n, 1_000_000n, 0n, 0n, 4_102_444_800n
    )).to.be.revertedWith("Treasury: floor would drop");
  });

  // ── item 6: one floor formula ──────────────────────────────────────────────

  it("FG7 (item 6): a direct USDC transfer to the treasury no longer inflates DirectSale's floor — both views agree on usdcReserve", async () => {
    const { cnova, treasury, usdc, owner, alice, deposit } = await loadFixture(deployFloorFixture);
    await deposit(500_000n);
    await cnova.mintReward(alice.address, 0, 500_000n);
    await deposit(4_500_000n);                                   // floor $0.10

    const ds = await (await ethers.getContractFactory("CNOVADirectSale")).deploy(
      await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
      owner.address, owner.address, 500_000_000n, 1_000_000_000n
    );

    expect(await ds.floorPriceE6(), "views agree before").to.equal(await treasury.floorPrice());

    // The divergence trigger: USDC reaching the treasury OUTSIDE depositReserve.
    await usdc.mint(owner.address, 50_000_000n);
    await usdc.transfer(await treasury.getAddress(), 50_000_000n); // $50 loose

    expect(await treasury.floorPrice(), "treasury floor unmoved by loose USDC").to.equal(100_000n);
    expect(await ds.floorPriceE6(),
      "pre-fix this read $1.10 per CNOVA off balanceOf; now it reads the one true formula")
      .to.equal(100_000n);
  });
});
