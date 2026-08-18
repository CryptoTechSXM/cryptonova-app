"use strict";
/**
 * test_ab/compare.js — reads every ab_result_*.json and prints the paired comparison.
 *
 * Run: node test_ab/compare.js
 *
 * ⛔ WHAT THIS DELIBERATELY REFUSES TO DO.
 *   It will not print a verdict from ONE seed. "One sample is not a measurement" is in the
 *   owner's rules because a count at a threshold held across three runs while a median
 *   nearly doubled in seven hours. A single paired run here is a shakedown of the harness,
 *   not evidence about item A, and this script says so rather than letting a lone row read
 *   as a result.
 *
 *   It also separates DEFAULT-DIAL pairs from EQUALISED-DIAL pairs and never averages
 *   across them. Four of the defects between these builds change keeper throughput
 *   (discovery order, the cap, the floor, batch truncation), so the default pair measures
 *   "the release" and the equalised pair measures "the economics holding throughput fixed".
 *   The DIFFERENCE between those two is the throughput contribution — a number worth
 *   having, and one that averaging would destroy.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = fs.readdirSync(root).filter((f) => /^ab_result_.+\.json$/.test(f));
if (!files.length) { console.log("no ab_result_*.json found — run replay.js first"); process.exit(0); }

const runs = files.map((f) => ({ f, ...JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) }));
const key = (r) => `${r.seed}${r.equalize ? "_eq" : ""}`;
const pairs = {};
for (const r of runs) (pairs[key(r)] ||= {})[r.arm] = r;

const pct = (a, b) => (a === null || b === null || a === 0 ? "  —  " :
  ((b - a) / a * 100).toFixed(0).padStart(4) + "%");
const f4 = (v) => (v === null || v === undefined ? "  null" : Number(v).toFixed(4).padStart(6));
const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);

const METRICS = [
  ["loansPerRescue",        "loans per rescue      ", "ratios", "lower is better — item A's core claim"],
  ["unfundedRescueShare",   "unfunded rescue share ", "ratios", "higher is better — fund paid nothing"],
  ["repeatParkShare",       "repeat-park share     ", "ratios", "lower is better — the loop signature"],
  ["parksPerMember",        "parks per member      ", "ratios", "lower is better — park pressure"],
];

const complete = [], partial = [];
for (const k of Object.keys(pairs).sort()) {
  (pairs[k].v849b && pairs[k].v850 ? complete : partial).push(k);
}

for (const k of complete) {
  const { v849b: a, v850: b } = pairs[k];
  console.log(`\n─── seed ${a.seed}${a.equalize ? "  [DIALS EQUALISED at 15/15]" : "  [release defaults 15 vs 20]"}` +
    `  ·  ${a.members} members, MATRIX_SIZE ${a.size} ───`);
  const dialLine = (r) => r.dials ? `cap=${r.dials.maxItemsPerUpkeep} floor=${r.dials.minGasPerItem}` : "dials NOT RECORDED";
  console.log(`  dials in force            ${dialLine(a)}   |   ${dialLine(b)}`);
  const void_ = a.ran.registered !== b.ran.registered || a.ran.keeperFailures !== b.ran.keeperFailures;
  if (void_) {
    console.log(`  [VOID] THE ARMS DID NOT RECEIVE EQUIVALENT TREATMENT — registered ` +
      `${a.ran.registered} vs ${b.ran.registered}, keeperFailures ${a.ran.keeperFailures} vs ` +
      `${b.ran.keeperFailures}. Do not read the rows below.`);
    for (const [arm, r] of [["v849b", a], ["v850", b]]) {
      const rs = r.keeperFailureReasons || [];
      if (rs.length) {
        const uniq = [...new Set(rs.map((x) => x.why))];
        console.log(`         ${arm} failures (${rs.length}), distinct reasons:`);
        for (const u of uniq.slice(0, 3)) console.log(`           ${u}`);
      }
    }
  }
  console.log(`  metric                    v849b   v850    change`);
  for (const [m, label, block] of METRICS) {
    console.log(`  ${label}  ${f4(a[block][m])}  ${f4(b[block][m])}   ${pct(a[block][m], b[block][m])}`);
  }
  console.log(`  rescues / loans           ${String(a.raw.rescues).padStart(6)}  ${String(b.raw.rescues).padStart(6)}` +
    `        (${a.raw.loans} vs ${b.raw.loans} loans)`);
  console.log(`  loan volume               ${usd(a.raw.loanVolume).padStart(6)}  ${usd(b.raw.loanVolume).padStart(6)}` +
    `   ${pct(Number(a.raw.loanVolume), Number(b.raw.loanVolume))}`);
  console.log(`  SF balance at end         ${usd(a.finalState.sfBalance).padStart(6)}  ${usd(b.finalState.sfBalance).padStart(6)}` +
    `   ${pct(Number(a.finalState.sfBalance), Number(b.finalState.sfBalance))}`);
  console.log(`  still parked (A+B)        ${String(Number(a.finalState.parkedA) + Number(a.finalState.parkedB)).padStart(6)}` +
    `  ${String(Number(b.finalState.parkedA) + Number(b.finalState.parkedB)).padStart(6)}`);
}

if (partial.length) {
  console.log(`\n  [WARN] INCOMPLETE PAIRS (one arm only, not comparable): ${partial.join(", ")}`);
}

const isVoid = (k) => {
  const p = pairs[k];
  return p.v849b.ran.registered !== p.v850.ran.registered ||
         p.v849b.ran.keeperFailures !== p.v850.ran.keeperFailures;
};
// ⛔ A VOID PAIR IS NOT A SEED. Counting one toward "3 seeds" would let the script bless a
//    conclusion built on runs it had just declared unreadable — the exact failure the
//    three-seed rule exists to prevent.
const defaultSeeds = complete.filter((k) => !k.endsWith("_eq") && !isVoid(k));
const eqSeeds = complete.filter((k) => k.endsWith("_eq") && !isVoid(k));
console.log(`\n─── STANDING ───`);
const voidCount = complete.length - defaultSeeds.length - eqSeeds.length;
console.log(`  VALID pairs: ${defaultSeeds.length} at release defaults, ${eqSeeds.length} equalised` +
  (voidCount ? `   (${voidCount} VOID, excluded from the count)` : ""));
if (defaultSeeds.length < 3) {
  console.log(`  [STOP] NOT ENOUGH TO CONCLUDE ANYTHING. ${defaultSeeds.length} of 3 seeds at release`);
  console.log(`     defaults. One sample is not a measurement — run more seeds before quoting`);
  console.log(`     any figure above as a finding about item A.`);
} else {
  console.log(`  [OK] ${defaultSeeds.length} seeds. Read the DIRECTION and whether it holds across all of`);
  console.log(`     them, not the point value of any single row — the underlying figures are`);
  console.log(`     volatile and the verdicts are what survive replication.`);
}
if (!eqSeeds.length) {
  console.log(`  [WARN] NO EQUALISED PAIR YET. Without one, every difference above is item A's`);
  console.log(`     economics PLUS the keeper doing more work per tick (cap 20 vs 15), in`);
  console.log(`     unknown proportion. Run with AB_EQUALIZE=1 to separate them.`);
}
console.log("");
