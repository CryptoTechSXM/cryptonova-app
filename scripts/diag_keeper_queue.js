// diag_keeper_queue.js — WHAT WILL THE KEEPER DO NEXT, AND WHY DOES AN ITEM FAIL?  READ-ONLY.
//
// Written 2026-09-17 (session 87, handoff 62.64). Measured with diag_block_events.js: five
// consecutive performUpkeep txs on the private V8.54 chain each emitted exactly ONE event,
//     WorkItemFailed workType=4 (WORK_PARKED_RESCUE) tier 0 T1.1 MatB member 0xc64700…82D8
// — the same member every time — while 3 other RESCUE-verdict members and 1 EVICTION-DUE member
// were never reached. performUpkeep's catch (MatrixKeeper.sol ~:986) swallows six known revert
// strings and emits WorkItemFailed WITHOUT the reason. This tool recovers what the event drops:
//
//   1. calls checkUpkeep() and decodes performData into the WorkItem[] the keeper would send
//      (so the queue ORDER is read, not inferred)
//   2. for each item, eth_calls the matching onlySelf worker (_doParkedRescueExternal,
//      _doEvictParkedExternal, _doForceRotateExternal, _doVelocityGateExternal) FROM the
//      MatrixKeeper address, and prints OK or the exact revert reason
//
// eth_call with from = the keeper contract satisfies onlySelf in a simulation only. Nothing is
// signed; no key is read. A worker type this tool does not simulate is printed as NOT SIMULATED,
// never as OK.
//
// Run (PowerShell, from C:\CryptoNite-Smart-Contracts\CryptoNova):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_54_private.json"
//   node scripts/diag_keeper_queue.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function die(m) { console.log(m); process.exit(1); }
const BOOK = (process.env.ADDRESSES_FILE || "").trim();
if (!BOOK) die("ADDRESSES_FILE not set.");
const RPC = (process.env.BASE_SEPOLIA_RPC_URL || "").trim();
if (!RPC) die("BASE_SEPOLIA_RPC_URL not set in .env.");
const A = JSON.parse(fs.readFileSync(path.join(__dirname, BOOK), "utf8"));
if (!A.matrixKeeper) die(`no matrixKeeper in ${BOOK}`);

const LABEL = new Map();
(function walk(o, pre) {
  for (const [k, v] of Object.entries(o || {})) {
    const n = pre ? `${pre}.${k}` : k;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) { if (!LABEL.has(v.toLowerCase())) LABEL.set(v.toLowerCase(), n); }
    else if (v && typeof v === "object") walk(v, n);
  }
})(A, "");
const lab = a => LABEL.get(String(a).toLowerCase()) || `${a.slice(0, 8)}…${a.slice(-4)}`;

const NAMES = ["VELOCITY", "GHOST", "RECLAIM", "CHAIN_LINK", "PARKED_RESCUE", "VELOCITY_GATE",
               "EVICT_PARKED", "DISTRIBUTE_CW", "FORCE_ROTATE", "ADVANCE_EPOCH"];

// V8.55 (session 88): the FUND's own reserve, printed with the queue. The head-of-line
// block measured on 2026-09-17 was invisible from the queue alone — every item read
// "FAILS revert: SF: below floor" and nothing said what the floor WAS.
const SF = new ethers.Interface([
  "function totalBalance() view returns (uint256)",
  "function stabilityFloor() view returns (uint256)",
  "function sfTarget() view returns (uint256)",
]);
const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);

const MK = new ethers.Interface([
  "function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)",
  "function _doParkedRescueExternal(address matrix, address member, uint8 t)",
  "function _doEvictParkedExternal(address matrix, address member)",
  "function _doForceRotateExternal(address matB)",
  "function _doVelocityGateExternal(uint8 t)",
]);

// custom-error decoding from every compiled ABI, so a custom error is named, not shown as hex
const ERRS = new Map();
(function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { scan(p); continue; }
    if (!f.name.endsWith(".json") || f.name.endsWith(".dbg.json")) continue;
    let j; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (!Array.isArray(j.abi)) continue;
    const errs = j.abi.filter(x => x.type === "error");
    if (!errs.length) continue;
    const i = new ethers.Interface(errs);
    for (const e of i.fragments.filter(x => x.type === "error")) ERRS.set(e.selector, i);
  }
})(path.join(__dirname, "..", "artifacts", "contracts"));

function reasonOf(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    const sel = data.slice(0, 10);
    if (sel === "0x08c379a0") { try { return "revert: " + ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]; } catch {} }
    if (sel === "0x4e487b71") { try { return "panic 0x" + ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10))[0].toString(16); } catch {} }
    const i = ERRS.get(sel);
    if (i) { try { const d = i.parseError(data); return `custom error ${d.name}(${d.args.map(String).join(", ")})`; } catch {} }
    return `revert data ${data.slice(0, 74)}`;
  }
  return "revert (no data): " + (e?.shortMessage || e?.message || "unknown").slice(0, 90);
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: ethers.Network.from(84532) });
  const head = await p.getBlockNumber();
  console.log("=".repeat(96));
  console.log("diag_keeper_queue.js — READ-ONLY (eth_call simulations). Nothing is signed or sent.");
  console.log(`book ${BOOK} | MatrixKeeper ${A.matrixKeeper} | block ${head} | rpc host ${new URL(RPC).host}`);
  console.log("=".repeat(96));

  // ── the fund, first, because it is the reason an item fails ──────────────────
  // A read that fails prints so and is never reported as a number.
  let spendable = null;
  if (A.stabilityFund) {
    try {
      const [tb] = SF.decodeFunctionResult("totalBalance",
        await p.call({ to: A.stabilityFund, data: SF.encodeFunctionData("totalBalance", []), blockTag: head }));
      const [fl] = SF.decodeFunctionResult("stabilityFloor",
        await p.call({ to: A.stabilityFund, data: SF.encodeFunctionData("stabilityFloor", []), blockTag: head }));
      spendable = tb > fl ? tb - fl : 0n;
      console.log(`StabilityFund ${A.stabilityFund}`);
      console.log(`  balance ${usd(tb)} · stabilityFloor ${usd(fl)} · SPENDABLE ${usd(spendable)}` +
                  (spendable === 0n ? "   ⛔ AT THE FLOOR — every loan-bearing rescue will revert 'SF: below floor'" : ""));
      // Session 92: setStabilityFloor requires floor <= sfTarget(), so sfTarget bounds how close to the
      // balance the floor can be put. Printed because the V8.55 on-chain proof moves the floor.
      try {
        const [tg] = SF.decodeFunctionResult("sfTarget",
          await p.call({ to: A.stabilityFund, data: SF.encodeFunctionData("sfTarget", []), blockTag: head }));
        console.log(`  sfTarget ${usd(tg)}  (the floor may be set no higher than this)`);
      } catch (e) {
        console.log("  sfTarget UNREADABLE — " + (e.shortMessage || e.message).slice(0, 80));
      }
      console.log("=".repeat(96));
    } catch (e) {
      console.log("StabilityFund: balance/floor UNREADABLE — " + (e.shortMessage || e.message).slice(0, 80));
      console.log("=".repeat(96));
    }
  }

  const raw = await p.call({ to: A.matrixKeeper, data: MK.encodeFunctionData("checkUpkeep", ["0x"]), blockTag: head });
  const [needed, performData] = MK.decodeFunctionResult("checkUpkeep", raw);
  console.log(`checkUpkeep: upkeepNeeded=${needed}  performData ${ (performData.length - 2) / 2 } bytes`);
  if (!needed || performData === "0x") { console.log("no work reported."); return; }

  const items = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"], performData)[0];
  console.log(`items the keeper would send now: ${items.length}\n`);

  let i = 0, belowFloor = 0;
  for (const it of items) {
    i++;
    const wt = Number(it.workType), t = Number(it.tierIndex);
    let data = null;
    if (wt === 4) data = MK.encodeFunctionData("_doParkedRescueExternal", [it.addr1, it.addr2, t]);
    else if (wt === 6) data = MK.encodeFunctionData("_doEvictParkedExternal", [it.addr1, it.addr2]);
    else if (wt === 8) data = MK.encodeFunctionData("_doForceRotateExternal", [it.addr1]);
    else if (wt === 5) data = MK.encodeFunctionData("_doVelocityGateExternal", [t]);
    const head2 = `#${i} ${String(NAMES[wt] || "type" + wt).padEnd(14)} tier ${t}  addr1 ${lab(it.addr1)}  addr2 ${lab(it.addr2)}`;
    if (!data) { console.log(`${head2}\n     NOT SIMULATED (worker type ${wt} not covered by this tool)`); continue; }
    try {
      await p.call({ from: A.matrixKeeper, to: A.matrixKeeper, data, blockTag: head });
      console.log(`${head2}\n     simulated: OK`);
    } catch (e) {
      const why = reasonOf(e);
      if (why.includes("SF: below floor")) belowFloor++;
      console.log(`${head2}\n     simulated: FAILS  ${why}`);
    }
  }

  // ── the exposure verdict, stated rather than left to the reader ───────────────
  console.log("\n" + "=".repeat(96));
  if (belowFloor > 0) {
    console.log(`⛔⛔ EXPOSED: ${belowFloor} of ${items.length} queued item(s) revert "SF: below floor".`);
    console.log("   On contracts BEFORE V8.55 the failed item is swallowed as WorkItemFailed and NOT");
    console.log("   dequeued, so at maxItemsPerUpkeep = 1 it is re-offered at the head every tick and");
    console.log("   nothing behind it runs. Cure: fund the SF (topup_sf.js) or lower stabilityFloor.");
  } else if (spendable === 0n) {
    console.log("⚠ Spendable is $0.00 but no queued item is asking the fund for money right now.");
    console.log("  NOT exposed at this block; it becomes exposed the moment a loan-bearing rescue is queued.");
  } else {
    console.log("✅ No queued item is refused by the fund's floor at this block.");
  }
  console.log("Done. Nothing was signed or sent.");
}
main().catch(e => die("FAILED: " + (e.shortMessage || e.message)));
