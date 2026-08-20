"use strict";
/**
 * V8_50_CycleEconomics.test.js — THE SELF-SUSTAINING LOOP NUMBER.
 *
 * WRITTEN 2026-08-20 (session 11). Owner question, in his words:
 *   "what we need to figure out is the self sustaining loop. we have a number it gets to
 *    that may not be necessary so the other pairs could get full faster."
 *
 * WHAT THIS IS NOT. It is NOT a routing threshold. There is no routing threshold and there
 * must not be one: `PairManagerV8._findExternalPair()` is `internal pure { return 0; }` and
 * the two counters that used to steer routing were deleted in V8.46 and V8.48 because a
 * cumulative counter froze 254 members in T1.1 MatA for three days. See V8_50_HANDOFF.md
 * section 11.1. Do not reintroduce one and do not re-derive this.
 *
 * WHAT THE LOOP ACTUALLY COSTS — read off MatrixLogicLib._crossToPartner:
 *   MatA -> MatB            costs _crossingPrice(fee)   -- pre-funded by the 50% reserve
 *                                                          carved at MatA entry.
 *   MatB -> next pair MatA  costs the FULL ENTRY FEE    -- it is a NEW CYCLE, not a
 *                                                          crossing, and the reserve is
 *                                                          already spent.
 *
 * ─── HISTORY OF THIS FIXTURE, so nobody repeats the two mistakes ──────────────────────
 * v1 tracked ONE hand-picked subject through both hops. At SIZE=7 that worked. At
 * SIZE=127 it REFUSED twice: the subject crossed A->B at reg 128 and was still
 * `activeInMatB == true` after 508 MatB rotations. Two lessons, both already in the
 * traps list and both re-learned the hard way:
 *   1. ONE SAMPLE IS NOT A MEASUREMENT. The question is what happens to the POPULATION
 *      at that hop, not to one address.
 *   2. `isActiveInMatrix` does not mean "holds a seat". Occupancy stayed 127/127 while
 *      485 members parked, so parked members are not occupants — but the view still
 *      answered true. Do not use it as a proxy for "still in the queue".
 * This version measures every cycle-out at the B hop and buckets the outcomes.
 *
 * ⚠ THE BUCKET THAT MATTERS MOST. `MemberParked` is emitted from THREE different places
 * in MatrixLogicLib and only ONE of them means "could not afford it":
 *      MemberParked(member, shortfall)  shortfall > 0  -> COULD NOT AFFORD THE HOP
 *      MemberParked(root, 0)            duplicate-seat guard: already seated in partner
 *      MemberParked(member, 0)          crossingInProgress deferral (V8.44)
 * Lumping them together would produce a headline that claims an affordability result the
 * run never observed. They are counted separately below and must stay separate.
 * (V8_50_HANDOFF.md section 7a: an instrument must not report the absence of something it
 * cannot observe; and: does that bucket's name claim something the run did not measure?)
 *
 * ============================ HOW TO RUN =====================================
 *   cd C:\CryptoNite-Smart-Contracts\CryptoNova
 *   npx hardhat compile --force
 *
 *   smoke (size 7, fast, proves the instrument works):
 *     npx hardhat test test/V8_50_CycleEconomics.test.js
 *
 *   THE REAL NUMBER (live matrix size — this is the one that counts):
 *     $env:CYCLE_SIZE=127; npx hardhat test test/V8_50_CycleEconomics.test.js
 *     Remove-Item Env:\CYCLE_SIZE
 * =============================================================================
 *
 * SIZE IS NOT COSMETIC. Pool share (1568 bps) is split across seats 2..N, so a size-7 run
 * hands each member ~18x the per-rotation pool share of a size-127 run. A number taken at
 * size 7 DESCRIBES NOBODY on the live chain. Size 127 or it is not an answer.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SIZE = Number(process.env.CYCLE_SIZE || process.env.GAS_MATRIX_SIZE || 7);
const FEE  = 10_000_000n;                                     // $10.00, T1 live entry fee
const BUDGET_MULT = Number(process.env.CYCLE_BUDGET || 6);    // registrations = BUDGET_MULT * SIZE
const PROGRESS    = Number(process.env.CYCLE_PROGRESS || 25);
const SAMPLE      = Number(process.env.CYCLE_SAMPLE || 12);   // parked members to price in detail

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(4);
const pct = (v, of) => ((Number(v) * 100) / Number(of)).toFixed(2) + "%";
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Deploy ONE pair. Deliberately one, not two.
 * addPair() closes the chain circle onto itself, so a single pair's MatB has
 * chainNext == its OWN MatA -- confirmed by this fixture's own END STATE dump and
 * matching live T3 today (pair0 MatB chainNext == pair0 MatA, measured 2026-08-20).
 * The MatB hop is still priced as a NEW CYCLE because the discriminator is this
 * matrix's own immutable isMatrixA, not the destination. One pair measures the real
 * price, and pairFactory is deliberately left unset so no expansion perturbs the run.
 * ──────────────────────────────────────────────────────────────────────────── */
async function deployPair(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter",
      { libraries: { TierRouterLib: trLib.target } })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(usdcAddr, FEE, owner.address);
  const pmAddr = await pm.getAddress();

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8",
    { libraries: { MatrixLogicLib: await matrixLib.getAddress() } });

  const a = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const b = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  await a.setPartner(await b.getAddress());
  await b.setPartner(await a.getAddress());
  for (const m of [a, b]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());

  return { usdc, pm, pmAddr, tr, a, b, sf, owner, W1, sigs, matrixLib,
           aAddr: await a.getAddress(), bAddr: await b.getAddress() };
}

/** Fresh funded wallets — hardhat only gives 20 signers and we need hundreds. */
async function freshWallets(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [w.address, "0x3635C9ADC5DEA00000"]);
    out.push(w);
  }
  return out;
}

/**
 * Register with NO referrer. Every member is therefore an orphan: L1 (950 bps) is routed
 * to accountOne and NONE of it reaches the entrant. That IS the no-referral case the
 * owner's framing is about ("members are expected to take loans and be evicted if they
 * never invite anyone"). This makes the whole fixture population the worst case, which is
 * the case worth pricing.
 */
async function reg(ctx, wallet) {
  await ctx.usdc.mint(wallet.address, FEE);
  await ctx.usdc.connect(wallet).approve(ctx.pmAddr, FEE);
  const rc = await (await ctx.tr.connect(wallet)
    .register(ethers.ZeroAddress, { gasLimit: 16_000_000 })).wait();
  return parseAll(ctx, rc.logs);
}

/**
 * Decode with ARTIFACT-DERIVED interfaces only. Never hand-written signatures —
 * the money events (CrossingFunded, MemberParked, MemberCrossedToPartner) are declared in
 * MatrixLogicLib and emitted THROUGH the matrix by delegatecall, so the logs carry the
 * matrix address and need the library ABI.
 */
function parseAll(ctx, logs) {
  const out = [];
  for (const lg of logs) {
    for (const iface of [ctx.matrixLib.interface, ctx.a.interface, ctx.pm.interface]) {
      let d = null;
      try { d = iface.parseLog(lg); } catch { d = null; }
      if (d) { out.push({ name: d.name, args: d.args, address: lg.address }); break; }
    }
  }
  return out;
}

describe("V8.50 — THE SELF-SUSTAINING LOOP: what happens at the forward hop out of MatB", function () {
  this.timeout(7_200_000);

  it(`censuses every MatB cycle-out for no-referral members at MATRIX_SIZE=${SIZE}`, async function () {
    const ctx = await deployPair(SIZE);
    const budget = BUDGET_MULT * SIZE;

    console.log("");
    console.log("=".repeat(96));
    console.log(`  CYCLE ECONOMICS — MATRIX_SIZE ${SIZE}, entry fee ${usd(FEE)}, NO referral income for anyone`);
    console.log(`  registration budget ${budget}   (CYCLE_BUDGET=${BUDGET_MULT} x SIZE)`);
    console.log("=".repeat(96));

    const wallets = await freshWallets(budget);

    const flow = { crossedAB: 0, parkedA: 0, gradB: 0, parkShortB: 0, parkZeroB: 0 };
    const gradCosts   = [];      // CrossingFunded totals for members who DID graduate out of B
    const shortfalls  = [];      // MemberParked shortfalls at the B hop, shortfall > 0 only
    const parkedAtB   = [];      // addresses parked at the B hop with a real shortfall
    let   firstCrossA = null;    // the A->B price, taken once — it is constant by construction

    for (let i = 0; i < budget; i++) {
      const evs = await reg(ctx, wallets[i]);

      for (const e of evs) {
        const fromA = e.address.toLowerCase() === ctx.aAddr.toLowerCase();
        const fromB = e.address.toLowerCase() === ctx.bAddr.toLowerCase();

        if (e.name === "MemberCrossedToPartner" && fromA) {
          flow.crossedAB++;
          if (!firstCrossA) {
            const cf = evs.find(x => x.name === "CrossingFunded" && x.args[0] === e.args[0]);
            if (cf) firstCrossA = { cost: cf.args[3], reserve: cf.args[1], earnings: cf.args[2] };
          }
        }
        if (e.name === "MemberParked" && fromA) flow.parkedA++;

        if (e.name === "MemberCrossedToPartner" && fromB) {
          flow.gradB++;
          const cf = evs.find(x => x.name === "CrossingFunded" && x.args[0] === e.args[0]);
          if (cf) gradCosts.push(cf.args[3]);
        }
        if (e.name === "MemberParked" && fromB) {
          const shortfall = BigInt(e.args[1]);
          if (shortfall > 0n) {
            flow.parkShortB++;
            shortfalls.push(shortfall);
            if (parkedAtB.length < SAMPLE) parkedAtB.push(e.args[0]);
          } else {
            // NOT an affordability result. Seat-guard or crossingInProgress deferral.
            flow.parkZeroB++;
          }
        }
      }

      if (PROGRESS > 0 && (i + 1) % PROGRESS === 0) {
        const [aOcc, aRot] = [await ctx.a.occupancy(), await ctx.a.rotationCount()];
        const [bOcc, bRot] = [await ctx.b.occupancy(), await ctx.b.rotationCount()];
        console.log(`  reg ${String(i + 1).padStart(4)}  ` +
          `MatA ${String(aOcc).padStart(3)}/${SIZE} rot ${String(aRot).padStart(4)}  |  ` +
          `MatB ${String(bOcc).padStart(3)}/${SIZE} rot ${String(bRot).padStart(4)}  |  ` +
          `A->B ${flow.crossedAB}   B FORWARD ${flow.gradB}   B parked-short ${flow.parkShortB}   B parked-zero ${flow.parkZeroB}`);
      }
    }

    const bHops = flow.gradB + flow.parkShortB + flow.parkZeroB;

    /* ── REFUSE RATHER THAN REPORT AN ABSENCE WE CANNOT OBSERVE ──────────────── */
    expect(bHops,
      `NO CYCLE-OUT AT THE MatB HOP WAS OBSERVED AT ALL in ${budget} registrations ` +
      `(A->B crossings seen: ${flow.crossedAB}). This is NOT a result of zero — the run ` +
      `never reached the hop. Raise CYCLE_BUDGET and re-run.`
    ).to.be.greaterThan(0);

    /* ── What a parked member had actually earned, sampled ───────────────────── */
    const sampled = [];
    for (const addr of parkedAtB) {
      const mA = await ctx.a.getMember(addr);
      const mB = await ctx.b.getMember(addr);
      sampled.push({ addr, earnedA: BigInt(mA.totalEarned), earnedB: BigInt(mB.totalEarned) });
    }

    console.log("");
    console.log("=".repeat(96));
    console.log(`  THE FORWARD HOP OUT OF MatB — CENSUS OF ${bHops} CYCLE-OUTS, MATRIX_SIZE ${SIZE}`);
    console.log("=".repeat(96));
    console.log(`  A->B crossing price (constant) ......... ` +
      (firstCrossA ? `${usd(firstCrossA.cost)}  = reserve ${usd(firstCrossA.reserve)} + earnings ${usd(firstCrossA.earnings)}`
                   : "NOT OBSERVED"));
    console.log(`  forward hop price ...................... ${usd(FEE)}  (full entry fee, no reserve behind it)`);
    console.log("");
    console.log(`  GRADUATED forward to the next MatA ..... ${String(flow.gradB).padStart(5)}   ${pct(flow.gradB, bHops || 1)}`);
    console.log(`  PARKED — COULD NOT AFFORD THE HOP ...... ${String(flow.parkShortB).padStart(5)}   ${pct(flow.parkShortB, bHops || 1)}`);
    console.log(`  PARKED — shortfall 0, NOT affordability  ${String(flow.parkZeroB).padStart(5)}   ${pct(flow.parkZeroB, bHops || 1)}`);
    console.log(`      (seat guard / crossingInProgress deferral — counted apart on purpose)`);
    console.log("");

    if (shortfalls.length) {
      const mn = shortfalls.reduce((a, b) => (b < a ? b : a));
      const mx = shortfalls.reduce((a, b) => (b > a ? b : a));
      const md = median(shortfalls);
      console.log(`  SHORTFALL over ${shortfalls.length} parked members:`);
      console.log(`      min    ${usd(mn)}   (${pct(mn, FEE)} of one fee)`);
      console.log(`      median ${usd(md)}   (${pct(md, FEE)} of one fee)`);
      console.log(`      max    ${usd(mx)}   (${pct(mx, FEE)} of one fee)`);
      console.log(`  So the median member arrives at the forward hop holding ${usd(FEE - md)} of the ${usd(FEE)} needed.`);
      console.log("");
    }

    if (sampled.length) {
      console.log(`  LIFETIME EARNINGS OF ${sampled.length} SAMPLED PARKED MEMBERS (A + B halves):`);
      for (const s of sampled.slice(0, 6)) {
        const tot = s.earnedA + s.earnedB;
        console.log(`      ${s.addr.slice(0, 10)}..  MatA ${usd(s.earnedA)}  MatB ${usd(s.earnedB)}  total ${usd(tot)}  (${pct(tot, FEE)} of one fee)`);
      }
      const totals = sampled.map(s => s.earnedA + s.earnedB);
      console.log(`      median lifetime earnings across the sample: ${usd(median(totals))}  (${pct(median(totals), FEE)} of one fee)`);
      console.log("");
    }

    console.log("-".repeat(96));
    if (flow.gradB === 0 && flow.parkShortB > 0) {
      console.log(`  >> THE LOOP DOES NOT FEED ITSELF AT SIZE ${SIZE}. ${flow.parkShortB} of ${bHops} cycle-outs`);
      console.log(`     could not pay the forward hop and ZERO graduated. Without referral income the`);
      console.log(`     forward hop is not merely expensive — it never succeeds.`);
      console.log(`     That gap closes ONLY via referral income, an SF loan, or a change to the`);
      console.log(`     splits. No routing threshold can touch it, and there is none to touch.`);
    } else if (flow.gradB > 0) {
      console.log(`  >> ${flow.gradB} of ${bHops} cycle-outs DID graduate forward at size ${SIZE}.`);
      console.log(`     Compare against live before trusting it: T1 pair0 MatB has pushed 4 members`);
      console.log(`     forward in 773 rotations. If those two rates disagree, THAT is the next`);
      console.log(`     finding — measure it, do not explain it.`);
    }
    console.log("-".repeat(96));
    console.log("");

    /* The assertion is on OBSERVABILITY only, never on a threshold. This fixture reports a
     * number for an owner decision; it is not the place to encode what the number ought to
     * be. A pass means "measured", not "healthy". */
    expect(bHops).to.be.greaterThan(0);
  });
});
