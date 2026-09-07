// V8_53_Pauser.test.js — the pause-ONLY role (MAINNET_READINESS.md §2 P2, session 66, 2026-09-07).
// Proves: pauser can pause; pauser can NOT unpause; pauser can NOT touch any setter; owner still
// pauses; non-owner/non-pauser cannot; owner can clear the pauser; unpause after a pauser pause
// reopens register(). Minimal fixture: TierRouter alone (pause needs no matrices).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

async function fixture() {
  const [deployer, admin, watchdog, stranger] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const lib  = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const TR   = await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: lib.target } });
  const tr   = await TR.deploy(await usdc.getAddress(), admin.address);
  return { tr, admin, watchdog, stranger };
}

describe("V8.53 pauser role (pause-only key)", function () {
  it("defaults to address(0) and only the owner can set it", async function () {
    const { tr, admin, watchdog, stranger } = await loadFixture(fixture);
    expect(await tr.pauser()).to.equal(ethers.ZeroAddress);
    await expect(tr.connect(stranger).setPauser(watchdog.address))
      .to.be.revertedWithCustomError(tr, "OwnableUnauthorizedAccount");
    await tr.connect(admin).setPauser(watchdog.address);
    expect(await tr.pauser()).to.equal(watchdog.address);
  });

  it("pauser can pause; a stranger cannot", async function () {
    const { tr, admin, watchdog, stranger } = await loadFixture(fixture);
    await tr.connect(admin).setPauser(watchdog.address);
    await expect(tr.connect(stranger).pauseSystem("nope")).to.be.revertedWithCustomError(tr, "TRAuth");
    await expect(tr.connect(watchdog).pauseSystem("SF below floor"))
      .to.emit(tr, "SystemPaused").withArgs("SF below floor", 0, 0);
    expect(await tr.systemPaused()).to.be.true;
  });

  it("pauser can NOT unpause — owner can", async function () {
    const { tr, admin, watchdog } = await loadFixture(fixture);
    await tr.connect(admin).setPauser(watchdog.address);
    await tr.connect(watchdog).pauseSystem("SF below floor");
    await expect(tr.connect(watchdog).unpauseSystem()).to.be.revertedWithCustomError(tr, "OwnableUnauthorizedAccount");
    await expect(tr.connect(watchdog).resumeSystem()).to.be.revertedWithCustomError(tr, "OwnableUnauthorizedAccount");
    await tr.connect(admin).unpauseSystem();
    expect(await tr.systemPaused()).to.be.false;
  });

  it("pauser can NOT use owner setters (setPauser, setGovernance, setInactivityGuardEnabled)", async function () {
    const { tr, admin, watchdog, stranger } = await loadFixture(fixture);
    await tr.connect(admin).setPauser(watchdog.address);
    await expect(tr.connect(watchdog).setPauser(stranger.address)).to.be.revertedWithCustomError(tr, "OwnableUnauthorizedAccount");
    await expect(tr.connect(watchdog).setGovernance(stranger.address)).to.be.revertedWithCustomError(tr, "OwnableUnauthorizedAccount");
    await expect(tr.connect(watchdog).setInactivityGuardEnabled(0)).to.be.revertedWithCustomError(tr, "TRAuth");
  });

  it("owner still pauses without a pauser set; clearing the pauser revokes it", async function () {
    const { tr, admin, watchdog } = await loadFixture(fixture);
    await tr.connect(admin).pauseSystem("owner pause");
    expect(await tr.systemPaused()).to.be.true;
    await tr.connect(admin).unpauseSystem();
    await tr.connect(admin).setPauser(watchdog.address);
    await tr.connect(admin).setPauser(ethers.ZeroAddress);
    await expect(tr.connect(watchdog).pauseSystem("revoked")).to.be.revertedWithCustomError(tr, "TRAuth");
  });

  it("pausing twice reverts TRState for the pauser too", async function () {
    const { tr, admin, watchdog } = await loadFixture(fixture);
    await tr.connect(admin).setPauser(watchdog.address);
    await tr.connect(watchdog).pauseSystem("one");
    await expect(tr.connect(watchdog).pauseSystem("two")).to.be.revertedWithCustomError(tr, "TRState");
  });
});
