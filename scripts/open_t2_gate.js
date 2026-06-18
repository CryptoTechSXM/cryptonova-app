/**
 * open_t2_gate.js
 * Manually opens the T2 velocity gate by calling TierRouter.setTierVelocityGreen(1, true).
 *
 * Run this when: MatrixKeeper hasn't auto-opened T2 yet and you need to unblock upgrades.
 * Auth: owner (DEPLOYER_PRIVATE_KEY) or matrixKeeper contract.
 *
 * Usage:
 *   node scripts/open_t2_gate.js              # opens T2 only
 *   TIER=3 node scripts/open_t2_gate.js       # opens a different tier (1-indexed)
 *
 * Or via Hardhat for auto .env loading:
 *   npx hardhat run scripts/open_t2_gate.js --network baseSepolia
 */

const { ethers } = require(
  (() => { try { require.resolve('hardhat'); return 'hardhat'; } catch { return 'ethers'; } })()
);
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const RPC_URL      = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

// Tier to open — 1-indexed (T2 = index 1), override via TIER env var
const TIER_1IDX = Number(process.env.TIER || 2);
const TIER_IDX  = TIER_1IDX - 1; // 0-indexed for contract

const TIER_ROUTER = '0x36a1069432157007ECe1246A609d1d5c108293b3'; // V8.14

const TIER_ROUTER_ABI = [
  // NOTE: getVelocityGates() has a bool[7] bug on 10-tier deploy — do not call it
  'function setTierVelocityGreen(uint8, bool) external',
  'function owner() external view returns (address)',
  'event VelocityGateSet(uint8 indexed tier, bool green)',
];

async function main() {
  if (!DEPLOYER_KEY) {
    console.error('ERROR: DEPLOYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const signer   = new ethers.Wallet(DEPLOYER_KEY, provider);
  const router   = new ethers.Contract(TIER_ROUTER, TIER_ROUTER_ABI, signer);

  const owner = await router.owner();

  console.log(`TierRouter        : ${TIER_ROUTER}`);
  console.log(`Owner             : ${owner}`);
  console.log(`Signer            : ${signer.address}`);
  console.log(`Target            : T${TIER_1IDX} velocity gate (index ${TIER_IDX})`);
  console.log(`Action            : setTierVelocityGreen(${TIER_IDX}, true)`);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error(`\nERROR: signer is not the owner. Need deployer wallet.`);
    process.exit(1);
  }

  // NOTE: cannot read gate state — getVelocityGates() has a bool[7] bug on 10-tier deploy.
  // Setting true is idempotent (if already open, no harm done).
  console.log(`\nSending tx…`);
  const tx = await router.setTierVelocityGreen(TIER_IDX, true, {
    gasLimit: 100_000,
  });
  console.log(`  tx hash  : ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  block    : ${receipt.blockNumber}`);
  console.log(`  gas used : ${receipt.gasUsed}`);
  console.log(`  status   : ${receipt.status === 1 ? '✅ SUCCESS' : '❌ FAILED'}`);

  // Confirm via VelocityGateSet event in receipt
  const iface = router.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'VelocityGateSet') {
        console.log(`\n  Event: VelocityGateSet(tier=${parsed.args.tier}, green=${parsed.args.green})`);
      }
    } catch {}
  }

  if (receipt.status === 1) {
    console.log(`\nT${TIER_1IDX} velocity gate is now OPEN.`);
    console.log(`Members cycling out of T${TIER_1IDX-1} MatB will now upgrade to T${TIER_1IDX}.`);
    console.log(`Run bigfill_v8.js to push the remaining 7 slots and trigger W1 T2 upgrade.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
