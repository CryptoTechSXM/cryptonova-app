"use strict";
/**
 * predeploy_check.js  --  V8.1 Pre-Deploy Validator
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this before every deploy to catch configuration bugs early.
 *
 * Checks (13 total):
 *   1. Required env vars are set
 *   2. deploy_v8.js StabilityFund constructor has 3 args (usdc, cnova, admin)
 *   3. forceCross gasLimit is >= 12_000_000 in bigfill_v8.js
 *   4. ADDRESSES_FILE defaults are consistent across scripts
 *   5. No em-dashes (—) in Solidity string literals
 *   6. lastActivityTime NOT in _credit() (gas regression guard)
 *   7. TierRouter ABI uses uint256 for tierEntryFees (not uint8)
 *
 * Run: npx hardhat run scripts/predeploy_check.js
 *  (no network needed — reads files only)
 */

const fs   = require("fs");
const path = require("path");

const ROOT    = path.join(__dirname, "..");
const SCRIPTS = __dirname;

let passed = 0;
let failed = 0;

function ok(msg)   { console.log(`  ✓  ${msg}`); passed++; }
function fail(msg) { console.error(`  ✗  ${msg}`); failed++; }
function sep(title) { console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`); }

// ── Helper: read file text ─────────────────────────────────────────────────
function read(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) { fail(`File not found: ${relPath}`); return ""; }
  return fs.readFileSync(full, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Required env vars
// ─────────────────────────────────────────────────────────────────────────────
sep("Env vars");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const REQUIRED_VARS = ["DEPLOYER_PRIVATE_KEY", "W1_PRIVATE_KEY"];
for (const v of REQUIRED_VARS) {
  if (process.env[v]) ok(`${v} is set`);
  else                fail(`${v} is NOT set in .env`);
}

const ADDR_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_6.json";
console.log(`  ℹ  ADDRESSES_FILE = ${ADDR_FILE}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. deploy_v8.js — StabilityFund constructor args
// ─────────────────────────────────────────────────────────────────────────────
sep("deploy_v8.js — StabilityFund constructor");
const deployText = read("scripts/deploy_v8.js");
if (deployText) {
  // Look for the deploy(...) call for StabilityFund
  // Should have [usdcAddr, cnovaAddr, admin] (3 elements)
  const sfMatch = deployText.match(/deploy\s*\(\s*StabilityFund\s*,\s*\[([^\]]+)\]/);
  if (!sfMatch) {
    fail("Could not find StabilityFund deploy() call — check deploy_v8.js manually");
  } else {
    const args = sfMatch[1].split(",").map(s => s.trim()).filter(Boolean);
    if (args.length === 3) {
      ok(`StabilityFund constructor has 3 args: [${args.join(", ")}]`);
    } else {
      fail(`StabilityFund constructor has ${args.length} arg(s): [${args.join(", ")}] — expected 3 (usdc, cnova, admin)`);
    }
  }

  // Check ADDRESSES_FILE default
  const afMatch = deployText.match(/deployed_addresses_v8_(\d+)\.json/g);
  if (afMatch) {
    const defaults = [...new Set(afMatch)];
    ok(`deploy_v8.js output file: ${defaults.join(", ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. bigfill_v8.js — forceCross gasLimit
// ─────────────────────────────────────────────────────────────────────────────
sep("bigfill_v8.js — forceCross gasLimit");
const bigfillText = read("scripts/bigfill_v8.js");
if (bigfillText) {
  // Find forceCross call with gasLimit
  const fcMatch = bigfillText.match(/forceCross\s*\([^)]+gasLimit\s*:\s*([\d_]+)/);
  if (!fcMatch) {
    fail("Could not find forceCross gasLimit — check bigfill_v8.js manually");
  } else {
    const gl = Number(fcMatch[1].replace(/_/g, ""));
    if (gl >= 12_000_000) {
      ok(`forceCross gasLimit = ${gl.toLocaleString()} (≥ 12M required)`);
    } else {
      fail(`forceCross gasLimit = ${gl.toLocaleString()} — must be ≥ 12,000,000. At MATRIX_SIZE=64, _distributePool burns ~3.5M gas leaving insufficient headroom.`);
    }
  }

  // Check ADDRESSES_FILE default
  const afMatch = bigfillText.match(/deployed_addresses_v8_(\d+)\.json/);
  if (afMatch) ok(`bigfill_v8.js addresses default: deployed_addresses_v8_${afMatch[1]}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADDRESSES_FILE consistency across scripts
// ─────────────────────────────────────────────────────────────────────────────
sep("ADDRESSES_FILE consistency");
const scripts = ["scripts/deploy_v8.js", "scripts/seed_w1.js", "scripts/bigfill_v8.js"];
const defaults = {};
for (const s of scripts) {
  const txt = read(s);
  if (!txt) continue;
  const m = txt.match(/deployed_addresses_v8_(\d+)\.json/);
  if (m) defaults[s] = `deployed_addresses_v8_${m[1]}.json`;
}
const uniqueDefaults = [...new Set(Object.values(defaults))];
if (uniqueDefaults.length === 1) {
  ok(`All scripts default to ${uniqueDefaults[0]}`);
} else {
  fail(`Scripts have MISMATCHED defaults: ${JSON.stringify(defaults)}`);
  console.error("    Fix: set ADDRESSES_FILE env var or align script defaults");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Solidity — no em-dashes in string literals
// ─────────────────────────────────────────────────────────────────────────────
sep("Solidity — em-dash check");
const SOL_DIR = path.join(ROOT, "contracts");
const solFiles = fs.readdirSync(SOL_DIR).filter(f => f.endsWith(".sol"));
let emDashFound = false;
for (const f of solFiles) {
  const txt = fs.readFileSync(path.join(SOL_DIR, f), "utf8");
  // Find em-dash (U+2014) inside string literals
  const lines = txt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines (// or *)
    const stripped = line.trimStart();
    if (stripped.startsWith("//") || stripped.startsWith("*")) continue;
    // Find string literals on this line (inside double-quotes) and check for em-dash
    const strMatches = line.match(/"[^"]*—[^"]*"/g);
    if (strMatches) {
      fail(`Em-dash inside string literal in ${f}:${i + 1} — fix: use -- instead`);
      console.error(`    Line: ${line.trim().substring(0, 100)}`);
      emDashFound = true;
    }
  }
}
if (!emDashFound) ok("No em-dashes found in any .sol file");

// ─────────────────────────────────────────────────────────────────────────────
// 6. FigureEightMatrixV8.sol — lastActivityTime NOT in _credit()
// ─────────────────────────────────────────────────────────────────────────────
sep("FigureEightMatrixV8.sol — gas regression guard");
const matTxt = read("contracts/FigureEightMatrixV8.sol");
if (matTxt) {
  // Find the _credit function body
  const creditMatch = matTxt.match(/function _credit\b[\s\S]*?^    \}/m);
  if (!creditMatch) {
    // Try a looser match
    const idx = matTxt.indexOf("function _credit(");
    if (idx === -1) {
      fail("Could not find _credit() function in FigureEightMatrixV8.sol");
    } else {
      // Look at the next 30 lines after _credit
      const snippet = matTxt.substring(idx, idx + 1500);
      // Only flag actual assignments (= block.timestamp), not comments
      const assignMatch = snippet.match(/lastActivityTime\s*\[\s*\w+\s*\]\s*=/);
      if (assignMatch) {
        fail("lastActivityTime assigned inside _credit() — this causes ~860k extra gas per cycle-out. Remove it.");
      } else {
        ok("lastActivityTime NOT assigned in _credit() (gas fix confirmed)");
      }
    }
  } else {
    const assignInCredit = /lastActivityTime\s*\[\s*\w+\s*\]\s*=/.test(creditMatch[0]);
    if (assignInCredit) {
      fail("lastActivityTime assigned inside _credit() — gas regression! Remove it.");
    } else {
      ok("lastActivityTime NOT assigned in _credit() (gas fix confirmed)");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. index.html — TierRouter ABI uses uint256 for tierEntryFees
// ─────────────────────────────────────────────────────────────────────────────
sep("index.html — TierRouter ABI");
const htmlPath = path.join(ROOT, "..", "..", "..", "..", "..", "CryptoNova-App", "index.html");
// Try the mount path
const htmlPaths = [
  htmlPath,
  "/sessions/happy-amazing-curie/mnt/CryptoNova-App/index.html"
];
let htmlTxt = "";
for (const p of htmlPaths) {
  if (fs.existsSync(p)) { htmlTxt = fs.readFileSync(p, "utf8"); break; }
}
if (!htmlTxt) {
  console.log("  ℹ  index.html not found from script dir — skipping ABI check");
} else {
  if (htmlTxt.includes("tierEntryFees(uint8)")) {
    fail("TIER_ROUTER_ABI uses uint8 for tierEntryFees — causes execution reverted. Change to uint256.");
  } else if (htmlTxt.includes("tierEntryFees(uint256)")) {
    ok("TIER_ROUTER_ABI uses uint256 for tierEntryFees (correct)");
  } else {
    console.log("  ℹ  tierEntryFees not found in index.html ABI — add if TierRouter is used");
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 8. deploy_v8.js — v8.6 MATRIX_SIZE=127 + all 7 tiers
// ─────────────────────────────────────────────────────────────────────────────
sep("deploy_v8.js — v8.6 config (MATRIX_SIZE=127, all 7 tiers)");
if (deployText) {
  // Check MATRIX_SIZE default
  const msMatch = deployText.match(/MATRIX_SIZE\s*[=\|][^\n]*?"(\d+)"/);
  if (msMatch) {
    const ms = parseInt(msMatch[1], 10);
    if (ms === 127) ok(`MATRIX_SIZE default = 127 (correct)`);
    else            fail(`MATRIX_SIZE default = ${ms} — expected 127 for v8.6`);
  } else {
    // Looser check
    if (deployText.includes('"127"')) ok('MATRIX_SIZE uses "127" (found in script)');
    else fail('MATRIX_SIZE "127" not found in deploy_v8.js — expected for v8.6');
  }

  // Check DEPLOY_TIERS default
  const dtMatch = deployText.match(/DEPLOY_TIERS\s*[=\|][^\n]*?"([^"]+)"/);
  if (dtMatch) {
    const tiers = dtMatch[1].split(",").map(t => t.trim());
    if (tiers.length === 7 && tiers.includes("7")) {
      ok(`DEPLOY_TIERS = "${dtMatch[1]}" (all 7 tiers)`);
    } else {
      fail(`DEPLOY_TIERS = "${dtMatch[1]}" — expected "1,2,3,4,5,6,7" for v8.6`);
    }
  } else {
    if (deployText.includes('"1,2,3,4,5,6,7"')) ok('DEPLOY_TIERS uses "1,2,3,4,5,6,7" (found)');
    else fail('DEPLOY_TIERS "1,2,3,4,5,6,7" not found in deploy_v8.js');
  }

  // Check velocity gate closure logic is present
  if (deployText.includes("setTierVelocityGreen") && deployText.includes("CLOSED")) {
    ok("Velocity gate closure logic found in deploy_v8.js");
  } else {
    fail("Velocity gate closure (setTierVelocityGreen + CLOSED) not found in deploy_v8.js");
  }

  // Check ADDRESSES_FILE default is v8_6
  if (deployText.includes("deployed_addresses_v8_6.json")) {
    ok("deploy_v8.js output file: deployed_addresses_v8_6.json");
  } else {
    fail("deploy_v8.js does not output to deployed_addresses_v8_6.json");
  }

  // Chainlink gas limit should be 6M+
  const clMatch = deployText.match(/Chainlink.*?gas.*?(\d[\d_,]+)/i);
  if (clMatch) {
    const gl = Number(clMatch[1].replace(/[_,]/g, ""));
    if (gl >= 6_000_000) ok(`Chainlink gas limit note: ${gl.toLocaleString()} (>= 6M)`);
    else                 fail(`Chainlink gas limit note: ${gl.toLocaleString()} — raise to >= 6,000,000 for 127-seat`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. FigureEightMatrixV8.sol — v8.6 parked wallet feature
// ─────────────────────────────────────────────────────────────────────────────
sep("FigureEightMatrixV8.sol — v8.6 parked wallet features");
if (matTxt) {
  // MemberParked event
  if (matTxt.includes("event MemberParked")) {
    ok("event MemberParked declared");
  } else {
    fail("event MemberParked NOT found — add to FigureEightMatrixV8.sol");
  }

  // parkedMembers array
  if (matTxt.includes("parkedMembers")) {
    ok("parkedMembers[] state variable found");
  } else {
    fail("parkedMembers[] NOT found — add address[] public parkedMembers");
  }

  // forceCrossKeeper function
  if (matTxt.includes("forceCrossKeeper")) {
    ok("forceCrossKeeper() found");
  } else {
    fail("forceCrossKeeper() NOT found — add keeper-only force-cross function");
  }

  // isParked helper
  if (matTxt.includes("isParked")) {
    ok("isParked() helper found");
  } else {
    fail("isParked() NOT found — add view helper for keeper discovery");
  }

  // Check MATRIX_SIZE is a constructor parameter (not hardcoded)
  if (matTxt.match(/uint256\s+(?:_matrixSize|matrixSize|_size)/)) {
    ok("MATRIX_SIZE is a constructor parameter (not hardcoded)");
  } else if (matTxt.includes("MATRIX_SIZE")) {
    ok("MATRIX_SIZE constant found in contract");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. StabilityFund.sol — payForceCross function
// ─────────────────────────────────────────────────────────────────────────────
sep("StabilityFund.sol — v8.6 payForceCross");
const sfText = read("contracts/StabilityFund.sol");
if (sfText) {
  if (sfText.includes("payForceCross")) {
    ok("payForceCross() found in StabilityFund.sol");
  } else {
    fail("payForceCross() NOT found — add keeper-only SF->matrix USDC transfer function");
  }

  // Check SF keeper setter
  if (sfText.includes("setMatrixKeeper") || sfText.includes("matrixKeeper")) {
    ok("matrixKeeper role found in StabilityFund.sol");
  } else {
    fail("matrixKeeper NOT found in StabilityFund.sol — keeper cannot call payForceCross");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. MatrixKeeper.sol — v8.6 WORK_PARKED_RESCUE + WORK_VELOCITY_GATE
// ─────────────────────────────────────────────────────────────────────────────
sep("MatrixKeeper.sol — v8.6 work types");
const mkText = read("contracts/MatrixKeeper.sol");
if (mkText) {
  if (mkText.includes("WORK_PARKED_RESCUE")) {
    ok("WORK_PARKED_RESCUE constant found");
  } else {
    fail("WORK_PARKED_RESCUE NOT found — add constant = 4");
  }

  if (mkText.includes("WORK_VELOCITY_GATE")) {
    ok("WORK_VELOCITY_GATE constant found");
  } else {
    fail("WORK_VELOCITY_GATE NOT found — add constant = 5");
  }

  if (mkText.includes("_doParkedRescue") || mkText.includes("doParkedRescue")) {
    ok("_doParkedRescue() handler found");
  } else {
    fail("_doParkedRescue() NOT found in MatrixKeeper.sol");
  }

  if (mkText.includes("_doVelocityGate") || mkText.includes("doVelocityGate")) {
    ok("_doVelocityGate() handler found");
  } else {
    fail("_doVelocityGate() NOT found in MatrixKeeper.sol");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. bigfill_v8.js — register gasLimit >= 8M for 127-seat
// ─────────────────────────────────────────────────────────────────────────────
sep("bigfill_v8.js — register gasLimit (127-seat)");
if (bigfillText) {
  const regGlMatch = bigfillText.match(/register\s*\([^)]+gasLimit\s*:\s*([\d_]+)/);
  if (!regGlMatch) {
    fail("Could not find register() gasLimit in bigfill_v8.js — check manually");
  } else {
    const gl = Number(regGlMatch[1].replace(/_/g, ""));
    if (gl >= 8_000_000) {
      ok(`register() gasLimit = ${gl.toLocaleString()} (>= 8M required for 127-seat)`);
    } else {
      fail(`register() gasLimit = ${gl.toLocaleString()} — must be >= 8,000,000 for MATRIX_SIZE=127 cycle-out gas`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. deployed_addresses_v8_6.json — exists and has expected keys
// ─────────────────────────────────────────────────────────────────────────────
sep("deployed_addresses_v8_6.json — presence check");
{
  const addrFile = path.join(ROOT, "deployed_addresses_v8_6.json");
  if (!fs.existsSync(addrFile)) {
    console.log("  ℹ  deployed_addresses_v8_6.json not found — run deploy_v8.js first");
  } else {
    const addrData = JSON.parse(fs.readFileSync(addrFile, "utf8"));
    const required = ["tierRouter", "stabilityFund", "matrixKeeper"];
    for (const key of required) {
      if (addrData[key]) ok(`addresses: ${key} = ${addrData[key]}`);
      else               fail(`addresses: ${key} missing from deployed_addresses_v8_6.json`);
    }
    // Check tiers 1-7 present
    const tiers = addrData.tiers || {};
    const tierCount = Object.keys(tiers).length;
    if (tierCount >= 7) {
      ok(`addresses: ${tierCount} tiers registered (expected 7)`);
    } else if (tierCount > 0) {
      console.log(`  ℹ  addresses: ${tierCount} tiers registered (deploy all 7 for v8.6)`);
    } else {
      fail("addresses: no tiers found — run deploy_v8.js with DEPLOY_TIERS=1,2,3,4,5,6,7");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(62));
if (failed === 0) {
  console.log(`  ✅  All ${passed} checks passed — safe to deploy`);
} else {
  console.error(`  ❌  ${failed} check(s) FAILED — fix before deploying`);
  console.error(`  ✓   ${passed} check(s) passed`);
  process.exit(1);
}
console.log("═".repeat(62) + "\n");
