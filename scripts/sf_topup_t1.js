/**
 * sf_topup_t1.js
 * Tops up the StabilityFund's T1 tier bucket (balanceByTier[0]) so rescues can proceed.
 *
 * Root cause: ghost entries drained balanceByTier[0] to $2.40.
 * Each rescue needs ~$4.50 from this bucket. With only $2.40, rescue silently
 * bails at "if (sfBal < sfShare) return" and nothing is rescued.
 *
 * This script:
 *   1. Approves USDC for the SF contract
 *   2. Calls sf.receiveLayer(tierIdx=0, amount, layer=1)
 *      which credits both totalBalance and balanceByTier[0]
 *
 * Usage: npx hardhat run scripts/sf_topup_t1.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

// How much to top up T1 bucket: 48 parked x ~$3.90 shortfall = ~$187 needed.
// Adding $250 to comfortably cover the full queue plus headroom.
const TOPUP_USDC = 250_000_000n; // $250 with 6 decimals

const SF_ABI = [
  'function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external',
  'function totalBalance() view returns (uint256)',
  'function balanceByTier(uint8) view returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_30.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const [signer] = await hre.ethers.getSigners();
  console.log('Signer:', signer.address);

  const sf   = new ethers.Contract(addrs.stabilityFund, SF_ABI, signer);
  const usdc = new ethers.Contract(addrs.usdc, ERC20_ABI, signer);

  // Pre-flight checks
  const usdcBal = await usdc.balanceOf(signer.address);
  console.log('Deployer USDC balance: $' + (Number(usdcBal)/1e6).toFixed(2));
  if (usdcBal < TOPUP_USDC) {
    console.error('Insufficient USDC balance. Need $' + (Number(TOPUP_USDC)/1e6).toFixed(2));
    process.exit(1);
  }

  const t0before = await sf.balanceByTier(0);
  const totBefore = await sf.totalBalance();
  console.log('SF balanceByTier[0] before: $' + (Number(t0before)/1e6).toFixed(2));
  console.log('SF totalBalance before:     $' + (Number(totBefore)/1e6).toFixed(2));

  // Step 1: Approve
  console.log('\nApproving USDC...');
  const approveTx = await usdc.approve(addrs.stabilityFund, TOPUP_USDC);
  await approveTx.wait();
  console.log('  Approved: $' + (Number(TOPUP_USDC)/1e6).toFixed(2));

  // Step 2: receiveLayer(tierIdx=0, amount, layer=1)
  console.log('Calling receiveLayer(0, ' + TOPUP_USDC + ', 1)...');
  const tx = await sf.receiveLayer(0, TOPUP_USDC, 1, { gasLimit: 300_000 });
  console.log('  TX:', tx.hash);
  const receipt = await tx.wait();
  console.log('  Status:', receipt.status === 1 ? 'success' : 'FAILED', 'gas=' + receipt.gasUsed);

  const t0after  = await sf.balanceByTier(0);
  const totAfter = await sf.totalBalance();
  console.log('\nSF balanceByTier[0] after: $' + (Number(t0after)/1e6).toFixed(2));
  console.log('SF totalBalance after:     $' + (Number(totAfter)/1e6).toFixed(2));
  console.log('\nDone. Rescue scheduler should now clear the parked queue.');
}

main().catch(e => { console.error(e); process.exit(1); });
