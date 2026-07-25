#!/usr/bin/env node
"use strict";
/**
 * sandbox_compile.js — offline chunked wasm-solc compiler for the Claude sandbox.
 *
 * WHY: the sandbox cannot download native solc (binaries.soliditylang.org is
 * not allowlisted), and each sandbox shell call is capped at 45 s — too short
 * for a full hardhat wasm compile. This driver compiles a SUBSET of root
 * contracts per invocation with node_modules/solc (0.8.26 wasm) and writes
 * hardhat-format artifacts, so `hardhat test --no-compile` works.
 *
 * NOT used on Windows / for deploys — the real hardhat config (optimizer
 * runs=1, viaIR overrides) stays authoritative there. Optimizer here follows
 * OPT=1 env (default ON with runs=1, matching config; no viaIR — tests run
 * with allowUnlimitedContractSize).
 *
 * Usage: node scripts/sandbox_compile.js <RootA.sol> [RootB.sol ...]
 *        ART_DIR=/path/to/artifacts (default ./artifacts-sandbox)
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const PROJECT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT, "contracts");
const ART_DIR = process.env.ART_DIR || path.join(PROJECT, "artifacts-sandbox");
const OPT_ON  = process.env.OPT !== "0";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node sandbox_compile.js <Root.sol> [...]");
  process.exit(1);
}

// ---- source loader with import resolution ---------------------------------
const loaded = {};
function readSource(sourceName) {
  if (loaded[sourceName] !== undefined) return loaded[sourceName];
  let fp;
  if (sourceName.startsWith("contracts/")) {
    fp = path.join(PROJECT, sourceName);
  } else if (sourceName.startsWith("@") || !sourceName.startsWith(".")) {
    fp = path.join(PROJECT, "node_modules", sourceName);
  } else {
    fp = path.join(PROJECT, sourceName);
  }
  const content = fs.readFileSync(fp, "utf8");
  loaded[sourceName] = content;
  return content;
}

function resolveImport(from, imp) {
  if (imp.startsWith(".")) {
    const dir = path.posix.dirname(from);
    return path.posix.normalize(path.posix.join(dir, imp));
  }
  return imp; // node_modules style
}

// BFS collect all sources reachable from the roots
const sources = {};
const queue = roots.map((r) => (r.startsWith("contracts/") ? r : "contracts/" + r));
while (queue.length) {
  const s = queue.shift();
  if (sources[s]) continue;
  const content = readSource(s);
  sources[s] = { content };
  // strip comments before scanning imports (commented-out imports must not resolve)
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const re = /import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(stripped))) {
    queue.push(resolveImport(s, m[1]));
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    ...(process.env.VIA_IR === "1" ? { viaIR: true } : {}),
    optimizer: { enabled: OPT_ON, runs: 1 },
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers"] },
    },
  },
};

const t0 = Date.now();
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const dt = ((Date.now() - t0) / 1000).toFixed(1);

let fatal = false;
for (const e of out.errors || []) {
  if (e.severity === "error") { fatal = true; console.error(e.formattedMessage); }
}
if (fatal) process.exit(2);

let written = 0;
for (const [sourceName, contracts] of Object.entries(out.contracts || {})) {
  if (!sourceName.startsWith("contracts/")) continue; // only project artifacts
  for (const [name, c] of Object.entries(contracts)) {
    const dir = path.join(ART_DIR, sourceName);
    fs.mkdirSync(dir, { recursive: true });
    const artifact = {
      _format: "hh-sol-artifact-1",
      contractName: name,
      sourceName,
      abi: c.abi,
      bytecode: "0x" + (c.evm.bytecode.object || ""),
      deployedBytecode: "0x" + (c.evm.deployedBytecode.object || ""),
      linkReferences: c.evm.bytecode.linkReferences || {},
      deployedLinkReferences: c.evm.deployedBytecode.linkReferences || {},
    };
    fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(artifact));
    // minimal dbg file so hardhat's artifact scanner is happy
    fs.writeFileSync(
      path.join(dir, name + ".dbg.json"),
      JSON.stringify({ _format: "hh-sol-dbg-1", buildInfo: "../../build-info/sandbox.json" })
    );
    written++;
  }
}
console.log(`compiled ${roots.join(", ")} in ${dt}s -> ${written} artifacts`);
