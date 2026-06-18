/**
 * /api/rescue.js — CryptoNova V8.18 Member Self-Rescue (topUpAndCross)
 *
 * POST /api/rescue  { "address": "0x..." }
 *
 * V8.18: Uses topUpAndCross() — deployer pays only the SHORTFALL
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

// V8.18 — deployed 2026-06-18 — Pool=45% Chain=17% SF=13%
// Hardcoded to avoid JSON import (no addresses file in app repo)
const ADDRS_RAW = {
  usdc: '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a',
  tiers: {
    T1:  { matA: '0x5BF99dF9b104B1C2667d1329aB6105A96F7F4D2F', matB: '0x37648874C532a3F00C4eAd8c5Fd2Ac28bbd69fa3' },
    T2:  { matA: '0xafDB80343f5a59FFdd48fe8FbFb63e059906b862', matB: '0xE9347F0424f0f8f462494F131b864C36F75a3F71' },
    T3:  { matA: '0x302750EC0b7fE457B0Bc560D92656c6A7556c6b0', matB: '0x5338E5aAac713FD378B7DEce69163352F327Cd4e6' },
    T4:  { matA: '0xe297265908ec6e4E2D63655935aB9d4EC0beB7ef', matB: '0xaE9fA8991aAA54E46C302aeD07772Cfa13e64819' },
    T5:  { matA: '0xB141bF474a098de238D937209939332140F76a6A', matB: '0x059945e3900c825E97324f915941D304B2e2a1C9' },
    T6:  { matA: '0x9fE86D87Bae2498b7785336D0816536B878A7FD5', matB: '0x4a677799587bCFaC264d6fa17008B2aE06414b60' },
    T7:  { matA: '0x7ef635348025D353c79664CAEBC5684F71a9A1f3', matB: '0xaa9B7ad754eb94895e3820Fca3669A6aF27b2570' },
    T8:  { matA: '0x420B9779863F281e14dF095840937CB14495440A', matB: '0x62238e24b6de4dfb4660505B02913Eaaa621B869' },
    T9:  { matA: '0xC910cC90Ce21F28eE0695C07BD0395033768563c', matB: '0x742E727b038D803043AA475D59B0d18b399FB60b' },
    T10: { matA: '0x7A4d7d9d5E6856aA46091d9D75e48E0e574784fb', matB: '0x3fBeAB162A20252bE8456D4252b3257fbC099768' },
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
      `Rescue (V8.18): ${address} rescued from ${parkedMatrix.label} | ` +
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
