// probe_v849_getters.js — prove the FRESH V8.49 deployment is actually running
// V8.49 code, and that the two defaults the whole test depends on really shipped.
// (Deploy card step 1.3b, V8.49 edition. Written 2026-08-16.)
//
// WHY THIS MATTERS MORE THAN THE V8.48 EDITION DID:
// V8.49 changes exactly two things that the measurement rests on —
// crossingBufferBps (default 0) and evictionGracePeriod (default 7 days) — and
// deploy_v8.js sets NEITHER explicitly. They arrive as contract defaults. So the
// only evidence that V8.49 rather than V8.48 is on chain is the getters
// themselves. Every number T1-T6 produces is meaningless if this is V8.48
// bytecode at a new address, and nothing else in the pipeline would notice.
//
// THREE KINDS OF ROW:
//   VIEW    — call it. Exists = pass. With an expected value, mismatch = FAIL
//             (a declared default did not ship).
//   ABSENT  — must NOT exist. Used for CROSSING_BUFFER_BPS(), the V8.48 public
//             constant that V8.49 retired. If it still answers, this is V8.48.
//             A missing selector returns empty data and ethers throws BAD_DATA.
//             ANY OTHER ERROR IS REPORTED INCONCLUSIVE, NOT PASS — an RPC hiccup
//             must never be read as "the old constant is gone". (This project has
//             twice drawn a negative conclusion from a failed lookup; not again.)
//   RECORD  — no expectation, just print and pin the starting value (SF balance,
//             total loaned) so later readings have a baseline.
//
// Read-only. No key. Run (contracts repo, Windows):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
//   node scripts\probe_v849_getters.js

const { ethers } = require("ethers");
const path = require("path");
const fs   = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC  = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const FILE = process.env.ADDRESSES_FILE;
if (!FILE) {
  console.log("FATAL: ADDRESSES_FILE not set. Name the deployment explicitly:");
  console.log('  $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"');
  process.exit(1);
}
const A = require(path.join(__dirname, FILE));

const DAY = 86400n;

// Warn (do not block) when the value looks inherited from .env rather than chosen.
function dotenvValue() {
  try {
    const t = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const m = t.match(/^\s*ADDRESSES_FILE\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const VIEWS = [
  // ── the two V8.49 defaults the measurement rests on ──────────────────────
  ["matrixKeeper", "crossingBufferBps == 0  (item 1b)",
    "function crossingBufferBps() view returns (uint256)", () => [], 0n, true],
  ["matrixKeeper", "evictionGracePeriod == 7d  (item 1)",
    "function evictionGracePeriod() view returns (uint256)", () => [], 7n * DAY, true],

  // ── the clock that must stay DECOUPLED from eviction ─────────────────────
  ["matrixKeeper", "extendedIdleTimeout == 7d (idle reclaim only)",
    "function extendedIdleTimeout() view returns (uint256)", () => [], 7n * DAY, true],

  // ── set explicitly by deploy_v8.js; confirm they landed ──────────────────
  ["matrixKeeper", "parkedGracePeriod == 86400 (24h)",
    "function parkedGracePeriod() view returns (uint256)", () => [], 86400n, true],
  ["matrixKeeper", "selfFundedGracePeriod == 300 (race guard)",
    "function selfFundedGracePeriod() view returns (uint256)", () => [], 300n, true],

  // ── policy B: loanHeadroom is the single primitive, the others derive ─────
  ["stabilityFund", "insolvencyFloorBps == 3400 (PARAM 59)",
    "function insolvencyFloorBps() view returns (uint256)", () => [], 3400n, true],
  ["stabilityFund", "loanHeadroom(W1,0)  (policy B primitive)",
    "function loanHeadroom(address,uint8) view returns (uint256)", () => [A.accountOne, 0], null, true],
  ["stabilityFund", "loanEligibleFor(W1,0,1e6)  (3-arg, policy B)",
    "function loanEligibleFor(address,uint8,uint256) view returns (bool)", () => [A.accountOne, 0, 1000000], null, true],
  ["stabilityFund", "loanEligible(W1,0)  (2-arg, derived)",
    "function loanEligible(address,uint8) view returns (bool)", () => [A.accountOne, 0], null, true],
];

// Must NOT exist. Their presence means V8.48 bytecode.
const ABSENT = [
  ["matrixKeeper", "CROSSING_BUFFER_BPS() is RETIRED",
    "function CROSSING_BUFFER_BPS() view returns (uint256)", () => []],
];

// No expectation — pin the starting values so later readings have a baseline.
const RECORD = [
  ["stabilityFund", "SF totalBalance at t0",
    "function totalBalance() view returns (uint256)", () => [], 1e6],
  ["stabilityFund", "totalRescueLoaned at t0",
    "function totalRescueLoaned() view returns (uint256)", () => [], 1e6],
];

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });

  console.log(`\nblock ${await p.getBlockNumber()}   addresses: ${FILE}`);
  console.log(`network in file: ${A.network}   deployedAt: ${A.deployedAt || "(not recorded)"}`);
  const dv = dotenvValue();
  if (dv && dv === FILE) {
    console.log(`\n  NOTE: ${FILE} is also what .env names, so it may have been INHERITED`);
    console.log(`  rather than chosen. Confirm this is the deployment you meant to probe.`);
  }

  // PRECONDITION: a probe against an address with no code reports everything as
  // missing, which reads exactly like "V8.49 did not ship". Rule it out first.
  let precondFail = 0;
  for (const key of ["matrixKeeper", "stabilityFund"]) {
    const code = await p.getCode(A[key]);
    if (!code || code === "0x") {
      console.log(`\nFATAL: no contract code at ${key} ${A[key]}`);
      console.log("Everything below would report MISSING for the wrong reason. Stopping.");
      precondFail++;
    }
  }
  if (precondFail) process.exit(1);
  console.log(`\n  MatrixKeeper  : ${A.matrixKeeper}`);
  console.log(`  StabilityFund : ${A.stabilityFund}\n`);

  let fail = 0, inconclusive = 0;

  for (const [key, label, abi, argFn, expected, required] of VIEWS) {
    const c = new ethers.Contract(A[key], [abi], p);
    const m = abi.match(/function (\w+)/)[1];
    try {
      const v = await c[m](...argFn());
      let ok = true, note = `= ${v}`;
      if (expected !== null) {
        ok = (typeof v === "bigint" ? v === expected : String(v) === String(expected));
        if (!ok) note = `= ${v}  EXPECTED ${expected}  <-- DEFAULT DID NOT SHIP`;
      }
      if (!ok && required) fail++;
      console.log(`${ok ? " OK " : "FAIL"}  ${label.padEnd(46)} ${note}`);
    } catch (e) {
      fail++;
      console.log(`FAIL  ${label.padEnd(46)} MISSING/REVERTED: ${(e.shortMessage || e.message).slice(0, 60)}`);
    }
  }

  // ── IS THE RETIRED V8.48 CONSTANT REALLY GONE? ────────────────────────────
  // FIRST ATTEMPT AT THIS CHECK WAS AN INFERENCE AND IT MISFIRED (2026-08-16).
  // It called CROSSING_BUFFER_BPS() and classified the error. An absent selector
  // on a Solidity contract with no fallback REVERTS WITH EMPTY DATA, which ethers
  // reports as CALL_EXCEPTION "missing revert data" — not the BAD_DATA the check
  // looked for. So it reported INCONCLUSIVE on a chain that was fine.
  //
  // Widening the string match would have "fixed" it while leaving the real defect:
  // concluding a function is ABSENT from the shape of an error is inference, and
  // this project has twice paid for a negative conclusion drawn that way.
  //
  // Direct evidence instead: read the runtime bytecode and look for the 4-byte
  // selector. Solidity's dispatcher compares selectors as PUSH4 literals, so a
  // dispatchable function's selector is present verbatim; absence is decisive.
  //
  // AND A POSITIVE CONTROL, because a detector that finds nothing is
  // indistinguishable from a broken detector: crossingBufferBps() MUST be found
  // by the same scan, in the same bytecode, on the same run. If the control
  // fails, the scan is broken and the result is reported INCONCLUSIVE — never as
  // a pass. (This is the TARGET= self-test discipline from bypass_scan_full.js.)
  const runtime = (await p.getCode(A.matrixKeeper)).toLowerCase();
  const selOf   = sig => ethers.id(sig).slice(2, 10).toLowerCase();
  const present = sig => runtime.includes(selOf(sig));

  const CONTROL_SIG = "crossingBufferBps()";
  const RETIRED_SIG = "CROSSING_BUFFER_BPS()";
  const controlFound = present(CONTROL_SIG);
  const retiredFound = present(RETIRED_SIG);

  console.log(`      [bytecode scan] ${runtime.length / 2 - 1} bytes  ` +
              `control ${CONTROL_SIG}=${selOf(CONTROL_SIG)} found=${controlFound}  ` +
              `retired ${RETIRED_SIG}=${selOf(RETIRED_SIG)} found=${retiredFound}`);

  if (!controlFound) {
    inconclusive++;
    console.log(`????  CROSSING_BUFFER_BPS() is RETIRED           INCONCLUSIVE`);
    console.log(`      The POSITIVE CONTROL failed: crossingBufferBps() should be in this`);
    console.log(`      bytecode and was not found. The scan is broken, so its silence about`);
    console.log(`      the retired constant proves nothing. Do not read this as a pass.`);
  } else if (retiredFound) {
    fail++;
    console.log(`FAIL  CROSSING_BUFFER_BPS() is RETIRED           SELECTOR PRESENT IN BYTECODE`);
    console.log(`      This deployment is V8.48 bytecode. Every measurement taken against it`);
    console.log(`      would be a well-measured fact about the wrong contract. STOP.`);
  } else {
    console.log(` OK   CROSSING_BUFFER_BPS() is RETIRED           absent from bytecode (control passed)`);
  }

  // Corroborating call — two independent instruments, as the VPS threshold work
  // did with entry counts vs rotation counts. Reported, never counted.
  for (const [key, label, abi, argFn] of ABSENT) {
    const c = new ethers.Contract(A[key], [abi], p);
    const m = abi.match(/function (\w+)/)[1];
    try {
      const v = await c[m](...argFn());
      console.log(`      [corroborate] call returned ${v} — DISAGREES with the bytecode scan`);
    } catch (e) {
      console.log(`      [corroborate] call reverted (${(e.shortMessage || e.message).slice(0, 40)}) — agrees`);
    }
  }

  for (const [key, label, abi, argFn, div] of RECORD) {
    const c = new ethers.Contract(A[key], [abi], p);
    const m = abi.match(/function (\w+)/)[1];
    try {
      const v = await c[m](...argFn());
      console.log(`REC   ${label.padEnd(46)} = $${(Number(v) / div).toFixed(2)}`);
    } catch (e) {
      console.log(`REC   ${label.padEnd(46)} unreadable: ${(e.shortMessage || e.message).slice(0, 40)}`);
    }
  }

  console.log("\n" + "=".repeat(74));
  if (fail === 0 && inconclusive === 0) {
    console.log("ALL V8.49 PROBES PASS — the chain is running V8.49 with buffer 0 and a 7-day");
    console.log("eviction clock. Measurements taken against this deployment mean what they say.");
  } else {
    if (fail) console.log(`${fail} PROBE(S) FAILED.`);
    if (inconclusive) console.log(`${inconclusive} INCONCLUSIVE — re-run before believing anything.`);
    console.log("Do NOT start the cohorts. Paste this output to Claude.");
    process.exit(1);
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
