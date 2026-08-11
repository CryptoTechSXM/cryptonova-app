"use strict";
/**
 * V8_48_SplitGrace.test.js — V8.48 item 12: grace applies to LOANS, not to a member's
 * own money.
 *
 * THE CHANGE
 *   _checkParked used to apply one parkedGracePeriod (24h live) before it knew anything
 *   about the member. It now applies that window only when the rescue draws Stability
 *   Fund money. A member whose withdrawable + crossing reserve already covers the entry
 *   fee costs the fund nothing, so they clear a short race guard instead —
 *   selfFundedGracePeriod, 5 minutes, matching fastlane_rescue.js's MIN_AGE.
 *
 * WHY THE MOCKS
 *   The branch fires only for a self-funded parked member, and a real local fixture
 *   cannot produce one: members park with ~20-28% of a fee in earnings against a flat
 *   50% reserve, landing near 80%, and their withdrawable freezes at park time. 25
 *   members, 70 members — same answer. The state is real on chain but rare, and the
 *   numbers below are the ones the chain actually produced.
 *
 * THE HISTORY THIS ENCODES
 *   This change was built, reverted, and restored inside one session:
 *     - built on the reading that fastlane_rescue.js implements a policy the contract
 *       cannot express;
 *     - REVERTED after a live census found 0 of 240 parked members self-funded;
 *     - RESTORED after fastlane.log showed two zero-debt rescues at 00:03 on
 *       2026-08-11 ($5.00 + $5.44 vs a $10 fee; $12.50 + $14.76 vs $25) followed by
 *       thirteen runs at zero.
 *   The census was not wrong, it was CENSORED: fastlane clears these members within ten
 *   minutes, so a snapshot samples the residue. A rare state is not an absent one, and
 *   a point-in-time count cannot tell the difference. That is what these tests pin.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);
const WORK_PARKED_RESCUE = 4;
const WORK_EVICT_PARKED = 6;

const FEE = M6(10);
const RESERVE = M6(5);          // CROSSING_RESERVE_BPS = 5000, a flat 50% of the fee
const SELF_GRACE = 300;         // 5 min
const PARKED_GRACE = 24 * 3600; // 24h, the live setting

function decode(performData) {
  if (!performData || performData === "0x") return [];
  const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], performData);
  return items.map((i) => ({ workType: Number(i.workType), addr2: i.addr2 }));
}

describe("V8.48 item 12 — grace protects against LOANS, not against your own money", function () {
  this.timeout(300_000);

  let keeper, matA, sf, owner, alice;

  // One tier, one pair, MatA only. rotationCount stays 0 so the idle sweep returns on
  // its first line and tierVelocityGreen is true so the gate scan skips — the only work
  // items that can appear are parked ones. Isolation is the point.
  async function setup({ sfBalance = M6(10_000) } = {}) {
    [owner, alice] = await ethers.getSigners();
    const tr = await (await ethers.getContractFactory("MockTierRouterK")).deploy();
    sf = await (await ethers.getContractFactory("MockStabilityFundK")).deploy(sfBalance);
    await sf.setTier(0, sfBalance);

    const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
    keeper = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: await lib.getAddress() },
    })).deploy(await tr.getAddress(), await sf.getAddress());

    matA = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
    const matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
    const pm = await (await ethers.getContractFactory("MockPairManagerK")).deploy();
    await pm.addPair(await matA.getAddress(), await matB.getAddress());
    await keeper.setPairManager(0, await pm.getAddress());

    await keeper.setParkedGracePeriod(PARKED_GRACE);
    await keeper.setSelfFundedGracePeriod(SELF_GRACE);
    // Keep the velocity item out of the batch so assertions read cleanly.
    await time.increase(10);
  }

  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  async function items() {
    const [, data] = await keeper.checkUpkeep("0x");
    return decode(data).filter((i) => i.workType === WORK_PARKED_RESCUE || i.workType === WORK_EVICT_PARKED);
  }
  const rescuedMe = async (who) =>
    (await items()).some((i) => i.workType === WORK_PARKED_RESCUE && i.addr2 === who);

  // ── the case that motivated the change ────────────────────────────────────
  it("SELF-FUNDED: discoverable after 5 minutes, not after 24 hours", async function () {
    await setup();
    // The exact live shape: reserve $5.00 + earnings $5.44 against a $10 fee.
    await matA.addParked(alice.address, await now(), M6(5.438759), RESERVE, 0);

    expect(await rescuedMe(alice.address), "must NOT fire inside the 5-minute race guard").to.equal(false);

    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address),
      "a member whose own money covers the fee must be discoverable once the race guard passes — " +
      "waiting 24h for a loan they do not need is the whole defect").to.equal(true);

    // And still true long before the loan window would have opened.
    await time.increase(3600);
    expect(await rescuedMe(alice.address)).to.equal(true);
  });

  it("EXACTLY at the fee is self-funded — the boundary is >=, matching fastlane's `wd + rs < fee`", async function () {
    await setup();
    await matA.addParked(alice.address, await now(), FEE - RESERVE, RESERVE, 0); // sums to exactly FEE
    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address), "wd + rs == fee costs the fund nothing").to.equal(true);
  });

  it("ONE UNIT SHORT is a loan and waits the full 24 hours", async function () {
    await setup();
    await matA.addParked(alice.address, await now(), FEE - RESERVE - 1n, RESERVE, 0);

    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address),
      "one unit short means the fund lends — the loan-protection window applies").to.equal(false);

    await time.increase(PARKED_GRACE);
    expect(await rescuedMe(alice.address), "and it fires once that window closes").to.equal(true);
  });

  // ── the population the live chain is actually made of ─────────────────────
  it("the 84% member — the live median — is unaffected", async function () {
    await setup();
    // Measured 2026-08-11: median parked member sits at 84.2% of the fee,
    // reserve 50% + ~34% earnings. They need a loan and must keep the full window.
    await matA.addParked(alice.address, await now(), M6(3.42), RESERVE, 0);

    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address), "84% of the fee still needs SF money").to.equal(false);
    await time.increase(PARKED_GRACE);
    expect(await rescuedMe(alice.address)).to.equal(true);
  });

  // ── eviction is not a rescue ──────────────────────────────────────────────
  it("EVICTION keeps the full window even when the member is self-funded", async function () {
    await setup();
    // withdrawn/totalEarned above rescueRatioBps (7000) => evict, not rescue.
    await matA.addParked(alice.address, await now(), M6(6), RESERVE, M6(94));

    await time.increase(SELF_GRACE + 5);
    expect((await items()).length,
      "eviction has no zero-cost version and nothing about it is urgent").to.equal(0);

    await time.increase(PARKED_GRACE);
    const found = await items();
    expect(found.length).to.equal(1);
    expect(found[0].workType, "and then it is an EVICT, not a rescue").to.equal(WORK_EVICT_PARKED);
  });

  // ── the compatibility guarantee the equivalence test leans on ─────────────
  it("selfFundedGracePeriod == parkedGracePeriod restores the OLD behaviour exactly", async function () {
    await setup();
    await keeper.setSelfFundedGracePeriod(3600);
    await keeper.setParkedGracePeriod(3600);
    await matA.addParked(alice.address, await now(), M6(9), RESERVE, 0); // self-funded

    await time.increase(600);
    expect(await rescuedMe(alice.address), "with the two equal, no early path exists").to.equal(false);
    await time.increase(3600);
    expect(await rescuedMe(alice.address)).to.equal(true);
  });

  // ── the SF check must not gate a rescue that needs no SF ──────────────────
  it("a self-funded rescue fires even with the Stability Fund EMPTY", async function () {
    await setup({ sfBalance: 0n });
    await matA.addParked(alice.address, await now(), M6(6), RESERVE, 0);
    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address),
      "sfShare is 0, so an empty fund is irrelevant — this is the T8/T9/T10 case, " +
      "where balanceByTier is $0.00 on the live chain").to.equal(true);
  });

  it("a LOAN rescue does NOT fire when the fund cannot cover it", async function () {
    await setup({ sfBalance: 0n });
    await matA.addParked(alice.address, await now(), M6(1), RESERVE, 0); // 60% of fee
    await time.increase(PARKED_GRACE + 10);
    expect(await rescuedMe(alice.address), "no money, no loan").to.equal(false);
  });

  // ── the setter ────────────────────────────────────────────────────────────
  it("setSelfFundedGracePeriod is governed and enumerated", async function () {
    await setup();
    for (const v of [0, 60, 300, 900, 1800, 3600]) {
      await keeper.setSelfFundedGracePeriod(v);
      expect(await keeper.selfFundedGracePeriod()).to.equal(v);
    }
    await expect(keeper.setSelfFundedGracePeriod(301)).to.be.revertedWith(
      "MK: invalid self-funded grace (0/60/300/900/1800/3600)");
    await expect(keeper.setSelfFundedGracePeriod(86400)).to.be.reverted;
    await expect(keeper.connect(alice).setSelfFundedGracePeriod(60)).to.be.revertedWith("MK: not authorized");
  });

  it("defaults to 300s, matching fastlane_rescue.js MIN_AGE", async function () {
    await setup();
    const fresh = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: {
        MatrixKeeperLib: await (await (await ethers.getContractFactory("MatrixKeeperLib")).deploy()).getAddress(),
      },
    })).deploy(await (await (await ethers.getContractFactory("MockTierRouterK")).deploy()).getAddress(),
               await sf.getAddress());
    expect(await fresh.selfFundedGracePeriod()).to.equal(300);
  });

  // ── a zero floor is allowed, and means what it says ───────────────────────
  it("selfFundedGracePeriod = 0 makes a self-funded member discoverable immediately", async function () {
    await setup();
    await keeper.setSelfFundedGracePeriod(0);
    await matA.addParked(alice.address, await now(), M6(6), RESERVE, 0);
    expect(await rescuedMe(alice.address), "0 means no floor at all").to.equal(true);
  });
});
