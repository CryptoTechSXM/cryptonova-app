/**
 * diag_v829e.js
 * Calls checkUpkeep with the new cap=20 and decodes ALL work items.
 * Then tries to staticCall performUpkeep to see if it reverts.
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const MK_ABI = [
  'function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData)',
  'function maxItemsPerUpkeep() view returns (uint256)',
  'function performUpkeep(bytes calldata performData) external',
];

const TYPE_NAMES = ['Velocity','Ghost','Reclaim','ChainLink','RescueParked','VelocityGate','EvictParked','CommunityDist'];

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_29.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const provider = ethers.provider;
  const mk = new ethers.Contract(addrs.matrixKeeper, MK_ABI, provider);

  const cap = await mk.maxItemsPerUpkeep();
  console.log('maxItemsPerUpkeep:', cap.toString());

  const [needed, perfData] = await mk.checkUpkeep('0x');
  console.log('upkeepNeeded:', needed);

  if (!needed || perfData === '0x') {
    console.log('No work pending.');
    return;
  }

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const WI_TYPE = 'tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]';
  const [items] = coder.decode([WI_TYPE], perfData);

  const counts = {};
  console.log(`\nWork items: ${items.length} total`);
  for (const item of items) {
    const t = Number(item.workType);
    const name = TYPE_NAMES[t] || `Type${t}`;
    counts[name] = (counts[name] || 0) + 1;
    console.log(`  workType=${t}(${name}) tier=${item.tierIndex} addr1=${item.addr1.slice(0,10)}… addr2=${item.addr2.slice(0,10)}…`);
  }
  console.log('\nSummary:', JSON.stringify(counts));

  // Check if any rescue items exist
  const rescueItems = items.filter(i => Number(i.workType) === 4);
  if (rescueItems.length === 0) {
    console.log('\n⚠️  NO RescueParked items in checkUpkeep output — keeper will never rescue.');
  } else {
    console.log(`\n✅ ${rescueItems.length} RescueParked items queued.`);
    console.log('Attempting static simulation of performUpkeep...');
    try {
      const [signer] = await hre.ethers.getSigners();
      const mkSigned = mk.connect(signer);
      await mkSigned.performUpkeep.staticCall(perfData);
      console.log('✅ performUpkeep simulation SUCCEEDED — rescues should process.');
    } catch (e) {
      console.log('❌ performUpkeep simulation REVERTED:', e.message.slice(0, 200));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
