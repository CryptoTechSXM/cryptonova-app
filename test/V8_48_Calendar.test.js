// V8_48_Calendar.test.js
//
// Regression for V8.48 — CommunityWallet distributes on THE 25TH OF EVERY MONTH.
//
// WHAT THIS REPLACED, AND WHY IT MATTERS
//   distributeInterval was a ROLLING 30-day window measured from whenever the last
//   distribution actually fired. It drifts: 4 Sep, ~4 Oct, ~3 Nov — roughly five days
//   a year, never landing on a fixed date. Meanwhile a `day-of-month >= 25` gate lived
//   in the FRONTEND until 2026-08-07, so members were told "the 25th" by a rule the
//   contract never had. V8.48 makes the 25th real, in the contract, and deletes the
//   interval so there is only one answer to the question.
//
// WHAT THIS FILE GUARDS
//   Calendar arithmetic fails quietly. A wrong civil-date conversion still compiles,
//   still distributes, and only shows up as a date nobody expected — one month later.
//   So every assertion below reads the real calendar out of the contract and checks
//   the DAY OF MONTH, not an elapsed-seconds delta.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);

// Read a timestamp as UTC civil parts. Deliberately uses JS Date rather than
// re-implementing Hinnant: an independent implementation is the point of a test.
const civil = (ts) => {
  const d = new Date(Number(ts) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

async function at(ts) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
  await ethers.provider.send("evm_mine", []);
}

// Seconds for a given UTC calendar date.
const utc = (y, m, d, hh = 12) => Math.floor(Date.UTC(y, m - 1, d, hh) / 1000);

describe("V8.48 — CommunityWallet monthly calendar (the 25th)", function () {
  let usdc, cw, owner;

  async function deploy({ genesis = 4, pioneer = 0, fund = M6(10_000) } = {}) {
    [owner] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    cw = await (await ethers.getContractFactory("CommunityWallet"))
      .deploy(await usdc.getAddress(), owner.address);

    const addrs = [];
    for (let i = 0; i < genesis + pioneer; i++) {
      addrs.push(ethers.getAddress(
        "0x" + (BigInt("0x1000000000000000000000000000000000000000") + BigInt(i + 1))
          .toString(16).padStart(40, "0")));
    }
    if (addrs.length) await cw.enrollBatch(addrs);
    if (fund > 0n) {
      await usdc.mint(owner.address, fund);
      await usdc.approve(await cw.getAddress(), fund);
      await cw.deposit(fund);
    }
    return addrs;
  }

  // ── the default ───────────────────────────────────────────────────────────
  it("defaults to the 25th, and the default is inside the February-safe range", async function () {
    await deploy();
    expect(await cw.distributionDayOfMonth()).to.equal(25);
    expect(Number(await cw.distributionDayOfMonth())).to.be.lte(28);
  });

  // ── the gate ──────────────────────────────────────────────────────────────
  it("reverts before the 25th and succeeds on it", async function () {
    await deploy();
    await at(utc(2026, 9, 24));
    await expect(cw.distribute()).to.be.revertedWith("CW: before the monthly date");

    await at(utc(2026, 9, 25));
    await expect(cw.distribute()).to.not.be.reverted;

    const d = civil((await ethers.provider.getBlock("latest")).timestamp);
    expect(d.d).to.equal(25, "distribution must land on the 25th, not 25 days later");
  });

  it("fires at most once per calendar month — the 26th does not open a second window", async function () {
    await deploy();
    await at(utc(2026, 9, 25));
    await cw.distribute();
    expect(await cw.distributionCount()).to.equal(1);

    // A day-of-month check ALONE would pass here: the 26th is also ">= 25".
    await at(utc(2026, 9, 26));
    await expect(cw.distribute()).to.be.revertedWith("CW: already distributed this month");
    await at(utc(2026, 9, 30));
    await expect(cw.distribute()).to.be.revertedWith("CW: already distributed this month");

    // Next month re-opens it.
    await at(utc(2026, 10, 25));
    await expect(cw.distribute()).to.not.be.reverted;
    expect(await cw.distributionCount()).to.equal(2);
  });

  // ── the schedule does not drift ───────────────────────────────────────────
  it("lands on the 25th for twelve consecutive months, including February", async function () {
    await deploy();
    // Start in November so the run crosses a year boundary AND February.
    let y = 2026, m = 11;
    const days = [];
    for (let i = 0; i < 12; i++) {
      await at(utc(y, m, 25));
      await cw.distribute();
      days.push(`${y}-${String(m).padStart(2, "0")}-` +
        String(civil((await ethers.provider.getBlock("latest")).timestamp).d).padStart(2, "0"));
      if (m === 12) { y += 1; m = 1; } else { m += 1; }
    }
    // Every entry must end in -25. A rolling interval produces -25, -24, -23...
    for (const stamp of days) {
      expect(stamp.endsWith("-25"), `drifted: ${days.join(" ")}`).to.equal(true);
    }
    expect(days.some((s) => s.includes("-02-"))).to.equal(true, "February must be covered");
    expect(await cw.distributionCount()).to.equal(12);
  });

  // ── nextDistributionTime: the frontend's single source of truth ───────────
  it("nextDistributionTime() points at the 25th before it, and at NEXT month's 25th after", async function () {
    await deploy();

    await at(utc(2026, 9, 10));
    let nxt = civil(await cw.nextDistributionTime());
    expect([nxt.y, nxt.m, nxt.d]).to.deep.equal([2026, 9, 25], "before the 25th: this month");

    await at(utc(2026, 9, 25));
    await cw.distribute();
    nxt = civil(await cw.nextDistributionTime());
    expect([nxt.y, nxt.m, nxt.d]).to.deep.equal([2026, 10, 25], "after distributing: next month");
  });

  it("nextDistributionTime() rolls the YEAR over in December", async function () {
    await deploy();
    await at(utc(2026, 12, 25));
    await cw.distribute();
    const nxt = civil(await cw.nextDistributionTime());
    expect([nxt.y, nxt.m, nxt.d]).to.deep.equal([2027, 1, 25]);
  });

  it("the claim window ends on the NEXT monthly date, not 30 days out", async function () {
    await deploy();
    await at(utc(2026, 1, 25));   // January -> expiry must be 25 Feb (31 days), not +30
    await cw.distribute();
    const d0 = await cw.distributions(0);
    const exp = civil(d0.expiresAt);
    expect([exp.y, exp.m, exp.d]).to.deep.equal([2026, 2, 25],
      "a +30 day window would expire 24 Feb and cut the claim period a day short");
  });

  // ── the governed setter ───────────────────────────────────────────────────
  it("setDistributionDayOfMonth moves the date and rejects days that skip February", async function () {
    await deploy();
    await expect(cw.setDistributionDayOfMonth(29)).to.be.revertedWith("CW: day must be 1-28");
    await expect(cw.setDistributionDayOfMonth(31)).to.be.revertedWith("CW: day must be 1-28");
    await expect(cw.setDistributionDayOfMonth(0)).to.be.revertedWith("CW: day must be 1-28");

    await cw.setDistributionDayOfMonth(1);
    await at(utc(2026, 9, 1));
    await expect(cw.distribute()).to.not.be.reverted;
    expect(civil((await ethers.provider.getBlock("latest")).timestamp).d).to.equal(1);
  });

  it("only a GOVERNOR can move the date", async function () {
    await deploy();
    const [, stranger] = await ethers.getSigners();
    await expect(cw.connect(stranger).setDistributionDayOfMonth(10)).to.be.reverted;
  });

  // ── distributeReady: what Chainlink actually gates on ─────────────────────
  it("distributeReady() tracks the calendar, not an elapsed interval", async function () {
    await deploy();
    await at(utc(2026, 9, 24));
    expect(await cw.distributeReady()).to.equal(false, "not ready on the 24th");
    await at(utc(2026, 9, 25));
    expect(await cw.distributeReady()).to.equal(true, "ready on the 25th");
    await cw.distribute();
    expect(await cw.distributeReady()).to.equal(false, "not ready again the same month");
    await at(utc(2026, 10, 25));
    expect(await cw.distributeReady()).to.equal(true, "ready again next month");
  });

  // ── the testnet escape hatch ──────────────────────────────────────────────
  //
  // forceDistribute() used to work by zeroing lastDistributionTime, because that is
  // what distribute() gated on. The calendar change made that reset a no-op, so the
  // function reverted on any day before the 25th — silently, because nothing called
  // it. These two tests exist so that cannot recur.
  it("forceDistribute() works before the 25th", async function () {
    await deploy();
    await at(utc(2026, 9, 3));
    await expect(cw.distribute()).to.be.revertedWith("CW: before the monthly date");
    await expect(cw.forceDistribute()).to.not.be.reverted;
    expect(await cw.distributionCount()).to.equal(1);
  });

  it("a forced run does NOT consume the month's real slot", async function () {
    await deploy();
    await at(utc(2026, 9, 3));
    await cw.forceDistribute();

    // The genuine monthly distribution must still be available on the 25th.
    await at(utc(2026, 9, 25));
    expect(await cw.distributeReady()).to.equal(true,
      "QA on the 3rd must not cancel the real distribution on the 25th");
    await expect(cw.distribute()).to.not.be.reverted;
    expect(await cw.distributionCount()).to.equal(2);
  });

  it("forceDistribute() is admin-only and leaves no bypass set between calls", async function () {
    await deploy();
    const [, stranger] = await ethers.getSigners();
    await at(utc(2026, 9, 3));
    await expect(cw.connect(stranger).forceDistribute()).to.be.reverted;

    await cw.forceDistribute();
    // If the bypass flag leaked, this would succeed instead of reverting.
    await at(utc(2026, 9, 4));
    await expect(cw.distribute()).to.be.revertedWith("CW: before the monthly date");
  });
});
