/**
 * push_parked.js — rescue parked wallets from T1 MatA → MatB (V8.13)
 *
 * V8.13 CHANGE: Sliding-scale SF rescue contribution.
 *   Higher member withdrawable → less SF help. Max SF = 50%.
 *   SF pays: 10% if withdrawable ≥ 95%, 15% if ≥ 90%, ... 50% if ≥ 50%.
 *   Members with < 50% withdrawable go to admin-only (deployer pays 100%).
 *   Members with ≥ 100% withdrawable self-fund via keeper (SF pays 0%).
 *
 * Run: node scripts/push_parked.js
 * Run N at a time: BATCH=100 node scripts/push_parked.js
 * FORCE_ADMIN=1: auto-top-up SF with each member's exact SF share before rescue.
 *   Deployer cost = sum of SF shares (variable, avg < $5/member vs old flat $5).
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

// ── Addresses (loaded from deployed_addresses_v8_13.json) ────────────────────
const { fs: _fs, path: _path } = { fs: require('fs'), path: require('path') };
const ADDR_FILE = _path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_13.json');
if (!_fs.existsSync(ADDR_FILE)) {
  console.error(`\n❌  ${ADDR_FILE} not found. Run deploy_v8.js first.`);
  process.exit(1);
}
const _addrs = JSON.parse(_fs.readFileSync(ADDR_FILE, 'utf8'));
const T1_ADDRS    = _addrs.tiers?.['T1'] ?? _addrs.tiers?.['1'] ?? {};
const MATRIX_KEEPER = _addrs.matrixKeeper;
const T1_MATA       = T1_ADDRS.matA;
const T1_MATB       = T1_ADDRS.matB;
const TIER_ROUTER   = _addrs.tierRouter;
const W1_ADDR       = process.env.W1_ADDRESS || _addrs.w1Address || _addrs.accountOne || ''; // accountOne = W1 in V8.12+
console.log(`📂  Loaded: ${_path.basename(ADDR_FILE)}  MatrixKeeper=${MATRIX_KEEPER?.slice(0,10)}...`);

// WORK_PARKED_RESCUE = 4 (from MatrixKeeper.sol)
const WORK_PARKED_RESCUE = 4;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const MATA_ABI = [
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function ENTRY_FEE() external view returns (uint256)',
  'function getParkedCount() external view returns (uint256)',
  'function getParkedMember(uint256 idx) external view returns (address)',
  'function isParked(address) external view returns (bool)',
  'function withdrawableOf(address member) external view returns (uint256)',
  'function forceCross(address member) external',  // admin path: pulls USDC from msg.sender
];
const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
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
  'function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external',  // owner-callable deposit; layer 5 = no community carve
];
const TR_ABI = [
  'function totalSystemCycles() external view returns (uint256)',
  'function tierCycles(address, uint8) external view returns (uint256)',
  'function memberHighestTier(address) external view returns (uint8)',
];

function fmt6(n) { return '$' + (Number(n) / 1e6).toFixed(2); }

/**
 * V8.13 sliding-scale SF rescue contribution.
 * Returns SF's BPS share (0n–5000n), or null if member is ineligible (< 50% withdrawable).
 * Mirror of MatrixKeeper._sfRescueBps().
 */
function sfRescueBps(withdrawable, entryFee) {
  const wBps = withdrawable * 10000n / entryFee;
  if (wBps >= 10000n) return    0n;   // >= 100%: self-fund, SF pays nothing
  if (wBps >=  9500n) return 1000n;   // SF 10%
  if (wBps >=  9000n) return 1500n;   // SF 15%
  if (wBps >=  8500n) return 2000n;   // SF 20%
  if (wBps >=  8000n) return 2500n;   // SF 25%
  if (wBps >=  7500n) return 3000n;   // SF 30%
  if (wBps >=  7000n) return 3500n;   // SF 35%
  if (wBps >=  6500n) return 4000n;   // SF 40%
  if (wBps >=  6000n) return 4500n;   // SF 45%
  if (wBps >=  5000n) return 5000n;   // SF 50% — maximum
  return null;                         // < 50%: not eligible for keeper rescue
}

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
  const usdc   = new ethers.Contract(_addrs.usdc, USDC_ABI, signer);

  console.log('═══════════════════════════════════════════════');
  console.log(' PUSH PARKED — T1 MatA → MatB rescue (V8.13)');
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

  const FORCE_ADMIN = process.env.FORCE_ADMIN === '1';

  const canFund = sfBal / entryFee;
  if (canFund === 0n && !FORCE_ADMIN) {
    console.error(`\nERROR: SF balance ${fmt6(sfBal)} < entry fee ${fmt6(entryFee)} — cannot rescue via keeper.`);
    console.error('       Run with FORCE_ADMIN=1 to top up SF and run the split (deployer pays SF share only).');
    process.exit(1);
  }

  // Read up to BATCH_SIZE parked addresses from the front of the queue
  const readCount = parkedCount < BigInt(BATCH_SIZE) ? Number(parkedCount) : BATCH_SIZE;
  console.log(`\nReading first ${readCount} parked addresses…`);
  const parkedAddrs = [];
  for (let i = 0; i < readCount; i++) {
    parkedAddrs.push(await matA.getParkedMember(i));
  }

  // Pre-flight: skip duplicates and already-in-MatB members.
  // V8.13 sliding scale: per-member SF share based on withdrawable.
  //   keeper path  = withdrawable >= 50% of entryFee  → SF pays sliding share, member pays rest
  //   admin-only   = withdrawable < 50% of entryFee   → deployer calls forceCross (full fee)
  //
  // FORCE_ADMIN=1: auto-top-up SF with the exact sum of per-member SF shares before running.
  // Deployer cost = sum(sfShare_i) — variable and always ≤ $5/member.
  const minMemberShare = entryFee / 2n;  // 50% floor — minimum member contribution
  console.log(`\nRescue math: sliding scale (SF 0–50%), member floor ${fmt6(minMemberShare)} withdrawable`);
  const adminMsg = FORCE_ADMIN
    ? `ENABLED — auto-top-up SF per member; forceCross for < ${fmt6(minMemberShare)} withdrawable`
    : 'disabled (set FORCE_ADMIN=1 to enable)';
  console.log(`Admin mode: ${adminMsg}`);
  console.log('\nPre-flight check…');
  // eligibleKeeper entries: { addr, sfShare, memberShare }
  const eligibleKeeper = [];
  const eligibleAdmin  = [];
  const seen = new Set();
  for (let i = 0; i < parkedAddrs.length; i++) {
    const addr = parkedAddrs[i];
    const addrLower = addr.toLowerCase();
    if (seen.has(addrLower)) {
      console.log(`  [${i}] ${addr}  SKIP (duplicate)`);
      continue;
    }
    seen.add(addrLower);
    let inMatB = false;
    try { const m = await matB.getMember(addr); inMatB = m.isInMatrix; } catch {}
    if (inMatB) {
      console.log(`  [${i}] ${addr}  SKIP (already in MatB)`);
      continue;
    }
    const withdrawable = await matA.withdrawableOf(addr).catch(() => 0n);
    const bps = sfRescueBps(withdrawable, entryFee);
    if (bps !== null) {
      const sfShare_i     = entryFee * bps / 10000n;
      const memberShare_i = entryFee - sfShare_i;
      const sfPct = Number(bps) / 100;
      if (bps === 0n) {
        console.log(`  [${i}] ${addr}  self-fund ✓  (withdrawable ${fmt6(withdrawable)} — no SF needed)`);
      } else {
        console.log(`  [${i}] ${addr}  keeper ✓  (withdrawable ${fmt6(withdrawable)}  SF ${sfPct}% ${fmt6(sfShare_i)}  member ${fmt6(memberShare_i)})`);
      }
      eligibleKeeper.push({ addr, sfShare: sfShare_i, memberShare: memberShare_i });
    } else {
      console.log(`  [${i}] ${addr}  ${FORCE_ADMIN ? 'admin forceCross' : 'needs admin forceCross'}  (withdrawable ${fmt6(withdrawable)} < floor ${fmt6(minMemberShare)})`);
      eligibleAdmin.push(addr);
    }
  }

  console.log(`\n  Keeper-rescuable : ${eligibleKeeper.length}`);
  console.log(`  Admin-only       : ${eligibleAdmin.length}`);

  if (eligibleKeeper.length === 0 && (!FORCE_ADMIN || eligibleAdmin.length === 0)) {
    console.log('\nNo keeper-rescuable members in this batch (all have < 50% withdrawable).');
    console.log('Options:');
    console.log('  1. Run with a larger BATCH to find members with earnings: BATCH=50 node scripts/push_parked.js');
    console.log('  2. Use admin forceCross (deployer pays full fee/member): FORCE_ADMIN=1 node scripts/push_parked.js');
    return;
  }

  // ── KEEPER PATH ──────────────────────────────────────────────────────────
  // V8.13: Each member has a different SF share. Sum them individually.
  // FORCE_ADMIN=1: top up SF with the exact total SF share for this batch.
  let rescueCount;
  if (FORCE_ADMIN && eligibleKeeper.length > 0) {
    // Determine how many we can afford: accumulate sfShares from the front
    // until we either exhaust the list or run out of deployer USDC.
    const deployerUsdc = await usdc.balanceOf(signer.address);
    let affordable = 0;
    let runningCost = 0n;
    for (const { sfShare: s } of eligibleKeeper) {
      if (runningCost + s > deployerUsdc) break;
      runningCost += s;
      affordable++;
    }
    if (affordable < eligibleKeeper.length) {
      console.log(`\n⚠  FORCE_ADMIN: deployer has ${fmt6(deployerUsdc)}, can fund ${affordable}/${eligibleKeeper.length} keeper rescues (variable SF shares).`);
    }
    rescueCount = affordable;

    if (rescueCount > 0) {
      const actualTopup = eligibleKeeper.slice(0, rescueCount).reduce((s, e) => s + e.sfShare, 0n);
      const avgSf = actualTopup / BigInt(rescueCount);
      console.log(`\nAuto-topping SF with ${fmt6(actualTopup)} (${rescueCount} rescues, avg ${fmt6(avgSf)}/member) from deployer…`);
      const sfContract = new ethers.Contract(sfAddr, SF_ABI, signer);
      const approveTx = await usdc.approve(sfAddr, actualTopup);
      await approveTx.wait();
      await new Promise(r => setTimeout(r, 2000));
      const topupTx = await sfContract.receiveLayer(0, actualTopup, 5);
      await topupTx.wait();
      console.log(`  SF topped up ✅  tx ${topupTx.hash.slice(0,10)}…`);
      console.log(`  Deployer cost: ${fmt6(actualTopup)} total`);
    }
  } else {
    // No FORCE_ADMIN: cap to what SF can currently fund
    // With variable shares we conservatively estimate using minMemberShare floor
    rescueCount = 0;
    let sfRunning = sfBal;
    for (const { sfShare: s } of eligibleKeeper) {
      if (sfRunning < s) break;
      sfRunning -= s;
      rescueCount++;
    }
  }
  if (rescueCount > 0) {
    console.log(`\nRescuing ${rescueCount} via keeper${FORCE_ADMIN ? ' (SF pre-funded by deployer)' : ` (SF funds ${rescueCount} at current balance ${fmt6(sfBal)})`}…`);
  }

  // ── KEEPER PATH: members with enough withdrawable ─────────────────────────
  // _doParkedRescue has no try/catch inside performUpkeep, so a single bad member
  // reverts the entire batch. Send individually so one failure doesn't block others.
  //
  // GAS NOTE: when MatB is FULL the first push triggers the full overflow cascade
  // (5–15M gas). Using 800k OOGs silently — use GAS_OVERFLOW (15M) for that entry.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let rescued = 0;
  let matBOccNow = matBOcc;

  for (let i = 0; i < rescueCount; i++) {
    const { addr } = eligibleKeeper[i];
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

  // ── ADMIN forceCross PATH: members with $0 withdrawable ───────────────────
  // forceCross(member) is onlyOwner — deployer calls it directly.
  // It pulls ENTRY_FEE USDC from msg.sender (deployer). Requires deployer to have
  // USDC and an approval. Enable with: FORCE_ADMIN=1 node scripts/push_parked.js
  let adminRescued = 0;
  if (FORCE_ADMIN && eligibleAdmin.length > 0) {
    const deployerUsdc = await usdc.balanceOf(signer.address);
    const adminBatch   = Number(deployerUsdc / entryFee);  // how many deployer can fund
    if (adminBatch === 0) {
      console.log(`\n⚠  FORCE_ADMIN=1 but deployer has no USDC (${fmt6(deployerUsdc)}). Top up deployer wallet first.`);
    } else {
      const adminCount = Math.min(eligibleAdmin.length, adminBatch);
      console.log(`\nAdmin forceCross: rescuing ${adminCount} members (deployer has ${fmt6(deployerUsdc)})…`);
      // Approve once for the whole batch (wait for confirmation before any forceCross)
      const approveAmt = entryFee * BigInt(adminCount) + entryFee; // +1 buffer
      const adminApproveTx = await usdc.approve(T1_MATA, approveAmt);
      await adminApproveTx.wait();
      await new Promise(r => setTimeout(r, 2000));  // RPC in-flight limit
      console.log(`  Approved ${fmt6(approveAmt)} USDC to MatA`);
      const matAAdmin = new ethers.Contract(T1_MATA, MATA_ABI, signer);
      for (let i = 0; i < adminCount; i++) {
        const addr = eligibleAdmin[i];
        process.stdout.write(`  [${i+1}/${adminCount}] ${addr} → `);
        const gasLimit = (matBOccNow >= matBSize) ? GAS_OVERFLOW : GAS_NORMAL;
        if (gasLimit === GAS_OVERFLOW) process.stdout.write(`⚡ overflow… `);
        try {
          const tx = await matAAdmin.forceCross(addr, { gasLimit });
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            adminRescued++;
            if (gasLimit !== GAS_OVERFLOW) matBOccNow++;
            console.log(`✅  tx ${tx.hash.slice(0,10)}…  gas ${receipt.gasUsed}`);
          } else {
            console.log(`❌  FAILED`);
          }
        } catch(e) {
          console.log(`❌  ${(e.reason || e.shortMessage || e.message || '').slice(0,100)}`);
        }
        if (gasLimit === GAS_OVERFLOW) await new Promise(r => setTimeout(r, 1500));
      }
    }
  } else if (eligibleAdmin.length > 0) {
    console.log(`\nℹ  ${eligibleAdmin.length} members need admin forceCross (insufficient withdrawable).`);
    console.log('   Run with FORCE_ADMIN=1 to rescue them (deployer pays $10 USDC each).');
  }

  // Post state
  const [newMatBOcc, newParked, sysCycAfter, w1CycAfter, w1TierAfter] = await Promise.all([
    matB.occupancy(),
    matA.getParkedCount(),
    tr.totalSystemCycles(),
    tr.tierCycles(W1_ADDR, 0),
    tr.memberHighestTier(W1_ADDR),
  ]);

  const deployerSpent = FORCE_ADMIN && rescued > 0
    ? eligibleKeeper.slice(0, rescued).reduce((s, e) => s + e.sfShare, 0n)
    : 0n;

  console.log(`\n─── Result ─────────────────────────────────────`);
  console.log(`  Keeper rescued: ${rescued} of ${rescueCount} attempted`);
  if (FORCE_ADMIN && rescued > 0) {
    console.log(`  Deployer spent: ${fmt6(deployerSpent)} SF top-up (avg ${fmt6(deployerSpent / BigInt(rescued))}/member)`);
  }
  if (FORCE_ADMIN) console.log(`  Admin rescued : ${adminRescued} of ${eligibleAdmin.length} attempted`);
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
    console.log('   Keeper (members with earnings) : BATCH=50 node scripts/push_parked.js');
    console.log('   Admin  (members with $0 earned): FORCE_ADMIN=1 BATCH=50 node scripts/push_parked.js');
  }

  if (newMatBOcc < matBSize) {
    console.log(`\n  MatB needs ${matBSize - newMatBOcc} more members to trigger next cycle.`);
    if (newParked === 0n) {
      console.log('  Parked queue empty — bigfill will fill remaining slots naturally.');
    }
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
