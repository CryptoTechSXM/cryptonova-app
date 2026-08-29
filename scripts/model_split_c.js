"use strict";
/**
 * model_split_c.js — EXPLORING 11.4 LEVER C, WITHOUT WRITING ANY CONTRACT CODE.
 * Written 2026-08-30, session 50. READ-ONLY: no RPC, no signing, no chain access at all.
 *
 * ⛔⛔ THIS IS AN EXPLORATION, NOT AN APPROVED CHANGE.
 * [stated] OWNER DECIDED 2026-08-30: "i would stick to A, while just explore C to see what
 * the outcome could be." A (accept the gap) is the standing policy. Nothing here authorises
 * a split change, and a future session must not read this file as permission.
 *
 * ⛔ WHY A MODEL AND NOT A FIXTURE SWEEP FIRST. The fixture costs 11 minutes per split
 * table at MATRIX_SIZE 127. The arithmetic is already MEASURED-EXACT: handoff 11.4
 * predicted $5.536 per cycle from the split table and the census measured $5.5916, and
 * predicted a $4.464 gap against a measured $4.4084. So the closed form tracks the system
 * to ~6 cents and can screen many candidates instantly. ⚠ THE MODEL SCREENS; THE FIXTURE
 * DECIDES. Run V8_50_ReferralBreakeven against any candidate before believing it.
 *
 * ⛔ THE CONSERVATION ARGUMENT BOUNDS EVERY ROW BELOW (11.4, and it is arithmetic, not a
 * finding to re-derive): one A+B cycle distributes EXACTLY 100% of the entry fee. So a
 * zero-referral member reaches 100% only if BOTH leaks — the system take AND the orphaned
 * L1 — go to zero. So long as the protocol takes any fee at all, NO split table makes a
 * member who never recruits self-funding. C can shrink the gap. It cannot close it.
 */

const BPS = 10000;
const MATRIX_SIZE = Number(process.env.CYCLE_SIZE || 127);   // pool is split across seats 2..N
const FEE = 10.0;                        // T1 entry fee, USD
const usd = (bps) => "$" + ((bps / BPS) * FEE).toFixed(4);

// ── THE MEASURED BASELINE, per FULL A+B CYCLE (both halves), from handoff 11.4 ─────────
// Per-half SPLITS in the fixtures are half of these (l1Bps 950 -> 1900 per cycle, etc).
const BASE = {
  pool:     3136,   // seats 2..N            -> members
  chain:    1900,   // 6 chain-pay levels     -> members
  direct:    500,   // the entrant's own carve-> the entrant themselves
  l1:       1900,   // the referrer — OR ORPHANED (12.2: 20% accountOne, 40% CW/SF, 40% dev)
  treasury: 1426, sf: 476, dev: 286, ops: 190, community: 96, buyback: 90,   // system take
};
const SYSTEM_KEYS = ["treasury", "sf", "dev", "ops", "community", "buyback"];

const systemTake = (s) => SYSTEM_KEYS.reduce((n, k) => n + s[k], 0);
const total      = (s) => Object.values(s).reduce((n, v) => n + v, 0);

/** What a member with ZERO referrals collects per cycle: pool + chain + their own direct.
 *  Their L1 is orphaned and 12.2 measured that NONE of it returns to the member side. */
const zeroRefTake = (s) => s.pool + s.chain + s.direct + (s.orphanToMember || 0);

/** ⚠ ARITHMETIC ESTIMATE, and 11.4 flags it as an UNDER-estimate of the member's position:
 *  it excludes chain pay from a growing downline, which pushes the true bar LOWER. The
 *  size-127 sweep measured the step between R=2 and R=3 against this predicting 2.35. */
const breakEven = (s) => (BPS - zeroRefTake(s)) / (s.l1 || 1);

// ⛔ SELF-CHECK FIRST. If the closed form does not reproduce the census, every row below is
// void and this script must say so rather than print a table.
const CENSUS_TAKE = 5.5916, CENSUS_GAP = 4.4084, TOL = 0.10;
const baseTake = (zeroRefTake(BASE) / BPS) * FEE;
const baseGap  = FEE - baseTake;
console.log("=".repeat(100));
console.log("  MODEL SELF-CHECK against the size-127 census (handoff 11.4)");
console.log("=".repeat(100));
console.log(`  zero-referral take   model ${usd(zeroRefTake(BASE))}   census $${CENSUS_TAKE.toFixed(4)}   delta $${Math.abs(baseTake - CENSUS_TAKE).toFixed(4)}`);
console.log(`  shortfall            model ${usd(BPS - zeroRefTake(BASE))}   census $${CENSUS_GAP.toFixed(4)}   delta $${Math.abs(baseGap - CENSUS_GAP).toFixed(4)}`);
if (Math.abs(baseTake - CENSUS_TAKE) > TOL || total(BASE) !== BPS) {
  console.log(`\n  *** SELF-CHECK FAILED (total ${total(BASE)} bps). The model does not reproduce the`);
  console.log(`      measured system. NO SCENARIO BELOW IS QUOTABLE. Fix the baseline first. ***`);
  process.exit(1);
}
console.log(`  ✅ closed form tracks the census to the cent. Total ${total(BASE)} bps. Screening is valid.\n`);

// ── SCENARIOS. Each must still total 10000 bps — money is moved, never created. ────────
const S = (name, note, mut) => {
  const s = { ...BASE, orphanToMember: 0 };
  mut(s);
  return { name, note, s };
};
const scenarios = [
  S("A — baseline (SHIPPING)", "no change. The standing decision.", () => {}),

  S("C1 — orphaned L1 to the member",
    "12.2: takes 80% from the community + dev wallets, 20% from accountOne. Owner call.",
    (s) => { s.orphanToMember = s.l1; }),

  // ⛔ MY FIRST DRAFT OF C2 DID `s.pool += s.l1` AND LEFT `l1` STANDING, which counts the
  // same 1900 bps twice. The sum guard rejected it as "BPS DO NOT SUM — SCENARIO VOID"
  // rather than printing a flattering row, which is the guard doing its job. The honest
  // model is: the orphan's 1900 goes to the POOL, and the orphan then receives only their
  // OWN SHARE of it — pool is split across seats 2..N, so that is 1900/(N-1) bps.
  S("C2 — orphaned L1 to the pool",
    "same money, but spread across seats 2..N — so the orphan gets back only 1/(N-1) of it.",
    (s) => { s.orphanToMember = Math.round(s.l1 / (MATRIX_SIZE - 1)); s.poolTopUp = s.l1; }),

  S("C3 — halve the treasury share into pool",
    "treasury 1426 -> 713. Touches the system take, i.e. the project's own income.",
    (s) => { const m = 713; s.treasury -= m; s.pool += m; }),

  S("C4 — C1 + halve treasury",
    "the two biggest levers together.",
    (s) => { s.orphanToMember = s.l1; const m = 713; s.treasury -= m; s.pool += m; }),

  S("C5 — zero the ENTIRE system take",
    "project income becomes zero. Shown as a BOUND, not an option — and it STILL does not self-fund.",
    (s) => { let m = 0; for (const k of SYSTEM_KEYS) { m += s[k]; s[k] = 0; } s.pool += m; }),

  S("C6 — BOTH leaks zero (C1 + C5)",
    "the arithmetic bound from 11.4. The ONLY way a zero-referral member self-funds.",
    (s) => { s.orphanToMember = s.l1; let m = 0; for (const k of SYSTEM_KEYS) { m += s[k]; s[k] = 0; } s.pool += m; }),
];

const DEBT_GATE_BPS = 5000;    // StabilityFund.insolvencyFloorBps — SHIPS 5_000 (owner 2026-08-19)

console.log("=".repeat(100));
console.log("  LEVER C — WHAT EACH RESHUFFLE WOULD DO TO A ZERO-REFERRAL MEMBER");
console.log("=".repeat(100));
const w = (v, n) => String(v).padEnd(n);
console.log("  " + w("scenario", 34) + w("take", 11) + w("shortfall", 12) + w("break-even", 12) + w("system take", 13) + "lendable?");
console.log("  " + "-".repeat(96));
for (const { name, s } of scenarios) {
  const t = zeroRefTake(s), gap = BPS - t;
  // The distributed table must still be exactly 10000 bps. `orphanToMember` and `poolTopUp`
  // are DERIVED read-outs (what the orphan actually receives / where their L1 went), not
  // extra money, so they are excluded from the sum — see the C2 note above for why this
  // guard exists at all.
  const dist = SYSTEM_KEYS.reduce((n, k) => n + s[k], 0) + s.pool + s.chain + s.direct + s.l1;
  if (dist !== BPS) { console.log("  " + w(name, 34) + `BPS SUM ${dist} != 10000 — SCENARIO VOID`); continue; }
  console.log("  " + w(name, 34) + w(usd(t), 11) + w(usd(gap), 12) +
              w(gap <= 0 ? "self-funds" : breakEven(s).toFixed(2) + " inv", 12) +
              w(usd(systemTake(s)), 13) +
              (gap <= DEBT_GATE_BPS ? "yes" : "NO — over the debt gate"));
}
console.log("=".repeat(100));
console.log(`  "lendable?" = is the shortfall within the SF debt gate (insolvencyFloorBps ${DEBT_GATE_BPS} = ${usd(DEBT_GATE_BPS)})?`);
console.log(`  ⚠ THAT GATE IS ON OUTSTANDING DEBT, NOT ON LOAN SIZE — it refuses a NEW loan once`);
console.log(`    memberDebt >= fee x bps/10000. It never reads the amount asked for (handoff 4938).`);
console.log(`  ⛔ NO ROW SELF-FUNDS EXCEPT C5, WHICH ZEROES THE PROJECT'S INCOME. That is the`);
console.log(`     conservation argument, priced: the gap closes only when BOTH leaks reach zero.`);
console.log(`  ⚠ C1/C4 HELP ONLY MEMBERS WITH NO REFERRER. What share of the live population that`);
console.log(`    is has NOT been measured — measure it before weighing C1 against C2.`);
