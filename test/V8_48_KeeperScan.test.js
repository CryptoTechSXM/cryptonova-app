"use strict";
/**
 * V8_48_KeeperScan.test.js — V8.48 item 12a: MatrixKeeperLib extraction.
 *
 * WHAT THIS PROVES
 *   The refactored MatrixKeeper and the frozen pre-refactor copy
 *   (contracts/test/MatrixKeeperPrev.sol, commit 7eaf3d6) return BYTE-IDENTICAL
 *   performData from checkUpkeep, across every state this fixture can reach.
 *
 * WHY EQUIVALENCE AND NOT SCENARIOS
 *   Item 12a is a pure move: the scan reads eighteen keeper variables, and they now
 *   travel through a ScanCfg memory snapshot instead of being read from storage in
 *   place. That introduces exactly one new failure mode — a field wired to the wrong
 *   neighbour. `idleSlotTimeout` written where `extendedIdleTimeout` belongs compiles
 *   cleanly, passes all 472 existing tests, and changes only WHEN the keeper decides
 *   to act. No hand-written scenario catches that unless it happens to guess the
 *   mis-wired field. Comparing two implementations does not have to guess.
 *
 *   Note what the existing suite did NOT cover before this file: the idle/ghost sweep
 *   (_scanMatrix) and the parked-member triage (_checkParked) — the two most intricate
 *   things item 12a moved — had no checkUpkeep coverage at all. "472 passing" was
 *   therefore not evidence that they survived the move. It is now.
 *
 * HOW STRONG IS THIS? MEASURED, NOT ASSUMED.
 *   Seven deliberate mutations were injected into MatrixKeeper's ScanCfg snapshot and
 *   this file was re-run against each. Four are caught, three are not:
 *
 *     KILLED   idleSlotTimeout <-> extendedIdleTimeout   (the MUTATION PROBE below)
 *     KILLED   pendingChainLinks replaced by an empty array
 *     KILLED   maxItems hardcoded instead of read
 *     KILLED   communityWallet pointed at the wrong contract
 *
 *     SURVIVES frozenMatBTimeout <-> parkedGracePeriod
 *              Both default to 6 hours, so the swap is a no-op at defaults; and with
 *              distinct values it still hides, because _isFrozenMatB short-circuits on
 *              lastRotationTimestamp == 0 and never reads the timeout at all. Killing it
 *              needs a MatB that is full AND has rotated AND has then gone stale — a
 *              world this fixture does not build. V8_44_Keeper.test.js K2 covers that
 *              behaviour directly, just not through the snapshot.
 *
 *     SURVIVES sfRescueThresholds <-> sfRescueBpsLadder
 *              Needs the StabilityFund balance tuned so the ladder's chosen bps is what
 *              decides PARKED_RESCUE vs nothing. At the balances this fixture produces,
 *              both orderings clear the bar.
 *
 *     SURVIVES rescueRatioBps <-> maxItemsPerUpkeep
 *              The eviction branch compares withdrawn/totalEarned against rescueRatioBps.
 *              No member in this fixture has withdrawn anything, so the ratio is 0 and no
 *              threshold below it can change the answer. Needs a parked member who has
 *              taken a withdrawal first.
 *
 *   Recorded rather than quietly left as "all green": knowing the boundary of a test is
 *   worth as much as the test. If item 12 keeps this harness, these three are where to
 *   start.
 *
 * ~~DELETE THIS FILE WITH ITEM 12~~ — SUPERSEDED 2026-08-11. KEEP IT.
 *
 *   That instruction assumed item 12 would change the scan's behaviour outright, making
 *   equivalence false by design. It shipped differently: the split grace is CONDITIONAL,
 *   and setting selfFundedGracePeriod == parkedGracePeriod collapses it back to the old
 *   behaviour exactly. This file now pins those two together in setup(), so it still
 *   proves what it was written to prove — that item 12a's extraction was behaviour-
 *   preserving — while V8_48_SplitGrace.test.js covers the new branch separately.
 *
 *   Retire this file (and MatrixKeeperPrev.sol) when the 12a refactor is old enough that
 *   a frozen pre-refactor keeper is no longer worth compiling, NOT on item 12's account.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE = 10_000_000n;

const WORK = {
  VELOCITY: 0, GHOST: 1, RECLAIM: 2, CHAIN_LINK: 3, PARKED_RESCUE: 4,
  VELOCITY_GATE: 5, EVICT_PARKED: 6, DISTRIBUTE_CW: 7, FORCE_ROTATE: 8,
  ADVANCE_EPOCH: 9,
};
const NAME = Object.fromEntries(Object.entries(WORK).map(([k, v]) => [v, k]));

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
const describeItems = (items) =>
  items.length === 0 ? "(none)" : items.map((i) => `${NAME[i.workType]}@t${i.tierIndex}`).join(", ");

describe("V8.48 item 12a — MatrixKeeperLib extraction is behaviour-preserving", function () {
  this.timeout(600_000);

  let ctx;

  // Deploy BOTH keepers against one world. Neither is wired as the matrices' keeper —
  // checkUpkeep is a view, so it needs configuration, not authority. That also keeps the
  // comparison honest: identical configuration in, identical bytes out.
  async function deployBoth(size) {
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
    const keeperNew = await (await ethers.getContractFactory("MatrixKeeper", {
      libraries: { MatrixKeeperLib: await keeperLib.getAddress() },
    })).deploy(trAddr, sfAddr);
    const keeperOld = await (await ethers.getContractFactory("MatrixKeeperPrev")).deploy(trAddr, sfAddr);
    const keeperAddr = await keeperNew.getAddress();

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

    // Configure BOTH identically. Anything applied to one must be applied to the other,
    // which is what `bothKeepers` below exists to enforce.
    for (const k of [keeperNew, keeperOld]) await k.setPairManager(0, pmAddr);

    // V8.48 item 12 deliberately CHANGES behaviour: a parked member who funds their own
    // re-entry clears selfFundedGracePeriod instead of parkedGracePeriod. The frozen
    // reference keeper has no such concept, so equivalence only holds where the two
    // windows are equal — pin them together explicitly rather than relying on this
    // fixture never producing a self-funded member. (It does not: members here park at
    // roughly 80% of the fee. But "the test passes because the state is unreachable" is
    // exactly the blind spot that made the first version of this file worthless, and it
    // should not be load-bearing a second time.)
    for (const k of [keeperNew]) await k.setSelfFundedGracePeriod(0);
    for (const k of [keeperNew, keeperOld]) await k.setParkedGracePeriod(0);

    return {
      usdc, tr, pm, sf, matA, matB, keeperNew, keeperOld, owner, W1, devOps, sigs,
      pmAddr, matAAddr, matBAddr,
    };
  }

  // Apply the same config call to both keepers so they can never drift apart.
  async function both(fn) {
    await fn(ctx.keeperNew);
    await fn(ctx.keeperOld);
  }

  /**
   * THE CORE ASSERTION. Compares raw performData bytes, not decoded fields — a decode
   * that drops a field would hide exactly the bug this is looking for.
   */
  async function assertIdentical(label) {
    const [neededNew, dataNew] = await ctx.keeperNew.checkUpkeep("0x");
    const [neededOld, dataOld] = await ctx.keeperOld.checkUpkeep("0x");
    const itemsNew = decodeItems(dataNew);
    const itemsOld = decodeItems(dataOld);

    expect(dataNew, `${label}: performData BYTES differ\n` +
      `      new: ${describeItems(itemsNew)}\n` +
      `      old: ${describeItems(itemsOld)}`).to.equal(dataOld);
    expect(neededNew, `${label}: upkeepNeeded differs`).to.equal(neededOld);
    return itemsNew;
  }

  async function reg(signer, referrer) {
    await ctx.usdc.mint(signer.address, FEE);
    await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
    await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
  }

  // Registering a real population is not decoration. With only a handful of members
  // matA never reaches MATRIX_SIZE, so rotationCount stays 0 — and _scanMatrix returns
  // on its very first line when that is true. A fixture that skips this exercises none
  // of the idle sweep while still reporting green, which is exactly what the first
  // draft of this file did.
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
    expect(await c.matA.rotationCount(), "matA must have rotated or the idle sweep is unreachable").to.be.gt(0n);
    return c;
  }

  /**
   * Build a MatB that is FULL and has NEVER rotated — the July 19 occ=127/127 rot=0
   * signature the frozen-MatB backstop exists for. Without this, _isFrozenMatB returns
   * at `occupancy() < MATRIX_SIZE()` and frozenMatBTimeout is never read, so any test
   * that claims to exercise it is claiming something untrue. Measured: with an ordinary
   * populated world, swapping frozenMatBTimeout into ScanCfg survives undetected.
   * Lifted from V8_44_Keeper.test.js's fillMatBExactly.
   */
  async function fillMatBExactly(c, size) {
    const { sigs, W1 } = c;
    const regIn = async (sg, ref) => {
      await c.usdc.mint(sg.address, FEE);
      await c.usdc.connect(sg).approve(c.pmAddr, FEE);
      await c.tr.connect(sg).register(ref, { gasLimit: 16_000_000 });
    };
    const forceCross = async (addr) => {
      await c.usdc.mint(c.owner.address, FEE);
      await c.usdc.connect(c.owner).approve(c.matAAddr, FEE);
      await c.matA.connect(c.owner).forceCross(addr, { gasLimit: 16_000_000 });
    };
    const fillers = sigs.slice(10, 10 + size - 1);
    await regIn(W1, ethers.ZeroAddress);
    for (const f of fillers) await regIn(f, W1.address);
    const cyclers = [W1, ...fillers];
    const externals = sigs.slice(10 + size - 1, 10 + 2 * size - 1);
    for (let i = 0; i < size; i++) {
      await regIn(externals[i], W1.address);
      if (!(await c.matB.isActiveInMatrix(cyclers[i].address))) await forceCross(cyclers[i].address);
    }
    expect(await c.matB.occupancy(), "MatB must be FULL").to.equal(BigInt(size));
    expect(await c.matB.rotationCount(), "MatB must never have rotated").to.equal(0n);
    return c;
  }

  async function freshPopulated() {
    const c = await deployBoth(7);
    await populate(c);
    return c;
  }

  before(async function () {
    ctx = await deployBoth(7);
  });

  it("agree on an empty world (no tiers registered yet is the degenerate case)", async function () {
    await assertIdentical("empty world");

    // Sanity: prove the comparison is not passing because BOTH sides are silently
    // returning nothing. The constructor sets lastVelocityCheck = block.timestamp, so a
    // freshly deployed keeper is deliberately quiet on velocity; roll past the window
    // and the item must appear on both.
    const window = await ctx.keeperNew.velocityWindow();
    await time.increase(Number(window) + 10);
    const items = await assertIdentical("empty world, velocity window elapsed");
    expect(items.some((i) => i.workType === WORK.VELOCITY),
      "no VELOCITY item after the window elapsed — the fixture is not exercising the scan at all").to.equal(true);
  });

  it("agree once members are registered and the matrices are ROTATING", async function () {
    await populate(ctx);
    await assertIdentical("populated");
  });

  it("agree across the idle sweep, and the sweep actually FIRES", async function () {
    // Own world: idle age is measured from registration, and the shared ctx has had the
    // clock pushed forward by earlier tests. Starting fresh is what makes the GHOST
    // window (idle >= idleSlotTimeout but < extendedIdleTimeout) reachable at all.
    const c = await freshPopulated();
    const pair = async (fn) => { await fn(c.keeperNew); await fn(c.keeperOld); };
    const same = async (label) => {
      const [, dn] = await c.keeperNew.checkUpkeep("0x");
      const [, do_] = await c.keeperOld.checkUpkeep("0x");
      expect(dn, `${label}: performData BYTES differ`).to.equal(do_);
      return decodeItems(dn);
    };

    await pair((k) => k.setIdleSlotTimeout(21_600));       // 6h  — GHOST threshold
    await pair((k) => k.setExtendedIdleTimeout(604_800));  // 7d  — RECLAIM threshold

    let items = await same("idle: fresh, below both thresholds");
    expect(items.some((i) => i.workType === WORK.GHOST), "no GHOST expected yet").to.equal(false);
    expect(items.some((i) => i.workType === WORK.RECLAIM), "no RECLAIM expected yet").to.equal(false);

    await time.increase(25_000);                            // ~7h: past 6h, far short of 7d
    items = await same("idle: inside the GHOST window");
    expect(items.some((i) => i.workType === WORK.GHOST),
      "GHOST must fire between idleSlotTimeout and extendedIdleTimeout — if it does not, _scanMatrix is not being reached and this file proves nothing").to.equal(true);
    expect(items.some((i) => i.workType === WORK.RECLAIM), "RECLAIM must NOT fire yet").to.equal(false);

    await time.increase(8 * 86_400);                        // past 7d
    items = await same("idle: past extendedIdleTimeout");
    expect(items.some((i) => i.workType === WORK.RECLAIM),
      "RECLAIM must fire once idle passes extendedIdleTimeout").to.equal(true);
  });

  it("MUTATION PROBE: crossing the two idle thresholds must change the bytes", async function () {
    // THE test for the one failure mode item 12a introduced. The ScanCfg snapshot copies
    // eighteen fields; a field assigned to its neighbour compiles, passes every other
    // test, and only changes WHEN the keeper acts.
    //
    // This works by putting the world at an idle age that sits BETWEEN the two thresholds,
    // where the correct answer is GHOST and the swapped answer is RECLAIM. Verified by
    // deliberately swapping the two fields in MatrixKeeper.checkUpkeep and confirming this
    // test — and only this test — goes red. The first version of this file did NOT do that
    // and the mutant survived it.
    const c = await freshPopulated();
    for (const k of [c.keeperNew, c.keeperOld]) {
      await k.setIdleSlotTimeout(21_600);        // 6h
      await k.setExtendedIdleTimeout(604_800);   // 7d
    }
    await time.increase(25_000);                 // ~7h — strictly between the two

    const [, dn] = await c.keeperNew.checkUpkeep("0x");
    const [, do_] = await c.keeperOld.checkUpkeep("0x");
    const items = decodeItems(dn);

    // If the snapshot had the fields crossed, 7h would read as "past the reclaim
    // threshold" and this would be RECLAIM instead.
    expect(items.some((i) => i.workType === WORK.GHOST),
      "expected GHOST at 7h idle with thresholds 6h/7d — a swapped ScanCfg produces RECLAIM here").to.equal(true);
    expect(items.some((i) => i.workType === WORK.RECLAIM),
      "RECLAIM at 7h idle means idleSlotTimeout and extendedIdleTimeout are crossed in ScanCfg").to.equal(false);
    expect(dn, "the two implementations disagree at the threshold boundary").to.equal(do_);
  });

  it("agree as maxItemsPerUpkeep truncates the batch", async function () {
    for (const n of [5, 10, 15, 20, 30, 40]) {   // the enumerated menu
      await both((k) => k.setMaxItemsPerUpkeep(n));
      const items = await assertIdentical(`maxItems=${n}`);
      expect(items.length, `maxItems=${n} must cap the batch`).to.be.lte(n);
    }
    await both((k) => k.setMaxItemsPerUpkeep(15));
  });

  it("agree across the parked grace period — the other uncovered path", async function () {
    // _checkParked. Whether or not this fixture manages to park anyone, moving the
    // grace period must move BOTH keepers the same way.
    for (const g of [0, 300, 6 * 3600, 30 * 86400]) {   // 0 or 5min..30d
      await both((k) => k.setParkedGracePeriod(g));
      // keep the self-funded window pinned to the loan window so the two keepers stay
      // comparable; the split itself is covered by V8_48_SplitGrace.test.js
      await ctx.keeperNew.setSelfFundedGracePeriod(g === 0 ? 0 : (g >= 3600 ? 3600 : 300));
      await assertIdentical(`parkedGracePeriod=${g}`);
    }
    await both((k) => k.setParkedGracePeriod(6 * 3600));
  });

  it("agree across the rescue-ratio eviction boundary", async function () {
    for (const bps of [5_000, 6_000, 7_000, 8_000, 9_000, 9_500]) {   // the enumerated menu
      await both((k) => k.setRescueRatioBps(bps));
      await assertIdentical(`rescueRatioBps=${bps}`);
    }
    await both((k) => k.setRescueRatioBps(7_000));
  });

  it("agree across every SF rescue ladder preset", async function () {
    for (const preset of [0, 1, 2, 3]) {
      await both((k) => k.setSfRescueLadderPreset(preset));
      await assertIdentical(`sfRescueLadderPreset=${preset}`);
    }
    await both((k) => k.setSfRescueLadderPreset(1));
  });

  it("agree across the frozen-MatB timeout, with a MatB that is ACTUALLY frozen", async function () {
    // Measured: swapping frozenMatBTimeout with parkedGracePeriod in ScanCfg survived the
    // first version of this test, because BOTH default to 6 hours — the swap was a no-op.
    // Distinct values plus a full, never-rotated MatB make the field load-bearing.
    const c = await fillMatBExactly(await deployBoth(7), 7);
    const pair = async (fn) => { await fn(c.keeperNew); await fn(c.keeperOld); };
    const same = async (label) => {
      const [, dn] = await c.keeperNew.checkUpkeep("0x");
      const [, do_] = await c.keeperOld.checkUpkeep("0x");
      expect(dn, `${label}: performData BYTES differ`).to.equal(do_);
      return decodeItems(dn);
    };
    // Distinct values on purpose: both fields default to 6 hours, so a swap between them
    // is a no-op at defaults and proves nothing.
    await pair((k) => k.setParkedGracePeriod(30 * 86_400));   // 30d
    await pair((k) => k.setFrozenMatBTimeout(300));           // 5min
    let items = await same("frozen: grace 30d, frozen-timeout 5min");
    expect(items.some((i) => i.workType === WORK.FORCE_ROTATE),
      "a full never-rotated MatB past a 5min timeout MUST be flagged — otherwise frozenMatBTimeout is never read and this test is decorative").to.equal(true);

    await pair((k) => k.setFrozenMatBTimeout(30 * 86_400));   // 30d
    items = await same("frozen: frozen-timeout raised to 30d");
    // lastRotationTimestamp is 0 (never rotated), which the contract treats as frozen
    // regardless of the timeout — so the flag SURVIVES the raise. Asserted rather than
    // assumed, because the opposite would be the intuitive guess.
    expect(items.some((i) => i.workType === WORK.FORCE_ROTATE),
      "a MatB that NEVER rotated stays flagged whatever the timeout (lastRot == 0 short-circuits)").to.equal(true);

    await pair((k) => k.setParkedGracePeriod(6 * 3_600));
    await pair((k) => k.setFrozenMatBTimeout(6 * 3_600));
    await same("frozen: both back to the 6h default");
  });

  it("agree across the frozen-MatB timeout (shared world)", async function () {
    for (const t of [0, 300, 6 * 3600, 30 * 86400]) {   // 0 or 5min..30d
      await both((k) => k.setFrozenMatBTimeout(t));
      await assertIdentical(`frozenMatBTimeout=${t}`);
    }
    await both((k) => k.setFrozenMatBTimeout(6 * 3600));
  });

  it("agree with a CommunityWallet wired — due, not due, and pointed at the wrong contract", async function () {
    // Own world, deliberately UNPOPULATED. The CW check is the LAST thing checkUpkeep
    // does and it is guarded by `count < maxItems`; in the populated world the batch is
    // already full of RECLAIM and PARKED_RESCUE items, so the CW branch never runs and
    // this case silently proves nothing. That is how it read green while asserting the
    // opposite of what was happening.
    const c = await deployBoth(7);
    const pair = async (fn) => { await fn(c.keeperNew); await fn(c.keeperOld); };
    const same = async (label) => {
      const [, dn] = await c.keeperNew.checkUpkeep("0x");
      const [, do_] = await c.keeperOld.checkUpkeep("0x");
      expect(dn, `${label}: performData BYTES differ`).to.equal(do_);
      return decodeItems(dn);
    };

    const usdcAddr = await c.usdc.getAddress();
    const cw = await (await ethers.getContractFactory("CommunityWallet"))
      .deploy(usdcAddr, c.owner.address);
    await pair((k) => k.setCommunityWallet(cw.target));
    let items = await same("CW wired but not due");
    expect(items.some((i) => i.workType === WORK.DISTRIBUTE_CW),
      "a CW that is not due must NOT produce a work item").to.equal(false);

    // Open the gate for real. Measured: pointing ScanCfg.communityWallet at the WRONG
    // address survived the first version of this test, because distributeReady() was
    // false either way and both sides produced nothing. With the gate genuinely open, a
    // wrong address means a MISSING item and the bytes diverge.
    await cw.enrollBatch([c.W1.address]);
    await c.usdc.mint(c.owner.address, 1_000_000n);
    await c.usdc.connect(c.owner).approve(cw.target, 1_000_000n);
    await cw.deposit(1_000_000n);
    const due = Number(await cw.nextDistributionTime());
    const nowTs = (await ethers.provider.getBlock("latest")).timestamp;
    if (due > nowTs) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [due]);
      await ethers.provider.send("evm_mine", []);
    }
    expect(await cw.distributeReady(), "the CW gate must be OPEN or this case proves nothing").to.equal(true);

    items = await same("CW wired AND due");
    expect(items.some((i) => i.workType === WORK.DISTRIBUTE_CW),
      "a due CommunityWallet must produce a DISTRIBUTE_CW item").to.equal(true);

    // A contract that is NOT a CommunityWallet: distributeReady()/epochReady() revert.
    // Both keepers must swallow it identically rather than bricking the whole scan.
    await pair((k) => k.setCommunityWallet(usdcAddr));
    items = await same("CW pointed at a contract without the selectors");
    expect(items.some((i) => i.workType === WORK.DISTRIBUTE_CW),
      "a wallet without distributeReady() must not produce a DISTRIBUTE_CW item").to.equal(false);
  });

  it("agree with pending chain links queued", async function () {
    // pendingChainLinks is a storage array the scan now receives as a memory copy —
    // the copy must preserve order and contents.
    await both((k) => k.queueChainLink(ctx.matAAddr, ctx.matBAddr, ethers.ZeroAddress, 0));
    const items = await assertIdentical("one chain link queued");
    expect(items.some((i) => i.workType === WORK.CHAIN_LINK),
      "a queued chain link must appear in the batch").to.equal(true);

    await both((k) => k.queueChainLink(ctx.matBAddr, ctx.matAAddr, ctx.matAAddr, 0));
    const items2 = await assertIdentical("two chain links queued");
    const links = items2.filter((i) => i.workType === WORK.CHAIN_LINK);
    expect(links.length, "both queued links must appear").to.equal(2);
    expect(links[0].addr1, "order must be preserved by the memory copy").to.equal(ctx.matAAddr);
    expect(links[1].addr1, "order must be preserved by the memory copy").to.equal(ctx.matBAddr);
  });

  it("agree after the velocity window rolls", async function () {
    for (const w of [1_800, 3_600, 7_200, 14_400]) {   // the enumerated menu
      await both((k) => k.setVelocityWindow(w));
      await assertIdentical(`velocityWindow=${w}`);
      await time.increase(w + 10);
      await assertIdentical(`velocityWindow=${w}, window elapsed`);
    }
  });

  it("the batch actually contains work — this whole file is vacuous otherwise", async function () {
    // Guards against the failure mode where both keepers return "0x" for every case
    // and every equivalence assertion above passes trivially.
    const [, data] = await ctx.keeperNew.checkUpkeep("0x");
    const items = decodeItems(data);
    expect(items.length, "checkUpkeep produced no work in ANY state — the comparison proved nothing").to.be.gt(0);
    const kinds = new Set(items.map((i) => i.workType));
    expect(kinds.size, `only one kind of work item was ever produced (${describeItems(items)})`).to.be.gte(1);
  });
});
