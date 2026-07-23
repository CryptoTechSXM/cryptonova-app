// mint_verify.js — V8.43 item 3: verify CNOVA minting integrity
//
// Checks, per tier and per matrix:
//   1. Does every matrix contract hold MINTER_ROLE on CNOVAToken?
//      (mintReward is wrapped in try/catch in MatrixLogicLib — a missing role
//       fails SILENTLY and the member never gets their mint.)
//   2. Entries vs mints: count MemberEntered events per matrix and compare
//      with TokensMinted events per tier. entries > mints = lost mints.
//
// Run:  node mint_verify.js
// Env:  BASE_SEPOLIA_RPC_URL, ADDRESSES_FILE (default deployed_addresses_v8_41.json)

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const RPC_URL    = process.env.BASE_SEPOLIA_RPC_URL;
const ADDRS_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_41.json";
const CHUNK      = 9_000; // getLogs block chunk (public RPC limit 10k)

const PM_ABI = [
  "function pairCount() external view returns (uint256)",
  "function getPairAt(uint256) external view returns (address matA, address matB)",
];
const CNOVA_ABI = [
  "function MINTER_ROLE() external view returns (bytes32)",
  "function hasRole(bytes32, address) external view returns (bool)",
];
const EV_ENTERED = "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)";
const EV_MINTED  = "event TokensMinted(address indexed to, uint256 amount, uint8 epoch, uint8 tierIndex)";

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    try {
      logs.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
    } catch (e) {
      console.log(`  WARN getLogs ${start}-${end}: ${(e.message || "").slice(0, 80)}`);
    }
  }
  return logs;
}

async function main() {
  if (!RPC_URL) { console.error("Missing BASE_SEPOLIA_RPC_URL"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const addrs    = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRS_FILE), "utf8"));
  const cnova    = new ethers.Contract(addrs.cnovaToken || addrs.cnova, CNOVA_ABI, provider);
  const iEntered = new ethers.Interface([EV_ENTERED]);
  const iMinted  = new ethers.Interface([EV_MINTED]);

  const latest = await provider.getBlockNumber();
  // Scan window: from deploy block if recorded, else last ~3 days (Base ~2s blocks)
  const fromBlock = Number(addrs.deployBlock || 0) || Math.max(0, latest - 130_000);
  console.log(`Addresses: ${ADDRS_FILE}`);
  console.log(`Scan window: block ${fromBlock} → ${latest}\n`);

  const MINTER_ROLE = await cnova.MINTER_ROLE();

  // ── Build matrix list per tier + check MINTER_ROLE ────────────────────────
  const tiers = {}; // tk -> [{addr, kind}]
  let roleFailures = 0;
  for (const tk of ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10"]) {
    const td = addrs.tiers?.[tk];
    if (!td?.pm) continue;
    const pm = new ethers.Contract(td.pm, PM_ABI, provider);
    const list = [];
    const count = Number(await pm.pairCount().catch(() => 0));
    for (let i = 0; i < count; i++) {
      try {
        const [matA, matB] = await pm.getPairAt(i);
        if (matA && matA !== ethers.ZeroAddress) list.push({ addr: matA, kind: `${tk}.${i+1} MatA` });
        if (matB && matB !== ethers.ZeroAddress) list.push({ addr: matB, kind: `${tk}.${i+1} MatB` });
      } catch {}
    }
    tiers[tk] = list;
    for (const m of list) {
      const ok = await cnova.hasRole(MINTER_ROLE, m.addr).catch(() => false);
      if (!ok) { console.log(`❌ NO MINTER_ROLE: ${m.kind} ${m.addr}`); roleFailures++; }
    }
  }
  console.log(roleFailures === 0
    ? "✅ MINTER_ROLE: all matrices can mint\n"
    : `\n🚨 ${roleFailures} matrices CANNOT mint — every entry there loses its CNOVA silently\n`);

  // ── TokensMinted per tier (single scan on CNOVA token) ────────────────────
  const mintTopic = iMinted.getEvent("TokensMinted").topicHash;
  const mintLogs  = await getLogsChunked(provider, { address: await cnova.getAddress(), topics: [mintTopic] }, fromBlock, latest);
  const mintsPerTier = {}; // tierIndex -> count
  for (const lg of mintLogs) {
    try {
      const ev = iMinted.parseLog(lg);
      const ti = Number(ev.args.tierIndex);
      mintsPerTier[ti] = (mintsPerTier[ti] || 0) + 1;
    } catch {}
  }

  // ── MemberEntered per matrix, aggregated per tier ─────────────────────────
  const enterTopic = iEntered.getEvent("MemberEntered").topicHash;
  console.log("Tier | Entries | Mints | Missing");
  console.log("-----|---------|-------|--------");
  let totalMissing = 0;
  for (const tk of Object.keys(tiers)) {
    const ti = parseInt(tk.slice(1)) - 1;
    let entries = 0;
    for (const m of tiers[tk]) {
      const logs = await getLogsChunked(provider, { address: m.addr, topics: [enterTopic] }, fromBlock, latest);
      entries += logs.length;
    }
    const mints   = mintsPerTier[ti] || 0;
    const missing = Math.max(0, entries - mints);
    totalMissing += missing;
    console.log(`${tk.padEnd(4)} | ${String(entries).padEnd(7)} | ${String(mints).padEnd(5)} | ${missing > 0 ? "🚨 " + missing : "0"}`);
  }

  console.log(totalMissing === 0
    ? "\n✅ No lost mints detected in scan window."
    : `\n🚨 ${totalMissing} entries had NO matching mint — investigate role grants + epoch caps.`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
