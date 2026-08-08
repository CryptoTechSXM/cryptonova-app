// fund_sponsor_pool.js — V8.43: fund the 11 default-sponsor pool wallets
// (W1 0x6512e9B5 excluded — already registered as T1 root by the deploy).
// Sends $50 USDC + 0.005 ETH to each so the owner can register them on admin.
//
// Run: node fund_sponsor_pool.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const USDC_ADDRESS = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const USDC_AMOUNT  = 50_000_000n;                // $50
const ETH_AMOUNT   = ethers.parseEther("0.005"); // gas

const POOL = [
  "0x19a59fbD6d2c1289668795D41453e1505B7B8102",
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB",
  "0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2",
  "0xa2Dfd8c3b99b4395550558acf6cFFe79017b702C",
  "0x8fb7ca44D27c67b0cFED5153aeEE4F70F4aed6c2",
  "0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e",
  "0x141a5B0d42B0ba2AF1BE4eC771B96Db460896a50",
  "0x30196CD21fb0DF32cbA9e71D197A788d2a3739eB",
  "0x0f50998163F3DeE028a3D72153659D08aede45F3",
  "0x26388a81eb9448DF02144cc765Bb448444e61f9B",
  "0x391ab9edC83960e6ec468bDb7e6abE5858656F68",
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
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const usdc     = new ethers.Contract(USDC_ADDRESS, USDC_ABI, deployer);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Funding ${POOL.length} sponsor-pool wallets: $50 USDC + 0.005 ETH each\n`);

  for (let i = 0; i < POOL.length; i++) {
    const addr = POOL[i];
    try {
      const ethBal = await provider.getBalance(addr);
      if (ethBal < ETH_AMOUNT) {
        await sendWithRetry(() => deployer.sendTransaction({ to: addr, value: ETH_AMOUNT - ethBal }), "ETH");
      }
      const usdcBal = await usdc.balanceOf(addr);
      if (usdcBal < USDC_AMOUNT) {
        try {
          await sendWithRetry(() => usdc.mint(addr, USDC_AMOUNT - usdcBal), "USDC mint");
        } catch {
          await sendWithRetry(() => usdc.transfer(addr, USDC_AMOUNT - usdcBal), "USDC transfer");
        }
      }
      console.log(`[${i+1}/${POOL.length}] ✓ ${addr}`);
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log(`[${i+1}/${POOL.length}] ✗ ${addr}: ${(e.message || "").slice(0, 100)}`);
    }
  }
  console.log("\nDone. Register each wallet on admin.crypto-nova.app, then we push preview/main at cutover.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
