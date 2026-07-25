// mint_usdc.js — mint 5000 testnet USDC to a list of addresses
// Run: node mint_usdc.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const USDC_ADDRESS = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const AMOUNT = 5_000_000_000n; // 5000 USDC (6 decimals)

const RECIPIENTS = [
  "0x7308daF433804e8F10Dd267C70332609bd491477",
  "0x1CA3316Ebc2F991C073ccdD1A25c68d482589A94",
  "0x95EBdE6a7C0A91699EAC972C8cD3284F45d5e1e5",
];

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
];

async function sendWithRetry(fn, label) {
  for (let a = 1; a <= 5; a++) {
    try { return await (await fn()).wait(); }
    catch (e) {
      const m = e.message || "";
      if (m.includes("in-flight") && a < 5) {
        console.log(`  ${label}: in-flight limit, retry ${a}/5 in 10s...`);
        await new Promise(r => setTimeout(r, 10_000));
      } else throw e;
    }
  }
}

async function main() {
  const rpc = process.env.BASE_SEPOLIA_RPC_URL;
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpc || !key) { console.error("Missing BASE_SEPOLIA_RPC_URL or DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(rpc);
  const deployer = new ethers.Wallet(key, provider);
  const usdc     = new ethers.Contract(USDC_ADDRESS, USDC_ABI, deployer);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Minting 5000 USDC to ${RECIPIENTS.length} addresses...\n`);

  for (let i = 0; i < RECIPIENTS.length; i++) {
    const addr = RECIPIENTS[i];
    try {
      try {
        await sendWithRetry(() => usdc.mint(addr, AMOUNT), "mint");
      } catch {
        await sendWithRetry(() => usdc.transfer(addr, AMOUNT), "transfer");
      }
      console.log(`[${i+1}/${RECIPIENTS.length}] ✓ ${addr}`);
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log(`[${i+1}/${RECIPIENTS.length}] ✗ ${addr}: ${(e.message || "").slice(0, 100)}`);
    }
  }
  console.log("\nDone.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
