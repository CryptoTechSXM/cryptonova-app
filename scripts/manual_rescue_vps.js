// manual_rescue.js  (standalone ethers.js — no Hardhat)
// Scans all tiers for parked members and calls performUpkeep with rescue-only performData.
// Run: node manual_rescue.js
// Cron: */5 * * * * cd /root/keeper && node manual_rescue.js >> /root/keeper/rescue.log 2>&1

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── Config ──────────────────────────────────────────────────────────────────
const RPC_URL        = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY    = process.env.KEEPER_PRIVATE_KEY;
const ADDRESSES_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_33.json";

if (!PRIVATE_KEY) { console.error("KEEPER_PRIVATE_KEY not set in .env"); process.exit(1); }

const BATCH               = 3;
const MAX_BATCHES_PER_RUN = 4;
const TIER_KEYS           = ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10"];
const RESCUE_FLOOR_BPS    = 4_000n;
const WI_TYPE             = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
const WORK_PARKED_RESCUE  = 4;

const MK_ABI = [
  "function performUpkeep(bytes calldata performData) external",
  "function checkUpkeep(bytes calldata) external view returns (bool, bytes memory)",
  "function parkedGracePeriod() view returns (uint256)",
];

const MAT_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256 idx) view returns (address)",
  "function isParked(address) view returns (bool)",
  "function parkedAt(address) view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function rescueDebtOf(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRESSES_FILE), "utf8"));

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Signer:", signer.address);

  const mk          = new ethers.Contract(addrs.matrixKeeper, MK_ABI, signer);
  const gracePeriod = await mk.parkedGracePeriod();
  const now         = Math.floor(Date.now() / 1000);
  console.log(`Grace period: ${gracePeriod}s`);

  // ── Scan a single matrix for eligible parked members ─────────────────────
  async function scanParked(matAddr, label, entryFee, tierIdx) {
    const mat   = new ethers.Contract(matAddr, MAT_ABI, provider);
    const total = await mat.getParkedCount();
    if (Number(total) === 0) return [];

    console.log(`\n[T${tierIdx + 1}] ${label}: ${total} parked`);
    const eligible = [];
    let skippedGrace = 0, skippedFloor = 0;

    for (let i = 0; i < Number(total); i++) {
      let member;
      try {
        member = await mat.getParkedMember(i);
      } catch {
        console.log(`  ⚠️  Array shrunk at index ${i} — stopping.`);
        break;
      }

      const isParked = await mat.isParked(member);
      const ts       = await mat.parkedAt(member);
      const age      = now - Number(ts);

      if (!isParked || age < Number(gracePeriod)) {
        skippedGrace++;
        continue;
      }

      const withdrawable     = await mat.withdrawableOf(member);
      const crossRes         = await mat.crossingReserveOf(member).catch(() => 0n);
      const effectiveContrib = BigInt(withdrawable) + BigInt(crossRes);
      const wBps             = entryFee > 0n ? (effectiveContrib * 10_000n) / BigInt(entryFee) : 0n;

      if (wBps < RESCUE_FLOOR_BPS) {
        skippedFloor++;
        console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ❌ (effectiveContrib $${(Number(effectiveContrib)/1e6).toFixed(2)} < 40% floor)`);
        continue;
      }

      eligible.push({ member, matAddr, tierIdx });
      console.log(`  [${i}] ${member.slice(0,10)}… age=${(age/3600).toFixed(1)}h ✅ withdraw=$${(Number(withdrawable)/1e6).toFixed(2)} reserve=$${(Number(crossRes)/1e6).toFixed(2)} total=$${(Number(effectiveContrib)/1e6).toFixed(2)}`);
    }

    if (skippedGrace > 0) console.log(`  ⏳ ${skippedGrace} in grace period`);
    if (skippedFloor > 0) console.log(`  ⚠️  ${skippedFloor} below rescue floor`);
    return eligible;
  }

  // ── Collect across all tiers ──────────────────────────────────────────────
  const allEligible = [];

  for (let t = 0; t < TIER_KEYS.length; t++) {
    const key = TIER_KEYS[t];
    if (!addrs.tiers?.[key]) continue;
    const { matA: matAAddr, matB: matBAddr } = addrs.tiers[key];
    if (!matAAddr || !matBAddr) continue;

    let entryFee = 10_000_000n;
    try {
      const matRef = new ethers.Contract(matAAddr, MAT_ABI, provider);
      entryFee = await matRef.ENTRY_FEE();
    } catch {
      console.log(`  ⚠️  T${t+1}: could not read ENTRY_FEE() — using $10 fallback`);
    }

    const fromB = await scanParked(matBAddr, "MatB", entryFee, t);
    const fromA = await scanParked(matAAddr, "MatA", entryFee, t);
    allEligible.push(...fromB, ...fromA);
  }

  if (allEligible.length === 0) {
    console.log("\nNo eligible members to rescue across any tier.");
    return;
  }

  console.log(`\nTotal eligible for rescue: ${allEligible.length} member(s)`);

  // ── Process in batches ────────────────────────────────────────────────────
  const coder    = ethers.AbiCoder.defaultAbiCoder();
  let batchNum   = 0;

  for (let start = 0; start < allEligible.length; start += BATCH) {
    if (batchNum >= MAX_BATCHES_PER_RUN) {
      console.log(`\nCapped at ${MAX_BATCHES_PER_RUN} batches/run — ${allEligible.length - start} deferred.`);
      break;
    }

    const batch       = allEligible.slice(start, start + BATCH);
    const items       = batch.map(({ member, matAddr, tierIdx }) => ({
      workType:  WORK_PARKED_RESCUE,
      tierIndex: tierIdx,
      addr1:     matAddr,
      addr2:     member,
    }));
    const performData = coder.encode([WI_TYPE], [items]);

    console.log(`\nBatch ${batchNum + 1}: rescuing ${batch.length} member(s)…`);
    batch.forEach(({ member, tierIdx }, i) =>
      console.log(`  ${i+1}. [T${tierIdx+1}] ${member}`)
    );

    try {
      await mk.performUpkeep.staticCall(performData);
      console.log("  Simulation: ✅ OK");
    } catch (e) {
      console.log("  Simulation: ❌ REVERTED —", e.message.slice(0, 200));
      console.log("  Skipping this batch.");
      batchNum++;
      continue;
    }

    const tx      = await mk.performUpkeep(performData, { gasLimit: 14_000_000 });
    console.log("  TX:", tx.hash);
    const receipt = await tx.wait();
    console.log("  Status:", receipt.status === 1 ? "✅ success" : "❌ failed", `gas=${receipt.gasUsed}`);
    batchNum++;
  }

  // ── Post-rescue parked counts ─────────────────────────────────────────────
  console.log("\n── Post-rescue parked counts ──");
  let grandTotal = 0n;
  for (let t = 0; t < TIER_KEYS.length; t++) {
    const key = TIER_KEYS[t];
    if (!addrs.tiers?.[key]) continue;
    const { matA: matAAddr, matB: matBAddr } = addrs.tiers[key];
    if (!matAAddr || !matBAddr) continue;
    const matA = new ethers.Contract(matAAddr, MAT_ABI, provider);
    const matB = new ethers.Contract(matBAddr, MAT_ABI, provider);
    const cA   = await matA.getParkedCount();
    const cB   = await matB.getParkedCount();
    const tot  = BigInt(cA) + BigInt(cB);
    if (tot > 0n) console.log(`  T${t+1}: MatA=${cA}  MatB=${cB}  (${tot})`);
    grandTotal += tot;
  }
  console.log(`  TOTAL: ${grandTotal}`);
}

main().catch(e => { console.error(e); process.exit(1); });
