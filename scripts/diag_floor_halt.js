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
  "function CROSSING_BUFFER_BPS() view returns (uint256)",
];
const SF_ABI = [
  "function memberDebt(address) view returns (uint256)",
  "function insolvencyFloorBps() view returns (uint256)",
  "function loanEligible(address,uint8) view returns (bool)",
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
  const bufferBps       = await mk.CROSSING_BUFFER_BPS();
  const preset          = await mk.sfRescueLadderPreset();
  const thresholds      = await readArray(mk, "sfRescueThresholds");
  const ladder          = await readArray(mk, "sfRescueBpsLadder");
  const floorBps        = await sf.insolvencyFloorBps();
  const sfBal           = await sf.totalBalance();

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
  console.log(`insolvencyFloorBps ${floorBps}   CROSSING_BUFFER_BPS ${bufferBps}   rescueRatioBps ${rescueRatioBps}`);
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

          let ts, seatedHere, seatedPartner, withdrawn, withdrawable, reserve, debt, eligible;
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
            eligible      = await sf.loanEligible(m, tierIdx);
          } catch (e) {
            unreadable.push(`${tierName} ${addr} ${m} ? ${e.shortMessage || e.message}`);
            continue;
          }
          parkedTotal++;

          const age  = BigInt(now) - ts;
          const row  = { tierName, tierIdx, addr, m, age, fee, reserve, withdrawable, debt, eligible };

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

          const buffer  = (fee * bufferBps) / 10_000n;   // MatrixKeeper.sol:568 — UNCONDITIONAL
          const advance = sfShare + buffer;
          row.sfShare = sfShare; row.buffer = buffer; row.advance = advance;

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

  // What policy B (floor tested AFTER the advance, buffer included) would do.
  const wouldRefuse = [...rescue, ...selfFunded].filter(r => r.debt + r.advance > (r.fee * floorBps) / 10_000n);
  console.log(`\nPOLICY B PREVIEW — memberDebt + advance > floor, so refused if B shipped today: ` +
              `${wouldRefuse.length} of ${rescue.length + selfFunded.length}`);
  if (floorBps > 0n && bufferBps > floorBps) {
    console.log(`    (expected to be ALL of them while the buffer exceeds the floor — that is item 1b's blocker,`);
    console.log(`     not a property of this population.)`);
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

  if (unreadable.length) {
    console.log(`\nUNREADABLE (${unreadable.length}) — counted nowhere above, never assumed to be zero:`);
    unreadable.slice(0, 30).forEach(s => console.log("    " + s));
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
