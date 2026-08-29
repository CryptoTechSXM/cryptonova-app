"use strict";
/**
 * V8_50_Graduation.test.js — does MatB GRADUATION fix the saturated pair?
 * Written 2026-08-30, session 50, against V8_50_HANDOFF 49.1h.
 *
 * WHY THIS EXISTS. 49.1h proposed the original V8.41 design — a cycled-out MatB root
 * GRADUATES to the next pair instead of re-entering its own MatA — and counted the seats
 * on PAPER:
 *
 *     MatA root cycles out (one seat free) -> crosses to MatB -> MatB root cycles out
 *     and GRADUATES to the next pair -> A's root takes MatB's freed seat -> the ARRIVING
 *     member takes MatA's freed seat.  Nobody parked, the pair keeps rotating.
 *
 * The handoff was explicit that this is a count on paper and must not be believed until
 * it is run.  ⛔ THE OWNER'S TWO RULES: measure before implementing, and a number that
 * has not been run is not a result.  So the G0 baselines run FIRST, against the code
 * exactly as it stands.
 *
 * WHY A NEW EXTERNAL REGISTRATION AND NOT A RESCUE.  V8.50 item S already diverts
 * RESCUES out of a both-halves-full pair (O1/O4), so a rescue would measure item S, not
 * graduation.  A new external registration is untouched by item S — the owner scoped it
 * to "rescued members only" — and `PairManagerV8._findExternalPair()` is
 * `internal pure returns 0`, ONE DOOR, so every new member enters pair 0 whether or not
 * pair 0 has a seat for them.  That is the live shape: T1.1 saturated and still taking
 * every arrival, T1.2 sitting at rotation 0 with 244 free seats.
 *
 * ⛔ WHAT THE BASELINE ASSERTS, AND WHY IT IS NOT "THE ARRIVAL IS PARKED".
 * The first draft of G0 asserted the arrival gets parked and FAILED — with thin splits
 * the MatB root was $1.42 short of the hop, funding-parked, and the arrival kept the
 * seat.  That is C1's brake, not a contradiction: 49.1e says the structure holds with
 * the brake ON TOO — "still one in, one parked".  WHICH member is robbed depends on
 * whether the MatB root can afford the hop; THAT ONE IS PARKED PER ENTRY does not.
 * So the baseline asserts the invariant, and G0a/G0b measure it from both sides.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

// Production-shaped weights: a MatB root cannot fund the full-fee hop. The brake is ON.
const THIN_SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
// C5's declared lever (49.6): the SAME mandatory 4750 bps redistributed into referral
// income so a well-sponsored MatB root CAN afford the hop. No money added. The brake is
// OFF. ⚠ NOT production weights — this says nothing about live economics.
const SOLVENT_SPLITS = {
  l1Bps: 4000, chainBps: 100, poolBps: 500,
  treasuryBps: 50, stabilityBps: 50,
  devBps: 20, opsBps: 15, communityBps: 10, buybackBps: 5,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE  = 10_000_000n;
const SIZE = 4;

const usd = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
const eq  = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Parsed with the EMITTER kept, because 48.0's whole finding is that a park in the
// DESTINATION is a different code site from a park in the SOURCE.
const EV = new ethers.Interface([
  "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)",
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix)",
  "event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix)",
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event RescueOverflowed(address indexed member, uint256 indexed fromPair, uint256 indexed toPair)",
  "event MemberReentered(address indexed member, uint8 tier)",
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

async function addPair(ctx, splits) {
  const matA = await ctx.MX.deploy(ctx.dp, FEE, SIZE, true,  0, splits, CP_BPS);
  const matB = await ctx.MX.deploy(ctx.dp, FEE, SIZE, false, 0, splits, CP_BPS);
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
  return { matA, matB, a: await matA.getAddress(), b: await matB.getAddress() };
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

function labeller(p1, p2) {
  const names = new Map();
  names.set(p1.a.toLowerCase(), "P1.MatA");
  names.set(p1.b.toLowerCase(), "P1.MatB");
  if (p2) { names.set(p2.a.toLowerCase(), "P2.MatA"); names.set(p2.b.toLowerCase(), "P2.MatB"); }
  return (addr) => names.get(String(addr).toLowerCase()) || String(addr).slice(0, 10);
}

function trace(rc, name, who) {
  const out = [];
  for (const l of rc.logs) {
    let ev = null;
    try { ev = EV.parseLog({ topics: [...l.topics], data: l.data }); } catch { continue; }
    if (!ev) continue;
    out.push({ emitter: name(l.address), event: ev.name, who: who(ev.args[0]),
               member: String(ev.args[0]), args: ev.args });
  }
  return out;
}

function printTrace(t, name, label) {
  console.log(`      [trace ] ${label}`);
  for (const e of t) {
    const extra = e.event === "MemberParked" ? `  shortfall ${usd(e.args[1])}`
                : e.event === "MemberEntered" ? `  pos ${e.args[1]}`
                : e.event === "MemberCrossedToPartner" ? `  -> ${name(e.args[2])}`
                : e.event === "RescueOverflowed" ? `  pair ${e.args[1]} -> pair ${e.args[2]}` : "";
    console.log(`         ${e.emitter.padEnd(10)} ${e.event.padEnd(23)} ${e.who.padEnd(10)}${extra}`);
  }
}

async function snap(p1, p2) {
  return {
    rotA: await p1.matA.rotationCount(), rotB: await p1.matB.rotationCount(),
    occA: await p1.matA.occupancy(),     occB: await p1.matB.occupancy(),
    parkA: await p1.matA.getParkedCount(), parkB: await p1.matB.getParkedCount(),
    p2A: await p2.matA.occupancy(),      p2B: await p2.matB.occupancy(),
  };
}
const seatTotal = (s) => Number(s.occA) + Number(s.occB) + Number(s.p2A) + Number(s.p2B);

function show(tag, s) {
  console.log(`      [${tag}] P1 MatA ${s.occA}/${SIZE} rot ${s.rotA} parked ${s.parkA}` +
              ` · MatB ${s.occB}/${SIZE} rot ${s.rotB} parked ${s.parkB}` +
              ` · P2 MatA ${s.p2A}/${SIZE} MatB ${s.p2B}/${SIZE}`);
}

/** Saturate pair 0 in both halves, then add an empty pair 1 as the graduation target. */
async function buildSaturated(splits) {
  const ctx = await deployBase();
  const p1  = await addPair(ctx, splits);
  await register(ctx, ctx.W1, ethers.ZeroAddress);
  for (let i = 0; i < SIZE * 14 + 30; i++) {
    await register(ctx, await newWallet(ctx), ctx.W1.address);
    if (await p1.matA.isFull() && await p1.matB.isFull()) break;
  }
  const p2 = await addPair(ctx, splits);
  return { ctx, p1, p2 };
}

/** C5's technique: feed referrals to MatB position 2, who becomes root next rotation. */
async function fundMatBRoot(ctx, p1) {
  const funds = async a => (await p1.matB.crossingReserveOf(a)) + (await p1.matB.withdrawableOf(a));
  let root = await p1.matB.posToMember(1);
  for (let i = 0; i < 15 && (await funds(root)) < FEE; i++) {
    const heir = await p1.matB.posToMember(2);
    if (heir === ethers.ZeroAddress) break;
    await register(ctx, await newWallet(ctx), heir);
    root = await p1.matB.posToMember(1);
  }
  return { root, held: await funds(root) };
}

describe("V8.50 — MatB graduation (49.1h): does it seat the arrival?", function () {
  this.timeout(1_800_000);

  /** One new external member registers into a pair that is full in BOTH halves. */
  async function arrive(ctx, p1, p2) {
    const name = labeller(p1, p2);
    const before = await snap(p1, p2);
    show("before", before);

    const arrival = await newWallet(ctx);
    const who = (a) => (eq(a, arrival.address) ? "ARRIVAL" : "incumbent");
    const rc = await (await register(ctx, arrival, ctx.W1.address)).wait();
    const t = trace(rc, name, who);
    printTrace(t, name, "one registration into the saturated pair");

    const after = await snap(p1, p2);
    show("after ", after);

    const seated = (await p1.matA.isActiveInMatrix(arrival.address))
                || (await p1.matB.isActiveInMatrix(arrival.address))
                || (await p2.matA.isActiveInMatrix(arrival.address))
                || (await p2.matB.isActiveInMatrix(arrival.address));
    const parks = t.filter(e => e.event === "MemberParked");
    const arrivalParks = parks.filter(e => e.who === "ARRIVAL");
    const p2Received = (Number(after.p2A) + Number(after.p2B)) - (Number(before.p2A) + Number(before.p2B));

    console.log(`      [seats ] total seated across BOTH pairs: ${seatTotal(before)} -> ${seatTotal(after)}` +
                `   (one member arrived and paid ${usd(FEE)})`);
    console.log(`      [result] arrival seated: ${seated ? "YES" : "NO"}` +
                ` · parks in this tx: ${parks.length}` +
                `${parks.length ? ` (${parks.map(p => `${p.who}@${p.emitter} ${usd(p.args[1])}`).join(", ")})` : ""}` +
                ` · P2 received: ${p2Received}`);
    return { before, after, seated, parks, arrivalParks, p2Received, t, arrival, name };
  }

  it("G0a BASELINE, BRAKE ON — thin splits: who pays for the arrival?", async function () {
    const { ctx, p1, p2 } = await buildSaturated(THIN_SPLITS);
    expect(await p1.matA.isFull(), "premise failed: P1 MatA not saturated").to.equal(true);
    expect(await p1.matB.isFull(), "premise failed: P1 MatB not saturated").to.equal(true);
    expect(await p2.matA.occupancy(), "premise failed: P2 MatA should start empty").to.equal(0n);

    const r = await arrive(ctx, p1, p2);
    console.log(`      >> ${seatTotal(r.after) === seatTotal(r.before)
      ? "ONE IN, ONE PARKED. The pair absorbed nobody — 49.1e's structure at fixture scale."
      : "THE PAIR ABSORBED SOMEBODY — that contradicts 49.1e. Stop and re-read."}`);

    // THE INVARIANT, not the identity of the victim.
    expect(seatTotal(r.after),
      "the saturated pair ABSORBED the arrival — 49.1e's 'a saturated pair cannot absorb anybody' " +
      "does not hold in this fixture, so nothing downstream of it can be trusted"
    ).to.equal(seatTotal(r.before));
    expect(r.parks.length, "no park at all in a saturated-pair entry — re-read the trace").to.be.greaterThan(0);
    expect(r.p2Received, "P2 received someone with no graduation in the code — baseline contaminated").to.equal(0);
  });

  it("G0b BASELINE, BRAKE OFF — a solvent MatB root: the arrival is the one robbed", async function () {
    const { ctx, p1, p2 } = await buildSaturated(SOLVENT_SPLITS);
    const { root, held } = await fundMatBRoot(ctx, p1);
    console.log(`      [solvnt] MatB root ${String(root).slice(0, 10)} holds ${usd(held)} against a ${usd(FEE)} hop`);

    expect(held,
      "premise failed: no MatB root could be made solvent even with referral-weighted splits — " +
      "without that this is just G0a again and measures nothing"
    ).to.be.gte(FEE);
    expect(await p1.matA.isFull(), "premise failed: P1 MatA not saturated after funding").to.equal(true);
    expect(await p1.matB.isFull(), "premise failed: P1 MatB not saturated after funding").to.equal(true);

    const r = await arrive(ctx, p1, p2);
    console.log(`      >> ${!r.seated && r.arrivalParks.length
      ? "THE ARRIVAL IS THE VICTIM — C5's theft, reached through a plain registration."
      : "the arrival kept its seat even with a solvent root — read the trace"}`);

    expect(seatTotal(r.after), "the saturated pair ABSORBED the arrival — contradicts 49.1e").to.equal(seatTotal(r.before));
    expect(r.parks.length, "no park at all in a saturated-pair entry — re-read the trace").to.be.greaterThan(0);
    expect(r.p2Received, "P2 received someone with no graduation in the code — baseline contaminated").to.equal(0);
  });

  it("G1 — GRADUATION ON, solvent root: does the arrival keep the seat 49.1h says it should?", async function () {
    const { ctx, p1, p2 } = await buildSaturated(SOLVENT_SPLITS);
    const { root, held } = await fundMatBRoot(ctx, p1);
    console.log(`      [solvnt] MatB root ${String(root).slice(0, 10)} holds ${usd(held)} against a ${usd(FEE)} hop`);
    expect(held, "premise failed: root not solvent — this would just be G0a again").to.be.gte(FEE);
    expect(await p1.matA.isFull(), "premise failed: P1 MatA not saturated").to.equal(true);
    expect(await p1.matB.isFull(), "premise failed: P1 MatB not saturated").to.equal(true);

    // THE ONE CHANGE. Everything else is G0b exactly.
    await ctx.tr.setGraduationEnabled(true);
    expect(await ctx.tr.graduationEnabled(), "the flag did not take").to.equal(true);

    const r = await arrive(ctx, p1, p2);
    const grew = seatTotal(r.after) - seatTotal(r.before);
    console.log(`      >> ${r.seated && r.parks.length === 0 && grew === 1
      ? "49.1h HOLDS. Nobody parked, the tier absorbed the arrival, and a member reached the empty pair."
      : "49.1h DOES NOT HOLD AS COUNTED — read the trace and the seat delta before believing anything."}`);

    // The paper count, asserted line by line so each half can fail on its own.
    expect(r.seated,
      "⛔ GRADUATION DID NOT SEAT THE ARRIVAL. 49.1h's count on paper is wrong and item S stays the " +
      "only candidate — do NOT ship graduation, and correct 49.1h before anything else."
    ).to.equal(true);
    expect(r.parks.length,
      "graduation seated the arrival but somebody ELSE was parked in the same transaction — the victim " +
      "moved, the park did not go away. That is 'reserve the seat' (49.1e) wearing a different hat."
    ).to.equal(0);
    expect(grew,
      "the tier's total seated count did not grow by exactly one. 49.1e's whole point is that a saturated " +
      "pair cannot absorb anybody; if graduation is the fix, THIS is the number that proves it."
    ).to.equal(1);
    expect(r.p2Received, "nobody reached P2 — the graduating root went somewhere else").to.equal(1);
    expect(Number(r.after.rotA) - Number(r.before.rotA), "P1 MatA did not rotate").to.be.greaterThan(0);
    expect(Number(r.after.rotB) - Number(r.before.rotB), "P1 MatB did not rotate").to.be.greaterThan(0);
  });

  it("G2 — GRADUATION ON, INSOLVENT root: the brake still fires and nothing is diverted", async function () {
    const { ctx, p1, p2 } = await buildSaturated(THIN_SPLITS);
    await ctx.tr.setGraduationEnabled(true);
    const r = await arrive(ctx, p1, p2);
    const funding = r.parks.filter(e => Number(e.args[1]) > 0);
    console.log(`      >> ${funding.length && r.seated && r.p2Received === 0
      ? "BRAKE INTACT. An insolvent root never reaches the graduation branch, so item G is invisible here."
      : "the insolvent case CHANGED under item G — read the trace, this is not what item G is allowed to touch."}`);

    // ⛔ THIS IS THE C1 TRIPWIRE FOR ITEM G. The insolvent MatB root funding-parks in
    // TierRouter's no-strand epilogue (:1473-1482) BEFORE _executeAdditive ever calls
    // sameTierTarget, so graduation cannot fire. If this goes red, item G is reaching a
    // path it was never scoped to touch.
    expect(funding.length,
      "the funding park is gone with graduation ON — item G is firing on a path where the root cannot " +
      "even afford the hop. 49.2's brake is what suppresses the theft; do not let item G remove it."
    ).to.be.greaterThan(0);
    expect(r.seated, "the arrival lost its seat in the insolvent case — item G made this WORSE").to.equal(true);
    expect(r.p2Received, "an insolvent root was diverted to P2 — it cannot afford to be there").to.equal(0);
  });

  it("G3 — THE FREEZE QUESTION (49.1g/49.1h): does the pair keep rotating under sustained arrivals?", async function () {
    const { ctx, p1, p2 } = await buildSaturated(SOLVENT_SPLITS);
    await fundMatBRoot(ctx, p1);
    await ctx.tr.setGraduationEnabled(true);

    // O4 measured item S freezing a saturated pair: 3 rescues, 3 diversions, rot +0.
    // Item G is a different path — the ARRIVAL still enters MatA — so the entry that
    // drives the rotation still happens. That is the claim; this counts it.
    const s0 = await snap(p1, p2);
    let noSeatParks = 0, fundingParks = 0, seatedTotal = 0;
    // N is deliberately BELOW P2.MatA's capacity. Once the graduation target fills up
    // there is nowhere to send the root and the pair falls back to today's park — correct
    // behaviour, and G4 measures it. Mixing the two here would blur the freeze reading.
    const N = SIZE - 1;
    for (let i = 0; i < N; i++) {
      const a = await newWallet(ctx);
      const rc = await (await register(ctx, a, ctx.W1.address)).wait();
      const t = trace(rc, labeller(p1, p2), () => "x");
      for (const e of t.filter(x => x.event === "MemberParked")) {
        if (Number(e.args[1]) === 0) noSeatParks++; else fundingParks++;
      }
      if (await p1.matA.isActiveInMatrix(a.address)) seatedTotal++;
      console.log(`      [entry ${i + 1}] P1 MatA rot ${await p1.matA.rotationCount()}` +
                  ` MatB rot ${await p1.matB.rotationCount()}` +
                  ` · P2 MatA ${await p2.matA.occupancy()}/${SIZE} MatB ${await p2.matB.occupancy()}/${SIZE}`);
    }
    const s1 = await snap(p1, p2);
    const graduations = (Number(s1.p2A) + Number(s1.p2B)) - (Number(s0.p2A) + Number(s0.p2B));
    console.log(`      [after ] MatA rot +${Number(s1.rotA) - Number(s0.rotA)}` +
                ` · MatB rot +${Number(s1.rotB) - Number(s0.rotB)}` +
                ` · arrivals seated ${seatedTotal}/${N} · graduations ${graduations}` +
                ` · NO-SEAT parks ${noSeatParks} · FUNDING parks ${fundingParks}` +
                ` · tier seats ${seatTotal(s0)} -> ${seatTotal(s1)}`);
    console.log(`      >> ${Number(s1.rotA) > Number(s0.rotA) && Number(s1.rotB) > Number(s0.rotB)
      ? "STILL TURNING. Item G does not reproduce O4's freeze — the arrival still drives the rotation."
      : "FROZEN. Item G has O4's problem too and must not ship either."}`);

    expect(Number(s1.rotA) - Number(s0.rotA),
      "P1 MatA stopped rotating under item G — this is O4's freeze on the entry path, which is worse " +
      "than on the rescue path because it is EVERY arrival. Do not ship item G."
    ).to.be.greaterThan(0);
    expect(Number(s1.rotB) - Number(s0.rotB), "P1 MatB stopped rotating under item G").to.be.greaterThan(0);
    // ⛔⛔ THE ASSERTION THAT WAS WRONG THE FIRST TWO TIMES, AND WHY THIS ONE IS RIGHT.
    // Draft 1 asserted the tier grows by N. It came back 1 of 3 and that is NOT item G
    // failing — it is 49.2's inversion reasserting itself INSIDE this fixture. Only the
    // first arrival's MatB root was solvent (the sponsor, $66.65); once it graduated away
    // the next roots held ~$2.74 against a $10 hop, funding-parked in TierRouter's
    // no-strand epilogue (:1473-1482), and never reached the graduation branch at all.
    //
    // ✅ SO THE HONEST CLAIM, AND THE ONE ITEM G ACTUALLY MAKES: while a graduation target
    // exists, NO MEMBER IS EVER PARKED FOR WANT OF A SEAT. Parks that remain are FUNDING
    // parks — the member could not afford the hop, which is a different defect with a
    // different fix. That is the seating half of 49.2's "one job", measured.
    //
    // ⚠ AND IT SIZES THE PRIZE HONESTLY: live is 1638 funding parks to 105 no-seat parks.
    // Item G addresses the 105. It does NOT address the 1638, and shipping it must not be
    // reported as fixing the parked backlog.
    expect(noSeatParks,
      "a member was parked with shortfall 0 while a graduation target still had room — that is the " +
      ":529 no-seat park item G exists to eliminate, and it is still happening"
    ).to.equal(0);
    expect(graduations, "nobody graduated at all during the run — item G never fired").to.be.greaterThan(0);
    expect(seatTotal(s1) - seatTotal(s0),
      "the tier's seated count did not grow by exactly the number of graduations — a graduation that " +
      "does not add a seat is a member moved, not a member absorbed"
    ).to.equal(graduations);
    expect(seatedTotal, "an arrival failed to get a seat in P1.MatA").to.equal(N);
  });

  it("G4 — EXHAUSTION: when no pair has room, item G must fall back to today's park and NEVER revert", async function () {
    const { ctx, p1, p2 } = await buildSaturated(SOLVENT_SPLITS);
    await fundMatBRoot(ctx, p1);
    await ctx.tr.setGraduationEnabled(true);

    // Fill the ONLY graduation target, then arrive once more with nowhere to send anyone.
    for (let i = 0; i < SIZE * 4 && Number(await p2.matA.occupancy()) < SIZE; i++) {
      await register(ctx, await newWallet(ctx), ctx.W1.address);
    }
    console.log(`      [target] P2 MatA ${await p2.matA.occupancy()}/${SIZE} MatB ${await p2.matB.occupancy()}/${SIZE}` +
                ` · pairs ${await ctx.pm.pairCount()}`);

    const r = await arrive(ctx, p1, p2);
    console.log(`      >> ${r.parks.length > 0
      ? "FELL BACK CLEANLY. No revert, and somebody parked exactly as before item G — the safety net is the old behaviour."
      : "nobody parked with every reachable pair full — read the trace, a pair was created or a seat came from somewhere"}`);

    // ⛔ THE ONE THING THAT MUST NEVER HAPPEN. sameTierTarget runs inside _cycleOutRoot,
    // which has NO try/catch above it: a revert here kills an unrelated member's
    // registration (T3.1 and T4.1, both stopped dead on 2026-07-28 and repaired live).
    // Reaching this line at all means the transaction succeeded.
    expect(r.t.length, "the arrival transaction produced no matrix events at all — it did not do the work").to.be.greaterThan(0);
  });
});
