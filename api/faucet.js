/**
 * /api/faucet.js — CryptoNova Testnet USDC Faucet
 *
 * POST /api/faucet  { "address": "0x..." }
 *
 * Mints $50 test USDC to any wallet that hasn't already claimed.
 * Rate-limited to 1 claim per wallet (in-memory; resets on cold start).
 * Testnet only — uses MockUSDC which has an onlyOwner mint().
 *
 * Required Vercel env vars:
 *   DEPLOYER_PRIVATE_KEY  — MockUSDC owner (can call mint())
 *   BASE_SEPOLIA_RPC      — e.g. https://sepolia.base.org
 *
 * Optional:
 *   FAUCET_AMOUNT_USDC    — how much to mint per claim (default: 50)
 */

import { ethers } from 'ethers';

const USDC_ADDRESS   = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const MOCK_USDC_ABI  = [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address) view returns (uint256)',
];

// In-memory rate-limit store: address → true
// Resets on Vercel cold start, which is fine for testnet
const claimed = new Map();

export default async function handler(req, res) {
  // CORS — allow v8.crypto-nova.app and localhost
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

  if (claimed.has(normalised)) {
    return res.status(429).json({ error: 'This wallet has already claimed testnet USDC.' });
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    console.error('DEPLOYER_PRIVATE_KEY not set in Vercel env');
    return res.status(500).json({ error: 'Faucet not configured' });
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
  const amount = BigInt(Number(process.env.FAUCET_AMOUNT_USDC || 50) * 1_000_000); // 6 decimals

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl, 84532, { staticNetwork: true });
    const wallet   = new ethers.Wallet(deployerKey, provider);
    const usdc     = new ethers.Contract(USDC_ADDRESS, MOCK_USDC_ABI, wallet);

    const tx = await usdc.mint(address, amount, { gasLimit: 100_000 });
    await tx.wait();

    // Mark as claimed only after successful TX
    claimed.set(normalised, true);

    console.log(`Faucet: minted ${Number(amount)/1e6} USDC to ${address} | tx: ${tx.hash}`);

    return res.status(200).json({
      success: true,
      amount:  `$${Number(amount)/1e6}`,
      tx:      tx.hash,
      message: `$${Number(amount)/1e6} test USDC sent to ${address}`,
    });

  } catch (e) {
    console.error('Faucet error:', e.message);
    return res.status(500).json({ error: 'Faucet TX failed: ' + (e.reason || e.message || 'unknown') });
  }
}
