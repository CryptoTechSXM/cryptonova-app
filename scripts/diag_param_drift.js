// diag_param_drift.js — WHICH GOVERNED PARAMETERS WOULD A FRESH DEPLOY GET WRONG?
//
// THE QUESTION (session 39, 2026-08-25). 38.2 found `parkedGracePeriod` carrying three
// different values for one behaviour, and the deploy script shipping the wrong one. Eight
// hours later 38.6 found `insolvencyFloorBps` in the same shape: source default 5000, live
// chain 3400, owner decision 3400, and `deploy_v8.js` never setting it at all. Two found by
// accident in one day is not two bugs, it is a CLASS. This measures the whole class.
//
// A static sweep of the three contracts (session 39) says 28 state variables have both a
// source default AND a setter — and `deploy_v8.js` sets exactly TWO of them, both added by
// 38.2 yesterday. For the other 26 the SOURCE DEFAULT IS WHAT SHIPS. Wherever the live
// chain has been tuned away from that default by a post-deploy setter call, a fresh V8.50
// deploy silently reverts the tuning, and nothing anywhere says a word.
//
// This asks the chain. Read-only. It sends no transaction and needs no key.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE INSTRUMENT DERIVES ALL THREE COLUMNS ITSELF. THERE IS NO TABLE IN THIS FILE.
//
//    A hardcoded parameter list is the very defect being measured — it is a second copy
//    of a fact, with nothing keeping it equal to the first. So at every run this script
//    RE-PARSES `contracts/*.sol` for the defaults and RE-PARSES `scripts/deploy_v8.js`
//    for the setter calls. Add a parameter tomorrow and it appears here with no edit.
//    38.5 wrote a line number into a handoff and called it a citation; a line number is
//    not a citation, and a table in a comment is not a mechanism.
//
// ⛔ NO SILENT FALLBACKS. A read that fails when the getter IS in the bytecode raises a
//    named PROBLEM and exits non-zero. 34.2's `parkedGracePeriod` fallback of 3600 against
//    a chain answering 86400 is the reason this rule exists.
//
// ⛔ AND ABSENCE IS PROVED, NOT INFERRED. A getter missing from the deployed bytecode and a
//    getter that reverts look identical over JSON-RPC and mean opposite things. Every
//    parameter's 4-byte selector is checked against `getCode` first, so "this parameter
//    postdates this chain" is never reported as a fault — and a genuine fault is never
//    excused as an old chain.
//
// ⛔ THE SELFTEST PLANTS ONE OF EACH VERDICT, because an instrument that has only ever
//    printed MATCH has not been shown able to say DRIFT. `parkedGracePeriod` must read
//    86400 and MATCH (38.5); `insolvencyFloorBps` must read 3400 and DRIFT against its 5000
//    source default (38.6); `evictionGracePeriod` must be ABSENT (it landed in V8.49, six
//    days after this deploy). If any planted expectation fails, this ABORTS — that means
//    either the instrument is broken or the chain moved, and both are findings, not noise.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/diag_param_drift.js --network baseSepolia
//
//   CSV=out.csv    override the output path (default: logs/param_drift_<ts>.csv)
//   SELFTEST=0     disable the planted-verdict check (do not, without a reason)
//
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// 34.1: NO DEFAULT. A hand-run diagnostic is exactly where a stale addresses file prints
// confident numbers about a dead deployment, because cron's .env is not there to save it.
if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.log("    npx hardhat run scripts/diag_param_drift.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));

// Which contract owns which source file, and where its address lives in the addresses file.
const SOURCES = [
  { sol: "StabilityFund.sol", addrKey: "stabilityFund" },
  { sol: "MatrixKeeper.sol",  addrKey: "matrixKeeper"  },
  { sol: "TierRouter.sol",    addrKey: "tierRouter"    },
];

// ⛔ THE PLANTED VERDICTS ARE V8.48-SPECIFIC, so they are only asserted when pointed at
//    the V8.48 addresses file. Against any other deployment the selftest is skipped and
//    says so out loud — a selftest that silently does nothing is worse than none.
const PLANTED_FOR = "v8_48";
const PLANTED = {
  parkedGracePeriod:  { live: "86400", verdict: "MATCH",
                        cite: "38.5, chain read 2026-08-25T00:01Z" },
  insolvencyFloorBps: { live: "3400",  verdict: "DRIFT",
                        cite: "38.6, chain read 2026-08-25" },
  // The third verdict this instrument can print. `evictionGracePeriod` arrived in V8.49
  // (b14eba7, 2026-08-15), SIX DAYS AFTER the V8.48 deploy — so its getter is not in the
  // live bytecode. index.html:9976 recorded the same absence independently, from the
  // frontend side, before this script existed. If this ever reads present, the chain is
  // not the V8.48 deployment this file claims.
  evictionGracePeriod: { live: null,   verdict: "ABSENT",
                        cite: "b14eba7 2026-08-15, and index.html:9976" },
};

// ── Solidity literal -> canonical decimal string ─────────────────────────────────────
// Handles 10_000, 24 hours, 7 days, 15 minutes, true/false. Anything it cannot resolve
// returns null, which becomes an UNPARSED verdict rather than a guess.
const UNITS = { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n, weeks: 604800n };
function litToValue(raw) {
  const s = String(raw).trim();
  if (s === "true")  return "true";
  if (s === "false") return "false";
  const m = s.match(/^([0-9_]+)\s*(seconds|minutes|hours|days|weeks)?$/);
  if (!m) return null;
  const n = BigInt(m[1].replace(/_/g, ""));
  return (m[2] ? n * UNITS[m[2]] : n).toString();
}

// ── Parse the contracts for governed parameters ──────────────────────────────────────
// A GOVERNED PARAMETER is a non-constant state variable that has BOTH an initializer in
// the source AND a matching set<Name> function. A variable with no setter cannot drift;
// a setter with no initializer has no default to disagree with.
function parseGoverned(solPath) {
  const src = fs.readFileSync(solPath, "utf8");
  const setters = new Set();
  for (const m of src.matchAll(/function\s+(set[A-Za-z0-9_]*)\s*\(/g)) {
    setters.add(m[1].toLowerCase());
  }
  const out = [];
  const varRe = /^[ \t]*(uint\d*|int\d*|bool|address)\s+(public|internal|private)?\s*(constant\s+|immutable\s+)?([A-Za-z_]\w*)\s*=\s*([^;]+);/gm;
  for (const m of src.matchAll(varRe)) {
    const [, type, vis, mod, name, rawVal] = m;
    if (mod) continue;                                    // constant / immutable: not tunable
    const setter = "set" + name[0].toUpperCase() + name.slice(1);
    if (!setters.has(setter.toLowerCase())) continue;     // no setter: cannot drift
    out.push({
      name, type, vis: vis || "internal", setter,
      rawDefault: rawVal.split(/\s+/).join(" ").trim(),
      srcDefault: litToValue(rawVal),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

async function main() {
  const root       = path.join(__dirname, "..");
  const deploySrc  = fs.readFileSync(path.join(__dirname, "deploy_v8.js"), "utf8");
  const problems   = [];
  const absent     = [];
  const rows       = [];

  console.log("");
  console.log("PARAMETER DRIFT — source default vs live chain vs what the deploy sets");
  console.log(`  addresses : ${process.env.ADDRESSES_FILE}  (${A.network}, deployed ${A.deployedAt})`);
  const block = await ethers.provider.getBlockNumber();
  console.log(`  block     : ${block}`);
  console.log("");

  for (const s of SOURCES) {
    const solPath = path.join(root, "contracts", s.sol);
    const addr    = A[s.addrKey];
    if (!addr) { problems.push(`addresses file has no '${s.addrKey}'`); continue; }

    const params = parseGoverned(solPath);
    // Every governed parameter here is `public`, so solc generates a same-name getter.
    // Build the ABI from what we actually found rather than from a written list.
    const abi = params
      .filter(p => p.vis === "public")
      .map(p => `function ${p.name}() view returns (${p.type})`);
    const c = new ethers.Contract(addr, abi, ethers.provider);

    // ⛔ PROVE ABSENCE, DO NOT INFER IT FROM A REVERT. A missing function and a function
    //    that reverts produce the SAME error over JSON-RPC, and they mean opposite things:
    //    one says "this parameter postdates this deployment", the other says "something is
    //    wrong". Fetch the runtime bytecode once and look for each getter's 4-byte
    //    selector. This is `audit_frontend_abi.js`'s MISSING check in miniature — the same
    //    check PHASE G's G.8 exists to run before the addresses change.
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") { problems.push(`${s.sol}: no contract deployed at ${addr}`); continue; }
    const hasSelector = (n) => code.includes(ethers.id(`${n}()`).slice(2, 10));

    for (const p of params) {
      const row = {
        contract: s.sol.replace(".sol", ""), addr, name: p.name, line: p.line,
        rawDefault: p.rawDefault, srcDefault: p.srcDefault,
        deploySets: new RegExp(`\\.\\s*${p.setter}\\s*\\(`).test(deploySrc),
        live: null, verdict: null,
      };

      if (p.vis !== "public") {
        row.verdict = "UNREADABLE";
        problems.push(`${p.name} is ${p.vis}, no getter — cannot be read from chain`);
      } else if (p.srcDefault === null) {
        row.verdict = "UNPARSED";
        problems.push(`${p.name} default "${p.rawDefault}" could not be resolved to a value`);
      } else if (!hasSelector(p.name)) {
        // NOT A PROBLEM. The getter is not in the deployed bytecode, so this parameter
        // did not exist when this deployment was made. It is a fact about the age of the
        // chain, and it is reported as such rather than counted as a failure.
        row.verdict = "ABSENT";
        absent.push(row);
      } else {
        try {
          const v = await c[p.name]();
          row.live = (typeof v === "boolean") ? String(v) : v.toString();
          row.verdict = (row.live === row.srcDefault) ? "MATCH" : "DRIFT";
        } catch (e) {
          // The selector IS in the bytecode and the call still failed. That is a genuine
          // fault and it counts.
          row.verdict = "UNREADABLE";
          problems.push(`${p.name} selector present but read failed on ${addr}: ${e.message.split("\n")[0]}`);
        }
      }
      rows.push(row);
    }
  }

  // ── SELFTEST — the instrument must be shown able to print BOTH verdicts ────────────
  if (process.env.SELFTEST === "0") {
    console.log("⚠ selftest DISABLED by SELFTEST=0 — every verdict below is unchecked.");
    console.log("");
  } else if (!process.env.ADDRESSES_FILE.includes(PLANTED_FOR)) {
    console.log(`⚠ selftest SKIPPED — planted verdicts are ${PLANTED_FOR}-specific and this run`);
    console.log(`  points at ${process.env.ADDRESSES_FILE}. Plant values for this deployment`);
    console.log("  before trusting a clean table from it.");
    console.log("");
  } else {
    let failed = false;
    for (const [name, want] of Object.entries(PLANTED)) {
      const r = rows.find(x => x.name === name);
      if (!r) { console.log(`SELFTEST FAIL: ${name} was not found by the source parse at all.`); failed = true; continue; }
      if (r.live !== want.live || r.verdict !== want.verdict) {
        console.log(`SELFTEST FAIL: ${name} expected live=${want.live} verdict=${want.verdict} (${want.cite})`);
        console.log(`               got  live=${r.live} verdict=${r.verdict}`);
        failed = true;
      }
    }
    if (failed) {
      console.log("");
      console.log("⛔ ABORTING. Either this instrument is broken or the chain moved since 38.5/38.6.");
      console.log("   BOTH ARE FINDINGS. Do not re-run with SELFTEST=0 to make this go away —");
      console.log("   read the two values above and establish which of the two it is first.");
      process.exit(1);
    }
    console.log("selftest: PASS — planted MATCH, DRIFT and ABSENT all three reproduced");
    console.log("");
  }

  // ── Report ────────────────────────────────────────────────────────────────────────
  const drift = rows.filter(r => r.verdict === "DRIFT");
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad("PARAMETER", 28) + pad("SOURCE DEFAULT", 16) + pad("LIVE CHAIN", 16) + pad("DEPLOY SETS", 13) + "VERDICT");
  console.log("-".repeat(88));
  for (const r of [...rows].sort((a, b) =>
      (a.verdict === "DRIFT" ? 0 : 1) - (b.verdict === "DRIFT" ? 0 : 1) || a.name.localeCompare(b.name))) {
    console.log(
      pad(r.name, 28) + pad(`${r.srcDefault ?? r.rawDefault}`, 16) +
      pad(r.live ?? "-", 16) + pad(r.deploySets ? "yes" : "-- NO --", 13) + r.verdict
    );
  }
  console.log("");
  console.log(`${rows.length} governed parameters · ${rows.filter(r => r.deploySets).length} set by deploy_v8.js · ${drift.length} DRIFTED from source`);
  console.log("");

  // THE HEADLINE. A parameter that has drifted AND is not set at deploy is one a fresh
  // deploy silently reverts — the 38.2 / 38.6 shape, stated as a count rather than found
  // one at a time by accident.
  const wouldRevert = drift.filter(r => !r.deploySets);
  if (wouldRevert.length) {
    console.log("⛔ THE DEPLOY SETS NEITHER VALUE, SO THE SOURCE DEFAULT IS WHAT SHIPS:");
    for (const r of wouldRevert) {
      console.log(`     ${pad(r.name, 26)} live ${pad(r.live, 12)} -> would ship ${r.srcDefault}   (${r.contract}.sol:${r.line})`);
    }
    console.log("");
    console.log("   ⚠ WHICH SIDE IS CORRECT IS A JUDGEMENT PER PARAMETER AND THIS SCRIPT DOES");
    console.log("     NOT MAKE IT. Sometimes LIVE is the decided policy and the source is stale");
    console.log("     (a setter call applied on chain and never written back). Sometimes SOURCE");
    console.log("     is the decided value and LIVE is a chain that never received the change.");
    console.log("     Read the commit that introduced each side before writing either into the");
    console.log("     deploy script.");
    console.log("");
  } else {
    console.log("✅ No drifted parameter is missing from the deploy script.");
    console.log("");
  }

  if (absent.length) {
    console.log(`ABSENT FROM THIS DEPLOYMENT'S BYTECODE — ${absent.length} parameter(s):`);
    for (const r of absent) {
      console.log(`     ${pad(r.name, 26)} source default ${pad(r.srcDefault ?? r.rawDefault, 12)} (${r.contract}.sol:${r.line})`);
    }
    console.log("   These postdate this deployment. Date each with:");
    console.log("     git log --reverse -S\"<name>\" -- contracts/<Contract>.sol");
    console.log("   ⛔ Against a deployment that SHOULD have them, an ABSENT row is the G.8");
    console.log("     MISSING failure and must stop the cutover.");
    console.log("");
  }

  if (problems.length) {
    console.log(`PROBLEMS: ${problems.length}`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log("");
  } else {
    console.log("PROBLEMS: 0");
    console.log("");
  }

  const ts  = new Date().toISOString().replace(/[:.]/g, "-");
  const out = process.env.CSV || path.join(root, "logs", `param_drift_${ts}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out,
    "contract,address,parameter,source_line,raw_default,source_default,live_value,deploy_sets,verdict\n" +
    rows.map(r => [r.contract, r.addr, r.name, r.line, `"${r.rawDefault}"`,
                   r.srcDefault ?? "", r.live ?? "", r.deploySets, r.verdict].join(",")).join("\n") + "\n");
  console.log(`CSV: ${out}`);

  // ⛔ 38.3's rule: a syntax check is not an existence check. Assert the artifact from
  //    disk, not from the buffer we just built.
  const back = fs.readFileSync(out, "utf8");
  const nLines = back.trim().split("\n").length - 1;
  if (nLines !== rows.length) {
    console.log(`⛔ CSV READ-BACK MISMATCH: wrote ${rows.length} rows, file holds ${nLines}.`);
    process.exit(1);
  }
  console.log(`CSV verified from disk: ${nLines} rows, ${back.length} bytes`);

  if (problems.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
