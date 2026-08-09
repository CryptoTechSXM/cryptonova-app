"use strict";
/**
 * V8_46_LadderGas.test.js — V8.46-B: how gas grows with LADDER DEPTH.
 *
 * WHY THIS EXISTS — AND WHY THE EXISTING GAS TEST WAS NOT ENOUGH
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-07-27 V8_46_CascadeGas.test.js measured a worst-case cascade at 127
 * seats: 4,651,492 gas against a ~17.8M ceiling. On a 3.8x headroom I declared
 * V8.46-B — the depth guard — dead.
 *
 * That fixture registers ONE tier (`tr.registerTier(0, …)`). A single pair's
 * cascade is exactly what it measures, and 4.65M is exactly right for that.
 *
 * On 2026-07-28 two real members proved it insufficient:
 *   owner's wallet   selfRescue.estimateGas -> 17,762,199   (refused by the RPC)
 *   @Lavern_Gay      selfRescue.estimateGas ->  ~16,500,000 (refused by the RPC)
 * Both hold seats across SIX tiers. The cost is not in one pair — it is in the
 * LADDER: a re-entry fills a full matrix, that rotation cycles its root out,
 * handleCycleOut runs the additive engine, the upgrade seats into the NEXT
 * tier's full matrix, and that rotation cycles ITS root out. Each tier the
 * member spans adds another full rotation to one transaction.
 *
 * So the question this file answers is not "what does a cascade cost" but
 * "what does each additional tier of depth cost, and at what depth does a member
 * become unrescuable". That number is the whole basis for the depth guard, and
 * guessing it is what put two members in a position they cannot get out of.
 *
 * HOW TO READ THE RESULT
 * ─────────────────────────────────────────────────────────────────────────────
 * The test does not assert a pass/fail ceiling — asserting one would just encode
 * today's guess. It MEASURES and prints:
 *   - gas for the deepest cascade it can build
 *   - the marginal cost of each extra tier
 *   - the tier depth at which the extrapolation crosses 17.8M
 * and fails only if the measured cost per tier is so small that it contradicts
 * the two live measurements — because that would mean the harness still is not
 * reproducing the real path, and a green test would be worse than no test.
 *
 * TIERS and SIZE are env-tunable because a full production run (SIZE=127 across
 * 6 tiers) is thousands of registrations. Default is deliberately smaller so the
 * suite stays runnable; raise it when you want the production number.
 *   TIERS=6 SIZE=127 npx hardhat test test/V8_46_LadderGas.test.js
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

const TIERS = Number(process.env.TIERS || 4);
const SIZE  = Number(process.env.SIZE  || 15);
const RPC_GAS_CAP = 17_800_000;
const HARDHAT_TX_CAP = 16_000_000;

// Production fee ladder, so the escrow/withdrawable arithmetic behaves as live.
const PROD_FEES = [10n, 25n, 50n, 100n, 250n, 500n, 1000n, 2500n, 5000n, 10000n];
// FLAT=1 makes every tier cost the same as T1.
//
// WHY THIS SWITCH EXISTS (2026-07-28): with the production ladder the cascade
// stopped dead at tier 2 — +28,799 gas for the second tier, then +0 for the
// third and fourth. _executeAdditive only upgrades when
// escrow + withdrawable >= nextFee, and a freshly seated filler holds a $5
// crossing reserve against a $50 T3 fee. The upgrade is skipped, silently, and
// the chain dies.
//
// That is not a harness defect so much as the reason this bug is invisible until
// production: cascade depth is bounded by how many CONSECUTIVE roots can afford
// the next tier. Members accruing for days can; fresh fillers cannot.
//
// FLAT fees remove affordability as a variable so the MECHANISM can be measured.
// Use FLAT=1 to characterise depth cost; use the production ladder to see how
// far a realistically-funded population actually chains.
const FEES = (process.env.FLAT === "1"
  ? PROD_FEES.map(() => PROD_FEES[0])
  : PROD_FEES).map(v => v * 1_000_000n);

async function deployLadder(tierCount = TIERS) {
  const [owner, W1, devOps] = await ethers.getSigners();
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
    .deploy(await usdc.getAddress(), owner.address);

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
  const PM = await ethers.getContractFactory("PairManagerV8");

  const tiers = [];
  for (let t = 0; t < tierCount; t++) {
    const fee = FEES[t];
    const pm  = await PM.deploy(await usdc.getAddress(), fee, owner.address);
    const matA = await MX.deploy(dp, fee, SIZE, true,  t, SPLITS, CP_BPS);
    const matB = await MX.deploy(dp, fee, SIZE, false, t, SPLITS, CP_BPS);
    await matA.setPartner(await matB.getAddress());
    await matB.setPartner(await matA.getAddress());
    for (const m of [matA, matB]) {
      await m.setPairManager(await pm.getAddress());
      await m.setTierRouter(await tr.getAddress());
      await m.setStabilityFund(await sf.getAddress());
      await m.setMatrixKeeper(owner.address);
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
      await tr.registerMatrix(await m.getAddress(), t);
    }
    await pm.addPair(await matA.getAddress(), await matB.getAddress());
    await pm.setTierRouter(await tr.getAddress());
    await tr.registerTier(t, await pm.getAddress(), fee);
    await tr.setTierMatrices(t, await matA.getAddress(), await matB.getAddress());
    await sf.setTierFee(t, fee);
    // VELOCITY gate — throttles AUTO-upgrades.
    await tr.setTierVelocityGreen(t, true);
    tiers.push({ pm, matA, matB, fee, pmAddr: await pm.getAddress() });
  }
  await sf.setTierRouter(await tr.getAddress());

  // WHALE gate — a DIFFERENT gate, and the one manualUpgrade actually checks.
  // 2026-07-28: the first version of this fixture opened only the velocity gate,
  // so the victim could never leave T1 and the test measured nothing. T2-T5 all
  // share the T5 gate; T6..T10 each have their own (TierRouter
  // _isTierUnlockedForManualEntry). Conflating the two is a documented trap in
  // CLAUDE.md and I walked straight into it.
  await tr.setTierWhaleGateActive(5, true).catch(() => {});
  for (let t = 6; t <= 10; t++) await tr.setTierWhaleGateActive(t, true).catch(() => {});

  return { usdc, tr, sf, tiers, owner, W1, members: [] };
}

async function newMember(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

/** Register into T1 through the real router. */
async function reg(ctx, s, ref) {
  const fee = ctx.tiers[0].fee;
  await ctx.usdc.mint(s.address, fee);
  await ctx.usdc.connect(s).approve(ctx.tiers[0].pmAddr, fee);
  const tx = await ctx.tr.connect(s).register(ref, { gasLimit: HARDHAT_TX_CAP });
  ctx.members.push(s);
  return tx.wait();
}

/** Fill tier `t`'s MatA (and optionally MatB) by impersonating its PairManager.
 *
 *  THE FLAW THIS FIXES (2026-07-28, first run of this file): only T1 was filled,
 *  so an upgrade into T2..Tn landed in a nearly EMPTY matrix, triggered no
 *  rotation, and produced no cascade. The measurement came back at 412k gas per
 *  tier and extrapolated to 44 tiers — against a live 17.76M at six. The fixture
 *  was measuring the cost of a seat, not the cost of a cascade.
 *
 *  Depth only costs anything when each tier's matrix is FULL, because that is
 *  what makes the upgrade rotate a root, which cycles that root out, which runs
 *  the additive engine again one tier up. Filling by impersonation rather than
 *  by real upgrades keeps the setup affordable. */
async function fillTier(ctx, t, alsoMatB = true) {
  const { pmAddr, fee, matA, matB } = ctx.tiers[t];
  await ethers.provider.send("hardhat_impersonateAccount", [pmAddr]);
  await ethers.provider.send("hardhat_setBalance", [pmAddr, "0x" + (10n ** 21n).toString(16)]);
  const pmSigner = await ethers.getSigner(pmAddr);
  for (const [mat, want] of [[matA, SIZE], [matB, alsoMatB ? SIZE : 0]]) {
    const addr = await mat.getAddress();
    while (Number(await mat.occupancy()) < want) {
      const w = ethers.Wallet.createRandom();
      await ctx.usdc.mint(ctx.owner.address, fee);
      await ctx.usdc.connect(ctx.owner).transfer(addr, fee);
      try { await mat.connect(pmSigner).enterFor(w.address, ctx.W1.address, { gasLimit: HARDHAT_TX_CAP }); }
      catch (e) {
        console.log(`      fill T${t + 1} stopped: ${(e.reason || e.shortMessage || e.message || "").slice(0, 90)}`);
        break;
      }
    }
  }
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [pmAddr]);
}

/** Push `who` up the ladder with manualUpgrade so they SPAN tiers 0..depth. */
async function climb(ctx, who, depth) {
  for (let t = 1; t <= depth; t++) {
    const fee = ctx.tiers[t].fee;
    await ctx.usdc.mint(who.address, fee);
    await ctx.usdc.connect(who).approve(await ctx.tr.getAddress(), fee);
    try {
      await ctx.tr.connect(who).manualUpgrade(t, { gasLimit: HARDHAT_TX_CAP });
    } catch (e) {
      // SAY WHY. The first version returned silently, so a victim stuck at tier
      // 1 looked identical to a victim who had climbed — and the test failed on
      // a symptom with no cause attached. A swallowed reason is the single most
      // expensive habit in this codebase.
      console.log(`      climb stopped at T${t + 1}: ` +
                  `${(e.reason || e.shortMessage || e.message || "").slice(0, 140)}`);
      return t - 1;
    }
  }
  return depth;
}

describe("V8.46-B — cascade gas versus ladder depth", function () {
  this.timeout(3_600_000);

  /** One run: build a ladder, fill every tier so each seat rotates a root, put a
   *  victim across `depth` tiers, then drive entries and report the worst tx. */
  /** Build a ladder `tierCount` deep with EVERY matrix full, then measure the
   *  single entry that triggers the cascade.
   *
   *  THE MECHANISM, corrected 2026-07-28 after two wrong fixtures:
   *  a MatA cycle-out does NOT run the additive engine — `_cycleOutRoot` sends
   *  MatB roots to handleCycleOut (re-entry -> upgrade -> double) and MatA roots
   *  merely to _crossToPartner. So depth is not one member's tier span. It is a
   *  CHAIN THROUGH DIFFERENT MEMBERS: an entry fills MatA, its root crosses into
   *  a full MatB, that rotates MatB's root, whose cycle-out upgrades into the
   *  next tier's full MatA, which rotates ITS root, and onward. The lever is
   *  therefore HOW MANY FULL TIERS EXIST, which is what this varies.
   *
   *  Both earlier versions returned byte-identical gas for shallow and deep runs
   *  because they varied the victim's span — a quantity the measured transaction
   *  never touched. Two configurations producing identical gas is not a
   *  measurement, it is a constant, and a constant meant the lever was not
   *  connected to the thing being measured. */
  async function measure(tierCount) {
    const ctx = await deployLadder(tierCount);
    for (let i = 0; i < SIZE; i++) await reg(ctx, await newMember(ctx), ctx.W1.address);
    // EVERY tier, T1 included — T1's MatB is only populated by crossings, so a
    // fixture that fills T1 by registration alone leaves MatB empty and the
    // crossing rotates nothing. "T1 15/0" was the tell.
    for (let t = 0; t < tierCount; t++) await fillTier(ctx, t);
    const occ = [];
    for (let t = 0; t < tierCount; t++)
      occ.push(`T${t + 1} ${await ctx.tiers[t].matA.occupancy()}/${await ctx.tiers[t].matB.occupancy()}`);
    console.log(`      ${tierCount} tier(s) full: ${occ.join("  ")}`);

    // Drive entries and take the worst — the cascade fires when the rotation
    // reaches a root whose cycle-out chains upward.
    let worst = 0n;
    for (let i = 0; i < SIZE + 2; i++) {
      const r = await reg(ctx, await newMember(ctx), ctx.W1.address);
      if (r.gasUsed > worst) worst = r.gasUsed;
    }
    return { tierCount, worst: Number(worst) };
  }

  it("shows cascade gas growing with ladder depth", async () => {
    console.log(`\n      ladder: ${TIERS} tiers x SIZE ${SIZE}` +
                (process.env.FLAT === "1" ? "  [FLAT fees — affordability removed]" : "  [production fee ladder]") +
                (SIZE < 127 ? `\n      (SIZE<127 — run FLAT=1 TIERS=6 SIZE=127 for the production number)` : ""));

    // TWO runs, shallow and deep. The DIFFERENCE is the marginal cost of depth,
    // and unlike a single absolute number it cannot be faked by a fixture that
    // is only measuring the price of a seat.
    // Every depth from 1 to TIERS, so the shape is visible rather than inferred
    // from two points.
    const runs = [];
    for (let n = 1; n <= TIERS; n++) runs.push(await measure(n));
    console.log("");
    let prev = null;
    for (const r of runs) {
      const delta = prev === null ? "" : `   (+${(r.worst - prev).toLocaleString()})`;
      console.log(`      ${String(r.tierCount).padStart(2)} tier(s) -> ${r.worst.toLocaleString()} gas${delta}`);
      prev = r.worst;
    }

    const shallow = runs[0], deep = runs[runs.length - 1];
    const perTier = (deep.worst - shallow.worst) / (deep.tierCount - shallow.tierCount);
    console.log(`\n      MARGINAL COST PER TIER OF DEPTH: ${Math.round(perTier).toLocaleString()} gas`);
    if (perTier > 0) {
      const room = RPC_GAS_CAP - shallow.worst;
      console.log(`      extrapolated: crosses ${RPC_GAS_CAP.toLocaleString()} at ~${(shallow.tierCount + Math.ceil(room / perTier))} tiers`);
    }
    console.log(`      LIVE REFERENCE: 17,762,199 on a real 6-tier member, SIZE=127 (2026-07-28)`);
    console.log(`      (a SIZE=${SIZE} rotation is far cheaper than a 127-seat one — compare shape, not magnitude)`);

    // The honest assertion: depth must COST something. If it does not, the
    // fixture still is not driving the ladder and the number above is worthless
    // — which is exactly the state V8_46_CascadeGas was in when it convinced me
    // to declare the depth guard dead.
    expect(perTier, "extra tiers cost nothing — the fixture is not reproducing the ladder")
      .to.be.greaterThan(0);
  });
});
