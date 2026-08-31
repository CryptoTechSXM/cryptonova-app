// diag_rescue_loan_counts.js — HOW MANY RESCUES DID EACH STUCK MEMBER ACTUALLY TAKE?
//
// THE QUESTION (handoff 35.10 item 1, written session 35, run session 36). 35.7 read the
// insolvency gate as a lifetime debt ceiling worth about one rescue, and inferred from the
// shape of ten recorded debts that the stuck members are ordinary people who took ONE OR
// TWO rescues off 35.6's treadmill and hit a ceiling that affords one. 35.7 marked that
// STRONGLY SUPPORTED, NOT PROVEN and named this measurement as the thing that settles it.
//
// Read-only. It sends no transaction and needs no key.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// ⛔ RUN 1 (2026-08-24 14:48Z) FAILED ITS OWN RECONCILIATION, AND THE FAULT WAS HERE.
//    KEEP THIS — IT IS THE REASON THE SCRIPT LOOKS THE WAY IT DOES.
//
//    v1 counted the MATRIX's events: `RescueLoanIssued` and `RescueDebtRepaid`
//    (MatrixLogicLib:267). 21 of 26 members reconciled and 5 did not, every one of them
//    with the chain holding LESS debt than the events derived — $1.60 to $6.80 missing.
//
//    The deployed source says why. V8.47 moved the ledger off the matrix and onto the SF:
//
//      MatrixLogicLib:547   try IStabilityFund(...).receiveDebtRepayment(member, repay) {}
//      MatrixLogicLib:549   emit RescueDebtRepaid(member, repay, owed - repay);
//      StabilityFund:841    require(authorizedMatrices[msg.sender] || msg.sender == tierRouter)
//      StabilityFund:857    emit MemberDebtRepaid(member, applied, memberDebt[member]);
//
//    `receiveDebtRepayment` accepts the TierRouter as well as any authorized matrix, and
//    the matrix-side event is emitted only on the matrix paths. A repayment driven from
//    the router moves the ledger and emits NOTHING a matrix scan can see. The SF's own
//    `MemberDebtIncreased` / `MemberDebtRepaid` pair is the ledger's own record of every
//    movement, from every caller — so that is what this script reconciles against now.
//    The matrix's `RescueLoanIssued` is still read, but only for the `rescueType` string,
//    which is the one thing the SF event does not carry.
//
//    THE LESSON, WHICH IS THE HOUSE LESSON AGAIN: I counted the event that was easy to
//    find rather than the event the ledger emits. The reconciliation is the only reason
//    that is a footnote instead of a published wrong number.
//
// ⛔ RUN 1 ALSO RAISED TWO `getParkedMember` OUT-OF-BOUNDS PANICS, AND THEY ARE A RACE,
//    NOT A CONTRACT BUG. `getParkedCount()` returns `_state.parkedMembers.length` and
//    `getParkedMember(i)` indexes that same array (FigureEightMatrixV8:606-607), so an
//    index inside the count cannot be out of bounds in ONE state. It can be across two:
//    the keeper drained a parked member between the two calls. The keeper fires every
//    2-4 seconds and this sweep takes minutes. So every read below is now pinned to ONE
//    BLOCK, which also means the census is a snapshot rather than a smear — v1's
//    past-grace count (28) was taken over two minutes of a moving queue.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// THE GATE, READ OUT OF THE DEPLOYED BUILD — NOT THE WORKING TREE (34.5)
//
//   git show d382d37:contracts/StabilityFund.sol:799
//     function loanEligible(address member, uint8 tierIdx) public view returns (bool) {
//         if (insolvencyFloorBps == 0) return true;
//         if (tierIdx >= MAX_TIERS)    return false;
//         uint256 fee = tierEntryFees[tierIdx];
//         if (fee == 0) return true;
//         return memberDebt[member] < fee * insolvencyFloorBps / 10_000;
//     }
//
//   1. THE CEILING IS PER-TIER. It is priced off the fee of the tier the rescue is
//      requested IN — $3.40 at T1, $8.50 at T2, $17.00 at T3 at floorBps 3400. 35.7
//      quoted the T1 figure as though it were the ceiling.
//   2. THE LEDGER IS GLOBAL. `memberDebt` is one number per member across every tier.
//   3. IT IS A NET FIGURE, NOT A TOTAL BORROWED. Repayment restores headroom. So the
//      question "how many rescues does the ceiling afford" cannot be answered by the
//      ceiling alone — it depends on how much of each loan comes back. That is why this
//      script prints borrowed, repaid AND net side by side.
//
// SELF-TESTS, BOTH OF WHICH MUST PASS BEFORE THE TABLE MEANS ANYTHING
//   1. PLANTED POSITIVE — the treadmill wallet from 35.6 must show loan events.
//   2. RECONCILIATION — per member, SF increases less SF repayments must equal the live
//      `memberDebtOf()`, and the global `totalRescueLoaned - totalRescueRepaid` must
//      equal the sum of every debt the SF holds (the invariant StabilityFund:736 states
//      about itself). If either fails the sweep is not a census and the verdict is
//      withheld rather than softened.
//
// ⛔ NO SILENT FALLBACKS. A failed read raises a named PROBLEM and downgrades its row to
//    UNKNOWN. A transport error is the ABSENCE of an answer, not an answer.
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/diag_rescue_loan_counts.js --network baseSepolia
//
//   TIERS=T1,T2        limit the parked sweep (default: every tier in the addresses file)
//   FROM_BLOCK=n       skip the deploy-block search (default: binary search on deployedAt)
//   CHUNK=9000         eth_getLogs window size
//   INCLUDE_GRACE=1    also count members still inside grace (default: past-grace only)
//   SNAPSHOT=0         do NOT pin reads to one block (only if the node refuses old state)
//   CSV=out.csv        override output path (default: logs/rescue_loan_counts_<ts>.csv)
//   SELFTEST=0         disable the planted positive (do not, without a reason)
//
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// 34.1 / 34.7 item 5: NO DEFAULT. Two copies of the rescue engine defaulted to a dead
// deployment for eleven days and printed confident numbers about it.
if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.log("    npx hardhat run scripts/diag_rescue_loan_counts.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
];
// The matrix event is kept for ONE reason: `rescueType`. The SF event is the ledger.
const MX_EV_ABI = [
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
];
const SF_EV_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];
const SF_ABI = [
  "function insolvencyFloorBps() view returns (uint256)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function memberDebtOf(address) view returns (uint256)",
  "function totalBalance() view returns (uint256)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
  "function loanEligible(address,uint8) view returns (bool)",
  "function clawbackBpsFor(address) view returns (uint256)",
];
const KEEPER_ABI = [
  "function parkedGracePeriod() view returns (uint256)",
  "function selfFundedGracePeriod() view returns (uint256)",
];

const usd = v => (v === null || v === undefined) ? "?" : "$" + (Number(v) / 1e6).toFixed(2);
const ts  = () => new Date().toISOString();
const lc  = a => String(a).toLowerCase();

const problems = [];
const PROBLEM = (where, e) => {
  const detail = e ? `: ${(e.shortMessage || e.message || "unreadable").slice(0, 90)}` : "";
  problems.push(`${where}${detail}`);
  console.log(`  PROBLEM ${where}${detail}`);
};

const isTransport = m =>
  /HH110|Invalid JSON-RPC|ECONNRESET|ETIMEDOUT|socket hang up|network|timeout|50[234]|fetch failed|could not coalesce|log range|block range/i
    .test(m || "");
// A pruned-state refusal is NOT a transport error and must never be retried into silence —
// it means the snapshot block is out of the node's window and the whole pin is invalid.
const isNoState = m => /missing trie node|header not found|state (is )?not available|no state|pruned/i.test(m || "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let SNAP = null;                       // the block every state read is pinned to
let snapDead = false;
const at = () => (SNAP === null ? {} : { blockTag: SNAP });

async function read(label, fn, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return { ok: true, v: await fn() }; }
    catch (e) {
      last = e;
      const msg = e.shortMessage || e.message;
      if (isNoState(msg)) { snapDead = true; break; }
      if (!isTransport(msg)) break;                 // a revert is a real answer
      await sleep(400 * (i + 1));
    }
  }
  PROBLEM(label, last);
  return { ok: false, v: null };
}

// ── the deploy block, found rather than assumed ────────────────────────────────────────
async function findDeployBlock(provider, isoWhen) {
  const target = Math.floor(new Date(isoWhen).getTime() / 1000);
  let lo = 0, hi = await provider.getBlockNumber();
  const hiB = await provider.getBlock(hi);
  if (!hiB) throw new Error("head block unreadable");
  if (hiB.timestamp < target) throw new Error("deployedAt is in the future of the chain head");
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (!b) { lo = mid + 1; continue; }
    if (b.timestamp < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  console.log(`[${ts()}] diag_rescue_loan_counts — READ-ONLY, no transactions sent`);
  console.log(`  addresses   : ${process.env.ADDRESSES_FILE}`);
  console.log(`  network     : ${A.network || "?"}   deployed ${A.deployedAt || "?"}`);

  const provider = ethers.provider;
  const mxIface  = new ethers.Interface(MX_EV_ABI);
  const sfIface  = new ethers.Interface(SF_EV_ABI);
  const T_LOAN   = mxIface.getEvent("RescueLoanIssued").topicHash;
  const T_INC    = sfIface.getEvent("MemberDebtIncreased").topicHash;
  const T_REP    = sfIface.getEvent("MemberDebtRepaid").topicHash;

  // ── the snapshot: one block for every state read ─────────────────────────────────────
  const head = await provider.getBlockNumber();
  let snapTime = BigInt(Math.floor(Date.now() / 1000));
  if (process.env.SNAPSHOT !== "0") {
    SNAP = head;
    const b = await provider.getBlock(SNAP);
    if (b) snapTime = BigInt(b.timestamp);
    console.log(`  snapshot    : block ${SNAP} (${new Date(Number(snapTime) * 1000).toISOString()})`);
    console.log(`                every state read below is pinned here, so the parked queue`);
    console.log(`                cannot shift under the sweep the way it did in run 1.`);
  } else {
    console.log(`  snapshot    : DISABLED — reads follow the head. Ages and counts will smear.`);
  }

  // ── grace: chain or nothing (34.2) ───────────────────────────────────────────────────
  const keeper = await ethers.getContractAt(KEEPER_ABI, A.matrixKeeper);
  const g = await read("parkedGracePeriod()", () => keeper.parkedGracePeriod(at()));
  if (!g.ok) {
    if (snapDead) {
      console.log("  ABORT: this node will not serve state at the snapshot block. Re-run with");
      console.log("  SNAPSHOT=0 and treat the census as a smear, or point at an archive RPC.");
    } else {
      console.log("  ABORT: grace period unreadable. Every past-grace verdict would be invented.");
    }
    return;
  }
  const grace = g.v;
  console.log(`  grace       : ${grace}s (${(Number(grace) / 3600).toFixed(1)}h), from chain  [parkedGracePeriod]`);
  // ⛔⛔ THERE ARE THREE CLOCKS, NOT ONE — established from source 2026-08-30 (51.5).
  //     MatrixKeeperLib._checkParked:753 gates the work queue on
  //         age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
  //     so a SELF-FUNDED member becomes actionable after selfFundedGracePeriod
  //     (300s at the live setting — a race guard, explicitly NOT a grace period,
  //     MatrixKeeper.sol:416) while a LOAN-BEARING one waits parkedGracePeriod (24h).
  //     This script judges EVERY parked member by the 24h clock, which UNDERSTATES
  //     what the queue considers actionable — measured 2026-08-30 at block 46177592:
  //     18 of 444 positions past 24h, 435 of 444 past 300s. Both bounds are printed
  //     below. sfShare is not readable off-chain without reimplementing _triageParked,
  //     so the true figure is NOT computed here — inventing it would be a hypothesis.
  const gs = await read("selfFundedGracePeriod()", () => keeper.selfFundedGracePeriod(at()));
  const selfGrace = gs.ok ? gs.v : null;
  console.log(`  self grace  : ${selfGrace === null ? "UNREADABLE — self-funded bound not computed"
                : `${selfGrace}s (${(Number(selfGrace) / 60).toFixed(0)}m), from chain  [selfFundedGracePeriod]`}`);

  // ── the gate's own inputs ────────────────────────────────────────────────────────────
  const sf    = await ethers.getContractAt(SF_ABI, A.stabilityFund);
  const floor = await read("insolvencyFloorBps()", () => sf.insolvencyFloorBps(at()));
  const sfBal = await read("SF totalBalance()",     () => sf.totalBalance(at()));
  if (!floor.ok) { console.log("  ABORT: insolvencyFloorBps unreadable — no ceiling can be computed."); return; }
  console.log(`  floor bps   : ${floor.v}`);
  console.log(`  SF balance  : ${usd(sfBal.v)}   <- the V8.48 gate never reads this`);

  const tierKeys = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);
  const tiers    = tierKeys.length ? tierKeys : Object.keys(A.tiers);

  const ceilingOf = new Map();
  console.log("\n  THE CEILING, PER TIER (fee * floorBps / 10000, from chain)");
  for (const tk of Object.keys(A.tiers)) {
    const idx = Number(tk.slice(1)) - 1;
    const f   = await read(`tierEntryFees(${idx})`, () => sf.tierEntryFees(idx, at()));
    if (!f.ok || f.v === 0n) continue;
    ceilingOf.set(tk, { fee: f.v, ceil: f.v * floor.v / 10000n });
    console.log(`    ${tk.padEnd(4)} fee ${usd(f.v).padStart(9)}   lifetime NET debt ceiling ${usd(f.v * floor.v / 10000n).padStart(9)}`);
  }

  // ── enumerate every pair; collect every matrix address for the type scan ─────────────
  const INCLUDE_GRACE = process.env.INCLUDE_GRACE === "1";
  const stuck = [], mxAddrs = [], cov = [];

  for (const tk of tiers) {
    const t = A.tiers[tk];
    if (!t || !t.pm) { PROBLEM(`${tk} pair manager absent from addresses file — TIER SKIPPED`); continue; }
    const pm = await ethers.getContractAt(PM_ABI, t.pm);
    const pc = await read(`${tk} pairCount()`, () => pm.pairCount(at()));
    if (!pc.ok) { cov.push(`${tk}: pairCount UNREADABLE — TIER NOT SWEPT`); continue; }

    let seenPairs = 0, seenMx = 0, parkedTotal = 0, pastGrace = 0, pastSelf = 0;
    for (let i = 0n; i < pc.v; i++) {
      const pr = await read(`${tk} getPairAt(${i})`, () => pm.getPairAt(i, at()));
      if (!pr.ok) continue;
      seenPairs++;
      for (let j = 0; j < 2; j++) {
        const addr = pr.v[j];
        if (addr === ethers.ZeroAddress) continue;
        mxAddrs.push(addr);
        const label = `${tk}.${i + 1n} ${j ? "MatB" : "MatA"}`;   // 1-BASED display
        const mx  = await ethers.getContractAt(MX_ABI, addr);
        const cnt = await read(`${label} getParkedCount()`, () => mx.getParkedCount(at()));
        if (!cnt.ok) continue;
        seenMx++;
        if (cnt.v === 0n) continue;
        parkedTotal += Number(cnt.v);

        for (let k = 0n; k < cnt.v; k++) {
          const mr = await read(`${label} getParkedMember(${k})`, () => mx.getParkedMember(k, at()));
          if (!mr.ok) continue;
          const m  = mr.v;
          const pa = await read(`${label} parkedAt(${m.slice(0, 10)})`, () => mx.parkedAt(m, at()));
          if (!pa.ok) continue;
          if (pa.v === 0n) continue;                    // already rescued out
          const ageS = snapTime - pa.v;
          const inGrace = ageS < grace;
          if (inGrace && !INCLUDE_GRACE) continue;
          if (!inGrace) pastGrace++;
          if (selfGrace !== null && ageS >= selfGrace) pastSelf++;
          stuck.push({ tier: tk, matrix: label, matrixAddr: addr, member: m,
                       ageDays: (Number(ageS) / 86400).toFixed(2), inGrace });
        }
      }
    }
    cov.push(`${tk}: pairs ${seenPairs}/${pc.v} | matrices ${seenMx} | parked ${parkedTotal} | past 24h ${pastGrace} | past ${selfGrace === null ? "self n/a" : (Number(selfGrace) / 60) + "m " + pastSelf}`);
  }

  console.log("\n  COVERAGE");
  cov.forEach(c => console.log("    " + c));
  const members = [...new Set(stuck.map(r => lc(r.member)))];
  console.log(`    ${stuck.length} parked positions, ${members.length} unique members, across ${mxAddrs.length} matrices`);

  // ── the log sweep ────────────────────────────────────────────────────────────────────
  let from;
  if (process.env.FROM_BLOCK) {
    from = Number(process.env.FROM_BLOCK);
    console.log(`\n  SCAN WINDOW  : ${from} -> ${head}   (FROM_BLOCK given)`);
  } else {
    try { from = await findDeployBlock(provider, A.deployedAt); }
    catch (e) {
      PROBLEM("deploy-block search", e);
      console.log("  ABORT: cannot locate the deploy block. Pass FROM_BLOCK= and re-run.");
      return;
    }
    console.log(`\n  SCAN WINDOW  : ${from} -> ${head}   (deploy block found by timestamp search)`);
  }

  const CHUNK = Number(process.env.CHUNK || 9000);
  const inc    = new Map();    // member -> [{amount, tier, block}]   THE LEDGER
  const rep    = new Map();    // member -> total repaid               THE LEDGER
  const types  = new Map();    // member -> [rescueType]               matrix event, colour only
  let scanned = 0;

  // (a) THE LEDGER — one address, so this is cheap and cannot miss a caller.
  for (let lo = from; lo <= head; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK - 1, head);
    const r = await read(`getLogs SF ${lo}-${hi}`,
      () => provider.getLogs({ address: A.stabilityFund, fromBlock: lo, toBlock: hi,
                               topics: [[T_INC, T_REP]] }), 3);
    if (!r.ok) continue;
    for (const lg of r.v) {
      let p; try { p = sfIface.parseLog(lg); } catch { continue; }
      const who = lc(p.args.member);
      if (p.name === "MemberDebtIncreased") {
        if (!inc.has(who)) inc.set(who, []);
        inc.get(who).push({ amount: p.args.amount, tier: Number(p.args.tier), block: lg.blockNumber });
      } else {
        rep.set(who, (rep.get(who) || 0n) + p.args.amount);
      }
    }
    scanned = hi;
  }
  const totalInc = [...inc.values()].reduce((n, v) => n + v.length, 0);
  console.log(`  ledger: ${totalInc} debt bookings across ${inc.size} members, scanned to ${scanned}`);

  // (b) THE COLOUR — matrix RescueLoanIssued, for `rescueType` only. Run 1 proved this
  // RPC takes an address array; if a future one does not, the whole window is re-walked
  // per matrix rather than left half-scanned. The switch is announced, never silent.
  const scanTypes = async (perMatrix) => {
    types.clear();
    let ok = true;
    for (let lo = from; lo <= head && ok; lo += CHUNK) {
      const hi = Math.min(lo + CHUNK - 1, head);
      const targets = perMatrix ? mxAddrs : [mxAddrs];
      for (const tgt of targets) {
        const r = await read(`getLogs matrices ${lo}-${hi}`,
          () => provider.getLogs({ address: tgt, fromBlock: lo, toBlock: hi, topics: [T_LOAN] }), 3);
        if (!r.ok) { if (!perMatrix) { ok = false; break; } else continue; }
        for (const lg of r.v) {
          let p; try { p = mxIface.parseLog(lg); } catch { continue; }
          const who = lc(p.args.member);
          if (!types.has(who)) types.set(who, []);
          types.get(who).push(p.args.rescueType);
        }
      }
    }
    return ok;
  };
  if (!(await scanTypes(false))) {
    console.log("  ⚠ this RPC will not take an address array. Re-walking the whole window");
    console.log("    per matrix so no rescueType is missed.");
    await scanTypes(true);
  }

  // ── SELFTEST 1: the planted positive — 35.6's treadmill wallet ───────────────────────
  // ⛔ CANARY RE-PLANTED 2026-08-30 (session 52), closing handoff 51.4.
  //    WAS 0xA9B019e7455618BeC38451619B3b3893ed106617 — a wallet that borrowed on an
  //    OLDER deployment. On V8.50 it can never fire, so SELFTEST 1 printed "the ledger
  //    scan is blind — STOP HERE" while the scan was in fact finding 38 bookings. A
  //    canary that cannot fire on the chain under test is worse than no canary: it
  //    reports a false negative with full confidence.
  //    NOW 0x762d09ef… — traced end to end on V8.50 (Telegram heartbeat -> keeper_state
  //    -> on-chain SF ledger), $3.01 in exactly 1 event at T1, and re-confirmed live by
  //    scripts/diag_rescue_seat_outcome.js at block 46177592.
  const PROBE = lc(process.env.PROBE || "0x762d09ef3a23cf31382a96f19710d8c5f0ad762f");
  if (process.env.SELFTEST !== "0") {
    console.log("\n  SELFTEST 1 — planted positive " + PROBE.slice(0, 10));
    const n = (inc.get(PROBE) || []).length;
    const tl = types.get(PROBE) || [];
    const byType = {};
    tl.forEach(t => { byType[t] = (byType[t] || 0) + 1; });
    if (n === 0) {
      console.log("  ⛔ ZERO debt bookings for the canary. It borrowed $3.01 on V8.50 in one");
      console.log("     event, confirmed on the SF ledger. If this scan cannot see that, it is");
      console.log("     blind, or ADDRESSES_FILE/FROM_BLOCK point off this deployment — STOP HERE.");
    } else {
      console.log(`  ✅ ${n} debt bookings on the ledger; matrix events type them as ` +
                  `${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(", ") || "(none seen)"}.`);
      console.log(`     EXPECTED for this canary: exactly 1 booking totalling $3.01 at T1.`);
      console.log(`     A DIFFERENT count is a finding, not noise — it means either this scan`);
      console.log(`     or the seat-outcome instrument is wrong, and they must be reconciled`);
      console.log(`     before either total is quoted.`);
    }
  }

  // ── SELFTEST 2: reconciliation against the ledger's own arithmetic ───────────────────
  console.log("\n  SELFTEST 2 — reconciliation: SF increases - SF repayments = live debt");
  let recOK = 0, recBad = 0, recUnknown = 0;
  const liveDebt = new Map();
  for (const m of members) {
    const d = await read(`memberDebtOf(${m.slice(0, 10)})`, () => sf.memberDebtOf(m, at()));
    if (!d.ok) { recUnknown++; continue; }
    liveDebt.set(m, d.v);
    const lent = (inc.get(m) || []).reduce((s, l) => s + l.amount, 0n);
    const back = rep.get(m) || 0n;
    const derived = lent > back ? lent - back : 0n;
    if (derived === d.v) recOK++;
    else {
      recBad++;
      console.log(`    ⛔ ${m.slice(0, 10)}  events ${usd(derived)} (booked ${usd(lent)} - repaid ${usd(back)}) vs chain ${usd(d.v)}`);
    }
  }
  console.log(`    ${recOK} reconcile | ${recBad} DISAGREE | ${recUnknown} unreadable`);

  // The invariant the contract states about itself (StabilityFund:736).
  const tL = await read("totalRescueLoaned()", () => sf.totalRescueLoaned(at()));
  const tR = await read("totalRescueRepaid()", () => sf.totalRescueRepaid(at()));
  if (tL.ok && tR.ok) {
    const net = tL.v > tR.v ? tL.v - tR.v : 0n;
    console.log(`    GLOBAL: loaned ${usd(tL.v)} - repaid ${usd(tR.v)} = ${usd(net)} outstanding across ALL members`);
    console.log(`            (this sweep's ${members.length} stuck members are a subset of that book)`);
  }

  const CENSUS = recBad === 0 && recUnknown === 0;
  if (!CENSUS) {
    console.log("    ⛔ NOT A CENSUS. Something moves member debt that neither SF event records.");
    console.log("       Counts below are a LOWER BOUND and the verdict is withheld.");
  } else {
    console.log("    ✅ Every stuck member reconciles to the cent against the ledger's own");
    console.log("       events. The counts below are complete.");
  }

  // ── the table ────────────────────────────────────────────────────────────────────────
  console.log(`\n  STUCK MEMBERS — WHAT THEY BORROWED, WHAT CAME BACK, AND WHAT THE CEILING ALLOWS`);
  console.log("  " + "-".repeat(118));
  console.log("  member      matrix         age    loans  booked   repaid   net debt  ceiling  over by  clawbk  eligible");
  const rows = [];
  for (const r of stuck.sort((a, b) => Number(b.ageDays) - Number(a.ageDays))) {
    const m    = lc(r.member);
    const ls   = inc.get(m) || [];
    const lent = ls.reduce((s, l) => s + l.amount, 0n);
    const back = rep.get(m) || 0n;
    const debt = liveDebt.has(m) ? liveDebt.get(m) : null;
    const c    = ceilingOf.get(r.tier);
    const over = (c && debt !== null) ? (debt > c.ceil ? debt - c.ceil : 0n) : null;
    const idx  = Number(r.tier.slice(1)) - 1;
    const el   = await read(`loanEligible(${m.slice(0, 10)}, ${idx})`, () => sf.loanEligible(m, idx, at()));
    const cb   = await read(`clawbackBpsFor(${m.slice(0, 10)})`, () => sf.clawbackBpsFor(m, at()));
    console.log(
      `  ${m.slice(0, 10)}  ${r.matrix.padEnd(13)} ${String(r.ageDays).padStart(5)}d ` +
      `${String(ls.length).padStart(5)}  ${usd(lent).padStart(8)} ${usd(back).padStart(8)} ` +
      `${usd(debt).padStart(9)} ${c ? usd(c.ceil).padStart(8) : "       ?"} ${usd(over).padStart(8)}  ` +
      `${cb.ok ? String(Number(cb.v) / 100) + "%" : "?"}`.padEnd(8) +
      `  ${el.ok ? (el.v ? "YES" : "no") : "?"}`
    );
    rows.push({ ...r, loanCount: ls.length, booked: lent, repaid: back, debt,
                ceiling: c ? c.ceil : null, overBy: over,
                clawbackBps: cb.ok ? Number(cb.v) : null,
                loanEligible: el.ok ? el.v : null,
                types: (types.get(m) || []).join("|") });
  }

  // ── the shape ────────────────────────────────────────────────────────────────────────
  console.log("\n  THE DISTRIBUTION — 35.7's CLAIM IS ABOUT THIS SHAPE");
  const perMember = new Map();
  for (const r of rows) perMember.set(lc(r.member), r.loanCount);
  const hist = new Map();
  for (const n of perMember.values()) hist.set(n, (hist.get(n) || 0) + 1);
  for (const k of [...hist.keys()].sort((a, b) => a - b)) {
    console.log(`    ${String(k).padStart(3)} loan(s): ${hist.get(k)} member(s)`);
  }

  // ── THE RATCHET — the thing the count alone cannot show ──────────────────────────────
  // A ceiling on NET debt is only a ceiling on rescue COUNT if none of the loan comes
  // back. Every one of these members has repaid something, so what matters is how much
  // net debt each lap leaves behind, and how many laps that buys before the gate shuts.
  console.log("\n  THE RATCHET — NET DEBT ADDED PER LOAN, AND HOW MANY LAPS THE CEILING BUYS");
  const uniq = [...perMember.keys()];
  let ratchets = [];
  for (const m of uniq) {
    const r = rows.find(x => lc(x.member) === m);
    if (!r || r.loanCount === 0 || r.debt === null) continue;
    const perLoanNet = Number(r.debt) / r.loanCount / 1e6;
    const repayRate  = Number(r.booked) === 0 ? 0 : Number(r.repaid) / Number(r.booked);
    ratchets.push({ m, perLoanNet, repayRate, loans: r.loanCount,
                    laps: r.ceiling ? Number(r.ceiling) / 1e6 / perLoanNet : null });
  }
  if (ratchets.length) {
    const avgNet = ratchets.reduce((s, x) => s + x.perLoanNet, 0) / ratchets.length;
    const avgRep = ratchets.reduce((s, x) => s + x.repayRate, 0) / ratchets.length;
    const laps   = ratchets.filter(x => x.laps !== null).map(x => x.laps).sort((a, b) => a - b);
    console.log(`    mean net debt left behind per loan : $${avgNet.toFixed(2)}`);
    console.log(`    mean share of each loan repaid     : ${(avgRep * 100).toFixed(1)}%`);
    if (laps.length) {
      console.log(`    loans the ceiling affords at that rate: ` +
                  `${laps[0].toFixed(1)} (min) .. ${laps[laps.length - 1].toFixed(1)} (max), ` +
                  `median ${laps[Math.floor(laps.length / 2)].toFixed(1)}`);
    }
    console.log("    ⇒ The ceiling caps NET debt, and each lap leaves a little behind. So the");
    console.log("      number of rescues it affords is not fixed — it is the ceiling divided by");
    console.log("      whatever the loop fails to repay each time round.");
  }

  const tot      = perMember.size;
  const oneOrTwo = [...perMember.values()].filter(n => n === 1 || n === 2).length;
  const three    = [...perMember.values()].filter(n => n >= 3).length;
  const blocked  = rows.filter(r => r.loanEligible === false).length;

  console.log(`\n  VERDICT ON 35.7 (basis: ${process.env.ADDRESSES_FILE}, snapshot block ${SNAP ?? "head"}, blocks ${from}-${scanned}, ${ts()})`);
  if (tot === 0) {
    console.log("    NO STUCK MEMBERS FOUND. Compare against 35.1's 41 positions before concluding.");
  } else {
    console.log(`    ${oneOrTwo}/${tot} members took one or two loans; ${three}/${tot} took three or more.`);
    console.log(`    ${blocked}/${rows.length} positions are refused by the live gate right now.`);
    if (three > 0) {
      console.log("    ⛔ 35.7's COUNT IS WRONG. 'One or two rescues and out' does not describe this");
      console.log("       population — and because these counts are a floor, more loans can only");
      console.log("       make that worse, never better. That half of 35.7 is refuted whether or");
      console.log("       not the reconciliation passed.");
      console.log("    ▶ 35.7's OTHER HALF — 'the loop minted the debt, not borrowing behaviour' —");
      console.log("       is what the ratchet block above measures. Read it, not the count.");
    } else if (!CENSUS) {
      console.log("    WITHHELD — the count fits 35.7, but selftest 2 failed and the counts are a");
      console.log("    floor, so a fitting count is not evidence. Fix the sweep first.");
    } else {
      console.log("    ✅ 35.7 HOLDS ON THE COUNT. Nobody here is a repeat borrower.");
    }
  }

  // ── CSV ──────────────────────────────────────────────────────────────────────────────
  const out = process.env.CSV || path.join(__dirname, "..", "logs",
    `rescue_loan_counts_${ts().replace(/[:.]/g, "-")}.csv`);
  const num = v => (v === null || v === undefined) ? "" : (Number(v) / 1e6).toFixed(2);
  const csv = ["member,tier,matrix,ageDays,loanCount,bookedUSD,repaidUSD,netDebtUSD,ceilingUSD,overByUSD,clawbackBps,loanEligible,rescueTypes"];
  for (const r of rows) {
    csv.push([r.member, r.tier, r.matrix, r.ageDays, r.loanCount, num(r.booked), num(r.repaid),
              num(r.debt), num(r.ceiling), num(r.overBy), r.clawbackBps ?? "",
              r.loanEligible === null ? "" : r.loanEligible, r.types].join(","));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, csv.join("\n"));
  console.log(`\n  CSV: ${out}`);

  console.log(`\n  PROBLEMS: ${problems.length}`);
  problems.forEach(p => console.log("    - " + p));
  if (problems.length) {
    console.log("  ⚠ A PROBLEM means a read did not answer. Rows resting on it read '?' and");
    console.log("    must not be quoted as measured.");
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
