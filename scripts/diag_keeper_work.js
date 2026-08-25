// diag_keeper_work.js — deploy-day diagnostic (2026-08-13): the VPS
// direct_keeper finds work on the FRESH V8.48 deployment and every
// performUpkeep REVERTS (cap halved 2->1->1). This decodes what checkUpkeep
// actually returns and captures the revert reason of performUpkeep.
//
// Read-only (staticCall only). No key needed. Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\diag_keeper_work.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

require("./rpc_resilience");   // 29.2: Base Sepolia sheds state reads; retry + endpoint fail-over
const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const WORK = ["VELOCITY","GHOST","RECLAIM","CHAIN_LINK","PARKED_RESCUE","VELOCITY_GATE","EVICT_PARKED","DISTRIBUTE_CW","FORCE_ROTATE","ADVANCE_EPOCH"];

const KEEPER_ABI = [
  "function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)",
  "function performUpkeep(bytes)",
  // 2026-08-25: the three routes performUpkeep accepts (MatrixKeeper.sol:914). Read
  // them so an auth refusal can never again be mistaken for a finding about the chain.
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function upkeepCaller(address) view returns (bool)",
  "function maxItemsPerUpkeep() view returns (uint256)",
  "function minGasPerItem() view returns (uint256)",
];

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const k = new ethers.Contract(A.matrixKeeper, KEEPER_ABI, p);
  console.log(`block ${await p.getBlockNumber()}   keeper: ${A.matrixKeeper}\n`);

  // ⛔ ADDED 2026-08-25: STATE THE CONFIGURATION THE RUN MEASURED IN.
  //    A batch of exactly N items is the signature of maxItemsPerUpkeep = N, and the
  //    V8.50 SOURCE ships 1 while live V8.48 reads 15 (handoff 39.0) — three different
  //    worlds. PHASE G G.4's pass condition depends on which one the chain is in, so the
  //    run must SAY, not leave it to be inferred from the item count.
  //    Both getters can be ABSENT from an older deployment: minGasPerItem postdates the
  //    2026-08-13 V8.48 deploy. A missing getter and a reverting one look identical over
  //    RPC and mean opposite things, so "unreadable" is printed, never a number.
  let cap = null, floorGas = null;
  try { cap = await k.maxItemsPerUpkeep(); } catch (_) {}
  try { floorGas = await k.minGasPerItem(); } catch (_) {}
  console.log("config on THIS deployment:");
  console.log(`  maxItemsPerUpkeep : ${cap === null ? "unreadable / absent from bytecode" : cap.toString()}`);
  console.log(`  minGasPerItem     : ${floorGas === null ? "unreadable / absent from bytecode" : Number(floorGas).toLocaleString()}`);
  if (cap !== null && cap !== 1n) {
    console.log(`  ⚠ cap is ${cap} — the V8.50 SOURCE default is 1. A gas measurement taken here`);
    console.log("     describes a batched world, not the one V8.50 deploys with. Say so in the result.");
  }
  console.log("");

  const [needed, performData] = await k.checkUpkeep("0x");
  console.log(`upkeepNeeded: ${needed}`);
  if (!needed) { console.log("No work discovered — nothing to diagnose (the VPS run may race a state change)."); return; }

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [items] = coder.decode(["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"], performData);
  console.log(`work items: ${items.length}`);
  for (const it of items) {
    const wt = Number(it.workType);
    console.log(`  - ${WORK[wt] || "UNKNOWN(" + wt + ")"}  tier=T${Number(it.tierIndex) + 1}  addr1=${it.addr1}  addr2=${it.addr2}`);
  }

  // Now try the whole batch, then each item alone, as an AUTHORISED caller would.
  //
  // ⛔ FIXED 2026-08-25 (session 40). This was HARDCODED to the live V8.48 VPS keeper
  //    EOA 0xd419681B... Pointed at the private V8.50 deployment — where that EOA was
  //    never granted — every one of 20 items returned "MK: not authorized keeper", which
  //    reads exactly like a real finding about that chain's configuration and is not one.
  //    The whole simulation half of that run was void while looking perfectly plausible.
  //    Same family as fund_testers.js's dead v8_45 default (handoff 39.4): a constant
  //    baked into an instrument silently voids it the moment it is aimed somewhere else.
  //    Now: FROM env override, else the deployment's own deployer/admin (owner() passes
  //    the auth check), and the resolved value plus WHY is printed on every run.
  const FROM = process.env.FROM || A.deployer || A.admin;
  if (!FROM) { console.log("FATAL: no FROM — set $env:FROM or add deployer/admin to the addresses file"); process.exit(1); }

  // Prove FROM is actually allowed BEFORE simulating, so a refusal is never ambiguous.
  let owner = "?", gov = "?", isCaller = null;
  try { owner = await k.owner(); } catch (e) { console.log(`  owner() unreadable: ${e.shortMessage || e.message}`); }
  try { gov   = await k.governance(); } catch (e) { console.log(`  governance() unreadable: ${e.shortMessage || e.message}`); }
  try { isCaller = await k.upkeepCaller(FROM); } catch (e) { console.log(`  upkeepCaller() unreadable: ${e.shortMessage || e.message}`); }
  const eq = (a, b2) => a && b2 && String(a).toLowerCase() === String(b2).toLowerCase();
  const why = eq(FROM, owner) ? "owner()" : eq(FROM, gov) ? "governance" : isCaller === true ? "upkeepCaller grant" : null;
  console.log(`\nsimulating AS ${FROM}`);
  console.log(`  source        : ${process.env.FROM ? "$env:FROM" : "addresses file deployer/admin"}`);
  console.log(`  owner()       : ${owner}`);
  console.log(`  governance    : ${gov}`);
  console.log(`  upkeepCaller  : ${isCaller === null ? "unreadable" : isCaller}`);
  if (why) {
    console.log(`  AUTHORISED via ${why} — a revert below is about the WORK, not the caller.`);
  } else {
    console.log("  ⛔ NOT AUTHORISED on this deployment. Every item below will return");
    console.log("     \"MK: not authorized keeper\" and NONE of it is a finding about the chain.");
    console.log("     Set $env:FROM to owner/governance/a granted caller and re-run.");
  }
  // ⛔ 2026-08-25: was 12,000,000 — BELOW the 14.67M worst live per-item sample (30.10),
  //    so a perfectly healthy dear rescue could staticCall out of gas and be written up as
  //    a revert. Sized above the worst observed item; print it so the basis is never guessed.
  const SIM_GAS = Number(process.env.SIM_GAS || 16_500_000);
  console.log(`  simulation gasLimit: ${SIM_GAS.toLocaleString()} (override with $env:SIM_GAS)`);
  async function tryPerform(list, label) {
    const data = coder.encode(["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"], [list]);
    try {
      await k.performUpkeep.staticCall(data, { from: FROM, gasLimit: SIM_GAS });
      console.log(`  ${label}: would SUCCEED`);
    } catch (e) {
      const reason = e.reason || e.shortMessage || e.message;
      const errData = e.data || (e.info && e.info.error && e.info.error.data) || "0x";
      console.log(`  ${label}: REVERTS -> ${String(reason).slice(0, 100)}   raw: ${String(errData).slice(0, 74)}`);
    }
  }

  console.log("\nperformUpkeep simulation (staticCall as keeper wallet):");
  // ⚠ A SUCCEEDING FULL BATCH IS NOT PROOF THE BATCH DID THE WORK. BatchGasHalted makes
  //    performUpkeep SUCCEED with processed < total — that is the gas guard working. A
  //    staticCall cannot tell "all N done" from "halted after 2". Only a real transaction
  //    receipt, with its events, answers that. Do not read the line below as completion.
  await tryPerform(items, "FULL BATCH (success != all items processed — see note above)");
  if (items.length > 1) {
    for (let i = 0; i < items.length; i++) {
      await tryPerform([items[i]], `item ${i} (${WORK[Number(items[i].workType)]})`);
    }
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
