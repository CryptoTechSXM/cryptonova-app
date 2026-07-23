// mint_usdc.js — mint 2500 testnet USDC to a list of addresses
// Run: node mint_usdc.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const USDC_ADDRESS = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const AMOUNT = 2_500_000_000n; // 2500 USDC (6 decimals)

const RECIPIENTS = [
  "0x2b3a87b814D4Ac14E96c2E6303C9e69aA99089A1",
  "0xcD3720Bd13a6c56B62b7E83cbb7f00Cf7aF29279",
  "0x28FC64f89A6d51C5b5998336fCcC73B97b750887",
];

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
];

async function main() {
  const rpc  = process.env.BASE_SEPOLIA_RPC_URL;
  const key  = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpc || !key) { console.error("Missing BASE_SEPOLIA_RPC_URL or DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(rpc);
  const deployer = new ethers.Wallet(key, provider);
  const usdc     = new ethers.Contract(USDC_ADDRESS, USDC_ABI, deployer);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Minting 2500 USDC to ${RECIPIENTS.length} addresses...\n`);

  for (let i = 0; i < RECIPIENTS.length; i++) {
    const addr = RECIPIENTS[i];
    try {
      const tx = await usdc.mint(addr, AMOUNT, { gasLimit: 100_000 });
      await tx.wait();
      console.log(`[${i+1}/${RECIPIENTS.length}] ✓ ${addr}`);
      await new Promise(r => setTimeout(r, 3000)); // 3s gap between txs
    } catch (e) {
      // If mint fails (e.g. no MINTER_ROLE), try transfer
      if (e.message?.includes("AccessControl") || e.message?.includes("caller is not") || e.message?.includes("mint")) {
        try {
          const tx = await usdc.transfer(addr, AMOUNT, { gasLimit: 100_000 });
          await tx.wait();
          console.log(`[${i+1}/${RECIPIENTS.length}] ✓ ${addr} (via transfer)`);
        } catch (e2) {
          console.log(`[${i+1}/${RECIPIENTS.length}] ✗ ${addr}: ${e2.message?.slice(0,100)}`);
        }
      } else {
        console.log(`[${i+1}/${RECIPIENTS.length}] ✗ ${addr}: ${e.message?.slice(0,100)}`);
      }
    }
  }

  console.log("\nDone.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
