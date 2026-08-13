"use strict";
/**
 * predeploy_check.js  --  V8.10 Pre-Deploy Validator
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
 * NOTE: this header list is not exhaustive — many checks have been added since
 * without updating the count above. Notably (V8.22): every SPLITS_T*_T* BPS
 * array is now parsed and arithmetically verified to sum to 10000, and every
 * CHAIN_PAY_T*_T* sub-split is verified to sum to its tier band's chainBps —
 * not just string-matched against the T1-T3 array, as before.
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
// V8.48: several checks below must distinguish a live CALL from a comment that
// merely names the old function. Strip line and block comments first — otherwise
// the tombstone comments documenting a removal trip the check that verifies it.
function stripComments(txt) {
  return String(txt)
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "")  // whole-line // comments (leaves https:// alone)
    .replace(/^[ \t]*\*[^\n]*$/gm, "");   // continuation lines of /** */ blocks
}

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
const OPTIONAL_WALLETS = ["DEV_WALLET_ADDRESS", "OPS_WALLET_ADDRESS"]; // default to deployer if unset
for (const v of REQUIRED_VARS) {
  if (process.env[v]) ok(`${v} is set`);
  else                fail(`${v} is NOT set in .env`);
}
for (const v of OPTIONAL_WALLETS) {
  if (process.env[v]) ok(`${v} = ${process.env[v].slice(0,10)}... (separate wallet)`);
  else ok(`${v} not set — will default to deployer address`);
}

const ADDR_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json";
console.log(`  ℹ  ADDRESSES_FILE = ${ADDR_FILE}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. deploy_v8.js — StabilityFund constructor args
// ─────────────────────────────────────────────────────────────────────────────
sep("deploy_v8.js — StabilityFund constructor");
const deployText = read("scripts/deploy_v8.js");
if (deployText) {
  // Look for the deploy(...) call for StabilityFund
  // V8.7 SF v3: should have [usdcAddr, admin] (2 elements)
  const sfMatch = deployText.match(/deploy\s*\(\s*StabilityFund\s*,\s*\[([^\]]+)\]/);
  if (!sfMatch) {
    fail("Could not find StabilityFund deploy() call — check deploy_v8.js manually");
  } else {
    const args = sfMatch[1].split(",").map(s => s.trim()).filter(Boolean);
    if (args.length === 2) {
      ok(`StabilityFund constructor has 2 args: [${args.join(", ")}]`);
    } else {
      fail(`StabilityFund constructor has ${args.length} arg(s): [${args.join(", ")}] — expected 2 (usdc, admin) for V8.7 SF v3`);
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
sep("bigfill_v8.js — register gasLimit");
const bigfillText = read("scripts/bigfill_v8.js");
if (bigfillText) {
  // bigfill no longer calls forceCross (V8.18+) — keeper handles rescues.
  // Verify register() gasLimit is ≥ 8M for 127-seat matrix.
  const regMatch = bigfillText.match(/register\s*\([^)]+gasLimit\s*:\s*([\d_]+)/);
  if (!regMatch) {
    // Not a failure — some builds inline the gasLimit differently
    console.log("  ℹ  Could not parse register() gasLimit inline — manual check skipped");
  } else {
    const gl = Number(regMatch[1].replace(/_/g, ""));
    if (gl >= 8_000_000) {
      ok(`register() gasLimit = ${gl.toLocaleString()} (≥ 8M required for 127-seat)`);
    } else {
      fail(`register() gasLimit = ${gl.toLocaleString()} — must be ≥ 8,000,000 for MATRIX_SIZE=127`);
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
// 6. MatrixLogicLib.sol — lastActivityTime IS in _credit() (V8.33 requirement)
//    HISTORY: this check originally guarded AGAINST the assignment (gas cost).
//    V8.33 deliberately reinstated it: passively-earning members were being
//    flagged idle and reclaimed (the V8.32 reclaim flood). The ~gas cost is the
//    accepted price of correct idle tracking. The check now asserts the V8.33
//    fix is PRESENT so a future "optimization" can't silently reintroduce
//    the reclaim flood.
// ─────────────────────────────────────────────────────────────────────────────
sep("MatrixLogicLib.sol — V8.33 idle-tracking guard (_credit resets timer)");
const matTxt = read("contracts/FigureEightMatrixV8.sol");
const libTxt = read("contracts/MatrixLogicLib.sol");
const creditSourceTxt = (matTxt && matTxt.includes("function _credit(")) ? matTxt : libTxt;
if (creditSourceTxt) {
  const idx = creditSourceTxt.indexOf("function _credit(");
  if (idx === -1) {
    fail(`Could not find _credit() function in FigureEightMatrixV8.sol or MatrixLogicLib.sol`);
  } else {
    const snippet = creditSourceTxt.substring(idx, idx + 1500);
    const assignMatch = snippet.match(/lastActivityTime\s*\[\s*\w+\s*\]\s*=/);
    if (assignMatch) {
      ok("lastActivityTime reset in _credit() (V8.33 reclaim-flood fix present)");
    } else {
      fail("lastActivityTime NOT reset in _credit() — V8.33 fix missing; passive earners will be reclaimed as idle (V8.32 flood).");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. index.html — TierRouter ABI uses uint256 for tierEntryFees
// ─────────────────────────────────────────────────────────────────────────────
sep("index.html — TierRouter ABI");
// V8.48: this used to hardcode a single session mount (/sessions/happy-amazing-curie/…)
// and point at CryptoNova-App. Both were stale, so every frontend check below
// silently SKIPPED — which is the exact failure mode the CODE<->FRONTEND PARITY
// rule exists to prevent. Resolve the mount at runtime and prefer the app that is
// actually being deployed.
const APP_DIRS = ["CryptoNova-Testnet-App", "CryptoNova-App", "CryptoNova-Mainnet-App"];
function findIndexHtml() {
  const roots = [];
  // walk up from ROOT looking for a dir that contains one of APP_DIRS
  let cur = ROOT;
  for (let i = 0; i < 8; i++) { roots.push(cur); cur = path.dirname(cur); }
  // plus whatever session mount we happen to be running under
  try {
    for (const s of fs.readdirSync("/sessions")) roots.push(path.join("/sessions", s, "mnt"));
  } catch (_) { /* not on a mounted session — fine */ }
  const envPath = process.env.FRONTEND_INDEX_HTML;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const r of roots) {
    for (const a of APP_DIRS) {
      const c = path.join(r, a, "index.html");
      if (fs.existsSync(c)) return c;
    }
  }
  return "";
}
const htmlFile = findIndexHtml();
let htmlTxt = htmlFile ? fs.readFileSync(htmlFile, "utf8") : "";
if (htmlFile) console.log(`  \u2139  frontend: ${htmlFile}`);
if (!htmlTxt) {
  fail("index.html NOT FOUND — every frontend parity check below was skipped. Set FRONTEND_INDEX_HTML=<path> or fix APP_DIRS.");
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
// 8. deploy_v8.js — v8.7 MATRIX_SIZE=127 + all 10 tiers
// ─────────────────────────────────────────────────────────────────────────────
sep("deploy_v8.js — v8.7 config (MATRIX_SIZE=127, all 10 tiers)");
if (deployText) {
  // Check MATRIX_SIZE default
  const msMatch = deployText.match(/MATRIX_SIZE\s*[=\|][^\n]*?"(\d+)"/);
  if (msMatch) {
    const ms = parseInt(msMatch[1], 10);
    if (ms === 127) ok(`MATRIX_SIZE default = 127 (correct)`);
    else            fail(`MATRIX_SIZE default = ${ms} — expected 127 for v8.7`);
  } else {
    // Looser check
    if (deployText.includes('"127"')) ok('MATRIX_SIZE uses "127" (found in script)');
    else fail('MATRIX_SIZE "127" not found in deploy_v8.js — expected for v8.7');
  }

  // Check DEPLOY_TIERS default
  const dtMatch = deployText.match(/DEPLOY_TIERS\s*[=\|][^\n]*?"([^"]+)"/);
  if (dtMatch) {
    const tiers = dtMatch[1].split(",").map(t => t.trim());
    if (tiers.length === 10 && tiers.includes("10")) {
      ok(`DEPLOY_TIERS = "${dtMatch[1]}" (all 10 tiers)`);
    } else {
      fail(`DEPLOY_TIERS = "${dtMatch[1]}" — expected "1,2,3,4,5,6,7,8,9,10" for v8.7`);
    }
  } else {
    if (deployText.includes('"1,2,3,4,5,6,7,8,9,10"')) ok('DEPLOY_TIERS uses "1,2,3,4,5,6,7,8,9,10" (found)');
    else fail('DEPLOY_TIERS "1,2,3,4,5,6,7,8,9,10" not found in deploy_v8.js');
  }

  // Check velocity gate closure logic is present
  if (deployText.includes("setTierVelocityGreen") && deployText.includes("CLOSED")) {
    ok("Velocity gate closure logic found in deploy_v8.js");
  } else {
    fail("Velocity gate closure (setTierVelocityGreen + CLOSED) not found in deploy_v8.js");
  }

  // Check deploy_v8.js writes to the CONFIGURED ADDRESSES_FILE (was a stale v8_43 hardcode).
  if (deployText.includes(ADDR_FILE)) {
    ok(`deploy_v8.js output file: ${ADDR_FILE}`);
  } else {
    fail(`deploy_v8.js does not output to ${ADDR_FILE} (set ADDRESSES_FILE in .env, align deploy_v8.js default)`);
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
sep("FigureEightMatrixV8.sol — v8.7 parked wallet features");
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
sep("StabilityFund.sol — v8.7 payForceCross");
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
sep("MatrixKeeper.sol — v8.7 work types");
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
// 13. deployed_addresses_v8_13.json — exists and has expected keys
// ─────────────────────────────────────────────────────────────────────────────
sep("deployed_addresses_v8_24.json — presence check");
{
  const addrFile = path.join(ROOT, "deployed_addresses_v8_24.json");
  if (!fs.existsSync(addrFile)) {
    console.log("  ℹ  deployed_addresses_v8_24.json not found — run deploy_v8.js first");
  } else {
    const addrData = JSON.parse(fs.readFileSync(addrFile, "utf8"));
    const required = ["tierRouter", "stabilityFund", "matrixKeeper"];
    for (const key of required) {
      if (addrData[key]) ok(`addresses: ${key} = ${addrData[key]}`);
      else               fail(`addresses: ${key} missing from deployed_addresses_v8_24.json`);
    }
    // Check tiers 1-7 present
    const tiers = addrData.tiers || {};
    const tierCount = Object.keys(tiers).length;
    if (tierCount >= 7) {
      ok(`addresses: ${tierCount} tiers registered (expected 10)`);
    } else if (tierCount > 0) {
      console.log(`  ℹ  addresses: ${tierCount}/10 tiers registered`);
    } else {
      fail("addresses: no tiers found — run deploy_v8.js with DEPLOY_TIERS=1,2,3,4,5,6,7,8,9,10");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. V8.10 — FigureEightMatrixV8.sol security patches
// ─────────────────────────────────────────────────────────────────────────────
sep("FigureEightMatrixV8.sol — V8.10 security patches");
if (matTxt) {
  // evictParked function
  if (matTxt.includes("function evictParked(")) {
    ok("evictParked() found — grace-period eviction function present");
  } else {
    fail("evictParked() NOT found — add V8.10 grace-period eviction to FigureEightMatrixV8.sol");
  }

  // MemberEvicted event
  if (matTxt.includes("event MemberEvicted(")) {
    ok("event MemberEvicted declared");
  } else {
    fail("event MemberEvicted NOT found — add V8.10 event to FigureEightMatrixV8.sol");
  }

  // parkedAt mapping -- V8.21: lives inside MatrixState in MatrixLogicLib.sol
  // (no "public" keyword there since it's a struct field, not a top-level
  // contract storage var; the matrix contract exposes it via an explicit
  // parkedAt(address) getter instead). Accept either form.
  if (
    matTxt.includes("mapping(address => uint256) public parkedAt") ||
    matTxt.includes("function parkedAt(address") ||
    (libTxt && libTxt.includes("mapping(address => uint256) parkedAt"))
  ) {
    ok("parkedAt[] storage found — grace-period clock storage present");
  } else {
    fail("parkedAt[] storage NOT found — add V8.10 parkedAt storage (FigureEightMatrixV8.sol or MatrixLogicLib.sol)");
  }

  // totalWithdrawn in Member struct
  if (matTxt.includes("totalWithdrawn") || (libTxt && libTxt.includes("totalWithdrawn"))) {
    ok("totalWithdrawn field found in Member struct");
  } else {
    fail("totalWithdrawn NOT found — add V8.10 drain-tracking field to Member struct");
  }

  // Withdrawal reserve check in withdraw() -- V8.21: lives in
  // MatrixLogicLib.withdrawCore() now, not inline in FigureEightMatrixV8.sol.
  // V8.31: message updated to "must keep crossing reserve while active".
  const guardMsgOld = "must keep entry fee reserve while active";
  const guardMsgNew = "must keep crossing reserve while active";
  if (
    matTxt.includes(guardMsgOld) || matTxt.includes(guardMsgNew) ||
    (libTxt && (libTxt.includes(guardMsgOld) || libTxt.includes(guardMsgNew)))
  ) {
    ok("Withdrawal reserve guard found (withdraw()/withdrawCore())");
  } else {
    fail("Withdrawal reserve guard NOT found — add crossing reserve guard check to withdraw()/withdrawCore()");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. V8.10 — MatrixKeeper.sol grace-period + eviction
// ─────────────────────────────────────────────────────────────────────────────
sep("MatrixKeeper.sol — V8.10 grace-period eviction");
if (mkText) {
  if (mkText.includes("WORK_EVICT_PARKED")) {
    ok("WORK_EVICT_PARKED constant found");
  } else {
    fail("WORK_EVICT_PARKED NOT found — add constant = 6 to MatrixKeeper.sol");
  }

  if (mkText.includes("parkedGracePeriod")) {
    ok("parkedGracePeriod config variable found");
  } else {
    fail("parkedGracePeriod NOT found — add V8.10 grace period config to MatrixKeeper.sol");
  }

  // V8.11 ratio-based rescue removed in V8.12+ (SF covers rescues directly via payForceCross)
  // rescueRatioBps / rescueContributionBps no longer in MatrixKeeper.sol — check removed

  if (mkText.includes("_doEvictParked") || mkText.includes("doEvictParked")) {
    ok("_doEvictParked() handler found");
  } else {
    fail("_doEvictParked() NOT found — add V8.10 eviction handler to MatrixKeeper.sol");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. V8.10 — CNOVAToken.sol epoch rewards schedule
// ─────────────────────────────────────────────────────────────────────────────
sep("CNOVAToken.sol — V8.10 epoch rewards (50,40,20,10,5,2.5,...) ");
const cnovaTxt = read("contracts/CNOVAToken.sol");
if (cnovaTxt) {
  // Epoch 1 = 50 * 1e18 (must not still be 25*1e18 from old schedule)
  if (cnovaTxt.includes("50   * 1e18") || cnovaTxt.includes("50 * 1e18")) {
    ok("Epoch 1 reward = 50 CNOVA (Nebula Genesis super-bonus confirmed)");
  } else {
    fail("Epoch 1 reward not 50 CNOVA — check epochRewards[] in CNOVAToken.sol");
  }

  // Epoch 2 = 40 * 1e18
  if (cnovaTxt.includes("40   * 1e18") || cnovaTxt.includes("40 * 1e18")) {
    ok("Epoch 2 reward = 40 CNOVA (Mercury Rise confirmed)");
  } else {
    fail("Epoch 2 reward not 40 CNOVA — V8.10 schedule: 50,40,20,10,5,2.5,...");
  }

  // Final plateau = 25 * 1e17 (2.5 CNOVA)
  if (cnovaTxt.includes("25   * 1e17") || cnovaTxt.includes("25 * 1e17")) {
    ok("Epoch 6-9 plateau = 2.5 CNOVA confirmed (25 * 1e17)");
  } else {
    fail("Epoch plateau 25*1e17 not found — check epochRewards[5-8] in CNOVAToken.sol");
  }

  // MAX_SUPPLY = 21M
  if (cnovaTxt.includes("21_000_000")) {
    ok("MAX_SUPPLY = 21,000,000 CNOVA confirmed");
  } else {
    fail("MAX_SUPPLY 21_000_000 not found in CNOVAToken.sol");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. V8.12 — TierRouter.sol communityWallet hook + MatrixKeeper distributeReady
// ─────────────────────────────────────────────────────────────────────────────
sep("V8.12 — CommunityWallet integration checks");

const trText = read("contracts/TierRouter.sol");
if (trText) {
  if (trText.includes("setCommunityWallet") && trText.includes("enroll(msg.sender)")) {
    ok("TierRouter.sol: setCommunityWallet() setter + enroll() hook in register() found");
  } else {
    fail("TierRouter.sol: setCommunityWallet/enroll hook missing — V8.12 community enrollment patch not applied");
  }

  // V8.23: default referrer (W1 fallback)
  if (trText.includes("setDefaultReferrer") && trText.includes("defaultReferrer")) {
    ok("TierRouter.sol: setDefaultReferrer() + defaultReferrer fallback in register() found (V8.23)");
  } else {
    fail("TierRouter.sol: defaultReferrer feature missing — organic sign-ups won't credit W1 (V8.23 patch not applied)");
  }

  if (trText.includes("globalJoinedCount")) {
    ok("TierRouter.sol: globalJoinedCount counter found");
  } else {
    fail("TierRouter.sol: globalJoinedCount missing — needed for first-1000 Community Fund eligibility");
  }
}

if (mkText) {
  // V8.48 item 12a: the CW gate moved into MatrixKeeperLib with the rest of the scan.
  // Search BOTH files — the trigger still exists, it just no longer lives where this
  // check was looking. (This check caught the move, which is the point of it.)
  const mkScanText = mkText + read("contracts/MatrixKeeperLib.sol");
  if (mkScanText.includes("WORK_DISTRIBUTE_CW") && mkScanText.includes("distributeReady")) {
    ok("MatrixKeeper.sol: WORK_DISTRIBUTE_CW + distributeReady() check found in checkUpkeep()");
  } else {
    fail("MatrixKeeper.sol: WORK_DISTRIBUTE_CW/distributeReady missing — monthly CW distribution won't trigger via Chainlink");
  }

  if (mkText.includes("setCommunityWallet")) {
    ok("MatrixKeeper.sol: setCommunityWallet() setter found");
  } else {
    fail("MatrixKeeper.sol: setCommunityWallet() setter missing — add V8.12 setter");
  }
}

const deployTxt = read("scripts/deploy_v8.js");
if (deployTxt) {
  if (deployTxt.includes("tierRouter.setCommunityWallet(cwAddr)")) {
    ok("deploy_v8.js: tierRouter.setCommunityWallet(cwAddr) call found — enroll hook will be active");
  } else {
    fail("deploy_v8.js: tierRouter.setCommunityWallet(cwAddr) MISSING — enroll() hook will stay dormant");
  }

  if (deployTxt.includes("keeper.setCommunityWallet(cwAddr)")) {
    ok("deploy_v8.js: keeper.setCommunityWallet(cwAddr) call found — Chainlink CW trigger active");
  } else {
    fail("deploy_v8.js: keeper.setCommunityWallet(cwAddr) MISSING — monthly distribution won't auto-trigger");
  }

  // V8.23: setDefaultReferrer must be called after W1 seeds
  if (deployTxt.includes("tierRouter.setDefaultReferrer(W1_ADDR)")) {
    ok("deploy_v8.js: tierRouter.setDefaultReferrer(W1_ADDR) call found (V8.23) — organic sign-ups will credit W1");
  } else {
    fail("deploy_v8.js: tierRouter.setDefaultReferrer(W1_ADDR) MISSING — sign-ups without referral link won't credit W1 (L1 chain-pay lost)");
  }

  // V8.15: setTierMatrices must be called after registerTier for manualUpgrade to work
  if (deployTxt.includes("tierRouter.setTierMatrices(")) {
    ok("deploy_v8.js: tierRouter.setTierMatrices() call found — tierMatrixAAddr/tierMatrixBAddr will be set (required by manualUpgrade)");
  } else {
    fail("deploy_v8.js: tierRouter.setTierMatrices() MISSING — manualUpgrade will always revert 'cross to MatB first' because tierMatrixBAddr stays address(0)");
  }

  // V8.19/V8.22: 10-field SplitConfig — verify BPS arrays sum to 10000.
  // V8.31: all tiers unified into SPLITS_ALL + CHAIN_PAY_ALL (Option B uniform).
  // Earlier versions used per-band arrays (SPLITS_T1_T3 etc.). Accept either.
  function parseBpsArray(label) {
    const re = new RegExp(`const\\s+${label}\\s*=\\s*\\[([^\\]]+)\\]`);
    const m = deployTxt.match(re);
    if (!m) return null;
    const nums = m[1].split(",").map(s => s.trim()).filter(Boolean).map(Number);
    return nums.some(Number.isNaN) ? null : nums;
  }

  const splitsAll    = parseBpsArray("SPLITS_ALL");
  const chainPayAll  = parseBpsArray("CHAIN_PAY_ALL");
  const isUnifiedBps = !!splitsAll;

  if (isUnifiedBps) {
    // V8.31+ unified model: one array for all tiers
    if (splitsAll.length !== 10) {
      fail(`deploy_v8.js: SPLITS_ALL has ${splitsAll.length} fields, expected 10 — [${splitsAll.join(",")}]`);
    } else {
      const sum = splitsAll.reduce((a, b) => a + b, 0);
      // V8.32: CROSSING_RESERVE_BPS (5000) + DIRECT_EARN_BPS (250) are contract constants,
      // so SPLITS_ALL covers only the remaining 4750 BPS.  Accept either 10000 (pre-V8.32)
      // or 4750 (V8.32+).
      if (sum === 10000) ok(`deploy_v8.js: SPLITS_ALL sums to 10000 BPS (V8.31 unified) — [${splitsAll.join(",")}]`);
      else if (sum === 4750) ok(`deploy_v8.js: SPLITS_ALL sums to 4750 BPS (V8.32 — crossing reserve + direct earn handled by contract constants) — [${splitsAll.join(",")}]`);
      else               fail(`deploy_v8.js: SPLITS_ALL sums to ${sum} BPS, expected 4750 (V8.32) or 10000 (pre-V8.32) — [${splitsAll.join(",")}]`);
    }
    if (!chainPayAll) {
      fail("deploy_v8.js: CHAIN_PAY_ALL array not found — cannot verify chain-pay sum");
    } else if (chainPayAll.length !== 6) {
      fail(`deploy_v8.js: CHAIN_PAY_ALL has ${chainPayAll.length} levels, expected 6 — [${chainPayAll.join(",")}]`);
    } else {
      const cpSum    = chainPayAll.reduce((a, b) => a + b, 0);
      const chainBps = splitsAll ? splitsAll[1] : null;
      if (chainBps != null && cpSum === chainBps) {
        ok(`deploy_v8.js: CHAIN_PAY_ALL sums to ${cpSum} BPS, matches SPLITS_ALL chainBps=${chainBps} (V8.31 unified)`);
      } else {
        fail(`deploy_v8.js: CHAIN_PAY_ALL sums to ${cpSum} BPS but SPLITS_ALL chainBps=${chainBps} — mismatch! [${chainPayAll.join(",")}]`);
      }
    }
  } else {
    // Legacy per-band model (V8.19-V8.30)
    const SPLIT_BANDS = ["SPLITS_T1_T3", "SPLITS_T4_T5", "SPLITS_T6_T7", "SPLITS_T8_T10"];
    const splitArrays = {};
    for (const band of SPLIT_BANDS) {
      const arr = parseBpsArray(band);
      splitArrays[band] = arr;
      if (!arr) {
        fail(`deploy_v8.js: ${band} array not found or unparseable — cannot verify BPS sum`);
        continue;
      }
      if (arr.length !== 10) {
        fail(`deploy_v8.js: ${band} has ${arr.length} fields, expected 10 (l1,chain,pool,treasury,sf,dev,ops,cw,bbr,lq) — [${arr.join(",")}]`);
        continue;
      }
      const sum = arr.reduce((a, b) => a + b, 0);
      if (sum === 10000) ok(`deploy_v8.js: ${band} sums to 10000 BPS — [${arr.join(",")}]`);
      else               fail(`deploy_v8.js: ${band} sums to ${sum} BPS, NOT 10000 — [${arr.join(",")}]`);
    }
    // chainBps is field index 1 in the 10-field SplitConfig array order above.
    const CHAIN_BANDS = [
      { name: "CHAIN_PAY_T1_T3",  splitBands: ["SPLITS_T1_T3"] },
      { name: "CHAIN_PAY_T4_T5",  splitBands: ["SPLITS_T4_T5"] },
      // T6-T7 and T8-T10 share the same 17.5% chain rate
      { name: "CHAIN_PAY_T6_T10", splitBands: ["SPLITS_T6_T7", "SPLITS_T8_T10"] },
    ];
    for (const { name, splitBands } of CHAIN_BANDS) {
      const arr = parseBpsArray(name);
      if (!arr) { fail(`deploy_v8.js: ${name} array not found or unparseable — cannot verify chain-pay sum`); continue; }
      if (arr.length !== 6) {
        fail(`deploy_v8.js: ${name} has ${arr.length} levels, expected 6 — [${arr.join(",")}]`);
        continue;
      }
      const sum = arr.reduce((a, b) => a + b, 0);
      for (const splitBand of splitBands) {
        const expected = splitArrays[splitBand] ? splitArrays[splitBand][1] : null;
        if (expected == null) {
          fail(`deploy_v8.js: cannot verify ${name} against ${splitBand} — chainBps unknown`);
        } else if (sum === expected) {
          ok(`deploy_v8.js: ${name} sums to ${sum} BPS, matches ${splitBand} chainBps=${expected}`);
        } else {
          fail(`deploy_v8.js: ${name} sums to ${sum} BPS but ${splitBand} chainBps=${expected} — mismatch! [${arr.join(",")}]`);
        }
      }
    }
  }

  // V8.19: liquidityReserve wiring in per-matrix loop
  if (deployTxt.includes("setLiquidityReserve(liquidityReserve)")) {
    ok("deploy_v8.js: setLiquidityReserve() wiring found — LQ carve will route to liquidityReserve");
  } else {
    fail("deploy_v8.js: setLiquidityReserve() MISSING from wiring loop — LQ USDC will fall back to devWallet");
  }

  // V8.19: CNOVADirectSale contract exists
  const directSaleTxt = read("contracts/CNOVADirectSale.sol");
  if (directSaleTxt && directSaleTxt.includes("function buyCNOVA(")) {
    ok("CNOVADirectSale.sol: buyCNOVA() found — investor purchase contract present (V8.19)");
  } else {
    fail("CNOVADirectSale.sol: MISSING or buyCNOVA() not found — investor purchase contract not deployed");
  }

  // V8.19: deploy_v8.js must actually deploy CNOVADirectSale and wire role grants
  // (the check above only confirms the .sol file exists — it doesn't mean deploy_v8.js
  // wires it up. This was missing entirely until 2026-06-20.)
  if (deployTxt.includes('getContractFactory("CNOVADirectSale"')) {
    ok("deploy_v8.js: CNOVADirectSale deploy step found");
  } else {
    fail("deploy_v8.js: CNOVADirectSale is never deployed — buy.html will have no contract to call");
  }
  // V8.23: mintDirect removed → mintForSale. directSale now needs DIRECT_SALE_ROLE, not MINTER_ROLE.
  if (deployTxt.includes("cnova.grantRole(DIRECT_SALE_ROLE, dsAddr)")) {
    ok("deploy_v8.js: DIRECT_SALE_ROLE grant to CNOVADirectSale found (V8.23)");
  } else {
    fail("deploy_v8.js: DIRECT_SALE_ROLE grant to CNOVADirectSale MISSING — buyCNOVA()/mintForSale() will revert on every purchase");
  }

  // V8.30: topUpAndCross MUST be absent (intentionally removed — replaced by selfRescue + coPayRescue pure SF loan)
  const matTxtV16 = read("contracts/FigureEightMatrixV8.sol");
  if (matTxtV16 && !matTxtV16.includes("function topUpAndCross(")) {
    ok("FigureEightMatrixV8.sol: topUpAndCross() confirmed absent — V8.30 removal OK");
  } else {
    fail("FigureEightMatrixV8.sol: topUpAndCross() still present — V8.30 removal incomplete");
  }

  // V8.30: selfRescue must be present
  if (matTxtV16 && matTxtV16.includes("function selfRescue(")) {
    ok("FigureEightMatrixV8.sol: selfRescue() found — member self-pay rescue active (V8.30)");
  } else {
    fail("FigureEightMatrixV8.sol: selfRescue() MISSING — V8.30 self-rescue not wired");
  }

  // V8.30: isInMatrix() must be present (fixes selector mismatch with MatrixKeeper)
  if (matTxtV16 && matTxtV16.includes("function isInMatrix(")) {
    ok("FigureEightMatrixV8.sol: isInMatrix() found — keeper selector mismatch fixed (V8.30)");
  } else {
    fail("FigureEightMatrixV8.sol: isInMatrix() MISSING — MatrixKeeper will flood reclaim tasks");
  }

  // V8.30: CouponRegistry must be in deploy script
  const deployTxtV30 = read("scripts/deploy_v8.js");
  if (deployTxtV30 && deployTxtV30.includes("CouponRegistry")) {
    ok("deploy_v8.js: CouponRegistry deploy step found (V8.30)");
  } else {
    fail("deploy_v8.js: CouponRegistry deploy step MISSING — coupon system won't deploy");
  }

  // V8.20: governance co-control must exist on all three target contracts, or
  // V8Governance.execute() reverts for every param except the 3 self-governed ones.
  const keeperTxtV20 = read("contracts/MatrixKeeper.sol");
  const trTxtV20      = read("contracts/TierRouter.sol");
  const f8v8TxtV20    = matTxtV16; // already read above
  const govTxtV20     = read("contracts/V8Governance.sol");

  if (keeperTxtV20 && keeperTxtV20.includes("function setGovernance(")) {
    ok("MatrixKeeper.sol: setGovernance() found — governance co-control wired (V8.20)");
  } else {
    fail("MatrixKeeper.sol: setGovernance() MISSING — governance proposals will revert on execute()");
  }
  if (trTxtV20 && trTxtV20.includes("function setGovernance(")) {
    ok("TierRouter.sol: setGovernance() found — governance co-control wired (V8.20)");
  } else {
    fail("TierRouter.sol: setGovernance() MISSING — governance proposals will revert on execute()");
  }
  // V8.21: governance field now lives inside the MatrixState struct
  // (_state.governance), not a bare top-level `governance` storage var.
  if (
    f8v8TxtV20 && (
      f8v8TxtV20.includes("msg.sender == governance") ||
      f8v8TxtV20.includes("msg.sender == _state.governance")
    )
  ) {
    ok("FigureEightMatrixV8.sol: governance check found on fee setter (V8.20)");
  } else {
    fail("FigureEightMatrixV8.sol: governance check MISSING on setWithdrawalFeeBps");
  }

  // V8.21: PARAM_EARLY_EXIT_PENALTY_BPS (id 10) was retired entirely -- the
  // field, setter, and getter were all removed from FigureEightMatrixV8.sol
  // because they were stored/DAO-votable but never consumed by any withdraw/
  // cycle logic. Guard against ever shipping a deploy where the dead function
  // somehow reappears (e.g. a bad merge) or where V8Governance still thinks
  // id 10 is a live target.
  if (f8v8TxtV20 && !f8v8TxtV20.includes("function setEarlyExitPenaltyBps(")) {
    ok("FigureEightMatrixV8.sol: setEarlyExitPenaltyBps() confirmed absent — param #10 stays retired (V8.21)");
  } else {
    fail("FigureEightMatrixV8.sol: setEarlyExitPenaltyBps() FOUND — param #10 was supposed to be retired in V8.21");
  }
  if (govTxtV20 && govTxtV20.includes("if (paramId == PARAM_EARLY_EXIT_PENALTY_BPS) revert")) {
    ok("V8Governance.sol: propose() permanently rejects retired PARAM_EARLY_EXIT_PENALTY_BPS (id 10)");
  } else {
    fail("V8Governance.sol: propose() does NOT reject PARAM_EARLY_EXIT_PENALTY_BPS — retired id 10 could still be proposed");
  }

  // V8.21: PARAM_WITHDRAWAL_FEE_BPS (id 9) targets PairManagerV8 (one per tier,
  // broadcasts to every pair it has ever added) instead of a single matrix
  // instance -- a tier can have multiple pairs via addPair() during
  // auto-expansion, and fees are stored per-instance, so a single-matrix
  // target would leave every other pair stale.
  const pmv8TxtV21 = read("contracts/PairManagerV8.sol");
  if (pmv8TxtV21 && pmv8TxtV21.includes("function setGovernance(") && pmv8TxtV21.includes("function setWithdrawalFeeBps(")) {
    ok("PairManagerV8.sol: setGovernance() + broadcast setWithdrawalFeeBps() found (V8.21 param #9 target fix)");
  } else {
    fail("PairManagerV8.sol: setGovernance() or broadcast setWithdrawalFeeBps() MISSING — param #9 proposals will revert");
  }
  if (deployTxt.includes("pm.setGovernance(govAddr)")) {
    ok("deploy_v8.js: per-tier PairManagerV8.setGovernance(govAddr) loop found (V8.21)");
  } else {
    fail("deploy_v8.js: per-tier PairManagerV8.setGovernance(govAddr) loop MISSING — param #9 proposals will revert with \"PM8: not authorized\"");
  }

  // V8.20: SF rescue ladder must be governable, not hardcoded.
  // V8.21: free-form setSfRescueLadder(uint256[],uint256[]) + proposeLadder()
  // were replaced by 4 curated presets -- setSfRescueLadderPreset(uint8) plus
  // a normal scalar PARAM_SF_RESCUE_LADDER proposal (no more bespoke
  // proposeLadder() path). This check was stale until now (still looking for
  // the pre-V8.21 names, so it always false-failed even though the preset
  // redesign — and its full governance lifecycle — was already shipped and
  // tested in test/V8Governance.test.js).
  if (keeperTxtV20 && keeperTxtV20.includes("function setSfRescueLadderPreset(")) {
    ok("MatrixKeeper.sol: setSfRescueLadderPreset() found — SF rescue ladder is governable via curated presets (V8.21)");
  } else {
    fail("MatrixKeeper.sol: setSfRescueLadderPreset() MISSING — SF rescue ladder still hardcoded");
  }
  if (govTxtV20 && govTxtV20.includes("PARAM_SF_RESCUE_LADDER")) {
    ok("V8Governance.sol: PARAM_SF_RESCUE_LADDER found (V8.21: normal scalar param, no bespoke proposeLadder())");
  } else {
    fail("V8Governance.sol: PARAM_SF_RESCUE_LADDER MISSING");
  }

  // V8.20: deploy_v8.js must actually wire setGovernance on all three contract types
  // (the checks above only confirm the .sol functions exist, not that deploy_v8.js calls them)
  if (deployTxt.includes("keeper.setGovernance(govAddr)")) {
    ok("deploy_v8.js: keeper.setGovernance(govAddr) wiring found");
  } else {
    fail("deploy_v8.js: keeper.setGovernance(govAddr) MISSING — MatrixKeeper governance proposals will revert");
  }
  if (deployTxt.includes("tierRouter.setGovernance(govAddr)")) {
    ok("deploy_v8.js: tierRouter.setGovernance(govAddr) wiring found");
  } else {
    fail("deploy_v8.js: tierRouter.setGovernance(govAddr) MISSING — TierRouter governance proposals will revert");
  }
  if (deployTxt.includes("mA.setGovernance(govAddr)") && deployTxt.includes("mB.setGovernance(govAddr)")) {
    ok("deploy_v8.js: per-matrix setGovernance(govAddr) loop found");
  } else {
    fail("deploy_v8.js: per-matrix setGovernance(govAddr) loop MISSING — fee-param governance proposals will revert");
  }

  // ── V8.20 second wave ──────────────────────────────────────────────────────
  // StabilityFund / CNOVABuybackReserve / CNOVADirectSale governance co-control,
  // CNOVAToken / CommunityWallet GOVERNOR_ROLE call path, and the ~24 new
  // V8Governance params + the second array-proposal path (boost table).
  const sfTxtV20  = read("contracts/StabilityFund.sol");
  const bbrTxtV20 = read("contracts/CNOVABuybackReserve.sol");
  const dsTxtV20  = read("contracts/CNOVADirectSale.sol");
  const cnovaTxtV20 = read("contracts/CNOVAToken.sol");
  const cwTxtV20    = read("contracts/CommunityWallet.sol");

  if (sfTxtV20 && sfTxtV20.includes("function setGovernance(")) {
    ok("StabilityFund.sol: setGovernance() found — governance co-control wired (V8.20)");
  } else {
    fail("StabilityFund.sol: setGovernance() MISSING — SF governance proposals will revert on execute()");
  }
  if (sfTxtV20 && sfTxtV20.includes("require(floor <= sfTarget")) {
    ok("StabilityFund.sol: setStabilityFloor() bounded to sfTarget (V8.20) — was unbounded before");
  } else {
    fail("StabilityFund.sol: setStabilityFloor() bound MISSING — floor could exceed target and brick all SF spends");
  }
  if (bbrTxtV20 && bbrTxtV20.includes("function setGovernance(")) {
    ok("CNOVABuybackReserve.sol: setGovernance() found — governance co-control wired (V8.20)");
  } else {
    fail("CNOVABuybackReserve.sol: setGovernance() MISSING — BBR governance proposals will revert on execute()");
  }
  if (dsTxtV20 && dsTxtV20.includes("function setGovernance(") &&
      dsTxtV20.includes("function setMaxTxBps(") && dsTxtV20.includes("function setMaxWalletBps(") &&
      dsTxtV20.includes("function setSfTargetDS(") && dsTxtV20.includes("function setLqTargetDS(")) {
    ok("CNOVADirectSale.sol: setGovernance() + granular cap/target setters found (V8.20)");
  } else {
    fail("CNOVADirectSale.sol: setGovernance() or granular setters MISSING — DS governance proposals will revert");
  }

  // V8Governance.sol: all 24 new scalar params + the boost-table array param
  if (govTxtV20 && govTxtV20.includes("PARAM_CW_DISTRIBUTION_DAY") &&
      govTxtV20.includes("PARAM_CNOVA_BOOST_TABLE") && govTxtV20.includes("function proposeBoostTable(")) {
    ok("V8Governance.sol: V8.20 second-wave params (15-39) + proposeBoostTable() found");
  } else {
    fail("V8Governance.sol: V8.20 second-wave params or proposeBoostTable() MISSING");
  }
  if (govTxtV20 && govTxtV20.includes("setAllowedValues(uint8 paramId") &&
      govTxtV20.includes("paramId > PARAM_MAX_ID") &&
      govTxtV20.includes("uint8 public constant PARAM_MAX_ID")) {
    ok("V8Governance.sol: setAllowedValues()/propose() upper bound updated to new max param (V8.22: PARAM_MAX_ID)");
  } else {
    fail("V8Governance.sol: setAllowedValues()/propose() upper bound NOT updated — new params would be unreachable or the old ceiling would reject them");
  }
  // V8.22: StabilityFund per-tier SF target multiplier -- 10 new PARAM_SF_MULT_T{n}
  // ids, each its own single-value governable setter (propose() can only carry
  // one uint256, so this couldn't be a single multi-arg setter like the
  // owner-only convenience function).
  if (govTxtV20 && govTxtV20.includes("PARAM_SF_MULT_T1") && govTxtV20.includes("PARAM_SF_MULT_T10") &&
      govTxtV20.includes("function setSfTargetMultiplierT1(uint256 v) external;") &&
      govTxtV20.includes("function setSfTargetMultiplierT10(uint256 v) external;")) {
    ok("V8Governance.sol: PARAM_SF_MULT_T1..T10 (V8.22 per-tier SF target multiplier) found");
  } else {
    fail("V8Governance.sol: PARAM_SF_MULT_T1..T10 MISSING — SF target multiplier governance proposals would revert");
  }
  if (sfTxtV20 && sfTxtV20.includes("function setSfTargetMultiplierT1(uint256 m)") &&
      sfTxtV20.includes("function setSfTargetMultiplierT10(uint256 m)") &&
      sfTxtV20.includes("onlyOwnerOrGovernance")) {
    ok("StabilityFund.sol: setSfTargetMultiplierT1..T10 found, onlyOwnerOrGovernance (V8.22)");
  } else {
    fail("StabilityFund.sol: setSfTargetMultiplierT1..T10 MISSING or not governance-callable — V8.22 redesign incomplete");
  }

  // CNOVAToken / CommunityWallet: GOVERNOR_ROLE was already role-gated on these
  // setters since V8.8/V8.9, but V8Governance never had a call path or (for
  // CommunityWallet) the role grant at all until V8.20.
  if (cnovaTxtV20 && cnovaTxtV20.includes("function setBoostTable(")) {
    ok("CNOVAToken.sol: setBoostTable() confirmed present (GOVERNOR_ROLE, pre-existing)");
  } else {
    fail("CNOVAToken.sol: setBoostTable() MISSING — PARAM_CNOVA_BOOST_TABLE has no target function");
  }
  if (cwTxtV20 && cwTxtV20.includes("function setGenesisBps(") && cwTxtV20.includes("function setDistributeRatio(") &&
      cwTxtV20.includes("function setDistributionDayOfMonth(")) {
    ok("CommunityWallet.sol: GOVERNOR_ROLE setters confirmed present (pre-existing)");
  } else {
    fail("CommunityWallet.sol: GOVERNOR_ROLE setters MISSING");
  }

  // deploy_v8.js: setGovernance wiring for the three new targets + the two new role grants
  if (deployTxt.includes("stabilityFund.setGovernance(govAddr)")) {
    ok("deploy_v8.js: stabilityFund.setGovernance(govAddr) wiring found");
  } else {
    fail("deploy_v8.js: stabilityFund.setGovernance(govAddr) MISSING — SF governance proposals will revert");
  }
  if (deployTxt.includes("buybackReserve.setGovernance(govAddr)")) {
    ok("deploy_v8.js: buybackReserve.setGovernance(govAddr) wiring found");
  } else {
    fail("deploy_v8.js: buybackReserve.setGovernance(govAddr) MISSING — BBR governance proposals will revert");
  }
  if (deployTxt.includes("directSale.setGovernance(govAddr)")) {
    ok("deploy_v8.js: directSale.setGovernance(govAddr) wiring found");
  } else {
    fail("deploy_v8.js: directSale.setGovernance(govAddr) MISSING — DS governance proposals will revert");
  }
  if (deployTxt.includes("cw.grantRole(CW_GOVERNOR_ROLE, govAddr)")) {
    ok("deploy_v8.js: CommunityWallet GOVERNOR_ROLE grant to V8Governance found");
  } else {
    fail("deploy_v8.js: CommunityWallet GOVERNOR_ROLE grant MISSING — CW governance proposals will revert (role never granted)");
  }
  if (deployTxt.includes("cnova.grantRole(GOVERNOR_ROLE, govAddr)")) {
    ok("deploy_v8.js: CNOVAToken GOVERNOR_ROLE grant to V8Governance found");
  } else {
    fail("deploy_v8.js: CNOVAToken GOVERNOR_ROLE grant MISSING — CNOVA governance proposals will revert (role never granted)");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. V8.48 — CommunityWallet calendar distribution (the 25th of every month)
// ─────────────────────────────────────────────────────────────────────────────
// distributeInterval was a ROLLING 30-day window: each distribution pushed the
// next one 30 days out from whenever the keeper happened to fire, so the date
// drifted every month and never landed on the 25th. V8.48 replaces it with real
// civil-calendar arithmetic. These checks exist because a partial revert of that
// change compiles cleanly and only shows up as a wrong date to members.
sep("V8.48 — CommunityWallet monthly calendar");
{
  const cwTxt   = read("contracts/CommunityWallet.sol");
  const govTxt  = read("contracts/V8Governance.sol");
  const mkTxt   = read("contracts/MatrixKeeper.sol");

  if (cwTxt && !/\bdistributeInterval\b/.test(stripComments(cwTxt))) {
    ok("CommunityWallet.sol: distributeInterval fully removed (no code references outside comments)");
  } else {
    fail("CommunityWallet.sol: distributeInterval still referenced in CODE — the rolling window is back, dates will drift off the 25th");
  }
  if (cwTxt && cwTxt.includes("uint8 public distributionDayOfMonth") &&
      cwTxt.includes("function setDistributionDayOfMonth(")) {
    ok("CommunityWallet.sol: distributionDayOfMonth + governor setter present");
  } else {
    fail("CommunityWallet.sol: distributionDayOfMonth / setDistributionDayOfMonth MISSING");
  }
  if (cwTxt && cwTxt.includes("function nextDistributionTime()") && cwTxt.includes("public view")) {
    ok("CommunityWallet.sol: nextDistributionTime() is public (single source of truth for the frontend)");
  } else {
    fail("CommunityWallet.sol: nextDistributionTime() MISSING or not public — frontend countdown has nothing to read");
  }
  if (cwTxt && cwTxt.includes("_civil(") && cwTxt.includes("_fromCivil(")) {
    ok("CommunityWallet.sol: civil-date helpers (_civil/_fromCivil) present");
  } else {
    fail("CommunityWallet.sol: _civil/_fromCivil MISSING — no calendar arithmetic, distribution cannot land on a fixed date");
  }
  if (cwTxt && cwTxt.includes("lastDistributionMonth") &&
      cwTxt.includes('"CW: already distributed this month"')) {
    ok("CommunityWallet.sol: once-per-month guard (lastDistributionMonth) present");
  } else {
    fail("CommunityWallet.sol: once-per-month guard MISSING — distribute() could fire repeatedly after the 25th");
  }
  // The day cap is what keeps February from silently skipping a month.
  if (cwTxt && cwTxt.includes('require(day >= 1 && day <= 28')) {
    ok("CommunityWallet.sol: distribution day capped at 28 (the date exists in February)");
  } else {
    fail("CommunityWallet.sol: day cap of 28 MISSING — a day of 29-31 would skip short months entirely");
  }
  // Governance param 39 was repointed; the old target no longer exists, so a
  // stale route here compiles but reverts when a passed proposal is executed.
  if (govTxt && govTxt.includes("PARAM_CW_DISTRIBUTION_DAY") &&
      govTxt.includes("setDistributionDayOfMonth(uint8(value))") &&
      !govTxt.includes("t.setDistributeInterval(value)")) {
    ok("V8Governance.sol: param 39 repointed to setDistributionDayOfMonth (V8.48)");
  } else {
    fail("V8Governance.sol: param 39 still routes to the DELETED setDistributeInterval — a passed proposal would revert on execute");
  }
  // V8.48 item 12a moved this gate into MatrixKeeperLib along with the rest of the scan.
  const keeperScan = (mkTxt || "") + read("contracts/MatrixKeeperLib.sol");
  if (keeperScan.includes("distributeReady()")) {
    ok("keeper: still gates on distributeReady() (now calendar-based, in MatrixKeeperLib)");
  } else {
    fail("keeper: distributeReady() gate MISSING from BOTH MatrixKeeper.sol and MatrixKeeperLib.sol — monthly distribution won't auto-trigger");
  }
  // Frontend parity, the harder kind: the cohort split is PROSE in index.html. On
  // 2026-08-10 one panel said Genesis 60% and another said 65%, against a contract
  // default of 6000 bps. Nothing catches a wrong number in a sentence except a check
  // that reads both and compares them.
  if (cwTxt && htmlTxt) {
    const bpsM = cwTxt.match(/genesisBps\s*=\s*([\d_]+)\s*;/);
    if (!bpsM) {
      fail("CommunityWallet.sol: could not read the genesisBps default — cohort-split parity is unverified");
    } else {
      const gPct = Number(bpsM[1].replace(/_/g, "")) / 100;
      const pPct = 100 - gPct;
      // Every percentage the page attributes to Genesis, wherever it is phrased.
      const claims = [];
      const pats = [
        /Genesis[^.<]{0,40}\(#1[\u2013-]500\)[^%]{0,60}?(\d{1,3})%/g,
        /Genesis Members<\/strong>\s*\(#1[\u2013-]500\)[\s\S]{0,80}?<strong>(\d{1,3})%<\/strong>/g,
      ];
      for (const re of pats) { let m; while ((m = re.exec(htmlTxt)) !== null) claims.push(Number(m[1])); }
      if (claims.length === 0) {
        console.log("  \u2139  index.html: no Genesis cohort percentage found in prose — nothing to compare");
      } else if (claims.every((c) => c === gPct)) {
        ok(`index.html: every Genesis cohort claim says ${gPct}% and matches genesisBps (${claims.length} place(s))`);
      } else {
        fail(`index.html: Genesis cohort prose says ${[...new Set(claims)].join("% / ")}% but the contract pays ${gPct}% (Pioneer ${pPct}%) \u2014 members are reading a number the contract does not honour`);
      }
    }
  }

  // Frontend parity: the countdown must read the contract's own next date, not
  // recompute an interval client-side.
  if (htmlTxt) {
    if (htmlTxt.includes("nextDistributionTime")) {
      ok("index.html: reads nextDistributionTime() (code<->frontend parity)");
    } else {
      fail("index.html: does NOT read nextDistributionTime() — the member-facing date is not the contract's date");
    }
    // V8.48 (2026-08-13): the countdown FEATURE-DETECTS across the V8.47→V8.48
    // cutover — nextDistributionTime() first, else distributeInterval() (the
    // V8.47 truth), else an honest "schedule unavailable". That fallback is
    // OWNER-ACCEPTED until the V8.48 deploy lands and is null-guarded, so a
    // guarded call is transitional, not a failure. A call WITHOUT `.catch(() =>
    // null)` on the same statement is still a hard fail — that is the fabricated
    // -fallback class this check was written for.
    {
      const stripped = stripComments(htmlTxt);
      const calls = [...stripped.matchAll(/distributeInterval\s*\(\s*\)/g)]
        // skip the ABI declaration line ('function distributeInterval() …')
        .filter((m) => !/function\s*$/.test(stripped.slice(Math.max(0, m.index - 20), m.index)));
      const unguarded = calls.filter((m) =>
        !/\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/.test(stripped.slice(m.index, m.index + 160)));
      if (unguarded.length > 0) {
        fail(`index.html: ${unguarded.length} distributeInterval() call(s) WITHOUT a null-catch — on V8.48 that read reverts and the countdown wears a fabricated value`);
      } else if (calls.length > 0) {
        console.log(`  ℹ  index.html: ${calls.length} null-guarded distributeInterval() call (V8.47 fallback) — REMOVE with its ABI line after the V8.48 cutover`);
      } else {
        ok("index.html: no distributeInterval() call remains (post-cutover state)");
      }
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 19. V8.48 item 12a — MatrixKeeperLib extraction + library linkage
// ─────────────────────────────────────────────────────────────────────────────
// A keeper deployed WITHOUT its library linked does not fail loudly: every
// checkUpkeep reverts, Chainlink reads that as "no work", and the whole automation
// layer goes quiet with nothing in any log to say so. These checks exist because
// that failure is silent by nature.
sep("V8.48 item 12a — MatrixKeeperLib");
{
  const libTxt    = read("contracts/MatrixKeeperLib.sol");
  const mkTxt12a  = read("contracts/MatrixKeeper.sol");

  if (libTxt && libTxt.includes("library MatrixKeeperLib") && libTxt.includes("function discover(")) {
    ok("MatrixKeeperLib.sol: library present with discover()");
  } else {
    fail("MatrixKeeperLib.sol: MISSING or has no discover() — the extraction is incomplete");
  }
  // external/public, NOT internal: an internal library function is INLINED back into the
  // caller and buys exactly zero bytes. This is the check that the extraction is real.
  if (libTxt && /function\s+discover\s*\([\s\S]{0,400}?\bexternal\b/.test(libTxt)) {
    ok("MatrixKeeperLib.discover() is external (delegatecall — code lives in the library)");
  } else {
    fail("MatrixKeeperLib.discover() is not external — an internal library function is inlined back into MatrixKeeper and frees NO bytecode");
  }
  if (mkTxt12a && mkTxt12a.includes('import "./MatrixKeeperLib.sol"') &&
      mkTxt12a.includes("MatrixKeeperLib.discover(cfg, lastGhostTime)")) {
    ok("MatrixKeeper.sol: checkUpkeep delegates to MatrixKeeperLib.discover()");
  } else {
    fail("MatrixKeeper.sol: checkUpkeep does not call MatrixKeeperLib.discover() — the scan is still inline");
  }
  // The snapshot must carry all sixteen ScanCfg fields. A missing one is a compile
  // error, but a field assigned to the WRONG source compiles fine — that is what
  // V8_48_KeeperScan.test.js's mutation probe is for. Here we only check it is built.
  const missing = ["idleSlotTimeout:", "extendedIdleTimeout:", "parkedGracePeriod:",
                   "rescueRatioBps:", "frozenMatBTimeout:", "sfThresholds:", "sfLadder:",
                   "pairManagers:", "links:"]
    .filter((f) => !(mkTxt12a && mkTxt12a.includes(f)));
  if (missing.length === 0) {
    ok("MatrixKeeper.sol: ScanCfg snapshot assigns every scan input");
  } else {
    fail(`MatrixKeeper.sol: ScanCfg snapshot is missing ${missing.join(" ")} — checkUpkeep would read a zero for each`);
  }

  if (deployTxt.includes('getContractFactory("MatrixKeeperLib"') &&
      deployTxt.includes("libraries: { MatrixKeeperLib: keeperLibAddr }")) {
    ok("deploy_v8.js: MatrixKeeperLib deployed and LINKED into MatrixKeeper");
  } else {
    fail("deploy_v8.js: MatrixKeeperLib not deployed/linked — every checkUpkeep would revert and Chainlink would silently do nothing");
  }
  // Linked-library addresses are required to verify on Basescan and are otherwise
  // unrecoverable after the deploy transcript scrolls away.
  if (deployTxt.includes("MatrixKeeperLib: keeperLibAddr") &&
      deployTxt.includes("MatrixLogicLib:  matrixLibAddr") &&
      deployTxt.includes("TierRouterLib:   trLibAddr")) {
    ok("deploy_v8.js: all three linked-library addresses are written to the addresses file");
  } else {
    fail("deploy_v8.js: linked-library addresses are NOT saved — Basescan verification of the linked contracts will need them and they are not recoverable later");
  }
  // The frozen reference copy is test-only. If it ever reaches a deploy script the
  // 24kB pre-refactor keeper ships to mainnet alongside the real one.
  if (deployTxt.includes("MatrixKeeperPrev")) {
    fail("deploy_v8.js references MatrixKeeperPrev — that is a TEST-ONLY frozen copy and must never be deployed");
  } else {
    ok("MatrixKeeperPrev stays out of the deploy path (test-only frozen reference)");
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 20. V8.48 item 12 — grace applies to LOANS, not to a member's own money
// ─────────────────────────────────────────────────────────────────────────────
// A self-funded rescue costs the Stability Fund nothing, so parkedGracePeriod (24h
// live) must not apply to it. Collapsing this back to one window is invisible: the
// contract keeps working, members just wait a day for money already theirs and are
// then given a loan they never needed, because the copay path does not re-check
// self-funding after the wait.
sep("V8.48 item 12 — split grace (self-funded vs loan)");
{
  const libTxt12 = read("contracts/MatrixKeeperLib.sol");
  const mkTxt12  = read("contracts/MatrixKeeper.sol");

  if (mkTxt12 && mkTxt12.includes("uint256 public selfFundedGracePeriod") &&
      mkTxt12.includes("function setSelfFundedGracePeriod(")) {
    ok("MatrixKeeper.sol: selfFundedGracePeriod + governed setter present");
  } else {
    fail("MatrixKeeper.sol: selfFundedGracePeriod MISSING — self-funded members wait the full loan window");
  }
  if (mkTxt12 && mkTxt12.includes("selfFundedGracePeriod: selfFundedGracePeriod")) {
    ok("MatrixKeeper.sol: selfFundedGracePeriod reaches the ScanCfg snapshot");
  } else {
    fail("MatrixKeeper.sol: selfFundedGracePeriod NOT in the ScanCfg snapshot — the library would read zero, making every self-funded rescue instant");
  }
  // The whole change is this ternary. Without it the field exists and does nothing.
  if (libTxt12 && /sfShare == 0 \? cfg\.selfFundedGracePeriod : cfg\.parkedGracePeriod/.test(libTxt12)) {
    ok("MatrixKeeperLib.sol: grace is chosen by sfShare (zero-cost rescue vs loan)");
  } else {
    fail("MatrixKeeperLib.sol: the sfShare-based grace choice is GONE — one window governs both again, which is the defect item 12 fixed");
  }
  // Eviction must NOT get the short window.
  if (libTxt12 && /if \(evict\) \{[\s\S]{0,200}?age < cfg\.parkedGracePeriod/.test(libTxt12)) {
    ok("MatrixKeeperLib.sol: eviction still waits the FULL parkedGracePeriod");
  } else {
    fail("MatrixKeeperLib.sol: eviction is not gated on parkedGracePeriod — evicting a member early is not a zero-cost action");
  }
  if (mkTxt12 && mkTxt12.includes("v == 0 || v == 60 || v == 300 || v == 900 || v == 1800 || v == 3600")) {
    ok("MatrixKeeper.sol: selfFundedGracePeriod is enumerated and capped at 1h");
  } else {
    fail("MatrixKeeper.sol: selfFundedGracePeriod is not enumerated — a long value silently turns it back into a second loan window");
  }
  // The keepers stay ON as backup (owner decision 2026-08-11). Flag if that changes
  // without the on-chain path having been observed to agree.
  ok("NOTE: fastlane_rescue.js + copay_rescue.js remain LIVE as backup by owner decision — retire only after on-chain discovery is observed doing the same work");
}


// ─────────────────────────────────────────────────────────────────────────────
// V8.48 items 7 + 13 — member tracker: joinedAt exists AND the deploy wires it
// ─────────────────────────────────────────────────────────────────────────────
// Two halves that are useless apart: PairManagerV8.memberJoinedAt (the penalty
// ladder's clock, and totalMembers() = unique PEOPLE for the Universe Mode gate)
// and deploy_v8.js calling treasury.setMemberTracker(T1 pm). The setter was never
// called in any deploy before V8.48 — earlyExitPenaltyBps read 0 for everyone and
// setFreeMode reverted. A deploy that ships one half without the other recreates
// exactly that, silently.
sep("V8.48 items 7+13 — treasury member tracker wiring");
{
  const pmTxt7 = read("contracts/PairManagerV8.sol");
  if (pmTxt7 && pmTxt7.includes("mapping(address => uint256) public memberJoinedAt") &&
      pmTxt7.includes("function _recordJoin(")) {
    ok("PairManagerV8: memberJoinedAt mapping + _recordJoin present");
  } else {
    fail("PairManagerV8: memberJoinedAt/_recordJoin MISSING — earlyExitPenaltyBps reads 0 for everyone");
  }
  if (pmTxt7 && /function totalMembers\(\)[^}]*return uniqueMembers/.test(pmTxt7)) {
    ok("PairManagerV8: totalMembers() returns uniqueMembers (PEOPLE, not entries — the Universe gate depends on this)");
  } else {
    fail("PairManagerV8: totalMembers() does not return uniqueMembers — the 500-member Universe gate would count entry churn (~41x inflation, the item-42 class)");
  }
  // Every totalRegistrations increment must have a _recordJoin beside it, or some
  // path's members never get a joinedAt (their penalty clock never starts).
  const incs7  = (pmTxt7.match(/totalRegistrations\s+\+= 1;/g) || []).length;
  const joins7 = (pmTxt7.match(/_recordJoin\(/g) || []).length - 1; // minus the definition
  if (incs7 > 0 && joins7 >= incs7) {
    ok(`PairManagerV8: _recordJoin at all ${incs7} routing sites`);
  } else {
    fail(`PairManagerV8: ${joins7} _recordJoin call(s) for ${incs7} routing increments — a path is missing its joinedAt stamp`);
  }
  if (deployTxt.includes("treasury.setMemberTracker(pmAddr)")) {
    ok("deploy_v8.js: treasury.setMemberTracker(T1 PairManager) wired (item 13 — never called before V8.48)");
  } else {
    fail("deploy_v8.js: setMemberTracker NOT called — earlyExitPenaltyBps returns 0 and setFreeMode reverts, the exact pre-V8.48 state");
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 20. V8.48 item 38 — frontend ABI ↔ contract surface (the mechanical half of
//     PARITY_AUDIT.md). Every `function`/`event` the frontend DECLARES in a
//     human-readable ABI string must exist in the V8.48 contract tree. This is
//     the item-30 class: routeEntryThreshold was deleted from the contract, the
//     frontend kept declaring and calling it behind a `.catch(() => 381n)`, and
//     members were shown a threshold that existed nowhere. Nothing but a
//     cross-read catches that, because the swallowed revert looks like a value.
//     For events we also compare the INDEXED layout — the 2026-07-29
//     MemberRegistered bug was an event that existed but was declared with the
//     wrong params indexed, so filters silently matched nothing.
// ─────────────────────────────────────────────────────────────────────────────
sep("item 38 — frontend ABI ↔ contract surface");
if (!htmlTxt) {
  fail("item 38 ABI check SKIPPED — index.html not found (see above)");
} else {
  // 1. Build the contract surface from every top-level .sol (test/ mocks are
  //    not deployed and must not satisfy a frontend reference).
  const CONTRACTS_DIR = path.join(ROOT, "contracts");
  const surfaceFns    = new Set();   // external/public functions + public var getters
  const surfaceEvents = {};          // name -> [ [indexedFlagPerParam, ...], ... ]
  const solFiles = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"));
  for (const f of solFiles) {
    const txt = stripComments(fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8"));
    // functions with external/public visibility
    for (const m of txt.matchAll(/function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)[^;{]*?\b(external|public)\b/g)) {
      surfaceFns.add(m[1]);
    }
    // public state variables (auto-getters), incl. constant/immutable/override
    for (const m of txt.matchAll(/\bpublic\s+(?:constant\s+|immutable\s+|override\s+)*([A-Za-z_]\w*)\s*(?:=|;)/g)) {
      surfaceFns.add(m[1]);
    }
    // events, with per-param indexed layout
    for (const m of txt.matchAll(/event\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
      const layout = m[2].trim() === "" ? [] :
        m[2].split(",").map((p) => /\bindexed\b/.test(p));
      (surfaceEvents[m[1]] = surfaceEvents[m[1]] || []).push(layout);
    }
  }
  if (surfaceFns.size < 100) {
    fail(`item 38: contract surface implausibly small (${surfaceFns.size} names) — parser broke, treat every result below as unverified`);
  }

  // 2. Names the frontend legitimately declares that live OUTSIDE this repo.
  const EXTERNAL_OK = new Set([
    // ERC20 + EIP-2612 (USDC)
    "name", "symbol", "decimals", "totalSupply", "balanceOf", "transfer",
    "approve", "allowance", "transferFrom", "permit", "nonces",
    "DOMAIN_SEPARATOR", "version", "Transfer", "Approval",
    // Multicall3
    "aggregate", "aggregate3", "tryAggregate", "blockAndAggregate",
  ]);
  // Known V8.47-only fallback, feature-detected in index.html and scheduled for
  // removal AFTER the V8.48 cutover (handoff NEXT UP). Warn, don't fail — check
  // 18 already fails on a live CALL to it once the cutover lands.
  const TRANSITION_OK = new Set(["distributeInterval"]);

  // 3. Every function/event the frontend declares in a human-readable ABI string.
  const missing = [];
  const transitional = [];
  let declared = 0;
  // NOTE the [ \t]* (not \s*): the quote must open the ABI string on the SAME
  // line as the keyword. With \s*, a comment ending in 'B' two blank lines above
  // a plain `function selectMatrix(…)` definition matched as an ABI declaration
  // — found and fixed during the first dry-run of this check, 2026-08-13.
  for (const m of htmlTxt.matchAll(/["'`][ \t]*(function|event)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
    const kind = m[1], nm = m[2];
    declared++;
    if (kind === "function") {
      if (surfaceFns.has(nm) || EXTERNAL_OK.has(nm)) continue;
      if (TRANSITION_OK.has(nm)) { transitional.push(nm); continue; }
      missing.push(`function ${nm}`);
    } else {
      if (EXTERNAL_OK.has(nm)) continue;
      const decls = surfaceEvents[nm];
      if (!decls) { missing.push(`event ${nm}`); continue; }
      const layout = m[3].trim() === "" ? [] :
        m[3].split(",").map((p) => /\bindexed\b/.test(p));
      const matches = decls.some((d) =>
        d.length === layout.length && d.every((v, i) => v === layout[i]));
      if (!matches) {
        missing.push(`event ${nm} — indexed layout [${layout.join(",")}] matches no contract declaration (contract: ${decls.map((d) => `[${d.join(",")}]`).join(" / ")})`);
      }
    }
  }
  if (declared === 0) {
    fail("item 38: found NO ABI declarations in index.html — parser broke or the ABI style changed; the check verified nothing");
  } else if (missing.length === 0) {
    ok(`index.html: all ${declared} ABI declarations exist in the V8.48 contracts (${solFiles.length} files, ${surfaceFns.size} surface names)`);
    for (const t of [...new Set(transitional)]) {
      console.log(`  ℹ  transitional: '${t}' declared for the V8.47 fallback — REMOVE after the V8.48 cutover`);
    }
  } else {
    for (const miss of [...new Set(missing)]) {
      fail(`index.html declares ${miss} — absent from every V8.48 contract. Members will see a swallowed revert wearing a value (item-30 class).`);
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
