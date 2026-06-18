/**
 * redeploy_sf.js
 * ──────────────────────────────────────────────────────────────────────────
 * Redeploys StabilityFund.sol (v2 — adds redeemCNOVA) and re-wires every
 * deployed contract that references the old StabilityFund address.
 *
 * Normal run (deploy + wire):
 *   npx hardhat run scripts/redeploy_sf.js --network baseSepolia
 *
 * Resume run (SF already deployed, just wire):
 *   $env:SF_ADDR="0x2a994AE149B6CE208909B5Fea5caa35F94e0D2ce"
 *   npx hardhat run scripts/redeploy_sf.js --network baseSepolia
 *
 * After running, copy the printed NEW_STABILITY_FUND address into:
 *   - CryptoNova-App/index.html  ->  ADDRS.stabilityFund
 * ──────────────────────────────────────────────────────────────────────────
 */

const hre = require('hardhat');
const { ethers } = hre;
const fs   = require('fs');
const path = require('path');

// ── Addresses (from deployed_addresses_v8_3.json) ─────────────────────────
const ADDRS = {
  usdc:          '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a',
  cnova:         '0x2ECB1b19f9B9c41F0F4A83844A176729Abc41a43',
  tierRouter:    '0x394FB648840E2d07324458Af64EA9480D54598a8',
  matrixKeeper:  '0x391a81B46D7ACE9e28B6ebd513B2D9531E77dC6d',
  T1: {
    pm:   '0x7e6693b747F5d66e6c7859B8c452C91aA0B7D459',
    matA: '0x99dDB434232C56673fD3C81e95caBec330fc8573',
    matB: '0xEeCfA538710EC5c04cf54e39e5e68bd6308EfAe9',
  },
  T2: {
    pm:   '0x09707B188B602ea36Ed870F5C53508A212a532c4',
    matA: '0x7C18b1F374B67b3a6E97346b98D63B48580e51DB',
    matB: '0x08F081C226A6081C8B570fFe4DB2517cCDE63132',
  },
};

const TIER_FEES = {
  0: 10_000_000n,  // T1 $10
  1: 25_000_000n,  // T2 $25
};

const MATRIX_ABI_MINIMAL = [
  'function setStabilityFund(address _sf) external',
];

const SF_ABI_SETUP = [
  'function setMatrixKeeper(address _keeper) external',
  'function setTierRouter(address _tr) external',
  'function setMatrixAuthorized(address matrix, bool authorized) external',
  'function setTierFee(uint8 tierIndex, uint256 fee) external',
  'function matrixKeeper() external view returns (address)',
  'function tierRouter() external view returns (address)',
  'function authorizedMatrices(address) external view returns (bool)',
  'function tierEntryFees(uint256) external view returns (uint256)',
  'function totalBalance() external view returns (uint256)',
];

async function send(contract, method, args, label) {
  console.log(`    ${label}...`);
  const tx = await contract[method](...args);
  await tx.wait();
  console.log(`    done  (${tx.hash.slice(0, 12)}...)`);
}

async function main() {
  const [rawSigner] = await ethers.getSigners();

  // ── NonceManager: prevents stale-nonce errors on public RPCs ─────────────
  const { NonceManager } = require('ethers');
  const deployer = new NonceManager(rawSigner);

  console.log('\n── StabilityFund Redeploy ───────────────────────────────────────────');
  console.log('Deployer:', rawSigner.address);
  console.log('Network: ', hre.network.name);

  const matrices   = [ADDRS.T1.matA, ADDRS.T1.matB, ADDRS.T2.matA, ADDRS.T2.matB];
  const matLabels  = ['T1.matA', 'T1.matB', 'T2.matA', 'T2.matB'];

  // ── 1. Deploy or resume ──────────────────────────────────────────────────
  let newSfAddr = process.env.SF_ADDR || '';
  if (newSfAddr) {
    console.log(`\n[1/7] Resuming with existing StabilityFund: ${newSfAddr}`);
  } else {
    console.log('\n[1/7] Deploying StabilityFund v2 (with redeemCNOVA)...');
    const SF = await ethers.getContractFactory('StabilityFund', deployer);
    const sf = await SF.deploy(ADDRS.usdc, ADDRS.cnova, rawSigner.address);
    await sf.waitForDeployment();
    newSfAddr = await sf.getAddress();
    console.log('  NEW StabilityFund:', newSfAddr);
  }

  const sfW = new ethers.Contract(newSfAddr, SF_ABI_SETUP, deployer);

  // ── 2. Set MatrixKeeper ──────────────────────────────────────────────────
  console.log('\n[2/7] Setting MatrixKeeper...');
  await send(sfW, 'setMatrixKeeper', [ADDRS.matrixKeeper], ADDRS.matrixKeeper);

  // ── 3. Set TierRouter ────────────────────────────────────────────────────
  console.log('\n[3/7] Setting TierRouter...');
  await send(sfW, 'setTierRouter', [ADDRS.tierRouter], ADDRS.tierRouter);

  // ── 4. Authorize all matrices ────────────────────────────────────────────
  console.log('\n[4/7] Authorizing matrices...');
  for (let i = 0; i < matrices.length; i++) {
    await send(sfW, 'setMatrixAuthorized', [matrices[i], true], matLabels[i]);
  }

  // ── 5. Set tier fees ─────────────────────────────────────────────────────
  console.log('\n[5/7] Setting tier fees...');
  for (const [tierIdx, fee] of Object.entries(TIER_FEES)) {
    await send(sfW, 'setTierFee', [Number(tierIdx), fee], `T${Number(tierIdx)+1} fee = $${Number(fee)/1e6}`);
  }

  // ── 6. Point matrices to new SF ──────────────────────────────────────────
  console.log('\n[6/7] Re-wiring matrices...');
  for (let i = 0; i < matrices.length; i++) {
    const mat = new ethers.Contract(matrices[i], MATRIX_ABI_MINIMAL, deployer);
    await send(mat, 'setStabilityFund', [newSfAddr], `${matLabels[i]}.setStabilityFund`);
  }

  // ── 7. Verify ────────────────────────────────────────────────────────────
  console.log('\n[7/7] Verifying...');
  const keeper  = await sfW.matrixKeeper();
  const router  = await sfW.tierRouter();
  const authA   = await sfW.authorizedMatrices(ADDRS.T1.matA);
  const authB   = await sfW.authorizedMatrices(ADDRS.T1.matB);
  const fee0    = await sfW.tierEntryFees(0);
  const fee1    = await sfW.tierEntryFees(1);

  const ok = keeper.toLowerCase() === ADDRS.matrixKeeper.toLowerCase()
          && router.toLowerCase()  === ADDRS.tierRouter.toLowerCase()
          && authA === true && authB === true
          && fee0 === 10_000_000n
          && fee1 === 25_000_000n;

  console.log(`  matrixKeeper:  ${keeper}`);
  console.log(`  tierRouter:    ${router}`);
  console.log(`  T1.matA auth:  ${authA}`);
  console.log(`  T1 fee:        ${fee0} (expect 10000000)`);
  console.log(`  T2 fee:        ${fee1} (expect 25000000)`);
  console.log(`  Result: ${ok ? 'ALL CHECKS PASSED' : 'FAILED -- review above'}`);
  if (!ok) process.exit(1);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('NEW_STABILITY_FUND:', newSfAddr);
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('\nUpdate index.html -> ADDRS.stabilityFund with this address.\n');

  // Auto-patch deployed_addresses_v8_3.json
  const jsonPath = path.join(__dirname, 'deployed_addresses_v8_3.json');
  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    data.stabilityFund = newSfAddr;
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    console.log('  Auto-patched deployed_addresses_v8_3.json');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
