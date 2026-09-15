"use strict";
/**
 * V8_54_StageInversion.test.js — THE FIXTURE FOR HANDOFF 62.54's PROPOSED FIX.
 *
 *  Audience: the next session of Claude, plus the owner.
 *
 *  ══════════════════════════════════════════════════════════════════════════════════════
 *  WHAT IS BEING TESTED
 *  ══════════════════════════════════════════════════════════════════════════════════════
 *  Session 81 MEASURED (handoff 62.54, memory `cryptonova-matrix-fill-design`) that the
 *  two-stage overflow escape hatch is ordered wrongly:
 *
 *      stage 1  _pairWithRoomFor        — ANY pair with a free MatA seat
 *      stage 2  _fullPairWaitingLongest — the FULL MatA that has waited longest
 *
 *  `_hasRoomAndFree` measures room on MatA ONLY (PairManagerV8:319). So a pair whose MatA is
 *  full reads as NO ROOM even with its MatB half empty. The moment a brand-new pair opens
 *  with an empty MatA, stage 1 finds it and the WHOLE overflow stream goes there — and the
 *  older pair's MatB stops being fed, which also stops its MatA rotating, which freezes
 *  every member seated in it. Live, by day (T1.1→T1.2 / T1.1→T1.3):
 *
 *      09-09  42 / 4   ← T1.3 opens          09-11   0 / 48
 *      09-10   0 / 59                        09-12  12 / 28  ← T1.3 MatA fills, 0→1 resumes
 *
 *  T1.2 MatB sat at 115/127 (90.5%) through both zero days.
 *
 *  THE PROPOSED FIX: invert the two stages. `contracts/test/PairManagerV8_StageInverted.sol`
 *  overrides `_overflowTargetFor` and does nothing else.
 *
 *  ══════════════════════════════════════════════════════════════════════════════════════
 *  ⛔ THE SCORING RULE — THE WHOLE POINT, AND THE TRAP THAT FOOLED EVERYONE IN AUGUST
 *  ══════════════════════════════════════════════════════════════════════════════════════
 *  THE METRIC IS NOT ROTATION VOLUME. The deleted `routeEntryThreshold` regime scored 5,684
 *  rotations on one MatB with near-zero ladder progress — members going round inside one
 *  matrix, not climbing (memory `cryptonova-entry-thresholds`). This fixture scores
 *
 *      LADDER PROGRESS = members who CROSSED MatA→MatB  (rung 1)
 *                      + members who CYCLED OUT OF MatB (rung 2 — reached the root and LEFT)
 *                      + seats actually advanced by members still sitting there
 *
 *  Rotation counts ARE printed, because they are the number that misled us, and printing
 *  them next to progress is how that stops happening. They are never asserted on their own,
 *  and G3 below FAILS the treatment if it wins on rotations while losing on completions.
 *
 *  ══════════════════════════════════════════════════════════════════════════════════════
 *  THE RIG
 *  ══════════════════════════════════════════════════════════════════════════════════════
 *  Three hand-wired pairs, size SIZE, no keepers, no factory. Registrations through the
 *  front door plus selfRescue by parked members — member actions only, exactly as
 *  V8_52_FrozenPair.test.js drives it. PAIR 2 IS WIRED AT DEPLOY BUT `addPair`ed ONLY AT THE
 *  CHOSEN MOMENT, which is how a factory pair actually arrives.
 *
 *  Each of the two arms is run at TWO open-points, because the size of the harm depends
 *  entirely on how empty the older pair's MatB is when the new pair opens:
 *    LIVE   — pair 2 opens when pair 1's MatB is at 90% (`factoryExpandThresholdBps`, read
 *             from the contract). This is the live geometry: 115/127.
 *    EARLY  — pair 2 opens when pair 1's MatB is at 50%. Not a live trigger; it shows how
 *             the harm scales. `fullTrigger` and `_forceExpand` can both open a pair at
 *             other moments, so 90% is not the only geometry that occurs.
 *
 *  ✅ A FREE CONTROL FALLS OUT OF THE DESIGN: while only TWO pairs exist the two arms are
 *     provably identical (with pair 1's MatA not yet full, stage 2 skips it and stage 1
 *     finds it; once it IS full, stage 1 skips it and stage 2 finds it — both orders return
 *     the same pair). R2 asserts the pre-open ledgers match EXACTLY. If they do not, the rig
 *     has an uncontrolled difference and nothing after it means anything.
 *
 *  ⛔ A RED HEADLINE IS A RESULT, NOT A BROKEN TEST. If the inversion does not buy ladder
 *     progress, that is the finding and it says do not redeploy for this. Do not "fix" the
 *     fixture until it agrees.
 *
 *  ⚠ THIS IS A FIXTURE AT SIZE ~8, NOT THE LIVE CHAIN AT 127. It can show the MECHANISM and
 *    the DIRECTION. It cannot give the magnitude the live system would see.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SIZE  = Number(process.env.SI_SIZE || 8);
const TAIL  = Number(process.env.SI_TAIL || 3 * SIZE); // registrations driven after opening
const FEE   = 10_000_000n;

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

const log = (...a) => console.log("      " + a.join(" "));

// ───────────────────────────────────────────────────────────────────────────────────────
// RIG
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Three wired pairs. Pairs 0 and 1 are added to the PairManager; pair 2 is fully wired but
 * NOT added — `openPair2()` adds it, which is what a factory deploy does live.
 * `pmName` picks the arm: "PairManagerV8" (control) or "PairManagerV8_StageInverted".
 */
async function deployThreePairs(size, pmName) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", { libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target } }))
    .deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory(pmName))
    .deploy(usdcAddr, FEE, owner.address);
  const [tresAddr, sfAddr, trAddr, pmAddr] = [
    await treasury.getAddress(), await sf.getAddress(),
    await tr.getAddress(),       await pm.getAddress(),
  ];

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await matrixLib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });

  const mats = [];
  for (let p = 0; p < 3; p++) {
    const a = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
    const b = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
    await a.setPartner(await b.getAddress());
    await b.setPartner(await a.getAddress());
    for (const m of [a, b]) {
      await m.setPairManager(pmAddr);
      await m.setTierRouter(trAddr);
      await m.setStabilityFund(sfAddr);
      await m.setMatrixKeeper(owner.address);
      await treasury.setAuthorizedCaller(await m.getAddress(), true);
      await sf.setMatrixAuthorized(await m.getAddress(), true);
      await tr.registerMatrix(await m.getAddress(), 0);
    }
    mats.push({ a, b });
  }
  // Pairs 0 and 1 exist from the start. Pair 2 is deployed and wired but NOT added yet —
  // it "opens" later, exactly as a factory pair does.
  await pm.addPair(await mats[0].a.getAddress(), await mats[0].b.getAddress());
  await pm.addPair(await mats[1].a.getAddress(), await mats[1].b.getAddress());
  await pm.setTierRouter(trAddr);
  await pm.setActivePairIndex(0);

  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await mats[0].a.getAddress(), await mats[0].b.getAddress());
  await sf.setMatrixKeeper(owner.address);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);

  const label = new Map();
  for (let p = 0; p < 3; p++) {
    label.set((await mats[p].a.getAddress()).toLowerCase(), `P${p}.MatA`);
    label.set((await mats[p].b.getAddress()).toLowerCase(), `P${p}.MatB`);
  }

  return {
    usdc, tr, pm, owner, W1, sigs, pmAddr, trAddr, mats, label,
    openPair2: async () => {
      await pm.addPair(await mats[2].a.getAddress(), await mats[2].b.getAddress());
    },
  };
}

/** Every event this fixture scores, pulled out of one receipt. */
function harvest(ctx, rc, ledger) {
  const mxIface = ctx.mats[0].a.interface;
  const pmIface = ctx.pm.interface;
  for (const lg of rc.logs) {
    let ev = null;
    try { ev = mxIface.parseLog(lg); } catch { /* not a matrix event */ }
    if (ev) {
      const where = ctx.label.get(lg.address.toLowerCase());
      if (!where) continue;
      if (ev.name === "MemberEntered")          ledger.entered.push({ m: ev.args.member, where, pos: Number(ev.args.bfsPosition) });
      else if (ev.name === "MemberCrossedToPartner") ledger.crossed.push({ m: ev.args.member, from: ctx.label.get(ev.args.fromMatrix.toLowerCase()), to: ctx.label.get(ev.args.toMatrix.toLowerCase()) });
      else if (ev.name === "MemberCycledOut")   ledger.cycledOut.push({ m: ev.args.member, where: ctx.label.get(ev.args.fromMatrix.toLowerCase()) });
      else if (ev.name === "MemberParked")      ledger.parked.push({ m: ev.args.member, where });
      continue;
    }
    try { ev = pmIface.parseLog(lg); } catch { continue; }
    if (!ev) continue;
    if (ev.name === "RescueOverflowed") ledger.overflow.push({ m: ev.args.member, from: Number(ev.args.fromPair), to: Number(ev.args.toPair) });
    else if (ev.name === "MemberRouted") ledger.routed.push({ m: ev.args.member, pair: Number(ev.args.pairId) });
  }
}

function emptyLedger() {
  return { entered: [], crossed: [], cycledOut: [], parked: [], overflow: [], routed: [] };
}

/** Front-door registration. Every event it causes lands in `ledger`. */
async function reg(ctx, signer, referrer, ledger) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  const rc = await (await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 })).wait();
  harvest(ctx, rc, ledger);
}

/** Pure member-driven churn: anyone parked anywhere selfRescues. No keeper. */
async function rescueParked(ctx, ledger) {
  for (const p of ctx.mats) {
    for (const mat of [p.a, p.b]) {
      const count = Number(await mat.getParkedCount());
      for (let k = 0; k < count; k++) {
        const addr   = await mat.getParkedMember(0);
        const signer = ctx.sigs.find((s) => s.address === addr);
        if (!signer) break;
        await ctx.usdc.mint(signer.address, FEE);
        await ctx.usdc.connect(signer).approve(await mat.getAddress(), FEE);
        const rc = await (await mat.connect(signer).selfRescue({ gasLimit: 16_000_000 })).wait();
        harvest(ctx, rc, ledger);
      }
    }
  }
}

/** Who is sitting where in a matrix, by seat. */
async function seats(mat, size) {
  const out = new Map();
  for (let p = 0; p <= size; p++) {
    const who = await mat.posToMember(p);
    if (who !== ethers.ZeroAddress) out.set(who, p);
  }
  return out;
}

async function snapshot(ctx, size) {
  const s = [];
  for (const p of ctx.mats) {
    s.push({
      occA: Number(await p.a.occupancy()), rotA: Number(await p.a.rotationCount()),
      occB: Number(await p.b.occupancy()), rotB: Number(await p.b.rotationCount()),
    });
  }
  return s;
}

const occLine = (s, size) =>
  s.map((x, i) => `P${i} A ${x.occA}/${size} rot ${x.rotA} · B ${x.occB}/${size} rot ${x.rotB}`).join("  |  ");

// ───────────────────────────────────────────────────────────────────────────────────────
// THE RUN
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * @param pmName   which PairManager to deploy (the arm)
 * @param openAtB  pair 2 is added the moment pair 1's MatB occupancy reaches this
 */
async function run(pmName, openAtB, tag) {
  const ctx = await deployThreePairs(SIZE, pmName);
  const { W1, sigs } = ctx;
  const wallets = sigs.slice(10, 290);
  let wi = 0;

  const pre  = emptyLedger();  // everything before pair 2 opens
  const win  = emptyLedger();  // the CAPTURE WINDOW: SIZE registrations after opening
  const post = emptyLedger();  // the rest of the tail
  let cur = pre;

  const step = async () => {
    if (wi >= wallets.length) throw new Error(`${tag}: ran out of wallets at ${wi} registrations — raise the signer count or lower SI_SIZE`);
    await reg(ctx, wallets[wi++], W1.address, cur);
    await rescueParked(ctx, cur);
  };

  await reg(ctx, W1, ethers.ZeroAddress, pre);

  // ── Phase 1: drive with TWO pairs until pair 1's MatB reaches openAtB.
  let reached = false;
  const cap = 30 * SIZE;
  for (let i = 0; i < cap && !reached; i++) {
    await step();
    reached = Number(await ctx.mats[1].b.occupancy()) >= openAtB;
    if (wi % 10 === 0) log(`${tag}  phase 1  reg ${wi}   ${occLine(await snapshot(ctx, SIZE), SIZE)}`);
  }
  const atOpen  = await snapshot(ctx, SIZE);
  const regsAtOpen = wi;

  // Who is sitting in pair 1 at the moment of opening, and where. This is the Sherwyn
  // population: the members whose seats either move or do not over the capture window.
  const p1aSeatsAtOpen = await seats(ctx.mats[1].a, SIZE);
  const p1bSeatsAtOpen = await seats(ctx.mats[1].b, SIZE);

  if (!reached) return { ok: false, tag, reason: `pair 1 MatB never reached ${openAtB}/${SIZE} in ${wi} registrations`, atOpen, regsAtOpen };

  // ── Pair 2 opens. THIS is the only thing that can make the two arms differ.
  await ctx.openPair2();
  log(`${tag}  ── PAIR 2 OPENS after ${regsAtOpen} registrations ──  ${occLine(atOpen, SIZE)}`);

  // ── Phase 2: the CAPTURE WINDOW — SIZE registrations, the time pair 2's MatA needs to
  //    fill and stop looking like "room". Fixed length so both arms get the same window.
  cur = win;
  for (let i = 0; i < SIZE; i++) {
    await step();
    log(`${tag}  window   reg ${wi}   ${occLine(await snapshot(ctx, SIZE), SIZE)}`);
  }
  const atWindowEnd = await snapshot(ctx, SIZE);
  const p1aSeatsAtEnd = await seats(ctx.mats[1].a, SIZE);
  const p1bSeatsAtEnd = await seats(ctx.mats[1].b, SIZE);

  // ── Phase 3: tail, to see whether the older pair recovers (live, it did — on 09-12).
  cur = post;
  for (let i = 0; i < TAIL; i++) {
    await step();
    if (wi % 10 === 0) log(`${tag}  tail     reg ${wi}   ${occLine(await snapshot(ctx, SIZE), SIZE)}`);
  }
  const atEnd = await snapshot(ctx, SIZE);

  // ── SEATS ADVANCED: for everyone seated in pair 1 when pair 2 opened and still seated at
  //    the end of the window, how many seats did they actually move toward the root?
  //    Members who left the seat entirely are counted as ladder progress, not here.
  const seatsAdvanced = (before, after) => {
    let moved = 0, frozen = 0, total = 0;
    for (const [m, posBefore] of before) {
      const posAfter = after.get(m);
      if (posAfter === undefined) continue;    // left the matrix — counted as a rung instead
      total += posBefore - posAfter;
      if (posAfter < posBefore) moved++; else frozen++;
    }
    return { total, moved, frozen };
  };
  const advA = seatsAdvanced(p1aSeatsAtOpen, p1aSeatsAtEnd);
  const advB = seatsAdvanced(p1bSeatsAtOpen, p1bSeatsAtEnd);

  const score = (L) => ({
    // LADDER PROGRESS
    rung1: L.crossed.length,                                        // MatA → MatB
    rung1p1: L.crossed.filter((c) => c.from === "P1.MatA").length,
    rung2: L.cycledOut.filter((c) => c.where && c.where.endsWith("MatB")).length,  // left the pair
    rung2p1: L.cycledOut.filter((c) => c.where === "P1.MatB").length,
    // FLOW
    entriesP1: L.entered.filter((e) => e.where.startsWith("P1")).length,
    entriesP2: L.entered.filter((e) => e.where.startsWith("P2")).length,
    // The live table's two columns: 0→1 and 0→2. Overflow out of the FRONT-DOOR pair is the
    // stream 62.54 measured being diverted; overflow out of a later pair is a different
    // question and is kept separate rather than pooled.
    ov0to1: L.overflow.filter((o) => o.from === 0 && o.to === 1).length,
    ov0to2: L.overflow.filter((o) => o.from === 0 && o.to === 2).length,
    ovTo1: L.overflow.filter((o) => o.to === 1).length,
    ovTo2: L.overflow.filter((o) => o.to === 2).length,
    parked: L.parked.length,
  });

  return {
    ok: true, tag, regsAtOpen, regsTotal: wi,
    atOpen, atWindowEnd, atEnd,
    pre: score(pre), win: score(win), post: score(post),
    advA, advB,
    rotTotalWindow: atWindowEnd.reduce((t, x, i) => t + (x.rotA - atOpen[i].rotA) + (x.rotB - atOpen[i].rotB), 0),
    rotTotalAll: atEnd.reduce((t, x) => t + x.rotA + x.rotB, 0),
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────

function report(name, C, T) {
  log("");
  log(`══ ${name} ════════════════════════════════════════════════════════`);
  if (!C.ok || !T.ok) {
    log(`   ⛔ RUN DID NOT REACH THE STATE UNDER TEST — nothing below is printed.`);
    if (!C.ok) log(`      control : ${C.reason}`);
    if (!T.ok) log(`      inverted: ${T.reason}`);
    return;
  }
  const row = (k, get) => log(
    (k + " ".repeat(34)).slice(0, 34) +
    ("control " + get(C)).padEnd(22) +
    ("inverted " + get(T))
  );
  log(`   registrations before pair 2 opened: control ${C.regsAtOpen} · inverted ${T.regsAtOpen}`);
  log(`   at open   control  ${occLine(C.atOpen, SIZE)}`);
  log(`   at open   inverted ${occLine(T.atOpen, SIZE)}`);
  log("");
  log("   ── CAPTURE WINDOW (the SIZE registrations after pair 2 opened) ──");
  row("overflow 0→1 (front door → pair 1)", (r) => r.win.ov0to1);
  row("overflow 0→2 (front door → pair 2)", (r) => r.win.ov0to2);
  row("overflow → pair 1, any source", (r) => r.win.ovTo1);
  row("overflow → pair 2, any source", (r) => r.win.ovTo2);
  row("entries landing in pair 1",     (r) => r.win.entriesP1);
  row("entries landing in pair 2",     (r) => r.win.entriesP2);
  log("");
  log("   ── LADDER PROGRESS in that window — THE METRIC ──");
  row("rung 1  crossed MatA→MatB",     (r) => r.win.rung1);
  row("   of which in pair 1",         (r) => r.win.rung1p1);
  row("rung 2  cycled OUT of a MatB",  (r) => r.win.rung2);
  row("   of which in pair 1",         (r) => r.win.rung2p1);
  row("pair 1 MatA seats advanced",    (r) => `${r.advA.total} (${r.advA.moved} moved, ${r.advA.frozen} frozen)`);
  row("pair 1 MatB seats advanced",    (r) => `${r.advB.total} (${r.advB.moved} moved, ${r.advB.frozen} frozen)`);
  log("");
  log("   ── ROTATION VOLUME — THE TRAP METRIC. Printed, never the verdict. ──");
  row("rotations in the window",       (r) => r.rotTotalWindow);
  row("rotations over the whole run",  (r) => r.rotTotalAll);
  log("");
  log("   ── WHOLE RUN ──");
  row("rung 1 total",                  (r) => r.pre.rung1 + r.win.rung1 + r.post.rung1);
  row("rung 2 total",                  (r) => r.pre.rung2 + r.win.rung2 + r.post.rung2);
  row("parked events total",           (r) => r.pre.parked + r.win.parked + r.post.parked);
  log(`   at end    control  ${occLine(C.atEnd, SIZE)}`);
  log(`   at end    inverted ${occLine(T.atEnd, SIZE)}`);
  log("");
}

describe("V8.54 — stage inversion in the overflow escape hatch, scored on LADDER PROGRESS", function () {
  this.timeout(7_200_000);

  const cases = [
    { name: `LIVE geometry — pair 2 opens at pair 1 MatB ${Math.floor(SIZE * 0.9)}/${SIZE} (90%, the factory trigger)`, openAtB: Math.floor(SIZE * 0.9), key: "live" },
    { name: `EARLY geometry — pair 2 opens at pair 1 MatB ${Math.floor(SIZE * 0.5)}/${SIZE} (50%)`,                     openAtB: Math.floor(SIZE * 0.5), key: "early" },
  ];
  const R = {};

  before(async () => {
    log(`SIZE=${SIZE}  TAIL=${TAIL}  (override with SI_SIZE / SI_TAIL)`);
    for (const c of cases) {
      R[c.key] = {
        C: await run("PairManagerV8",               c.openAtB, `${c.key}/control `),
        T: await run("PairManagerV8_StageInverted", c.openAtB, `${c.key}/inverted`),
      };
      report(c.name, R[c.key].C, R[c.key].T);
    }
  });

  for (const c of cases) {
    describe(c.name, function () {

      it("R1 rig: both arms actually reached the state under test", function () {
        const { C, T } = R[c.key];
        expect(C.ok, `control arm never set up: ${C.reason}`).to.equal(true);
        expect(T.ok, `inverted arm never set up: ${T.reason}`).to.equal(true);
        // Pair 1's MatA must be FULL at the open — otherwise there is nothing for stage 2 to
        // find and the two orders cannot differ.
        expect(C.atOpen[1].occA, "pair 1 MatA was not full when pair 2 opened — the rig is not reproducing the geometry").to.equal(SIZE);
        expect(C.atOpen[1].occB, "pair 1 MatB was already full when pair 2 opened — there is no starvation to observe").to.be.lessThan(SIZE);
      });

      it("R2 rig: the two arms are IDENTICAL before pair 2 opens (the built-in control)", function () {
        const { C, T } = R[c.key];
        // With only two pairs, both stage orders return the same pair. Any difference here is
        // an uncontrolled variable and everything downstream is void.
        expect(T.regsAtOpen, "arms diverged BEFORE pair 2 opened — the rig has an uncontrolled difference").to.equal(C.regsAtOpen);
        expect(JSON.stringify(T.atOpen), "pre-open chain state differs between arms").to.equal(JSON.stringify(C.atOpen));
        expect(JSON.stringify(T.pre), "pre-open ladder ledger differs between arms").to.equal(JSON.stringify(C.pre));
      });

      it("R3 planted positive: on TODAY's code the new pair CAPTURES the stream and pair 1 is starved", function () {
        const { C } = R[c.key];
        // If this passes on unfixed code the rig is not reproducing 62.54's finding and the
        // headline below is worthless — see REGRESSION_REGISTER R8.
        expect(C.win.ov0to1,
          `control sent ${C.win.ov0to1} front-door overflow event(s) into pair 1 during the capture window — expected 0. ` +
          `62.54 measured the brand-new pair taking the WHOLE 0→ stream (09-10: 0/59, 09-11: 0/48). If this is not 0 the rig is not reproducing the capture.`)
          .to.equal(0);
        expect(C.win.ov0to2, "control sent nothing to pair 2 either — there was no front-door overflow at all in the window, so nothing is being tested").to.be.greaterThan(0);
      });

      it("H1 HEADLINE: inverting the stages buys LADDER PROGRESS in pair 1 during the capture window", function () {
        const { C, T } = R[c.key];
        const cProg = C.win.rung1p1 + C.win.rung2p1 + C.advA.total + C.advB.total;
        const tProg = T.win.rung1p1 + T.win.rung2p1 + T.advA.total + T.advB.total;
        expect(tProg,
          `inverted bought no ladder progress in the starved pair: control ${cProg} vs inverted ${tProg}. ` +
          `A RED HERE IS A RESULT — it says the inversion is not worth a redeploy at this geometry. Do not edit the fixture until it agrees.`)
          .to.be.greaterThan(cProg);
      });

      it("H2 the starved pair is actually fed instead of skipped", function () {
        const { C, T } = R[c.key];
        expect(T.win.ov0to1, "inverted did not send the front-door overflow into the older full pair — the override is not taking effect").to.be.greaterThan(C.win.ov0to1);
        expect(T.atWindowEnd[1].occB, "inverted left pair 1's MatB no fuller than the control did").to.be.gte(C.atWindowEnd[1].occB);
      });

      it("G1 relocation guard: the NEW pair still fills — the freeze is not merely moved", function () {
        const { T } = R[c.key];
        // Self-limiting claim: once the older pair's MatB fills it stops qualifying for stage
        // 1 on its own, and the new pair's MatA gets fed. If pair 2 ends empty, the inversion
        // has starved the new pair instead, which is the same defect pointed the other way.
        expect(T.atEnd[2].occA, "pair 2's MatA is still empty at the end of the run — the inversion relocated the starvation").to.be.greaterThan(0);
      });

      it("G2 no-regression guard: whole-run ladder progress is not worse", function () {
        const { C, T } = R[c.key];
        const tot = (r) => r.pre.rung1 + r.win.rung1 + r.post.rung1 + r.pre.rung2 + r.win.rung2 + r.post.rung2;
        expect(tot(T), `inverted made the SYSTEM worse over the whole run: control ${tot(C)} vs inverted ${tot(T)}`).to.be.gte(tot(C));
      });

      it("G3 treadmill guard: the inversion must not win on rotation volume while losing on completions", function () {
        const { C, T } = R[c.key];
        const comp = (r) => r.pre.rung2 + r.win.rung2 + r.post.rung2;
        if (T.rotTotalAll > C.rotTotalAll) {
          expect(comp(T),
            `inverted scored MORE rotations (${T.rotTotalAll} vs ${C.rotTotalAll}) but FEWER members completing the ladder ` +
            `(${comp(T)} vs ${comp(C)}). That is the August treadmill — high rotation volume, members going round in place. REJECT.`)
            .to.be.gte(comp(C));
        }
      });
    });
  }
});
