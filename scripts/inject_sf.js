/**
 * inject_sf.js
 * Injects USDC into the StabilityFund via receiveLayer() (owner-callable).
 * Mints testnet USDC to deployer, approves SF, then calls receiveLayer.
 *
 * Run:
 *   $env:INJECT_USD="1000"; npx hardhat run scripts/inject_sf.js --network baseSepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

// V8.43: read SF from the current ADDRESSES_FILE — no more hardcoded stale address
const fs   = require("fs");
const path = require("path");
const _addrs = JSON.parse(fs.readFileSync(
  path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_43.json"), "utf8"));
const SF_ADDR   = _addrs.stabilityFund;
const USDC_ADDR = _addrs.usdc || "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const DELAY_MS  = 3000; // 3s between txs to avoid in-flight limit

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const SF_ABI = [
  "function totalBalance() view returns (uint256)",
  "function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  const usd    = parseInt(process.env.INJECT_USD || "1000", 10);
  const amount = BigInt(usd) * 1_000_000n;

  console.log(`\nDeployer : ${deployer.address}`);
  console.log(`SF       : ${SF_ADDR}`);
  console.log(`Injecting: $${usd} USDC via receiveLayer(0, amount, 5) — L5 penalty path, no CW carve\n`);

  const usdc = await ethers.getContractAt("MockUSDC",      USDC_ADDR, deployer);
  const sf   = await ethers.getContractAt("StabilityFund", SF_ADDR,   deployer);

  const before = await sf.totalBalance();
  console.log(`SF totalBalance before: $${Number(before) / 1e6}`);

  // 1. Mint to deployer
  await (await usdc.mint(deployer.address, amount)).wait();
  console.log(`  ✓  Minted $${usd} USDC to deployer`);
  await sleep(DELAY_MS);

  // 2. Approve SF
  await (await usdc.approve(SF_ADDR, amount)).wait();
  console.log(`  ✓  Approved SF`);
  await sleep(DELAY_MS);

  // 3. Inject via receiveLayer (tier 0 = T1, layer 5 = L5 penalty — no community carve-out)
  await (await sf.receiveLayer(0, amount, 5)).wait();
  console.log(`  ✓  receiveLayer called`);

  const after = await sf.totalBalance();
  console.log(`\nSF totalBalance after : $${Number(after) / 1e6}`);
  console.log(`Injected              : $${(Number(after) - Number(before)) / 1e6}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
