// diag_parked_experiment.js — THE PARKED NEAR-EXPERIMENT (handoff 13.9 item 1).
//
// THE QUESTION (13.5): every member who took a co-pay rescue was PARKED WITH A SHORTFALL at
// the moment of the loan — and so were the members who SELF-RESCUED with their own money, and
// so were the ones who STAYED PARKED until they were evicted. Same starting condition, four
// outcomes. Does the loan HELP, or were the borrowers already sinking?
//
// ⛔⛔ READ THIS BEFORE READING ANY NUMBER THIS SCRIPT PRINTS.
//
// 13.5 justified the design like this: *"the keeper picks co-pay recipients by walking a
// queue rather than by merit. That is as close to random assignment as this chain offers."*
// THAT IS WRONG, AND IT WAS WRONG WHEN IT WAS WRITTEN. It was a guess about the selector that
// nobody had read. The selector is `MatrixKeeperLib._triageParked` and it refuses a parked
// member on FOUR explicit tests before any rescue is queued:
//
//   EVICT_GHOST   the parked record is stale bookkeeping             (not about the member)
//   EVICT_RATIO   withdrawn / claimableEver > rescueRatioBps         ⛔ MERIT
//   EVICT_LADDER  (crossingReserve + withdrawable) / crossingCost
//                 below the BOTTOM RUNG of sfRescueThresholds        ⛔ MERIT — a WEALTH FILTER
//   EVICT_FLOOR   StabilityFund.loanEligibleFor(member,tier,advance)
//                 fails — existing debt already at the ceiling       ⛔ MERIT — a CREDIT FILTER
//
// The queue walk (`_scanParked`, index 0..parkedCount) sets the ORDER and the truncation at
// maxItemsPerUpkeep. It does not decide WHO QUALIFIES. Selection into the rescued arm is
// POSITIVE on wealth and POSITIVE on creditworthiness, which is the exact direction that makes
// "the rescued did better" a foregone conclusion.
//
// The second rescue path is `scripts/corescue_keeper.js`, run by hand: it walks the same queue
// and calls `coPayRescue` on EVERY parked wallet with no ladder or ratio test of its own — but
// `StabilityFund.payCoRescue` still enforces the insolvency floor and reverts, and the script
// estimateGas-es first and silently `continue`s on failure. So the floor filter survives even
// on the "unfiltered" path. There is no unfiltered arm anywhere.
//
// SO THIS SCRIPT DOES NOT REPORT A TREATMENT EFFECT AND MUST NEVER BE QUOTED AS ONE.
// What it does instead, in this order:
//   SECTION 2  BALANCE CHECK FIRST, OUTCOMES SECOND. The pre-treatment state of each arm,
//              measured off `MemberParked.shortfall`, which IS the ladder variable:
//              contribBps = 10000 - shortfall*10000/crossingCost. If the arms differ here,
//              every outcome difference in section 3 is explained before it is measured.
//   SECTION 4  THE ONE COMPARISON THAT SURVIVES — a narrow window either side of the ladder's
//              bottom rung. Two members a few basis points apart, one rescued and one evicted
//              by a hard cutoff, are genuinely comparable. This is a regression-discontinuity
//              window, and it is the only part of this output with a causal reading.
//
// ⚠ TRAPS INHERITED FROM SESSIONS 12/13 — DO NOT REINTRODUCE:
//  1. `MemberParked` has six emit sites and only two carry a real shortfall. Only shortfall>0
//     episodes are the experiment; shortfall==0 parks are counted and set aside.
//  2. "the SF emitted a log in this tx" is NOT a loan. FundDeposit fires on every entry.
//     The loan signal is `MemberDebtIncreased`, nothing else.
//  3. A DEBT SNAPSHOT IS NOT A REPAYMENT HISTORY — both debt events, all blocks.
//  4. AN INSTRUMENT MUST NOT REPORT THE ABSENCE OF WHAT IT CANNOT OBSERVE. Every rescue path
//     ends in `_finalizeCrossing`, which emits `MemberCrossedToPartner` + `CrossingFunded`,
//     so a keeper rescue IS visible even when it books no loan. Forward-hop success is
//     `MemberReentered` on the TierRouter, never `MemberCrossedToPartner` at MatB.
//  5. A CONTROL GROUP IS NOT OPTIONAL (13.8). Everything is computed for ORGANIC and for
//     BIGFILL side by side. BIGFILL is a known machine: if the two panels tell the same
//     story, the story is about the mechanism, not about members.
//  6. IF FILL_MNEMONIC IS MISSING, EVERY BIGFILL WALLET LANDS IN ORGANIC AND THE ORGANIC
//     PANEL READS BEAUTIFULLY. Hard exit, not a warning.
//
// Read-only. Nothing is written to chain.
//
// Run: npx hardhat run scripts/diag_parked_experiment.js --network baseSepolia
// Env: TIERS=1,2,3  CHUNK=4000  COHORT_MAX=1200  RD_WINDOW=1500  ADDRESSES_FILE=...
// ⛔ SELFTEST RUNS BEFORE ANY require OF hardhat OR THE ADDRESS BOOK, ON PURPOSE.
//    Sections 5 and 6 are pure aggregation and need neither a chain nor a deployment
//    artifact; gating them here is what lets them be exercised on a machine that has
//    neither. Function declarations hoist, so `selftest` is defined by the time this runs.
if (process.env.SELFTEST === "1") {
  console.log("\n  SELFTEST — sections 5/6 aggregation (no chain, no address book)\n");
  selftest();
}

const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS      = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK      = Number(process.env.CHUNK || 4000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 1200);
const RD_WINDOW  = Number(process.env.RD_WINDOW || 1500);   // bps either side of the ladder rung

const lc  = (a) => String(a).toLowerCase();
const usd = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
const pct = (n, d) => d ? `${(n * 100 / d).toFixed(1)}%` : "  n/a";
const pad = (s, n) => String(s).padStart(n);

/* ── event vocabulary ─────────────────────────────────────────────────────── */
const MATRIX_ABI = [
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed)",
  "event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)",
  "event MemberEvicted(address indexed member, uint256 totalWithdrawn)",
  "event GhostDequeued(address indexed member, uint256 staleParkedAt)",
  "event MemberCrossedToPartner(address indexed member, address fromMatrix, address toMatrix)",
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)",
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
];
const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];
const TR_ABI = [
  "event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)",
  "event MemberReentered(address indexed member, uint8 tier)",
];
const PM_ABI = ["function pairCount() view returns (uint256)",
                "function getPairAt(uint256) view returns (address,address)"];
const MAT_VIEW = ["function ENTRY_FEE() view returns (uint256)",
                  "function isMatrixA() view returns (bool)"];
const MK_ABI = ["function sfRescueLadderPreset() view returns (uint8)",
                "function sfRescueThresholds(uint256) view returns (uint256)",
                "function sfRescueBpsLadder(uint256) view returns (uint256)",
                "function rescueRatioBps() view returns (uint256)",
                "function crossingBufferBps() view returns (uint256)",
                "function maxItemsPerUpkeep() view returns (uint256)"];
const SF_VIEW = ["function insolvencyFloorBps() view returns (uint256)"];

/* ── log scanning: ONE getLogs per chunk covering every matrix and every event.
 *    Six separate queryFilter calls per matrix per chunk would be ~6x the RPC traffic
 *    and this range is ~310k blocks. Subdivides on failure, records unreadable gaps. */
const gaps = [];
async function scanLogs(addresses, topic0s, from, to, span) {
  const out = [];
  for (let b = from; b <= to; b += span) {
    const end = Math.min(b + span - 1, to);
    let got = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try {
        got = await ethers.provider.getLogs({ address: addresses, topics: [topic0s], fromBlock: b, toBlock: end });
      } catch {
        if (attempt === 2) {
          if (span > 250) got = await scanLogs(addresses, topic0s, b, end, Math.floor(span / 4));
          else { gaps.push([b, end]); got = []; }
        } else await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    out.push(...got);
  }
  return out;
}

async function deployFloor(head) {
  if (process.env.FROM_BLOCK) return Number(process.env.FROM_BLOCK);
  const want = Math.floor(new Date(A.deployedAt).getTime() / 1000);
  let lo = 1, hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const blk = await ethers.provider.getBlock(mid);
    if (!blk) { lo = mid + 1; continue; }
    if (blk.timestamp < want) lo = mid + 1; else hi = mid;
  }
  return Math.max(1, lo - 50);
}

/* ── cohorts: derived, never typed in here (13.2) ─────────────────────────── */
const bigfillIndexOf = new Map();
const leaderSet = new Set();
function buildBigfill() {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("\n  ⛔ FILL_MNEMONIC is not set. STOPPING.");
    console.error("     Without it every bigfill wallet is classified ORGANIC and the organic");
    console.error("     panel reads as a triumph. That is the flattering failure mode.");
    process.exit(1);
  }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillIndexOf.set(lc(acct.deriveChild(i).address), i);
}
function buildLeaders() {
  const p = path.join(__dirname, "..", "run_bigfill_rr.ps1");
  const txt = fs.readFileSync(p, "utf8");
  const block = txt.split(/\$leaders\s*=\s*@\(/)[1];
  if (!block) { console.error("\n  ⛔ no $leaders block in run_bigfill_rr.ps1. STOPPING."); process.exit(1); }
  for (const m of block.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
  if (leaderSet.size < 10) {
    console.error(`\n  ⛔ parsed only ${leaderSet.size} leaders (expected ~41). STOPPING — a short roster`);
    console.error("     reassigns leaders to ORGANIC, which is the flattering direction.");
    process.exit(1);
  }
}
const cohortOf = (a) => bigfillIndexOf.has(lc(a)) ? "bigfill" : (leaderSet.has(lc(a)) ? "leader" : "organic");

/* ── small stats helpers. No averages without a spread beside them. ───────── */
function quantiles(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: s.length, min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1],
           mean: s.reduce((a, b) => a + b, 0) / s.length };
}

const ARMS = ["SF-LOAN", "ASSIST-NOLOAN", "SELF-RESCUE", "EVICTED", "STILL-PARKED", "GHOST"];

/* ═══════════════════════════════════════════════════════════════════════════════
 * SECTION 5 + 6 (session 24) — THE TWO CORRECTIONS 14.4 ASKED FOR, AS PURE FUNCTIONS
 *
 * 14.4 named two defects in 14.1's table and said a per-tier split "should be run before
 * this table is used to set anything":
 *
 *   (a) ONE REAL IMBALANCE, IN DOLLARS NOT RATIOS. Median shortfall was $2.65 for
 *       STILL-PARKED against $1.58 / $1.60 for the rescued arms while contribBps was the
 *       same across all three. Same ratio, bigger dollars means the never-rescued arm
 *       SKEWS TO HIGHER TIERS — and if it does, 14.1's arms are not balanced after all
 *       and every outcome difference is part treatment and part tier.
 *   (b) NO TIME-AT-RISK ADJUSTMENT. Outcomes run to the head block, so an episode that
 *       exited in week one has had longer to produce cycles than one that exited
 *       yesterday. `cycled again` and `2+ cycles` inherit that directly.
 *
 * ⛔ THESE ARE PURE FUNCTIONS ON PURPOSE. Everything above them needs a live chain; this
 *    does not. It means the aggregation can be exercised against synthetic episodes with
 *    known answers (`SELFTEST=1`) on a machine with no RPC at all — which is how the
 *    version you are reading was validated, since the session that wrote it could not
 *    reach Base Sepolia. The chain-dependent half is unchanged and unvalidated by that
 *    self-test; it is the same code that produced 14.1.
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** Median of a bigint/number array, or null. Lower median on even counts — same
 *  convention as `quantiles` above, so the two never disagree by half a step. */
function med(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return a[Math.floor((a.length - 1) / 2)];
}

/**
 * SECTION 5 — the per-tier split, and the composition check that motivates it.
 *
 * Returns { comp, cells } where
 *   comp[arm][tier]  = how many of that arm's episodes sat in that tier  (the imbalance)
 *   cells[arm][tier] = { n, twoPlus, owing, medContribBps, medShortUsd }  (the split)
 *
 * ⚠ The COMPOSITION table is the one that decides whether 14.1 can be quoted at all. The
 *   per-tier cells are what you fall back to if it cannot.
 */
function tierSplit(episodes, arms, tiers) {
  const comp = {}, cells = {};
  for (const a of arms) {
    comp[a] = {}; cells[a] = {};
    for (const t of tiers) {
      comp[a][t] = 0;
      cells[a][t] = { n: 0, twoPlus: 0, owing: 0, contribs: [], shorts: [] };
    }
  }
  for (const ep of episodes) {
    const a = ep.arm, t = ep.mat && ep.mat.tier;
    if (!comp[a] || !comp[a][t] === undefined || comp[a][t] === undefined) continue;
    comp[a][t]++;
    const c = cells[a][t];
    c.n++;
    if (ep.cyclesAfter >= 2) c.twoPlus++;
    if (ep.owingNow) c.owing++;
    c.contribs.push(ep.contribBps);
    c.shorts.push(ep.shortUsd);
  }
  for (const a of arms) for (const t of tiers) {
    const c = cells[a][t];
    c.medContribBps = med(c.contribs);
    c.medShortUsd   = med(c.shorts);
    delete c.contribs; delete c.shorts;
  }
  return { comp, cells };
}

/**
 * SECTION 6 — outcomes over an EQUAL observation window.
 *
 * ⛔ THE FIX IS A FIXED WINDOW, NOT A RATE. Dividing cycles by exposure would hand every
 *    recently-exited episode a huge denominator on one or two events and read as noise.
 *    Instead: pick a window W in blocks, KEEP only episodes with at least W blocks of
 *    exposure, and count only the cycles that landed inside (t0, t0+W]. Every surviving
 *    episode is then observed for exactly the same length of time.
 *
 * ⚠ AND CAPPING HAS ITS OWN SELECTION, WHICH IS NOT OPTIONAL TO STATE. Requiring W blocks
 *   of exposure keeps only OLDER episodes. If the population changed over the deployment,
 *   the capped table describes the early population. `censored` is returned per arm so the
 *   size of that filter is always visible next to the result — an arm that loses most of
 *   itself to the cap has not been adjusted, it has been replaced.
 *
 * @param cyclesOf (member) -> array of block numbers at which that member cycled
 */
function cappedWindow(episodes, cyclesOf, head, W, arms) {
  const out = {};
  for (const a of arms) out[a] = { eligible: 0, censored: 0, twoPlus: 0, cycledAgain: 0, exposures: [] };
  for (const ep of episodes) {
    const row = out[ep.arm];
    if (!row) continue;
    const t0 = ep.exitB ?? ep.parkB;
    const exposure = head - t0;
    row.exposures.push(exposure);
    if (exposure < W) { row.censored++; continue; }
    row.eligible++;
    const n = (cyclesOf(ep.member) || []).filter((b) => b > t0 && b <= t0 + W).length;
    if (n >= 1) row.cycledAgain++;
    if (n >= 2) row.twoPlus++;
  }
  for (const a of arms) {
    out[a].medExposure = med(out[a].exposures);
    delete out[a].exposures;
  }
  return out;
}

/** p25 of a numeric array — the default window, chosen so three quarters of the
 *  episodes survive the cap rather than a number picked to look good. */
function p25(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) * 0.25)];
}

/* ── SELFTEST — synthetic episodes, known answers, no chain ──────────────────── */
function selftest() {
  const arms = ["SF-LOAN", "SELF-RESCUE", "STILL-PARKED"];
  const tiers = ["T1", "T2"];
  const T = (t) => ({ tier: t });
  let fails = 0;
  const eq = (got, want, what) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { fails++; console.log(`  FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
    else console.log(`  ok   ${what}`);
  };

  // Deliberately lopsided: STILL-PARKED sits in T2, the rescued arms in T1 — exactly the
  // skew 14.4 suspected. If tierSplit cannot show that, it cannot do its job.
  const eps = [
    { arm: "SF-LOAN",      mat: T("T1"), cyclesAfter: 3, owingNow: true,  contribBps: 7900, shortUsd: 1.5, parkB: 10, exitB: 20 },
    { arm: "SF-LOAN",      mat: T("T1"), cyclesAfter: 0, owingNow: false, contribBps: 8100, shortUsd: 1.7, parkB: 10, exitB: 90 },
    { arm: "SELF-RESCUE",  mat: T("T1"), cyclesAfter: 2, owingNow: false, contribBps: 7800, shortUsd: 1.6, parkB: 10, exitB: 20 },
    { arm: "STILL-PARKED", mat: T("T2"), cyclesAfter: 0, owingNow: false, contribBps: 7815, shortUsd: 2.6, parkB: 20, exitB: null },
    { arm: "STILL-PARKED", mat: T("T2"), cyclesAfter: 1, owingNow: true,  contribBps: 7820, shortUsd: 2.7, parkB: 30, exitB: null },
  ];

  const { comp, cells } = tierSplit(eps, arms, tiers);
  eq(comp["SF-LOAN"], { T1: 2, T2: 0 }, "composition: SF-LOAN is entirely T1");
  eq(comp["STILL-PARKED"], { T1: 0, T2: 2 }, "composition: STILL-PARKED is entirely T2 (the skew)");
  eq(cells["SF-LOAN"]["T1"].n, 2, "cells: SF-LOAN T1 count");
  eq(cells["SF-LOAN"]["T1"].twoPlus, 1, "cells: SF-LOAN T1 reaches 2+ cycles once");
  eq(cells["SF-LOAN"]["T1"].owing, 1, "cells: SF-LOAN T1 owing count");
  eq(cells["SF-LOAN"]["T1"].medShortUsd, 1.5, "cells: lower median on an even count");
  eq(cells["STILL-PARKED"]["T1"].n, 0, "cells: an empty tier reports 0, not undefined");

  // Window. head = 100, W = 50.
  //   SF-LOAN #1  t0=20 exposure 80 >= 50 -> counts cycles in (20,70]
  //   SF-LOAN #2  t0=90 exposure 10 <  50 -> CENSORED, and this is the bias 14.4 named
  //   SELF-RESC   t0=20 exposure 80 -> eligible
  //   STILL #1    t0=20 exposure 80 -> eligible   (STILL-PARKED uses parkB)
  //   STILL #2    t0=30 exposure 70 -> eligible
  const cyc = new Map([
    ["m1", [25, 40, 95]],   // two inside (20,70], one outside -> twoPlus
    ["m3", [60]],           // one inside -> cycledAgain but not twoPlus
  ]);
  const eps2 = eps.map((e, i) => ({ ...e, member: ["m1", "m2", "m3", "m4", "m5"][i] }));
  const w = cappedWindow(eps2, (m) => cyc.get(m), 100, 50, arms);
  eq(w["SF-LOAN"].eligible, 1, "window: one SF-LOAN episode survives the cap");
  eq(w["SF-LOAN"].censored, 1, "window: the recent one is censored, not counted as a zero");
  eq(w["SF-LOAN"].twoPlus, 1, "window: cycles OUTSIDE the window do not count");
  eq(w["SELF-RESCUE"].cycledAgain, 1, "window: one cycle inside the window");
  eq(w["SELF-RESCUE"].twoPlus, 0, "window: one cycle is not two");
  eq(w["STILL-PARKED"].eligible, 2, "window: STILL-PARKED measured from parkB");
  eq(w["STILL-PARKED"].twoPlus, 0, "window: no cycles recorded for those members");
  eq(p25([10, 20, 30, 40, 50]), 20, "p25 of a five-element array");

  console.log(fails ? `\n  ⛔ SELFTEST FAILED (${fails})` : `\n  ✅ SELFTEST PASSED — the aggregation is exercised; the CHAIN half is not.`);
  process.exit(fails ? 1 : 0);
}

async function main() {
  buildBigfill();
  buildLeaders();

  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);

  console.log("=".repeat(104));
  console.log(`  THE PARKED NEAR-EXPERIMENT — ${A.network}, ${process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"}`);
  console.log(`  deployed ${A.deployedAt}   blocks ${from}..${head}  (${head - from})   MATRIX_SIZE ${A.matrixSize}`);
  console.log(`  bigfill window HD 0..${COHORT_MAX - 1}   leader roster ${leaderSet.size}   tiers ${TIERS.join(",")}`);
  console.log("=".repeat(104));

  /* ── THE BASIS. Every threshold read off the LIVE chain, never assumed from source. ── */
  const mk = await ethers.getContractAt(MK_ABI, A.matrixKeeper);
  const sfv = await ethers.getContractAt(SF_VIEW, A.stabilityFund);
  const thr = [], lad = [];
  for (let i = 0; i < 32; i++) {
    try { thr.push(Number(await mk.sfRescueThresholds(i))); lad.push(Number(await mk.sfRescueBpsLadder(i))); }
    catch { break; }
  }
  const preset = Number(await mk.sfRescueLadderPreset().catch(() => -1));
  const ratioBps = Number(await mk.rescueRatioBps().catch(() => -1));
  const bufBps = Number(await mk.crossingBufferBps().catch(() => -1));
  const maxItems = Number(await mk.maxItemsPerUpkeep().catch(() => -1));
  const floorBps = Number(await sfv.insolvencyFloorBps().catch(() => -1));
  const LADDER_BOTTOM = thr.length ? thr[thr.length - 1] : 4000;

  console.log(`\n  THE SELECTOR, AS IT IS CONFIGURED ON CHAIN RIGHT NOW`);
  console.log(`  ${"-".repeat(100)}`);
  console.log(`  sfRescueLadderPreset      ${preset}   thresholds ${thr.join("/")}`);
  console.log(`                                bps ${lad.join("/")}`);
  console.log(`  ⛔ LADDER BOTTOM RUNG      ${LADDER_BOTTOM} bps  — a parked member whose (reserve+withdrawable)`);
  console.log(`                                is below ${(LADDER_BOTTOM / 100).toFixed(0)}% of the crossing cost is EVICTED, never rescued.`);
  console.log(`  rescueRatioBps            ${ratioBps}  — withdrawn/claimableEver above this is EVICTED`);
  console.log(`  insolvencyFloorBps        ${floorBps}  — debt ceiling as bps of the member's own tier fee`);
  console.log(`  crossingBufferBps         ${bufBps}   maxItemsPerUpkeep ${maxItems}`);
  console.log(`  ⚠ ASSIGNMENT IS NOT RANDOM. Three of these four gates are merit tests. Read section 2`);
  console.log(`    before section 3, and read section 4 before believing anything causal.`);

  /* ── enumerate every matrix in scope ─────────────────────────────────────── */
  const mats = new Map();   // lc(addr) -> {addr, tier, tierNum, pair, isA, fee, cross, label}
  for (const t of TIERS) {
    const n = Number(t.slice(1));
    const pm = await ethers.getContractAt(PM_ABI, A.tiers[t].pm);
    const npairs = Number(await pm.pairCount().catch(() => 1));
    for (let p = 0; p < npairs; p++) {
      const [ma, mb] = await pm.getPairAt(p);
      for (const addr of [ma, mb]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const c = await ethers.getContractAt(MAT_VIEW, addr);
        const fee = BigInt(await c.ENTRY_FEE());
        const isA = await c.isMatrixA();
        mats.set(lc(addr), { addr, tier: t, tierNum: n, pair: p, isA, fee,
                             cross: isA ? fee / 2n : fee, label: `${t}p${p}${isA ? "A" : "B"}` });
      }
    }
  }
  console.log(`\n  matrices in scope: ${mats.size}  (${[...mats.values()].map(m => m.label).join(" ")})`);

  /* ── one sweep for every matrix event, one for the SF, one for the router ── */
  const mIface = new ethers.Interface(MATRIX_ABI);
  const mTopics = MATRIX_ABI.map(sig => mIface.getEvent(sig.match(/event (\w+)/)[1]).topicHash);
  const addrs = [...mats.values()].map(m => m.addr);

  console.log(`\n  scanning ${head - from} blocks in ${CHUNK}-block chunks … (this is the slow part)`);
  const rawM = await scanLogs(addrs, mTopics, from, head, CHUNK);

  const sfIface = new ethers.Interface(SF_ABI);
  const rawS = await scanLogs([A.stabilityFund], SF_ABI.map(s => sfIface.getEvent(s.match(/event (\w+)/)[1]).topicHash), from, head, CHUNK);
  const trIface = new ethers.Interface(TR_ABI);
  const rawT = await scanLogs([A.tierRouter], TR_ABI.map(s => trIface.getEvent(s.match(/event (\w+)/)[1]).topicHash), from, head, CHUNK);
  console.log(`  matrix logs ${rawM.length}   SF logs ${rawS.length}   router logs ${rawT.length}` +
              (gaps.length ? `   ⛔ ${gaps.length} UNREADABLE RANGES — counts below are LOWER BOUNDS` : `   ✅ no unreadable ranges`));

  /* ── decode ──────────────────────────────────────────────────────────────── */
  const dec = (iface, l) => { const p = iface.parseLog(l); return { name: p.name, args: p.args, b: l.blockNumber,
                              li: l.index ?? l.logIndex, tx: l.transactionHash, at: lc(l.address) }; };
  const evM = rawM.map(l => dec(mIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);
  const evS = rawS.map(l => dec(sfIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);
  const evT = rawT.map(l => dec(trIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);

  /* debt history, and a loan signal keyed by (tx,member) — trap 2 */
  const loanKey = new Set(), debtEvents = new Map();
  for (const e of evS) {
    const m = lc(e.args.member);
    if (e.name === "MemberDebtIncreased") loanKey.add(`${e.tx}|${m}`);
    if (!debtEvents.has(m)) debtEvents.set(m, []);
    debtEvents.get(m).push({ b: e.b, d: e.name === "MemberDebtIncreased" ? BigInt(e.args.amount) : -BigInt(e.args.amount) });
  }
  const debtAt = (m, blk) => (debtEvents.get(m) || []).reduce((s, x) => x.b <= blk ? s + x.d : s, 0n);
  const debtNow = (m) => debtAt(m, head);

  /* directs, at a block and lifetime */
  const directBlocks = new Map();
  for (const e of evT) {
    if (e.name !== "MemberRegistered") continue;
    const r = lc(e.args.referrer);
    if (r === lc(ethers.ZeroAddress)) continue;
    if (!directBlocks.has(r)) directBlocks.set(r, []);
    directBlocks.get(r).push(e.b);
  }
  const directsAt = (m, blk) => (directBlocks.get(m) || []).filter(b => b <= blk).length;

  /* forward-hop clearances and later cycle-outs, per member, ascending */
  const reentBlocks = new Map(), cycleBlocks = new Map();
  for (const e of evT) if (e.name === "MemberReentered") {
    const m = lc(e.args.member); if (!reentBlocks.has(m)) reentBlocks.set(m, []); reentBlocks.get(m).push(e.b);
  }
  for (const e of evM) if (e.name === "MemberCycledOut") {
    const m = lc(e.args.member); if (!cycleBlocks.has(m)) cycleBlocks.set(m, []); cycleBlocks.get(m).push(e.b);
  }
  const countAfter = (map, m, blk) => (map.get(m) || []).filter(b => b > blk).length;

  /* WHICH SELECTOR DID THE WORK. The two rescue paths have DIFFERENT filters:
   *   forceCrossKeeper — the automated keeper, gated by ghost/ratio/ladder/floor
   *   coPayRescue      — corescue_keeper.js by hand, gated by the SF floor ONLY
   * If one path dominates, that path's filter is the selection story. */
  const rescueType = new Map();
  for (const e of evM) if (e.name === "RescueLoanIssued") rescueType.set(`${e.tx}|${lc(e.args.member)}`, e.args.rescueType);

  /* ── EPISODE CONSTRUCTION ────────────────────────────────────────────────── *
   * Per (matrix, member) walk the timeline. A park with shortfall>0 OPENS an episode;
   * the first exit event CLOSES it. Anything that does not fit is COUNTED AND PRINTED —
   * an instrument that silently drops what it cannot classify is how 13.8's defects shipped. */
  const EXITS = { CoPayRescue: 1, SelfRescue: 1, MemberEvicted: 1, GhostDequeued: 1, MemberCrossedToPartner: 1 };
  const byKey = new Map();
  for (const e of evM) {
    if (e.name === "MemberCycledOut" || e.name === "RescueLoanIssued") continue;
    if (e.name !== "MemberParked" && !EXITS[e.name]) continue;
    const k = `${e.at}|${lc(e.args.member)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const episodes = [];
  let parkZero = 0, freeCrossing = 0, reparkInEpisode = 0, sameTxTail = 0;
  for (const [k, list] of byKey) {
    const [matAddr, member] = k.split("|");
    const M = mats.get(matAddr);
    if (!M) continue;
    let open = null, closedTx = null;
    for (const e of list) {
      if (e.name === "MemberParked") {
        if (BigInt(e.args.shortfall) === 0n) { parkZero++; continue; }        // trap 1
        if (open) { reparkInEpisode++; continue; }
        open = { member, mat: M, parkB: e.b, shortfall: BigInt(e.args.shortfall), tx: e.tx };
      } else {
        if (!open) {
          // Every rescue emits its own event AND _finalizeCrossing's MemberCrossedToPartner
          // in the SAME tx, so the second one arrives after the episode already closed.
          // That is expected bookkeeping, not an anomaly. A MemberCrossedToPartner in some
          // OTHER tx is an ordinary self-funded crossing by a member who was never parked.
          if (e.tx === closedTx) sameTxTail++; else freeCrossing++;
          continue;
        }
        open.exit = e.name; open.exitB = e.b; open.exitTx = e.tx;
        episodes.push(open); open = null; closedTx = e.tx;
      }
    }
    if (open) { open.exit = null; episodes.push(open); }
  }

  /* classify + attach covariates and outcomes */
  for (const ep of episodes) {
    const loaned = ep.exitTx ? loanKey.has(`${ep.exitTx}|${ep.member}`) : false;
    ep.arm = ep.exit === null                     ? "STILL-PARKED"
           : ep.exit === "MemberEvicted"          ? "EVICTED"
           : ep.exit === "GhostDequeued"          ? "GHOST"
           : ep.exit === "SelfRescue"             ? "SELF-RESCUE"
           : loaned                               ? "SF-LOAN"
           :                                        "ASSIST-NOLOAN";
    ep.cohort = cohortOf(ep.member);
    // THE LADDER VARIABLE, reconstructed from the park event itself:
    //   shortfall = crossingCost - (crossingReserve + withdrawable)  =>  contrib = cost - shortfall
    const cost = ep.mat.cross;
    ep.contribBps = cost > 0n ? Number(((cost > ep.shortfall ? cost - ep.shortfall : 0n) * 10000n) / cost) : 0;
    ep.shortUsd = Number(ep.shortfall) / 1e6;
    ep.debtAtPark = Number(debtAt(ep.member, ep.parkB)) / 1e6;
    ep.directsAtPark = directsAt(ep.member, ep.parkB);
    const t0 = ep.exitB ?? ep.parkB;
    ep.cyclesAfter = countAfter(cycleBlocks, ep.member, t0);
    ep.reentAfter  = countAfter(reentBlocks, ep.member, t0);
    ep.owingNow    = debtNow(ep.member) > 0n;
    ep.rescueType  = ep.exitTx ? (rescueType.get(`${ep.exitTx}|${ep.member}`) || null) : null;
  }

  /* ── SECTION 1 — RECONCILIATION ──────────────────────────────────────────── */
  const parksWithShortfall = episodes.length;
  console.log(`\n  ${"=".repeat(100)}`);
  console.log(`  1. THE POPULATION — every park WITH A SHORTFALL, and what happened to it`);
  console.log(`  ${"=".repeat(100)}`);
  const armCount = {}; for (const a of ARMS) armCount[a] = 0;
  for (const ep of episodes) armCount[ep.arm]++;
  const summed = ARMS.reduce((s, a) => s + armCount[a], 0);
  for (const a of ARMS) console.log(`  ${a.padEnd(22)}${pad(armCount[a], 7)}${pad(pct(armCount[a], parksWithShortfall), 9)}`);
  console.log(`  ${"-".repeat(38)}`);
  console.log(`  ${"episodes".padEnd(22)}${pad(parksWithShortfall, 7)}`);
  console.log(`  ${"arms sum to".padEnd(22)}${pad(summed, 7)}   ${summed === parksWithShortfall ? "✅" : "⛔ DOES NOT RECONCILE"}`);
  console.log(`\n  set aside, printed so nothing is silently dropped:`);
  console.log(`    parks with shortfall == 0 (the four non-affordability emit sites)   ${parkZero}`);
  console.log(`    same-tx tail events (_finalizeCrossing after its own rescue event)  ${sameTxTail}`);
  console.log(`    crossings/exits by members who were NOT parked (ordinary crossings) ${freeCrossing}`);
  console.log(`    a second park while an episode was open                             ${reparkInEpisode}`);

  const byType = new Map();
  for (const ep of episodes) if (ep.rescueType) byType.set(ep.rescueType, (byType.get(ep.rescueType) || 0) + 1);
  console.log(`\n  WHICH SELECTOR ISSUED THE LOAN — and therefore WHICH FILTER produced the rescued arm:`);
  if (!byType.size) console.log(`    (no RescueLoanIssued inside any episode's exit tx)`);
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    const note = t === "forceCrossKeeper" ? "automated keeper — ghost/ratio/LADDER/floor gates"
               : t === "coPayRescue"      ? "corescue_keeper.js by hand — SF FLOOR gate only"
               : "";
    console.log(`    ${t.padEnd(20)}${pad(n, 6)}   ${note}`);
  }

  /* ── panels ──────────────────────────────────────────────────────────────── */
  const panel = (cohort) => {
    const eps = episodes.filter(e => e.cohort === cohort && e.arm !== "GHOST");
    console.log(`\n  ${"=".repeat(100)}`);
    console.log(`  COHORT: ${cohort.toUpperCase()}   ${eps.length} episodes`);
    console.log(`  ${"=".repeat(100)}`);
    if (!eps.length) { console.log("  (none)"); return; }

    /* SECTION 2 — BALANCE FIRST */
    console.log(`\n  2. BALANCE CHECK — WHAT THE ARMS LOOKED LIKE **BEFORE** ANYTHING HAPPENED TO THEM.`);
    console.log(`     contribBps = (crossingReserve+withdrawable) as bps of the crossing cost, taken from`);
    console.log(`     the park event's own shortfall. THE LADDER EVICTS BELOW ${LADDER_BOTTOM}.`);
    console.log(`     ⛔ IF THESE ROWS DIFFER, SECTION 3 IS EXPLAINED BEFORE IT IS MEASURED.`);
    console.log(`\n  ${"arm".padEnd(16)}${pad("n", 6)}${pad("contrib min", 13)}${pad("p25", 7)}${pad("med", 7)}${pad("p75", 7)}` +
                `${pad("max", 7)}${pad("shortfall$", 12)}${pad("debt@park$", 12)}${pad("directs@park", 14)}`);
    console.log("  " + "-".repeat(98));
    for (const a of ARMS) {
      if (a === "GHOST") continue;
      const g = eps.filter(e => e.arm === a);
      if (!g.length) { console.log(`  ${a.padEnd(16)}${pad(0, 6)}`); continue; }
      const q = quantiles(g.map(e => e.contribBps));
      const s = quantiles(g.map(e => e.shortUsd));
      const d = quantiles(g.map(e => e.debtAtPark));
      const r = quantiles(g.map(e => e.directsAtPark));
      console.log(`  ${a.padEnd(16)}${pad(q.n, 6)}${pad(q.min, 13)}${pad(q.p25, 7)}${pad(q.med, 7)}${pad(q.p75, 7)}` +
                  `${pad(q.max, 7)}${pad(s.med.toFixed(2), 12)}${pad(d.med.toFixed(2), 12)}${pad(r.mean.toFixed(2), 14)}`);
    }
    console.log(`  (shortfall / debt columns are MEDIANS; directs is a mean because it is mostly 0)`);

    /* how many episodes were even ELIGIBLE by the ladder */
    const above = eps.filter(e => e.contribBps >= LADDER_BOTTOM).length;
    console.log(`\n  episodes at or above the ladder bottom rung (${LADDER_BOTTOM} bps): ${above} / ${eps.length}` +
                `  (${pct(above, eps.length)})  — the rest CANNOT be rescued by the keeper at all`);

    /* SECTION 3 — outcomes, with the caveat attached to the table itself */
    console.log(`\n  3. WHAT HAPPENED NEXT — ⚠ NOT A TREATMENT EFFECT. READ SECTION 2 FIRST.`);
    console.log(`\n  ${"arm".padEnd(16)}${pad("n", 6)}${pad("cycled again", 14)}${pad("cleared hop", 13)}` +
                `${pad("2+ cycles", 11)}${pad("owing now", 11)}${pad("med contrib", 13)}`);
    console.log("  " + "-".repeat(84));
    for (const a of ARMS) {
      if (a === "GHOST") continue;
      const g = eps.filter(e => e.arm === a);
      if (!g.length) { console.log(`  ${a.padEnd(16)}${pad(0, 6)}`); continue; }
      const cyc = g.filter(e => e.cyclesAfter > 0).length;
      const hop = g.filter(e => e.reentAfter > 0).length;
      const two = g.filter(e => e.cyclesAfter >= 2).length;
      const ow  = g.filter(e => e.owingNow).length;
      const q = quantiles(g.map(e => e.contribBps));
      console.log(`  ${a.padEnd(16)}${pad(g.length, 6)}${pad(pct(cyc, g.length), 14)}${pad(pct(hop, g.length), 13)}` +
                  `${pad(pct(two, g.length), 11)}${pad(pct(ow, g.length), 11)}${pad(q.med, 13)}`);
    }

    /* SECTION 4 — THE DISCONTINUITY WINDOW */
    console.log(`\n  4. ⛔ THE ONLY CAUSAL READING IN THIS OUTPUT — THE LADDER CUTOFF AT ${LADDER_BOTTOM} bps.`);
    console.log(`     Members within ±${RD_WINDOW} bps of the rung are near-identical on the variable the`);
    console.log(`     selector uses, but the ones BELOW are refused by a hard threshold. Compare across it.`);
    const lo = eps.filter(e => e.contribBps >= LADDER_BOTTOM - RD_WINDOW && e.contribBps < LADDER_BOTTOM);
    const hi = eps.filter(e => e.contribBps >= LADDER_BOTTOM && e.contribBps < LADDER_BOTTOM + RD_WINDOW);
    const side = (label, g) => {
      if (!g.length) { console.log(`  ${label.padEnd(30)}${pad(0, 6)}   (empty — no comparison possible)`); return; }
      const q = quantiles(g.map(e => e.contribBps));
      const rescued = g.filter(e => e.arm === "SF-LOAN" || e.arm === "ASSIST-NOLOAN").length;
      const selfR = g.filter(e => e.arm === "SELF-RESCUE").length;
      const evic = g.filter(e => e.arm === "EVICTED").length;
      const cyc = g.filter(e => e.cyclesAfter > 0).length;
      const hop = g.filter(e => e.reentAfter > 0).length;
      const ow = g.filter(e => e.owingNow).length;
      console.log(`  ${label.padEnd(30)}${pad(g.length, 6)}  med ${pad(q.med, 5)}   rescued ${pad(rescued, 4)}` +
                  `  self ${pad(selfR, 3)}  evicted ${pad(evic, 4)}  |  cycled again ${pad(pct(cyc, g.length), 7)}` +
                  `  cleared hop ${pad(pct(hop, g.length), 7)}  owing ${pad(pct(ow, g.length), 7)}`);
    };
    console.log("");
    side(`BELOW rung (${LADDER_BOTTOM - RD_WINDOW}..${LADDER_BOTTOM - 1})`, lo);
    side(`AT/ABOVE rung (${LADDER_BOTTOM}..${LADDER_BOTTOM + RD_WINDOW - 1})`, hi);
    if (lo.length < 20 || hi.length < 20) {
      console.log(`\n  ⚠ ONE OF THESE SIDES IS UNDER 20 EPISODES. That is not a measurement — it is an`);
      console.log(`    anecdote with a percentage sign on it. Report the counts, not the rates.`);
    }
    if (lo.length && lo.filter(e => e.arm === "SF-LOAN" || e.arm === "ASSIST-NOLOAN").length > 0) {
      console.log(`\n  ⚠ ${lo.filter(e => e.arm === "SF-LOAN" || e.arm === "ASSIST-NOLOAN").length} episodes BELOW the rung were rescued anyway —`);
      console.log(`    corescue_keeper.js does not apply the ladder, only the SF floor. The cutoff is FUZZY,`);
      console.log(`    not sharp, so this window is a comparison of tendencies and not a clean discontinuity.`);
    }
  };

  panel("organic");
  panel("bigfill");

  /* ── SECTION 5 + 6 — 14.4's TWO CORRECTIONS (session 24) ──────────────────── *
   * ORGANIC ONLY. 14.6 measured that the member-specific columns do NOT reproduce on a
   * population of scripts (bigfill ends owing at 1.1% against organic's 20.2%), so a
   * per-tier split of bigfill would be a split of the wrong thing. 14.1's table is the
   * organic one and these are corrections to it. */
  {
    const org = episodes.filter((e) => e.cohort === "organic");
    const armsHere = ARMS.filter((a) => org.some((e) => e.arm === a));

    console.log(`\n  ${"=".repeat(100)}`);
    console.log(`  5. PER-TIER SPLIT — 14.4's open item. ORGANIC ONLY (14.6: bigfill's member columns are not member facts).`);
    console.log(`  ${"=".repeat(100)}`);
    const { comp, cells } = tierSplit(org, armsHere, TIERS);

    console.log(`\n  5A. ARM COMPOSITION BY TIER — ⛔ THIS IS THE TABLE THAT DECIDES WHETHER 14.1 CAN BE QUOTED.`);
    console.log(`      14.4 suspected the never-rescued arm skews to higher tiers (same contribBps, bigger`);
    console.log(`      dollars). If these rows differ, 14.1's arms are NOT balanced and every outcome`);
    console.log(`      difference in it is part treatment and part tier.`);
    console.log(`\n      ${"arm".padEnd(16)}${TIERS.map((t) => pad(t, 9)).join("")}${pad("n", 8)}   share by tier`);
    for (const a of armsHere) {
      const n = TIERS.reduce((x, t) => x + comp[a][t], 0);
      const shares = TIERS.map((t) => n ? `${(comp[a][t] * 100 / n).toFixed(0)}%` : "n/a");
      console.log(`      ${a.padEnd(16)}${TIERS.map((t) => pad(comp[a][t], 9)).join("")}${pad(n, 8)}   ${shares.join(" / ")}`);
    }
    console.log(`\n      ⚠ Read the SHARES, not the counts — the arms are different sizes by construction.`);

    console.log(`\n  5B. OUTCOMES WITHIN EACH TIER — the fallback if 5A shows a skew.`);
    console.log(`      ${"arm".padEnd(16)}${"tier".padEnd(6)}${pad("n", 6)}${pad("2+ cyc", 9)}${pad("owing", 9)}${pad("medContrib", 12)}${pad("medShort$", 11)}`);
    for (const a of armsHere) for (const t of TIERS) {
      const c = cells[a][t];
      if (!c.n) continue;
      console.log(`      ${a.padEnd(16)}${t.padEnd(6)}${pad(c.n, 6)}${pad(pct(c.twoPlus, c.n), 9)}${pad(pct(c.owing, c.n), 9)}` +
                  `${pad(c.medContribBps ?? "n/a", 12)}${pad(c.medShortUsd === null ? "n/a" : c.medShortUsd.toFixed(2), 11)}`);
    }
    console.log(`\n      ⛔ A CELL WITH A HANDFUL OF EPISODES IS NOT A RATE. Read n before every percentage;`);
    console.log(`         14.1's arms were 238 / 219 / 192 and splitting them three ways does not add data.`);

    /* ── 6 — EQUAL TIME AT RISK ── */
    const exposures = org.map((e) => head - (e.exitB ?? e.parkB));
    const W = Number(process.env.WINDOW_BLOCKS || p25(exposures));
    console.log(`\n  ${"=".repeat(100)}`);
    console.log(`  6. OUTCOMES OVER AN EQUAL WINDOW — 14.4's other open item ("no time-at-risk adjustment")`);
    console.log(`  ${"=".repeat(100)}`);
    console.log(`      window W = ${W} blocks${process.env.WINDOW_BLOCKS ? " (WINDOW_BLOCKS)" : " (p25 of organic exposure — three quarters of episodes survive the cap)"}`);
    console.log(`      Only episodes with >= W blocks of exposure are kept, and only cycles inside (t0, t0+W].`);
    const win = cappedWindow(org, (m) => cycleBlocks.get(lc(m)), head, W, armsHere);
    console.log(`\n      ${"arm".padEnd(16)}${pad("eligible", 10)}${pad("censored", 10)}${pad("medExposure", 13)}${pad("cycled", 9)}${pad("2+ cyc", 9)}`);
    for (const a of armsHere) {
      const r = win[a];
      console.log(`      ${a.padEnd(16)}${pad(r.eligible, 10)}${pad(r.censored, 10)}${pad(r.medExposure ?? "n/a", 13)}` +
                  `${pad(pct(r.cycledAgain, r.eligible), 9)}${pad(pct(r.twoPlus, r.eligible), 9)}`);
    }
    console.log(`\n      ⚠ medExposure is the UNCAPPED median and it is why this section exists — if the arms`);
    console.log(`        differ there, 14.1's cycle columns were comparing different observation lengths.`);
    console.log(`      ⛔ CAPPING HAS ITS OWN SELECTION. Requiring W blocks of exposure keeps only OLDER`);
    console.log(`         episodes, so this table describes the early population. An arm that loses most of`);
    console.log(`         itself to \`censored\` has not been adjusted — it has been replaced. Read the two`);
    console.log(`         columns together, and quote section 3's numbers beside these, never instead of them.`);
    console.log(`      ⚠ 14.4's ranking still applies: \`2+ cyc\` is PARTLY MECHANICAL (a rescued member is`);
    console.log(`        seated and a seated member cycles). The window fixes the exposure bias, not that one.`);
  }

  /* ── what this run cannot see ────────────────────────────────────────────── */
  console.log(`\n  ${"=".repeat(100)}`);
  console.log(`  WHAT THIS INSTRUMENT CANNOT SEE — carry these forward with every number above`);
  console.log(`  ${"=".repeat(100)}`);
  console.log(`  · ASSIGNMENT IS NOT RANDOM. Three merit gates decide the rescued arm (see the header).`);
  console.log(`    Sections 2 and 3 are DESCRIPTIVE. Only section 4 has a causal reading, and only if`);
  console.log(`    both sides of the rung are populated.`);
  console.log(`  · Members below the rung are evicted, so "EVICTED" is not a counterfactual for`);
  console.log(`    "SF-LOAN" — it is a poorer population by construction.`);
  console.log(`  · Outcomes in sections 2-4 are measured to the head block, so a member rescued`);
  console.log(`    yesterday has had less time to cycle than one rescued in week one. SECTION 6 now`);
  console.log(`    applies an equal-window adjustment; sections 2-4 still do not. Quote both.`);
  console.log(`  · ${bufBps >= 0 ? `crossingBufferBps is ${bufBps} ON CHAIN` : "crossingBufferBps unreadable"} — V8.48 manufactured debt with the buffer that V8.50 removes.`);
  console.log(`    Every debt figure here is on the OLD build (13.11). Re-run on the V8.50 private deploy.`);
  console.log(`  · Loans are not tracked individually; "owing now" is the member's balance at head.`);
  console.log(`  · STILL-PARKED episodes are open-ended: their outcome window starts at the park, not`);
  console.log(`    at an exit, so they get MORE time-at-risk than the other arms, not less.`);
  if (gaps.length) console.log(`  · ⛔ ${gaps.length} BLOCK RANGES WERE UNREADABLE. Every count is a LOWER BOUND.`);
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
