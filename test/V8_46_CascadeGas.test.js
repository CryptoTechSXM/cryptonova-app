"use strict";
/**
 * V8_46_CascadeGas.test.js — the production-size gate that has never been run.
 *
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * Two open items both need a 127-seat matrix, and neither can be answered at
 * the SIZE=4 used by the other suites:
 *
 *  1. CASCADE GAS. Listed as a V8.44 deploy gate ("cascade gas < 17.8M") and
 *     never run until now.
 *
 *     RESULT (2026-07-27): worst-case single-pair cascade = 4,651,492 gas
 *     against a 17,800,000 cap — 3.8x headroom. Plain entry 734,647; peak entry
 *     during rotation 5,127,660.
 *
 *     THIS DISPROVES the gas hypothesis for the 8 silent graduations. The theory
 *     was that try/catch forwards only 63/64 of remaining gas (EIP-150), so an
 *     out-of-gas inner call would revert, the empty catch at MatrixLogicLib:513
 *     would swallow it, and the outer tx would still succeed with its 1/64 — a
 *     successful transaction with a vanished member and no events. That is what
 *     W1's trail showed, but at 3.8x headroom a single-pair cascade cannot
 *     exhaust gas. Fee mismatch and router funding were already eliminated by
 *     diag_cycleout_revert.js. The cause of those 8 graduations is STILL UNKNOWN.
 *
 *     NOT MEASURED HERE: the multi-tier ladder cascade. This fixture wires ONE
 *     tier. Live, a cycle-out continues into re-entry -> upgrade into the NEXT
 *     tier's matrix -> possibly a double seat, each with its own rotation. That
 *     is what CLAUDE.md's "~15.5M full-matrix cascade" refers to, and all 8
 *     victims were wallets spanning many tiers (W1 held T1-T8). It remains the
 *     best surviving candidate and needs its own fixture.
 *
 *  2. S2 ROUTING COVERAGE. V8.46-A (re-entry always seats in own MatA) has no
 *     unit test. Three attempts failed at SIZE=4 because a member's MatB balance
 *     comes only from pool accrual inside MatB — 18% split across its seats. With
 *     4 seats and ~12 rotations that is pennies against a 50% shortfall, so no
 *     re-entry ever fires. At 127 seats with real rotation volume, members
 *     accumulate enough to self-fund, which is why live T1.1 MatB has produced
 *     roughly 1,600 funded re-entries.
 *
 * SLOW BY DESIGN — this fills 127 seats and drives crossings, so it takes
 * minutes. Run it as a gate, not on every save:
 *     npx hardhat test test/V8_46_CascadeGas.test.js
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
const SIZE = 127;                 // PRODUCTION size — the whole point of this file
const RPC_GAS_CAP = 17_800_000n;  // public Base Sepolia rejects above ~17.8M (-32003)
// Hardhat refuses a single tx above 2^24 = 16,777,216 gas, which is BELOW the
// real cap. That is convenient rather than limiting: anything hardhat cannot
// even fund would certainly fail on-chain, so a pass here is conservative.
// It does mean we cannot observe usage between 16.78M and 17.8M — if a cascade
// runs out of gas at this limit, treat it as "over budget", not "unmeasurable".
const HARDHAT_TX_CAP = 16_000_000;

async function deployPair() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter"))
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
  await pm.setEntryThresholds(1, 2);
  return { usdc, tr, pm, matA, matB, owner, W1, members: [], pmAddr: await pm.getAddress() };
}

async function newMember(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

/** Register `s`, returning the receipt so gas can be read. */
async function reg(ctx, s, ref) {
  await ctx.usdc.mint(s.address, FEE);
  await ctx.usdc.connect(s).approve(ctx.pmAddr, FEE);
  const tx = await ctx.tr.connect(s).register(ref, { gasLimit: HARDHAT_TX_CAP });
  ctx.members.push(s);
  return await tx.wait();
}

/** Owner-funded force-cross of parked MatA members so MatB fills. */
async function drainParkedIntoMatB(ctx, cap = 400) {
  const matAAddr = await ctx.matA.getAddress();
  let done = 0;
  for (const s of ctx.members) {
    if (done >= cap) break;
    if ((await ctx.matA.parkedAt(s.address)) > 0n) {
      await ctx.usdc.mint(ctx.owner.address, FEE);
      await ctx.usdc.connect(ctx.owner).approve(matAAddr, FEE);
      try {
        await ctx.matA.connect(ctx.owner).forceCross(s.address, { gasLimit: HARDHAT_TX_CAP });
        done++;
      } catch { /* already crossed or not eligible */ }
    }
  }
  return done;
}

describe("V8.46 — production-size cascade: gas gate + routing proof", function () {
  this.timeout(2_400_000);   // 40 minutes; 127 seats is genuinely slow

  it("measures worst-case cascade gas at 127 seats and proves re-entry routing", async function () {
    const ctx = await deployPair();
    const { matA, matB, W1 } = ctx;
    const matAAddr = (await matA.getAddress()).toLowerCase();
    const matBAddr = (await matB.getAddress()).toLowerCase();

    // ── Phase 1: fill MatA to 127/127 ───────────────────────────────────────
    await reg(ctx, W1, ethers.ZeroAddress);
    let baselineGas = 0n;
    for (let i = 1; i < SIZE; i++) {
      const rc = await reg(ctx, await newMember(ctx), W1.address);
      if (i === 10) baselineGas = rc.gasUsed;      // plain seat, no rotation
    }
    expect(await matA.occupancy()).to.equal(BigInt(SIZE));
    console.log(`      MatA filled 127/127 · baseline plain-entry gas ${baselineGas.toLocaleString()}`);

    // ── Phase 2: drive rotations so MatB fills and members accrue pool ──────
    let maxRotGas = 0n;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 40; i++) {
        const rc = await reg(ctx, await newMember(ctx), W1.address);
        if (rc.gasUsed > maxRotGas) maxRotGas = rc.gasUsed;
      }
      const crossed = await drainParkedIntoMatB(ctx);
      const bOcc = await matB.occupancy();
      console.log(`      round ${round + 1}: MatB ${bOcc}/${SIZE} · crossed ${crossed} · ` +
                  `peak entry gas so far ${maxRotGas.toLocaleString()}`);
      if (bOcc >= BigInt(SIZE)) break;
    }

    // ── Phase 3: the deepest cascade — entry into a FULL MatA whose partner
    //    MatB is also full. Root cycles out of MatA, crosses into a full MatB,
    //    which cycles ITS root out, which re-enters. This is the path that
    //    silently graduated 5 wallets on V8.45.
    const bOccFinal = await matB.occupancy();
    console.log(`      MatB at ${bOccFinal}/${SIZE} before the worst-case entry`);

    const rcWorst = await reg(ctx, await newMember(ctx), W1.address);
    const worstGas = rcWorst.gasUsed;
    console.log(`\n      WORST-CASE CASCADE GAS: ${worstGas.toLocaleString()} ` +
                `(cap ${RPC_GAS_CAP.toLocaleString()}, headroom ` +
                `${(RPC_GAS_CAP - worstGas).toLocaleString()})`);

    // ── Routing proof (closes the S2 gap): pair MemberReentered with the
    //    MemberRouted in the same tx and read the destination matrix.
    const reentered = ethers.id("MemberReentered(address,uint8)");
    const routed    = ethers.id("MemberRouted(address,uint256,address)");
    const logs = await ethers.provider.getLogs({ fromBlock: 0, toBlock: "latest" });
    const byTx = new Map();
    for (const lg of logs) {
      if (lg.topics[0] !== reentered && lg.topics[0] !== routed) continue;
      if (!byTx.has(lg.transactionHash)) byTx.set(lg.transactionHash, { re: false, dests: [] });
      const rec = byTx.get(lg.transactionHash);
      if (lg.topics[0] === reentered) rec.re = true;
      else rec.dests.push(("0x" + lg.data.slice(-40)).toLowerCase());
    }
    const dests = [];
    for (const [, rec] of byTx) if (rec.re) dests.push(...rec.dests);
    const toA = dests.filter(d => d === matAAddr).length;
    const toB = dests.filter(d => d === matBAddr).length;
    console.log(`      funded re-entries: ${dests.length} -> MatA ${toA}, MatB ${toB}\n`);

    // ── THE GATE ────────────────────────────────────────────────────────────
    expect(worstGas, `cascade uses ${worstGas} gas, over the ~17.8M public-RPC cap. ` +
      `Registrations will fail with -32003 and, on V8.45, members vanish silently ` +
      `because the empty catch swallows the out-of-gas. V8.46-B (depth guard) is REQUIRED.`)
      .to.be.lt(RPC_GAS_CAP);

    // Routing assertion only when the harness actually produced a funded
    // re-entry — otherwise say so rather than passing vacuously.
    if (dests.length > 0) {
      expect(toB, `${toB} re-entry/-ies routed to MatB — MatA loses its only entry ` +
                  `source and freezes. V8.46-A is not in effect.`).to.equal(0);
      expect(toA, "re-entries fired but none landed in MatA").to.be.greaterThan(0);
    } else {
      console.log("      NOTE: no funded re-entry occurred even at 127 seats — the routing");
      console.log("      assertion did not run. Increase rounds or referral volume.");
    }
  });
});
