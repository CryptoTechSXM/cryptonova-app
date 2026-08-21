// diag_debt_sweep.js — DOES DEBT COLLECTION COST MEMBERS THE FORWARD HOP? (handoff 14.8 item 1)
//
// THE QUESTION (14.5): loan-rescued organic members clear the forward hop at 8.0% while members
// who self-rescued from the identical parked state clear it at 19.6% — and the borrowers cycle
// MORE. More laps, fewer exits. Session 14 marked the candidate mechanism UNVERIFIED. This
// script verifies or kills it.
//
// ⛔ THE MECHANISM IS NOT A HYPOTHESIS ANY MORE — IT IS IN THE SOURCE, READ BEFORE THIS SCRIPT
// WAS WRITTEN. `MatrixLogicLib._cycleOutRoot` (:835-856), inside the SAME transaction as the
// MatB cycle-out and STRICTLY BEFORE the forward hop is attempted:
//
//     cycleOutDebt = StabilityFund.memberDebtOf(root)
//     if (cycleOutDebt > 0 && withdrawable > 0)
//         repay = min(withdrawable, cycleOutDebt)
//         self.members[root].withdrawable -= repay          <-- THE HOP'S OWN NUMERATOR
//         emit RescueDebtRepaid(root, repay, ...)
//     TierRouter.handleCycleOut(root, tier, crossingReserve, withdrawable)   <-- AFTER
//
// So the balance the hop is judged against is the balance AFTER debt collection. What is left
// to measure is not WHETHER it happens but HOW MUCH IT TAKES and WHETHER IT WAS DECISIVE.
//
// THE COUNTERFACTUAL IS EXACT, WHICH IS WHY THIS IS WORTH RUNNING. For a member who parked,
// `MemberParked.shortfall` is measured in the same transaction, after the sweep. Without the
// sweep the member would have held `swept` more. So:
//
//     swept >= shortfall   =>   THE COLLECTION IS WHY THEY DID NOT GRADUATE
//
// No model, no assumption, same transaction, both numbers straight off the chain.
//
// ⛔⛔ AND THE HONEST FRAME, WHICH MUST TRAVEL WITH EVERY NUMBER BELOW:
// THIS IS NOT A BUG AND THE MONEY IS NOT FREE. Not collecting means the debt stays outstanding
// and travels into the next cycle. What this measures is an ORDERING POLICY the protocol
// currently applies without anyone having chosen it: COLLECT THE DEBT NOW, OR LET THEM
// GRADUATE. That is the owner's call, and this script exists to price it, not to make it.
//
// ⚠ FOUR EMIT SITES, NOT ONE — the trap this script had to avoid. `RescueDebtRepaid` fires from
// MatrixLogicLib:638 (the banded clawback inside _settlePool), :853 (this sweep), :1015 (a
// crossing) and :1393 (withdrawCore). In a cycle-out transaction 638 and 853 can BOTH fire —
// the rotation settles the pool, the clawback takes its band, then the sweep takes the rest.
// Attributing the event to one site is impossible from logs alone AND UNNECESSARY: both reduce
// the same numerator in the same transaction, so this script sums EVERY debt repayment for that
// member in that transaction and calls it what it is — total collected before the hop.
//
// ⚠ AND A CROSS-CHECK, BECAUSE ONE READING IS NOT A MEASUREMENT. Every one of those four sites
// calls `receiveDebtRepayment`, which emits `MemberDebtRepaid` on the StabilityFund. That is
// the SAME money seen from the creditor's side, so the two totals must AGREE, not add. They are
// printed side by side and a disagreement is flagged ⛔ — it would mean a repayment path that
// does not reach the fund, or a fund credit with no matrix behind it.
//
// ⚠ OTHER TRAPS CARRIED FORWARD: MemberParked has six emit sites, only two carry a real
// shortfall (session 13). Forward-hop SUCCESS is `MemberReentered` on the TierRouter, never
// `MemberCrossedToPartner`, which that path cannot emit (12.1). A control cohort is not
// optional (13.8) — everything runs twice, organic and bigfill.
//
// Read-only. Nothing is written to chain.
//
// Run: npx hardhat run scripts/diag_debt_sweep.js --network baseSepolia
// Env: TIERS=1,2,3  CHUNK=4000  COHORT_MAX=1200  ADDRESSES_FILE=...
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const TIERS      = (process.env.TIERS || "1,2,3").split(",").map(s => `T${s.trim()}`).filter(t => A.tiers[t]);
const CHUNK      = Number(process.env.CHUNK || 4000);
const COHORT_MAX = Number(process.env.COHORT_MAX || 1200);

const lc  = (a) => String(a).toLowerCase();
const usd = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
const pct = (n, d) => d ? `${(n * 100 / d).toFixed(1)}%` : "  n/a";
const pad = (s, n) => String(s).padStart(n);

const MATRIX_ABI = [
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)",
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining)",
];
const SF_ABI = [
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
];
const TR_ABI = ["event MemberReentered(address indexed member, uint8 tier)"];
const PM_ABI = ["function pairCount() view returns (uint256)",
                "function getPairAt(uint256) view returns (address,address)"];
const MAT_VIEW = ["function ENTRY_FEE() view returns (uint256)",
                  "function isMatrixA() view returns (bool)"];

const gaps = [];
async function scanLogs(addresses, topic0s, from, to, span) {
  const out = [];
  for (let b = from; b <= to; b += span) {
    const end = Math.min(b + span - 1, to);
    let got = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try { got = await ethers.provider.getLogs({ address: addresses, topics: [topic0s], fromBlock: b, toBlock: end }); }
      catch {
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

const bigfillIndexOf = new Map();
const leaderSet = new Set();
function buildBigfill() {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) {
    console.error("\n  ⛔ FILL_MNEMONIC is not set. STOPPING — without it every bigfill wallet");
    console.error("     falls into ORGANIC and the organic panel reads as a triumph.");
    process.exit(1);
  }
  const acct = ethers.HDNodeWallet.fromPhrase(mnemo, undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < COHORT_MAX; i++) bigfillIndexOf.set(lc(acct.deriveChild(i).address), i);
}
function buildLeaders() {
  const p = path.join(__dirname, "..", "run_bigfill_rr.ps1");
  const block = fs.readFileSync(p, "utf8").split(/\$leaders\s*=\s*@\(/)[1];
  if (!block) { console.error("\n  ⛔ no $leaders block in run_bigfill_rr.ps1. STOPPING."); process.exit(1); }
  for (const m of block.split(/^\s*\)\s*$/m)[0].matchAll(/0x[0-9a-fA-F]{40}/g)) leaderSet.add(lc(m[0]));
  if (leaderSet.size < 10) { console.error(`\n  ⛔ only ${leaderSet.size} leaders parsed (expected ~41). STOPPING.`); process.exit(1); }
}
const cohortOf = (a) => bigfillIndexOf.has(lc(a)) ? "bigfill" : (leaderSet.has(lc(a)) ? "leader" : "organic");

function quantiles(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: s.length, min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

async function main() {
  buildBigfill();
  buildLeaders();

  const head = await ethers.provider.getBlockNumber();
  const from = await deployFloor(head);

  console.log("=".repeat(104));
  console.log(`  THE DEBT SWEEP AT THE FORWARD HOP — ${A.network}, ${process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"}`);
  console.log(`  deployed ${A.deployedAt}   blocks ${from}..${head}  (${head - from})   MATRIX_SIZE ${A.matrixSize}`);
  console.log(`  bigfill window HD 0..${COHORT_MAX - 1}   leader roster ${leaderSet.size}   tiers ${TIERS.join(",")}`);
  console.log("=".repeat(104));
  console.log(`\n  THE MECHANISM IS IN THE SOURCE, NOT IN DISPUTE (MatrixLogicLib:835-856):`);
  console.log(`  at a MatB cycle-out the member's outstanding SF debt is taken out of withdrawable`);
  console.log(`  FIRST, and the REDUCED balance is what TierRouter.handleCycleOut then judges the`);
  console.log(`  forward hop against. This run measures how much it takes and when it was decisive.`);

  /* every matrix (RescueDebtRepaid can fire in either half of the pair in one tx),
   * but the HOP population is MatB cycle-outs only — the sweep is guarded !isMatrixA. */
  const mats = new Map(), matBs = new Set();
  for (const t of TIERS) {
    const pm = await ethers.getContractAt(PM_ABI, A.tiers[t].pm);
    const npairs = Number(await pm.pairCount().catch(() => 1));
    for (let p = 0; p < npairs; p++) {
      const [ma, mb] = await pm.getPairAt(p);
      for (const addr of [ma, mb]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const c = await ethers.getContractAt(MAT_VIEW, addr);
        const fee = BigInt(await c.ENTRY_FEE());
        const isA = await c.isMatrixA();
        mats.set(lc(addr), { addr, tier: t, pair: p, isA, fee, label: `${t}p${p}${isA ? "A" : "B"}` });
        if (!isA) matBs.add(lc(addr));
      }
    }
  }
  console.log(`\n  matrices in scope ${mats.size}   MatB halves (the hop) ${matBs.size}`);

  const mIface = new ethers.Interface(MATRIX_ABI);
  const mTopics = MATRIX_ABI.map(s => mIface.getEvent(s.match(/event (\w+)/)[1]).topicHash);
  const sfIface = new ethers.Interface(SF_ABI);
  const sTopics = SF_ABI.map(s => sfIface.getEvent(s.match(/event (\w+)/)[1]).topicHash);
  const trIface = new ethers.Interface(TR_ABI);
  const tTopics = TR_ABI.map(s => trIface.getEvent(s.match(/event (\w+)/)[1]).topicHash);

  console.log(`  scanning ${head - from} blocks in ${CHUNK}-block chunks …`);
  const rawM = await scanLogs([...mats.values()].map(m => m.addr), mTopics, from, head, CHUNK);
  const rawS = await scanLogs([A.stabilityFund], sTopics, from, head, CHUNK);
  const rawT = await scanLogs([A.tierRouter], tTopics, from, head, CHUNK);
  console.log(`  matrix logs ${rawM.length}   SF logs ${rawS.length}   router logs ${rawT.length}` +
              (gaps.length ? `   ⛔ ${gaps.length} UNREADABLE RANGES — every count is a LOWER BOUND` : `   ✅ no unreadable ranges`));

  const dec = (iface, l) => { const p = iface.parseLog(l); return { name: p.name, args: p.args, b: l.blockNumber,
                              li: l.index ?? l.logIndex, tx: l.transactionHash, at: lc(l.address) }; };
  const evM = rawM.map(l => dec(mIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);
  const evS = rawS.map(l => dec(sfIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);
  const evT = rawT.map(l => dec(trIface, l)).sort((a, b) => a.b - b.b || a.li - b.li);

  /* per (tx,member): what the MATRIX says was collected, and what the FUND says it received */
  const sweptMatrix = new Map(), sweptFund = new Map();
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  for (const e of evM) if (e.name === "RescueDebtRepaid")
    bump(sweptMatrix, `${e.tx}|${lc(e.args.member)}`, BigInt(e.args.repaid));
  for (const e of evS) if (e.name === "MemberDebtRepaid")
    bump(sweptFund, `${e.tx}|${lc(e.args.member)}`, BigInt(e.args.amount));

  /* debt balance history, so we can ask what the member owed BEFORE this transaction */
  const debtEv = new Map();
  for (const e of evS) {
    const m = lc(e.args.member);
    if (!debtEv.has(m)) debtEv.set(m, []);
    debtEv.get(m).push({ b: e.b, li: e.li, tx: e.tx,
                         d: e.name === "MemberDebtIncreased" ? BigInt(e.args.amount) : -BigInt(e.args.amount) });
  }
  // Everything the member owed going INTO this transaction: all debt events strictly before
  // it. Events from this same tx are excluded — they ARE the collection we are measuring, and
  // including them would net the sweep out of the balance it was taken from.
  // ⚠ same-block/different-tx events are counted as "before"; log order across txs in a block
  // is the block's order, so this is right, but it is worth knowing it is an ordering call.
  const debtBeforeTx = (m, blk, tx) =>
    (debtEv.get(m) || []).reduce((s, x) => (x.b < blk || (x.b === blk && x.tx !== tx)) ? s + x.d : s, 0n);

  const reentKey = new Set(evT.filter(e => e.name === "MemberReentered").map(e => `${e.tx}|${lc(e.args.member)}`));
  const parkByKey = new Map();
  for (const e of evM) if (e.name === "MemberParked" && matBs.has(e.at))
    parkByKey.set(`${e.tx}|${lc(e.args.member)}`, BigInt(e.args.shortfall));

  /* ── the hop population ─────────────────────────────────────────────────── */
  const hops = [];
  for (const e of evM) {
    if (e.name !== "MemberCycledOut" || !matBs.has(e.at)) continue;
    const m = lc(e.args.member);
    const key = `${e.tx}|${m}`;
    const M = mats.get(e.at);
    const shortfall = parkByKey.has(key) ? parkByKey.get(key) : null;
    hops.push({
      member: m, cohort: cohortOf(m), tier: M.tier, label: M.label, b: e.b, tx: e.tx, fee: M.fee,
      outcome: reentKey.has(key) ? "REENTERED"
             : shortfall === null ? "UNEXPLAINED"
             : shortfall > 0n ? "PARKED-SHORT" : "PARKED-ZERO",
      shortfall: shortfall === null ? 0n : shortfall,
      swept: sweptMatrix.get(key) || 0n,
      sweptFund: sweptFund.get(key) || 0n,
      debtBefore: debtBeforeTx(m, e.b, e.tx),
    });
  }

  /* ── SECTION 0 — the two readings must agree ────────────────────────────── */
  let mSum = 0n, fSum = 0n, disagree = 0;
  for (const h of hops) {
    mSum += h.swept; fSum += h.sweptFund;
    if (h.swept !== h.sweptFund) disagree++;
  }
  console.log(`\n  ${"=".repeat(100)}`);
  console.log(`  0. CROSS-CHECK — the same money seen twice. These must AGREE, not add.`);
  console.log(`  ${"=".repeat(100)}`);
  console.log(`  collected, per the MATRIX (RescueDebtRepaid)        ${usd(mSum)}`);
  console.log(`  received,  per the FUND   (MemberDebtRepaid)        ${usd(fSum)}`);
  console.log(`  hop transactions where the two disagree             ${disagree}   ` +
              (disagree === 0 ? "✅" : "⛔ A REPAYMENT PATH IS NOT REACHING THE FUND — INVESTIGATE BEFORE READING ON"));

  /* ── panels ─────────────────────────────────────────────────────────────── */
  const panel = (cohort) => {
    const H = hops.filter(h => h.cohort === cohort);
    console.log(`\n  ${"=".repeat(100)}`);
    console.log(`  COHORT: ${cohort.toUpperCase()}   ${H.length} MatB cycle-outs (forward-hop attempts)`);
    console.log(`  ${"=".repeat(100)}`);
    if (!H.length) { console.log("  (none)"); return; }

    const re = H.filter(h => h.outcome === "REENTERED");
    const ps = H.filter(h => h.outcome === "PARKED-SHORT");
    const pz = H.filter(h => h.outcome === "PARKED-ZERO");
    const un = H.filter(h => h.outcome === "UNEXPLAINED");
    console.log(`\n  RE-ENTERED ${pad(re.length, 5)}   PARKED-SHORT ${pad(ps.length, 5)}   PARKED-ZERO ${pad(pz.length, 4)}` +
                `   UNEXPLAINED ${pad(un.length, 4)}   cleared ${pct(re.length, H.length)}`);
    console.log(`  reconcile: ${re.length + ps.length + pz.length + un.length} vs ${H.length}  ` +
                (re.length + ps.length + pz.length + un.length === H.length ? "✅" : "⛔"));

    /* 1. clearance by whether the member owed anything going in */
    console.log(`\n  1. DID CARRYING DEBT INTO THE HOP MATTER?`);
    console.log(`     ⚠ DESCRIPTIVE — members with debt borrowed because they were short. Selection.`);
    console.log(`\n  ${"debt going in".padEnd(20)}${pad("hops", 7)}${pad("re-entered", 12)}${pad("cleared %", 11)}${pad("med swept", 12)}`);
    console.log("  " + "-".repeat(64));
    for (const [label, f] of [["none ($0.00)", h => h.debtBefore <= 0n], ["owed something", h => h.debtBefore > 0n]]) {
      const g = H.filter(f);
      const r = g.filter(h => h.outcome === "REENTERED").length;
      const q = quantiles(g.map(h => Number(h.swept) / 1e6));
      console.log(`  ${label.padEnd(20)}${pad(g.length, 7)}${pad(r, 12)}${pad(pct(r, g.length), 11)}${pad(q ? `$${q.med.toFixed(2)}` : "-", 12)}`);
    }

    /* 2. how much the collection actually took */
    const swept = H.filter(h => h.swept > 0n);
    const qs = quantiles(swept.map(h => Number(h.swept) / 1e6));
    console.log(`\n  2. WHAT THE COLLECTION TOOK, IN THE HOP'S OWN TRANSACTION`);
    console.log(`     hops with any debt collected  ${pad(swept.length, 6)} / ${H.length}  (${pct(swept.length, H.length)})`);
    if (qs) {
      console.log(`     amount collected              min ${usd(qs.min * 1e6)}  p25 ${usd(qs.p25 * 1e6)}  med ${usd(qs.med * 1e6)}` +
                  `  p75 ${usd(qs.p75 * 1e6)}  max ${usd(qs.max * 1e6)}`);
      console.log(`     total collected at the hop    ${usd(H.reduce((s, h) => s + h.swept, 0n))}`);
    }

    /* 3. THE HEADLINE — was it decisive? */
    console.log(`\n  3. ⛔ WAS THE COLLECTION DECISIVE? — swept >= shortfall, same transaction, both`);
    console.log(`        numbers off the chain. This is the whole point of the run.`);
    const sweptAndParked = ps.filter(h => h.swept > 0n);
    const decisive = sweptAndParked.filter(h => h.swept >= h.shortfall);
    const contributed = sweptAndParked.filter(h => h.swept > 0n && h.swept < h.shortfall);
    console.log(`\n  ${"parked WITH a shortfall".padEnd(46)}${pad(ps.length, 6)}`);
    console.log(`  ${"  ...and debt was collected in the same tx".padEnd(46)}${pad(sweptAndParked.length, 6)}  ${pct(sweptAndParked.length, ps.length)} of parks`);
    console.log(`  ${"  ⛔ ...and the amount collected >= the shortfall".padEnd(46)}${pad(decisive.length, 6)}  ${pct(decisive.length, ps.length)} of parks`);
    console.log(`  ${"       WOULD HAVE CLEARED THE HOP WITHOUT IT".padEnd(46)}`);
    console.log(`  ${"  ...collected, but less than the shortfall".padEnd(46)}${pad(contributed.length, 6)}  (made it worse, not decisive)`);
    console.log(`  ${"  ...no collection — a genuine shortfall".padEnd(46)}${pad(ps.length - sweptAndParked.length, 6)}`);
    if (decisive.length) {
      console.log(`\n  the decisive cases, priced:`);
      console.log(`    total collected from them            ${usd(decisive.reduce((s, h) => s + h.swept, 0n))}`);
      console.log(`    total shortfall it created           ${usd(decisive.reduce((s, h) => s + h.shortfall, 0n))}`);
      console.log(`    distinct members                     ${new Set(decisive.map(h => h.member)).size}`);
      const q2 = quantiles(decisive.map(h => Number(h.swept - h.shortfall) / 1e6));
      console.log(`    surplus over the shortfall           med ${usd(q2.med * 1e6)}  max ${usd(q2.max * 1e6)}`);
      console.log(`\n    first 10, open one before quoting the rest:`);
      for (const h of decisive.slice(0, 10))
        console.log(`      ${h.label}  blk ${h.b}  swept ${usd(h.swept).padStart(7)}  short ${usd(h.shortfall).padStart(7)}  ${h.tx}`);
    } else {
      console.log(`\n  ✅ NOT ONE PARK IN THIS COHORT WAS CAUSED BY THE COLLECTION. The 14.5 hypothesis`);
      console.log(`     is REFUTED for ${cohort} and should be struck from the handoff, not softened.`);
    }

    /* 4. and the other side of the same question */
    const reSwept = re.filter(h => h.swept > 0n);
    console.log(`\n  4. THE OTHER SIDE — members who CLEARED the hop despite a collection: ${reSwept.length} of ${re.length}`);
    if (reSwept.length) {
      const q3 = quantiles(reSwept.map(h => Number(h.swept) / 1e6));
      console.log(`     med collected from them ${usd(q3.med * 1e6)}   max ${usd(q3.max * 1e6)}  — collection is not automatically fatal`);
    }
  };

  panel("organic");
  panel("bigfill");

  console.log(`\n  ${"=".repeat(100)}`);
  console.log(`  WHAT THIS INSTRUMENT CANNOT SEE`);
  console.log(`  ${"=".repeat(100)}`);
  console.log(`  · ⛔ THE MONEY IS NOT FREE. "Would have cleared without the collection" does NOT mean`);
  console.log(`    "should not have been collected" — the debt would simply still be outstanding, and`);
  console.log(`    the member would carry it into the next cycle. THIS IS AN ORDERING POLICY, and`);
  console.log(`    choosing it is the owner's, not this script's.`);
  console.log(`  · The four RescueDebtRepaid emit sites cannot be told apart from logs, so "collected"`);
  console.log(`    is the sweep PLUS any banded clawback in the same transaction. Both reduce the same`);
  console.log(`    numerator, which is why they are summed rather than separated.`);
  console.log(`  · A member who cleared the hop with no collection may simply never have borrowed.`);
  console.log(`    Section 1 is descriptive and carries the same selection caveat as 13.5.`);
  console.log(`  · V8.48 ONLY. The crossing buffer manufactured debt on this build (13.11); with it at`);
  console.log(`    zero in V8.50 there is less debt to collect and this whole table shrinks. Re-run.`);
  if (gaps.length) console.log(`  · ⛔ ${gaps.length} BLOCK RANGES UNREADABLE — every count is a LOWER BOUND.`);
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
