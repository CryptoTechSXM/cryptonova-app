// diag_parked_ages.js — how OLD is the parked queue, really?
//
// THE QUESTION
//   diag_keeper_discovery.js reported, against live V8.48 on 2026-08-17:
//       T1: pairs=2 parked=105 pastGrace=0
//   105 members parked and not one of them past a 24h grace. On a chain whose
//   T1 pair has rotated 460/300 times that is possible — but it is also exactly
//   the shape a SWALLOWED ERROR makes. That script wraps both per-member reads
//   in `.catch(() => 0n)` / `.catch(() => ZeroAddress)`, and the handoff already
//   records ARRAY_RANGE_ERROR coming back from getParkedMember on this very
//   deployment. A member whose read reverts is still counted by getParkedCount
//   and silently contributes 0 to the age census. parked=105 / pastGrace=0 is
//   what that failure would print.
//
//   Same class of trap as the UTF-16 Tee-Object captures: the failure and the
//   all-clear are indistinguishable in the output.
//
// WHAT THIS DOES DIFFERENTLY
//   Nothing is caught silently. Every read that fails is COUNTED AND NAMED, and
//   the verdict at the bottom refuses to call the queue healthy if any read
//   failed. The age histogram is printed whether or not it is comfortable.
//
//   This script reads only. It calls no state-changing function.
//
// Run: npx hardhat run scripts/diag_parked_ages.js --network baseSepolia
//   ADDRESSES_FILE is taken from .env (deployed_addresses_v8_48.json = the
//   live community chain).
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const KEEPER = [
  "function configuredTierCount() view returns (uint8)",
  "function pairManagerForTier(uint8) view returns (address)",
  "function parkedGracePeriod() view returns (uint256)",
  "function selfFundedGracePeriod() view returns (uint256)",
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
  "function isMatrixA() view returns (bool)",
  "function rotationCount() view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function getMemberTotalWithdrawn(address) view returns (uint256)",
];

const H = (s) => (Number(s) / 3600).toFixed(1) + "h";
const D = (s) => (Number(s) / 86400).toFixed(2) + "d";
const U = (v) => "$" + (Number(v) / 1e6).toFixed(2);

// Age buckets, in hours. The 24h edge is parkedGracePeriod; 168h is the V8.49
// eviction clock, which is NOT deployed on V8.48 — on the live chain eviction
// fires at parkedGracePeriod, so anything past 24h that is still sitting there
// is a member the keeper looked at and walked away from.
const BUCKETS = [1, 6, 24, 72, 168, 336, 720, Infinity];
const LABEL = ["<1h", "1-6h", "6-24h", "1-3d", "3-7d", "7-14d", "14-30d", ">30d"];

async function main() {
  const p = ethers.provider;
  const keeperAddr = A.matrixKeeper || A.MatrixKeeper;
  const k = new ethers.Contract(keeperAddr, KEEPER, p);
  const now = (await p.getBlock("latest")).timestamp;

  console.log("\n  MatrixKeeper:", keeperAddr);
  console.log("  addresses   :", process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json");
  console.log("  block time  :", new Date(now * 1000).toISOString());

  const grace = Number(await k.parkedGracePeriod());
  let selfGrace = null;
  try { selfGrace = Number(await k.selfFundedGracePeriod()); } catch { /* not on this deployment */ }
  const ratioBps = Number(await k.rescueRatioBps());
  console.log(`  parkedGracePeriod    : ${H(grace)}`);
  console.log(`  selfFundedGracePeriod: ${selfGrace === null ? "NOT PRESENT on this deployment" : H(selfGrace)}`);
  console.log(`  rescueRatioBps       : ${ratioBps}`);

  const tiers = Number(await k.configuredTierCount());

  let readErrors = [];      // every failure, named
  let countedTotal = 0;     // sum of getParkedCount()
  let agedTotal = 0;        // members whose parkedAt we actually read
  const hist = new Array(BUCKETS.length).fill(0);
  const oldest = [];        // {tier, matrix, member, ageSec}
  let zeroTs = 0;           // parkedAt == 0 while sitting in the queue: a REAL defect, not a read failure

  for (let t = 0; t < tiers; t++) {
    let pmAddr;
    try { pmAddr = await k.pairManagerForTier(t); }
    catch (e) { readErrors.push(`T${t + 1} pairManagerForTier: ${e.shortMessage || e.message}`); continue; }
    if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;

    const pm = new ethers.Contract(pmAddr, PM, p);
    let pc;
    try { pc = Number(await pm.activePairCount()); }
    catch (e) { readErrors.push(`T${t + 1} activePairCount: ${e.shortMessage || e.message}`); continue; }

    for (let i = 0; i < pc; i++) {
      let a, b;
      try { [a, b] = await pm.getPairAt(i); }
      catch (e) { readErrors.push(`T${t + 1} p${i} getPairAt: ${e.shortMessage || e.message}`); continue; }

      for (const [lbl, m] of [["A", a], ["B", b]]) {
        if (!m || m === ethers.ZeroAddress) continue;
        const mx = new ethers.Contract(m, MX, p);
        const tag = `T${t + 1} p${i}${lbl}`;

        let n;
        try { n = Number(await mx.getParkedCount()); }
        catch (e) { readErrors.push(`${tag} getParkedCount: ${e.shortMessage || e.message}`); continue; }
        if (n === 0) continue;
        countedTotal += n;

        let localAged = 0, localErr = 0, localZero = 0;
        const localAges = [];

        for (let q = 0; q < n; q++) {
          let mem;
          try { mem = await mx.getParkedMember(q); }
          catch (e) {
            localErr++;
            readErrors.push(`${tag} getParkedMember(${q}): ${e.shortMessage || e.message}`);
            continue;
          }
          if (!mem || mem === ethers.ZeroAddress) {
            localErr++;
            readErrors.push(`${tag} getParkedMember(${q}): returned the zero address`);
            continue;
          }
          let ts;
          try { ts = Number(await mx.parkedAt(mem)); }
          catch (e) {
            localErr++;
            readErrors.push(`${tag} parkedAt(${mem}): ${e.shortMessage || e.message}`);
            continue;
          }
          if (ts === 0) {
            // In the queue but with no timestamp. Not a read failure — a state
            // defect: _checkParked reads this same value, so the keeper cannot
            // age this member either.
            localZero++; zeroTs++;
            readErrors.push(`${tag} parkedAt(${mem}) == 0 WHILE QUEUED — the keeper cannot age this member`);
            continue;
          }
          const age = now - ts;
          localAges.push(age);
          localAged++; agedTotal++;
          for (let bi = 0; bi < BUCKETS.length; bi++) {
            if (age < BUCKETS[bi] * 3600) { hist[bi]++; break; }
          }
          oldest.push({ tag, member: mem, age, matrix: m });
        }

        localAges.sort((x, y) => x - y);
        const med = localAges.length ? localAges[Math.floor(localAges.length / 2)] : 0;
        const mx1 = localAges.length ? localAges[localAges.length - 1] : 0;
        console.log(
          `\n  ${tag}  ${m}` +
          `\n     queued=${n}  aged=${localAged}  readFailed=${localErr}  parkedAtZero=${localZero}` +
          `\n     median age=${D(med)}   oldest=${D(mx1)}   past ${H(grace)} grace=${localAges.filter((x) => x >= grace).length}`
        );
      }
    }
  }

  // ── the histogram ─────────────────────────────────────────────────────────
  console.log("\n  ── PARKED AGE DISTRIBUTION ──");
  for (let bi = 0; bi < BUCKETS.length; bi++) {
    const bar = "#".repeat(Math.min(60, hist[bi]));
    console.log(`    ${LABEL[bi].padEnd(7)} ${String(hist[bi]).padStart(4)}  ${bar}`);
  }

  // ── the ten oldest, with the numbers that decide their verdict ────────────
  oldest.sort((x, y) => y.age - x.age);
  const top = oldest.slice(0, 10);
  if (top.length) {
    console.log("\n  ── TEN OLDEST, AND WHY THEY ARE STILL THERE ──");
    console.log("     (withdrawable + reserve vs the fee is what _checkParked prices;");
    console.log("      withdrawn/(withdrawn+withdrawable) vs rescueRatioBps is what evicts)");
    for (const o of top) {
      const mx = new ethers.Contract(o.matrix, MX, p);
      let fee = 0n, w = 0n, r = 0n, wd = 0n, isA = null, note = "";
      try {
        [fee, w, r, wd, isA] = await Promise.all([
          mx.ENTRY_FEE(), mx.withdrawableOf(o.member), mx.crossingReserveOf(o.member),
          mx.getMemberTotalWithdrawn(o.member), mx.isMatrixA(),
        ]);
      } catch (e) { note = `  <read failed: ${e.shortMessage || e.message}>`; }
      const held = w + r;
      const claimable = wd + w;
      const ratio = claimable > 0n ? Number((wd * 10000n) / claimable) : 0;
      console.log(
        `     ${o.tag} ${o.member.slice(0, 10)}… age=${D(o.age).padStart(8)}` +
        `  fee=${U(fee)} held=${U(held)} (w=${U(w)} res=${U(r)})` +
        `  withdrawnRatio=${ratio}${ratio > ratioBps ? " >EVICT" : ""}` +
        `  ${isA === null ? "" : isA ? "MatA" : "MatB"}${note}`
      );
    }
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log("\n  ── VERDICT ──");
  console.log(`    getParkedCount total : ${countedTotal}`);
  console.log(`    successfully aged    : ${agedTotal}`);
  console.log(`    read failures        : ${readErrors.length - zeroTs}`);
  console.log(`    parkedAt == 0 queued : ${zeroTs}`);

  if (readErrors.length) {
    console.log("\n    ⚠  THE CENSUS IS INCOMPLETE. Every failure, in full:");
    for (const e of readErrors.slice(0, 40)) console.log(`       ${e}`);
    if (readErrors.length > 40) console.log(`       … and ${readErrors.length - 40} more`);
    console.log("\n    Do NOT read the histogram above as the whole queue — it covers");
    console.log(`    ${agedTotal} of ${countedTotal} members. A previous run reported`);
    console.log("    'pastGrace=0' with these same reads swallowed by .catch().");
  } else if (agedTotal === countedTotal && countedTotal > 0) {
    const past = oldest.filter((o) => o.age >= grace).length;
    console.log(`\n    Census COMPLETE: all ${countedTotal} parked members were aged.`);
    console.log(`    ${past} of them are past the ${H(grace)} grace.`);
    if (past === 0) {
      console.log("    The earlier pastGrace=0 was REAL, not a swallowed error — the queue");
      console.log("    is young and draining. Parked starvation is not currently firing.");
    } else {
      console.log("    These are members checkUpkeep should be queueing and is not.");
      console.log("    Compare against the checkUpkeep output in diag_keeper_discovery.js.");
    }
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
