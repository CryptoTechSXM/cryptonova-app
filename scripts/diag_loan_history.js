// diag_loan_history.js — V8.49 item 1b, policy B. Written 2026-08-16.
//
// THE QUESTION THIS ANSWERS
// -------------------------
// diag_floor_halt.js reported that policy B would refuse 13 of 101 parked members,
// and that 9 of them "carry debt" while 4 do not. The owner asked the right question
// of that number: is this their FIRST loan, or have they been rescued before?
//
// THE SNAPSHOT CANNOT ANSWER IT. StabilityFund.memberDebt is CURRENT OUTSTANDING
// debt (StabilityFund.sol:741, decremented by applyRepayment at :854). A member who
// borrowed $4.00 and repaid it in full reads $0.00 — identical, in every getter, to a
// member who has never borrowed a cent. Calling that "never borrowed" would be the
// same fabrication class this project keeps hitting: a value that means one thing read
// as though it meant another.
//
// The only source of truth is the event log:
//   MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)
//   MemberDebtRepaid   (address indexed member, uint256 amount, uint256 newTotal)
// Both index `member` (StabilityFund.sol:754-755), so grouping is exact, not inferred.
//
// SELF-TEST — THIS IS NOT OPTIONAL. bypass_scan_full.js printed a confident "0" twice
// on 2026-07-29 while a proven positive sat inside the scanned range, because a capped
// fetch produced a clean, plausible, wrong answer. So before any per-member conclusion
// is printed, the scan's own totals are reconciled against the contract's cumulative
// counters, which are written by the SAME function that emits the events:
//   Σ MemberDebtIncreased.amount  ==  StabilityFund.totalRescueLoaned()   (:828)
//   Σ MemberDebtRepaid.amount     ==  StabilityFund.totalRescueRepaid()
// If they disagree, the window or the chunking missed logs and EVERY number below is
// suspect — the script says so in those words and does not dress it up.
//
// Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_loan_history.js
//
// Optional env:
//   TIERS=T1,T2       narrow the tier sweep
//   ALL=1             profile every parked member, not just the ones B would refuse
//   CHUNK=1800        starting getLogs window (it halves itself on failure)
//   FROM_BLOCK=...    override the deploy-block search
//   ADDRESSES_FILE=...
//
// Read-only. Sends nothing. A failed read prints "?" and its reason, never a number.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));
const ONLY = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);
const PROFILE_ALL = process.env.ALL === "1";
const CHUNK0 = BigInt(process.env.CHUNK || 1800);

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
  "function rotationCount() view returns (uint256)",
  "function occupancy() view returns (uint256)",
  // FigureEightMatrixV8.sol:793 — the whole Member struct in one call. Field order is
  // MatrixLogicLib.Member (:50): id, referrer, joinedAt, withdrawable, totalEarned,
  // totalWithdrawn, cyclesCompleted, isInMatrix, hasEverJoined, crossingReserve.
  "function members(address) view returns (tuple(uint256 id,address referrer,uint256 joinedAt,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 cyclesCompleted,bool isInMatrix,bool hasEverJoined,uint256 crossingReserve))",
];
const PM_ABI = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address matA, address matB)",
];
const MK_ABI = [
  "function rescueRatioBps() view returns (uint256)",
  "function sfRescueThresholds(uint256) view returns (uint256)",
  "function sfRescueBpsLadder(uint256) view returns (uint256)",
  "function sfRescueLadderPreset() view returns (uint8)",
  "function CROSSING_BUFFER_BPS() view returns (uint256)",
  "function crossingBufferBps() view returns (uint256)",
];
const SF_ABI = [
  "function memberDebt(address) view returns (uint256)",
  "function insolvencyFloorBps() view returns (uint256)",
  "function totalBalance() view returns (uint256)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];

const usd  = v => "$" + (Number(v) / 1e6).toFixed(2);
const hrs  = s => (Number(s) / 3600).toFixed(1) + "h";
const short = a => a.slice(0, 10);

// Mirror of MatrixKeeperLib._rescueBpsFor (:317). null == the "off the bottom of the
// ladder" sentinel, which in Solidity is type(uint256).max.
function rescueBpsFor(thresholds, ladder, effectiveContrib, entryFee) {
  if (thresholds.length === 0) return 10_000n;
  const wBps = (effectiveContrib * 10_000n) / entryFee;
  for (let i = 0; i < thresholds.length; i++) if (wBps >= thresholds[i]) return ladder[i];
  return null;
}

async function readArray(c, fn) {
  const out = [];
  for (let i = 0; i < 64; i++) { try { out.push(await c[fn](i)); } catch { break; } }
  return out;
}

async function readBufferBps(mk) {
  try   { return { bps: await mk.crossingBufferBps(),   source: "crossingBufferBps() [V8.49 param]" }; }
  catch { /* not deployed yet */ }
  return { bps: await mk.CROSSING_BUFFER_BPS(), source: "CROSSING_BUFFER_BPS() [V8.48 constant]" };
}

/**
 * Find the first block at or after `wantTs` by binary search on block timestamps.
 * Deliberately NOT "current block minus seconds/2": Base's 2s cadence is a nominal, and
 * a window that starts even slightly late drops the earliest loans — which are exactly
 * the ones that decide whether a member's current loan is their first.
 */
async function blockAtOrAfter(p, wantTs, hiBlock) {
  let lo = 0, hi = hiBlock, ans = hiBlock;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let b;
    try { b = await p.getBlock(mid); } catch { lo = mid + 1; continue; }
    if (!b) { lo = mid + 1; continue; }
    if (b.timestamp >= wantTs) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return ans;
}

/**
 * Chunked getLogs that HALVES its window on failure rather than giving up or, worse,
 * capping silently. The free sepolia.base.org endpoint refuses large ranges with
 * "could not coalesce error" (its 429) — measured 2,000 OK / 9,000 FAIL, 2026-07-29.
 * Every chunk that finally fails is recorded and reported; none is skipped quietly.
 */
async function getLogsChunked(p, address, topic0, fromBlock, toBlock) {
  const out = [], failed = [];
  let from = BigInt(fromBlock);
  const end = BigInt(toBlock);
  let span = CHUNK0;
  let done = 0n;
  const total = end - from + 1n;
  while (from <= end) {
    const to = (from + span - 1n) > end ? end : (from + span - 1n);
    try {
      const logs = await p.getLogs({ address, topics: [topic0], fromBlock: Number(from), toBlock: Number(to) });
      out.push(...logs);
      done += (to - from + 1n);
      from = to + 1n;
      if (span < CHUNK0) span *= 2n;                 // recover after a narrow patch
      process.stdout.write(`\r    scanning ${Number(done * 100n / total)}%   `);
    } catch (e) {
      if (span > 100n) { span /= 2n; continue; }     // halve and retry the same start
      failed.push(`${from}-${to}: ${e.shortMessage || e.message}`);
      from = to + 1n;
      span = CHUNK0;
    }
  }
  process.stdout.write("\r                        \r");
  return { logs: out, failed };
}

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p  = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const mk = new ethers.Contract(A.matrixKeeper,  MK_ABI, p);
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);

  const head  = await p.getBlockNumber();
  const now   = (await p.getBlock(head)).timestamp;

  const rescueRatioBps = await mk.rescueRatioBps();
  const bufferRead     = await readBufferBps(mk);
  const bufferBps      = bufferRead.bps;
  const thresholds     = await readArray(mk, "sfRescueThresholds");
  const ladder         = await readArray(mk, "sfRescueBpsLadder");
  const floorBps       = await sf.insolvencyFloorBps();
  const loanedTotal    = await sf.totalRescueLoaned();
  const repaidTotal    = await sf.totalRescueRepaid();

  console.log(`block ${head}   SF ${A.stabilityFund}`);
  console.log(`insolvencyFloorBps ${floorBps}   crossing buffer ${bufferBps} bps  <- ${bufferRead.source}`);
  console.log(`SF lifetime: loaned ${usd(loanedTotal)}   repaid ${usd(repaidTotal)}   outstanding ${usd(loanedTotal - repaidTotal)}`);

  // ── 1. THE LOAN LEDGER, FROM EVENTS ────────────────────────────────────────
  const fromBlock = process.env.FROM_BLOCK
    ? Number(process.env.FROM_BLOCK)
    : await blockAtOrAfter(p, Math.floor(Date.parse(A.deployedAt) / 1000), head);
  console.log(`\nscanning SF debt events from block ${fromBlock} (deployedAt ${A.deployedAt}) to ${head} — ${head - fromBlock + 1} blocks`);

  const iface = new ethers.Interface(SF_ABI);
  const T_INC = iface.getEvent("MemberDebtIncreased").topicHash;
  const T_REP = iface.getEvent("MemberDebtRepaid").topicHash;

  const incRes = await getLogsChunked(p, A.stabilityFund, T_INC, fromBlock, head);
  const repRes = await getLogsChunked(p, A.stabilityFund, T_REP, fromBlock, head);

  const hist = new Map();   // member -> { loans:[{amount,tier,block}], repaid:[{amount,block}] }
  const bump = (m) => { const k = m.toLowerCase(); if (!hist.has(k)) hist.set(k, { loans: [], repaid: [] }); return hist.get(k); };
  let scannedLoaned = 0n, scannedRepaid = 0n;
  for (const l of incRes.logs) {
    const e = iface.parseLog(l);
    bump(e.args.member).loans.push({ amount: e.args.amount, tier: Number(e.args.tier), block: l.blockNumber });
    scannedLoaned += e.args.amount;
  }
  for (const l of repRes.logs) {
    const e = iface.parseLog(l);
    bump(e.args.member).repaid.push({ amount: e.args.amount, block: l.blockNumber });
    scannedRepaid += e.args.amount;
  }

  // ── 2. SELF-TEST BEFORE ANY CONCLUSION ─────────────────────────────────────
  // The events and the counters are written by the same function (increaseMemberDebt,
  // StabilityFund.sol:827-831), so they cannot legitimately disagree. If they do, this
  // scan is short of logs and "never borrowed" below would be a scanning artefact.
  const okLoaned = scannedLoaned === loanedTotal;
  const okRepaid = scannedRepaid === repaidTotal;
  console.log(`\nSCAN SELF-TEST`);
  console.log(`  MemberDebtIncreased: ${incRes.logs.length} events, ${usd(scannedLoaned)}  vs contract totalRescueLoaned ${usd(loanedTotal)}  ${okLoaned ? "MATCH" : "*** MISMATCH ***"}`);
  console.log(`  MemberDebtRepaid   : ${repRes.logs.length} events, ${usd(scannedRepaid)}  vs contract totalRescueRepaid ${usd(repaidTotal)}  ${okRepaid ? "MATCH" : "*** MISMATCH ***"}`);
  if (incRes.failed.length || repRes.failed.length) {
    console.log(`  CHUNKS THAT FAILED OUTRIGHT (counted nowhere, never assumed empty):`);
    [...incRes.failed, ...repRes.failed].slice(0, 20).forEach(s => console.log("    " + s));
  }
  if (!okLoaned || !okRepaid) {
    console.log(`\n  *** THE SCAN IS INCOMPLETE. Every "first loan / prior loan" verdict below is`);
    console.log(`      UNRELIABLE — a missed log reads exactly like a member who never borrowed.`);
    console.log(`      Re-run with a smaller CHUNK (e.g. CHUNK=500) or a paid RPC before believing it.`);
  } else {
    console.log(`  => the scan holds every loan the contract has ever booked. Verdicts below are sound.`);
  }
  console.log(`  distinct members who have EVER borrowed, chain-wide: ${[...hist.values()].filter(h => h.loans.length).length}`);

  // ── 3. THE PARKED QUEUE, WITH TRIAGE AND HISTORY SIDE BY SIDE ──────────────
  const tiers = Object.entries(A.tiers).filter(([name]) => !ONLY.length || ONLY.includes(name));
  const rows = [], unreadable = [];

  for (const [tierName, t] of tiers) {
    const tierIdx = Number(tierName.slice(1)) - 1;
    let pairs;
    try {
      const pm = new ethers.Contract(t.pm, PM_ABI, p);
      const n  = await pm.activePairCount();
      pairs = [];
      for (let i = 0n; i < n; i++) pairs.push(await pm.getPairAt(i));
    } catch (e) {
      console.log(`${tierName}: pair enumeration FAILED (${e.shortMessage || e.message}) — address-file pair 1 only`);
      pairs = [[t.matA, t.matB]];
    }

    for (const [matA, matB] of pairs) {
      for (const addr of [matA, matB]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const mat = new ethers.Contract(addr, MAT_ABI, p);

        let pc, fee, partner, rot, occ;
        try { pc = await mat.getParkedCount(); } catch (e) { console.log(`  ${addr} getParkedCount ? (${e.shortMessage || e.message})`); continue; }
        if (pc === 0n) continue;
        try { fee = await mat.ENTRY_FEE(); }   catch (e) { console.log(`  ${addr} ENTRY_FEE ? (${e.shortMessage || e.message})`); continue; }
        try { partner = await mat.partner(); } catch { partner = ethers.ZeroAddress; }
        try { rot = await mat.rotationCount(); } catch (e) { rot = null; console.log(`  ${addr} rotationCount ? (${e.shortMessage || e.message})`); }
        try { occ = await mat.occupancy(); }    catch { occ = null; }

        for (let i = 0n; i < pc; i++) {
          let m;
          try { m = await mat.getParkedMember(i); } catch (e) { unreadable.push(`${addr}[${i}] getParkedMember ? ${e.shortMessage || e.message}`); continue; }
          if (!m || m === ethers.ZeroAddress) continue;

          let ts, seatedHere, seatedPartner, withdrawn, withdrawable, reserve, debt, info;
          try {
            ts = await mat.parkedAt(m);
            if (ts === 0n) continue;
            seatedHere    = await mat.isInMatrix(m);
            seatedPartner = partner !== ethers.ZeroAddress
              ? await new ethers.Contract(partner, MAT_ABI, p).isActiveInMatrix(m) : false;
            withdrawn     = await mat.getMemberTotalWithdrawn(m);
            withdrawable  = await mat.withdrawableOf(m);
            reserve       = await mat.crossingReserveOf(m);
            debt          = await sf.memberDebt(m);
            info          = await mat.members(m);
          } catch (e) { unreadable.push(`${tierName} ${addr} ${m} ? ${e.shortMessage || e.message}`); continue; }

          if (seatedHere || seatedPartner) continue;   // GHOST — triage returns before any of this

          const totalEarnedM  = withdrawn + withdrawable;
          const withdrawRatio = totalEarnedM > 0n ? (withdrawn * 10_000n) / totalEarnedM : 0n;
          if (withdrawRatio > rescueRatioBps) continue;          // EVICT_RATIO

          const effective = reserve + withdrawable;
          const sfBps = rescueBpsFor(thresholds, ladder, effective, fee);
          if (sfBps === null) continue;                          // EVICT_LADDER

          const maxShortfall = fee > effective ? fee - effective : 0n;
          let sfShare = (fee * sfBps) / 10_000n;
          if (sfShare > maxShortfall) sfShare = maxShortfall;

          const h = hist.get(m.toLowerCase()) || { loans: [], repaid: [] };
          rows.push({
            tierName, tierIdx, addr, m, rot, occ, fee, reserve, withdrawable, withdrawn, debt,
            sfShare,
            parkAge: BigInt(now) - ts,
            joinAge: info.joinedAt > 0n ? BigInt(now) - info.joinedAt : null,
            cycles: info.cyclesCompleted,
            everJoined: info.hasEverJoined,
            lifetimeEarned: info.totalEarned,
            loans: h.loans, repaid: h.repaid,
            refusedAt0: debt + sfShare > (fee * floorBps) / 10_000n,
          });
        }
      }
    }
  }

  // ── 4. REPORT ──────────────────────────────────────────────────────────────
  const refused = rows.filter(r => r.refusedAt0);
  const everBorrowed = rows.filter(r => r.loans.length > 0);

  console.log(`\nPARKED (rescue candidates, ghosts/ratio/ladder cases excluded): ${rows.length}`);
  console.log(`  would be REFUSED by policy B at crossingBufferBps = 0: ${refused.length}`);
  console.log(`  have EVER taken an SF loan (from events, not from memberDebt): ${everBorrowed.length}`);
  console.log(`  carry OUTSTANDING debt right now (memberDebt > 0)          : ${rows.filter(r => r.debt > 0n).length}`);
  const repaidInFull = rows.filter(r => r.loans.length > 0 && r.debt === 0n);
  console.log(`  borrowed before and REPAID IN FULL (invisible to memberDebt): ${repaidInFull.length}` +
              (repaidInFull.length ? "   <- these are the ones the snapshot could not see" : ""));

  const show = PROFILE_ALL ? rows : refused;
  console.log(`\n${PROFILE_ALL ? "EVERY parked rescue candidate" : "THE MEMBERS POLICY B WOULD REFUSE"} — is this their first loan?\n`);
  for (const r of show.sort((a, b) => (b.loans.length - a.loans.length) || Number(b.sfShare - a.sfShare))) {
    const lifetimeLoaned = r.loans.reduce((a, l) => a + l.amount, 0n);
    const lifetimeRepaid = r.repaid.reduce((a, l) => a + l.amount, 0n);
    const verdict = r.loans.length === 0
      ? "FIRST LOAN — never borrowed before"
      : `RESCUED BEFORE x${r.loans.length}  (lifetime borrowed ${usd(lifetimeLoaned)}, repaid ${usd(lifetimeRepaid)})`;
    console.log(`  ${r.tierName} ${r.m}`);
    console.log(`      ask now ${usd(r.sfShare)}   outstanding debt ${usd(r.debt)}   floor ${usd((r.fee * floorBps) / 10_000n)}   -> ${verdict}`);
    console.log(`      reserve ${usd(r.reserve)}  withdrawable ${usd(r.withdrawable)}  lifetime withdrawn ${usd(r.withdrawn)}  lifetime EARNED ${usd(r.lifetimeEarned)}`);
    console.log(`      cyclesCompleted ${r.cycles}   hasEverJoined ${r.everJoined}   parked ${hrs(r.parkAge)} ago   joined ${r.joinAge === null ? "?" : hrs(r.joinAge) + " ago"}`);
    console.log(`      matrix ${short(r.addr)}  rotationCount ${r.rot === null ? "?" : r.rot}  occupancy ${r.occ === null ? "?" : r.occ}`);
    if (r.loans.length) {
      console.log(`      loan history: ` + r.loans.map(l => `${usd(l.amount)}@blk${l.block}(T${l.tier + 1})`).join("  "));
      if (r.repaid.length) console.log(`      repayments  : ` + r.repaid.map(l => `${usd(l.amount)}@blk${l.block}`).join("  "));
    }
    console.log("");
  }

  // ── 5. THE ANSWER, IN ONE LINE ─────────────────────────────────────────────
  const firstTimers = refused.filter(r => r.loans.length === 0);
  const repeats     = refused.filter(r => r.loans.length > 0);
  console.log(`ANSWER — of the ${refused.length} members policy B would refuse:`);
  console.log(`  ${repeats.length} have been rescued before (${repeats.reduce((a, r) => a + r.loans.length, 0)} loans between them)`);
  console.log(`  ${firstTimers.length} would be refused on their FIRST EVER loan`);
  if (firstTimers.length) {
    const neverEarned = firstTimers.filter(r => r.lifetimeEarned === 0n).length;
    const neverCycled = firstTimers.filter(r => r.cycles === 0n).length;
    console.log(`      of those first-timers: ${neverEarned} have lifetime earnings of $0.00, ${neverCycled} have completed 0 cycles`);
    console.log(`      (lifetime EARNED is the Member struct's totalEarned — it survives withdrawal,`);
    console.log(`       so $0.00 there means they were never paid anything, not that they spent it.)`);
  }
  if (!okLoaned || !okRepaid) console.log(`\n  ...but the self-test above FAILED, so treat all of it as provisional.`);

  if (unreadable.length) {
    console.log(`\nUNREADABLE (${unreadable.length}) — counted nowhere above, never assumed to be zero:`);
    unreadable.slice(0, 30).forEach(s => console.log("    " + s));
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
