/**
 * reclaim_coupon.js — Reclaim USDC from an expired unused coupon
 *
 * Usage:
 *   node scripts/reclaim_coupon.js CODE=LAUNCH10
 *
 * Only the original issuer can reclaim, and only after 30 days have passed.
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.includes('=')).map(a => a.split('='))
);
const CODE = ARGS.CODE;
if (!CODE) { console.error('Usage: node scripts/reclaim_coupon.js CODE=<plaintext_code>'); process.exit(1); }

const RPC_URL    = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const ADDRS_FILE = process.env.ADDRESSES_FILE   || 'deployed_addresses_v8_30.json';

const ABI = [
  'function reclaimCoupon(bytes32 codeHash) external',
  'function coupons(bytes32) external view returns (address issuer, uint256 amount, uint256 expiry, bool used)',
];

async function main() {
  const addrsPath = path.join(__dirname, '..', ADDRS_FILE);
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  const reg      = new ethers.Contract(addrs.couponRegistry, ABI, wallet);

  const codeHash = ethers.keccak256(ethers.toUtf8Bytes(CODE));
  const c = await reg.coupons(codeHash);

  if (c.issuer === ethers.ZeroAddress) { console.error('❌ Coupon not found.'); process.exit(1); }
  if (c.used)                          { console.error('❌ Coupon already used — nothing to reclaim.'); process.exit(1); }

  const now = Math.floor(Date.now() / 1000);
  if (now < Number(c.expiry)) {
    const remaining = Math.ceil((Number(c.expiry) - now) / 86400);
    console.error(`❌ Coupon still valid for ${remaining} more day(s). Can only reclaim after expiry.`);
    process.exit(1);
  }

  console.log(`Reclaiming $${(Number(c.amount)/1e6).toFixed(2)} USDC for code "${CODE}"…`);
  const tx = await reg.reclaimCoupon(codeHash);
  await tx.wait();
  console.log(`✅ Reclaimed! $${(Number(c.amount)/1e6).toFixed(2)} USDC returned to ${wallet.address}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
