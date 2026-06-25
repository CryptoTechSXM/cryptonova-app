require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Mint CNOVA to the deployer wallet for AMM seeding.
// Default: 100,000 CNOVA (matches deploy_lp.js default SEED_CNOVA).
const AMOUNT = process.env.MINT_AMOUNT ?? '100000';

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployed_addresses_v8_22.json'), 'utf8'));

  const cnova = new ethers.Contract(addrs.cnova, [
    'function mintDirectAdmin(address to, uint256 amount) external',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ], w);

  console.log('Deployer :', w.address);

  const dec = Number(await cnova.decimals());
  const amt = ethers.parseUnits(AMOUNT, dec);

  console.log(`Minting ${AMOUNT} CNOVA to deployer...`);
  const tx = await cnova.mintDirectAdmin(w.address, amt);
  await tx.wait();

  const bal = await cnova.balanceOf(w.address);
  console.log('✅ Done. New CNOVA balance:', ethers.formatUnits(bal, dec));
}
main().catch(console.error);
