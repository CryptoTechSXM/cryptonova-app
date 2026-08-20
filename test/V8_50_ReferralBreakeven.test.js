"use strict";
/**
 * V8_50_ReferralBreakeven.test.js — WHERE DOES THE LOOP ACTUALLY START WORKING?
 *
 * WRITTEN 2026-08-20 (session 11). v2 — v1's referral tree was WRONG, see below.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * V8_50_CycleEconomics.test.js proved a no-referral population graduates 0 of 485 at the
 * forward hop out of MatB, and the gap is fully accounted for: a full A+B cycle distributes
 * the ENTIRE entry fee, and what leaks away from a non-recruiter is the system take
 * (2564 bps) plus their orphaned L1 (1900 bps) = 4464 bps. Measured median shortfall
 * 4408 bps. So the only lever a member has is referral income. This fixture measures how
 * much of it they actually need.
 *
 * ─── ⛔ WHAT v1 GOT WRONG. DO NOT REBUILD IT THAT WAY ─────────────────────────────────
 * v1 built an R-ary tree (member i's referrer = member floor((i-1)/R)). At SIZE=7 it
 * produced this, and the pattern is the whole lesson:
 *
 *      R=0  median shortfall $5.1280      R=3  median shortfall $5.1280
 *      R=1  median shortfall $3.2280      R=5  median shortfall $5.1280
 *      R=2  median shortfall $5.1280
 *
 * R=1 is better than R=0 by EXACTLY $1.90 — one invitee-cycle of L1 (950 bps x both
 * halves). R=2, 3 and 5 are identical to R=0 to the cent: not less benefit, NO benefit.
 *
 * The cause is TIMING, not rate. `_credit` (MatrixLogicLib:1332-1350) writes to
 * `self.members[recipient]` in the matrix THE INVITEE ENTERED, with no check that the
 * recipient is still seated there. `BalanceCarried` only fires at the moment of crossing,
 * so an L1 payment arriving AFTER the referrer has crossed to MatB lands in a MatA balance
 * they have left, and the forward hop — which funds only from MatB `withdrawable` — cannot
 * touch it. In v1's tree, R=1 happened to place every invitee immediately after their
 * referrer; at R>=2 the later invitees arrived too late. v1 was measuring when people
 * joined, not how many joined.
 *
 * TRAP FOR THE LIST: BEFORE SWEEPING A VARIABLE, PROVE THE HARNESS HOLDS EVERYTHING ELSE
 * STILL. A monotonic-looking failure would have been caught; four rows identical to the
 * cent are what exposed it.
 *
 * ─── WHAT v2 DOES DIFFERENTLY ────────────────────────────────────────────────────────
 * 1. INTERLEAVED, so timing is constant across rates: register a subject, then immediately
 *    register their R invitees, then the next subject. Every subject's referral income
 *    arrives at the same point in their own life whatever R is. Rate is now the only
 *    variable that moves.
 * 2. ROLES ARE SEPARATED. Invitees refer nobody, so lumping them in with subjects would
 *    dilute the median with a population we already measured. Subjects and invitees are
 *    censused apart — and the invitee column is a per-run control: it must look like R=0.
 * 3. L1 IS TRACKED BY DESTINATION. Every L1 credit to a subject is bucketed as
 *    USABLE (arrived in MatA before they crossed, so it rides across on BalanceCarried, or
 *    arrived in MatB) or STRANDED (arrived in MatA after they had already left). If the
 *    stranded bucket is large, referral income is worth materially less than 1900 bps per
 *    invitee-cycle and the "~2.35 invitees" arithmetic is wrong.
 *
 * ⚠ THE STRANDED-L1 QUESTION IS THE REASON TO RUN THIS. It is UNVERIFIED. The code shows
 * the mechanism and v1's numbers point straight at it, but nothing has yet measured how
 * much money lands there. That number, not the break-even row, may be the finding.
 *
 * ============================ HOW TO RUN =====================================
 *   cd C:\CryptoNite-Smart-Contracts\CryptoNova
 *   npx hardhat compile --force
 *
 *   smoke (size 7, fast — proves the harness, NOT the answer):
 *     npx hardhat test test/V8_50_ReferralBreakeven.test.js
 *
 *   THE REAL SWEEP (live matrix size, several minutes per rate):
 *     $env:CYCLE_SIZE=127; npx hardhat test test/V8_50_ReferralBreakeven.test.js
 *     Remove-Item Env:\CYCLE_SIZE
 * =============================================================================
 *
 * SIZE IS NOT COSMETIC. Pool share is split across seats 2..N, so size 7 hands each member
 * ~18x the per-rotation pool share of size 127. A break-even taken at size 7 DESCRIBES
 * NOBODY. Size 127 or it is not an answer.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SIZE = Number(process.env.CYCLE_SIZE || process.env.GAS_MATRIX_SIZE || 7);
const FEE  = 10_000_000n;
/* ⛔ BUDGET IS FIXED ACROSS EVERY RATE. DO NOT SCALE IT WITH R. READ THIS BEFORE CHANGING IT.
 *
 * v3 scaled the budget with R (381/762/1143/1524/1905 regs) to keep subject counts even.
 * That traded a small-sample problem for a MUCH worse confound and produced a table that
 * was flatly non-monotonic — R=3 came back WORSE than R=0 with 235 hops behind it, so it
 * could not be dismissed as noise:
 *      R=0 $3.2390 | R=1 $2.5096 | R=2 $0.6472 | R=3 $3.3812 | R=4 $1.6212
 *
 * THE CAUSE: shortfall GROWS WITH SYSTEM MATURITY. Early cycle-outs rode MatA while it was
 * filling on full $10 entries; later ones are paid out of $5 crossings (V8_50_HANDOFF.md
 * 11.4). Scaling the budget therefore measured every rate at a DIFFERENT point in the
 * system's life, and two effects — more referrals (better) vs longer run (worse) — fought
 * each other inside one column. Same class as the parked-population trap already on the
 * list: A POPULATION THAT MOVES CANNOT BE COMPARED ACROSS RUNS TAKEN AT DIFFERENT TIMES.
 *
 * A fixed budget makes every row share one maturity clock, so the rates are comparable.
 * The cost is fewer subject hops at high R — that is the ACCEPTABLE failure, because
 * MIN_HOPS labels a thin row honestly whereas a confounded row lies quietly. */
const BUDGET_MULT = Number(process.env.CYCLE_BUDGET || 6);
const MIN_HOPS    = Number(process.env.CYCLE_MIN_HOPS || 10);
const REFS = (process.env.CYCLE_REFS || "0,1,2,3,4").split(",").map(s => Number(s.trim()));

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const SRC_L1_REFERRAL = 2n;

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(4);
const pctOf = (v, of) => ((Number(v) * 100) / Number(of)).toFixed(2) + "%";
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

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

async function freshWallets(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [w.address, "0x3635C9ADC5DEA00000"]);
    out.push(w);
  }
  return out;
}

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

async function reg(ctx, wallet, referrer) {
  await ctx.usdc.mint(wallet.address, FEE);
  await ctx.usdc.connect(wallet).approve(ctx.pmAddr, FEE);
  const rc = await (await ctx.tr.connect(wallet)
    .register(referrer, { gasLimit: 16_000_000 })).wait();
  return parseAll(ctx, rc.logs);
}

async function runOne(R) {
  const ctx = await deployPair(SIZE);
  const budget = BUDGET_MULT * SIZE;             // FIXED across rates — see the note at the top
  const wallets = await freshWallets(budget);

  const role = new Map();          // address -> "subject" | "invitee"
  const leftA = new Set();         // members who have crossed A->B (so MatA credits strand)
  /* L1 split by WHICH EVENT PAID IT. An invitee pays their referrer twice: 950 bps when
   * they enter MatA, and 950 bps again when they cross into MatB. The second payment
   * arrives much later, so a referrer who reaches the forward hop early collects only the
   * first half of each invitee's value. The v2 smoke run showed exactly this — invitees 1
   * and 2 were each worth $1.90 but the third only $0.95. Splitting the buckets is what
   * turns that from a curiosity into a number. */
  const l1 = { fromA: 0n, fromB: 0n, stranded: 0n };
  const hop = {                    // forward-hop census, split by role
    subject: { grads: 0, short: 0, zero: 0, shortfalls: [] },
    invitee: { grads: 0, short: 0, zero: 0, shortfalls: [] },
  };
  const gradCount = new Map();

  const handle = (evs) => {
    for (const e of evs) {
      const fromA = e.address.toLowerCase() === ctx.aAddr.toLowerCase();
      const fromB = e.address.toLowerCase() === ctx.bAddr.toLowerCase();

      // L1 destination accounting — the point of v2.
      if (e.name === "EarningsCredited" && BigInt(e.args.source) === SRC_L1_REFERRAL) {
        const to = e.args.member;
        if (role.get(to) === "subject") {
          // In MatA AFTER they crossed = stranded: the forward hop funds from MatB only.
          if (fromA && leftA.has(to))   l1.stranded += BigInt(e.args.amount);
          else if (fromA)               l1.fromA    += BigInt(e.args.amount);
          else if (fromB)               l1.fromB    += BigInt(e.args.amount);
        }
      }

      if (e.name === "MemberCrossedToPartner" && fromA) leftA.add(e.args[0]);

      if (e.name === "MemberCrossedToPartner" && fromB) {
        const r = role.get(e.args[0]);
        if (r) hop[r].grads++;
        gradCount.set(e.args[0], (gradCount.get(e.args[0]) ?? 0) + 1);
      }
      if (e.name === "MemberParked" && fromB) {
        const r = role.get(e.args[0]);
        const sf = BigInt(e.args[1]);
        if (r) {
          // shortfall 0 is the seat guard / crossingInProgress deferral, NOT affordability.
          if (sf > 0n) { hop[r].short++; hop[r].shortfalls.push(sf); } else { hop[r].zero++; }
        }
      }
    }
  };

  // INTERLEAVED: subject, then their R invitees, then the next subject. Timing constant.
  let i = 0;
  while (i < budget) {
    const subject = wallets[i];
    role.set(subject.address, "subject");
    handle(await reg(ctx, subject, ethers.ZeroAddress));
    i++;
    for (let k = 0; k < R && i < budget; k++, i++) {
      role.set(wallets[i].address, "invitee");
      handle(await reg(ctx, wallets[i], subject.address));
    }
  }

  const sHops = hop.subject.grads + hop.subject.short + hop.subject.zero;
  const iHops = hop.invitee.grads + hop.invitee.short + hop.invitee.zero;

  return {
    R, sHops, iHops,
    sGrads: hop.subject.grads, sShort: hop.subject.short,
    iGrads: hop.invitee.grads, iShort: hop.invitee.short,
    sMed: median(hop.subject.shortfalls), iMed: median(hop.invitee.shortfalls),
    l1FromA: l1.fromA, l1FromB: l1.fromB, l1Stranded: l1.stranded, budget,
    twice: [...gradCount.values()].filter(v => v >= 2).length,
  };
}

const results = [];

describe(`V8.50 — REFERRAL BREAK-EVEN SWEEP (v2, interleaved) at MATRIX_SIZE=${SIZE}`, function () {
  this.timeout(14_400_000);

  for (const R of REFS) {
    it(`R=${R} invitees per subject — censuses the forward hop`, async function () {
      const r = await runOne(R);
      results.push(r);
      console.log(`    R=${R}  (${r.budget} regs)  subjects: ${r.sHops} hops, FORWARD ${r.sGrads}, median short ` +
        `${r.sMed !== null ? usd(r.sMed) : "n/a"}  |  invitees: ${r.iHops} hops, FORWARD ${r.iGrads}` +
        `  |  L1 entry ${usd(r.l1FromA)} + crossing ${usd(r.l1FromB)} / stranded ${usd(r.l1Stranded)}` +
        (r.sHops < MIN_HOPS ? `   ⚠ ONLY ${r.sHops} SUBJECT HOPS — NOT A MEASUREMENT` : ""));
      expect(r.sHops + r.iHops,
        `R=${R}: NO CYCLE-OUT AT THE FORWARD HOP OBSERVED. NOT a result of zero — the run ` +
        `never reached the hop. Raise CYCLE_BUDGET.`).to.be.greaterThan(0);
    });
  }

  after(function () {
    if (!results.length) return;
    const w = (s, n) => String(s).padEnd(n);
    console.log("");
    console.log("=".repeat(112));
    console.log(`  REFERRAL BREAK-EVEN — MATRIX_SIZE ${SIZE}, entry fee ${usd(FEE)}, interleaved (timing held constant)`);
    console.log("=".repeat(112));
    console.log("  " + w("invitees", 10) + w("subj hops", 11) + w("FORWARD", 10) + w("rate", 9) +
                w("median short", 15) + w("invitee fwd", 13) + w("L1 @entry", 12) + w("L1 @cross", 12) + w("2 cyc", 7) + "note");
    console.log("  " + "-".repeat(108));
    for (const r of results.sort((x, y) => x.R - y.R)) {
      console.log("  " + w(r.R, 10) + w(r.sHops, 11) + w(r.sGrads, 10) +
        w(pctOf(r.sGrads, r.sHops || 1), 9) + w(r.sMed !== null ? usd(r.sMed) : "-", 15) +
        w(`${r.iGrads}/${r.iHops}`, 13) + w(usd(r.l1FromA), 12) + w(usd(r.l1FromB), 12) +
        w(r.twice, 7) + (r.sHops < MIN_HOPS ? "⚠ n too small — not a measurement" : ""));
    }
    console.log("=".repeat(112));

    const ctrl = results.find(r => r.R === 0);
    if (ctrl) {
      console.log(ctrl.sGrads === 0
        ? `  CONTROL OK: R=0 graduated 0 of ${ctrl.sHops}. The no-referral baseline reproduces.`
        : `  *** CONTROL FAILED: R=0 graduated ${ctrl.sGrads}. HARNESS IS WRONG — EVERY ROW ABOVE IS VOID. ***`);
    }
    const bad = results.find(r => r.R > 0 && r.iGrads > 0);
    if (bad) console.log(`  ⚠ INVITEES GRADUATED at R=${bad.R} (${bad.iGrads}). Invitees refer nobody, so they should behave like R=0. Explain before trusting the subject rows.`);

    const first = results.filter(r => r.sGrads > 0).sort((a, b) => a.R - b.R)[0];
    console.log(first
      ? `  BREAK-EVEN: the forward hop first succeeds at R=${first.R} invitees per subject.`
      : `  BREAK-EVEN NOT REACHED at any rate tested (${REFS.join(", ")}). Extend CYCLE_REFS upward.`);
    const two = results.filter(r => r.twice > 0).sort((a, b) => a.R - b.R)[0];
    console.log(two
      ? `  TWO FULL CYCLES: first achieved at R=${two.R} (${two.twice} member(s)).`
      : `  TWO FULL CYCLES: NOT achieved at any rate tested — the owner's stated goal is not met by referrals alone here.`);

    const anyStrand = results.some(r => r.l1Stranded > 0n);
    console.log("");
    if (anyStrand) {
      console.log(`  ⛔ STRANDED L1 IS NON-ZERO EVEN UNDER INTERLEAVING. Referral money credited into MatA`);
      console.log(`     after the referrer had already crossed cannot fund the forward hop, which funds`);
      console.log(`     from MatB withdrawable only. Chase this before quoting any per-invitee value.`);
    } else {
      /* ⚠ DO NOT LET THIS READ AS A CLEAN BILL OF HEALTH. It is not.
       * This harness registers every invitee IMMEDIATELY after their referrer, so an
       * invitee cannot arrive after the referrer has crossed. Zero stranding is therefore
       * TRUE BY CONSTRUCTION, not a property of the system. An instrument must not report
       * the absence of something it cannot observe.
       * The evidence that stranding is REAL is the v1 run, whose R>=2 rows came back
       * identical to R=0 to the cent precisely because the later invitees arrived too
       * late. That case is NOT tested here and remains OPEN. */
      console.log(`  ⚠ STRANDED L1 READS ZERO — BUT THAT IS TRUE BY CONSTRUCTION, NOT A RESULT.`);
      console.log(`     This harness registers every invitee immediately after their referrer, so no`);
      console.log(`     invitee CAN arrive after the referrer has crossed. It does not test late`);
      console.log(`     referrals at all. v1's tree did, and its R>=2 rows came back identical to R=0`);
      console.log(`     to the cent — which is the evidence that stranding is real. STILL OPEN:`);
      console.log(`     what a member earns when their invitees join AFTER they have crossed to MatB.`);
    }
    console.log("=".repeat(112));
    console.log("");
  });
});
