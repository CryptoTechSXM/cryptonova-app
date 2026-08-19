"use strict";
/**
 * V8_49_CrossingBuffer.test.js — V8.49 item 1b: the crossing buffer is OFF.
 *
 * WHAT CHANGED AND WHY (short version; full reasoning in V8_49_SCOPE.md item 1b)
 *   MatrixKeeper advanced a flat CROSSING_BUFFER_BPS = 3_600 (36% of the entry fee)
 *   on top of every keeper rescue and booked it as member debt. Measured on the live
 *   V8.48 chain 2026-08-15 (scripts/diag_floor_halt.js, 52 parked members):
 *
 *     real entry-fee shortfalls   $0.41 – $1.72
 *     buffer added to every one   $3.60
 *     buffer's share of the ask   $187.20 of $232.29  =  80%
 *
 *   Three things followed, and all three are what this file exists to keep fixed:
 *     1. insolvencyFloorBps was 3_400 AT THE TIME. The buffer at 3_600 was LARGER, so
 *        every advance cleared the floor on its way past — including for a member with
 *        zero debt and zero shortfall. The floor could not refuse anyone.
 *        (V8.50 moved the floor default to 5_000 on 2026-08-19, which would no longer be
 *        smaller than a 3_600 buffer. That does NOT weaken the reason this file exists:
 *        the buffer default is 0 and the defect was the buffer being unconditional, not
 *        the particular pair of numbers.)
 *     2. The buffer was computed OUTSIDE every branch on sfShare, so a SELF-FUNDED
 *        member (sfShare == 0, "costs the fund nothing") was still advanced $3.60,
 *        which made totalSfNeeded > 0, which called payForceCross, which could
 *        revert "SF: insolvency floor" — a string NOT on performUpkeep's
 *        swallow-list, so the WHOLE upkeep batch would revert.
 *     3. The buffer is debt, and the banded clawback takes 60% of the member's pool
 *        income to repay it — eating the earnings needed for the next crossing.
 *
 *   Owner decision 2026-08-15: remove it. Shipped as a GOVERNED param defaulting to
 *   0 rather than a deletion, so it is reversible without a redeploy if rescued
 *   members start re-parking too fast (the accepted risk).
 *
 * WHAT THIS FILE DOES **NOT** COVER — stated rather than left as "all green".
 *   There is no end-to-end assertion here that a real keeper rescue books
 *   `shortfall` and nothing more. That needs a full parked-member fixture with live
 *   matrices, a funded StabilityFund and an authorized keeper — the V8Elevator-scale
 *   setup, not this file's. What is pinned here is the layer where the defect
 *   actually lived: a hardcoded constant nobody could change, a default that ships
 *   because deploy_v8.js never sets it, and a governance menu that must match the
 *   setter or the param is fiction (the item-26 class).
 *
 *   THE GAP WORTH CLOSING NEXT: extend V8_48_GhostFloor.test.js's mock harness to
 *   run _doParkedRescue (not just discovery) and assert increaseMemberDebt is called
 *   with exactly the shortfall at bps 0, and with shortfall + 36% at bps 3_600.
 *   Until that exists, the arithmetic change itself is covered only by the live
 *   measurement above.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

// Must mirror MatrixKeeper.setCrossingBufferBps's require EXACTLY, and
// V8Governance._allowedValues[PARAM_MK_CROSSING_BUFFER] EXACTLY.
const MENU = [0, 900, 1800, 2700, 3600];
const PARAM_ID = 61;

/**
 * Does this contract's ABI expose `name`?
 *
 * ethers v6 `Interface.getFunction()` RETURNS NULL for an unknown name — it only
 * throws on ambiguity. The first version of CB-2 wrapped it in try/catch and
 * assumed a throw, so the catch never ran and the test reported the constant as
 * still present when it was not. Same family as the fabricated-fallback bugs this
 * project keeps finding: a null treated as a value. Handle both shapes.
 */
function hasFn(contract, name) {
  try { return contract.interface.getFunction(name) !== null; }
  catch { return false; }
}

describe("V8.49 item 1b — crossing buffer OFF by default, governed, reversible", function () {
  let owner, mk, gov;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    // MatrixKeeper is a LINKED contract since V8.48 item 12a — deploy
    // MatrixKeeperLib first and link it, same as V8_48_KeeperScan and
    // V8_48_GhostFloor do. Without this getContractFactory throws
    // "missing links for the following libraries" before any test body runs.
    const keeperLib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
    // Constructor is (tierRouter, stabilityFund); neither is read by anything this
    // file touches, they only need to be non-zero.
    mk = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: await keeperLib.getAddress() },
    })).deploy(owner.address, owner.address);
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    // (cnovaToken, tierRouter, matrixKeeper)
    gov = await (await ethers.getContractFactory("V8Governance"))
      .deploy(await cnova.getAddress(), owner.address, await mk.getAddress());
  });

  // ── THE DEFAULT IS WHAT SHIPS ─────────────────────────────────────────────
  describe("the declared default", function () {
    it("CB-1: crossingBufferBps defaults to 0 — the buffer is off on a fresh deploy", async function () {
      // This is the whole change. deploy_v8.js does NOT call setCrossingBufferBps
      // (verified 2026-08-15), so the DECLARED DEFAULT is the live value — exactly
      // the item-42 situation, where changing a default WAS the shipping mechanism.
      expect(await mk.crossingBufferBps()).to.equal(0);
    });

    it("CB-2: the old hardcoded constant is GONE, not merely shadowed", async function () {
      // A regression pin with teeth: if someone reintroduces
      // `uint256 public constant CROSSING_BUFFER_BPS`, the ABI grows that getter
      // back and this fails. Without it, a second source of truth could sit
      // alongside the param and the call site could quietly read the wrong one.
      expect(hasFn(mk, "crossingBufferBps"),
        "the governed param must be public — the call site and governance both need it"
      ).to.equal(true);
      expect(hasFn(mk, "CROSSING_BUFFER_BPS"),
        "CROSSING_BUFFER_BPS is back — V8.49 replaced it with the governed crossingBufferBps"
      ).to.equal(false);
    });
  });

  // ── THE SETTER ────────────────────────────────────────────────────────────
  describe("setCrossingBufferBps — enumerated, house convention", function () {
    it("CB-3: accepts every value on the menu, including the retired 3_600", async function () {
      for (const v of MENU) {
        await mk.setCrossingBufferBps(v);
        expect(await mk.crossingBufferBps(), `menu value ${v} did not stick`).to.equal(v);
      }
      // Leave it where it belongs.
      await mk.setCrossingBufferBps(0);
      expect(await mk.crossingBufferBps()).to.equal(0);
    });

    it("CB-4: rejects off-menu values — free ranges are not the house style", async function () {
      // 3_400 and 5_000 are both deliberately chosen: they are the OLD and the CURRENT
      // insolvencyFloorBps, the values someone might reach for to "make the buffer match
      // the floor". Neither is on this menu, and both stay in the list so the check keeps
      // covering the reach whichever value PARAM 59 is sitting at.
      for (const bad of [1, 3400, 5000, 10000]) {
        await expect(mk.setCrossingBufferBps(bad), `${bad} should be rejected`)
          .to.be.revertedWith("MK: invalid crossing buffer (0/900/1800/2700/3600)");
      }
    });

    it("CB-5: emits ConfigUpdated so a change is visible on chain", async function () {
      await expect(mk.setCrossingBufferBps(3600))
        .to.emit(mk, "ConfigUpdated").withArgs("crossingBufferBps", 3600);
      await mk.setCrossingBufferBps(0);
    });

    it("CB-6: is not open to the public", async function () {
      const [, stranger] = await ethers.getSigners();
      await expect(mk.connect(stranger).setCrossingBufferBps(3600)).to.be.reverted;
    });
  });

  // ── GOVERNANCE (the item-26 / item-43 discipline) ─────────────────────────
  describe("PARAM_MK_CROSSING_BUFFER — DAO-tunable for real, not in name", function () {
    it("CB-7: param id 61 is assigned and PARAM_MAX_ID covers it", async function () {
      expect(await gov.PARAM_MK_CROSSING_BUFFER()).to.equal(PARAM_ID);
      // gte, not equal: MAX_ID moves whenever a param is added. Pinning it to 61
      // would be a change detector that explains nothing — the item-42 anti-pattern,
      // and the exact line that broke in V8_48_GhostFloor GF-G1 when param 60 landed.
      expect(await gov.PARAM_MAX_ID()).to.be.gte(PARAM_ID);
    });

    it("CB-8: the governance menu matches the setter EXACTLY, both directions", async function () {
      // Item 26 shipped a setter with a governance gate but no param id, so "DAO
      // tunable" was fiction until it was caught. The subtler version of the same
      // bug is a menu that lists a value the setter rejects: the proposal passes,
      // waits out 72h of voting and a 48h timelock, and then reverts on execution.
      const menu = (await gov.getAllowedValues(PARAM_ID)).map(Number);
      expect(menu, "menu must match the setter's enumeration exactly").to.deep.equal(MENU);
      // And prove it, rather than trusting the two literals to stay in step.
      for (const v of menu) {
        await mk.setCrossingBufferBps(v);   // reverts here if the menu over-promises
      }
      await mk.setCrossingBufferBps(0);
    });

    it("CB-9: the declared default AND the retired value are both votable-back-to", async function () {
      const menu = (await gov.getAllowedValues(PARAM_ID)).map(Number);
      // item-42 lesson: a value absent from its own menu can never be restored.
      expect(menu, "the shipping default must be on the menu")
        .to.include(Number(await mk.crossingBufferBps()));
      expect(menu, "3600 is the reversal knob if the parked queue stops draining")
        .to.include(3600);
    });
  });

  // ── THE INVARIANT THAT MADE THE FLOOR UNENFORCEABLE ───────────────────────
  describe("the buffer-vs-floor relationship", function () {
    it("CB-10: at the shipping default the buffer cannot outrun the insolvency floor", async function () {
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
      const sf = await (await ethers.getContractFactory("StabilityFund"))
        .deploy(await usdc.getAddress(), owner.address);

      const buffer = await mk.crossingBufferBps();
      const floor  = await sf.insolvencyFloorBps();

      // THE DEFECT, STATED AS AN INVARIANT. While buffer >= floor, a rescue advances
      // more than the floor permits before any shortfall is even added, so the floor
      // refuses nobody and policy B (floor tested AFTER the advance) would refuse
      // EVERYONE — measured 52 of 52 on the live queue. Neither is a usable policy.
      // This does not assert buffer == 0; it asserts the two are compatible, which is
      // the property that actually has to hold if the buffer is ever turned back up.
      expect(buffer, `crossing buffer ${buffer} bps >= insolvency floor ${floor} bps — ` +
        `the floor cannot be enforced at this setting (V8_49_SCOPE.md item 1b)`
      ).to.be.lt(floor);
    });
  });
});
