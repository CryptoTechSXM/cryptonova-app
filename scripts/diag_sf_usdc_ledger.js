// diag_sf_usdc_ledger.js — WHERE DID ~$930 OF STABILITY FUND MONEY ACTUALLY GO?
//
// Built 2026-08-19 (session 9), immediately after diag_sf_flows.js produced a flat
// contradiction that must be resolved before ANY conclusion about the fund is safe.
//
// ── THE CONTRADICTION, AND IT IS THE FINDING ──────────────────────────────────────────
// diag_sf_flows.js measured, over V8.48's whole life (6.2 days, 0 failed ranges, and its
// loaned/repaid totals reconciled EXACTLY against the fund's own counters):
//
//     FundDeposit inflow      +$1,705.00
//     MemberDebtIncreased     -$1,343.94      (reconciles: contract says $1,343.94)
//     MemberDebtRepaid          +$608.21      (reconciles: contract says $608.21)
//     ------------------------------------
//     implied balance           +$969.27
//     ACTUAL totalBalance()        $36.94
//     ====================================
//     UNACCOUNTED                ~$932
//
// AND EVERY SINGLE DAY IN THAT TABLE WAS NET POSITIVE, while the balance fell
// $212.35 -> $87.50 -> $36.94 over the same period. A model that says "up every day" while
// the balance goes down is not a small error — it is a missing path, and it is worth more
// than the question it was built to answer.
//
// ⚠ SO THE "net/day" COLUMN IN diag_sf_flows.js IS VOID AND MUST NOT BE QUOTED. Its OUTFLOW
//   column is trustworthy (it reconciles to the contract counter); its INFLOW column measures
//   FundDeposit EVENTS, which evidently do not equal cash the fund keeps.
//
// ── WHY THIS SCRIPT IS THE RIGHT INSTRUMENT ───────────────────────────────────────────
// Every previous number came from EVENTS THE PROTOCOL CHOSE TO EMIT. This one reads the
// only thing that cannot be incomplete: the ERC-20 ledger. Every USDC Transfer with the
// StabilityFund as sender or receiver, in and out, by counterparty. If money left, it left
// as a Transfer, and there is no path around that.
//
// House rule this follows: PREFER CONTRACT STATE OVER RECONSTRUCTION, and when an
// event-derived figure and a state figure disagree, the state figure wins and the gap is
// the thing to explain.
//
// ── CANDIDATE EXPLANATIONS — LISTED SO THEY CAN BE REFUTED, NOT ASSUMED ───────────────
//   1. communityOverflowBps = 10000 (V8.48 item 26): 100% of at-target L1 inflow is routed
//      to the CommunityWallet. If the fund crossed its target early in its life, surplus
//      would have flowed out BY DESIGN and would be entirely correct.
//   2. FundDeposit may be emitted for money the fund only passes through — the layer model
//      is 1/3/5 and the event carries a `layer` argument.
//   3. Some payout path books no debt, so MemberDebtIncreased understates cash out.
//   4. A real leak.
// ⚠ DO NOT PICK ONE FROM THE LIST ABOVE BEFORE RUNNING THIS. The counterparty table below
//   answers it directly: whoever received the money is named, with amounts and dates.
//
// Read-only. No wallet, no writes.
//
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_sf_usdc_ledger.js
// Optional: FROM=<block>  WINDOW=3000  CSV=1

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) {
  console.error("\n  ADDRESSES_FILE is not set, and this script will not guess.\n");
  process.exit(1);
}
const A = require(path.join(__dirname, ADDRFILE));

const FROM  = Number(process.env.FROM || 45_428_000);
const CHUNK = Number(process.env.WINDOW || 9000);

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ERC20 = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const SF_ABI = [
  "function totalBalance() view returns (uint256)",
  "function totalRescueLoaned() view returns (uint256)",
  "function totalRescueRepaid() view returns (uint256)",
];
const TR_ABI = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI = ["function pairCount() view returns (uint256)", "function getPairAt(uint256) view returns (address,address)"];

const usd  = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const pad  = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

(async () => {
  if (!RPC) { console.log("FATAL: no RPC"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const SF = A.stabilityFund;
  const sf = new ethers.Contract(SF, SF_ABI, p);

  let totalBalance, loaned, repaid, usdcHeld;
  try {
    totalBalance = await sf.totalBalance();
    loaned = await sf.totalRescueLoaned();
    repaid = await sf.totalRescueRepaid();
    usdcHeld = await new ethers.Contract(A.usdc, ["function balanceOf(address) view returns (uint256)"], p).balanceOf(SF);
  } catch (e) {
    console.error("\n  REFUSING TO RUN: a state read failed — " + (e.shortMessage || e.message || "").slice(0, 90));
    console.error("  If eth_call is 503ing, Base Sepolia is not serving state reads.\n");
    process.exit(1);
  }

  const tip = await p.getBlockNumber();
  const t0 = (await p.getBlock(FROM)).timestamp;
  const t1 = (await p.getBlock(tip)).timestamp;
  const dayOf = (bn) => new Date((t0 + (bn - FROM) * (t1 - t0) / (tip - FROM)) * 1000).toISOString().slice(0, 10);

  console.log(`\n  addresses: ${ADDRFILE}`);
  console.log(`  StabilityFund ${SF}`);
  console.log(`  blocks ${FROM}..${tip}\n`);
  console.log(`  totalBalance() (internal accounting): ${usd(totalBalance)}`);
  console.log(`  USDC balanceOf(SF) (actual tokens)  : ${usd(usdcHeld)}` +
    (totalBalance === usdcHeld ? "   MATCH" : `   ⚠ DIFFER by ${usd(usdcHeld > totalBalance ? usdcHeld - totalBalance : totalBalance - usdcHeld)}`));
  console.log(`  lifetime loaned ${usd(loaned)}   repaid ${usd(repaid)}   outstanding ${usd(loaned - repaid)}\n`);

  // ── label every address we know, so counterparties are names not hex ────────────────
  const label = new Map();
  const put = (addr, name) => { if (addr && addr !== ethers.ZeroAddress) label.set(addr.toLowerCase(), name); };
  for (const [k, v] of Object.entries(A)) if (typeof v === "string" && v.startsWith("0x") && v.length === 42) put(v, k);
  try {
    const [pms] = await new ethers.Contract(A.tierRouter, TR_ABI, p).getAllTiers();
    for (let t = 0; t < pms.length; t++) {
      if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
      put(pms[t], `T${t + 1}.pm`);
      const pm = new ethers.Contract(pms[t], PM_ABI, p);
      const n = Number(await pm.pairCount());
      for (let i = 0; i < n; i++) {
        const [a, b] = await pm.getPairAt(i);
        put(a, `T${t + 1}.${i + 1}.MatA`); put(b, `T${t + 1}.${i + 1}.MatB`);
      }
    }
  } catch { console.log("  ⚠ matrix labelling failed — counterparties will show as raw addresses"); }
  const nameOf = (a) => label.get(a.toLowerCase()) || a.slice(0, 10) + ".." + a.slice(-4);

  // ── every USDC Transfer touching the SF ─────────────────────────────────────────────
  const topicSF = ethers.zeroPadValue(SF, 32);
  const holes = { n: 0 };
  const grab = async (topics) => {
    const out = [];
    for (let a = FROM; a <= tip; a += CHUNK) {
      const b = Math.min(a + CHUNK - 1, tip);
      let got = null;
      for (let att = 0; att < 3 && got === null; att++) {
        try { got = await p.getLogs({ address: A.usdc, fromBlock: a, toBlock: b, topics }); }
        catch { await new Promise((r) => setTimeout(r, 700 * (att + 1))); }
      }
      if (got === null) holes.n++; else out.push(...got);
    }
    return out;
  };
  const incoming = await grab([TRANSFER, null, topicSF]);
  const outgoing = await grab([TRANSFER, topicSF, null]);
  console.log(`  transfers IN ${incoming.length}   OUT ${outgoing.length}   failed ranges ${holes.n}\n`);

  if (incoming.length + outgoing.length === 0) {
    console.error("  REFUSING TO CONTINUE: no USDC transfers found for the fund at all. The fund");
    console.error("  holds tokens, so the filter or the USDC address is wrong, not the chain.\n");
    process.exit(1);
  }

  const daily = new Map();
  const byCounterIn = new Map(), byCounterOut = new Map();
  let totIn = 0n, totOut = 0n;
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  const day = (bn) => { const d = dayOf(bn); if (!daily.has(d)) daily.set(d, { in: 0n, out: 0n }); return daily.get(d); };

  for (const l of incoming) {
    const { args } = ERC20.parseLog(l);
    totIn += args.value; day(l.blockNumber).in += args.value; bump(byCounterIn, nameOf(args.from), args.value);
  }
  for (const l of outgoing) {
    const { args } = ERC20.parseLog(l);
    totOut += args.value; day(l.blockNumber).out += args.value; bump(byCounterOut, nameOf(args.to), args.value);
  }

  console.log("1. PER DAY — actual USDC movement");
  console.log("day               in         out          net      running");
  console.log("─".repeat(60));
  let run = 0n;
  for (const [d, r] of [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const net = r.in - r.out; run += net;
    console.log(`${d}  ${pad(usd(r.in), 10)}  ${pad(usd(r.out), 10)}  ${pad((net < 0n ? "-" : "+") + usd(net < 0n ? -net : net), 11)}  ${pad(usd(run), 10)}`);
  }

  console.log("\n2. WHO PAID THE FUND");
  for (const [k, v] of [...byCounterIn].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 15))
    console.log(`   ${padr(k, 26)} ${pad(usd(v), 11)}   ${(Number(v * 10000n / (totIn || 1n)) / 100).toFixed(1)}%`);

  console.log("\n3. ⛔ WHO THE FUND PAID — THIS IS THE COLUMN THAT ANSWERS THE QUESTION");
  for (const [k, v] of [...byCounterOut].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 15))
    console.log(`   ${padr(k, 26)} ${pad(usd(v), 11)}   ${(Number(v * 10000n / (totOut || 1n)) / 100).toFixed(1)}%`);

  console.log("\n4. RECONCILIATION — the ledger against the tokens actually held");
  const implied = totIn - totOut;
  console.log(`   transfers in            ${pad(usd(totIn), 11)}`);
  console.log(`   transfers out           ${pad(usd(totOut), 11)}`);
  console.log(`   implied balance         ${pad(usd(implied), 11)}`);
  console.log(`   actual USDC held        ${pad(usd(usdcHeld), 11)}   ${implied === usdcHeld ? "MATCH — the ledger is complete" : "⚠ DIFFER"}`);
  if (implied !== usdcHeld) {
    console.log(`   difference              ${pad(usd(implied > usdcHeld ? implied - usdcHeld : usdcHeld - implied), 11)}`);
    console.log("   A gap here means the fund held USDC BEFORE this block range — widen FROM to");
    console.log("   the fund's creation block. It does NOT mean tokens vanished.");
  }
  console.log(`\n   lending (MemberDebtIncreased, reconciled): ${usd(loaned)}`);
  console.log(`   total paid out (ERC-20 ground truth):      ${usd(totOut)}`);
  if (totOut > loaned) {
    console.log(`   ⛔ THE FUND PAID OUT ${usd(totOut - loaned)} MORE THAN IT LENT.`);
    console.log("   That difference is NOT rescue lending. Read section 3 — whoever received it is");
    console.log("   named there. If it is the CommunityWallet, this is communityOverflowBps = 10000");
    console.log("   working as designed (V8.48 item 26) and the fund is not leaking, it is SHARING");
    console.log("   its surplus. If it is anything else, that is the finding and it needs chasing.");
  }
  if (holes.n) console.log(`\n   ⚠ ${holes.n} failed ranges — every total above is a FLOOR. Re-run with WINDOW=3000.`);
  console.log("");

  if (process.env.CSV) {
    const f = "sf_usdc_ledger_" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
    fs.writeFileSync(f, "day,in,out\n" + [...daily.entries()].sort().map(([d, r]) => `${d},${Number(r.in) / 1e6},${Number(r.out) / 1e6}`).join("\n"));
    console.log("  CSV written to " + f + "\n");
  }
})().catch((e) => { console.error("FAILED: " + (e.stack || e.message || e)); process.exit(1); });
