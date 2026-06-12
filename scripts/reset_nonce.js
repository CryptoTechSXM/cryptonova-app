"use strict";
/**
 * reset_nonce.js — cancel all pending transactions for deployer or funder.
 * Run when NonceManager drift leaves ghost TXs stuck in mempool.
 *
 * Usage:
 *   npx hardhat run scripts/reset_nonce.js --network baseSepolia           (deployer)
 *   RESET_SIGNER=1 npx hardhat run scripts/reset_nonce.js --network baseSepolia  (funder)
 */
const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const signers = await ethers.getSigners();
  const idx     = Number(process.env.RESET_SIGNER || 0);
  const signer  = signers[idx];
  if (!signer) {
    console.error(`❌  No signer at index ${idx}. Check DEPLOYER_PRIVATE_KEY / FILL_FUNDER_KEY in .env`);
    process.exit(1);
  }
  const addr = signer.address;

  const confirmedNonce = await ethers.provider.getTransactionCount(addr, "latest");
  const pendingNonce   = await ethers.provider.getTransactionCount(addr, "pending");

  console.log(`Signer [${idx}]:      ${addr}`);
  console.log(`Confirmed nonce:  ${confirmedNonce}`);
  console.log(`Pending nonce:    ${pendingNonce}`);
  console.log(`Stuck TXs:        ${pendingNonce - confirmedNonce}`);

  if (pendingNonce <= confirmedNonce) {
    console.log("✓ No stuck transactions — nonce is clean.");
    return;
  }

  // Bump gas well above typical Base Sepolia tip to ensure replacement.
  // 3× is usually enough; use 5× to be safe on congested testnet.
  const feeData = await ethers.provider.getFeeData();
  const maxFee  = (feeData.maxFeePerGas  || ethers.parseUnits("5", "gwei")) * 5n;
  const tip     = (feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei")) * 5n;

  console.log(`\nGas: maxFee=${ethers.formatUnits(maxFee,"gwei")}gwei  tip=${ethers.formatUnits(tip,"gwei")}gwei`);
  console.log(`Cancelling nonces ${confirmedNonce} → ${pendingNonce - 1}...`);

  for (let n = confirmedNonce; n < pendingNonce; n++) {
    try {
      const tx = await signer.sendTransaction({
        to:                   addr,  // self-send, zero value
        value:                0n,
        nonce:                n,
        maxFeePerGas:         maxFee,
        maxPriorityFeePerGas: tip,
        gasLimit:             21000,
      });
      console.log(`  nonce ${n} → cancel TX ${tx.hash.slice(0, 14)}…`);
      await tx.wait();
      console.log(`  ✓ nonce ${n} confirmed`);
    } catch (e) {
      console.warn(`  ⚠  nonce ${n} failed: ${e.message.slice(0, 100)}`);
    }
  }

  const finalPending   = await ethers.provider.getTransactionCount(addr, "pending");
  const finalConfirmed = await ethers.provider.getTransactionCount(addr, "latest");
  console.log(`\nFinal confirmed nonce: ${finalConfirmed}`);
  console.log(`Final pending nonce:   ${finalPending}`);
  if (finalPending === finalConfirmed) {
    console.log("✓ Nonce is now clean — no stuck TXs");
  } else {
    console.log(`⚠  ${finalPending - finalConfirmed} TX(s) still pending — re-run if needed`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
