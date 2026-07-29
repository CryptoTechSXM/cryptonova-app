const { ethers } = require('hardhat');

const COUPON_REGISTRY = '0x5873F8140662088221a6A97A07DD0FDD416A2E41';
const USDC            = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const W1              = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';
const CODE            = 'TESTCNOVA';

const REG_ABI = [
  'function coupons(bytes32) view returns (address issuer, uint256 amount, uint256 expiry, bool used)',
  'function couponAmount() view returns (uint256)',
  'function authorizedMatrix(address) view returns (bool)',
];
const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const reg  = await ethers.getContractAt(REG_ABI, COUPON_REGISTRY);
  const usdc = await ethers.getContractAt(USDC_ABI, USDC);

  const codeHash = ethers.keccak256(ethers.toUtf8Bytes(CODE));
  const coupon   = await reg.coupons(codeHash);
  const amount   = await reg.couponAmount();
  const w1Bal    = await usdc.balanceOf(W1);

  console.log(`\n=== Coupon Check ===`);
  console.log(`  Code:         ${CODE}`);
  console.log(`  codeHash:     ${codeHash}`);
  console.log(`  Taken:        ${coupon.issuer !== ethers.ZeroAddress}`);
  if (coupon.issuer !== ethers.ZeroAddress) {
    console.log(`  Issuer:       ${coupon.issuer}`);
    console.log(`  Used:         ${coupon.used}`);
    console.log(`  Expiry:       ${new Date(Number(coupon.expiry)*1000).toISOString()}`);
  }

  console.log(`\n=== W1 Wallet ===`);
  console.log(`  USDC balance: $${ethers.formatUnits(w1Bal, 6)}`);
  console.log(`  Coupon cost:  $${ethers.formatUnits(amount, 6)}`);
  console.log(`  Can issue:    ${w1Bal >= amount}`);

  // Check T1 MatA is authorized
  const T1_MAT_A = '0x5E52d5A6d118F7539D56C2f37555B25e6308545D';
  const T1_MAT_B = '0x85ac86445F72c3458C2feC3C2D6F268dC124DBCe';
  const authA = await reg.authorizedMatrix(T1_MAT_A);
  const authB = await reg.authorizedMatrix(T1_MAT_B);
  console.log(`\n=== Matrix Authorization ===`);
  console.log(`  T1 MatA authorized: ${authA}`);
  console.log(`  T1 MatB authorized: ${authB}`);
}

main().catch(console.error);
