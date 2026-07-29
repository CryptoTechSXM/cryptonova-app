const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');
const { ethers } = hre;

const MK_ABI = [
  'function stabilityFund() view returns (address)',
  'function tierRouter() view returns (address)',
];

const SF_ABI = [
  'function totalBalance() view returns (uint256)',
  'function balanceByTier(uint8) view returns (uint256)',
];

async function main() {
  const addrsPath = path.join(__dirname, 'deployed_addresses_v8_29.json');
  const addrs = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const mk = new ethers.Contract(addrs.matrixKeeper, MK_ABI, ethers.provider);

  const sfOnChain = await mk.stabilityFund();
  const sfInJson  = addrs.stabilityFund;

  console.log('SF in JSON:     ', sfInJson);
  console.log('SF in Keeper:   ', sfOnChain);
  console.log('Match:          ', sfOnChain.toLowerCase() === sfInJson.toLowerCase() ? 'YES' : 'NO -- MISMATCH!');

  // Check both addresses
  const sf1 = new ethers.Contract(sfInJson,   SF_ABI, ethers.provider);
  const sf2 = new ethers.Contract(sfOnChain,  SF_ABI, ethers.provider);

  const bal1 = await sf1.totalBalance().catch(() => 'N/A');
  const t0_1 = await sf1.balanceByTier(0).catch(() => 'N/A');
  const bal2 = await sf2.totalBalance().catch(() => 'N/A');
  const t0_2 = await sf2.balanceByTier(0).catch(() => 'N/A');

  console.log('\nJSON SF (' + sfInJson.slice(0,10) + '...):');
  console.log('  totalBalance:    $' + (typeof bal1 === 'bigint' ? (Number(bal1)/1e6).toFixed(2) : bal1));
  console.log('  balanceByTier[0]:$' + (typeof t0_1 === 'bigint' ? (Number(t0_1)/1e6).toFixed(2) : t0_1));

  console.log('\nKeeper SF (' + sfOnChain.slice(0,10) + '...):');
  console.log('  totalBalance:    $' + (typeof bal2 === 'bigint' ? (Number(bal2)/1e6).toFixed(2) : bal2));
  console.log('  balanceByTier[0]:$' + (typeof t0_2 === 'bigint' ? (Number(t0_2)/1e6).toFixed(2) : t0_2));
}

main().catch(e => { console.error(e); process.exit(1); });
