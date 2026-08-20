// diag_badge_preview.js - WHAT WOULD THE PARKED-MEMBER BADGE ACTUALLY SAY ON THE LIVE CHAIN?
//
// Built 2026-08-19 (session 10). The badge in index.html renderParkedList() had never been
// run against a live chain. It calls views that do not exist on V8.48 and falls back, and the
// fallback was written but unproven - "unproven" being the whole reason this file exists.
//
// THIS IS NOT A SECOND MODEL OF THE BADGE. It is the badge's OWN read path, transcribed
// once, so that what it renders can be observed without a browser and without a wallet.
// StabilityFund.sol:938 warns by name about three copies of one formula drifting; if this
// script and index.html ever disagree, ONE OF THEM IS WRONG AND THE DISAGREEMENT IS THE
// FINDING - do not average them, go and find out which.
//
// -- WHAT IT CHECKS ------------------------------------------------------------------------
//   1. The V8.48 headroom derivation, including loanHeadroom's TWO "unlimited" branches
//      (insolvencyFloorBps == 0, tierEntryFees[t] == 0) which the shipped fallback omitted
//      until 2026-08-19. Omitting them inverts the verdict: fee * 0 / 10000 is a ceiling of
//      zero, so every parked row reads PENDING EVICTION at the exact moment the floor is
//      DISABLED and nobody can be refused.
//   2. The eviction clock fallback, gated so it substitutes extendedIdleTimeout for
//      evictionGracePeriod only when the chain says the latter is ABSENT - never when a read
//      merely FAILED. MatrixKeeper.sol:1066: "Do NOT re-point this at extendedIdleTimeout to
//      keep them in step."
//   3. HOW MANY MEMBERS WOULD SEE THE BADGE AT ALL. renderParkedList returns early when a
//      member holds fewer than 2 parked positions, so a member with exactly one parked
//      position never sees any of this. Nobody has measured that share. A feature that
//      reaches 3 of 111 people is a different decision from one that reaches 90.
//
// -- HOW IT REFUSES TO LIE -----------------------------------------------------------------
//   - A failed read is UNKNOWN, never "fine". Zero is a legitimate headroom, so a failed
//     read rendered as 0 would tell a healthy member they are about to be evicted.
//   - Where memberDebt cannot be read, the ceiling is still an UPPER BOUND on headroom
//     (headroom = ceiling - debt, debt >= 0). "Cannot be covered" stays sound on those rows;
//     "can be covered" does not, and is reported as CHECKING rather than as good news.
//   - It prints its own cross-check against diag_eviction_clock.js's "cannot cover" count.
//     Two instruments over one population that disagree mean one is broken.
//
// Read-only. No wallet, no keys, nothing written to any chain. ASCII output only.
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_badge_preview.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) { console.error("\n  ADDRESSES_FILE is not set, and this script will not guess.\n"); process.exit(1); }
const A = require(path.join(__dirname, ADDRFILE));

const TR_ABI = ["function getAllTiers() view returns (address[10], uint256[10])"];
const PM_ABI = ["function pairCount() view returns (uint256)", "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
  "function getMember(address) view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))",
];
const KEEPER_ABI = [
  "function evictionGracePeriod() view returns (uint256)",   // V8.49+
  "function extendedIdleTimeout() view returns (uint256)",   // V8.48 and earlier
];
const SF_ABI = [
  "function loanHeadroom(address,uint8) view returns (uint256)",   // V8.49+ only
  "function insolvencyFloorBps() view returns (uint256)",
  "function memberDebt(address) view returns (uint256)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function totalBalance() view returns (uint256)",
];

const UNLIMITED = Symbol("unlimited");
const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const padr = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

// Same classifier as index.html and probe_keeper_views.js. "Not on this build" and "the read
// failed" are different answers and must never be merged.
function isAbsent(e) {
  const code = e && e.code ? String(e.code) : "";
  const msg = (e && (e.shortMessage || e.message)) || "";
  if (code === "BAD_DATA") return true;
  if (code === "CALL_EXCEPTION" && (e.data === null || e.data === undefined || e.data === "0x")) return true;
  return /could not decode result data|missing revert data/i.test(msg);
}

(async () => {
  if (!RPC) { console.log("FATAL: no RPC"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);

  // ---- the two chain-wide reads the badge makes once -------------------------------------
  let grace = null, graceSource = "", sfBal = null;
  try {
    const k = new ethers.Contract(A.matrixKeeper, KEEPER_ABI, p);
    try { grace = BigInt(await k.evictionGracePeriod()); graceSource = "evictionGracePeriod (V8.49+)"; }
    catch (e1) {
      if (isAbsent(e1)) {
        try { grace = BigInt(await k.extendedIdleTimeout()); graceSource = "extendedIdleTimeout (V8.48 - the V8.49 name is ABSENT on this build)"; }
        catch (_) { grace = null; graceSource = "NEITHER clock could be read"; }
      } else {
        grace = null; graceSource = "evictionGracePeriod read FAILED (not absent) - refusing to substitute";
      }
    }
  } catch (_) { grace = null; graceSource = "keeper unreachable"; }
  try { sfBal = BigInt(await sf.totalBalance()); } catch (_) { sfBal = null; }

  const now = BigInt((await p.getBlock("latest")).timestamp);   // CHAIN time, not wall clock

  console.log("");
  console.log("PARKED-BADGE PREVIEW - " + new Date(Number(now) * 1000).toISOString() + " (chain time)");
  console.log("  addresses    : " + ADDRFILE);
  console.log("  eviction clock: " + (grace === null ? "UNKNOWN" : grace + " s = " + (Number(grace) / 86400) + " d") + "   <- " + graceSource);
  console.log("  SF balance   : " + (sfBal === null ? "UNKNOWN" : usd(sfBal)));
  console.log("=".repeat(104));

  // ---- enumerate every parked position ---------------------------------------------------
  const [pms] = await new ethers.Contract(A.tierRouter, TR_ABI, p).getAllTiers();
  const rows = [];
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
          let who; try { who = await m.getParkedMember(k); } catch { continue; }
          if (!who || who === ethers.ZeroAddress) continue;
          let pa = 0n, res = 0n, wd = 0n;
          try { pa = BigInt(await m.parkedAt(who)); } catch { continue; }
          try { res = BigInt(await m.crossingReserveOf(who)); } catch {}
          try { wd = BigInt((await m.getMember(who)).withdrawable); } catch {}
          const have = res + wd;
          const gap = fee > have ? fee - have : 0n;
          rows.push({ tier: t + 1, pair: i + 1, half, who, parkedAt: pa, gap });
        }
      }
    }
  }

  if (!rows.length) { console.log("\n  No parked members found anywhere. Nothing to preview.\n"); return; }

  // ---- headroom, once per (member,tier) - the badge reads per position but the answer only
  //      depends on the member and the tier, so cache it and save a few hundred calls.
  const cache = new Map();
  async function headroomFor(who, tierIdx) {
    const key = who + ":" + tierIdx;
    if (cache.has(key)) return cache.get(key);
    let out;
    try {
      out = BigInt(await sf.loanHeadroom(who, tierIdx));   // exact where it exists
    } catch (_) {
      // V8.48 derivation - loanHeadroom's WHOLE definition, reads taken SEPARATELY so one
      // missing view cannot take the other two down with it.
      let bps = null, tfee = null, owed = null;
      try { bps = BigInt(await sf.insolvencyFloorBps()); } catch (_) {}
      if (bps === 0n) { cache.set(key, UNLIMITED); return UNLIMITED; }
      try { tfee = BigInt(await sf.tierEntryFees(tierIdx)); } catch (_) {}
      if (tfee === 0n) { cache.set(key, UNLIMITED); return UNLIMITED; }
      if (bps === null || tfee === null) { cache.set(key, null); return null; }
      const ceiling = (tfee * bps) / 10000n;
      try { owed = BigInt(await sf.memberDebt(who)); } catch (_) {}
      out = owed === null ? { bound: ceiling } : (ceiling > owed ? ceiling - owed : 0n);
    }
    cache.set(key, out);
    return out;
  }

  // ---- the badge's own verdict function --------------------------------------------------
  function badgeFor(gap, headroom) {
    if (gap === 0n) return "no gap";                       // badge renders nothing on this row
    if (headroom === null) return "CHECKING";
    if (headroom === UNLIMITED) {
      return (sfBal !== null && sfBal < gap) ? "WAITING ON FUND" : "IN RESCUE QUEUE";
    }
    if (typeof headroom === "object" && headroom !== null && "bound" in headroom) {
      return headroom.bound < gap ? "PENDING EVICTION" : "CHECKING";
    }
    if (headroom < gap) return "PENDING EVICTION";
    if (sfBal !== null && sfBal < gap) return "WAITING ON FUND";
    return "IN RESCUE QUEUE";
  }

  for (const r of rows) {
    r.headroom = await headroomFor(r.who, r.tier - 1);
    r.badge = badgeFor(r.gap, r.headroom);
    r.hoursLeft = grace === null ? null : Number((r.parkedAt + grace) - now) / 3600;
  }

  // ---- WHO WOULD ACTUALLY SEE THIS -------------------------------------------------------
  // renderParkedList: `if (cands.length < 2) { box.style.display='none'; return; }`
  const byMember = new Map();
  for (const r of rows) {
    if (!byMember.has(r.who)) byMember.set(r.who, []);
    byMember.get(r.who).push(r);
  }
  const seers = [...byMember.entries()].filter(([, v]) => v.length >= 2);
  const oneOnly = [...byMember.entries()].filter(([, v]) => v.length === 1);

  // ---- results ---------------------------------------------------------------------------
  const dist = {};
  for (const r of rows) dist[r.badge] = (dist[r.badge] || 0) + 1;

  console.log("\nBADGE THAT EACH PARKED POSITION WOULD RENDER");
  console.log("  " + padr("badge", 20) + padl("positions", 11) + "   share of positions with a gap");
  console.log("  " + "-".repeat(72));
  const withGap = rows.filter((r) => r.gap > 0n).length;
  for (const [b, c] of Object.entries(dist).sort((x, y) => y[1] - x[1])) {
    const share = b === "no gap" ? "-" : ((c / Math.max(1, withGap)) * 100).toFixed(1) + "%";
    console.log("  " + padr(b, 20) + padl(c, 11) + "   " + share);
  }

  console.log("\nSOONEST 12 BY CLOCK (full addresses - a truncated one becomes an ENS lookup)");
  const sorted = rows.filter((r) => r.gap > 0n).sort((a, b2) => (a.hoursLeft ?? 1e9) - (b2.hoursLeft ?? 1e9));
  console.log("  " + padr("member", 44) + padr("where", 13) + padl("hrs left", 10) + padl("gap", 10) + padl("can lend", 11) + "  badge");
  console.log("  " + "-".repeat(120));
  for (const r of sorted.slice(0, 12)) {
    const hr = r.headroom === null ? "?"
      : r.headroom === UNLIMITED ? "unlimited"
      : (typeof r.headroom === "object" ? "<=" + usd(r.headroom.bound) : usd(r.headroom));
    console.log("  " + padr(r.who, 44) + padr("T" + r.tier + "." + r.pair + " " + r.half, 13) +
      padl(r.hoursLeft === null ? "?" : (r.hoursLeft <= 0 ? "PASSED" : r.hoursLeft.toFixed(1)), 10) +
      padl(usd(r.gap), 10) + padl(hr, 11) + "  " + r.badge);
  }

  console.log("\n" + "=".repeat(104));
  console.log("  parked POSITIONS scanned         : " + rows.length);
  console.log("  distinct parked MEMBERS          : " + byMember.size);
  console.log("  positions with a funding gap     : " + withGap);
  console.log("");
  console.log("  ** WHO ACTUALLY SEES THE BADGE **");
  console.log("  members holding 2+ parked positions (badge RENDERS) : " + seers.length);
  console.log("  members holding exactly 1        (badge HIDDEN)     : " + oneOnly.length);
  if (byMember.size) {
    console.log("  -> the feature is visible to " + ((seers.length / byMember.size) * 100).toFixed(1) + "% of parked members.");
  }
  if (seers.length === 0) {
    console.log("  ** NOBODY ON THIS CHAIN WOULD SEE IT AT ALL. The `cands.length < 2` early return in");
    console.log("     renderParkedList hides it for every single parked member. That is a product");
    console.log("     decision to take deliberately, not a bug to fix quietly - the single-position");
    console.log("     card is supposed to cover those members. Check that it says something.");
  }

  const cannotCover = rows.filter((r) =>
    r.gap > 0n && r.headroom !== null && r.headroom !== UNLIMITED &&
    (typeof r.headroom === "object" ? r.headroom.bound < r.gap : r.headroom < r.gap)).length;
  const unknown = rows.filter((r) => r.gap > 0n && r.headroom === null).length;

  console.log("");
  console.log("  CROSS-CHECK AGAINST diag_eviction_clock.js");
  console.log("  positions a loan CANNOT cover    : " + cannotCover + (unknown ? "   (+" + unknown + " unreadable, counted neither way)" : ""));
  console.log("  Run `node scripts\\diag_eviction_clock.js` and compare. It counts the SAME thing");
  console.log("  over the SAME population by the same rule. If the two numbers differ, one of these");
  console.log("  instruments is broken - that disagreement is the finding, do not average them.");
  console.log("");
})().catch((e) => { console.error("FAILED: " + (e.stack || e.message || e)); process.exit(1); });
