"use strict";
/**
 * V8_48_KeeperScan.test.js — V8.48 item 12a: MatrixKeeperLib extraction.
 *
 * WHAT THIS PROVES
 *   The refactored MatrixKeeper and the frozen pre-refactor copy
 *   (contracts/test/MatrixKeeperPrev.sol, commit 7eaf3d6) discover the SAME SET of work
 *   from checkUpkeep, across every state this fixture can reach.
 *
 *   ⛔ IT SAID "BYTE-IDENTICAL performData" UNTIL V8.50 DEFECT 6, AND THAT IS NOW FALSE
 *      BY DESIGN. Defect 6 reordered MatrixKeeperLib.discover so bounded work drains
 *      first and the unbounded scans then run by deadline — parked (eviction clock)
 *      ahead of ghost/reclaim (no deadline). Prev is frozen at the old order, so the two
 *      emit the same work in a different SEQUENCE. The comparison moved to multiset
 *      equality plus an exact count check; see the canon() note below for why that costs
 *      the harness none of its four measured mutation kills, and read the re-premised
 *      truncation case for the one place it genuinely could not be preserved.
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
 *   V8.49 item 1 is the SECOND item to do this — the eviction clock, likewise collapsing
 *   when evictionGracePeriod == parkedGracePeriod, likewise pinned in setup(), likewise
 *   covered separately (V8_49_EvictionClock.test.js, which asserts the collapse property
 *   itself so this file's pin cannot quietly stop meaning anything).
 *
 *   V8.50 IS THE THIRD, AND IT IS THE FIRST THAT COULD NOT BE PINNED. defect 5 lowers
 *   maxItemsPerUpkeep and IS pinnable (setup() holds it at 15, the frozen keeper's
 *   value, and the collapse is exact). Defect 6's reorder is not: an order has no value
 *   to set it back to. That is why this file's comparison changed shape instead of
 *   growing a fourth pin — and it is the honest signal that the 12a harness has started
 *   to age, exactly as the retirement note below anticipated.
 *
 *   READ THE PINS AS A LIST OF DELIBERATE BEHAVIOUR CHANGES. Each one is an item that
 *   changed the scan on purpose; the harness holds them at their old values so it can
 *   still answer the one question it was built for. If a third pin appears, that is
 *   normal. If a pin is ever added to make a FAILURE go away rather than to hold a known
 *   deliberate change, this file has stopped being evidence of anything.
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

/**
 * ⛔ V8.50 DEFECT 6 CHANGED WHAT "IDENTICAL" MEANS HERE. READ THIS BEFORE TIGHTENING IT
 *    BACK TO A BYTE COMPARE.
 *
 * This file used to compare raw performData BYTES. It cannot any more: defect 6
 * reordered MatrixKeeperLib.discover so that bounded work drains first and the two
 * UNBOUNDED scans then run in order of what expires — parked (eviction clock) ahead of
 * ghost/reclaim (no deadline). MatrixKeeperPrev is frozen at the old order by
 * definition, so the two keepers now emit the same work in a different SEQUENCE.
 *
 * Unlike the split grace and the eviction clock, this one CANNOT be pinned back to its
 * old behaviour, because an order is not a parameter. So the comparison moves from
 * sequence-identity to SET-identity, and the harness loses nothing measurable: all four
 * mutation kills recorded in the header change WHICH items appear, never merely their
 * order —
 *     idleSlotTimeout <-> extendedIdleTimeout   reclassifies GHOST vs RECLAIM
 *     pendingChainLinks emptied                 removes CHAIN_LINK items
 *     maxItems hardcoded                        changes the item COUNT
 *     communityWallet mispointed                changes the CW items
 * Every one of those is still caught by a multiset comparison, and the count check
 * below keeps the maxItems kill exact.
 *
 * The ONE place set-identity is genuinely weaker is a truncated batch, where the two
 * orders legitimately keep different work. That case is no longer compared against Prev
 * at all — it asserts the NEW priority deliberately. See "the batch truncates" below.
 */
const canon = (i) => `${i.workType}|${i.tierIndex}|${i.addr1.toLowerCase()}|${i.addr2.toLowerCase()}`;
const asMultiset = (items) => items.map(canon).sort();

function expectSameSet(itemsNew, itemsOld, label) {
  expect(itemsNew.length, `${label}: item COUNT differs\n` +
    `      new: ${describeItems(itemsNew)}\n` +
    `      old: ${describeItems(itemsOld)}`).to.equal(itemsOld.length);
  expect(asMultiset(itemsNew), `${label}: same count, DIFFERENT WORK\n` +
    `      new: ${describeItems(itemsNew)}\n` +
    `      old: ${describeItems(itemsOld)}`).to.deep.equal(asMultiset(itemsOld));
}

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
    //
    // ⛔ THE COLLAPSE IS AT ZERO, AND THE SETTERS LEAVE NO OTHER CHOICE. Read them before
    //    touching these three lines:
    //        setSelfFundedGracePeriod  0 / 60 / 300 / 900 / 1800 / 3600
    //        setEvictionGracePeriod    0 / 1d / 2d / 3d / 4d / 5d / 7d
    //    Their menus intersect at 0 and nowhere else, so "set each equal to
    //    parkedGracePeriod" — the collapse the header describes and EC-4 asserts — is
    //    only REACHABLE when parkedGracePeriod is itself 0. Anything else is unsettable.
    //
    //    THAT THIRD LINE WAS MISSING AND IT IS THE WHOLE BUG. MatrixKeeperLib._checkParked
    //    gates on
    //        age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
    //        age < (isGhost      ? parkedGracePeriod     : evictionGracePeriod)
    //    while MatrixKeeperPrev has neither branch and gates BOTH on parkedGracePeriod.
    //    Pinning the new keeper's two windows to 0 while leaving parkedGracePeriod at its
    //    6h default does not collapse the split — it OPENS it as far as it goes: the
    //    refactored keeper discovers a self-funded rescue and fires an eviction
    //    IMMEDIATELY, where the frozen one waits the full six hours.
    //
    //    It survived only while this fixture happened to produce no self-funded and no
    //    evictable parker inside that window — the exact "passes because the state is
    //    unreachable" blind spot the note below warns about, reintroduced by the pins
    //    written to prevent it. V8.50 made the state reachable: the run showed keeperNew
    //    queueing one PARKED_RESCUE and four EVICT_PARKED that Prev did not queue at all,
    //    in a batch nowhere near its cap. Six of the eight failures were this one line,
    //    the rest of them downstream of it.
    for (const k of [keeperNew, keeperOld]) await k.setParkedGracePeriod(0);
    for (const k of [keeperNew]) await k.setSelfFundedGracePeriod(0);
    for (const k of [keeperNew]) await k.setEvictionGracePeriod(0);

    // ⛔ THE FOURTH PIN, AND IT IS THE ONE THAT MAKES ALL THE OTHERS MEAN ANYTHING:
    //    THE BATCH MUST NOT TRUNCATE. Raised from the 15 default to the enumerated
    //    ceiling of 40.
    //
    //    V8.50 defect 6 reordered discovery so parked work is taken before ghost/reclaim.
    //    Once the cap BITES, the two keepers are supposed to keep DIFFERENT work — that
    //    is the entire fix — so no content comparison against a frozen keeper that
    //    orders them the other way can be meaningful. Measured on this world at the 15
    //    default: new = 12x PARKED_RESCUE + 1x RECLAIM, old = 13x RECLAIM, both exactly
    //    15, in SIX separate cases. Neither keeper was wrong. The comparison was.
    //
    //    With no truncation both emit the SAME SET in a different sequence, which is
    //    exactly what expectSameSet is for, and this file goes back to answering the one
    //    question it was built for: did the 12a extraction preserve WHICH members get
    //    WHICH verdict. Batch sizing is not that question and has its own two cases
    //    below, which set the cap deliberately and restore it to 40 rather than 15.
    //
    //    ⚠ If a future fixture grows past 40 discoverable items this pin silently stops
    //    holding and the same six failures return wearing a different hat. The guard is
    //    the count assertion in expectSameSet plus "the batch actually contains work" at
    //    the end of this file; if both keepers ever report exactly 40, suspect this line
    //    first.
    for (const k of [keeperNew, keeperOld]) await k.setMaxItemsPerUpkeep(40);

    // ⛔ V8.50 ITEM A — THE THIRD PIN, AND THE DECISION BEHIND IT IS WRITTEN OUT IN FULL
    // BECAUSE THE OBVIOUS READING OF THIS FILE IS THAT ITEM A RETIRES IT.
    //
    // THE PREMISE LOOKED STRUCTURALLY DEAD. The two pins above equalise a PARAMETER each.
    // Item A is not a parameter: it changes what a crossing COSTS, and MatrixKeeperPrev
    // will never know about it. So the first reading was that this suite cannot be
    // rescued the way items 12 and 1 were, and should be retired or re-baselined.
    //
    // THAT READING WAS WRONG, AND THE RUN SAYS SO. Item A reprices a crossing OUT OF A
    // MatA. Out of a MatB it changes nothing — MatrixKeeperLib._crossingCost returns the
    // full entry fee, the same number the frozen keeper uses — and under item A a MatA
    // parker's reserve covers their crossing outright, so MatA parks nobody for funding
    // and the entire parked queue this fixture builds lives in the MatB. The two keepers
    // therefore ask the same question about the same members. Measured on this world:
    // at insolvencyFloorBps 0 they queue the SAME SET of work, in every scenario in this
    // file. (It read BYTE-IDENTICAL when measured; V8.50 defect 6 then reordered
    // discovery, so the sequence differs and the set does not. The claim above is
    // unaffected — it was always about WHICH members get WHICH verdict.)
    //
    // WHAT DOES DIVERGE IS ONE THING, AND IT IS NOT THE EXTRACTION. Item A stops carving
    // a reserve for a MatB entrant, so a MatB parker's effective contribution is their
    // earnings alone — measured here, $4.12 and $4.88 of a $10.00 fee where V8.48 read
    // $9.12 and $9.88. Same ladder, same rung arithmetic; what moves is the SHORTFALL,
    // from ~$0.88 to ~$5.13. That ask then clears or fails the INSOLVENCY FLOOR, and the
    // floor is a governed amount. So the divergence is real, intended, and lives entirely
    // in one parameter — which is exactly the shape the two pins above already handle.
    //
    // Pinning it to 0 does NOT hide a keeper difference: both keepers call the same
    // loanEligibleFor, and this suite was green at the shipping 3400 before item A. It
    // neutralises the one INPUT item A moved. The divergence itself is not swept away —
    // it is asserted, at the shipping value, by "V8.50 item A: the two keepers diverge
    // ONLY at the insolvency floor" at the bottom of this file. Between them the file
    // now covers more than it did: the extraction is still pinned byte-for-byte, and the
    // economic change has a test that fails if it ever stops happening.
    await sf.setInsolvencyFloorBps(0);

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

    expectSameSet(itemsNew, itemsOld, label);
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
      expectSameSet(decodeItems(dn), decodeItems(do_), label);
      return decodeItems(dn);
    };

    // ⛔ THE CAP MUST NOT BITE IN THIS WORLD. V8.50 defect 6 put parked work ahead of
    // ghost/reclaim, and this fixture parks a dozen members — at the default cap of 15
    // the parked queue fills the batch and the idle sweep is squeezed out entirely.
    // Measured before this line existed: new = 12x PARKED_RESCUE + 1x GHOST, old = 13x
    // GHOST, both exactly 15. Nothing was WRONG there — that IS the reorder working, and
    // both keepers were still capped identically — but it makes the GHOST/RECLAIM
    // classification this test exists to check unobservable, and a comparison against a
    // frozen keeper that orders the two scans differently is meaningless once the cap
    // bites. Truncation priority is covered on its own, deliberately, further down.
    await pair((k) => k.setMaxItemsPerUpkeep(40));
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
      // Cap raised for the same reason as the idle sweep above: since V8.50 defect 6 put
      // parked work ahead of ghost/reclaim, a default-15 batch in this fixture is filled
      // by the parked queue and the GHOST this probe looks for never appears — which
      // would turn a MUTATION PROBE into a test that passes because it sees nothing.
      await k.setMaxItemsPerUpkeep(40);
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
    expectSameSet(decodeItems(dn), decodeItems(do_),
      "the two implementations disagree at the threshold boundary");
  });

  it("truncate the batch to the SAME SIZE — and V8.50 keeps the deadline work, not the housekeeping", async function () {
    // ⛔ THE ONE TEST DEFECT 6 GENUINELY RE-PREMISED. It used to call assertIdentical at
    // each cap, which was a fair question while both keepers filled the batch in the
    // same order. It is not fair any more and, worse, it would be MISLEADING: when the
    // cap bites, the two keepers legitimately keep DIFFERENT work, because choosing what
    // survives truncation is the entire point of the reorder. A test demanding they
    // agree there would be demanding the fix not work.
    //
    // So this splits into the two questions that are still answerable:
    //   1. the CAP itself is still read from storage and still bites identically —
    //      this is what killed the "maxItems hardcoded" mutation, and it survives;
    //   2. when it bites, V8.50 keeps the work that EXPIRES and sheds the work that
    //      does not. Asserted directly, against the new priority, not against Prev.
    for (const n of [5, 10, 15, 20, 30, 40]) {   // the enumerated menu
      await both((k) => k.setMaxItemsPerUpkeep(n));
      const [, dN] = await ctx.keeperNew.checkUpkeep("0x");
      const [, dO] = await ctx.keeperOld.checkUpkeep("0x");
      const iN = decodeItems(dN), iO = decodeItems(dO);

      expect(iN.length, `maxItems=${n} must cap the batch`).to.be.lte(n);
      expect(iN.length, `maxItems=${n}: the two keepers must truncate to the same SIZE — ` +
        `a difference here means the cap is no longer read from storage, which is the ` +
        `mutation this case was written to kill`).to.equal(iO.length);

      // 2. Deadline work first. GHOST/RECLAIM carry no deadline and are the only items
      //    the reorder demotes, so a batch that is FULL must not be spending a slot on
      //    them while a parked decision went unqueued. Stated as an implication rather
      //    than a flat "no housekeeping": when nothing is parked, housekeeping is
      //    exactly what SHOULD fill the batch.
      const full = iN.length === n;
      const housekeeping = iN.filter((i) => i.workType === WORK.GHOST || i.workType === WORK.RECLAIM).length;
      const parkedWork  = iN.filter((i) => i.workType === WORK.PARKED_RESCUE || i.workType === WORK.EVICT_PARKED).length;
      if (full && housekeeping > 0) {
        // Everything parked that was discoverable made it in, or the reorder is not
        // doing its job. Re-read at a cap large enough not to bite, and compare.
        await both((k) => k.setMaxItemsPerUpkeep(40));
        const [, dWide] = await ctx.keeperNew.checkUpkeep("0x");
        const wideParked = decodeItems(dWide)
          .filter((i) => i.workType === WORK.PARKED_RESCUE || i.workType === WORK.EVICT_PARKED).length;
        await both((k) => k.setMaxItemsPerUpkeep(n));
        expect(parkedWork, `maxItems=${n}: the batch is FULL and still spending ${housekeeping} ` +
          `slot(s) on GHOST/RECLAIM while only ${parkedWork} of ${wideParked} parked ` +
          `decisions made it in. Housekeeping has no deadline; a parked member is on the ` +
          `eviction clock. This is exactly the starvation defect 6 removed.`).to.equal(wideParked);
      }
    }
    await both((k) => k.setMaxItemsPerUpkeep(40));   // restore the no-truncation pin
  });

  it("DEFECT 6: parked work outranks ghost/reclaim when the batch cannot hold both", async function () {
    // The property stated on its own, so it cannot quietly stop being tested if the
    // truncation case above is ever rewritten.
    //
    // ⛔ THE CAP CANNOT BE SQUEEZED TO 1. setMaxItemsPerUpkeep is enumerated —
    //    5 / 10 / 15 / 20 / 30 / 40 — and the first draft of this test asked for 1 and
    //    reverted with "MK: invalid max items". FIVE is the floor, and five slots are
    //    not necessarily all contested: velocity, chain links, the CW block, force-rotate
    //    and the velocity gate are BOUNDED sources that legitimately drain ahead of both
    //    scans (see the ordering note in MatrixKeeperLib.discover), so some of the five
    //    are spoken for before either scan runs.
    //
    //    So the property is stated as an IMPLICATION rather than "the winning slot is
    //    parked": if ANY housekeeping item made it into a capped batch, then EVERY parked
    //    decision must have made it in first. That is precisely what starvation violates,
    //    it does not care how many bounded items came first, and it stays true whatever
    //    the enumerated floor becomes.
    await both((k) => k.setMaxItemsPerUpkeep(40));
    const [, dWide] = await ctx.keeperNew.checkUpkeep("0x");
    const wide = decodeItems(dWide);
    const isParked = (i) => i.workType === WORK.PARKED_RESCUE || i.workType === WORK.EVICT_PARKED;
    const isHouse  = (i) => i.workType === WORK.GHOST || i.workType === WORK.RECLAIM;
    const wideParked = wide.filter(isParked);
    const wideHouse  = wide.filter(isHouse);

    if (wideParked.length === 0 || wideHouse.length === 0) {
      // Nothing to arbitrate — say so out loud rather than passing silently on a fixture
      // that never built the contention this test exists to check.
      console.log(`      (no contention in this fixture: parked=${wideParked.length} housekeeping=${wideHouse.length})`);
      await both((k) => k.setMaxItemsPerUpkeep(40));   // restore the no-truncation pin
      this.skip();
      return;
    }

    for (const cap of [5, 10]) {
      await both((k) => k.setMaxItemsPerUpkeep(cap));
      const [, dCap] = await ctx.keeperNew.checkUpkeep("0x");
      const got = decodeItems(dCap);
      const gotParked = got.filter(isParked).length;
      const gotHouse  = got.filter(isHouse).length;

      expect(got.length, `maxItems=${cap} must cap the batch`).to.be.lte(cap);
      if (gotHouse > 0) {
        expect(gotParked, `maxItems=${cap}: the batch kept ${gotHouse} GHOST/RECLAIM item(s) ` +
          `while only ${gotParked} of ${wideParked.length} parked decisions made it in — ` +
          `${describeItems(got)}. Housekeeping has no deadline; a parked member is on the ` +
          `eviction clock, and a rescue that waits long enough becomes an eviction. This ` +
          `is the starvation defect 6 removed.`).to.equal(wideParked.length);
      }
    }
    await both((k) => k.setMaxItemsPerUpkeep(40));   // restore the no-truncation pin
  });

  it("the parked grace period moves both keepers, and the split windows only ever make V8.50 act SOONER", async function () {
    // _checkParked, the other path item 12a moved. Two claims, and the second one is
    // deliberately weaker than "identical" — because identical is UNREACHABLE here and
    // pretending otherwise is what broke this test.
    //
    // ⛔ WHY IT CANNOT BE AN EQUALITY AT EVERY g. The refactored keeper gates on
    //        age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
    //        age < (isGhost      ? parkedGracePeriod     : evictionGracePeriod)
    //    and MatrixKeeperPrev gates both on parkedGracePeriod alone. Collapsing that
    //    needs selfFundedGracePeriod == evictionGracePeriod == parkedGracePeriod, and the
    //    SETTERS DO NOT ALLOW IT: the self-funded menu tops out at 3600 while the
    //    eviction menu starts at 86400. They intersect at 0 and nowhere else. At g=300,
    //    g=6h or g=30d there is no legal pair of values that reproduces Prev.
    //
    //    The previous version of this test papered over that with
    //        setSelfFundedGracePeriod(g === 0 ? 0 : (g >= 3600 ? 3600 : 300))
    //    under a comment claiming it "pinned" the windows together. A one-hour
    //    self-funded window against a thirty-day loan window is not a pin, it is the
    //    split opened as wide as the setters go. It read green only while no self-funded
    //    parker was older than an hour — and it never restored the value, so every later
    //    test in this shared world inherited the un-collapsed split. That single
    //    expression accounted for six of the eight failures in the V8.50 run; the
    //    rescue-ratio, ladder-preset, frozen-MatB, chain-link and velocity-window cases
    //    were downstream of it, not faults of their own.
    //
    // So: equality where it is reachable, and the real safety property everywhere else.
    for (const g of [0, 300, 6 * 3600, 30 * 86400]) {   // 0 or 5min..30d
      await both((k) => k.setParkedGracePeriod(g));

      const [, dN] = await ctx.keeperNew.checkUpkeep("0x");
      const [, dO] = await ctx.keeperOld.checkUpkeep("0x");
      const iN = decodeItems(dN), iO = decodeItems(dO);

      if (g === 0) {
        // The one value where all three windows CAN be equal — and setup() has already
        // put the two split windows there. Full equivalence must hold.
        expectSameSet(iN, iO, `parkedGracePeriod=${g}`);
        continue;
      }

      // ── THE SAFETY PROPERTY, and it is the same shape as IF-2 ──────────────────
      // Both split windows are 0, i.e. as permissive as they go. Every member Prev
      // queues, V8.50 must queue too, with the SAME verdict: a shorter window can only
      // ever bring work FORWARD, never withhold it and never change what the work is.
      // A member appearing only in the OLD list would mean V8.50 is sitting on a
      // decision the frozen keeper already made — the one direction that is not a
      // trade-off anyone chose.
      const newSet = new Set(asMultiset(iN));
      const missing = asMultiset(iO).filter((x) => !newSet.has(x));
      expect(missing, `parkedGracePeriod=${g}: V8.50 DROPPED work the frozen keeper queued\n` +
        `      new: ${describeItems(iN)}\n` +
        `      old: ${describeItems(iO)}`).to.deep.equal([]);

      // And the extra items, if any, must be exactly the parked decisions the shorter
      // windows unlocked — never a ghost, a reclaim, a chain link or anything structural.
      const oldSet = new Set(asMultiset(iO));
      const extra = iN.filter((i) => !oldSet.has(canon(i)));
      for (const e of extra) {
        expect([WORK.PARKED_RESCUE, WORK.EVICT_PARKED],
          `parkedGracePeriod=${g}: V8.50 queued a ${NAME[e.workType]} the frozen keeper ` +
          `did not, and only the two PARKED verdicts can legitimately differ here — ` +
          `everything else means the extraction diverged`).to.include(e.workType);
      }
    }
    // Restore the world exactly as setup() built it. The old version restored
    // parkedGracePeriod to 6h — which setup() never set — and left the split windows
    // behind entirely.
    await both((k) => k.setParkedGracePeriod(0));
    await ctx.keeperNew.setSelfFundedGracePeriod(0);
    await ctx.keeperNew.setEvictionGracePeriod(0);
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
      expectSameSet(decodeItems(dn), decodeItems(do_), label);
      return decodeItems(dn);
    };
    // Distinct values on purpose: when this test was written BOTH fields defaulted to
    // 6 hours, so a swap between them was a no-op at defaults and proved nothing.
    // (V8.48 item 24 moved frozenMatBTimeout's default to 15 min — the defaults now
    // differ on their own, but the explicit values stay: this test must not depend
    // on what the defaults happen to be.)
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
      expectSameSet(decodeItems(dn), decodeItems(do_), label);
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

  // ── V8.50 item A: the divergence, pinned rather than swept away ────────────────
  it("V8.50 item A: the two keepers diverge ONLY at the insolvency floor, and only for MatB parkers", async function () {
    // THE COMPANION TO THE THIRD PIN IN setup(). That pin is only honest if the thing it
    // neutralises is exactly this and nothing else, and this is the test that says so.
    //
    // It is also a live instrument for the owner's PARAM 59 decision: the sweep below
    // prints, for every value on the DAO menu, how many members the refactored keeper
    // evicts that V8.48 would have rescued. ⚠ READ THE SIZE BEFORE QUOTING IT: this world
    // is MATRIX_SIZE 7, where one journey earns $2.44 (24%) against the structural $3.40
    // (34%) at 127. These members are POORER than any real member and their ask is
    // correspondingly larger. This measures the SHAPE of the cliff, not its live depth —
    // scripts/model_item_a.js on the live population is the number that decides PARAM 59.
    //
    // OWN WORLD, the same idiom the idle sweep uses: the shared ctx has had its batch
    // size, ratio, ladder preset and velocity window moved by the tests above, and the
    // cliff is only legible against the SHIPPING config. Measured on the shared world
    // this sweep reads 0 flips at every value — which looks like good news and is
    // actually the fixture no longer containing the members.
    const c = await freshPopulated();
    expect(Number(await c.matB.getParkedCount()),
      "no MatB parked queue — this test is measuring nothing").to.be.gt(0);

    const sweep = [];
    for (const bps of [0, 1_700, 2_500, 3_400, 5_000, 6_800, 10_000]) {
      await c.sf.setInsolvencyFloorBps(bps);
      const [, dN] = await c.keeperNew.checkUpkeep("0x");
      const [, dO] = await c.keeperOld.checkUpkeep("0x");
      const iN = decodeItems(dN), iO = decodeItems(dO);
      // ⛔ MATCHED BY MEMBER, NOT BY SLOT. This used to walk both arrays by index and
      // call iN[k] vs iO[k] a flip. V8.50 defect 6 reordered discovery, so slot k in one
      // keeper and slot k in the other are no longer the same member — index matching
      // would report every item as flipped and the assertions below would start
      // "passing" on noise. The question was always per-MEMBER anyway: for this parker,
      // did the verdict change?
      const key = (i) => `${i.addr1.toLowerCase()}|${i.addr2.toLowerCase()}`;
      const oldBy = new Map(iO.map((i) => [key(i), i]));
      const flips = [];
      for (const n of iN) {
        const o = oldBy.get(key(n));
        if (o && o.workType !== n.workType) flips.push({ who: n.addr2, o, n });
      }
      // Set-identity, not byte-identity — see the canon() note at the top of the file.
      const sameSet = JSON.stringify(asMultiset(iN)) === JSON.stringify(asMultiset(iO));
      sweep.push({ bps, identical: sameSet, flips });
    }
    await c.sf.setInsolvencyFloorBps(0);   // leave the world as the pin found it

    console.log("      PARAM 59 sweep — members the refactored keeper evicts that V8.48 rescued:");
    for (const r of sweep) console.log(`        insolvencyFloorBps ${String(r.bps).padStart(5)} -> ${r.flips.length} flipped${r.identical ? "  (same work, both keepers)" : ""}`);

    // 1. AT FLOOR 0 THE EXTRACTION STILL HOLDS BYTE-FOR-BYTE, under item A. This is the
    //    claim the whole file exists to make, and item A did not take it away.
    expect(sweep[0].identical,
      "at insolvencyFloorBps 0 the refactored keeper must still queue the SAME SET of work " +
      "as the frozen V8.48 copy — if this fails, item A broke the EXTRACTION and not just " +
      "the economics, and the third pin in setup() is no longer honest. (Set, not bytes: " +
      "V8.50 defect 6 reordered discovery and Prev is frozen at the old order.)").to.equal(true);

    // 2. THE DIVERGENCE IS ONE-DIRECTIONAL AND ONE-SHAPED. Every flip is a member V8.48
    //    would have lent to and item A's keeper evicts — never the reverse. A flip the
    //    other way would mean item A is lending to somebody V8.48 refused, which is not
    //    a trade-off anyone chose.
    const shipping = sweep.find((r) => r.bps === 3_400);
    expect(shipping.flips.length,
      "the shipping floor must actually produce the cliff — a zero here means this test " +
      "has stopped measuring anything").to.be.gt(0);
    for (const f of shipping.flips) {
      expect(f.o.workType, `${f.who}: V8.48 side must be a RESCUE`).to.equal(WORK.PARKED_RESCUE);
      expect(f.n.workType, `${f.who}: V8.50 side must be an EVICT`).to.equal(WORK.EVICT_PARKED);
      expect(f.n.addr1,
        "every flip must be a MatB parker. A MatA flip would mean item A repriced a " +
        "crossing the reserve was supposed to cover, which is the opposite of the item"
      ).to.equal(c.matBAddr);
      expect(await c.matB.crossingReserveOf(f.n.addr2),
        "and the reason is that item A no longer carves this member a reserve — if it is " +
        "non-zero, the cliff has some other cause and this explanation is wrong"
      ).to.equal(0n);
    }

    // 3. THE CLIFF IS THE FLOOR, NOT THE LADDER — so it is bought back with PARAM 59 and
    //    nothing else. Raising the ceiling far enough must restore parity exactly.
    const top = sweep[sweep.length - 1];
    expect(top.identical,
      "at insolvencyFloorBps 10000 the ceiling is a full fee and no advance can exceed " +
      "it, so the two keepers must agree again. If they do not, something OTHER than the " +
      "floor is diverging and the analysis above is incomplete.").to.equal(true);
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
