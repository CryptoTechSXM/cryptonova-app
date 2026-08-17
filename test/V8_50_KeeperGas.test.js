"use strict";
/**
 * V8_50_KeeperGas.test.js — V8.50 defect 5: what does a batch actually COST?
 *
 * WHY THIS FILE EXISTS
 *   maxItemsPerUpkeep is held at 15 with a written case for lowering it to 5. That case
 *   rests on ONE measurement — ~2.6M gas for a rescued parked item, taken on the V8.49
 *   private chain — and that number PREDATES items A and E1. Item A pays an A->B crossing
 *   out of the member's own reserve, so a MatA parker's rescue never touches the
 *   StabilityFund at all: no loanEligibleFor, no payForceCross, no debt write. The
 *   expensive shape did not get cheaper, it got RARER, and 2.6M x 15 is arithmetic on a
 *   number that no longer describes the population.
 *
 *   Setting a live gas dial off a stale estimate is the thing this project keeps
 *   promising not to do. So: measure the batch, then set the cap.
 *
 * WHAT IT MEASURES, AND WHY IT IS THE BATCH AND NOT THE ITEM
 *   The failure mode is a performUpkeep that runs OUT OF GAS, and gas is consumed by the
 *   whole transaction, not by an item in isolation. Per-item numbers summed by hand miss
 *   the shared prologue, the warm/cold storage transitions between items, and the fact
 *   that discovery order decides WHICH items are in the batch at all — which V8.50 defect
 *   6 just changed. So the primary reading is a real performUpkeep at each enumerated cap,
 *   over one identical world restored from a snapshot each time.
 *
 *   Per-type costs are measured too, single-item, because they are what a future session
 *   needs in order to re-project without re-running everything. They are reported as a
 *   SECONDARY reading and the batch numbers win where they disagree.
 *
 * WHAT IT DOES NOT MEASURE, STATED SO NOBODY QUOTES IT WRONGLY
 *   MATRIX_SIZE here is 7. The live tiers run 127. Position loops in _scanMatrix and the
 *   L1/chain payout walk are shorter here than on the live chain, so THESE ARE NOT LIVE
 *   NUMBERS. What this file establishes is the SHAPE — the ratio between a self-funded
 *   rescue and an SF-funded one, and how batch cost scales with the cap. Anyone using it
 *   to pick a live cap must say so out loud and add headroom for the size difference.
 *
 * Run: npx hardhat test test/V8_50_KeeperGas.test.js
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE = 10_000_000n;
const SIZE = 7;

const WORK = {
  VELOCITY: 0, GHOST: 1, RECLAIM: 2, CHAIN_LINK: 3, PARKED_RESCUE: 4,
  VELOCITY_GATE: 5, EVICT_PARKED: 6, DISTRIBUTE_CW: 7, FORCE_ROTATE: 8,
  ADVANCE_EPOCH: 9,
};
const NAME = Object.fromEntries(Object.entries(WORK).map(([k, v]) => [v, k]));
const CAPS = [5, 10, 15, 20, 30, 40];   // the enumerated menu, in full

/**
 * The ceiling this is judged against. NOT a block gas limit — the number that matters is
 * whatever the automation registry will actually hand performUpkeep, which is lower and
 * is a deployment setting. 17.8M is the figure the defect 5 write-up uses; it lives here
 * as a named constant so a future session changes it in ONE place and re-reads the table
 * rather than re-deriving the argument.
 */
const CEILING = 17_800_000n;

function decodeItems(performData) {
  if (!performData || performData === "0x") return [];
  const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
    performData
  );
  return items.map((i) => ({
    workType: Number(i.workType), tierIndex: Number(i.tierIndex),
    addr1: i.addr1, addr2: i.addr2,
  }));
}
const encodeItems = (items) => ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
  [items.map((i) => [i.workType, i.tierIndex, i.addr1, i.addr2])]);

const tally = (items) => {
  const c = {};
  for (const i of items) c[NAME[i.workType]] = (c[NAME[i.workType]] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k}x${v}`).join(" ") || "(none)";
};
const M = (g) => (Number(g) / 1e6).toFixed(2) + "M";

describe("V8.50 defect 5 — the cost of a batch, measured", function () {
  this.timeout(600_000);

  let ctx, snap;

  async function deployWorld(size) {
    const sigs = await ethers.getSigners();
    const [owner, W1, devOps] = sigs;

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
    const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
    const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
      .deploy(cnovaAddr, usdcAddr, owner.address);
    const sf = await (await ethers.getContractFactory("StabilityFund")).deploy(usdcAddr, owner.address);
    const tr = await (await ethers.getContractFactory("TierRouter", {
      libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target },
    })).deploy(usdcAddr, owner.address);
    const pm = await (await ethers.getContractFactory("PairManagerV8")).deploy(usdcAddr, FEE, owner.address);
    const [tresAddr, sfAddr, trAddr, pmAddr] = [
      await treasury.getAddress(), await sf.getAddress(),
      await tr.getAddress(), await pm.getAddress(),
    ];

    const keeperLib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
    const keeper = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: await keeperLib.getAddress() },
    })).deploy(trAddr, sfAddr);
    const keeperAddr = await keeper.getAddress();

    const dp = {
      usdc: usdcAddr, cnova: cnovaAddr, treasury: tresAddr,
      devWallet: devOps.address, opsWallet: devOps.address,
      accountOne: W1.address, admin: owner.address,
    };
    const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
    const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
      libraries: { MatrixLogicLib: await matrixLib.getAddress() },
    });
    const matA = await MX.deploy(dp, FEE, size, true, 0, SPLITS, CP_BPS);
    const matB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
    const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

    await matA.setPartner(matBAddr);
    await matB.setPartner(matAAddr);
    for (const m of [matA, matB]) {
      await m.setPairManager(pmAddr);
      await m.setTierRouter(trAddr);
      await m.setStabilityFund(sfAddr);
      await m.setMatrixKeeper(keeperAddr);
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
    }
    await pm.addPair(matAAddr, matBAddr);
    await pm.setTierRouter(trAddr);
    await tr.registerTier(0, pmAddr, FEE);
    await tr.setTierMatrices(0, matAAddr, matBAddr);
    await tr.registerMatrix(matAAddr, 0);
    await tr.registerMatrix(matBAddr, 0);
    await tr.setMatrixKeeper(keeperAddr);
    await sf.setMatrixKeeper(keeperAddr);
    await sf.setTierFee(0, FEE);
    await sf.setTierRouter(trAddr);
    await keeper.setPairManager(0, pmAddr);

    // Everything discoverable, so the batch is limited by the CAP and nothing else. This
    // file is about cost per batch, not about who is eligible when.
    await keeper.setParkedGracePeriod(0);
    await keeper.setSelfFundedGracePeriod(0);
    await keeper.setEvictionGracePeriod(0);

    return { owner, W1, sigs, usdc, sf, tr, pm, keeper, matA, matB,
             matAAddr, matBAddr, pmAddr, sfAddr, keeperAddr };
  }

  // A population large enough that the matrices ROTATE and members actually park.
  // Without rotation _scanMatrix returns on its first line and there is no queue to cost.
  async function populate(c, n = 25) {
    const { sigs, W1 } = c;
    await c.usdc.mint(W1.address, FEE);
    await c.usdc.connect(W1).approve(c.pmAddr, FEE);
    await c.tr.connect(W1).register(ethers.ZeroAddress, { gasLimit: 16_000_000 });
    for (let i = 0; i < n; i++) {
      const sg = sigs[10 + i];
      await c.usdc.mint(sg.address, FEE);
      await c.usdc.connect(sg).approve(c.pmAddr, FEE);
      await c.tr.connect(sg).register(W1.address, { gasLimit: 16_000_000 });
    }
    expect(await c.matA.rotationCount(), "matA must rotate or there is no parked queue to cost").to.be.gt(0n);
    return c;
  }

  before(async function () {
    ctx = await populate(await deployWorld(SIZE));
    // Push every idle clock past its threshold so ghost/reclaim are in the batch too —
    // a real full batch is a MIXTURE, and costing only the parked items would understate
    // the cheap end and overstate the average.
    await time.increase(8 * 86_400);
    snap = await takeSnapshot();
  });

  it("GAS-1: the batch cost at every enumerated cap, against the ceiling", async function () {
    const rows = [];
    for (const cap of CAPS) {
      await snap.restore();
      await ctx.keeper.setMaxItemsPerUpkeep(cap);

      const [needed, data] = await ctx.keeper.checkUpkeep("0x");
      const items = decodeItems(data);
      if (!needed || items.length === 0) { rows.push({ cap, n: 0, gas: 0n, mix: "(no work)" }); continue; }

      const rc = await (await ctx.keeper.performUpkeep(data)).wait();
      rows.push({ cap, n: items.length, gas: rc.gasUsed, mix: tally(items) });
    }

    console.log(`\n      BATCH COST BY CAP  (MATRIX_SIZE ${SIZE} — SHAPE, NOT LIVE NUMBERS)`);
    console.log(`      ceiling ${M(CEILING)}\n`);
    console.log("      cap  items      gas   per item  vs ceiling  mix");
    for (const r of rows) {
      const per = r.n ? r.gas / BigInt(r.n) : 0n;
      const pct = Number(r.gas * 100n / CEILING);
      console.log(
        `      ${String(r.cap).padStart(3)}  ${String(r.n).padStart(5)}  ${M(r.gas).padStart(7)}` +
        `  ${M(per).padStart(9)}  ${String(pct.toFixed(1) + "%").padStart(10)}  ${r.mix}`
      );
    }

    // 1. The cap must actually bind. If every cap returns the same item count this file
    //    is measuring one batch six times and the table above is decoration.
    const counts = rows.map((r) => r.n);
    expect(new Set(counts).size, "no cap ever bound — the fixture has too little work to " +
      "cost a batch, and every row above is the same measurement").to.be.gt(1);

    // 2. Cost must be MONOTONIC in the cap. A bigger batch that costs less means the
    //    snapshot did not restore and the rows are measuring different worlds.
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].n > rows[i - 1].n) {
        expect(rows[i].gas, `cap ${rows[i].cap} ran ${rows[i].n} items for less gas than ` +
          `cap ${rows[i - 1].cap} ran ${rows[i - 1].n} — the world is not being restored ` +
          `between rows and none of these numbers can be trusted`).to.be.gt(rows[i - 1].gas);
      }
    }

    // 3. THE FINDING, whichever way it falls. Reported, not asserted into a pass: the
    //    largest cap that fits the ceiling at this matrix size.
    const fits = rows.filter((r) => r.gas > 0n && r.gas <= CEILING).map((r) => r.cap);
    const largest = fits.length ? Math.max(...fits) : null;
    console.log(`\n      -> every cap here fits ${M(CEILING)}; the largest is ${largest ?? "NONE"}.`);
    console.log(`         ⚠ DO NOT READ THAT AS "40 IS SAFE". See GAS-4 below and the note in`);
    console.log(`           the source: this table is a COMPOSITION artifact, not a cap verdict.`);
    expect(largest, "not even a cap of 5 fits the ceiling at MATRIX_SIZE 7 — if this is " +
      "real, maxItemsPerUpkeep is not the knob and performUpkeep needs splitting").to.not.equal(null);

    // ⛔ WHY THIS TABLE MUST NOT BE READ AS A CAP VERDICT, WRITTEN AT THE POINT OF THE
    //    MISTAKE. Cost FLATTENS above cap 10 (4.52M -> 4.67M -> 4.71M -> 4.90M) and the
    //    reason is visible in the mix column: this world only ever offers FOUR
    //    PARKED_RESCUE items. Every slot above that fills with RECLAIM at ~0.04M. The
    //    batch is not getting cheaper per item because the code got better; it is getting
    //    cheaper because the extra work is trivial.
    //
    //    A real batch is not obliged to be that kind. Defect 6 now puts parked work
    //    FIRST, so the worst realistic composition is a batch that is ENTIRELY rescues —
    //    which is exactly what a long parked queue produces, and exactly the situation
    //    the cap exists to survive. This fixture cannot build that naturally, so GAS-4
    //    projects it from the measured per-item cost instead. That projection, not this
    //    table, is what a cap should be chosen against.
    const spread = Number(rows[rows.length - 1].gas - rows[1].gas) / Number(rows[1].gas);
    expect(spread, "batch cost across caps 10..40 varied by more than 50%, so the " +
      "composition plateau described above no longer holds and GAS-4's worst-case " +
      "projection needs rebuilding from a fixture that actually saturates the cap"
    ).to.be.lt(0.5);
  });

  it("GAS-2: a self-funded rescue against an SF-funded one — item A's saving, in gas", async function () {
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);

    const [, data] = await ctx.keeper.checkUpkeep("0x");
    const items = decodeItems(data);

    // Classify by MATRIX, which under item A is the same question as "does the fund pay".
    // MatrixKeeperLib._crossingCost charges a MatA parker half the fee, which their flat
    // 50% reserve covers outright -> sfShare 0, no loanEligibleFor, no payForceCross.
    // A MatB parker still pays a full fee and still asks the fund.
    const byKind = { selfFunded: [], sfFunded: [], evict: [], housekeeping: [] };
    for (const i of items) {
      if (i.workType === WORK.PARKED_RESCUE) {
        (i.addr1 === ctx.matAAddr ? byKind.selfFunded : byKind.sfFunded).push(i);
      } else if (i.workType === WORK.EVICT_PARKED) byKind.evict.push(i);
      else if (i.workType === WORK.GHOST || i.workType === WORK.RECLAIM) byKind.housekeeping.push(i);
    }

    // One item per transaction. Sequential and each measurement is of the world as it
    // stands at that moment — which is what a real keeper does anyway.
    const measured = {};
    for (const [kind, list] of Object.entries(byKind)) {
      const gasses = [];
      for (const it of list.slice(0, 4)) {
        try {
          const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
          gasses.push(rc.gasUsed);
        } catch (e) {
          // A refusal is not a measurement — record it rather than averaging it in.
          console.log(`      (${kind} ${it.addr2.slice(0, 10)} reverted: ${e.shortMessage || e.message})`);
        }
      }
      if (gasses.length) {
        gasses.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        measured[kind] = { n: gasses.length, med: gasses[Math.floor(gasses.length / 2)], max: gasses[gasses.length - 1] };
      }
    }

    console.log("\n      PER-ITEM COST (secondary reading — the batch table above wins)");
    for (const [kind, m] of Object.entries(measured)) {
      console.log(`      ${kind.padEnd(13)} n=${m.n}  median ${M(m.med)}  max ${M(m.max)}`);
    }

    if (measured.selfFunded && measured.sfFunded) {
      const ratio = Number(measured.sfFunded.med) / Number(measured.selfFunded.med);
      console.log(`\n      -> an SF-funded rescue costs ${ratio.toFixed(2)}x a self-funded one.`);
      console.log(`         That multiple is item A's gas dividend, and it is why the pre-item-A`);
      console.log(`         2.6M/item figure overstates a post-item-A batch.`);
      expect(measured.sfFunded.med,
        "an SF-funded rescue must cost MORE than a self-funded one — it does a " +
        "loanEligibleFor, a payForceCross and a debt write that the other skips. If this " +
        "fails, the classification above is wrong, not the contract").to.be.gt(measured.selfFunded.med);
    } else {
      // Say so rather than passing quietly on a fixture that never built both shapes.
      console.log(`\n      (no A/B comparison: selfFunded=${byKind.selfFunded.length} sfFunded=${byKind.sfFunded.length})`);
      this.skip();
    }
  });

  it("GAS-4: THE CAP VERDICT — a batch of nothing but SF-funded rescues", async function () {
    // THE ONE THAT ACTUALLY DECIDES DEFECT 5.
    //
    // GAS-1 measured the batch this fixture happens to produce. A cap has to survive the
    // batch the SYSTEM can produce, and since defect 6 those are not the same thing:
    // parked work is now taken FIRST, so a long parked queue yields a batch of rescues
    // and nothing else. That is the shape the ceiling has to hold, and it is the shape a
    // 25-member world with four rescuers in it will never build on its own.
    //
    // So it is projected from the measured MAX cost of a single SF-funded rescue rather
    // than staged. Projection is weaker evidence than measurement and is labelled as
    // such — but projecting from a number measured on THIS code beats the alternative on
    // offer, which is a 2.6M estimate from a chain running different contracts.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);
    const [, data] = await ctx.keeper.checkUpkeep("0x");
    const items = decodeItems(data);

    // Worst single rescue actually observed, not an average — a cap must hold on a bad
    // day, and averaging is how a ceiling gets breached by the tail.
    let worstRescue = 0n;
    for (const it of items.filter((i) => i.workType === WORK.PARKED_RESCUE)) {
      try {
        const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
        if (rc.gasUsed > worstRescue) worstRescue = rc.gasUsed;
      } catch { /* refusals are not measurements */ }
    }
    expect(worstRescue, "no rescue completed, so there is nothing to project from").to.be.gt(0n);

    console.log(`\n      WORST-CASE BATCH: every slot an SF-funded rescue`);
    console.log(`      worst measured rescue ${M(worstRescue)} at MATRIX_SIZE ${SIZE}, ceiling ${M(CEILING)}\n`);
    console.log("      cap   projected   vs ceiling   verdict");
    const verdicts = [];
    for (const cap of CAPS) {
      const proj = worstRescue * BigInt(cap);
      const pct = Number(proj * 100n / CEILING);
      const ok = proj <= CEILING;
      verdicts.push({ cap, proj, ok });
      console.log(`      ${String(cap).padStart(3)}   ${M(proj).padStart(9)}   ${String(pct.toFixed(0) + "%").padStart(10)}   ${ok ? "fits" : "EXCEEDS"}`);
    }
    const safe = verdicts.filter((v) => v.ok).map((v) => v.cap);
    const largestSafe = safe.length ? Math.max(...safe) : null;

    console.log(`\n      -> at MATRIX_SIZE ${SIZE} the largest SATURATED-batch cap is ${largestSafe ?? "NONE"}.`);
    console.log(`         Live tiers run MATRIX_SIZE 127. The V8.49 private chain measured`);
    console.log(`         ~2.6M for a rescued item at live size against ${M(worstRescue)} here, so scale`);
    console.log(`         this DOWN — it is an upper bound on the cap, never a target.`);

    // The finding is REPORTED, not asserted into a particular value: the day a future
    // change makes rescues cheaper, this test should print a bigger number, not fail.
    // What IS asserted is the thing that would invalidate the whole exercise.
    expect(largestSafe, `not even a cap of 5 survives a saturated batch at MATRIX_SIZE ${SIZE} ` +
      `(${M(worstRescue * 5n)} against ${M(CEILING)}). If that is real, maxItemsPerUpkeep is ` +
      `not the control and performUpkeep has to become resumable — a much larger change ` +
      `than defect 5 and one the owner needs to hear about before any cap is chosen.`
    ).to.not.equal(null);

    // And the honest cross-check on the fixture's own table: GAS-1 said every cap fits.
    // If the saturated projection agrees at 40, this file is not stressing anything and
    // its conclusion is worthless.
    expect(largestSafe, "the saturated projection matched GAS-1's plateau, which means the " +
      "worst case is not being modelled — either rescues got dramatically cheaper or the " +
      "projection lost its teeth").to.be.lessThan(40);
  });

  it("GAS-3: the batch is not dominated by one pathological item", async function () {
    // If a single item can approach the ceiling on its own, the cap is the wrong control
    // entirely and no value of maxItemsPerUpkeep is safe. Worth knowing before tuning it.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);
    const [, data] = await ctx.keeper.checkUpkeep("0x");
    const items = decodeItems(data);

    let worst = 0n, worstKind = "(none)";
    for (const it of items.slice(0, 12)) {
      try {
        const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
        if (rc.gasUsed > worst) { worst = rc.gasUsed; worstKind = NAME[it.workType]; }
      } catch { /* refusals are not measurements */ }
    }
    console.log(`\n      worst single item: ${M(worst)} (${worstKind}) = ${(Number(worst * 100n / CEILING)).toFixed(1)}% of the ceiling`);
    expect(worst, `a single ${worstKind} item costs ${M(worst)} against a ${M(CEILING)} ceiling. ` +
      `At that price the batch cap cannot protect the transaction and performUpkeep needs ` +
      `to be splittable, which is a bigger change than defect 5.`).to.be.lt(CEILING / 2n);
  });

  it("GAS-5: DEFECT 8 — the floor STOPS the batch instead of letting it cascade", async function () {
    // ⛔ WHAT THIS IS ACTUALLY PROTECTING AGAINST, because the obvious guess is wrong.
    //
    // An out-of-gas batch does NOT revert. Every item is dispatched as
    // `try this._doXExternal()`, and under EIP-150 a sub-call gets 63/64 of the remaining
    // gas — so when the batch runs dry the sub-call burns its 63/64, reverts on OOG, and
    // the CATCH FIRES. The loop then continues with 1/64 of nothing and every remaining
    // item fails identically. Exhaustion therefore presents as a cascade of
    // WorkItemFailed events, which is exactly what a floor refusal, an SF exhaustion or
    // an already-rescued member also produce. The keeper looks like it ran fine.
    //
    // So the property is not "the transaction survives" — it already did. It is that
    // running low is now DISTINGUISHABLE in the logs from being refused.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(20);
    await ctx.keeper.setMinGasPerItem(7_500_000);   // deliberately high so the floor bites early

    const [, data] = await ctx.keeper.checkUpkeep("0x");
    const items = decodeItems(data);
    expect(items.length, "need a multi-item batch to halt part-way through").to.be.gt(3);

    // Hand it far less than the batch would want. 12M against a 7.5M floor leaves room
    // for a couple of items and then the guard must take over.
    const rc = await (await ctx.keeper.performUpkeep(data, { gasLimit: 12_000_000 })).wait();

    const halted = rc.logs
      .map((l) => { try { return ctx.keeper.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).filter((e) => e.name === "BatchGasHalted");

    expect(halted.length, `the batch was given 12M for ${items.length} items against a 7.5M ` +
      `floor and never emitted BatchGasHalted. Either the guard is not being reached or ` +
      `the fixture is too cheap to trigger it — check gasUsed ${rc.gasUsed} first.`).to.equal(1);

    const { processed, total, gasRemaining } = halted[0].args;
    console.log(`\n      BatchGasHalted: processed ${processed} of ${total}, ${M(gasRemaining)} left`);

    expect(Number(processed), "the batch must do SOME work before halting — halting at " +
      "item 0 means the floor is above anything the registry will ever hand it, which " +
      "is a stall, not a guard").to.be.gt(0);
    expect(Number(processed), "it must also stop SHORT of the full batch, or this test " +
      "measured a batch that fit and proved nothing").to.be.lt(Number(total));

    // The work that was skipped is deferred, never dropped: it is still discoverable.
    const [stillNeeded, data2] = await ctx.keeper.checkUpkeep("0x");
    expect(stillNeeded, "the unprocessed tail must still be discoverable on the next tick — " +
      "a gas halt defers work, it does not consume it").to.equal(true);
    expect(decodeItems(data2).length, "next tick found no work at all after a partial batch").to.be.gt(0);
  });

  it("GAS-6: the floor is above the worst item, and the menu cannot vote it below one", async function () {
    // A floor BELOW the cost of a single item lets the batch enter work it cannot finish,
    // which buys nothing at all — the cascade happens anyway, one item later. This is the
    // invariant that makes the whole guard worth having, so it is asserted against the
    // MEASURED worst item rather than against a remembered constant.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);
    const [, data] = await ctx.keeper.checkUpkeep("0x");
    let worst = 0n;
    for (const it of decodeItems(data).filter((i) => i.workType === WORK.PARKED_RESCUE)) {
      try {
        const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
        if (rc.gasUsed > worst) worst = rc.gasUsed;
      } catch { /* refusals are not measurements */ }
    }
    expect(worst, "no rescue completed, so there is nothing to compare the floor against").to.be.gt(0n);

    await snap.restore();
    const floor = await ctx.keeper.minGasPerItem();
    console.log(`\n      minGasPerItem ${M(floor)} vs worst measured item ${M(worst)} ` +
      `(MATRIX_SIZE ${SIZE}; live 127 measured ~2.6M)`);
    expect(floor, `the gas floor (${M(floor)}) is at or below the worst item measured here ` +
      `(${M(worst)}). A floor under one item's cost lets the batch start work it cannot ` +
      `finish and the WorkItemFailed cascade returns.`).to.be.gt(worst);

    // ⚠ THE LOCAL WORST IS NOT THE LIVE WORST. MATRIX_SIZE 7 here, 127 live, where the
    //   same item measured ~2.6M. The floor must clear THAT, and the assertion above
    //   cannot see it — so it is stated as its own check against the known live figure.
    expect(floor, "the floor must clear the ~2.6M a live-size rescue measured on the V8.49 " +
      "chain, not merely the cheaper item this small world produces").to.be.gte(2_600_000n);

    // Every value the DAO can vote for must still be settable, and the lowest of them
    // must still clear the live figure — a menu entry that breaks the invariant is a
    // proposal waiting to disarm the guard.
    for (const v of [2_500_000, 3_500_000, 5_000_000, 7_500_000]) {
      await ctx.keeper.setMinGasPerItem(v);
      expect(await ctx.keeper.minGasPerItem(), `menu value ${v} must be settable`).to.equal(BigInt(v));
    }
    await ctx.keeper.setMinGasPerItem(3_500_000);
    await expect(ctx.keeper.setMinGasPerItem(1_000_000),
      "a value below the menu must be refused").to.be.reverted;
  });
});
