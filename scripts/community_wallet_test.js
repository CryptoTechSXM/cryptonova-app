/**
 * community_wallet_test.js
 *
 * End-to-end testnet verification of CommunityWallet.sol.
 * Runs against V8.10 deployed contracts on Base Sepolia.
 *
 * Steps:
 *   1. Report current CW state (balance, enrolled count, next distribute time)
 *   2. Enroll test wallets via enrollBatch() (owner-only)
 *   3. Reduce distributeInterval to 2 minutes (governor-only)
 *   4. Wait for interval, then call distribute()
 *   5. Report claimable amounts per wallet
 *   6. Call claim() for wallets we control (deployer + W1)
 *   7. Verify USDC received
 *   8. Restore interval to 30 days (optional)
 *
 * Usage:
 *   cd C:\CryptoNite-Smart-Contracts\CryptoNova
 *   node scripts/community_wallet_test.js
 *
 * Requires .env:
 *   DEPLOYER_PRIVATE_KEY=0x...
 *   W1_PRIVATE_KEY=0x...       (optional — to test claim() from W1)
 *   BASE_SEPOLIA_RPC=https://...
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── Addresses ────────────────────────────────────────────────────────────────
const CW_ADDRESS   = '0x525D14dA6042cd0223388E922a8FA8E91eC2304D';
const USDC_ADDRESS = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const DEPLOYER_ADDR = '0xCd0Af6a4116f2062c1594aDf34c1821D45175506';
const W1_ADDR      = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';

// Test wallets to enroll (Genesis cohort = first 500)
// Using deployer + W1 + 3 derived fill wallets as our test set
const TEST_WALLETS = [
  DEPLOYER_ADDR,
  W1_ADDR,
  // Add more if you know registered wallet addresses
];

// ── ABIs ─────────────────────────────────────────────────────────────────────
const CW_ABI = [
  // View
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
  // Write
  'function enrollBatch(address[] calldata members) external',
  'function setDistributeInterval(uint256 interval) external',
  'function distribute() external',
  'function claim() external returns (uint256)',
  // Events
  'event MemberEnrolled(address indexed member, uint8 cohort, uint256 enrollmentNumber)',
  'event DistributionCreated(uint256 indexed distId, uint256 toDistribute, uint256 genesisShare, uint256 pioneerShare)',
  'event Claimed(address indexed member, uint256 amount)',
];

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sep(label) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + label);
  console.log('─'.repeat(60));
}

function fmt(usdcRaw) {
  return '$' + (Number(usdcRaw) / 1e6).toFixed(4);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const RPC_URL      = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
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

  // ── STEP 1: Report current state ──────────────────────────────────────────
  sep('STEP 1 — Current CommunityWallet state');

  const cwBal        = await usdc.balanceOf(CW_ADDRESS);
  const totalEnrolled = await cw.totalEnrolled();
  const genesisCount  = await cw.genesisCount();
  const pioneerCount  = await cw.pioneerCount();
  const interval      = await cw.distributeInterval();
  const lastDist      = await cw.lastDistributionTime();
  const distCount     = await cw.distributionCount();
  const pool          = await cw.availablePool();
  const ready         = await cw.distributeReady();

  const now = BigInt(Math.floor(Date.now() / 1000));
  const nextDist = lastDist + interval;
  const secsUntil = nextDist > now ? nextDist - now : 0n;

  console.log(`  USDC balance:       ${fmt(cwBal)}`);
  console.log(`  Available pool:     ${fmt(pool)}`);
  console.log(`  Total enrolled:     ${totalEnrolled}`);
  console.log(`  Genesis members:    ${genesisCount} / 500`);
  console.log(`  Pioneer members:    ${pioneerCount} / 500`);
  console.log(`  Distributions run:  ${distCount}`);
  console.log(`  Interval:           ${Number(interval) / 60} minutes`);
  console.log(`  Last distributed:   ${lastDist === 0n ? 'never' : new Date(Number(lastDist) * 1000).toISOString()}`);
  console.log(`  Distribute ready:   ${ready}`);
  if (secsUntil > 0n) {
    console.log(`  Next distribute in: ${Number(secsUntil)} seconds`);
  }

  // Check cohort for each test wallet
  console.log('\n  Enrollment status:');
  for (const addr of TEST_WALLETS) {
    const c = await cw.cohort(addr);
    const label = c === 0n ? 'NOT ENROLLED' : c === 1n ? 'Genesis' : 'Pioneer';
    console.log(`    ${addr.slice(0, 10)}...  →  ${label}`);
  }

  // ── STEP 2: Enroll test wallets if not already enrolled ───────────────────
  sep('STEP 2 — Enroll test wallets via enrollBatch()');

  const toEnroll = [];
  for (const addr of TEST_WALLETS) {
    const c = await cw.cohort(addr);
    if (c === 0n) toEnroll.push(addr);
  }

  if (toEnroll.length === 0) {
    console.log('  ✅  All test wallets already enrolled — skipping');
  } else {
    console.log(`  Enrolling ${toEnroll.length} wallet(s): ${toEnroll.map(a => a.slice(0,10)+'...').join(', ')}`);
    const tx = await cw.enrollBatch(toEnroll, { gasLimit: 500_000n });
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait(1);
    console.log(`  ✅  enrollBatch confirmed (block ${receipt.blockNumber})`);

    // Verify
    for (const addr of toEnroll) {
      const c = await cw.cohort(addr);
      const label = c === 1n ? 'Genesis' : c === 2n ? 'Pioneer' : 'FAILED';
      console.log(`    ${addr.slice(0,10)}...  →  ${label} ✅`);
    }
    console.log(`  Total enrolled now: ${await cw.totalEnrolled()}`);
  }

  // ── STEP 3: Reduce distributeInterval to 2 minutes ────────────────────────
  sep('STEP 3 — Set distributeInterval to 2 minutes (testing only)');

  const currentInterval = await cw.distributeInterval();
  const TWO_MINUTES = 120n;

  if (currentInterval <= TWO_MINUTES) {
    console.log('  ✅  Already at short interval — skipping');
  } else {
    const tx = await cw.setDistributeInterval(TWO_MINUTES, { gasLimit: 100_000n });
    console.log(`  TX: ${tx.hash}`);
    await tx.wait(1);
    console.log(`  ✅  distributeInterval set to 2 minutes`);
  }

  // Check if distribute is ready
  const readyNow = await cw.distributeReady();
  if (!readyNow) {
    const last = await cw.lastDistributionTime();
    const now2 = BigInt(Math.floor(Date.now() / 1000));
    const newInterval = await cw.distributeInterval();
    const waitSecs = Number((last + newInterval) - now2) + 5;
    if (waitSecs > 0) {
      console.log(`  ⏳  Waiting ${waitSecs}s for interval to pass...`);
      await sleep(waitSecs * 1000);
    }
  }

  // ── STEP 4: Call distribute() ─────────────────────────────────────────────
  sep('STEP 4 — Call distribute()');

  const poolBefore = await cw.availablePool();
  const enrolledNow = await cw.totalEnrolled();

  if (poolBefore === 0n) {
    console.log('  ⚠️   Pool is empty — no USDC to distribute yet.');
    console.log('  Run a registration or two first to fund the 1% carve,');
    console.log('  or send USDC directly to the CommunityWallet address:');
    console.log(`  ${CW_ADDRESS}`);
    console.log('\n  Skipping distribute() — nothing to distribute.');
  } else if (enrolledNow === 0n) {
    console.log('  ⚠️   No members enrolled — cannot distribute.');
  } else {
    console.log(`  Pool available: ${fmt(poolBefore)}`);
    console.log(`  Enrolled: ${enrolledNow}`);

    const isReady = await cw.distributeReady();
    if (!isReady) {
      console.log('  ⚠️   distributeReady() returned false — interval not elapsed yet.');
    } else {
      const tx = await cw.distribute({ gasLimit: 500_000n });
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait(1);
      console.log(`  ✅  distribute() confirmed (block ${receipt.blockNumber})`);

      // Decode event
      const distLog = receipt.logs.find(l => {
        try { cw.interface.parseLog(l); return true; } catch { return false; }
      });
      if (distLog) {
        const parsed = cw.interface.parseLog(distLog);
        if (parsed?.name === 'DistributionCreated') {
          console.log(`  Distribution #${parsed.args[0]}: total=${fmt(parsed.args[1])}, genesis=${fmt(parsed.args[2])}, pioneer=${fmt(parsed.args[3])}`);
        }
      }
    }
  }

  // ── STEP 5: Report claimable per wallet ───────────────────────────────────
  sep('STEP 5 — Claimable amounts');

  for (const addr of TEST_WALLETS) {
    const c = await cw.cohort(addr);
    const cohortLabel = c === 1n ? 'Genesis' : c === 2n ? 'Pioneer' : 'Not enrolled';
    const claimAmt = await cw.claimable(addr);
    console.log(`  ${addr.slice(0,10)}...  [${cohortLabel}]  claimable: ${fmt(claimAmt)}`);
  }

  // ── STEP 6: Claim for wallets we control ─────────────────────────────────
  sep('STEP 6 — Claim USDC');

  // Claim for deployer
  const deployerClaimable = await cw.claimable(deployer.address);
  if (deployerClaimable > 0n) {
    const balBefore = await usdc.balanceOf(deployer.address);
    const tx = await cw.connect(deployer).claim({ gasLimit: 300_000n });
    console.log(`  Deployer claim TX: ${tx.hash}`);
    await tx.wait(1);
    const balAfter = await usdc.balanceOf(deployer.address);
    console.log(`  ✅  Deployer received: ${fmt(balAfter - balBefore)} USDC`);
  } else {
    console.log('  Deployer: nothing to claim yet.');
  }

  // Claim for W1 if key provided
  if (w1) {
    const w1Claimable = await cw.claimable(W1_ADDR);
    if (w1Claimable > 0n) {
      const cwW1 = cw.connect(w1);
      const balBefore = await usdc.balanceOf(W1_ADDR);
      const tx = await cwW1.claim({ gasLimit: 300_000n });
      console.log(`  W1 claim TX: ${tx.hash}`);
      await tx.wait(1);
      const balAfter = await usdc.balanceOf(W1_ADDR);
      console.log(`  ✅  W1 received: ${fmt(balAfter - balBefore)} USDC`);
    } else {
      console.log('  W1: nothing to claim yet.');
    }
  } else {
    console.log('  W1: W1_PRIVATE_KEY not set — skipping W1 claim test.');
    console.log('  Add W1_PRIVATE_KEY to .env to test member claim().');
  }

  // ── STEP 7: Restore interval to 30 days ──────────────────────────────────
  sep('STEP 7 — Restore distributeInterval to 30 days');

  const THIRTY_DAYS = BigInt(30 * 24 * 60 * 60);
  const curInterval = await cw.distributeInterval();
  if (curInterval >= THIRTY_DAYS) {
    console.log('  Already at 30 days — no change needed.');
  } else {
    const tx = await cw.setDistributeInterval(THIRTY_DAYS, { gasLimit: 100_000n });
    console.log(`  TX: ${tx.hash}`);
    await tx.wait(1);
    console.log('  ✅  distributeInterval restored to 30 days');
  }

  // ── Final report ──────────────────────────────────────────────────────────
  sep('FINAL STATE');

  const finalBal   = await usdc.balanceOf(CW_ADDRESS);
  const finalPool  = await cw.availablePool();
  const finalDists = await cw.distributionCount();
  const finalEnrol = await cw.totalEnrolled();

  console.log(`  CW USDC balance:     ${fmt(finalBal)}`);
  console.log(`  Pool available:      ${fmt(finalPool)}`);
  console.log(`  Total enrolled:      ${finalEnrol}`);
  console.log(`  Distributions run:   ${finalDists}`);
  console.log(`  CW address:          ${CW_ADDRESS}`);
  console.log(`\n  ✅  Community Wallet test complete.\n`);
  console.log('  ⚠️   REMEMBER: Before mainnet, patch TierRouter.register() to');
  console.log('  call communityWallet.enroll(msg.sender) for first 1,000 members.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
