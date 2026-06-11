"use strict";
const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const UNIT    = 1_000_000n;
const T1_FEE  = 10n * UNIT;
const T2_FEE  = 25n * UNIT;
const MSIZE   = 15n;

/** V8.7 7-field SplitConfig */
const SPLITS = {
  l1Bps: 2000, chainBps: 2000, poolBps: 3300,
  treasuryBps: 1500, devOpsBps: 500, stabilityBps: 600, buybackBps: 100,
};  // sum = 10 000
const CHAIN_BPS = [1000n, 400n, 300n, 150n, 75n, 75n];  // sum = 2000 = chainBps

async function deployFixture() {
  const signers   = await ethers.getSigners();
  const deployer  = signers[0];
  const devOps    = signers[1];
  const accountOne= signers[2];
  const admin     = signers[3];
  const w1        = signers[4];
  const wallets   = signers.slice(5, 22);

  const MockUSDC      = await ethers.getContractFactory("MockUSDC");
  const usdc          = await MockUSDC.deploy(deployer.address);
  const usdcAddr      = await usdc.getAddress();

  const CNOVAToken    = await ethers.getContractFactory("CNOVAToken");
  const cnova         = await CNOVAToken.deploy(admin.address);
  const cnovaAddr     = await cnova.getAddress();

  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury      = await CNOVATreasury.deploy(cnovaAddr, usdcAddr, admin.address);
  const treasuryAddr  = await treasury.getAddress();

  const TierRouter    = await ethers.getContractFactory("TierRouter");
  const tierRouter    = await TierRouter.deploy(usdcAddr, admin.address);
  const trAddr        = await tierRouter.getAddress();

  const FM = await ethers.getContractFactory("FigureEightMatrixV8");

  const dp = { usdc: usdcAddr, cnova: cnovaAddr, treasury: treasuryAddr,
                devOpsWallet: devOps.address, accountOne: accountOne.address, admin: admin.address };
  const matA  = await FM.deploy(dp, T1_FEE, MSIZE, true,  0, SPLITS, CHAIN_BPS);
  const matB  = await FM.deploy(dp, T1_FEE, MSIZE, false, 0, SPLITS, CHAIN_BPS);
  const matA2 = await FM.deploy(dp, T2_FEE, MSIZE, true,  1, SPLITS, CHAIN_BPS);
  const matB2 = await FM.deploy(dp, T2_FEE, MSIZE, false, 1, SPLITS, CHAIN_BPS);

  const matAAddr  = await matA.getAddress();
  const matBAddr  = await matB.getAddress();
  const matA2Addr = await matA2.getAddress();
  const matB2Addr = await matB2.getAddress();

  const PM  = await ethers.getContractFactory("PairManagerV8");
  const pm1 = await PM.deploy(usdcAddr, T1_FEE, admin.address);
  const pm2 = await PM.deploy(usdcAddr, T2_FEE, admin.address);
  const pm1Addr = await pm1.getAddress();
  const pm2Addr = await pm2.getAddress();

  await matA.connect(admin).setPartner(matBAddr);
  await matB.connect(admin).setPartner(matAAddr);
  await matA.connect(admin).setPairManager(pm1Addr);
  await matB.connect(admin).setPairManager(pm1Addr);
  await pm1.connect(admin).addPair(matAAddr, matBAddr);
  await pm1.connect(admin).setTierRouter(trAddr);

  await matA2.connect(admin).setPartner(matB2Addr);
  await matB2.connect(admin).setPartner(matA2Addr);
  await matA2.connect(admin).setPairManager(pm2Addr);
  await matB2.connect(admin).setPairManager(pm2Addr);
  await pm2.connect(admin).addPair(matA2Addr, matB2Addr);
  await pm2.connect(admin).setTierRouter(trAddr);

  await tierRouter.connect(admin).registerTier(0, pm1Addr, T1_FEE);
  await tierRouter.connect(admin).registerTier(1, pm2Addr, T2_FEE);
  await tierRouter.connect(admin).registerMatrix(matBAddr,  0);
  await tierRouter.connect(admin).registerMatrix(matB2Addr, 1);

  await treasury.connect(admin).setAuthorizedCaller(matAAddr,  true);
  await treasury.connect(admin).setAuthorizedCaller(matBAddr,  true);
  await treasury.connect(admin).setAuthorizedCaller(matA2Addr, true);
  await treasury.connect(admin).setAuthorizedCaller(matB2Addr, true);
  await treasury.connect(admin).setTier1Matrix(matAAddr);
  await treasury.connect(admin).setMemberTracker(pm1Addr);

  const MINTER_ROLE = await cnova.MINTER_ROLE();
  for (const m of [matA, matB, matA2, matB2]) {
    await cnova.connect(admin).grantRole(MINTER_ROLE, await m.getAddress());
  }

  const allUsers = [w1, ...wallets];
  for (const s of allUsers) {
    await usdc.mint(s.address, T1_FEE * 100n);
  }

  const reg = async (signer, referrer) => {
    await usdc.connect(signer).approve(pm1Addr, T1_FEE);
    return tierRouter.connect(signer).register(referrer != null ? referrer : ethers.ZeroAddress);
  };

  return { usdc, cnova, treasury, tierRouter, matA, matB, pm1, pm2, admin,
           w1, wallets, reg };
}

describe("MSIZE=15 cycle-out reproduction", function () {
  this.timeout(120000);

  it("fills MatA to 15/15 and wallet[14] triggers first cycle-out", async function () {
    const { tierRouter, matA, matB, w1, wallets, reg } = await loadFixture(deployFixture);

    await reg(w1, null);
    console.log("\n  W1 registered. MatA occ: " + (await matA.occupancy()));

    for (let i = 0; i < 14; i++) {
      await reg(wallets[i], w1.address);
    }

    const occ = await matA.occupancy();
    console.log("  After W1+14 wallets: MatA occ = " + occ + " / " + (await matA.MATRIX_SIZE()));
    expect(occ).to.equal(15n);

    const w1Escrow = await matA.escrowOf(w1.address);
    console.log("  W1 escrow before trigger: $" + (Number(w1Escrow)/1e6));

    console.log("  Registering wallet[14] (cycle-out trigger)...");
    const tx      = await reg(wallets[14], w1.address);
    const receipt = await tx.wait();
    console.log("  Cycle-out succeeded! gasUsed: " + receipt.gasUsed);

    const w1InA = (await matA.members(w1.address)).isInMatrix;
    const w1InB = (await matB.members(w1.address)).isInMatrix;
    console.log("  W1 in MatA: " + w1InA + " (expect false)");
    console.log("  W1 in MatB: " + w1InB + " (expect true)");
    expect(w1InA).to.be.false;
    expect(w1InB).to.be.true;
    expect(await matB.occupancy()).to.equal(1n);

    console.log("  Registering wallet[15] (post-cycle-out)...");
    const tx2 = await reg(wallets[15], w1.address);
    await tx2.wait();
    console.log("  wallet[15] registered OK");
  });
});
