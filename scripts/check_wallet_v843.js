// check_wallet_v843.js — diagnose a member wallet's registration state on V8.43
// Run: node check_wallet_v843.js 0xWALLET

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const WALLET = process.argv[2] || "0x20325876F47c5D30DA4Ac38C52a73eF342eAfd56";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "scripts", "deployed_addresses_v8_43.json"), "utf8"));

  const tr = new ethers.Contract(addrs.tierRouter, [
    "function memberHighestTier(address) view returns (uint8)",
    "function globalJoined(address) view returns (bool)",
    "function memberReferrer(address) view returns (address)",
  ], provider);
  const usdc = new ethers.Contract(addrs.usdc, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ], provider);
  const matA = new ethers.Contract(addrs.tiers.T1.matA || addrs.tiers.T1.matrixA, [
    "function isActiveInMatrix(address) view returns (bool)",
    "function occupancy() view returns (uint256)",
  ], provider);

  console.log(`Wallet: ${WALLET}\n`);
  console.log(`memberHighestTier : ${await tr.memberHighestTier(WALLET)}`);
  console.log(`globalJoined      : ${await tr.globalJoined(WALLET)}`);
  console.log(`referrer          : ${await tr.memberReferrer(WALLET)}`);
  console.log(`USDC balance      : $${ethers.formatUnits(await usdc.balanceOf(WALLET), 6)}`);
  console.log(`allowance → T1 PM : $${ethers.formatUnits(await usdc.allowance(WALLET, addrs.tiers.T1.pm), 6)}`);
  console.log(`T1.1 MatA active  : ${await matA.isActiveInMatrix(WALLET).catch(() => "?")}`);
  console.log(`T1.1 MatA occ     : ${await matA.occupancy().catch(() => "?")}/127`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
