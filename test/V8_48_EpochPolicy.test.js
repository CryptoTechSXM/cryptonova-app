"use strict";
/**
 * V8_48_EpochPolicy.test.js — the epoch triple-trigger must stay coherent.
 *
 * WHY THIS FILE EXISTS
 *   On 2026-08-12 the live V8.47 set was measured: 27,776 TokensMinted events
 *   across 671 unique members. mintReward fires on EVERY seat — register,
 *   upgrade, crossing, re-entry, rescue re-seat — while `countedMember` counts a
 *   person once, ever. 41 seats per person. So MINT and MEMBER were denominated
 *   in quantities ~41x apart, and epochs 2, 3 and 4 cost 2,150,000 CNOVA while
 *   26 new members joined. All three advances were TRIGGER_MINT. MEMBER had
 *   never fired, and at epochMemberLimit = 10,000 it never could have.
 *
 *   Nothing was leaking — predicted treasury inflow matched usdcReserve to a
 *   ratio of 1.000, so every one of those seats paid a real fee. The fault was
 *   entirely in the limits.
 *
 * WHAT THIS FILE GUARDS
 *   Not "the constants equal the numbers we picked" — that is a change detector
 *   and tells a future reader nothing about why. Each test below encodes the
 *   REASON a value is what it is, so changing the policy fails with an
 *   explanation rather than a diff.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E18 = 10n ** 18n;

// The design assumption, stated once and used by the tests that depend on it.
// Testnet measured 164 multiplier units per member under bot churn against
// matrices that fill in hours. Real users are estimated at 10-40. 20 is the
// figure epochMemberLimit is sized against; if that estimate is ever revised,
// this constant and the limit move together or the test below fails.
const DESIGN_UNITS_PER_MEMBER = 20n;
const FIXED_EPOCHS = 8n;   // epochs 1-8 use the table; epoch 9 is the formula

describe("V8.48 — epoch policy invariants", function () {
  this.timeout(300_000);

  async function deployed() {
    const [owner, alice, minter] = await ethers.getSigners();
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    await cnova.grantRole(await cnova.MINTER_ROLE(), minter.address);
    return { cnova, owner, alice, minter };
  }

  it("the bonus era cannot eat the supply Final Frontier needs to run in", async function () {
    const { cnova } = await loadFixture(deployed);
    const mintLimit = await cnova.epochMintLimit();
    const maxSupply = await cnova.MAX_SUPPLY();

    // Final Frontier mints rewardPct * TREASURY_PER_ENTRY / (100 * floor) —
    // $0.375 of CNOVA per $0.50 of treasury inflow, constant in dollars and
    // shrinking in tokens as the floor rises. Supply therefore grows as the
    // treasury to the power 0.75, so FF's entire runway is whatever headroom
    // the fixed schedule leaves it:
    //     bonus era ends at  8M -> treasury may grow 3.6x before MAX_SUPPLY
    //     bonus era ends at 20M -> treasury may grow 6.7%
    // Requiring the fixed schedule to fit in HALF of MAX_SUPPLY keeps the
    // multiple comfortably above 3x. The governance menu offers 2.5M and 5M for
    // this parameter; both fail here, which is the point.
    expect(mintLimit * FIXED_EPOCHS, "8 fixed epochs must fit in half of MAX_SUPPLY, or Final Frontier has no room to operate")
      .to.be.lte(maxSupply / 2n);
  });

  it("MEMBER must be able to fire before MINT at the churn the system is designed for", async function () {
    const { cnova } = await loadFixture(deployed);
    const memberLimit = await cnova.epochMemberLimit();
    const mintLimit   = await cnova.epochMintLimit();
    const genesis     = await cnova.epochRewards(0);

    // Epoch 1 is the binding case: the reward is highest there, so if MEMBER can
    // lead in epoch 1 it can lead in every later epoch. A member limit that
    // cannot lead is not a conservative setting — it is a dead trigger, and a
    // dead trigger shown to the community as a progress bar is worse than none.
    const emissionAtDesignChurn = memberLimit * DESIGN_UNITS_PER_MEMBER * genesis;
    expect(emissionAtDesignChurn,
      `at ${DESIGN_UNITS_PER_MEMBER} units/member, ${memberLimit} members emit ` +
      `${emissionAtDesignChurn / E18} CNOVA in epoch 1 — above epochMintLimit, so MINT ` +
      `fires first and epochMemberLimit can never be reached`
    ).to.be.lte(mintLimit);

    // And the old value must stay rejected. 10,000 needed members to average
    // under 2 units each, in a matrix whose whole purpose is to cycle them.
    const oldValue = 10_000n;
    expect(oldValue * DESIGN_UNITS_PER_MEMBER * genesis,
      "10,000 was the dead value this invariant exists to exclude — if it now passes, the invariant is wrong"
    ).to.be.gt(mintLimit);
  });

  it("every default is reachable from the governance menu, so the DAO can restore it", async function () {
    // A value set by admin but absent from V8Governance's allowed list is a
    // one-way door: the DAO can vote to change it and never vote it back. This
    // caught a live near-miss — 2,500 was briefly the recommended member limit
    // and is not on the menu ([100, 500, 1000, 5000, 10000, 50000, 100000]).
    const { cnova, owner } = await loadFixture(deployed);
    const gov = await (await ethers.getContractFactory("V8Governance")).deploy(
      await cnova.getAddress(), owner.address, owner.address
    );

    const PARAM_MINT = 31, PARAM_MEMBER = 32, PARAM_TIME = 33;
    const cases = [
      ["epochMintLimit",   PARAM_MINT,   await cnova.epochMintLimit()],
      ["epochMemberLimit", PARAM_MEMBER, await cnova.epochMemberLimit()],
      ["epochTimeLimit",   PARAM_TIME,   await cnova.epochTimeLimit()],
    ];
    for (const [name, paramId, value] of cases) {
      const menu = await gov.getAllowedValues(paramId);
      expect(menu.length, `${name} has no governance menu at all`).to.be.gt(0);
      expect(menu.map(String), `${name} default ${value} is not on its governance menu [${menu.join(", ")}] — the DAO could never restore it`)
        .to.include(String(value));
    }
  });

  it("TIME is a dormancy backstop, not the schedule", async function () {
    const { cnova } = await loadFixture(deployed);
    const timeLimit = await cnova.epochTimeLimit();

    // At 30 days the whole nine-epoch schedule expires in eight months whether
    // or not one person joins — the Genesis bonus spent on the calendar rather
    // than on early members. Require at least 90 days so slow-but-honest growth
    // gets a chance to earn its epochs on members first.
    expect(timeLimit, "epochTimeLimit below 90 days lets the calendar outrun genuine growth")
      .to.be.gte(90n * 24n * 3600n);
    // And still bounded — an idle project must not hold Genesis rates open forever.
    expect(timeLimit, "epochTimeLimit must stay within the setter's 365-day ceiling")
      .to.be.lte(365n * 24n * 3600n);
  });

  it("THE FAILURE MODE: at MAX_SUPPLY mintReward pays ZERO and does not revert", async function () {
    // This is why epochMintLimit is a hard ceiling rather than a preference. If
    // the bonus era exhausts supply, members do not get an error telling them
    // the well is dry — mintReward silently truncates and hands them nothing,
    // and every downstream `try ... {} catch {}` in MatrixLogicLib treats that
    // as success. Proving it here is what makes the first test in this file
    // more than an opinion.
    const { cnova, alice, minter, owner } = await loadFixture(deployed);
    const maxSupply = await cnova.MAX_SUPPLY();

    // Fill to 100 wei short of the cap.
    await cnova.grantRole(await cnova.MINTER_ROLE(), owner.address);
    await cnova.mintDirect(alice.address, maxSupply - 100n);
    expect(await cnova.totalMinted()).to.equal(maxSupply - 100n);

    // T10 in epoch 1 wants 640 * 50 = 32,000 CNOVA. It gets 100 wei, quietly.
    const before = await cnova.balanceOf(alice.address);
    await expect(cnova.connect(minter).mintReward(alice.address, 9, 0),
      "truncation must not revert — that is precisely what makes it invisible").to.not.be.reverted;
    expect((await cnova.balanceOf(alice.address)) - before,
      "the member asked for 32,000 CNOVA and received 100 wei").to.equal(100n);
    expect(await cnova.totalMinted()).to.equal(maxSupply);

    // And from here on every member receives nothing at all, still silently.
    const atCap = await cnova.balanceOf(alice.address);
    await expect(cnova.connect(minter).mintReward(alice.address, 0, 0)).to.not.be.reverted;
    expect((await cnova.balanceOf(alice.address)) - atCap,
      "past the cap every reward is zero and nothing tells the member").to.equal(0n);
  });

  it("the three triggers still work at the new defaults", async function () {
    // Guards against a policy change that satisfies the arithmetic above while
    // breaking the mechanism — e.g. a limit of zero, which passes every <= test
    // in this file and would advance the epoch on the very first mint.
    const { cnova, minter, alice } = await loadFixture(deployed);
    expect(await cnova.epochMemberLimit(), "a zero member limit would advance on the first mint").to.be.gt(0n);
    expect(await cnova.epochMintLimit()).to.be.gt(0n);
    expect(await cnova.epochTimeLimit()).to.be.gt(0n);

    expect(await cnova.currentEpoch()).to.equal(0);
    await cnova.connect(minter).mintReward(alice.address, 0, 0);
    expect(await cnova.currentEpoch(), "one ordinary T1 entry must not advance anything").to.equal(0);
    expect(await cnova.epochMemberCount(), "and it must count as exactly one member").to.equal(1n);
  });
});
