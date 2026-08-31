// diag_cashout_gate.js — CAN MEMBERS ACTUALLY CASH OUT CNOVA FOR USDC, AND AT WHAT COST?
// READ-ONLY: no signer is constructed, nothing is signed, nothing is sent.
// Built 2026-08-31 (session 53).
//
// WHY THIS EXISTS
// ───────────────
// The owner intends to tell members, in the V8.51 redeploy announcement, to WITHDRAW
// and CASH OUT THEIR CNOVA AS USDC before the switch. That is a public promise about
// a code path, so it gets measured before it is made — this project has been bitten
// four separate times by a figure or a mechanism that was quoted from source and was
// not what the chain actually does (47.7 item 7, the $10 lock, the tierPairManagers
// getter, and diag_headroom_stuck.js's own header).
//
// THE PATH: CNOVATreasury.redeemAtFloor(cnovaAmount)
//   floor    = usdcReserve * 1e18 / cnova.totalSupply()
//   usdcOut  = cnovaAmount * floor / 1e18
//   requires floor > 0, usdcOut > 0, usdcOut <= usdcReserve
//   then applies the V4 EARLY EXIT PENALTY on days since the member's FIRST T1 join:
//     0-30d 45%  |  31-60d 30%  |  61-90d 15%  |  91-120d 5%  |  121d+ 0%
//   and finally cnova.burnFrom(member, amount) — WHICH NEEDS AN ALLOWANCE TO THE
//   TREASURY. A member who has not approved will revert, and that is a UX step the
//   announcement has to spell out.
//
// ⛔ THE TRAP THIS CHECKS FOR EXPLICITLY: `usdcReserve` is an INTERNAL accounting
//    variable, not the contract's token balance — exactly like StabilityFund's
//    `totalBalance`, where CLAUDE.md records that $52,000 sent by direct transfer was
//    permanently unspendable because the internal counter never saw it. So this prints
//    BOTH numbers and flags any drift instead of trusting one.
//
// Run: ADDRESSES_FILE=deployed_addresses_v8_50.json \
//      npx hardhat run scripts/diag_cashout_gate.js --network baseSepolia
// Env: ADDRESSES_FILE (required), MEMBERS (comma-separated; defaults to a sample seen
//      on chain 2026-08-31), AMOUNT_CNOVA (simulate this many CNOVA instead of the
//      member's whole balance).

const path = require("path");
const hre  = require("hardhat");
const { ethers } = hre;

const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || ""));

const TREASURY_ABI = [
  "function floorPrice() view returns (uint256)",
  "function usdcReserve() view returns (uint256)",
  "function usdcValueAtFloor(uint256) view returns (uint256)",
  "function earlyExitPenaltyBps(address) view returns (uint256)",
  "function tier1Matrix() view returns (address)",
  "function isUniverseMode() view returns (bool)",
  "function redeemAtFloor(uint256)",
];
const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
];
const TRACKER_ABI = ["function memberJoinedAt(address) view returns (uint256)"];

const DEFAULT_MEMBERS = [
  "0x6eBf5b507f34C0f516945690c671Fa3f5C1846F0",
  "0x29d883d36253B8DE7b2b06F36C87Ab25d393517c",
  "0xC05d60D6C0326952a268777b0D9e062C1dDb2b83",
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB",
];

const usd  = (v) => `$${(Number(v) / 1e6).toFixed(4)}`;
const cn   = (v) => `${(Number(ethers.formatUnits(v, 18))).toFixed(4)}`;
const line = (n = 100) => console.log("=".repeat(n));

// A failed read prints WHY and never a number. (CLAUDE.md: "never batch unknown
// getters; a failed read prints '?' and its reason, never a number.")
async function rd(label, fn) {
  try { return { ok: true, v: await fn() }; }
  catch (e) { console.log(`  ?  ${label} — READ FAILED: ${(e.shortMessage || e.message || "").slice(0, 90)}`); return { ok: false }; }
}

async function main() {
  if (!process.env.ADDRESSES_FILE) {
    console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
    process.exit(1);
  }
  const p = ethers.provider;
  const treasury = new ethers.Contract(A.treasury, TREASURY_ABI, p);
  const cnova    = new ethers.Contract(A.cnova,    ERC20_ABI,    p);
  const usdc     = new ethers.Contract(A.usdc,     ERC20_ABI,    p);

  line();
  console.log("diag_cashout_gate.js — READ-ONLY. Nothing is signed or sent.");
  console.log("question       : can a member cash CNOVA out for USDC today, and what do they actually receive?");
  console.log("addresses file :", process.env.ADDRESSES_FILE);
  console.log("treasury       :", A.treasury);
  console.log("cnova          :", A.cnova);
  console.log("usdc           :", A.usdc);
  console.log("block          :", await p.getBlockNumber());
  line();

  // ── 1. IS THE FLOOR EVEN ESTABLISHED, AND IS THE RESERVE REAL? ─────────────
  console.log("\n── 1. THE FLOOR AND THE RESERVE ──");
  const floor   = await rd("floorPrice()",  () => treasury.floorPrice());
  const reserve = await rd("usdcReserve()", () => treasury.usdcReserve());
  const held    = await rd("usdc.balanceOf(treasury)", () => usdc.balanceOf(A.treasury));
  const supply  = await rd("cnova.totalSupply()", () => cnova.totalSupply());
  const uni     = await rd("isUniverseMode()", () => treasury.isUniverseMode());
  const t1m     = await rd("tier1Matrix()", () => treasury.tier1Matrix());

  if (floor.ok)   console.log(`  floorPrice            : ${floor.v}  (${usd(floor.v)} per 1 CNOVA)`);
  if (reserve.ok) console.log(`  usdcReserve (internal): ${usd(reserve.v)}   <- THIS is what redeemAtFloor spends against`);
  if (held.ok)    console.log(`  USDC actually held    : ${usd(held.v)}`);
  if (supply.ok)  console.log(`  CNOVA totalSupply     : ${cn(supply.v)}`);
  if (uni.ok)     console.log(`  isUniverseMode        : ${uni.v}`);
  if (t1m.ok)     console.log(`  tier1Matrix (the penalty clock's source) : ${t1m.v}`);

  if (reserve.ok && held.ok) {
    if (held.v > reserve.v) {
      console.log(`  ⛔ DRIFT: the contract HOLDS ${usd(held.v - reserve.v)} MORE than usdcReserve counts.`);
      console.log(`     Same shape as StabilityFund totalBalance vs balanceOf — money sent by direct`);
      console.log(`     transfer is invisible to the spend guard and cannot be redeemed against.`);
    } else if (reserve.v > held.v) {
      console.log(`  ⛔⛔ usdcReserve claims ${usd(reserve.v - held.v)} MORE than the contract holds — redemptions`);
      console.log(`     will pass the guard and then fail on the transfer. Investigate before promising anything.`);
    } else {
      console.log("  ✅ usdcReserve == USDC held — no drift.");
    }
  }
  if (floor.ok && floor.v === 0n) {
    console.log('  ⛔ floorPrice is 0 — every redeemAtFloor reverts "Treasury: floor not established yet".');
  }

  // ── 2. WHAT A MEMBER ACTUALLY RECEIVES ────────────────────────────────────
  console.log("\n── 2. PER-MEMBER: WHAT WOULD THEY ACTUALLY GET? ──");
  const members = (process.env.MEMBERS || DEFAULT_MEMBERS.join(","))
    .split(",").map(s => s.trim()).filter(Boolean);
  const tracker = t1m.ok && t1m.v !== ethers.ZeroAddress
    ? new ethers.Contract(t1m.v, TRACKER_ABI, p) : null;

  console.log("  member       CNOVA        at floor    penalty   net USDC    allowance   simulated redeemAtFloor");
  console.log("  " + "-".repeat(112));
  let anyHolder = false;
  for (const m of members) {
    const bal = await rd(`balanceOf ${m}`, () => cnova.balanceOf(m));
    if (!bal.ok) continue;
    const amount = process.env.AMOUNT_CNOVA
      ? ethers.parseUnits(process.env.AMOUNT_CNOVA, 18) : bal.v;
    if (bal.v > 0n) anyHolder = true;

    const gross = await rd("usdcValueAtFloor", () => treasury.usdcValueAtFloor(amount));
    const pen   = await rd("earlyExitPenaltyBps", () => treasury.earlyExitPenaltyBps(m));
    const allow = await rd("cnova.allowance", () => cnova.allowance(m, A.treasury));
    const net   = (gross.ok && pen.ok) ? gross.v - (gross.v * pen.v) / 10_000n : null;

    // The honest test: simulate the real call AS the member. A revert reason here is
    // the answer, not an error — it is exactly what the member would see.
    let sim = "skipped (zero balance)";
    if (amount > 0n) {
      try {
        await treasury.redeemAtFloor.staticCall(amount, { from: m });
        sim = "✅ WOULD SUCCEED";
      } catch (e) {
        sim = "⛔ " + (e.shortMessage || e.reason || e.message || "reverted").slice(0, 60);
      }
    }
    console.log(
      `  ${m.slice(0, 10)}  ${bal.ok ? cn(bal.v).padStart(10) : "?".padStart(10)}` +
      `  ${gross.ok ? usd(gross.v).padStart(10) : "?".padStart(10)}` +
      `  ${pen.ok ? (Number(pen.v) / 100).toFixed(0).padStart(5) + "%" : "    ?"}` +
      `  ${net !== null ? usd(net).padStart(10) : "?".padStart(10)}` +
      `  ${allow.ok ? (allow.v > 0n ? "     yes" : "      no") : "       ?"}` +
      `   ${sim}`
    );
    if (tracker) {
      const j = await rd("memberJoinedAt", () => tracker.memberJoinedAt(m));
      if (j.ok) {
        const days = j.v === 0n ? null
          : Math.floor((Math.floor(Date.now() / 1000) - Number(j.v)) / 86400);
        console.log(`              joinedAt ${j.v === 0n ? "0 (NOT RECORDED — penalty returns 0)" : `${new Date(Number(j.v) * 1000).toISOString().slice(0, 10)}, ${days} days ago`}`);
      }
    }
  }
  if (!anyHolder) {
    console.log("\n  ⚠ NONE of the sampled wallets hold CNOVA, so the per-member section proves nothing.");
    console.log("    Pass real holders: MEMBERS=0x..,0x.. — a vacuous pass is not a pass (51.4).");
  }

  // ── 3. THE VERDICT, STATED AS A PROMISE WE COULD OR COULD NOT MAKE ────────
  console.log("\n── 3. CAN THE ANNOUNCEMENT SAY 'CASH OUT YOUR CNOVA'? ──");
  if (!floor.ok || !reserve.ok) {
    console.log("  UNDECIDABLE — a required read failed above. Do not write the line until this runs clean.");
  } else if (floor.v === 0n || reserve.v === 0n) {
    console.log("  ⛔ NO. The floor or the reserve is zero, so redeemAtFloor cannot pay anybody.");
  } else {
    console.log("  Mechanically available. TWO THINGS THE ANNOUNCEMENT MUST STILL SAY:");
    console.log("   1. the member must APPROVE CNOVA to the treasury first, or the burn reverts;");
    console.log("   2. the EARLY EXIT PENALTY above is deducted — quote the real percentage, never the gross.");
    console.log(`  Whole-supply check: redeeming every CNOVA in existence would ask ${supply.ok && floor.ok ? usd((supply.v * floor.v) / (10n ** 18n)) : "?"}`);
    console.log(`  against a reserve of ${usd(reserve.v)} — if that is short, it is FIRST COME FIRST SERVED and`);
    console.log("  the announcement must not imply everyone can exit at the quoted floor.");
  }
  line();
}

main().catch((e) => { console.error(e); process.exit(1); });
