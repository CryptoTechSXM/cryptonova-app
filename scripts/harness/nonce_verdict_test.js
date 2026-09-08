// scripts/harness/nonce_verdict_test.js — proves R17's verdict offline. Run from the repo root:
//   node scripts/harness/nonce_verdict_test.js      -> "4/4 PASS", exit 0
const assert = require("assert");
const { nonceVerdict } = require("../nonce_verdict");
const cases = [
  ["equal -> ok",            nonceVerdict(100, 100).action, "ok"],
  ["chain ahead -> foreign", nonceVerdict(100, 101).action, "foreign"],
  ["chain behind -> lag",    nonceVerdict(100, 98).action,  "lag"],
  ["unusable read -> lag",   nonceVerdict(100, NaN).action, "lag"],
];
let pass = 0;
for (const [name, got, want] of cases) {
  try { assert.strictEqual(got, want); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: got ${got}, want ${want}`); }
}
assert.ok(/rr_keeper\.OFF/.test(nonceVerdict(1, 2).msg), "foreign message names the kill switch");
console.log(`${pass}/${cases.length} PASS`); process.exit(pass === cases.length ? 0 : 1);
