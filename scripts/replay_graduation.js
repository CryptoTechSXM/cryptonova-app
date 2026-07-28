"use strict";
/**
 * replay_graduation.js — replay a silent-graduation transaction on a fork and
 * find out what actually reverted inside the swallowed try/catch.
 *
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * MatrixLogicLib:513 calls TierRouter.handleCycleOut inside a try/catch whose
 * catch was EMPTY. The root is removed from the seat map BEFORE that call, so
 * any revert inside handleCycleOut was swallowed: no re-entry, no upgrade, no
 * park, no event. The member simply vanished, and the OUTER transaction still
 * succeeded — which is why nothing in the logs ever pointed at a cause.
 *
 * Ten members have now gone this way. Three hypotheses were raised and all
 * three were eliminated by measurement:
 *   1. Fee mismatch between TierRouter and PairManager — ruled out, aligned on
 *      all 10 tiers.
 *   2. TierRouter USDC / allowance shortfall — ruled out, all 9 live MatB roots
 *      simulate clean (diag_cycleout_revert.js).
 *   3. Out-of-gas on the single-pair path — ruled out by V8_46_CascadeGas.test.js:
 *      worst case 4,651,492 gas against a 17.8M cap, 3.8x headroom.
 *
 * What was always missing was a specific, replayable instance. Sherwyn's report
 * on 2026-07-27 produced one:
 *   tx    0x462bf842b1b63afba13b4cbfef96b71d81d3639b786ded4ef311b3e72f7c4294
 *   block 44700243   (T1.1 MatA, cycle #2, MemberCycledOut and nothing else)
 *
 * HOW IT WORKS
 * ─────────────────────────────────────────────────────────────────────────────
 * The outer transaction SUCCEEDED, so a plain re-run tells us nothing — the
 * catch swallows the failure again. We need the trace.
 *
 *   1. Fetch the original tx from a live Base Sepolia provider.
 *   2. hardhat_reset the fork to the block BEFORE it, so state matches exactly.
 *   3. Impersonate the sender and replay the identical calldata.
 *   4. debug_traceTransaction the replay (Hardhat Network implements this for
 *      transactions it executed itself).
 *   5. Walk the structLogs for REVERT opcodes and for frames that ran out of
 *      gas, and report the DEEPEST failure with its decoded reason.
 *
 * A revert reason names the cause outright. An out-of-gas frame instead means
 * the multi-tier ladder cascade is exhausting the 63/64 forwarded to it — the
 * one surviving hypothesis — and V8.46-B's depth guard goes back into scope.
 *
 * Read-only: nothing is sent to a real network.
 *
 * Run:
 *   FORK=1 TX=0x462bf842... npx hardhat run scripts/replay_graduation.js
 *   FORK=1 TX=0x... VERBOSE=1 npx hardhat run scripts/replay_graduation.js
 */

const { ethers, network } = require("hardhat");
require("dotenv").config();

const TX_HASH = (process.env.TX || "").trim();
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const VERBOSE = process.env.VERBOSE === "1";

// Every custom error declared across the protocol, so a 4-byte selector in the
// trace becomes a name instead of a hex blob. Plus the two OpenZeppelin ERC20
// ones, which are the likeliest cause if this turns out to be a funding issue.
const ERROR_SIGS = [
  "error TRZero()", "error TRBadValue()", "error TRAuth()", "error TRState()",
  "error F8V8_ZeroAddress()", "error F8V8_NotAuthorized()", "error F8V8_BadValue()", "error F8V8_BadConfig()",
  "error MPF_UnauthorizedPM()", "error MPF_TierNotConfigured()", "error MPF_InvalidTier()",
  "error MPF_ZeroAddress()", "error MPF_Reentrant()",
  "error MK_NotKeeper()", "error MK_InvalidParam()", "error MK_ZeroAddress()",
  "error MF_NotAdmin()", "error MF_InvalidTier()", "error MF_InvalidSize()",
  "error MF_AlreadyConfigured()", "error MF_NotConfigured()", "error MF_ZeroAddress()",
  "error MF_WrongOwner()", "error MF_TierMismatch()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];
const ERR_IFACE = new ethers.Interface(ERROR_SIGS);

/** Decode revert data: Error(string), Panic(uint256), or a known custom error. */
function decodeRevert(hex) {
  if (!hex || hex === "0x") return "(empty revert — require() with no message, or out-of-gas)";
  try {
    if (hex.startsWith("0x08c379a0")) {                       // Error(string)
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(10));
      return `Error("${reason}")`;
    }
    if (hex.startsWith("0x4e487b71")) {                       // Panic(uint256)
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + hex.slice(10));
      const panics = {
        1n: "assert(false)", 17n: "arithmetic overflow/underflow", 18n: "division by zero",
        33n: "invalid enum", 34n: "bad storage byte array", 35n: "pop on empty array",
        50n: "ARRAY INDEX OUT OF BOUNDS", 65n: "out of memory", 81n: "uninitialised function call",
      };
      return `Panic(0x${code.toString(16)}) — ${panics[code] || "unknown panic"}`;
    }
    const parsed = ERR_IFACE.parseError(hex);
    if (parsed) {
      const args = parsed.args.length ? "(" + parsed.args.map(a => a.toString()).join(", ") + ")" : "()";
      return `${parsed.name}${args}`;
    }
  } catch { /* fall through */ }
  return `unrecognised revert data ${hex.slice(0, 74)}${hex.length > 74 ? "…" : ""}`;
}

/** Pull `len` bytes at `off` out of the trace's memory array (32-byte words). */
function readMemory(memory, off, len) {
  if (!memory || !memory.length || len === 0) return "0x";
  const flat = memory.join("");
  const start = off * 2;
  const end   = start + len * 2;
  if (start >= flat.length) return "0x";
  return "0x" + flat.slice(start, Math.min(end, flat.length));
}

const stackTop = (stack, n = 0) =>
  stack && stack.length > n ? BigInt("0x" + stack[stack.length - 1 - n]) : 0n;

async function main() {
  if (!TX_HASH || !TX_HASH.startsWith("0x") || TX_HASH.length !== 66) {
    console.log("Set TX=0x<64 hex chars>.  Example:");
    console.log("  FORK=1 TX=0x462bf842b1b63afba13b4cbfef96b71d81d3639b786ded4ef311b3e72f7c4294 \\");
    console.log("    npx hardhat run scripts/replay_graduation.js");
    process.exit(1);
  }
  if (process.env.FORK !== "1") {
    console.log("FORK=1 is required — otherwise hardhat runs an empty local chain");
    console.log("and there is nothing to replay against.");
    process.exit(1);
  }

  // ── 1. Fetch the original transaction from the live chain ──────────────────
  const live = new ethers.JsonRpcProvider(RPC_URL);
  const tx   = await live.getTransaction(TX_HASH);
  if (!tx) { console.log(`FATAL: ${TX_HASH} not found on ${RPC_URL}`); process.exit(1); }
  const rc = await live.getTransactionReceipt(TX_HASH);

  console.log("═".repeat(78));
  console.log("SILENT GRADUATION — FORK REPLAY");
  console.log("═".repeat(78));
  console.log(`tx        ${TX_HASH}`);
  console.log(`block     ${tx.blockNumber}`);
  console.log(`from      ${tx.from}`);
  console.log(`to        ${tx.to}`);
  console.log(`value     ${ethers.formatEther(tx.value)} ETH`);
  console.log(`gasLimit  ${tx.gasLimit.toLocaleString()}`);
  console.log(`gasUsed   ${rc ? rc.gasUsed.toLocaleString() : "?"}  status ${rc ? rc.status : "?"}`);
  console.log(`selector  ${tx.data.slice(0, 10)}   calldata ${(tx.data.length - 2) / 2} bytes`);
  console.log(`logs      ${rc ? rc.logs.length : "?"} emitted`);
  console.log("");
  console.log("NOTE: the outer transaction SUCCEEDED. That is the whole problem —");
  console.log("the failure is inside a swallowed try/catch, so only a trace shows it.");
  console.log("");

  // ── 2. Fork at the block BEFORE, so state matches the moment it ran ────────
  const forkBlock = tx.blockNumber - 1;
  console.log(`Forking Base Sepolia at block ${forkBlock}…`);
  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: RPC_URL, blockNumber: forkBlock } }],
  });

  // ── 3. Impersonate the sender and replay identical calldata ───────────────
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [tx.from] });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [tx.from, "0x" + (10n ** 20n).toString(16)],       // 100 ETH for gas
  });
  const sender = await ethers.getSigner(tx.from);

  let replayHash, replayRc;
  try {
    const sent = await sender.sendTransaction({
      to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit,
    });
    replayHash = sent.hash;
    replayRc   = await sent.wait();
    console.log(`Replayed OK — status ${replayRc.status}, gasUsed ${replayRc.gasUsed.toLocaleString()}`);
    if (rc && replayRc.gasUsed !== rc.gasUsed) {
      console.log(`  (live used ${rc.gasUsed.toLocaleString()} — a difference means fork state drifted;`);
      console.log(`   treat the result as indicative rather than exact)`);
    }
  } catch (e) {
    console.log(`Replay REVERTED outright: ${e.shortMessage || e.message}`);
    console.log("That alone is informative — on-chain it succeeded, so fork state differs.");
    process.exit(1);
  }
  console.log("");

  // ── 4. Trace it ───────────────────────────────────────────────────────────
  console.log("Tracing… (this can take a minute on a large cascade)");
  let trace;
  try {
    trace = await network.provider.request({
      method: "debug_traceTransaction",
      params: [replayHash, { disableStorage: true, disableMemory: false, disableStack: false }],
    });
  } catch (e) {
    console.log(`FATAL: debug_traceTransaction unavailable — ${e.message}`);
    console.log("Hardhat Network supports it for transactions it executed; check the hardhat version.");
    process.exit(1);
  }

  const logs = trace.structLogs || [];
  console.log(`  ${logs.length.toLocaleString()} steps, max depth ${Math.max(...logs.map(l => l.depth))}`);
  console.log("");

  // ── 5. Find every failure and report the deepest ──────────────────────────
  const failures = [];
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    if (l.op === "REVERT") {
      const off = Number(stackTop(l.stack, 0));
      const len = Number(stackTop(l.stack, 1));
      failures.push({
        kind: "REVERT", depth: l.depth, pc: l.pc, gasLeft: l.gas, step: i,
        data: readMemory(l.memory, off, len),
      });
    } else if (l.error) {
      // Hardhat marks a frame that ran out of gas (or hit an invalid opcode).
      failures.push({
        kind: String(l.error).toUpperCase().includes("GAS") ? "OUT OF GAS" : `ERROR: ${l.error}`,
        depth: l.depth, pc: l.pc, gasLeft: l.gas, step: i, data: "0x",
      });
    }
  }

  // Which contract actually reverted? For a failure at depth D, the call that
  // created that frame is the last CALL-family op at depth D-1 before it. The
  // target sits at stack position 1 for CALL/CALLCODE (gas, addr, value, …) and
  // for DELEGATECALL/STATICCALL (gas, addr, …). Knowing "MatA vs MatB, which
  // tier" is the difference between a theory and a diagnosis.
  const CALL_OPS = new Set(["CALL", "DELEGATECALL", "STATICCALL", "CALLCODE"]);
  function callerOf(step, depth) {
    for (let i = step - 1; i >= 0; i--) {
      const l = logs[i];
      if (l.depth === depth - 1 && CALL_OPS.has(l.op)) {
        return { op: l.op, target: ethers.getAddress("0x" + stackTop(l.stack, 1).toString(16).padStart(40, "0")) };
      }
      if (l.depth < depth - 1) break;
    }
    return null;
  }

  // Identify an address by probing it on the fork — no addresses file needed,
  // which also means this cannot go stale the way a hardcoded default does.
  const idCache = new Map();
  async function identify(addr) {
    if (idCache.has(addr)) return idCache.get(addr);
    const probe = new ethers.Contract(addr, [
      "function isMatrixA() view returns (bool)",
      "function ENTRY_FEE() view returns (uint256)",
      "function pairIndex() view returns (uint256)",
      "function occupancy() view returns (uint256)",
    ], ethers.provider);
    let label = "unknown contract";
    try {
      const [isA, fee, pi, occ] = await Promise.all([
        probe.isMatrixA().catch(() => null),
        probe.ENTRY_FEE().catch(() => null),
        probe.pairIndex().catch(() => null),
        probe.occupancy().catch(() => null),
      ]);
      if (isA !== null && fee !== null) {
        label = `${isA ? "MatA" : "MatB"} · entry $${(Number(fee) / 1e6).toFixed(0)}` +
                (pi !== null ? ` · pair ${Number(pi) + 1}` : "") +
                (occ !== null ? ` · occupancy ${occ}/127` : "");
      }
    } catch { /* not a matrix */ }
    idCache.set(addr, label);
    return label;
  }

  for (const f of failures) {
    const c = callerOf(f.step, f.depth);
    if (c) { f.target = c.target; f.callOp = c.op; f.label = await identify(c.target); }
  }

  if (failures.length === 0) {
    console.log("No REVERT and no failed frame found in the trace.");
    console.log("");
    console.log("That is a real result, not a null one: it means the cycle-out did NOT");
    console.log("fail on this replay. Either fork state differs from the live moment, or");
    console.log("the graduation is not a swallowed revert at all and the missing events");
    console.log("have another explanation. Re-run with VERBOSE=1 to inspect the call tree.");
  } else {
    console.log("─".repeat(78));
    console.log(`${failures.length} failed frame(s) — deepest first`);
    console.log("─".repeat(78));
    failures.sort((a, b) => b.depth - a.depth || a.step - b.step);
    for (const f of failures.slice(0, 12)) {
      console.log(`depth ${String(f.depth).padStart(2)}  ${f.kind.padEnd(12)}  gasLeft ${Number(f.gasLeft).toLocaleString().padStart(12)}  pc ${f.pc}`);
      if (f.target) console.log(`             in ${f.target}  (${f.label})  via ${f.callOp}`);
      if (f.data && f.data !== "0x") console.log(`             ${decodeRevert(f.data)}`);
    }
    console.log("");

    const deepest = failures[0];
    console.log("═".repeat(78));
    console.log("VERDICT");
    console.log("═".repeat(78));
    if (deepest.kind === "OUT OF GAS") {
      console.log("OUT OF GAS in the innermost frame.");
      console.log("");
      console.log("This confirms the surviving hypothesis: the multi-tier ladder cascade");
      console.log("exhausts the 63/64 of gas EIP-150 forwards into handleCycleOut, the");
      console.log("empty catch swallows it, and the outer tx succeeds on its retained 1/64.");
      console.log("");
      console.log("=> V8.46-B (nesting depth guard) goes BACK INTO SCOPE. The single-pair");
      console.log("   measurement of 4.65M was not the path that fails.");
    } else {
      console.log(`Innermost failure at depth ${deepest.depth}:`);
      console.log(`  ${decodeRevert(deepest.data)}`);
      console.log("");
      console.log("A named revert means gas is NOT the cause, so V8.46-B's depth guard stays");
      console.log("out of scope. Fix this condition directly; V8.46-C already converts it");
      console.log("from a silent vanish into a park plus a CycleOutFailed event.");
    }
    console.log("");
    console.log(`Gas at the deepest failure: ${Number(deepest.gasLeft).toLocaleString()}`);
    console.log(`Total gas used by the replay: ${replayRc.gasUsed.toLocaleString()}`);
  }

  if (VERBOSE) {
    console.log("");
    console.log("─".repeat(78));
    console.log("CALL TREE");
    console.log("─".repeat(78));
    let shown = 0;
    for (const l of logs) {
      if (["CALL", "DELEGATECALL", "STATICCALL", "CALLCODE"].includes(l.op) && shown < 80) {
        const target = "0x" + stackTop(l.stack, 1).toString(16).padStart(40, "0");
        console.log(`  depth ${String(l.depth).padStart(2)}  ${l.op.padEnd(13)} -> ${target}  gas ${Number(l.gas).toLocaleString()}`);
        shown++;
      }
    }
    if (shown >= 80) console.log("  … truncated at 80 calls");
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
