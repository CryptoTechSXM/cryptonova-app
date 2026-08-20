"use strict";
/**
 * V8_50_MemberLedger.test.js — WHAT BOUNDS THE WITHDRAWABLE AT THE FORWARD HOP.
 *
 * WRITTEN 2026-08-20 (session 12). Written to answer the ONE open question left by
 * session 11, in the handoff's own words (V8_50_HANDOFF.md 11.5):
 *
 *   "Take ONE parked member at the hop and account for their withdrawable to the cent
 *    against every credit they ever received — pool, chain, direct, L1, carried balance —
 *    and find what the distribution is bounded by. Do not reason about it."
 *
 * THE ANOMALY THIS EXISTS FOR. Across 3,600+ hops at referral rates 0-4, not one member
 * has EVER crossed forward out of MatB. Members reach within EIGHT CENTS of the $10.00 fee
 * and stop. FORWARD is 0 everywhere, so this is not a sampling artefact — the distribution
 * of withdrawable-at-the-hop appears to be BOUNDED below the fee, and nothing measured so
 * far says what the bound is.
 *
 * ⛔ TWO CAUSES ARE ALREADY RULED OUT. DO NOT RE-CHASE THEM HERE OR ANYWHERE:
 *   ❌ Lazy pool settlement hiding earned-but-uncredited money from the affordability test.
 *      REFUTED: `_cycleOutRoot` calls `_settlePool(self, cfg, root)` at MatrixLogicLib:805,
 *      BEFORE the crossing logic. The departing root is settled first, every time.
 *   ❌ An earnings or payout cap. REFUTED: none exists; `_settlePool` computes an exact
 *      rational `(k*dA1 - dAr) / W` with no ceiling.
 *
 * ─── WHAT THIS FIXTURE MEASURES, AND WHY IT CAN ─────────────────────────────────────────
 * Every dollar that ever lands in a member's `withdrawable` is emitted. There is exactly
 * ONE credit path — `MatrixLogicLib._credit` (:1332) — and it emits
 * `EarningsCredited(member, payer, source, amount)` on the same line it does
 * `withdrawable += amount`. Five sources, from the library's own constants:
 *
 *      1 SRC_DIRECT_ENTRY   the 2.5% carve on the member's own entry
 *      2 SRC_L1_REFERRAL    paid to the entrant's referrer
 *      3 SRC_CHAIN_PAY      up to 6 levels above the entrant
 *      4 SRC_POOL_SHARE     settled rotation pool
 *      5 SRC_ORPHAN_ACCT1   orphaned fee routed to accountOne  (NOT a member credit)
 *
 * The only money that enters `withdrawable` WITHOUT going through `_credit` is the carried
 * balance (`creditCarriedBalance`, deliberately bypasses `_credit` — see MatrixLogicLib:302)
 * and a released crossing reserve. The carry emits `BalanceCarried`. The reserve release
 * emits NOTHING, so the reconciliation below cannot see it — which is why every path that
 * can release a reserve (`SlotReclaimed`, `SlotParkedIdle`) is counted and any subject that
 * had one is REFUSED as a subject rather than reported with a silently incomplete ledger.
 * (V8_50_HANDOFF 7a: an instrument must not report the absence of something it cannot
 * observe. Session 11's v2 broke exactly that rule and printed the result as a finding.)
 *
 * ─── THE IDENTITY UNDER TEST ────────────────────────────────────────────────────────────
 * At a MatB cycle-out the forward hop is priced by TierRouter._executeAdditive (:1351):
 *      have = escrow + withdrawable ;  shortfall = curFee - have
 * and escrow is 0 under V8.50 item A (no reserve is carved at a MatB crossing entry). So:
 *
 *      withdrawable_at_park  ==  FEE - shortfall
 *
 *      and, purely from events:
 *      carriedA->B  ==  creditsA - crossingFromEarningsA - debtRepaidA - withdrawnA
 *      withdrawable ==  creditsB + carriedA->B - crossingFromEarningsB - debtRepaidB - withdrawnB
 *
 * THREE INDEPENDENT READINGS OF THE SAME NUMBER: the contract's own shortfall event, the
 * on-chain `getMember().withdrawable` read at the instant of the park, and the sum of the
 * member's entire credit history. If they agree, the credit stream IS the bound and the
 * composition table says what it is made of. IF THEY DISAGREE, THE DIFFERENCE IS THE
 * FINDING — that is the whole point of running this, and the assertion at the bottom fails
 * loudly rather than printing a number nobody checked.
 *
 * ⚠ ONE SAMPLE IS NOT A MEASUREMENT — and neither is the first N. Shortfall DEGRADES with
 * system maturity (11.4: early cycle-outs were paid out of full-price entries, steady-state
 * ones out of half-price crossings), so the first N parked members are the richest N.
 * Session 11 walked into that with `median lifetime earnings` and had to withdraw the line.
 * Subjects here are spread EVENLY across the whole run by park order, and the composition
 * table is computed over ALL parked members, not a batch.
 *
 * ============================ HOW TO RUN =====================================
 *   cd C:\CryptoNite-Smart-Contracts\CryptoNova
 *
 *   STEP 1 — instrument check (size 7, ~1 minute). Proves the ledger reconciles.
 *            The COMPOSITION numbers from this run describe nobody. Ignore them.
 *     npx hardhat test test/V8_50_MemberLedger.test.js
 *
 *   STEP 2 — the real number, live matrix size:
 *     $env:CYCLE_SIZE=127; npx hardhat test test/V8_50_MemberLedger.test.js
 *     Remove-Item Env:\CYCLE_SIZE
 * =============================================================================
 *
 * SIZE IS NOT COSMETIC. Pool share (1568 bps) is split across seats 2..N, so a size-7 run
 * hands each member ~18x the per-rotation pool share of a size-127 run. The RECONCILIATION
 * is size-independent (it is an accounting identity); the COMPOSITION is not. Size 127 or
 * it is not an answer about the live chain.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SIZE        = Number(process.env.CYCLE_SIZE || process.env.GAS_MATRIX_SIZE || 7);
const FEE         = 10_000_000n;                                 // $10.00, T1 live entry fee
const BUDGET_MULT = Number(process.env.CYCLE_BUDGET || 6);       // registrations = MULT * SIZE
const PROGRESS    = Number(process.env.CYCLE_PROGRESS || 25);
const SUBJECTS    = Number(process.env.LEDGER_SUBJECTS || 6);    // full ledgers to print

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

const SRC = { 1: "direct entry", 2: "L1 referral", 3: "chain pay", 4: "pool share", 5: "orphan->acct1" };

const usd  = (v) => "$" + (Number(v) / 1e6).toFixed(4);
const bps  = (v) => ((Number(v) * 10000) / Number(FEE)).toFixed(0) + " bps";
const pct  = (v, of) => ((Number(v) * 100) / Number(of || 1n)).toFixed(2) + "%";
const sum  = (arr) => arr.reduce((a, b) => a + b, 0n);
const median = (arr) => {
  if (!arr.length) return 0n;
  const s = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};
const maxOf = (arr) => (arr.length ? arr.reduce((a, b) => (b > a ? b : a)) : 0n);
const minOf = (arr) => (arr.length ? arr.reduce((a, b) => (b < a ? b : a)) : 0n);

/* Identical deployment to V8_50_CycleEconomics.test.js — deliberately ONE pair, so the
 * MatB hop is priced as a new cycle by this matrix's own immutable isMatrixA and no pair
 * expansion perturbs the run. Do not "improve" this into two pairs without re-reading the
 * note in that file: the discriminator is local, not the destination. */
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

  return { usdc, cnova, treasury, pm, pmAddr, tr, a, b, sf, owner, W1, devOps, sigs, matrixLib,
           aAddr: await a.getAddress(), bAddr: await b.getAddress(),
           trAddr: (await tr.getAddress()).toLowerCase(),
           treasuryAddr: await treasury.getAddress(), sfAddr: await sf.getAddress() };
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

/** NO referrer for anyone. Every member is an orphan, so L1 (950 bps) routes to accountOne
 *  and none of it reaches the entrant. That is the case the owner's framing is about and
 *  the case worth pricing. */
async function reg(ctx, wallet) {
  await ctx.usdc.mint(wallet.address, FEE);
  await ctx.usdc.connect(wallet).approve(ctx.pmAddr, FEE);
  const rc = await (await ctx.tr.connect(wallet)
    .register(ethers.ZeroAddress, { gasLimit: 16_000_000 })).wait();
  return parseAll(ctx, rc.logs);
}

/** ARTIFACT-DERIVED interfaces only. The money events are declared in MatrixLogicLib and
 *  emitted THROUGH the matrix by delegatecall, so the log carries the matrix address and
 *  needs the LIBRARY abi. Never hand-write a signature here. */
function parseAll(ctx, logs) {
  const out = [];
  for (const lg of logs) {
    for (const iface of [ctx.matrixLib.interface, ctx.a.interface, ctx.pm.interface, ctx.tr.interface]) {
      let d = null;
      try { d = iface.parseLog(lg); } catch { d = null; }
      if (d) { out.push({ name: d.name, args: d.args, address: lg.address.toLowerCase() }); break; }
    }
  }
  return out;
}

/* A per-member ledger. Every field is populated from an EVENT, never from a view call,
 * so the reconciliation is independent of contract state at read time. */
function blankLeg() {
  return {
    credits: { 1: 0n, 2: 0n, 3: 0n, 4: 0n, 5: 0n },
    counts:  { 1: 0,  2: 0,  3: 0,  4: 0,  5: 0  },
    crossFromEarnings: 0n, crossFromReserve: 0n, debtRepaid: 0n, withdrawn: 0n,
    carriedOut: 0n, carriedIn: 0n,
    reserveReleaseEvents: 0,     // SlotReclaimed / SlotParkedIdle — UNOBSERVABLE amounts
  };
}
function ledgerFor(map, addr) {
  const k = addr.toLowerCase();
  if (!map.has(k)) map.set(k, { A: blankLeg(), B: blankLeg() });
  return map.get(k);
}

/* A frozen copy of a member's ledger AT AN INSTANT.
 *
 * ⚠ WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL. The park happens PART-WAY THROUGH a
 * registration transaction: one entry rotates a root out of MatA, that root crosses, the
 * crossing rotates a root out of MatB, and that member parks — and the cascade then
 * CARRIES ON crediting people, the parked member included (chain pay from the entry that
 * is still being processed). So the member's balance at the END of the transaction is not
 * the balance the affordability gate read. Comparing the gate's shortfall against an
 * end-of-transaction reading would manufacture a disagreement and report it as a finding.
 * Both instants are captured and both are reconciled, separately. */
function snapLeg(l) {
  return {
    credits: { ...l.credits }, counts: { ...l.counts },
    crossFromEarnings: l.crossFromEarnings, crossFromReserve: l.crossFromReserve,
    debtRepaid: l.debtRepaid, withdrawn: l.withdrawn,
    carriedOut: l.carriedOut, carriedIn: l.carriedIn,
    reserveReleaseEvents: l.reserveReleaseEvents,
  };
}
const snapBoth = (L) => (L ? { A: snapLeg(L.A), B: snapLeg(L.B) } : { A: blankLeg(), B: blankLeg() });
const creditsOf  = (leg) => sum([1, 2, 3, 4, 5].map(s => leg.credits[s]));
const predCarry  = (sn) => creditsOf(sn.A) - sn.A.crossFromEarnings - sn.A.debtRepaid - sn.A.withdrawn;
const predWith   = (sn) => creditsOf(sn.B) + sn.B.carriedIn - sn.B.crossFromEarnings - sn.B.debtRepaid - sn.B.withdrawn;

describe("V8.50 — THE BOUNDED DISTRIBUTION: account one parked member to the cent", function () {
  this.timeout(7_200_000);

  it(`reconciles withdrawable-at-the-hop against every credit ever received, MATRIX_SIZE=${SIZE}`, async function () {
    const ctx    = await deployPair(SIZE);
    const budget = BUDGET_MULT * SIZE;
    const A = ctx.aAddr.toLowerCase(), B = ctx.bAddr.toLowerCase();
    const ACCT1 = ctx.W1.address.toLowerCase();

    console.log("");
    console.log("=".repeat(100));
    console.log(`  MEMBER LEDGER — MATRIX_SIZE ${SIZE}, entry fee ${usd(FEE)}, NO referral income for anyone`);
    console.log(`  registration budget ${budget}  (CYCLE_BUDGET=${BUDGET_MULT} x SIZE)`);
    console.log(`  QUESTION: what bounds withdrawable at the MatB forward hop, below ${usd(FEE)}?`);
    console.log("=".repeat(100));

    const wallets = await freshWallets(budget);

    const legs   = new Map();     // address -> { A: leg, B: leg }
    const parked = [];            // every affordability park at the B hop, in order
    const flow   = { crossedAB: 0, gradBviaCross: 0, parkShortB: 0, parkZeroB: 0, cycleOutA: 0, cycleOutB: 0 };
    const routerFlow = { reentered: 0, upgraded: 0, doubled: 0, routerParked: 0 };
    const entriesToA = new Map(); // address -> how many times they have entered MatA
    const orphan = {};            // orphaned-fee routing, keyed by the contract's own source string
    let   sfFromSplits = 0n;      // StabilityContribution — the split, not the orphan share
    let   firstCrossA = null;

    for (let i = 0; i < budget; i++) {
      const evs = await reg(ctx, wallets[i]);
      const parkedThisTx = [];

      for (const e of evs) {
        /* ⛔⛔ THE EVENT THAT WAS NEVER BEING COUNTED — READ THIS BEFORE TRUSTING ANY
         * "FORWARD = 0" NUMBER, INCLUDING SESSION 11's.
         *
         * A member who CAN afford the forward hop does NOT emit MemberCrossedToPartner.
         * _cycleOutRoot (:834) sends every MatB cycle-out to TierRouter.handleCycleOut
         * whenever a tierRouter is wired — which it always is, in this fixture and on
         * live. _crossToPartner, the ONLY emitter of MemberCrossedToPartner, is the ELSE
         * branch and is unreachable for a MatB root. TierRouter._executeAdditive (:1351)
         * instead calls _takeSeat -> PairManager.registerFor -> _enterMatrix, which emits
         * MemberEntered at the DESTINATION and MemberReentered at the router.
         *
         * SO SUCCESS AT THIS HOP IS SILENT ON THE EVENT THE CENSUS WATCHES, AND ONLY
         * FAILURE IS LOUD. A fixture counting MemberCrossedToPartner at MatB is counting
         * an event that path cannot emit, and will report 0 forever no matter what the
         * members can afford. That is the handoff's own trap — an instrument must not
         * report the absence of something it cannot observe — with a new face on it.
         *
         * Counted below three independent ways so no single event has to be trusted:
         *   MemberCycledOut@B   every hop ATTEMPT     (denominator)
         *   MemberParked@B      the failures          (already counted)
         *   MemberReentered@TR  the successes         (this block) */
        if (e.address === ctx.trAddr) {
          if (e.name === "MemberReentered")  routerFlow.reentered++;
          if (e.name === "MemberUpgraded")   routerFlow.upgraded++;
          if (e.name === "DoubleEntryFired") routerFlow.doubled++;
          if (e.name === "MemberParked")     routerFlow.routerParked++;
          continue;
        }
        const at = e.address === A ? "A" : e.address === B ? "B" : null;
        if (!at) continue;                       // PairManager events: not ledger
        const half = (addr) => ledgerFor(legs, addr)[at];

        switch (e.name) {
          case "EarningsCredited": {
            const l = half(e.args[0]);
            const s = Number(e.args[2]);
            l.credits[s] += BigInt(e.args[3]);
            l.counts[s]  += 1;
            break;
          }
          case "CrossingFunded": {
            const l = half(e.args[0]);
            l.crossFromReserve  += BigInt(e.args[1]);
            l.crossFromEarnings += BigInt(e.args[2]);
            if (at === "A" && !firstCrossA) {
              firstCrossA = { reserve: BigInt(e.args[1]), earnings: BigInt(e.args[2]), cost: BigInt(e.args[3]) };
            }
            break;
          }
          case "RescueDebtRepaid":  half(e.args[0]).debtRepaid += BigInt(e.args[1]); break;
          case "EarningsWithdrawn": half(e.args[0]).withdrawn  += BigInt(e.args[1]); break;
          case "BalanceCarried": {
            // emitted at the SOURCE matrix, args = (member, from, to, amount)
            const amt = BigInt(e.args[3]);
            const dst = String(e.args[2]).toLowerCase();
            half(e.args[0]).carriedOut += amt;
            const dstHalf = dst === A ? "A" : dst === B ? "B" : null;
            if (dstHalf) ledgerFor(legs, e.args[0])[dstHalf].carriedIn += amt;
            break;
          }
          // A released crossing reserve is NOT emitted with an amount. Count the events
          // that can cause one so a subject with an invisible movement is refused, not
          // reported with a hole in its ledger.
          case "SlotReclaimed":
          case "SlotParkedIdle":  half(e.args[0]).reserveReleaseEvents += 1; break;

          /* ⛔ WHERE AN ORPHANED L1 ACTUALLY GOES. Session 11's closed-form table says
           * "L1 referral 1900 bps -> the referrer, or accountOne if orphaned". The
           * accountOne half of that is WRONG and this is what proves it, from the
           * contract's own event. _routeOrphanFee (MatrixLogicLib:1250) splits it:
           *      20%           -> accountOne  (ledger credit)
           *      80% x poolBps -> the COMMUNITY WALLET, or the STABILITY FUND if unset
           *                       (NOT the members' rotation pool, despite the helper
           *                        being named _forwardToCommunityPool)
           *      80% x fdrBps  -> the DEV WALLET, transferred straight out
           * and the two ratios ADAPT (:1305) from 4000/4000 toward 6000/2000 or
           * 2000/6000 to keep the running split near even. The CONCLUSION survives —
           * none of it returns to the member side — but the destinations do not, and
           * lever C in the owner's decision reads very differently because of it. */
          case "OrphanFeeRouted": {
            const src = String(e.args[4]);
            if (!orphan[src]) orphan[src] = { amount: 0n, acct1: 0n, pool: 0n, founder: 0n, n: 0 };
            orphan[src].amount  += BigInt(e.args[0]);
            orphan[src].acct1   += BigInt(e.args[1]);
            orphan[src].pool    += BigInt(e.args[2]);
            orphan[src].founder += BigInt(e.args[3]);
            orphan[src].n       += 1;
            break;
          }
          case "StabilityContribution": sfFromSplits += BigInt(e.args[1]); break;

          case "MemberCrossedToPartner":
            if (at === "A") flow.crossedAB++; else flow.gradBviaCross++;
            break;

          // The denominator: every attempt at the forward hop, however it ended.
          case "MemberCycledOut": if (at === "B") flow.cycleOutB++; else flow.cycleOutA++; break;

          // A member entering MatA for the SECOND time has been round the loop and paid
          // the full fee to do it. Counted per member so "how many cycles" is a fact.
          case "MemberEntered":
            if (at === "A") {
              const kk = String(e.args[0]).toLowerCase();
              entriesToA.set(kk, (entriesToA.get(kk) || 0) + 1);
            }
            break;

          case "MemberParked": {
            if (at !== "B") break;
            const shortfall = BigInt(e.args[1]);
            if (shortfall > 0n) {
              flow.parkShortB++;
              // Freeze the ledger HERE — this is the instant the gate read the balance.
              parkedThisTx.push({
                addr: String(e.args[0]), shortfall,
                atPark: snapBoth(legs.get(String(e.args[0]).toLowerCase())),
              });
            } else { flow.parkZeroB++; }                // seat guard / deferral — NOT affordability
            break;
          }
        }
      }

      // Read the chain at the INSTANT of the park — a third, independent reading of the
      // same number, taken before any later registration can move it.
      for (const p of parkedThisTx) {
        const mB = await ctx.b.getMember(p.addr);
        const mA = await ctx.a.getMember(p.addr);
        parked.push({
          ...p,
          regIndex: i + 1,
          endOfTx:            snapBoth(legs.get(p.addr.toLowerCase())),
          chainWithdrawableB: BigInt(mB.withdrawable),
          chainPendingPoolB:  BigInt(await ctx.b.pendingPoolOf(p.addr)),
          chainReserveB:      BigInt(mB.crossingReserve),
          chainEarnedA:       BigInt(mA.totalEarned),
          chainEarnedB:       BigInt(mB.totalEarned),
        });
      }

      if (PROGRESS > 0 && (i + 1) % PROGRESS === 0) {
        const [aOcc, aRot] = [await ctx.a.occupancy(), await ctx.a.rotationCount()];
        const [bOcc, bRot] = [await ctx.b.occupancy(), await ctx.b.rotationCount()];
        console.log(`  reg ${String(i + 1).padStart(4)}  MatA ${String(aOcc).padStart(3)}/${SIZE} rot ${String(aRot).padStart(4)}  |  ` +
          `MatB ${String(bOcc).padStart(3)}/${SIZE} rot ${String(bRot).padStart(4)}  |  ` +
          `A->B ${flow.crossedAB}  B hops ${flow.cycleOutB}  B RE-ENTERED ${routerFlow.reentered}  ` +
          `B parked-short ${flow.parkShortB}  B parked-zero ${flow.parkZeroB}`);
      }
    }

    /* ── REFUSE RATHER THAN REPORT AN ABSENCE WE CANNOT OBSERVE ─────────────────────── */
    expect(flow.cycleOutB,
      `NO CYCLE-OUT AT THE MatB HOP WAS OBSERVED AT ALL in ${budget} registrations ` +
      `(A->B crossings seen: ${flow.crossedAB}). This is NOT a result of zero — the run ` +
      `never reached the hop. Raise CYCLE_BUDGET and re-run.`
    ).to.be.greaterThan(0);
    expect(parked.length,
      `The B hop was reached but NO member parked with a shortfall > 0, so there is nothing ` +
      `to reconcile. If RE-ENTERED is non-zero that is itself the finding — read it, do not ` +
      `patch this fixture.`
    ).to.be.greaterThan(0);

    /* ── SUBJECTS: spread EVENLY across the run, never the first N ──────────────────── */
    const k = Math.min(SUBJECTS, parked.length);
    const picks = [];
    for (let j = 0; j < k; j++) picks.push(parked[Math.floor(((j + 0.5) * parked.length) / k)]);

    console.log("");
    console.log("=".repeat(100));
    console.log(`  PER-MEMBER LEDGERS — ${k} subjects spread evenly across ${parked.length} parked members`);
    console.log(`  (evenly, NOT the first ${k}: shortfall degrades with system maturity, so the`);
    console.log(`   earliest parked members are the richest and describe nobody in steady state)`);
    console.log("=".repeat(100));

    let worstDelta = 0n;
    const recon = [];

    for (const p of picks) {
      const sn = p.atPark, en = p.endOfTx;
      const line = (label, v, extra = "") =>
        console.log(`      ${label.padEnd(40, ".")} ${usd(v).padStart(11)}  ${extra}`);

      const creditsA = creditsOf(sn.A), creditsB = creditsOf(sn.B);
      const carryPred     = predCarry(sn);
      const withPredPark  = predWith(sn);
      const withPredEndTx = predWith(en);
      const fromShortfall = FEE - p.shortfall;
      const lateCredits   = creditsOf(en.B) - creditsOf(sn.B);

      const dCarry = carryPred - sn.A.carriedOut;                    // A ledger closes cleanly
      const dGate  = withPredPark - fromShortfall;                   // gate read == credit stream
      const dChain = withPredEndTx - p.chainWithdrawableB;           // end-of-tx == credit stream
      const worst  = [dCarry, dGate, dChain].map(x => (x < 0n ? -x : x)).reduce((a, b) => (b > a ? b : a));
      if (worst > worstDelta) worstDelta = worst;
      recon.push({ addr: p.addr, dCarry, dGate, dChain });

      console.log("");
      console.log(`  ── ${p.addr}`);
      console.log(`     parked at registration ${p.regIndex} of ${budget}  ` +
                  `(park #${parked.indexOf(p) + 1} of ${parked.length})   shortfall ${usd(p.shortfall)}`);
      if (sn.A.reserveReleaseEvents + sn.B.reserveReleaseEvents > 0) {
        console.log(`     ⚠ NOT A CLEAN SUBJECT: ${sn.A.reserveReleaseEvents + sn.B.reserveReleaseEvents} ` +
                    `idle-reclaim/soft-park event(s). A reserve release emits NO amount, so this`);
        console.log(`       ledger has a hole and any delta below may be that hole, not a finding.`);
      }

      console.log(`     MatA — every credit received in the first half:`);
      for (const s of [1, 2, 3, 4, 5])
        if (sn.A.counts[s]) line(`  ${SRC[s]} x${sn.A.counts[s]}`, sn.A.credits[s], bps(sn.A.credits[s]));
      line("  MatA credits total", creditsA, bps(creditsA));
      line("  less A->B crossing paid from earnings", sn.A.crossFromEarnings,
           `(the reserve paid ${usd(sn.A.crossFromReserve)} of it)`);
      if (sn.A.debtRepaid) line("  less SF debt repaid in A", sn.A.debtRepaid);
      if (sn.A.withdrawn)  line("  less withdrawn to wallet in A", sn.A.withdrawn);
      line("  = predicted carry into MatB", carryPred);
      line("  BalanceCarried event says", sn.A.carriedOut, dCarry === 0n ? "MATCH" : `⛔ DELTA ${usd(dCarry)}`);

      console.log(`     MatB — every credit received in the second half, up to the park:`);
      line("  carried in from MatA", sn.B.carriedIn);
      for (const s of [1, 2, 3, 4, 5])
        if (sn.B.counts[s]) line(`  ${SRC[s]} x${sn.B.counts[s]}`, sn.B.credits[s], bps(sn.B.credits[s]));
      line("  MatB credits total", creditsB, bps(creditsB));
      if (sn.B.debtRepaid) line("  less SF debt repaid in B", sn.B.debtRepaid);
      if (sn.B.withdrawn)  line("  less withdrawn to wallet in B", sn.B.withdrawn);

      console.log(`     THE GATE'S OWN NUMBER, TWO WAYS:`);
      line("  A. credit stream at the instant of the park", withPredPark);
      line("  B. FEE - MemberParked.shortfall", fromShortfall, dGate === 0n ? "MATCH" : `⛔ DELTA ${usd(dGate)}`);
      console.log(`     AFTER THE PARK, SAME CASCADE (not what the gate saw):`);
      line("  credited to them later in the same tx", lateCredits);
      line("  credit stream at end of transaction", withPredEndTx);
      line("  getMember().withdrawable, read after the tx", p.chainWithdrawableB,
           dChain === 0n ? "MATCH" : `⛔ DELTA ${usd(dChain)}`);
      line("  un-settled pool still owed to them", p.chainPendingPoolB,
           p.chainPendingPoolB === 0n ? "(settled before the gate — MatrixLogicLib:805)" : "⚠ NON-ZERO");
      line("  crossingReserve held at the park", p.chainReserveB,
           p.chainReserveB === 0n ? "(item A: no reserve is carved at a MatB crossing entry)" : "⚠ NON-ZERO");
      console.log("");
      line("  LIFETIME CREDITED, BOTH HALVES", creditsA + creditsB, bps(creditsA + creditsB));
      line("  NEEDED FOR THE FORWARD HOP", FEE, "10000 bps");
      line("  SHORT BY", p.shortfall, bps(p.shortfall));
    }

    /* ── COMPOSITION OVER THE WHOLE PARKED POPULATION, NOT A BATCH ──────────────────── */
    console.log("");
    console.log("=".repeat(100));
    console.log(`  WHAT THE MONEY IS MADE OF — ALL ${parked.length} PARKED MEMBERS, NOT A SAMPLE`);
    console.log("=".repeat(100));
    const bySrc = {};
    for (const s of [1, 2, 3, 4]) bySrc[s] = [];
    const totals = [], holdings = [];
    for (const p of parked) {
      const sn = p.atPark;                       // AT THE PARK, not end-of-transaction
      for (const s of [1, 2, 3, 4]) bySrc[s].push(sn.A.credits[s] + sn.B.credits[s]);
      totals.push(sum([1, 2, 3, 4].map(s => sn.A.credits[s] + sn.B.credits[s])));
      holdings.push(FEE - p.shortfall);          // the gate's own number, exact
    }
    console.log(`  source                    median          min          max     median as bps of the fee`);
    for (const s of [1, 2, 3, 4]) {
      console.log(`  ${SRC[s].padEnd(22)} ${usd(median(bySrc[s])).padStart(11)}  ${usd(minOf(bySrc[s])).padStart(11)}  ` +
                  `${usd(maxOf(bySrc[s])).padStart(11)}   ${bps(median(bySrc[s]))}`);
    }
    console.log(`  ${"─".repeat(78)}`);
    console.log(`  ${"LIFETIME CREDITED".padEnd(22)} ${usd(median(totals)).padStart(11)}  ${usd(minOf(totals)).padStart(11)}  ` +
                `${usd(maxOf(totals)).padStart(11)}   ${bps(median(totals))}`);
    console.log(`  ${"HELD AT THE HOP".padEnd(22)} ${usd(median(holdings)).padStart(11)}  ${usd(minOf(holdings)).padStart(11)}  ` +
                `${usd(maxOf(holdings)).padStart(11)}   ${bps(median(holdings))}`);
    console.log("");
    console.log(`  ⛔ THE CEILING, MEASURED: the RICHEST of all ${parked.length} members ever to reach this hop`);
    console.log(`     held ${usd(maxOf(holdings))} against the ${usd(FEE)} they needed — short by ${usd(FEE - maxOf(holdings))}.`);
    console.log(`     L1 referral is ${usd(median(bySrc[2]))} for every one of them: nobody recruited, so all`);
    console.log(`     ${SPLITS.l1Bps * 2} bps of L1 per cycle left the member side entirely.`);

    /* ── WHERE EVERY DOLLAR WENT — the conservation check, measured not derived ──────── */
    console.log("");
    console.log("=".repeat(100));
    console.log(`  WHERE EVERY DOLLAR OF ${budget} x ${usd(FEE)} = ${usd(BigInt(budget) * FEE)} ACTUALLY WENT`);
    console.log("=".repeat(100));
    let memberCredited = 0n, acct1Credited = 0n;
    for (const [addr, L] of legs.entries()) {
      const t = sum([1, 2, 3, 4, 5].map(s => L.A.credits[s] + L.B.credits[s]));
      if (addr === ACCT1) acct1Credited += t; else memberCredited += t;
    }
    const bal = async (addr) => BigInt(await ctx.usdc.balanceOf(addr));
    const [bA, bB, bT, bSF, bDev, bPM, bTR] = await Promise.all([
      bal(ctx.aAddr), bal(ctx.bAddr), bal(ctx.treasuryAddr), bal(ctx.sfAddr),
      bal(ctx.devOps.address), bal(ctx.pmAddr), bal(await ctx.tr.getAddress()),
    ]);
    const gross = BigInt(budget) * FEE;
    const row = (label, v) => console.log(`  ${label.padEnd(52, ".")} ${usd(v).padStart(12)}   ${pct(v, gross)}`);

    /* ⚠ TWO LEVELS, DELIBERATELY. A ledger credit is NOT a separate pile of money from
     * the USDC sitting in the matrix — the matrix HOLDS the USDC that backs every
     * member's withdrawable. Listing both in one flat column double-counts, and a flat
     * column that sums past 100% is exactly the kind of table that gets quoted later by
     * someone who did not write it. Level 1 is money that has LEFT the pair. Level 2 is
     * what the money still inside it is owed to. */
    console.log(`  LEVEL 1 — USDC THAT HAS LEFT THE PAIR ENTIRELY (members can never reach it):`);
    row("Treasury contract", bT);
    row("Stability Fund", bSF);
    row("dev/ops wallet", bDev);
    if (bPM) row("PairManager", bPM);
    if (bTR) row("TierRouter", bTR);
    const gone = bT + bSF + bDev + bPM + bTR;
    row("TOTAL GONE", gone);
    console.log("");
    console.log(`  LEVEL 2 — USDC STILL INSIDE THE PAIR (${usd(bA + bB)}), AND WHO IT IS OWED TO:`);
    const reservesAndDust = bA + bB - memberCredited - acct1Credited;
    row("ledger credits owed to MEMBERS", memberCredited);
    row("ledger credits owed to accountOne", acct1Credited);
    row("un-spent crossing reserves + dust", reservesAndDust);
    console.log("");
    const closes = gone + bA + bB;
    console.log(`  CONSERVATION CHECK: ${usd(gone)} gone + ${usd(bA + bB)} still inside = ${usd(closes)} ` +
                `against ${usd(gross)} in.  ${closes === gross ? "EXACT." : `⛔ OFF BY ${usd(gross - closes)}`}`);
    console.log("");

    /* ── THE ORPHANED L1, FROM THE CONTRACT'S OWN ROUTING EVENT ─────────────────────── */
    const oAll = Object.values(orphan);
    if (oAll.length) {
      const oT = { amount: 0n, acct1: 0n, pool: 0n, founder: 0n, n: 0 };
      for (const o of oAll) { oT.amount += o.amount; oT.acct1 += o.acct1; oT.pool += o.pool; oT.founder += o.founder; oT.n += o.n; }
      console.log(`  ⛔ WHERE THE ORPHANED L1 ACTUALLY WENT — ${oT.n} routings, ${usd(oT.amount)} total`);
      console.log(`     (session 11's table says this all goes to accountOne. IT DOES NOT.)`);
      for (const [src, o] of Object.entries(orphan))
        console.log(`     source "${src}" x${o.n} .......... ${usd(o.amount)}`);
      row("  -> accountOne (20%, a ledger credit)", oT.acct1);
      row("  -> community wallet / Stability Fund", oT.pool);
      row("  -> dev wallet, transferred out", oT.founder);
      console.log(`     NONE of it returns to the member side either way, so session 11's`);
      console.log(`     CONCLUSION stands — but lever C reads differently: reallocating orphaned L1`);
      console.log(`     takes ${pct(oT.pool + oT.founder, oT.amount)} of it from the community wallet and the dev wallet,`);
      console.log(`     not ${pct(oT.amount, oT.amount)} of it from accountOne. THAT IS AN OWNER DECISION, NOT A TUNING KNOB.`);
      console.log("");
    }

    /* ── ⛔ THE CENSUS, WITH SUCCESS COUNTED ────────────────────────────────────────── */
    const multi = [...entriesToA.values()].filter(v => v > 1).length;
    const maxEntries = Math.max(0, ...entriesToA.values());
    const unaccounted = flow.cycleOutB - parked.length - flow.parkZeroB - routerFlow.reentered;
    console.log("=".repeat(100));
    console.log(`  ⛔ THE FORWARD HOP, COUNTED THREE WAYS — SUCCESS IS SILENT, ONLY FAILURE EMITS`);
    console.log("=".repeat(100));
    console.log(`  MatB cycle-outs (every attempt at the hop) ......... ${String(flow.cycleOutB).padStart(6)}`);
    console.log(`  of which PARKED, could not afford it .............. ${String(parked.length).padStart(6)}   ${pct(parked.length, flow.cycleOutB || 1)}`);
    console.log(`  of which PARKED, shortfall 0 (guard/deferral) ..... ${String(flow.parkZeroB).padStart(6)}   ${pct(flow.parkZeroB, flow.cycleOutB || 1)}`);
    console.log(`  of which RE-ENTERED — PAID THE FULL ${usd(FEE)} ....... ${String(routerFlow.reentered).padStart(6)}   ${pct(routerFlow.reentered, flow.cycleOutB || 1)}`);
    console.log(`  unaccounted for (must be 0) ....................... ${String(unaccounted).padStart(6)}`);
    console.log("");
    console.log(`  MemberCrossedToPartner emitted at MatB ............ ${String(flow.gradBviaCross).padStart(6)}   <- THE EVENT SESSION 11 COUNTED`);
    console.log(`  members who entered MatA more than once .......... ${String(multi).padStart(6)}   (max entries by one member: ${maxEntries})`);
    console.log(`  upgrades / double seats taken at the hop ......... ${String(routerFlow.upgraded).padStart(6)} / ${routerFlow.doubled}`);
    console.log("");
    if (routerFlow.reentered > 0 && flow.gradBviaCross === 0) {
      console.log(`  >> ⛔⛔ "FORWARD = 0" WAS AN ARTEFACT OF THE COUNTER, NOT A PROPERTY OF THE SYSTEM.`);
      console.log(`     ${routerFlow.reentered} members DID pay the full ${usd(FEE)} at this hop and took a seat, while`);
      console.log(`     MemberCrossedToPartner stayed at 0 the whole time — because a MatB cycle-out`);
      console.log(`     goes through TierRouter, and TierRouter does not emit it. The distribution is`);
      console.log(`     NOT bounded below ${usd(FEE)}. Members above the line were invisible, not absent.`);
      console.log(`     ⚠ EVERY "0 GRADUATIONS" NUMBER IN HANDOFF 11.4 AND 11.5 IS MEASURED ON THIS`);
      console.log(`     COUNTER AND MUST BE RESTATED. The SHORTFALL numbers are unaffected — they come`);
      console.log(`     off MemberParked, which fires correctly, and reconcile to the wei above.`);
    } else if (routerFlow.reentered === 0) {
      console.log(`  >> Re-entry count is 0 as well, so the hop genuinely never succeeds here and`);
      console.log(`     session 11's conclusion survives on a counter that can now observe success.`);
    }
    console.log("-".repeat(100));
    console.log(`  RECONCILIATION: largest disagreement between the three readings, across all ` +
                `${k} subjects: ${usd(worstDelta)}`);
    if (worstDelta === 0n) {
      console.log(`  >> THE CREDIT STREAM ACCOUNTS FOR THE WITHDRAWABLE EXACTLY, TO THE WEI.`);
      console.log(`     Nothing is being lost, capped, withheld or settled late. What bounds the`);
      console.log(`     distribution is the COMPOSITION TABLE above and nothing else: the member`);
      console.log(`     receives pool + chain + direct, and never the L1 or the system take.`);
    } else {
      console.log(`  >> ⛔ THE READINGS DISAGREE BY ${usd(worstDelta)}. THAT DISAGREEMENT IS THE FINDING.`);
      console.log(`     Do not explain it. The per-subject DELTA lines above say which of the three`);
      console.log(`     readings is the odd one out, and that names the code path to read next.`);
    }
    console.log("-".repeat(100));
    console.log("");

    /* The reconciliation IS the test. A silent mismatch would be worse than no fixture:
     * every number session 11 published rests on the credit stream being complete. */
    for (const r of recon) {
      expect(r.dCarry, `${r.addr}: BalanceCarried disagrees with the MatA credit stream by ` +
        `${usd(r.dCarry)} — money entered or left MatA outside _credit. READ THE PATH, do not ` +
        `adjust the fixture.`).to.equal(0n);
      expect(r.dGate, `${r.addr}: the affordability gate's own shortfall disagrees with the ` +
        `credit stream by ${usd(r.dGate)} — THE GATE IS NOT READING THE BALANCE THE MEMBER HOLDS. ` +
        `THIS IS THE ANSWER TO THE BOUNDED-DISTRIBUTION QUESTION. Find the path that moved it.`).to.equal(0n);
      expect(r.dChain, `${r.addr}: end-of-transaction withdrawable disagrees with the credit ` +
        `stream by ${usd(r.dChain)} — something credits or debits withdrawable without emitting. ` +
        `Find it before any number from this fixture is quoted.`).to.equal(0n);
    }
  });
});
