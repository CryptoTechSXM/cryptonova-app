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

const ADDR_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_24.json";
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
// V8.21: _credit() moved into MatrixLogicLib.sol along with the rest of the
// core logic -- check there if it's not found inline in the matrix contract.
const libTxt = read("contracts/MatrixLogicLib.sol");
const creditSourceTxt = (matTxt && matTxt.includes("function _credit(")) ? matTxt : libTxt;
const creditSourceLabel = (matTxt && matTxt.includes("function _credit(")) ? "FigureEightMatrixV8.sol" : "MatrixLogicLib.sol";
if (creditSourceTxt) {
  // Find the _credit function body
  const creditMatch = creditSourceTxt.match(/function _credit\b[\s\S]*?^    \}/m);
  if (!creditMatch) {
    // Try a looser match
    const idx = creditSourceTxt.indexOf("function _credit(");
    if (idx === -1) {
      fail(`Could not find _credit() function in FigureEightMatrixV8.sol or MatrixLogicLib.sol`);
    } else {
      // Look at the next 30 lines after _credit
      const snippet = creditSourceTxt.substring(idx, idx + 1500);
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

  // Check ADDRESSES_FILE default is v8_24
  if (deployText.includes("deployed_addresses_v8_24.json")) {
    ok("deploy_v8.js output file: deployed_addresses_v8_24.json");
  } else {
    fail("deploy_v8.js does not output to deployed_addresses_v8_24.json");
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
  if (
    matTxt.includes("must keep entry fee reserve while active") ||
    (libTxt && libTxt.includes("must keep entry fee reserve while active"))
  ) {
    ok("Withdrawal reserve guard found (withdraw()/withdrawCore())");
  } else {
    fail("Withdrawal reserve guard NOT found — add 'must keep entry fee reserve while active' check to withdraw()/withdrawCore()");
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
  if (mkText.includes("WORK_DISTRIBUTE_CW") && mkText.includes("distributeReady")) {
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

  // V8.19/V8.22: 10-field SplitConfig — verify ALL FOUR tier-band arrays actually
  // sum to 10000 BPS, and that each CHAIN_PAY_* sub-split sums to its band's
  // chainBps. (Previously this only string-matched the T1-T3 array literal — it
  // never caught a bad edit to SPLITS_T4_T5/T6_T7/T8_T10. The on-chain
  // constructor's require(sum == 10000) would still block a bad deploy, but only
  // after spending gas and failing loudly mid-deploy — this catches it for free,
  // before any transaction is sent.)
  function parseBpsArray(label) {
    const re = new RegExp(`const\\s+${label}\\s*=\\s*\\[([^\\]]+)\\]`);
    const m = deployTxt.match(re);
    if (!m) return null;
    const nums = m[1].split(",").map(s => s.trim()).filter(Boolean).map(Number);
    return nums.some(Number.isNaN) ? null : nums;
  }

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
    else fail(`deploy_v8.js: ${band} sums to ${sum} BPS, NOT 10000 — [${arr.join(",")}]`);
  }

  // chainBps is field index 1 in the 10-field SplitConfig array order above.
  const CHAIN_BANDS = [
    { name: "CHAIN_PAY_T1_T3",  splitBands: ["SPLITS_T1_T3"] },
    { name: "CHAIN_PAY_T4_T5",  splitBands: ["SPLITS_T4_T5"] },
    // T6-T7 and T8-T10 are documented to share the same 17.5% chain rate, so
    // CHAIN_PAY_T6_T10 must match the chainBps of BOTH split bands.
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

  // V8.16: topUpAndCross must be in contract
  const matTxtV16 = read("contracts/FigureEightMatrixV8.sol");
  if (matTxtV16 && matTxtV16.includes("function topUpAndCross(")) {
    ok("FigureEightMatrixV8.sol: topUpAndCross() found — member self-rescue active (V8.16)");
  } else {
    fail("FigureEightMatrixV8.sol: topUpAndCross() MISSING — V8.16 self-rescue not deployed");
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
  if (govTxtV20 && govTxtV20.includes("PARAM_CW_DISTRIBUTE_INTERVAL") &&
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
      cwTxtV20.includes("function setDistributeInterval(")) {
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
