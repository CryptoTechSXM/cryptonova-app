"use strict";
/**
 * trace_selfresc.js
 *
 * Calls debug_traceCall (callTracer) directly on Alchemy for selfRescue().
 * Returns the full call tree so we can see EXACTLY which sub-call reverts.
 * No Hardhat fork needed.
 *
 * Picks the first parked wallet that has USDC allowance >= $1 already set for
 * matA (bigfill wallets set real on-chain approve before each selfRescue call).
 *
 * Run:
 *   npx hardhat run scripts/trace_selfresc.js --network baseSepolia
 *
 * Optional env overrides:
 *   PARKED_ADDR=0x...   skip scan, trace this wallet directly
 */
const { ethers } = require("hardhat");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

// ── JSON-RPC helper ──────────────────────────────────────────────────────────
function jsonrpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const parsed  = new URL(url);
    const options = {
      hostname: parsed.hostname, port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Revert decoder ──────────────────────────────────────────────────────────
const fmt6 = n => "$" + (Number(BigInt(n)) / 1e6).toFixed(4);

function decodeOutput(hex) {
  if (!hex || hex === "0x" || hex === "") return "(empty)";
  const sel = hex.slice(0, 10).toLowerCase();
  const pay = "0x" + hex.slice(10);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  try {
    if (sel === "0x08c379a0") {
      const [msg] = abi.decode(["string"], pay);
      return `Error: "${msg}"`;
    }
    if (sel === "0x4e487b71") {
      const [code] = abi.decode(["uint256"], pay);
      const names = {1:"assert",17:"overflow",18:"div-zero",32:"array-bounds",50:"pop-empty",65:"OOM"};
      return `Panic(${code}) ${names[Number(code)] || ""}`;
    }
    if (sel === "0xfb8f41b2") {
      const [spender, have, need] = abi.decode(["address","uint256","uint256"], pay);
      return `ERC20InsufficientAllowance  spender=${spender}  allowance=${fmt6(have)}  needed=${fmt6(need)}`;
    }
    if (sel === "0xe450d38c") {
      const [acct, have, need] = abi.decode(["address","uint256","uint256"], pay);
      return `ERC20InsufficientBalance  account=${acct}  have=${fmt6(have)}  need=${fmt6(need)}`;
    }
    if (sel === "0x5274afe7") {
      const [token] = abi.decode(["address"], pay);
      return `SafeERC20FailedOperation  token=${token}`;
    }
    if (sel === "0x3e3f8f73") return `ReentrancyGuardReentrantCall()`;
    if (sel === "0x94280d62") {
      const [addr] = abi.decode(["address"], pay);
      return `ERC20InvalidSpender(${addr})`;
    }
    return `UNKNOWN_${sel}  raw=${hex.slice(0, 130)}`;
  } catch (e) {
    return `(decode failed)  raw=${hex.slice(0, 130)}`;
  }
}

// ── Walk call tree, print every failed call ─────────────────────────────────
function printFailed(call, depth, labels) {
  const pad  = "  ".repeat(depth);
  const to   = call.to?.toLowerCase();
  const lbl  = labels[to] || call.to?.slice(0, 10) + "…";
  const sel  = call.input?.slice(0, 10) || "";
  const desc = `[${call.type}] ${lbl}  sel=${sel}`;

  if (call.error) {
    const decoded = decodeOutput(call.output || "");
    console.log(`${pad}⚡ FAIL  ${desc}`);
    console.log(`${pad}   error  : ${call.error}`);
    console.log(`${pad}   output : ${call.output?.slice(0, 200) || "(none)"}`);
    console.log(`${pad}   decoded: ${decoded}`);
  }
  for (const sub of (call.calls || [])) {
    printFailed(sub, depth + 1, labels);
  }
}

// ── Print the full call tree (trimmed) ──────────────────────────────────────
function printTree(call, depth, labels) {
  if (depth > 6) return; // don't flood console
  const pad  = "  ".repeat(depth);
  const to   = call.to?.toLowerCase();
  const lbl  = labels[to] || (call.to?.slice(0, 10) + "…");
  const sel  = call.input?.slice(0, 10) || "";
  const ok   = call.error ? "✗" : "✓";
  console.log(`${pad}${ok} [${call.type}] ${lbl}  sel=${sel}  gas=${call.gasUsed}`);
  for (const sub of (call.calls || [])) {
    printTree(sub, depth + 1, labels);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const addrs    = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const T1       = addrs.tiers?.T1 || { matA: addrs.T1?.matA, matB: addrs.T1?.matB };
  const USDC_ADDR = (addrs.usdc || addrs.USDC).toLowerCase();
  const TR_ADDR   = (addrs.treasury || addrs.CNOVATreasury || "").toLowerCase();
  const SF_ADDR   = (addrs.stabilityFund || "").toLowerCase();
  const TR_ROUTER = (addrs.tierRouter || "").toLowerCase();
  const matAAddr  = T1.matA.toLowerCase();
  const matBAddr  = T1.matB.toLowerCase();

  // Human-readable labels for the trace tree
  const labels = {
    [matAAddr]:  "T1.1-MatA",
    [matBAddr]:  "T1.1-MatB",
    [USDC_ADDR]: "USDC",
    [TR_ADDR]:   "Treasury",
    [SF_ADDR]:   "SF",
    [TR_ROUTER]: "TierRouter",
  };

  const matA = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
  const usdc  = await ethers.getContractAt("MockUSDC",            addrs.usdc || addrs.USDC);

  // ── Find a parked wallet with allowance ──────────────────────────────────
  let parkedAddr = process.env.PARKED_ADDR || null;
  if (!parkedAddr) {
    const count = await matA.getParkedCount();
    console.log(`Scanning ${count} parked members for one with USDC allowance ≥ $1 …\n`);
    for (let i = 0; i < count; i++) {
      const addr = await matA.getParkedMember(i);
      if (!addr || addr === ethers.ZeroAddress) continue;
      const ts  = await matA.parkedAt(addr);
      if (ts === 0n) continue;
      const allowance = await usdc.allowance(addr, T1.matA);
      const bal       = await usdc.balanceOf(addr);
      console.log(`  [${String(i).padStart(3)}] ${addr.slice(0,12)}…  allowance=${fmt6(allowance)}  walletBal=${fmt6(bal)}`);
      if (allowance >= 1_000_000n) { parkedAddr = addr; break; }
    }
  }
  if (!parkedAddr) {
    console.log("\nNo parked wallet has allowance ≥ $1.  bigfill hasn't set approve yet, OR");
    console.log("all wallets already used their allowance.  Set PARKED_ADDR=0x… to force one.\n");
    console.log("Tracing the first parked wallet anyway (will show ERC20InsufficientAllowance — but we'll see the call tree).");
    const addr0 = await matA.getParkedMember(0);
    parkedAddr = addr0;
  }

  console.log(`\nTarget wallet: ${parkedAddr}`);
  const allowance = await usdc.allowance(parkedAddr, T1.matA);
  const walletBal = await usdc.balanceOf(parkedAddr);
  console.log(`  USDC allowance to matA : ${fmt6(allowance)}`);
  console.log(`  USDC wallet balance    : ${fmt6(walletBal)}`);

  // ── Encode selfRescue calldata ───────────────────────────────────────────
  const calldata = matA.interface.encodeFunctionData("selfRescue", []);

  // ── debug_traceCall with callTracer ─────────────────────────────────────
  console.log(`\nCalling debug_traceCall on Alchemy …`);
  const resp = await jsonrpc(RPC_URL, "debug_traceCall", [
    { to: T1.matA, from: parkedAddr, data: calldata, gas: "0xE4E1C0" },
    "latest",
    { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }
  ]);

  if (resp.error) {
    console.log("RPC returned error:", JSON.stringify(resp.error, null, 2));
    return;
  }

  const trace = resp.result;
  console.log(`\nTop-level result:`);
  console.log(`  error   : ${trace.error || "(none — succeeded?)"}`);
  console.log(`  gasUsed : ${trace.gasUsed}`);
  console.log(`  output  : ${trace.output?.slice(0, 200) || "(none)"}`);
  if (trace.output) console.log(`  decoded : ${decodeOutput(trace.output)}`);

  console.log("\n════ Full call tree ════");
  printTree(trace, 0, labels);

  console.log("\n════ Failed calls only ════");
  printFailed(trace, 0, labels);

  console.log("\n════ DONE ════");
}

main().catch(e => { console.error(e); process.exit(1); });
