// set_treasury_community_wallet.js — WIRE THE COMMUNITY WALLET INTO THE TREASURY.
//
// THE DEFECT (found 2026-08-25, session 39, measured with scripts/diag_redeem_revert.js):
// `deploy_v8.js` wired the CommunityWallet into TierRouter, StabilityFund, every matrix and
// MatrixKeeper — five calls — and NEVER into CNOVATreasury. So on live V8.48
// `treasury.communityWallet` reads address(0), and because `redeemAtFloor` pays 20% of the
// early-exit penalty to that address (CNOVATreasury.sol:288, inside `if (penalty > 0)`),
// EVERY redemption by a member who owes a penalty reverts with `ERC20InvalidReceiver(0)`.
//
// A fully-vested member at 0 bps skips the branch and redeems fine, which is why this
// presented as the frontend's intermittent generic "Transaction failed on-chain" instead of
// a reproducible bug, from the V8.48 deploy until it was measured.
//
// ⛔ READ-ONLY UNLESS `ARM=1`. Without it this reports and changes nothing.
//
// Run (read-only first, ALWAYS):
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/set_treasury_community_wallet.js --network baseSepolia
//
// Then, to actually send it:
//   ARM=1 ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/set_treasury_community_wallet.js --network baseSepolia
//
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.log("    npx hardhat run scripts/set_treasury_community_wallet.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
const ARM = process.env.ARM === "1";

const ABI = [
  "function communityWallet() view returns (address)",
  "function owner() view returns (address)",
  "function setCommunityWallet(address) external",
];

async function main() {
  const want = A.communityWallet;
  if (!want) { console.log("FATAL: addresses file has no 'communityWallet'."); process.exit(1); }
  if (!A.treasury) { console.log("FATAL: addresses file has no 'treasury'."); process.exit(1); }

  const [signer] = await ethers.getSigners();
  const T = new ethers.Contract(A.treasury, ABI, signer);

  console.log("");
  console.log("TREASURY -> COMMUNITY WALLET WIRING");
  console.log(`  addresses : ${process.env.ADDRESSES_FILE}  (${A.network})`);
  console.log(`  treasury  : ${A.treasury}`);
  console.log(`  signer    : ${await signer.getAddress()}`);
  console.log("");

  const owner = await T.owner();
  const now   = await T.communityWallet();
  console.log(`  treasury.owner()           ${owner}`);
  console.log(`  treasury.communityWallet   ${now}${now === ethers.ZeroAddress ? "   ⛔ UNSET" : ""}`);
  console.log(`  addresses file says        ${want}`);
  console.log("");

  // ⛔ NOTHING IS ASSUMED. Each of these is a reason to stop, stated separately.
  if (now !== ethers.ZeroAddress) {
    if (now.toLowerCase() === want.toLowerCase()) {
      console.log("✅ ALREADY SET, and it matches the addresses file. Nothing to do.");
      return;
    }
    console.log("⛔ ALREADY SET, TO A DIFFERENT ADDRESS THAN THE ADDRESSES FILE.");
    console.log("   That disagreement IS the finding — do not overwrite it on this script's");
    console.log("   say-so. Establish which one is correct first.");
    process.exit(1);
  }

  if ((await signer.getAddress()).toLowerCase() !== owner.toLowerCase()) {
    console.log("⛔ THE SIGNER IS NOT THE TREASURY OWNER. `setCommunityWallet` is onlyOwner,");
    console.log("   so this would revert. Run it with the owner key, or send it from the");
    console.log("   owner wallet directly.");
    process.exit(1);
  }

  if (!ARM) {
    console.log("DRY RUN — nothing sent. This is what ARM=1 would do:");
    console.log(`   treasury.setCommunityWallet(${want})`);
    console.log("");
    console.log("   Effect: redeemAtFloor's penalty branch gets a real recipient, so a member");
    console.log("   who owes an early-exit penalty can redeem again. Members at 0 bps were");
    console.log("   never affected. It changes no rate, no fee and no balance.");
    console.log("");
    console.log("   Re-run with ARM=1 to send it.");
    return;
  }

  console.log("ARM=1 — sending setCommunityWallet…");
  const tx = await T.setCommunityWallet(want);
  console.log(`  tx: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  mined in block ${rc.blockNumber}, status ${rc.status}`);

  // ⛔ VERIFY FROM THE CHAIN, NOT FROM THE RECEIPT. A successful receipt says the call did
  //    not revert; it does not say storage holds what you intended.
  //
  // ⛔⛔ AND ONE READ IS NOT A MEASUREMENT AGAINST AN RPC THAT CAN SERVE STALE STATE.
  //    2026-08-25, first live run: this printed "READ-BACK MISMATCH — the transaction
  //    succeeded and the value is not what was set" on a transaction that had WORKED
  //    PERFECTLY. The immediate re-read hit a node that had not yet caught up to the block
  //    it had just mined, and answered with the OLD value. A false alarm on a successful
  //    live fix costs exactly as much trust as a missed failure, and it invites somebody to
  //    re-send a transaction that already landed.
  //
  //    The repo already carried this lesson — an earlier instrument was made to retry 6x
  //    over 12s "because ONE READ IS NOT A MEASUREMENT against an RPC that can serve stale
  //    state, in EITHER direction" — and this script did not apply it. Now it does, and it
  //    also PINS the read to the block the transaction was mined in (36.2's rule), so a
  //    lagging node raises an error instead of quietly answering about an earlier block.
  let after = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      after = await T.communityWallet({ blockTag: rc.blockNumber });
      if (after.toLowerCase() === want.toLowerCase()) break;
    } catch (e) {
      after = null;                                  // node has not got the block yet
    }
    if (attempt < 6) {
      console.log(`  read-back attempt ${attempt} not settled yet — retrying in 2s…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log(`  treasury.communityWallet is now ${after || "UNREADABLE"}`);
  if (!after || after.toLowerCase() !== want.toLowerCase()) {
    console.log("⛔ READ-BACK DID NOT SETTLE after 6 attempts over ~10s, pinned to the mined");
    console.log(`   block ${rc.blockNumber}. The transaction itself succeeded (status ${rc.status}).`);
    console.log("   ⚠ DO NOT RE-SEND ON THIS ALONE — read the value again in a minute first.");
    console.log("   A stale RPC read has already produced one false alarm here.");
    process.exit(1);
  }
  console.log("");
  console.log("✅ VERIFIED FROM CHAIN. Re-run scripts/diag_redeem_revert.js to confirm the");
  console.log("   redeem path now passes for a member who owes a penalty.");
}

main().catch(e => { console.error(e); process.exit(1); });
