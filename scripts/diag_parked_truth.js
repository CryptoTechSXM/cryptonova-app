// diag_parked_truth.js — 915 parked, ZERO past a 24h grace period. Which is it?
//
// THE OBSERVATION (diag_keeper_discovery.js, 2026-08-11 01:00 UTC)
//   30 matrices, getParkedCount() sums to 915, and not one of those 915 is past the
//   24-hour parkedGracePeriod. checkUpkeep returns zero items. The keeper IS
//   configured — configuredTierCount 10, every pairManagerForTier set.
//
//   "915 parked, none older than 24 hours" is not a thing that happens by accident.
//   Three explanations fit the same observation and they demand opposite responses:
//
//   H1  parkedAt is ZERO for these members.
//       _checkParked returns early on `ts == 0` — before the grace check, before the
//       SF check. Discovery would be structurally blind no matter how long anyone
//       waits, and the audit's conclusion would be right for a reason it never named.
//
//   H2  parkedAt is set and genuinely recent for all of them.
//       Then copay_rescue / fastlane_rescue are clearing parked members faster than
//       the 24h grace period, so on-chain discovery never gets a turn. Nothing is
//       broken; the grace period is simply longer than the keepers' response time.
//       Retiring those keepers would then STRAND members for 24h, and item 12 is
//       really a question about what the grace period should be.
//
//   H1b duplicate entries in the parked ARRAY.
//       Every push to parkedMembers is paired with a parkedAt write, so a blanket
//       zero should not happen — EXCEPT that _removeFromParkedQueue removes only the
//       FIRST matching entry and then clears the mapping. A member pushed twice
//       therefore leaves one live entry behind with parkedAt == 0, permanently
//       invisible to _checkParked and permanently inflating getParkedCount().
//
//   H3  the parked ARRAY is not compacted.
//       getParkedCount() counts everyone who has ever parked, including members long
//       since rescued (isParked false, parkedAt cleared). Discovery is then correct
//       to find nothing — and "915 parked" is a number nobody should be quoting,
//       including anywhere it reaches members.
//
// This script does not guess between them. It reads parkedAt, isParked and the
// rescue inputs for a sample of the real queue and prints the distribution.
//
// Run: npx hardhat run scripts/diag_parked_truth.js --network baseSepolia
//   SAMPLE=8   how many entries to sample per matrix (default 8: first 4, last 4 —
//              the ends of the array are where a compaction bug shows up)
//   TIERS=1,2  restrict to these tier numbers (default: all configured)
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const KEEPER = [
  "function configuredTierCount() view returns (uint8)",
  "function pairManagerForTier(uint8) view returns (address)",
  "function parkedGracePeriod() view returns (uint256)",
  "function rescueRatioBps() view returns (uint256)",
];
const PM = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function isParked(address) view returns (bool)",
  "function isInMatrix(address) view returns (bool)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function getMemberTotalWithdrawn(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
];
const SF = [
  "function balanceByTier(uint8) view returns (uint256)",
  "function totalBalance() view returns (uint256)",
];

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const hrs = (s) => (Number(s) / 3600).toFixed(1);

async function main() {
  const p = ethers.provider;
  const k = new ethers.Contract(A.matrixKeeper, KEEPER, p);
  const sf = new ethers.Contract(A.stabilityFund, SF, p);
  const now = (await p.getBlock("latest")).timestamp;
  const grace = Number(await k.parkedGracePeriod());
  const ratioBps = Number(await k.rescueRatioBps());
  const SAMPLE = Number(process.env.SAMPLE || 8);
  const only = process.env.TIERS ? process.env.TIERS.split(",").map((s) => Number(s.trim())) : null;

  console.log(`\n  block ${new Date(now * 1000).toISOString()}   grace ${hrs(grace)}h   rescueRatioBps ${ratioBps}`);
  console.log(`  sampling up to ${SAMPLE} entries per matrix (first half, last half)\n`);

  // Buckets that map 1:1 onto the three hypotheses.
  const tally = {
    zeroTs: 0,        // H1 — parkedAt == 0: invisible to _checkParked
    notParked: 0,     // H3 — still in the array but isParked() false: stale entry
    zeroAddr: 0,      // H3 — array slot holds address(0)
    freshTs: 0,       // H2 — parkedAt set, inside the grace window
    staleTs: 0,       //      parkedAt set, PAST grace — should be discoverable
    sampled: 0,
  };
  const ages = [];
  let totalEntries = 0, uniqueEntries = 0, totalDupes = 0;
  const dupeExamples = [];
  console.log("  ── DUPLICATE SCAN (full array, not sampled) ──");
  const examples = { zeroTs: [], notParked: [], staleTs: [], freshTs: [] };

  const n = Number(await k.configuredTierCount());
  for (let t = 0; t < n; t++) {
    if (only && !only.includes(t + 1)) continue;
    const pmAddr = await k.pairManagerForTier(t);
    if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pmAddr, PM, p);
    const pc = Number(await pm.activePairCount());
    for (let i = 0; i < pc; i++) {
      const [a, b] = await pm.getPairAt(i);
      for (const [lbl, m] of [["A", a], ["B", b]]) {
        if (!m || m === ethers.ZeroAddress) continue;
        const mx = new ethers.Contract(m, MX, p);
        const cnt = Number(await mx.getParkedCount().catch(() => 0n));
        if (cnt === 0) continue;

        // DUPLICATE SCAN — reads the whole array, not a sample. A duplicate is the
        // one mechanism that produces parkedAt == 0 despite every push being paired
        // with a timestamp write, so it is worth the extra calls.
        {
          const seen = new Map();
          let dupes = 0;
          for (let q = 0; q < cnt; q++) {
            const mm = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
            if (!mm || mm === ethers.ZeroAddress) continue;
            const prev = seen.get(mm);
            if (prev !== undefined) { dupes++; if (dupeExamples.length < 6) dupeExamples.push(`T${t + 1} p${i}${lbl} ${mm.slice(0, 10)}… at [${prev}] and [${q}]`); }
            else seen.set(mm, q);
          }
          totalEntries += cnt;
          uniqueEntries += seen.size;
          totalDupes += dupes;
          if (dupes > 0) console.log(`    T${t + 1} p${i}${lbl}: ${cnt} entries, ${seen.size} unique, ${dupes} DUPLICATE`);
        }

        // Sample BOTH ends: a queue that is never compacted looks different at the
        // head (oldest, long since rescued) than at the tail (newest).
        const half = Math.max(1, Math.floor(SAMPLE / 2));
        const idxs = new Set();
        for (let q = 0; q < Math.min(half, cnt); q++) idxs.add(q);
        for (let q = Math.max(0, cnt - half); q < cnt; q++) idxs.add(q);

        for (const q of idxs) {
          const mem = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
          tally.sampled++;
          if (!mem || mem === ethers.ZeroAddress) { tally.zeroAddr++; continue; }
          const [ts, parked] = await Promise.all([
            mx.parkedAt(mem).catch(() => 0n),
            mx.isParked(mem).catch(() => null),
          ]);
          const tsN = Number(ts);
          const tag = `T${t + 1} p${i}${lbl}[${q}] ${mem.slice(0, 10)}…`;
          if (tsN === 0) {
            tally.zeroTs++;
            if (examples.zeroTs.length < 4) examples.zeroTs.push(`${tag} parkedAt=0 isParked=${parked}`);
          } else {
            const age = now - tsN;
            ages.push(age);
            if (parked === false) {
              tally.notParked++;
              if (examples.notParked.length < 4) examples.notParked.push(`${tag} age=${hrs(age)}h isParked=FALSE (stale array entry)`);
            } else if (age >= grace) {
              tally.staleTs++;
              if (examples.staleTs.length < 4) examples.staleTs.push(`${tag} age=${hrs(age)}h PAST GRACE`);
            } else {
              tally.freshTs++;
              if (examples.freshTs.length < 4) examples.freshTs.push(`${tag} age=${hrs(age)}h inside grace`);
            }
          }
        }
      }
    }
  }

  console.log(`\n    array entries ${totalEntries}   unique members ${uniqueEntries}   DUPLICATES ${totalDupes}`);
  if (totalDupes > 0) {
    console.log("    ^ every duplicate leaves one entry with parkedAt == 0 once the member is");
    console.log("      rescued once: _removeFromParkedQueue removes the FIRST match and clears");
    console.log("      the mapping, so the survivor is invisible to _checkParked forever.");
    for (const d of dupeExamples) console.log(`      ${d}`);
  }

  console.log("\n  ── SAMPLE BREAKDOWN ──");
  console.log(`    sampled entries          : ${tally.sampled}`);
  console.log(`    parkedAt == 0            : ${tally.zeroTs}    (H1: invisible to _checkParked)`);
  console.log(`    array slot address(0)    : ${tally.zeroAddr}    (H3: uncompacted array)`);
  console.log(`    isParked() == false      : ${tally.notParked}    (H3: stale entry, already rescued)`);
  console.log(`    parked, inside grace     : ${tally.freshTs}    (H2: keepers clearing faster than grace)`);
  console.log(`    parked, PAST grace       : ${tally.staleTs}    (should be discoverable NOW)`);

  if (ages.length) {
    ages.sort((x, y) => x - y);
    const pick = (f) => hrs(ages[Math.min(ages.length - 1, Math.floor(ages.length * f))]);
    console.log(`\n    parked age p0/p25/p50/p75/p100 (h): ${hrs(ages[0])} / ${pick(0.25)} / ${pick(0.5)} / ${pick(0.75)} / ${hrs(ages[ages.length - 1])}`);
  }

  for (const [kk, label] of [["zeroTs", "parkedAt == 0"], ["notParked", "isParked false"],
                             ["staleTs", "past grace"], ["freshTs", "inside grace"]]) {
    if (examples[kk].length) {
      console.log(`\n    examples — ${label}:`);
      for (const e of examples[kk]) console.log(`      ${e}`);
    }
  }

  // ── THE NUMBER THAT DECIDES ITEM 12 ───────────────────────────────────────
  // V8.48 item 12 splits the grace period: a rescue the member funds THEMSELVES
  // (withdrawable + crossing reserve >= entry fee, so the Stability Fund pays zero)
  // becomes discoverable after a short race guard instead of the full 24 hours.
  //
  // That change does NOTHING unless self-funded parked members actually exist. In a
  // local fixture they never occur: a member's withdrawable FREEZES the moment they
  // park, and it lands around 7.8 against a fee of 10 — reserve 5.0 plus roughly 2.8
  // earned. If the live chain looks the same, item 12 is a no-op and should not ship.
  console.log("\n  ── SELF-FUNDED CENSUS (does item 12 apply to anyone?) ──");
  {
    let selfFunded = 0, needsLoan = 0, checked = 0;
    const near = [];
    for (let t = 0; t < n; t++) {
      if (only && !only.includes(t + 1)) continue;
      const pmAddr = await k.pairManagerForTier(t);
      if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;
      const pm = new ethers.Contract(pmAddr, PM, p);
      const pc = Number(await pm.activePairCount());
      for (let i = 0; i < pc; i++) {
        const [a2, b2] = await pm.getPairAt(i);
        for (const [lbl, m] of [["A", a2], ["B", b2]]) {
          if (!m || m === ethers.ZeroAddress) continue;
          const mx = new ethers.Contract(m, MX, p);
          const cnt = Number(await mx.getParkedCount().catch(() => 0n));
          if (cnt === 0) continue;
          const fee = await mx.ENTRY_FEE().catch(() => 0n);
          if (fee === 0n) continue;
          const half = Math.max(1, Math.floor(SAMPLE / 2));
          const idxs = new Set();
          for (let q = 0; q < Math.min(half, cnt); q++) idxs.add(q);
          for (let q = Math.max(0, cnt - half); q < cnt; q++) idxs.add(q);
          for (const q of idxs) {
            const mem = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
            if (!mem || mem === ethers.ZeroAddress) continue;
            const [wd, rs] = await Promise.all([
              mx.withdrawableOf(mem).catch(() => 0n),
              mx.crossingReserveOf(mem).catch(() => 0n),
            ]);
            const eff = wd + rs;
            checked++;
            if (eff >= fee) {
              selfFunded++;
              if (near.length < 6) near.push(`SELF-FUNDED T${t + 1} p${i}${lbl} ${mem.slice(0, 10)}… ${usd(wd)}+${usd(rs)} = ${usd(eff)} >= fee ${usd(fee)}`);
            } else {
              needsLoan++;
              const pct = fee > 0n ? Number(eff * 100n / fee) : 0;
              if (pct >= 90 && near.length < 6) near.push(`near miss   T${t + 1} p${i}${lbl} ${mem.slice(0, 10)}… ${usd(eff)} = ${pct}% of fee ${usd(fee)}`);
            }
          }
        }
      }
    }
    console.log(`    sampled ${checked}   SELF-FUNDED ${selfFunded}   needs an SF loan ${needsLoan}`);
    for (const x of near) console.log(`      ${x}`);
    console.log();
    if (checked === 0) {
      console.log("    Nothing sampled — inconclusive.");
    } else if (selfFunded === 0) {
      console.log("    ZERO self-funded. Item 12's split grace would change NOTHING on chain:");
      console.log("    every parked member needs SF money, so every one of them correctly waits");
      console.log("    the full grace period. DO NOT SHIP the change on the strength of theory —");
      console.log("    and fastlane_rescue.js has nothing to do either, which is worth knowing");
      console.log("    separately.");
    } else {
      const pct = Math.round((selfFunded / checked) * 100);
      console.log(`    ${pct}% of sampled parked members fund their own re-entry. Those are the`);
      console.log("    members waiting out a 24h loan-protection window for money already theirs,");
      console.log("    and they are exactly who item 12's split grace releases.");
    }
  }

  // SF balances: the other reason _checkParked drops a member silently.
  console.log("\n  ── STABILITY FUND (the other silent drop) ──");
  console.log(`    totalBalance: ${usd(await sf.totalBalance())}`);
  const per = [];
  for (let t = 0; t < n; t++) per.push(`T${t + 1}=${usd(await sf.balanceByTier(t).catch(() => 0n))}`);
  console.log(`    ${per.join("  ")}`);

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log("\n  ── WHICH HYPOTHESIS ──");
  const { zeroTs, notParked, zeroAddr, freshTs, staleTs, sampled } = tally;
  const most = Math.max(zeroTs, notParked + zeroAddr, freshTs, staleTs);
  if (sampled === 0) {
    console.log("    Nothing sampled — no parked entries found. Re-run when the census is non-zero.");
  } else if (most === zeroTs) {
    console.log("    H1. parkedAt is ZERO on the majority sampled. _checkParked returns on");
    console.log("    `ts == 0` before it ever reaches the grace or SF checks, so these members");
    console.log("    can NEVER be discovered however long they wait. The fix is wherever the");
    console.log("    park path fails to stamp parkedAt — a contract bug, not a keeper feature.");
  } else if (most === notParked + zeroAddr) {
    console.log("    H3. Most sampled entries are STALE — already rescued, or an empty slot.");
    console.log("    getParkedCount() is counting history, not the live queue. Discovery is");
    console.log("    behaving correctly by finding nothing. Two consequences: the parked array");
    console.log("    needs compaction, and any number derived from getParkedCount() overstates");
    console.log("    reality — check every place that figure is shown before quoting it again.");
  } else if (most === freshTs) {
    console.log("    H2. The queue is genuinely fresh — the off-chain keepers are clearing");
    console.log("    parked members faster than the 24h grace period, so on-chain discovery");
    console.log("    never gets a turn. NOTHING IS BROKEN. Item 12 is not a discovery problem;");
    console.log("    it is the question of what parkedGracePeriod should be, and retiring those");
    console.log("    keepers as-is would strand members for a full day.");
  } else {
    console.log("    Members ARE past grace and should be discoverable. If checkUpkeep still");
    console.log("    returns nothing, the remaining suspect is the SF balance check above:");
    console.log("    _checkParked drops a member when the tier bucket AND totalBalance are both");
    console.log("    short of the rescue share.");
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
