"use strict";
/**
 * run_log.js — TEE EVERY RUN TO A DATED FILE ON DISK.
 *
 * Owner request 2026-08-21 (session 29): "have these deploys saved to disk with names in
 * a folder so we don't need to copy paste and we can have every deploy from now on as
 * reference in the future."
 *
 * WHY IT EARNS ITS PLACE. Session 28 recorded four failed deploys whose addresses were
 * never captured, so four orphaned contract sets are on Base Sepolia that nobody can
 * identify (28.0). Session 29 added two more. Every one of those runs printed the
 * addresses to a console that was then lost. A run that is not written down is a run
 * that has to be repeated.
 *
 * USE — one line, at the very top of any script, before anything prints:
 *     require("./run_log");
 *
 * WRITES
 *   logs/runs/<script>/<utc-timestamp>_<label>.log   full transcript
 *   logs/runs/INDEX.md                               one row per run, newest last
 * `logs/` is gitignored, so this is local history and never bloats the repo.
 *
 * SAFETY
 *   - Synchronous writes (writeSync on a held fd), so a crash or process.exit still
 *     leaves a complete file. A log that loses the last line before the error is
 *     worthless, and the error is the line you came for.
 *   - Env is WHITELISTED, never dumped: secrets live in .env and RPC URLs carry API
 *     keys. Endpoints are recorded as HOSTNAMES ONLY.
 *   - uncaughtException / unhandledRejection are recorded and then re-thrown normally,
 *     so behaviour is unchanged — this observes, it does not intervene.
 */
const fs   = require("fs");
const path = require("path");

const ROOT     = path.join(__dirname, "..");
const SCRIPT   = path.basename(process.argv[1] || "unknown", ".js");
const STARTED  = new Date();
const STAMP    = STARTED.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");

function labelFor() {
  if (process.env.RUN_LABEL) return String(process.env.RUN_LABEL).replace(/[^A-Za-z0-9_.-]/g, "_");
  if (process.env.ADDRESSES_FILE) return path.basename(process.env.ADDRESSES_FILE, ".json");
  return "run";
}

const DIR = path.join(ROOT, "logs", "runs", SCRIPT);
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, `${STAMP}_${labelFor()}.log`);
const fd = fs.openSync(FILE, "a");

function raw(line) { try { fs.writeSync(fd, line); } catch {} }

const hostOnly = (u) => { try { return new URL(u).host; } catch { return u ? "(unparseable)" : "(unset)"; } };
function gitDesc() {
  try {
    const { execSync } = require("child_process");
    const opts = { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] };
    const br = execSync("git rev-parse --abbrev-ref HEAD", opts).toString().trim();
    const sha = execSync("git rev-parse --short HEAD", opts).toString().trim();
    const dirty = execSync("git status --porcelain", opts).toString().trim() ? " +uncommitted" : "";
    return `${br}@${sha}${dirty}`;
  } catch { return "(git unavailable)"; }
}

// Whitelist. Everything else stays out — .env holds keys and this file is plain text.
const ENV_KEYS = [
  "ADDRESSES_FILE", "MATRIX_SIZE", "DEPLOY_TIERS", "PARKED_GRACE_SECS", "SELF_GRACE_SECS",
  "GAS_MULTIPLIER", "ALLOW_ADDRESSES_OVERWRITE", "ONE_ITEM", "INTERVAL_SECS", "MAX_TICKS",
  "SELF_RESCUE_RATE", "UPGRADE_RATE", "COUNT", "OFFSET", "RUN_LABEL", "ARM", "BASE_BPS", "FRONTEND",
];

raw(`${"=".repeat(78)}\n`);
raw(`RUN LOG  ${SCRIPT}\n`);
raw(`started   ${STARTED.toISOString()}\n`);
raw(`command   node ${process.argv.slice(1).map(a => path.basename(a)).join(" ")}\n`);
raw(`node      ${process.version}\n`);
raw(`git       ${gitDesc()}\n`);
raw(`rpc       BASE_SEPOLIA_RPC_URL = ${hostOnly(process.env.BASE_SEPOLIA_RPC_URL)}\n`);
raw(`          BASE_SEPOLIA_RPC     = ${hostOnly(process.env.BASE_SEPOLIA_RPC)}\n`);
if (process.env.FALLBACK_RPCS) {
  raw(`          FALLBACK_RPCS        = ${process.env.FALLBACK_RPCS.split(",").map(s => hostOnly(s.trim())).join(", ")}\n`);
}
for (const k of ENV_KEYS) if (process.env[k] !== undefined) raw(`env       ${k} = ${process.env[k]}\n`);
raw(`${"=".repeat(78)}\n\n`);

// ── Tee ──────────────────────────────────────────────────────────────────────
const util = require("util");
for (const method of ["log", "info", "warn", "error", "debug"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    try { raw(util.format(...args) + "\n"); } catch {}
  };
}

let fatal = null;
process.on("uncaughtException",  (e) => { fatal = e; raw(`\n*** UNCAUGHT EXCEPTION ***\n${(e && e.stack) || e}\n`); throw e; });
process.on("unhandledRejection", (e) => { fatal = e; raw(`\n*** UNHANDLED REJECTION ***\n${(e && e.stack) || e}\n`); });

process.on("exit", (code) => {
  const secs = Math.round((Date.now() - STARTED.getTime()) / 1000);
  const outcome = (code === 0 && !fatal) ? "OK" : "FAILED";
  raw(`\n${"=".repeat(78)}\nfinished  ${new Date().toISOString()}  after ${secs}s  exit ${code}  ${outcome}\n${"=".repeat(78)}\n`);
  try { fs.closeSync(fd); } catch {}
  try {
    const index = path.join(ROOT, "logs", "runs", "INDEX.md");
    if (!fs.existsSync(index)) {
      fs.writeFileSync(index,
        "# Run index\n\nEvery run of a script that requires `run_log.js`, newest last.\n" +
        "`logs/` is gitignored — this is local history.\n\n" +
        "| started (UTC) | script | label | secs | outcome | log |\n|---|---|---|---|---|---|\n");
    }
    const rel = path.relative(path.join(ROOT, "logs", "runs"), FILE).replace(/\\/g, "/");
    fs.appendFileSync(index,
      `| ${STARTED.toISOString()} | ${SCRIPT} | ${labelFor()} | ${secs} | ${outcome} | \`${rel}\` |\n`);
  } catch {}
  // Printed last so it is the thing left on screen.
  process.stdout.write(`\n  run log: logs/runs/${SCRIPT}/${path.basename(FILE)}  (${outcome})\n`);
});
