"use strict";
/**
 * V8_44_PoolEquivalence.test.js — item D property test.
 *
 * Replays the EXACT V8.43 per-rotation credit loop in JS from the on-chain
 * event stream (PoolDistributed / MemberEntered / MemberCycledOut /
 * SlotParkedIdle / SlotReclaimed reconstruct every member's position at every
 * rotation), then compares against the V8.44 pull-based accounting
 * (PoolShareCredited sums + pendingPoolOf) across a seeded randomized
 * join/rotate/withdraw/force-cross sequence.
 *
 * EXPECTED EQUIVALENCE (documented in MatrixLogicLib):
 *  - In exact arithmetic the closed form equals the old loop to the wei.
 *  - Integer division differs ONLY in flooring: the old loop floored once per
 *    rotation, the pull model floors once per settle. Per-member deviation is
 *    therefore bounded by the number of rotations the member sat through
 *    (in USDC wei = 1e-6 $), and the pull model never pays MORE than exact.
 *  - The old loop's per-rotation dust sweep to seat 2 is intentionally gone;
 *    the JS reference excludes dust and tracks it separately.
 *  - Conservation: Σ credited + Σ pending ≤ Σ pool folded in.
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
const SIZE = 7;

async function deploySystem() {
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
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE, owner.address);
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
  const matA = await MX.deploy(dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setPairManager(await pm.getAddress());
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await matA.setMatrixKeeper(owner.address);
  await pm.addPair(await matA.getAddress(), await matB.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await tr.setTierMatrices(0, await matA.getAddress(), await matB.getAddress());
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  return { usdc, tr, pm, matA, matB, owner, W1, devOps, sigs };
}

// Seeded PRNG (LCG) for reproducibility
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / (1 << 23); };
}

/** V8.43 reference: replay the old per-rotation loop from the event stream. */
async function v843Reference(mat) {
  const filterAll = async (f) => (await mat.queryFilter(f, 0)).map((l) => ({
    name: l.fragment.name, args: l.args, block: l.blockNumber, index: l.index,
  }));
  const evs = [
    ...(await filterAll(mat.filters.PoolDistributed())),
    ...(await filterAll(mat.filters.MemberEntered())),
    ...(await filterAll(mat.filters.MemberCycledOut())),
    ...(await filterAll(mat.filters.SlotReclaimed())),
    ...(await filterAll(mat.filters.SlotParkedIdle ? mat.filters.SlotParkedIdle() : mat.filters.SlotReclaimed())),
  ].sort((a, b) => (a.block - b.block) || (a.index - b.index));

  const W = BigInt(SIZE * (SIZE + 1) / 2 - 1);
  const pos = new Map();            // member -> position
  const credited = new Map();       // member -> total (V8.43 loop, no dust)
  let dust = 0n, totalPool = 0n, rotations = 0;
  const seatEvents = new Map();     // member -> rotations sat through

  for (const e of evs) {
    if (e.name === "PoolDistributed") {
      const P = BigInt(e.args[0]);
      totalPool += P; rotations += 1;
      let distributed = 0n;
      for (const [m, p] of pos) {
        if (p >= 2 && p <= SIZE) {
          const share = (P * BigInt(p)) / W;
          credited.set(m, (credited.get(m) || 0n) + share);
          distributed += share;
          seatEvents.set(m, (seatEvents.get(m) || 0) + 1);
        }
      }
      dust += P - distributed;
    } else if (e.name === "MemberEntered") {
      pos.set(e.args[0], Number(e.args[1]));
    } else if (e.name === "MemberCycledOut") {
      pos.delete(e.args[0]);
      for (const [m, p] of pos) pos.set(m, p - 1);
    } else if (e.name === "SlotReclaimed" || e.name === "SlotParkedIdle") {
      pos.delete(e.args[0]);
    }
  }
  return { credited, dust, totalPool, rotations, seatEvents };
}

/** V8.44 actual: PoolShareCredited sums + live pending. */
async function v844Actual(mat, members) {
  const credited = new Map();
  for (const l of await mat.queryFilter(mat.filters.PoolShareCredited(), 0)) {
    const m = l.args[0];
    credited.set(m, (credited.get(m) || 0n) + BigInt(l.args[2]));
  }
  for (const m of members) {
    const pend = await mat.pendingPoolOf(m);
    if (pend > 0n) credited.set(m, (credited.get(m) || 0n) + pend);
  }
  return credited;
}

describe("V8.44 — pull-based pool: property equivalence vs V8.43 loop", function () {
  this.timeout(600_000);

  it("randomized join/withdraw/force-cross sequence: per-member match within flooring bound; conservation holds", async function () {
    const ctx = await deploySystem();
    const { usdc, tr, pm, matA, matB, owner, W1, sigs } = ctx;
    const rand = lcg(42);
    const pmAddr = await pm.getAddress();
    const matAAddr = await matA.getAddress();

    const joined = [];
    const regNew = async () => {
      const w = sigs[10 + joined.length];
      const ref = joined.length === 0 || rand() < 0.3
        ? (joined.length ? joined[Math.floor(rand() * joined.length)].address : ethers.ZeroAddress)
        : W1.address;
      await usdc.mint(w.address, FEE);
      await usdc.connect(w).approve(pmAddr, FEE);
      await tr.connect(w).register(joined.length === 0 ? ethers.ZeroAddress : ref, { gasLimit: 16_000_000 });
      joined.push(w);
    };

    // Seed + fill: W1 then 6 fillers
    for (let i = 0; i < SIZE; i++) await regNew();

    // Randomized op mix. Stop before MatB fills (avoid handleCycleOut path —
    // debt-free, single-matrix-rotation-at-a-time keeps the reference exact).
    let crossings = 0;
    for (let op = 0; op < 22 && crossings < SIZE - 1; op++) {
      const r = rand();
      if (r < 0.55) {
        await regNew();                                    // may rotate MatA
      } else if (r < 0.8) {
        // force-cross a parked member into MatB (owner-funded, no debt)
        let parked = null;
        for (const s of joined) {
          if ((await matA.parkedAt(s.address)) > 0n) { parked = s; break; }
        }
        if (parked) {
          await usdc.mint(owner.address, FEE);
          await usdc.connect(owner).approve(matAAddr, FEE);
          await matA.connect(owner).forceCross(parked.address, { gasLimit: 16_000_000 });
          crossings++;
        } else {
          await regNew();
        }
      } else {
        // mid-ride withdraw — forces a settle checkpoint at a random moment
        for (const s of joined) {
          const free = await matA.freeWithdrawable(s.address);
          if (free > 0n) { await matA.connect(s).withdraw(); break; }
        }
      }
    }

    const memberAddrs = joined.map((s) => s.address);
    for (const mat of [matA, matB]) {
      const ref = await v843Reference(mat);
      if (ref.rotations === 0) continue;
      const act = await v844Actual(mat, memberAddrs);

      let sumActual = 0n;
      const names = new Set([...ref.credited.keys(), ...act.credited?.keys?.() || act.keys()]);
      for (const m of names) {
        const expected = ref.credited.get(m) || 0n;
        const actual   = act.get(m) || 0n;
        sumActual += actual;
        const bound = BigInt((ref.seatEvents.get(m) || 0) + 1);
        const diff = expected > actual ? expected - actual : actual - expected;
        expect(diff, `pool mismatch for ${m}: v843=${expected} v844=${actual} (bound ${bound})`)
          .to.be.lte(bound);
      }
      // Conservation: never credit more than the pool folded in.
      expect(sumActual, "over-distribution").to.be.lte(ref.totalPool);
      // And the model must not silently under-pay beyond dust + flooring:
      const slack = ref.totalPool - sumActual;
      const slackBound = ref.dust + BigInt(ref.rotations * (SIZE + 2));
      expect(slack, `under-distribution beyond dust+flooring (dust=${ref.dust})`).to.be.lte(slackBound);
    }
  });
});
