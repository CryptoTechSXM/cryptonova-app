/**
 * topup_sf.js
 * Deposits USDC into the StabilityFund.
 *
 * Funding source: W1 wallet (W1_PRIVATE_KEY in .env) — it has USDC from seed_w1.
 * Deployer (owner) is used only to authorize/deauthorize W1 as a matrix caller.
 *
 * Usage: npx hardhat run scripts/topup_sf.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const AMOUNT_USDC = '500'; // $500

const SF_ABI  = [
  'function setMatrixAuthorized(address matrix, bool authorized) external',
  'function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external',
  'function totalBalance() view returns (uint256)',
  'function balanceByTier(uint8) view returns (uint256)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  require('dotenv').config();
  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_30.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  // Deployer is the SF owner (needed for setMatrixAuthorized)
  const [signer] = await hre.ethers.getSigners();

  // W1 is the USDC source — it received $491 during seed_w1
  const w1Key = process.env.W1_PRIVATE_KEY || process.env.SEED_W1_KEY;
  if (!w1Key) {
    console.error('❌  W1_PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);

  console.log('Deployer (owner):', signer.address);
  console.log('W1 (funder)     :', w1Wallet.address);
  console.log('SF              :', addrs.stabilityFund);
  console.log('USDC            :', addrs.usdc);

  const amount = ethers.parseUnits(AMOUNT_USDC, 6);
  const usdc   = new ethers.Contract(addrs.usdc, ERC20_ABI, signer);
  const sf     = new ethers.Contract(addrs.stabilityFund, SF_ABI, signer);

  // Check W1 has enough USDC
  const w1Bal = await usdc.balanceOf(w1Wallet.address);
  console.log(`\nW1 USDC balance: $${ethers.formatUnits(w1Bal, 6)}`);
  if (w1Bal < amount) {
    console.error(`❌  W1 only has $${ethers.formatUnits(w1Bal, 6)} — need $${AMOUNT_USDC}`);
    process.exit(1);
  }

  const beforeTotal = await sf.totalBalance();
  const beforeT1    = await sf.balanceByTier(0);
  console.log(`\nSF before — total: $${ethers.formatUnits(beforeTotal,6)}  T1: $${ethers.formatUnits(beforeT1,6)}`);

  // Step 1: deployer authorizes W1 as a matrix caller temporarily
  console.log('\nAuthorizing W1 as matrix caller…');
  const authTx = await sf.setMatrixAuthorized(w1Wallet.address, true);
  await authTx.wait();
  console.log('Authorized ✅');
  await sleep(8000);

  // Step 2: W1 approves SF to pull USDC
  console.log(`W1 approving SF for $${AMOUNT_USDC} USDC…`);
  const approveTx = await usdc.connect(w1Wallet).approve(addrs.stabilityFund, amount);
  await approveTx.wait();
  console.log('Approved ✅');
  await sleep(8000);

  // Step 3: W1 deposits via receiveLayer (tierIdx=0 = T1, layer=1)
  console.log(`W1 depositing $${AMOUNT_USDC} into SF via receiveLayer…`);
  const depositTx = await sf.connect(w1Wallet).receiveLayer(0, amount, 1);
  console.log('TX:', depositTx.hash);
  await depositTx.wait();
  console.log('Deposited ✅');
  await sleep(8000);

  // Step 4: deployer revokes W1's matrix authorization
  console.log('Revoking W1 matrix authorization…');
  const revokeTx = await sf.setMatrixAuthorized(w1Wallet.address, false);
  await revokeTx.wait();
  console.log('Revoked ✅');

  const afterTotal = await sf.totalBalance();
  const afterT1    = await sf.balanceByTier(0);
  console.log(`\nSF after  — total: $${ethers.formatUnits(afterTotal,6)}  T1: $${ethers.formatUnits(afterT1,6)}`);
  console.log('\n✅  StabilityFund funded successfully.');
}

main().catch(e => { console.error(e); process.exit(1); });
