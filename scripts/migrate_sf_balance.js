/**
 * migrate_sf_balance.js
 * ─────────────────────────────────────────────────────────────────
 * Reads USDC balance from the old StabilityFund and transfers it
 * to the new one via oldSF.withdraw(amount, newSF, reason).
 *
 * Run:
 *   npx hardhat run scripts/migrate_sf_balance.js --network baseSepolia
 * ─────────────────────────────────────────────────────────────────
 */

const hre = require('hardhat');
const { ethers } = hre;
const { NonceManager } = require('ethers');

const OLD_SF  = '0x0a75cB6EDaB85aa911cCe8Fcb76E0Fb812F6f3bB';
const NEW_SF  = '0x2a994AE149B6CE208909B5Fea5caa35F94e0D2ce';
const USDC    = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';

const OLD_SF_ABI = [
  'function totalBalance() external view returns (uint256)',
  'function withdraw(uint256 amount, address to, string calldata reason) external',
];
const USDC_ABI = [
  'function balanceOf(address) external view returns (uint256)',
];

async function main() {
  const [rawSigner] = await ethers.getSigners();
  const deployer = new NonceManager(rawSigner);

  console.log('\n── StabilityFund Balance Migration ─────────────────────────────');
  console.log('Deployer:', rawSigner.address);
  console.log('Old SF:  ', OLD_SF);
  console.log('New SF:  ', NEW_SF);

  const oldSF = new ethers.Contract(OLD_SF,  OLD_SF_ABI, deployer);
  const usdc  = new ethers.Contract(USDC,    USDC_ABI,   deployer);

  // Check both balances
  const sfBal    = await oldSF.totalBalance();
  const usdcBal  = await usdc.balanceOf(OLD_SF);
  const newSfBal = await usdc.balanceOf(NEW_SF);

  console.log(`\nOld SF totalBalance:  ${sfBal} (${Number(sfBal)/1e6} USDC)`);
  console.log(`Old SF actual USDC:   ${usdcBal} (${Number(usdcBal)/1e6} USDC)`);
  console.log(`New SF USDC balance:  ${newSfBal} (${Number(newSfBal)/1e6} USDC)`);

  // Use the tracked balance (totalBalance) — this is what the contract will allow
  if (sfBal === 0n) {
    console.log('\nOld SF totalBalance is 0 — nothing to migrate.');
    return;
  }

  // Migrate using the tracked balance (not raw USDC balance, to avoid rounding issues)
  const amount = sfBal;
  console.log(`\nMigrating ${amount} (${Number(amount)/1e6} USDC) to new SF...`);

  const tx = await oldSF.withdraw(amount, NEW_SF, 'migrate to SF v2');
  console.log('TX sent:', tx.hash);
  await tx.wait();
  console.log('Confirmed!');

  // Verify
  const newSfBalAfter = await usdc.balanceOf(NEW_SF);
  console.log(`\nNew SF USDC after: ${newSfBalAfter} (${Number(newSfBalAfter)/1e6} USDC)`);
  console.log('\nMigration complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
