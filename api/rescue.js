/**
 * /api/rescue.js — CryptoNova V8.16 Member Self-Rescue (topUpAndCross)
 *
 * POST /api/rescue  { "address": "0x..." }
 *
 * V8.16: Uses topUpAndCross() — deployer pays only the SHORTFALL
 * (ENTRY_FEE − member.withdrawable), not the full entry fee.
 * The member's own withdrawable covers their portion.
 *
 * Rate-limit: 1 rescue per wallet per cold start (in-memory).
 *
 * Required Vercel env:
 *   DEPLOYER_PRIVATE_KEY   — any funded wallet (pays shortfall only)
 *   BASE_SEPOLIA_RPC       — https://sepolia.base.org
 */

import { ethers } from 'ethers';
import ADDRS_RAW from '../scripts/deployed_addresses_v8_16.json' assert { type: 'json' };

const MATRIX_ABI = [
  'function hasEverJoined(address) view returns (bool)',
  'function getMember(address) view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
  'function parkedAt(address) view returns (uint256)',
  'function isParked(address) view returns (bool)',
  'function ENTRY_FEE() view returns (uint256)',
  'function topUpAndCross(address member) external',
];

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];

// All 20 matrix addresses: { label, addr }
const MATRICES = Object.entries(ADDRS_RAW.tiers).flatMap(([tier, t]) => [
  { label: `${tier}-A`, addr: t.matA },
  { label: `${tier}-B`, addr: t.matB },
]);

// In-memory rate limit: one rescue per wallet per cold start
const rescued = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { address } = req.body || {};
  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const normalised = address.toLowerCase();
  if (rescued.has(normalised)) {
    return res.status(429).json({ error: 'Already rescued in this session. Contact support if still stuck.' });
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    return res.status(500).json({ error: 'Rescue not configured (missing deployer key)' });
  }

  const rpcUrl   = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl, 84532, { staticNetwork: true });
  const deployer = new ethers.Wallet(deployerKey, provider);
  const usdc     = new ethers.Contract(ADDRS_RAW.usdc, USDC_ABI, deployer);

  try {
    // 1. Find which matrix this address is parked in
    let parkedMatrix  = null;
    let entryFee      = 0n;
    let memberBal     = 0n;

    for (const m of MATRICES) {
      const mc = new ethers.Contract(m.addr, MATRIX_ABI, provider);
      const [parked, fee] = await Promise.all([
        mc.isParked(address).catch(() => false),
        mc.ENTRY_FEE().catch(() => 0n),
      ]);
      if (parked) {
        const info = await mc.getMember(address).catch(() => null);
        memberBal    = info ? info.withdrawable : 0n;
        parkedMatrix = { ...m, contract: new ethers.Contract(m.addr, MATRIX_ABI, deployer) };
        entryFee     = fee;
        break;
      }
    }

    if (!parkedMatrix) {
      return res.status(400).json({
        error: 'This wallet is not currently parked in any matrix. They may have already been rescued or are still active.',
      });
    }

    // 2. Compute shortfall: only pay what the member cannot cover themselves
    const shortfall = memberBal >= entryFee ? 0n : entryFee - memberBal;

    // 3. Check deployer USDC balance (only need to cover shortfall)
    if (shortfall > 0n) {
      const deployerBal = await usdc.balanceOf(deployer.address);
      if (deployerBal < shortfall) {
        console.error(
          `Rescue: deployer has $${Number(deployerBal)/1e6} — needs shortfall $${Number(shortfall)/1e6} ` +
          `(member covers $${Number(memberBal)/1e6} of $${Number(entryFee)/1e6})`
        );
        return res.status(500).json({ error: 'Rescue fund insufficient — contact support' });
      }

      // 4a. Approve deployer → matrix for the shortfall only
      const approveTx = await usdc.approve(parkedMatrix.addr, shortfall, { gasLimit: 80_000 });
      await approveTx.wait();
    }

    // 4b. Call topUpAndCross — member's withdrawable covers their share, deployer tops up shortfall
    const rescueTx = await parkedMatrix.contract.topUpAndCross(address, { gasLimit: 800_000 });
    await rescueTx.wait();

    rescued.set(normalised, true);
    console.log(
      `Rescue (V8.16): ${address} rescued from ${parkedMatrix.label} | ` +
      `shortfall=$${Number(shortfall)/1e6} member=$${Number(memberBal)/1e6} | tx: ${rescueTx.hash}`
    );

    return res.status(200).json({
      success:   true,
      matrix:    parkedMatrix.label,
      entryFee:  `$${Number(entryFee) / 1e6}`,
      memberPay: `$${Number(memberBal >= entryFee ? entryFee : memberBal) / 1e6}`,
      topUp:     `$${Number(shortfall) / 1e6}`,
      tx:        rescueTx.hash,
      message:   `You've been re-entered into the matrix. Check your Dashboard.`,
    });

  } catch (e) {
    console.error('Rescue error:', e.message);
    return res.status(500).json({ error: 'Rescue failed: ' + (e.reason || e.message || 'unknown') });
  }
}
