"use strict";
/**
 * V8.47 — StabilityFund member-level rescue-debt ledger.
 * TEST #1 (written before the full implementation): SF-CONSERVATION INVARIANT.
 *
 *   Σ_members memberDebt[m]  ==  totalRescueLoaned − totalRescueRepaid
 *
 * No wei of debt is ever created or destroyed by the ledger — booking, redirect
 * repayment, explicit repayment and migration only MOVE debt between "outstanding"
 * and "repaid". A second invariant guards custody: the SF's real USDC balance
 * always equals its booked totalBalance.
 *
 * The ledger is exercised in isolation (StabilityFund + MockUSDC + MockRescueMatrix)
 * — the full-system integration cases (follow-across-tiers, upgrade-gate fold) run
 * against the real matrix/router suite on the device.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

// Deterministic PRNG so the invariant sweep is reproducible (no Date/Math.random flakiness).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function deploy() {
  const [owner] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const mock = await (await ethers.getContractFactory("MockRescueMatrix"))
    .deploy(await sf.getAddress(), await usdc.getAddress());
  await sf.setMatrixAuthorized(await mock.getAddress(), true);
  // Fund the mock generously so it can always cover a repayment (models member earnings).
  await usdc.mint(await mock.getAddress(), 10n ** 18n);
  return { owner, usdc, sf, mock };
}

async function totalOutstanding(sf, members) {
  let s = 0n;
  for (const m of members) s += await sf.memberDebt(m);
  return s;
}

describe("V8.47 SF-conservation invariant (test #1)", function () {
  this.timeout(600000);

  it("I1/I2: ledger + custody conservation hold after every op in a 400-op random sweep", async () => {
    const { sf, mock, usdc } = await deploy();
    const sfAddr = await sf.getAddress();
    const members = Array.from({ length: 6 }, () => ethers.Wallet.createRandom().address);
    const rnd = mulberry32(0xc0ffee);

    const assertInvariant = async (label) => {
      const outstanding = await totalOutstanding(sf, members);
      const loaned = await sf.totalRescueLoaned();
      const repaid = await sf.totalRescueRepaid();
      // I1 — ledger conservation
      expect(outstanding, `[${label}] Σ memberDebt == loaned − repaid`).to.equal(loaned - repaid);
      // repaid can never exceed loaned
      expect(repaid <= loaned, `[${label}] repaid (${repaid}) <= loaned (${loaned})`).to.equal(true);
      // I2 — custody matches accounting
      expect(await usdc.balanceOf(sfAddr), `[${label}] SF USDC balance == totalBalance`)
        .to.equal(await sf.totalBalance());
    };

    await assertInvariant("init");

    const N = 400;
    for (let i = 0; i < N; i++) {
      const m = members[Math.floor(rnd() * members.length)];
      const roll = rnd();
      if (roll < 0.45) {
        // book a loan: tier 0..9, amount 1..500 cents
        const tier = Math.floor(rnd() * 10);
        const amt = BigInt(1 + Math.floor(rnd() * 500)) * 10_000n;
        await mock.bookLoan(m, tier, amt);
      } else if (roll < 0.75) {
        // pool-share redirect at the banded clawback rate
        const earning = BigInt(1 + Math.floor(rnd() * 300)) * 10_000n;
        await mock.redirectRepay(m, earning);
      } else if (roll < 0.95) {
        // explicit repay (cycle-out / withdraw settle), capped at owed inside SF
        const owed = await sf.memberDebt(m);
        if (owed > 0n) {
          const pay = rnd() < 0.5 ? owed : owed / 2n + 1n;
          await mock.repay(m, pay);
        }
      } else {
        // migration-style batch: sweep several stranded debts in one round
        for (let k = 0; k < 3; k++) {
          const tier = Math.floor(rnd() * 10);
          const amt = BigInt(1 + Math.floor(rnd() * 50)) * 10_000n;
          await mock.bookLoan(members[Math.floor(rnd() * members.length)], tier, amt);
        }
      }
      await assertInvariant(`op ${i} roll=${roll.toFixed(3)}`);
    }

    // Drain everything: outstanding must reach exactly zero and loaned == repaid.
    for (const m of members) {
      const owed = await sf.memberDebt(m);
      if (owed > 0n) await mock.repay(m, owed);
    }
    expect(await totalOutstanding(sf, members), "all debt drained").to.equal(0n);
    expect(await sf.totalRescueRepaid()).to.equal(await sf.totalRescueLoaned());
  });

  it("banded clawback 90/80/70/60 keyed to issuing tier (direction A), owner-retunable", async () => {
    const { sf, mock } = await deploy();
    const cases = [
      [0, 6000n], [2, 6000n],   // T1–T3 → 60%
      [3, 7000n], [4, 7000n],   // T4–T5 → 70%
      [5, 8000n], [6, 8000n],   // T6–T7 → 80%
      [7, 9000n], [9, 9000n],   // T8–T10 → 90%
    ];
    for (const [tier, bps] of cases) {
      const m = ethers.Wallet.createRandom().address;
      await mock.bookLoan(m, tier, 1_000_000n);
      expect(await sf.clawbackBpsFor(m), `issuing tier T${tier + 1}`).to.equal(bps);
    }
    // Owner retunes the bands live.
    await sf.setClawbackBands([5000, 4000, 3000, 2000]);
    const m2 = ethers.Wallet.createRandom().address;
    await mock.bookLoan(m2, 9, 1_000_000n); // T10 → band 0
    expect(await sf.clawbackBpsFor(m2)).to.equal(5000n);
  });

  it("highest issuing tier drives the band; full repay clears the tier back to 0", async () => {
    const { sf, mock } = await deploy();
    const m = ethers.Wallet.createRandom().address;
    await mock.bookLoan(m, 1, 1_000_000n); // T2 → band 3 (60%)
    expect(await sf.clawbackBpsFor(m)).to.equal(6000n);
    await mock.bookLoan(m, 8, 1_000_000n); // T9 → raises to band 0 (90%)
    expect(await sf.clawbackBpsFor(m)).to.equal(9000n);
    expect(await sf.debtIssuingTier(m)).to.equal(8);
    await mock.repay(m, await sf.memberDebt(m)); // clear all
    expect(await sf.memberDebt(m)).to.equal(0n);
    expect(await sf.debtIssuingTier(m)).to.equal(0);
  });

  it("only authorized matrices can book or repay on the ledger", async () => {
    const { sf } = await deploy();
    const [, stranger] = await ethers.getSigners();
    const m = ethers.Wallet.createRandom().address;
    await expect(sf.connect(stranger).increaseMemberDebt(m, 0, 1_000_000n))
      .to.be.revertedWith("SF: not authorized");
    await expect(sf.connect(stranger)["receiveDebtRepayment(address,uint256)"](m, 1_000_000n))
      .to.be.revertedWith("SF: not authorized");
  });
});
