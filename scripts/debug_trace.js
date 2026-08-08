"use strict";
const { ethers } = require("hardhat");

const SPLITS = {
  l1Bps: 2000, chainBps: 2000, poolBps: 3300,
  treasuryBps: 1500, stabilityBps: 500,
  devBps: 300, opsBps: 200, communityBps: 100, buybackBps: 100,
  liquidityBps: 0,
};
const CP_BPS  = [800, 500, 250, 200, 150, 100];
const FEE     = 10_000_000n;
const SF_SEED = 50_000_000n;

async function main() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];

  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter"))
    .deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(usdcAddr, FEE, owner.address);

  const [tresAddr, sfAddr, trAddr, pmAddr] = [
    await treasury.getAddress(), await sf.getAddress(),
    await tr.getAddress(),       await pm.getAddress(),
  ];

  const dp = {
    usdc:         usdcAddr,
    cnova:        cnovaAddr,
    treasury:     tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne:   W1.address,
    admin:        owner.address,
  };

  const MatrixLib  = await ethers.getContractFactory("MatrixLogicLib");
  const matrixLib  = await MatrixLib.deploy();
  await matrixLib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });
  const matA = await MX.deploy(dp, FEE, 4, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, 4, false, 0, SPLITS, CP_BPS);
  const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

  await matA.setPartner(matBAddr);
  await matB.setPartner(matAAddr);
  for (const m of [matA, matB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(trAddr);
    await m.setStabilityFund(sfAddr);
  }
  await matA.setMatrixKeeper(owner.address);
  await sf.setMatrixKeeper(owner.address);
  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);
  await treasury.setAuthorizedCaller(matAAddr, true);
  await treasury.setAuthorizedCaller(matBAddr, true);
  await sf.setMatrixAuthorized(matAAddr, true);
  await sf.setMatrixAuthorized(matBAddr, true);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);
  await usdc.mint(owner.address, SF_SEED);
  await usdc.connect(owner).approve(sfAddr, SF_SEED);
  await sf.connect(owner).receiveLayer(0, SF_SEED, 1);

  const fmt = (v) => `$${(Number(v) / 1e6).toFixed(4)}`;

  async function checkW1() {
    const m = await matA.getMember(W1.address);
    const w = await matA.withdrawableOf(W1.address);
    const matABal = await usdc.balanceOf(matAAddr);
    console.log(`  W1.withdrawable=${fmt(w)} crossReserve=${fmt(m.crossingReserve)} matABal=${fmt(matABal)}`);
  }

  // W1 registers
  await usdc.mint(W1.address, FEE);
  await usdc.connect(W1).approve(pmAddr, FEE);
  await tr.connect(W1).register(ethers.ZeroAddress, { gasLimit: 1_000_000 });
  console.log("After W1 registration:");
  await checkW1();

  // Fillers
  const fillers = sigs.slice(10, 13);
  for (let i = 0; i < fillers.length; i++) {
    const w   = fillers[i];
    const ref = i === 0 ? W1.address : fillers[i-1].address;
    await usdc.mint(w.address, FEE);
    await usdc.connect(w).approve(pmAddr, FEE);
    await tr.connect(w).register(ref, { gasLimit: 1_000_000 });
    console.log(`After filler${i} registration:`);
    await checkW1();
  }

  console.log("\nBefore cycler (W1 state):");
  await checkW1();

  // Cycler
  const cycler = sigs[13];
  await usdc.mint(cycler.address, FEE);
  await usdc.connect(cycler).approve(pmAddr, FEE);
  try {
    const tx = await tr.connect(cycler).register(fillers[2].address, { gasLimit: 3_000_000 });
    const rcpt = await tx.wait();
    console.log(`\nCycle-out TX: OK gasUsed=${rcpt.gasUsed}`);
  } catch (err) {
    console.log("Cycle-out FAILED:", err.message.slice(0, 300));
  }

  console.log("\nAfter cycle-out:");
  const w1Earn = await matA.withdrawableOf(W1.address);
  const w1InB = await matB.getMember(W1.address);
  const w1Parked = await matA.isParked(W1.address);
  console.log(`  W1.withdrawable=${fmt(w1Earn)}`);
  console.log(`  W1 parked=${w1Parked}`);
  console.log(`  W1 in matB: hasEverJoined=${w1InB.hasEverJoined}`);
}

main().catch(console.error);
