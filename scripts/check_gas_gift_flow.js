/**
 * check_gas_gift_flow.js — the instrument for 44.14 part 2.
 *
 *   MODE=snapshot npx hardhat run scripts/check_gas_gift_flow.js --network baseSepolia
 *   ... issue ONE coupon on admin.crypto-nova.app/pif.html ...
 *   MODE=compare  npx hardhat run scripts/check_gas_gift_flow.js --network baseSepolia
 *
 * WHAT IS BEING TESTED. `CouponRegistry.issueCoupon` forwards msg.value to
 * `gasGiftWallet` (CouponRegistry.sol:133-136). Until 2026-08-28 that slot held the
 * OPS wallet, not the API funder, so every sponsor's ETH accumulated where nobody is
 * ever paid from. `setGasGiftWallet` has since been run and the pointer reads correct.
 * ⛔ BUT A POINTER IS NOT A PAYMENT. Nobody has yet watched one real coupon move the
 * money. This is mainnet-critical: on mainnet that ETH is real.
 *
 * WHY TWO MODES AND NOT ONE READ. The sponsor's own balance falls by the gift PLUS
 * gas, so it can never prove the amount by itself. The decisive pair is:
 *   FUNDER increases by EXACTLY the gift, and OPS does not move at all.
 * A single "after" reading cannot show either. Snapshot writes the before-state to
 * disk so the comparison is one measurement, not two impressions taken minutes apart.
 *
 * It signs nothing and sends nothing. Pure reads.
 *
 * Env:
 *   SPONSOR — the wallet you will issue the coupon from.
 *             Defaults to the owner's QA member wallet.
 */
const hre  = require('hardhat');
const fs   = require('fs');
const path = require('path');

const A = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployed_addresses_v8_50.json'), 'utf8'));

const COUPON_REGISTRY = A.couponRegistry;
const OPS             = A.opsWallet;
const USDC            = A.usdc;
const SPONSOR = process.env.SPONSOR || '0x26388a81eb9448DF02144cc765Bb448444e61f9B';
const SNAP    = path.join(__dirname, '.gas_gift_snapshot.json');

// index.html:5123 GAS_GIFT_WEI and pif.html GAS_GIFT_ETH must both equal this.
const EXPECTED_GIFT = hre.ethers.parseEther('0.0001');

const REG_ABI  = ['function gasGiftWallet() view returns (address)'];
const ERC20    = ['function balanceOf(address) view returns (uint256)',
                  'function decimals() view returns (uint8)'];

const eth = v => hre.ethers.formatEther(v);

async function readState() {
  const p    = hre.ethers.provider;
  const reg  = new hre.ethers.Contract(COUPON_REGISTRY, REG_ABI, p);
  const usdc = new hre.ethers.Contract(USDC, ERC20, p);

  // A read-after-write against a load-balanced RPC is not a measurement until it
  // agrees with itself (the set_gas_gift_wallet lesson). Read the pointer twice.
  let funder = await reg.gasGiftWallet();
  for (let i = 0; i < 5; i++) {
    const again = await reg.gasGiftWallet();
    if (again === funder) break;
    funder = again;
    await new Promise(r => setTimeout(r, 1200));
  }

  const block = await p.getBlockNumber();
  return {
    block,
    at: new Date().toISOString(),
    gasGiftWallet: funder,
    sponsor:  SPONSOR,
    balances: {
      sponsorETH: (await p.getBalance(SPONSOR)).toString(),
      funderETH:  (await p.getBalance(funder)).toString(),
      opsETH:     (await p.getBalance(OPS)).toString(),
      sponsorUSDC:(await usdc.balanceOf(SPONSOR)).toString(),
    }
  };
}

function show(s) {
  console.log(`  block          ${s.block}   (${s.at})`);
  console.log(`  gasGiftWallet  ${s.gasGiftWallet}`);
  console.log(`  sponsor        ${s.sponsor}`);
  console.log(`    sponsor ETH  ${eth(s.balances.sponsorETH)}`);
  console.log(`    funder  ETH  ${eth(s.balances.funderETH)}`);
  console.log(`    ops     ETH  ${eth(s.balances.opsETH)}`);
  console.log(`    sponsor USDC ${(Number(s.balances.sponsorUSDC) / 1e6).toFixed(2)}`);
}

async function main() {
  const mode = (process.env.MODE || 'snapshot').toLowerCase();
  console.log(`\nCouponRegistry ${COUPON_REGISTRY}`);
  console.log(`ops wallet     ${OPS}  (must NOT move)\n`);

  const now = await readState();

  if (mode === 'snapshot') {
    console.log('── BEFORE ──────────────────────────────');
    show(now);
    fs.writeFileSync(SNAP, JSON.stringify(now, null, 2));
    console.log(`\nSaved. Now issue exactly ONE coupon from ${SPONSOR} on`);
    console.log(`admin.crypto-nova.app/pif.html, then re-run with MODE=compare.`);
    if (now.gasGiftWallet.toLowerCase() === OPS.toLowerCase()) {
      console.log('\n⛔ STOP: gasGiftWallet still points at OPS. Re-run set_gas_gift_wallet.js first.');
    }
    return;
  }

  if (!fs.existsSync(SNAP)) { console.error('No snapshot found — run MODE=snapshot first.'); process.exit(2); }
  const before = JSON.parse(fs.readFileSync(SNAP, 'utf8'));

  console.log('── BEFORE ──────────────────────────────'); show(before);
  console.log('\n── AFTER ───────────────────────────────'); show(now);

  if (before.gasGiftWallet !== now.gasGiftWallet) {
    console.log('\n⚠ gasGiftWallet CHANGED between the two reads — investigate before trusting anything below.');
  }

  const d = k => BigInt(now.balances[k]) - BigInt(before.balances[k]);
  const dFunder = d('funderETH'), dOps = d('opsETH'), dSponsor = d('sponsorETH'), dUsdc = d('sponsorUSDC');

  console.log('\n── DELTAS ──────────────────────────────');
  console.log(`  funder  ETH  ${dFunder >= 0n ? '+' : ''}${eth(dFunder)}`);
  console.log(`  ops     ETH  ${dOps    >= 0n ? '+' : ''}${eth(dOps)}`);
  console.log(`  sponsor ETH  ${eth(dSponsor)}   (gift + gas — cannot prove the amount on its own)`);
  console.log(`  sponsor USDC ${(Number(dUsdc) / 1e6).toFixed(2)}`);

  console.log('\n── VERDICT ─────────────────────────────');
  let pass = true;
  if (dFunder === EXPECTED_GIFT) {
    console.log(`  ✅ funder received EXACTLY ${eth(EXPECTED_GIFT)} ETH`);
  } else if (dFunder === 0n) {
    console.log(`  ⛔ funder received NOTHING — the gift did not arrive`); pass = false;
  } else {
    console.log(`  ⚠ funder moved by ${eth(dFunder)}, expected ${eth(EXPECTED_GIFT)}`);
    console.log(`     (another transaction may have touched this wallet — check the block range)`); pass = false;
  }
  if (dOps === 0n) console.log(`  ✅ ops wallet did not move`);
  else { console.log(`  ⛔ OPS MOVED by ${eth(dOps)} — the old defect is still live`); pass = false; }

  if (dSponsor >= 0n) { console.log(`  ⚠ sponsor ETH did not fall — did the coupon actually go through?`); pass = false; }
  else if (-dSponsor < EXPECTED_GIFT) { console.log(`  ⛔ sponsor paid less than the gift — no gift was attached`); pass = false; }
  else console.log(`  ✅ sponsor paid ${eth(-dSponsor)} (gift ${eth(EXPECTED_GIFT)} + gas ${eth(-dSponsor - EXPECTED_GIFT)})`);

  if (dUsdc === -10_000000n) console.log(`  ✅ sponsor paid 10.00 USDC for the coupon`);
  else console.log(`  ⚠ sponsor USDC moved ${(Number(dUsdc)/1e6).toFixed(2)}, expected -10.00`);

  console.log(pass ? '\n✅ 44.14 PART 2 CONFIRMED — the gas gift reaches the funder wallet.'
                   : '\n⛔ NOT CONFIRMED. Do not close 44.14.');
}

main().catch(e => { console.error(e); process.exit(1); });
