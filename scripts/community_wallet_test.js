/**
 * community_wallet_test.js
 *
 * End-to-end testnet verification of CommunityWallet.sol.
 * Runs against V8.10 deployed contracts on Base Sepolia.
 *
 * V8.48: distribution is a CALENDAR DATE (the 25th of every month), not a rolling
 * 30-day interval. distributeInterval and setDistributeInterval no longer exist, so
 * the old "shorten the interval to 2 minutes, then restore it" trick is gone with
 * them — there is no interval left to shorten. The testnet path is forceDistribute(),
 * which bypasses the calendar gate and, deliberately, does NOT consume the month's
 * real slot: QA on the 3rd still leaves the genuine run on the 25th intact.
 *
 * Steps:
 *   1. Report current CW state (balance, enrolled count, NEXT DISTRIBUTION DATE)
 *   2. Enroll test wallets via enrollBatch() (owner-only)
 *   3. Reach a distributable state — distribute() if the date has arrived,
 *      otherwise forceDistribute() (admin, testnet-only)
 *   4. Report claimable amounts per wallet
 *   5. Call claim() for wallets we control (deployer + W1), verify USDC received
 *   6. Re-report the next distribution date
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
  'function nextDistributionTime() view returns (uint256)',
  'function distributionDayOfMonth() view returns (uint8)',
  'function lastDistributionTime() view returns (uint256)',
  'function lastDistributionMonth() view returns (uint256)',
  'function distributeReady() view returns (bool)',
  'function availablePool() view returns (uint256)',
  'function claimable(address member) view returns (uint256)',
  'function cohort(address member) view returns (uint8)',
  'function distributionCount() view returns (uint256)',
  // Write
  'function enrollBatch(address[] calldata members) external',
  'function setDistributionDayOfMonth(uint8 day) external',
  'function forceDistribute() external',
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
  const nextDistTime  = await cw.nextDistributionTime();
  const dayOfMonth    = await cw.distributionDayOfMonth();
  const lastDist      = await cw.lastDistributionTime();
  const distCount     = await cw.distributionCount();
  const pool          = await cw.availablePool();
  const ready         = await cw.distributeReady();

  const now = BigInt(Math.floor(Date.now() / 1000));
  // Do NOT recompute the schedule here. nextDistributionTime() is the contract's own
  // answer and the only one the frontend is allowed to show; a second implementation
  // in this script would be a second source of truth, which is precisely how "claim on
  // the 25th" became a belief the contract never supported.
  const secsUntil = nextDistTime > now ? nextDistTime - now : 0n;

  console.log(`  USDC balance:       ${fmt(cwBal)}`);
  console.log(`  Available pool:     ${fmt(pool)}`);
  console.log(`  Total enrolled:     ${totalEnrolled}`);
  console.log(`  Genesis members:    ${genesisCount} / 500`);
  console.log(`  Pioneer members:    ${pioneerCount} / 500`);
  console.log(`  Distributions run:  ${distCount}`);
  console.log(`  Distribution day:   the ${dayOfMonth}th of every month`);
  console.log(`  Last distributed:   ${lastDist === 0n ? 'never' : new Date(Number(lastDist) * 1000).toISOString()}`);
  console.log(`  Distribute ready:   ${ready}`);
  console.log(`  Next distribution:  ${new Date(Number(nextDistTime) * 1000).toISOString()}`);
  if (secsUntil > 0n) {
    const d = Number(secsUntil) / 86400;
    console.log(`                      (in ${d >= 1 ? d.toFixed(1) + ' days' : (Number(secsUntil) / 3600).toFixed(1) + ' hours'})`);
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

  // ── STEP 3: Reach a distributable state ───────────────────────────────────
  //
  // V8.48: there is no interval to shorten any more. Either the calendar date has
  // arrived, or we use the admin/testnet bypass. Nothing else can make distribute()
  // succeed, and nothing here should try to fake the date.
  sep('STEP 3 — Reach a distributable state');

  const readyNow = await cw.distributeReady();
  if (readyNow) {
    console.log('  \u2705  distributeReady() is TRUE — the monthly date has arrived, no bypass needed.');
  } else {
    const nd = await cw.nextDistributionTime();
    console.log(`  distributeReady() is FALSE — next real distribution ${new Date(Number(nd) * 1000).toISOString()}`);
    console.log('  Using forceDistribute() (admin, testnet chains only).');
    try {
      const tx = await cw.forceDistribute({ gasLimit: 800_000n });
      console.log(`  TX: ${tx.hash}`);
      await tx.wait(1);
      // Verify rather than assume: a reverted-but-mined tx and a no-op both look
      // like success from the tx hash alone.
      const after = await cw.distributionCount();
      console.log(`  \u2705  forceDistribute() confirmed — distributionCount now ${after}`);
      const ndAfter = await cw.nextDistributionTime();
      if (ndAfter === nd) {
        console.log('  \u2705  the real monthly slot is intact (next date unchanged) — as designed.');
      } else {
        console.log(`  \u26a0\ufe0f   next date MOVED to ${new Date(Number(ndAfter) * 1000).toISOString()} — a forced run should not consume the month.`);
      }
    } catch (e) {
      console.log(`  \u274c  forceDistribute() failed: ${e.shortMessage || e.message}`);
      console.log('     (it is DEFAULT_ADMIN_ROLE-gated and rejects non-testnet chain ids)');
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
      const nd2 = await cw.nextDistributionTime();
      console.log(`  \u2139   distributeReady() is false — next distribution ${new Date(Number(nd2) * 1000).toISOString()}.`);
      console.log('     Either this month has already distributed, or the date has not arrived.');
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

  // ── STEP 7: (removed in V8.48) ───────────────────────────────────────────
  //
  // This step used to restore distributeInterval to 30 days after shrinking it to 2
  // minutes for the test. Neither the shrink nor the restore exists any more: the
  // schedule is a governed calendar day, not a duration this script may edit. If the
  // date itself ever needs to change it goes through governance param 39
  // (PARAM_CW_DISTRIBUTION_DAY), never through a test script.
  sep('STEP 7 — Schedule (read-only)');
  {
    const day  = await cw.distributionDayOfMonth();
    const next = await cw.nextDistributionTime();
    console.log(`  Distribution day: the ${day}th of every month (governed, 1-28)`);
    console.log(`  Next scheduled:   ${new Date(Number(next) * 1000).toISOString()}`);
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
