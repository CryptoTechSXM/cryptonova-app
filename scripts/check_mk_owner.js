const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;
async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_34.json'), 'utf8'));
  const mk = new ethers.Contract(addrs.matrixKeeper, ['function owner() view returns (address)'], hre.ethers.provider);
  console.log('MatrixKeeper owner:', await mk.owner());
}
main().catch(console.error);
