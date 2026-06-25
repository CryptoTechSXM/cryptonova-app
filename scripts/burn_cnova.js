require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Amount to burn — defaults to full deployer balance
const BURN_AMOUNT = process.env.BURN_AMOUNT ?? null; // null = burn everything in wallet

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'deployed_addresses_v8_22.json'), 'utf8'));

  const cnova = new ethers.Contract(addrs.cnova, [
    'function burn(uint256 amount) external',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
  ], w);

  const dec = Number(await cnova.decimals());
  const balBefore = await cnova.balanceOf(w.address);
  const supplyBefore = await cnova.totalSupply();

  const burnAmt = BURN_AMOUNT
    ? ethers.parseUnits(BURN_AMOUNT, dec)
    : balBefore;

  console.log('Deployer       :', w.address);
  console.log('Balance before :', ethers.formatUnits(balBefore, dec), 'CNOVA');
  console.log('Total supply   :', ethers.formatUnits(supplyBefore, dec), 'CNOVA');
  console.log('Burning        :', ethers.formatUnits(burnAmt, dec), 'CNOVA');

  if (burnAmt === 0n) {
    console.log('Nothing to burn.');
    return;
  }

  const tx = await cnova.burn(burnAmt);
  await tx.wait();

  const balAfter = await cnova.balanceOf(w.address);
  const supplyAfter = await cnova.totalSupply();

  console.log('\n✅ Burn complete');
  console.log('Balance after  :', ethers.formatUnits(balAfter, dec), 'CNOVA');
  console.log('Total supply   :', ethers.formatUnits(supplyAfter, dec), 'CNOVA');
}
main().catch(console.error);
