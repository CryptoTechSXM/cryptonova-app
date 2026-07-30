"use strict";
/**
 * V8_46_KeeperAuth.test.js — V8.46 item 1.
 *
 *  A1. performUpkeep was `external` with NO guard — anyone could hand-craft a
 *      WorkItem[] and drive the queue. Now allowlisted: owner + governance +
 *      upkeepCaller[] only. setUpkeepCaller is owner/governance-only.
 *  A2. _doEvictParked had NO time gate — anyone could evict a freshly-parked
 *      member and lock them out of rescue re-entry. Now requires a completed
 *      rotation AND extendedIdleTimeout (7d) since parkedAt, like _doReclaimSlot.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const FEE                = 10_000_000n;
const WORK_EVICT_PARKED  = 6;
const EXTENDED_IDLE      = 604800; // 7 days — MatrixKeeper.extendedIdleTimeout default

function encodeWork(items) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
    [items]
  );
}

async function deployKeeper() {
  const [owner, keeperEOA, stranger, member] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const usdcAddr = await usdc.getAddress();
  const sf = await (await ethers.getContractFactory("StabilityFund")).deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter")).deploy(usdcAddr, owner.address);
  const keeper = await (await ethers.getContractFactory("MatrixKeeper"))
    .deploy(await tr.getAddress(), await sf.getAddress());
  return { keeper, owner, keeperEOA, stranger, member };
}

describe("V8.46 item 1 — MatrixKeeper allowlist + eviction idle gate", function () {

  describe("A1. performUpkeep allowlist", function () {
    it("blocks a stranger; allows owner and allowlisted EOAs; re-blocks after removal", async function () {
      const { keeper, owner, keeperEOA, stranger } = await deployKeeper();
      const empty = encodeWork([]);

      await expect(keeper.connect(stranger).performUpkeep(empty))
        .to.be.revertedWith("MK: not authorized keeper");

      await expect(keeper.connect(owner).performUpkeep(empty)).to.not.be.reverted;

      await keeper.connect(owner).setUpkeepCaller(keeperEOA.address, true);
      await expect(keeper.connect(keeperEOA).performUpkeep(empty)).to.not.be.reverted;

      await keeper.connect(owner).setUpkeepCaller(keeperEOA.address, false);
      await expect(keeper.connect(keeperEOA).performUpkeep(empty))
        .to.be.revertedWith("MK: not authorized keeper");
    });

    it("setUpkeepCaller is owner/governance-only", async function () {
      const { keeper, stranger, keeperEOA } = await deployKeeper();
      await expect(keeper.connect(stranger).setUpkeepCaller(keeperEOA.address, true))
        .to.be.revertedWith("MK: not authorized");
    });
  });

  describe("A2. _doEvictParked idle gate", function () {
    it("does NOT evict a freshly-parked member; evicts only after the 7-day window", async function () {
      const { keeper, owner, member } = await deployKeeper();
      const mock = await (await ethers.getContractFactory("MockEvictMatrix")).deploy();
      const mockAddr = await mock.getAddress();

      await mock.setParkedAt(await time.latest());
      await mock.setRotationCount(1);
      const work = encodeWork([
        { workType: WORK_EVICT_PARKED, tierIndex: 0, addr1: mockAddr, addr2: member.address },
      ]);

      // within the idle window -> gate returns early, no eviction
      await keeper.connect(owner).performUpkeep(work);
      expect(await mock.evicted()).to.equal(false);

      // past extendedIdleTimeout -> eviction fires
      await time.increase(EXTENDED_IDLE + 1);
      await keeper.connect(owner).performUpkeep(work);
      expect(await mock.evicted()).to.equal(true);
    });

    it("does NOT evict when the matrix has never rotated (rotationCount == 0)", async function () {
      const { keeper, owner, member } = await deployKeeper();
      const mock = await (await ethers.getContractFactory("MockEvictMatrix")).deploy();
      const mockAddr = await mock.getAddress();

      await mock.setParkedAt(1);        // ancient park
      await mock.setRotationCount(0);   // but matrix never rotated
      const work = encodeWork([
        { workType: WORK_EVICT_PARKED, tierIndex: 0, addr1: mockAddr, addr2: member.address },
      ]);

      await time.increase(EXTENDED_IDLE + 1);
      await keeper.connect(owner).performUpkeep(work);
      expect(await mock.evicted()).to.equal(false);
    });
  });
});
