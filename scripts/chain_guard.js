"use strict";
/**
 * chain_guard.js — T2 network guard (MAINNET_READINESS.md §3 T2), session 66, 2026-09-07.
 *
 * Every script that reads an addresses book (ADDRESSES_FILE) and talks to a chain must call
 * assertChain(book, provider, label) BEFORE its first call, so a Base-Sepolia book can never be
 * driven against Base mainnet (chainId 8453) or the reverse. deploy_v8.js writes `chainId` into
 * every book from this commit on; older books without the field are REFUSED unless
 * ALLOW_LEGACY_BOOK=1 (they only exist on Sepolia, but the guard must not guess).
 *
 * Usage (ethers v6):
 *   const { assertChain } = require('./chain_guard');
 *   await assertChain(A, provider, process.env.ADDRESSES_FILE);
 * Throws (and the caller should let it exit non-zero) on mismatch.
 */
async function assertChain(book, provider, label = "addresses book") {
  const live = Number((await provider.getNetwork()).chainId);
  if (book.chainId === undefined || book.chainId === null) {
    if (process.env.ALLOW_LEGACY_BOOK === "1") {
      console.warn(`  ⚠ chain_guard: ${label} has no chainId field (legacy book, network "${book.network}"); ALLOW_LEGACY_BOOK=1 so continuing on chain ${live}`);
      return live;
    }
    throw new Error(`chain_guard: ${label} has no chainId field (network "${book.network}"). Add "chainId" to the book (84532 Base Sepolia / 8453 Base mainnet) or set ALLOW_LEGACY_BOOK=1 for a known-Sepolia book.`);
  }
  const want = Number(book.chainId);
  if (want !== live) {
    throw new Error(`chain_guard: ${label} is for chainId ${want} (${book.network}) but the RPC is chainId ${live}. Wrong ADDRESSES_FILE or wrong RPC URL — refusing to run.`);
  }
  return live;
}
module.exports = { assertChain };
