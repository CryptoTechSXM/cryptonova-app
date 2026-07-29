"use strict";
/**
 * mint_usdc_leaders.js — Mint 2500 USDC to each leader address for LP testing
 * Run: npx hardhat run scripts/mint_usdc_leaders.js --network baseSepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

const USDC_ADDRESS = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const AMOUNT_EACH  = 2500n * 1_000_000n; // 2500 USDC (6 decimals)

const LEADERS = [
  "0x01e0b43FbD714adC4EcEb6E4D5355Ed9E1434FC9",
  "0x0ddb6a96fa15f98e823Cd6632f9b14373CD1C74b",
  "0x141a5b0d42b0ba2af1be4ec771b96db460896a50",
  "0x19a59fbD6d2c1289668795D41453e1505B7B8102",
  "0x1CA3316Ebc2F991C073ccdD1A25c68d482589A94",
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB",
  "0x343954b158bF1dc62D69C4E5Aa504A8c9D8932C7",
  "0x3Bd8aCb1D150E8CAA13690d54Be9a9Ba0eeA17Bb",
  "0x3c17556855cfBd29b6F7a41eBfdbe8e914B7bbDD",
  "0x4392471363D2b215c9E0D03C25C06EDd6bFA9871",
  "0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2",
  "0x54305e14c0355f087365f1d510733c1314e500dc",
  "0x56815B1bf2a1E0371CF5682CDA331A28B0aC8f0c",
  "0x5704E5F537069127a8a53e7C85D522264a0135eD",
  "0x70569791aB42304ADDE5A34c412eC6e411Ae0b0B",
  "0x7308daF433804e8F10Dd267C70332609bd491477",
  "0x79470c63b5421e333Ab4149b3206d55A39c17532",
  "0x7974967be8d32965Ac320135cF98c51F4b16A610",
  "0x7a245ED3799D31C0D90BA0cfe3191c0CF9a46FBa",
  "0x8fb7ca44D27c67b0cFED5153aeEE4F70F4aed6c2",
  "0x964eA413F4C5D660E4C9545f99330df49E80ACD3",
  "0xa2Dfd8c3b99b4395550558acf6cFFe79017b702C",
  "0xA9B019e7455618BeC38451619B3b3893ed106617",
  "0xAdf9C692CB9C77e641Cd2438F117a7570963F238",
  "0xb464C1eF79d4F3Ad4109bF5D66E6066F44611918",
  "0xd136d23643A2eBeE50Bbe62F20B3E77aFF7c4a30",
  "0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e",
  "0xe828748C1dd5E470a52A3c803a6bc0353f660D67",
  "0xE9380a5e9a763d01bDc90dE12dd55bC4f090c13F",
  "0xf1ad812938b7a57bb1b5e9e34c0acb9b12bdf8d3",
  "0xfBD6Fa7d7ffF900f826896a5c91F371bF3489333",
  "0xFEDC8f5Dd42a251C3d74ba2982CE3c8C31064236",
];

const USDC_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const signers = await ethers.getSigners();
  const funder = signers[1] || signers[0]; // FILL_FUNDER_KEY = signers[1]
  console.log(`Funder: ${funder.address}`);

  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, funder);

  const funderBal = await usdc.balanceOf(funder.address);
  console.log(`Funder USDC balance: $${(Number(funderBal)/1e6).toFixed(2)}`);

  const totalNeeded = AMOUNT_EACH * BigInt(LEADERS.length);
  if (funderBal < totalNeeded) {
    console.error(`Not enough USDC. Need $${Number(totalNeeded)/1e6}, have $${Number(funderBal)/1e6}`);
    process.exit(1);
  }

  console.log(`\nTransferring $2,500 USDC to ${LEADERS.length} addresses...`);
  console.log(`Total: $${(LEADERS.length * 2500).toLocaleString()} USDC\n`);

  let success = 0;
  for (let i = 0; i < LEADERS.length; i++) {
    const addr = LEADERS[i];
    try {
      const before = await usdc.balanceOf(addr);
      const tx = await usdc.transfer(addr, AMOUNT_EACH);
      await tx.wait();
      const after = await usdc.balanceOf(addr);
      console.log(`  ✓ [${String(i+1).padStart(2)}] ${addr}  before: $${(Number(before)/1e6).toFixed(2)}  after: $${(Number(after)/1e6).toFixed(2)}`);
      success++;
    } catch (e) {
      console.error(`  ✗ [${String(i+1).padStart(2)}] ${addr}  ERROR: ${e.message}`);
    }
  }

  console.log(`\nDone. ${success}/${LEADERS.length} transferred successfully.`);
}

main().catch(e => { console.error(e); process.exit(1); });
