/**
 * set_max_items.js
 * Bumps MatrixKeeper.maxItemsPerUpkeep from 15 → 30 so that
 * parked-rescue work items get queued alongside reclaim items.
 *
 * Why 30? Currently: 14 Reclaim + 1 Velocity = 15, filling the cap
 * and leaving zero slots for WORK_PARKED_RESCUE (type 4).
 * With 30 slots: same 15 priority items + up to 15 rescue items.
 *
 * ⛔ SESSION 92 (62.70) — TWO DEFECTS FIXED, same shape as set_parked_grace.js 2026-08-16:
 *   1. The book fallback was "deployed_addresses_v8_30.json" — lose ADDRESSES_FILE and the owner
 *      key is pointed at dead contracts. Now a refusal, not a newer literal.
 *   2. The value was hard-coded to 20 (a V8.30-era reason, above). It is now REQUIRED as
 *      MAX_ITEMS; the contract's own menu (1|2|5|10|15|20|30|40) is the authority and its revert
 *      reason is shown if it refuses. Production ships 1.
 *
 * Run (PC, contracts repo):
 *   $env:ADDRESSES_FILE="deployed_addresses_v8_56_private.json"; $env:MAX_ITEMS="5"
 *   npx hardhat run scripts/set_max_items.js --network baseSepolia
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');

async function main() {
  const net = hre.network.name;
  if (net !== 'baseSepolia') throw new Error(`Wrong network: ${net}`);

  const addrsFile = (process.env.ADDRESSES_FILE || '').trim();
  if (!addrsFile) throw new Error('ADDRESSES_FILE not set — refusing to guess the deployment.');
  const NEW_CAP = Number(process.env.MAX_ITEMS);
  if (!process.env.MAX_ITEMS || !Number.isInteger(NEW_CAP) || NEW_CAP < 1)
    throw new Error('MAX_ITEMS not set (e.g. $env:MAX_ITEMS="5"). Contract menu: 1|2|5|10|15|20|30|40.');
  // Try scripts/ folder first, then project root
  let addrsPath = path.join(__dirname, addrsFile);
  if (!fs.existsSync(addrsPath)) addrsPath = path.join(__dirname, '..', addrsFile);
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));
  const mkAddr = addrs.matrixKeeper;
  if (!mkAddr) throw new Error('matrixKeeper address not found in ' + addrsFile);

  const [owner] = await hre.ethers.getSigners();
  console.log('Owner :', owner.address);
  console.log('Book  :', addrsFile);
  console.log('MK    :', mkAddr);

  const MK = await hre.ethers.getContractAt('MatrixKeeper', mkAddr, owner);

  const before = await MK.maxItemsPerUpkeep();
  console.log('Current maxItemsPerUpkeep:', before.toString());

  console.log(`Setting → ${NEW_CAP} ...`);
  const tx = await MK.setMaxItemsPerUpkeep(NEW_CAP);
  console.log('TX:', tx.hash);
  const rc = await tx.wait();
  console.log(`Confirmed. block ${rc.blockNumber} status ${rc.status}`);

  // ⛔ MEASURED 2026-09-18 (session 92): the plain read-back returned the OLD value (1) right after a
  // mined status-1 tx; diag_keeper_queue read 5 minutes later. A stale node, not a failed write — and
  // the old "Value did not update!" throw invited sending the tx AGAIN. Read AT the receipt's block.
  const after = await MK.maxItemsPerUpkeep({ blockTag: rc.blockNumber });
  console.log('New maxItemsPerUpkeep   :', after.toString());

  if (Number(after) !== NEW_CAP) throw new Error('Value did not update!');
  console.log(`✅ Done — maxItemsPerUpkeep is ${after} on ${addrsFile}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
