// diag_eviction_clock.js — WHEN CAN THE FIRST MEMBER ACTUALLY BE EVICTED, AND WHO?
//
// Built 2026-08-19 (session 9). Owner question: "we can see how much more time it needs
// for them to be evicted — if too much we don't test."
//
// ── WHY THE ANSWER IS NOT JUST A CLOCK ────────────────────────────────────────────────
// Eviction needs TWO things to be true at once, and only one of them is a timer:
//   1. THE CLOCK — MatrixKeeper:1071 returns early while
//      `block.timestamp - parkedAt(member) < evictionGracePeriod` (7 days as shipped,
//      DAO param 62, READ here rather than assumed).
//   2. A REASON — MatrixKeeperLib._triageParked must return non-NONE: EVICT_FLOOR (the
//      insolvency floor refuses the loan), EVICT_LADDER (off the bottom of the SF rescue
//      ladder), EVICT_RATIO (withdrawRatio over rescueRatioBps) or EVICT_GHOST (already
//      seated — a dequeue, not an eviction).
// A member whose clock has run out but who is RESCUABLE is rescued, not evicted. So the
// answer to "when is the first eviction" is the earliest member who is BOTH out of time
// AND unrescuable — not simply the oldest parked member.
//
// ⚠ AND THE THING THAT HAS BEEN HIDING IT: BIGFILL SELF-RESCUES AT 100%. With
// SELF_RESCUE_RATE=1.0 every funded parked wallet is rescued long before its clock
// expires, which is exactly why `MemberEvicted addresses found: 0` on a chain that has
// been live 6+ days. **Eviction has never fired here because nothing has been allowed to
// sit unrescued**, not because the code is broken. To test eviction on purpose you must
// leave a cohort parked AND unfunded AND excluded from the sweep — see the footer.
//
// ⛔ THIS DOES NOT RE-IMPLEMENT _triageParked. Its reason is an internal uint8, never
// emitted. This reads only exact public views — loanHeadroom vs the member's own gap — and
// reports "a loan cannot cover this" as a statement about two numbers, not as a prediction
// of the keeper's branch. Same rule the dashboard badge follows.
//
// Read-only. No wallet, no writes.
//
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_eviction_clock.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) { console.error("\n  ADDRESSES_FILE is not set, and this script will not guess.\n"); process.exit(1); }
const A = require(path.join(__dirname, ADDRFILE));

const TR_ABI  = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI  = ["function pairCount() view returns (uint256)", "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function getMember(address) view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))",
];
// ⛔ THE ECLIPSE CLOCK HAS TWO NAMES AND THE LIVE CHAIN USES THE OLDER ONE.
// `evictionGracePeriod` was introduced in V8.49 item 1 (commit b14eba7). LIVE IS V8.48,
// which exposes `extendedIdleTimeout` (604_800 = the same 7 days). Calling the V8.49 name
// against the V8.48 deployment returns "missing revert data" — a call to a function that
// does not exist, which reads exactly like a network failure and is not one. Same defect
// class as `activateLayer` (declared in an interface, implemented nowhere, survived from
// V8.1 to 2026-08). ASK FOR BOTH AND REPORT WHICH ONE ANSWERED.
const KEEPER_ABI = [
  "function evictionGracePeriod() view returns (uint256)",   // V8.49+
  "function extendedIdleTimeout() view returns (uint256)",   // V8.48 and earlier
];
// ⛔ V8.49 NAMES DO NOT EXIST ON THE LIVE V8.48 DEPLOYMENT. Probed 2026-08-19 against
// 0xeb36ee74… (14,863 bytes) with a full address:
//     insolvencyFloorBps()          3400        EXISTS
//     memberDebt(address)              0        EXISTS
//     tierEntryFees(uint256)      $10.00        EXISTS
//     loanEligible(address,uint8)   true        EXISTS
//     loanHeadroom(address,uint8)      —        MISSING  (V8.49 item 1b, commit 40d7843)
//     loanEligibleFor(...)             —        MISSING  (same commit)
// So ask for loanHeadroom first (it is exact where it exists) and DERIVE it otherwise from
// the three views that do: ceiling = tierEntryFees * insolvencyFloorBps / 10000, minus
// memberDebt. Live T1 ceiling today = $10.00 x 3400/10000 = $3.40.
const SF_ABI = [
  "function loanHeadroom(address,uint8) view returns (uint256)",   // V8.49+ only
  "function loanEligible(address,uint8) view returns (bool)",
  "function insolvencyFloorBps() view returns (uint256)",
  "function memberDebt(address) view returns (uint256)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function totalBalance() view returns (uint256)",
];

const usd  = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const pad  = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);
const hrs  = (s) => (Number(s) / 3600).toFixed(1);

(async () => {
  if (!RPC) { console.log("FATAL: no RPC"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });

  let grace, sfBal, graceSource = "";
  try {
    const k = new ethers.Contract(A.matrixKeeper, KEEPER_ABI, p);
    try { grace = BigInt(await k.evictionGracePeriod()); graceSource = "evictionGracePeriod (V8.49+)"; }
    catch { grace = BigInt(await k.extendedIdleTimeout()); graceSource = "extendedIdleTimeout (V8.48 — the V8.49 name does not exist on this deployment)"; }
    sfBal = BigInt(await new ethers.Contract(A.stabilityFund, SF_ABI, p).totalBalance());
  } catch (e) {
    console.error("\n  REFUSING TO RUN: state read failed — " + (e.shortMessage || e.message || "").slice(0, 90));
    console.error("  Base Sepolia was flapping on 2026-08-19; use watch_base_sepolia.mjs first.\n");
    process.exit(1);
  }
  const now = BigInt((await p.getBlock("latest")).timestamp);   // CHAIN time, not wall clock
  const sf  = new ethers.Contract(A.stabilityFund, SF_ABI, p);

  console.log("");
  console.log("EVICTION CLOCK — " + new Date(Number(now) * 1000).toISOString() + "  (chain time)");
  console.log(`  addresses: ${ADDRFILE}`);
  console.log(`  eviction window: ${grace} s = ${Number(grace) / 86400} days   <- read from ${graceSource}`);
  console.log(`  StabilityFund balance: ${usd(sfBal)}`);
  console.log("=".repeat(104));

  const [pms] = await new ethers.Contract(A.tierRouter, TR_ABI, p).getAllTiers();
  const rows = [];
  let headroomDerived = 0, headroomBound = 0;
  for (let t = 0; t < pms.length; t++) {
    if (!pms[t] || pms[t] === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pms[t], PM_ABI, p);
    let n = 0; try { n = Number(await pm.pairCount()); } catch { continue; }
    for (let i = 0; i < n; i++) {
      let a, b; try { [a, b] = await pm.getPairAt(i); } catch { continue; }
      for (const [half, addr] of [["MatA", a], ["MatB", b]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const m = new ethers.Contract(addr, MAT_ABI, p);
        let cnt = 0; try { cnt = Number(await m.getParkedCount()); } catch { continue; }
        if (!cnt) continue;
        let fee = 0n; try { fee = BigInt(await m.ENTRY_FEE()); } catch {}
        for (let k = 0; k < cnt; k++) {
          let who; try { who = await m.getParkedMember(k); } catch { continue; }   // tail races are known here
          if (!who || who === ethers.ZeroAddress) continue;
          let pa = 0n, res = 0n, wd = 0n, headroom = null;
          try { pa  = BigInt(await m.parkedAt(who)); } catch { continue; }
          try { res = BigInt(await m.crossingReserveOf(who)); } catch {}
          try { wd  = BigInt((await m.getMember(who)).withdrawable); } catch {}
          try { headroom = BigInt(await sf.loanHeadroom(who, t)); }
          catch {
            // ── V8.48 fallback, REBUILT 2026-08-19 ────────────────────────────────────
            // v1 used Promise.all over three views, so ONE missing view made all three
            // look broken and 107 of 107 members came back unknown — the same
            // all-or-nothing blindness that has cost this session all day. Read them
            // SEPARATELY and use the strongest bound each row can actually support.
            //
            // ⛔ THE KEY INSIGHT: memberDebt is NOT REQUIRED to answer the question.
            //    headroom = ceiling - debt, and debt >= 0, so CEILING IS AN UPPER BOUND ON
            //    HEADROOM no matter what the debt is. If a member's gap exceeds the
            //    ceiling, no loan can ever cover them — that conclusion is SOUND even with
            //    the debt unknown. Only the converse ("they are fine") needs the real debt,
            //    and rows without it are marked so nobody reads them as safe.
            //    Live V8.48 measured: insolvencyFloorBps 3400, tierEntryFees(0) $10.00,
            //    so the T1 ceiling is $3.40 — every parked gap above that is uncoverable.
            let ceiling = null;
            try {
              const bps  = BigInt(await sf.insolvencyFloorBps());
              const tfee = BigInt(await sf.tierEntryFees(t));
              ceiling = (tfee * bps) / 10_000n;
            } catch { ceiling = null; }
            if (ceiling !== null) {
              let owed = null;
              try { owed = BigInt(await sf.memberDebt(who)); } catch { owed = null; }
              if (owed !== null) { headroom = ceiling > owed ? ceiling - owed : 0n; headroomDerived++; }
              else { headroom = ceiling; headroomBound++; }   // UPPER BOUND — debt unreadable
            } else { headroom = null; }
          }
          const have = res + wd;
          const gap  = fee > have ? fee - have : 0n;
          const left = (pa + grace) - now;
          rows.push({ tier: t + 1, pair: i + 1, half, who, parkedAt: pa, left, gap, headroom });
        }
      }
    }
  }

  if (!rows.length) { console.log("\n  No parked members found. Nothing on any clock.\n"); return; }
  rows.sort((x, y) => (x.left < y.left ? -1 : 1));

  // A member is only an eviction CANDIDATE if a loan cannot cover their gap. Anyone else
  // gets rescued when their turn comes and never reaches the valve.
  const cannotBeCovered = (r) => r.gap > 0n && r.headroom !== null && r.headroom < r.gap;
  const unknown = rows.filter((r) => r.gap > 0n && r.headroom === null).length;

  console.log("\nSOONEST 15 BY CLOCK");
  // FULL addresses, not abbreviated: the first version printed 12-char stubs and the very
  // next step was to paste one into probe_sf_views.js, where a truncated address silently
  // became an ENS lookup. Print what you expect to be used.
  console.log("  " + padr("member", 44) + padr("where", 14) + pad("hrs left", 10) + pad("gap", 11) + pad("fund can lend", 15) + "  loan covers gap?");
  console.log("  " + "-".repeat(126));
  for (const r of rows.slice(0, 15)) {
    const cov = r.gap === 0n ? "no gap - rescuable"
      : r.headroom === null ? "UNKNOWN (read failed)"
      : r.headroom >= r.gap ? "yes - will be rescued"
      : "NO  <-- eviction candidate";
    console.log("  " + padr(r.who, 44) + padr(`T${r.tier}.${r.pair} ${r.half}`, 14) +
      pad(r.left <= 0n ? "PASSED" : hrs(r.left), 10) + pad(usd(r.gap), 11) +
      pad(r.headroom === null ? "?" : usd(r.headroom), 15) + "  " + cov);
  }

  const cands = rows.filter(cannotBeCovered);
  const soonestAny  = rows[0];
  const soonestCand = cands.length ? cands.reduce((m, r) => (r.left < m.left ? r : m)) : null;

  console.log("\n" + "=".repeat(104));
  console.log(`  parked members scanned      : ${rows.length}`);
  if (headroomDerived) console.log(`  headroom DERIVED exactly (ceiling - memberDebt): ${headroomDerived}`);
  if (headroomBound) console.log(`  headroom as UPPER BOUND (memberDebt unreadable — ceiling only): ${headroomBound}`);
  if (headroomBound) console.log(`     -> "cannot be covered" is still SOUND on those rows; "can be covered" is NOT.`);
  console.log(`  with a gap a loan CANNOT cover: ${cands.length}${unknown ? `   (+${unknown} unknown — reads failed, NOT counted either way)` : ""}`);
  console.log(`  soonest clock of ANY parked member : ${soonestAny.left <= 0n ? "already passed" : hrs(soonestAny.left) + " h (" + (Number(soonestAny.left) / 86400).toFixed(2) + " days)"}`);
  if (soonestCand) {
    const d = Number(soonestCand.left) / 86400;
    console.log(`  ⛔ SOONEST REAL EVICTION           : ${soonestCand.left <= 0n ? "ALREADY DUE" : hrs(soonestCand.left) + " h (" + d.toFixed(2) + " days)"}  — ${soonestCand.who.slice(0, 12)} in T${soonestCand.tier}.${soonestCand.pair} ${soonestCand.half}`);
    console.log(`     that member is short ${usd(soonestCand.gap)} and the fund may lend at most ${usd(soonestCand.headroom)}`);
  } else if (unknown > 0 && unknown >= rows.filter((r) => r.gap > 0n).length / 2) {
    // ⛔ NO VERDICT. The first version printed "NO EVICTION CANDIDATES AT ALL" while 105 of
    // 107 headroom reads had failed — zero candidates because nothing could be READ, not
    // because none exist. An instrument must never report the absence of what it could not
    // observe; that error has cost this session six times in one day, and this is where it
    // gets stopped.
    console.log(`  ⛔ NO VERDICT — ${unknown} of ${rows.filter((r) => r.gap > 0n).length} members with a gap could not be checked.`);
    console.log("     Zero candidates here means zero READINGS, not zero risk. Fix the reads first:");
    console.log("     on live V8.48 loanHeadroom does not exist, so if the derived fallback ALSO failed,");
    console.log("     check insolvencyFloorBps / tierEntryFees / memberDebt individually.");
  } else {
    console.log("  ⛔ NO EVICTION CANDIDATES — every parked member with a gap THAT COULD BE CHECKED");
    console.log("     can be covered by a loan, so the clock never matters for them.");
    if (unknown) console.log(`     ⚠ ${unknown} member(s) could not be checked and are excluded from that statement.`);
  }

  console.log("");
  console.log("  DECIDING WHETHER TO TEST EVICTION (owner question 2026-08-19):");
  console.log("   · The number that matters is SOONEST REAL EVICTION, not the soonest clock.");
  console.log("   · If that is days away and a V8.50 deploy lands first, the chain resets and the");
  console.log("     test never happens. Do not wait for it by accident — decide deliberately.");
  console.log("   · TO FORCE IT INSTEAD: eviction has never fired here because bigfill self-rescues");
  console.log("     at 100%, so nothing is ever left parked long enough. A real test needs a small");
  console.log("     cohort that is parked, UNFUNDED, and EXCLUDED from the self-rescue sweep, then");
  console.log("     left alone for the grace period. Shortening evictionGracePeriod (DAO param 62)");
  console.log("     is the other lever and is far faster — but it is a LIVE config change on the");
  console.log("     community chain and would move the deadline for every real member too, so it");
  console.log("     is an owner decision, not a test convenience.");
  console.log("");
})().catch((e) => { console.error("FAILED: " + (e.stack || e.message || e)); process.exit(1); });
