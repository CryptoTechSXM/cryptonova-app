/**
 * buy_cnova_for_lp.js
 * Buy CNOVA through CNOVADirectSale for AMM seeding.
 *
 * Steps:
 *   1. Read live floor + tier price
 *   2. Calculate USDC needed for TARGET_CNOVA at tier price
 *   3. Temporarily disable whale caps (deployer = owner)
 *   4. Approve USDC + buy
 *   5. Restore caps
 *   6. Print result + updated floor price
 *
 * Usage:
 *   node scripts/buy_cnova_for_lp.js
 *   TARGET_CNOVA=50000 node scripts/buy_cnova_for_lp.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const TARGET_CNOVA    = parseFloat(process.env.TARGET_CNOVA ?? '100000');
const DELAY_MS        = 3000; // 3s between txs to stay under public RPC rate limit
// Canonical cap values — used as restore target regardless of what's on-chain
// (guards against a previous partial run having left caps at 0)
const DEFAULT_TX_CAP     = 100n;
const DEFAULT_WALLET_CAP = 500n;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendWithRetry(fn, label, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await fn();
      const rcp = await tx.wait();
      console.log(`✅ ${label} (gas: ${rcp.gasUsed})`);
      await sleep(DELAY_MS);
      return rcp;
    } catch (e) {
      const msg = e.error?.message || e.shortMessage || e.message || '';
      if (msg.includes('rate limit') && i < retries - 1) {
        console.log(`  ⚠️  Rate limit on ${label}, waiting 10s...`);
        await sleep(10000);
      } else {
        throw e;
      }
    }
  }
}

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'deployed_addresses_v8_22.json'), 'utf8'));

  const DS_ABI = [
    'function buyCNOVA(uint256 usdcAmount) external',
    'function floorPriceE6() view returns (uint256)',
    'function currentMultBps() view returns (uint256)',
    'function setCaps(uint256 maxTxBps, uint256 maxWalletBps) external',
    'function maxTxBps() view returns (uint256)',
    'function maxWalletBps() view returns (uint256)',
  ];
  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
  ];

  const ds    = new ethers.Contract(addrs.directSale, DS_ABI, w);
  const usdc  = new ethers.Contract(addrs.usdc,  ERC20_ABI, w);
  const cnova = new ethers.Contract(addrs.cnova, ERC20_ABI, w);

  // ── 1. Read live prices ───────────────────────────────────────────────────
  const [floorE6, multBps, curTxCap, curWalletCap] = await Promise.all([
    ds.floorPriceE6(),
    ds.currentMultBps(),
    ds.maxTxBps(),
    ds.maxWalletBps(),
  ]);

  const floorUSD     = Number(floorE6) / 1e6;
  const multiplier   = Number(multBps) / 10000;
  const tierPriceE6  = floorE6 * multBps / 10000n;
  const tierPriceUSD = floorUSD * multiplier;

  // ── 2. Calculate USDC needed ──────────────────────────────────────────────
  // cnovaOut = usdcAmount * 1e18 / tierPriceE6
  // usdcAmount = TARGET_CNOVA * 1e18 * tierPriceE6 / 1e18 / 1e6 ... simplified:
  // usdcAmount (6 dec) = TARGET_CNOVA (18 dec) * tierPriceE6 / 1e18
  const cnovaTarget  = ethers.parseUnits(String(TARGET_CNOVA), 18);
  const usdcNeeded   = cnovaTarget * tierPriceE6 / ethers.parseUnits('1', 18);
  // Add 0.5% buffer so rounding doesn't leave us short
  const usdcWithBuffer = usdcNeeded * 1005n / 1000n;

  console.log('─────────────────────────────────────────');
  console.log(`Floor price   : $${floorUSD.toFixed(6)} / CNOVA`);
  console.log(`Tier price    : $${tierPriceUSD.toFixed(6)} / CNOVA`);
  console.log(`Target CNOVA  : ${TARGET_CNOVA.toLocaleString()}`);
  console.log(`USDC to spend : $${(Number(usdcWithBuffer) / 1e6).toFixed(2)}`);
  console.log('─────────────────────────────────────────');

  const usdcBal = await usdc.balanceOf(w.address);
  if (usdcBal < usdcWithBuffer) {
    throw new Error(`Insufficient USDC: have ${Number(usdcBal)/1e6}, need ${Number(usdcWithBuffer)/1e6}`);
  }

  // ── 3. Disable whale caps temporarily ────────────────────────────────────
  // Note: if a previous partial run left caps at 0, we still restore to DEFAULT at the end.
  console.log(`\nDisabling whale caps (on-chain: txCap=${curTxCap} walletCap=${curWalletCap})...`);
  if (curTxCap === 0n && curWalletCap === 0n) {
    console.log('  Caps already at 0 (previous partial run?) — skipping setCaps(0,0)');
    await sleep(DELAY_MS);
  } else {
    await sendWithRetry(() => ds.setCaps(0, 0), 'Caps disabled');
  }

  try {
    // ── 4. Approve + buy ────────────────────────────────────────────────────
    console.log(`Approving USDC...`);
    await sendWithRetry(() => usdc.approve(addrs.directSale, usdcWithBuffer), 'USDC approved');

    console.log(`Buying CNOVA...`);
    await sendWithRetry(() => ds.buyCNOVA(usdcWithBuffer), 'Purchase complete');

  } finally {
    // ── 5. Restore caps (always, even if buy fails) ──────────────────────
    // Always restore to DEFAULT values — never trust curTxCap/curWalletCap as restore target
    // because a prior crashed run may have left them at 0 on-chain.
    console.log(`\nRestoring whale caps to defaults (txCap=${DEFAULT_TX_CAP} walletCap=${DEFAULT_WALLET_CAP})...`);
    await sendWithRetry(() => ds.setCaps(DEFAULT_TX_CAP, DEFAULT_WALLET_CAP), 'Caps restored');
  }

  // ── 6. Print result ───────────────────────────────────────────────────────
  const [cnovaBal, newFloorE6, newSupply] = await Promise.all([
    cnova.balanceOf(w.address),
    ds.floorPriceE6(),
    cnova.totalSupply(),
  ]);

  console.log('\n─────────────────────────────────────────');
  console.log(`CNOVA balance  : ${ethers.formatUnits(cnovaBal, 18)}`);
  console.log(`Total supply   : ${ethers.formatUnits(newSupply, 18)}`);
  console.log(`New floor price: $${(Number(newFloorE6)/1e6).toFixed(6)} / CNOVA`);
  console.log('─────────────────────────────────────────');
  console.log('\nReady to seed AMM. Run check_amm_seed_price.js to get updated deploy command.');
}
main().catch(console.error);
