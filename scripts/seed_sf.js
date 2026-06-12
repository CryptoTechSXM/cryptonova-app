/**
 * seed_sf.js
 * ──────────────────────────────────────────────────────────────────────────
 * Seeds the new StabilityFund totalBalance by calling receiveLayer() as owner.
 *
 * Background: the migrate_sf_balance.js script sent $33 USDC to the new SF
 * via a raw ERC20 safeTransfer, which landed in the contract's USDC balance
 * but did NOT update totalBalance (receiveLayer was never called).
 *
 * Fix: owner calls receiveLayer(tier=0, amount=$33, layer=1) which:
 *   1. Pulls $33 USDC from the deployer wallet into the SF
 *   2. Increments totalBalance by $33
 *
 * After this, totalBalance = $33 and the home-page Stability Fund card
 * will show the correct value. The extra $33 already sitting in the
 * contract is surplus backing that grows the floor price.
 *
 * Run:
 *   npx hardhat run scripts/seed_sf.js --network baseSepolia
 * ──────────────────────────────────────────────────────────────────────────
 */

const hre = require('hardhat');
const { ethers } = hre;
const { NonceManager } = require('ethers');

const NEW_SF = '0x2a994AE149B6CE208909B5Fea5caa35F94e0D2ce';
const USDC   = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';

const SF_ABI = [
  'function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external',
  'function totalBalance() external view returns (uint256)',
];

const USDC_ABI = [
  'function balanceOf(address) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];

async function main() {
  const [rawSigner] = await ethers.getSigners();
  const deployer = new NonceManager(rawSigner);

  console.log('\n── Seed StabilityFund totalBalance ──────────────────────────────');
  console.log('Deployer:', rawSigner.address);
  console.log('New SF:  ', NEW_SF);

  const sf   = new ethers.Contract(NEW_SF, SF_ABI,   deployer);
  const usdc = new ethers.Contract(USDC,   USDC_ABI, deployer);

  // How much does the SF actually hold in USDC?
  const actualBal = await usdc.balanceOf(NEW_SF);
  const trackedBal = await sf.totalBalance();
  console.log(`\nSF actual USDC:    ${actualBal} (${Number(actualBal)/1e6} USDC)`);
  console.log(`SF totalBalance:   ${trackedBal} (${Number(trackedBal)/1e6} USDC)`);

  const gap = actualBal - trackedBal;
  if (gap <= 0n) {
    console.log('\ntotalBalance already matches actual USDC — nothing to do.');
    return;
  }

  // The gap = amount we need to add via receiveLayer to align accounting.
  // We pull this from the deployer wallet so receiveLayer's safeTransferFrom succeeds.
  const deployerBal = await usdc.balanceOf(rawSigner.address);
  console.log(`\nDeployer USDC:     ${deployerBal} (${Number(deployerBal)/1e6} USDC)`);
  console.log(`Gap to fill:       ${gap} (${Number(gap)/1e6} USDC)`);

  if (deployerBal < gap) {
    console.error('ERROR: deployer does not have enough USDC to fill the gap.');
    process.exit(1);
  }

  // Approve SF to pull from deployer
  console.log('\n[1/2] Approving SF to spend deployer USDC...');
  const approveTx = await usdc.approve(NEW_SF, gap);
  await approveTx.wait();
  console.log('  Approved.');

  // Call receiveLayer as owner (tier=0, layer=1 = pool carve)
  console.log('[2/2] Calling receiveLayer to seed totalBalance...');
  const seedTx = await sf.receiveLayer(0, gap, 1);
  console.log('  TX sent:', seedTx.hash);
  await seedTx.wait();
  console.log('  Confirmed!');

  // Verify
  const newTracked = await sf.totalBalance();
  const newActual  = await usdc.balanceOf(NEW_SF);
  console.log(`\nSF totalBalance after:  ${newTracked} ($${Number(newTracked)/1e6})`);
  console.log(`SF actual USDC after:   ${newActual} ($${Number(newActual)/1e6})`);
  console.log('\n✅ Stability Fund seeded. Refresh the home page to see the balance.');
}

main().catch((e) => { console.error(e); process.exit(1); });
