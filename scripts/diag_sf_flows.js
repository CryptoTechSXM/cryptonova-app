// diag_sf_flows.js — WHERE DOES STABILITY FUND MONEY COME FROM, AND WHERE DOES IT GO?
//
// Built 2026-08-19 (session 9) to settle a disagreement between the owner and a previous
// session of Claude. Neither position was measured; this is the measurement.
//
// ── THE DISAGREEMENT ──────────────────────────────────────────────────────────────────
// SESSION 8 WROTE: "bigfill does not replenish — SF income is stabilityBps 238 = $0.238 per
// $10 registration against a rescue costing $3.42-$4.52", and concluded: leave live V8.48
// organic, because funding or filling it would erase the drain series.
//
// THE OWNER CORRECTED THAT 2026-08-19, and he is right on mechanism. Three inflows were
// missed:
//   1. each bigfill run registers 1-5 NEW wallets       -> entry fee -> stability split
//   2. each run UPGRADES to the highest eligible tier   -> a $25 T2 / $50 T3 fee carries a
//      proportionally larger stability split than a $10 T1 registration
//   3. each run SELF-RESCUES                            -> the crossing fee is still
//      distributed (the SF gets its split) AND NO SF LOAN IS DRAWN
//
// (3) IS THE BIG ONE, AND IT IS NOT AN INCOME ARGUMENT — IT IS AVOIDED OUTFLOW. A wallet
// that self-rescues does not draw the $3.42-$4.52 SF share and still pays in: roughly a $4
// swing per event against the passive case, an order of magnitude above the per-registration
// credit session 8 reasoned from. Session 8's figure also came from a HARNESS CONFIG that the
// same document flagged as unconfirmed against the live deployment.
//
// ── AND THE CONSEQUENCE THAT MATTERS MORE THAN WHO WAS RIGHT ──────────────────────────
// The bigfill wallets stay seated whether bigfill runs or not. With it stopped they still
// cycle out, still park, still get SF-rescued — they just stop registering, upgrading and
// self-rescuing. STOPPING BIGFILL REMOVED THE INCOME AND KEPT THE LIABILITY, making the
// population 100% PASSIVE BY CONSTRUCTION — the same pathological extreme as
// SELF_RESCUE_RATE = 0 in the A/B harness. So the ~$125/day drain may be an artifact of the
// measurement regime rather than a property of the economics, and "preserve the clean
// before-picture" is not a reason to leave it alone.
//
// ⚠ BUT BIGFILL-ON IS NOT "THE REAL WORLD" EITHER. Those wallets are funded, they upgrade
// whenever eligible and they self-rescue every time — roughly a 100% self-rescue rate. Real
// members sit between. THE TWO REGIMES ARE THE TWO ENDS OF A BRACKET, not right and wrong,
// and that is exactly why measuring both is worth more than arguing either.
//
// ── WHY THIS NEEDS NO RESTART AND NO RISK ─────────────────────────────────────────────
// THE EXPERIMENT HAS ALREADY RUN. Live V8.48 history contains bigfill-ACTIVE periods and
// bigfill-STOPPED periods. This script reads both out of the chain and puts them side by
// side. Nothing is written, no wallet is touched, no keeper is started.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────────────────
//   1. Every SF inflow (FundDeposit, emitted by the FUND ITSELF — one contract, one writer)
//      and every outflow (MemberDebtIncreased) and repayment (MemberDebtRepaid), per day.
//   2. ATTRIBUTES each inflow by what else happened in the SAME TRANSACTION: registration,
//      upgrade, self-rescue, copay, keeper rescue. A tx carrying more than one classifier is
//      reported as MIXED rather than guessed at — and the mixed share is printed, because if
//      it dominates the attribution is weak and you need to know that.
//   3. Splits the days into BIGFILL-ACTIVE vs QUIET on a stated, tunable threshold and prints
//      the per-day averages for each regime. That comparison is the answer.
//   4. Reconciles the event-derived totals against the fund's OWN counters
//      (totalRescueLoaned / totalRescueRepaid / totalBalance). House rule: prefer contract
//      state; if the two disagree, THE DISAGREEMENT IS THE FINDING.
//
// ── TRAPS THIS SCRIPT IS BUILT AGAINST (all previously paid for in this repo) ─────────
//   · THREE EVENT NAMES ARE AMBIGUOUS on this chain — MemberParked, MemberEnrolled and
//     MemberCycledOut each exist with TWO different signatures on different contracts.
//     Everything here keys on TOPIC0, never on a name.
//   · Library events are not in a contract's ABI — SelfRescue, CoPayRescue and
//     RescueLoanIssued come from MatrixLogicLib and are emitted at the MATRIX address.
//     Fetched by topic0 and then filtered against the enumerated matrix set.
//   · A failed log range makes every total a FLOOR. Holes are counted, printed, and the
//     verdict is suppressed if any exist.
//   · A diagnostic that cannot say WHICH deployment it measured has measured nothing —
//     refuses to start without ADDRESSES_FILE, same as diag_sf_debt_reconcile.js.
//
// RUN (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_sf_flows.js
// Optional: FROM=<block>   WINDOW=3000   BIGFILL_MIN_REGS=<n>   CSV=1

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;

const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) {
  console.error("\n  ADDRESSES_FILE is not set, and this script will not guess.\n");
  console.error("  A diagnostic that cannot say WHICH deployment it measured has measured");
  console.error("  nothing. Set it in .env (line 69 already does on this machine) or pass it:\n");
  console.error('      $env:ADDRESSES_FILE="deployed_addresses_v8_48.json"; node scripts/diag_sf_flows.js\n');
  process.exit(1);
}
const A = require(path.join(__dirname, ADDRFILE));

const FROM   = Number(process.env.FROM || 45_428_000);   // measured V8.48 creation floor
const CHUNK  = Number(process.env.WINDOW || 9000);       // QuickNode eth_getLogs cap is 10k
const BIGFILL_MIN_REGS = Number(process.env.BIGFILL_MIN_REGS || 20);

// ── topic0s ───────────────────────────────────────────────────────────────────────────
// ⛔ FIXED 2026-08-19, FIRST RUN: this block previously stored a 10-CHARACTER PREFIX of each
// topic0 (readable in comparisons) and then fed that prefix to eth_getLogs as the filter.
// `zeroPadValue("0xc99c5117", 32)` LEFT-pads a 4-byte value into
// 0x000...00c99c5117, which matches no event that has ever been emitted. The run returned
// "logs fetched: 0   failed ranges: 0" — ZERO OBSERVATIONS AND ZERO ERRORS — and then printed
// empty tables and a tidy "only one regime present" message. That is the session's own trap
// (an instrument reporting the absence of what it cannot observe) committed one more time, in
// the very script written to avoid it. topic0 is now DERIVED from the signature, so it cannot
// drift from what the chain emits, and a zero-log run is now a hard stop (see below).
const SIGS = {
  // StabilityFund — the fund's own view of its money. One contract, one writer.
  FundDeposit:           "FundDeposit(uint8,uint256,uint8,address)",
  MemberDebtIncreased:   "MemberDebtIncreased(address,uint8,uint256,uint256)",
  MemberDebtRepaid:      "MemberDebtRepaid(address,uint256,uint256)",
  DebtRepaymentReceived: "DebtRepaymentReceived(address,uint256)",     // cross-check only
  // Classifiers — what KIND of activity paid the fee
  MemberRegistered:      "MemberRegistered(address,uint8,address)",    // TierRouter
  ManualUpgrade:         "ManualUpgrade(address,uint8,uint8,uint256)", // TierRouter
  SelfRescue:            "SelfRescue(address,uint256,uint256)",        // MatrixLogicLib @ matrix
  CoPayRescue:           "CoPayRescue(address,uint256,uint256,uint256)",
  ParkedRescued:         "ParkedRescued(address,address,uint8)",       // MatrixKeeper
  RescueLoanIssued:      "RescueLoanIssued(address,uint256,string)",   // MatrixLogicLib @ matrix
};
const T = Object.fromEntries(Object.entries(SIGS).map(([k, sig]) => [k, ethers.id(sig)]));

const IFACE = new ethers.Interface([
  "event FundDeposit(uint8 indexed tier, uint256 amount, uint8 layer, address from)",
  "event MemberDebtIncreased(address indexed member, uint8 tier, uint256 amount, uint256 newTotal)",
  "event MemberDebtRepaid(address indexed member, uint256 amount, uint256 newTotal)",
  "event DebtRepaymentReceived(address indexed matrix, uint256 amount)",
]);

const SF_ABI = [
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
  "function totalBalance() view returns (uint256)",
];
const TR_ABI  = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI  = ["function pairCount() view returns (uint256)", "function getPairAt(uint256) view returns (address,address)"];

const usd  = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const pad  = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });

  // Refuse loudly if state reads are down — 2026-08-19 Base Sepolia served headers while
  // failing eth_call for ~45 minutes, and a diagnostic that runs through that prints
  // confident nonsense.
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);
  let cLoaned, cRepaid, cBalance;
  try {
    cLoaned  = await sf.totalRescueLoaned();
    cRepaid  = await sf.totalRescueRepaid();
    cBalance = await sf.totalBalance();
  } catch (e) {
    console.error("\n  REFUSING TO RUN: a StabilityFund state read failed —");
    console.error("  " + (e.shortMessage || e.message || "").slice(0, 100));
    console.error("  If eth_call is returning 503, Base Sepolia is not serving state reads.");
    console.error("  Use CryptoNova-Testnet-App\\watch_base_sepolia.mjs and retry after recovery.\n");
    process.exit(1);
  }

  const tip = await p.getBlockNumber();
  const t0 = (await p.getBlock(FROM)).timestamp;
  const t1 = (await p.getBlock(tip)).timestamp;
  const dayOf = (bn) => new Date((t0 + (bn - FROM) * (t1 - t0) / (tip - FROM)) * 1000)
    .toISOString().slice(0, 10);

  console.log(`\n  addresses: ${ADDRFILE}`);
  console.log(`  StabilityFund ${A.stabilityFund}`);
  console.log(`  blocks ${FROM}..${tip}  (~${((t1 - t0) / 86400).toFixed(1)} days)\n`);

  // ── enumerate every matrix, so matrix-emitted events can be filtered to OUR deployment ──
  const matrixSet = new Set();
  try {
    const [pms] = await new ethers.Contract(A.tierRouter, TR_ABI, p).getAllTiers();
    for (const pmAddr of pms) {
      if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;
      const pm = new ethers.Contract(pmAddr, PM_ABI, p);
      const n = Number(await pm.pairCount());
      for (let i = 0; i < n; i++) {
        const [a, b] = await pm.getPairAt(i);
        if (a && a !== ethers.ZeroAddress) matrixSet.add(a.toLowerCase());
        if (b && b !== ethers.ZeroAddress) matrixSet.add(b.toLowerCase());
      }
    }
  } catch (e) { console.log("  ⚠ matrix enumeration failed — matrix-emitted events will be UNFILTERED"); }
  console.log(`  matrices enumerated: ${matrixSet.size}`);

  // ── one getLogs per window, OR-ing every topic we care about ──────────────────────────
  const ALL_TOPICS = Object.values(T);   // full 32-byte topic0s — never a prefix
  const holes = { n: 0, said: false };
  const logs = [];
  for (let a = FROM; a <= tip; a += CHUNK) {
    const b = Math.min(a + CHUNK - 1, tip);
    let got = null;
    for (let att = 0; att < 3 && got === null; att++) {
      try { got = await p.getLogs({ fromBlock: a, toBlock: b, topics: [ALL_TOPICS] }); }
      catch (e) { await new Promise((r) => setTimeout(r, 700 * (att + 1))); }
    }
    if (got === null) {
      holes.n++;
      if (!holes.said) { console.log(`    range ${a}-${b} FAILED — totals below are FLOORS`); holes.said = true; }
    } else logs.push(...got);
  }
  console.log(`  logs fetched: ${logs.length}   failed ranges: ${holes.n}\n`);

  // ⛔ ZERO LOGS WITH ZERO FAILURES IS A BROKEN INSTRUMENT, NOT AN EMPTY CHAIN. The fund holds
  // a non-zero balance and its counters are non-zero (read above), so events MUST exist in
  // range. Stop rather than print empty tables that read like a result.
  if (logs.length === 0) {
    console.error("  REFUSING TO CONTINUE: 0 logs matched across the whole range with 0 failed");
    console.error("  ranges. The fund's own counters are non-zero, so the filter is wrong, not");
    console.error("  the chain. Check the topic0 list and the FROM block before trusting anything.\n");
    process.exit(1);
  }

  // ── index by tx, keyed on TOPIC0 (never on a name — three names are ambiguous here) ──
  const sfAddr = A.stabilityFund.toLowerCase();
  const trAddr = (A.tierRouter || "").toLowerCase();
  const mkAddr = (A.matrixKeeper || A.MatrixKeeper || "").toLowerCase();
  const topic0 = (l) => l.topics[0];
  const byTx = new Map();
  const get = (h) => { if (!byTx.has(h)) byTx.set(h, { flags: new Set(), deposits: [], block: 0 }); return byTx.get(h); };

  const daily = new Map();
  const day = (bn) => {
    const d = dayOf(bn);
    if (!daily.has(d)) daily.set(d, { regs: 0, ups: 0, self: 0, copay: 0, keeper: 0, inflow: 0n, outflow: 0n, repaid: 0n });
    return daily.get(d);
  };

  let evtLoaned = 0n, evtRepaid = 0n, evtInflow = 0n;
  const bySource = { registration: 0n, upgrade: 0n, "self-rescue": 0n, copay: 0n, "keeper-rescue": 0n, MIXED: 0n, unattributed: 0n };

  for (const l of logs) {
    const t = topic0(l), from = l.address.toLowerCase();
    const tx = get(l.transactionHash); tx.block = l.blockNumber;

    if (t === T.FundDeposit && from === sfAddr) {
      const { args } = IFACE.parseLog(l);
      tx.deposits.push(args.amount);
      evtInflow += args.amount; day(l.blockNumber).inflow += args.amount;
    } else if (t === T.MemberDebtIncreased && from === sfAddr) {
      const { args } = IFACE.parseLog(l);
      evtLoaned += args.amount; day(l.blockNumber).outflow += args.amount;
    } else if (t === T.MemberDebtRepaid && from === sfAddr) {
      const { args } = IFACE.parseLog(l);
      evtRepaid += args.amount; day(l.blockNumber).repaid += args.amount;
    } else if (t === T.MemberRegistered && from === trAddr) { tx.flags.add("registration"); day(l.blockNumber).regs++; }
    else if (t === T.ManualUpgrade && from === trAddr)      { tx.flags.add("upgrade");      day(l.blockNumber).ups++; }
    else if (t === T.ParkedRescued && from === mkAddr)      { tx.flags.add("keeper-rescue"); day(l.blockNumber).keeper++; }
    else if (t === T.SelfRescue && (!matrixSet.size || matrixSet.has(from))) { tx.flags.add("self-rescue"); day(l.blockNumber).self++; }
    else if (t === T.CoPayRescue && (!matrixSet.size || matrixSet.has(from))) { tx.flags.add("copay"); day(l.blockNumber).copay++; }
  }

  // ── attribute inflow by what else was in the same tx ─────────────────────────────────
  for (const [, tx] of byTx) {
    if (!tx.deposits.length) continue;
    const sum = tx.deposits.reduce((a, x) => a + x, 0n);
    const f = [...tx.flags];
    if (f.length === 1) bySource[f[0]] += sum;
    else if (f.length === 0) bySource.unattributed += sum;
    else bySource.MIXED += sum;
  }

  // ── 1. daily table ───────────────────────────────────────────────────────────────────
  console.log("1. PER DAY — activity and money");
  console.log("day          regs   upgr   self  copay  keepR       SF in      SF out    repaid         net");
  console.log("─".repeat(96));
  const rows = [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [d, r] of rows) {
    const net = r.inflow + r.repaid - r.outflow;
    console.log(`${d}  ${pad(r.regs, 5)}  ${pad(r.ups, 5)}  ${pad(r.self, 5)}  ${pad(r.copay, 5)}  ${pad(r.keeper, 5)}  ` +
      `${pad(usd(r.inflow), 10)}  ${pad(usd(r.outflow), 10)}  ${pad(usd(r.repaid), 8)}  ${pad((net < 0n ? "-" : "+") + usd(net < 0n ? -net : net), 10)}`);
  }

  // ── 2. the regime comparison — THE ANSWER ────────────────────────────────────────────
  const active = rows.filter(([, r]) => r.regs >= BIGFILL_MIN_REGS);
  const quiet  = rows.filter(([, r]) => r.regs <  BIGFILL_MIN_REGS);
  const avg = (set) => {
    if (!set.length) return null;
    const s = set.reduce((a, [, r]) => ({
      inflow: a.inflow + r.inflow, outflow: a.outflow + r.outflow, repaid: a.repaid + r.repaid,
      regs: a.regs + r.regs, self: a.self + r.self, ups: a.ups + r.ups, keeper: a.keeper + r.keeper,
    }), { inflow: 0n, outflow: 0n, repaid: 0n, regs: 0, self: 0, ups: 0, keeper: 0 });
    const n = BigInt(set.length);
    return { days: set.length, inflow: s.inflow / n, outflow: s.outflow / n, repaid: s.repaid / n,
             net: (s.inflow + s.repaid - s.outflow) / n,
             regs: (s.regs / set.length).toFixed(1), self: (s.self / set.length).toFixed(1),
             ups: (s.ups / set.length).toFixed(1), keeper: (s.keeper / set.length).toFixed(1) };
  };
  const A_ = avg(active), Q_ = avg(quiet);

  console.log(`\n2. THE REGIME COMPARISON   (a day counts as BIGFILL-ACTIVE at >= ${BIGFILL_MIN_REGS} registrations — set BIGFILL_MIN_REGS to change)`);
  console.log("                        days   regs/d  self/d  upgr/d  keepR/d      in/day     out/day     net/day");
  console.log("─".repeat(96));
  for (const [label, v] of [["BIGFILL ACTIVE", A_], ["QUIET (organic)", Q_]]) {
    if (!v) { console.log(`${padr(label, 22)}  — no days in this regime —`); continue; }
    console.log(`${padr(label, 22)} ${pad(v.days, 5)}  ${pad(v.regs, 7)} ${pad(v.self, 7)} ${pad(v.ups, 7)} ${pad(v.keeper, 8)}  ` +
      `${pad(usd(v.inflow), 10)}  ${pad(usd(v.outflow), 10)}  ${pad((v.net < 0n ? "-" : "+") + usd(v.net < 0n ? -v.net : v.net), 10)}`);
  }

  // ── 3. inflow attribution ────────────────────────────────────────────────────────────
  console.log("\n3. WHERE THE INFLOW CAME FROM  (attributed by what else was in the same transaction)");
  const totalAttr = Object.values(bySource).reduce((a, x) => a + x, 0n);
  for (const [k, v] of Object.entries(bySource).sort((a, b) => (b[1] > a[1] ? 1 : -1))) {
    if (v === 0n) continue;
    const pct = totalAttr > 0n ? Number(v * 10000n / totalAttr) / 100 : 0;
    console.log(`   ${padr(k, 16)} ${pad(usd(v), 11)}   ${pct.toFixed(1)}%`);
  }
  const mixedPct = totalAttr > 0n ? Number((bySource.MIXED + bySource.unattributed) * 10000n / totalAttr) / 100 : 0;
  if (mixedPct > 25) {
    console.log(`   ⚠ ${mixedPct.toFixed(1)}% is MIXED or unattributed — a transaction carrying several`);
    console.log(`     classifiers is NOT guessed at. Above ~25% the attribution is weak; read the`);
    console.log(`     per-day table and the regime split instead, which do not depend on it.`);
  }

  // ── 4. reconciliation against the fund's own counters ────────────────────────────────
  console.log("\n4. RECONCILIATION — events vs the fund's OWN counters");
  console.log(`   loaned   events ${padr(usd(evtLoaned), 11)} contract ${padr(usd(cLoaned), 11)} ${evtLoaned === cLoaned ? "MATCH" : "⚠ DIFFER"}`);
  console.log(`   repaid   events ${padr(usd(evtRepaid), 11)} contract ${padr(usd(cRepaid), 11)} ${evtRepaid === cRepaid ? "MATCH" : "⚠ DIFFER"}`);
  console.log(`   outstanding (contract): ${usd(cLoaned - cRepaid)}     balance now: ${usd(cBalance)}`);
  if (evtLoaned !== cLoaned || evtRepaid !== cRepaid) {
    console.log("   ⚠ A DIFFERENCE IS A FINDING, NOT A ROUNDING ISSUE. With 0 failed ranges it means an");
    console.log("     unaccounted path; with >0 it is the holes. Check the failed-range count above first.");
  }

  // ── verdict ──────────────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(96));
  if (holes.n > 0) {
    console.log(`  NO VERDICT — ${holes.n} log ranges failed, so every total above is a FLOOR.`);
    console.log("  Re-run with WINDOW=3000 before drawing any conclusion.");
  } else if (!A_ || !Q_) {
    console.log("  NO COMPARISON — only one regime is present in this block range.");
    console.log("  Widen FROM to cover a period when bigfill was running.");
  } else {
    const aNet = A_.net, qNet = Q_.net;
    console.log(`  BIGFILL ACTIVE: net ${(aNet < 0n ? "-" : "+") + usd(aNet < 0n ? -aNet : aNet)}/day     QUIET: net ${(qNet < 0n ? "-" : "+") + usd(qNet < 0n ? -qNet : qNet)}/day`);
    if (aNet > qNet) {
      console.log("  -> THE OWNER IS RIGHT: the fund does better with bigfill running. Session 8's");
      console.log("     'bigfill does not replenish' is refuted by the chain's own history, and the");
      console.log("     drain series was measuring a population made passive by construction.");
    } else {
      console.log("  -> The fund does NOT do better with bigfill running, on this data. Before");
      console.log("     concluding, check the self/d column: if it is ~0 in BOTH regimes then the");
      console.log("     self-rescue mechanism never fired and this compares two passive worlds.");
    }
    console.log("  ⚠ NEITHER REGIME IS THE REAL WORLD. Bigfill wallets self-rescue and upgrade every");
    console.log("     time (~100%); stopped, they do neither (0%). Real members sit between, so read");
    console.log("     these two numbers as a BRACKET around the truth, never as the answer itself.");
  }
  console.log("═".repeat(96) + "\n");

  if (process.env.CSV) {
    const f = "sf_flows_" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
    fs.writeFileSync(f, "day,regs,upgrades,selfRescues,copay,keeperRescues,inflow,outflow,repaid\n" +
      rows.map(([d, r]) => `${d},${r.regs},${r.ups},${r.self},${r.copay},${r.keeper},${Number(r.inflow) / 1e6},${Number(r.outflow) / 1e6},${Number(r.repaid) / 1e6}`).join("\n"));
    console.log("  CSV written to " + f + "\n");
  }
})().catch((e) => { console.error("FAILED: " + (e.stack || e.message || e)); process.exit(1); });
