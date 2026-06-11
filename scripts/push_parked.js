/**
 * push_parked.js — rescue parked wallets from T1 MatA into MatB (V8.8)
 *
 * WHY: checkUpkeep() reverts (calls tierVelocityGreen(uint8) which is broken
 * on the deployed contract), so Chainlink Automation never fires. Parked members
 * pile up, MatB never fills, W1 never upgrades to T2.
 *
 * FIX: call performUpkeep() directly (no access guard) with manually built
 * WORK_PARKED_RESCUE items. The keeper calls:
 *   StabilityFund.payForceCross() → sends ENTRY_FEE USDC to MatA
 *   MatA.forceCrossKeeper(member) → member crosses to MatB
 *
 * Run: node scripts/push_parked.js
 * Run N at a time: BATCH=5 node scripts/push_parked.js
 * Run repeatedly until parked=0 and MatB fills to 127.
 */

const { ethers } = require('ethers');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const RPC_URL      = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const BATCH_SIZE   = Number(process.env.BATCH || 10);

// Gas limits:
//   NORMAL  — regular MatB entry (new member struct ≈ 140k, distribution ≈ 400k, overhead)
//   OVERFLOW — MatB full → cycle-out → W1 upgrades T2 (measured ~5-8M; 15M is safe)
const GAS_NORMAL   = 800_000;
const GAS_OVERFLOW = 15_000_000;

// ── V8.9 Addresses ────────────────────────────────────────────────────────────
const MATRIX_KEEPER = '0x95a69F7d1735174F314b32f97c32b7e8E515C002';
const T1_MATA       = '0x6f42Cf432D82cB0ce33B572b73F31b9e58ae978e';
const T1_MATB       = '0xE7557506b2a766DbeF5BA3841baC865E36C0991E';

// WORK_PARKED_RESCUE = 4 (from MatrixKeeper.sol)
const WORK_PARKED_RESCUE = 4;

// ── ABIs ──────────────────────────────────────────────────────────────────────
const TIER_ROUTER = '0x44aD72D63d501F5d2893F1A15Df8DDfB174E56d7';
const W1_ADDR     = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';

const MATA_ABI = [
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function ENTRY_FEE() external view returns (uint256)',
  'function getParkedCount() external view returns (uint256)',
  'function getParkedMember(uint256 idx) external view returns (address)',
  'function isParked(address) external view returns (bool)',
];
const MATB_ABI = [
  'function occupancy() external view returns (uint256)',
  'function MATRIX_SIZE() external view returns (uint256)',
  'function isActiveInMatrix(address) external view returns (bool)',
  'function getMember(address) external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
];
const KEEPER_ABI = [
  'function performUpkeep(bytes calldata performData) external',
  'function stabilityFund() external view returns (address)',
];
const SF_ABI = [
  'function balanceByTier(uint8 tier) external view returns (uint256)',
];
const TR_ABI = [
  'function totalSystemCycles() external view returns (uint256)',
  'function tierCycles(address, uint8) external view returns (uint256)',
  'function memberHighestTier(address) external view returns (uint8)',
];

function fmt6(n) { return '$' + (Number(n) / 1e6).toFixed(2); }

async function main() {
  if (!DEPLOYER_KEY) { console.error('DEPLOYER_PRIVATE_KEY missing'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const signer   = new ethers.Wallet(DEPLOYER_KEY, provider);
  const keeper   = new ethers.Contract(MATRIX_KEEPER, KEEPER_ABI, signer);
  const matA     = new ethers.Contract(T1_MATA, MATA_ABI, provider);
  const matB     = new ethers.Contract(T1_MATB, MATB_ABI, provider);
  const tr       = new ethers.Contract(TIER_ROUTER, TR_ABI, provider);

  const sfAddr = await keeper.stabilityFund();
  const sf     = new ethers.Contract(sfAddr, SF_ABI, provider);

  console.log('═══════════════════════════════════════════════');
  console.log(' PUSH PARKED — T1 MatA → MatB rescue (V8.8)');
  console.log('═══════════════════════════════════════════════\n');

  const [matAOcc, matARotations, entryFee, parkedCount, matBOcc, matBSize, sfBal] =
    await Promise.all([
      matA.occupancy(),
      matA.rotationCount(),
      matA.ENTRY_FEE(),
      matA.getParkedCount(),
      matB.occupancy(),
      matB.MATRIX_SIZE(),
      sf.balanceByTier(0),
    ]);

  const [sysCycBefore, w1CycBefore, w1TierBefore] = await Promise.all([
    tr.totalSystemCycles(),
    tr.tierCycles(W1_ADDR, 0),
    tr.memberHighestTier(W1_ADDR),
  ]);

  console.log(`T1 MatA       : ${matAOcc}/127  (rotations: ${matARotations})`);
  console.log(`T1 MatB       : ${matBOcc}/${matBSize}  (${matBOcc >= matBSize ? 'FULL — next entry triggers overflow' : `need ${matBSize - matBOcc} more`})`);
  console.log(`Parked count  : ${parkedCount}`);
  console.log(`Entry fee     : ${fmt6(entryFee)}`);
  console.log(`SF balance T1 : ${fmt6(sfBal)}`);
  console.log(`System cycles : ${sysCycBefore}  |  W1 T1-cyc: ${w1CycBefore}  |  W1 tier: T${w1TierBefore}`);

  if (parkedCount === 0n) {
    console.log('\n✅ No parked members in T1 MatA.');
    if (matBOcc < matBSize) {
      console.log(`   MatB still needs ${matBSize - matBOcc} more. New MatA cycles may be in progress.`);
    }
    return;
  }

  const canFund = sfBal / entryFee;
  if (canFund === 0n) {
    console.error(`\nERROR: SF balance ${fmt6(sfBal)} < entry fee ${fmt6(entryFee)} — cannot rescue.`);
    process.exit(1);
  }

  // Read up to BATCH_SIZE parked addresses from the front of the queue
  const readCount = parkedCount < BigInt(BATCH_SIZE) ? Number(parkedCount) : BATCH_SIZE;
  console.log(`\nReading first ${readCount} parked addresses…`);
  const parkedAddrs = [];
  for (let i = 0; i < readCount; i++) {
    parkedAddrs.push(await matA.getParkedMember(i));
  }

  // Pre-filter: skip any member that is already in MatB.
  // isParked(addr) in MatA = hasEverJoined && !isInMatrix — TRUE even for members
  // already sitting in MatB. Trying to re-enter MatB would revert "already in matrix".
  console.log('\nPre-flight check (skipping duplicates already in MatB)…');
  const eligible = [];
  const seen = new Set();
  for (let i = 0; i < parkedAddrs.length; i++) {
    const addr = parkedAddrs[i];
    const addrLower = addr.toLowerCase();
    if (seen.has(addrLower)) {
      console.log(`  [${i}] ${addr}  SKIP (duplicate in parked queue)`);
      continue;
    }
    seen.add(addrLower);
    let inMatB = false;
    try {
      const m = await matB.getMember(addr);
      inMatB = m.isInMatrix;
    } catch {}
    if (inMatB) {
      console.log(`  [${i}] ${addr}  SKIP (already in MatB)`);
    } else {
      console.log(`  [${i}] ${addr}  OK → will rescue`);
      eligible.push(addr);
    }
  }

  if (eligible.length === 0) {
    console.log('\nNo eligible members to rescue in this batch.');
    console.log('The front of the parked queue is all duplicates / already-in-MatB.');
    console.log('Run again to advance past them, or check if MatB is already filling.');
    return;
  }

  // Cap by SF funding
  const rescueCount = eligible.length < Number(canFund) ? eligible.length : Number(canFund);
  console.log(`\nRescuing ${rescueCount} eligible members (SF covers max ${canFund})…`);

  // ── Send ONE rescue at a time ──────────────────────────────────────────────
  // _doParkedRescue has no try/catch inside performUpkeep, so a single bad member
  // reverts the entire batch. Send individually so one failure doesn't block others.
  //
  // GAS NOTE: a normal MatB entry costs ~800k. But when MatB is FULL (127/127) the
  // first push triggers the full overflow cascade:
  //   forceCrossKeeper → _crossToPartner → MatB._enterMatrix → MatB._cycleOutRoot
  //   → TierRouter.handleCycleOut(W1) → _executeAndDouble → T2_PM.registerFor(W1)
  //   → T2_MatA._enterMatrix(W1)
  // That chain costs 5–15M gas (per bigfill OOG testing). Using 800k OOGs silently —
  // the TX is mined with status=1 but handleCycleOut is caught by the try/catch and
  // swallowed, leaving W1 stuck forever. Use GAS_OVERFLOW (15M) for that entry.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let rescued = 0;
  let matBOccNow = matBOcc;

  for (let i = 0; i < rescueCount; i++) {
    const addr = eligible[i];
    const item = [{
      workType:  WORK_PARKED_RESCUE,
      tierIndex: 0,
      addr1:     T1_MATA,
      addr2:     addr,
    }];
    const performData = coder.encode(
      ['tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]'],
      [item]
    );

    process.stdout.write(`  [${i+1}/${rescueCount}] ${addr} → `);
    // Hoist gasLimit so it's in scope for the stop-early check after catch
    const gasLimit = (matBOccNow >= matBSize) ? GAS_OVERFLOW : GAS_NORMAL;
    try {
      if (gasLimit === GAS_OVERFLOW) {
        process.stdout.write(`  ⚡ MatB FULL — using ${(GAS_OVERFLOW/1e6).toFixed(0)}M gas for overflow cascade… `);
      }
      const tx = await keeper.performUpkeep(performData, { gasLimit });
      const receipt = await tx.wait();
      if (receipt.status === 1) {
        rescued++;
        // Overflow cascade: root exits MatB AND rescued wallet fills that slot →
        // net MatB occupancy is unchanged (stays at MATRIX_SIZE). Don't increment.
        // Normal fill: occupancy grows by 1.
        if (gasLimit !== GAS_OVERFLOW) matBOccNow++;
        console.log(`✅  tx ${tx.hash.slice(0,10)}…  gas ${receipt.gasUsed}`);
      } else {
        console.log(`❌  FAILED  tx ${tx.hash}`);
      }
    } catch (e) {
      const msg = e.reason || e.shortMessage || e.message || String(e);
      const isRpcThrottle = msg.includes('in-flight') || msg.includes('coalesce') || msg.includes('rate');
      if (isRpcThrottle) {
        // RPC is throttling rapid-fire txs — wait 5s and retry once
        const reason = msg.includes('in-flight') ? 'in-flight limit' : 'RPC throttle (coalesce)';
        console.log(`⏳ ${reason} — waiting 5s…`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          const retryGas = (matBOccNow >= matBSize) ? GAS_OVERFLOW : GAS_NORMAL;
          const tx2 = await keeper.performUpkeep(performData, { gasLimit: retryGas });
          const r2   = await tx2.wait();
          if (r2.status === 1) {
            rescued++;
            if (retryGas !== GAS_OVERFLOW) matBOccNow++;
            console.log(`✅  RETRY tx ${tx2.hash.slice(0,10)}…  gas ${r2.gasUsed}`);
          } else {
            console.log(`❌  RETRY FAILED  tx ${tx2.hash}`);
          }
        } catch (e2) {
          console.log(`❌  RETRY ERROR  ${e2.reason || e2.shortMessage || e2.message}`);
        }
      } else {
        console.log(`❌  ERROR  ${msg.slice(0, 120)}`);
      }
    }

    // Brief pause between overflow rescues to avoid RPC throttle on rapid 15M-gas submissions
    if (gasLimit === GAS_OVERFLOW) await new Promise(r => setTimeout(r, 1500));

    // Stop early only on normal fills — overflow cascades keep MatB stable at MATRIX_SIZE
    // so there's no point stopping after one overflow rescue.
    if (gasLimit !== GAS_OVERFLOW && matBOccNow >= matBSize) {
      console.log('\n🎉  MatB appears FULL — stopping rescues.');
      break;
    }
  }

  // Post state
  const [newMatBOcc, newParked, sysCycAfter, w1CycAfter, w1TierAfter] = await Promise.all([
    matB.occupancy(),
    matA.getParkedCount(),
    tr.totalSystemCycles(),
    tr.tierCycles(W1_ADDR, 0),
    tr.memberHighestTier(W1_ADDR),
  ]);

  console.log(`\n─── Result ─────────────────────────────────────`);
  console.log(`  Rescued       : ${rescued} of ${rescueCount} attempted`);
  console.log(`  MatB occ      : ${matBOcc} → ${newMatBOcc}  (+${newMatBOcc - matBOcc})`);
  console.log(`  Parked left   : ${parkedCount} → ${newParked}`);
  console.log(`  System cycles : ${sysCycBefore} → ${sysCycAfter}  (+${sysCycAfter - sysCycBefore})`);
  console.log(`  W1 T1-cycles  : ${w1CycBefore} → ${w1CycAfter}`);
  console.log(`  W1 tier       : T${w1TierBefore} → T${w1TierAfter}`);

  if (w1TierAfter > w1TierBefore) {
    console.log(`\n🎉  W1 upgraded T${w1TierBefore}→T${w1TierAfter}!`);
  } else if (sysCycAfter > sysCycBefore) {
    console.log('\n✅  System cycles incremented — cycle mechanics working.');
    if (w1TierAfter < 2n) {
      console.log('    W1 may have been parked (autoReentry OFF + not enough for T2).');
      console.log('    Check W1 withdrawable in MatB and T2 velocity gate status.');
    }
  } else if (newMatBOcc >= matBSize) {
    console.log('\n⚠   MatB still full, system cycles unchanged.');
    console.log('    The overflow push may have OOGd — check TX gas used vs limit.');
  }

  if (newParked > 0n) {
    console.log(`\nℹ  ${newParked} wallets still parked — run again to rescue more:`);
    console.log('   BATCH=20 node scripts/push_parked.js');
  }

  if (newMatBOcc < matBSize) {
    console.log(`\n  MatB needs ${matBSize - newMatBOcc} more members to trigger next cycle.`);
    if (newParked === 0n) {
      console.log('  Parked queue empty — bigfill will fill remaining slots naturally.');
    }
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
