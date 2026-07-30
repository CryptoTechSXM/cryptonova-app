"use strict";
/**
 * V8_46_EpochMemberCount.test.js — V8.46 item 9.
 *
 * mintReward runs on EVERY seat (register, upgrade, crossing, re-entry, rescue
 * re-seat), so epochMemberCount used to tick per seat-event, not per person — the
 * figure-8 loop inflated it far past the real member count (8,330 vs 2,762 on V8.45).
 * The fix gates the increment on a LIFETIME `countedMember` flag: a member is
 * counted once, ever. These tests prove the counter now tracks PEOPLE.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

async function deployToken() {
  const [admin, minter, alice, bob, carol, dave] = await ethers.getSigners();
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  await cnova.connect(admin).grantRole(await cnova.MINTER_ROLE(), minter.address);
  return { cnova, admin, minter, alice, bob, carol, dave };
}

describe("V8.46 item 9 — epochMemberCount counts unique members, not seat events", function () {

  it("counts each member once, no matter how many times they are re-seated", async function () {
    const { cnova, minter, alice, bob, carol } = await deployToken();

    await cnova.connect(minter).mintReward(alice.address, 0);
    await cnova.connect(minter).mintReward(bob.address, 0);
    await cnova.connect(minter).mintReward(carol.address, 0);
    expect(await cnova.epochMemberCount()).to.equal(3);

    // the figure-8 loop: re-seat the SAME three many times across tiers
    for (let i = 0; i < 5; i++) {
      await cnova.connect(minter).mintReward(alice.address, 0);
      await cnova.connect(minter).mintReward(bob.address, 1);
      await cnova.connect(minter).mintReward(carol.address, 2);
    }
    expect(await cnova.epochMemberCount()).to.equal(3);           // unchanged — no double count
    expect(await cnova.countedMember(alice.address)).to.equal(true);
  });

  it("MEMBER trigger advances on NEW people, never on re-mints of the same member", async function () {
    const { cnova, admin, minter, alice, bob, carol, dave } = await deployToken();
    await cnova.connect(admin).setEpochMemberLimit(3);

    // re-mint one member 10× — one unique person — must NOT advance the epoch
    for (let i = 0; i < 10; i++) await cnova.connect(minter).mintReward(alice.address, 0);
    expect(await cnova.currentEpoch()).to.equal(0);
    expect(await cnova.epochMemberCount()).to.equal(1);

    await cnova.connect(minter).mintReward(bob.address, 0);    // count -> 2
    await cnova.connect(minter).mintReward(carol.address, 0);  // count -> 3
    expect(await cnova.currentEpoch()).to.equal(0);            // advance triggers on the NEXT mint

    await cnova.connect(minter).mintReward(dave.address, 0);   // _tryAdvance sees 3 >= 3 -> epoch 1
    expect(await cnova.currentEpoch()).to.equal(1);
  });

  it("a member counted in one epoch is NOT recounted after an advance (lifetime gate)", async function () {
    const { cnova, minter, alice, bob } = await deployToken();

    await cnova.connect(minter).mintReward(alice.address, 0);
    expect(await cnova.epochMemberCount()).to.equal(1);

    // advance to the next epoch via the TIME trigger
    await time.increase(30 * 24 * 3600 + 1);
    await cnova.connect(minter).mintReward(bob.address, 0);    // advance -> epoch 1, reset; bob counted
    expect(await cnova.currentEpoch()).to.equal(1);
    expect(await cnova.epochMemberCount()).to.equal(1);        // bob only

    // alice re-enters in epoch 1 — already counted for life, must not tick again
    await cnova.connect(minter).mintReward(alice.address, 0);
    expect(await cnova.epochMemberCount()).to.equal(1);        // still just bob
  });
});
