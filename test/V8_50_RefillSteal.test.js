"use strict";
/**
 * V8_50_RefillSteal.test.js — THE 48.4 FIXTURE. Written 2026-08-29, session 49.
 * Audience: the next session of Claude, plus the owner. No third party exists.
 *
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Handoff 48.4 carries a mechanism that is REASONED FROM SOURCE AND NOT MEASURED,
 * and says in as many words: "Prove it before building on it." This is that proof
 * — or that kill. THE TWO RULES apply: the disagreement is the finding, and a
 * hypothesis that has not been run is not a result.
 *
 * THE CLAIM UNDER TEST (48.4, verbatim in substance):
 *   With BOTH halves of a pair at capacity, `_cycleOutRoot` on A pushes its root
 *   into B, B cycles ITS root, and that root crosses back into the slot A just
 *   freed — the refill at MatrixLogicLib:529 consuming the seat the newcomer was
 *   cycled out to make.
 *
 * THE PATH IT PREDICTS, traced through the source 2026-08-29:
 *   MatB.selfRescue(victim)                                 MatrixLogicLib:1672
 *     -> _finalizeCrossing, pairManager branch              :~1075
 *        emits MemberCrossedToPartner(victim, MatB, PM)
 *     -> PairManagerV8.rescueReentry                        PairManagerV8:294
 *        V8.48 item 10: dest = OWN MatA, unconditionally
 *     -> MatA._enterMatrix(victim)
 *        MatA is full  -> _cycleOutRoot(A)                  :787
 *          A is MatA   -> _crossToPartner(A_root)           :911 -> :926
 *            MatB is full -> _cycleOutRoot(B)               :787
 *              B is MatB, tierRouter set -> handleCycleOut  :871
 *                -> TierRouter -> re-entry into OWN MatA
 *                -> _takeSeat CONSUMES THE SLOT A JUST FREED
 *        control returns to MatA._enterMatrix
 *        _lowestFreeSlot == 0 -> PARK                       :529
 *        emits MemberParked(victim, 0) in the DESTINATION
 *
 * That is EXACTLY the live signature on Sherwyn's trail (`0x1e8e2dcf`, 48.0):
 *   46118522   T1.1 MatB   MemberCrossedToPartner
 *   46118522   T1.1 MatA   MemberParked   PARKED shortfall $0.00
 * — same transaction, cross in MatB, park in MatA, shortfall 0, no CycleOutFailed.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY
 * ─────────────────────────────────────────────────────────────────────────────
 * V8_46_SeatCollision.test.js records the trap: an assertion loose enough to be
 * satisfied by the fallback proves nothing. So this test does not merely assert
 * "the victim ends up parked" — a funding park would satisfy that and the whole
 * point of 48.0 is that THESE parks are not funding parks. It asserts the three
 * things that separate the 48.4 mechanism from every other way to end up parked:
 *
 *   C1  the park is in the DESTINATION (MatA), carries shortfall 0, and is NOT
 *       accompanied by CycleOutFailed for the victim  -> isolates :529, not
 *       :881 / :908 (which pair with CycleOutFailed) and not :938 (source-side).
 *   C2  SOMEBODY ELSE took a MatA seat in that same transaction. This is the
 *       actual 48.4 claim — the refill — and it is what makes the park a STOLEN
 *       SEAT rather than a matrix that was simply never going to have room.
 *   C3  control: with MatB NOT saturated, the identical rescue SEATS the victim.
 *       Without C3, C1+C2 are also consistent with "a full MatA parks everyone",
 *       which would be a different bug with a different fix.
 *
 * IF C1 PASSES AND C2 FAILS: the park is real and reproducible but the refill
 * mechanism in 48.4 is WRONG. That is a kill, it is a good outcome, and the
 * failure message says so. Do not soften C2 to make it green.
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

// C5 ONLY. The constructor requires the splits to sum to exactly 4750 (the other
// 5250 is the 50% crossing reserve + direct earn — FigureEightMatrixV8:153-159), so
// this REDISTRIBUTES that same 4750 into referral income instead of adding money.
// Purpose: make a MatB member solvent enough to actually complete the full-fee hop
// back into MatA, which the production weights never allow (see C5's header).
// 4000 + 100 + 500 + 50 + 50 + 20 + 15 + 10 + 5 = 4750.
const SOLVENT_SPLITS = {
  l1Bps: 4000, chainBps: 100, poolBps: 500,
  treasuryBps: 50, stabilityBps: 50,
  devBps: 20, opsBps: 15, communityBps: 10, buybackBps: 5,
  liquidityBps: 0,
};
const FEE = 10_000_000n;

const EV = new ethers.Interface([
  "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)",
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix)",
  "event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix)",
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event CycleOutFailed(address indexed member, uint8 tierIndex)",
  "event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)",
  "event MemberReentered(address indexed member, uint8 tier)",
]);

const eq  = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const usd = v => "$" + (Number(v) / 1e6).toFixed(2);

/** One pair. sizeA / sizeB are separate on purpose — C3 needs a MatB that does
 *  not saturate while MatA does, and MATRIX_SIZE is per matrix. */
async function deployTier(sizeA, sizeB, splits = SPLITS) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
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
  const matA = await MX.deploy(dp, FEE, sizeA, true,  0, splits, CP_BPS);
  const matB = await MX.deploy(dp, FEE, sizeB, false, 0, splits, CP_BPS);
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

  const aAddr = await matA.getAddress();
  const bAddr = await matB.getAddress();
  return {
    usdc, tr, pm, sf, matA, matB, owner, W1, sizeA, sizeB,
    aAddr, bAddr, pmAddr: await pm.getAddress(),
    label: {
      [aAddr.toLowerCase()]: "MatA",
      [bAddr.toLowerCase()]: "MatB",
      [(await pm.getAddress()).toLowerCase()]: "PairManager",
      [(await tr.getAddress()).toLowerCase()]: "TierRouter",
    },
  };
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

/** Decode every event in a receipt we care about, tagged with WHICH contract
 *  emitted it. The emitter is the whole point — 48.0's finding is that a park in
 *  the DESTINATION is a different site from a park in the SOURCE. */
function trace(ctx, rc) {
  const out = [];
  for (const l of rc.logs) {
    let p = null;
    try { p = EV.parseLog({ topics: [...l.topics], data: l.data }); } catch { /* not ours */ }
    if (!p) continue;
    out.push({ ev: p.name, from: ctx.label[l.address.toLowerCase()] || l.address, args: p.args });
  }
  return out;
}

function printTrace(t, title) {
  console.log(`      ── ${title} ──`);
  if (t.length === 0) console.log("         (no decodable events)");
  for (const e of t) {
    const who = String(e.args[0]).slice(0, 10);
    let extra = "";
    if (e.ev === "MemberParked")  extra = ` shortfall ${usd(e.args[1])}`;
    if (e.ev === "MemberEntered") extra = ` pos ${e.args[1]}`;
    if (e.ev === "MemberCrossedToPartner")
      extra = ` -> ${String(e.args[2]).slice(0, 10)}`;
    console.log(`         ${String(e.from).padEnd(11)} ${e.ev.padEnd(24)} ${who}${extra}`);
  }
}

/** Register sponsored members until MatA is full and MatB has reached `wantB`
 *  occupancy. Returns the members created. Asserts nothing — the caller decides
 *  what a failure to reach the state means for its own premise. */
async function fill(ctx) {
  const made = [];
  for (let i = 0; i < ctx.sizeA * 12 + 24; i++) {
    const w = await newWallet(ctx);
    made.push(w);
    await register(ctx, w, ctx.W1.address);
    if (await ctx.matA.isFull() && await ctx.matB.isFull() && (await ctx.matB.getParkedCount()) > 0n) break;
  }
  return made;
}

async function state(ctx, tag) {
  console.log(
    `      [${tag}] MatA occ ${await ctx.matA.occupancy()}/${ctx.sizeA} full=${await ctx.matA.isFull()} ` +
    `rot ${await ctx.matA.rotationCount()} parked ${await ctx.matA.getParkedCount()}  |  ` +
    `MatB occ ${await ctx.matB.occupancy()}/${ctx.sizeB} full=${await ctx.matB.isFull()} ` +
    `rot ${await ctx.matB.rotationCount()} parked ${await ctx.matB.getParkedCount()}`
  );
}

/** Pick a member parked in MatB, fund their shortfall, and self-rescue them.
 *  Returns { victim, rc, t }. */
async function selfRescueFromB(ctx, victimAddr) {
  const signer = await ethers.getImpersonatedSigner(victimAddr);
  await ethers.provider.send("hardhat_setBalance",
    [victimAddr, "0x" + (10n ** 20n).toString(16)]);
  // Over-fund deliberately: the point of this test is the SEATING decision, and
  // an under-funded victim would park for the ordinary funding reason and the
  // test would pass for the wrong reason (the S2 trap, V8_46_MatAStarvation).
  await ctx.usdc.mint(victimAddr, FEE * 4n);
  await ctx.usdc.connect(signer).approve(ctx.bAddr, FEE * 4n);
  // Hardhat's per-transaction gas cap in this repo's toolbox is 16,777,216 (2^24) —
  // NOT the 30M block limit. Measured 2026-08-29: a 29M limit is rejected before the
  // call is even attempted ("exceeds transaction gas cap"). Sit just under it.
  // ⚠ IF THIS RESCUE EVER RUNS OUT OF GAS AT THIS CEILING, THAT IS ITSELF A FINDING:
  // it would mean one member's rescue can cascade past a block's worth of work.
  const tx = await ctx.matB.connect(signer).selfRescue({ gasLimit: 16_700_000 });
  const rc = await tx.wait();
  return { rc, t: trace(ctx, rc) };
}

describe("V8.50 / 48.4 — does a saturated partner steal the seat a newcomer was cycled out to make?", function () {
  this.timeout(1_800_000);

  it("C1: both halves saturated with an INSOLVENT MatB root — the rescued member IS SEATED, because the cascade's own root funding-parks instead of taking the seat (this test guards THE BRAKE; C5 is the theft)", async function () {
    // ⛔⛔ READ C5 WITH THIS. ON ITS OWN THIS TEST MISLED FOR ABOUT AN HOUR.
    //
    // Session 49 first read this result as "48.4 is killed". THAT WAS WRONG, and C5
    // proved it wrong in the same session: with a SOLVENT MatB root the theft fires
    // exactly as 48.4 described. 48.4 IS REAL AND IT IS FUNDING-GATED. What this test
    // actually measures is the case where THE BRAKE IS ON — the cycled MatB root cannot
    // afford the hop, so it never reaches MatA to take the seat.
    //
    // Trace, one transaction, sizes 4/4, insolvent root:
    //     MatB  SelfRescue             victim
    //     MatB  MemberCrossedToPartner victim -> PairManager
    //     MatA  MemberCycledOut        A_root          <- A cycles, as 48.4 predicted
    //     MatA  MemberCrossedToPartner A_root -> MatB  <- crosses, as 48.4 predicted
    //     MatB  MemberCycledOut        B_root          <- B cycles, as 48.4 predicted
    //     MatB  MemberParked           B_root  $5.48   <- ⛔ AND HERE IT STOPS
    //     MatB  MemberEntered          A_root  pos 4
    //     MatA  MemberEntered          victim  pos 4   <- SEATED
    //
    // B's cycled-out root never crossed back into MatA to eat the freed seat, because
    // IT COULD NOT AFFORD THE FULL-FEE MatB HOP and funding-parked $5.48 short of a $10
    // fee (TierRouter:1473-1482, the no-strand epilogue). So the seat A freed stayed
    // free and the newcomer took it.
    //
    // ⛔⛔ THE INVERSION — MEASURED FROM BOTH SIDES (C1 brake on, C5 brake off):
    // THE FUNDING SHORTAGE IS WHAT PREVENTS THE SEAT THEFT. The same shortage that
    // produces 1025 live funding parks is the brake stopping the cascade from consuming
    // a newcomer's seat. FIXING THE FUNDING WITHOUT FIXING THE SEATING CONVERTS FUNDING
    // PARKS INTO NO-SEAT PARKS — members who could not afford to be robbed will be able
    // to afford it. THE TWO FIXES ARE ONE JOB. Do not ship them apart.
    //
    // SO THIS TEST IS A TRIPWIRE. It asserts the brake still fires. If it goes RED,
    // the brake is gone and every rescue now runs C5's path, not this one.
    //
    // ⚠ SCALE CAVEAT, STILL TRUE: 4/4 with a thin income profile; live T1.1 is 127/127
    // at rot 1369. The live NO-SEAT parks are ~6% of all parks (68 of 1100), which is
    // consistent with "only the minority of MatB roots that are solvent can steal a
    // seat" — but that consistency is a HYPOTHESIS about live, not a measurement of it.
    const ctx = await deployTier(4, 4);
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await fill(ctx);
    await state(ctx, "setup");

    expect(await ctx.matA.isFull(), "premise failed: MatA never saturated").to.equal(true);
    expect(await ctx.matB.isFull(), "premise failed: MatB never saturated — this test is about BOTH halves being full").to.equal(true);
    const parkedCount = await ctx.matB.getParkedCount();
    expect(parkedCount, "premise failed: no member parked in MatB to rescue").to.be.gt(0n);

    const victim = await ctx.matB.getParkedMember(0);
    console.log(`      [victim] ${victim} — parked in MatB, ${parkedCount} parked there`);

    const { t } = await selfRescueFromB(ctx, victim);
    printTrace(t, "self-rescue receipt");
    await state(ctx, "after ");

    const crossed = t.find(e => e.ev === "MemberCrossedToPartner" && eq(e.args[0], victim) && e.from === "MatB");
    expect(crossed, "the rescue never left MatB — selfRescue did not reach _finalizeCrossing, so nothing about seating was exercised").to.not.equal(undefined);

    // The cascade must actually have run, or the seating result is uninteresting.
    const cycledA = t.filter(e => e.ev === "MemberCycledOut" && e.from === "MatA");
    const cycledB = t.filter(e => e.ev === "MemberCycledOut" && e.from === "MatB");
    expect(cycledA.length, "MatA never cycled its root — the entry did not hit the full-matrix path at all").to.be.greaterThan(0);
    expect(cycledB.length, "MatB never cycled its root — the cascade 48.4 describes did not run, so this test says nothing about it").to.be.greaterThan(0);

    // THE MEASURED OUTCOME: seated, not parked in the destination.
    const destPark = t.find(e => e.ev === "MemberParked" && e.from === "MatA" && eq(e.args[0], victim));
    const seated   = await ctx.matA.isActiveInMatrix(victim);
    expect(destPark,
      "⛔ THE VICTIM IS NOW PARKED IN THE DESTINATION — this fixture has started behaving like C5. " +
      "The funding brake is gone and 48.4's seat theft is now firing on the ORDINARY path, not just the " +
      "solvent-root one. Check what changed about member funding before doing anything else."
    ).to.equal(undefined);
    expect(seated, "the victim was neither seated nor parked in MatA — neither branch fired, the harness did not reach the seating decision").to.equal(true);

    // THE TRIPWIRE. This is the brake. If it disappears, re-open 48.4.
    const brake = t.find(e => e.ev === "MemberParked" && e.from === "MatB" && !eq(e.args[0], victim) && e.args[1] > 0n);
    expect(brake,
      "⛔ THE FUNDING BRAKE IS GONE. On 2026-08-29 the MatB root cycled out mid-cascade and FUNDING-PARKED " +
      "(shortfall > 0), which is the ONLY reason it never crossed back into MatA to take the newcomer's seat. " +
      "That park is no longer happening. C5 shows what runs instead: THE SEAT THEFT. If a funding fix landed " +
      "without a seating fix, THIS IS THE REGRESSION 49.2 WARNED ABOUT — stop and read C5."
    ).to.not.equal(undefined);
    console.log(`      [brake ] MatB root ${String(brake.args[0]).slice(0, 10)} funding-parked ${usd(brake.args[1])} short — this is what saved the newcomer's seat`);
  });

  it("C3 (control): the SAME saturated fixture with ONE free MatB seat — the identical rescue must SEAT the member", async function () {
    // ⛔ WHY THIS CONTROL IS BUILT THIS WAY, 2026-08-29.
    //
    // The first draft gave MatB four times the size of MatA so it would not
    // saturate. IT SATURATED ANYWAY — measured: MatA 4/4 rot 18, MatB 16/16 rot 2 —
    // and the premise assertion failed rather than passing vacuously, which is the
    // harness behaving correctly. The reason is structural and worth carrying:
    // A MEMBER CANNOT BE PARKED OUT OF MatB UNTIL MatB HAS FILLED AND ROTATED.
    // A park is a consequence of saturation, so "parked in MatB" and "MatB has
    // room" cannot be reached by registering more members. Sizing cannot separate
    // them; only freeing a seat after the fact can.
    //
    // So this control is now the SAME fixture as C1 — same sizes, same fill, same
    // rescue — with exactly ONE variable changed: one MatB seat is emptied first,
    // via the keeper's softParkIdle (no idle-time gate on it, MatrixLogicLib:1494).
    // One variable, one difference in outcome. That is what makes it a control.
    const ctx = await deployTier(4, 4);
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await fill(ctx);
    await state(ctx, "filled");

    expect(await ctx.matA.isFull(), "premise failed: MatA never saturated").to.equal(true);
    expect(await ctx.matB.isFull(), "premise failed: MatB never saturated — C3 starts from the SAME state as C1").to.equal(true);

    // The victim is a SEATED MatB member, not the naturally-parked one, so that
    // parking them is what creates the free seat. Position 2, not the root: the
    // root is about to cycle out anyway and would muddy the one variable.
    const victim = await ctx.matB.posToMember(2);
    expect(victim, "premise failed: MatB position 2 is empty").to.not.equal(ethers.ZeroAddress);
    await ctx.matB.connect(ctx.owner).softParkIdle(victim);
    await state(ctx, "1 free");

    expect(await ctx.matB.isFull(), "premise failed: softParkIdle did not free a MatB seat").to.equal(false);
    expect(await ctx.matA.isFull(), "premise failed: MatA must still be full — that is the constant between C1 and C3").to.equal(true);
    console.log(`      [victim] ${victim} — parked out of MatB, MatB now has ONE free seat`);

    const { t } = await selfRescueFromB(ctx, victim);
    printTrace(t, "control receipt");
    await state(ctx, "after ");

    const destPark = t.find(e => e.ev === "MemberParked" && e.from === "MatA" && eq(e.args[0], victim));
    const seated   = await ctx.matA.isActiveInMatrix(victim);

    expect(destPark,
      "THE CONTROL PARKED TOO. A rescued member is parked in MatA even though MatB had a free seat, " +
      "so PARTNER SATURATION IS NOT THE TRIGGER and 48.4 is looking at the wrong variable. " +
      "This is the more important result of the two — chase it before anything else."
    ).to.equal(undefined);
    expect(seated,
      "the victim was neither parked in MatA nor seated there. Neither branch fired; the harness did not reach the seating decision."
    ).to.equal(true);
  });

  it("C4 (THE OWNER'S QUESTION): an SF-funded coPayRescue into a fully saturated pair — does the SF book debt for a seat that does not exist?", async function () {
    // ⛔ THIS IS THE TEST THAT ANSWERS 48.4, NOT C1/C2.
    //
    // 48.4's stated fear, in the owner's terms: "The SF would lend the crossing fee
    // and book member debt for a seat that may not exist." C1 measured a SELF-funded
    // rescue. The keepers that are paused run the SF-funded path, so that is the path
    // the decision actually turns on, and it is the one measured here.
    //
    // TWO HARNESS KNOBS, BOTH DELIBERATE AND BOTH DECLARED:
    //   1. The SF is topped up directly (owner authorised as a matrix, then
    //      receiveDebtRepayment) because 25 registrations only route ~$6 of
    //      stabilityBps into it — not enough to clear `totalBalance >= sfShare + floor`.
    //   2. insolvencyFloorBps is set to 0. That floor is LENDING POLICY (V8.48 item 46);
    //      this test is about SEATING. Leaving it on would make the test fail for a
    //      reason it is not asking about. ⚠ It also means this test says NOTHING about
    //      whether the floor would have refused the loan live — do not read it that way.
    const ctx = await deployTier(4, 4);

    await ctx.sf.connect(ctx.owner).setInsolvencyFloorBps(0);
    await ctx.usdc.mint(ctx.owner.address, FEE * 100n);
    await ctx.sf.connect(ctx.owner).setMatrixAuthorized(ctx.owner.address, true);
    await ctx.usdc.connect(ctx.owner).approve(await ctx.sf.getAddress(), FEE * 100n);
    await ctx.sf.connect(ctx.owner).receiveDebtRepayment(FEE * 100n);

    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await fill(ctx);
    await state(ctx, "setup");

    expect(await ctx.matA.isFull(), "premise failed: MatA never saturated").to.equal(true);
    expect(await ctx.matB.isFull(), "premise failed: MatB never saturated").to.equal(true);
    expect(await ctx.matB.getParkedCount(), "premise failed: nobody parked in MatB to rescue").to.be.gt(0n);

    const victim = await ctx.matB.getParkedMember(0);
    const debtBefore = await ctx.sf.memberDebtOf(victim);
    console.log(`      [victim] ${victim} — parked in MatB, SF debt before ${usd(debtBefore)}`);

    // coPayRescue is UNGATED on the matrix (48.5: the 24h grace is keeper policy only,
    // MatrixLogicLib:1620-1626 has no grace requirement), so the keeper's exact call is
    // reproducible here with no impersonation.
    const rc = await (await ctx.matB.coPayRescue(victim, { gasLimit: 16_700_000 })).wait();
    const t = trace(ctx, rc);
    printTrace(t, "coPayRescue receipt");
    await state(ctx, "after ");

    const seated     = await ctx.matA.isActiveInMatrix(victim);
    const destPark   = t.find(e => e.ev === "MemberParked" && e.from === "MatA" && eq(e.args[0], victim));
    const debtAfter  = await ctx.sf.memberDebtOf(victim);
    console.log(`      [ledger] SF debt ${usd(debtBefore)} -> ${usd(debtAfter)}   seated in MatA: ${seated}`);

    // THE DECISION-RELEVANT ASSERTION. Debt booked AND no seat is the fear coming true.
    expect(debtAfter > debtBefore && !seated,
      "⛔ THE OWNER'S FEAR IS CONFIRMED: the SF booked " + usd(debtAfter - debtBefore) +
      " of debt against this member and they did NOT get a seat. KEEP THE KEEPERS PAUSED " +
      "and take the 48.9 item 1 routing decision before anything is unpaused."
    ).to.equal(false);

    // And the positive form, so this cannot pass by the member merely not being charged.
    expect(seated,
      "the rescued member is not seated in MatA. If no debt was booked either, the rescue " +
      "did not happen at all and this test measured nothing — check the SF top-up and the floor."
    ).to.equal(true);
  });

  it("C5 (THE RESURRECTION TEST): with a SOLVENT MatB root, does the cascade finally steal the newcomer's seat?", async function () {
    // ⛔ THIS IS THE ONE EXPERIMENT THAT CAN STILL BRING 48.4 BACK, AND IT IS THE TEST
    // OF 49.2's INVERSION.
    //
    // C1 killed the seat theft, but for a REASON, not by absence: B's cycled-out root
    // funding-parked $5.48 short instead of crossing back into MatA to take the freed
    // seat. If that shortage is the only thing standing between us and the theft, then
    // making the MatB root SOLVENT should produce it — and the funding fix and the
    // seating fix become ONE job instead of two.
    //
    // WHY THE SPLITS ARE RE-WEIGHTED AND WHY THAT IS NOT CHEATING:
    // a MatB member's LIFETIME pool income is bounded near poolBps x fee — they hold a
    // seat for (size-1) rotations and take pool/size each time — so pool can never fund
    // a FULL-FEE hop no matter how big or busy the matrix is. Referral income has no
    // such ceiling: it scales with downline. So the only lever that can make a MatB
    // member solvent is l1, and SOLVENT_SPLITS moves weight into it. THE TOTAL IS
    // UNCHANGED at 4750 — no money is added, it is redistributed. ⚠ These are NOT the
    // production weights and this test says NOTHING about live economics. It isolates
    // ONE question: given a solvent MatB root, what happens to the newcomer's seat?
    const ctx = await deployTier(4, 4, SOLVENT_SPLITS);
    await register(ctx, ctx.W1, ethers.ZeroAddress);
    await fill(ctx);
    await state(ctx, "setup");

    expect(await ctx.matA.isFull(), "premise failed: MatA never saturated").to.equal(true);
    expect(await ctx.matB.isFull(), "premise failed: MatB never saturated").to.equal(true);

    // Feed referrals to the member at MatB position 2, who becomes root next rotation.
    // Targeting the root itself is useless: the very next registration cycles them out.
    const funds = async a => (await ctx.matB.crossingReserveOf(a)) + (await ctx.matB.withdrawableOf(a));
    let root = await ctx.matB.posToMember(1);
    for (let i = 0; i < 15 && (await funds(root)) < FEE; i++) {
      const heir = await ctx.matB.posToMember(2);
      if (heir === ethers.ZeroAddress) break;
      await register(ctx, await newWallet(ctx), heir);
      root = await ctx.matB.posToMember(1);
      console.log(`      [fund  ] pass ${i + 1}: MatB root ${String(root).slice(0, 10)} holds ${usd(await funds(root))} against a ${usd(FEE)} hop`);
    }

    // PREMISE. Without a solvent root this test is just C1 again and measures nothing.
    const rootFunds = await funds(root);
    expect(rootFunds,
      "premise failed: could not make ANY MatB root solvent enough for the full-fee hop, even with " +
      "referral-weighted splits. If this trips, the funding constraint is structurally unreachable in " +
      "this fixture and 49.2's inversion CANNOT be tested here — say so rather than weakening the test."
    ).to.be.gte(FEE);
    console.log(`      [solvent] MatB root ${String(root).slice(0, 10)} holds ${usd(rootFunds)} — it CAN afford the hop back into MatA`);

    expect(await ctx.matA.isFull(), "premise failed: MatA no longer full after the funding passes").to.equal(true);
    expect(await ctx.matB.isFull(), "premise failed: MatB no longer full after the funding passes").to.equal(true);

    // Re-read the parked queue: the funding passes churned it.
    const parked = await ctx.matB.getParkedCount();
    expect(parked, "premise failed: nobody parked in MatB to rescue after the funding passes").to.be.gt(0n);
    let victim = ethers.ZeroAddress;
    for (let i = 0n; i < parked; i++) {
      const cand = await ctx.matB.getParkedMember(i);
      if (!eq(cand, root)) { victim = cand; break; }
    }
    expect(victim, "premise failed: the only parked member IS the solvent root").to.not.equal(ethers.ZeroAddress);
    console.log(`      [victim ] ${victim}`);

    const { t } = await selfRescueFromB(ctx, victim);
    printTrace(t, "solvent-root receipt");
    await state(ctx, "after ");

    const destPark = t.find(e => e.ev === "MemberParked" && e.from === "MatA" && eq(e.args[0], victim));
    const seated   = await ctx.matA.isActiveInMatrix(victim);
    const thief    = t.find(e => e.ev === "MemberEntered" && e.from === "MatA" && !eq(e.args[0], victim));
    console.log(`      [result ] seated=${seated}  destPark=${destPark ? usd(destPark.args[1]) : "none"}  ` +
                `otherMatAEntrant=${thief ? String(thief.args[0]).slice(0, 10) : "none"}`);

    // THE HYPOTHESIS, ASSERTED SO IT CAN FAIL. A green C5 RESURRECTS 48.4 (funding-gated);
    // a red C5 kills it a second time, from the opposite direction, and that is stronger.
    expect(destPark,
      "⛔ 48.4 IS KILLED TWICE OVER, AND THIS IS THE STRONGER KILL. Even with a SOLVENT MatB root — " +
      "the exact condition 49.2 said was the only thing preventing the theft — the rescued member was " +
      (seated ? "STILL SEATED" : "neither seated nor destination-parked") + ". So the funding shortage is NOT " +
      "what protects the seat, 49.2's inversion is WRONG, and the live no-seat parks (58 MatA + 10 MatB) " +
      "have a cause that is NOT in this cascade at all. Update 49.2 and 49.5 before anything else."
    ).to.not.equal(undefined);
    expect(destPark.args[1],
      "the destination park carried a non-zero shortfall — that is a FUNDING park, not the :529 no-seat park"
    ).to.equal(0n);
    expect(thief,
      "the victim IS parked in the destination with shortfall 0, but nobody else entered MatA in that " +
      "transaction — so the seat was not stolen by a refill. Real park, wrong mechanism, same as 48.4."
    ).to.not.equal(undefined);
  });
});
