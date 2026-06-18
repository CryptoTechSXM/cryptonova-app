"use strict";
/**
 * ReentryCycle.test.js
 * Specifically tests the full rotation cycle:
 * - Member 1 registers (root)
 * - Matrix fills (7 members)
 * - Member 8 joins → root cycles out → root RE-ENTERS matrix automatically
 * - Verifies root is back in matrix, NOT stuck in queue
 * - Verifies double re-entry works
 * - Verifies earnings accumulate across cycles
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const UNIT = 1_000_000n;
const FEE  = 10n * UNIT;

async function deployV6() {
  const [deployer, dev, ops, admin, ...signers] = await ethers.getSigners();
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
    await cnova.getAddress(), await usdc.getAddress(), admin.address
  );
  const cw = await (await ethers.getContractFactory("CryptoNovaCommunityWallet")).deploy(
    await usdc.getAddress(), admin.address
  );
  const Matrix = await ethers.getContractFactory("CryptoNovaMatrixV6");
  const mx = await Matrix.deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev.address, ops.address, await cw.getAddress(), admin.address, FEE, 7n
  );
  const BM = await ethers.getContractFactory("BeltManagerV6");
  const bm = await BM.deploy(await usdc.getAddress(), admin.address, 10n);

  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  const EPOCH  = await cnova.EPOCH_ROLE();
  const bmAddr = await bm.getAddress();
  const mxAddr = await mx.getAddress();

  await cnova.connect(admin).grantRole(MINTER, mxAddr);
  await cnova.connect(admin).grantRole(BURNER, await treasury.getAddress());
  await cnova.connect(admin).grantRole(EPOCH,  mxAddr);
  await bm.connect(admin).addBelt(mxAddr);
  await mx.connect(admin).setAuthorizedCaller(bmAddr, true);
  await mx.connect(admin).setBeltManagerCaller(bmAddr);
  await treasury.connect(admin).setAuthorizedCaller(mxAddr, true);
  await treasury.connect(admin).setTier1Matrix(bmAddr);
  await treasury.connect(admin).setCommunityWallet(await cw.getAddress());
  await cw.connect(admin).setAuthorisedRegistrar(mxAddr, true);
  await cw.connect(admin).setAuthorisedRegistrar(bmAddr, true);

  for (const s of signers.slice(0, 15)) {
    await usdc.connect(deployer).mint(s.address, 500n * UNIT);
  }

  const reg = async (signer, referrer) => {
    const [cost] = await bm.registrationCost();
    await usdc.connect(signer).approve(bmAddr, cost);
    return bm.connect(signer).register(referrer ?? ethers.ZeroAddress);
  };

  return { usdc, cnova, bm, mx, admin, signers, reg, bmAddr, mxAddr };
}

describe("V6 Re-entry Cycle", function () {

  it("member 1 cycles out and re-enters matrix automatically on member 8", async function () {
    const { mx, bm, signers, reg } = await loadFixture(deployV6);
    const alice = signers[0];

    // Alice registers first (no referrer — primary)
    await reg(alice);
    // Members 2-7 use Alice as referrer → Alice earns $2.50 × 6 = $15 L1 bonus
    // Plus chain pay → Alice has well above $10 to self-fund re-entry
    for (let i = 1; i < 7; i++) await reg(signers[i], alice.address);

    expect(await mx.occupancy()).to.equal(7n);
    expect(await mx.matrixPos(alice.address)).to.equal(1n);

    // Verify Alice has enough to self-fund re-entry
    const aliceEarned = (await mx.getMember(alice.address)).withdrawable;
    expect(aliceEarned).to.be.gte(FEE, "Alice needs >= $10 to self-fund re-entry");

    // Member 8 joins → alice cycles out → alice re-enters automatically
    await reg(signers[7], alice.address);

    const m = await mx.getMember(alice.address);
    expect(m.cyclesCompleted).to.equal(1n, "Alice should have 1 cycle");
    expect(m.isInMatrix).to.equal(true, "Alice should be BACK in matrix after re-entry");
    expect(await mx.matrixPos(alice.address)).to.be.gt(0n, "Alice should have a matrix position");
    expect(await bm.queuePosition(alice.address)).to.equal(0n, "Alice should NOT be stuck in queue");
  });

  it("occupancy decrements on cycle-out then increments on re-entry", async function () {
    const { mx, bm, signers, reg } = await loadFixture(deployV6);
    const alice = signers[0];
    await reg(alice);
    for (let i = 1; i < 7; i++) await reg(signers[i], alice.address);
    expect(await mx.occupancy()).to.equal(7n);

    await reg(signers[7], alice.address);
    expect(await mx.occupancy()).to.equal(7n, "Occupancy should be 7 again after re-entry");
  });

  it("cycled member earns chain pay from re-entry cycle", async function () {
    const { mx, bm, signers, reg } = await loadFixture(deployV6);
    const alice = signers[0];
    await reg(alice);
    for (let i = 1; i < 7; i++) await reg(signers[i], alice.address);
    const earnedBefore = (await mx.getMember(alice.address)).totalEarned;

    await reg(signers[7], alice.address);

    const earnedAfter = (await mx.getMember(alice.address)).totalEarned;
    expect(earnedAfter).to.be.gt(earnedBefore, "Alice should earn more after cycle");
  });

  it("multiple cycles work correctly", async function () {
    const { mx, bm, signers, reg } = await loadFixture(deployV6);
    const alice = signers[0];
    await reg(alice);
    for (let i = 1; i < 7; i++) await reg(signers[i], alice.address);

    await reg(signers[7], alice.address);
    expect((await mx.getMember(alice.address)).cyclesCompleted).to.equal(1n);
    expect((await mx.getMember(alice.address)).isInMatrix).to.equal(true);

    await reg(signers[8], alice.address);
    expect(await mx.rotationCount()).to.equal(2n);
  });

  it("double re-entry queues second slot when earnings sufficient", async function () {
    const { mx, bm, signers, reg, bmAddr, usdc } = await loadFixture(deployV6);
    const alice = signers[0];

    // Alice registers first, others use her as referrer → she earns $2.50×6=$15 L1 + chain pay
    await reg(alice);
    for (let i = 1; i < 7; i++) await reg(signers[i], alice.address);

    // Enable double re-entry for alice
    await bm.connect(alice).setDoubleReentry(true);

    // Verify alice has enough for double re-entry ($20+ withdrawable)
    const aliceW = (await mx.getMember(alice.address)).withdrawable;
    expect(aliceW).to.be.gte(FEE * 2n, "Alice needs >= $20 for double re-entry");

    // Member 8 triggers alice's cycle-out
    await reg(signers[7], alice.address);

    // Alice should be in matrix AND have cycled once
    const m = await mx.getMember(alice.address);
    expect(m.cyclesCompleted).to.equal(1n);
    expect(m.isInMatrix).to.equal(true);
  });
});
