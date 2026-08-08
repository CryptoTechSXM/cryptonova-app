// wallet_inflow.js — every USDC payment that has ever landed in this wallet,
// grouped by which contract sent it, reconciled against the matrices' own ledgers.
//
// WHY THIS EXISTS INSTEAD OF withdraw_events.js (2026-07-29)
// ─────────────────────────────────────────────────────────────────────────────
// The question is "the dashboard says $1,947.50 withdrawn but I withdrew $1,000
// twice". withdraw_events.js answers it by scanning EarningsWithdrawn on each of
// 14 matrices — at the free endpoint's measured range cap (between 2,000 and
// 9,000 blocks; PROBE proved 2,000 OK / 9,000 FAIL) that is ~2,800 eth_getLogs
// calls, and "could not coalesce error" is this provider's 429. It would rate-
// limit into holes and produce another INCONCLUSIVE floor.
//
// The same fact is available from ONE contract. Every withdrawal ends in
//   MatrixLogicLib.withdrawCore:1007  cfg.usdc.safeTransfer(recipient, payout)
// so scanning USDC's own Transfer(from=*, to=member) captures every payout from
// every matrix in a single filter — ~100 chunks instead of ~2,800, and it is the
// wallet-side view, which is exactly the view the complaint is made from.
//
// WHAT TO COMPARE, AND WHY THE FEE MATTERS HERE
//   The ledger field `totalWithdrawn` is GROSS (incremented at :996, before the
//   1.5% fee is taken at :999). The USDC Transfer is NET. So they should differ
//   by exactly the fee and NOTHING else:
//
//       expected net  =  totalWithdrawn * (10000 - withdrawalFeeBps) / 10000
//                     =  $1,947.50 * 0.985  =  $1,918.29
//
//   If the wallet received ~$1,918 the chain and the dashboard agree and the
//   "$2,000" was never $2,000 — most likely a "withdraw all" that took whatever
//   was FREE at that moment (freeWithdrawable, after the crossing and automation
//   reserves) rather than a typed figure.
//   If the wallet received ~$1,970 (= $2,000 * 0.985), then $52.50 of GROSS went
//   missing from the ledger and that is a real accounting bug for V8.46.
//
// Payments that are NOT withdrawals are labelled, not silently mixed in: the
// keeper funding wallets, the StabilityFund, and plain transfers all show up here
// and would inflate the total if lumped together.
//
// Read-only. No key.
//
// Run:  ADDR=0x... node wallet_inflow.js
//       ADDR=0x... WINDOW=2000 FROM=44750000 node wallet_inflow.js   (today only)

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const CANDIDATE_DIRS = [
  __dirname, process.cwd(),
  "C:/CryptoNite-MT5-Bots", "C:/CryptoNite-Smart-Contracts/CryptoNova", "/root/keeper",
  path.join(__dirname, "..", "CryptoNite-Smart-Contracts", "CryptoNova"),
];
function findFile(name) {
  for (const d of CANDIDATE_DIRS) { try { const f = path.join(d, name); if (fs.existsSync(f)) return f; } catch (_) {} }
  return null;
}
for (const d of CANDIDATE_DIRS) {
  try { const f = path.join(d, ".env"); if (fs.existsSync(f)) require("dotenv").config({ path: f }); } catch (_) {}
}

const RPC_URL    = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRS_PATH = process.env.ADDRESSES_PATH || findFile(process.env.ADDRESSES_FILE || "deployed_addresses_v8_45.json");
const WHO        = (process.env.ADDR || "").trim();
// 2,000 measured safe on sepolia.base.org; 9,000 fails. Do not raise blindly.
const WINDOW     = Number(process.env.WINDOW || 2000);
const FROM       = Number(process.env.FROM || 44_600_000);

const ERC20_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const TR_ABI    = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI    = ["function pairCount() view returns (uint256)",
                   "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI   = ["function getMemberTotalWithdrawn(address) view returns (uint256)",
                   "function withdrawalFeeBps() view returns (uint256)"];

const usd = v => "$" + Number(ethers.formatUnits(v, 6)).toFixed(2);
const pad = (s, n) => String(s).padStart(n);
const why = e => ((e && (e.shortMessage || e.info?.error?.message || e.message)) || String(e)).replace(/\s+/g, " ").slice(0, 140);
async function rd(fn, d = null) { try { return await fn(); } catch { return d; } }

async function main() {
  if (!WHO)      { console.log("Usage: ADDR=0x... node wallet_inflow.js"); process.exit(1); }
  if (!RPC_URL)  { console.log("FATAL: no RPC. Pass RPC=https://sepolia.base.org"); process.exit(1); }
  if (!ADDRS_PATH) { console.log("FATAL: addresses file not found"); process.exit(1); }

  const who = ethers.getAddress(WHO);
  const p   = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const a   = JSON.parse(fs.readFileSync(ADDRS_PATH, "utf8"));
  const tip = await p.getBlockNumber();

  console.log(`wallet_inflow — ${who}`);
  console.log(`blocks ${FROM}..${tip}  ·  window ${WINDOW}  ·  ${new Date().toISOString()}`);

  // Map every matrix address to a label so senders can be named, and collect the
  // GROSS ledger figure at the same time.
  console.log(`\nbuilding the matrix map…`);
  const label = new Map(); let gross = 0n, feeBps = null;
  const [pms] = await new ethers.Contract(a.tierRouter, TR_ABI, p).getAllTiers();
  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    const n  = Number(await rd(() => pm.pairCount(), 0n));
    for (let i = 0; i < n; i++) {
      const pr = await rd(() => pm.getPairAt(i));
      if (!pr) continue;
      for (const [half, addr] of [["MatA", pr[0]], ["MatB", pr[1]]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        label.set(addr.toLowerCase(), `T${t + 1}.${i + 1} ${half}`);
        const c = new ethers.Contract(addr, MAT_ABI, p);
        const tw = await rd(() => c.getMemberTotalWithdrawn(who), 0n);
        if (tw > 0n) gross += tw;
        if (feeBps === null && tw > 0n) feeBps = await rd(() => c.withdrawalFeeBps(), null);
      }
    }
  }
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string" && v.startsWith("0x") && v.length === 42) {
      if (!label.has(v.toLowerCase())) label.set(v.toLowerCase(), k);
    }
  }
  console.log(`  ${label.size} known addresses mapped`);

  const usdc = new ethers.Contract(a.usdc, ERC20_ABI, p);
  const filter = usdc.filters.Transfer(null, who);
  const logs = []; let holes = 0, reported = false;
  const chunks = Math.ceil((tip - FROM + 1) / WINDOW);
  console.log(`\nscanning USDC Transfer -> this wallet in ${chunks} chunks…`);
  let done = 0;
  for (let b = FROM; b <= tip; b += WINDOW) {
    const e = Math.min(b + WINDOW - 1, tip);
    let got = null, lastErr = null;
    for (let att = 0; att < 4 && got === null; att++) {
      try { got = await usdc.queryFilter(filter, b, e); }
      catch (err) { lastErr = err; await new Promise(r => setTimeout(r, 600 * (att + 1))); }
    }
    if (got === null) { holes++; if (!reported) { console.log(`  ! ${b}-${e} FAILED — ${why(lastErr)}`); reported = true; } }
    else logs.push(...got);
    if (++done % 25 === 0) console.log(`  …${done}/${chunks} chunks, ${logs.length} payments so far`);
  }
  if (holes) console.log(`  ! ${holes} chunk(s) failed — totals below are a FLOOR`);

  logs.sort((x, y) => x.blockNumber - y.blockNumber);

  console.log(`\nEVERY USDC PAYMENT INTO THIS WALLET`);
  console.log("block      amount        from                                        what");
  console.log("─".repeat(104));
  let fromMatrix = 0n, fromOther = 0n;
  for (const ev of logs) {
    const src = ev.args.from.toLowerCase();
    const name = label.get(src);
    const isMatrix = name && /^T\d+\.\d+ Mat[AB]$/.test(name);
    if (isMatrix) fromMatrix += ev.args.value; else fromOther += ev.args.value;
    console.log(`${pad(ev.blockNumber, 9)}  ${pad(usd(ev.args.value), 12)}  ${ev.args.from}  ` +
                (isMatrix ? `WITHDRAWAL from ${name}` : (name ? `(${name} — not a withdrawal)` : "(unknown sender — not a withdrawal)")));
  }
  if (!logs.length) console.log("  (none found)");

  const bps = feeBps === null ? 150n : BigInt(feeBps);
  const expectedNet = gross * (10000n - bps) / 10000n;

  console.log(`\nRECONCILIATION`);
  console.log(`  stored totalWithdrawn, GROSS  (the dashboard figure)   ${pad(usd(gross), 12)}`);
  console.log(`  minus the ${Number(bps) / 100}% withdrawal fee                        ${pad("-" + usd(gross - expectedNet), 12)}`);
  console.log(`  => NET the chain says you should have received         ${pad(usd(expectedNet), 12)}`);
  console.log(`  actual USDC received FROM MATRICES                    ${pad(usd(fromMatrix), 12)}`);
  console.log(`  other USDC received (funding, SF, transfers)          ${pad(usd(fromOther), 12)}   <- excluded on purpose`);

  const diff = fromMatrix > expectedNet ? fromMatrix - expectedNet : expectedNet - fromMatrix;
  console.log(`\nVERDICT`);
  if (holes) {
    console.log(`  INCONCLUSIVE — ${holes} chunk(s) unread. Re-run with WINDOW=1000 before believing any figure.`);
  } else if (diff <= 10000n) { // within 1 cent
    console.log(`  MATCHED to within a cent. The chain, the dashboard and your wallet all agree.`);
    console.log(`  There is no missing $52.50: the two withdrawals together moved ${usd(gross)} gross,`);
    console.log(`  not $2,000. A "withdraw all" takes freeWithdrawable at that instant — whatever was`);
    console.log(`  free after the crossing and automation reserves — which is rarely a round number.`);
    console.log(`  The odd figures in the ledger ($93.84, $144.66) are the signature of exactly that.`);
  } else {
    console.log(`  MISMATCH of ${usd(diff)} between the ledger and the money.`);
    console.log(`  totalWithdrawn is incremented in the same statement that debits withdrawable`);
    console.log(`  (withdrawCore:995-996) and the transfer is 8 lines later in the same function,`);
    console.log(`  so these cannot legitimately differ. Treat as a V8.46 accounting bug and`);
    console.log(`  identify the matrix by re-running withdraw_events.js with WINDOW=2000.`);
  }
}

main().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
