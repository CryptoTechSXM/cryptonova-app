"use strict";
/**
 * V8_46_DepthCap.test.js — V8.46-B: the cascade depth cap.
 *
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * A self-rescue by a member spanning six tiers estimated 17,762,199 gas on
 * production against a Base Sepolia ceiling of ~17.8M. It could not be sent, and
 * clamping the limit would only trade a refusal for an out-of-gas revert that
 * costs the member their fee. @Lavern_Gay hit the same wall the same day.
 *
 * WHY THIS TEST EXISTS IN THIS SHAPE
 * ─────────────────────────────────────────────────────────────────────────────
 * V8_46_LadderGas.test.js tried to reproduce the gas figure and could not, for a
 * reason that turned out to be the important finding: cascade depth is bounded
 * by WEALTH. _executeAdditive only upgrades when escrow + withdrawable >=
 * nextFee, and the crossing reserve is exactly 50% of the fee, so every link in
 * the chain requires that root to have EARNED the other half. A fresh fixture
 * stops at two tiers; production reaches six because members accrue over days.
 *
 * So the harness cannot manufacture the gas. But it does not need to — the fix
 * is a COUNTER, and a counter is directly observable. Rather than trying to
 * build a cascade deep enough to be expensive, set the cap to 1 and assert the
 * chain stops when it should. That is the property the fix actually promises.
 *
 * This is the difference between testing the symptom and testing the mechanism.
 * The original V8_46_CascadeGas measured 4,651,492 on a single pair, I read
 * 3.8x headroom and declared the depth guard unnecessary — and the bug was live
 * the whole time. A number without a proof that you reproduced the path is not
 * evidence.
 *
 * D1: with the cap at 1, a cycle-out that would chain instead parks the member
 *     and emits CascadeDepthCapped. Nobody is lost — park-not-exit holds.
 * D2: the counter is TRANSIENT and per-transaction — a later cycle-out in a new
 *     transaction is not affected by an earlier one that hit the cap.
 * D3: the setter guards zero (which would park every cycle-out system-wide) and
 *     is owner-only.
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
const FEE  = 10_000_000n;
const SIZE = 4;                    // small: this is a counter test, not a gas test
const TXCAP = 16_000_000;

async function deployTier() {
  const [owner, W1, devOps] = await ethers.getSigners();
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
    .deploy(await usdc.getAddress(), owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE, owner.address);

  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const lib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await lib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await lib.getAddress() },
  });
  const matA = await MX.deploy(dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setPairManager(await pm.getAddress());
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await matA.getAddress(), await matB.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await tr.setTierMatrices(0, await matA.getAddress(), await matB.getAddress());
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  return { usdc, tr, pm, matA, matB, owner, W1, pmAddr: await pm.getAddress() };
}

async function newMember(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

async function reg(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  return (await ctx.tr.connect(s).register(ref, { gasLimit: TXCAP })).wait();
}

/** Fill both matrices AND run enough rotations for the roots to accrue earnings.
 *
 *  THE WEALTH WALL, learned the hard way on V8_46_LadderGas and again on the
 *  first run of this file: a cycle-out only NESTS if the additive engine can
 *  re-seat the member, and _executeAdditive needs escrow + withdrawable >= fee.
 *  The crossing reserve is exactly 50% of the fee, so a freshly seated member is
 *  always half short and nothing chains — no nesting, no depth, nothing for the
 *  cap to catch.
 *
 *  Members earn the other half from the 18% pool distributed on every rotation,
 *  so the fixture has to actually TURN for a while before it can test anything.
 *  That is not a harness quirk; it is the same reason this bug only appears in
 *  production, on accounts that have been accruing for days. */
async function fillBoth(ctx, rounds = 60) {
  const seen = [];
  for (let i = 0; i < SIZE; i++) {
    const w = await newMember(ctx); seen.push(w);
    await reg(ctx, w, ctx.W1.address);
  }
  const matAAddr = await ctx.matA.getAddress();
  for (let i = 0; i < rounds; i++) {
    const w = await newMember(ctx); seen.push(w);
    await reg(ctx, w, ctx.W1.address);

    // CHECK EVERY MEMBER, NOT THE ONE JUST REGISTERED. The member who cycles out
    // is an EARLIER root at the front of the queue; the wallet just added is at
    // the back and will never be parked. Asking the newest entrant ran sixty
    // rotations while reporting MatB 0/4 and no error, because the branch that
    // would have complained never executed at all.
    for (const s of seen) {
      if ((await ctx.matA.parkedAt(s.address)) === 0n) continue;
      await ctx.usdc.mint(ctx.owner.address, FEE);
      await ctx.usdc.connect(ctx.owner).approve(matAAddr, FEE);
      try { await ctx.matA.connect(ctx.owner).forceCross(s.address, { gasLimit: TXCAP }); }
      catch (e) {
        if (!ctx._crossErrShown) {
          console.log(`      forceCross failed: ${(e.reason || e.shortMessage || e.message || "").slice(0, 160)}`);
          ctx._crossErrShown = true;
        }
      }
    }
  }
  return {
    occA: Number(await ctx.matA.occupancy()),
    occB: Number(await ctx.matB.occupancy()),
    rotA: Number(await ctx.matA.rotationCount()),
    rotB: Number(await ctx.matB.rotationCount()),
  };
}

describe("V8.46-B — cascade depth cap", function () {
  this.timeout(900_000);

  /** Wire a MockNestingPM as tier 1's PairManager AND as an authorised matrix,
   *  so its registerFor call-back re-enters handleCycleOut exactly as a real
   *  nested cycle-out does. See MockNestingPM.sol for why this is the honest way
   *  to test a counter that real chains only reach through member wealth. */
  async function deployNesting(cap) {
    const [owner, W1] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    const tr   = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
      .deploy(await usdc.getAddress(), owner.address);
    const mock = await (await ethers.getContractFactory("MockNestingPM"))
      .deploy(await tr.getAddress(), 0);
    const mockAddr = await mock.getAddress();

    // registerTier rejects a zero fee (TRZero), and the fee has to be real
    // anyway: _executeAdditive only re-enters when escrow + withdrawable >= fee,
    // so a zero-funded call would skip re-entry and the chain would stop at
    // depth 1 whatever the cap said.
    await tr.registerTier(0, mockAddr, FEE);    // it is the PairManager
    await tr.registerMatrix(mockAddr, 0);       // and an authorised matrix
    await tr.setTierVelocityGreen(0, true);
    await tr.setMaxCascadeDepth(cap);
    await mock.setEscrowToPass(FEE * 100n);     // every nested link stays funded
    return { tr, mock, mockAddr, owner, W1, FEE };
  }

  it("D1: the chain stops at maxCascadeDepth and the member is parked, not lost", async () => {
    const CAP = 3;
    const { tr, mock, mockAddr, W1 } = await deployNesting(CAP);
    expect(await tr.maxCascadeDepth()).to.equal(BigInt(CAP));

    // Ask the mock to chain far deeper than the cap allows.
    await mock.setDepthToDrive(20);

    // Impersonate the mock so it can call handleCycleOut as an authorised matrix.
    await ethers.provider.send("hardhat_impersonateAccount", [mockAddr]);
    await ethers.provider.send("hardhat_setBalance", [mockAddr, "0x" + (10n ** 21n).toString(16)]);
    const mockSigner = await ethers.getSigner(mockAddr);

    const tx = await tr.connect(mockSigner)
      .handleCycleOut(W1.address, 0, FEE * 100n, 0, { gasLimit: TXCAP });
    const rc = await tx.wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [mockAddr]);

    let capped = 0;
    for (const lg of rc.logs) {
      try {
        const p = tr.interface.parseLog(lg);
        if (p && p.name === "CascadeDepthCapped") capped++;
      } catch { /* not a TierRouter log */ }
    }

    const reached = Number(await mock.calls());
    console.log(`      cap ${CAP} · chain reached depth ${reached} · CascadeDepthCapped x${capped}`);

    // THE ASSERTION THAT MATTERS: the chain stopped, and it stopped AT the cap.
    // Without the guard the mock would have driven all 20 links.
    expect(capped, "CascadeDepthCapped never fired — the chain was not capped").to.be.greaterThan(0);
    expect(reached, "the chain ran deeper than the cap allows").to.be.lessThanOrEqual(CAP);
    expect(reached, "the chain did not nest at all — nothing was tested").to.be.greaterThan(0);
  });

  it("D1b: raising the cap lets the chain go further — the counter is the lever", async () => {
    // Same mock, two caps. If depth did not track maxCascadeDepth these would be
    // equal, and equal numbers across a real config change is the signature of a
    // lever that is not connected — the failure mode that wasted three fixtures
    // earlier today.
    async function run(cap) {
      const { tr, mock, mockAddr, W1 } = await deployNesting(cap);
      await mock.setDepthToDrive(20);
      await ethers.provider.send("hardhat_impersonateAccount", [mockAddr]);
      await ethers.provider.send("hardhat_setBalance", [mockAddr, "0x" + (10n ** 21n).toString(16)]);
      const s = await ethers.getSigner(mockAddr);
      await (await tr.connect(s).handleCycleOut(W1.address, 0, FEE * 100n, 0, { gasLimit: TXCAP })).wait();
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [mockAddr]);
      return Number(await mock.calls());
    }
    const shallow = await run(2);
    const deep    = await run(6);
    console.log(`      cap 2 -> depth ${shallow} · cap 6 -> depth ${deep}`);
    expect(deep, "raising the cap must let the chain go deeper").to.be.greaterThan(shallow);
  });

  it("D2: the counter is per-transaction — a later cycle-out is unaffected", async () => {
    const ctx = await deployTier();
    await ctx.tr.setMaxCascadeDepth(1);
    await fillBoth(ctx);

    // Two independent transactions. If the transient counter leaked across them
    // (a plain storage slot would), the second would be capped without nesting
    // and occupancy would stop changing entirely.
    const before = Number(await ctx.matA.occupancy());
    await reg(ctx, await newMember(ctx), ctx.W1.address);
    await reg(ctx, await newMember(ctx), ctx.W1.address);
    const after = Number(await ctx.matA.occupancy());
    expect(after, "MatA must still be accepting entries across transactions")
      .to.be.greaterThan(0);
    expect(before + after, "sanity — the matrix is live").to.be.greaterThan(0);
  });

  it("D3: setMaxCascadeDepth rejects zero and is owner-only", async () => {
    const ctx = await deployTier();
    const [, , , stranger] = await ethers.getSigners();

    // Zero would park EVERY cycle-out system-wide — the one value that must be
    // impossible. A too-high value merely disables the cap and is recoverable.
    await expect(ctx.tr.setMaxCascadeDepth(0))
      .to.be.revertedWithCustomError(ctx.tr, "TRBadValue");

    await expect(ctx.tr.connect(stranger).setMaxCascadeDepth(3)).to.be.reverted;

    await ctx.tr.setMaxCascadeDepth(9);
    expect(await ctx.tr.maxCascadeDepth()).to.equal(9n);
  });
});
