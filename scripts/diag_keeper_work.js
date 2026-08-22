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
];

(async () => {
  if (!RPC) { console.log("FATAL: no RPC in .env"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const k = new ethers.Contract(A.matrixKeeper, KEEPER_ABI, p);
  console.log(`block ${await p.getBlockNumber()}   keeper: ${A.matrixKeeper}\n`);

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

  // Now try the whole batch, then each item alone, as the keeper wallet would.
  const FROM = "0xd419681BA72992636f05e256168681c939826B4b"; // VPS keeper signer
  async function tryPerform(list, label) {
    const data = coder.encode(["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"], [list]);
    try {
      await k.performUpkeep.staticCall(data, { from: FROM, gasLimit: 12_000_000 });
      console.log(`  ${label}: would SUCCEED`);
    } catch (e) {
      const reason = e.reason || e.shortMessage || e.message;
      const errData = e.data || (e.info && e.info.error && e.info.error.data) || "0x";
      console.log(`  ${label}: REVERTS -> ${String(reason).slice(0, 100)}   raw: ${String(errData).slice(0, 74)}`);
    }
  }

  console.log("\nperformUpkeep simulation (staticCall as keeper wallet):");
  await tryPerform(items, "FULL BATCH");
  if (items.length > 1) {
    for (let i = 0; i < items.length; i++) {
      await tryPerform([items[i]], `item ${i} (${WORK[Number(items[i].workType)]})`);
    }
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
