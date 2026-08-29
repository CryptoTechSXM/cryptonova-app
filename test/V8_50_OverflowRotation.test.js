"use strict";
/**
 * V8_50_OverflowRotation.test.js — O4. Does V8.50 item S FREEZE a saturated pair?
 * Written 2026-08-29, session 49, immediately after item S went green.
 *
 * WHY THIS EXISTS. O1's receipt contains NO MemberCycledOut in pair 1 at all: the
 * diverted member never enters the full MatA, so the entry that used to drive a rotation
 * no longer happens. Live T1.1 sits at rotationCount 1994 precisely BECAUSE those
 * rescue entries keep arriving and churning it.
 *
 * THE RISK, STATED AS THE HYPOTHESIS IT IS: if every rescue diverts away, a saturated
 * pair may stop rotating, and its 254 seated members would stop cycling out and earning.
 * That would be a WORSE bug than the one item S fixes — a growing park queue is visible
 * and reversible; a silently frozen tier is neither, and members would find it first.
 *
 * ⛔ DO NOT DEPLOY ITEM S UNTIL THIS HAS RUN. It is cheap and it is decisive.
 *
 * WHAT IS MEASURED: rotationCount on both halves of pair 1, before and after a run of
 * consecutive rescues out of pair 1's MatB. This test does NOT assert a pass/fail
 * verdict on the economics — that is the owner's call. It PRINTS the number and asserts
 * only the thing that would make the reading meaningless (that the rescues happened at
 * all, and diverted). Read the printed delta and decide.
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
const SIZE = 4;

const EV = new ethers.Interface([
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix)",
  "event RescueOverflowed(address indexed member, uint256 indexed fromPair, uint256 indexed toPair)",
]);

async function deployBase() {
  const [owner, W1, devOps] = await ethers.getSigners();
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: trLib.target } }))
    .deploy(await usdc.getAddress(), owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE, owner.address);
  const lib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await lib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await lib.getAddress() },
  });
  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  return { usdc, treasury, sf, tr, pm, MX, dp, owner, W1, pmAddr: await pm.getAddress() };
}

async function addPair(ctx) {
  const matA = await ctx.MX.deploy(ctx.dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await ctx.MX.deploy(ctx.dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setPairManager(ctx.pmAddr);
    await m.setTierRouter(await ctx.tr.getAddress());
    await m.setStabilityFund(await ctx.sf.getAddress());
    await m.setMatrixKeeper(ctx.owner.address);
    await ctx.treasury.setAuthorizedCaller(await m.getAddress(), true);
    await ctx.sf.setMatrixAuthorized(await m.getAddress(), true);
    await ctx.tr.registerMatrix(await m.getAddress(), 0);
  }
  await ctx.pm.addPair(await matA.getAddress(), await matB.getAddress());
  return { matA, matB };
}

async function newWallet(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}
async function register(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  return ctx.tr.connect(s).register(ref, { gasLimit: 16_000_000 });
}
async function rescue(ctx, matB, victim) {
  const signer = await ethers.getImpersonatedSigner(victim);
  await ethers.provider.send("hardhat_setBalance", [victim, "0x" + (10n ** 20n).toString(16)]);
  await ctx.usdc.mint(victim, FEE * 4n);
  await ctx.usdc.connect(signer).approve(await matB.getAddress(), FEE * 4n);
  return (await matB.connect(signer).selfRescue({ gasLimit: 16_700_000 })).wait();
}

describe("V8.50 item S — O4: does diverting rescues freeze the saturated pair?", function () {
  this.timeout(1_800_000);

  it("O4: rotationCount on a saturated pair, measured across a run of diverted rescues", async function () {
    const ctx = await deployBase();
    const p1  = await addPair(ctx);
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    for (let i = 0; i < SIZE * 14 + 30; i++) {
      await register(ctx, await newWallet(ctx), ctx.W1.address);
      if (await p1.matA.isFull() && await p1.matB.isFull() && (await p1.matB.getParkedCount()) >= 3n) break;
    }
    const p2 = await addPair(ctx);

    expect(await p1.matA.isFull(), "premise failed: P1 MatA not saturated").to.equal(true);
    expect(await p1.matB.isFull(), "premise failed: P1 MatB not saturated").to.equal(true);
    const queue = await p1.matB.getParkedCount();
    expect(queue, "premise failed: need at least 2 parked members to see a trend").to.be.gte(2n);

    const rotA0 = await p1.matA.rotationCount();
    const rotB0 = await p1.matB.rotationCount();
    console.log(`      [before] P1 MatA rot ${rotA0}  MatB rot ${rotB0}  parked in MatB ${queue}`);

    let diverted = 0, cycledInP1 = 0;
    const n = Number(queue > 5n ? 5n : queue);
    for (let i = 0; i < n; i++) {
      const cnt = await p1.matB.getParkedCount();
      if (cnt === 0n) break;
      const victim = await p1.matB.getParkedMember(0);
      const rc = await rescue(ctx, p1.matB, victim);
      for (const l of rc.logs) {
        try {
          const ev = EV.parseLog({ topics: [...l.topics], data: l.data });
          if (ev && ev.name === "RescueOverflowed") diverted++;
          if (ev && ev.name === "MemberCycledOut") cycledInP1++;
        } catch { /* not ours */ }
      }
      console.log(`      [rescue ${i + 1}] P1 MatA rot ${await p1.matA.rotationCount()}` +
                  `  MatB rot ${await p1.matB.rotationCount()}` +
                  `  P2 MatA occ ${await p2.matA.occupancy()}/${SIZE}` +
                  `  P1 parkedB ${await p1.matB.getParkedCount()}`);
    }

    const rotA1 = await p1.matA.rotationCount();
    const rotB1 = await p1.matB.rotationCount();
    console.log(`      [after ] P1 MatA rot ${rotA1} (+${rotA1 - rotA0})  MatB rot ${rotB1} (+${rotB1 - rotB0})`);
    console.log(`      [counts] rescues run ${n} · diverted ${diverted} · cycle-outs anywhere in those txs ${cycledInP1}`);
    console.log(`      >> ${rotA1 === rotA0 && rotB1 === rotB0
      ? "FROZEN — the saturated pair did not rotate once. Item S needs a companion before deploy."
      : "STILL TURNING — the pair kept rotating while its rescues diverted."}`);

    // The only hard assertions are the ones that would make the reading meaningless.
    expect(diverted, "no rescue diverted — item S never fired, so this says nothing about freezing").to.be.greaterThan(0);
    expect(await p2.matA.occupancy(), "pair 2 received nobody — the diversions did not land").to.be.gt(0n);
  });
});
