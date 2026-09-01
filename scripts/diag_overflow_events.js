// diag_overflow_events.js — DID ITEM S ACTUALLY FIRE ON CHAIN, AND IS ITEM G ON OR OFF?
// READ-ONLY: no signer, nothing signed, nothing sent. Built 2026-08-31 (session 53).
//
// WHY THIS EXISTS
// ───────────────
// The private V8.51 gate chain was filled to saturation with graduation OFF, expecting to
// reproduce the live chain's seat theft. It did NOT reproduce at anything like the live
// rate: T1.1 MatA showed ONE no-seat park where live V8.50 produces ~70 in 24h, and the
// second pair (T1.2) picked up 7 members while live's T1.2 sits at rotation 0 with 244
// free seats and nothing reaching it.
//
// THE CANDIDATE EXPLANATION, WHICH THIS SCRIPT EXISTS TO CONFIRM OR KILL:
//   ITEM S IS UNFLAGGED AND WAS THEREFORE ACTIVE THE WHOLE TIME. bigfill self-rescues
//   parked members; rescueReentry sees _bothHalvesFull(pair 0) and routes them to
//   _pairWithRoomFor -> pair 1, emitting RescueOverflowed. On live V8.50 there is no item
//   S, so item 10 returns every rescued member to their OWN MatA, where they take the seat
//   the cascade just freed — which is precisely the 49.1e swap that parks the arrival and
//   leaves T1.2 starved.
//
// ⛔ THAT IS A HYPOTHESIS UNTIL RescueOverflowed IS COUNTED. If the event never fired, the
//    7 members in T1.2 arrived some other way and the explanation is wrong — which is a
//    result, not a failure. The script prints zero as zero and says so.
//
// It also reads TierRouter.graduationEnabled(), because a "graduation OFF" baseline that
// was never checked is not a baseline.
//
// Run: ADDRESSES_FILE=deployed_addresses_v8_51_private.json FROM_BLOCK=46189900 \
//      npx hardhat run scripts/diag_overflow_events.js --network baseSepolia
// Env: ADDRESSES_FILE (required), FROM_BLOCK, CHUNK (9000), TIER (e.g. T1).

const path = require("path");
const { ethers } = require("hardhat");

const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || ""));

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
  "event RescueOverflowed(address indexed member, uint256 indexed fromPair, uint256 indexed toPair)",
];
const TR_ABI = [
  "function graduationEnabled() view returns (bool)",
  // V8.51: item G finally has an event. Emitted by TierRouterLib via delegatecall, so it
  // arrives with TierRouter's address even though TierRouter's own ABI does not declare it.
  "event MemberGraduated(address indexed member, uint256 indexed fromPair, uint256 indexed toPair)",
];
const MAT_ABI = [
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
  "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)",
];

const line = (n = 96) => console.log("=".repeat(n));

async function scanTopic(p, address, topic, from, head, chunk) {
  const logs = [];
  for (let b = from; b <= head; b += chunk) {
    const to = Math.min(b + chunk - 1, head);
    try {
      logs.push(...await p.getLogs({ address, fromBlock: b, toBlock: to, topics: [topic] }));
    } catch (e) {
      return { ok: false, why: (e.shortMessage || e.message || "").slice(0, 80) };
    }
  }
  return { ok: true, logs };
}

async function main() {
  if (!process.env.ADDRESSES_FILE) {
    console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
    process.exit(1);
  }
  const p = ethers.provider;
  const head = await p.getBlockNumber();
  const from = Number(process.env.FROM_BLOCK || Math.max(0, head - 20000));
  const CHUNK = Number(process.env.CHUNK || 9000);
  const TIER_ONLY = (process.env.TIER || "").trim().toUpperCase();

  line();
  console.log("diag_overflow_events.js — READ-ONLY. Nothing is signed or sent.");
  console.log("question       : did ITEM S fire (RescueOverflowed), and is ITEM G on or off?");
  console.log("addresses file :", process.env.ADDRESSES_FILE);
  console.log("blocks         :", `${from}..${head}`);
  line();

  // ── ITEM G's flag. A baseline nobody checked is not a baseline. ────────────
  try {
    const g = await new ethers.Contract(A.tierRouter, TR_ABI, p).graduationEnabled();
    console.log(`\nTierRouter.graduationEnabled : ${g}   ${g ? "⛔ ITEM G IS ON — this is NOT a graduation-off baseline" : "✅ OFF — item G took no part in what follows"}`);
  } catch (e) {
    console.log(`\n?  graduationEnabled — READ FAILED: ${(e.shortMessage || e.message || "").slice(0, 80)}`);
    console.log("   ⛔ Do not describe the run as 'graduation off' on an unread flag.");
  }

  const pmIface = new ethers.Interface(PM_ABI);
  const T_OVER = pmIface.getEvent("RescueOverflowed").topicHash;
  const matIface = new ethers.Interface(MAT_ABI);
  const T_ENTER = matIface.getEvent("MemberEntered").topicHash;

  let grand = 0, anyFail = false;
  let grandUnexplained = null;   // set per tier below; null means never computed

  for (const tk of Object.keys(A.tiers || {})) {
    if (TIER_ONLY && tk.toUpperCase() !== TIER_ONLY) continue;
    const pmAddr = A.tiers[tk].pm;
    const pm = new ethers.Contract(pmAddr, PM_ABI, p);

    let pairCount = 0;
    try { pairCount = Number(await pm.pairCount()); }
    catch (e) { console.log(`\n${tk}  ? pairCount READ FAILED — skipping`); anyFail = true; continue; }
    if (pairCount === 0) continue;

    const r = await scanTopic(p, pmAddr, T_OVER, from, head, CHUNK);
    if (!r.ok) { console.log(`\n${tk}  ⛔ RescueOverflowed SCAN FAILED: ${r.why} — NOT reported as zero`); anyFail = true; continue; }

    console.log(`\n── ${tk}  PairManager ${pmAddr}  (${pairCount} pair${pairCount === 1 ? "" : "s"}) ──`);
    console.log(`   RescueOverflowed events: ${r.logs.length}`);
    grand += r.logs.length;
    for (const lg of r.logs.slice(0, 12)) {
      const d = pmIface.parseLog(lg);
      console.log(`     ${d.args.member}  pair ${d.args.fromPair} -> pair ${d.args.toPair}   blk ${lg.blockNumber}  tx ${lg.transactionHash.slice(0, 18)}…`);
    }
    if (r.logs.length > 12) console.log(`     … and ${r.logs.length - 12} more`);

    // ⛔ THE ACCOUNTING THAT MATTERS, ADDED 2026-08-31 AFTER A SUBTRACTION LEFT 4 ENTRIES
    // UNEXPLAINED. Counting entries into later pairs and subtracting the overflow count
    // gives a REMAINDER, not an identity — and a remainder is not evidence of anything.
    // Item G leaves NO EVENT of its own (50.4 shipped a view, a lib branch and a flag, no
    // emit), so the only way to see a graduation on chain is by ELIMINATION: an entry into
    // a later pair whose transaction carries NO RescueOverflowed. This cross-references by
    // txHash and NAMES the leftovers so each one can be opened on BaseScan by hand.
    // A classification nobody can re-check is not evidence (noseat_witness.js's rule).
    const overflowTxs = new Set(r.logs.map(l => l.transactionHash.toLowerCase()));
    const unexplained = [];
    let laterEntries = 0;

    for (let i = 0; i < pairCount; i++) {
      let a, b;
      try { [a, b] = await pm.getPairAt(i); } catch { console.log(`   ? getPairAt(${i}) failed`); anyFail = true; continue; }
      for (const [label, addr] of [[`${tk}.${i + 1} MatA`, a], [`${tk}.${i + 1} MatB`, b]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const m = new ethers.Contract(addr, MAT_ABI, p);
        let occ = "?", rot = "?";
        try { occ = (await m.occupancy()).toString(); rot = (await m.rotationCount()).toString(); } catch { anyFail = true; }
        const e = await scanTopic(p, addr, T_ENTER, from, head, CHUNK);
        console.log(`   ${label.padEnd(12)} occ ${occ.padStart(3)}  rot ${rot.padStart(4)}  MemberEntered ${e.ok ? e.logs.length : "SCAN FAILED"}`);
        if (!e.ok) { anyFail = true; continue; }
        if (i === 0) continue;                    // pair 0 is the front door; not routing
        laterEntries += e.logs.length;
        for (const lg of e.logs) {
          if (overflowTxs.has(lg.transactionHash.toLowerCase())) continue;   // item S explains it
          let who = "?";
          try { who = matIface.parseLog(lg).args.member; } catch { /* keep "?" */ }
          unexplained.push({ label, who, blk: lg.blockNumber, tx: lg.transactionHash });
        }
      }
    }

    console.log(`\n   ── ROUTING ACCOUNT for ${tk} ──`);
    console.log(`   entries into pairs 2+            : ${laterEntries}`);
    console.log(`   of those, in a RescueOverflowed tx: ${laterEntries - unexplained.length}   (ITEM S)`);
    console.log(`   NOT explained by item S           : ${unexplained.length}`);
    grandUnexplained = (grandUnexplained || 0) + unexplained.length;
    if (unexplained.length === 0) {
      console.log("   ⛔ ZERO. Every entry into a later pair is item S. On this evidence ITEM G HAS NOT");
      console.log("      FIRED — do not describe it as proven on chain, however green the fixtures are.");
    } else {
      console.log("   ▶ CANDIDATE GRADUATIONS — open these on BaseScan before calling them item G.");
      console.log("     A real graduation is a MatB root cycling out and entering the NEXT pair's MatA in");
      console.log("     the same tx. A duplicate re-route (_freePairFor) looks similar and is NOT item G.");
      for (const u of unexplained.slice(0, 20)) {
        console.log(`     ${u.label.padEnd(12)} ${u.who}  blk ${u.blk}  tx ${u.tx}`);
      }
      if (unexplained.length > 20) console.log(`     … and ${unexplained.length - 20} more`);
    }
  }

  // ── THE CROSS-CHECK. Two independent methods must agree. ───────────────────
  // Before V8.51 item G had no event, so a graduation could only be found by ELIMINATION:
  // an entry into a later pair whose tx carries no RescueOverflowed. Now it emits
  // MemberGraduated, so the same quantity is directly observable. Running BOTH and
  // comparing is the point: the event is new code, and new code that agrees with an
  // independent method is trustworthy in a way that either one alone is not.
  // ⛔ If they disagree, DO NOT prefer the event because it is newer and easier to read.
  // A disagreement IS the finding — measure it, do not explain it.
  const trIface = new ethers.Interface(TR_ABI);
  const T_GRAD = trIface.getEvent("MemberGraduated").topicHash;
  const g = await scanTopic(p, A.tierRouter, T_GRAD, from, head, CHUNK);
  console.log("\n── ITEM G's OWN EVENT (V8.51+) ──");
  if (!g.ok) {
    console.log(`   ⛔ MemberGraduated SCAN FAILED: ${g.why} — NOT reported as zero`);
    anyFail = true;
  } else {
    console.log(`   MemberGraduated events on TierRouter ${A.tierRouter}: ${g.logs.length}`);
    for (const lg of g.logs.slice(0, 12)) {
      const d = trIface.parseLog({ topics: [...lg.topics], data: lg.data });
      console.log(`     ${d.args.member}  pair ${d.args.fromPair} -> pair ${d.args.toPair}   blk ${lg.blockNumber}  tx ${lg.transactionHash.slice(0, 18)}…`);
    }
    if (g.logs.length > 12) console.log(`     … and ${g.logs.length - 12} more`);
    if (g.logs.length === 0) {
      console.log("   ⚠ ZERO — either item G never fired, or this deployment predates the event");
      console.log("     (the V8.51 gate chain deployed 2026-08-31 03:49Z has NO MemberGraduated in its");
      console.log("      bytecode). Check which before concluding anything.");
    } else if (grandUnexplained !== null) {
      console.log(`\n   CROSS-CHECK  event count ${g.logs.length}  vs  unexplained-by-item-S ${grandUnexplained}`);
      if (g.logs.length === grandUnexplained) {
        console.log("   ✅ TWO INDEPENDENT METHODS AGREE. The event reports exactly the entries that");
        console.log("      elimination attributes to graduation. Either one alone could be wrong; both");
        console.log("      agreeing is what makes this trustworthy.");
      } else {
        console.log("   ⛔⛔ THEY DISAGREE. That IS the finding — do not explain it, measure it. Open the");
        console.log("      difference with scripts/diag_tx_events.js before believing either number, and");
        console.log("      do NOT prefer the event just because it is newer and easier to read.");
      }
    }
  }

  line();
  console.log("== VERDICT ==");
  if (anyFail) console.log("⚠ At least one read failed above — treat the totals as INCOMPLETE, never as zero.");
  if (grand > 0) {
    console.log(`✅ ITEM S FIRED ${grand} TIME(S) ON CHAIN. rescueReentry found pair 0 full in BOTH halves and`);
    console.log("   routed the rescued member to a pair with room instead of parking them. That is the");
    console.log("   escape hatch working, and it is the likely reason this chain did not reproduce the");
    console.log("   live seat-theft rate: on live V8.50 there is no item S, so item 10 returns every");
    console.log("   rescued member to their OWN MatA and they take the seat the cascade just freed.");
  } else {
    console.log("⛔ RescueOverflowed NEVER FIRED. The item-S explanation for this chain's behaviour is");
    console.log("   WRONG and must not be carried forward — the members in later pairs arrived some");
    console.log("   other way. Find that way before drawing any conclusion about item S.");
  }
  line();
}

main().catch((e) => { console.error(e); process.exit(1); });
