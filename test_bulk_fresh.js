// test_bulk_fresh.js — V8.43 item 1/2 empirical test:
// Can a FRESH member (zero cycles) register and immediately bulkUpgrade to T5?
// Proves whether the contract needs changes or only the frontend gate does.
//
// Run: node test_bulk_fresh.js

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const RPC_URL      = process.env.BASE_SEPOLIA_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const MNEMONIC     = process.env.FILL_MNEMONIC;
const ADDRS_FILE   = process.env.ADDRESSES_FILE || "deployed_addresses_v8_42.json";
const WALLET_INDEX = Number(process.env.TEST_INDEX || 990_001); // far from stress keeper range

const USDC_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function transfer(address,uint256) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
];
const TR_ABI = [
  "function register(address) external",
  "function bulkUpgrade(uint8) external",
  "function memberHighestTier(address) external view returns (uint8)",
  "function tierEntryFees(uint256) external view returns (uint256)", // public array getter — uint256 index
  "function tierCycles(address,uint8) external view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);
  const addrs    = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRS_FILE), "utf8"));
  const usdc     = new ethers.Contract(addrs.usdc, USDC_ABI, deployer);
  const tr       = new ethers.Contract(addrs.tierRouter, TR_ABI, provider);

  const mn = ethers.Mnemonic.fromPhrase(MNEMONIC);
  const w  = ethers.HDNodeWallet.fromMnemonic(mn, `m/44'/60'/0'/0/${WALLET_INDEX}`).connect(provider);
  console.log(`Test wallet [${WALLET_INDEX}]: ${w.address}`);

  const existing = Number(await tr.memberHighestTier(w.address));
  if (existing > 0) { console.log(`Already tier ${existing} — pick another TEST_INDEX`); process.exit(1); }

  // Fees: T1 (register) + T2..T5 (bulk)
  const fees = [];
  for (let i = 0; i < 5; i++) fees.push(BigInt(await tr.tierEntryFees(i)));
  const t1Fee    = fees[0];
  const bulkFee  = fees[1] + fees[2] + fees[3] + fees[4];
  console.log(`T1 fee: ${ethers.formatUnits(t1Fee, 6)} | bulk T2-T5: ${ethers.formatUnits(bulkFee, 6)}`);

  // Fund — retry on "in-flight transaction limit" (delegated deployer + stress keeper share the account)
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
  console.log("Funding ETH + USDC...");
  await sendWithRetry(() => deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.02") }), "ETH");
  await sendWithRetry(() => usdc.transfer(w.address, t1Fee + bulkFee + 1_000_000n), "USDC");

  // 1. Register (T1) — approve T1 PairManager (PM pulls the fee)
  console.log("Registering T1...");
  await (await usdc.connect(w).approve(addrs.tiers.T1.pm, t1Fee, { gasLimit: 100_000 })).wait();
  await (await tr.connect(w).register(addrs.accountOne, { gasLimit: 15_000_000 })).wait();
  console.log(`memberHighestTier after register: ${await tr.memberHighestTier(w.address)}`);
  console.log(`T1 cycles: ${await tr.tierCycles(w.address, 0)} (must be 0 — that's the point)`);

  // 2. Immediately bulkUpgrade to T5 — approve TierRouter (bulk pulls from member)
  console.log("Approving bulk fee to TierRouter...");
  await (await usdc.connect(w).approve(addrs.tierRouter, bulkFee, { gasLimit: 100_000 })).wait();

  console.log("Estimating bulkUpgrade(4) gas...");
  let est = null;
  try {
    est = await tr.connect(w).bulkUpgrade.estimateGas(4);
    console.log(`estimateGas: ${est.toString()}`);
  } catch (e) {
    console.log(`estimateGas REVERTED: ${e.reason || e.shortMessage || (e.message || "").slice(0, 150)}`);
  }

  console.log("Sending bulkUpgrade(4) with 15M gas...");
  try {
    const tx = await tr.connect(w).bulkUpgrade(4, { gasLimit: 15_000_000 });
    const rc = await tx.wait();
    console.log(`✅ bulkUpgrade SUCCEEDED — gasUsed: ${rc.gasUsed.toString()}`);
    console.log(`memberHighestTier now: ${await tr.memberHighestTier(w.address)}`);
  } catch (e) {
    console.log(`❌ bulkUpgrade FAILED: ${e.reason || e.shortMessage || (e.message || "").slice(0, 200)}`);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
