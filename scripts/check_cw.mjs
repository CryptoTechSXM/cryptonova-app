import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import * as path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Accept either env var name
const RPC  = process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const CW   = '0x525D14dA6042cd0223388E922a8FA8E91eC2304D';
const USDC = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const DEPLOYER = '0xCd0Af6a4116f2062c1594aDf34c1821D45175506';
const W1       = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';
const DIST_TX  = '0xef192f4a412d26bf0100cee84bf62a246438d42400349e14167cb1ee801d3a12';

const CW_ABI = [
  'function lastDistributionTime() view returns (uint256)',
  'function distributionCount() view returns (uint256)',
  'function availablePool() view returns (uint256)',
  'function claimable(address) view returns (uint256)',
  'function totalEnrolled() view returns (uint256)',
];
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

const provider = new ethers.JsonRpcProvider(RPC);
console.log('Using RPC:', RPC.slice(0,40) + '...');

const cw   = new ethers.Contract(CW, CW_ABI, provider);
const usdc = new ethers.Contract(USDC, USDC_ABI, provider);

const fmt = v => '$' + (Number(v)/1e6).toFixed(4);

const [lastDist, distCount, pool, cwBal, enrolled] = await Promise.all([
  cw.lastDistributionTime(),
  cw.distributionCount(),
  cw.availablePool(),
  usdc.balanceOf(CW),
  cw.totalEnrolled(),
]);

console.log('\n=== CommunityWallet State ===');
console.log('lastDistributionTime:', lastDist === 0n ? 'still 0 — distribute() did NOT run' : new Date(Number(lastDist)*1000).toISOString());
console.log('distributionCount:   ', distCount.toString());
console.log('totalEnrolled:       ', enrolled.toString());
console.log('CW USDC balance:     ', fmt(cwBal));
console.log('availablePool:       ', fmt(pool));

const deplClaim = await cw.claimable(DEPLOYER).catch(e => `ERR: ${e.code}`);
const w1Claim   = await cw.claimable(W1).catch(e => `ERR: ${e.code}`);
console.log('Deployer claimable:  ', typeof deplClaim === 'bigint' ? fmt(deplClaim) : deplClaim);
console.log('W1 claimable:        ', typeof w1Claim === 'bigint' ? fmt(w1Claim) : w1Claim);

const receipt = await provider.getTransactionReceipt(DIST_TX).catch(() => null);
console.log('\ndistribute() TX:', DIST_TX.slice(0,20)+'...');
console.log('TX status:          ', receipt ? (receipt.status === 1 ? '✅ SUCCESS' : '❌ REVERTED') : '⏳ Not found / still pending');
if (receipt) console.log('Block:              ', receipt.blockNumber);
