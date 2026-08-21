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

  /* ── what this run cannot see ────────────────────────────────────────────── */
  console.log(`\n  ${"=".repeat(100)}`);
  console.log(`  WHAT THIS INSTRUMENT CANNOT SEE — carry these forward with every number above`);
  console.log(`  ${"=".repeat(100)}`);
  console.log(`  · ASSIGNMENT IS NOT RANDOM. Three merit gates decide the rescued arm (see the header).`);
  console.log(`    Sections 2 and 3 are DESCRIPTIVE. Only section 4 has a causal reading, and only if`);
  console.log(`    both sides of the rung are populated.`);
  console.log(`  · Members below the rung are evicted, so "EVICTED" is not a counterfactual for`);
  console.log(`    "SF-LOAN" — it is a poorer population by construction.`);
  console.log(`  · Outcomes are measured to the head block. A member rescued yesterday has had less`);
  console.log(`    time to cycle than one rescued in week one. No time-at-risk adjustment is applied.`);
  console.log(`  · ${bufBps >= 0 ? `crossingBufferBps is ${bufBps} ON CHAIN` : "crossingBufferBps unreadable"} — V8.48 manufactured debt with the buffer that V8.50 removes.`);
  console.log(`    Every debt figure here is on the OLD build (13.11). Re-run on the V8.50 private deploy.`);
  console.log(`  · Loans are not tracked individually; "owing now" is the member's balance at head.`);
  console.log(`  · STILL-PARKED episodes are open-ended: their outcome window starts at the park, not`);
  console.log(`    at an exit, so they get MORE time-at-risk than the other arms, not less.`);
  if (gaps.length) console.log(`  · ⛔ ${gaps.length} BLOCK RANGES WERE UNREADABLE. Every count is a LOWER BOUND.`);
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
