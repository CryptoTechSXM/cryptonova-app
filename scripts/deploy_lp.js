/**
 * deploy_lp.js
 * Deploy CryptoNovaLP (USDC/CNOVA AMM) and seed initial liquidity.
 *
 * Reads USDC + CNOVA addresses from deployed_addresses_v8_22.json (or ADDRESSES_FILE env override).
 * Seeds pool at SEED_USDC USDC : SEED_CNOVA CNOVA → implied price = SEED_USDC / SEED_CNOVA USDC per CNOVA.
 *
 * Usage:
 *   node scripts/deploy_lp.js
 *   SEED_USDC=500 SEED_CNOVA=50000 node scripts/deploy_lp.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs          = require("fs");
const path        = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = process.env.ADDRESSES_FILE
  ?? path.join(__dirname, "../deployed_addresses_v8_22.json");

const LP_OUT_FILE = path.join(
  __dirname,
  "../deployed_addresses_lp.json"
);

// Initial seed liquidity
const SEED_USDC  = parseFloat(process.env.SEED_USDC  ?? "1000");   // USDC to seed
const SEED_CNOVA = parseFloat(process.env.SEED_CNOVA  ?? "100000"); // CNOVA to seed
// Implied initial price: SEED_USDC / SEED_CNOVA = 0.01 USDC per CNOVA (default)

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const LP_ABI = [
  "function addLiquidity(uint256 usdcAmount, uint256 cnovaAmount) returns (uint256 lpMinted)",
  "function getReserves() view returns (uint256, uint256)",
  "function getCNOVAPrice() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load addresses
  if (!fs.existsSync(ADDRESSES_FILE)) {
    throw new Error(`Addresses file not found: ${ADDRESSES_FILE}`);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const USDC_ADDR  = addrs.usdc;
  const CNOVA_ADDR = addrs.cnova;

  if (!USDC_ADDR || !CNOVA_ADDR) {
    throw new Error("usdc or cnova missing from addresses file");
  }

  // Provider + signer
  const RPC_URL    = process.env.BASE_SEPOLIA_RPC ?? process.env.BASE_SEPOLIA_RPC_URL ?? process.env.RPC_URL;
  const DEPLOY_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.DEPLOYER_KEY;
  if (!RPC_URL)    throw new Error("BASE_SEPOLIA_RPC not set in .env");
  if (!DEPLOY_KEY) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(DEPLOY_KEY, provider);

  console.log(`\n🔧  CryptoNovaLP Deploy`);
  console.log(`    Deployer : ${deployer.address}`);
  console.log(`    USDC     : ${USDC_ADDR}`);
  console.log(`    CNOVA    : ${CNOVA_ADDR}`);
  console.log(`    Seed     : ${SEED_USDC} USDC / ${SEED_CNOVA} CNOVA`);
  console.log(`    Init price: $${(SEED_USDC / SEED_CNOVA).toFixed(6)} per CNOVA\n`);

  // ── Deploy ────────────────────────────────────────────────────────────────
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../artifacts/contracts/CryptoNovaLP.sol/CryptoNovaLP.json"),
      "utf8"
    )
  );

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  console.log("⏳  Deploying CryptoNovaLP...");
  const lp = await factory.deploy(USDC_ADDR, CNOVA_ADDR);
  await lp.waitForDeployment();
  const LP_ADDR = await lp.getAddress();
  console.log(`✅  CryptoNovaLP deployed: ${LP_ADDR}`);

  // ── Check balances ────────────────────────────────────────────────────────
  const usdc  = new ethers.Contract(USDC_ADDR,  ERC20_ABI, deployer);
  const cnova = new ethers.Contract(CNOVA_ADDR, ERC20_ABI, deployer);

  const usdcDec  = Number(await usdc.decimals());
  const cnovaDec = Number(await cnova.decimals());

  const usdcBal  = await usdc.balanceOf(deployer.address);
  const cnovaBal = await cnova.balanceOf(deployer.address);

  const usdcSeedAmt  = ethers.parseUnits(String(SEED_USDC),  usdcDec);
  const cnovaSeedAmt = ethers.parseUnits(String(SEED_CNOVA), cnovaDec);

  console.log(`\n💰  Balances:`);
  console.log(`    USDC  : ${ethers.formatUnits(usdcBal, usdcDec)} (need ${SEED_USDC})`);
  console.log(`    CNOVA : ${ethers.formatUnits(cnovaBal, cnovaDec)} (need ${SEED_CNOVA})`);

  if (usdcBal < usdcSeedAmt) {
    throw new Error(
      `Insufficient USDC: have ${ethers.formatUnits(usdcBal, usdcDec)}, need ${SEED_USDC}`
    );
  }
  if (cnovaBal < cnovaSeedAmt) {
    throw new Error(
      `Insufficient CNOVA: have ${ethers.formatUnits(cnovaBal, cnovaDec)}, need ${SEED_CNOVA}`
    );
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  console.log("\n⏳  Approving USDC...");
  let tx = await usdc.approve(LP_ADDR, usdcSeedAmt);
  await tx.wait();
  console.log("✅  USDC approved");

  console.log("⏳  Approving CNOVA...");
  tx = await cnova.approve(LP_ADDR, cnovaSeedAmt);
  await tx.wait();
  console.log("✅  CNOVA approved");

  // ── Seed liquidity ────────────────────────────────────────────────────────
  console.log("\n⏳  Adding initial liquidity...");
  const lpContract = new ethers.Contract(LP_ADDR, LP_ABI, deployer);
  tx = await lpContract.addLiquidity(usdcSeedAmt, cnovaSeedAmt);
  const receipt = await tx.wait();
  console.log(`✅  Liquidity seeded (tx: ${receipt.hash})`);

  // ── Verify state ──────────────────────────────────────────────────────────
  const [rU, rC] = await lpContract.getReserves();
  const price    = await lpContract.getCNOVAPrice();
  const supply   = await lpContract.totalSupply();

  // getCNOVAPrice returns (reserveUSDC * 1e18) / reserveCNOVA
  // To get human USDC per CNOVA: price / 1e(18 - usdcDec + usdcDec) ...
  // Simpler: humanPrice = (reserveUSDC / 1e6) / (reserveCNOVA / 1e18)
  const humanPrice = (Number(rU) / 1e6) / (Number(rC) / 1e18);

  console.log(`\n📊  Pool state:`);
  console.log(`    USDC  reserve : ${ethers.formatUnits(rU, usdcDec)} USDC`);
  console.log(`    CNOVA reserve : ${ethers.formatUnits(rC, cnovaDec)} CNOVA`);
  console.log(`    AMM price     : $${humanPrice.toFixed(6)} per CNOVA`);
  console.log(`    LP supply     : ${ethers.formatUnits(supply, 18)} CNOVA-LP`);

  // ── Save addresses ────────────────────────────────────────────────────────
  const out = {
    network:       addrs.network ?? "baseSepolia",
    deployedAt:    new Date().toISOString(),
    lpPool:        LP_ADDR,
    usdc:          USDC_ADDR,
    cnova:         CNOVA_ADDR,
    seedUSDC:      SEED_USDC,
    seedCNOVA:     SEED_CNOVA,
    initPriceUSDC: humanPrice,
    note:          "USDC/CNOVA constant-product AMM (x*y=k, 0.30% fee)",
  };

  fs.writeFileSync(LP_OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\n💾  Saved to: ${LP_OUT_FILE}`);
  console.log(`\n🎉  CryptoNovaLP is live!`);
  console.log(`    Pool address: ${LP_ADDR}`);
  console.log(`    Add to your .env: LP_POOL=${LP_ADDR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
