/**
 * seed_lp.js
 * Resume seeding an already-deployed CryptoNovaLP.
 * Picks up after USDC was already approved — approves CNOVA then calls addLiquidity.
 *
 * Usage:
 *   $env:LP_ADDR="0x..."; $env:SEED_USDC="2868.28"; $env:SEED_CNOVA="100000"; node scripts/seed_lp.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs  = require('fs');
const path = require('path');

const LP_ADDR    = process.env.LP_ADDR;
const SEED_USDC  = parseFloat(process.env.SEED_USDC  ?? '1000');
const SEED_CNOVA = parseFloat(process.env.SEED_CNOVA ?? '100000');
const DELAY_MS   = 4000; // 4s between txs

if (!LP_ADDR) throw new Error('LP_ADDR not set — pass as $env:LP_ADDR="0x..."');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendWithRetry(fn, label, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx  = await fn();
      const rcp = await tx.wait();
      console.log(`✅ ${label} (gas: ${rcp.gasUsed})`);
      await sleep(DELAY_MS);
      return rcp;
    } catch (e) {
      const msg = e.error?.message || e.shortMessage || e.message || '';
      if ((msg.includes('rate limit') || msg.includes('in-flight')) && i < retries - 1) {
        console.log(`  ⚠️  RPC throttle on "${label}", waiting 12s...`);
        await sleep(12000);
      } else {
        throw e;
      }
    }
  }
}

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'deployed_addresses_v8_22.json'), 'utf8'));

  const RPC_URL = process.env.BASE_SEPOLIA_RPC ?? process.env.BASE_SEPOLIA_RPC_URL;
  const KEY     = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.DEPLOYER_KEY;
  if (!RPC_URL) throw new Error('BASE_SEPOLIA_RPC not set');
  if (!KEY)     throw new Error('DEPLOYER_PRIVATE_KEY not set');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(KEY, provider);

  const ERC20_ABI = [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ];
  const LP_ABI = [
    'function addLiquidity(uint256 usdcAmount, uint256 cnovaAmount) returns (uint256)',
    'function getReserves() view returns (uint256,uint256)',
    'function totalSupply() view returns (uint256)',
  ];

  const usdc  = new ethers.Contract(addrs.usdc,  ERC20_ABI, wallet);
  const cnova = new ethers.Contract(addrs.cnova, ERC20_ABI, wallet);
  const lp    = new ethers.Contract(LP_ADDR,     LP_ABI,    wallet);

  const usdcDec  = Number(await usdc.decimals());
  const cnovaDec = Number(await cnova.decimals());

  const usdcAmt  = ethers.parseUnits(String(SEED_USDC),  usdcDec);
  const cnovaAmt = ethers.parseUnits(String(SEED_CNOVA), cnovaDec);

  console.log(`\n💧  Seeding CryptoNovaLP`);
  console.log(`    LP       : ${LP_ADDR}`);
  console.log(`    Seed USDC : ${SEED_USDC}`);
  console.log(`    Seed CNOVA: ${SEED_CNOVA}`);
  console.log(`    Price     : $${(SEED_USDC / SEED_CNOVA).toFixed(6)} per CNOVA\n`);

  // USDC was already approved in the previous run — skip it to avoid burning gas.
  // Approve CNOVA to LP
  console.log('Approving CNOVA to LP...');
  await sendWithRetry(() => cnova.approve(LP_ADDR, cnovaAmt), 'CNOVA approved');

  // Add liquidity
  console.log('Adding liquidity...');
  const receipt = await sendWithRetry(
    () => lp.addLiquidity(usdcAmt, cnovaAmt),
    'Liquidity seeded'
  );

  // Read pool state
  const [rU, rC] = await lp.getReserves();
  const supply   = await lp.totalSupply();
  const humanPrice = (Number(rU) / 1e6) / (Number(rC) / 1e18);

  console.log('\n📊  Pool state:');
  console.log(`    USDC  reserve : ${ethers.formatUnits(rU, usdcDec)} USDC`);
  console.log(`    CNOVA reserve : ${ethers.formatUnits(rC, cnovaDec)} CNOVA`);
  console.log(`    AMM price     : $${humanPrice.toFixed(6)} per CNOVA`);
  console.log(`    LP supply     : ${ethers.formatUnits(supply, 18)} LP tokens`);

  // Save LP address file
  const out = {
    network:       addrs.network ?? 'baseSepolia',
    deployedAt:    new Date().toISOString(),
    lpPool:        LP_ADDR,
    usdc:          addrs.usdc,
    cnova:         addrs.cnova,
    seedUSDC:      SEED_USDC,
    seedCNOVA:     SEED_CNOVA,
    initPriceUSDC: humanPrice,
    note:          'USDC/CNOVA constant-product AMM (x*y=k, 0.30% fee)',
  };

  const outFile = path.join(__dirname, '..', 'deployed_addresses_lp.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n💾  Saved: deployed_addresses_lp.json`);
  console.log(`\n🎉  Pool is live at ${LP_ADDR}`);
}
main().catch(e => { console.error(e); process.exit(1); });
