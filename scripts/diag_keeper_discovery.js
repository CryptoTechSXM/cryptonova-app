// diag_keeper_discovery.js — is item 12 real work, or already done?
//
// THE QUESTION
//   AUTOMATION_AUDIT.md (2026-08-09) states as its central finding that checkUpkeep
//   can discover only 6 of the 10 work types, and that WORK_GHOST, WORK_RECLAIM,
//   WORK_PARKED_RESCUE and WORK_EVICT_PARKED are "executable but undiscoverable".
//   Item 12 exists to add that discovery and retire copay_rescue, fastlane_rescue
//   and evict_parked.
//
//   That finding does not match the source. `git log -S` puts _scanMatrix (GHOST /
//   RECLAIM) in checkUpkeep since V8.1 and _checkParked (PARKED_RESCUE /
//   EVICT_PARKED) since V8.10 — both long before the audit was written. A local
//   fixture confirms it: with 25 members registered and the clock advanced,
//   checkUpkeep returns RECLAIM and PARKED_RESCUE items.
//
//   So either the audit is wrong, or the discovery code exists but never fires on
//   the LIVE deployment. Those two possibilities call for completely different
//   work, and guessing between them would mean writing a feature that already
//   ships. This script asks the chain.
//
// WHAT IS TREATED AS TRUTH
//   checkUpkeep's OWN output. This script does NOT re-implement _checkParked to
//   decide what "should" be queued — a second implementation of the rule is how
//   this project got a "claim on the 25th" gate that the contract never had. The
//   contract's answer is the answer; everything else printed here is the INPUT to
//   that answer, so a surprising result can be explained rather than argued with.
//
// Run: npx hardhat run scripts/diag_keeper_discovery.js --network baseSepolia
//   ADDRESSES_FILE=deployed_addresses_v8_47.json   (default)
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const KEEPER = [
  "function configuredTierCount() view returns (uint8)",
  "function pairManagerForTier(uint8) view returns (address)",
  "function maxItemsPerUpkeep() view returns (uint256)",
  "function parkedGracePeriod() view returns (uint256)",
  "function idleSlotTimeout() view returns (uint256)",
  "function extendedIdleTimeout() view returns (uint256)",
  "function rescueRatioBps() view returns (uint256)",
  "function frozenMatBTimeout() view returns (uint256)",
  "function velocityWindow() view returns (uint256)",
  "function lastVelocityCheck() view returns (uint256)",
  "function pendingChainLinkCount() view returns (uint256)",
  "function communityWallet() view returns (address)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
];
const PM = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
  "function MATRIX_SIZE() view returns (uint256)",
  "function isMatrixA() view returns (bool)",
];

const WORK = {
  0: "VELOCITY", 1: "GHOST", 2: "RECLAIM", 3: "CHAIN_LINK", 4: "PARKED_RESCUE",
  5: "VELOCITY_GATE", 6: "EVICT_PARKED", 7: "DISTRIBUTE_CW", 8: "FORCE_ROTATE",
  9: "ADVANCE_EPOCH",
};
// The four the audit calls undiscoverable.
const DISPUTED = [1, 2, 4, 6];

const hrs = (s) => (Number(s) / 3600).toFixed(1) + "h";

async function main() {
  const p = ethers.provider;
  const keeperAddr = A.matrixKeeper || A.MatrixKeeper;
  const k = new ethers.Contract(keeperAddr, KEEPER, p);
  const now = (await p.getBlock("latest")).timestamp;

  console.log("\n  MatrixKeeper:", keeperAddr);
  console.log("  block time:  ", new Date(now * 1000).toISOString());

  // ── 1. Is the keeper even configured to scan? ─────────────────────────────
  // If configuredTierCount is 0, every scan loop in checkUpkeep is skipped and
  // NOTHING is discoverable — which would make the audit right in effect and
  // wrong in cause, and the fix a one-line setPairManager rather than a feature.
  console.log("\n  ── CONFIGURATION (if this is wrong, no scan runs at all) ──");
  const n = Number(await k.configuredTierCount());
  console.log(`    configuredTierCount : ${n}${n === 0 ? "   <<< ZERO — every scan loop is skipped" : ""}`);
  console.log(`    maxItemsPerUpkeep   : ${await k.maxItemsPerUpkeep()}`);
  console.log(`    parkedGracePeriod   : ${hrs(await k.parkedGracePeriod())}`);
  console.log(`    idleSlotTimeout     : ${hrs(await k.idleSlotTimeout())}`);
  console.log(`    extendedIdleTimeout : ${hrs(await k.extendedIdleTimeout())}`);
  console.log(`    rescueRatioBps      : ${await k.rescueRatioBps()}`);
  console.log(`    frozenMatBTimeout   : ${hrs(await k.frozenMatBTimeout())}`);
  console.log(`    pendingChainLinks   : ${await k.pendingChainLinkCount()}`);
  console.log(`    communityWallet     : ${await k.communityWallet()}`);

  const maxItems = Number(await k.maxItemsPerUpkeep());
  const grace = Number(await k.parkedGracePeriod());

  // ── 2. Is there anything to find? ─────────────────────────────────────────
  console.log("\n  ── PARKED CENSUS (the work the audit says cannot be found) ──");
  let totalParked = 0, pastGrace = 0, matrices = 0, unsetTiers = [];
  for (let t = 0; t < 10; t++) {
    const pmAddr = await k.pairManagerForTier(t).catch(() => ethers.ZeroAddress);
    if (!pmAddr || pmAddr === ethers.ZeroAddress) { unsetTiers.push(t + 1); continue; }
    const pm = new ethers.Contract(pmAddr, PM, p);
    const pc = Number(await pm.activePairCount().catch(() => 0n));
    let tierParked = 0, tierPast = 0, detail = [];
    for (let i = 0; i < pc; i++) {
      const [a, b] = await pm.getPairAt(i);
      for (const [lbl, m] of [["A", a], ["B", b]]) {
        if (!m || m === ethers.ZeroAddress) continue;
        matrices++;
        const mx = new ethers.Contract(m, MX, p);
        const [pk, occ, rot, sz] = await Promise.all([
          mx.getParkedCount().catch(() => 0n), mx.occupancy().catch(() => 0n),
          mx.rotationCount().catch(() => 0n), mx.MATRIX_SIZE().catch(() => 0n),
        ]);
        tierParked += Number(pk);
        for (let q = 0; q < Number(pk); q++) {
          const mem = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
          if (mem === ethers.ZeroAddress) continue;
          const ts = Number(await mx.parkedAt(mem).catch(() => 0n));
          if (ts > 0 && now - ts >= grace) tierPast++;
        }
        if (Number(pk) > 0 || Number(occ) > 0) {
          detail.push(`p${i}${lbl} occ=${occ}/${sz} rot=${rot} parked=${pk}`);
        }
      }
    }
    totalParked += tierParked; pastGrace += tierPast;
    console.log(`    T${t + 1}: pairs=${pc} parked=${tierParked} pastGrace=${tierPast}`);
    for (const d of detail) console.log(`         ${d}`);
  }
  if (unsetTiers.length) console.log(`    pairManagerForTier NOT SET for tiers: ${unsetTiers.join(", ")}`);
  console.log(`\n    matrices scanned: ${matrices}   parked: ${totalParked}   past grace: ${pastGrace}`);

  // ── 3. What does the contract itself say? ─────────────────────────────────
  console.log("\n  ── checkUpkeep() — THE CONTRACT'S OWN ANSWER ──");
  let needed = false, data = "0x";
  try {
    [needed, data] = await k.checkUpkeep("0x");
  } catch (e) {
    console.log(`    REVERTED: ${e.shortMessage || e.message}`);
    console.log("    A reverting checkUpkeep reads to Chainlink as 'no work' — silently.");
    return;
  }
  const items = data === "0x" ? []
    : ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"], data)[0];
  const counts = {};
  for (const i of items) counts[Number(i.workType)] = (counts[Number(i.workType)] || 0) + 1;

  console.log(`    upkeepNeeded: ${needed}   items: ${items.length} / maxItems ${maxItems}` +
    (items.length >= maxItems ? "   <<< BATCH IS FULL" : ""));
  for (const [w, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${WORK[w].padEnd(14)} x${c}`);
  }
  if (items.length === 0) console.log("      (none)");

  // ── 4. The verdict ────────────────────────────────────────────────────────
  console.log("\n  ── VERDICT ON ITEM 12 ──");
  const found = DISPUTED.filter((w) => counts[w]);
  if (found.length) {
    console.log(`    checkUpkeep IS discovering ${found.map((w) => WORK[w]).join(", ")}.`);
    console.log("    The audit's central finding is WRONG for these types. Item 12 is not");
    console.log("    'add discovery' — it is 'confirm the three keepers are redundant and");
    console.log("    retire them', which is a smaller and mostly operational change.");
  } else if (totalParked === 0 && pastGrace === 0) {
    console.log("    Nothing is parked right now, so the parked path CANNOT be observed");
    console.log("    either way from this run. Not evidence for the audit. Re-run when the");
    console.log("    parked census above is non-zero before concluding anything.");
  } else if (items.length >= maxItems) {
    console.log(`    ${pastGrace} member(s) are past the grace period, but the batch is FULL at`);
    console.log(`    ${maxItems} items with other work. Discovery is not missing — it is being`);
    console.log("    CROWDED OUT. That makes item 12 a prioritisation problem (parked");
    console.log("    rescues starved behind velocity/chain-link/rotate items), not a");
    console.log("    discovery problem, and the fix is ordering or a larger batch.");
  } else {
    console.log(`    ${pastGrace} member(s) past grace, batch NOT full, yet no parked work queued.`);
    console.log("    THIS is the case the audit describes. Next thing to check is the");
    console.log("    StabilityFund balance per tier: _checkParked drops a member entirely when");
    console.log("    SF cannot cover the rescue share, and returns EVICT only when the member");
    console.log("    has withdrawn past rescueRatioBps.");
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
