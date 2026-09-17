"use strict";
/**
 * V8_55_SpendableFloor.test.js — THE STABILITY-FUND FLOOR HEAD-OF-LINE BLOCK.
 *
 * MEASURED FIRST, ON CHAIN, BEFORE ANY OF THIS WAS WRITTEN (private V8.54 sandbox,
 * 2026-09-17, handoff 62.64):
 *
 *   - Fund balance $17.10, stabilityFloor $100.00, five parked members, four of them
 *     carrying a RESCUE verdict and one an EVICTION that was already due.
 *   - Five consecutive performUpkeep transactions at an IDENTICAL 154,533 gas changed
 *     nothing readable. Each emitted exactly one event:
 *         WorkItemFailed workType=4 (PARKED_RESCUE) tier 0 matB 0xc64700…82D8
 *     — THE SAME MEMBER EVERY TICK.
 *   - diag_keeper_queue (block 46941216): checkUpkeep returned ONE item, that member's
 *     rescue, and an eth_call of the worker FROM the keeper address reverted
 *         "SF: below floor".
 *   - Setting the private floor to $0 cleared it instantly: six transactions, four
 *     rescues, $16.86 lent, "backlog cleared in 6 tick(s)".
 *
 * WHAT THE MEASUREMENT SAYS, AND IT IS NOT A KEEPER-SCRIPT PROBLEM
 *   Discovery and the lender ask DIFFERENT QUESTIONS about the fund's money.
 *
 *     MatrixKeeperLib._checkParked  : sfAvail = balanceByTier | totalBalance;
 *                                     queue it if  sfAvail >= sfShare
 *     StabilityFund.payForceCross   : require(totalBalance >= advance + stabilityFloor,
 *                                             "SF: below floor")
 *
 *   So whenever  sfShare <= totalBalance < advance + stabilityFloor,  discovery queues a
 *   rescue the fund will refuse. performUpkeep's catch at MatrixKeeper.sol:~986 swallows
 *   "SF: below floor" into a WorkItemFailed, the item is NOT dequeued, and checkUpkeep —
 *   which fills slots in scan order and ships at maxItemsPerUpkeep = 1 — hands back the
 *   same item on the next tick. Every other rescue, the due eviction, the velocity check
 *   and the CW epoch sit behind it. One transaction burned per tick, forever, until
 *   somebody moves the floor by hand.
 *
 *   MatrixKeeper.sol:~970 states the opposite in a comment — that discovery asks the
 *   floor first "so a floor refusal here should be unreachable". It asks
 *   loanEligibleFor, which is the MEMBER's insolvency ceiling. That is a different floor
 *   with a different name and a different failure string. The fund's own reserve was
 *   never asked about at all.
 *
 * WHY THE SUITE DID NOT CATCH IT
 *   MockStabilityFundK modelled loanEligibleFor and not `stabilityFloor`, so the mock
 *   lender could not produce the revert the real one produces. The mock gained both
 *   guards in this commit, in the real lender's order.
 *
 * THE TWO REFUSALS ARE NOT THE SAME REFUSAL, and every test below keeps them apart:
 *   "SF: insolvency floor"  — this MEMBER has borrowed too much (V8.49 item 1b).
 *   "SF: below floor"       — this FUND may not go this low (V8.20 stabilityFloor).
 *   A fixture that cannot tell them apart is testing neither.
 *
 * LIVE V8.52 EXPOSURE: any tick where the live fund's spendable reaches $0 while a
 * RESCUE-verdict member is parked. UNMEASURED on the live chain at the time of writing.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const M6  = (n) => ethers.parseUnits(n.toString(), 6);
const FEE = M6(10);                    // T1 entry fee

const WORK_VELOCITY      = 0;
const WORK_PARKED_RESCUE = 4;
const WORK_EVICT_PARKED  = 6;
const PARKED_GRACE = 24 * 3600;

// `thin`: withdrawable $8.40, no reserve, parked in a MatB, so the crossing costs the
// FULL fee. 8400 bps of $10.00 lands on preset 1's 8000 rung (2500 bps), giving
// $2.50, capped at the real shortfall of $1.60. Identical member and identical
// arithmetic to V8_49_InsolvencyFloor part 2 — deliberately, so the only new variable
// in this file is the fund's own floor.
const SF_SHARE = M6(1.6);

describe("V8.55 — the Stability Fund's own floor, asked by discovery as the lender asks it", function () {
  this.timeout(600_000);

  // ══ PART 1 — the real lender, so the two refusals are pinned apart ═══════════
  describe("the lender", function () {
    async function sfFixture() {
      const [owner, member] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
      const sf   = await (await ethers.getContractFactory("StabilityFund"))
        .deploy(await usdc.getAddress(), owner.address);
      const mock = await (await ethers.getContractFactory("MockRescueMatrix"))
        .deploy(await sf.getAddress(), await usdc.getAddress());
      await sf.setMatrixAuthorized(await mock.getAddress(), true);
      await sf.setTierFee(0, FEE);
      await sf.setMatrixKeeper(owner.address);
      await usdc.mint(owner.address, M6(1000));
      await usdc.approve(await sf.getAddress(), M6(1000));
      await sf.receiveLayer(0, M6(5), 5);          // the whole fund: $5.00
      return { owner, member, usdc, sf, mock };
    }

    it("BF-1: a member well inside their ceiling is still refused when the FUND is at its floor", async function () {
      const { owner, member, sf, mock } = await sfFixture();
      expect(await sf.totalBalance()).to.equal(M6(5));

      // The member is eligible — this is not an insolvency refusal, and the test would
      // be worthless if it were.
      expect(await sf.loanEligibleFor(member.address, 0, SF_SHARE),
        "the MEMBER has room: $1.60 against a $5.00 ceiling, no debt").to.equal(true);

      // $4.00 held back leaves $1.00 spendable against a $1.60 ask.
      await sf.connect(owner).setStabilityFloor(M6(4));
      await expect(sf.connect(owner).payForceCross(member.address, 0, await mock.getAddress(), SF_SHARE))
        .to.be.revertedWith("SF: below floor");

      // Lower the floor so the spendable amount covers it EXACTLY and the same call goes
      // through. Nothing about the member changed between these two lines.
      await sf.connect(owner).setStabilityFloor(M6(5) - SF_SHARE);
      await sf.connect(owner).payForceCross(member.address, 0, await mock.getAddress(), SF_SHARE);
      expect(await sf.totalBalance()).to.equal(M6(5) - SF_SHARE);
    });
  });

  // ══ PART 2 — discovery, on the keeper harness ═══════════════════════════════
  describe("discovery agrees with the lender", function () {
    let keeper, matA, matB, sfMock, thin, ghost;

    function decode(pd) {
      if (!pd || pd === "0x") return [];
      const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], pd);
      return items.map((i) => ({ workType: Number(i.workType), addr1: i.addr1, addr2: i.addr2 }));
    }
    async function allWork() {
      const [, data] = await keeper.checkUpkeep("0x");
      return decode(data);
    }
    async function workFor(who) {
      return (await allWork()).filter((i) => i.addr2 === who).map((i) => i.workType);
    }
    const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

    /** Put the fund in a named state: total balance, tier-0 bucket, and the floor. */
    async function fund(total, floor) {
      await sfMock.setTotal(total);
      await sfMock.setTier(0, total);
      await sfMock.setStabilityFloor(floor);
    }

    async function setup() {
      const sigs = await ethers.getSigners();
      [thin, ghost] = sigs.slice(1, 3).map((s) => s.address);

      const tr = await (await ethers.getContractFactory("MockTierRouterK")).deploy();
      sfMock = await (await ethers.getContractFactory("MockStabilityFundK")).deploy(M6(10_000));
      await sfMock.setTier(0, M6(10_000));
      // The MEMBER ceiling stays armed and generous throughout: $3.40 against a $1.60
      // ask. If any assertion below flips, it is the FUND's floor that flipped it.
      await sfMock.setInsolvencyFloorBps(3400);
      await sfMock.setTierFee(0, FEE);

      const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
      keeper = await (await ethers.getContractFactory("MatrixKeeper", {
        libraries: { MatrixKeeperLib: await lib.getAddress() },
      })).deploy(await tr.getAddress(), await sfMock.getAddress());

      matA = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
      matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, false);
      const pm = await (await ethers.getContractFactory("MockPairManagerK")).deploy();
      await pm.addPair(await matA.getAddress(), await matB.getAddress());
      await keeper.setPairManager(0, await pm.getAddress());
      await keeper.setMaxItemsPerUpkeep(15);
      await keeper.setParkedGracePeriod(PARKED_GRACE);

      const t = await now();
      await matB.addParked(thin,  t, M6(8.4), 0, 0);   // index 0 — the rescue
      await matB.addParked(ghost, t, M6(7),   0, 0);   // index 1 — behind it in the queue
      await matB.setSeated(ghost, true);               // seated => EVICT_GHOST, costs the fund nothing
      await time.increase(10);
    }

    it("BF-2: THE DEFECT — a rescue the fund cannot pay must not be queued", async function () {
      await setup();
      // $2.00 in the fund, $1.00 of it reserved. Discovery's old test (`$2.00 >= $1.60`)
      // says yes; the lender's test (`$2.00 >= $1.60 + $1.00`) says no. This is the exact
      // shape measured on the private chain, scaled down.
      await fund(M6(2), M6(1));
      await time.increase(PARKED_GRACE + 5);

      expect(await sfMock.loanEligibleFor(thin, 0, SF_SHARE),
        "not an insolvency refusal — the member has room").to.equal(true);
      expect(await sfMock.totalBalance(),
        "and the fund holds more than the ask, which is what fooled discovery").to.be.gte(SF_SHARE);

      expect(await workFor(thin),
        "a rescue that WILL revert 'SF: below floor' must never reach the queue")
        .to.deep.equal([]);
    });

    it("BF-3: THE HEAD-OF-LINE BLOCK — at cap 1 the unpayable item owns the only slot", async function () {
      // This is the whole cost of the defect. It is not one skipped member: at the
      // shipping maxItemsPerUpkeep of 1, the refused item is re-offered at the head of
      // the queue every tick and NOTHING behind it is ever reached.
      await setup();
      await fund(M6(2), M6(1));
      await time.increase(PARKED_GRACE + 5);

      // Spend the velocity check first, exactly as production does, so the single slot
      // is genuinely free for member work (the CV3 tripwire in V8_50_CapOneVelocity).
      await keeper.performUpkeep(ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
        [[[WORK_VELOCITY, 0, ethers.ZeroAddress, ethers.ZeroAddress]]]));
      await keeper.setMaxItemsPerUpkeep(1);

      const items = await allWork();
      expect(items.length, "cap 1: exactly one item").to.equal(1);
      expect(items[0].addr2,
        "the unpayable rescue must not be holding the slot — the member BEHIND it is due")
        .to.equal(ghost);
      expect(items[0].workType, "and what is due for them is the ghost eviction")
        .to.equal(WORK_EVICT_PARKED);
    });

    it("BF-4: the boundary is spendable, not balance — exactly enough passes, one wei less does not", async function () {
      await setup();
      await time.increase(PARKED_GRACE + 5);

      // $10.00 in the fund, $8.40 reserved => spendable $1.60 => the ask lands exactly.
      await fund(M6(10), M6(10) - SF_SHARE);
      expect(await workFor(thin), "spendable == the ask: rescue").to.deep.equal([WORK_PARKED_RESCUE]);

      await fund(M6(10), M6(10) - SF_SHARE + 1n);
      expect(await workFor(thin), "one wei short of the ask: nothing").to.deep.equal([]);
    });

    it("BF-5: at floor 0 nothing changes — the whole existing suite's world is untouched", async function () {
      // The shipping default is 0 on the mock and 0 on a fresh StabilityFund, so this
      // pins that the fix is inert where it should be inert.
      await setup();
      await fund(M6(2), 0);
      await time.increase(PARKED_GRACE + 5);
      expect(await workFor(thin)).to.deep.equal([WORK_PARKED_RESCUE]);
    });

    it("BF-6: EXECUTION — the crossing buffer is trimmed to what is spendable, not to the balance", async function () {
      // _doParkedRescue already trims the buffer rather than skipping a rescue outright
      // when the fund is short. It computed "short" from the balance, so with a floor in
      // place it trimmed to a number the lender still refuses — the same disagreement one
      // layer down. Discovery being fixed does not fix this: the two sides must BOTH ask
      // about spendable or they can still disagree after a vote moves the buffer.
      await setup();
      await sfMock.setInsolvencyFloorBps(0);        // member ceiling off: isolate the fund's floor
      await keeper.setCrossingBufferBps(3600);      // buffer $3.60, so the ask is $1.60 + $3.60 = $5.20
      await fund(M6(10), M6(6));                    // spendable $4.00 — under the ask, over the shortfall
      await time.increase(PARKED_GRACE + 5);

      const pd = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
        [[[WORK_PARKED_RESCUE, 0, await matB.getAddress(), thin]]]);
      const rc = await (await keeper.performUpkeep(pd)).wait();
      const names = rc.logs
        .map((l) => { try { return keeper.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean).map((e) => e.name);

      expect(names,
        "trimmed to $4.00 the fund can pay, so the member is rescued rather than failed")
        .to.include("ParkedRescued");
      expect(names,
        "a buffer trimmed against the raw balance asks for $5.20 and comes back 'SF: below floor'")
        .to.not.include("WorkItemFailed");
    });
  });
});
