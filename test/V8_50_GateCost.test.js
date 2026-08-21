"use strict";
/**
 * V8_50_GateCost.test.js — what does the sponsorship gate COST?
 * Session 17 built it; session 19 (2026-08-21) UN-SKIPPED and rewrote it when the gate
 * was promoted from a fixture into the tree.
 *
 * ⛔ WHY THIS FILE EXISTS, AND IT IS THE LESSON OF THE RUN THAT PRECEDED IT.
 *   The gate was first priced end-to-end through V8_50_KeeperGas with a BINDING ceiling
 *   (baseAdvanceBps 1500). The fund then refused loans the baseline had granted, the
 *   batch composition moved from PARKED_RESCUEx8/EVICT_PARKEDx4 to x2/x10, and every gas
 *   figure in that run priced a DIFFERENT POPULATION rather than a different mechanism.
 *   A measurement whose control arm changed is not a measurement.
 *   THIS is the second instrument: the added read, measured alone, in gas units and not
 *   in two-decimal millions. The end-to-end delta must then equal a WHOLE-NUMBER multiple
 *   of what this reads. A non-integer multiple means loanHeadroom is called more often
 *   than the call graph says — and that would be the real finding.
 *
 * ⛔ WHAT SESSION 19 CHANGED, AND WHY THE OLD SHAPE NO LONGER WORKS.
 *   Session 17's fixture read the router UNCONDITIONALLY, so it could be held at
 *   baseAdvanceBps = 10_000 and price the read without changing any answer. The SHIPPED
 *   code short-circuits on `baseAdvanceBps < insolvencyFloorBps` BEFORE touching the
 *   router, so at 10_000 there is no read to price — the old GATE-1 would have failed on
 *   its own "the branch never ran" assertion, correctly.
 *   The fix is to price the read in the configuration production will actually run in
 *   (gate ARMED) and to hold the ANSWER constant a different way: measure a member who
 *   HAS a direct. The branch runs, the router is read, and the ceiling comes back
 *   unchanged — so any gas difference is the read and nothing else.
 *
 * THE THREE ARMS
 *   plain  — same bytecode, tierRouter never wired. Enters the branch, finds
 *            address(0), stops. The `tierRouter` SLOAD is in BOTH arms and cancels.
 *   gated  — tierRouter wired to MockDirectRouter (same storage and call shape as
 *            TierRouter.directCount, which is all the gas depends on).
 *   inert  — both wired, both at baseAdvanceBps = 10_000. Nothing should be read at all
 *            and the delta must be EXACTLY ZERO. That is GATE-2, and it is the pin on
 *            the claim that shipping the gate switched off is free.
 *
 * ⚠ STILL A LOWER BOUND on the change against the pre-gate contract, which did not read
 *   `tierRouter` in this function at all. The end-to-end run carries the total.
 *
 * Run:  npx hardhat test test/V8_50_GateCost.test.js
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const FEE  = 10_000_000n;
const BASE = 3_000n;                 // the armed policy value (18.18 / 19.0)
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 8) => String(v).padStart(n);

describe("V8.50 — the sponsorship gate, priced in isolation", function () {
  this.timeout(120_000);

  async function rig() {
    const [owner, noDirects, oneDirect] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const U    = await usdc.getAddress();
    const SF   = await ethers.getContractFactory("StabilityFund");

    const sfPlain = await SF.deploy(U, owner.address);
    const sfGated = await SF.deploy(U, owner.address);
    const router  = await (await ethers.getContractFactory("MockDirectRouter")).deploy();

    await sfPlain.setTierFee(0, FEE);
    await sfGated.setTierFee(0, FEE);
    await sfGated.setTierRouter(await router.getAddress());
    await router.setDirects(oneDirect.address, 1);

    const probe = await (await ethers.getContractFactory("GateProbe")).deploy();
    // Each probeTwice is its own transaction, so costCold is genuinely cold every time.
    const read = async (sf, member) => {
      await (await probe.probeTwice(await sf.getAddress(), member, 0)).wait();
      return { cold: await probe.costCold(), warm: await probe.costWarm(), value: await probe.value() };
    };
    return { owner, noDirects, oneDirect, sfPlain, sfGated, router, read };
  }

  it("GATE-1: the added read, armed, measured alone in gas units", async function () {
    const { noDirects, oneDirect, sfPlain, sfGated, read } = await rig();

    // ARM BOTH ARMS. Both then enter the branch; only the wired one reaches the router,
    // so the tierRouter SLOAD cancels and the delta is the staticcall plus the slot.
    await sfPlain.setBaseAdvanceBps(BASE);
    await sfGated.setBaseAdvanceBps(BASE);

    const plain1 = await read(sfPlain, oneDirect.address);
    const gated1 = await read(sfGated, oneDirect.address);   // HAS a direct: answer unchanged
    const gated0 = await read(sfGated, noDirects.address);   // no direct: the gate binds

    console.log(`\n      THE ADDED READ, MEASURED ALONE (gas units, not millions)\n`);
    console.log(`      arm                                     cold      warm     headroom`);
    console.log(`      ------------------------------------------------------------------`);
    console.log(`      ${pad("plain (tierRouter unset)", 34)}${num(plain1.cold)}  ${num(plain1.warm)}  ${num(plain1.value, 11)}`);
    console.log(`      ${pad("gated, member WITH 1 direct", 34)}${num(gated1.cold)}  ${num(gated1.warm)}  ${num(gated1.value, 11)}`);
    console.log(`      ${pad("gated, member with 0 directs", 34)}${num(gated0.cold)}  ${num(gated0.warm)}  ${num(gated0.value, 11)}`);

    const dCold = gated1.cold - plain1.cold;
    const dWarm = gated1.warm - plain1.warm;
    console.log(`      ------------------------------------------------------------------`);
    console.log(`      ADDED COST      cold ${dCold}   warm ${dWarm}   (per loanHeadroom call)\n`);

    // ── The COST arm must not move the ANSWER. A member with a direct is untouched at
    //    any base — 18.4's framing correction, asserted here as well as in GateBase.
    expect(gated1.value, "a member WITH a direct must read the same headroom gated or not")
      .to.equal(plain1.value);
    // ── And the gate must actually bind for the member it is aimed at, or this whole
    //    file is pricing a mechanism that does nothing.
    expect(gated0.value, "the armed gate did not lower the zero-direct ceiling")
      .to.equal(FEE * BASE / 10_000n);

    // ── Warm/cold must behave like the EVM, or the probe is measuring something else.
    expect(dCold > dWarm, "cold access did not cost more than warm — probe is not measuring the read")
      .to.equal(true);
    expect(dWarm > 0n, "the gated arm was not more expensive at all — the branch never ran")
      .to.equal(true);

    // ── THE MEET LINE. The end-to-end run has to land on one of these rows.
    console.log(`      WHAT THE END-TO-END RUN MUST SHOW, if the call graph is what it looks like`);
    console.log(`      calls per rescue   predicted added gas`);
    for (const n of [1n, 2n, 3n, 4n]) {
      const total = dCold + (n - 1n) * dWarm;
      console.log(`      ${num(n, 8)}           ${num(total, 10)}   (${(Number(total) / 1e6).toFixed(3)}M)`);
    }
    console.log(`      -> V8_50_KeeperGas prints to 0.01M, so anything under ~10,000 gas is`);
    console.log(`         BELOW THAT INSTRUMENT'S RESOLUTION and will read as +0.00M or +0.01M.`);
    console.log(`         That is agreement, not absence. Say so rather than claiming zero.\n`);
  });

  it("GATE-2: SHIPPING IT SWITCHED OFF IS FREE — at the default the router is never read", async function () {
    const { oneDirect, noDirects, sfPlain, sfGated, read } = await rig();

    // Defaults, untouched: baseAdvanceBps 10_000 >= insolvencyFloorBps 5_000.
    expect(await sfGated.baseAdvanceBps(), "declared default").to.equal(10_000n);

    const plain = await read(sfPlain, noDirects.address);
    const gated = await read(sfGated, noDirects.address);

    console.log(`\n      INERT ARM — default baseAdvanceBps, router wired but unreachable`);
    console.log(`      plain cold ${plain.cold}  warm ${plain.warm}`);
    console.log(`      gated cold ${gated.cold}  warm ${gated.warm}\n`);

    // This is the whole justification for the inert default in the deploy runbook: the
    // gate can sit in the contract from day one at ZERO gas until it is armed.
    expect(gated.cold - plain.cold, "inert gate cost cold gas — the short-circuit is not short-circuiting")
      .to.equal(0n);
    expect(gated.warm - plain.warm, "inert gate cost warm gas — the short-circuit is not short-circuiting")
      .to.equal(0n);
    expect(gated.value, "inert gate changed the answer").to.equal(plain.value);

    // And a member with a direct is equally untouched, for the same reason.
    const g1 = await read(sfGated, oneDirect.address);
    expect(g1.value).to.equal(plain.value);
  });
});
