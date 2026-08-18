// audit_frontend_abi.js — DOES THE FRONTEND STILL SPEAK THE CONTRACTS' LANGUAGE?
//
// THE QUESTION, AND WHY IT IS ASKED BEFORE A DEPLOY AND NOT AFTER
//   V8.50 DELETES a public constant (MatrixKeeper.DIRECT_EARN_BPS), ADDS functions
//   (creditCarriedBalance, totalEarnedOf, setMinGasPerItem) and ADDS events
//   (BalanceCarried, BatchGasHalted). The frontend declares its own ABI fragments as
//   string literals. If it declares something the contracts no longer have, the site
//   breaks the moment the new addresses go live — which is exactly the failure you
//   cannot fix afterwards.
//
//   A spot-check is not an audit. Grepping for eight names found nothing on 2026-08-18
//   and that is reassuring, not conclusive. This walks EVERY fragment.
//
// TWO FAILURE MODES, AND THE SECOND IS WORSE
//   MISSING      the frontend declares a function/event the V8.50 artifacts do not have.
//                The call reverts or the log never decodes. LOUD.
//   SHAPE DRIFT  the SELECTOR still matches (same name, same inputs) but the OUTPUTS
//                changed. The call succeeds and decodes to the WRONG VALUE. SILENT.
//                This is the one worth building a tool for — a selector match is not
//                safety, and eyeballing a diff will miss it every time.
//
// Read-only. Touches no chain. Run from the contracts repo AFTER `npx hardhat compile`:
//   node scripts/audit_frontend_abi.js
//   FRONTEND=../../CryptoNova-Testnet-App   (default; override for the mainnet app)
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const FE   = process.env.FRONTEND || path.join(__dirname, "..", "..", "..", "CryptoNova-Testnet-App");
const ART  = path.join(__dirname, "..", "artifacts", "contracts");
const SKIP = new Set(["node_modules", "archive", "locales", ".git", "dist", "build", "coverage"]);

function walk(dir, exts, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.some(x => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

// ── 1. every ABI fragment the frontend declares ──────────────────────────────
// Fragments appear as quoted strings: 'function foo(...) view returns (...)'.
// Matching on the quote boundary rather than the line keeps multi-fragment lines intact.
const FRAG_RE = /['"`]\s*((?:function|event)\s+[^'"`]+?)\s*['"`]/g;
const feFiles = walk(FE, [".html", ".js", ".jsx", ".ts", ".tsx"]);
const frags = new Map();   // normalised signature -> { raw, files:Set }
for (const f of feFiles) {
  let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
  let m;
  while ((m = FRAG_RE.exec(txt)) !== null) {
    const raw = m[1].replace(/\s+/g, " ").trim();
    if (!frags.has(raw)) frags.set(raw, { raw, files: new Set() });
    frags.get(raw).files.add(path.relative(FE, f));
  }
}

// ── 2. every function and event the compiled V8.50 contracts expose ──────────
const bySelector = new Map();   // selector/topic -> [{ contract, format }]
let artCount = 0;
for (const a of walk(ART, [".json"])) {
  if (a.endsWith(".dbg.json")) continue;
  let j; try { j = JSON.parse(fs.readFileSync(a, "utf8")); } catch { continue; }
  if (!Array.isArray(j.abi)) continue;
  artCount++;
  let iface; try { iface = new ethers.Interface(j.abi); } catch { continue; }
  iface.forEachFunction(fn => {
    const k = fn.selector;
    if (!bySelector.has(k)) bySelector.set(k, []);
    bySelector.get(k).push({ contract: j.contractName, format: fn.format("full") });
  });
  iface.forEachEvent(ev => {
    const k = ev.topicHash;
    if (!bySelector.has(k)) bySelector.set(k, []);
    bySelector.get(k).push({ contract: j.contractName, format: ev.format("full") });
  });
}

// ── 3. the diff ──────────────────────────────────────────────────────────────
// ⛔ NOT EVERY FRAGMENT THE FRONTEND DECLARES BELONGS TO US.
// The site also talks to third-party contracts that will never appear in our artifacts.
// The first run reported Multicall3's aggregate3 as "MISSING from V8.50", which is true
// and completely irrelevant — it was never ours to have. Anything matched here is
// reported separately as EXTERNAL rather than as a problem.
//
// ⚠ KEEP THIS LIST TIGHT. Every name added here is a call this audit stops checking, so
// a wrong entry buys silence on a real break. Add only what is verifiably foreign.
const EXTERNAL = [
  /^function aggregate3\(/,          // Multicall3, canonical 0xcA11bde0
  /^function aggregate\(/,           // Multicall / Multicall2
  /^function blockAndAggregate\(/,
  /^function tryAggregate\(/,
  /^function getEthBalance\(/,
];
const missing = [], drift = [], ok = [], unparsable = [], external = [];
for (const { raw, files } of frags.values()) {
  let frag;
  try { frag = ethers.Fragment.from(raw); }
  catch (e) { unparsable.push({ raw, files, why: (e.shortMessage || e.message || "").slice(0, 60) }); continue; }

  let key, feOut;
  if (frag.type === "function") {
    key = ethers.FunctionFragment.from(raw).selector;
    // ⛔ TYPES ONLY — NOT format("full"). The first draft compared full formats, which
    // INCLUDE the parameter NAME, so every named return in the codebase read as drift:
    //     frontend  returns (uint256)
    //     contract  returns (uint256 locked)      <- flagged, identical in every way
    // That produced 17 alarms of which ~15 were noise, on the very first run. A tool
    // that cries wolf gets ignored, and an ignored tool is worse than no tool.
    feOut = ethers.FunctionFragment.from(raw).outputs.map(o => o.format("sighash")).join(",");
  } else if (frag.type === "event") {
    key = ethers.EventFragment.from(raw).topicHash;
    feOut = null;   // events: the selector covers name + input types, which is the shape
  } else continue;

  const hits = bySelector.get(key);
  if (!hits || !hits.length) {
    if (EXTERNAL.some(re => re.test(raw))) external.push({ raw, files });
    else missing.push({ raw, files });
    continue;
  }

  if (feOut !== null) {
    // ⛔ THE SILENT CASE. Same selector, different outputs -> the call succeeds and
    // decodes to a wrong value. Only flag when NO contract matches the frontend's
    // outputs; several contracts may share a selector legitimately.
    const anyMatch = hits.some(h => {
      try { return ethers.FunctionFragment.from(h.format).outputs.map(o => o.format("sighash")).join(",") === feOut; }
      catch { return false; }
    });
    if (!anyMatch) { drift.push({ raw, files, hits }); continue; }
  }
  ok.push(raw);
}

// ── 4. report ────────────────────────────────────────────────────────────────
const rel = p => p.length > 3 ? p.slice(0, 3).join(", ") + ` (+${p.length - 3})` : p.join(", ");
console.log(`\n  frontend   ${FE}`);
console.log(`  artifacts  ${artCount} compiled contracts`);
console.log(`  scanned    ${feFiles.length} frontend files, ${frags.size} distinct ABI fragments\n`);

console.log(`  ✅ present and shape-compatible : ${ok.length}`);
console.log(`  ⛔ MISSING from V8.50           : ${missing.length}`);
console.log(`  ⛔ SHAPE DRIFT (silent)         : ${drift.length}`);
console.log(`  ⚠  unparsable (not ABI)        : ${unparsable.length}`);
console.log(`  ·  external (not our contracts) : ${external.length}`);

if (missing.length) {
  console.log(`\n  ⛔ MISSING — the frontend calls these and V8.50 DOES NOT HAVE THEM.`);
  console.log(`     Each one breaks the moment the new addresses go live.`);
  for (const m of missing) console.log(`     ${m.raw}\n        in: ${rel([...m.files])}`);
}
if (drift.length) {
  console.log(`\n  ⛔ SHAPE DRIFT — selector matches, OUTPUTS DIFFER. These do NOT revert.`);
  console.log(`     They return a value the frontend decodes WRONGLY. Worse than missing.`);
  for (const d of drift) {
    console.log(`     frontend: ${d.raw}\n        in: ${rel([...d.files])}`);
    for (const h of d.hits.slice(0, 3)) console.log(`        contract ${h.contract}: ${h.format}`);
  }
}
if (external.length) {
  console.log(`\n  ·  EXTERNAL — third-party contracts, correctly absent from our artifacts.`);
  for (const e of external) console.log(`     ${e.raw.slice(0, 76)}`);
}
if (unparsable.length) {
  console.log(`\n  ⚠  NOT VALID ABI — listed, never silently dropped. Most are prose that`);
  console.log(`     happened to start with "function"; check none is a real fragment.`);
  for (const u of unparsable.slice(0, 12)) console.log(`     ${u.raw.slice(0, 84)}   [${u.why}]`);
  if (unparsable.length > 12) console.log(`     ... and ${unparsable.length - 12} more`);
}

console.log(`\n  ── VERDICT ──`);
if (!frags.size) {
  console.log(`  NO FRAGMENTS FOUND. Check FRONTEND=${FE} is the right path — a wrong path`);
  console.log(`  produces a clean bill of health, which is the worst possible failure here.`);
} else if (!artCount) {
  console.log(`  NO ARTIFACTS. Run 'npx hardhat compile --force' first — with none loaded,`);
  console.log(`  EVERY fragment reads as missing.`);
} else if (!missing.length && !drift.length) {
  console.log(`  ✅ The frontend and V8.50 agree on all ${ok.length} fragments it declares.`);
  console.log(`  ⚠ THIS CHECKS THE INTERFACE, NOT THE MEANING. A function can keep its exact`);
  console.log(`  signature and change what the number MEANS — item A halved the crossing`);
  console.log(`  price without touching one selector. Semantic drift needs reading, not this.`);
} else {
  console.log(`  ⛔ ${missing.length + drift.length} PROBLEM(S). Fix before the deploy, not after.`);
}
console.log("");
