/**
 * check_treasury_auth.js
 * Verifies CNOVATreasury authorizedCallers for MatA and MatB,
 * then callStatic-simulates the rescue to get the exact revert reason.
 *
 * Usage: node scripts/check_treasury_auth.js
 */

const { ethers } = require('ethers');

// Force public RPC
const RPC_URL = 'https://sepolia.base.org';

const TREASURY      = '0x44060f1513AE4B0b24E97e655E04Cf466e0e88B6';
const T1_MATA       = '0xE23eF8d2c5d90CD8239ea729479fEdd1E9Fd3e1b';
const T1_MATB       = '0xF059Da5E6C86A7aDeA9AaEAA2Fb8f717BcCD0E4d';
const MATRIX_KEEPER = '0x3009f21D51f7C46ED7EBDC9Fe7f26a4e4C596AAe';

const MATRIX_ABI = [
  'function treasury() external view returns (address)',
  'function getParkedMember(uint256) external view returns (address)',
];
const TREAS_ABI = [
  'function authorizedCallers(address) external view returns (bool)',
  'function owner() external view returns (address)',
];
const KEEPER_ABI = [
  'function performUpkeep(bytes calldata performData) external',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const matA   = new ethers.Contract(T1_MATA,       MATRIX_ABI, provider);
  const matB   = new ethers.Contract(T1_MATB,       MATRIX_ABI, provider);
  const treas  = new ethers.Contract(TREASURY,      TREAS_ABI,  provider);
  const keeper = new ethers.Contract(MATRIX_KEEPER, KEEPER_ABI, provider);

  console.log('===================================================');
  console.log(' TREASURY AUTH + CALLSTATIC DIAGNOSTIC');
  console.log('===================================================\n');

  const [matATreas, matBTreas] = await Promise.all([
    matA.treasury().catch(e => '(err:' + e.code + ')'),
    matB.treasury().catch(e => '(err:' + e.code + ')'),
  ]);
  const matBTreasOk = typeof matBTreas === 'string' && matBTreas.startsWith('0x') &&
                      matBTreas.toLowerCase() === TREASURY.toLowerCase();

  console.log('-- Treasury address check --');
  console.log('  MatA.treasury()  :', matATreas);
  console.log('  MatB.treasury()  :', matBTreas);
  console.log('  Deployed treasury:', TREASURY);
  console.log('  MatB match       :', matBTreasOk ? 'YES OK' : 'NO MISMATCH - MatB uses different Treasury!');

  const [matAAuth, matBAuth, owner] = await Promise.all([
    treas.authorizedCallers(T1_MATA),
    treas.authorizedCallers(T1_MATB),
    treas.owner(),
  ]);
  console.log('\n-- CNOVATreasury authorizedCallers --');
  console.log('  Treasury :', TREASURY);
  console.log('  owner    :', owner);
  console.log('  MatA     :', matAAuth ? 'AUTHORIZED' : 'NOT AUTHORIZED');
  console.log('  MatB     :', matBAuth ? 'AUTHORIZED' : 'NOT AUTHORIZED  <-- if false, this is the revert');

  if (!matBTreasOk && matBTreas && matBTreas.startsWith('0x')) {
    console.log('\n-- MatBs actual treasury --');
    const altTreas = new ethers.Contract(matBTreas, TREAS_ABI, provider);
    const [aA, aB, aO] = await Promise.all([
      altTreas.authorizedCallers(T1_MATA).catch(() => '?'),
      altTreas.authorizedCallers(T1_MATB).catch(() => '?'),
      altTreas.owner().catch(() => '?'),
    ]);
    console.log('  Treasury:', matBTreas, ' owner:', aO);
    console.log('  MatA:', aA, '  MatB:', aB);
  }

  console.log('\n-- callStatic simulation --');
  const parkedMember = await matA.getParkedMember(1);
  console.log('  Simulating rescue of', parkedMember, '(parked index 1)...');

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const performData = coder.encode(
    ['tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]'],
    [[{ workType: 4, tierIndex: 0, addr1: T1_MATA, addr2: parkedMember }]]
  );

  try {
    await keeper.performUpkeep.staticCall(performData, { gasLimit: 1_000_000 });
    console.log('  Result: WOULD SUCCEED - try higher gasLimit when sending');
  } catch (e) {
    const reason = e.reason || e.revert?.args?.[0] || e.shortMessage || e.message?.slice(0, 300);
    console.log('  Result: REVERTS');
    console.log('  Reason:', reason);
    if (e.data && e.data !== '0x' && e.data.length > 10) {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + e.data.slice(10));
        console.log('  Decoded:', '"' + decoded[0] + '"');
      } catch {}
    }
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
