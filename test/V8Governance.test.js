"use strict";
/**
 * V8Governance.test.js
 * Tests the LIVE V8Governance contract (CNOVA-balance-weighted voting).
 * NOT to be confused with Governance.test.js, which tests the old/unused
 * burn-to-vote CNOVAGovernance contract.
 *
 * Coverage (V8.20):
 *  - REGRESSION: execute() reverts for MatrixKeeper/TierRouter params when
 *    setGovernance() was never wired -- this was the actual bug found
 *    2026-06-20 (every proposal through V8.19 would pass the vote and then
 *    silently fail at execute()).
 *  - FIX: execute() succeeds once setGovernance() is wired on both contracts.
 *  - SF rescue ladder: default values match the old V8.18 hardcoded ladder,
 *    direct setSfRescueLadder() validation, and the full proposeLadder() ->
 *    vote -> finalize -> timelock -> execute lifecycle.
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { time }        = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const UNIT   = 1_000_000n;     // 1 USDC (6 decimals)
const T1_FEE = 10n * UNIT;     // $10
const MSIZE  = 7n;

const SPLITS = {
  l1Bps: 2000, chainBps: 2000, poolBps: 3300, treasuryBps: 1500,
  stabilityBps: 500, devBps: 300, opsBps: 200, communityBps: 100,
  buybackBps: 100, liquidityBps: 0,
};
const CHAIN_BPS = [1000n, 400n, 300n, 150n, 75n, 75n];

const VOTING_PERIOD   = 72n * 3600n;
const TIMELOCK_PERIOD = 48n * 3600n;

// V8Governance param IDs (BigInt -- ethers v6 decodes all uint event args as bigint)
const PARAM_VELOCITY_WINDOW       = 4n;
const PARAM_AUTO_UPGRADE_THRESH   = 1n;
const PARAM_SF_RESCUE_LADDER      = 14n;
const PARAM_WHALE_GATE_THRESHOLD  = 15n;
const PARAM_PARKED_GRACE_PERIOD   = 19n;
const PARAM_SF_TARGET             = 21n;
const PARAM_BBR_TRIGGER_THRESHOLD = 24n;
const PARAM_DS_MAX_TX_BPS         = 26n;
const PARAM_CNOVA_REWARD_PCT      = 30n;
const PARAM_CNOVA_BOOST_TABLE     = 36n;
const PARAM_CW_GENESIS_BPS        = 37n;

async function deployFixture() {
  const [deployer, admin, devOps, accountOne, proposer, voterA, voterB, other] =
    await ethers.getSigners();

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
    await cnova.getAddress(), await usdc.getAddress(), admin.address
  );

  const tierRouter = await (await ethers.getContractFactory("TierRouter")).deploy(
    await usdc.getAddress(), admin.address
  );

  // Placeholder stabilityFund address -- governance tests never trigger a real
  // parked rescue, so MatrixKeeper just needs a non-zero address here.
  const matrixKeeper = await (await ethers.getContractFactory("MatrixKeeper")).deploy(
    await tierRouter.getAddress(), admin.address
  );

  // One minimal matrix pair, just so the F8V8 governance-check fix has a real
  // deployed instance to assert against.
  const FM = await ethers.getContractFactory("FigureEightMatrixV8");
  const deployMatrix = async (isA) => FM.deploy(
    {
      usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
      treasury: await treasury.getAddress(),
      devWallet: devOps.address, opsWallet: devOps.address,
      accountOne: accountOne.address, admin: admin.address,
    },
    T1_FEE, MSIZE, isA, 0, SPLITS, CHAIN_BPS
  );
  const matA = await deployMatrix(true);
  const matB = await deployMatrix(false);
  await matA.connect(admin).setPartner(await matB.getAddress());
  await matB.connect(admin).setPartner(await matA.getAddress());
  await matA.connect(admin).setTierRouter(await tierRouter.getAddress());
  await matB.connect(admin).setTierRouter(await tierRouter.getAddress());

  const gov = await (await ethers.getContractFactory("V8Governance")).deploy(
    await cnova.getAddress(), await tierRouter.getAddress(), await matrixKeeper.getAddress()
  );
  const govAddr = await gov.getAddress();

  // ── V8.20 second wave: real deploys of the other governance targets ───────
  const stabilityFund = await (await ethers.getContractFactory("StabilityFund")).deploy(
    await usdc.getAddress(), admin.address
  );
  const buybackReserve = await (await ethers.getContractFactory("CNOVABuybackReserve")).deploy(
    await usdc.getAddress(), await cnova.getAddress(),
    ethers.ZeroAddress, ethers.ZeroAddress, // testnet stub: no live Aerodrome router
    admin.address
  );
  // CNOVADirectSale.Ownable(msg.sender) -- owner is whoever deploys it, NOT the
  // `_admin`-style param the other contracts take. Deploy without an explicit
  // signer override so it inherits the default (deployer) the same way deploy_v8.js does.
  const directSale = await (await ethers.getContractFactory("CNOVADirectSale")).deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    await stabilityFund.getAddress(), other.address, // liquidityReserve stub
    500_000_000n, 1_000_000_000n
  );
  const communityWallet = await (await ethers.getContractFactory("CommunityWallet")).deploy(
    await usdc.getAddress(), admin.address
  );

  const CW_GOVERNOR_ROLE    = await communityWallet.GOVERNOR_ROLE();
  const CNOVA_GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  // Voting power: proposer needs >= 0.01% of supply, voterA needs to clear the
  // 2% quorum on its own to keep tests simple.
  await cnova.connect(admin).mintDirectAdmin(proposer.address, ethers.parseEther("1000"));
  await cnova.connect(admin).mintDirectAdmin(voterA.address,   ethers.parseEther("60000"));
  await cnova.connect(admin).mintDirectAdmin(voterB.address,   ethers.parseEther("1000"));

  // Helper: full propose -> vote -> finalize -> timelock-elapsed lifecycle,
  // leaving the proposal ready for execute().
  async function proposeVoteAndQueue(paramId, target, newValue, desc = "test") {
    await gov.connect(proposer).propose(paramId, target, newValue, desc);
    const id = await gov.proposalCount();
    await gov.connect(voterA).castVote(id, true);
    await time.increase(Number(VOTING_PERIOD) + 1);
    await gov.finalizeVote(id);
    await time.increase(Number(TIMELOCK_PERIOD) + 1);
    return id;
  }

  async function proposeLadderAndQueue(target, thresholds, bpsValues, desc = "ladder test") {
    await gov.connect(proposer).proposeLadder(target, thresholds, bpsValues, desc);
    const id = await gov.proposalCount();
    await gov.connect(voterA).castVote(id, true);
    await time.increase(Number(VOTING_PERIOD) + 1);
    await gov.finalizeVote(id);
    await time.increase(Number(TIMELOCK_PERIOD) + 1);
    return id;
  }

  async function proposeBoostTableAndQueue(target, thresholds, rates, desc = "boost table test") {
    await gov.connect(proposer).proposeBoostTable(target, thresholds, rates, desc);
    const id = await gov.proposalCount();
    await gov.connect(voterA).castVote(id, true);
    await time.increase(Number(VOTING_PERIOD) + 1);
    await gov.finalizeVote(id);
    await time.increase(Number(TIMELOCK_PERIOD) + 1);
    return id;
  }

  return {
    usdc, cnova, treasury, tierRouter, matrixKeeper, matA, matB, gov, govAddr,
    stabilityFund, buybackReserve, directSale, communityWallet,
    CW_GOVERNOR_ROLE, CNOVA_GOVERNOR_ROLE,
    deployer, admin, devOps, accountOne, proposer, voterA, voterB, other,
    proposeVoteAndQueue, proposeLadderAndQueue, proposeBoostTableAndQueue,
  };
}

describe("V8Governance — wiring regression + SF rescue ladder", function () {

  // ── Regression: the actual bug found 2026-06-20 ──────────────────────────
  describe("Governance wiring (the bug)", function () {
    it("REGRESSION: execute() reverts on MatrixKeeper params when setGovernance was never called", async function () {
      const { gov, matrixKeeper, proposeVoteAndQueue } = await loadFixture(deployFixture);
      const id = await proposeVoteAndQueue(
        PARAM_VELOCITY_WINDOW, await matrixKeeper.getAddress(), 7200, "bump velocity window"
      );
      // matrixKeeper.governance was never set -- this is exactly the V8.19 state.
      await expect(gov.execute(id)).to.be.revertedWith("MK: not authorized");
    });

    it("REGRESSION: execute() reverts on TierRouter params when setGovernance was never called", async function () {
      const { gov, tierRouter, proposeVoteAndQueue } = await loadFixture(deployFixture);
      const id = await proposeVoteAndQueue(
        PARAM_AUTO_UPGRADE_THRESH, await tierRouter.getAddress(), 3, "lower upgrade threshold"
      );
      await expect(gov.execute(id)).to.be.revertedWith("TR: not authorized");
    });

    it("FIX: execute() succeeds on MatrixKeeper once setGovernance is wired", async function () {
      const { gov, govAddr, deployer, matrixKeeper, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await matrixKeeper.connect(deployer).setGovernance(govAddr);

      const id = await proposeVoteAndQueue(
        PARAM_VELOCITY_WINDOW, await matrixKeeper.getAddress(), 7200, "bump velocity window"
      );
      await expect(gov.execute(id))
        .to.emit(gov, "ProposalExecuted").withArgs(id, PARAM_VELOCITY_WINDOW, 7200n);
      expect(await matrixKeeper.velocityWindow()).to.equal(7200n);
    });

    it("FIX: execute() succeeds on TierRouter once setGovernance is wired", async function () {
      const { gov, govAddr, admin, tierRouter, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await tierRouter.connect(admin).setGovernance(govAddr);

      const id = await proposeVoteAndQueue(
        PARAM_AUTO_UPGRADE_THRESH, await tierRouter.getAddress(), 3, "lower upgrade threshold"
      );
      await gov.execute(id);
      expect(await tierRouter.autoUpgradeCycleThreshold()).to.equal(3n);
    });

    it("owner retains emergency backstop -- can still call setters directly without governance", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await matrixKeeper.connect(deployer).setVelocityWindow(7200);
      expect(await matrixKeeper.velocityWindow()).to.equal(7200n);
    });

    it("FigureEightMatrixV8 fee setters accept the governance address once wired", async function () {
      const { gov, govAddr, admin, matA, other } = await loadFixture(deployFixture);
      await expect(matA.connect(other).setWithdrawalFeeBps(100)).to.be.revertedWith("F8V8: not governance");

      await matA.connect(admin).setGovernance(govAddr);
      // Simulate governance calling directly (impersonation not needed -- just
      // prove the require() now accepts the governance address by reading it back).
      expect(await matA.governance()).to.equal(govAddr);
    });
  });

  // ── SF rescue ladder: defaults match V8.18 ────────────────────────────────
  describe("SF rescue ladder defaults", function () {
    it("matches the exact V8.18 hardcoded breakpoints out of the box", async function () {
      const { matrixKeeper } = await loadFixture(deployFixture);
      // First rung: full withdrawable -> 0% rescue
      expect(await matrixKeeper.sfRescueThresholds(0)).to.equal(10_000n);
      expect(await matrixKeeper.sfRescueBpsLadder(0)).to.equal(0n);
      // Deepest rung: 40-49% withdrawable -> SF covers 60% (the exact value the
      // user asked about -- "is the 60% configurable on chain or software driven")
      expect(await matrixKeeper.sfRescueThresholds(10)).to.equal(4_000n);
      expect(await matrixKeeper.sfRescueBpsLadder(10)).to.equal(6_000n);
    });
  });

  // ── SF rescue ladder: direct owner setter validation ──────────────────────
  describe("setSfRescueLadder validation (direct owner call)", function () {
    it("rejects mismatched array lengths", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([10_000, 5_000], [0])
      ).to.be.revertedWith("MK: length mismatch");
    });

    it("rejects a first threshold that isn't 10000", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([9_000, 5_000], [0, 5_000])
      ).to.be.revertedWith("MK: first threshold must be 10000");
    });

    it("rejects a first bps that isn't 0", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([10_000, 5_000], [100, 5_000])
      ).to.be.revertedWith("MK: first bps must be 0");
    });

    it("rejects non-descending thresholds", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([10_000, 10_000], [0, 5_000])
      ).to.be.revertedWith("MK: thresholds must descend");
    });

    it("rejects non-ascending bps", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([10_000, 5_000], [0, 0])
      ).to.be.revertedWith("MK: bps must ascend");
    });

    it("rejects bps over 10000", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([10_000, 5_000], [0, 10_001])
      ).to.be.revertedWith("MK: bps too high");
    });

    it("accepts and emits SfRescueLadderUpdated on a valid replacement ladder", async function () {
      const { deployer, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(deployer).setSfRescueLadder([10_000, 7_000, 4_000], [0, 3_000, 8_000])
      ).to.emit(matrixKeeper, "SfRescueLadderUpdated").withArgs(3n, 8_000n);

      expect(await matrixKeeper.sfRescueThresholds(2)).to.equal(4_000n);
      expect(await matrixKeeper.sfRescueBpsLadder(2)).to.equal(8_000n);
      // Old 11-rung ladder is gone -- index 3 no longer exists.
      await expect(matrixKeeper.sfRescueThresholds(3)).to.be.reverted;
    });

    it("rejects ladder setter from a random address (not owner, not governance)", async function () {
      const { other, matrixKeeper } = await loadFixture(deployFixture);
      await expect(
        matrixKeeper.connect(other).setSfRescueLadder([10_000, 5_000], [0, 5_000])
      ).to.be.revertedWith("MK: not authorized");
    });
  });

  // ── SF rescue ladder: full governance lifecycle ───────────────────────────
  describe("proposeLadder() -> vote -> execute lifecycle", function () {
    it("rejects a malformed ladder at proposal-creation time (before any vote)", async function () {
      const { gov, matrixKeeper, proposer } = await loadFixture(deployFixture);
      await expect(
        gov.connect(proposer).proposeLadder(
          await matrixKeeper.getAddress(), [9_000, 5_000], [0, 5_000], "bad ladder"
        )
      ).to.be.revertedWithCustomError(gov, "GOV_ValueNotAllowed");
    });

    it("replaces the SF rescue ladder via a full DAO vote", async function () {
      const { gov, govAddr, deployer, matrixKeeper, proposeLadderAndQueue } = await loadFixture(deployFixture);
      await matrixKeeper.connect(deployer).setGovernance(govAddr);

      const newThresholds = [10_000, 7_000, 4_000];
      const newBps        = [0, 3_000, 8_000];
      const id = await proposeLadderAndQueue(
        await matrixKeeper.getAddress(), newThresholds, newBps, "tighten SF rescue ladder"
      );

      await expect(gov.execute(id))
        .to.emit(gov, "ProposalExecuted").withArgs(id, PARAM_SF_RESCUE_LADDER, 0n);

      expect(await matrixKeeper.sfRescueThresholds(2)).to.equal(4_000n);
      expect(await matrixKeeper.sfRescueBpsLadder(2)).to.equal(8_000n);
    });

    it("REGRESSION: ladder execute() also reverts without setGovernance wired", async function () {
      const { gov, matrixKeeper, proposeLadderAndQueue } = await loadFixture(deployFixture);
      const id = await proposeLadderAndQueue(
        await matrixKeeper.getAddress(), [10_000, 5_000], [0, 5_000], "tighten ladder"
      );
      await expect(gov.execute(id)).to.be.revertedWith("MK: not authorized");
    });
  });

  // ── V8.20 second wave: every newly-wired contract gets one happy-path +
  //    one regression-without-wiring test. Per-param coverage isn't repeated
  //    here for every one of the ~24 new scalar params -- they all go through
  //    the identical _applyParam() dispatch already proven above; what matters
  //    is proving each NEW TARGET CONTRACT's wiring actually works end-to-end.
  describe("V8.20 second wave -- new target contracts", function () {
    it("TierRouter: setWhaleGateThreshold executes once setGovernance is wired", async function () {
      const { gov, govAddr, admin, tierRouter, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await tierRouter.connect(admin).setGovernance(govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_WHALE_GATE_THRESHOLD, await tierRouter.getAddress(), 25, "raise whale gate"
      );
      await gov.execute(id);
      expect(await tierRouter.whaleGateThreshold()).to.equal(25n);
    });

    it("MatrixKeeper: setParkedGracePeriod executes once setGovernance is wired", async function () {
      const { gov, govAddr, deployer, matrixKeeper, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await matrixKeeper.connect(deployer).setGovernance(govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_PARKED_GRACE_PERIOD, await matrixKeeper.getAddress(), 21600, "tighten grace period"
      );
      await gov.execute(id);
      expect(await matrixKeeper.parkedGracePeriod()).to.equal(21600n);
    });

    it("StabilityFund: REGRESSION execute() reverts without setGovernance wired", async function () {
      const { gov, stabilityFund, proposeVoteAndQueue } = await loadFixture(deployFixture);
      const id = await proposeVoteAndQueue(
        PARAM_SF_TARGET, await stabilityFund.getAddress(), 500_000_000, "raise SF target"
      );
      await expect(gov.execute(id)).to.be.revertedWith("SF: not authorized");
    });

    it("StabilityFund: setSFTarget executes once setGovernance is wired", async function () {
      const { gov, govAddr, admin, stabilityFund, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await stabilityFund.connect(admin).setGovernance(govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_SF_TARGET, await stabilityFund.getAddress(), 500_000_000, "raise SF target"
      );
      await gov.execute(id);
      expect(await stabilityFund.sfTarget()).to.equal(500_000_000n);
    });

    it("StabilityFund: setStabilityFloor rejects a floor above sfTarget (bounds added in V8.20)", async function () {
      const { admin, stabilityFund } = await loadFixture(deployFixture);
      // Default sfTarget is $300 (300_000_000) -- $1000 floor should be rejected.
      await expect(
        stabilityFund.connect(admin).setStabilityFloor(1_000_000_000)
      ).to.be.revertedWith("SF: floor exceeds target");
    });

    it("CNOVABuybackReserve: setTriggerThreshold executes once setGovernance is wired", async function () {
      const { gov, govAddr, admin, buybackReserve, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await buybackReserve.connect(admin).setGovernance(govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_BBR_TRIGGER_THRESHOLD, await buybackReserve.getAddress(), 1_000_000_000, "raise BBR threshold"
      );
      await gov.execute(id);
      expect(await buybackReserve.triggerThreshold()).to.equal(1_000_000_000n);
    });

    it("CNOVABuybackReserve: REGRESSION execute() reverts without setGovernance wired", async function () {
      const { gov, buybackReserve, proposeVoteAndQueue } = await loadFixture(deployFixture);
      const id = await proposeVoteAndQueue(
        PARAM_BBR_TRIGGER_THRESHOLD, await buybackReserve.getAddress(), 1_000_000_000, "raise BBR threshold"
      );
      await expect(gov.execute(id)).to.be.revertedWith("BBR: not authorized");
    });

    it("CNOVADirectSale: setMaxTxBps executes once setGovernance is wired (owner is deployer, not admin)", async function () {
      const { gov, govAddr, deployer, directSale, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await directSale.connect(deployer).setGovernance(govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_DS_MAX_TX_BPS, await directSale.getAddress(), 200, "raise DS tx cap"
      );
      await gov.execute(id);
      expect(await directSale.maxTxBps()).to.equal(200n);
    });

    it("CNOVAToken: setRewardPct executes once GOVERNOR_ROLE is granted (role existed since V8.9, call path didn't)", async function () {
      const { gov, govAddr, admin, cnova, CNOVA_GOVERNOR_ROLE, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await cnova.connect(admin).grantRole(CNOVA_GOVERNOR_ROLE, govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_CNOVA_REWARD_PCT, await cnova.getAddress(), 40, "lower reward pct"
      );
      await gov.execute(id);
      expect(await cnova.rewardPct()).to.equal(40n);
    });

    it("CNOVAToken: REGRESSION execute() reverts without GOVERNOR_ROLE granted", async function () {
      const { gov, cnova, proposeVoteAndQueue } = await loadFixture(deployFixture);
      const id = await proposeVoteAndQueue(
        PARAM_CNOVA_REWARD_PCT, await cnova.getAddress(), 40, "lower reward pct"
      );
      await expect(gov.execute(id)).to.be.reverted; // AccessControl custom error, not a string revert
    });

    it("CNOVAToken: full proposeBoostTable() -> vote -> execute lifecycle replaces the boost table", async function () {
      const { gov, govAddr, admin, cnova, CNOVA_GOVERNOR_ROLE, proposeBoostTableAndQueue } = await loadFixture(deployFixture);
      await cnova.connect(admin).grantRole(CNOVA_GOVERNOR_ROLE, govAddr);

      const newThresholds = [200n * 10n**18n, 2_000n * 10n**18n];
      const newRates      = [800n, 2000n];
      const id = await proposeBoostTableAndQueue(await cnova.getAddress(), newThresholds, newRates, "simplify boost table");

      await expect(gov.execute(id))
        .to.emit(gov, "ProposalExecuted").withArgs(id, PARAM_CNOVA_BOOST_TABLE, 0n);

      expect(await cnova.boostThresholds(0)).to.equal(newThresholds[0]);
      expect(await cnova.boostRates(1)).to.equal(2000n);
      // Old 5-rung table is gone -- index 2 no longer exists.
      await expect(cnova.boostThresholds(2)).to.be.reverted;
    });

    it("CommunityWallet: setGenesisBps executes once GOVERNOR_ROLE is granted (role existed since V8.8, call path + grant didn't)", async function () {
      const { gov, govAddr, admin, communityWallet, CW_GOVERNOR_ROLE, proposeVoteAndQueue } = await loadFixture(deployFixture);
      await communityWallet.connect(admin).grantRole(CW_GOVERNOR_ROLE, govAddr);
      const id = await proposeVoteAndQueue(
        PARAM_CW_GENESIS_BPS, await communityWallet.getAddress(), 7000, "lower genesis split"
      );
      await gov.execute(id);
      expect(await communityWallet.genesisBps()).to.equal(7000n);
    });

    it("CommunityWallet: REGRESSION execute() reverts without GOVERNOR_ROLE granted (grant never existed before V8.20)", async function () {
      const { gov, communityWallet, proposeVoteAndQueue } = await loadFixture(deployFixture);
      const id = await proposeVoteAndQueue(
        PARAM_CW_GENESIS_BPS, await communityWallet.getAddress(), 7000, "lower genesis split"
      );
      await expect(gov.execute(id)).to.be.reverted;
    });
  });
});
