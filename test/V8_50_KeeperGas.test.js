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
 *   MATRIX_SIZE defaults to 7. The live tiers run 127. Position loops in _scanMatrix and
 *   the L1/chain payout walk are shorter at 7 than on the live chain, so THE DEFAULT RUN
 *   DOES NOT PRODUCE LIVE NUMBERS. What the default establishes is the SHAPE — the ratio
 *   between a self-funded rescue and an SF-funded one, and how batch cost scales with the
 *   cap. Anyone using it to pick a live cap must say so out loud and add headroom.
 *
 * ⛔ V8.50 DEPLOY GATE (2026-08-18) — MATRIX_SIZE IS A KNOB NOW, AND HERE IS WHY.
 *   The gate's measurement 1 is "gas per SF-funded rescue at MATRIX_SIZE 127", and every
 *   gas figure this project owns was taken at 7. The only live-size input to
 *   minGasPerItem = 3.5M is a ~2.6M figure carried from the V8.49 private chain — which
 *   ran DIFFERENT CONTRACTS (no item A, no E1). Per defect 8, a floor set below the true
 *   cost of one item does not revert loudly; it cascades WorkItemFailed and reads exactly
 *   like a floor refusal. A wrong value there hides itself.
 *
 *   MATRIX_SIZE is a CONSTRUCTOR ARGUMENT (FigureEightMatrixV8.sol:43, immutable, set at
 *   :167) — not a compile-time constant and not a deploy-only setting. deployWorld() below
 *   already took it as a parameter; only the `const SIZE = 7` above pinned it small. So
 *   the live-size number is measurable HERE, on THIS code, with no deploy and no chain
 *   touched, before the private chain exists.
 *
 *   ⚠ WHAT THE 127 RUN IS AND IS NOT. It is a real measurement of V8.50 EVM cost at live
 *   matrix size. It is NOT the community chain's state shape: this fixture's queue depth,
 *   referral chain (every member refers to W1), tier count (one) and storage warmth are
 *   the fixture's, not the community's. It bounds and de-risks the private-chain run; it
 *   does not replace gate measurements 3 and 4, which need a running system.
 *
 * Run (baseline — the suite runs this, and 602 passing depends on it being unchanged):
 *   npx hardhat test test/V8_50_KeeperGas.test.js
 * Run (the gate's live-size measurement, PowerShell):
 *   $env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js
 *   Unset afterwards: Remove-Item Env:\GAS_MATRIX_SIZE
 * Optional: GAS_POP overrides the population if the fixture fails to build both rescue
 *   shapes. Both knobs print in the banner, so any number quoted carries its basis.
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

/**
 * SIZE — 7 by default, 127 for the deploy gate. Nothing else in this file changes with it.
 *
 * BASELINE is not just "SIZE === 7"; it is the exact fixture the 602-passing suite ran, so
 * it requires the default population too. Any deviation and the size-7-specific assertions
 * below stop being safe to enforce, because they were calibrated against that one world.
 */
const SIZE = Number(process.env.GAS_MATRIX_SIZE || 7);

/**
 * POPULATION. The size-7 fixture used 25 registrations against a pair capacity of 14 —
 * 11 more members than seats, and those 11 are what park and therefore what there is to
 * rescue. The formula below reproduces 25 exactly at size 7 (2*7+11) so the baseline is
 * bit-identical, and scales the same way above it.
 *
 * ⚠ MARKED UNVERIFIED, PER RULE 1: how many excess registrations are needed to yield
 * enough SF-funded rescues to measure at size 127 is a GUESS. It is not load-bearing —
 * the fixture asserts loudly if it fails to build both rescue shapes rather than passing
 * quietly, and GAS_POP exists so the answer is a knob turn, not a code edit.
 *
 * The hardhat network is configured for 300 accounts (hardhat.config.js), and populate()
 * starts at signer index 10, so the ceiling is 290. At 127 the formula wants 288.
 */
const POP = Number(process.env.GAS_POP || (SIZE === 7 ? 2 * SIZE + 11 : 2 * SIZE + 34));
const IS_BASELINE = SIZE === 7 && POP === 25;

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

/**
 * ⛔ THE HARDHAT PROVIDER CAPS A SINGLE TRANSACTION AT 2^24 = 16,777,216 GAS.
 *
 * Found the hard way on the first MATRIX_SIZE 127 attempt: a register sent with a 29M gas
 * limit is refused outright with "Transaction gas limit is 29000000 and exceeds transaction
 * gas cap of 16777216". The original 16,000,000 in this file sits just under that cap,
 * which is almost certainly why it was chosen.
 *
 * IT MATTERS FAR MORE THAN A FAILED SEND, AND THIS IS THE PART TO READ. The cap is BELOW
 * the 17.8M CEILING this file judges batches against. So an in-process run cannot observe
 * a batch that costs between 16.78M and 17.80M — the transaction is refused before it
 * executes and reports NO gas figure at all. Left unhandled, that refusal is caught by the
 * `catch` blocks below and reads as "the item did not complete", which is
 * indistinguishable from a floor refusal or an already-rescued member.
 *
 * That is defect 8's failure mode wearing a different hat: an instrument that reports
 * "nothing happened" when the truth is "it cost more than I can measure". So every catch
 * in this file now identifies the cap error explicitly and says so out loud, and the batch
 * table records a capped row as UNMEASURABLE rather than dropping it.
 */
const PROVIDER_CAP = 16_777_216n;
const isCapError = (e) => /exceeds transaction gas cap|exceeds block gas limit/i.test(
  (e && (e.message || e.shortMessage)) || "");

/**
 * The worst SINGLE SF-funded rescue MEASURED at the live MATRIX_SIZE 127, 2026-08-18, on
 * V8.50 at HEAD — item #1 of a batch, every storage slot cold. Confirmed two independent
 * ways agreeing to 0.1%: GAS-2's isolated single-item run (4,366,374) and GAS-7's per-kind
 * curve at k=1 (4.36M).
 *
 * ⛔ THIS IS WHAT minGasPerItem IS SIZED AGAINST, and it is why the floor moved 3.5M -> 5M.
 *    A floor below it lets the batch enter an item it cannot finish, which per defect 8
 *    does NOT revert — it cascades WorkItemFailed and reads as a floor refusal.
 *
 * It replaces a ~2.6M figure that was never an item cost at all: that was a BATCH PER-ITEM
 * AVERAGE from the V8.49 chain (12.9M over 5 items, testchain_keeper.js:285), carried in
 * MatrixKeeper.sol as though it described one rescue.
 *
 * Re-derive: $env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js
 */
const LIVE_WORST_COLD_RESCUE = 4_366_374n;

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
  // 10 minutes is ample at size 7. At 127 the fixture alone is ~290 registrations, most of
  // them triggering a 126-position shift, so the hook needs room to finish rather than to
  // time out half-built and report a partial world's numbers as if they were the answer.
  this.timeout(IS_BASELINE ? 600_000 : 5_400_000);

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

    // MX/dp/treasury are exported so GAS-10 can deploy a SECOND matrix pair into this same
    // tier after the parked queue has already formed — see that test for why.
    return { owner, W1, sigs, usdc, sf, tr, pm, keeper, matA, matB, treasury, MX, dp, size,
             matAAddr, matBAddr, pmAddr, sfAddr, keeperAddr };
  }

  // A population large enough that the matrices ROTATE and members actually park.
  // Without rotation _scanMatrix returns on its first line and there is no queue to cost.
  async function populate(c, n = POP) {
    const { sigs, W1 } = c;

    // Say so BEFORE spending ten minutes registering, not after. A fixture that silently
    // runs short of signers registers fewer members than asked and reports its numbers
    // with the same confidence as a full one.
    expect(sigs.length, `the fixture needs ${10 + n} signers for a population of ${n} and ` +
      `hardhat.config.js provides ${sigs.length}. Lower GAS_POP or raise accounts.count.`
    ).to.be.gte(10 + n);

    // At size 7 a register that triggers a cycle-out shifts 6 positions; at 127 it shifts
    // 126, plus a longer _scanMatrix walk. 16M is ample at the default (worst observed
    // 2.00M) and is not obviously ample at 127 — so the non-default path takes every gas
    // unit the provider will allow, which is 16,777,216 and not a unit more. If a
    // registration still fails at 127 that is a finding about live-size cost, not a
    // fixture problem, and the caller is told which of the two it was.
    const REG_GAS = IS_BASELINE ? 16_000_000 : 16_700_000;

    await c.usdc.mint(W1.address, FEE);
    await c.usdc.connect(W1).approve(c.pmAddr, FEE);
    await c.tr.connect(W1).register(ethers.ZeroAddress, { gasLimit: REG_GAS });

    // Registration cost is not what this file is about, but at 127 it is the first live-size
    // number anyone has, and it is free to collect while the fixture builds.
    let worstReg = 0n;
    for (let i = 0; i < n; i++) {
      const sg = sigs[10 + i];
      await c.usdc.mint(sg.address, FEE);
      await c.usdc.connect(sg).approve(c.pmAddr, FEE);
      let rc;
      try {
        rc = await (await c.tr.connect(sg).register(W1.address, { gasLimit: REG_GAS })).wait();
      } catch (e) {
        // Name which failure this is. "register #212 reverted" and "a registration at live
        // matrix size costs more gas than a transaction can carry" are wildly different
        // findings and the raw error does not distinguish them for a reader.
        throw new Error(
          `registration ${i + 1}/${n} FAILED at MATRIX_SIZE ${SIZE}` +
          (isCapError(e)
            ? ` because it exceeded the ${M(PROVIDER_CAP)} provider transaction gas cap. ` +
              `⛔ THAT IS A FINDING, NOT A FIXTURE FAULT: a single registration at live ` +
              `matrix size does not fit in one transaction, which the community chain ` +
              `would hit on the ${2 * SIZE}th member. Worst register before this: ${M(worstReg)}.`
            : `: ${e.shortMessage || e.message}`)
        );
      }
      if (rc.gasUsed > worstReg) worstReg = rc.gasUsed;
      if (!IS_BASELINE && (i + 1) % 25 === 0) {
        console.log(`      ... populated ${i + 1}/${n} (worst register so far ${M(worstReg)})`);
      }
    }
    c.worstRegister = worstReg;

    expect(await c.matA.rotationCount(), "matA must rotate or there is no parked queue to cost").to.be.gt(0n);
    return c;
  }

  before(async function () {
    console.log(`\n      FIXTURE: MATRIX_SIZE ${SIZE}, population ${POP}, ` +
      `pair capacity ${2 * SIZE}, ${IS_BASELINE ? "BASELINE (suite fixture)" : "⛔ NON-BASELINE — deploy-gate run"}`);
    ctx = await populate(await deployWorld(SIZE));
    console.log(`      worst REGISTER observed: ${M(ctx.worstRegister)} at MATRIX_SIZE ${SIZE}`);
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

      let rc, txGasLimit = null;
      try {
        const txr = await ctx.keeper.performUpkeep(data);
        txGasLimit = txr.gasLimit;      // what the ESTIMATE handed it, not what it used
        rc = await txr.wait();
      } catch (e) {
        if (isCapError(e)) {
          // UNMEASURABLE is not zero and it is not "fits". Recorded as its own state so
          // the table cannot be read as though this cap were cheap or absent.
          rows.push({ cap, n: items.length, gas: null, mix: tally(items) });
          continue;
        }
        throw e;
      }

      // ⛔ THE 2026-08-18 DISAGREEMENT THAT THIS EXISTS TO SETTLE.
      //    At MATRIX_SIZE 127 the table read `PARKED_RESCUEx8` for a 12.22M batch while
      //    GAS-2 measured a single SF-funded rescue at 4.37M. Eight of those is 35M. The
      //    two numbers cannot both describe the same transaction, and the gap is not
      //    something to reason about — a batch that halts, a batch whose items FAIL, and
      //    a batch of cheap self-funded rescues all produce a small total for completely
      //    different reasons, and only one of them is benign.
      //
      //    So the row now carries what actually happened inside the transaction: how many
      //    items succeeded, how many emitted WorkItemFailed, whether the gas floor halted
      //    it, and what gas limit the estimate handed it in the first place. None of that
      //    was visible before, which is why the plateau could be mistaken for composition.
      const evs = rc.logs
        .map((l) => { try { return ctx.keeper.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean);
      const halted = evs.find((e) => e.name === "BatchGasHalted");
      const failed = evs.filter((e) => e.name === "WorkItemFailed").length;

      rows.push({
        cap, n: items.length, gas: rc.gasUsed, mix: tally(items),
        failed, txGasLimit,
        halted: halted ? { processed: Number(halted.args.processed), total: Number(halted.args.total) } : null,
      });
    }

    console.log(`\n      BATCH COST BY CAP  (MATRIX_SIZE ${SIZE} — SHAPE, NOT LIVE NUMBERS)`);
    console.log(`      ceiling ${M(CEILING)}\n`);
    console.log(`      floor in force: ${M(await ctx.keeper.minGasPerItem())} per item`);
    console.log("      cap  items      gas   per item  vs ceiling   ok  what happened / mix");
    for (const r of rows) {
      if (r.gas === null) {
        console.log(
          `      ${String(r.cap).padStart(3)}  ${String(r.n).padStart(5)}  ` +
          `${"UNMEASURABLE".padStart(7)}  ${"—".padStart(9)}  ${">16.78M".padStart(10)}  ${r.mix}`
        );
        continue;
      }
      const per = r.n ? r.gas / BigInt(r.n) : 0n;
      const pct = Number(r.gas * 100n / CEILING);
      // "ok" is items that neither failed nor were skipped by a halt — the only ones whose
      // cost is actually inside this gas figure. Dividing by r.n instead is how a batch
      // that did 2 items and refused 6 gets reported as cheap per item.
      const skipped = r.halted ? r.n - r.halted.processed : 0;
      const ok = r.n - (r.failed || 0) - skipped;
      const note = [
        r.halted ? `HALTED ${r.halted.processed}/${r.halted.total}` : null,
        r.failed ? `${r.failed} FAILED` : null,
        r.txGasLimit ? `limit ${M(r.txGasLimit)}` : null,
      ].filter(Boolean).join(" ");
      console.log(
        `      ${String(r.cap).padStart(3)}  ${String(r.n).padStart(5)}  ${M(r.gas).padStart(7)}` +
        `  ${M(per).padStart(9)}  ${String(pct.toFixed(1) + "%").padStart(10)}  ` +
        `${String(ok).padStart(3)}  ${note ? note + "  " : ""}${r.mix}`
      );
    }
    const capped = rows.filter((r) => r.gas === null);
    if (capped.length) {
      console.log(`\n      ⛔ ${capped.length} row(s) exceeded the ${M(PROVIDER_CAP)} provider ` +
        `transaction cap and could not be measured in-process.`);
      console.log(`         Those batches cost MORE than ${M(PROVIDER_CAP)}, not zero. Against a ` +
        `${M(CEILING)} ceiling that is`);
      console.log(`         unresolved either way, and it is a question only a real chain can answer.`);
    }

    // 1. The cap must actually bind. If every cap returns the same item count this file
    //    is measuring one batch six times and the table above is decoration.
    const counts = rows.map((r) => r.n);
    expect(new Set(counts).size, "no cap ever bound — the fixture has too little work to " +
      "cost a batch, and every row above is the same measurement").to.be.gt(1);

    // 2. Cost must be MONOTONIC in the cap. A bigger batch that costs less means the
    //    snapshot did not restore and the rows are measuring different worlds.
    const anyHalted = rows.some((r) => r.halted);
    if (anyHalted) {
      console.log(`\n      ⛔ THE GAS FLOOR BOUND AT LEAST ONE ROW. Where it did, batch cost is`);
      console.log(`         limited by the TRANSACTION'S GAS BUDGET, not by the cap — so a flat`);
      console.log(`         cost across caps is the floor working, NOT a cheap item mix, and the`);
      console.log(`         monotonicity check below is suspended because it no longer means`);
      console.log(`         anything. Read the "ok" column, not the item count.`);
    }
    for (let i = 1; i < rows.length; i++) {
      // An UNMEASURABLE row has no number to compare, and comparing against one anyway is
      // how a null becomes a zero and a zero becomes "it got cheaper".
      if (rows[i].gas === null || rows[i - 1].gas === null) continue;
      // A halted batch spent its budget rather than its cap. Comparing two budget-bound
      // rows tests the estimator, not the code, and would fail for a non-finding.
      if (rows[i].halted || rows[i - 1].halted) continue;
      if (rows[i].n > rows[i - 1].n) {
        expect(rows[i].gas, `cap ${rows[i].cap} ran ${rows[i].n} items for less gas than ` +
          `cap ${rows[i - 1].cap} ran ${rows[i - 1].n} — the world is not being restored ` +
          `between rows and none of these numbers can be trusted`).to.be.gt(rows[i - 1].gas);
      }
    }

    // 3. THE FINDING, whichever way it falls. Reported, not asserted into a pass: the
    //    largest cap that fits the ceiling at this matrix size.
    const fits = rows.filter((r) => r.gas !== null && r.gas > 0n && r.gas <= CEILING).map((r) => r.cap);
    const largest = fits.length ? Math.max(...fits) : null;
    console.log(`\n      -> largest cap MEASURED to fit ${M(CEILING)}: ${largest ?? "NONE"}` +
      `${capped.length ? ` (${capped.length} higher cap(s) UNMEASURABLE, not proven to fit)` : ""}.`);
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
    // Anchored on caps 10 and 40 exactly as before — rows[1] and the last row. Only the
    // null-guard is new, so the baseline computes the identical number it always did.
    const spreadLo = rows[1], spreadHi = rows[rows.length - 1];
    const spread = (spreadLo && spreadHi && spreadLo.gas && spreadHi.gas)
      ? Number(spreadHi.gas - spreadLo.gas) / Number(spreadLo.gas)
      : NaN;
    if (IS_BASELINE) {
      expect(spread, "batch cost across caps 10..40 varied by more than 50%, so the " +
        "composition plateau described above no longer holds and GAS-4's worst-case " +
        "projection needs rebuilding from a fixture that actually saturates the cap"
      ).to.be.lt(0.5);
    } else {
      // ⛔ NOT ASSERTED OFF-BASELINE, DELIBERATELY. The 50% bound describes the size-7
      //    world's composition — four rescues and a long tail of reclaims. A different
      //    matrix size builds a different mix, so enforcing it here would fail for a
      //    reason that is not a finding, and a test that cries wolf gets skimmed.
      //    Reported instead, because a plateau that DOES survive a size change is
      //    information about the shape rather than about this fixture.
      console.log(`\n      spread across caps 10..40: ${Number.isNaN(spread) ? "n/a (a row was UNMEASURABLE)" : (spread * 100).toFixed(1) + "%"} ` +
        `(reported, not asserted — the <50% plateau is a size-7 property)`);
    }
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
    let worstRescue = 0n, capRefusals = 0;
    for (const it of items.filter((i) => i.workType === WORK.PARKED_RESCUE)) {
      try {
        const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
        if (rc.gasUsed > worstRescue) worstRescue = rc.gasUsed;
      } catch (e) {
        // A refusal is not a measurement — but an item too EXPENSIVE to send is not a
        // refusal, and swallowing both identically is exactly defect 8's failure mode
        // reproduced inside the instrument that is supposed to detect it. Say which.
        if (isCapError(e)) capRefusals++;
      }
    }
    if (capRefusals) {
      console.log(`\n      ⛔ ${capRefusals} rescue(s) EXCEEDED the ${M(PROVIDER_CAP)} provider ` +
        `transaction cap and returned no figure.`);
      console.log(`         Read that as "cost more than ${M(PROVIDER_CAP)}", never as "did not run". ` +
        `Any worst-case below is an UNDERSTATEMENT.`);
    }
    expect(worstRescue, `no rescue produced a gas figure` +
      (capRefusals ? ` — and ${capRefusals} of them were refused for EXCEEDING the ` +
        `${M(PROVIDER_CAP)} transaction cap, which means a single SF-funded rescue at ` +
        `MATRIX_SIZE ${SIZE} does not fit in one transaction. That is the finding, and it ` +
        `is far worse than a wrong minGasPerItem.`
       : `, so there is nothing to project from`)).to.be.gt(0n);

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
    if (SIZE === 127) {
      console.log(`         THIS IS LIVE MATRIX SIZE. No downward scaling is owed on size —`);
      console.log(`         but this is still a FIXTURE state shape, not the community chain's.`);
    } else {
      console.log(`         Live tiers run MATRIX_SIZE 127, where a cold SF-funded rescue MEASURES`);
      console.log(`         ${M(LIVE_WORST_COLD_RESCUE)} against ${M(worstRescue)} here — so scale this DOWN. It is an upper`);
      console.log(`         bound on the cap, never a target. (The ~2.6M this line used to cite was`);
      console.log(`         a BATCH AVERAGE, not an item cost — see LIVE_WORST_COLD_RESCUE above.)`);
    }

    // The finding is REPORTED, not asserted into a particular value: the day a future
    // change makes rescues cheaper, this test should print a bigger number, not fail.
    // What IS asserted is the thing that would invalidate the whole exercise.
    // ⛔ ASSERTED ONLY ON THE BASELINE — AND THIS IS A DEMOTION, NOT A CONVENIENCE.
    //    The `worst x cap` model was the best available when this file was written. It is
    //    no longer: the 2026-08-18 MATRIX_SIZE 127 run measured a batch containing eight
    //    rescues at 12.22M while this projection says five cost 21.83M. The model
    //    multiplies a COLD-START cost by every slot and ignores that slots 2..n find
    //    warm storage. GAS-7 now measures the cold and marginal costs separately and
    //    projects from both, which is the reading a cap should be chosen against.
    //
    //    Failing here off-baseline would be failing on a model this file has itself
    //    disproved — the definition of crying wolf. Kept as an assertion at size 7 so the
    //    suite still guards the original claim, reported everywhere else.
    if (IS_BASELINE) {
      expect(largestSafe, `not even a cap of 5 survives a saturated batch at MATRIX_SIZE ${SIZE} ` +
        `(${M(worstRescue * 5n)} against ${M(CEILING)}). If that is real, maxItemsPerUpkeep is ` +
        `not the control and performUpkeep has to become resumable — a much larger change ` +
        `than defect 5 and one the owner needs to hear about before any cap is chosen.`
      ).to.not.equal(null);
    } else if (largestSafe === null) {
      console.log(`\n      ⚠ On the cold-start x cap model NOTHING fits — but that model is`);
      console.log(`        contradicted by GAS-1's measured batches. See GAS-7 for the`);
      console.log(`        measured curve, which is what the cap verdict now rests on.`);
    }

    // And the honest cross-check on the fixture's own table: GAS-1 said every cap fits.
    // If the saturated projection agrees at 40, this file is not stressing anything and
    // its conclusion is worthless.
    // `null` means NOTHING fits, which is the opposite of "lost its teeth" — asserting
    // lessThan on it would report a too-harsh projection as a too-soft one.
    if (largestSafe !== null) {
      expect(largestSafe, "the saturated projection matched GAS-1's plateau, which means the " +
        "worst case is not being modelled — either rescues got dramatically cheaper or the " +
        "projection lost its teeth").to.be.lessThan(40);
    }
  });

  it("GAS-7: the MEASURED cost curve of a rescue-only batch — cold start vs marginal", async function () {
    // ⛔ WHY THIS EXISTS, AND WHAT IT REPLACES.
    //
    // GAS-4 projects a saturated batch as `worst single rescue x cap`. At MATRIX_SIZE 127
    // that model says a cap of 5 costs 21.83M and EXCEEDS the 17.80M ceiling. The batch
    // table measured on the same world, same run, says a batch containing EIGHT rescues
    // cost 12.22M. Both cannot be right, and per this file's own rule the batch numbers
    // win: the projection is multiplying a COLD-START cost by every slot.
    //
    // A single-item performUpkeep pays every cold SLOAD itself — the matrix, the fund,
    // the router, the tier. Inside a batch the second rescue onward finds those slots
    // WARM. So there are two different real costs and the file only ever measured one of
    // them, then extrapolated with it.
    //
    // This measures both, directly, by running rescue-only batches of 1..k and diffing.
    // No projection: the curve IS the measurement, and everything downstream can be built
    // on the two numbers it produces rather than on one number used twice.
    // ⛔ MEASURED PER KIND, BECAUSE THE FIRST ATTEMPT MIXED THEM AND THE MIXING SHOWED.
    //    The 2026-08-18 first run of this test produced steps of
    //    0.86M · 0.83M · 2.83M · 1.43M · 1.42M — not a curve, two curves overlaid. Its
    //    k=1 "cold-start" came out at 2.38M, which is EXACTLY GAS-2's self-funded median:
    //    discovery simply handed it self-funded rescues first, and the 2.83M jump at k=4
    //    was the first SF-funded one arriving. A single "marginal cost" averaged over that
    //    is a number describing no item that exists.
    //
    //    So each kind gets its own curve. The floor is sized against the SF-funded one,
    //    because that is the expensive shape and defect 6 puts parked work FIRST — an
    //    SF-funded rescue can be item #1 of a batch, paying every cold cost itself.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);
    const [, data0] = await ctx.keeper.checkUpkeep("0x");
    const allRescues = decodeItems(data0).filter((i) => i.workType === WORK.PARKED_RESCUE);
    const kinds = {
      "SF-funded":   allRescues.filter((i) => i.addr1 !== ctx.matAAddr),
      "self-funded": allRescues.filter((i) => i.addr1 === ctx.matAAddr),
    };
    console.log(`\n      RESCUE-ONLY COST CURVES (MATRIX_SIZE ${SIZE}, floor lowered to 2.50M)`);
    console.log(`      discovered: ${Object.entries(kinds).map(([k, v]) => `${k} ${v.length}`).join(" · ")}`);

    const result = {};
    for (const [kindName, list] of Object.entries(kinds)) {
      if (list.length < 2) {
        console.log(`\n      ${kindName}: only ${list.length} discovered — no curve. Raise GAS_POP.`);
        continue;
      }
      const maxK = Math.min(list.length, 5);
      const curve = [];
      for (let k = 1; k <= maxK; k++) {
        await snap.restore();
        await ctx.keeper.setMaxItemsPerUpkeep(40);
        // Lowest menu value, so the FLOOR does not halt the batch and the curve measures
        // cost rather than the guard. The guard is GAS-5's subject, not this one's.
        await ctx.keeper.setMinGasPerItem(2_500_000);
        let rc = null;
        try {
          rc = await (await ctx.keeper.performUpkeep(encodeItems(list.slice(0, k)))).wait();
        } catch (e) {
          if (isCapError(e)) { curve.push({ k, gas: null }); continue; }
          throw e;
        }
        const evs = rc.logs
          .map((l) => { try { return ctx.keeper.interface.parseLog(l); } catch { return null; } })
          .filter(Boolean);
        curve.push({
          k, gas: rc.gasUsed,
          failed: evs.filter((e) => e.name === "WorkItemFailed").length,
          halted: evs.some((e) => e.name === "BatchGasHalted"),
        });
      }

      console.log(`\n      ${kindName}`);
      console.log("        k      gas   step   failed  halted");
      let prev = null;
      for (const c of curve) {
        if (c.gas === null) { console.log(`      ${String(c.k).padStart(3)}   UNMEASURABLE (>${M(PROVIDER_CAP)})`); prev = null; continue; }
        const step = prev === null ? null : c.gas - prev;
        console.log(`      ${String(c.k).padStart(3)}  ${M(c.gas).padStart(7)}  ` +
          `${(step === null ? "—" : M(step)).padStart(6)}  ${String(c.failed).padStart(6)}  ${c.halted ? "yes" : "no"}`);
        prev = c.gas;
      }

      const ok = curve.filter((c) => c.gas !== null && !c.failed && !c.halted);
      if (ok.length < 2) { console.log(`        (no clean pair — nothing to derive)`); continue; }
      const cold = ok[0].gas;
      const last = ok[ok.length - 1];
      const marginal = (last.gas - cold) / BigInt(last.k - 1);
      result[kindName] = { cold, marginal };
      console.log(`        -> cold ${M(cold)} · marginal ${M(marginal)} ` +
        `(cold is ${(Number(cold) / Number(marginal)).toFixed(1)}x the marginal)`);
    }

    const sf = result["SF-funded"];
    expect(sf, "no SF-funded curve was produced, so the expensive shape — the one the " +
      "floor is sized against — was never measured. Raise GAS_POP.").to.not.equal(undefined);

    console.log(`\n      -> SATURATED SF-FUNDED BATCH, on the MEASURED curve ` +
      `(cold ${M(sf.cold)} + (n-1) x ${M(sf.marginal)}):`);
    const fits = CAPS.filter((cap) => sf.cold + BigInt(cap - 1) * sf.marginal <= CEILING);
    for (const cap of CAPS) {
      const proj = sf.cold + BigInt(cap - 1) * sf.marginal;
      console.log(`           cap ${String(cap).padStart(2)}  ${M(proj).padStart(7)}  ${proj <= CEILING ? "fits" : "EXCEEDS"}`);
    }
    console.log(`         -> largest cap that fits: ${fits.length ? Math.max(...fits) : "NONE"}`);
    console.log(`\n      ⚠ THE FLOOR IS SIZED AGAINST THE COLD NUMBER, NOT THE MARGINAL ONE.`);
    console.log(`        minGasPerItem asks "can I afford ONE MORE item", and the honest answer`);
    console.log(`        must cover the most expensive item that could be NEXT. Since defect 6`);
    console.log(`        takes parked work first, an SF-funded rescue can be item #1 and pay`);
    console.log(`        every cold cost itself. GAS-6 owns that assertion.`);

    // ⛔ THE THIRD COST, AND THE ONE THE FLOOR ACTUALLY HAS TO COVER.
    //    Both curves above start from item #1, so both measure a rescue with EVERYTHING
    //    cold. That is not the shape the floor answers for — the floor answers for an item
    //    arriving LATE, when shared state is already warm. The mixed first run of this test
    //    accidentally measured it: three self-funded rescues, then the first SF-funded one
    //    cost 2.83M, against 4.36M cold and 1.43M fully warm. Three different prices for
    //    one item, and only one of them is the floor's business.
    //
    //    Measured deliberately here rather than left as an accident of discovery order.
    const self = kinds["self-funded"], sfList = kinds["SF-funded"];
    if (self.length >= 2 && sfList.length >= 1) {
      await snap.restore();
      await ctx.keeper.setMaxItemsPerUpkeep(40);
      await ctx.keeper.setMinGasPerItem(2_500_000);
      const warmers = self.slice(0, 2);
      const rcWarm = await (await ctx.keeper.performUpkeep(encodeItems(warmers))).wait();
      const rcBoth = await (async () => {
        await snap.restore();
        await ctx.keeper.setMaxItemsPerUpkeep(40);
        await ctx.keeper.setMinGasPerItem(2_500_000);
        return (await ctx.keeper.performUpkeep(encodeItems([...warmers, sfList[0]]))).wait();
      })();
      const firstTouch = rcBoth.gasUsed - rcWarm.gasUsed;
      console.log(`\n      MID-BATCH FIRST SF-FUNDED TOUCH (shared state warm, fund state cold):`);
      console.log(`        ${M(warmers.length === 1 ? 1n : BigInt(warmers.length))} self-funded first ` +
        `(${M(rcWarm.gasUsed)}), then +1 SF-funded = ${M(rcBoth.gasUsed)}  ->  ${M(firstTouch)}`);
      console.log(`      -> THE THREE PRICES OF ONE SF-FUNDED RESCUE:`);
      console.log(`         cold (item #1, all storage cold)      ${M(sf.cold)}`);
      console.log(`         first touch mid-batch (shared warm)   ${M(firstTouch)}   <-- the floor's job`);
      console.log(`         fully warm (marginal)                 ${M(sf.marginal)}`);
      ctx.firstTouchSF = firstTouch;
    }

    expect(sf.marginal, "the marginal SF-funded rescue costs MORE than the cold-start one, " +
      "which inverts the warm/cold argument this test is built on and means the curve is " +
      "measuring something else").to.be.lt(sf.cold);
  });

  it("GAS-8: DOES THE SHIPPED FLOOR EVER LET AN ITEM START THAT IT CANNOT FINISH?", async function () {
    // ⛔ THIS IS THE PROPERTY. EVERYTHING ELSE IN THIS FILE IS A PROXY FOR IT.
    //
    // GAS-6 asserts `minGasPerItem > worst single item`, and at MATRIX_SIZE 127 that fails:
    // 3.50M against a 4.37M cold rescue. But GAS-7's curves show 4.37M is what a rescue
    // costs when it is item #1 — paying every cold SLOAD for the matrix, the fund, the
    // router and the tier. And at item #1 gasleft is the WHOLE BUDGET, ~15M, nowhere near
    // the floor. The floor only ever has to answer for an item that arrives LATE, and by
    // then the shared state is warm.
    //
    // So the comparison GAS-6 makes may be the wrong one. That is a claim, and claims get
    // measured: this test squeezes the transaction from every direction and asks the only
    // question that matters — did any item FAIL for a gas reason under the SHIPPED floor?
    //
    // Per defect 8, an item that starts and cannot finish does NOT revert the batch. It
    // emits WorkItemFailed and looks like a refusal. So a non-zero count here, with the
    // floor in force, is the cascade returning — and it is the one result that would make
    // this value unshippable.
    // ⛔ READ THE DEFAULT FROM THE CONTRACT, NEVER RESTATE IT. A hardcoded copy here would
    //    keep asserting the OLD value's sufficiency after the real default moved — the
    //    test would go on passing while measuring a floor nobody ships. (It moved
    //    3.5M -> 5M on 2026-08-18; this line is why that did not go unnoticed.)
    await snap.restore();
    const shippedFloor = Number(await ctx.keeper.minGasPerItem());
    const LIMITS = [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000, 16_000_000];
    const out = [];
    for (const limit of LIMITS) {
      await snap.restore();
      await ctx.keeper.setMaxItemsPerUpkeep(20);
      await ctx.keeper.setMinGasPerItem(shippedFloor);
      const [, data] = await ctx.keeper.checkUpkeep("0x");
      const items = decodeItems(data);
      let rc = null, threw = null;
      try {
        rc = await (await ctx.keeper.performUpkeep(data, { gasLimit: limit })).wait();
      } catch (e) { threw = e.shortMessage || e.message; }
      if (!rc) { out.push({ limit, threw }); continue; }
      const evs = rc.logs
        .map((l) => { try { return ctx.keeper.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean);
      const halted = evs.find((e) => e.name === "BatchGasHalted");
      out.push({
        limit, n: items.length, gas: rc.gasUsed,
        failed: evs.filter((e) => e.name === "WorkItemFailed").length,
        halted: halted ? `${Number(halted.args.processed)}/${Number(halted.args.total)}` : "no",
        // ⛔ gasRemaining is the ONLY direct read of what the floor actually saw. Without it
        //    a halt point can only be inferred from gasUsed — and gasUsed is NET of storage
        //    refunds while the floor checks gasleft(), which is GROSS. Those two differ by
        //    however much the batch refunded, so reasoning from gasUsed alone silently
        //    mis-states the guard's decision by exactly the refund.
        left: halted ? halted.args.gasRemaining : null,
      });
    }

    console.log(`\n      FLOOR SUFFICIENCY under the SHIPPED ${M(BigInt(shippedFloor))} floor ` +
      `(MATRIX_SIZE ${SIZE})`);
    console.log("        budget    gasUsed  items  halted   gasLeft@halt   WorkItemFailed");
    for (const r of out) {
      if (r.threw) { console.log(`      ${M(BigInt(r.limit)).padStart(8)}   THREW: ${r.threw}`); continue; }
      console.log(`      ${M(BigInt(r.limit)).padStart(8)}  ${M(r.gas).padStart(9)}  ${String(r.n).padStart(5)}  ` +
        `${String(r.halted).padStart(6)}   ${(r.left === null ? "—" : M(r.left)).padStart(12)}   ` +
        `${r.failed === 0 ? "0" : `⛔ ${r.failed}`}`);
    }
    // The halt must occur BELOW the floor every time. A halt recorded with more gas left
    // than the floor means the guard fired for some other reason and this table is not
    // measuring what it claims to.
    for (const r of out) {
      if (r.left === null || r.threw) continue;
      expect(r.left, `the batch halted at ${M(BigInt(r.limit))} budget with ${M(r.left)} still ` +
        `remaining, which is ABOVE the ${M(BigInt(shippedFloor))} floor. The guard did not fire ` +
        `for the reason this test assumes, so the sufficiency result above is unproven.`
      ).to.be.lt(BigInt(shippedFloor));
    }

    const anyFailed = out.filter((r) => r.failed > 0);
    if (anyFailed.length === 0) {
      console.log(`\n      -> ZERO items failed at any budget. Under this fixture the ${M(BigInt(shippedFloor))}`);
      console.log(`         floor never let the batch start work it could not finish: it halted first,`);
      console.log(`         every time, cleanly.`);
      console.log(`      ⚠ SINGLE TIER ONLY, AND THAT IS THE LIMIT OF THIS RESULT. The cold premium is`);
      console.log(`        paid by whichever item touches a given tier's storage FIRST. This world has`);
      console.log(`        ONE tier, so that is always item #1, when gas is plentiful. A second tier`);
      console.log(`        arriving mid-batch would pay it LATE — UNVERIFIED here, and the one thing`);
      console.log(`        that could still overturn the ${M(BigInt(shippedFloor))} value.`);
    }

    expect(anyFailed.length, `⛔ THE CASCADE IS BACK. At ${anyFailed.map((r) => M(BigInt(r.limit))).join(", ")} ` +
      `the batch emitted WorkItemFailed with the ${M(BigInt(shippedFloor))} floor in force, which means ` +
      `the floor let an item start that it could not finish. This is defect 8's exact failure ` +
      `mode and the value cannot ship.`).to.equal(0);
  });

  it("GAS-9: WHAT DOES AN SF RESCUE COST BY ARRIVAL CONTEXT — the floor's real requirement", async function () {
    // ⛔ THE QUESTION THE FLOOR ACTUALLY ASKS, ASKED PROPERLY.
    //
    // GAS-7 established that one SF-funded rescue has three prices, but it only measured
    // two arrival contexts: item #1 (everything cold, 4.36M) and after SELF-FUNDED rescues
    // (2.83M). Those are not the only ways an SF rescue can arrive, and the cheaper one was
    // measured after a prefix that does a LOT of warming — a self-funded rescue crosses
    // A->B, so it touches both matrices and much of the crossing path before the SF item
    // ever runs.
    //
    // A batch of EVICTIONS and RECLAIMS warms almost none of that. Those items touch the
    // parked queue and little else — no crossing, no fund, no distribution. So an SF rescue
    // arriving after cheap housekeeping is a THIRD context, and it is the one the floor is
    // most likely to face in practice: the cheap work is what a batch gets through before
    // gas runs low.
    //
    // This was going to be a two-tier fixture. `PairManagerV8.registerFor` is gated to the
    // TierRouter and `_manualUpgrade` requires upgrade eligibility, so seeding a second tier
    // honestly is a large build. The tier question is really "what does an item cost when it
    // is the first to touch a big COLD region, late in a batch" — and that is answerable
    // here, today, by varying the PREFIX instead of adding a tier. Cheaper instrument, same
    // question. The tier-specific version stays on the list; this bounds it first.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);
    const [, dataAll] = await ctx.keeper.checkUpkeep("0x");
    const all = decodeItems(dataAll);
    const sfOne = all.find((i) => i.workType === WORK.PARKED_RESCUE && i.addr1 !== ctx.matAAddr);
    const selfR = all.filter((i) => i.workType === WORK.PARKED_RESCUE && i.addr1 === ctx.matAAddr);
    const cheap = all.filter((i) => i.workType === WORK.EVICT_PARKED ||
                                    i.workType === WORK.RECLAIM || i.workType === WORK.GHOST);
    expect(sfOne, "no SF-funded rescue discovered — nothing to price").to.not.equal(undefined);

    // Cost of a prefix alone, then the same prefix plus the SF rescue. The difference is
    // what that rescue cost ARRIVING IN THAT CONTEXT — measured, not modelled.
    async function arrivalCost(prefix) {
      const run = async (list) => {
        await snap.restore();
        await ctx.keeper.setMaxItemsPerUpkeep(40);
        await ctx.keeper.setMinGasPerItem(2_500_000);   // lowest menu: do not let the guard interfere
        const rc = await (await ctx.keeper.performUpkeep(encodeItems(list))).wait();
        const evs = rc.logs
          .map((l) => { try { return ctx.keeper.interface.parseLog(l); } catch { return null; } })
          .filter(Boolean);
        return { gas: rc.gasUsed, failed: evs.filter((e) => e.name === "WorkItemFailed").length };
      };
      const before = prefix.length ? await run(prefix) : { gas: 0n, failed: 0 };
      const after = await run([...prefix, sfOne]);
      return { cost: after.gas - before.gas, prefixGas: before.gas, failed: before.failed + after.failed };
    }

    const contexts = [
      ["item #1 — nothing warm", []],
      ["after 6 cheap items (evict/reclaim)", cheap.slice(0, 6)],
      ["after 2 self-funded rescues", selfR.slice(0, 2)],
    ];
    console.log(`\n      SF-FUNDED RESCUE COST BY ARRIVAL CONTEXT (MATRIX_SIZE ${SIZE})`);
    console.log("      prefix                                 prefix gas   the rescue");
    let worstArrival = 0n, worstCtx = "";
    for (const [label, prefix] of contexts) {
      if (label.startsWith("after") && prefix.length === 0) {
        console.log(`      ${label.padEnd(38)}  (none available — skipped)`); continue;
      }
      const r = await arrivalCost(prefix);
      console.log(`      ${label.padEnd(38)}  ${M(r.prefixGas).padStart(10)}   ${M(r.cost).padStart(10)}` +
        `${r.failed ? `   ⛔ ${r.failed} FAILED` : ""}`);
      if (r.cost > worstArrival) { worstArrival = r.cost; worstCtx = label; }
    }

    // ⛔ READ THE FLOOR FROM A RESTORED WORLD. arrivalCost() sets minGasPerItem to 2.5M so
    //    the guard cannot interfere with the measurement, and the FIRST version of this
    //    test then read the value back afterwards — reporting "shipped floor 2.50M" when
    //    the shipped floor is 3.50M. The number was the test's own leftover state.
    //    A wrong figure printed confidently in an artifact is worse than no figure.
    await snap.restore();
    const floor = await ctx.keeper.minGasPerItem();
    console.log(`\n      -> WORST ARRIVAL: ${M(worstArrival)}  (${worstCtx})`);
    console.log(`         shipped floor ${M(floor)} — ${floor > worstArrival ? "CLEARS" : "⛔ DOES NOT CLEAR"} it` +
      `${floor > worstArrival ? ` with ${(Number(floor - worstArrival) / Number(worstArrival) * 100).toFixed(0)}% headroom` : ""}.`);
    const smallest = [2_500_000n, 3_500_000n, 5_000_000n, 7_500_000n].find((v) => v > worstArrival);
    console.log(`         DAO menu: 2.5M / 3.5M / 5M / 7.5M — the smallest that clears is ` +
      `${smallest ? M(smallest) : "NONE ON THE MENU"}.`);
    console.log(`\n      ⚠ A VIOLATED INVARIANT IS NOT THE SAME AS A REACHABLE FAILURE. THIS IS WHY`);
    console.log(`        3.5M SURVIVED AS LONG AS IT DID, AND WHY IT WAS STILL MOVED TO ${M(floor)}:`);
    console.log(`        for the cascade to fire, gasleft must be NEAR THE FLOOR at the moment a`);
    console.log(`        COLD ${M(worstArrival)} item starts. In a single-tier world those two cannot`);
    console.log(`        co-occur: burning ~12M of budget REQUIRES running rescues, and running`);
    console.log(`        rescues WARMS the expensive path. Cheap items cost ~0.12M, so a cap-20`);
    console.log(`        batch of nothing but evictions burns ~2.4M — it can never walk gas down`);
    console.log(`        to the floor while leaving anything cold. GAS-8 measured exactly that:`);
    console.log(`        zero failures at every budget.`);
    console.log(`      ⛔ A SECOND TIER BREAKS THAT COUPLING, WHICH IS NOW THE WHOLE QUESTION.`);
    console.log(`        Tier-1 rescues burn gas while tier-2 storage stays COLD. That is the one`);
    console.log(`        shape where a cold ${M(worstArrival)} item can arrive with ~${M(floor)} left.`);
    console.log(`        UNMEASURED. Do not settle minGasPerItem until it is.`);

    ctx.worstArrival = worstArrival;
    expect(worstArrival, "no arrival context produced a cost, so nothing was measured").to.be.gt(0n);
  });

  it("GAS-10: A COLD PAIR ARRIVING LATE — the coupling test, and the floor's real verdict", async function () {
    // ⛔ THE QUESTION, STATED EXACTLY.
    //
    // GAS-9 showed the floor's invariant IS violated: a cold SF-funded rescue costs 4.31M
    // against a 3.50M floor. GAS-8 showed no failure ever actually occurs. Both are true,
    // and the reconciliation is a COUPLING: to walk gas down to the floor you must run
    // rescues, and running rescues WARMS the expensive path, so by the time gas is scarce
    // nothing cold is left to start. Cheap items can't burn enough to matter (~0.12M each).
    //
    // A SECOND MATRIX PAIR IN THE SAME TIER BREAKS THAT COUPLING and is nearly free.
    // Different contracts, therefore different storage, therefore cold — exactly like a
    // second tier — but reachable through the ordinary parked-rescue path with no upgrade
    // gate, no extra members and no config change. It is also REALISTIC: the owner's
    // routing rule is that a new pair is spawned so overflowing members have space to sit
    // (PairManagerV8:538). A queue forms against a full pair, a pair is added, the queue
    // drains into cold storage.
    //
    // ⛔⛔ HOW THE FIRST VERSION OF THIS TEST LIED, AND WHY THE REWRITE LOOKS LIKE THIS.
    //   v1 added the pair once and then swept five budgets IN ONE WORLD, because
    //   snap.restore() undoes contract deployments. Every run CONSUMED rescues, so each
    //   later row tested a more depleted world than the one before. The final row — the
    //   16M budget, nominally the strongest test — burned 0.59M and rescued NOBODY,
    //   because there was nothing left to do. It then printed "NO CASCADE" in bold.
    //
    //   A sweep whose later rows are WEAKER tests than its earlier ones, reported as
    //   though they were all equal, is a false-negative machine. Each budget now gets a
    //   FRESH world with a freshly deployed cold pair, and every row reports how much
    //   work it actually found so a depleted row can never masquerade as a clean pass.
    //
    //   v1 also reported the cold-pair rescue at 4.36M — IDENTICAL to the pre-pair cold
    //   cost. Two numbers agreeing when they describe different storage is as loud a
    //   signal as two disagreeing, and it had one likely cause: the rescue never went to
    //   the new pair at all. So the probe now reads matA2/matB2 OCCUPANCY before and
    //   after, and says outright when the cold pair was never touched.
    if (!ctx.MX) { console.log("\n      (fixture did not export MX — skipped)"); this.skip(); }

    // A fresh world with a freshly deployed, entirely cold second pair. Deployments do not
    // survive snap.restore(), so this must run again for every measurement.
    async function coldPairWorld() {
      await snap.restore();
      const matA2 = await ctx.MX.deploy(ctx.dp, FEE, ctx.size, true, 0, SPLITS, CP_BPS);
      const matB2 = await ctx.MX.deploy(ctx.dp, FEE, ctx.size, false, 0, SPLITS, CP_BPS);
      const [a2, b2] = [await matA2.getAddress(), await matB2.getAddress()];
      await matA2.setPartner(b2);
      await matB2.setPartner(a2);
      for (const m of [matA2, matB2]) {
        await m.setPairManager(ctx.pmAddr);
        await m.setTierRouter(await ctx.tr.getAddress());
        await m.setStabilityFund(ctx.sfAddr);
        await m.setMatrixKeeper(ctx.keeperAddr);
        await ctx.treasury.setAuthorizedCaller(await m.getAddress(), true);
        await ctx.sf.setMatrixAuthorized(await m.getAddress(), true);
      }
      await ctx.pm.addPair(a2, b2);
      await ctx.tr.registerMatrix(a2, 0);
      await ctx.tr.registerMatrix(b2, 0);
      await ctx.keeper.setMaxItemsPerUpkeep(40);
      return { matA2, matB2 };
    }
    const occ = async (w) => [await w.matA2.occupancy(), await w.matB2.occupancy()];
    const parse = (rc) => rc.logs
      .map((l) => { try { return ctx.keeper.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    // ── 1. PROBE: does a rescue actually REACH the cold pair, and what does it cost? ────
    let touched = false;
    {
      const w = await coldPairWorld();
      await ctx.keeper.setMinGasPerItem(2_500_000);
      const [, d] = await ctx.keeper.checkUpkeep("0x");
      const rescues = decodeItems(d).filter((i) => i.workType === WORK.PARKED_RESCUE);
      expect(rescues.length, "no parked rescues discovered after adding the pair").to.be.gt(0);
      const before = await occ(w);
      const rc = await (await ctx.keeper.performUpkeep(encodeItems([rescues[0]]))).wait();
      const after = await occ(w);
      touched = after[0] > before[0] || after[1] > before[1];
      console.log(`\n      COLD-PAIR PROBE`);
      console.log(`        one parked rescue, run alone: ${M(rc.gasUsed)}` +
        `${parse(rc).filter((e) => e.name === "WorkItemFailed").length ? "  ⛔ FAILED" : ""}`);
      console.log(`        pair-2 occupancy  matA2 ${before[0]} -> ${after[0]}   matB2 ${before[1]} -> ${after[1]}`);
      if (!touched) {
        console.log(`      ⛔⛔ THE COLD PAIR WAS NEVER TOUCHED. The rescue seated somewhere else,`);
        console.log(`          so NOTHING below tests cold storage and this test proves NOTHING`);
        console.log(`          about the coupling. Do not read a clean sweep as a pass.`);
      }
    }

    // ── 2. ADVERSARIAL: burn gas on warm work, then hit the cold pair. FRESH WORLD EACH. ─
    const shippedFloor10 = await (async () => { await snap.restore(); return ctx.keeper.minGasPerItem(); })();
    console.log(`\n      ADVERSARIAL BATCH — fresh world per budget, SHIPPED ${M(shippedFloor10)} floor`);
    console.log("        budget  items    gasUsed  rescued  halted  pair2 seats  WorkItemFailed");
    let cascade = 0, rowsWithWork = 0;
    for (const limit of [8_000_000, 10_000_000, 12_000_000, 14_000_000, 16_000_000]) {
      const w = await coldPairWorld();
      await ctx.keeper.setMinGasPerItem(shippedFloor10);
      const [, dd] = await ctx.keeper.checkUpkeep("0x");
      const list = decodeItems(dd).slice(0, 12);
      const before = await occ(w);
      let rc = null, threw = null;
      try {
        rc = await (await ctx.keeper.performUpkeep(encodeItems(list), { gasLimit: limit })).wait();
      } catch (e) { threw = e.shortMessage || e.message; }
      if (!rc) { console.log(`      ${M(BigInt(limit)).padStart(8)}   THREW: ${threw}`); continue; }
      const evs = parse(rc);
      const failed = evs.filter((e) => e.name === "WorkItemFailed").length;
      const halted = evs.find((e) => e.name === "BatchGasHalted");
      const after = await occ(w);
      const seats = (after[0] - before[0]) + (after[1] - before[1]);
      cascade += failed;
      if (list.length >= 3) rowsWithWork++;
      console.log(`      ${M(BigInt(limit)).padStart(8)}  ${String(list.length).padStart(5)}  ` +
        `${M(rc.gasUsed).padStart(9)}  ${String(evs.filter((e) => e.name === "ParkedRescued").length).padStart(7)}  ` +
        `${String(halted ? `${Number(halted.args.processed)}/${Number(halted.args.total)}` : "no").padStart(6)}  ` +
        `${String(seats).padStart(11)}  ${failed === 0 ? "0" : `⛔ ${failed}`}`);
    }

    console.log("");
    if (!touched) {
      console.log(`      -> INCONCLUSIVE. The cold pair was never seated into, so the coupling was`);
      console.log(`         never actually put under test — PairManagerV8.rescueReentry returns a`);
      console.log(`         rescued member to their OWN pair (destPair = fromPairIndex), so a new`);
      console.log(`         pair can never attract one. Only a second TIER reaches cold storage.`);
      console.log(`         Treat ${M(shippedFloor10)} as UNVERIFIED against this failure mode.`);
    } else if (cascade === 0) {
      console.log(`      -> NO CASCADE across ${rowsWithWork} rows that had real work, with cold pair-2`);
      console.log(`         storage reachable mid-batch. The coupling held.`);
    } else {
      console.log(`      -> ⛔ ${cascade} WorkItemFailed. The coupling is broken and 3.50M cannot ship.`);
    }
    console.log(`      ⚠ WorkItemFailed has causes OTHER than gas — a floor refusal, an exhausted`);
    console.log(`        fund, an already-rescued member all emit it. A non-zero count is a REASON`);
    console.log(`        TO INVESTIGATE, not a proof of exhaustion. That ambiguity is defect 8's`);
    console.log(`        entire point and this test cannot see through it either.`);

    // The one thing worth failing on: a sweep where nothing had work is not a pass.
    expect(rowsWithWork, "every adversarial row found fewer than 3 items, so the sweep tested " +
      "an empty world and its clean result means nothing").to.be.gt(0);
  });

  it("GAS-3: the batch is not dominated by one pathological item", async function () {
    // If a single item can approach the ceiling on its own, the cap is the wrong control
    // entirely and no value of maxItemsPerUpkeep is safe. Worth knowing before tuning it.
    await snap.restore();
    await ctx.keeper.setMaxItemsPerUpkeep(40);
    const [, data] = await ctx.keeper.checkUpkeep("0x");
    const items = decodeItems(data);

    let worst = 0n, worstKind = "(none)", capRefusals = 0;
    for (const it of items.slice(0, 12)) {
      try {
        const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
        if (rc.gasUsed > worst) { worst = rc.gasUsed; worstKind = NAME[it.workType]; }
      } catch (e) {
        // A refusal is not a measurement — but an item too EXPENSIVE to send is not a
        // refusal, and swallowing both identically is exactly defect 8's failure mode
        // reproduced inside the instrument that is supposed to detect it. Say which.
        if (isCapError(e)) capRefusals++;
      }
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
    if (SIZE === 127) {
      console.log(`      ⛔ GATE MEASUREMENT 2 — at LIVE matrix size the guard fires and halts the`);
      console.log(`         batch after ${processed} of ${total} items. It is reached, and it is`);
      console.log(`         distinguishable in the logs from a floor refusal. (Forced conditions:`);
      console.log(`         minGasPerItem 7.5M, gasLimit 12M — this proves the guard WORKS, it is`);
      console.log(`         not a reading of when it fires under the shipped floor. GAS-8 is that.)`);
    }

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
    let worst = 0n, capRefusals = 0;
    for (const it of decodeItems(data).filter((i) => i.workType === WORK.PARKED_RESCUE)) {
      try {
        const rc = await (await ctx.keeper.performUpkeep(encodeItems([it]))).wait();
        if (rc.gasUsed > worst) worst = rc.gasUsed;
      } catch (e) {
        // A refusal is not a measurement — but an item too EXPENSIVE to send is not a
        // refusal, and swallowing both identically is exactly defect 8's failure mode
        // reproduced inside the instrument that is supposed to detect it. Say which.
        if (isCapError(e)) capRefusals++;
      }
    }
    expect(worst, `no rescue produced a gas figure to compare the floor against` +
      (capRefusals ? ` — ${capRefusals} were refused for EXCEEDING the ${M(PROVIDER_CAP)} ` +
        `transaction cap at MATRIX_SIZE ${SIZE}, so the floor is not merely wrong, the item ` +
        `does not fit in a transaction at all.` : ``)).to.be.gt(0n);

    await snap.restore();
    const floor = await ctx.keeper.minGasPerItem();
    console.log(`\n      minGasPerItem ${M(floor)} vs worst measured item ${M(worst)} ` +
      `(MATRIX_SIZE ${SIZE}${SIZE === 127 ? " — LIVE SIZE" : `; live 127 MEASURED ${M(LIVE_WORST_COLD_RESCUE)}`})`);

    // ⛔ AT MATRIX_SIZE 127 THIS ASSERTION IS THE V8.50 DEPLOY GATE'S MEASUREMENT 1.
    //    Failing here is not a broken test — it is the finding the gate exists to
    //    produce, and it says minGasPerItem must move before the community sees V8.50.
    if (SIZE === 127) {
      const headroom = (Number(floor - worst) / Number(worst) * 100);
      console.log(`      ⛔ GATE MEASUREMENT 1 — worst SF-funded rescue at LIVE matrix size: ${M(worst)}`);
      console.log(`         floor ${M(floor)} ${floor > worst ? "CLEARS" : "DOES NOT CLEAR"} it` +
        `${floor > worst ? ` with ${headroom.toFixed(0)}% headroom` : ""}.`);
      console.log(`         basis: in-process hardhat, V8.50 code at HEAD, fixture population ${POP},`);
      console.log(`                one tier, every member referred to W1. NOT the community chain's state.`);
    }

    expect(floor, `the gas floor (${M(floor)}) is at or below the worst item measured here ` +
      `(${M(worst)} at MATRIX_SIZE ${SIZE}). A floor under one item's cost lets the batch ` +
      `start work it cannot finish and the WorkItemFailed cascade returns.`).to.be.gt(worst);

    // ⚠ AT THE DEFAULT SIZE THE LOCAL WORST IS NOT THE LIVE WORST — 1.76M here against
    //   4.37M at 127. The assertion above cannot see that, so the live figure gets its own
    //   check. This used to compare against ~2.6M, which was a BATCH AVERAGE and not a
    //   single item at all; it is now the MEASURED cold cost at live matrix size.
    expect(floor, `the floor must clear the ${M(LIVE_WORST_COLD_RESCUE)} a cold SF-funded ` +
      `rescue MEASURED at the live MATRIX_SIZE 127, not merely the cheaper item a small ` +
      `world produces. Below this the batch can start an item it cannot finish and defect ` +
      `8's WorkItemFailed cascade returns — silently.`).to.be.gt(LIVE_WORST_COLD_RESCUE);

    // Every value the DAO can vote for must still be settable, and the lowest of them
    // must still clear the live figure — a menu entry that breaks the invariant is a
    // proposal waiting to disarm the guard.
    for (const v of [2_500_000, 3_500_000, 5_000_000, 7_500_000]) {
      await ctx.keeper.setMinGasPerItem(v);
      expect(await ctx.keeper.minGasPerItem(), `menu value ${v} must be settable`).to.equal(BigInt(v));
    }
    await ctx.keeper.setMinGasPerItem(5_000_000);   // the shipped default, restored
    await expect(ctx.keeper.setMinGasPerItem(1_000_000),
      "a value below the menu must be refused").to.be.reverted;
  });
});
