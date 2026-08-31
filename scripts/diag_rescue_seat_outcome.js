// diag_rescue_seat_outcome.js — READ-ONLY. No transactions are ever sent.
//
// WHY THIS EXISTS (session 52, 2026-08-30)
// ----------------------------------------
// The owner's rule on rescue exposure is: "nobody should accrue SF debt for a seat that
// may not exist." Session 51 measured the SIZE of the book ($52.75 across 36 members,
// agreed to the cent by two instruments) but never measured the thing the rule is
// actually about: how many of those advances BOUGHT A SEAT.
//
// A borrower who took an advance and is STILL SITTING IN THE PARKED QUEUE, with a
// parkedAt older than their own last debt booking, never left the queue — that advance
// bought nothing. That is the harm, stated as a measurable predicate.
//
// It also settles two carried-forward questions in the same pass:
//
//   51.3  STANDING PARKED vs PARK EVENTS. getParkedCount()/getParkedMember() is a
//         QUEUE DEPTH at one pinned block. The "1638 funding parks" figure is a count
//         of MemberParked LOGS OVER A BLOCK RANGE — a FLOW. They are different
//         quantities and can never have contradicted each other. This script prints the
//         standing census per matrix so the two are never conflated again.
//
//   51.5  THERE ARE THREE GRACE CLOCKS, NOT ONE, and the sibling instrument
//         (diag_rescue_loan_counts.js:287) judges every parked member against the 24h
//         one. MatrixKeeperLib._checkParked:753 does NOT:
//             age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
//         so a SELF-FUNDED member is actionable after selfFundedGracePeriod (5 minutes,
//         MatrixKeeper.sol:416 — a race guard, explicitly not a grace period) while a
//         LOAN-BEARING one waits parkedGracePeriod (24h, :394). Judging everyone by 24h
//         UNDERSTATES what the work queue considers actionable. This script reads BOTH
//         getters from chain and reports both counts, never one blended number.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not compute sfShare per member. That lives inside _triageParked and is not
// readable off-chain without reimplementing it, and a reimplementation would be a
// hypothesis. So the two clock counts are reported as BOUNDS, clearly labelled, rather
// than as one "actionable" number that would be invented.
//
// SELFTESTS — AND WHY THEY CANNOT BE VACUOUS THIS TIME (51.4)
// -----------------------------------------------------------
// diag_rescue_loan_counts.js's planted positive (0xa9b019e7) borrowed on an OLDER
// deployment, so it can never fire on V8.50: the run printed "the ledger scan is blind"
// while the scan was in fact working. Its second selftest reported "0 DISAGREE" over
// ZERO subjects and called it a pass.
//
// The canary here is 0x762d09ef…762f, which borrowed $3.01 ON V8.50 — the wallet from
// the owner's own keeper heartbeat, traced end to end (Telegram alert -> keeper_state
// -> on-chain SF ledger). It is matched by PREFIX AND SUFFIX AND AMOUNT AND EVENT COUNT,
// all four known independently of this run, so it is a real positive control and not a
// value this script derived from its own scan.
//
// Every selftest here prints VACUOUS, never PASS, when it had zero subjects.
//
// USAGE
//   ADDRESSES_FILE=deployed_addresses_v8_50.json FROM_BLOCK=45976470 \
//     npx hardhat run scripts/diag_rescue_seat_outcome.js --network baseSepolia
//
//   ADDRESSES_FILE   REQUIRED. No default — see 51.2: direct_keeper.js:25 defaults to a
//                    DEAD deployment and would silently measure the wrong chain.
//   FROM_BLOCK       optional; deploy block is found by timestamp search if omitted.
//   TIERS            optional, e.g. "T1,T2" — default every tier in the addresses file.
//   CHUNK            optional eth_getLogs window, default 9000.
//   SNAPSHOT=0       follow the head instead of pinning (ages and counts will smear).
//   SELFTEST=0       skip the selftests (do not do this in a run you intend to quote).

const path = require("path");
const fs   = require("fs");
const { ethers } = require("hardhat");

// STRESS_CSV — optional. The output of CryptoNova-Keepers/probe_pool_membership.js,
// run on the VPS (the derivation needs FILL_MNEMONIC and that phrase never leaves the
// box). Columns: index,address,highestTier,isMember. Supplying it splits every figure
// below into SYNTHETIC (a derived harness wallet) and ORGANIC (everything else).
//
// ⚠ "organic" here means "not in the supplied ranges". Earlier harness runs used other
// index ranges, so the organic side is an UPPER BOUND, not a headcount. It is labelled
// that way in the output and must stay labelled that way in anything quoted from it.
const STRESS = new Set();
if (process.env.STRESS_CSV) {
  const raw = fs.readFileSync(process.env.STRESS_CSV, "utf8").split(/\r?\n/);
  for (const line of raw.slice(1)) {
    const c = line.split(",");
    if (c.length >= 2 && /^0x[0-9a-fA-F]{40}$/.test(c[1].trim())) STRESS.add(c[1].trim().toLowerCase());
  }
}
const cohortOf = a => STRESS.size === 0 ? "?" : (STRESS.has(a) ? "synthetic" : "organic");

if (!process.env.ADDRESSES_FILE) {
  console.log("REFUSING TO RUN: ADDRESSES_FILE is not set.");
  console.log("  There is no safe default. A wrong addresses file measures a dead chain");
  console.log("  and reports it as fact — see handoff 51.2.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_50.json FROM_BLOCK=45976470 \\");
  console.log("    npx hardhat run scripts/diag_rescue_seat_outcome.js --network baseSepolia");
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
const SF_EV_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];
const SF_ABI = [
  "function memberDebtOf(address) view returns (uint256)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
  "function totalBalance() view returns (uint256)",
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
const isNoState = m => /missing trie node|header not found|state (is )?not available|no state|pruned/i.test(m || "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let SNAP = null;
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
      if (!isTransport(msg)) break;
      await sleep(400 * (i + 1));
    }
  }
  PROBLEM(label, last);
  return { ok: false, v: null };
}

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

// The canary. All four facts are known INDEPENDENTLY of this run, from the owner's
// keeper heartbeat and the session-51 SF ledger read. Override only with cause.
const CANARY_PREFIX = lc(process.env.PROBE_PREFIX || "0x762d09ef");
const CANARY_SUFFIX = lc(process.env.PROBE_SUFFIX || "762f");
const CANARY_USD    = process.env.PROBE_USD    || "3.01";
const CANARY_EVENTS = Number(process.env.PROBE_EVENTS || 1);

async function main() {
  console.log(`[${ts()}] diag_rescue_seat_outcome — READ-ONLY, no transactions sent`);
  console.log(`  addresses   : ${process.env.ADDRESSES_FILE}`);
  console.log(`  network     : ${A.network || "?"}   deployed ${A.deployedAt || "?"}`);
  console.log(`  cohort file : ${process.env.STRESS_CSV
      ? `${process.env.STRESS_CSV} — ${STRESS.size} harness addresses loaded`
      : "none given — figures will NOT be split organic/synthetic"}`);

  const provider = ethers.provider;
  const sfIface  = new ethers.Interface(SF_EV_ABI);
  const T_INC    = sfIface.getEvent("MemberDebtIncreased").topicHash;
  const T_REP    = sfIface.getEvent("MemberDebtRepaid").topicHash;

  const head = await provider.getBlockNumber();
  let snapTime = BigInt(Math.floor(Date.now() / 1000));
  if (process.env.SNAPSHOT !== "0") {
    SNAP = head;
    const b = await provider.getBlock(SNAP);
    if (b) snapTime = BigInt(b.timestamp);
    console.log(`  snapshot    : block ${SNAP} (${new Date(Number(snapTime) * 1000).toISOString()})`);
  } else {
    console.log(`  snapshot    : DISABLED — reads follow the head; the census will smear.`);
  }

  // ── BOTH CLOCKS, FROM CHAIN (51.5) ───────────────────────────────────────────────────
  const keeper = await ethers.getContractAt(KEEPER_ABI, A.matrixKeeper);
  const g24 = await read("parkedGracePeriod()",     () => keeper.parkedGracePeriod(at()));
  const g5  = await read("selfFundedGracePeriod()", () => keeper.selfFundedGracePeriod(at()));
  if (!g24.ok) {
    if (snapDead) console.log("  ABORT: node will not serve state at the snapshot block. Re-run SNAPSHOT=0 or use an archive RPC.");
    else          console.log("  ABORT: parkedGracePeriod unreadable — every grace verdict would be invented.");
    return;
  }
  const loanGrace = g24.v;
  const selfGrace = g5.ok ? g5.v : null;
  console.log(`  loan grace  : ${loanGrace}s (${(Number(loanGrace)/3600).toFixed(1)}h)  parkedGracePeriod, from chain`);
  if (selfGrace === null) {
    console.log(`  self grace  : UNREADABLE — the 5-minute branch cannot be applied; the`);
    console.log(`                self-funded bound below is therefore NOT computed.`);
  } else {
    console.log(`  self grace  : ${selfGrace}s (${(Number(selfGrace)/60).toFixed(0)}m)  selfFundedGracePeriod, from chain`);
  }

  // ── 1. THE STANDING PARKED CENSUS — a QUEUE DEPTH, not a flow (51.3) ─────────────────
  const tierKeys = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);
  const tiers    = tierKeys.length ? tierKeys : Object.keys(A.tiers);

  const parked = new Map();          // member(lc) -> [ {tier, matrix, parkedAt, ageS} ]  ALL of them
  let positionsTotal = 0;            // POSITIONS, not members — a member can hold two
  const perTier = [];

  console.log("\n  1. STANDING PARKED CENSUS (getParkedCount per matrix, pinned block)");
  for (const tk of tiers) {
    const t = A.tiers[tk];
    if (!t || !t.pm) { PROBLEM(`${tk} pair manager absent from addresses file — TIER SKIPPED`); continue; }
    const pm = await ethers.getContractAt(PM_ABI, t.pm);
    const pc = await read(`${tk} pairCount()`, () => pm.pairCount(at()));
    if (!pc.ok) { perTier.push(`${tk}: pairCount UNREADABLE — TIER NOT SWEPT`); continue; }

    let seenMx = 0, standing = 0, pastLoan = 0, pastSelf = 0;
    for (let i = 0n; i < pc.v; i++) {
      const pr = await read(`${tk} getPairAt(${i})`, () => pm.getPairAt(i, at()));
      if (!pr.ok) continue;
      for (let j = 0; j < 2; j++) {
        const addr = pr.v[j];
        if (addr === ethers.ZeroAddress) continue;
        const label = `${tk}.${i + 1n} ${j ? "MatB" : "MatA"}`;
        const mx  = await ethers.getContractAt(MX_ABI, addr);
        const cnt = await read(`${label} getParkedCount()`, () => mx.getParkedCount(at()));
        if (!cnt.ok) continue;
        seenMx++;
        if (cnt.v === 0n) continue;
        for (let k = 0n; k < cnt.v; k++) {
          const mr = await read(`${label} getParkedMember(${k})`, () => mx.getParkedMember(k, at()));
          if (!mr.ok) continue;
          const m  = mr.v;
          const pa = await read(`${label} parkedAt`, () => mx.parkedAt(m, at()));
          if (!pa.ok || pa.v === 0n) continue;
          const ageS = snapTime - pa.v;
          standing++; positionsTotal++;
          if (ageS >= loanGrace) pastLoan++;
          if (selfGrace !== null && ageS >= selfGrace) pastSelf++;
          const key = lc(m);
          if (!parked.has(key)) parked.set(key, []);
          parked.get(key).push({ tier: tk, matrix: label, parkedAt: pa.v, ageS });
        }
      }
    }
    const selfCol = selfGrace === null ? "n/a" : String(pastSelf);
    perTier.push(`${tk.padEnd(4)} matrices ${String(seenMx).padStart(3)} | STANDING PARKED ${String(standing).padStart(4)} | past 24h ${String(pastLoan).padStart(4)} | past ${selfGrace === null ? "self" : (Number(selfGrace)/60)+"m"} ${selfCol.padStart(4)}`);
  }
  perTier.forEach(l => console.log("    " + l));
  const standingTotal = parked.size;
  const multi = [...parked.values()].filter(v => v.length > 1).length;
  console.log(`    ── ${positionsTotal} standing parked POSITIONS held by ${standingTotal} DISTINCT MEMBERS at block ${SNAP ?? "head"}`);
  console.log(`       ${multi} of those members hold MORE THAN ONE position — which is why the seat`);
  console.log(`       verdict below is taken over ALL of a member's parks, not one of them.`);
  console.log(`       (positions != members: one member can be parked in more than one matrix.`);
  console.log(`        51.3's "410 parked" was a POSITION count — compare like with like.)`);
  console.log(`    ⛔ This is a QUEUE DEPTH. The "1638 funding parks" figure counts MemberParked`);
  console.log(`       LOGS OVER A RANGE — a FLOW. They are different quantities; neither`);
  console.log(`       contradicts the other, and "0 stuck" only ever meant "none past grace".`);

  // ── 2. THE LEDGER ────────────────────────────────────────────────────────────────────
  let from;
  if (process.env.FROM_BLOCK) {
    from = Number(process.env.FROM_BLOCK);
    console.log(`\n  2. LEDGER SCAN WINDOW: ${from} -> ${head}   (FROM_BLOCK given)`);
  } else {
    try { from = await findDeployBlock(provider, A.deployedAt); }
    catch (e) {
      PROBLEM("deploy-block search", e);
      console.log("  ABORT: cannot locate the deploy block. Pass FROM_BLOCK= and re-run.");
      return;
    }
    console.log(`\n  2. LEDGER SCAN WINDOW: ${from} -> ${head}   (deploy block found by timestamp search)`);
  }

  const CHUNK = Number(process.env.CHUNK || 9000);
  const inc = new Map();     // member -> [{amount, tier, block}]
  const rep = new Map();     // member -> total repaid
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
  }
  const totalInc = [...inc.values()].reduce((n, v) => n + v.length, 0);
  console.log(`     ${totalInc} debt bookings across ${inc.size} borrowers`);

  // booking timestamps, so "still parked since before the advance" is decidable
  const blockTime = new Map();
  const wanted = [...new Set([...inc.values()].flat().map(b => b.block))];
  for (const bn of wanted) {
    const b = await read(`getBlock(${bn})`, () => provider.getBlock(bn), 3);
    if (b.ok && b.v) blockTime.set(bn, BigInt(b.v.timestamp));
  }

  // ── SELFTEST 1: the planted positive, matched on four independently-known facts ──────
  if (process.env.SELFTEST !== "0") {
    console.log(`\n  SELFTEST 1 — planted positive ${CANARY_PREFIX}…${CANARY_SUFFIX}, expect ${CANARY_EVENTS} event(s) totalling $${CANARY_USD}`);
    const hits = [...inc.keys()].filter(a => a.startsWith(CANARY_PREFIX) && a.endsWith(CANARY_SUFFIX));
    if (hits.length === 0) {
      console.log("    FAIL — the canary is absent from the ledger scan.");
      console.log("    Either the scan is blind, or ADDRESSES_FILE/FROM_BLOCK point somewhere");
      console.log("    the canary never borrowed. STOP HERE; do not quote anything below.");
      return;
    }
    if (hits.length > 1) { console.log(`    FAIL — ${hits.length} addresses match the canary pattern; it is not unique. STOP.`); return; }
    const who = hits[0];
    const evs = inc.get(who);
    const sum = evs.reduce((n, e) => n + e.amount, 0n);
    const okN = evs.length === CANARY_EVENTS;
    const okV = (Number(sum) / 1e6).toFixed(2) === Number(CANARY_USD).toFixed(2);
    console.log(`    canary resolves to ${who}`);
    console.log(`    events ${evs.length} (expect ${CANARY_EVENTS}) ${okN ? "OK" : "DISAGREE"} | total ${usd(sum)} (expect $${CANARY_USD}) ${okV ? "OK" : "DISAGREE"}`);
    if (!okN || !okV) {
      console.log("    ⛔ The scan RUNS but DISAGREES with an independently known fact.");
      console.log("       That is a finding, not a warning. Do not quote the totals below");
      console.log("       until the disagreement is explained.");
    } else {
      console.log("    PASS — over a real subject, on this deployment.");
      console.log(`    ▶ FULL CANARY ADDRESS FOR RE-PLANTING diag_rescue_loan_counts.js: ${who}`);
    }
  }

  // ── 3. DID THE ADVANCE BUY A SEAT? ───────────────────────────────────────────────────
  console.log("\n  3. SEAT OUTCOME PER BORROWER  (the owner's rule, made measurable)");
  const sf = await ethers.getContractAt(SF_ABI, A.stabilityFund);
  const boughtNothing = [], reParked = [], notParked = [];
  let liveSum = 0n;

  for (const [who, evs] of inc) {
    const lastBlock = Math.max(...evs.map(e => e.block));
    const lastTs    = blockTime.get(lastBlock) ?? null;
    const loaned    = evs.reduce((n, e) => n + e.amount, 0n);
    const repaid    = rep.get(who) || 0n;
    const d = await read(`memberDebtOf(${who.slice(0,10)})`, () => sf.memberDebtOf(who, at()));
    if (d.ok) liveSum += d.v;
    const rec = { who, cohort: cohortOf(who), evs: evs.length, loaned, repaid, live: d.ok ? d.v : null,
                  tier: evs[evs.length - 1].tier, lastBlock, lastTs };
    const ps = parked.get(who);
    if (!ps || ps.length === 0) { notParked.push(rec); continue; }
    rec.positions = ps.length;
    if (lastTs === null) {
      // Cannot decide without the booking time. Say so; never default into a verdict.
      const e = ps.slice().sort((a, b) => Number(a.parkedAt - b.parkedAt))[0];
      rec.matrix = e.matrix; rec.ageDays = (Number(e.ageS) / 86400).toFixed(2);
      rec.why = "booking timestamp unreadable — UNCLASSIFIED"; reParked.push(rec); continue;
    }
    // A park that was ALREADY OPEN when the advance was booked, and is STILL open,
    // is a park the advance did not clear. That is the predicate — evaluated over
    // EVERY position the member holds, because 444 positions sit on 281 members and
    // picking one by scan order decided this verdict by accident in the first cut.
    // Which park to judge against. A member here typically holds 2-4 positions and
    // several loans, so "earliest park vs LAST loan" is a badly-posed question and was
    // reporting a tier mismatch on 90 rows out of 90 — an artifact of the question,
    // not a finding. Compare against the set of tiers this member actually borrowed at
    // (MemberDebtIncreased.tier is 0-BASED: tier < MAX_TIERS, tierEntryFees[0] = T1),
    // and prefer a park in a tier they really borrowed in.
    const loanTiers = new Set(evs.map(e => e.tier));
    rec.loanTiers = [...loanTiers].sort((x, y) => x - y).map(t => "T" + (t + 1)).join("/");
    const byAge = (a, b) => Number(a.parkedAt - b.parkedAt);
    const predating = ps.filter(x => x.parkedAt <= lastTs).sort(byAge);
    const tierOfPark = x => Number(x.tier.slice(1)) - 1;
    const chosen = predating.find(x => loanTiers.has(tierOfPark(x)))
                || predating[0]
                || ps.slice().sort(byAge)[0];
    rec.matrix   = chosen.matrix;
    rec.ageDays  = (Number(chosen.ageS) / 86400).toFixed(2);
    // Gap between the advance and the park it is being judged against. A gap of ~0
    // means park and loan landed in the same block — the owner's cycle-out model —
    // and that is NOT a wasted advance, so it is reported, never silently binned.
    rec.gapH     = (Number(chosen.parkedAt - lastTs) / 3600).toFixed(2);
    rec.tierMatch = loanTiers.has(tierOfPark(chosen));
    if (predating.length) boughtNothing.push(rec); else reParked.push(rec);
  }

  console.log(`\n    A. ADVANCE BOUGHT NO SEAT — still in the parked queue, parked BEFORE their own`);
  console.log(`       last debt booking, so they never left it:  ${boughtNothing.length} of ${inc.size} borrowers`);
  if (boughtNothing.length === 0) {
    console.log(`       (none — every advance on this deployment moved its member out of the queue)`);
  } else {
    for (const r of boughtNothing.sort((a,b) => Number(b.loaned - a.loaned))) {
      console.log(`       ${r.who}  ${r.matrix.padEnd(12)} loaned ${usd(r.loaned).padStart(8)}  live ${usd(r.live).padStart(8)}  parked ${r.ageDays}d  ${r.evs}ev  gap ${String(r.gapH).padStart(8)}h  ${r.positions} pos  borrowed ${r.loanTiers}${r.tierMatch ? "" : "  [parked in a tier they never borrowed in]"}`);
    }
  }
  console.log(`\n    B. RE-PARKED AFTER THE ADVANCE — the advance seated them; they parked again`);
  console.log(`       later, which is ordinary matrix churn, not a wasted advance:  ${reParked.length}`);
  for (const r of reParked.sort((a,b) => Number(b.loaned - a.loaned)).slice(0, 15)) {
    console.log(`       ${r.who}  ${(r.matrix||"?").padEnd(12)} loaned ${usd(r.loaned).padStart(8)}  live ${usd(r.live).padStart(8)}  parked ${r.ageDays||"?"}d${r.why ? "  ⚠ " + r.why : ""}`);
  }
  if (reParked.length > 15) console.log(`       … and ${reParked.length - 15} more`);
  console.log(`\n    C. NOT IN THE PARKED QUEUE AT ALL — seated or exited:  ${notParked.length}`);

  // ── 4. THE SPLIT — who is actually carrying this debt ────────────────────────────────
  if (STRESS.size > 0) {
    const all = [...boughtNothing, ...reParked, ...notParked];
    const sum = rs => rs.reduce((n, r) => n + (r.live || 0n), 0n);
    const org = all.filter(r => r.cohort === "organic");
    const syn = all.filter(r => r.cohort === "synthetic");
    const orgA = boughtNothing.filter(r => r.cohort === "organic");
    const synA = boughtNothing.filter(r => r.cohort === "synthetic");
    console.log("\n  4. ORGANIC vs SYNTHETIC — the number the exposure decision rests on");
    console.log(`     borrowers        organic ${String(org.length).padStart(4)} | synthetic ${String(syn.length).padStart(4)}`);
    console.log(`     LIVE DEBT HELD   organic ${usd(sum(org)).padStart(10)} | synthetic ${usd(sum(syn)).padStart(10)}`);
    console.log(`     bought no seat   organic ${String(orgA.length).padStart(4)} | synthetic ${String(synA.length).padStart(4)}`);
    console.log(`     ...their loans   organic ${usd(orgA.reduce((n,r)=>n+r.loaned,0n)).padStart(10)} | synthetic ${usd(synA.reduce((n,r)=>n+r.loaned,0n)).padStart(10)}`);
    const parkedOrg = [...parked.keys()].filter(m => cohortOf(m) === "organic").length;
    console.log(`     standing parked  organic ${String(parkedOrg).padStart(4)} | synthetic ${String(parked.size - parkedOrg).padStart(4)}  (distinct members)`);
    console.log(`     ⚠ ORGANIC IS AN UPPER BOUND — it means "not in the supplied harness ranges".`);
    console.log(`       Quote it as a bound. It is not a headcount of real people.`);
    if (org.length) {
      console.log(`\n     ORGANIC BORROWERS, largest live debt first:`);
      for (const r of org.sort((x, y) => Number((y.live||0n) - (x.live||0n))).slice(0, 20))
        console.log(`       ${r.who}  live ${usd(r.live).padStart(9)}  loaned ${usd(r.loaned).padStart(9)}  ${r.evs}ev  ${r.matrix ? r.matrix.padEnd(12) : "not parked ".padEnd(12)}${boughtNothing.includes(r) ? " NO SEAT" : ""}`);
      if (org.length > 20) console.log(`       … and ${org.length - 20} more`);
    }
  } else {
    console.log("\n  4. ORGANIC vs SYNTHETIC — SKIPPED, no STRESS_CSV given.");
    console.log("     Without it the book cannot be attributed and no exposure decision should");
    console.log("     be taken from the totals above.");
  }

  // ── SELFTEST 2: the live/event tie, and it says VACUOUS when it has no subjects ───────
  if (process.env.SELFTEST !== "0") {
    console.log("\n  SELFTEST 2 — live memberDebtOf() vs the SF's own counters");
    const tl = await read("totalRescueLoaned()", () => sf.totalRescueLoaned(at()));
    const tr = await read("totalRescueRepaid()", () => sf.totalRescueRepaid(at()));
    if (inc.size === 0) {
      console.log("    VACUOUS — zero borrowers in the window. This is NOT a pass.");
    } else if (!tl.ok || !tr.ok) {
      console.log("    INCONCLUSIVE — SF counters unreadable; no tie can be asserted.");
    } else {
      const counters = tl.v - tr.v;
      const agree = counters === liveSum;
      console.log(`    subjects ${inc.size} borrowers`);
      console.log(`    live sum over borrowers : ${usd(liveSum)}`);
      console.log(`    SF counters loaned-repaid: ${usd(counters)}  (${usd(tl.v)} - ${usd(tr.v)})`);
      console.log(`    ${agree ? "PASS — event-derived and live-contract totals match to the cent." : "⛔ DISAGREE — that gap IS the finding. Do not average it away."}`);
    }
  }

  // ── VERDICT ──────────────────────────────────────────────────────────────────────────
  console.log("\n  VERDICT");
  console.log(`    standing parked members     : ${standingTotal}`);
  console.log(`    borrowers on this deployment: ${inc.size}   bookings ${totalInc}`);
  console.log(`    advances that bought no seat: ${boughtNothing.length}` +
              (inc.size ? `  (${(100 * boughtNothing.length / inc.size).toFixed(1)}% of borrowers)` : ""));
  const sameBlock = boughtNothing.filter(r => Math.abs(Number(r.gapH)) < 0.02).length;
  const wasted = boughtNothing.reduce((n, r) => n + r.loaned, 0n);
  console.log(`    value of those advances     : ${usd(wasted)}`);
  console.log(`    of which park+loan same block: ${sameBlock}   <- NOT wasted; the park and the`);
  console.log(`                                   advance landed together, which is the designed`);
  console.log(`                                   cycle-out sequence, not a failed rescue.`);
  console.log(`\n    ⚠ "bought no seat" is measured as STILL PARKED, parked before their own last`);
  console.log(`      booking. A member rescued into a seat who later cycled out and re-parked is`);
  console.log(`      in group B, not A. The discriminator is the parkedAt timestamp, not a guess.`);

  if (problems.length) {
    console.log(`\n  ${problems.length} PROBLEM(S) — coverage was not complete, so treat every count as a FLOOR:`);
    problems.slice(0, 20).forEach(p => console.log("    " + p));
    if (problems.length > 20) console.log(`    … and ${problems.length - 20} more`);
  } else {
    console.log("\n  no read problems — coverage complete.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
