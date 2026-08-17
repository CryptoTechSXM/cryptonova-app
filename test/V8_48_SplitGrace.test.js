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
 *
 * TOUCHED BY V8.49 ITEM 1 (the eviction clock) — one test, EXTENDED not weakened.
 *   This file was not on the list of fixtures item 1 expected to break; the full suite
 *   found it. Its eviction test asserted "waits the FULL window", written when eviction
 *   and rescue shared parkedGracePeriod, so it read the 24h clock as the answer rather
 *   than as one of two. It now walks all three windows in order. Worth noting for the
 *   next session: a fixture can encode a coincidence as an intention without anyone
 *   choosing to, and the only thing that finds it is running everything.
 *
 * RE-FIXTURED BY V8.50 ITEM A — AND THE ARITHMETIC IS UNCHANGED BY THE MOVE.
 *   Item A pays an A->B crossing out of the member's own crossing reserve, so crossing
 *   OUT of a MatA now costs 50% of the fee and a MatA parker holding the flat 50%
 *   reserve covers it outright. The loan path did not get rarer in a MatA — it stopped
 *   existing there (measured: 35 of 35 live MatA parkers self-fund). So the three tests
 *   that need a LOAN moved to the pair's MatB, where a cycle-out re-enters a MatA at the
 *   FULL fee and a member can still be short. The self-funded tests stay in the MatA:
 *   that case did not move, it got commoner.
 *
 *   Each moved member keeps its exact effective contribution — withdrawable becomes the
 *   old (withdrawable + reserve) and the reserve becomes 0, because item A leaves a MatB
 *   member holding NO reserve; it was spent getting them there. So every wBps, every
 *   shortfall and every sfShare below is the same number it was before item A. Only the
 *   matrix and the pocket changed. That is deliberate: these tests pin item 12's rule
 *   (grace protects against loans), not item A's economics.
 *
 *   THE POPULATION, MEASURED — live V8.48, 2026-08-16, scripts/model_item_a.js, n=63
 *   members who completed a journey. Post-item-A the re-entry ask runs min $0.00 /
 *   median $2.71 / max $4.28, so a member arrives at a $10 re-entry holding between
 *   $5.72 and $10.00. Every fixture below sits inside that band.
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
// V8.49 item 1: the EVICTION clock, split out of parkedGracePeriod. Declared default,
// asserted below rather than assumed — this file must exercise what ships.
const EVICT_GRACE = 7 * 24 * 3600;

function decode(performData) {
  if (!performData || performData === "0x") return [];
  const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], performData);
  return items.map((i) => ({ workType: Number(i.workType), addr2: i.addr2 }));
}

describe("V8.48 item 12 — grace protects against LOANS, not against your own money", function () {
  this.timeout(300_000);

  let keeper, matA, matB, sf, owner, alice;

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
    // V8.50 item A: the pair's MatB is now flagged as one, because the tests below need
    // a crossing that still costs a FULL fee — the MatB cycle-out that re-enters a MatA.
    // Flipping it does NOT let the frozen-MatB scan into the batch: _isFrozenMatB returns
    // on `occupancy() < MATRIX_SIZE()` and this mock's occupancy is always 0.
    matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, false);
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
    // V8.50 item A: at a MatB re-entry the member holds no reserve and the crossing is
    // the full fee, so "one unit short" is withdrawable alone. Effective FEE - 1 against
    // a FEE crossing is the same 9,999 bps this asserted before item A moved the money.
    await matB.addParked(alice.address, await now(), FEE - 1n, 0, 0);

    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address),
      "one unit short means the fund lends — the loan-protection window applies").to.equal(false);

    await time.increase(PARKED_GRACE);
    expect(await rescuedMe(alice.address), "and it fires once that window closes").to.equal(true);
  });

  // ── the population the live chain is actually made of ─────────────────────
  it("the MEDIAN re-entry member — the live population — is unaffected", async function () {
    await setup();
    // WAS "the 84% member": reserve 50% + ~34% earnings = 84.2% of the fee, measured
    // 2026-08-11 at an A->B crossing. Item A retired that member — in a MatA the reserve
    // now pays the crossing outright. The population this test exists to represent moved
    // to the MatB re-entry, and it was re-measured there: model_item_a.js on live V8.48,
    // 2026-08-16, n=63, median ask $2.71 — so the median member arrives holding $7.29 of
    // a $10 re-entry, 72.9%. Still a loan, so still the full window. The number changed
    // because the world did; the rule under test did not.
    await matB.addParked(alice.address, await now(), M6(7.29), 0, 0);

    await time.increase(SELF_GRACE + 5);
    expect(await rescuedMe(alice.address), "a $2.71 ask is SF money, not their own").to.equal(false);
    await time.increase(PARKED_GRACE);
    expect(await rescuedMe(alice.address)).to.equal(true);
  });

  // ── eviction is not a rescue ──────────────────────────────────────────────
  //
  // V8.49 item 1 EXTENDED this test; it did not change what it asserts. Item 12's claim
  // — a member who can pay for themselves does not make EVICTION cheap, so the 5-minute
  // race guard never applies to it — is untouched and is still the first assertion below.
  // What V8.49 added is the second one: the 24-hour RESCUE clock does not evict anyone
  // either. Eviction used to fire at exactly that moment, because the evict branch gated
  // on parkedGracePeriod. Owner policy has always been 3-5 days; it had simply never been
  // built, and it had never been noticed because evictions could not fire AT ALL until
  // V8.48 put the valve on chain and authorized the keeper.
  it("EVICTION gets neither short window — not the self-funded race guard, not the rescue clock", async function () {
    await setup();
    expect(await keeper.evictionGracePeriod(),
      "this test must exercise the SHIPPING default, not a value it set for itself").to.equal(BigInt(EVICT_GRACE));

    // withdrawn/totalEarned above rescueRatioBps (7000) => evict, not rescue. They are
    // ALSO self-funded ($6 withdrawable + $5 reserve against a $10 fee) — that pairing
    // is the whole fixture: being able to fund your own re-entry is what would have
    // qualified you for the short window, if eviction were a rescue. It is not.
    await matA.addParked(alice.address, await now(), M6(6), RESERVE, M6(94));

    await time.increase(SELF_GRACE + 5);
    expect((await items()).length,
      "item 12: eviction has no zero-cost version, so the self-funded race guard never applies").to.equal(0);

    await time.increase(PARKED_GRACE);
    expect((await items()).length,
      "V8.49 item 1: the rescue clock does not evict either — these days belong to the " +
      "member, to self-rescue before the valve takes their seat").to.equal(0);

    await time.increase(EVICT_GRACE - PARKED_GRACE);
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
    // 60% of a full-fee MatB re-entry, near the poor end of the measured post-item-A
    // band ($5.72 is the largest measured ask's member). They need $4.00; there is $0.00.
    await matB.addParked(alice.address, await now(), M6(6), 0, 0);
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
