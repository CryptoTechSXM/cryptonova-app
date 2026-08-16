"use strict";
/**
 * V8_49_EvictionClock.test.js — item 1: the eviction clock is not the rescue clock.
 *
 * THE POLICY THIS ENCODES (owner, V8.48 deploy day, 2026-08-13):
 *   "The SF always grows organically, eviction should not happen for 3 to 5 days. We do
 *    not seed SF, it grows organically. 24hrs of registrations before automated rescue
 *    kicks in on testnet and 48hrs on mainnet — that is by design, to have members
 *    rescue themselves before SF takes over."
 *
 * WHAT WAS ACTUALLY WRONG — AND WHAT WAS NOT. READ THIS BEFORE THE SCOPE.
 *   The scope opened item 1 on the claim that "V8.48 will evict real members 24 hours
 *   after they park". THAT CLAIM WAS FALSE, and finding out why is most of what this
 *   file is for.
 *
 *   It came from reading MatrixKeeperLib's evict branch, which gates DISCOVERY on
 *   parkedGracePeriod (24h). But EXECUTION had its own, independent gate:
 *   MatrixKeeper._doEvictParked refused every non-ghost eviction until
 *   `extendedIdleTimeout` — 7 days, never set at deploy, so 7 days is what has always
 *   shipped. A member could be QUEUED from 24h and simply never evicted: the work item
 *   was consumed and _doEvictParked returned silently. **No member was ever exposed to a
 *   24-hour eviction, in any version.** The owner's 3-5 day policy was already satisfied.
 *
 *   THE REAL DEFECT WAS TWO UNRELATED KNOBS GOVERNING ONE BEHAVIOUR. Neither
 *   parkedGracePeriod (the SF rescue clock) nor extendedIdleTimeout (the idle-slot
 *   RECLAIM clock, borrowed by V8.46 "mirroring _doReclaimSlot") means "eviction". So
 *   eviction timing could not be read off any single value, could not be voted on, and
 *   would move if either unrelated knob moved. And for six of the seven days, discovery
 *   emitted EVICT work items that execution refused — burning slots out of
 *   maxItemsPerUpkeep (15) against a queue of 88 parked members.
 *
 *   V8.49 makes evictionGracePeriod the ONLY eviction clock, read by both sides, and
 *   defaults it to 7 days — exactly what extendedIdleTimeout was already enforcing. So
 *   this change moves nobody's eviction. The policy became REACHABLE (a DAO vote to
 *   3/4/5 days), not enacted. That was the owner's call, 2026-08-16.
 *
 * WHY NOBODY EVER NOTICED, INCLUDING THE SESSION THAT WROTE THE FIRST VERSION OF THIS
 *   Evictions had never fired at all, in any version: evict_parked.js's cron guard
 *   (pgrep -f evict_loop.sh) always matched its own parent shell, so the script never ran
 *   once. V8.48 moved eviction on chain (item 47's valve) AND authorized the keeper EOA,
 *   so V8.48 is the first version that can evict anyone — which is what made this
 *   urgent. But the deeper reason is in this file's own subject: **every test that
 *   existed drove checkUpkeep only.** Discovery was covered and execution was not, so a
 *   disagreement between them could not fail anything. EC-8 is that missing test.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS HERE
 *   EC-1  the three REAL eviction cases (ratio / ladder / floor) wait the new clock,
 *         and produce NO WORK AT ALL in between — they are not rescued either, which is
 *         the point: those days are for the member to self-rescue.
 *   EC-2  a GHOST is still dequeued on the OLD clock. Deliberate (2026-08-15): a parked
 *         record whose holder is already seated costs them nothing to remove, so this
 *         parameter introduces exactly ONE behavioural change, not two.
 *   EC-3  a member who is simply being RESCUED is untouched by any of it.
 *   EC-4  THE COLLAPSE PROPERTY: evictionGracePeriod == parkedGracePeriod reproduces
 *         pre-V8.49 behaviour exactly. This is not a curiosity — it is what keeps
 *         V8_48_KeeperScan.test.js's frozen-keeper equivalence harness meaningful, since
 *         that file pins the two together in setup(). If this test ever fails, that
 *         harness has silently stopped proving anything.
 *   EC-5  the setter menu and the governance menu enumerate the same set, BOTH
 *         directions. A passed proposal carrying a value the keeper's require rejects
 *         reverts at execution — the item-26 "DAO tunable was fiction" class.
 *   EC-6  the declared default is on its own menu (item-42 lesson) and so is 86400,
 *         which is how this change is reversed by vote rather than by redeploy.
 *   EC-8  **DISCOVERY AND EXECUTION AGREE AT EVERY INSTANT.** The one that would have
 *         caught the original defect. Drives performUpkeep, not just checkUpkeep.
 *   EC-9  a ghost still bypasses the execution gate entirely — including the rotation
 *         check, which a non-ghost could not survive.
 *
 * FIXTURE NOTE — why mocks. The four eviction reasons need a parked member with specific
 * withdrawn/withdrawable/reserve ratios and a specific SF verdict. A real pair produces
 * members near 80% of fee and nothing else (see contracts/test/MockKeeperScan.sol's
 * header for the measurement). These reuse the MockKeeperScan harness V8_48_GhostFloor
 * built for exactly this reason.
 *
 * The reason code is internal to discovery: WorkItem's shape is unchanged, so performData
 * still decodes as tuple(uint8,uint8,address,address) — every decode below is that
 * assertion made incidentally, which is enough for a field that never crosses the wire.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);
const FEE = M6(10);                       // T1

const WORK_PARKED_RESCUE = 4;
const WORK_EVICT_PARKED  = 6;

const PARKED_GRACE = 24 * 3600;           // the live testnet rescue clock
const EVICT_GRACE  = 7 * 24 * 3600;       // 604_800 — the declared default

describe("V8.49 item 1 — the eviction clock is separate from the rescue clock", function () {
  this.timeout(600_000);

  let keeper, matA, matB, sfMock;
  let ghost, ratio, ladder, floored, rescued;

  function decode(performData) {
    if (!performData || performData === "0x") return [];
    const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], performData);
    return items.map((i) => ({ workType: Number(i.workType), addr2: i.addr2 }));
  }
  async function workFor(who) {
    const [, data] = await keeper.checkUpkeep("0x");
    return decode(data).filter((i) => i.addr2 === who).map((i) => i.workType);
  }
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

  /**
   * Five parked members, one per triage outcome, all parked at the same instant.
   * The numbers are chosen against the LIVE default ladder (preset 1: bottom rung
   * 4000 bps) and the live rescueRatioBps (7000) — not against round numbers.
   */
  async function setup({ evictGrace = null, rotation = 0 } = {}) {
    const sigs = await ethers.getSigners();
    [ghost, ratio, ladder, floored, rescued] = sigs.slice(1, 6).map((s) => s.address);

    const tr = await (await ethers.getContractFactory("MockTierRouterK")).deploy();
    sfMock = await (await ethers.getContractFactory("MockStabilityFundK")).deploy(M6(10_000));
    await sfMock.setTier(0, M6(10_000));

    // MatrixKeeper is a LINKED contract since V8.48 item 12a — getContractFactory
    // without this throws "missing links" before any test body runs. V8Governance and
    // StabilityFund are NOT linked, which is what misled an earlier draft in this suite.
    const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
    keeper = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: await lib.getAddress() },
    })).deploy(await tr.getAddress(), await sfMock.getAddress());

    // Both mocks report isMatrixA — keeps the frozen-MatB scan out of the batch, so
    // every work item in performData is a parked-queue decision.
    matA = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
    matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
    const pm = await (await ethers.getContractFactory("MockPairManagerK")).deploy();
    await pm.addPair(await matA.getAddress(), await matB.getAddress());
    await keeper.setPairManager(0, await pm.getAddress());
    await keeper.setParkedGracePeriod(PARKED_GRACE);
    if (evictGrace !== null) await keeper.setEvictionGracePeriod(evictGrace);

    const t = await now();
    // addParked(member, parkedAt, withdrawable, crossingReserve, lifetimeWithdrawn)
    //
    // GHOST   — seated in this very matrix; triage returns before reading any numbers.
    await matA.addParked(ghost, t, M6(2), M6(5), 0);
    await matA.setSeated(ghost, true);
    // RATIO   — withdrawn $8 of $10 earned = 8000 bps, past rescueRatioBps (7000).
    await matA.addParked(ratio, t, M6(2), M6(5), M6(8));
    // LADDER  — contribution $0.30 against a $10 fee = 300 bps, below the ladder's
    //           bottom rung (4000). The fund will not cover someone this thin.
    await matA.addParked(ladder, t, M6(0.1), M6(0.2), 0);
    // FLOOR   — a live rescue candidate ($7 of $10 covered, $3 shortfall) whom the SF
    //           refuses on item 46's insolvency floor.
    await matA.addParked(floored, t, M6(2), M6(5), 0);
    await sfMock.setFloored(floored, true);
    // RESCUE  — the control. Identical to FLOOR, minus the floor.
    await matA.addParked(rescued, t, M6(2), M6(5), 0);

    // rotationCount stays 0 by default so _scanMatrix returns on its first line and the
    // only work items are parked ones. EC-8 opts in, because _doEvictParked gates on it.
    if (rotation > 0) await matA.setRotationCount(rotation);

    await time.increase(10);
  }

  /// Drive the EXECUTION side directly: hand performUpkeep one EVICT work item.
  /// Returns the ParkedMemberEvicted events it emitted (none = the gate refused).
  async function evictViaKeeper(who) {
    const pd = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
      [[[WORK_EVICT_PARKED, 0, await matA.getAddress(), who]]]);
    const rc = await (await keeper.performUpkeep(pd)).wait();
    return rc.logs
      .map((l) => { try { return keeper.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).filter((e) => e.name === "ParkedMemberEvicted");
  }

  // ── EC-1 ───────────────────────────────────────────────────────────────────
  it("EC-1: ratio / ladder / floor members are NOT evicted at 24h, are at 7 days, and produce no work in between", async function () {
    await setup();
    expect(await keeper.evictionGracePeriod(),
      "the fixture must be exercising the declared default, not a value it set itself").to.equal(BigInt(EVICT_GRACE));

    await time.increase(PARKED_GRACE + 5);

    // THE HEART OF THE ITEM. Before V8.49 all three were EVICT work items at this
    // instant. Asserting the EMPTY list rather than "not EVICT" is deliberate: they
    // must not be quietly rescued instead, because the SF has already refused each of
    // them for a different reason. These days belong to the member, to self-rescue.
    for (const [name, who] of [["ratio", ratio], ["ladder", ladder], ["floor", floored]]) {
      expect(await workFor(who),
        `${name}: at 24h this member must be left ALONE — not evicted, not rescued`).to.deep.equal([]);
    }

    await time.increase(EVICT_GRACE - PARKED_GRACE + 10);

    for (const [name, who] of [["ratio", ratio], ["ladder", ladder], ["floor", floored]]) {
      expect(await workFor(who),
        `${name}: at 7 days the eviction clock has run and the valve takes them`).to.deep.equal([WORK_EVICT_PARKED]);
    }
  });

  // ── EC-2 ───────────────────────────────────────────────────────────────────
  it("EC-2: a GHOST keeps the OLD clock — dequeued at 24h while a real eviction in the same batch waits", async function () {
    await setup();
    await time.increase(PARKED_GRACE + 5);

    // Decided 2026-08-15, and deliberately the conservative option: ghost behaviour is
    // unchanged by this item. A ghost's holder is already seated — the valve DEQUEUES
    // ONLY, touching no seat, no funds and no position — so there is nobody to protect
    // with a longer wait, and making them linger four days would just hold a queue slot.
    expect(await workFor(ghost),
      "ghost dequeue must not have been slowed down by the eviction clock").to.deep.equal([WORK_EVICT_PARKED]);

    // The contrast, in the same batch and the same block: this is what changed.
    expect(await workFor(floored),
      "a REAL eviction at the same instant must still be waiting").to.deep.equal([]);
  });

  // ── EC-3 ───────────────────────────────────────────────────────────────────
  it("EC-3: an ordinary rescue is untouched — still the rescue clock, before and after", async function () {
    await setup();
    await time.increase(PARKED_GRACE + 5);
    expect(await workFor(rescued),
      "the rescue path must be unaffected by an eviction-only parameter").to.deep.equal([WORK_PARKED_RESCUE]);
    await time.increase(EVICT_GRACE);
    expect(await workFor(rescued),
      "and it must still be a rescue once the eviction clock has also elapsed").to.deep.equal([WORK_PARKED_RESCUE]);
  });

  // ── EC-4 ───────────────────────────────────────────────────────────────────
  it("EC-4: THE COLLAPSE PROPERTY — evictionGracePeriod == parkedGracePeriod reproduces pre-V8.49 behaviour exactly", async function () {
    // V8_48_KeeperScan.test.js pins these two together in setup() so its byte-identical
    // comparison against the frozen pre-refactor keeper still holds. That pin is only
    // honest if the collapse is real. This is the test that says it is; without it the
    // pin could go on masking a genuine divergence and the harness would still be green.
    await setup({ evictGrace: PARKED_GRACE });
    await time.increase(PARKED_GRACE + 5);

    for (const [name, who] of [["ghost", ghost], ["ratio", ratio], ["ladder", ladder], ["floor", floored]]) {
      expect(await workFor(who),
        `${name}: with the clocks equal, every eviction case fires at the old moment`).to.deep.equal([WORK_EVICT_PARKED]);
    }
    expect(await workFor(rescued)).to.deep.equal([WORK_PARKED_RESCUE]);
  });

  // ── EC-8 ───────────────────────────────────────────────────────────────────
  it("EC-8: EXECUTION uses the same clock as discovery — no work item is ever queued that _doEvictParked refuses", async function () {
    // THIS IS THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT, and its absence is
    // why the defect survived to be found by reading rather than by running.
    //
    // Discovery and execution were on DIFFERENT knobs: _checkParked gated on
    // parkedGracePeriod (24h) while _doEvictParked gated on extendedIdleTimeout (7 days,
    // the idle-slot RECLAIM timeout, borrowed). Nothing failed — the work item was
    // queued, consumed, and silently dropped, six days running, burning slots out of
    // maxItemsPerUpkeep against an 88-member queue. Every existing test drove
    // checkUpkeep only, so every existing test was green.
    //
    // The invariant, stated once so it cannot drift again: AT EVERY INSTANT, discovery
    // queueing an eviction and execution accepting it are the SAME answer.
    await setup({ rotation: 1 });

    await time.increase(PARKED_GRACE + 5);
    expect(await workFor(ratio), "discovery: not yet").to.deep.equal([]);
    expect((await evictViaKeeper(ratio)).length,
      "execution: not yet either — the two must refuse together").to.equal(0);

    await time.increase(EVICT_GRACE - PARKED_GRACE + 10);
    expect(await workFor(ratio), "discovery: now").to.deep.equal([WORK_EVICT_PARKED]);
    const evicted = await evictViaKeeper(ratio);
    expect(evicted.length, "execution: now — and they must accept together").to.equal(1);
    expect(evicted[0].args.member).to.equal(ratio);
  });

  it("EC-9: a GHOST bypasses the execution gate entirely, as it always has", async function () {
    // _doEvictParked's ghost branch skips both the rotation check and the clock. That is
    // load-bearing and predates V8.49: a stale record whose holder is seated can be
    // dequeued at any age because it costs them nothing. Pinned here so the reconciliation
    // above cannot quietly swallow it — note rotation stays 0, which a non-ghost could
    // not survive.
    await setup();
    await matA.setSeated(ghost, true);
    const evicted = await evictViaKeeper(ghost);
    expect(evicted.length, "a ghost is dequeued immediately, no clock, no rotation").to.equal(1);
  });

  // ── EC-5 ───────────────────────────────────────────────────────────────────
  describe("the setter and the governance menu", function () {
    async function govFixture() {
      const [owner, stranger] = await ethers.getSigners();
      const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
      const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
      const k = await (await ethers.getContractFactory("MatrixKeeper", {
        libraries: { MatrixKeeperLib: await lib.getAddress() },
      })).deploy(owner.address, owner.address);
      // Constructor is (cnovaToken, tierRouter, matrixKeeper); only non-zero addresses
      // are needed to read a menu.
      const g = await (await ethers.getContractFactory("V8Governance"))
        .deploy(await cnova.getAddress(), owner.address, await k.getAddress());
      return { owner, stranger, k, g };
    }

    it("EC-5: the keeper's require and the DAO menu enumerate the SAME set, both directions", async function () {
      const { k, g } = await govFixture();
      const id = await g.PARAM_MK_EVICTION_GRACE();
      expect(id, "param id").to.equal(62n);
      expect(await g.PARAM_MAX_ID(),
        "MAX_ID must COVER the id or propose() rejects it. Checked as >=, not ==: the id " +
        "at the top moves every time a param is added, and pinning it makes a passing " +
        "change fail for no reason (the item-42 anti-pattern).").to.be.gte(id);

      const menu = (await g.getAllowedValues(id)).map((v) => Number(v));
      expect(menu.length, "menu must not be empty — an empty allowedValues blocks every proposal").to.be.gt(0);

      // Direction 1: everything the DAO can vote for, the keeper accepts. A value that
      // passes a vote and then reverts at execution is worse than one that was never
      // offered — the proposal is spent and the param looks broken.
      for (const v of menu) {
        await k.setEvictionGracePeriod(v);
        expect(await k.evictionGracePeriod(), `menu value ${v} must be settable`).to.equal(BigInt(v));
      }

      // Direction 2: values the keeper refuses are absent from the menu. Sampled at the
      // shapes a human would actually propose — a plausible round number, an off-by-one
      // on a menu entry, and a 6-day value that looks like it belongs.
      for (const v of [3600, 86401, 518400, 1209600]) {
        expect(menu, `${v} must not be on the DAO menu`).to.not.include(v);
        await expect(k.setEvictionGracePeriod(v),
          `${v} must be refused by the keeper`).to.be.revertedWith("MK: invalid eviction grace (0/1d/2d/3d/4d/5d/7d)");
      }
    });

    it("EC-6: the declared default is on its own menu, and so is the pre-V8.49 24h value", async function () {
      const { k, g } = await govFixture();
      const menu = (await g.getAllowedValues(await g.PARAM_MK_EVICTION_GRACE())).map((v) => Number(v));

      expect(await k.evictionGracePeriod(), "declared default = 7 days").to.equal(BigInt(EVICT_GRACE));
      expect(menu,
        "a default absent from its own menu can never be voted back (item-42)").to.include(EVICT_GRACE);
      expect(menu,
        "86400 is how this whole change is reversed by vote instead of by redeploy — " +
        "set it equal to parkedGracePeriod and the split collapses (EC-4)").to.include(PARKED_GRACE);
      expect(menu,
        "0 is the admin/testing override, and the value V8_48_KeeperScan pins BOTH clocks to").to.include(0);
    });

    it("EC-7: the setter is owner/governance-gated", async function () {
      const { k, stranger } = await govFixture();
      await expect(k.connect(stranger).setEvictionGracePeriod(EVICT_GRACE))
        .to.be.revertedWith("MK: not authorized");
    });
  });
});
