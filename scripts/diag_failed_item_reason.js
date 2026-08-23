// diag_failed_item_reason.js — WHY did a WorkItemFailed fire? Read-only, one transaction.
//
// ⛔ THE PROBLEM THIS EXISTS FOR (handoff 30.13, defect 8). `WorkItemFailed` carries no
//    reason. An item that RAN OUT OF GAS and an item that reverted for its own reasons
//    emit the identical event, so a count of them cannot be acted on. G.4 produced one
//    on PARKED_RESCUE and 30.13 read it as defect 8 reproduced — an item dispatched with
//    more than the 5M floor and less than its 13M cost. **That reading has never been
//    tested.** This file tests it, two independent ways, and says which way answered.
//
// ⛔⛔ A WRONG TEST THAT SHIPPED IN THIS FILE FOR ONE RUN, 2026-08-23, KEPT BECAUSE THE
//    MISTAKE IS INSTRUCTIVE. Probe 0 below originally read: `performUpkeep` dispatches
//    with no gas cap, so EIP-150 gives the inner call 63/64 and the caller keeps 1/64;
//    therefore an out-of-gas item returns at most gasLimit/64 (~0.23M here), and the
//    observed 0.69M "is 2.9x more than an out-of-gas call can leave — it reverted for its
//    own reasons." **THAT IS WRONG, AND IT CONFIDENTLY CONTRADICTED A CORRECT HANDOFF.**
//    The 1/64 retention COMPOUNDS WITH DEPTH: each nested full-forwarding call keeps its
//    own 1/64, so an out-of-gas N levels down returns 1-(63/64)^N of the top allotment —
//    1.6% at depth 1, but ~9% at depth 6 and ~19% at depth 13. The real trace showed the
//    rescue reverting SEVEN levels deep, and 0.58M returned of 6.61M given is 8.8%, i.e.
//    exactly what a depth-6 out-of-gas leaves. The arithmetic did not disprove gas; it
//    was a single-level model applied to a deep call tree.
//    **THE LESSON IS THE HOUSE RULE: that was reasoning wearing a measurement's clothes.
//    The trace is the measurement. Where they disagree, the trace wins.**
//
// THREE PROBES, IN ORDER OF STRENGTH — the trace first, because it is the only one that
// SEES the failure rather than inferring it:
//   1. debug_traceTransaction (callTracer) — names the failing inner call and its revert
//      data outright. Not every RPC plan exposes it; absence is not a failure, it is a
//      missing instrument and this file says so rather than guessing.
//   2. eth_call replay of the same item with `from` = the keeper itself (the dispatch is
//      `this._doX...`, so any other sender reverts on authorisation and would hand back
//      a CONFIDENTLY WRONG reason). Run at the block BEFORE the transaction.
//      ⚠ ITS LIMIT, STATED UP FRONT: earlier items in the same batch changed state, so a
//      replay from the pre-transaction block is not the exact world the item met. Treat
//      a reason it returns as a STRONG CANDIDATE, not proof, and say so in the handoff.
//
// RUN (in C:\CryptoNite-Smart-Contracts\CryptoNova):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_50_private.json"
//   $env:FAILED_TX="0x484727ca3961ae63e4480c6c5f31317b19385bf0e9b5e862bc32c4780ae23b93"
//   node scripts/diag_failed_item_reason.js
//   Remove-Item Env:\ADDRESSES_FILE; Remove-Item Env:\FAILED_TX
// ⚠ Clearing ADDRESSES_FILE afterwards is not optional — a lingering session variable
//   beats .env (dotenv never overwrites a set value) and is what aimed a bigfill run at
//   the wrong chain on 2026-08-22 (handoff 30.8, 29.3c).

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const M = (n) => (Number(n) / 1e6).toFixed(2) + "M";
// ⛔⛔ 2026-08-23 (session 33). THIS TABLE WAS WRONG FROM ID 5 UP AND HAD NO ID 9.
//    Authoritative source, re-read rather than remembered: MatrixKeeper.sol:169-186.
//        was   5 EVICT_PARKED · 6 VELOCITY_GATE · 7 FORCE_ROTATE · 8 ADVANCE_EPOCH · (no 9)
//        is    5 VELOCITY_GATE · 6 EVICT_PARKED · 7 DISTRIBUTE_CW · 8 FORCE_ROTATE · 9 ADVANCE_EPOCH
//    Four of the ten ids named the wrong job. G.4's item was type 4, which reads the same
//    in both tables, so 31.4's type survived by LUCK — not because the table was right.
//    Cross-checked against every other WORK map in the repo: diag_keeper_discovery.js,
//    testchain_keeper.js, V8_48_KeeperScan and V8_50_KeeperGas all already agree with the
//    contract; diag_keeper_gas_live.js stops at 6 and prints the raw number above that,
//    which is honest. THIS FILE WAS THE ONLY ONE THAT NAMED THEM WRONG.
const WORK = { 0: "VELOCITY", 1: "GHOST", 2: "RECLAIM", 3: "CHAIN_LINK", 4: "PARKED_RESCUE",
               5: "VELOCITY_GATE", 6: "EVICT_PARKED", 7: "DISTRIBUTE_CW", 8: "FORCE_ROTATE",
               9: "ADVANCE_EPOCH" };

// ⛔⛔ `addr1` IS NOT ALWAYS THE MEMBER, AND PRINTING IT AS ONE COST A SESSION.
//    WorkItemFailed carries two bare addresses; what they MEAN depends on the workType,
//    because performUpkeep passes them POSITIONALLY into handlers whose signatures differ
//    (dispatch MatrixKeeper.sol:891-954, signatures :965-972):
//
//        PARKED_RESCUE  _doParkedRescueExternal(matrix, member, t)  -> addr1 MATRIX, addr2 MEMBER
//        EVICT_PARKED   _doEvictParkedExternal(matrix, member)      -> addr1 MATRIX, addr2 MEMBER
//        RECLAIM        _doReclaimSlotExternal(member, matB, t)     -> addr1 MEMBER,  addr2 matB
//        GHOST          _doGhostEntryExternal(member, t)            -> addr1 MEMBER,  addr2 unread
//        CHAIN_LINK     _doChainLinkExternal(a, b, idx)             -> a PAIR of matrices
//        FORCE_ROTATE   _doForceRotateExternal(matB)                -> addr1 matB,    addr2 unread
//        DISTRIBUTE_CW / ADVANCE_EPOCH                              -> addr1 CommunityWallet
//        VELOCITY / VELOCITY_GATE                                   -> neither address is read
//
//    This file printed a fixed `member = addr1`. On a PARKED_RESCUE that is the MATRIX,
//    and it sent handoff 31.4 looking for a MetaMask smart account behind an address that
//    is our own `tiers.T1.matB` (32.4 caught the address; this is the cause). ⚠ The replay
//    in probe 2 was NEVER affected — it passes (addr1, addr2) straight through in the same
//    order the contract does, so it was always correct. The DISPLAY was the whole defect.
const ADDR_ROLES = {
  0: ["addr1 (unread)",  "addr2 (unread)"],
  1: ["member",          "addr2 (unread)"],
  2: ["member",          "matB"],
  3: ["matrix a",        "matrix b"],
  4: ["MATRIX",          "MEMBER"],
  5: ["addr1 (unread)",  "addr2 (unread)"],
  6: ["MATRIX",          "MEMBER"],
  7: ["communityWallet", "addr2 (unread)"],
  8: ["matB",            "addr2 (unread)"],
  9: ["communityWallet", "addr2 (unread)"],
};

// The six reasons MatrixKeeper.sol:912-923 treats as a SKIP. Anything else with a reason
// string re-reverts the whole batch, so a SUCCESSFUL transaction cannot contain one.
const BENIGN = [
  "F8V8: already in matrix", "F8V8: not parked", "F8V8: still in matrix",
  "SF: insolvency floor", "SF: below floor", "F8V8: insufficient withdrawable for rescue",
];

async function main() {
  const txHash = process.env.FAILED_TX;
  if (!txHash) throw new Error("set FAILED_TX to the transaction hash (diag_keeper_gas_live prints it)");

  const addrFile = process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json";
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, addrFile), "utf8"));
  const keeperAddr = addrs.matrixKeeper;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
  const provider = new ethers.JsonRpcProvider(rpc, 84532, { staticNetwork: true });

  console.log(`\n  ${"=".repeat(94)}`);
  console.log(`  WHY DID THE ITEM FAIL — ${txHash}`);
  console.log(`  addresses ${addrFile}   keeper ${keeperAddr}`);
  console.log(`  ${"=".repeat(94)}\n`);

  const rc = await provider.getTransactionReceipt(txHash);
  if (!rc) throw new Error("no receipt — wrong chain, or the RPC has pruned it");
  const tx = await provider.getTransaction(txHash);

  const iface = new ethers.Interface([
    "event WorkItemFailed(uint8 indexed workType, uint8 tierIndex, address addr1, address addr2)",
    "event BatchGasHalted(uint256 processed, uint256 total, uint256 gasRemaining)",
    "function performUpkeep(bytes performData)",
    "function _doParkedRescueExternal(address a, address b, uint8 tierIndex)",
    "function minGasPerItem() view returns (uint256)",
  ]);

  let failed = null, halted = null;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== keeperAddr.toLowerCase()) continue;
    let p; try { p = iface.parseLog(l); } catch { continue; }
    if (!p) continue;
    if (p.name === "WorkItemFailed") failed = { workType: Number(p.args[0]), tierIndex: Number(p.args[1]), addr1: p.args[2], addr2: p.args[3] };
    if (p.name === "BatchGasHalted") halted = { processed: Number(p.args[0]), total: Number(p.args[1]), gasRemaining: Number(p.args[2]) };
  }
  if (!failed) throw new Error("no WorkItemFailed in this receipt — check the hash");

  console.log(`  THE FAILED ITEM`);
  console.log(`    type      ${WORK[failed.workType] || failed.workType}   tier ${failed.tierIndex}`);
  // Named by what the CONTRACT does with each slot for THIS workType — see ADDR_ROLES.
  const roles = ADDR_ROLES[failed.workType] || ["addr1", "addr2"];
  console.log(`    ${roles[0].padEnd(9)} ${failed.addr1}`);
  console.log(`    ${roles[1].padEnd(9)} ${failed.addr2}`);
  console.log(`    tx status ${rc.status === 1 ? "SUCCESS" : "REVERTED"}   gasUsed ${M(rc.gasUsed)}   gasLimit ${M(tx.gasLimit)}`);
  if (halted) console.log(`    halt      processed ${halted.processed} of ${halted.total}, ${M(halted.gasRemaining)} remaining`);

  // ── PROBE 0: the returned-gas test. ⛔ WEAK, AND IT WAS WRONG THE FIRST TIME — see the
  //    header. Kept because it is free and it bounds the case, but it can only ever say
  //    "out of gas is IMPOSSIBLE", never "out of gas happened", and it needs the call
  //    DEPTH to say even that. Below ~30% returned, every answer is compatible with gas.
  console.log(`\n  0. THE RETURNED-GAS TEST — a BOUND, not a verdict. Read the trace for the answer.`);
  if (halted) {
    const pct = (halted.gasRemaining / Number(tx.gasLimit)) * 100;
    // 1-(63/64)^N is what an out-of-gas N levels down hands back.
    const impliedDepth = Math.log(1 - Math.min(0.99, halted.gasRemaining / Number(tx.gasLimit))) / Math.log(63 / 64);
    console.log(`     the halt reports ${M(halted.gasRemaining)} of a ${M(tx.gasLimit)} limit = ${pct.toFixed(1)}% returned`);
    console.log(`     an out-of-gas N calls deep returns 1-(63/64)^N: 1.6% at depth 1, ~9% at 6, ~19% at 13`);
    console.log(`     -> ${pct > 30
      ? `⛔ OUT OF GAS IS IMPLAUSIBLE. ${pct.toFixed(1)}% would need a call tree ~${Math.round(impliedDepth)} deep.`
      : `⚠ INCONCLUSIVE. ${pct.toFixed(1)}% is exactly what an out-of-gas ~${Math.round(impliedDepth)} levels deep leaves. ` +
        `This probe CANNOT separate the cases here — do not let it. The trace decides.`}`);
    console.log(`     ⚠ AND THE ITEM-COUNT ARGUMENT DOES NOT HELP EITHER: "later dispatches needed a`);
    console.log(`     full floor free" only bites if the failure was NOT the last item, and the event`);
    console.log(`     carries no index. In G.4's case it WAS the last, and the argument proved nothing.`);
  } else {
    console.log(`     no BatchGasHalted in this transaction — this probe needs one. Read the trace.`);
  }

  // ── PROBE 1: the trace.
  console.log(`\n  1. debug_traceTransaction (callTracer) — the direct answer, if the plan allows it`);
  let traced = false;
  try {
    const t = await provider.send("debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
    const walk = (c, d = 0) => {
      const out = [];
      if (c.error || c.revertReason) out.push({ d, to: c.to, gas: c.gas, gasUsed: c.gasUsed, error: c.error, revertReason: c.revertReason, input: c.input });
      for (const k of c.calls || []) out.push(...walk(k, d + 1));
      return out;
    };
    const bad = walk(t);
    traced = true;
    if (!bad.length) console.log(`     the trace shows NO failing inner call — unexpected; keep the raw trace.`);
    for (const b of bad) {
      console.log(`     depth ${b.d}  to ${b.to}`);
      console.log(`       error "${b.error}"${b.revertReason ? `  reason "${b.revertReason}"` : `  (no reason data)`}`);
      if (b.gas != null) console.log(`       gas given ${M(parseInt(b.gas, 16))}  gas used ${M(parseInt(b.gasUsed, 16))}` +
        `${parseInt(b.gasUsed, 16) >= parseInt(b.gas, 16) * 0.99 ? `   ⛔ USED ~ALL OF IT = OUT OF GAS` : `   ✅ returned gas = an ordinary revert`}`);
    }
  } catch (e) {
    console.log(`     UNAVAILABLE on this endpoint: ${(e.shortMessage || e.message || "").slice(0, 120)}`);
    console.log(`     Not a result either way — a missing instrument, not evidence. Probe 2 follows.`);
  }

  // ── PROBE 2: replay the item.
  console.log(`\n  2. eth_call REPLAY of the same item at block ${rc.blockNumber - 1}, from the keeper itself`);
  try {
    const data = iface.encodeFunctionData("_doParkedRescueExternal", [failed.addr1, failed.addr2, failed.tierIndex]);
    await provider.call({ to: keeperAddr, from: keeperAddr, data, blockTag: rc.blockNumber - 1 });
    console.log(`     ✅ IT SUCCEEDED IN REPLAY, WITH THE GAS AN eth_call GETS (effectively unlimited).`);
    console.log(`     The item was PERFORMABLE — it did not fail on its own terms. Combined with an`);
    console.log(`     out-of-gas frame in the trace, that is the two halves of defect 8: legitimate`);
    console.log(`     work, dispatched above the floor, with less gas than it needed to finish.`);
  } catch (e) {
    const reason = e.reason || e.shortMessage || e.message || "";
    console.log(`     REVERTED: "${reason}"`);
    const hit = BENIGN.find((b) => reason.includes(b));
    if (hit) {
      console.log(`     ✅ "${hit}" IS ONE OF THE SIX REASONS MatrixKeeper TREATS AS A SKIP (line 912-923).`);
      console.log(`     That path emits WorkItemFailed and continues. It is the guard working, not defect 8.`);
    } else {
      console.log(`     ⛔ NOT one of the six skip reasons. Note what that implies: a reason string off`);
      console.log(`     that list makes the dispatch re-revert the WHOLE batch — and this transaction`);
      console.log(`     SUCCEEDED. So the live failure cannot have taken this path, and the replay is`);
      console.log(`     describing a different world. Trust probe 0 and the trace over this line.`);
    }
  }

  console.log(`\n  ${"=".repeat(94)}`);
  console.log(`  WHAT TO WRITE DOWN: whether the item ran out of gas (defect 8 reproduced, and the`);
  console.log(`  floor/cap decision is load-bearing) or reverted for its own reasons (a benign skip,`);
  console.log(`  and G.4's alarm is the guard reporting itself correctly). ${traced ? "The trace answered it." : "No trace was available."}`);
  console.log(`  ⚠ EITHER WAY THE CONFIGURATION IS UNCHANGED — maxItemsPerUpkeep = 1 is required by`);
  console.log(`  the 13.03M item existing at all, not by this one event's cause (30.13).`);
  console.log(`  ${"=".repeat(94)}\n`);
}

main().catch((e) => { console.error(`\n  ⛔ ${e.message}\n`); process.exit(1); });
