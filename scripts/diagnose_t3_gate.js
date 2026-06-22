"use strict";
/**
 * diagnose_t3_gate.js — root-cause the recurring "T3 doesn't auto-open after
 * T2 MatB crossing" bug on the LIVE V8.18 deployment.
 *
 * Plain ethers (no hardhat) so it can run with: node scripts/diagnose_t3_gate.js
 * Reads BASE_SEPOLIA_RPC from .env.
 *
 * Optionally pass a member address to check their specific cross/upgrade state:
 *   node scripts/diagnose_t3_gate.js 0xMemberAddress
 */
const { ethers } = require("ethers");
require("dotenv").config();

const addrs = require("./deployed_addresses_v8_18.json");

const TR_ABI = [
  "function getVelocityGates() view returns (bool[10])",
  "function authorizedMatrices(address) view returns (bool)",
  "function matrixTierIndex(address) view returns (uint8)",
  "function tierPairManagers(uint256) view returns (address)",
  "function tierMatrixAAddr(uint256) view returns (address)",
  "function tierMatrixBAddr(uint256) view returns (address)",
  "function tierCycles(address,uint8) view returns (uint256)",
  "function memberHighestTier(address) view returns (uint8)",
  "function systemPaused() view returns (bool)",
];
const MAT_ABI = [
  "function occupancy() view returns (uint256)",
  "function isActiveInMatrix(address) view returns (bool)",
  "function tierRouter() view returns (address)",
];

async function main() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const tr = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);
  const t2matA = new ethers.Contract(addrs.tiers.T2.matA, MAT_ABI, provider);
  const t2matB = new ethers.Contract(addrs.tiers.T2.matB, MAT_ABI, provider);
  const t3matA = new ethers.Contract(addrs.tiers.T3.matA, MAT_ABI, provider);
  const t3matB = new ethers.Contract(addrs.tiers.T3.matB, MAT_ABI, provider);

  console.log("── Wiring sanity (TierRouter view of T2 MatB) ──────────────");
  const [authT2MatB, tierIdxT2MatB, t2matBTierRouter, pairMgrT3, matAaddrT3, matBaddrT3] = await Promise.all([
    tr.authorizedMatrices(addrs.tiers.T2.matB),
    tr.matrixTierIndex(addrs.tiers.T2.matB),
    t2matB.tierRouter(),
    tr.tierPairManagers(2),
    tr.tierMatrixAAddr(2),
    tr.tierMatrixBAddr(2),
  ]);
  console.log("authorizedMatrices[T2.matB]:      ", authT2MatB, " (expect true)");
  console.log("matrixTierIndex[T2.matB]:         ", tierIdxT2MatB, " (expect 1)");
  console.log("T2.matB.tierRouter():             ", t2matBTierRouter, " (expect", addrs.tierRouter, ")");
  console.log("TierRouter.tierPairManagers(2):   ", pairMgrT3, " (expect", addrs.tiers.T3.pm, ")");
  console.log("TierRouter.tierMatrixAAddr(2):    ", matAaddrT3, " (expect", addrs.tiers.T3.matA, ")");
  console.log("TierRouter.tierMatrixBAddr(2):    ", matBaddrT3, " (expect", addrs.tiers.T3.matB, ")");

  console.log("\n── Velocity gates ───────────────────────────────────────────");
  const gates = await tr.getVelocityGates();
  gates.forEach((g, i) => console.log(`  T${i + 1} gate: ${g ? "OPEN" : "CLOSED"}`));

  console.log("\n── Occupancy ────────────────────────────────────────────────");
  const [t2aOcc, t2bOcc, t3aOcc, t3bOcc, paused] = await Promise.all([
    t2matA.occupancy(),
    t2matB.occupancy(),
    t3matA.occupancy(),
    t3matB.occupancy(),
    tr.systemPaused(),
  ]);
  console.log("T2 MatA occupancy: ", t2aOcc.toString(), "/127");
  console.log("T2 MatB occupancy: ", t2bOcc.toString(), "/127");
  console.log("T3 MatA occupancy: ", t3aOcc.toString(), "/127");
  console.log("T3 MatB occupancy: ", t3bOcc.toString(), "/127");
  console.log("systemPaused:      ", paused);

  const memberArg = process.argv[2];
  if (memberArg) {
    console.log(`\n── Member-specific check: ${memberArg} ──────────────────────`);
    const [inT2MatB, inT3MatA, cyclesT2, highest] = await Promise.all([
      t2matB.isActiveInMatrix(memberArg),
      t3matA.isActiveInMatrix(memberArg),
      tr.tierCycles(memberArg, 1),
      tr.memberHighestTier(memberArg),
    ]);
    console.log("In T2 MatB:        ", inT2MatB);
    console.log("In T3 MatA:        ", inT3MatA);
    console.log("T2 tierCycles:     ", cyclesT2.toString());
    console.log("memberHighestTier: ", highest);
  } else {
    console.log("\n(Tip: pass a member address as an arg to check their specific cross state)");
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
