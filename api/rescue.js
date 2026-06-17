/**
 * /api/rescue.js — CryptoNova V8.17 Member Self-Rescue (topUpAndCross)
 *
 * POST /api/rescue  { "address": "0x..." }
 *
 * V8.17: Uses topUpAndCross() — deployer pays only the SHORTFALL
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

// V8.17 — deployed 2026-06-17 — Pool=45% Chain=17% SF=15%
// Hardcoded to avoid JSON import (no addresses file in app repo)
const ADDRS_RAW = {
  usdc: '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a',
  tiers: {
    T1:  { matA: '0x88A3dcb7AE73b0B765036fa1F29753bcDA2Dbd66', matB: '0xCFE4E56f03B5c0041efFA21B14fCf0eF52Fd251C' },
    T2:  { matA: '0xC1ac0a7d6b295569FbCa4a27E923A1f555D5BE0b', matB: '0x6b7e79beF7F5D96af7556D3a32bEbBa000931296' },
    T3:  { matA: '0x99e25D5C05b3Df1F5d2D43776f21ae2426245Eb7', matB: '0x4F8Bce516Ad376bEBB56e69223eEB3625eD945AE' },
    T4:  { matA: '0x12621f38C40AB4B5682e883abDCD41167a61980f', matB: '0xa1e5E4a35be643822938B19e90844FEbB754dB3c' },
    T5:  { matA: '0xF2e91800C31588F17fCc99aBD1aA67d0f11B45a0', matB: '0x8834323E62B4BB37807CC403F3f6A384be52D535' },
    T6:  { matA: '0xcce304011aB2d84900a1EB90FfA38B5d16368957', matB: '0x2Ebbf3f619bb4487D3ac7C5f183E4f36D1843f8e' },
    T7:  { matA: '0x247d2fFa5873D0abf213A25dB43c5DbAcaa1eD3e', matB: '0x6E264c04C67f368f44b492b4A9A0106eA4e481e7' },
    T8:  { matA: '0x827C2b7f7C9d2ecE3A245e0161885f1A0f71879D', matB: '0xa7C763232beE0103CE73CC54fd00BFb83f8508dC' },
    T9:  { matA: '0xF6F74C28dea75299e9c2fa50a95969383B72F4e0', matB: '0x09aa9e0C568aa0743638eeAAdc097559EC77daCc' },
    T10: { matA: '0x7b2B4785ec8f70186B7001816FBe1c7277D00af4', matB: '0xf6C3Fc62d5fD787271a124a0a5D44f9b54B1e6B2' },
  },
};

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
      `Rescue (V8.17): ${address} rescued from ${parkedMatrix.label} | ` +
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
