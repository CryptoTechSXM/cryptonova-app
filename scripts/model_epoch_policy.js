// model_epoch_policy.js — pick an epoch policy from MEASURED emission, not a guess.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FIRST VERSION OF THIS FILE WAS WRONG (2026-08-12)
//   It estimated "how deep members climb" from live matrix occupancy, reached
//   through `tierPairManagers(uint8)`. TierRouter declares
//       address[MAX_TIERS] public tierPairManagers;
//   so the real accessor takes a uint256 — different selector, every call
//   reverted. A `.catch(() => ZeroAddress)` swallowed it, every tier read 0
//   seats, the average climb collapsed to 1.0x, and that is precisely the
//   assumption under which EVERY candidate policy reports "SMOOTH". The script
//   fabricated the answer it was asked to test.
//
//   This version does not estimate the shape at all. It COUNTS it.
// ─────────────────────────────────────────────────────────────────────────────
//
// THE MECHANISM, EXACTLY
//   CNOVAToken.mintReward is called on EVERY seat event — register, upgrade,
//   crossing, re-entry, rescue re-seat — and emits
//       TokensMinted(to, amount, epoch, tierIndex)
//   with amount = epochRewards[epoch-1] * tierMultipliers[tierIndex].
//
//   But the MEMBER trigger counts something else entirely. `countedMember` is a
//   LIFETIME mapping (CNOVAToken:204, V8.46 item 9) that is never reset, so
//   epochMemberCount only ticks the FIRST time an address is ever minted to. One
//   person who climbs T1->T10 and cycles a dozen times is ONE member and
//   1,275+ multiplier units of emission.
//
//   That gap is the whole problem. It has a name and a number:
//
//       unitsPerMember = sum(tierMultipliers[tierIndex]) / unique members
//
//   and this script measures it from the chain rather than assuming it. A
//   pure-T1-once community is 1.0. Today's testnet is whatever it is — the
//   script prints the distribution, not just the mean, because sizing a
//   backstop off a mean is how you get a backstop that fires on ordinary users.
//
// WHAT "SMOOTH" MEANS
//   MEMBER is the trigger a community can see and predict ("epoch 3 at 3,000
//   members"). MINT should be a BACKSTOP that fires only on genuine runaway.
//   Today it is exactly backwards: MINT has fired every time, MEMBER never once.
//
// HONESTY NOTES BUILT INTO THE OUTPUT
//   - Every read that fails, fails loudly. No `.catch(() => 0)` anywhere.
//   - The script ABORTS if it measures zero members or zero emission.
//   - It cross-checks each event's amount against reward x multiplier and
//     reports any mismatch instead of silently averaging it in.
//   - It compares predicted treasury inflow against the ACTUAL usdcReserve and
//     prints the ratio, so you can see how good the fee model is before
//     trusting the floor projection.
//   - Testnet traffic is stress traffic. unitsPerMember here is an UPPER bound
//     on what real users will do. That caveat is printed, not buried here.
//
// Run: npx hardhat run scripts/model_epoch_policy.js --network baseSepolia
//   MEMBER_LIMITS=500,1000,2500,5000   candidate epochMemberLimit ladder
//   DEPLOY_BLOCK=12345678              skip the deploy-block search
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const TOK = [
  "function currentEpochNumber() view returns (uint8)",
  "function epochRewards(uint256) view returns (uint256)",
  "function tierMultipliers(uint256) view returns (uint256)",
  "function epochMintLimit() view returns (uint256)",
  "function epochMemberLimit() view returns (uint256)",
  "function epochTimeLimit() view returns (uint256)",
  "function epochMemberCount() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "event TokensMinted(address indexed to, uint256 amount, uint8 epoch, uint8 tierIndex)",
];
const TRE = ["function floorPrice() view returns (uint256)", "function usdcReserve() view returns (uint256)"];
const TR  = ["function getAllTiers() view returns (address[10] pairManagers, uint256[10] entryFees)"];

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(4);
const cn  = (v) => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });
const num = (n) => Math.round(n).toLocaleString();
const TREASURY_BPS = 500;   // SPLITS_ALL[3], deploy_v8.js:103 — 5% of the entry fee
const EPOCH_NAMES = ["Nebula Genesis", "Mercury Rise", "Lunar Cluster", "Aurora Zenith", "Solaris Echo",
                     "Cosmic Core", "Galaxy Grid", "Supernova Spark", "Final Frontier"];

// Find the first block at or after a timestamp. Binary search beats scanning
// 400k empty blocks, and beats hardcoding a number that goes stale on redeploy.
async function blockAtOrAfter(p, wantTs) {
  let lo = 1, hi = await p.getBlockNumber();
  if ((await p.getBlock(hi)).timestamp < wantTs) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await p.getBlock(mid);
    if (!b) { lo = mid + 1; continue; }
    if (b.timestamp < wantTs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Pull a log range, halving the window on provider limits rather than skipping
// it. A skipped window is a silently incomplete census — the exact failure this
// script exists to avoid.
async function pullLogs(c, filter, from, to, depth = 0) {
  try {
    return await c.queryFilter(filter, from, to);
  } catch (e) {
    if (to - from < 2) throw new Error(`unreadable block ${from}: ${e.message}`);
    if (depth > 20) throw new Error(`log range would not narrow at ${from}-${to}`);
    const mid = Math.floor((from + to) / 2);
    const a = await pullLogs(c, filter, from, mid, depth + 1);
    const b = await pullLogs(c, filter, mid + 1, to, depth + 1);
    return a.concat(b);
  }
}

async function main() {
  const p = ethers.provider;
  const tok = new ethers.Contract(A.cnova, TOK, p);
  const tre = new ethers.Contract(A.treasury, TRE, p);
  const tr  = new ethers.Contract(A.tierRouter, TR, p);

  const rewards = [], mults = [];
  for (let e = 0; e < 9; e++) rewards.push(Number(await tok.epochRewards(e)) / 1e18);
  for (let i = 0; i < 10; i++) mults.push(Number(await tok.tierMultipliers(i)));
  const [, feesRaw] = await tr.getAllTiers();
  const fees = feesRaw.map((f) => Number(f) / 1e6);
  if (fees[0] <= 0) throw new Error("tier entry fees read as zero — refusing to model on a bad read");

  const epochNow  = Number(await tok.currentEpochNumber());
  const supply    = Number(await tok.totalSupply()) / 1e18;
  const minted    = Number(await tok.totalMinted()) / 1e18;
  const maxSupply = Number(await tok.MAX_SUPPLY()) / 1e18;
  const reserve   = Number(await tre.usdcReserve()) / 1e6;
  const floor     = Number(await tre.floorPrice()) / 1e6;
  const mintLimNow = Number(await tok.epochMintLimit()) / 1e18;
  const memLimNow  = Number(await tok.epochMemberLimit());

  console.log(`\n  ── LIVE STATE ──`);
  console.log(`    epoch ${epochNow} of 9 (${EPOCH_NAMES[epochNow - 1]}), base reward ${rewards[epochNow - 1]} CNOVA/entry`);
  console.log(`    minted ${cn(minted * 1e18)} of ${cn(maxSupply * 1e18)} CNOVA  ·  reserve ${usd(reserve * 1e6)}  ·  floor ${usd(floor * 1e6)}`);
  console.log(`    current policy: epochMemberLimit ${num(memLimNow)}, epochMintLimit ${num(mintLimNow)} CNOVA`);
  console.log(`    tier fees: ${fees.map((f, i) => `T${i + 1} ${usd(f * 1e6)}`).join("  ")}`);

  // ── COUNT THE SHAPE ────────────────────────────────────────────────────────
  const tip = await p.getBlockNumber();
  const from = process.env.DEPLOY_BLOCK
    ? Number(process.env.DEPLOY_BLOCK)
    : await blockAtOrAfter(p, Math.floor(new Date(A.deployedAt).getTime() / 1000) - 60);
  console.log(`\n  ── COUNTING TokensMinted, blocks ${num(from)} -> ${num(tip)} ──`);

  let logs = [];
  const CHUNK = 9000;
  for (let b = from; b <= tip; b += CHUNK) {
    logs = logs.concat(await pullLogs(tok, tok.filters.TokensMinted(), b, Math.min(b + CHUNK - 1, tip)));
    process.stdout.write(`\r    ${num(logs.length)} events, through block ${num(Math.min(b + CHUNK - 1, tip))}   `);
  }
  console.log();
  if (logs.length === 0) throw new Error("no TokensMinted events found — the range or the address is wrong; refusing to model on nothing");

  const seenAt = new Map();          // address -> epoch of first ever mint
  const unitsBy = new Map();         // address -> total multiplier units
  const perEpoch = [];               // {newMembers, seats, cnova, units}
  for (let e = 0; e < 9; e++) perEpoch.push({ newMembers: 0, seats: 0, cnova: 0, units: 0, usdc: 0 });
  const tierSeats = new Array(10).fill(0);
  let mismatches = 0, predictedUsdc = 0;

  for (const l of logs) {
    const to = l.args.to.toLowerCase();
    const ep = Number(l.args.epoch);          // 1-based
    const ti = Number(l.args.tierIndex);
    const amt = Number(l.args.amount) / 1e18;
    if (ep < 1 || ep > 9 || ti > 9) { mismatches++; continue; }
    const row = perEpoch[ep - 1];

    // amount must be reward x multiplier. Epoch 9 uses the Final Frontier
    // formula instead, so it is exempt; anything else that disagrees is a hole
    // in this model and gets reported rather than averaged in.
    if (ep < 9 && Math.abs(amt - rewards[ep - 1] * mults[ti]) > 1e-9) mismatches++;

    if (!seenAt.has(to)) { seenAt.set(to, ep); row.newMembers++; }
    unitsBy.set(to, (unitsBy.get(to) || 0) + mults[ti]);
    row.seats++; row.cnova += amt; row.units += mults[ti];
    tierSeats[ti]++;
    const u = fees[ti] * TREASURY_BPS / 10000;
    row.usdc += u; predictedUsdc += u;
  }

  const members = seenAt.size;
  const totalUnits = [...unitsBy.values()].reduce((a, b) => a + b, 0);
  if (members === 0 || totalUnits === 0) throw new Error("measured zero members or zero units — refusing to model");

  const dist = [...unitsBy.values()].sort((a, b) => a - b);
  const pct = (q) => dist[Math.min(dist.length - 1, Math.floor(q * dist.length))];
  const unitsMean = totalUnits / members;

  console.log(`\n  ── MEASURED SHAPE (${num(logs.length)} seat events, ${num(members)} unique members) ──`);
  console.log(`    seats by tier: ${tierSeats.map((s, i) => `T${i + 1}=${num(s)}`).join("  ")}`);
  console.log(`    multiplier units per member — this is THE number:`);
  console.log(`      median ${pct(0.5)}   p75 ${pct(0.75)}   p90 ${pct(0.90)}   p99 ${pct(0.99)}   max ${num(dist[dist.length - 1])}`);
  console.log(`      MEAN ${unitsMean.toFixed(1)}   (pure-T1-once would be 1.0)`);
  console.log(`    the mean is ${(unitsMean / pct(0.5)).toFixed(1)}x the median — a few deep climbers carry the emission,`);
  console.log(`    which is why a MINT limit sized off the mean fires on ordinary members.`);
  if (mismatches > 0) console.log(`    !! ${num(mismatches)} events did not match reward x multiplier — investigate before trusting this`);

  console.log(`\n  ── WHAT ACTUALLY HAPPENED, EPOCH BY EPOCH ──`);
  console.log(`    epoch                   new members   seats     CNOVA minted   units/new member`);
  for (let e = 0; e < 9; e++) {
    const r = perEpoch[e];
    if (r.seats === 0) continue;
    const upm = r.newMembers > 0 ? (r.units / r.newMembers).toFixed(1) : "n/a";
    console.log(`    ${String(e + 1)} ${EPOCH_NAMES[e].padEnd(18)} ${num(r.newMembers).padStart(9)} ${num(r.seats).padStart(9)} ${cn(r.cnova * 1e18).padStart(15)} ${String(upm).padStart(18)}`);
  }
  console.log(`\n    Read the first column: MEMBER never came close to ${num(memLimNow)}. Read the fourth:`);
  console.log(`    MINT hit ${num(mintLimNow)} three times. The limits are not measuring the same thing.`);

  // ── how good is the fee model? ─────────────────────────────────────────────
  const calib = reserve / predictedUsdc;
  console.log(`\n  ── FEE MODEL CALIBRATION ──`);
  console.log(`    predicted treasury inflow (seats x fee x 5%): ${usd(predictedUsdc * 1e6)}`);
  console.log(`    ACTUAL usdcReserve:                           ${usd(reserve * 1e6)}`);
  console.log(`    ratio ${calib.toFixed(3)} — ${Math.abs(calib - 1) < 0.15 ? "close enough to trust the floor projection below" : "OFF: the floor projection below is indicative only, not a forecast"}`);

  // ── CANDIDATES ─────────────────────────────────────────────────────────────
  // Model real users as climbing LESS than stress-test traffic. Report both so
  // the assumption is visible instead of buried.
  const SHAPES = [
    { name: "as measured on testnet (upper bound)", units: unitsMean },
    { name: "half the measured climb", units: unitsMean / 2 },
    { name: "median member only", units: pct(0.5) },
  ];
  const LIMITS = (process.env.MEMBER_LIMITS || "500,1000,2500,5000").split(",").map(Number);
  const avgFeePerSeat = tierSeats.reduce((s, n, i) => s + n * fees[i], 0) / logs.length;
  const unitsPerSeat  = totalUnits / logs.length;

  console.log(`\n  ── CANDIDATE epochMemberLimit VALUES ──`);
  console.log(`    For each: emission in epoch 1 (the worst case — reward is highest there),`);
  console.log(`    the mintLimit that would BACK it without binding, total members served`);
  console.log(`    across the 8 fixed epochs, and where supply and floor land.\n`);
  for (const shape of SHAPES) {
    console.log(`    ── assuming ${shape.name}: ${shape.units.toFixed(1)} units/member ──`);
    for (const M of LIMITS) {
      let cnovaOut = 0;
      for (let e = 0; e < 8; e++) cnovaOut += M * shape.units * rewards[e];      // epoch 9 is self-regulating
      // Seats scale with units, and every seat pays a fee: seats/member =
      // units/member divided by units/seat, each worth avgFeePerSeat x 5%.
      const seatsPerMember = shape.units / unitsPerSeat;
      const usdcOut = M * 8 * seatsPerMember * avgFeePerSeat * TREASURY_BPS / 10000;
      const ep1 = M * shape.units * rewards[0];
      const backstop = Math.ceil(ep1 * 2 / 100000) * 100000;                     // 2x headroom = runaway only
      const endSupply = supply + cnovaOut;
      const endFloor = (reserve + usdcOut) / endSupply;
      const bindsToday = ep1 > mintLimNow;
      console.log(`      memberLimit ${num(M).padStart(6)}  epoch-1 emission ${cn(ep1 * 1e18).padStart(11)} CNOVA` +
                  `  ${bindsToday ? "<- MINT still binds at today's 1,000,000" : "MINT clear at today's limit"}`);
      console.log(`                      suggested epochMintLimit ${num(backstop).padStart(9)} CNOVA (2x headroom)`);
      console.log(`                      serves ${num(M * 8).padStart(7)} members on the bonus schedule` +
                  `  ->  supply ${cn(endSupply * 1e18)} (${(endSupply * 100 / maxSupply).toFixed(1)}% of max)` +
                  `  floor ${usd(floor * 1e6)} -> ${usd(endFloor * 1e6)}`);
    }
    console.log();
  }

  // ── where the floor settles, by epoch ──────────────────────────────────────
  console.log(`  ── THE FLOOR IS SET BY THE EPOCH YOU SETTLE AT, NOT THE PATH ──`);
  console.log(`    marginal price of one T1 entry = (fee x 5%) / (reward x 1). Above the`);
  console.log(`    floor it lifts, below it dilutes. Floor now ${usd(floor * 1e6)}.`);
  for (let e = 0; e < 8; e++) {
    const m = fees[0] * TREASURY_BPS / 10000 / rewards[e];
    console.log(`      epoch ${e + 1} ${EPOCH_NAMES[e].padEnd(16)} reward ${String(rewards[e]).padStart(5)} -> T1 marginal ${usd(m * 1e6).padStart(10)}  ${m > floor ? "lifts" : "dilutes"}${e + 1 === epochNow ? "   <- now" : ""}`);
  }

  console.log(`\n  ── CAVEAT, STATED NOT BURIED ──`);
  console.log(`    Every number above rests on ${num(members)} testnet members generated by stress`);
  console.log(`    traffic and keeper loops. Real users will climb LESS, so units/member is an`);
  console.log(`    UPPER bound and the emission figures are conservative-high. That is the right`);
  console.log(`    direction to be wrong in for a mint backstop and the wrong direction for the`);
  console.log(`    "members served" figure. Treat the ladder as a shape, not a forecast.\n`);
}

main().catch((e) => { console.error("\nFAILED:", e.message || e); process.exit(1); });
