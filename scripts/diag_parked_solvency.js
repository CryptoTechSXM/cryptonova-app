// diag_parked_solvency.js — CAN THE PAST-GRACE PARKED MEMBERS PAY THEIR OWN WAY OUT?
//
// THE QUESTION (handoff 34.7 item 2, 2026-08-24). 34.8 established that `_selfRescue`
// never consults `loanEligible`, so the insolvency floor cannot refuse it: a parked
// member with USDC in their wallet has a working exit that costs them the shortfall and
// nothing else. That reframes the whole problem — if they hold the money it is a
// FRONTEND/COMMS defect, and if they do not it is an economic one and the owner's
// `insolvencyFloorBps` dial is back on the table. Nobody has asked the chain yet.
//
// This asks. Read-only. It sends no transaction and needs no key.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// WHY THIS SCRIPT EXISTS RATHER THAN A GREP (2026-08-24 — keep this, it cost a session)
//
//   The cheap instrument was tried first: 103 bigfill run logs print a USDC balance
//   beside every self-rescue. It answered 1 of the 10 oldest and could never have
//   answered the rest. `simulateSelfRescues` (bigfill_v8.js:606) iterates bigfill's OWN
//   HD wallet list and asks each matrix `parkedAt(w.address)`; it never enumerates the
//   matrix parked queue. Its own empty-case string says so — "0 parked members in test
//   wallets". Nine of the ten oldest appear in ZERO logs because they are not bigfill
//   wallets. The logs are a census of the test cohort, not of the parked population.
//
//   The one that did appear, 0x52BEA7CE, appeared 105 times in 90 runs, every time as
//   `$0 USDC, keeper SF path`. It is the planted positive this script self-tests against.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// ⛔ THE SHORTFALL IS COMPUTED THE WAY THE DEPLOYED CONTRACT COMPUTES IT, AND THAT IS
//    NOT WHAT diag_headroom_stuck.js DOES.
//
//    `_selfRescue` (git show d382d37:contracts/MatrixLogicLib.sol:1464, V8.48) reads the
//    RAW struct field:
//
//        uint256 withdrawable    = self.members[member].withdrawable;
//        uint256 reserve         = self.members[member].crossingReserve;
//        uint256 effectiveContrib = reserve + withdrawable;
//        uint256 shortfall = cfg.entryFee > effectiveContrib
//                          ? cfg.entryFee - effectiveContrib : 0;
//        if (shortfall > 0) cfg.usdc.safeTransferFrom(member, address(this), shortfall);
//
//    `withdrawableOf()` (FigureEightMatrixV8:613) is NOT that field — V8.44 item D made
//    it `members[m].withdrawable + pendingPoolOf(...)`. diag_headroom_stuck.js:136 and
//    copay_rescue.js price with `withdrawableOf`, which is correct for the SF CO-PAY but
//    OVERSTATES what a member has for a SELF-rescue by their un-settled pool accrual.
//    So 34.6's "$0.15-$2.67" may be a FLOOR on what these members must actually find.
//
//    This script prints BOTH and flags any member where they disagree, rather than
//    silently picking one. Getting this wrong tells a member to bring too little money.
//
// ⛔ THE APPROVAL GOES TO THE MATRIX, NOT TierRouter. `safeTransferFrom` above is called
//    by the matrix on its own behalf, so `allowance(member, matrixAddress)` is what
//    gates it. CLAUDE.md carries this as a standing correction because a session already
//    told a member to approve the wrong spender.
//
// ⛔ NO SILENT FALLBACKS, ANYWHERE. Every read that fails raises a named PROBLEM and the
//    member's verdict becomes UNKNOWN rather than a number. 34.2: copay_rescue's
//    `parkedGracePeriod` fallback was 3600s while the chain answers 86400s, which would
//    silently shorten grace by 23 hours. Here an unreadable grace period ABORTS.
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/diag_parked_solvency.js --network baseSepolia
//
//   TIERS=T1,T2       limit the sweep (default: every tier in the addresses file)
//   INCLUDE_GRACE=1   also report members still inside grace (default: past-grace only)
//   CSV=out.csv       override the output path (default: logs/parked_solvency_<ts>.csv)
//   SELFTEST=0        disable the planted-positive check (do not, without a reason)
//   PROBE=0xabc...    use a different planted positive
//
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// 34.1 / 34.7 item 5: NO DEFAULT. The master copy of copay_rescue.js defaulted to a dead
// v8_45 and the droplet copy to a "current" symlink that had pointed at v8_47 for eleven
// days after V8.48 went live. Both would have printed confident numbers about a dead
// deployment. A hand-run diagnostic is exactly where that trap closes, because cron's
// .env is not there to save it.
if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.log("    npx hardhat run scripts/diag_parked_solvency.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
// getMember returns the Member struct; `withdrawable` is field 3 and `crossingReserve`
// field 9 (MatrixLogicLib:50). Named here so the tuple index is never guessed.
const MX_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function getMember(address) view returns (tuple(uint256 id,address referrer,uint256 joinedAt,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 cyclesCompleted,bool isInMatrix,bool hasEverJoined,uint256 crossingReserve))",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const KEEPER_ABI = ["function parkedGracePeriod() view returns (uint256)"];
const SF_ABI = [
  "function insolvencyFloorBps() view returns (uint256)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function memberDebtOf(address) view returns (uint256)",
  "function totalBalance() view returns (uint256)",
  "function loanEligible(address,uint8) view returns (bool)",             // V8.48
  "function loanEligibleFor(address,uint8,uint256) view returns (bool)",  // V8.49+
];

const usd = v => (v === null || v === undefined) ? "?" : "$" + (Number(v) / 1e6).toFixed(2);
const ts  = () => new Date().toISOString();

const problems = [];
const PROBLEM = (where, e) => {
  const detail = e ? `: ${(e.shortMessage || e.message || "unreadable").slice(0, 90)}` : "";
  problems.push(`${where}${detail}`);
  console.log(`  PROBLEM ${where}${detail}`);
};

// A transport error is the ABSENCE of an answer, not an answer. bigfill learned this the
// expensive way on 2026-08-19 (31 consecutive HH110s recorded as member refusals) and
// again on 2026-08-20 with stale nonces. Retry, then report as unreadable — never as a
// measured zero.
const isTransport = m =>
  /HH110|Invalid JSON-RPC|ECONNRESET|ETIMEDOUT|socket hang up|network|timeout|50[234]|fetch failed|could not coalesce/i
    .test(m || "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function read(label, fn, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return { ok: true, v: await fn() }; }
    catch (e) {
      last = e;
      if (!isTransport(e.shortMessage || e.message)) break;  // a revert is a real answer
      await sleep(400 * (i + 1));
    }
  }
  PROBLEM(label, last);
  return { ok: false, v: null };
}

async function main() {
  console.log(`[${ts()}] diag_parked_solvency — READ-ONLY, no transactions sent`);
  console.log(`  addresses   : ${process.env.ADDRESSES_FILE}`);
  console.log(`  network     : ${A.network || "?"}   deployed ${A.deployedAt || "?"}`);

  // ── grace: chain or nothing ────────────────────────────────────────────────────────
  const keeper = await ethers.getContractAt(KEEPER_ABI, A.matrixKeeper);
  const g = await read("parkedGracePeriod()", () => keeper.parkedGracePeriod());
  if (!g.ok) {
    console.log("  ABORT: grace period unreadable. Every past-grace verdict below would");
    console.log("  have been invented. 34.2 — the fallback here used to be 3600s against");
    console.log("  a live 86400s, which silently shortens grace by 23 hours.");
    return;
  }
  const grace = g.v;
  console.log(`  grace       : ${grace}s (${(Number(grace) / 3600).toFixed(1)}h), from chain`);

  // ── which insolvency rule is actually deployed (34.5) ──────────────────────────────
  const sf = await ethers.getContractAt(SF_ABI, A.stabilityFund);
  const zero = ethers.ZeroAddress;
  const probe = async fn => { try { await fn(); return true; } catch { return false; } };
  const hasV49 = await probe(() => sf.loanEligibleFor(zero, 0, 1n));
  const hasV48 = await probe(() => sf.loanEligible(zero, 0));
  const RULE = hasV49 ? "V8.49+ loanEligibleFor — amount-aware"
             : hasV48 ? "V8.48 loanEligible — FLAT gate on existing debt"
             : "NONE — deployed build not identified";
  const floor = await read("insolvencyFloorBps()", () => sf.insolvencyFloorBps());
  const sfBal = await read("SF totalBalance()",     () => sf.totalBalance());
  console.log(`  SF rule     : ${RULE}`);
  console.log(`  floor bps   : ${floor.ok ? floor.v : "?"}`);
  console.log(`  SF balance  : ${usd(sfBal.v)}   <- the V8.48 gate never reads this`);
  if (!hasV49 && !hasV48) {
    console.log("  ⛔ Neither signature answers. Identify the deployed build before reading on.");
    return;
  }

  const usdc = await ethers.getContractAt(USDC_ABI, A.usdc);
  const now  = BigInt(Math.floor(Date.now() / 1000));
  const tierKeys = (process.env.TIERS || "").split(",").map(s => s.trim()).filter(Boolean);
  const tiers = tierKeys.length ? tierKeys : Object.keys(A.tiers);
  const INCLUDE_GRACE = process.env.INCLUDE_GRACE === "1";

  // ── enumerate EVERY pair, not just pair 1 ──────────────────────────────────────────
  // CLAUDE.md's standing trap: `tiers.T1.matA` is pair 1 FOREVER while pairCount() grows,
  // and diag_headroom_stuck.js only ever looked there. A tier's later pairs are exactly
  // where a member the census missed would be sitting.
  const rows = [];
  const cov  = [];
  for (const tk of tiers) {
    const t = A.tiers[tk];
    if (!t || !t.pm) { PROBLEM(`${tk} pair manager absent from addresses file — TIER SKIPPED`); continue; }
    const pm = await ethers.getContractAt(PM_ABI, t.pm);
    const pc = await read(`${tk} pairCount()`, () => pm.pairCount());
    if (!pc.ok) { cov.push(`${tk}: pairCount UNREADABLE — TIER NOT SWEPT`); continue; }

    let seenPairs = 0, seenMx = 0, emptyMx = 0, parkedTotal = 0, pastGrace = 0;
    for (let i = 0n; i < pc.v; i++) {
      const pr = await read(`${tk} getPairAt(${i})`, () => pm.getPairAt(i));
      if (!pr.ok) continue;
      seenPairs++;
      for (let j = 0; j < 2; j++) {
        const addr = pr.v[j];
        if (addr === ethers.ZeroAddress) continue;
        const label = `${tk}.${i + 1n} ${j ? "MatB" : "MatA"}`;   // 1-BASED display, 0-based index
        const mx = await ethers.getContractAt(MX_ABI, addr);
        const cnt = await read(`${label} getParkedCount()`, () => mx.getParkedCount());
        if (!cnt.ok) continue;
        seenMx++;
        if (cnt.v === 0n) { emptyMx++; continue; }
        parkedTotal += Number(cnt.v);

        const fee = await read(`${label} ENTRY_FEE()`, () => mx.ENTRY_FEE());

        for (let k = 0n; k < cnt.v; k++) {
          const mr = await read(`${label} getParkedMember(${k})`, () => mx.getParkedMember(k));
          if (!mr.ok) continue;
          const m = mr.v;

          const pa = await read(`${label} parkedAt(${m.slice(0, 10)})`, () => mx.parkedAt(m));
          if (!pa.ok) continue;
          if (pa.v === 0n) continue;                       // already rescued out
          const ageS = now - pa.v;
          const inGrace = ageS < grace;
          if (inGrace && !INCLUDE_GRACE) continue;
          if (!inGrace) pastGrace++;

          // ── the measurement ────────────────────────────────────────────────────────
          const bal   = await read(`balanceOf(${m.slice(0, 10)})`,        () => usdc.balanceOf(m));
          const allow = await read(`allowance(${m.slice(0, 10)}->matrix)`, () => usdc.allowance(m, addr));
          const mem   = await read(`${label} getMember(${m.slice(0, 10)})`, () => mx.getMember(m));
          const wOf   = await read(`${label} withdrawableOf(${m.slice(0, 10)})`, () => mx.withdrawableOf(m));
          const debt  = await read(`memberDebtOf(${m.slice(0, 10)})`,      () => sf.memberDebtOf(m));
          const elig  = hasV48
            ? await read(`loanEligible(${m.slice(0, 10)})`, () => sf.loanEligible(m, Number(tk.slice(1)) - 1))
            : { ok: false, v: null };

          // EXACT _selfRescue arithmetic, raw struct field — see the header.
          let shortSelf = null, shortAccrual = null, res = null, wRaw = null;
          if (fee.ok && mem.ok) {
            res   = mem.v.crossingReserve;
            wRaw  = mem.v.withdrawable;
            const eff = res + wRaw;
            shortSelf = fee.v > eff ? fee.v - eff : 0n;
          }
          if (fee.ok && wOf.ok && mem.ok) {
            const effA = mem.v.crossingReserve + wOf.v;
            shortAccrual = fee.v > effA ? fee.v - effA : 0n;
          }

          // A verdict is only allowed when the reads it rests on succeeded.
          let verdict, gap = null;
          if (shortSelf === null || !bal.ok || !allow.ok) {
            verdict = "UNKNOWN (a read failed)";
          } else if (shortSelf === 0n) {
            verdict = "NO PAYMENT NEEDED — reserve+withdrawable already covers the fee";
          } else if (bal.v < shortSelf) {
            gap = shortSelf - bal.v;
            verdict = `CANNOT PAY — short ${usd(gap)}`;
          } else if (allow.v < shortSelf) {
            verdict = "APPROVAL ONLY — holds the money, matrix not approved";
          } else {
            verdict = "CAN SELF-RESCUE NOW — funded and approved";
          }

          rows.push({
            tier: tk, matrix: label, matrixAddr: addr, member: m,
            ageDays: (Number(ageS) / 86400).toFixed(2),
            inGrace,
            fee: fee.v, reserve: res, withdrawableRaw: wRaw,
            withdrawableWithAccrual: wOf.ok ? wOf.v : null,
            shortfallSelfRescue: shortSelf,
            shortfallWithAccrual: shortAccrual,
            usdcBalance: bal.ok ? bal.v : null,
            allowanceToMatrix: allow.ok ? allow.v : null,
            sfDebt: debt.ok ? debt.v : null,
            loanEligible: elig.ok ? elig.v : null,
            verdict,
          });
        }
      }
    }
    cov.push(`${tk}: pairs ${seenPairs}/${pc.v} | matrices ${seenMx} (${emptyMx} empty) | parked ${parkedTotal} | past-grace ${pastGrace}`);
  }

  // ── planted positive (CLAUDE.md: a detector that reports zero must find one first) ──
  const PROBE_ADDR = (process.env.PROBE || "0x52BEA7CE").toLowerCase();
  if (process.env.SELFTEST !== "0") {
    const hit = rows.find(r => r.member.toLowerCase().startsWith(PROBE_ADDR));
    console.log("\n  SELFTEST — planted positive " + PROBE_ADDR);
    if (!hit) {
      console.log(`  ⛔ NOT FOUND. bigfill logged this wallet parked with $0 USDC 105 times`);
      console.log(`     across 90 runs, most recently 2026-08-24. If this sweep cannot see`);
      console.log(`     it, the sweep is incomplete and NOTHING BELOW IS A CENSUS.`);
    } else if (hit.usdcBalance === null) {
      console.log(`  ⛔ found, but its balance read FAILED — the instrument is not answering.`);
    } else if (hit.usdcBalance === 0n) {
      console.log(`  ✅ found at ${hit.matrix}, balance ${usd(hit.usdcBalance)} — agrees with`);
      console.log(`     105 independent bigfill observations. The sweep sees what it should.`);
    } else {
      console.log(`  ⚠ found at ${hit.matrix} holding ${usd(hit.usdcBalance)}, but bigfill read`);
      console.log(`     $0.00 as recently as 2026-08-24. Either it was funded since, or one`);
      console.log(`     of the two instruments is wrong. RESOLVE THIS BEFORE QUOTING THE TABLE.`);
    }
  }

  // ── report ─────────────────────────────────────────────────────────────────────────
  console.log("\n  COVERAGE");
  cov.forEach(c => console.log("    " + c));

  console.log(`\n  ${INCLUDE_GRACE ? "ALL" : "PAST-GRACE"} PARKED MEMBERS — ${rows.length}`);
  console.log("  " + "-".repeat(108));
  console.log("  member        matrix         age    fee     short    wallet   allow    debt   verdict");
  for (const r of rows.sort((a, b) => Number(b.ageDays) - Number(a.ageDays))) {
    console.log(
      `  ${r.member.slice(0, 10)}  ${r.matrix.padEnd(13)} ${String(r.ageDays).padStart(5)}d ` +
      `${usd(r.fee).padStart(7)} ${usd(r.shortfallSelfRescue).padStart(8)} ` +
      `${usd(r.usdcBalance).padStart(8)} ${usd(r.allowanceToMatrix).padStart(8)} ` +
      `${usd(r.sfDebt).padStart(7)}  ${r.verdict}`
    );
  }

  // The divergence that matters — see the header. If these disagree, 34.6's shortfalls
  // are a floor and any member-facing number derived from them is too low.
  const diverge = rows.filter(r =>
    r.shortfallSelfRescue !== null && r.shortfallWithAccrual !== null &&
    r.shortfallSelfRescue !== r.shortfallWithAccrual);
  if (diverge.length) {
    console.log(`\n  ⛔ ${diverge.length} member(s) where the SELF-RESCUE shortfall exceeds the`);
    console.log("     co-pay-priced one, because withdrawableOf() includes un-settled pool");
    console.log("     accrual that _selfRescue does not read. THE SELF-RESCUE FIGURE IS THE");
    console.log("     ONE TO QUOTE A MEMBER — the other tells them to bring too little.");
    for (const r of diverge) {
      console.log(`     ${r.member.slice(0, 10)}  selfRescue ${usd(r.shortfallSelfRescue)}  vs  withAccrual ${usd(r.shortfallWithAccrual)}`);
    }
  }

  const tally = { fundedApproved: 0, approvalOnly: 0, cannotPay: 0, noneNeeded: 0, unknown: 0 };
  let totalGap = 0n;
  for (const r of rows) {
    if (r.verdict.startsWith("CAN SELF-RESCUE"))      tally.fundedApproved++;
    else if (r.verdict.startsWith("APPROVAL ONLY"))   tally.approvalOnly++;
    else if (r.verdict.startsWith("CANNOT PAY"))    { tally.cannotPay++;
      if (r.shortfallSelfRescue !== null && r.usdcBalance !== null) totalGap += (r.shortfallSelfRescue - r.usdcBalance); }
    else if (r.verdict.startsWith("NO PAYMENT"))      tally.noneNeeded++;
    else tally.unknown++;
  }

  console.log("\n  THE ANSWER TO 34.7 ITEM 2");
  console.log(`    can self-rescue right now      : ${tally.fundedApproved}`);
  console.log(`    hold the money, need approval  : ${tally.approvalOnly}`);
  console.log(`    already covered, no payment    : ${tally.noneNeeded}`);
  console.log(`    CANNOT pay from their wallet   : ${tally.cannotPay}   (total gap ${usd(totalGap)})`);
  console.log(`    unknown (a read failed)        : ${tally.unknown}`);
  console.log("");
  if (tally.unknown > 0) {
    console.log("    ⚠ UNKNOWNs are present. This is not yet a census — resolve them first.");
  } else if (tally.fundedApproved + tally.approvalOnly > tally.cannotPay) {
    console.log("    => Most of these members CAN pay. 34.8's frontend/comms reading holds:");
    console.log("       the dashboard has to tell a parked member the amount and the spender.");
  } else if (tally.cannotPay > 0) {
    console.log("    => Most CANNOT pay. This is economic, and the insolvencyFloorBps dial is");
    console.log("       back on the table as an owner decision.");
  }

  console.log(`\n  PROBLEMS: ${problems.length}`);
  problems.forEach(p => console.log("    " + p));
  if (problems.length) {
    console.log("  ⚠ A run with PROBLEMs measured less than it swept. Do not quote it as complete.");
  }

  // ── CSV — diag_parked_ages.js wrote none and the full 40 were lost to a console ─────
  const outPath = process.env.CSV || path.join(
    __dirname, "..", "logs", `parked_solvency_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  const num = v => v === null || v === undefined ? "" : (Number(v) / 1e6).toFixed(6);
  const head = ["tier","matrix","matrix_addr","member","age_days","in_grace","entry_fee",
                "crossing_reserve","withdrawable_raw","withdrawable_with_accrual",
                "shortfall_selfrescue","shortfall_with_accrual","usdc_balance",
                "allowance_to_matrix","sf_debt","loan_eligible","verdict"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      r.tier, r.matrix, r.matrixAddr, r.member, r.ageDays, r.inGrace,
      num(r.fee), num(r.reserve), num(r.withdrawableRaw), num(r.withdrawableWithAccrual),
      num(r.shortfallSelfRescue), num(r.shortfallWithAccrual), num(r.usdcBalance),
      num(r.allowanceToMatrix), num(r.sfDebt),
      r.loanEligible === null ? "" : r.loanEligible,
      `"${r.verdict}"`,
    ].join(","));
  }
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n") + "\n");
    console.log(`\n  CSV: ${outPath}  (${rows.length} rows)`);
  } catch (e) {
    console.log(`\n  PROBLEM could not write CSV to ${outPath}: ${e.message}`);
    console.log("  The table above is the only copy — 34.7 item 2 lost its member list to a console once already.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
