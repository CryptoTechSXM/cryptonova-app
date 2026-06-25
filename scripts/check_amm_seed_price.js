require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// How many CNOVA to seed into the AMM
const SEED_CNOVA = parseFloat(process.env.SEED_CNOVA ?? '100000');
// AMM premium over back-office tier price (1.25 = 25% above)
const PREMIUM = parseFloat(process.env.PREMIUM ?? '1.25');

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'deployed_addresses_v8_22.json'), 'utf8'));

  const ds = new ethers.Contract(addrs.directSale, [
    'function floorPriceE6() external view returns (uint256)',
    'function currentMultBps() external view returns (uint256)',
  ], p);

  const [floorE6, multBps] = await Promise.all([
    ds.floorPriceE6(),
    ds.currentMultBps(),
  ]);

  // floorPriceE6 = USDC (6 dec) per 1 full CNOVA
  // e.g. 20000 = $0.020000 per CNOVA
  const floorUSD    = Number(floorE6) / 1e6;
  const multiplier  = Number(multBps) / 10000;
  const tierPriceUSD = floorUSD * multiplier;
  const ammPriceUSD  = tierPriceUSD * PREMIUM;
  const seedUSDC     = ammPriceUSD * SEED_CNOVA;

  console.log('─────────────────────────────────────────');
  console.log(`Floor price        : $${floorUSD.toFixed(6)} / CNOVA`);
  console.log(`Bonding multiplier : ${multiplier}× (${multBps} BPS)`);
  console.log(`Back-office price  : $${tierPriceUSD.toFixed(6)} / CNOVA`);
  console.log(`AMM premium        : ${PREMIUM}×`);
  console.log(`AMM seed price     : $${ammPriceUSD.toFixed(6)} / CNOVA`);
  console.log('─────────────────────────────────────────');
  console.log(`Seed CNOVA         : ${SEED_CNOVA.toLocaleString()}`);
  console.log(`Seed USDC needed   : $${seedUSDC.toFixed(2)}`);
  console.log('─────────────────────────────────────────');
  console.log(`\nTo deploy at this price run:`);
  console.log(`  $env:SEED_USDC="${seedUSDC.toFixed(2)}"; $env:SEED_CNOVA="${SEED_CNOVA}"; node scripts/deploy_lp.js`);
}
main().catch(console.error);
