"use strict";
/**
 * V8_49_InsolvencyFloor.test.js — item 1b, POLICY B: the floor includes the loan.
 *
 * WHAT WAS WRONG
 *   StabilityFund.loanEligible tested `memberDebt < ceiling` BEFORE the advance and
 *   never added the advance itself. So the floor capped the debt a member could START
 *   a loan from, not the debt they ended with, and every borrower finished above the
 *   ceiling by up to a full advance. The contract's own doc comment described the
 *   intent ("refuses a new loan when memberDebt >= fee x this / 10000"); the code did
 *   not implement it.
 *
 * WHAT SHIPS
 *   `memberDebt[member] + advance <= fee * insolvencyFloorBps / 10_000`, enforced at
 *   BOTH SF entry points (payCoRescue :679, payForceCross :649) and asked with the
 *   SAME NUMBER by keeper discovery (MatrixKeeperLib._triageParked) in the same commit.
 *
 * WHY DISCOVERY AND THE LENDER MUST AGREE ON THE AMOUNT, NOT JUST THE VERDICT
 *   "SF: insolvency floor" reverting inside performUpkeep does not skip one member —
 *   it takes the WHOLE BATCH: velocity, chain-links, evictions, the CW epoch. V8.48
 *   asked the two sides different questions (discovery: "any room left?"; lender:
 *   "room for THIS advance?"), which is a disagreement waiting for the right member.
 *   IF-8 is the test that fails if anyone ever "simplifies" discovery back to asking
 *   about sfShare alone — and it fails for the right reason, because crossingBufferBps
 *   is a DAO param now (61) and a vote can change the amount without touching code.
 *
 * MEASURED BEFORE BUILDING (2026-08-16, diag_loan_history.js, 104 parked, scan
 * self-tested against totalRescueLoaned to the cent):
 *   - 15 members would be refused by this rule. ALL 15 are repeat borrowers.
 *   - ZERO would be refused on a first loan. The earlier "4 never borrowed" reading
 *     was wrong: memberDebt is CURRENT OUTSTANDING, so 9 of them had borrowed and
 *     repaid in full and read $0.00, indistinguishable from never having borrowed.
 *     The event log was the only way to tell. Owner caught the claim; the snapshot
 *     could not support it.
 *   - Each of the 15 had borrowed once, repaid $3.40-$4.04, earned $2.32-$3.82
 *     lifetime, never withdrawn a cent, and came back needing $3.77-$5.00 — needing
 *     more per cycle than they earn per cycle, which is verbatim the condition this
 *     floor exists to stop.
 *   - Owner decision, same day: STRICT B. One rule, first loan or not.
 *
 * THE SAFETY ARGUMENT, AND WHERE IT IS PINNED
 *   B is STRICTLY TIGHTER than V8.48 at every point — it can never lend where the old
 *   code refused, because every advance is > 0. That is the entire reason this is
 *   shippable without a migration. IF-2 is that proof, as a property over a grid, not
 *   as one example.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const M6  = (n) => ethers.parseUnits(n.toString(), 6);
const FEE = M6(10);                       // T1
const CEIL = M6(3.4);                     // FEE x 3400bps — the declared default floor

const WORK_PARKED_RESCUE = 4;
const WORK_EVICT_PARKED  = 6;
const PARKED_GRACE = 24 * 3600;
const EVICT_GRACE  = 7 * 24 * 3600;

describe("V8.49 item 1b — policy B: the insolvency floor includes the loan being asked for", function () {
  this.timeout(600_000);

  // ══ PART 1 — the lender, on the real StabilityFund ══════════════════════════
  describe("the lender", function () {
    async function sfFixture() {
      const [owner, member] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
      const sf   = await (await ethers.getContractFactory("StabilityFund"))
        .deploy(await usdc.getAddress(), owner.address);
      const mock = await (await ethers.getContractFactory("MockRescueMatrix"))
        .deploy(await sf.getAddress(), await usdc.getAddress());
      await sf.setMatrixAuthorized(await mock.getAddress(), true);
      await sf.setTierFee(0, FEE);
      // owner doubles as the keeper so payForceCross is reachable without a keeper rig.
      await sf.setMatrixKeeper(owner.address);
      // Seed generously so "SF: below floor" can never shadow the floor check — the
      // two reverts are different failures and a test that cannot tell them apart is
      // testing neither.
      await usdc.mint(owner.address, M6(1000));
      await usdc.approve(await sf.getAddress(), M6(1000));
      await sf.receiveLayer(0, M6(1000), 5);
      return { owner, member, usdc, sf, mock };
    }

    it("IF-1: the boundary is debt + advance <= ceiling — exactly at it passes, one wei over is refused", async function () {
      const { member, sf, mock } = await sfFixture();
      expect(await sf.insolvencyFloorBps(), "declared default").to.equal(3400n);

      // Zero debt, and an advance that lands EXACTLY on the ceiling. Under V8.48 this
      // was never the question — any advance was allowed as long as prior debt was
      // under the line, which is how a $5.20 loan sat on a $3.40 ceiling.
      expect(await sf.loanEligibleFor(member.address, 0, CEIL)).to.equal(true);
      await mock.pullCoRescue(member.address, 0, CEIL);
      expect(await sf.memberDebt(member.address), "pullCoRescue moves money; the ledger is booked separately").to.equal(0n);

      // Now book that debt for real and ask again. The ceiling is full.
      await mock.bookLoan(member.address, 0, CEIL);
      expect(await sf.loanEligibleFor(member.address, 0, 1n),
        "a member exactly at the ceiling has room for nothing, not even one wei").to.equal(false);
      await expect(mock.pullCoRescue(member.address, 0, 1n))
        .to.be.revertedWith("SF: insolvency floor");
    });

    it("IF-2: THE SAFETY PROPERTY — B is strictly tighter than V8.48 everywhere, never looser", async function () {
      // This is why policy B can ship without a migration or a grandfather clause: it
      // cannot lend anywhere the old rule refused. Asserted as a property over a grid
      // rather than at one point, because the failure this guards against is a sign
      // error or an off-by-one in the rearrangement, which one example would miss.
      const { member, sf, mock } = await sfFixture();
      const debts    = [0, 0.5, 1, 3.39, 3.4, 3.41, 9].map(M6);
      const advances = [1n, M6(0.01), M6(1), M6(3.4), M6(6)];

      let booked = 0n;
      for (const d of debts) {
        if (d > booked) { await mock.bookLoan(member.address, 0, d - booked); booked = d; }
        const oldRule = await sf.loanEligible(member.address, 0);      // memberDebt < ceiling
        for (const a of advances) {
          const newRule = await sf.loanEligibleFor(member.address, 0, a);
          if (newRule) {
            expect(oldRule,
              `debt ${d} advance ${a}: policy B allowed a loan V8.48 refused — B must be STRICTLY TIGHTER`
            ).to.equal(true);
          }
        }
      }
      // ...and it is genuinely tighter somewhere, or the property above is vacuous.
      // (The vacuous-pass trap: a test that only checks an implication passes when the
      // antecedent is never true.)
      expect(await sf.loanEligible(member.address, 0), "debt $9 is over the ceiling either way").to.equal(false);
    });

    it("IF-3: loanHeadroom is the number a member can act on, and it predicts the boundary exactly", async function () {
      const { member, sf, mock } = await sfFixture();
      expect(await sf.loanHeadroom(member.address, 0), "fresh member: the whole ceiling").to.equal(CEIL);

      await mock.bookLoan(member.address, 0, M6(1));
      const room = await sf.loanHeadroom(member.address, 0);
      expect(room, "$3.40 ceiling less $1.00 owed").to.equal(M6(2.4));

      // The headroom IS the boundary — not an approximation of it. The dashboard shows
      // this figure, so if it were off by anything the member would be told a number
      // the contract then refuses (the $10-lock mistake, again).
      expect(await sf.loanEligibleFor(member.address, 0, room)).to.equal(true);
      expect(await sf.loanEligibleFor(member.address, 0, room + 1n)).to.equal(false);
      await mock.pullCoRescue(member.address, 0, room);              // succeeds
      await mock.bookLoan(member.address, 0, room);                  // book it
      expect(await sf.loanHeadroom(member.address, 0), "ceiling now full").to.equal(0n);
    });

    it("IF-4: the escape hatch and the unregistered tier both still work, on the NEW function", async function () {
      const { owner, member, sf, mock } = await sfFixture();
      await mock.bookLoan(member.address, 0, M6(9));
      expect(await sf.loanEligibleFor(member.address, 0, M6(1))).to.equal(false);

      // 0 = floor disabled. It is on the DAO menu precisely so a vote can turn the
      // whole mechanism off without a redeploy if it bites harder than intended.
      await sf.connect(owner).setInsolvencyFloorBps(0);
      expect(await sf.loanEligibleFor(member.address, 0, M6(1000)),
        "floor disabled must permit any advance — that is what the escape hatch means").to.equal(true);
      expect(await sf.loanHeadroom(member.address, 0)).to.equal(ethers.MaxUint256);

      await sf.connect(owner).setInsolvencyFloorBps(3400);
      // A tier with no registered fee has no basis for an estimate, so it cannot floor.
      expect(await sf.loanEligibleFor(member.address, 7, M6(1000))).to.equal(true);
      expect(await sf.loanHeadroom(member.address, 7)).to.equal(ethers.MaxUint256);
      // An out-of-range tier is refused, not treated as unregistered.
      expect(await sf.loanEligibleFor(member.address, 99, 1n)).to.equal(false);
    });

    it("IF-5: BOTH lending entry points enforce it — payCoRescue and payForceCross", async function () {
      // The V8.48 defect was symmetric across both, so the fix has to be checked at
      // both. payForceCross is the keeper path (the one that carries the buffer);
      // payCoRescue is the member-driven path.
      const { owner, member, sf, mock } = await sfFixture();
      await mock.bookLoan(member.address, 0, M6(3));       // $0.40 of room left

      await expect(mock.pullCoRescue(member.address, 0, M6(0.5)))
        .to.be.revertedWith("SF: insolvency floor");
      await expect(sf.connect(owner).payForceCross(member.address, 0, await mock.getAddress(), M6(0.5)))
        .to.be.revertedWith("SF: insolvency floor");

      // ...and both still lend inside the room.
      await mock.pullCoRescue(member.address, 0, M6(0.4));
      await sf.connect(owner).payForceCross(member.address, 0, await mock.getAddress(), M6(0.4));
    });

    it("IF-6: the three views share one primitive and cannot drift apart", async function () {
      // loanHeadroom is the only place the arithmetic lives; loanEligible and
      // loanEligibleFor derive from it. This codebase has already shipped a dashboard
      // that itemised $7,500 while the chain held $10,000 — two models of one rule,
      // drifting. This asserts there is only one model.
      const { owner, member, sf, mock } = await sfFixture();
      for (const bps of [0, 1700, 3400, 10000]) {
        await sf.connect(owner).setInsolvencyFloorBps(bps);
        for (const tier of [0, 7, 99]) {
          const room = await sf.loanHeadroom(member.address, tier);
          expect(await sf.loanEligible(member.address, tier),
            `bps ${bps} tier ${tier}: loanEligible must be exactly (headroom > 0)`).to.equal(room > 0n);
        }
      }
      await sf.connect(owner).setInsolvencyFloorBps(3400);
      await mock.bookLoan(member.address, 0, M6(3.4));
      expect(await sf.loanHeadroom(member.address, 0)).to.equal(0n);
      expect(await sf.loanEligible(member.address, 0)).to.equal(false);
      expect(await sf.loanEligibleFor(member.address, 0, 1n)).to.equal(false);
    });
  });

  // ══ PART 2 — discovery and the lender, on the keeper harness ════════════════
  describe("discovery agrees with the lender", function () {
    let keeper, matA, sfMock, thin, fat, ghost;

    function decode(pd) {
      if (!pd || pd === "0x") return [];
      const [items] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"], pd);
      return items.map((i) => ({ workType: Number(i.workType), addr2: i.addr2 }));
    }
    async function workFor(who) {
      const [, data] = await keeper.checkUpkeep("0x");
      return decode(data).filter((i) => i.addr2 === who).map((i) => i.workType);
    }
    const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

    /**
     * THIN — reserve $5.00 + withdrawable $3.40 = $8.40 effective = 8400 bps, which
     *        lands on preset 1's 8000 rung (2500 bps). sfShare = min($2.50, shortfall
     *        $1.60) = $1.60. Comfortably inside the $3.40 ceiling on its own — which is
     *        exactly what makes it the right member for IF-8.
     * FAT  — reserve $5.00 + withdrawable $5.00 = the whole fee. maxShortfall 0, so
     *        sfShare is 0: the SELF-FUNDED case item 12 turns on.
     */
    async function setup() {
      const sigs = await ethers.getSigners();
      [thin, fat, ghost] = sigs.slice(1, 4).map((s) => s.address);

      const tr = await (await ethers.getContractFactory("MockTierRouterK")).deploy();
      sfMock = await (await ethers.getContractFactory("MockStabilityFundK")).deploy(M6(10_000));
      await sfMock.setTier(0, M6(10_000));
      // Give the mock the REAL floor arithmetic, not the blunt per-member flag: policy
      // B is about an amount, and a boolean mock answers the same for $0.01 and $6.00.
      await sfMock.setInsolvencyFloorBps(3400);
      await sfMock.setTierFee(0, FEE);

      // MatrixKeeper is LINKED (V8.48 item 12a) — no libraries object, no test body.
      const lib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
      keeper = await (await ethers.getContractFactory("MatrixKeeper", {
        libraries: { MatrixKeeperLib: await lib.getAddress() },
      })).deploy(await tr.getAddress(), await sfMock.getAddress());

      matA = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
      const matB = await (await ethers.getContractFactory("MockMatrixK")).deploy(FEE, true);
      const pm = await (await ethers.getContractFactory("MockPairManagerK")).deploy();
      await pm.addPair(await matA.getAddress(), await matB.getAddress());
      await keeper.setPairManager(0, await pm.getAddress());
      await keeper.setParkedGracePeriod(PARKED_GRACE);

      const t = await now();
      await matA.addParked(thin, t, M6(3.4), M6(5), 0);
      await matA.addParked(fat,  t, M6(5),   M6(5), 0);
      await matA.addParked(ghost, t, M6(2),  M6(5), 0);
      await matA.setSeated(ghost, true);
      await time.increase(10);
    }

    it("IF-7: a member over the ceiling is routed to eviction, never queued as a rescue", async function () {
      await setup();
      // $2.00 owed against a $3.40 ceiling leaves $1.40 of room, and the ask is $1.60.
      await sfMock.setMemberDebt(thin, M6(2));
      await time.increase(PARKED_GRACE + 5);

      expect(await workFor(thin),
        "over the ceiling: NOT a rescue, and not an eviction yet either — the eviction " +
        "clock is 7 days and those days belong to the member, to self-rescue").to.deep.equal([]);

      await time.increase(EVICT_GRACE - PARKED_GRACE + 10);
      expect(await workFor(thin), "at 7 days the valve takes them").to.deep.equal([WORK_EVICT_PARKED]);

      // The boundary, on the same member: leave exactly enough room and they are rescued.
      await sfMock.setMemberDebt(thin, M6(3.4) - M6(1.6));
      expect(await workFor(thin), "with room for exactly this advance, it is a rescue").to.deep.equal([WORK_PARKED_RESCUE]);
      await sfMock.setMemberDebt(thin, M6(3.4) - M6(1.6) + 1n);
      expect(await workFor(thin), "one wei less room flips it").to.deep.equal([WORK_EVICT_PARKED]);
    });

    it("IF-8: THE AMOUNT, NOT THE VERDICT — the buffer changes the answer, so discovery must ask about it", async function () {
      // ⚠ THIS IS THE TEST THAT FAILS IF ANYONE SIMPLIFIES DISCOVERY BACK TO sfShare.
      //
      // `thin` asks for $1.60 against a $3.40 ceiling with no debt: comfortably eligible
      // on sfShare alone, at every buffer setting. But _doParkedRescue asks the SF for
      // sfShare + buffer, and at 3600 bps that is $5.20 — refused. If discovery only
      // asked about $1.60 it would queue a rescue the lender refuses, and
      // "SF: insolvency floor" inside performUpkeep would take the WHOLE batch.
      //
      // crossingBufferBps is DAO param 61 now, so this is not hypothetical: a vote can
      // move the amount without anyone touching this code.
      await setup();
      await time.increase(PARKED_GRACE + 5);

      expect(await workFor(thin), "buffer 0 (the shipping default): plain rescue").to.deep.equal([WORK_PARKED_RESCUE]);
      expect(await sfMock.loanEligibleFor(thin, 0, M6(1.6)),
        "sfShare alone is well inside the ceiling — the verdict must NOT come from this").to.equal(true);

      await keeper.setCrossingBufferBps(3600);
      expect(await sfMock.loanEligibleFor(thin, 0, M6(5.2)),
        "sfShare + buffer is over it — this is the question the lender will ask").to.equal(false);

      await time.increase(EVICT_GRACE);
      expect(await workFor(thin),
        "discovery must follow the money: same member, same sfShare, refused because the " +
        "ADVANCE grew. A discovery that asks about sfShare alone returns RESCUE here and " +
        "hands performUpkeep a batch-halt.").to.deep.equal([WORK_EVICT_PARKED]);

      // ...and back down again, to prove it tracks the param rather than latching.
      await keeper.setCrossingBufferBps(0);
      expect(await workFor(thin), "vote it back to 0 and the member is rescuable again").to.deep.equal([WORK_PARKED_RESCUE]);
    });

    it("IF-9: a SELF-FUNDED member is not floored at buffer 0 — and IS asked once the buffer is real", async function () {
      // Item 12's claim is "this rescue costs the fund nothing". That was FALSE in
      // V8.48: _doParkedRescue computed the buffer outside every branch on sfShare, so
      // a self-funded member was still advanced 36% of the fee and could still be
      // refused — scope finding (ii), the live batch-halt path. The guard is on the
      // ADVANCE now, so it follows the money instead of assuming where the money is.
      await setup();
      await sfMock.setMemberDebt(fat, M6(9));      // far past any ceiling
      await time.increase(PARKED_GRACE + 5);

      expect(await workFor(fat),
        "buffer 0: they borrow nothing, so the floor has nothing to refuse — item 12 holds"
      ).to.deep.equal([WORK_PARKED_RESCUE]);

      await keeper.setCrossingBufferBps(3600);
      await time.increase(EVICT_GRACE);
      expect(await workFor(fat),
        "buffer 3600: they ARE borrowing $3.60, so the floor applies to them like anyone else"
      ).to.deep.equal([WORK_EVICT_PARKED]);
    });

    it("IF-10: a floor refusal at the LENDER skips one member and does not halt the batch", async function () {
      // Belt and braces for the case discovery is supposed to make impossible. The two
      // sides now ask the same question, so this should be unreachable — which is
      // exactly why it is worth pinning: the cost of being wrong is not one skipped
      // member, it is velocity, chain-links, evictions and the CW epoch all reverting.
      await setup();
      await sfMock.setMemberDebt(thin, M6(3.4));   // ceiling full: the lender will refuse
      await matA.setRotationCount(1);              // _doEvictParked needs a rotation

      const pd = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
        [[
          [WORK_PARKED_RESCUE, 0, await matA.getAddress(), thin],   // the SF will refuse this
          [WORK_EVICT_PARKED,  0, await matA.getAddress(), ghost],  // ...this must still run
        ]]);

      const rc = await (await keeper.performUpkeep(pd)).wait();
      const names = rc.logs
        .map((l) => { try { return keeper.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean);

      expect(names.some((e) => e.name === "WorkItemFailed"),
        "the refused rescue must surface as a failed item, not vanish").to.equal(true);
      expect(names.some((e) => e.name === "ParkedMemberEvicted"),
        "THE POINT: the item AFTER the refusal still ran. A bubbled revert would have " +
        "taken the whole batch and this event would be absent.").to.equal(true);
    });
  });
});
