"use strict";
/**
 * V8_48_GhostFloor.test.js — the items 45 + 46 + 47 package.
 *
 * THE MEASUREMENT THIS ENCODES (diag_ghost_parked.js, live Base Sepolia 2026-08-13):
 *   41 GHOSTS — live parked-queue records whose holders were actually SEATED. 39 of
 *   41 were one shape: parked in a MatB, later seated in the SAME PAIR's MatA (every
 *   MatB rescue destination is the pair's MatA, item 10), because the V8.46
 *   dequeue-on-seat in enterMatrix is matrix-LOCAL. Every copay run burned attempts
 *   on them, reverting "F8V8: already in matrix" forever; the pre-V8.48 evictParked
 *   ALSO reverted on them ("member is in matrix"), so no path could clean them.
 *
 * THE OWNER POLICY (his words, 2026-08-13): "evict them when their fees are maybe
 *   more than the fees they are collecting… they will be evicted and would need to
 *   pay the full fee to get back in. It is not a free ride for ever — the idea is to
 *   help them, but if they are not getting any referrals they would be evicted bcuz
 *   the loan no longer covers their coverage %."
 *
 * WHAT SHIPPED, and what each part of this file pins:
 *   45a PREVENTION  — taking a seat clears the park record in BOTH pair halves
 *                     (GF-P*): kills the 39/41 class at the source.
 *   47  VALVE       — evictParked has two branches (GF-V*): a GHOST is dequeued
 *                     ONLY (funds and seat untouched); a genuinely parked member is
 *                     evicted with their crossing reserve RELEASED to withdrawable
 *                     (involuntary exit — no exitSeat penalty; their SF debt stays
 *                     booked and repays off the top of the next withdrawal).
 *   46  FLOOR       — the SF refuses a new loan once memberDebt >= fee x
 *                     insolvencyFloorBps/10000 (GF-F*), and keeper discovery routes
 *                     floored members to eviction instead of rescue (GF-D*).
 *                     selfRescue is deliberately NOT floored — the floor gates
 *                     LENDING, never a member spending their own money.
 *
 * Fixture notes: the real-pair tests borrow V8_48_RescueRouting's deployPair and its
 * impersonation trick. Ghost construction must BYPASS the prevention it also tests —
 * same problem V8.46's G2 solved with a decoy partner; reused here (no supported path
 * can create a ghost once 45a is in).
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);
const FEE = 10_000_000n;                 // $10
const RESERVE = FEE / 2n;                // CROSSING_RESERVE_BPS = 5000
const WORK_PARKED_RESCUE = 4;
const WORK_EVICT_PARKED = 6;

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

// ─────────────────────────────────────────────────────────────────────────────
// Real-pair fixture (V8_48_RescueRouting's deployPair, size 15)
// ─────────────────────────────────────────────────────────────────────────────
async function deployPair(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter",
      { libraries: { TierRouterLib: trLib.target } })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(usdcAddr, FEE, owner.address);
  const pmAddr = await pm.getAddress();

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8",
    { libraries: { MatrixLogicLib: await matrixLib.getAddress() } });

  const a = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const b = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  await a.setPartner(await b.getAddress());
  await b.setPartner(await a.getAddress());
  for (const m of [a, b]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());

  // a spare, pair-less matrix used as the DECOY partner for ghost construction
  const decoy = await MX.deploy(dp, FEE, size, true, 0, SPLITS, CP_BPS);

  return { usdc, pm, pmAddr, tr, sf, a, b, decoy, owner, W1, sigs,
           aAddr: await a.getAddress(), bAddr: await b.getAddress(),
           decoyAddr: await decoy.getAddress() };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

/** Seat `member` into `dest` the way a cross-matrix flow does: impersonate the
 *  matrix `viaAddr` (which must be dest's current partner), fund the fee, call
 *  _enterMatrix. Returns the receipt. */
async function seatVia(ctx, dest, viaAddr, member) {
  const asMat = await impersonate(viaAddr);
  await ctx.usdc.mint(viaAddr, FEE);
  await ctx.usdc.connect(asMat).approve(await dest.getAddress(), FEE);
  const tx = await dest.connect(asMat)._enterMatrix(member, ethers.ZeroAddress, { gasLimit: 16_000_000 });
  const rc = await tx.wait();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [viaAddr]);
  return rc;
}

/** Drive W1 into MatB: W1 registers, 15 fillers fill MatA (size 15), the 16th entry
 *  rotates the root and W1 crosses to MatB. Asserted, not assumed (item-11 lesson). */
async function driveW1IntoMatB(ctx) {
  await reg(ctx, ctx.W1, ethers.ZeroAddress);
  for (let i = 3; i < 3 + 15; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);
  expect(await ctx.b.isActiveInMatrix(ctx.W1.address),
    "fixture precondition: W1 must have crossed into MatB").to.equal(true);
  expect(await ctx.a.isActiveInMatrix(ctx.W1.address),
    "fixture precondition: W1 must have left MatA").to.equal(false);
}

// Parse with EXPLICIT fragments: whether solc copies a library's events into the
// using contract's artifact ABI is a compiler detail (the first run of this suite
// found GhostDequeued absent while MemberEvicted was present) — pin the topic0s
// here so the assertions cannot depend on it.
const EVT_IFACE = new ethers.Interface([
  "event GhostDequeued(address indexed member, uint256 staleParkedAt)",
  "event EvictionReserveReleased(address indexed member, uint256 amount)",
  "event MemberEvicted(address indexed member, uint256 totalWithdrawn)",
]);
const libEvents = (rc, _iface, name) =>
  rc.logs.map((l) => { try { return EVT_IFACE.parseLog(l); } catch { return null; } })
    .filter(Boolean).filter((e) => e.name === name);

describe("V8.48 items 45+46+47 — ghosts, the insolvency floor, and the eviction valve", function () {
  this.timeout(600_000);

  // ── 45a PREVENTION ─────────────────────────────────────────────────────────
  describe("item 45a — taking a seat clears the park record in BOTH pair halves", function () {
    it("GF-P1: the live 39/41 class is dead — parked in MatB, seated into MatA, MatB record CLEARED", async function () {
      const ctx = await deployPair(15);
      await driveW1IntoMatB(ctx);

      // Park W1 in MatB the way the live chain does at cycle-out shortfall: the
      // keeper's soft-park (owner is matrixKeeper in this fixture). W1 is now
      // parked-in-B, seated nowhere — the exact pre-ghost state.
      await ctx.b.softParkIdle(ctx.W1.address);
      expect(await ctx.b.parkedAt(ctx.W1.address)).to.be.gt(0n);
      expect(await ctx.b.getParkedCount()).to.equal(1n);

      // Seat W1 into MatA via the partner crossing path (impersonated MatB) —
      // the same shape as the rescue/cascade seats that created every live ghost.
      const rc = await seatVia(ctx, ctx.a, ctx.bAddr, ctx.W1.address);

      // THE FIX: MatA's enterMatrix told its partner. Without 45a this record
      // survived forever and copay burned an attempt on it every 10 minutes.
      expect(await ctx.b.parkedAt(ctx.W1.address),
        "origin MatB park record must be cleared by the cross-matrix seat").to.equal(0n);
      expect(await ctx.b.getParkedCount()).to.equal(0n);
      expect(libEvents(rc, ctx.b.interface, "GhostDequeued").length,
        "MatB must emit GhostDequeued for the cleared residue").to.equal(1);
      // And the seat itself is real.
      expect(await ctx.a.isActiveInMatrix(ctx.W1.address)).to.equal(true);
    });

    it("GF-P2: clearParkRecord is partner-only — a stranger cannot dequeue anyone", async function () {
      const ctx = await deployPair(15);
      await reg(ctx, ctx.W1, ethers.ZeroAddress);
      await expect(ctx.a.connect(ctx.owner).clearParkRecord(ctx.W1.address))
        .to.be.revertedWith("F8V8: only partner");
      // The partner may call it, and with no record it is a harmless no-op.
      const asB = await impersonate(ctx.bAddr);
      await ctx.a.connect(asB).clearParkRecord(ctx.W1.address);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.bAddr]);
    });
  });

  // ── 47 VALVE ───────────────────────────────────────────────────────────────
  describe("item 47 — evictParked: ghost = dequeue-only, parked = evict with reserve released", function () {
    it("GF-V1: a GHOST is dequeued ONLY — seat intact, balances untouched, GhostDequeued not MemberEvicted", async function () {
      const ctx = await deployPair(15);
      await driveW1IntoMatB(ctx);
      await ctx.b.softParkIdle(ctx.W1.address);

      // Construct the ghost by BYPASSING prevention (no supported path can create
      // one now): swing MatA's partner to a DECOY for the seat — the V8.46 G2
      // trick — so MatA's partner-clear misses MatB, then restore the pair.
      await ctx.a.setPartner(ctx.decoyAddr);
      await seatVia(ctx, ctx.a, ctx.decoyAddr, ctx.W1.address);
      await ctx.a.setPartner(ctx.bAddr);

      // Ghost precondition, asserted loudly: parked in B AND seated in A.
      expect(await ctx.b.parkedAt(ctx.W1.address), "ghost setup failed: not parked in B").to.be.gt(0n);
      expect(await ctx.a.isActiveInMatrix(ctx.W1.address), "ghost setup failed: not seated in A").to.equal(true);

      const wdBefore = await ctx.b.withdrawableOf(ctx.W1.address);
      const rsBefore = await ctx.b.crossingReserveOf(ctx.W1.address);
      const posBefore = await ctx.a.matrixPos(ctx.W1.address);

      const rc = await (await ctx.b.evictParked(ctx.W1.address)).wait();

      expect(await ctx.b.parkedAt(ctx.W1.address)).to.equal(0n);
      expect(await ctx.b.getParkedCount()).to.equal(0n);
      expect(libEvents(rc, ctx.b.interface, "GhostDequeued").length).to.equal(1);
      expect(libEvents(rc, ctx.b.interface, "MemberEvicted").length,
        "a ghost must NOT be reported as evicted").to.equal(0);
      // Funds and seat untouched — they are a live, earning member.
      expect(await ctx.b.withdrawableOf(ctx.W1.address)).to.equal(wdBefore);
      expect(await ctx.b.crossingReserveOf(ctx.W1.address)).to.equal(rsBefore);
      expect(await ctx.a.matrixPos(ctx.W1.address)).to.equal(posBefore);
      expect(await ctx.a.isActiveInMatrix(ctx.W1.address)).to.equal(true);
    });

    it("GF-V2: the valve stays keeper-gated and idempotent — no new door was opened", async function () {
      const ctx = await deployPair(15);
      await reg(ctx, ctx.W1, ethers.ZeroAddress);
      const P = ctx.sigs[3];
      await reg(ctx, P, ctx.W1.address);
      await ctx.a.softParkIdle(P.address);
      // Only the matrixKeeper may drive the valve (performUpkeep is allowlisted
      // since V8.46 — the two gates together are what closed the public-eviction
      // hole; do not weaken either).
      await expect(ctx.a.connect(P).evictParked(P.address))
        .to.be.revertedWith("F8V8: not keeper");
      await ctx.a.evictParked(P.address);
      // Cleared is cleared — a second call cannot double-release anything.
      await expect(ctx.a.evictParked(P.address))
        .to.be.revertedWith("F8V8: member not parked");
    });

    it("GF-V3: a cycle-out-parked member is EVICTED — dequeued, reserve RELEASED to withdrawable", async function () {
      // The reserve-bearing parked state is the LIVE dominant one (members park at
      // ~84% of fee = 50% reserve INTACT + ~34% earnings). softParkIdle cannot
      // produce it — it releases the reserve at park time by design — so drive the
      // REAL path, which is also the live one: a MatB root whose re-entry cannot
      // be funded parks IN MatB with their reserve intact. (adminForceRotateRoot
      // is a MatB-only tool — the first version of this test aimed it at MatA and
      // the contract said so: "F8V8: only callable on MatB".)
      const ctx = await deployPair(15);
      await driveW1IntoMatB(ctx);
      // W1 in MatB: fresh $5 reserve from the crossing entry, earnings ~pennies —
      // the $10 re-entry MUST fall short. Force the cycle-out.
      await ctx.b.adminForceRotateRoot({ gasLimit: 16_000_000 });

      // Preconditions asserted loudly (item-11 lesson): parked, unseated, reserve intact.
      expect(await ctx.b.parkedAt(ctx.W1.address),
        "precondition: shortfall cycle-out must PARK the root in MatB").to.be.gt(0n);
      expect(await ctx.b.isActiveInMatrix(ctx.W1.address)).to.equal(false);
      const rs = await ctx.b.crossingReserveOf(ctx.W1.address);
      expect(rs, "precondition: cycle-out park must keep the crossing reserve").to.equal(RESERVE);
      const wd = await ctx.b.withdrawableOf(ctx.W1.address);

      const rc = await (await ctx.b.evictParked(ctx.W1.address)).wait();

      expect(await ctx.b.parkedAt(ctx.W1.address)).to.equal(0n);
      expect(libEvents(rc, ctx.b.interface, "MemberEvicted").length).to.equal(1);
      const rel = libEvents(rc, ctx.b.interface, "EvictionReserveReleased");
      expect(rel.length).to.equal(1);
      expect(rel[0].args.amount).to.equal(rs);
      // The owner's rule, in balances: they keep every cent that was theirs —
      // reserve folded into withdrawable — and the POSITION is what they lose.
      expect(await ctx.b.crossingReserveOf(ctx.W1.address)).to.equal(0n);
      expect(await ctx.b.withdrawableOf(ctx.W1.address)).to.equal(wd + rs);
      // Re-entry from here costs the full fee: selfRescue is closed (not parked).
      await expect(ctx.b.connect(ctx.W1).selfRescue()).to.be.revertedWith("F8V8: not parked");
    });
  });

  // ── 46 FLOOR (SF unit) ─────────────────────────────────────────────────────
  describe("item 46 — the SF insolvency floor gates LENDING and nothing else", function () {
    async function sfFixture() {
      const [owner, member] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
      const sf = await (await ethers.getContractFactory("StabilityFund"))
        .deploy(await usdc.getAddress(), owner.address);
      const mock = await (await ethers.getContractFactory("MockRescueMatrix"))
        .deploy(await sf.getAddress(), await usdc.getAddress());
      await sf.setMatrixAuthorized(await mock.getAddress(), true);
      await sf.setTierFee(0, FEE); // $10 → default ceiling = $10 x 3400/10000 = $3.40
      // Seed the fund so "SF: below floor" can never shadow the floor check.
      await usdc.mint(owner.address, M6(1000));
      await usdc.approve(await sf.getAddress(), M6(1000));
      await sf.receiveLayer(0, M6(1000), 5);
      return { owner, member, usdc, sf, mock };
    }

    it("GF-F1: the boundary is debt >= fee x floorBps/10000, and the revert names the floor", async function () {
      const { member, sf, mock } = await sfFixture();
      expect(await sf.insolvencyFloorBps(), "declared default").to.equal(3400n);

      // One unit under the ceiling: still eligible, loan flows.
      await mock.bookLoan(member.address, 0, M6(3.4) - 1n);
      expect(await sf.loanEligible(member.address, 0)).to.equal(true);
      await mock.pullCoRescue(member.address, 0, M6(1));

      // Cross the line: lending stops, with a reason a keeper log can grep.
      await mock.bookLoan(member.address, 0, 1n);
      expect(await sf.loanEligible(member.address, 0)).to.equal(false);
      await expect(mock.pullCoRescue(member.address, 0, M6(1)))
        .to.be.revertedWith("SF: insolvency floor");
    });

    it("GF-F2: 0 disables the floor (the on-menu escape hatch), and an unregistered tier cannot floor anyone", async function () {
      const { owner, member, sf, mock } = await sfFixture();
      await mock.bookLoan(member.address, 0, M6(9)); // way past any ceiling
      expect(await sf.loanEligible(member.address, 0)).to.equal(false);
      await sf.connect(owner).setInsolvencyFloorBps(0);
      expect(await sf.loanEligible(member.address, 0),
        "floor disabled must restore eligibility — the DAO's escape hatch").to.equal(true);
      // A tier with no registered fee has no basis for an estimate: eligible.
      await sf.connect(owner).setInsolvencyFloorBps(3400);
      expect(await sf.loanEligible(member.address, 7)).to.equal(true);
    });

    it("GF-F3: setter is owner/governance-gated and bounded", async function () {
      const { member, sf } = await sfFixture();
      await expect(sf.connect(member).setInsolvencyFloorBps(5000))
        .to.be.revertedWith("SF: not authorized");
      await expect(sf.setInsolvencyFloorBps(10_001))
        .to.be.revertedWith("SF: floor bps > 100%");
    });

    it("GF-F4: selfRescue is NOT floored — a member spending their own money is never refused", async function () {
      // The floor lives in the SF's lending functions. selfRescue never touches
      // the SF, so a floored member can ALWAYS pay their own shortfall and
      // re-enter — eviction is for those who cannot. Owner policy depends on
      // this distinction; pin it end-to-end on a real pair.
      const ctx = await deployPair(15);
      await reg(ctx, ctx.W1, ethers.ZeroAddress);
      const P = ctx.sigs[3];
      await reg(ctx, P, ctx.W1.address);
      await ctx.a.softParkIdle(P.address);

      // Floor P hard on the SF ledger via an authorized matrix (impersonated MatA).
      const asA = await impersonate(ctx.aAddr);
      await ctx.sf.connect(asA).increaseMemberDebt(P.address, 0, M6(9));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.aAddr]);
      await ctx.sf.setTierFee(0, FEE);
      expect(await ctx.sf.loanEligible(P.address, 0)).to.equal(false);

      // P self-funds the shortfall from their wallet and re-enters regardless.
      const need = FEE; // more than enough for any shortfall
      await ctx.usdc.mint(P.address, need);
      await ctx.usdc.connect(P).approve(ctx.aAddr, need);
      await ctx.a.connect(P).selfRescue({ gasLimit: 16_000_000 });
      expect(await ctx.a.parkedAt(P.address), "self-rescue must still work floored").to.equal(0n);
    });
  });

  // ── 46/45 DISCOVERY ROUTING (mock world, the SplitGrace harness) ───────────
  describe("keeper discovery — floored and ghost members route to the valve, not the lender", function () {
    let keeper, matA, matB, sfMock, alice;
    const PARKED_GRACE = 24 * 3600;

    function decode(performData) {
      if (!performData || performData === "0x") return [];
      const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], performData);
      return items.map((i) => ({ workType: Number(i.workType), addr2: i.addr2 }));
    }
    async function workFor(who) {
      const [, data] = await keeper.checkUpkeep("0x");
      return decode(data).filter((i) => i.addr2 === who).map((i) => i.workType);
    }

    async function setup() {
      const sigs = await ethers.getSigners();
      alice = sigs[1];
      const tr = await (await ethers.getContractFactory("MockTierRouterK")).deploy();
      sfMock = await (await ethers.getContractFactory("MockStabilityFundK")).deploy(M6(10_000));
      await sfMock.setTier(0, M6(10_000));
      const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
      keeper = await (await ethers.getContractFactory("MatrixKeeper", {
        libraries: { MatrixKeeperLib: await lib.getAddress() },
      })).deploy(await tr.getAddress(), await sfMock.getAddress());
      matA = await (await ethers.getContractFactory("MockMatrixK")).deploy(M6(10), true);
      matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(M6(10), true);
      const pm = await (await ethers.getContractFactory("MockPairManagerK")).deploy();
      await pm.addPair(await matA.getAddress(), await matB.getAddress());
      await keeper.setPairManager(0, await pm.getAddress());
      await keeper.setParkedGracePeriod(PARKED_GRACE);
      await time.increase(10);
    }
    const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

    it("GF-D1: a FLOORED member who needs a loan routes to EVICT; the same member un-floored routes to RESCUE", async function () {
      await setup();
      // Needs a loan: $2 + $5 reserve against a $10 fee.
      await matA.addParked(alice.address, await now(), M6(2), M6(5), 0);
      await sfMock.setFloored(alice.address, true);
      await time.increase(PARKED_GRACE + 5);
      expect(await workFor(alice.address)).to.deep.equal([WORK_EVICT_PARKED]);
      // The control: identical member, floor lifted → the lender takes them back.
      await sfMock.setFloored(alice.address, false);
      expect(await workFor(alice.address)).to.deep.equal([WORK_PARKED_RESCUE]);
    });

    it("GF-D2: a floored but SELF-FUNDED member still routes to RESCUE — the floor gates loans only", async function () {
      await setup();
      await matA.addParked(alice.address, await now(), M6(5.5), M6(5), 0); // covers the fee
      await sfMock.setFloored(alice.address, true);
      await time.increase(PARKED_GRACE + 5);
      expect(await workFor(alice.address),
        "sfShare is 0 — no loan is being asked for, so the floor must not fire").to.deep.equal([WORK_PARKED_RESCUE]);
    });

    it("GF-D3: a GHOST routes to EVICT (the valve dequeues) — seated here or in the partner half", async function () {
      await setup();
      await matA.addParked(alice.address, await now(), M6(2), M6(5), 0);
      await matA.setSeated(alice.address, true); // seated in the SAME matrix
      await time.increase(PARKED_GRACE + 5);
      expect(await workFor(alice.address)).to.deep.equal([WORK_EVICT_PARKED]);

      // Partner-half ghost: unseat here, seat them in the partner instead.
      await matA.setSeated(alice.address, false);
      await matA.setPartner(await matB.getAddress());
      await matB.setSeated(alice.address, true);
      expect(await workFor(alice.address)).to.deep.equal([WORK_EVICT_PARKED]);
      // Control: no seat anywhere → back to rescue.
      await matB.setSeated(alice.address, false);
      expect(await workFor(alice.address)).to.deep.equal([WORK_PARKED_RESCUE]);
    });
  });

  // ── GOVERNANCE MENU (the item-42/43 discipline) ────────────────────────────
  describe("PARAM_SF_INSOLVENCY_FLOOR — the default sits on its own menu", function () {
    it("GF-G1: param 59 menu carries the declared default AND 0, and PARAM_MAX_ID moved", async function () {
      const [owner] = await ethers.getSigners();
      const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
      // Constructor is (cnovaToken, tierRouter, matrixKeeper); the two routing
      // targets only need to be non-zero for a menu read.
      const gov = await (await ethers.getContractFactory("V8Governance"))
        .deploy(await cnova.getAddress(), owner.address, owner.address);
      expect(await gov.PARAM_SF_INSOLVENCY_FLOOR()).to.equal(59);
      // NOT equal(59): MAX_ID moves every time a param is added (param 60 arrived
      // the same day and broke the first version of this line — a change detector
      // that explains nothing, the exact item-42 anti-pattern). The invariant that
      // matters: the id is assigned and MAX_ID covers it.
      expect(await gov.PARAM_MAX_ID()).to.be.gte(59);
      const menu = (await gov.getAllowedValues(59)).map(Number);
      // The declared default must be votable-back-to, and 0 is the escape hatch —
      // a value absent from the menu can never be voted back (item-42 lesson).
      const usdcOwner = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
      const sf = await (await ethers.getContractFactory("StabilityFund"))
        .deploy(await usdcOwner.getAddress(), owner.address);
      expect(menu).to.include(Number(await sf.insolvencyFloorBps()));
      expect(menu).to.include(0);
    });
  });
});
