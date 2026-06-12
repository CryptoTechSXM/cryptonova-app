"use strict";
/**
 * CycleOutDebug.test.js
 * MATRIX_SIZE=4 local test: seed W1 at pos-1, fill to 4, trigger cycle-out on member #5.
 *
 * With MSIZE=4 and V8.7 BPS, W1 earns ~$4.10 from L1+chain pay on 3 fillers — not enough
 * to self-fund the $10 crossing fee. W1 gets parked. The keeper+SF rescue path is then
 * exercised: SF funds the cross, matA.forceCrossKeeper() completes the crossing.
 *
 * This tests the full production parked-wallet rescue flow.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

/** V8.7 7-field SplitConfig */
const SPLITS = {
  l1Bps: 2000, chainBps: 2000, poolBps: 3300,
  treasuryBps: 1500, stabilityBps: 500,
  devBps: 300, opsBps: 200, communityBps: 100, buybackBps: 100,
};  // sum = 10 000
const CP_BPS  = [800, 500, 250, 200, 150, 100];  // sum = 2000 = chainBps
const FEE     = 10_000_000n;  // $10 USDC (6 decimals)
const SF_SEED = 50_000_000n;  // $50 pre-seeded so keeper can fund the rescue

async function deploy(size = 4) {
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

  // DeployParams struct: usdc, cnova, treasury, devOpsWallet, accountOne, admin
  const dp = {
    usdc:         usdcAddr,
    cnova:        cnovaAddr,
    treasury:     tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne:   W1.address,
    admin:        owner.address,
  };

  const MX   = await ethers.getContractFactory("FigureEightMatrixV8");
  const matA = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

  // Wire: partner
  await matA.setPartner(matBAddr);
  await matB.setPartner(matAAddr);

  // Wire: pairManager, tierRouter, stabilityFund on each matrix
  for (const m of [matA, matB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(trAddr);
    await m.setStabilityFund(sfAddr);
  }

  // Set owner as matrixKeeper on matA AND sf (allows keeper rescue calls in tests)
  await matA.setMatrixKeeper(owner.address);
  await sf.setMatrixKeeper(owner.address);

  // PairManager: add pair + set tierRouter
  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);

  // TierRouter
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);

  // Authorize in treasury + SF
  await treasury.setAuthorizedCaller(matAAddr, true);
  await treasury.setAuthorizedCaller(matBAddr, true);
  await sf.setMatrixAuthorized(matAAddr, true);
  await sf.setMatrixAuthorized(matBAddr, true);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);

  // Pre-seed SF: MSIZE=4 gives W1 ~$4.10 in earnings, not enough for the $10 cross.
  // SF covers the gap. In production, keeper checks SF.balanceByTier[tier] >= fee before rescue.
  await usdc.mint(owner.address, SF_SEED);
  await usdc.connect(owner).approve(sfAddr, SF_SEED);
  await sf.connect(owner).receiveLayer(0, SF_SEED, 1);

  return { usdc, cnova, treasury, sf, tr, pm, matA, matB, owner, W1, devOps, sigs };
}

describe("CycleOutDebug", function () {
  this.timeout(120_000);

  it("fills MatA (size=4): W1 parks on cycle-out (insufficient funds), keeper rescues to MatB", async function () {
    const { usdc, treasury, sf, matA, matB, tr, pm, owner, W1, sigs } = await deploy(4);
    const pmAddr   = await pm.getAddress();
    const matAAddr = await matA.getAddress();
    const matBAddr = await matB.getAddress();

    // Confirm treasury auth
    expect(await treasury.authorizedCallers(matAAddr), "MatA not authed in treasury").to.be.true;
    expect(await treasury.authorizedCallers(matBAddr), "MatB not authed in treasury").to.be.true;
    console.log("  treasury auth: OK");

    // Register W1 at position 1
    await usdc.mint(W1.address, FEE);
    await usdc.connect(W1).approve(pmAddr, FEE);
    await tr.connect(W1).register(ethers.ZeroAddress, { gasLimit: 1_000_000 });
    expect(await matA.matrixPos(W1.address)).to.equal(1n);
    console.log("  W1 at position 1: OK");

    // Fill remaining 3 seats
    const fillers = sigs.slice(10, 13);
    for (let i = 0; i < fillers.length; i++) {
      const w   = fillers[i];
      const ref = i === 0 ? W1.address : fillers[i-1].address;
      await usdc.mint(w.address, FEE);
      await usdc.connect(w).approve(pmAddr, FEE);
      await tr.connect(w).register(ref, { gasLimit: 1_000_000 });
    }
    expect(await matA.occupancy()).to.equal(4n);
    console.log("  MatA full (4/4): OK");

    // Trigger cycle-out: 5th member registration
    const cycler = sigs[13];
    await usdc.mint(cycler.address, FEE);
    await usdc.connect(cycler).approve(pmAddr, FEE);

    try {
      const tx   = await tr.connect(cycler).register(fillers[2].address, { gasLimit: 3_000_000 });
      const rcpt = await tx.wait();
      console.log("  Cycle-out TX: OK  gasUsed=" + rcpt.gasUsed.toString());
    } catch (err) {
      console.log("  Cycle-out FAILED:", err.reason || err.message.slice(0, 200));
      try {
        await ethers.provider.call({
          from: cycler.address,
          to:   await tr.getAddress(),
          data: tr.interface.encodeFunctionData("register", [fillers[2].address]),
        });
      } catch (ce) {
        console.log("  eth_call reason:", ce.reason ?? "(null)");
        if (ce.data && ce.data.startsWith("0x4e487b71")) {
          const code = BigInt("0x" + ce.data.slice(10));
          const msgs = {1n:"assert",17n:"overflow/underflow",18n:"div-by-zero",49n:"pop empty array",65n:"alloc too large"};
          console.log("  PANIC:", msgs[code] ?? "code=" + code.toString());
        }
      }
      throw err;
    }

    // ── Phase 2: Verify parked state ─────────────────────────────────────────
    // W1 earns ~$4.10 (L1 from filler0 + chain pay from fillers 0-2).
    // That is less than FEE=$10, so _crossToPartner parks W1 (MemberParked event emitted).
    const w1Parked  = await matA.isParked(W1.address);
    const w1InBpre  = await matB.getMember(W1.address);
    const w1Earn    = await matA.withdrawableOf(W1.address);
    console.log("  W1 parked in matA:          " + w1Parked + " (expect true)");
    console.log("  W1 in matB before rescue:   " + w1InBpre.hasEverJoined + " (expect false)");
    console.log("  W1 withdrawable (earnings): $" + (Number(w1Earn) / 1e6).toFixed(6));
    expect(w1Parked,               "W1 should be parked (earnings < cross fee)").to.be.true;
    expect(w1InBpre.hasEverJoined, "W1 should not be in matB before rescue").to.be.false;

    // ── Phase 3: Keeper rescue ────────────────────────────────────────────────
    // Production flow: MatrixKeeper.performUpkeep() calls _doParkedRescue() which does:
    //   1. sf.payForceCross(tierIdx, sourceMatrix, fee)  — SF sends ENTRY_FEE to matA
    //   2. matA.forceCrossKeeper(member)                 — matA uses those funds to cross
    // Here we call both steps directly with owner acting as keeper.
    await sf.connect(owner).payForceCross(0, matAAddr, FEE);
    await matA.connect(owner).forceCrossKeeper(W1.address);

    const w1InB  = await matB.getMember(W1.address);
    const w1PosB = await matB.matrixPos(W1.address);
    console.log("  W1 in MatB after rescue: hasEverJoined=" + w1InB.hasEverJoined + " pos=" + w1PosB.toString());
    expect(w1InB.hasEverJoined, "W1 should be in matB after keeper rescue").to.be.true;
    expect(w1InB.isInMatrix,    "W1 should be active in matB").to.be.true;
    expect(w1PosB,              "W1 should be at pos 1 in matB").to.equal(1n);
    expect(await matA.getParkedCount(), "parked queue should be empty after rescue").to.equal(0n);
    console.log("  SUCCESS: W1 rescued by keeper and crossed to MatB at position 1");
  });
});
