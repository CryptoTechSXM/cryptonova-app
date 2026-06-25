/**
 * early_unlock_all.js
 * Call earlyUnlockAll() on CNOVAToken to pay the vesting penalty
 * and immediately unlock all deployer CNOVA for transfer.
 *
 * Usage:
 *   node scripts/early_unlock_all.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs   = require('fs');
const path = require('path');

async function main() {
  const addrs = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'deployed_addresses_v8_22.json'), 'utf8'));

  const RPC_URL = process.env.BASE_SEPOLIA_RPC ?? process.env.BASE_SEPOLIA_RPC_URL;
  const KEY     = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.DEPLOYER_KEY;
  if (!RPC_URL) throw new Error('BASE_SEPOLIA_RPC not set');
  if (!KEY)     throw new Error('DEPLOYER_PRIVATE_KEY not set');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(KEY, provider);

  const CNOVA_ABI = [
    'function earlyUnlockAll() external returns (uint256 totalReleased, uint256 totalPenalty)',
    'function balanceOf(address) view returns (uint256)',
    'function lockedBalanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function vestBatchesOf(address) view returns (tuple(uint128 amount, uint128 unlockAt)[])',
  ];
  const DS_ABI = [
    'function floorPriceE6() view returns (uint256)',
    'function currentMultBps() view returns (uint256)',
  ];

  const cnova = new ethers.Contract(addrs.cnova, CNOVA_ABI, wallet);
  const ds    = new ethers.Contract(addrs.directSale, DS_ABI, provider);

  // ── Before state ──────────────────────────────────────────────────────────
  const [balBefore, lockedBefore, supplyBefore, batches, floorE6Before, multBps] =
    await Promise.all([
      cnova.balanceOf(wallet.address),
      cnova.lockedBalanceOf(wallet.address),
      cnova.totalSupply(),
      cnova.vestBatchesOf(wallet.address),
      ds.floorPriceE6(),
      ds.currentMultBps(),
    ]);

  const unlockedBefore = balBefore > lockedBefore ? balBefore - lockedBefore : 0n;
  const floorBefore    = Number(floorE6Before) / 1e6;
  const tierPrice      = floorBefore * Number(multBps) / 10000;

  console.log('─────────────────────────────────────────');
  console.log('BEFORE earlyUnlockAll()');
  console.log(`  Balance      : ${ethers.formatUnits(balBefore, 18)} CNOVA`);
  console.log(`  Locked       : ${ethers.formatUnits(lockedBefore, 18)} CNOVA`);
  console.log(`  Unlocked     : ${ethers.formatUnits(unlockedBefore, 18)} CNOVA`);
  console.log(`  Total supply : ${ethers.formatUnits(supplyBefore, 18)} CNOVA`);
  console.log(`  Floor price  : $${floorBefore.toFixed(6)}`);
  console.log(`  Vest batches : ${batches.length}`);
  console.log('─────────────────────────────────────────');

  if (batches.length === 0) {
    console.log('No vest batches found — nothing to unlock.');
    return;
  }

  // Estimate penalty
  const now = BigInt(Math.floor(Date.now() / 1000));
  let estPenalty = 0n;
  for (const b of batches) {
    const unlockAt = BigInt(b.unlockAt);
    if (now < unlockAt) {
      const timeRemaining = unlockAt - now;
      // vestDuration default = 180 days
      const vestDuration = BigInt(180 * 24 * 3600);
      const tr = timeRemaining < vestDuration ? timeRemaining : vestDuration;
      estPenalty += (BigInt(b.amount) * 5000n * tr) / (10000n * vestDuration);
    }
  }
  const estReleased = balBefore - estPenalty;

  console.log('\n📊  Estimated outcome:');
  console.log(`  Penalty (burned) : ~${ethers.formatUnits(estPenalty, 18)} CNOVA (~50%)`);
  console.log(`  Released         : ~${ethers.formatUnits(estReleased, 18)} CNOVA`);

  const seedCNOVA = Number(ethers.formatUnits(estReleased, 18));
  const seedUSDC  = seedCNOVA * tierPrice * 1.25; // 1.25× AMM premium
  console.log(`\n  LP seed (after unlock):`);
  console.log(`    CNOVA : ~${seedCNOVA.toFixed(0)}`);
  console.log(`    USDC  : ~$${seedUSDC.toFixed(2)} (at 1.25× tier price)`);
  console.log('─────────────────────────────────────────\n');

  // ── Call earlyUnlockAll ───────────────────────────────────────────────────
  console.log('Calling earlyUnlockAll()...');
  const tx  = await cnova.earlyUnlockAll();
  const rcp = await tx.wait();
  console.log(`✅ earlyUnlockAll confirmed (gas: ${rcp.gasUsed})`);

  // ── After state ───────────────────────────────────────────────────────────
  const [balAfter, lockedAfter, supplyAfter, floorE6After] = await Promise.all([
    cnova.balanceOf(wallet.address),
    cnova.lockedBalanceOf(wallet.address),
    cnova.totalSupply(),
    ds.floorPriceE6(),
  ]);

  const unlockedAfter = balAfter > lockedAfter ? balAfter - lockedAfter : 0n;
  const floorAfter    = Number(floorE6After) / 1e6;
  const penaltyPaid   = balBefore - balAfter;

  console.log('\n─────────────────────────────────────────');
  console.log('AFTER earlyUnlockAll()');
  console.log(`  Balance      : ${ethers.formatUnits(balAfter, 18)} CNOVA`);
  console.log(`  Locked       : ${ethers.formatUnits(lockedAfter, 18)} CNOVA`);
  console.log(`  Unlocked     : ${ethers.formatUnits(unlockedAfter, 18)} CNOVA`);
  console.log(`  Total supply : ${ethers.formatUnits(supplyAfter, 18)} CNOVA`);
  console.log(`  Floor price  : $${floorAfter.toFixed(6)} (was $${floorBefore.toFixed(6)})`);
  console.log(`  Penalty burned: ${ethers.formatUnits(penaltyPaid, 18)} CNOVA`);
  console.log('─────────────────────────────────────────');

  const finalCNOVA = Number(ethers.formatUnits(balAfter, 18));
  const finalUSDC  = finalCNOVA * floorAfter * 1.25 * Number(multBps) / 10000;
  console.log(`\n✅  Ready to seed LP with ${finalCNOVA.toFixed(0)} CNOVA`);
  console.log(`   USDC needed : $${finalUSDC.toFixed(2)}`);
  console.log(`\n   Run next:`);
  console.log(`   $env:LP_ADDR="0xceEC4bC9E6a9E8fBFe6D2aeC8D1e23f1C8bb4310"; $env:SEED_USDC="${finalUSDC.toFixed(2)}"; $env:SEED_CNOVA="${finalCNOVA.toFixed(0)}"; node scripts/seed_lp.js`);
}
main().catch(e => { console.error(e); process.exit(1); });
