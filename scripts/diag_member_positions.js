// diag_member_positions.js — WHY DOES SELF RESCUE KEEP COMING BACK FOR ONE MEMBER?
//
// THE QUESTION (2026-08-24, owner testing on admin): a wallet self-rescues, the panel
// clears, and the self-rescue prompt returns. Three explanations fit that description and
// they need completely different responses, so this measures which one it is instead of
// arguing about it:
//
//   (A) MULTIPLE PARKED POSITIONS AT ONCE. Each rescue clears exactly ONE matrix. If the
//       member is parked in three, they must rescue three times, and the panel correctly
//       shows the next one each time. NOT A BUG. Measured 2026-08-24 by
//       diag_parked_solvency.js: of 36 members past grace, FIVE were parked in two
//       matrices simultaneously. bigfill's own code asserts this cannot happen
//       ("A member can only be parked on ONE matrix at a time -- break on first hit",
//       bigfill_v8.js:609) and that assertion is measured FALSE.
//
//   (B) RE-PARKING AFTER A SUCCESSFUL RESCUE. The rescue lands, _finalizeCrossing seats
//       them, they cycle out again and park again — a real cycle, working as designed,
//       just faster than expected. Also NOT A BUG, but it means the member is churning.
//
//   (C) THE RESCUE IS NOT ACTUALLY LANDING. The transaction reverts or the parked queue
//       is not being cleared, so the same position reappears. THAT would be a bug.
//
// The three are trivially separable in the event log, which is why this reads events
// rather than only current state:
//   (A) -> several MemberParked, DIFFERENT matrices, then rescues clearing them one by one
//   (B) -> strict alternation in ONE matrix: Parked, SelfRescue, Parked, SelfRescue...
//   (C) -> repeated MemberParked in one matrix with NO SelfRescue in between
//
// Read-only. Sends no transaction, needs no key.
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json MEMBER=0xabc... \
//     npx hardhat run scripts/diag_member_positions.js --network baseSepolia
//
//   BLOCKS=200000   how far back to scan for events (default 130000, ~3 days on Base Sepolia)
//   CHUNK=9000      getLogs window; most public RPCs refuse more than 10k
//
// 34.1: no ADDRESSES_FILE default. A hand-run diagnostic is exactly where a stale
// default reads a dead deployment and prints confident numbers.
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  process.exit(1);
}
if (!process.env.MEMBER) {
  console.log("FATAL: MEMBER not set. MEMBER=0xabc... is the wallet to investigate.");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
const MEMBER = ethers.getAddress(process.env.MEMBER.trim());

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX_ABI = [
  "function ENTRY_FEE() view returns (uint256)",
  "function parkedAt(address) view returns (uint256)",
  "function getMember(address) view returns (tuple(uint256 id,address referrer,uint256 joinedAt,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 cyclesCompleted,bool isInMatrix,bool hasEverJoined,uint256 crossingReserve))",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
// The re-entry flag decides whether a completed crossing seats the member or dumps them
// straight back into the parked queue. TierRouter._executeAdditive:1131 (per
// CryptoNova-Keepers/check_member_options.js):
//     reentryOn = (!optionsSet || cycles < reentryMinCycles) ? true : autoReentryEnabled
// so a member below reentryMinCycles has re-entry FORCED ON regardless of their setting.
// If re-entry is on and reserve + withdrawable < the next fee, MatrixLogicLib
// `parkCycledOut` (:1685) parks them again — "TierRouter parks a member whose MatB
// cycle-out could not fund a re-entry".
const TR_ABI = [
  "function memberOptions(address) view returns (bool autoUpgradeDisabled, bool autoReentryEnabled, bool doubleReentryEnabled, bool optionsSet)",
  "function reentryMinCycles() view returns (uint256)",
];

const usd = v => (v === null || v === undefined) ? "?" : "$" + (Number(v) / 1e6).toFixed(2);
const problems = [];
const PROBLEM = (w, e) => {
  problems.push(`${w}${e ? ": " + (e.shortMessage || e.message || "").slice(0, 80) : ""}`);
  console.log(`  PROBLEM ${w}${e ? ": " + (e.shortMessage || e.message || "").slice(0, 80) : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isTransport = m => /HH110|Invalid JSON-RPC|ECONNRESET|ETIMEDOUT|socket hang up|network|timeout|50[234]|fetch failed|limit|range/i.test(m || "");
async function read(label, fn, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return { ok: true, v: await fn() }; }
    catch (e) { last = e; if (!isTransport(e.shortMessage || e.message)) break; await sleep(400 * (i + 1)); }
  }
  PROBLEM(label, last);
  return { ok: false, v: null };
}

// Event signatures, from git show d382d37:contracts/MatrixLogicLib.sol
const EV = {
  [ethers.id("MemberParked(address,uint256)")]:                 "PARKED",
  [ethers.id("SelfRescue(address,uint256,uint256)")]:           "SELF-RESCUE",
  [ethers.id("CoPayRescue(address,uint256,uint256,uint256)")]:  "COPAY-RESCUE",
  [ethers.id("MemberEvicted(address,uint256)")]:                "EVICTED",
};

async function main() {
  console.log(`  diag_member_positions — READ-ONLY`);
  console.log(`  member    : ${MEMBER}`);
  console.log(`  addresses : ${process.env.ADDRESSES_FILE}`);

  const usdc = await ethers.getContractAt(USDC_ABI, A.usdc);
  const bal = await read("usdc.balanceOf", () => usdc.balanceOf(MEMBER));
  console.log(`  wallet    : ${usd(bal.v)} USDC\n`);

  // ── every matrix this member has ever touched ─────────────────────────────────────
  const mats = [];            // {label, addr}
  for (const tk of Object.keys(A.tiers)) {
    const t = A.tiers[tk];
    if (!t || !t.pm) { PROBLEM(`${tk} pair manager absent — TIER SKIPPED`); continue; }
    const pm = await ethers.getContractAt(PM_ABI, t.pm);
    const pc = await read(`${tk} pairCount()`, () => pm.pairCount());
    if (!pc.ok) continue;
    for (let i = 0n; i < pc.v; i++) {
      const pr = await read(`${tk} getPairAt(${i})`, () => pm.getPairAt(i));
      if (!pr.ok) continue;
      for (let j = 0; j < 2; j++) {
        if (pr.v[j] === ethers.ZeroAddress) continue;
        mats.push({ label: `${tk}.${i + 1n} ${j ? "MatB" : "MatA"}`, addr: pr.v[j] });
      }
    }
  }
  console.log(`  matrices in scope: ${mats.length}\n`);

  const footprint = [], parked = [];
  for (const m of mats) {
    const mx = await ethers.getContractAt(MX_ABI, m.addr);
    const mem = await read(`${m.label} getMember`, () => mx.getMember(MEMBER));
    if (!mem.ok) continue;
    if (!mem.v.hasEverJoined) continue;                    // never touched this matrix
    const pa = await read(`${m.label} parkedAt`, () => mx.parkedAt(MEMBER));
    const fee = await read(`${m.label} ENTRY_FEE`, () => mx.ENTRY_FEE());
    const alw = await read(`${m.label} allowance`, () => usdc.allowance(MEMBER, m.addr));
    const eff = mem.v.crossingReserve + mem.v.withdrawable;
    const short = (fee.ok && fee.v > eff) ? fee.v - eff : 0n;
    const row = {
      ...m, inMatrix: mem.v.isInMatrix, parkedAt: pa.ok ? pa.v : null,
      cycles: mem.v.cyclesCompleted, reserve: mem.v.crossingReserve,
      withdrawable: mem.v.withdrawable, fee: fee.v, short, allowance: alw.ok ? alw.v : null,
    };
    footprint.push(row);
    if (pa.ok && pa.v > 0n) parked.push(row);
  }

  console.log("  EVERY MATRIX THIS MEMBER HAS JOINED");
  console.log("  " + "-".repeat(104));
  console.log("  matrix         seated  parked  cycles   fee    reserve  withdrawable  shortfall  allowance");
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const r of footprint) {
    const age = r.parkedAt && r.parkedAt > 0n ? ((Number(now - r.parkedAt) / 3600).toFixed(1) + "h") : "-";
    console.log(
      `  ${r.label.padEnd(13)} ${(r.inMatrix ? "YES" : "no").padStart(6)} ${age.padStart(7)} ` +
      `${String(r.cycles).padStart(6)} ${usd(r.fee).padStart(7)} ${usd(r.reserve).padStart(9)} ` +
      `${usd(r.withdrawable).padStart(13)} ${usd(r.short).padStart(10)} ${usd(r.allowance).padStart(10)}`
    );
  }

  // ── the re-entry flag, which is what decides whether a rescue STICKS ───────────────
  const tr = await ethers.getContractAt(TR_ABI, A.tierRouter);
  const opts = await read("tierRouter.memberOptions", () => tr.memberOptions(MEMBER));
  const minC = await read("tierRouter.reentryMinCycles", () => tr.reentryMinCycles());
  if (opts.ok && minC.ok) {
    console.log(`\n  RE-ENTRY SETTING`);
    console.log(`    optionsSet ${opts.v.optionsSet} | autoReentryEnabled ${opts.v.autoReentryEnabled} | reentryMinCycles ${minC.v}`);
    console.log(`    matrix         cycles  re-entry on next cycle-out  can it fund the re-entry?`);
    for (const r of footprint) {
      const on = (!opts.v.optionsSet || r.cycles < minC.v) ? true : opts.v.autoReentryEnabled;
      const why = !opts.v.optionsSet ? "forced (options never set)"
                : r.cycles < minC.v  ? "forced (below minCycles)"
                : (opts.v.autoReentryEnabled ? "member's own flag: ON" : "member's own flag: OFF");
      const funded = r.fee !== null && (r.reserve + r.withdrawable) >= r.fee;
      console.log(`    ${r.label.padEnd(13)} ${String(r.cycles).padStart(6)}  ${(on ? "ON  — " + why : "off — " + why).padEnd(28)} ` +
        (on ? (funded ? "yes, seats cleanly" : `NO — re-parks, needs ${usd(r.short)} again`) : "n/a"));
    }
    const treadmill = footprint.filter(r => ((!opts.v.optionsSet || r.cycles < minC.v) ? true : opts.v.autoReentryEnabled)
                                         && r.fee !== null && (r.reserve + r.withdrawable) < r.fee);
    if (treadmill.length) {
      let cost = 0n; for (const r of treadmill) cost += r.short;
      console.log(`\n    ⛔ ${treadmill.length} matrix/matrices will RE-PARK this member the moment a rescue completes.`);
      console.log(`       Each lap costs them ${usd(cost)} across those positions and returns them to where`);
      console.log(`       they started. Paying it again does not advance them — it buys one more lap.`);
    }
  }

  console.log(`\n  ▶ PARKED RIGHT NOW: ${parked.length}`);
  for (const r of parked) console.log(`      ${r.label}  needs ${usd(r.short)}  (approved ${usd(r.allowance)})`);
  if (parked.length > 1) {
    console.log(`  ⛔ EXPLANATION (A): this member is parked in ${parked.length} matrices AT ONCE.`);
    console.log(`     Each selfRescue() clears exactly ONE — it takes msg.sender and the matrix it`);
    console.log(`     was called on. ${parked.length} rescues are REQUIRED. The panel returning is`);
    console.log(`     it showing the next position, which is correct behaviour, not a loop.`);
  }

  // ── the event sequence, which is what actually separates A from B from C ───────────
  const SPAN  = Number(process.env.BLOCKS || 130000);
  const CHUNK = Number(process.env.CHUNK  || 9000);
  const tip = await ethers.provider.getBlockNumber();
  const from = Math.max(0, tip - SPAN);
  const addrs = mats.map(m => m.addr);
  const byAddr = Object.fromEntries(mats.map(m => [m.addr.toLowerCase(), m.label]));
  const memberTopic = ethers.zeroPadValue(MEMBER, 32);

  console.log(`\n  EVENT HISTORY — blocks ${from}..${tip} (${SPAN} blocks, ~${(SPAN * 2 / 86400).toFixed(1)} days)`);
  const events = [];
  let scanFailed = 0;
  for (let b = from; b <= tip; b += CHUNK) {
    const to = Math.min(b + CHUNK - 1, tip);
    const r = await read(`getLogs ${b}..${to}`, () => ethers.provider.getLogs({
      address: addrs, fromBlock: b, toBlock: to,
      topics: [Object.keys(EV), memberTopic],
    }));
    if (!r.ok) { scanFailed++; continue; }
    for (const l of r.v) {
      events.push({ block: l.blockNumber, kind: EV[l.topics[0]], matrix: byAddr[l.address.toLowerCase()] || l.address });
    }
  }
  events.sort((a, b) => a.block - b.block);

  if (scanFailed) {
    console.log(`  ⚠ ${scanFailed} log chunk(s) unreadable — the sequence below is INCOMPLETE.`);
    console.log(`    Do not read an absence in it as proof of anything. Lower CHUNK and re-run.`);
  }
  if (!events.length) {
    console.log(`  (no events in this window — widen with BLOCKS=)`);
  } else {
    for (const e of events) console.log(`    ${String(e.block).padStart(9)}  ${e.kind.padEnd(13)} ${e.matrix}`);
  }

  // ── verdict, and only where the reads support one ──────────────────────────────────
  console.log(`\n  READING`);
  const parks   = events.filter(e => e.kind === "PARKED");
  const rescues = events.filter(e => e.kind === "SELF-RESCUE" || e.kind === "COPAY-RESCUE");
  const parkMats = new Set(parks.map(e => e.matrix));
  console.log(`    MemberParked events : ${parks.length} across ${parkMats.size} matrix/matrices`);
  console.log(`    rescue events       : ${rescues.length}`);

  if (problems.length || scanFailed) {
    console.log(`    ⚠ ${problems.length} PROBLEM(s) and ${scanFailed} unreadable chunk(s) — NOT concluding.`);
  } else if (parked.length > 1) {
    console.log(`    => (A) MULTIPLE POSITIONS. ${parked.length} parked at once, so ${parked.length} rescues are needed.`);
    console.log(`       Not a defect. The "Clear all parked positions" button sequences them.`);
  } else if (parks.length > 1 && parkMats.size === 1 && rescues.length >= parks.length - 1) {
    console.log(`    => (B) RE-PARKING. One matrix, parked and rescued repeatedly in strict turn.`);
    console.log(`       The rescues ARE landing; this member cycles out and re-parks quickly.`);
    console.log(`       Working as designed — but worth asking whether the cycle is too fast.`);
  } else if (parks.length > 1 && rescues.length === 0) {
    console.log(`    => (C) SUSPECT. Repeated parking with NO rescue event recorded at all.`);
    console.log(`       The rescues are not landing. This is the case that IS a bug — capture the`);
    console.log(`       failing tx hash and decode it before changing anything.`);
  } else {
    console.log(`    => Sequence does not match A, B or C cleanly. Read the list above rather than`);
    console.log(`       forcing it into a category — the raw order is the evidence.`);
  }

  console.log(`\n  PROBLEMS: ${problems.length}`);
  problems.forEach(p => console.log("    " + p));
}

main().catch(e => { console.error(e); process.exit(1); });
