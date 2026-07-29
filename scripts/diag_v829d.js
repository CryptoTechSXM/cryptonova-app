/**
 * diag_v829d.js
 * Simulates _doParkedRescue for first 5 parked members to find the silent early-return.
 * Checks: isParked, withdrawable, sfBps, sfShare, crossingBuffer, totalSfNeeded vs sfBal
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const MAT_A_ABI = [
  'function getParkedCount() view returns (uint256)',
  'function getParkedMember(uint256 idx) view returns (address)',
  'function isParked(address) view returns (bool)',
  'function withdrawableOf(address) view returns (uint256)',
  'function ENTRY_FEE() view returns (uint256)',
  'function rescueDebtOf(address) view returns (uint256)',
  'function parkedAt(address) view returns (uint256)',
  'function getMemberTotalWithdrawn(address) view returns (uint256)',
];

const SF_ABI = [
  'function balanceByTier(uint8) view returns (uint256)',
  'function totalBalance() view returns (uint256)',
  'function stabilityFloor() view returns (uint256)',
];

const MK_ABI = [
  'function sfRescueThresholds(uint256) view returns (uint256)',
  'function sfRescueBpsLadder(uint256) view returns (uint256)',
  'function CROSSING_BUFFER_BPS() view returns (uint256)',
  'function rescueRatioBps() view returns (uint256)',
  'function stabilityFund() view returns (address)',
  'function parkedGracePeriod() view returns (uint256)',
];

// Mirror of _sfRescueBps logic
function sfRescueBps(withdrawable, thresholds, ladder) {
  const n = thresholds.length;
  if (n === 0) return 10_000n;
  for (let i = 0; i < n; i++) {
    if (withdrawable >= thresholds[i]) return ladder[i];
  }
  return BigInt('0x' + 'ff'.repeat(32)); // type(uint256).max
}

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_29.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const provider = ethers.provider;
  const matA = new ethers.Contract(addrs.tiers.T1.matA, MAT_A_ABI, provider);
  const mk   = new ethers.Contract(addrs.matrixKeeper, MK_ABI, provider);

  const sfAddr = await mk.stabilityFund();
  const sf = new ethers.Contract(sfAddr, SF_ABI, provider);

  // Read ladder
  const thresholds = [], ladder = [];
  for (let i = 0; i < 15; i++) {
    try { thresholds.push(await mk.sfRescueThresholds(i)); } catch { break; }
  }
  for (let i = 0; i < thresholds.length; i++) {
    ladder.push(await mk.sfRescueBpsLadder(i));
  }
  const CROSSING_BUFFER_BPS = await mk.CROSSING_BUFFER_BPS();
  const rescueRatioBps = await mk.rescueRatioBps();
  const gracePeriod = await mk.parkedGracePeriod();

  const sfBal = await sf.balanceByTier(0);
  const sfTotal = await sf.totalBalance();
  const sfFloor = await sf.stabilityFloor();

  const U = ethers.formatUnits;
  console.log(`SF balanceByTier[0]: $${U(sfBal, 6)}`);
  console.log(`SF totalBalance    : $${U(sfTotal, 6)}`);
  console.log(`SF stabilityFloor  : $${U(sfFloor, 6)}`);
  console.log(`CROSSING_BUFFER_BPS: ${CROSSING_BUFFER_BPS}`);
  console.log(`rescueRatioBps     : ${rescueRatioBps}`);
  console.log(`gracePeriod        : ${gracePeriod}s`);
  console.log(`Thresholds (${thresholds.length}):`, thresholds.map(t => '$' + U(t, 6)).join(', '));
  console.log(`Ladder BPS         :`, ladder.map(b => Number(b)).join(', '));
  console.log('');

  const count = await matA.getParkedCount();
  console.log(`MatA parkedCount: ${count}`);
  const CHECK = Math.min(Number(count), 8);
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < CHECK; i++) {
    const member = await matA.getParkedMember(i);
    const isParked = await matA.isParked(member);
    const withdrawable = await matA.withdrawableOf(member);
    const debt = await matA.rescueDebtOf(member);
    const parkedTs = await matA.parkedAt(member);
    const age = now - Number(parkedTs);

    const fee = await matA.ENTRY_FEE();
    const cbuf = fee * CROSSING_BUFFER_BPS / 10_000n;
    const bps = sfRescueBps(withdrawable, thresholds, ladder);
    const MAX = BigInt('0x' + 'ff'.repeat(32));

    let action, sfShare = 0n, totalNeeded = 0n, canRescue = false;

    if (!isParked) {
      action = '❌ isParked=false → SILENT RETURN (early-return 1)';
    } else if (withdrawable === 0n && debt > 0n) {
      action = '↩ zero withdrawable + debt → EVICT (early-return path)';
    } else if (bps === MAX) {
      action = '❌ sfBps=MAX → SILENT RETURN (early-return 2 — below all thresholds)';
    } else {
      sfShare = fee * bps / 10_000n;
      totalNeeded = sfShare + cbuf;
      if (sfBal < sfShare) {
        action = `❌ sfBal($${U(sfBal,6)}) < sfShare($${U(sfShare,6)}) → SILENT RETURN (early-return 3)`;
      } else {
        if (sfBal < totalNeeded) {
          // buffer trimmed
          const trimmedBuf = sfBal - sfShare;
          totalNeeded = sfShare + trimmedBuf;
          action = `⚠️ Buffer trimmed to $${U(trimmedBuf,6)}. totalNeeded=$${U(totalNeeded,6)} — SHOULD RESCUE`;
        } else {
          action = `✅ SHOULD RESCUE — totalNeeded=$${U(totalNeeded,6)}, sfBal=$${U(sfBal,6)}`;
        }
        canRescue = true;
      }
    }

    // Grace check
    const inGrace = age < Number(gracePeriod);

    console.log(`[${i}] ${member.slice(0,8)}…`);
    console.log(`    isParked=${isParked} inGrace=${inGrace}(${(age/3600).toFixed(1)}h)`);
    console.log(`    withdrawable=$${U(withdrawable,6)} debt=$${U(debt,6)} bps=${bps===MAX?'MAX':Number(bps)}`);
    if (sfShare > 0n) console.log(`    sfShare=$${U(sfShare,6)} cbuf=$${U(cbuf,6)} totalNeeded=$${U(totalNeeded,6)}`);
    console.log(`    → ${action}`);
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
