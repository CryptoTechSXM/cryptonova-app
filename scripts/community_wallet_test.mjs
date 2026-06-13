/**
 * community_wallet_test.mjs
 *
 * End-to-end testnet verification of CommunityWallet.sol (V8.10, Base Sepolia).
 *
 * Steps:
 *   1. Report current CW state
 *   2. Enroll test wallets via enrollBatch() (owner-only, idempotent)
 *   3. Call distribute() — works immediately on first run since lastDistributionTime=0
 *   4. Report claimable amounts per enrolled wallet
 *   5. Call claim() for deployer + W1
 *
 * Usage:
 *   cd C:\CryptoNite-Smart-Contracts\CryptoNova
 *   node scripts/community_wallet_test.mjs
 */

import { ethers } from 'ethers';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const CW_ADDRESS   = '0x525D14dA6042cd0223388E922a8FA8E91eC2304D';
const USDC_ADDRESS = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const DEPLOYER_ADDR = '0xCd0Af6a4116f2062c1594aDf34c1821D45175506';
const W1_ADDR      = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';

const TEST_WALLETS = [DEPLOYER_ADDR, W1_ADDR];

const CW_ABI = [
  'function totalEnrolled() view returns (uint256)',
  'function genesisCount() view returns (uint256)',
  'function pioneerCount() view returns (uint256)',
  'function distributeInterval() view returns (uint256)',
  'function lastDistributionTime() view returns (uint256)',
  'function distributeReady() view returns (bool)',
  'function availablePool() view returns (uint256)',
  'function claimable(address member) view returns (uint256)',
  'function cohort(address member) view returns (uint8)',
  'function distributionCount() view returns (uint256)',
  'function enrollBatch(address[] calldata members) external',
  'function distribute() external',
  'function claim() external returns (uint256)',
  'event DistributionCreated(uint256 indexed distId, uint256 toDistribute, uint256 genesisShare, uint256 pioneerShare)',
  'event Claimed(address indexed member, uint256 amount)',
];

const USDC_ABI = ['function balanceOf(address account) view returns (uint256)'];

function sep(label) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + label);
  console.log('─'.repeat(60));
}

function fmt(usdcRaw) {
  return '$' + (Number(usdcRaw) / 1e6).toFixed(4);
}

function cohortLabel(c) {
  return c === 0n ? 'Not enrolled' : c === 1n ? 'Genesis' : 'Pioneer';
}

async function main() {
  const RPC_URL      = process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const W1_KEY       = process.env.W1_PRIVATE_KEY;

  if (!DEPLOYER_KEY) {
    console.error('❌  DEPLOYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);
  const w1       = W1_KEY ? new ethers.Wallet(W1_KEY, provider) : null;

  const cw   = new ethers.Contract(CW_ADDRESS,   CW_ABI,   deployer);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  // ── STEP 1: Current state ─────────────────────────────────────────────────
  sep('STEP 1 — Current CommunityWallet state');

  const cwBal         = await usdc.balanceOf(CW_ADDRESS);
  const totalEnrolled = await cw.totalEnrolled();
  const genesisCount  = await cw.genesisCount();
  const pioneerCount  = await cw.pioneerCount();
  const interval      = await cw.distributeInterval();
  const lastDist      = await cw.lastDistributionTime();
  const distCount     = await cw.distributionCount();
  const pool          = await cw.availablePool();

  const now      = BigInt(Math.floor(Date.now() / 1000));
  const nextDist = lastDist === 0n ? 0n : lastDist + interval;
  const secsLeft = nextDist > now ? nextDist - now : 0n;
  const firstRunReady = lastDist === 0n; // lastDistributionTime=0 → never run → eligible now

  console.log(`  USDC balance:       ${fmt(cwBal)}`);
  console.log(`  Available pool:     ${fmt(pool)}`);
  console.log(`  Total enrolled:     ${totalEnrolled}`);
  console.log(`  Genesis members:    ${genesisCount} / 500`);
  console.log(`  Pioneer members:    ${pioneerCount} / 500`);
  console.log(`  Distributions run:  ${distCount}`);
  console.log(`  Interval:           ${Number(interval) / 86400} days`);
  console.log(`  Last distributed:   ${lastDist === 0n ? 'never (first distribute ready immediately)' : new Date(Number(lastDist) * 1000).toISOString()}`);
  if (!firstRunReady && secsLeft > 0n) {
    const daysLeft = Number(secsLeft) / 86400;
    console.log(`  Next distribute in: ${daysLeft.toFixed(1)} days`);
  }

  console.log('\n  Enrollment status:');
  for (const addr of TEST_WALLETS) {
    const c = await cw.cohort(addr);
    console.log(`    ${addr.slice(0, 10)}...  →  ${cohortLabel(c)}`);
  }

  // ── STEP 2: Enroll test wallets ───────────────────────────────────────────
  sep('STEP 2 — Enroll test wallets via enrollBatch()');

  const toEnroll = [];
  for (const addr of TEST_WALLETS) {
    const c = await cw.cohort(addr);
    if (c === 0n) toEnroll.push(addr);
  }

  if (toEnroll.length === 0) {
    console.log('  ✅  All test wallets already enrolled — skipping');
  } else {
    console.log(`  Enrolling: ${toEnroll.join(', ')}`);
    const tx = await cw.enrollBatch(toEnroll, { gasLimit: 500_000n });
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait(1);
    console.log(`  ✅  Confirmed (block ${receipt.blockNumber})`);
    for (const addr of toEnroll) {
      const c = await cw.cohort(addr);
      console.log(`    ${addr.slice(0,10)}...  →  ${cohortLabel(c)} ✅`);
    }
    console.log(`  Total enrolled: ${await cw.totalEnrolled()}`);
  }

  // ── STEP 3: distribute() ─────────────────────────────────────────────────
  sep('STEP 3 — Call distribute()');

  const poolNow     = await cw.availablePool();
  const enrolledNow = await cw.totalEnrolled();
  const lastDistNow = await cw.lastDistributionTime();

  // On the very first run, lastDistributionTime=0 means block.timestamp >= 0+30days is always true
  const canDistribute = lastDistNow === 0n || (BigInt(Math.floor(Date.now() / 1000)) >= lastDistNow + interval);

  console.log(`  Pool available:  ${fmt(poolNow)}`);
  console.log(`  Members enrolled: ${enrolledNow}`);
  console.log(`  Can distribute:   ${canDistribute}`);

  if (poolNow === 0n) {
    console.log('\n  ⚠️   Pool is empty. The 1% carve accumulates with each registration.');
    console.log('  To fund immediately, send USDC directly to the CommunityWallet:');
    console.log(`  ${CW_ADDRESS}`);
    console.log('\n  Re-run this script after funding to complete the distribute/claim test.');
  } else if (enrolledNow === 0n) {
    console.log('\n  ⚠️   No members enrolled — cannot distribute.');
  } else if (!canDistribute) {
    const remaining = (lastDistNow + interval) - BigInt(Math.floor(Date.now() / 1000));
    console.log(`\n  ⏳  Interval not elapsed. Next distribute in ${Number(remaining) / 86400} days.`);
  } else {
    console.log('\n  Calling distribute()...');
    try {
      const tx = await cw.distribute({ gasLimit: 600_000n });
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait(1);
      console.log(`  ✅  distribute() confirmed (block ${receipt.blockNumber})`);

      // Parse DistributionCreated event
      for (const log of receipt.logs) {
        try {
          const parsed = cw.interface.parseLog(log);
          if (parsed?.name === 'DistributionCreated') {
            const [distId, total, genShare, pionShare] = parsed.args;
            console.log(`\n  Distribution #${distId}:`);
            console.log(`    Total distributed: ${fmt(total)}`);
            console.log(`    Genesis share (60%): ${fmt(genShare)}`);
            console.log(`    Pioneer share (40%): ${fmt(pionShare)}`);
            const genCt = await cw.genesisCount();
            const pioCt = await cw.pioneerCount();
            if (genCt > 0n) console.log(`    Per Genesis member: ${fmt(genShare / genCt)}`);
            if (pioCt > 0n) console.log(`    Per Pioneer member: ${fmt(pionShare / pioCt)}`);
          }
        } catch {}
      }
    } catch (e) {
      console.log(`  ❌  distribute() reverted: ${e.reason || e.message}`);
    }
  }

  // ── STEP 4: Claimable amounts ─────────────────────────────────────────────
  sep('STEP 4 — Claimable amounts per wallet');

  for (const addr of TEST_WALLETS) {
    const c     = await cw.cohort(addr);
    const claim = await cw.claimable(addr);
    console.log(`  ${addr.slice(0,10)}...  [${cohortLabel(c)}]  claimable: ${fmt(claim)}`);
  }

  // ── STEP 5: claim() ───────────────────────────────────────────────────────
  sep('STEP 5 — Claim USDC');

  // Deployer claim
  const deplClaimable = await cw.claimable(deployer.address);
  if (deplClaimable > 0n) {
    const balBefore = await usdc.balanceOf(deployer.address);
    const tx = await cw.connect(deployer).claim({ gasLimit: 300_000n });
    console.log(`  Deployer claim TX: ${tx.hash}`);
    const receipt = await tx.wait(1);
    const balAfter = await usdc.balanceOf(deployer.address);
    console.log(`  ✅  Deployer received: ${fmt(balAfter - balBefore)} USDC`);
  } else {
    console.log('  Deployer: nothing claimable yet.');
  }

  // W1 claim
  if (w1) {
    const cwW1 = cw.connect(w1);
    const w1Claimable = await cw.claimable(W1_ADDR);
    if (w1Claimable > 0n) {
      const balBefore = await usdc.balanceOf(W1_ADDR);
      const tx = await cwW1.claim({ gasLimit: 300_000n });
      console.log(`  W1 claim TX: ${tx.hash}`);
      await tx.wait(1);
      const balAfter = await usdc.balanceOf(W1_ADDR);
      console.log(`  ✅  W1 received: ${fmt(balAfter - balBefore)} USDC`);
    } else {
      console.log('  W1: nothing claimable yet.');
    }
  } else {
    console.log('  W1: add W1_PRIVATE_KEY to .env to test W1 claim().');
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  sep('FINAL STATE');
  console.log(`  CW USDC balance:   ${fmt(await usdc.balanceOf(CW_ADDRESS))}`);
  console.log(`  Total enrolled:    ${await cw.totalEnrolled()}`);
  console.log(`  Distributions run: ${await cw.distributionCount()}`);
  console.log(`  CW address:        ${CW_ADDRESS}`);
  console.log('\n  ✅  Community Wallet test complete.');
  console.log('\n  ⚠️   MAINNET CHECKLIST:');
  console.log('  [ ] Patch TierRouter.register() → communityWallet.enroll(msg.sender)');
  console.log('  [ ] Call CommunityWallet.setEnrollor(tierRouterAddress) after deploy');
  console.log('  [ ] Register MatrixKeeper to call distribute() via Chainlink (distributeReady() check)');
}

main().catch(e => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
