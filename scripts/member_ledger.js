// member_ledger.js — every number the dashboard aggregates, shown per matrix.
//
// WHY (2026-07-29): two reports on 0xe8Ad7bbA that both come down to the same
// thing — the dashboard shows ONE figure for something the contracts store
// TWENTY times, once per matrix.
//
//   1. "withdrew $1k but Total Withdrawn was not properly displayed"
//      `totalWithdrawn` is a per-matrix field (MatrixLogicLib:996). A single
//      withdrawal walks several matrices, so the headline is a SUM — and the
//      dashboard only sums matrices it enumerates (`hasEverJoined || _hasCredit`,
//      index.html:4581). Anything outside that filter is silently omitted.
//
//   2. "have a loan that is not being paid"
//      `rescueDebt` is ALSO per-matrix, and it only repays two ways:
//        a) _settlePool:450 — a slice of a POOL SHARE, `share * rescueRepayBps`.
//           But `if (share == 0) return;` sits ABOVE that block, so a member with
//           no pool accrual in that matrix gets NO gradual repayment, ever.
//        b) _cycleOutRoot:548 — from `withdrawable`, and only if it is > 0 at
//           that instant.
//      So a debt parked in a matrix the member no longer earns in, or cycles out
//      of, can sit untouched indefinitely — no matter how many times they rotate
//      SOMEWHERE ELSE. That is the shape of Sherwyn's $1.68.
//
// Prints, per matrix: seated/parked, withdrawable, freeWithdrawable, crossing
// reserve, totalEarned, totalWithdrawn, rescueDebt — then the sums, so a
// dashboard figure can be checked against the parts it claims to add up.
//
// Read-only. No key.
//
// Run:  ADDR=0x... node member_ledger.js

// PORTABLE (2026-07-29). `ethers` is installed in the contracts repo and on the
// VPS, NOT in CryptoNite-MT5-Bots where this file lives — and Node resolves
// modules from the SCRIPT's directory, not the working directory, so `cd`-ing
// somewhere else does not help. Copying the file next to node_modules used to
// break it instead, because it looked for .env and the addresses JSON beside
// itself. It now searches known locations for both and says which it used.
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const CANDIDATE_DIRS = [
  __dirname, process.cwd(),
  "C:/CryptoNite-MT5-Bots", "C:/CryptoNite-Smart-Contracts/CryptoNova", "/root/keeper",
  path.join(__dirname, "..", "CryptoNite-Smart-Contracts", "CryptoNova"),
];
function findFile(n) {
  for (const d of CANDIDATE_DIRS) {
    try { const f = path.join(d, n); if (fs.existsSync(f)) return f; } catch (_) {}
  }
  return null;
}
for (const d of CANDIDATE_DIRS) {
  try { const f = path.join(d, ".env"); if (fs.existsSync(f)) require("dotenv").config({ path: f }); } catch (_) {}
}

// RPC= wins: the paid Alchemy endpoint expired 2026-07-29, so a stale .env may
// still name a dead provider.
const RPC_URL    = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRS_NAME = process.env.ADDRESSES_FILE || "deployed_addresses_v8_45.json";
const ADDRS_PATH = process.env.ADDRESSES_PATH || findFile(ADDRS_NAME);
const WHO        = (process.env.ADDR || "").trim();

const TR_ABI = ["function getAllTiers() view returns (address[10], uint256[10])",
                "function memberHighestTier(address) view returns (uint8)",
                "function reservedFor(address) view returns (uint256)"];
const PM_ABI = ["function pairCount() view returns (uint256)",
                "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "function getMember(address) view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))",
  "function freeWithdrawable(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function rescueDebtOf(address) view returns (uint256)",
  "function parkedAt(address) view returns (uint256)",
  "function stabilityFund() view returns (address)",
];
const SF_ABI = ["function rescueRepayBps() view returns (uint256)"];

const usd = v => "$" + Number(ethers.formatUnits(v, 6)).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

async function rd(fn, dflt = null) { try { return await fn(); } catch { return dflt; } }

async function main() {
  if (!WHO) { console.log("Usage: ADDR=0x... node member_ledger.js"); process.exit(1); }
  if (!RPC_URL) {
    console.log("FATAL: no RPC. Pass RPC=https://sepolia.base.org, or put BASE_SEPOLIA_RPC_URL in a .env in one of:");
    CANDIDATE_DIRS.forEach(d => console.log("   " + d));
    process.exit(1);
  }
  if (!ADDRS_PATH) {
    console.log(`FATAL: could not find ${ADDRS_NAME}. Looked in:`);
    CANDIDATE_DIRS.forEach(d => console.log("   " + d));
    console.log("Or pass ADDRESSES_PATH=C:/CryptoNite-MT5-Bots/" + ADDRS_NAME);
    process.exit(1);
  }
  const who = ethers.getAddress(WHO);
  const p  = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const a  = JSON.parse(fs.readFileSync(ADDRS_PATH, "utf8"));
  console.log(`rpc ${String(RPC_URL).replace(/\/v2\/.*/, "/v2/****")}   ·   addresses ${ADDRS_PATH}`);
  const tr = new ethers.Contract(a.tierRouter, TR_ABI, p);
  const [pms] = await tr.getAllTiers();
  const ht  = Number(await rd(() => tr.memberHighestTier(who), 0));
  const rsv = await rd(() => tr.reservedFor(who), 0n);

  console.log(`member_ledger — ${who}`);
  console.log(`memberHighestTier T${ht}   ·   TierRouter.reservedFor ${usd(rsv)}   ·   ${new Date().toISOString()}\n`);
  console.log("matrix          state      withdrawable   freeWd    reserve   totalEarned  totalWithdrawn    DEBT");
  console.log("─".repeat(108));

  let sWd=0n, sFree=0n, sRes=0n, sEarn=0n, sOut=0n, sDebt=0n;
  const debts=[];
  let repayBps=null, sfAddr=null;

  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    const n = await rd(() => pm.pairCount(), 0n);
    for (let i = 0; i < Number(n); i++) {
      const pr = await rd(() => pm.getPairAt(i));
      if (!pr) continue;
      for (const [half, addr] of [["MatA", pr[0]], ["MatB", pr[1]]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const c = new ethers.Contract(addr, MAT_ABI, p);
        const m = await rd(() => c.getMember(who));
        if (!m) continue;
        const debt = await rd(() => c.rescueDebtOf(who), 0n);
        const free = await rd(() => c.freeWithdrawable(who), 0n);
        const res  = await rd(() => c.crossingReserveOf(who), 0n);
        const pk   = await rd(() => c.parkedAt(who), 0n);
        // Skip matrices this member has never touched at all.
        if (!m.hasEverJoined && m.withdrawable === 0n && m.totalWithdrawn === 0n && debt === 0n) continue;
        if (sfAddr === null) sfAddr = await rd(() => c.stabilityFund(), null);

        const state = m.isInMatrix ? "seated" : (pk > 0n ? "parked" : (m.hasEverJoined ? "left" : "credit"));
        sWd+=m.withdrawable; sFree+=free; sRes+=res; sEarn+=m.totalEarned; sOut+=m.totalWithdrawn; sDebt+=debt;
        if (debt > 0n) debts.push({ label:`T${t+1}.${i+1} ${half}`, debt, wd:m.withdrawable, seated:m.isInMatrix, parked:pk>0n });
        console.log(
          `${`T${t+1}.${i+1} ${half}`.padEnd(15)} ${state.padEnd(9)} ${pad(usd(m.withdrawable),12)} ${pad(usd(free),9)} ` +
          `${pad(usd(res),9)} ${pad(usd(m.totalEarned),12)} ${pad(usd(m.totalWithdrawn),15)} ${pad(debt>0n?usd(debt):"-",7)}`
        );
      }
    }
  }
  console.log("─".repeat(108));
  console.log(`${"SUM".padEnd(15)} ${"".padEnd(9)} ${pad(usd(sWd),12)} ${pad(usd(sFree),9)} ${pad(usd(sRes),9)} ${pad(usd(sEarn),12)} ${pad(usd(sOut),15)} ${pad(sDebt>0n?usd(sDebt):"-",7)}`);

  console.log(`\nWHAT THE DASHBOARD SHOULD SHOW`);
  console.log(`  TOTAL WITHDRAWN  ${usd(sOut)}   <- sum of the per-matrix totalWithdrawn column`);
  console.log(`  TOTAL EARNED     ${usd(sEarn)}`);
  console.log(`  WITHDRAWABLE     ${usd(sFree)}   (freeWithdrawable — after crossing + automation locks)`);
  console.log(`  If the screen disagrees with these, it is an ENUMERATION problem: index.html only`);
  console.log(`  counts matrices passing \`hasEverJoined || withdrawable > 0\` (:4581), so a matrix`);
  console.log(`  showing state "left" with a nonzero totalWithdrawn and no balance is EXCLUDED —`);
  console.log(`  its withdrawal history vanishes from the headline.`);

  if (sfAddr && sfAddr !== ethers.ZeroAddress) {
    repayBps = await rd(() => new ethers.Contract(sfAddr, SF_ABI, p).rescueRepayBps(), null);
  }
  console.log(`\nRESCUE DEBT`);
  if (!debts.length) { console.log(`  none outstanding.`); }
  else {
    console.log(`  StabilityFund ${sfAddr ?? "?"}   rescueRepayBps ${repayBps ?? "?"}` +
                (repayBps !== null ? `  (${Number(repayBps)/100}% of each pool share)` : ""));
    for (const d of debts) {
      console.log(`  ${d.label}: ${usd(d.debt)} outstanding · withdrawable here ${usd(d.wd)} · ${d.seated?"seated":d.parked?"parked":"not seated"}`);
      const reasons=[];
      if (!d.seated) reasons.push("NOT SEATED here — earns no pool share, so the gradual path (_settlePool:450) never runs");
      if (d.wd === 0n) reasons.push("withdrawable is $0 here — the cycle-out path (:548) has nothing to take");
      if (repayBps !== null && Number(repayBps) === 0) reasons.push("rescueRepayBps is 0 — the gradual path is switched off system-wide");
      if (reasons.length) reasons.forEach(r => console.log(`      why it is not repaying: ${r}`));
      else console.log(`      should be repaying gradually as pool shares settle — check RescueDebtRepaid events`);
    }
    console.log(`\n  KEY POINT: debt is PER-MATRIX. Rotating in a DIFFERENT matrix does nothing for it.`);
    console.log(`  Repayment needs either a pool share in THIS matrix, or a cycle-out from THIS matrix`);
    console.log(`  with a positive withdrawable. Neither happens to a member who has moved on.`);
  }
}

main().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
