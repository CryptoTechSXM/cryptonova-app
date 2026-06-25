require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployed_addresses_v8_22.json'), 'utf8'));
  const erc20 = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ];
  const usdc  = new ethers.Contract(addrs.usdc,  erc20, p);
  const cnova = new ethers.Contract(addrs.cnova, erc20, p);
  const [ub, cb] = await Promise.all([usdc.balanceOf(w.address), cnova.balanceOf(w.address)]);
  console.log('Deployer :', w.address);
  console.log('USDC     :', ethers.formatUnits(ub, 6),  ' (need 1000 for default seed)');
  console.log('CNOVA    :', ethers.formatUnits(cb, 18), ' (need 100000 for default seed)');
}
main().catch(console.error);
