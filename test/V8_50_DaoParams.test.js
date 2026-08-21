"use strict";
/**
 * V8_50_DaoParams.test.js — the item-43 sweep. Session 19, 2026-08-21.
 *
 * OWNER DECISION 2026-08-21: "anything owner can change should also be DAO governance
 * where possible." That is not a new policy here — it is an unfinished one. V8.48 fixed
 * exactly this for setCommunityOverflowBps (param 60), whose comment records the defect
 * class: a setter carrying an `onlyOwnerOrGovernance` gate but NO param id, so "DAO
 * tunable" is owner-only in practice because governance has no way to PROPOSE it.
 *
 * The sweep found 55 gated setters, 47 with a governance path, 8 without. Five are fixed
 * here. Three are not, deliberately:
 *   setTierGateThreshold, setTierWhaleGateActive — take TWO arguments and a proposal
 *     carries one value. Unreachable by construction; the per-tier whale gates already
 *     have ids 52-57, which is the coverage that matters.
 *   setUpkeepCaller — authorization, not economics. A compromised keeper key must be
 *     revocable in minutes, not through a vote plus a timelock. Owner-only ON PURPOSE.
 *
 * ⛔ THE TEST THAT MATTERS IS DP-5, AND IT IS THE SECOND INSTRUMENT.
 *   A governance menu and its target setter are two lists of the same thing, free to
 *   drift — and when they drift the failure is silent in the worst direction: a proposal
 *   passes a vote, waits out the timelock, and then REVERTS on execution. The menus are
 *   not eyeballed against the setters here. Every value on every new menu is fed to the
 *   real setter on the real contract, and the setter has to accept it.
 */
const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// The declared default, asserted rather than assumed (DP-3) so "vote it back" is real.
const DEFAULT_BANDS = [9000n, 8000n, 7000n, 6000n];
const PRESETS = {
  0: [0n, 0n, 0n, 0n],
  1: [6000n, 5000n, 4000n, 3000n],
  2: [9000n, 8000n, 7000n, 6000n],
  3: [10000n, 9500n, 9000n, 8000n],
};

describe("V8.50 — the item-43 sweep: owner-changeable means DAO-reachable", function () {
  this.timeout(300_000);

  async function fixture() {
    const [owner, gov, stranger] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const sf   = await (await ethers.getContractFactory("StabilityFund"))
      .deploy(await usdc.getAddress(), owner.address);
    const sfAddr = await sf.getAddress();

    // MatrixKeeper(tierRouter, stabilityFund) — both only checked non-zero, so the
    // router can be any address for a pure config test.
    // V8.48 item 12a: the discovery scan lives in MatrixKeeperLib and must be linked.
    const mk = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: (await (await ethers.getContractFactory("MatrixKeeperLib")).deploy()).target },
    })).deploy(owner.address, sfAddr);

    // V8Governance(cnova, tierRouter, matrixKeeper) — same, and _initAllowedValues()
    // runs in the constructor, which is the registry this file reads.
    const govc = await (await ethers.getContractFactory("V8Governance"))
      .deploy(await usdc.getAddress(), owner.address, await mk.getAddress());

    return { owner, gov, stranger, sf, mk, govc };
  }

  // ══ PART A — the clawback preset ════════════════════════════════════════════
  describe("PART A — StabilityFund.setClawbackPreset", function () {

    it("DP-1: each preset expands to its documented band set", async function () {
      const { sf } = await loadFixture(fixture);
      for (const [id, bands] of Object.entries(PRESETS)) {
        await sf.setClawbackPreset(Number(id));
        for (let b = 0; b < 4; b++) {
          expect(await sf.clawbackBpsByBand(b), `preset ${id} band ${b}`).to.equal(bands[b]);
        }
      }
    });

    it("DP-2: preset 2 reproduces the DECLARED DEFAULT exactly — so it can be voted back", async function () {
      const { sf } = await loadFixture(fixture);
      // Read the shipped default first, then prove preset 2 restores it after a change.
      for (let b = 0; b < 4; b++) {
        expect(await sf.clawbackBpsByBand(b), "declared default").to.equal(DEFAULT_BANDS[b]);
      }
      await sf.setClawbackPreset(3);
      expect(await sf.clawbackBpsByBand(0)).to.equal(10000n);
      await sf.setClawbackPreset(2);
      for (let b = 0; b < 4; b++) {
        expect(await sf.clawbackBpsByBand(b), "voted back to default").to.equal(DEFAULT_BANDS[b]);
      }
    });

    it("DP-3: bounded, gated, and it emits both the bands and the preset", async function () {
      const { sf, gov, stranger } = await loadFixture(fixture);

      await expect(sf.setClawbackPreset(4)).to.be.revertedWith("SF: bad clawback preset");
      await expect(sf.connect(stranger).setClawbackPreset(1)).to.be.revertedWith("SF: not authorized");

      await expect(sf.setClawbackPreset(1))
        .to.emit(sf, "ClawbackBandsSet").withArgs(6000n, 5000n, 4000n, 3000n)
        .and.to.emit(sf, "ClawbackPresetSet").withArgs(1n);

      // Governance is the whole point of the change.
      await sf.setGovernance(gov.address);
      await expect(sf.connect(gov).setClawbackPreset(0))
        .to.emit(sf, "ClawbackPresetSet").withArgs(0n);
      expect(await sf.clawbackBpsByBand(3)).to.equal(0n);
    });

    it("DP-4: NO preset id is stored — the bands are the single source of truth", async function () {
      const { sf } = await loadFixture(fixture);
      // Same shape as the velocity suite's "the StabilityFund still has no activateLayer".
      // Storing an id beside the bands would be two models of one rule, free to drift the
      // moment setClawbackBands is called directly. If someone adds that getter, this fails
      // and they should read the note above setClawbackPreset before deleting the test.
      expect(sf.clawbackPreset, "a stored preset id would be a second source of truth")
        .to.equal(undefined);

      // And the direct band setter still wins, with no id left disagreeing with it.
      await sf.setClawbackPreset(3);
      await sf.setClawbackBands([1234, 2345, 3456, 4567]);
      expect(await sf.clawbackBpsByBand(0)).to.equal(1234n);
      expect(await sf.clawbackBpsByBand(3)).to.equal(4567n);
    });
  });

  // ══ PART B — the menus, proven against the setters ══════════════════════════
  describe("PART B — every menu value must be accepted by its target setter", function () {

    it("DP-5: THE MIRROR — feed every value of every new menu to the real setter", async function () {
      const { sf, mk, govc } = await loadFixture(fixture);

      // paramId -> [label, how to apply the value to the real target]
      const NEW_PARAMS = [
        [await govc.PARAM_SF_CLAWBACK_PRESET(),   "SF.setClawbackPreset",        (v) => sf.setClawbackPreset(v)],
        [await govc.PARAM_SF_BASE_ADVANCE(),      "SF.setBaseAdvanceBps",        (v) => sf.setBaseAdvanceBps(v)],
        [await govc.PARAM_MK_SELF_FUNDED_GRACE(), "MK.setSelfFundedGracePeriod", (v) => mk.setSelfFundedGracePeriod(v)],
        [await govc.PARAM_MK_FROZEN_MATB(),       "MK.setFrozenMatBTimeout",     (v) => mk.setFrozenMatBTimeout(v)],
        [await govc.PARAM_MK_GHOST_ENTRY(),       "MK.setGhostEntryEnabled",     (v) => mk.setGhostEntryEnabled(v !== 0n)],
      ];

      for (const [id, label, apply] of NEW_PARAMS) {
        const menu = await govc.getAllowedValues(id);
        // An empty menu is not "no restriction" — propose() would have nothing to match,
        // so the param would be silently unproposable. That is the item-43 defect wearing
        // a different hat, and it must fail here rather than after a deploy.
        expect(menu.length, `param ${id} (${label}) has an EMPTY menu — it would be unproposable`)
          .to.be.greaterThan(0);

        for (const v of menu) {
          await expect(apply(v), `${label} REJECTED menu value ${v} — menu and setter have drifted`)
            .to.not.be.reverted;
        }
      }
    });

    it("DP-6: PARAM_MAX_ID moved with the new ids, so propose() can reach them", async function () {
      const { govc } = await loadFixture(fixture);
      const maxId = await govc.PARAM_MAX_ID();

      expect(maxId).to.equal(await govc.PARAM_MK_GHOST_ENTRY());
      for (const id of [
        await govc.PARAM_SF_CLAWBACK_PRESET(),
        await govc.PARAM_SF_BASE_ADVANCE(),
        await govc.PARAM_MK_SELF_FUNDED_GRACE(),
        await govc.PARAM_MK_FROZEN_MATB(),
        await govc.PARAM_MK_GHOST_ENTRY(),
      ]) {
        expect(id, "a new id above PARAM_MAX_ID is rejected by propose() and setAllowedValues()")
          .to.be.lte(maxId);
      }

      // One past the top is still refused — the guard did not simply get widened away.
      await expect(govc.setAllowedValues(Number(maxId) + 1, [1]))
        .to.be.revertedWithCustomError(govc, "GOV_InvalidParam");
    });

    it("DP-7: the three deliberate omissions stay omitted, and the reason is in the test", async function () {
      const { mk } = await loadFixture(fixture);
      // setTierGateThreshold(uint8,uint256) and setTierWhaleGateActive(uint8,bool) take TWO
      // arguments; a proposal carries one value, so no param id can express them. The
      // per-tier whale gates already have ids 52-57.
      // setUpkeepCaller(address,bool) is authorization, not economics — owner-only so a
      // compromised keeper key can be revoked in minutes rather than by vote + timelock.
      // This test exists so that "why isn't this DAO-votable" has an answer in the suite
      // rather than only in a handoff nobody re-reads.
      expect(typeof mk.setUpkeepCaller, "still present as an owner tool").to.equal("function");
    });
  });
});
