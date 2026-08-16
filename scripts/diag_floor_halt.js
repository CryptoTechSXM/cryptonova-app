// diag_floor_halt.js — V8.49 item 1b (written 2026-08-15).
//
// WHY THIS EXISTS
// ---------------
// checkUpkeep only tells you what is due RIGHT NOW (a parked member inside the
// grace window produces no work item, so `upkeepNeeded: false` says nothing
// about whether the halt path below is reachable). This script asks the
// question directly, off the clock.
//
// THE HALT PATH (V8.49 scope item 1b, finding (ii)):
//   MatrixKeeperLib._triageParked skips the insolvency-floor check when
//   sfShare == 0 (the "self-funded, costs the fund nothing" case, item 12).
//   MatrixKeeper._doParkedRescue then advances the crossing buffer ANYWAY —
//   a flat CROSSING_BUFFER_BPS (3_600) of the entry fee, computed outside every
//   branch on sfShare — so totalSfNeeded > 0 and payForceCross IS called.
//   StabilityFund.payForceCross requires loanEligible(member, tier).
//   "SF: insolvency floor" is NOT on the swallow-list at MatrixKeeper.sol:471-473,
//   so it hits revert(reason) and THE WHOLE performUpkeep BATCH REVERTS —
//   velocity, chain-links, evictions, CW epoch, all of it.
//
//   Trigger = a parked member who is BOTH
//     (a) self-funded  : crossingReserve + withdrawable >= ENTRY_FEE, and
//     (b) over the floor: memberDebt >= ENTRY_FEE * insolvencyFloorBps / 10000
//   ...and who is not already routed to eviction by the ghost / withdraw-ratio /
//   ladder tests that run before it.
//
// This mirrors _triageParked line for line. It does NOT send anything.
//
// Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_floor_halt.js
//
// Optional: TIERS=T1,T2 to narrow;  ADDRESSES_FILE overrides the address file.
//
// HOUSE RULE OBSERVED: every getter below was grepped out of
// MatrixKeeperLib.sol's IFigureEightKeeper interface before use, nothing is
// batched behind a shared catch, and a failed read prints "?" plus its reason —
// never a number.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));
const ONLY = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);

const MAT_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function isInMatrix(address) view returns (bool)",
  "function isActiveInMatrix(address) view returns (bool)",
  "function partner() view returns (address)",
  "function ENTRY_FEE() view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function getMemberTotalWithdrawn(address) view returns (uint256)",
];
const PM_ABI = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address matA, address matB)",
];
const MK_ABI = [
  "function rescueRatioBps() view returns (uint256)",
  "function parkedGracePeriod() view returns (uint256)",
  "function selfFundedGracePeriod() view returns (uint256)",
  "function sfRescueThresholds(uint256) view returns (uint256)",
  "function sfRescueBpsLadder(uint256) view returns (uint256)",
  "function sfRescueLadderPreset() view returns (uint8)",
  // V8.48 (live) exposes the retired CONSTANT; V8.49 replaces it with the governed
  // param of the same meaning. BOTH are declared so this script keeps working across
  // the deploy — readBufferBps() below tries the param first and reports which one it
  // read. It never falls back to a literal: a fabricated 3600 here would silently
  // mis-state every advance in the report.
  "function CROSSING_BUFFER_BPS() view returns (uint256)",
  "function crossingBufferBps() view returns (uint256)",
];
const SF_ABI = [
  "function memberDebt(address) view returns (uint256)",
  "function insolvencyFloorBps() view returns (uint256)",
  "function loanEligible(address,uint8) view returns (bool)",
  // V8.49 policy B. Absent on V8.48 — detection at startup decides which is used.
  "function loanEligibleFor(address,uint8,uint256) view returns (bool)",
  "function loanHeadroom(address,uint8) view returns (uint256)",
  "function totalBalance() view returns (uint256)",
  "function stabilityFloor() view returns (uint256)",
  "function balanceByTier(uint8) view returns (uint256)",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
const MAXU = (1n << 256n) - 1n;

// Mirror of MatrixKeeperLib._rescueBpsFor (line 317). Returns null for the
// "off the bottom of the ladder" sentinel (type(uint256).max in Solidity).
function rescueBpsFor(thresholds, ladder, effectiveContrib, entryFee) {
  if (thresholds.length === 0) return 10_000n;
  const wBps = (effectiveContrib * 10_000n) / entryFee;
  for (let i = 0; i < thresholds.length; i++) {
    if (wBps >= thresholds[i]) return ladder[i];
  }
  return null;
}

// Read a dynamic public array by probing indices until the getter reverts.
// Deliberately NOT reconstructed from the preset table in the source — this
// reads live chain state, so a hand-set ladder cannot silently mislead us.
// The crossing buffer is a CONSTANT on the live V8.48 keeper and a governed PARAM
// on V8.49. Read whichever this chain actually has, and say which. Returns
// { bps, source } or throws — there is no default, deliberately.
async function readBufferBps(mk) {
  try   { return { bps: await mk.crossingBufferBps(),   source: "crossingBufferBps() [V8.49 param]" }; }
  catch { /* not deployed yet — fall through to the V8.48 constant */ }
  return { bps: await mk.CROSSING_BUFFER_BPS(), source: "CROSSING_BUFFER_BPS() [V8.48 constant]" };
}

// Which insolvency policy does THIS chain implement? Same shape as readBufferBps:
// ask the chain, never assume, and report which answer was used.
//
// Probed with a zero-address / zero-advance call purely for existence. A chain
// with policy B answers; V8.48 has no such selector and reverts with empty data.
// An UNEXPECTED error is fatal rather than defaulted: silently modelling policy A
// against a policy-B chain is exactly the disagreement this detection exists to
// stop, and it would produce clean, plausible, wrong numbers.
async function detectPolicyB(sf) {
  try {
    await sf.loanEligibleFor(ethers.ZeroAddress, 0, 0);
    return true;
  } catch (e) {
    const msg = (e.shortMessage || e.message || "").toLowerCase();
    const missing = msg.includes("missing revert data") || msg.includes("could not decode")
                 || (e.code === "CALL_EXCEPTION" && !e.reason) || e.code === "BAD_DATA";
    if (missing) return false;
    throw new Error(
      `Cannot tell which insolvency policy this chain implements: ${e.shortMessage || e.message}\n` +
      `  Refusing to guess. A wrong guess here mis-classifies exactly the members this tool is for.`
    );
  }
}

async function readArray(c, fn) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    try { out.push(await c[fn](i)); } catch { break; }
  }
  return out;
}

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p  = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const mk = new ethers.Contract(A.matrixKeeper, MK_ABI, p);
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);

  const block = await p.getBlockNumber();
  const now   = (await p.getBlock(block)).timestamp;

  const rescueRatioBps  = await mk.rescueRatioBps();
  const grace           = await mk.parkedGracePeriod();
  const selfGrace       = await mk.selfFundedGracePeriod();
  const bufferRead      = await readBufferBps(mk);
  const bufferBps       = bufferRead.bps;
  const preset          = await mk.sfRescueLadderPreset();
  const thresholds      = await readArray(mk, "sfRescueThresholds");
  const ladder          = await readArray(mk, "sfRescueBpsLadder");
  const floorBps        = await sf.insolvencyFloorBps();
  const sfBal           = await sf.totalBalance();
  const POLICY_B        = await detectPolicyB(sf);

  // stabilityFloor decides whether SF EXHAUSTION is graceful or fatal.
  // MatrixKeeper._doParkedRescue trims the buffer so totalSfNeeded == sfAvail
  // when the fund is short (line 578-581) — which satisfies
  // `totalBalance >= fee + stabilityFloor` EXACTLY when stabilityFloor == 0,
  // and fails it for any non-zero floor. "SF: below floor" is NOT on the
  // swallow-list at MatrixKeeper.sol:471-473, so a failure reverts the batch.
  // deploy_v8.js never sets this, but governance can — so it is READ, not assumed.
  let stabFloor = null;
  try { stabFloor = await sf.stabilityFloor(); }
  catch (e) { console.log(`stabilityFloor ? (${e.shortMessage || e.message})`); }

  console.log(`block ${block}   keeper ${A.matrixKeeper}`);
  console.log(`SF ${A.stabilityFund}   totalBalance ${usd(sfBal)}   stabilityFloor ${stabFloor === null ? "?" : usd(stabFloor)}`);
  console.log(`insolvencyFloorBps ${floorBps}   crossing buffer ${bufferBps} bps  <- read from ${bufferRead.source}   rescueRatioBps ${rescueRatioBps}`);
  console.log(`INSOLVENCY POLICY MODELLED: ${POLICY_B
    ? "B  — floor tested on the ADVANCE via loanEligibleFor(m,tier,advance), applied to EVERY parked member [V8.49]"
    : "A  — floor skipped when sfShare == 0, else 2-arg loanEligible(m,tier) [V8.48]"}`);
  if (POLICY_B && bufferBps === 0n) {
    console.log(`Buffer is 0, so totalSfNeeded == 0 for a self-funded member and payForceCross is`);
    console.log(`never called for them — the V8.48 batch-halt path is DELETED, not merely unarmed.`);
    console.log(`("SF: insolvency floor" and "SF: below floor" are also on performUpkeep's`);
    console.log(` swallow-list as of V8.49, so a refusal skips one member, not the batch.)`);
  }
  console.log(`parkedGracePeriod ${grace}s   selfFundedGracePeriod ${selfGrace}s   ladder preset ${preset} (${thresholds.length} rungs)`);
  if (bufferBps > floorBps) {
    console.log(`\n*** BUFFER (${bufferBps} bps) EXCEEDS FLOOR (${floorBps} bps) — every forceCross advance`);
    console.log(`    starts above the floor by construction. See V8_49_SCOPE.md item 1b.`);
  }
  console.log("");

  const tiers = Object.entries(A.tiers).filter(([name]) => !ONLY.length || ONLY.includes(name));
  let parkedTotal = 0, halt = [], evictFloor = [], evictOther = [], rescue = [], selfFunded = [], unreadable = [];

  for (const [tierName, t] of tiers) {
    const tierIdx = Number(tierName.slice(1)) - 1;
    let pairs;
    try {
      const pm = new ethers.Contract(t.pm, PM_ABI, p);
      const n  = await pm.activePairCount();
      pairs = [];
      for (let i = 0n; i < n; i++) pairs.push(await pm.getPairAt(i));
    } catch (e) {
      console.log(`${tierName}: pair enumeration FAILED (${e.shortMessage || e.message}) — falling back to the address file's pair 1 only`);
      pairs = [[t.matA, t.matB]];
    }

    for (const [matA, matB] of pairs) {
      for (const addr of [matA, matB]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const mat = new ethers.Contract(addr, MAT_ABI, p);

        let pc, fee, partner;
        try { pc = await mat.getParkedCount(); }        catch (e) { console.log(`  ${addr} getParkedCount ? (${e.shortMessage || e.message})`); continue; }
        if (pc === 0n) continue;
        try { fee = await mat.ENTRY_FEE(); }            catch (e) { console.log(`  ${addr} ENTRY_FEE ? (${e.shortMessage || e.message})`); continue; }
        try { partner = await mat.partner(); }          catch { partner = ethers.ZeroAddress; }

        for (let i = 0n; i < pc; i++) {
          let m;
          try { m = await mat.getParkedMember(i); } catch (e) { unreadable.push(`${addr}[${i}] getParkedMember ? ${e.shortMessage || e.message}`); continue; }
          if (!m || m === ethers.ZeroAddress) continue;

          let ts, seatedHere, seatedPartner, withdrawn, withdrawable, reserve, debt;
          try {
            ts            = await mat.parkedAt(m);
            if (ts === 0n) continue;
            seatedHere    = await mat.isInMatrix(m);
            seatedPartner = partner !== ethers.ZeroAddress
              ? await new ethers.Contract(partner, MAT_ABI, p).isActiveInMatrix(m)
              : false;
            withdrawn     = await mat.getMemberTotalWithdrawn(m);
            withdrawable  = await mat.withdrawableOf(m);
            reserve       = await mat.crossingReserveOf(m);
            debt          = await sf.memberDebt(m);
            // Eligibility is NOT read here any more. Under policy B the question
            // depends on the ADVANCE, which is not known until the ladder has run
            // below. Reading it here is what forced the 2-arg form. See POLICY.
          } catch (e) {
            unreadable.push(`${tierName} ${addr} ${m} ? ${e.shortMessage || e.message}`);
            continue;
          }
          parkedTotal++;

          const age  = BigInt(now) - ts;
          const row  = { tierName, tierIdx, addr, m, age, fee, reserve, withdrawable, debt };

          // ---- _triageParked, in order -------------------------------------
          if (seatedHere || seatedPartner) { evictOther.push({ ...row, why: "GHOST (seated in the pair)" }); continue; }

          const totalEarned   = withdrawn + withdrawable;
          const withdrawRatio = totalEarned > 0n ? (withdrawn * 10_000n) / totalEarned : 0n;
          if (withdrawRatio > rescueRatioBps) { evictOther.push({ ...row, why: `withdrawRatio ${withdrawRatio} > ${rescueRatioBps}` }); continue; }

          const effective = reserve + withdrawable;
          const sfBps = rescueBpsFor(thresholds, ladder, effective, fee);
          if (sfBps === null) { evictOther.push({ ...row, why: "off the bottom of the rescue ladder" }); continue; }

          const maxShortfall = fee > effective ? fee - effective : 0n;
          let sfShare = (fee * sfBps) / 10_000n;
          if (sfShare > maxShortfall) sfShare = maxShortfall;

          const buffer  = (fee * bufferBps) / 10_000n;
          const advance = sfShare + buffer;
          row.sfShare = sfShare; row.buffer = buffer; row.advance = advance;

          // ---- THE FLOOR TEST — WHICH POLICY IS ON THIS CHAIN? ---------------
          // V8.48 (policy A): discovery skips the floor entirely when sfShare == 0
          //   ("self-funded, costs the fund nothing") and otherwise asks the 2-arg
          //   loanEligible(member, tier) — which is loanHeadroom > 0, i.e. "can
          //   they borrow ANYTHING". It answers identically for a $0.01 advance and
          //   a $6.00 one.
          // V8.49 (policy B): the floor is tested against the ADVANCE, at both SF
          //   entry points AND in _triageParked, via
          //   loanEligibleFor(member, tier, advance).
          //
          // This mirror asked the V8.48 question unconditionally. Once V8.49 was
          // deployed that made it disagree with the chain about exactly the members
          // the test is about. Detected at startup, never assumed, and the policy
          // actually modelled is printed in the header.
          let eligible;
          try {
            eligible = POLICY_B
              ? await sf.loanEligibleFor(m, tierIdx, advance)
              : await sf.loanEligible(m, tierIdx);
          } catch (e) {
            unreadable.push(`${tierName} ${addr} ${m} eligibility ? ${e.shortMessage || e.message}`);
            continue;
          }
          row.eligible = eligible;

          if (POLICY_B) {
            // One rule, first loan or not, self-funded or not. sfShare == 0 no
            // longer buys a pass — that coupling was policy A's.
            if (!eligible) { evictFloor.push({ ...row, why: "floored at discovery (policy B, on the advance) -> eviction valve" }); continue; }
            if (sfShare === 0n) { selfFunded.push(row); continue; }
            rescue.push(row);
            continue;
          }

          if (sfShare > 0n && !eligible) { evictFloor.push({ ...row, why: "floored at discovery -> eviction valve" }); continue; }

          // sfShare == 0 => discovery calls this member self-funded and SKIPS the
          // floor check. _doParkedRescue still advances the buffer, so the SF is
          // still asked, and it can still refuse.
          if (sfShare === 0n) {
            selfFunded.push(row);
            if (!eligible) halt.push({ ...row, why: "SELF-FUNDED + FLOORED -> payForceCross reverts -> BATCH HALT" });
            continue;
          }
          rescue.push(row);
        }
      }
    }
  }

  const line = r => `    ${r.tierName} ${r.m}  age ${(Number(r.age) / 3600).toFixed(1)}h  fee ${usd(r.fee)}  reserve ${usd(r.reserve)}  wdable ${usd(r.withdrawable)}  debt ${usd(r.debt)}` +
    (r.advance !== undefined ? `  advance ${usd(r.advance)} (sf ${usd(r.sfShare)} + buffer ${usd(r.buffer)})` : "") +
    (r.why ? `  <- ${r.why}` : "");

  console.log(`PARKED READ: ${parkedTotal}${unreadable.length ? `   (+${unreadable.length} unreadable — listed at the end)` : ""}\n`);

  console.log(`*** HALT RISK (self-funded AND over the floor): ${halt.length}`);
  halt.forEach(r => console.log(line(r)));
  if (halt.length === 0) console.log("    none right now — the batch-revert path is not armed at this block.");

  console.log(`\nSelf-funded (sfShare == 0, buffer still advanced + booked as debt): ${selfFunded.length}`);
  selfFunded.slice(0, 20).forEach(r => console.log(line(r)));

  console.log(`\nRouted to EVICTION by the insolvency floor: ${evictFloor.length}`);
  evictFloor.slice(0, 20).forEach(r => console.log(line(r)));

  console.log(`\nRouted to EVICTION for other reasons (ghost / ratio / ladder): ${evictOther.length}`);
  evictOther.slice(0, 20).forEach(r => console.log(line(r)));

  console.log(`\nWould be RESCUED with an SF loan: ${rescue.length}`);
  rescue.slice(0, 20).forEach(r => console.log(line(r)));

  // ── POLICY B PREVIEW ───────────────────────────────────────────────────────
  // B = the insolvency floor tested AFTER the advance:
  //     memberDebt + totalAdvance <= fee * insolvencyFloorBps / 10_000
  //
  // ⚠ THIS MODELS DISCOVERY ONLY. It mirrors _triageParked, not
  // MatrixKeeper._doParkedRescue and not StabilityFund.payForceCross. A clock or a
  // gate in this system is TWO gates and this script can only see one of them —
  // exactly the half-view that produced item 1's false premise. Treat every number
  // below as "what discovery would decide", never as "what happens".
  const pendingB = [...rescue, ...selfFunded];
  const floorOf  = r => (r.fee * floorBps) / 10_000n;

  // ── WHEN POLICY B IS ALREADY ON CHAIN, THIS STOPS BEING A PREVIEW ─────────
  // It becomes a RECONCILIATION, which is more useful: the arithmetic below
  // (debt + advance > fee * floorBps / 10_000) is this script's MODEL of the
  // rule; loanEligibleFor() is the CHAIN'S implementation of it. Run both over
  // the same members and they must agree. Two independent instruments, the way
  // the VPS threshold work checked entry counts against rotation counts.
  //
  // A disagreement is a finding, not a rounding difference: it means the mirror
  // and the contract have drifted, and every number this script prints about the
  // floor is then suspect. It is reported loudly and NOT reconciled silently.
  if (POLICY_B) {
    const all = [...rescue, ...selfFunded, ...evictFloor];
    const mismatch = all.filter(r => {
      const modelRefuses = (r.debt + r.advance) > floorOf(r);
      const chainRefuses = r.eligible === false;
      return modelRefuses !== chainRefuses;
    });
    console.log(`\nMIRROR RECONCILIATION (policy B is LIVE on this chain)`);
    console.log(`  members checked            : ${all.length}`);
    console.log(`  chain refused (loanEligibleFor==false) : ${all.filter(r => r.eligible === false).length}`);
    console.log(`  model refused (debt+advance > floor)   : ${all.filter(r => (r.debt + r.advance) > floorOf(r)).length}`);
    if (mismatch.length === 0) {
      console.log(`  ✓ model and chain AGREE on all ${all.length}`);
    } else {
      console.log(`  *** ${mismatch.length} DISAGREEMENT(S) — the mirror has drifted from the contract.`);
      console.log(`  *** Every floor number in this report is suspect until this is explained.`);
      mismatch.slice(0, 10).forEach(r => console.log(
        `      ${r.tierName} ${r.m}  debt ${usd(r.debt)} + advance ${usd(r.advance)} vs floor ${usd(floorOf(r))}` +
        `  chain says eligible=${r.eligible}`));
    }
    console.log(`\n(The block below is retained for the V8.48 comparison only — on this chain the`);
    console.log(` real refusal count is the "Routed to EVICTION by the insolvency floor" figure above.)`);
  }

  const refusedLive = pendingB.filter(r => r.debt + r.advance > floorOf(r));
  console.log(`\nPOLICY B PREVIEW (discovery only) — refused if B shipped AT THE LIVE BUFFER (${bufferBps} bps): ` +
              `${refusedLive.length} of ${pendingB.length}`);
  if (floorBps > 0n && bufferBps > floorBps) {
    console.log(`    (expected to be ALL of them while the buffer exceeds the floor — that is item 1b's blocker,`);
    console.log(`     not a property of this population.)`);
  }

  // THE NUMBER V8.49 ACTUALLY SHIPS AGAINST. crossingBufferBps defaults to 0, so the
  // advance is the real entry-fee shortfall and nothing else. Everything below is the
  // configuration being built, not the one on chain today.
  const refusedAt0 = pendingB.filter(r => r.debt + r.sfShare > floorOf(r));
  console.log(`\n    AT crossingBufferBps = 0 (the V8.49 default, advance == real shortfall):`);
  console.log(`      refused now      : ${refusedAt0.length} of ${pendingB.length}`);
  refusedAt0.slice(0, 10).forEach(r => console.log(line(r)));

  // How much room each member has LEFT before B bites, and how many further loans of
  // their own current size that room holds. Emergent and queue-dependent — the "3 loans"
  // figure moved to 2 within 4.6h on 2026-08-15. Reported as a spread, never as a rule.
  const withDebt  = pendingB.filter(r => r.debt > 0n);
  const debtTotalB = pendingB.reduce((a, r) => a + r.debt, 0n);
  console.log(`      carrying debt    : ${withDebt.length} of ${pendingB.length}, total ${usd(debtTotalB)}` +
              (withDebt.length ? `, max ${usd(withDebt.reduce((a, r) => r.debt > a ? r.debt : a, 0n))}` : ""));
  if (debtTotalB === 0n) {
    console.log(`      => B REFUSES NOBODY TODAY. It is a guard that arms as debt accumulates,`);
    console.log(`         not a change anyone on this queue would feel. Say so in the handoff.`);
  }

  const loansLeft = pendingB
    .filter(r => r.sfShare > 0n)
    .map(r => {
      const room = floorOf(r) > r.debt ? floorOf(r) - r.debt : 0n;
      return Number(room / r.sfShare);          // whole further loans at TODAY's shortfall
    })
    .sort((a, b) => a - b);
  if (loansLeft.length) {
    const med = loansLeft[Math.floor(loansLeft.length / 2)];
    console.log(`      loans until B refuses, at each member's CURRENT shortfall: ` +
                `min ${loansLeft[0]} · median ${med} · max ${loansLeft[loansLeft.length - 1]}`);
    console.log(`      (emergent, not a rule — it moved 3 -> 2 in 4.6h on 2026-08-15. Do not hard-code it.)`);
  }

  // The AMOUNT question, stated as a number. Discovery must ask the floor about the
  // SAME advance the lender will be asked for, or the two disagree and "SF: insolvency
  // floor" reverts the whole performUpkeep batch. This line shows what a future vote to
  // raise the buffer would do to that agreement if discovery only asked about sfShare.
  for (const bps of [0n, 900n, 1800n, 2700n, 3600n]) {
    const n = pendingB.filter(r => r.debt + r.sfShare + (r.fee * bps) / 10_000n > floorOf(r)).length;
    console.log(`      if crossingBufferBps were ${String(bps).padStart(4)}: B refuses ${n} of ${pendingB.length}` +
                (bps === 0n ? "   <- shipping default" : ""));
  }

  // ── SF EXHAUSTION PROJECTION ───────────────────────────────────────────────
  // The queue is bigger than the fund. Walk the pending rescues in discovery
  // order, applying MatrixKeeper._doParkedRescue's own arithmetic (the buffer
  // trim at :578-581, the bail at :582, then payForceCross's floor require),
  // and report where it stops and HOW it stops — a graceful skip or a revert
  // that takes the whole performUpkeep batch with it.
  const pending = [...rescue, ...selfFunded];
  const needTotal = pending.reduce((a, r) => a + r.advance, 0n);
  console.log(`\nSF EXHAUSTION — pending advances ${usd(needTotal)} vs totalBalance ${usd(sfBal)}` +
              (needTotal > sfBal ? `   SHORT BY ${usd(needTotal - sfBal)}` : "   (fund covers the queue)"));

  // What the SAME queue costs with the buffer removed (owner decision 2026-08-15).
  const needNoBuffer = pending.reduce((a, r) => a + r.sfShare, 0n);
  const bufferPart   = needTotal - needNoBuffer;
  console.log(`    of which BUFFER ${usd(bufferPart)} and real shortfall ${usd(needNoBuffer)}` +
              `  (buffer is ${needTotal > 0n ? Number(bufferPart * 100n / needTotal) : 0}% of the ask)`);
  console.log(`    WITH crossingBufferBps = 0 the queue costs ${usd(needNoBuffer)} vs ${usd(sfBal)} available -> ` +
              (needNoBuffer <= sfBal ? `FUND COVERS ALL ${pending.length}, ${usd(sfBal - needNoBuffer)} left` : `still short ${usd(needNoBuffer - sfBal)}`));
  const floorAmt = pending.length ? (pending[0].fee * floorBps) / 10_000n : 0n;
  const avgShort = pending.length ? needNoBuffer / BigInt(pending.length) : 0n;
  if (avgShort > 0n) {
    console.log(`    average real shortfall ${usd(avgShort)} vs floor ${usd(floorAmt)} -> ` +
                `~${Number(floorAmt / avgShort)} loans before policy B refuses (owner's stated model: 2)`);
  }

  if (stabFloor === null) {
    console.log("    stabilityFloor unreadable — projection SKIPPED rather than guessed.");
  } else {
    let bal = sfBal, done = 0, stopped = null;
    for (const r of pending) {
      let buffer = r.buffer, sfShare = r.sfShare;
      const avail = bal;
      let need = sfShare + buffer;
      if (avail < need) { buffer = avail > sfShare ? avail - sfShare : 0n; need = sfShare + buffer; }
      if (avail < sfShare) { stopped = { r, how: "GRACEFUL SKIP (keeper returns early, no revert)" }; break; }
      if (need > 0n && bal < need + stabFloor) {
        stopped = { r, how: `REVERT "SF: below floor" -> NOT on the swallow-list -> WHOLE BATCH REVERTS` };
        break;
      }
      bal -= need; done++;
    }
    console.log(`    ${done} of ${pending.length} rescues fund before the fund runs out (balance left ${usd(bal)})`);
    if (stopped) {
      console.log(`    then: ${stopped.how}`);
      console.log(`    at:   ${stopped.r.tierName} ${stopped.r.m} needing ${usd(stopped.r.advance)}`);
    } else {
      console.log(`    the whole pending queue funds without exhausting the fund.`);
    }
    if (stabFloor === 0n) {
      console.log(`    stabilityFloor is $0.00, so the buffer trim lands exactly on the require and`);
      console.log(`    exhaustion degrades gracefully. ANY non-zero floor turns this into a batch revert.`);
    }
  }

  // ── BASELINE LOG (V8.49, 2026-08-15) ──────────────────────────────────────
  // THE POINT OF THIS: the 2026-08-13 parked-growth investigation measured the
  // OLD V8.47 chain (+125 parked/day, 99.8% repeat share, exponential SF
  // financing). Those numbers do not describe V8.48 and cannot be recovered
  // later — a snapshot samples the residue, not the population. Every run
  // appends one row here, so the growth RATE becomes measurable, and so there
  // is a genuine before/after when V8.49 lands the buffer removal.
  // Append-only, never rewritten. Safe to run as often as you like.
  //
  // ⛔ THE SERIES WAS CHAIN-BLIND, AND IT PRODUCED A FICTION (found 2026-08-16).
  // The first V8.49 private-deploy run appended row 4 to a file whose rows 1-3 were
  // from the LIVE V8.48 chain, then differenced last-vs-first ACROSS DEPLOYMENTS and
  // printed:
  //     "over 11.5h: parked 88 -> 13 (-75, -156.2/day)"
  // V8.49 did not drain 156 members a day. Those are two different chains. The row's
  // DATA was correct; what was wrong was that nothing recorded WHICH deployment it
  // described, so the trend arithmetic silently spanned both.
  //
  // Fixed by recording the MatrixKeeper ADDRESS — the deployment's ground truth, not
  // the addresses-file name, which is an operator-chosen label that can be pointed
  // anywhere. Trends are computed only across rows from the SAME keeper. Rows written
  // before this column existed are excluded from the arithmetic and COUNTED OUT LOUD,
  // rather than assumed to belong to whichever chain is being read today.
  //
  // Deliberately still append-only. The historical rows are real measurements and are
  // not rewritten; they are simply no longer differenced against a chain they never
  // described.
  try {
    const fs   = require("fs");
    const out  = process.env.BASELINE_FILE
      ? path.join(__dirname, "..", "logs", process.env.BASELINE_FILE)
      : path.join(__dirname, "..", "logs", "parked_baseline.csv");
    const head = "iso,block,parked,halt_risk,self_funded,evict_floor,evict_other," +
                 "rescue,sf_balance_usd,stability_floor_usd,advance_total_usd," +
                 "buffer_total_usd,shortfall_total_usd,debt_total_usd,buffer_bps,floor_bps,keeper\n";
    if (!fs.existsSync(path.dirname(out))) fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!fs.existsSync(out)) fs.writeFileSync(out, head);
    const n = v => (Number(v) / 1e6).toFixed(2);
    const debtTotal = pending.reduce((a, r) => a + r.debt, 0n);
    // Timestamp from the CHAIN, not the local clock — the local clock is not what
    // the ages in this file are measured against.
    const iso = new Date(Number(now) * 1000).toISOString();
    const thisKeeper = String(A.matrixKeeper).toLowerCase();
    fs.appendFileSync(out, [
      iso, block, parkedTotal, halt.length, selfFunded.length, evictFloor.length,
      evictOther.length, rescue.length, n(sfBal), stabFloor === null ? "" : n(stabFloor),
      n(needTotal), n(bufferPart), n(needNoBuffer), n(debtTotal), bufferBps, floorBps,
      thisKeeper,
    ].join(",") + "\n");

    const raw       = fs.readFileSync(out, "utf8").trim().split("\n");
    const headerCol = raw[0].split(",");
    const kIdx      = headerCol.indexOf("keeper");
    const body      = raw.slice(1).map(l => l.split(","));
    console.log(`\nbaseline row appended -> logs/${path.basename(out)}  (${body.length} row${body.length === 1 ? "" : "s"} total)`);

    const mine     = kIdx >= 0 ? body.filter(c => (c[kIdx] || "").toLowerCase() === thisKeeper) : [];
    const unlabelled = kIdx >= 0 ? body.filter(c => !c[kIdx]).length : body.length;

    if (unlabelled > 0) {
      console.log(`    ${unlabelled} row(s) predate deployment labelling and are EXCLUDED from the trend.`);
      console.log(`    They are real measurements, but nothing records which chain they describe,`);
      console.log(`    and at least one of them is from a different deployment than this one.`);
    }
    console.log(`    ${mine.length} row(s) belong to THIS deployment (keeper ${thisKeeper.slice(0, 10)}…)`);

    if (mine.length >= 2) {
      const first = mine[0], last = mine[mine.length - 1];
      const hrs = (Date.parse(last[0]) - Date.parse(first[0])) / 3_600_000;
      if (hrs > 0.25) {
        const dParked = Number(last[2]) - Number(first[2]);
        console.log(`    over ${hrs.toFixed(1)}h on this chain: parked ${first[2]} -> ${last[2]} ` +
                    `(${dParked >= 0 ? "+" : ""}${dParked}, ${(dParked / hrs * 24).toFixed(1)}/day)` +
                    `   SF $${first[8]} -> $${last[8]}`);
      } else {
        console.log(`    (need a few hours between runs on THIS chain before a rate means anything)`);
      }
    } else {
      console.log(`    (no trend yet — a rate needs at least two rows from the same deployment)`);
    }
  } catch (e) {
    // Logging must never break the diagnostic.
    console.log(`\nbaseline log SKIPPED (${e.message})`);
  }

  if (unreadable.length) {
    console.log(`\nUNREADABLE (${unreadable.length}) — counted nowhere above, never assumed to be zero:`);
    unreadable.slice(0, 30).forEach(s => console.log("    " + s));
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
