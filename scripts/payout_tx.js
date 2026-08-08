// payout_tx.js — for each USDC payout into a wallet, fetch the TRANSACTION that
// caused it and show who called what, plus who got the ledger credit.
//
// WHY (2026-07-29): wallet_inflow.js proved that T3.1 MatA paid 0xe8Ad7bbA $51.71
// (gross $52.50) while that matrix's `totalWithdrawn` for 0xe8Ad7bbA reads $0.00.
// Fourteen other matrices reconciled to the cent, so the mechanism is not broken
// in general — one payout took a different path.
//
// There is exactly ONE line in the system that sends USDC to a member:
//     MatrixLogicLib.withdrawCore:1007   cfg.usdc.safeTransfer(recipient, payout)
// and it is eight lines below
//     :996                              totalWithdrawn[member] += amt
//
// Note the two different names. `member` is whose ledger is debited; `recipient`
// is who gets the cash. FigureEightMatrixV8 exposes both:
//     withdraw()                     -> member = msg.sender, recipient = msg.sender
//     withdrawPartial(amount)        -> member = msg.sender, recipient = msg.sender
//     withdrawTo(recipient)          -> member = msg.sender, recipient = ANYONE
//     withdrawPartialTo(recipient,a) -> member = msg.sender, recipient = ANYONE
//
// So a payout can legitimately land in wallet X while the ledger entry is written
// against wallet Y — if the call came from Y. That is the first hypothesis and it
// is CHEAP TO TEST: read the matrix's totalWithdrawn for the transaction's SENDER.
// If the sender's ledger holds the missing $52.50, nothing is lost and nothing is
// corrupted; the money simply belongs to a different account's history than the
// wallet it arrived in. If NOBODY's ledger holds it, that is a real accounting
// bug for V8.46.
//
// Do not guess from the amount. Fetch the transaction. (2026-07-29, twice.)
//
// Read-only. No key.
//
// Run:  ADDR=0x... FROM=44796400 TO=44796800 node payout_tx.js
//       ADDR=0x... MATRIX=0x827B... node payout_tx.js     (one matrix only)

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const CANDIDATE_DIRS = [
  __dirname, process.cwd(),
  "C:/CryptoNite-MT5-Bots", "C:/CryptoNite-Smart-Contracts/CryptoNova", "/root/keeper",
  path.join(__dirname, "..", "CryptoNite-Smart-Contracts", "CryptoNova"),
];
function findFile(n) { for (const d of CANDIDATE_DIRS) { try { const f = path.join(d, n); if (fs.existsSync(f)) return f; } catch (_) {} } return null; }
for (const d of CANDIDATE_DIRS) { try { const f = path.join(d, ".env"); if (fs.existsSync(f)) require("dotenv").config({ path: f }); } catch (_) {} }

const RPC_URL    = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRS_PATH = process.env.ADDRESSES_PATH || findFile(process.env.ADDRESSES_FILE || "deployed_addresses_v8_45.json");
const WHO        = (process.env.ADDR || "").trim();
const ONLY       = (process.env.MATRIX || "").trim().toLowerCase();
const FROM       = Number(process.env.FROM || 44_796_400);
const TO_BLK     = Number(process.env.TO || 44_796_800);
const WINDOW     = Number(process.env.WINDOW || 200);

const ERC20_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const TR_ABI    = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI    = ["function pairCount() view returns (uint256)",
                   "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI   = ["function getMemberTotalWithdrawn(address) view returns (uint256)",
                   "function withdrawableOf(address) view returns (uint256)"];

// Selectors for every entry point that can move money out to a member.
const SIGS = [
  "withdraw()", "withdrawPartial(uint256)", "withdrawTo(address)",
  "withdrawPartialTo(address,uint256)", "keeperFullWithdraw(address)",
  "bulkWithdraw(address[])", "selfRescue()", "coPayRescue(address)",
  "manualUpgrade(uint8)", "bulkUpgrade(uint8)", "performUpkeep(bytes)",
  "register(address)", "releaseReserve(address)", "adminReleaseStrandedReserve(address)",
  "exitSeat()",
];
const SELECTOR = new Map(SIGS.map(s => [ethers.id(s).slice(0, 10), s]));

const usd = v => "$" + Number(ethers.formatUnits(v, 6)).toFixed(2);
async function rd(fn, d = null) { try { return await fn(); } catch { return d; } }

async function main() {
  if (!WHO)     { console.log("Usage: ADDR=0x... node payout_tx.js"); process.exit(1); }
  if (!RPC_URL) { console.log("FATAL: no RPC"); process.exit(1); }
  const who = ethers.getAddress(WHO);
  const p   = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const a   = JSON.parse(fs.readFileSync(ADDRS_PATH, "utf8"));

  const label = new Map();
  const [pms] = await new ethers.Contract(a.tierRouter, TR_ABI, p).getAllTiers();
  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    for (let i = 0; i < Number(await rd(() => pm.pairCount(), 0n)); i++) {
      const pr = await rd(() => pm.getPairAt(i));
      if (!pr) continue;
      for (const [h, ad] of [["MatA", pr[0]], ["MatB", pr[1]]])
        if (ad && ad !== ethers.ZeroAddress) label.set(ad.toLowerCase(), `T${t + 1}.${i + 1} ${h}`);
    }
  }

  const usdc = new ethers.Contract(a.usdc, ERC20_ABI, p);
  const logs = [];
  for (let b = FROM; b <= TO_BLK; b += WINDOW) {
    const e = Math.min(b + WINDOW - 1, TO_BLK);
    const got = await rd(() => usdc.queryFilter(usdc.filters.Transfer(null, who), b, e));
    if (got === null) console.log(`  ! ${b}-${e} unreadable`); else logs.push(...got);
  }

  console.log(`payout_tx — ${who}   blocks ${FROM}..${TO_BLK}\n`);
  let flagged = 0;

  for (const ev of logs) {
    const src = ev.args.from.toLowerCase();
    const name = label.get(src);
    if (!name) continue;                       // not a matrix payout
    if (ONLY && src !== ONLY) continue;

    const tx  = await rd(() => p.getTransaction(ev.transactionHash));
    const sel = tx?.data ? tx.data.slice(0, 10) : "?";
    const fn  = SELECTOR.get(sel) || `unknown ${sel}`;
    const mat = new ethers.Contract(ev.args.from, MAT_ABI, p);

    // The decisive pair of reads: whose ledger recorded this?
    const twRecipient = await rd(() => mat.getMemberTotalWithdrawn(who), null);
    const caller      = tx ? ethers.getAddress(tx.from) : null;
    const twCaller    = caller && caller.toLowerCase() !== who.toLowerCase()
      ? await rd(() => mat.getMemberTotalWithdrawn(caller), null) : null;

    const ok = twRecipient !== null && twRecipient > 0n;
    if (!ok) flagged++;

    console.log(`${name}  block ${ev.blockNumber}  paid ${usd(ev.args.value)}   ${ok ? "" : "<-- UNRECORDED"}`);
    console.log(`   tx        ${ev.transactionHash}`);
    console.log(`   called by ${caller ?? "?"}${caller && caller.toLowerCase() === who.toLowerCase() ? "  (the recipient themselves)" : "  (NOT the recipient)"}`);
    console.log(`   tx.to     ${tx?.to ?? "?"}${tx && tx.to && label.get(tx.to.toLowerCase()) ? `  = ${label.get(tx.to.toLowerCase())}` : (tx && tx.to && tx.to.toLowerCase() === a.tierRouter.toLowerCase() ? "  = TierRouter" : "")}`);
    console.log(`   function  ${fn}`);
    console.log(`   ledger in this matrix: totalWithdrawn[recipient] = ${twRecipient === null ? "READ FAILED" : usd(twRecipient)}`);
    if (twCaller !== null) console.log(`                          totalWithdrawn[caller]    = ${usd(twCaller)}`);
    console.log("");
  }

  console.log(`SUMMARY`);
  console.log(`  ${logs.length} inbound transfer(s) examined, ${flagged} with NO ledger entry for the recipient.`);
  if (flagged) {
    console.log(`\n  READ THE "called by" AND "function" LINES ABOVE FOR THE FLAGGED ROW:`);
    console.log(`   - called by the recipient, function withdraw/withdrawPartial`);
    console.log(`       -> the ledger SHOULD have been written. Real V8.46 accounting bug.`);
    console.log(`   - called by someone else, function withdrawTo/withdrawPartialTo`);
    console.log(`       -> working as written: withdrawCore debits msg.sender and pays`);
    console.log(`          `+"`recipient`"+`, so the history belongs to the caller. No money lost,`);
    console.log(`          but the dashboard can never show it, and any member can push a`);
    console.log(`          payout into someone else's wallet.`);
    console.log(`   - tx.to is the TierRouter`);
    console.log(`       -> a router-driven withdrawal; check whether the router passes the`);
    console.log(`          member through as msg.sender or calls on its own behalf.`);
  }
}

main().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
