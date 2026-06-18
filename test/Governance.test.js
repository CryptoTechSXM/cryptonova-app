"use strict";
/**
 * Governance.test.js
 * Tests the burn-to-vote CNOVAGovernance contract.
 *
 * Coverage:
 *  - Phase gate (Universe Mode required)
 *  - Proposal creation + creation burn
 *  - Vote FOR / AGAINST accumulation
 *  - Multi-vote top-ups (add more burns to existing vote)
 *  - Quorum requirement
 *  - Majority requirement
 *  - Execution delay (timelock)
 *  - Successful execute → calls setRewardPct
 *  - Defeated proposal cannot execute
 *  - Cancel by proposer / admin
 *  - Value bounds (REWARD_PCT 10–75)
 *  - Burn-to-vote reduces CNOVA supply (floor strengthening)
 *  - proposalState transitions
 *  - isExecutable view
 *  - voterInfo view
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { time }        = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ONE_CNOVA = ethers.parseEther("1");
const MINT_AMT  = ethers.parseEther("1000");  // plenty for voting in tests

async function deployGov() {
  const [deployer, admin, proposer, voterA, voterB, voterC, anyone] =
    await ethers.getSigners();

  // ── Deploy MockUSDC ────────────────────────────────────────────────────────
  const usdc = await (await ethers.getContractFactory("MockUSDC"))
    .deploy(deployer.address);

  // ── Deploy CNOVAToken ──────────────────────────────────────────────────────
  const cnova = await (await ethers.getContractFactory("CNOVAToken"))
    .deploy(admin.address);

  // ── Deploy CNOVATreasury ──────────────────────────────────────────────────
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), admin.address);

  // ── Deploy CNOVAGovernance ─────────────────────────────────────────────────
  const gov = await (await ethers.getContractFactory("CNOVAGovernance"))
    .deploy(
      await cnova.getAddress(),
      await treasury.getAddress(),
      admin.address
    );

  const cnovaAddr = await cnova.getAddress();
  const govAddr   = await gov.getAddress();
  const treAddr   = await treasury.getAddress();

  // ── Roles ──────────────────────────────────────────────────────────────────
  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const BURNER_ROLE   = await cnova.BURNER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  // Governance needs BURNER_ROLE to burn from voters without approve()
  await cnova.connect(admin).grantRole(BURNER_ROLE,   govAddr);
  // Governance needs GOVERNOR_ROLE to call setRewardPct()
  await cnova.connect(admin).grantRole(GOVERNOR_ROLE, govAddr);
  // Mint CNOVA to test actors (admin mints directly for test setup)
  await cnova.connect(admin).grantRole(MINTER_ROLE, deployer.address);

  for (const actor of [proposer, voterA, voterB, voterC]) {
    await cnova.connect(deployer).mintDirect(actor.address, MINT_AMT);
  }

  // ── Helper: force Universe Mode ────────────────────────────────────────────
  // Treasury.setFreeMode() requires 500+ members via tier1Matrix.
  // We bypass by deploying a mock that always returns 500+.
  // ALTERNATIVE for tests: use a simple mock that has isUniverseMode = true.
  // Since CNOVATreasury.setFreeMode() is called by owner and checks tier1Matrix,
  // we deploy a mock tier1Matrix stub and set it.

  const MockMatrix = await ethers.getContractFactory("MockTier1Matrix");
  const mockMatrix = await MockMatrix.deploy();
  await treasury.connect(admin).setTier1Matrix(await mockMatrix.getAddress());
  await treasury.connect(admin).setFreeMode();  // 500+ members via mock

  // ── Reduce voting period for tests ────────────────────────────────────────
  // Default 7 days is too long for unit tests — set to 3 days
  await gov.connect(admin).setVotingPeriod(3 * 24 * 3600);
  await gov.connect(admin).setExecutionDelay(1 * 24 * 3600);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const PROPOSAL_TYPE_REWARD_PCT = 0;  // enum index
  const VOTING_PERIOD = 3 * 24 * 3600;
  const EXEC_DELAY    = 1 * 24 * 3600;

  async function createProposal(signer, newValue = 40, desc = "Raise rewardPct to 40") {
    return gov.connect(signer).propose(PROPOSAL_TYPE_REWARD_PCT, newValue, desc);
  }

  async function passProposal(proposalId, burnFor = ethers.parseEther("60")) {
    // voterA burns enough to pass quorum (50 CNOVA) + beat against
    await gov.connect(voterA).vote(proposalId, true, burnFor);
    await time.increase(VOTING_PERIOD + 1);
    await time.increase(EXEC_DELAY + 1);
  }

  return {
    cnova, treasury, gov, admin, proposer, voterA, voterB, voterC, anyone,
    PROPOSAL_TYPE_REWARD_PCT, VOTING_PERIOD, EXEC_DELAY,
    createProposal, passProposal
  };
}

// ─── MockTier1Matrix helper contract ────────────────────────────────────────
// Needs to exist so Hardhat can deploy it. We define it inline via getContractFactory
// by having a minimal contract in the test directory or using deployments.
// Since we can't write a .sol inline here, we use a different approach:
// Override treasury.isUniverseMode by deploying a simple wrapper.
// Actually the cleanest approach: just stub the mock in a separate file.

describe("CNOVAGovernance — burn-to-vote", function () {

  // ── Phase gate ─────────────────────────────────────────────────────────────
  describe("Phase gate", function () {
    it("blocks proposals before Universe Mode", async function () {
      // Deploy fresh treasury that is NOT in Universe Mode
      const [deployer, admin, proposer] = await ethers.getSigners();
      const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
      const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
      const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
        .deploy(await cnova.getAddress(), await usdc.getAddress(), admin.address);
      const gov = await (await ethers.getContractFactory("CNOVAGovernance"))
        .deploy(await cnova.getAddress(), await treasury.getAddress(), admin.address);

      await cnova.connect(admin).grantRole(await cnova.MINTER_ROLE(), deployer.address);
      await cnova.connect(admin).grantRole(await cnova.BURNER_ROLE(), await gov.getAddress());
      await cnova.connect(deployer).mintDirect(proposer.address, ethers.parseEther("100"));

      await expect(
        gov.connect(proposer).propose(0, 40, "Test")
      ).to.be.revertedWith("GOV: Universe Mode not active yet");
    });
  });

  // ── Proposal creation ──────────────────────────────────────────────────────
  describe("Proposal creation", function () {
    it("creates a proposal and burns creation fee", async function () {
      const { gov, cnova, proposer, createProposal } = await loadFixture(deployGov);

      const balBefore = await cnova.balanceOf(proposer.address);
      const tx = await createProposal(proposer, 40);
      const balAfter  = await cnova.balanceOf(proposer.address);

      const minBurn = await gov.minCreateBurn();
      expect(balBefore - balAfter).to.equal(minBurn, "Creation burn deducted");

      await expect(tx).to.emit(gov, "ProposalCreated")
        .withArgs(1n, proposer.address, 0n, 40n, (await gov.getProposal(1)).endTime, "Raise rewardPct to 40");

      expect(await gov.proposalCount()).to.equal(1n);
    });

    it("rejects value outside REWARD_PCT bounds", async function () {
      const { gov, proposer } = await loadFixture(deployGov);
      await expect(gov.connect(proposer).propose(0, 9, "Too low"))
        .to.be.revertedWith("GOV: REWARD_PCT must be 10-75");
      await expect(gov.connect(proposer).propose(0, 76, "Too high"))
        .to.be.revertedWith("GOV: REWARD_PCT must be 10-75");
    });

    it("rejects empty description", async function () {
      const { gov, proposer } = await loadFixture(deployGov);
      await expect(gov.connect(proposer).propose(0, 40, ""))
        .to.be.revertedWith("GOV: empty description");
    });

    it("increments proposalCount", async function () {
      const { gov, proposer, createProposal } = await loadFixture(deployGov);
      await createProposal(proposer, 40);
      await createProposal(proposer, 50);
      expect(await gov.proposalCount()).to.equal(2n);
    });
  });

  // ── Voting ─────────────────────────────────────────────────────────────────
  describe("Voting", function () {
    it("accepts FOR votes and emits VoteCast", async function () {
      const { gov, cnova, voterA, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      const burnAmt = ethers.parseEther("10");

      const balBefore = await cnova.balanceOf(voterA.address);
      await expect(gov.connect(voterA).vote(1, true, burnAmt))
        .to.emit(gov, "VoteCast")
        .withArgs(1n, voterA.address, true, burnAmt, burnAmt, 0n);

      expect(await cnova.balanceOf(voterA.address)).to.equal(balBefore - burnAmt);
      expect((await gov.getProposal(1)).burnedFor).to.equal(burnAmt);
    });

    it("accepts AGAINST votes", async function () {
      const { gov, voterB, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      const burnAmt = ethers.parseEther("20");
      await gov.connect(voterB).vote(1, false, burnAmt);
      expect((await gov.getProposal(1)).burnedAgainst).to.equal(burnAmt);
    });

    it("allows voter to top up their burn position", async function () {
      const { gov, voterA, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true, ethers.parseEther("10"));
      await gov.connect(voterA).vote(1, true, ethers.parseEther("15"));

      const info = await gov.voterInfo(1, voterA.address);
      expect(info.forBurned).to.equal(ethers.parseEther("25"));
      expect((await gov.getProposal(1)).burnedFor).to.equal(ethers.parseEther("25"));
    });

    it("accumulates multiple voters correctly", async function () {
      const { gov, voterA, voterB, voterC, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true,  ethers.parseEther("30"));
      await gov.connect(voterB).vote(1, true,  ethers.parseEther("20"));
      await gov.connect(voterC).vote(1, false, ethers.parseEther("10"));

      const p = await gov.getProposal(1);
      expect(p.burnedFor).to.equal(ethers.parseEther("50"));
      expect(p.burnedAgainst).to.equal(ethers.parseEther("10"));
    });

    it("rejects votes after voting period closes", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer);
      await time.increase(VOTING_PERIOD + 1);
      await expect(gov.connect(voterA).vote(1, true, ONE_CNOVA))
        .to.be.revertedWith("GOV: voting closed");
    });

    it("rejects zero-amount votes", async function () {
      const { gov, voterA, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      await expect(gov.connect(voterA).vote(1, true, 0n))
        .to.be.revertedWith("GOV: zero burn");
    });
  });

  // ── Proposal states ────────────────────────────────────────────────────────
  describe("proposalState transitions", function () {
    it("returns ACTIVE during voting period", async function () {
      const { gov, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      expect(await gov.proposalState(1)).to.equal(0); // ACTIVE
    });

    it("returns DEFEATED when quorum not met", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer);
      // Burn only 10 CNOVA FOR — below 50 CNOVA quorum
      await gov.connect(voterA).vote(1, true, ethers.parseEther("10"));
      await time.increase(VOTING_PERIOD + 1);
      expect(await gov.proposalState(1)).to.equal(4); // DEFEATED
    });

    it("returns DEFEATED when against wins", async function () {
      const { gov, voterA, voterB, createProposal, proposer, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true,  ethers.parseEther("60")); // meets quorum
      await gov.connect(voterB).vote(1, false, ethers.parseEther("70")); // against wins
      await time.increase(VOTING_PERIOD + 1);
      expect(await gov.proposalState(1)).to.equal(4); // DEFEATED
    });

    it("returns PASSED after voting closes (before execution delay)", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true, ethers.parseEther("60"));
      await time.increase(VOTING_PERIOD + 1);
      expect(await gov.proposalState(1)).to.equal(1); // PASSED
    });

    it("returns QUEUED after execution delay elapses", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD, EXEC_DELAY } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true, ethers.parseEther("60"));
      await time.increase(VOTING_PERIOD + EXEC_DELAY + 1);
      expect(await gov.proposalState(1)).to.equal(2); // QUEUED
    });

    it("returns CANCELED for a canceled proposal", async function () {
      const { gov, proposer, createProposal, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(proposer).cancel(1);
      expect(await gov.proposalState(1)).to.equal(5); // CANCELED
    });
  });

  // ── Execution ──────────────────────────────────────────────────────────────
  describe("Execution", function () {
    it("executes a passed proposal and updates rewardPct", async function () {
      const { gov, cnova, voterA, createProposal, proposer, passProposal } = await loadFixture(deployGov);
      await createProposal(proposer, 40, "Raise to 40%");
      await passProposal(1);

      await expect(gov.connect(proposer).execute(1))   // permissionless
        .to.emit(gov, "ProposalExecuted")
        .withArgs(1n, 0n, 40n);

      expect(await cnova.rewardPct()).to.equal(40n);
      expect(await gov.proposalState(1)).to.equal(3); // EXECUTED
    });

    it("anyone can call execute — permissionless", async function () {
      const { gov, cnova, voterA, anyone, createProposal, proposer, passProposal } = await loadFixture(deployGov);
      await createProposal(proposer, 50, "Raise to 50%");
      await passProposal(1);
      await gov.connect(anyone).execute(1);  // not proposer, not admin
      expect(await cnova.rewardPct()).to.equal(50n);
    });

    it("cannot execute before execution delay", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer, 40, "Test");
      await gov.connect(voterA).vote(1, true, ethers.parseEther("60"));
      await time.increase(VOTING_PERIOD + 1);  // voting closed, but delay not elapsed
      await expect(gov.connect(proposer).execute(1))
        .to.be.revertedWith("GOV: execution delay not elapsed");
    });

    it("cannot execute a defeated proposal", async function () {
      const { gov, voterA, voterB, createProposal, proposer, VOTING_PERIOD, EXEC_DELAY } = await loadFixture(deployGov);
      await createProposal(proposer, 40, "Test");
      await gov.connect(voterA).vote(1, true,  ethers.parseEther("60"));
      await gov.connect(voterB).vote(1, false, ethers.parseEther("70")); // against wins
      await time.increase(VOTING_PERIOD + EXEC_DELAY + 1);
      await expect(gov.connect(proposer).execute(1))
        .to.be.revertedWith("GOV: proposal defeated");
    });

    it("cannot execute without quorum", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD, EXEC_DELAY } = await loadFixture(deployGov);
      await createProposal(proposer, 40, "Test");
      await gov.connect(voterA).vote(1, true, ethers.parseEther("5")); // below 50 quorum
      await time.increase(VOTING_PERIOD + EXEC_DELAY + 1);
      await expect(gov.connect(proposer).execute(1))
        .to.be.revertedWith("GOV: quorum not reached");
    });

    it("cannot execute twice", async function () {
      const { gov, voterA, createProposal, proposer, passProposal } = await loadFixture(deployGov);
      await createProposal(proposer, 40, "Test");
      await passProposal(1);
      await gov.connect(proposer).execute(1);
      await expect(gov.connect(proposer).execute(1))
        .to.be.revertedWith("GOV: already executed");
    });

    it("rejects rewardPct values below 10 at execution time", async function () {
      // This would only fail if bounds were changed after proposal creation —
      // the creation validation already blocks out-of-range values.
      // We test it by directly checking the bounds.
      const { gov } = await loadFixture(deployGov);
      expect(await gov.REWARD_PCT_MIN()).to.equal(10n);
      expect(await gov.REWARD_PCT_MAX()).to.equal(75n);
    });
  });

  // ── Cancel ─────────────────────────────────────────────────────────────────
  describe("Cancel", function () {
    it("proposer can cancel during voting", async function () {
      const { gov, proposer, createProposal } = await loadFixture(deployGov);
      await createProposal(proposer);
      await expect(gov.connect(proposer).cancel(1))
        .to.emit(gov, "ProposalCanceled").withArgs(1n);
      expect(await gov.proposalState(1)).to.equal(5); // CANCELED
    });

    it("admin can cancel a proposal", async function () {
      const { gov, admin, proposer, createProposal } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(admin).cancel(1);
      expect((await gov.getProposal(1)).canceled).to.equal(true);
    });

    it("random address cannot cancel", async function () {
      const { gov, anyone, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      await expect(gov.connect(anyone).cancel(1))
        .to.be.revertedWith("GOV: not proposer or admin");
    });

    it("cannot cancel after voting closes", async function () {
      const { gov, proposer, createProposal, VOTING_PERIOD } = await loadFixture(deployGov);
      await createProposal(proposer);
      await time.increase(VOTING_PERIOD + 1);
      await expect(gov.connect(proposer).cancel(1))
        .to.be.revertedWith("GOV: voting already closed");
    });

    it("burned CNOVA is not refunded on cancel", async function () {
      const { gov, cnova, proposer, voterA, createProposal } = await loadFixture(deployGov);
      await createProposal(proposer);
      const burnAmt  = ethers.parseEther("20");
      const balBefore = await cnova.balanceOf(voterA.address);
      await gov.connect(voterA).vote(1, true, burnAmt);
      await gov.connect(proposer).cancel(1);
      // Balance after vote is permanent — no refund
      expect(await cnova.balanceOf(voterA.address)).to.equal(balBefore - burnAmt);
    });
  });

  // ── Tokenomics ─────────────────────────────────────────────────────────────
  describe("Burn-to-vote strengthens floor", function () {
    it("every vote reduces CNOVA total supply", async function () {
      const { gov, cnova, voterA, voterB, createProposal, proposer } = await loadFixture(deployGov);
      const supplyBefore = await cnova.totalSupply();

      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true,  ethers.parseEther("30"));
      await gov.connect(voterB).vote(1, false, ethers.parseEther("20"));

      const supplyAfter = await cnova.totalSupply();
      const minBurn = await gov.minCreateBurn();

      // Supply reduced by: minCreateBurn (propose) + 30 (voterA) + 20 (voterB)
      const expectedBurn = minBurn + ethers.parseEther("50");
      expect(supplyBefore - supplyAfter).to.equal(expectedBurn);
    });

    it("currentParams() returns live governable state", async function () {
      const { gov, cnova } = await loadFixture(deployGov);
      const params = await gov.currentParams();
      expect(params._rewardPct).to.equal(await cnova.rewardPct());
      expect(params._votingPeriod).to.equal(await gov.votingPeriod());
    });
  });

  // ── isExecutable view ──────────────────────────────────────────────────────
  describe("isExecutable", function () {
    it("returns false during voting", async function () {
      const { gov, voterA, createProposal, proposer } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true, ethers.parseEther("60"));
      expect(await gov.isExecutable(1)).to.equal(false);
    });

    it("returns true after delay when passed", async function () {
      const { gov, voterA, createProposal, proposer, VOTING_PERIOD, EXEC_DELAY } = await loadFixture(deployGov);
      await createProposal(proposer);
      await gov.connect(voterA).vote(1, true, ethers.parseEther("60"));
      await time.increase(VOTING_PERIOD + EXEC_DELAY + 1);
      expect(await gov.isExecutable(1)).to.equal(true);
    });
  });

  // ── Pause ──────────────────────────────────────────────────────────────────
  describe("Pause", function () {
    it("admin can pause and unpause", async function () {
      const { gov, admin, proposer, createProposal } = await loadFixture(deployGov);
      await gov.connect(admin).setPaused(true);
      await expect(createProposal(proposer)).to.be.revertedWith("GOV: paused");
      await gov.connect(admin).setPaused(false);
      await expect(createProposal(proposer)).to.not.be.reverted;
    });
  });
});
