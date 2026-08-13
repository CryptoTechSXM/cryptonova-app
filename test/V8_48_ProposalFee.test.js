"use strict";
/**
 * V8_48_ProposalFee.test.js — the proposal fee, made REAL (owner decision 2026-08-13).
 *
 * HISTORY, so nobody re-litigates it: V8.34 shipped the FRONTEND for a "100 CNOVA
 * burned on propose" fee — and even this repo's own V8Governance.test.js fixture has
 * carried a MaxUint256 approve "for the 100 CNOVA proposal fee" ever since — but the
 * CONTRACT half was never built. proposalFee() did not exist, the UI's read always
 * reverted, and a .catch dressed the revert up as 100e18 (removed by the 2026-08-07
 * audit). These tests cover the completed mechanism.
 *
 * THE DESIGN UNDER TEST: 100 CNOVA default, burned from the proposer via the
 * allowance path (explicit consent — governance holds no BURNER_ROLE); charged by
 * BOTH propose() and proposeBoostTable(); DAO-votable (param 58) with 0 on the menu
 * as the vote-it-free escape hatch; voting untouched and free.
 */
const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { time }        = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const FEE  = ethers.parseEther("100");
// The owner's menu (2026-08-13) plus 0 — asserted verbatim in PF4.
const MENU = ["0", "2.5", "5", "10", "25", "50", "100", "250", "500", "1000"]
  .map(v => ethers.parseEther(v));
const PARAM_PROPOSAL_FEE = 58;
const PARAM_QUORUM_BPS   = 13;   // any cheap scalar param for generic proposals

async function deployFixture() {
  const [deployer, admin, proposer, voterA, poorGuy] = await ethers.getSigners();

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  const tierRouter = await (await ethers.getContractFactory("TierRouter", {
    libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target },
  })).deploy(await usdc.getAddress(), admin.address);
  const matrixKeeper = await (await ethers.getContractFactory("MatrixKeeper", {
    libraries: { MatrixKeeperLib: (await (await ethers.getContractFactory("MatrixKeeperLib")).deploy()).target },
  })).deploy(await tierRouter.getAddress(), admin.address);
  const gov = await (await ethers.getContractFactory("V8Governance")).deploy(
    await cnova.getAddress(), await tierRouter.getAddress(), await matrixKeeper.getAddress()
  );
  const govAddr = await gov.getAddress();

  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await cnova.connect(admin).grantRole(DIRECT_SALE_ROLE, admin.address);
  await cnova.connect(admin).mintForSale(proposer.address, ethers.parseEther("1000"));
  await cnova.connect(admin).mintForSale(voterA.address,   ethers.parseEther("60000"));
  await cnova.connect(admin).mintForSale(poorGuy.address,  ethers.parseEther("50"));
  await cnova.connect(proposer).approve(govAddr, ethers.MaxUint256);

  return { usdc, cnova, tierRouter, matrixKeeper, gov, govAddr,
           deployer, admin, proposer, voterA, poorGuy };
}

describe("V8.48 — the proposal fee, made real (param 58)", function () {
  this.timeout(600_000);

  it("PF1: propose() BURNS the fee from the proposer — balance, supply and totalBurned all move by exactly 100", async () => {
    const ctx = await loadFixture(deployFixture);
    expect(await ctx.gov.proposalFee(), "the V8.34 promise is the default").to.equal(FEE);

    const balBefore    = await ctx.cnova.balanceOf(ctx.proposer.address);
    const supplyBefore = await ctx.cnova.totalSupply();
    const burnedBefore = await ctx.cnova.totalBurned();

    await expect(ctx.gov.connect(ctx.proposer)
        .propose(PARAM_QUORUM_BPS, ethers.ZeroAddress, 300, "raise quorum"))
      .to.emit(ctx.gov, "ProposalFeeBurned").withArgs(1n, ctx.proposer.address, FEE);

    expect(balBefore - await ctx.cnova.balanceOf(ctx.proposer.address),
      "fee left the proposer").to.equal(FEE);
    expect(supplyBefore - await ctx.cnova.totalSupply(),
      "fee was BURNED, not moved — supply shrank").to.equal(FEE);
    expect(await ctx.cnova.totalBurned() - burnedBefore,
      "the token's burn ledger recorded it").to.equal(FEE);
    expect(await ctx.gov.proposalCount(), "and the proposal exists").to.equal(1n);
  });

  it("PF2: no allowance → revert; allowance but can't afford the fee → revert. Nobody pays without proposing, nobody proposes without paying", async () => {
    const ctx = await loadFixture(deployFixture);

    // voterA holds plenty of CNOVA but never approved the governance contract.
    await expect(ctx.gov.connect(ctx.voterA)
        .propose(PARAM_QUORUM_BPS, ethers.ZeroAddress, 300, "no allowance"))
      .to.be.revertedWithCustomError(ctx.cnova, "ERC20InsufficientAllowance");

    // poorGuy passes the 0.01%-of-supply gate but cannot afford the 100 fee.
    const supply = await ctx.cnova.totalSupply();
    const bal    = await ctx.cnova.balanceOf(ctx.poorGuy.address);
    expect(bal, "PRECONDITION: poorGuy must clear the proposer gate, or this test " +
      "asserts the wrong revert").to.be.gte(supply / 10_000n);
    expect(bal, "PRECONDITION: poorGuy must NOT afford the fee").to.be.lt(FEE);
    await ctx.cnova.connect(ctx.poorGuy).approve(ctx.govAddr, ethers.MaxUint256);
    await expect(ctx.gov.connect(ctx.poorGuy)
        .propose(PARAM_QUORUM_BPS, ethers.ZeroAddress, 300, "cannot afford"))
      .to.be.revertedWithCustomError(ctx.cnova, "ERC20InsufficientBalance");
    expect(await ctx.gov.proposalCount(), "no proposal was created by either revert").to.equal(0n);
  });

  it("PF3: proposeBoostTable() pays the SAME fee — the array path is not a free side door", async () => {
    const ctx = await loadFixture(deployFixture);
    const balBefore = await ctx.cnova.balanceOf(ctx.proposer.address);
    await expect(ctx.gov.connect(ctx.proposer).proposeBoostTable(
        await ctx.cnova.getAddress(),
        [ethers.parseEther("100")], [500],
        "boost table"))
      .to.emit(ctx.gov, "ProposalFeeBurned").withArgs(1n, ctx.proposer.address, FEE);
    expect(balBefore - await ctx.cnova.balanceOf(ctx.proposer.address)).to.equal(FEE);
  });

  it("PF4: menu discipline (the item-42 test style) — default on the menu, 0 on the menu, owner's list verbatim", async () => {
    const ctx = await loadFixture(deployFixture);
    const menu = await ctx.gov.getAllowedValues(PARAM_PROPOSAL_FEE);
    expect(menu.map(String), "the owner's 2026-08-13 menu, plus the 0 escape hatch")
      .to.deep.equal(MENU.map(String));
    expect(menu.map(String), "a default absent from the menu could never be voted back")
      .to.include(String(await ctx.gov.proposalFee()));
    expect(menu.map(String), "without 0, proposing could never be made free again")
      .to.include("0");
  });

  it("PF5: the fee governs ITSELF — full DAO vote takes it to 0, and proposing becomes free", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.gov.connect(ctx.proposer)
      .propose(PARAM_PROPOSAL_FEE, ethers.ZeroAddress, 0, "make proposing free");
    const id = await ctx.gov.proposalCount();
    await ctx.gov.connect(ctx.voterA).castVote(id, true);
    await time.increase(Number(await ctx.gov.votingPeriod()) + 1);
    await ctx.gov.finalizeVote(id);
    await time.increase(Number(await ctx.gov.timelockPeriod()) + 1);
    await ctx.gov.execute(id);
    expect(await ctx.gov.proposalFee(), "the DAO set it to 0").to.equal(0n);

    // And the next proposal burns nothing — no fee, no event.
    const balBefore = await ctx.cnova.balanceOf(ctx.proposer.address);
    await expect(ctx.gov.connect(ctx.proposer)
        .propose(PARAM_QUORUM_BPS, ethers.ZeroAddress, 300, "free now"))
      .to.not.emit(ctx.gov, "ProposalFeeBurned");
    expect(await ctx.cnova.balanceOf(ctx.proposer.address),
      "proposing at fee 0 costs zero CNOVA").to.equal(balBefore);
  });

  it("PF6: VOTING IS ALWAYS FREE — the owner's rule, pinned: castVote moves no CNOVA and needs no allowance", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.gov.connect(ctx.proposer)
      .propose(PARAM_QUORUM_BPS, ethers.ZeroAddress, 300, "something to vote on");
    const id = await ctx.gov.proposalCount();

    // voterA has NO allowance to the governance contract (asserted, not assumed) —
    // if voting ever grew a fee, this is the test that screams.
    expect(await ctx.cnova.allowance(ctx.voterA.address, ctx.govAddr)).to.equal(0n);
    const balBefore = await ctx.cnova.balanceOf(ctx.voterA.address);
    await ctx.gov.connect(ctx.voterA).castVote(id, true);
    expect(await ctx.cnova.balanceOf(ctx.voterA.address),
      "vote weight is READ, never taken").to.equal(balBefore);
  });
});
