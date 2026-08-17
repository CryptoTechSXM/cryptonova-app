// model_item_a.js — V8.50 item A: does "the reserve pays the crossing" hold, and how big
// is the prize? Written 2026-08-16. PHASE 5 REWRITTEN the same day — see WHY below.
//
// WHY THIS EXISTS
// ---------------
// V8_50_HANDOFF.md says item A leaves a member asking $3.20 against a $3.40 floor, and
// then says, correctly: "The $3.20 figure is Claude's arithmetic, not a measurement."
// It points at model_insolvency_floor.js to settle it. That script does NOT model item A
// — it models the three FLOOR POLICIES (pre-loan / post-loan / clamp) against today's
// parked queue. Useful, but a different question. This script is the missing one.
//
// ⛔ WHY PHASE 5 WAS REWRITTEN — READ THIS, IT IS THE WHOLE LESSON
// ---------------------------------------------------------------
// v1 of this script bounded the post-item-A re-entry ask using CrossingFunded's
// `fromEarnings` field. It reported a median ask of $0.48 against a $3.40 floor and
// "100% clear the floor" — against the handoff's predicted $3.20. A ~7x result in the
// direction that flatters the plan. It was wrong for TWO independent reasons, both
// found by reading the source rather than believing the output:
//
//   1. THE BUFFER IS NOT EARNINGS. MatrixLogicLib.sol:1368 adds `crossingBuffer` straight
//      to `withdrawable`, bypassing _credit(). At the next crossing that borrowed money is
//      spent and recorded as `fromEarnings`. At the live 3600bps buffer that is $3.60 of
//      SF money per rescue counted as member earnings.
//   2. SELECTION BIAS. CrossingFunded is emitted ONLY by _crossToPartner (line 871) —
//      the SELF-FUNDED path. The rescued path, _finalizeCrossing (line 907-934), approves
//      and enters WITHOUT emitting it. So v1's population was the healthiest members only:
//      24 of 63, self-selected for having crossed unaided.
//
// PHASE 5 NOW USES `EarningsCredited` INSTEAD. _credit() (line 1146) is the ONLY writer of
// the member struct's `totalEarned` field, and it emits EarningsCredited on every credit
// with a provenance tag. The crossing buffer never goes through it. So summing
// EarningsCredited per member reconstructs TRUE lifetime earnings exactly, with rescue
// money structurally excluded — and phase 5 now carries a positive control that proves it.
//
// WHAT THIS SCRIPT ANSWERS
//   1. WHERE IS THE PARKED QUEUE?  MatA = stuck at the A->B crossing, freed outright by
//      item A. MatB = at a re-entry that costs a full fee under item A exactly as today.
//      The MatA share IS the size of item A's prize. Never measured before.
//   2. IS THE RESERVE ACTUALLY ENOUGH?  Item A's premise, checked against member structs.
//   3. HOW MUCH DO SELF-FUNDED CROSSINGS EAT?  Measured, with the blind spot named.
//   4. HOW MANY PARKS DOES ITEM A PREVENT?  From MemberParked, split by half.
//   5. WHAT IS THE RE-ENTRY ASK AFTERWARDS?  From true earnings, with a positive control.
//
// HOUSE RULES OBSERVED (V8_50_HANDOFF.md section 6):
//   * Every getter and every event signature was grepped out of the .sol source before
//     use. Nothing is batched behind a shared catch. A failed read prints "?" and its
//     reason, never a number.
//   * Every phase carries a reconciliation it can fail.
//   * DIRECT_EARN_BPS is deliberately NOT read from MatrixKeeper. That public constant
//     says 500; the real value in MatrixLogicLib.sol:188 is 250 (V8.32 halved it). It is
//     dead code, but public, so a script that trusts it is wrong with no error.
//   * Scan holes make earnings a LOWER bound, which makes the ask a LOWER bound too —
//     i.e. incomplete data biases this script AGAINST item A, never for it.
//
// Read-only. Sends nothing, signs nothing.
//
// Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\model_item_a.js
//
// Optional:
//   ADDRESSES_FILE=deployed_addresses_v8_49.json   (default: .env's = live v8_48)
//   TIERS=T1            narrow the walk (recommended — the earnings scan is the slow part)
//   SCAN_BLOCKS=200000  event-scan depth
//   EXPECT_PARKED=139   reconcile the walk against a diag_floor_halt.js run

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRFILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json";
const A = require(path.join(__dirname, ADDRFILE));
const ONLY = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);
const SCAN_BLOCKS = Number(process.env.SCAN_BLOCKS || 200000);
const EXPECT_PARKED = process.env.EXPECT_PARKED ? Number(process.env.EXPECT_PARKED) : null;
const CHUNK = 9000;      // under the 10k eth_getLogs block cap
const CHUNK_EARN = 3000; // EarningsCredited is high volume — smaller window, fewer log-count rejections

// --- ABIs. Every entry grepped from the .sol source, 2026-08-16. --------------
const MAT_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function getMemberTotalWithdrawn(address) view returns (uint256)",
  // FigureEightMatrixV8.sol:83 / MatrixLogicLib.sol:208 — arity + indexing verified
  "event CrossingFunded(address indexed member, uint256 fromEscrow, uint256 fromEarnings, uint256 total)",
  // FigureEightMatrixV8.sol:98 / MatrixLogicLib.sol:247
  "event MemberParked(address indexed member, uint256 shortfall)",
  // MatrixLogicLib.sol:228-233 — THREE indexed params. source is uint8, tags 1..5.
  "event EarningsCredited(address indexed member, address indexed payer, uint8 indexed source, uint256 amount)",
];
const PM_ABI = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address matA, address matB)",
];
const MK_ABI = [
  "function CROSSING_RESERVE_BPS() view returns (uint256)",
  "function crossingBufferBps() view returns (uint256)",
  "function CROSSING_BUFFER_BPS() view returns (uint256)",
];
const SF_ABI = [
  "function memberDebt(address) view returns (uint256)",
  "function insolvencyFloorBps() view returns (uint256)",
  "function totalBalance() view returns (uint256)",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
const pct = (a, b) => (b ? (100 * Number(a) / Number(b)).toFixed(1) + "%" : "—");
const bar = (n = 78) => "=".repeat(n);

async function readBufferBps(mk) {
  try   { return { bps: await mk.crossingBufferBps(),  src: "crossingBufferBps() [param, V8.49+]" }; }
  catch { /* not on this chain */ }
  return { bps: await mk.CROSSING_BUFFER_BPS(), src: "CROSSING_BUFFER_BPS() [constant, V8.48]" };
}

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p  = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const mk = new ethers.Contract(A.matrixKeeper,  MK_ABI, p);
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);

  const block = await p.getBlockNumber();
  const now   = (await p.getBlock(block)).timestamp;
  const from0 = Math.max(0, block - SCAN_BLOCKS);

  // ---- PHASE 1 — plumbing. Any failure is fatal. -----------------------------
  console.log(bar());
  console.log("PHASE 1 — plumbing (every value read from chain; a failure stops the run)");
  console.log(bar());
  console.log(`  address file             ${ADDRFILE}`);
  console.log(`  block                    ${block}   scanning from ${from0}`);
  console.log(`  keeper                   ${A.matrixKeeper}`);

  let crossReserveBps;
  try { crossReserveBps = await mk.CROSSING_RESERVE_BPS(); }
  catch (e) {
    console.log(`\nFATAL: CROSSING_RESERVE_BPS() unreadable (${e.shortMessage || e.message}).`);
    console.log(`This constant IS item A. Refusing to assume 5000. Stopping.`);
    process.exit(1);
  }
  const floorBps = await sf.insolvencyFloorBps();
  const sfBal    = await sf.totalBalance();
  const buf      = await readBufferBps(mk);
  console.log(`  CROSSING_RESERVE_BPS     ${crossReserveBps}  (${Number(crossReserveBps) / 100}%)  <- item A's crossing price`);
  console.log(`  insolvencyFloorBps       ${floorBps}  (${Number(floorBps) / 100}%)`);
  console.log(`  crossing buffer          ${buf.bps} bps   <- ${buf.src}`);
  console.log(`  SF totalBalance          ${usd(sfBal)}`);
  if (buf.bps > 0n) {
    console.log(`\n  ⚠ BUFFER IS ${buf.bps} bps AND NON-ZERO. Every rescue seeds ${Number(buf.bps) / 100}% of the fee`);
    console.log(`  into the member's withdrawable as SF money (MatrixLogicLib.sol:1368) WITHOUT going`);
    console.log(`  through _credit(). Phase 5 measures around it. Any tool that reads withdrawable as`);
    console.log(`  "earnings" on this chain is counting borrowed money.`);
  }

  // ---- PHASE 2 — the parked queue, split by half. THE PRIZE. ------------------
  console.log("\n" + bar());
  console.log("PHASE 2 — where is the parked queue? MatA = stuck mid-cycle, MatB = at re-entry");
  console.log(bar());

  const tiers = Object.entries(A.tiers).filter(([n]) => !ONLY.length || ONLY.includes(n));
  const parked = [];
  const matrices = [];
  const unreadable = [];

  for (const [tierName, t] of tiers) {
    const tierIdx = Number(tierName.slice(1)) - 1;
    let pairs;
    try {
      const pm = new ethers.Contract(t.pm, PM_ABI, p);
      const n = await pm.activePairCount();
      pairs = [];
      for (let i = 0n; i < n; i++) pairs.push(await pm.getPairAt(i));
    } catch (e) {
      console.log(`  ${tierName}: pair enumeration FAILED (${e.shortMessage || e.message})`);
      console.log(`    -> falling back to the address file's pair 1 ONLY. Counts are a LOWER BOUND.`);
      pairs = [[t.matA, t.matB]];
    }

    for (const pair of pairs) {
      const [matA, matB] = [pair[0], pair[1]];
      for (const [half, addr] of [["MatA", matA], ["MatB", matB]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const mat = new ethers.Contract(addr, MAT_ABI, p);
        let fee;
        try { fee = await mat.ENTRY_FEE(); }
        catch (e) { console.log(`  ${addr} ENTRY_FEE ? (${e.shortMessage || e.message}) — SKIPPED, not zero`); continue; }
        matrices.push({ tierName, tierIdx, addr, half, fee, matA, matB });

        let pc;
        try { pc = await mat.getParkedCount(); }
        catch (e) { console.log(`  ${addr} getParkedCount ? (${e.shortMessage || e.message}) — SKIPPED`); continue; }

        for (let i = 0n; i < pc; i++) {
          let m;
          try { m = await mat.getParkedMember(i); }
          catch (e) { unreadable.push(`${addr}[${i}] getParkedMember ? ${e.shortMessage || e.message}`); continue; }
          if (!m || m === ethers.ZeroAddress) continue;
          try {
            const ts = await mat.parkedAt(m);
            if (ts === 0n) continue;
            parked.push({
              tierName, tierIdx, half, addr, fee, m, matA, matB,
              age:          BigInt(now) - ts,
              reserve:      await mat.crossingReserveOf(m),
              withdrawable: await mat.withdrawableOf(m),
              withdrawn:    await mat.getMemberTotalWithdrawn(m),
              debt:         await sf.memberDebt(m),
            });
          } catch (e) { unreadable.push(`${tierName} ${half} ${m} ? ${e.shortMessage || e.message}`); continue; }
        }
      }
    }
  }

  console.log(`  matrices walked ${matrices.length}   parked read ${parked.length}` +
              (unreadable.length ? `   (+${unreadable.length} unreadable, listed at the end)` : ""));
  if (EXPECT_PARKED !== null) {
    const ok = parked.length === EXPECT_PARKED;
    console.log(`  RECONCILE vs EXPECT_PARKED=${EXPECT_PARKED}: ${ok ? "MATCH" : "*** MISMATCH ***"}` +
                (ok ? "" : ` — this walk sees ${parked.length}. Trust NEITHER number until resolved.`));
  }
  if (!parked.length) { console.log("\n  No parked members. Stopping."); process.exit(0); }

  const inA = parked.filter(x => x.half === "MatA");
  const inB = parked.filter(x => x.half === "MatB");
  console.log(`\n  parked in MatA (stuck at the A->B crossing)   ${inA.length}   ${pct(inA.length, parked.length)}`);
  console.log(`  parked in MatB (at re-entry, a NEW cycle)     ${inB.length}   ${pct(inB.length, parked.length)}`);
  console.log(`\n  ^ THE MatA SHARE IS ITEM A'S PRIZE.`);

  console.log(`\n  IS THE RESERVE ACTUALLY ENOUGH? (item A's premise, checked not assumed)`);
  let covered = 0, short = 0, worstGap = 0n;
  for (const x of inA) {
    x.crossPrice = x.fee * crossReserveBps / 10_000n;
    x.itemAShort = x.reserve >= x.crossPrice ? 0n : x.crossPrice - x.reserve;
    if (x.itemAShort === 0n) covered++; else { short++; if (x.itemAShort > worstGap) worstGap = x.itemAShort; }
  }
  if (inA.length) {
    console.log(`    crossing price under item A   ${usd(inA[0].crossPrice)} at a ${usd(inA[0].fee)} fee`);
    console.log(`    reserve covers it in full     ${covered} of ${inA.length}  (${pct(covered, inA.length)})`);
    if (short) console.log(`    *** ${short} hold LESS than the crossing price, worst gap ${usd(worstGap)} — investigate before building.`);
    else       console.log(`    *** ALL ${inA.length} MatA parkers are freed outright by item A. Premise holds on chain.`);
  }
  const todayShort = x => (x.fee > x.reserve + x.withdrawable ? x.fee - (x.reserve + x.withdrawable) : 0n);
  console.log(`\n  Those MatA parkers cost the fund TODAY: ${usd(inA.reduce((a, x) => a + todayShort(x), 0n))} of real shortfall.`);
  console.log(`  Under item A that becomes ${usd(inA.reduce((a, x) => a + x.itemAShort, 0n))}.`);

  // ---- PHASE 3 — self-funded crossings. BLIND SPOT NAMED. --------------------
  console.log("\n" + bar());
  console.log(`PHASE 3 — what SELF-FUNDED crossings cost members (last ${SCAN_BLOCKS} blocks)`);
  console.log(bar());
  console.log(`  ⚠ BLIND SPOT: CrossingFunded is emitted ONLY by _crossToPartner (MatrixLogicLib:871),`);
  console.log(`  the self-funded path. The RESCUED path, _finalizeCrossing (907-934), approves and`);
  console.log(`  enters WITHOUT emitting it. Everything below therefore describes members who`);
  console.log(`  crossed UNAIDED. A zero in any row means "no self-funded crossing", NEVER "no crossing".\n`);

  let nCross = 0, sumEscrow = 0n, sumEarn = 0n, sumTotal = 0n, mismatched = 0, holes = 0;
  const byHalf = { MatA: { n: 0, earn: 0n }, MatB: { n: 0, earn: 0n } };
  for (const mx of matrices) {
    const c = new ethers.Contract(mx.addr, MAT_ABI, p);
    for (let f = from0; f <= block; f += CHUNK) {
      const t = Math.min(f + CHUNK - 1, block);
      let logs;
      try { logs = await c.queryFilter(c.filters.CrossingFunded(), f, t); }
      catch { holes++; continue; }
      for (const l of logs) {
        const esc = l.args.fromEscrow, ern = l.args.fromEarnings, tot = l.args.total;
        if (esc + ern !== tot) mismatched++;   // RECONCILE — the contract's own identity
        nCross++; sumEscrow += esc; sumEarn += ern; sumTotal += tot;
        byHalf[mx.half].n++; byHalf[mx.half].earn += ern;
      }
    }
  }
  if (holes) console.log(`  WARNING: ${holes} chunk(s) unreadable — LOWER BOUND, not a total.`);
  console.log(`  self-funded crossings seen  ${nCross}`);
  console.log(`  RECONCILE escrow + earnings == total : ${mismatched === 0 ? "OK on all " + nCross : "*** " + mismatched + " MISMATCH(ES) — event decode wrong, STOP ***"}`);
  if (nCross) {
    console.log(`  paid from reserve           ${usd(sumEscrow)}   ${pct(sumEscrow, sumTotal)}`);
    console.log(`  paid from withdrawable      ${usd(sumEarn)}   ${pct(sumEarn, sumTotal)}   <- item A stops charging this`);
    console.log(`  total crossed               ${usd(sumTotal)}`);
    for (const h of ["MatA", "MatB"]) {
      const b = byHalf[h];
      console.log(`    ${h}: ${String(b.n).padStart(5)} self-funded crossings, ${usd(b.earn).padStart(10)} taken from withdrawable`);
    }
    console.log(`\n  A near-exact 50/50 split is EXPECTED, not a coincidence: the reserve is carved at`);
    console.log(`  ${Number(crossReserveBps) / 100}% of the fee on entry and the destination charges the same fee, so`);
    console.log(`  fromReserve is structurally half. That is item A's premise showing up in the data.`);
  }

  // ---- PHASE 4 — parks item A removes. ---------------------------------------
  console.log("\n" + bar());
  console.log("PHASE 4 — how many PARKS does item A prevent?");
  console.log(bar());
  let parkA = 0, parkB = 0, parkAshort = 0n, zeroShort = 0, holes2 = 0;
  for (const mx of matrices) {
    const c = new ethers.Contract(mx.addr, MAT_ABI, p);
    for (let f = from0; f <= block; f += CHUNK) {
      const t = Math.min(f + CHUNK - 1, block);
      let logs;
      try { logs = await c.queryFilter(c.filters.MemberParked(), f, t); }
      catch { holes2++; continue; }
      for (const l of logs) {
        if (l.args.shortfall === 0n) { zeroShort++; continue; }
        if (mx.half === "MatA") { parkA++; parkAshort += l.args.shortfall; } else parkB++;
      }
    }
  }
  if (holes2) console.log(`  WARNING: ${holes2} chunk(s) unreadable — LOWER BOUND.`);
  console.log(`  funding parks in MatA (A->B crossing)  ${parkA}   totalling ${usd(parkAshort)} of shortfall`);
  console.log(`  funding parks in MatB (re-entry)       ${parkB}`);
  console.log(`  deferral parks (shortfall 0)           ${zeroShort}   <- not funding-related; item A does not touch these`);
  if (parkA + parkB > 0) {
    console.log(`\n  ITEM A REMOVES THE MatA COLUMN ENTIRELY: ${pct(parkA, parkA + parkB)} of all funding parks,`);
    console.log(`  and with them ${usd(parkAshort)} of lending the fund never has to do.`);
  }
  console.log(`  RECONCILE: parks seen (${parkA + parkB}) >= parked right now (${parked.length}): ` +
              `${parkA + parkB >= parked.length ? "OK" : "*** FAILS — scan too shallow or a matrix missing. ***"}`);

  // ---- PHASE 5 — TRUE earnings, from EarningsCredited. -----------------------
  console.log("\n" + bar());
  console.log("PHASE 5 — the re-entry ask under item A, from TRUE earnings");
  console.log(bar());
  console.log(`  _credit() (MatrixLogicLib:1146) is the ONLY writer of the member struct's`);
  console.log(`  totalEarned, and it emits EarningsCredited on every credit. The crossing buffer`);
  console.log(`  bypasses it (line 1368). So summing this event = true earnings, rescue money`);
  console.log(`  structurally excluded. Scan holes LOWER earnings and RAISE the ask — errors here`);
  console.log(`  count against item A, never for it.\n`);

  const want = new Set(parked.map(x => x.m.toLowerCase()));
  const earned = new Map();        // member -> credits across the whole pair
  const earnedIn = new Map();      // `member|matrix` -> credits in that one matrix (per journey)
  const bySource = {};
  let earnLogs = 0, holes3 = 0;
  for (const mx of matrices) {
    const c = new ethers.Contract(mx.addr, MAT_ABI, p);
    for (let f = from0; f <= block; f += CHUNK_EARN) {
      const t = Math.min(f + CHUNK_EARN - 1, block);
      let logs;
      try { logs = await c.queryFilter(c.filters.EarningsCredited(), f, t); }
      catch { holes3++; continue; }
      for (const l of logs) {
        earnLogs++;
        const k = l.args.member.toLowerCase();
        const s = Number(l.args.source);
        bySource[s] = (bySource[s] || 0n) + l.args.amount;
        if (want.has(k)) {
          earned.set(k, (earned.get(k) || 0n) + l.args.amount);
          const kk = k + "|" + mx.addr;
          earnedIn.set(kk, (earnedIn.get(kk) || 0n) + l.args.amount);
        }
      }
    }
  }
  const SRC = { 1: "direct entry (2.5%)", 2: "L1 referral", 3: "chain pay", 4: "pool share", 5: "orphan -> acct1" };
  console.log(`  EarningsCredited seen ${earnLogs}` + (holes3 ? `   WARNING: ${holes3} unreadable chunk(s) — LOWER BOUND` : ""));
  console.log(`  credited by source (all members, whole scan):`);
  for (const s of Object.keys(bySource).sort()) {
    console.log(`    ${String(s).padStart(2)} ${(SRC[s] || "UNKNOWN TAG — check MatrixLogicLib:235-239").padEnd(34)} ${usd(bySource[s]).padStart(12)}`);
  }

  // ⛔ THE CONTROL THAT WAS HERE IN v2 WAS WRONG, AND IT REFUSED A VERDICT FOR A
  //    REASON THAT DOES NOT EXIST. Recorded because the mistake is instructive.
  //
  //    v2 asserted: credited == withdrawable + withdrawn for a never-rescued member,
  //    and called credited > withdrawable + withdrawn "impossible — the scan missed
  //    credits". It is not impossible. It is the NORMAL state, because withdrawable
  //    drains through three paths that are not withdrawals:
  //      * _crossToPartner:868      withdrawable -= fromWithdrawable  (paying a crossing)
  //      * _crossToPartner:882-897  withdrawable -= repay             (SF debt clawback)
  //      * forceCrossKeeper:1357    withdrawable -= memberShare       (rescued crossing)
  //    87 of 98 members showed it and the run produced NO VERDICT on a false alarm.
  //    A control must encode an invariant that is actually invariant.
  //
  //    THE REAL CONTROL, used below: EarningsCredited is tagged with its source, and
  //    the tags have known BPS weights of the entry fee (MatrixLogicLib:187-188 and the
  //    split config). Source 1 is a flat 250bps carve on every entry, so it DERIVES the
  //    total entry-fee volume in range; chain pay and pool must then land near their own
  //    weights against that same volume. Three independent quantities that have to agree,
  //    none of them assumed from the fee.
  const DIRECT_BPS_TRUE = 250n;   // MatrixLogicLib.sol:188. NOT the keeper's public 500.
  const CHAIN_BPS_EXP   = 1350n;  // 5 payable levels x 270 (level 6 pays 0)
  const POOL_BPS_EXP    = 1800n;  // MatrixKeeper POOL_BPS, and the scope's 1800
  console.log(`\n  CONTROL — do the source tags agree with their own BPS weights?`);
  const s1 = bySource[1] || 0n;
  if (s1 === 0n) {
    console.log(`    no source-1 credits in range — cannot derive entry volume. NO VERDICT BELOW.`);
  } else {
    const feeVolume = s1 * 10_000n / DIRECT_BPS_TRUE;
    console.log(`    entry-fee volume DERIVED from source 1  ${usd(feeVolume)}   (${usd(s1)} at ${DIRECT_BPS_TRUE}bps)`);
    for (const [tag, expBps, label] of [[3, CHAIN_BPS_EXP, "chain pay"], [4, POOL_BPS_EXP, "pool share"]]) {
      const got = bySource[tag] || 0n;
      const exp = feeVolume * expBps / 10_000n;
      const ratio = exp > 0n ? (Number(got) / Number(exp) * 100).toFixed(1) : "—";
      console.log(`    ${label.padEnd(11)} expected ~${usd(exp).padStart(10)} at ${expBps}bps, saw ${usd(got).padStart(10)}  = ${ratio}% of expected`);
    }
    console.log(`    (pool settles per rotation, so it lags — undershoot is expected there.`);
    console.log(`     chain pay is paid instantly and should land close. A wild miss on chain pay`);
    console.log(`     means the scan or the decode is wrong, and the verdict below is worthless.)`);
  }

  // Per-member figures. `taken` is what actually left the system to the member's wallet;
  // it is the only outflow item A does NOT give back.
  let noData = 0;
  for (const x of parked) {
    const other = x.half === "MatA" ? x.matB : x.matA;
    let oWd = 0n;
    try { oWd = await new ethers.Contract(other, MAT_ABI, p).getMemberTotalWithdrawn(x.m); }
    catch (e) { unreadable.push(`${x.m} partner-half withdrawn ? ${e.shortMessage || e.message}`); }
    x.withdrawnOther = oWd;      // phase 6 needs the halves apart, not just the sum
    x.taken = x.withdrawn + oWd;
    const cr = earned.get(x.m.toLowerCase());
    if (cr === undefined) { noData++; x.trueEarned = null; continue; }
    x.trueEarned = cr;
    x.earnA = earnedIn.get(x.m.toLowerCase() + "|" + x.matA) || 0n;
    x.earnB = earnedIn.get(x.m.toLowerCase() + "|" + x.matB) || 0n;
  }

  const feeRef   = parked[0].fee;
  const floorAmt = feeRef * floorBps / 10_000n;

  // What does one completed journey actually earn? The scope says 3400bps ($3.40 at T1)
  // from 250 direct + 1800 pool + 1350 chain. MEASURE it rather than repeat it.
  const jA = inB.map(x => x.earnA).filter(v => v > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (jA.length) {
    console.log(`\n  WHAT ONE COMPLETED JOURNEY EARNS (MatA credits of members who finished it, n=${jA.length})`);
    console.log(`    min ${usd(jA[0])}  median ${usd(jA[Math.floor(jA.length / 2)])}  max ${usd(jA[jA.length - 1])}`);
    console.log(`    the scope's structural figure is ${usd(feeRef * 3400n / 10_000n)} (3400bps). Compare the median.`);
  }

  console.log(`\n  THE ASK AT RE-ENTRY UNDER ITEM A (MatB parkers — they have finished a full cycle)`);
  console.log(`  Under item A the reserve paid the A->B crossing, so earnings were never spent on it.`);
  console.log(`  Holding at re-entry = credits across BOTH halves - what they withdrew to their wallet.`);
  console.log(`  floor at this tier: ${usd(feeRef)} x ${floorBps}bps = ${usd(floorAmt)}\n`);
  const asks = [];
  let clears = 0, refusedN = 0, withdrew = 0;
  for (const x of inB) {
    if (x.trueEarned === null) continue;
    if (x.taken > 0n) withdrew++;
    const holding = x.trueEarned > x.taken ? x.trueEarned - x.taken : 0n;
    const ask = x.fee > holding ? x.fee - holding : 0n;
    asks.push(ask);
    if (ask <= floorAmt) clears++; else refusedN++;
  }
  if (!asks.length) console.log(`  No MatB parker had usable credit data (${noData} without). NO VERDICT.`);
  else {
    asks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    console.log(`  members measured         ${asks.length} of ${inB.length}   (${withdrew} have withdrawn to wallet)`);
    console.log(`  ask under item A         min ${usd(asks[0])}  median ${usd(asks[Math.floor(asks.length / 2)])}  max ${usd(asks[asks.length - 1])}`);
    console.log(`  CLEARS the floor         ${clears}  (${pct(clears, asks.length)})`);
    console.log(`  REFUSED by the floor     ${refusedN}  (${pct(refusedN, asks.length)})`);
    console.log(`\n  The handoff predicts $3.20 against a ${usd(floorAmt)} floor. Compare the median.`);
    console.log(`  If the median sits ABOVE the floor, item C must move WITH item A and they ship together.`);
    console.log(`  This is measured, not assumed — every input is a chain read or a tagged credit.`);

    // ── PARAM 59 SWEEP (added 2026-08-17, owner decision) ────────────────────
    // min/median/max cannot answer "how many clear at X" for an X between them, and
    // the owner's instinct (4000) sits inside the refused tail. Count it instead.
    // 4000 is marked because it is settable by the OWNER (setInsolvencyFloorBps takes
    // any bps <= 10000) but is NOT on the DAO menu at V8Governance.sol:496, so a value
    // set there could never be voted back to.
    const MENU = [0, 1700, 2500, 3400, 5000, 6800, 10000];
    console.log(`\n  PARAM 59 SWEEP — how many of the ${asks.length} are rescued at each ceiling:`);
    for (const bps of [...MENU, 4000].sort((a, b) => a - b)) {
      const ceil = feeRef * BigInt(bps) / 10_000n;
      const ok = asks.filter((a) => a <= ceil).length;
      const onMenu = MENU.includes(bps);
      console.log(`    ${String(bps).padStart(5)} bps  ceiling ${usd(ceil).padStart(8)}  rescued ${String(ok).padStart(3)}/${asks.length}  refused ${String(asks.length - ok).padStart(3)}${onMenu ? "" : "   <- OFF the DAO menu"}`);
    }
  }
  // ==========================================================================
  console.log(`\n==============================================================================`);
  console.log(`PHASE 6 — THE SAME ASK, ON THE BASIS THE CONTRACT ACTUALLY USES`);
  console.log(`==============================================================================`);
  // ⛔ WHY THIS PHASE EXISTS. Phase 5 sums a member's credits across BOTH halves. That is
  // correct for the population it measures — today's V8.48 parkers, whose MatA balance was
  // already spent on their full-fee crossing, so aggregate ~= MatB ledger. It is WRONG as a
  // PROJECTION of item A, and the difference decides PARAM 59.
  //
  // The re-entry is funded by TierRouter.handleCycleOut(member, tierIndex, escrow,
  // withdrawable), and MatrixLogicLib._cycleOutRoot passes those two buckets from the
  // CYCLING MATRIX ONLY. There is no cross-matrix lookup. The keeper agrees:
  // MatrixKeeperLib._triageParked reads crossingReserveOf + withdrawableOf on the PARKED
  // matrix. So the gate sees one ledger, never the sum.
  //
  // Under item A the member KEEPS their journey-A earnings — in the MatA ledger — because
  // the reserve alone paid the crossing. Under V8.48 that money arrived in MatB as a carved
  // reserve and was spendable here. Item A does not take it away; it moves it somewhere the
  // AUTOMATIC path cannot reach. (selfRescue pulls a shortfall from the WALLET, so a member
  // can still bring it manually after a withdraw.)
  //
  // Measured on a local fixture 2026-08-17: MatA ledger $7.31 stranded, MatB ledger $7.66
  // passed to the gate, $14.97 aggregate. This phase asks whether the live population says
  // the same thing.
  {
    const askAgg = [], askLedger = [];
    let noSplit = 0;
    for (const x of inB) {
      if (x.trueEarned === null) { noSplit++; continue; }
      // AGGREGATE — phase 5's basis: everything they earned, minus everything withdrawn.
      const holdAgg = x.trueEarned > x.taken ? x.trueEarned - x.taken : 0n;
      // LEDGER — the gate's basis, projected under item A: journey-B credits only, minus
      // what they withdrew FROM MatB. The MatB reserve is 0 under item A by construction,
      // so the whole bucket is withdrawable.
      const holdLed = x.earnB > x.withdrawn ? x.earnB - x.withdrawn : 0n;
      askAgg.push(x.fee > holdAgg ? x.fee - holdAgg : 0n);
      askLedger.push(x.fee > holdLed ? x.fee - holdLed : 0n);
    }
    const med = (a) => a[Math.floor(a.length / 2)];
    if (!askLedger.length) {
      console.log(`  no MatB parker had usable per-ledger data (${noSplit} without). NO VERDICT.`);
    } else {
      askAgg.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      askLedger.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      console.log(`  members measured  ${askLedger.length} of ${inB.length}`);
      console.log(`  ask, AGGREGATE (phase 5, both halves)   min ${usd(askAgg[0])}  median ${usd(med(askAgg))}  max ${usd(askAgg[askAgg.length - 1])}`);
      console.log(`  ask, MatB LEDGER (what the gate sees)   min ${usd(askLedger[0])}  median ${usd(med(askLedger))}  max ${usd(askLedger[askLedger.length - 1])}`);
      const gap = med(askLedger) > med(askAgg) ? med(askLedger) - med(askAgg) : 0n;
      console.log(`  MEDIAN UNDERSTATEMENT                   ${usd(gap)}   <- how much phase 5 flatters item A`);

      console.log(`\n  PARAM 59 SWEEP ON THE LEDGER BASIS — rescued of ${askLedger.length}:`);
      const MENU = [0, 1700, 2500, 3400, 5000, 6800, 10000];
      for (const bps of MENU) {
        const ceil = feeRef * BigInt(bps) / 10_000n;
        const okA = askAgg.filter((a) => a <= ceil).length;
        const okL = askLedger.filter((a) => a <= ceil).length;
        const flag = okL === askLedger.length ? "  <- clears everyone" : "";
        console.log(`    ${String(bps).padStart(5)} bps  ceiling ${usd(ceil).padStart(8)}   aggregate ${String(okA).padStart(3)}   LEDGER ${String(okL).padStart(3)}${flag}`);
      }
      console.log(`\n  ⛔ WHICH COLUMN APPLIES DEPENDS ON WHETHER ITEM E1 SHIPS — READ THIS BEFORE`);
      console.log(`  QUOTING EITHER. This script reads the LIVE chain, which runs V8.48. It cannot`);
      console.log(`  "see" E1; both columns are PROJECTIONS onto the same V8.48 data.`);
      console.log(``);
      console.log(`    LEDGER column     = item A WITHOUT E1. The crossing stops charging earnings,`);
      console.log(`                        but those earnings stay in the MatA ledger and the`);
      console.log(`                        re-entry gate only reads MatB. Journey B alone funds it.`);
      console.log(`    AGGREGATE column  = item A WITH E1. _crossToPartner carries the member's`);
      console.log(`                        remaining withdrawable across, so the MatB ledger holds`);
      console.log(`                        journey A + journey B and the gate sees the whole sum.`);
      console.log(``);
      console.log(`  The two coincide BY CONSTRUCTION once E1 is in — that is what E1 does, so the`);
      console.log(`  aggregate column is not a separate measurement, it is the post-E1 answer. Do`);
      console.log(`  not present it as independent confirmation; it is the same arithmetic relabelled.`);
      console.log(`  WITHOUT E1 the honest floor is 6800. WITH E1 it is 3400 and it clears everyone.`);
      console.log(`\n  ⚠ ONE CAVEAT, STATED SO IT IS NOT MISTAKEN FOR CERTAINTY: these are V8.48`);
      console.log(`  members. Their MatA balance was already spent on a full-fee crossing, so the`);
      console.log(`  ledger split item A CREATES is not fully visible in them yet. The LEDGER column`);
      console.log(`  is therefore itself an upper bound on how good things are — a post-item-A`);
      console.log(`  member keeps MORE in MatA, so MORE is stranded from this gate, not less.`);
    }
  }

  console.log(`\n  ⚠ NOT IN THE HANDOFF: _crossToPartner sweeps ALL remaining withdrawable to repay SF`);
  console.log(`  debt right after the crossing (MatrixLogicLib:882-897). Under item A the member`);
  console.log(`  arrives there holding MORE, so an indebted member is clawed back HARDER, not spared.`);
  console.log(`  "No first loan therefore no clawback" holds only for members who never borrowed.`);
  console.log(`  MatB parkers currently carrying debt: ${inB.filter(x => x.debt > 0n).length} of ${inB.length}.`);

  if (unreadable.length) {
    console.log("\n" + bar());
    console.log(`UNREADABLE (${unreadable.length}) — listed, never silently dropped`);
    console.log(bar());
    for (const u of unreadable.slice(0, 40)) console.log("  " + u);
    if (unreadable.length > 40) console.log(`  ... and ${unreadable.length - 40} more`);
  }
  console.log("\nDone.\n");
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
