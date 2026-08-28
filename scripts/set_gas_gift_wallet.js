/**
 * set_gas_gift_wallet.js — point CouponRegistry.gasGiftWallet at the wallet that
 * actually pays recipients.
 *
 *   npx hardhat run scripts/set_gas_gift_wallet.js --network baseSepolia
 *
 * ⛔ WHY (session 44, 2026-08-28). issueCoupon forwards the sponsor's ETH gas gift to
 * `gasGiftWallet` (CouponRegistry.sol:133-136). That slot was never attached after the
 * gas gift wallet was created in an earlier session, so it still held the address that
 * happened to be there — the OPS wallet 0xa23A0492…F5ba4019. Meanwhile recipients are
 * funded by /api/gas-gift from a DIFFERENT wallet (the FAUCET/GAS_GIFT key). Result:
 * every sponsor's gas contribution landed in ops and never funded anyone. Nobody was
 * stranded (the API pays out regardless) and this is testnet ETH, but the same wiring
 * on mainnet would be real money going to the wrong place.
 *
 * Owner decision 2026-08-28: REWIRE, do not remove. The gas gift was the community's
 * own idea and it stays; this makes the contribution actually replenish the payer.
 *
 * TARGET defaults to the funder address returned by /api/gas-gift-address on
 * 2026-08-28. ⚠ VERIFY IT STILL MATCHES before running — if GAS_GIFT_PRIVATE_KEY or
 * FAUCET_PRIVATE_KEY is ever rotated in Vercel, this address changes and the two halves
 * silently drift apart again, which is the exact failure this script exists to fix.
 * Re-check: https://www.crypto-nova.app/api/gas-gift-address
 */
const hre  = require('hardhat');
const fs   = require('fs');
const path = require('path');
const { ethers } = hre;

async function main() {
  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_50.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const TARGET = process.env.GAS_GIFT_WALLET || '0xE5F5cc91e8c5251193eF3108374Ae44CEE9841D3';
  if (!ethers.isAddress(TARGET)) throw new Error('GAS_GIFT_WALLET is not a valid address: ' + TARGET);

  const [signer] = await hre.ethers.getSigners();
  console.log('Signer      :', signer.address);
  console.log('Registry    :', addrs.couponRegistry);

  const cr = new ethers.Contract(addrs.couponRegistry, [
    'function gasGiftWallet() view returns (address)',
    'function setGasGiftWallet(address _wallet) external',
    'function owner() view returns (address)',
  ], signer);

  const owner = await cr.owner().catch(() => null);
  if (owner && owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer is not the owner (owner is ${owner}) — this call would revert`);
  }

  const before = await cr.gasGiftWallet();
  console.log('Current     :', before, before.toLowerCase() === (addrs.opsWallet || '').toLowerCase() ? '  <-- the OPS wallet, i.e. the bug' : '');
  console.log('Setting to  :', ethers.getAddress(TARGET));

  if (before.toLowerCase() === TARGET.toLowerCase()) {
    console.log('\n✓ already set to the target — nothing to do.');
    return;
  }

  const tx = await cr.setGasGiftWallet(ethers.getAddress(TARGET), { gasLimit: 100_000 });
  console.log('tx          :', tx.hash);
  await tx.wait();

  // ⚠ RETRY THE READ-BACK. First version of this script asserted on a SINGLE read and
  // cried "the set did not take" on a transaction that had in fact succeeded — the read
  // simply landed on a pool node that had not yet seen the block. A read-after-write
  // against a load-balanced RPC is not a measurement until it agrees with itself.
  let after = null;
  for (let i = 0; i < 6; i++) {
    after = await cr.gasGiftWallet();
    if (after.toLowerCase() === TARGET.toLowerCase()) break;
    console.log(`  read-back still stale (${after}) — retry ${i + 1}/6 …`);
    await new Promise(r => setTimeout(r, 2500));
  }
  console.log('\nNow         :', after);
  if (after.toLowerCase() !== TARGET.toLowerCase()) {
    throw new Error('read-back still MISMATCHED after 6 tries — check the tx on BaseScan '
                  + 'before assuming it failed; a Success status with a GasGiftWalletUpdated '
                  + 'log means the write landed and only the read is behind.');
  }
  console.log('✓ gasGiftWallet now points at the wallet that funds recipients.');
  console.log('  Sponsors\' gas contributions will replenish it from here on.');
  console.log('  ⚠ ETH already sent to the old wallet stays there — sweep it separately if wanted.');
}

main().catch((e) => { console.error(e); process.exit(1); });
