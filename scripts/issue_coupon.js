/**
 * issue_coupon.js — Mint a one-time coupon code for a new member
 *
 * Usage:
 *   node scripts/issue_coupon.js CODE=LAUNCH10
 *   node scripts/issue_coupon.js CODE=FRIEND50 AMOUNT=5000000   (override amount, 6-decimal USDC)
 *
 * What it does:
 *   1. Hashes the plaintext CODE with keccak256
 *   2. Approves couponAmount USDC to CouponRegistry
 *   3. Calls issueCoupon(hash) — deposits USDC into registry, valid 30 days
 *   4. Prints the plaintext code + hash to share with the new member
 *
 * The issuer (DEPLOYER_KEY) pays the USDC upfront.
 * If the coupon is unused after 30 days, run reclaim_coupon.js to get it back.
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.includes('='))
    .map(a => a.split('='))
);

const CODE = ARGS.CODE;
if (!CODE) {
  console.error('Usage: node scripts/issue_coupon.js CODE=<plaintext_code>');
  process.exit(1);
}

const RPC_URL   = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const ADDRS_FILE = process.env.ADDRESSES_FILE  || 'deployed_addresses_v8_30.json';

const COUPON_REG_ABI = [
  'function issueCoupon(bytes32 codeHash) external',
  'function couponAmount() external view returns (uint256)',
  'function isValid(bytes32 codeHash) external view returns (bool)',
  'function coupons(bytes32) external view returns (address issuer, uint256 amount, uint256 expiry, bool used)',
];
const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

async function main() {
  // ── Load addresses ──────────────────────────────────────────────────────
  const addrsPath = path.join(__dirname, '..', ADDRS_FILE);
  if (!fs.existsSync(addrsPath)) {
    console.error(`Addresses file not found: ${addrsPath}`);
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));
  const couponRegAddr = addrs.couponRegistry;
  const usdcAddr      = addrs.usdc;

  if (!couponRegAddr) { console.error('couponRegistry address missing from addresses file'); process.exit(1); }
  if (!usdcAddr)      { console.error('usdc address missing from addresses file'); process.exit(1); }

  // ── Provider + signer ───────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  console.log(`Issuer wallet : ${wallet.address}`);

  const couponReg = new ethers.Contract(couponRegAddr, COUPON_REG_ABI, wallet);
  const usdc      = new ethers.Contract(usdcAddr,      USDC_ABI,       wallet);

  // ── Hash the code ───────────────────────────────────────────────────────
  const codeHash = ethers.keccak256(ethers.toUtf8Bytes(CODE));
  console.log(`\nPlaintext code : "${CODE}"`);
  console.log(`Code hash      : ${codeHash}`);

  // ── Check it isn't already issued ───────────────────────────────────────
  const existing = await couponReg.coupons(codeHash);
  if (existing.issuer !== ethers.ZeroAddress) {
    console.error('\n❌ This coupon code has already been issued (hash collision or duplicate). Choose a different code.');
    process.exit(1);
  }

  // ── Determine amount ────────────────────────────────────────────────────
  const couponAmt = ARGS.AMOUNT ? BigInt(ARGS.AMOUNT) : await couponReg.couponAmount();
  const usdcFmt   = (Number(couponAmt) / 1e6).toFixed(2);
  console.log(`\nCoupon value   : $${usdcFmt} USDC`);
  console.log(`Valid for      : 30 days after issuance`);

  // ── Check balance ───────────────────────────────────────────────────────
  const bal = await usdc.balanceOf(wallet.address);
  if (bal < couponAmt) {
    console.error(`\n❌ Insufficient USDC. Need $${usdcFmt}, have $${(Number(bal)/1e6).toFixed(2)}`);
    process.exit(1);
  }

  // ── Approve if needed ───────────────────────────────────────────────────
  const allowance = await usdc.allowance(wallet.address, couponRegAddr);
  if (allowance < couponAmt) {
    console.log('\nStep 1/2: Approving USDC to CouponRegistry…');
    const approveTx = await usdc.approve(couponRegAddr, couponAmt);
    await approveTx.wait();
    console.log('✅ Approved');
  } else {
    console.log('\nStep 1/2: USDC already approved — skipping');
  }

  // ── Issue the coupon ────────────────────────────────────────────────────
  console.log('Step 2/2: Issuing coupon on-chain…');
  const tx = await couponReg.issueCoupon(codeHash);
  const receipt = await tx.wait();
  console.log(`✅ Coupon issued! TX: ${receipt.hash}`);

  // ── Expiry time ─────────────────────────────────────────────────────────
  const block  = await provider.getBlock(receipt.blockNumber);
  const expiry = new Date((block.timestamp + 30 * 24 * 3600) * 1000);
  console.log(`   Expires: ${expiry.toUTCString()}`);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────');
  console.log('  COUPON READY TO SHARE');
  console.log('─────────────────────────────────────────────');
  console.log(`  Code    : ${CODE}`);
  console.log(`  Value   : $${usdcFmt} off the $10 entry fee`);
  console.log(`  Expires : ${expiry.toDateString()}`);
  console.log('─────────────────────────────────────────────');
  console.log('\nSend the CODE (not the hash) to the new member.');
  console.log('They enter it in the Coupon Code field on the Register tab.');
  console.log('\nTo reclaim if unused: node scripts/reclaim_coupon.js CODE=' + CODE);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
