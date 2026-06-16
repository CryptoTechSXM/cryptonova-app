"use strict";
/**
 * fix_set_tier_matrices.js — post-deploy hotfix for V8.15
 *
 * deploy_v8.js calls registerTier(tierIndex, pairManager, fee) which sets
 * tierPairManagers and tierEntryFees, but never calls setTierMatrices() which
 * sets tierMatrixAAddr and tierMatrixBAddr. Without those, manualUpgrade()
 * can't check inPrevMatB → always reverts "cross to MatB first".
 *
 * This script calls setTierMatrices for all 10 tiers on the live deployment.
 *
 * Run:
 *   npx hardhat run scripts/fix_set_tier_matrices.js --network baseSepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const addrs = require("./deployed_addresses_v8_12.json");
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("TierRouter:", addrs.tierRouter);

  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter, deployer);

  const tiers = [
    { idx: 0, label: 'T1',  matA: addrs.tiers.T1.matA,  matB: addrs.tiers.T1.matB  },
    { idx: 1, label: 'T2',  matA: addrs.tiers.T2.matA,  matB: addrs.tiers.T2.matB  },
    { idx: 2, label: 'T3',  matA: addrs.tiers.T3.matA,  matB: addrs.tiers.T3.matB  },
    { idx: 3, label: 'T4',  matA: addrs.tiers.T4.matA,  matB: addrs.tiers.T4.matB  },
    { idx: 4, label: 'T5',  matA: addrs.tiers.T5.matA,  matB: addrs.tiers.T5.matB  },
    { idx: 5, label: 'T6',  matA: addrs.tiers.T6.matA,  matB: addrs.tiers.T6.matB  },
    { idx: 6, label: 'T7',  matA: addrs.tiers.T7.matA,  matB: addrs.tiers.T7.matB  },
    { idx: 7, label: 'T8',  matA: addrs.tiers.T8.matA,  matB: addrs.tiers.T8.matB  },
    { idx: 8, label: 'T9',  matA: addrs.tiers.T9.matA,  matB: addrs.tiers.T9.matB  },
    { idx: 9, label: 'T10', matA: addrs.tiers.T10.matA, matB: addrs.tiers.T10.matB },
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  console.log("\nCalling setTierMatrices for all 10 tiers...\n");

  for (const t of tiers) {
    // Skip if already set correctly
    const current = await tr.tierMatrixBAddr(t.idx);
    if (current.toLowerCase() === t.matB.toLowerCase()) {
      console.log(`  ${t.label} (idx ${t.idx}): already set ✅ (skipping)`);
      continue;
    }
    process.stdout.write(`  ${t.label} (idx ${t.idx}): matA=${t.matA.slice(0,10)}... matB=${t.matB.slice(0,10)}... `);
    const tx = await tr.setTierMatrices(t.idx, t.matA, t.matB);
    await tx.wait();
    console.log("✅");
    await sleep(1500); // avoid in-flight TX limit on public RPC
  }

  // Verify
  console.log("\n── Verification ──");
  for (const t of tiers) {
    const storedB = await tr.tierMatrixBAddr(t.idx);
    const ok = storedB.toLowerCase() === t.matB.toLowerCase();
    console.log(`  ${t.label} matB: ${storedB.slice(0,10)}... ${ok ? '✅' : '❌ MISMATCH'}`);
  }

  console.log("\n✅ All tier matrices set. manualUpgrade() should now work.");
  console.log("   Run simulate_upgrade.js to confirm W1 upgrade passes.");
}

main().catch(e => { console.error(e); process.exit(1); });
