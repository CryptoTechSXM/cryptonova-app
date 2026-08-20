"use strict";
/**
 * V8_50_GateCost.test.js — session 17. What does the sponsorship gate COST?
 *
 * ⛔ WHY THIS FILE EXISTS, AND IT IS THE LESSON OF THE RUN THAT PRECEDED IT.
 *   The gate was first priced end-to-end through V8_50_KeeperGas with a BINDING ceiling
 *   (baseAdvanceBps 1500). The fund then refused loans the baseline had granted, the
 *   batch composition moved from PARKED_RESCUEx8/EVICT_PARKEDx4 to x2/x10, and every gas
 *   figure in that run priced a DIFFERENT POPULATION rather than a different mechanism.
 *   A measurement whose control arm changed is not a measurement.
 *
 *   Two things follow, and both are built here:
 *     1. baseAdvanceBps is now 10_000 — the gate reads the router on every call but the
 *        ceiling never drops, so the keeper's work list is identical to baseline.
 *     2. THIS is the second instrument: the added read, measured alone, in gas units and
 *        not in two-decimal millions. The end-to-end delta must then equal a WHOLE-NUMBER
 *        multiple of what this reads. A non-integer multiple means loanHeadroom is called
 *        more often than the call graph says — and that would be the real finding.
 *
 * WHAT THE TWO ARMS ARE
 *   sfPlain — tierRouter never wired, so `tierRouter != address(0)` short-circuits and no
 *             router call happens. Everything else is the same bytecode.
 *   sfGated — tierRouter wired to a mock with the same storage and call shape as
 *             TierRouter.directCount, which is all the gas depends on.
 *   The difference is therefore the staticcall plus the directCount slot. ⚠ It is a LOWER
 *   BOUND on the change against the ORIGINAL contract, which did not read `tierRouter` in
 *   this function at all — that SLOAD is inside BOTH arms here and cancels. The
 *   end-to-end run is what carries the total.
 *
 * Run:  npx hardhat test test/V8_50_GateCost.test.js
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const FEE = 10_000_000n;
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 8) => String(v).padStart(n);

// ⛔ SKIPPED ON PURPOSE. This test only means anything while the fixture is applied —
//    without it sfPlain and sfGated are the same contract, the delta is 0, and the
//    assertions fail. The tree ships WITHOUT the gate (session 17 measured and reverted).
//    To run it:  node scripts/fixture_gate_apply.js
//                change describe.skip to describe below
//                npx hardhat compile && npx hardhat test test/V8_50_GateCost.test.js
//                node scripts/fixture_gate_apply.js --undo   <- do not forget this
describe.skip("V8.50 session 17 — the sponsorship gate, priced in isolation", function () {
  it("GATE-1: one gated loanHeadroom against one ungated one, in gas units", async function () {
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
    async function read(sf, member) {
      await (await probe.probeTwice(await sf.getAddress(), member, 0)).wait();
      return {
        cold:  await probe.costCold(),
        warm:  await probe.costWarm(),
        value: await probe.value(),
      };
    }

    const plain0 = await read(sfPlain, noDirects.address);
    const gated0 = await read(sfGated, noDirects.address);
    const gated1 = await read(sfGated, oneDirect.address);

    console.log(`\n      THE ADDED READ, MEASURED ALONE (gas units, not millions)\n`);
    console.log(`      arm                                     cold      warm     headroom`);
    console.log(`      ------------------------------------------------------------------`);
    console.log(`      ${pad("ungated (tierRouter unset)", 34)}${num(plain0.cold)}  ${num(plain0.warm)}  ${num(plain0.value, 11)}`);
    console.log(`      ${pad("gated, member with 0 directs", 34)}${num(gated0.cold)}  ${num(gated0.warm)}  ${num(gated0.value, 11)}`);
    console.log(`      ${pad("gated, member with 1 direct", 34)}${num(gated1.cold)}  ${num(gated1.warm)}  ${num(gated1.value, 11)}`);

    const dCold = gated0.cold - plain0.cold;
    const dWarm = gated0.warm - plain0.warm;
    console.log(`      ------------------------------------------------------------------`);
    console.log(`      ADDED COST      cold ${dCold}   warm ${dWarm}   (per loanHeadroom call)\n`);

    // ── The answer must not move. A non-binding gate that changes the RESULT is a bug,
    //    not a cost. This is the cheapest correctness check available and it is free here.
    expect(gated0.value, "the non-binding gate CHANGED the headroom — it is not non-binding")
      .to.equal(plain0.value);
    expect(gated1.value, "headroom differs by direct count while baseAdvanceBps is 10_000")
      .to.equal(plain0.value);

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
});
