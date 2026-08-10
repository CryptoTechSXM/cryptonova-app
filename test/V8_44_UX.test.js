"use strict";
/**
 * V8_44_UX.test.js — V8.44 UX batch (plan items C2, G1, G2, G3, I3).
 *
 *  UX1. registerWithOptions — one-popup registration with options folded in.
 *  UX2. registerWithPermit — EIP-2612 signature approval, no approve tx.
 *  UX3. C2: bulkUpgrade honors the manualUpgrade three-way eligibility
 *       (cycle-completed member upgrades with the Whale Gate CLOSED).
 *  UX4. G3: hybridUpgrade — free earnings drawn first, wallet tops up the rest.
 *  UX5. G2: bulkWithdraw sweeps every matrix with a free balance in one tx.
 *  UX6. I3: exitSeat — voluntary mid-cycle exit releases the crossing reserve
 *       minus the DAO-tunable penalty (earnings never penalized).
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE1 = 10_000_000n;   // T1 $10
const FEE2 = 7_000_000n;    // T2 $7
const SIZE = 7;

async function deployTwoTiers() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
    .deploy(await usdc.getAddress(), owner.address);
  const pm1 = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE1, owner.address);
  const pm2 = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE2, owner.address);

  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await matrixLib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });

  const mk = async (isA, tier, fee) => MX.deploy(dp, fee, SIZE, isA, tier, SPLITS, CP_BPS);
  const matA1 = await mk(true, 0, FEE1), matB1 = await mk(false, 0, FEE1);
  const matA2 = await mk(true, 1, FEE2), matB2 = await mk(false, 1, FEE2);

  const wire = async (a, b, pm) => {
    await a.setPartner(await b.getAddress());
    await b.setPartner(await a.getAddress());
    for (const m of [a, b]) {
      await m.setPairManager(await pm.getAddress());
      await m.setTierRouter(await tr.getAddress());
      await m.setStabilityFund(await sf.getAddress());
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
    }
    await pm.addPair(await a.getAddress(), await b.getAddress());
    await pm.setTierRouter(await tr.getAddress());
  };
  await wire(matA1, matB1, pm1);
  await wire(matA2, matB2, pm2);

  await tr.registerTier(0, await pm1.getAddress(), FEE1);
  await tr.registerTier(1, await pm2.getAddress(), FEE2);
  await tr.setTierMatrices(0, await matA1.getAddress(), await matB1.getAddress());
  await tr.setTierMatrices(1, await matA2.getAddress(), await matB2.getAddress());
  for (const m of [matA1, matB1]) await tr.registerMatrix(await m.getAddress(), 0);
  for (const m of [matA2, matB2]) await tr.registerMatrix(await m.getAddress(), 1);
  await sf.setTierFee(0, FEE1);
  await sf.setTierFee(1, FEE2);
  await sf.setTierRouter(await tr.getAddress());

  return { usdc, tr, pm1, pm2, matA1, matB1, matA2, matB2, sf, owner, W1, devOps, sigs };
}

async function reg(ctx, signer, referrer, fee = FEE1, pm = null) {
  const pmAddr = await (pm || ctx.pm1).getAddress();
  await ctx.usdc.mint(signer.address, fee);
  await ctx.usdc.connect(signer).approve(pmAddr, fee);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

describe("V8.44 — UX batch (C2, G1, G2, G3, I3)", function () {
  this.timeout(600_000);

  it("UX1: registerWithOptions — options set in the same tx as registration", async function () {
    const ctx = await deployTwoTiers();
    const { usdc, tr, pm1, W1 } = ctx;
    await usdc.mint(W1.address, FEE1);
    await usdc.connect(W1).approve(await pm1.getAddress(), FEE1);
    await tr.connect(W1).registerWithOptions(ethers.ZeroAddress, false, true, false, { gasLimit: 16_000_000 });

    expect(await tr.globalJoined(W1.address)).to.equal(true);
    const opts = await tr.getMemberOptions(W1.address);
    expect(opts.optionsSet).to.equal(true);
    expect(opts.autoReentryEnabled).to.equal(true);
    expect(opts.autoUpgradeDisabled).to.equal(false);
  });

  it("UX2: registerWithPermit — EIP-2612 signature, zero approve transactions", async function () {
    const ctx = await deployTwoTiers();
    const { usdc, tr, pm1, sigs } = ctx;
    const member = sigs[20];
    await usdc.mint(member.address, FEE1);

    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "USD Coin", version: "1",
      chainId: net.chainId, verifyingContract: await usdc.getAddress(),
    };
    const types = {
      Permit: [
        { name: "owner",    type: "address" },
        { name: "spender",  type: "address" },
        { name: "value",    type: "uint256" },
        { name: "nonce",    type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    // Deadline must come from CHAIN time, not wall-clock: in a full-suite run
    // earlier tests advance block.timestamp by months (vesting/epoch suites),
    // which would silently expire the permit (the try/catch would swallow it).
    const blk = await ethers.provider.getBlock("latest");
    const deadline = BigInt(blk.timestamp + 3600);
    const values = {
      owner: member.address,
      spender: await pm1.getAddress(),   // PairManager pulls the entry fee
      value: FEE1,
      nonce: await usdc.nonces(member.address),
      deadline,
    };
    const sig = ethers.Signature.from(await member.signTypedData(domain, types, values));

    // No approve() anywhere — the permit signature IS the approval.
    await tr.connect(member).registerWithPermit(
      ethers.ZeroAddress, false, true, false,
      FEE1, deadline, sig.v, sig.r, sig.s,
      { gasLimit: 16_000_000 }
    );
    expect(await tr.globalJoined(member.address)).to.equal(true);
    expect((await tr.getMemberOptions(member.address)).autoReentryEnabled).to.equal(true);
  });

  it("UX3 (C2): bulkUpgrade accepts cycle-completed eligibility with the Whale Gate CLOSED", async function () {
    const ctx = await deployTwoTiers();
    const { usdc, tr, owner, W1, sigs } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    const other = sigs[21];
    await reg(ctx, other, W1.address);

    // Record a completed T1 cycle for W1 through an owner-authorized "matrix"
    // (unit shortcut — handleCycleOut is the only tierCycles writer). W1 opts
    // out of re-entry (reentryMinCycles=1 so the choice applies) so the
    // additive engine takes no seat and makes no matrix callbacks (the "matrix"
    // here is an EOA).
    await tr.connect(owner).setReentryMinCycles(1);
    await tr.connect(W1).setMemberOptions(false, false, false);
    await tr.registerMatrix(owner.address, 0);
    await tr.connect(owner).handleCycleOut(W1.address, 0, 0, 0);
    expect(await tr.tierCycles(W1.address, 0)).to.equal(1n);
    expect(await tr.isWhaleGateActiveForTier(5)).to.equal(false); // T2 gate closed

    // V8.43 BUG: bulkUpgrade required the gate only → reverted here.
    await usdc.mint(W1.address, FEE2);
    await usdc.connect(W1).approve(await tr.getAddress(), FEE2);
    await tr.connect(W1).bulkUpgrade(1, { gasLimit: 16_000_000 });
    expect(await tr.memberHighestTier(W1.address)).to.equal(2);

    // Control: a member with no cycle, not in MatB, gate closed → still blocked.
    await usdc.mint(other.address, FEE2);
    await usdc.connect(other).approve(await tr.getAddress(), FEE2);
    await expect(tr.connect(other).bulkUpgrade(1, { gasLimit: 16_000_000 }))
      .to.be.revertedWithCustomError(tr, "TRGate");
  });

  it("UX4 (G3): hybridUpgrade draws free earnings first, wallet covers only the shortfall", async function () {
    const ctx = await deployTwoTiers();
    const { usdc, tr, matA1, matA2, owner, W1, sigs } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    // FOUR referrals, not six — SETUP ADJUSTED FOR V8.48 ITEM 1, assertion unchanged.
    //
    // This test needs W1's free earnings to fall SHORT of the fee, because the shortfall
    // is the entire thing hybridUpgrade exists to cover. Six referrals used to produce
    // that, but only because freeWithdrawable applied the crossing-reserve lock even to a
    // member who had opted OUT of automation — the comment below ("frees earnings beyond
    // the crossing lock") describes exactly that now-corrected behaviour.
    //
    // Item 1 made the view mirror withdrawCore, which does NOT lock the crossing reserve
    // when automation is off. So six referrals now yield $7.852 against a $7.00 fee and
    // there is no shortfall left to test. Four keeps a comfortable one.
    //
    // THE ASSERTIONS BELOW ARE UNTOUCHED. This test protects a real member-facing
    // invariant — earnings are spent first, the wallet pays only the difference — and that
    // invariant did not change. Only the fixture's ability to construct the scenario did.
    // The setup guard on line ~202 is what caught this, loudly, instead of the test
    // quietly passing on a case it was no longer exercising.
    for (let i = 0; i < 4; i++) await reg(ctx, sigs[10 + i], W1.address); // L1 earnings → W1

    // Disable W1's automation so reservedFor = 0 (with item 1, this frees the FULL balance)
    await tr.connect(W1).setMemberOptions(true, false, false);
    // Open the T2-T5 gate so W1 is upgrade-eligible without a cycle
    await tr.connect(owner).setTierWhaleGateActive(5, true);

    const free = await matA1.freeWithdrawable(W1.address);
    expect(free, "setup: W1 needs some free earnings").to.be.gt(0n);
    expect(free, "setup: free earnings must NOT cover the full fee").to.be.lt(FEE2);

    const wBefore   = await matA1.withdrawableOf(W1.address);
    const walletBal = FEE2; // mint exactly the fee; only the shortfall may be pulled
    await usdc.mint(W1.address, walletBal);
    await usdc.connect(W1).approve(await tr.getAddress(), walletBal);
    const balBefore = await usdc.balanceOf(W1.address);

    await tr.connect(W1).hybridUpgrade(1, { gasLimit: 16_000_000 });

    expect(await matA2.isActiveInMatrix(W1.address), "seated in T2").to.equal(true);
    const walletSpent = balBefore - (await usdc.balanceOf(W1.address));
    expect(walletSpent, "wallet pays only the shortfall").to.equal(FEE2 - free);
    expect(await matA1.withdrawableOf(W1.address)).to.equal(wBefore - free);
    expect(await tr.memberHighestTier(W1.address)).to.equal(2);
  });

  it("UX5 (G2): bulkWithdraw sweeps free balances across matrices in one tx", async function () {
    const ctx = await deployTwoTiers();
    const { usdc, tr, matA1, W1, sigs } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    for (let i = 0; i < 6; i++) await reg(ctx, sigs[10 + i], W1.address);

    // All automation off → reservedFor = 0 → full balance withdrawable.
    await tr.connect(W1).setMemberOptions(true, false, false);

    const bal = await matA1.withdrawableOf(W1.address);
    expect(bal).to.be.gt(0n);
    const feeBps = await matA1.withdrawalFeeBps();
    const expectedNet = bal - (bal * feeBps) / 10_000n;

    const before = await usdc.balanceOf(W1.address);
    await tr.connect(W1).bulkWithdraw({ gasLimit: 16_000_000 });
    const got = (await usdc.balanceOf(W1.address)) - before;

    expect(got, "swept net of withdrawal fee").to.equal(expectedNet);
    expect(await matA1.withdrawableOf(W1.address)).to.equal(0n);
  });

  it("UX6 (I3): exitSeat releases the crossing reserve minus penalty; earnings untouched", async function () {
    const ctx = await deployTwoTiers();
    const { tr, matA1, sf, W1, sigs } = ctx;
    await reg(ctx, W1, ethers.ZeroAddress);
    for (let i = 0; i < 6; i++) await reg(ctx, sigs[10 + i], W1.address);

    const quitter = sigs[13]; // f4 — passive, seated, reserve $5
    expect(await matA1.isActiveInMatrix(quitter.address)).to.equal(true);
    const reserve = await matA1.crossingReserveOf(quitter.address);
    expect(reserve).to.equal(FEE1 / 2n);
    const wBefore = await matA1.withdrawableOf(quitter.address);
    const occBefore = await matA1.occupancy();

    expect(await matA1.exitPenaltyBps()).to.equal(2_000n); // default 20%
    await matA1.connect(quitter).exitSeat({ gasLimit: 16_000_000 });

    expect(await matA1.isActiveInMatrix(quitter.address)).to.equal(false);
    expect(await matA1.crossingReserveOf(quitter.address)).to.equal(0n);
    const penalty = (reserve * 2_000n) / 10_000n;
    expect(await matA1.withdrawableOf(quitter.address)).to.equal(wBefore + reserve - penalty);
    expect(await matA1.occupancy()).to.equal(occBefore - 1n);

    // Full liquidity after exit: everything withdrawable (no locks — not seated).
    await tr.connect(quitter).setMemberOptions(true, false, false);
    await matA1.connect(quitter).withdraw();
    expect(await matA1.withdrawableOf(quitter.address)).to.equal(0n);
  });
});
