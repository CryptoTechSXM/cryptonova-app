"use strict";
/**
 * reset_test_wallets.js
 * Resets hasRegistered for all test wallets on ALL 7 tier BeltManagers
 * Run this before each self-test pass to reuse the same wallets
 * Usage: npx hardhat run scripts/reset_test_wallets.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const { PARAMS, TIER_FEE_MULTIPLIERS, USDC_UNIT } = require("./v6_params");

// ── UPDATE THESE ADDRESSES AFTER EACH DEPLOY ──────────────────────────────
const BELT_MANAGERS = [
  "0x8FC04BFc5675428dBC81C0337bf6AF0fe16f4fdc",  // T1 Midscale v2
  "0x8c0D24F5CC12f0C9D4EDDf4Cd047bEb49cc7c8cB",  // T2
  "0x6f41638EA3bd65F5455E9A2D62471a53AE98C144",  // T3
  "0x820F7C625cced214e5febfc876C0e78f33DA8b5B",  // T4
  "0xa62A5Af3CcbdcABA739471ae0Be65Fa24C87DaA6",  // T5
  "0x94b9036d10d4C1feda05A3E054E1b8C21152d055",  // T6
  "0x4EBC6CCf2aa032642729Dbb76b03F141a3074603",  // T7
];

// ── YOUR TEST WALLETS ──────────────────────────────────────────────────────
const TEST_WALLETS = [
  "0x19a59fbD6d2c1289668795D41453e1505B7B8102",
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB",
  "0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2",
  "0xa2Dfd8c3b99b4395550558acf6cFFe79017b702C",
  "0x7a245ED3799D31C0D90BA0cfe3191c0CF9a46FBa",
  "0x558E7848BD190C32251f7610c14329C594E5b0A0",
  // Add more wallets here as needed
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Resetting test wallets with:", deployer.address);
  console.log("Wallets to reset:", TEST_WALLETS.length);
  console.log("BeltManagers to reset:", BELT_MANAGERS.length);

  let resetCount = 0;
  for (const bmAddr of BELT_MANAGERS) {
    const bm = await ethers.getContractAt("BeltManagerV6", bmAddr);
    const tierIdx = BELT_MANAGERS.indexOf(bmAddr) + 1;
    for (const wallet of TEST_WALLETS) {
      const isReg = await bm.hasRegistered(wallet);
      if (isReg) {
        const tx = await bm.resetMember(wallet);
        await tx.wait();
        console.log(`  Reset T${tierIdx} wallet ${wallet.slice(0,8)}...`);
        resetCount++;
      }
    }
  }
  console.log(`\nDone. Reset ${resetCount} registrations.`);
}
main().catch(e => { console.error(e); process.exit(1); });
