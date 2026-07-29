/**
 * sf_rescue_topup_v8_36.js
 * Mints USDC and tops up the V8.36 StabilityFund T1 rescue bucket.
 *
 * Situation: 104 members parked in T1 MatA, SF has only $14.42.
 * Each rescue needs up to $10 from SF → need ~$1,040 to clear the queue.
 * Adding $1,000 to give overnight rescue + headroom.
 *
 * Steps:
 *   1. Mint $1,000 USDC to deployer (MockUSDC)
 *   2. Temporarily authorize deployer on SF (receiveLayer gated)
 *   3. Approve + deposit $1,000 into SF via receiveLayer(tierIdx=0, layer=1)
 *   4. Revoke deployer's SF authorization
 *
 * Usage: npx hardhat run scripts/sf_rescue_topup_v8_36.js --network baseSepolia
 */
const hre = require('hardhat');
const fs   = require('fs');
const path = require('path');
const { ethers } = hre;

const TOPUP_USDC = 1_000_000_000n; // $1,000 (6 decimals)
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SF_ABI = [
  'function setMatrixAuthorized(address matrix, bool authorized) external',
  'function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external',
  'function totalBalance() view returns (uint256)',
  'function balanceByTier(uint8) view returns (uint256)',
];
const ERC20_ABI = [
  'function mint(address to, uint256 amount) external',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_36.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const [deployer] = await hre.ethers.getSigners();
  console.log('Deployer:', deployer.address);
  console.log('SF      :', addrs.stabilityFund);
  console.log('USDC    :', addrs.usdc);

  const sf   = new ethers.Contract(addrs.stabilityFund, SF_ABI, deployer);
  const usdc = new ethers.Contract(addrs.usdc, ERC20_ABI, deployer);

  // Read SF state before
  const totBefore = await sf.totalBalance();
  const t1Before  = await sf.balanceByTier(0);
  console.log(`\nSF before — total: $${(Number(totBefore)/1e6).toFixed(2)}  T1 bucket: $${(Number(t1Before)/1e6).toFixed(2)}`);

  // Step 1: Mint USDC to deployer
  console.log(`\n[1/4] Minting $${Number(TOPUP_USDC)/1e6} USDC to deployer...`);
  const mintTx = await usdc.mint(deployer.address, TOPUP_USDC, { gasLimit: 100_000 });
  await mintTx.wait();
  const bal = await usdc.balanceOf(deployer.address);
  console.log(`  ✓ Deployer USDC balance now: $${(Number(bal)/1e6).toFixed(2)}`);
  await sleep(4000);

  // Step 2: Authorize deployer on SF
  console.log('\n[2/4] Authorizing deployer as SF matrix caller...');
  const authTx = await sf.setMatrixAuthorized(deployer.address, true, { gasLimit: 100_000 });
  await authTx.wait();
  console.log('  ✓ Authorized');
  await sleep(4000);

  // Step 3: Approve + deposit
  console.log(`\n[3/4] Approving SF for $${Number(TOPUP_USDC)/1e6} USDC...`);
  const approveTx = await usdc.approve(addrs.stabilityFund, TOPUP_USDC, { gasLimit: 100_000 });
  await approveTx.wait();
  console.log('  ✓ Approved');
  await sleep(4000);

  console.log(`\n      Depositing into SF T1 bucket via receiveLayer(0, ${TOPUP_USDC}, 1)...`);
  const depositTx = await sf.receiveLayer(0, TOPUP_USDC, 1, { gasLimit: 300_000 });
  console.log('  TX:', depositTx.hash);
  const receipt = await depositTx.wait();
  console.log('  Status:', receipt.status === 1 ? '✓ success' : '❌ FAILED', '  gas=' + receipt.gasUsed);
  await sleep(4000);

  // Step 4: Revoke authorization
  console.log('\n[4/4] Revoking deployer SF authorization...');
  const revokeTx = await sf.setMatrixAuthorized(deployer.address, false, { gasLimit: 100_000 });
  await revokeTx.wait();
  console.log('  ✓ Revoked');

  // Final state
  const totAfter = await sf.totalBalance();
  const t1After  = await sf.balanceByTier(0);
  console.log(`\nSF after  — total: $${(Number(totAfter)/1e6).toFixed(2)}  T1 bucket: $${(Number(t1After)/1e6).toFixed(2)}`);
  console.log('\n✅  Done. Rescue keeper will now clear the 104-member parked queue overnight.');
  console.log('   (1h grace period active — all parked members eligible within the hour)');
}

main().catch(e => { console.error(e); process.exit(1); });
