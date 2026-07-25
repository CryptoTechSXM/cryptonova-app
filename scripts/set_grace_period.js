/**
 * set_grace_period.js
 * Temporarily reduces parkedGracePeriod on MatrixKeeper for testnet rescue ops.
 * Usage: npx hardhat run scripts/set_grace_period.js --network baseSepolia
 * Set back to 86400 (24h) after rescue: GRACE_SECS=86400 npx hardhat run ...
 */
const hre  = require('hardhat');
const fs   = require('fs');
const path = require('path');
const { ethers } = hre;

async function main() {
  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_34.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const [signer] = await hre.ethers.getSigners();
  console.log('Signer:', signer.address);

  const mk = new ethers.Contract(addrs.matrixKeeper, [
    'function setParkedGracePeriod(uint256 v) external',
    'function parkedGracePeriod() view returns (uint256)',
  ], signer);

  const current = await mk.parkedGracePeriod();
  console.log('Current grace period:', current.toString(), 's  (' + (Number(current) / 3600).toFixed(1) + 'h)');

  const newGrace = BigInt(process.env.GRACE_SECS || '3600');
  console.log('Setting to:', newGrace.toString(), 's  (' + (Number(newGrace) / 3600).toFixed(1) + 'h) ...');

  const tx = await mk.setParkedGracePeriod(newGrace, { gasLimit: 100_000 });
  await tx.wait();

  const updated = await mk.parkedGracePeriod();
  console.log('✓ Grace period updated:', updated.toString(), 's  (' + (Number(updated) / 3600).toFixed(1) + 'h)');
}

main().catch(console.error);
