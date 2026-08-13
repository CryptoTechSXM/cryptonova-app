"use strict";
/**
 * V8_48_CommunityOverflow.test.js — the surplus-to-community dial, armed and votable.
 *
 * TWO OWNER DECISIONS MEET HERE:
 *   2026-08-07 (recovered 2026-08-13 — it had fallen out of the scope entirely; the
 *   addendum file that carried it was never created because the device bridge was
 *   down that day): a DAO-tunable lever so the community, not the SF, receives the
 *   value once the fund is healthy.
 *   2026-08-13 (superseding, owner's words): "100% of surplus go to CW and we can
 *   DAO vote to change it after."
 *
 * WHAT SHIPPED:
 *   - communityOverflowBps declared default 0 → 10_000: while the SF sits at/above
 *     sfTarget(), EVERY incremental L1 dollar routes to the CommunityWallet.
 *   - The setter menu now reaches 10_000 (it was capped at 500 — "0-5%" — which
 *     could never express the decided policy).
 *   - PARAM_SF_COMMUNITY_OVERFLOW = 60: the setter carried onlyOwnerOrGovernance
 *     since item 26 but NO governance param id existed — the DAO had no path to it,
 *     so "DAO tunable" was owner-only in practice (the item-43 "fee that never
 *     existed on chain" class, caught by sweeping the recovered decision).
 *
 * Item 26's own mechanics (evaluate target BEFORE crediting the deposit; keep the
 * money in the SF if the CW rejects it) were built 2026-08-09 but shipped with NO
 * dedicated tests — this file is also their first coverage.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);

describe("V8.48 — SF surplus-to-community: 100% by default, DAO param 60", function () {
  async function fixture() {
    const [owner, member] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const sf = await (await ethers.getContractFactory("StabilityFund"))
      .deploy(await usdc.getAddress(), owner.address);
    const cw = await (await ethers.getContractFactory("CommunityWallet"))
      .deploy(await usdc.getAddress(), owner.address);
    await sf.setCommunityWallet(await cw.getAddress());
    // Owner is an authorized receiveLayer caller; fund the owner for deposits.
    await usdc.mint(owner.address, M6(100_000));
    await usdc.approve(await sf.getAddress(), M6(100_000));
    // Manual target (tierRouter unwired): $300 — the auto/manual fallback default.
    return { owner, member, usdc, sf, cw };
  }

  it("CO1: declared default is 10000, and it sits on BOTH menus (SF enum + gov param 60)", async function () {
    const { owner, member, sf } = await fixture();
    expect(await sf.communityOverflowBps(), "the owner's decision, as a declared default").to.equal(10_000n);
    // SF-side enumeration: off-menu reverts, on-menu values land.
    await expect(sf.setCommunityOverflowBps(9_999)).to.be.revertedWith("SF: invalid overflow bps");
    await expect(sf.connect(member).setCommunityOverflowBps(0)).to.be.revertedWith("SF: not authorized");
    await sf.setCommunityOverflowBps(2_500);
    expect(await sf.communityOverflowBps()).to.equal(2_500n);
    // Governance side: param 60 exists, is the max id, and its menu mirrors the
    // setter exactly — a menu value the setter rejects is a proposal that can pass
    // and then revert at execution (the exact class param 39 hit in item 41).
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    const gov = await (await ethers.getContractFactory("V8Governance"))
      .deploy(await cnova.getAddress(), owner.address, owner.address);
    expect(await gov.PARAM_SF_COMMUNITY_OVERFLOW()).to.equal(60);
    // gte, not equal: MAX_ID moves with every new param (GF-G1 learned this the
    // hard way the same day this file was written).
    expect(await gov.PARAM_MAX_ID()).to.be.gte(60);
    const menu = (await gov.getAllowedValues(60)).map(Number);
    expect(menu).to.include(10_000);
    expect(menu).to.include(0);
    for (const v of menu) {
      await sf.setCommunityOverflowBps(v); // every menu value must be settable
      expect(await sf.communityOverflowBps()).to.equal(BigInt(v));
    }
  });

  it("CO2: below target NOTHING routes; at target 100% of the next L1 deposit goes to the CW", async function () {
    const { sf, cw, usdc } = await fixture();
    const target = await sf.sfTarget(); // $300 manual default
    const cwAddr = await cw.getAddress();

    // Below target: the deposit stays in the fund, community gets nothing yet.
    await sf.receiveLayer(0, target - M6(50), 1);
    expect(await usdc.balanceOf(cwAddr)).to.equal(0n);
    expect(await sf.totalRoutedToCommunity()).to.equal(0n);

    // THE BOUNDARY, and item 26's ordering rule: this deposit BRINGS the fund to
    // target, but totalBalance is read before crediting — a deposit must not tip
    // its own test. It stays in the SF.
    await sf.receiveLayer(0, M6(50), 1);
    expect(await sf.totalBalance()).to.equal(target);
    expect(await usdc.balanceOf(cwAddr)).to.equal(0n);

    // AT target: the fund needs nothing more — 100% of the next L1 dollar is
    // surplus and lands in the CommunityWallet, to the cent.
    await sf.receiveLayer(0, M6(40), 1);
    expect(await usdc.balanceOf(cwAddr), "all of it, to the community").to.equal(M6(40));
    expect(await sf.totalRoutedToCommunity()).to.equal(M6(40));
    expect(await sf.totalBalance(), "the fund itself holds at target").to.equal(target);
  });

  it("CO3: a dialed-down rate splits accordingly, and 0 switches the redirect off", async function () {
    const { sf, cw, usdc } = await fixture();
    const target = await sf.sfTarget();
    const cwAddr = await cw.getAddress();
    await sf.receiveLayer(0, target, 1); // fill to target exactly

    await sf.setCommunityOverflowBps(2_500); // DAO dialed down to 25%
    await sf.receiveLayer(0, M6(100), 1);
    expect(await usdc.balanceOf(cwAddr)).to.equal(M6(25));
    expect(await sf.totalBalance()).to.equal(target + M6(75));

    await sf.setCommunityOverflowBps(0); // and off
    await sf.receiveLayer(0, M6(100), 1);
    expect(await usdc.balanceOf(cwAddr), "unchanged — redirect off").to.equal(M6(25));
  });
});
