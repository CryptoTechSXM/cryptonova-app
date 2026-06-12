"use strict";
const { ethers } = require("hardhat");

const ADDRESSES = {
  cnova:     "0x16aA142C705aC0DCCD6923558071D5FD6E9f4De3",
  treasury:  "0xa55256Ed90E56DF3009c1a738557B65467dD61e3",
  community: "0x4D9a035323B9A09Dc0DD19E54418C2b44f997346",
  tm:        "0x249d6a4502C0b75E7E55d970C031C436855C26d0",
  matrices: {
    1: "0x3b2E0f282C46B060485e7277D080732310FF5DeA",
    2: "0x320Db0CEd7c7b04B24597195E3a09bc2aDf62caB",
    3: "0x02F83458ac0fd5050aBBb9babBFa29398b39dC6A",
    4: "0x25bFdF0d9D41d131e25F9cC4198F9d35ED0816b7",
    5: "0x9541Dd025494276b7aa3924ab1BE2356261b9Cb7",
    6: "0xaE1401D22a3Ea5d55F2D5E9c8d30BB6F667776dd",
    7: "0xEC5E9e4c29B848e0DC07CD36AD1378720D24CcB7",
  }
};

async function waitTx(tx, label) {
  process.stdout.write(`  [tx] ${label} ... `);
  const r = await tx.wait();
  console.log(`✓  (gas: ${r.gasUsed})`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Completing wiring from deployer:", deployer.address);

  const cnova     = await ethers.getContractAt("CNOVAToken", ADDRESSES.cnova);
  const treasury  = await ethers.getContractAt("CNOVATreasury", ADDRESSES.treasury);
  const community = await ethers.getContractAt("CryptoNovaCommunityWallet", ADDRESSES.community);
  const tm        = await ethers.getContractAt("CryptoNovaTierManager", ADDRESSES.tm);

  // setMatrix 6 & 7 — skip if already set
  for (const t of [6, 7]) {
    try {
      await waitTx(await tm.setMatrix(t, ADDRESSES.matrices[t]), `TierManager.setMatrix(${t})`);
    } catch(e) {
      console.log(`  [skip] setMatrix(${t}) already set`);
    }
  }

  // CommunityWallet authorise all 7 + TierManager
  for (let t = 1; t <= 7; t++) {
    await waitTx(await community.setAuthorisedRegistrar(ADDRESSES.matrices[t], true), `CW.authorise Tier ${t}`);
  }
  await waitTx(await community.setAuthorisedRegistrar(ADDRESSES.tm, true), "CW.authorise TierManager");

  // Matrix Tier 2-7: setAuthorizedRegistrar → TierManager
  for (let t = 2; t <= 7; t++) {
    const mx = await ethers.getContractAt("CryptoNovaMatrixV3", ADDRESSES.matrices[t]);
    await waitTx(await mx.setAuthorizedRegistrar(ADDRESSES.tm, true), `Matrix ${t}.setAuthorizedRegistrar`);
  }

  // Treasury: setAuthorizedCaller for all 7 matrices
  for (let t = 1; t <= 7; t++) {
    await waitTx(await treasury.setAuthorizedCaller(ADDRESSES.matrices[t], true), `Treasury.authorise Tier ${t}`);
  }

  // Treasury: setTier1Matrix
  await waitTx(await treasury.setTier1Matrix(ADDRESSES.matrices[1]), "Treasury.setTier1Matrix");

  console.log("\n✅ Wiring complete!");
}

main().catch(e => { console.error(e); process.exit(1); });
