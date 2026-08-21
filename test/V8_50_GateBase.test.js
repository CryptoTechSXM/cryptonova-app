"use strict";
/**
 * V8_50_GateBase.test.js — THE SPONSORSHIP GATE, session 19 (2026-08-21).
 *
 * WHAT SHIPS
 *   TierRouter.directCount (a counter, incremented once per join in _bookkeepJoin) and
 *   StabilityFund.baseAdvanceBps (a LOWER CEILING applied inside loanHeadroom to members
 *   whose directCount is 0). Handoff sections 17.1, 18.4-18.18 and 19.0-19.6 are the
 *   measured basis; this file is the pin.
 *
 * ⛔ THE THING THIS FILE EXISTS TO STOP SOMEONE "FIXING"
 *   It is a CEILING, not a first advance. The advance SIZE comes from the member's
 *   shortfall, loanEligibleFor is a boolean on the WHOLE advance, and there is no
 *   partial-funding path — so a zero-direct member who needs more than the base gets
 *   NOTHING, and _triageParked routes that to eviction. Handoff 18.8 corrected three
 *   earlier sections that described it as "a small first advance"; GB-9 fails if anyone
 *   reintroduces that reading as code.
 *
 * ⛔ AND THE TWO PROPERTIES THAT MAKE IT SAFE TO SHIP
 *   GB-4  the gate can only ever LOWER headroom, never raise it — asserted over a grid,
 *         not at a point, because the failure it guards is a rearrangement error that one
 *         example would miss. Same reasoning as V8_49_InsolvencyFloor's IF-2.
 *   GB-5  it FAILS OPEN. If tierRouter is miswired or is an older build with no
 *         directCount, the ordinary floor stays in force. loanHeadroom reverting would
 *         take a whole keeper batch with it (the reason IF-8 exists next door), so a gate
 *         that cannot read its counter must refuse nobody.
 *
 * ⚠ WHAT THIS FILE DOES NOT COVER, STATED SO NOBODY READS IT AS COVERED
 *   The COUPON join path (registerWithCoupon) is not exercised here — it needs a
 *   CouponRegistry rig. It is covered BY CONSTRUCTION: V8.44's size diet funnelled both
 *   join paths through _bookkeepJoin, which is the only place memberReferrer is assigned,
 *   and both callers revert on globalJoined[msg.sender] first. If anyone ever splits that
 *   function, PART B goes stale silently — so the split is the thing to watch for.
 */
const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const M6   = (n) => ethers.parseUnits(n.toString(), 6);
const FEE  = M6(10);                 // T1

// DERIVED, never pinned — the same anti-pattern warning V8_49_InsolvencyFloor carries.
// The invariant is "the ceiling is the fee times the declared default"; assert the
// declared defaults separately (GB-1) and let the arithmetic follow them.
const FLOOR_BPS_DEFAULT = 5_000n;    // StabilityFund.insolvencyFloorBps
const BASE_BPS_DEFAULT  = 10_000n;   // StabilityFund.baseAdvanceBps — SHIPS INERT, see GB-1
const BASE_BPS_POLICY   = 3_000n;    // the value the runbook applies after migration (18.18 / 19.0)

const ceilAt = (bps) => FEE * bps / 10_000n;

describe("V8.50 — the sponsorship gate (directCount + baseAdvanceBps)", function () {
  this.timeout(600_000);

  // ══ PART A — the dial and the gate, on the real StabilityFund ═══════════════
  describe("PART A — StabilityFund.loanHeadroom", function () {

    async function gateFixture() {
      const [owner, member, sponsored, gov] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
      const sf   = await (await ethers.getContractFactory("StabilityFund"))
        .deploy(await usdc.getAddress(), owner.address);
      const mock = await (await ethers.getContractFactory("MockRescueMatrix"))
        .deploy(await sf.getAddress(), await usdc.getAddress());

      // MockDirectRouter lives in contracts/test/GateProbe.sol — session 17 built it to
      // price the read without a matrix world, and it is the right double here too:
      // same storage shape (one uint32 mapping slot), same call shape.
      const router = await (await ethers.getContractFactory("MockDirectRouter")).deploy();

      await sf.setMatrixAuthorized(await mock.getAddress(), true);
      await sf.setTierFee(0, FEE);
      await sf.setMatrixKeeper(owner.address);
      await sf.setTierRouter(await router.getAddress());

      // Seed generously so "SF: below floor" can never shadow a gate refusal — two
      // different failures, and a test that cannot tell them apart is testing neither.
      await usdc.mint(owner.address, M6(1000));
      await usdc.approve(await sf.getAddress(), M6(1000));
      await sf.receiveLayer(0, M6(1000), 5);

      // `member` has sponsored nobody; `sponsored` has one direct.
      await router.setDirects(sponsored.address, 1);
      return { owner, member, sponsored, gov, usdc, sf, mock, router };
    }

    it("GB-1: SHIPS INERT — baseAdvanceBps defaults to 10000 and changes no headroom", async function () {
      const { member, sponsored, sf, router } = await gateFixture();

      expect(await sf.baseAdvanceBps(), "declared default").to.equal(BASE_BPS_DEFAULT);
      expect(await sf.insolvencyFloorBps(), "declared default").to.equal(FLOOR_BPS_DEFAULT);
      expect(await router.directCount(member.address), "the subject has no directs").to.equal(0n);

      // The whole point of the default: a member with zero directs is treated exactly
      // like one with a sponsor, because directCount does not backfill and on migration
      // day EVERY member reads 0. See the deploy note on baseAdvanceBps.
      expect(await sf.loanHeadroom(member.address, 0)).to.equal(ceilAt(FLOOR_BPS_DEFAULT));
      expect(await sf.loanHeadroom(sponsored.address, 0)).to.equal(ceilAt(FLOOR_BPS_DEFAULT));
    });

    it("GB-2: the dial is settable by owner and governance, capped at 100%, and emits", async function () {
      const { owner, member, sf, gov } = await gateFixture();

      await expect(sf.setBaseAdvanceBps(BASE_BPS_POLICY))
        .to.emit(sf, "BaseAdvanceBpsSet").withArgs(BASE_BPS_POLICY);
      expect(await sf.baseAdvanceBps()).to.equal(BASE_BPS_POLICY);

      await expect(sf.setBaseAdvanceBps(10_001n)).to.be.revertedWith("SF: base bps > 100%");
      await expect(sf.connect(member).setBaseAdvanceBps(1_000n)).to.be.revertedWith("SF: not authorized");

      // 19.6: the value MUST be movable without a redeploy, because the only measurement
      // that could still change it needs live V8.50 and weeks of accrual.
      await sf.setGovernance(gov.address);
      await expect(sf.connect(gov).setBaseAdvanceBps(3_500n))
        .to.emit(sf, "BaseAdvanceBpsSet").withArgs(3_500n);
      expect(await sf.baseAdvanceBps()).to.equal(3_500n);
    });

    it("GB-3: at base 3000 a zero-direct member is capped at $3.00 and a sponsor at $5.00", async function () {
      const { member, sponsored, sf } = await gateFixture();
      await sf.setBaseAdvanceBps(BASE_BPS_POLICY);

      expect(await sf.loanHeadroom(member.address, 0),
        "sponsored nobody — the base ceiling applies").to.equal(ceilAt(BASE_BPS_POLICY));
      expect(await sf.loanHeadroom(sponsored.address, 0),
        "ONE direct is enough — the gate does not touch them at any base").to.equal(ceilAt(FLOOR_BPS_DEFAULT));
    });

    it("GB-4: THE SAFETY PROPERTY — the gate only ever lowers headroom, never raises it", async function () {
      const { member, sponsored, sf, mock } = await gateFixture();

      // A grid, not a point. Debt is booked cumulatively; headroom must fall monotonically
      // as the base falls, and must never exceed the ungated value at any (debt, base).
      const bases = [10_000n, 5_000n, 4_999n, 3_500n, 3_000n, 1_500n, 0n];
      const debts = [0, 0.5, 1, 2.99, 3, 3.01, 6].map(M6);

      let booked = 0n;
      for (const d of debts) {
        if (d > booked) { await mock.bookLoan(member.address, 0, d - booked); booked = d; }

        await sf.setBaseAdvanceBps(10_000n);
        const ungated = await sf.loanHeadroom(member.address, 0);

        let prev = ungated;
        for (const b of bases) {
          await sf.setBaseAdvanceBps(b);
          const got = await sf.loanHeadroom(member.address, 0);
          expect(got, `base ${b} at debt ${d}: gate must never lend where the plain floor refused`)
            .to.be.lte(ungated);
          expect(got, `base ${b} at debt ${d}: headroom must fall monotonically with the base`)
            .to.be.lte(prev);
          prev = got;
        }

        // And the member WITH a direct is untouched at every base in the grid — this is
        // 18.4's framing correction as an assertion: the gate has exactly one column.
        for (const b of bases) {
          await sf.setBaseAdvanceBps(b);
          expect(await sf.loanHeadroom(sponsored.address, 0),
            `base ${b}: a member with a sponsor is never gated`).to.equal(ceilAt(FLOOR_BPS_DEFAULT));
        }
      }
    });

    it("GB-5: FAILS OPEN — a router with no directCount leaves the ordinary floor in force", async function () {
      const { member, sf } = await gateFixture();
      await sf.setBaseAdvanceBps(BASE_BPS_POLICY);

      // RevertingTierRouter is a real contract that does NOT implement directCount, which
      // is exactly the miswiring case: the SF pointed at an older build. The call reverts,
      // the catch swallows it, and lending continues under the plain floor.
      const stale = await (await ethers.getContractFactory("RevertingTierRouter")).deploy();
      await sf.setTierRouter(await stale.getAddress());

      await expect(sf.loanHeadroom(member.address, 0), "must not revert — a reverting view here kills a keeper batch")
        .to.not.be.reverted;
      expect(await sf.loanHeadroom(member.address, 0),
        "unreadable counter must refuse nobody").to.equal(ceilAt(FLOOR_BPS_DEFAULT));
      expect(await sf.loanEligibleFor(member.address, 0, ceilAt(FLOOR_BPS_DEFAULT))).to.equal(true);
    });

    it("GB-6: the inert boundary is base >= floor — one bp either side of it", async function () {
      const { member, sf } = await gateFixture();

      await sf.setBaseAdvanceBps(FLOOR_BPS_DEFAULT);
      expect(await sf.loanHeadroom(member.address, 0),
        "base == floor: inert, and the router is not read at all").to.equal(ceilAt(FLOOR_BPS_DEFAULT));

      await sf.setBaseAdvanceBps(FLOOR_BPS_DEFAULT - 1n);
      expect(await sf.loanHeadroom(member.address, 0),
        "one bp below the floor: it binds").to.equal(ceilAt(FLOOR_BPS_DEFAULT - 1n));
    });

    it("GB-7: the three views still share one primitive under the gate", async function () {
      const { member, sf } = await gateFixture();
      await sf.setBaseAdvanceBps(BASE_BPS_POLICY);

      const room = await sf.loanHeadroom(member.address, 0);
      expect(await sf.loanEligibleFor(member.address, 0, room), "exactly at the ceiling passes").to.equal(true);
      expect(await sf.loanEligibleFor(member.address, 0, room + 1n), "one wei over is refused").to.equal(false);
      expect(await sf.loanEligible(member.address, 0)).to.equal(room > 0n);
    });

    it("GB-9: a refused member gets NOTHING, not a smaller advance — 18.8 as a test", async function () {
      const { member, sf, mock } = await gateFixture();
      await sf.setBaseAdvanceBps(BASE_BPS_POLICY);

      // The near-miss shape 18.16 measured: needs $4.42, base is $3.00. There is no
      // partial-funding path, so the answer is a refusal of the WHOLE advance — and the
      // lender must revert rather than quietly lend $3.00.
      const ask = M6(4.42);
      expect(await sf.loanEligibleFor(member.address, 0, ask)).to.equal(false);
      await expect(mock.pullCoRescue(member.address, 0, ask)).to.be.revertedWith("SF: insolvency floor");
      expect(await sf.memberDebt(member.address), "nothing was lent").to.equal(0n);
    });
  });

  // ══ PART B — the counter, through the real TierRouter ═══════════════════════
  describe("PART B — TierRouter.directCount", function () {

    const T1_FEE = M6(10);
    const T2_FEE = M6(25);
    const MSIZE  = 15n;
    const SPLITS = { l1Bps: 950, chainBps: 950, poolBps: 1568, treasuryBps: 713,
                     stabilityBps: 238, devBps: 143, opsBps: 95, communityBps: 48,
                     buybackBps: 45, liquidityBps: 0 };          // sum = 4750
    const CHAIN_BPS = [475n, 190n, 143n, 71n, 36n, 35n];         // sum = 950

    // Same rig as Msize15.test.js — the smallest fixture in the suite that produces a
    // real TierRouter you can register through. Trimmed to one tier pair.
    async function routerFixture() {
      const s = await ethers.getSigners();
      const [deployer, devOps, accountOne, admin, w1] = s;
      const wallets = s.slice(5, 12);

      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
      const usdcAddr = await usdc.getAddress();
      const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
      const cnovaAddr = await cnova.getAddress();
      const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
        .deploy(cnovaAddr, usdcAddr, admin.address);
      const treasuryAddr = await treasury.getAddress();

      const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
      const tierRouter = await (await ethers.getContractFactory("TierRouter",
        { libraries: { TierRouterLib: trLib.target } })).deploy(usdcAddr, admin.address);
      const trAddr = await tierRouter.getAddress();

      const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
      await matrixLib.waitForDeployment();
      const FM = await ethers.getContractFactory("FigureEightMatrixV8",
        { libraries: { MatrixLogicLib: await matrixLib.getAddress() } });

      const dp = { usdc: usdcAddr, cnova: cnovaAddr, treasury: treasuryAddr,
                   devWallet: devOps.address, opsWallet: devOps.address,
                   accountOne: accountOne.address, admin: admin.address };
      const matA = await FM.deploy(dp, T1_FEE, MSIZE, true,  0, SPLITS, CHAIN_BPS);
      const matB = await FM.deploy(dp, T1_FEE, MSIZE, false, 0, SPLITS, CHAIN_BPS);
      const matAAddr = await matA.getAddress(), matBAddr = await matB.getAddress();

      const pm1 = await (await ethers.getContractFactory("PairManagerV8"))
        .deploy(usdcAddr, T1_FEE, admin.address);
      const pm1Addr = await pm1.getAddress();

      await matA.connect(admin).setPartner(matBAddr);
      await matB.connect(admin).setPartner(matAAddr);
      await matA.connect(admin).setPairManager(pm1Addr);
      await matB.connect(admin).setPairManager(pm1Addr);
      await pm1.connect(admin).addPair(matAAddr, matBAddr);
      await pm1.connect(admin).setTierRouter(trAddr);

      await tierRouter.connect(admin).registerTier(0, pm1Addr, T1_FEE);
      await tierRouter.connect(admin).registerMatrix(matBAddr, 0);

      for (const a of [matAAddr, matBAddr]) await treasury.connect(admin).setAuthorizedCaller(a, true);
      await treasury.connect(admin).setTier1Matrix(matAAddr);
      await treasury.connect(admin).setMemberTracker(pm1Addr);
      const MINTER_ROLE = await cnova.MINTER_ROLE();
      for (const m of [matA, matB]) await cnova.connect(admin).grantRole(MINTER_ROLE, await m.getAddress());

      for (const sg of [w1, ...wallets]) await usdc.mint(sg.address, T1_FEE * 100n);

      const reg = async (signer, referrer) => {
        await usdc.connect(signer).approve(pm1Addr, T1_FEE);
        return tierRouter.connect(signer).register(referrer != null ? referrer : ethers.ZeroAddress);
      };
      return { tierRouter, w1, wallets, reg };
    }

    it("GB-10: register credits the referrer by exactly one and the newcomer by none", async function () {
      const { tierRouter, w1, wallets, reg } = await loadFixture(routerFixture);

      await reg(w1, null);
      expect(await tierRouter.directCount(w1.address), "nobody has joined under W1 yet").to.equal(0n);

      await reg(wallets[0], w1.address);
      expect(await tierRouter.directCount(w1.address)).to.equal(1n);
      expect(await tierRouter.directCount(wallets[0].address), "the newcomer sponsored nobody").to.equal(0n);

      await reg(wallets[1], w1.address);
      await reg(wallets[2], wallets[0].address);
      expect(await tierRouter.directCount(w1.address), "two directs").to.equal(2n);
      expect(await tierRouter.directCount(wallets[0].address), "credit goes to the actual sponsor").to.equal(1n);
      expect(await tierRouter.directCount(wallets[1].address)).to.equal(0n);
    });

    it("GB-11: an unresolvable referrer credits NOBODY — address(0) is never incremented", async function () {
      const { tierRouter, w1, wallets, reg } = await loadFixture(routerFixture);

      // W1 registers with no referrer, and no defaultReferrer is wired in this rig, so
      // _resolveRef collapses to address(0). The guard in _bookkeepJoin is what stops
      // address(0) accumulating a phantom downline that the gate would then read.
      await reg(w1, null);
      expect(await tierRouter.directCount(ethers.ZeroAddress)).to.equal(0n);

      // Referring to someone who has not joined resolves to address(0) too.
      await reg(wallets[0], wallets[6].address);
      expect(await tierRouter.directCount(ethers.ZeroAddress), "still nobody").to.equal(0n);
      expect(await tierRouter.directCount(wallets[6].address), "a non-member cannot be credited").to.equal(0n);
    });

    it("GB-12: the counter cannot be inflated by re-registering — one join, one credit", async function () {
      const { tierRouter, w1, wallets, reg } = await loadFixture(routerFixture);

      await reg(w1, null);
      await reg(wallets[0], w1.address);
      expect(await tierRouter.directCount(w1.address)).to.equal(1n);

      // globalJoined[msg.sender] is checked before _bookkeepJoin on BOTH join paths, so a
      // second registration cannot run the increment again.
      await expect(reg(wallets[0], w1.address)).to.be.reverted;
      expect(await tierRouter.directCount(w1.address), "unchanged").to.equal(1n);
    });
  });
});
