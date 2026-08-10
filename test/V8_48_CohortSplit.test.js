// V8_48_CohortSplit.test.js
//
// Regression for V8.48 item 27 — CommunityWallet.distribute() cohort inversion.
//
// THE DEFECT (measured live 2026-08-09, Genesis 500 / Pioneer 146):
//   distribute() divided each cohort's share by the LIVE member count, so a
//   partially filled cohort concentrated its whole share on fewer people. The
//   60/40 split paid each Pioneer $5.11 against each Genesis member's $2.24 —
//   2.3x — inverting the seniority the wallet exists to reward. It held for any
//   Pioneer count below 334, i.e. for the entire ramp to 1000.
//
// THE FIX: divide by COHORT_SIZE. A seat's value no longer depends on how many
// seats are occupied; the unoccupied share rolls over instead of concentrating.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const M6  = (n) => ethers.parseUnits(n.toString(), 6);

describe("V8.48 item 27 — CommunityWallet cohort split", function () {
  let usdc, cw, owner, enrollor;

  // Deploy fresh, enrol `g` Genesis and `p` Pioneer wallets, fund with `amount`.
  async function setup(g, p, amount) {
    [owner, enrollor] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    cw   = await (await ethers.getContractFactory("CommunityWallet"))
                  .deploy(await usdc.getAddress(), owner.address);

    // Deterministic throwaway addresses — enrolment only records the address.
    const addrs = [];
    for (let i = 0; i < g + p; i++) {
      addrs.push(ethers.getAddress(
        "0x" + (BigInt("0x1000000000000000000000000000000000000000") + BigInt(i + 1))
          .toString(16).padStart(40, "0")));
    }
    // enrollBatch is onlyOwner and fills Genesis first, then Pioneer.
    const CHUNK = 200;
    for (let i = 0; i < addrs.length; i += CHUNK) {
      await cw.enrollBatch(addrs.slice(i, i + CHUNK));
    }
    await usdc.mint(owner.address, amount);
    await usdc.approve(await cw.getAddress(), amount);
    await cw.deposit(amount);
    return addrs;
  }

  async function runDistribution() {
    // V8.48: distribute() gates on a CALENDAR DATE (the 25th) plus one-per-month, not on
    // a rolling interval. A fixed +31 days is no longer a valid way to reach it — 31 days
    // from an arbitrary start lands on an arbitrary day of the month, and any day before
    // the 25th reverts "CW: before the monthly date".
    //
    // Jump to the contract's OWN nextDistributionTime() instead of computing a date here.
    // A test that recomputes the schedule is a second, independent answer to the same
    // question, and this project has already paid for one of those: a `day-of-month >= 25`
    // gate lived in the frontend until 2026-08-07 and produced a belief the contract never
    // supported. The contract is the single source of truth, in tests too.
    const nextT = Number(await cw.nextDistributionTime());
    const nowT  = (await ethers.provider.getBlock("latest")).timestamp;
    if (nextT > nowT) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [nextT]);
    }
    await ethers.provider.send("evm_mine", []);
    await cw.distribute();
    const d = await cw.distributions(0);
    return { perGenesis: d.perGenesis, perPioneer: d.perPioneer };
  }

  it("Genesis out-earns Pioneer per head at the LIVE ratio that used to invert (500/146)", async function () {
    await setup(500, 146, M6(10_000));
    const { perGenesis, perPioneer } = await runDistribution();

    // The bug produced perPioneer > perGenesis here. Seniority must hold.
    expect(perGenesis).to.be.gt(perPioneer,
      "Genesis must out-earn Pioneer per head — this is the exact 500/146 state " +
      "that paid Pioneers 2.3x on 2026-08-09");

    // At the default 60/40 over a FIXED divisor the ratio is exactly 1.5x.
    expect(perGenesis * 4n).to.equal(perPioneer * 6n,
      "per-head ratio must be genesisBps:pioneerBps = 60:40 = 1.5x");
  });

  it("per-head value does NOT depend on how many seats are filled", async function () {
    await setup(500, 100, M6(10_000));
    const a = await runDistribution();
    await setup(500, 400, M6(10_000));
    const b = await runDistribution();

    expect(a.perGenesis).to.equal(b.perGenesis,
      "a Genesis seat must be worth the same regardless of Pioneer enrolment");
    expect(a.perPioneer).to.equal(b.perPioneer,
      "a Pioneer seat must be worth the same regardless of how many Pioneers exist");
  });

  it("holds at every point on the ramp, including an empty Pioneer cohort", async function () {
    for (const p of [0, 1, 146, 333, 334, 500]) {
      await setup(500, p, M6(10_000));
      const { perGenesis, perPioneer } = await runDistribution();
      expect(perGenesis).to.be.gt(perPioneer,
        `inverted at Pioneer count ${p} — the old divisor inverted below 334`);
    }
  });

  it("the unfilled-seat share stays in the pool rather than being paid out", async function () {
    await setup(500, 0, M6(10_000));       // Pioneer cohort entirely empty
    const before = await usdc.balanceOf(await cw.getAddress());
    const { perPioneer } = await runDistribution();
    const pending = await cw.totalActivePending();

    // 50% distributes; of that, 40% belongs to Pioneer seats that do not exist.
    // Those must NOT be redistributed to Genesis — they roll over.
    const distributable = before / 2n;                 // distributeRatioBps 5000
    const genesisShare  = (distributable * 6000n) / 10000n;
    expect(pending).to.be.lte(genesisShare,
      "Pioneer's share of an empty cohort must not leak into the Genesis payout");
    expect(perPioneer).to.be.gt(0n,
      "per-seat Pioneer value is still defined even with nobody enrolled");
  });
});
