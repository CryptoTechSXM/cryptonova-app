// set_parked_grace.js — Set MatrixKeeper.parkedGracePeriod
// Usage: node scripts/set_parked_grace.js <hours>
// Example: node scripts/set_parked_grace.js 14
//
// Common values:
//   6  hours = 21600  (current default — too short for launch)
//   14 hours = 50400  (testnet interim)
//   24 hours = 86400  (mainnet target default)

require('dotenv').config();
const { ethers } = require('ethers');

const hours = parseFloat(process.argv[2]);
if (!hours || hours < 0.1) {
  console.error('Usage: node scripts/set_parked_grace.js <hours>');
  process.exit(1);
}

const seconds = Math.round(hours * 3600);
console.log(`Setting parkedGracePeriod to ${hours}h = ${seconds}s`);

const path = require('path');
const fs   = require('fs');
const ADDR_FILE = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_33.json');
const addrs = JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));

const ABI = [
  'function parkedGracePeriod() external view returns (uint256)',
  'function setParkedGracePeriod(uint256 v) external',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const mk       = new ethers.Contract(addrs.matrixKeeper, ABI, wallet);

  const current = await mk.parkedGracePeriod();
  console.log(`Current: ${Number(current)}s = ${(Number(current)/3600).toFixed(1)}h`);

  const tx = await mk.setParkedGracePeriod(seconds);
  console.log(`Tx sent: ${tx.hash}`);
  await tx.wait();

  const updated = await mk.parkedGracePeriod();
  console.log(`Updated: ${Number(updated)}s = ${(Number(updated)/3600).toFixed(1)}h ✅`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
