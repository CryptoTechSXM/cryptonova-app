/**
 * set_max_items.js
 * Bumps MatrixKeeper.maxItemsPerUpkeep from 15 → 30 so that
 * parked-rescue work items get queued alongside reclaim items.
 *
 * Why 30? Currently: 14 Reclaim + 1 Velocity = 15, filling the cap
 * and leaving zero slots for WORK_PARKED_RESCUE (type 4).
 * With 30 slots: same 15 priority items + up to 15 rescue items.
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');

async function main() {
  const net = hre.network.name;
  if (net !== 'baseSepolia') throw new Error(`Wrong network: ${net}`);

  const addrsFile = process.env.ADDRESSES_FILE || 'deployed_addresses_v8_30.json';
  // Try scripts/ folder first, then project root
  let addrsPath = path.join(__dirname, addrsFile);
  if (!fs.existsSync(addrsPath)) addrsPath = path.join(__dirname, '..', addrsFile);
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));
  const mkAddr = addrs.matrixKeeper;
  if (!mkAddr) throw new Error('matrixKeeper address not found in ' + addrsFile);

  const [owner] = await hre.ethers.getSigners();
  console.log('Owner :', owner.address);
  console.log('MK    :', mkAddr);

  const MK = await hre.ethers.getContractAt('MatrixKeeper', mkAddr, owner);

  const before = await MK.maxItemsPerUpkeep();
  console.log('Current maxItemsPerUpkeep:', before.toString());

  const NEW_CAP = 20; // Max allowed (5|10|15|20). 14 Reclaim+1 Velocity=15, leaves 5 rescue slots.
  console.log(`Setting → ${NEW_CAP} ...`);
  const tx = await MK.setMaxItemsPerUpkeep(NEW_CAP);
  console.log('TX:', tx.hash);
  await tx.wait();
  console.log('Confirmed.');

  const after = await MK.maxItemsPerUpkeep();
  console.log('New maxItemsPerUpkeep   :', after.toString());

  if (Number(after) !== NEW_CAP) throw new Error('Value did not update!');
  console.log('✅ Done — keeper can now queue rescue items alongside reclaim items.');
}

main().catch(e => { console.error(e); process.exit(1); });
