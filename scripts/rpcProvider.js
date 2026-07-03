"use strict";
/**
 * rpcProvider.js — Robust multi-RPC provider for CryptoNova scripts.
 *
 * Tries each RPC in order (primary from env, then free public fallbacks).
 * Returns the first one that responds within 6 seconds.
 *
 * Usage:
 *   const { createProvider } = require('./rpcProvider');
 *   const provider = await createProvider(process.env.BASE_SEPOLIA_RPC_URL);
 *
 * ENV VARS:
 *   BASE_SEPOLIA_RPC_URL   Primary RPC (Alchemy, Infura, etc.)
 *   FALLBACK_RPC_URL       Optional second RPC (overrides built-in fallbacks)
 */

const { ethers } = require('ethers');

const BUILTIN_FALLBACKS = [
  'https://sepolia.base.org',                                   // Coinbase official
  'https://base-sepolia-rpc.publicnode.com',                    // PublicNode
  'https://base-sepolia.blockpi.network/v1/rpc/public',         // BlockPI
];

/**
 * @param {string} primaryUrl  The preferred RPC URL (usually from .env)
 * @param {number} timeoutMs   Per-RPC connection timeout (default 6000ms)
 * @returns {Promise<ethers.JsonRpcProvider>}
 */
async function createProvider(primaryUrl, timeoutMs = 6000) {
  const extra = process.env.FALLBACK_RPC_URL ? [process.env.FALLBACK_RPC_URL] : [];
  const urls  = [...new Set([primaryUrl, ...extra, ...BUILTIN_FALLBACKS].filter(Boolean))];

  for (const url of urls) {
    const display = url.replace(/\/v2\/[^/]+/, '/v2/***');
    try {
      const p = new ethers.JsonRpcProvider(url);
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      if (url !== primaryUrl) {
        console.log(`  ⚠️  Primary RPC unavailable — using fallback: ${display}`);
      } else {
        console.log(`  ✓ RPC: ${display}`);
      }
      return p;
    } catch {
      console.log(`  ✗ RPC failed: ${display}`);
    }
  }

  throw new Error('All RPC endpoints unreachable. Check network or add FALLBACK_RPC_URL to .env');
}

module.exports = { createProvider };
