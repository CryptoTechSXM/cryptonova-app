"use strict";
/**
 * V8_50_CapOneVelocity.test.js — THE COST OF maxItemsPerUpkeep = 1, ASSERTED ON PURPOSE.
 *
 * WHY THIS FILE EXISTS (session 53, 2026-08-31)
 * ─────────────────────────────────────────────
 * A full-suite run came back 650 passing / 12 FAILING against a tree whose last recorded
 * full-suite green was 2026-08-17 — two weeks earlier. Ten of the twelve failures had one
 * cause, and it was not a bug in anything:
 *
 *   5a07cab (2026-08-23) changed maxItemsPerUpkeep's DEFAULT from 15 to 1.
 *
 *   MatrixKeeperLib.discover() allocates WorkItem[](cfg.maxItems) and hands slot 0 to the
 *   VELOCITY item whenever `block.timestamp >= lastVelocityCheck + velocityWindow`. At
 *   cap 1 a due velocity check therefore consumes the ENTIRE batch and discovery returns
 *   nothing else — no parked rescue, no eviction, no ghost, no reclaim, on that tick.
 *
 * Four discovery fixtures advance time past a 24h grace period while velocityWindow is 4h,
 * so velocity was always due in them, so their per-member assertions all saw an empty list.
 * They are now pinned to cap 15 with the reasoning written at the pin.
 *
 * ⛔ THE POINT OF *THIS* FILE IS THAT PINNING THOSE FIXTURES HIDES THE BEHAVIOUR AGAIN.
 * Cap 1 is the right shipping value — handoff 30.10a/30.10b, the only setting provably
 * safe against a 14.67M worst-case item on a ~16.5M budget — so the trade it makes should
 * be VISIBLE and DELIBERATE, not rediscovered as a bug in three weeks. That is the whole
 * job here: state the cost out loud so nobody has to find it twice.
 *
 * ▶ THE LIVE CONSEQUENCE, WHICH IS THE REASON TO CARE. velocityWindow is 4 hours and
 *   deploy_v8.js does NOT call setMaxItemsPerUpkeep, so production runs at 1. Every four
 *   hours one keeper tick is spent entirely on the velocity check and discovers no member
 *   work at all. That is tolerable ONLY because _doVelocityCheck succeeds and advances
 *   lastVelocityCheck. If it ever stops advancing — a revert, or a driver that filters
 *   velocity items out of the batch — velocity is due on EVERY tick, the single slot is
 *   consumed forever, and member work is NEVER discovered. That is not hypothetical: the
 *   velocity check reverted on every deployment before V8.50 (8c60b64, the activateLayer
 *   selector that was declared and never implemented). CV3 is the tripwire for it.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);
const WORK_VELOCITY = 0;
const WORK_PARKED_RESCUE = 4;
const PARKED_GRACE = 24 * 3600;

describe("V8.50 — maxItemsPerUpkeep = 1: the velocity item owns the only slot", function () {
  let keeper, matA, matB, alice;

  function decode(performData) {
    if (!performData || performData === "0x") return [];
    const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], performData);
    return items.map((i) => ({ workType: Number(i.workType), addr2: i.addr2 }));
  }
  const discovered = async () => decode((await keeper.checkUpkeep("0x"))[1]);

  beforeEach(async function () {
    const sigs = await ethers.getSigners();
    alice = sigs[1];
    const tr = await (await ethers.getContractFactory("MockTierRouterK")).deploy();
    const sfMock = await (await ethers.getContractFactory("MockStabilityFundK")).deploy(M6(10_000));
    await sfMock.setTier(0, M6(10_000));
    const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
    keeper = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: await lib.getAddress() },
    })).deploy(await tr.getAddress(), await sfMock.getAddress());
    matA = await (await ethers.getContractFactory("MockMatrixK")).deploy(M6(10), true);
    matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(M6(10), false);
    const pm = await (await ethers.getContractFactory("MockPairManagerK")).deploy();
    await pm.addPair(await matA.getAddress(), await matB.getAddress());
    await keeper.setPairManager(0, await pm.getAddress());
    await keeper.setParkedGracePeriod(PARKED_GRACE);

    // One unambiguous piece of member work: alice parked, $7.00 against a $10.00 fee,
    // well past the loan clock. Nothing about this test depends on WHICH work type she
    // earns — only on whether she is discovered at all.
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await matB.addParked(alice.address, now, M6(7), 0, 0);
    await time.increase(PARKED_GRACE + 5);
  });

  it("CV1: at cap 1 with a velocity check due, the batch is velocity ONLY and member work is invisible", async function () {
    // The shipping default. Asserted, not assumed.
    expect(await keeper.maxItemsPerUpkeep(), "cap 1 is the shipping default").to.equal(1n);

    const items = await discovered();
    expect(items.length, "cap 1 means exactly one item, whatever it is").to.equal(1);
    expect(items[0].workType, "and the velocity item takes it — discover() fills slot 0 first")
      .to.equal(WORK_VELOCITY);
    expect(items.filter((i) => i.addr2 === alice.address),
      "⛔ THE COST: a member who is past grace and needs a rescue is NOT discovered on this tick"
    ).to.deep.equal([]);
  });

  it("CV2: the member is discoverable in the same state — the cap was the only thing hiding her", async function () {
    await keeper.setMaxItemsPerUpkeep(15);
    const items = await discovered();
    expect(items.some((i) => i.workType === WORK_VELOCITY),
      "velocity is still due — nothing about the member's state changed").to.equal(true);
    expect(items.filter((i) => i.addr2 === alice.address).map((i) => i.workType),
      "and now she is found, which proves the empty list above was the BATCH SIZE and not her state"
    ).to.deep.equal([WORK_PARKED_RESCUE]);
  });

  it("CV3: TRIPWIRE — once velocity is not due, cap 1 spends its one slot on the member", async function () {
    // The load-bearing assumption in production: lastVelocityCheck advances, so velocity
    // is due only once per velocityWindow and every other tick is free for member work.
    //
    // ⛔ IF THIS GOES RED, THE KEEPER IS STARVED. It means a due velocity item is being
    // produced unconditionally, and at cap 1 that is a permanent discovery outage: no
    // parked member is ever rescued, evicted or reclaimed again.
    // Advance lastVelocityCheck the way production does — by PERFORMING the velocity item.
    // Hand-encoded as a batch of exactly one so this test has no side effects on alice's
    // parked record; performUpkeep wraps each item in try/catch, so a mock world cannot
    // make this revert.
    const velocityOnly = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
      [[[WORK_VELOCITY, 0, ethers.ZeroAddress, ethers.ZeroAddress]]]);
    await keeper.performUpkeep(velocityOnly);
    expect(await keeper.lastVelocityCheck(), "the velocity clock must have moved").to.be.gt(0n);

    const items = await discovered();
    expect(items.some((i) => i.workType === WORK_VELOCITY),
      "velocity has just run, so it must not be due again inside the window").to.equal(false);
    expect(items.filter((i) => i.addr2 === alice.address).map((i) => i.workType),
      "and the freed slot goes to the member — this is what makes cap 1 survivable in production"
    ).to.deep.equal([WORK_PARKED_RESCUE]);
  });
});
